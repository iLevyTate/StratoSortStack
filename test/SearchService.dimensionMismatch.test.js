/**
 * Regression: an embedding-model change makes _normalizeQueryVector throw an
 * actionable isDimensionMismatch error ("rebuild your search index"), but
 * vectorSearch/chunkSearch caught EVERYTHING and returned [] — so hybrid
 * search silently degraded to keyword-only forever and the purpose-built
 * recovery path in ipc/semantic.js (isDimensionMismatchError on result.error)
 * was dead code.
 *
 * Contract pinned here:
 *  - vectorSearch / chunkSearch REJECT with the isDimensionMismatch error
 *  - hybrid mode still serves BM25 results, but flags meta.requiresRebuild
 *    and a VECTOR_DIMENSION_MISMATCH warning (rendered by the search
 *    diagnostics banner)
 *  - when even BM25 has nothing, hybridSearch fails with the actionable
 *    message so semantic.js maps it to VECTOR_DB_DIMENSION_MISMATCH
 */

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

const { SearchService } = require('../src/main/services/SearchService');

const COLLECTION_DIM = 768;
const WRONG_DIM = 1024;

function makeService(overrides = {}) {
  const vectorDbService = {
    initialize: jest.fn().mockResolvedValue(true),
    isOnline: true,
    getStats: jest.fn().mockResolvedValue({ files: 1, fileChunks: 1, folders: 0 }),
    getCollectionDimension: jest.fn().mockResolvedValue(COLLECTION_DIM),
    querySimilarFiles: jest.fn().mockResolvedValue([]),
    querySimilarChunks: jest.fn().mockResolvedValue([]),
    getChunksForFile: jest.fn().mockResolvedValue([]),
    peekFiles: jest.fn().mockResolvedValue({ ids: [], embeddings: [], metadatas: [] }),
    getFile: jest.fn().mockResolvedValue(null),
    ...overrides.vectorDbService
  };

  const history = {
    initialize: jest.fn().mockResolvedValue(undefined),
    analysisHistory: { metadata: { totalEntries: 0 }, entries: {} }
  };

  const embedding = {
    embedText: jest.fn().mockResolvedValue({ vector: new Array(WRONG_DIM).fill(0.1) }),
    ...overrides.parallelEmbeddingService
  };

  const service = new SearchService({
    vectorDbService,
    analysisHistoryService: history,
    parallelEmbeddingService: embedding,
    reRankerService: null,
    queryProcessor: null,
    relationshipIndexService: null
  });

  service._validateFileExistence = jest.fn(async (results) => ({
    validResults: results,
    ghostCount: 0
  }));
  service.isIndexStale = jest.fn(() => false);
  service.enrichResults = jest.fn();

  return service;
}

describe('SearchService — dimension mismatch must surface, not silently degrade', () => {
  test('vectorSearch rejects with the actionable isDimensionMismatch error', async () => {
    const service = makeService();
    await expect(service.vectorSearch('quarterly report', 5)).rejects.toMatchObject({
      isDimensionMismatch: true,
      message: expect.stringContaining('rebuild your search index')
    });
  });

  test('chunkSearch rejects with the actionable isDimensionMismatch error', async () => {
    const service = makeService();
    await expect(service.chunkSearch('quarterly report', 5, 20)).rejects.toMatchObject({
      isDimensionMismatch: true
    });
  });

  test('hybrid mode keeps BM25 results but flags requiresRebuild + warning', async () => {
    const service = makeService();
    service.bm25Search = jest.fn().mockResolvedValue([
      {
        id: 'file-1',
        score: 1.2,
        metadata: { path: '/docs/a.txt', name: 'a.txt' },
        source: 'bm25'
      }
    ]);

    const result = await service.hybridSearch('quarterly report', {
      mode: 'hybrid',
      topK: 5
    });

    expect(result.success).toBe(true);
    expect(result.mode).toBe('bm25-fallback');
    expect(result.results).toHaveLength(1);
    expect(result.meta?.requiresRebuild).toBe(true);
    expect(result.meta?.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'VECTOR_DIMENSION_MISMATCH',
          severity: 'high',
          message: expect.stringContaining('rebuild your search index')
        })
      ])
    );
  });

  test('vector mode with no BM25 fallback fails with the actionable message', async () => {
    const service = makeService();
    service.bm25Search = jest.fn().mockResolvedValue([]);

    const result = await service.hybridSearch('quarterly report', {
      mode: 'vector',
      topK: 5
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('rebuild your search index');
  });
});
