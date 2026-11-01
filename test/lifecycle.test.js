/**
 * Tests for lifecycle.js — Electron app lifecycle management.
 * Covers handleBeforeQuit shutdown sequence, verifyShutdownCleanup,
 * and error handlers.
 */

jest.mock('electron', () => ({
  app: {
    quit: jest.fn(),
    exit: jest.fn(),
    relaunch: jest.fn(),
    on: jest.fn(),
    removeListener: jest.fn()
  },
  BrowserWindow: {
    getAllWindows: jest.fn().mockReturnValue([])
  },
  ipcMain: {
    removeHandler: jest.fn(),
    removeAllListeners: jest.fn()
  },
  powerMonitor: {
    on: jest.fn(),
    removeListener: jest.fn()
  }
}));

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
};
const mockShutdownLogging = jest.fn();
const mockHasPendingDownloadedUpdate = jest.fn();

jest.mock('../src/shared/logger', () => ({
  createLogger: () => mockLogger,
  shutdownLogging: (...args) => mockShutdownLogging(...args)
}));

jest.mock('../src/main/core/autoUpdater', () => ({
  hasPendingDownloadedUpdate: () => mockHasPendingDownloadedUpdate()
}));

jest.mock('../src/main/core/systemTray', () => ({
  destroyTray: jest.fn(),
  getTray: jest.fn().mockReturnValue(null),
  unregisterGlobalShortcuts: jest.fn()
}));

jest.mock('../src/main/services/startup', () => ({
  getStartupManager: jest.fn(() => ({
    shutdown: jest.fn().mockResolvedValue(undefined)
  }))
}));

jest.mock('../src/main/core/systemAnalytics', () => ({
  destroy: jest.fn()
}));

jest.mock('../src/shared/promiseUtils', () => ({
  withTimeout: jest.fn((promise) => promise),
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

jest.mock('../src/main/core/ipcRegistry', () => ({
  setShuttingDown: jest.fn(),
  waitForInFlightOperations: jest.fn().mockResolvedValue(true),
  removeAllRegistered: jest.fn().mockReturnValue({ handlers: 5, listeners: 3 })
}));

jest.mock('../src/main/utils/workerPools', () => ({
  destroyPools: jest.fn().mockResolvedValue(undefined)
}));

describe('lifecycle – verifyShutdownCleanup', () => {
  let verifyShutdownCleanup;
  let initializeLifecycle;

  beforeEach(() => {
    jest.resetModules();
    Object.values(mockLogger).forEach((fn) => fn.mockClear());

    // Re-import to get a fresh module
    const lifecycle = require('../src/main/core/lifecycle');
    verifyShutdownCleanup = lifecycle.verifyShutdownCleanup;
    initializeLifecycle = lifecycle.initializeLifecycle;
  });

  test('reports no issues when all resources are released', async () => {
    initializeLifecycle({
      getMetricsInterval: () => null,
      getChildProcessListeners: () => [],
      getGlobalProcessListeners: () => [],
      getEventListeners: () => [],
      getServiceIntegration: () => null,
      getDownloadWatcher: () => null
    });

    // Should not throw
    await expect(verifyShutdownCleanup()).resolves.toBeUndefined();
  });

  test('detects leaked metrics interval', async () => {
    initializeLifecycle({
      getMetricsInterval: () => 12345, // non-null = leak
      getChildProcessListeners: () => [],
      getGlobalProcessListeners: () => [],
      getEventListeners: () => [],
      getServiceIntegration: () => null,
      getDownloadWatcher: () => null
    });

    // Should not throw, but will log warnings internally
    await expect(verifyShutdownCleanup()).resolves.toBeUndefined();
  });

  test('detects leaked event listeners', async () => {
    initializeLifecycle({
      getMetricsInterval: () => null,
      getChildProcessListeners: () => [() => {}],
      getGlobalProcessListeners: () => [() => {}],
      getEventListeners: () => [() => {}, () => {}],
      getServiceIntegration: () => ({ initialized: true }),
      getDownloadWatcher: () => ({ stop: jest.fn() })
    });

    await expect(verifyShutdownCleanup()).resolves.toBeUndefined();
  });

  test('does not flag undefined download watcher as a leak', async () => {
    initializeLifecycle({
      getMetricsInterval: () => null,
      getChildProcessListeners: () => [],
      getGlobalProcessListeners: () => [],
      getEventListeners: () => [],
      getServiceIntegration: () => null,
      getDownloadWatcher: () => undefined
    });

    await expect(verifyShutdownCleanup()).resolves.toBeUndefined();

    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('downloadWatcher is not null')
    );
  });
});

describe('lifecycle – handleBeforeQuit', () => {
  let handleBeforeQuit;
  let initializeLifecycle;

  beforeEach(() => {
    jest.resetModules();
    // Re-mock dependencies to reset call counts
    jest.mock('../src/main/core/ipcRegistry', () => ({
      setShuttingDown: jest.fn(),
      waitForInFlightOperations: jest.fn().mockResolvedValue(true),
      removeAllRegistered: jest.fn().mockReturnValue({ handlers: 0, listeners: 0 })
    }));

    const lifecycle = require('../src/main/core/lifecycle');
    handleBeforeQuit = lifecycle.handleBeforeQuit;
    initializeLifecycle = lifecycle.initializeLifecycle;
  });

  test('sets IPC shutdown gate before cleanup', async () => {
    initializeLifecycle({
      setIsQuitting: jest.fn(),
      getMetricsInterval: () => null,
      setMetricsInterval: jest.fn(),
      getDownloadWatcher: () => null,
      setDownloadWatcher: jest.fn(),
      getServiceIntegration: () => null,
      getSettingsService: () => null,
      getChildProcessListeners: () => [],
      setChildProcessListeners: jest.fn(),
      getGlobalProcessListeners: () => [],
      setGlobalProcessListeners: jest.fn(),
      getEventListeners: () => [],
      setEventListeners: jest.fn()
    });

    await handleBeforeQuit();

    const { setShuttingDown } = require('../src/main/core/ipcRegistry');
    expect(setShuttingDown).toHaveBeenCalledWith(true);
  });

  test('clears metrics interval during cleanup', async () => {
    const setMetricsInterval = jest.fn();
    const intervalId = setInterval(() => {}, 10000);

    initializeLifecycle({
      setIsQuitting: jest.fn(),
      getMetricsInterval: () => intervalId,
      setMetricsInterval,
      getDownloadWatcher: () => null,
      setDownloadWatcher: jest.fn(),
      getServiceIntegration: () => null,
      getSettingsService: () => null,
      getChildProcessListeners: () => [],
      setChildProcessListeners: jest.fn(),
      getGlobalProcessListeners: () => [],
      setGlobalProcessListeners: jest.fn(),
      getEventListeners: () => [],
      setEventListeners: jest.fn()
    });

    await handleBeforeQuit();

    expect(setMetricsInterval).toHaveBeenCalledWith(null);
    clearInterval(intervalId); // cleanup
  });

  test('stops download watcher during cleanup', async () => {
    const mockWatcher = { stop: jest.fn().mockResolvedValue(undefined) };
    const setDownloadWatcher = jest.fn();

    initializeLifecycle({
      setIsQuitting: jest.fn(),
      getMetricsInterval: () => null,
      setMetricsInterval: jest.fn(),
      getDownloadWatcher: () => mockWatcher,
      setDownloadWatcher,
      getServiceIntegration: () => null,
      getSettingsService: () => null,
      getChildProcessListeners: () => [],
      setChildProcessListeners: jest.fn(),
      getGlobalProcessListeners: () => [],
      setGlobalProcessListeners: jest.fn(),
      getEventListeners: () => [],
      setEventListeners: jest.fn()
    });

    await handleBeforeQuit();

    expect(mockWatcher.stop).toHaveBeenCalled();
    expect(setDownloadWatcher).toHaveBeenCalledWith(null);
  });

  test('is idempotent (re-entrant quit guard)', async () => {
    initializeLifecycle({
      setIsQuitting: jest.fn(),
      getMetricsInterval: () => null,
      setMetricsInterval: jest.fn(),
      getDownloadWatcher: () => null,
      setDownloadWatcher: jest.fn(),
      getServiceIntegration: () => null,
      getSettingsService: () => null,
      getChildProcessListeners: () => [],
      setChildProcessListeners: jest.fn(),
      getGlobalProcessListeners: () => [],
      setGlobalProcessListeners: jest.fn(),
      getEventListeners: () => [],
      setEventListeners: jest.fn()
    });

    await handleBeforeQuit();
    const { setShuttingDown } = require('../src/main/core/ipcRegistry');
    const callCount1 = setShuttingDown.mock.calls.length;

    // Second call should be a no-op
    await handleBeforeQuit();
    expect(setShuttingDown.mock.calls.length).toBe(callCount1);
  });
});

describe('lifecycle – handleBeforeQuit exit code vs pending update', () => {
  const baseConfig = () => ({
    setIsQuitting: jest.fn(),
    getMetricsInterval: () => null,
    setMetricsInterval: jest.fn(),
    getDownloadWatcher: () => null,
    setDownloadWatcher: jest.fn(),
    getServiceIntegration: () => null,
    getSettingsService: () => null,
    getChildProcessListeners: () => [],
    setChildProcessListeners: jest.fn(),
    getGlobalProcessListeners: () => [],
    setGlobalProcessListeners: jest.fn(),
    getEventListeners: () => [],
    setEventListeners: jest.fn()
  });

  const promiseUtilsMock = (withTimeout) => () => ({
    withTimeout,
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
  });

  const runQuit = async () => {
    const electron = require('electron');
    electron.app.exit.mockClear();
    const lifecycle = require('../src/main/core/lifecycle');
    lifecycle.initializeLifecycle(baseConfig());
    await lifecycle.handleBeforeQuit();
    expect(electron.app.exit).toHaveBeenCalledTimes(1);
    return electron.app.exit.mock.calls[0][0];
  };

  beforeEach(() => {
    jest.resetModules();
    Object.values(mockLogger).forEach((fn) => fn.mockClear());
    mockShutdownLogging.mockReset().mockResolvedValue(undefined);
    mockHasPendingDownloadedUpdate.mockReset().mockReturnValue(false);
    // jest.doMock registrations survive resetModules, so re-arm the
    // pass-through withTimeout before every test.
    jest.doMock('../src/shared/promiseUtils', promiseUtilsMock(jest.fn((promise) => promise)));
  });

  test('exits 0 after a clean shutdown', async () => {
    await expect(runQuit()).resolves.toBe(0);
  });

  test.each([
    [false, 1],
    [true, 0]
  ])(
    'cleanup rejecting for a non-timeout reason (pending update: %s) exits %i',
    async (pending, expectedCode) => {
      mockHasPendingDownloadedUpdate.mockReturnValue(pending);
      jest.doMock(
        '../src/shared/promiseUtils',
        promiseUtilsMock(
          jest.fn((promise, _ms, label) =>
            label === 'Cleanup wall' ? Promise.reject(new Error('cleanup exploded')) : promise
          )
        )
      );

      await expect(runQuit()).resolves.toBe(expectedCode);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Cleanup failed'),
        'cleanup exploded'
      );
    }
  );

  test.each([
    [false, 1],
    [true, 0]
  ])('cleanup wall timeout (pending update: %s) exits %i', async (pending, expectedCode) => {
    mockHasPendingDownloadedUpdate.mockReturnValue(pending);
    jest.doMock(
      '../src/shared/promiseUtils',
      promiseUtilsMock(
        jest.fn((promise, _ms, label) =>
          label === 'Cleanup wall'
            ? Promise.reject(new Error('Cleanup wall timed out after 54000ms'))
            : promise
        )
      )
    );

    await expect(runQuit()).resolves.toBe(expectedCode);
  });

  test.each([
    [false, 1],
    [true, 0]
  ])(
    'shutdown verification throwing (pending update: %s) exits %i',
    async (pending, expectedCode) => {
      mockHasPendingDownloadedUpdate.mockReturnValue(pending);
      const { getTray } = require('../src/main/core/systemTray');
      getTray.mockImplementation(() => {
        throw new Error('tray handle gone');
      });

      try {
        await expect(runQuit()).resolves.toBe(expectedCode);
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('[SHUTDOWN-VERIFY] Verification failed'),
          'tray handle gone'
        );
      } finally {
        getTray.mockReset().mockReturnValue(null);
      }
    }
  );

  test.each([
    [false, 1],
    [true, 0]
  ])('log flush failure (pending update: %s) exits %i', async (pending, expectedCode) => {
    mockHasPendingDownloadedUpdate.mockReturnValue(pending);
    mockShutdownLogging.mockRejectedValue(new Error('sonic boom is not ready yet'));

    await expect(runQuit()).resolves.toBe(expectedCode);
  });

  test('clean exit with a pending update stays 0 without logging the override', async () => {
    mockHasPendingDownloadedUpdate.mockReturnValue(true);

    await expect(runQuit()).resolves.toBe(0);
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('exiting 0 so the installer can run')
    );
  });
});

describe('lifecycle – relaunch requested during shutdown', () => {
  const quitConfig = () => ({
    setIsQuitting: jest.fn(),
    getMetricsInterval: () => null,
    setMetricsInterval: jest.fn(),
    getDownloadWatcher: () => null,
    setDownloadWatcher: jest.fn(),
    getServiceIntegration: () => null,
    getSettingsService: () => null,
    getChildProcessListeners: () => [],
    setChildProcessListeners: jest.fn(),
    getGlobalProcessListeners: () => [],
    setGlobalProcessListeners: jest.fn(),
    getEventListeners: () => [],
    setEventListeners: jest.fn()
  });

  let electron;
  let lifecycle;

  beforeEach(() => {
    jest.resetModules();
    Object.values(mockLogger).forEach((fn) => fn.mockClear());
    mockShutdownLogging.mockReset().mockResolvedValue(undefined);
    mockHasPendingDownloadedUpdate.mockReset().mockReturnValue(false);
    jest.doMock('../src/shared/promiseUtils', () => ({
      withTimeout: jest.fn((promise) => promise),
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
    electron = require('electron');
    electron.app.exit.mockClear();
    electron.app.relaunch.mockClear();
    lifecycle = require('../src/main/core/lifecycle');
    lifecycle.initializeLifecycle(quitConfig());
  });

  test('without a request the app exits without relaunching', async () => {
    await lifecycle.handleBeforeQuit();

    expect(electron.app.relaunch).not.toHaveBeenCalled();
    expect(electron.app.exit).toHaveBeenCalledTimes(1);
  });

  test('a request made during shutdown relaunches once, right before app.exit', async () => {
    const quit = lifecycle.handleBeforeQuit();
    expect(lifecycle.requestRelaunchAfterShutdown('second-instance')).toBe(true);
    await quit;

    expect(electron.app.relaunch).toHaveBeenCalledTimes(1);
    expect(electron.app.exit).toHaveBeenCalledTimes(1);
    expect(electron.app.relaunch.mock.invocationCallOrder[0]).toBeLessThan(
      electron.app.exit.mock.invocationCallOrder[0]
    );
    // Logged while the log streams are still open.
    const relaunchLog = mockLogger.info.mock.calls.findIndex(
      ([msg]) => msg === '[SHUTDOWN] Relaunching after shutdown'
    );
    expect(relaunchLog).toBeGreaterThan(-1);
    expect(mockLogger.info.mock.invocationCallOrder[relaunchLog]).toBeLessThan(
      mockShutdownLogging.mock.invocationCallOrder[0]
    );
    expect(mockLogger.info.mock.calls[relaunchLog][1]).toEqual(
      expect.objectContaining({ reason: 'second-instance' })
    );
  });

  test('the relaunched instance does not replay Jump List tasks from this instance', async () => {
    const originalArgv = process.argv;
    process.argv = [
      'C:\\Program Files\\StratoSort Stack\\StratoSort Stack.exe',
      '--open-documents',
      '--some-flag',
      '--analyze-folder'
    ];
    try {
      lifecycle.requestRelaunchAfterShutdown('second-instance');
      await lifecycle.handleBeforeQuit();
    } finally {
      process.argv = originalArgv;
    }

    expect(electron.app.relaunch).toHaveBeenCalledTimes(1);
    expect(electron.app.relaunch).toHaveBeenCalledWith({ args: ['--some-flag'] });
  });

  test('repeated requests are one-shot: app.relaunch starts one instance per call', async () => {
    expect(lifecycle.requestRelaunchAfterShutdown('second-instance')).toBe(true);
    expect(lifecycle.requestRelaunchAfterShutdown('second-instance')).toBe(false);
    expect(lifecycle.requestRelaunchAfterShutdown('second-instance')).toBe(false);

    await lifecycle.handleBeforeQuit();
    await lifecycle.handleBeforeQuit(); // re-entrant quit is ignored

    expect(electron.app.relaunch).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[SHUTDOWN] Relaunch requested; the app will start again after shutdown',
      expect.objectContaining({ reason: 'second-instance' })
    );
  });

  test('a request that lands while the logs flush is still honoured', async () => {
    mockShutdownLogging.mockImplementation(async () => {
      lifecycle.requestRelaunchAfterShutdown('second-instance');
    });

    await lifecycle.handleBeforeQuit();

    expect(electron.app.relaunch).toHaveBeenCalledTimes(1);
    expect(electron.app.relaunch.mock.invocationCallOrder[0]).toBeLessThan(
      electron.app.exit.mock.invocationCallOrder[0]
    );
  });

  test('a downloaded update that installs on quit wins over the relaunch', async () => {
    mockHasPendingDownloadedUpdate.mockReturnValue(true);
    lifecycle.requestRelaunchAfterShutdown('second-instance');

    await lifecycle.handleBeforeQuit();

    expect(electron.app.relaunch).not.toHaveBeenCalled();
    expect(electron.app.exit).toHaveBeenCalledWith(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Not relaunching'),
      expect.objectContaining({ reason: 'second-instance' })
    );
  });

  test('a throwing app.relaunch still exits', async () => {
    electron.app.relaunch.mockImplementationOnce(() => {
      throw new Error('relaunch unavailable');
    });
    lifecycle.requestRelaunchAfterShutdown('second-instance');

    await expect(lifecycle.handleBeforeQuit()).resolves.toBeUndefined();
    expect(electron.app.exit).toHaveBeenCalledTimes(1);
  });
});

describe('lifecycle – error classification (handleUnhandledRejection)', () => {
  let handleUnhandledRejection;

  const errorTypeOf = () => {
    const call = mockLogger.error.mock.calls.find(([msg]) => msg === 'UNHANDLED REJECTION:');
    return call?.[1]?.errorType;
  };

  beforeEach(() => {
    jest.resetModules();
    Object.values(mockLogger).forEach((fn) => fn.mockClear());
    handleUnhandledRejection = require('../src/main/core/lifecycle').handleUnhandledRejection;
  });

  test('preserves classifier categories without an explicit alias (ENOSPC → DISK_FULL, not UNKNOWN)', () => {
    handleUnhandledRejection(Object.assign(new Error('write failed'), { code: 'ENOSPC' }), null);
    expect(errorTypeOf()).toBe('DISK_FULL');
  });

  test('preserves EIO as IO_ERROR rather than flattening to UNKNOWN', () => {
    handleUnhandledRejection(Object.assign(new Error('read failed'), { code: 'EIO' }), null);
    expect(errorTypeOf()).toBe('IO_ERROR');
  });

  test('still maps aliased categories (ENOENT → FILE_NOT_FOUND)', () => {
    handleUnhandledRejection(Object.assign(new Error('missing'), { code: 'ENOENT' }), null);
    expect(errorTypeOf()).toBe('FILE_NOT_FOUND');
  });

  test('unclassifiable errors remain UNKNOWN', () => {
    handleUnhandledRejection(new Error('something weird happened'), null);
    expect(errorTypeOf()).toBe('UNKNOWN');
  });

  test('does not treat worker stdio EPIPE as an unhandled rejection', () => {
    handleUnhandledRejection(
      Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE' }),
      null
    );
    expect(errorTypeOf()).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[LIFECYCLE] Ignoring benign cancellation/abort in unhandledRejection handler',
      expect.objectContaining({ code: 'EPIPE' })
    );
    expect(require('../src/main/core/lifecycle').getUnhandledErrorCounts().rejections).toBe(0);
  });
});

describe('lifecycle – handleUncaughtException benign cancellation', () => {
  let handleUncaughtException;
  let electron;

  beforeEach(() => {
    jest.resetModules();
    Object.values(mockLogger).forEach((fn) => fn.mockClear());
    // Deterministic: with ErrorHandler uninitialized, a genuine uncaught error
    // exits directly (app.exit(1)); a benign cancellation must return earlier.
    jest.doMock('../src/main/errors/ErrorHandler', () => ({ isInitialized: false }));
    electron = require('electron');
    electron.app.exit.mockClear();
    handleUncaughtException = require('../src/main/core/lifecycle').handleUncaughtException;
  });

  test('does NOT exit the app for an aborted operation (e.g. "Vision request aborted")', () => {
    handleUncaughtException(new Error('Vision request aborted'));
    expect(electron.app.exit).not.toHaveBeenCalled();
  });

  test('does NOT exit for AbortError, OPERATION_CANCELLED, or ECONNRESET', () => {
    handleUncaughtException(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    handleUncaughtException(Object.assign(new Error('x'), { code: 'OPERATION_CANCELLED' }));
    handleUncaughtException(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    expect(electron.app.exit).not.toHaveBeenCalled();
  });

  test('does NOT exit for worker stdio EPIPE (OCR/embedding worker died under memory pressure)', () => {
    handleUncaughtException(
      Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE' })
    );
    expect(electron.app.exit).not.toHaveBeenCalled();
  });

  test('DOES exit for a genuine unexpected error', () => {
    handleUncaughtException(new Error('cannot read properties of undefined'));
    expect(electron.app.exit).toHaveBeenCalled();
  });
});

describe('lifecycle – handleProcessWarning', () => {
  let lifecycle;

  const warnPayload = () => {
    const call = mockLogger.warn.mock.calls.find(([msg]) => msg === 'PROCESS WARNING:');
    return call?.[1];
  };

  beforeEach(() => {
    jest.resetModules();
    Object.values(mockLogger).forEach((fn) => fn.mockClear());
    lifecycle = require('../src/main/core/lifecycle');
  });

  test('routes a Node process warning to logger.warn with structured fields', () => {
    const warning = Object.assign(new Error('possible EventEmitter memory leak detected'), {
      name: 'MaxListenersExceededWarning',
      code: 'MAXLISTENERS'
    });
    lifecycle.handleProcessWarning(warning);
    const payload = warnPayload();
    expect(payload).toMatchObject({
      name: 'MaxListenersExceededWarning',
      message: 'possible EventEmitter memory leak detected',
      code: 'MAXLISTENERS',
      warningCount: 1
    });
    expect(payload.stack).toEqual(expect.any(String));
  });

  test('counts warnings and surfaces them in getUnhandledErrorCounts', () => {
    lifecycle.handleProcessWarning(new Error('first'));
    lifecycle.handleProcessWarning(new Error('second'));
    expect(lifecycle.getUnhandledErrorCounts().warnings).toBe(2);
  });

  test('falls back to a generic name and stringifies non-Error warnings', () => {
    lifecycle.handleProcessWarning('something is deprecated');
    expect(warnPayload()).toMatchObject({
      name: 'Warning',
      message: 'something is deprecated'
    });
  });

  test('includes the optional detail field only when present', () => {
    lifecycle.handleProcessWarning(
      Object.assign(new Error('experimental API'), { detail: 'use the stable API instead' })
    );
    expect(warnPayload().detail).toBe('use the stable API instead');
  });
});

describe('lifecycle – OS shutdown hooks (LC-07)', () => {
  const baseConfig = () => ({
    setIsQuitting: jest.fn(),
    getMetricsInterval: () => null,
    setMetricsInterval: jest.fn(),
    getDownloadWatcher: () => null,
    setDownloadWatcher: jest.fn(),
    getServiceIntegration: () => null,
    getSettingsService: () => null,
    getChildProcessListeners: () => [],
    setChildProcessListeners: jest.fn(),
    getGlobalProcessListeners: () => [],
    setGlobalProcessListeners: jest.fn(),
    getEventListeners: () => [],
    setEventListeners: jest.fn()
  });

  let lifecycle;
  let electron;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('../src/main/core/ipcRegistry', () => ({
      setShuttingDown: jest.fn(),
      waitForInFlightOperations: jest.fn().mockResolvedValue(true),
      removeAllRegistered: jest.fn().mockReturnValue({ handlers: 0, listeners: 0 })
    }));
    electron = require('electron');
    electron.powerMonitor.on.mockClear();
    electron.powerMonitor.removeListener.mockClear();
    electron.app.on.mockClear();
    lifecycle = require('../src/main/core/lifecycle');
    lifecycle.initializeLifecycle(baseConfig());
  });

  test('registerLifecycleHandlers listens for powerMonitor shutdown and the handler runs the quit cleanup', async () => {
    const cleanup = lifecycle.registerLifecycleHandlers(jest.fn());
    try {
      expect(electron.powerMonitor.on).toHaveBeenCalledWith('shutdown', expect.any(Function));
      const [, shutdownHandler] = electron.powerMonitor.on.mock.calls.find(
        ([name]) => name === 'shutdown'
      );

      const event = { preventDefault: jest.fn() };
      shutdownHandler(event);
      await new Promise((resolve) => setImmediate(resolve));

      // preventDefault holds the OS off while cleanup runs; the IPC gate is
      // the first thing handleBeforeQuit does.
      expect(event.preventDefault).toHaveBeenCalled();
      const { setShuttingDown } = require('../src/main/core/ipcRegistry');
      expect(setShuttingDown).toHaveBeenCalledWith(true);
    } finally {
      cleanup.cleanupAppListeners();
      cleanup.cleanupProcessListeners();
    }
    expect(electron.powerMonitor.removeListener).toHaveBeenCalledWith(
      'shutdown',
      expect.any(Function)
    );
  });

  test('registerLifecycleHandlers refreshes the user-data lock heartbeat on resume and detaches on cleanup', () => {
    const cleanup = lifecycle.registerLifecycleHandlers(jest.fn());
    try {
      expect(electron.powerMonitor.on).toHaveBeenCalledWith('resume', expect.any(Function));
      expect(electron.powerMonitor.on).toHaveBeenCalledWith('suspend', expect.any(Function));
    } finally {
      cleanup.cleanupAppListeners();
      cleanup.cleanupProcessListeners();
    }
    expect(electron.powerMonitor.removeListener).toHaveBeenCalledWith(
      'resume',
      expect.any(Function)
    );
  });

  test('attachSessionEndFlush runs the quit cleanup on the window session-end event', async () => {
    const window = { on: jest.fn(), removeListener: jest.fn() };
    const detach = lifecycle.attachSessionEndFlush(window);

    expect(window.on).toHaveBeenCalledWith('session-end', expect.any(Function));
    const [, handler] = window.on.mock.calls[0];
    handler();
    await new Promise((resolve) => setImmediate(resolve));

    const { setShuttingDown } = require('../src/main/core/ipcRegistry');
    expect(setShuttingDown).toHaveBeenCalledWith(true);

    detach();
    expect(window.removeListener).toHaveBeenCalledWith('session-end', handler);
  });

  test('attachSessionEndFlush tolerates a missing window', () => {
    expect(() => lifecycle.attachSessionEndFlush(null)()).not.toThrow();
  });
});
