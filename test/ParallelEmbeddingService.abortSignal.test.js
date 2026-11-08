/**
 * ParallelEmbeddingService.embedText({ signal }): a superseded search must not
 * keep its query embedding queued ahead of the live one. A queued embed whose
 * signal aborts is dropped from the semaphore queue without ever reaching the
 * model; a running one's result is discarded (AbortError, not a wrapped
 * EMBEDDING_GENERATION_FAILED) and it is not counted or logged as a failure.
 */

jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

jest.mock('../src/shared/config/index', () => ({
  get: jest.fn((key, defaultValue) => defaultValue)
}));

jest.mock('../src/main/services/LlamaService', () => {
  const mockInstance = {
    generateEmbedding: jest.fn(),
    getHealthStatus: jest.fn(() => ({ initialized: true })),
    testConnection: jest.fn().mockResolvedValue({ success: true }),
    getConfig: jest.fn().mockReturnValue({ embeddingModel: 'mxbai-embed-large' }),
    acquireModelLoadLock: jest.fn().mockResolvedValue(() => {})
  };
  return {
    getInstance: jest.fn(() => mockInstance),
    __mockInstance: mockInstance
  };
});

const { logger: mockLogger } = require('../src/shared/logger');
const llama = require('../src/main/services/LlamaService').__mockInstance;
const { ParallelEmbeddingService } = require('../src/main/services/ParallelEmbeddingService');

function deferred() {
  /** @type {(v: any) => void} */
  let resolve = () => {};
  /** @type {(e: any) => void} */
  let reject = () => {};
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('ParallelEmbeddingService.embedText abort signal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    llama.generateEmbedding.mockResolvedValue({ embedding: [0.1, 0.2, 0.3] });
  });

  test('a pre-aborted signal rejects with AbortError without touching the model', async () => {
    const service = new ParallelEmbeddingService({ concurrencyLimit: 1 });
    const ac = new AbortController();
    ac.abort();

    await expect(service.embedText('query', { signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError'
    });
    expect(llama.generateEmbedding).not.toHaveBeenCalled();
    expect(service.activeRequests).toBe(0);
    expect(service.stats.failedRequests).toBe(0);
  });

  test('a queued embed is dropped from the queue when its signal aborts', async () => {
    const service = new ParallelEmbeddingService({ concurrencyLimit: 1 });
    const running = deferred();
    llama.generateEmbedding.mockReturnValueOnce(running.promise);

    const first = service.embedText('stale running');
    await flush();
    expect(service.activeRequests).toBe(1);

    const ac = new AbortController();
    const queued = service.embedText('stale queued', { signal: ac.signal });
    await flush();
    expect(service.waitQueue).toHaveLength(1);

    ac.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(service.waitQueue).toHaveLength(0);

    running.resolve({ embedding: [1, 2, 3] });
    await expect(first).resolves.toMatchObject({ vector: [1, 2, 3] });

    // The dropped request never reached the model and the slot count is clean.
    expect(llama.generateEmbedding).toHaveBeenCalledTimes(1);
    expect(service.activeRequests).toBe(0);
    expect(service.stats.failedRequests).toBe(0);
  });

  test('a later live request still gets the slot after a queued one was dropped', async () => {
    const service = new ParallelEmbeddingService({ concurrencyLimit: 1 });
    const running = deferred();
    llama.generateEmbedding.mockReturnValueOnce(running.promise);

    const first = service.embedText('running');
    await flush();
    const ac = new AbortController();
    const dropped = service.embedText('dropped', { signal: ac.signal });
    const live = service.embedText('live');
    await flush();
    expect(service.waitQueue).toHaveLength(2);

    ac.abort();
    await expect(dropped).rejects.toMatchObject({ name: 'AbortError' });
    expect(service.waitQueue).toHaveLength(1);

    running.resolve({ embedding: [1, 1, 1] });
    await first;
    await expect(live).resolves.toMatchObject({ vector: [0.1, 0.2, 0.3] });
    expect(llama.generateEmbedding).toHaveBeenCalledTimes(2);
    expect(llama.generateEmbedding.mock.calls.map((c) => c[0])).toEqual(['running', 'live']);
    expect(service.activeRequests).toBe(0);
  });

  test('forwards the signal to LlamaService.generateEmbedding', async () => {
    const service = new ParallelEmbeddingService({ concurrencyLimit: 1 });
    const ac = new AbortController();

    await service.embedText('query', { signal: ac.signal });
    expect(llama.generateEmbedding).toHaveBeenCalledWith(
      'query',
      expect.objectContaining({ signal: ac.signal })
    );
  });

  test('a running embed whose signal aborts discards its result', async () => {
    const service = new ParallelEmbeddingService({ concurrencyLimit: 1 });
    const running = deferred();
    llama.generateEmbedding.mockReturnValueOnce(running.promise);
    const ac = new AbortController();

    const p = service.embedText('query', { signal: ac.signal });
    await flush();
    ac.abort();
    running.resolve({ embedding: [9, 9, 9] });

    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(service.activeRequests).toBe(0);
    expect(service.stats.failedRequests).toBe(0);
    expect(service.stats.successfulRequests).toBe(0);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  test('an aborted embed is not retried and not wrapped as a generation failure', async () => {
    const service = new ParallelEmbeddingService({ concurrencyLimit: 1, maxRetries: 3 });
    const ac = new AbortController();
    llama.generateEmbedding.mockImplementationOnce(async () => {
      ac.abort();
      const err = new Error('Operation aborted');
      err.name = 'AbortError';
      throw err;
    });

    const err = await service.embedText('query', { signal: ac.signal }).catch((e) => e);
    expect(err).toMatchObject({ name: 'AbortError' });
    expect(err.code).not.toBe('EMBEDDING_GENERATION_FAILED');
    expect(llama.generateEmbedding).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  test('without a signal the call behaves as before', async () => {
    const service = new ParallelEmbeddingService({ concurrencyLimit: 1 });
    await expect(service.embedText('query')).resolves.toMatchObject({
      vector: [0.1, 0.2, 0.3]
    });
    expect(service.stats.successfulRequests).toBe(1);
  });
});
