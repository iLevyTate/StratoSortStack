/**
 * The "Open download page" action on the ai.vc-runtime-missing banner calls
 * window.open on Microsoft's Visual C++ Redistributable page. That routes
 * through createWindow's setWindowOpenHandler host allowlist, so the exact
 * host must be allowed — and only the exact host.
 */

// Mock electron modules
jest.mock('electron', () => ({
  BrowserWindow: jest.fn().mockImplementation(() => ({
    loadURL: jest.fn().mockResolvedValue(),
    loadFile: jest.fn().mockResolvedValue(),
    once: jest.fn(),
    on: jest.fn(),
    show: jest.fn(),
    focus: jest.fn(),
    maximize: jest.fn(),
    setFullScreen: jest.fn(),
    isDestroyed: jest.fn().mockReturnValue(false),
    isVisible: jest.fn().mockReturnValue(true),
    isFocused: jest.fn().mockReturnValue(true),
    isMinimized: jest.fn().mockReturnValue(false),
    isMaximized: jest.fn().mockReturnValue(false),
    isFullScreen: jest.fn().mockReturnValue(false),
    webContents: {
      isLoading: jest.fn().mockReturnValue(false),
      once: jest.fn(),
      on: jest.fn(),
      openDevTools: jest.fn(),
      setWindowOpenHandler: jest.fn(),
      session: {
        webRequest: {
          onHeadersReceived: jest.fn()
        },
        setPermissionRequestHandler: jest.fn()
      }
    }
  })),
  shell: {
    openExternal: jest.fn()
  },
  app: {
    setAppUserModelId: jest.fn(),
    isPackaged: false,
    getAppPath: jest.fn(() => process.cwd()),
    getPath: jest.fn(() => require('path').join(process.cwd(), 'mock-user-data')),
    // Compositor diagnostics logged once after the first show.
    getGPUFeatureStatus: jest.fn(() => ({ gpu_compositing: 'enabled', webgl: 'enabled' })),
    getGPUInfo: jest.fn().mockResolvedValue({
      gpuDevice: [
        {
          active: true,
          vendorId: 4318,
          deviceId: 7956,
          driverVendor: 'NVIDIA',
          driverVersion: '560.94'
        }
      ]
    })
  },
  screen: {
    getPrimaryDisplay: jest.fn(() => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      workAreaSize: { width: 1920, height: 1080 },
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      scaleFactor: 1
    })),
    getDisplayMatching: jest.fn(() => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      workAreaSize: { width: 1920, height: 1080 },
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      scaleFactor: 1
    })),
    getAllDisplays: jest.fn(() => [
      {
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
        workAreaSize: { width: 1920, height: 1080 },
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        scaleFactor: 1
      }
    ])
  }
}));

jest.mock('electron-window-state', () =>
  jest.fn().mockReturnValue({
    x: 100,
    y: 100,
    width: 1440,
    height: 900,
    manage: jest.fn(),
    unmanage: jest.fn()
  })
);

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

jest.mock('../src/shared/configDefaults', () => ({
  isDevelopment: jest.fn().mockReturnValue(false),
  getEnvBool: jest.fn().mockReturnValue(false)
}));

jest.mock('../src/main/errors/ErrorHandler', () => ({
  handleCriticalError: jest.fn().mockResolvedValue(undefined)
}));

const { VC_REDIST_DOWNLOAD_PAGE_URL } = require('../src/main/utils/vcRuntimeDetection');

describe('createWindow external link allowlist: VC++ Redistributable page', () => {
  let createMainWindow;
  let shell;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    shell = require('electron').shell;
    createMainWindow = require('../src/main/core/createWindow');
  });

  test('opens the learn.microsoft.com download page externally and denies the in-app window', () => {
    const win = createMainWindow();
    const handler = win.webContents.setWindowOpenHandler.mock.calls[0][0];

    expect(handler({ url: VC_REDIST_DOWNLOAD_PAGE_URL })).toEqual({ action: 'deny' });
    expect(shell.openExternal).toHaveBeenCalledWith(VC_REDIST_DOWNLOAD_PAGE_URL);
  });

  test('does not open look-alike hosts or plain HTTP', () => {
    const win = createMainWindow();
    const handler = win.webContents.setWindowOpenHandler.mock.calls[0][0];

    handler({ url: 'https://learn.microsoft.com.evil.example/vc_redist' });
    handler({ url: 'https://evil.learn.microsoft.com/vc_redist' });
    handler({ url: 'http://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist' });
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});
