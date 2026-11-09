// @ts-check
/**
 * Microsoft Visual C++ Redistributable detection (Windows).
 *
 * node-llama-cpp's prebuilt `llama-addon.node` and its ggml/llama DLLs import
 * MSVCP140.dll and VCRUNTIME140.dll. A fresh Windows install does not ship the
 * VC++ 2015-2022 runtime, so on such a machine every backend fails to load and
 * node-llama-cpp reports only `NoBinaryFoundError`. This module answers the
 * one question that turns that opaque error into an actionable one: is the
 * runtime missing?
 *
 * Detection is local and read-only: it checks System32 for the DLLs and, for
 * diagnostics only, reads the VC++ runtime registry key. Nothing here touches
 * the network; the download page is opened only when the user clicks the
 * banner action (see DegradedStateBanner).
 *
 * Never throws.
 *
 * @module utils/vcRuntimeDetection
 */

const path = require('path');
const fs = require('fs');
const { asyncSpawn } = require('./asyncSpawnUtils');

/** Microsoft's "Latest supported Visual C++ Redistributable downloads" page. */
const VC_REDIST_DOWNLOAD_PAGE_URL =
  'https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist';

/** DLLs the node-llama-cpp Windows binaries import from the VC++ runtime. */
const VC_RUNTIME_DLLS = Object.freeze(['msvcp140.dll', 'vcruntime140.dll']);

const REGISTRY_TIMEOUT_MS = 3000;

/**
 * Whether an engine initialization error means the native llama binaries could
 * not be loaded at all (as opposed to a config, model or GPU-only failure).
 * node-llama-cpp throws a plain Error whose message is `NoBinaryFoundError`
 * once every backend failed to load; a direct addon load failure surfaces as
 * ERR_DLOPEN_FAILED or a Windows loader message.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isNativeBinaryLoadError(error) {
  if (!error || typeof error !== 'object') return false;
  const err = /** @type {{ name?: unknown, message?: unknown, code?: unknown }} */ (error);
  const name = typeof err.name === 'string' ? err.name : '';
  const message = typeof err.message === 'string' ? err.message : '';
  if (name === 'NoBinaryFoundError' || /NoBinaryFoundError/.test(message)) return true;
  if (err.code === 'ERR_DLOPEN_FAILED') return true;
  return /specified module could not be found|not a valid Win32 application/i.test(message);
}

/**
 * Architecture label Microsoft uses for the redistributable download.
 * @param {string} [arch]
 * @returns {'x64' | 'ARM64'}
 */
function vcRuntimeArchLabel(arch = process.arch) {
  return arch === 'arm64' ? 'ARM64' : 'x64';
}

/**
 * The user-facing banner text for a missing runtime.
 * @param {string} [arch]
 * @returns {string}
 */
function vcRuntimeMissingMessage(arch = process.arch) {
  return (
    `Local AI needs the Microsoft Visual C++ Redistributable (${vcRuntimeArchLabel(arch)}), ` +
    "which isn't installed on this PC. Install it from Microsoft, then restart StratoSort."
  );
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function systemDirFromEnv(env) {
  return path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32');
}

/**
 * Read `HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\<arch>` Installed.
 * Diagnostic only: resolves true/false when the key answers, null when reg.exe
 * is unavailable, times out or the key is absent. Never rejects.
 *
 * @param {{ arch?: string, env?: NodeJS.ProcessEnv, spawnImpl?: typeof asyncSpawn }} [options]
 * @returns {Promise<boolean | null>}
 */
async function readVcRuntimeRegistryInstalled({
  arch = process.arch,
  env = process.env,
  spawnImpl = asyncSpawn
} = {}) {
  const key = `HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\${arch === 'arm64' ? 'arm64' : 'x64'}`;
  try {
    const result = await spawnImpl(
      path.join(systemDirFromEnv(env), 'reg.exe'),
      ['query', key, '/v', 'Installed'],
      { timeout: REGISTRY_TIMEOUT_MS, windowsHide: true }
    );
    if (!result || result.status !== 0) return null;
    const match = /Installed\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(String(result.stdout || ''));
    return match ? parseInt(match[1], 16) === 1 : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {Object} VcRuntimeStatus
 * @property {boolean} applicable   false off Windows; the other fields are then empty
 * @property {boolean} present      every required DLL exists in System32
 * @property {string[]} missingDlls
 * @property {string | null} systemDir
 * @property {boolean | null} registryInstalled  diagnostic only
 * @property {'x64' | 'ARM64' | null} archLabel
 */

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function defaultFileExists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether the VC++ runtime the llama binaries need is installed.
 *
 * @param {{
 *   platform?: string,
 *   arch?: string,
 *   env?: NodeJS.ProcessEnv,
 *   fileExists?: (filePath: string) => Promise<boolean>,
 *   readRegistryInstalled?: () => Promise<boolean | null>
 * }} [options] injectable for tests
 * @returns {Promise<VcRuntimeStatus>}
 */
async function detectVcRuntime({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  fileExists = defaultFileExists,
  readRegistryInstalled
} = {}) {
  if (platform !== 'win32') {
    return {
      applicable: false,
      present: true,
      missingDlls: [],
      systemDir: null,
      registryInstalled: null,
      archLabel: null
    };
  }
  const systemDir = systemDirFromEnv(env);
  /** @type {string[]} */
  const missingDlls = [];
  for (const dll of VC_RUNTIME_DLLS) {
    const exists = await Promise.resolve()
      .then(() => fileExists(path.join(systemDir, dll)))
      .catch(() => false);
    if (!exists) missingDlls.push(dll);
  }
  /** @type {boolean | null} */
  const registryInstalled = await Promise.resolve()
    .then(() =>
      readRegistryInstalled
        ? readRegistryInstalled()
        : readVcRuntimeRegistryInstalled({ arch, env })
    )
    .catch(/** @returns {null} */ () => null);
  return {
    applicable: true,
    present: missingDlls.length === 0,
    missingDlls,
    systemDir,
    registryInstalled: typeof registryInstalled === 'boolean' ? registryInstalled : null,
    archLabel: vcRuntimeArchLabel(arch)
  };
}

module.exports = {
  VC_REDIST_DOWNLOAD_PAGE_URL,
  VC_RUNTIME_DLLS,
  isNativeBinaryLoadError,
  vcRuntimeArchLabel,
  vcRuntimeMissingMessage,
  readVcRuntimeRegistryInstalled,
  detectVcRuntime
};
