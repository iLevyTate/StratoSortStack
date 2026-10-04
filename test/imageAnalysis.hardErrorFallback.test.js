/**
 * @jest-environment node
 *
 * Regression tests: image hard-error paths (missing/empty/oversized/TOCTOU)
 * must route through the shared createFallbackAnalysis() factory instead of
 * returning a bare `{error, category: 'error', keywords: [], confidence: 0}`
 * shape. The degraded shape had no suggestedName and persisted to analysis
 * history with the fake category 'error'. The error message callers match on
 * (ENOENT/TOCTOU/size text) must be preserved verbatim.
 *
 * Unlike imageAnalysis.behavior.test.js, this suite uses the REAL
 * fallbackUtils so it asserts the actual fallback shape.
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

describe('Image analysis hard-error fallback shape', () => {
  let fs;

  beforeEach(() => {
    jest.clearAllMocks();
    resetSingletons();

    const mockCacheInstance =
      require('../src/main/services/AnalysisCacheService').getImageAnalysisCache();
    mockCacheInstance.get.mockReturnValue(null);

    fs = require('fs').promises;
    fs.stat.mockResolvedValue({ size: 1024, mtimeMs: 1000 });
    fs.readFile.mockResolvedValue(Buffer.from('image-data'));
    fs.access.mockResolvedValue(undefined);

    require('../src/main/services/LlamaService').getInstance.mockReturnValue({
      getConfig: jest.fn().mockResolvedValue({ visionModel: 'test-vision-model' }),
      testConnection: jest.fn().mockResolvedValue({ success: true }),
      listModels: jest.fn().mockResolvedValue([{ name: 'test-vision-model' }]),
      analyzeImage: jest.fn(),
      supportsVisionInput: jest.fn().mockResolvedValue(true),
      _shouldUseConservativeVisionProfile: jest.fn(() => false)
    });
  });

  // Every hard-error path must produce a real fallback analysis (category,
  // suggestedName, keywords) rather than the bare `category: 'error'` shape,
  // while keeping the exact error message.
  const expectHardErrorFallback = (result, errorText) => {
    expect(result.error).toBe(errorText);
    expect(result.isFallback).toBe(true);
    expect(result.category).toBeTruthy();
    expect(result.category).not.toBe('error');
    expect(typeof result.suggestedName).toBe('string');
    expect(result.suggestedName.length).toBeGreaterThan(0);
    expect(Array.isArray(result.keywords)).toBe(true);
    expect(result.confidence).toBe(0);
    expect(result.fallbackReason).toBe(errorText);
  };

  test('missing file (ENOENT on stat) routes through the shared fallback factory', async () => {
    const enoent = new Error('no such file');
    enoent.code = 'ENOENT';
    fs.stat.mockRejectedValue(enoent);

    const result = await analyzeImageFile('/path/to/missing.png');

    expectHardErrorFallback(result, 'Image file not found (ENOENT)');
    expect(result.suggestedName).toBe('missing.png');
  });

  test('empty file (0 bytes) routes through the shared fallback factory', async () => {
    fs.stat.mockResolvedValue({ size: 0, mtimeMs: 1000 });

    const result = await analyzeImageFile('/path/to/empty.png');

    expectHardErrorFallback(result, 'Image file is empty (0 bytes)');
  });

  test('oversized file routes through the shared fallback factory', async () => {
    fs.stat.mockResolvedValue({ size: 2 * 1024 * 1024, mtimeMs: 1000 });

    const result = await analyzeImageFile('/path/to/huge.png');

    expect(result.error).toMatch(/Image file too large \(2\.0MB exceeds 1\.0MB limit\)/);
    expect(result.isFallback).toBe(true);
    expect(result.category).not.toBe('error');
    expect(result.suggestedName).toBe('huge.png');
    expect(result.confidence).toBe(0);
  });

  test('file deleted between stat and read (TOCTOU) routes through the shared fallback factory', async () => {
    const enoent = new Error('gone');
    enoent.code = 'ENOENT';
    fs.readFile.mockRejectedValue(enoent);

    const result = await analyzeImageFile('/path/to/race.png');

    expectHardErrorFallback(result, 'Image file was deleted during analysis (TOCTOU)');
  });
});
