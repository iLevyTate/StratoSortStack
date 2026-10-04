/**
 * @jest-environment node
 *
 * The relevance gate used to run AFTER the top-k slice. With "Search
 * context" on, the top-k were the search tab's files, so the ones the gate
 * dropped as off-topic were never replaced by library hits and a turn could
 * end with no sources at all (audit CH-03).
 */

const { RetrievalEngine } = require('../src/main/services/chat/RetrievalEngine');

function hit(id, score, extra = {}) {
  return {
    id,
    score,
    metadata: { path: `/${id}.txt`, name: `${id}.txt`, summary: `about ${id}` },
    matchDetails: { hybrid: { vectorRawScore: score }, bestSnippet: `snippet ${id}` },
    ...extra
  };
}

function makeEngine({ libraryHits, contextScores }) {
  const searchService = {
    hybridSearch: jest.fn(async () => ({ success: true, results: libraryHits })),
    chunkSearch: jest.fn(async () => []),
    enrichResults: jest.fn()
  };
  const vectorDbService = {
    initialize: jest.fn(),
    getCollectionDimension: jest.fn(async () => 2),
    getFile: jest.fn(async (id) => ({
      filePath: `/${id}.txt`,
      fileName: `${id}.txt`,
      embedding: contextScores[id] ?? null
    }))
  };
  const embeddingService = { embedText: jest.fn(async () => ({ vector: [1, 0] })) };
  return new RetrievalEngine({
    searchService,
    vectorDbService,
    embeddingService,
    settingsService: { getAll: async () => ({}) },
    defaults: { chunkTopK: 10, topK: 3, mode: 'hybrid', contextFileLimit: 200 }
  });
}

describe('RetrievalEngine: relevance gate runs before the top-k slice', () => {
  test('off-topic context files are replaced by library hits instead of leaving the turn empty', async () => {
    // Context files embed nearly orthogonal to the query vector [1, 0]:
    // cosine 0.1, below the 0.30 gate. Library hits are strong.
    const engine = makeEngine({
      libraryHits: [hit('lease', 0.82), hit('lease-addendum', 0.71), hit('tax-note', 0.55)],
      contextScores: { tax1: [0.1, 0.995], tax2: [0.1, 0.995], tax3: [0.1, 0.995] }
    });

    const { sources, meta } = await engine.retrieveSources('what does my lease say about pets', {
      topK: 3,
      mode: 'hybrid',
      contextFileIds: ['tax1', 'tax2', 'tax3']
    });

    expect(sources.map((s) => s.name)).toEqual(['lease.txt', 'lease-addendum.txt', 'tax-note.txt']);
    expect(meta.contextBoosted).toBe(true);
    expect(meta.droppedLowRelevance).toBe(3);
  });

  test('relevant context files still come first and the result is capped at top-k', async () => {
    const engine = makeEngine({
      libraryHits: [hit('lease', 0.82), hit('lease-addendum', 0.71)],
      contextScores: { memo: [0.9, 0.436], memo2: [0.8, 0.6] }
    });

    const { sources } = await engine.retrieveSources('pets', {
      topK: 3,
      mode: 'hybrid',
      contextFileIds: ['memo', 'memo2']
    });

    expect(sources).toHaveLength(3);
    expect(sources.slice(0, 2).map((s) => s.name)).toEqual(['memo.txt', 'memo2.txt']);
    expect(sources[2].name).toBe('lease.txt');
  });
});
