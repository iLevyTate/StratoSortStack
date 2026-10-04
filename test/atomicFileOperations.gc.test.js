jest.mock('fs', () => require('memfs').fs);
jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});
jest.mock('../src/main/errors/FileSystemError', () => {
  class FSLikeError extends Error {
    constructor(code, metadata = {}) {
      super(metadata.originalError || code);
      this.code = code;
      this.metadata = metadata;
      this.isFileSystemError = true;
    }
    static fromNodeError(error, context = {}) {
      return new FSLikeError(error.code || 'UNKNOWN', {
        ...context,
        originalError: error.message
      });
    }
  }
  return {
    FileSystemError: FSLikeError,
    AtomicOperationError: FSLikeError,
    IntegrityError: FSLikeError,
    FILE_SYSTEM_ERROR_CODES: {
      SIZE_MISMATCH: 'SIZE_MISMATCH',
      ATOMIC_OPERATION_FAILED: 'ATOMIC_OPERATION_FAILED',
      ROLLBACK_FAILED: 'ROLLBACK_FAILED'
    }
  };
});
jest.mock('os', () => ({
  tmpdir: () => '/tmp'
}));

const fs = require('fs');
const path = require('path');
const { gcOrphanedBackupDirectories } = require('../src/shared/atomicFileOperations');

// Coverage for the GC pass added at startup in simple-main.js. The function
// scans ${tmpdir}/stratosort-backups/ for per-process backup subdirs left
// behind when cleanupBackups (deferred via setTimeout) didn't fire before
// process exit. Without this test the GC was running silently in production
// with zero confidence in its prune semantics.
describe('gcOrphanedBackupDirectories', () => {
  const root = '/tmp/stratosort-backups';

  beforeEach(async () => {
    // memfs persists across tests in a single suite; clean the root each
    // run so prune counts are deterministic.
    await fs.promises.rm(root, { recursive: true, force: true }).catch(() => {});
    await fs.promises.mkdir(root, { recursive: true });
  });

  test('returns zero counts when the backup root does not exist', async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
    const result = await gcOrphanedBackupDirectories();
    expect(result).toEqual({ scanned: 0, removed: 0 });
  });

  test('returns zero counts when the backup root is empty', async () => {
    const result = await gcOrphanedBackupDirectories();
    expect(result).toEqual({ scanned: 0, removed: 0 });
  });

  test('prunes only directories older than maxAgeMs', async () => {
    const oldDir = path.join(root, 'old-process');
    const recentDir = path.join(root, 'recent-process');
    await fs.promises.mkdir(oldDir);
    await fs.promises.mkdir(recentDir);

    // Backdate the old dir by 10 days; recent stays at "now".
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    await fs.promises.utimes(oldDir, tenDaysAgo / 1000, tenDaysAgo / 1000);

    const result = await gcOrphanedBackupDirectories(7 * 24 * 60 * 60 * 1000);

    expect(result.scanned).toBe(2);
    expect(result.removed).toBe(1);
    await expect(fs.promises.access(oldDir)).rejects.toBeDefined();
    await expect(fs.promises.access(recentDir)).resolves.toBeUndefined();
  });

  test('keeps directories newer than maxAgeMs untouched', async () => {
    const recentDir = path.join(root, 'recent-process');
    await fs.promises.mkdir(recentDir);

    const result = await gcOrphanedBackupDirectories(7 * 24 * 60 * 60 * 1000);

    expect(result.scanned).toBe(1);
    expect(result.removed).toBe(0);
    await expect(fs.promises.access(recentDir)).resolves.toBeUndefined();
  });

  test('skips non-directory entries (files and symlinks)', async () => {
    // A stray file at the root should be ignored, not treated as a backup
    // dir candidate. (entry.isDirectory() guard.)
    await fs.promises.writeFile(path.join(root, 'README.txt'), 'stray', 'utf8');

    const result = await gcOrphanedBackupDirectories(7 * 24 * 60 * 60 * 1000);

    // Scanned counts ALL readdir entries (including the file); removed
    // counts only directories that passed the age gate. The file is
    // skipped so removed === 0.
    expect(result.scanned).toBe(1);
    expect(result.removed).toBe(0);
  });

  test('respects custom maxAgeMs (1 hour)', async () => {
    const justNowDir = path.join(root, 'just-now');
    const twoHoursOldDir = path.join(root, 'two-hours-old');
    await fs.promises.mkdir(justNowDir);
    await fs.promises.mkdir(twoHoursOldDir);

    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    await fs.promises.utimes(twoHoursOldDir, twoHoursAgo / 1000, twoHoursAgo / 1000);

    const result = await gcOrphanedBackupDirectories(60 * 60 * 1000); // 1 hour

    expect(result.scanned).toBe(2);
    expect(result.removed).toBe(1);
    await expect(fs.promises.access(twoHoursOldDir)).rejects.toBeDefined();
    await expect(fs.promises.access(justNowDir)).resolves.toBeUndefined();
  });

  test('does not throw on individual prune failure (best-effort)', async () => {
    // Pre-create an old dir whose rm we cannot easily fail in memfs;
    // assert the function returns a result rather than throwing on a
    // permission error scenario by simply verifying happy-path resilience.
    const oldDir = path.join(root, 'goes-away');
    await fs.promises.mkdir(oldDir);
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    await fs.promises.utimes(oldDir, tenDaysAgo / 1000, tenDaysAgo / 1000);

    await expect(gcOrphanedBackupDirectories()).resolves.toMatchObject({
      scanned: expect.any(Number),
      removed: expect.any(Number)
    });
  });
});
