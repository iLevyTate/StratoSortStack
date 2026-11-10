/**
 * @jest-environment node
 *
 * A cancelled image analysis ends with a cancellation error. It used to end
 * with a filename fallback: analyzeImageFile caught the cancellation in its
 * outer handler and returned "analysis", which the batch then recorded in the
 * analysis history and the ready queue as if the image had been analyzed.
 *
 * Uses the real fallbackUtils (mock scaffolding shared with
 * imageAnalysis.hardErrorFallback.test.js).
 */
const { analyzeImageFile, resetSingletons } = require('../src/main/analysis/imageAnalysis');

jest.mock('fs', () => ({
  promises: {
    stat: jest.fn(),
    readFile: jest.fn(),
    access: jest.fn()
  }
}));

jest.mock('sharp', () => {
  const mockSharp = jest.fn(() => ({
    metadata: jest.fn().mockResolvedValue({ width: 100, height: 100, format: 'png' }),
    rotate: jest.fn().mockReturnThis(),
    resize: jest.fn().mockReturnThis(),
    png: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(Buffer.from('processed-image'))
  }));
  return mockSharp;
});

jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  };
  return { createLogger: jest.fn(() => logger) };
});

jest.mock('../src/main/services/LlamaService', () => ({
  getInstance: jest.fn()
}));

jest.mock('../src/main/analysis/documentLlm', () => ({
  analyzeTextWithLlama: jest.fn()
}));

jest.mock('../src/main/services/FolderMatchingService', () => ({
  matchCategoryToFolder: jest.fn((cat) => cat),
  matchCategoryToFolderWithSuggestion: jest.fn((cat) => ({
    folder: cat,
    suggestedNewFolder: null,
    source: 'matched'
  }))
}));

jest.mock('../src/main/analysis/embeddingQueue/stageQueues', () => ({
  analysisQueue: { enqueue: jest.fn() }
}));

jest.mock('../src/main/analysis/embeddingQueue/queueManager', () => ({
  removeByFilePath: jest.fn()
}));

jest.mock('../src/main/services/AnalysisCacheService', () => {
  const mockCache = {
    get: jest.fn(),
    set: jest.fn(),
    clear: jest.fn()
  };
  return {
    getImageAnalysisCache: jest.fn(() => mockCache)
  };
});

jest.mock('../src/main/services/ServiceContainer', () => ({
  container: { tryResolve: jest.fn(() => null) },
  ServiceIds: { SEARCH_SERVICE: 'searchService' }
}));

jest.mock('../src/main/utils/llmOptimization', () => ({
  globalDeduplicator: {
    generateKey: jest.fn(() => 'test-key'),
    deduplicate: jest.fn((key, fn) => fn())
  }
}));

jest.mock('../src/main/utils/jsonRepair', () => ({
  extractAndParseJSON: jest.fn(() => null)
}));

jest.mock('../src/main/utils/llmJsonRepair', () => ({
  attemptJsonRepairWithLlama: jest.fn().mockResolvedValue(null),
  attemptProseExtractionWithLlama: jest.fn().mockResolvedValue(null)
}));

jest.mock('../src/main/utils/tesseractUtils', () => ({
  recognizeIfAvailable: jest.fn().mockResolvedValue({ success: false, text: '' })
}));

jest.mock('../src/main/analysis/semanticFolderMatcher', () => {
  const mockMatcher = {
    embeddingCache: { initialized: true },
    initialize: jest.fn(),
    embedText: jest.fn().mockResolvedValue({ vector: [0.1, 0.2] })
  };
  return {
    applySemanticFolderMatching: jest.fn(),
    getServices: jest.fn(() => ({ matcher: mockMatcher })),
    resetSingletons: jest.fn()
  };
});

jest.mock('../src/shared/promiseUtils', () => ({
  withAbortableTimeout: jest.fn((fn) => fn({ signal: {} })),
  createBackgroundWorkTracker: jest.fn(() => ({
    track: jest.fn((p) => p),
    drain: jest.fn(),
    get size() {
      return 0;
    }
  })),
  createInitGuard: jest.fn(() => ({
    isInitialized: () => false,
    initialize: jest.fn(async (fn) => fn()),
    reset: jest.fn(),
    requireInitialized: jest.fn()
  }))
}));

jest.mock('../src/main/services/embedding/embeddingGate', () => ({
  shouldEmbed: jest.fn().mockResolvedValue({ shouldEmbed: true })
}));

jest.mock('../src/shared/folderUtils', () => ({
  findContainingSmartFolder: jest.fn(() => null)
}));

// Control the size guard deterministically (1 MB limit).
jest.mock('../src/main/analysis/analysisLimits', () => ({
  getAnalysisLimits: jest.fn().mockResolvedValue({ maxImageFileSize: 1024 * 1024 })
}));

describe('a cancelled image analysis', () => {
  let llama;

  const cancelled = () =>
    Object.assign(new Error('Operation cancelled'), { code: 'OPERATION_CANCELLED' });

  beforeEach(() => {
    jest.clearAllMocks();
    resetSingletons();

    require('../src/main/services/AnalysisCacheService')
      .getImageAnalysisCache()
      .get.mockReturnValue(null);

    const fs = require('fs').promises;
    fs.stat.mockResolvedValue({ size: 1024, mtimeMs: 1000 });
    fs.readFile.mockResolvedValue(Buffer.from('image-data'));
    fs.access.mockResolvedValue(undefined);

    llama = {
      getConfig: jest.fn().mockResolvedValue({ visionModel: 'test-vision-model' }),
      testConnection: jest.fn().mockResolvedValue({ success: true }),
      listModels: jest.fn().mockResolvedValue([{ name: 'test-vision-model' }]),
      analyzeImage: jest.fn(),
      supportsVisionInput: jest.fn().mockResolvedValue(true),
      _shouldUseConservativeVisionProfile: jest.fn(() => false)
    };
    require('../src/main/services/LlamaService').getInstance.mockReturnValue(llama);
  });

  test('a vision request cancelled by the caller rejects instead of returning a fallback', async () => {
    llama.analyzeImage.mockRejectedValue(cancelled());

    await expect(analyzeImageFile('/path/to/photo.png')).rejects.toMatchObject({
      code: 'OPERATION_CANCELLED'
    });
    expect(llama.analyzeImage).toHaveBeenCalledTimes(1);
  });

  test('isCancelled before the vision request rejects with the cancellation code', async () => {
    await expect(
      analyzeImageFile('/path/to/photo.png', [], { isCancelled: () => true })
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
    expect(llama.analyzeImage).not.toHaveBeenCalled();
  });

  test('a fallback produced after the caller aborted is not returned as an analysis', async () => {
    const controller = new AbortController();
    // The engine reports the abort as an ordinary failure; every later step
    // (retry, OCR, filename fallback) then runs for a caller that has left.
    llama.analyzeImage.mockImplementation(async () => {
      controller.abort();
      throw new Error('socket hang up');
    });

    await expect(
      analyzeImageFile('/path/to/photo.png', [], { abortSignal: controller.signal })
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
  });

  test('a failure with no cancellation still returns the filename fallback', async () => {
    llama.analyzeImage.mockRejectedValue(new Error('socket hang up'));

    const result = await analyzeImageFile('/path/to/photo.png', [], {
      abortSignal: new AbortController().signal,
      isCancelled: () => false
    });

    expect(result.isFallback || result._isFallback).toBe(true);
    expect(result.suggestedName).toBeTruthy();
  });

  test('an analysis that completed is returned even if the caller aborts at the end', async () => {
    const controller = new AbortController();
    llama.analyzeImage.mockImplementation(async () => {
      controller.abort();
      return {
        response: JSON.stringify({
          category: 'Photos',
          keywords: ['beach', 'sunset'],
          confidence: 90,
          suggestedName: 'beach-sunset',
          content_type: 'photograph'
        })
      };
    });
    require('../src/main/utils/jsonRepair').extractAndParseJSON.mockImplementation((text) =>
      JSON.parse(text)
    );

    const result = await analyzeImageFile('/path/to/photo.png', [], {
      abortSignal: controller.signal
    });

    expect(result.isFallback).not.toBe(true);
    expect(result.keywords).toEqual(expect.arrayContaining(['beach']));
  });
});
