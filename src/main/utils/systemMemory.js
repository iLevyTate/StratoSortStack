// @ts-check
/**
 * How much memory the system can hand out right now, per platform.
 *
 * `os.freemem()` means different things on different systems. On Windows
 * (GlobalMemoryStatusEx ullAvailPhys) and Linux (MemAvailable) libuv already
 * reports AVAILABLE memory: free pages plus caches the kernel drops on
 * demand. On macOS it reports FREE pages only, and macOS keeps most memory
 * in the inactive, speculative and purgeable lists on purpose, so a healthy
 * Mac routinely shows a few hundred MB "free" with gigabytes to spare. A
 * fixed floor compared against it (BatchAnalysisService pauses each file
 * start below 300 MB) fires on almost every file there, and the memory log
 * reports pressure that is not real.
 *
 * On darwin this module reads `kern.memorystatus_level` instead: the kernel's
 * own "percent of memory available" (the figure `memory_pressure` prints as
 * "System-wide memory free percentage"), which counts the reclaimable lists.
 * The probe runs `/usr/sbin/sysctl` with a 1 s timeout, is cached briefly,
 * and falls back to `os.freemem()` on any failure, so the worst case is the
 * old behaviour. Other platforms return `os.freemem()` unchanged and never
 * start a process.
 *
 * The same probe style gives the memory heartbeat two more figures: swap in
 * use (darwin) and one child process's resident size (darwin, linux).
 */

const os = require('os');
const { asyncSpawn } = require('./asyncSpawnUtils');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('SystemMemory');

const SYSCTL_PATH = '/usr/sbin/sysctl';
const PS_PATH = '/bin/ps';
const PROBE_TIMEOUT_MS = 1000;
const DEFAULT_CACHE_MS = 2000;

/**
 * Same shape as asyncSpawn: never rejects, reports failure in the result.
 * @typedef {(command: string, args: string[], options: Record<string, any>) =>
 *   Promise<{ status?: number | null, stdout?: string, error?: any }>} RunCommand
 */

/**
 * Run a short probe and return its stdout; throws when it fails or times out.
 * @param {RunCommand} runCommand
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function probe(runCommand, command, args) {
  const result = await runCommand(command, args, {
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true
  });
  if (result?.error) throw result.error;
  if (result?.status !== 0) throw new Error(`${command} exited with ${result?.status}`);
  return String(result.stdout ?? '');
}

/**
 * Parse `sysctl -n kern.memorystatus_level` output.
 * @param {unknown} stdout
 * @returns {number | null} percent of memory available, 0-100, or null
 */
function parseMemorystatusLevel(stdout) {
  const text = String(stdout ?? '').trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const level = Number(text);
  return level <= 100 ? level : null;
}

/**
 * Parse `sysctl -n vm.swapusage` output, e.g.
 * `total = 10240.00M  used = 8814.25M  free = 1425.75M  (encrypted)`.
 * @param {unknown} stdout
 * @returns {number | null} swap in use, in whole MB, or null
 */
function parseSwapUsedMB(stdout) {
  const match = /used\s*=\s*([\d.]+)\s*([KMG])/i.exec(String(stdout ?? ''));
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2].toUpperCase();
  const mb = unit === 'G' ? value * 1024 : unit === 'K' ? value / 1024 : value;
  return Math.round(mb);
}

/**
 * Parse `ps -o rss= -p <pid>` output (KB).
 * @param {unknown} stdout
 * @returns {number | null}
 */
function parseRssKb(stdout) {
  const text = String(stdout ?? '').trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

/**
 * @param {{ platform?: string, osApi?: { freemem: () => number, totalmem: () => number },
 *   runCommand?: RunCommand, now?: () => number, cacheMs?: number, log?: any }} [deps]
 */
function createAvailableMemoryReader({
  platform = process.platform,
  osApi = os,
  runCommand = asyncSpawn,
  now = Date.now,
  cacheMs = DEFAULT_CACHE_MS,
  log = logger
} = {}) {
  /** @type {{ bytes: number, at: number } | null} */
  let cached = null;
  /** @type {Promise<number> | null} */
  let inFlight = null;
  let fallbackLogged = false;

  const freeBytes = () => osApi.freemem();

  /** @returns {Promise<number>} */
  const readDarwin = async () => {
    try {
      const level = parseMemorystatusLevel(
        await probe(runCommand, SYSCTL_PATH, ['-n', 'kern.memorystatus_level'])
      );
      if (level === null) throw new Error('unexpected kern.memorystatus_level output');
      return Math.round((osApi.totalmem() * level) / 100);
    } catch (error) {
      if (!fallbackLogged) {
        fallbackLogged = true;
        log.warn('[SystemMemory] Could not read available memory; using free memory instead', {
          error: /** @type {any} */ (error)?.message
        });
      }
      return freeBytes();
    }
  };

  /**
   * Available memory in bytes. Never rejects.
   * @returns {Promise<number>}
   */
  const read = async () => {
    if (platform !== 'darwin') return freeBytes();
    if (cached && now() - cached.at < cacheMs) return cached.bytes;
    if (!inFlight) {
      inFlight = readDarwin()
        .then((bytes) => {
          cached = { bytes, at: now() };
          return bytes;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };

  /**
   * The last reading, without waiting. On darwin a stale or missing reading
   * starts a refresh in the background and returns what is known now (free
   * memory until the first reading lands).
   * @returns {number}
   */
  const peek = () => {
    if (platform !== 'darwin') return freeBytes();
    if (!cached || now() - cached.at >= cacheMs) {
      read().catch(() => {});
    }
    return cached ? cached.bytes : freeBytes();
  };

  return { read, peek };
}

/**
 * Swap in use, in MB. darwin only (`vm.swapusage`); null elsewhere or on any
 * failure. Never rejects.
 * @param {{ platform?: string, runCommand?: RunCommand }} [deps]
 * @returns {Promise<number | null>}
 */
async function readSwapUsedMB({ platform = process.platform, runCommand = asyncSpawn } = {}) {
  if (platform !== 'darwin') return null;
  try {
    return parseSwapUsedMB(await probe(runCommand, SYSCTL_PATH, ['-n', 'vm.swapusage']));
  } catch {
    return null;
  }
}

/**
 * Resident size of another process, in KB, via `ps`. darwin and linux only;
 * null on Windows, for a bad pid, or on any failure. Never rejects.
 * @param {number | null | undefined} pid
 * @param {{ platform?: string, runCommand?: RunCommand }} [deps]
 * @returns {Promise<number | null>}
 */
async function readProcessRssKb(
  pid,
  { platform = process.platform, runCommand = asyncSpawn } = {}
) {
  if (platform !== 'darwin' && platform !== 'linux') return null;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const command = platform === 'darwin' ? PS_PATH : 'ps';
    return parseRssKb(await probe(runCommand, command, ['-o', 'rss=', '-p', String(pid)]));
  } catch {
    return null;
  }
}

/** @type {ReturnType<typeof createAvailableMemoryReader> | null} */
let sharedReader = null;
function getSharedReader() {
  if (!sharedReader) sharedReader = createAvailableMemoryReader();
  return sharedReader;
}

/**
 * Available system memory in bytes (see the module comment). Never rejects.
 * @returns {Promise<number>}
 */
function getAvailableMemoryBytes() {
  return getSharedReader().read();
}

/**
 * The last available-memory reading, without waiting.
 * @returns {number}
 */
function peekAvailableMemoryBytes() {
  return getSharedReader().peek();
}

module.exports = {
  createAvailableMemoryReader,
  getAvailableMemoryBytes,
  peekAvailableMemoryBytes,
  readSwapUsedMB,
  readProcessRssKb,
  parseMemorystatusLevel,
  parseSwapUsedMB,
  parseRssKb
};
