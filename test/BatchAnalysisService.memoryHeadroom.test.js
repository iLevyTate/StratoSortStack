/**
 * The near-OOM pause before each file start must use AVAILABLE memory. On
 * macOS os.freemem() counts free pages only and sits under the 300 MB floor
 * on a healthy machine, so every file waited up to 8 s for nothing.
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
const MiB = 1024 * 1024;

describe('BatchAnalysisService memory headroom', () => {
  let service;
  let systemMemory;
  let logger;
  let freememSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    systemMemory = require('../src/main/utils/systemMemory');
    logger = require('../src/shared/logger').logger;
    // What macOS reports as "free" on a healthy machine: under the floor.
    freememSpy = jest.spyOn(require('os'), 'freemem').mockReturnValue(100 * MiB);

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
    service = new BatchAnalysisService({ concurrency: 2 });
  });

  afterEach(() => {
    freememSpy.mockRestore();
  });

  const pauseLines = () =>
    logger.warn.mock.calls.filter(([msg]) => /Pausing next file/.test(String(msg)));

  test('plenty available: no pause even when free pages are under the floor', async () => {
    systemMemory.getAvailableMemoryBytes.mockResolvedValue(4 * GiB);

    const result = await service.analyzeFiles(['/in/a.pdf', '/in/b.pdf']);

    expect(result.successful).toBe(2);
    expect(pauseLines()).toHaveLength(0);
    expect(result.stats.modalities.documents.memoryWaitMs).toBe(0);
  });

  test('genuinely low: still pauses, logs available memory, and counts the wait', async () => {
    systemMemory.getAvailableMemoryBytes
      .mockResolvedValueOnce(100 * MiB) // first check: under the floor
      .mockResolvedValue(4 * GiB); // recovered on the next poll

    const result = await service.analyzeFiles(['/in/a.pdf']);

    expect(result.successful).toBe(1);
    expect(pauseLines()).toHaveLength(1);
    expect(pauseLines()[0][1]).toEqual(expect.objectContaining({ availableMemMB: 100 }));
    expect(result.stats.modalities.documents.memoryWaitMs).toBeGreaterThanOrEqual(900);
  });
});
