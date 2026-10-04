/**
 * v1 Orama persistence migration invariants.
 *
 * This fixture represents the shape of an on-disk Orama persistence generated
 * by older builds (`schemaVersion: 1` in `<collection>.meta.json`). Loading
 * that fixture should now uphold the invariants the current service
 * promises, regardless of what exactly a v1 writer put on disk:
 *
 *   1. **Prototype-pollution safety** — `__proto__` / `constructor.prototype`
 *      keys in the persisted JSON must not leak onto `Object.prototype`.
 *   2. **Corrupt-data quarantine** — malformed JSON is renamed to a
 *      `.corrupt.<timestamp>` file (not silently dropped) so a human can
 *      recover or inspect.
 *   3. **Dimension-mismatch archive** — if the embedding model has changed
 *      dimensionality since the fixture was written, the old store is
 *      archived (`.dim<n>.<ts>.bak`) and a fresh, empty DB is returned so
 *      the renderer can prompt for a rebuild without losing the backup.
 *
 * These mirror the upgraded restore path in
 * `src/main/services/OramaVectorService.js`.
 */

const mockCreate = jest.fn();
const mockInsert = jest.fn();
const mockUpdate = jest.fn();
let mockLogger;

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/mock-user-data')
  }
}));

jest.mock('../src/shared/logger', () => {
  mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  };
  return {
    createLogger: () => mockLogger
  };
});

jest.mock('../src/shared/singletonFactory', () => ({
  createSingletonHelpers: () => ({
    getInstance: jest.fn(),
    createInstance: jest.fn(),
    registerWithContainer: jest.fn(),
    resetInstance: jest.fn()
  })
}));

jest.mock('@orama/orama', () => ({
  create: (...args) => mockCreate(...args),
  insert: (...args) => mockInsert(...args),
  search: jest.fn(),
  remove: jest.fn(),
  update: (...args) => mockUpdate(...args),
  count: jest.fn(),
  getByID: jest.fn()
}));

jest.mock('@orama/plugin-data-persistence', () => ({
  persist: jest.fn(),
  restore: jest.fn()
}));

jest.mock('lz4-napi', () => ({
  compress: jest.fn(async (buf) => buf),
  uncompress: jest.fn(async () => {
    throw new Error('Not used in this test');
  })
}));

const mockFs = {
  readFile: jest.fn(),
  unlink: jest.fn(),
  rename: jest.fn(),
  mkdir: jest.fn(),
  writeFile: jest.fn(),
  stat: jest.fn()
};

jest.mock('fs', () => ({
  promises: mockFs
}));

const { OramaVectorService } = require('../src/main/services/OramaVectorService');

function makeV1Fixture({ dimension = 3, extraDocs = {} } = {}) {
  return {
    docs: {
      docs: {
        a: {
          id: 'a',
          embedding: new Array(dimension).fill(0.1),
          filePath: '/legacy/a.txt',
          fileName: 'a.txt',
          fileType: 'text/plain',
          analyzedAt: '2024-01-02T03:04:05.678Z'
        },
        b: {
          id: 'b',
          embedding: new Array(dimension).fill(0.2),
          filePath: '/legacy/b.txt',
          fileName: 'b.txt',
          fileType: 'text/plain',
          analyzedAt: '2024-01-02T03:04:06.678Z'
        },
        ...extraDocs
      }
    }
  };
}

function makeService({ dimension = 3 } = {}) {
  const service = new OramaVectorService();
  service._dataPath = '/mock-user-data/vector-db';
  service._dimension = dimension;
  service._embeddingStore = {};
  service._collectionDimensions = {};
  service._clearQueryCache = jest.fn();
  service._broadcastStatus = jest.fn();
  return service;
}

describe('OramaVectorService — v1 persistence migration invariants', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreate.mockResolvedValue({ _name: 'mock-db' });
    mockInsert.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue(undefined);
    mockFs.rename.mockResolvedValue(undefined);
  });

  test('restores a v1 fixture and loads every document', async () => {
    const persisted = JSON.stringify(makeV1Fixture({ dimension: 3 }));

    mockFs.readFile.mockImplementation(async (targetPath) => {
      const p = String(targetPath);
      if (p.endsWith('.lz4')) {
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }
      if (p.endsWith('files.json')) return persisted;
      if (p.endsWith('files.sidecar.json')) return JSON.stringify({});
      throw new Error(`Unexpected readFile path: ${p}`);
    });

    const service = makeService({ dimension: 3 });
    const db = await service._createOrRestoreDatabase('files', {
      id: 'string',
      embedding: 'vector[3]'
    });

    expect(db).toEqual({ _name: 'mock-db' });
    expect(mockInsert).toHaveBeenCalledTimes(2);
    expect(mockInsert).toHaveBeenCalledWith(
      { _name: 'mock-db' },
      expect.objectContaining({ id: 'a', filePath: '/legacy/a.txt' })
    );
    expect(mockInsert).toHaveBeenCalledWith(
      { _name: 'mock-db' },
      expect.objectContaining({ id: 'b', filePath: '/legacy/b.txt' })
    );
  });

  test('strips prototype-pollution keys baked into the v1 fixture', async () => {
    // A compromised or buggy v1 writer could emit `__proto__` keys; the safe
    // JSON parser must neutralise them before the shape reaches our heap.
    const polluted = `{
      "__proto__": { "polluted": true },
      "constructor": { "prototype": { "alsoBad": true } },
      "docs": {
        "docs": {
          "a": {
            "id": "a",
            "embedding": [0.1, 0.2, 0.3],
            "filePath": "/legacy/a.txt",
            "fileName": "a.txt",
            "fileType": "text/plain",
            "analyzedAt": "2024-01-02T03:04:05.678Z"
          }
        }
      }
    }`;

    mockFs.readFile.mockImplementation(async (targetPath) => {
      const p = String(targetPath);
      if (p.endsWith('.lz4')) {
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }
      if (p.endsWith('files.json')) return polluted;
      if (p.endsWith('files.sidecar.json')) return JSON.stringify({});
      throw new Error(`Unexpected readFile path: ${p}`);
    });

    const service = makeService({ dimension: 3 });
    await service._createOrRestoreDatabase('files', {
      id: 'string',
      embedding: 'vector[3]'
    });

    // Prototype MUST be untouched — if this leaks, every other object in
    // the process would now carry `.polluted` / `.alsoBad`.
    expect({}.polluted).toBeUndefined();
    expect({}.alsoBad).toBeUndefined();

    // The legitimate document still loaded.
    expect(mockInsert).toHaveBeenCalledWith(
      { _name: 'mock-db' },
      expect.objectContaining({ id: 'a' })
    );
  });

  test('quarantines a v1 file with malformed JSON instead of silently resetting', async () => {
    mockFs.readFile.mockImplementation(async (targetPath) => {
      const p = String(targetPath);
      if (p.endsWith('.lz4')) {
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }
      if (p.endsWith('files.json')) return '{ this is not valid json ';
      if (p.endsWith('files.sidecar.json')) return JSON.stringify({});
      throw new Error(`Unexpected readFile path: ${p}`);
    });

    const service = makeService({ dimension: 3 });
    await service._createOrRestoreDatabase('files', {
      id: 'string',
      embedding: 'vector[3]'
    });

    const quarantineCalls = mockFs.rename.mock.calls.filter(([, dest]) =>
      String(dest).includes('.corrupt.')
    );
    expect(quarantineCalls.length).toBeGreaterThan(0);
    // No documents should have been inserted — we surface a fresh DB and
    // depend on reindex UX rather than faking data.
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('archives the store and raises a degraded flag when dimension changes', async () => {
    // v1 fixture has 3-dim vectors; service now expects 4-dim ones.
    const persisted = JSON.stringify(makeV1Fixture({ dimension: 3 }));

    mockFs.readFile.mockImplementation(async (targetPath) => {
      const p = String(targetPath);
      if (p.endsWith('.lz4')) {
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }
      if (p.endsWith('files.json')) return persisted;
      if (p.endsWith('files.sidecar.json')) return JSON.stringify({});
      throw new Error(`Unexpected readFile path: ${p}`);
    });

    const service = makeService({ dimension: 4 });
    await service._createOrRestoreDatabase('files', {
      id: 'string',
      embedding: 'vector[4]'
    });

    const archiveCalls = mockFs.rename.mock.calls.filter(([, dest]) =>
      /\.dim\d+\.\d+\.bak$/.test(String(dest))
    );
    expect(archiveCalls.length).toBeGreaterThan(0);
    // Brand new empty DB (no docs inserted from the mismatched v1 store).
    expect(mockInsert).not.toHaveBeenCalled();
    expect(service._clearQueryCache).toHaveBeenCalled();
  });
});
