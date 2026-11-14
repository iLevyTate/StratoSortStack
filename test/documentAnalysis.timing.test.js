/**
 * @jest-environment node
 *
 * Each analyzed document logs one '[ANALYSIS-TIMING]' line with how long each
 * stage took (reading the file, finding similar names, the AI model, folder
 * matching), so "where do the 27 seconds per file go" has an answer. The line
 * carries the extension and sizes only: no file name, no content.
 */
const fs = require('fs').promises;

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  setContext: jest.fn()
};
jest.mock('../src/shared/logger', () => ({ createLogger: jest.fn(() => mockLogger) }));

jest.mock('../src/main/analysis/documentExtractors', () => ({
  extractTextFromPdfRaw: jest.fn(),
  ocrPdfIfNeededRaw: jest.fn(),
  extractTextFromPdf: jest.fn(),
  ocrPdfIfNeeded: jest.fn(),
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
  AppConfig: { ai: { textAnalysis: { defaultModel: 'mock-model' } } }
}));

jest.mock('../src/main/llamaUtils', () => ({
  getTextModel: jest.fn(() => 'mock-model'),
  getLlamaService: jest.fn(() => null),
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
    generateKey: jest.fn(() => 'mock-key'),
    deduplicate: jest.fn(async (_key, fn) => fn())
  }
}));

function timingLines() {
  return mockLogger.info.mock.calls.filter(([msg]) => msg === '[ANALYSIS-TIMING]');
}

describe('documentAnalysis stage timing', () => {
  let analyzeDocumentFile;
  let extractors;
  let documentLlm;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(fs, 'stat').mockResolvedValue({
      size: 4096,
      mtimeMs: 1600000000000,
      mtime: new Date(1600000000000),
      isFile: () => true
    });
    jest.spyOn(fs, 'access').mockResolvedValue(undefined);
    analyzeDocumentFile = require('../src/main/analysis/documentAnalysis').analyzeDocumentFile;
    extractors = require('../src/main/analysis/documentExtractors');
    documentLlm = require('../src/main/analysis/documentLlm');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('a fresh analysis logs every stage, then a repeat logs a file-cache hit', async () => {
    extractors.extractTextFromCsv.mockResolvedValue('Columns: Query | Clicks\nseo 12');
    documentLlm.analyzeTextWithLlama.mockResolvedValue({
      category: 'GSC',
      confidence: 80,
      keywords: ['seo']
    });
    const folders = [{ name: 'GSC', description: 'Search Console' }];

    await analyzeDocumentFile('/exports/secret-client-report.csv', folders);

    const [first] = timingLines();
    expect(first).toBeDefined();
    const data = first[1];
    expect(data).toEqual(
      expect.objectContaining({
        ext: '.csv',
        sizeKB: 4,
        chars: 'Columns: Query | Clicks\nseo 12'.length,
        cache: 'miss',
        outcome: 'ok'
      })
    );
    for (const key of ['extractMs', 'namingMs', 'llmMs', 'matchMs', 'totalMs']) {
      expect(typeof data[key]).toBe('number');
      expect(data[key]).toBeGreaterThanOrEqual(0);
    }
    expect(JSON.stringify(data)).not.toContain('secret-client-report');
    expect(JSON.stringify(data)).not.toContain('Query');

    mockLogger.info.mockClear();
    await analyzeDocumentFile('/exports/secret-client-report.csv', folders);
    const [second] = timingLines();
    expect(second[1]).toEqual(expect.objectContaining({ cache: 'file-hit', ext: '.csv' }));
    expect(documentLlm.analyzeTextWithLlama).toHaveBeenCalledTimes(1);
  });

  test('a failed AI step is logged as a fallback', async () => {
    extractors.extractTextFromCsv.mockResolvedValue('a,b\n1,2');
    documentLlm.analyzeTextWithLlama.mockResolvedValue({ error: 'timed out', keywords: [] });

    await analyzeDocumentFile('/exports/other.csv', []);

    const [line] = timingLines();
    expect(line[1]).toEqual(expect.objectContaining({ outcome: 'fallback', cache: 'miss' }));
    expect(typeof line[1].llmMs).toBe('number');
  });
});
