/**
 * @jest-environment node
 */
'use strict';

/**
 * waitForFirstPaint() holds heavyweight startup until the window is on screen
 * (or its document has loaded), capped so headless and stuck-renderer runs
 * still initialise services. The fake window below is a plain EventEmitter
 * pair (window + webContents) so listener bookkeeping can be asserted exactly.
 */
const { EventEmitter } = require('events');

const { waitForFirstPaint } = require('../../../src/main/core/firstPaintGate');
const { TIMEOUTS } = require('../../../src/shared/performanceConstants');

function makeWindow({ destroyed = false } = {}) {
  const win = new EventEmitter();
  win.webContents = new EventEmitter();
  win.isDestroyed = jest.fn(() => destroyed);
  return win;
}

describe('firstPaintGate.waitForFirstPaint', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("resolves 'shown' when the window emits show", async () => {
    const win = makeWindow();
    const gate = waitForFirstPaint(win, { timeoutMs: 3000 });
    win.emit('show');
    await expect(gate).resolves.toBe('shown');
  });

  test("resolves 'did-finish-load' when the document loads before the window is shown", async () => {
    const win = makeWindow();
    const gate = waitForFirstPaint(win, { timeoutMs: 3000 });
    win.webContents.emit('did-finish-load');
    await expect(gate).resolves.toBe('did-finish-load');
  });

  test("resolves 'timeout' once timeoutMs elapses without a paint signal", async () => {
    // setImmediate stays real so the trailing macrotask yield can run.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const win = makeWindow();
    let settled = null;
    const gate = waitForFirstPaint(win, { timeoutMs: 3000 }).then((reason) => {
      settled = reason;
      return reason;
    });

    await jest.advanceTimersByTimeAsync(2999);
    expect(settled).toBeNull();

    await jest.advanceTimersByTimeAsync(1);
    await expect(gate).resolves.toBe('timeout');
  });

  test('defaults the cap to TIMEOUTS.FIRST_PAINT_GATE', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    expect(TIMEOUTS.FIRST_PAINT_GATE).toBe(3000);
    const win = makeWindow();
    const gate = waitForFirstPaint(win);
    await jest.advanceTimersByTimeAsync(TIMEOUTS.FIRST_PAINT_GATE);
    await expect(gate).resolves.toBe('timeout');
  });

  test("resolves 'no-window' for a null or destroyed window without touching it", async () => {
    await expect(waitForFirstPaint(null)).resolves.toBe('no-window');
    await expect(waitForFirstPaint(undefined)).resolves.toBe('no-window');

    const destroyed = makeWindow({ destroyed: true });
    await expect(waitForFirstPaint(destroyed)).resolves.toBe('no-window');
    expect(destroyed.listenerCount('show')).toBe(0);
    expect(destroyed.webContents.listenerCount('did-finish-load')).toBe(0);
  });

  test('removes the losing listeners and clears the timer after settling', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const win = makeWindow();
    const gate = waitForFirstPaint(win, { timeoutMs: 3000 });
    expect(win.listenerCount('show')).toBe(1);
    expect(win.webContents.listenerCount('did-finish-load')).toBe(1);
    expect(jest.getTimerCount()).toBe(1);

    win.emit('show');
    await gate;

    expect(win.listenerCount('show')).toBe(0);
    expect(win.webContents.listenerCount('did-finish-load')).toBe(0);
    expect(jest.getTimerCount()).toBe(0);

    // A late did-finish-load must not reach a stale handler.
    expect(() => win.webContents.emit('did-finish-load')).not.toThrow();
  });

  test('removes the show listener when did-finish-load wins', async () => {
    const win = makeWindow();
    const gate = waitForFirstPaint(win, { timeoutMs: 3000 });
    win.webContents.emit('did-finish-load');
    await gate;
    expect(win.listenerCount('show')).toBe(0);
    expect(win.webContents.listenerCount('did-finish-load')).toBe(0);
  });

  test('removes both listeners when the timeout wins', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const win = makeWindow();
    const gate = waitForFirstPaint(win, { timeoutMs: 50 });
    await jest.advanceTimersByTimeAsync(50);
    await gate;
    expect(win.listenerCount('show')).toBe(0);
    expect(win.webContents.listenerCount('did-finish-load')).toBe(0);
  });

  test('yields one macrotask turn after settling so already-queued timers run first', async () => {
    const win = makeWindow();
    const order = [];
    const gate = waitForFirstPaint(win, { timeoutMs: 3000 }).then(() => {
      order.push('gate');
    });
    // Stands in for the ready-to-show -> show -> focus timers, which are
    // already queued by the time 'show' fires.
    setImmediate(() => order.push('pending-timer'));
    win.emit('show');
    await gate;
    expect(order).toEqual(['pending-timer', 'gate']);
  });

  test('tolerates a window whose webContents is missing', async () => {
    const win = new EventEmitter();
    win.isDestroyed = () => false;
    const gate = waitForFirstPaint(win, { timeoutMs: 3000 });
    win.emit('show');
    await expect(gate).resolves.toBe('shown');
  });
});
