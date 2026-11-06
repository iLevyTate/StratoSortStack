/**
 * A save writes what changed, not the whole index.
 *
 * On a real library every save rewrote every collection in full (a 293 MB
 * passage index, its 156 MB embedding sidecar and a fresh 293 MB .bak copy),
 * every 5-30 seconds during analysis: about 785 MB per save to add one file.
 */

const path = require('path');
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

const TEMP_DIR = path.join(__dirname, 'temp-orama-lighter-saves');

describe('OramaVectorService saves only what changed', () => {
  let service;
  let writes;
  let copies;
  let writeSpy;
  let copySpy;

  beforeAll(async () => {
    await fsp.mkdir(TEMP_DIR, { recursive: true });
  });
  afterAll(async () => {
    await fsp.rm(TEMP_DIR, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    await fsp.rm(TEMP_DIR, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(TEMP_DIR, { recursive: true });
    app.getPath.mockReturnValue(TEMP_DIR);
    service = new OramaVectorService();
    await service.initialize();
    writes = [];
    copies = [];
    const realWrite = fsp.writeFile.bind(fsp);
    const realCopy = fsp.copyFile.bind(fsp);
    writeSpy = jest.spyOn(fsp, 'writeFile').mockImplementation((file, ...rest) => {
      writes.push(path.basename(String(file)));
      return realWrite(file, ...rest);
    });
    copySpy = jest.spyOn(fsp, 'copyFile').mockImplementation((src, ...rest) => {
      copies.push(path.basename(String(src)));
      return realCopy(src, ...rest);
    });
  });

  afterEach(async () => {
    writeSpy.mockRestore();
    copySpy.mockRestore();
    if (service?.shutdown) await service.shutdown();
  });

  async function save() {
    service._persistPending = true;
    await service._doPersist();
  }
  const wrote = (prefix) => writes.some((name) => name.startsWith(prefix));
  const vector = () => new Array(768).fill(0.1);

  test('after the first full save, adding a file writes only the files collection', async () => {
    await save();
    expect(wrote('fileChunks.json')).toBe(true);
    writes.length = 0;

    await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/nowhere/a.txt' } });
    await save();

    expect(wrote('files.json')).toBe(true);
    expect(wrote('fileChunks.json')).toBe(false);
    expect(wrote('fileChunks.sidecar.json')).toBe(false);
    expect(wrote('folders.json')).toBe(false);
  });

  test('a save that writes logs "Persisted databases" at info outside development', async () => {
    // The Live Activity feed only sees enabled levels; production runs at
    // info, so a debug-only line would never reach it.
    expect(process.env.NODE_ENV).not.toBe('development');
    const logger = require('../src/shared/logger').logger;
    await save();
    await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/nowhere/a.txt' } });
    logger.info.mockClear();
    logger.debug.mockClear();
    await save();

    expect(logger.info).toHaveBeenCalledWith('[OramaVectorService] Persisted databases', {
      collections: ['files'],
      full: false,
      durationMs: expect.any(Number)
    });
    expect(logger.debug).not.toHaveBeenCalledWith(
      '[OramaVectorService] Persisted databases',
      expect.anything()
    );
  });

  test('a save with nothing to write keeps "Persisted databases" at debug', async () => {
    const logger = require('../src/shared/logger').logger;
    await save();
    logger.info.mockClear();
    logger.debug.mockClear();
    await save();

    expect(logger.info).not.toHaveBeenCalledWith(
      '[OramaVectorService] Persisted databases',
      expect.anything()
    );
    expect(logger.debug).toHaveBeenCalledWith(
      '[OramaVectorService] Persisted databases',
      expect.objectContaining({ collections: [] })
    );
  });

  test('a save with nothing changed writes nothing', async () => {
    await save();
    writes.length = 0;
    await save();
    expect(writes).toEqual([]);
  });

  test('a collection object replaced by a rebuild is saved', async () => {
    await save();
    writes.length = 0;
    // Rebuilds and resets swap in a new database object without writing to it.
    service._databases.feedback = await require('@orama/orama').create({
      schema: service._schemas.feedback
    });
    await save();
    expect(wrote('feedback.json')).toBe(true);
    expect(wrote('files.json')).toBe(false);
  });

  test('the .bak copy is refreshed once, not on every save', async () => {
    // The test file system cannot fsync a handle; stub just the .bak tmp file.
    const realOpen = fsp.open.bind(fsp);
    const openSpy = jest
      .spyOn(fsp, 'open')
      .mockImplementation((file, ...rest) =>
        String(file).includes('.bak.tmp.')
          ? Promise.resolve({ sync: async () => {}, close: async () => {} })
          : realOpen(file, ...rest)
      );
    await save();
    await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/nowhere/a.txt' } });
    await save();
    // The first save had no active file to copy; this one made the .bak.
    const bakCopies = copies.filter((name) => name.startsWith('files.json')).length;
    expect(bakCopies).toBeGreaterThan(0);
    expect(await fsp.stat(path.join(service._dataPath, 'files.json.lz4.bak'))).toBeTruthy();

    await service.upsertFile({ id: 'file:b', vector: vector(), meta: { path: '/nowhere/b.txt' } });
    await save();
    expect(wrote('files.json')).toBe(true);
    expect(copies.filter((name) => name.startsWith('files.json')).length).toBe(bakCopies);
    openSpy.mockRestore();
  });

  test('persistAll writes every collection', async () => {
    await save();
    writes.length = 0;
    await service.persistAll();
    for (const name of Object.keys(service._databases)) {
      expect(wrote(`${name}.json`)).toBe(true);
    }
  });

  test('a save that fails is retried with the same collections', async () => {
    await save();
    await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/nowhere/a.txt' } });
    // Fail the index write itself (a sidecar write failure is absorbed).
    const passThrough = writeSpy.getMockImplementation();
    let failed = false;
    writeSpy.mockImplementation((file, ...rest) => {
      if (!failed && String(file).includes('files.json.lz4.tmp')) {
        failed = true;
        return Promise.reject(Object.assign(new Error('locked'), { code: 'EBUSY' }));
      }
      return passThrough(file, ...rest);
    });
    await save();
    expect(failed).toBe(true);
    writes.length = 0;
    await save();
    expect(wrote('files.json')).toBe(true);
  });
});

describe('OramaVectorService save spacing', () => {
  test('the gap between saves grows with how long the last one took', () => {
    const service = Object.create(OramaVectorService.prototype);
    service._lastPersistDurationMs = 0;
    expect(service._persistGapMs()).toBe(5000);
    service._lastPersistDurationMs = 3000;
    expect(service._persistGapMs()).toBe(60_000);
    service._lastPersistDurationMs = 20_000;
    expect(service._persistGapMs()).toBe(120_000);
  });
});
