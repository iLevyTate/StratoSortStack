// @ts-check
/**
 * Lightweight wrapper around the User Timing API (performance.mark /
 * performance.measure) that is safe to call from any process:
 *
 *   - Main process         : Node's `perf_hooks.performance` (v16+).
 *   - Renderer / Preload   : browser `performance`.
 *   - Worker threads       : `perf_hooks.performance`.
 *   - Old / stubbed runtime: falls back to no-ops so test environments
 *                            without a full performance API don't throw.
 *
 * Why a wrapper instead of calling performance.mark directly?
 *
 *   1. DevTools / Chromium tracing surface User Timing events in the
 *      Performance panel automatically, so `perf_marks.measure(...)`
 *      instrumentation shows up in flame charts with zero setup.
 *   2. Some renderer code paths run before `performance` is polyfilled
 *      (e.g. during the splash polyfill boot-error capture). A thin
 *      guard avoids duplicating try/catch scaffolding across callers.
 *   3. Tests can mock the exported functions easily.
 *
 * We intentionally do NOT persist marks beyond what the platform already
 * keeps (browsers cap at ~10k marks by default), and we keep names short
 * but fully-qualified (`phase:render:discover`, `startup:main:ready`) so
 * greps in support bundles are deterministic.
 */

// Node 20+ exposes performance on globalThis; renderer/preload bundlers do the
// same via the browser global. Fall back to `perf_hooks` only when we're sure
// we're in a Node context and the global isn't already populated.
function _resolvePerf() {
  if (typeof performance !== 'undefined' && performance && typeof performance.mark === 'function') {
    return performance;
  }
  try {
    const perfHooks = require('perf_hooks');
    return perfHooks?.performance || null;
  } catch {
    return null;
  }
}

const _perf = _resolvePerf();

function _isEnabled() {
  return Boolean(_perf && typeof _perf.mark === 'function');
}

/**
 * @param {string} name
 * @param {unknown} [detail]
 * @returns {void}
 */
function mark(name, detail) {
  if (!_isEnabled() || typeof name !== 'string' || name.length === 0) return;
  try {
    // `detail` is silently ignored by older runtimes that implement the
    // pre-Level-3 API, which is the correct fallback behaviour.
    _perf.mark(name, detail ? { detail } : undefined);
  } catch {
    // Swallow. Instrumentation must never break product code.
  }
}

/**
 * @param {string} name
 * @param {string} [startMark]
 * @param {string} [endMark]
 * @returns {number|null}
 */
function measure(name, startMark, endMark) {
  if (!_isEnabled() || typeof _perf.measure !== 'function' || typeof name !== 'string') return null;
  try {
    // Signature matches both Level 3 (`measure(name, { start, end })`) and
    // the legacy `measure(name, startMark, endMark)` form; using the legacy
    // form keeps us compatible with older Electron versions.
    const entry = _perf.measure(name, startMark, endMark);
    // Node's perf_hooks returns the entry synchronously; browsers return
    // void but the measurement is still available via getEntriesByName.
    if (entry && typeof entry.duration === 'number') return entry.duration;
    const entries =
      typeof _perf.getEntriesByName === 'function' ? _perf.getEntriesByName(name, 'measure') : null;
    if (entries && entries.length > 0) {
      return entries[entries.length - 1].duration;
    }
  } catch {
    // Missing start/end mark, stale names after a clear(), etc. Ignore.
  }
  return null;
}

/**
 * @param {string} [name]
 * @returns {void}
 */
function clearMarks(name) {
  if (!_isEnabled() || typeof _perf.clearMarks !== 'function') return;
  try {
    _perf.clearMarks(name);
  } catch {
    /* noop */
  }
}

/**
 * @param {string} [name]
 * @returns {void}
 */
function clearMeasures(name) {
  if (!_isEnabled() || typeof _perf.clearMeasures !== 'function') return;
  try {
    _perf.clearMeasures(name);
  } catch {
    /* noop */
  }
}

/**
 * Measure between two marks AND emit a structured JSONL log line at debug
 * level via the caller's logger. This is the opt-in bridge that makes
 * User-Timing data visible in support bundles (which collect the rolling
 * JSONL log but not the Chromium tracing capture).
 *
 * Why not auto-log every measure? Chromium tracing and DevTools Performance
 * panel remain the primary consumer — auto-logging would (a) add noise at
 * steady state and (b) duplicate what the Tracing category already captures
 * for an in-process session. Callers that care about long-term forensic
 * visibility (startup phases, migration, first-search latency) opt in at
 * the measurement site.
 *
 * @param {string} name
 * @param {string} startMark
 * @param {string} endMark
 * @param {{ debug?: Function, info?: Function }} [logger] any logger with
 *   a `.debug` method. Silently no-ops when the logger doesn't support it.
 * @returns {number|null} The measured duration in milliseconds, or null.
 */
function measureAndLog(name, startMark, endMark, logger) {
  const duration = measure(name, startMark, endMark);
  if (duration == null) return duration;
  if (logger && typeof logger.debug === 'function') {
    try {
      logger.debug('[perf]', { name, durationMs: Math.round(duration * 100) / 100 });
    } catch {
      // Logger failures must never propagate into instrumentation callsites.
    }
  }
  return duration;
}

module.exports = {
  mark,
  measure,
  measureAndLog,
  clearMarks,
  clearMeasures,
  isEnabled: _isEnabled
};
