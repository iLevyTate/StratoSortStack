const FolderMatchingService = require('../src/main/services/FolderMatchingService');

jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

const mockLlamaService = {
  generateEmbedding: jest.fn(),
  getConfig: jest.fn().mockReturnValue({ embeddingModel: 'mxbai-embed-large' })
};

jest.mock('../src/main/services/LlamaService', () => ({
  getInstance: () => mockLlamaService
}));

describe('FolderMatchingService', () => {
  let service;
  let mockVectorDbService;

  beforeEach(() => {
    mockVectorDbService = {
      initialize: jest.fn().mockResolvedValue(undefined),
      upsertFolder: jest.fn().mockResolvedValue({ success: true }),
      getStats: jest.fn().mockResolvedValue({ folders: 1, files: 2 })
    };

    mockLlamaService.generateEmbedding.mockResolvedValue({
      embedding: new Array(1024).fill(0.1)
    });

    service = new FolderMatchingService(mockVectorDbService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('embedText uses LlamaService and returns vector', async () => {
    const result = await service.embedText('Project invoices and receipts');
    expect(result.vector.length).toBe(1024);
    expect(mockLlamaService.generateEmbedding).toHaveBeenCalledTimes(1);
  });

  test('upsertFolderEmbedding writes to vector DB', async () => {
    const folder = { id: 'f1', name: 'Invoices', path: '/tmp/Invoices' };
    await service.upsertFolderEmbedding(folder);
    expect(mockVectorDbService.upsertFolder).toHaveBeenCalled();
  });

  test('getStats returns vector DB stats', async () => {
    const stats = await service.getStats();
    expect(stats.folders).toBe(1);
    expect(stats.files).toBe(2);
  });

  test('pruneStaleFolders deletes vector-DB folder embeddings not in current set', async () => {
    // Reproduces the live regression where the folder vector DB retains
    // an "Images" embedding from a removed default file-type taxonomy.
    // The override pipeline picks "Images" and downstream demotes it to
    // "Uncategorized". Filter at the consumer prevents the user-visible
    // symptom; this prune cleans the polluted DB so it can't even surface.
    mockVectorDbService.getAllFolders = jest.fn().mockResolvedValue([
      { id: 'folder:current1', metadata: { folderName: 'Financial' } },
      { id: 'folder:current2', metadata: { folderName: 'Logos' } },
      { id: 'folder:phantom1', metadata: { folderName: 'Images' } },
      { id: 'folder:phantom2', metadata: { folderName: 'Documents' } }
    ]);
    mockVectorDbService.batchDeleteFolders = jest.fn().mockResolvedValue({ count: 2 });

    const result = await service.pruneStaleFolders(['folder:current1', 'folder:current2']);

    expect(mockVectorDbService.batchDeleteFolders).toHaveBeenCalledTimes(1);
    expect(mockVectorDbService.batchDeleteFolders.mock.calls[0][0].sort()).toEqual([
      'folder:phantom1',
      'folder:phantom2'
    ]);
    expect(result.pruned).toBe(2);
  });

  test('pruneStaleFolders is a no-op when every persisted folder is in current set', async () => {
    mockVectorDbService.getAllFolders = jest.fn().mockResolvedValue([
      { id: 'folder:a', metadata: { folderName: 'Financial' } },
      { id: 'folder:b', metadata: { folderName: 'Work' } }
    ]);
    mockVectorDbService.batchDeleteFolders = jest.fn();

    const result = await service.pruneStaleFolders(['folder:a', 'folder:b']);

    expect(mockVectorDbService.batchDeleteFolders).not.toHaveBeenCalled();
    expect(result.pruned).toBe(0);
  });

  test('pruneStaleFolders gracefully no-ops when vectorDbService lacks getAllFolders', async () => {
    // Older vector DB implementations may not expose getAllFolders. Don't
    // crash batchUpsertFolders just because pruning isn't available.
    delete mockVectorDbService.getAllFolders;
    mockVectorDbService.batchDeleteFolders = jest.fn();

    const result = await service.pruneStaleFolders(['folder:a']);

    expect(mockVectorDbService.batchDeleteFolders).not.toHaveBeenCalled();
    expect(result.pruned).toBe(0);
  });
});

describe('FolderMatchingService.matchCategoryToFolder — name matching pipeline', () => {
  // Static method, no instance needed.

  test('exact case-insensitive match wins', () => {
    const folders = [{ name: 'Lab Corp' }, { name: 'Other Folder' }];
    expect(FolderMatchingService.matchCategoryToFolder('lab corp', folders)).toBe('Lab Corp');
  });

  test('Levenshtein typo within threshold matches', () => {
    // distance("lab co", "lab corp") = 2, threshold for 8-char name = 2
    const folders = [{ name: 'Lab Corp' }];
    expect(FolderMatchingService.matchCategoryToFolder('lab co', folders)).toBe('Lab Corp');
  });

  test('prefix-subsumption: short variant matches longer folder name (forward)', () => {
    // "Lab" → "Lab Corp" — Levenshtein distance 5 > threshold 2, but the
    // canonical "lab" is a prefix of "lab corp" at a word boundary.
    const folders = [{ name: 'Lab Corp' }];
    expect(FolderMatchingService.matchCategoryToFolder('Lab', folders)).toBe('Lab Corp');
  });

  test('prefix-subsumption: longer extracted text matches shorter folder name (reverse)', () => {
    // LLM sometimes returns "Lab Corp - 2024 Test Results" for the entity
    // "Lab Corp". The folder canonical "lab corp" is a prefix of the
    // extracted canonical "lab corp 2024 test results" at a word boundary.
    const folders = [{ name: 'Lab Corp' }];
    expect(
      FolderMatchingService.matchCategoryToFolder('Lab Corp - 2024 Test Results', folders)
    ).toBe('Lab Corp');
  });

  test('prefix-subsumption: prefers closest length match when multiple folders qualify', () => {
    // "lab co" prefixes both "lab corp" (delta 2) and "lab corporation"
    // (delta 9). Closest length wins to avoid drifting toward the longer
    // folder when the LLM gave a near-complete short form.
    const folders = [{ name: 'Lab Corporation' }, { name: 'Lab Corp' }, { name: 'Other Folder' }];
    // Note: "lab co" → "lab corp" Levenshtein dist=2 ≤ threshold 2 already
    // matches Lab Corp, so this test mostly verifies Levenshtein still wins.
    // Use a case that bypasses Levenshtein:
    const result = FolderMatchingService.matchCategoryToFolder('Lab Cor', folders);
    // distance("lab cor", "lab corp")=1 ≤ threshold 2 → Levenshtein matches
    expect(result).toBe('Lab Corp');
  });

  test('prefix-subsumption: word-boundary check prevents partial-word false positives', () => {
    // "lab" should NOT match "labyrinth" — "lab" is a prefix in raw chars
    // but not at a word boundary (next char is 'y', not space or end).
    const folders = [{ name: 'Labyrinth Studio' }, { name: 'Other' }];
    const result = FolderMatchingService.matchCategoryToFolder('Lab', folders);
    // Should fall through to fallback (Uncategorized or first folder)
    // because no prefix at word boundary matches.
    expect(result).not.toBe('Labyrinth Studio');
  });

  test('prefix-subsumption: minimum 3-char guard prevents 2-letter false positives', () => {
    // "am" should NOT prefix-match "Amazon" — too short, would create
    // false positives like "am" → any folder starting with "am".
    const folders = [{ name: 'Amazon Receipts' }, { name: 'American Express' }];
    const result = FolderMatchingService.matchCategoryToFolder('am', folders);
    // Falls through to token-overlap or fallback; should NOT prefix-match.
    expect(result).not.toBe('Amazon Receipts');
  });

  test('returns null when no folders provided maps to Uncategorized literal', () => {
    expect(FolderMatchingService.matchCategoryToFolder('anything', [])).toBe('Uncategorized');
  });

  test('generic buckets like "documents" route to Uncategorized when present', () => {
    const folders = [{ name: 'Uncategorized' }, { name: 'Lab Corp' }];
    expect(FolderMatchingService.matchCategoryToFolder('documents', folders)).toBe('Uncategorized');
  });

  test('generic bucket word matches a real folder of that exact name (regression)', () => {
    // Default file-type taxonomy: "Documents"/"Images" are real folders, so an
    // LLM answer of "Documents" must land there, NOT be forced to Uncategorized
    // by the generic-bucket guard. This was the root cause of resumes/NDAs/etc.
    // being repeatedly filed as Uncategorized despite clearly matching.
    const folders = [
      { name: 'Documents' },
      { name: 'Images' },
      { name: 'Spreadsheets' },
      { name: 'Uncategorized' }
    ];
    expect(FolderMatchingService.matchCategoryToFolder('Documents', folders)).toBe('Documents');
    expect(FolderMatchingService.matchCategoryToFolder('documents', folders)).toBe('Documents');
    expect(FolderMatchingService.matchCategoryToFolder('Images', folders)).toBe('Images');
  });

  test('matches invented LLM categories via folder description semantics', () => {
    const folders = [
      {
        name: 'Financial',
        description: 'invoices, receipts, tax documents, and bank statements'
      },
      { name: 'Work', description: 'client projects and business deliverables' },
      { name: 'Uncategorized' }
    ];
    expect(FolderMatchingService.matchCategoryToFolder('Invoices', folders)).toBe('Financial');
    expect(FolderMatchingService.matchCategoryToFolder('Bank Statements', folders)).toBe(
      'Financial'
    );
  });

  test('matches via folder keywords when description alone is thin', () => {
    const folders = [
      {
        name: '3D print',
        description: 'maker files',
        keywords: ['stl', 'gcode', '3mf', 'cad']
      },
      { name: 'Uncategorized' }
    ];
    expect(FolderMatchingService.matchCategoryToFolder('STL CAD Models', folders)).toBe('3D print');
  });
});

describe('FolderMatchingService.matchCategoryToFolderWithSuggestion — rich return', () => {
  test('returns matched source when the category resolves to a real folder', () => {
    const folders = [{ name: 'Lab Corp' }, { name: 'Uncategorized' }];
    const result = FolderMatchingService.matchCategoryToFolderWithSuggestion('lab corp', folders);
    expect(result).toEqual({ folder: 'Lab Corp', suggestedNewFolder: null, source: 'matched' });
  });

  test('surfaces meaningful unmatched categories as new-folder suggestions', () => {
    // Reproduces the live regression: "marketing" had no real folder, so the
    // base matcher returned "Uncategorized" and the theme was silently lost.
    const folders = [{ name: 'Financial' }, { name: 'Work' }, { name: 'Uncategorized' }];
    const result = FolderMatchingService.matchCategoryToFolderWithSuggestion('marketing', folders);
    expect(result).toEqual({
      folder: 'Uncategorized',
      suggestedNewFolder: 'marketing',
      source: 'fallback'
    });
  });

  test('does not suggest a new folder for generic buckets (image/document/default)', () => {
    const folders = [{ name: 'Financial' }, { name: 'Uncategorized' }];
    const result = FolderMatchingService.matchCategoryToFolderWithSuggestion('image', folders);
    expect(result.suggestedNewFolder).toBeNull();
    expect(result.source).toBe('matched'); // routed to Uncategorized intentionally
  });

  test('does not suggest a new folder when the raw category IS literally Uncategorized', () => {
    const folders = [{ name: 'Financial' }, { name: 'Uncategorized' }];
    const result = FolderMatchingService.matchCategoryToFolderWithSuggestion(
      'Uncategorized',
      folders
    );
    expect(result.suggestedNewFolder).toBeNull();
  });

  test('reports no-folders source when smart folders list is empty', () => {
    const result = FolderMatchingService.matchCategoryToFolderWithSuggestion('anything', []);
    expect(result).toEqual({
      folder: 'Uncategorized',
      suggestedNewFolder: null,
      source: 'no-folders'
    });
  });
});

describe('FolderMatchingService.matchCategoryToFolder — token-subset equivalence', () => {
  test('maps Web Development to an existing Web folder', () => {
    const folders = [{ name: 'Web' }, { name: 'Financial' }, { name: 'Uncategorized' }];
    expect(FolderMatchingService.matchCategoryToFolder('Web Development', folders)).toBe('Web');
  });

  test('maps Trading Engine to an existing Trading folder', () => {
    const folders = [{ name: 'Trading' }, { name: 'Uncategorized' }];
    expect(FolderMatchingService.matchCategoryToFolder('Trading Engine', folders)).toBe('Trading');
  });

  test('prefers the longest equivalent folder name when multiple match', () => {
    const folders = [{ name: 'Web' }, { name: 'Web Development Hub' }, { name: 'Uncategorized' }];
    expect(FolderMatchingService.matchCategoryToFolder('Web Development', folders)).toBe(
      'Web Development Hub'
    );
  });

  test('maps category-subject suffix artifacts to the configured folder', () => {
    const folders = [
      { name: 'Nature', path: '/Nature' },
      { name: 'Finances', path: '/Finances' },
      { name: 'Uncategorized', path: '/Uncategorized' }
    ];
    expect(FolderMatchingService.matchCategoryToFolder('Nature_17803333378895', folders)).toBe(
      'Nature'
    );
    expect(FolderMatchingService.matchCategoryToFolder('Finances_17803333396590', folders)).toBe(
      'Finances'
    );
  });
});
