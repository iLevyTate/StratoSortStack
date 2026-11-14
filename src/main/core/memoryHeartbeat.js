// @ts-check
/**
 * Memory heartbeat sampler.
 *
 * Always-on diagnostic mirroring the crashReporter's "unconditional
 * post-mortem" stance: an OS OOM-kill or a native fault in
 * node-llama-cpp/CUDA leaves a clean log that simply stops, so the last
 * heartbeat line before an abrupt termination reveals whether memory was
 * spiking. Samples main-process RSS (which, unlike V8 heapUsed, includes
 * native model/CUDA allocations) plus system-wide pressure.
 *
 * The pressure warning uses hysteresis: warn once on the upward crossing of
 * the high watermark, then keep sampling at info until pressure falls below
 * the (lower) recovery watermark. A sustained-high session previously logged
 * a warn every 15 s — thousands per session — drowning real warnings.
 *
 * The plain info line follows the same idea: it is written when memory has
 * moved since the last line (RSS by RSS_CHANGE_RATIO, or system use by
 * SYS_USED_CHANGE_PCT points) and at least every QUIET_LOG_INTERVAL_MS
 * otherwise. A climb towards an OOM-kill is a series of changes, so it still
 * lands in the log; a flat idle session writes one line every five minutes
 * instead of one every 15 s.
 *
 * System use is measured against AVAILABLE memory (utils/systemMemory.js),
 * not os.freemem(): on macOS free pages alone read as constant pressure.
 * Each line also carries the other memory the app is responsible for, so a
 * climb can be pinned on the right process: every Electron process
 * (renderer, GPU, helpers) from app.getAppMetrics(), the separate vision
 * runtime's resident size, and swap in use. The vision and swap figures come
 * from short probes that run in the background; a tick logs the latest one
 * (so they appear from the second tick) and the sampler stays synchronous.
 */

const os = require('os');
const { createLogger } = require('../../shared/logger');
const {
  peekAvailableMemoryBytes,
  readProcessRssKb,
  readSwapUsedMB: readSwapUsedMBDefault
} = require('../utils/systemMemory');

const defaultLogger = createLogger('Main');

const MEMORY_PRESSURE_WARN_PCT = 85;
const MEMORY_PRESSURE_RECOVERY_PCT = 80;
/** Log again once RSS has moved this fraction from the last logged value. */
const RSS_CHANGE_RATIO = 0.1;
/** Log again once system memory use has moved this many points. */
const SYS_USED_CHANGE_PCT = 5;
/** Log at least this often even when nothing moved. */
const QUIET_LOG_INTERVAL_MS = 5 * 60 * 1000;

function toMB(/** @type {any} */ bytes) {
  return Math.round(bytes / 1024 / 1024);
}

/**
 * True when `value` moved by RSS_CHANGE_RATIO (and at least 1 MB) from
 * `previous`, or appeared or went away.
 * @param {number | null} value
 * @param {number | null} previous
 */
function movedByRatio(value, previous) {
  if (value === null || previous === null) return value !== previous;
  return Math.abs(value - previous) >= Math.max(1, previous * RSS_CHANGE_RATIO);
}

/**
 * Sum of every Electron process's working set, in MB, or null.
 * @param {(() => Array<{ memory?: { workingSetSize?: number } }>) | null} getAppMetrics
 * @returns {number | null}
 */
function sumAppProcessesMB(getAppMetrics) {
  if (typeof getAppMetrics !== 'function') return null;
  try {
    const metrics = getAppMetrics();
    if (!Array.isArray(metrics) || metrics.length === 0) return null;
    const totalKb = metrics.reduce((sum, m) => sum + (Number(m?.memory?.workingSetSize) || 0), 0);
    return Math.round(totalKb / 1024);
  } catch {
    return null;
  }
}

/**
 * @typedef {{ rssMB: number, sysUsedPct: number, appProcessesMB: number | null,
 *   visionRssMB: number | null }} MovementFields
 */

/**
 * @typedef {{
 *   logger?: any, osApi?: any, processApi?: any, now?: () => number,
 *   peekAvailable?: () => number,
 *   getAppMetrics?: (() => Array<{ memory?: { workingSetSize?: number } }>) | null,
 *   getVisionPid?: (() => number | null | undefined) | null,
 *   readRssKb?: (pid: number) => Promise<number | null> | number | null,
 *   readSwapUsedMB?: () => Promise<number | null> | number | null
 * }} SamplerDeps
 */

/**
 * @param {SamplerDeps} [deps] An injected `osApi` stands for the whole
 *   system: unless `peekAvailable` and `readSwapUsedMB` are given too, its
 *   freemem() is the available figure and swap is not probed.
 * @returns {() => void} sampler — call once per heartbeat tick; never throws
 */
function createMemoryPressureSampler({
  logger = defaultLogger,
  osApi = os,
  processApi = process,
  now = Date.now,
  peekAvailable = osApi === os ? peekAvailableMemoryBytes : () => osApi.freemem(),
  getAppMetrics = null,
  getVisionPid = null,
  readRssKb = readProcessRssKb,
  readSwapUsedMB = osApi === os ? () => readSwapUsedMBDefault() : () => null
} = {}) {
  let pressureHigh = false;
  /** @type {(MovementFields & { at: number }) | null} */
  let lastLogged = null;

  // Latest results of the background probes, and which are still running.
  /** @type {{ visionRssMB: number | null, swapUsedMB: number | null }} */
  const latest = { visionRssMB: null, swapUsedMB: null };
  const probing = { visionRssMB: false, swapUsedMB: false };

  /**
   * Start `probe` unless the one for `key` is still running; keep its result
   * (null on any failure) for the next tick.
   * @param {'visionRssMB' | 'swapUsedMB'} key
   * @param {() => Promise<number | null> | number | null} probe
   */
  const refresh = (key, probe) => {
    if (probing[key]) return;
    probing[key] = true;
    // An async IIFE so a probe that throws synchronously lands in the same
    // catch as one that rejects; the promise itself never rejects.
    void (async () => {
      try {
        const value = await probe();
        latest[key] = typeof value === 'number' && Number.isFinite(value) ? value : null;
      } catch {
        latest[key] = null;
      } finally {
        probing[key] = false;
      }
    })();
  };

  const refreshProbes = () => {
    refresh('swapUsedMB', readSwapUsedMB);
    refresh('visionRssMB', async () => {
      const pid = typeof getVisionPid === 'function' ? getVisionPid() : null;
      if (typeof pid !== 'number' || !(pid > 0)) return null;
      const kb = await readRssKb(pid);
      return typeof kb === 'number' ? Math.round(kb / 1024) : null;
    });
  };

  /** @param {MovementFields} sample */
  const movedSinceLastLine = (sample) => {
    if (!lastLogged) return true;
    if (now() - lastLogged.at >= QUIET_LOG_INTERVAL_MS) return true;
    if (Math.abs(sample.sysUsedPct - lastLogged.sysUsedPct) >= SYS_USED_CHANGE_PCT) return true;
    return (
      movedByRatio(sample.rssMB, lastLogged.rssMB) ||
      movedByRatio(sample.appProcessesMB, lastLogged.appProcessesMB) ||
      movedByRatio(sample.visionRssMB, lastLogged.visionRssMB)
    );
  };
  /** @param {MovementFields} sample */
  const remember = (sample) => {
    lastLogged = {
      rssMB: sample.rssMB,
      sysUsedPct: sample.sysUsedPct,
      appProcessesMB: sample.appProcessesMB,
      visionRssMB: sample.visionRssMB,
      at: now()
    };
  };

  // Start the first readings now, so the first tick (and anything that peeks
  // at available memory before it, like the batch concurrency default) has
  // them rather than macOS's free-pages figure.
  try {
    refreshProbes();
    peekAvailable();
  } catch {
    // A tick retries; creating the sampler must never throw.
  }

  return function sampleMemoryPressure() {
    try {
      refreshProbes();
      const { rss, heapUsed } = processApi.memoryUsage();
      const totalMem = osApi.totalmem();
      const freeMem = osApi.freemem();
      const availableMem = peekAvailable();
      const sysUsedPct =
        totalMem > 0 ? Math.round(((totalMem - availableMem) / totalMem) * 100) : 0;
      const sample = {
        rssMB: toMB(rss),
        heapUsedMB: toMB(heapUsed),
        sysFreeMB: toMB(freeMem),
        sysAvailableMB: toMB(availableMem),
        sysTotalMB: toMB(totalMem),
        sysUsedPct,
        appProcessesMB: sumAppProcessesMB(getAppMetrics),
        visionRssMB: latest.visionRssMB,
        swapUsedMB: latest.swapUsedMB
      };
      if (sysUsedPct >= MEMORY_PRESSURE_WARN_PCT && !pressureHigh) {
        pressureHigh = true;
        logger.warn('[MEMORY-HEARTBEAT] System memory pressure high', sample);
        remember(sample);
      } else if (pressureHigh && sysUsedPct < MEMORY_PRESSURE_RECOVERY_PCT) {
        pressureHigh = false;
        logger.info('[MEMORY-HEARTBEAT] System memory pressure recovered', sample);
        remember(sample);
      } else if (movedSinceLastLine(sample)) {
        logger.info('[MEMORY-HEARTBEAT]', sample);
        remember(sample);
      }
    } catch (error) {
      logger.warn('[MEMORY-HEARTBEAT] sample failed', { error: error?.message });
    }
  };
}

module.exports = { createMemoryPressureSampler };
