// @ts-check
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { IpcRateLimiter } = require('./ipcRateLimiter');
const { createIpcSanitizer } = require('./ipcSanitizer');
const { createIpcValidator } = require('./ipcValidator');
const { sanitizePath } = require('../shared/pathSanitization');
// Import performance constants for configuration values
const { LIMITS: PERF_LIMITS, TIMEOUTS } = require('../shared/performanceConstants');
const { getIpcInvokeTimeout } = require('../shared/ipcInvokeTimeout');
// Import centralized security config to avoid channel definition drift
const {
  ALLOWED_RECEIVE_CHANNELS: SECURITY_RECEIVE_CHANNELS,
  SETTINGS_VALIDATION
} = require('../shared/securityConfig');
// Import image/audio/video extensions from constants.js (single source of truth) to avoid hardcoded drift
const {
  SUPPORTED_IMAGE_EXTENSIONS,
  SUPPORTED_AUDIO_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS
} = require('../shared/constants');
// Audit item #2: centralised IPC enforcement sets. Previously these lived inline
// in preload.js, which created a two-location drift problem — a new channel
// added in constants.js needed remembering in preload too or it would silently
// skip concurrency limiting / event-only enforcement. The shared module
// self-validates every entry against IPC_CHANNELS at load time.
const {
  EVENT_ONLY_CHANNELS,
  CONCURRENCY_LIMITED_CHANNELS,
  DOWNLOADS_TRIAGE_MUTATION_CHANNELS,
  resolveConcurrencyLockKey
} = require('../shared/ipcEnforcement');

// === START GENERATED IPC_CHANNELS ===
// Auto-generated from src/shared/constants.js
// Run 'npm run generate:channels' to update
const IPC_CHANNELS = {
  // FILES
  FILES: {
    SELECT: 'files:select',
    SELECT_DIRECTORY: 'files:select-directory',
    GET_DOCUMENTS_PATH: 'files:get-documents-path',
    CREATE_FOLDER_DIRECT: 'files:create-folder-direct',
    GET_FILE_STATS: 'files:get-stats',
    GET_FILES_IN_DIRECTORY: 'files:get-in-directory',
    PERFORM_OPERATION: 'files:perform-operation',
    DELETE_FILE: 'files:delete',
    OPEN_FILE: 'files:open',
    REVEAL_FILE: 'files:reveal',
    COPY_FILE: 'files:copy',
    OPEN_FOLDER: 'files:open-folder',
    DELETE_FOLDER: 'files:delete-folder',
    CLEANUP_ANALYSIS: 'files:cleanup-analysis',
    ADD_TAGS: 'files:add-tags'
  },

  // SMART_FOLDERS
  SMART_FOLDERS: {
    GET: 'smart-folders:get',
    SAVE: 'smart-folders:save',
    UPDATE_CUSTOM: 'smart-folders:update-custom',
    GET_CUSTOM: 'smart-folders:get-custom',
    SCAN_STRUCTURE: 'smart-folders:scan-structure',
    ADD: 'smart-folders:add',
    EDIT: 'smart-folders:edit',
    DELETE: 'smart-folders:delete',
    MATCH: 'smart-folders:match',
    RESET_TO_DEFAULTS: 'smart-folders:reset-defaults',
    GENERATE_DESCRIPTION: 'smart-folders:generate-description',
    WATCHER_START: 'smart-folders:watcher-start',
    WATCHER_STOP: 'smart-folders:watcher-stop',
    WATCHER_STATUS: 'smart-folders:watcher-status'
  },

  // ANALYSIS
  ANALYSIS: {
    ANALYZE_DOCUMENT: 'analysis:analyze-document',
    ANALYZE_IMAGE: 'analysis:analyze-image',
    ANALYZE_MEDIA: 'analysis:analyze-media',
    ANALYZE_BATCH: 'analysis:analyze-batch',
    CANCEL_BATCH: 'analysis:cancel-batch',
    EXTRACT_IMAGE_TEXT: 'analysis:extract-image-text',
    GET_READY_QUEUE: 'analysis:get-ready-queue',
    CLEAR_READY_QUEUE: 'analysis:clear-ready-queue'
  },

  // SETTINGS
  SETTINGS: {
    GET: 'settings:get',
    SAVE: 'settings:save',
    GET_CONFIGURABLE_LIMITS: 'settings:get-limits',
    GET_LOGS_INFO: 'settings:get-logs-info',
    OPEN_LOGS_FOLDER: 'settings:open-logs-folder',
    EXPORT: 'settings:export',
    IMPORT: 'settings:import',
    CREATE_BACKUP: 'settings:create-backup',
    LIST_BACKUPS: 'settings:list-backups',
    RESTORE_BACKUP: 'settings:restore-backup',
    DELETE_BACKUP: 'settings:delete-backup'
  },

  // LLAMA
  LLAMA: {
    GET_MODELS: 'llama:get-models',
    GET_CONFIG: 'llama:get-config',
    UPDATE_CONFIG: 'llama:update-config',
    TEST_CONNECTION: 'llama:test-connection',
    DOWNLOAD_MODEL: 'llama:download-model',
    DELETE_MODEL: 'llama:delete-model',
    GET_DOWNLOAD_STATUS: 'llama:get-download-status',
    CANCEL_DOWNLOAD: 'llama:cancel-download',
    WARM: 'llama:warm'
  },

  // WHISPER
  WHISPER: {
    GET_INSTALL_STATUS: 'whisper:get-install-status',
    INSTALL_MODEL: 'whisper:install-model'
  },

  // UNDO_REDO
  UNDO_REDO: {
    UNDO: 'undo-redo:undo',
    REDO: 'undo-redo:redo',
    GET_HISTORY: 'undo-redo:get-history',
    GET_STATE: 'undo-redo:get-state',
    CLEAR_HISTORY: 'undo-redo:clear',
    CAN_UNDO: 'undo-redo:can-undo',
    CAN_REDO: 'undo-redo:can-redo',
    STATE_CHANGED: 'undo-redo:state-changed'
  },

  // ANALYSIS_HISTORY
  ANALYSIS_HISTORY: {
    GET: 'analysis-history:get',
    SEARCH: 'analysis-history:search',
    GET_STATISTICS: 'analysis-history:get-statistics',
    GET_FILE_HISTORY: 'analysis-history:get-file-history',
    SET_EMBEDDING_POLICY: 'analysis-history:set-embedding-policy',
    CLEAR: 'analysis-history:clear',
    EXPORT: 'analysis-history:export',
    EXPORT_TRANSCRIPT: 'analysis-history:export-transcript',
    GET_TIMELINE: 'analysis-history:get-timeline'
  },

  // EMBEDDINGS
  EMBEDDINGS: {
    REBUILD_FOLDERS: 'embeddings:rebuild-folders',
    REBUILD_FILES: 'embeddings:rebuild-files',
    FULL_REBUILD: 'embeddings:full-rebuild',
    REANALYZE_ALL: 'embeddings:reanalyze-all',
    REANALYZE_FILE: 'embeddings:reanalyze-file',
    GET_STATS: 'embeddings:get-stats',
    SEARCH: 'embeddings:search',
    SCORE_FILES: 'embeddings:score-files',
    FIND_SIMILAR: 'embeddings:find-similar',
    REBUILD_BM25_INDEX: 'embeddings:rebuild-bm25',
    GET_SEARCH_STATUS: 'embeddings:get-search-status',
    DIAGNOSE_SEARCH: 'embeddings:diagnose-search',
    FIND_MULTI_HOP: 'embeddings:find-multi-hop',
    COMPUTE_CLUSTERS: 'embeddings:compute-clusters',
    GET_CLUSTERS: 'embeddings:get-clusters',
    GET_CLUSTER_MEMBERS: 'embeddings:get-cluster-members',
    GET_SIMILARITY_EDGES: 'embeddings:get-similarity-edges',
    GET_FILE_METADATA: 'embeddings:get-file-metadata',
    FIND_FILES_BY_PATHS: 'embeddings:find-files-by-paths',
    FIND_DUPLICATES: 'embeddings:find-duplicates',
    TRASH_DUPLICATES: 'embeddings:trash-duplicates',
    REINDEX_FILE_HASHES: 'embeddings:reindex-file-hashes',
    CLEAR_CLUSTERS: 'embeddings:clear-clusters',
    RENAME_CLUSTER: 'embeddings:rename-cluster'
  },

  // ATLAS
  ATLAS: {
    GET_PROJECTION: 'atlas:get-projection',
    GET_STATUS: 'atlas:get-status'
  },

  // SYSTEM
  SYSTEM: {
    GET_METRICS: 'system:get-metrics',
    GET_APPLICATION_STATISTICS: 'system:get-app-stats',
    GET_RUNTIME_INFO: 'system:get-runtime-info',
    APPLY_UPDATE: 'system:apply-update',
    CHECK_FOR_UPDATES: 'system:check-for-updates',
    DOWNLOAD_UPDATE: 'system:download-update',
    GET_CONFIG: 'system:get-config',
    GET_CONFIG_VALUE: 'system:get-config-value',
    RENDERER_ERROR_REPORT: 'renderer-error-report',
    GET_RECOMMENDED_CONCURRENCY: 'system:get-recommended-concurrency',
    LOG: 'system:log',
    EXPORT_LOGS: 'system:export-logs',
    GET_DEGRADED_STATE: 'system:get-degraded-state',
    DISMISS_DEGRADED_FLAG: 'system:dismiss-degraded-flag',
    ABORT_INVOKE: 'system:abort-invoke',
    GET_LEGAL_NOTICES: 'system:get-legal-notices',
    OPEN_LEGAL_DOCUMENT: 'system:open-legal-document'
  },

  // WINDOW
  WINDOW: {
    MINIMIZE: 'window:minimize',
    TOGGLE_MAXIMIZE: 'window:toggle-maximize',
    IS_MAXIMIZED: 'window:is-maximized',
    CLOSE: 'window:close',
    SET_THEME_BACKGROUND: 'window:set-theme-background'
  },

  // LICENSE
  LICENSE: {
    GET_STATUS: 'license:get-status',
    ACTIVATE: 'license:activate',
    DEACTIVATE: 'license:deactivate'
  },

  // SUGGESTIONS
  SUGGESTIONS: {
    GET_FILE_SUGGESTIONS: 'suggestions:get-file',
    GET_BATCH_SUGGESTIONS: 'suggestions:get-batch',
    RECORD_FEEDBACK: 'suggestions:record-feedback',
    GET_STRATEGIES: 'suggestions:get-strategies',
    APPLY_STRATEGY: 'suggestions:apply-strategy',
    GET_USER_PATTERNS: 'suggestions:get-user-patterns',
    CLEAR_PATTERNS: 'suggestions:clear-patterns',
    ANALYZE_FOLDER_STRUCTURE: 'suggestions:analyze-folder-structure',
    SUGGEST_NEW_FOLDER: 'suggestions:suggest-new-folder',
    ADD_FEEDBACK_MEMORY: 'suggestions:add-feedback-memory',
    GET_FEEDBACK_MEMORY: 'suggestions:get-feedback-memory',
    UPDATE_FEEDBACK_MEMORY: 'suggestions:update-feedback-memory',
    DELETE_FEEDBACK_MEMORY: 'suggestions:delete-feedback-memory'
  },

  // ORGANIZE
  ORGANIZE: {
    AUTO: 'organize:auto',
    BATCH: 'organize:batch',
    PROCESS_NEW: 'organize:process-new',
    GET_STATS: 'organize:get-stats',
    CLUSTER_BATCH: 'organize:cluster-batch',
    IDENTIFY_OUTLIERS: 'organize:identify-outliers',
    GET_CLUSTER_SUGGESTIONS: 'organize:get-cluster-suggestions'
  },

  // VECTOR_DB
  VECTOR_DB: {
    GET_STATS: 'vectordb:get-stats',
    HEALTH_CHECK: 'vectordb:health-check',
    STATUS_CHANGED: 'vectordb:status-changed'
  },

  // CHAT
  CHAT: {
    QUERY_STREAM: 'chat:query-stream',
    CANCEL_STREAM: 'chat:cancel-stream',
    STREAM_CHUNK: 'chat:stream-chunk',
    STREAM_END: 'chat:stream-end',
    RESET_SESSION: 'chat:reset-session',
    LIST_CONVERSATIONS: 'chat:list-conversations',
    GET_CONVERSATION: 'chat:get-conversation',
    DELETE_CONVERSATION: 'chat:delete-conversation',
    SEARCH_CONVERSATIONS: 'chat:search-conversations',
    EXPORT_CONVERSATION: 'chat:export-conversation'
  },

  // KNOWLEDGE
  KNOWLEDGE: {
    GET_RELATIONSHIP_EDGES: 'knowledge:get-relationship-edges',
    GET_RELATIONSHIP_STATS: 'knowledge:get-relationship-stats',
    GET_RELATED_DOCUMENTS: 'knowledge:get-related-documents',
    REBUILD_RELATIONSHIPS: 'knowledge:rebuild-relationships'
  },

  // DOWNLOADS
  DOWNLOADS: {
    TRIAGE_START: 'downloads:triage:start',
    TRIAGE_DEEP_SCAN: 'downloads:triage:deep-scan',
    TRIAGE_ACT: 'downloads:triage:act',
    TRIAGE_EXPORT_REPORT: 'downloads:triage:export-report',
    TRIAGE_SCAN_PROGRESS: 'downloads:triage:scan-progress',
    TRIAGE_SESSION_INVALIDATED: 'downloads:triage:session-invalidated'
  },

  // MCP
  MCP: {
    STATUS: 'mcp:status',
    ENABLE: 'mcp:enable',
    DISABLE: 'mcp:disable',
    ROTATE_TOKEN: 'mcp:rotate-token',
    GET_CONFIG_SNIPPET: 'mcp:get-config-snippet',
    TEST_CONNECTION: 'mcp:test-connection',
    STATUS_CHANGED: 'mcp:status-changed'
  },

  // AI_PROVIDER
  AI_PROVIDER: {
    GET_CONFIG: 'ai-provider:get-config',
    SET_PROVIDER_CONFIG: 'ai-provider:set-provider-config',
    SET_KEY: 'ai-provider:set-key',
    GET_KEY_STATUS: 'ai-provider:get-key-status',
    REMOVE_KEY: 'ai-provider:remove-key',
    TEST_PROVIDER: 'ai-provider:test-provider',
    GET_USAGE: 'ai-provider:get-usage',
    SET_ROUTING: 'ai-provider:set-routing',
    ACKNOWLEDGE_CLOUD: 'ai-provider:acknowledge-cloud',
    STATUS_CHANGED: 'ai-provider:status-changed'
  }
};

const IPC_EVENTS = {
  SYSTEM_METRICS: 'system-metrics',
  OPERATION_PROGRESS: 'operation-progress',
  APP_ERROR: 'app:error',
  APP_UPDATE: 'app:update',
  MENU_ACTION: 'menu-action',
  OPEN_SEMANTIC_SEARCH: 'open-semantic-search',
  SETTINGS_CHANGED_EXTERNAL: 'settings-changed-external',
  FILE_OPERATION_COMPLETE: 'file-operation-complete',
  NOTIFICATION: 'notification',
  NOTIFICATION_ACTION: 'notification-action',
  BATCH_RESULTS_CHUNK: 'batch-results-chunk',
  SMART_FOLDERS_UPDATED: 'smart-folders-updated',
  ANALYSIS_FILE_COMPLETE: 'analysis:file-complete'
};
// === END GENERATED IPC_CHANNELS ===

const isPreloadDevMode = process?.env?.NODE_ENV === 'development';
const PRELOAD_LOG_LEVEL = isPreloadDevMode ? 'debug' : 'info';

/** @param {string} level */
const shouldLogPreloadLevel = (level) => {
  /** @type {Record<string, number>} */
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  return levels[level] >= levels[PRELOAD_LOG_LEVEL];
};

/** @param {any} value */
const serializePreloadLogData = (value) => {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }
  return value;
};

const MAX_SYSTEM_LOG_MESSAGE_CHARS = 8192;
const ALLOWED_SYSTEM_LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

/**
 * @param {string} level
 * @param {any} message
 * @param {any} data
 */
const normalizeSystemLogPayload = (level, message, data) => {
  const normalizedLevel = ALLOWED_SYSTEM_LOG_LEVELS.has(level) ? level : 'info';

  let normalizedMessage = '';
  if (typeof message === 'string') {
    normalizedMessage = message;
  } else if (message instanceof Error) {
    normalizedMessage = message.message || String(message);
  } else if (message != null) {
    normalizedMessage = String(message);
  }
  if (!normalizedMessage) {
    normalizedMessage = '[renderer-log]';
  }
  if (normalizedMessage.length > MAX_SYSTEM_LOG_MESSAGE_CHARS) {
    normalizedMessage = normalizedMessage.slice(0, MAX_SYSTEM_LOG_MESSAGE_CHARS);
  }

  const serializedData = serializePreloadLogData(data);
  /** @type {Record<string, any>} */
  let normalizedData = {};
  if (serializedData && typeof serializedData === 'object' && !Array.isArray(serializedData)) {
    normalizedData = serializedData;
  } else if (Array.isArray(serializedData)) {
    normalizedData = { items: serializedData };
  } else if (serializedData != null) {
    normalizedData = { value: serializedData };
  }

  return {
    level: normalizedLevel,
    message: normalizedMessage,
    data: normalizedData
  };
};

// Internal rate limiter for preload-originated log writes. Previously
// writePreloadLog invoked ipcRenderer directly, bypassing
// SecureIPCManager's rate limiter, which meant a runaway log loop inside
// preload could flood the main process without backpressure. A fresh
// SecureIPCManager-style rate limiter isn't usable here because this
// helper exists before the manager instantiates (logs fire during
// module-init); so we run a tiny fixed-window limiter local to the log
// path. The limits below are generous (60 msg / 1000ms) compared to a
// healthy app's natural preload logging (<1/s) — they only bite under
// pathological loops.
const PRELOAD_LOG_WINDOW_MS = 1000;
const PRELOAD_LOG_WINDOW_MAX = 60;
const PRELOAD_LOG_INVOKE_TIMEOUT_MS = 5000;
let preloadLogWindowStart = Date.now();
let preloadLogWindowCount = 0;
let preloadLogDroppedSinceReport = 0;

const shouldSkipForRateLimit = () => {
  const now = Date.now();
  if (now - preloadLogWindowStart >= PRELOAD_LOG_WINDOW_MS) {
    preloadLogWindowStart = now;
    preloadLogWindowCount = 0;
  }
  if (preloadLogWindowCount >= PRELOAD_LOG_WINDOW_MAX) {
    preloadLogDroppedSinceReport += 1;
    return true;
  }
  preloadLogWindowCount += 1;
  return false;
};

/**
 * @param {string} channel
 * @param {any} payload
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
const invokeWithTimeout = (channel, payload, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve();
      }
    }, timeoutMs);
    /** @type {any} */ (timer).unref?.();
    const finish = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    };
    let pending;
    try {
      pending = ipcRenderer.invoke(channel, payload);
    } catch {
      finish();
      return;
    }
    // Tests and some sandboxed environments may mock ipcRenderer.invoke to
    // return a non-Promise (or undefined). Guard so writePreloadLog never
    // throws a synchronous error out of a best-effort log call.
    if (!pending || typeof pending.then !== 'function') {
      finish();
      return;
    }
    // Intentionally fire-and-forget: preload log writes are best-effort and
    // must never propagate back to the caller. `finish()` handles both paths.
    void pending.then(finish, finish);
  });

/**
 * @param {string} level
 * @param {any} message
 * @param {any} [data]
 */
const writePreloadLog = (level, message, data) => {
  if (!shouldLogPreloadLevel(level)) return;
  if (shouldSkipForRateLimit()) return;
  const payload = serializePreloadLogData(data);
  try {
    const normalized = normalizeSystemLogPayload(level, `[Preload] ${message}`, payload);
    if (
      preloadLogDroppedSinceReport > 0 &&
      normalized.data &&
      typeof normalized.data === 'object'
    ) {
      /** @type {any} */ (normalized.data).preloadLogDropped = preloadLogDroppedSinceReport;
      preloadLogDroppedSinceReport = 0;
    }
    invokeWithTimeout(IPC_CHANNELS.SYSTEM.LOG, normalized, PRELOAD_LOG_INVOKE_TIMEOUT_MS);
  } catch {
    // Ignore logging errors to prevent infinite loops
  }
};

const log = {
  /** @param {any} message @param {any} [data] */
  debug: (message, data) => writePreloadLog('debug', message, data),
  /** @param {any} message @param {any} [data] */
  info: (message, data) => writePreloadLog('info', message, data),
  /** @param {any} message @param {any} [data] */
  warn: (message, data) => writePreloadLog('warn', message, data),
  /** @param {any} message @param {any} [error] */
  error: (message, error) => writePreloadLog('error', message, error)
};

/**
 * @param {string} query
 * @param {Record<string, any>} [options]
 */
const buildEmbeddingSearchPayload = (query, options = {}) => {
  const {
    topK = 20,
    mode = 'hybrid',
    minScore,
    chunkWeight,
    chunkTopK,
    correctSpelling,
    expandSynonyms,
    rerank,
    rerankTopN
  } = options;

  return {
    query,
    topK,
    mode,
    // Optional numerical/boolean parameters
    ...(Number.isFinite(minScore) && { minScore }),
    ...(Number.isFinite(chunkWeight) && { chunkWeight }),
    ...(Number.isInteger(chunkTopK) && { chunkTopK }),
    ...(typeof correctSpelling === 'boolean' && { correctSpelling }),
    ...(typeof expandSynonyms === 'boolean' && { expandSynonyms }),
    ...(typeof rerank === 'boolean' && { rerank }),
    ...(Number.isInteger(rerankTopN) && { rerankTopN })
  };
};

log.info('Secure preload script loaded');

// Dynamically derive allowed send channels from centralized IPC_CHANNELS to prevent drift.
// Iterating keys here means new categories added to IPC_CHANNELS (e.g. AI_PROVIDER, MCP)
// are picked up automatically without a parallel manual edit to this list. The previous
// hand-curated form drifted twice (AI_PROVIDER, MCP), causing "Unauthorized IPC channel"
// errors that locked the renderer out of correctly-registered handlers.
/** @type {Record<string, string[]>} */
const ALLOWED_CHANNELS = Object.fromEntries(
  Object.entries(IPC_CHANNELS).map(([category, channels]) => [
    category,
    Object.values(channels || {}).filter((/** @type {any} */ value) => typeof value === 'string')
  ])
);

const ALLOWED_RECEIVE_CHANNELS = [...SECURITY_RECEIVE_CHANNELS];

// Flatten allowed send channels for validation (Set for O(1) lookup and no coercion edge cases)
const ALL_SEND_CHANNELS = new Set(Object.values(ALLOWED_CHANNELS).flat());

// Fix 2A: Event-only channels (main→renderer push events with no ipcMain.handle()
// registration) are excluded from the invoke whitelist so a typo doesn't burn
// the `MAX_RETRIES` no-handler retry budget and pollute the rate-limit budget.
// Membership lives in `src/shared/ipcEnforcement.js` (audit item #2 — formerly
// hand-maintained here).
for (const ch of EVENT_ONLY_CHANNELS) {
  ALL_SEND_CHANNELS.delete(ch);
}

// Fix 1B: Build image extension set from constants.js (single source of truth).
// SUPPORTED_IMAGE_EXTENSIONS entries are ".jpg" format; strip leading dot for routing comparison.
const IMAGE_EXT_SET = new Set(SUPPORTED_IMAGE_EXTENSIONS.map((e) => e.slice(1)));
// Media (audio + video) extension set — routes single-file analyze() calls to
// ANALYZE_MEDIA so videos/audio reach the WhisperService transcript pipeline
// instead of falling through to ANALYZE_DOCUMENT (which can't extract text
// from binary media containers). Mirrors the BatchAnalysisService partitioner
// in src/main/services/analysisRouting.js so the single-file and batch paths
// agree on classification.
const MEDIA_EXT_SET = new Set(
  [...SUPPORTED_AUDIO_EXTENSIONS, ...SUPPORTED_VIDEO_EXTENSIONS].map((e) => e.slice(1))
);

const THROTTLED_CHANNELS = new Map([
  // Avoid request bursts on large folder scans.
  [IPC_CHANNELS.FILES.GET_FILE_STATS, 25]
]);
const EMBEDDINGS_STATS_CACHE_MS = 5000;

// Fix 1C: Channels that run expensive operations and must not overlap
// concurrently. A simple lock map prevents a buggy/compromised renderer from
// triggering multiple rebuilds. Membership and the per-channel rationale now
// live in `src/shared/ipcEnforcement.js` (audit item #2) — moving them to a
// shared module killed the recurring drift bug where adding a channel to
// constants.js silently skipped concurrency limiting because the author
// only edited one of two locations.
//
// Triage start / deep-scan / act use a *shared* lock key via the same module's
// `resolveConcurrencyLockKey` + DOWNLOADS_TRIAGE_MUTATION_CHANNELS.

// Fix 2C: Payload size limits enforced recursively before sanitization.
// The original O(1) top-level checks were trivially bypassed by nesting one
// level deep ({ chunk: { items: [<10k items>] } }, { payload: 'A'.repeat(50e6) }).
// Now applied at every level of the payload tree with a shared budget so
// fanned-out payloads can't exceed the documented MEMORY.md guarantees.
const PAYLOAD_MAX_STRING_LENGTH = 5 * 1024 * 1024; // 5MB
const PAYLOAD_MAX_ARRAY_ITEMS = 10000;
const PAYLOAD_MAX_OBJECT_KEYS = 5000;
const PAYLOAD_MAX_BUFFER_BYTES = 5 * 1024 * 1024; // 5MB — same budget as strings
const PAYLOAD_MAX_WALK_DEPTH = 32; // matches sanitizer MAX_SANITIZE_DEPTH

/**
 * Walk the payload tree and reject if any node exceeds the per-node size
 * limits. Throws on first violation with a message identifying which limit
 * was breached. Cycle-safe via WeakSet to avoid infinite recursion on
 * accidentally circular renderer state.
 *
 * Binary types (TypedArray, ArrayBuffer) and collection types (Map, Set)
 * are short-circuited BEFORE Object.keys() because:
 *   - Object.keys(uint8) materializes a string array of length === byteLength
 *     (e.g. 50MB → 52,428,800 strings → hundreds of MB allocated). A renderer
 *     could DoS the preload by repeatedly sending typed arrays just to make
 *     us allocate that key array before we throw.
 *   - Plain ArrayBuffer has zero own keys so the original recursive walk would
 *     pass it through; structured-clone IPC then serializes the full byte
 *     payload regardless of our string/array limits.
 *   - Map/Set have zero own keys for the same reason — a 10M-entry Map would
 *     bypass the array-item cap entirely.
 */
/**
 * @param {any} value
 * @param {number} depth
 * @param {WeakSet<object>} seen
 */
function enforcePayloadSizeLimits(value, depth, seen) {
  if (depth > PAYLOAD_MAX_WALK_DEPTH) {
    // Don't traverse below depth limit — sanitizer will collapse it later.
    return;
  }
  if (typeof value === 'string') {
    if (value.length > PAYLOAD_MAX_STRING_LENGTH) {
      throw new Error('IPC payload too large: string exceeds 5MB limit');
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > PAYLOAD_MAX_ARRAY_ITEMS) {
      throw new Error('IPC payload too large: array exceeds 10,000 item limit');
    }
    if (seen.has(value)) return;
    seen.add(value);
    for (const item of value) {
      enforcePayloadSizeLimits(item, depth + 1, seen);
    }
    return;
  }
  // Binary/collection short-circuits BEFORE Object.keys() to avoid the DoS
  // patterns described in the JSDoc. Order matters: ArrayBuffer.isView is
  // true for Buffer/TypedArray/DataView; ArrayBuffer instanceof check covers
  // raw ArrayBuffers passed through structured clone.
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    if (value.byteLength > PAYLOAD_MAX_BUFFER_BYTES) {
      throw new Error(
        `IPC payload too large: binary buffer exceeds ${PAYLOAD_MAX_BUFFER_BYTES} byte limit`
      );
    }
    return; // never recurse into binary content
  }
  if (value instanceof Map || value instanceof Set) {
    if (value.size > PAYLOAD_MAX_ARRAY_ITEMS) {
      throw new Error(
        `IPC payload too large: ${value.constructor.name} exceeds 10,000 entry limit`
      );
    }
    if (seen.has(value)) return;
    seen.add(value);
    for (const item of value) {
      enforcePayloadSizeLimits(item, depth + 1, seen);
    }
    return;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return;
    seen.add(value);
    const keys = Object.keys(value);
    if (keys.length > PAYLOAD_MAX_OBJECT_KEYS) {
      throw new Error('IPC payload too large: object exceeds 5,000 key limit');
    }
    for (const key of keys) {
      enforcePayloadSizeLimits(value[key], depth + 1, seen);
    }
  }
}

/**
 * Enhanced IPC validation with security checks
 */
class SecureIPCManager {
  constructor() {
    /** @type {Map<string, any>} */
    this.activeListeners = new Map();
    this._listenerCounter = 0;
    // Listener audit bookkeeping (used to detect growth/leaks without breaking long-lived subs)
    this._lastListenerAuditAt = Date.now();
    this._lastListenerAuditCount = 0;
    this.rateLimiter = new IpcRateLimiter({
      maxRequestsPerSecond: PERF_LIMITS.MAX_IPC_REQUESTS_PER_SECOND,
      perfLimits: PERF_LIMITS
    });
    /** @type {Map<string, any[]>} */
    this.channelQueues = new Map();
    /** @type {Map<string, number>} */
    this._channelQueueTimestamps = new Map();
    /** @type {Map<string, string>} */
    this._inflightInvokes = new Map();
    /** @type {{ value: any, expiresAt: number, pending: Promise<any>|null }} */
    this._embeddingsStatsCache = { value: null, expiresAt: 0, pending: null };
    /** @type {Map<string, Promise<any>>} */
    this._concurrencyLocks = new Map();
    this.sanitizer = createIpcSanitizer({ log });
    this.validator = createIpcValidator({ log });
    /** @type {number|undefined} */
    this._ipcRequestCounter = undefined;
  }

  /**
   * Rate limiting to prevent IPC abuse
   * Fixed: Add cleanup to prevent memory leaks
   */
  /** @param {string} channel */
  checkRateLimit(channel) {
    return this.rateLimiter.checkRateLimit(channel);
  }

  /** @param {string} channel */
  _getInvokeTimeout(channel) {
    return getIpcInvokeTimeout(channel);
  }

  /**
   * Generate a request id for an IPC invoke. Used both as a correlation id in
   * logs and as the abort key so that a preload-side timeout can signal the
   * main handler to cancel cooperatively.
   *
   * Format is intentionally narrow (`[\w.:-]+`) so the main-side validator
   * can safely reject anything that could be used for log injection.
   */
  _generateIpcRequestId() {
    const counter = (this._ipcRequestCounter = (this._ipcRequestCounter || 0) + 1);
    const rand =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
        : Math.random().toString(36).slice(2, 14);
    return `rq-${Date.now().toString(36)}-${counter.toString(36)}-${rand}`;
  }

  /**
   * Build the abort envelope appended as the last argument to every
   * `ipcRenderer.invoke` call. The main-side ipcRegistry wrapper strips this
   * before calling the handler.
   *
   * The envelope also carries an optional `traceId` originated by the renderer
   * (e.g. scoped to a user action spanning multiple invokes). When present,
   * the main-side wrapper uses it as the correlation id for structured logs,
   * so every log line produced by the handler can be grouped under the same
   * user action in aggregate log analysis.
   */
  /** @param {string} requestId */
  _buildIpcMetaEnvelope(requestId) {
    /** @type {{ __stratosortIpcMeta: { requestId: string, sentAt: number, traceId?: string } }} */
    const envelope = {
      __stratosortIpcMeta: {
        requestId,
        sentAt: Date.now()
      }
    };
    const traceId = this._currentTraceId();
    if (traceId) {
      envelope.__stratosortIpcMeta.traceId = traceId;
    }
    return envelope;
  }

  /**
   * Return the renderer-originated trace id for the currently active session,
   * or null if no session is active. Callers (Redux thunks, user-action
   * handlers) start a session via `electronAPI.trace.beginSession` and end it
   * via the returned dispose handle.
   *
   * Renderer is single-threaded; concurrent user actions MUST pass distinct
   * trace ids explicitly (not via the ambient session).
   */
  _currentTraceId() {
    /** @type {{ traceId: string, startedAt: number, expiresAt: number, maxDurationMs: number, warnedExpired: boolean } | null} */
    const session = this._activeTraceSession;
    if (!session) return null;
    if (session.expiresAt && Date.now() > session.expiresAt) {
      // Safety valve: don't leak an old trace id if the caller forgot to end
      // the session. Warn once so callers can fix the leak.
      if (!session.warnedExpired) {
        session.warnedExpired = true;
        log.warn(
          `[Trace] Session ${session.traceId} exceeded ${session.maxDurationMs}ms budget; detaching`
        );
      }
      this._activeTraceSession = null;
      return null;
    }
    return session.traceId;
  }

  /**
   * Begin a renderer-originated trace session. Returns a dispose handle.
   * Only one session may be active at a time; a warning is logged if a new
   * session overlaps an unexpired one, and the new session wins.
   *
   * Trace ids must match the same narrow character class as request ids so
   * the main-side validator can safely accept them without injection risk.
   *
   * @param {string} [traceId]
   * @param {{ maxDurationMs?: number }} [options]
   * @returns {{ traceId: string, end: () => void }}
   */
  beginTraceSession(traceId, options = {}) {
    const normalizedId =
      typeof traceId === 'string' && /^[\w.:-]+$/.test(traceId) && traceId.length <= 128
        ? traceId
        : this._generateTraceId();
    const maxDurationMs =
      Number.isFinite(options.maxDurationMs) && options.maxDurationMs > 0
        ? Math.min(options.maxDurationMs, 10 * 60 * 1000)
        : 60 * 1000;
    if (this._activeTraceSession && this._activeTraceSession.traceId !== normalizedId) {
      log.debug(
        `[Trace] Replacing active trace ${this._activeTraceSession.traceId} with ${normalizedId}`
      );
    }
    /** @type {{ traceId: string, startedAt: number, expiresAt: number, maxDurationMs: number, warnedExpired: boolean }} */
    const session = {
      traceId: normalizedId,
      startedAt: Date.now(),
      expiresAt: Date.now() + maxDurationMs,
      maxDurationMs,
      warnedExpired: false
    };
    this._activeTraceSession = session;
    return {
      traceId: normalizedId,
      end: () => {
        if (this._activeTraceSession === session) {
          this._activeTraceSession = null;
        }
      }
    };
  }

  _generateTraceId() {
    const rand =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
        : Math.random().toString(36).slice(2, 14);
    return `tr-${Date.now().toString(36)}-${rand}`;
  }

  /**
   * Best-effort cancel signal to the main process. We use `ipcRenderer.send`
   * (one-way) rather than invoke so that we never await our own cleanup.
   */
  /**
   * @param {string} channel
   * @param {string} requestId
   * @param {string} [reason]
   */
  _sendAbortSignal(channel, requestId, reason) {
    try {
      ipcRenderer.send(IPC_CHANNELS.SYSTEM.ABORT_INVOKE, {
        requestId,
        channel,
        reason: typeof reason === 'string' ? reason.slice(0, 64) : 'timeout'
      });
    } catch (err) {
      log.debug(
        `[SecureIPC] Failed to send abort for ${channel} (${requestId}): ${err?.message || err}`
      );
    }
  }

  /**
   * Renderer-initiated cooperative cancel for all in-flight invokes on a
   * channel. Sends the same ABORT_INVOKE signal the timeout path uses, so the
   * main-side handler's `event.abortSignal` fires and the operation (e.g. a
   * batch organize) can stop instead of running to completion after the user
   * clicked Cancel. The invoke promise itself still settles normally — the
   * handler decides how to resolve once aborted.
   *
   * @param {string} channel - Invoke channel to abort (e.g. 'files:perform-operation')
   * @param {string} [reason='renderer-cancel']
   * @returns {number} Number of in-flight invokes signalled
   */
  abortInflightChannel(channel, reason) {
    if (typeof channel !== 'string' || channel.length === 0) return 0;
    let signalled = 0;
    for (const [requestId, inflightChannel] of this._inflightInvokes) {
      if (inflightChannel === channel) {
        this._sendAbortSignal(channel, requestId, reason || 'renderer-cancel');
        signalled += 1;
      }
    }
    return signalled;
  }

  /**
   * @param {string} channel
   * @param {any[]} sanitizedArgs
   * @param {number} timeout
   */
  async _invokeWithTimeout(channel, sanitizedArgs, timeout) {
    let completed = false;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timeoutId;
    const requestId = this._generateIpcRequestId();
    // Append the abort envelope AFTER sanitization so the request id is never
    // rewritten by the HTML/path sanitizer. The main wrapper strips it before
    // calling the handler, so no handler needs to know about it.
    const argsWithMeta = [...sanitizedArgs, this._buildIpcMetaEnvelope(requestId)];
    this._inflightInvokes.set(requestId, channel);

    try {
      const invokePromise = ipcRenderer.invoke(channel, ...argsWithMeta);
      // Absorb rejection if timeout wins the race; log for observability
      invokePromise.catch((/** @type {any} */ err) => {
        if (!completed) {
          log.debug(
            `[SecureIPC] Swallowed post-timeout rejection for ${channel}: ${err?.message || err}`
          );
        }
      });
      /** @type {Promise<never>} */
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          if (!completed) {
            // Fire-and-forget cancel so the main handler can abort cooperatively
            // instead of continuing to consume CPU / DB / model resources.
            this._sendAbortSignal(channel, requestId, 'ipc-timeout');
            reject(new Error(`IPC timeout after ${timeout}ms for channel: ${channel}`));
          }
        }, timeout);
      });
      const result = await Promise.race([invokePromise, timeoutPromise]);
      completed = true;
      clearTimeout(timeoutId);
      return this.validator.validateResult(result, channel);
    } catch (error) {
      completed = true;
      clearTimeout(timeoutId);
      throw error;
    } finally {
      this._inflightInvokes.delete(requestId);
    }
  }

  /**
   * @param {string} channel
   * @param {any[]} sanitizedArgs
   * @param {number} timeout
   */
  async _invokeWithRetries(channel, sanitizedArgs, timeout) {
    const MAX_RETRIES = 3;
    /** @type {any} */
    let lastError;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this._invokeWithTimeout(channel, sanitizedArgs, timeout);
      } catch (error) {
        lastError = error;
        if (error.message && error.message.includes('No handler registered')) {
          log.warn(`Handler not ready for ${channel}, attempt ${attempt + 1}/${MAX_RETRIES}`);
          const RETRY_BASE_DELAY_MS = 100;
          await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** attempt));
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error(`IPC invoke failed after ${MAX_RETRIES} attempts for ${channel}`);
  }

  /**
   * Periodic listener audit to detect potential leaks.
   */
  auditStaleListeners() {
    const now = Date.now();

    const totalListeners = this.activeListeners.size;
    /** @type {Map<string, number>} */
    const channelCounts = new Map();
    let oldestAgeMs = 0;

    for (const listener of this.activeListeners.values()) {
      const channel = listener?.channel;
      if (typeof channel === 'string' && channel) {
        channelCounts.set(channel, (channelCounts.get(channel) || 0) + 1);
      }
      const createdAt =
        typeof listener?.createdAt === 'number' && Number.isFinite(listener.createdAt)
          ? listener.createdAt
          : null;
      if (createdAt) {
        oldestAgeMs = Math.max(oldestAgeMs, now - createdAt);
      }
    }

    let maxPerChannel = 0;
    for (const count of channelCounts.values()) {
      maxPerChannel = Math.max(maxPerChannel, count);
    }

    const growthSinceLastAudit =
      typeof this._lastListenerAuditCount === 'number'
        ? totalListeners - this._lastListenerAuditCount
        : 0;

    // Heuristics: warn only when counts/growth look suspicious.
    const MAX_TOTAL_LISTENERS_WARN = 50;
    const MAX_PER_CHANNEL_WARN = 10;
    const MAX_GROWTH_PER_AUDIT_WARN = 20;

    const topChannels = Array.from(channelCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([channel, count]) => ({ channel, count }));

    if (
      totalListeners >= MAX_TOTAL_LISTENERS_WARN ||
      maxPerChannel >= MAX_PER_CHANNEL_WARN ||
      growthSinceLastAudit >= MAX_GROWTH_PER_AUDIT_WARN
    ) {
      log.warn('[SecureIPC] Listener audit indicates potential leak', {
        totalListeners,
        maxPerChannel,
        growthSinceLastAudit,
        oldestAgeMinutes: Math.round(oldestAgeMs / 60000),
        topChannels
      });
    } else if (process.env.NODE_ENV === 'development') {
      log.debug('[SecureIPC] Listener audit', {
        totalListeners,
        maxPerChannel,
        growthSinceLastAudit,
        oldestAgeMinutes: Math.round(oldestAgeMs / 60000),
        topChannels
      });
    }

    this._lastListenerAuditAt = now;
    this._lastListenerAuditCount = totalListeners;

    return {
      totalListeners,
      maxPerChannel,
      growthSinceLastAudit,
      oldestAgeMs
    };
  }

  /**
   * @param {string} channel
   * @param {() => Promise<any>} task
   * @returns {Promise<any>}
   */
  enqueueThrottled(channel, task) {
    const STALE_QUEUE_TIMEOUT_MS = 30000;

    // Evict stale entries that never resolved (prevents memory leak)
    const queueTs = this._channelQueueTimestamps.get(channel);
    if (queueTs && Date.now() - queueTs > STALE_QUEUE_TIMEOUT_MS) {
      log.debug(`[SecureIPC] Evicting stale queue entry for ${channel}`);
      this.channelQueues.delete(channel);
      this._channelQueueTimestamps.delete(channel);
    }

    const delayMs = THROTTLED_CHANNELS.get(channel) || 0;
    /** @type {Promise<any>} */
    const prev = /** @type {any} */ (this.channelQueues.get(channel)) || Promise.resolve();
    /** @type {(err: any) => undefined} */
    const absorb = (err) => {
      log.debug('[SecureIPC] Throttled queue absorbed previous rejection', {
        channel,
        error: err?.message
      });
      return undefined;
    };
    /** @type {() => Promise<any>} */
    const runTask = async () => {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return task();
    };
    /** @type {Promise<any>} */
    const next = prev
      .catch(absorb)
      .then(runTask)
      .finally(() => {
        if (this.channelQueues.get(channel) === /** @type {any} */ (next)) {
          this.channelQueues.delete(channel);
          this._channelQueueTimestamps.delete(channel);
        }
      });
    this.channelQueues.set(channel, /** @type {any} */ (next));
    this._channelQueueTimestamps.set(channel, Date.now());
    return next;
  }

  /**
   * Secure invoke with validation and error handling
   */
  /**
   * @param {string} channel
   * @param {...any} args
   */
  async safeInvoke(channel, ...args) {
    if (THROTTLED_CHANNELS.has(channel)) {
      return this.enqueueThrottled(channel, () => this.safeInvokeCore(channel, ...args));
    }
    return this.safeInvokeCore(channel, ...args);
  }

  /**
   * @param {string} channel
   * @param {...any} args
   */
  async safeInvokeCore(channel, ...args) {
    // Tracks whether THIS invocation actually acquired the concurrency lock.
    // The finally block must only release a lock it owns — otherwise a caller
    // that was throttled (and threw CONCURRENCY_LIMIT below) would delete the
    // lock still held by the in-flight owner, defeating serialization.
    let acquiredLock = false;
    try {
      // Channel validation
      if (!ALL_SEND_CHANNELS.has(channel)) {
        log.warn(`Blocked invoke to unauthorized channel: ${channel}`);
        throw new Error(`Unauthorized IPC channel: ${channel}`);
      }

      // Rate limiting
      this.checkRateLimit(channel);

      // Fix 1C: Concurrency guard for expensive operations
      const lockKey = resolveConcurrencyLockKey(channel);
      const needsMutationLock =
        CONCURRENCY_LIMITED_CHANNELS.has(channel) ||
        DOWNLOADS_TRIAGE_MUTATION_CHANNELS.has(channel);
      if (needsMutationLock) {
        if (this._concurrencyLocks.get(lockKey)) {
          // Tagged with a code so the catch block below (and renderer
          // pattern-matchers like SettingsPanel.jsx's auto-health-check
          // handler) can recognize a throttle rejection without
          // string-matching the message.
          const err = /** @type {Error & { code?: string }} */ (
            new Error(`Operation already in progress: ${lockKey}`)
          );
          err.code = 'CONCURRENCY_LIMIT';
          throw err;
        }
        this._concurrencyLocks.set(lockKey, /** @type {any} */ (true));
        acquiredLock = true;
      }

      const embeddingStatsForceRefresh =
        channel === IPC_CHANNELS.EMBEDDINGS.GET_STATS &&
        args.length > 0 &&
        typeof args[0] === 'object' &&
        args[0] !== null &&
        args[0].forceRefresh === true;

      // Coalesce frequent stats polling across renderer surfaces.
      if (channel === IPC_CHANNELS.EMBEDDINGS.GET_STATS && !embeddingStatsForceRefresh) {
        const now = Date.now();
        if (
          this._embeddingsStatsCache.value &&
          typeof this._embeddingsStatsCache.expiresAt === 'number' &&
          this._embeddingsStatsCache.expiresAt > now
        ) {
          return this._embeddingsStatsCache.value;
        }
        if (this._embeddingsStatsCache.pending) {
          return this._embeddingsStatsCache.pending;
        }
      }

      // Fix 2C: Payload size guard — recursive walk before O(n) sanitization.
      // Single shared `seen` set across all top-level args so a payload that
      // references the same large structure twice still spends its budget once.
      const seen = new WeakSet();
      for (const arg of args) {
        enforcePayloadSizeLimits(arg, 0, seen);
      }

      // Argument sanitization
      const sanitizedArgs = this.sanitizer.sanitizeArguments(args);

      // Reduce log noise: use debug for all channels in production, info only in dev.
      // High-frequency polled channels are downgraded to debug-only-in-dev so they
      // don't dominate the log (in observed runs `system:get-degraded-state` polled
      // every 30s for 45+ idle minutes, drowning out useful entries).
      const HIGH_FREQUENCY_POLLED_CHANNELS = new Set([
        IPC_CHANNELS.EMBEDDINGS.GET_STATS,
        IPC_CHANNELS.SYSTEM.GET_DEGRADED_STATE
      ]);
      if (HIGH_FREQUENCY_POLLED_CHANNELS.has(channel)) {
        if (process.env.NODE_ENV === 'development') {
          log.debug(`Secure invoke: ${channel}`);
        }
      } else if (process.env.NODE_ENV === 'development') {
        log.info(`Secure invoke: ${channel}${sanitizedArgs.length > 0 ? ' [with args]' : ''}`);
      } else {
        log.debug(`Secure invoke: ${channel}${sanitizedArgs.length > 0 ? ' [with args]' : ''}`);
      }

      const timeout = this._getInvokeTimeout(channel);
      if (channel === IPC_CHANNELS.EMBEDDINGS.GET_STATS) {
        if (embeddingStatsForceRefresh) {
          this._embeddingsStatsCache.value = null;
          this._embeddingsStatsCache.expiresAt = 0;
        }
        this._embeddingsStatsCache.pending = this._invokeWithRetries(
          channel,
          sanitizedArgs,
          timeout
        )
          .then((/** @type {any} */ result) => {
            this._embeddingsStatsCache.value = result;
            this._embeddingsStatsCache.expiresAt = Date.now() + EMBEDDINGS_STATS_CACHE_MS;
            return result;
          })
          // Fix 3A: Clear stale cache on error so next request doesn't serve outdated data
          .catch((/** @type {any} */ err) => {
            this._embeddingsStatsCache.value = null;
            this._embeddingsStatsCache.expiresAt = 0;
            throw err;
          })
          .finally(() => {
            this._embeddingsStatsCache.pending = null;
          });
        return await this._embeddingsStatsCache.pending;
      }
      return await this._invokeWithRetries(channel, sanitizedArgs, timeout);
    } catch (/** @type {any} */ error) {
      // CONCURRENCY_LIMIT rejections come from the throttle above and are an
      // expected steady-state outcome whenever two renderer surfaces poll the
      // same channel within the lock window (e.g. Settings panel + auto AI
      // health check, observed at 110 ms apart in production logs). Logging
      // them at error level made the routine throttle indistinguishable from a
      // real IPC failure in postmortems. info preserves visibility for spam
      // without polluting the error tier.
      if (error.code === 'CONCURRENCY_LIMIT' || error.code === 'RATE_LIMIT') {
        log.info(`IPC throttled (${channel}): ${error.message}`);
      } else {
        log.error(`IPC invoke error for ${channel}: ${error.message}`);
      }
      // Fix 2E: Preserve structured error codes so renderer can distinguish error types
      const wrappedError = /** @type {Error & { code?: string, details?: any }} */ (
        new Error(`IPC Error: ${error.message}`, { cause: error })
      );
      if (error.code) wrappedError.code = error.code;
      if (error.details) wrappedError.details = error.details;
      throw wrappedError;
    } finally {
      // Only release the lock if this invocation acquired it. A throttled
      // caller (CONCURRENCY_LIMIT) never set the lock, so it must not delete
      // the entry the in-flight owner still holds.
      if (acquiredLock) {
        const lockKey = resolveConcurrencyLockKey(channel);
        this._concurrencyLocks.delete(lockKey);
      }
    }
  }

  /**
   * Secure event listener with cleanup tracking
   */
  /**
   * @param {string} channel
   * @param {(...args: any[]) => void} callback
   * @returns {() => void} unsubscribe function
   */
  safeOn(channel, callback) {
    if (!ALLOWED_RECEIVE_CHANNELS.includes(channel)) {
      log.warn(`Blocked listener on unauthorized channel: ${channel}`);
      return () => {};
    }

    const createdAt = Date.now();
    const listenerKey = `${channel}_${++this._listenerCounter}_${createdAt}`;

    /** @param {any} event @param {...any} args */
    const wrappedCallback = (event, ...args) => {
      // Track listener activity for audit/diagnostics (best-effort)
      try {
        const meta = this.activeListeners.get(listenerKey);
        if (meta) {
          meta.lastCalledAt = Date.now();
          meta.callCount = (meta.callCount || 0) + 1;
        }
      } catch {
        // Non-fatal
      }

      try {
        // Validate event source
        if (!this.validator.validateEventSource(event)) {
          log.warn(`Rejected event from invalid source on channel: ${channel}`);
          return;
        }

        // Sanitize incoming data
        const sanitizedArgs = this.sanitizer.sanitizeTrustedEventArgs(args);

        // Special handling for different event types
        if (channel === 'system-metrics' && sanitizedArgs.length === 1) {
          const data = sanitizedArgs[0];
          if (this.validator.isValidSystemMetrics(data)) {
            callback(data);
          } else {
            log.warn('Invalid system-metrics data rejected');
          }
        } else {
          callback(...sanitizedArgs);
        }
      } catch (error) {
        log.error(`Error in ${channel} event handler:`, error);
      }
    };

    this.activeListeners.set(listenerKey, {
      channel,
      callback: wrappedCallback,
      createdAt,
      lastCalledAt: null,
      callCount: 0
    });

    ipcRenderer.on(channel, wrappedCallback);

    // Return cleanup function
    return () => {
      ipcRenderer.removeListener(channel, wrappedCallback);
      this.activeListeners.delete(listenerKey);
    };
  }

  /**
   * Cleanup all active listeners
   */
  cleanup() {
    for (const { channel, callback } of this.activeListeners.values()) {
      ipcRenderer.removeListener(channel, callback);
    }
    this.activeListeners.clear();
    log.info('All IPC listeners cleaned up');
  }
}

// Initialize secure IPC manager
const secureIPC = new SecureIPCManager();

// Log derived invoke timeouts once at startup
try {
  log.info('[SecureIPC] Invoke timeouts', {
    defaultInvokeTimeoutMs: PERF_LIMITS.IPC_INVOKE_TIMEOUT || 30000,
    directoryScanTimeoutMs: TIMEOUTS.DIRECTORY_SCAN || 60000,
    scanStructureInvokeTimeoutMs: secureIPC._getInvokeTimeout(
      IPC_CHANNELS.SMART_FOLDERS.SCAN_STRUCTURE
    ),
    chatQueryStreamTimeoutMs: secureIPC._getInvokeTimeout(IPC_CHANNELS.CHAT.QUERY_STREAM),
    downloadsTriageStartTimeoutMs: secureIPC._getInvokeTimeout(IPC_CHANNELS.DOWNLOADS.TRIAGE_START),
    downloadsTriageDeepScanTimeoutMs: secureIPC._getInvokeTimeout(
      IPC_CHANNELS.DOWNLOADS.TRIAGE_DEEP_SCAN
    )
  });
} catch {
  // Non-fatal (logging only)
}

// Periodic listener audit
const LISTENER_AUDIT_INTERVAL_MS = 10 * 60 * 1000;
const listenerAuditIntervalId = setInterval(() => {
  try {
    secureIPC.auditStaleListeners();
  } catch (e) {
    log.debug('[Preload] Listener audit error:', e?.message);
  }
}, LISTENER_AUDIT_INTERVAL_MS);

/**
 * Throw on structured failure responses.
 */
/**
 * @param {any} result
 * @param {{ allowCanceled?: boolean, defaultMessage?: string, expectObject?: boolean }} [opts]
 */
function throwIfFailed(result, opts = {}) {
  const { allowCanceled = true, defaultMessage = 'Operation failed', expectObject = false } = opts;
  if (!result || typeof result !== 'object') {
    if (expectObject) {
      throw new Error(defaultMessage);
    }
    return result;
  }
  if (!Object.prototype.hasOwnProperty.call(result, 'success')) return result;
  if (result.success !== false) return result;
  if (allowCanceled && (result.canceled === true || result.cancelled === true)) return result;
  const msg =
    (typeof result.error === 'string' && result.error) ||
    (typeof result.error === 'object' &&
      result.error !== null &&
      typeof result.error.message === 'string' &&
      result.error.message) ||
    (typeof result.message === 'string' && result.message) ||
    defaultMessage;
  const err = /** @type {Error & { details?: any, code?: string }} */ (new Error(msg));
  err.details = result;
  // Copy a code onto err so renderer code can branch on `err.code` directly.
  // Handlers across the codebase emit codes in three different shapes:
  //   { error: { code: '...' } }    — createErrorResponse standard
  //   { code: '...' }               — flat shape (mcp, costTracker)
  //   { errorCode: '...' }          — flat shape (aiProvider _fail)
  // Without this, e.g. AIProviderConfigModal's `if (err.code === 'CONSENT_REQUIRED')`
  // retry path was dead: the thrown Error carried only `details.code`, never
  // `code`, so consent re-prompts never opened.
  const code =
    (result.error && typeof result.error === 'object' && result.error.code) ||
    result.code ||
    result.errorCode ||
    null;
  if (code) err.code = code;
  throw err;
}

/**
 * Effective Windows path-length limit, forwarded from main via
 * `--stratosort-max-path-length=<n>` in webPreferences.additionalArguments
 * (main runs the LongPathsEnabled registry probe; the sandboxed preload
 * cannot). Falls back to the legacy 260 MAX_PATH when the argument is
 * missing or malformed so we fail closed.
 */
/** @type {number|null} */
let _cachedMaxPathLength = null;
function _effectiveMaxPathLength() {
  if (_cachedMaxPathLength !== null) return _cachedMaxPathLength;
  let limit = 260;
  try {
    const argv = typeof process !== 'undefined' && Array.isArray(process.argv) ? process.argv : [];
    for (const arg of argv) {
      if (typeof arg === 'string' && arg.startsWith('--stratosort-max-path-length=')) {
        const parsed = parseInt(arg.split('=')[1], 10);
        if (Number.isInteger(parsed) && parsed >= 260 && parsed <= 32767) {
          limit = parsed;
        }
        break;
      }
    }
  } catch {
    // Keep the conservative default
  }
  _cachedMaxPathLength = limit;
  return limit;
}

/**
 * Fix 1A: Shared path validation for analysis endpoints.
 * Extracted from files.analyze() so that analysis.document(), analysis.image(),
 * and analysis.extractText() apply the same security checks.
 */
/** @param {any} filePath */
function _validateAnalysisFilePath(filePath) {
  if (Array.isArray(filePath) && filePath.length > 0) filePath = filePath[0];
  if (filePath && typeof filePath === 'object' && filePath.path) filePath = filePath.path;
  if (typeof filePath === 'string') filePath = filePath.trim().replace(/^['"](.*)['"]$/, '$1');

  if (typeof filePath === 'string' && filePath.toLowerCase().startsWith('file://')) {
    try {
      filePath = sanitizePath(filePath);
    } catch {
      // Ignore invalid file:// input; subsequent validation will fail safely
    }
  }

  if (!filePath || typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Invalid file path');
  }

  // Reject any URI scheme (http://, https://, javascript:, data:, vbscript:,
  // ms-appx:, file: post-sanitize, etc.). The scheme tail is `[a-z0-9+.-]+`
  // (one OR MORE — RFC 3986 requires schemes ≥2 chars; a one-char scheme
  // would falsely match Windows paths like `C://users/foo` which are
  // legitimate-but-malformed user paths, not URIs).
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(filePath)) {
    throw new Error('Invalid file path: URI schemes not allowed');
  }

  // Reject NUL bytes — classic POSIX path-truncation bypass where
  // "/safe/path\0/etc/passwd" is opened as /safe/path on some kernels.
  // Defense-in-depth: main-side sanitizePath also rejects these, but the
  // preload gate that announces itself as the validator should be the
  // first to do so.
  if (filePath.indexOf('\0') !== -1) {
    throw new Error('Invalid file path: null byte not allowed');
  }

  // Cap length by platform. POSIX PATH_MAX is 4096 on Linux. On Windows the
  // effective ceiling depends on the LongPathsEnabled registry opt-in, which
  // the sandboxed preload cannot probe itself: main probes it once and
  // forwards the effective limit via additionalArguments (createWindow.js);
  // a missing argument falls back to the legacy 260 cap (fail closed).
  // Surfacing the limit here gives the user remediation guidance instead of
  // a cryptic ENAMETOOLONG deep in the analysis stack. Detect Windows via
  // navigator.platform (process.platform may be undefined in bundled
  // preload per the Win-detection note in ipcSanitizer.js:158).
  const isWin =
    (typeof navigator !== 'undefined' && /^Win/i.test(navigator.platform)) ||
    (typeof process !== 'undefined' && process.platform === 'win32');
  const maxPathLen = isWin ? _effectiveMaxPathLength() : 4096;
  if (filePath.length > maxPathLen) {
    throw new Error(
      isWin
        ? `Invalid file path: ${filePath.length} chars exceeds the effective Windows path limit ` +
            `(${maxPathLen}). Enable LongPathsEnabled in the registry (per Microsoft Docs > ` +
            'Naming Files, Paths, and Namespaces) or move the file to a shorter path.'
        : 'Invalid file path: path too long'
    );
  }

  // DOS device / NT namespace syntax (`\\?\`, `\\.\`, `\\??\`) is rejected
  // outright: it bypasses Win32 path normalization downstream and enables
  // NULL-device tricks and reserved-name access that the rest of the
  // validation stack does not reason about.
  if (/^[\\/]{2}[?.]/.test(filePath)) {
    throw new Error(
      'Invalid file path: Windows device-namespace syntax (\\\\?\\, \\\\.\\) is not allowed'
    );
  }

  const isUNC = filePath.startsWith('\\\\') || filePath.startsWith('//');
  if (isUNC) {
    // Plain UNC shares are allowed, matching main-side policy: smart-folder
    // registration explicitly accepts UNC watch roots (src/main/ipc/
    // smartFolders.js, folderHandlers.js), and analysis/organize validation
    // sets `disallowUNC: false` so files on those shares can be processed.
    // Blocking them here made the preload the one layer where the feature
    // silently broke. Require a well-formed `\\server\share` head and reject
    // colons anywhere in the body (no drive designator exists in a UNC path,
    // so any colon is NTFS alternate-data-stream syntax).
    const uncBody = filePath.slice(2);
    if (!/^[^\\/:]+[\\/][^\\/:]+/.test(uncBody) || uncBody.includes(':')) {
      throw new Error(
        'Invalid file path: malformed UNC path (expected \\\\server\\share\\...; ' +
          'alternate data streams are not allowed)'
      );
    }
  }

  // Drive-letter paths: any colon beyond the drive designator is NTFS
  // alternate-data-stream syntax (C:\dir\file.txt:hidden). The UNC branch
  // already rejects ADS; without this, a dropped-file path that bypassed
  // sanitizePath (the getPathForDroppedFile fallback) would carry the
  // stream all the way to main before being caught — keep the preload a
  // complete first gate. POSIX paths are exempt (colons are legal there).
  if (/^[a-zA-Z]:[\\/]/.test(filePath) && filePath.indexOf(':', 2) !== -1) {
    throw new Error('Invalid file path: alternate data streams are not allowed');
  }

  // Reject `..` traversal segments. Main-side sanitizePath normalizes first and
  // rejects any post-normalization `..`, but this preload gate (which announces
  // itself as the "complete first gate" above) does not normalize, so it must
  // reject the traversal indicator outright rather than forward it. Canonical
  // paths from the file dialog, drag/drop (getPathForDroppedFile → sanitizePath),
  // and smart-folder scans never contain `..`, so this rejects only malformed or
  // hostile input.
  if (filePath.split(/[\\/]+/).some((segment) => segment === '..')) {
    throw new Error('Invalid file path: path traversal (..) not allowed');
  }

  const isAbsolute = isUNC || /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('/');
  if (!isAbsolute) throw new Error('Invalid file path: must be an absolute path');

  return filePath;
}

// Cleanup on window unload
window.addEventListener('beforeunload', () => {
  clearInterval(listenerAuditIntervalId);
  secureIPC.cleanup();
});

// Expose secure, typed API through context bridge
contextBridge.exposeInMainWorld('electronAPI', {
  // File Operations
  files: {
    select: () => secureIPC.safeInvoke(IPC_CHANNELS.FILES.SELECT),
    // `purpose` says what the folder is for; only a 'destination' pick is
    // remembered by the destination policy. Anything else is dropped here.
    selectDirectory: (/** @type {any} */ options) =>
      secureIPC.safeInvoke(
        IPC_CHANNELS.FILES.SELECT_DIRECTORY,
        options?.purpose === 'destination' || options?.purpose === 'source'
          ? { purpose: options.purpose }
          : undefined
      ),
    getDocumentsPath: () => secureIPC.safeInvoke(IPC_CHANNELS.FILES.GET_DOCUMENTS_PATH),
    createFolder: (/** @type {any} */ fullPath) =>
      secureIPC.safeInvoke(IPC_CHANNELS.FILES.CREATE_FOLDER_DIRECT, fullPath),
    normalizePath: (/** @type {any} */ p) => {
      const original = p;
      try {
        if (typeof p !== 'string') return p;
        let uncPrefix = '';
        if (p.startsWith('\\\\')) {
          uncPrefix = '\\\\';
          p = p.slice(2);
        }
        let normalized = uncPrefix + p.replace(/([\\/])+/g, '$1');
        if (normalized.length > 3 && (normalized.endsWith('/') || normalized.endsWith('\\'))) {
          if (!(normalized.match(/^[A-Za-z]:[\\/]$/) || normalized === '/')) {
            normalized = normalized.slice(0, -1);
          }
        }
        return normalized;
      } catch {
        return original;
      }
    },
    getStats: async (/** @type {any} */ filePath) => {
      const result = await secureIPC.safeInvoke(IPC_CHANNELS.FILES.GET_FILE_STATS, filePath);
      if (!result || typeof result !== 'object') {
        return result;
      }
      const success = result.success !== false;
      const stats = result.stats && typeof result.stats === 'object' ? result.stats : {};
      return {
        success,
        exists: success,
        error: result.error,
        ...stats
      };
    },
    getPathForDroppedFile: (/** @type {any} */ file) => {
      try {
        if (!file || typeof webUtils?.getPathForFile !== 'function') return '';
        const rawPath = webUtils.getPathForFile(file) || '';
        if (!rawPath || typeof rawPath !== 'string') return '';
        try {
          return sanitizePath(rawPath);
        } catch (err) {
          // sanitizePath rejects for several distinct reasons. Only path
          // length/depth limits represent a legitimate-but-rejected OS path (a
          // real, deeply nested file the filesystem still supports), so for those
          // fall back to a cleaned raw path to keep Discover drag/drop working
          // (main re-validates every channel that consumes this). Any OTHER
          // rejection — traversal, ADS, reserved name, null byte — a canonical
          // OS-provided drop path should never produce, so FAIL CLOSED instead of
          // re-admitting a suspicious path (was previously fail-open for all).
          const isLimitRejection = err?.code === 'PATH_TOO_LONG' || err?.code === 'PATH_TOO_DEEP';
          if (!isLimitRejection) {
            log.warn('[Preload] sanitizePath rejected dropped file path; refusing raw fallback', {
              message: err?.message,
              pathPrefix: rawPath.slice(0, 96)
            });
            return '';
          }
          // Defense-in-depth: even on the length/depth fall-through, re-reject the
          // traversal markers a canonical OS drop path never contains.
          const cleaned = rawPath.replace(/\0/g, '').trim();
          if (cleaned.split(/[\\/]+/).some((segment) => segment === '..')) {
            log.warn('[Preload] dropped file path fallback contained traversal; refusing', {
              pathPrefix: rawPath.slice(0, 96)
            });
            return '';
          }
          log.warn('[Preload] sanitizePath rejected dropped file path (length/depth); using raw', {
            message: err?.message,
            pathPrefix: rawPath.slice(0, 96)
          });
          return cleaned;
        }
      } catch (err) {
        log.debug('[Preload] getPathForFile failed for drop', { message: err?.message });
        return '';
      }
    },
    getDirectoryContents: (/** @type {any} */ dirPath) =>
      secureIPC.safeInvoke(IPC_CHANNELS.FILES.GET_FILES_IN_DIRECTORY, dirPath),
    organize: (/** @type {any} */ operations) =>
      secureIPC.safeInvoke(IPC_CHANNELS.FILES.PERFORM_OPERATION, {
        type: 'batch_organize',
        operations
      }),
    performOperation: (/** @type {any} */ operations) =>
      secureIPC.safeInvoke(IPC_CHANNELS.FILES.PERFORM_OPERATION, operations),
    // `options.permanent` is sent only after the user confirmed a permanent
    // delete in a second dialog (the OS trash was unavailable).
    delete: (
      /** @type {any} */ filePath,
      /** @type {{ permanent?: boolean } | undefined} */ options
    ) =>
      options && typeof options === 'object'
        ? secureIPC.safeInvoke(IPC_CHANNELS.FILES.DELETE_FILE, filePath, options)
        : secureIPC.safeInvoke(IPC_CHANNELS.FILES.DELETE_FILE, filePath),
    cleanupAnalysis: (/** @type {any} */ filePath) =>
      secureIPC.safeInvoke(IPC_CHANNELS.FILES.CLEANUP_ANALYSIS, filePath),
    open: (/** @type {any} */ filePath) =>
      secureIPC.safeInvoke(IPC_CHANNELS.FILES.OPEN_FILE, filePath),
    reveal: (/** @type {any} */ filePath) =>
      secureIPC.safeInvoke(IPC_CHANNELS.FILES.REVEAL_FILE, filePath),
    copy: (/** @type {any} */ sourcePath, /** @type {any} */ destinationPath) =>
      secureIPC.safeInvoke(IPC_CHANNELS.FILES.COPY_FILE, sourcePath, destinationPath),
    openFolder: (/** @type {any} */ folderPath) =>
      secureIPC.safeInvoke(IPC_CHANNELS.FILES.OPEN_FOLDER, folderPath),
    deleteFolder: (/** @type {any} */ folderPath) =>
      secureIPC.safeInvoke(IPC_CHANNELS.FILES.DELETE_FOLDER, folderPath),
    analyze: (/** @type {any} */ filePath, /** @type {any} */ options) => {
      try {
        // Fix 1A: Use shared path validation
        filePath = _validateAnalysisFilePath(filePath);

        const lastDot = filePath.lastIndexOf('.');
        const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
        let ext = '';
        if (lastDot > lastSlash && lastDot > 0) ext = filePath.slice(lastDot + 1).toLowerCase();

        const payload =
          options?.namingSettings && typeof options.namingSettings === 'object'
            ? { filePath, namingSettings: options.namingSettings }
            : filePath;

        // Fix 1B: Use IMAGE_EXT_SET derived from constants.js instead of hardcoded list
        if (IMAGE_EXT_SET.has(ext)) {
          return secureIPC.safeInvoke(IPC_CHANNELS.ANALYSIS.ANALYZE_IMAGE, payload);
        }
        if (MEDIA_EXT_SET.has(ext)) {
          return secureIPC.safeInvoke(IPC_CHANNELS.ANALYSIS.ANALYZE_MEDIA, payload);
        }
        return secureIPC.safeInvoke(IPC_CHANNELS.ANALYSIS.ANALYZE_DOCUMENT, payload);
      } catch (error) {
        log.error('File analysis security check failed:', error);
        return Promise.reject(error);
      }
    },
    addTags: (/** @type {any} */ fileIds, /** @type {any} */ tags) =>
      secureIPC.safeInvoke(IPC_CHANNELS.FILES.ADD_TAGS, fileIds, tags)
  },

  // Smart Folders
  smartFolders: {
    get: () => secureIPC.safeInvoke(IPC_CHANNELS.SMART_FOLDERS.GET),
    save: (/** @type {any} */ folders) =>
      secureIPC.safeInvoke(IPC_CHANNELS.SMART_FOLDERS.SAVE, folders),
    updateCustom: (/** @type {any} */ folders) =>
      secureIPC.safeInvoke(IPC_CHANNELS.SMART_FOLDERS.UPDATE_CUSTOM, folders),
    getCustom: () => secureIPC.safeInvoke(IPC_CHANNELS.SMART_FOLDERS.GET_CUSTOM),
    scanStructure: (/** @type {any} */ rootPath) =>
      secureIPC.safeInvoke(IPC_CHANNELS.SMART_FOLDERS.SCAN_STRUCTURE, rootPath),
    add: (/** @type {any} */ folder) =>
      secureIPC.safeInvoke(IPC_CHANNELS.SMART_FOLDERS.ADD, folder),
    edit: (/** @type {any} */ folderId, /** @type {any} */ updatedFolder) =>
      secureIPC.safeInvoke(IPC_CHANNELS.SMART_FOLDERS.EDIT, folderId, updatedFolder),
    delete: (/** @type {any} */ folderId) =>
      secureIPC.safeInvoke(IPC_CHANNELS.SMART_FOLDERS.DELETE, folderId),
    match: (/** @type {any} */ text, /** @type {any} */ folders) =>
      secureIPC.safeInvoke(IPC_CHANNELS.SMART_FOLDERS.MATCH, { text, smartFolders: folders }),
    resetToDefaults: () => secureIPC.safeInvoke(IPC_CHANNELS.SMART_FOLDERS.RESET_TO_DEFAULTS),
    generateDescription: (/** @type {any} */ folderName) =>
      secureIPC.safeInvoke(IPC_CHANNELS.SMART_FOLDERS.GENERATE_DESCRIPTION, folderName),
    watcherStart: () => secureIPC.safeInvoke(IPC_CHANNELS.SMART_FOLDERS.WATCHER_START),
    watcherStop: () => secureIPC.safeInvoke(IPC_CHANNELS.SMART_FOLDERS.WATCHER_STOP),
    watcherStatus: () => secureIPC.safeInvoke(IPC_CHANNELS.SMART_FOLDERS.WATCHER_STATUS)
  },

  // Analysis
  // Fix 1A: document(), image(), and extractText() now validate paths like files.analyze()
  analysis: {
    document: (/** @type {any} */ filePath) => {
      try {
        filePath = _validateAnalysisFilePath(filePath);
        return secureIPC.safeInvoke(IPC_CHANNELS.ANALYSIS.ANALYZE_DOCUMENT, filePath);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    image: (/** @type {any} */ filePath) => {
      try {
        filePath = _validateAnalysisFilePath(filePath);
        return secureIPC.safeInvoke(IPC_CHANNELS.ANALYSIS.ANALYZE_IMAGE, filePath);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    media: (/** @type {any} */ filePath) => {
      try {
        filePath = _validateAnalysisFilePath(filePath);
        return secureIPC.safeInvoke(IPC_CHANNELS.ANALYSIS.ANALYZE_MEDIA, filePath);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    batch: (/** @type {any} */ payload) => {
      try {
        // Match the per-file analysis bridges: every path that crosses the
        // preload→main boundary must clear _validateAnalysisFilePath (rejects
        // device-namespace, malformed UNC/ADS, file://, http://, NUL bytes,
        // relative). Without this, analysis.batch became the only escape
        // hatch — a renderer compromise could send
        // `{ filePaths: ['\\\\?\\C:\\...', 'http://x'] }` and the main side's
        // filePathSchema would not catch it.
        if (payload && Array.isArray(payload.filePaths)) {
          payload = {
            ...payload,
            filePaths: payload.filePaths.map((/** @type {any} */ p) => _validateAnalysisFilePath(p))
          };
        }
        return secureIPC.safeInvoke(IPC_CHANNELS.ANALYSIS.ANALYZE_BATCH, payload);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    cancelBatch: (/** @type {any} */ payload) =>
      secureIPC.safeInvoke(IPC_CHANNELS.ANALYSIS.CANCEL_BATCH, payload),
    getReadyQueue: () => secureIPC.safeInvoke(IPC_CHANNELS.ANALYSIS.GET_READY_QUEUE),
    clearReadyQueue: () => secureIPC.safeInvoke(IPC_CHANNELS.ANALYSIS.CLEAR_READY_QUEUE),
    extractText: (/** @type {any} */ filePath) => {
      try {
        filePath = _validateAnalysisFilePath(filePath);
        return secureIPC.safeInvoke(IPC_CHANNELS.ANALYSIS.EXTRACT_IMAGE_TEXT, filePath);
      } catch (error) {
        return Promise.reject(error);
      }
    }
  },

  // Analysis History
  analysisHistory: {
    get: (/** @type {any} */ options) =>
      secureIPC.safeInvoke(IPC_CHANNELS.ANALYSIS_HISTORY.GET, options),
    search: (/** @type {any} */ query, /** @type {any} */ options) =>
      options === undefined
        ? secureIPC.safeInvoke(IPC_CHANNELS.ANALYSIS_HISTORY.SEARCH, query)
        : secureIPC.safeInvoke(IPC_CHANNELS.ANALYSIS_HISTORY.SEARCH, query, options),
    getStatistics: () => secureIPC.safeInvoke(IPC_CHANNELS.ANALYSIS_HISTORY.GET_STATISTICS),
    getFileHistory: (/** @type {any} */ filePath) =>
      secureIPC.safeInvoke(IPC_CHANNELS.ANALYSIS_HISTORY.GET_FILE_HISTORY, filePath),
    setEmbeddingPolicy: (/** @type {any} */ filePath, /** @type {any} */ policy) =>
      secureIPC.safeInvoke(IPC_CHANNELS.ANALYSIS_HISTORY.SET_EMBEDDING_POLICY, {
        filePath,
        policy
      }),
    clear: () => secureIPC.safeInvoke(IPC_CHANNELS.ANALYSIS_HISTORY.CLEAR),
    export: (/** @type {any} */ format) =>
      secureIPC.safeInvoke(IPC_CHANNELS.ANALYSIS_HISTORY.EXPORT, format),
    exportTranscript: (/** @type {any} */ filePath, /** @type {any} */ format) =>
      secureIPC.safeInvoke(IPC_CHANNELS.ANALYSIS_HISTORY.EXPORT_TRANSCRIPT, {
        filePath,
        format
      }),
    getTimeline: (/** @type {any} */ options) =>
      secureIPC.safeInvoke(IPC_CHANNELS.ANALYSIS_HISTORY.GET_TIMELINE, options || {})
  },

  // AI Provider Configuration
  aiProvider: {
    getConfig: () =>
      secureIPC.safeInvoke(IPC_CHANNELS.AI_PROVIDER.GET_CONFIG, {}).then(throwIfFailed),
    setProviderConfig: (/** @type {any} */ provider, /** @type {any} */ config) =>
      secureIPC
        .safeInvoke(IPC_CHANNELS.AI_PROVIDER.SET_PROVIDER_CONFIG, { provider, config })
        .then(throwIfFailed),
    setKey: (
      /** @type {any} */ provider,
      /** @type {any} */ key,
      /** @type {Record<string,any>} */ opts = {}
    ) =>
      secureIPC
        .safeInvoke(IPC_CHANNELS.AI_PROVIDER.SET_KEY, {
          provider,
          key,
          ...(opts.allowPlaintext === true ? { allowPlaintext: true } : {})
        })
        .then(throwIfFailed),
    getKeyStatus: (/** @type {any} */ provider) =>
      secureIPC
        .safeInvoke(IPC_CHANNELS.AI_PROVIDER.GET_KEY_STATUS, { provider })
        .then(throwIfFailed),
    removeKey: (/** @type {any} */ provider) =>
      secureIPC.safeInvoke(IPC_CHANNELS.AI_PROVIDER.REMOVE_KEY, { provider }).then(throwIfFailed),
    testProvider: (/** @type {any} */ provider) =>
      secureIPC
        .safeInvoke(IPC_CHANNELS.AI_PROVIDER.TEST_PROVIDER, { provider })
        .then(throwIfFailed),
    getUsage: () =>
      secureIPC.safeInvoke(IPC_CHANNELS.AI_PROVIDER.GET_USAGE, {}).then(throwIfFailed),
    setRouting: (/** @type {any} */ routing) =>
      secureIPC.safeInvoke(IPC_CHANNELS.AI_PROVIDER.SET_ROUTING, routing).then(throwIfFailed),
    acknowledgeCloud: () =>
      secureIPC.safeInvoke(IPC_CHANNELS.AI_PROVIDER.ACKNOWLEDGE_CLOUD, {}).then(throwIfFailed),
    // Use secureIPC.safeOn for parity with vectorDb.onStatusChanged: gives
    // listener-activity tracking and goes through the ALLOWED_RECEIVE_CHANNELS
    // allowlist (the channel is added to securityConfig). Returns a clean
    // disposer that the activeListeners map cleans up too.
    onStatusChanged: (/** @type {any} */ callback) =>
      secureIPC.safeOn(IPC_CHANNELS.AI_PROVIDER.STATUS_CHANGED, callback)
  },

  // Embeddings / Semantic
  embeddings: {
    rebuildFolders: () => secureIPC.safeInvoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FOLDERS),
    rebuildFiles: () => secureIPC.safeInvoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES),
    fullRebuild: (/** @type {any} */ options) =>
      secureIPC.safeInvoke(IPC_CHANNELS.EMBEDDINGS.FULL_REBUILD, options),
    reanalyzeAll: (/** @type {any} */ options) =>
      secureIPC.safeInvoke(IPC_CHANNELS.EMBEDDINGS.REANALYZE_ALL, options),
    reanalyzeFile: (/** @type {any} */ filePath, options = {}) =>
      secureIPC.safeInvoke(IPC_CHANNELS.EMBEDDINGS.REANALYZE_FILE, { filePath, ...options }),
    getStats: (/** @type {any} */ options = undefined) =>
      options === undefined
        ? secureIPC.safeInvoke(IPC_CHANNELS.EMBEDDINGS.GET_STATS)
        : secureIPC.safeInvoke(IPC_CHANNELS.EMBEDDINGS.GET_STATS, options),
    search: (/** @type {any} */ query, options = {}) =>
      secureIPC.safeInvoke(
        IPC_CHANNELS.EMBEDDINGS.SEARCH,
        buildEmbeddingSearchPayload(query, options)
      ),
    scoreFiles: (/** @type {any} */ query, /** @type {any} */ fileIds) =>
      secureIPC.safeInvoke(IPC_CHANNELS.EMBEDDINGS.SCORE_FILES, { query, fileIds }),
    findSimilar: (/** @type {any} */ fileId, topK = 10) =>
      secureIPC.safeInvoke(IPC_CHANNELS.EMBEDDINGS.FIND_SIMILAR, { fileId, topK }),
    rebuildBM25Index: () => secureIPC.safeInvoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_BM25_INDEX),
    getSearchStatus: () => secureIPC.safeInvoke(IPC_CHANNELS.EMBEDDINGS.GET_SEARCH_STATUS),
    diagnoseSearch: (testQuery = 'test') =>
      secureIPC.safeInvoke(IPC_CHANNELS.EMBEDDINGS.DIAGNOSE_SEARCH, { testQuery }),
    findMultiHop: (/** @type {any} */ seedIds, options = {}) =>
      secureIPC.safeInvoke(IPC_CHANNELS.EMBEDDINGS.FIND_MULTI_HOP, { seedIds, options }),
    computeClusters: (k = 'auto', options = {}) =>
      secureIPC.safeInvoke(IPC_CHANNELS.EMBEDDINGS.COMPUTE_CLUSTERS, {
        k,
        ...(options && typeof options === 'object' ? options : {})
      }),
    getClusters: () => secureIPC.safeInvoke(IPC_CHANNELS.EMBEDDINGS.GET_CLUSTERS),
    getClusterMembers: (/** @type {any} */ clusterId) =>
      secureIPC.safeInvoke(IPC_CHANNELS.EMBEDDINGS.GET_CLUSTER_MEMBERS, { clusterId }),
    getSimilarityEdges: (
      /** @type {any} */ fileIds,
      /** @type {Record<string,any>} */ options = {}
    ) =>
      secureIPC.safeInvoke(IPC_CHANNELS.EMBEDDINGS.GET_SIMILARITY_EDGES, {
        fileIds,
        threshold: options.threshold,
        maxEdgesPerNode: options.maxEdgesPerNode
      }),
    getFileMetadata: (/** @type {any} */ fileIds) =>
      secureIPC.safeInvoke(IPC_CHANNELS.EMBEDDINGS.GET_FILE_METADATA, { fileIds }),
    findFilesByPaths: (/** @type {any} */ paths) =>
      secureIPC.safeInvoke(IPC_CHANNELS.EMBEDDINGS.FIND_FILES_BY_PATHS, { paths }),
    findDuplicates: (/** @type {any} */ options) =>
      secureIPC.safeInvoke(IPC_CHANNELS.EMBEDDINGS.FIND_DUPLICATES, options || {}),
    trashDuplicates: (/** @type {any} */ payload) =>
      secureIPC.safeInvoke(IPC_CHANNELS.EMBEDDINGS.TRASH_DUPLICATES, payload || {}),
    reindexFileHashes: (/** @type {any} */ options) =>
      secureIPC.safeInvoke(IPC_CHANNELS.EMBEDDINGS.REINDEX_FILE_HASHES, options || {}),
    clearClusters: () => secureIPC.safeInvoke(IPC_CHANNELS.EMBEDDINGS.CLEAR_CLUSTERS),
    renameCluster: (/** @type {any} */ clusterId, /** @type {any} */ newLabel) =>
      secureIPC.safeInvoke(IPC_CHANNELS.EMBEDDINGS.RENAME_CLUSTER, { clusterId, newLabel })
  },

  // Latent-space Atlas (UMAP projection of embeddings)
  atlas: {
    getProjection: (/** @type {Record<string,any>} */ options = {}) =>
      secureIPC.safeInvoke(IPC_CHANNELS.ATLAS.GET_PROJECTION, options || {}),
    getStatus: () => secureIPC.safeInvoke(IPC_CHANNELS.ATLAS.GET_STATUS)
  },

  // Chat
  chat: {
    queryStream: (/** @type {any} */ payload) =>
      secureIPC.safeInvoke(IPC_CHANNELS.CHAT.QUERY_STREAM, payload),
    cancelStream: (/** @type {any} */ payload) =>
      secureIPC.safeInvoke(IPC_CHANNELS.CHAT.CANCEL_STREAM, payload),
    onStreamChunk: (/** @type {any} */ callback) =>
      secureIPC.safeOn(IPC_CHANNELS.CHAT.STREAM_CHUNK, callback),
    onStreamEnd: (/** @type {any} */ callback) =>
      secureIPC.safeOn(IPC_CHANNELS.CHAT.STREAM_END, callback),
    resetSession: (/** @type {any} */ sessionId) =>
      secureIPC.safeInvoke(IPC_CHANNELS.CHAT.RESET_SESSION, { sessionId }),
    listConversations: (/** @type {any} */ limit, /** @type {any} */ offset) =>
      secureIPC.safeInvoke(IPC_CHANNELS.CHAT.LIST_CONVERSATIONS, { limit, offset }),
    getConversation: (/** @type {any} */ id) =>
      secureIPC.safeInvoke(IPC_CHANNELS.CHAT.GET_CONVERSATION, { id }),
    deleteConversation: (/** @type {any} */ id) =>
      secureIPC.safeInvoke(IPC_CHANNELS.CHAT.DELETE_CONVERSATION, { id }),
    searchConversations: (/** @type {any} */ query) =>
      secureIPC.safeInvoke(IPC_CHANNELS.CHAT.SEARCH_CONVERSATIONS, { query }),
    exportConversation: (/** @type {any} */ id) =>
      secureIPC.safeInvoke(IPC_CHANNELS.CHAT.EXPORT_CONVERSATION, { id })
  },

  // Knowledge
  knowledge: {
    getRelationshipEdges: (
      /** @type {any} */ fileIds,
      /** @type {Record<string,any>} */ options = {}
    ) =>
      secureIPC.safeInvoke(IPC_CHANNELS.KNOWLEDGE.GET_RELATIONSHIP_EDGES, {
        fileIds,
        minWeight: options.minWeight,
        maxEdges: options.maxEdges
      }),
    getRelationshipStats: () => secureIPC.safeInvoke(IPC_CHANNELS.KNOWLEDGE.GET_RELATIONSHIP_STATS),
    getRelatedDocuments: (
      /** @type {any} */ fileId,
      /** @type {Record<string,any>} */ options = {}
    ) =>
      secureIPC.safeInvoke(IPC_CHANNELS.KNOWLEDGE.GET_RELATED_DOCUMENTS, {
        fileId,
        limit: options.limit,
        minWeight: options.minWeight,
        similarityThreshold: options.similarityThreshold
      }),
    rebuildRelationships: () =>
      secureIPC.safeInvoke(IPC_CHANNELS.KNOWLEDGE.REBUILD_RELATIONSHIPS, {})
  },

  // MCP Server
  mcp: {
    enable: () => secureIPC.safeInvoke(IPC_CHANNELS.MCP.ENABLE, {}).then(throwIfFailed),
    disable: () => secureIPC.safeInvoke(IPC_CHANNELS.MCP.DISABLE, {}).then(throwIfFailed),
    status: () => secureIPC.safeInvoke(IPC_CHANNELS.MCP.STATUS, {}),
    rotateToken: () => secureIPC.safeInvoke(IPC_CHANNELS.MCP.ROTATE_TOKEN, {}).then(throwIfFailed),
    getConfigSnippet: (/** @type {any} */ client) =>
      secureIPC.safeInvoke(IPC_CHANNELS.MCP.GET_CONFIG_SNIPPET, { client }).then(throwIfFailed),
    testConnection: () =>
      secureIPC.safeInvoke(IPC_CHANNELS.MCP.TEST_CONNECTION, {}).then(throwIfFailed),
    // See aiProvider.onStatusChanged for the rationale; using safeOn here
    // gives the same listener-tracking + allowlist parity.
    onStatusChanged: (/** @type {any} */ callback) =>
      secureIPC.safeOn(IPC_CHANNELS.MCP.STATUS_CHANGED, callback)
  },

  // Downloads Triage (Phase 3)
  downloads: {
    triage: {
      start: (payload = {}) => secureIPC.safeInvoke(IPC_CHANNELS.DOWNLOADS.TRIAGE_START, payload),
      deepScan: (/** @type {any} */ payload) =>
        secureIPC.safeInvoke(IPC_CHANNELS.DOWNLOADS.TRIAGE_DEEP_SCAN, payload || {}),
      act: (/** @type {any} */ payload) =>
        secureIPC.safeInvoke(IPC_CHANNELS.DOWNLOADS.TRIAGE_ACT, payload || {}),
      exportReport: (/** @type {any} */ triageId) =>
        secureIPC.safeInvoke(IPC_CHANNELS.DOWNLOADS.TRIAGE_EXPORT_REPORT, { triageId }),
      onScanProgress: (/** @type {any} */ callback) =>
        secureIPC.safeOn(IPC_CHANNELS.DOWNLOADS.TRIAGE_SCAN_PROGRESS, callback),
      onSessionInvalidated: (/** @type {any} */ callback) =>
        secureIPC.safeOn(IPC_CHANNELS.DOWNLOADS.TRIAGE_SESSION_INVALIDATED, callback)
    }
  },

  // Suggestions
  suggestions: {
    getFileSuggestions: (/** @type {any} */ file, /** @type {any} */ options) =>
      secureIPC.safeInvoke(IPC_CHANNELS.SUGGESTIONS.GET_FILE_SUGGESTIONS, { file, options }),
    getBatchSuggestions: (/** @type {any} */ files, /** @type {any} */ options) =>
      secureIPC.safeInvoke(IPC_CHANNELS.SUGGESTIONS.GET_BATCH_SUGGESTIONS, { files, options }),
    recordFeedback: (
      /** @type {any} */ file,
      /** @type {any} */ suggestion,
      /** @type {any} */ accepted,
      /** @type {any} */ note
    ) =>
      secureIPC.safeInvoke(IPC_CHANNELS.SUGGESTIONS.RECORD_FEEDBACK, {
        file,
        suggestion,
        accepted,
        note
      }),
    getStrategies: () => secureIPC.safeInvoke(IPC_CHANNELS.SUGGESTIONS.GET_STRATEGIES),
    applyStrategy: (/** @type {any} */ files, /** @type {any} */ strategyId) =>
      secureIPC.safeInvoke(IPC_CHANNELS.SUGGESTIONS.APPLY_STRATEGY, { files, strategyId }),
    getUserPatterns: () => secureIPC.safeInvoke(IPC_CHANNELS.SUGGESTIONS.GET_USER_PATTERNS),
    clearPatterns: () => secureIPC.safeInvoke(IPC_CHANNELS.SUGGESTIONS.CLEAR_PATTERNS),
    analyzeFolderStructure: (/** @type {any} */ files) =>
      secureIPC.safeInvoke(IPC_CHANNELS.SUGGESTIONS.ANALYZE_FOLDER_STRUCTURE, { files }),
    suggestNewFolder: (/** @type {any} */ file) =>
      secureIPC.safeInvoke(IPC_CHANNELS.SUGGESTIONS.SUGGEST_NEW_FOLDER, { file }),
    addFeedbackMemory: (/** @type {any} */ text, /** @type {any} */ metadata) =>
      secureIPC.safeInvoke(IPC_CHANNELS.SUGGESTIONS.ADD_FEEDBACK_MEMORY, { text, metadata }),
    getFeedbackMemory: () => secureIPC.safeInvoke(IPC_CHANNELS.SUGGESTIONS.GET_FEEDBACK_MEMORY),
    updateFeedbackMemory: (
      /** @type {any} */ id,
      /** @type {any} */ text,
      /** @type {any} */ metadata
    ) =>
      secureIPC.safeInvoke(IPC_CHANNELS.SUGGESTIONS.UPDATE_FEEDBACK_MEMORY, { id, text, metadata }),
    deleteFeedbackMemory: (/** @type {any} */ id) =>
      secureIPC.safeInvoke(IPC_CHANNELS.SUGGESTIONS.DELETE_FEEDBACK_MEMORY, { id })
  },

  // Organize
  organize: {
    auto: (/** @type {any} */ params) => secureIPC.safeInvoke(IPC_CHANNELS.ORGANIZE.AUTO, params),
    batch: (/** @type {any} */ params) => secureIPC.safeInvoke(IPC_CHANNELS.ORGANIZE.BATCH, params),
    processNew: (/** @type {any} */ params) =>
      secureIPC.safeInvoke(IPC_CHANNELS.ORGANIZE.PROCESS_NEW, params),
    getStats: () => secureIPC.safeInvoke(IPC_CHANNELS.ORGANIZE.GET_STATS),
    clusterBatch: (/** @type {any} */ files, /** @type {any} */ smartFolders) =>
      secureIPC.safeInvoke(IPC_CHANNELS.ORGANIZE.CLUSTER_BATCH, { files, smartFolders }),
    identifyOutliers: (/** @type {any} */ files) =>
      secureIPC.safeInvoke(IPC_CHANNELS.ORGANIZE.IDENTIFY_OUTLIERS, { files }),
    getClusterSuggestions: (/** @type {any} */ file, /** @type {any} */ smartFolders) =>
      secureIPC.safeInvoke(IPC_CHANNELS.ORGANIZE.GET_CLUSTER_SUGGESTIONS, { file, smartFolders })
  },

  // Undo/Redo
  undoRedo: {
    undo: () => secureIPC.safeInvoke(IPC_CHANNELS.UNDO_REDO.UNDO),
    redo: () => secureIPC.safeInvoke(IPC_CHANNELS.UNDO_REDO.REDO),
    getHistory: (/** @type {any} */ limit) =>
      secureIPC.safeInvoke(IPC_CHANNELS.UNDO_REDO.GET_HISTORY, limit),
    getState: () => secureIPC.safeInvoke(IPC_CHANNELS.UNDO_REDO.GET_STATE),
    clear: () => secureIPC.safeInvoke(IPC_CHANNELS.UNDO_REDO.CLEAR_HISTORY),
    canUndo: () => secureIPC.safeInvoke(IPC_CHANNELS.UNDO_REDO.CAN_UNDO),
    canRedo: () => secureIPC.safeInvoke(IPC_CHANNELS.UNDO_REDO.CAN_REDO),
    onStateChanged: (/** @type {any} */ callback) =>
      secureIPC.safeOn(IPC_CHANNELS.UNDO_REDO.STATE_CHANGED, callback)
  },

  // System
  system: {
    getMetrics: () => secureIPC.safeInvoke(IPC_CHANNELS.SYSTEM.GET_METRICS),
    getApplicationStatistics: () =>
      secureIPC.safeInvoke(IPC_CHANNELS.SYSTEM.GET_APPLICATION_STATISTICS),
    getRuntimeInfo: () => secureIPC.safeInvoke(IPC_CHANNELS.SYSTEM.GET_RUNTIME_INFO),
    applyUpdate: () => secureIPC.safeInvoke(IPC_CHANNELS.SYSTEM.APPLY_UPDATE),
    checkForUpdates: () => secureIPC.safeInvoke(IPC_CHANNELS.SYSTEM.CHECK_FOR_UPDATES),
    downloadUpdate: () => secureIPC.safeInvoke(IPC_CHANNELS.SYSTEM.DOWNLOAD_UPDATE),
    getConfig: () => secureIPC.safeInvoke(IPC_CHANNELS.SYSTEM.GET_CONFIG),
    getConfigValue: (/** @type {any} */ path) =>
      secureIPC.safeInvoke(IPC_CHANNELS.SYSTEM.GET_CONFIG_VALUE, path),
    getRecommendedConcurrency: () =>
      secureIPC.safeInvoke(IPC_CHANNELS.SYSTEM.GET_RECOMMENDED_CONCURRENCY),
    log: (/** @type {any} */ level, /** @type {any} */ message, /** @type {any} */ data) =>
      secureIPC.safeInvoke(
        IPC_CHANNELS.SYSTEM.LOG,
        normalizeSystemLogPayload(level, message, data)
      ),
    exportLogs: () => secureIPC.safeInvoke(IPC_CHANNELS.SYSTEM.EXPORT_LOGS),
    getDegradedState: () => secureIPC.safeInvoke(IPC_CHANNELS.SYSTEM.GET_DEGRADED_STATE),
    dismissDegradedFlag: (/** @type {any} */ code) =>
      secureIPC.safeInvoke(IPC_CHANNELS.SYSTEM.DISMISS_DEGRADED_FLAG, { code }),
    // Cooperative cancel of in-flight invokes on a channel (e.g. user clicks
    // Cancel during a batch organize). Synchronous fire-and-forget; returns
    // the number of in-flight requests signalled.
    abortInvoke: (/** @type {any} */ payload) =>
      secureIPC.abortInflightChannel(
        typeof payload?.channel === 'string' ? payload.channel : '',
        typeof payload?.reason === 'string' ? payload.reason : 'renderer-cancel'
      ),
    getLegalNotices: () => secureIPC.safeInvoke(IPC_CHANNELS.SYSTEM.GET_LEGAL_NOTICES),
    openLegalDocument: (/** @type {any} */ kind) =>
      secureIPC.safeInvoke(IPC_CHANNELS.SYSTEM.OPEN_LEGAL_DOCUMENT, { kind }),
    onOpenSemanticSearch: (/** @type {any} */ callback) =>
      secureIPC.safeOn(IPC_EVENTS.OPEN_SEMANTIC_SEARCH, callback)
  },

  // Trace: renderer-originated correlation ids scoped to a user action. Any
  // `safeInvoke` issued while a session is active carries the `traceId` to
  // the main process, where it becomes the correlation id used by the
  // structured logger for every log line produced by the handler. This lets
  // you group logs from multi-step user actions (e.g. "organize batch")
  // without threading an id through every dispatch manually.
  //
  // Usage:
  //   const trace = window.electronAPI.trace.beginSession();
  //   try {
  //     await window.electronAPI.files.analyze(path);
  //     await window.electronAPI.organize.batch(ops);
  //   } finally {
  //     trace.end();
  //   }
  trace: {
    beginSession: (/** @type {any} */ traceId, /** @type {any} */ options) =>
      secureIPC.beginTraceSession(traceId, options),
    generateTraceId: () => secureIPC._generateTraceId(),
    currentTraceId: () => secureIPC._currentTraceId()
  },

  // Window
  window: {
    minimize: () =>
      IPC_CHANNELS.WINDOW?.MINIMIZE
        ? secureIPC.safeInvoke(IPC_CHANNELS.WINDOW.MINIMIZE)
        : undefined,
    toggleMaximize: () =>
      IPC_CHANNELS.WINDOW?.TOGGLE_MAXIMIZE
        ? secureIPC.safeInvoke(IPC_CHANNELS.WINDOW.TOGGLE_MAXIMIZE)
        : undefined,
    isMaximized: () =>
      IPC_CHANNELS.WINDOW?.IS_MAXIMIZED
        ? secureIPC.safeInvoke(IPC_CHANNELS.WINDOW.IS_MAXIMIZED)
        : undefined,
    close: () =>
      IPC_CHANNELS.WINDOW?.CLOSE ? secureIPC.safeInvoke(IPC_CHANNELS.WINDOW.CLOSE) : undefined,
    setThemeBackground: (/** @type {any} */ theme) =>
      IPC_CHANNELS.WINDOW?.SET_THEME_BACKGROUND
        ? secureIPC.safeInvoke(IPC_CHANNELS.WINDOW.SET_THEME_BACKGROUND, theme)
        : undefined
  },

  // Commercial license status (offline verification, never touches the network)
  license: {
    getStatus: () =>
      secureIPC.safeInvoke(IPC_CHANNELS.LICENSE.GET_STATUS).then((r) => throwIfFailed(r)),
    activate: (/** @type {any} */ key) =>
      secureIPC.safeInvoke(IPC_CHANNELS.LICENSE.ACTIVATE, { key }).then((r) => throwIfFailed(r)),
    deactivate: () =>
      secureIPC.safeInvoke(IPC_CHANNELS.LICENSE.DEACTIVATE).then((r) => throwIfFailed(r))
  },

  // Llama Service (New in-process AI)
  llama: {
    getModels: () => secureIPC.safeInvoke(IPC_CHANNELS.LLAMA.GET_MODELS),
    getConfig: () => secureIPC.safeInvoke(IPC_CHANNELS.LLAMA.GET_CONFIG),
    updateConfig: (/** @type {any} */ config) =>
      secureIPC.safeInvoke(IPC_CHANNELS.LLAMA.UPDATE_CONFIG, config),
    testConnection: () => secureIPC.safeInvoke(IPC_CHANNELS.LLAMA.TEST_CONNECTION),
    warm: () => secureIPC.safeInvoke(IPC_CHANNELS.LLAMA.WARM),
    downloadModel: (/** @type {any} */ modelName) =>
      secureIPC.safeInvoke(IPC_CHANNELS.LLAMA.DOWNLOAD_MODEL, modelName),
    deleteModel: (/** @type {any} */ modelName) =>
      secureIPC.safeInvoke(IPC_CHANNELS.LLAMA.DELETE_MODEL, modelName),
    getDownloadStatus: () => secureIPC.safeInvoke(IPC_CHANNELS.LLAMA.GET_DOWNLOAD_STATUS),
    cancelDownload: (/** @type {any} */ modelName) =>
      secureIPC.safeInvoke(IPC_CHANNELS.LLAMA.CANCEL_DOWNLOAD, modelName)
  },

  // Whisper / VAD model installer (in-process counterpart of
  // scripts/setup-whisper-model.js — see WhisperModelInstaller.js)
  whisper: {
    getInstallStatus: () => secureIPC.safeInvoke(IPC_CHANNELS.WHISPER.GET_INSTALL_STATUS),
    installModel: (/** @type {any} */ options) =>
      secureIPC.safeInvoke(IPC_CHANNELS.WHISPER.INSTALL_MODEL, options)
  },

  // Vector DB (Orama - New in-process)
  vectorDb: {
    getStats: () => secureIPC.safeInvoke(IPC_CHANNELS.VECTOR_DB.GET_STATS),
    healthCheck: () => secureIPC.safeInvoke(IPC_CHANNELS.VECTOR_DB.HEALTH_CHECK),
    onStatusChanged: (/** @type {any} */ callback) =>
      secureIPC.safeOn(IPC_CHANNELS.VECTOR_DB.STATUS_CHANGED, callback)
  },

  // Event Listeners
  events: {
    onOperationProgress: (/** @type {any} */ callback) =>
      secureIPC.safeOn(IPC_EVENTS.OPERATION_PROGRESS, callback),
    onAppError: (/** @type {any} */ callback) => secureIPC.safeOn(IPC_EVENTS.APP_ERROR, callback),
    onAppUpdate: (/** @type {any} */ callback) => secureIPC.safeOn(IPC_EVENTS.APP_UPDATE, callback),
    onSystemMetrics: (/** @type {any} */ callback) =>
      secureIPC.safeOn(IPC_EVENTS.SYSTEM_METRICS, callback),
    onMenuAction: (/** @type {any} */ callback) =>
      secureIPC.safeOn(IPC_EVENTS.MENU_ACTION, callback),
    onSettingsChanged: (/** @type {any} */ callback) =>
      secureIPC.safeOn(IPC_EVENTS.SETTINGS_CHANGED_EXTERNAL, callback),
    onFileOperationComplete: (/** @type {any} */ callback) =>
      secureIPC.safeOn(IPC_EVENTS.FILE_OPERATION_COMPLETE, callback),
    onNotification: (/** @type {any} */ callback) =>
      secureIPC.safeOn(IPC_EVENTS.NOTIFICATION, callback),
    onNotificationAction: (/** @type {any} */ callback) =>
      secureIPC.safeOn(IPC_EVENTS.NOTIFICATION_ACTION, callback),
    onSmartFoldersUpdated: (/** @type {any} */ callback) =>
      secureIPC.safeOn(IPC_EVENTS.SMART_FOLDERS_UPDATED, callback),
    onBatchResultsChunk: (/** @type {any} */ callback) =>
      secureIPC.safeOn(IPC_EVENTS.BATCH_RESULTS_CHUNK, callback),
    onAnalysisFileComplete: (/** @type {any} */ callback) =>
      secureIPC.safeOn(IPC_EVENTS.ANALYSIS_FILE_COMPLETE, callback),
    // Fix 3B: sendError intentionally bypasses SecureIPCManager and uses ipcRenderer.send()
    // directly. This is deliberate: error reporting must not be blocked by the main invoke
    // pipeline (which might itself be erroring). It has its own 10/s rate limit and sanitization.
    // Combined max with SecureIPCManager is 210 req/s, which is acceptable.
    sendError: (() => {
      let _sendErrorCount = 0;
      let _sendErrorWindowStart = Date.now();
      const SEND_ERROR_MAX_PER_SEC = 10;

      return (/** @type {any} */ errorData) => {
        try {
          if (!errorData || typeof errorData !== 'object' || !errorData.message) return;

          // Rate limit: max 10 error reports per second
          const now = Date.now();
          if (now - _sendErrorWindowStart > 1000) {
            _sendErrorCount = 0;
            _sendErrorWindowStart = now;
          }
          if (++_sendErrorCount > SEND_ERROR_MAX_PER_SEC) return;

          const channel = IPC_CHANNELS.SYSTEM.RENDERER_ERROR_REPORT;
          if (!ALL_SEND_CHANNELS.has(channel)) return;
          const sanitized = {
            ...(typeof errorData.message === 'string' && {
              message: errorData.message.slice(0, 2048)
            }),
            ...(typeof errorData.stack === 'string' && { stack: errorData.stack.slice(0, 4096) }),
            ...(typeof errorData.componentStack === 'string' && {
              componentStack: errorData.componentStack.slice(0, 4096)
            })
          };
          ipcRenderer.send(channel, sanitized);
        } catch (error) {
          log.error('[events.sendError] Failed to send error report:', error);
        }
      };
    })()
  },

  // Settings
  settings: {
    get: async () =>
      throwIfFailed(await secureIPC.safeInvoke(IPC_CHANNELS.SETTINGS.GET), {
        expectObject: true,
        defaultMessage: 'Failed to load settings'
      }),
    /**
     * Merge a single key into current settings and persist (convenience for renderer/tests).
     */
    update: async (/** @type {any} */ key, /** @type {any} */ value) => {
      if (typeof key !== 'string' || !key.trim()) {
        throw new Error('settings.update requires a non-empty string key');
      }
      // The main-process SAVE handler silently strips un-allowlisted keys;
      // failing loudly here turns a silent no-op into an actionable error.
      if (!SETTINGS_VALIDATION.allowedKeys.has(key)) {
        throw new Error(`settings.update: "${key}" is not an allowlisted settings key`);
      }
      const current = await throwIfFailed(await secureIPC.safeInvoke(IPC_CHANNELS.SETTINGS.GET), {
        expectObject: true,
        defaultMessage: 'Failed to load settings'
      });
      const merged = { ...current, [key]: value };
      return throwIfFailed(await secureIPC.safeInvoke(IPC_CHANNELS.SETTINGS.SAVE, merged), {
        expectObject: true,
        defaultMessage: 'Failed to save settings'
      });
    },
    save: async (/** @type {any} */ settings) =>
      throwIfFailed(await secureIPC.safeInvoke(IPC_CHANNELS.SETTINGS.SAVE, settings), {
        expectObject: true,
        defaultMessage: 'Failed to save settings'
      }),
    // Fix 3C: Consistent throwIfFailed usage across all settings methods
    getConfigurableLimits: async () =>
      throwIfFailed(await secureIPC.safeInvoke(IPC_CHANNELS.SETTINGS.GET_CONFIGURABLE_LIMITS), {
        defaultMessage: 'Failed to get configurable limits'
      }),
    getLogsInfo: async () =>
      throwIfFailed(await secureIPC.safeInvoke(IPC_CHANNELS.SETTINGS.GET_LOGS_INFO), {
        defaultMessage: 'Failed to get logs info'
      }),
    openLogsFolder: async () =>
      throwIfFailed(await secureIPC.safeInvoke(IPC_CHANNELS.SETTINGS.OPEN_LOGS_FOLDER), {
        defaultMessage: 'Failed to open logs folder'
      }),
    export: async (/** @type {any} */ exportPath) =>
      throwIfFailed(await secureIPC.safeInvoke(IPC_CHANNELS.SETTINGS.EXPORT, exportPath), {
        expectObject: true,
        defaultMessage: 'Failed to export settings'
      }),
    import: async (/** @type {any} */ importPath) =>
      throwIfFailed(await secureIPC.safeInvoke(IPC_CHANNELS.SETTINGS.IMPORT, importPath), {
        expectObject: true,
        defaultMessage: 'Failed to import settings'
      }),
    createBackup: async () =>
      throwIfFailed(await secureIPC.safeInvoke(IPC_CHANNELS.SETTINGS.CREATE_BACKUP), {
        defaultMessage: 'Failed to create settings backup'
      }),
    listBackups: async () =>
      throwIfFailed(await secureIPC.safeInvoke(IPC_CHANNELS.SETTINGS.LIST_BACKUPS), {
        defaultMessage: 'Failed to list settings backups'
      }),
    restoreBackup: async (/** @type {any} */ backupPath) =>
      throwIfFailed(await secureIPC.safeInvoke(IPC_CHANNELS.SETTINGS.RESTORE_BACKUP, backupPath), {
        expectObject: true,
        defaultMessage: 'Failed to restore settings backup'
      }),
    deleteBackup: async (/** @type {any} */ backupPath) =>
      throwIfFailed(await secureIPC.safeInvoke(IPC_CHANNELS.SETTINGS.DELETE_BACKUP, backupPath), {
        expectObject: true,
        defaultMessage: 'Failed to delete settings backup'
      })
  }

  // Deprecated APIs removed - in-process stack only
});

log.info('Secure context bridge exposed with structured API');

// Test-only export. In the bundled production preload (webpack `target: 'web'`,
// no `output.library`) this assignment stays inside webpack's per-module wrapper
// and is never read — the preload runs for its `exposeInMainWorld` side effect,
// not its exports. Under jest (CommonJS) it lets unit suites exercise
// `SecureIPCManager.enqueueThrottled` against the real method instead of an
// inline reimplementation of its stale-eviction logic.
if (typeof module !== 'undefined' && module.exports) {
  module.exports.SecureIPCManager = SecureIPCManager;
}
