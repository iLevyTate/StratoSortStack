/**
 * Needs-review routing (routingDecision.js).
 *
 * A Markdown report about local AI models was suggested into an "SEO data"
 * folder: every ranked candidate clears a 0.4 semantic floor, so a file that
 * fits no folder still went to whichever folder came out on top. A file now
 * goes to a Smart Folder only on a confident match (a learned pattern, a
 * content score of 0.55 or more that no other folder comes within 0.03 of,
 * or a name the file carries outright). Otherwise it needs review: it goes
 * to the default folder, or stays unassigned when there is none.
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
const {
  CONFIDENT_CONTENT_SCORE,
  AMBIGUOUS_MARGIN
} = require('../src/main/services/organization/routingDecision');

jest.setTimeout(30000);

const SEO_DATA = {
  id: 'seo-data',
  name: 'SEO data',
  path: '/Users/alex/Library/SEO data',
  description: 'Keyword rankings and search traffic exports.'
};
const SEO_AUDITS = {
  id: 'seo-audits',
  name: 'SEO audits',
  path: '/Users/alex/Library/SEO audits',
  description: 'PDF SEO audit reports with site scores, backlinks and recommendations.'
};
const INVOICES = {
  id: 'invoices',
  name: 'Invoices',
  path: '/Users/alex/Library/Invoices',
  description: 'Invoices and receipts from vendors.'
};
const RECEIPTS = {
  id: 'receipts',
  name: 'Receipts',
  path: '/Users/alex/Library/Receipts',
  description: 'Store and card receipts.'
};
const PRINTS = {
  id: 'prints',
  name: '3D Prints',
  path: '/Users/alex/Library/3D Prints',
  description: 'Models to print.',
  keywords: ['stl']
};
const UNCATEGORIZED = {
  id: 'uncategorized',
  name: 'Uncategorized',
  path: '/Users/alex/Library/Uncategorized',
  isDefault: true
};

const FOLDERS = [SEO_DATA, SEO_AUDITS, INVOICES, RECEIPTS, PRINTS, UNCATEGORIZED];
const FOLDERS_NO_DEFAULT = FOLDERS.filter((f) => f !== UNCATEGORIZED);

/** @param {{ id: string, name: string, path: string }} folder @param {number} score */
const match = (folder, score) => ({
  folderId: folder.id,
  name: folder.name,
  path: folder.path,
  score
});

/** The report from the original case: a Markdown file about local AI. */
function localAiReport(overrides = {}) {
  return {
    name: 'state-of-local-ai.md',
    extension: 'md',
    path: '/Users/alex/Downloads/state-of-local-ai.md',
    analysis: {
      // The analysis model is told to answer with a folder name, so it named one.
      category: 'SEO data',
      date: '2026-10-01',
      time_period: '2026',
      keywords: ['local models', 'inference', 'privacy'],
      purpose: 'Survey of running language models on your own computer',
      confidence: 70
    },
    ...overrides
  };
}

function makeService({ folderMatches = [], mode = 'embedding' } = {}) {
  const vectorDb = {
    initialize: jest.fn().mockResolvedValue(true),
    isServerAvailable: jest.fn().mockResolvedValue(true),
    getStats: jest.fn().mockResolvedValue({ files: 120, fileChunks: 0, folders: 6 }),
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
    load: jest.fn().mockResolvedValue({ smartFolderRoutingMode: mode }),
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

/** The options the Organize grid ranks with (useOrganizeSuggestions). */
const INTERACTIVE = {
  skipSmartFolderEmbeddings: true,
  skipGeneration: true,
  skipImprovementCandidates: true,
  includeStructureAnalysis: false
};

const suggest = (service, file, folders = FOLDERS, mode = 'embedding') =>
  service.getSuggestionsForFile(file, folders, { ...INTERACTIVE, routingModeOverride: mode });

describe('thresholds', () => {
  test('come from the analysis step scale', () => {
    expect(CONFIDENT_CONTENT_SCORE).toBe(0.55);
    expect(AMBIGUOUS_MARGIN).toBe(0.03);
  });
});

describe('a file that fits no folder', () => {
  test('an unrelated Markdown report is not routed by a 0.4-level match', async () => {
    const service = makeService({
      folderMatches: [match(SEO_AUDITS, 0.45), match(SEO_DATA, 0.42)]
    });
    const result = await suggest(service, localAiReport());

    expect(result.success).toBe(true);
    expect(result.needsReview).toBe(true);
    expect(result.routingDecision.reason).toBe('weak_match');
    expect(result.primary.folder).toBe('Uncategorized');
    expect(result.primary.needsReview).toBe(true);
    expect(result.explanation).toBe(
      'No Smart Folder matched this file well. The closest was "SEO audits".'
    );
    // Still listed, so the user can pick one by hand.
    expect(result.alternatives.map((s) => s.folder)).toEqual(
      expect.arrayContaining(['SEO audits', 'SEO data'])
    );
    // Not a confidence anyone could auto-move on.
    expect(result.confidence).toBeLessThan(0.3);
  });

  test('stays unassigned when there is no default folder', async () => {
    const service = makeService({
      folderMatches: [match(SEO_AUDITS, 0.45), match(SEO_DATA, 0.42)]
    });
    const result = await suggest(service, localAiReport(), FOLDERS_NO_DEFAULT);

    expect(result.success).toBe(true);
    expect(result.needsReview).toBe(true);
    expect(result.primary).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.alternatives.map((s) => s.folder)).toContain('SEO audits');
  });

  test('just below the confident score needs review; at it, the file routes', async () => {
    const below = makeService({ folderMatches: [match(INVOICES, 0.54)] });
    const at = makeService({ folderMatches: [match(INVOICES, 0.55)] });
    const file = localAiReport({ analysis: { category: 'Invoices', confidence: 80 } });

    expect((await suggest(below, file)).needsReview).toBe(true);
    const routed = await suggest(at, file);
    expect(routed.needsReview).toBe(false);
    expect(routed.primary.folder).toBe('Invoices');
  });

  test('the date template does not choose the folder or the explanation', async () => {
    // A date and a time period scored the date template 0.6, and with no
    // label its folder was its own default, Uncategorized, explained as
    // "Using Date-Based organization method".
    const service = makeService();
    const file = localAiReport({
      analysis: { date: '2026-10-01', time_period: '2026', confidence: 70 }
    });
    const result = await suggest(service, file);

    expect(result.needsReview).toBe(true);
    expect(result.routingDecision.reason).toBe('no_match');
    expect(result.explanation).toBe('No Smart Folder matched this file.');
    expect(result.explanation).not.toMatch(/Date-Based/);
    const sources = [result.primary, ...result.alternatives].map((s) => s?.source);
    expect(sources).not.toContain('strategy');
  });
});

describe('an empty file or a failed extraction', () => {
  test('a filename guess does not route the file, even in LLM routing', async () => {
    const service = makeService({ mode: 'llm' });
    const file = {
      name: 'invoice-scan.pdf',
      extension: 'pdf',
      path: '/Users/alex/Downloads/invoice-scan.pdf',
      analysis: {
        category: 'Invoices',
        isFallback: true,
        extractionMethod: 'filename',
        confidence: 30
      }
    };
    const result = await suggest(service, file, FOLDERS, 'llm');

    expect(result.needsReview).toBe(true);
    expect(result.primary.folder).toBe('Uncategorized');
    expect(result.explanation).toBe(
      'No Smart Folder matched this file well. The closest was "Invoices".'
    );
  });

  test('an empty file with no analysis fields needs review', async () => {
    const service = makeService();
    const file = {
      name: 'empty.txt',
      extension: 'txt',
      path: '/Users/alex/Downloads/empty.txt',
      analysis: { isFallback: true, extractionMethod: 'empty', confidence: 0 }
    };
    const result = await suggest(service, file);

    expect(result.needsReview).toBe(true);
    expect(result.routingDecision.reason).toBe('no_match');
    expect(result.primary.folder).toBe('Uncategorized');
  });
});

describe('a file that fits two folders equally', () => {
  test('is ambiguous and says which two', async () => {
    const service = makeService({
      folderMatches: [match(SEO_DATA, 0.66), match(SEO_AUDITS, 0.65)]
    });
    const result = await suggest(service, localAiReport());

    expect(result.needsReview).toBe(true);
    expect(result.routingDecision.reason).toBe('ambiguous');
    expect(result.primary.folder).toBe('Uncategorized');
    expect(result.explanation).toBe('"SEO data" and "SEO audits" matched this file about equally.');
  });

  test('a clear gap between the two is not ambiguous', async () => {
    const service = makeService({
      folderMatches: [match(SEO_DATA, 0.66), match(SEO_AUDITS, 0.62)]
    });
    const result = await suggest(service, localAiReport());

    expect(result.needsReview).toBe(false);
    expect(result.primary.folder).toBe('SEO data');
  });
});

describe('confident matches route as before', () => {
  test('a strong content match goes to its folder with its own explanation', async () => {
    const service = makeService({
      folderMatches: [match(INVOICES, 0.72), match(RECEIPTS, 0.5)]
    });
    const file = {
      name: 'march-invoice.pdf',
      extension: 'pdf',
      path: '/Users/alex/Downloads/march-invoice.pdf',
      analysis: { category: 'Invoices', date: '2026-03-02', confidence: 90 }
    };
    const result = await suggest(service, file);

    expect(result.needsReview).toBe(false);
    expect(result.routingDecision.basis).toBe('content_match');
    expect(result.primary.folder).toBe('Invoices');
    expect(result.confidence).toBe(0.72);
    expect(result.explanation).toBe('This file\'s meaning matches "Invoices"');
  });

  test('a learned pattern routes a file whose content match is weak', async () => {
    const service = makeService({ folderMatches: [match(SEO_DATA, 0.42)] });
    const file = localAiReport();
    const suggestion = { folder: SEO_DATA.name, path: SEO_DATA.path };
    service.userPatterns.set(service.patternMatcher.extractPattern(file, suggestion), {
      ...suggestion,
      count: 4,
      confidence: 0.8,
      lastUsed: Date.now()
    });
    const result = await suggest(service, file);

    expect(result.needsReview).toBe(false);
    expect(result.routingDecision.basis).toBe('learned');
    expect(result.primary.folder).toBe('SEO data');
  });

  test('LLM routing still sends a label that names a folder there', async () => {
    const service = makeService({ mode: 'llm' });
    const file = {
      name: 'march-invoice.pdf',
      extension: 'pdf',
      path: '/Users/alex/Downloads/march-invoice.pdf',
      analysis: { category: 'Invoices', confidence: 90 }
    };
    const result = await suggest(service, file, FOLDERS, 'llm');

    expect(result.needsReview).toBe(false);
    expect(result.routingDecision.basis).toBe('name_match');
    expect(result.primary.folder).toBe('Invoices');
  });

  test('a folder that claims the extension takes it, below the auto-move threshold', async () => {
    const service = makeService();
    const file = {
      name: 'bracket.stl',
      extension: 'stl',
      path: '/Users/alex/Downloads/bracket.stl',
      analysis: { category: 'Uncategorized', confidence: 90 }
    };
    const result = await suggest(service, file);

    expect(result.needsReview).toBe(false);
    expect(result.primary.folder).toBe('3D Prints');
    expect(result.explanation).toBe('"3D Prints" is the folder for STL files');
    expect(result.confidence).toBeLessThan(0.75);
  });
});

describe('getBatchSuggestions', () => {
  test('lists unassigned files and flags review files in their group', async () => {
    const service = makeService({
      folderMatches: [match(SEO_AUDITS, 0.45), match(SEO_DATA, 0.42)]
    });
    const withDefault = await service.getBatchSuggestions([localAiReport()], FOLDERS, {
      ...INTERACTIVE
    });
    const entry = withDefault.groups.flatMap((g) => g.files)[0];
    expect(entry.needsReview).toBe(true);
    expect(entry.suggestion.folder).toBe('Uncategorized');
    expect(withDefault.unassigned).toEqual([]);

    const noDefault = await service.getBatchSuggestions([localAiReport()], FOLDERS_NO_DEFAULT, {
      ...INTERACTIVE
    });
    expect(noDefault.groups).toEqual([]);
    expect(noDefault.unassigned).toHaveLength(1);
    expect(noDefault.unassigned[0]).toMatchObject({
      path: '/Users/alex/Downloads/state-of-local-ai.md',
      suggestion: null,
      needsReview: true,
      explanation: 'No Smart Folder matched this file well. The closest was "SEO audits".'
    });
  });
});
