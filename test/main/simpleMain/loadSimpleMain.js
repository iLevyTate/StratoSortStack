/**
 * Loads src/main/simple-main.js in isolation for unit tests.
 *
 * simple-main is the main-process entry module: requiring it registers app
 * listeners and takes the user-data lock. This helper must be called from a
 * test file that has already declared the jest.mock() calls below (jest only
 * hoists mocks declared in the test file itself), so it only provides the
 * factories and the bookkeeping:
 *
 *   jest.mock('electron', () => require('./loadSimpleMain').electronMockFactory());
 *   jest.mock('chokidar', () => ({ watch: jest.fn() }));
 *   jest.mock('dotenv', () => ({ config: jest.fn() }));
 *   jest.mock('../../../src/main/core/userDataLock', () =>
 *     require('./loadSimpleMain').userDataLockMockFactory());
 *   jest.mock('../../../src/main/core/createWindow', () =>
 *     require('./loadSimpleMain').createWindowMockFactory());
 *
 * app.whenReady() never resolves, so none of the real startup runs: tests
 * drive the exported helpers and the captured app event handlers directly.
 */
const { EventEmitter } = require('events');

function electronMockFactory() {
  const base = jest.requireActual('../../mocks/electron.js');
  const appEvents = new EventEmitter();
  const app = {
    ...base.app,
    name: 'StratoSort Stack',
    commandLine: {
      appendSwitch: jest.fn(),
      hasSwitch: jest.fn(() => false),
      getSwitchValue: jest.fn(() => '')
    },
    whenReady: jest.fn(() => new Promise(() => {})),
    requestSingleInstanceLock: jest.fn(() => true),
    setAppUserModelId: jest.fn(),
    disableHardwareAcceleration: jest.fn(),
    setPath: jest.fn(),
    on: jest.fn((event, handler) => {
      appEvents.on(event, handler);
      return app;
    }),
    once: jest.fn((event, handler) => {
      appEvents.once(event, handler);
      return app;
    }),
    prependListener: jest.fn((event, handler) => {
      appEvents.prependListener(event, handler);
      return app;
    }),
    removeListener: jest.fn((event, handler) => {
      appEvents.removeListener(event, handler);
      return app;
    }),
    __events: appEvents
  };
  return {
    ...base,
    app,
    protocol: {
      ...(base.protocol || {}),
      registerSchemesAsPrivileged: jest.fn(),
      handle: jest.fn()
    },
    crashReporter: { start: jest.fn() }
  };
}

function userDataLockMockFactory() {
  return {
    acquireUserDataLock: jest.fn(() => ({ acquired: true })),
    releaseUserDataLock: jest.fn(),
    attachUserDataLockPowerMonitor: jest.fn()
  };
}

/** A BrowserWindow stand-in: an EventEmitter with the state simple-main reads. */
function createFakeWindow() {
  const win = new EventEmitter();
  let visible = false;
  win.webContents = Object.assign(new EventEmitter(), {
    isLoading: jest.fn(() => true),
    send: jest.fn(),
    session: {}
  });
  win.isDestroyed = jest.fn(() => false);
  win.isVisible = jest.fn(() => visible);
  win.isMinimized = jest.fn(() => false);
  win.isMaximized = jest.fn(() => false);
  win.isFullScreen = jest.fn(() => false);
  win.show = jest.fn(() => {
    visible = true;
    win.emit('show');
  });
  win.hide = jest.fn(() => {
    visible = false;
  });
  win.focus = jest.fn();
  win.restore = jest.fn();
  win.moveTop = jest.fn();
  win.setAlwaysOnTop = jest.fn();
  win.getBounds = jest.fn(() => ({ x: 0, y: 0, width: 1200, height: 800 }));
  win.setBounds = jest.fn();
  win.center = jest.fn();
  return win;
}

function createWindowMockFactory() {
  const factory = jest.fn(() => {
    const win = createFakeWindow();
    factory.windows.push(win);
    return win;
  });
  factory.windows = [];
  return factory;
}

/**
 * Require simple-main and return its exports plus the captured app events.
 * Process-level listeners it registers (exit, SIGINT, SIGTERM) are removed
 * again by the returned dispose().
 */
function loadSimpleMain() {
  const tracked = ['exit', 'SIGINT', 'SIGTERM'];
  const before = new Map(tracked.map((e) => [e, process.listeners(e)]));
  // process.getSystemVersion is Electron-only; simple-main calls it at load
  // on macOS. Stand it in under plain Node so the suite runs on every OS.
  const addedGetSystemVersion = typeof process.getSystemVersion !== 'function';
  if (addedGetSystemVersion) process.getSystemVersion = () => '15.0.0';
  let mod;
  try {
    mod = require('../../../src/main/simple-main');
  } finally {
    if (addedGetSystemVersion) delete process.getSystemVersion;
  }
  const electron = require('electron');
  const createWindow = require('../../../src/main/core/createWindow');
  const dispose = () => {
    for (const event of tracked) {
      for (const listener of process.listeners(event)) {
        if (!before.get(event).includes(listener)) process.removeListener(event, listener);
      }
    }
    electron.app.__events.removeAllListeners();
  };
  return { mod, app: electron.app, createWindow, dispose };
}

module.exports = {
  electronMockFactory,
  userDataLockMockFactory,
  createWindowMockFactory,
  createFakeWindow,
  loadSimpleMain
};
