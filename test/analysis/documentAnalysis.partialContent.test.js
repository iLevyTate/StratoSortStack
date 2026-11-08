/**
 * documentAnalysis marks a result analyzed from part of the file
 * (partialContent) and gives the extractor what it needs to stay partial:
 *  - an oversize CSV is read from its head with the same byte cap as other
 *    text files, instead of whole;
 *  - a scanned PDF whose OCR stopped at the page cap is flagged partial;
 *  - an over-length body cut by the extractor is flagged partial and the
 *    truncation marker never reaches the model or the stored text.
 */

jest.mock('../../src/main/services/ServiceContainer', () => ({
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

jest.mock('../../src/main/analysis/documentExtractors', () => ({
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
  readTextFileWithEncoding: jest.fn(),
  // Mirrors the real export; the module itself is mocked here.
  TEXT_TRUNCATION_MARKER: '\n\n[Text truncated due to length]'
}));

jest.mock('../../src/main/analysis/analysisLimits', () => ({
  getAnalysisLimits: jest.fn().mockResolvedValue({
    maxTextFileSize: 64,
    maxDocumentFileSize: 1024 * 1024,
    maxImageFileSize: 1024 * 1024
  })
}));

jest.mock('../../src/main/analysis/documentLlm', () => ({
  analyzeTextWithLlama: jest.fn(),
  normalizeCategoryToSmartFolders: jest.fn((cat) => cat),
  AppConfig: { ai: { textAnalysis: { defaultModel: 'test-model.gguf' } } }
}));

jest.mock('../../src/main/llamaUtils', () => ({
  getTextModel: jest.fn().mockReturnValue('test-model.gguf'),
  getLlamaService: jest.fn(() => null)
}));

jest.mock('../../src/main/utils/llmOptimization', () => ({
  globalDeduplicator: {
    generateKey: jest.fn().mockReturnValue('test-key'),
    deduplicate: jest.fn((key, fn) => fn())
  }
}));

jest.mock('../../src/main/analysis/semanticFolderMatcher', () => ({
  applySemanticFolderMatching: jest.fn()
}));

jest.mock('../../src/shared/performanceConstants', () => {
  const actual = jest.requireActual('../../src/shared/performanceConstants');
  return {
    ...actual,
    TIMEOUTS: { ...actual.TIMEOUTS, DELAY_LOCK_RETRY: 1 }
  };
});

jest.mock('../../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const { analyzeDocumentFile } = require('../../src/main/analysis/documentAnalysis');
const documentExtractors = require('../../src/main/analysis/documentExtractors');
const documentLlm = require('../../src/main/analysis/documentLlm');
const { FileProcessingError } = require('../../src/main/errors/AnalysisError');
const fs = require('fs');

const MARKER = documentExtractors.TEXT_TRUNCATION_MARKER;
const statsOfSize = (size) => ({ size, mtimeMs: 1600000000000, mtime: new Date(1600000000000) });

// analyzeDocumentFile caches by path+stats; a fresh path per test keeps a
// prior result from short-circuiting the extraction under test.
let pathCounter = 0;
const uniquePath = (name) => `/docs/${(pathCounter += 1)}-${name}`;

beforeEach(() => {
  jest.clearAllMocks();
  fs.promises.access.mockResolvedValue(undefined);
  documentLlm.analyzeTextWithLlama.mockResolvedValue({
    category: 'Records',
    keywords: ['k'],
    confidence: 90
  });
});

describe('oversize CSV', () => {
  test('is extracted from its head with the text byte cap and flagged partial', async () => {
    fs.promises.stat.mockResolvedValue(statsOfSize(4096));
    documentExtractors.extractTextFromCsv.mockResolvedValue('id name\n1 alpha');

    const filePath = uniquePath('ledger.csv');
    const result = await analyzeDocumentFile(filePath, [], { bypassCache: true });

    expect(documentExtractors.extractTextFromCsv).toHaveBeenCalledWith(filePath, {
      maxBytes: 64
    });
    expect(result.extractionMethod).toBe('content');
    expect(result.partialContent).toBe(true);
  });

  test('within the limit is read whole and not flagged', async () => {
    fs.promises.stat.mockResolvedValue(statsOfSize(32));
    documentExtractors.extractTextFromCsv.mockResolvedValue('id name\n1 alpha');

    const filePath = uniquePath('small.csv');
    const result = await analyzeDocumentFile(filePath, [], { bypassCache: true });

    const [, options] = documentExtractors.extractTextFromCsv.mock.calls[0];
    expect(options?.maxBytes ?? null).toBeNull();
    expect(result.partialContent).toBe(false);
  });
});

describe('scanned PDF OCR coverage', () => {
  const noTextError = (pageCount) =>
    new FileProcessingError('PDF_NO_TEXT_CONTENT', 'scan.pdf', {
      suggestion: 'PDF may be image-based or corrupted',
      textLayer: '',
      pageCount
    });

  beforeEach(() => {
    fs.promises.stat.mockResolvedValue(statsOfSize(4096));
  });

  test('OCR that stopped at the page cap is flagged partial', async () => {
    documentExtractors.extractTextFromPdf.mockRejectedValue(noTextError(40));
    documentExtractors.ocrPdfIfNeeded.mockImplementation(async (_path, options) => {
      if (options?.coverage) Object.assign(options.coverage, { pagesOcred: 3, totalPages: 40 });
      return 'Master services agreement between the parties';
    });

    const result = await analyzeDocumentFile(uniquePath('contract.pdf'), [], {
      bypassCache: true
    });

    // The page count pdf.js already found is handed to OCR.
    expect(documentExtractors.ocrPdfIfNeeded.mock.calls[0][1].pageCount).toBe(40);
    expect(result.extractionMethod).toBe('content');
    expect(result.partialContent).toBe(true);
  });

  test('OCR of every page is not flagged', async () => {
    documentExtractors.extractTextFromPdf.mockRejectedValue(noTextError(2));
    documentExtractors.ocrPdfIfNeeded.mockImplementation(async (_path, options) => {
      if (options?.coverage) Object.assign(options.coverage, { pagesOcred: 2, totalPages: 2 });
      return 'Two page letter about the lease renewal';
    });

    const result = await analyzeDocumentFile(uniquePath('letter.pdf'), [], {
      bypassCache: true
    });

    expect(result.partialContent).toBe(false);
  });
});

describe('over-length extracted body', () => {
  test('is flagged partial and the truncation marker is not analyzed or stored', async () => {
    fs.promises.stat.mockResolvedValue(statsOfSize(4096));
    documentExtractors.extractTextFromDocx.mockResolvedValue(`Quarterly report body${MARKER}`);

    const result = await analyzeDocumentFile(uniquePath('report.docx'), [], {
      bypassCache: true
    });

    expect(result.partialContent).toBe(true);
    const [analyzedText] = documentLlm.analyzeTextWithLlama.mock.calls[0];
    expect(analyzedText).toBe('Quarterly report body');
    expect(String(result.extractedText || '')).not.toContain('[Text truncated due to length]');
  });

  test('a complete body is not flagged', async () => {
    fs.promises.stat.mockResolvedValue(statsOfSize(4096));
    documentExtractors.extractTextFromDocx.mockResolvedValue('Quarterly report body');

    const result = await analyzeDocumentFile(uniquePath('brief.docx'), [], {
      bypassCache: true
    });

    expect(result.partialContent).toBe(false);
  });
});
