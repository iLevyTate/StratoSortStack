/**
 * @jest-environment node
 *
 * Dispatch for the file types the README promised but nothing read: 3D and
 * design files, notebooks, tar/gz archives, and the head read for oversize
 * text files. The readers themselves are unit-tested in test/extractors.*.
 */
const fs = require('fs');

jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  };
  return { createLogger: jest.fn(() => logger), logger };
});

jest.mock('../src/main/analysis/documentExtractors', () => ({
  extractTextFromPdf: jest.fn(),
  extractTextFromPdfRaw: jest.fn(),
  ocrPdfIfNeeded: jest.fn(),
  ocrPdfIfNeededRaw: jest.fn(),
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

jest.mock(
  '../src/main/analysis/extractors/cadDesignExtractors',
  () => ({
    extractTextFromStl: jest.fn(),
    extractTextFromObj: jest.fn(),
    extractTextFrom3mf: jest.fn(),
    extractTextFromGcode: jest.fn(),
    extractTextFromEps: jest.fn(),
    extractTextFromAi: jest.fn()
  }),
  { virtual: true }
);
jest.mock(
  '../src/main/analysis/extractors/notebookExtractor',
  () => ({ extractTextFromIpynb: jest.fn() }),
  { virtual: true }
);
jest.mock(
  '../src/main/analysis/extractors/archiveListing',
  () => ({
    describeArchive: jest.fn(),
    classifyArchiveExtension: jest.fn((name) =>
      /\.tar$/i.test(name)
        ? 'tar'
        : /\.tgz$/i.test(name)
          ? 'tgz'
          : /\.gz$/i.test(name)
            ? 'gzip'
            : null
    )
  }),
  { virtual: true }
);

jest.mock('../src/main/analysis/documentLlm', () => ({
  analyzeTextWithLlama: jest.fn(),
  normalizeCategoryToSmartFolders: jest.fn((category) => category),
  AppConfig: { ai: { textAnalysis: { defaultModel: 'test-model' } } }
}));
jest.mock('../src/main/llamaUtils', () => ({
  getLlamaService: jest.fn(() => null),
  loadLlamaConfig: jest.fn(async () => ({ textModel: 'test-model' }))
}));
jest.mock('../src/main/services/ServiceContainer', () => ({
  container: { tryResolve: jest.fn(() => null), has: jest.fn(() => false) },
  ServiceIds: { SEARCH_SERVICE: 'SEARCH_SERVICE' }
}));
jest.mock('../src/main/analysis/semanticFolderMatcher', () => ({
  applySemanticFolderMatching: jest.fn(async (result) => result)
}));
jest.mock('../src/main/analysis/embeddingQueue/stageQueues', () => ({
  analysisQueue: { add: jest.fn((fn) => fn()) }
}));
jest.mock('../src/main/utils/llmOptimization', () => ({
  globalDeduplicator: {
    dedupe: jest.fn((key, fn) => fn()),
    deduplicate: jest.fn((key, fn) => fn())
  }
}));
jest.mock('../src/main/analysis/namingContextBm25', () => ({
  fetchNamingContextFromBm25: jest.fn(async () => [])
}));
jest.mock('../src/main/analysis/analysisLimits', () => ({
  getAnalysisLimits: jest.fn(async () => ({ maxTextFileSize: 16 }))
}));

const extractors = require('../src/main/analysis/documentExtractors');
const cad = require('../src/main/analysis/extractors/cadDesignExtractors');
const notebook = require('../src/main/analysis/extractors/notebookExtractor');
const archives = require('../src/main/analysis/extractors/archiveListing');
const documentLlm = require('../src/main/analysis/documentLlm');
const { analyzeDocumentFile } = require('../src/main/analysis/documentAnalysis');

const LLM_OK = { summary: 'ok', category: 'Models', confidence: 0.8, keywords: ['model'] };

describe('documentAnalysis dispatch for the restored file types', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    documentLlm.analyzeTextWithLlama.mockResolvedValue(LLM_OK);
  });

  test.each([
    ['.stl', 'extractTextFromStl'],
    ['.obj', 'extractTextFromObj'],
    ['.3mf', 'extractTextFrom3mf'],
    ['.gcode', 'extractTextFromGcode'],
    ['.eps', 'extractTextFromEps']
  ])('%s is read through %s and analyzed as content', async (ext, fn) => {
    cad[fn].mockResolvedValue(`${ext} model metadata text long enough to analyze`);

    const result = await analyzeDocumentFile(`/models/part${ext}`, [{ name: 'Models' }], {
      bypassCache: true
    });

    expect(cad[fn]).toHaveBeenCalledWith(`/models/part${ext}`);
    expect(documentLlm.analyzeTextWithLlama).toHaveBeenCalled();
    expect(documentLlm.analyzeTextWithLlama.mock.calls[0][0]).toContain('model metadata text');
    expect(result.extractionMethod).toBe('content');
  });

  test('.ai is read through extractTextFromAi with a PDF reader injected', async () => {
    cad.extractTextFromAi.mockImplementation(async (filePath, { extractTextFromPdf }) => {
      expect(typeof extractTextFromPdf).toBe('function');
      return 'Adobe Illustrator document with enough metadata text';
    });

    await analyzeDocumentFile('/design/logo.ai', [], { bypassCache: true });

    expect(cad.extractTextFromAi).toHaveBeenCalledTimes(1);
    expect(documentLlm.analyzeTextWithLlama).toHaveBeenCalled();
  });

  test('.psd has no reader and is organized by filename with an honest reason', async () => {
    const result = await analyzeDocumentFile('/design/mockup.psd', [], { bypassCache: true });

    expect(documentLlm.analyzeTextWithLlama).not.toHaveBeenCalled();
    expect(result.extractionMethod).toBe('filename');
    expect(result.fallbackReason).toMatch(/no PSD reader/);
    expect(result.confidence).toBe(70);
  });

  test('an empty metadata read falls back to the filename instead of calling the model', async () => {
    cad.extractTextFromStl.mockResolvedValue('');

    const result = await analyzeDocumentFile('/models/blank.stl', [], { bypassCache: true });

    expect(documentLlm.analyzeTextWithLlama).not.toHaveBeenCalled();
    expect(result.extractionMethod).toBe('filename');
    expect(result.fallbackReason).toMatch(/no readable metadata/);
  });

  test('.ipynb routes through the notebook reader', async () => {
    notebook.extractTextFromIpynb.mockResolvedValue('Jupyter notebook (Python 3)\n\n# Analysis');

    await analyzeDocumentFile('/work/analysis.ipynb', [], { bypassCache: true });

    expect(notebook.extractTextFromIpynb).toHaveBeenCalledWith('/work/analysis.ipynb');
    expect(documentLlm.analyzeTextWithLlama).toHaveBeenCalled();
  });

  test('.tar and .tgz archives are listed and their entry names become keywords', async () => {
    archives.describeArchive.mockResolvedValue({
      format: 'tar',
      summary: 'TAR archive with 3 entries',
      entryNames: ['invoices/2026-01.pdf', 'invoices/2026-02.pdf', 'notes.txt'],
      totalEntries: 3,
      truncated: false
    });

    const result = await analyzeDocumentFile('/downloads/books.tar', [], { bypassCache: true });

    expect(archives.describeArchive).toHaveBeenCalledWith('/downloads/books.tar');
    expect(result.extractionMethod).toBe('archive');
    expect(result.purpose).toBe('TAR archive with 3 entries');
    expect(result.keywords.length).toBeGreaterThan(0);
    expect(documentLlm.analyzeTextWithLlama).not.toHaveBeenCalled();
  });

  test('an unreadable tar still returns an archive result instead of failing', async () => {
    archives.describeArchive.mockResolvedValue(null);

    const result = await analyzeDocumentFile('/downloads/broken.tgz', [], { bypassCache: true });

    expect(result.extractionMethod).toBe('archive');
    expect(result.purpose).toMatch(/content listing unavailable/);
  });

  test('.rar keeps the bare archive summary (no permissively licensed reader)', async () => {
    const result = await analyzeDocumentFile('/downloads/photos.rar', [], { bypassCache: true });

    expect(archives.describeArchive).not.toHaveBeenCalled();
    expect(result.purpose).toBe('RAR archive');
  });

  test('an oversize text file is analyzed from its head instead of failing as too large', async () => {
    fs.mkdirSync('/big', { recursive: true });
    fs.writeFileSync('/big/notes.txt', 'x'.repeat(64)); // limit mocked to 16 bytes
    extractors.readTextFileWithEncoding.mockResolvedValue('head of the file text');

    const result = await analyzeDocumentFile('/big/notes.txt', [], { bypassCache: true });

    expect(extractors.readTextFileWithEncoding).toHaveBeenCalledWith('/big/notes.txt', {
      maxBytes: 16
    });
    expect(documentLlm.analyzeTextWithLlama).toHaveBeenCalled();
    expect(result.extractionMethod).toBe('content');
    expect(result.partialContent).toBe(true);
  });

  test('a text file within the limit is read whole', async () => {
    fs.mkdirSync('/small', { recursive: true });
    fs.writeFileSync('/small/notes.txt', 'short');
    extractors.readTextFileWithEncoding.mockResolvedValue('short note content here');

    const result = await analyzeDocumentFile('/small/notes.txt', [], { bypassCache: true });

    expect(extractors.readTextFileWithEncoding).toHaveBeenCalledWith('/small/notes.txt');
    expect(result.partialContent).toBe(false);
  });
});
