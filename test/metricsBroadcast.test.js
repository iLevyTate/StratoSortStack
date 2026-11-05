/**
 * The main process pushes system metrics to the window every 30 s. Nobody
 * reads them while the window is minimized or hidden in the tray, so the tick
 * must skip the collection and the send then, and resume when it is shown.
 */
const {
  createMetricsBroadcastTick,
  isWindowOnScreen
} = require('../src/main/core/metricsBroadcast');

function makeWindow({ visible = true, minimized = false, destroyed = false } = {}) {
  return {
    webContents: { id: 1 },
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    isMinimized: () => minimized
  };
}

function makeTick(win) {
  const collectMetrics = jest.fn().mockResolvedValue({ uptime: 1 });
  const send = jest.fn();
  const logger = { error: jest.fn() };
  const tick = createMetricsBroadcastTick({
    getWindow: () => win.current,
    collectMetrics,
    send,
    logger
  });
  return { tick, collectMetrics, send, logger };
}

describe('metrics broadcast tick', () => {
  test('sends metrics to a visible window', async () => {
    const win = { current: makeWindow() };
    const { tick, collectMetrics, send } = makeTick(win);
    await tick();
    expect(collectMetrics).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(win.current.webContents, { uptime: 1 });
  });

  test('skips collection and send while minimized or hidden, then resumes', async () => {
    const win = { current: makeWindow({ minimized: true }) };
    const { tick, collectMetrics, send } = makeTick(win);
    await tick();
    win.current = makeWindow({ visible: false });
    await tick();
    expect(collectMetrics).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    win.current = makeWindow();
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('no window, a destroyed one, or a failing collector never throws', async () => {
    const win = { current: null };
    const { tick, collectMetrics, logger } = makeTick(win);
    await expect(tick()).resolves.toBeUndefined();
    win.current = makeWindow({ destroyed: true });
    await tick();
    expect(collectMetrics).not.toHaveBeenCalled();

    win.current = makeWindow();
    collectMetrics.mockRejectedValueOnce(new Error('boom'));
    await expect(tick()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  test('isWindowOnScreen reads visibility and minimized state', () => {
    expect(isWindowOnScreen(makeWindow())).toBe(true);
    expect(isWindowOnScreen(makeWindow({ minimized: true }))).toBe(false);
    expect(isWindowOnScreen(makeWindow({ visible: false }))).toBe(false);
    expect(isWindowOnScreen(null)).toBe(false);
  });
});
