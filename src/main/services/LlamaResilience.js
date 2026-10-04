// @ts-check
// src/main/services/LlamaResilience.js

const { createLogger } = require('../../shared/logger');
const { withRetry } = require('../../shared/errorHandlingUtils');
const { delay } = require('../../shared/promiseUtils');
const { CircuitBreaker } = require('../utils/CircuitBreaker');

const logger = createLogger('LlamaResilience');

/**
 * Per-model-type circuit breakers.
 * Separate breakers prevent a text model failure from blocking embedding operations.
 * @type {Map<string, CircuitBreaker>}
 */
const _circuitBreakers = new Map();

/** @type {{ failureThreshold: number, successThreshold: number, timeout: number, resetTimeout: number }} */
const LLAMA_BREAKER_CONFIG = {
  failureThreshold: 5, // Open after 5 consecutive complete failures
  successThreshold: 2, // 2 successes in HALF_OPEN to close
  timeout: 300000, // 300s (5m) before probing recovery (increased for CPU fallback)
  resetTimeout: 300000 // Reset failure count after 300s of no failures
};

/**
 * Get or create a circuit breaker for the given model type.
 * @param {string} modelType - 'text' | 'vision' | 'embedding'
 * @returns {CircuitBreaker}
 */
function _getCircuitBreaker(modelType) {
  if (!_circuitBreakers.has(modelType)) {
    _circuitBreakers.set(modelType, new CircuitBreaker(`llama-${modelType}`, LLAMA_BREAKER_CONFIG));
  }
  return _circuitBreakers.get(modelType);
}

/**
 * Expected business/control-flow failures that should NOT trip the circuit breaker.
 * These represent caller cancellations, missing models, corrupt inputs, etc. rather
 * than backend health degradation. Allowing them to count as circuit breaker failures
 * causes blackouts after harmless scenarios like queued request cancellation.
 */
const NON_TRANSIENT_ERROR_PATTERNS = [
  'model not found',
  'model file not found',
  'not found',
  'invalid gguf',
  'corrupted',
  'bad magic',
  'no model',
  'download',
  'unsupported image format',
  'zero length image',
  'invalid image',
  // The memory manager refusing a load is a sizing decision, not a backend
  // fault. Five refusals in a row used to open the text breaker for 300 s.
  'memory budget exceeded'
];

const ABORT_ERROR_PATTERNS = [
  'operation aborted',
  'this operation was aborted',
  'cancelled',
  'canceled',
  'aborted while queued',
  'aborted before queuing'
];

const NON_TRANSIENT_ERROR_CODES = new Set([
  'LLAMA_001', // LLAMA_MODEL_LOAD_FAILED
  'LLAMA_002', // LLAMA_MODEL_NOT_FOUND
  'MODEL_MEMORY_BUDGET_EXCEEDED' // ModelMemoryManager refused the load
]);

function getErrorMessages(/** @type {any} */ error) {
  const messages = new Set();
  let current = error;

  while (current && typeof current === 'object') {
    if (typeof current.message === 'string' && current.message.trim()) {
      messages.add(current.message.toLowerCase());
    }
    current = current.originalError;
  }

  return Array.from(messages);
}

function isAbortLikeError(/** @type {any} */ error) {
  let current = error;

  while (current && typeof current === 'object') {
    if (current.name === 'AbortError') {
      return true;
    }
    current = current.originalError;
  }

  return getErrorMessages(error).some((message) =>
    ABORT_ERROR_PATTERNS.some((pattern) => message.includes(pattern))
  );
}

/**
 * Check if an error is non-transient (should NOT count against circuit breaker)
 */
function isNonTransientError(/** @type {any} */ error) {
  // Check error code first (most reliable)
  const code = error?.code || error?.originalError?.code;
  if (code && NON_TRANSIENT_ERROR_CODES.has(code)) return true;

  return (
    isAbortLikeError(error) ||
    getErrorMessages(error).some((message) =>
      NON_TRANSIENT_ERROR_PATTERNS.some((pattern) => message.includes(pattern))
    )
  );
}

/**
 * Errors that indicate we should retry
 */
const RETRYABLE_LLAMA_ERRORS = [
  'context allocation failed',
  'failed to create context',
  'memory allocation failed',
  'gpu memory',
  'vram',
  'cuda',
  'metal',
  'timeout',
  'busy'
];

/**
 * Errors that indicate we should fall back to CPU
 */
const GPU_FALLBACK_ERRORS = [
  'cuda out of memory',
  'metal error',
  'vulkan error',
  'vk_error',
  'cuda error',
  'gpu not available',
  'no metal device',
  'unable to allocate',
  'failed to allocate',
  'buffer allocation failed',
  'not enough vram',
  'available vram',
  'context size of'
];

const TRANSIENT_GPU_ERROR_PATTERNS = [
  'metal error',
  'vulkan error',
  'vk_error',
  'cuda error',
  'driver',
  'busy'
];

/**
 * Check if error is retryable
 */
function isRetryableLlamaError(/** @type {any} */ error) {
  const message = (error.message || '').toLowerCase();
  return RETRYABLE_LLAMA_ERRORS.some((pattern) => message.includes(pattern));
}

/**
 * Check if error suggests GPU fallback
 */
function shouldFallbackToCPU(/** @type {any} */ error) {
  const message = (error.message || '').toLowerCase();
  return GPU_FALLBACK_ERRORS.some((pattern) => message.includes(pattern));
}

function isTransientGpuError(/** @type {any} */ error) {
  const message = (error?.message || '').toLowerCase();
  return TRANSIENT_GPU_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

/**
 * Core retry + GPU-fallback logic, separated from the circuit breaker wrapper
 * so the breaker records a single success/failure for the entire attempt chain.
 * @private
 */
async function _executeWithRetries(/** @type {any} */ operation, /** @type {any} */ options) {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 5000,
    allowCPUFallback = true,
    onRetry = null,
    onFallback = null
  } = options;

  let lastError;
  let usedCPUFallback = false;

  // Try with current GPU setting
  try {
    return await withRetry(operation, {
      maxRetries,
      initialDelay,
      maxDelay,
      shouldRetry: isRetryableLlamaError,
      onRetry: (error, attempt) => {
        logger.warn(`[Resilience] Retry attempt ${attempt}`, { error: error.message });
        if (onRetry) onRetry(error, attempt);
      }
    })();
  } catch (error) {
    lastError = error;

    // Transient load failure: DegradationManager couldn't classify the error
    // beyond a generic "failed to load model" — usually VRAM contention from
    // a sibling process (vision server) that just hadn't released yet.
    // Policy: one retry with 1.5 s backoff to give CUDA time to release VRAM,
    // then surface. Hard stop — don't escalate to CPU fallback because the
    // failure isn't VRAM-specific (CPU fallback only helps confirmed GPU-OOM
    // errors and would mask permanent failures like a deleted model file).
    if (error?._degradationAction === 'transient_load_failure') {
      logger.warn('[Resilience] Transient load failure, retrying once after 1.5s backoff', {
        error: error.message
      });
      await delay(1500);
      try {
        return await operation();
      } catch (retryError) {
        lastError = retryError;
        // Fall through to "All retries exhausted" — do NOT enter CPU fallback
        // since "failed to load model" can mean lots of things that CPU mode
        // wouldn't fix.
      }
      // Skip the GPU-fallback block; head straight to the enriched error.
      throw _buildEnrichedError(lastError, usedCPUFallback);
    }

    // Check if we should fall back to CPU
    if (allowCPUFallback && shouldFallbackToCPU(error)) {
      const cpuFallbackRequestedByDegradation = error?._degradationAction === 'retry_with_cpu';
      const transientGpuError = isTransientGpuError(error);

      // Transient backend faults should retry on the primary backend before
      // escalating to CPU fallback.
      if (!cpuFallbackRequestedByDegradation && transientGpuError) {
        try {
          logger.warn('[Resilience] Transient GPU error, retrying primary backend', {
            error: error.message
          });
          return await withRetry(operation, {
            maxRetries: 2,
            initialDelay: 500,
            maxDelay: 2000,
            shouldRetry: isRetryableLlamaError,
            onRetry: (retryErr, attempt) => {
              logger.warn(`[Resilience] Primary-backend retry attempt ${attempt}`, {
                error: retryErr.message
              });
              if (onRetry) onRetry(retryErr, attempt);
            }
          })();
        } catch (transientRetryError) {
          lastError = transientRetryError;
        }
      }

      logger.warn('[Resilience] GPU error, falling back to CPU', {
        error: lastError?.message || error.message
      });

      if (onFallback) onFallback(lastError || error);
      usedCPUFallback = true;

      // Retry with CPU
      try {
        return await withRetry(() => operation({ forceCPU: true }), {
          maxRetries: 2,
          initialDelay: 500,
          maxDelay: 2000
        })();
      } catch (cpuError) {
        lastError = cpuError;
      }
    }
  }

  // All retries exhausted
  throw _buildEnrichedError(lastError, usedCPUFallback);
}

/**
 * Build the enriched error thrown when retries (and optional CPU fallback)
 * have been exhausted. Extracted so multiple exit paths in
 * `_executeWithRetries` produce the same surface.
 *
 * @param {Error} lastError
 * @param {boolean} usedCPUFallback
 * @returns {Error}
 * @private
 */
function _buildEnrichedError(lastError, usedCPUFallback) {
  const enrichedError = /** @type {Error & { originalError?: any, usedCPUFallback?: boolean }} */ (
    new Error(
      `Llama operation failed: ${lastError.message}` +
        (usedCPUFallback ? ' (including CPU fallback)' : '')
    )
  );
  enrichedError.originalError = lastError;
  enrichedError.usedCPUFallback = usedCPUFallback;
  return enrichedError;
}

/**
 * Wrap Llama operations with resilience (circuit breaker + retry + GPU fallback).
 *
 * When `modelType` is provided, a per-model-type circuit breaker guards the
 * operation.  After 5 consecutive complete failures (all retries exhausted)
 * the breaker opens and immediately rejects further calls for that model type
 * until the 5 min recovery probe succeeds.
 *
 * @param {(...args: any[]) => any} operation - The async operation to execute
 * @param {Record<string, any>} [options] - { modelType, maxRetries, initialDelay, maxDelay, allowCPUFallback, onRetry, onFallback }
 */
async function withLlamaResilience(operation, options = {}) {
  const { modelType, ...retryOptions } = options;

  if (modelType) {
    const breaker = _getCircuitBreaker(modelType);
    // Wrap the retry logic so non-transient errors (model-not-found, etc.) bypass
    // the circuit breaker's failure recording. These are expected business failures,
    // not service health degradation. Without this, 5 "model not found" errors
    // open the circuit for 5 minutes, blocking operations even after the model is
    // downloaded.
    return breaker.execute(async () => {
      try {
        return await _executeWithRetries(operation, retryOptions);
      } catch (error) {
        if (isNonTransientError(error)) {
          // In HALF_OPEN state, non-transient errors must still transition the
          // breaker to OPEN. Otherwise the breaker stays stuck in HALF_OPEN
          // because _skipCircuitBreakerCount prevents recordFailure() from
          // being called, and recordFailure() is the only path that transitions
          // HALF_OPEN -> OPEN.
          if (breaker.getState() !== 'HALF_OPEN') {
            // Tag the error so CircuitBreaker.execute() still throws it, but
            // we record a success to prevent the breaker from tripping.
            // This is safe because the breaker's recordFailure() has already been
            // called by execute()'s catch block — we need to undo that.
            // Simpler approach: throw a wrapper that CircuitBreaker won't count.
            error._skipCircuitBreakerCount = true;
          }
        }
        throw error;
      }
    });
  }

  // Backward-compatible: no circuit breaker when modelType is omitted
  return _executeWithRetries(operation, retryOptions);
}

/**
 * Wrap Orama persistence operations
 */
/**
 * @param {(...args: any[]) => any} operation
 * @param {{ maxRetries?: number }} [options]
 */
async function withOramaResilience(operation, options = {}) {
  const { maxRetries = 3 } = options;

  return withRetry(operation, {
    maxRetries,
    initialDelay: 100,
    maxDelay: 1000,
    shouldRetry: (error) => {
      const message = (error.message || '').toLowerCase();
      // Retry on disk I/O errors
      return (
        message.includes('ebusy') ||
        message.includes('eacces') ||
        message.includes('eperm') ||
        message.includes('enospc')
      );
    }
  })();
}

/**
 * Get circuit breaker stats for all model types (diagnostics).
 * @returns {Record<string, any>}
 */
function getLlamaCircuitStats() {
  /** @type {Record<string, any>} */
  const stats = {};
  for (const [type, breaker] of _circuitBreakers) {
    stats[type] = breaker.getStats();
  }
  return stats;
}

/**
 * Compact view for health reporting: the state of every breaker created so
 * far and the model types whose breaker is OPEN (requests rejected until the
 * recovery probe runs).
 * @returns {{ states: Record<string, string>, open: string[] }}
 */
function getLlamaCircuitSummary() {
  /** @type {Record<string, string>} */
  const states = {};
  /** @type {string[]} */
  const open = [];
  for (const [type, breaker] of _circuitBreakers) {
    const state = breaker.getState();
    states[type] = state;
    if (state === 'OPEN') open.push(type);
  }
  return { states, open };
}

/**
 * Reset the circuit breaker for a specific model type.
 * @param {string} modelType - 'text' | 'vision' | 'embedding'
 */
function resetLlamaCircuit(modelType) {
  const breaker = _circuitBreakers.get(modelType);
  if (breaker) breaker.reset();
}

/**
 * Cleanup all circuit breakers (call during shutdown).
 */
function cleanupLlamaCircuits() {
  for (const breaker of _circuitBreakers.values()) {
    breaker.cleanup();
  }
  _circuitBreakers.clear();
}

module.exports = {
  withLlamaResilience,
  withOramaResilience,
  isRetryableLlamaError,
  shouldFallbackToCPU,
  getLlamaCircuitStats,
  getLlamaCircuitSummary,
  resetLlamaCircuit,
  cleanupLlamaCircuits,
  // Exposed for testing only
  _circuitBreakers,
  _getCircuitBreaker
};
