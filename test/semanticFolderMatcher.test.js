jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock('fs', () => ({
  promises: {
    access: jest.fn().mockResolvedValue(undefined)
  }
}));

jest.mock('../src/shared/performanceConstants', () => ({
  THRESHOLDS: {
    FOLDER_MATCH_CONFIDENCE: 0.75,
    FOLDER_MATCH_UNMATCHED_CATEGORY_FLOOR: 0.8
  },
  TIMEOUTS: {
    EMBEDDING_REQUEST: 5000,
    SEMANTIC_QUERY: 5000
  }
}));

jest.mock('../src/main/services/ServiceContainer', () => ({
  ServiceIds: {
    ORAMA_VECTOR: 'ORAMA_VECTOR',
    FOLDER_MATCHING: 'FOLDER_MATCHING',
    SETTINGS: 'settings',
    LLAMA_SERVICE: 'LLAMA_SERVICE'
  },
  container: {
    tryResolve: jest.fn()
  }
}));

jest.mock('../src/main/analysis/embeddingQueue/stageQueues', () => ({
  analysisQueue: {
    enqueue: jest.fn().mockResolvedValue(undefined)
  }
}));

jest.mock('../src/shared/folderUtils', () => ({
  findContainingSmartFolder: jest.fn()
}));

jest.mock('../src/main/services/embedding/embeddingGate', () => ({
  shouldEmbed: jest.fn().mockResolvedValue({ shouldEmbed: true, timing: 'ok', policy: 'ok' })
}));

jest.mock('../src/main/analysis/chunkEmbedding', () => ({
  embedFileChunks: jest.fn().mockResolvedValue({ persisted: 3, skipped: null })
}));

jest.mock('../src/main/analysis/embeddingSummary', () => ({
  buildEmbeddingSummary: jest.fn(() => ({
    text: 'summary',
    wasTruncated: false,
    estimatedTokens: 10
  }))
}));

jest.mock('../src/shared/pathSanitization', () => ({
  normalizePathForIndex: (p) => p,
  getCanonicalFileId: (p, isImage) => `${isImage ? 'image' : 'file'}:${p}`
}));

jest.mock('../src/shared/promiseUtils', () => ({
  withTimeout: jest.fn((p) => p),
  createBackgroundWorkTracker: jest.fn(() => ({
    track: jest.fn((p) => p),
    drain: jest.fn(),
    get size() {
      return 0;
    }
  })),
  createInitGuard: jest.fn(() => ({
    isInitialized: () => false,
    initialize: jest.fn(async (fn) => fn()),
    reset: jest.fn(),
    requireInitialized: jest.fn()
  }))
}));

const { container } = require('../src/main/services/ServiceContainer');
const { analysisQueue } = require('../src/main/analysis/embeddingQueue/stageQueues');
const { findContainingSmartFolder } = require('../src/shared/folderUtils');
const { shouldEmbed } = require('../src/main/services/embedding/embeddingGate');
const fs = require('fs').promises;

const {
  applySemanticFolderMatching,
  validateMatcher,
  normalizeLlmConfidence
} = require('../src/main/analysis/semanticFolderMatcher');

describe('semanticFolderMatcher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.access.mockResolvedValue(undefined);
    container.tryResolve.mockReset();
  });

  test('validateMatcher requires expected methods', () => {
    expect(validateMatcher(null)).toBeFalsy();
    expect(
      validateMatcher({
        initialize() {},
        batchUpsertFolders() {},
        embedText() {},
        matchVectorToFolders() {}
      })
    ).toBe(true);
  });

  test('skips when vector DB is unavailable', async () => {
    container.tryResolve.mockReturnValueOnce(null);
    const analysis = { category: 'Financial', confidence: 0.9 };

    const result = await applySemanticFolderMatching({
      analysis,
      filePath: 'C:\\a.pdf',
      fileName: 'a.pdf',
      fileExtension: '.pdf',
      smartFolders: []
    });

    expect(result).toBe(analysis);
    expect(analysisQueue.enqueue).not.toHaveBeenCalled();
  });

  test('skips when matcher is invalid', async () => {
    container.tryResolve
      .mockReturnValueOnce({ initialize: jest.fn() }) // vectorDb
      .mockReturnValueOnce({}); // matcher missing methods

    const analysis = { category: 'Financial', confidence: 0.9 };
    const result = await applySemanticFolderMatching({
      analysis,
      filePath: 'C:\\a.pdf',
      fileName: 'a.pdf',
      fileExtension: '.pdf',
      smartFolders: []
    });
    expect(result).toBe(analysis);
  });

  test('initializes matcher, upserts folders, enqueues embedding when file is in smart folder', async () => {
    const vectorDb = { initialize: jest.fn().mockResolvedValue(undefined) };
    const matcher = {
      embeddingCache: { initialized: false },
      initialize: jest.fn().mockResolvedValue(undefined),
      batchUpsertFolders: jest.fn().mockResolvedValue({ count: 1 }),
      embedText: jest.fn().mockResolvedValue({ vector: [1, 2, 3], model: 'm' }),
      matchVectorToFolders: jest.fn().mockResolvedValue([])
    };

    container.tryResolve.mockReturnValueOnce(vectorDb).mockReturnValueOnce(matcher);

    findContainingSmartFolder.mockReturnValue({ name: 'Financial', path: 'C:\\Sorted\\Financial' });
    shouldEmbed.mockResolvedValue({ shouldEmbed: true, timing: 'ok', policy: 'ok' });

    const analysis = { category: 'Documents', confidence: 0.9, keywords: ['a'] };

    const result = await applySemanticFolderMatching({
      analysis,
      filePath: 'C:\\Sorted\\Financial\\a.pdf',
      fileName: 'a.pdf',
      fileExtension: '.pdf',
      fileSize: 123,
      extractedText: 'text',
      smartFolders: [{ name: 'Financial', path: 'C:\\Sorted\\Financial' }]
    });

    expect(result).toBe(analysis);
    expect(matcher.initialize).toHaveBeenCalled();
    expect(matcher.batchUpsertFolders).toHaveBeenCalledWith([
      { name: 'Financial', path: 'C:\\Sorted\\Financial' }
    ]);
    expect(analysisQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringContaining('file:C:\\Sorted\\Financial\\a.pdf'),
        vector: [1, 2, 3],
        model: 'm',
        meta: expect.objectContaining({
          path: 'C:\\Sorted\\Financial\\a.pdf',
          name: 'a.pdf',
          smartFolder: 'Financial'
        })
      })
    );
  });

  test('builds passage vectors on the Discover path right after the file vector is queued', async () => {
    const { embedFileChunks } = require('../src/main/analysis/chunkEmbedding');
    const vectorDb = { initialize: jest.fn().mockResolvedValue(undefined) };
    const matcher = {
      embeddingCache: { initialized: true },
      initialize: jest.fn().mockResolvedValue(undefined),
      batchUpsertFolders: jest.fn().mockResolvedValue({ count: 1 }),
      embedText: jest.fn().mockResolvedValue({ vector: [1, 2, 3], model: 'm' }),
      matchVectorToFolders: jest.fn().mockResolvedValue([])
    };
    container.tryResolve.mockReturnValueOnce(vectorDb).mockReturnValueOnce(matcher);
    findContainingSmartFolder.mockReturnValue({ name: 'Financial', path: 'C:\\Sorted\\Financial' });
    shouldEmbed.mockResolvedValue({ shouldEmbed: true, timing: 'ok', policy: 'ok' });

    const analysis = { category: 'Documents', confidence: 0.9, keywords: ['a'] };
    const longText = 'A long document body. '.repeat(40);
    await applySemanticFolderMatching({
      analysis,
      filePath: 'C:\\Sorted\\Financial\\a.pdf',
      fileName: 'a.pdf',
      fileExtension: '.pdf',
      fileSize: 123,
      extractedText: longText,
      smartFolders: [{ name: 'Financial', path: 'C:\\Sorted\\Financial' }]
    });

    expect(analysisQueue.enqueue).toHaveBeenCalled();
    expect(embedFileChunks).toHaveBeenCalledTimes(1);
    const args = embedFileChunks.mock.calls[0][0];
    expect(args).toMatchObject({
      fileId: expect.stringContaining('file:C:\\Sorted\\Financial\\a.pdf'),
      filePath: 'C:\\Sorted\\Financial\\a.pdf',
      extractedText: longText,
      vectorDb
    });
    // The matcher's embedder is the one used for passages, so chunk and file
    // vectors come from the same model.
    await args.embedText('passage');
    expect(matcher.embedText).toHaveBeenCalledWith('passage');
  });

  test('does not build passage vectors when the embedding gate says skip', async () => {
    const { embedFileChunks } = require('../src/main/analysis/chunkEmbedding');
    const vectorDb = { initialize: jest.fn().mockResolvedValue(undefined) };
    const matcher = {
      embeddingCache: { initialized: true },
      initialize: jest.fn().mockResolvedValue(undefined),
      batchUpsertFolders: jest.fn().mockResolvedValue({ count: 1 }),
      embedText: jest.fn().mockResolvedValue({ vector: [1, 2, 3], model: 'm' }),
      matchVectorToFolders: jest.fn().mockResolvedValue([])
    };
    container.tryResolve.mockReturnValueOnce(vectorDb).mockReturnValueOnce(matcher);
    findContainingSmartFolder.mockReturnValue({ name: 'Financial', path: 'C:\\Sorted\\Financial' });
    shouldEmbed.mockResolvedValue({ shouldEmbed: false, timing: 'manual', policy: 'skip' });

    await applySemanticFolderMatching({
      analysis: { category: 'Documents', confidence: 0.9, keywords: ['a'] },
      filePath: 'C:\\Sorted\\Financial\\a.pdf',
      fileName: 'a.pdf',
      fileExtension: '.pdf',
      fileSize: 123,
      extractedText: 'A long document body. '.repeat(40),
      smartFolders: [{ name: 'Financial', path: 'C:\\Sorted\\Financial' }]
    });

    expect(analysisQueue.enqueue).not.toHaveBeenCalled();
    expect(embedFileChunks).not.toHaveBeenCalled();
  });

  test('skips enqueue when file moved before document embedding persistence', async () => {
    const vectorDb = { initialize: jest.fn().mockResolvedValue(undefined) };
    const matcher = {
      embeddingCache: { initialized: false },
      initialize: jest.fn().mockResolvedValue(undefined),
      batchUpsertFolders: jest.fn().mockResolvedValue({ count: 1 }),
      embedText: jest.fn().mockResolvedValue({ vector: [1, 2, 3], model: 'm' }),
      matchVectorToFolders: jest.fn().mockResolvedValue([])
    };

    container.tryResolve.mockReturnValueOnce(vectorDb).mockReturnValueOnce(matcher);
    shouldEmbed.mockResolvedValue({ shouldEmbed: true, timing: 'ok', policy: 'ok' });
    fs.access.mockRejectedValueOnce(new Error('missing'));

    const analysis = { category: 'Documents', confidence: 0.9, keywords: ['a'] };
    const result = await applySemanticFolderMatching({
      analysis,
      filePath: 'C:\\gone.pdf',
      fileName: 'gone.pdf',
      fileExtension: '.pdf',
      fileSize: 123,
      extractedText: 'text',
      smartFolders: []
    });

    expect(result._fileMovedDuringAnalysis).toBe(true);
    expect(result.embeddingStatus).toBe('skipped');
    expect(analysisQueue.enqueue).not.toHaveBeenCalled();
  });

  test('does not strand embeddingStatus as pending when enqueue throws (F-050)', async () => {
    const vectorDb = { initialize: jest.fn().mockResolvedValue(undefined) };
    const matcher = {
      embeddingCache: { initialized: false },
      initialize: jest.fn().mockResolvedValue(undefined),
      batchUpsertFolders: jest.fn().mockResolvedValue({ count: 1 }),
      embedText: jest.fn().mockResolvedValue({ vector: [1, 2, 3], model: 'm' }),
      matchVectorToFolders: jest.fn().mockResolvedValue([])
    };

    container.tryResolve.mockReturnValueOnce(vectorDb).mockReturnValueOnce(matcher);
    shouldEmbed.mockResolvedValue({ shouldEmbed: true, timing: 'ok', policy: 'ok' });
    fs.access.mockResolvedValue(undefined);
    analysisQueue.enqueue.mockRejectedValueOnce(new Error('queue offline'));

    const analysis = { category: 'Documents', confidence: 0.9, keywords: ['a'] };
    const result = await applySemanticFolderMatching({
      analysis,
      filePath: 'C:\\a.pdf',
      fileName: 'a.pdf',
      fileExtension: '.pdf',
      fileSize: 123,
      extractedText: 'text',
      smartFolders: []
    });

    expect(analysisQueue.enqueue).toHaveBeenCalled();
    expect(result.embeddingStatus).not.toBe('pending');
    expect(result.embeddingStatus).toBe('error');
  });

  test('de-duplicates repeated smart-folder upserts for the same matcher and folder set', async () => {
    const vectorDb = { initialize: jest.fn().mockResolvedValue(undefined) };
    const matcher = {
      embeddingCache: { initialized: true },
      initialize: jest.fn(),
      batchUpsertFolders: jest.fn().mockResolvedValue({ count: 1 }),
      embedText: jest.fn().mockResolvedValue({ vector: [1, 2, 3], model: 'm' }),
      matchVectorToFolders: jest.fn().mockResolvedValue([])
    };

    container.tryResolve.mockImplementation((serviceId) => {
      if (serviceId === 'ORAMA_VECTOR') return vectorDb;
      if (serviceId === 'FOLDER_MATCHING') return matcher;
      return null;
    });

    const baseParams = {
      fileName: 'a.pdf',
      fileExtension: '.pdf',
      smartFolders: [{ name: 'Financial', path: 'C:\\Sorted\\Financial' }]
    };

    await applySemanticFolderMatching({
      ...baseParams,
      analysis: { category: 'Documents', confidence: 0.9 },
      filePath: 'C:\\Sorted\\Financial\\a.pdf'
    });
    await applySemanticFolderMatching({
      ...baseParams,
      analysis: { category: 'Documents', confidence: 0.9 },
      filePath: 'C:\\Sorted\\Financial\\b.pdf'
    });

    expect(matcher.batchUpsertFolders).toHaveBeenCalledTimes(1);
  });

  test('retries smart-folder upsert when previous attempt persisted nothing', async () => {
    const vectorDb = { initialize: jest.fn().mockResolvedValue(undefined) };
    const matcher = {
      embeddingCache: { initialized: true },
      initialize: jest.fn(),
      batchUpsertFolders: jest.fn().mockResolvedValue({
        count: 0,
        skipped: [{ error: 'dimension_mismatch' }],
        requiresRebuild: true
      }),
      embedText: jest.fn().mockResolvedValue({ vector: [1, 2, 3], model: 'm' }),
      matchVectorToFolders: jest.fn().mockResolvedValue([])
    };

    container.tryResolve.mockImplementation((serviceId) => {
      if (serviceId === 'ORAMA_VECTOR') return vectorDb;
      if (serviceId === 'FOLDER_MATCHING') return matcher;
      return null;
    });

    const baseParams = {
      fileName: 'a.pdf',
      fileExtension: '.pdf',
      smartFolders: [{ name: 'Financial', path: 'C:\\Sorted\\Financial' }]
    };

    await applySemanticFolderMatching({
      ...baseParams,
      analysis: { category: 'Documents', confidence: 0.9 },
      filePath: 'C:\\Sorted\\Financial\\a.pdf'
    });
    await applySemanticFolderMatching({
      ...baseParams,
      analysis: { category: 'Documents', confidence: 0.9 },
      filePath: 'C:\\Sorted\\Financial\\b.pdf'
    });

    expect(matcher.batchUpsertFolders).toHaveBeenCalledTimes(2);
  });

  test('overrides category when embedding match exceeds threshold and effective LLM confidence', async () => {
    const vectorDb = { initialize: jest.fn().mockResolvedValue(undefined) };
    const matcher = {
      embeddingCache: { initialized: true },
      initialize: jest.fn(),
      batchUpsertFolders: jest.fn().mockResolvedValue({ count: 1 }),
      embedText: jest.fn().mockResolvedValue({ vector: [1, 2, 3], model: 'm' }),
      matchVectorToFolders: jest
        .fn()
        .mockResolvedValue([{ name: 'Financial', path: 'C:\\Sorted\\Financial', score: 0.9 }])
    };
    container.tryResolve.mockReturnValueOnce(vectorDb).mockReturnValueOnce(matcher);

    findContainingSmartFolder.mockReturnValue(null);

    const analysis = { category: 'Documents', confidence: 0.95 };
    await applySemanticFolderMatching({
      analysis,
      filePath: 'C:\\a.pdf',
      fileName: 'a.pdf',
      fileExtension: '.pdf',
      smartFolders: [{ name: 'Financial' }]
    });

    expect(analysis.category).toBe('Financial');
    expect(analysis.categorySource).toBe('embedding_override');
    expect(analysis.suggestedFolder).toBe('Financial');
    expect(analysis.destinationFolder).toBe('C:\\Sorted\\Financial');
    expect(analysis.folderMatchCandidates).toHaveLength(1);
  });

  test('enqueue uses overridden category when embedding override wins', async () => {
    const vectorDb = { initialize: jest.fn().mockResolvedValue(undefined) };
    const matcher = {
      embeddingCache: { initialized: true },
      initialize: jest.fn(),
      batchUpsertFolders: jest.fn().mockResolvedValue({ count: 1 }),
      embedText: jest.fn().mockResolvedValue({ vector: [1, 2, 3], model: 'm' }),
      matchVectorToFolders: jest
        .fn()
        .mockResolvedValue([{ name: 'Financial', path: 'C:\\Sorted\\Financial', score: 0.9 }])
    };
    container.tryResolve.mockReturnValueOnce(vectorDb).mockReturnValueOnce(matcher);

    findContainingSmartFolder.mockReturnValue({ name: 'General', path: 'C:\\Sorted\\General' });
    shouldEmbed.mockResolvedValue({ shouldEmbed: true, timing: 'ok', policy: 'ok' });

    const analysis = { category: 'Documents', confidence: 0.2, keywords: ['a'] };
    await applySemanticFolderMatching({
      analysis,
      filePath: 'C:\\Sorted\\General\\a.pdf',
      fileName: 'a.pdf',
      fileExtension: '.pdf',
      fileSize: 123,
      extractedText: 'text',
      smartFolders: [
        { name: 'General', path: 'C:\\Sorted\\General' },
        { name: 'Financial', path: 'C:\\Sorted\\Financial' }
      ]
    });

    expect(analysis.category).toBe('Financial');
    expect(analysis.categorySource).toBe('embedding_override');
    expect(analysisQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          category: 'Financial',
          smartFolder: 'General'
        })
      })
    );
  });

  test('preserves LLM category when confidence is higher than embedding', async () => {
    const vectorDb = { initialize: jest.fn().mockResolvedValue(undefined) };
    const matcher = {
      embeddingCache: { initialized: true },
      initialize: jest.fn(),
      batchUpsertFolders: jest.fn().mockResolvedValue({ count: 1 }),
      embedText: jest.fn().mockResolvedValue({ vector: [1, 2, 3], model: 'm' }),
      matchVectorToFolders: jest
        .fn()
        .mockResolvedValue([{ name: 'Financial', path: 'C:\\Sorted\\Financial', score: 0.8 }])
    };
    container.tryResolve.mockReturnValueOnce(vectorDb).mockReturnValueOnce(matcher);

    const analysis = { category: 'Financial', confidence: 0.95 };
    await applySemanticFolderMatching({
      analysis,
      filePath: 'C:\\a.pdf',
      fileName: 'a.pdf',
      fileExtension: '.pdf',
      smartFolders: [{ name: 'Financial' }]
    });

    expect(analysis.category).toBe('Financial');
    expect(analysis.categorySource).toBe('llm_preserved');
  });

  test('normalizes fractional confidence 1.5 as percentage (not 150% on 0–1 scale)', async () => {
    const vectorDb = { initialize: jest.fn().mockResolvedValue(undefined) };
    const matcher = {
      embeddingCache: { initialized: true },
      initialize: jest.fn(),
      batchUpsertFolders: jest.fn().mockResolvedValue({ count: 1 }),
      embedText: jest.fn().mockResolvedValue({ vector: [1, 2, 3], model: 'm' }),
      matchVectorToFolders: jest.fn().mockResolvedValue([
        { name: 'Invoices', path: 'C:\\Sorted\\Invoices', score: 0.8 },
        { name: 'Financial', path: 'C:\\Sorted\\Financial', score: 0.4 }
      ])
    };
    container.tryResolve.mockReturnValueOnce(vectorDb).mockReturnValueOnce(matcher);

    const analysis = { category: 'Financial', confidence: 1.5 };
    await applySemanticFolderMatching({
      analysis,
      filePath: 'C:\\a.pdf',
      fileName: 'a.pdf',
      fileExtension: '.pdf',
      smartFolders: [{ name: 'Financial' }, { name: 'Invoices', path: 'C:\\Sorted\\Invoices' }]
    });

    expect(analysis.categorySource).toBe('embedding_override');
    expect(analysis.category).toBe('Invoices');
  });

  test('clamps LLM confidence above 100 to 1.0 so embedding cannot spuriously override', async () => {
    const vectorDb = { initialize: jest.fn().mockResolvedValue(undefined) };
    const matcher = {
      embeddingCache: { initialized: true },
      initialize: jest.fn(),
      batchUpsertFolders: jest.fn().mockResolvedValue({ count: 1 }),
      embedText: jest.fn().mockResolvedValue({ vector: [1, 2, 3], model: 'm' }),
      matchVectorToFolders: jest
        .fn()
        .mockResolvedValue([{ name: 'Other', path: 'C:\\Sorted\\Other', score: 0.95 }])
    };
    // Hybrid keeps the LLM unless the vector score beats normalized confidence.
    // Auto/embedding-first would take Other here; this test pins the clamp.
    container.tryResolve.mockImplementation((id) => {
      if (id === 'ORAMA_VECTOR') return vectorDb;
      if (id === 'FOLDER_MATCHING') return matcher;
      if (id === 'settings') {
        return { load: async () => ({ smartFolderRoutingMode: 'hybrid' }) };
      }
      return undefined;
    });

    const analysis = { category: 'Financial', confidence: 150 };
    await applySemanticFolderMatching({
      analysis,
      filePath: 'C:\\a.pdf',
      fileName: 'a.pdf',
      fileExtension: '.pdf',
      smartFolders: [{ name: 'Financial' }, { name: 'Other', path: 'C:\\Sorted\\Other' }]
    });

    expect(analysis.categorySource).toBe('llm_preserved');
    expect(analysis.category).toBe('Financial');
  });

  test('preserves LLM category when top vector candidate name is not in current smartFolders (phantom)', async () => {
    // Reproduces the live regression where the folder vector DB still contains
    // a "Images" embedding from a removed default file-type taxonomy. The
    // semantic match returns "Images" as top hit with a high score, the
    // override fires, and downstream `matchCategoryToFolder("Images", folders)`
    // demotes the result to "Uncategorized" — losing both the embedding hit
    // AND the LLM category.
    const vectorDb = { initialize: jest.fn().mockResolvedValue(undefined) };
    const matcher = {
      embeddingCache: { initialized: true },
      initialize: jest.fn(),
      batchUpsertFolders: jest.fn().mockResolvedValue({ count: 1 }),
      embedText: jest.fn().mockResolvedValue({ vector: [1, 2, 3], model: 'm' }),
      matchVectorToFolders: jest
        .fn()
        .mockResolvedValue([{ name: 'Images', path: 'C:\\Sorted\\Images', score: 0.95 }])
    };
    container.tryResolve.mockReturnValueOnce(vectorDb).mockReturnValueOnce(matcher);

    const analysis = { category: 'Logos and Graphic Design', confidence: 50 };
    await applySemanticFolderMatching({
      analysis,
      filePath: 'C:\\bunny-carpet.jpg',
      fileName: 'bunny-carpet.jpg',
      fileExtension: '.jpg',
      type: 'image',
      smartFolders: [
        { name: 'Logos and Graphic Design', path: 'C:\\Sorted\\Logos and Graphic Design' },
        { name: 'Uncategorized', path: 'C:\\Sorted\\Uncategorized' }
      ]
    });

    expect(analysis.category).toBe('Logos and Graphic Design');
    expect(analysis.categorySource).not.toBe('embedding_override');
    expect(analysis.suggestedFolder).toBeUndefined();
    // Full candidate list (including phantom) preserved for debug surface
    expect(analysis.folderMatchCandidates).toHaveLength(1);
  });

  test('falls through to next vector candidate that IS in current smartFolders', async () => {
    // When top vector candidate is a phantom, but a lower-ranked candidate
    // exists in the current smart folders and still beats LLM confidence,
    // the override should fire against that lower-ranked real-folder match.
    const vectorDb = { initialize: jest.fn().mockResolvedValue(undefined) };
    const matcher = {
      embeddingCache: { initialized: true },
      initialize: jest.fn(),
      batchUpsertFolders: jest.fn().mockResolvedValue({ count: 1 }),
      embedText: jest.fn().mockResolvedValue({ vector: [1, 2, 3], model: 'm' }),
      matchVectorToFolders: jest.fn().mockResolvedValue([
        { name: 'Images', path: 'C:\\Sorted\\Images', score: 0.95 },
        { name: 'Financial', path: 'C:\\Sorted\\Financial', score: 0.82 }
      ])
    };
    container.tryResolve.mockReturnValueOnce(vectorDb).mockReturnValueOnce(matcher);

    const analysis = { category: 'Documents', confidence: 60 };
    await applySemanticFolderMatching({
      analysis,
      filePath: 'C:\\receipt.pdf',
      fileName: 'receipt.pdf',
      fileExtension: '.pdf',
      smartFolders: [
        { name: 'Financial', path: 'C:\\Sorted\\Financial' },
        { name: 'Other', path: 'C:\\Sorted\\Other' }
      ]
    });

    expect(analysis.category).toBe('Financial');
    expect(analysis.categorySource).toBe('embedding_override');
    expect(analysis.suggestedFolder).toBe('Financial');
    expect(analysis.destinationFolder).toBe('C:\\Sorted\\Financial');
    expect(analysis.folderMatchCandidates).toHaveLength(2);
  });

  test('does not override when LLM category is unmatchable and embedding is below the unmatched floor', async () => {
    // Regression: life-areas image with LLM category "Body, Mind & Spirit"
    // (not in smart folders) was routed to "Financial" because the embedding
    // score 0.61 cleared the base FOLDER_MATCH_CONFIDENCE while the LLM
    // category collapsed to effectiveLlmConfidence=0. With the higher
    // FOLDER_MATCH_UNMATCHED_CATEGORY_FLOOR, low-confidence embeddings can
    // no longer hijack an unmatchable category.
    const vectorDb = { initialize: jest.fn().mockResolvedValue(undefined) };
    const matcher = {
      embeddingCache: { initialized: true },
      initialize: jest.fn(),
      batchUpsertFolders: jest.fn().mockResolvedValue({ count: 1 }),
      embedText: jest.fn().mockResolvedValue({ vector: [1, 2, 3], model: 'm' }),
      matchVectorToFolders: jest
        .fn()
        .mockResolvedValue([{ name: 'Financial', path: 'C:\\Sorted\\Financial', score: 0.76 }])
    };
    container.tryResolve.mockReturnValueOnce(vectorDb).mockReturnValueOnce(matcher);

    const analysis = { category: 'Body, Mind & Spirit', confidence: 0.8 };
    await applySemanticFolderMatching({
      analysis,
      filePath: 'C:\\life-areas.png',
      fileName: 'life-areas.png',
      fileExtension: '.png',
      type: 'image',
      smartFolders: [
        { name: 'Financial', path: 'C:\\Sorted\\Financial' },
        { name: 'Uncategorized', path: 'C:\\Sorted\\Uncategorized' }
      ]
    });

    expect(analysis.category).toBe('Body, Mind & Spirit');
    expect(analysis.categorySource).not.toBe('embedding_override');
    expect(analysis.suggestedFolder).toBeUndefined();
    expect(analysis.suggestedNewFolder).toBe('Body, Mind & Spirit');
  });

  test('does override when LLM category is unmatchable AND embedding score clears the unmatched floor', async () => {
    // Mirror of the prior test, but with a confident embedding (0.9 vs mocked
    // floor 0.8). Override must still fire — we are not blocking strong
    // semantic signals, only refusing weak ones.
    const vectorDb = { initialize: jest.fn().mockResolvedValue(undefined) };
    const matcher = {
      embeddingCache: { initialized: true },
      initialize: jest.fn(),
      batchUpsertFolders: jest.fn().mockResolvedValue({ count: 1 }),
      embedText: jest.fn().mockResolvedValue({ vector: [1, 2, 3], model: 'm' }),
      matchVectorToFolders: jest
        .fn()
        .mockResolvedValue([{ name: 'Financial', path: 'C:\\Sorted\\Financial', score: 0.9 }])
    };
    container.tryResolve.mockReturnValueOnce(vectorDb).mockReturnValueOnce(matcher);

    const analysis = { category: 'Some Unknown Theme', confidence: 0.8 };
    await applySemanticFolderMatching({
      analysis,
      filePath: 'C:\\receipt.pdf',
      fileName: 'receipt.pdf',
      fileExtension: '.pdf',
      smartFolders: [{ name: 'Financial', path: 'C:\\Sorted\\Financial' }]
    });

    expect(analysis.category).toBe('Financial');
    expect(analysis.categorySource).toBe('embedding_override');
    expect(analysis.suggestedNewFolder).toBeUndefined();
  });

  test('does not surface a new-folder suggestion when LLM category is the literal Uncategorized', async () => {
    const vectorDb = { initialize: jest.fn().mockResolvedValue(undefined) };
    const matcher = {
      embeddingCache: { initialized: true },
      initialize: jest.fn(),
      batchUpsertFolders: jest.fn().mockResolvedValue({ count: 1 }),
      embedText: jest.fn().mockResolvedValue({ vector: [1, 2, 3], model: 'm' }),
      matchVectorToFolders: jest
        .fn()
        .mockResolvedValue([{ name: 'Financial', path: 'C:\\Sorted\\Financial', score: 0.5 }])
    };
    container.tryResolve.mockReturnValueOnce(vectorDb).mockReturnValueOnce(matcher);

    const analysis = { category: 'Uncategorized', confidence: 0.8 };
    await applySemanticFolderMatching({
      analysis,
      filePath: 'C:\\misc.pdf',
      fileName: 'misc.pdf',
      fileExtension: '.pdf',
      smartFolders: [
        { name: 'Financial', path: 'C:\\Sorted\\Financial' },
        { name: 'Uncategorized', path: 'C:\\Sorted\\Uncategorized' }
      ]
    });

    expect(analysis.suggestedNewFolder).toBeUndefined();
  });

  test('honours the abort signal before invoking embedText (early short-circuit)', async () => {
    // Round-3 audit fix: when the user closes the window mid-analysis the
    // abort signal must short-circuit the embedding work so we don't burn
    // VRAM and write stale vectors after the renderer is unblocked. This
    // test confirms `signal.aborted = true` at function entry skips the
    // entire matcher path without touching the mock matcher methods.
    const vectorDb = { initialize: jest.fn().mockResolvedValue(undefined) };
    const matcher = {
      embeddingCache: { initialized: true },
      initialize: jest.fn(),
      batchUpsertFolders: jest.fn().mockResolvedValue({ count: 1 }),
      embedText: jest.fn(),
      matchVectorToFolders: jest.fn()
    };
    container.tryResolve.mockReturnValueOnce(vectorDb).mockReturnValueOnce(matcher);

    const controller = new AbortController();
    controller.abort();

    const analysis = { category: 'Financial', confidence: 0.9 };
    const result = await applySemanticFolderMatching({
      analysis,
      filePath: 'C:\\a.pdf',
      fileName: 'a.pdf',
      fileExtension: '.pdf',
      smartFolders: [{ name: 'Financial', path: 'C:\\Sorted\\Financial' }],
      signal: controller.signal
    });

    expect(result).toBe(analysis);
    expect(matcher.embedText).not.toHaveBeenCalled();
    expect(matcher.matchVectorToFolders).not.toHaveBeenCalled();
    expect(analysisQueue.enqueue).not.toHaveBeenCalled();
  });

  function stubServices(vectorDb, matcher, routingMode = 'auto') {
    container.tryResolve.mockReset();
    container.tryResolve.mockImplementation((id) => {
      if (id === 'ORAMA_VECTOR') return vectorDb;
      if (id === 'FOLDER_MATCHING') return matcher;
      if (id === 'settings') {
        return { load: async () => ({ smartFolderRoutingMode: routingMode }) };
      }
      return undefined;
    });
  }

  test('auto routing lets a decisive folder vector beat a high-confidence LLM name match', async () => {
    const vectorDb = { initialize: jest.fn().mockResolvedValue(undefined) };
    const matcher = {
      embeddingCache: { initialized: true },
      initialize: jest.fn(),
      batchUpsertFolders: jest.fn().mockResolvedValue({ count: 1 }),
      embedText: jest.fn().mockResolvedValue({ vector: [1, 2, 3], model: 'm' }),
      matchVectorToFolders: jest.fn().mockResolvedValue([
        { name: 'Research', path: 'C:\\Sorted\\Research', score: 0.88 },
        { name: 'Nature', path: 'C:\\Sorted\\Nature', score: 0.62 }
      ])
    };
    stubServices(vectorDb, matcher, 'auto');

    const analysis = { category: 'Nature', confidence: 95 };
    await applySemanticFolderMatching({
      analysis,
      filePath: 'C:\\protein.txt',
      fileName: 'protein.txt',
      fileExtension: '.txt',
      smartFolders: [
        {
          name: 'Nature',
          path: 'C:\\Sorted\\Nature',
          description: 'Environment, climate, wildlife'
        },
        {
          name: 'Research',
          path: 'C:\\Sorted\\Research',
          description: 'Research papers, science, machine learning'
        }
      ]
    });

    expect(analysis.category).toBe('Research');
    expect(analysis.categorySource).toBe('embedding_override');
  });

  test('LLM-only routing never overrides the model category with a folder vector', async () => {
    const vectorDb = { initialize: jest.fn().mockResolvedValue(undefined) };
    const matcher = {
      embeddingCache: { initialized: true },
      initialize: jest.fn(),
      batchUpsertFolders: jest.fn().mockResolvedValue({ count: 1 }),
      embedText: jest.fn().mockResolvedValue({ vector: [1, 2, 3], model: 'm' }),
      matchVectorToFolders: jest.fn().mockResolvedValue([
        { name: 'Research', path: 'C:\\Sorted\\Research', score: 0.88 },
        { name: 'Nature', path: 'C:\\Sorted\\Nature', score: 0.62 }
      ])
    };
    stubServices(vectorDb, matcher, 'llm');

    const analysis = { category: 'Nature', confidence: 95 };
    await applySemanticFolderMatching({
      analysis,
      filePath: 'C:\\protein.txt',
      fileName: 'protein.txt',
      fileExtension: '.txt',
      smartFolders: [
        { name: 'Nature', path: 'C:\\Sorted\\Nature' },
        { name: 'Research', path: 'C:\\Sorted\\Research' }
      ]
    });

    expect(analysis.category).toBe('Nature');
    expect(analysis.categorySource).not.toBe('embedding_override');
  });

  test('hybrid routing keeps a high-confidence LLM folder when the vector disagrees', async () => {
    const vectorDb = { initialize: jest.fn().mockResolvedValue(undefined) };
    const matcher = {
      embeddingCache: { initialized: true },
      initialize: jest.fn(),
      batchUpsertFolders: jest.fn().mockResolvedValue({ count: 1 }),
      embedText: jest.fn().mockResolvedValue({ vector: [1, 2, 3], model: 'm' }),
      matchVectorToFolders: jest.fn().mockResolvedValue([
        { name: 'Research', path: 'C:\\Sorted\\Research', score: 0.88 },
        { name: 'Nature', path: 'C:\\Sorted\\Nature', score: 0.62 }
      ])
    };
    stubServices(vectorDb, matcher, 'hybrid');

    const analysis = { category: 'Nature', confidence: 95 };
    await applySemanticFolderMatching({
      analysis,
      filePath: 'C:\\protein.txt',
      fileName: 'protein.txt',
      fileExtension: '.txt',
      smartFolders: [
        { name: 'Nature', path: 'C:\\Sorted\\Nature' },
        { name: 'Research', path: 'C:\\Sorted\\Research' }
      ]
    });

    expect(analysis.category).toBe('Nature');
    expect(analysis.categorySource).toBe('llm_preserved');
  });

  test('embedding-first routing overrides when the LLM folder is absent from vector top-k', async () => {
    const vectorDb = { initialize: jest.fn().mockResolvedValue(undefined) };
    const matcher = {
      embeddingCache: { initialized: true },
      initialize: jest.fn(),
      batchUpsertFolders: jest.fn().mockResolvedValue({ count: 1 }),
      embedText: jest.fn().mockResolvedValue({ vector: [1, 2, 3], model: 'm' }),
      matchVectorToFolders: jest
        .fn()
        .mockResolvedValue([{ name: 'Research', path: 'C:\\Sorted\\Research', score: 0.88 }])
    };
    stubServices(vectorDb, matcher, 'embedding');

    const analysis = { category: 'Nature', confidence: 95 };
    await applySemanticFolderMatching({
      analysis,
      filePath: 'C:\\protein.txt',
      fileName: 'protein.txt',
      fileExtension: '.txt',
      smartFolders: [
        { name: 'Nature', path: 'C:\\Sorted\\Nature' },
        { name: 'Research', path: 'C:\\Sorted\\Research' }
      ]
    });

    expect(analysis.category).toBe('Research');
    expect(analysis.categorySource).toBe('embedding_override');
  });
});

describe('normalizeLlmConfidence', () => {
  test.each([
    [0, 0],
    [1, 0.01],
    [1.5, 0.015],
    [50, 0.5],
    [85, 0.85],
    [100, 1],
    [150, 1],
    [-5, 0]
  ])('normalizes %p to %p', (raw, expected) => {
    expect(normalizeLlmConfidence(raw)).toBeCloseTo(expected, 8);
  });

  test('NaN and undefined fall back to 0.7', () => {
    expect(normalizeLlmConfidence(NaN)).toBe(0.7);
    expect(normalizeLlmConfidence(undefined)).toBe(0.7);
  });

  test('preserves fractional 0–1 scores', () => {
    expect(normalizeLlmConfidence(0.85)).toBeCloseTo(0.85, 8);
  });
});
