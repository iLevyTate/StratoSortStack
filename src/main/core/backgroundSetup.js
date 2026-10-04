// @ts-check
/**
 * Background Setup Module
 *
 * Fully automated first-run dependency setup in the background:
 * - Download missing CORE GGUF models (embedding + text). The vision model is
 *   never auto-downloaded here — it is fetched only via the explicit
 *   ModelSetupWizard flow. Honors the `modelAutoDownloadSkipped` setting
 *   ("Continue with limited AI"): when set, no background downloads happen.
 * - Record setup completion marker
 *
 * OCR is handled by the bundled tesseract.js (no external install needed).
 * Vision runtime (llama-server) is bundled via assets/runtime/ in production
 * builds and downloaded on-demand in dev via VisionService._ensureBinary().
 *
 * This runs asynchronously and does not block startup.
 *
 * @module core/backgroundSetup
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('node:crypto');

const { createLogger } = require('../../shared/logger');
const { safeSend } = require('../ipc/ipcWrappers');
const { getInstance: getModelDownloadManager } = require('../services/ModelDownloadManager');
const { getInstance: getLlamaService } = require('../services/LlamaService');
const { ensureResolvedModelsPath } = require('../services/modelPathResolver');
const { container, ServiceIds } = require('../services/ServiceContainer');
const { AI_DEFAULTS, IPC_EVENTS } = require('../../shared/constants');
const { getModel } = require('../../shared/modelRegistry');
const { toPercentNumber, toFiniteNonNegativeNumber } = require('../../shared/numberUtils');

const logger = createLogger('BackgroundSetup');

// Track background setup status for visibility
/** @type {{ complete: boolean, error: any, startedAt: any, completedAt: any }} */
const backgroundSetupStatus = {
  complete: false,
  error: null,
  startedAt: null,
  completedAt: null
};

/**
 * Get current background setup status
 * @returns {any} Status object
 */
function getBackgroundSetupStatus() {
  return { ...backgroundSetupStatus };
}

/**
 * Notify renderer of dependency setup progress.
 * @param {any} payload - Progress payload
 */
function emitDependencyProgress(payload) {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      safeSend(win.webContents, IPC_EVENTS.OPERATION_PROGRESS, {
        type: 'dependency',
        ...(payload || {})
      });
    }
  } catch (error) {
    logger.debug('[BACKGROUND] Could not emit dependency progress:', error.message);
  }
}

/**
 * Check if this is a first run
 * @returns {Promise<boolean>}
 */
async function checkFirstRun() {
  const setupMarker = path.join(app.getPath('userData'), 'dependency-setup-complete.marker');

  try {
    await fs.access(setupMarker);
    return false;
  } catch (err) {
    logger.debug('[BACKGROUND] First-run marker missing or inaccessible', {
      error: err?.message || String(err)
    });
    return true;
  }
}

/**
 * Mark setup as complete by writing marker file.
 * @returns {Promise<boolean>} True if the marker was written.
 */
async function markSetupComplete() {
  const setupMarker = path.join(app.getPath('userData'), 'dependency-setup-complete.marker');

  // Use atomic write (temp + rename) to prevent corruption
  try {
    const tempPath = `${setupMarker}.tmp.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
    await fs.writeFile(tempPath, new Date().toISOString());
    await fs.rename(tempPath, setupMarker);
    return true;
  } catch (e) {
    // warn, not debug: a failed marker write means every launch re-runs
    // first-run setup (re-probing models, re-emitting progress) — worth a
    // visible signal in the log when diagnosing "setup runs every time".
    logger.warn('[BACKGROUND] Could not create setup marker; first-run setup will repeat', {
      setupMarker,
      error: e.message
    });
    return false;
  }
}

/**
 * Download missing GGUF models in the background.
 * Non-blocking: failures are logged but do not prevent app startup.
 */
function emitLegacyModelsWarning() {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      safeSend(win.webContents, IPC_EVENTS.NOTIFICATION, {
        message:
          'Downloading models to legacy directory. Consider moving models to the current app data folder.',
        severity: 'warning',
        duration: 6000
      });
    }
  } catch (error) {
    logger.debug('[BACKGROUND] Could not emit legacy models warning:', error.message);
  }
}

/**
 * Whether the user explicitly declined background model downloads (the
 * "Continue with limited AI" choice on the welcome screen). Persisted as the
 * `modelAutoDownloadSkipped` setting; cleared when the user explicitly starts
 * a download in the ModelSetupWizard. Fails open (false) so a broken settings
 * read can never silently disable first-run provisioning.
 * @returns {Promise<boolean>}
 */
async function isModelAutoDownloadSkipped() {
  try {
    const settingsService = /** @type {any} */ (container.tryResolve(ServiceIds.SETTINGS));
    if (!settingsService?.load) return false;
    const settings = await settingsService.load();
    return settings?.modelAutoDownloadSkipped === true;
  } catch (error) {
    logger.debug('[BACKGROUND] Could not read modelAutoDownloadSkipped (assuming false)', {
      error: error?.message || String(error)
    });
    return false;
  }
}

async function downloadMissingModels() {
  try {
    const llamaService = getLlamaService();
    const downloadManager = getModelDownloadManager();
    await downloadManager.initialize();

    const cfg = await llamaService.getConfig();
    const availableModels = await llamaService.listModels();
    const availableNames = new Set(
      availableModels.map((/** @type {any} */ m) => m.name || m.filename || '')
    );
    const coreModels = [
      cfg.embeddingModel || AI_DEFAULTS.EMBEDDING.MODEL,
      cfg.textModel || AI_DEFAULTS.TEXT.MODEL
    ].filter(Boolean);
    const requiredModels = [...coreModels];

    // The vision model (~4 GB) is deliberately NOT auto-downloaded here — it
    // downloads only through the explicit ModelSetupWizard flow where the user
    // consents to the transfer. One narrow repair case remains: when the vision
    // model is already present locally (i.e. the user explicitly downloaded it
    // earlier) but its small companion projector (mmproj, required for image
    // understanding) is missing, re-fetch just the projector.
    const visionModel = cfg.visionModel || AI_DEFAULTS.IMAGE.MODEL;
    if (visionModel && availableNames.has(visionModel)) {
      const visionInfo = getModel(visionModel);
      if (visionInfo?.clipModel?.name) {
        requiredModels.push(visionInfo.clipModel.name);
      }
    }

    const missing = requiredModels.filter((name) => !availableNames.has(name));
    if (missing.length === 0) {
      logger.info('[BACKGROUND] All required models are available');
      emitDependencyProgress({
        message: 'All AI models available.',
        stage: 'models-ready'
      });
      return true;
    }

    // Consent gate: the user chose "Continue with limited AI". No background
    // downloads until they explicitly start one in the ModelSetupWizard
    // (which clears the setting).
    if (await isModelAutoDownloadSkipped()) {
      logger.info('[BACKGROUND] Model auto-download declined by user setting; skipping', {
        missing
      });
      emitDependencyProgress({
        message: 'AI model downloads are paused (your choice). Open model setup to download.',
        stage: 'models-skipped'
      });
      return false;
    }

    logger.info('[BACKGROUND] Missing models, starting background download', {
      missing,
      available: Array.from(availableNames)
    });

    const resolved = await ensureResolvedModelsPath();
    if (resolved.source === 'legacy') {
      logger.warn('[BACKGROUND] Downloading to legacy models directory', {
        modelsPath: /** @type {any} */ (resolved).modelsPath,
        currentModelsPath: /** @type {any} */ (resolved).currentModelsPath
      });
      emitLegacyModelsWarning();
    }

    const failedModels = [];
    for (const modelName of missing) {
      emitDependencyProgress({
        message: `Downloading model: ${modelName}…`,
        dependency: 'models',
        stage: 'model-download',
        model: modelName
      });

      try {
        /** @type {any} */
        let latestProgress = null;
        const downloadResult = await downloadManager.downloadModel(modelName, {
          onProgress: (/** @type {any} */ progress) => {
            try {
              latestProgress = progress || latestProgress;
              const resolvedFilename = progress?.filename || modelName;
              const win = BrowserWindow.getAllWindows()[0];
              if (win && !win.isDestroyed()) {
                const percent = toPercentNumber(progress?.percent ?? progress?.percentage);
                safeSend(win.webContents, IPC_EVENTS.OPERATION_PROGRESS, {
                  type: 'model-download',
                  model: modelName,
                  progress: {
                    model: modelName,
                    filename: resolvedFilename,
                    percent,
                    downloadedBytes: toFiniteNonNegativeNumber(progress?.downloadedBytes),
                    totalBytes: toFiniteNonNegativeNumber(progress?.totalBytes),
                    speedBps: toFiniteNonNegativeNumber(progress?.speedBps),
                    etaSeconds: toFiniteNonNegativeNumber(progress?.etaSeconds)
                  }
                });
              }
            } catch (err) {
              logger.debug('[BACKGROUND] Progress IPC skipped (window closing)', {
                error: err?.message || String(err)
              });
            }
          }
        });

        const fallbackModelInfo = getModel(modelName);
        const expectedModelBytes = Number(fallbackModelInfo?.size) || 0;
        const expectedCompanionBytes = Number(fallbackModelInfo?.clipModel?.size) || 0;
        const degraded = Boolean(downloadResult?.degraded);
        const companionDownload = downloadResult?.companionDownload || null;
        const finalTotalBytes = Math.max(
          Number(downloadResult?.totalBytes) || 0,
          expectedModelBytes + expectedCompanionBytes
        );
        const finalDownloadedBytes = Math.max(
          Number(downloadResult?.downloadedBytes) || 0,
          latestProgress?.downloadedBytes || 0,
          expectedModelBytes
        );
        const win = BrowserWindow.getAllWindows()[0];
        if (win && !win.isDestroyed()) {
          safeSend(win.webContents, IPC_EVENTS.OPERATION_PROGRESS, {
            type: 'model-download-complete',
            model: modelName,
            success: !degraded,
            degraded,
            progress: {
              model: modelName,
              filename: modelName,
              percent:
                finalTotalBytes > 0
                  ? Math.max(
                      0,
                      Math.min(100, Math.round((finalDownloadedBytes / finalTotalBytes) * 100))
                    )
                  : 100,
              downloadedBytes: finalDownloadedBytes,
              totalBytes: finalTotalBytes,
              speedBps: 0,
              etaSeconds: 0,
              companion: companionDownload
            }
          });
        }

        logger.info(`[BACKGROUND] Model downloaded: ${modelName}`, {
          degraded,
          companion: companionDownload
        });
        emitDependencyProgress({
          message: degraded
            ? `Model ready with warnings: ${modelName}`
            : `Model ready: ${modelName}`,
          dependency: 'models',
          stage: degraded ? 'model-ready-degraded' : 'model-ready',
          model: modelName,
          degraded,
          companion: companionDownload
        });
      } catch (downloadError) {
        failedModels.push(modelName);
        logger.warn(`[BACKGROUND] Failed to download model: ${modelName}`, {
          error: downloadError.message
        });
        emitDependencyProgress({
          message: `Model download failed: ${modelName} (${downloadError.message})`,
          dependency: 'models',
          stage: 'error',
          model: modelName
        });
      }
    }
    // Setup "succeeded" only when the core (embedding + text) models are in
    // place — vision is optional and must not hold the setup marker hostage.
    const coreFailed = failedModels.filter((name) => coreModels.includes(name));
    return coreFailed.length === 0;
  } catch (error) {
    logger.warn('[BACKGROUND] Model provisioning failed (non-fatal)', {
      error: error.message
    });
    return false;
  }
}

async function runAutomatedDependencySetup() {
  emitDependencyProgress({ message: 'Checking runtime dependencies…', stage: 'check' });

  // Download missing GGUF models (best-effort, non-blocking).
  // OCR uses bundled tesseract.js — no external install needed.
  // Vision runtime (llama-server) is bundled in production builds.
  const modelsReady = await downloadMissingModels();

  // Verify embeddings work (GPU/CPU backend already logged by LlamaService)
  await runEmbeddingProbe();

  return modelsReady;
}

/**
 * Run a quick embedding probe to verify the embedding model and GPU/CPU path work.
 * Non-blocking: logs result, does not fail setup.
 */
async function runEmbeddingProbe() {
  try {
    const embeddingService = container.tryResolve(ServiceIds.PARALLEL_EMBEDDING);
    if (!embeddingService) {
      logger.debug('[BACKGROUND] Embedding service not yet available, skipping probe');
      return;
    }
    const result = await embeddingService.embedText('embedding health probe');
    if (result?.vector && Array.isArray(result.vector) && result.vector.length > 0) {
      logger.info('[BACKGROUND] Embeddings OK', {
        dim: result.vector.length,
        model: result.model || 'unknown'
      });
    } else {
      logger.warn('[BACKGROUND] Embedding probe returned incomplete result');
    }
  } catch (probeErr) {
    logger.warn('[BACKGROUND] Embedding probe failed', { error: probeErr?.message });
  }
}

/**
 * Run background setup (fully automated dependency setup on first run).
 * This runs asynchronously and does not block startup.
 * @returns {Promise<void>}
 */
async function runBackgroundSetup() {
  backgroundSetupStatus.startedAt = new Date().toISOString();

  try {
    const isFirstRun = await checkFirstRun();

    if (isFirstRun) {
      logger.info('[BACKGROUND] First run detected - will run automated dependency setup');

      let setupSucceeded = false;
      try {
        setupSucceeded = await runAutomatedDependencySetup();
      } catch (err) {
        logger.warn('[BACKGROUND] Setup script error:', err.message);
      }

      // Only stamp the marker when the core models actually landed. A failed
      // first run (offline install, blocked download host) must retry on the
      // next launch instead of permanently claiming completion.
      if (setupSucceeded) {
        await markSetupComplete();
      } else {
        logger.warn(
          '[BACKGROUND] First-run setup incomplete; marker not written, will retry next launch'
        );
      }
    } else {
      logger.debug('[BACKGROUND] Not first run, skipping automated dependency setup');

      // In-process AI stack - no external service recovery needed.
      // However, models may still be missing (deleted, failed download, etc.).
      // Check and download missing models on every launch.
      try {
        await downloadMissingModels();
        await runEmbeddingProbe();
      } catch (err) {
        logger.debug(
          '[BACKGROUND] Model check on subsequent run failed (non-fatal):',
          err?.message
        );
      }
    }

    // Mark background setup as complete
    backgroundSetupStatus.complete = true;
    backgroundSetupStatus.completedAt = new Date().toISOString();
    logger.info('[BACKGROUND] Background setup completed successfully');
  } catch (error) {
    // Track error - status can be queried via getBackgroundSetupStatus()
    backgroundSetupStatus.error = error.message;
    backgroundSetupStatus.completedAt = new Date().toISOString();
    logger.error('[BACKGROUND] Background setup failed:', error);
  }
}

module.exports = {
  runBackgroundSetup,
  getBackgroundSetupStatus,
  checkFirstRun
};
