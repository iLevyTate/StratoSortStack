/**
 * @jest-environment node
 */
const { IPC_CHANNELS } = require('../src/shared/constants');

// Mock dependencies
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
  syncEmbeddingForMove: jest.fn().mockResolvedValue()
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
  // Delegate to the suite's fs.rename mock; tests drive occupied-destination
  // behavior by seeding renameNoReplace rejections. Real no-replace semantics
  // are covered by atomicFileOperations.test.js.
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

// Mock validation schemas to avoid Zod issues
jest.mock('../src/main/ipc/validationSchemas', () => ({
  z: {},
  schemas: {}
}));

// Destination policy: real module, with the decision points wrapped so one
// test can refuse a destination. Elsewhere the global electron mock's dialog
// approves, as it does for every pre-existing test here.
jest.mock('../src/main/ipc/files/destinationPolicy', () => {
  const actual = jest.requireActual('../src/main/ipc/files/destinationPolicy');
  return {
    ...actual,
    authorizeDestination: jest.fn(actual.authorizeDestination),
    authorizeDestinations: jest.fn(actual.authorizeDestinations)
  };
});

describe('File Operation Handlers', () => {
  let mockIpcMain;
  let mockLogger;
  let mockServiceIntegration;
  let mockMainWindow;
  let mockSearchService;
  let mockClusteringService;
  let mockFilePathCoordinator;
  let safeHandle;
  let safeSend;
  let registerFileOperationHandlers;
  let fs;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    fs = require('fs').promises;
    safeHandle = require('../src/main/ipc/ipcWrappers').safeHandle;
    safeSend = require('../src/main/ipc/ipcWrappers').safeSend;
    mockLogger = require('../src/shared/logger').logger;
    require('../src/main/utils/fileDedup').handleDuplicateMove.mockResolvedValue(null);

    mockIpcMain = { handle: jest.fn() };
    mockMainWindow = {
      isDestroyed: jest.fn(() => false),
      webContents: { send: jest.fn() }
    };

    mockServiceIntegration = {
      undoRedo: { recordAction: jest.fn(), recordBatch: jest.fn() }
    };

    // Mock Search & Clustering services
    mockSearchService = {
      invalidateAndRebuild: jest.fn().mockResolvedValue()
    };
    mockClusteringService = {
      invalidateClusters: jest.fn()
    };
    require('../src/main/ipc/semantic').getSearchServiceInstance.mockReturnValue(mockSearchService);
    require('../src/main/ipc/semantic').getClusteringServiceInstance.mockReturnValue(
      mockClusteringService
    );

    // Mock FilePathCoordinator via ServiceContainer
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

  describe('PERFORM_OPERATION', () => {
    test('handles file move successfully', async () => {
      const handler = getHandler(IPC_CHANNELS.FILES.PERFORM_OPERATION);
      const operation = {
        type: 'move',
        source: '/src/doc.pdf',
        destination: '/dest/doc.pdf'
      };

      const result = await handler({}, operation);

      expect(result.success).toBe(true);
      expect(fs.rename).toHaveBeenCalledWith('/src/doc.pdf', '/dest/doc.pdf');

      // Verify side effects
      expect(mockFilePathCoordinator.atomicPathUpdate).toHaveBeenCalled();
      expect(mockSearchService.invalidateAndRebuild).toHaveBeenCalled();
      expect(mockClusteringService.invalidateClusters).toHaveBeenCalled();
      expect(mockServiceIntegration.undoRedo.recordAction).toHaveBeenCalled();
    });

    test('batch_move moves every file and records ONE MOVE_BATCH undo entry (UR-04)', async () => {
      const handler = getHandler(IPC_CHANNELS.FILES.PERFORM_OPERATION);
      fs.rename.mockImplementation(async (src) => {
        if (src === '/src/bad.pdf') {
          throw Object.assign(new Error('occupied'), { code: 'EEXIST' });
        }
      });

      const result = await handler(
        {},
        {
          type: 'batch_move',
          label: 'Move files',
          operations: [
            { source: '/src/a.pdf', destination: '/dest/a.pdf' },
            { source: '/src/bad.pdf', destination: '/dest/bad.pdf' },
            { source: '/src/c.pdf', destination: '/dest/c.pdf' }
          ]
        }
      );

      expect(result.moved).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.success).toBe(false);
      expect(result.results).toHaveLength(3);
      expect(result.results[1]).toEqual(
        expect.objectContaining({
          success: false,
          errorCode: 'FILE_EXISTS',
          source: '/src/bad.pdf'
        })
      );
      // One undo entry for the selection, never one per file.
      expect(mockServiceIntegration.undoRedo.recordAction).not.toHaveBeenCalled();
      expect(mockServiceIntegration.undoRedo.recordBatch).toHaveBeenCalledTimes(1);
      expect(mockServiceIntegration.undoRedo.recordBatch).toHaveBeenCalledWith(
        'MOVE_BATCH',
        [
          { type: 'move', originalPath: '/src/a.pdf', newPath: '/dest/a.pdf' },
          { type: 'move', originalPath: '/src/c.pdf', newPath: '/dest/c.pdf' }
        ],
        { summary: { label: 'Move files', source: 'manual_batch_move' } }
      );
      // Side effects still run per moved file.
      expect(mockFilePathCoordinator.atomicPathUpdate).toHaveBeenCalledTimes(2);
    });

    test('batch_move with nothing moved records no undo entry', async () => {
      const handler = getHandler(IPC_CHANNELS.FILES.PERFORM_OPERATION);
      fs.rename.mockRejectedValue(Object.assign(new Error('occupied'), { code: 'EEXIST' }));

      const result = await handler(
        {},
        { type: 'batch_move', operations: [{ source: '/src/a.pdf', destination: '/dest/a.pdf' }] }
      );

      expect(result.moved).toBe(0);
      expect(result.failed).toBe(1);
      expect(mockServiceIntegration.undoRedo.recordBatch).not.toHaveBeenCalled();
    });

    test('move fails closed with FILE_EXISTS when a different file occupies the destination [F-079]', async () => {
      // fs.rename silently replaces an occupied destination on every
      // platform, so the handler must route through renameNoReplace and
      // surface its EEXIST as a structured refusal instead of clobbering.
      const handler = getHandler(IPC_CHANNELS.FILES.PERFORM_OPERATION);
      const { renameNoReplace } = require('../src/shared/atomicFileOperations');
      const eexist = new Error(
        "EEXIST: file already exists, rename '/src/doc.pdf' -> '/dest/doc.pdf'"
      );
      eexist.code = 'EEXIST';
      renameNoReplace.mockRejectedValueOnce(eexist);

      const result = await handler(
        {},
        { type: 'move', source: '/src/doc.pdf', destination: '/dest/doc.pdf' }
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('FILE_EXISTS');
      // The occupant must not be replaced or removed.
      expect(fs.rename).not.toHaveBeenCalled();
      expect(fs.unlink).not.toHaveBeenCalled();
      // A refused move records no undo entry and runs no move side effects.
      expect(mockServiceIntegration.undoRedo.recordAction).not.toHaveBeenCalled();
      expect(mockFilePathCoordinator.atomicPathUpdate).not.toHaveBeenCalled();
    });

    test('handles file copy successfully', async () => {
      const handler = getHandler(IPC_CHANNELS.FILES.PERFORM_OPERATION);
      const operation = {
        type: 'copy',
        source: '/src/doc.pdf',
        destination: '/dest/doc.pdf'
      };

      const result = await handler({}, operation);

      expect(result.success).toBe(true);
      expect(fs.mkdir).toHaveBeenCalledWith('/dest', { recursive: true });
      // COPYFILE_EXCL is load-bearing: without it copyFile silently
      // overwrites an occupied destination.
      expect(fs.copyFile).toHaveBeenCalledWith('/src/doc.pdf', '/dest/doc.pdf', 1);
      expect(mockFilePathCoordinator.handleFileCopy).toHaveBeenCalled();
    });

    test('copy fails closed with FILE_EXISTS when destination is occupied', async () => {
      // fs.copyFile without COPYFILE_EXCL silently replaces the occupant.
      // The handler must pass the flag and surface EEXIST as a structured
      // FILE_EXISTS refusal instead of clobbering.
      const handler = getHandler(IPC_CHANNELS.FILES.PERFORM_OPERATION);
      const eexist = Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
      fs.copyFile.mockRejectedValueOnce(eexist);

      const result = await handler(
        {},
        { type: 'copy', source: '/src/doc.pdf', destination: '/dest/doc.pdf' }
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('FILE_EXISTS');
      // A refused copy must not run copy side effects.
      expect(mockFilePathCoordinator.handleFileCopy).not.toHaveBeenCalled();
    });

    test('delegates batch_organize to handler', async () => {
      const handler = getHandler(IPC_CHANNELS.FILES.PERFORM_OPERATION);
      const operation = {
        type: 'batch_organize',
        operations: []
      };

      const { handleBatchOrganize } = require('../src/main/ipc/files/batchOrganizeHandler');
      await handler({}, operation);

      expect(handleBatchOrganize).toHaveBeenCalled();
    });

    test('a destination the policy refuses is not moved and carries the policy error', async () => {
      const handler = getHandler(IPC_CHANNELS.FILES.PERFORM_OPERATION);
      const policy = require('../src/main/ipc/files/destinationPolicy');
      policy.authorizeDestination.mockResolvedValueOnce({
        allowed: false,
        reason: 'autostart',
        errorCode: 'DESTINATION_AUTOSTART',
        error: 'Destination is a startup folder'
      });

      const result = await handler(
        {},
        { type: 'move', source: '/src/doc.pdf', destination: '/startup/doc.pdf' }
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('DESTINATION_AUTOSTART');
      expect(result.error).toMatch(/startup folder/);
      expect(fs.rename).not.toHaveBeenCalled();
      expect(policy.authorizeDestination).toHaveBeenCalledWith(
        '/startup/doc.pdf',
        expect.objectContaining({ sourcePath: '/src/doc.pdf' })
      );
    });

    test('validates paths before operation', async () => {
      const handler = getHandler(IPC_CHANNELS.FILES.PERFORM_OPERATION);
      const { validateFileOperationPath } = require('../src/shared/pathSanitization');

      validateFileOperationPath.mockReturnValueOnce({ valid: false, error: 'Bad path' });

      const result = await handler({}, { type: 'move', source: 'bad', destination: 'good' });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('INVALID_PATH');
      expect(fs.rename).not.toHaveBeenCalled();
    });

    test('handles duplicate move through delete side-effect pipeline', async () => {
      require('../src/main/utils/fileDedup').handleDuplicateMove.mockResolvedValue({
        skipped: true,
        destination: '/dest/doc.pdf',
        reason: 'duplicate'
      });
      const handler = getHandler(IPC_CHANNELS.FILES.PERFORM_OPERATION);
      const operation = {
        type: 'move',
        source: '/src/doc.pdf',
        destination: '/dest/doc.pdf'
      };

      const result = await handler({}, operation);

      expect(result.success).toBe(true);
      expect(result.skipped).toBe(true);
      expect(fs.rename).not.toHaveBeenCalled();
      expect(mockFilePathCoordinator.handleFileDeletion).toHaveBeenCalledWith('/src/doc.pdf');
      expect(mockSearchService.invalidateAndRebuild).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'file-dedup-delete',
          oldPath: '/src/doc.pdf'
        })
      );
      expect(safeSend).toHaveBeenCalledWith(
        mockMainWindow.webContents,
        expect.any(String),
        expect.objectContaining({
          operation: 'delete',
          oldPath: '/src/doc.pdf'
        })
      );
    });
  });

  describe('COPY_FILE', () => {
    test('passes COPYFILE_EXCL and maps EEXIST to FILE_EXISTS', async () => {
      const handler = getHandler(IPC_CHANNELS.FILES.COPY_FILE);
      const eexist = Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
      fs.copyFile.mockRejectedValueOnce(eexist);

      const result = await handler({}, '/src/doc.pdf', '/dest/doc.pdf');

      expect(fs.copyFile).toHaveBeenCalledWith('/src/doc.pdf', '/dest/doc.pdf', 1);
      expect(result.success).toBe(false);
      // Previously dead code: without COPYFILE_EXCL, copyFile never threw
      // EEXIST so this mapping was unreachable and occupants were replaced.
      expect(result.errorCode).toBe('FILE_EXISTS');
    });

    test('copies successfully when destination is free', async () => {
      const handler = getHandler(IPC_CHANNELS.FILES.COPY_FILE);

      const result = await handler({}, '/src/doc.pdf', '/dest/doc.pdf');

      expect(result.success).toBe(true);
      expect(fs.copyFile).toHaveBeenCalledWith('/src/doc.pdf', '/dest/doc.pdf', 1);
    });
  });

  describe('DELETE_FILE', () => {
    test('moves file to OS trash (no hard unlink) and cleans up', async () => {
      const handler = getHandler(IPC_CHANNELS.FILES.DELETE_FILE);
      const filePath = '/path/to/delete.pdf';
      const { shell } = require('electron');

      const result = await handler({}, filePath);

      expect(result.success).toBe(true);
      expect(result.trashed).toBe(true);
      // Trash-first: the recoverable path must be used, never a hard unlink.
      expect(shell.trashItem).toHaveBeenCalledWith(filePath);
      expect(fs.unlink).not.toHaveBeenCalled();
      // Backward-compatible response shape.
      expect(result.deletedFile).toEqual(
        expect.objectContaining({ path: filePath, size: expect.any(Number) })
      );
      expect(mockFilePathCoordinator.handleFileDeletion).toHaveBeenCalledWith(filePath);
      expect(mockSearchService.invalidateAndRebuild).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'file-delete',
          oldPath: filePath
        })
      );
      expect(safeSend).toHaveBeenCalledWith(
        mockMainWindow.webContents,
        expect.any(String),
        expect.objectContaining({
          operation: 'delete',
          oldPath: filePath
        })
      );
    });

    test('never unlinks on its own when trash fails: returns TRASH_UNAVAILABLE', async () => {
      const handler = getHandler(IPC_CHANNELS.FILES.DELETE_FILE);
      const filePath = '/path/to/delete.pdf';
      const { shell } = require('electron');
      shell.trashItem.mockRejectedValueOnce(new Error('gio: not supported'));

      const result = await handler({}, filePath);

      // The dialog the user confirmed promised the Trash; a permanent delete
      // needs its own confirmation, so the file must still be on disk.
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('TRASH_UNAVAILABLE');
      expect(result.trashError).toEqual(expect.stringContaining('gio'));
      expect(fs.unlink).not.toHaveBeenCalled();
    });

    test('unlinks only when trash fails AND the caller confirmed permanent', async () => {
      const handler = getHandler(IPC_CHANNELS.FILES.DELETE_FILE);
      const filePath = '/path/to/delete.pdf';
      const { shell } = require('electron');
      shell.trashItem.mockRejectedValueOnce(new Error('gio: not supported'));

      const result = await handler({}, filePath, { permanent: true });

      expect(result.success).toBe(true);
      expect(result.trashed).toBe(false);
      expect(fs.unlink).toHaveBeenCalledWith(filePath);
      expect(result.warning).toEqual(expect.stringContaining('permanently deleted'));
    });

    test('still prefers the trash when permanent is confirmed but trash works', async () => {
      const handler = getHandler(IPC_CHANNELS.FILES.DELETE_FILE);
      const filePath = '/path/to/delete.pdf';
      const { shell } = require('electron');

      const result = await handler({}, filePath, { permanent: true });

      expect(result.success).toBe(true);
      expect(result.trashed).toBe(true);
      expect(shell.trashItem).toHaveBeenCalledWith(filePath);
      expect(fs.unlink).not.toHaveBeenCalled();
    });

    test('handles ENOENT gracefully', async () => {
      const handler = getHandler(IPC_CHANNELS.FILES.DELETE_FILE);
      fs.stat.mockRejectedValueOnce({ code: 'ENOENT', message: 'Not found' });

      const result = await handler({}, '/missing.pdf');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('FILE_NOT_FOUND');
      expect(fs.unlink).not.toHaveBeenCalled();
    });
  });
});
