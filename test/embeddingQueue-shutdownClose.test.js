/**
 * Clean-quit SQLite close for the embedding queues.
 *
 * Both staged queues persist into one embedding-queue.db through a shared
 * store handle. The manager closes it (WAL checkpoint) after the last queue
 * has written; each queue makes its own persistence a no-op once its
 * shutdown() has completed so a late caller cannot reopen the closed store.
 */

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => 'C:\\user-data') }
}));

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })
}));

jest.mock('../src/shared/config/index', () => ({
  get: jest.fn((_key, fallback) => fallback)
}));

jest.mock('../src/shared/pathTraceLogger', () => ({ traceQueueUpdate: jest.fn() }));

jest.mock('../src/shared/performanceConstants', () => ({
  BATCH: { EMBEDDING_FLUSH_DELAY_MS: 10 },
  LIMITS: { MAX_QUEUE_SIZE: 100, MAX_DEAD_LETTER_SIZE: 100 },
  THRESHOLDS: { QUEUE_HIGH_WATERMARK: 0.8, QUEUE_CRITICAL_WATERMARK: 0.9 },
  RETRY: { BACKOFF_BASE_MS: 10, BACKOFF_MAX_MS: 1000 },
  CONCURRENCY: { EMBEDDING_FLUSH: 2 },
  TIMEOUTS: { MUTEX_ACQUIRE: 50 }
}));

jest.mock('../src/shared/errorCodes', () => ({ ERROR_CODES: { TIMEOUT: 'GEN_001' } }));

jest.mock('../src/main/analysis/embeddingQueue/persistence', () => ({
  loadPersistedData: jest.fn().mockResolvedValue(undefined),
  persistQueueData: jest.fn().mockResolvedValue(undefined),
  closeSqliteStore: jest.fn()
}));

const mockFailedHandler = {
  failedItems: new Map(),
  deadLetterQueue: [],
  trackFailedItem: jest.fn(),
  retryFailedItems: jest.fn().mockResolvedValue(undefined),
  setDeadLetterQueue: jest.fn(),
  persistAll: jest.fn().mockResolvedValue(undefined)
};
let capturedShouldBlockPersist = () => false;
jest.mock('../src/main/analysis/embeddingQueue/failedItemHandler', () => ({
  createFailedItemHandler: jest.fn((config) => {
    capturedShouldBlockPersist = config.shouldBlockPersist;
    return mockFailedHandler;
  })
}));

jest.mock('../src/main/analysis/embeddingQueue/progress', () => ({
  createProgressTracker: jest.fn(() => ({
    onProgress: jest.fn(() => () => {}),
    notify: jest.fn(),
    clear: jest.fn()
  }))
}));

jest.mock('../src/main/analysis/embeddingQueue/parallelProcessor', () => ({
  processItemsInParallel: jest.fn(async ({ items, startProcessedCount }) => {
    return startProcessedCount + items.length;
  })
}));

jest.mock('../src/main/services/ServiceContainer', () => ({
  container: { resolve: jest.fn() },
  ServiceIds: { ORAMA_VECTOR: 'ORAMA_VECTOR' }
}));

const mockAnalysisQueue = { shutdown: jest.fn(), forceFlush: jest.fn(), getStats: jest.fn() };
const mockOrganizeQueue = { shutdown: jest.fn(), forceFlush: jest.fn(), getStats: jest.fn() };
jest.mock('../src/main/analysis/embeddingQueue/stageQueues', () => ({
  analysisQueue: mockAnalysisQueue,
  organizeQueue: mockOrganizeQueue
}));

const persistence = require('../src/main/analysis/embeddingQueue/persistence');
const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');
const queueManager = require('../src/main/analysis/embeddingQueue/queueManager');
const { getAllIdVariants } = require('../src/main/utils/fileIdUtils');

describe('EmbeddingQueueCore persistence after shutdown', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFailedHandler.failedItems = new Map();
    mockFailedHandler.deadLetterQueue = [];
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('shutdown writes final state once, then later persists are no-ops', async () => {
    const q = new EmbeddingQueue({ flushDelayMs: 0 });
    q.initialized = true;
    q.queue = [{ id: 'file:a', vector: [1] }];

    await q.shutdown();
    expect(persistence.persistQueueData).toHaveBeenCalledTimes(1);
    expect(mockFailedHandler.persistAll).toHaveBeenCalledTimes(1);
    expect(q._isShutdownComplete).toBe(true);

    await q.persistQueue();
    q._persistPendingRemovals();
    expect(persistence.persistQueueData).toHaveBeenCalledTimes(1);
    expect(capturedShouldBlockPersist()).toBe(true);
  });

  test('a debounced persist armed before shutdown does not fire afterwards', async () => {
    jest.useFakeTimers();
    const q = new EmbeddingQueue({ flushDelayMs: 0 });
    q.initialized = true;
    jest.spyOn(q, 'flush').mockResolvedValue(undefined);
    jest.spyOn(q, 'scheduleFlush').mockImplementation(() => {});

    await q.enqueue({ id: 'file:a', vector: [1, 2, 3] });
    expect(q._persistDebounceTimer).not.toBeNull();

    await q.shutdown();
    const persistsAtShutdown = persistence.persistQueueData.mock.calls.length;

    await jest.advanceTimersByTimeAsync(1000);
    expect(persistence.persistQueueData).toHaveBeenCalledTimes(persistsAtShutdown);
  });

  test('a late removeByFilePath after shutdown does not reach the store', async () => {
    const filePath = 'C:/docs/a.txt';
    const q = new EmbeddingQueue({ flushDelayMs: 0 });
    q.initialized = true;
    q.queue = [{ id: getAllIdVariants(filePath)[0], filePath, vector: [1] }];

    await q.shutdown();
    const persistsAtShutdown = persistence.persistQueueData.mock.calls.length;

    expect(q.removeByFilePath(filePath)).toBe(1);
    await Promise.resolve();

    expect(persistence.persistQueueData).toHaveBeenCalledTimes(persistsAtShutdown);
  });
});

describe('queueManager.shutdown closes the shared SQLite store once', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAnalysisQueue.shutdown.mockResolvedValue(undefined);
    mockOrganizeQueue.shutdown.mockResolvedValue(undefined);
  });

  test('closes after both queues have shut down', async () => {
    const order = [];
    mockAnalysisQueue.shutdown.mockImplementation(async () => {
      order.push('analysis');
    });
    mockOrganizeQueue.shutdown.mockImplementation(async () => {
      order.push('organize');
    });
    persistence.closeSqliteStore.mockImplementation(() => {
      order.push('close');
    });

    await queueManager.shutdown();

    expect(order).toEqual(['analysis', 'organize', 'close']);
    expect(persistence.closeSqliteStore).toHaveBeenCalledTimes(1);
    expect(persistence.closeSqliteStore).toHaveBeenCalledWith();
  });

  test('still closes the store when one queue shutdown rejects', async () => {
    mockOrganizeQueue.shutdown.mockRejectedValue(new Error('organize boom'));

    await expect(queueManager.shutdown()).rejects.toThrow('Embedding queue shutdown failed');

    expect(persistence.closeSqliteStore).toHaveBeenCalledTimes(1);
  });
});
