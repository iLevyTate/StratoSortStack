// @ts-check
/**
 * Canonical Error Codes — Single Source of Truth
 *
 * All error codes used across the application are defined here.
 * Other modules (errorHandlingUtils.js, IPC handlers, services) should
 * import from this file instead of defining their own ERROR_CODES.
 *
 * @module shared/errorCodes
 */

const ERROR_CODES = {
  // ── LLM / AI Service Errors ──
  LLAMA_MODEL_LOAD_FAILED: 'LLAMA_001',
  LLAMA_MODEL_NOT_FOUND: 'LLAMA_002',
  LLAMA_INFERENCE_FAILED: 'LLAMA_003',
  LLAMA_GPU_ERROR: 'LLAMA_004',
  LLAMA_OOM: 'LLAMA_005',
  // Native addon crashed with SIGILL / "illegal instruction" — the prebuilt
  // node-llama-cpp binary uses CPU instructions the host doesn't support, or
  // the Electron ABI mismatches. Surface actionable copy pointing at the
  // small-model fallback.
  LLAMA_MODEL_INCOMPATIBLE_CPU: 'LLAMA_006',
  // Model filename is configured but does not exist at the expected userData
  // path (e.g. still sitting in the legacy postinstall models directory).
  LLAMA_MODEL_PATH_MISMATCH: 'LLAMA_007',
  // Configured model was missing; LlamaService auto-switched to the default
  // model. Raised as a degraded-state warning so the renderer can surface it.
  LLAMA_MODEL_AUTO_FALLBACK: 'LLAMA_008',

  // ── Vector DB Errors ──
  VECTOR_DB_INIT_FAILED: 'VECTOR_001',
  VECTOR_DB_PERSIST_FAILED: 'VECTOR_002',
  VECTOR_DB_QUERY_FAILED: 'VECTOR_003',
  VECTOR_DB_DIMENSION_MISMATCH: 'VECTOR_004',

  // ── Embedding / Analysis Errors ──
  EMBEDDING_GENERATION_FAILED: 'EMBED_001',
  ANALYSIS_FAILED: 'ANALYSIS_FAILED',
  // The media file has no audio stream to transcribe (a silent screen
  // recording). A property of the file, not a failure, so never retried.
  MEDIA_NO_AUDIO_STREAM: 'MEDIA_NO_AUDIO_STREAM',
  MODEL_NOT_AVAILABLE: 'MODEL_NOT_AVAILABLE',
  INVALID_FILE_TYPE: 'INVALID_FILE_TYPE',

  // ── Migration Errors ──
  MIGRATION_FAILED: 'MIGRATION_001',

  // ── File System Errors ──
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  FILE_ACCESS_DENIED: 'FILE_ACCESS_DENIED',
  FILE_READ_ERROR: 'FILE_READ_ERROR',
  FILE_WRITE_ERROR: 'FILE_WRITE_ERROR',
  DIRECTORY_NOT_FOUND: 'DIRECTORY_NOT_FOUND',
  DIRECTORY_CREATION_FAILED: 'DIRECTORY_CREATION_FAILED',
  PATH_ACCESS_FAILED: 'PATH_ACCESS_FAILED',
  PATH_NOT_DIRECTORY: 'PATH_NOT_DIRECTORY',
  PARENT_NOT_DIRECTORY: 'PARENT_NOT_DIRECTORY',
  ORIGINAL_NOT_DIRECTORY: 'ORIGINAL_NOT_DIRECTORY',
  RENAME_FAILED: 'RENAME_FAILED',

  // ── Validation Errors ──
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_PATH: 'INVALID_PATH',
  INVALID_FOLDER_PATH: 'INVALID_FOLDER_PATH',
  INVALID_FOLDER_ID: 'INVALID_FOLDER_ID',
  INVALID_FOLDER_DATA: 'INVALID_FOLDER_DATA',
  INVALID_FOLDER_NAME: 'INVALID_FOLDER_NAME',
  INVALID_FOLDER_NAME_CHARS: 'INVALID_FOLDER_NAME_CHARS',
  FOLDER_NOT_FOUND: 'FOLDER_NOT_FOUND',
  FOLDER_NAME_EXISTS: 'FOLDER_NAME_EXISTS',
  FOLDER_ALREADY_EXISTS: 'FOLDER_ALREADY_EXISTS',
  // Returned when the proposed name is canonically equivalent to an existing
  // folder (token-subset match, e.g. "Logos and Graphic Design" when "Logos"
  // already exists). The UI should offer "use existing" rather than silently
  // creating duplicates that confuse the embedding-based matcher.
  FOLDER_NAME_EQUIVALENT: 'FOLDER_NAME_EQUIVALENT',
  PARENT_NOT_WRITABLE: 'PARENT_NOT_WRITABLE',
  PARENT_NOT_ACCESSIBLE: 'PARENT_NOT_ACCESSIBLE',

  // ── Security Errors ──
  SECURITY_PATH_VIOLATION: 'SECURITY_PATH_VIOLATION',

  // ── Smart Folder Operation Errors ──
  SAVE_FAILED: 'SAVE_FAILED',
  UPDATE_FAILED: 'UPDATE_FAILED',
  EDIT_FAILED: 'EDIT_FAILED',
  DELETE_FAILED: 'DELETE_FAILED',
  ADD_FOLDER_FAILED: 'ADD_FOLDER_FAILED',
  CONFIG_SAVE_FAILED: 'CONFIG_SAVE_FAILED',
  RESET_FAILED: 'RESET_FAILED',

  // ── Batch Operation Errors ──
  BATCH_OPERATION_FAILED: 'BATCH_OPERATION_FAILED',
  PARTIAL_FAILURE: 'PARTIAL_FAILURE',
  INVALID_BATCH: 'INVALID_BATCH',
  EMPTY_BATCH: 'EMPTY_BATCH',
  BATCH_TOO_LARGE: 'BATCH_TOO_LARGE',
  BATCH_LOCK_TIMEOUT: 'BATCH_LOCK_TIMEOUT',
  INVALID_OPERATION: 'INVALID_OPERATION',

  // ── Network Errors ──
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',

  // ── Generic Errors ──
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  OPERATION_CANCELLED: 'OPERATION_CANCELLED',
  QUEUE_FULL: 'QUEUE_FULL'
};

module.exports = { ERROR_CODES };
