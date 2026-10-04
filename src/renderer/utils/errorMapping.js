// @ts-check
import { ERROR_CODES as AI_ERROR_CODES } from '../../shared/errorCodes';
import {
  looksLikeCpuIncompatibility,
  looksLikeModelNotFound
} from '../../shared/llamaErrorClassifier';

const DEFAULT_NOTIFICATION = {
  severity: 'error',
  duration: 5000
};

const ERROR_TYPE_MAP = {
  TIMEOUT: {
    severity: 'warning',
    message: 'Operation timed out. Please try again.'
  },
  IPC_TIMEOUT: {
    severity: 'warning',
    message: 'The AI is busy processing other requests. Please try again shortly.'
  },
  RATE_LIMITED: {
    severity: 'warning',
    message: 'Too many requests. Please wait a moment and try again.'
  },
  CIRCUIT_OPEN: {
    severity: 'warning',
    message: 'AI service is temporarily recovering. Please wait a moment and try again.'
  },
  HANDLER_NOT_READY: {
    severity: 'warning',
    message: 'Service is still starting up. Please wait a moment and try again.'
  },
  NETWORK: {
    severity: 'warning',
    message: 'Network error. Check your connection and try again.'
  },
  FILE_NOT_FOUND: {
    severity: 'error',
    message: 'File not found. It may have been moved or deleted.'
  },
  MODEL_NOT_FOUND: {
    severity: 'error',
    message: 'Required model is missing. Install the model and retry.'
  },
  AI_ENGINE_ERROR: {
    severity: 'error',
    message: 'AI service error. Check model status and try again.'
  },
  OUT_OF_MEMORY: {
    severity: 'error',
    message: 'Out of memory. Try a smaller file or reduce concurrency.'
  },
  FILE_TOO_LARGE: {
    severity: 'warning',
    message: 'File too large to process with current limits.'
  },
  PERMISSION_DENIED: {
    severity: 'error',
    message: 'Permission denied. Check file access permissions.'
  },
  UNSUPPORTED_FORMAT: {
    severity: 'warning',
    message: 'Unsupported file format.'
  }
};

/**
 * Codes the file-operation handlers return (destinationPolicy.js,
 * fileOperationHandlers.js, batchOrganizeHandler.js). They are not AI codes,
 * so they live beside AI_ERROR_CODES rather than in it.
 */
const FILE_OPERATION_CODE_MAP = {
  DESTINATION_NOT_ALLOWED: {
    severity: 'warning',
    message:
      'That folder was not approved. Choose a Smart Folder, or pick the folder in a file dialog and allow it when asked.'
  },
  DESTINATION_AUTOSTART: {
    severity: 'error',
    message:
      'That folder runs its contents when you sign in, so StratoSort will not place files there.'
  },
  DESTINATION_UNC: {
    severity: 'warning',
    message: 'Network folders are allowed only inside a Smart Folder on that share.'
  },
  FILE_EXISTS: {
    severity: 'warning',
    message: 'A different file already exists at the destination.'
  },
  ABORTED: {
    severity: 'warning',
    message: 'The operation was cancelled before it finished.'
  }
};

/** @type {Record<string, { severity: string, message: string }>} */
const ERROR_CODE_MAP = {
  ...FILE_OPERATION_CODE_MAP,
  [AI_ERROR_CODES.LLAMA_MODEL_LOAD_FAILED]: {
    severity: 'error',
    message:
      'Could not load the AI model. Re-download it from Settings → Models, or switch to a smaller model if this keeps happening.'
  },
  [AI_ERROR_CODES.LLAMA_MODEL_NOT_FOUND]: {
    severity: 'error',
    message:
      'AI model file is missing. Open Settings → Models to install it, or run the model setup wizard from the welcome screen.'
  },
  [AI_ERROR_CODES.LLAMA_MODEL_INCOMPATIBLE_CPU]: {
    severity: 'error',
    message:
      'Your CPU does not support instructions required by this model (SIGILL). Switch to the small Qwen 0.5B profile in Settings → Models, or install a build matching your CPU.'
  },
  [AI_ERROR_CODES.LLAMA_MODEL_PATH_MISMATCH]: {
    severity: 'error',
    message:
      'Found an AI model file in the legacy install directory. Move it to the app data models folder, or rerun model setup to migrate it automatically.'
  },
  [AI_ERROR_CODES.LLAMA_MODEL_AUTO_FALLBACK]: {
    severity: 'warning',
    message:
      'The configured AI model was unavailable, so StratoSort switched to a smaller default model. Quality may be reduced — reinstall the preferred model from Settings → Models to restore it.'
  },
  [AI_ERROR_CODES.LLAMA_INFERENCE_FAILED]: {
    severity: 'error',
    message: 'AI inference failed. Please try again.'
  },
  [AI_ERROR_CODES.LLAMA_GPU_ERROR]: {
    severity: 'warning',
    message: 'GPU error detected. The app will retry using CPU.'
  },
  [AI_ERROR_CODES.LLAMA_OOM]: {
    severity: 'error',
    message: 'Out of memory. Try a smaller file or reduce concurrency.'
  },
  [AI_ERROR_CODES.VECTOR_DB_INIT_FAILED]: {
    severity: 'error',
    message: 'Vector database failed to initialize. Please restart the app.'
  },
  [AI_ERROR_CODES.VECTOR_DB_PERSIST_FAILED]: {
    severity: 'warning',
    message: 'Failed to save embeddings. Recent changes may not persist.'
  },
  [AI_ERROR_CODES.VECTOR_DB_QUERY_FAILED]: {
    severity: 'error',
    message: 'Search failed. Please try again.'
  },
  [AI_ERROR_CODES.VECTOR_DB_DIMENSION_MISMATCH]: {
    severity: 'warning',
    message: 'Embedding model changed. Rebuild embeddings in Settings.'
  },
  [AI_ERROR_CODES.EMBEDDING_GENERATION_FAILED]: {
    severity: 'error',
    message: 'Failed to generate embeddings. Please try again.'
  },
  [AI_ERROR_CODES.ANALYSIS_FAILED]: {
    severity: 'error',
    message: 'Analysis failed. Please try again.'
  },
  [AI_ERROR_CODES.MIGRATION_FAILED]: {
    severity: 'error',
    message: 'Migration failed. Please restart the app or check logs.'
  },
  // ── File-system codes surfaced at the IPC boundary ──
  [AI_ERROR_CODES.FILE_NOT_FOUND]: {
    severity: 'error',
    message: 'File not found. It may have been moved, renamed, or deleted.'
  },
  [AI_ERROR_CODES.FILE_ACCESS_DENIED]: {
    severity: 'error',
    message: 'Cannot access that file. Check its permissions and try again.'
  },
  [AI_ERROR_CODES.FILE_READ_ERROR]: {
    severity: 'error',
    message: 'Could not read the file. Make sure it is not open in another program.'
  },
  [AI_ERROR_CODES.FILE_WRITE_ERROR]: {
    severity: 'error',
    message: 'Could not write the file. Check disk space and permissions.'
  },
  [AI_ERROR_CODES.DIRECTORY_NOT_FOUND]: {
    severity: 'error',
    message: 'Folder not found. It may have been moved or deleted.'
  },
  [AI_ERROR_CODES.DIRECTORY_CREATION_FAILED]: {
    severity: 'error',
    message: 'Could not create that folder. Check parent permissions.'
  },
  [AI_ERROR_CODES.PATH_ACCESS_FAILED]: {
    severity: 'error',
    message: 'Cannot access that path. It may not exist or may be restricted.'
  },
  [AI_ERROR_CODES.PATH_NOT_DIRECTORY]: {
    severity: 'warning',
    message: 'The target path is not a folder.'
  },
  [AI_ERROR_CODES.RENAME_FAILED]: {
    severity: 'error',
    message: 'Could not rename the file. It may be locked by another process.'
  },
  // ── Availability / model state ──
  [AI_ERROR_CODES.MODEL_NOT_AVAILABLE]: {
    severity: 'warning',
    message: 'AI model is not ready. Wait for setup to finish or open Settings → Models.'
  },
  [AI_ERROR_CODES.INVALID_FILE_TYPE]: {
    severity: 'warning',
    message: 'This file type cannot be processed.'
  },
  // ── Validation ──
  [AI_ERROR_CODES.VALIDATION_ERROR]: {
    severity: 'warning',
    message: 'Request was invalid. Please check the form and try again.'
  },
  [AI_ERROR_CODES.INVALID_INPUT]: {
    severity: 'warning',
    message: 'One or more inputs were invalid. Please review and try again.'
  },
  [AI_ERROR_CODES.INVALID_PATH]: {
    severity: 'warning',
    message: 'That path is not valid.'
  },
  [AI_ERROR_CODES.INVALID_FOLDER_PATH]: {
    severity: 'warning',
    message: 'That folder path is not valid.'
  },
  [AI_ERROR_CODES.INVALID_FOLDER_ID]: {
    severity: 'warning',
    message: 'Folder reference is invalid. Reload the app and try again.'
  },
  [AI_ERROR_CODES.INVALID_FOLDER_DATA]: {
    severity: 'warning',
    message: 'Folder configuration is invalid. Please review the values and retry.'
  },
  [AI_ERROR_CODES.INVALID_FOLDER_NAME]: {
    severity: 'warning',
    message: 'Folder name is invalid.'
  },
  [AI_ERROR_CODES.INVALID_FOLDER_NAME_CHARS]: {
    severity: 'warning',
    message: 'Folder name contains characters your operating system cannot use.'
  },
  [AI_ERROR_CODES.FOLDER_NOT_FOUND]: {
    severity: 'error',
    message: 'Folder not found.'
  },
  [AI_ERROR_CODES.FOLDER_NAME_EXISTS]: {
    severity: 'warning',
    message: 'A folder with that name already exists. Choose a different name.'
  },
  [AI_ERROR_CODES.FOLDER_ALREADY_EXISTS]: {
    severity: 'warning',
    message: 'That folder already exists.'
  },
  [AI_ERROR_CODES.PARENT_NOT_WRITABLE]: {
    severity: 'error',
    message: 'Parent folder is not writable. Check permissions or choose another location.'
  },
  [AI_ERROR_CODES.PARENT_NOT_ACCESSIBLE]: {
    severity: 'error',
    message: 'Cannot access the parent folder.'
  },
  // ── Security ──
  [AI_ERROR_CODES.SECURITY_PATH_VIOLATION]: {
    severity: 'error',
    message: 'Refused: that path is outside the permitted locations.'
  },
  // ── Smart folder operations ──
  [AI_ERROR_CODES.SAVE_FAILED]: {
    severity: 'error',
    message: 'Save failed. Please try again.'
  },
  [AI_ERROR_CODES.UPDATE_FAILED]: {
    severity: 'error',
    message: 'Update failed. Please try again.'
  },
  [AI_ERROR_CODES.EDIT_FAILED]: {
    severity: 'error',
    message: 'Edit failed. Please try again.'
  },
  [AI_ERROR_CODES.DELETE_FAILED]: {
    severity: 'error',
    message: 'Delete failed. Please try again.'
  },
  [AI_ERROR_CODES.ADD_FOLDER_FAILED]: {
    severity: 'error',
    message: 'Could not add that folder. Please try again.'
  },
  [AI_ERROR_CODES.CONFIG_SAVE_FAILED]: {
    severity: 'error',
    message: 'Could not save configuration. Please try again.'
  },
  // ── Batch operations ──
  [AI_ERROR_CODES.BATCH_OPERATION_FAILED]: {
    severity: 'error',
    message: 'Batch operation failed. Some files may not have been processed.'
  },
  [AI_ERROR_CODES.PARTIAL_FAILURE]: {
    severity: 'warning',
    message: 'Some items in the batch failed. Review and retry the affected ones.'
  },
  [AI_ERROR_CODES.INVALID_BATCH]: {
    severity: 'warning',
    message: 'Batch is invalid.'
  },
  [AI_ERROR_CODES.EMPTY_BATCH]: {
    severity: 'warning',
    message: 'Nothing selected to process.'
  },
  [AI_ERROR_CODES.BATCH_TOO_LARGE]: {
    severity: 'warning',
    message: 'Too many items at once. Split the selection into smaller batches.'
  },
  [AI_ERROR_CODES.INVALID_OPERATION]: {
    severity: 'warning',
    message: 'That operation cannot be performed here.'
  },
  // ── Network ──
  [AI_ERROR_CODES.NETWORK_ERROR]: {
    severity: 'warning',
    message: 'Network error. Check your connection and try again.'
  },
  [AI_ERROR_CODES.TIMEOUT]: {
    severity: 'warning',
    message: 'Operation timed out. Please try again.'
  },
  [AI_ERROR_CODES.SERVICE_UNAVAILABLE]: {
    severity: 'warning',
    message: 'A service is temporarily unavailable. Please try again shortly.'
  },
  // ── Generic ──
  [AI_ERROR_CODES.UNKNOWN_ERROR]: {
    severity: 'error',
    message: 'Something went wrong. Please try again.'
  },
  [AI_ERROR_CODES.OPERATION_CANCELLED]: {
    severity: 'info',
    message: 'Operation cancelled.'
  },
  [AI_ERROR_CODES.QUEUE_FULL]: {
    severity: 'warning',
    message: 'The processing queue is full. Please wait for current work to finish.'
  }
};

/**
 * Category fallback for error codes that escape ERROR_CODE_MAP. Models routinely
 * emit ad-hoc codes (e.g. `FILE_LOCKED`, `EMBEDDING_TIMEOUT`) that have the same
 * prefix as a mapped code but don't have their own entry — previously these
 * fell through to the default "Operation failed." copy, which gave the user no
 * direction. Match on a stable family prefix so new codes in the same area
 * still get actionable copy without every one needing a hand-written entry.
 *
 * Order matters: more specific prefixes first.
 */
const CODE_CATEGORY_FALLBACKS = [
  {
    test: (/** @type {any} */ c) => c.startsWith('LLAMA_'),
    entry: ERROR_CODE_MAP[AI_ERROR_CODES.LLAMA_INFERENCE_FAILED]
  },
  {
    test: (/** @type {any} */ c) => c.startsWith('VECTOR_'),
    entry: ERROR_CODE_MAP[AI_ERROR_CODES.VECTOR_DB_QUERY_FAILED]
  },
  {
    test: (/** @type {any} */ c) => c.startsWith('EMBED_'),
    entry: ERROR_CODE_MAP[AI_ERROR_CODES.EMBEDDING_GENERATION_FAILED]
  },
  {
    test: (/** @type {any} */ c) => c.includes('BATCH'),
    entry: ERROR_CODE_MAP[AI_ERROR_CODES.BATCH_OPERATION_FAILED]
  },
  {
    test: (/** @type {any} */ c) => c.includes('FOLDER'),
    entry: ERROR_CODE_MAP[AI_ERROR_CODES.FOLDER_NOT_FOUND]
  },
  {
    test: (/** @type {any} */ c) => c.includes('DIRECTORY') || c.includes('PATH'),
    entry: ERROR_CODE_MAP[AI_ERROR_CODES.PATH_ACCESS_FAILED]
  },
  {
    test: (/** @type {any} */ c) => c.includes('FILE'),
    entry: ERROR_CODE_MAP[AI_ERROR_CODES.FILE_READ_ERROR]
  },
  {
    test: (/** @type {any} */ c) => c.includes('VALIDATION') || c.startsWith('INVALID_'),
    entry: ERROR_CODE_MAP[AI_ERROR_CODES.VALIDATION_ERROR]
  },
  {
    test: (/** @type {any} */ c) => c.includes('NETWORK') || c.includes('TIMEOUT'),
    entry: ERROR_CODE_MAP[AI_ERROR_CODES.NETWORK_ERROR]
  },
  {
    test: (/** @type {any} */ c) => c.includes('SECURITY'),
    entry: ERROR_CODE_MAP[AI_ERROR_CODES.SECURITY_PATH_VIOLATION]
  },
  {
    test: (/** @type {any} */ c) => c.endsWith('_FAILED'),
    entry: ERROR_CODE_MAP[AI_ERROR_CODES.SAVE_FAILED]
  }
];

function resolveCategoryFallback(/** @type {any} */ code) {
  if (typeof code !== 'string' || !code) return null;
  for (const { test, entry } of CODE_CATEGORY_FALLBACKS) {
    if (test(code) && entry) return entry;
  }
  return null;
}

/**
 * Classify raw error strings into known error types.
 */
function classifyError(/** @type {any} */ errorStr) {
  if (!errorStr || typeof errorStr !== 'string') return null;
  if (errorStr.includes('IPC timeout')) return 'IPC_TIMEOUT';
  if (errorStr.includes('Rate limit exceeded')) return 'RATE_LIMITED';
  // CircuitBreaker.execute throws "Circuit breaker is OPEN for llama-text";
  // compare case-insensitively and accept both spellings.
  const lower = errorStr.toLowerCase();
  if (
    lower.includes('circuit breaker is open') ||
    lower.includes('circuit breaker open') ||
    lower.includes('temporarily unavailable')
  )
    return 'CIRCUIT_OPEN';
  if (errorStr.includes('No handler registered')) return 'HANDLER_NOT_READY';
  if (errorStr.includes('timed out')) return 'TIMEOUT';
  return null;
}

/**
 * Detect Llama-specific error signatures that weren't tagged with an error
 * code at the main-process boundary. Returns a mapped entry so both free-form
 * strings and structured Error objects resolve to the same actionable copy.
 */
function classifyLlamaCodeFromErrorShape(/** @type {any} */ error) {
  if (looksLikeCpuIncompatibility(error)) return AI_ERROR_CODES.LLAMA_MODEL_INCOMPATIBLE_CPU;
  if (looksLikeModelNotFound(error)) return AI_ERROR_CODES.LLAMA_MODEL_NOT_FOUND;
  return null;
}

/**
 * True when an error is the preload SecureIPC invoke timeout (message shape:
 * "IPC timeout after <ms>ms for channel: <channel>"). Long-running main-side
 * jobs (e.g. embeddings full rebuild) KEEP RUNNING after this fires — callers
 * should present "still running in the background", not a failure.
 */
export function isIpcTimeoutError(/** @type {any} */ error) {
  const msg = typeof error === 'string' ? error : error?.message;
  return typeof msg === 'string' && msg.includes('IPC timeout');
}

/**
 * Normalize an IPC error payload to a render-safe string. Handlers return the
 * standardized `{ code, message, details }` envelope on failure; rendering
 * that object directly as a JSX child crashes React (minified error #31).
 * Accepts strings, Error instances, and envelope objects.
 */
export function toErrorMessage(/** @type {any} */ error, fallback = 'Operation failed.') {
  if (typeof error === 'string' && error.trim()) return error;
  if (typeof error?.message === 'string' && error.message.trim()) return error.message;
  return fallback;
}

/**
 * @param {{ error?: any, errorType?: string, errorCode?: string, operationType?: string }} [args]
 */
export function mapErrorToNotification({ error, errorType, errorCode, operationType } = {}) {
  const typeKey = typeof errorType === 'string' ? errorType.toUpperCase() : null;
  const explicitCodeKey =
    typeof errorCode === 'string'
      ? errorCode
      : typeof error?.code === 'string'
        ? error.code
        : typeof error?.errorCode === 'string'
          ? error.errorCode
          : null;
  // If an explicit code was provided, prefer it; otherwise sniff the error
  // shape/message for a Llama-specific signature before falling back to the
  // generic classifier. This lets actionable Llama copy win when the main
  // process forwarded a bare Error across IPC.
  const codeKey = explicitCodeKey || classifyLlamaCodeFromErrorShape(error);
  const inferred = !typeKey
    ? classifyError(typeof error === 'string' ? error : error?.message)
    : null;
  const codeMap = /** @type {Record<string, any>} */ (ERROR_CODE_MAP);
  const typeMap = /** @type {Record<string, any>} */ (ERROR_TYPE_MAP);
  const mapped =
    (codeKey ? codeMap[codeKey] : null) ||
    (typeKey ? typeMap[typeKey] : null) ||
    (inferred ? typeMap[inferred] : null) ||
    (codeKey ? resolveCategoryFallback(codeKey) : null);
  const rawMessage =
    typeof error === 'string'
      ? error.trim()
      : typeof error?.message === 'string'
        ? error.message.trim()
        : '';
  const baseMessage = mapped?.message || rawMessage || 'Operation failed.';
  const severity = mapped?.severity || DEFAULT_NOTIFICATION.severity;
  const prefix = operationType ? `${operationType} failed: ` : '';
  return {
    message: `${prefix}${baseMessage}`,
    severity,
    duration: DEFAULT_NOTIFICATION.duration
  };
}
