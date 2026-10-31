// @ts-check
/**
 * Last-known-good GPU backend for node-llama-cpp.
 *
 * On Windows node-llama-cpp test-loads every GPU prebuilt (CUDA, Vulkan) in a
 * child process before using it, so each candidate the backend selector tries
 * and rejects still costs a full binary test. This record remembers which
 * backend the selector settled on, so the next launch can try that one first.
 * It only reorders: the library's binary test still runs, a failed cached
 * attempt clears the record, and the normal candidate ladder carries on.
 *
 * The record is keyed by a fingerprint of the machine and the shipped binaries
 * (platform, arch, app version, node-llama-cpp version, detected GPU type and
 * name, and driver version when the GPU probe reports one), plus the GPU
 * backends node-llama-cpp reported as supported when it was saved. Any
 * difference, a missing, unreadable or corrupt file, or a record older than
 * BACKEND_CACHE_MAX_AGE_MS reads as "no hint". The supported set catches a
 * runtime that appeared after the record was saved: a Vulkan record written
 * while the CUDA runtime was missing must not keep CUDA behind Vulkan once a
 * CUDA toolkit is installed. None of the methods throw.
 *
 * Electron-free on purpose: the caller supplies the userData directory and the
 * app version, so a worker thread can use it too.
 *
 * @module utils/llamaBackendCache
 */

const fs = require('fs').promises;
const path = require('path');
const { createLogger } = require('../../shared/logger');
const { atomicWriteFile, safeUnlink } = require('../../shared/atomicFile');
const { tryParse } = require('../../shared/safeJsonOps');

const logger = createLogger('LlamaBackendCache');

const BACKEND_CACHE_FILENAME = 'gpu-backend-cache.json';
// The full ladder runs again once a record is this old. A one-off failure of
// a preferred backend would otherwise keep a slower one first until the next
// app update changes the fingerprint.
const BACKEND_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
// CPU is never remembered: a cached CPU result would skip every GPU attempt
// on later launches, including after the user installs a working driver.
const CACHEABLE_BACKENDS = new Set(['cuda', 'vulkan', 'metal']);
const FINGERPRINT_KEYS = /** @type {const} */ ([
  'platform',
  'arch',
  'appVersion',
  'nodeLlamaVersion',
  'gpuType',
  'gpuName',
  'driverVersion'
]);

/**
 * @typedef {{
 *   platform: string|null,
 *   arch: string|null,
 *   appVersion: string|null,
 *   nodeLlamaVersion: string|null,
 *   gpuType: string|null,
 *   gpuName: string|null,
 *   driverVersion: string|null
 * }} BackendFingerprint
 */

/**
 * `supportedGpuTypes` is the `getLlamaGpuTypes('supported')` result of this
 * launch, or null/undefined when it is unknown.
 * @typedef {{ supportedGpuTypes?: Array<string|false>|null }} SupportOptions
 */

/**
 * @typedef {{
 *   filePath: string,
 *   fingerprint: BackendFingerprint,
 *   read: (options?: SupportOptions|null) => Promise<string|null>,
 *   write: (backend: any, options?: SupportOptions|null) => Promise<boolean>,
 *   clear: () => Promise<void>
 * }} LlamaBackendCache
 */

/**
 * Stable key for a `getLlamaGpuTypes('supported')` result: the GPU type names,
 * lowercased, de-duplicated and sorted (`['vulkan', 'cuda', false]` ->
 * `'cuda,vulkan'`). null when the set is unknown (no array was given).
 *
 * @param {any} supportedGpuTypes
 * @returns {string|null}
 */
function supportedGpuTypesKey(supportedGpuTypes) {
  if (!Array.isArray(supportedGpuTypes)) return null;
  const names = supportedGpuTypes
    .filter((entry) => typeof entry === 'string' && entry.trim())
    .map((entry) => entry.trim().toLowerCase());
  return [...new Set(names)].sort().join(',');
}

/** @param {any} value */
function asText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * @param {{ platform?: any, arch?: any, appVersion?: any, nodeLlamaVersion?: any, gpuInfo?: any }} args
 * @returns {BackendFingerprint}
 */
function buildBackendFingerprint({ platform, arch, appVersion, nodeLlamaVersion, gpuInfo }) {
  const gpuType = asText(gpuInfo?.type);
  return {
    platform: asText(platform),
    arch: asText(arch),
    appVersion: asText(appVersion),
    nodeLlamaVersion: asText(nodeLlamaVersion),
    gpuType: gpuType ? gpuType.toLowerCase() : null,
    gpuName: asText(gpuInfo?.name),
    driverVersion: asText(gpuInfo?.driverVersion)
  };
}

/**
 * Names of the fingerprint fields that differ; every field when `stored` is
 * not an object.
 *
 * @param {any} stored
 * @param {BackendFingerprint} current
 * @returns {string[]}
 */
function diffFingerprint(stored, current) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return [...FINGERPRINT_KEYS];
  }
  return FINGERPRINT_KEYS.filter((key) => (stored[key] ?? null) !== current[key]);
}

/**
 * Create the backend record for one machine/version fingerprint.
 *
 * @param {{
 *   userDataPath?: string|null,
 *   appVersion?: string|null,
 *   nodeLlamaVersion?: string|null,
 *   gpuInfo?: any,
 *   platform?: string,
 *   arch?: string,
 *   now?: () => number
 * }} options
 * @returns {LlamaBackendCache|null} null when no userData directory is given
 */
function createLlamaBackendCache({
  userDataPath,
  appVersion = null,
  nodeLlamaVersion = null,
  gpuInfo = null,
  platform = process.platform,
  arch = process.arch,
  now = Date.now
}) {
  if (!asText(userDataPath)) return null;
  const directory = /** @type {string} */ (userDataPath);

  const filePath = path.join(directory, BACKEND_CACHE_FILENAME);
  const fingerprint = buildBackendFingerprint({
    platform,
    arch,
    appVersion,
    nodeLlamaVersion,
    gpuInfo
  });

  /**
   * Debug-log why the record is not used; every read miss returns through here.
   *
   * @param {string} reason
   * @param {Record<string, any>} [details]
   * @returns {null}
   */
  const ignore = (reason, details = {}) => {
    logger.debug('[LlamaBackendCache] Ignoring cached backend record', {
      reason,
      filePath,
      ...details
    });
    return null;
  };

  /**
   * The remembered backend when the record matches this fingerprint and is
   * fresh, otherwise null. When `supportedGpuTypes` is known it must also
   * match the set the record was saved with; an unknown set (the support probe
   * failed this launch) is not compared.
   *
   * @param {SupportOptions|null} [options]
   * @returns {Promise<string|null>}
   */
  async function read(options) {
    /** @type {string} */
    let raw;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return ignore('missing');
      return ignore('unreadable', { error: error?.message || String(error) });
    }

    const parsed = tryParse(raw);
    const record = parsed.success ? parsed.value : null;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return ignore('corrupt', { error: parsed.error?.message || null });
    }
    if (typeof record.backend !== 'string' || !CACHEABLE_BACKENDS.has(record.backend)) {
      return ignore('invalid', { backend: record.backend ?? null });
    }

    const changed = diffFingerprint(record.fingerprint, fingerprint);
    if (changed.length > 0) {
      return ignore('fingerprint-mismatch', { backend: record.backend, changed });
    }

    const currentSupported = supportedGpuTypesKey(options?.supportedGpuTypes);
    const savedSupported =
      typeof record.supportedGpuTypes === 'string' ? record.supportedGpuTypes : null;
    if (currentSupported !== null && savedSupported !== currentSupported) {
      return ignore('supported-backends-changed', {
        backend: record.backend,
        saved: savedSupported,
        current: currentSupported
      });
    }

    const savedAtMs = typeof record.savedAt === 'string' ? Date.parse(record.savedAt) : NaN;
    const ageMs = now() - savedAtMs;
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > BACKEND_CACHE_MAX_AGE_MS) {
      return ignore('expired', {
        backend: record.backend,
        savedAt: record.savedAt ?? null,
        maxAgeMs: BACKEND_CACHE_MAX_AGE_MS
      });
    }

    return record.backend;
  }

  /**
   * Remember `backend` for this fingerprint and supported-backend set.
   * Resolves false (never throws) when the backend is not a GPU backend or the
   * write fails.
   *
   * @param {any} backend
   * @param {SupportOptions|null} [options]
   * @returns {Promise<boolean>}
   */
  async function write(backend, options) {
    if (typeof backend !== 'string' || !CACHEABLE_BACKENDS.has(backend)) return false;
    try {
      await fs.mkdir(directory, { recursive: true });
      await atomicWriteFile(
        filePath,
        {
          backend,
          fingerprint,
          supportedGpuTypes: supportedGpuTypesKey(options?.supportedGpuTypes),
          savedAt: new Date(now()).toISOString()
        },
        { pretty: true }
      );
      return true;
    } catch (error) {
      logger.debug('[LlamaBackendCache] Failed to save cached backend record', {
        backend,
        filePath,
        error: error?.message || String(error)
      });
      return false;
    }
  }

  /** Delete the record. Never throws. */
  async function clear() {
    try {
      await safeUnlink(filePath);
    } catch (error) {
      logger.debug('[LlamaBackendCache] Failed to clear cached backend record', {
        filePath,
        error: error?.message || String(error)
      });
    }
  }

  return { filePath, fingerprint, read, write, clear };
}

/**
 * Read-only view of the record for a second node-llama-cpp stack (the
 * embedding worker thread). It tries the remembered backend first, but saving
 * and clearing stay with the main process's LlamaService, so the two stacks
 * never race on the file. Resolves undefined when no userData directory is
 * given; never throws.
 *
 * @param {{
 *   userDataPath?: string|null,
 *   appVersion?: string|null,
 *   nodeLlama?: any,
 *   gpuInfo?: any
 * }} options
 * @returns {Promise<{ read: LlamaBackendCache['read'] } | undefined>}
 */
async function createReadOnlyLlamaBackendCache({
  userDataPath,
  appVersion = null,
  nodeLlama,
  gpuInfo = null
}) {
  if (!asText(userDataPath)) return undefined;
  let nodeLlamaVersion = null;
  if (typeof nodeLlama?.getModuleVersion === 'function') {
    try {
      nodeLlamaVersion = await nodeLlama.getModuleVersion();
    } catch {
      // The fingerprint carries null; the record just misses.
    }
  }
  const cache = createLlamaBackendCache({ userDataPath, appVersion, nodeLlamaVersion, gpuInfo });
  return cache ? { read: cache.read } : undefined;
}

module.exports = {
  BACKEND_CACHE_FILENAME,
  BACKEND_CACHE_MAX_AGE_MS,
  createLlamaBackendCache,
  createReadOnlyLlamaBackendCache
};
