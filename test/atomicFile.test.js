/**
 * Tests for atomicFile utilities
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');

// Mock dependencies
jest.mock('../src/shared/performanceConstants', () => ({
  RETRY: {
    ATOMIC_BACKOFF_STEP_MS: 10
  }
}));

jest.mock('../src/shared/logger', () => {
  const logger = {
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

const {
  atomicWriteFile,
  safeUnlink,
  loadJsonFile,
  persistData,
  persistMap,
  loadMap,
  isWindowsFileLockError,
  replaceFileWithRetry
} = require('../src/shared/atomicFile');

describe('atomicFile', () => {
  let testDir;
  let testFile;

  beforeEach(async () => {
    // FL-3 FIX: Use fs.mkdtemp for guaranteed-unique temp directories
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomicfile-test-'));
    testFile = path.join(testDir, 'test.json');
  });

  afterEach(async () => {
    // FL-3 FIX: Use fs.rm with retries instead of deprecated fs.rmdir
    try {
      await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('atomicWriteFile', () => {
    test('writes data to file', async () => {
      const data = { foo: 'bar', count: 42 };

      await atomicWriteFile(testFile, data);

      const content = await fs.readFile(testFile, 'utf8');
      expect(JSON.parse(content)).toEqual(data);
    });

    test('writes pretty-printed JSON when option set', async () => {
      const data = { foo: 'bar' };

      await atomicWriteFile(testFile, data, { pretty: true });

      const content = await fs.readFile(testFile, 'utf8');
      expect(content).toBe(JSON.stringify(data, null, 2));
    });

    test('overwrites existing file atomically', async () => {
      const original = { version: 1 };
      const updated = { version: 2 };

      await atomicWriteFile(testFile, original);
      await atomicWriteFile(testFile, updated);

      const content = await fs.readFile(testFile, 'utf8');
      expect(JSON.parse(content)).toEqual(updated);
    });

    test('cleans up temp file on rename error', async () => {
      // Mock fs.rename to simulate a rename failure
      const originalRename = fs.rename;
      jest
        .spyOn(fs, 'rename')
        .mockRejectedValue(Object.assign(new Error('Simulated rename error'), { code: 'ENOENT' }));

      await expect(atomicWriteFile(testFile, { test: true })).rejects.toThrow(
        'Simulated rename error'
      );

      // Restore fs.rename
      fs.rename = originalRename;

      // Verify no temp files left behind
      const files = await fs.readdir(testDir);
      expect(files.filter((f) => f.includes('.tmp.'))).toHaveLength(0);
    });

    test('writes arrays correctly', async () => {
      const data = [1, 2, 3, { nested: true }];

      await atomicWriteFile(testFile, data);

      const content = await fs.readFile(testFile, 'utf8');
      expect(JSON.parse(content)).toEqual(data);
    });
  });

  describe('safeUnlink', () => {
    test('deletes existing file', async () => {
      await fs.writeFile(testFile, 'test');

      await safeUnlink(testFile);

      await expect(fs.access(testFile)).rejects.toThrow();
    });

    test('does not throw for non-existent file', async () => {
      const nonExistent = path.join(testDir, 'does-not-exist.json');

      await expect(safeUnlink(nonExistent)).resolves.toBeUndefined();
    });

    test('propagates non-ENOENT errors', async () => {
      // Create a file and make it read-only
      const readOnlyFile = path.join(testDir, 'readonly.txt');
      await fs.writeFile(readOnlyFile, 'test');

      // On Windows, we test by trying to delete a directory (different error)
      // On Unix, we'd make file readonly, but that's complex cross-platform
      // So just verify safeUnlink doesn't swallow all errors - it only ignores ENOENT
      const originalUnlink = fs.unlink;

      // Mock fs.unlink to throw a permission error
      jest
        .spyOn(fs, 'unlink')
        .mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));

      await expect(safeUnlink(readOnlyFile)).rejects.toThrow('Permission denied');

      // Restore
      fs.unlink = originalUnlink;
    });
  });

  describe('loadJsonFile', () => {
    test('loads and parses JSON file', async () => {
      const data = { loaded: true, value: 123 };
      await fs.writeFile(testFile, JSON.stringify(data));

      const result = await loadJsonFile(testFile);

      expect(result).toEqual(data);
    });

    test('returns null for non-existent file', async () => {
      const result = await loadJsonFile(path.join(testDir, 'missing.json'));

      expect(result).toBeNull();
    });

    test('calls onLoad callback with parsed data', async () => {
      const data = { test: 'callback' };
      await fs.writeFile(testFile, JSON.stringify(data));
      const onLoad = jest.fn();

      await loadJsonFile(testFile, { onLoad });

      expect(onLoad).toHaveBeenCalledWith(data);
    });

    test('handles corrupt JSON by returning null', async () => {
      await fs.writeFile(testFile, 'not valid json {{{');

      const result = await loadJsonFile(testFile, { backupCorrupt: false });

      expect(result).toBeNull();
    });

    test('backs up corrupt file when backupCorrupt is true', async () => {
      await fs.writeFile(testFile, 'invalid json');

      await loadJsonFile(testFile, { backupCorrupt: true });

      const files = await fs.readdir(testDir);
      expect(files.some((f) => f.includes('.corrupt.'))).toBe(true);
    });

    test('loads arrays correctly', async () => {
      const data = [1, 2, { three: 3 }];
      await fs.writeFile(testFile, JSON.stringify(data));

      const result = await loadJsonFile(testFile);

      expect(result).toEqual(data);
    });
  });

  describe('persistData', () => {
    test('writes non-empty object', async () => {
      const data = { key: 'value' };

      await persistData(testFile, data);

      const content = await fs.readFile(testFile, 'utf8');
      expect(JSON.parse(content)).toEqual(data);
    });

    test('writes non-empty array', async () => {
      const data = [1, 2, 3];

      await persistData(testFile, data);

      const content = await fs.readFile(testFile, 'utf8');
      expect(JSON.parse(content)).toEqual(data);
    });

    test('deletes file for empty object', async () => {
      await fs.writeFile(testFile, '{"old":"data"}');

      await persistData(testFile, {});

      await expect(fs.access(testFile)).rejects.toThrow();
    });

    test('deletes file for empty array', async () => {
      await fs.writeFile(testFile, '[1,2,3]');

      await persistData(testFile, []);

      await expect(fs.access(testFile)).rejects.toThrow();
    });

    test('handles non-existent file for empty data', async () => {
      // Should not throw even if file doesn't exist
      await expect(persistData(testFile, [])).resolves.toBeUndefined();
    });
  });

  describe('persistMap', () => {
    test('persists Map as array of entries', async () => {
      const map = new Map([
        ['key1', 'value1'],
        ['key2', { nested: true }]
      ]);

      await persistMap(testFile, map);

      const content = await fs.readFile(testFile, 'utf8');
      expect(JSON.parse(content)).toEqual([
        ['key1', 'value1'],
        ['key2', { nested: true }]
      ]);
    });

    test('deletes file for empty Map', async () => {
      await fs.writeFile(testFile, '[[1,2]]');

      await persistMap(testFile, new Map());

      await expect(fs.access(testFile)).rejects.toThrow();
    });
  });

  describe('loadMap', () => {
    test('loads Map from file', async () => {
      await fs.writeFile(
        testFile,
        JSON.stringify([
          ['a', 1],
          ['b', 2]
        ])
      );

      const result = await loadMap(testFile);

      expect(result).toBeInstanceOf(Map);
      expect(result.get('a')).toBe(1);
      expect(result.get('b')).toBe(2);
    });

    test('returns null for non-existent file', async () => {
      const result = await loadMap(path.join(testDir, 'missing.json'));

      expect(result).toBeNull();
    });

    test('returns null for non-array data', async () => {
      await fs.writeFile(testFile, JSON.stringify({ not: 'array' }));

      const result = await loadMap(testFile);

      expect(result).toBeNull();
    });
  });

  describe('isWindowsFileLockError', () => {
    test('returns true for EPERM', () => {
      const error = Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
      expect(isWindowsFileLockError(error)).toBe(true);
    });

    test('returns true for EACCES', () => {
      const error = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
      expect(isWindowsFileLockError(error)).toBe(true);
    });

    test('returns true for EBUSY', () => {
      const error = Object.assign(new Error('Resource busy'), { code: 'EBUSY' });
      expect(isWindowsFileLockError(error)).toBe(true);
    });

    test('returns false for ENOENT', () => {
      const error = Object.assign(new Error('No such file'), { code: 'ENOENT' });
      expect(isWindowsFileLockError(error)).toBe(false);
    });

    test('returns false for other errors', () => {
      const error = Object.assign(new Error('Unknown'), { code: 'UNKNOWN' });
      expect(isWindowsFileLockError(error)).toBe(false);
    });

    test('handles null/undefined error', () => {
      expect(isWindowsFileLockError(null)).toBe(false);
      expect(isWindowsFileLockError(undefined)).toBe(false);
    });
  });

  describe('replaceFileWithRetry', () => {
    test('renames file on first attempt when successful', async () => {
      const tempFile = path.join(testDir, 'temp.txt');
      const targetFile = path.join(testDir, 'target.txt');
      await fs.writeFile(tempFile, 'test content');

      await replaceFileWithRetry(tempFile, targetFile);

      const content = await fs.readFile(targetFile, 'utf8');
      expect(content).toBe('test content');
      await expect(fs.access(tempFile)).rejects.toThrow();
    });

    test('retries on EPERM and succeeds', async () => {
      const tempFile = path.join(testDir, 'temp.txt');
      const targetFile = path.join(testDir, 'target.txt');
      await fs.writeFile(tempFile, 'retry content');

      const originalRename = fs.rename;
      let attemptCount = 0;
      jest.spyOn(fs, 'rename').mockImplementation(async (src, dest) => {
        attemptCount++;
        if (attemptCount < 3) {
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        }
        return originalRename(src, dest);
      });

      await replaceFileWithRetry(tempFile, targetFile, { maxAttempts: 5, baseDelayMs: 5 });

      const content = await fs.readFile(targetFile, 'utf8');
      expect(content).toBe('retry content');
      expect(attemptCount).toBe(3);

      fs.rename = originalRename;
    });

    test('falls back to copy on persistent lock error', async () => {
      const tempFile = path.join(testDir, 'temp.txt');
      const targetFile = path.join(testDir, 'target.txt');
      await fs.writeFile(tempFile, 'fallback content');

      const originalRename = fs.rename;
      jest
        .spyOn(fs, 'rename')
        .mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));

      await replaceFileWithRetry(tempFile, targetFile, { maxAttempts: 2, baseDelayMs: 5 });

      const content = await fs.readFile(targetFile, 'utf8');
      expect(content).toBe('fallback content');

      fs.rename = originalRename;
    });

    test('throws non-lock errors immediately', async () => {
      const tempFile = path.join(testDir, 'temp.txt');
      const targetFile = path.join(testDir, 'target.txt');
      await fs.writeFile(tempFile, 'test');

      const originalRename = fs.rename;
      jest
        .spyOn(fs, 'rename')
        .mockRejectedValue(Object.assign(new Error('No such file'), { code: 'ENOENT' }));

      await expect(
        replaceFileWithRetry(tempFile, targetFile, { maxAttempts: 5, baseDelayMs: 5 })
      ).rejects.toThrow('No such file');

      fs.rename = originalRename;
    });
  });

  describe('integration', () => {
    test('atomicWriteFile + loadJsonFile roundtrip', async () => {
      const original = {
        nested: { data: [1, 2, 3] },
        string: 'hello',
        number: 42.5
      };

      await atomicWriteFile(testFile, original);
      const loaded = await loadJsonFile(testFile);

      expect(loaded).toEqual(original);
    });

    test('persistMap + loadMap roundtrip', async () => {
      const original = new Map([
        ['complex', { deeply: { nested: true } }],
        ['simple', 'value']
      ]);

      await persistMap(testFile, original);
      const loaded = await loadMap(testFile);

      expect(loaded.get('complex')).toEqual({ deeply: { nested: true } });
      expect(loaded.get('simple')).toBe('value');
    });
  });
});
