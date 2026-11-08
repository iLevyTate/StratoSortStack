/**
 * orama-4 blast radius: when the lz4-napi native binding fails to load, the
 * shared codec passes bytes through unchanged. The analysis-history and
 * embedding-queue SQLite stores used to read a genuine LZ4 blob that way,
 * fail to parse it, call it SQLITE_CORRUPT, and then back up and DELETE the
 * healthy database. A missing binding is an environment problem, not
 * corruption: the load must fail as transient and leave the database alone,
 * so the data comes back once the binding loads again.
 *
 * Real better-sqlite3 + real lz4-napi (to write the blobs) on the real file
 * system in an OS temp dir; only the codec's binding is taken away.
 */

const os = require('os');
const path = require('path');

jest.mock('fs', () => jest.requireActual('fs'));
jest.mock('fs/promises', () => jest.requireActual('fs/promises'));
const fsSync = require('fs');

const ENV_KEYS = ['STRATOSORT_ANALYSISHISTORY_BACKEND', 'STRATOSORT_EMBEDDINGQUEUE_BACKEND'];
const savedEnv = {};

const quietLogger = () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  };
  return { logger, createLogger: () => logger };
};

/**
 * Load a persistence module in a fresh registry, with or without the binding.
 * @param {string} modulePath
 * @param {{ bindingMissing: boolean }} opts
 */
function loadPersistence(modulePath, { bindingMissing }) {
  jest.resetModules();
  jest.doMock('../src/shared/logger', () => quietLogger());
  if (bindingMissing) {
    // What src/shared/lz4Codec.js exports when require('lz4-napi') throws.
    jest.doMock('../src/shared/lz4Codec', () => {
      const toBuffer = (input) => (Buffer.isBuffer(input) ? input : Buffer.from(input));
      return {
        compressSync: toBuffer,
        uncompressSync: toBuffer,
        compress: async (input) => toBuffer(input),
        uncompress: async (input) => toBuffer(input),
        isLz4BindingAvailable: false,
        lz4BindingError: new Error('Cannot find the lz4-napi native binding')
      };
    });
  } else {
    jest.dontMock('../src/shared/lz4Codec');
  }
  return require(modulePath);
}

const dirEntries = (dir) => fsSync.readdirSync(dir).sort();
const corruptCopies = (dir) => dirEntries(dir).filter((f) => f.includes('.corrupt.'));

describe('SQLite persistence with the lz4 binding missing', () => {
  let tempDir;

  beforeAll(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      process.env[key] = 'sqlite';
    }
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  beforeEach(() => {
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'strato-lz4-missing-'));
  });

  afterEach(() => {
    try {
      fsSync.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // a handle may linger on Windows; the OS cleans its temp dir eventually
    }
  });

  test('analysis history: a compressed history is held, not deleted, and loads once the binding returns', async () => {
    const historyPath = path.join(tempDir, 'analysis-history.json');
    const modulePath = '../src/main/services/analysisHistory/persistence';
    const history = {
      schemaVersion: '2.0.0',
      entries: { a: { id: 'a', originalPath: '/docs/a.pdf' } },
      totalAnalyzed: 1,
      totalSize: 10,
      metadata: { totalEntries: 1 }
    };
    const createEmptyHistory = () => ({ schemaVersion: '2.0.0', entries: {}, metadata: {} });
    const migrate = async (h) => h;

    let persistence = loadPersistence(modulePath, { bindingMissing: false });
    await persistence.saveHistory(historyPath, history);
    persistence.closeSqliteStore();
    expect(dirEntries(tempDir)).toContain('analysis-history.db');

    persistence = loadPersistence(modulePath, { bindingMissing: true });
    const saveHistory = jest.fn();
    let loadError = null;
    let loaded = null;
    try {
      loaded = await persistence.loadHistory(
        historyPath,
        '2.0.0',
        createEmptyHistory,
        saveHistory,
        migrate
      );
    } catch (error) {
      loadError = error;
    }
    persistence.closeSqliteStore();
    expect(loaded).toBeNull();
    expect(loadError).toEqual(
      expect.objectContaining({ code: 'LZ4_UNAVAILABLE', transient: true })
    );
    expect(saveHistory).not.toHaveBeenCalled();
    expect(corruptCopies(tempDir)).toEqual([]);
    expect(dirEntries(tempDir)).toContain('analysis-history.db');

    persistence = loadPersistence(modulePath, { bindingMissing: false });
    const restored = await persistence.loadHistory(
      historyPath,
      '2.0.0',
      createEmptyHistory,
      saveHistory,
      migrate
    );
    persistence.closeSqliteStore();
    expect(restored.entries).toEqual(history.entries);
  });

  test('analysis history: config and index loads hold the database the same way', async () => {
    const configPath = path.join(tempDir, 'analysis-config.json');
    const indexPath = path.join(tempDir, 'analysis-index.json');
    const modulePath = '../src/main/services/analysisHistory/persistence';

    let persistence = loadPersistence(modulePath, { bindingMissing: false });
    await persistence.saveConfig(configPath, { schemaVersion: '2.0.0', maxEntries: 42 });
    await persistence.saveIndex(indexPath, { byPath: { '/docs/a.pdf': 'a' } });
    persistence.closeSqliteStore();

    persistence = loadPersistence(modulePath, { bindingMissing: true });
    const getDefaultConfig = jest.fn(() => ({ schemaVersion: '2.0.0' }));
    await expect(
      persistence.loadConfig(configPath, getDefaultConfig, jest.fn())
    ).rejects.toMatchObject({ code: 'LZ4_UNAVAILABLE', transient: true });
    await expect(
      persistence.loadIndex(indexPath, () => ({ byPath: {} }), jest.fn())
    ).rejects.toMatchObject({ code: 'LZ4_UNAVAILABLE', transient: true });
    persistence.closeSqliteStore();
    expect(corruptCopies(tempDir)).toEqual([]);

    persistence = loadPersistence(modulePath, { bindingMissing: false });
    const config = await persistence.loadConfig(configPath, getDefaultConfig, jest.fn());
    const index = await persistence.loadIndex(indexPath, () => ({ byPath: {} }), jest.fn());
    persistence.closeSqliteStore();
    expect(config.maxEntries).toBe(42);
    expect(index.byPath).toEqual({ '/docs/a.pdf': 'a' });
  });

  test('embedding queue: a compressed queue is held, not deleted, and loads once the binding returns', async () => {
    const queuePath = path.join(tempDir, 'pending_embeddings.json');
    const modulePath = '../src/main/analysis/embeddingQueue/persistence';
    const queue = [{ id: 'file:/docs/a.pdf', vector: [0.1, 0.2], meta: { path: '/docs/a.pdf' } }];

    let persistence = loadPersistence(modulePath, { bindingMissing: false });
    await persistence.persistQueueData(queuePath, queue, { key: 'queue', throwOnError: true });
    persistence.closeSqliteStore();
    expect(dirEntries(tempDir)).toContain('embedding-queue.db');

    persistence = loadPersistence(modulePath, { bindingMissing: true });
    const onLoad = jest.fn();
    let loadError = null;
    try {
      await persistence.loadPersistedData(queuePath, onLoad, 'pending embeddings', {
        key: 'queue'
      });
    } catch (error) {
      loadError = error;
    }
    persistence.closeSqliteStore();
    expect(loadError).toEqual(
      expect.objectContaining({ code: 'LZ4_UNAVAILABLE', transient: true })
    );
    expect(onLoad).not.toHaveBeenCalled();
    expect(corruptCopies(tempDir)).toEqual([]);
    expect(dirEntries(tempDir)).toContain('embedding-queue.db');

    persistence = loadPersistence(modulePath, { bindingMissing: false });
    const reloaded = jest.fn();
    await persistence.loadPersistedData(queuePath, reloaded, 'pending embeddings', {
      key: 'queue'
    });
    persistence.closeSqliteStore();
    expect(reloaded).toHaveBeenCalledWith(queue);
  });

  test('a plain (uncompressed) blob still loads without the binding', async () => {
    const queuePath = path.join(tempDir, 'pending_embeddings.json');
    const modulePath = '../src/main/analysis/embeddingQueue/persistence';
    const queue = [{ id: 'file:/docs/b.pdf' }];

    // Written while the binding was already missing: identity "compression".
    const persistence = loadPersistence(modulePath, { bindingMissing: true });
    await persistence.persistQueueData(queuePath, queue, { key: 'queue', throwOnError: true });
    const onLoad = jest.fn();
    await persistence.loadPersistedData(queuePath, onLoad, 'pending embeddings', { key: 'queue' });
    persistence.closeSqliteStore();
    expect(onLoad).toHaveBeenCalledWith(queue);
  });
});
