/**
 * @jest-environment node
 */
/**
 * Startup replay must hold the same exclusions the live batch handler
 * holds: the global batch lock (so a user organize started during replay
 * cannot race it on the same destination) and the ghost-cleanup latch (so
 * the search ghost sweep cannot delete embeddings for sources already
 * renamed but not yet remapped by post-batch persistence).
 */

const mockFs = {
  access: jest.fn(),
  stat: jest.fn(),
  mkdir: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
  rename: jest.fn().mockResolvedValue(undefined)
};
jest.mock('fs', () => ({ promises: mockFs, constants: {} }));

jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  };
  return { createLogger: jest.fn(() => logger), logger };
});

jest.mock('../src/shared/atomicFileOperations', () => ({
  atomicFileOps: { atomicMove: jest.fn(async (_source, destination) => destination) }
}));

jest.mock('../src/main/ipc/ipcWrappers', () => ({ safeSend: jest.fn() }));

jest.mock('../src/main/utils/fileDedup', () => ({
  computeFileChecksum: jest.fn(),
  handleDuplicateMove: jest.fn().mockResolvedValue(null)
}));

jest.mock('../src/main/ipc/files/embeddingSync', () => ({
  removeEmbeddingsForPathBestEffort: jest.fn()
}));

jest.mock('../src/shared/pathSanitization', () => ({
  validateFileOperationPath: jest.fn(async (p) => ({ valid: true, normalizedPath: p })),
  normalizePathForIndex: jest.fn((p) => p)
}));

jest.mock('../src/shared/ghostCleanupGuard', () => ({
  deferGhostCleanup: jest.fn(),
  resumeGhostCleanup: jest.fn(),
  isGhostCleanupDeferred: jest.fn(() => false)
}));

jest.mock('../src/main/ipc/files/batchOrganizeHandler', () => ({
  recordUndoAndUpdateDatabase: jest
    .fn()
    .mockResolvedValue({ undoRecorded: true, pathIndexUpdated: true })
}));

const { resumeIncompleteBatches } = require('../src/main/services/OrganizeResumeService');
const { acquireBatchLock, releaseBatchLock } = require('../src/main/ipc/files/batchLockManager');
const { deferGhostCleanup, resumeGhostCleanup } = require('../src/shared/ghostCleanupGuard');
const { atomicFileOps } = require('../src/shared/atomicFileOperations');

// acquireBatchLock gives up after BATCH_LOCK_ACQUIRE_MAX_WAIT (5 min) of
// retries; anything past that settles the resume run under fake timers.
const LOCK_GIVE_UP_MS = 6 * 60 * 1000;

const SOURCE = '/downloads/report.pdf';
const DESTINATION = '/organized/report.pdf';

function makeBatch(overrides = {}) {
  return {
    id: 'batch_1700000000000_0000abcd',
    operations: [{ source: SOURCE, destination: DESTINATION, status: 'pending' }],
    ...overrides
  };
}

function makeServiceIntegration(batches) {
  return {
    processingState: {
      getIncompleteOrganizeBatches: jest.fn().mockReturnValue(batches),
      markOrganizeOpStarted: jest.fn().mockResolvedValue(undefined),
      markOrganizeOpDone: jest.fn().mockResolvedValue(undefined),
      markOrganizeOpError: jest.fn().mockResolvedValue(undefined),
      markOrganizeOpsPersisted: jest.fn().mockResolvedValue(undefined),
      completeOrganizeBatch: jest.fn().mockResolvedValue(undefined)
    }
  };
}

describe('OrganizeResumeService batch lock + ghost-cleanup latch', () => {
  let logger;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(0);
    logger = { warn: jest.fn(), info: jest.fn() };
    mockFs.access.mockImplementation(async (p) => {
      if (p === DESTINATION) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('defers the batch while another batch holds the lock, then replays once it is free', async () => {
    await acquireBatchLock('live-user-batch');
    const batch = makeBatch();
    const svc = makeServiceIntegration([batch]);

    const blockedRun = resumeIncompleteBatches(svc, logger, () => null);
    await jest.advanceTimersByTimeAsync(LOCK_GIVE_UP_MS);
    await blockedRun;

    expect(atomicFileOps.atomicMove).not.toHaveBeenCalled();
    expect(svc.processingState.markOrganizeOpStarted).not.toHaveBeenCalled();
    expect(svc.processingState.completeOrganizeBatch).not.toHaveBeenCalled();
    expect(deferGhostCleanup).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not acquire batch lock'),
      { batchId: batch.id }
    );

    releaseBatchLock('live-user-batch');

    const freeRun = resumeIncompleteBatches(svc, logger, () => null);
    await jest.advanceTimersByTimeAsync(1000);
    await freeRun;

    expect(atomicFileOps.atomicMove).toHaveBeenCalledWith(SOURCE, DESTINATION);
    expect(svc.processingState.completeOrganizeBatch).toHaveBeenCalledWith(batch.id);
  });

  test('holds the ghost-cleanup latch around the replay and releases the lock afterwards', async () => {
    const batch = makeBatch();
    const svc = makeServiceIntegration([batch]);

    const run = resumeIncompleteBatches(svc, logger, () => null);
    await jest.advanceTimersByTimeAsync(1000);
    await run;

    expect(deferGhostCleanup).toHaveBeenCalledTimes(1);
    expect(resumeGhostCleanup).toHaveBeenCalledTimes(1);
    const [deferOrder] = deferGhostCleanup.mock.invocationCallOrder;
    const [moveOrder] = atomicFileOps.atomicMove.mock.invocationCallOrder;
    const [resumeOrder] = resumeGhostCleanup.mock.invocationCallOrder;
    expect(deferOrder).toBeLessThan(moveOrder);
    expect(moveOrder).toBeLessThan(resumeOrder);

    // Lock was released: a fresh acquirer gets it without waiting.
    await expect(acquireBatchLock('probe', 1000)).resolves.toBe(true);
    releaseBatchLock('probe');
  });

  test('releases the lock and the latch even when the replay throws', async () => {
    const svc = makeServiceIntegration([makeBatch({ operations: undefined })]);

    const run = resumeIncompleteBatches(svc, logger, () => null);
    await jest.advanceTimersByTimeAsync(1000);
    await run;

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Resume batches failed'),
      expect.any(String)
    );
    expect(deferGhostCleanup).toHaveBeenCalledTimes(1);
    expect(resumeGhostCleanup).toHaveBeenCalledTimes(1);
    await expect(acquireBatchLock('probe', 1000)).resolves.toBe(true);
    releaseBatchLock('probe');
  });
});
