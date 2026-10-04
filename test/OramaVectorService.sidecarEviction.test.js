/**
 * Regression: _markSidecarEvicted is fire-and-forget. When the sidecar LRU
 * evicts id X during upsertFile(A), and X is re-upserted with a fresh vector
 * before the async mark runs, the mark's getByID reads the FRESH doc and
 * zeroes it (hasVector:false + zero embedding) — knocking X out of vector
 * search until a repair pass, even though the sidecar holds its live vector.
 *
 * The fix re-checks the sidecar inside the async callback: if the id is
 * present again, the eviction is stale and must not zero anything.
 */

const fs = require('fs').promises;
const path = require('path');

jest.mock('electron', () => ({
  app: { getPath: jest.fn() }
}));

jest.mock('../src/shared/logger', () => {
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  };
  return { createLogger: () => mockLogger, __mockLogger: mockLogger };
});

jest.mock('../src/shared/singletonFactory', () => ({
  createSingletonHelpers: () => ({
    getInstance: jest.fn(),
    createInstance: jest.fn(),
    registerWithContainer: jest.fn(),
    resetInstance: jest.fn()
  })
}));

jest.mock('@orama/plugin-data-persistence', () => ({
  persist: jest.fn(async () => '{}'),
  restore: jest.fn(async () => {
    throw new Error('restore not available in test');
  })
}));

jest.mock('../src/main/llamaUtils', () => ({
  getEmbeddingModel: jest.fn(() => 'nomic-embed-text-v1.5-Q8_0.gguf'),
  loadLlamaConfig: jest.fn().mockResolvedValue({
    selectedEmbeddingModel: 'nomic-embed-text-v1.5-Q8_0.gguf'
  })
}));

const { app } = require('electron');
const { OramaVectorService } = require('../src/main/services/OramaVectorService');

const TEMP_DIR = path.join(__dirname, 'temp-orama-sidecar-eviction');

describe('OramaVectorService — sidecar eviction vs re-upsert race', () => {
  let service;

  beforeAll(async () => {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  });

  afterAll(async () => {
    try {
      await fs.rm(TEMP_DIR, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  beforeEach(async () => {
    app.getPath.mockReturnValue(TEMP_DIR);
    service = new OramaVectorService();
    await service.initialize();
    service._maxEmbeddingStoreSize = 2;
  });

  afterEach(async () => {
    if (service?.shutdown) await service.shutdown();
  });

  const vec = (seed) => {
    const v = new Array(service._dimension).fill(0);
    v[0] = seed;
    return v;
  };

  test('a re-upserted id is not zeroed by the stale eviction mark', async () => {
    const { getByID } = require('@orama/orama');

    await service.upsertFile({ id: 'file:a', vector: vec(0.1), meta: { path: '/x/a.txt' } });
    await service.upsertFile({ id: 'file:b', vector: vec(0.2), meta: { path: '/x/b.txt' } });

    // Overflows the 2-entry sidecar: evicts LRU 'file:a' and fires the
    // async _markSidecarEvicted('file:a').
    const overflow = service.upsertFile({
      id: 'file:c',
      vector: vec(0.3),
      meta: { path: '/x/c.txt' }
    });

    // Re-upsert 'file:a' with a fresh vector before the mark's async
    // getByID/update chain has run.
    await overflow;
    await service.upsertFile({ id: 'file:a', vector: vec(0.9), meta: { path: '/x/a.txt' } });

    // Let the fire-and-forget mark task drain.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const doc = await getByID(service._databases.files, 'file:a');
    expect(doc.hasVector).toBe(true);
    expect(doc.embedding[0]).toBeCloseTo(0.9);
  });
});
