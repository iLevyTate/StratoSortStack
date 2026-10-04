/**
 * Centralized Electron Mock
 *
 * Provides standardized mocks for Electron modules.
 * Import this in test files instead of defining mocks inline.
 *
 * Uses a global singleton so that jest.resetModules() in beforeEach does not
 * create fresh jest.fn() instances — tests that capture `dialog` or `ipcMain`
 * at the top of the file and then call resetModules() need the same mock
 * objects to remain stable across module reloads.
 *
 * @example
 * jest.mock('electron', () => require('./mocks/electron'));
 */

// Reuse the singleton across module reloads (jest.resetModules() clears the
// module cache but does not clear globalThis).
if (!globalThis.__electronMockSingleton) {
  const _ipcHandlers = new Map();
  const _mockIpcMain = {
    _handlers: _ipcHandlers,
    handle: jest.fn((channel, handler) => {
      _ipcHandlers.set(channel, handler);
    }),
    on: jest.fn(),
    removeHandler: jest.fn((channel) => {
      _ipcHandlers.delete(channel);
    }),
    removeAllListeners: jest.fn()
  };

  const _mockBrowserWindow = jest.fn().mockImplementation(() => ({
    loadURL: jest.fn(),
    loadFile: jest.fn(),
    on: jest.fn(),
    once: jest.fn(),
    show: jest.fn(),
    hide: jest.fn(),
    close: jest.fn(),
    destroy: jest.fn(),
    isDestroyed: jest.fn(() => false),
    webContents: {
      send: jest.fn(),
      on: jest.fn(),
      openDevTools: jest.fn(),
      closeDevTools: jest.fn()
    }
  }));
  _mockBrowserWindow.getAllWindows = jest.fn(() => []);
  _mockBrowserWindow.getFocusedWindow = jest.fn(() => null);

  globalThis.__electronMockSingleton = {
    ipcMain: _mockIpcMain,
    ipcRenderer: {
      invoke: jest.fn(),
      on: jest.fn(),
      send: jest.fn(),
      removeListener: jest.fn(),
      removeAllListeners: jest.fn()
    },
    app: {
      getPath: jest.fn((name) => {
        const paths = {
          userData: '/mock/userData',
          appData: '/mock/appData',
          temp: '/mock/temp',
          home: '/mock/home',
          documents: '/mock/documents',
          downloads: '/mock/downloads'
        };
        return paths[name] || `/mock/${name}`;
      }),
      getName: jest.fn(() => 'StratoSort Core'),
      getVersion: jest.fn(() => '1.0.0'),
      isPackaged: false,
      quit: jest.fn(),
      exit: jest.fn(),
      on: jest.fn(),
      once: jest.fn(),
      whenReady: jest.fn(() => Promise.resolve())
    },
    dialog: {
      showOpenDialog: jest.fn(() => Promise.resolve({ canceled: false, filePaths: [] })),
      showSaveDialog: jest.fn(() => Promise.resolve({ canceled: false, filePath: '' })),
      showMessageBox: jest.fn(() => Promise.resolve({ response: 0 })),
      showErrorBox: jest.fn()
    },
    shell: {
      openPath: jest.fn(() => Promise.resolve('')),
      openExternal: jest.fn(() => Promise.resolve()),
      showItemInFolder: jest.fn(),
      trashItem: jest.fn(() => Promise.resolve())
    },
    BrowserWindow: _mockBrowserWindow,
    nativeTheme: {
      themeSource: 'system',
      shouldUseDarkColors: false,
      shouldUseHighContrastColors: false,
      shouldUseInvertedColorScheme: false,
      on: jest.fn(),
      off: jest.fn()
    },
    screen: {
      getPrimaryDisplay: jest.fn(() => ({
        workAreaSize: { width: 1920, height: 1080 },
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        scaleFactor: 1
      })),
      getAllDisplays: jest.fn(() => [
        {
          workAreaSize: { width: 1920, height: 1080 },
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          scaleFactor: 1
        }
      ])
    },
    Menu: {
      buildFromTemplate: jest.fn(() => ({
        popup: jest.fn(),
        items: []
      })),
      setApplicationMenu: jest.fn(),
      getApplicationMenu: jest.fn(() => null)
    },
    Notification: jest.fn().mockImplementation(() => ({
      show: jest.fn(),
      close: jest.fn(),
      on: jest.fn()
    })),
    Tray: jest.fn().mockImplementation(() => ({
      setToolTip: jest.fn(),
      setContextMenu: jest.fn(),
      setImage: jest.fn(),
      destroy: jest.fn(),
      on: jest.fn()
    })),
    contextBridge: {
      exposeInMainWorld: jest.fn()
    },
    crashReporter: {
      start: jest.fn(),
      getLastCrashReport: jest.fn(() => null),
      getUploadedReports: jest.fn(() => [])
    },
    globalShortcut: {
      register: jest.fn(() => true),
      unregister: jest.fn(),
      unregisterAll: jest.fn(),
      isRegistered: jest.fn(() => false)
    },
    nativeImage: {
      createFromPath: jest.fn(() => ({ isEmpty: () => false })),
      createFromBuffer: jest.fn(() => ({ isEmpty: () => false })),
      createEmpty: jest.fn(() => ({ isEmpty: () => true }))
    },
    protocol: {
      registerFileProtocol: jest.fn(),
      registerBufferProtocol: jest.fn(),
      interceptFileProtocol: jest.fn(),
      unregisterProtocol: jest.fn(),
      isProtocolRegistered: jest.fn(() => false)
    },
    safeStorage: {
      isEncryptionAvailable: jest.fn(() => false),
      encryptString: jest.fn((s) => Buffer.from(String(s))),
      decryptString: jest.fn((buf) => Buffer.from(buf).toString('utf8'))
    },
    webUtils: {
      getPathForFile: jest.fn((file) => file?.path || file || '')
    }
  };
}

module.exports = globalThis.__electronMockSingleton;
