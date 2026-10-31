// @ts-check
/**
 * Performance and Timing Constants
 * Centralized location for all timing-related magic numbers
 *
 * This file contains all performance-related constants used throughout the application.
 * Constants are organized by category and can be overridden via environment variables
 * where appropriate.
 */

const path = require('path');

/**
 * Environment variable helper - safely parse numeric env vars with validation
 * @param {string} envVar - Environment variable name
 * @param {number} defaultValue - Default value if env var is not set or invalid
 * @param {{ min?: number, max?: number }} [options] - Validation options
 * @returns {number} Parsed value or default
 */
function getEnvNumber(envVar, defaultValue, options = {}) {
  const value = process.env[envVar];
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    return defaultValue;
  }
  const { min = -Infinity, max = Infinity } = options;
  if (parsed < min || parsed > max) {
    return defaultValue;
  }
  return parsed;
}

/**
 * Timeout durations in milliseconds
 */
const TIMEOUTS = {
  DEBOUNCE_INPUT: 300,
  TOOLTIP_DELAY: 500,
  ANIMATION_SHORT: 200,
  ANIMATION_MEDIUM: 300,
  ANIMATION_LONG: 500,
  ANIMATION_FADE: 180, // Fade skeleton/overlay animations
  FILE_READ: 15000,
  FILE_WRITE: 10000,
  FILE_COPY: 30000,
  DIRECTORY_SCAN: 60000,
  AI_ANALYSIS_SHORT: 30000,
  AI_ANALYSIS_MEDIUM: 60000,
  AI_ANALYSIS_LONG: 300000, // Increased to 5 minutes to handle CPU-based vision analysis
  // Batch runs can legitimately exceed per-file timeouts on CPU-bound systems.
  // Keep this high and rely on analysis watchdogs for hang detection.
  AI_ANALYSIS_BATCH: 30 * 60 * 1000,
  // Downloads triage Tier 0 + Tier 1 can exceed default IPC invoke budget on large folders.
  TRIAGE_SCAN_LONG: 15 * 60 * 1000,
  // Invoke budget for channels that block on a native modal dialog
  // (showOpenDialog/showSaveDialog): the wait is user-controlled — someone
  // browsing a folder tree can legitimately sit in the dialog for minutes,
  // and the handler resolves the moment the dialog closes.
  USER_DIALOG: 10 * 60 * 1000,
  API_REQUEST: 10000,
  API_REQUEST_SLOW: 30000,
  HEALTH_CHECK: 5000,
  AXIOS_DEFAULT: 5000,
  SERVICE_STARTUP: 30000,
  SERVICE_INIT_WAIT: 2000, // Wait for service initialization
  DATABASE_INIT: 15000,
  MODEL_LOAD: 60000,
  MODEL_DISCOVERY: 5000, // Model discovery/list timeout
  EMBEDDING_REQUEST: 30000,
  BATCH_EMBEDDING_MAX: 5 * 60 * 1000, // 5 minutes max for batch embedding operations
  MODEL_LIST: 15000, // Timeout for listing all local models
  DELAY_MICRO: 50, // Very short delays for race condition prevention
  DELAY_TINY: 5, // Minimal delay for inter-file processing
  DELAY_MINI: 10, // Small delay for inter-batch processing
  DELAY_SHORT: 250,
  DELAY_MEDIUM: 500,
  DELAY_BATCH: 100, // Short delay for batch operations
  DELAY_LOCK_RETRY: 400, // Delay before retrying lock acquisition
  MUTEX_ACQUIRE: 30000,
  DELAY_NOTIFICATION: 1500,
  SIGKILL_VERIFY: 100, // Delay to verify SIGKILL termination
  CLEANUP_DELAY: 60000, // Delay before cleanup operations (e.g., temp file removal)
  CLEANUP_MAX: 5000,
  SHUTDOWN_MAX: 10000,
  PROCESS_KILL_VERIFY: 500, // Delay to verify process termination
  IPC_HANDLER_RETRY_BASE: 100,
  IPC_HANDLER_MAX_WAIT: 2000,
  SEARCH_INDEX_REBUILD: 5000, // Max wait for BM25 index rebuild after batch operations
  SEMANTIC_QUERY: 30000,
  FLUSH_MAX_WAIT: 30000,
  WINDOW_LOAD_DELAY: 100, // Delay before loading window content
  // Electron recommends showing complex apps immediately with a backgroundColor;
  // this bounds the hidden period when ready-to-show is late (GPU process hang,
  // slow renderer bootstrap). The window is force-shown once this elapses.
  WINDOW_SHOW_FALLBACK: 4000,
  // Heavyweight coordinated startup waits for the first paint (show or
  // did-finish-load) before it starts, capped here so a headless or stuck
  // renderer still initialises services.
  FIRST_PAINT_GATE: 3000,
  // First show can wait on GPU model warmup + renderer bootstrap; mutex must not expire early.
  WINDOW_CREATION_READY: 60000,
  // Bound on each stat/mkdir of the Uncategorized folder before the window is
  // created. Documents can sit on a slow or offline volume (redirected to a
  // network share, a cloud placeholder); startup continues without it.
  DEFAULT_FOLDER_PROBE: 3000,
  // A hardware-accelerated session must keep its window up this long with no
  // GPU process exits before the sticky .gpu-fallback flag is cleared.
  GPU_FALLBACK_STABLE_RUN: 30000,
  // Analysis lock and monitoring timeouts
  ANALYSIS_LOCK: 5 * 60 * 1000, // 5 minutes - forces lock release if analysis hangs
  GLOBAL_ANALYSIS: 10 * 60 * 1000, // 10 minutes - max total analysis time
  HEARTBEAT_INTERVAL: 30000, // 30 seconds - progress heartbeat during analysis
  STALE_ACTIVITY: 15 * 60 * 1000, // 15 minutes - activity considered stale
  METRICS_BROADCAST: 30000, // 30 seconds - system metrics broadcast to renderer
  EMBEDDING_CHECK: 1000, // Delay before checking embeddings status
  STUCK_ANALYSIS_CHECK: 2 * 60 * 1000, // 2 minutes - analysis considered stuck
  VISION_STARTUP: 120000, // 2 min — vision model loading can be slow
  VISION_REQUEST: 90000, // 90s — most images complete in 30-60s; cuts timeout from 5min
  // Keep vision runtime alive briefly between requests to avoid costly cold starts.
  // Set to 0 to disable keep-alive and force immediate shutdown behavior.
  VISION_IDLE_KEEPALIVE: 60000,
  // MCP Streamable HTTP sessions with no traffic for this long are closed
  // so clients that never send DELETE cannot grow the per-session server map.
  MCP_SESSION_IDLE: 30 * 60 * 1000
};

const RETRY = {
  MAX_ATTEMPTS_LOW: 2,
  MAX_ATTEMPTS_MEDIUM: 3,
  MAX_ATTEMPTS_HIGH: 5,
  MAX_ATTEMPTS_VERY_HIGH: 10,
  INITIAL_DELAY: 1000,
  MAX_DELAY: 10000,
  EXPONENTIAL_BASE: 2,
  FILE_OPERATION: { maxAttempts: 3, initialDelay: 500, maxDelay: 5000 },
  NETWORK_REQUEST: { maxAttempts: 5, initialDelay: 1000, maxDelay: 10000 },
  AI_ANALYSIS: { maxAttempts: 2, initialDelay: 2000, maxDelay: 10000 },
  IPC_HANDLER: { maxAttempts: 5, initialDelay: 100 },
  LLAMA_API: { maxAttempts: 3, initialDelay: 1000, maxDelay: 4000 },
  VECTOR_DB: { maxAttempts: 3, initialDelay: 500, maxDelay: 5000 },
  SETTINGS_BACKUP: { initialDelay: 100 }, // Start delay for exponential backoff during settings backup
  SETTINGS_SAVE: { initialDelay: 200 }, // Start delay for exponential backoff during settings save
  DATABASE_OFFLINE_MAX: 10,
  ITEM_MAX_RETRIES: 3,
  BACKOFF_BASE_MS: 5000,
  BACKOFF_MAX_MS: 300000,
  // Atomic operation retry backoff (multiplied by attempt number)
  ATOMIC_BACKOFF_STEP_MS: 50 // e.g., 50ms, 100ms, 150ms for attempts 1, 2, 3
};

const CACHE = {
  MAX_FILE_CACHE: 500,
  MAX_IMAGE_CACHE: getEnvNumber('MAX_IMAGE_CACHE', 300, { min: 50, max: 1000 }),
  MAX_EMBEDDING_CACHE: 1000,
  MAX_ANALYSIS_CACHE: 200,
  MAX_LRU_CACHE: 100,
  TTL_SHORT: 5 * 60 * 1000,
  TTL_MEDIUM: 30 * 60 * 1000,
  TTL_LONG: 2 * 60 * 60 * 1000,
  TTL_DAY: 24 * 60 * 60 * 1000,
  CLEANUP_INTERVAL: 15 * 60 * 1000,
  ANALYSIS_HISTORY_TTL_MS: 5000,
  STATS_CACHE_TTL_MS: 30000,
  SEARCH_CACHE_TTL_MS: 10000
};

const BATCH = {
  SIZE_SMALL: 10,
  SIZE_MEDIUM: 50,
  SIZE_LARGE: 100,
  SIZE_XLARGE: 1000,
  MAX_CONCURRENT_FILES: 5,
  MAX_CONCURRENT_ANALYSIS: 3,
  MAX_CONCURRENT_NETWORK: 10,
  PROGRESS_UPDATE_INTERVAL: 1000,
  EMBEDDING_BATCH_SIZE: 50,
  EMBEDDING_PARALLEL_SIZE: 10,
  EMBEDDING_FLUSH_DELAY_MS: 500,
  SEMANTIC_BATCH_SIZE: 50,
  AUTO_ORGANIZE_BATCH_SIZE: getEnvNumber('AUTO_ORGANIZE_BATCH_SIZE', 10, {
    min: 1,
    max: 100
  })
};

const THRESHOLDS = {
  CONFIDENCE_LOW: 0.3,
  CONFIDENCE_MEDIUM: 0.6,
  CONFIDENCE_HIGH: 0.8,
  CONFIDENCE_VERY_HIGH: 0.9,
  DEFAULT_CONFIDENCE_PERCENT: 70,
  DEFAULT_IMAGE_CONFIDENCE_PERCENT: 75,
  MEMORY_WARNING_PERCENT: 80,
  DISK_WARNING_PERCENT: 90,
  CPU_WARNING_PERCENT: 85,
  MIN_SIMILARITY_SCORE: 0.15, // Lowered from 0.25 to allow more marginal semantic matches
  MIN_MATCH_CONFIDENCE: 0.6,
  // Min cosine score for an embedding match to override a generic/non-matching
  // LLM category. Tuned from real nomic-embed-text-v1.5 measurements
  // (scripts/measure-embedding-scores.js): correct folder matches on full
  // document content score 0.68-0.86, while the next-best (wrong) folder trails
  // by ~0.14. 0.55 sits a safe ~0.12 below the weakest legitimate match so good
  // matches are not rejected, yet still excludes low-confidence noise. The prior
  // 0.65 sat on top of the weakest real match and (with the old input-truncation
  // bug depressing scores) silently dropped valid semantic routes.
  FOLDER_MATCH_CONFIDENCE: 0.55,
  // Stricter floor used when the LLM category is generic ("image") or doesn't
  // map to any existing smart folder. In that case `effectiveLlmConfidence`
  // collapses to 0, so the override gate degenerates to "any embedding >=
  // FOLDER_MATCH_CONFIDENCE wins" — letting a 0.61 score route a wellness
  // image into Financial. Requiring 0.75 here means a low-confidence embedding
  // can't quietly hijack an unmatchable LLM category; the unmatched theme is
  // surfaced as a new-folder suggestion instead.
  FOLDER_MATCH_UNMATCHED_CATEGORY_FLOOR: 0.75,
  // LLM self-reported confidence calibration caps.
  //
  // Small quantized text models will happily report 95% confidence on a
  // routing decision driven by surface-token overlap (e.g. "Liberty
  // University" matching both a resume and an unrelated AVA folder
  // description). The score reflects model self-assessment, not the model's
  // actual discriminative power for this corpus.
  //
  // We sanity-check LLM confidence against the embedding-side signal — the
  // SPREAD between the top-scoring folder and the runner-up. A small spread
  // means the embedding model can't tell them apart either, so a near-
  // certain confidence is unwarranted. Caps are deliberately conservative
  // (never raise, only cap) so a legitimately decisive route survives
  // intact.
  CONFIDENCE_CALIBRATION: {
    // No embedding folder candidates returned at all — the LLM is the only
    // source. Cap so the UI shows hedged language for any decision we can't
    // cross-check.
    NO_EMBEDDING_CAP: 80,
    // Top folder score didn't even reach FOLDER_MATCH_CONFIDENCE — the
    // embedding model couldn't find a confident home for the file.
    LOW_TOP_SCORE_CAP: 70,
    // The LLM picked a category that doesn't map to any registered smart
    // folder. The LLM's self-confidence is irrelevant when its label is
    // unactionable.
    UNMATCHABLE_CATEGORY_CAP: 75,
    // Spread bins: top.score - runnerUp.score, with runner-up=0 if absent.
    // A tighter spread = the embedding model is less confident, so the cap
    // on the LLM's claim tightens too.
    NO_SPREAD_THRESHOLD: 0.03, // virtually tied
    NO_SPREAD_CAP: 60,
    NARROW_SPREAD_THRESHOLD: 0.07,
    NARROW_SPREAD_CAP: 75,
    MODERATE_SPREAD_THRESHOLD: 0.12,
    MODERATE_SPREAD_CAP: 85
  },
  QUEUE_HIGH_WATERMARK: 0.75,
  QUEUE_CRITICAL_WATERMARK: 0.9,
  // Similarity edge thresholds
  SIMILARITY_EDGE_DEFAULT: 0.5,
  SIMILARITY_EDGE_MAX_PER_NODE: 3,
  // Duplicate-tier thresholds (see src/main/services/ClusteringService.js#findNearDuplicates).
  // EXACT is reserved for byte-identical SHA-256 matches, not a cosine threshold.
  DUPLICATE_EXACT: 1.0,
  DUPLICATE_NEAR_IDENTICAL_MIN: 0.98,
  DUPLICATE_RELATED_MIN: 0.9
};

/**
 * Stability guardrail thresholds.
 * Used by telemetry + release threshold checks to detect regression drift.
 */
const STABILITY_THRESHOLDS = {
  // Warn when more than 25% of searches require fallback paths.
  SEARCH_FALLBACK_RATE_WARN: 0.25,
  // Warn when more than 30% of routing decisions resolve to Uncategorized.
  UNCATEGORIZED_ROUTING_RATE_WARN: 0.3
};

/**
 * Search and Ranking Constants
 * Parameters for hybrid search, RRF fusion, and scoring
 */
const SEARCH = {
  // Reciprocal Rank Fusion constant (higher = more weight to top results)
  RRF_K: 60,
  // RRF score blending weights (for combining normalized RRF with original score)
  RRF_NORMALIZED_WEIGHT: 0.7,
  RRF_ORIGINAL_WEIGHT: 0.3,
  // Hybrid search weights - semantic-first for natural language queries
  // Reduced BM25 weight prevents keyword-only matches from dominating
  VECTOR_WEIGHT: 0.75,
  BM25_WEIGHT: 0.25,
  // Default topK values by context
  DEFAULT_TOP_K: 30,
  DEFAULT_TOP_K_SIMILAR: 10,
  // Graph expansion defaults (local relationship index)
  GRAPH_EXPANSION_ENABLED: false,
  GRAPH_EXPANSION_WEIGHT: 0.2,
  GRAPH_EXPANSION_MAX_SEEDS: 15,
  GRAPH_EXPANSION_MAX_EDGES: 200,
  GRAPH_EXPANSION_MAX_NEIGHBORS: 120,
  GRAPH_EXPANSION_MIN_WEIGHT: 2,
  GRAPH_EXPANSION_DECAY: 0.6,
  // Contextual chunk expansion
  CHUNK_CONTEXT_ENABLED: true,
  CHUNK_CONTEXT_MAX_NEIGHBORS: 1,
  CHUNK_CONTEXT_MAX_FILES: 8,
  CHUNK_CONTEXT_MAX_CHARS: 2000,
  // Chunk search multiplier (topK * multiplier candidates, capped at 100)
  CHUNK_TOP_K_MULTIPLIER: 3,
  // Minimum epsilon for division safety
  MIN_EPSILON: 0.001
};

/**
 * Text Chunking Constants
 * Parameters for splitting large documents into embeddable chunks
 * Used for deep semantic recall from extracted text
 */
const CHUNKING = {
  // Default chunk size in characters
  CHUNK_SIZE: 1000,
  // Overlap between consecutive chunks for context preservation
  OVERLAP: 200,
  // Maximum number of chunks per document (prevents runaway chunking)
  MAX_CHUNKS: 80,
  // Minimum text length to trigger chunking
  MIN_TEXT_LENGTH: 200,
  // Maximum chunks to return per file in search results
  MAX_CHUNKS_PER_FILE: 3
};

/**
 * Smart Content Selection Constants
 * Parameters for selecting representative content from large documents
 * for LLM analysis, replacing naive linear truncation.
 */
const CONTENT_SELECTION = {
  // Fraction of total budget reserved for the document outline (headings)
  OUTLINE_RATIO: 0.05,
  // Fraction of body budget (budget minus outline) for the document beginning
  HEAD_RATIO: 0.37,
  // Fraction of body budget for the document ending
  TAIL_RATIO: 0.16,
  // Remainder (1 - HEAD - TAIL = 0.47) goes to middle samples.
  // Number of evenly-spaced samples drawn from the middle of the document
  MIDDLE_SAMPLE_COUNT: 4,
  // Characters reserved for section markers ([BEGINNING], [END], etc.)
  MARKER_OVERHEAD: 80,
  // Map-reduce threshold: documents exceeding this character count
  // are eligible for the optional deep-analysis summarization path
  MAP_REDUCE_THRESHOLD: 100000,
  // Map phase: max response tokens per chunk summary (short = fast)
  MAP_MAX_TOKENS: 256,
  // Map phase: temperature (0 = deterministic, fastest generation)
  MAP_TEMPERATURE: 0,
  // Map phase: chunk size in characters
  MAP_CHUNK_SIZE: 8000
};

const LIMITS = {
  MAX_SEARCH_RESULTS: 100,
  MAX_SUGGESTIONS: 10,
  MAX_HISTORY_ITEMS: 1000,
  MAX_LOG_ENTRIES: 5000,
  MAX_UNDO_STACK: 50,
  MAX_QUEUE_SIZE: 10000,
  MAX_DEAD_LETTER_SIZE: 1000,
  MAX_HISTORY_ENTRIES: 10000,
  MAX_TOP_K: 100,
  MAX_XLSX_ROWS: 10000,
  MAX_IPC_REQUESTS_PER_SECOND: 200,
  RATE_LIMIT_CLEANUP_THRESHOLD: 100,
  RATE_LIMIT_STALE_MS: 60000,
  IPC_INVOKE_TIMEOUT: 330000, // Default invoke timeout; long channels override via _getInvokeTimeout
  MAX_NUMERIC_RETRIES: 5000,
  MAX_FILENAME_LENGTH: 255, // Standard filesystem limit (NTFS, ext4, HFS+)
  MAX_SETTINGS_BACKUPS: 10,
  MAX_WATCHER_RESTARTS: 10,
  WATCHER_RESTART_WINDOW: 60000,
  FEEDBACK_RETENTION_DAYS: 90,
  PATTERN_STALE_DAYS: 180,
  MEMORY_CHECK_INTERVAL: 100,
  MAX_OVERLAP_ITERATIONS: 10000,
  MAX_OVERLAPS_REPORT: 100,
  BATCH_ORGANIZE_SIZE: 100, // Maximum files in a single batch organize operation
  ANALYSIS_QUEUE_SIZE: 1000, // Maximum size of analysis queue in SmartFolderWatcher (prevents drops during bulk imports)
  MAX_ANALYSIS_RESULTS: 5000 // Maximum analysis results kept in Redux store to prevent unbounded memory growth
};

const DEBOUNCE = {
  SETTINGS_SAVE: 1000,
  SETTINGS_HYDRATION: 10000, // Max wait for settings hydration from main process
  PATTERN_SAVE_THROTTLE: 5000,
  CACHE_BATCH_WAIT: 100,
  CACHE_BATCH_MAX_WAIT: 5000,
  REFRESH_INTERVAL: 60000,
  ERROR_RETRY_INTERVAL: 5000,
  WATCHER_RESTART_BASE: 5000, // Base delay for watcher restart exponential backoff
  LEARNING_DEDUPE_WINDOW: 5000, // Prevent duplicate learning for same file within 5s
  FEEDBACK_MEMORY_SAVE: 5000, // Throttle feedback memory persistence
  PERSISTENCE_SAVE: 5000 // Throttle pattern persistence saves
};

const CONCURRENCY = {
  FOLDER_SCAN: 50,
  EMBEDDING_FLUSH: 5,
  // Analysis worker limits
  // Default to 1 for sequential processing - better UX (see progress) and prevents VRAM exhaustion
  // Users with high VRAM can increase via settings
  MIN_WORKERS: 1,
  DEFAULT_WORKERS: 1,
  MAX_WORKERS: 8
};

const GPU_TUNING = {
  // Batch sizes by VRAM tier
  NUM_BATCH_CPU_ONLY: 128,
  NUM_BATCH_MINIMAL: 192, // 4GB or unknown GPU
  NUM_BATCH_LOW_MEMORY: 256, // 6GB VRAM
  NUM_BATCH_MEDIUM_MEMORY: 384, // 8GB VRAM
  NUM_BATCH_HIGH_MEMORY: 512, // 12GB VRAM
  NUM_BATCH_VERY_HIGH_MEMORY: 1024, // 16GB+ VRAM
  // VRAM thresholds in MB
  LOW_MEMORY_THRESHOLD: 6000,
  MEDIUM_MEMORY_THRESHOLD: 8000,
  HIGH_MEMORY_THRESHOLD: 12000,
  VERY_HIGH_MEMORY_THRESHOLD: 16000
};

/**
 * LLM inference performance tuning constants
 * Used for node-llama-cpp in-process inference
 * Based on 2026 best practices for local LLM inference
 */
const LLAMA = {
  // Max loaded models - actual value is VRAM-dependent (set in PerformanceService)
  // 8GB+: 3 models (text + vision + embedding), <8GB: 2 models
  MAX_LOADED_MODELS: 2, // Default for <8GB VRAM
  // Parallel requests for embeddings (1 is more stable with in-process inference)
  NUM_PARALLEL_EMBEDDINGS: 1,
  // GPU layers configuration ('auto' = offload all layers to GPU when available)
  GPU_LAYERS_DEFAULT: 'auto',
  // Context window sizes by task type (reference defaults; actual sizing is dynamic in LlamaService)
  CONTEXT_EMBEDDINGS: 512,
  CONTEXT_VISION: 4608, // LLaVA images encode to ~4000 tokens; floor must exceed that
  CONTEXT_TEXT: 8192,
  // Headroom reserved on tight-VRAM GPUs (workspace allocator + driver compositor
  // + OS reserve) when computing an explicit `--n-gpu-layers` count for the
  // out-of-process vision server. Subtracted from `vramMB - mmproj - KV` before
  // the per-layer budget is divided out. Conservative; over-reserving costs
  // a layer or two of offload, under-reserving SIGTERMs the runtime at
  // `load_tensors`.
  VISION_TIGHT_VRAM_OVERHEAD_MB: 600,
  // Rate limiting (internal, not network-based)
  MAX_REQUESTS_PER_SECOND: 5,
  RATE_LIMIT_WINDOW_MS: 1000
};

/**
 * Window management timing constants
 * Used for window restore, focus, and visibility operations
 */
const WINDOW = {
  /** Delay after restore() before checking visibility (ms) */
  RESTORE_SETTLE_MS: 50,
  /** Duration to keep window "always on top" when forcing foreground on Windows (ms) */
  ALWAYS_ON_TOP_DURATION_MS: 100
};

/**
 * Process management timing constants
 * Used for graceful shutdown and process termination
 */
const PROCESS = {
  /** Time to wait after SIGTERM before sending SIGKILL (ms) */
  GRACEFUL_SHUTDOWN_WAIT_MS: 2000,
  /** Timeout for individual kill commands (ms) */
  KILL_COMMAND_TIMEOUT_MS: 100
};

/**
 * Text truncation limits for display and processing
 * Used to prevent memory issues and improve performance
 */
const TRUNCATION = {
  // Display limits
  NAME_MAX: 50,
  DESCRIPTION_MAX: 140,
  PREVIEW_SHORT: 100,
  PREVIEW_MEDIUM: 200,
  PREVIEW_LONG: 300,
  PREVIEW_XLARGE: 500,

  // Processing limits
  TEXT_EXTRACT_MAX: 2000,
  CACHE_SIGNATURE: 1000,
  HASH_PREFIX: 8,
  FOLDER_ID_HASH: 32,

  // Collection limits
  FOLDERS_DISPLAY: 10,
  KEYWORDS_MAX: 7,
  KEYWORDS_EXTENDED: 15,
  TAGS_DISPLAY: 5,
  ZIP_ENTRIES_MAX: 50,
  XLSX_ENTRIES_MAX: 100,
  TOP_EXTENSIONS: 3
};

/**
 * Viewport breakpoints for responsive design
 * Matches common device widths
 */
const VIEWPORT = {
  MOBILE: 480,
  TABLET: 768,
  DESKTOP: 1280,
  WIDE_DESKTOP: 1600,
  ULTRA_WIDE: 1920,
  FOUR_K: 2560
};

/**
 * Temp file patterns to ignore during file watching.
 * Canonical superset — used by DownloadWatcher, SmartFolderWatcher, and any
 * other code that needs to skip transient/system files.
 * @readonly
 * @type {Array<RegExp>}
 */
const TEMP_FILE_PATTERNS = [
  // Generic temp / backup files
  /\.(tmp|temp)$/i,
  /\.bak$/i,
  // Download-manager temp files
  /\.crdownload$/i, // Chrome
  /\.part$/i, // Firefox
  /\.partial$/i, // Generic partial
  /\.download$/i, // Safari
  /\.!qB$/i, // qBittorrent
  // Editor swap / lock files
  /\.swp$/i, // Vim
  /\.swx$/i, // Vim
  /\.swo$/i, // Vim
  /\.lock$/i, // Generic lock
  /\.lck$/i, // Alternative lock
  // Editor / OS temp-file naming conventions
  /^~\$/, // Microsoft Office temp (~$document.docx)
  /^\.#/, // Emacs lock files
  /^#.*#$/, // Emacs auto-save files
  /~$/, // Backup files ending in tilde
  // macOS system / resource files
  /^\._/, // macOS resource forks
  /^\.DS_Store$/i,
  // Windows system files
  /^Thumbs\.db$/i,
  /^desktop\.ini$/i
];

/**
 * Check if a **filename** (basename, no directory) matches temp file patterns.
 * @param {string} filename - Filename to check (must be a basename)
 * @returns {boolean} True if file is a temp file
 */
function isTempFile(filename) {
  return TEMP_FILE_PATTERNS.some((pattern) => pattern.test(filename));
}

/**
 * Check if a **file path** references a temporary or incomplete file.
 * Convenience wrapper that extracts the basename before testing.
 * @param {string} filePath - Full or relative file path
 * @returns {boolean} True if the file appears to be temporary
 */
function isTemporaryFile(filePath) {
  return isTempFile(path.basename(filePath));
}

module.exports = {
  TIMEOUTS,
  RETRY,
  CACHE,
  BATCH,
  THRESHOLDS,
  STABILITY_THRESHOLDS,
  SEARCH,
  CHUNKING,
  LIMITS,
  DEBOUNCE,
  CONTENT_SELECTION,
  CONCURRENCY,
  GPU_TUNING,
  LLAMA,
  WINDOW,
  PROCESS,
  TRUNCATION,
  VIEWPORT,
  TEMP_FILE_PATTERNS,
  isTempFile,
  isTemporaryFile
};
