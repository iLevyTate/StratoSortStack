/**
 * Automatic update checks on a machine with no network.
 *
 * Offline use is a first-class mode for this privacy-first app. A machine that
 * is simply offline must not get the "Automatic updates are temporarily
 * unavailable" degraded banner (or an error toast) on every launch and every
 * periodic tick; the banner is for an updater that fails while the machine
 * is online (feed down, bad manifest, signature mismatch).
 */

// getUpdateTargetCapability() is unsupported on linux without APPIMAGE.
const SUPPORTS_AUTO_UPDATE = !(process.platform === 'linux' && !process.env.APPIMAGE);
const testIfSupported = SUPPORTS_AUTO_UPDATE ? test : test.skip;

const path = require('path');

const ORIGINAL_EXEC_PATH = process.execPath;

jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    setContext: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

const mockElectronApp = { isPackaged: true };
const mockIsOnline = jest.fn();
const mockGetAllWindows = jest.fn();
let mockAutoUpdaterHandlers = new Map();

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: (...args) => mockGetAllWindows(...args) },
  app: mockElectronApp,
  net: { isOnline: (...args) => mockIsOnline(...args) }
}));

const mockAutoUpdater = {
  autoDownload: undefined,
  on: jest.fn((event, handler) => {
    mockAutoUpdaterHandlers.set(event, handler);
  }),
  removeListener: jest.fn(),
  setFeedURL: jest.fn(),
  checkForUpdates: jest.fn(),
  downloadUpdate: jest.fn(),
  quitAndInstall: jest.fn()
};

jest.mock('electron-updater', () => ({ autoUpdater: mockAutoUpdater }));

jest.mock('../src/main/ipc/ipcWrappers', () => ({ safeSend: jest.fn() }));

describe('autoUpdater while the machine is offline', () => {
  const layoutRoot = path.resolve('/ss-updater-offline-layout');
  const installedExe = path.join(layoutRoot, 'installed', 'StratoSort Stack.exe');
  const mockWindow = { isDestroyed: () => false, webContents: {} };

  function seedInstalledLayout() {
    const fs = require('fs');
    fs.mkdirSync(path.dirname(installedExe), { recursive: true });
    fs.writeFileSync(installedExe, '');
    fs.writeFileSync(path.join(path.dirname(installedExe), 'Uninstall StratoSort Stack.exe'), '');
  }

  function updaterFlags() {
    return require('../src/main/services/DegradedStateTracker')
      .getInstance()
      .list()
      .filter((flag) => flag.code === 'auto-updater.unavailable');
  }

  function sentStatuses() {
    const { safeSend } = require('../src/main/ipc/ipcWrappers');
    return safeSend.mock.calls.map((call) => call[2]?.status);
  }

  afterAll(() => {
    process.execPath = ORIGINAL_EXEC_PATH;
  });

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockAutoUpdaterHandlers = new Map();
    process.execPath = installedExe;
    process.env.STRATOSORT_ENABLE_AUTO_UPDATES = 'true';
    mockGetAllWindows.mockReturnValue([mockWindow]);
    mockIsOnline.mockReturnValue(true);
    mockAutoUpdater.checkForUpdates.mockResolvedValue(undefined);
    seedInstalledLayout();
  });

  afterEach(() => {
    delete process.env.STRATOSORT_ENABLE_AUTO_UPDATES;
    jest.useRealTimers();
    try {
      require('../src/main/core/autoUpdater').cleanupAutoUpdater();
    } catch {
      /* module may not have loaded */
    }
  });

  testIfSupported('skips the startup check and raises no banner when offline', async () => {
    mockIsOnline.mockReturnValue(false);

    const { initializeAutoUpdater } = require('../src/main/core/autoUpdater');
    await initializeAutoUpdater(false, () => mockWindow);

    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(updaterFlags()).toEqual([]);
    expect(sentStatuses()).not.toContain('error');
  });

  testIfSupported('an updater error reported while offline raises no banner', async () => {
    const { initializeAutoUpdater } = require('../src/main/core/autoUpdater');
    await initializeAutoUpdater(false, () => mockWindow);

    // The connection drops later; electron-updater emits 'error' for the
    // failed request.
    mockIsOnline.mockReturnValue(false);
    mockAutoUpdaterHandlers.get('error')(new Error('net::ERR_INTERNET_DISCONNECTED'));

    expect(updaterFlags()).toEqual([]);
  });

  testIfSupported('the periodic check is skipped while offline', async () => {
    jest.useFakeTimers();
    const { initializeAutoUpdater } = require('../src/main/core/autoUpdater');
    await initializeAutoUpdater(false, () => mockWindow);
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    mockIsOnline.mockReturnValue(false);
    jest.advanceTimersByTime(4 * 60 * 60 * 1000);

    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  testIfSupported('a failed check while online still raises the banner', async () => {
    mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(
      Object.assign(new Error('feed unreachable'), { code: 'ENOTFOUND' })
    );

    const { initializeAutoUpdater } = require('../src/main/core/autoUpdater');
    await initializeAutoUpdater(false, () => mockWindow);

    expect(updaterFlags()).toHaveLength(1);
    expect(sentStatuses()).toContain('error');
  });
});
