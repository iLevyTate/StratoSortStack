/**
 * When the lz4-napi native binding fails to load, the shared codec passes
 * bytes through unchanged. The vector store must not read that as corruption:
 * a healthy .json.lz4 stays where it is (no quarantine, no "reindex" flag),
 * saves never put plain JSON under the .lz4 name, and once the binding loads
 * again the untouched index comes back.
 *
 * Real service, real Orama, real files in a temp dir.
 */

const os = require('os');
const path = require('path');

// The shared test setup swaps fs for memfs, and a fresh module registry gets a
// fresh, empty memfs volume. These tests restart the service across module
// registries, so they run on the real file system, in an OS temp dir.
jest.mock('fs', () => jest.requireActual('fs'));
jest.mock('fs/promises', () => jest.requireActual('fs/promises'));
const fsp = require('fs').promises;

jest.mock('electron', () => ({ app: { getPath: jest.fn() } }));
jest.mock('../src/shared/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: () => logger, logger };
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
  persist: jest.fn(async (db) => JSON.stringify(require('@orama/orama').save(db))),
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

const TEMP_DIR = require('fs').mkdtempSync(
  path.join(jest.requireActual('os').tmpdir(), 'strato-orama-lz4-')
);

const vector = (seed = 0.1) => {
  const v = new Array(768).fill(0.01);
  v[0] = seed;
  return v;
};

/** Fresh module registry: service + its electron mock + the tracker it reports to. */
function loadService() {
  const { app } = require('electron');
  app.getPath.mockReturnValue(TEMP_DIR);
  const tracker = require('../src/main/services/DegradedStateTracker').getInstance();
  const raise = jest.spyOn(tracker, 'raise');
  const { OramaVectorService } = require('../src/main/services/OramaVectorService');
  return { service: new OramaVectorService(), raise };
}

function stubBakFsync() {
  // The test file system cannot fsync a handle; stub just the .bak tmp file.
  const realOpen = fsp.open.bind(fsp);
  return jest
    .spyOn(fsp, 'open')
    .mockImplementation((file, ...rest) =>
      String(file).includes('.bak.tmp.')
        ? Promise.resolve({ sync: async () => {}, close: async () => {} })
        : realOpen(file, ...rest)
    );
}

describe('OramaVectorService without a loadable LZ4 binding', () => {
  let service;

  beforeEach(async () => {
    await fsp.rm(TEMP_DIR, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(TEMP_DIR, { recursive: true });
  });

  afterEach(async () => {
    if (service?.shutdown) await service.shutdown();
    service = null;
    jest.restoreAllMocks();
    jest.dontMock('lz4-napi');
    jest.resetModules();
  });

  afterAll(async () => {
    await fsp.rm(TEMP_DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('leaves a healthy .json.lz4 untouched and gets it back once the binding loads', async () => {
    // Session 1: binding available, write a real LZ4 index holding file:a.
    stubBakFsync();
    ({ service } = loadService());
    await service.initialize();
    await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/nowhere/a.txt' } });
    await service.persistAll();
    await service.persistAll();
    const dataPath = service._dataPath;
    const lz4Path = path.join(dataPath, 'files.json.lz4');
    const bakPath = `${lz4Path}.bak`;
    const lz4Before = await fsp.readFile(lz4Path);
    const bakBefore = await fsp.readFile(bakPath);
    await service.shutdown();
    jest.restoreAllMocks();

    // Session 2: the native binding fails to load.
    jest.resetModules();
    jest.doMock('lz4-napi', () => {
      throw new Error('Cannot find native binding');
    });
    stubBakFsync();
    let raise;
    ({ service, raise } = loadService());
    expect(require('../src/shared/lz4Codec').isLz4BindingAvailable).toBe(false);
    await service.initialize();

    const names = await fsp.readdir(dataPath);
    expect(names.filter((n) => n.includes('.corrupt.'))).toEqual([]);
    expect(raise).not.toHaveBeenCalledWith(
      expect.objectContaining({ code: expect.stringMatching(/^orama\.corrupt-persistence/) })
    );
    expect(raise).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'orama.compression-unavailable' })
    );

    // Saves in this session must not overwrite the LZ4 files with plain bytes.
    await service.upsertFile({
      id: 'file:b',
      vector: vector(0.4),
      meta: { path: '/nowhere/b.txt' }
    });
    await service.persistAll();
    service._bakRotatedAt.clear();
    await service.persistAll();
    expect((await fsp.readFile(lz4Path)).equals(lz4Before)).toBe(true);
    expect((await fsp.readFile(bakPath)).equals(bakBefore)).toBe(true);
    await service.shutdown();
    jest.restoreAllMocks();

    // Session 3: binding loads again; the untouched index is restored.
    jest.dontMock('lz4-napi');
    jest.resetModules();
    stubBakFsync();
    ({ service } = loadService());
    await service.initialize();
    expect(await service.getFile('file:a')).toEqual(expect.objectContaining({ id: 'file:a' }));
  });
  test('a session without the binding never saves a collection whose .json.lz4 it could not read', async () => {
    // Session 1: binding available; files.json.lz4 + its sidecar hold file:a.
    stubBakFsync();
    ({ service } = loadService());
    await service.initialize();
    await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/nowhere/a.txt' } });
    await service.persistAll();
    const dataPath = service._dataPath;
    const lz4Path = path.join(dataPath, 'files.json.lz4');
    const jsonPath = path.join(dataPath, 'files.json');
    const sidecarPath = path.join(dataPath, 'files.sidecar.json');
    const lz4Before = await fsp.readFile(lz4Path);
    const sidecarBefore = await fsp.readFile(sidecarPath);
    await service.shutdown();
    jest.restoreAllMocks();

    // Session 2: the binding fails to load. It starts without file:a and must
    // not write its own, smaller files collection anywhere restore would read.
    jest.resetModules();
    jest.doMock('lz4-napi', () => {
      throw new Error('Cannot find native binding');
    });
    stubBakFsync();
    ({ service } = loadService());
    await service.initialize();
    await service.batchUpsertFiles([
      { id: 'file:b', vector: vector(0.4), meta: { path: '/nowhere/b.txt' } }
    ]);
    await service.persistAll();
    await service.shutdown();
    jest.restoreAllMocks();

    expect((await fsp.readFile(lz4Path)).equals(lz4Before)).toBe(true);
    expect((await fsp.readFile(sidecarPath)).equals(sidecarBefore)).toBe(true);
    await expect(fsp.access(jsonPath)).rejects.toMatchObject({ code: 'ENOENT' });

    // Session 3: binding back; file:a comes back with its saved vector.
    jest.dontMock('lz4-napi');
    jest.resetModules();
    stubBakFsync();
    ({ service } = loadService());
    await service.initialize();
    expect(await service.getFile('file:a')).toEqual(expect.objectContaining({ id: 'file:a' }));
    expect(service._embeddingStore.files.has('file:a')).toBe(true);
  });
  test('a plain .json newer than the .json.lz4 is kept aside, not deleted, by the next save', async () => {
    stubBakFsync();
    ({ service } = loadService());
    await service.initialize();
    await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/nowhere/a.txt' } });
    await service.persistAll();
    const dataPath = service._dataPath;
    const jsonPath = path.join(dataPath, 'files.json');
    // Written by an older binding-less session, after the .lz4.
    await fsp.writeFile(jsonPath, '{"newer":true}');
    const later = new Date(Date.now() + 60_000);
    await fsp.utimes(jsonPath, later, later);

    await service.persistAll();

    const names = await fsp.readdir(dataPath);
    const kept = names.filter((n) => /^files\.json\.newer-than-lz4\.\d+\.bak$/.test(n));
    expect(names).not.toContain('files.json');
    expect(kept).toHaveLength(1);
    expect(await fsp.readFile(path.join(dataPath, kept[0]), 'utf8')).toBe('{"newer":true}');
  });

  test('an older plain .json beside the .json.lz4 is still removed by a save', async () => {
    stubBakFsync();
    ({ service } = loadService());
    await service.initialize();
    await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/nowhere/a.txt' } });
    await service.persistAll();
    const dataPath = service._dataPath;
    const jsonPath = path.join(dataPath, 'files.json');
    await fsp.writeFile(jsonPath, '{"older":true}');
    const earlier = new Date(Date.now() - 60 * 60_000);
    await fsp.utimes(jsonPath, earlier, earlier);

    await service.persistAll();

    const names = await fsp.readdir(dataPath);
    expect(names).not.toContain('files.json');
    expect(names.some((n) => n.includes('newer-than-lz4'))).toBe(false);
  });
});
