/**
 * Regression: hybridSearch never forwarded options.precomputedEmbedding into
 * _executeHybridSearchInternal, so callers that already held the query
 * embedding (ChatService retrieval passes it "to save a redundant inference
 * call") still triggered a fresh embedText — competing for the single
 * inference slot and frequently timing out into bm25-fallback during chat.
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

const DIM = 768;

function makeService() {
  const vectorDbService = {
    initialize: jest.fn().mockResolvedValue(true),
    isOnline: true,
    getStats: jest.fn().mockResolvedValue({ files: 1, fileChunks: 0, folders: 0 }),
    getCollectionDimension: jest.fn().mockResolvedValue(DIM),
    querySimilarFiles: jest.fn().mockResolvedValue([]),
    querySimilarChunks: jest.fn().mockResolvedValue([]),
    getChunksForFile: jest.fn().mockResolvedValue([]),
    peekFiles: jest.fn().mockResolvedValue({ ids: [], embeddings: [], metadatas: [] }),
    getFile: jest.fn().mockResolvedValue(null)
  };

  const embedding = {
    embedText: jest.fn().mockResolvedValue({ vector: new Array(DIM).fill(0.1) })
  };

  const service = new SearchService({
    vectorDbService,
    analysisHistoryService: {
      initialize: jest.fn().mockResolvedValue(undefined),
      analysisHistory: { metadata: { totalEntries: 0 }, entries: {} }
    },
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
  service.bm25Search = jest.fn().mockResolvedValue([]);

  return { service, embedding };
}

describe('SearchService — precomputedEmbedding plumbing', () => {
  test('hybrid mode uses the caller-provided embedding instead of re-embedding', async () => {
    const { service, embedding } = makeService();

    const result = await service.hybridSearch('quarterly report', {
      mode: 'hybrid',
      topK: 5,
      precomputedEmbedding: { vector: new Array(DIM).fill(0.2) }
    });

    expect(result.success).toBe(true);
    expect(embedding.embedText).not.toHaveBeenCalled();
  });
});
