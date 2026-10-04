/**
 * @jest-environment node
 */
/**
 * Tests for AtomicFileOperations
 * Tests transactional file operations with rollback capabilities
 */

// Unmock fs to use real filesystem for these tests
// The global test-setup mocks fs with memfs, but this causes path resolution
// issues on Windows. These tests need the real filesystem.
jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const path = jest.requireActual('path');
const fs = require('fs').promises;
const os = require('os');

const normalizeTestPath = (value) => path.normalize(value);

describe('AtomicFileOperations', () => {
  let AtomicFileOperations;
  let atomicFileOps;
  let crossDeviceMove;
  let renameNoReplace;
  let organizeFilesAtomically;
  let testDir;
  // Track created instances for cleanup
  const createdInstances = [];

  beforeEach(async () => {
    // FL-3 FIX: Use fs.mkdtemp for guaranteed-unique temp directories
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-test-'));

    // Clear module cache to ensure fresh imports
    jest.resetModules();

    const module = require('../src/shared/atomicFileOperations');
    // Wrap AtomicFileOperations to track instances
    const OriginalClass = module.AtomicFileOperations;
    AtomicFileOperations = function (...args) {
      const instance = new OriginalClass(...args);
      createdInstances.push(instance);
      return instance;
    };
    AtomicFileOperations.prototype = OriginalClass.prototype;
    atomicFileOps = module.atomicFileOps;
    crossDeviceMove = module.crossDeviceMove;
    renameNoReplace = module.renameNoReplace;
    organizeFilesAtomically = module.organizeFilesAtomically;
  });

  afterEach(async () => {
    // Clean up all created AtomicFileOperations instances
    for (const instance of createdInstances) {
      if (instance && typeof instance.shutdown === 'function') {
        instance.shutdown();
      }
    }
    createdInstances.length = 0;

    // Cleanup test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('AtomicFileOperations class', () => {
    test('constructor initializes with defaults', () => {
      const ops = new AtomicFileOperations();
      expect(ops.activeTransactions).toBeInstanceOf(Map);
      expect(ops.backupDirectory).toBeNull();
      expect(ops.journalBaseDirectory).toBeNull();
      expect(ops.operationTimeout).toBe(30000);
    });

    test('generateTransactionId creates unique IDs', () => {
      const ops = new AtomicFileOperations();
      const id1 = ops.generateTransactionId();
      const id2 = ops.generateTransactionId();

      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
      expect(id1).not.toBe(id2);
      expect(id1).toHaveLength(32); // 16 bytes hex
    });

    test('initializeJournalDirectory uses injected journal base directory when provided', async () => {
      const ops = new AtomicFileOperations();
      const customBase = path.join(testDir, 'userData');
      ops.setJournalBaseDirectory(customBase);

      const journalDir = await ops.initializeJournalDirectory();

      expect(normalizeTestPath(journalDir)).toBe(
        normalizeTestPath(path.join(customBase, 'stratosort-journals'))
      );
      await expect(fs.stat(journalDir)).resolves.toBeDefined();
    });
  });

  describe('fileExists', () => {
    test('returns true for existing file', async () => {
      const filePath = path.join(testDir, 'exists.txt');
      await fs.writeFile(filePath, 'content');

      const result = await atomicFileOps.fileExists(filePath);
      expect(result).toBe(true);
    });

    test('returns false for non-existing file', async () => {
      const filePath = path.join(testDir, 'not-exists.txt');

      const result = await atomicFileOps.fileExists(filePath);
      expect(result).toBe(false);
    });
  });

  describe('generateUniqueFilename', () => {
    test('returns original path if no conflict', async () => {
      const filePath = path.join(testDir, 'unique.txt');

      const result = await atomicFileOps.generateUniqueFilename(filePath);
      expect(normalizeTestPath(result)).toBe(normalizeTestPath(filePath));
    });

    test('generates unique filename when conflict exists', async () => {
      const filePath = path.join(testDir, 'conflict.txt');
      await fs.writeFile(filePath, 'content');

      const result = await atomicFileOps.generateUniqueFilename(filePath);
      expect(normalizeTestPath(result)).toBe(
        normalizeTestPath(path.join(testDir, 'conflict_1.txt'))
      );
    });

    test('increments counter for multiple conflicts', async () => {
      const filePath = path.join(testDir, 'multi.txt');
      await fs.writeFile(filePath, 'content');
      await fs.writeFile(path.join(testDir, 'multi_1.txt'), 'content');
      await fs.writeFile(path.join(testDir, 'multi_2.txt'), 'content');

      const result = await atomicFileOps.generateUniqueFilename(filePath);
      expect(normalizeTestPath(result)).toBe(normalizeTestPath(path.join(testDir, 'multi_3.txt')));
    });
  });

  describe('beginTransaction', () => {
    test('creates transaction with unique ID', async () => {
      const ops = new AtomicFileOperations();
      const id = await ops.beginTransaction();

      expect(id).toBeDefined();
      expect(ops.activeTransactions.has(id)).toBe(true);
    });

    test('transaction has correct initial state', async () => {
      const ops = new AtomicFileOperations();
      const id = await ops.beginTransaction();
      const transaction = ops.activeTransactions.get(id);

      expect(transaction.status).toBe('active');
      expect(transaction.operations).toEqual([]);
      expect(transaction.backups).toEqual([]);
      expect(transaction.startTime).toBeDefined();
    });

    test('accepts initial operations', async () => {
      const ops = new AtomicFileOperations();
      const initialOps = [{ type: 'move', source: 'a', destination: 'b' }];
      const id = await ops.beginTransaction(initialOps);
      const transaction = ops.activeTransactions.get(id);

      expect(transaction.operations).toHaveLength(1);
    });
  });

  describe('addOperation', () => {
    test('adds operation to transaction', async () => {
      const ops = new AtomicFileOperations();
      const id = await ops.beginTransaction();

      ops.addOperation(id, { type: 'move', source: 'a', destination: 'b' });

      const transaction = ops.activeTransactions.get(id);
      expect(transaction.operations).toHaveLength(1);
      expect(transaction.operations[0].type).toBe('move');
    });

    test('throws for non-existent transaction', () => {
      const ops = new AtomicFileOperations();

      expect(() => {
        ops.addOperation('invalid-id', { type: 'move' });
      }).toThrow('Transaction invalid-id not found');
    });

    test('adds timestamp and id to operation', async () => {
      const ops = new AtomicFileOperations();
      const id = await ops.beginTransaction();

      ops.addOperation(id, { type: 'move', source: 'a', destination: 'b' });

      const transaction = ops.activeTransactions.get(id);
      expect(transaction.operations[0].id).toBeDefined();
      expect(transaction.operations[0].timestamp).toBeDefined();
    });
  });

  describe('atomicMove', () => {
    test('moves file to destination', async () => {
      const source = path.join(testDir, 'source.txt');
      const dest = path.join(testDir, 'dest.txt');
      await fs.writeFile(source, 'content');

      const result = await atomicFileOps.atomicMove(source, dest);

      expect(normalizeTestPath(result)).toBe(normalizeTestPath(dest));
      expect(await atomicFileOps.fileExists(source)).toBe(false);
      expect(await atomicFileOps.fileExists(dest)).toBe(true);
    });

    test('creates destination directory if needed', async () => {
      const source = path.join(testDir, 'source.txt');
      const dest = path.join(testDir, 'subdir', 'dest.txt');
      await fs.writeFile(source, 'content');

      await atomicFileOps.atomicMove(source, dest);

      expect(await atomicFileOps.fileExists(dest)).toBe(true);
    });

    test('renames to unique filename on conflict', async () => {
      // The EEXIST check prevents data loss by falling back to unique names
      const source = path.join(testDir, 'source.txt');
      const dest = path.join(testDir, 'dest.txt');
      const expectedDest = path.join(testDir, 'dest_1.txt');
      await fs.writeFile(source, 'new content');
      await fs.writeFile(dest, 'existing');

      const result = await atomicFileOps.atomicMove(source, dest);

      expect(normalizeTestPath(result)).toBe(normalizeTestPath(expectedDest));
      // Verify the original file was NOT overwritten
      const originalContent = await fs.readFile(dest, 'utf8');
      expect(originalContent).toBe('existing');
      // Verify the new file was created
      const newContent = await fs.readFile(expectedDest, 'utf8');
      expect(newContent).toBe('new content');
    });

    test('serializes concurrent moves to the same destination without overwriting', async () => {
      // Two different sources racing for the same destination. Without the
      // per-destination mutex the fileExists()->rename() preflight is a TOCTOU:
      // both see "free", both rename, and the second silently overwrites the
      // first (data loss). Serialized, the first wins the destination and the
      // second falls back to a unique name — both payloads survive.
      const sourceA = path.join(testDir, 'concurrent-a.txt');
      const sourceB = path.join(testDir, 'concurrent-b.txt');
      const dest = path.join(testDir, 'concurrent-dest.txt');
      await fs.writeFile(sourceA, 'AAA');
      await fs.writeFile(sourceB, 'BBB');

      const [resA, resB] = await Promise.all([
        atomicFileOps.atomicMove(sourceA, dest),
        atomicFileOps.atomicMove(sourceB, dest)
      ]);

      // Distinct destinations — no silent overwrite.
      expect(normalizeTestPath(resA)).not.toBe(normalizeTestPath(resB));
      expect(await atomicFileOps.fileExists(resA)).toBe(true);
      expect(await atomicFileOps.fileExists(resB)).toBe(true);

      // Both payloads survived the race.
      const contents = [await fs.readFile(resA, 'utf8'), await fs.readFile(resB, 'utf8')].sort();
      expect(contents).toEqual(['AAA', 'BBB']);

      // Both sources were consumed.
      expect(await atomicFileOps.fileExists(sourceA)).toBe(false);
      expect(await atomicFileOps.fileExists(sourceB)).toBe(false);
    });

    test('unique-name fallback locks the fallback name — cannot overwrite a concurrent mover targeting it directly [F-151]', async () => {
      // Mover B targets an occupied dest and falls back to dest_1; mover C
      // targets dest_1 DIRECTLY. Pre-fix, the destination lock was keyed once
      // on B's ORIGINAL name, so B's fileExists()->rename() preflight against
      // dest_1 ran outside C's dest_1 lock — both saw "free", both renamed,
      // and one payload was silently destroyed. The fileExists spy pins the
      // interleaving: B's preflight read of dest_1 is held open until C's
      // move has landed (or a timeout under the fixed code, where C is queued
      // behind B's dest_1 lock), making the stale-read window deterministic
      // in both code shapes.
      const sourceB = path.join(testDir, 'fallback-b.txt');
      const sourceC = path.join(testDir, 'fallback-c.txt');
      const dest = path.join(testDir, 'fallback-dest.txt');
      const fallbackDest = path.join(testDir, 'fallback-dest_1.txt');
      await fs.writeFile(sourceB, 'B-payload');
      await fs.writeFile(sourceC, 'C-payload');
      await fs.writeFile(dest, 'occupier');

      let armed = false;
      let startC = () => {};
      const cStarted = new Promise((resolve) => {
        startC = resolve;
      });

      const realGenerate = atomicFileOps.generateUniqueFilename.bind(atomicFileOps);
      jest.spyOn(atomicFileOps, 'generateUniqueFilename').mockImplementation(async (p) => {
        const result = await realGenerate(p);
        // A fallback name was just picked; the NEXT preflight read of that
        // name is the one the old code performed under the wrong lock.
        armed = true;
        return result;
      });

      const realFileExists = atomicFileOps.fileExists.bind(atomicFileOps);
      jest.spyOn(atomicFileOps, 'fileExists').mockImplementation(async (p) => {
        const isFallbackPreflight = armed && path.normalize(p) === path.normalize(fallbackDest);
        const result = await realFileExists(p);
        if (isFallbackPreflight) {
          armed = false;
          startC();
          // Give C the whole window to land its own rename to dest_1. Under
          // the fixed code C is queued behind B's dest_1 lock, so the timeout
          // releases B with its still-valid read instead of deadlocking.
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        return result;
      });

      const bPromise = atomicFileOps.atomicMove(sourceB, dest);
      const cPromise = (async () => {
        await cStarted;
        return atomicFileOps.atomicMove(sourceC, fallbackDest);
      })();

      const [resB, resC] = await Promise.all([bPromise, cPromise]);

      // Distinct final destinations — nobody renamed over the other.
      expect(normalizeTestPath(resB)).not.toBe(normalizeTestPath(resC));
      // Every payload survived: the occupier plus both moved files.
      expect(await fs.readFile(dest, 'utf8')).toBe('occupier');
      const contents = [await fs.readFile(resB, 'utf8'), await fs.readFile(resC, 'utf8')].sort();
      expect(contents).toEqual(['B-payload', 'C-payload']);
      expect(await atomicFileOps.fileExists(sourceB)).toBe(false);
      expect(await atomicFileOps.fileExists(sourceC)).toBe(false);
    });

    // Regression (EXDEV branch): after a verified cross-device copy, an ENOENT
    // on the source unlink means the source is already gone — the destination
    // is the only surviving copy and MUST be preserved, not rolled back.
    test('EXDEV fallback treats ENOENT on source unlink as a completed move', async () => {
      const source = path.join(testDir, 'exdev-enoent-source.txt');
      const dest = path.join(testDir, 'exdev-enoent-dest.txt');
      const content = 'exdev enoent content';
      await fs.writeFile(source, content);

      // Force only the source→dest rename into the cross-device branch. The
      // staged copy is published by a second rename (staging→dest, same
      // volume) that must be allowed through.
      const realRename = fs.rename.bind(fs);
      const renameSpy = jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (path.normalize(from) === path.normalize(source)) {
          const err = new Error('EXDEV: cross-device link not permitted');
          err.code = 'EXDEV';
          throw err;
        }
        return realRename(from, to);
      });
      const realUnlink = fs.unlink.bind(fs);
      const unlinkSpy = jest.spyOn(fs, 'unlink').mockImplementation(async (target) => {
        if (path.normalize(target) === path.normalize(source)) {
          const err = new Error('ENOENT: no such file or directory');
          err.code = 'ENOENT';
          throw err;
        }
        return realUnlink(target);
      });

      try {
        const result = await atomicFileOps.atomicMove(source, dest);
        expect(normalizeTestPath(result)).toBe(normalizeTestPath(dest));
        expect(await fs.readFile(dest, 'utf8')).toBe(content);
      } finally {
        renameSpy.mockRestore();
        unlinkSpy.mockRestore();
      }
    });

    // Regression: the EXDEV branch used to `return await crossDeviceMove()`,
    // which resolves void — so executeOperation recorded `undefined` in
    // createdDestinations and rollback could not remove the copied file.
    test('EXDEV fallback resolves the final destination path', async () => {
      const source = path.join(testDir, 'exdev-return-source.txt');
      const dest = path.join(testDir, 'exdev-return-dest.txt');
      await fs.writeFile(source, 'cross-device payload');

      const realRename = fs.rename.bind(fs);
      const renameSpy = jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (path.normalize(from) === path.normalize(source)) {
          const err = new Error('EXDEV: cross-device link not permitted');
          err.code = 'EXDEV';
          throw err;
        }
        return realRename(from, to);
      });

      try {
        const result = await atomicFileOps.atomicMove(source, dest);
        expect(typeof result).toBe('string');
        expect(normalizeTestPath(result)).toBe(normalizeTestPath(dest));
        expect(await atomicFileOps.fileExists(source)).toBe(false);
        expect(await fs.readFile(dest, 'utf8')).toBe('cross-device payload');
      } finally {
        renameSpy.mockRestore();
      }
    });
  });

  describe('atomicCopy', () => {
    test('copies file to destination', async () => {
      const source = path.join(testDir, 'source.txt');
      const dest = path.join(testDir, 'dest.txt');
      await fs.writeFile(source, 'content');

      const result = await atomicFileOps.atomicCopy(source, dest);

      expect(normalizeTestPath(result)).toBe(normalizeTestPath(dest));
      expect(await atomicFileOps.fileExists(source)).toBe(true);
      expect(await atomicFileOps.fileExists(dest)).toBe(true);
    });

    test('verifies copy integrity', async () => {
      const source = path.join(testDir, 'source.txt');
      const dest = path.join(testDir, 'dest.txt');
      const content = 'test content for integrity check';
      await fs.writeFile(source, content);

      await atomicFileOps.atomicCopy(source, dest);

      const sourceStats = await fs.stat(source);
      const destStats = await fs.stat(dest);
      expect(destStats.size).toBe(sourceStats.size);
    });
  });

  describe('atomicCreate', () => {
    test('creates file with content', async () => {
      const filePath = path.join(testDir, 'new.txt');
      const content = 'new content';

      const result = await atomicFileOps.atomicCreate(filePath, content);

      expect(normalizeTestPath(result)).toBe(normalizeTestPath(filePath));
      const readContent = await fs.readFile(filePath, 'utf8');
      expect(readContent).toBe(content);
    });

    test('creates directory if needed', async () => {
      const filePath = path.join(testDir, 'newdir', 'new.txt');
      const content = 'content';

      await atomicFileOps.atomicCreate(filePath, content);

      expect(await atomicFileOps.fileExists(filePath)).toBe(true);
    });

    test('handles Buffer content', async () => {
      const filePath = path.join(testDir, 'buffer.txt');
      const content = Buffer.from('buffer content');

      await atomicFileOps.atomicCreate(filePath, content);

      const readContent = await fs.readFile(filePath);
      expect(readContent.toString()).toBe('buffer content');
    });
  });

  describe('createBackup', () => {
    test('creates backup copy of file', async () => {
      const ops = new AtomicFileOperations();
      const source = path.join(testDir, 'to-backup.txt');
      await fs.writeFile(source, 'backup content');

      const id = ops.generateTransactionId();
      const backupPath = await ops.createBackup(source, id);

      expect(backupPath).toBeDefined();
      expect(await ops.fileExists(backupPath)).toBe(true);
    });

    test('backup has same size as original', async () => {
      const ops = new AtomicFileOperations();
      const source = path.join(testDir, 'to-backup.txt');
      const content = 'backup content with some data';
      await fs.writeFile(source, content);

      const id = ops.generateTransactionId();
      const backupPath = await ops.createBackup(source, id);

      const sourceStats = await fs.stat(source);
      const backupStats = await fs.stat(backupPath);
      expect(backupStats.size).toBe(sourceStats.size);
    });
  });

  describe('getTransactionStatus', () => {
    test('returns null for non-existent transaction', () => {
      const ops = new AtomicFileOperations();
      const status = ops.getTransactionStatus('invalid-id');
      expect(status).toBeNull();
    });

    test('returns correct status for active transaction', async () => {
      const ops = new AtomicFileOperations();
      const id = await ops.beginTransaction();
      ops.addOperation(id, { type: 'move', source: 'a', destination: 'b' });

      const status = ops.getTransactionStatus(id);

      expect(status.id).toBe(id);
      expect(status.status).toBe('active');
      expect(status.operationCount).toBe(1);
      expect(status.backupCount).toBe(0);
      expect(status.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getActiveTransactions', () => {
    test('returns empty array when no transactions', () => {
      const ops = new AtomicFileOperations();
      const active = ops.getActiveTransactions();
      expect(active).toEqual([]);
    });

    test('returns all active transactions', async () => {
      const ops = new AtomicFileOperations();
      await ops.beginTransaction();
      await ops.beginTransaction();

      const active = ops.getActiveTransactions();
      expect(active).toHaveLength(2);
    });
  });

  describe('cleanupStaleTransactions', () => {
    test('removes transactions older than maxAge', async () => {
      const ops = new AtomicFileOperations();
      const id = await ops.beginTransaction();

      // Manually set old start time
      ops.activeTransactions.get(id).startTime = Date.now() - 7200000; // 2 hours ago

      const removed = await ops.cleanupStaleTransactions(3600000); // 1 hour

      expect(removed).toBe(1);
      expect(ops.activeTransactions.has(id)).toBe(false);
    });

    test('keeps recent transactions', async () => {
      const ops = new AtomicFileOperations();
      const id = await ops.beginTransaction();

      const removed = await ops.cleanupStaleTransactions(3600000);

      expect(removed).toBe(0);
      expect(ops.activeTransactions.has(id)).toBe(true);
    });
  });

  describe('crossDeviceMove', () => {
    test('copies file and deletes source', async () => {
      const source = path.join(testDir, 'cross-source.txt');
      const dest = path.join(testDir, 'cross-dest.txt');
      await fs.writeFile(source, 'cross device content');

      await crossDeviceMove(source, dest);

      expect(await atomicFileOps.fileExists(source)).toBe(false);
      expect(await atomicFileOps.fileExists(dest)).toBe(true);
    });

    test('verifies file size by default', async () => {
      const source = path.join(testDir, 'verify-source.txt');
      const dest = path.join(testDir, 'verify-dest.txt');
      const content = 'content for verification';
      await fs.writeFile(source, content);

      await crossDeviceMove(source, dest);

      const destContent = await fs.readFile(dest, 'utf8');
      expect(destContent).toBe(content);
    });

    test('skips verification when verify is false', async () => {
      const source = path.join(testDir, 'no-verify-source.txt');
      const dest = path.join(testDir, 'no-verify-dest.txt');
      await fs.writeFile(source, 'content');

      await crossDeviceMove(source, dest, { verify: false });

      expect(await atomicFileOps.fileExists(dest)).toBe(true);
    });

    test('creates destination directory when missing', async () => {
      const source = path.join(testDir, 'nested-source.txt');
      const dest = path.join(testDir, 'nested', 'deep', 'nested-dest.txt');
      await fs.writeFile(source, 'nested content');

      await crossDeviceMove(source, dest);

      expect(await atomicFileOps.fileExists(dest)).toBe(true);
      expect(await atomicFileOps.fileExists(source)).toBe(false);
    });

    // Regression: a verified copy followed by an ENOENT source unlink means the
    // source is already gone. The destination is then the only surviving copy, so
    // it MUST be preserved rather than rolled back (which would destroy the file).
    test('treats ENOENT on source unlink as a completed move (preserves destination)', async () => {
      const source = path.join(testDir, 'enoent-source.txt');
      const dest = path.join(testDir, 'enoent-dest.txt');
      const content = 'enoent content';
      await fs.writeFile(source, content);

      const realUnlink = fs.unlink.bind(fs);
      const unlinkSpy = jest.spyOn(fs, 'unlink').mockImplementation(async (target) => {
        if (path.normalize(target) === path.normalize(source)) {
          const err = new Error('ENOENT: no such file or directory');
          err.code = 'ENOENT';
          throw err;
        }
        return realUnlink(target);
      });

      try {
        await expect(crossDeviceMove(source, dest)).resolves.toBeUndefined();
        expect(await atomicFileOps.fileExists(dest)).toBe(true);
        expect(await fs.readFile(dest, 'utf8')).toBe(content);
      } finally {
        unlinkSpy.mockRestore();
      }
    });

    // Regression: a non-ENOENT source unlink failure (e.g. EACCES) means the source
    // still exists, so leaving the copy would duplicate the file — roll back and throw.
    test('rolls back destination when source unlink fails with a non-ENOENT error', async () => {
      const source = path.join(testDir, 'eacces-source.txt');
      const dest = path.join(testDir, 'eacces-dest.txt');
      await fs.writeFile(source, 'eacces content');

      const realUnlink = fs.unlink.bind(fs);
      const unlinkSpy = jest.spyOn(fs, 'unlink').mockImplementation(async (target) => {
        if (path.normalize(target) === path.normalize(source)) {
          const err = new Error('EACCES: permission denied');
          err.code = 'EACCES';
          throw err;
        }
        return realUnlink(target);
      });

      try {
        await expect(crossDeviceMove(source, dest)).rejects.toThrow();
        expect(await atomicFileOps.fileExists(dest)).toBe(false);
      } finally {
        unlinkSpy.mockRestore();
      }
    });

    // Regression: the copy must be staged under a temp name, never written
    // directly at the canonical destination. A copy that dies mid-write must
    // leave NOTHING at the final name (a truncated file there is
    // indistinguishable from the real document and shunts the genuine file to
    // a `_1` suffix on resume) and must reap its own staging artifact.
    test('mid-copy failure leaves no file at the final name and cleans up the staging artifact', async () => {
      const source = path.join(testDir, 'midcopy-source.txt');
      const dest = path.join(testDir, 'midcopy-dest.txt');
      await fs.writeFile(source, 'full content that never finishes copying');

      const copySpy = jest.spyOn(fs, 'copyFile').mockImplementation(async (_src, target) => {
        // Simulate a crash mid-copy: partial bytes land at the copy target,
        // then the operation dies (ENOSPC, power loss, kill -9, ...).
        await fs.writeFile(target, 'full con');
        const err = new Error('ENOSPC: no space left on device');
        err.code = 'ENOSPC';
        throw err;
      });

      try {
        await expect(crossDeviceMove(source, dest)).rejects.toThrow();
        // The canonical destination name was never occupied by partial data.
        expect(await atomicFileOps.fileExists(dest)).toBe(false);
        // The staging artifact was reaped in the error path.
        const leftovers = (await fs.readdir(testDir)).filter(
          (name) => name.includes('stratosort-') || name.endsWith('.tmp')
        );
        expect(leftovers).toEqual([]);
        // The source — the only intact copy — is untouched.
        expect(await atomicFileOps.fileExists(source)).toBe(true);
      } finally {
        copySpy.mockRestore();
      }
    });

    // Verification failures (size/checksum) happen against the STAGED copy;
    // rejecting must reap the staging artifact and never touch the final name.
    test('checksum verification failure cleans up the staging artifact and preserves the source', async () => {
      const source = path.join(testDir, 'cksum-source.txt');
      const dest = path.join(testDir, 'cksum-dest.txt');
      await fs.writeFile(source, 'checksum content');

      const checksumFn = jest.fn(async (target) =>
        path.normalize(target) === path.normalize(source) ? 'aaa' : 'bbb'
      );

      await expect(crossDeviceMove(source, dest, { checksumFn })).rejects.toThrow();
      expect(await atomicFileOps.fileExists(dest)).toBe(false);
      const leftovers = (await fs.readdir(testDir)).filter(
        (name) => name.includes('stratosort-') || name.endsWith('.tmp')
      );
      expect(leftovers).toEqual([]);
      expect(await fs.readFile(source, 'utf8')).toBe('checksum content');
    });

    // The staging rename publishes with no-replace semantics, preserving the
    // COPYFILE_EXCL contract of the old direct copy: an occupied destination
    // must surface as an error, leave the occupant intact, and reap staging.
    test('fails without clobbering an occupied destination and leaves no staging artifact', async () => {
      const source = path.join(testDir, 'occupied-source.txt');
      const dest = path.join(testDir, 'occupied-dest.txt');
      await fs.writeFile(source, 'incoming');
      await fs.writeFile(dest, 'existing occupant');

      await expect(crossDeviceMove(source, dest)).rejects.toThrow();
      expect(await fs.readFile(dest, 'utf8')).toBe('existing occupant');
      expect(await fs.readFile(source, 'utf8')).toBe('incoming');
      const leftovers = (await fs.readdir(testDir)).filter(
        (name) => name.includes('stratosort-') || name.endsWith('.tmp')
      );
      expect(leftovers).toEqual([]);
    });

    // Staging names end in `.tmp` so SmartFolderWatcher/DownloadWatcher's
    // isTemporaryFile() gate ignores an in-flight (or crash-orphaned) copy
    // instead of feeding partial data into auto-analysis.
    test('staging artifact name is ignored by the temp-file watcher gate', async () => {
      const { isTemporaryFile } = jest.requireActual('../src/shared/performanceConstants');
      const source = path.join(testDir, 'gate-source.txt');
      const dest = path.join(testDir, 'gate-dest.txt');
      await fs.writeFile(source, 'gate content');

      /** Capture the staging path the module actually uses. */
      let stagingTarget = null;
      const realCopy = fs.copyFile.bind(fs);
      const copySpy = jest.spyOn(fs, 'copyFile').mockImplementation(async (src, target, flags) => {
        stagingTarget = target;
        return realCopy(src, target, flags);
      });

      try {
        await crossDeviceMove(source, dest);
        expect(stagingTarget).not.toBeNull();
        expect(stagingTarget).not.toBe(path.normalize(dest));
        expect(isTemporaryFile(stagingTarget)).toBe(true);
        // The published file itself must NOT look temporary.
        expect(isTemporaryFile(dest)).toBe(false);
      } finally {
        copySpy.mockRestore();
      }
    });
  });

  describe('renameNoReplace', () => {
    test('moves file when destination is free', async () => {
      const source = path.join(testDir, 'nnr-source.txt');
      const dest = path.join(testDir, 'nnr-dest.txt');
      await fs.writeFile(source, 'payload');

      await renameNoReplace(source, dest);

      expect(await atomicFileOps.fileExists(source)).toBe(false);
      expect(await fs.readFile(dest, 'utf8')).toBe('payload');
    });

    test('throws EEXIST and leaves both files intact when destination is occupied', async () => {
      // Node's fs.rename silently REPLACES an existing destination on every
      // platform (POSIX rename(2); MOVEFILE_REPLACE_EXISTING on Windows).
      // renameNoReplace must fail closed instead of destroying the occupant.
      const source = path.join(testDir, 'nnr-src-occupied.txt');
      const dest = path.join(testDir, 'nnr-dst-occupied.txt');
      await fs.writeFile(source, 'incoming');
      await fs.writeFile(dest, 'existing-different-content');

      await expect(renameNoReplace(source, dest)).rejects.toMatchObject({
        code: 'EEXIST'
      });

      expect(await fs.readFile(source, 'utf8')).toBe('incoming');
      expect(await fs.readFile(dest, 'utf8')).toBe('existing-different-content');
    });

    test('allows case-only rename of the same file (case-insensitive filesystems)', async () => {
      // On win32/darwin, access(dest) finds the SOURCE itself for a
      // case-only rename; the preflight must not report that as EEXIST.
      const source = path.join(testDir, 'CaseFile.TXT');
      const dest = path.join(testDir, 'casefile.txt');
      await fs.writeFile(source, 'case-only');

      await renameNoReplace(source, dest);

      expect(await fs.readFile(dest, 'utf8')).toBe('case-only');
      const entries = await fs.readdir(testDir);
      expect(entries.filter((e) => e.toLowerCase() === 'casefile.txt')).toEqual(['casefile.txt']);
    });

    test('propagates ENOENT when source is missing', async () => {
      const source = path.join(testDir, 'nnr-missing.txt');
      const dest = path.join(testDir, 'nnr-missing-dest.txt');

      await expect(renameNoReplace(source, dest)).rejects.toMatchObject({
        code: 'ENOENT'
      });
    });
  });

  describe('commitTransaction', () => {
    test('executes all operations successfully', async () => {
      const ops = new AtomicFileOperations();
      const source = path.join(testDir, 'commit-source.txt');
      const dest = path.join(testDir, 'commit-dest.txt');
      await fs.writeFile(source, 'content');

      const id = await ops.beginTransaction();
      ops.addOperation(id, { type: 'move', source, destination: dest });

      const result = await ops.commitTransaction(id);

      expect(result.success).toBe(true);
      expect(await ops.fileExists(dest)).toBe(true);
    });

    test('sets transaction status to committed', async () => {
      const ops = new AtomicFileOperations();
      const id = await ops.beginTransaction();

      await ops.commitTransaction(id);

      const transaction = ops.activeTransactions.get(id);
      expect(transaction.status).toBe('committed');
    });
  });

  describe('rollbackTransaction', () => {
    test('throws for non-existent transaction', async () => {
      const ops = new AtomicFileOperations();

      await expect(ops.rollbackTransaction('invalid-id')).rejects.toThrow();
    });
  });

  describe('organizeFilesAtomically', () => {
    test('moves multiple files atomically', async () => {
      const source1 = path.join(testDir, 'org-source1.txt');
      const source2 = path.join(testDir, 'org-source2.txt');
      const dest1 = path.join(testDir, 'organized', 'dest1.txt');
      const dest2 = path.join(testDir, 'organized', 'dest2.txt');

      await fs.writeFile(source1, 'content1');
      await fs.writeFile(source2, 'content2');

      const result = await organizeFilesAtomically([
        { originalPath: source1, targetPath: dest1 },
        { originalPath: source2, targetPath: dest2 }
      ]);

      expect(result.success).toBe(true);
    });
  });
});
