/**
 * A flush that meets a vector store refusing writes (shutdown in progress or
 * writes blocked) must keep the batch in the durable queue and must not mark
 * the files' embeddings as done: nothing reached the index.
 * Uses the real parallel processor against a stub vector service.
 */

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/tmp/user-data') }
}));

jest.mock('../src/shared/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger, createLogger: () => logger };
});

jest.mock('../src/shared/config/index', () => ({
  get: jest.fn((_key, fallback) => fallback)
}));

jest.mock('../src/shared/pathTraceLogger', () => ({
  traceQueueUpdate: jest.fn()
}));

jest.mock('../src/main/analysis/embeddingQueue/persistence', () => ({
  loadPersistedData: jest.fn().mockResolvedValue(undefined),
  persistQueueData: jest.fn().mockResolvedValue(undefined)
}));

const mockFailedHandler = {
  failedItems: new Map(),
  deadLetterQueue: [],
  trackFailedItem: jest.fn(),
  retryFailedItems: jest.fn().mockResolvedValue(undefined),
  getNextRetryDelay: jest.fn(() => null),
  setDeadLetterQueue: jest.fn(),
  persistAll: jest.fn().mockResolvedValue(undefined),
  persistPending: jest.fn().mockResolvedValue(undefined)
};

jest.mock('../src/main/analysis/embeddingQueue/failedItemHandler', () => ({
  createFailedItemHandler: jest.fn(() => mockFailedHandler)
}));

const mockContainer = { resolve: jest.fn() };

jest.mock('../src/main/services/ServiceContainer', () => ({
  container: mockContainer,
  ServiceIds: {
    ORAMA_VECTOR: 'ORAMA_VECTOR',
    ANALYSIS_HISTORY: 'ANALYSIS_HISTORY',
    PROCESSING_STATE: 'PROCESSING_STATE'
  }
}));

describe('EmbeddingQueue flush against a write-blocked vector store', () => {
  let history;
  let processingState;

  function wireServices(vectorDb) {
    history = { updateEmbeddingStateByPath: jest.fn().mockResolvedValue(undefined) };
    processingState = { updateReadyEmbeddingStatus: jest.fn().mockResolvedValue(undefined) };
    mockContainer.resolve.mockImplementation((id) => {
      if (id === 'ORAMA_VECTOR') return vectorDb;
      if (id === 'ANALYSIS_HISTORY') return history;
      if (id === 'PROCESSING_STATE') return processingState;
      throw new Error(`unexpected service ${id}`);
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockFailedHandler.failedItems = new Map();
  });

  test('keeps the batch queued, does not persist a shorter queue and does not mark embeddings done', async () => {
    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');
    const { persistQueueData } = require('../src/main/analysis/embeddingQueue/persistence');

    // isOnline stays true while cleanup() has already blocked writes.
    const vectorDb = {
      initialize: jest.fn().mockResolvedValue(undefined),
      isOnline: true,
      batchUpsertFiles: jest
        .fn()
        .mockResolvedValue({ queued: false, count: 0, skipped: true, reason: 'shutdown' }),
      upsertFile: jest.fn(async (file) => ({
        queued: false,
        fileId: file.id,
        skipped: true,
        reason: 'shutdown'
      }))
    };
    wireServices(vectorDb);

    const q = new EmbeddingQueue({ flushDelayMs: 0 });
    q.initialized = true;
    // Retries are timers; a refused flush must not leave one running past the test.
    q._isShuttingDown = true;
    const item = { id: 'file:/docs/q1.pdf', vector: [1, 2], meta: { path: '/docs/q1.pdf' } };
    q.queue = [item];

    await q.flush();

    expect(vectorDb.batchUpsertFiles).toHaveBeenCalledTimes(1);
    expect(q.queue).toEqual([item]);
    expect(persistQueueData).not.toHaveBeenCalled();
    expect(history.updateEmbeddingStateByPath).not.toHaveBeenCalled();
    expect(processingState.updateReadyEmbeddingStatus).not.toHaveBeenCalled();
    // A refused write is not the item's fault: it must not burn its dead-letter budget.
    expect(mockFailedHandler.trackFailedItem).not.toHaveBeenCalled();
  });

  test('an accepted batch is still removed and marked done', async () => {
    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');

    const vectorDb = {
      initialize: jest.fn().mockResolvedValue(undefined),
      isOnline: true,
      batchUpsertFiles: jest.fn().mockResolvedValue({ queued: true, count: 1 })
    };
    wireServices(vectorDb);

    const q = new EmbeddingQueue({ flushDelayMs: 0 });
    q.initialized = true;
    q._isShuttingDown = true;
    q.queue = [{ id: 'file:/docs/q2.pdf', vector: [1, 2], meta: { path: '/docs/q2.pdf' } }];

    await q.flush();

    expect(q.queue).toHaveLength(0);
    expect(history.updateEmbeddingStateByPath).toHaveBeenCalledWith('/docs/q2.pdf', {
      status: 'done'
    });
  });
});
