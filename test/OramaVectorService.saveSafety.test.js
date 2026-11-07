/**
 * The vector store saves what restore reads, and its size limit is an error
 * the user sees, never a save that silently stops.
 *
 * A collection is saved as one JSON string. On a real library the passage
 * index reached 461 million characters, about 75 MB short of the longest
 * string V8 can build (536,870,888). Past that, every save threw RangeError,
 * the retry counter reset, and each later write re-ran a doomed multi-second
 * stringify while new passages were lost on restart. Most of that string was
 * Orama's index export, which restore never reads.
 */

const path = require('path');
const fsp = require('fs').promises;

const mockTracker = { raise: jest.fn(), clear: jest.fn() };
const TOO_LARGE_MARKER = 'stratosort-too-large-to-read';

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
jest.mock('../src/main/services/DegradedStateTracker', () => ({
  getInstance: () => mockTracker,
  raiseStorageFull: jest.fn(),
  clearStorageFull: jest.fn(() => true),
  STORAGE_FULL_SOURCES: { VECTOR_STORE: 'vector-store' }
}));
jest.mock('../src/shared/lz4Codec', () => {
  const real = jest.requireActual('../src/shared/lz4Codec');
  return {
    ...real,
    // A file holding the marker stands in for one that decompresses past
    // the longest string V8 can build: its toString throws like Node does.
    uncompress: jest.fn(async (input) => {
      const out = await real.uncompress(input);
      if (!out.includes(TOO_LARGE_MARKER)) return out;
      return {
        toString() {
          const error = new Error('Cannot create a string longer than 0x1fffffe8 characters');
          // @ts-ignore
          error.code = 'ERR_STRING_TOO_LONG';
          throw error;
        }
      };
    })
  };
});
jest.mock('../src/main/llamaUtils', () => ({
  getEmbeddingModel: jest.fn(() => 'nomic-embed-text-v1.5-Q8_0.gguf'),
  loadLlamaConfig: jest.fn().mockResolvedValue({
    selectedEmbeddingModel: 'nomic-embed-text-v1.5-Q8_0.gguf'
  })
}));

const { app } = require('electron');
const { logger } = require('../src/shared/logger');
const { compress, uncompress } = jest.requireActual('../src/shared/lz4Codec');
const { OramaVectorService } = require('../src/main/services/OramaVectorService');

const TEMP_DIR = path.join(__dirname, 'temp-orama-save-safety');
const vector = (value = 0.1) => new Array(768).fill(value);

describe('OramaVectorService save safety', () => {
  /** @type {any} */
  let service;

  beforeEach(async () => {
    await fsp.rm(TEMP_DIR, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(TEMP_DIR, { recursive: true });
    app.getPath.mockReturnValue(TEMP_DIR);
    jest.clearAllMocks();
    service = new OramaVectorService();
    await service.initialize();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (service?.shutdown) await service.shutdown();
  });

  afterAll(async () => {
    await fsp.rm(TEMP_DIR, { recursive: true, force: true }).catch(() => {});
  });

  /** One save, after any save already running (the first write starts one). */
  async function save() {
    while (service._currentPersistPromise || service._isPersisting) {
      await service._currentPersistPromise;
      service._currentPersistPromise = null;
      if (service._isPersisting) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    service._persistPending = true;
    await service._doPersist();
  }

  async function readSaved(name) {
    const raw = await fsp.readFile(path.join(service._dataPath, `${name}.json.lz4`));
    return JSON.parse((await uncompress(raw)).toString('utf8'));
  }

  /** Shut down (which saves), optionally change the files, then start again. */
  async function restart(beforeStart = async () => {}) {
    await service.shutdown();
    await beforeStart();
    service = new OramaVectorService();
    await service.initialize();
  }

  const persistFailures = () =>
    logger.error.mock.calls.filter(([message]) => String(message).includes('Persistence failed'))
      .length;

  describe('what a save writes', () => {
    test('the saved file holds the documents and none of the index export', async () => {
      await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/x/a.txt' } });
      await save();

      const saved = await readSaved('files');
      expect(Object.keys(saved)).toEqual(['docs']);
      const docs = Object.values(saved.docs.docs);
      expect(docs).toHaveLength(1);
      expect(docs[0]).toEqual(expect.objectContaining({ id: 'file:a' }));
    });

    test('a file saved that way comes back with its vector after a restart', async () => {
      await service.upsertFile({ id: 'file:a', vector: vector(0.3), meta: { path: '/x/a.txt' } });
      await save();
      await restart();

      const doc = await service.getFile('file:a');
      expect(doc).toEqual(expect.objectContaining({ id: 'file:a' }));
      expect(Array.from(doc.embedding)).toHaveLength(768);
      expect(doc.embedding[0]).toBeCloseTo(0.3);
    });

    test('a file in the old full-export format still restores', async () => {
      // Written by an earlier release: Orama's whole export, index included.
      const { save: oramaSave } = jest.requireActual('@orama/orama');
      await service.upsertFile({ id: 'file:old', vector: vector(), meta: { path: '/x/o.txt' } });
      // What the persistence plugin's persist(db, 'json') writes.
      const fullExport = JSON.stringify(oramaSave(service._databases.files));
      expect(Object.keys(JSON.parse(fullExport))).toEqual(
        expect.arrayContaining(['docs', 'index', 'sorting'])
      );
      const dir = service._dataPath;
      await restart(async () => {
        await fsp.writeFile(
          path.join(dir, 'files.json.lz4'),
          await compress(Buffer.from(fullExport, 'utf8'))
        );
      });

      expect(await service.getFile('file:old')).toEqual(
        expect.objectContaining({ id: 'file:old' })
      );
    });
  });

  describe('a collection too large to save', () => {
    /** Make stringify fail only for the files collection's saved JSON. */
    function failFilesStringify() {
      const realStringify = JSON.stringify;
      const calls = { files: 0 };
      jest.spyOn(JSON, 'stringify').mockImplementation(function (value, ...rest) {
        const docs = value?.docs?.docs;
        if (docs && Object.values(docs).some((doc) => doc?.id === 'file:a')) {
          calls.files += 1;
          throw new RangeError('Invalid string length');
        }
        return realStringify.call(JSON, value, ...rest);
      });
      return calls;
    }

    test('is reported, the other collections still save, and it is not retried as a failure', async () => {
      await save();
      await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/x/a.txt' } });
      await service.upsertFolder({ id: 'folder:a', vector: vector(), name: 'A', path: '/x' });
      const before = await fsp.readFile(path.join(service._dataPath, 'files.json.lz4'));
      failFilesStringify();

      await save();

      expect(mockTracker.raise).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'orama.too-large:files', severity: 'error' })
      );
      expect(persistFailures()).toBe(0);
      expect(service._persistPending).toBe(false);
      expect(await fsp.readFile(path.join(service._dataPath, 'files.json.lz4'))).toEqual(before);
      const folders = await readSaved('folders');
      expect(Object.values(folders.docs.docs).map((doc) => doc.id)).toContain('folder:a');
    });

    test('is not stringified again until it shrinks, then saving resumes', async () => {
      await save();
      await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/x/a.txt' } });
      await service.upsertFile({ id: 'file:b', vector: vector(), meta: { path: '/x/b.txt' } });
      const calls = failFilesStringify();
      await save();
      expect(calls.files).toBe(1);

      // Growing does not try again: the same multi-second stringify would fail.
      await service.upsertFile({ id: 'file:c', vector: vector(), meta: { path: '/x/c.txt' } });
      await save();
      expect(calls.files).toBe(1);

      // Fewer documents than when it failed: worth one more try.
      jest.restoreAllMocks();
      await service.deleteFileEmbedding('file:b');
      await service.deleteFileEmbedding('file:c');
      await save();

      expect(mockTracker.clear).toHaveBeenCalledWith('orama.too-large:files');
      const ids = Object.values((await readSaved('files')).docs.docs).map((doc) => doc.id);
      expect(ids).toEqual(['file:a']);
    });
  });

  describe('a collection too large to read', () => {
    async function plantTooLargeFileChunks() {
      await service.batchUpsertFileChunks([
        { id: 'chunk:a:0', vector: vector(), meta: { fileId: 'file:a', chunkIndex: 0 } }
      ]);
      const dir = service._dataPath;
      await restart(async () => {
        await fsp.writeFile(
          path.join(dir, 'fileChunks.json.lz4'),
          await compress(Buffer.from(`{"docs":{"docs":{},"note":"${TOO_LARGE_MARKER}"}}`, 'utf8'))
        );
      });
    }

    test('is left on disk as it is, not renamed as corrupt', async () => {
      await plantTooLargeFileChunks();

      const names = await fsp.readdir(service._dataPath);
      expect(names).toContain('fileChunks.json.lz4');
      expect(names.some((name) => name.includes('.corrupt.'))).toBe(false);
      expect(mockTracker.raise).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'orama.too-large:fileChunks' })
      );
    });

    test('is never saved over, blob or sidecar, while it stays unread', async () => {
      await plantTooLargeFileChunks();
      const blob = await fsp.readFile(path.join(service._dataPath, 'fileChunks.json.lz4'));
      const sidecar = await fsp.readFile(path.join(service._dataPath, 'fileChunks.sidecar.json'));

      await service.batchUpsertFileChunks([
        { id: 'chunk:b:0', vector: vector(), meta: { fileId: 'file:b', chunkIndex: 0 } }
      ]);
      await service.persistAll();

      expect(await fsp.readFile(path.join(service._dataPath, 'fileChunks.json.lz4'))).toEqual(blob);
      expect(await fsp.readFile(path.join(service._dataPath, 'fileChunks.sidecar.json'))).toEqual(
        sidecar
      );
    });

    test('a deliberate reset replaces it and saving resumes', async () => {
      await plantTooLargeFileChunks();

      await service.resetFileChunks();

      const saved = await readSaved('fileChunks');
      expect(saved.docs.docs).toEqual({});
      expect(mockTracker.clear).toHaveBeenCalledWith('orama.too-large:fileChunks');
    });
  });

  test('a write during a save leaves one save scheduled after it, not two', async () => {
    await save();
    await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/x/a.txt' } });
    const clearSpy = jest.spyOn(global, 'clearTimeout');

    service._persistPending = true;
    const running = service._doPersist();
    // A write lands mid-save and arms the debounce timer.
    service._schedulePersist();
    const armedDuringSave = service._persistTimer;
    await running;

    expect(service._persistTimer).not.toBe(armedDuringSave);
    expect(clearSpy).toHaveBeenCalledWith(armedDuringSave);
  });

  test('startup removes half-written temp files from old saves and keeps recent ones', async () => {
    const dir = service._dataPath;
    await service.shutdown();
    const stale = path.join(dir, 'fileChunks.json.lz4.tmp.a05413d8');
    const fresh = path.join(dir, 'fileChunks.json.lz4.tmp.cd6e4624');
    await fsp.writeFile(stale, 'partial');
    await fsp.writeFile(fresh, 'partial');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fsp.utimes(stale, twoHoursAgo, twoHoursAgo);

    service = new OramaVectorService();
    await service.initialize();

    const names = await fsp.readdir(dir);
    expect(names).not.toContain(path.basename(stale));
    expect(names).toContain(path.basename(fresh));
  });
});
