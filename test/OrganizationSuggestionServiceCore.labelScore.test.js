/**
 * Nearly every file showed exactly 60% (retest item 7). The date-based
 * strategy template scored 0.3 for a date plus 0.3 for the analysis label
 * and named its folder after that label, so the label reached the ranking at
 * 0.6 even in embedding mode, where the label is deliberately left out.
 *
 * Also: auto-organize must not move a file into a folder only because that
 * folder "could be enhanced" for it.
 */

const mockLlamaService = {
  initialize: jest.fn().mockResolvedValue(undefined),
  getConfig: jest.fn().mockReturnValue({ textModel: 'test-model.gguf' }),
  generateText: jest.fn().mockResolvedValue({ response: '{"suggestions":[]}' })
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
  },
  {
    id: 'u',
    name: 'Uncategorized',
    path: '/docs/Uncategorized',
    isDefault: true
  }
];

function makeFile() {
  return {
    name: 'march-invoice.pdf',
    extension: 'pdf',
    path: '/downloads/march-invoice.pdf',
    analysis: {
      category: 'Invoices',
      date: '2026-09-03',
      keywords: ['invoice', 'payment'],
      purpose: 'Invoice for March services',
      confidence: 90
    }
  };
}

function makeService(folderMatches = []) {
  const vectorDb = {
    initialize: jest.fn().mockResolvedValue(true),
    isServerAvailable: jest.fn().mockResolvedValue(true),
    getStats: jest.fn().mockResolvedValue({ files: 120, fileChunks: 0, folders: 3 }),
    upsertFolder: jest.fn().mockResolvedValue({ success: true }),
    upsertFile: jest.fn().mockResolvedValue({ success: true }),
    queryFeedbackMemory: jest.fn().mockResolvedValue([]),
    queryFolders: jest.fn().mockResolvedValue([]),
    queryFiles: jest.fn().mockResolvedValue([])
  };
  const folderMatching = {
    upsertFolderEmbedding: jest.fn().mockResolvedValue({ success: true }),
    upsertFileEmbedding: jest.fn().mockResolvedValue({ success: true }),
    matchVectorToFolders: jest.fn().mockResolvedValue(folderMatches),
    matchFileToFolders: jest.fn().mockResolvedValue([]),
    embedText: jest.fn().mockResolvedValue({ vector: new Array(1024).fill(0.1) })
  };
  const settings = {
    get: jest.fn(() => null),
    load: jest.fn().mockResolvedValue({ smartFolderRoutingMode: 'embedding' }),
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

const INTERACTIVE = {
  routingModeOverride: 'embedding',
  skipSmartFolderEmbeddings: true,
  skipGeneration: true,
  skipImprovementCandidates: true,
  includeStructureAnalysis: false
};

describe('the analysis label does not reach embedding ranking through a strategy', () => {
  test('with no content match the file goes to the catch-all and says why', async () => {
    const service = makeService([]);
    const result = await service.getSuggestionsForFile(makeFile(), SMART_FOLDERS, INTERACTIVE);

    expect(result.primary.folder).toBe('Uncategorized');
    expect(result.primary.source).toBe('default');
    expect(result.explanation).toBe('No Smart Folder matched what this file contains');
    const sources = [result.primary, ...result.alternatives].map((s) => s?.source);
    expect(sources).not.toContain('strategy');
  });

  test('a content match shows its own score, not a flat 60%', async () => {
    const service = makeService([
      { folderId: 'folder-1', name: 'Invoices', path: '/docs/Invoices', score: 0.52 }
    ]);
    const result = await service.getSuggestionsForFile(makeFile(), SMART_FOLDERS, INTERACTIVE);

    expect(result.primary.folder).toBe('Invoices');
    expect(result.primary.source).toBe('semantic');
    expect(result.confidence).toBe(0.52);
  });

  test('LLM routing still uses the label', async () => {
    const service = makeService([]);
    const result = await service.getSuggestionsForFile(makeFile(), SMART_FOLDERS, {
      ...INTERACTIVE,
      routingModeOverride: 'llm'
    });
    expect(result.primary.folder).toBe('Invoices');
  });
});

describe('folder-improvement candidates', () => {
  test('stay alternatives and never become the primary', async () => {
    const service = makeService([]);
    jest.spyOn(service, 'getImprovementSuggestions').mockResolvedValue([
      {
        folder: 'Projects',
        path: '/docs/Projects',
        score: 0.75,
        confidence: 0.55,
        method: 'folder_improvement'
      }
    ]);
    const result = await service.getSuggestionsForFile(makeFile(), SMART_FOLDERS, {
      ...INTERACTIVE,
      skipImprovementCandidates: false
    });

    expect(result.primary.source).not.toBe('improvement');
    expect(result.primary.folder).toBe('Uncategorized');
    expect(result.alternatives.map((s) => s.source)).toContain('improvement');
    expect(result.confidence).toBeLessThan(0.75);
  });

  test('do not take over a real content match for the same folder', async () => {
    const service = makeService([
      { folderId: 'folder-1', name: 'Invoices', path: '/docs/Invoices', score: 0.55 }
    ]);
    jest.spyOn(service, 'getImprovementSuggestions').mockResolvedValue([
      {
        folder: 'Invoices',
        path: '/docs/Invoices',
        score: 0.65,
        confidence: 0.45,
        method: 'folder_improvement'
      }
    ]);
    const result = await service.getSuggestionsForFile(makeFile(), SMART_FOLDERS, {
      ...INTERACTIVE,
      skipImprovementCandidates: false
    });

    expect(result.primary.folder).toBe('Invoices');
    expect(result.primary.source).toBe('semantic');
    expect(result.confidence).toBe(0.55);
  });
});
