/**
 * @jest-environment node
 */
/**
 * The Duplicate Finder must not silently drop part of a large library. The
 * exact (SHA-256) tier is O(n) and covers every embedded file the vector store
 * can enumerate; the O(n^2) embedding tiers keep their row cap, and any cap
 * that applies is reported as a partial result (truncated + counts + warning).
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

function makeLibrary(count, { vectorFor = () => [], hashFor = (i) => `sha-${i}` } = {}) {
  const ids = [];
  const embeddings = [];
  const metadatas = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(`f${i}`);
    embeddings.push(vectorFor(i));
    metadatas.push({
      path: `/library/f${i}.pdf`,
      filePath: `/library/f${i}.pdf`,
      fileName: `f${i}.pdf`,
      fileHash: hashFor(i)
    });
  }
  return { ids, embeddings, metadatas };
}

/** Vector store mock whose peekFiles honours its limit and the real 10000 clamp. */
function makeVectorDb(library, totalFiles = library.ids.length) {
  return {
    initialize: jest.fn().mockResolvedValue(undefined),
    getStats: jest.fn().mockResolvedValue({ files: totalFiles }),
    peekFiles: jest.fn(async (limit) => {
      const n = Math.max(1, Math.min(Number(limit) || 50, 10000));
      return {
        ids: library.ids.slice(0, n),
        embeddings: library.embeddings.slice(0, n),
        metadatas: library.metadatas.slice(0, n)
      };
    })
  };
}

function loadService(vectorDb) {
  jest.resetModules();
  const mod = require('../src/main/services/ClusteringService');
  const ClusteringService = mod.ClusteringService || mod;
  return new ClusteringService({ vectorDbService: vectorDb, llamaService: null });
}

describe('ClusteringService.findNearDuplicates coverage on large libraries', () => {
  test('finds byte-identical files that sit beyond the first 1000 indexed rows', async () => {
    const library = makeLibrary(1500, {
      hashFor: (i) => (i === 1200 || i === 1300 ? 'sha-same' : `sha-${i}`)
    });
    const service = loadService(makeVectorDb(library));

    const result = await service.findNearDuplicates();

    expect(result.success).toBe(true);
    expect(result.tiers.exact).toHaveLength(1);
    expect(result.tiers.exact[0].members.map((m) => m.id).sort()).toEqual(['f1200', 'f1300']);
    expect(result.summary.scannedFiles).toBe(1500);
    expect(result.summary.totalFiles).toBe(1500);
  });

  test('reports the embedding comparison as partial when more files exist than it compares', async () => {
    // 1100 distinct unit vectors, none similar to each other.
    const dim = 8;
    const library = makeLibrary(1100, {
      vectorFor: (i) => {
        const v = new Array(dim).fill(0);
        v[i % dim] = 1;
        v[(i * 3 + 1) % dim] = i % 2 ? -1 : 0.5;
        return v;
      }
    });
    const service = loadService(makeVectorDb(library));

    const result = await service.findNearDuplicates({ threshold: 0.999 });

    expect(result.success).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.summary.truncated).toBe(true);
    expect(result.summary.comparedFiles).toBe(1000);
    expect(typeof result.warning).toBe('string');
    expect(result.warning).toMatch(/1,?000/);
  }, 60000);

  test('marks the result partial when the store holds more files than one scan can read', async () => {
    const library = makeLibrary(10000);
    const service = loadService(makeVectorDb(library, 12000));

    const result = await service.findNearDuplicates();

    expect(result.success).toBe(true);
    expect(result.summary.scannedFiles).toBe(10000);
    expect(result.summary.totalFiles).toBe(12000);
    expect(result.summary.truncated).toBe(true);
    expect(result.truncated).toBe(true);
    expect(typeof result.warning).toBe('string');
  }, 60000);

  test('a complete scan of a small library is not marked partial', async () => {
    const library = makeLibrary(3, { hashFor: (i) => (i < 2 ? 'sha-same' : 'sha-other') });
    const service = loadService(makeVectorDb(library));

    const result = await service.findNearDuplicates();

    expect(result.tiers.exact).toHaveLength(1);
    expect(result.summary.truncated).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.warning).toBeUndefined();
  });
});
