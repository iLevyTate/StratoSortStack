// @ts-check
/**
 * EmbeddingQueueManager
 *
 * Wrapper that applies path updates/removals across all staged embedding queues.
 * Used by FilePathCoordinator so pending embeddings remain consistent after moves/renames/deletes.
 */
const { analysisQueue, organizeQueue } = require('./stageQueues');
const { closeSqliteStore } = require('./persistence');
const { delay } = require('../../../shared/promiseUtils');

/**
 * @param {any} queue
 * @param {string} method
 * @param {...any} args
 */
function safeCallOptional(queue, method, ...args) {
  const fn = queue && typeof queue[method] === 'function' ? queue[method] : null;
  if (!fn) return 0;
  return fn.apply(queue, args);
}

/**
 * @param {any} queue
 * @param {string} method
 * @param {...any} args
 */
function safeCallRequired(queue, method, ...args) {
  const fn = queue && typeof queue[method] === 'function' ? queue[method] : null;
  if (!fn) {
    const queueName = queue?.constructor?.name || 'UnknownQueue';
    throw new Error(`[EmbeddingQueueManager] Missing ${method} on ${queueName}`);
  }
  return fn.apply(queue, args);
}

const queues = [analysisQueue, organizeQueue];

/**
 * @param {any} queue
 * @param {{ highWatermarkPercent?: number, releasePercent?: number, maxWaitMs?: number, initialDelayMs?: number, maxDelayMs?: number }} [options]
 */
async function waitForQueueCapacity(
  queue,
  {
    highWatermarkPercent = 75,
    releasePercent = 50,
    maxWaitMs = 60000,
    initialDelayMs = 250,
    maxDelayMs = 2000
  } = {}
) {
  if (!queue || typeof queue.getStats !== 'function') {
    return { waited: false, timedOut: false, capacityPercent: null };
  }

  const start = Date.now();
  const firstStats = queue.getStats() || {};
  let capacityPercent = Number(firstStats.capacityPercent) || 0;
  if (capacityPercent < highWatermarkPercent) {
    return { waited: false, timedOut: false, capacityPercent };
  }

  let waitMs = Math.max(50, initialDelayMs);
  while (Date.now() - start < maxWaitMs) {
    await delay(waitMs);
    const stats = queue.getStats() || {};
    capacityPercent = Number(stats.capacityPercent) || 0;
    if (capacityPercent <= releasePercent) {
      return { waited: true, timedOut: false, capacityPercent };
    }
    waitMs = Math.min(maxDelayMs, Math.round(waitMs * 1.5));
  }

  return { waited: true, timedOut: true, capacityPercent };
}

module.exports = {
  analysisQueue,
  organizeQueue,

  /**
   * @param {string} oldPath
   * @param {string} newPath
   */
  updateByFilePath(oldPath, newPath) {
    let total = 0;
    for (const q of queues) total += safeCallOptional(q, 'updateByFilePath', oldPath, newPath) || 0;
    return total;
  },

  /** @param {Array<{ oldPath: string, newPath: string }>} pathChanges */
  updateByFilePaths(pathChanges) {
    let total = 0;
    for (const q of queues) total += safeCallOptional(q, 'updateByFilePaths', pathChanges) || 0;
    return total;
  },

  /** @param {string} filePath */
  removeByFilePath(filePath) {
    let total = 0;
    for (const q of queues) total += safeCallOptional(q, 'removeByFilePath', filePath) || 0;
    return total;
  },

  /** @param {string[]} filePaths */
  removeByFilePaths(filePaths) {
    let total = 0;
    for (const q of queues) total += safeCallOptional(q, 'removeByFilePaths', filePaths) || 0;
    return total;
  },

  getStats() {
    return {
      analysis: analysisQueue?.getStats ? analysisQueue.getStats() : null,
      organize: organizeQueue?.getStats ? organizeQueue.getStats() : null
    };
  },

  /** @param {Parameters<typeof waitForQueueCapacity>[1]} [options] */
  waitForAnalysisQueueCapacity(options = {}) {
    return waitForQueueCapacity(analysisQueue, options);
  },

  /** @param {Parameters<typeof waitForQueueCapacity>[1]} [options] */
  waitForOrganizeQueueCapacity(options = {}) {
    return waitForQueueCapacity(organizeQueue, options);
  },

  /**
   * Restore every staged queue from disk and schedule its flush. Each queue
   * already does this inside its own initialize(), but nothing called that
   * until the first enqueue() of the process, so items persisted before a
   * crash or quit sat idle (F-190 / CP-10). Called once at startup after the
   * vector store is ready; a queue that fails to restore never blocks the
   * others and never throws here — the failure is the caller's to log.
   *
   * @returns {Promise<PromiseSettledResult<any>[]>}
   */
  async initialize() {
    return Promise.allSettled(queues.map((q) => safeCallOptional(q, 'initialize')));
  },

  async forceFlush() {
    const results = await Promise.allSettled(queues.map((q) => safeCallRequired(q, 'forceFlush')));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Embedding queue forceFlush failed'
      );
    }
    return results;
  },

  async shutdown() {
    const results = await Promise.allSettled(queues.map((q) => safeCallRequired(q, 'shutdown')));
    // Both queues persist into one embedding-queue.db through a shared store
    // handle, so the close (and its WAL checkpoint) belongs here, after the
    // last queue has written — not inside each queue's shutdown().
    closeSqliteStore();
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Embedding queue shutdown failed'
      );
    }
    return results;
  }
};
