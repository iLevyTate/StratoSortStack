/**
 * The embedding sidecar is durable state, not a cache.
 *
 * It used to evict its oldest entry past `_maxEmbeddingStoreSize` (10,000)
 * and zero that document's vector in Orama. Restore repairs vectors from the
 * saved sidecar, so on a library over the cap every evicted document came
 * back unusable: re-embed churn on each start, and a search that silently
 * dropped everything past the cap. With the old cap set to 3, upserting
 * a, b, c, d left only three usable documents.
 *
 * The cap is gone. These tests still set the old knob below the document
 * count, so they fail if any size limit comes back for the durable map.
 */

const os = require('os');
const path = require('path');
const fsp = require('fs').promises;

jest.mock('fs', () => jest.requireActual('fs'));
jest.mock('fs/promises', () => jest.requireActual('fs/promises'));
jest.mock('electron', () => ({ app: { getPath: jest.fn() } }));
jest.mock('../src/shared/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: () => logger };
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

const TEMP_ROOT = require('fs').mkdtempSync(
  path.join(jest.requireActual('os').tmpdir(), 'strato-orama-uncapped-')
);

const FILE_IDS = ['file:a', 'file:b', 'file:c', 'file:d', 'file:e', 'file:f'];
const FOLDER_IDS = ['folder:1', 'folder:2', 'folder:3', 'folder:4', 'folder:5'];
const OLD_CAP = 3;

/** A distinct unit-ish vector per seed. */
const vectorFor = (dimension, seed) => {
  const v = new Array(dimension).fill(0.001);
  v[seed % dimension] = 1;
  v[(seed * 7 + 3) % dimension] = 0.5;
  return v;
};

afterAll(async () => {
  await fsp.rm(TEMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe('OramaVectorService sidecar is never capped', () => {
  let dir;
  let services;

  const startService = async () => {
    const service = new OramaVectorService();
    services.push(service);
    await service.initialize();
    // The old cap knob, set below the document count. Nothing may read it.
    service._maxEmbeddingStoreSize = OLD_CAP;
    return service;
  };

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(TEMP_ROOT, 'run-'));
    app.getPath.mockReturnValue(dir);
    services = [];
    // The test file system cannot fsync a handle; stub just the .bak tmp file
    // (same approach as OramaVectorService.persistDurability.test.js).
    const realOpen = fsp.open.bind(fsp);
    jest
      .spyOn(fsp, 'open')
      .mockImplementation((file, ...rest) =>
        String(file).includes('.bak.tmp.')
          ? Promise.resolve({ sync: async () => {}, close: async () => {} })
          : realOpen(file, ...rest)
      );
  });

  afterEach(async () => {
    for (const service of services) {
      await service.shutdown().catch(() => {});
    }
    jest.restoreAllMocks();
  });

  test('more documents than the old cap all stay usable through persist and restore', async () => {
    const first = await startService();
    const dimension = first._dimension;
    for (const [i, id] of FILE_IDS.entries()) {
      await first.upsertFile({
        id,
        vector: vectorFor(dimension, i + 1),
        meta: { path: `/lib/${id.slice(5)}.txt` }
      });
    }
    for (const [i, id] of FOLDER_IDS.entries()) {
      await first.upsertFolder({
        id,
        vector: vectorFor(dimension, i + 101),
        name: `Folder ${i}`,
        path: `/lib/folder-${i}`
      });
    }
    // Let any fire-and-forget work from the upserts land.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(first._embeddingStore.files.size).toBe(FILE_IDS.length);
    expect(first._embeddingStore.folders.size).toBe(FOLDER_IDS.length);
    for (const id of FILE_IDS) {
      await expect(first.hasUsableVector(id)).resolves.toBe(true);
    }

    const saved = await first.persistAll();
    expect(saved.success).toBe(true);
    const sidecar = JSON.parse(
      await fsp.readFile(path.join(first._dataPath, 'files.sidecar.json'), 'utf8')
    );
    expect(Object.keys(sidecar).sort()).toEqual([...FILE_IDS].sort());
    const folderSidecar = JSON.parse(
      await fsp.readFile(path.join(first._dataPath, 'folders.sidecar.json'), 'utf8')
    );
    expect(Object.keys(folderSidecar).sort()).toEqual([...FOLDER_IDS].sort());
    await first.shutdown();

    const second = await startService();
    expect(second._embeddingStore.files.size).toBe(FILE_IDS.length);
    expect(second._embeddingStore.folders.size).toBe(FOLDER_IDS.length);
    for (const [i, id] of FILE_IDS.entries()) {
      // hasUsableVector is what an `onlyMissing` backfill asks before it
      // re-embeds: false here would mean a re-embed request.
      await expect(second.hasUsableVector(id)).resolves.toBe(true);
      expect(second._embeddingStore.files.get(id)).toEqual(vectorFor(dimension, i + 1));
    }
    const diagnostics = await second.getFileVectorDiagnostics();
    expect(diagnostics).toEqual(
      expect.objectContaining({
        eligibleForPrimaryVector: FILE_IDS.length,
        placeholderVectors: 0,
        missingEmbedding: 0
      })
    );
    for (const [i, id] of FOLDER_IDS.entries()) {
      expect(second._embeddingStore.folders.get(id)).toEqual(vectorFor(dimension, i + 101));
    }
  });

  test('upserting past the old cap neither evicts nor zeroes an earlier document', async () => {
    const service = await startService();
    const dimension = service._dimension;
    for (const [i, id] of ['file:a', 'file:b', 'file:c', 'file:d'].entries()) {
      await service.upsertFile({
        id,
        vector: vectorFor(dimension, i + 1),
        meta: { path: `/x/${i}` }
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { getByID } = require('@orama/orama');
    for (const id of ['file:a', 'file:b', 'file:c', 'file:d']) {
      expect(service._embeddingStore.files.has(id)).toBe(true);
      const doc = await getByID(service._databases.files, id);
      expect(doc.hasVector).toBe(true);
      await expect(service.hasUsableVector(id)).resolves.toBe(true);
    }
  });
});
