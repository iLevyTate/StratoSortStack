// @ts-check
/**
 * Error Classifier Utility
 *
 * Centralizes error classification logic for consistent error handling across the codebase.
 * Provides helpers for classifying system errors, determining retryability, and generating
 * user-friendly messages.
 *
 * @module shared/errorClassifier
 */

/**
 * @typedef {{ code?: string, message?: string }} ClassifiableError
 */

/**
 * Error categories for classification
 */
const ErrorCategory = {
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  FILE_EXISTS: 'FILE_EXISTS',
  FILE_IN_USE: 'FILE_IN_USE',
  DISK_FULL: 'DISK_FULL',
  PATH_TOO_LONG: 'PATH_TOO_LONG',
  DIRECTORY_NOT_EMPTY: 'DIRECTORY_NOT_EMPTY',
  CROSS_DEVICE: 'CROSS_DEVICE',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  IO_ERROR: 'IO_ERROR',
  PROCESS_NOT_FOUND: 'PROCESS_NOT_FOUND',
  UNKNOWN: 'UNKNOWN'
};

/**
 * System error codes and their categories
 */
const ERROR_CODE_MAP = {
  // File system errors
  ENOENT: ErrorCategory.FILE_NOT_FOUND,
  EACCES: ErrorCategory.PERMISSION_DENIED,
  EPERM: ErrorCategory.PERMISSION_DENIED,
  EEXIST: ErrorCategory.FILE_EXISTS,
  EBUSY: ErrorCategory.FILE_IN_USE,
  ENOSPC: ErrorCategory.DISK_FULL,
  EDQUOT: ErrorCategory.DISK_FULL, // Linux disk quota exceeded
  ENAMETOOLONG: ErrorCategory.PATH_TOO_LONG,
  ENOTEMPTY: ErrorCategory.DIRECTORY_NOT_EMPTY,
  EXDEV: ErrorCategory.CROSS_DEVICE,
  EIO: ErrorCategory.IO_ERROR,

  // Network errors
  ECONNREFUSED: ErrorCategory.NETWORK_ERROR,
  ECONNRESET: ErrorCategory.NETWORK_ERROR,
  ENOTFOUND: ErrorCategory.NETWORK_ERROR,
  ENETUNREACH: ErrorCategory.NETWORK_ERROR,
  EHOSTUNREACH: ErrorCategory.NETWORK_ERROR,
  ETIMEDOUT: ErrorCategory.TIMEOUT,

  // Process errors
  ESRCH: ErrorCategory.PROCESS_NOT_FOUND
};

/**
 * User-friendly messages for error categories
 */
const USER_MESSAGES = {
  [ErrorCategory.FILE_NOT_FOUND]: 'File or directory not found',
  [ErrorCategory.PERMISSION_DENIED]: 'Permission denied - check file permissions',
  [ErrorCategory.FILE_EXISTS]: 'Destination file already exists',
  [ErrorCategory.FILE_IN_USE]: 'File is currently in use by another process',
  [ErrorCategory.DISK_FULL]: 'Insufficient disk space',
  [ErrorCategory.PATH_TOO_LONG]: 'File path is too long',
  [ErrorCategory.DIRECTORY_NOT_EMPTY]: 'Directory is not empty',
  [ErrorCategory.CROSS_DEVICE]: 'Cannot move across different drives',
  [ErrorCategory.NETWORK_ERROR]: 'Network connection error',
  [ErrorCategory.TIMEOUT]: 'Operation timed out',
  [ErrorCategory.IO_ERROR]: 'Disk I/O error',
  [ErrorCategory.PROCESS_NOT_FOUND]: 'Process not found',
  [ErrorCategory.UNKNOWN]: 'An unexpected error occurred'
};

/**
 * Error codes that indicate the operation can be retried
 */
const RETRYABLE_CODES = new Set([
  'EBUSY', // File in use - might be released
  'EPERM', // Windows file lock - might be released
  'ETIMEDOUT', // Network timeout - might succeed on retry
  'ECONNRESET', // Connection reset - might succeed on retry
  'ECONNREFUSED', // Connection refused - external service might start (not used for in-process AI)
  'EIO' // I/O error - might be transient
]);

/**
 * Error codes that indicate a transient network issue
 */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT'
]);

/**
 * Error codes that indicate file system permission issues
 */
const PERMISSION_ERROR_CODES = new Set(['EACCES', 'EPERM']);

/**
 * Get the error category for an error
 *
 * @param {ClassifiableError|null|undefined} error - The error to classify
 * @returns {string} Error category from ErrorCategory
 */
function getErrorCategory(error) {
  if (!error) {
    return ErrorCategory.UNKNOWN;
  }

  // Check error code first
  if (error.code && /** @type {Record<string,string>} */ (ERROR_CODE_MAP)[error.code]) {
    return /** @type {Record<string,string>} */ (ERROR_CODE_MAP)[error.code];
  }

  // Check message for common patterns
  const message = error.message?.toLowerCase() || '';

  if (message.includes('timeout') || message.includes('timed out')) {
    return ErrorCategory.TIMEOUT;
  }

  // Narrowed match: avoid false positives from AI/in-process "connection" errors
  if (
    message.includes('network') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ECONNRESET')
  ) {
    return ErrorCategory.NETWORK_ERROR;
  }

  if (message.includes('permission') || message.includes('access denied')) {
    return ErrorCategory.PERMISSION_DENIED;
  }

  if (message.includes('not found') || message.includes('no such file')) {
    return ErrorCategory.FILE_NOT_FOUND;
  }

  if (message.includes('disk full') || message.includes('no space')) {
    return ErrorCategory.DISK_FULL;
  }

  return ErrorCategory.UNKNOWN;
}

/**
 * Get a user-friendly error message
 *
 * @param {ClassifiableError|null|undefined} error - The error
 * @param {string} context - Optional context (e.g., 'file', 'folder', 'connection')
 * @returns {string} User-friendly error message
 */
function getUserMessage(error, context = '') {
  const category = getErrorCategory(error);
  let message = USER_MESSAGES[category] || USER_MESSAGES[ErrorCategory.UNKNOWN];

  // Customize message based on context
  if (context) {
    switch (category) {
      case ErrorCategory.FILE_NOT_FOUND:
        message = `${context.charAt(0).toUpperCase() + context.slice(1)} not found`;
        break;
      case ErrorCategory.PERMISSION_DENIED:
        message = `Permission denied - cannot access ${context}`;
        break;
      case ErrorCategory.FILE_IN_USE:
        message = `${context.charAt(0).toUpperCase() + context.slice(1)} is currently in use`;
        break;
    }
  }

  return message;
}

/**
 * Check if an error is retryable
 *
 * @param {ClassifiableError|null|undefined} error - The error to check
 * @returns {boolean} True if the error is potentially retryable
 */
function isRetryable(error) {
  if (!error) return false;

  // Check by error code
  if (error.code && RETRYABLE_CODES.has(error.code)) {
    return true;
  }

  // Check by message for timeout-like errors
  const message = error.message?.toLowerCase() || '';
  if (message.includes('timeout') || message.includes('timed out')) {
    return true;
  }

  return false;
}

/**
 * Check if an error is a network-related error
 *
 * @param {ClassifiableError|null|undefined} error - The error to check
 * @returns {boolean} True if the error is network-related
 */
function isNetworkError(error) {
  if (!error) return false;

  if (error.code && NETWORK_ERROR_CODES.has(error.code)) {
    return true;
  }

  const message = error.message?.toLowerCase() || '';
  return (
    message.includes('network') ||
    message.includes('econnrefused') ||
    message.includes('econnreset')
  );
}

/**
 * Check if an error is a permission error
 *
 * @param {ClassifiableError|null|undefined} error - The error to check
 * @returns {boolean} True if the error is permission-related
 */
function isPermissionError(error) {
  if (!error) return false;

  if (error.code && PERMISSION_ERROR_CODES.has(error.code)) {
    return true;
  }

  const message = error.message?.toLowerCase() || '';
  return message.includes('permission') || message.includes('access denied');
}

/**
 * Check if an error indicates the file/resource doesn't exist
 *
 * @param {ClassifiableError|null|undefined} error - The error to check
 * @returns {boolean} True if the error indicates resource doesn't exist
 */
function isNotFoundError(error) {
  if (!error) return false;

  if (error.code === 'ENOENT') {
    return true;
  }

  const message = error.message?.toLowerCase() || '';
  return message.includes('not found') || message.includes('no such file');
}

/**
 * Check if an error indicates a cross-device operation
 *
 * @param {ClassifiableError|null|undefined} error - The error to check
 * @returns {boolean} True if the error is a cross-device error
 */
function isCrossDeviceError(error) {
  return error?.code === 'EXDEV';
}

/**
 * Check if an error indicates the file already exists
 *
 * @param {ClassifiableError|null|undefined} error - The error to check
 * @returns {boolean} True if the error indicates file exists
 */
function isExistsError(error) {
  return error?.code === 'EEXIST';
}

/**
 * Check if an error indicates a critical/unrecoverable issue
 * These errors typically require user intervention
 *
 * @param {ClassifiableError|null|undefined} error - The error to check
 * @returns {boolean} True if the error is critical
 */
function isCriticalError(error) {
  if (!error) return false;

  const category = getErrorCategory(error);
  return [
    ErrorCategory.PERMISSION_DENIED,
    ErrorCategory.DISK_FULL,
    ErrorCategory.IO_ERROR
  ].includes(category);
}

/**
 * Classify an error and return comprehensive information
 *
 * @param {ClassifiableError|null|undefined} error - The error to classify
 * @param {{context?: string}} [options] - Options
 * @returns {Object} Classification result
 */
function classifyError(error, options = {}) {
  const { context = '' } = options;

  return {
    category: getErrorCategory(error),
    userMessage: getUserMessage(error, context),
    isRetryable: isRetryable(error),
    isNetworkError: isNetworkError(error),
    isPermissionError: isPermissionError(error),
    isNotFoundError: isNotFoundError(error),
    isCriticalError: isCriticalError(error),
    originalMessage: error?.message || 'Unknown error',
    code: error?.code || null
  };
}

module.exports = {
  // Categories
  ErrorCategory,

  // Main classification functions
  getErrorCategory,
  getUserMessage,
  classifyError,

  // Type checkers
  isRetryable,
  isNetworkError,
  isPermissionError,
  isNotFoundError,
  isCrossDeviceError,
  isExistsError,
  isCriticalError
};
