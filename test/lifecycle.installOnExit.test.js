/**
 * A deferred "Install now" must start the installer only after shutdown
 * cleanup and the log flush, right before app.exit(): the NSIS installer
 * force-kills the running app about 2 s after it starts, so starting it any
 * earlier cuts the orderly shutdown short.
 */

jest.mock('electron', () => ({
  app: {
    quit: jest.fn(),
    exit: jest.fn(),
    relaunch: jest.fn(),
    on: jest.fn(),
    removeListener: jest.fn()
  },
  BrowserWindow: { getAllWindows: jest.fn().mockReturnValue([]) },
  ipcMain: { removeHandler: jest.fn(), removeAllListeners: jest.fn() },
  powerMonitor: { on: jest.fn(), removeListener: jest.fn() }
}));

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockShutdownLogging = jest.fn();
const mockRunPendingInstallOnExit = jest.fn();
const mockStartupShutdown = jest.fn();

jest.mock('../src/shared/logger', () => ({
  createLogger: () => mockLogger,
  shutdownLogging: (...args) => mockShutdownLogging(...args)
}));

jest.mock('../src/main/core/autoUpdater', () => ({
  hasPendingDownloadedUpdate: () => true,
  runPendingInstallOnExit: (...args) => mockRunPendingInstallOnExit(...args)
}));

jest.mock('../src/main/core/systemTray', () => ({
  destroyTray: jest.fn(),
  getTray: jest.fn().mockReturnValue(null),
  unregisterGlobalShortcuts: jest.fn()
}));

jest.mock('../src/main/services/startup', () => ({
  getStartupManager: jest.fn(() => ({ shutdown: (...args) => mockStartupShutdown(...args) }))
}));

jest.mock('../src/main/core/systemAnalytics', () => ({ destroy: jest.fn() }));

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
  removeAllRegistered: jest.fn().mockReturnValue({ handlers: 0, listeners: 0 })
}));

jest.mock('../src/main/utils/workerPools', () => ({
  destroyPools: jest.fn().mockResolvedValue(undefined)
}));

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

describe('lifecycle – deferred update install at the exit site', () => {
  let electron;
  let lifecycle;

  beforeEach(() => {
    jest.resetModules();
    mockShutdownLogging.mockReset().mockResolvedValue(undefined);
    mockRunPendingInstallOnExit.mockReset().mockReturnValue(true);
    mockStartupShutdown.mockReset().mockResolvedValue(undefined);
    electron = require('electron');
    electron.app.exit.mockClear();
    electron.app.relaunch.mockClear();
    lifecycle = require('../src/main/core/lifecycle');
    lifecycle.initializeLifecycle(quitConfig());
  });

  test('starts the installer once, after cleanup and the log flush, before app.exit', async () => {
    await lifecycle.handleBeforeQuit();

    expect(mockRunPendingInstallOnExit).toHaveBeenCalledTimes(1);
    const installOrder = mockRunPendingInstallOnExit.mock.invocationCallOrder[0];
    expect(mockStartupShutdown.mock.invocationCallOrder[0]).toBeLessThan(installOrder);
    expect(mockShutdownLogging.mock.invocationCallOrder[0]).toBeLessThan(installOrder);
    expect(electron.app.exit).toHaveBeenCalledTimes(1);
    expect(installOrder).toBeLessThan(electron.app.exit.mock.invocationCallOrder[0]);
    // A pending update still wins over a relaunch.
    expect(electron.app.relaunch).not.toHaveBeenCalled();
  });

  test('an installer that throws still lets the app exit', async () => {
    mockRunPendingInstallOnExit.mockImplementation(() => {
      throw new Error('spawn failed');
    });

    await lifecycle.handleBeforeQuit();

    expect(electron.app.exit).toHaveBeenCalledTimes(1);
  });
});
