/**
 * @jest-environment node
 */
/**
 * A second launch while the main window is still hidden (waiting for its
 * first paint) must not force-show the unpainted window: show() puts a blank
 * frame on screen and releases the first-paint gate, which starts heavyweight
 * startup while the renderer is still loading. The window comes forward once
 * its own first show happens.
 */
jest.mock('electron', () => require('./loadSimpleMain').electronMockFactory());
jest.mock('chokidar', () => ({ watch: jest.fn() }));
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../../src/main/core/userDataLock', () =>
  require('./loadSimpleMain').userDataLockMockFactory()
);
jest.mock('../../../src/main/core/createWindow', () =>
  require('./loadSimpleMain').createWindowMockFactory()
);

const { loadSimpleMain } = require('./loadSimpleMain');
const { waitForFirstPaint } = require('../../../src/main/core/firstPaintGate');

describe('second launch before the main window has been shown', () => {
  let harness;

  beforeAll(() => {
    harness = loadSimpleMain();
  });

  afterAll(() => {
    harness.dispose();
  });

  test('defers the restore until the first show instead of showing a blank window', async () => {
    const { app, createWindow } = harness;

    // First launch path: no window yet, so the handler creates one. It stays
    // hidden until ready-to-show.
    app.__events.emit('second-instance', {}, []);
    expect(createWindow).toHaveBeenCalledTimes(1);
    const win = createWindow.windows[0];
    expect(win.isVisible()).toBe(false);

    let gateReason = null;
    const gate = waitForFirstPaint(win, { timeoutMs: 60_000 }).then((reason) => {
      gateReason = reason;
      return reason;
    });

    // The user double-clicks the icon again while the window is still hidden.
    app.__events.emit('second-instance', {}, []);
    await new Promise((resolve) => setImmediate(resolve));

    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
    expect(gateReason).toBeNull();

    // The window's own first show (ready-to-show / show fallback) brings the
    // deferred restore forward.
    win.show();
    await expect(gate).resolves.toBe('shown');
    await new Promise((resolve) => setImmediate(resolve));
    expect(win.focus).toHaveBeenCalled();
  });

  test('a launch after the window has been shown restores it immediately', async () => {
    const { app, createWindow } = harness;
    const win = createWindow.windows[0];
    win.hide();
    win.show.mockClear();
    win.focus.mockClear();

    app.__events.emit('second-instance', {}, []);
    await new Promise((resolve) => setImmediate(resolve));

    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
  });
});
