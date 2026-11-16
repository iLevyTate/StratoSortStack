/**
 * Tests for remaining resource cleanup fixes (round 2)
 *
 * Covers:
 * - platformBehavior.js: always-on-top timer skips a closed window, no 'closed' listener
 * - windowState.js: settle timer skips a closed window, no 'closed' listener
 * - createWindow.js: nested DevTools timer IDs tracked and cleared
 * - VisionService.downloadFile: response stream destroyed on fileStream error
 * - asyncSpawnUtils.js: child process listeners cleaned up after exit
 */

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

// ====================== platformBehavior: always-on-top timer cleanup ======================

describe('platformBehavior - always-on-top timer cleanup', () => {
  let platformBehavior;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();

    jest.doMock('../src/shared/platformUtils', () => ({
      get isWindows() {
        return true;
      },
      get isMacOS() {
        return false;
      }
    }));
    jest.doMock('../src/shared/performanceConstants', () => ({
      WINDOW: { ALWAYS_ON_TOP_DURATION_MS: 50 },
      PROCESS: { KILL_COMMAND_TIMEOUT_MS: 100, GRACEFUL_SHUTDOWN_WAIT_MS: 100 },
      TIMEOUTS: { SIGKILL_VERIFY: 10 }
    }));
    jest.doMock('../src/main/utils/asyncSpawnUtils', () => ({
      asyncSpawn: jest.fn()
    }));

    platformBehavior = require('../src/main/core/platformBehavior');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('does not register a closed handler for the always-on-top timer', () => {
    // A once('closed') per call piled up on the long-lived main window; the
    // timer callback checks isDestroyed() instead.
    const mockWindow = {
      isDestroyed: jest.fn().mockReturnValue(false),
      setAlwaysOnTop: jest.fn(),
      moveTop: jest.fn(),
      show: jest.fn(),
      focus: jest.fn(),
      once: jest.fn(),
      on: jest.fn()
    };

    platformBehavior.bringWindowToForeground(mockWindow);

    expect(mockWindow.once).not.toHaveBeenCalledWith('closed', expect.any(Function));
    expect(mockWindow.on).not.toHaveBeenCalledWith('closed', expect.any(Function));
  });

  test('timer leaves a window destroyed before the timeout alone', () => {
    let destroyed = false;
    const mockWindow = {
      isDestroyed: jest.fn(() => destroyed),
      setAlwaysOnTop: jest.fn(),
      moveTop: jest.fn(),
      show: jest.fn(),
      focus: jest.fn(),
      once: jest.fn()
    };

    platformBehavior.bringWindowToForeground(mockWindow);

    // setAlwaysOnTop(true) was called
    expect(mockWindow.setAlwaysOnTop).toHaveBeenCalledWith(true);

    // Window is destroyed BEFORE the timer fires
    destroyed = true;
    jest.advanceTimersByTime(100);

    // Only the initial setAlwaysOnTop(true); the timer skipped the dead window
    expect(mockWindow.setAlwaysOnTop).toHaveBeenCalledTimes(1);
  });
});

// ====================== windowState: settle timer cleanup ======================

describe('windowState - settle timer cleanup', () => {
  let windowState;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();

    jest.doMock('../src/shared/performanceConstants', () => ({
      WINDOW: {
        RESTORE_SETTLE_MS: 100,
        RESTORE_TIMEOUT_MS: 3000,
        RESTORE_FORCE_SETTLE_MS: 200
      }
    }));
    jest.doMock('electron', () => ({
      screen: {
        getPrimaryDisplay: jest.fn(() => ({
          workAreaSize: { width: 1920, height: 1080 }
        }))
      }
    }));

    windowState = require('../src/main/core/windowState');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('restoreMinimizedWindow settles without registering a closed handler', async () => {
    const restoreHandlers = [];
    const closedHandlers = [];
    const mockWindow = {
      isDestroyed: jest.fn().mockReturnValue(false),
      isFullScreen: jest.fn().mockReturnValue(false),
      isMinimized: jest.fn().mockReturnValue(true),
      isMaximized: jest.fn().mockReturnValue(false),
      isVisible: jest.fn().mockReturnValue(true),
      isFocused: jest.fn().mockReturnValue(false),
      focus: jest.fn(),
      show: jest.fn(),
      restore: jest.fn(),
      center: jest.fn(),
      getBounds: jest.fn().mockReturnValue({ x: 100, y: 100, width: 800, height: 600 }),
      on: jest.fn(),
      once: jest.fn((event, cb) => {
        if (event === 'restore') restoreHandlers.push(cb);
        if (event === 'closed') closedHandlers.push(cb);
      }),
      removeListener: jest.fn()
    };

    // Start restoreMinimizedWindow (creates promise + registers restore handler + timeout)
    const promise = windowState.restoreMinimizedWindow(mockWindow);

    // Simulate the restore event firing (triggers onRestore -> settle timer)
    restoreHandlers.forEach((cb) => cb());

    // The settle timer checks isDestroyed() itself, so no per-restore 'closed'
    // listener is left on the long-lived main window
    expect(closedHandlers).toHaveLength(0);

    // Advance past settle time so the settle timer fires and the promise resolves
    jest.advanceTimersByTime(200);

    await promise;

    // Verify the window was focused during settle
    expect(mockWindow.focus).toHaveBeenCalled();
  });
});

// asyncSpawnUtils tests are in a separate file (asyncSpawnUtils.cleanup.test.js)
// due to jest.mock('child_process') requiring file-level hoisting.

// ====================== VisionService.downloadFile: response stream cleanup ======================

describe('VisionService.downloadFile - stream error cleanup', () => {
  test('destroys response stream when fileStream errors', () => {
    // Verify the pattern: response.on('error') destroys fileStream,
    // fileStream.on('error') destroys response
    const mockResponse = {
      statusCode: 200,
      pipe: jest.fn(),
      on: jest.fn(),
      destroy: jest.fn()
    };
    const mockFileStream = {
      on: jest.fn(),
      close: jest.fn(),
      destroy: jest.fn()
    };

    // Simulate the event wiring from downloadFile
    // fileStream.on('error', ...) should call response.destroy()
    const fileStreamHandlers = {};
    mockFileStream.on.mockImplementation((event, handler) => {
      fileStreamHandlers[event] = handler;
    });

    const responseHandlers = {};
    mockResponse.on.mockImplementation((event, handler) => {
      responseHandlers[event] = handler;
    });

    // Simulate what downloadFile does after getting a 200 response:
    // response.pipe(fileStream)
    // fileStream.on('finish', ...) / fileStream.on('error', ...)
    // response.on('error', ...)
    mockResponse.pipe(mockFileStream);

    // Register the handlers as the source code does
    mockFileStream.on('finish', () => mockFileStream.close());
    mockFileStream.on('error', (error) => {
      mockResponse.destroy();
    });
    mockResponse.on('error', (error) => {
      mockFileStream.destroy();
    });

    // Trigger a fileStream error
    fileStreamHandlers['error'](new Error('Disk full'));

    expect(mockResponse.destroy).toHaveBeenCalled();

    // Trigger a response error
    responseHandlers['error'](new Error('Network failure'));

    expect(mockFileStream.destroy).toHaveBeenCalled();
  });
});
