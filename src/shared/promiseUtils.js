// @ts-check
/**
 * Consolidated Promise Utilities
 *
 * This module provides a single source of truth for all async/promise-related
 * utilities across the application. All timeout, retry, delay, and debounce
 * functionality should be imported from this module.
 *
 * @module shared/promiseUtils
 */

const { createLogger } = require('./logger');

const logger = createLogger('PromiseUtils');
// ============================================================================
// DELAY / SLEEP UTILITIES
// ============================================================================

/**
 * Creates a promise that resolves after a specified delay.
 * The timeout is unreferenced to allow the Node.js process to exit naturally
 * if this is the only pending operation.
 *
 * @param {number} ms - Delay in milliseconds
 * @returns {Promise<void>} Promise that resolves after the delay
 * @example
 * await delay(1000); // Wait 1 second
 * console.log('1 second has passed');
 */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // prevent process exit during shutdown retry/batch operations
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * Alias for delay - creates a promise that resolves after a specified time.
 * Provided for semantic clarity when the intent is to "sleep" the execution.
 *
 * @param {number} ms - Sleep duration in milliseconds
 * @returns {Promise<void>} Promise that resolves after sleeping
 * @example
 * await sleep(500); // Sleep for 500ms
 */
const sleep = delay;

// ============================================================================
// TIMEOUT UTILITIES
// ============================================================================

/**
 * Throw an AbortError when the given signal has already aborted.
 *
 * @param {AbortSignal|null|undefined} signal
 * @param {string} [message='Aborted']
 */
function throwIfAborted(signal, message = 'Aborted') {
  if (signal?.aborted) {
    const error = new Error(message);
    error.name = 'AbortError';
    throw error;
  }
}

/**
 * Wraps a promise or function with a timeout.
 * If the operation takes longer than the specified timeout, the promise
 * rejects with a timeout error.
 *
 * Supports two usage patterns:
 * 1. Direct promise timeout: withTimeout(promise, 5000, 'Database query')
 * 2. Function wrapper: withTimeout(asyncFn, 5000, 'API call')
 *
 * @param {Promise<any>|((...args: any[]) => any)} fnOrPromise - Promise to timeout OR async function to wrap
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} [operationName='Operation'] - Name of the operation for error messages
 * @returns {Promise<any>|((...args: any[]) => Promise<any>)} Wrapped promise with timeout OR wrapped function
 * @throws {Error} Throws if operation times out
 * @example
 * // Direct promise timeout
 * const result = await withTimeout(fetch('/api/data'), 5000, 'API fetch');
 *
 * // Function wrapper
 * const timedFetch = withTimeout(fetchData, 5000, 'Data fetch');
 * const result = await timedFetch(params);
 */
function withTimeout(fnOrPromise, timeoutMs, operationName = 'Operation') {
  const createTimeoutPromise = () => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // Allow process to exit if this timer is the only thing keeping it alive
      // This is critical for Jest test cleanup - the timeout will still fire
      // as long as Promise.race keeps the event loop active
      if (timeoutId.unref) {
        timeoutId.unref();
      }
    });
    return { timeoutPromise, timeoutId };
  };

  // If a promise is passed directly, race it with timeout
  if (
    fnOrPromise &&
    typeof (/** @type {any} */ (fnOrPromise).then) === 'function' &&
    typeof fnOrPromise !== 'function'
  ) {
    const { timeoutPromise, timeoutId } = createTimeoutPromise();
    const asPromise = /** @type {Promise<any>} */ (fnOrPromise);

    // Prevent unhandled promise rejections if the original promise rejects AFTER the timeout
    asPromise.catch((/** @type {any} */ err) => {
      logger.debug(
        `[PromiseUtils] Suppressed late rejection from timed-out operation "${operationName}":`,
        err.message
      );
    });

    return Promise.race([asPromise, timeoutPromise]).finally(() => {
      clearTimeout(timeoutId);
    });
  }

  const asFn = /** @type {(...args: any[]) => any} */ (fnOrPromise);
  // If a function is passed, return a wrapped function
  return async function (/** @type {any[]} */ ...args) {
    const { timeoutPromise, timeoutId } = createTimeoutPromise();
    try {
      const p = asFn(...args);
      // Prevent unhandled promise rejections if the original promise rejects AFTER the timeout
      if (p && typeof p.catch === 'function') {
        p.catch((/** @type {any} */ err) => {
          logger.debug(
            `[PromiseUtils] Suppressed late rejection from timed-out operation "${operationName}":`,
            err.message
          );
        });
      }
      return await Promise.race([p, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }
  };
}

/**
 * Execute a promise with timeout and AbortController support.
 * Enhanced version of withTimeout that provides an AbortController signal
 * to the promise factory, allowing the underlying operation to be cancelled.
 *
 * @param {(abortController: AbortController) => Promise<any>} fn - Function that receives AbortController and returns a Promise
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} [operationName='Operation'] - Name of the operation for error messages
 * @returns {Promise<*>} Result of the promise
 * @throws {Error} If the operation times out or the promise rejects
 *
 * @example
 * const result = await withAbortableTimeout(
 *   (abortController) => fetch(url, { signal: abortController.signal }),
 *   5000,
 *   'API fetch'
 * );
 */
/**
 * @param {(abortController: AbortController) => Promise<any>} fn
 * @param {number} timeoutMs
 * @param {string} [operationName]
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<any>}
 */
async function withAbortableTimeout(fn, timeoutMs, operationName = 'Operation', options = {}) {
  const externalSignal = options.signal || null;
  const abortController = new AbortController();
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timeoutId = null;
  /** @type {(() => void)|null} */
  let onExternalAbort = null;

  const makeCancelledError = () => {
    const err = /** @type {Error & { code?: string }} */ (
      new Error(`${operationName} was cancelled`)
    );
    err.code = 'OPERATION_CANCELLED';
    return err;
  };

  // Caller already cancelled — don't start the work at all.
  if (externalSignal?.aborted) {
    throw makeCancelledError();
  }

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      abortController.abort();
      reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Allow process to exit if this timer is the only thing keeping it alive
    // Critical for Jest test cleanup
    if (timeoutId.unref) {
      timeoutId.unref();
    }
    // Link the caller's signal: external cancellation (user cancel, window
    // close) aborts the inner work immediately instead of letting it run to
    // the timeout.
    if (externalSignal) {
      onExternalAbort = () => {
        abortController.abort();
        reject(makeCancelledError());
      };
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  });

  try {
    const promise = fn(abortController);
    // Prevent unhandled promise rejections if the original promise rejects AFTER the timeout
    if (promise && typeof promise.catch === 'function') {
      promise.catch((/** @type {any} */ err) => {
        logger.debug(
          `[PromiseUtils] Suppressed late rejection from aborted operation "${operationName}":`,
          err.message
        );
      });
    }
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    // Guaranteed cleanup in all code paths
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
    // Note: do NOT abort on success. The timeout handler (line above) handles
    // abort when timeout fires. Aborting on success would trigger spurious
    // abort event handlers in callers that already completed successfully.
  }
}

// ============================================================================
// RETRY UTILITIES
// ============================================================================

/**
 * Calculate delay with exponential backoff and optional jitter.
 * Jitter helps prevent the "thundering herd" problem when multiple
 * retries happen simultaneously.
 *
 * @param {number} attempt - Current attempt number (0-based)
 * @param {number} initialDelay - Initial delay in ms
 * @param {number} maxDelay - Maximum delay in ms
 * @param {number} backoffFactor - Exponential backoff multiplier
 * @param {number} jitterFactor - Jitter factor (0-1), 0 = no jitter
 * @returns {number} Delay in milliseconds
 */
function calculateRetryDelay(attempt, initialDelay, maxDelay, backoffFactor, jitterFactor = 0) {
  // Exponential backoff
  const exponentialDelay = initialDelay * backoffFactor ** attempt;
  const baseDelay = Math.min(exponentialDelay, maxDelay);

  // Add jitter if specified (jitter is +/- jitterFactor of the delay)
  if (jitterFactor > 0) {
    const jitter = baseDelay * jitterFactor * (Math.random() - 0.5) * 2;
    return Math.max(0, Math.floor(baseDelay + jitter));
  }

  return Math.floor(baseDelay);
}

/**
 * Wraps an async function with retry logic and exponential backoff.
 * Returns a new function that will automatically retry on failure.
 *
 * @param {(...args: any[]) => any} fn - Async function to wrap with retry logic
 * @param {Object} [options={}] - Retry configuration options
 * @param {number} [options.maxRetries=3] - Maximum number of retry attempts (alias: maxAttempts)
 * @param {number} [options.maxAttempts] - Alias for maxRetries
 * @param {number} [options.initialDelay=1000] - Initial delay between retries in ms (alias: delay)
 * @param {number} [options.delay] - Alias for initialDelay
 * @param {number} [options.maxDelay=10000] - Maximum delay between retries in ms
 * @param {number} [options.backoff=2] - Backoff multiplier for exponential delay (alias: backoffFactor)
 * @param {number} [options.backoffFactor] - Alias for backoff
 * @param {number} [options.jitterFactor=0] - Jitter factor (0-1) to randomize delays, preventing thundering herd
 * @param {string} [options.operationName='Operation'] - Name for logging
 * @param {(error: any, attempt: number) => boolean} [options.shouldRetry] - Function(error, attempt) => boolean to determine if retry should occur
 * @param {(error: any, attempt: number) => void} [options.onRetry] - Callback(error, attempt) called before each retry
 * @returns {(...args: any[]) => Promise<any>} Wrapped function with retry logic
 * @example
 * const fetchWithRetry = withRetry(fetchData, {
 *   maxRetries: 3,
 *   initialDelay: 1000,
 *   backoff: 2,
 *   jitterFactor: 0.3, // +/- 30% randomization
 *   shouldRetry: (err) => err.code !== 'AUTH_FAILED'
 * });
 * const data = await fetchWithRetry(url);
 */
function withRetry(fn, options = {}) {
  const {
    maxRetries,
    maxAttempts,
    initialDelay,
    delay: delayOption,
    maxDelay = 10000,
    backoff,
    backoffFactor,
    jitterFactor = 0,
    operationName = 'Operation',
    shouldRetry = () => true,
    onRetry
  } = options;

  // Support both parameter naming conventions
  const effectiveMaxRetries = maxRetries ?? maxAttempts ?? 3;
  const effectiveInitialDelay = initialDelay ?? delayOption ?? 1000;
  const effectiveBackoff = backoff ?? backoffFactor ?? 2;

  return async function (/** @type {any[]} */ ...args) {
    let lastError;

    for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
      try {
        return await fn(...args);
      } catch (error) {
        lastError = error;

        if (attempt < effectiveMaxRetries && shouldRetry(error, attempt)) {
          const waitTime = calculateRetryDelay(
            attempt,
            effectiveInitialDelay,
            maxDelay,
            effectiveBackoff,
            jitterFactor
          );

          logger.warn(
            `[Retry] ${operationName} attempt ${attempt + 1}/${effectiveMaxRetries} failed, retrying in ${waitTime}ms`,
            { error: error.message }
          );

          if (onRetry) {
            try {
              onRetry(error, attempt);
            } catch (callbackError) {
              logger.warn('[Retry] onRetry callback threw error', {
                error: callbackError.message
              });
            }
          }

          await new Promise((resolve) => {
            const t = setTimeout(resolve, waitTime);
            if (t && typeof t.unref === 'function') t.unref();
          });
        } else {
          if (attempt === effectiveMaxRetries) {
            logger.error(`[Retry] ${operationName} failed after ${effectiveMaxRetries} attempts`, {
              error: error.message
            });
          }
          break;
        }
      }
    }

    throw lastError;
  };
}

/**
 * Executes an async operation with retry logic.
 * Convenience function that immediately invokes the retry-wrapped function.
 *
 * @param {(...args: any[]) => any} operation - Async operation to execute with retries
 * @param {Object} [options={}] - Same options as withRetry
 * @returns {Promise<*>} Result of the operation
 * @example
 * const result = await retry(() => fetchData(url), { maxRetries: 3 });
 */
async function retry(operation, options = {}) {
  return withRetry(operation, options)();
}

// ============================================================================
// SAFE EXECUTION UTILITIES
// ============================================================================

// ============================================================================
// DEBOUNCE / THROTTLE UTILITIES
// ============================================================================

/**
 * Creates a debounced function that delays invoking fn until after wait milliseconds
 * have elapsed since the last time the debounced function was invoked.
 *
 * @param {(...args: any[]) => any} fn - Function to debounce
 * @param {number} waitMs - Debounce delay in milliseconds
 * @param {{ leading?: boolean, trailing?: boolean, maxWait?: number }} [options={}] - Configuration options
 * @returns {((...args: any[]) => any) & { cancel: () => void, flush: () => any }} Debounced function with cancel() method
 * @example
 * const debouncedSave = debounce(saveData, 300);
 * debouncedSave(); // Will only execute after 300ms of no calls
 * debouncedSave.cancel(); // Cancel pending execution
 */
function debounce(fn, waitMs, options = {}) {
  const { leading = false, trailing = true, maxWait } = options;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timeoutId = null;
  /** @type {any[]|null} */
  let lastArgs = null;
  /** @type {any} */
  let lastThis = null;
  /** @type {any} */
  let result;
  /** @type {number|undefined} */
  let lastCallTime;
  let lastInvokeTime = 0;
  const hasMaxWait = typeof maxWait === 'number';

  /**
   * @param {number} time
   */
  function invokeFunc(time) {
    const args = lastArgs;
    const thisArg = lastThis;
    lastArgs = lastThis = null;
    lastInvokeTime = time !== undefined ? time : Date.now();
    result = fn.apply(thisArg, args);
    return result;
  }

  /**
   * @param {number} time
   */
  function shouldInvoke(time) {
    const timeSinceLastCall = time - /** @type {number} */ (lastCallTime);
    const timeSinceLastInvoke = time - lastInvokeTime;
    return (
      lastCallTime === undefined ||
      timeSinceLastCall >= waitMs ||
      timeSinceLastCall < 0 ||
      (hasMaxWait && timeSinceLastInvoke >= /** @type {number} */ (maxWait))
    );
  }

  /**
   * @param {number} time
   */
  function remainingWait(time) {
    const timeSinceLastCall = time - /** @type {number} */ (lastCallTime);
    const timeSinceLastInvoke = time - lastInvokeTime;
    const timeWaiting = waitMs - timeSinceLastCall;
    return hasMaxWait
      ? Math.min(timeWaiting, /** @type {number} */ (maxWait) - timeSinceLastInvoke)
      : timeWaiting;
  }

  function timerExpired() {
    const time = Date.now();
    if (shouldInvoke(time)) {
      return trailingEdge(time);
    }
    timeoutId = setTimeout(timerExpired, remainingWait(time));
    return undefined;
  }

  /**
   * @param {number} time
   */
  function trailingEdge(time) {
    timeoutId = null;
    if (trailing && lastArgs) {
      return invokeFunc(time);
    }
    lastArgs = lastThis = null;
    return result;
  }

  /**
   * @param {number} time
   */
  function leadingEdge(time) {
    timeoutId = setTimeout(timerExpired, waitMs);
    return leading ? invokeFunc(time) : result;
  }

  function debounced(/** @type {any[]} */ ...args) {
    const time = Date.now();
    const isInvoking = shouldInvoke(time);

    lastArgs = args;
    lastThis = this;
    lastCallTime = time;

    if (isInvoking) {
      if (timeoutId === null) {
        return leadingEdge(time);
      }
      if (hasMaxWait) {
        // Handle invocations in a tight maxWait loop
        clearTimeout(timeoutId);
        timeoutId = setTimeout(timerExpired, waitMs);
        return invokeFunc(time);
      }
    }

    if (timeoutId === null) {
      timeoutId = setTimeout(timerExpired, waitMs);
    }

    return result;
  }

  debounced.cancel = function () {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    lastInvokeTime = 0;
    lastArgs = lastCallTime = lastThis = timeoutId = null;
  };

  debounced.flush = function () {
    return timeoutId === null ? result : trailingEdge(Date.now());
  };

  return debounced;
}

/**
 * Creates a throttled function that only invokes fn at most once per wait period.
 *
 * @param {(...args: any[]) => any} fn - Function to throttle
 * @param {number} waitMs - Throttle period in milliseconds
 * @param {{ leading?: boolean, trailing?: boolean }} [options={}] - Configuration options
 * @returns {((...args: any[]) => any) & { cancel: () => void, flush: () => any }} Throttled function with cancel() method
 * @example
 * const throttledScroll = throttle(handleScroll, 100);
 * window.addEventListener('scroll', throttledScroll);
 */
function throttle(fn, waitMs, options = {}) {
  return debounce(fn, waitMs, {
    leading: options.leading !== false,
    trailing: options.trailing !== false,
    maxWait: waitMs
  });
}

// ============================================================================
// BACKGROUND WORK TRACKER
// ============================================================================

/**
 * Creates a tracker for fire-and-forget promises so shutdown can await them.
 * Each service creates one tracker, wraps fire-and-forget calls with track(),
 * and calls drain() in its shutdown() method.
 *
 * @param {string} [name='Service'] - Name for logging
 * @returns {Object} Tracker with track(), drain(), and size getter
 * @example
 * const bgWork = createBackgroundWorkTracker('LlamaService');
 * // Instead of: someAsyncOp().catch(log);
 * bgWork.track(someAsyncOp().catch(log));
 * // In shutdown:
 * await bgWork.drain();
 */
function createBackgroundWorkTracker(name = 'Service') {
  const pending = new Set();
  return {
    track(/** @type {any} */ promise) {
      if (!promise || typeof promise.finally !== 'function') return promise;
      pending.add(promise);
      promise.finally(() => pending.delete(promise));
      return promise;
    },
    async drain(timeoutMs = 5000) {
      if (pending.size === 0) return;
      logger.debug(`[${name}] Draining ${pending.size} background tasks`);
      await Promise.race([Promise.allSettled([...pending]), delay(timeoutMs)]);
    },
    get size() {
      return pending.size;
    }
  };
}

// ============================================================================
// INITIALIZATION GUARD UTILITIES
// ============================================================================

/**
 * Creates a race-condition-safe initialization guard.
 * Multiple concurrent calls to initialize will wait for the first to complete.
 *
 * @param {string} [name='Service'] - Name for logging
 * @returns {{ initialize: (fn: (...args: any[]) => any) => Promise<any>, isInitialized: () => boolean, reset: () => void, requireInitialized: () => void }} Guard object with initialize and reset methods
 * @example
 * const initGuard = createInitGuard('MyService');
 *
 * async function initialize() {
 *   return initGuard.initialize(async () => {
 *     // Actual initialization logic
 *     await loadConfig();
 *     await connectToDatabase();
 *     return true;
 *   });
 * }
 */
function createInitGuard(name = 'Service') {
  let initialized = false;
  /** @type {Promise<any>|null} */
  let initPromise = null;

  return {
    /**
     * Check if initialized
     * @returns {boolean}
     */
    isInitialized() {
      return initialized;
    },

    /**
     * Run initialization with race condition protection.
     * If already initialized, returns immediately.
     * If initialization is in progress, waits for it to complete.
     *
     * @param {() => Promise<any>} initFn - Async function that performs initialization
     * @returns {Promise<*>} Result of initFn
     */
    async initialize(initFn) {
      // Already initialized - return immediately
      if (initialized) {
        return true;
      }

      // Initialization in progress - wait for it
      if (initPromise) {
        return initPromise;
      }

      // Start initialization
      initPromise = (async () => {
        try {
          const result = await initFn();
          initialized = true;
          initPromise = null;
          logger.debug(`[${name}] Initialization complete`);
          return result;
        } catch (error) {
          initPromise = null;
          logger.error(`[${name}] Initialization failed:`, error.message);
          throw error;
        }
      })();

      return initPromise;
    },

    /**
     * Reset initialization state (for shutdown/reinit)
     */
    reset() {
      initialized = false;
      initPromise = null;
      logger.debug(`[${name}] Initialization state reset`);
    },

    /**
     * Require initialization, throws if not initialized
     * @throws {Error} If not initialized
     */
    requireInitialized() {
      if (!initialized) {
        throw new Error(`${name} is not initialized`);
      }
    }
  };
}

/**
 * Creates a timeout-race promise pair for common timeout patterns.
 * Returns both the timeout promise and cleanup function.
 *
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} [message='Operation timed out'] - Timeout error message
 * @returns {{promise: Promise<any>, cleanup: () => void}} Timeout promise and cleanup function
 * @example
 * const { promise: timeoutPromise, cleanup } = createTimeoutRace(5000, 'API call');
 * try {
 *   const result = await Promise.race([apiCall(), timeoutPromise]);
 * } finally {
 *   cleanup();
 * }
 */
function createTimeoutRace(timeoutMs, message = 'Operation timed out') {
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timeoutId = null;

  const promise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${message} after ${timeoutMs}ms`));
    }, timeoutMs);

    // Allow process to exit without waiting for this timer
    if (timeoutId && typeof timeoutId.unref === 'function') {
      timeoutId.unref();
    }
  });

  const cleanup = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  return { promise, cleanup };
}

// ============================================================================
// CONCURRENCY PRIMITIVES
// ============================================================================

// Re-export the canonical Semaphore from RateLimiter.
// Previously a simpler duplicate lived here; now there is one implementation
// with queue-size limits, timeouts, backpressure retry, and reset().
const { Semaphore } = require('./RateLimiter');

// ============================================================================
// BATCH & CONCURRENCY UTILITIES
// ============================================================================

/**
 * Ensures all promises in an array are settled with proper error handling.
 * Returns results in order, with null for failed promises.
 *
 * @param {Array<Promise<any>>} promises - Array of promises to settle
 * @param {((error: any, index: number) => any)|null} [onError=null] - Error handler for failed promises
 * @returns {Promise<Array<any>>} Array of results (null for rejected promises)
 * @example
 * const results = await allSettledWithErrors([p1, p2, p3], (err, idx) => {
 *   console.log(`Promise ${idx} failed:`, err.message);
 * });
 */
async function allSettledWithErrors(promises, onError = null) {
  if (!Array.isArray(promises)) {
    throw new Error('Expected an array of promises');
  }

  const results = await Promise.allSettled(promises);
  const finalResults = [];
  const errors = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      finalResults.push(result.value);
    } else {
      errors.push({ index: i, error: result.reason });
      finalResults.push(null);

      if (onError) {
        try {
          await onError(result.reason, i);
        } catch (handlerError) {
          logger.error('[AllSettled] Error handler failed', {
            error: handlerError.message,
            originalError: result.reason?.message
          });
        }
      }
    }
  }

  if (errors.length > 0) {
    logger.warn(`[AllSettled] ${errors.length} of ${promises.length} promises failed`, {
      errors: errors.map((e) => ({
        index: e.index,
        message: e.error?.message
      }))
    });
  }

  return finalResults;
}

/**
 * Maps items through an async iteratee with a bounded worker pool.
 *
 * Unlike batchProcess (batch barrier + inter-batch delay), workers pull the
 * next item as soon as they finish, so one slow item never gates the whole
 * batch. Results are returned in input order. Iteratee errors REJECT the
 * returned promise (fail-fast) — wrap the iteratee if per-item errors should
 * be collected instead.
 *
 * @param {Array<any>} items - Items to process
 * @param {number} concurrency - Max simultaneous iteratee invocations (clamped to [1, items.length])
 * @param {(item: any, index: number) => Promise<any>} iteratee - async (item, index) => result
 * @param {{ settle?: boolean }} [options] - `settle: true` uses Promise.allSettled on workers
 *   so one iteratee throw does not reject the whole map (document-extraction OCR).
 * @returns {Promise<Array<any>>} Results in input order
 * @example
 * const results = await mapWithConcurrency(paths, 8, (p) => trashOne(p));
 */
async function mapWithConcurrency(items, concurrency, iteratee, options = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  const safeConcurrency = Math.max(1, Math.min(concurrency || 1, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: safeConcurrency }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
    }
  });

  if (options.settle) {
    await Promise.allSettled(workers);
  } else {
    await Promise.all(workers);
  }

  return results;
}

/**
 * Executes promises in batches with controlled concurrency.
 *
 * @param {Array<any>} items - Items to process
 * @param {(item: any, index: number) => any} fn - Function to execute for each item
 * @param {number} [batchSize=5] - Number of concurrent promises per batch
 * @returns {Promise<Array<any>>} Array of results
 * @example
 * const results = await batchProcess(urls, fetchUrl, 3);
 */
async function batchProcess(items, fn, batchSize = 5) {
  const results = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchPromises = batch.map((item, index) => fn(item, i + index));
    const batchResults = await allSettledWithErrors(batchPromises);
    results.push(...batchResults);

    // Add small delay between batches to prevent overwhelming the system
    if (i + batchSize < items.length) {
      await delay(50);
    }
  }

  return results;
}

// ============================================================================
// OBSERVABLE FALLBACK
// ============================================================================

/**
 * Wraps a promise so that rejections are logged (instead of swallowed silently)
 * and the returned promise always resolves to undefined.
 *
 * Use for opportunistic cleanup operations where a failure is not a bug but
 * silently dropping it is — e.g.,
 *   await swallow(fs.unlink(tempPath), logger, 'cleanup:atomic-temp');
 *
 * Default level is 'debug' because most cleanup failures are operational
 * noise (file already gone, etc.). Pass 'warn' for sites where a failure
 * is worth surfacing in production logs.
 *
 * The logger argument is optional; if absent or missing the requested
 * level method, the rejection is dropped silently. A broken logger
 * (transport throws) is intentionally NOT caught — that's a real bug.
 *
 * @param {Promise<any>} promise - the operation to wrap
 * @param {{ debug?: Function, warn?: Function }} [optLogger] - structured logger
 * @param {string} [context=''] - short label included in the log message
 * @param {'debug'|'warn'} [level='debug'] - level to emit the rejection at
 * @returns {Promise<undefined>} always resolves to undefined
 */
async function swallow(promise, optLogger, context = '', level = 'debug') {
  try {
    await promise;
  } catch (err) {
    const fn = optLogger?.[level];
    if (typeof fn === 'function') {
      fn.call(optLogger, `[swallow] ${context}`, {
        error: err?.message,
        code: err?.code
      });
    }
  }
  return undefined;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Delay / Sleep
  delay,
  sleep,

  // Timeout
  throwIfAborted,
  withTimeout,
  withAbortableTimeout,
  createTimeoutRace,

  // Retry
  withRetry,
  retry,
  calculateRetryDelay,

  // Debounce / Throttle
  debounce,
  throttle,

  // Batch & Concurrency
  batchProcess,
  mapWithConcurrency,
  allSettledWithErrors,

  // Initialization
  createInitGuard,

  // Background work tracking
  createBackgroundWorkTracker,

  // Concurrency Primitives
  Semaphore,

  // Observable fallback
  swallow
};
