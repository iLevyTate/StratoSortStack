// @ts-check
/**
 * Parallel Processor Module
 *
 * Semaphore-based parallel processing for embedding operations.
 *
 * @module embeddingQueue/parallelProcessor
 */

const { createLogger } = require('../../../shared/logger');
const logger = createLogger('ParallelProcessor');
const { withTimeout } = require('../../../shared/promiseUtils');
const { TIMEOUTS } = require('../../../shared/performanceConstants');
const PQueue = require('p-queue').default;

/** Error code for a flush that hit a vector store refusing writes. */
const VECTOR_WRITES_BLOCKED = 'VECTOR_WRITES_BLOCKED';

/**
 * The vector store answers `{ queued: false, reason: 'shutdown' }` (without
 * throwing) when its writes are blocked or it is shutting down. Nothing was
 * written, so the caller must not count the items as embedded.
 * @param {any} result
 * @returns {boolean}
 */
function isWritesBlockedResult(result) {
  return Boolean(result && result.queued === false && result.reason === 'shutdown');
}

/**
 * Rejecting (rather than reporting per-item failures) keeps the whole batch in
 * the durable queue for a later flush and keeps the refusal out of the
 * dead-letter retry budget: the items themselves are fine.
 * @param {'file' | 'folder'} type
 * @returns {Error & { code: string }}
 */
function writesBlockedError(type) {
  return Object.assign(
    new Error(`Vector store refused ${type} writes (shutting down or writes blocked)`),
    { code: VECTOR_WRITES_BLOCKED }
  );
}

/**
 * Process items in parallel with semaphore-based concurrency control
 * @param {object} params - Processing parameters
 * @param {any[]} params.items - Items to process
 * @param {'file' | 'folder'} params.type
 * @param {any} params.vectorDbService - Vector DB service instance (dynamic method dispatch)
 * @param {Set<string>} params.failedItemIds - Set to track failed item IDs
 * @param {number} params.startProcessedCount - Starting count for progress
 * @param {number} params.totalBatchSize - Total batch size for progress
 * @param {number} params.concurrency - Max concurrent operations
 * @param {(progress: Record<string, any>) => void} params.onProgress - Progress callback
 * @param {(item: any, reason: string) => void} params.onItemFailed - Callback when item fails
 * @returns {Promise<number>} Updated processed count
 */
async function processItemsInParallel({
  items,
  type,
  vectorDbService,
  failedItemIds,
  startProcessedCount,
  totalBatchSize,
  concurrency,
  onProgress,
  onItemFailed
}) {
  let processedCount = startProcessedCount;

  // Try batch upsert first if available
  const batchMethod = type === 'file' ? 'batchUpsertFiles' : 'batchUpsertFolders';
  const singleMethod = type === 'file' ? 'upsertFile' : 'upsertFolder';

  if (typeof vectorDbService[batchMethod] === 'function') {
    try {
      if (type === 'folder') {
        // Format folders for batch upsert
        const formattedItems = items.map((item) => ({
          id: item.id,
          vector: item.vector,
          name: item.meta?.name || item.id,
          path: item.meta?.path,
          model: item.model,
          updatedAt: item.updatedAt
        }));
        const result = await withTimeout(
          vectorDbService[batchMethod](formattedItems),
          TIMEOUTS.BATCH_EMBEDDING_MAX || 5 * 60 * 1000,
          `Batch ${type} upsert`
        );
        if (isWritesBlockedResult(result)) throw writesBlockedError(type);
        // If the service returns success: false (e.g. dimension mismatch), we must treat it as a failure
        // so items go to the failed queue instead of being silently dropped.
        if (result && result.success === false) {
          const isDimensionMismatch =
            result.error === 'dimension_mismatch' || result.requiresRebuild === true;
          if (isDimensionMismatch) {
            for (const item of items) {
              failedItemIds.add(item.id);
              onItemFailed(item, result.error || 'dimension_mismatch');
            }
            return processedCount;
          }
          throw new Error(result.error || 'Batch folder upsert failed');
        }
        if (result?.failed && result.failed.length > 0) {
          const itemsById = new Map(items.map((item) => [item.id, item]));
          for (const failure of result.failed) {
            const failedItem = itemsById.get(failure.id);
            if (failedItem) {
              failedItemIds.add(failedItem.id);
              onItemFailed(failedItem, failure.error || 'batch_upsert_failed');
            }
          }
          // Derive success count from known quantities rather than trusting result.count
          const actualSuccessCount = Math.max(0, items.length - result.failed.length);
          if (actualSuccessCount > 0) {
            processedCount += actualSuccessCount;
            onProgress({
              phase: 'processing',
              total: totalBatchSize,
              completed: processedCount,
              percent: totalBatchSize > 0 ? Math.round((processedCount / totalBatchSize) * 100) : 0,
              itemType: type
            });
          }
          return processedCount;
        }
      } else {
        const result = await withTimeout(
          vectorDbService[batchMethod](items),
          TIMEOUTS.BATCH_EMBEDDING_MAX || 5 * 60 * 1000,
          `Batch ${type} upsert`
        );
        if (isWritesBlockedResult(result)) throw writesBlockedError(type);
        if (result && result.success === false) {
          const isDimensionMismatch =
            result.error === 'dimension_mismatch' || result.requiresRebuild === true;
          if (isDimensionMismatch) {
            for (const item of items) {
              failedItemIds.add(item.id);
              onItemFailed(item, result.error || 'dimension_mismatch');
            }
            return processedCount;
          }
          throw new Error(result.error || 'Batch file upsert failed');
        }
        if (result?.failed && result.failed.length > 0) {
          const itemsById = new Map(items.map((item) => [item.id, item]));
          for (const failure of result.failed) {
            const failedItem = itemsById.get(failure.id);
            if (failedItem) {
              failedItemIds.add(failedItem.id);
              onItemFailed(failedItem, failure.error || 'batch_upsert_failed');
            }
          }
          // Derive success count from known quantities rather than trusting result.count
          const actualSuccessCount = Math.max(0, items.length - result.failed.length);
          if (actualSuccessCount > 0) {
            processedCount += actualSuccessCount;
            onProgress({
              phase: 'processing',
              total: totalBatchSize,
              completed: processedCount,
              percent: totalBatchSize > 0 ? Math.round((processedCount / totalBatchSize) * 100) : 0,
              itemType: type
            });
          }
          return processedCount;
        }
      }

      // All items processed successfully
      processedCount += items.length;
      onProgress({
        phase: 'processing',
        total: totalBatchSize,
        completed: processedCount,
        percent: totalBatchSize > 0 ? Math.round((processedCount / totalBatchSize) * 100) : 0,
        itemType: type
      });

      return processedCount;
    } catch (batchError) {
      // Retrying item by item against a store that refuses writes cannot help.
      if (batchError?.code === VECTOR_WRITES_BLOCKED) throw batchError;
      logger.warn(
        `[EmbeddingQueue] Batch ${type} upsert failed, falling back to parallel individual:`,
        batchError.message
      );
      // Fall through to parallel individual processing
    }
  }

  // Queue-based parallel processing
  logger.debug(
    `[EmbeddingQueue] Processing ${items.length} ${type}s with concurrency ${concurrency}`
  );

  const queue = new PQueue({ concurrency });
  let writesBlocked = false;

  /** @param {any} item */
  const processItem = async (item) => {
    try {
      const payload =
        type === 'folder'
          ? {
              id: item.id,
              vector: item.vector,
              name: item.meta?.name || item.id,
              path: item.meta?.path,
              model: item.model,
              updatedAt: item.updatedAt
            }
          : {
              id: item.id,
              vector: item.vector,
              meta: item.meta,
              model: item.model,
              updatedAt: item.updatedAt
            };

      const result = await withTimeout(
        vectorDbService[singleMethod](payload),
        TIMEOUTS.EMBEDDING_REQUEST || 30000,
        `Upsert ${type}`
      );

      if (isWritesBlockedResult(result)) {
        writesBlocked = true;
        return;
      }

      if (result && result.success === false) {
        const isDimensionMismatch =
          result.error === 'dimension_mismatch' || result.requiresRebuild === true;
        if (isDimensionMismatch) {
          failedItemIds.add(item.id);
          onItemFailed(item, result.error || 'dimension_mismatch');
          return;
        }
        throw new Error(result.error || `Upsert ${type} failed`);
      }

      const completed = ++processedCount;
      onProgress({
        phase: 'processing',
        total: totalBatchSize,
        completed,
        percent: totalBatchSize > 0 ? Math.round((completed / totalBatchSize) * 100) : 0,
        itemType: type,
        currentItem: item.id
      });
    } catch (itemError) {
      logger.warn(`[EmbeddingQueue] Failed to upsert ${type} ${item.id}:`, itemError.message);
      failedItemIds.add(item.id);
      onItemFailed(item, itemError.message);
    }
  };

  await Promise.all(
    items.map((item) => queue.add(() => (writesBlocked ? undefined : processItem(item))))
  );

  // Rejecting leaves the whole batch queued; any item that did land is simply
  // upserted again on the next flush (upserts are idempotent).
  if (writesBlocked) throw writesBlockedError(type);

  return processedCount;
}

module.exports = { processItemsInParallel, VECTOR_WRITES_BLOCKED };
