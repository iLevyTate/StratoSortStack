/**
 * Each section summary carries where a slow run's time went: the time file
 * starts spent waiting for the embedding queue to drain (backpressure), and
 * the median, 90th percentile and longest per-file analysis time.
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

jest.mock('../src/main/utils/systemMemory', () => ({
  getAvailableMemoryBytes: jest.fn(),
  peekAvailableMemoryBytes: jest.fn(() => 8 * 1024 * 1024 * 1024)
}));

const mockBatchProcessor = {
  concurrencyLimit: 3,
  processBatch: jest.fn(),
  getStats: jest.fn().mockReturnValue({ totalProcessed: 0, totalErrors: 0 })
};

jest.mock('../src/main/utils/llmOptimization', () => ({
  globalBatchProcessor: mockBatchProcessor,
  BatchProcessor: jest.fn().mockImplementation(() => mockBatchProcessor)
}));

jest.mock('../src/main/services/PerformanceService', () => ({
  getRecommendedConcurrency: jest.fn().mockResolvedValue({
    maxConcurrent: 3,
    reason: 'test',
    vramMB: 24000
  })
}));

jest.mock('../src/main/services/ModelAccessCoordinator', () => ({
  getInstance: jest.fn(() => ({
    getQueueStats: jest.fn().mockReturnValue({
      text: { queued: 0, pending: 0, concurrency: 1 },
      vision: { queued: 0, pending: 0, concurrency: 1 },
      embedding: { queued: 0, pending: 0, concurrency: 1 }
    })
  }))
}));

jest.mock('../src/main/services/LlamaService', () => ({
  getInstance: jest.fn(() => ({
    enterVisionBatchMode: jest.fn().mockResolvedValue(undefined),
    exitVisionBatchMode: jest.fn().mockResolvedValue(undefined)
  }))
}));

jest.mock('../src/main/analysis/documentAnalysis', () => ({
  analyzeDocumentFile: jest.fn(),
  flushAllEmbeddings: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../src/main/analysis/imageAnalysis', () => ({
  analyzeImageFile: jest.fn(),
  flushAllEmbeddings: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../src/main/services/ParallelEmbeddingService', () => ({
  getInstance: jest.fn(() => ({
    concurrencyLimit: 5,
    getStats: jest.fn().mockReturnValue({ processed: 0, failed: 0, pending: 0 }),
    setConcurrencyLimit: jest.fn()
  }))
}));

jest.mock('../src/main/analysis/embeddingQueue/stageQueues', () => ({
  analysisQueue: {
    getStats: jest.fn().mockReturnValue({
      queueLength: 0,
      failedItemsCount: 0,
      deadLetterCount: 0,
      capacityPercent: 0
    }),
    onProgress: jest.fn().mockReturnValue(() => {}),
    forceFlush: jest.fn().mockResolvedValue(undefined),
    shutdown: jest.fn().mockResolvedValue(undefined)
  }
}));

jest.mock('../src/main/analysis/embeddingQueue/queueManager', () => ({
  forceFlush: jest.fn().mockResolvedValue(undefined),
  shutdown: jest.fn().mockResolvedValue(undefined)
}));

const GiB = 1024 * 1024 * 1024;

describe('BatchAnalysisService section timing', () => {
  let service;
  let stageQueues;

  beforeEach(() => {
    jest.clearAllMocks();
    require('../src/main/utils/systemMemory').getAvailableMemoryBytes.mockResolvedValue(4 * GiB);
    stageQueues = require('../src/main/analysis/embeddingQueue/stageQueues');
    mockBatchProcessor.processBatch.mockImplementation(async (items, processor) => {
      const results = [];
      let successful = 0;
      for (let i = 0; i < items.length; i++) {
        const result = await processor(items[i], i);
        results.push(result);
        if (result?.success) successful++;
      }
      return { results, errors: [], successful };
    });
    require('../src/main/analysis/documentAnalysis').analyzeDocumentFile.mockResolvedValue({
      category: 'document',
      confidence: 85
    });
    const BatchAnalysisService = require('../src/main/services/BatchAnalysisService');
    service = new BatchAnalysisService({ concurrency: 1 });
  });

  test('reports per-file duration percentiles and no backpressure wait', async () => {
    const result = await service.analyzeFiles(['/in/a.pdf', '/in/b.pdf', '/in/c.pdf']);
    const docs = result.stats.modalities.documents;
    expect(docs.backpressureWaitMs).toBe(0);
    expect(docs.fileMs).toEqual({
      p50: expect.any(Number),
      p90: expect.any(Number),
      max: expect.any(Number)
    });
    expect(docs.fileMs.p50).toBeLessThanOrEqual(docs.fileMs.p90);
    expect(docs.fileMs.p90).toBeLessThanOrEqual(docs.fileMs.max);
  });

  test('counts the time a file start waited on a full embedding queue', async () => {
    const full = { queueLength: 900, failedItemsCount: 0, deadLetterCount: 0, capacityPercent: 90 };
    const empty = { queueLength: 0, failedItemsCount: 0, deadLetterCount: 0, capacityPercent: 0 };
    // Full when the file start checks it; drained by the wait loop's next look.
    let drained = false;
    stageQueues.analysisQueue.getStats.mockImplementation(() => (drained ? empty : full));
    const drain = setTimeout(() => {
      drained = true;
    }, 100);

    const result = await service.analyzeFiles(['/in/a.pdf']);
    clearTimeout(drain);
    stageQueues.analysisQueue.getStats.mockReturnValue(empty);

    expect(result.successful).toBe(1);
    expect(result.stats.modalities.documents.backpressureWaitMs).toBeGreaterThan(0);
  });

  test('a section with no finished files has no percentiles', async () => {
    const result = await service.analyzeFiles(['/in/a.pdf']);
    expect(result.stats.modalities.images.fileMs).toBeNull();
  });
});
