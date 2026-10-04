/**
 * documentAnalysis extraction guards (fallback provenance):
 *  - an office document whose contents could not be read is a fallback
 *    result, and must say so the way every other fallback does
 *    (`isFallback` / `_isFallback` / `fallbackReason`), whether the method is
 *    `filename_fallback` (parse failure) or `format_unsupported` (no reader
 *    in this build, password-protected .doc). Stamping only the method left
 *    the IPC pipeline classifier counting legacy .xls files as `primary`.
 */

jest.mock('../src/main/services/ServiceContainer', () => ({
  container: { tryResolve: jest.fn(() => null) },
  ServiceIds: { SEARCH_SERVICE: 'searchService' }
}));

jest.mock('fs', () => {
  const actualFs = jest.requireActual('fs');
  return {
    ...actualFs,
    promises: {
      stat: jest.fn(),
      readFile: jest.fn(),
      access: jest.fn(),
      writeFile: jest.fn(),
      unlink: jest.fn(),
      readdir: jest.fn()
    }
  };
});

jest.mock('../src/main/analysis/documentExtractors', () => ({
  extractTextFromPdf: jest.fn(),
  ocrPdfIfNeeded: jest.fn(),
  isEncryptedPdfError: jest.fn(() => false),
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
}));

jest.mock('../src/main/analysis/documentLlm', () => ({
  analyzeTextWithLlama: jest.fn(),
  normalizeCategoryToSmartFolders: jest.fn((cat) => cat),
  AppConfig: { ai: { textAnalysis: { defaultModel: 'test-model.gguf' } } }
}));

jest.mock('../src/main/llamaUtils', () => ({
  getTextModel: jest.fn().mockReturnValue('test-model.gguf'),
  getLlamaService: jest.fn(() => null)
}));

jest.mock('../src/main/utils/llmOptimization', () => ({
  globalDeduplicator: {
    generateKey: jest.fn().mockReturnValue('test-key'),
    deduplicate: jest.fn((key, fn) => fn())
  }
}));

jest.mock('../src/main/analysis/semanticFolderMatcher', () => ({
  applySemanticFolderMatching: jest.fn()
}));

jest.mock('../src/shared/performanceConstants', () => {
  const actual = jest.requireActual('../src/shared/performanceConstants');
  return {
    ...actual,
    TIMEOUTS: { ...actual.TIMEOUTS, DELAY_LOCK_RETRY: 1 }
  };
});

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const { analyzeDocumentFile } = require('../src/main/analysis/documentAnalysis');
const documentExtractors = require('../src/main/analysis/documentExtractors');
const documentLlm = require('../src/main/analysis/documentLlm');
const { FileProcessingError } = require('../src/main/errors/AnalysisError');
const { isFallbackAnalysis } = require('../src/shared/analysisProvenance');
const fs = require('fs');

const SMALL_STATS = { size: 1024, mtimeMs: 1600000000000, mtime: new Date(1600000000000) };

// analyzeDocumentFile caches by path+stats; give every test its own path so a
// prior result cannot short-circuit the extraction under test.
let pathCounter = 0;
const uniquePath = (name) => `/docs/${(pathCounter += 1)}-${name}`;

describe('office extraction failures are stamped as fallbacks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.promises.stat.mockResolvedValue(SMALL_STATS);
    fs.promises.access.mockResolvedValue(undefined);
    documentLlm.analyzeTextWithLlama.mockResolvedValue({
      category: 'Docs',
      keywords: ['k'],
      confidence: 90
    });
  });

  test('a legacy .xls the build cannot read carries the fallback flags next to format_unsupported', async () => {
    documentExtractors.extractTextFromXls.mockRejectedValue(
      new FileProcessingError('LEGACY_FORMAT_UNSUPPORTED', 'ledger.xls', {
        fileType: '.xls',
        suggestion: 'Save the workbook as .xlsx to have its contents analyzed.'
      })
    );

    const result = await analyzeDocumentFile(uniquePath('ledger.xls'), []);

    expect(result.extractionMethod).toBe('format_unsupported');
    expect(result.isFallback).toBe(true);
    expect(result._isFallback).toBe(true);
    expect(typeof result.fallbackReason).toBe('string');
    expect(result.fallbackReason.length).toBeGreaterThan(0);
    expect(isFallbackAnalysis(result)).toBe(true);
    expect(documentLlm.analyzeTextWithLlama).not.toHaveBeenCalled();
  });

  test('a password-protected .doc carries the fallback flags next to format_unsupported', async () => {
    documentExtractors.extractTextFromDoc.mockRejectedValue(
      new FileProcessingError('DOC_ENCRYPTED', 'secret.doc', {
        suggestion: 'Remove the password from the document and try again.'
      })
    );

    const result = await analyzeDocumentFile(uniquePath('secret.doc'), []);

    expect(result.extractionMethod).toBe('format_unsupported');
    expect(result.isFallback).toBe(true);
    expect(result._isFallback).toBe(true);
    expect(result.fallbackReason).toMatch(/password/i);
    expect(isFallbackAnalysis(result)).toBe(true);
  });

  test('a parse failure that falls back to the filename is flagged the same way', async () => {
    documentExtractors.extractTextFromDocx.mockRejectedValue(
      new Error('corrupt zip central directory')
    );

    const result = await analyzeDocumentFile(uniquePath('report.docx'), []);

    expect(result.extractionMethod).toBe('filename_fallback');
    expect(result.isFallback).toBe(true);
    expect(result._isFallback).toBe(true);
    expect(typeof result.fallbackReason).toBe('string');
    expect(result.fallbackReason.length).toBeGreaterThan(0);
  });

  test('fallback reasons are stable labels, not the raw extractor error text', async () => {
    // The IPC classifier records `fallbackReason` as the pipeline outcome
    // reason, and the Diagnostics tile counts those; a free-text error
    // message per file would make that histogram unreadable.
    documentExtractors.extractTextFromXls.mockRejectedValue(
      new FileProcessingError('LEGACY_FORMAT_UNSUPPORTED', 'a.xls', { fileType: '.xls' })
    );
    const first = await analyzeDocumentFile(uniquePath('a.xls'), []);

    documentExtractors.extractTextFromXls.mockRejectedValue(
      new FileProcessingError('LEGACY_FORMAT_UNSUPPORTED', 'b.xls', {
        fileType: '.xls',
        suggestion: 'Save the workbook as .xlsx to have its contents analyzed.'
      })
    );
    const second = await analyzeDocumentFile(uniquePath('b.xls'), []);

    expect(first.fallbackReason).toBe(second.fallbackReason);
    expect(first.fallbackReason).not.toContain(first.extractionError);
  });
});
