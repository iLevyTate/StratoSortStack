/**
 * Hybrid fusion must not silently cut honest matches (K-24).
 *
 * UI weights: BM25 beta 0.25, file vector alpha 0.375, chunk gamma 0.375,
 * minScore 0.15 applied to the fused score. Before this:
 *
 * - a leg that returned nothing kept its weight, so every score was capped
 *   at the weight of the legs that answered (0.625 with no chunk vectors);
 * - BM25 was min-max normalized, so the weakest keyword hit in the window
 *   scored exactly 0;
 * - a file analyzed but never embedded could only ever score beta x keyword
 *   (<= 0.25), so with 11 of 281 files embedded most keyword matches were cut;
 * - graph-expansion neighbours top out at 0.12 and were floored at 0.15
 *   afterwards, so none ever survived.
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

const hit = (id, score) => ({ id, score, metadata: { path: `/docs/${id}.txt` }, matchDetails: {} });

function makeService({ isKnownUnembedded } = {}) {
  const vectorDbService = {
    initialize: jest.fn().mockResolvedValue(true),
    isOnline: true,
    getStats: jest.fn().mockResolvedValue({ files: 3, fileChunks: 3, folders: 0 }),
    getChunksForFile: jest.fn().mockResolvedValue([]),
    getFile: jest.fn().mockResolvedValue(null),
    markEmbeddingsOrphaned: jest.fn().mockResolvedValue({ marked: 0, failed: 0 })
  };
  if (isKnownUnembedded) vectorDbService.isKnownUnembedded = isKnownUnembedded;

  const service = new SearchService({
    vectorDbService,
    analysisHistoryService: {
      initialize: jest.fn().mockResolvedValue(undefined),
      analysisHistory: { metadata: { totalEntries: 0 }, entries: {} }
    },
    parallelEmbeddingService: {
      embedText: jest.fn().mockResolvedValue({ vector: [0.1, 0.2, 0.3] })
    },
    reRankerService: null,
    queryProcessor: null,
    relationshipIndexService: null
  });

  service._enrichResults = jest.fn();
  service._applyGraphExpansion = jest.fn(async (results) => ({
    results,
    meta: { enabled: false }
  }));
  service._validateFileExistence = jest.fn(async (results) => ({
    validResults: results,
    ghostCount: 0
  }));
  service.isIndexStale = jest.fn(() => false);
  service.buildBM25Index = jest.fn().mockResolvedValue({ success: true, indexed: 0 });
  service.chunkSearch = jest.fn().mockResolvedValue([]);
  service._queryProcessorInitialized = true;
  service.queryProcessor = null;
  return service;
}

const OPTIONS = { topK: 20, minScore: 0.15, mode: 'hybrid', chunkWeight: 0.5 };

function byId(res) {
  return new Map(res.results.map((r) => [r.id, r]));
}

describe('SearchService hybrid fusion (K-24)', () => {
  test('a leg with no hits does not cap every score (renormalized over the legs that answered)', async () => {
    const service = makeService();
    service.bm25Search = jest.fn().mockResolvedValue([hit('a', 10), hit('b', 5)]);
    service._vectorSearchWithTimeout = jest.fn().mockResolvedValue({
      timedOut: false,
      results: [hit('a', 0.8), hit('c', 0.45), hit('d', 0.3)]
    });
    // No chunk vectors: the chunk leg answers nothing.

    const res = await service.hybridSearch('lease renewal', OPTIONS);
    const got = byId(res);

    expect(res.success).toBe(true);
    // a: (0.375 x 1 + 0.25 x 1) / 0.625 = 1.0 (was capped at 0.625).
    expect(got.get('a').score).toBeCloseTo(1, 5);
    // c: vector n = (0.45-0.3)/0.5 = 0.3 -> 0.375 x 0.3 / 0.625 = 0.18 (was 0.1125, cut).
    expect(got.get('c').score).toBeCloseTo(0.18, 5);
    // b: keyword-only, n = 5/10 -> 0.25 x 0.5 / 0.625 = 0.2 (min-max made it 0, cut).
    expect(got.get('b').score).toBeCloseTo(0.2, 5);
    // d: weakest vector hit, still 0 under min-max: cut.
    expect(got.has('d')).toBe(false);
    expect(res.results.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(res.meta.queryScale).toBeCloseTo(1.6, 5);
  });

  test('a never-embedded file is scored on keywords alone; an embedded, dissimilar one is not', async () => {
    const service = makeService({ isKnownUnembedded: (id) => id === 'unembedded' });
    service.bm25Search = jest
      .fn()
      .mockResolvedValue([hit('a', 10), hit('unembedded', 8), hit('embedded', 8)]);
    service._vectorSearchWithTimeout = jest.fn().mockResolvedValue({
      timedOut: false,
      results: [hit('a', 0.8), hit('f', 0.4)]
    });
    service.chunkSearch = jest.fn().mockResolvedValue([hit('a', 0.7), hit('f', 0.5)]);

    const res = await service.hybridSearch('invoice 12345', OPTIONS);
    const got = byId(res);

    // The vector legs could never have scored it: keyword score (0.8) stands.
    expect(got.get('unembedded').score).toBeCloseTo(0.8, 5);
    expect(got.get('unembedded').matchDetails.hybrid.keywordOnly).toBe(true);
    // Has a vector and was not similar: the zero semantic credit is real.
    expect(got.get('embedded').score).toBeCloseTo(0.25 * 0.8, 5);
    expect(got.get('embedded').matchDetails.hybrid.keywordOnly).toBe(false);
  });

  test('without the store lookup, scoring stays conservative', async () => {
    const service = makeService();
    service.bm25Search = jest.fn().mockResolvedValue([hit('a', 10), hit('x', 8)]);
    service._vectorSearchWithTimeout = jest.fn().mockResolvedValue({
      timedOut: false,
      results: [hit('a', 0.8), hit('f', 0.4)]
    });
    service.chunkSearch = jest.fn().mockResolvedValue([hit('a', 0.7), hit('f', 0.5)]);

    const res = await service.hybridSearch('invoice', OPTIONS);

    expect(byId(res).get('x').score).toBeCloseTo(0.25 * 0.8, 5);
  });

  test('graph-expansion neighbours survive the score floor', async () => {
    const service = makeService();
    service._applyGraphExpansion = SearchService.prototype._applyGraphExpansion.bind(service);
    service.relationshipIndex = {
      getNeighborEdges: jest.fn().mockResolvedValue({
        edges: [{ source: 'a', target: 'neighbour', weight: 1, concepts: ['lease'] }]
      })
    };
    service.bm25Search = jest.fn().mockResolvedValue([hit('a', 10)]);
    service._vectorSearchWithTimeout = jest.fn().mockResolvedValue({
      timedOut: false,
      results: [hit('a', 0.8), hit('low', 0.2)]
    });

    const res = await service.hybridSearch('lease', {
      ...OPTIONS,
      graphExpansion: true,
      graphExpansionWeight: 0.2
    });
    const ids = res.results.map((r) => r.id);

    expect(ids[0]).toBe('a');
    expect(ids).toContain('neighbour');
    // The below-floor direct match is still cut; only the neighbour is exempt.
    expect(ids).not.toContain('low');
    expect(byId(res).get('neighbour').score).toBeLessThan(0.15);
  });
});

describe('SearchService._normalizeByMax', () => {
  test('keeps near-tied BM25 hits near-tied instead of mapping the weaker to 0', () => {
    const service = makeService();
    const out = service._normalizeByMax([hit('a', 9.1), hit('b', 8.9)]);
    expect(out[0].score).toBe(1);
    expect(out[1].score).toBeCloseTo(8.9 / 9.1, 5);
    expect(out[1].originalScore).toBe(8.9);
  });

  test('all-zero or empty input is safe', () => {
    const service = makeService();
    expect(service._normalizeByMax([])).toEqual([]);
    expect(service._normalizeByMax([hit('a', 0)])[0].score).toBe(0);
  });
});
