/**
 * Tests for Undo/Redo IPC Handlers
 * Tests undo, redo, and action history operations
 */

// Mock logger
jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

// Mock errorHandlingUtils
jest.mock('../src/shared/errorHandlingUtils', () => ({
  createSuccessResponse: jest.fn((data) => ({ success: true, data })),
  ERROR_CODES: {
    UNKNOWN_ERROR: 'UNKNOWN_ERROR',
    SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE'
  }
}));

// Mock ipcRegistry - must forward to ipcMain.handle
jest.mock('../src/main/core/ipcRegistry', () => ({
  registerHandler: jest.fn((ipcMain, channel, handler) => {
    // Forward to the mocked ipcMain.handle
    ipcMain.handle(channel, handler);
  })
}));

// Mock ipcWrappers
jest.mock('../src/main/ipc/ipcWrappers', () => ({
  createHandler: jest.fn(({ handler, getService, fallbackResponse }) => {
    return async (event, ...args) => {
      const service = getService ? getService() : null;
      if (!service) {
        return fallbackResponse;
      }
      // For handlers that take (event, arg, service) vs (event, service)
      if (args.length > 0 && args[0] !== undefined) {
        return await handler(event, args[0], service);
      }
      return await handler(event, service);
    };
  }),
  safeHandle: (ipcMain, channel, handler) => {
    ipcMain.handle(channel, handler);
  },
  safeSend: jest.fn()
}));

// Mock the DegradedStateTracker singleton so we can observe raise/clear calls.
const mockDegradedTracker = { raise: jest.fn(), clear: jest.fn() };
jest.mock('../src/main/services/DegradedStateTracker', () => ({
  getInstance: () => mockDegradedTracker
}));

describe('Undo/Redo IPC Handlers', () => {
  let registerUndoRedoIpc;
  let mockIpcMain;
  let mockLogger;
  let handlers;
  let mockUndoRedoService;
  let safeSend;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    mockIpcMain = {
      handle: jest.fn()
    };

    mockLogger = {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    mockUndoRedoService = {
      undo: jest.fn(),
      redo: jest.fn(),
      getActionHistory: jest.fn(),
      getFullState: jest.fn(),
      clearHistory: jest.fn(),
      canUndo: jest.fn(),
      canRedo: jest.fn()
    };

    handlers = {};

    // Capture registered handlers
    mockIpcMain.handle.mockImplementation((channel, handler) => {
      handlers[channel] = handler;
    });

    registerUndoRedoIpc = require('../src/main/ipc/undoRedo');
    ({ safeSend } = require('../src/main/ipc/ipcWrappers'));
  });

  const setupHandlers = (serviceAvailable = true) => {
    registerUndoRedoIpc({
      ipcMain: mockIpcMain,
      IPC_CHANNELS: {
        UNDO_REDO: {
          UNDO: 'undo-redo:undo',
          REDO: 'undo-redo:redo',
          STATE_CHANGED: 'undo-redo:state-changed',
          GET_HISTORY: 'undo-redo:get-history',
          GET_STATE: 'undo-redo:get-state',
          CLEAR_HISTORY: 'undo-redo:clear-history',
          CAN_UNDO: 'undo-redo:can-undo',
          CAN_REDO: 'undo-redo:can-redo'
        }
      },
      logger: mockLogger,
      getServiceIntegration: () => (serviceAvailable ? { undoRedo: mockUndoRedoService } : null)
    });
  };

  describe('registerUndoRedoIpc', () => {
    test('registers all handlers', () => {
      setupHandlers();

      expect(mockIpcMain.handle).toHaveBeenCalledTimes(7);
      expect(handlers['undo-redo:undo']).toBeDefined();
      expect(handlers['undo-redo:redo']).toBeDefined();
      expect(handlers['undo-redo:get-history']).toBeDefined();
      expect(handlers['undo-redo:get-state']).toBeDefined();
      expect(handlers['undo-redo:clear-history']).toBeDefined();
      expect(handlers['undo-redo:can-undo']).toBeDefined();
      expect(handlers['undo-redo:can-redo']).toBeDefined();
    });
  });

  describe('undo handler', () => {
    test('executes undo successfully', async () => {
      setupHandlers();
      mockUndoRedoService.undo.mockResolvedValue({
        success: true,
        action: { type: 'move' }
      });

      const handler = handlers['undo-redo:undo'];
      const result = await handler({});

      expect(result.success).toBe(true);
      expect(mockUndoRedoService.undo).toHaveBeenCalled();
    });

    test('emits state-changed event for successful undo results with ISO timestamps', async () => {
      setupHandlers();
      const sender = {
        isDestroyed: jest.fn(() => false)
      };
      const undoResult = {
        success: true,
        action: {
          id: 'action-1',
          type: 'FILE_MOVE',
          description: 'Undo move',
          timestamp: '2026-03-12T13:26:51.839Z'
        }
      };
      mockUndoRedoService.undo.mockResolvedValue(undoResult);

      const handler = handlers['undo-redo:undo'];
      const result = await handler({ sender });

      expect(result).toEqual(undoResult);
      expect(safeSend).toHaveBeenCalledWith(sender, 'undo-redo:state-changed', {
        action: 'undo',
        result: undoResult
      });
    });

    test('broadcasts FILE_OPERATION_COMPLETE for the moves an undo performed [F-152]', async () => {
      // Pre-fix, undo/redo emitted only UNDO_REDO.STATE_CHANGED, which no
      // renderer path listener consumes — undoing an organize left graph
      // nodes and the timeline pointing at the reverted destinations.
      setupHandlers();
      const sender = { isDestroyed: jest.fn(() => false) };
      const undoResult = {
        success: true,
        action: { id: 'a1', type: 'MOVE_BATCH', description: 'Undo organize', timestamp: 't' },
        pathMutations: [
          { oldPath: '/dest/a.pdf', newPath: '/src/a.pdf' },
          { oldPath: '/dest/b.pdf', newPath: '/src/b.pdf' }
        ]
      };
      mockUndoRedoService.undo.mockResolvedValue(undoResult);

      await handlers['undo-redo:undo']({ sender });

      expect(safeSend).toHaveBeenCalledWith(sender, 'file-operation-complete', {
        operation: 'move',
        files: ['/dest/a.pdf', '/dest/b.pdf'],
        destinations: ['/src/a.pdf', '/src/b.pdf']
      });
    });

    test('broadcasts moves even for a partial undo, but no state-changed [F-152]', async () => {
      setupHandlers();
      const sender = { isDestroyed: jest.fn(() => false) };
      mockUndoRedoService.undo.mockResolvedValue({
        success: false,
        partial: true,
        action: { id: 'a2', type: 'MOVE_BATCH', description: 'd', timestamp: 't' },
        pathMutations: [{ oldPath: '/dest/a.pdf', newPath: '/src/a.pdf' }]
      });

      await handlers['undo-redo:undo']({ sender });

      // The files this partial undo DID move must still be remapped.
      expect(safeSend).toHaveBeenCalledWith(sender, 'file-operation-complete', {
        operation: 'move',
        files: ['/dest/a.pdf'],
        destinations: ['/src/a.pdf']
      });
      expect(safeSend).not.toHaveBeenCalledWith(
        sender,
        'undo-redo:state-changed',
        expect.anything()
      );
    });

    test('returns message when nothing to undo', async () => {
      setupHandlers();
      mockUndoRedoService.undo.mockResolvedValue(null);

      const handler = handlers['undo-redo:undo'];
      const result = await handler({});

      expect(result.success).toBe(false);
      expect(result.message).toBe('Nothing to undo');
    });

    test('returns fallback when service unavailable', async () => {
      setupHandlers(false);

      const handler = handlers['undo-redo:undo'];
      const result = await handler({});

      expect(result.success).toBe(false);
      expect(result.message).toBe('Undo service unavailable');
    });

    test('handles undo error', async () => {
      setupHandlers();
      mockUndoRedoService.undo.mockRejectedValue(new Error('Undo failed'));

      const handler = handlers['undo-redo:undo'];
      const result = await handler({});

      expect(result.success).toBe(false);
      expect(result.message).toBe('Undo failed');
    });
  });

  describe('redo handler', () => {
    test('executes redo successfully', async () => {
      setupHandlers();
      mockUndoRedoService.redo.mockResolvedValue({
        success: true,
        action: { type: 'move' }
      });

      const handler = handlers['undo-redo:redo'];
      const result = await handler({});

      expect(result.success).toBe(true);
    });

    test('returns message when nothing to redo', async () => {
      setupHandlers();
      mockUndoRedoService.redo.mockResolvedValue(null);

      const handler = handlers['undo-redo:redo'];
      const result = await handler({});

      expect(result.success).toBe(false);
      expect(result.message).toBe('Nothing to redo');
    });
  });

  describe('getHistory handler', () => {
    test('returns action history', async () => {
      setupHandlers();
      const history = [
        { id: 1, type: 'move' },
        { id: 2, type: 'copy' }
      ];
      mockUndoRedoService.getActionHistory.mockResolvedValue(history);

      const handler = handlers['undo-redo:get-history'];
      const result = await handler({}, 50);

      expect(result).toEqual(history);
      expect(mockUndoRedoService.getActionHistory).toHaveBeenCalledWith(50);
    });

    test('returns empty array when service unavailable', async () => {
      setupHandlers(false);

      const handler = handlers['undo-redo:get-history'];
      const result = await handler({});

      expect(result).toEqual([]);
    });

    test('returns empty array on error', async () => {
      setupHandlers();
      mockUndoRedoService.getActionHistory.mockRejectedValue(new Error('DB error'));

      const handler = handlers['undo-redo:get-history'];
      const result = await handler({});

      expect(result).toEqual([]);
    });

    test('normalizes invalid and string limits', async () => {
      setupHandlers();
      mockUndoRedoService.getActionHistory.mockResolvedValue([]);
      const handler = handlers['undo-redo:get-history'];

      await handler({}, '100');
      expect(mockUndoRedoService.getActionHistory).toHaveBeenLastCalledWith(100);

      await handler({}, -25);
      expect(mockUndoRedoService.getActionHistory).toHaveBeenLastCalledWith(1);

      await handler({}, Number.NaN);
      expect(mockUndoRedoService.getActionHistory).toHaveBeenLastCalledWith(50);
    });

    test('clamps excessively large limits', async () => {
      setupHandlers();
      mockUndoRedoService.getActionHistory.mockResolvedValue([]);
      const handler = handlers['undo-redo:get-history'];

      await handler({}, 10000);
      expect(mockUndoRedoService.getActionHistory).toHaveBeenCalledWith(200);
    });
  });

  describe('getState handler', () => {
    test('returns full undo/redo state', async () => {
      setupHandlers();
      const state = {
        stack: [{ id: '1', type: 'move', description: 'Move file' }],
        pointer: 0,
        canUndo: true,
        canRedo: false
      };
      mockUndoRedoService.getFullState.mockReturnValue(state);

      const handler = handlers['undo-redo:get-state'];
      const result = await handler({});

      expect(result).toEqual(state);
      expect(mockUndoRedoService.getFullState).toHaveBeenCalled();
    });

    test('returns empty state when service unavailable', async () => {
      setupHandlers(false);

      const handler = handlers['undo-redo:get-state'];
      const result = await handler({});

      expect(result).toEqual({
        stack: [],
        pointer: -1,
        canUndo: false,
        canRedo: false
      });
    });

    test('returns empty state on error', async () => {
      setupHandlers();
      mockUndoRedoService.getFullState.mockImplementation(() => {
        throw new Error('State error');
      });

      const handler = handlers['undo-redo:get-state'];
      const result = await handler({});

      expect(result).toEqual({
        stack: [],
        pointer: -1,
        canUndo: false,
        canRedo: false
      });
    });
  });

  describe('clearHistory handler', () => {
    test('clears action history', async () => {
      setupHandlers();
      mockUndoRedoService.clearHistory.mockResolvedValue({ success: true });

      const handler = handlers['undo-redo:clear-history'];
      const result = await handler({});

      expect(result.success).toBe(true);
    });

    test('returns success true when service returns null', async () => {
      setupHandlers();
      mockUndoRedoService.clearHistory.mockResolvedValue(null);

      const handler = handlers['undo-redo:clear-history'];
      const result = await handler({});

      expect(result.success).toBe(true);
    });
  });

  describe('canUndo handler', () => {
    test('returns true when undo available', async () => {
      setupHandlers();
      mockUndoRedoService.canUndo.mockResolvedValue(true);

      const handler = handlers['undo-redo:can-undo'];
      const result = await handler({});

      expect(result).toBe(true);
    });

    test('returns false when undo not available', async () => {
      setupHandlers();
      mockUndoRedoService.canUndo.mockResolvedValue(false);

      const handler = handlers['undo-redo:can-undo'];
      const result = await handler({});

      expect(result).toBe(false);
    });

    test('returns false when service unavailable', async () => {
      setupHandlers(false);

      const handler = handlers['undo-redo:can-undo'];
      const result = await handler({});

      expect(result).toBe(false);
    });
  });

  describe('canRedo handler', () => {
    test('returns true when redo available', async () => {
      setupHandlers();
      mockUndoRedoService.canRedo.mockResolvedValue(true);

      const handler = handlers['undo-redo:can-redo'];
      const result = await handler({});

      expect(result).toBe(true);
    });

    test('returns false when service unavailable', async () => {
      setupHandlers(false);

      const handler = handlers['undo-redo:can-redo'];
      const result = await handler({});

      expect(result).toBe(false);
    });
  });

  describe('degraded-state flag', () => {
    beforeEach(() => {
      mockDegradedTracker.raise.mockClear();
      mockDegradedTracker.clear.mockClear();
    });

    test('CAN_UNDO raises undo-redo.service-unavailable when service throws', async () => {
      // The toolbar's undo button is driven by polling CAN_UNDO. Without
      // this flag, a thrown service exception silently disables the
      // button — indistinguishable from "no history yet". A user mid-edit
      // who hits Ctrl+Z to back out a destructive change would get NO
      // visible response and proceed unaware. severity: 'error' reflects
      // that destructive-action recovery is the user's most critical
      // safety net.
      setupHandlers();
      mockUndoRedoService.canUndo.mockRejectedValue(new Error('database locked'));

      const handler = handlers['undo-redo:can-undo'];
      const result = await handler({});

      // Existing behaviour preserved.
      expect(result).toBe(false);
      // New behaviour: raised the flag.
      expect(mockDegradedTracker.raise).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'undo-redo.service-unavailable',
          subsystem: 'undo-redo',
          severity: 'error',
          message: expect.stringMatching(/undo\/redo isn't working/i)
        })
      );
    });

    test('CAN_UNDO clears the flag on the next successful read', async () => {
      setupHandlers();
      mockUndoRedoService.canUndo.mockResolvedValue(true);

      const handler = handlers['undo-redo:can-undo'];
      await handler({});

      expect(mockDegradedTracker.clear).toHaveBeenCalledWith('undo-redo.service-unavailable');
      expect(mockDegradedTracker.raise).not.toHaveBeenCalled();
    });

    test('CAN_REDO uses the same flag code so the banner does not double up', async () => {
      // CAN_UNDO and CAN_REDO are polled together. If they had distinct
      // codes the banner would show two near-identical entries when the
      // service was down. One stable code per subsystem.
      setupHandlers();
      mockUndoRedoService.canRedo.mockRejectedValue(new Error('database locked'));

      const handler = handlers['undo-redo:can-redo'];
      await handler({});

      expect(mockDegradedTracker.raise).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'undo-redo.service-unavailable' })
      );
    });

    test('GET_HISTORY raises the shared flag when the store read throws', async () => {
      // A thrown getActionHistory (DB lock / corrupted journal) returns [] —
      // identical to "no history". Without the flag the history panel renders
      // empty and the user concludes nothing was tracked. Reuses the same
      // subsystem code as CAN_UNDO/CAN_REDO so the banner stays single.
      setupHandlers();
      mockUndoRedoService.getActionHistory.mockRejectedValue(new Error('DB locked'));

      const handler = handlers['undo-redo:get-history'];
      // Pass an explicit limit so the mock createHandler forwards
      // (event, limit, service) and the real service.getActionHistory runs.
      const result = await handler({}, 50);

      // Existing behaviour preserved.
      expect(result).toEqual([]);
      // New behaviour: raised the shared flag.
      expect(mockDegradedTracker.raise).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'undo-redo.service-unavailable',
          subsystem: 'undo-redo',
          severity: 'error'
        })
      );
    });

    test('GET_HISTORY clears the flag on a successful read', async () => {
      setupHandlers();
      mockUndoRedoService.getActionHistory.mockResolvedValue([{ id: 1, type: 'move' }]);

      const handler = handlers['undo-redo:get-history'];
      await handler({}, 50);

      expect(mockDegradedTracker.clear).toHaveBeenCalledWith('undo-redo.service-unavailable');
      expect(mockDegradedTracker.raise).not.toHaveBeenCalled();
    });

    test('GET_STATE raises the shared flag when getFullState throws', async () => {
      // GET_STATE drives the same toolbar undo/redo enabled-state the polled
      // CAN_UNDO/CAN_REDO handlers do. A thrown getFullState returns the
      // canonical empty state, silently disabling both buttons — identical to
      // "no history yet". Reuses the same subsystem code so the banner stays
      // single even if CAN_* are polling concurrently.
      setupHandlers();
      mockUndoRedoService.getFullState.mockImplementation(() => {
        throw new Error('corrupted stack');
      });

      const handler = handlers['undo-redo:get-state'];
      const result = await handler({});

      // Existing behaviour preserved.
      expect(result).toEqual({
        stack: [],
        pointer: -1,
        canUndo: false,
        canRedo: false
      });
      // New behaviour: raised the shared flag.
      expect(mockDegradedTracker.raise).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'undo-redo.service-unavailable',
          subsystem: 'undo-redo',
          severity: 'error'
        })
      );
    });

    test('GET_STATE clears the flag on a successful read', async () => {
      setupHandlers();
      mockUndoRedoService.getFullState.mockReturnValue({
        stack: [{ id: '1', type: 'move' }],
        pointer: 0,
        canUndo: true,
        canRedo: false
      });

      const handler = handlers['undo-redo:get-state'];
      await handler({});

      expect(mockDegradedTracker.clear).toHaveBeenCalledWith('undo-redo.service-unavailable');
      expect(mockDegradedTracker.raise).not.toHaveBeenCalled();
    });
  });
});
