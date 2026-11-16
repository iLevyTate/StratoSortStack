/**
 * Clicking a tray notification focuses the app and, 100 ms later, tells the
 * renderer which view to open. Each click used to add a once('closed')
 * listener to every window to clear that timer; the main window stays open
 * all session, so the listeners piled up (MaxListenersExceededWarning past
 * ten clicks). The timer is harmless after a close: the emit skips
 * destroyed windows.
 */

const { EventEmitter } = require('events');

jest.mock('electron', () => ({
  Notification: Object.assign(jest.fn(), { isSupported: jest.fn(() => true) }),
  BrowserWindow: {
    getAllWindows: jest.fn(() => [])
  }
}));

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

jest.mock('../src/main/ipc/ipcWrappers', () => ({
  safeSend: jest.fn(() => true)
}));

const NotificationService = require('../src/main/services/NotificationService');
const { BrowserWindow } = require('electron');
const { safeSend } = require('../src/main/ipc/ipcWrappers');

function makeWindow() {
  const win = new EventEmitter();
  let destroyed = false;
  Object.assign(win, {
    webContents: { id: 1, send: jest.fn() },
    isDestroyed: () => destroyed,
    isMinimized: () => false,
    restore: jest.fn(),
    show: jest.fn(),
    focus: jest.fn(),
    destroy: () => {
      destroyed = true;
      win.emit('closed');
    }
  });
  return win;
}

describe('NotificationService activation', () => {
  let service;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    service = new NotificationService({ settingsService: { load: jest.fn() } });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('repeated clicks add no listeners to the window', () => {
    const win = makeWindow();
    BrowserWindow.getAllWindows.mockReturnValue([win]);

    for (let i = 0; i < 15; i++) {
      service._handleNotificationActivation({ type: 'file_organized', data: { i } });
    }
    jest.advanceTimersByTime(100);

    expect(win.listenerCount('closed')).toBe(0);
    expect(safeSend).toHaveBeenCalledTimes(15);
  });

  test('a window closed before the timer fires is not sent to', () => {
    const win = makeWindow();
    BrowserWindow.getAllWindows.mockReturnValue([win]);

    service._handleNotificationActivation({ type: 'file_organized', data: null });
    win.destroy();
    jest.advanceTimersByTime(100);

    expect(safeSend).not.toHaveBeenCalled();
  });
});
