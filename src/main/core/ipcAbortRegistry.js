// @ts-check
/**
 * IPC Abort Registry
 *
 * Tracks in-flight IPC invocations by a renderer-generated request id so that
 * a preload-side timeout (or explicit user cancel) can signal the main-side
 * handler to stop work cooperatively.
 *
 * Design notes:
 * - The renderer (via preload) appends an envelope `{ __stratosortIpcMeta: { requestId } }`
 *   as the LAST argument to every `ipcRenderer.invoke` call. The main-side
 *   ipcRegistry wrapper strips that envelope before calling the handler and
 *   registers an AbortController here keyed by `requestId`.
 * - When the preload timeout fires (or the renderer chooses to cancel), it
 *   sends on `IPC_CHANNELS.SYSTEM.ABORT_INVOKE` with `{ requestId }`. The main
 *   listener calls `abort(requestId)` which triggers the AbortController.
 * - Handlers opt in to cancellation by reading `event.abortSignal`. Existing
 *   handlers that ignore it are unaffected — the wrapper still cleans up the
 *   entry in `finally`.
 *
 * @module core/ipcAbortRegistry
 */

const { createLogger } = require('../../shared/logger');

const logger = createLogger('IPCAbortRegistry');

const MAX_CONCURRENT_ENTRIES = 10000;
const MAX_REQUEST_ID_LENGTH = 128;
const REQUEST_ID_PATTERN = /^[\w.:-]+$/;

/**
 * @typedef {Object} AbortRegistryEntry
 * @property {AbortController} controller
 * @property {string} channel
 * @property {number} registeredAt
 */

/** @type {Map<string, AbortRegistryEntry>} */
const _entries = new Map();

/**
 * Validate that a renderer-supplied request id is well-formed. We reject
 * anything that could be used as a log-injection vector or that risks
 * unbounded growth in the map.
 *
 * @param {unknown} requestId
 * @returns {boolean}
 */
function isValidRequestId(requestId) {
  return (
    typeof requestId === 'string' &&
    requestId.length > 0 &&
    requestId.length <= MAX_REQUEST_ID_LENGTH &&
    REQUEST_ID_PATTERN.test(requestId)
  );
}

/**
 * Register an AbortController for an in-flight invoke.
 * Returns the controller's signal (or `null` if registration was refused).
 *
 * @param {string} requestId
 * @param {string} channel
 * @returns {AbortSignal|null}
 */
function register(requestId, channel) {
  if (!isValidRequestId(requestId)) {
    return null;
  }
  if (_entries.has(requestId)) {
    // Duplicate id from a buggy/compromised renderer: refuse rather than
    // silently replace, since we'd leak the prior controller.
    logger.warn(`[AbortRegistry] Duplicate requestId ignored: ${requestId}`);
    return _entries.get(requestId).controller.signal;
  }
  if (_entries.size >= MAX_CONCURRENT_ENTRIES) {
    // LRU-evict the oldest entry and ABORT it, so that:
    //  (a) the map size stays bounded, and
    //  (b) the evicted handler actually gets a cancellation signal rather
    //      than continuing to consume CPU/VRAM with its caller already
    //      timed out. Silently returning null (previous behaviour) kept
    //      the handler alive without an abortSignal — the worst of both
    //      worlds.
    // Map iteration order is insertion order, so the first key is the
    // oldest; this is O(1) for both the size check and the delete.
    const oldestId = _entries.keys().next().value;
    if (oldestId) {
      const evicted = abort(oldestId, 'registry-cap-evict');
      _entries.delete(oldestId);
      logger.warn(
        `[AbortRegistry] Entry cap reached (${MAX_CONCURRENT_ENTRIES}); evicted oldest=${oldestId} ` +
          `to make room for ${channel} (aborted=${evicted})`
      );
    } else {
      // Defensive: size === cap but keys().next() was empty. Refuse the
      // new registration rather than loop.
      logger.warn(
        `[AbortRegistry] Entry cap reached (${MAX_CONCURRENT_ENTRIES}) but no entry to evict; refusing ${channel}`
      );
      return null;
    }
  }
  const controller = new AbortController();
  _entries.set(requestId, {
    controller,
    channel,
    registeredAt: Date.now()
  });
  return controller.signal;
}

/**
 * Unregister an entry (called in the wrapper's `finally` block).
 *
 * @param {string} requestId
 */
function unregister(requestId) {
  if (!isValidRequestId(requestId)) return;
  _entries.delete(requestId);
}

/**
 * Abort an in-flight invoke by id. Called from the ABORT_INVOKE listener
 * when the renderer's timeout fires.
 *
 * @param {string} requestId
 * @param {string} [reason='ipc-timeout']
 * @returns {boolean} True if an entry existed and was aborted
 */
function abort(requestId, reason = 'ipc-timeout') {
  if (!isValidRequestId(requestId)) return false;
  const entry = _entries.get(requestId);
  if (!entry) return false;
  try {
    // `AbortController.abort(reason)` is supported on Node 18+.
    entry.controller.abort(reason);
  } catch (err) {
    logger.warn(`[AbortRegistry] Failed to abort ${requestId}: ${err?.message || err}`);
    try {
      entry.controller.abort();
    } catch {
      /* best effort */
    }
  }
  logger.debug(
    `[AbortRegistry] Aborted invoke requestId=${requestId} channel=${entry.channel} reason=${reason}`
  );
  return true;
}

/**
 * Abort everything (used during shutdown to unblock any handlers that are
 * cooperatively awaiting their signal).
 *
 * @param {string} [reason='shutdown']
 * @returns {number} Count of aborted entries
 */
function abortAll(reason = 'shutdown') {
  let count = 0;
  for (const [requestId] of _entries) {
    if (abort(requestId, reason)) count++;
  }
  return count;
}

/**
 * @returns {number}
 */
function size() {
  return _entries.size;
}

/**
 * Test-only reset hook.
 * @returns {void}
 */
function _reset() {
  _entries.clear();
}

module.exports = {
  register,
  unregister,
  abort,
  abortAll,
  size,
  isValidRequestId,
  _reset,
  MAX_CONCURRENT_ENTRIES,
  MAX_REQUEST_ID_LENGTH
};
