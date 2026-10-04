/**
 * @jest-environment node
 *
 * PRIVACY.md promises that the logs a user can export from Diagnostics never
 * carry the contents of the files they analyzed. The model's purpose,
 * project, entity, summary, keywords and suggested name all paraphrase the
 * document, so the per-file "analyzed" lines in the three analysis modules
 * must log shape only (category, confidence, counts, booleans), never those
 * values. Each path is driven with sentinel strings in the content-derived
 * fields and every logger call at every level is checked for them.
 */
const fs = require('fs').promises;

jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

jest.mock('sharp', () =>
  jest.fn(() => ({
    metadata: jest.fn().mockResolvedValue({ width: 100, height: 100, format: 'png' }),
    rotate: jest.fn().mockReturnThis(),
    resize: jest.fn().mockReturnThis(),
    png: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(Buffer.from('processed-image'))
  }))
);

const mockLlamaService = {
  _initialized: true,
  initialize: jest.fn().mockResolvedValue(undefined),
  getConfig: jest.fn().mockResolvedValue({
    textModel: 'test-text-model',
    visionModel: 'test-vision-model'
  }),
  listModels: jest
    .fn()
    .mockResolvedValue([{ name: 'test-text-model' }, { name: 'test-vision-model' }]),
  testConnection: jest.fn().mockResolvedValue({ success: true }),
  updateConfig: jest.fn().mockResolvedValue(undefined),
  generateText: jest.fn(),
  analyzeImage: jest.fn(),
  supportsVisionInput: jest.fn().mockResolvedValue(true),
  _shouldUseConservativeVisionProfile: jest.fn(() => false)
};

jest.mock('../src/main/services/LlamaService', () => ({
  getInstance: jest.fn(() => mockLlamaService)
}));

jest.mock('../src/main/llamaUtils', () => ({
  getTextModel: jest.fn(() => 'test-text-model'),
  getLlamaService: jest.fn(() => mockLlamaService),
  loadLlamaConfig: jest.fn(async () => ({ selectedTextModel: 'test-text-model' })),
  ensureTextModelReadyForAnalysis: jest.fn(async () => ({ ok: true, model: 'test-text-model' }))
}));

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

// documentAnalysis is driven with the LLM module mocked so its own log line
// is exercised with a known analysis object; the real documentLlm is loaded
// separately below with jest.requireActual.
jest.mock('../src/main/analysis/documentLlm', () => ({
  analyzeTextWithLlama: jest.fn(),
  normalizeCategoryToSmartFolders: jest.fn((cat) => cat),
  AppConfig: { ai: { textAnalysis: { defaultModel: 'test-text-model', timeout: 30000 } } }
}));

jest.mock('../src/main/services/FolderMatchingService', () => ({
  matchCategoryToFolder: jest.fn((cat) => cat),
  matchCategoryToFolderWithSuggestion: jest.fn((cat) => ({
    folder: cat,
    suggestedNewFolder: null,
    source: 'matched'
  }))
}));

jest.mock('../src/main/analysis/organizationGuidance', () => ({
  getOrganizationGuidance: jest.fn(async () => null),
  formatOrganizationGuidanceBlock: jest.fn(() => '')
}));

jest.mock('../src/main/services/AnalysisCacheService', () => {
  const textCache = {
    generateKey: jest.fn(() => 'text-cache-key'),
    get: jest.fn(),
    set: jest.fn()
  };
  const imageCache = { get: jest.fn(), set: jest.fn(), clear: jest.fn() };
  return {
    getInstance: jest.fn(() => textCache),
    getImageAnalysisCache: jest.fn(() => imageCache)
  };
});

jest.mock('../src/main/services/ServiceContainer', () => ({
  container: { tryResolve: jest.fn(() => null) },
  ServiceIds: { SEARCH_SERVICE: 'searchService' }
}));

jest.mock('../src/main/analysis/semanticFolderMatcher', () => ({
  applySemanticFolderMatching: jest.fn(async () => undefined),
  getServices: jest.fn(() => ({ matcher: null })),
  resetSingletons: jest.fn()
}));

jest.mock('../src/main/analysis/embeddingQueue/stageQueues', () => ({
  analysisQueue: { add: jest.fn(), enqueue: jest.fn() }
}));

jest.mock('../src/main/analysis/embeddingQueue/queueManager', () => ({
  removeByFilePath: jest.fn()
}));

jest.mock('../src/main/services/embedding/embeddingGate', () => ({
  shouldEmbed: jest.fn(async () => ({ shouldEmbed: false, policy: 'off', timing: 'skip' }))
}));

jest.mock('../src/shared/folderUtils', () => ({
  findContainingSmartFolder: jest.fn(() => null)
}));

jest.mock('../src/main/utils/tesseractUtils', () => ({
  recognizeIfAvailable: jest.fn(async () => ({ success: false, text: '' }))
}));

jest.mock('../src/main/utils/llmJsonRepair', () => ({
  attemptJsonRepairWithLlama: jest.fn(async () => null),
  attemptProseExtractionWithLlama: jest.fn(async () => null)
}));

jest.mock('../src/main/utils/llmOptimization', () => ({
  globalDeduplicator: {
    generateKey: jest.fn(() => 'dedup-key'),
    deduplicate: jest.fn(async (key, fn) => fn())
  }
}));

const { logger } = require('../src/shared/logger');

// Unique tokens that cannot collide with anything a log line legitimately
// carries (file names, categories, model names, counts).
const SENTINEL = {
  purpose: 'SENTINEL-PURPOSE-c4f1',
  project: 'SENTINEL-PROJECT-c4f1',
  entity: 'SENTINEL-ENTITY-c4f1',
  summary: 'SENTINEL-SUMMARY-c4f1',
  reasoning: 'SENTINEL-REASONING-c4f1',
  keyword: 'SENTINEL-KEYWORD-c4f1',
  suggestedName: 'SENTINEL-NAME-c4f1'
};
const SENTINEL_VALUES = Object.values(SENTINEL);

const SMART_FOLDERS = [
  { name: 'Financial', description: 'Financial documents' },
  { name: 'Photos', description: 'Pictures' },
  { name: 'Uncategorized', description: 'Everything else' }
];

/** The model's answer with every content-derived field set to a sentinel. */
function sentinelAnalysis(category) {
  return {
    category,
    type: 'report',
    purpose: SENTINEL.purpose,
    project: SENTINEL.project,
    entity: SENTINEL.entity,
    summary: SENTINEL.summary,
    reasoning: SENTINEL.reasoning,
    keywords: [SENTINEL.keyword, `${SENTINEL.keyword}-2`],
    suggestedName: SENTINEL.suggestedName,
    date: '2024-03-01',
    confidence: 88
  };
}

function serialize(value) {
  try {
    return JSON.stringify(value, (_key, v) => (v instanceof Error ? v.message : v));
  } catch {
    return String(value);
  }
}

/** Every argument of every logger call at every level, serialized. */
function allLoggedText() {
  return ['info', 'warn', 'error', 'debug']
    .flatMap((level) => logger[level].mock.calls)
    .map((args) => serialize(args))
    .join('\n');
}

function expectNoSentinelLogged() {
  const logged = allLoggedText();
  for (const sentinel of SENTINEL_VALUES) {
    expect(logged).not.toContain(sentinel);
  }
}

function findLogPayload(level, message) {
  const call = logger[level].mock.calls.find((args) => args[0] === message);
  return call ? call[1] : undefined;
}

describe('analysis logs carry no document content', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(fs, 'stat').mockResolvedValue({
      size: 1024,
      mtimeMs: 1600000000000,
      mtime: new Date(1600000000000),
      isFile: () => true
    });
    jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('image-bytes'));
    jest.spyOn(fs, 'access').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('[AI-ANALYSIS-SUCCESS] Document analyzed logs shape only', async () => {
    const { analyzeDocumentFile } = require('../src/main/analysis/documentAnalysis');
    const extractors = require('../src/main/analysis/documentExtractors');
    const documentLlm = require('../src/main/analysis/documentLlm');
    extractors.extractTextFromPdf.mockResolvedValue('Quarterly figures, page one.');
    documentLlm.analyzeTextWithLlama.mockResolvedValue(sentinelAnalysis('Financial'));

    const result = await analyzeDocumentFile('report.pdf', SMART_FOLDERS);

    // The result itself still carries the content; only the log must not.
    expect(result.purpose).toBe(SENTINEL.purpose);
    const payload = findLogPayload('info', '[AI-ANALYSIS-SUCCESS] Document analyzed');
    expect(payload).toEqual(
      expect.objectContaining({
        fileName: 'report.pdf',
        category: 'Financial',
        confidence: 88,
        keywordCount: 2,
        hasDate: true,
        hasSuggestedName: true,
        extractionMethod: 'content'
      })
    );
    expectNoSentinelLogged();
  });

  test('[AI-ANALYSIS-SUCCESS] Image analyzed logs shape only', async () => {
    const { analyzeImageFile, resetSingletons } = require('../src/main/analysis/imageAnalysis');
    resetSingletons();
    mockLlamaService.analyzeImage.mockResolvedValue({
      response: JSON.stringify({ ...sentinelAnalysis('Photos'), has_text: false })
    });

    const result = await analyzeImageFile('/pictures/holiday.png', SMART_FOLDERS);

    expect(result.isFallback).toBeFalsy();
    expect(result.purpose).toBe(SENTINEL.purpose);
    const payload = findLogPayload('info', '[AI-ANALYSIS-SUCCESS] Image analyzed');
    expect(payload).toEqual(
      expect.objectContaining({
        fileName: 'holiday.png',
        category: 'Photos',
        confidence: 88,
        keywordCount: 2,
        hasDate: true,
        hasSuggestedName: true,
        extractionMethod: 'vision'
      })
    );
    expectNoSentinelLogged();
  });

  test('[DocumentLLM] Analysis complete logs shape only', async () => {
    const { analyzeTextWithLlama } = jest.requireActual('../src/main/analysis/documentLlm');
    mockLlamaService.generateText.mockResolvedValue({
      response: JSON.stringify(sentinelAnalysis('Financial'))
    });

    const result = await analyzeTextWithLlama(
      'Quarterly figures, page one.',
      'report.pdf',
      SMART_FOLDERS
    );

    expect(result.purpose).toBe(SENTINEL.purpose);
    const payload = findLogPayload('info', '[DocumentLLM] Analysis complete');
    expect(payload).toEqual(
      expect.objectContaining({
        fileName: 'report.pdf',
        extraction: expect.objectContaining({
          category: 'Financial',
          confidence: 88,
          keywordCount: 2,
          hasDate: true,
          hasSuggestedName: true
        })
      })
    );
    expectNoSentinelLogged();
  });
});
