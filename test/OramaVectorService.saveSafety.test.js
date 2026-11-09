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

    test('the saved bytes are exactly what one JSON.stringify of them gives', async () => {
      await service.upsertFile({ id: 'file:a', vector: vector(0.25), meta: { path: '/x/a.txt' } });
      await service.upsertFile({ id: 'file:b', vector: vector(0.5), meta: { path: '/x/b"q.txt' } });
      await save();

      const raw = await fsp.readFile(path.join(service._dataPath, 'files.json.lz4'));
      const docsStore = service._databases.files.data.docs;
      expect((await uncompress(raw)).toString('utf8')).toBe(
        JSON.stringify({ docs: { docs: docsStore.docs, count: docsStore.count } })
      );
      const sidecar = await fsp.readFile(
        path.join(service._dataPath, 'files.sidecar.json'),
        'utf8'
      );
      expect(sidecar).toBe(JSON.stringify(Object.fromEntries(service._embeddingStore.files)));
    });

    test('a large save yields to the event loop instead of blocking it', async () => {
      const many = Array.from({ length: 800 }, (_, i) => ({
        id: `chunk:big:${i}`,
        vector: vector(0.123456789 + i / 1e6),
        meta: { fileId: 'file:big', chunkIndex: i }
      }));
      await service.batchUpsertFileChunks(many);
      // Count event-loop turns, and note the turn the first and the last
      // passage are serialized in.
      let turns = 0;
      let running = true;
      const turn = () => {
        turns += 1;
        if (running) setImmediate(turn);
      };
      setImmediate(turn);
      const realStringify = JSON.stringify;
      /** @type {number[]} turns elapsed between the first and the last passage, per save */
      const spans = [];
      let firstAt = 0;
      jest.spyOn(JSON, 'stringify').mockImplementation(function (value, ...rest) {
        if (value && typeof value === 'object' && value.id === 'chunk:big:0') firstAt = turns;
        if (value && typeof value === 'object' && value.id === 'chunk:big:799') {
          spans.push(turns - firstAt);
        }
        return realStringify.call(JSON, value, ...rest);
      });
      try {
        await service.persistAll();
      } finally {
        running = false;
      }
      // ~7 MB of passage JSON: the event loop ran while it was being built.
      expect(spans.length).toBeGreaterThan(0);
      expect(Math.min(...spans)).toBeGreaterThan(0);
      const saved = await readSaved('fileChunks');
      expect(Object.keys(saved.docs.docs)).toHaveLength(800);
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
    /**
     * Make the files collection's saved JSON fail as if past the longest
     * string V8 can build. A save serializes it one document at a time, so
     * the failure comes from the document file:a.
     */
    function failFilesStringify() {
      const realStringify = JSON.stringify;
      const calls = { files: 0 };
      jest.spyOn(JSON, 'stringify').mockImplementation(function (value, ...rest) {
        if (value && typeof value === 'object' && value.id === 'file:a') {
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

    test('its embedding sidecar is not rewritten either while it stays too large', async () => {
      await save();
      await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/x/a.txt' } });
      failFilesStringify();
      await save();
      const sidecarPath = path.join(service._dataPath, 'files.sidecar.json');
      const sidecarIds = async () =>
        Object.keys(JSON.parse(await fsp.readFile(sidecarPath, 'utf8')));
      const before = await sidecarIds();

      await service.upsertFile({ id: 'file:b', vector: vector(), meta: { path: '/x/b.txt' } });
      await save();

      expect(await sidecarIds()).toEqual(before);
      expect(before).not.toContain('file:b');
    });

    test('a sidecar too long to build is reported as too large, not retried as a failure', async () => {
      await save();
      await service.batchUpsertFileChunks([
        { id: 'chunk:a:0', vector: vector(), meta: { fileId: 'file:a', chunkIndex: 0 } }
      ]);
      await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/x/a.txt' } });
      const realStringify = JSON.stringify;
      const calls = { sidecar: 0, blob: 0 };
      jest.spyOn(JSON, 'stringify').mockImplementation(function (value, ...rest) {
        // The fileChunks sidecar is keyed by chunk id (the blob by Orama's
        // internal ids), so a chunk id as a key means the sidecar.
        if (typeof value === 'string' && value.startsWith('chunk:')) {
          calls.sidecar += 1;
          throw new RangeError('Invalid string length');
        }
        if (value && typeof value === 'object' && String(value.id).startsWith('chunk:')) {
          calls.blob += 1;
        }
        return realStringify.call(JSON, value, ...rest);
      });

      await save();
      await service.batchUpsertFileChunks([
        { id: 'chunk:a:1', vector: vector(), meta: { fileId: 'file:a', chunkIndex: 1 } }
      ]);
      await save();

      expect(persistFailures()).toBe(0);
      expect(service._persistPending).toBe(false);
      expect(mockTracker.raise).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'orama.too-large:fileChunks' })
      );
      // Not re-run on the next round, and the larger blob is not attempted.
      expect(calls.sidecar).toBe(1);
      expect(calls.blob).toBe(0);
      const files = await readSaved('files');
      expect(Object.values(files.docs.docs).map((doc) => doc.id)).toContain('file:a');
    });

    test('is tried again after a while even when it has as many documents as when it failed', async () => {
      await save();
      await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/x/a.txt' } });
      await service.upsertFile({ id: 'file:b', vector: vector(), meta: { path: '/x/b.txt' } });
      const calls = failFilesStringify();
      await save();
      expect(calls.files).toBe(1);

      // Swap a document: same count, smaller payload. Not retried straight away.
      jest.restoreAllMocks();
      await service.deleteFileEmbedding('file:b');
      await service.upsertFile({ id: 'file:c', vector: vector(), meta: { path: '/x/c.txt' } });
      await save();
      expect(mockTracker.clear).not.toHaveBeenCalledWith('orama.too-large:files');

      const later = Date.now() + 31 * 60 * 1000;
      jest.spyOn(Date, 'now').mockReturnValue(later);
      await service.upsertFile({ id: 'file:d', vector: vector(), meta: { path: '/x/d.txt' } });
      await save();

      expect(mockTracker.clear).toHaveBeenCalledWith('orama.too-large:files');
      const ids = Object.values((await readSaved('files')).docs.docs).map((doc) => doc.id);
      expect(ids.sort()).toEqual(['file:a', 'file:c', 'file:d']);
    });

    test('a repair of it reports that the rebuilt index did not reach disk', async () => {
      await save();
      await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/x/a.txt' } });
      failFilesStringify();

      const repair = await service._repairFilesVectorIndexFromCurrentState();

      expect(repair.repaired).toBe(true);
      expect(repair.persisted).toBe(false);
    });

    test('a save report counts only the collections the caller names', () => {
      const saved = { success: true, tooLargeToSave: ['files'] };
      expect(service._reportSave('Files vector index rebuilt', saved, ['files'])).toEqual(
        expect.objectContaining({ persisted: false })
      );
      expect(service._reportSave('Folders vector index rebuilt', saved, ['folders'])).toEqual({
        persisted: true
      });
    });

    test('the last save before quitting tries it once more', async () => {
      await save();
      await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/x/a.txt' } });
      failFilesStringify();
      await save();

      jest.restoreAllMocks();
      await service.upsertFile({ id: 'file:c', vector: vector(), meta: { path: '/x/c.txt' } });
      const dir = service._dataPath;
      await service.shutdown();

      const raw = await fsp.readFile(path.join(dir, 'files.json.lz4'));
      const saved = JSON.parse((await uncompress(raw)).toString('utf8'));
      expect(
        Object.values(saved.docs.docs)
          .map((doc) => doc.id)
          .sort()
      ).toEqual(['file:a', 'file:c']);
    });

    test('the last save before quitting tries it even with no write since it failed', async () => {
      await save();
      await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/x/a.txt' } });
      failFilesStringify();
      await save();

      jest.restoreAllMocks();
      const dir = service._dataPath;
      await service.shutdown();

      const raw = await fsp.readFile(path.join(dir, 'files.json.lz4'));
      const saved = JSON.parse((await uncompress(raw)).toString('utf8'));
      expect(Object.values(saved.docs.docs).map((doc) => doc.id)).toEqual(['file:a']);
    });

    test('the last save before quitting tries it even after a save round skipped it', async () => {
      await save();
      await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: '/x/a.txt' } });
      await service.upsertFile({ id: 'file:b', vector: vector(), meta: { path: '/x/b.txt' } });
      const calls = failFilesStringify();
      await save();
      expect(calls.files).toBe(1);

      // Same count, smaller payload: the next round skips it, and the
      // shutdown save after that round still writes the session's changes.
      jest.restoreAllMocks();
      await service.deleteFileEmbedding('file:b');
      await service.upsertFile({ id: 'file:c', vector: vector(), meta: { path: '/x/c.txt' } });
      logger.info.mockClear();
      await save();
      expect(mockTracker.clear).not.toHaveBeenCalledWith('orama.too-large:files');
      // The skipped round does not claim it saved the collection.
      expect(logger.info).not.toHaveBeenCalledWith(
        '[OramaVectorService] Persisted databases',
        expect.objectContaining({ collections: expect.arrayContaining(['files']) })
      );
      const dir = service._dataPath;
      await service.shutdown();

      const raw = await fsp.readFile(path.join(dir, 'files.json.lz4'));
      const saved = JSON.parse((await uncompress(raw)).toString('utf8'));
      expect(
        Object.values(saved.docs.docs)
          .map((doc) => doc.id)
          .sort()
      ).toEqual(['file:a', 'file:c']);
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

    test('a readable .bak beside it is not restored and then saved over it', async () => {
      await service.batchUpsertFileChunks([
        { id: 'chunk:old:0', vector: vector(), meta: { fileId: 'file:old', chunkIndex: 0 } }
      ]);
      const dir = service._dataPath;
      const primary = path.join(dir, 'fileChunks.json.lz4');
      await restart(async () => {
        await fsp.copyFile(primary, `${primary}.bak`);
        await fsp.writeFile(
          primary,
          await compress(Buffer.from(`{"docs":{"docs":{},"note":"${TOO_LARGE_MARKER}"}}`, 'utf8'))
        );
      });
      const blob = await fsp.readFile(primary);
      const bak = await fsp.readFile(`${primary}.bak`);

      await service.batchUpsertFileChunks([
        { id: 'chunk:new:0', vector: vector(), meta: { fileId: 'file:new', chunkIndex: 0 } }
      ]);
      await service.persistAll();

      expect(mockTracker.raise).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'orama.too-large:fileChunks' })
      );
      expect(await fsp.readFile(primary)).toEqual(blob);
      expect(await fsp.readFile(`${primary}.bak`)).toEqual(bak);
    });

    /** Save `name` once, then restart with its blob replaced by one too large to read. */
    async function plantTooLarge(name, seed) {
      await seed();
      const dir = service._dataPath;
      await restart(async () => {
        await fsp.writeFile(
          path.join(dir, `${name}.json.lz4`),
          await compress(Buffer.from(`{"docs":{"docs":{},"note":"${TOO_LARGE_MARKER}"}}`, 'utf8'))
        );
      });
      const read = async (file) => fsp.readFile(path.join(dir, file)).catch(() => null);
      return {
        dir,
        blob: await read(`${name}.json.lz4`),
        sidecar: await read(`${name}.sidecar.json`),
        bak: await read(`${name}.json.lz4.bak`),
        read
      };
    }

    /** A vector pointing mostly along one axis, far from the other axes. */
    const axis = (i) => {
      const v = new Array(768).fill(0.001);
      v[i] = 1;
      return v;
    };

    test('an automatic files index repair does not lift the block', async () => {
      const before = await plantTooLarge('files', () =>
        service.upsertFile({ id: 'file:old', vector: vector(), meta: { path: '/x/old.txt' } })
      );
      await service.upsertFile({ id: 'file:p', vector: axis(1), meta: { path: '/x/p.txt' } });
      // The sidecar no longer matches the index: the health probe fails and
      // would rebuild (replace) the files collection.
      service._embeddingStore.files.set('file:p', axis(0));

      await service._ensurePrimaryVectorHealth({ reason: 'test', force: true, autoRepair: true });
      await service._repairFilesVectorIndexFromCurrentState();
      await service.persistAll();

      expect(await before.read('files.json.lz4')).toEqual(before.blob);
      expect(await before.read('files.sidecar.json')).toEqual(before.sidecar);
      expect(await before.read('files.json.lz4.bak')).toEqual(before.bak);
      expect(mockTracker.clear).not.toHaveBeenCalledWith('orama.too-large:files');
    });

    test('a session that analyzes, orphans and analyzes again never saves over it', async () => {
      const before = await plantTooLarge('files', () =>
        service.upsertFile({ id: 'file:old', vector: vector(), meta: { path: '/x/old.txt' } })
      );
      const meta = (p) => ({ path: p, filePath: p, fileName: path.basename(p) });

      await service.batchUpsertFiles([{ id: 'file:A', vector: axis(2), meta: meta('/x/A.pdf') }]);
      await service.markEmbeddingsOrphaned(['file:A']);
      await service.batchUpsertFiles([{ id: 'file:B', vector: axis(3), meta: meta('/x/B.pdf') }]);
      await service.persistAll();
      service._bakRotatedAt.clear();
      await service.persistAll();

      expect(await before.read('files.json.lz4')).toEqual(before.blob);
      expect(await before.read('files.sidecar.json')).toEqual(before.sidecar);
      expect(await before.read('files.json.lz4.bak')).toEqual(before.bak);
    });

    test('an automatic folders index repair does not lift the block', async () => {
      const before = await plantTooLarge('folders', () =>
        service.upsertFolder({ id: 'folder:old', vector: vector(), name: 'Old', path: '/x' })
      );
      await service.upsertFolder({ id: 'folder:p', vector: axis(1), name: 'P', path: '/p' });

      const repair = await service._repairFoldersVectorIndexFromCurrentState();
      await service.persistAll();

      expect(repair.persisted).toBe(false);
      expect(await before.read('folders.json.lz4')).toEqual(before.blob);
      expect(await before.read('folders.sidecar.json')).toEqual(before.sidecar);
      expect(mockTracker.clear).not.toHaveBeenCalledWith('orama.too-large:folders');
    });

    test('a deliberate files reset lifts the block', async () => {
      await plantTooLarge('files', () =>
        service.upsertFile({ id: 'file:old', vector: vector(), meta: { path: '/x/old.txt' } })
      );

      const reset = await service.resetFiles();

      expect(reset.persisted).toBe(true);
      expect((await readSaved('files')).docs.docs).toEqual({});
      expect(mockTracker.clear).toHaveBeenCalledWith('orama.too-large:files');
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
