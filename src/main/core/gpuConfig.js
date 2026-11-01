// @ts-check
/**
 * GPU Configuration
 *
 * GPU preference settings and hardware acceleration handling.
 * Extracted from simple-main.js for better maintainability.
 *
 * @module core/gpuConfig
 */

const { app } = require('electron');
const fsSync = require('fs');
const path = require('path');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('GPU');

/**
 * Path to the persistent GPU fallback flag file.
 * Written when repeated GPU crashes are detected; while it is fresh, every
 * launch runs with hardware acceleration disabled.
 */
/** @type {string | null} */
let _gpuFallbackFlagPath;
try {
  _gpuFallbackFlagPath = path.join(app.getPath('userData'), '.gpu-fallback');
} catch {
  _gpuFallbackFlagPath = null;
}

/**
 * How long the software fallback holds before a launch retries hardware
 * acceleration. A software-rendered session says nothing about whether the
 * driver works, so a stable run in that mode cannot clear the flag; only a
 * stable hardware-accelerated retry does (clearGpuFallbackAfterStableRun). A
 * retry that crashes again rewrites the flag, which restarts this period.
 */
const GPU_FALLBACK_RETRY_AFTER_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

/** @param {number | null} ms */
const toHours = (ms) => (ms === null ? null : Math.round(ms / (60 * 60 * 1000)));

/**
 * Read the flag left by an earlier session. Its age is the file's mtime, which
 * every write refreshes; an unreadable mtime counts as a fresh flag.
 * @returns {{ present: boolean, ageMs: number | null }}
 */
function readGpuFallbackFlag() {
  if (!_gpuFallbackFlagPath) return { present: false, ageMs: null };
  try {
    if (!fsSync.existsSync(_gpuFallbackFlagPath)) return { present: false, ageMs: null };
  } catch {
    // userData may not be accessible yet; treat as no flag
    return { present: false, ageMs: null };
  }
  try {
    const { mtimeMs } = fsSync.statSync(_gpuFallbackFlagPath);
    return { present: true, ageMs: Math.max(0, Date.now() - mtimeMs) };
  } catch {
    return { present: true, ageMs: null };
  }
}

/**
 * Check if GPU fallback was triggered by repeated GPU crashes in a previous session.
 * Must be evaluated at module load (before app.ready) so that
 * app.disableHardwareAcceleration() can be called in time. The flag stays on
 * disk: deleting it on read made a broken driver alternate between a slow
 * hardware launch and a fast software one.
 */
const initialFallbackFlag = readGpuFallbackFlag();
const gpuFallbackTriggered =
  initialFallbackFlag.present &&
  (initialFallbackFlag.ageMs === null || initialFallbackFlag.ageMs < GPU_FALLBACK_RETRY_AFTER_MS);
if (gpuFallbackTriggered) {
  logger.warn(
    '[GPU] Auto-disabling hardware acceleration due to repeated GPU crashes in an earlier session',
    { flagAgeH: toHours(initialFallbackFlag.ageMs) }
  );
} else if (initialFallbackFlag.present) {
  logger.info('[GPU] GPU fallback period over; retrying hardware acceleration', {
    flagAgeH: toHours(initialFallbackFlag.ageMs)
  });
}

/**
 * Check if software rendering is forced
 */
const forceSoftwareRenderer =
  process.env.STRATOSORT_FORCE_SOFTWARE_GPU === '1' ||
  process.env.ELECTRON_FORCE_SOFTWARE === '1' ||
  gpuFallbackTriggered ||
  process.argv.includes('--safe-mode');

/**
 * Time-based sliding window for GPU failure tracking
 */
const GPU_FAILURE_RESET_WINDOW = 60 * 60 * 1000; // 1 hour
let gpuFailureCount = 0;
let lastGpuFailureTime = 0;
// Every GPU process exit this session, never reset: any exit disqualifies the
// session from clearing the fallback flag.
let sessionGpuExitCount = 0;

/**
 * Window accessors injected by simple-main.js (this module must not import it).
 * @type {{ getMainWindow: (() => any) | null, isFirstShowPending: (() => boolean) | null }}
 */
const windowAccess = { getMainWindow: null, isFirstShowPending: null };

function shouldForceInferenceCpuMode() {
  return (
    process.env.STRATOSORT_FORCE_SOFTWARE_GPU === '1' ||
    process.env.ELECTRON_FORCE_SOFTWARE === '1' ||
    process.argv.includes('--safe-mode')
  );
}

/**
 * Raster switches forced on this platform: none on Windows and macOS, the
 * historical pair on Linux (see initializeGpuConfig).
 *
 * @returns {string[]}
 */
function getForcedRasterSwitches() {
  return process.platform === 'linux' ? ['enable-gpu-rasterization', 'enable-zero-copy'] : [];
}

/**
 * Initialize GPU configuration
 * Must be called before app.ready
 * @param {{ getMainWindow?: () => any, isFirstShowPending?: () => boolean }} [options]
 *   getMainWindow returns the main BrowserWindow (or null); isFirstShowPending
 *   is true from window creation until its first 'show'.
 */
function initializeGpuConfig({ getMainWindow, isFirstShowPending } = {}) {
  if (typeof getMainWindow === 'function') windowAccess.getMainWindow = getMainWindow;
  if (typeof isFirstShowPending === 'function') {
    windowAccess.isFirstShowPending = isFirstShowPending;
  }
  try {
    if (forceSoftwareRenderer) {
      app.disableHardwareAcceleration();
      if (shouldForceInferenceCpuMode()) {
        process.env.STRATOSORT_FORCE_SOFTWARE_GPU = '1';
      }
      logger.warn('[GPU] Hardware acceleration disabled', {
        reason: shouldForceInferenceCpuMode() ? 'explicit-software-mode' : 'renderer-gpu-fallback',
        inferenceGpuMode: shouldForceInferenceCpuMode() ? 'cpu-only' : 'unchanged'
      });
    } else {
      // ANGLE-over-D3D11 exists only on Windows; on macOS (Metal) and Linux
      // (GL/Vulkan) forcing it makes Chromium's GPU init fall back or fail,
      // silently costing hardware acceleration. Only pin the backend where
      // it is valid — other platforms keep Chromium's default selection
      // unless ANGLE_BACKEND explicitly overrides.
      const angleBackend =
        process.env.ANGLE_BACKEND || (process.platform === 'win32' ? 'd3d11' : null);
      if (angleBackend) {
        app.commandLine.appendSwitch('use-angle', angleBackend);
      }

      // Only set use-gl if explicitly requested
      const glImplementation = process.env.STRATOSORT_GL_IMPLEMENTATION;
      if (glImplementation) {
        app.commandLine.appendSwitch('use-gl', glImplementation);
        logger.info(`[GPU] Custom GL implementation set: ${glImplementation}`);
      }

      // Safer GPU settings
      if (process.env.STRATOSORT_IGNORE_GPU_BLOCKLIST === '1') {
        app.commandLine.appendSwitch('ignore-gpu-blocklist');
        logger.warn('[GPU] GPU blocklist ignored via STRATOSORT_IGNORE_GPU_BLOCKLIST');
      }

      // Windows and macOS: no enable-gpu-rasterization / enable-zero-copy.
      // Both override Chromium's per-driver decisions; the first bypasses the
      // GPU rasterization blocklist (GPU raster is already on by default
      // there where the driver is not blocklisted), the second forces
      // native-buffer tile uploads. Either only changes behaviour on drivers
      // Chromium already distrusts.
      // Linux keeps both, as every earlier release set them on all platforms:
      // Chromium's Linux raster default varies with version and driver, and
      // the AppImage has not been measured without them.
      const rasterSwitches = getForcedRasterSwitches();
      for (const rasterSwitch of rasterSwitches) {
        app.commandLine.appendSwitch(rasterSwitch);
      }
      logger.info(`[GPU] Flags set: ANGLE=${angleBackend}`, { rasterSwitches });
    }
  } catch (e) {
    logger.warn('[GPU] Failed to apply GPU flags:', e?.message || 'Unknown error');
  }
}

/**
 * A GPU process that dies before the first show can hold ready-to-show back
 * until Chromium has restarted it or given up on it. Show the window now so
 * the user gets a frame instead of a busy cursor; the renderer paints into it
 * once the compositor is back. Only the startup show is forced: a window the
 * user hid (tray, background mode) stays hidden.
 * @param {any} details
 */
function showWindowAwaitingFirstShow(details) {
  try {
    if (!windowAccess.isFirstShowPending?.()) return;
    const win = windowAccess.getMainWindow?.();
    if (!win || win.isDestroyed?.() || win.isVisible?.()) return;
    logger.warn('[GPU] GPU process exited before the window was shown; showing it now', {
      reason: details?.reason,
      uptimeS: Math.round(process.uptime())
    });
    win.show();
  } catch (error) {
    logger.debug('[GPU] Could not show the window after a GPU process exit', {
      error: error?.message
    });
  }
}

/**
 * Handle GPU process exit events
 * @param {any} event - Event object
 * @param {any} details - Event details
 */
function handleGpuProcessGone(event, details) {
  if (details?.type === 'GPU') {
    const now = Date.now();

    // Reset counter if last failure was more than 1 hour ago
    if (now - lastGpuFailureTime > GPU_FAILURE_RESET_WINDOW) {
      gpuFailureCount = 0;
      logger.debug('[GPU] Failure counter reset after stability window');
    }

    gpuFailureCount += 1;
    sessionGpuExitCount += 1;
    lastGpuFailureTime = now;

    logger.error('[GPU] Process exited', {
      reason: details?.reason,
      exitCode: details?.exitCode,
      crashCount: gpuFailureCount,
      lastFailure: new Date(lastGpuFailureTime).toISOString()
    });

    showWindowAwaitingFirstShow(details);

    if (gpuFailureCount >= 3 && _gpuFallbackFlagPath) {
      // Write persistent flag so the next launch auto-disables GPU
      fsSync.promises
        .writeFile(_gpuFallbackFlagPath, Date.now().toString())
        .then(
          /** @returns {undefined} */ () => {
            logger.error(
              '[GPU] Repeated GPU failures detected — auto-disabling hardware acceleration on next launch'
            );
            return undefined;
          }
        )
        .catch((/** @type {any} */ flagErr) => {
          logger.warn('[GPU] Failed to write GPU fallback flag:', flagErr?.message);
        });
    } else if (gpuFailureCount >= 2 && process.env.STRATOSORT_FORCE_SOFTWARE_GPU !== '1') {
      logger.warn(
        '[GPU] Repeated GPU failures detected. Set STRATOSORT_FORCE_SOFTWARE_GPU=1 to force software rendering.'
      );
    }
  }
}

/**
 * Clear the sticky fallback flag once hardware acceleration has run stably.
 * simple-main.js calls this TIMEOUTS.GPU_FALLBACK_STABLE_RUN after creating the
 * main window, next to its .crash-timestamps reset. The flag is kept when this
 * session rendered in software (nothing was learned about the driver), when
 * any GPU process exited this session, or when the window is not visible.
 * Every outcome with a flag present is logged: this runs after file logging
 * starts, unlike the module-load decision above.
 * @returns {'no-flag' | 'cleared' | 'kept-software-mode' | 'kept-gpu-exits' | 'kept-window-hidden' | 'kept-error'}
 */
function clearGpuFallbackAfterStableRun() {
  const flag = readGpuFallbackFlag();
  if (!flag.present || !_gpuFallbackFlagPath) return 'no-flag';
  const detail = {
    flagAgeH: toHours(flag.ageMs),
    gpuExitsThisSession: sessionGpuExitCount
  };

  if (forceSoftwareRenderer) {
    logger.info('[GPU] Software rendering fallback still active', {
      ...detail,
      retryHardwareInH:
        flag.ageMs === null ? null : toHours(Math.max(0, GPU_FALLBACK_RETRY_AFTER_MS - flag.ageMs))
    });
    return 'kept-software-mode';
  }
  if (sessionGpuExitCount > 0) {
    logger.warn('[GPU] Keeping the GPU fallback flag: the GPU process exited this session', detail);
    return 'kept-gpu-exits';
  }

  let windowVisible = false;
  try {
    const win = windowAccess.getMainWindow?.();
    windowVisible = Boolean(win && !win.isDestroyed?.() && win.isVisible?.());
  } catch {
    // A destroyed window can throw on access; treat it as not visible.
  }
  if (!windowVisible) {
    logger.info('[GPU] Keeping the GPU fallback flag until a run with a visible window', detail);
    return 'kept-window-hidden';
  }

  try {
    fsSync.unlinkSync(_gpuFallbackFlagPath);
    logger.info('[GPU] Hardware acceleration ran stably; GPU fallback flag cleared', detail);
    return 'cleared';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'no-flag';
    logger.warn('[GPU] Failed to clear the GPU fallback flag', {
      ...detail,
      error: error?.message
    });
    return 'kept-error';
  }
}

module.exports = {
  forceSoftwareRenderer,
  shouldForceInferenceCpuMode,
  initializeGpuConfig,
  handleGpuProcessGone,
  clearGpuFallbackAfterStableRun,
  GPU_FALLBACK_RETRY_AFTER_MS
};
