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
});
