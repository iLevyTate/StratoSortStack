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
 *   - It runs only while the runtime is missing (detectVcRuntime). When it is
 *     present the call answers `already-installed` without touching the file,
 *     so a renderer cannot use it to raise UAC prompts at will.
 *   - The executable path is derived from process.resourcesPath and the app's
 *     own arch only. Nothing from the renderer reaches the path or arguments.
 *   - The bundled file is copied into a fresh per-call directory under the OS
 *     temp dir (fs.mkdtemp). That copy is Authenticode-verified (Valid,
 *     O=Microsoft Corporation) and the same copy is what runs, so replacing
 *     the bundled file after the check does not change what runs elevated.
 *     The directory is removed afterwards.
 *   - It runs elevated through PowerShell `Start-Process -Verb RunAs` (Windows
 *     shows one UAC prompt: the runtime installs per-machine while StratoSort
 *     stays per-user). The path reaches PowerShell via an environment
 *     variable; the script itself is a fixed -EncodedCommand string that also
 *     runs in ConstrainedLanguage mode (managed PCs).
 *   - A signature PowerShell could not check at all (missing, blocked, timed
 *     out) reports `signature-unreadable`, kept apart from a signature that
 *     was read and is wrong (`signature-invalid`).
 *   - Off Windows, or when the file is absent (dev builds), it reports
 *     `not-bundled` so the renderer falls back to Microsoft's download page.
 *
 * Never throws.
 *
 * @module utils/vcRuntimeInstaller
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { asyncSpawn } = require('./asyncSpawnUtils');
const {
  powershellPath,
  encodedCommandArgs,
  verifyMicrosoftSignature,
  windowsPowerShellEnv
} = require('./authenticode');
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
 * Generous ceiling for UAC + install. The preload budget for this channel
 * (VC_RUNTIME_INSTALL_INVOKE_TIMEOUT_MS in src/shared/ipcInvokeTimeout.js) is
 * a minute longer, so main always answers `timed-out` before the renderer
 * would see a raw IPC timeout. The installer keeps running if this is hit; a
 * second attempt meanwhile exits 1618 (`install-in-progress`).
 */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** Prefix of the per-call temp directory that holds the verified copy. */
const STAGING_DIR_PREFIX = 'stratosort-vcredist-';

/**
 * The elevated run. It must work in ConstrainedLanguage mode too: cmdlets,
 * property reads, string methods, Write-Output and `exit` only (no
 * [Console]::..., no non-core type literals).
 *
 * Start-Process reports a failed launch as an InvalidOperationException whose
 * message embeds the Win32 error text; there is no inner Win32Exception to
 * read a code from. A declined UAC prompt is ERROR_CANCELLED (1223), and
 * `net.exe helpmsg 1223` prints that same system text in the PC's language,
 * so a message containing it exits 1223. Anything else prints the
 * launch-failed marker and exits 1.
 */
const ELEVATED_INSTALL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  `  $p = Start-Process -FilePath $env:${INSTALLER_ENV_VAR} -ArgumentList ${VC_REDIST_INSTALL_ARGS.map((a) => `'${a}'`).join(',')} -Verb RunAs -Wait -PassThru`,
  '  exit [int]$p.ExitCode',
  '} catch {',
  '  $message = [string]$_.Exception.Message',
  "  $cancelText = ''",
  '  try {',
  "    $cancelText = ((& (Join-Path $env:SystemRoot 'System32\\net.exe') helpmsg 1223) | Where-Object { $_ }) -join ' '",
  '  } catch { }',
  '  $cancelText = ([string]$cancelText).Trim()',
  '  if ($cancelText -and $message.Contains($cancelText)) { exit 1223 }',
  `  Write-Output ('${LAUNCH_FAILED_MARKER}: ' + $message)`,
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
 *   1618  ERROR_INSTALL_ALREADY_RUNNING: another installation is in progress
 *         (for example an earlier vc_redist run that outlived our timeout)
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
    case 1618:
      return {
        success: false,
        cancelled: false,
        needsRestart: false,
        meaning: 'install-in-progress'
      };
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
 * Remove a staging directory. Best effort: the installer may still hold the
 * file (after a timeout), so a failure is reported, not thrown.
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function removeStagingDir(dir) {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy the bundled installer into a fresh directory of its own (fs.mkdtemp
 * under the OS temp dir), so the file that is verified and run is one nothing
 * else knew the path of when it was checked.
 *
 * @param {string} sourcePath
 * @param {{ tmpDir?: string }} [options]
 * @returns {Promise<{ path: string, cleanup: () => Promise<boolean> }>}
 */
async function stageInstallerCopy(sourcePath, { tmpDir = os.tmpdir() } = {}) {
  const dir = await fs.promises.mkdtemp(path.join(tmpDir, STAGING_DIR_PREFIX));
  const copyPath = path.join(dir, path.basename(sourcePath));
  try {
    await fs.promises.copyFile(sourcePath, copyPath, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    await removeStagingDir(dir);
    throw error;
  }
  return { path: copyPath, cleanup: () => removeStagingDir(dir) };
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
    env: windowsPowerShellEnv(env, { [INSTALLER_ENV_VAR]: installerPath }),
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
 * @property {string} [reason]          'already-installed' | 'not-bundled' |
 *                                      'signature-unreadable' | 'signature-invalid' |
 *                                      'launch-failed' | 'timed-out' | 'install-in-progress' |
 *                                      'installer-failed' | 'runtime-still-missing'
 * @property {boolean} [runtimePresent] detectVcRuntime() before (already-installed) or after
 *                                      the installer exited
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
 *   stageCopy?: (sourcePath: string) => Promise<{ path: string, cleanup: () => Promise<boolean> }>,
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
  stageCopy = stageInstallerCopy,
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
  const probe = () =>
    Promise.resolve()
      .then(detect)
      .catch(/** @returns {null} */ () => null);

  /** @type {(() => Promise<boolean>) | null} */
  let cleanup = null;
  try {
    if (platform !== 'win32') return result({ reason: 'not-bundled' });

    // Only a missing runtime warrants an elevated installer. A probe that
    // fails says nothing either way, so it does not block the install.
    const before = await probe();
    if (before?.applicable && before.present) {
      logger?.info('[VC-RUNTIME] Not running the redistributable: the runtime is already present');
      return result({ reason: 'already-installed', runtimePresent: true });
    }

    const installerPath = bundledVcRedistPath({ resourcesPath, arch });
    if (!installerPath || !(await fileExists(installerPath))) {
      return result({ reason: 'not-bundled' });
    }

    /** @type {string} */
    let stagedPath;
    try {
      const staged = await stageCopy(installerPath);
      stagedPath = staged.path;
      cleanup = staged.cleanup;
    } catch (error) {
      logger?.warn('[VC-RUNTIME] Could not copy the bundled redistributable to a temp folder', {
        error: /** @type {Error} */ (error)?.message
      });
      return result({
        reason: 'launch-failed',
        error: `Could not prepare the installer: ${/** @type {Error} */ (error)?.message || 'copy failed'}`
      });
    }

    const verdict = await verifySignature(stagedPath, { env });
    if (!verdict?.ok) {
      const unreadable = !verdict || verdict.reason === 'unreadable';
      logger?.warn(
        unreadable
          ? '[VC-RUNTIME] Not running the bundled redistributable: its signature could not be checked on this PC'
          : '[VC-RUNTIME] Refusing to run the bundled redistributable: signature check failed',
        {
          reason: verdict?.reason,
          status: verdict?.info?.status,
          signer: verdict?.info?.subject
        }
      );
      return unreadable
        ? result({
            reason: 'signature-unreadable',
            error: "Couldn't check the installer's signature on this PC"
          })
        : result({
            reason: 'signature-invalid',
            error: 'The bundled installer is not Microsoft-signed'
          });
    }

    logger?.info('[VC-RUNTIME] Running the bundled Visual C++ Redistributable', {
      file: path.basename(installerPath),
      version: verdict.info?.productVersion
    });
    const run = await runElevated(stagedPath, { env });
    if (run.timedOut) {
      return result({
        reason: 'timed-out',
        error:
          'The installer did not finish in time. It may still be running; wait for it to close before trying again'
      });
    }
    if (run.launchFailed) {
      return result({
        reason: 'launch-failed',
        error: run.detail || 'Could not start the installer'
      });
    }

    const outcome = mapVcRedistExitCode(run.exitCode);
    const runtime = await probe();
    const runtimePresent = Boolean(runtime && (!runtime.applicable || runtime.present));
    logger?.info('[VC-RUNTIME] Redistributable installer finished', {
      exitCode: run.exitCode,
      meaning: outcome.meaning,
      runtimePresent
    });

    if (outcome.cancelled) {
      return result({ cancelled: true, exitCode: run.exitCode, runtimePresent });
    }
    if (outcome.meaning === 'install-in-progress') {
      return result({
        reason: 'install-in-progress',
        exitCode: run.exitCode,
        runtimePresent,
        error: 'Another installation is already running on this PC'
      });
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
  } finally {
    if (cleanup) {
      const removed = await cleanup().catch(() => false);
      if (!removed) {
        logger?.warn('[VC-RUNTIME] Could not remove the temporary installer copy');
      }
    }
  }
}

module.exports = {
  VC_REDIST_RESOURCE_SEGMENTS,
  VC_REDIST_INSTALL_ARGS,
  INSTALLER_ENV_VAR,
  LAUNCH_FAILED_MARKER,
  INSTALL_TIMEOUT_MS,
  STAGING_DIR_PREFIX,
  ELEVATED_INSTALL_SCRIPT,
  vcRedistFileName,
  bundledVcRedistPath,
  mapVcRedistExitCode,
  stageInstallerCopy,
  runInstallerElevated,
  installBundledVcRuntime
};
