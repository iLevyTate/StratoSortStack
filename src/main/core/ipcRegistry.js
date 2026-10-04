// @ts-check
/**
 * IPC Channel Registry
 *
 * Tracks all registered IPC channels to enable targeted cleanup
 * instead of the dangerous ipcMain.removeAllListeners().
 *
 * @module core/ipcRegistry
 */

const { createLogger } = require('../../shared/logger');
const { withCorrelationId, generateCorrelationId } = require('../../shared/correlationId');
const { assertAllowedIpcSender } = require('../ipc/ipcSenderValidator');
const ipcAbortRegistry = require('./ipcAbortRegistry');

const TRACE_ID_PATTERN = /^[\w.:-]+$/;
const MAX_TRACE_ID_LENGTH = 128;

/**
 * Detect and strip the preload-added abort envelope.
 *
 * The preload appends `{ __stratosortIpcMeta: { requestId, traceId? } }` as
 * the last argument to every `ipcRenderer.invoke`. We pop it here so that
 * handlers never see it, and return the `requestId` (per-invoke, used as the
 * abort key) along with the optional `traceId` (per-user-action, used as the
 * correlation id so that all logs produced by the handler share an id with
 * any other invokes the same user action triggered).
 *
 * @param {unknown[]} args
 * @returns {{ args: unknown[], requestId: string|null, traceId: string|null }}
 */
function extractIpcMetaEnvelope(args) {
  if (!Array.isArray(args) || args.length === 0) {
    return { args, requestId: null, traceId: null };
  }
  const last = args[args.length - 1];
  if (!last || typeof last !== 'object' || Array.isArray(last)) {
    return { args, requestId: null, traceId: null };
  }
  const meta = /** @type {any} */ (last).__stratosortIpcMeta;
  if (!meta || typeof meta !== 'object') {
    return { args, requestId: null, traceId: null };
  }
  // Only treat the last arg as an envelope if it's a dedicated envelope
  // object (i.e. its only own keys are the meta marker). This avoids
  // accidentally stripping a legitimate trailing object that happens to
  // carry a `__stratosortIpcMeta` field.
  const ownKeys = Object.keys(last);
  if (ownKeys.length !== 1 || ownKeys[0] !== '__stratosortIpcMeta') {
    return { args, requestId: null, traceId: null };
  }
  const requestId = typeof meta.requestId === 'string' ? meta.requestId : null;
  // Validate the trace id rather than trusting the renderer — a compromised
  // renderer could otherwise inject arbitrary strings into our structured
  // logs via the correlation id.
  const rawTraceId = typeof meta.traceId === 'string' ? meta.traceId : null;
  const traceId =
    rawTraceId &&
    rawTraceId.length > 0 &&
    rawTraceId.length <= MAX_TRACE_ID_LENGTH &&
    TRACE_ID_PATTERN.test(rawTraceId)
      ? rawTraceId
      : null;
  return { args: args.slice(0, -1), requestId, traceId };
}

/**
 * Use client-supplied correlation id when present and safe (for log tracing across IPC).
 * @param {unknown[]} invokeArgs - Arguments after `event` from ipcMain.handle
 * @returns {string|null}
 */
function extractCorrelationIdFromInvokeArgs(invokeArgs) {
  for (const arg of invokeArgs) {
    if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
      const argAny = /** @type {any} */ (arg);
      const raw = argAny.correlationId ?? argAny.__stratosortCorrelationId;
      if (
        typeof raw === 'string' &&
        raw.length > 0 &&
        raw.length <= 128 &&
        /^[\w.:-]+$/.test(raw)
      ) {
        return raw;
      }
    }
  }
  return null;
}

const logger = createLogger('IPCRegistry');
let _opCounter = 0;
/**
 * Registry of all IPC channels registered through this module.
 * Separated by type: handlers (handle/invoke) vs listeners (on/send).
 */
const registry = {
  /** Channels registered via ipcMain.handle() */
  handlers: new Set(),
  /** Channels registered via ipcMain.on() */
  listeners: new Map(), // channel -> Set of wrapped listener functions
  /** FIX: Maps original listener to wrapped listener for removeListener lookup */
  listenerWrappers: new WeakMap() // original -> wrapped
};

/**
 * FIX: CRITICAL - Global shutdown flag to prevent IPC handlers from running during shutdown
 * Previously, IPC handlers could fire during shutdown and access destroyed services
 */
let _isShuttingDown = false;
const _inFlightOperations = new Set();

/**
 * Set shutdown state - called by lifecycle during app shutdown
 * @param {boolean} shutting - True if app is shutting down
 */
function setShuttingDown(shutting) {
  _isShuttingDown = shutting;
  if (shutting) {
    logger.info('[REGISTRY] Shutdown mode enabled - IPC handlers will reject new requests');
  }
}

/**
 * Check if app is in shutdown state
 * @returns {boolean} True if app is shutting down
 */
function isShuttingDown() {
  return _isShuttingDown;
}

/**
 * Wrap ipcMain.handle to track registered channels
 *
 * @param {any} ipcMain - Electron ipcMain
 * @param {string} channel - Channel name
 * @param {Function} handler - Handler function
 */
function registerHandler(ipcMain, channel, handler) {
  if (!channel || typeof channel !== 'string') {
    throw new Error('Channel must be a non-empty string');
  }
  if (!handler || typeof handler !== 'function') {
    throw new Error('Handler must be a function');
  }

  // Check for duplicate registration
  if (registry.handlers.has(channel)) {
    logger.warn(`[REGISTRY] Handler already registered for channel: ${channel}`);
    // Remove old handler before registering new one
    try {
      ipcMain.removeHandler(channel);
    } catch (e) {
      logger.debug(`[REGISTRY] Could not remove old handler: ${e.message}`);
    }
  }

  const wrappedHandler = async (/** @type {any} */ event, /** @type {any[]} */ ...rawArgs) => {
    const operationId = `${channel}-${++_opCounter}`;
    _inFlightOperations.add(operationId);
    if (_isShuttingDown) {
      _inFlightOperations.delete(operationId);
      logger.debug(`[REGISTRY] Rejecting IPC call during shutdown: ${channel}`);
      return {
        success: false,
        error: {
          code: 'APP_SHUTTING_DOWN',
          message: 'Application is shutting down'
        }
      };
    }
    // Strip the preload-added envelope so handlers never observe it. The
    // traceId (when present) is preferred as the correlation id so every log
    // line within a user action — even if it spans multiple invokes — groups
    // under a single id. The requestId is always the abort key.
    const { args, requestId, traceId } = extractIpcMetaEnvelope(rawArgs);
    const correlationId =
      traceId ||
      extractCorrelationIdFromInvokeArgs(args) ||
      (requestId && ipcAbortRegistry.isValidRequestId(requestId) ? requestId : null) ||
      generateCorrelationId('ipc');
    const senderGate = assertAllowedIpcSender(event, channel);
    if (senderGate) {
      _inFlightOperations.delete(operationId);
      return senderGate;
    }
    let registeredRequestId = null;
    let abortSignal = null;
    if (requestId && ipcAbortRegistry.isValidRequestId(requestId)) {
      abortSignal = ipcAbortRegistry.register(requestId, channel);
      if (abortSignal) {
        registeredRequestId = requestId;
      }
    }
    // Expose the signal to opt-in handlers via a non-enumerable property so
    // pre-existing serialization / logging of the event object is not
    // affected. Handlers can read `event.abortSignal` to cooperatively bail.
    if (abortSignal) {
      try {
        Object.defineProperty(event, 'abortSignal', {
          value: abortSignal,
          enumerable: false,
          configurable: true,
          writable: false
        });
      } catch {
        // If the event is frozen (shouldn't happen for IpcMainInvokeEvent),
        // silently skip — handlers simply won't see the signal.
      }
    }
    try {
      return await withCorrelationId(async () => handler(event, ...args), correlationId);
    } finally {
      if (registeredRequestId) {
        ipcAbortRegistry.unregister(registeredRequestId);
      }
      _inFlightOperations.delete(operationId);
    }
  };

  ipcMain.handle(channel, wrappedHandler);
  registry.handlers.add(channel);
  logger.debug(`[REGISTRY] Handler registered: ${channel}`);
}

/**
 * Wait for in-flight IPC handlers to finish.
 * @param {number} timeoutMs
 * @param {number} [allowedRemaining=0] - Treat this many residual operations
 *   as "drained". Pass 1 when the caller is itself an IPC handler (its own
 *   operation stays in-flight for the duration of the wait and would
 *   otherwise guarantee a timeout).
 * @returns {Promise<boolean>} True if drained before timeout.
 */
async function waitForInFlightOperations(timeoutMs = 5000, allowedRemaining = 0) {
  const start = Date.now();
  while (_inFlightOperations.size > allowedRemaining && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 50);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
  }
  return _inFlightOperations.size <= allowedRemaining;
}

/**
 * Wrap ipcMain.on to track registered listeners
 *
 * @param {any} ipcMain - Electron ipcMain
 * @param {string} channel - Channel name
 * @param {Function} listener - Listener function
 */
function registerListener(ipcMain, channel, listener) {
  if (!channel || typeof channel !== 'string') {
    throw new Error('Channel must be a non-empty string');
  }
  if (!listener || typeof listener !== 'function') {
    throw new Error('Listener must be a function');
  }

  const wrappedListener = (/** @type {any} */ event, /** @type {any[]} */ ...args) => {
    const operationId = `${channel}-${++_opCounter}`;
    _inFlightOperations.add(operationId);
    if (_isShuttingDown) {
      _inFlightOperations.delete(operationId);
      logger.debug(`[REGISTRY] Ignoring IPC listener during shutdown: ${channel}`);
      return;
    }
    // Defense in depth: `ipcMain.handle` registrations already gate on the
    // sender above, but `ipcMain.on` listeners (e.g. `renderer-error-report`,
    // `system:abort-invoke`) previously bypassed this check. A compromised
    // `<webview>` or opener could otherwise fire-and-forget into our main
    // process. Skipping returns any non-null payload from the validator to
    // short-circuit - for `on` listeners we still drop the message so the
    // legitimate listener never sees it.
    const senderGate = assertAllowedIpcSender(event, channel);
    if (senderGate) {
      _inFlightOperations.delete(operationId);
      return;
    }
    try {
      const result = listener(event, ...args);
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).finally(() => _inFlightOperations.delete(operationId));
      }
      _inFlightOperations.delete(operationId);
      return result;
    } catch (error) {
      _inFlightOperations.delete(operationId);
      throw error;
    }
  };

  ipcMain.on(channel, wrappedListener);

  if (!registry.listeners.has(channel)) {
    registry.listeners.set(channel, new Set());
  }
  registry.listeners.get(channel).add(wrappedListener);
  registry.listenerWrappers.set(listener, wrappedListener);
  logger.debug(`[REGISTRY] Listener registered: ${channel}`);
}

/**
 * Remove a specific handler by channel
 *
 * @param {any} ipcMain - Electron ipcMain
 * @param {string} channel - Channel name
 * @returns {boolean} True if handler was removed
 */
function removeHandler(ipcMain, channel) {
  if (!registry.handlers.has(channel)) {
    return false;
  }

  try {
    ipcMain.removeHandler(channel);
    registry.handlers.delete(channel);
    logger.debug(`[REGISTRY] Handler removed: ${channel}`);
    return true;
  } catch (e) {
    logger.error(`[REGISTRY] Failed to remove handler ${channel}:`, e);
    return false;
  }
}

/**
 * Remove a specific listener
 *
 * @param {any} ipcMain - Electron ipcMain
 * @param {string} channel - Channel name
 * @param {Function} listener - Listener function to remove (original, not wrapped)
 * @returns {boolean} True if listener was removed
 */
function removeListener(ipcMain, channel, listener) {
  const channelListeners = registry.listeners.get(channel);
  const wrappedListener = registry.listenerWrappers.get(listener);

  if (!channelListeners || !wrappedListener || !channelListeners.has(wrappedListener)) {
    return false;
  }

  try {
    ipcMain.removeListener(channel, wrappedListener);
    channelListeners.delete(wrappedListener);
    registry.listenerWrappers.delete(listener);

    // Clean up empty channel entry
    if (channelListeners.size === 0) {
      registry.listeners.delete(channel);
    }

    logger.debug(`[REGISTRY] Listener removed: ${channel}`);
    return true;
  } catch (e) {
    logger.error(`[REGISTRY] Failed to remove listener ${channel}:`, e);
    return false;
  }
}

/**
 * Remove all registered handlers and listeners (targeted cleanup)
 *
 * This is the safe alternative to ipcMain.removeAllListeners().
 * It only removes channels that were registered through this registry.
 *
 * @param {any} ipcMain - Electron ipcMain
 * @param {{ excludeChannels?: Set<string> | any[] }} [options]
 *   excludeChannels: Channels to keep registered past this cleanup pass.
 *   Used during shutdown to leave a few diagnostic
 *   channels (e.g. `system:log`) alive past handler teardown so the renderer
 *   can keep logging while the rest of the cleanup runs. The renderer's late
 *   `system:log` calls were generating 'No handler registered' errors after
 *   IPC cleanup in observed shutdown logs.
 * @returns {{handlers: number, listeners: number, kept: string[]}}
 */
function removeAllRegistered(ipcMain, options = {}) {
  let handlersRemoved = 0;
  let listenersRemoved = 0;
  const exclude =
    options.excludeChannels instanceof Set
      ? options.excludeChannels
      : new Set(Array.isArray(options.excludeChannels) ? options.excludeChannels : []);
  const kept = [];

  // Remove all handlers (except excluded)
  const handlersToRemove = [];
  for (const channel of registry.handlers) {
    if (exclude.has(channel)) {
      kept.push(channel);
      continue;
    }
    handlersToRemove.push(channel);
  }
  for (const channel of handlersToRemove) {
    try {
      ipcMain.removeHandler(channel);
      handlersRemoved++;
      registry.handlers.delete(channel);
      logger.debug(`[REGISTRY] Cleanup: removed handler ${channel}`);
    } catch (e) {
      logger.error(`[REGISTRY] Cleanup: failed to remove handler ${channel}:`, e);
    }
  }

  // Remove all listeners (except excluded)
  const listenerChannelsToRemove = [];
  for (const [channel, listeners] of registry.listeners) {
    if (exclude.has(channel)) {
      kept.push(channel);
      continue;
    }
    listenerChannelsToRemove.push([channel, listeners]);
  }
  for (const [channel, listeners] of listenerChannelsToRemove) {
    for (const listener of listeners) {
      try {
        ipcMain.removeListener(channel, listener);
        listenersRemoved++;
      } catch (e) {
        logger.error(`[REGISTRY] Cleanup: failed to remove listener ${channel}:`, e);
      }
    }
    registry.listeners.delete(channel);
  }

  logger.info(
    `[REGISTRY] Cleanup complete: ${handlersRemoved} handlers, ${listenersRemoved} listeners removed${
      kept.length ? ` (${kept.length} kept: ${kept.join(', ')})` : ''
    }`
  );

  return { handlers: handlersRemoved, listeners: listenersRemoved, kept };
}

/**
 * Get statistics about registered channels
 *
 * @returns {{handlers: number, listeners: number, channels: string[]}}
 */
function getStats() {
  const handlerChannels = Array.from(registry.handlers);
  const listenerChannels = Array.from(registry.listeners.keys());
  const allChannels = [...new Set([...handlerChannels, ...listenerChannels])];

  return {
    handlers: registry.handlers.size,
    listeners: Array.from(registry.listeners.values()).reduce((sum, set) => sum + set.size, 0),
    channels: allChannels.sort()
  };
}

/**
 * Check if a handler is registered for a channel
 *
 * @param {string} channel - Channel name
 * @returns {boolean}
 */
function hasHandler(channel) {
  return registry.handlers.has(channel);
}

/**
 * Check if any listeners are registered for a channel
 *
 * @param {string} channel - Channel name
 * @returns {boolean}
 */
function hasListeners(channel) {
  return registry.listeners.has(channel) && registry.listeners.get(channel).size > 0;
}

module.exports = {
  registerHandler,
  registerListener,
  removeHandler,
  removeListener,
  removeAllRegistered,
  getStats,
  hasHandler,
  hasListeners,
  setShuttingDown,
  isShuttingDown,
  waitForInFlightOperations
};
