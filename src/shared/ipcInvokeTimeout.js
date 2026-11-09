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
    channel === IPC_CHANNELS.FILES.PERFORM_OPERATION ||
    channel === IPC_CHANNELS.ORGANIZE.BATCH ||
    channel === IPC_CHANNELS.SMART_FOLDERS.ADD ||
    channel === IPC_CHANNELS.SMART_FOLDERS.GENERATE_DESCRIPTION ||
    channel === IPC_CHANNELS.SMART_FOLDERS.MATCH
  ) {
    timeout = TIMEOUTS.AI_ANALYSIS_LONG || 180000;
  }
  // Batch analysis and batch suggestions can exceed per-file timeouts on CPU-bound systems.
  if (
    channel === IPC_CHANNELS.ANALYSIS.ANALYZE_BATCH ||
    channel === IPC_CHANNELS.SUGGESTIONS.GET_BATCH_SUGGESTIONS
  ) {
    timeout = TIMEOUTS.AI_ANALYSIS_BATCH || 300000;
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
    channel === IPC_CHANNELS.SYSTEM.EXPORT_LOGS ||
    // UAC prompt + the Visual C++ Redistributable installer's own window.
    channel === IPC_CHANNELS.SYSTEM.INSTALL_VC_RUNTIME
  ) {
    timeout = TIMEOUTS.USER_DIALOG || 600000;
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
  getIpcInvokeTimeout
};
