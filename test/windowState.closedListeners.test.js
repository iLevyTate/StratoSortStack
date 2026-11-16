/**
 * restoreMinimizedWindow runs on every restore of the long-lived main window.
 * It must not leave a 'closed' listener behind per call, and a window closed
 * during the settle delay must still resolve the restore.
 */
const { EventEmitter } = require('events');

jest.mock('../src/shared/logger', () => {
  const logger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { logger, createLogger: jest.fn(() => logger) };
});
jest.mock('../src/main/core/platformBehavior', () => ({
  bringWindowToForeground: jest.fn(),
  isWindows: false
}));
jest.mock('electron', () => ({ screen: { getAllDisplays: jest.fn(() => []) } }));

function fakeMinimizedWindow() {
  const win = new EventEmitter();
  let destroyed = false;
  win.isDestroyed = jest.fn(() => destroyed);
  win.destroy = () => {
    destroyed = true;
    win.emit('closed');
  };
  win.isVisible = jest.fn(() => true);
  win.show = jest.fn();
  win.focus = jest.fn();
  win.restore = jest.fn(() => win.emit('restore'));
  return win;
}

describe('restoreMinimizedWindow listener hygiene', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('repeated restores do not accumulate closed listeners', async () => {
    const { restoreMinimizedWindow } = require('../src/main/core/windowState');
    const win = fakeMinimizedWindow();

    for (let i = 0; i < 20; i += 1) {
      const done = restoreMinimizedWindow(win);
      jest.runOnlyPendingTimers();
      await done;
    }

    expect(win.listenerCount('closed')).toBe(0);
    expect(win.focus).toHaveBeenCalledTimes(20);
  });

  test('a window closed during the settle delay still resolves', async () => {
    const { restoreMinimizedWindow } = require('../src/main/core/windowState');
    const win = fakeMinimizedWindow();

    const done = restoreMinimizedWindow(win);
    win.destroy();
    jest.runOnlyPendingTimers();

    await expect(done).resolves.toBeUndefined();
    expect(win.focus).not.toHaveBeenCalled();
  });
});
