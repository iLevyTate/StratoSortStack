// @ts-check
/**
 * First-paint gate for the main-process startup sequence.
 *
 * The heavyweight coordinated startup (node-llama-cpp ESM import, GPU backend
 * probing, Orama load) used to be queued as a microtask in the same tick that
 * createWindow() returned. Its synchronous stretches ran on the main-process
 * JS thread, which is also where the app:// handler serves index.html and
 * where ready-to-show / show() are dispatched, so every stall delayed the
 * first visible frame 1:1 and the show-fallback timer could not fire either.
 *
 * waitForFirstPaint() lets the caller hold that work until the window is
 * actually on screen (or its document has loaded), capped so a headless e2e
 * run or a stuck renderer still initialises services.
 */
const { TIMEOUTS } = require('../../shared/performanceConstants');

/** @typedef {'shown' | 'did-finish-load' | 'timeout' | 'no-window'} FirstPaintReason */

/**
 * Resolve once the window has been shown, its document has finished loading,
 * or `timeoutMs` has elapsed, whichever comes first. Resolves with the reason
 * so the caller can log which path released the gate.
 *
 * After settling it yields one macrotask turn (setImmediate) so macrotasks
 * that are already queued when the gate releases (notably the 100 ms show
 * timer when did-finish-load or ready-to-show won the race) run before the
 * caller continues into heavy startup work. The 50 ms focus timer is armed
 * inside the show callback and is not covered by this yield.
 *
 * @param {any} win BrowserWindow (or a compatible event emitter); may be null.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<FirstPaintReason>}
 */
async function waitForFirstPaint(win, { timeoutMs = TIMEOUTS.FIRST_PAINT_GATE } = {}) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) {
    return 'no-window';
  }

  /** @type {FirstPaintReason} */
  const reason = await new Promise((resolve) => {
    const webContents = win.webContents;
    /** @type {any} */
    let timerId = null;
    let settled = false;

    const onShow = () => settle('shown');
    const onDidFinishLoad = () => settle('did-finish-load');

    /** @param {FirstPaintReason} value */
    function settle(value) {
      if (settled) return;
      settled = true;
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
      removeListener(win, 'show', onShow);
      removeListener(webContents, 'did-finish-load', onDidFinishLoad);
      resolve(value);
    }

    addOnceListener(win, 'show', onShow);
    addOnceListener(webContents, 'did-finish-load', onDidFinishLoad);
    timerId = setTimeout(() => settle('timeout'), timeoutMs);
  });

  // Let already-queued macrotasks (the show timer, when it is pending) run
  // before the caller continues into heavy startup work.
  await new Promise((resolve) => setImmediate(resolve));
  return reason;
}

/**
 * @param {any} emitter
 * @param {string} event
 * @param {Function} handler
 */
function addOnceListener(emitter, event, handler) {
  if (emitter && typeof emitter.once === 'function') {
    emitter.once(event, handler);
  }
}

/**
 * @param {any} emitter
 * @param {string} event
 * @param {Function} handler
 */
function removeListener(emitter, event, handler) {
  if (!emitter || typeof emitter.removeListener !== 'function') return;
  try {
    emitter.removeListener(event, handler);
  } catch {
    // A destroyed BrowserWindow throws on listener access; the gate has
    // already settled, so there is nothing left to clean up.
  }
}

module.exports = { waitForFirstPaint };
