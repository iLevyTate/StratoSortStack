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
    getUserFriendlyMessage() {
      return this.message;
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
      ROLLBACK_FAILED: 'ROLLBACK_FAILED',
      FILE_NOT_FOUND: 'FILE_NOT_FOUND',
      WRITE_FAILED: 'WRITE_FAILED',
      PARTIAL_WRITE: 'PARTIAL_WRITE'
    }
  };
});
jest.mock('os', () => ({
  tmpdir: () => '/tmp'
}));

const fs = require('fs');
const { AtomicFileOperations } = require('../src/shared/atomicFileOperations');

describe('AtomicFileOperations rollback and cross-device', () => {
  let ops;

  beforeEach(() => {
    jest.resetModules();
    ops = new AtomicFileOperations();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (ops && typeof ops.shutdown === 'function') {
      ops.shutdown();
    }
  });

  test('rollbackTransaction restores from backups when an operation fails', async () => {
    const tx = await ops.beginTransaction();
    // Use literal Unix-style paths since memfs is platform-agnostic
    const src = '/tmp/fileC.txt';
    const dest = '/tmp/dest/fileC.txt';
    await fs.promises.mkdir('/tmp/dest', { recursive: true });
    await fs.promises.writeFile(src, 'content');

    // Inject an operation that will throw (unknown type) to trigger rollback
    ops.addOperation(tx, { type: 'move', source: src, destination: dest });
    ops.addOperation(tx, { type: 'unknown-op', source: src, destination: dest });

    const result = await ops.commitTransaction(tx);
    // FIX: Transaction that fails and rolls back should return success: false
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();

    // Source should be restored after rollback (exists) and destination absent
    await expect(fs.promises.access(src)).resolves.toBeUndefined();
    await expect(fs.promises.access(dest)).rejects.toBeDefined();
  });

  test('timed-out commit awaits the in-flight op before rollback so no destination is orphaned', async () => {
    const tx = await ops.beginTransaction();
    const src = '/tmp/slow/fileE.txt';
    const dest = '/tmp/slow-dest/fileE.txt';
    await fs.promises.mkdir('/tmp/slow', { recursive: true });
    await fs.promises.mkdir('/tmp/slow-dest', { recursive: true });
    await fs.promises.writeFile(src, 'payload');

    ops.addOperation(tx, { type: 'move', source: src, destination: dest });

    // Force the timeout to win the race while the real move is still pending:
    // delay executeOperation past the (shortened) operationTimeout so the
    // destination push happens AFTER the timeout fires. Pre-fix, rollback would
    // scan createdDestinations before the push and leave the moved file orphaned.
    ops.operationTimeout = 20;
    const realExecute = ops.executeOperation.bind(ops);
    let execSettled = Promise.resolve();
    jest.spyOn(ops, 'executeOperation').mockImplementation((txId, op) => {
      execSettled = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return realExecute(txId, op);
      })();
      return execSettled;
    });

    const result = await ops.commitTransaction(tx);
    expect(result.success).toBe(false);

    // Wait for the move to fully settle. With the fix, commitTransaction already
    // awaited it (and rollback cleaned the destination); pre-fix it returned at
    // the timeout and this await lets the detached move finish so the on-disk
    // orphan (src gone, dest present) becomes observable to the assertions.
    await execSettled.catch(() => {});

    // Rollback must have waited for the move to settle, then cleaned the
    // destination and restored the source — never both paths present.
    await expect(fs.promises.access(src)).resolves.toBeUndefined();
    await expect(fs.promises.access(dest)).rejects.toBeDefined();
  });

  test('cross-device move fallback copies and deletes source', async () => {
    const tx = await ops.beginTransaction();
    const src = '/tmp/fileD.txt';
    await fs.promises.writeFile(src, 'abc');

    const realRename = fs.promises.rename.bind(fs.promises);
    const renameSpy = jest.spyOn(fs.promises, 'rename').mockImplementation((from, to) => {
      if (String(from) === src) {
        const err = new Error('cross device');
        err.code = 'EXDEV';
        return Promise.reject(err);
      }
      return realRename(from, to);
    });

    const dest = '/tmp/other/fileD.txt';
    await ops.executeOperation(tx, { type: 'move', source: src, destination: dest });

    await expect(fs.promises.access(dest)).resolves.toBeUndefined();
    await expect(fs.promises.access(src)).rejects.toBeDefined();
    renameSpy.mockRestore();
  });

  test('EXDEV mid-copy failure leaves no truncated destination', async () => {
    const tx = await ops.beginTransaction();
    const src = '/tmp/fileEnospc.txt';
    await fs.promises.writeFile(src, 'abcdefghij');
    const dest = '/tmp/other/fileEnospc.txt';

    const realRename = fs.promises.rename.bind(fs.promises);
    jest.spyOn(fs.promises, 'rename').mockImplementation((from, to) => {
      if (String(from) === src) {
        const err = new Error('cross device');
        err.code = 'EXDEV';
        return Promise.reject(err);
      }
      return realRename(from, to);
    });
    jest.spyOn(fs.promises, 'copyFile').mockImplementation(async () => {
      const err = new Error('no space');
      err.code = 'ENOSPC';
      throw err;
    });

    await expect(
      ops.executeOperation(tx, { type: 'move', source: src, destination: dest })
    ).rejects.toBeDefined();

    await expect(fs.promises.access(dest)).rejects.toBeDefined();
    await expect(fs.promises.access(src)).resolves.toBeUndefined();
  });

  test('rollback keeps destination when source restore fails', async () => {
    const tx = await ops.beginTransaction();
    const src = '/tmp/keep-src.txt';
    const dest = '/tmp/keep-dest/file.txt';
    await fs.promises.mkdir('/tmp/keep-dest', { recursive: true });
    await fs.promises.writeFile(src, 'original');

    await ops.executeOperation(tx, { type: 'move', source: src, destination: dest });

    const transaction = ops.activeTransactions.get(tx);
    expect(transaction.backups.length).toBeGreaterThan(0);
    await fs.promises.unlink(transaction.backups[0].backup);

    await expect(ops.rollbackTransaction(tx)).rejects.toBeDefined();
    await expect(fs.promises.access(dest)).resolves.toBeUndefined();
  });
});
