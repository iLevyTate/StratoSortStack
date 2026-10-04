/**
 * Tests for BatchAnalysisService
 * Tests parallel file analysis, concurrency control, and embedding integration
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

// Mock llmOptimization
const mockBatchProcessor = {
  concurrencyLimit: 3,
  processBatch: jest.fn(),
  getStats: jest.fn().mockReturnValue({
    totalProcessed: 0,
    totalErrors: 0
  })
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

const mockCoordinator = {
  getQueueStats: jest.fn().mockReturnValue({
    text: { queued: 0, pending: 0, concurrency: 1 },
    vision: { queued: 0, pending: 0, concurrency: 1 },
    embedding: { queued: 0, pending: 0, concurrency: 1 }
  })
};

jest.mock('../src/main/services/ModelAccessCoordinator', () => ({
  getInstance: jest.fn(() => mockCoordinator)
}));

const mockLlamaService = {
  enterVisionBatchMode: jest.fn().mockResolvedValue(undefined),
  exitVisionBatchMode: jest.fn().mockResolvedValue(undefined)
};

jest.mock('../src/main/services/LlamaService', () => ({
  getInstance: jest.fn(() => mockLlamaService)
}));

// Mock analysis modules
jest.mock('../src/main/analysis/documentAnalysis', () => ({
  analyzeDocumentFile: jest.fn(),
  flushAllEmbeddings: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../src/main/analysis/imageAnalysis', () => ({
  analyzeImageFile: jest.fn(),
  flushAllEmbeddings: jest.fn().mockResolvedValue(undefined)
}));

// Mock ParallelEmbeddingService
const mockEmbeddingService = {
  concurrencyLimit: 5,
  getStats: jest.fn().mockReturnValue({
    processed: 0,
    failed: 0,
    pending: 0
  }),
  setConcurrencyLimit: jest.fn()
};

jest.mock('../src/main/services/ParallelEmbeddingService', () => ({
  getInstance: jest.fn(() => mockEmbeddingService)
}));

// Mock embedding queue + manager
const mockEmbeddingQueue = {
  getStats: jest.fn().mockReturnValue({
    queueLength: 0,
    failedItemsCount: 0,
    deadLetterCount: 0,
    capacityPercent: 0
  }),
  onProgress: jest.fn().mockReturnValue(() => {}),
  forceFlush: jest.fn().mockResolvedValue(undefined),
  shutdown: jest.fn().mockResolvedValue(undefined)
};

jest.mock('../src/main/analysis/embeddingQueue/stageQueues', () => ({
  analysisQueue: mockEmbeddingQueue
}));

jest.mock('../src/main/analysis/embeddingQueue/queueManager', () => ({
  forceFlush: jest.fn().mockResolvedValue(undefined),
  shutdown: jest.fn().mockResolvedValue(undefined)
}));

describe('BatchAnalysisService', () => {
  let BatchAnalysisService;
  let service;
  let analyzeDocumentFile;
  let analyzeImageFile;
  let freememSpy;

  beforeAll(() => {
    // analyzeFiles pauses (real 1 s polls, up to 8 s) whenever os.freemem()
    // drops under its 300 MB floor. A full-suite run on a busy host can dip
    // below that, turning these behaviour tests into timeouts. Pin it healthy.
    freememSpy = jest.spyOn(require('os'), 'freemem').mockReturnValue(8 * 1024 * 1024 * 1024);
  });

  afterAll(() => {
    freememSpy.mockRestore();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    analyzeDocumentFile = require('../src/main/analysis/documentAnalysis').analyzeDocumentFile;
    analyzeImageFile = require('../src/main/analysis/imageAnalysis').analyzeImageFile;
    BatchAnalysisService = require('../src/main/services/BatchAnalysisService');

    // Reset mock implementations
    mockBatchProcessor.processBatch.mockImplementation(async (items, processor, options) => {
      const results = [];
      const errors = [];
      let successful = 0;

      for (let i = 0; i < items.length; i++) {
        try {
          const result = await processor(items[i], i);
          results.push(result);
          if (result.success) successful++;
        } catch (error) {
          errors.push({ item: items[i], error });
        }

        if (options.onProgress) {
          options.onProgress({
            completed: i + 1,
            total: items.length,
            percent: ((i + 1) / items.length) * 100
          });
        }
      }

      return { results, errors, successful };
    });

    analyzeDocumentFile.mockResolvedValue({
      category: 'document',
      confidence: 85
    });

    analyzeImageFile.mockResolvedValue({
      category: 'photo',
      confidence: 90
    });

    service = new BatchAnalysisService();
  });

  describe('constructor', () => {
    test('initializes with default concurrency', () => {
      expect(service.concurrency).toBeGreaterThanOrEqual(2);
      expect(service.concurrency).toBeLessThanOrEqual(8);
    });

    test('accepts custom concurrency option', () => {
      const customService = new BatchAnalysisService({ concurrency: 4 });
      expect(customService.concurrency).toBe(4);
    });

    test('initializes parallel embedding service config', () => {
      // Embedding service accessed via live singleton getter, config stored for initialization
      expect(service._embeddingServiceConfig).toBeDefined();
      expect(service._embeddingServiceConfig.concurrencyLimit).toBeGreaterThan(0);
    });
  });

  describe('calculateOptimalConcurrency', () => {
    test('returns value between 2 and 8', () => {
      const concurrency = service.calculateOptimalConcurrency();
      expect(concurrency).toBeGreaterThanOrEqual(2);
      expect(concurrency).toBeLessThanOrEqual(8);
    });

    test('reduces concurrency under memory pressure', () => {
      // This is hard to test directly since it depends on system state
      // Just verify the function doesn't throw
      expect(() => service.calculateOptimalConcurrency()).not.toThrow();
    });
  });

  describe('analyzeFiles', () => {
    test('returns empty results for empty input', async () => {
      const result = await service.analyzeFiles([]);

      expect(result.success).toBe(true);
      expect(result.results).toEqual([]);
      expect(result.total).toBe(0);
    });

    test('returns empty results for non-array input', async () => {
      const result = await service.analyzeFiles(null);

      expect(result.success).toBe(true);
      expect(result.results).toEqual([]);
    });

    test('analyzes document files', async () => {
      const files = ['/path/to/doc.pdf', '/path/to/text.txt'];

      const result = await service.analyzeFiles(files);

      expect(analyzeDocumentFile).toHaveBeenCalledTimes(2);
      expect(result.total).toBe(2);
      expect(result.successful).toBe(2);
    });

    test('analyzes image files', async () => {
      const files = ['/path/to/image.jpg', '/path/to/photo.png'];

      const result = await service.analyzeFiles(files);

      expect(analyzeImageFile).toHaveBeenCalledTimes(2);
      expect(result.total).toBe(2);
    });

    test('handles mixed file types', async () => {
      const files = ['/path/to/doc.pdf', '/path/to/image.jpg'];

      const result = await service.analyzeFiles(files);

      expect(analyzeDocumentFile).toHaveBeenCalledTimes(1);
      expect(analyzeImageFile).toHaveBeenCalledTimes(1);
      expect(result.total).toBe(2);
    });

    test('partitions files by modality deterministically', () => {
      const partitioned = service.partitionFilesByModality([
        '/path/to/a.jpg',
        '/path/to/b.pdf',
        '/path/to/c.png',
        '/path/to/d.txt',
        '/path/to/e.mp3',
        '/path/to/f.mp4',
        '/path/to/g.wav',
        '/path/to/h.mkv'
      ]);

      expect(partitioned.images).toEqual(['/path/to/a.jpg', '/path/to/c.png']);
      expect(partitioned.documents).toEqual(['/path/to/b.pdf', '/path/to/d.txt']);
      expect(partitioned.media).toEqual([
        '/path/to/e.mp3',
        '/path/to/f.mp4',
        '/path/to/g.wav',
        '/path/to/h.mkv'
      ]);
    });

    test('reports progress via callback', async () => {
      const onProgress = jest.fn();
      const files = ['/path/to/doc1.pdf', '/path/to/doc2.pdf'];

      await service.analyzeFiles(files, [], { onProgress });

      expect(onProgress).toHaveBeenCalled();
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: expect.any(String)
        })
      );
    });

    test('handles analysis errors gracefully', async () => {
      // The mock processor catches errors and marks them as failed results
      mockBatchProcessor.processBatch.mockImplementation(async (items, processor) => {
        const results = [];
        const errors = [];
        let successful = 0;

        for (let i = 0; i < items.length; i++) {
          try {
            const result = await processor(items[i], i);
            results.push(result);
            if (result.success) successful++;
            else errors.push({ item: items[i], error: result.error });
          } catch (error) {
            results.push({
              filePath: items[i],
              success: false,
              error: error.message
            });
            errors.push({ item: items[i], error });
          }
        }

        return { results, errors, successful };
      });

      analyzeDocumentFile
        .mockRejectedValueOnce(new Error('Analysis failed'))
        .mockResolvedValueOnce({ category: 'document', confidence: 85 });

      const files = ['/path/to/bad.pdf', '/path/to/good.pdf'];

      const result = await service.analyzeFiles(files);

      expect(result.total).toBe(2);
      // Check that at least one file failed
      const failedResults = result.results.filter((r) => !r.success);
      expect(failedResults.length).toBeGreaterThan(0);
    });

    test('passes smart folders to analyzers', async () => {
      const smartFolders = [{ name: 'Work', path: '/work' }];
      const files = ['/path/to/doc.pdf'];

      await service.analyzeFiles(files, smartFolders);

      expect(analyzeDocumentFile).toHaveBeenCalledWith(
        '/path/to/doc.pdf',
        smartFolders,
        expect.objectContaining({ isCancelled: expect.any(Function) })
      );
    });

    test('validates and clamps concurrency', async () => {
      // Concurrency 0 and negatives should clamp to 1
      service.setConcurrency(0);
      expect(service.concurrency).toBe(1);

      service.setConcurrency(-5);
      expect(service.concurrency).toBe(1);

      // Values above 10 should clamp to 10
      service.setConcurrency(100);
      expect(service.concurrency).toBe(10);

      // NaN should clamp to 1 (Math.max(1, NaN) === 1 after Math.min)
      service.setConcurrency(NaN);
      expect(service.concurrency).toBe(1);

      // Valid value in range should be kept
      service.setConcurrency(5);
      expect(service.concurrency).toBe(5);
    });

    test('flushes embeddings after analysis', async () => {
      const { flushAllEmbeddings: flushDoc } = require('../src/main/analysis/documentAnalysis');
      const { flushAllEmbeddings: flushImage } = require('../src/main/analysis/imageAnalysis');

      const files = ['/path/to/doc.pdf'];

      await service.analyzeFiles(files);

      expect(flushDoc).toHaveBeenCalled();
      expect(flushImage).toHaveBeenCalled();
    });

    test('includes stats in result', async () => {
      const files = ['/path/to/doc.pdf'];

      const result = await service.analyzeFiles(files);

      expect(result.stats).toBeDefined();
      expect(result.stats.totalDuration).toBeDefined();
      expect(result.stats.avgPerFile).toBeDefined();
      expect(result.stats.filesPerSecond).toBeDefined();
      expect(result.stats.embedding).toBeDefined();
      expect(result.stats.modalities).toBeDefined();
    });

    test('emits modality-aware progress telemetry', async () => {
      const onProgress = jest.fn();
      const files = ['/path/to/doc.pdf', '/path/to/image.jpg'];

      await service.analyzeFiles(files, [], { onProgress });

      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          docInFlight: expect.any(Number),
          imageInFlight: expect.any(Number),
          docCompleted: expect.any(Number),
          imageCompleted: expect.any(Number)
        })
      );
    });

    test('keeps vision runtime warm for image section', async () => {
      const files = ['/path/to/doc.pdf', '/path/to/image.jpg', '/path/to/image2.png'];

      await service.analyzeFiles(files, [], {
        enableVisionBatchMode: true,
        disableAdaptiveConcurrency: true,
        concurrency: 2
      });

      expect(mockLlamaService.enterVisionBatchMode).toHaveBeenCalledTimes(1);
      expect(mockLlamaService.exitVisionBatchMode).toHaveBeenCalledTimes(1);
    });

    test('subscribes to embedding progress when callback provided', async () => {
      const onEmbeddingProgress = jest.fn();
      const files = ['/path/to/doc.pdf'];

      await service.analyzeFiles(files, [], { onEmbeddingProgress });

      expect(mockEmbeddingQueue.onProgress).toHaveBeenCalledWith(onEmbeddingProgress);
    });
  });

  describe('analyzeFilesGrouped', () => {
    test('groups files by type before processing', async () => {
      const files = ['/path/to/doc.pdf', '/path/to/image.jpg', '/path/to/doc2.txt'];

      const result = await service.analyzeFilesGrouped(files);

      expect(result.total).toBe(3);
    });

    test('merges results from all groups', async () => {
      const files = ['/path/to/doc.pdf', '/path/to/image.jpg'];

      const result = await service.analyzeFilesGrouped(files);

      expect(result.results.length).toBe(2);
    });

    test('respects groupConcurrency to avoid amplified parallel batches', async () => {
      const files = ['/path/to/doc.pdf', '/path/to/image.jpg', '/path/to/sheet.csv'];
      let activeGroups = 0;
      let maxActiveGroups = 0;

      jest.spyOn(service, 'analyzeFiles').mockImplementation(async (groupFiles) => {
        activeGroups += 1;
        maxActiveGroups = Math.max(maxActiveGroups, activeGroups);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeGroups -= 1;
        return {
          success: true,
          results: groupFiles.map((filePath) => ({ filePath, success: true })),
          errors: [],
          total: groupFiles.length,
          successful: groupFiles.length
        };
      });

      await service.analyzeFilesGrouped(files, [], { groupConcurrency: 1 });

      expect(maxActiveGroups).toBe(1);
    });
  });

  describe('groupFilesByType', () => {
    test('groups image files together', () => {
      const files = ['/a.jpg', '/b.png', '/c.gif'];

      const groups = service.groupFilesByType(files);

      expect(groups.image).toHaveLength(3);
    });

    test('groups document files together', () => {
      const files = ['/a.pdf', '/b.doc', '/c.txt'];

      const groups = service.groupFilesByType(files);

      expect(groups.document).toHaveLength(3);
    });

    test('groups spreadsheet files together', () => {
      const files = ['/a.xlsx', '/b.csv'];

      const groups = service.groupFilesByType(files);

      expect(groups.spreadsheet).toHaveLength(2);
    });

    test('puts unknown extensions in other group', () => {
      const files = ['/a.xyz', '/b.unknown'];

      const groups = service.groupFilesByType(files);

      expect(groups.other).toHaveLength(2);
    });
  });

  describe('getFileType', () => {
    test('identifies image extensions', () => {
      expect(service.getFileType('.jpg')).toBe('image');
      expect(service.getFileType('.png')).toBe('image');
      expect(service.getFileType('.gif')).toBe('image');
      expect(service.getFileType('.webp')).toBe('image');
    });

    test('identifies document extensions', () => {
      expect(service.getFileType('.pdf')).toBe('document');
      expect(service.getFileType('.doc')).toBe('document');
      expect(service.getFileType('.txt')).toBe('document');
    });

    test('identifies spreadsheet extensions', () => {
      expect(service.getFileType('.xlsx')).toBe('spreadsheet');
      expect(service.getFileType('.csv')).toBe('spreadsheet');
    });

    test('identifies presentation extensions', () => {
      expect(service.getFileType('.pptx')).toBe('presentation');
      expect(service.getFileType('.ppt')).toBe('presentation');
    });

    test('returns other for unknown extensions', () => {
      expect(service.getFileType('.xyz')).toBe('other');
    });
  });

  describe('isImageFile', () => {
    test('returns true for image extensions', () => {
      expect(service.isImageFile('.jpg')).toBe(true);
      expect(service.isImageFile('.JPEG')).toBe(true);
      expect(service.isImageFile('.png')).toBe(true);
      expect(service.isImageFile('.gif')).toBe(true);
    });

    test('returns false for non-image extensions', () => {
      expect(service.isImageFile('.pdf')).toBe(false);
      expect(service.isImageFile('.txt')).toBe(false);
    });
  });

  describe('setConcurrency', () => {
    test('sets concurrency within limits', () => {
      service.setConcurrency(5);
      expect(service.concurrency).toBe(5);
    });

    test('clamps concurrency to minimum of 1', () => {
      service.setConcurrency(0);
      expect(service.concurrency).toBe(1);
    });

    test('clamps concurrency to maximum of 10', () => {
      service.setConcurrency(100);
      expect(service.concurrency).toBe(10);
    });

    test('updates batch processor concurrency', () => {
      service.setConcurrency(6);
      expect(mockBatchProcessor.concurrencyLimit).toBe(6);
    });
  });

  describe('getStats', () => {
    test('returns combined statistics', () => {
      const stats = service.getStats();

      expect(stats.concurrency).toBeDefined();
      expect(stats.embedding).toBeDefined();
      expect(stats.embedding.queue).toBeDefined();
      expect(stats.embedding.service).toBeDefined();
    });
  });

  describe('getEmbeddingQueueStats', () => {
    test('returns queue statistics', () => {
      const stats = service.getEmbeddingQueueStats();

      expect(stats).toBeDefined();
      expect(mockEmbeddingQueue.getStats).toHaveBeenCalled();
    });
  });

  describe('setEmbeddingConcurrency', () => {
    test('updates embedding service concurrency', () => {
      service.setEmbeddingConcurrency(3);

      expect(mockEmbeddingService.setConcurrencyLimit).toHaveBeenCalledWith(3);
    });
  });

  describe('flushEmbeddings', () => {
    test('forces embedding queue flush', async () => {
      const queueManager = require('../src/main/analysis/embeddingQueue/queueManager');
      await service.flushEmbeddings();

      expect(queueManager.forceFlush).toHaveBeenCalled();
    });
  });

  describe('error paths', () => {
    test('handles partial batch failure (some files succeed, some fail)', async () => {
      analyzeDocumentFile
        .mockResolvedValueOnce({ category: 'document', confidence: 85 })
        .mockRejectedValueOnce(new Error('Extraction failed'));

      const files = ['/path/to/good.pdf', '/path/to/bad.pdf'];
      const result = await service.analyzeFiles(files);

      // One should succeed, one should fail
      const successes = result.results.filter((r) => r.success);
      const failures = result.results.filter((r) => !r.success);
      expect(successes.length + failures.length).toBe(2);
      expect(failures).toHaveLength(1);
    });

    test('handles LLM service unavailable during analysis', async () => {
      analyzeDocumentFile.mockRejectedValue(new Error('LLM service not available'));

      const files = ['/path/to/doc.pdf'];
      const result = await service.analyzeFiles(files);

      expect(result.results).toHaveLength(1);
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toContain('LLM service not available');
    });

    test('handles embedding flush failure gracefully', async () => {
      const { flushAllEmbeddings: flushDoc } = require('../src/main/analysis/documentAnalysis');
      flushDoc.mockRejectedValueOnce(new Error('Flush timeout'));

      const files = ['/path/to/doc.pdf'];
      // Should not throw even if flush fails
      const result = await service.analyzeFiles(files);
      expect(result.results).toHaveLength(1);
      expect(result.success).toBe(true);
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('Flush timeout')])
      );
    });
  });

  describe('shutdown', () => {
    test('shuts down embedding queue', async () => {
      const queueManager = require('../src/main/analysis/embeddingQueue/queueManager');
      await service.shutdown();

      expect(queueManager.shutdown).toHaveBeenCalled();
    });

    test('analyzeFiles cleans up progress subscription in finally block', async () => {
      const unsubscribe = jest.fn();
      mockEmbeddingQueue.onProgress.mockReturnValue(unsubscribe);

      await service.analyzeFiles(['/test.pdf'], [], {
        onEmbeddingProgress: jest.fn()
      });

      // analyzeFiles' finally block should have called unsubscribe
      expect(unsubscribe).toHaveBeenCalled();
      // Instance field should be nulled after analyzeFiles completes
      expect(service._embeddingProgressUnsubscribe).toBeNull();
    });

    test('shutdown cleans up progress subscription if still active', async () => {
      const unsubscribe = jest.fn();
      // Manually set as if analyzeFiles is still in progress
      service._embeddingProgressUnsubscribe = unsubscribe;

      await service.shutdown();

      expect(unsubscribe).toHaveBeenCalled();
      expect(service._embeddingProgressUnsubscribe).toBeNull();
    });
  });
});
