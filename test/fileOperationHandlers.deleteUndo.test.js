/**
 * @jest-environment node
 *
 * Regression guard for the perform-operation delete path (Position 04
 * audit gap B). Before the fix, `case 'delete'` in
 * `createPerformOperationHandler` ran `fs.unlink` directly and returned
 * `{ success: true }` — no undo entry was ever recorded. `ACTION_TYPES`
 * has a `FILE_DELETE` type and `UndoRedoService` has a full reverse path
 * that restores from a backup (`UndoRedoService.js:807`), but the IPC
 * handler never snapshotted the file or called `recordAction`, so the
 * delete was unrecoverable.
 *
 * The fix uses the existing `UndoRedoService.createBackup(source)`
 * primitive (which copies to `userData/undo-backups/<ts>_<rand>_<name>`
 * and size-verifies) BEFORE the unlink, then records a `FILE_DELETE`
 * action with `{ originalPath, backupPath, createBackup: true }` and a
 * `{ durable: true }` option that force-flushes the actions file — ALSO
 * BEFORE the unlink. Ordering matters twice over:
 *
 * 1. backup before unlink — else there is nothing to restore from;
 * 2. recordAction (durably flushed) before unlink — recordAction alone
 *    persists via a 250ms debounced save, so a crash between the unlink
 *    and the flush would leave a backup referenced by nothing, and the
 *    next launch's orphan sweep (`cleanupOldBackups`) would destroy the
 *    only surviving copy of the user's file.
 *
 * If the unlink then fails, the pre-recorded action is retracted via
 * `removeAction(actionId)` so the undo stack never offers to "restore"
 * a file that was never deleted.
 */

const { IPC_CHANNELS, ACTION_TYPES } = require('../src/shared/constants');

jest.mock('fs', () => ({
  promises: {
    stat: jest.fn().mockResolvedValue({ size: 100 }),
    access: jest.fn().mockResolvedValue(),
    rename: jest.fn().mockResolvedValue(),
    copyFile: jest.fn().mockResolvedValue(),
    unlink: jest.fn().mockResolvedValue(),
    mkdir: jest.fn().mockResolvedValue()
  },
  constants: { COPYFILE_EXCL: 1 }
}));

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

jest.mock('../src/main/ipc/ipcWrappers', () => ({
  createHandler: jest.fn(({ handler }) => handler),
  safeHandle: jest.fn(),
  withErrorLogging: jest.fn((logger, handler) => handler),
  withValidation: jest.fn((logger, schema, handler) => handler),
  safeSend: jest.fn()
}));

jest.mock('../src/main/ipc/files/batchOrganizeHandler', () => ({
  handleBatchOrganize: jest.fn().mockResolvedValue({ success: true, count: 1 })
}));

jest.mock('../src/shared/pathSanitization', () => ({
  validateFileOperationPath: jest.fn((p) => ({ valid: true, normalizedPath: p }))
}));

jest.mock('../src/shared/pathTraceLogger', () => ({
  traceMoveStart: jest.fn(),
  traceMoveComplete: jest.fn(),
  traceCopyStart: jest.fn(),
  traceCopyComplete: jest.fn(),
  traceDeleteStart: jest.fn(),
  traceDeleteComplete: jest.fn(),
  traceDbUpdate: jest.fn(),
  PathChangeReason: { USER_MOVE: 'user_move' }
}));

jest.mock('../src/main/services/organization/learningFeedback', () => ({
  getInstance: jest.fn(),
  FEEDBACK_SOURCES: { MANUAL_MOVE: 'manual_move' }
}));

jest.mock('../src/main/ipc/files/embeddingSync', () => ({
  syncEmbeddingForMove: jest.fn().mockResolvedValue(),
  removeEmbeddingsForPathBestEffort: jest.fn().mockResolvedValue(),
  verifyEmbeddingAfterMove: jest.fn().mockResolvedValue()
}));

jest.mock('../src/shared/promiseUtils', () => ({
  withTimeout: jest.fn((p) => p),
  createBackgroundWorkTracker: jest.fn(() => ({
    track: jest.fn((p) => p),
    drain: jest.fn(),
    get size() {
      return 0;
    }
  })),
  createInitGuard: jest.fn(() => ({
    isInitialized: () => false,
    initialize: jest.fn(async (fn) => fn()),
    reset: jest.fn(),
    requireInitialized: jest.fn()
  }))
}));

jest.mock('../src/shared/atomicFileOperations', () => ({
  crossDeviceMove: jest.fn(),
  renameNoReplace: jest.fn((src, dest) => require('fs').promises.rename(src, dest))
}));

jest.mock('../src/main/utils/fileDedup', () => ({
  handleDuplicateMove: jest.fn().mockResolvedValue(null)
}));

jest.mock('../src/main/ipc/semantic', () => ({
  getSearchServiceInstance: jest.fn(),
  getClusteringServiceInstance: jest.fn()
}));

jest.mock('../src/main/services/ServiceContainer', () => ({
  container: {
    has: jest.fn(),
    resolve: jest.fn()
  },
  ServiceIds: {
    FILE_PATH_COORDINATOR: 'filePathCoordinator',
    ANALYSIS_HISTORY: 'analysisHistory'
  }
}));

jest.mock('../src/main/ipc/validationSchemas', () => ({
  z: {},
  schemas: {}
}));

describe('perform-delete undo wiring [Position 04 Gap B]', () => {
  let mockIpcMain;
  let mockLogger;
  let mockServiceIntegration;
  let mockMainWindow;
  let mockSearchService;
  let mockClusteringService;
  let mockFilePathCoordinator;
  let safeHandle;
  let registerFileOperationHandlers;
  let fs;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    fs = require('fs').promises;
    safeHandle = require('../src/main/ipc/ipcWrappers').safeHandle;
    mockLogger = require('../src/shared/logger').logger;

    mockIpcMain = { handle: jest.fn() };
    mockMainWindow = {
      isDestroyed: jest.fn(() => false),
      webContents: { send: jest.fn() }
    };

    mockServiceIntegration = {
      undoRedo: {
        createBackup: jest
          .fn()
          .mockImplementation(
            async (source) =>
              `/userData/undo-backups/1700000000000_deadbeef_${source.split('/').pop()}`
          ),
        recordAction: jest.fn().mockResolvedValue('action-id-1'),
        removeAction: jest.fn().mockResolvedValue(true)
      }
    };

    mockSearchService = { invalidateAndRebuild: jest.fn().mockResolvedValue() };
    mockClusteringService = { invalidateClusters: jest.fn() };
    require('../src/main/ipc/semantic').getSearchServiceInstance.mockReturnValue(mockSearchService);
    require('../src/main/ipc/semantic').getClusteringServiceInstance.mockReturnValue(
      mockClusteringService
    );

    mockFilePathCoordinator = {
      atomicPathUpdate: jest.fn().mockResolvedValue({ success: true }),
      handleFileCopy: jest.fn().mockResolvedValue({ success: true }),
      handleFileDeletion: jest.fn().mockResolvedValue({ success: true })
    };
    const { container } = require('../src/main/services/ServiceContainer');
    container.has.mockReturnValue(true);
    container.resolve.mockReturnValue(mockFilePathCoordinator);

    const { IpcServiceContext } = require('../src/main/ipc/IpcServiceContext');
    const context = new IpcServiceContext();
    context.setCore({ ipcMain: mockIpcMain, IPC_CHANNELS, logger: mockLogger });
    context.setElectron({ getMainWindow: () => mockMainWindow });
    context.setServiceIntegration(() => mockServiceIntegration);

    registerFileOperationHandlers =
      require('../src/main/ipc/files/fileOperationHandlers').registerFileOperationHandlers;
    registerFileOperationHandlers(context);
  });

  function getHandler(channel) {
    const call = safeHandle.mock.calls.find((c) => c[1] === channel);
    if (!call) throw new Error(`Handler for ${channel} not registered`);
    return call[2];
  }

  test('snapshots the file and durably records FILE_DELETE action BEFORE unlink', async () => {
    const handler = getHandler(IPC_CHANNELS.FILES.PERFORM_OPERATION);
    const source = '/home/user/doc.pdf';

    const result = await handler({}, { type: 'delete', source });

    expect(result.success).toBe(true);

    // A backup must exist on disk before the delete lands, else undo has
    // nothing to restore from.
    expect(mockServiceIntegration.undoRedo.createBackup).toHaveBeenCalledWith(source);
    expect(mockServiceIntegration.undoRedo.createBackup).toHaveBeenCalledTimes(1);

    expect(fs.unlink).toHaveBeenCalledWith(source);

    // The recorded action carries the backup path so the FILE_DELETE
    // reverse handler can restore — and it must be recorded with
    // durable: true so the actions file is flushed past the debounced
    // save before the unlink happens.
    expect(mockServiceIntegration.undoRedo.recordAction).toHaveBeenCalledWith(
      ACTION_TYPES.FILE_DELETE,
      expect.objectContaining({
        originalPath: source,
        backupPath: expect.stringContaining('undo-backups'),
        createBackup: true
      }),
      expect.objectContaining({ durable: true })
    );

    // CRASH-WINDOW ORDERING: backup AND durable record must both land
    // before the unlink. If the record happened after the unlink, a crash
    // in between would leave the backup unreferenced — and the next
    // launch's orphan sweep would destroy the only copy of the file.
    const createBackupOrder =
      mockServiceIntegration.undoRedo.createBackup.mock.invocationCallOrder[0];
    const recordActionOrder =
      mockServiceIntegration.undoRedo.recordAction.mock.invocationCallOrder[0];
    const unlinkOrder = fs.unlink.mock.invocationCallOrder[0];
    expect(createBackupOrder).toBeLessThan(unlinkOrder);
    expect(recordActionOrder).toBeLessThan(unlinkOrder);

    // The action was not retracted — the unlink succeeded.
    expect(mockServiceIntegration.undoRedo.removeAction).not.toHaveBeenCalled();
  });

  test('retracts the pre-recorded action when the unlink fails', async () => {
    const handler = getHandler(IPC_CHANNELS.FILES.PERFORM_OPERATION);
    const source = '/home/user/locked.pdf';
    fs.unlink.mockRejectedValueOnce(Object.assign(new Error('EPERM: locked'), { code: 'EPERM' }));

    const result = await handler({}, { type: 'delete', source });

    // The delete failed and must be reported as such.
    expect(result.success).toBe(false);

    // The durably pre-recorded action describes a delete that never
    // happened; leaving it would offer an undo that "restores" a file
    // that still exists. It must be removed by id.
    expect(mockServiceIntegration.undoRedo.recordAction).toHaveBeenCalled();
    expect(mockServiceIntegration.undoRedo.removeAction).toHaveBeenCalledWith('action-id-1');
  });

  test('delete still succeeds when backup fails; recordAction is skipped', async () => {
    // If we cannot create a backup (disk full, permission), the user's
    // delete request must still proceed — refusing would surprise them.
    // We just log the missing-undo case; recordAction never runs.
    const handler = getHandler(IPC_CHANNELS.FILES.PERFORM_OPERATION);
    mockServiceIntegration.undoRedo.createBackup.mockRejectedValueOnce(
      Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    );

    const result = await handler({}, { type: 'delete', source: '/home/user/large.iso' });

    expect(result.success).toBe(true);
    expect(fs.unlink).toHaveBeenCalledWith('/home/user/large.iso');
    expect(mockServiceIntegration.undoRedo.recordAction).not.toHaveBeenCalled();
  });
});
