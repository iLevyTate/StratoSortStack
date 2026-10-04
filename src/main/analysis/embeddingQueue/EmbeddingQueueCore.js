// @ts-check
/**
 * EmbeddingQueue Core Class
 *
 * Core embedding queue with persistence, retry logic, and parallel processing.
 *
 * @module embeddingQueue/EmbeddingQueueCore
 */

const path = require('path');
const { app } = require('electron');
const { createLogger } = require('../../../shared/logger');
const { createInitGuard } = require('../../../shared/promiseUtils');
const { container, ServiceIds } = require('../../services/ServiceContainer');
const { get: getConfig } = require('../../../shared/config/index');
const { traceQueueUpdate } = require('../../../shared/pathTraceLogger');
const { getAllIdVariants, buildPathUpdatePairs } = require('../../utils/fileIdUtils');
const {
  BATCH,
  LIMITS,
  THRESHOLDS,
  RETRY,
  CONCURRENCY,
  TIMEOUTS
} = require('../../../shared/performanceConstants');
const { ERROR_CODES } = require('../../../shared/errorCodes');

const { loadPersistedData, persistQueueData } = require('./persistence');
const { createFailedItemHandler } = require('./failedItemHandler');
const { processItemsInParallel } = require('./parallelProcessor');
const { createProgressTracker } = require('./progress');

const logger = createLogger('EmbeddingQueue');
class EmbeddingQueue {
  /**
   * @param {{ persistenceFileName?: string, batchSize?: number, flushDelayMs?: number, parallelFlushConcurrency?: number, failedItemsPath?: string, deadLetterPath?: string }} [options]
   */
  constructor(options = {}) {
    /** @type {any[]} */
    this.queue = [];
    const persistenceFileName =
      typeof options.persistenceFileName === 'string' && options.persistenceFileName.trim()
        ? options.persistenceFileName.trim()
        : 'pending_embeddings.json';
    this.persistencePath = path.join(app.getPath('userData'), persistenceFileName);
    const baseName = path.basename(this.persistencePath, path.extname(this.persistencePath));
    this._persistenceKeys = {
      queue: `${baseName}:queue`,
      failedItems: `${baseName}:failedItems`,
      deadLetter: `${baseName}:deadLetter`,
      pendingRemovals: `${baseName}:pendingRemovals`
    };
    // pendingRemovals shares persistencePath with queue. In SQLite mode they
    // coexist as distinct keys in the same DB; in JSON-fallback mode they
    // would clobber each other (both keys ignored, both write to the bare
    // file). Give pendingRemovals its own JSON file for the fallback path.
    const persistenceExt = path.extname(this.persistencePath) || '.json';
    this._pendingRemovalsJsonPath = path.join(
      path.dirname(this.persistencePath),
      `${baseName}.pendingRemovals${persistenceExt}`
    );

    // Configuration from unified config
    this.BATCH_SIZE =
      typeof options.batchSize === 'number' &&
      Number.isFinite(options.batchSize) &&
      options.batchSize > 0
        ? Math.floor(options.batchSize)
        : getConfig('ANALYSIS.batchSize', 50);
    this.FLUSH_DELAY_MS =
      typeof options.flushDelayMs === 'number' &&
      Number.isFinite(options.flushDelayMs) &&
      options.flushDelayMs >= 0
        ? options.flushDelayMs
        : BATCH.EMBEDDING_FLUSH_DELAY_MS;
    this.flushTimer = null;
    this.isFlushing = false;
    this._initGuard = createInitGuard('EmbeddingQueueCore');

    // Memory limits
    this.MAX_QUEUE_SIZE = LIMITS.MAX_QUEUE_SIZE;
    this.MAX_RETRY_COUNT = getConfig('ANALYSIS.retryAttempts', 3);
    // Generic flush-error retry/backoff budget (reset on a successful online flush).
    this.retryCount = 0;
    // Offline-DB give-up budget, kept separate from retryCount so a run of generic
    // flush errors (which never resets on the offline path) can't prematurely
    // exhaust the offline retry budget. Reset on online success AND on give-up.
    this._offlineRetryCount = 0;

    // Memory monitoring thresholds
    this.HIGH_WATERMARK = THRESHOLDS.QUEUE_HIGH_WATERMARK;
    this.CRITICAL_WATERMARK = THRESHOLDS.QUEUE_CRITICAL_WATERMARK;
    this.MEMORY_WARNING_THRESHOLD = Math.floor(this.MAX_QUEUE_SIZE * this.HIGH_WATERMARK);
    this.CRITICAL_WARNING_THRESHOLD = Math.floor(this.MAX_QUEUE_SIZE * this.CRITICAL_WATERMARK);
    this.memoryWarningLogged = false;
    this.criticalWarningLogged = false;

    // Parallel processing config
    this.PARALLEL_FLUSH_CONCURRENCY =
      typeof options.parallelFlushConcurrency === 'number' &&
      Number.isFinite(options.parallelFlushConcurrency) &&
      options.parallelFlushConcurrency > 0
        ? Math.floor(options.parallelFlushConcurrency)
        : CONCURRENCY.EMBEDDING_FLUSH;

    // Progress tracking
    this._progressTracker = createProgressTracker();

    // Failed item handler
    const failedItemsPath =
      typeof options.failedItemsPath === 'string' && options.failedItemsPath.trim()
        ? options.failedItemsPath.trim()
        : path.join(app.getPath('userData'), 'failed_embeddings.json');
    const deadLetterPath =
      typeof options.deadLetterPath === 'string' && options.deadLetterPath.trim()
        ? options.deadLetterPath.trim()
        : path.join(app.getPath('userData'), 'dead_letter_embeddings.json');
    this.failedItemsPath = failedItemsPath;
    this.deadLetterPath = deadLetterPath;
    this._failedItemHandler = createFailedItemHandler({
      itemMaxRetries: getConfig('ANALYSIS.retryAttempts', 3),
      maxDeadLetterSize: LIMITS.MAX_DEAD_LETTER_SIZE,
      failedItemsPath,
      deadLetterPath,
      persistenceKeys: this._persistenceKeys,
      // Share the load-failure latch: after a failed initialize() the handler's
      // maps are missing on-disk entries, so its persists must not replace the
      // persisted failedItems/deadLetter keys with the partial in-memory state.
      shouldBlockPersist: () => this._persistBlocked || this._isShutdownComplete
    });

    // Track pending operations for graceful shutdown
    this._pendingPersistence = null;
    this._pendingFlush = null;
    // Handle to the genuinely in-flight flush() worker, published by the worker
    // itself once it passes the double-check (paired with isFlushing). Distinct
    // from _pendingFlush, which enqueue/scheduleFlush reassign to the last-kicked
    // flush — that one may still be parked on the mutex or destined to
    // early-return, so forceFlush must await this handle, not _pendingFlush.
    this._activeFlush = null;

    // Shutdown guard — reject new enqueues after shutdown begins
    this._isShuttingDown = false;
    // Set once shutdown() has written its final state. From then on every
    // persist is a no-op so a late caller (path coordinator, stray flush
    // completion) cannot reopen the SQLite store the manager has closed.
    this._isShutdownComplete = false;

    // Track all outstanding persistence promises (including from remove/update ops)
    this._outstandingPersistence = new Set();

    // Pending removals to apply after flush completes
    this._pendingRemovals = new Set();

    // Track retry timers so they can be cleared on shutdown
    this._retryTimers = new Set();

    // Mutex for flush operation to prevent double-flush race conditions
    this._flushMutex = Promise.resolve();

    // Latch: set when initialize() fails to load persisted state. While set,
    // destructive persists are blocked — the in-memory queue/failed-items are
    // empty or partial, and writing them out would overwrite (lose) the
    // pending embeddings still recorded on disk. Cleared by a successful load.
    this._persistBlocked = false;
  }

  /** @returns {boolean} Whether the queue has been initialized */
  get initialized() {
    return this._initGuard.isInitialized();
  }

  // Legacy setter — no-op since init state is managed by _initGuard
  set initialized(_v) {
    // Intentional no-op: init state managed by createInitGuard
  }

  /**
   * Acquire flush mutex to prevent concurrent flush operations
   * @param {number} timeout - Timeout in ms (default: TIMEOUTS.MUTEX_ACQUIRE)
   * @returns {Promise<Function>} Release function to call when done
   * @private
   */
  async _acquireFlushMutex(timeout = TIMEOUTS.MUTEX_ACQUIRE) {
    // Without this, timeout + normal completion could both call release()
    let released = false;
    /** @type {() => void} */
    let release;
    const next = new Promise((resolve) => {
      release = () => {
        if (!released) {
          released = true;
          resolve();
        }
      };
    });

    const current = this._flushMutex;
    this._flushMutex = next;

    /** @type {NodeJS.Timeout | undefined} */
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          Object.assign(new Error(`Flush mutex acquisition timed out after ${timeout}ms`), {
            code: ERROR_CODES.TIMEOUT
          })
        );
      }, timeout);
    });

    try {
      await Promise.race([current, timeoutPromise]);
      return release;
    } catch (/** @type {any} */ error) {
      if (error.code === ERROR_CODES.TIMEOUT) {
        logger.error(
          '[EmbeddingQueue] Mutex acquisition timed out — previous flush still running; not advancing queue'
        );
        // This acquirer never owned the mutex, so it must not run its critical
        // section (no release() now) — but its `next` link is already spliced
        // into the chain and later waiters may be parked on it. Do NOT revert
        // the tail: if a second waiter chained behind this one also times out,
        // reverting would leave the tail pointing at this waiter's forever-
        // pending `next`, permanently wedging every future flush (each would
        // wait TIMEOUTS.MUTEX_ACQUIRE and throw). Instead heal the chain:
        // when this waiter's turn finally arrives (the slow holder releases),
        // pass ownership straight through so subsequent waiters unblock (T-16).
        // eslint-disable-next-line promise/catch-or-return -- ownership pass-through only; release() is idempotent and never throws
        current.then(release, release);
        throw error;
      }
      release();
      throw error;
    } finally {
      // Wrap in try-catch as defensive measure (clearTimeout shouldn't throw)
      try {
        if (timeoutId) clearTimeout(timeoutId);
      } catch (clearError) {
        logger.debug('[EmbeddingQueue] clearTimeout error (non-fatal):', clearError.message);
      }
    }
  }

  /**
   * Ensure all pending operations complete (call before app quit)
   */
  async ensurePendingComplete() {
    // Clear debounce timer to prevent it from firing during shutdown
    if (this._persistDebounceTimer) {
      clearTimeout(this._persistDebounceTimer);
      this._persistDebounceTimer = null;
    }
    const operations = [];
    if (this._pendingPersistence) operations.push(this._pendingPersistence);
    if (this._pendingFlush) operations.push(this._pendingFlush);

    if (operations.length > 0) {
      logger.info('[EmbeddingQueue] Waiting for pending operations to complete');
      try {
        await Promise.all(operations);
      } catch (err) {
        logger.error('[EmbeddingQueue] Error completing pending operations:', err.message);
      }
    }
    if (this._pendingRemovals?.size) {
      const pending = this._pendingRemovals;
      this._pendingRemovals = new Set();
      const beforeCount = this.queue.length;
      this.queue = this.queue.filter((item) => !pending.has(item.id));
      for (const id of pending) {
        this._failedItemHandler.failedItems.delete(id);
      }
      const pendingRemoved = beforeCount - this.queue.length;
      if (pendingRemoved > 0) {
        logger.debug('[EmbeddingQueue] Applied pending removals before shutdown persist', {
          removedCount: pendingRemoved
        });
      }
      await this._failedItemHandler
        .persistAll()
        .catch((/** @type {any} */ err) =>
          logger.warn(
            '[EmbeddingQueue] Failed to persist failed items after pending removals:',
            err.message
          )
        );
      // Clear persisted pending removals now that they've been applied
      this._persistPendingRemovals();
    }
    await this.persistQueue();
  }

  /**
   * Register a progress callback
   * @param {Function} callback
   */
  onProgress(callback) {
    return this._progressTracker.onProgress(callback);
  }

  /**
   * Notify progress callbacks
   * @param {any} progress
   */
  _notifyProgress(progress) {
    this._progressTracker.notify(progress);
  }

  /**
   * Initialize the queue by loading pending items from disk
   */
  async initialize() {
    return this._initGuard.initialize(async () => {
      try {
        // Load main queue
        await loadPersistedData(
          this.persistencePath,
          (/** @type {any} */ data) => {
            if (Array.isArray(data) && data.length > 0) {
              this.queue = data;
              logger.info(
                `[EmbeddingQueue] Restored ${this.queue.length} pending embeddings from disk`
              );
            }
          },
          'pending embeddings',
          { key: this._persistenceKeys.queue }
        );

        // Load failed items
        await loadPersistedData(
          this.failedItemsPath,
          (/** @type {any} */ data) => {
            if (data && typeof data === 'object') {
              // Handle object format { id: itemData } and array formats:
              // - [[id, itemData], ...] (persistMap)
              // - [{ id, item, ... }, ...]
              const entries = Array.isArray(data)
                ? data
                    .map((entry) => {
                      if (Array.isArray(entry) && entry.length === 2) {
                        return entry;
                      }
                      const id = entry?.id || entry?.item?.id;
                      return id ? [id, entry] : null;
                    })
                    .filter(Boolean)
                : Object.entries(data);
              for (const [id, itemData] of entries) {
                if (id && itemData && itemData.item) {
                  this._failedItemHandler.failedItems.set(id, itemData);
                }
              }
              if (this._failedItemHandler.failedItems.size > 0) {
                logger.info(
                  `[EmbeddingQueue] Restored ${this._failedItemHandler.failedItems.size} failed items awaiting retry`
                );
              }
            }
          },
          'failed items',
          { key: this._persistenceKeys.failedItems }
        );

        // Load dead letter queue
        await loadPersistedData(
          this.deadLetterPath,
          (/** @type {any} */ data) => {
            if (Array.isArray(data) && data.length > 0) {
              this._failedItemHandler.setDeadLetterQueue(data);
              logger.info(`[EmbeddingQueue] Loaded ${data.length} items in dead letter queue`);
            }
          },
          'dead letter queue',
          { key: this._persistenceKeys.deadLetter }
        );

        // Load pending removals that survived a crash.
        // These are IDs that were queued for removal during a flush but the
        // flush never completed (app crashed). Apply them now before any flush.
        await loadPersistedData(
          this.persistencePath,
          (/** @type {any} */ data) => {
            if (Array.isArray(data) && data.length > 0) {
              for (const id of data) {
                if (typeof id === 'string') this._pendingRemovals.add(id);
              }
              logger.info(
                `[EmbeddingQueue] Restored ${this._pendingRemovals.size} pending removals from crash recovery`
              );
            }
          },
          'pending removals',
          {
            key: this._persistenceKeys.pendingRemovals,
            jsonPath: this._pendingRemovalsJsonPath
          }
        );

        // All persisted state loaded — safe to allow persists (clears the
        // latch if a previous initialize() attempt failed and reset() reran us).
        this._persistBlocked = false;

        if (this.queue.length > 0 || this._failedItemHandler.failedItems.size > 0) {
          this.scheduleFlush();
        }
      } catch (error) {
        logger.error('[EmbeddingQueue] Initialization error:', error);
        // The in-memory state is empty/partial while the on-disk state may
        // still hold pending embeddings. Latch persists off so the next
        // persistQueue()/trackFailedItem persist can't overwrite (and lose)
        // the persisted data with this incomplete snapshot.
        this._persistBlocked = true;
        logger.warn(
          '[EmbeddingQueue] Persisted-state load failed — blocking queue/failed-item persists to preserve on-disk data'
        );
        // Returning without re-throwing lets initGuard mark initialized,
        // preventing permanent deadlock on subsequent initialize() calls.
      }
    });
  }

  /**
   * Add an item to the embedding queue
   * @param {any} item
   */
  async enqueue(item) {
    if (this._isShuttingDown) {
      logger.warn('[EmbeddingQueue] Rejecting enqueue — shutdown in progress', { id: item?.id });
      return { success: false, reason: 'shutting_down' };
    }

    if (!item || !item.id || !item.vector) {
      logger.warn('[EmbeddingQueue] Invalid item ignored', { id: item?.id });
      return { success: false, reason: 'invalid_item' };
    }

    // Initialize BEFORE any validation that calls trackFailedItem: the
    // handler's fire-and-forget persist would otherwise run against the
    // not-yet-loaded failedItems map and replace the whole persisted
    // failedItems key with a one-entry map.
    if (!this.initialized) {
      await this.initialize();
    }

    if (!Array.isArray(item.vector) || item.vector.length === 0) {
      logger.warn('[EmbeddingQueue] Invalid vector - must be non-empty array', {
        id: item.id,
        vectorType: typeof item.vector,
        isArray: Array.isArray(item.vector),
        length: item.vector?.length
      });
      this._failedItemHandler.trackFailedItem(item, 'invalid_vector_format');
      return { success: false, reason: 'invalid_vector_format' };
    }

    // NaN/Infinity in any position will corrupt similarity calculations
    // Performance: Typical embedding vectors are 384-4096 dimensions, checking all is fast
    let vectorSanitized = false;
    let invalidCount = 0;
    const vectorLength = item.vector.length;
    const sanitizedVector = new Array(vectorLength);
    for (let idx = 0; idx < vectorLength; idx++) {
      const val = item.vector[idx];
      if (typeof val !== 'number' || !Number.isFinite(val)) {
        invalidCount += 1;
        vectorSanitized = true;
        sanitizedVector[idx] = 0;
      } else {
        sanitizedVector[idx] = val;
      }
    }
    if (vectorSanitized) {
      // Reject vectors where more than 5% of dimensions are invalid — partially-
      // corrupted vectors with many zeroed values will distort similarity search.
      // Allow trivial corruption (1-2 values in a 384-dim vector) to be zeroed.
      const corruptionRatio = invalidCount / vectorLength;
      if (invalidCount === vectorLength || corruptionRatio > 0.05) {
        logger.warn('[EmbeddingQueue] Rejecting vector with excessive invalid values', {
          id: item.id,
          invalidCount,
          vectorLength,
          corruptionPercent: Math.round(corruptionRatio * 100)
        });
        this._failedItemHandler.trackFailedItem(item, 'invalid_vector_values');
        return { success: false, reason: 'invalid_vector_values' };
      }
      item.vector = sanitizedVector;
      logger.warn('[EmbeddingQueue] Sanitized vector with minor invalid values', {
        id: item.id,
        invalidCount,
        vectorLength
      });
    }

    /** @type {{ success: boolean, warnings: string[], reason?: string }} */
    const result = { success: true, warnings: [] };
    if (vectorSanitized) {
      result.warnings.push('vector_sanitized');
    }

    // Memory monitoring
    if (this.queue.length >= this.MEMORY_WARNING_THRESHOLD && !this.memoryWarningLogged) {
      const capacityPercent = Math.round((this.queue.length / this.MAX_QUEUE_SIZE) * 100);
      logger.warn(
        `[EmbeddingQueue] Queue at ${capacityPercent}% capacity - approaching high watermark`
      );
      this.memoryWarningLogged = true;
      result.warnings.push('high_watermark');
    }

    if (this.queue.length >= this.CRITICAL_WARNING_THRESHOLD && !this.criticalWarningLogged) {
      const capacityPercent = Math.round((this.queue.length / this.MAX_QUEUE_SIZE) * 100);
      logger.error(
        `[EmbeddingQueue] CRITICAL: Queue at ${capacityPercent}% capacity - flush may be failing`
      );
      this.criticalWarningLogged = true;
      result.warnings.push('critical_watermark');
    }

    // Reset warning flags below thresholds
    if (this.queue.length < this.MEMORY_WARNING_THRESHOLD * 0.5) {
      this.memoryWarningLogged = false;
    }
    if (this.queue.length < this.CRITICAL_WARNING_THRESHOLD * 0.5) {
      this.criticalWarningLogged = false;
    }

    // A fresh enqueue supersedes any removal queued for the same id while a
    // flush was in progress (removeByFilePath-then-enqueue re-analysis flow);
    // otherwise the post-flush removal sweep would delete the new item.
    if (this._pendingRemovals?.has(item.id)) {
      this._pendingRemovals.delete(item.id);
      this._persistPendingRemovals();
    }

    // Dedup by id: re-analyzing a file enqueues a fresh vector for the same
    // document id. Replace the stale pending entry in place so the queue holds
    // one (latest) vector per id instead of flushing duplicates in order.
    const existingIndex = this.queue.findIndex((queued) => queued?.id === item.id);
    if (existingIndex !== -1) {
      this.queue[existingIndex] = item;
      result.warnings.push('replaced_pending_duplicate');
    }

    // Enforce max queue size with backpressure instead of dropping data
    if (existingIndex === -1 && this.queue.length >= this.MAX_QUEUE_SIZE) {
      const capacityPercent = Math.round((this.queue.length / this.MAX_QUEUE_SIZE) * 100);
      logger.error(
        `[EmbeddingQueue] Queue full (${capacityPercent}% capacity) - diverting item to failed queue (backpressure)`,
        { id: item.id }
      );
      this._failedItemHandler.trackFailedItem(item, 'queue_overflow');
      await this.persistQueue().catch((/** @type {any} */ err) =>
        logger.warn('[EmbeddingQueue] Failed to persist after overflow backpressure:', err.message)
      );
      result.success = false;
      result.reason = 'queue_overflow';
      result.warnings.push('queue_overflow');
      return result;
    }

    if (existingIndex === -1) {
      this.queue.push(item);
    }

    // Debounced persist: coalesce rapid enqueue() calls into a single disk write
    if (!this._persistDebounceTimer) {
      this._persistDebounceTimer = setTimeout(() => {
        this._persistDebounceTimer = null;

        if (this._isShuttingDown) return;
        this._pendingPersistence = this.persistQueue()
          .catch((err) => logger.warn('[EmbeddingQueue] Failed to persist queue:', err.message))
          .finally(() => {
            this._pendingPersistence = null;
          });
      }, 500);
      // Allow process to exit if this timer is the only thing keeping it alive
      if (typeof this._persistDebounceTimer.unref === 'function') {
        this._persistDebounceTimer.unref();
      }
    }

    if (this.queue.length >= this.BATCH_SIZE) {
      // Honor the exponential error backoff: while a retry timer from a
      // previous flush failure is pending, don't fire an immediate flush —
      // that would defeat the backoff window. The retry timer itself calls
      // scheduleFlush(), so the queued items are never stranded.
      const backoffPending = this._retryTimers.size > 0;
      if (!backoffPending) {
        if (this._pendingFlush || this.isFlushing) {
          // Gate like scheduleFlush(): a flush is already kicked/in flight.
          // Stacking another flush() here would park each extra caller on the
          // mutex for up to TIMEOUTS.MUTEX_ACQUIRE and pile up waiters. The
          // in-flight flush reschedules itself when the queue is still
          // non-empty; arm the delayed timer as a belt-and-braces follow-up.
          this.scheduleFlush();
        } else {
          this._pendingFlush = this.flush()
            .catch((err) => logger.error('[EmbeddingQueue] Flush failed:', err.message))
            .finally(() => {
              this._pendingFlush = null;
            });
        }
      }
    } else {
      this.scheduleFlush();
    }

    return result;
  }

  /**
   * Schedule a delayed flush
   */
  scheduleFlush() {
    if (this._isShuttingDown) return;
    if (this.flushTimer) return;

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      // If a flush is already in progress, reschedule to avoid overriding _pendingFlush.
      if (this._pendingFlush || this.isFlushing) {
        this.scheduleFlush();
        return;
      }
      this._pendingFlush = this.flush()
        .catch((err) => {
          logger.error('[EmbeddingQueue] Delayed flush failed:', err.message);
        })
        .finally(() => {
          this._pendingFlush = null;
        });
    }, this.FLUSH_DELAY_MS);
    // Allow the process to exit if this flush timer is the only thing keeping it
    // alive — parity with _persistDebounceTimer and _scheduleRetry. In the
    // Electron main process the app/window keeps the loop alive, so unref'ing a
    // 50ms flush timer cannot cause a premature exit; it only stops a lone
    // pending flush from pinning a short-lived loop (jest worker / CLI).
    if (typeof this.flushTimer.unref === 'function') {
      this.flushTimer.unref();
    }
  }

  /** @param {number} backoffDelay */
  _scheduleRetry(backoffDelay) {
    if (this._isShuttingDown) return;
    const retryTimer = setTimeout(() => {
      this._retryTimers.delete(retryTimer);
      if (this._isShuttingDown) return;
      this.scheduleFlush();
    }, backoffDelay);
    this._retryTimers.add(retryTimer);
    if (retryTimer.unref) retryTimer.unref();
  }

  /**
   * Persist queue to disk
   */
  async persistQueue() {
    if (this._isShutdownComplete) {
      logger.debug('[EmbeddingQueue] Skipping queue persist — shutdown already completed');
      return;
    }
    if (this._persistBlocked) {
      logger.warn(
        '[EmbeddingQueue] Skipping queue persist — persisted-state load failed; refusing to overwrite on-disk queue'
      );
      return;
    }
    await persistQueueData(this.persistencePath, this.queue, { key: this._persistenceKeys.queue });
  }

  /**
   * Persist pending removals to disk so they survive crashes during flush.
   * Fire-and-forget at the call site, but the promise is registered with
   * `_outstandingPersistence` so `shutdown()` (line ~1279) drains it before
   * exiting. Without that registration the persist could be in flight when
   * the process exits, dropping the on-disk state of `_pendingRemovals`
   * and re-leaking removed items into the queue on next boot.
   * @private
   */
  _persistPendingRemovals() {
    if (this._isShutdownComplete) {
      logger.debug(
        '[EmbeddingQueue] Skipping pending-removals persist — shutdown already completed'
      );
      return;
    }
    if (this._persistBlocked) {
      // Load failed: the in-memory pendingRemovals set may be missing entries
      // that are still recorded on disk; overwriting would re-leak removed
      // items into the queue on the next boot. Preserve the on-disk state.
      logger.warn(
        '[EmbeddingQueue] Skipping pending-removals persist — persisted-state load failed'
      );
      return;
    }
    const data = Array.from(this._pendingRemovals);
    const promise = persistQueueData(this.persistencePath, data, {
      key: this._persistenceKeys.pendingRemovals,
      jsonPath: this._pendingRemovalsJsonPath
    }).catch((err) => {
      logger.warn('[EmbeddingQueue] Failed to persist pending removals', {
        error: err?.message
      });
    });
    // Track in the outstanding-persistence set so shutdown() awaits it.
    // Use the .finally hook to deregister, so a slow or hung persist that
    // outlives the drain budget still gets unregistered eventually rather
    // than holding the set non-empty indefinitely.
    if (this._outstandingPersistence && typeof this._outstandingPersistence.add === 'function') {
      this._outstandingPersistence.add(promise);
      // eslint-disable-next-line promise/catch-or-return -- bookkeeping-only .finally; the promise's resolution and rejection are both handled at its caller, here we only deregister from the outstanding-set
      promise.finally(() => {
        this._outstandingPersistence.delete(promise);
        return undefined;
      });
    }
  }

  /**
   * Flush pending embeddings to vector DB
   * Uses mutex to prevent race conditions from concurrent flush calls
   */
  async flush() {
    // Acquire mutex to prevent concurrent flush operations
    const release = await this._acquireFlushMutex();

    try {
      // Check conditions after acquiring mutex (double-check pattern)
      if (this.isFlushing || this.queue.length === 0) {
        return;
      }

      this.isFlushing = true;
      // Publish a handle to THIS in-flight worker so forceFlush awaits the real
      // flush rather than the externally-reassignable _pendingFlush. Resolve-only
      // (never reject) so an un-awaited handle can't raise unhandledRejection.
      let resolveActiveFlush;
      this._activeFlush = new Promise((resolve) => {
        resolveActiveFlush = resolve;
      });
      const flushStartTime = Date.now();

      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }

      const batchSize = Math.min(this.queue.length, this.BATCH_SIZE);
      const batch = this.queue.slice(0, batchSize);
      // Ids removed from the queue during this flush (applied pending removals).
      // The persist-failure re-add path consults this so it never resurrects an
      // item the user deleted mid-flush.
      const removedDuringFlush = new Set();

      this._notifyProgress({
        phase: 'start',
        total: batch.length,
        completed: 0,
        percent: 0,
        queueRemaining: this.queue.length - batchSize
      });

      try {
        logger.debug('[EmbeddingQueue] Flushing batch', { count: batch.length });

        let vectorDbService;
        try {
          vectorDbService = container.resolve(ServiceIds.ORAMA_VECTOR);
        } catch (resolveError) {
          logger.error(
            '[EmbeddingQueue] Failed to resolve vector DB service:',
            resolveError.message
          );
          await this._handleOfflineDatabase(batch, batchSize);
          return;
        }

        if (!vectorDbService) {
          logger.error('[EmbeddingQueue] Vector DB service is null');
          await this._handleOfflineDatabase(batch, batchSize);
          return;
        }

        await vectorDbService.initialize();

        if (!vectorDbService.isOnline) {
          await this._handleOfflineDatabase(batch, batchSize);
          return;
        }

        // A working online flush means both retry episodes are over.
        this.retryCount = 0;
        this._offlineRetryCount = 0;

        const fileItems = [];
        const folderItems = [];

        // Single pass segregation (Fix: Avoid double filtering)
        // Also skip items that were marked for removal during flush
        for (const item of batch) {
          if (this._pendingRemovals?.has(item.id)) continue;
          if (item.id.startsWith('folder:')) {
            folderItems.push(item);
          } else {
            fileItems.push(item);
          }
        }
        const failedItemIds = new Set();
        let processedCount = 0;

        // Process files
        if (fileItems.length > 0) {
          processedCount = await processItemsInParallel({
            items: fileItems,
            type: 'file',
            vectorDbService,
            failedItemIds,
            startProcessedCount: processedCount,
            totalBatchSize: batch.length,
            concurrency: this.PARALLEL_FLUSH_CONCURRENCY,
            onProgress: (p) => this._notifyProgress(p),
            onItemFailed: (item, err) => this._failedItemHandler.trackFailedItem(item, err)
          });
        }

        // Process folders
        // The void operator was causing folder processing counts to be lost
        if (folderItems.length > 0) {
          // Note: processedCount is used as input via startProcessedCount
          processedCount = await processItemsInParallel({
            items: folderItems,
            type: 'folder',
            vectorDbService,
            failedItemIds,
            startProcessedCount: processedCount,
            totalBatchSize: batch.length,
            concurrency: this.PARALLEL_FLUSH_CONCURRENCY,
            onProgress: (p) => this._notifyProgress(p),
            onItemFailed: (item, err) => this._failedItemHandler.trackFailedItem(item, err)
          });
        }

        // Remove only the exact batch items by object identity.
        // This prevents dropping a newer re-enqueue with the same ID.
        const processedItems = new Set(batch);
        this.queue = this.queue.filter((item) => !processedItems.has(item));

        if (this._pendingRemovals?.size) {
          const pending = this._pendingRemovals;
          this._pendingRemovals = new Set();
          const beforeCount = this.queue.length;
          this.queue = this.queue.filter((item) => !pending.has(item.id));
          for (const id of pending) {
            this._failedItemHandler.failedItems.delete(id);
            removedDuringFlush.add(id);
          }
          const pendingRemoved = beforeCount - this.queue.length;
          if (pendingRemoved > 0) {
            logger.debug('[EmbeddingQueue] Applied pending removals after flush', {
              removedCount: pendingRemoved
            });
          }
          // Clear persisted pending removals now that they've been applied
          this._persistPendingRemovals();
        }

        // Clear failed-item records for items that succeeded in this batch
        let clearedFailed = 0;
        for (const item of batch) {
          if (!failedItemIds.has(item.id)) {
            if (this._failedItemHandler.failedItems.delete(item.id)) {
              clearedFailed += 1;
            }
          }
        }

        const flushDuration = Date.now() - flushStartTime;
        const successCount = batch.length - failedItemIds.size;

        logger.info('[EmbeddingQueue] Successfully flushed batch', {
          success: successCount,
          failed: failedItemIds.size,
          processed: processedCount,
          remaining: this.queue.length,
          duration: `${flushDuration}ms`
        });

        this._notifyProgress({
          phase: 'complete',
          total: batch.length,
          completed: successCount,
          failed: failedItemIds.size,
          processed: processedCount,
          percent: 100,
          queueRemaining: this.queue.length,
          duration: flushDuration
        });

        try {
          // Durability barrier: the just-failed items were removed from
          // this.queue above (by batch identity) and so are excluded from the
          // queue persist below. Their only on-disk record so far is the
          // non-awaited persist inside trackFailedItem, so a hard kill between
          // the queue persist and that fire-and-forget write would leave those
          // items in NEITHER file — silently dropping their files from indexing.
          // Persist failed items durably FIRST so they survive the same crash
          // window. (The prior-failed cleanup case is persisted below via
          // clearedFailed; only pay this extra write when this batch failed.)
          if (failedItemIds.size > 0) {
            await this._failedItemHandler.persistAll();
          }
          if (this._persistBlocked) {
            // Load failed at startup: the on-disk queue still holds pending
            // embeddings that never made it into memory. Skip the persist (do
            // not throw — the batch WAS flushed to the vector DB). Worst case
            // the flushed items re-flush from disk on the next start, which
            // the vector DB upsert handles idempotently.
            logger.warn(
              '[EmbeddingQueue] Skipping post-flush queue persist — persisted-state load failed; on-disk queue preserved'
            );
          } else {
            await persistQueueData(this.persistencePath, this.queue, {
              key: this._persistenceKeys.queue,
              throwOnError: true
            });
          }
        } catch (persistError) {
          // Re-add batch items to avoid silent data loss on disk failure, but
          // only items that are still safe to restore. Skipping ids removed
          // during this flush avoids resurrecting a user-deleted item; skipping
          // ids already in the queue (a concurrent re-enqueue) or freshly
          // pending-removed avoids duplicating a live queue entry.
          const queueIds = new Set(this.queue.map((item) => item.id));
          const itemsToReAdd = batch.filter(
            (item) =>
              !removedDuringFlush.has(item.id) &&
              !this._pendingRemovals?.has(item.id) &&
              !queueIds.has(item.id)
          );
          logger.error('[EmbeddingQueue] Persistence failed after flush, re-adding batch items', {
            error: persistError.message,
            batchSize: batch.length,
            reAdded: itemsToReAdd.length,
            skipped: batch.length - itemsToReAdd.length
          });
          this.queue.unshift(...itemsToReAdd);
          throw persistError;
        }
        await this._failedItemHandler.retryFailedItems(this.queue, () => this.persistQueue());
        if (clearedFailed > 0) {
          await this._failedItemHandler
            .persistAll()
            .catch((/** @type {any} */ err) =>
              logger.warn('[EmbeddingQueue] Failed to persist failed items cleanup:', err.message)
            );
        }

        await this._syncEmbeddingStatusAfterFlush(fileItems, failedItemIds);

        if (this.queue.length > 0) {
          this.scheduleFlush();
        }
      } catch (error) {
        logger.error('[EmbeddingQueue] Flush error:', error.message);
        this._notifyProgress({
          phase: 'error',
          error: error.message,
          retryCount: this.retryCount
        });

        this.retryCount++;
        const backoffDelay = Math.min(
          RETRY.BACKOFF_BASE_MS * 2 ** (this.retryCount - 1),
          RETRY.BACKOFF_MAX_MS
        );
        logger.info(`[EmbeddingQueue] Will retry in ${backoffDelay / 1000}s`);
        this._scheduleRetry(backoffDelay);
      } finally {
        this.isFlushing = false;
        // Settle and drop the in-flight handle in lockstep with isFlushing so
        // forceFlush's `isFlushing && _activeFlush` read never sees a torn pair.
        if (resolveActiveFlush) resolveActiveFlush();
        this._activeFlush = null;
      }
    } finally {
      // Always release the mutex
      release();
    }
  }

  /**
   * Mark analysis-history and durable ready-queue embedding status after a
   * successful flush so Discover UI and processing-state.json reflect indexed files.
   *
   * @param {any[]} fileItems
   * @param {Set<string>} failedItemIds
   * @private
   */
  async _syncEmbeddingStatusAfterFlush(fileItems, failedItemIds) {
    if (!Array.isArray(fileItems) || fileItems.length === 0) return;

    let analysisHistoryService = null;
    let processingStateService = null;
    try {
      analysisHistoryService = container.resolve(ServiceIds.ANALYSIS_HISTORY);
    } catch {
      // Optional during early startup
    }
    try {
      processingStateService = container.resolve(ServiceIds.PROCESSING_STATE);
    } catch {
      // Optional during early startup
    }

    for (const item of fileItems) {
      if (failedItemIds?.has(item.id)) continue;
      const filePath = item.path || item.meta?.filePath || item.meta?.path;
      if (typeof filePath !== 'string' || !filePath) continue;

      try {
        await analysisHistoryService?.updateEmbeddingStateByPath?.(filePath, { status: 'done' });
      } catch (err) {
        logger.debug('[EmbeddingQueue] Analysis history embedding status update failed', {
          filePath,
          error: err?.message
        });
      }

      try {
        await processingStateService?.updateReadyEmbeddingStatus?.(filePath, 'done');
      } catch (err) {
        logger.debug('[EmbeddingQueue] Ready-queue embedding status update failed', {
          filePath,
          error: err?.message
        });
      }
    }
  }

  /**
   * Handle offline database scenario
   * @param {any[]} batch
   * @param {number} _batchSize
   */
  async _handleOfflineDatabase(batch, _batchSize) {
    this._offlineRetryCount++;

    this._notifyProgress({
      phase: 'offline',
      total: batch.length,
      completed: 0,
      retryCount: this._offlineRetryCount,
      maxRetries: this.MAX_RETRY_COUNT
    });

    if (this._offlineRetryCount >= this.MAX_RETRY_COUNT) {
      logger.error(
        `[EmbeddingQueue] Database offline after ${this.MAX_RETRY_COUNT} retries, moving items to failed queue`
      );
      for (const item of batch) {
        this._failedItemHandler.trackFailedItem(item, 'Database offline');
      }
      // Remove only the exact batch items by object identity.
      // Queue may have been mutated while flush was in progress.
      const batchItems = new Set(batch);
      this.queue = this.queue.filter((item) => !batchItems.has(item));
      this._offlineRetryCount = 0;
      await this.persistQueue();

      // This allows UI listeners to know the batch failed permanently
      this._notifyProgress({
        phase: 'fatal_error',
        total: batch.length,
        completed: 0,
        failed: batch.length,
        error: `Database offline after ${this.MAX_RETRY_COUNT} retries`
      });

      return;
    }

    logger.warn(
      `[EmbeddingQueue] Database offline, will retry (${this._offlineRetryCount}/${this.MAX_RETRY_COUNT})`
    );

    const backoffDelay = Math.min(
      RETRY.BACKOFF_BASE_MS * 2 ** (this._offlineRetryCount - 1),
      RETRY.BACKOFF_MAX_MS
    );
    logger.info(`[EmbeddingQueue] Retry in ${backoffDelay / 1000}s`);
    this._scheduleRetry(backoffDelay);
  }

  /**
   * Remove pending items by file path
   * Call this when a file is deleted to prevent orphaned embeddings
   * @param {string} filePath - The file path to remove
   * @returns {number} Number of items removed
   */
  removeByFilePath(filePath) {
    if (!filePath) return 0;

    const fileIds = new Set(getAllIdVariants(filePath));
    let removedCount = 0;

    if (this.isFlushing) {
      for (const item of this.queue) {
        if (fileIds.has(item.id)) {
          removedCount++;
        }
      }
      for (const id of fileIds) {
        this._pendingRemovals.add(id);
      }
      // Persist pending removals so they survive a crash during flush
      this._persistPendingRemovals();
      if (removedCount > 0) {
        logger.debug('[EmbeddingQueue] Queued removals for deleted file (flush in progress)', {
          filePath,
          removedCount
        });
      }
      return removedCount;
    }

    // Remove from main queue using in-place splice to avoid replacing the array
    // reference while flush() holds a stale batchSize from the same array
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (fileIds.has(this.queue[i].id)) {
        this.queue.splice(i, 1);
        removedCount++;
      }
    }

    // Remove from failed items
    fileIds.forEach((id) => this._failedItemHandler.failedItems.delete(id));

    if (removedCount > 0) {
      logger.debug('[EmbeddingQueue] Removed pending items for deleted file', {
        filePath,
        removedCount
      });
      // Persist the updated queue — track the promise for shutdown coordination
      const p = this.persistQueue()
        .catch((err) =>
          logger.warn('[EmbeddingQueue] Failed to persist after removal:', err.message)
        )
        .finally(() => this._outstandingPersistence.delete(p));
      this._outstandingPersistence.add(p);
    }

    return removedCount;
  }

  /**
   * Remove pending items by multiple file paths (batch operation)
   * @param {string[]} filePaths - Array of file paths to remove
   * @returns {number} Total number of items removed
   */
  removeByFilePaths(filePaths) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) return 0;

    const fileIds = new Set(filePaths.flatMap((p) => getAllIdVariants(p)));
    let removedCount = 0;

    if (this.isFlushing) {
      for (const item of this.queue) {
        if (fileIds.has(item.id)) {
          removedCount++;
        }
      }
      for (const id of fileIds) {
        this._pendingRemovals.add(id);
      }
      this._persistPendingRemovals();
      if (removedCount > 0) {
        logger.debug('[EmbeddingQueue] Queued removals for deleted files (flush in progress)', {
          fileCount: filePaths.length,
          removedCount
        });
      }
      return removedCount;
    }

    // Remove from main queue using in-place splice to avoid replacing the array
    // reference while flush() holds a stale batchSize from the same array
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (fileIds.has(this.queue[i].id)) {
        this.queue.splice(i, 1);
        removedCount++;
      }
    }

    // Remove from failed items
    for (const fileId of fileIds) {
      if (this._failedItemHandler.failedItems.has(fileId)) {
        this._failedItemHandler.failedItems.delete(fileId);
      }
    }

    if (removedCount > 0) {
      logger.debug('[EmbeddingQueue] Removed pending items for deleted files', {
        fileCount: filePaths.length,
        removedCount
      });
      // Persist the updated queue — track the promise for shutdown coordination
      const p = this.persistQueue()
        .catch((err) =>
          logger.warn('[EmbeddingQueue] Failed to persist after batch removal:', err.message)
        )
        .finally(() => this._outstandingPersistence.delete(p));
      this._outstandingPersistence.add(p);
    }

    return removedCount;
  }

  /**
   * Internal helper to update paths in queue and failed items
   * @param {string} oldPath
   * @param {string} newPath
   * @returns {{queueUpdated: number, failedUpdated: boolean}}
   * @private
   */
  _updatePath(oldPath, newPath) {
    if (!oldPath || !newPath) return { queueUpdated: 0, failedUpdated: false };

    const idPairs = buildPathUpdatePairs(oldPath, newPath);

    let queueUpdated = 0;
    let failedUpdated = false;

    for (const { oldId, newId } of idPairs) {
      // Update main queue items in-place
      for (const item of this.queue) {
        if (item?.id === oldId) {
          item.id = newId;
          if (item.meta && typeof item.meta === 'object') {
            item.meta.path = newPath;
            if (typeof item.meta.name === 'string') {
              item.meta.name = newPath.split(/[\\/]/).pop();
            }
          }
          queueUpdated++;
        }
      }

      // Update failed items map keys
      const failed = this._failedItemHandler.failedItems.get(oldId);
      if (failed) {
        this._failedItemHandler.failedItems.delete(oldId);
        // Keep the stored item consistent
        if (failed.item && typeof failed.item === 'object') {
          failed.item.id = newId;
          if (failed.item.meta && typeof failed.item.meta === 'object') {
            failed.item.meta.path = newPath;
            if (typeof failed.item.meta.name === 'string') {
              failed.item.meta.name = newPath.split(/[\\/]/).pop();
            }
          }
        }
        this._failedItemHandler.failedItems.set(newId, failed);
        failedUpdated = true;
      }
    }

    return { queueUpdated, failedUpdated };
  }

  /**
   * Update pending items by file path after a move/rename.
   * This prevents queued embeddings from being flushed under stale IDs.
   *
   * Updates both file: and image: prefixed IDs and also updates failed items.
   *
   * @param {string} oldPath
   * @param {string} newPath
   * @returns {number} Number of queued items updated
   */
  updateByFilePath(oldPath, newPath) {
    const { queueUpdated, failedUpdated } = this._updatePath(oldPath, newPath);

    // PATH-TRACE: Log embedding queue path update
    if (queueUpdated > 0 || failedUpdated) {
      traceQueueUpdate(oldPath, newPath, queueUpdated + (failedUpdated ? 1 : 0));
    }

    if (queueUpdated > 0) {
      const p = this.persistQueue()
        .catch((err) =>
          logger.warn('[EmbeddingQueue] Failed to persist after path update:', err.message)
        )
        .finally(() => this._outstandingPersistence.delete(p));
      this._outstandingPersistence.add(p);
    }

    if (failedUpdated) {
      const p = this._failedItemHandler
        .persistAll()
        .catch((/** @type {any} */ err) =>
          logger.warn(
            '[EmbeddingQueue] Failed to persist failed items after path update:',
            err.message
          )
        )
        .finally(() => this._outstandingPersistence.delete(p));
      this._outstandingPersistence.add(p);
    }

    return queueUpdated;
  }

  /**
   * Batch update pending items by multiple file path changes.
   * @param {Array<{oldPath: string, newPath: string}>} pathChanges
   * @returns {number} Total updated count
   */
  updateByFilePaths(pathChanges) {
    if (!Array.isArray(pathChanges) || pathChanges.length === 0) return 0;

    let totalQueueUpdated = 0;
    let anyFailedUpdated = false;

    for (const change of pathChanges) {
      if (!change?.oldPath || !change?.newPath) continue;
      const { queueUpdated, failedUpdated } = this._updatePath(change.oldPath, change.newPath);
      totalQueueUpdated += queueUpdated;
      if (failedUpdated) anyFailedUpdated = true;
    }

    if (totalQueueUpdated > 0) {
      const p = this.persistQueue()
        .catch((err) =>
          logger.warn('[EmbeddingQueue] Failed to persist after batch path update:', err.message)
        )
        .finally(() => this._outstandingPersistence.delete(p));
      this._outstandingPersistence.add(p);
    }

    if (anyFailedUpdated) {
      const p = this._failedItemHandler
        .persistAll()
        .catch((/** @type {any} */ err) =>
          logger.warn(
            '[EmbeddingQueue] Failed to persist failed items after batch path update:',
            err.message
          )
        )
        .finally(() => this._outstandingPersistence.delete(p));
      this._outstandingPersistence.add(p);
    }

    return totalQueueUpdated;
  }

  /**
   * Get queue statistics
   */
  getStats() {
    const capacityPercent = Math.round((this.queue.length / this.MAX_QUEUE_SIZE) * 100);
    let healthStatus = 'healthy';
    if (capacityPercent >= this.CRITICAL_WATERMARK * 100) {
      healthStatus = 'critical';
    } else if (capacityPercent >= this.HIGH_WATERMARK * 100) {
      healthStatus = 'warning';
    }

    const failedStats = this._failedItemHandler.getStats();

    return {
      queueLength: this.queue.length,
      maxQueueSize: this.MAX_QUEUE_SIZE,
      capacityPercent,
      healthStatus,
      isFlushing: this.isFlushing,
      retryCount: this.retryCount,
      maxRetryCount: this.MAX_RETRY_COUNT,
      highWatermark: this.MEMORY_WARNING_THRESHOLD,
      criticalWatermark: this.CRITICAL_WARNING_THRESHOLD,
      isInitialized: this.initialized,
      hasHighWatermarkWarning: this.memoryWarningLogged,
      hasCriticalWarning: this.criticalWarningLogged,
      ...failedStats
    };
  }

  /**
   * Get dead letter items
   */
  getDeadLetterItems(limit = 100) {
    return this._failedItemHandler.getDeadLetterItems(limit);
  }

  /**
   * Clear dead letter queue
   */
  async clearDeadLetterQueue() {
    return this._failedItemHandler.clearDeadLetterQueue();
  }

  /**
   * Retry a dead letter item
   * @param {string} itemId
   */
  async retryDeadLetterItem(itemId) {
    const result = await this._failedItemHandler.retryDeadLetterItem(itemId, this.queue, () =>
      this.persistQueue()
    );
    if (result) this.scheduleFlush();
    return result;
  }

  /**
   * Retry all dead letter items
   */
  async retryAllDeadLetterItems() {
    const count = await this._failedItemHandler.retryAllDeadLetterItems(this.queue, () =>
      this.persistQueue()
    );
    if (count > 0) this.scheduleFlush();
    return count;
  }

  /**
   * Force flush immediately
   */
  async forceFlush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Await the existing flush promise instead of busy-wait polling.
    // This is both more efficient and avoids hogging the event loop.
    if (this.isFlushing && this._activeFlush) {
      logger.info('[EmbeddingQueue] Waiting for current flush to complete...');
      const maxWait = 30000;
      /** @type {NodeJS.Timeout | undefined} */
      let forceFlushTimer;
      try {
        await Promise.race([
          this._activeFlush,
          new Promise((_, reject) => {
            forceFlushTimer = setTimeout(() => {
              reject(
                Object.assign(new Error('Force flush timeout waiting for current flush'), {
                  code: ERROR_CODES.TIMEOUT
                })
              );
            }, maxWait);
            if (forceFlushTimer.unref) forceFlushTimer.unref();
          })
        ]).finally(() => {
          if (forceFlushTimer) clearTimeout(forceFlushTimer);
        });
      } catch (/** @type {any} */ err) {
        if (err.code === ERROR_CODES.TIMEOUT) {
          logger.warn(
            '[EmbeddingQueue] Force flush timeout - current flush still in progress after 30s. Proceeding with persistence only.',
            { queueLength: this.queue.length }
          );
          await this.persistQueue();
          await this._failedItemHandler.persistAll();
          logger.info('[EmbeddingQueue] Force flush completed (persistence only due to timeout)');
          return;
        }
        // Other errors from the flush itself are non-fatal here
        logger.warn(
          '[EmbeddingQueue] Pending flush resolved with error during forceFlush:',
          err.message
        );
      }
    }

    if (this.queue.length > 0) {
      logger.info(`[EmbeddingQueue] Force flushing ${this.queue.length} remaining items`);
      try {
        await this.flush();
      } catch (flushError) {
        logger.error('[EmbeddingQueue] Force flush failed:', flushError.message);
        // Continue with persistence even if flush fails
      }
    }

    await this.persistQueue();
    await this._failedItemHandler.persistAll();
    logger.info('[EmbeddingQueue] Force flush complete');
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    logger.info('[EmbeddingQueue] Shutting down...');

    // Set shutdown flag first — prevents new enqueues from being accepted
    this._isShuttingDown = true;

    if (this._persistDebounceTimer) {
      clearTimeout(this._persistDebounceTimer);
      this._persistDebounceTimer = null;
    }

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this._retryTimers.size > 0) {
      for (const timer of this._retryTimers) {
        clearTimeout(timer);
      }
      this._retryTimers.clear();
    }

    if (this._progressTracker?.clear) {
      this._progressTracker.clear();
    }

    // This prevents race conditions where async persistence from enqueue() is still running
    if (this._pendingPersistence) {
      try {
        await this._pendingPersistence;
      } catch (err) {
        logger.warn('[EmbeddingQueue] Pending persistence failed during shutdown:', err.message);
      }
    }

    if (this._pendingFlush) {
      try {
        await this._pendingFlush;
      } catch (err) {
        logger.warn('[EmbeddingQueue] Pending flush failed during shutdown:', err.message);
      }
    }

    // Drain all outstanding persistence promises from remove/update operations.
    // Loop until the set is stable: while we await one batch, fire-and-forget
    // path-update / remove handlers can add new persistence promises that the
    // single-shot snapshot would miss. Bounded by MAX_DRAIN_ATTEMPTS to avoid
    // an unbounded shutdown if a downstream caller keeps queuing work.
    const MAX_DRAIN_ATTEMPTS = 5;
    let drainAttempts = 0;
    while (this._outstandingPersistence.size > 0 && drainAttempts < MAX_DRAIN_ATTEMPTS) {
      drainAttempts += 1;
      const snapshot = [...this._outstandingPersistence];
      logger.info('[EmbeddingQueue] Waiting for outstanding persistence operations', {
        count: snapshot.length,
        attempt: drainAttempts
      });
      try {
        await Promise.allSettled(snapshot);
      } catch (err) {
        logger.warn('[EmbeddingQueue] Error draining outstanding persistence:', err.message);
      }
    }
    if (this._outstandingPersistence.size > 0) {
      logger.warn('[EmbeddingQueue] Outstanding persistence ops not fully drained at shutdown', {
        remaining: this._outstandingPersistence.size,
        attempts: drainAttempts
      });
    }

    await this.persistQueue();
    await this._failedItemHandler.persistAll();
    this._isShutdownComplete = true;
    logger.info('[EmbeddingQueue] Shutdown complete', {
      pendingItems: this.queue.length,
      failedItems: this._failedItemHandler.failedItems.size,
      deadLetterItems: this._failedItemHandler.deadLetterQueue.length
    });
  }
}

module.exports = EmbeddingQueue;
