/**
 * Tests for createWindow
 * Tests application window initialization
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
    getPath: jest.fn(() => require('path').join(process.cwd(), 'mock-user-data'))
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

describe('createWindow', () => {
  let createMainWindow;
  let BrowserWindow;
  let windowStateKeeper;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    BrowserWindow = require('electron').BrowserWindow;
    windowStateKeeper = require('electron-window-state');
    createMainWindow = require('../src/main/core/createWindow');
  });

  describe('window creation', () => {
    test('creates BrowserWindow with correct dimensions', () => {
      createMainWindow();

      expect(BrowserWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          width: 1440,
          height: 900,
          minWidth: 800,
          minHeight: 600
        })
      );
    });

    test('creates window with light theme (default)', () => {
      createMainWindow();

      expect(BrowserWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          backgroundColor: '#0f1820',
          darkTheme: false
        })
      );
    });

    test('creates window with show:false initially', () => {
      createMainWindow();

      expect(BrowserWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          show: false
        })
      );
    });

    describe('persisted theme background (U-002)', () => {
      const writeThemeFile = (content) => {
        // memfs mock: plant the file the window:set-theme-background handler
        // would have persisted on a previous run.
        const fs = require('fs');
        const path = require('path');
        const userData = path.join(process.cwd(), 'mock-user-data');
        fs.mkdirSync(userData, { recursive: true });
        fs.writeFileSync(path.join(userData, 'theme-background.json'), content);
      };

      test('native background matches the persisted light theme', () => {
        writeThemeFile(JSON.stringify({ theme: 'light' }));
        createMainWindow();

        expect(BrowserWindow).toHaveBeenCalledWith(
          expect.objectContaining({ backgroundColor: '#eef2f6' })
        );
      });

      test('native background matches the persisted dark theme', () => {
        writeThemeFile(JSON.stringify({ theme: 'dark' }));
        createMainWindow();

        expect(BrowserWindow).toHaveBeenCalledWith(
          expect.objectContaining({ backgroundColor: '#0a0c0e' })
        );
      });

      test('corrupt persistence falls back to the primary surface', () => {
        writeThemeFile('{not json');
        createMainWindow();

        expect(BrowserWindow).toHaveBeenCalledWith(
          expect.objectContaining({ backgroundColor: '#0f1820' })
        );
      });
    });

    test('uses window state from windowStateKeeper', () => {
      windowStateKeeper.mockReturnValue({
        x: 200,
        y: 300,
        width: 1600,
        height: 700,
        manage: jest.fn(),
        unmanage: jest.fn()
      });

      createMainWindow();

      expect(BrowserWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          x: 200,
          y: 300,
          width: 1600,
          height: 700
        })
      );
    });

    test('clamps oversized restored bounds before applying maximized state', () => {
      const electron = require('electron');
      electron.screen.getPrimaryDisplay.mockReturnValue({
        workArea: { x: 0, y: 0, width: 1280, height: 800 },
        workAreaSize: { width: 1280, height: 800 },
        bounds: { x: 0, y: 0, width: 1280, height: 800 },
        scaleFactor: 1
      });
      electron.screen.getDisplayMatching.mockReturnValue({
        workArea: { x: 0, y: 0, width: 1280, height: 800 },
        workAreaSize: { width: 1280, height: 800 },
        bounds: { x: 0, y: 0, width: 1280, height: 800 },
        scaleFactor: 1
      });
      windowStateKeeper.mockReturnValue({
        x: 0,
        y: 0,
        width: 1400,
        height: 900,
        isMaximized: true,
        isFullScreen: false,
        manage: jest.fn(),
        unmanage: jest.fn()
      });

      const win = createMainWindow();

      expect(BrowserWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          x: 0,
          y: 0,
          width: 1280,
          height: 800
        })
      );
      expect(win.maximize).toHaveBeenCalled();
    });
  });

  describe('webPreferences security', () => {
    test('disables nodeIntegration', () => {
      createMainWindow();

      const options = BrowserWindow.mock.calls[0][0];
      expect(options.webPreferences.nodeIntegration).toBe(false);
    });

    test('enables contextIsolation', () => {
      createMainWindow();

      const options = BrowserWindow.mock.calls[0][0];
      expect(options.webPreferences.contextIsolation).toBe(true);
    });

    test('enables webSecurity', () => {
      createMainWindow();

      const options = BrowserWindow.mock.calls[0][0];
      expect(options.webPreferences.webSecurity).toBe(true);
    });

    test('keeps the spellchecker off (its dictionaries come from a Google CDN)', () => {
      createMainWindow();

      const options = BrowserWindow.mock.calls[0][0];
      // docs/NETWORK_TRANSPARENCY.md: no outbound requests without a cloud
      // provider; Chromium would fetch Hunspell dictionaries on Windows/Linux.
      expect(options.webPreferences.spellcheck).toBe(false);
    });

    test('does not enable remote module (removed in Electron 40+)', () => {
      createMainWindow();

      const options = BrowserWindow.mock.calls[0][0];
      // enableRemoteModule was removed from Electron 40+ (always false).
      // Verify it is not explicitly set to true.
      expect(options.webPreferences.enableRemoteModule).not.toBe(true);
    });

    test('disables webviewTag', () => {
      createMainWindow();

      const options = BrowserWindow.mock.calls[0][0];
      expect(options.webPreferences.webviewTag).toBe(false);
    });

    test('sets preload script path', () => {
      createMainWindow();

      const options = BrowserWindow.mock.calls[0][0];
      expect(options.webPreferences.preload).toContain('preload.js');
    });
  });

  describe('window state management', () => {
    test('calls windowStateKeeper.manage', () => {
      const manage = jest.fn();
      windowStateKeeper.mockReturnValue({
        x: 100,
        y: 100,
        width: 1440,
        height: 900,
        manage,
        unmanage: jest.fn()
      });

      const win = createMainWindow();

      expect(manage).toHaveBeenCalledWith(win);
    });

    test('registers closed event for unmanage', () => {
      const win = createMainWindow();

      expect(win.once).toHaveBeenCalledWith('closed', expect.any(Function));
    });
  });

  describe('content loading', () => {
    test('schedules content loading', () => {
      jest.useFakeTimers();

      const win = createMainWindow();

      jest.advanceTimersByTime(200);

      expect(win.loadURL).toHaveBeenCalled();

      jest.useRealTimers();
    });
  });

  describe('security headers', () => {
    test('sets up onHeadersReceived handler', () => {
      const win = createMainWindow();

      expect(win.webContents.session.webRequest.onHeadersReceived).toHaveBeenCalled();
    });

    test('sets CSP header in response', () => {
      const win = createMainWindow();

      const callback = win.webContents.session.webRequest.onHeadersReceived.mock.calls[0][0];

      const mockCallback = jest.fn();
      callback({ responseHeaders: {} }, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          responseHeaders: expect.objectContaining({
            'Content-Security-Policy': expect.any(Array),
            'X-Content-Type-Options': ['nosniff'],
            'X-Frame-Options': ['DENY']
          })
        })
      );
    });

    test('CSP directives shape is a snapshot — adding new fetch types must come here first', () => {
      // This test pins the exact set of CSP fetch directives currently emitted
      // so that any silent change (a renderer dependency that needs a new
      // directive — e.g. <video> playback needing media-src, or a worker
      // needing worker-src) fails this check loudly and forces a security
      // review instead of being noticed only when the feature breaks at
      // runtime.
      //
      // Note: PR #182 added backend audio/video analysis (transcription,
      // keyframe extraction). Today the renderer does NOT render <audio>
      // or <video> elements, so media-src is intentionally absent — a
      // missing directive falls back to default-src 'self', which would
      // block file:// playback. If a future PR adds an in-app preview
      // player, this assertion will fail; the fix is to add
      //   media-src 'self' file: blob:
      // to createWindow.js and update the expected list below.
      const win = createMainWindow();
      const callback = win.webContents.session.webRequest.onHeadersReceived.mock.calls[0][0];
      const mockCallback = jest.fn();
      callback({ responseHeaders: {} }, mockCallback);

      const csp = mockCallback.mock.calls[0][0].responseHeaders['Content-Security-Policy'][0];
      const directiveNames = csp
        .split(';')
        .map((part) => part.trim().split(/\s+/)[0])
        .filter(Boolean)
        .sort();

      expect(directiveNames).toEqual([
        'base-uri',
        'connect-src',
        'default-src',
        'font-src',
        'form-action',
        'img-src',
        'object-src',
        'script-src',
        // S-1: the blanket style-src split into elem (hash-allowlisted in
        // prod) + attr (unsafe-inline; attributes cannot be hashed and carry
        // no selector-based exfiltration surface).
        'style-src-attr',
        'style-src-elem'
      ]);
      // Hardening invariants that should never quietly regress.
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("object-src 'none'");
      // No media-src yet — see comment above. If this changes, update both
      // the directive list AND this expectation.
      expect(csp).not.toContain('media-src');
    });
  });

  describe('ready-to-show event', () => {
    test('registers ready-to-show handler', () => {
      const win = createMainWindow();

      expect(win.once).toHaveBeenCalledWith('ready-to-show', expect.any(Function));
    });

    test('shows and focuses window when ready', () => {
      jest.useFakeTimers();

      const win = createMainWindow();

      // Find and call the ready-to-show handler
      const readyToShowCall = win.once.mock.calls.find((call) => call[0] === 'ready-to-show');
      const readyToShowHandler = readyToShowCall[1];

      readyToShowHandler();

      jest.advanceTimersByTime(200);

      expect(win.show).toHaveBeenCalled();
      expect(win.focus).toHaveBeenCalled();

      jest.useRealTimers();
    });
  });

  describe('navigation security', () => {
    test('blocks in-app navigation', () => {
      const win = createMainWindow();

      const navigateCall = win.webContents.on.mock.calls.find(
        (call) => call[0] === 'will-navigate'
      );
      const navigateHandler = navigateCall[1];

      const mockEvent = { preventDefault: jest.fn() };
      navigateHandler(mockEvent, 'https://malicious.com');

      expect(mockEvent.preventDefault).toHaveBeenCalled();
    });

    test('blocks webview attachment', () => {
      const win = createMainWindow();

      const attachCall = win.webContents.on.mock.calls.find(
        (call) => call[0] === 'will-attach-webview'
      );
      const attachHandler = attachCall[1];

      const mockEvent = { preventDefault: jest.fn() };
      attachHandler(mockEvent);

      expect(mockEvent.preventDefault).toHaveBeenCalled();
    });
  });

  describe('external link handling', () => {
    test('sets window open handler', () => {
      const win = createMainWindow();

      expect(win.webContents.setWindowOpenHandler).toHaveBeenCalled();
    });

    test('allows opening allowed domains externally', () => {
      const shell = require('electron').shell;
      const win = createMainWindow();

      const handlerConfig = win.webContents.setWindowOpenHandler.mock.calls[0][0];
      const result = handlerConfig({ url: 'https://github.com/test' });

      expect(shell.openExternal).toHaveBeenCalledWith('https://github.com/test');
      expect(result).toEqual({ action: 'deny' });
    });

    test('blocks opening non-allowed domains', () => {
      const shell = require('electron').shell;
      shell.openExternal.mockClear();

      const win = createMainWindow();

      const handlerConfig = win.webContents.setWindowOpenHandler.mock.calls[0][0];
      handlerConfig({ url: 'https://malicious.com' });

      expect(shell.openExternal).not.toHaveBeenCalled();
    });
  });

  describe('permission requests', () => {
    test('sets permission request handler', () => {
      const win = createMainWindow();

      expect(win.webContents.session.setPermissionRequestHandler).toHaveBeenCalled();
    });

    test('denies all permission requests', () => {
      const win = createMainWindow();

      const handler = win.webContents.session.setPermissionRequestHandler.mock.calls[0][0];

      const mockCallback = jest.fn();
      handler({}, 'camera', mockCallback);

      expect(mockCallback).toHaveBeenCalledWith(false);
    });

    test('denied permission requests log at warn level with permission and URL', () => {
      // Regression guard: prior to this fix, denials logged at debug level
      // — invisible at production log levels. A future renderer dependency
      // requesting a new permission type would get silently denied with no
      // breadcrumb. Permission denials are rare enough that warn-level
      // visibility is appropriate.
      const { logger } = require('../src/shared/logger');
      const callsBefore = logger.warn.mock.calls.length;

      const win = createMainWindow();
      const handler = win.webContents.session.setPermissionRequestHandler.mock.calls[0][0];
      const mockWebContents = { getURL: jest.fn(() => 'file:///path/to/index.html') };
      handler(mockWebContents, 'notifications', jest.fn());

      const newWarnCalls = logger.warn.mock.calls.slice(callsBefore);
      const denyCall = newWarnCalls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('Denied permission request')
      );
      expect(denyCall).toBeTruthy();
      expect(denyCall[1]).toMatchObject({
        permission: 'notifications',
        requestingURL: 'file:///path/to/index.html'
      });
    });

    test('clipboard permissions are NOT logged (allow path is silent)', () => {
      // Companion: clipboard read/write are explicitly allowed without
      // logging because they're frequent and benign. The deny path is
      // the only one that should generate noise.
      const { logger } = require('../src/shared/logger');
      logger.warn.mockClear();

      const win = createMainWindow();
      const handler = win.webContents.session.setPermissionRequestHandler.mock.calls[0][0];
      handler({ getURL: jest.fn(() => 'file:///x') }, 'clipboard-read', jest.fn());
      handler({ getURL: jest.fn(() => 'file:///x') }, 'clipboard-sanitized-write', jest.fn());

      const denyCalls = logger.warn.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('Denied permission request')
      );
      expect(denyCalls).toHaveLength(0);
    });
  });

  describe('AppUserModelId', () => {
    test('sets AppUserModelId on Windows', () => {
      const app = require('electron').app;
      const originalIsPackaged = app.isPackaged;
      const originalResourcesPath = process.resourcesPath;
      app.isPackaged = true;
      process.resourcesPath = '/mock/resources';

      createMainWindow();

      expect(app.setAppUserModelId).toHaveBeenCalledWith('com.stratosort.app');

      app.isPackaged = originalIsPackaged;
      process.resourcesPath = originalResourcesPath;
    });
  });

  describe('devTools security (Fix 4 regression)', () => {
    test('devTools disabled in production when app is not in dev mode', () => {
      createMainWindow();

      const options = BrowserWindow.mock.calls[0][0];
      // Default mocks: isDevelopment()=false, getEnvBool()=false, app.isPackaged=false
      expect(options.webPreferences.devTools).toBe(false);
    });

    test('devTools blocked in packaged builds even with FORCE_DEV_TOOLS=true', () => {
      jest.resetModules();

      const { isDevelopment, getEnvBool } = require('../src/shared/configDefaults');
      isDevelopment.mockReturnValue(false);
      getEnvBool.mockImplementation((key) => key === 'FORCE_DEV_TOOLS');

      const electronMock = require('electron');
      electronMock.app.isPackaged = true;

      // In packaged builds, process.resourcesPath is set by Electron
      const originalResourcesPath = process.resourcesPath;
      process.resourcesPath = '/mock/resources';

      try {
        const freshCreateMainWindow = require('../src/main/core/createWindow');
        freshCreateMainWindow();

        const options = electronMock.BrowserWindow.mock.calls[0][0];
        // isDev=false, app.isPackaged=true → !true && true = false
        expect(options.webPreferences.devTools).toBe(false);
      } finally {
        // Restore for other tests
        electronMock.app.isPackaged = false;
        process.resourcesPath = originalResourcesPath;
      }
    });

    test('devTools enabled via FORCE_DEV_TOOLS in unpackaged builds', () => {
      jest.resetModules();

      const { isDevelopment, getEnvBool } = require('../src/shared/configDefaults');
      isDevelopment.mockReturnValue(false);
      getEnvBool.mockImplementation((key) => key === 'FORCE_DEV_TOOLS');

      const electronMock = require('electron');
      electronMock.app.isPackaged = false;

      const freshCreateMainWindow = require('../src/main/core/createWindow');
      freshCreateMainWindow();

      const options = electronMock.BrowserWindow.mock.calls[0][0];
      // isDev=false, app.isPackaged=false → !false && true = true
      expect(options.webPreferences.devTools).toBe(true);
    });

    test('opens devTools when FORCE_DEV_TOOLS is true', () => {
      // Reset modules to get fresh imports with new mock values
      jest.resetModules();

      // Set up the mocks BEFORE requiring createMainWindow
      const { isDevelopment, getEnvBool } = require('../src/shared/configDefaults');
      isDevelopment.mockReturnValue(true);
      getEnvBool.mockImplementation((key) => key === 'USE_DEV_SERVER' || key === 'FORCE_DEV_TOOLS');

      // Store ready-to-show callback so we can trigger it
      let readyToShowCallback = null;
      const { BrowserWindow: MockBrowserWindow } = require('electron');
      MockBrowserWindow.mockImplementation(() => ({
        loadURL: jest.fn().mockResolvedValue(),
        loadFile: jest.fn().mockResolvedValue(),
        once: jest.fn((event, cb) => {
          if (event === 'ready-to-show') {
            readyToShowCallback = cb;
          }
        }),
        on: jest.fn(),
        show: jest.fn(),
        focus: jest.fn(),
        isDestroyed: jest.fn().mockReturnValue(false),
        isVisible: jest.fn().mockReturnValue(true),
        isFocused: jest.fn().mockReturnValue(true),
        isMinimized: jest.fn().mockReturnValue(false),
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
      }));

      // Now require createMainWindow with the updated mocks
      const freshCreateMainWindow = require('../src/main/core/createWindow');

      jest.useFakeTimers();

      const win = freshCreateMainWindow();

      // Advance timers to trigger loadContent
      jest.advanceTimersByTime(100);

      // Trigger the ready-to-show event
      if (readyToShowCallback) {
        readyToShowCallback();
      }

      // Advance timers past the nested setTimeout delays (100ms + 50ms)
      jest.advanceTimersByTime(200);

      expect(win.webContents.openDevTools).toHaveBeenCalled();

      jest.useRealTimers();
    });

    test('does not auto-open DevTools when STRATOSORT_E2E is set', () => {
      jest.resetModules();

      const { isDevelopment, getEnvBool } = require('../src/shared/configDefaults');
      isDevelopment.mockReturnValue(true);
      getEnvBool.mockImplementation((key) => key === 'STRATOSORT_E2E' || key === 'USE_DEV_SERVER');

      let readyToShowCallback = null;
      const { BrowserWindow: MockBrowserWindow } = require('electron');
      MockBrowserWindow.mockImplementation(() => ({
        loadURL: jest.fn().mockResolvedValue(),
        loadFile: jest.fn().mockResolvedValue(),
        once: jest.fn((event, cb) => {
          if (event === 'ready-to-show') {
            readyToShowCallback = cb;
          }
        }),
        on: jest.fn(),
        show: jest.fn(),
        focus: jest.fn(),
        isDestroyed: jest.fn().mockReturnValue(false),
        isVisible: jest.fn().mockReturnValue(true),
        isFocused: jest.fn().mockReturnValue(true),
        isMinimized: jest.fn().mockReturnValue(false),
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
      }));

      const freshCreateMainWindow = require('../src/main/core/createWindow');
      jest.useFakeTimers();
      const win = freshCreateMainWindow();
      jest.advanceTimersByTime(100);
      if (readyToShowCallback) {
        readyToShowCallback();
      }
      jest.advanceTimersByTime(200);

      expect(win.webContents.openDevTools).not.toHaveBeenCalled();

      jest.useRealTimers();
    });
  });

  describe('subdomain blocking (Fix 6 regression)', () => {
    test('blocks subdomain of allowed hosts', () => {
      const shell = require('electron').shell;
      shell.openExternal.mockClear();

      const win = createMainWindow();

      const handlerConfig = win.webContents.setWindowOpenHandler.mock.calls[0][0];

      // evil.huggingface.co should NOT match huggingface.co
      handlerConfig({ url: 'https://evil.huggingface.co/phish' });
      expect(shell.openExternal).not.toHaveBeenCalled();

      // sub.github.com should NOT match github.com
      handlerConfig({ url: 'https://sub.github.com/phish' });
      expect(shell.openExternal).not.toHaveBeenCalled();
    });

    test('still allows exact allowed hosts', () => {
      const shell = require('electron').shell;
      shell.openExternal.mockClear();

      const win = createMainWindow();
      const handlerConfig = win.webContents.setWindowOpenHandler.mock.calls[0][0];

      handlerConfig({ url: 'https://github.com/iLevyTate/StratoSortCore' });
      expect(shell.openExternal).toHaveBeenCalledWith(
        'https://github.com/iLevyTate/StratoSortCore'
      );
    });

    test('allows mailto support links', () => {
      const shell = require('electron').shell;
      shell.openExternal.mockClear();

      const win = createMainWindow();
      const handlerConfig = win.webContents.setWindowOpenHandler.mock.calls[0][0];

      handlerConfig({ url: 'mailto:contact@kennedyappliedsciences.com?subject=test' });
      expect(shell.openExternal).toHaveBeenCalledWith(
        'mailto:contact@kennedyappliedsciences.com?subject=test'
      );

      shell.openExternal.mockClear();
      handlerConfig({ url: 'https://huggingface.co/models' });
      expect(shell.openExternal).toHaveBeenCalledWith('https://huggingface.co/models');
    });
  });

  describe('post-load health check', () => {
    let executeJavaScript;
    let mockLogger;

    beforeEach(() => {
      jest.useFakeTimers();
      jest.resetModules();
      jest.clearAllMocks();

      executeJavaScript = jest.fn();
      BrowserWindow = require('electron').BrowserWindow;
      BrowserWindow.mockImplementation(() => ({
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
          executeJavaScript,
          session: {
            webRequest: {
              onHeadersReceived: jest.fn()
            },
            setPermissionRequestHandler: jest.fn()
          }
        }
      }));

      createMainWindow = require('../src/main/core/createWindow');
      mockLogger = require('../src/shared/logger').createLogger();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    const fireDidFinishLoad = () => {
      createMainWindow();
      const win = BrowserWindow.mock.results[0].value;
      const handler = win.webContents.on.mock.calls.find(([evt]) => evt === 'did-finish-load')?.[1];
      expect(handler).toBeDefined();
      handler();
      return win;
    };

    test('retries when splash is present but app is mounted', async () => {
      executeJavaScript
        .mockResolvedValueOnce('NO_SPLASH')
        .mockResolvedValueOnce(
          JSON.stringify({
            splashPresent: true,
            rootChildren: 2,
            hasElectronAPI: true,
            bootErrors: 0
          })
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            splashPresent: false,
            rootChildren: 2,
            hasElectronAPI: true,
            bootErrors: 0
          })
        );

      fireDidFinishLoad();
      await jest.runAllTimersAsync();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('splash still visible, retrying'),
        expect.objectContaining({ attempt: 1 })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('app rendered successfully'),
        expect.objectContaining({ attempt: 2 })
      );
      expect(mockLogger.error).not.toHaveBeenCalledWith(
        expect.stringContaining('app may not have rendered'),
        expect.anything()
      );
    });

    test('errors when root has no children', async () => {
      executeJavaScript.mockResolvedValueOnce('NO_SPLASH').mockResolvedValueOnce(
        JSON.stringify({
          splashPresent: true,
          rootChildren: 0,
          hasElectronAPI: true,
          bootErrors: 0
        })
      );

      fireDidFinishLoad();
      await jest.runAllTimersAsync();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('app may not have rendered'),
        expect.objectContaining({ rootChildren: 0, attempt: 1 })
      );
    });
  });

  describe('renderer crash policy (render-process-gone)', () => {
    const fireGone = (win, details) => {
      const handler = win.webContents.on.mock.calls.find(
        ([evt]) => evt === 'render-process-gone'
      )?.[1];
      expect(handler).toBeDefined();
      handler({}, details);
    };

    let nowSpy;

    beforeEach(() => {
      nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    });

    afterEach(() => {
      nowSpy.mockRestore();
    });

    test('auto-reloads oom/crashed while budget remains, then escalates via handleCriticalError', () => {
      const errorHandler = require('../src/main/errors/ErrorHandler');
      const win = createMainWindow();
      win.webContents.reload = jest.fn();
      win.webContents.id = 7;

      fireGone(win, { reason: 'oom', exitCode: 5 });
      fireGone(win, { reason: 'crashed', exitCode: 5 });
      expect(win.webContents.reload).toHaveBeenCalledTimes(2);
      expect(errorHandler.handleCriticalError).not.toHaveBeenCalled();

      // Third crash inside the window: budget spent — createWindow must escalate
      // itself, since ErrorHandler's app-level listener ignores oom/crashed.
      fireGone(win, { reason: 'crashed', exitCode: 5 });
      expect(win.webContents.reload).toHaveBeenCalledTimes(2);
      expect(errorHandler.handleCriticalError).toHaveBeenCalledTimes(1);
      expect(errorHandler.handleCriticalError).toHaveBeenCalledWith(
        expect.stringMatching(/Renderer Process Crashed.*reason=crashed.*exitCode=5/),
        expect.objectContaining({
          details: expect.objectContaining({ reason: 'crashed' }),
          webContentsId: 7
        })
      );
    });

    test('reload budget resets once the window elapses', () => {
      const errorHandler = require('../src/main/errors/ErrorHandler');
      const win = createMainWindow();
      win.webContents.reload = jest.fn();

      fireGone(win, { reason: 'oom' });
      fireGone(win, { reason: 'oom' });
      fireGone(win, { reason: 'oom' });
      expect(errorHandler.handleCriticalError).toHaveBeenCalledTimes(1);

      nowSpy.mockReturnValue(1_000_000 + 60_001);
      fireGone(win, { reason: 'oom' });
      expect(win.webContents.reload).toHaveBeenCalledTimes(3);
      expect(errorHandler.handleCriticalError).toHaveBeenCalledTimes(1);
    });

    test('non-transient reasons are neither reloaded nor escalated here (ErrorHandler owns them)', () => {
      const errorHandler = require('../src/main/errors/ErrorHandler');
      const win = createMainWindow();
      win.webContents.reload = jest.fn();

      fireGone(win, { reason: 'killed' });
      fireGone(win, { reason: 'abnormal-exit' });
      fireGone(win, { reason: 'launch-failed' });

      expect(win.webContents.reload).not.toHaveBeenCalled();
      expect(errorHandler.handleCriticalError).not.toHaveBeenCalled();
    });
  });

  describe('CSP hardening', () => {
    test('CSP script-src does not contain unsafe-eval', () => {
      const win = createMainWindow();

      const callback = win.webContents.session.webRequest.onHeadersReceived.mock.calls[0][0];
      const mockCallback = jest.fn();
      callback({ responseHeaders: {} }, mockCallback);

      const csp = mockCallback.mock.calls[0][0].responseHeaders['Content-Security-Policy'][0];
      expect(csp).not.toContain('unsafe-eval');
      expect(csp).toContain("script-src 'self'");
    });

    test('CSP includes all required security directives', () => {
      const win = createMainWindow();

      const callback = win.webContents.session.webRequest.onHeadersReceived.mock.calls[0][0];
      const mockCallback = jest.fn();
      callback({ responseHeaders: {} }, mockCallback);

      const headers = mockCallback.mock.calls[0][0].responseHeaders;
      expect(headers['X-Content-Type-Options']).toEqual(['nosniff']);
      expect(headers['X-Frame-Options']).toEqual(['DENY']);
      expect(headers['Referrer-Policy']).toEqual(['no-referrer']);
      expect(headers['Cross-Origin-Opener-Policy']).toEqual(['same-origin']);

      const csp = headers['Content-Security-Policy'][0];
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
    });
  });
});

describe('createWindow.escapeHtml', () => {
  test('escapes markup interpolated into the missing-bundle page', () => {
    const { escapeHtml } = require('../src/main/core/createWindow');
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml('C:\\foo&bar')).toContain('&amp;');
  });
});
