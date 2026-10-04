// @ts-check
/**
 * Llama IPC Handlers - In-process LLM operations
 *
 * IPC handlers for node-llama-cpp based LlamaService.
 * Provides model management, configuration, and health check endpoints.
 *
 * @module ipc/llama
 */

const { IpcServiceContext, createFromLegacyParams } = require('./IpcServiceContext');
const { createHandler, safeHandle, safeSend, z } = require('./ipcWrappers');
const { schemas } = require('./validationSchemas');
const { container: serviceContainer, ServiceIds } = require('../services/ServiceContainer');
const { ensureResolvedModelsPath } = require('../services/modelPathResolver');
const { TIMEOUTS } = require('../../shared/performanceConstants');
const { AI_DEFAULTS, IPC_EVENTS } = require('../../shared/constants');
const { withTimeout } = require('../../shared/promiseUtils');
const { getModel } = require('../../shared/modelRegistry');
const { classifyLlamaError } = require('../../shared/llamaErrorClassifier');
const { toPercentNumber, toFiniteNonNegativeNumber } = require('../../shared/numberUtils');

// Build a renderer-safe error envelope that gives the renderer enough
// to distinguish failure modes (model-not-loaded vs OOM vs corrupt-gguf vs
// permission-denied) without leaking raw error strings. Without this,
// every Llama IPC failure surfaces as the same generic `error.message`
// string and the renderer cannot offer specific remediation.
/**
 * @param {any} error
 */
function _llamaErrorEnvelope(error) {
  const llamaCode = classifyLlamaError(error);
  const code =
    llamaCode ||
    (error && typeof error.code === 'string' && error.code) ||
    (error && typeof error.name === 'string' && error.name !== 'Error' && error.name) ||
    'LLAMA_ERROR';
  return {
    success: false,
    error: error?.message || 'Llama operation failed',
    code,
    ...(llamaCode ? { llamaCode } : {})
  };
}

// Flatten LlamaService.getHealthStatus() into the renderer-facing
// `llamaHealth` snapshot. All four producers of that snapshot — the
// get-models and test-connection success paths and both of their catch
// paths — go through this one function, so a field added to
// getHealthStatus() cannot reach one producer and not another.
// llama:get-models used to build a shorter object of its own that omitted
// usingCPUFallback/cpuFallbackTypes entirely, and the Settings panel
// refreshes models right after (and sometimes instead of)
// llama:test-connection — so the honest "Ready (CPU fallback)" badge was
// immediately overwritten with a snapshot that could not express a fallback.
// The catch paths pass `null` health (there is none to report) and override
// `status`/`error` through `extra`; every other field then lands on its
// honest "unknown" default instead of being absent.
/**
 * @param {any} health - LlamaService.getHealthStatus() result (may be undefined)
 * @param {{ status?: string, lastCheck: number, [k: string]: any }} extra
 * @returns {Record<string, any>}
 */
function _llamaHealthSnapshot(health, extra) {
  return {
    status: health?.healthy === false ? 'unhealthy' : 'healthy',
    initialized: Boolean(health?.initialized),
    degraded: Boolean(health?.degraded),
    openCircuits: Array.isArray(health?.openCircuits) ? health.openCircuits : [],
    usingCPUFallback: Boolean(health?.usingCPUFallback),
    // Which model types are actually running on the CPU, so the badge can
    // name them instead of claiming the whole engine fell back.
    cpuFallbackTypes: Array.isArray(health?.cpuFallbackTypes) ? health.cpuFallbackTypes : [],
    gpuBackend: health?.gpuBackend || null,
    gpuDetected: health?.gpuDetected || null,
    gpuSelection: health?.gpuSelection || null,
    ...extra
  };
}

/**
 * Register Llama IPC handlers
 * @param {IpcServiceContext|Record<string, any>} servicesOrParams - Service context or legacy parameters
 */
function registerLlamaIpc(servicesOrParams) {
  let container;
  if (servicesOrParams instanceof IpcServiceContext) {
    container = servicesOrParams;
  } else {
    container = createFromLegacyParams(servicesOrParams);
  }

  const { ipcMain, IPC_CHANNELS, logger } = container.core;
  const { systemAnalytics } = container;
  const { getMainWindow } = container.electron;

  // Lazy load LlamaService to avoid circular dependencies
  /** @type {any} */
  let llamaService = null;
  /** @type {any} */
  let modelDownloadManager = null;

  function getLlamaService() {
    if (!llamaService) {
      if (!serviceContainer.has(ServiceIds.LLAMA_SERVICE)) {
        const { registerWithContainer } = require('../services/LlamaService');
        registerWithContainer(serviceContainer, ServiceIds.LLAMA_SERVICE);
      }
      llamaService = serviceContainer.resolve(ServiceIds.LLAMA_SERVICE);
    }
    return llamaService;
  }

  function getModelDownloadManager() {
    if (!modelDownloadManager) {
      if (!serviceContainer.has(ServiceIds.MODEL_DOWNLOAD_MANAGER)) {
        const { registerWithContainer } = require('../services/ModelDownloadManager');
        registerWithContainer(serviceContainer, ServiceIds.MODEL_DOWNLOAD_MANAGER);
      }
      modelDownloadManager = serviceContainer.resolve(ServiceIds.MODEL_DOWNLOAD_MANAGER);
    }
    return modelDownloadManager;
  }

  const context = 'Llama';
  const schemaVoid = z ? z.void() : null;
  const schemaModelName = schemas?.llamaModelFilename || (z ? z.string().min(1) : null);
  // Restrict update-config to known config fields instead of allowing arbitrary passthrough
  const ALLOWED_CONFIG_FIELDS = new Set([
    'textModel',
    'visionModel',
    'embeddingModel',
    // Canonical internal field names
    'gpuLayers',
    'contextSize',
    'threads',
    // Backward-compatible field names used in settings payloads
    'llamaGpuLayers',
    'llamaContextSize'
  ]);
  const schemaUpdateConfig = z
    ? z
        .record(z.string(), z.any())
        .refine((obj) => Object.keys(obj).every((k) => ALLOWED_CONFIG_FIELDS.has(k)), {
          message: 'Unknown config fields provided'
        })
    : null;

  // Get available models
  safeHandle(
    ipcMain,
    IPC_CHANNELS.LLAMA.GET_MODELS,
    createHandler({
      logger,
      context,
      schema: schemaVoid,
      handler: async () => {
        try {
          const service = getLlamaService();
          await service.initialize();

          const models = await withTimeout(
            service.listModels(),
            TIMEOUTS.MODEL_DISCOVERY,
            'List models'
          );

          // Categorize models by type
          /** @type {Record<string, string[]>} */
          const categories = {
            text: [],
            vision: [],
            embedding: []
          };

          for (const model of models || []) {
            const type = model.type || 'text';
            // 'support' = non-loadable companion files (mmproj projector):
            // keep them out of every picker bucket; the flat `models` list
            // still carries them for the management/delete UI.
            if (type === 'support') continue;
            if (categories[type]) {
              categories[type].push(model.name || model.filename);
            } else {
              categories.text.push(model.name || model.filename);
            }
          }

          // Update health status
          const now = Date.now();
          const healthStatus = service.getHealthStatus?.();
          systemAnalytics.llamaHealth = _llamaHealthSnapshot(healthStatus, {
            modelCount: models?.length || 0,
            gpuBackend: healthStatus?.gpuBackend || service._gpuBackend || null,
            lastCheck: now
          });

          const config = await service.getConfig();
          const allModelNames = (models || []).map((/** @type {any} */ m) => m.name || m.filename);

          // Auto-resolve stale model names. Ollama-era names with ':' tags
          // (e.g. 'llama3.2:latest') are replaced with GGUF defaults immediately.
          // Partial-match names (e.g. 'mxbai-embed-large') are fuzzy-matched
          // against installed GGUF filenames.
          /** @param {unknown} n */
          const isOllamaName = (n) =>
            typeof n === 'string' && n.includes(':') && !n.endsWith('.gguf');

          /**
           * @param {string|null|undefined} configured
           * @param {string[]} installedList
           * @param {string|null|undefined} defaultModel
           */
          const resolveModel = (configured, installedList, defaultModel) => {
            if (!configured) return defaultModel || configured;
            if (installedList.includes(configured)) return configured;
            // Ollama-style names can't be fuzzy-matched — use the default
            if (isOllamaName(configured)) return defaultModel || configured;
            const lc = configured.toLowerCase();
            return (
              installedList.find((m) => m.toLowerCase().includes(lc)) ||
              installedList.find((m) => lc.includes(m.toLowerCase())) ||
              configured
            );
          };

          const resolvedText = resolveModel(
            config.textModel,
            categories.text,
            AI_DEFAULTS.TEXT.MODEL
          );
          const resolvedVision = resolveModel(
            config.visionModel,
            categories.vision,
            AI_DEFAULTS.IMAGE.MODEL
          );
          const resolvedEmbedding = resolveModel(
            config.embeddingModel,
            categories.embedding,
            AI_DEFAULTS.EMBEDDING.MODEL
          );

          // Do not auto-persist corrections to avoid mid-operation model switches.
          // Instead return suggested corrections to the UI so the user can confirm.
          /** @type {Record<string, string|null|undefined>} */
          const corrections = {};
          if (resolvedText !== config.textModel) corrections.textModel = resolvedText;
          if (resolvedVision !== config.visionModel) corrections.visionModel = resolvedVision;
          if (resolvedEmbedding !== config.embeddingModel)
            corrections.embeddingModel = resolvedEmbedding;

          if (Object.keys(corrections).length > 0) {
            logger.info('[IPC:Llama] Detected stale model names (not auto-applied)', corrections);
          }

          // Per-model metadata for the management UI (type + on-disk size).
          // Kept separate from `models` (names only) so existing consumers
          // of the flat name list are untouched.
          const modelDetails = (models || []).map((/** @type {any} */ m) => ({
            name: m.name || m.filename,
            type: m.type || 'text',
            sizeMB: Number.isFinite(m.sizeBytes) ? Math.round(m.sizeBytes / (1024 * 1024)) : null
          }));

          return {
            models: allModelNames,
            modelDetails,
            categories,
            selected: {
              textModel: resolvedText,
              visionModel: resolvedVision,
              embeddingModel: resolvedEmbedding
            },
            corrections,
            requiresModelConfirmation: Object.keys(corrections).length > 0,
            llamaHealth: systemAnalytics.llamaHealth,
            inProcess: true
          };
        } catch (error) {
          logger.error('[IPC:Llama] Error getting models:', error);
          const now = Date.now();
          systemAnalytics.llamaHealth = _llamaHealthSnapshot(null, {
            status: 'unhealthy',
            error: error.message,
            lastCheck: now
          });
          return {
            models: [],
            categories: { text: [], vision: [], embedding: [] },
            selected: {},
            error: error.message,
            llamaHealth: systemAnalytics.llamaHealth,
            inProcess: true
          };
        }
      }
    })
  );

  // Warm the text model in the background so the next text inference (e.g.
  // smart-folder AI description) skips the cold VRAM load. Returns immediately;
  // the load runs fire-and-forget and never blocks the caller.
  safeHandle(
    ipcMain,
    IPC_CHANNELS.LLAMA.WARM,
    createHandler({
      logger,
      context,
      schema: schemaVoid,
      handler: async () => {
        try {
          const service = getLlamaService();
          void Promise.resolve()
            .then(() => service.warmTextModel())
            .catch((/** @type {any} */ err) =>
              logger.debug('[IPC:Llama] Text warm-up skipped', { error: err?.message })
            );
        } catch (error) {
          logger.debug('[IPC:Llama] Warm request ignored', {
            error: /** @type {any} */ (error)?.message
          });
        }
        return { success: true };
      }
    })
  );

  // Get configuration
  safeHandle(
    ipcMain,
    IPC_CHANNELS.LLAMA.GET_CONFIG,
    createHandler({
      logger,
      context,
      schema: schemaVoid,
      handler: async () => {
        try {
          const service = getLlamaService();
          await service.initialize();
          const config = await service.getConfig();
          return { success: true, config };
        } catch (error) {
          logger.error('[IPC:Llama] Error getting config:', error);
          return _llamaErrorEnvelope(error);
        }
      }
    })
  );

  // Update configuration
  safeHandle(
    ipcMain,
    IPC_CHANNELS.LLAMA.UPDATE_CONFIG,
    createHandler({
      logger,
      context,
      schema: schemaUpdateConfig,
      handler: async (_event, config) => {
        try {
          const service = getLlamaService();
          await service.initialize();
          const beforeConfig =
            typeof service.getConfig === 'function'
              ? await service.getConfig().catch(
                  /** @type {(err: any) => any} */ (
                    (err) => {
                      logger.debug('[IPC:Llama] getConfig failed', { error: err?.message });
                      return null;
                    }
                  )
                )
              : null;
          const mappedConfig = {
            ...config,
            gpuLayers: config?.gpuLayers ?? config?.llamaGpuLayers,
            contextSize: config?.contextSize ?? config?.llamaContextSize
          };
          const updateResult = await service.updateConfig(mappedConfig);
          const afterConfig =
            typeof service.getConfig === 'function'
              ? await service.getConfig().catch(
                  /** @type {(err: any) => any} */ (
                    (err) => {
                      logger.debug('[IPC:Llama] getConfig failed', { error: err?.message });
                      return null;
                    }
                  )
                )
              : null;

          /** @type {Record<string, { from: any, to: any }>} */
          const changed = {};
          for (const key of ['textModel', 'visionModel', 'embeddingModel']) {
            if (
              beforeConfig?.[key] &&
              afterConfig?.[key] &&
              beforeConfig[key] !== afterConfig[key]
            ) {
              changed[key] = {
                from: beforeConfig[key],
                to: afterConfig[key]
              };
            }
          }

          logger.info('[IPC:Llama] Config update applied', {
            changedModelKeys: Object.keys(changed),
            modelDowngraded: Boolean(updateResult?.modelDowngraded),
            requestedEmbeddingModel: config?.embeddingModel,
            selectedEmbeddingModel:
              updateResult?.selected?.embedding || afterConfig?.embeddingModel || null
          });

          if (updateResult?.modelDowngraded) {
            logger.warn('[IPC:Llama] Unsupported model request adjusted to safe defaults', {
              requested: config,
              selected: updateResult?.selected || null
            });
          }

          return {
            success: true,
            selected: updateResult?.selected || null,
            modelDowngraded: Boolean(updateResult?.modelDowngraded),
            changes: changed
          };
        } catch (error) {
          logger.error('[IPC:Llama] Error updating config:', error);
          return _llamaErrorEnvelope(error);
        }
      }
    })
  );

  // Test connection / health check
  safeHandle(
    ipcMain,
    IPC_CHANNELS.LLAMA.TEST_CONNECTION,
    createHandler({
      logger,
      context,
      schema: schemaVoid,
      handler: async () => {
        try {
          const service = getLlamaService();
          await withTimeout(service.initialize(), TIMEOUTS.SERVICE_STARTUP, 'Llama initialization');
          // getHealthStatus is synchronous; timeout wrappers apply only to async operations.
          const health = service.getHealthStatus();

          const now = Date.now();
          systemAnalytics.llamaHealth = _llamaHealthSnapshot(health, {
            status: health.healthy ? 'healthy' : 'unhealthy',
            lastCheck: now
          });

          return {
            success: true,
            status: health.healthy ? 'healthy' : 'unhealthy',
            llamaHealth: systemAnalytics.llamaHealth,
            inProcess: true,
            gpuBackend: health.gpuBackend
          };
        } catch (error) {
          logger.error('[IPC:Llama] Test connection failed:', error);
          const now = Date.now();
          systemAnalytics.llamaHealth = _llamaHealthSnapshot(null, {
            status: 'unhealthy',
            error: error.message,
            lastCheck: now
          });
          return {
            success: false,
            status: 'unhealthy',
            error: error.message,
            llamaHealth: systemAnalytics.llamaHealth,
            inProcess: true
          };
        }
      }
    })
  );

  // Download model (non-blocking: starts download and returns immediately)
  safeHandle(
    ipcMain,
    IPC_CHANNELS.LLAMA.DOWNLOAD_MODEL,
    createHandler({
      logger,
      context,
      schema: schemaModelName,
      handler: async (_event, modelName) => {
        const normalizedName = typeof modelName === 'string' ? modelName.trim() : '';
        try {
          if (!normalizedName) {
            return { success: false, error: 'Model name is required' };
          }
          if (
            normalizedName.includes('..') ||
            normalizedName.includes('/') ||
            normalizedName.includes('\\')
          ) {
            return { success: false, error: 'Invalid model name' };
          }
          const manager = getModelDownloadManager();
          const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
          /** @param {string} name */
          const getExpectedTotalBytes = (name) => {
            const modelInfo = getModel(name);
            if (!modelInfo) return 0;
            let total = Number(modelInfo.size) || 0;
            if (modelInfo.clipModel?.size) {
              total += Number(modelInfo.clipModel.size) || 0;
            }
            return total;
          };
          const latestProgressByModel = new Map();

          // If backgroundSetup already started this download, piggyback on it
          // instead of throwing a noisy error. The original starter forwards
          // progress to the window it captured at start time; if that window
          // was recreated since (renderer reload), the current window would
          // never see progress. Bridge filtered global progress events to the
          // live window until the download leaves the manager.
          if (manager.isDownloading(normalizedName)) {
            logger.debug('[IPC:Llama] Download already in progress, deferring to background', {
              model: normalizedName
            });
            const watchedFilenames = new Set([normalizedName]);
            const clipName = getModel(normalizedName)?.clipModel?.name;
            if (clipName) watchedFilenames.add(clipName);
            let lastBridgeSend = 0;
            /** @type {(() => void) | null} */
            let stopBridge = null;
            const maybeStop = () => {
              const stillActive = [...watchedFilenames].some((name) => manager.isDownloading(name));
              if (!stillActive && stopBridge) {
                stopBridge();
              }
            };
            const unsubscribe = manager.onProgress(
              (/** @type {Record<string, any>} */ progress) => {
                const filename = progress?.filename;
                if (!watchedFilenames.has(filename)) return;
                const now = Date.now();
                const percent = toPercentNumber(progress?.percent ?? progress?.percentage);
                if (now - lastBridgeSend > 100 || percent === 100) {
                  lastBridgeSend = now;
                  const liveWin = typeof getMainWindow === 'function' ? getMainWindow() : null;
                  if (liveWin && !liveWin.isDestroyed()) {
                    safeSend(liveWin.webContents, IPC_EVENTS.OPERATION_PROGRESS, {
                      type: 'model-download',
                      model: filename || normalizedName,
                      progress: {
                        model: filename || normalizedName,
                        filename: filename || normalizedName,
                        percent,
                        downloadedBytes: toFiniteNonNegativeNumber(progress?.downloadedBytes),
                        totalBytes: toFiniteNonNegativeNumber(progress?.totalBytes),
                        speedBps: toFiniteNonNegativeNumber(progress?.speedBps),
                        etaSeconds: toFiniteNonNegativeNumber(progress?.etaSeconds)
                      }
                    });
                  }
                }
              }
            );
            // Tear down via a slow unref'd poll rather than inline on the
            // final progress event: a vision model hands off to its clip
            // companion a few ms after the main file completes, and an
            // inline check in that gap would stop the bridge too early.
            // The poll also covers cancelled/failed downloads, which emit
            // no further progress at all.
            const reaper = setInterval(maybeStop, TIMEOUTS.HEALTH_CHECK);
            if (typeof reaper.unref === 'function') reaper.unref();
            stopBridge = () => {
              unsubscribe();
              clearInterval(reaper);
              stopBridge = null;
            };
            return { success: true, alreadyInProgress: true };
          }

          const resolved = await ensureResolvedModelsPath();
          if (resolved.source === 'legacy' && win && !win.isDestroyed()) {
            safeSend(win.webContents, IPC_EVENTS.NOTIFICATION, {
              message:
                'Downloading to legacy models directory. Consider moving models to the current app data folder.',
              severity: 'warning',
              duration: 6000
            });
          }

          let lastSend = 0;
          // Set up progress callback
          /** @param {Record<string, any>} progress */
          const onProgress = (progress) => {
            const actualModel = progress?.filename || normalizedName;
            const normalizedProgress = {
              model: actualModel,
              filename: progress?.filename || actualModel,
              percent: toPercentNumber(progress?.percent ?? progress?.percentage),
              downloadedBytes: toFiniteNonNegativeNumber(progress?.downloadedBytes),
              totalBytes: toFiniteNonNegativeNumber(progress?.totalBytes),
              speedBps: toFiniteNonNegativeNumber(progress?.speedBps),
              etaSeconds: toFiniteNonNegativeNumber(progress?.etaSeconds)
            };
            latestProgressByModel.set(actualModel, normalizedProgress);

            const now = Date.now();
            if (now - lastSend > 100 || normalizedProgress.percent === 100) {
              lastSend = now;
              if (win && !win.isDestroyed()) {
                safeSend(win.webContents, IPC_EVENTS.OPERATION_PROGRESS, {
                  type: 'model-download',
                  model: actualModel,
                  progress: normalizedProgress
                });
              }
            }
          };

          // Start download in background — do NOT await.
          // Downloads can take minutes/hours; awaiting would exceed IPC timeout.
          // Completion and errors are reported via OPERATION_PROGRESS events.
          manager
            .downloadModel(normalizedName, { onProgress })
            .then(
              /** @type {() => void} */ (
                () => {
                  logger.info('[IPC:Llama] Model download completed', { model: normalizedName });
                  if (win && !win.isDestroyed()) {
                    const latestRequestedProgress =
                      latestProgressByModel.get(normalizedName) || null;
                    const expectedTotalBytes = getExpectedTotalBytes(normalizedName);
                    const totalBytes = Math.max(
                      latestRequestedProgress?.totalBytes || 0,
                      expectedTotalBytes || 0
                    );
                    const downloadedBytes = Math.max(
                      latestRequestedProgress?.downloadedBytes || 0,
                      totalBytes
                    );
                    safeSend(win.webContents, IPC_EVENTS.OPERATION_PROGRESS, {
                      type: 'model-download-complete',
                      model: normalizedName,
                      success: true,
                      progress: {
                        model: normalizedName,
                        filename: normalizedName,
                        percent: 100,
                        downloadedBytes,
                        totalBytes,
                        speedBps: 0,
                        etaSeconds: 0
                      }
                    });
                  }
                  return undefined;
                }
              )
            )
            .catch((/** @type {any} */ error) => {
              // Handle race condition: download may have started concurrently
              if (error?.message?.includes('already in progress')) {
                logger.debug('[IPC:Llama] Download started concurrently, deferring to background', {
                  model: normalizedName
                });
                return;
              }
              logger.error('[IPC:Llama] Model download failed:', error);
              if (win && !win.isDestroyed()) {
                safeSend(win.webContents, IPC_EVENTS.OPERATION_PROGRESS, {
                  type: 'model-download-error',
                  model: normalizedName,
                  error: error?.message || 'Download failed'
                });
              }
            });

          return { success: true, started: true };
        } catch (error) {
          if (error?.message?.includes('already in progress')) {
            logger.debug('[IPC:Llama] Download started concurrently, deferring to background', {
              model: normalizedName
            });
            return { success: true, alreadyInProgress: true };
          }
          logger.error('[IPC:Llama] Model download failed:', error);
          return { success: false, error: error.message };
        }
      }
    })
  );

  // Delete model
  safeHandle(
    ipcMain,
    IPC_CHANNELS.LLAMA.DELETE_MODEL,
    createHandler({
      logger,
      context,
      schema: schemaModelName,
      handler: async (_event, modelName) => {
        try {
          const normalizedName = typeof modelName === 'string' ? modelName.trim() : '';
          if (!normalizedName) {
            return { success: false, error: 'Model name is required' };
          }
          if (
            normalizedName.includes('..') ||
            normalizedName.includes('/') ||
            normalizedName.includes('\\')
          ) {
            return { success: false, error: 'Invalid model name' };
          }
          const manager = getModelDownloadManager();
          const result = await manager.deleteModel(normalizedName);
          return result;
        } catch (error) {
          logger.error('[IPC:Llama] Model delete failed:', error);
          return _llamaErrorEnvelope(error);
        }
      }
    })
  );

  // Get download status
  safeHandle(
    ipcMain,
    IPC_CHANNELS.LLAMA.GET_DOWNLOAD_STATUS,
    createHandler({
      logger,
      context,
      schema: schemaVoid,
      handler: async () => {
        try {
          const manager = getModelDownloadManager();
          const status = manager.getStatus();
          return { success: true, status };
        } catch (error) {
          logger.error('[IPC:Llama] Get download status failed:', error);
          return { success: false, error: error.message };
        }
      }
    })
  );

  // Cancel an in-progress model download
  safeHandle(
    ipcMain,
    IPC_CHANNELS.LLAMA.CANCEL_DOWNLOAD,
    createHandler({
      logger,
      context,
      schema: schemaModelName,
      handler: async (_event, modelName) => {
        try {
          const normalizedName = typeof modelName === 'string' ? modelName.trim() : '';
          if (!normalizedName) {
            return { success: false, error: 'Model name is required' };
          }
          if (
            normalizedName.includes('..') ||
            normalizedName.includes('/') ||
            normalizedName.includes('\\')
          ) {
            return { success: false, error: 'Invalid model name' };
          }
          const manager = getModelDownloadManager();
          const cancelled = manager.cancelDownload(normalizedName);
          if (!cancelled) {
            return { success: false, error: 'No in-progress download for this model' };
          }
          return { success: true, cancelled: true };
        } catch (error) {
          logger.error('[IPC:Llama] Cancel download failed:', error);
          return _llamaErrorEnvelope(error);
        }
      }
    })
  );
}

module.exports = { registerLlamaIpc };
