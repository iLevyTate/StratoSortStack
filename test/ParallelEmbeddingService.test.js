/**
 * Tests for ParallelEmbeddingService
 * Tests parallel embedding generation with semaphore concurrency control
 */

// Mock logger
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

// Mock config
jest.mock('../src/shared/config/index', () => ({
  get: jest.fn((key, defaultValue) => defaultValue)
}));

// Mock LlamaService - define inside factory to survive jest.resetModules()
jest.mock('../src/main/services/LlamaService', () => {
  const mockInstance = {
    generateEmbedding: jest.fn().mockResolvedValue({
      embedding: [0.1, 0.2, 0.3]
    }),
    getHealthStatus: jest.fn(() => ({ initialized: true })),
    testConnection: jest.fn().mockResolvedValue({ success: true }),
    getConfig: jest.fn().mockReturnValue({ embeddingModel: 'mxbai-embed-large' }),
    acquireModelLoadLock: jest.fn().mockResolvedValue(() => {})
  };
  return {
    getInstance: jest.fn(() => mockInstance),
    __mockInstance: mockInstance // Expose for test access
  };
});

// Get reference to mock instance after module load
const getMockLlamaServiceInstance = () =>
  require('../src/main/services/LlamaService').__mockInstance;

describe('ParallelEmbeddingService', () => {
  let ParallelEmbeddingService;
  let getInstance;
  let resetInstance;
  let mockLlamaServiceInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    // Get fresh mock instance after resetModules
    mockLlamaServiceInstance = getMockLlamaServiceInstance();
    // Reset LlamaService mock to success
    mockLlamaServiceInstance.generateEmbedding.mockResolvedValue({
      embedding: [0.1, 0.2, 0.3]
    });

    const module = require('../src/main/services/ParallelEmbeddingService');
    ParallelEmbeddingService = module.ParallelEmbeddingService;
    getInstance = module.getInstance;
    resetInstance = module.resetInstance;
  });

  describe('constructor', () => {
    test('creates instance with default options', () => {
      const service = new ParallelEmbeddingService();

      expect(service.concurrencyLimit).toBeGreaterThanOrEqual(2);
      expect(service.concurrencyLimit).toBeLessThanOrEqual(10);
      expect(service.activeRequests).toBe(0);
      expect(service.waitQueue).toEqual([]);
    });

    test('accepts custom concurrency limit', () => {
      const service = new ParallelEmbeddingService({ concurrencyLimit: 3 });

      expect(service.concurrencyLimit).toBe(3);
    });

    test('caps concurrency at 10', () => {
      const service = new ParallelEmbeddingService({ concurrencyLimit: 100 });

      expect(service.concurrencyLimit).toBe(10);
    });

    test('initializes stats object', () => {
      const service = new ParallelEmbeddingService();

      expect(service.stats.totalRequests).toBe(0);
      expect(service.stats.successfulRequests).toBe(0);
      expect(service.stats.failedRequests).toBe(0);
      expect(service.stats.peakConcurrency).toBe(0);
    });

    test('accepts custom retry options', () => {
      const service = new ParallelEmbeddingService({
        maxRetries: 5,
        initialRetryDelayMs: 500
      });

      expect(service.maxRetries).toBe(5);
      expect(service.initialRetryDelayMs).toBe(500);
    });

    test('preserves explicit zero retry options', () => {
      const service = new ParallelEmbeddingService({
        maxRetries: 0,
        initialRetryDelayMs: 0,
        maxRetryDelayMs: 0
      });

      expect(service.maxRetries).toBe(0);
      expect(service.initialRetryDelayMs).toBe(0);
      expect(service.maxRetryDelayMs).toBe(0);
    });
  });

  describe('_calculateOptimalConcurrency', () => {
    test('returns value based on CPU cores', () => {
      const service = new ParallelEmbeddingService();
      const concurrency = service._calculateOptimalConcurrency();

      expect(concurrency).toBeGreaterThanOrEqual(2);
      expect(concurrency).toBeLessThanOrEqual(10); // Hard cap increased from 5 to 10 for powerful GPUs
    });
  });

  describe('semaphore', () => {
    test('allows requests up to limit', async () => {
      const service = new ParallelEmbeddingService({ concurrencyLimit: 2 });

      await service._acquireSlot();
      await service._acquireSlot();

      expect(service.activeRequests).toBe(2);
    });

    test('queues requests over limit', async () => {
      const service = new ParallelEmbeddingService({ concurrencyLimit: 1 });

      await service._acquireSlot();

      // Second request should be queued
      const waitPromise = service._acquireSlot();
      expect(service.waitQueue.length).toBe(1);

      // Release slot to allow second request
      service._releaseSlot();
      await waitPromise;

      expect(service.activeRequests).toBe(1);
    });

    test('tracks peak concurrency', async () => {
      const service = new ParallelEmbeddingService({ concurrencyLimit: 3 });

      await service._acquireSlot();
      await service._acquireSlot();

      expect(service.stats.peakConcurrency).toBe(2);

      await service._acquireSlot();

      expect(service.stats.peakConcurrency).toBe(3);
    });

    test('clears timeout when releasing to queued request', async () => {
      jest.useFakeTimers();

      const service = new ParallelEmbeddingService({ concurrencyLimit: 1 });
      await service._acquireSlot();

      const waitPromise = service._acquireSlot();
      const queueEntry = service.waitQueue[0];
      const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

      service._releaseSlot();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(queueEntry.timeoutId);

      await waitPromise;
      jest.useRealTimers();
    });
  });

  describe('embedText', () => {
    test('generates embedding for text', async () => {
      const service = new ParallelEmbeddingService();

      const result = await service.embedText('hello world');

      expect(result.vector).toEqual([0.1, 0.2, 0.3]);
      // Model comes from getConfig().embeddingModel since LlamaService.generateEmbedding
      // returns {embedding: [...]} without a model field
      expect(result.model).toBe('mxbai-embed-large');
    });

    test('updates statistics on success', async () => {
      const service = new ParallelEmbeddingService();

      await service.embedText('test');

      expect(service.stats.totalRequests).toBe(1);
      expect(service.stats.successfulRequests).toBe(1);
      expect(service.stats.failedRequests).toBe(0);
    });

    test('throws error on embedding failure', async () => {
      mockLlamaServiceInstance.generateEmbedding.mockRejectedValueOnce(new Error('AI error'));

      const service = new ParallelEmbeddingService();

      // FIX: Now throws error instead of returning fallback zero vector
      // Zero vectors are useless for semantic search and pollute the database
      await expect(service.embedText('test')).rejects.toThrow('Embedding failed: AI error');
    });

    test('releases slot after completion', async () => {
      const service = new ParallelEmbeddingService({ concurrencyLimit: 1 });

      await service.embedText('test');

      expect(service.activeRequests).toBe(0);
    });
  });

  describe('failure and retry accounting', () => {
    test('increments failedRequests when embedText fails terminally', async () => {
      mockLlamaServiceInstance.generateEmbedding.mockRejectedValue(
        Object.assign(new Error('model not found'), { code: 'MODEL_NOT_FOUND' })
      );

      const service = new ParallelEmbeddingService({ maxRetries: 0 });

      await expect(service.embedText('hello')).rejects.toThrow();

      expect(service.stats.totalRequests).toBe(1);
      expect(service.stats.failedRequests).toBe(1);
      expect(service.stats.successfulRequests).toBe(0);
      // Slot must be released even on failure to avoid semaphore starvation.
      expect(service.activeRequests).toBe(0);
    });

    test('non-retryable errors fail immediately without additional attempts', async () => {
      mockLlamaServiceInstance.generateEmbedding.mockRejectedValue(
        Object.assign(new Error('invalid input'), { code: 'INVALID_INPUT' })
      );

      const service = new ParallelEmbeddingService({
        maxRetries: 3,
        initialRetryDelayMs: 0
      });

      await expect(service.embedText('hello')).rejects.toThrow(/invalid input/);

      // Only one call for a non-retryable classification, regardless of maxRetries.
      expect(mockLlamaServiceInstance.generateEmbedding).toHaveBeenCalledTimes(1);
    });

    test('retryable errors trigger retries up to maxRetries then record failure', async () => {
      const transientError = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
      mockLlamaServiceInstance.generateEmbedding
        .mockRejectedValueOnce(transientError)
        .mockRejectedValueOnce(transientError)
        .mockResolvedValueOnce({ embedding: [0.9, 0.8] });

      const service = new ParallelEmbeddingService({
        maxRetries: 3,
        initialRetryDelayMs: 0,
        maxRetryDelayMs: 0
      });

      const result = await service.embedText('retry-me');
      expect(result.vector).toEqual([0.9, 0.8]);
      expect(mockLlamaServiceInstance.generateEmbedding).toHaveBeenCalledTimes(3);
      expect(service.stats.successfulRequests).toBe(1);
      expect(service.stats.failedRequests).toBe(0);
    });

    test('failedRequests accumulates across a batch with mixed outcomes', async () => {
      const service = new ParallelEmbeddingService({ maxRetries: 0 });

      mockLlamaServiceInstance.generateEmbedding
        .mockResolvedValueOnce({ embedding: [1] })
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ embedding: [2] })
        .mockRejectedValueOnce(new Error('boom'));

      await service.batchEmbedTexts(
        [
          { id: '1', text: 'a' },
          { id: '2', text: 'b' },
          { id: '3', text: 'c' },
          { id: '4', text: 'd' }
        ],
        { stopOnError: false }
      );

      expect(service.stats.totalRequests).toBe(4);
      expect(service.stats.successfulRequests).toBe(2);
      expect(service.stats.failedRequests).toBe(2);
    });
  });

  describe('batchEmbedTexts', () => {
    test('processes batch of items', async () => {
      const service = new ParallelEmbeddingService();

      const items = [
        { id: '1', text: 'hello' },
        { id: '2', text: 'world' }
      ];

      const { results, errors, stats } = await service.batchEmbedTexts(items);

      expect(results).toHaveLength(2);
      expect(errors).toHaveLength(0);
      expect(stats.successful).toBe(2);
    });

    test('returns empty results for empty input', async () => {
      const service = new ParallelEmbeddingService();

      const { results, stats } = await service.batchEmbedTexts([]);

      expect(results).toEqual([]);
      expect(stats.total).toBe(0);
    });

    test('reports progress', async () => {
      const service = new ParallelEmbeddingService();
      const progressUpdates = [];

      const items = [
        { id: '1', text: 'hello' },
        { id: '2', text: 'world' }
      ];

      await service.batchEmbedTexts(items, {
        onProgress: (p) => progressUpdates.push(p)
      });

      expect(progressUpdates.length).toBe(2);
      expect(progressUpdates[0].completed).toBeGreaterThanOrEqual(1);
      expect(progressUpdates[1].percent).toBe(100);
    });

    test('collects errors for failed items', async () => {
      mockLlamaServiceInstance.generateEmbedding
        .mockResolvedValueOnce({ embedding: [0.1] })
        .mockRejectedValueOnce(new Error('Failed'));

      const service = new ParallelEmbeddingService();

      const items = [
        { id: '1', text: 'hello' },
        { id: '2', text: 'world' }
      ];

      const { results, errors } = await service.batchEmbedTexts(items);

      // FIX: Now errors are collected instead of returning fallback zero vectors
      // First succeeds, second fails and error is collected
      expect(errors.length).toBe(1);
      expect(errors[0].id).toBe('2');
      expect(errors[0].error).toContain('Failed');
      // Results array contains successful items (filtered from null/undefined)
      // The first item succeeded
      const successfulResults = results.filter((r) => r && r.success);
      expect(successfulResults).toHaveLength(1);
    });

    test('respects stopOnError option', async () => {
      mockLlamaServiceInstance.generateEmbedding.mockRejectedValue(new Error('Failed'));

      const service = new ParallelEmbeddingService();

      const items = [
        { id: '1', text: 'hello' },
        { id: '2', text: 'world' }
      ];

      // With stopOnError: false, all items are attempted even if some fail
      // FIX: Now errors are tracked instead of returning fallback vectors
      const { errors, stats } = await service.batchEmbedTexts(items, { stopOnError: false });

      // All items processed, errors collected
      expect(service.stats.totalRequests).toBe(2);
      expect(errors.length).toBe(2); // Both items failed
      expect(stats.failed).toBe(2);
    });

    test('stopOnError=true rejects and stops further processing', async () => {
      mockLlamaServiceInstance.generateEmbedding.mockRejectedValueOnce(new Error('Failed'));

      const service = new ParallelEmbeddingService();

      const items = [
        { id: '1', text: 'hello' },
        { id: '2', text: 'world' }
      ];

      await expect(service.batchEmbedTexts(items, { stopOnError: true })).rejects.toThrow('Failed');
      expect(mockLlamaServiceInstance.generateEmbedding).toHaveBeenCalledTimes(1);
      expect(service.stats.totalRequests).toBe(1);
    });

    test('includes metadata in results', async () => {
      const service = new ParallelEmbeddingService();

      const items = [{ id: '1', text: 'hello', meta: { source: 'test' } }];

      const { results } = await service.batchEmbedTexts(items);

      expect(results[0].meta.source).toBe('test');
    });

    test('dedupes identical texts, issuing one embedding call per unique text', async () => {
      mockLlamaServiceInstance.generateEmbedding.mockClear();
      const service = new ParallelEmbeddingService();

      const items = [
        { id: '1', text: 'duplicate', meta: { source: 'a' } },
        { id: '2', text: 'unique', meta: { source: 'b' } },
        { id: '3', text: 'duplicate', meta: { source: 'c' } },
        { id: '4', text: 'duplicate', meta: { source: 'd' } }
      ];

      const { results, errors, stats } = await service.batchEmbedTexts(items);

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(4);
      expect(stats.total).toBe(4);
      expect(stats.uniqueProcessed).toBe(2);
      expect(stats.dedupSavings).toBe(2);

      // Each original id must appear exactly once with its own meta preserved.
      const byId = Object.fromEntries(results.map((r) => [r.id, r]));
      expect(byId['1'].meta.source).toBe('a');
      expect(byId['2'].meta.source).toBe('b');
      expect(byId['3'].meta.source).toBe('c');
      expect(byId['4'].meta.source).toBe('d');

      // Duplicates share the same vector reference (by design — vectors are
      // treated as immutable downstream).
      expect(byId['1'].vector).toBe(byId['3'].vector);
      expect(byId['1'].vector).toBe(byId['4'].vector);

      // Exactly one embedding call per unique text.
      expect(mockLlamaServiceInstance.generateEmbedding).toHaveBeenCalledTimes(2);
    });

    test('dedupe can be disabled via options.dedupe=false', async () => {
      mockLlamaServiceInstance.generateEmbedding.mockClear();
      const service = new ParallelEmbeddingService();

      const items = [
        { id: '1', text: 'duplicate' },
        { id: '2', text: 'duplicate' },
        { id: '3', text: 'duplicate' }
      ];

      const { stats } = await service.batchEmbedTexts(items, { dedupe: false });

      expect(stats.total).toBe(3);
      expect(stats.dedupSavings ?? 0).toBe(0);
      expect(mockLlamaServiceInstance.generateEmbedding).toHaveBeenCalledTimes(3);
    });

    test('dedup fans out errors to every original occurrence', async () => {
      mockLlamaServiceInstance.generateEmbedding.mockRejectedValue(new Error('boom'));
      const service = new ParallelEmbeddingService();

      const items = [
        { id: 'a', text: 'same' },
        { id: 'b', text: 'same' },
        { id: 'c', text: 'same' }
      ];

      const { errors, stats } = await service.batchEmbedTexts(items);

      expect(stats.uniqueProcessed).toBe(1);
      expect(errors).toHaveLength(3);
      expect(errors.map((e) => e.id).sort()).toEqual(['a', 'b', 'c']);
      expect(mockLlamaServiceInstance.generateEmbedding).toHaveBeenCalledTimes(1);
    });
  });

  describe('batchEmbedFileSummaries', () => {
    test('converts file summaries to items', async () => {
      const service = new ParallelEmbeddingService();

      const files = [{ fileId: 'f1', summary: 'A document', filePath: '/path/file1.pdf' }];

      const { results } = await service.batchEmbedFileSummaries(files);

      expect(results[0].id).toBe('f1');
      expect(results[0].meta.path).toBe('/path/file1.pdf');
    });
  });

  describe('batchEmbedFolders', () => {
    test('converts folders to items', async () => {
      const service = new ParallelEmbeddingService();

      const folders = [{ id: 'folder1', name: 'Documents', description: 'My docs' }];

      const { results } = await service.batchEmbedFolders(folders);

      expect(results[0].meta.name).toBe('Documents');
      expect(results[0].meta.description).toBe('My docs');
    });

    test('generates id from name if not provided', async () => {
      const service = new ParallelEmbeddingService();

      const folders = [{ name: 'Photos' }];

      // Call batchEmbedTexts via batchEmbedFolders
      const spy = jest.spyOn(service, 'batchEmbedTexts');
      await service.batchEmbedFolders(folders);

      expect(spy).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: 'folder:Photos' })]),
        expect.anything()
      );
    });

    test('prefers embeddingText over name/description join', async () => {
      const service = new ParallelEmbeddingService();
      const spy = jest.spyOn(service, 'batchEmbedTexts');
      const enriched = '3D Prints - stl | File types: stl obj | Domain: 3d';
      await service.batchEmbedFolders([
        { id: 'f1', name: '3D Prints', description: 'stl', embeddingText: enriched }
      ]);

      expect(spy).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: 'f1', text: enriched })]),
        expect.anything()
      );
    });
  });

  describe('setConcurrencyLimit', () => {
    test('updates concurrency limit', () => {
      const service = new ParallelEmbeddingService({ concurrencyLimit: 3 });

      service.setConcurrencyLimit(5);

      expect(service.concurrencyLimit).toBe(5);
    });

    test('enforces minimum of 1', () => {
      const service = new ParallelEmbeddingService();

      service.setConcurrencyLimit(0);

      expect(service.concurrencyLimit).toBe(1);
    });

    test('enforces maximum of 10', () => {
      const service = new ParallelEmbeddingService();

      service.setConcurrencyLimit(20);

      expect(service.concurrencyLimit).toBe(10);
    });
  });

  describe('getStats', () => {
    test('returns current statistics', async () => {
      const service = new ParallelEmbeddingService({ concurrencyLimit: 3 });
      await service.embedText('test');

      const stats = service.getStats();

      expect(stats.totalRequests).toBe(1);
      expect(stats.concurrencyLimit).toBe(3);
      expect(stats.successRate).toBe(100);
    });

    test('calculates average latency', async () => {
      const service = new ParallelEmbeddingService();
      await service.embedText('test');

      const stats = service.getStats();

      expect(stats.avgLatencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('resetStats', () => {
    test('clears all statistics', async () => {
      const service = new ParallelEmbeddingService();
      await service.embedText('test');

      service.resetStats();

      expect(service.stats.totalRequests).toBe(0);
      expect(service.stats.successfulRequests).toBe(0);
      expect(service.stats.peakConcurrency).toBe(0);
    });
  });

  describe('shutdown', () => {
    test('rejects pending requests', async () => {
      jest.useFakeTimers();

      const service = new ParallelEmbeddingService({ concurrencyLimit: 1 });
      await service._acquireSlot();

      const pendingPromise = service._acquireSlot();
      // Attach the handler up front: shutdown rejects the queued entry
      // mid-flight, and an unattached rejection fails the test as unhandled.
      const pendingRejection = pendingPromise.catch((e) => e);

      // The held slot is never released here, so shutdown's bounded
      // active-request drain must time out — advance fake timers past the
      // bgWork drain budget (5s) plus the active-request drain (10s).
      const shutdownPromise = service.shutdown();
      await jest.advanceTimersByTimeAsync(20000);
      await shutdownPromise;

      const err = await pendingRejection;
      expect(err.message).toContain('Service shutting down');

      jest.useRealTimers();
    });

    test('clears queue', async () => {
      const service = new ParallelEmbeddingService();

      await service.shutdown();

      expect(service.waitQueue).toEqual([]);
      expect(service.activeRequests).toBe(0);
    });
  });

  describe('isServiceHealthy', () => {
    test('returns true when llama responds', async () => {
      const service = new ParallelEmbeddingService();

      const healthy = await service.isServiceHealthy();

      expect(healthy).toBe(true);
    });

    test('returns false when llama fails', async () => {
      mockLlamaServiceInstance.testConnection.mockRejectedValueOnce(new Error('Connection failed'));

      const service = new ParallelEmbeddingService();

      const healthy = await service.isServiceHealthy();

      expect(healthy).toBe(false);
    });
  });

  describe('waitForService', () => {
    test('returns true when service becomes available', async () => {
      const service = new ParallelEmbeddingService();

      const available = await service.waitForService({
        maxWaitMs: 1000,
        checkIntervalMs: 100
      });

      expect(available).toBe(true);
    });

    test('returns false on timeout', async () => {
      mockLlamaServiceInstance.testConnection.mockRejectedValue(new Error('Connection failed'));

      const service = new ParallelEmbeddingService();

      const available = await service.waitForService({
        maxWaitMs: 100,
        checkIntervalMs: 50
      });

      expect(available).toBe(false);
    });
  });

  describe('_adjustConcurrency', () => {
    test('reduces concurrency on high error rate', async () => {
      const service = new ParallelEmbeddingService({ concurrencyLimit: 5 });
      service.stats.successfulRequests = 5;
      service.stats.failedRequests = 5; // 50% error rate

      service._adjustConcurrency();

      expect(service.concurrencyLimit).toBeLessThan(5);
    });

    test('does not adjust with insufficient data', () => {
      const service = new ParallelEmbeddingService({ concurrencyLimit: 5 });
      service.stats.successfulRequests = 3;
      service.stats.failedRequests = 0;

      service._adjustConcurrency();

      expect(service.concurrencyLimit).toBe(5);
    });
  });

  describe('_classifyError', () => {
    test('classifies network errors', () => {
      const service = new ParallelEmbeddingService();

      expect(service._classifyError({ code: 'ECONNREFUSED' })).toBe('NETWORK_ERROR');
      expect(service._classifyError({ code: 'ECONNRESET' })).toBe('NETWORK_ERROR');
      expect(service._classifyError({ code: 'ETIMEDOUT' })).toBe('NETWORK_ERROR');
      expect(service._classifyError({ message: 'connection refused' })).toBe('NETWORK_ERROR');
      expect(service._classifyError({ message: 'network error' })).toBe('NETWORK_ERROR');
    });

    test('classifies service unavailable errors', () => {
      const service = new ParallelEmbeddingService();

      expect(service._classifyError({ code: 'SERVICE_UNAVAILABLE' })).toBe('SERVICE_UNAVAILABLE');
      expect(service._classifyError({ code: 'SERVICE_SHUTDOWN' })).toBe('SERVICE_UNAVAILABLE');
      expect(service._classifyError({ message: 'service unavailable' })).toBe(
        'SERVICE_UNAVAILABLE'
      );
      expect(service._classifyError({ message: 'shutting down' })).toBe('SERVICE_UNAVAILABLE');
    });

    test('classifies timeout errors', () => {
      const service = new ParallelEmbeddingService();

      expect(service._classifyError({ code: 'TIMEOUT' })).toBe('TIMEOUT');
      expect(service._classifyError({ code: 'QUEUE_TIMEOUT' })).toBe('TIMEOUT');
      expect(service._classifyError({ message: 'request timed out' })).toBe('TIMEOUT');
    });

    test('classifies model not found errors', () => {
      const service = new ParallelEmbeddingService();

      expect(service._classifyError({ message: 'model not found' })).toBe('MODEL_NOT_FOUND');
      expect(service._classifyError({ message: 'model does not exist' })).toBe('MODEL_NOT_FOUND');
      expect(service._classifyError({ message: 'unknown model' })).toBe('MODEL_NOT_FOUND');
    });

    test('classifies rate limiting errors', () => {
      const service = new ParallelEmbeddingService();

      expect(service._classifyError({ code: 'RATE_LIMITED' })).toBe('RATE_LIMITED');
      expect(service._classifyError({ message: 'rate limit exceeded' })).toBe('RATE_LIMITED');
      expect(service._classifyError({ message: 'too many requests' })).toBe('RATE_LIMITED');
    });

    test('classifies out of memory errors', () => {
      const service = new ParallelEmbeddingService();

      expect(service._classifyError({ message: 'out of memory' })).toBe('OUT_OF_MEMORY');
      expect(service._classifyError({ message: 'OOM killed' })).toBe('OUT_OF_MEMORY');
    });

    test('classifies invalid input errors', () => {
      const service = new ParallelEmbeddingService();

      expect(service._classifyError({ message: 'invalid input' })).toBe('INVALID_INPUT');
      expect(service._classifyError({ message: 'empty text' })).toBe('INVALID_INPUT');
      expect(service._classifyError({ message: 'malformed request' })).toBe('INVALID_INPUT');
    });

    test('returns UNKNOWN for unclassified errors', () => {
      const service = new ParallelEmbeddingService();

      expect(service._classifyError({ message: 'something went wrong' })).toBe('UNKNOWN');
      expect(service._classifyError({})).toBe('UNKNOWN');
    });
  });

  describe('_isRetryableError', () => {
    test('returns true for network errors', () => {
      const service = new ParallelEmbeddingService();

      expect(service._isRetryableError({ code: 'ECONNREFUSED' })).toBe(true);
      expect(service._isRetryableError({ code: 'ECONNRESET' })).toBe(true);
      expect(service._isRetryableError({ code: 'ETIMEDOUT' })).toBe(true);
    });

    test('returns true for service unavailable errors', () => {
      const service = new ParallelEmbeddingService();

      expect(service._isRetryableError({ code: 'SERVICE_UNAVAILABLE' })).toBe(true);
      expect(service._isRetryableError({ message: 'service unavailable' })).toBe(true);
    });

    test('returns true for timeout errors', () => {
      const service = new ParallelEmbeddingService();

      expect(service._isRetryableError({ code: 'QUEUE_TIMEOUT' })).toBe(true);
      expect(service._isRetryableError({ message: 'request timed out' })).toBe(true);
    });

    test('returns true for rate limiting errors', () => {
      const service = new ParallelEmbeddingService();

      expect(service._isRetryableError({ code: 'RATE_LIMITED' })).toBe(true);
      expect(service._isRetryableError({ message: 'rate limit exceeded' })).toBe(true);
    });

    test('returns false for model not found errors', () => {
      const service = new ParallelEmbeddingService();

      expect(service._isRetryableError({ message: 'model not found' })).toBe(false);
    });

    test('returns false for out of memory errors', () => {
      const service = new ParallelEmbeddingService();

      expect(service._isRetryableError({ message: 'out of memory' })).toBe(false);
    });

    test('returns false for invalid input errors', () => {
      const service = new ParallelEmbeddingService();

      expect(service._isRetryableError({ message: 'invalid input' })).toBe(false);
    });

    test('returns false for unknown errors', () => {
      const service = new ParallelEmbeddingService();

      expect(service._isRetryableError({ message: 'something went wrong' })).toBe(false);
    });
  });

  describe('singleton', () => {
    test('getInstance returns same instance', () => {
      const instance1 = getInstance();
      const instance2 = getInstance();

      expect(instance1).toBe(instance2);
    });

    test('resetInstance clears singleton', async () => {
      const instance1 = getInstance();
      await resetInstance();
      const instance2 = getInstance();

      expect(instance1).not.toBe(instance2);
    });
  });
});
