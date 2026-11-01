// Mock dependencies
jest.mock('../../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock('../../src/main/services/LlamaService', () => ({
  getInstance: jest.fn().mockReturnValue({
    getConfig: jest.fn().mockResolvedValue({ embeddingModel: 'test-model' }),
    generateEmbedding: jest.fn().mockResolvedValue({ embedding: [0.1, 0.2], model: 'test-model' }),
    getHealthStatus: jest.fn().mockReturnValue({ initialized: true }),
    on: jest.fn(),
    once: jest.fn(),
    pinModel: jest.fn(),
    unpinModel: jest.fn()
  })
}));

jest.mock('../../src/main/utils/workerPools', () => ({
  getEmbeddingPool: jest.fn().mockReturnValue(null), // Disable worker pool for this test
  destroyEmbeddingPool: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../../src/main/services/PerformanceService', () => ({
  getRecommendedConcurrency: jest.fn().mockResolvedValue({ maxConcurrent: 5 })
}));

describe('ParallelEmbeddingService Fixes', () => {
  let ParallelEmbeddingService;
  let service;

  beforeEach(() => {
    // Other suites may load ParallelEmbeddingService before this file's mocks apply,
    // leaving a stale binding to the real workerPools.getEmbeddingPool (null in Jest).
    jest.resetModules();
    ParallelEmbeddingService =
      require('../../src/main/services/ParallelEmbeddingService').ParallelEmbeddingService;
    jest.clearAllMocks();
    service = new ParallelEmbeddingService({
      concurrencyLimit: 2,
      maxRetries: 1
    });
  });

  afterEach(async () => {
    await service.shutdown();
  });

  test('should limit concurrency', async () => {
    const LlamaService = require('../../src/main/services/LlamaService');
    let resolveEmbedding;
    const embeddingPromise = new Promise((r) => (resolveEmbedding = r));

    LlamaService.getInstance().generateEmbedding.mockImplementation(() => embeddingPromise);

    // Start 3 requests with limit 2
    const p1 = service.embedText('text1');
    const p2 = service.embedText('text2');
    const p3 = service.embedText('text3');

    // Allow event loop to process
    await new Promise((r) => setTimeout(r, 10));

    expect(service.activeRequests).toBe(2);
    expect(service.waitQueue.length).toBe(1);

    // Resolve embeddings
    resolveEmbedding({ embedding: [0.1], model: 'test-model' });

    await Promise.all([p1, p2, p3]);
  });

  test('should handle batch errors gracefully', async () => {
    const LlamaService = require('../../src/main/services/LlamaService');
    LlamaService.getInstance()
      .generateEmbedding.mockResolvedValueOnce({ embedding: [0.1], model: 'test-model' })
      .mockRejectedValueOnce(new Error('Embedding failed'))
      .mockResolvedValueOnce({ embedding: [0.3], model: 'test-model' });

    const items = [
      { id: '1', text: 'text1' },
      { id: '2', text: 'text2' },
      { id: '3', text: 'text3' }
    ];

    const result = await service.batchEmbedTexts(items);

    // The service returns all results, including failed ones (with success: false)
    expect(result.results.length).toBe(3);

    // Check successful items
    const successful = result.results.filter((r) => r.success);
    expect(successful.length).toBe(2);

    // Check errors
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].id).toBe('2');
    expect(result.stats.successful).toBe(2);
    expect(result.stats.failed).toBe(1);
  });

  test('should abort batch on model mismatch', async () => {
    const LlamaService = require('../../src/main/services/LlamaService');

    // First call returns model A, second returns model B
    LlamaService.getInstance()
      .generateEmbedding.mockResolvedValueOnce({ embedding: [0.1], model: 'model-A' })
      .mockResolvedValueOnce({ embedding: [0.2], model: 'model-B' });

    // Config returns model A initially
    LlamaService.getInstance().getConfig.mockResolvedValue({ embeddingModel: 'model-A' });

    const items = [
      { id: '1', text: 'text1' },
      { id: '2', text: 'text2' }
    ];

    // Item 2: generateEmbedding -> 'model-B'. Mismatch with batchModel 'model-A'.
    // The service catches this and returns it as an error in the result object
    const result = await service.batchEmbedTexts(items);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].error).toMatch(/Model mismatch/);
    expect(result.stats.failed).toBe(1);
  });

  test('should recover from context overflow with stricter cap', async () => {
    const LlamaService = require('../../src/main/services/LlamaService');
    LlamaService.getInstance().generateEmbedding.mockImplementation(async (input) => {
      if ((input || '').length > 1200) {
        throw new Error('Input is longer than the context size of 512 tokens');
      }
      return { embedding: [0.11, 0.22], model: 'test-model' };
    });

    const longDenseText = 'x'.repeat(2400);
    const result = await service.embedText(longDenseText);

    expect(result.success).toBe(true);
    expect(result.vector).toEqual([0.11, 0.22]);
    expect(LlamaService.getInstance().generateEmbedding).toHaveBeenCalledTimes(2);
  });

  test('should cap concurrency to embedding worker thread count', async () => {
    const workerPools = require('../../src/main/utils/workerPools');
    workerPools.getEmbeddingPool.mockReturnValue({
      stratosortMaxThreads: 1,
      run: jest.fn().mockResolvedValue({ embedding: [0.1, 0.2], model: 'test-model' })
    });

    service = new ParallelEmbeddingService({
      concurrencyLimit: 6,
      maxRetries: 1
    });

    await service.embedText('text1');

    expect(service.concurrencyLimit).toBe(1);
    expect(service.providerConcurrencyCap).toBe(1);
    expect(workerPools.getEmbeddingPool).toHaveBeenCalled();
  });

  test('should restore concurrency when embedding worker becomes unavailable', async () => {
    const workerPools = require('../../src/main/utils/workerPools');
    let currentPool = {
      stratosortMaxThreads: 1,
      run: jest.fn().mockResolvedValue({ embedding: [0.1, 0.2], model: 'test-model' })
    };
    workerPools.getEmbeddingPool.mockImplementation(() => currentPool);

    service = new ParallelEmbeddingService({
      concurrencyLimit: 6,
      maxRetries: 1
    });

    await service.embedText('text1');
    expect(service.concurrencyLimit).toBe(1);

    currentPool = null;
    await service.embedText('text2');

    expect(service.providerConcurrencyCap).toBe(10);
    expect(service.concurrencyLimit).toBeGreaterThan(1);
  });

  test('should keep chunk pooling within remaining concurrency headroom', async () => {
    const LlamaService = require('../../src/main/services/LlamaService');
    let activeEmbeds = 0;
    let peakEmbeds = 0;

    LlamaService.getInstance().generateEmbedding.mockImplementation(
      () =>
        new Promise((resolve) => {
          activeEmbeds += 1;
          peakEmbeds = Math.max(peakEmbeds, activeEmbeds);
          setTimeout(() => {
            activeEmbeds -= 1;
            resolve({ embedding: [0.3, 0.4], model: 'test-model' });
          }, 5);
        })
    );

    service = new ParallelEmbeddingService({
      concurrencyLimit: 2,
      maxRetries: 1
    });
    service.activeRequests = 2;

    const pooled = await service._embedWithChunkPooling(
      'x'.repeat(4000),
      'test-model',
      LlamaService.getInstance(),
      { embeddingModel: 'test-model' },
      900
    );

    expect(pooled.success).toBe(true);
    expect(peakEmbeds).toBe(1);

    // The two synthetic "held" slots were never real requests; restore so
    // afterEach's shutdown doesn't wait out the bounded active-request drain.
    service.activeRequests = 0;
  });

  describe('construction-time concurrency sync', () => {
    test('passes the GPU LlamaService already detected as a hint instead of re-probing', async () => {
      const LlamaService = require('../../src/main/services/LlamaService');
      const { getRecommendedConcurrency } = require('../../src/main/services/PerformanceService');
      getRecommendedConcurrency.mockClear();
      LlamaService.getInstance().getHealthStatus.mockReturnValueOnce({
        initialized: true,
        gpuDetected: { type: 'cuda', name: 'RTX 4090', vramMB: 24576 }
      });

      const hinted = new ParallelEmbeddingService({ concurrencyLimit: 2, maxRetries: 1 });
      try {
        expect(getRecommendedConcurrency).toHaveBeenCalledTimes(1);
        expect(getRecommendedConcurrency).toHaveBeenCalledWith({
          gpuHint: expect.objectContaining({ type: 'cuda', vramMB: 24576 })
        });
      } finally {
        await hinted.shutdown();
      }
    });

    test('does not query PerformanceService at construction before LlamaService is initialized', async () => {
      const LlamaService = require('../../src/main/services/LlamaService');
      const { getRecommendedConcurrency } = require('../../src/main/services/PerformanceService');
      getRecommendedConcurrency.mockClear();
      LlamaService.getInstance().getHealthStatus.mockReturnValueOnce({ initialized: false });

      const early = new ParallelEmbeddingService({ concurrencyLimit: 2, maxRetries: 1 });
      try {
        await new Promise((r) => setTimeout(r, 0));
        expect(getRecommendedConcurrency).not.toHaveBeenCalled();
        // The deferred sync is wired to LlamaService's 'initialized' event.
        expect(LlamaService.getInstance().once).toHaveBeenCalledWith(
          'initialized',
          expect.any(Function)
        );
      } finally {
        await early.shutdown();
      }
    });

    test('the deferred initialized handler syncs with the detected GPU as a hint', async () => {
      const LlamaService = require('../../src/main/services/LlamaService');
      const { getRecommendedConcurrency } = require('../../src/main/services/PerformanceService');
      const llama = LlamaService.getInstance();
      llama.getHealthStatus.mockReturnValueOnce({ initialized: false });
      llama.once.mockClear();

      const early = new ParallelEmbeddingService({ concurrencyLimit: 2, maxRetries: 1 });
      try {
        const [, handler] = llama.once.mock.calls.find(([event]) => event === 'initialized');
        getRecommendedConcurrency.mockClear();
        // Persistent: the handler reads health more than once (concurrency
        // recalculation first, then the hint for the sync).
        llama.getHealthStatus.mockReturnValue({
          initialized: true,
          gpuBackend: 'vulkan',
          gpuDetected: { type: 'vulkan', name: 'Radeon', vramMB: 8192 }
        });

        handler();

        expect(getRecommendedConcurrency).toHaveBeenCalledWith({
          gpuHint: expect.objectContaining({ type: 'vulkan' })
        });
      } finally {
        llama.getHealthStatus.mockReturnValue({ initialized: true });
        await early.shutdown();
      }
    });
  });
});
