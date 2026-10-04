// @ts-check
/**
 * Batch Lock Manager
 *
 * Provides a global lock to prevent concurrent batch operations.
 */

const { logger: baseLogger, createLogger } = require('../../../shared/logger');
const { delay } = require('../../../shared/promiseUtils');
const { PROCESSING_LIMITS } = require('../../../shared/constants');
const { TIMEOUTS } = require('../../../shared/performanceConstants');

const logger =
  typeof createLogger === 'function' ? createLogger('IPC:Files:BatchLock') : baseLogger;
if (typeof createLogger !== 'function' && logger?.setContext) {
  logger.setContext('IPC:Files:BatchLock');
}

// Global batch operation lock to prevent concurrent batch operations
/** @type {{ batchId: string, acquiredAt: number } | null} */
let batchOperationLock = null;
// Budget for the rollback tail that runs AFTER a batch trips
// MAX_TOTAL_BATCH_TIME: the in-flight move must finish (FILE_COPY) and every
// completed op must be restored. Holders renew the lock per op, so this TTL
// is only the crash backstop — it must still exceed the worst-case
// legitimate hold, or a second batch could start mid-rollback.
const ROLLBACK_ALLOWANCE_MS = 2 * 60 * 1000;
const BATCH_LOCK_TIMEOUT =
  PROCESSING_LIMITS.MAX_TOTAL_BATCH_TIME + TIMEOUTS.FILE_COPY + ROLLBACK_ALLOWANCE_MS;
const BATCH_LOCK_ACQUIRE_TIMEOUT = 15000; // 15 seconds per attempt
const BATCH_LOCK_ACQUIRE_MAX_WAIT = 5 * 60 * 1000; // 5 minutes total wait
const BATCH_LOCK_RETRY_BASE_MS = 1000;
const BATCH_LOCK_RETRY_MAX_MS = 10000;

// Promise-based mutex for atomic lock acquisition (prevents race conditions)
/** @type {Promise<unknown>} */
let lockMutex = Promise.resolve();

/**
 * @typedef {Object} BatchLockWaiter
 * @property {string} batchId
 * @property {boolean} settled
 * @property {(value: boolean) => void} resolve
 * @property {() => void} clearTimeout
 * @property {ReturnType<typeof setTimeout>} [timeoutId]
 */

// Promise-based waiters queue to avoid busy-wait polling
/** @type {BatchLockWaiter[]} */
const batchLockWaiters = [];

/**
 * Acquire the global batch operation lock
 * Uses promise-based mutex for ATOMIC check-and-set to prevent race conditions
 * @param {string} batchId - Unique identifier for the batch
 * @param {number} timeout - Maximum time to wait for lock (ms)
 * @returns {Promise<boolean>} True if lock acquired, false if timeout
 */
async function acquireBatchLockOnce(batchId, timeout = BATCH_LOCK_ACQUIRE_TIMEOUT) {
  /** @type {(value?: unknown) => void} */
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  const current = lockMutex;
  lockMutex = next;

  // Wait for previous mutex holder to release (with timeout)
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('Lock acquisition mutex timeout'));
    }, timeout);
  });

  try {
    await Promise.race([current, timeoutPromise]);
  } catch {
    // Mutex timeout - release our slot and return false
    release();
    return false;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  try {
    // Check and handle stale lock
    if (batchOperationLock !== null) {
      if (Date.now() - batchOperationLock.acquiredAt > BATCH_LOCK_TIMEOUT) {
        logger.warn('[FILE-OPS] Force-releasing stale batch lock', {
          staleBatchId: batchOperationLock.batchId,
          heldFor: Date.now() - batchOperationLock.acquiredAt
        });
        batchOperationLock = null;
      }
    }

    // If lock is free, acquire immediately
    if (batchOperationLock === null) {
      batchOperationLock = { batchId, acquiredAt: Date.now() };
      release(); // Release mutex
      return true;
    }

    // Lock is held by another batch - add to waiters queue
    release(); // Release mutex before waiting

    // Wait for lock to be released using promise-based approach (no polling)
    return new Promise((resolve) => {
      let settled = false;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timeoutId;
      /** @type {BatchLockWaiter} */
      const waiter = {
        batchId,
        settled: false,
        resolve: (value) => {
          if (settled) return; // Prevent double-resolve
          settled = true;
          waiter.settled = true;
          if (timeoutId) clearTimeout(timeoutId);
          resolve(value);
        },
        clearTimeout: () => clearTimeout(timeoutId)
      };

      batchLockWaiters.push(waiter);

      timeoutId = setTimeout(() => {
        if (settled) return;
        const index = batchLockWaiters.indexOf(waiter);
        if (index !== -1) {
          batchLockWaiters.splice(index, 1);
        }
        waiter.resolve(false);
      }, timeout);

      waiter.timeoutId = timeoutId;
    });
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * Acquire the global batch lock, retrying with backoff until the max wait elapses
 * @param {string} batchId - Unique identifier for the batch
 * @param {number} [timeout] - Maximum time to wait per attempt (ms)
 * @returns {Promise<boolean>} True if lock acquired, false if total wait exceeded
 */
async function acquireBatchLock(batchId, timeout = BATCH_LOCK_ACQUIRE_TIMEOUT) {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < BATCH_LOCK_ACQUIRE_MAX_WAIT) {
    const acquired = await acquireBatchLockOnce(batchId, timeout);
    if (acquired) return true;
    attempt += 1;
    const backoff = Math.min(BATCH_LOCK_RETRY_BASE_MS * 2 ** attempt, BATCH_LOCK_RETRY_MAX_MS);
    await delay(backoff);
  }
  return false;
}

/**
 * Refresh the holder's lease so a long-running (but live) batch is never
 * force-released mid-operation. Ignored when the caller is not the holder.
 * @param {string} batchId - Batch ID that should hold the lock
 * @returns {boolean} True when the lease was renewed
 */
function renewBatchLock(batchId) {
  if (!batchOperationLock || batchOperationLock.batchId !== batchId) return false;
  batchOperationLock.acquiredAt = Date.now();
  return true;
}

/**
 * Release the global batch operation lock
 * Notifies waiting batch operations that the lock is available
 * @param {string} batchId - Batch ID that should hold the lock
 */
function releaseBatchLock(batchId) {
  if (!batchOperationLock) return;
  if (batchOperationLock.batchId !== batchId) {
    logger.warn('[FILE-OPS] releaseBatchLock called by non-holder batch', {
      callerBatchId: batchId,
      holderBatchId: batchOperationLock.batchId
    });
    return;
  }

  // Transfer ownership directly to the next valid waiter.
  // Only clear the lock if no waiter is eligible to receive handoff.
  let nextWaiter = null;
  while (batchLockWaiters.length > 0) {
    const waiter = batchLockWaiters.shift();
    if (waiter.clearTimeout) {
      waiter.clearTimeout();
    } else if (waiter.timeoutId) {
      clearTimeout(waiter.timeoutId);
    }
    if (waiter.settled) continue;
    if (!waiter.batchId) continue; // Validate batchId on handoff
    nextWaiter = waiter;
    break;
  }

  if (nextWaiter) {
    batchOperationLock = { batchId: nextWaiter.batchId, acquiredAt: Date.now() };
    nextWaiter.resolve(true);
    return;
  }

  batchOperationLock = null;
}

module.exports = {
  acquireBatchLock,
  renewBatchLock,
  releaseBatchLock,
  BATCH_LOCK_TIMEOUT
};
