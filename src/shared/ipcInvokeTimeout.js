// @ts-check
/**
 * Maps an IPC channel to its renderer-side invoke timeout (preload SecureIPCManager).
 * Single source of truth — keep in sync with any channel that needs a non-default budget.
 */

const { IPC_CHANNELS } = require('./constants');
const { LIMITS: PERF_LIMITS, TIMEOUTS } = require('./performanceConstants');

/**
 * Live Activity subscribe/unsubscribe only touch an in-memory registry in
 * main. The renderer chains each new subscription behind the previous
 * unsubscribe, so a stuck release must fail fast instead of holding a
 * reconnect for the 330 s default.
 */
const LIVE_LOG_INVOKE_TIMEOUT_MS = 5000;

/**
 * SYSTEM.INSTALL_VC_RUNTIME waits for a UAC prompt plus Microsoft's
 * installer. Main gives up after INSTALL_TIMEOUT_MS (10 min, in
 * src/main/utils/vcRuntimeInstaller.js) and answers `timed-out`; this budget
 * is a minute longer so that answer always reaches the renderer instead of a
 * raw preload timeout. Pinned against the main value by
 * test/vcRuntimeInstaller.test.js.
 */
const VC_RUNTIME_INSTALL_INVOKE_TIMEOUT_MS = 11 * 60 * 1000;

/**
 * ANALYSIS.ANALYZE_BATCH is one request for a whole Discover run. The run has
 * its own watchdogs (no progress, and a cap of at most ANALYSIS_RUN_MAX) and
 * cancels the batch in main when one fires. A fixed 30 minutes here cut every
 * longer run off instead: main was told to stop the batch and the rest went
 * through the per-file path. This budget only has to outlast the run, so that
 * the watchdogs act first.
 */
const ANALYZE_BATCH_INVOKE_TIMEOUT_MS =
  (TIMEOUTS.ANALYSIS_RUN_MAX || 6 * 60 * 60 * 1000) + 3 * (TIMEOUTS.GLOBAL_ANALYSIS || 600000);

/**
 * FILES.PERFORM_OPERATION is one request for a whole organize batch (up to
 * 1000 moves) or one move, copy or delete. A move to another drive copies and
 * checksums the file, so neither has an upper bound. The 5-minute AI budget
 * cut off batches that were still moving files: main was told to stop, the
 * user saw a timeout, and the rest only moved at the next launch. The request
 * therefore gets the longest delay a timer can hold (about 24.8 days; a
 * longer one fires at once). Stop is what ends a batch early, and main gives
 * up on a move that does not answer once the batch is stopped. A single
 * move, copy or delete has no Stop: it ends when the operating system
 * answers or fails the request.
 */
const FILE_OPERATION_INVOKE_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * @param {string} channel
 * @returns {number} Timeout in milliseconds
 */
function getIpcInvokeTimeout(channel) {
  let timeout = PERF_LIMITS.IPC_INVOKE_TIMEOUT || 30000;
  // Folder scans can legitimately take longer than default IPC timeout,
  // especially for large folders or slower/network drives.
  if (channel === IPC_CHANNELS.SMART_FOLDERS.SCAN_STRUCTURE) {
    timeout = TIMEOUTS.DIRECTORY_SCAN || 60000;
  }
  if (
    channel === IPC_CHANNELS.ANALYSIS.ANALYZE_IMAGE ||
    channel === IPC_CHANNELS.ANALYSIS.ANALYZE_DOCUMENT ||
    channel === IPC_CHANNELS.SUGGESTIONS.GET_FILE_SUGGESTIONS ||
    channel === IPC_CHANNELS.ORGANIZE.BATCH ||
    channel === IPC_CHANNELS.SMART_FOLDERS.ADD ||
    channel === IPC_CHANNELS.SMART_FOLDERS.GENERATE_DESCRIPTION ||
    channel === IPC_CHANNELS.SMART_FOLDERS.MATCH
  ) {
    timeout = TIMEOUTS.AI_ANALYSIS_LONG || 180000;
  }
  // Batch suggestions can exceed per-file timeouts on CPU-bound systems.
  if (channel === IPC_CHANNELS.SUGGESTIONS.GET_BATCH_SUGGESTIONS) {
    timeout = TIMEOUTS.AI_ANALYSIS_BATCH || 300000;
  }
  if (channel === IPC_CHANNELS.ANALYSIS.ANALYZE_BATCH) {
    timeout = ANALYZE_BATCH_INVOKE_TIMEOUT_MS;
  }
  if (channel === IPC_CHANNELS.FILES.PERFORM_OPERATION) {
    timeout = FILE_OPERATION_INVOKE_TIMEOUT_MS;
  }
  // Embedding search/scoring operations involve embedding generation through the semaphore
  if (
    channel === IPC_CHANNELS.EMBEDDINGS.SEARCH ||
    channel === IPC_CHANNELS.EMBEDDINGS.FIND_SIMILAR ||
    channel === IPC_CHANNELS.EMBEDDINGS.SCORE_FILES ||
    channel === IPC_CHANNELS.EMBEDDINGS.FIND_MULTI_HOP ||
    channel === IPC_CHANNELS.EMBEDDINGS.COMPUTE_CLUSTERS
  ) {
    timeout = TIMEOUTS.AI_ANALYSIS_LONG || 180000;
  }
  // Embedding rebuild/reanalyze operations are long-running batch jobs
  if (
    channel === IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES ||
    channel === IPC_CHANNELS.EMBEDDINGS.REBUILD_FOLDERS ||
    channel === IPC_CHANNELS.EMBEDDINGS.FULL_REBUILD ||
    channel === IPC_CHANNELS.EMBEDDINGS.REANALYZE_ALL
  ) {
    timeout = TIMEOUTS.AI_ANALYSIS_BATCH || 300000;
  }
  // Chat streaming involves retrieval (search + BM25 rebuild + re-ranking)
  // plus LLM inference, which routinely exceeds the 30s default timeout
  if (channel === IPC_CHANNELS.CHAT.QUERY_STREAM) {
    timeout = TIMEOUTS.AI_ANALYSIS_LONG || 180000;
  }
  if (
    channel === IPC_CHANNELS.DOWNLOADS.TRIAGE_START ||
    channel === IPC_CHANNELS.DOWNLOADS.TRIAGE_DEEP_SCAN ||
    channel === IPC_CHANNELS.DOWNLOADS.TRIAGE_ACT
  ) {
    timeout = TIMEOUTS.TRIAGE_SCAN_LONG || 900000;
  }
  // Channels whose handler blocks on a native modal dialog (file/folder
  // pickers, save-as). The 30s default races the USER's thinking time: the
  // preload rejected with a raw timeout while the dialog stayed open, and a
  // late "Save" still wrote the file after the UI had already shown failure.
  if (
    channel === IPC_CHANNELS.FILES.SELECT ||
    channel === IPC_CHANNELS.FILES.SELECT_DIRECTORY ||
    channel === IPC_CHANNELS.DOWNLOADS.TRIAGE_EXPORT_REPORT ||
    channel === IPC_CHANNELS.ANALYSIS_HISTORY.EXPORT ||
    channel === IPC_CHANNELS.ANALYSIS_HISTORY.EXPORT_TRANSCRIPT ||
    channel === IPC_CHANNELS.SETTINGS.EXPORT ||
    channel === IPC_CHANNELS.SETTINGS.IMPORT ||
    channel === IPC_CHANNELS.SYSTEM.EXPORT_LOGS
  ) {
    timeout = TIMEOUTS.USER_DIALOG || 600000;
  }
  // UAC prompt + the Visual C++ Redistributable installer's own window.
  if (channel === IPC_CHANNELS.SYSTEM.INSTALL_VC_RUNTIME) {
    timeout = VC_RUNTIME_INSTALL_INVOKE_TIMEOUT_MS;
  }
  if (
    channel === IPC_CHANNELS.SYSTEM.LIVE_LOG_SUBSCRIBE ||
    channel === IPC_CHANNELS.SYSTEM.LIVE_LOG_UNSUBSCRIBE
  ) {
    timeout = LIVE_LOG_INVOKE_TIMEOUT_MS;
  }
  return timeout;
}

module.exports = {
  ANALYZE_BATCH_INVOKE_TIMEOUT_MS,
  FILE_OPERATION_INVOKE_TIMEOUT_MS,
  VC_RUNTIME_INSTALL_INVOKE_TIMEOUT_MS,
  getIpcInvokeTimeout
};
