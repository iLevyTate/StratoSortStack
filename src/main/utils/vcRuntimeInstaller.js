// @ts-check
/**
 * In-app install of the bundled Microsoft Visual C++ Redistributable (Windows).
 *
 * Windows packages carry Microsoft's unmodified `vc_redist.<arch>.exe` under
 * `<resources>/assets/runtime/vcredist/` (staged by scripts/setup-vc-redist.js,
 * shipped by electron-builder's `win.extraResources`). The NSIS installer runs
 * it during setup; this module covers the zip build (no installer) and users
 * who declined the installer's prompt, behind the "Install now" action on the
 * ai.vc-runtime-missing banner.
 *
 * Guarantees:
 *   - The executable path is derived from process.resourcesPath and the app's
 *     own arch only. Nothing from the renderer reaches the path or arguments.
 *   - The file must pass Authenticode verification (Valid, O=Microsoft
 *     Corporation) immediately before it is run; otherwise it never runs.
 *   - It runs elevated through PowerShell `Start-Process -Verb RunAs` (Windows
 *     shows one UAC prompt: the runtime installs per-machine while StratoSort
 *     stays per-user). The path reaches PowerShell via an environment
 *     variable; the script itself is a fixed -EncodedCommand string.
 *   - Off Windows, or when the file is absent (dev builds), it reports
 *     `not-bundled` so the renderer falls back to Microsoft's download page.
 *
 * Never throws.
 *
 * @module utils/vcRuntimeInstaller
 */

const path = require('path');
const fs = require('fs');
const { asyncSpawn } = require('./asyncSpawnUtils');
const { powershellPath, encodedCommandArgs, verifyMicrosoftSignature } = require('./authenticode');
const { detectVcRuntime } = require('./vcRuntimeDetection');

/** Path segments under the resources directory (matches electron-builder win.extraResources). */
const VC_REDIST_RESOURCE_SEGMENTS = Object.freeze(['assets', 'runtime', 'vcredist']);

/** Arguments for an interactive, progress-only, no-reboot install. */
const VC_REDIST_INSTALL_ARGS = Object.freeze(['/install', '/passive', '/norestart']);

/** Environment variable that carries the installer path into PowerShell. */
const INSTALLER_ENV_VAR = 'SS_VC_REDIST_INSTALLER';

/** Marker the elevation script prints when Start-Process itself fails. */
const LAUNCH_FAILED_MARKER = 'SS_VC_REDIST_LAUNCH_FAILED';

/**
 * Generous ceiling for UAC + install. The preload budget for this channel is
 * the same (TIMEOUTS.USER_DIALOG); the installer keeps running if it is hit.
 */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

const ELEVATED_INSTALL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  `  $p = Start-Process -FilePath $env:${INSTALLER_ENV_VAR} -ArgumentList ${VC_REDIST_INSTALL_ARGS.map((a) => `'${a}'`).join(',')} -Verb RunAs -Wait -PassThru`,
  '  exit [int]$p.ExitCode',
  '} catch {',
  '  $code = 0',
  '  $e = $_.Exception',
  '  while ($e) {',
  '    if ($e -is [System.ComponentModel.Win32Exception]) { $code = $e.NativeErrorCode; break }',
  '    $e = $e.InnerException',
  '  }',
  '  if ($code -eq 1223) { exit 1223 }',
  `  [Console]::Out.WriteLine('${LAUNCH_FAILED_MARKER}: ' + $_.Exception.Message)`,
  '  exit 1',
  '}'
].join('\n');

/**
 * Microsoft's file name for an arch. The app's own arch decides: an x64 build
 * running under emulation on Arm needs the x64 runtime.
 * @param {string} [arch]
 * @returns {string}
 */
function vcRedistFileName(arch = process.arch) {
  return `vc_redist.${arch === 'arm64' ? 'arm64' : 'x64'}.exe`;
}

/**
 * @param {{ resourcesPath?: string, arch?: string }} [options]
 * @returns {string | null} null when no resources directory is known
 */
function bundledVcRedistPath({ resourcesPath = process.resourcesPath, arch = process.arch } = {}) {
  if (typeof resourcesPath !== 'string' || !resourcesPath) return null;
  return path.join(resourcesPath, ...VC_REDIST_RESOURCE_SEGMENTS, vcRedistFileName(arch));
}

/**
 * @typedef {Object} ExitCodeOutcome
 * @property {boolean} success
 * @property {boolean} cancelled
 * @property {boolean} needsRestart   Windows asked for a reboot to finish (3010 / 1641)
 * @property {string} meaning
 */

/**
 * Map a vc_redist (WiX Burn / MSI) exit code.
 *   0     installed
 *   1638  this or a newer version is already installed
 *   3010  installed, reboot required (1641: reboot initiated)
 *   1602  user cancelled the installer
 *   1223  ERROR_CANCELLED: the UAC prompt was declined
 *   other failure
 * @param {number | null | undefined} exitCode
 * @returns {ExitCodeOutcome}
 */
function mapVcRedistExitCode(exitCode) {
  switch (exitCode) {
    case 0:
      return { success: true, cancelled: false, needsRestart: false, meaning: 'installed' };
    case 1638:
      return {
        success: true,
        cancelled: false,
        needsRestart: false,
        meaning: 'already-installed'
      };
    case 3010:
    case 1641:
      return { success: true, cancelled: false, needsRestart: true, meaning: 'reboot-required' };
    case 1602:
    case 1223:
      return { success: false, cancelled: true, needsRestart: false, meaning: 'cancelled' };
    default:
      return { success: false, cancelled: false, needsRestart: false, meaning: 'failed' };
  }
}

/** @param {string} filePath */
async function defaultFileExists(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Run the installer elevated and wait for it.
 * @param {string} installerPath
 * @param {{ env?: NodeJS.ProcessEnv, spawnImpl?: typeof asyncSpawn }} [options]
 * @returns {Promise<{ exitCode: number | null, launchFailed: boolean, timedOut: boolean, detail?: string }>}
 */
async function runInstallerElevated(
  installerPath,
  { env = process.env, spawnImpl = asyncSpawn } = {}
) {
  const result = await spawnImpl(powershellPath(env), encodedCommandArgs(ELEVATED_INSTALL_SCRIPT), {
    env: { ...env, [INSTALLER_ENV_VAR]: installerPath },
    timeout: INSTALL_TIMEOUT_MS,
    windowsHide: true
  });
  const stdout = String(result?.stdout || '');
  const markerLine = stdout.split(/\r?\n/).find((line) => line.startsWith(LAUNCH_FAILED_MARKER));
  return {
    exitCode: typeof result?.status === 'number' ? result.status : null,
    launchFailed: Boolean(markerLine) || Boolean(result?.error && result?.status == null),
    timedOut: result?.timedOut === true,
    detail: markerLine
      ? markerLine.slice(LAUNCH_FAILED_MARKER.length + 1).trim()
      : result?.error?.message
  };
}

/**
 * @typedef {Object} VcRuntimeInstallResult
 * @property {boolean} success
 * @property {boolean} cancelled
 * @property {boolean} needsRestart     Windows needs a reboot before the DLLs are usable
 * @property {number | null} exitCode
 * @property {string} [reason]          'not-bundled' | 'signature-invalid' | 'launch-failed' |
 *                                      'timed-out' | 'installer-failed' | 'runtime-still-missing'
 * @property {boolean} [runtimePresent] detectVcRuntime() after the installer exited
 * @property {string} [error]
 */

/**
 * Install the bundled redistributable. Injectable for tests.
 *
 * @param {{
 *   platform?: string,
 *   arch?: string,
 *   resourcesPath?: string,
 *   env?: NodeJS.ProcessEnv,
 *   fileExists?: (filePath: string) => Promise<boolean>,
 *   verifySignature?: typeof verifyMicrosoftSignature,
 *   runElevated?: typeof runInstallerElevated,
 *   detect?: () => Promise<{ applicable: boolean, present: boolean }>,
 *   logger?: { info: Function, warn: Function }
 * }} [deps]
 * @returns {Promise<VcRuntimeInstallResult>}
 */
async function installBundledVcRuntime({
  platform = process.platform,
  arch = process.arch,
  resourcesPath = process.resourcesPath,
  env = process.env,
  fileExists = defaultFileExists,
  verifySignature = verifyMicrosoftSignature,
  runElevated = runInstallerElevated,
  detect = () => detectVcRuntime({ platform, arch, env }),
  logger
} = {}) {
  /** @type {(fields: Partial<VcRuntimeInstallResult>) => VcRuntimeInstallResult} */
  const result = (fields) => ({
    success: false,
    cancelled: false,
    needsRestart: false,
    exitCode: null,
    ...fields
  });

  try {
    if (platform !== 'win32') return result({ reason: 'not-bundled' });
    const installerPath = bundledVcRedistPath({ resourcesPath, arch });
    if (!installerPath || !(await fileExists(installerPath))) {
      return result({ reason: 'not-bundled' });
    }

    const verdict = await verifySignature(installerPath, { env });
    if (!verdict?.ok) {
      logger?.warn(
        '[VC-RUNTIME] Refusing to run the bundled redistributable: signature check failed',
        {
          reason: verdict?.reason,
          status: verdict?.info?.status,
          signer: verdict?.info?.subject
        }
      );
      return result({
        reason: 'signature-invalid',
        error: 'The bundled installer is not Microsoft-signed'
      });
    }

    logger?.info('[VC-RUNTIME] Running the bundled Visual C++ Redistributable', {
      file: path.basename(installerPath),
      version: verdict.info?.productVersion
    });
    const run = await runElevated(installerPath, { env });
    if (run.timedOut) {
      return result({ reason: 'timed-out', error: 'The installer did not finish in time' });
    }
    if (run.launchFailed) {
      return result({
        reason: 'launch-failed',
        error: run.detail || 'Could not start the installer'
      });
    }

    const outcome = mapVcRedistExitCode(run.exitCode);
    const runtime = await Promise.resolve()
      .then(detect)
      .catch(/** @returns {null} */ () => null);
    const runtimePresent = Boolean(runtime && (!runtime.applicable || runtime.present));
    logger?.info('[VC-RUNTIME] Redistributable installer finished', {
      exitCode: run.exitCode,
      meaning: outcome.meaning,
      runtimePresent
    });

    if (outcome.cancelled) {
      return result({ cancelled: true, exitCode: run.exitCode, runtimePresent });
    }
    if (!outcome.success) {
      return result({
        reason: 'installer-failed',
        exitCode: run.exitCode,
        runtimePresent,
        error: `The installer exited with code ${run.exitCode}`
      });
    }
    // A reboot-pending install may not have placed the DLLs yet; anything else
    // that reports success must have.
    if (!runtimePresent && !outcome.needsRestart) {
      return result({
        reason: 'runtime-still-missing',
        exitCode: run.exitCode,
        runtimePresent,
        error: 'The installer finished but the runtime is still missing'
      });
    }
    return result({
      success: true,
      needsRestart: outcome.needsRestart,
      exitCode: run.exitCode,
      runtimePresent
    });
  } catch (error) {
    logger?.warn('[VC-RUNTIME] Install failed unexpectedly', {
      error: /** @type {Error} */ (error)?.message
    });
    return result({ reason: 'installer-failed', error: /** @type {Error} */ (error)?.message });
  }
}

module.exports = {
  VC_REDIST_RESOURCE_SEGMENTS,
  VC_REDIST_INSTALL_ARGS,
  INSTALLER_ENV_VAR,
  LAUNCH_FAILED_MARKER,
  ELEVATED_INSTALL_SCRIPT,
  vcRedistFileName,
  bundledVcRedistPath,
  mapVcRedistExitCode,
  runInstallerElevated,
  installBundledVcRuntime
};
