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
 * Written when repeated GPU crashes are detected; read on next launch
 * to auto-disable hardware acceleration.
 */
/** @type {string | null} */
let _gpuFallbackFlagPath;
try {
  _gpuFallbackFlagPath = path.join(app.getPath('userData'), '.gpu-fallback');
} catch {
  _gpuFallbackFlagPath = null;
}

/**
 * Check if GPU fallback was triggered by repeated GPU crashes in a previous session.
 * Must be evaluated at module load (before app.ready) so that
 * app.disableHardwareAcceleration() can be called in time.
 */
let gpuFallbackTriggered = false;
try {
  if (_gpuFallbackFlagPath && fsSync.existsSync(_gpuFallbackFlagPath)) {
    gpuFallbackTriggered = true;
    // Remove the flag so it doesn't persist indefinitely.
    // If GPU crashes again, the flag will be re-written.
    fsSync.unlinkSync(_gpuFallbackFlagPath);
    logger.warn(
      '[GPU] Auto-disabling hardware acceleration due to repeated GPU crashes in previous session'
    );
  }
} catch {
  // userData may not be accessible yet; ignore
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

function shouldForceInferenceCpuMode() {
  return (
    process.env.STRATOSORT_FORCE_SOFTWARE_GPU === '1' ||
    process.env.ELECTRON_FORCE_SOFTWARE === '1' ||
    process.argv.includes('--safe-mode')
  );
}

/**
 * Initialize GPU configuration
 * Must be called before app.ready
 */
function initializeGpuConfig() {
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

      logger.info(`[GPU] Flags set: ANGLE=${angleBackend}`);
    }
  } catch (e) {
    logger.warn('[GPU] Failed to apply GPU flags:', e?.message || 'Unknown error');
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
    lastGpuFailureTime = now;

    logger.error('[GPU] Process exited', {
      reason: details?.reason,
      exitCode: details?.exitCode,
      crashCount: gpuFailureCount,
      lastFailure: new Date(lastGpuFailureTime).toISOString()
    });

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
 * Apply production GPU optimizations
 * @param {boolean} isDev - Whether running in development mode
 */
function applyProductionOptimizations(isDev) {
  if (!forceSoftwareRenderer) {
    app.commandLine.appendSwitch('enable-gpu-rasterization');
    app.commandLine.appendSwitch('enable-zero-copy');
  }

  if (isDev) {
    logger.info('[DEVELOPMENT] GPU acceleration flags enabled for development');
  } else {
    logger.info('[PRODUCTION] GPU acceleration optimizations enabled');
  }
}

module.exports = {
  forceSoftwareRenderer,
  shouldForceInferenceCpuMode,
  initializeGpuConfig,
  handleGpuProcessGone,
  applyProductionOptimizations
};
