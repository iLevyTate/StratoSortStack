/**
 * "Install now" on Windows must not start the NSIS installer before shutdown
 * cleanup: in update mode the installer force-kills the running app about 2 s
 * after launch, which cut off handleBeforeQuit (Orama final persist, hash-cache
 * flush, lock release). quitAndInstall() now only quits; lifecycle starts the
 * installer through runPendingInstallOnExit() at its exit site.
 */

const ORIGINAL_PLATFORM = process.platform;

jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

const mockApp = { isPackaged: false, quit: jest.fn() };

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: mockApp
}));

// Shape of electron-updater's BaseUpdater (NsisUpdater): install() and the
// installerPath getter exist alongside quitAndInstall().
const mockUpdater = {
  on: jest.fn(),
  removeListener: jest.fn(),
  quitAndInstall: jest.fn(),
  install: jest.fn(() => true),
  installerPath: /** @type {string|null} */ ('C:\\updates\\installer.exe')
};

jest.mock('electron-updater', () => ({ autoUpdater: mockUpdater }));

jest.mock('../src/main/ipc/ipcWrappers', () => ({ safeSend: jest.fn() }));

const setPlatform = (value) =>
  Object.defineProperty(process, 'platform', { value, configurable: true });

const flushImmediate = () => new Promise((resolve) => setImmediate(resolve));

describe('autoUpdater – install deferred to the exit site', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.STRATOSORT_ENABLE_AUTO_UPDATES = 'true';
    mockApp.quit.mockClear();
    mockUpdater.quitAndInstall.mockClear();
    mockUpdater.install.mockClear();
    mockUpdater.install.mockImplementation(() => true);
    mockUpdater.installerPath = 'C:\\updates\\installer.exe';
    setPlatform('win32');
  });

  afterEach(() => {
    setPlatform(ORIGINAL_PLATFORM);
    delete process.env.STRATOSORT_ENABLE_AUTO_UPDATES;
  });

  test('on Windows, Install now quits without spawning the installer', async () => {
    const { quitAndInstall } = require('../src/main/core/autoUpdater');

    expect(quitAndInstall()).toEqual({ success: true });
    await flushImmediate();

    expect(mockApp.quit).toHaveBeenCalledTimes(1);
    expect(mockUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(mockUpdater.install).not.toHaveBeenCalled();
  });

  test('the exit site starts the visible, relaunching installer exactly once', async () => {
    const { quitAndInstall, runPendingInstallOnExit } = require('../src/main/core/autoUpdater');

    quitAndInstall();
    await flushImmediate();

    expect(runPendingInstallOnExit()).toBe(true);
    expect(mockUpdater.install).toHaveBeenCalledTimes(1);
    expect(mockUpdater.install).toHaveBeenCalledWith(false, true);

    // A second exit-site call must not spawn a second installer.
    expect(runPendingInstallOnExit()).toBe(false);
    expect(mockUpdater.install).toHaveBeenCalledTimes(1);
  });

  test('an ordinary quit does not start the installer from the exit site', () => {
    const { runPendingInstallOnExit } = require('../src/main/core/autoUpdater');

    expect(runPendingInstallOnExit()).toBe(false);
    expect(mockUpdater.install).not.toHaveBeenCalled();
  });

  test('with nothing downloaded, Install now reports an error and does not quit', async () => {
    mockUpdater.installerPath = null;
    const { quitAndInstall, runPendingInstallOnExit } = require('../src/main/core/autoUpdater');

    expect(quitAndInstall()).toEqual({
      success: false,
      error: 'No downloaded update available yet. Check for updates and finish download first.'
    });
    await flushImmediate();

    expect(mockApp.quit).not.toHaveBeenCalled();
    expect(runPendingInstallOnExit()).toBe(false);
    expect(mockUpdater.install).not.toHaveBeenCalled();
  });

  test('an installer that throws at the exit site does not block the exit', async () => {
    mockUpdater.install.mockImplementation(() => {
      throw new Error('spawn failed');
    });
    const { quitAndInstall, runPendingInstallOnExit } = require('../src/main/core/autoUpdater');

    quitAndInstall();
    await flushImmediate();

    expect(runPendingInstallOnExit()).toBe(false);
  });

  test('macOS keeps electron-updater quitAndInstall (Squirrel installs after exit)', async () => {
    setPlatform('darwin');
    const { quitAndInstall, runPendingInstallOnExit } = require('../src/main/core/autoUpdater');

    expect(quitAndInstall()).toEqual({ success: true });
    await flushImmediate();

    expect(mockUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(mockApp.quit).not.toHaveBeenCalled();
    expect(runPendingInstallOnExit()).toBe(false);
  });
});
