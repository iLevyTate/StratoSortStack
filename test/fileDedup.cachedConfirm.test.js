/**
 * Move-time dedup reads through the hash cache, and confirms before acting.
 *
 * Organize used to re-read the source and every same-size file in the
 * destination on every move. Dedup now passes the persistent hash cache to
 * the checksum, so unchanged files are not read again. A cached hash can be
 * stale (content changed, mtime restored), so a match is re-read fresh before
 * the source is removed: a stale entry must never cost the user a file.
 */

const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { computeFileChecksum, handleDuplicateMove } = require('../src/main/utils/fileDedup');

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function memoryCache(seed = {}) {
  const entries = new Map(Object.entries(seed));
  return {
    entries,
    get: jest.fn(async (filePath) => entries.get(filePath) || null),
    set: jest.fn(async (filePath, value) => {
      entries.set(filePath, value.sha256);
    })
  };
}

describe('handleDuplicateMove with a hash cache', () => {
  let dir;
  let source;
  let destDir;
  let existing;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dedup-confirm-'));
    destDir = path.join(dir, 'Finance');
    await fs.mkdir(destDir);
    source = path.join(dir, 'invoice.pdf');
    existing = path.join(destDir, 'invoice-2024.pdf');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('a match found through the cache is confirmed fresh, then the source is removed', async () => {
    await fs.writeFile(source, 'same bytes');
    await fs.writeFile(existing, 'same bytes');
    const cache = memoryCache();
    const unlinkFn = jest.fn(async (p) => fs.unlink(p));

    const result = await handleDuplicateMove({
      sourcePath: source,
      destinationPath: path.join(destDir, 'invoice.pdf'),
      checksumFn: computeFileChecksum,
      hashCache: cache,
      unlinkFn
    });

    expect(result).toEqual(expect.objectContaining({ skipped: true, reason: 'duplicate' }));
    expect(unlinkFn).toHaveBeenCalledWith(source);
    // Elimination went through the cache.
    expect(cache.get).toHaveBeenCalled();
  });

  test('stale cached hashes that claim a match do not remove a different file', async () => {
    await fs.writeFile(source, 'the real invoice');
    await fs.writeFile(existing, 'a different file');
    // Same size on purpose, so the size pre-filter keeps the candidate.
    expect((await fs.stat(source)).size).toBe((await fs.stat(existing)).size);
    const stale = sha256('whatever was there before');
    const cache = memoryCache({ [source]: stale, [existing]: stale });
    const unlinkFn = jest.fn();

    const result = await handleDuplicateMove({
      sourcePath: source,
      destinationPath: path.join(destDir, 'invoice.pdf'),
      checksumFn: computeFileChecksum,
      hashCache: cache,
      unlinkFn
    });

    expect(result).toBeNull();
    expect(unlinkFn).not.toHaveBeenCalled();
    await expect(fs.readFile(source, 'utf8')).resolves.toBe('the real invoice');
    // The fresh reads refreshed both stale entries.
    expect(cache.entries.get(source)).toBe(sha256('the real invoice'));
    expect(cache.entries.get(existing)).toBe(sha256('a different file'));
  });

  test('computeFileChecksum with fresh skips the cached value', async () => {
    await fs.writeFile(source, 'current');
    const cache = memoryCache({ [source]: 'stale' });
    await expect(computeFileChecksum(source, { cache })).resolves.toBe('stale');
    await expect(computeFileChecksum(source, { cache, fresh: true })).resolves.toBe(
      sha256('current')
    );
  });
});
