/**
 * Interactive destination ranking (D1).
 *
 * The Organize grid ranks every ready file's destination through the
 * suggestion engine. In LLM routing mode that used to mean one text
 * generation per file (minutes for a batch of 50), and folder-improvement
 * candidates scored on name overlap could outrank a semantic match.
 * `skipGeneration` and `skipImprovementCandidates` turn both off.
 */

const mockLlamaService = {
  initialize: jest.fn().mockResolvedValue(undefined),
  getConfig: jest.fn().mockReturnValue({ textModel: 'test-model.gguf' }),
  generateText: jest.fn()
};

jest.mock('../src/main/services/LlamaService', () => ({
  getInstance: () => mockLlamaService
}));
jest.mock('../src/main/services/PerformanceService', () => ({
  getRecommendedConcurrency: jest.fn().mockResolvedValue({
    maxConcurrent: 1,
    embeddingConcurrency: 3
  })
}));

const OrganizationSuggestionService = require('../src/main/services/organization');

jest.setTimeout(30000);

const SMART_FOLDERS = [
  {
    id: 'folder-1',
    name: 'Invoices',
    path: '/docs/Invoices',
    description: 'Financial invoices and receipts',
    keywords: ['invoice', 'receipt', 'payment']
  },
  {
    id: 'folder-2',
    name: 'Projects',
    path: '/docs/Projects',
    description: 'Active project files',
    keywords: ['project', 'work', 'development']
  }
];

function makeFile(overrides = {}) {
  return {
    name: 'march-invoice.pdf',
    extension: 'pdf',
    path: '/downloads/march-invoice.pdf',
    analysis: {
      category: 'Invoices',
      keywords: ['invoice', 'payment'],
      purpose: 'Invoice for March services',
      confidence: 90
    },
    ...overrides
  };
}

function makeService(routingMode) {
  const vectorDb = {
    initialize: jest.fn().mockResolvedValue(true),
    isServerAvailable: jest.fn().mockResolvedValue(true),
    getStats: jest.fn().mockResolvedValue({ files: 120, fileChunks: 0, folders: 2 }),
    upsertFolder: jest.fn().mockResolvedValue({ success: true }),
    upsertFile: jest.fn().mockResolvedValue({ success: true }),
    queryFeedbackMemory: jest.fn().mockResolvedValue([]),
    queryFolders: jest.fn().mockResolvedValue([]),
    queryFiles: jest.fn().mockResolvedValue([])
  };
  const folderMatching = {
    upsertFolderEmbedding: jest.fn().mockResolvedValue({ success: true }),
    upsertFileEmbedding: jest.fn().mockResolvedValue({ success: true }),
    matchVectorToFolders: jest.fn().mockResolvedValue([]),
    matchFileToFolders: jest.fn().mockResolvedValue([]),
    embedText: jest.fn().mockResolvedValue({ vector: new Array(1024).fill(0.1) })
  };
  const settings = {
    get: jest.fn(() => null),
    load: jest.fn().mockResolvedValue({ smartFolderRoutingMode: routingMode }),
    save: jest.fn().mockResolvedValue({ success: true })
  };
  const service = new OrganizationSuggestionService({
    vectorDbService: vectorDb,
    folderMatchingService: folderMatching,
    settingsService: settings
  });
  service.userPatterns = new Map();
  service.feedbackHistory = [];
  service.folderUsageStats = new Map();
  return service;
}

beforeEach(() => {
  mockLlamaService.generateText.mockReset().mockResolvedValue({
    response: JSON.stringify({
      suggestions: [{ folder: 'Projects', reasoning: 'guess', confidence: 0.9 }]
    })
  });
});

describe('getSuggestionsForFile with skipGeneration', () => {
  test('LLM routing mode generates text per file without it', async () => {
    const service = makeService('llm');
    await service.getSuggestionsForFile(makeFile(), SMART_FOLDERS, {
      includeStructureAnalysis: false
    });
    expect(mockLlamaService.generateText).toHaveBeenCalled();
  });

  test('LLM routing mode makes no text generation call with it', async () => {
    const service = makeService('llm');
    const result = await service.getSuggestionsForFile(makeFile(), SMART_FOLDERS, {
      includeStructureAnalysis: false,
      skipGeneration: true
    });
    expect(mockLlamaService.generateText).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    // The analysis-time label still ranks: it costs no inference.
    expect(result.primary?.folder).toBe('Invoices');
    expect(typeof result.explanation).toBe('string');
  });
});

describe('skipImprovementCandidates', () => {
  test('keeps folder-improvement candidates out of the ranking', async () => {
    const service = makeService('embedding');
    const spy = jest.spyOn(service, 'getImprovementSuggestions').mockResolvedValue([
      {
        folder: 'Projects',
        path: '/docs/Projects',
        score: 0.9,
        confidence: 0.9,
        method: 'folder_improvement'
      }
    ]);

    const withCandidates = await service.getSuggestionsForFile(makeFile(), SMART_FOLDERS, {
      includeStructureAnalysis: false,
      skipGeneration: true
    });
    const sources = [withCandidates.primary, ...withCandidates.alternatives].map((s) => s?.source);
    expect(sources).toContain('improvement');

    spy.mockClear();
    const without = await service.getSuggestionsForFile(makeFile(), SMART_FOLDERS, {
      includeStructureAnalysis: false,
      skipGeneration: true,
      skipImprovementCandidates: true
    });
    expect(spy).not.toHaveBeenCalled();
    const withoutSources = [without.primary, ...without.alternatives].map((s) => s?.source);
    expect(withoutSources).not.toContain('improvement');
  });
});

describe('getBatchSuggestions entries', () => {
  test('carry the explanation and make no generation call with skipGeneration', async () => {
    const service = makeService('llm');
    const result = await service.getBatchSuggestions([makeFile()], SMART_FOLDERS, {
      includeStructureAnalysis: false,
      skipGeneration: true,
      skipImprovementCandidates: true
    });
    expect(result.success).toBe(true);
    expect(mockLlamaService.generateText).not.toHaveBeenCalled();
    const entry = result.groups.flatMap((g) => g.files)[0];
    expect(entry.path).toBe('/downloads/march-invoice.pdf');
    expect(entry.suggestion.folder).toBe('Invoices');
    expect(typeof entry.explanation).toBe('string');
    expect(entry.explanation.length).toBeGreaterThan(0);
  });
});
