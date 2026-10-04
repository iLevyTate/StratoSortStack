/**
 * @jest-environment node
 */
const { analyzeImageFile, resetSingletons } = require('../src/main/analysis/imageAnalysis');

// Mock dependencies
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
jest.mock(
  '../src/main/analysis/extractors/heicDecode',
  () => ({ decodeHeicToPng: jest.fn().mockResolvedValue(null) }),
  { virtual: true }
);
jest.mock(
  '../src/main/analysis/extractors/svgText',
  () => ({ extractTextFromSvg: jest.fn(() => '') }),
  { virtual: true }
);

jest.mock('../src/main/analysis/documentLlm', () => ({
  analyzeTextWithLlama: jest.fn().mockResolvedValue({
    category: 'General',
    keywords: ['text'],
    confidence: 80,
    suggestedName: 'ocr_analysis'
  })
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

// Mock AnalysisCacheService with a singleton mock
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
  extractAndParseJSON: jest.fn((text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })
}));

jest.mock('../src/main/utils/llmJsonRepair', () => ({
  attemptJsonRepairWithLlama: jest.fn(),
  attemptProseExtractionWithLlama: jest.fn()
}));

jest.mock('../src/main/utils/tesseractUtils', () => ({
  recognizeIfAvailable: jest.fn().mockResolvedValue({ success: false, text: '' })
}));

// exif-reader 2.x groups tags by IFD and returns Date objects. Only consulted
// when the sharp metadata mock carries an `exif` buffer.
jest.mock('exif-reader', () =>
  jest.fn(() => ({ Photo: { DateTimeOriginal: new Date(Date.UTC(2023, 4, 9, 10, 0, 0)) } }))
);

// Inline mock definition for semanticFolderMatcher
jest.mock('../src/main/analysis/semanticFolderMatcher', () => {
  const mockMatcher = {
    embeddingCache: { initialized: true },
    initialize: jest.fn(),
    embedText: jest.fn()
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

// Mock fallbackUtils properly as it's used directly
jest.mock('../src/main/analysis/fallbackUtils', () => {
  const actual = jest.requireActual('../src/main/analysis/fallbackUtils');
  return {
    ...actual,
    createFallbackAnalysis: jest.fn((params) => ({
      ...params,
      // The real builder lifts these two out of `options`.
      date: params.options?.date ?? null,
      extractionMethod: params.options?.extractionMethod ?? 'filename_fallback',
      isFallback: true,
      confidence: 60
    })),
    getIntelligentKeywords: jest.fn(() => ['fallback', 'keyword']),
    getIntelligentCategory: jest.fn(() => 'General')
  };
});

// Mock embeddingGate
jest.mock('../src/main/services/embedding/embeddingGate', () => ({
  shouldEmbed: jest.fn().mockResolvedValue({ shouldEmbed: true })
}));

// Mock folderUtils to support destructuring in SUT
jest.mock('../src/shared/folderUtils', () => ({
  findContainingSmartFolder: jest.fn()
}));

describe('Image Analysis Behavior', () => {
  let fs;
  let mockLlamaService;
  let mockCacheInstance;
  let mockMatcherInstance;

  beforeEach(() => {
    jest.clearAllMocks(); // Use clearAllMocks to preserve factory implementations
    resetSingletons();

    // Get fresh mock references
    mockCacheInstance =
      require('../src/main/services/AnalysisCacheService').getImageAnalysisCache();
    mockCacheInstance.get.mockReturnValue(null); // Cache miss by default

    // Access nested mock: getServices() -> returns object with matcher -> matcher has embedText
    mockMatcherInstance = require('../src/main/analysis/semanticFolderMatcher').getServices()
      .matcher;
    mockMatcherInstance.embedText.mockResolvedValue({ vector: [0.1, 0.2] });

    fs = require('fs').promises;
    // Default fs behavior
    fs.stat.mockResolvedValue({ size: 1024, mtimeMs: 1000 });
    fs.readFile.mockResolvedValue(Buffer.from('image-data'));
    fs.access.mockResolvedValue(undefined);

    mockLlamaService = {
      getConfig: jest.fn().mockResolvedValue({ visionModel: 'test-vision-model' }),
      testConnection: jest.fn().mockResolvedValue({ success: true }),
      listModels: jest.fn().mockResolvedValue([{ name: 'test-vision-model' }]),
      analyzeImage: jest.fn(),
      supportsVisionInput: jest.fn().mockResolvedValue(true),
      _shouldUseConservativeVisionProfile: jest.fn(() => false)
    };
    require('../src/main/services/LlamaService').getInstance.mockReturnValue(mockLlamaService);
    const llmJsonRepair = require('../src/main/utils/llmJsonRepair');
    llmJsonRepair.attemptJsonRepairWithLlama.mockResolvedValue(null);
    llmJsonRepair.attemptProseExtractionWithLlama.mockResolvedValue(null);

    // Setup folderUtils mock default
    require('../src/shared/folderUtils').findContainingSmartFolder.mockReturnValue(null);

    // Setup embeddingGate mock default
    require('../src/main/services/embedding/embeddingGate').shouldEmbed.mockResolvedValue({
      shouldEmbed: true
    });
  });

  test('HEIC is organized by filename with an honest reason and never reaches the vision model (MI-02)', async () => {
    const result = await analyzeImageFile('/photos/IMG_0042.heic', [{ name: 'Photos' }]);

    expect(result.isFallback).toBe(true);
    // A build limitation, not a model gap: the watcher must not spend its
    // provisional retries on a file no vision model install can decode.
    expect(result.extractionMethod).toBe('format_unsupported');
    expect(result.reason).toMatch(/HEIC photos cannot be decoded in this build/);
    expect(mockLlamaService.analyzeImage).not.toHaveBeenCalled();
  });

  test('the HEIC filename fallback carries the file date it says it organizes by', async () => {
    fs.stat.mockResolvedValue({ size: 1024, mtimeMs: Date.UTC(2024, 6, 4, 12, 0, 0) });

    const result = await analyzeImageFile('/photos/IMG_0042.heic', [{ name: 'Photos' }]);

    expect(result.isFallback).toBe(true);
    expect(result.date).toBe('2024-07-04');
  });

  test('a placeholder EXIF date (unset camera clock) is skipped for the next candidate, or for mtime', async () => {
    const sharp = require('sharp');
    const defaultImpl = sharp.getMockImplementation();
    sharp.mockImplementation(() => ({
      metadata: jest
        .fn()
        .mockResolvedValue({ width: 100, height: 100, format: 'jpeg', exif: Buffer.from('x') }),
      rotate: jest.fn().mockReturnThis(),
      resize: jest.fn().mockReturnThis(),
      png: jest.fn().mockReturnThis(),
      toBuffer: jest.fn().mockResolvedValue(Buffer.from('processed-image'))
    }));
    const exifReader = require('exif-reader');
    mockLlamaService.analyzeImage.mockResolvedValue({
      response: JSON.stringify({ category: 'Photos', keywords: ['beach'], confidence: 88 })
    });

    try {
      // exif-reader turns "0000:00:00 00:00:00" into 30 November 1899.
      exifReader.mockReturnValueOnce({
        Photo: {
          DateTimeOriginal: new Date(Date.UTC(1899, 10, 30)),
          DateTimeDigitized: new Date(Date.UTC(2021, 0, 15, 9, 0, 0))
        }
      });
      const withFallback = await analyzeImageFile('/path/to/IMG_0001.jpg');
      expect(withFallback.date).toBe('2021-01-15');

      exifReader.mockReturnValueOnce({
        Photo: { DateTimeOriginal: new Date(Date.UTC(1899, 10, 30)) }
      });
      const placeholderOnly = await analyzeImageFile('/path/to/IMG_0002.jpg');
      expect(placeholderOnly.date).not.toBe('1899-11-30');
      expect(placeholderOnly.date).toBeUndefined();
    } finally {
      sharp.mockImplementation(defaultImpl);
    }
  });

  test('HEIC decoded by the bundled FFmpeg goes through the vision model as PNG', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('decoded')]);
    require('../src/main/analysis/extractors/heicDecode').decodeHeicToPng.mockResolvedValueOnce(
      png
    );
    mockLlamaService.analyzeImage.mockResolvedValue({
      response: JSON.stringify({
        category: 'Photos',
        keywords: ['beach'],
        confidence: 85,
        suggestedName: 'beach_day',
        has_text: false
      })
    });

    const result = await analyzeImageFile('/photos/IMG_0043.heic', [{ name: 'Photos' }]);

    expect(
      require('../src/main/analysis/extractors/heicDecode').decodeHeicToPng
    ).toHaveBeenCalledWith('/photos/IMG_0043.heic', expect.any(Object));
    expect(mockLlamaService.analyzeImage).toHaveBeenCalledTimes(1);
    expect(result.isFallback).toBeFalsy();
    expect(result.category).toBe('Photos');
  });

  test('SVG text is read from the markup and grounds the vision prompt without OCR', async () => {
    const svgText = 'Quarterly revenue by region\nNorth 42%\nSouth 31%\nWest 27%';
    require('../src/main/analysis/extractors/svgText').extractTextFromSvg.mockReturnValueOnce(
      svgText
    );
    fs.readFile.mockResolvedValue(
      Buffer.from('<svg><text>Quarterly revenue by region</text></svg>')
    );
    mockLlamaService.analyzeImage.mockResolvedValue({
      response: JSON.stringify({
        category: 'Finance',
        keywords: ['revenue'],
        confidence: 90,
        suggestedName: 'revenue_by_region',
        has_text: true
      })
    });

    const result = await analyzeImageFile('/diagrams/revenue.svg');

    expect(mockLlamaService.analyzeImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining('Quarterly revenue by region') })
    );
    expect(require('../src/main/utils/tesseractUtils').recognizeIfAvailable).not.toHaveBeenCalled();
    expect(result.category).toBe('Finance');
  });

  test('analyzes image successfully with AI', async () => {
    // Mock successful AI response
    const aiResponse = {
      response: JSON.stringify({
        category: 'Finance',
        keywords: ['receipt', 'tax'],
        confidence: 90,
        suggestedName: 'tax_receipt',
        has_text: false
      })
    };
    mockLlamaService.analyzeImage.mockResolvedValue(aiResponse);

    const result = await analyzeImageFile('/path/to/image.png');

    expect(result.error).toBeUndefined();
    expect(result.category).toBe('Finance');
    expect(result.llmSuggestedName).toBe('tax_receipt.png');
    expect(result.suggestedName).toBe('tax_receipt.png'); // Expect extension appended
    expect(mockLlamaService.analyzeImage).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 300000
      })
    );
    expect(mockCacheInstance.set).toHaveBeenCalled();
  });

  test('preserves dotted basenames when restoring the source extension', async () => {
    mockLlamaService.analyzeImage.mockResolvedValue({
      response: JSON.stringify({
        category: 'Finance',
        keywords: ['statement'],
        confidence: 88,
        suggestedName: 'meeting.v2',
        has_text: false
      })
    });

    const result = await analyzeImageFile('/path/to/source-image.png');

    expect(result.suggestedName).toBe('meeting.v2.png');
  });

  test('normalizes fractional model confidence to percentage', async () => {
    mockLlamaService.analyzeImage.mockResolvedValue({
      response: JSON.stringify({
        category: 'Finance',
        keywords: ['receipt'],
        confidence: 0.85,
        suggestedName: 'receipt_scan',
        has_text: false
      })
    });

    const result = await analyzeImageFile('/path/to/image.png');

    expect(result.confidence).toBe(85);
  });

  test('uses cached result if available', async () => {
    const cachedResult = { category: 'Cached', confidence: 95 };
    mockCacheInstance.get.mockReturnValue(cachedResult);

    const result = await analyzeImageFile('/path/to/image.webp');

    expect(result).toBe(cachedResult);
    expect(mockLlamaService.analyzeImage).not.toHaveBeenCalled();
  });

  test('handles AI engine unavailability gracefully', async () => {
    mockLlamaService.testConnection.mockResolvedValue({ success: false });
    mockLlamaService.supportsVisionInput.mockResolvedValue(false);

    const result = await analyzeImageFile('/path/to/image.png');

    // Check for fallback indicators
    expect(result.confidence).toBe(60);
    expect(result.reason).toMatch(/AI engine unavailable|not loaded/i);
    expect(mockLlamaService.analyzeImage).not.toHaveBeenCalled();
    expect(mockCacheInstance.set).not.toHaveBeenCalled();
  });

  test('continues with vision analysis when preflight is unhealthy but vision is supported', async () => {
    mockLlamaService.testConnection.mockResolvedValue({ success: false, status: 'warming_up' });
    mockLlamaService.supportsVisionInput.mockResolvedValue(true);
    mockLlamaService.analyzeImage.mockResolvedValue({
      response: JSON.stringify({
        category: 'Finance',
        keywords: ['invoice'],
        confidence: 87,
        suggestedName: 'invoice_scan',
        has_text: false
      })
    });

    const result = await analyzeImageFile('/path/to/image.png');

    expect(mockLlamaService.analyzeImage).toHaveBeenCalled();
    expect(result.error).toBeUndefined();
    expect(result.category).toBe('Finance');
  });

  test('retries image preflight once before fallback', async () => {
    mockLlamaService.testConnection
      .mockResolvedValueOnce({ success: false, status: 'warming_up' })
      .mockResolvedValueOnce({ success: true });
    mockLlamaService.analyzeImage.mockResolvedValue({
      response: JSON.stringify({
        category: 'Finance',
        keywords: ['invoice'],
        confidence: 85,
        suggestedName: 'invoice_scan'
      })
    });

    const result = await analyzeImageFile('/path/to/image.png');

    expect(mockLlamaService.testConnection).toHaveBeenCalledTimes(2);
    expect(mockLlamaService.analyzeImage).toHaveBeenCalled();
    expect(result.error).toBeUndefined();
    expect(result.category).toBe('Finance');
  });

  test('OCR reads the original image resized for OCR, not the 1024 px vision copy', async () => {
    // Word recall on a 1440p screenshot drops to zero when Tesseract gets the
    // vision model's 1024 px copy. The vision model keeps its copy; OCR gets
    // the original bytes resized to the OCR ceiling.
    const sharp = require('sharp');
    const defaultImpl = sharp.getMockImplementation();
    const resize = jest.fn().mockReturnThis();
    sharp.mockImplementation(() => ({
      metadata: jest.fn().mockResolvedValue({ width: 3000, height: 2000, format: 'png' }),
      rotate: jest.fn().mockReturnThis(),
      resize,
      png: jest.fn().mockReturnThis(),
      toBuffer: jest.fn().mockResolvedValue(Buffer.from('processed-image'))
    }));
    mockLlamaService.analyzeImage.mockResolvedValue({
      response: JSON.stringify({
        category: 'Finance',
        keywords: ['invoice'],
        confidence: 90,
        has_text: true,
        content_type: 'text_document'
      })
    });
    const { recognizeIfAvailable } = require('../src/main/utils/tesseractUtils');
    recognizeIfAvailable.mockResolvedValueOnce({ success: true, text: 'Invoice 123 total due' });

    try {
      await analyzeImageFile('/path/to/invoice_scan.webp');
    } finally {
      sharp.mockImplementation(defaultImpl);
    }

    const widths = resize.mock.calls.map((call) => call[0]?.width);
    expect(widths).toContain(1024); // vision copy
    expect(widths).toContain(2480); // OCR copy, A4 at 150 DPI
    expect(fs.readFile).toHaveBeenCalledTimes(1);
  });

  test('records the EXIF capture date from the exif-reader 2.x shape', async () => {
    const sharp = require('sharp');
    const defaultImpl = sharp.getMockImplementation();
    sharp.mockImplementation(() => ({
      metadata: jest
        .fn()
        .mockResolvedValue({ width: 100, height: 100, format: 'jpeg', exif: Buffer.from('x') }),
      rotate: jest.fn().mockReturnThis(),
      resize: jest.fn().mockReturnThis(),
      png: jest.fn().mockReturnThis(),
      toBuffer: jest.fn().mockResolvedValue(Buffer.from('processed-image'))
    }));
    mockLlamaService.analyzeImage.mockResolvedValue({
      response: JSON.stringify({
        category: 'Photos',
        keywords: ['beach'],
        confidence: 88,
        suggestedName: 'beach_day'
      })
    });

    let result;
    try {
      result = await analyzeImageFile('/path/to/IMG_2041.jpg');
    } finally {
      sharp.mockImplementation(defaultImpl);
    }

    expect(result.date).toBe('2023-05-09');
  });

  test('uses the preprocessed OCR buffer for text-hint pre-extraction', async () => {
    mockLlamaService.analyzeImage.mockResolvedValue({
      response: JSON.stringify({
        category: 'Finance',
        keywords: ['invoice', 'total'],
        confidence: 90,
        suggestedName: 'invoice_scan',
        has_text: true,
        content_type: 'text_document'
      })
    });

    const { recognizeIfAvailable } = require('../src/main/utils/tesseractUtils');
    recognizeIfAvailable.mockResolvedValueOnce({
      success: true,
      text: 'Invoice 123 total amount due and payable'
    });

    await analyzeImageFile('/path/to/invoice_scan.webp');

    expect(recognizeIfAvailable).toHaveBeenCalled();
    expect(recognizeIfAvailable.mock.calls[0][1]).toEqual(Buffer.from('processed-image'));
    expect(fs.readFile).toHaveBeenCalledTimes(1);
  });

  test('continues vision analysis when preprocessing fails', async () => {
    const sharp = require('sharp');
    sharp
      .mockImplementationOnce(() => ({
        metadata: jest.fn().mockResolvedValue({ width: 3000, height: 2000, format: 'png' })
      }))
      .mockImplementationOnce(() => ({
        rotate: jest.fn().mockReturnThis(),
        resize: jest.fn().mockReturnThis(),
        png: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockRejectedValue(new Error('sharp conversion failed'))
      }));

    mockLlamaService.analyzeImage.mockResolvedValue({
      response: JSON.stringify({
        category: 'Finance',
        keywords: ['invoice'],
        confidence: 86,
        suggestedName: 'invoice_scan'
      })
    });

    const result = await analyzeImageFile('/path/to/image.png');

    expect(mockLlamaService.analyzeImage).toHaveBeenCalled();
    expect(result.error).toBeUndefined();
    expect(result.category).toBe('Finance');
  });

  test('routes recoverable vision errors through OCR/text fallback before filename fallback', async () => {
    mockLlamaService.analyzeImage.mockRejectedValue(
      new Error('Failed to parse JSON from vision response (empty response)')
    );
    const { recognizeIfAvailable } = require('../src/main/utils/tesseractUtils');
    recognizeIfAvailable.mockResolvedValueOnce({
      success: true,
      text: 'Invoice #123 total amount due'
    });
    const { analyzeTextWithLlama } = require('../src/main/analysis/documentLlm');
    analyzeTextWithLlama.mockResolvedValueOnce({
      category: 'Financial',
      keywords: ['invoice', 'amount'],
      confidence: 84,
      suggestedName: 'invoice_scan'
    });

    const result = await analyzeImageFile('/path/to/invoice_scan.webp');

    expect(analyzeTextWithLlama).toHaveBeenCalled();
    expect(recognizeIfAvailable.mock.calls[0][1]).toEqual(Buffer.from('processed-image'));
    expect(fs.readFile).toHaveBeenCalledTimes(1);
    expect(result.category).toBe('Financial');
    expect(result.analysisWarning).toMatch(/parse json|empty response/i);
    expect(result.reason).not.toBe('AI engine failed');
  });

  test('treats vision timeouts as recoverable fallback errors without claiming CPU mode', async () => {
    mockLlamaService.analyzeImage.mockRejectedValue(
      new Error('Image analysis timed out before the vision runtime responded.')
    );
    const { recognizeIfAvailable } = require('../src/main/utils/tesseractUtils');
    recognizeIfAvailable.mockResolvedValueOnce({
      success: true,
      text: 'OCR extracted text from a slow vision request'
    });
    const { analyzeTextWithLlama } = require('../src/main/analysis/documentLlm');
    analyzeTextWithLlama.mockResolvedValueOnce({
      category: 'Work',
      keywords: ['ocr', 'slow'],
      confidence: 81,
      suggestedName: 'slow_vision_fallback'
    });

    const result = await analyzeImageFile('/path/to/slow-image.webp');

    expect(result.error).toBeUndefined();
    expect(result.category).toBe('Work');
    expect(result.analysisWarning).toMatch(/timed out/i);
    expect(result.analysisWarning).not.toMatch(/cpu mode/i);
  });

  test('OCR/text fallback after a vision failure re-reads the file instead of holding the original', async () => {
    // A photo with no text hint keeps nothing but the vision copy through
    // the vision call; the rare OCR pass pays one extra disk read.
    mockLlamaService.analyzeImage.mockRejectedValue(new Error('model returned malformed JSON'));

    const { recognizeIfAvailable } = require('../src/main/utils/tesseractUtils');
    recognizeIfAvailable.mockResolvedValueOnce({
      success: true,
      text: 'Screenshot text extracted from processed image buffer'
    });

    const { analyzeTextWithLlama } = require('../src/main/analysis/documentLlm');
    analyzeTextWithLlama.mockResolvedValueOnce({
      category: 'Work',
      keywords: ['screenshot', 'notes'],
      confidence: 83,
      suggestedName: 'meeting_notes'
    });

    const result = await analyzeImageFile('/path/to/image.webp');

    expect(recognizeIfAvailable).toHaveBeenCalled();
    expect(recognizeIfAvailable.mock.calls[0][1]).toEqual(Buffer.from('processed-image'));
    expect(fs.readFile).toHaveBeenCalledTimes(2);
    expect(fs.readFile).toHaveBeenLastCalledWith('/path/to/image.webp');
    expect(analyzeTextWithLlama).toHaveBeenCalled();
    expect(result.category).toBe('Work');
  });

  test('continues OCR/text fallback when OCR preprocessing fails', async () => {
    const sharp = require('sharp');
    sharp
      .mockImplementationOnce(() => ({
        metadata: jest.fn().mockResolvedValue({ width: 3000, height: 2000, format: 'png' })
      }))
      .mockImplementationOnce(() => ({
        rotate: jest.fn().mockReturnThis(),
        resize: jest.fn().mockReturnThis(),
        png: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockRejectedValue(new Error('sharp conversion failed'))
      }))
      .mockImplementationOnce(() => ({
        metadata: jest.fn().mockResolvedValue({ width: 3000, height: 2000, format: 'png' })
      }))
      .mockImplementationOnce(() => ({
        rotate: jest.fn().mockReturnThis(),
        resize: jest.fn().mockReturnThis(),
        png: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockRejectedValue(new Error('sharp conversion failed'))
      }));

    mockLlamaService.analyzeImage.mockRejectedValue(new Error('model returned malformed JSON'));

    const { recognizeIfAvailable } = require('../src/main/utils/tesseractUtils');
    recognizeIfAvailable.mockResolvedValueOnce({
      success: true,
      text: 'Screenshot text extracted from original image buffer'
    });

    const { analyzeTextWithLlama } = require('../src/main/analysis/documentLlm');
    analyzeTextWithLlama.mockResolvedValueOnce({
      category: 'Work',
      keywords: ['screenshot', 'notes'],
      confidence: 83,
      suggestedName: 'meeting_notes'
    });

    const result = await analyzeImageFile('/path/to/image.png');

    expect(recognizeIfAvailable).toHaveBeenCalled();
    expect(recognizeIfAvailable.mock.calls[0][1]).toEqual(Buffer.from('image-data'));
    expect(result.error).toBeUndefined();
    expect(result.category).toBe('Work');
  });

  test('skips JSON repair for prose-like vision responses and uses prose extraction directly', async () => {
    mockLlamaService.analyzeImage
      .mockResolvedValueOnce({
        response: 'The image appears to be a team structure chart for a project meeting.'
      })
      .mockResolvedValueOnce({
        response: 'This is a prose-only retry response that still does not follow JSON.'
      });

    const { extractAndParseJSON } = require('../src/main/utils/jsonRepair');
    extractAndParseJSON
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        category: 'Work',
        keywords: ['team', 'project'],
        confidence: 88,
        suggestedName: 'team_structure',
        has_text: true
      });

    const {
      attemptJsonRepairWithLlama,
      attemptProseExtractionWithLlama
    } = require('../src/main/utils/llmJsonRepair');
    attemptProseExtractionWithLlama.mockResolvedValueOnce(
      JSON.stringify({
        category: 'Work',
        keywords: ['team', 'project'],
        confidence: 88,
        suggestedName: 'team_structure',
        has_text: true
      })
    );

    const result = await analyzeImageFile('/path/to/image.webp');

    expect(attemptJsonRepairWithLlama).not.toHaveBeenCalled();
    expect(mockLlamaService.analyzeImage).toHaveBeenCalledTimes(2);
    expect(attemptProseExtractionWithLlama).toHaveBeenCalledTimes(1);
    expect(result.error).toBeUndefined();
    expect(result.category).toBe('Work');
  });

  test('recovers prose-like vision output with a strict vision retry before prose extraction', async () => {
    mockLlamaService.analyzeImage
      .mockResolvedValueOnce({
        response: 'The image appears to be an invoice with line items and totals.'
      })
      .mockResolvedValueOnce({
        response: JSON.stringify({
          category: 'Financial',
          keywords: ['invoice', 'totals', 'line_items'],
          confidence: 91,
          suggestedName: 'invoice_totals',
          has_text: true,
          content_type: 'text_document'
        })
      });

    const {
      attemptJsonRepairWithLlama,
      attemptProseExtractionWithLlama
    } = require('../src/main/utils/llmJsonRepair');

    const result = await analyzeImageFile('/path/to/invoice_photo.png');

    expect(mockLlamaService.analyzeImage).toHaveBeenCalledTimes(2);
    expect(attemptJsonRepairWithLlama).not.toHaveBeenCalled();
    expect(attemptProseExtractionWithLlama).not.toHaveBeenCalled();
    expect(result.error).toBeUndefined();
    expect(result.category).toBe('Financial');
    expect(result.suggestedName).toBe('invoice_totals.png');
  });

  test('routes non-recoverable vision error payloads through final OCR/text fallback', async () => {
    mockLlamaService.analyzeImage
      .mockResolvedValueOnce({
        response: JSON.stringify({
          error: 'gpu overload',
          confidence: 60
        })
      })
      .mockResolvedValueOnce({
        response: JSON.stringify({
          error: 'gpu overload',
          confidence: 60
        })
      });

    const { recognizeIfAvailable } = require('../src/main/utils/tesseractUtils');
    recognizeIfAvailable.mockResolvedValueOnce({
      success: true,
      text: 'Invoice #987 subtotal tax total due'
    });

    const { analyzeTextWithLlama } = require('../src/main/analysis/documentLlm');
    analyzeTextWithLlama.mockResolvedValueOnce({
      category: 'Financial',
      keywords: ['invoice', 'total'],
      confidence: 82,
      suggestedName: 'invoice_987'
    });

    const result = await analyzeImageFile('/path/to/invoice_photo.png');

    expect(result.error).toBeUndefined();
    expect(result.category).toBe('Financial');
    expect(result.analysisWarning).toMatch(/gpu overload/i);
  });

  test('post-vision OCR re-reads the file for an image with no text hint', async () => {
    mockLlamaService.analyzeImage.mockResolvedValue({
      response: JSON.stringify({
        category: 'Work',
        keywords: ['memo'],
        confidence: 45,
        has_text: true,
        content_type: 'text_document'
      })
    });

    const { recognizeIfAvailable } = require('../src/main/utils/tesseractUtils');
    recognizeIfAvailable.mockResolvedValueOnce({
      success: true,
      text: 'Post vision OCR text from the processed image buffer'
    });

    const result = await analyzeImageFile('/path/to/image.webp');

    expect(recognizeIfAvailable).toHaveBeenCalled();
    expect(recognizeIfAvailable.mock.calls[0][1]).toEqual(Buffer.from('processed-image'));
    expect(fs.readFile).toHaveBeenCalledTimes(2);
    expect(fs.readFile).toHaveBeenLastCalledWith('/path/to/image.webp');
    expect(result.error).toBeUndefined();
  });

  test('skips vision-based OCR passes when conservative vision mode is active', async () => {
    mockLlamaService._shouldUseConservativeVisionProfile.mockReturnValue(true);
    mockLlamaService.analyzeImage.mockResolvedValue({
      response: JSON.stringify({
        category: 'Work',
        keywords: ['memo'],
        confidence: 45,
        has_text: true,
        content_type: 'text_document'
      })
    });

    const { recognizeIfAvailable } = require('../src/main/utils/tesseractUtils');
    recognizeIfAvailable.mockResolvedValueOnce({
      success: false,
      text: ''
    });

    const result = await analyzeImageFile('/path/to/image.webp');

    expect(mockLlamaService.analyzeImage).toHaveBeenCalledTimes(1);
    expect(result.error).toBeUndefined();
  });

  test('detects hallucination (financial doc -> landscape)', async () => {
    // Filename suggests financial, AI suggests landscape
    const aiResponse = {
      response: JSON.stringify({
        category: 'Nature',
        keywords: ['sunset', 'beach'],
        confidence: 90,
        suggestedName: 'sunset_beach',
        has_text: false,
        content_type: 'photograph'
      })
    };
    mockLlamaService.analyzeImage.mockResolvedValue(aiResponse);

    const result = await analyzeImageFile('/path/to/invoice_2024.png');

    // Should detect hallucination and penalize confidence
    expect(result.validation_warnings).toBeDefined();
    expect(result.validation_warnings.some((w) => w.includes('HALLUCINATION'))).toBe(true);
    expect(result.confidence).toBeLessThan(50);
  });

  test('queues embedding if in smart folder', async () => {
    // Mock smart folder match using the proper mock
    const smartFolders = [{ name: 'Docs', path: '/path/to' }];
    require('../src/shared/folderUtils').findContainingSmartFolder.mockReturnValue(smartFolders[0]);

    // Mock successful AI response
    mockLlamaService.analyzeImage.mockResolvedValue({
      response: JSON.stringify({ category: 'Docs', keywords: [], confidence: 80 })
    });

    await analyzeImageFile('/path/to/image.png', smartFolders);

    // Verify embedding was queued
    const { analysisQueue } = require('../src/main/analysis/embeddingQueue/stageQueues');
    expect(analysisQueue.enqueue).toHaveBeenCalled();
  });

  test('skips image embedding enqueue when file moves before persistence', async () => {
    const smartFolders = [{ name: 'Docs', path: '/path/to' }];
    require('../src/shared/folderUtils').findContainingSmartFolder.mockReturnValue(smartFolders[0]);
    mockLlamaService.analyzeImage.mockResolvedValue({
      response: JSON.stringify({ category: 'Docs', keywords: [], confidence: 80 })
    });
    fs.access.mockRejectedValueOnce(new Error('missing'));

    const result = await analyzeImageFile('/path/to/image.png', smartFolders);

    const { analysisQueue } = require('../src/main/analysis/embeddingQueue/stageQueues');
    expect(result._fileMovedDuringAnalysis).toBe(true);
    expect(result.embeddingStatus).toBe('skipped');
    expect(analysisQueue.enqueue).not.toHaveBeenCalled();
  });
});
