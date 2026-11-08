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
 * actually on screen, capped so a headless e2e run or a stuck renderer still
 * initialises services. Its document finishing loading does not count: that
 * fires before ready-to-show, and the window is shown a further 100 ms after
 * ready-to-show, so releasing on it put the heavy work ahead of the first
 * frame again.
 *
 * Other startup work (the semantic pre-warm) waits on the same release
 * through whenFirstPaintGateReleased().
 */
const { TIMEOUTS } = require('../../shared/performanceConstants');

/** @typedef {'shown' | 'timeout' | 'no-window'} FirstPaintReason */

/** @type {(reason: FirstPaintReason) => void} */
let releaseGate = () => {};
/** @type {Promise<FirstPaintReason>} */
let gateReleased = new Promise((resolve) => {
  releaseGate = resolve;
});

/**
 * Resolve once the window has been shown or `timeoutMs` has elapsed,
 * whichever comes first. Resolves with the reason so the caller can log which
 * path released the gate, and releases whenFirstPaintGateReleased().
 *
 * After settling it yields one macrotask turn (setImmediate) so macrotasks
 * that are already queued when the gate releases run before the caller
 * continues into heavy startup work. The 50 ms focus timer is armed inside the
 * show callback and is not covered by this yield.
 *
 * @param {any} win BrowserWindow (or a compatible event emitter); may be null.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<FirstPaintReason>}
 */
async function waitForFirstPaint(win, { timeoutMs = TIMEOUTS.FIRST_PAINT_GATE } = {}) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) {
    releaseGate('no-window');
    return 'no-window';
  }

  /** @type {FirstPaintReason} */
  const reason = await new Promise((resolve) => {
    /** @type {any} */
    let timerId = null;
    let settled = false;

    const onShow = () => settle('shown');

    /** @param {FirstPaintReason} value */
    function settle(value) {
      if (settled) return;
      settled = true;
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
      removeListener(win, 'show', onShow);
      resolve(value);
    }

    addOnceListener(win, 'show', onShow);
    timerId = setTimeout(() => settle('timeout'), timeoutMs);
  });
  releaseGate(reason);

  // Let already-queued macrotasks (the show timer, when it is pending) run
  // before the caller continues into heavy startup work.
  await new Promise((resolve) => setImmediate(resolve));
  return reason;
}

/**
 * Resolve once waitForFirstPaint() has released, or after `timeoutMs` if it
 * never runs (a degraded start that never creates the main window).
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<FirstPaintReason>}
 */
function whenFirstPaintGateReleased({
  timeoutMs = TIMEOUTS.WINDOW_SHOW_FALLBACK + TIMEOUTS.FIRST_PAINT_GATE
} = {}) {
  /** @type {any} */
  let timerId = null;
  /** @type {Promise<FirstPaintReason>} */
  const cap = new Promise((resolve) => {
    timerId = setTimeout(() => resolve('timeout'), timeoutMs);
    if (typeof timerId?.unref === 'function') timerId.unref();
  });
  return Promise.race([gateReleased, cap]).finally(() => clearTimeout(timerId));
}

/** Test hook: make the gate unreleased again. */
function _resetFirstPaintGateForTests() {
  gateReleased = new Promise((resolve) => {
    releaseGate = resolve;
  });
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

module.exports = { waitForFirstPaint, whenFirstPaintGateReleased, _resetFirstPaintGateForTests };
