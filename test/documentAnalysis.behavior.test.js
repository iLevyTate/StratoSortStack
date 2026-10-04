/**
 * @jest-environment node
 */
const fs = require('fs').promises;
const path = require('path');

// Mock dependencies
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

jest.mock('../src/main/analysis/documentExtractors', () => {
  const extractTextFromPdf = jest.fn();
  const ocrPdfIfNeeded = jest.fn();
  return {
    extractTextFromPdfRaw: extractTextFromPdf,
    ocrPdfIfNeededRaw: ocrPdfIfNeeded,
    extractTextFromPdf,
    ocrPdfIfNeeded,
    extractTextFromDoc: jest.fn(),
    extractTextFromDocx: jest.fn(),
    extractTextFromCsv: jest.fn(),
    extractTextFromXlsx: jest.fn(),
    extractTextFromPptx: jest.fn(),
    extractTextFromXls: jest.fn(),
    extractTextFromPpt: jest.fn(),
    extractTextFromOdfZip: jest.fn(),
    extractTextFromEpub: jest.fn(),
    extractTextFromEml: jest.fn(),
    extractTextFromMsg: jest.fn(),
    extractTextFromKml: jest.fn(),
    extractTextFromKmz: jest.fn(),
    extractPlainTextFromRtf: jest.fn(),
    extractPlainTextFromXml: jest.fn(),
    extractPlainTextFromHtml: jest.fn(),
    readTextFileWithEncoding: jest.fn()
  };
});

jest.mock('../src/main/analysis/documentLlm', () => ({
  analyzeTextWithLlama: jest.fn(),
  normalizeCategoryToSmartFolders: jest.fn((cat) => cat),
  AppConfig: { ai: { textAnalysis: { defaultModel: 'mock-model' } } }
}));

jest.mock('../src/main/llamaUtils', () => ({
  getTextModel: jest.fn(() => 'mock-model'),
  loadLlamaConfig: jest.fn(async () => ({ selectedTextModel: 'mock-model' }))
}));

jest.mock('../src/main/services/ServiceContainer', () => ({
  container: { tryResolve: jest.fn(() => null) },
  ServiceIds: { SEARCH_SERVICE: 'searchService' }
}));

jest.mock('../src/main/analysis/semanticFolderMatcher', () => ({
  applySemanticFolderMatching: jest.fn(async (res) => res),
  getServices: jest.fn(() => ({}))
}));

jest.mock('../src/main/analysis/embeddingQueue/stageQueues', () => ({
  analysisQueue: { add: jest.fn() }
}));

jest.mock('../src/main/utils/llmOptimization', () => ({
  globalDeduplicator: {
    checkDuplicate: jest.fn(async () => null),
    recordProcessing: jest.fn(async () => {}),
    generateKey: jest.fn(() => 'mock-key'),
    deduplicate: jest.fn(async (key, fn) => fn()) // Execute the callback immediately
  }
}));

// Mock fallbackUtils to control behavior
jest.mock('../src/main/analysis/fallbackUtils', () => ({
  getIntelligentCategory: jest.fn(() => 'Videos'), // Match real behavior
  getIntelligentKeywords: jest.fn(() => ['video']),
  safeSuggestedName: jest.fn((name) => name),
  // Fix mock signature to match real implementation (single object)
  createFallbackAnalysis: jest.fn((params) => {
    const errorMsg = params.options?.error || params.reason || 'Unknown error';
    return {
      category: 'Documents', // Match real behavior
      error: errorMsg,
      confidence: 0
    };
  })
}));

// Mock utils for normalization
jest.mock('../src/main/analysis/utils', () => ({
  normalizeAnalysisResult: jest.fn((raw, fallback) => {
    return {
      ...raw,
      category: raw.category || fallback.category,
      confidence: raw.confidence !== undefined ? raw.confidence : fallback.confidence
    };
  })
}));

describe('documentAnalysis (behavior)', () => {
  let analyzeDocumentFile;
  let extractors;
  let documentLlm;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    // Mock fs.stat to return consistent values for caching
    jest.spyOn(fs, 'stat').mockResolvedValue({
      size: 1024,
      mtimeMs: 1600000000000,
      mtime: new Date(1600000000000),
      isFile: () => true
    });

    // Mock fs.readFile for text files
    jest.spyOn(fs, 'readFile').mockResolvedValue('mock file content');

    // Mock fs.access to simulate file existence checks
    jest.spyOn(fs, 'access').mockResolvedValue(undefined);

    analyzeDocumentFile = require('../src/main/analysis/documentAnalysis').analyzeDocumentFile;
    extractors = require('../src/main/analysis/documentExtractors');
    documentLlm = require('../src/main/analysis/documentLlm');
  });

  test('analyzes PDF by extracting text and calling LLM', async () => {
    // Use simple filename to avoid path separator issues
    const filePath = 'doc.pdf';
    extractors.extractTextFromPdf.mockResolvedValue('Extracted PDF content');
    documentLlm.analyzeTextWithLlama.mockResolvedValue({
      summary: 'A summary',
      category: 'Finance',
      confidence: 0.9
    });

    const result = await analyzeDocumentFile(filePath);

    expect(extractors.extractTextFromPdf).toHaveBeenCalledWith(filePath, 'doc.pdf', {
      signal: undefined
    });
    expect(documentLlm.analyzeTextWithLlama).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        category: 'Finance',
        confidence: 0.9
      })
    );
  });

  test('uses OCR fallback when PDF extraction returns empty text', async () => {
    const filePath = 'scanned.pdf';
    extractors.extractTextFromPdf.mockResolvedValue(''); // Empty result
    extractors.ocrPdfIfNeeded.mockResolvedValue('OCR Content');
    documentLlm.analyzeTextWithLlama.mockResolvedValue({
      summary: 'OCR Summary',
      category: 'Scanned',
      confidence: 0.8
    });

    await analyzeDocumentFile(filePath);

    expect(extractors.extractTextFromPdf).toHaveBeenCalled();
    expect(extractors.ocrPdfIfNeeded).toHaveBeenCalledWith(filePath, { signal: undefined });
    expect(documentLlm.analyzeTextWithLlama).toHaveBeenCalledWith(
      'OCR Content',
      expect.any(String), // fileName
      expect.any(Array), // smartFolders
      expect.any(String), // date
      expect.any(Array), // namingContext
      expect.any(Object) // options (bypassCache)
    );
  });

  test('keeps a thin PDF text layer when OCR finds nothing longer, and prefers OCR when it does', async () => {
    const extractors = require('../src/main/analysis/documentExtractors');
    const { analyzeTextWithLlama } = require('../src/main/analysis/documentLlm');
    const thin = Object.assign(new Error('PDF contains no extractable text'), {
      code: 'PDF_NO_TEXT_CONTENT',
      metadata: { textLayer: 'Scanned with CamScanner', pageCount: 1 }
    });
    extractors.extractTextFromPdf.mockRejectedValue(thin);

    // OCR finds nothing: the footer is all there is, so it is what gets analyzed.
    extractors.ocrPdfIfNeeded.mockResolvedValueOnce('');
    analyzeTextWithLlama.mockClear();
    await analyzeDocumentFile('/docs/scan.pdf', []);
    expect(analyzeTextWithLlama.mock.calls.at(-1)?.[0]).toBe('Scanned with CamScanner');

    // OCR reads the page: the longer text wins.
    extractors.ocrPdfIfNeeded.mockResolvedValueOnce(
      'Lease agreement between the parties for the premises at 12 Main Street'
    );
    analyzeTextWithLlama.mockClear();
    await analyzeDocumentFile('/docs/scan.pdf', []);
    expect(analyzeTextWithLlama.mock.calls.at(-1)?.[0]).toMatch(/^Lease agreement/);
  });

  test('treats PDF_NO_TEXT_CONTENT as expected fallback without hard error logging', async () => {
    const filePath = 'scan-only.pdf';
    const noTextError = new Error('PDF contains no extractable text');
    noTextError.code = 'PDF_NO_TEXT_CONTENT';
    extractors.extractTextFromPdf.mockRejectedValue(noTextError);
    extractors.ocrPdfIfNeeded.mockResolvedValue('');

    const result = await analyzeDocumentFile(filePath);
    const logger = require('../src/shared/logger').createLogger();

    expect(extractors.ocrPdfIfNeeded).toHaveBeenCalledWith(filePath, { signal: undefined });
    expect(result).toEqual(
      expect.objectContaining({
        category: 'Documents',
        confidence: 0
      })
    );
    expect(result.error).toMatch(/no extractable text|scanned pdf/i);
    expect(logger.error).not.toHaveBeenCalled();
  });

  describe('user cancellation during PDF extraction', () => {
    const makeAbortError = () => {
      const err = new Error('Operation aborted');
      err.name = 'AbortError';
      return err;
    };

    test('propagates AbortError from text extraction without OCR, wrapping or error logs', async () => {
      const filePath = 'cancelled.pdf';
      const controller = new AbortController();
      controller.abort();
      extractors.extractTextFromPdf.mockRejectedValue(makeAbortError());

      await expect(
        analyzeDocumentFile(filePath, [], { abortSignal: controller.signal })
      ).rejects.toMatchObject({ name: 'AbortError' });

      const logger = require('../src/shared/logger').createLogger();
      expect(extractors.extractTextFromPdf).toHaveBeenCalledWith(filePath, 'cancelled.pdf', {
        signal: controller.signal
      });
      expect(extractors.ocrPdfIfNeeded).not.toHaveBeenCalled();
      expect(documentLlm.analyzeTextWithLlama).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    test('propagates cancellation raised inside the OCR fallback', async () => {
      const filePath = 'cancelled-during-ocr.pdf';
      const noTextError = new Error('PDF contains no extractable text');
      noTextError.code = 'PDF_NO_TEXT_CONTENT';
      const cancelled = new Error('Operation cancelled');
      cancelled.code = 'OPERATION_CANCELLED';
      extractors.extractTextFromPdf.mockRejectedValue(noTextError);
      extractors.ocrPdfIfNeeded.mockRejectedValue(cancelled);

      await expect(analyzeDocumentFile(filePath)).rejects.toMatchObject({
        code: 'OPERATION_CANCELLED'
      });

      const logger = require('../src/shared/logger').createLogger();
      expect(documentLlm.analyzeTextWithLlama).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  test('reads plain-text files through the encoding-aware reader, not a bare utf8 decode', async () => {
    const filePath = 'notes.txt';
    // resetModules() gives the SUT a fresh memfs instance, so the top-level
    // spies do not reach it. The text branch fails closed when the size
    // cannot be established, so stat must succeed on the SUT's own fs.
    jest.spyOn(require('fs').promises, 'stat').mockResolvedValue({
      size: 1024,
      mtimeMs: 1600000000000,
      mtime: new Date(1600000000000)
    });
    extractors.readTextFileWithEncoding.mockResolvedValue('Decoded UTF-16 content');
    documentLlm.analyzeTextWithLlama.mockResolvedValue({
      summary: 'ok',
      category: 'Notes',
      confidence: 0.8
    });

    await analyzeDocumentFile(filePath);

    expect(extractors.readTextFileWithEncoding).toHaveBeenCalledWith(filePath);
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(documentLlm.analyzeTextWithLlama).toHaveBeenCalledWith(
      'Decoded UTF-16 content',
      expect.any(String),
      expect.any(Array),
      expect.any(String),
      expect.any(Array),
      expect.any(Object)
    );
  });

  test('routes legacy .doc through the office extractor (document size limit, not text limit)', async () => {
    const filePath = 'legacy.doc';
    // 60 MB: over the 50 MB text-file default but under the office document limit.
    fs.stat.mockResolvedValue({
      size: 60 * 1024 * 1024,
      mtimeMs: 1600000000000,
      mtime: new Date(1600000000000),
      isFile: () => true
    });
    extractors.extractTextFromDoc.mockResolvedValue('Word 97 content');
    documentLlm.analyzeTextWithLlama.mockResolvedValue({
      summary: 'ok',
      category: 'Docs',
      confidence: 0.8
    });

    await analyzeDocumentFile(filePath);

    expect(extractors.extractTextFromDoc).toHaveBeenCalledWith(filePath);
    expect(extractors.readTextFileWithEncoding).not.toHaveBeenCalled();
    expect(documentLlm.analyzeTextWithLlama).toHaveBeenCalled();
  });

  test('skips AI for video files and uses extension-based fallback', async () => {
    const filePath = 'movie.mp4';

    const result = await analyzeDocumentFile(filePath);

    expect(extractors.extractTextFromPdf).not.toHaveBeenCalled();
    expect(documentLlm.analyzeTextWithLlama).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        category: 'Videos',
        extractionMethod: 'extension_short_circuit'
      })
    );
  });

  test('handles extraction errors gracefully with fallback analysis', async () => {
    const filePath = 'corrupt.pdf';
    extractors.extractTextFromPdf.mockRejectedValue(new Error('Corrupt PDF'));
    extractors.ocrPdfIfNeeded.mockRejectedValue(new Error('OCR Failed'));

    const result = await analyzeDocumentFile(filePath);

    expect(result).toEqual(
      expect.objectContaining({
        category: 'Documents',
        confidence: 0
      })
    );
    // Check for error message in the result
    // The actual error message might be "Failed to extract text from PDF document" due to FileProcessingError wrapping
    expect(result.error).toMatch(/Corrupt PDF|Failed to extract text/);
  });

  test('does not cache degraded content fallback results', async () => {
    const filePath = 'notes.pdf';
    extractors.extractTextFromPdf.mockResolvedValue('Recovered note content');
    documentLlm.analyzeTextWithLlama
      .mockResolvedValueOnce({ error: 'LLM unavailable' })
      .mockResolvedValueOnce({ error: 'LLM unavailable' });

    const first = await analyzeDocumentFile(filePath);
    const second = await analyzeDocumentFile(filePath);

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first.error || first.purpose).toBeTruthy();
    expect(second.error || second.purpose).toBeTruthy();
    expect(documentLlm.analyzeTextWithLlama).toHaveBeenCalledTimes(2);
  });

  test.each([
    { ext: '.docx', extractor: 'extractTextFromDocx' },
    { ext: '.xlsx', extractor: 'extractTextFromXlsx' },
    { ext: '.odt', extractor: 'extractTextFromOdfZip' },
    { ext: '.epub', extractor: 'extractTextFromEpub' },
    { ext: '.eml', extractor: 'extractTextFromEml' },
    { ext: '.msg', extractor: 'extractTextFromMsg' }
  ])('routes %s through the correct extractor', async ({ ext, extractor }) => {
    const filePath = `sample${ext}`;
    extractors[extractor].mockResolvedValue('Extracted content');
    documentLlm.analyzeTextWithLlama.mockResolvedValue({
      summary: 'ok',
      category: 'Docs',
      confidence: 0.8
    });

    await analyzeDocumentFile(filePath);

    expect(extractors[extractor]).toHaveBeenCalledTimes(1);
    expect(extractors[extractor].mock.calls[0][0]).toBe(filePath);
    expect(documentLlm.analyzeTextWithLlama).toHaveBeenCalled();
  });

  describe('Caching behavior', () => {
    test('persists cache between calls', async () => {
      const filePath = 'cached.pdf';
      extractors.extractTextFromPdf.mockResolvedValue('Content');
      documentLlm.analyzeTextWithLlama.mockResolvedValue({ category: 'Cached' });

      // First call
      await analyzeDocumentFile(filePath);

      // Second call
      await analyzeDocumentFile(filePath);

      expect(extractors.extractTextFromPdf).toHaveBeenCalled();
    });
  });

  test('bypasses cache when requested', async () => {
    const filePath = 'bypass.pdf';
    extractors.extractTextFromPdf.mockResolvedValue('Content');
    documentLlm.analyzeTextWithLlama.mockResolvedValue({ category: 'Fresh' });

    await analyzeDocumentFile(filePath);
    await analyzeDocumentFile(filePath, [], { bypassCache: true });

    expect(extractors.extractTextFromPdf).toHaveBeenCalledTimes(2);
  });
});
