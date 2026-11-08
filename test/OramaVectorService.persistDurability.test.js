/**
 * Durability contracts of the vector store's save/shutdown/restore paths,
 * exercised against the real service, real Orama and real files in a temp dir.
 *
 * - A second cleanup()/shutdown() waits for the first one's final save.
 * - persistAll() tells its caller when the save did not reach disk.
 * - Resets and index repairs pass that on to their callers.
 * - The first write of a session is debounced like any other.
 * - A primary that reads but does not parse falls back to the rolling .bak.
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
// The real plugin uses a dynamic import() that Jest's VM rejects; Orama's own
// save() produces the same JSON shape the service parses on restore.
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

const { app } = require('electron');
const { compress, uncompress } = require('../src/shared/lz4Codec');
const { OramaVectorService } = require('../src/main/services/OramaVectorService');

const TEMP_ROOT = require('fs').mkdtempSync(
  path.join(jest.requireActual('os').tmpdir(), 'strato-orama-durability-')
);
const TEMP_DIR = path.join(TEMP_ROOT, 'compressed');

const vector = (seed = 0.1) => {
  const v = new Array(768).fill(0.01);
  v[0] = seed;
  return v;
};

afterAll(async () => {
  await fsp.rm(TEMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe('OramaVectorService persistence durability', () => {
  let service;
  let openSpy;

  beforeEach(async () => {
    await fsp.rm(TEMP_DIR, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(TEMP_DIR, { recursive: true });
    app.getPath.mockReturnValue(TEMP_DIR);
    // The test file system cannot fsync a handle; stub just the .bak tmp file
    // (same approach as OramaVectorService.lighterSaves.test.js).
    const realOpen = fsp.open.bind(fsp);
    openSpy = jest
      .spyOn(fsp, 'open')
      .mockImplementation((file, ...rest) =>
        String(file).includes('.bak.tmp.')
          ? Promise.resolve({ sync: async () => {}, close: async () => {} })
          : realOpen(file, ...rest)
      );
    service = new OramaVectorService();
    await service.initialize();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (service?.shutdown) await service.shutdown();
    openSpy = null;
  });

  test('a second shutdown waits for the final save already running in the first', async () => {
    await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/nowhere/a.txt' } });

    let releaseWrite;
    const writeGate = new Promise((resolve) => {
      releaseWrite = resolve;
    });
    let blockedWrites = 0;
    const realWrite = fsp.writeFile.bind(fsp);
    jest.spyOn(fsp, 'writeFile').mockImplementation(async (file, ...rest) => {
      if (/files\.json(\.lz4)?\.tmp\./.test(path.basename(String(file)))) {
        blockedWrites += 1;
        await writeGate;
      }
      return realWrite(file, ...rest);
    });

    const first = service.cleanup();
    // Let the first cleanup reach the blocked index write.
    for (let i = 0; i < 50 && blockedWrites === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(blockedWrites).toBeGreaterThan(0);

    let secondSettled = false;
    const second = service.shutdown().then(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The second caller (ServiceContainer at quit) must not be told shutdown
    // is done while the final save is still mid-write.
    expect(secondSettled).toBe(false);

    releaseWrite();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(secondSettled).toBe(true);

    const raw = await fsp.readFile(path.join(service._dataPath, 'files.json.lz4'));
    expect((await uncompress(raw)).toString('utf8')).toContain('file:a');
    const leftovers = (await fsp.readdir(service._dataPath)).filter((n) => n.includes('.tmp.'));
    expect(leftovers).toEqual([]);
  });

  test('persistAll reports a save that did not reach disk', async () => {
    await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/nowhere/a.txt' } });
    const realWrite = fsp.writeFile.bind(fsp);
    jest.spyOn(fsp, 'writeFile').mockImplementation(async (file, ...rest) => {
      if (/^files\.json\.lz4\.tmp\./.test(path.basename(String(file)))) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return realWrite(file, ...rest);
    });

    const result = await service.persistAll();

    expect(result).toEqual(expect.objectContaining({ success: false }));
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.code).toBe('EACCES');
  });

  test('persistAll reports success when everything was written', async () => {
    await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/nowhere/a.txt' } });
    const result = await service.persistAll();
    expect(result).toEqual({ success: true });
  });

  const failIndexWrites = () => {
    const realWrite = fsp.writeFile.bind(fsp);
    return jest.spyOn(fsp, 'writeFile').mockImplementation(async (file, ...rest) => {
      if (/\.json\.lz4\.tmp\./.test(path.basename(String(file)))) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return realWrite(file, ...rest);
    });
  };
  const { logger } = require('../src/shared/logger');

  test('resetAll tells its caller when the reset never reached disk', async () => {
    await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/nowhere/a.txt' } });
    await service.persistAll();
    logger.info.mockClear();
    failIndexWrites();

    const result = await service.resetAll();

    expect(result).toEqual(expect.objectContaining({ persisted: false }));
    expect(logger.info).not.toHaveBeenCalledWith('[OramaVectorService] All collections reset');
    // The saved index on disk still holds the old file.
    const raw = await fsp.readFile(path.join(service._dataPath, 'files.json.lz4'));
    expect((await uncompress(raw)).toString('utf8')).toContain('file:a');
  });

  test('resetAll reports persisted when the reset was saved', async () => {
    await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/nowhere/a.txt' } });
    const result = await service.resetAll();
    expect(result).toEqual(expect.objectContaining({ persisted: true }));
    const raw = await fsp.readFile(path.join(service._dataPath, 'files.json.lz4'));
    expect((await uncompress(raw)).toString('utf8')).not.toContain('file:a');
  });

  test('an embedding-model change says whether its reset reached disk', async () => {
    jest
      .spyOn(service, '_refreshEmbeddingDimension')
      .mockResolvedValue({ modelChanged: true, dimensionChanged: false, modelName: 'new-model' });
    failIndexWrites();
    const failed = await service.handleEmbeddingModelChange({
      previousModel: 'old-model',
      newModel: 'new-model'
    });
    expect(failed).toEqual(
      expect.objectContaining({ collectionsReset: true, resetPersisted: false })
    );
  });

  test('an embedding-model change that needs no reset reports no reset save', async () => {
    jest
      .spyOn(service, '_refreshEmbeddingDimension')
      .mockResolvedValue({ modelChanged: false, dimensionChanged: false, modelName: 'same' });
    const result = await service.handleEmbeddingModelChange({
      previousModel: 'same',
      newModel: 'same'
    });
    expect(result).toEqual(
      expect.objectContaining({ collectionsReset: false, resetPersisted: null })
    );
  });

  test('a single collection reset reports a failed save', async () => {
    failIndexWrites();
    await expect(service.resetFiles()).resolves.toEqual(
      expect.objectContaining({ persisted: false })
    );
    await expect(service.resetFolders()).resolves.toEqual(
      expect.objectContaining({ persisted: false })
    );
  });

  test('an index repair reports a save that did not reach disk', async () => {
    await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/nowhere/a.txt' } });
    await service.upsertFolder({
      id: 'folder:a',
      vector: vector(0.3),
      name: 'A',
      path: '/nowhere'
    });
    failIndexWrites();

    const files = await service._repairFilesVectorIndexFromCurrentState();
    const folders = await service._repairFoldersVectorIndexFromCurrentState();

    expect(files).toEqual(expect.objectContaining({ repaired: true, persisted: false }));
    expect(folders).toEqual(expect.objectContaining({ repaired: true, persisted: false }));
  });

  test('an index repair reports persisted when the save landed', async () => {
    await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/nowhere/a.txt' } });
    const files = await service._repairFilesVectorIndexFromCurrentState();
    expect(files).toEqual(expect.objectContaining({ repaired: true, persisted: true }));
  });

  test('the first write of a session is debounced, not saved immediately', async () => {
    const persistSpy = jest.spyOn(service, '_doPersist');

    await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/nowhere/a.txt' } });

    expect(persistSpy).not.toHaveBeenCalled();
    expect(service._persistTimer).not.toBeNull();
  });

  test('a primary that reads but does not parse is restored from the .bak, which survives later saves', async () => {
    await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/nowhere/a.txt' } });
    await service.persistAll();
    // Second save rotates the first generation into files.json.lz4.bak.
    await service.persistAll();
    const dataPath = service._dataPath;
    const bakPath = path.join(dataPath, 'files.json.lz4.bak');
    expect((await uncompress(await fsp.readFile(bakPath))).toString('utf8')).toContain('file:a');
    await service.shutdown();

    // A valid LZ4 frame wrapping torn JSON: it decodes, then fails to parse.
    await fsp.writeFile(
      path.join(dataPath, 'files.json.lz4'),
      await compress(Buffer.from('{"docs":{"docs":{"1":{"id":"file:a",', 'utf8'))
    );

    service = new OramaVectorService();
    await service.initialize();

    expect(await service.getFile('file:a')).toEqual(expect.objectContaining({ id: 'file:a' }));
    const names = await fsp.readdir(dataPath);
    expect(names.some((n) => /^files\.json\.lz4\.corrupt\.\d+$/.test(n))).toBe(true);

    // Later saves (including a due .bak rotation) keep file:a in the backup.
    await service.upsertFile({
      id: 'file:z',
      vector: vector(0.5),
      meta: { path: '/nowhere/z.txt' }
    });
    await service.persistAll();
    service._bakRotatedAt.clear();
    await service.persistAll();
    expect((await uncompress(await fsp.readFile(bakPath))).toString('utf8')).toContain('file:a');
  });
});

describe('OramaVectorService .bak fallback with compression off', () => {
  const PLAIN_DIR = path.join(TEMP_ROOT, 'plain');
  let previousCompress;
  let Service;
  let service;

  beforeEach(async () => {
    previousCompress = process.env.STRATOSORT_ORAMA_COMPRESS;
    process.env.STRATOSORT_ORAMA_COMPRESS = 'false';
    await fsp.rm(PLAIN_DIR, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(PLAIN_DIR, { recursive: true });
    jest.isolateModules(() => {
      require('electron').app.getPath.mockReturnValue(PLAIN_DIR);
      ({ OramaVectorService: Service } = require('../src/main/services/OramaVectorService'));
    });
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
    jest.restoreAllMocks();
    if (service?.shutdown) await service.shutdown();
    if (previousCompress === undefined) delete process.env.STRATOSORT_ORAMA_COMPRESS;
    else process.env.STRATOSORT_ORAMA_COMPRESS = previousCompress;
    await fsp.rm(PLAIN_DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('a torn files.json is restored from files.json.bak', async () => {
    service = new Service();
    await service.initialize();
    await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/nowhere/a.txt' } });
    await service.persistAll();
    await service.persistAll();
    const dataPath = service._dataPath;
    expect(await fsp.readFile(path.join(dataPath, 'files.json.bak'), 'utf8')).toContain('file:a');
    await service.shutdown();

    const primary = path.join(dataPath, 'files.json');
    const full = await fsp.readFile(primary, 'utf8');
    await fsp.writeFile(primary, full.slice(0, Math.floor(full.length / 2)));

    service = new Service();
    await service.initialize();

    expect(await service.getFile('file:a')).toEqual(expect.objectContaining({ id: 'file:a' }));
    await service.persistAll();
    service._bakRotatedAt.clear();
    await service.persistAll();
    expect(await fsp.readFile(path.join(dataPath, 'files.json.bak'), 'utf8')).toContain('file:a');
  });
});
