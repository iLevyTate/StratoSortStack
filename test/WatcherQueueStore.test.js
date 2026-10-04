/**
 * @jest-environment node
 */
/**
 * WatcherQueueStore (K-07)
 *
 * The persisted analysis queue is a real on-disk artifact, so these tests run
 * against the real filesystem. The global test-setup swaps `fs` for memfs
 * (which mangles Windows drive-letter paths); unmock it the same way
 * test/atomicFileOperations.test.js does.
 */

jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const os = require('os');
const path = require('path');
const fs = require('fs').promises;

jest.mock('../src/shared/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  },
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const {
  createWatcherQueueStore,
  toPersisted
} = require('../src/main/services/watcher/WatcherQueueStore');

describe('toPersisted', () => {
  test('keeps only the resume fields and rejects item shapes with no path', () => {
    expect(
      toPersisted({
        filePath: 'C:\\a.txt',
        mtime: 1,
        eventType: 'change',
        queuedAt: 2,
        retryCount: 0,
        applyNaming: false,
        dedupKey: 'c:/a.txt',
        cachedAnalysis: { summary: 'x'.repeat(5000) },
        _lastAnalysis: { summary: 'y' },
        restored: true
      })
    ).toEqual({
      filePath: 'C:\\a.txt',
      mtime: 1,
      eventType: 'change',
      queuedAt: 2,
      retryCount: 0,
      applyNaming: false,
      dedupKey: 'c:/a.txt'
    });

    expect(toPersisted(null)).toBeNull();
    expect(toPersisted({})).toBeNull();
    expect(toPersisted({ filePath: '' })).toBeNull();
    expect(toPersisted({ filePath: 42 })).toBeNull();
  });

  test('omits absent optional fields rather than writing undefined', () => {
    expect(toPersisted({ filePath: 'C:\\b.txt' })).toEqual({ filePath: 'C:\\b.txt' });
  });
});

describe('WatcherQueueStore', () => {
  let dir;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wqs-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('round-trips queue items without transient fields', async () => {
    const store = createWatcherQueueStore(path.join(dir, 'queue.json'));
    await store.save([
      {
        filePath: 'C:\\a.txt',
        mtime: 1,
        eventType: 'add',
        queuedAt: 2,
        retryCount: 1,
        cachedAnalysis: { big: true },
        _lastAnalysis: { big: true }
      }
    ]);
    const items = await store.load();
    expect(items).toEqual([
      { filePath: 'C:\\a.txt', mtime: 1, eventType: 'add', queuedAt: 2, retryCount: 1 }
    ]);
  });

  // forceReanalyzeAll marks every item `bulk: true` and the watcher's
  // exclusion gates read that flag: a hand-picked single-file reanalyze is
  // exempt from the user's exclusion rules, a bulk one is not. If the flag
  // is dropped on the way to disk, every row of an interrupted bulk run comes
  // back exempt after the restart and excluded files get an LLM pass.
  test('round-trips the bulk flag so a restored bulk reanalyze is still not exempt', async () => {
    const store = createWatcherQueueStore(path.join(dir, 'queue.json'));
    await store.save([
      { filePath: 'C:\\w\\bulk.psd', mtime: 1, eventType: 'reanalyze', bulk: true, queuedAt: 2 },
      { filePath: 'C:\\w\\picked.psd', mtime: 1, eventType: 'reanalyze', queuedAt: 3 }
    ]);
    expect(await store.load()).toEqual([
      { filePath: 'C:\\w\\bulk.psd', mtime: 1, eventType: 'reanalyze', bulk: true, queuedAt: 2 },
      { filePath: 'C:\\w\\picked.psd', mtime: 1, eventType: 'reanalyze', queuedAt: 3 }
    ]);
  });

  test('load returns [] when the file is missing or corrupt', async () => {
    const p = path.join(dir, 'queue.json');
    const store = createWatcherQueueStore(p);
    expect(await store.load()).toEqual([]);
    await fs.writeFile(p, '{not json', 'utf8');
    expect(await store.load()).toEqual([]);
  });

  test('save with an empty array removes the file', async () => {
    const p = path.join(dir, 'queue.json');
    const store = createWatcherQueueStore(p);
    await store.save([{ filePath: 'x', mtime: 0, eventType: 'add', queuedAt: 0 }]);
    await store.save([]);
    await expect(fs.access(p)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // A second queue implementation (F-196) wrote smart-folder-watcher-queue.json
  // on main for a few days. Its rows must not be orphaned when that code was
  // removed: load merges them, and the file goes away after the next save.
  test('merges the legacy queue file on load and removes it after a save', async () => {
    const p = path.join(dir, 'queue.json');
    const legacy = path.join(dir, 'smart-folder-watcher-queue.json');
    await fs.writeFile(
      legacy,
      JSON.stringify({
        version: 1,
        queue: [{ filePath: '/docs/a.pdf', mtime: 1, eventType: 'add', _big: 'x' }],
        overflow: [{ filePath: '/docs/b.pdf', mtime: 2, eventType: 'reanalyze' }]
      }),
      'utf8'
    );
    const store = createWatcherQueueStore(p, { legacyFilePath: legacy });
    await store.save([{ filePath: '/docs/c.pdf', mtime: 3, eventType: 'add' }]);
    // save() already consumed the legacy file, so write it back to test load.
    await fs.writeFile(
      legacy,
      JSON.stringify({ version: 1, queue: [{ filePath: '/docs/a.pdf', mtime: 1 }], overflow: [] }),
      'utf8'
    );

    expect(await store.load()).toEqual([
      { filePath: '/docs/c.pdf', mtime: 3, eventType: 'add' },
      { filePath: '/docs/a.pdf', mtime: 1 }
    ]);

    await store.save(await store.load());
    await expect(fs.access(legacy)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await store.load()).toEqual([
      { filePath: '/docs/c.pdf', mtime: 3, eventType: 'add' },
      { filePath: '/docs/a.pdf', mtime: 1 }
    ]);
  });

  test('an empty save also removes the legacy file', async () => {
    const legacy = path.join(dir, 'smart-folder-watcher-queue.json');
    await fs.writeFile(legacy, JSON.stringify({ queue: [], overflow: [] }), 'utf8');
    const store = createWatcherQueueStore(path.join(dir, 'queue.json'), {
      legacyFilePath: legacy
    });
    await store.save([]);
    await expect(fs.access(legacy)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
