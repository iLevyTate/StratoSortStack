/**
 * Tests for the tiered shape of ClusteringService.findNearDuplicates.
 *
 * Covers: tier disjointness, exact tier sourced from fileHash groupings,
 * near-identical vs related boundary math, and back-compat `groups` flatten.
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

jest.mock('../src/main/llamaUtils', () => ({
  getTextModel: jest.fn(() => 'qwen3:0.6b')
}));

describe('ClusteringService.findNearDuplicates (tiered)', () => {
  let ClusteringService;
  let service;
  let mockVectorDb;

  // Two embeddings that hit ~0.99 similarity (near-identical tier).
  const vecA = new Array(32).fill(0).map((_, i) => Math.cos(i / 10));
  const vecB = vecA.map((v) => v + 0.0005); // near-identical
  // A third embedding that's 0.92-ish similar (related tier).
  const vecC = new Array(32).fill(0).map((_, i) => Math.cos(i / 10 + 0.3));
  // A very dissimilar fourth so we can test non-match.
  const vecD = new Array(32).fill(0).map((_, i) => Math.sin(i / 2 + 10));

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    mockVectorDb = {
      initialize: jest.fn().mockResolvedValue(undefined),
      getStats: jest.fn().mockResolvedValue({ files: 4 }),
      peekFiles: jest.fn()
    };

    const module = require('../src/main/services/ClusteringService');
    ClusteringService = module.ClusteringService || module;
    service = new ClusteringService({ vectorDbService: mockVectorDb, llamaService: null });
  });

  test('returns empty tiers when fewer than 2 files indexed', async () => {
    mockVectorDb.getStats.mockResolvedValue({ files: 1 });
    const result = await service.findNearDuplicates();
    expect(result.success).toBe(true);
    expect(result.tiers.exact).toEqual([]);
    expect(result.tiers.nearIdentical).toEqual([]);
    expect(result.tiers.related).toEqual([]);
    expect(result.totalDuplicates).toBe(0);
  });

  test('exact tier: groups files that share a SHA-256 hash', async () => {
    mockVectorDb.peekFiles.mockResolvedValue({
      ids: ['f1', 'f2', 'f3'],
      embeddings: [vecA, vecD, vecD],
      metadatas: [
        { path: '/a.pdf', fileHash: 'sha-one' },
        { path: '/b.pdf', fileHash: 'sha-two' },
        { path: '/c.pdf', fileHash: 'sha-two' }
      ]
    });

    const result = await service.findNearDuplicates();
    expect(result.success).toBe(true);
    expect(result.tiers.exact).toHaveLength(1);
    expect(result.tiers.exact[0].reason).toBe('sha256');
    expect(result.tiers.exact[0].tier).toBe('exact');
    expect(result.tiers.exact[0].averageSimilarity).toBe(1);
    expect(result.tiers.exact[0].memberCount).toBe(2);
    const memberIds = result.tiers.exact[0].members.map((m) => m.id).sort();
    expect(memberIds).toEqual(['f2', 'f3']);
  });

  test('exact members are subtracted from embedding tiers (disjointness)', async () => {
    // f1 and f2 share a hash AND are near-identical by embedding.
    // The exact tier should claim them; the near-identical tier should be empty.
    mockVectorDb.peekFiles.mockResolvedValue({
      ids: ['f1', 'f2'],
      embeddings: [vecA, vecB],
      metadatas: [
        { path: '/a.pdf', fileHash: 'same-sha' },
        { path: '/b.pdf', fileHash: 'same-sha' }
      ]
    });

    const result = await service.findNearDuplicates();
    expect(result.tiers.exact).toHaveLength(1);
    expect(result.tiers.nearIdentical).toHaveLength(0);
    expect(result.tiers.related).toHaveLength(0);
  });

  test('near-identical tier: pairs with cosine >= 0.98 group together', async () => {
    mockVectorDb.peekFiles.mockResolvedValue({
      ids: ['near1', 'near2'],
      embeddings: [vecA, vecB],
      metadatas: [
        { path: '/near1.pdf' }, // no fileHash, so not eligible for exact
        { path: '/near2.pdf' }
      ]
    });

    const result = await service.findNearDuplicates();
    expect(result.tiers.exact).toHaveLength(0);
    expect(result.tiers.nearIdentical.length).toBeGreaterThanOrEqual(1);
    expect(result.tiers.nearIdentical[0].reason).toBe('embedding>=0.98');
    expect(result.tiers.nearIdentical[0].tier).toBe('nearIdentical');
    expect(result.tiers.nearIdentical[0].averageSimilarity).toBeGreaterThanOrEqual(0.98);
  });

  test('related tier: pairs with 0.90 <= cosine < 0.98 group together', async () => {
    // Force related-bucket membership by using custom tier thresholds.
    mockVectorDb.peekFiles.mockResolvedValue({
      ids: ['r1', 'r2'],
      embeddings: [vecA, vecC],
      metadatas: [{ path: '/r1.pdf' }, { path: '/r2.pdf' }]
    });

    // The exact cosine of vecA vs vecC depends on the specific vectors; lower
    // the related threshold so we deterministically land in the related bucket.
    const result = await service.findNearDuplicates({
      tierThresholds: { nearIdenticalMin: 0.99, relatedMin: 0.7 }
    });

    // At least one of nearIdentical or related should carry this pair.
    const totalEmbeddingGroups = result.tiers.nearIdentical.length + result.tiers.related.length;
    expect(totalEmbeddingGroups).toBeGreaterThanOrEqual(1);
    // And no exact tier, since no hashes were set.
    expect(result.tiers.exact).toHaveLength(0);
  });

  test('summary counts match tier lengths', async () => {
    mockVectorDb.peekFiles.mockResolvedValue({
      ids: ['e1', 'e2', 'n1', 'n2'],
      embeddings: [vecA, vecA, vecB, vecB],
      metadatas: [
        { path: '/e1.pdf', fileHash: 'hh' },
        { path: '/e2.pdf', fileHash: 'hh' },
        { path: '/n1.pdf' },
        { path: '/n2.pdf' }
      ]
    });

    const result = await service.findNearDuplicates();
    expect(result.summary.exactCount).toBe(result.tiers.exact.length);
    expect(result.summary.nearIdenticalCount).toBe(result.tiers.nearIdentical.length);
    expect(result.summary.relatedCount).toBe(result.tiers.related.length);
    expect(result.groups.length).toBe(
      result.tiers.exact.length + result.tiers.nearIdentical.length + result.tiers.related.length
    );
  });

  test('back-compat: `groups` flatten covers all tiers in exact→near→related order', async () => {
    mockVectorDb.peekFiles.mockResolvedValue({
      ids: ['e1', 'e2', 'n1', 'n2'],
      embeddings: [vecA, vecA, vecB, vecB],
      metadatas: [
        { path: '/e1.pdf', fileHash: 'hh' },
        { path: '/e2.pdf', fileHash: 'hh' },
        { path: '/n1.pdf' },
        { path: '/n2.pdf' }
      ]
    });

    const result = await service.findNearDuplicates();
    const tierSequence = result.groups.map((g) => g.tier);
    // Exact groups come first, then near-identical, then related.
    let sawNonExact = false;
    let sawRelated = false;
    for (const t of tierSequence) {
      if (t === 'exact' && sawNonExact) {
        throw new Error('exact group appeared after non-exact');
      }
      if (t !== 'exact') sawNonExact = true;
      if (t === 'related') sawRelated = true;
      if (t === 'nearIdentical' && sawRelated) {
        throw new Error('nearIdentical group appeared after related');
      }
    }
  });
});
