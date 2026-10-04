// @ts-check
/**
 * Centralized Error Handling Utilities
 * Provides reusable error handling patterns across the application.
 *
 * Note: Core async utilities (withTimeout, withRetry) are consolidated in
 * promiseUtils.js. This module re-exports withRetry for backward compatibility
 * and provides error-specific utilities.
 *
 * @module shared/errorHandlingUtils
 */

const { withRetry: consolidatedWithRetry } = require('./promiseUtils');
// Single source of truth for all error codes — see errorCodes.js
const { ERROR_CODES } = require('./errorCodes');
// Pull correlationId from AsyncLocalStorage when available. Required so the
// renderer can cross-reference a failing IPC response against a specific log
// line without having to scrape the user's journal by message substring.
/** @type {(()=>string|undefined)|null} */
let _getCorrelationId;
try {
  ({ getCorrelationId: _getCorrelationId } = require('./correlationId'));
} catch {
  _getCorrelationId = null;
}

/**
 * Standard error response structure
 * @typedef {Object} ErrorResponse
 * @property {boolean} success - Always false for errors
 * @property {string} error - Error message
 * @property {string} [code] - Error code for programmatic handling
 * @property {Object} [details] - Additional error context
 */

/**
 * Standard success response structure
 * @typedef {Object} SuccessResponse
 * @property {boolean} success - Always true for success
 * @property {*} data - Response data
 */

/**
 * @typedef {Object} ErrorLike
 * @property {string} [message]
 * @property {string} [name]
 * @property {string} [code]
 * @property {string} [errorCode]
 * @property {unknown[]} [validationErrors]
 * @property {unknown[]} [validationWarnings]
 */

/**
 * @typedef {{ [key: string]: unknown, debug?: (...args: any[]) => void, warn?: (...args: any[]) => void, error?: (...args: any[]) => void, info?: (...args: any[]) => void }} LoggerLike
 */

/**
 * Creates a standardized success response
 * @param {*} data - Response data
 * @returns {SuccessResponse}
 */
function createSuccessResponse(data) {
  return {
    success: true,
    data
  };
}

/**
 * Create standardized error response
 * @param {ErrorLike|null|undefined} error - Error object or error-like object
 * @param {Record<string,unknown>} [context] - Additional context to include
 * @returns {Object} Standardized error response
 */
function createErrorResponse(error, context = {}) {
  const errorMessage = error?.message || String(error || 'Unknown error');
  const errorName = error?.name || 'Error';
  const errorCode = error?.code || error?.errorCode || ERROR_CODES.UNKNOWN_ERROR;

  // Attach the active correlation id so the renderer-side toast / log line can
  // be matched against the JSONL backend log without the user copy/pasting the
  // error message. Only attached when running inside a withCorrelationId
  // scope — outside of one (e.g. a renderer-local validator) we simply skip.
  const correlationId = typeof _getCorrelationId === 'function' ? _getCorrelationId() : undefined;

  const details = {
    errorType: errorName,
    ...(correlationId ? { correlationId } : {}),
    ...context,
    ...(error?.validationErrors && {
      validationErrors: error.validationErrors
    }),
    ...(error?.validationWarnings && {
      validationWarnings: error.validationWarnings
    })
  };

  return {
    success: false,
    error: {
      code: errorCode,
      message: errorMessage,
      details: Object.keys(details).length > 1 ? details : undefined
    }
  };
}

/**
 * Retry wrapper with exponential backoff.
 * Re-exported from promiseUtils for backward compatibility.
 *
 * @param {Function} fn - Function to retry
 * @param {Object} options - Retry options
 * @returns {Function} Wrapped function with retry logic
 * @see module:shared/promiseUtils.withRetry
 */
const withRetry = consolidatedWithRetry;

/**
 * Log an error when using a fallback value and return the fallback.
 * This helper standardizes logging for catch blocks that use fallback values,
 * making otherwise silent failures visible for debugging.
 *
 * @param {LoggerLike} logger - Logger instance with debug/warn methods
 * @param {string} context - Context identifier (e.g., 'DocumentExtractor', 'LlamaUtils')
 * @param {string} operation - Description of the operation that failed
 * @param {ErrorLike|string} error - The caught error or error message
 * @param {*} fallbackValue - The fallback value to return
 * @param {{level?: string}} [options] - Additional options
 * @returns {*} The fallback value
 *
 * @example
 * // In a catch block:
 * catch (error) {
 *   return logFallback(logger, 'DocumentExtractor', 'extractTextFromDoc', error, '');
 * }
 *
 * // With warn level:
 * catch (error) {
 *   return logFallback(logger, 'LlamaUtils', 'loadConfig', error, {}, { level: 'warn' });
 * }
 */
function logFallback(logger, context, operation, error, fallbackValue, options = {}) {
  const { level = 'debug' } = options;
  const anyErr = /** @type {any} */ (error);
  const errorMessage = anyErr?.message || (typeof error === 'string' ? error : 'Unknown error');
  const fallbackDisplay =
    typeof fallbackValue === 'object'
      ? Array.isArray(fallbackValue)
        ? `[array(${fallbackValue.length})]`
        : '[object]'
      : String(fallbackValue);

  const logMessage = `[${context}] ${operation} failed, using fallback`;
  /** @type {Record<string,unknown>} */
  const logDetails = {
    error: errorMessage,
    fallback: fallbackDisplay
  };

  // Add error code if available
  if (anyErr?.code) {
    logDetails.errorCode = anyErr.code;
  }

  // Call appropriate log level
  if (logger && typeof logger[level] === 'function') {
    logger[level](logMessage, logDetails);
  } else if (logger && typeof logger.debug === 'function') {
    // Fallback to debug if specified level not available
    logger.debug(logMessage, logDetails);
  }

  return fallbackValue;
}

/**
 * Safely extracts an error message from any type of error.
 * Handles Error objects, strings, objects with message property, and unknown types.
 *
 * FIX: Prevents issues when error is not an Error object (e.g., string, null, object)
 *
 * @param {*} error - The error to extract message from
 * @param {string} [fallback='Unknown error'] - Fallback message if extraction fails
 * @returns {string} The error message
 *
 * @example
 * // Works with Error objects
 * getErrorMessage(new Error('Something failed')) // 'Something failed'
 *
 * // Works with strings
 * getErrorMessage('Connection refused') // 'Connection refused'
 *
 * // Works with objects
 * getErrorMessage({ message: 'API error', code: 500 }) // 'API error'
 *
 * // Handles null/undefined
 * getErrorMessage(null) // 'Unknown error'
 */
function getErrorMessage(error, fallback = 'Unknown error') {
  if (error === null || error === undefined) {
    return fallback;
  }

  if (typeof error === 'string') {
    return error || fallback;
  }

  if (error instanceof Error) {
    return error.message || fallback;
  }

  if (typeof error === 'object') {
    // Try common error message properties
    if (typeof error.message === 'string') {
      return error.message || fallback;
    }
    if (typeof error.error === 'string') {
      return error.error || fallback;
    }
    if (typeof error.msg === 'string') {
      return error.msg || fallback;
    }
    // Try to stringify as last resort
    try {
      const str = JSON.stringify(error);
      return str !== '{}' ? str : fallback;
    } catch {
      return fallback;
    }
  }

  // For numbers, booleans, etc.
  try {
    return String(error) || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Safely attach an error code to an error object.
 * If the error is not an object, wraps it in a new Error.
 * Preserves any existing error code to avoid masking the root cause.
 *
 * @param {*} error - The error (or error-like value) to attach a code to
 * @param {string} code - The error code to attach
 * @returns {Error} The error object with the code attached
 */
function attachErrorCode(error, code) {
  if (error && typeof error === 'object') {
    const errObj = /** @type {Record<string,unknown>} */ (error);
    if (!errObj.code) {
      errObj.code = code;
    }
    return /** @type {Error} */ (error);
  }
  const wrapped = new Error(String(error || 'Unknown error'));
  /** @type {any} */ (wrapped).code = code;
  return wrapped;
}

module.exports = {
  ERROR_CODES,
  createErrorResponse,
  createSuccessResponse,
  withRetry,
  logFallback,
  getErrorMessage,
  attachErrorCode
};
