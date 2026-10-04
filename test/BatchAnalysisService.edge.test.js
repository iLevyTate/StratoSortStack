/**
 * Edge/bug-catching tests for BatchAnalysisService
 * Focus: backpressure loop safety, embedding progress unsubscribe, and grouped analysis resilience.
 */

const mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};

jest.mock('../src/shared/logger', () => ({
  createLogger: () => mockLogger
}));

jest.mock('../src/shared/config/index', () => ({
  get: jest.fn((_, fallback) => fallback)
}));

const mockBatchProcessor = {
  concurrencyLimit: 3,
  processBatch: jest.fn()
};

jest.mock('../src/main/utils/llmOptimization', () => ({
  globalBatchProcessor: mockBatchProcessor,
  BatchProcessor: jest.fn().mockImplementation(() => mockBatchProcessor)
}));

jest.mock('../src/main/services/PerformanceService', () => ({
  getRecommendedConcurrency: jest.fn().mockResolvedValue({
    maxConcurrent: 2
  })
}));

jest.mock('../src/main/services/ModelAccessCoordinator', () => ({
  getInstance: jest.fn(() => ({
    getQueueStats: jest.fn(() => ({
      text: { queued: 0, pending: 0, concurrency: 1 },
      vision: { queued: 0, pending: 0, concurrency: 1 },
      embedding: { queued: 0, pending: 0, concurrency: 1 }
    }))
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
  flushAllEmbeddings: jest.fn()
}));

jest.mock('../src/main/analysis/imageAnalysis', () => ({
  analyzeImageFile: jest.fn(),
  flushAllEmbeddings: jest.fn()
}));

jest.mock('../src/main/services/ParallelEmbeddingService', () => ({
  getInstance: jest.fn(() => ({
    concurrencyLimit: 3,
    getStats: jest.fn(() => ({ processed: 0, failed: 0, pending: 0 }))
  }))
}));

const mockAnalysisQueue = {
  getStats: jest.fn(),
  onProgress: jest.fn()
};

jest.mock('../src/main/analysis/embeddingQueue/stageQueues', () => ({
  analysisQueue: mockAnalysisQueue
}));

jest.mock('../src/main/analysis/embeddingQueue/queueManager', () => ({
  forceFlush: jest.fn().mockResolvedValue(undefined),
  shutdown: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../src/main/services/autoOrganize/fileTypeUtils', () => ({
  getFileTypeCategory: jest.fn((ext) => (ext === '.jpg' ? 'Images' : 'Documents')),
  getFileTypeSingular: jest.fn((ext) => (ext === '.jpg' ? 'Image' : 'Document'))
}));

describe('BatchAnalysisService (edge)', () => {
  const flushMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const advance = async (ms) => {
    if (typeof jest.advanceTimersByTimeAsync === 'function') {
      await jest.advanceTimersByTimeAsync(ms);
      return;
    }
    jest.advanceTimersByTime(ms);
    await flushMicrotasks();
  };

  let freememSpy;

  afterEach(() => {
    freememSpy?.mockRestore();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    // analyzeFiles pauses each file start for up to 8 s while os.freemem() is
    // under 300 MB. macOS reports only fully unused pages as free, so CI
    // runners there sit below the floor and the ordering test timed out.
    // Pin a healthy value; the memory guard is not what these tests cover.
    freememSpy = jest.spyOn(require('os'), 'freemem').mockReturnValue(8 * 1024 * 1024 * 1024);

    // default queue stats
    mockAnalysisQueue.getStats.mockReturnValue({
      queueLength: 0,
      failedItemsCount: 0,
      deadLetterCount: 0,
      capacityPercent: 0
    });
    mockAnalysisQueue.onProgress.mockReturnValue(() => {});

    const {
      analyzeDocumentFile,
      flushAllEmbeddings: flushDocs
    } = require('../src/main/analysis/documentAnalysis');
    const {
      analyzeImageFile,
      flushAllEmbeddings: flushImages
    } = require('../src/main/analysis/imageAnalysis');
    analyzeDocumentFile.mockResolvedValue({ ok: true });
    analyzeImageFile.mockResolvedValue({ ok: true });
    flushDocs.mockResolvedValue(undefined);
    flushImages.mockResolvedValue(undefined);

    mockBatchProcessor.processBatch.mockImplementation(async (items, processor, options) => {
      const results = [];
      const errors = [];
      let successful = 0;
      for (let i = 0; i < items.length; i++) {
        const r = await processor(items[i], i);
        results.push(r);
        if (r.success) successful++;
        if (options?.onProgress)
          options.onProgress({ completed: i + 1, total: items.length, percent: 100 });
        if (options?.stopOnError && !r.success) break;
      }
      return { results, errors, successful };
    });
  });

  test('analyzeFiles unsubscribes embedding progress even if execution throws', async () => {
    const unsubscribe = jest.fn();
    mockAnalysisQueue.onProgress.mockReturnValueOnce(unsubscribe);
    mockBatchProcessor.processBatch.mockRejectedValueOnce(new Error('boom'));

    const BatchAnalysisService = require('../src/main/services/BatchAnalysisService');
    const service = new BatchAnalysisService({ concurrency: 1 });

    await expect(
      service.analyzeFiles(['C:\\a.pdf'], [], { onEmbeddingProgress: jest.fn() })
    ).rejects.toThrow('boom');
    expect(unsubscribe).toHaveBeenCalled();
  });

  test('backpressure waits for queue to drain but does not loop forever (drain scenario)', async () => {
    jest.useFakeTimers();
    // The memory-headroom guard polls os.freemem() with a real 1s delay; under
    // fake timers a low-memory host would never get past it. Pin it healthy.
    const os = require('os');
    const freememSpy = jest.spyOn(os, 'freemem').mockReturnValue(8 * 1024 * 1024 * 1024);

    // Key the queue state on (fake) elapsed time, not call count: analyzeFiles
    // reads getStats() for bookkeeping before the backpressure check, so a
    // call-count script silently skips the wait entirely.
    const startedAt = Date.now();
    mockAnalysisQueue.getStats.mockImplementation(() =>
      Date.now() - startedAt < 1200
        ? { queueLength: 100, capacityPercent: 80, failedItemsCount: 0, deadLetterCount: 0 }
        : { queueLength: 10, capacityPercent: 40, failedItemsCount: 0, deadLetterCount: 0 }
    );

    try {
      const BatchAnalysisService = require('../src/main/services/BatchAnalysisService');
      const service = new BatchAnalysisService({ concurrency: 1 });

      const p = service.analyzeFiles(['C:\\a.pdf'], [], { concurrency: 1 });
      // Backpressure polls after 500ms (still full) then 750ms more (drained).
      await advance(500);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[BATCH-ANALYSIS] Backpressure: embedding queue at capacity',
        expect.objectContaining({ capacityPercent: 80 })
      );
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        '[BATCH-ANALYSIS] Embedding queue drained, resuming analysis',
        expect.anything()
      );

      await advance(800);
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[BATCH-ANALYSIS] Embedding queue drained, resuming analysis',
        expect.anything()
      );

      await expect(p).resolves.toEqual(expect.objectContaining({ total: 1, successful: 1 }));
    } finally {
      freememSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  test('flushAllEmbeddings failures are tolerated (Promise.allSettled)', async () => {
    const { flushAllEmbeddings: flushDocs } = require('../src/main/analysis/documentAnalysis');
    const { flushAllEmbeddings: flushImages } = require('../src/main/analysis/imageAnalysis');
    flushDocs.mockRejectedValueOnce(new Error('docs flush failed'));
    flushImages.mockRejectedValueOnce(new Error('images flush failed'));

    const BatchAnalysisService = require('../src/main/services/BatchAnalysisService');
    const service = new BatchAnalysisService({ concurrency: 1 });

    const result = await service.analyzeFiles(['C:\\a.pdf'], [], {});
    expect(result.success).toBe(true);
    expect(result.successful).toBe(1);
  });

  test('analyzeFilesGrouped merges fulfilled groups and tolerates a rejected group', async () => {
    const BatchAnalysisService = require('../src/main/services/BatchAnalysisService');
    const service = new BatchAnalysisService({ concurrency: 1 });

    // Force analyzeFiles to reject for one group
    const orig = service.analyzeFiles.bind(service);
    jest.spyOn(service, 'analyzeFiles').mockImplementation(async (files, folders, options) => {
      if (files.some((f) => f.endsWith('.jpg'))) {
        throw new Error('group failed');
      }
      return orig(files, folders, options);
    });

    const res = await service.analyzeFilesGrouped(['C:\\a.pdf', 'C:\\b.jpg'], [], {});
    expect(res.total).toBe(2);
    expect(res.results.length).toBe(1); // only pdf fulfilled
  });

  test('runs documents section before images by default', async () => {
    const { analyzeDocumentFile } = require('../src/main/analysis/documentAnalysis');
    const { analyzeImageFile } = require('../src/main/analysis/imageAnalysis');
    const sequence = [];

    analyzeDocumentFile.mockImplementation(async (filePath) => {
      sequence.push(`doc:${filePath}`);
      return { ok: true };
    });
    analyzeImageFile.mockImplementation(async (filePath) => {
      sequence.push(`img:${filePath}`);
      return { ok: true };
    });

    const BatchAnalysisService = require('../src/main/services/BatchAnalysisService');
    const service = new BatchAnalysisService({ concurrency: 2 });
    await service.analyzeFiles(['C:\\a.jpg', 'C:\\b.pdf', 'C:\\c.jpg', 'C:\\d.txt'], [], {});

    expect(sequence).toEqual(['doc:C:\\b.pdf', 'doc:C:\\d.txt', 'img:C:\\a.jpg', 'img:C:\\c.jpg']);
  });
});
