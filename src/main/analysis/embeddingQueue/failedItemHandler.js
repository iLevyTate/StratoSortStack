// @ts-check
/**
 * Failed Item Handler Module
 *
 * Handles failed item tracking, dead letter queue, and retry logic.
 *
 * @module embeddingQueue/failedItemHandler
 */

const { createLogger } = require('../../../shared/logger');
const logger = createLogger('FailedItemHandler');
const { RETRY } = require('../../../shared/performanceConstants');
const { persistFailedItems, persistDeadLetterQueue, SQLITE_KEYS } = require('./persistence');

/**
 * Create a failed item handler instance
 * @param {object} config - Configuration
 * @param {number} config.itemMaxRetries - Max retries per item
 * @param {number} config.maxDeadLetterSize - Max dead letter queue size
 * @param {number} [config.maxFailedItemsSize] - Max failed items Map size (prevents memory exhaustion)
 * @param {string} config.failedItemsPath - Path to persist failed items
 * @param {string} config.deadLetterPath - Path to persist dead letter queue
 * @param {Record<string, string>} [config.persistenceKeys] - Override for SQLite persistence keys
 * @param {() => boolean} [config.shouldBlockPersist] - When it returns true, all disk persists
 *   are skipped (in-memory state is kept). Used by the owner to protect on-disk data after a
 *   failed initial load, where the in-memory maps are empty/partial and writing them out would
 *   replace (lose) the persisted records.
 * @returns {Record<string, any>} Failed item handler
 */
function createFailedItemHandler(config) {
  const {
    itemMaxRetries,
    maxDeadLetterSize,
    maxFailedItemsSize = 1000,
    failedItemsPath,
    deadLetterPath,
    persistenceKeys = SQLITE_KEYS
  } = config;
  const shouldBlockPersist =
    typeof config.shouldBlockPersist === 'function' ? config.shouldBlockPersist : () => false;

  /**
   * Persist the failed-items map unless the owner has latched persists off.
   * @returns {Promise<void>}
   */
  async function persistFailedItemsGuarded() {
    if (shouldBlockPersist()) {
      logger.warn('[EmbeddingQueue] Skipping failed-items persist — persist latch active');
      return;
    }
    await persistFailedItems(failedItemsPath, failedItems, { key: persistenceKeys.failedItems });
  }

  /**
   * Persist the dead-letter queue unless the owner has latched persists off.
   * @returns {Promise<void>}
   */
  async function persistDeadLetterQueueGuarded() {
    if (shouldBlockPersist()) {
      logger.warn('[EmbeddingQueue] Skipping dead-letter persist — persist latch active');
      return;
    }
    await persistDeadLetterQueue(deadLetterPath, deadLetterQueue, {
      key: persistenceKeys.deadLetter
    });
  }

  // State
  /** @type {Map<string, any>} */
  const failedItems = new Map();
  /** @type {any[]} */
  let deadLetterQueue = [];

  /** @param {any} errorMessage */
  function normalizeError(errorMessage) {
    const message =
      typeof errorMessage === 'string'
        ? errorMessage
        : errorMessage?.error || errorMessage?.message || String(errorMessage || 'unknown_error');
    const normalized = message.toLowerCase();
    const isDimensionMismatch =
      normalized.includes('dimension_mismatch') || normalized.includes('dimension mismatch');
    return {
      message,
      requiresRebuild: isDimensionMismatch,
      errorCode: isDimensionMismatch ? 'dimension_mismatch' : null
    };
  }

  /**
   * @param {any} item - The failed embedding item
   * @param {any} errorMessage - The error message (string or error-like object)
   */
  function trackFailedItem(item, errorMessage) {
    const existing = failedItems.get(item.id);
    const retryCount = existing ? existing.retryCount + 1 : 1;
    const normalizedError = normalizeError(errorMessage);

    if (normalizedError.requiresRebuild) {
      addToDeadLetterQueue(item, normalizedError.message, retryCount, {
        requiresRebuild: true,
        errorCode: normalizedError.errorCode
      });
      failedItems.delete(item.id);
      return;
    }

    if (retryCount > itemMaxRetries) {
      addToDeadLetterQueue(item, errorMessage, retryCount);
      failedItems.delete(item.id);
      return;
    }

    // Enforce maximum size with LRU eviction to prevent memory exhaustion
    if (!existing && failedItems.size >= maxFailedItemsSize) {
      // Evict oldest entry (first key in Map iteration order)
      const oldestKey = failedItems.keys().next().value;
      if (oldestKey) {
        const oldEntry = failedItems.get(oldestKey);
        failedItems.delete(oldestKey);
        // Move evicted item to dead letter queue so it's not lost
        if (oldEntry) {
          addToDeadLetterQueue(
            oldEntry.item,
            `Evicted from failed items due to capacity (was: ${oldEntry.error})`,
            oldEntry.retryCount
          );
        }
        logger.warn(
          `[EmbeddingQueue] Failed items at capacity (${maxFailedItemsSize}), evicted oldest to dead letter`,
          { evictedId: oldestKey }
        );
      }
    }

    // Map maintains insertion order, so updating an existing key doesn't move it
    // By deleting first then re-inserting, the item moves to the end (most recently used)
    if (existing) {
      failedItems.delete(item.id);
    }

    failedItems.set(item.id, {
      item,
      retryCount,
      lastAttempt: Date.now(),
      error: normalizedError.message
    });

    // Persist failed items to disk for recovery
    persistFailedItemsGuarded().catch((err) => {
      logger.warn('[EmbeddingQueue] Failed to persist failed items:', err.message);
    });

    logger.debug(
      `[EmbeddingQueue] Tracked failed item ${item.id} (retry ${retryCount}/${itemMaxRetries})`
    );
  }

  /**
   * Add an item to the dead letter queue
   * @param {Object} item - The failed embedding item
   * @param {string} errorMessage - The error message
   * @param {number} retryCount - Number of retries attempted
   */
  /**
   * @param {any} item
   * @param {any} errorMessage
   * @param {number} retryCount
   * @param {{ errorCode?: string | null, requiresRebuild?: boolean }} [options]
   */
  function addToDeadLetterQueue(item, errorMessage, retryCount, options = {}) {
    const deadLetterEntry = {
      item,
      error: errorMessage,
      errorCode: options.errorCode || null,
      requiresRebuild: options.requiresRebuild === true,
      retryCount,
      failedAt: new Date().toISOString(),
      itemId: item.id,
      itemType: item.id.startsWith('folder:') ? 'folder' : 'file'
    };

    deadLetterQueue.push(deadLetterEntry);

    // Prune oldest entries if queue exceeds capacity (push first so the queue
    // can actually hold maxDeadLetterSize items before eviction kicks in)
    while (deadLetterQueue.length > maxDeadLetterSize) {
      const pruneCount = Math.max(1, Math.floor(maxDeadLetterSize * 0.1));
      deadLetterQueue.splice(0, pruneCount);
      logger.warn(
        `[EmbeddingQueue] Dead letter queue at capacity, pruned ${pruneCount} oldest entries`
      );
    }

    logger.error(
      `[EmbeddingQueue] Item ${item.id} moved to dead letter queue after ${retryCount} failed attempts`,
      { error: errorMessage }
    );

    // Persist dead letter queue to disk
    persistDeadLetterQueueGuarded().catch((err) => {
      logger.warn('[EmbeddingQueue] Failed to persist dead letter queue:', err.message);
    });
  }

  /**
   * Get items whose exponential backoff has elapsed. Pure read: `lastAttempt`
   * is stamped by retryFailedItems only for items it actually re-queues, so an
   * item already sitting in the main queue keeps its original backoff clock
   * instead of being pushed out on every poll.
   * @param {number} [now]
   * @returns {any[]} Items ready to retry
   */
  function getItemsToRetry(now = Date.now()) {
    const itemsToRetry = [];

    for (const data of failedItems.values()) {
      // Exponential backoff per item: 10s, 20s, 40s
      // Formula: BASE_MS * 2^(retryCount-1) gives 10s, 20s, 40s for retryCount 1, 2, 3
      const backoffMs = RETRY.BACKOFF_BASE_MS * 2 ** (data.retryCount - 1);

      if (now - data.lastAttempt >= backoffMs) {
        itemsToRetry.push(data.item);
      }
    }

    return itemsToRetry;
  }

  /**
   * Retry failed items
   * @param {any[]} queue - Main queue to add retries to
   * @param {Function} persistQueue - Function to persist queue
   */
  async function retryFailedItems(queue, persistQueue) {
    const now = Date.now();
    const itemsToRetry = getItemsToRetry(now);
    if (itemsToRetry.length === 0) {
      return;
    }

    const existingIds = new Set(queue.map((item) => item?.id).filter(Boolean));
    const deduped = itemsToRetry.filter((item) => item?.id && !existingIds.has(item.id));
    if (deduped.length === 0) {
      return;
    }

    for (const item of deduped) {
      const data = failedItems.get(item.id);
      if (data) data.lastAttempt = now;
    }

    logger.info(`[EmbeddingQueue] Re-queuing ${deduped.length} failed items for retry`);
    // Prepend to queue for priority processing
    // Use splice(0, 0, ...batch) in chunks to avoid stack overflow and O(n*m) unshift loop
    queue.splice(0, 0, ...deduped);
    await persistQueue();
    await persistFailedItemsGuarded();
  }

  /**
   * Get dead letter queue items
   * @param {number} [limit] - Max items to return
   * @returns {any[]} Dead letter items
   */
  function getDeadLetterItems(limit = 100) {
    return deadLetterQueue.slice(-limit);
  }

  /**
   * Clear the dead letter queue
   * @returns {Promise<number>} Number of items cleared
   */
  async function clearDeadLetterQueue() {
    const count = deadLetterQueue.length;
    deadLetterQueue = [];
    await persistDeadLetterQueueGuarded();
    logger.info(`[EmbeddingQueue] Cleared ${count} items from dead letter queue`);
    return count;
  }

  /**
   * Retry a specific dead letter item
   * @param {string} itemId - Item ID to retry
   * @param {any[]} queue - Main queue to add to
   * @param {Function} persistQueue - Function to persist queue
   * @returns {Promise<boolean>} Success
   */
  async function retryDeadLetterItem(itemId, queue, persistQueue) {
    const index = deadLetterQueue.findIndex((entry) => entry.itemId === itemId);
    if (index === -1) {
      logger.warn(`[EmbeddingQueue] Dead letter item ${itemId} not found`);
      return false;
    }

    const entry = deadLetterQueue.splice(index, 1)[0];
    queue.push(entry.item);
    await persistQueue();
    await persistDeadLetterQueueGuarded();
    logger.info(`[EmbeddingQueue] Manually re-queued dead letter item ${itemId}`);
    return true;
  }

  /**
   * Retry all dead letter items
   * @param {any[]} queue - Main queue to add to
   * @param {Function} persistQueue - Function to persist queue
   * @returns {Promise<number>} Number of items re-queued
   */
  async function retryAllDeadLetterItems(queue, persistQueue) {
    if (deadLetterQueue.length === 0) {
      return 0;
    }

    const count = deadLetterQueue.length;
    const items = deadLetterQueue.map((entry) => entry.item);
    deadLetterQueue = [];
    // Push items individually to avoid stack overflow from spread on large arrays
    for (const item of items) {
      queue.push(item);
    }
    await persistQueue();
    await persistDeadLetterQueueGuarded();
    logger.info(`[EmbeddingQueue] Manually re-queued ${count} dead letter items`);
    return count;
  }

  /**
   * Set the dead letter queue (for initialization)
   * @param {any[]} items - Items to set
   */
  function setDeadLetterQueue(items) {
    deadLetterQueue = items;
  }

  /**
   * Persist all state
   */
  async function persistAll() {
    await persistFailedItemsGuarded();
    await persistDeadLetterQueueGuarded();
  }

  /**
   * Get stats
   */
  function getStats() {
    return {
      failedItemsCount: failedItems.size,
      maxFailedItemsSize,
      deadLetterCount: deadLetterQueue.length,
      maxDeadLetterSize,
      itemMaxRetries
    };
  }

  return {
    failedItems,
    get deadLetterQueue() {
      return deadLetterQueue;
    },
    trackFailedItem,
    addToDeadLetterQueue,
    getItemsToRetry,
    retryFailedItems,
    getDeadLetterItems,
    clearDeadLetterQueue,
    retryDeadLetterItem,
    retryAllDeadLetterItems,
    setDeadLetterQueue,
    persistAll,
    getStats
  };
}

module.exports = { createFailedItemHandler };
