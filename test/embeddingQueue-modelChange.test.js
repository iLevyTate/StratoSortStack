/**
 * Vectors waiting in the embedding queue (or its failed-items map and
 * dead-letter queue) that a different embedding model produced must never be
 * written into the index. With a different dimension they churned into the
 * dead-letter queue; with the same dimension they were written silently and
 * mixed two vector spaces in one index.
 * Uses the real failed-item handler and parallel processor against a stub
 * vector service; persistence is stubbed.
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
  persistQueueData: jest.fn().mockResolvedValue(undefined),
  persistFailedItems: jest.fn().mockResolvedValue(true),
  persistDeadLetterQueue: jest.fn().mockResolvedValue(true),
  SQLITE_KEYS: { queue: 'queue', failedItems: 'failedItems', deadLetter: 'deadLetter' }
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

const { logger: mockLogger } = require('../src/shared/logger');
const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');

const OLD_MODEL = 'old-embed-v1-Q8_0.gguf';
const NEW_MODEL = 'new-embed-v2-Q8_0.gguf';

/** Both models are 2-dimensional here, so nothing but the model tells them apart. */
function fileItem(name, model) {
  const item = { id: `file:/docs/${name}`, vector: [0.1, 0.2], meta: { path: `/docs/${name}` } };
  if (model) item.model = model;
  return item;
}

function deadLetterEntry(item) {
  return { item, itemId: item.id, error: 'dimension_mismatch', retryCount: 1 };
}

describe('EmbeddingQueue after an embedding-model change', () => {
  let vectorDb;
  let history;

  beforeEach(() => {
    jest.clearAllMocks();
    vectorDb = {
      initialize: jest.fn().mockResolvedValue(undefined),
      isOnline: true,
      getEmbeddingModel: jest.fn(() => NEW_MODEL),
      batchUpsertFiles: jest.fn(async (files) => ({ success: true, count: files.length }))
    };
    history = { updateEmbeddingStateByPath: jest.fn().mockResolvedValue(undefined) };
    mockContainer.resolve.mockReset();
    mockContainer.resolve.mockImplementation((id) => {
      if (id === 'ORAMA_VECTOR') return vectorDb;
      if (id === 'ANALYSIS_HISTORY') return history;
      if (id === 'PROCESSING_STATE') return null;
      throw new Error(`unexpected service ${id}`);
    });
  });

  async function newQueue() {
    const q = new EmbeddingQueue({ flushDelayMs: 0 });
    // Persistence is stubbed, so this restores nothing.
    await q.initialize();
    // Keeps flush from arming retry and persist timers that outlive the test.
    q._isShuttingDown = true;
    return q;
  }

  test('flush never writes a vector from another model, even one of the same dimension', async () => {
    const q = await newQueue();
    const stale = fileItem('stale.pdf', OLD_MODEL);
    const fresh = fileItem('fresh.pdf', NEW_MODEL);
    // Another quantization of the index model embeds into the same space
    // (the same-dimension fallback chain produces these).
    const quantized = fileItem('quantized.pdf', 'new-embed-v2-Q4_K_M.gguf');
    // No stamp: nothing says which model made it, so flush keeps it.
    const unstamped = fileItem('unstamped.pdf');
    q.queue = [stale, fresh, quantized, unstamped];

    await q.flush();

    expect(vectorDb.batchUpsertFiles).toHaveBeenCalledTimes(1);
    const written = vectorDb.batchUpsertFiles.mock.calls[0][0].map((f) => f.id);
    expect(written).toEqual([fresh.id, quantized.id, unstamped.id]);
    expect(q.queue).toHaveLength(0);
    // Dropped, not failed: it must not churn into the retry or dead-letter queues.
    expect(q._failedItemHandler.failedItems.has(stale.id)).toBe(false);
    expect(q._failedItemHandler.deadLetterQueue).toHaveLength(0);
    // Nor be reported as embedded.
    expect(history.updateEmbeddingStateByPath).not.toHaveBeenCalledWith('/docs/stale.pdf', {
      status: 'done'
    });
  });

  test('a model change drops queued, retrying and dead-lettered vectors not from the new model', async () => {
    const q = await newQueue();
    const fresh = fileItem('fresh.pdf', NEW_MODEL);
    q.queue = [fileItem('stale.pdf', OLD_MODEL), fileItem('unstamped.pdf'), fresh];
    const retrying = fileItem('retrying.pdf', OLD_MODEL);
    q._failedItemHandler.failedItems.set(retrying.id, {
      item: retrying,
      retryCount: 1,
      lastAttempt: Date.now(),
      error: 'timeout'
    });
    const freshDead = deadLetterEntry(fileItem('fresh-dead.pdf', NEW_MODEL));
    q._failedItemHandler.setDeadLetterQueue([
      deadLetterEntry(fileItem('dead.pdf', OLD_MODEL)),
      freshDead
    ]);

    const dropped = q.dropOtherModelEmbeddings(NEW_MODEL);

    expect(dropped).toBe(4);
    expect(q.queue).toEqual([fresh]);
    expect(q._failedItemHandler.failedItems.size).toBe(0);
    expect(q._failedItemHandler.deadLetterQueue).toEqual([freshDead]);
    const dropLines = mockLogger.info.mock.calls.filter(([msg]) => /Dropped 4 /.test(msg));
    expect(dropLines).toHaveLength(1);
  });
});
