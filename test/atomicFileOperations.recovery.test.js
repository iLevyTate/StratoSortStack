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
const { AtomicFileOperations } = require('../src/shared/atomicFileOperations');

describe('AtomicFileOperations journal recovery', () => {
  let ops;

  beforeEach(async () => {
    jest.resetModules();
    ops = new AtomicFileOperations();
    await ops.initializeJournalDirectory();
  });

  afterEach(() => {
    if (ops && typeof ops.shutdown === 'function') {
      ops.shutdown();
    }
  });

  const writeJournal = async (id, journalData) => {
    const journalPath = path.join(ops.journalDirectory, `${id}.journal`);
    await fs.promises.writeFile(
      journalPath,
      JSON.stringify({ id, ...journalData }, null, 2),
      'utf8'
    );
    return journalPath;
  };

  test('cleans committed journals without running rollback recovery', async () => {
    const journalPath = await writeJournal('tx-committed', {
      status: 'committed',
      startTime: Date.now()
    });

    const result = await ops.recoverFromJournals();

    expect(result).toEqual({ recovered: 0, cleaned: 1, errors: 0, skipped: 0 });
    await expect(fs.promises.access(journalPath)).rejects.toBeDefined();
  });

  test('recovers active journals by restoring backups and removing partial destinations', async () => {
    const sourcePath = '/tmp/docs/original.txt';
    const backupPath = '/tmp/backups/original.backup';
    const partialDest = '/tmp/docs/partial-destination.txt';

    await fs.promises.mkdir('/tmp/docs', { recursive: true });
    await fs.promises.mkdir('/tmp/backups', { recursive: true });
    await fs.promises.writeFile(backupPath, 'restored-content', 'utf8');
    await fs.promises.writeFile(partialDest, 'partial', 'utf8');

    const journalPath = await writeJournal('tx-active', {
      status: 'active',
      startTime: Date.now(),
      backups: [{ source: sourcePath, backup: backupPath }],
      createdDestinations: [partialDest]
    });

    const result = await ops.recoverFromJournals();

    expect(result).toEqual({ recovered: 1, cleaned: 0, errors: 0, skipped: 0 });
    await expect(fs.promises.readFile(sourcePath, 'utf8')).resolves.toBe('restored-content');
    await expect(fs.promises.access(partialDest)).rejects.toBeDefined();
    await expect(fs.promises.access(backupPath)).rejects.toBeDefined();
    await expect(fs.promises.access(journalPath)).rejects.toBeDefined();
  });

  // backupAndReplace journals the same path as a backup source (delete) and a
  // created destination (create). Recovery must not restore it and then rm it.
  test('keeps a restored file that is also listed as a created destination (same-path delete+create)', async () => {
    const settingsPath = '/tmp/cfg/settings.json';
    const backupPath = '/tmp/backups/settings.backup';

    await fs.promises.mkdir('/tmp/cfg', { recursive: true });
    await fs.promises.mkdir('/tmp/backups', { recursive: true });
    await fs.promises.writeFile(backupPath, '{"theme":"dark"}', 'utf8');
    await fs.promises.writeFile(settingsPath, '{"the', 'utf8');

    const journalPath = await writeJournal('tx-same-path', {
      status: 'active',
      startTime: Date.now(),
      backups: [{ source: settingsPath, backup: backupPath }],
      createdDestinations: [settingsPath]
    });

    const result = await ops.recoverFromJournals();

    expect(result).toEqual({ recovered: 1, cleaned: 0, errors: 0, skipped: 0 });
    await expect(fs.promises.readFile(settingsPath, 'utf8')).resolves.toBe('{"theme":"dark"}');
    await expect(fs.promises.access(backupPath)).rejects.toBeDefined();
    await expect(fs.promises.access(journalPath)).rejects.toBeDefined();
  });

  test('keeps backups, destinations and the journal when a restore fails', async () => {
    const restorableSource = '/tmp/partial/restorable.txt';
    const restorableBackup = '/tmp/backups/restorable.backup';
    const lostSource = '/tmp/partial/lost.txt';
    const missingBackup = '/tmp/backups/does-not-exist.backup';
    const partialDest = '/tmp/partial/moved.txt';

    await fs.promises.mkdir('/tmp/partial', { recursive: true });
    await fs.promises.mkdir('/tmp/backups', { recursive: true });
    await fs.promises.writeFile(restorableBackup, 'restorable', 'utf8');
    await fs.promises.writeFile(partialDest, 'only remaining copy', 'utf8');

    const journalPath = await writeJournal('tx-failed-restore', {
      status: 'active',
      startTime: Date.now(),
      backups: [
        { source: restorableSource, backup: restorableBackup },
        { source: lostSource, backup: missingBackup }
      ],
      createdDestinations: [partialDest]
    });

    const result = await ops.recoverFromJournals();

    expect(result).toEqual({ recovered: 0, cleaned: 0, errors: 1, skipped: 0 });
    // The restore that could run still ran…
    await expect(fs.promises.readFile(restorableSource, 'utf8')).resolves.toBe('restorable');
    // …but nothing was discarded: the destination may be the only copy, the
    // surviving backup is still needed, and the journal must retry next launch.
    await expect(fs.promises.readFile(partialDest, 'utf8')).resolves.toBe('only remaining copy');
    await expect(fs.promises.access(restorableBackup)).resolves.toBeUndefined();
    await expect(fs.promises.access(journalPath)).resolves.toBeUndefined();
  });

  test('removes stale journals older than maxAge', async () => {
    const oldJournalPath = await writeJournal('tx-stale', {
      status: 'active',
      startTime: Date.now() - 5 * 60 * 1000 // 5 minutes ago
    });

    const result = await ops.recoverFromJournals(60 * 1000); // 1 minute max age

    expect(result).toEqual({ recovered: 0, cleaned: 1, errors: 0, skipped: 0 });
    await expect(fs.promises.access(oldJournalPath)).rejects.toBeDefined();
  });

  test('counts and removes corrupt journal files', async () => {
    const corruptPath = path.join(ops.journalDirectory, 'tx-corrupt.journal');
    await fs.promises.writeFile(corruptPath, '{invalid-json', 'utf8');

    const result = await ops.recoverFromJournals();

    expect(result).toEqual({ recovered: 0, cleaned: 0, errors: 1, skipped: 0 });
    await expect(fs.promises.access(corruptPath)).rejects.toBeDefined();
  });

  // F-043: createdDestinations must be journaled to disk BEFORE executeOperation
  // returns, otherwise a crash in the window between the rename and
  // commitTransaction's post-op flush leaves a journal with an empty
  // createdDestinations -- recovery then restores the source but cannot remove
  // the moved file, leaving a silent duplicate at both paths.
  test('journals the moved destination before executeOperation returns (F-043)', async () => {
    const source = '/tmp/f043-flush/source.txt';
    const destination = '/tmp/f043-flush/dest/source.txt';
    await fs.promises.mkdir('/tmp/f043-flush', { recursive: true });
    await fs.promises.writeFile(source, 'payload', 'utf8');

    const txId = await ops.beginTransaction();
    // Execute the single op WITHOUT committing -- this is exactly what
    // commitTransaction does (executeOperation, then a later writeJournal). The
    // on-disk journal at this point is what a hard kill mid-commit would leave.
    await ops.executeOperation(txId, { type: 'move', source, destination });

    const journalPath = path.join(ops.journalDirectory, `${txId}.journal`);
    const journal = JSON.parse(await fs.promises.readFile(journalPath, 'utf8'));

    expect(journal.status).toBe('active');
    expect(journal.createdDestinations).toContain(path.normalize(destination));
  });

  test('crash mid-move recovery removes the moved file instead of a duplicate (F-043)', async () => {
    const source = '/tmp/f043-dup/report.txt';
    const destination = '/tmp/f043-dup/sorted/report.txt';
    const expectedSource = path.normalize(source);
    const expectedDest = path.normalize(destination);
    await fs.promises.mkdir('/tmp/f043-dup', { recursive: true });
    await fs.promises.writeFile(source, 'report-content', 'utf8');

    const txId = await ops.beginTransaction();
    // Simulate a hard kill after the rename completes but before
    // commitTransaction's removeJournal: execute the op, leave the journal.
    await ops.executeOperation(txId, { type: 'move', source, destination });

    // The move happened: file now lives at the destination.
    await expect(fs.promises.readFile(expectedDest, 'utf8')).resolves.toBe('report-content');

    // Restart recovery (own-PID journals fall through to recovery).
    const result = await ops.recoverFromJournals();
    expect(result.recovered).toBe(1);

    // Source restored from backup AND the moved file removed -- no duplicate.
    await expect(fs.promises.readFile(expectedSource, 'utf8')).resolves.toBe('report-content');
    await expect(fs.promises.access(expectedDest)).rejects.toBeDefined();
  });
});
