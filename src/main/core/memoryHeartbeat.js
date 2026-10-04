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
 */

const os = require('os');
const { createLogger } = require('../../shared/logger');

const defaultLogger = createLogger('Main');

const MEMORY_PRESSURE_WARN_PCT = 85;
const MEMORY_PRESSURE_RECOVERY_PCT = 80;

function toMB(/** @type {any} */ bytes) {
  return Math.round(bytes / 1024 / 1024);
}

/**
 * @param {{ logger?: any, osApi?: any, processApi?: any }} [deps]
 * @returns {() => void} sampler — call once per heartbeat tick; never throws
 */
function createMemoryPressureSampler({
  logger = defaultLogger,
  osApi = os,
  processApi = process
} = {}) {
  let pressureHigh = false;

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
      } else if (pressureHigh && sysUsedPct < MEMORY_PRESSURE_RECOVERY_PCT) {
        pressureHigh = false;
        logger.info('[MEMORY-HEARTBEAT] System memory pressure recovered', sample);
      } else {
        logger.info('[MEMORY-HEARTBEAT]', sample);
      }
    } catch (error) {
      logger.warn('[MEMORY-HEARTBEAT] sample failed', { error: error?.message });
    }
  };
}

module.exports = { createMemoryPressureSampler };
