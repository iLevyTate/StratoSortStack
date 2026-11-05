/**
 * @jest-environment node
 */
/**
 * Tests for HashCache — the sidecar SHA-256 cache used by Phase 1 (for files
 * not yet in Orama) and consumed by Phase 3 triage.
 */

jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const path = require('path');
const fs = require('fs').promises;
const os = require('os');

jest.mock('electron', () => ({
  app: { getPath: jest.fn() }
}));

describe('HashCache', () => {
  let HashCache;
  let testDir;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `hash-cache-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    const electron = require('electron');
    electron.app.getPath.mockReturnValue(testDir);
    jest.resetModules();
    const electronAfter = require('electron');
    electronAfter.app.getPath.mockReturnValue(testDir);
    ({ HashCache } = require('../src/main/utils/hashCache'));
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('returns null for unknown paths', async () => {
    const cache = new HashCache();
    const hit = await cache.get('/any/path', { size: 1, mtimeMs: 1 });
    expect(hit).toBeNull();
  });

  test('set + get round-trip returns cached hash', async () => {
    const cache = new HashCache();
    await cache.set('/a/b.txt', { size: 10, mtimeMs: 1000, sha256: 'deadbeef' });
    const hit = await cache.get('/a/b.txt', { size: 10, mtimeMs: 1000 });
    expect(hit).toBe('deadbeef');
  });

  test('size mismatch is a cache miss', async () => {
    const cache = new HashCache();
    await cache.set('/x', { size: 100, mtimeMs: 500, sha256: 'aaa' });
    const hit = await cache.get('/x', { size: 200, mtimeMs: 500 });
    expect(hit).toBeNull();
  });

  test('mtime mismatch is a cache miss', async () => {
    const cache = new HashCache();
    await cache.set('/x', { size: 100, mtimeMs: 500, sha256: 'aaa' });
    const hit = await cache.get('/x', { size: 100, mtimeMs: 9999 });
    expect(hit).toBeNull();
  });

  test('invalidate removes an entry', async () => {
    const cache = new HashCache();
    await cache.set('/x', { size: 1, mtimeMs: 1, sha256: 'h' });
    await cache.invalidate('/x');
    const hit = await cache.get('/x', { size: 1, mtimeMs: 1 });
    expect(hit).toBeNull();
  });

  test('flush writes a JSON file with the expected shape', async () => {
    const cachePath = path.join(testDir, 'custom-cache.json');
    const cache = new HashCache({ filePath: cachePath });
    await cache.set('/p', { size: 5, mtimeMs: 123, sha256: 'h5' });
    await cache.flush();

    const raw = await fs.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.entries['/p']).toEqual({ size: 5, mtimeMs: 123, sha256: 'h5' });
  });

  // Each save rewrites the whole cache file (up to 50,000 rows). A hashing
  // pass used to do that about twice a second, and re-hashing an unchanged
  // file counted as a change.
  describe('write volume', () => {
    const fsp = require('fs').promises;
    // Count whole-file rewrites without touching disk (timers are fake here).
    const stubWrites = () => {
      jest.spyOn(fsp, 'mkdir').mockResolvedValue(undefined);
      jest.spyOn(fsp, 'rename').mockResolvedValue(undefined);
      return jest.spyOn(fsp, 'writeFile').mockResolvedValue(undefined);
    };

    afterEach(() => {
      jest.restoreAllMocks();
      jest.useRealTimers();
    });

    test('setting an unchanged entry does not make the cache dirty', async () => {
      const cachePath = path.join(testDir, 'same.json');
      const cache = new HashCache({ filePath: cachePath });
      await cache.set('/same', { size: 5, mtimeMs: 123, sha256: 'h5' });
      await cache.flush();
      const writeSpy = jest.spyOn(require('fs').promises, 'writeFile');

      await cache.set('/same', { size: 5, mtimeMs: 123, sha256: 'h5' });
      await cache.flush();

      expect(writeSpy).not.toHaveBeenCalled();
      writeSpy.mockRestore();
    });

    test('a burst of sets is saved once, after hashing goes quiet', async () => {
      jest.useFakeTimers();
      const cache = new HashCache({ filePath: path.join(testDir, 'burst.json') });
      const saveSpy = stubWrites();

      for (let i = 0; i < 4; i += 1) {
        await cache.set(`/f${i}`, { size: i, mtimeMs: i, sha256: `h${i}` });
        await jest.advanceTimersByTimeAsync(400);
      }
      // 1.6 s in: the old 500 ms timer had already written three times.
      expect(saveSpy).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(5000);
      expect(saveSpy).toHaveBeenCalledTimes(1);
    });

    test('steady hashing still saves at the max wait', async () => {
      jest.useFakeTimers();
      const cache = new HashCache({ filePath: path.join(testDir, 'steady.json') });
      const saveSpy = stubWrites();

      // One new hash per second never leaves a 5 s quiet gap.
      for (let i = 0; i < 31; i += 1) {
        await cache.set(`/s${i}`, { size: i, mtimeMs: i, sha256: `s${i}` });
        await jest.advanceTimersByTimeAsync(1000);
      }
      expect(saveSpy).toHaveBeenCalledTimes(1);
    });

    test('flushHashCache writes the shared cache pending changes at quit', async () => {
      const { getHashCache, flushHashCache } = require('../src/main/utils/hashCache');
      const cache = getHashCache();
      await cache.set('/quit', { size: 1, mtimeMs: 2, sha256: 'q' });

      await flushHashCache();

      const parsed = JSON.parse(await fs.readFile(path.join(testDir, 'hash-cache.json'), 'utf8'));
      expect(parsed.entries['/quit']).toEqual({ size: 1, mtimeMs: 2, sha256: 'q' });
    });

    // Quit flushes the cache. If the debounced save was already writing, flush
    // found nothing dirty and returned at once, and shutdown went on while
    // the write was still in flight.
    test('flush waits for a timer save already writing, then writes what changed since', async () => {
      jest.useFakeTimers();
      const cache = new HashCache({ filePath: path.join(testDir, 'inflight.json') });
      const writeSpy = stubWrites();
      const renameSpy = /** @type {jest.SpyInstance} */ (require('fs').promises.rename);
      let finishFirstWrite;
      writeSpy.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirstWrite = resolve;
          })
      );

      await cache.set('/first', { size: 1, mtimeMs: 1, sha256: 'one' });
      await jest.advanceTimersByTimeAsync(5000);
      expect(writeSpy).toHaveBeenCalledTimes(1); // the timer save, still writing

      // A hash lands mid-write, then the app quits.
      await cache.set('/second', { size: 2, mtimeMs: 2, sha256: 'two' });
      let flushed = false;
      const flushing = cache.flush().then(() => {
        flushed = true;
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(flushed).toBe(false);
      // Saves take turns on the shared tmp file.
      expect(writeSpy).toHaveBeenCalledTimes(1);

      finishFirstWrite();
      await flushing;
      expect(writeSpy).toHaveBeenCalledTimes(2);
      expect(renameSpy).toHaveBeenCalledTimes(2);
      expect(JSON.parse(writeSpy.mock.calls[1][1]).entries['/second']).toEqual({
        size: 2,
        mtimeMs: 2,
        sha256: 'two'
      });
    });

    test('a failed write keeps the changes for the next flush', async () => {
      const cachePath = path.join(testDir, 'retry.json');
      const cache = new HashCache({ filePath: cachePath });
      await cache.set('/r', { size: 1, mtimeMs: 1, sha256: 'r' });
      const writeSpy = jest
        .spyOn(require('fs').promises, 'writeFile')
        .mockRejectedValueOnce(new Error('disk full'));

      await expect(cache.flush()).rejects.toThrow('disk full');
      writeSpy.mockRestore();
      await cache.flush();

      const parsed = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      expect(parsed.entries['/r']).toEqual({ size: 1, mtimeMs: 1, sha256: 'r' });
    });
  });
});
