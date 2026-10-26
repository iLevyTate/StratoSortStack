// Platform guard. The SUT's `getUpdateTargetCapability()` returns `supported:
// false` on linux without `process.env.APPIMAGE` (electron-builder's linux
// updater only handles AppImage). The tests below that assert happy-path
// behavior (setFeedURL invoked, downloadUpdate called, autoDownload set, etc.)
// can't be exercised in that environment because the SUT short-circuits.
// Skip them on unsupported linux; they run on win32, darwin, and AppImage CI.
const SUPPORTS_AUTO_UPDATE = !(process.platform === 'linux' && !process.env.APPIMAGE);
const testIfSupported = SUPPORTS_AUTO_UPDATE ? test : test.skip;

const mockGetAllWindows = jest.fn();
let mockAutoUpdaterHandlers = new Map();

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

const mockElectronApp = { isPackaged: false };

jest.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: (...args) => mockGetAllWindows(...args)
  },
  app: mockElectronApp
}));

const mockAutoUpdater = {
  autoDownload: undefined,
  on: jest.fn((event, handler) => {
    mockAutoUpdaterHandlers.set(event, handler);
  }),
  removeListener: jest.fn(),
  setFeedURL: jest.fn(),
  checkForUpdates: jest.fn().mockResolvedValue(undefined),
  downloadUpdate: jest.fn().mockResolvedValue(undefined),
  quitAndInstall: jest.fn()
};

jest.mock('electron-updater', () => ({
  autoUpdater: mockAutoUpdater
}));

jest.mock('../src/main/ipc/ipcWrappers', () => ({
  safeSend: jest.fn()
}));

describe('autoUpdater', () => {
  beforeEach(() => {
    mockAutoUpdaterHandlers = new Map();
    mockElectronApp.isPackaged = false;
    mockGetAllWindows.mockReset();
    mockAutoUpdater.autoDownload = undefined;
    mockAutoUpdater.on.mockClear();
    mockAutoUpdater.removeListener.mockClear();
    mockAutoUpdater.checkForUpdates.mockClear();
    mockAutoUpdater.downloadUpdate.mockClear();
    mockAutoUpdater.quitAndInstall.mockClear();
    mockAutoUpdater.setFeedURL.mockClear();
    delete process.env.STRATOSORT_ENABLE_AUTO_UPDATES;
    delete process.env.STRATOSORT_UPDATE_FEED_URL;
    delete process.env.STRATOSORT_UPDATE_FEED_ALLOWED_HOSTS;
    const { safeSend } = require('../src/main/ipc/ipcWrappers');
    safeSend.mockClear();
    jest.resetModules();
  });

  test('skips updater initialization when auto-updates are disabled', async () => {
    const { initializeAutoUpdater } = require('../src/main/core/autoUpdater');

    await initializeAutoUpdater(false, jest.fn().mockReturnValue(null));

    expect(mockAutoUpdater.on).not.toHaveBeenCalled();
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  test('manual update checks no-op when auto-updates are disabled', async () => {
    const { checkForUpdates } = require('../src/main/core/autoUpdater');

    const result = await checkForUpdates();

    expect(result).toEqual({ success: true, disabled: true });
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  test('non-packaged build keeps startup update check disabled without env var', async () => {
    mockElectronApp.isPackaged = false;

    const { initializeAutoUpdater } = require('../src/main/core/autoUpdater');
    await initializeAutoUpdater(false, jest.fn().mockReturnValue(null));

    expect(mockAutoUpdater.on).not.toHaveBeenCalled();
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  testIfSupported('packaged build enables the updater by default without env var', async () => {
    mockElectronApp.isPackaged = true;
    mockGetAllWindows.mockReturnValue([]);

    const {
      initializeAutoUpdater,
      __test: { areAutomaticUpdatesEnabled }
    } = require('../src/main/core/autoUpdater');
    await initializeAutoUpdater(false, jest.fn().mockReturnValue(null));

    expect(areAutomaticUpdatesEnabled()).toBe(true);
    expect(mockAutoUpdater.on).toHaveBeenCalled();
  });

  test('STRATOSORT_ENABLE_AUTO_UPDATES=false disables updater even when packaged', async () => {
    process.env.STRATOSORT_ENABLE_AUTO_UPDATES = 'false';
    mockElectronApp.isPackaged = true;

    const { initializeAutoUpdater } = require('../src/main/core/autoUpdater');
    await initializeAutoUpdater(false, jest.fn().mockReturnValue(null));

    expect(mockAutoUpdater.on).not.toHaveBeenCalled();
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  testIfSupported('applies generic feed URL when STRATOSORT_UPDATE_FEED_URL is set', async () => {
    process.env.STRATOSORT_ENABLE_AUTO_UPDATES = 'true';
    process.env.STRATOSORT_UPDATE_FEED_URL = 'https://cdn.example.com/app/win';

    const mockWindow = {
      isDestroyed: jest.fn().mockReturnValue(false),
      webContents: {}
    };
    mockGetAllWindows.mockReturnValue([mockWindow]);

    const { initializeAutoUpdater } = require('../src/main/core/autoUpdater');
    await initializeAutoUpdater(false, jest.fn().mockReturnValue(null));

    expect(mockAutoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://cdn.example.com/app/win/'
    });
  });

  testIfSupported('downloadUpdate invokes electron-updater when auto-updates enabled', async () => {
    process.env.STRATOSORT_ENABLE_AUTO_UPDATES = 'true';
    mockElectronApp.isPackaged = true;
    mockGetAllWindows.mockReturnValue([]);

    const { initializeAutoUpdater, downloadUpdate } = require('../src/main/core/autoUpdater');
    await initializeAutoUpdater(false, jest.fn().mockReturnValue(null));
    mockAutoUpdater.downloadUpdate.mockClear();

    const result = await downloadUpdate();

    expect(result).toEqual({ success: true });
    expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  testIfSupported('downloadUpdate fails fast when updater was never initialized', async () => {
    process.env.STRATOSORT_ENABLE_AUTO_UPDATES = 'true';

    const { downloadUpdate } = require('../src/main/core/autoUpdater');
    const result = await downloadUpdate();

    // No listeners are registered without initialization — downloading
    // would fire progress/downloaded events unheard.
    expect(result.success).toBe(false);
    expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  test('downloadUpdate no-ops when auto-updates are disabled', async () => {
    const { downloadUpdate } = require('../src/main/core/autoUpdater');

    const result = await downloadUpdate();

    expect(result).toEqual({ success: true, disabled: true });
    expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  testIfSupported('manual checkForUpdates applies generic feed URL before checking', async () => {
    process.env.STRATOSORT_ENABLE_AUTO_UPDATES = 'true';
    process.env.STRATOSORT_UPDATE_FEED_URL = 'https://updates.example.com/stratosort/';
    // Keep isPackaged=false: packaged builds additionally require
    // STRATOSORT_UPDATE_FEED_ALLOWED_HOSTS for custom feeds.
    mockGetAllWindows.mockReturnValue([]);

    const { initializeAutoUpdater, checkForUpdates } = require('../src/main/core/autoUpdater');
    await initializeAutoUpdater(false, jest.fn().mockReturnValue(null));
    mockAutoUpdater.setFeedURL.mockClear();
    mockAutoUpdater.checkForUpdates.mockClear();

    await checkForUpdates();

    expect(mockAutoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://updates.example.com/stratosort/'
    });
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalled();
  });

  testIfSupported(
    'manual checkForUpdates fails fast when updater was never initialized',
    async () => {
      process.env.STRATOSORT_ENABLE_AUTO_UPDATES = 'true';

      const { checkForUpdates } = require('../src/main/core/autoUpdater');
      const result = await checkForUpdates();

      expect(result.success).toBe(false);
      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    }
  );

  testIfSupported('sets autoDownload to false (Fix 5 regression)', async () => {
    process.env.STRATOSORT_ENABLE_AUTO_UPDATES = 'true';

    const mockWindow = {
      isDestroyed: jest.fn().mockReturnValue(false),
      webContents: {}
    };
    mockGetAllWindows.mockReturnValue([mockWindow]);

    const { initializeAutoUpdater } = require('../src/main/core/autoUpdater');
    await initializeAutoUpdater(false, jest.fn().mockReturnValue(null));

    // autoDownload must be false to prevent silent unsigned update installation
    expect(mockAutoUpdater.autoDownload).toBe(false);
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  // Regression: a failed initial checkForUpdates() used to just log,
  // leaving the renderer's UpdateIndicator stuck in "checking" forever
  // until the user restarted the app. The error path must push an
  // error status to the renderer via safeSend so the UI can recover.
  testIfSupported(
    'initial update-check failure notifies the renderer with status=error',
    async () => {
      process.env.STRATOSORT_ENABLE_AUTO_UPDATES = 'true';

      const mockWindow = {
        isDestroyed: jest.fn().mockReturnValue(false),
        webContents: {}
      };
      mockGetAllWindows.mockReturnValue([mockWindow]);

      mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(
        Object.assign(new Error('feed unreachable'), { code: 'ENOTFOUND' })
      );

      const { initializeAutoUpdater } = require('../src/main/core/autoUpdater');
      await initializeAutoUpdater(false, jest.fn().mockReturnValue(mockWindow));

      const { safeSend } = require('../src/main/ipc/ipcWrappers');
      expect(safeSend).toHaveBeenCalledWith(
        mockWindow.webContents,
        'app:update',
        expect.objectContaining({
          status: 'error',
          error: 'feed unreachable'
        })
      );
    }
  );

  testIfSupported('falls back to BrowserWindow when getMainWindow returns null', async () => {
    process.env.STRATOSORT_ENABLE_AUTO_UPDATES = 'true';

    const mockWindow = {
      isDestroyed: jest.fn().mockReturnValue(false),
      webContents: {}
    };
    mockGetAllWindows.mockReturnValue([mockWindow]);

    const getMainWindow = jest.fn().mockReturnValue(null);
    const { initializeAutoUpdater } = require('../src/main/core/autoUpdater');

    await initializeAutoUpdater(false, getMainWindow);

    const updateAvailableHandler = mockAutoUpdaterHandlers.get('update-available');
    expect(typeof updateAvailableHandler).toBe('function');

    updateAvailableHandler();

    const { safeSend } = require('../src/main/ipc/ipcWrappers');
    expect(safeSend).toHaveBeenCalledWith(mockWindow.webContents, 'app:update', {
      status: 'available'
    });
  });

  testIfSupported('quitAndInstall returns graceful error when no update filepath exists', () => {
    process.env.STRATOSORT_ENABLE_AUTO_UPDATES = 'true';
    mockAutoUpdater.quitAndInstall.mockImplementation(() => {
      throw new Error("No update filepath provided, can't quit and install");
    });

    const { quitAndInstall } = require('../src/main/core/autoUpdater');
    const result = quitAndInstall();

    expect(result).toEqual({
      success: false,
      error: 'No downloaded update available yet. Check for updates and finish download first.'
    });
  });

  testIfSupported('quitAndInstall succeeds when updater accepts install call', () => {
    process.env.STRATOSORT_ENABLE_AUTO_UPDATES = 'true';
    mockAutoUpdater.quitAndInstall.mockImplementation(() => {});

    const { quitAndInstall } = require('../src/main/core/autoUpdater');
    const result = quitAndInstall();

    expect(result).toEqual({ success: true });
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  // Regression: STRATOSORT_UPDATE_FEED_URL is an attacker-influential env var
  // (anyone who can seed env before Electron starts can steer the updater).
  // The validator MUST fail closed on non-HTTPS, credentialed URLs, and
  // non-allowlisted hosts — falling back to the packaged feed instead of
  // setting an unsafe feed URL.
  describe('STRATOSORT_UPDATE_FEED_URL validation (security regression)', () => {
    test('rejects http:// feed URL; does not call setFeedURL', () => {
      process.env.STRATOSORT_UPDATE_FEED_URL = 'http://cdn.example.com/app/win';
      const {
        __test: { applyCustomUpdateFeedIfConfigured }
      } = require('../src/main/core/autoUpdater');
      applyCustomUpdateFeedIfConfigured();
      expect(mockAutoUpdater.setFeedURL).not.toHaveBeenCalled();
    });

    test('rejects file:// feed URL', () => {
      process.env.STRATOSORT_UPDATE_FEED_URL = 'file:///tmp/updates/';
      const {
        __test: { applyCustomUpdateFeedIfConfigured }
      } = require('../src/main/core/autoUpdater');
      applyCustomUpdateFeedIfConfigured();
      expect(mockAutoUpdater.setFeedURL).not.toHaveBeenCalled();
    });

    test('rejects URL with embedded credentials', () => {
      process.env.STRATOSORT_UPDATE_FEED_URL = 'https://user:pass@cdn.example.com/app/';
      const {
        __test: { applyCustomUpdateFeedIfConfigured }
      } = require('../src/main/core/autoUpdater');
      applyCustomUpdateFeedIfConfigured();
      expect(mockAutoUpdater.setFeedURL).not.toHaveBeenCalled();
    });

    test('rejects host not in STRATOSORT_UPDATE_FEED_ALLOWED_HOSTS when set', () => {
      process.env.STRATOSORT_UPDATE_FEED_URL = 'https://evil.example/app/';
      process.env.STRATOSORT_UPDATE_FEED_ALLOWED_HOSTS = 'cdn.example.com,updates.example.com';
      const {
        __test: { applyCustomUpdateFeedIfConfigured }
      } = require('../src/main/core/autoUpdater');
      applyCustomUpdateFeedIfConfigured();
      expect(mockAutoUpdater.setFeedURL).not.toHaveBeenCalled();
    });

    test('accepts subdomain of allowlisted host', () => {
      process.env.STRATOSORT_UPDATE_FEED_URL = 'https://edge01.cdn.example.com/app/';
      process.env.STRATOSORT_UPDATE_FEED_ALLOWED_HOSTS = 'cdn.example.com';
      const {
        __test: { applyCustomUpdateFeedIfConfigured }
      } = require('../src/main/core/autoUpdater');
      applyCustomUpdateFeedIfConfigured();
      expect(mockAutoUpdater.setFeedURL).toHaveBeenCalledWith({
        provider: 'generic',
        url: 'https://edge01.cdn.example.com/app/'
      });
    });

    test('accepts any HTTPS host when allowlist is unset (opt-in posture)', () => {
      process.env.STRATOSORT_UPDATE_FEED_URL = 'https://cdn.example.com/app';
      const {
        __test: { applyCustomUpdateFeedIfConfigured }
      } = require('../src/main/core/autoUpdater');
      applyCustomUpdateFeedIfConfigured();
      expect(mockAutoUpdater.setFeedURL).toHaveBeenCalledWith({
        provider: 'generic',
        url: 'https://cdn.example.com/app/'
      });
    });

    test('rejects garbage string that is not a valid URL', () => {
      process.env.STRATOSORT_UPDATE_FEED_URL = 'not a url';
      const {
        __test: { applyCustomUpdateFeedIfConfigured }
      } = require('../src/main/core/autoUpdater');
      applyCustomUpdateFeedIfConfigured();
      expect(mockAutoUpdater.setFeedURL).not.toHaveBeenCalled();
    });
  });

  describe('autoUpdateCheck preference (settings toggle)', () => {
    test('layers the user preference on top of the env gate', () => {
      process.env.STRATOSORT_ENABLE_AUTO_UPDATES = 'true';
      const {
        setAutoUpdateCheckEnabled,
        __test: { areAutomaticUpdatesEnabled }
      } = require('../src/main/core/autoUpdater');

      // Defaults to enabled when the env gate is on.
      expect(areAutomaticUpdatesEnabled()).toBe(true);

      // Opting out of background checks disables automatic checks...
      setAutoUpdateCheckEnabled(false);
      expect(areAutomaticUpdatesEnabled()).toBe(false);

      // ...and re-enabling restores them, no restart required.
      setAutoUpdateCheckEnabled(true);
      expect(areAutomaticUpdatesEnabled()).toBe(true);
    });

    test('env gate dominates: preference cannot enable updates when env is off', () => {
      delete process.env.STRATOSORT_ENABLE_AUTO_UPDATES;
      const {
        setAutoUpdateCheckEnabled,
        __test: { areAutomaticUpdatesEnabled }
      } = require('../src/main/core/autoUpdater');

      setAutoUpdateCheckEnabled(true);
      expect(areAutomaticUpdatesEnabled()).toBe(false);
    });
  });
});
