/**
 * Tests for the Phase 2 EdgeAggregator — merges shared-concept, pairwise
 * content-similarity, and centroid-bridge signals into one edge per
 * (source, target) with a structured reasons[] payload.
 */

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

// Mock ServiceContainer so we can inject the three services the aggregator reads.
const mockServices = {
  relationshipIndex: null,
  clustering: null,
  oramaVector: null
};

jest.mock('../src/main/services/ServiceContainer', () => ({
  container: {
    tryResolve: jest.fn((id) => {
      if (id === 'relationshipIndex') return mockServices.relationshipIndex;
      if (id === 'clustering') return mockServices.clustering;
      if (id === 'oramaVector') return mockServices.oramaVector;
      return null;
    }),
    has: jest.fn(() => true),
    resolve: jest.fn()
  },
  ServiceIds: {
    RELATIONSHIP_INDEX: 'relationshipIndex',
    CLUSTERING: 'clustering',
    ORAMA_VECTOR: 'oramaVector'
  }
}));

describe('EdgeAggregator', () => {
  let EdgeAggregator;

  beforeEach(() => {
    jest.clearAllMocks();
    mockServices.relationshipIndex = null;
    mockServices.clustering = null;
    mockServices.oramaVector = null;
    jest.resetModules();
    jest.doMock('../src/shared/logger', () => {
      const logger = {
        setContext: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
      };
      return { logger, createLogger: jest.fn(() => logger) };
    });
    jest.doMock('../src/main/services/ServiceContainer', () => ({
      container: {
        tryResolve: jest.fn((id) => {
          if (id === 'relationshipIndex') return mockServices.relationshipIndex;
          if (id === 'clustering') return mockServices.clustering;
          if (id === 'oramaVector') return mockServices.oramaVector;
          return null;
        }),
        has: jest.fn(() => true),
        resolve: jest.fn()
      },
      ServiceIds: {
        RELATIONSHIP_INDEX: 'relationshipIndex',
        CLUSTERING: 'clustering',
        ORAMA_VECTOR: 'oramaVector'
      }
    }));
    ({ EdgeAggregator } = require('../src/main/services/relationships/EdgeAggregator'));
  });

  test('returns empty when no seedIds provided', async () => {
    const agg = new EdgeAggregator();
    const result = await agg.getEdgesForFiles([]);
    expect(result.edges).toEqual([]);
    expect(result.neighbors).toEqual([]);
  });

  test('merges concept and content signals into ONE edge with two reasons', async () => {
    mockServices.relationshipIndex = {
      getNeighborEdges: jest.fn().mockResolvedValue({
        success: true,
        edges: [
          {
            id: 'rel:a->b',
            source: 'a',
            target: 'b',
            weight: 3,
            concepts: ['invoice', 'q3']
          }
        ],
        neighbors: ['b']
      })
    };
    mockServices.clustering = {
      clusters: [],
      findFileSimilarityEdges: jest.fn().mockResolvedValue([
        {
          id: 'sim:a->b',
          source: 'a',
          target: 'b',
          similarity: 0.87,
          type: 'similarity'
        }
      ])
    };

    const agg = new EdgeAggregator();
    const { edges, neighbors } = await agg.getEdgesForFiles(['a']);
    expect(edges).toHaveLength(1);
    const [edge] = edges;
    expect(edge.source).toBe('a');
    expect(edge.target).toBe('b');
    expect(edge.reasons).toHaveLength(2);
    const kinds = edge.reasons.map((r) => r.kind);
    // Dominant order: shared_concepts before content_similarity.
    expect(kinds[0]).toBe('shared_concepts');
    expect(kinds[1]).toBe('content_similarity');
    expect(neighbors).toEqual(['b']);
  });

  test('edges are canonicalized by (src < dst) regardless of source order', async () => {
    mockServices.relationshipIndex = {
      getNeighborEdges: jest.fn().mockResolvedValue({
        success: true,
        edges: [{ id: 'r1', source: 'zzz', target: 'aaa', weight: 5, concepts: [] }],
        neighbors: []
      })
    };
    mockServices.clustering = {
      clusters: [],
      findFileSimilarityEdges: jest
        .fn()
        .mockResolvedValue([{ id: 's1', source: 'aaa', target: 'zzz', similarity: 0.6 }])
    };
    const agg = new EdgeAggregator();
    const { edges } = await agg.getEdgesForFiles(['zzz']);
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe('aaa');
    expect(edges[0].target).toBe('zzz');
    expect(edges[0].reasons.map((r) => r.kind).sort()).toEqual([
      'content_similarity',
      'shared_concepts'
    ]);
  });

  test('centroid bridges only project to file edges with at least one seed endpoint', async () => {
    mockServices.relationshipIndex = {
      getNeighborEdges: jest.fn().mockResolvedValue({ success: true, edges: [], neighbors: [] })
    };
    mockServices.clustering = {
      clusters: [
        { id: 0, members: [{ id: 'f-seed' }] },
        { id: 1, members: [{ id: 'f-neighbor' }, { id: 'f-other' }] }
      ],
      isClustersStale: jest.fn().mockReturnValue(false),
      findFileSimilarityEdges: jest.fn().mockResolvedValue([]),
      findCrossClusterEdges: jest.fn().mockResolvedValue([
        {
          source: 'cluster:0',
          target: 'cluster:1',
          similarity: 0.72,
          sharedTerms: ['acme'],
          bridgeFiles: [
            { id: 'f-seed', clusterId: 'cluster:0' },
            { id: 'f-neighbor', clusterId: 'cluster:1' },
            { id: 'f-other', clusterId: 'cluster:1' }
          ]
        }
      ])
    };
    const agg = new EdgeAggregator();
    const { edges } = await agg.getEdgesForFiles(['f-seed']);
    // Pairs involving f-seed: (f-seed, f-neighbor), (f-seed, f-other).
    // Pair (f-neighbor, f-other) must NOT be emitted (no seed endpoint).
    expect(edges.every((e) => e.source === 'f-seed' || e.target === 'f-seed')).toBe(true);
    expect(edges).toHaveLength(2);
    for (const e of edges) {
      expect(e.reasons[0].kind).toBe('centroid_bridge');
      expect(e.reasons[0].sharedTerms).toContain('acme');
    }
  });

  test('a failure in one signal does not block others', async () => {
    mockServices.relationshipIndex = {
      getNeighborEdges: jest.fn().mockRejectedValue(new Error('index corrupt'))
    };
    mockServices.clustering = {
      clusters: [],
      findFileSimilarityEdges: jest
        .fn()
        .mockResolvedValue([{ id: 's1', source: 'a', target: 'b', similarity: 0.6 }])
    };
    const agg = new EdgeAggregator();
    const { edges } = await agg.getEdgesForFiles(['a']);
    expect(edges).toHaveLength(1);
    expect(edges[0].reasons[0].kind).toBe('content_similarity');
  });

  test('getFileMetadata joins Orama records by id', async () => {
    mockServices.oramaVector = {
      getFile: jest.fn().mockImplementation(async (id) => ({
        id,
        fileName: `${id}.pdf`,
        filePath: `/tmp/${id}.pdf`,
        tags: ['x'],
        keywords: ['y']
      }))
    };
    const agg = new EdgeAggregator();
    const files = await agg.getFileMetadata(['a', 'b']);
    expect(Object.keys(files).sort()).toEqual(['a', 'b']);
    expect(files.a.fileName).toBe('a.pdf');
    expect(files.a.filePath).toBe('/tmp/a.pdf');
  });

  test('limit caps the returned edges', async () => {
    // Create 30 concept edges; expect only 20 back when limit=20.
    const bulkEdges = [];
    for (let i = 0; i < 30; i++) {
      bulkEdges.push({
        id: `rel:a->n${i}`,
        source: 'a',
        target: `n${i}`,
        weight: 30 - i,
        concepts: ['c']
      });
    }
    mockServices.relationshipIndex = {
      getNeighborEdges: jest.fn().mockResolvedValue({
        success: true,
        edges: bulkEdges,
        neighbors: bulkEdges.map((e) => e.target)
      })
    };
    mockServices.clustering = {
      clusters: [],
      findFileSimilarityEdges: jest.fn().mockResolvedValue([])
    };
    const agg = new EdgeAggregator();
    const { edges } = await agg.getEdgesForFiles(['a'], { limit: 20 });
    expect(edges).toHaveLength(20);
  });
});
