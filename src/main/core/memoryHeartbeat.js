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
 */

const os = require('os');
const { createLogger } = require('../../shared/logger');

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
 * @param {{ logger?: any, osApi?: any, processApi?: any, now?: () => number }} [deps]
 * @returns {() => void} sampler — call once per heartbeat tick; never throws
 */
function createMemoryPressureSampler({
  logger = defaultLogger,
  osApi = os,
  processApi = process,
  now = Date.now
} = {}) {
  let pressureHigh = false;
  /** @type {{ rssMB: number, sysUsedPct: number, at: number } | null} */
  let lastLogged = null;

  /** @param {{ rssMB: number, sysUsedPct: number }} sample */
  const movedSinceLastLine = (sample) => {
    if (!lastLogged) return true;
    if (now() - lastLogged.at >= QUIET_LOG_INTERVAL_MS) return true;
    if (Math.abs(sample.sysUsedPct - lastLogged.sysUsedPct) >= SYS_USED_CHANGE_PCT) return true;
    const rssDelta = Math.abs(sample.rssMB - lastLogged.rssMB);
    return rssDelta >= Math.max(1, lastLogged.rssMB * RSS_CHANGE_RATIO);
  };
  /** @param {{ rssMB: number, sysUsedPct: number }} sample */
  const remember = (sample) => {
    lastLogged = { rssMB: sample.rssMB, sysUsedPct: sample.sysUsedPct, at: now() };
  };

  return function sampleMemoryPressure() {
    try {
      const { rss, heapUsed } = processApi.memoryUsage();
      const totalMem = osApi.totalmem();
      const freeMem = osApi.freemem();
      const sysUsedPct = totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : 0;
      const sample = {
        rssMB: toMB(rss),
        heapUsedMB: toMB(heapUsed),
        sysFreeMB: toMB(freeMem),
        sysTotalMB: toMB(totalMem),
        sysUsedPct
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
