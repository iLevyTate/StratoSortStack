// @ts-check
/**
 * Shared IPC enforcement sets used by both the preload bridge and (potentially)
 * the main-side ipcRegistry. Centralising these prevents the recurring drift
 * problem where a new channel added in `src/shared/constants.js` would silently
 * skip concurrency limiting or event-only enforcement because the author
 * only knew to edit one of two locations (CONSTANTS + the preload set).
 *
 * **Self-validation at module load.** Every entry in every set below is looked
 * up against `IPC_CHANNELS` from `constants.js` at require-time. A missing
 * channel throws synchronously, which surfaces drift at app startup AND in any
 * CI job that imports this module — far stronger than a docs convention.
 *
 * @module ipcEnforcement
 */

const { IPC_CHANNELS } = require('./constants');

/**
 * Resolve a `CATEGORY.ENDPOINT` path against IPC_CHANNELS and throw if missing.
 * Surfaces typos, renames, and removed channels at module-load time so the
 * preload never ships with a "ghost" enforcement entry.
 *
 * @param {string} categoryEndpoint - dotted path like 'EMBEDDINGS.FULL_REBUILD'
 * @returns {string} the resolved channel string
 */
function resolveChannel(categoryEndpoint) {
  const [category, endpoint] = categoryEndpoint.split('.');
  const channels = /** @type {Record<string, Record<string, string>>} */ (
    /** @type {any} */ (IPC_CHANNELS)
  );
  const value = channels?.[category]?.[endpoint];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `ipcEnforcement: IPC_CHANNELS.${categoryEndpoint} is not a registered channel. ` +
        `Either the entry was renamed/removed in src/shared/constants.js or this set ` +
        `references a channel that does not exist. Update both locations together.`
    );
  }
  return value;
}

/**
 * Channels with no `ipcMain.handle()` registration — they are push-from-main
 * events delivered via `safeOn`. Excluded from the invoke whitelist so a typo
 * doesn't burn the `MAX_RETRIES` no-handler retry budget (the `_invokeWithRetries`
 * loop in preload.js) and pollute the rate-limit budget.
 *
 * Keep in sync with the `EVENT_ONLY_CHANNELS` consumer in preload.js (which
 * uses this set to subtract from ALL_SEND_CHANNELS).
 */
const EVENT_ONLY_CHANNEL_REFS = [
  'UNDO_REDO.STATE_CHANGED',
  'VECTOR_DB.STATUS_CHANGED',
  'CHAT.STREAM_CHUNK',
  'CHAT.STREAM_END',
  'MCP.STATUS_CHANGED',
  'AI_PROVIDER.STATUS_CHANGED',
  'DOWNLOADS.TRIAGE_SCAN_PROGRESS',
  'DOWNLOADS.TRIAGE_SESSION_INVALIDATED'
];

const EVENT_ONLY_CHANNELS = new Set(EVENT_ONLY_CHANNEL_REFS.map(resolveChannel));

/**
 * Channels that run expensive operations and must not overlap concurrently.
 * A simple lock map in preload prevents a buggy/compromised renderer from
 * triggering multiple rebuilds.
 *
 * Heavy embedding/LLM/analysis/triage ops + shared-state mutators. Every
 * member is justified inline (kept where it's used: see preload.js for the
 * per-channel rationale comments that survived the refactor).
 */
const CONCURRENCY_LIMITED_CHANNEL_REFS = [
  'EMBEDDINGS.FULL_REBUILD',
  'EMBEDDINGS.REANALYZE_ALL',
  'EMBEDDINGS.REBUILD_FILES',
  'EMBEDDINGS.REBUILD_FOLDERS',
  'EMBEDDINGS.COMPUTE_CLUSTERS',
  'EMBEDDINGS.REBUILD_BM25_INDEX',
  'ANALYSIS.ANALYZE_BATCH',
  'ANALYSIS.ANALYZE_MEDIA',
  // Auto/batch organize run LLM analysis + atomic file moves over the same files;
  // overlapping invocations could double-move or race. Deliberately retained as
  // "core functionality" in ipcVerification REQUIRED_HANDLERS, so harden rather
  // than retire (F-032).
  'ORGANIZE.AUTO',
  'ORGANIZE.BATCH',
  'LLAMA.DOWNLOAD_MODEL',
  'LLAMA.DELETE_MODEL',
  'LLAMA.UPDATE_CONFIG',
  'LLAMA.TEST_CONNECTION',
  'EMBEDDINGS.FIND_DUPLICATES',
  'EMBEDDINGS.TRASH_DUPLICATES',
  'EMBEDDINGS.REINDEX_FILE_HASHES',
  'EMBEDDINGS.CLEAR_CLUSTERS',
  'EMBEDDINGS.RENAME_CLUSTER',
  'EMBEDDINGS.DIAGNOSE_SEARCH',
  'AI_PROVIDER.TEST_PROVIDER',
  'SYSTEM.DISMISS_DEGRADED_FLAG'
  // NOTE: triage start / deep-scan / act use a *shared* lock key via
  // DOWNLOADS_TRIAGE_MUTATION_CHANNELS + resolveConcurrencyLockKey below.
];

const CONCURRENCY_LIMITED_CHANNELS = new Set(CONCURRENCY_LIMITED_CHANNEL_REFS.map(resolveChannel));

/**
 * Lock key shared by all triage-mutation channels — start, deep-scan, and act
 * cannot overlap (they mutate the same triage session state). Implemented as
 * one shared lock key rather than separate per-channel locks.
 */
const DOWNLOADS_TRIAGE_MUTATION_LOCK_KEY = 'downloads:triage:mutation';

const DOWNLOADS_TRIAGE_MUTATION_CHANNEL_REFS = [
  'DOWNLOADS.TRIAGE_START',
  'DOWNLOADS.TRIAGE_DEEP_SCAN',
  'DOWNLOADS.TRIAGE_ACT'
];

const DOWNLOADS_TRIAGE_MUTATION_CHANNELS = new Set(
  DOWNLOADS_TRIAGE_MUTATION_CHANNEL_REFS.map(resolveChannel)
);

/**
 * Resolve the concurrency lock key for a channel. Triage mutations share one
 * key; everything else uses the channel name as the key.
 *
 * @param {string} channel
 * @returns {string}
 */
function resolveConcurrencyLockKey(channel) {
  if (DOWNLOADS_TRIAGE_MUTATION_CHANNELS.has(channel)) {
    return DOWNLOADS_TRIAGE_MUTATION_LOCK_KEY;
  }
  return channel;
}

/**
 * Returns true if the channel requires concurrency serialisation (either via
 * its own lock key or via the shared triage-mutation key).
 *
 * @param {string} channel
 * @returns {boolean}
 */
function isConcurrencyLimited(channel) {
  return (
    CONCURRENCY_LIMITED_CHANNELS.has(channel) || DOWNLOADS_TRIAGE_MUTATION_CHANNELS.has(channel)
  );
}

module.exports = {
  EVENT_ONLY_CHANNELS,
  CONCURRENCY_LIMITED_CHANNELS,
  DOWNLOADS_TRIAGE_MUTATION_CHANNELS,
  DOWNLOADS_TRIAGE_MUTATION_LOCK_KEY,
  resolveConcurrencyLockKey,
  isConcurrencyLimited,
  // Exported for CI verification scripts and tests
  EVENT_ONLY_CHANNEL_REFS,
  CONCURRENCY_LIMITED_CHANNEL_REFS,
  DOWNLOADS_TRIAGE_MUTATION_CHANNEL_REFS
};
