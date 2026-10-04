/**
 * documentAnalysis extraction guards:
 *  - office extraction is retried once only for transient OS errors, never
 *    for parse failures or timeouts (each retry could re-run a full OCR sweep);
 *  - the text-file size guard fails closed when the file cannot be stat'ed
 *    instead of reading an unbounded file into memory.
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
  readTextFileWithEncoding: jest.fn()
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
const fs = require('fs');

const SMALL_STATS = { size: 1024, mtimeMs: 1600000000000, mtime: new Date(1600000000000) };

// analyzeDocumentFile caches by path+stats; give every test its own path so a
// prior result cannot short-circuit the extraction under test.
let pathCounter = 0;
const uniquePath = (name) => `/docs/${(pathCounter += 1)}-${name}`;

describe('office extraction retry gating', () => {
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

  test('a parse failure is not retried and falls back to filename analysis', async () => {
    documentExtractors.extractTextFromDocx.mockRejectedValue(
      new Error('corrupt zip central directory')
    );

    const result = await analyzeDocumentFile(uniquePath('report.docx'), []);

    expect(documentExtractors.extractTextFromDocx).toHaveBeenCalledTimes(1);
    expect(result.extractionMethod).toBe('filename_fallback');
    expect(result.extractionError).toBe('corrupt zip central directory');
    expect(documentLlm.analyzeTextWithLlama).not.toHaveBeenCalled();
  });

  test('a legacy format the build cannot read is named, carries its hint and is never a model gap', async () => {
    // The hint lives under FileProcessingError.metadata; reading it off the
    // error itself left "Save the workbook as .xlsx" out of every purpose.
    const { FileProcessingError } = require('../../src/main/errors/AnalysisError');
    documentExtractors.extractTextFromXls.mockRejectedValue(
      new FileProcessingError('LEGACY_FORMAT_UNSUPPORTED', 'ledger.xls', {
        fileType: '.xls',
        suggestion: 'Save the workbook as .xlsx to have its contents analyzed.'
      })
    );

    const result = await analyzeDocumentFile(uniquePath('ledger.xls'), []);

    expect(documentExtractors.extractTextFromXls).toHaveBeenCalledTimes(1);
    expect(result.purpose).toBe(
      'Excel 97-2003 workbook (.xls): contents not readable in this build, organized by filename. Save the workbook as .xlsx to have its contents analyzed.'
    );
    expect(result.extractionErrorCode).toBe('LEGACY_FORMAT_UNSUPPORTED');
    expect(result.extractionMethod).toBe('format_unsupported');
    expect(documentLlm.analyzeTextWithLlama).not.toHaveBeenCalled();
  });

  test('a password-protected .doc says so and is not retried as a model gap either', async () => {
    const { FileProcessingError } = require('../../src/main/errors/AnalysisError');
    documentExtractors.extractTextFromDoc.mockRejectedValue(
      new FileProcessingError('DOC_ENCRYPTED', 'secret.doc', {
        suggestion: 'Remove the password from the document and try again.'
      })
    );

    const result = await analyzeDocumentFile(uniquePath('secret.doc'), []);

    expect(result.purpose).toMatch(/password-protected/);
    expect(result.purpose).toMatch(/Remove the password/);
    expect(result.extractionErrorCode).toBe('DOC_ENCRYPTED');
    expect(result.extractionMethod).toBe('format_unsupported');
  });

  test('a timeout is not retried', async () => {
    documentExtractors.extractTextFromPptx.mockRejectedValue(
      new Error('PPTX extraction: deck.pptx timed out after 90000ms')
    );

    const result = await analyzeDocumentFile(uniquePath('deck.pptx'), []);

    expect(documentExtractors.extractTextFromPptx).toHaveBeenCalledTimes(1);
    expect(result.extractionMethod).toBe('filename_fallback');
  });

  test.each(['EBUSY', 'EPERM', 'EAGAIN', 'EMFILE', 'ENFILE'])(
    'a transient %s error is retried exactly once',
    async (code) => {
      documentExtractors.extractTextFromDocx
        .mockRejectedValueOnce(Object.assign(new Error(`${code}: resource busy`), { code }))
        .mockResolvedValueOnce('Recovered document body');

      const result = await analyzeDocumentFile(uniquePath('report.docx'), []);

      expect(documentExtractors.extractTextFromDocx).toHaveBeenCalledTimes(2);
      expect(documentLlm.analyzeTextWithLlama).toHaveBeenCalled();
      expect(result.category).toBe('Docs');
    }
  );

  test('a transient code wrapped as the cause of a FileProcessingError is still retried', async () => {
    const { FileProcessingError } = require('../../src/main/errors/AnalysisError');
    const osError = Object.assign(new Error('EBUSY: locked'), { code: 'EBUSY' });
    documentExtractors.extractTextFromDocx
      .mockRejectedValueOnce(
        new FileProcessingError('FILE_READ_ERROR', 'report.docx', { cause: osError })
      )
      .mockResolvedValueOnce('Recovered document body');

    await analyzeDocumentFile(uniquePath('report.docx'), []);

    expect(documentExtractors.extractTextFromDocx).toHaveBeenCalledTimes(2);
  });

  test('a transient failure that fails again on retry is not retried a third time', async () => {
    documentExtractors.extractTextFromDocx.mockRejectedValue(
      Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
    );

    const result = await analyzeDocumentFile(uniquePath('report.docx'), []);

    expect(documentExtractors.extractTextFromDocx).toHaveBeenCalledTimes(2);
    expect(result.extractionMethod).toBe('filename_fallback');
    expect(result.extractionErrorCode).toBe('EBUSY');
  });

  test('cancellation propagates instead of retrying or degrading to a fallback', async () => {
    documentExtractors.extractTextFromDocx.mockRejectedValue(
      Object.assign(new Error('cancelled'), { code: 'OPERATION_CANCELLED' })
    );

    await expect(analyzeDocumentFile(uniquePath('report.docx'), [])).rejects.toMatchObject({
      code: 'OPERATION_CANCELLED'
    });
    expect(documentExtractors.extractTextFromDocx).toHaveBeenCalledTimes(1);
  });

  test('the office extractors receive the caller abort signal', async () => {
    const controller = new AbortController();
    const filePath = uniquePath('report.docx');
    documentExtractors.extractTextFromDocx.mockResolvedValue('body');

    await analyzeDocumentFile(filePath, [], { abortSignal: controller.signal });

    expect(documentExtractors.extractTextFromDocx).toHaveBeenCalledWith(filePath, {
      signal: controller.signal
    });
  });
});

describe('text-file size guard when the cache stat failed', () => {
  const SIXTY_MB = 60 * 1024 * 1024;

  beforeEach(() => {
    jest.clearAllMocks();
    fs.promises.access.mockResolvedValue(undefined);
    documentLlm.analyzeTextWithLlama.mockResolvedValue({
      category: 'Notes',
      keywords: [],
      confidence: 90
    });
  });

  test('re-stats an oversize file and reads only its head, never the whole file', async () => {
    fs.promises.stat
      .mockRejectedValueOnce(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }))
      .mockResolvedValueOnce({ ...SMALL_STATS, size: SIXTY_MB });
    documentExtractors.readTextFileWithEncoding.mockResolvedValue('first part of a huge file');

    const filePath = uniquePath('huge.txt');
    const result = await analyzeDocumentFile(filePath, []);

    expect(fs.promises.stat).toHaveBeenCalledTimes(2);
    // The oversize file is read through the encoding-aware reader with a
    // byte cap below its size; a bare readFile of it must never happen.
    expect(documentExtractors.readTextFileWithEncoding).toHaveBeenCalledTimes(1);
    const [target, options] = documentExtractors.readTextFileWithEncoding.mock.calls[0];
    expect(target).toBe(filePath);
    expect(options.maxBytes).toBeGreaterThan(0);
    expect(options.maxBytes).toBeLessThan(SIXTY_MB);
    expect(fs.promises.readFile.mock.calls.map(([t]) => t)).not.toContain(filePath);
    expect(result.extractionMethod).toBe('content');
    expect(result.partialContent).toBe(true);
  });

  test('fails closed when the size cannot be established at all', async () => {
    fs.promises.stat.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

    const result = await analyzeDocumentFile(uniquePath('locked.txt'), []);

    expect(documentExtractors.readTextFileWithEncoding).not.toHaveBeenCalled();
    expect(result.extractionMethod).toBe('failed');
    expect(result.error).toBe('Failed to read file from disk');
  });

  test('re-stat success within the limit lets the read proceed', async () => {
    fs.promises.stat
      .mockRejectedValueOnce(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }))
      .mockResolvedValueOnce(SMALL_STATS);
    documentExtractors.readTextFileWithEncoding.mockResolvedValue('small file body');

    const filePath = uniquePath('small.txt');
    const result = await analyzeDocumentFile(filePath, []);

    expect(documentExtractors.readTextFileWithEncoding).toHaveBeenCalledWith(filePath);
    expect(result.category).toBe('Notes');
  });
});
