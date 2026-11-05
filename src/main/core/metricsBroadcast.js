// @ts-check
/**
 * Periodic system-metrics push to the renderer.
 *
 * Collecting metrics walks process and pipeline counters, and the only reader
 * is the window's UI. While the window is minimized or hidden (closed to the
 * tray) nobody sees the numbers, so the tick does nothing; the first tick
 * after the window comes back sends fresh ones.
 */

/**
 * True when the window exists and can be seen: not destroyed, shown, and not
 * minimized.
 * @param {any} win
 * @returns {boolean}
 */
function isWindowOnScreen(win) {
  if (!win || win.isDestroyed?.()) return false;
  if (typeof win.isVisible === 'function' && !win.isVisible()) return false;
  if (typeof win.isMinimized === 'function' && win.isMinimized()) return false;
  return true;
}

/**
 * @param {{
 *   getWindow: () => any,
 *   collectMetrics: () => Promise<any>,
 *   send: (webContents: any, metrics: any) => void,
 *   logger: { error: Function }
 * }} deps
 * @returns {() => Promise<void>} one tick; never throws
 */
function createMetricsBroadcastTick({ getWindow, collectMetrics, send, logger }) {
  return async function broadcastMetrics() {
    try {
      const win = getWindow();
      if (!isWindowOnScreen(win)) return;
      const metrics = await collectMetrics();
      send(win.webContents, metrics);
    } catch (error) {
      logger.error('[METRICS] Failed to collect or send metrics:', error);
    }
  };
}

module.exports = { createMetricsBroadcastTick, isWindowOnScreen };
