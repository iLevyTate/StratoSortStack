jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

describe('ipcRegistry waitForInFlightOperations', () => {
  test('waits for in-flight handlers to finish', async () => {
    // FL-1 FIX: Use real timers to avoid fake-timer + async interleaving races.
    // waitForInFlightOperations polls every 50ms, so handler must outlast the
    // timeout AND the first poll cycle for the "still in flight" assertion.
    jest.useRealTimers();

    jest.resetModules();
    const {
      registerHandler,
      waitForInFlightOperations,
      setShuttingDown
    } = require('../src/main/core/ipcRegistry');

    setShuttingDown(false);

    const handlers = {};
    const ipcMain = {
      handle: jest.fn((channel, handler) => {
        handlers[channel] = handler;
      }),
      removeHandler: jest.fn(),
      on: jest.fn(),
      removeListener: jest.fn()
    };

    // Handler takes 300ms — well beyond the 100ms wait timeout
    registerHandler(ipcMain, 'test:delay', async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      return { success: true };
    });

    const handlerPromise = handlers['test:delay']({}, {});

    // Wait should time out because handler is still in-flight
    await expect(waitForInFlightOperations(100)).resolves.toBe(false);

    await handlerPromise;

    // Now that handler has completed, waiting should succeed immediately
    await expect(waitForInFlightOperations(100)).resolves.toBe(true);
  });
});
/**
 * Tests for IPC Channel Registry
 * Tests targeted IPC channel registration and cleanup
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

describe('ipcRegistry', () => {
  let ipcRegistry;
  let mockIpcMain;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    mockIpcMain = {
      handle: jest.fn(),
      on: jest.fn(),
      removeHandler: jest.fn(),
      removeListener: jest.fn()
    };

    ipcRegistry = require('../src/main/core/ipcRegistry');
  });

  describe('registerHandler', () => {
    test('registers handler with ipcMain', () => {
      const handler = jest.fn();

      ipcRegistry.registerHandler(mockIpcMain, 'test-channel', handler);

      // FIX: Handler is now wrapped with shutdown gate, so check for any function
      expect(mockIpcMain.handle).toHaveBeenCalledWith('test-channel', expect.any(Function));
    });

    test('tracks registered handler', () => {
      const handler = jest.fn();

      ipcRegistry.registerHandler(mockIpcMain, 'test-channel', handler);

      expect(ipcRegistry.hasHandler('test-channel')).toBe(true);
    });

    test('throws error for empty channel', () => {
      expect(() => {
        ipcRegistry.registerHandler(mockIpcMain, '', jest.fn());
      }).toThrow('Channel must be a non-empty string');
    });

    test('throws error for null channel', () => {
      expect(() => {
        ipcRegistry.registerHandler(mockIpcMain, null, jest.fn());
      }).toThrow('Channel must be a non-empty string');
    });

    test('throws error for non-function handler', () => {
      expect(() => {
        ipcRegistry.registerHandler(mockIpcMain, 'channel', 'not a function');
      }).toThrow('Handler must be a function');
    });

    test('throws error for null handler', () => {
      expect(() => {
        ipcRegistry.registerHandler(mockIpcMain, 'channel', null);
      }).toThrow('Handler must be a function');
    });

    test('removes old handler on duplicate registration', () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();

      ipcRegistry.registerHandler(mockIpcMain, 'dup-channel', handler1);
      ipcRegistry.registerHandler(mockIpcMain, 'dup-channel', handler2);

      expect(mockIpcMain.removeHandler).toHaveBeenCalledWith('dup-channel');
      expect(mockIpcMain.handle).toHaveBeenCalledTimes(2);
    });
  });

  describe('registerListener', () => {
    test('registers listener with ipcMain', () => {
      const listener = jest.fn();

      ipcRegistry.registerListener(mockIpcMain, 'test-channel', listener);

      // FIX: Listener is now wrapped with shutdown gate, so check for wrapped function
      expect(mockIpcMain.on).toHaveBeenCalledWith('test-channel', expect.any(Function));
    });

    test('tracks registered listener', () => {
      const listener = jest.fn();

      ipcRegistry.registerListener(mockIpcMain, 'test-channel', listener);

      expect(ipcRegistry.hasListeners('test-channel')).toBe(true);
    });

    test('throws error for empty channel', () => {
      expect(() => {
        ipcRegistry.registerListener(mockIpcMain, '', jest.fn());
      }).toThrow('Channel must be a non-empty string');
    });

    test('throws error for non-function listener', () => {
      expect(() => {
        ipcRegistry.registerListener(mockIpcMain, 'channel', 'not a function');
      }).toThrow('Listener must be a function');
    });

    test('allows multiple listeners on same channel', () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();

      ipcRegistry.registerListener(mockIpcMain, 'channel', listener1);
      ipcRegistry.registerListener(mockIpcMain, 'channel', listener2);

      expect(mockIpcMain.on).toHaveBeenCalledTimes(2);
      expect(ipcRegistry.hasListeners('channel')).toBe(true);
    });
  });

  describe('removeHandler', () => {
    test('removes registered handler', () => {
      ipcRegistry.registerHandler(mockIpcMain, 'test-channel', jest.fn());

      const result = ipcRegistry.removeHandler(mockIpcMain, 'test-channel');

      expect(result).toBe(true);
      expect(mockIpcMain.removeHandler).toHaveBeenCalledWith('test-channel');
      expect(ipcRegistry.hasHandler('test-channel')).toBe(false);
    });

    test('returns false for unregistered handler', () => {
      const result = ipcRegistry.removeHandler(mockIpcMain, 'nonexistent');

      expect(result).toBe(false);
    });

    test('returns false on removeHandler error', () => {
      ipcRegistry.registerHandler(mockIpcMain, 'test-channel', jest.fn());
      mockIpcMain.removeHandler.mockImplementation(() => {
        throw new Error('Remove failed');
      });

      const result = ipcRegistry.removeHandler(mockIpcMain, 'test-channel');

      expect(result).toBe(false);
    });
  });

  describe('removeListener', () => {
    test('removes registered listener', () => {
      const listener = jest.fn();
      ipcRegistry.registerListener(mockIpcMain, 'test-channel', listener);

      const result = ipcRegistry.removeListener(mockIpcMain, 'test-channel', listener);

      expect(result).toBe(true);
      // FIX: Listener is wrapped, so check that removeListener was called with wrapped function
      expect(mockIpcMain.removeListener).toHaveBeenCalledWith('test-channel', expect.any(Function));
    });

    test('returns false for unregistered channel', () => {
      const result = ipcRegistry.removeListener(mockIpcMain, 'nonexistent', jest.fn());

      expect(result).toBe(false);
    });

    test('returns false for unregistered listener', () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();
      ipcRegistry.registerListener(mockIpcMain, 'channel', listener1);

      const result = ipcRegistry.removeListener(mockIpcMain, 'channel', listener2);

      expect(result).toBe(false);
    });

    test('cleans up channel when last listener removed', () => {
      const listener = jest.fn();
      ipcRegistry.registerListener(mockIpcMain, 'channel', listener);

      ipcRegistry.removeListener(mockIpcMain, 'channel', listener);

      expect(ipcRegistry.hasListeners('channel')).toBe(false);
    });

    test('returns false on removeListener error', () => {
      const listener = jest.fn();
      ipcRegistry.registerListener(mockIpcMain, 'channel', listener);
      mockIpcMain.removeListener.mockImplementation(() => {
        throw new Error('Remove failed');
      });

      const result = ipcRegistry.removeListener(mockIpcMain, 'channel', listener);

      expect(result).toBe(false);
    });
  });

  describe('removeAllRegistered', () => {
    test('removes all handlers and listeners', () => {
      ipcRegistry.registerHandler(mockIpcMain, 'handler1', jest.fn());
      ipcRegistry.registerHandler(mockIpcMain, 'handler2', jest.fn());
      ipcRegistry.registerListener(mockIpcMain, 'listener1', jest.fn());

      const result = ipcRegistry.removeAllRegistered(mockIpcMain);

      expect(result.handlers).toBe(2);
      expect(result.listeners).toBe(1);
    });

    test('clears registry after removal', () => {
      ipcRegistry.registerHandler(mockIpcMain, 'handler', jest.fn());
      ipcRegistry.registerListener(mockIpcMain, 'listener', jest.fn());

      ipcRegistry.removeAllRegistered(mockIpcMain);

      expect(ipcRegistry.hasHandler('handler')).toBe(false);
      expect(ipcRegistry.hasListeners('listener')).toBe(false);
    });

    test('handles errors during cleanup', () => {
      ipcRegistry.registerHandler(mockIpcMain, 'handler', jest.fn());
      mockIpcMain.removeHandler.mockImplementation(() => {
        throw new Error('Cleanup error');
      });

      // Should not throw
      expect(() => {
        ipcRegistry.removeAllRegistered(mockIpcMain);
      }).not.toThrow();
    });

    test('returns zero counts for empty registry', () => {
      const result = ipcRegistry.removeAllRegistered(mockIpcMain);

      expect(result.handlers).toBe(0);
      expect(result.listeners).toBe(0);
    });

    // Regression guard for the L4 audit fix in lifecycle.js: system:log is
    // kept registered past Phase 2 IPC cleanup so the renderer logger can
    // keep sending log lines while the rest of the cleanup runs (the
    // observed shutdown noise was a flurry of "No handler registered for
    // system:log" errors). The mechanism is `excludeChannels` on
    // removeAllRegistered.
    test('excludeChannels keeps named handler registered and reports kept', () => {
      const keepHandler = jest.fn();
      const removeHandler = jest.fn();
      ipcRegistry.registerHandler(mockIpcMain, 'system:log', keepHandler);
      ipcRegistry.registerHandler(mockIpcMain, 'files:select', removeHandler);

      const result = ipcRegistry.removeAllRegistered(mockIpcMain, {
        excludeChannels: new Set(['system:log'])
      });

      expect(result.handlers).toBe(1);
      expect(result.kept).toContain('system:log');
      // The kept handler must still be reachable AFTER the cleanup pass.
      expect(ipcRegistry.hasHandler('system:log')).toBe(true);
      expect(ipcRegistry.hasHandler('files:select')).toBe(false);
    });

    test('excludeChannels accepts an array (not just a Set)', () => {
      ipcRegistry.registerHandler(mockIpcMain, 'system:log', jest.fn());
      ipcRegistry.registerHandler(mockIpcMain, 'files:select', jest.fn());

      const result = ipcRegistry.removeAllRegistered(mockIpcMain, {
        excludeChannels: ['system:log']
      });

      expect(result.handlers).toBe(1);
      expect(result.kept).toContain('system:log');
      expect(ipcRegistry.hasHandler('system:log')).toBe(true);
    });

    test('excludeChannels also preserves listener registrations', () => {
      ipcRegistry.registerListener(mockIpcMain, 'system:log', jest.fn());
      ipcRegistry.registerListener(mockIpcMain, 'unrelated', jest.fn());

      const result = ipcRegistry.removeAllRegistered(mockIpcMain, {
        excludeChannels: new Set(['system:log'])
      });

      expect(result.listeners).toBe(1);
      expect(result.kept).toContain('system:log');
      expect(ipcRegistry.hasListeners('system:log')).toBe(true);
      expect(ipcRegistry.hasListeners('unrelated')).toBe(false);
    });
  });

  describe('getStats', () => {
    test('returns handler count', () => {
      ipcRegistry.registerHandler(mockIpcMain, 'handler1', jest.fn());
      ipcRegistry.registerHandler(mockIpcMain, 'handler2', jest.fn());

      const stats = ipcRegistry.getStats();

      expect(stats.handlers).toBe(2);
    });

    test('returns listener count', () => {
      ipcRegistry.registerListener(mockIpcMain, 'listener1', jest.fn());
      ipcRegistry.registerListener(mockIpcMain, 'listener1', jest.fn());
      ipcRegistry.registerListener(mockIpcMain, 'listener2', jest.fn());

      const stats = ipcRegistry.getStats();

      expect(stats.listeners).toBe(3);
    });

    test('returns sorted channel list', () => {
      ipcRegistry.registerHandler(mockIpcMain, 'zebra', jest.fn());
      ipcRegistry.registerHandler(mockIpcMain, 'alpha', jest.fn());
      ipcRegistry.registerListener(mockIpcMain, 'beta', jest.fn());

      const stats = ipcRegistry.getStats();

      expect(stats.channels).toEqual(['alpha', 'beta', 'zebra']);
    });

    test('returns empty stats for empty registry', () => {
      const stats = ipcRegistry.getStats();

      expect(stats.handlers).toBe(0);
      expect(stats.listeners).toBe(0);
      expect(stats.channels).toEqual([]);
    });
  });

  describe('hasHandler', () => {
    test('returns true for registered handler', () => {
      ipcRegistry.registerHandler(mockIpcMain, 'channel', jest.fn());

      expect(ipcRegistry.hasHandler('channel')).toBe(true);
    });

    test('returns false for unregistered handler', () => {
      expect(ipcRegistry.hasHandler('nonexistent')).toBe(false);
    });
  });

  describe('hasListeners', () => {
    test('returns true for channel with listeners', () => {
      ipcRegistry.registerListener(mockIpcMain, 'channel', jest.fn());

      expect(ipcRegistry.hasListeners('channel')).toBe(true);
    });

    test('returns false for channel without listeners', () => {
      expect(ipcRegistry.hasListeners('nonexistent')).toBe(false);
    });

    test('returns false for channel with empty listener set', () => {
      const listener = jest.fn();
      ipcRegistry.registerListener(mockIpcMain, 'channel', listener);
      ipcRegistry.removeListener(mockIpcMain, 'channel', listener);

      expect(ipcRegistry.hasListeners('channel')).toBe(false);
    });
  });

  describe('shutdown gate', () => {
    test('setShuttingDown sets shutdown state', () => {
      expect(ipcRegistry.isShuttingDown()).toBe(false);

      ipcRegistry.setShuttingDown(true);
      expect(ipcRegistry.isShuttingDown()).toBe(true);

      ipcRegistry.setShuttingDown(false);
      expect(ipcRegistry.isShuttingDown()).toBe(false);
    });

    test('wrapped handler returns error when shutting down', async () => {
      const handler = jest.fn().mockResolvedValue({ success: true });
      ipcRegistry.registerHandler(mockIpcMain, 'test-channel', handler);

      // Get the wrapped handler that was registered
      const wrappedHandler = mockIpcMain.handle.mock.calls[0][1];

      // Set shutdown state
      ipcRegistry.setShuttingDown(true);

      // Call the wrapped handler
      const result = await wrappedHandler({}, 'arg1', 'arg2');

      // Should return shutdown error without calling original handler
      expect(result).toEqual({
        success: false,
        error: {
          code: 'APP_SHUTTING_DOWN',
          message: 'Application is shutting down'
        }
      });
      expect(handler).not.toHaveBeenCalled();

      // Reset for other tests
      ipcRegistry.setShuttingDown(false);
    });

    test('wrapped handler calls original handler when not shutting down', async () => {
      const handler = jest.fn().mockResolvedValue({ success: true, data: 'test' });
      ipcRegistry.registerHandler(mockIpcMain, 'normal-channel', handler);

      // Get the wrapped handler
      const wrappedHandler = mockIpcMain.handle.mock.calls[0][1];

      // Ensure not shutting down
      ipcRegistry.setShuttingDown(false);

      // Call the wrapped handler
      const mockEvent = { sender: {} };
      const result = await wrappedHandler(mockEvent, 'arg1', 'arg2');

      // Should call original handler and return its result
      expect(handler).toHaveBeenCalledWith(mockEvent, 'arg1', 'arg2');
      expect(result).toEqual({ success: true, data: 'test' });
    });

    test('wrapped listener does NOT fire during shutdown', () => {
      const listener = jest.fn();
      ipcRegistry.registerListener(mockIpcMain, 'shutdown-listener', listener);

      // Get the wrapped listener
      const wrappedListener = mockIpcMain.on.mock.calls[0][1];

      ipcRegistry.setShuttingDown(true);

      // Call the wrapped listener — original should NOT be called
      wrappedListener({}, 'data');
      expect(listener).not.toHaveBeenCalled();

      ipcRegistry.setShuttingDown(false);
    });

    test('wrapped listener calls original when NOT shutting down', () => {
      const listener = jest.fn().mockReturnValue('sync-result');
      ipcRegistry.registerListener(mockIpcMain, 'active-listener', listener);

      const wrappedListener = mockIpcMain.on.mock.calls[0][1];

      ipcRegistry.setShuttingDown(false);

      const mockEvent = { sender: {} };
      const result = wrappedListener(mockEvent, 'arg1', 'arg2');

      expect(listener).toHaveBeenCalledWith(mockEvent, 'arg1', 'arg2');
      expect(result).toBe('sync-result');
    });

    test('wrapped listener handles async return', async () => {
      const listener = jest.fn().mockResolvedValue('async-result');
      ipcRegistry.registerListener(mockIpcMain, 'async-listener', listener);

      const wrappedListener = mockIpcMain.on.mock.calls[0][1];

      ipcRegistry.setShuttingDown(false);

      const result = wrappedListener({}, 'data');

      // The result should be a Promise since the original returns a Promise
      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBe('async-result');
    });
  });
});
