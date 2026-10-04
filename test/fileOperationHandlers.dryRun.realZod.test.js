/**
 * @jest-environment node
 *
 * Regression guard for the Preview-button bug: the renderer sends
 * `{ type: 'batch_organize', dryRun: true, operations }` to
 * `IPC_CHANNELS.FILES.PERFORM_OPERATION`. Before the schema fix, Zod's
 * default object mode stripped `dryRun` (and `strict`) silently, so the
 * handler entered the real batch path and moved files on disk while the
 * renderer expected a preview. The dedicated handler unit test
 * (batchOrganizeHandler.dryRun.test.js) calls the handler directly and
 * therefore could not catch this — the bug lived in the createHandler +
 * Zod path that the existing test bypassed.
 *
 * This file wires `registerFileOperationHandlers` against real Zod
 * schemas and a captured ipcMain stub, then invokes the registered
 * handler exactly the way `safeHandle` would. We rely on
 * `acquireBatchLock` to assert that dryRun NEVER reaches the real batch
 * (lock acquisition is the first observable side effect of the non-dry
 * path) and that the same call without dryRun DOES enter the batch path.
 */

const path = require('path');

// In-memory simulated filesystem used by the dry-run preview's pathExistsSilent.
const mockExistingPaths = new Set();

jest.mock('fs', () => ({
  promises: {
    access: jest.fn(async (p) => {
      if (mockExistingPaths.has(p)) return undefined;
      const err = new Error(`ENOENT: ${p}`);
      err.code = 'ENOENT';
      throw err;
    }),
    rename: jest.fn(),
    mkdir: jest.fn(),
    unlink: jest.fn(),
    stat: jest.fn(async () => ({ size: 1, mtimeMs: Date.now() }))
  }
}));

jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  };
  return {
    createLogger: jest.fn(() => logger),
    logger
  };
});

// Lock manager is a singleton imported by both the handler and tests, so
// asserting on its mock is the cleanest "did we enter the batch path?" probe.
jest.mock('../src/main/ipc/files/batchLockManager', () => ({
  acquireBatchLock: jest.fn().mockResolvedValue(true),
  renewBatchLock: jest.fn().mockReturnValue(true),
  releaseBatchLock: jest.fn()
}));

jest.mock('../src/main/ipc/files/batchValidator', () => ({
  validateBatchOperation: jest.fn(() => null),
  MAX_BATCH_SIZE: 1000
}));

jest.mock('../src/main/ipc/files/batchRollback', () => ({
  executeRollback: jest.fn()
}));

jest.mock('../src/main/ipc/files/batchProgressReporter', () => ({
  sendFileOperationBatchComplete: jest.fn(),
  sendOperationProgress: jest.fn(),
  sendChunkedResults: jest.fn().mockResolvedValue({ sent: true, totalChunks: 0 })
}));

jest.mock('../src/shared/fileOperationTracker', () => ({
  getInstance: jest.fn(() => ({ recordOperation: jest.fn() }))
}));

// Path validation runs on real fs in production. For this regression test we
// only care about the schema-through-handler routing, so allow everything.
jest.mock('../src/shared/pathSanitization', () => ({
  validateFileOperationPath: jest.fn(async (p) => ({ valid: true, normalizedPath: p }))
}));

const { acquireBatchLock } = require('../src/main/ipc/files/batchLockManager');
const { registerFileOperationHandlers } = require('../src/main/ipc/files/fileOperationHandlers');
const { IPC_CHANNELS } = require('../src/shared/constants');

function setupRegistration() {
  const handlers = {};
  const ipcMain = {
    handle: jest.fn((channel, handler) => {
      handlers[channel] = handler;
    })
  };
  registerFileOperationHandlers({
    ipcMain,
    IPC_CHANNELS,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    getMainWindow: () => null,
    getServiceIntegration: () => null
  });
  return handlers;
}

describe('files:perform-operation with real Zod (dryRun regression guard)', () => {
  let handlers;

  beforeEach(() => {
    mockExistingPaths.clear();
    jest.clearAllMocks();
    handlers = setupRegistration();
  });

  test('dryRun=true reaches the dry-run branch and never acquires the batch lock', async () => {
    mockExistingPaths.add('/in/a.pdf');
    mockExistingPaths.add('/out');

    const performOp = handlers[IPC_CHANNELS.FILES.PERFORM_OPERATION];
    expect(typeof performOp).toBe('function');

    const result = await performOp(
      { sender: { id: 1 } },
      {
        type: 'batch_organize',
        dryRun: true,
        operations: [{ source: '/in/a.pdf', destination: '/out/a.pdf' }]
      }
    );

    // The dry-run handler returns the plan envelope directly.
    expect(result).toMatchObject({
      success: true,
      dryRun: true,
      total: 1
    });
    expect(Array.isArray(result.wouldMove)).toBe(true);
    // Critical safety property: the batch lock is NEVER acquired in dry-run.
    expect(acquireBatchLock).not.toHaveBeenCalled();
  });

  test('omitting dryRun enters the real batch path (acquires the lock)', async () => {
    mockExistingPaths.add('/in/a.pdf');
    mockExistingPaths.add('/out');

    const performOp = handlers[IPC_CHANNELS.FILES.PERFORM_OPERATION];

    await performOp(
      { sender: { id: 1 } },
      {
        type: 'batch_organize',
        operations: [{ source: '/in/a.pdf', destination: '/out/a.pdf' }]
      }
    ).catch(() => {
      /* downstream may bail without service integration; only the lock matters here */
    });

    expect(acquireBatchLock).toHaveBeenCalled();
  });

  test('strict=true survives validation and is observable on the operation', async () => {
    // Inject a probe directly into the validateBatchOperation mock to capture
    // the operation shape after Zod validation. validateBatchOperation runs
    // BEFORE acquireBatchLock so we can return early without firing the lock.
    const { validateBatchOperation } = require('../src/main/ipc/files/batchValidator');
    let observedOperation = null;
    validateBatchOperation.mockImplementationOnce((op) => {
      observedOperation = op;
      // Return a short-circuit error so the handler does not proceed further.
      return { success: false, error: 'short-circuit-for-test' };
    });

    const performOp = handlers[IPC_CHANNELS.FILES.PERFORM_OPERATION];
    await performOp(
      { sender: { id: 1 } },
      {
        type: 'batch_organize',
        strict: true,
        operations: [{ source: '/in/a.pdf', destination: '/out/a.pdf' }]
      }
    );

    expect(observedOperation).not.toBeNull();
    expect(observedOperation.strict).toBe(true);
  });

  test('rejects payload with invalid dryRun type (not a boolean)', async () => {
    const performOp = handlers[IPC_CHANNELS.FILES.PERFORM_OPERATION];
    const result = await performOp(
      { sender: { id: 1 } },
      {
        type: 'batch_organize',
        dryRun: 'yes',
        operations: [{ source: '/in/a.pdf', destination: '/out/a.pdf' }]
      }
    );

    // createHandler returns an error envelope for validation failures.
    expect(result?.success).toBe(false);
    expect(acquireBatchLock).not.toHaveBeenCalled();
  });
});
