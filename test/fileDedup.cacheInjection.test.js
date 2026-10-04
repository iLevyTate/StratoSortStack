/**
 * @jest-environment node
 */
/**
 * Tests for the cache-injection behavior added to fileDedup.computeFileChecksum
 * in Phase 1. Verifies: cache hits short-circuit hashing, cache misses
 * populate the cache with stat info, and callers without a cache get the
 * original stream-and-hash behavior unchanged.
 */

jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const path = require('path');
const fs = require('fs').promises;
const os = require('os');

describe('fileDedup.computeFileChecksum cache injection', () => {
  let computeFileChecksum;
  let testDir;
  let sampleFile;
  let sampleStat;

  beforeAll(async () => {
    testDir = path.join(os.tmpdir(), `dedup-cache-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    sampleFile = path.join(testDir, 'hello.txt');
    await fs.writeFile(sampleFile, 'hello world');
    sampleStat = await fs.stat(sampleFile);
    ({ computeFileChecksum } = require('../src/main/utils/fileDedup'));
  });

  afterAll(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('with no cache, hashing works unchanged', async () => {
    const h = await computeFileChecksum(sampleFile);
    expect(typeof h).toBe('string');
    expect(h).toHaveLength(64);
  });

  test('cache hit avoids re-hashing', async () => {
    const cache = {
      get: jest.fn().mockResolvedValue('cached-hash-value'),
      set: jest.fn()
    };
    const result = await computeFileChecksum(sampleFile, {
      cache,
      stat: { size: sampleStat.size, mtimeMs: sampleStat.mtimeMs }
    });
    expect(result).toBe('cached-hash-value');
    expect(cache.get).toHaveBeenCalledWith(sampleFile, {
      size: sampleStat.size,
      mtimeMs: sampleStat.mtimeMs
    });
    expect(cache.set).not.toHaveBeenCalled();
  });

  test('cache miss populates cache with computed hash', async () => {
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined)
    };
    const hash = await computeFileChecksum(sampleFile, {
      cache,
      stat: { size: sampleStat.size, mtimeMs: sampleStat.mtimeMs }
    });
    expect(hash).toHaveLength(64);
    expect(cache.set).toHaveBeenCalledWith(sampleFile, {
      size: sampleStat.size,
      mtimeMs: sampleStat.mtimeMs,
      sha256: hash
    });
  });

  test('cache.set failure is non-fatal', async () => {
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockRejectedValue(new Error('disk full'))
    };
    const hash = await computeFileChecksum(sampleFile, {
      cache,
      stat: { size: sampleStat.size, mtimeMs: sampleStat.mtimeMs }
    });
    expect(hash).toHaveLength(64);
  });
});
