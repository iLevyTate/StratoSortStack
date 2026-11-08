/**
 * Restore parses saved collections in a worker_thread (oramaRestoreWorker).
 *
 * The worker runs the same loader the main thread falls back to, and only
 * repackages its result for the trip back (embeddings as one transferred
 * Float64Array per batch, the sidecar packed until asked for). These tests
 * drive the real worker from source against real temp files and require the
 * worker path to give exactly what the in-process path gives: same outcome
 * for every kind of file restore distinguishes, same documents, same vectors
 * bit for bit.
 */

const os = require('os');
const path = require('path');
const fsp = require('fs').promises;

jest.mock('fs', () => jest.requireActual('fs'));
jest.mock('fs/promises', () => jest.requireActual('fs/promises'));
jest.mock('electron', () => ({ app: { getPath: jest.fn() } }));
jest.mock('../src/shared/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: () => logger, __mockLogger: logger };
});
jest.mock('../src/shared/singletonFactory', () => ({
  createSingletonHelpers: () => ({
    getInstance: jest.fn(),
    createInstance: jest.fn(),
    registerWithContainer: jest.fn(),
    resetInstance: jest.fn()
  })
}));
jest.mock('../src/main/llamaUtils', () => ({
  getEmbeddingModel: jest.fn(() => 'nomic-embed-text-v1.5-Q8_0.gguf'),
  loadLlamaConfig: jest.fn().mockResolvedValue({
    selectedEmbeddingModel: 'nomic-embed-text-v1.5-Q8_0.gguf'
  })
}));
// Always the worker built from source: a dist/ bundle left over from an
// older build must not decide this test.
const mockWorkerSource = require('path').join(
  __dirname,
  '..',
  'src',
  'main',
  'workers',
  'oramaRestoreWorker.js'
);
const mockResolveWorkerPath = jest.fn(() => mockWorkerSource);
jest.mock('../src/main/utils/workerPools', () => ({
  resolveWorkerPath: (...args) => mockResolveWorkerPath(...args)
}));

const { app } = require('electron');
const { __mockLogger: logger } = require('../src/shared/logger');
const { create, insert, save } = require('@orama/orama');
const { compress } = require('../src/shared/lz4Codec');
const {
  loadPersistedCollection,
  loadPersistedSidecar,
  loadInWorker
} = require('../src/main/workers/oramaRestoreLoader');
const { OramaVectorService } = require('../src/main/services/OramaVectorService');

const TEMP_ROOT = require('fs').mkdtempSync(
  path.join(jest.requireActual('os').tmpdir(), 'strato-orama-restore-worker-')
);
const DIM = 8;

afterAll(async () => {
  await fsp.rm(TEMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

/** Values JSON keeps exactly but a float32 round trip would not. */
const vectorFor = (seed, dim = DIM) =>
  Array.from({ length: dim }, (_, j) => Math.sin(seed * 31 + j) / 3);

const docsFixture = (count) => {
  /** @type {Record<string, any>} */
  const docs = {};
  for (let i = 0; i < count; i++) {
    docs[String(i + 1)] = {
      id: `file:${i}`,
      embedding: vectorFor(i + 1),
      filePath: `/lib/${i}.txt`,
      keywords: ['alpha', `k${i}`],
      nested: { score: i / 7, tags: [{ name: 't' }] },
      hasVector: true
    };
  }
  // Shapes the worker must leave alone rather than pack.
  docs.odd1 = { id: 'file:empty', embedding: [], filePath: '/lib/empty.txt' };
  docs.odd2 = { id: 'file:null', embedding: null, filePath: '/lib/null.txt' };
  docs.odd3 = { id: 'file:mixed', embedding: [0.1, null, 0.3], filePath: '/lib/mixed.txt' };
  docs.odd4 = { id: 'file:objectShape', embedding: { 0: 0.5, 1: 0.25 }, filePath: '/o.txt' };
  docs.noId = { filePath: '/lib/no-id.txt' };
  return docs;
};

const compactJson = (count) => JSON.stringify({ docs: { docs: docsFixture(count), count } });

/** Compare a worker load against the in-process load of the same file. */
const expectSameLoad = (fromWorker, inProcess) => {
  expect(fromWorker.status).toBe(inProcess.status);
  if (inProcess.error) {
    expect(fromWorker.error).toBeInstanceOf(Error);
    expect(fromWorker.error.message).toBe(inProcess.error.message);
    expect(fromWorker.error.code).toBe(inProcess.error.code);
    expect(fromWorker.error.name).toBe(inProcess.error.name);
  } else {
    expect(fromWorker.error).toBeNull();
  }
  // toStrictEqual would also pass undefined-vs-missing keys; key order and
  // -0 are checked separately below.
  expect(fromWorker.docList).toEqual(inProcess.docList);
  if (inProcess.docList) {
    expect(fromWorker.docList.map((d) => Object.keys(d))).toEqual(
      inProcess.docList.map((d) => Object.keys(d))
    );
    fromWorker.docList.forEach((doc, i) => {
      const expected = inProcess.docList[i].embedding;
      if (Array.isArray(expected)) {
        expect(Array.isArray(doc.embedding)).toBe(true);
        expected.forEach((v, j) => expect(Object.is(doc.embedding[j], v)).toBe(true));
      }
    });
  }
};

describe('oramaRestoreLoader: worker and in-process loads agree', () => {
  let dir;
  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(TEMP_ROOT, 'loader-'));
  });

  const writeFixture = async (name, contents) => {
    const filePath = path.join(dir, name);
    await fsp.writeFile(filePath, contents);
    return filePath;
  };

  const compare = async (filePath, decompress, batchSize = 7) => {
    const inProcess = await loadPersistedCollection(filePath, { decompress, keepText: false });
    const fromWorker = await loadInWorker(mockWorkerSource, {
      kind: 'collection',
      filePath,
      decompress,
      batchSize
    });
    expectSameLoad(fromWorker, inProcess);
    return { inProcess, fromWorker };
  };

  test('compact docs.docs format, LZ4 compressed, across several batches', async () => {
    const filePath = await writeFixture(
      'compact.json.lz4',
      await compress(Buffer.from(compactJson(40), 'utf8'))
    );
    const { fromWorker } = await compare(filePath, true);
    expect(fromWorker.status).toBe('ok');
    expect(fromWorker.docList).toHaveLength(44); // 40 + 4 odd shapes, minus the id-less one
  });

  test('compact format, uncompressed', async () => {
    const filePath = await writeFixture('compact.json', compactJson(20));
    const { fromWorker } = await compare(filePath, false);
    expect(fromWorker.docList).toHaveLength(24);
  });

  test('number edge cases survive the Float64Array trip (-0, 1e400, subnormals)', async () => {
    const text =
      '{"docs":{"docs":{"1":{"id":"n1","embedding":[-0,1e400,5e-324,0.1,-1.7976931348623157e308]}}}}';
    const { fromWorker } = await compare(await writeFixture('numbers.json', text), false);
    const [v] = fromWorker.docList.map((d) => d.embedding);
    expect(Object.is(v[0], -0)).toBe(true);
    expect(v[1]).toBe(Infinity);
    expect(v[2]).toBe(5e-324);
  });

  test('legacy full export (what Orama persist(db, "json") writes), both encodings', async () => {
    const db = await create({
      schema: { id: 'string', title: 'string', embedding: `vector[${DIM}]` }
    });
    for (let i = 0; i < 12; i++) {
      await insert(db, { id: `legacy:${i}`, title: `doc ${i}`, embedding: vectorFor(i + 50) });
    }
    // persist(db, 'json') is JSON.stringify(save(db)); it needs ESM import.
    const exported = JSON.stringify(save(db));
    expect(JSON.parse(exported).index).toBeDefined(); // a real full export
    const plain = await writeFixture('legacy.json', exported);
    const packed = await writeFixture(
      'legacy.json.lz4',
      await compress(Buffer.from(exported, 'utf8'))
    );
    const a = await compare(plain, false);
    const b = await compare(packed, true);
    expect(a.fromWorker.docList.map((d) => d.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `legacy:${i}`)
    );
    expect(b.fromWorker.docList).toEqual(a.fromWorker.docList);
  });

  test('missing, empty, not JSON, corrupt LZ4, no documents: same outcome and error', async () => {
    const missing = await compare(path.join(dir, 'missing.json.lz4'), true);
    expect(missing.fromWorker.status).toBe('read-error');
    expect(missing.fromWorker.error.code).toBe('ENOENT');

    const empty = await compare(await writeFixture('empty.json', ''), false);
    expect(empty.fromWorker.status).toBe('empty');

    const torn = await compare(await writeFixture('torn.json', '{"docs":{"docs":{"1":'), false);
    expect(torn.fromWorker.status).toBe('parse-error');

    const corrupt = await compare(
      await writeFixture('corrupt.json.lz4', Buffer.from('definitely not an lz4 frame')),
      true
    );
    expect(corrupt.fromWorker.status).toBe('read-error');

    const noDocs = await compare(await writeFixture('nodocs.json', '{"docs":{"count":0}}'), false);
    expect(noDocs.fromWorker).toEqual({ status: 'ok', error: null, docList: null });
  });

  test('prototype-pollution keys are stripped in the worker too', async () => {
    const text =
      '{"docs":{"docs":{"1":{"id":"p1","__proto__":{"polluted":true},' +
      '"meta":{"constructor":{"prototype":{"x":1}},"ok":1},"embedding":[1,2]}}}}';
    const { fromWorker } = await compare(await writeFixture('polluted.json', text), false);
    expect(fromWorker.docList).toEqual([{ id: 'p1', meta: { ok: 1 }, embedding: [1, 2] }]);
    expect({}.polluted).toBeUndefined();
  });

  test('sidecar: same ids in the same order, same vectors, normalized as in-process', async () => {
    /** @type {Record<string, any>} */
    const sidecar = {};
    for (let i = 0; i < 30; i++) sidecar[`file:${i}`] = vectorFor(i + 200);
    sidecar['file:short'] = [0.1, 0.2];
    sidecar['file:objectShape'] = Object.fromEntries(vectorFor(999).map((v, j) => [j, v]));
    sidecar['file:strings'] = vectorFor(7).map(String);
    sidecar['file:bad'] = [1, 'x', 3, 4, 5, 6, 7, 8];
    const filePath = await writeFixture('files.sidecar.json', JSON.stringify(sidecar));

    const inProcess = await loadPersistedSidecar(filePath, { dimension: DIM });
    const fromWorker = await loadInWorker(mockWorkerSource, {
      kind: 'sidecar',
      filePath,
      dimension: DIM
    });
    expect(fromWorker.size).toBe(inProcess.size);
    expect([...fromWorker.ids()]).toEqual([...inProcess.ids()]);
    for (const id of inProcess.ids()) expect(fromWorker.get(id)).toEqual(inProcess.get(id));
    expect(fromWorker.get('file:short')).toBeUndefined();
    expect(fromWorker.get('file:bad')).toBeUndefined();
    expect(fromWorker.get('file:strings')).toEqual(vectorFor(7));
    expect(fromWorker.get('nope')).toBeUndefined();

    await expect(
      loadInWorker(mockWorkerSource, {
        kind: 'sidecar',
        filePath: path.join(dir, 'no.sidecar.json'),
        dimension: DIM
      })
    ).resolves.toBeNull();
    await expect(
      loadPersistedSidecar(path.join(dir, 'no.sidecar.json'), { dimension: DIM })
    ).resolves.toBeNull();
  });

  test('a worker that cannot start or dies rejects, so the caller can fall back', async () => {
    await expect(
      loadInWorker(path.join(dir, 'no-such-worker.js'), {
        kind: 'collection',
        filePath: path.join(dir, 'compact.json'),
        decompress: false
      })
    ).rejects.toThrow();
    const crashing = await writeFixture('crashing-worker.js', 'process.exit(3);');
    await expect(
      loadInWorker(crashing, {
        kind: 'collection',
        filePath: path.join(dir, 'compact.json'),
        decompress: false
      })
    ).rejects.toThrow(/exited with code 3/);
  });
});

describe('OramaVectorService restore through the worker', () => {
  let dir;
  let services;
  const savedEnv = process.env.STRATOSORT_ORAMA_RESTORE_WORKER;

  const FILES = 30;
  const FOLDERS = 6;
  const CHUNKS = 45;

  const startService = async ({ worker }) => {
    if (worker) process.env.STRATOSORT_ORAMA_RESTORE_WORKER = 'true';
    else delete process.env.STRATOSORT_ORAMA_RESTORE_WORKER;
    const service = new OramaVectorService();
    service._restoreWorkerMinBytes = 0; // the fixtures are small
    services.push(service);
    await service.initialize();
    return service;
  };

  const snapshot = (service) => {
    /** @type {Record<string, any>} */
    const out = {};
    for (const name of ['files', 'folders', 'fileChunks']) {
      const docs = Object.values(service._databases[name].data.docs.docs)
        .filter(Boolean)
        .map((doc) => ({ ...doc }))
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      const store = service._embeddingStore[name];
      out[name] = {
        count: docs.length,
        ids: docs.map((d) => d.id),
        docs,
        sidecar: [...(store?.entries() || [])].sort(([a], [b]) => (a < b ? -1 : 1))
      };
    }
    return out;
  };

  const restoredLog = (name) =>
    logger.info.mock.calls
      .filter(([message]) => message === `[OramaVectorService] Restored ${name} database`)
      .map(([, detail]) => detail)
      .pop();

  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(TEMP_ROOT, 'service-'));
  });

  beforeEach(() => {
    app.getPath.mockReturnValue(dir);
    services = [];
    mockResolveWorkerPath.mockImplementation(() => mockWorkerSource);
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
    for (const service of services) await service.shutdown().catch(() => {});
    jest.restoreAllMocks();
    logger.info.mockClear();
    logger.warn.mockClear();
    if (savedEnv === undefined) delete process.env.STRATOSORT_ORAMA_RESTORE_WORKER;
    else process.env.STRATOSORT_ORAMA_RESTORE_WORKER = savedEnv;
  });

  test('restores the same ids, counts and vectors as the in-process path', async () => {
    const seed = await startService({ worker: false });
    const dim = seed._dimension;
    for (let i = 0; i < FILES; i++) {
      await seed.upsertFile({
        id: `file:${i}`,
        vector: vectorFor(i + 1, dim),
        meta: { path: `/lib/doc-${i}.txt`, keywords: ['k', `w${i}`], tags: ['t'] }
      });
    }
    for (let i = 0; i < FOLDERS; i++) {
      await seed.upsertFolder({
        id: `folder:${i}`,
        vector: vectorFor(i + 500, dim),
        name: `Folder ${i}`,
        path: `/lib/f${i}`
      });
    }
    await seed.batchUpsertFileChunks(
      Array.from({ length: CHUNKS }, (_, i) => ({
        id: `chunk:${i}`,
        vector: vectorFor(i + 900, dim),
        meta: { fileId: `file:${i % FILES}`, chunkIndex: i, content: `passage ${i} text` }
      }))
    );
    expect((await seed.persistAll()).success).toBe(true);
    await seed.shutdown();
    expect(
      require('fs').existsSync(path.join(seed._dataPath, 'files.json.lz4')) ||
        require('fs').existsSync(path.join(seed._dataPath, 'files.json'))
    ).toBe(true);

    logger.info.mockClear();
    const inProcess = await startService({ worker: false });
    expect(restoredLog('files')).toEqual(
      expect.objectContaining({ inserted: FILES, parsedIn: 'main', sidecarParsedIn: 'main' })
    );
    const expected = snapshot(inProcess);
    await inProcess.shutdown();

    logger.info.mockClear();
    const viaWorker = await startService({ worker: true });
    for (const [name, count] of [
      ['files', FILES],
      ['folders', FOLDERS],
      ['fileChunks', CHUNKS]
    ]) {
      expect(restoredLog(name)).toEqual(
        expect.objectContaining({ inserted: count, parsedIn: 'worker', sidecarParsedIn: 'worker' })
      );
    }
    const actual = snapshot(viaWorker);

    expect(actual.files.count).toBe(FILES);
    expect(actual.folders.count).toBe(FOLDERS);
    expect(actual.fileChunks.count).toBe(CHUNKS);
    expect(actual).toEqual(expected);
    for (let i = 0; i < FILES; i++) {
      await expect(viaWorker.hasUsableVector(`file:${i}`)).resolves.toBe(true);
    }
    expect(viaWorker._restoreWorkerDisabledReason).toBeNull();
  });

  test('a primary that fails to decode falls back to .bak the same way through the worker', async () => {
    const seed = await startService({ worker: false });
    const lz4Path = path.join(seed._dataPath, 'files.json.lz4');
    const usesLz4 = require('fs').existsSync(lz4Path);
    const primary = usesLz4 ? lz4Path : path.join(seed._dataPath, 'files.json');
    await seed.shutdown();
    await fsp.copyFile(primary, `${primary}.bak`);
    await fsp.writeFile(primary, usesLz4 ? Buffer.from('not lz4') : '{"torn":');

    logger.info.mockClear();
    const viaWorker = await startService({ worker: true });
    expect(restoredLog('files')).toEqual(
      expect.objectContaining({ inserted: FILES, parsedIn: 'worker' })
    );
    expect(snapshot(viaWorker).files.count).toBe(FILES);
    const left = await fsp.readdir(seed._dataPath);
    expect(left.some((f) => f.startsWith(`${path.basename(primary)}.corrupt.`))).toBe(true);
  });

  test('falls back to the in-process parse when the worker cannot start, and says so once', async () => {
    mockResolveWorkerPath.mockImplementation(() => path.join(dir, 'missing-worker.js'));
    const service = await startService({ worker: true });
    expect(restoredLog('files')).toEqual(
      expect.objectContaining({ inserted: FILES, parsedIn: 'main', sidecarParsedIn: 'main' })
    );
    expect(service._restoreWorkerDisabledReason).toEqual(expect.any(String));
    const unavailable = logger.warn.mock.calls.filter(([message]) =>
      String(message).includes('Restore worker unavailable')
    );
    expect(unavailable).toHaveLength(1);
    // Only the first file tried the worker; the rest of the session skipped it.
    expect(mockResolveWorkerPath).toHaveBeenCalledTimes(1);
  });
});
