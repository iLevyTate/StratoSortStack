/**
 * bringWindowToForeground runs on every restore of the long-lived main window
 * (second launch, tray, dock). It must not add a 'closed' listener per call:
 * those were never removed and piled up into MaxListenersExceededWarning.
 */
const { EventEmitter } = require('events');

jest.mock('../src/shared/logger', () => {
  const logger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { logger, createLogger: jest.fn(() => logger) };
});

jest.mock('../src/shared/platformUtils', () => ({ isWindows: true, isMacOS: false }));

function fakeWindow() {
  const win = new EventEmitter();
  let destroyed = false;
  win.isDestroyed = jest.fn(() => destroyed);
  win.destroy = () => {
    destroyed = true;
    win.emit('closed');
  };
  win.moveTop = jest.fn();
  win.show = jest.fn();
  win.focus = jest.fn();
  win.setAlwaysOnTop = jest.fn();
  return win;
}

describe('bringWindowToForeground listener hygiene', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('repeated restores do not accumulate closed listeners', () => {
    const { bringWindowToForeground } = require('../src/main/core/platformBehavior');
    const win = fakeWindow();

    for (let i = 0; i < 20; i += 1) {
      bringWindowToForeground(win);
      jest.runOnlyPendingTimers();
    }

    expect(win.listenerCount('closed')).toBe(0);
    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
  });

  test('a window closed before the timer fires is left alone', () => {
    const { bringWindowToForeground } = require('../src/main/core/platformBehavior');
    const win = fakeWindow();

    bringWindowToForeground(win);
    win.destroy();
    win.setAlwaysOnTop.mockClear();
    jest.runOnlyPendingTimers();

    expect(win.setAlwaysOnTop).not.toHaveBeenCalled();
  });
});
