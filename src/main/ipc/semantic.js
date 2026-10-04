// @ts-check
const { IpcServiceContext, createFromLegacyParams } = require('./IpcServiceContext');
const { container, ServiceIds } = require('../services/ServiceContainer');
const path = require('path');
const fs = require('fs').promises;

// Resolve services via container — use tryResolve so callers get null
// instead of an exception during shutdown or before services are ready.
const getOramaService = () => container.tryResolve(ServiceIds.ORAMA_VECTOR);
const getFolderMatcher = () => container.tryResolve(ServiceIds.FOLDER_MATCHING);
const getParallelEmbeddingService = () => container.tryResolve(ServiceIds.PARALLEL_EMBEDDING);
const getSearchService = () => container.tryResolve(ServiceIds.SEARCH_SERVICE);
const getClusteringService = () => container.tryResolve(ServiceIds.CLUSTERING);
const getLlamaService = () => container.tryResolve(ServiceIds.LLAMA_SERVICE);
const getUndoRedoService = () => container.tryResolve(ServiceIds.UNDO_REDO);
const { getInstance: getAtlasService } = require('../services/AtlasProjectionService');

/** @param {string} name */
const SERVICE_UNAVAILABLE = (name) => ({
  success: false,
  error: `${name} not available — service may still be initializing`,
  errorCode: 'SERVICE_UNAVAILABLE'
});

const { getInstance: getQueryProcessor } = require('../services/QueryProcessor');
const { SUPPORTED_IMAGE_EXTENSIONS, AI_DEFAULTS, IPC_EVENTS } = require('../../shared/constants');
const {
  BATCH,
  TIMEOUTS,
  LIMITS,
  SEARCH,
  THRESHOLDS,
  CHUNKING,
  RETRY
} = require('../../shared/performanceConstants');
const { createHandler, safeHandle, safeSend, z } = require('./ipcWrappers');
const { schemas: validationSchemas } = require('./validationSchemas');
const { cosineSimilarity, padOrTruncateVector } = require('../../shared/vectorMath');
const { validateFileOperationPath } = require('../../shared/pathSanitization');
const { categorizeModel } = require('../../shared/modelCategorization');
const { chunkText } = require('../utils/textChunking');
const { normalizeText } = require('../../shared/normalization');
const { getFileEmbeddingId } = require('../utils/fileIdUtils');
const { enrichFolderTextForEmbedding } = require('../analysis/semanticExtensionMap');
const { buildEmbeddingSummary } = require('../analysis/embeddingSummary');
const { resolveEmbeddingModelOptions } = require('../analysis/embeddingModelOptions');
const {
  readEmbeddingIndexMetadata,
  writeEmbeddingIndexMetadata,
  updateEmbeddingIndexMetadata,
  markRebuildInProgress,
  clearRebuildInProgress
} = require('../services/vectorDb/embeddingIndexMetadata');
const embeddingQueueManager = require('../analysis/embeddingQueue/queueManager');
const { isAutoChunkEnabled } = require('../../shared/experienceMode');
const { isFallbackAnalysis } = require('../../shared/analysisProvenance');
const { createLogger } = require('../../shared/logger');
const { ERROR_CODES } = require('../../shared/errorCodes');
const { withTimeout } = require('../../shared/promiseUtils');
const _moduleLogger = createLogger('semantic-ipc');

// D6: embedding-index health is a coverage ratio, not a zero check. 11 vectors
// for 281 analyzed files used to read as "healthy" because the old check only
// fired at fileCount === 0. Below this fraction of eligible files having a
// vector, GET_STATS reports `embeddingCoverageLow` (F-197).
const MIN_HEALTHY_FILE_EMBEDDING_COVERAGE = 0.95;

/** @typedef {import('./ipcWrappers').LoggerLike} LoggerLike */
/**
 * Invoke event as delivered by ipcRegistry: Electron's IpcMainInvokeEvent plus
 * the opt-in cooperative-cancellation signal attached as a non-enumerable
 * property in src/main/core/ipcRegistry.js.
 * @typedef {import('electron').IpcMainInvokeEvent & { abortSignal?: AbortSignal }} IpcMainInvokeEvent
 */

/**
 * Register-time dependencies threaded into each named handler. Every handler
 * destructures only the members it uses, so all service accessors are
 * optional in the type; call sites always pass what the handler needs.
 * @typedef {Object} SemanticHandlerDeps
 * @property {LoggerLike} logger
 * @property {() => Promise<Record<string, any>|null>} [safeEnsureInit]
 * @property {() => Record<string, any>[]} [getCustomFolders]
 * @property {(() => any)|null} [getServiceIntegration]
 * @property {() => Promise<boolean>} [shouldBuildChunkEmbeddings]
 * @property {(serviceId: string) => any} [resolveOptionalService]
 * @property {(() => import('electron').BrowserWindow|null)|undefined} [getMainWindow]
 */

/**
 * True when embedding work is actively queued or in flight — not merely "pending"
 * in analysis history (which can stay high when indexing is idle or blocked).
 */
function isEmbeddingPipelineBusy() {
  try {
    const qm = embeddingQueueManager.getStats?.();
    for (const stage of [qm?.analysis, qm?.organize]) {
      if (!stage || typeof stage !== 'object') continue;
      if (stage.isFlushing) return true;
      if (typeof stage.queueLength === 'number' && stage.queueLength > 0) return true;
    }
    const pes = getParallelEmbeddingService();
    if (pes && typeof pes.getStats === 'function') {
      const ps = pes.getStats();
      if (typeof ps.activeRequests === 'number' && ps.activeRequests > 0) return true;
      if (typeof ps.queuedRequests === 'number' && ps.queuedRequests > 0) return true;
    }
  } catch {
    // Non-fatal: fall through to not busy
  }
  return false;
}

/** @param {any} error */
const isDimensionMismatchError = (error) => {
  if (!error) return false;
  const message = error?.message || error?.error || (typeof error === 'string' ? error : '') || '';
  return (
    error?.code === ERROR_CODES.VECTOR_DB_DIMENSION_MISMATCH || /dimension mismatch/i.test(message)
  );
};

/**
 * Detect Ollama-style model names (e.g. 'llama3.2:latest', 'mistral:7b').
 * These contain a ':' tag separator and are never valid GGUF filenames.
 * @param {string} name
 * @returns {boolean}
 */
function _isOllamaStyleName(name) {
  return typeof name === 'string' && name.includes(':') && !name.endsWith('.gguf');
}

/**
 * @param {string|null|undefined} name
 * @returns {string}
 */
// normalizeModelName / findInstalledModelMatch live in shared/modelNameMatch
// so the watcher's provisional-retry check (F-195) can use the same matcher.
const { findInstalledModelMatch } = require('../../shared/modelNameMatch');

/**
 * Return de-duped list of installed model filenames matching the given type.
 * Uses the model's own `type` property first, then falls back to
 * heuristic-based `categorizeModel()`.
 * @param {Array<Record<string, any>>|null|undefined} models
 * @param {string} targetType
 */
function getInstalledModelNamesByType(models, targetType) {
  const modelList = Array.isArray(models) ? models : [];
  const names = modelList
    .map((model) => {
      const name = String(model?.name || model?.filename || '').trim();
      if (!name) return null;
      const type = String(model?.type || '').toLowerCase();
      const category = type || categorizeModel(name);
      return category === targetType ? name : null;
    })
    .filter(Boolean);

  // De-dupe while preserving order
  return [...new Set(names)];
}

/**
 * Convenience alias kept for readability in embedding-only call-sites.
 * @param {Array<Record<string, any>>|null|undefined} models
 */
function getInstalledEmbeddingModelNames(models) {
  return getInstalledModelNamesByType(models, 'embedding');
}

/**
 * Verify embedding model is available locally.
 * @param {LoggerLike} logger - Logger instance
 * @param {string|null} [preferredModel]
 * @returns {Promise<{available: boolean, model: string, error?: string, availableModels?: string[]}>}
 */
async function verifyEmbeddingModelAvailable(logger, preferredModel = null) {
  const llama = getLlamaService();
  if (!llama) {
    return {
      available: false,
      model: preferredModel || AI_DEFAULTS.EMBEDDING.MODEL,
      error: 'LlamaService not available — AI engine may still be initializing'
    };
  }
  const cfg = await llama.getConfig();
  let model =
    typeof preferredModel === 'string' && preferredModel.trim()
      ? preferredModel.trim()
      : cfg.embeddingModel || AI_DEFAULTS.EMBEDDING.MODEL;

  // Replace Ollama-era names with the GGUF default and persist the correction
  if (_isOllamaStyleName(model)) {
    logger.info('[EMBEDDINGS] Replacing Ollama-era embedding model name with GGUF default', {
      ollamaName: model,
      default: AI_DEFAULTS.EMBEDDING.MODEL
    });
    model = AI_DEFAULTS.EMBEDDING.MODEL;
    try {
      await llama.updateConfig({ embeddingModel: model });
    } catch (e) {
      logger.warn('[EMBEDDINGS] Failed to persist embedding model correction:', e?.message);
    }
  }

  // Unit tests mock embedding generation and don't require real GGUF files.
  if (process.env.JEST_WORKER_ID) {
    return { available: true, model };
  }

  try {
    const models = await llama.listModels();
    const modelNames = models
      .map((/** @type {any} */ m) => String(m?.name || m?.filename || '').trim())
      .filter(Boolean);
    const embeddingModelNames = getInstalledEmbeddingModelNames(models);

    // Check if the configured model (or a variant) is installed
    const matchedPrimary = findInstalledModelMatch(modelNames, model);
    if (!matchedPrimary) {
      // Try fallback models
      const fallbackModels = AI_DEFAULTS.EMBEDDING.FALLBACK_MODELS || [];
      for (const fallback of fallbackModels) {
        const matchedFallback = findInstalledModelMatch(modelNames, fallback);
        if (matchedFallback) {
          logger.info('[EMBEDDINGS] Primary model not found, using fallback', {
            primary: model,
            fallback: matchedFallback,
            availableModels: modelNames.slice(0, 10)
          });
          return { available: true, model: matchedFallback };
        }
      }

      // Last resort: use any installed embedding model.
      // This prevents hard-failing rebuild/reanalyze when the configured model
      // is missing but another valid embedding model exists locally.
      if (embeddingModelNames.length > 0) {
        const autoSelected = embeddingModelNames[0];
        logger.info('[EMBEDDINGS] Using installed embedding model fallback', {
          primary: model,
          autoSelected,
          availableEmbeddingModels: embeddingModelNames.slice(0, 10)
        });
        return { available: true, model: autoSelected };
      }

      logger.error('[EMBEDDINGS] No embedding model available', {
        configured: model,
        fallbacks: fallbackModels,
        availableModels: modelNames.slice(0, 10)
      });

      return {
        available: false,
        model,
        error: `Embedding model "${model}" not downloaded. Download it in Settings > Models.`,
        availableModels: modelNames.slice(0, 10)
      };
    }

    return { available: true, model: matchedPrimary };
  } catch (error) {
    logger.error('[EMBEDDINGS] Failed to verify embedding model:', error.message);
    return {
      available: false,
      model,
      error: `AI engine unavailable: ${error.message}. Check model downloads and try again.`
    };
  }
}

/**
 * @param {string[]} modelNames
 * @param {string} model
 * @returns {boolean}
 */
function isModelAvailable(modelNames, model) {
  return Boolean(findInstalledModelMatch(modelNames, model));
}

/** @param {LoggerLike} logger */
async function verifyReanalyzeModelsAvailable(logger) {
  const llama = getLlamaService();
  if (!llama) {
    return {
      available: false,
      textModel: AI_DEFAULTS.TEXT.MODEL,
      visionModel: AI_DEFAULTS.IMAGE.MODEL,
      embeddingModel: AI_DEFAULTS.EMBEDDING.MODEL,
      error: 'LlamaService not available — AI engine may still be initializing'
    };
  }
  const cfg = await llama.getConfig();
  let textModel = cfg.textModel || AI_DEFAULTS.TEXT.MODEL;
  let visionModel = cfg.visionModel || AI_DEFAULTS.IMAGE.MODEL;
  let embeddingModel = cfg.embeddingModel || AI_DEFAULTS.EMBEDDING.MODEL;

  // Replace Ollama-era names with GGUF defaults and persist corrections
  const corrections = {};
  if (_isOllamaStyleName(textModel)) {
    corrections.textModel = AI_DEFAULTS.TEXT.MODEL;
    textModel = AI_DEFAULTS.TEXT.MODEL;
  }
  if (_isOllamaStyleName(visionModel)) {
    corrections.visionModel = AI_DEFAULTS.IMAGE.MODEL;
    visionModel = AI_DEFAULTS.IMAGE.MODEL;
  }
  if (_isOllamaStyleName(embeddingModel)) {
    corrections.embeddingModel = AI_DEFAULTS.EMBEDDING.MODEL;
    embeddingModel = AI_DEFAULTS.EMBEDDING.MODEL;
  }
  if (Object.keys(corrections).length > 0) {
    logger.info('[REANALYZE] Replacing Ollama-era model names with GGUF defaults', corrections);
    try {
      await llama.updateConfig(corrections);
    } catch (e) {
      logger.warn('[REANALYZE] Failed to persist model name corrections:', e?.message);
    }
  }

  // Unit tests mock analysis/embedding and don't require real GGUF files.
  if (process.env.JEST_WORKER_ID) {
    return { available: true, textModel, visionModel, embeddingModel };
  }

  try {
    const models = await llama.listModels();
    // Preserve original casing from fs.readdir so returned matches can load
    // on case-sensitive filesystems (Linux/macOS).
    const modelNames = models
      .map((/** @type {any} */ m) => String(m?.name || m?.filename || '').trim())
      .filter(Boolean);

    // --- Text model: try configured → fallback list → any installed text model ---
    if (!isModelAvailable(modelNames, textModel)) {
      const textFallbacks = AI_DEFAULTS.TEXT.FALLBACK_MODELS || [];
      const matchedTextFallback = textFallbacks
        .map((candidate) => findInstalledModelMatch(modelNames, candidate))
        .find(Boolean);

      if (matchedTextFallback) {
        logger.info('[REANALYZE] Primary text model not found, using fallback', {
          primary: textModel,
          fallback: matchedTextFallback
        });
        textModel = matchedTextFallback;
      } else {
        const installedTextModels = getInstalledModelNamesByType(models, 'text');
        if (installedTextModels.length > 0) {
          logger.info('[REANALYZE] Using any installed text model as last-resort fallback', {
            primary: textModel,
            autoSelected: installedTextModels[0]
          });
          textModel = installedTextModels[0];
        } else {
          return {
            available: false,
            model: textModel,
            modelType: 'text',
            error: `Text model "${textModel}" not downloaded. Download it in Settings > Models.`
          };
        }
      }
    }

    // --- Vision model: try configured → fallback list → any installed vision model ---
    if (!isModelAvailable(modelNames, visionModel)) {
      const visionFallbacks = AI_DEFAULTS.IMAGE.FALLBACK_MODELS || [];
      const matchedVisionFallback = visionFallbacks
        .map((candidate) => findInstalledModelMatch(modelNames, candidate))
        .find(Boolean);

      if (matchedVisionFallback) {
        logger.info('[REANALYZE] Primary vision model not found, using fallback', {
          primary: visionModel,
          fallback: matchedVisionFallback
        });
        visionModel = matchedVisionFallback;
      } else {
        const installedVisionModels = getInstalledModelNamesByType(models, 'vision');
        if (installedVisionModels.length > 0) {
          logger.info('[REANALYZE] Using any installed vision model as last-resort fallback', {
            primary: visionModel,
            autoSelected: installedVisionModels[0]
          });
          visionModel = installedVisionModels[0];
        } else {
          return {
            available: false,
            model: visionModel,
            modelType: 'vision',
            error: `Vision model "${visionModel}" not downloaded. Download it in Settings > Models.`
          };
        }
      }
    }

    let embeddingModelToUse = findInstalledModelMatch(modelNames, embeddingModel);
    if (!embeddingModelToUse) {
      const fallbackModels = AI_DEFAULTS.EMBEDDING.FALLBACK_MODELS || [];
      const matchedFallback = fallbackModels
        .map((candidate) => findInstalledModelMatch(modelNames, candidate))
        .find(Boolean);

      if (matchedFallback) {
        logger.info('[EMBEDDINGS] Primary model not found, using fallback', {
          primary: embeddingModel,
          fallback: matchedFallback,
          availableModels: modelNames.slice(0, 10)
        });
        embeddingModelToUse = matchedFallback;
      } else {
        const embeddingModelNames = getInstalledEmbeddingModelNames(models);
        if (embeddingModelNames.length > 0) {
          embeddingModelToUse = embeddingModelNames[0];
          logger.info('[EMBEDDINGS] Using installed embedding model fallback for reanalyze', {
            primary: embeddingModel,
            autoSelected: embeddingModelToUse,
            availableEmbeddingModels: embeddingModelNames.slice(0, 10)
          });
        } else {
          return {
            available: false,
            model: embeddingModel,
            modelType: 'embedding',
            error: `Embedding model "${embeddingModel}" not downloaded. Download it in Settings > Models.`
          };
        }
      }
    }

    return {
      available: true,
      textModel,
      visionModel,
      embeddingModel: embeddingModelToUse
    };
  } catch (error) {
    logger.error('[EMBEDDINGS] Failed to verify models for reanalysis:', error.message);
    return {
      available: false,
      model: embeddingModel,
      modelType: 'ai',
      error: `AI engine unavailable: ${error.message}. Check model downloads and try again.`
    };
  }
}

// Module-level reference to SearchService for cross-module access

/**
 * Get the SearchService instance (if initialized)
 * Used by fileOperationHandlers to invalidate index after file moves
 * @returns {import('../services/SearchService').SearchService|null}
 */
function getSearchServiceInstance() {
  return getSearchService();
}

/**
 * Get the ClusteringService instance (if initialized)
 * Used by fileOperationHandlers to invalidate clusters after file moves/deletes
 * @returns {import('../services/ClusteringService').ClusteringService|null}
 */
function getClusteringServiceInstance() {
  return getClusteringService();
}

// This prevents data corruption when user clicks rebuild multiple times
/** @type {{ isLocked: boolean, operation: string|null, startedAt: number|null, lastActivityAt: number|null, token: string|null }} */
let _rebuildLock = {
  isLocked: false,
  operation: null,
  startedAt: null,
  lastActivityAt: null,
  token: null
};
let _rebuildLockSeq = 0;

/**
 * Acquire rebuild lock for an operation
 *
 * Stale-lock recovery is based on holder INACTIVITY, not total runtime:
 * a full rebuild over a large library legitimately runs for well over the
 * stale window (CPU embedding is ~0.5-2s per item, capped at 50k entries),
 * so a wall-clock steal let a retry start a second concurrent rebuild that
 * interleaved resetAll() + upserts with the live one and corrupted the
 * index. Long-running holders call touchRebuildLock() from their item
 * loops; only a holder that has stopped heartbeating (hung or leaked) can
 * be displaced.
 *
 * @param {string} operation - Name of the operation (e.g., 'REBUILD_FILES', 'FULL_REBUILD')
 * @returns {{ acquired: boolean, token?: string, reason?: string }}
 */
function acquireRebuildLock(operation) {
  if (_rebuildLock.isLocked) {
    const STALE_LOCK_TIMEOUT = 10 * 60 * 1000; // 10 minutes without a heartbeat
    const lastAlive = _rebuildLock.lastActivityAt ?? _rebuildLock.startedAt ?? 0;
    if (Date.now() - lastAlive > STALE_LOCK_TIMEOUT) {
      _moduleLogger.warn('[SEMANTIC] Force-releasing stale rebuild lock (holder inactive)', {
        staleLockOperation: _rebuildLock.operation,
        heldForMs: Date.now() - (_rebuildLock.startedAt ?? 0),
        inactiveForMs: Date.now() - lastAlive
      });
    } else {
      return {
        acquired: false,
        reason: `Another rebuild operation is in progress: ${_rebuildLock.operation} (started ${Math.round((Date.now() - (_rebuildLock.startedAt ?? 0)) / 1000)}s ago)`
      };
    }
  }
  const now = Date.now();
  _rebuildLock = {
    isLocked: true,
    operation,
    startedAt: now,
    lastActivityAt: now,
    token: `${operation}:${now}:${++_rebuildLockSeq}`
  };
  return { acquired: true, token: _rebuildLock.token };
}

/**
 * Heartbeat the rebuild lock from a long-running holder's work loop so the
 * stale-lock recovery in acquireRebuildLock never displaces a live holder.
 * @param {string|null|undefined} token
 */
function touchRebuildLock(token) {
  if (_rebuildLock.isLocked && token && _rebuildLock.token === token) {
    _rebuildLock.lastActivityAt = Date.now();
  }
}

/**
 * Release the rebuild lock
 * @param {string|null|undefined} token
 */
function releaseRebuildLock(token) {
  if (token && _rebuildLock.token && token !== _rebuildLock.token) {
    _moduleLogger.warn('[SEMANTIC] Ignoring rebuild lock release from stale holder', {
      token,
      activeToken: _rebuildLock.token,
      operation: _rebuildLock.operation
    });
    return false;
  }
  _rebuildLock = {
    isLocked: false,
    operation: null,
    startedAt: null,
    lastActivityAt: null,
    token: null
  };
  return true;
}

// Named handler bodies extracted from registerEmbeddingsIpc.
// Pulled to module top so each can be reasoned about and unit-tested in
// isolation rather than buried inside the multi-thousand-line closure.
// Handlers receive their closure-captured dependencies (safeEnsureInit,
// per-request locks, etc.) as explicit `deps` arguments.

/**
 * @param {SemanticHandlerDeps} deps
 * @param {IpcMainInvokeEvent} event
 * @param {{ force?: boolean, maxFiles?: number }} [payload]
 */
async function handleReindexFileHashes(
  { safeEnsureInit, logger },
  event,
  { force = false, maxFiles = 10000 } = {}
) {
  const initErr = await safeEnsureInit();
  if (initErr) return initErr;
  try {
    const orama = getOramaService();
    if (!orama) return SERVICE_UNAVAILABLE('OramaVectorService');

    const peek = await orama.peekFiles(maxFiles);
    const ids = peek?.ids || [];
    const metadatas = peek?.metadatas || [];

    const { computeFileChecksum } = require('../utils/fileDedup');
    const { getHashCache } = require('../utils/hashCache');
    const cache = getHashCache();

    let hashed = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const meta = metadatas[i] || {};
      const existingHash = meta.fileHash || '';
      if (existingHash && !force) {
        skipped++;
        continue;
      }
      const filePath = meta.filePath || meta.path;
      if (!filePath) {
        skipped++;
        continue;
      }
      try {
        let statInfo = null;
        try {
          const s = await fs.stat(filePath);
          if (typeof s.isFile === 'function' && !s.isFile()) {
            skipped++;
            continue;
          }
          statInfo = { size: s.size, mtimeMs: s.mtimeMs };
        } catch {
          failed++;
          continue;
        }
        const sha256 = await computeFileChecksum(filePath, {
          cache,
          stat: statInfo
        });
        await orama.updateFileHash(id, sha256);
        hashed++;
      } catch (err) {
        failed++;
        logger.warn('[EMBEDDINGS] Reindex hash failed for file', {
          id,
          error: err?.message
        });
      }
    }

    await cache.flush();

    return {
      success: true,
      total: ids.length,
      hashed,
      skipped,
      failed
    };
  } catch (e) {
    logger.error('[EMBEDDINGS] Reindex file hashes failed:', e);
    return { success: false, error: e.message };
  }
}

/**
 * @param {SemanticHandlerDeps} deps
 * @param {IpcMainInvokeEvent} event
 * @param {{ paths?: string[], summary?: Record<string, any> }} [payload]
 */
async function handleTrashDuplicates({ logger }, event, { paths, summary } = {}) {
  try {
    if (!Array.isArray(paths) || paths.length === 0) {
      return { success: false, error: 'No paths provided' };
    }

    const { TrashService } = require('../services/TrashService');
    const trasher = new TrashService();
    const result = await trasher.trashBatch(paths);

    if (result.trashed.length > 0) {
      const undo = getUndoRedoService();
      if (undo && typeof undo.recordBatch === 'function') {
        const operations = result.trashed.map((item) => ({
          type: 'trash',
          originalPath: item.path,
          size: item.size || 0
        }));
        try {
          await undo.recordBatch('TRASH_BATCH', operations, {
            summary: summary || { label: 'Delete duplicates' }
          });
        } catch (err) {
          logger.warn('[EMBEDDINGS] TRASH_BATCH undo record failed', {
            error: err?.message
          });
        }
      }

      // A trashed file is a deletion for every index: vector row, analysis
      // history, embedding queue and processing state (the coordinator does
      // all four), then one BM25 rebuild. Dropping the vector row alone left
      // the files in history, keyword search and the Atlas, and a queued
      // embedding came back as a row.
      const coordinator = container.tryResolve(ServiceIds.FILE_PATH_COORDINATOR);
      const orama = getOramaService();
      for (const item of result.trashed) {
        try {
          if (coordinator && typeof coordinator.handleFileDeletion === 'function') {
            await coordinator.handleFileDeletion(item.path);
          } else if (orama && typeof orama.deleteFileByPath === 'function') {
            await orama.deleteFileByPath(item.path);
          }
        } catch (err) {
          logger.warn('[EMBEDDINGS] Failed to remove trashed file from the indexes', {
            path: item.path,
            error: err?.message
          });
        }
      }
      if (result.trashed.length > 0) {
        try {
          getSearchServiceInstance()
            ?.invalidateAndRebuild?.({ immediate: false, reason: 'trash-duplicates' })
            ?.catch?.(() => {});
        } catch {
          // Best effort; the staleness timer catches up otherwise.
        }
      }
    }

    return {
      success: result.failed.length === 0,
      trashed: result.trashed,
      failed: result.failed,
      totalBytes: result.totalBytes
    };
  } catch (e) {
    logger.error('[EMBEDDINGS] Trash duplicates failed:', e);
    return {
      success: false,
      error: e.message,
      trashed: /** @type {any[]} */ ([]),
      failed: paths?.map((p) => ({ path: p, error: e.message })) || []
    };
  }
}

/**
 * Enrich duplicate-group members with their current on-disk byte size.
 *
 * The vector DB schema does not persist file size, so statting each member is
 * the source of truth and reflects the file's *current* size rather than a
 * stale index value. `result.groups` and `result.tiers.*` share the same
 * member object references, so mutating each member once updates every view.
 * Files that can't be statted (moved/deleted/permission) are left without a
 * size so the UI shows "Size unavailable" instead of a misleading "0 B".
 *
 * @param {Record<string, any>} result findNearDuplicates result (mutated in place).
 */
async function enrichDuplicateMemberSizes(result) {
  const groups = Array.isArray(result?.groups) ? result.groups : [];
  if (groups.length === 0) return;

  const uniquePaths = new Set();
  for (const group of groups) {
    const members = Array.isArray(group?.members) ? group.members : [];
    for (const member of members) {
      const filePath = member?.path || member?.filePath;
      if (filePath) uniquePaths.add(filePath);
    }
  }
  if (uniquePaths.size === 0) return;

  const sizeByPath = new Map();
  await Promise.all(
    [...uniquePaths].map(async (filePath) => {
      try {
        const stat = await fs.stat(filePath);
        if (stat.isFile()) sizeByPath.set(filePath, stat.size);
      } catch {
        // Missing/unreadable file — leave its size unknown.
      }
    })
  );

  for (const group of groups) {
    const members = Array.isArray(group?.members) ? group.members : [];
    for (const member of members) {
      const filePath = member?.path || member?.filePath;
      const size = filePath ? sizeByPath.get(filePath) : undefined;
      if (typeof size === 'number') member.size = size;
    }
  }
}

/**
 * @param {SemanticHandlerDeps} deps
 * @param {IpcMainInvokeEvent} event
 * @param {{ threshold?: number, maxResults?: number, tierThresholds?: Record<string, any> }} [payload]
 */
async function handleFindDuplicates(
  { safeEnsureInit, logger },
  event,
  { threshold = 0.9, maxResults = 50, tierThresholds } = {}
) {
  const initErr = await safeEnsureInit();
  if (initErr) return initErr;
  try {
    const numThreshold = Number(threshold);
    if (isNaN(numThreshold) || numThreshold < 0.7 || numThreshold > 1) {
      return {
        success: false,
        error: 'threshold must be a number between 0.7 and 1.0',
        tiers: { exact: [], nearIdentical: [], related: [] },
        groups: [],
        totalDuplicates: 0
      };
    }

    const numMaxResults = Number(maxResults);
    if (!Number.isInteger(numMaxResults) || numMaxResults < 1 || numMaxResults > 200) {
      return {
        success: false,
        error: 'maxResults must be an integer between 1 and 200',
        tiers: { exact: [], nearIdentical: [], related: [] },
        groups: [],
        totalDuplicates: 0
      };
    }

    const service = getClusteringService();
    if (!service) return SERVICE_UNAVAILABLE('ClusteringService');
    // Thread the IPC abort signal through so a renderer that closes the
    // duplicate finder mid-scan actually stops the O(n²) cosine loop.
    const result = await service.findNearDuplicates({
      threshold: numThreshold,
      maxResults: numMaxResults,
      tierThresholds,
      signal: event?.abortSignal || undefined
    });

    if (result?.success) {
      await enrichDuplicateMemberSizes(result);
    }

    return result;
  } catch (e) {
    logger.error('[EMBEDDINGS] Find duplicates failed:', e);
    return {
      success: false,
      error: `Failed to find duplicate files: ${e.message}`,
      operation: 'FIND_DUPLICATES',
      tiers: { exact: [], nearIdentical: [], related: [] },
      groups: [],
      totalDuplicates: 0
    };
  }
}

/**
 * @param {SemanticHandlerDeps} deps
 * @param {IpcMainInvokeEvent} event
 * @param {{ fileIds?: string[] }} [payload]
 */
async function handleGetFileMetadata({ safeEnsureInit, logger }, event, { fileIds } = {}) {
  const initErr = await safeEnsureInit();
  if (initErr) return initErr;
  try {
    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      return { success: true, metadata: {} };
    }

    // Validate and limit file IDs
    const validIds = fileIds
      .filter((id) => typeof id === 'string' && id.length > 0 && id.length < 2048)
      .slice(0, 100); // Limit to 100 files per request

    if (validIds.length === 0) {
      return { success: true, metadata: {} };
    }

    const oramaSvc = getOramaService();
    if (!oramaSvc) return SERVICE_UNAVAILABLE('OramaVectorService');
    await oramaSvc.initialize();

    // Batch-fetch file metadata via OramaVectorService.getFile()
    /** @type {Record<string, any>} */
    const metadata = {};
    await Promise.allSettled(
      validIds.map(async (id) => {
        try {
          const doc = await oramaSvc.getFile(id);
          if (doc) {
            metadata[id] = {
              path: doc.filePath,
              filePath: doc.filePath,
              fileName: doc.fileName,
              fileType: doc.fileType,
              analyzedAt: doc.analyzedAt,
              suggestedName: doc.suggestedName,
              keywords: doc.keywords,
              tags: doc.tags,
              extractionMethod: doc.extractionMethod
            };
          }
        } catch {
          // Individual fetch failure is non-critical
        }
      })
    );

    return { success: true, metadata };
  } catch (e) {
    logger.error('[EMBEDDINGS] Get file metadata failed:', e);
    return {
      success: false,
      error: `Failed to retrieve file metadata: ${e.message}`,
      operation: 'GET_FILE_METADATA',
      metadata: {}
    };
  }
}

/**
 * Atlas: build (if needed) and return a page of the latent-space projection.
 * Heavy UMAP work happens once inside AtlasProjectionService and is cached;
 * this handler just serves a page small enough for the preload payload guards.
 * @param {SemanticHandlerDeps} deps
 * @param {IpcMainInvokeEvent} event
 * @param {{ offset?: number, limit?: number, force?: boolean }} [payload]
 */
async function handleGetAtlasProjection({ safeEnsureInit, logger }, event, payload = {}) {
  const initErr = await safeEnsureInit();
  if (initErr) return initErr;
  try {
    const svc = getAtlasService();
    if (!svc) return SERVICE_UNAVAILABLE('AtlasProjectionService');
    const page = await svc.getProjectionPage({
      offset: Number(payload?.offset) || 0,
      limit: Number(payload?.limit) || undefined,
      force: payload?.force === true
    });
    return { success: true, ...page };
  } catch (e) {
    logger.error('[ATLAS] Get projection failed:', e);
    return { success: false, error: `Failed to build atlas projection: ${e.message}` };
  }
}

/**
 * @param {SemanticHandlerDeps} deps
 */
async function handleGetAtlasStatus({ safeEnsureInit, logger }) {
  const initErr = await safeEnsureInit();
  if (initErr) return initErr;
  try {
    const svc = getAtlasService();
    if (!svc) return SERVICE_UNAVAILABLE('AtlasProjectionService');
    const status = await svc.getStatus();
    return { success: true, ...status };
  } catch (e) {
    logger.error('[ATLAS] Get status failed:', e);
    return { success: false, error: `Failed to get atlas status: ${e.message}` };
  }
}

/**
 * @param {SemanticHandlerDeps} deps
 * @param {IpcMainInvokeEvent} event
 * @param {{ paths?: string[] }} [payload]
 */
async function handleFindFilesByPaths({ safeEnsureInit, logger }, event, { paths } = {}) {
  const initErr = await safeEnsureInit();
  if (initErr) return initErr;
  try {
    if (!Array.isArray(paths) || paths.length === 0) {
      return { success: true, results: [] };
    }

    const orama = getOramaService();
    if (!orama) return SERVICE_UNAVAILABLE('OramaVectorService');
    await orama.initialize();
    /** @type {Record<string, any>[]} */
    const results = [];

    // Process paths in parallel
    await Promise.allSettled(
      paths.map(async (p) => {
        try {
          const ext = path.extname(p).toLowerCase();
          const isImage = SUPPORTED_IMAGE_EXTENSIONS.includes(ext);
          const type = isImage ? 'image' : 'file';
          const id = getFileEmbeddingId(p, type);

          const doc = await orama.getFile(id);
          if (doc) {
            results.push({
              path: doc.filePath,
              id: id,
              name: doc.fileName,
              type: type
            });
          }
        } catch {
          // Ignore
        }
      })
    );

    return { success: true, results };
  } catch (e) {
    logger.error('[EMBEDDINGS] Find files by paths failed:', e);
    return { success: false, error: e.message };
  }
}

/**
 * @param {SemanticHandlerDeps} deps
 * @param {IpcMainInvokeEvent} event
 * @param {{ fileIds?: string[], threshold?: number, maxEdgesPerNode?: number }} [payload]
 */
async function handleGetSimilarityEdges(
  { safeEnsureInit, logger },
  event,
  {
    fileIds,
    threshold = THRESHOLDS.SIMILARITY_EDGE_DEFAULT,
    maxEdgesPerNode = THRESHOLDS.SIMILARITY_EDGE_MAX_PER_NODE
  } = {}
) {
  const initErr = await safeEnsureInit();
  if (initErr) return initErr;
  try {
    if (!Array.isArray(fileIds) || fileIds.length < 2) {
      return { success: true, edges: [] };
    }

    // Validate threshold (should be between 0 and 1)
    const numThreshold = Number(threshold);
    if (isNaN(numThreshold) || numThreshold < 0 || numThreshold > 1) {
      return {
        success: false,
        error: 'threshold must be a number between 0 and 1',
        edges: []
      };
    }

    // Validate maxEdgesPerNode (should be a positive integer)
    const numMaxEdges = Number(maxEdgesPerNode);
    if (!Number.isInteger(numMaxEdges) || numMaxEdges < 1 || numMaxEdges > 20) {
      return {
        success: false,
        error: 'maxEdgesPerNode must be an integer between 1 and 20',
        edges: []
      };
    }

    // Filter and limit fileIds
    const validIds = fileIds
      .filter((id) => typeof id === 'string' && id.length > 0 && id.length < 2048)
      .slice(0, 500); // Limit to 500 files for performance

    if (validIds.length < 2) {
      return { success: true, edges: [] };
    }

    const service = getClusteringService();
    if (!service) return SERVICE_UNAVAILABLE('ClusteringService');
    const edges = await service.findFileSimilarityEdges(validIds, {
      threshold: numThreshold,
      maxEdgesPerNode: numMaxEdges
    });

    return {
      success: true,
      edges
    };
  } catch (e) {
    logger.error('[EMBEDDINGS] Get similarity edges failed:', e);
    return {
      success: false,
      error: `Failed to compute similarity edges: ${e.message}`,
      operation: 'GET_SIMILARITY_EDGES',
      edges: []
    };
  }
}

/** @param {SemanticHandlerDeps} deps */
async function handleClearClusters({ safeEnsureInit, logger }) {
  const initErr = await safeEnsureInit();
  if (initErr) return initErr;
  try {
    const service = getClusteringService();
    if (!service) return SERVICE_UNAVAILABLE('ClusteringService');
    service.clearClusters();
    logger.info('[EMBEDDINGS] Cluster cache cleared manually');
    return { success: true, message: 'Cluster cache cleared' };
  } catch (e) {
    logger.error('[EMBEDDINGS] Clear clusters failed:', e);
    return {
      success: false,
      error: `Failed to clear cluster cache: ${e.message}`,
      operation: 'CLEAR_CLUSTERS'
    };
  }
}

/**
 * @param {SemanticHandlerDeps} deps
 * @param {IpcMainInvokeEvent} event
 * @param {{ clusterId: string, newLabel: string }} payload
 */
async function handleRenameCluster({ safeEnsureInit, logger }, event, { clusterId, newLabel }) {
  const initErr = await safeEnsureInit();
  if (initErr) return initErr;
  try {
    const { app } = require('electron');
    const labelsFilePath = require('path').join(
      app.getPath('userData'),
      'cluster-user-labels.json'
    );
    const service = getClusteringService();
    if (!service) return SERVICE_UNAVAILABLE('ClusteringService');
    await service.renameCluster(clusterId, newLabel, labelsFilePath);
    logger.info(`[EMBEDDINGS] Cluster ${clusterId} renamed to "${newLabel}"`);
    return { success: true, clusterId, newLabel };
  } catch (e) {
    logger.error('[EMBEDDINGS] Rename cluster failed:', e);
    return { success: false, error: `Failed to rename cluster: ${e.message}` };
  }
}

/**
 * @param {SemanticHandlerDeps} deps
 * @param {IpcMainInvokeEvent} event
 * @param {{ clusterId?: number }} [payload]
 */
async function handleGetClusterMembers({ safeEnsureInit, logger }, event, { clusterId } = {}) {
  const initErr = await safeEnsureInit();
  if (initErr) return initErr;
  try {
    // Zod schema enforces z.number(); no string coercion needed
    if (!Number.isInteger(clusterId)) {
      return { success: false, error: 'clusterId must be an integer' };
    }
    const numericId = clusterId;

    const service = getClusteringService();
    if (!service) return SERVICE_UNAVAILABLE('ClusteringService');
    const members = await service.getClusterMembers(numericId);

    return {
      success: true,
      clusterId,
      members
    };
  } catch (e) {
    logger.error('[EMBEDDINGS] Get cluster members failed:', e);
    return {
      success: false,
      error: `Failed to get members of cluster ${clusterId}: ${e.message}`,
      operation: 'GET_CLUSTER_MEMBERS',
      clusterId
    };
  }
}

/** @param {SemanticHandlerDeps} deps */
async function handleGetClusters({ safeEnsureInit, logger }) {
  const initErr = await safeEnsureInit();
  if (initErr) return initErr;
  try {
    const service = getClusteringService();
    if (!service) return SERVICE_UNAVAILABLE('ClusteringService');
    const clusters = service.getClustersForGraph();
    const crossClusterEdges = await service.findCrossClusterEdges(
      THRESHOLDS.SIMILARITY_EDGE_DEFAULT
    );

    return {
      success: true,
      clusters,
      crossClusterEdges,
      stale: service.isClustersStale()
    };
  } catch (e) {
    logger.error('[EMBEDDINGS] Get clusters failed:', e);
    return {
      success: false,
      error: `Failed to retrieve clusters: ${e.message}`,
      operation: 'GET_CLUSTERS'
    };
  }
}

/**
 * @param {SemanticHandlerDeps} deps
 * @param {IpcMainInvokeEvent} event
 * @param {{ k?: number|string, generateLabels?: boolean }} [payload]
 */
async function handleComputeClusters(
  { safeEnsureInit, logger },
  event,
  { k = 'auto', generateLabels = false } = {}
) {
  const initErr = await safeEnsureInit();
  if (initErr) return initErr;
  try {
    // Validate k parameter
    if (k !== 'auto') {
      const numK = Number(k);
      if (!Number.isInteger(numK) || numK < 1 || numK > 100) {
        return {
          success: false,
          error: "k must be 'auto' or an integer between 1 and 100"
        };
      }
    }

    const service = getClusteringService();
    if (!service) return SERVICE_UNAVAILABLE('ClusteringService');
    const result = await service.computeClusters(k);

    if (result.success && result.clusters.length > 0) {
      // Phase 1: Generate fast metadata-based labels (no LLM) so
      // the graph has meaningful labels immediately.
      await service.generateClusterLabels({ skipLLM: true });

      // Build the full response with clusters + cross-cluster edges
      // so the frontend can render without an extra getClusters call.
      const clusters = service.getClustersForGraph();
      const crossClusterEdges = await service.findCrossClusterEdges(
        THRESHOLDS.SIMILARITY_EDGE_DEFAULT
      );

      // Phase 2: Fire LLM label refinement in the background (non-blocking).
      // Labels will be available on the next getClusters call.
      if (generateLabels) {
        const llamaService = getLlamaService();
        const textQueue = llamaService?.getQueueStats?.()?.text || null;
        const textQueued = Math.max(0, Number(textQueue?.queued) || 0);
        const textPending = Math.max(0, Number(textQueue?.pending) || 0);
        const textConcurrency = Math.max(1, Number(textQueue?.concurrency) || 1);
        const textQueueBusy = textQueued > 0 || textPending >= textConcurrency;
        const memoryAllowsOptionalText =
          typeof llamaService?.canRunOptionalInference === 'function'
            ? llamaService.canRunOptionalInference('text')
            : false;

        if (textQueueBusy) {
          logger.info(
            '[EMBEDDINGS] Deferring background LLM label refinement due to text queue pressure',
            {
              pending: textPending,
              queued: textQueued,
              textConcurrency
            }
          );
        } else if (!memoryAllowsOptionalText) {
          logger.info(
            '[EMBEDDINGS] Skipping background LLM label refinement — text model not loaded and memory budget is tight'
          );
        } else {
          service.generateClusterLabels({ skipLLM: false }).catch((/** @type {any} */ err) => {
            logger.warn('[EMBEDDINGS] Background LLM label generation failed:', err.message);
          });
        }
      }

      return {
        ...result,
        clusters,
        crossClusterEdges,
        stale: false
      };
    }

    return result;
  } catch (e) {
    logger.error('[EMBEDDINGS] Cluster computation failed:', e);
    return {
      success: false,
      error: `Cluster computation failed: ${e.message}`,
      operation: 'COMPUTE_CLUSTERS'
    };
  }
}

/**
 * @param {SemanticHandlerDeps} deps
 * @param {IpcMainInvokeEvent} event
 * @param {{ seedIds?: string[], options?: Record<string, any> }} [payload]
 */
async function handleFindMultiHop(
  { safeEnsureInit, logger },
  event,
  { seedIds, options = {} } = {}
) {
  const initErr = await safeEnsureInit();
  if (initErr) return initErr;
  try {
    if (!Array.isArray(seedIds) || seedIds.length === 0) {
      return { success: false, error: 'seedIds must be a non-empty array' };
    }

    // The seed cap (10) is enforced by the embeddingsFindMultiHop Zod schema;
    // oversized requests are rejected before reaching here.
    const validIds = seedIds.filter((id) => typeof id === 'string' && id.length > 0);

    if (validIds.length === 0) {
      return { success: false, error: 'No valid seedIds provided' };
    }

    // Map UI parameters to service parameters (fixes parameter name mismatch)
    // UI sends: { hops, decay } but service expects: { maxHops, decayFactor }
    const mappedOptions = {
      maxHops: options.hops ?? options.maxHops,
      topKPerHop: options.topKPerHop,
      decayFactor: options.decay ?? options.decayFactor
    };

    const results = await getFolderMatcher().findMultiHopNeighbors(validIds, mappedOptions);
    return { success: true, results };
  } catch (e) {
    logger.error('[EMBEDDINGS] Multi-hop expansion failed:', e);
    return { success: false, error: e.message };
  }
}

/** @param {SemanticHandlerDeps} deps */
async function handleGetSearchStatus({ safeEnsureInit, logger }) {
  const initErr = await safeEnsureInit();
  if (initErr) return initErr;
  try {
    const service = getSearchService();
    if (!service) return SERVICE_UNAVAILABLE('SearchService');
    return { success: true, status: service.getIndexStatus() };
  } catch (e) {
    logger.error('[EMBEDDINGS] Get search status failed:', e);
    return { success: false, error: e.message };
  }
}

/** @param {SemanticHandlerDeps} deps */
async function handleRebuildBm25Index({ safeEnsureInit, logger, getServiceIntegration }) {
  const initErr = await safeEnsureInit();
  if (initErr) return initErr;
  try {
    const service = getSearchService();
    if (!service) return SERVICE_UNAVAILABLE('SearchService');
    const result = await service.rebuildIndex();

    // Extend vocabulary for spell correction after index rebuild
    try {
      const queryProcessor = getQueryProcessor();
      const serviceIntegration = getServiceIntegration && getServiceIntegration();
      const historyService = serviceIntegration?.analysisHistory;
      if (queryProcessor && historyService) {
        await queryProcessor.extendVocabulary(historyService);
        logger.debug('[EMBEDDINGS] Vocabulary extended after BM25 rebuild');
      }
    } catch (vocabErr) {
      logger.debug('[EMBEDDINGS] Vocabulary extension failed:', vocabErr.message);
    }

    return result;
  } catch (e) {
    logger.error('[EMBEDDINGS] Rebuild BM25 index failed:', e);
    return { success: false, error: e.message };
  }
}

/**
 * @param {SemanticHandlerDeps} deps
 * @param {IpcMainInvokeEvent} event
 * @param {{ query?: string, fileIds?: string[] }} [payload]
 */
async function handleScoreFiles({ safeEnsureInit, logger }, event, { query, fileIds } = {}) {
  const initErr = await safeEnsureInit();
  if (initErr) return initErr;
  const QUERY_TIMEOUT = TIMEOUTS.SEMANTIC_QUERY;

  try {
    const cleanQuery = normalizeText(query, { maxLength: 2000 });
    if (!cleanQuery) {
      return { success: false, error: 'Query is required' };
    }
    if (cleanQuery.length < 2 || cleanQuery.length > 2000) {
      return { success: false, error: 'Query length must be between 2 and 2000 characters' };
    }

    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      return { success: false, error: 'fileIds must be a non-empty array' };
    }

    // Keep scoring fast and payloads bounded (renderer typically stays < 1000 nodes)
    const MAX_IDS = 1000;
    if (fileIds.length > MAX_IDS) {
      return { success: false, error: `fileIds must contain at most ${MAX_IDS} ids` };
    }

    const normalizedIds = [];
    const seenIds = new Set();
    for (const id of fileIds) {
      if (typeof id !== 'string' || id.length === 0 || id.length >= 2048) continue;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      normalizedIds.push(id);
      if (normalizedIds.length >= MAX_IDS) break;
    }

    if (normalizedIds.length === 0) {
      return { success: false, error: 'No valid fileIds provided' };
    }

    // Create timeout promise
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Query timeout exceeded')), QUERY_TIMEOUT);
    });

    try {
      const scored = await Promise.race([
        (async () => {
          const embeddingService = getParallelEmbeddingService();
          if (!embeddingService) return [];
          const { vector: rawQueryVector } = await embeddingService.embedText(cleanQuery);
          if (!Array.isArray(rawQueryVector) || rawQueryVector.length === 0) {
            return [];
          }

          const oramaSvc = getOramaService();
          if (!oramaSvc) return [];
          await oramaSvc.initialize();
          const expectedDim =
            typeof oramaSvc.getCollectionDimension === 'function'
              ? await oramaSvc.getCollectionDimension('files')
              : null;
          const queryVector = padOrTruncateVector(rawQueryVector, expectedDim);
          if (!Array.isArray(queryVector) || queryVector.length === 0) {
            return [];
          }

          // Batch-fetch file embeddings via OramaVectorService.getFile()
          const fileEntries = await Promise.all(
            normalizedIds.map(async (id) => {
              try {
                const doc = await oramaSvc.getFile(id);
                return doc ? { id: doc.id, embedding: doc.embedding } : null;
              } catch {
                return null;
              }
            })
          );
          const validEntries = fileEntries.filter(Boolean);
          const ids = validEntries.map((e) => e.id);
          const embeddings = validEntries.map((e) => e.embedding);

          const scores = [];
          let dimensionMismatches = 0;
          for (let i = 0; i < ids.length; i += 1) {
            const vec = embeddings[i];
            if (!Array.isArray(vec) || vec.length === 0) continue;
            // Fail closed on dimension mismatch (vector recorded under a
            // previous embedding model). Padding/truncating produces
            // meaningless similarity scores; SearchService applies the same
            // skip-and-log policy.
            if (vec.length !== queryVector.length) {
              dimensionMismatches += 1;
              continue;
            }
            const score = cosineSimilarity(queryVector, vec);
            scores.push({ id: ids[i], score });
          }
          if (dimensionMismatches > 0) {
            logger.warn('[EMBEDDINGS] scoreFiles skipped vectors with mismatched dimensions', {
              skipped: dimensionMismatches,
              expectedDim: queryVector.length
            });
          }

          scores.sort((a, b) => b.score - a.score);
          return scores;
        })(),
        timeoutPromise
      ]);

      return { success: true, scores: scored };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  } catch (e) {
    logger.error('[EMBEDDINGS] scoreFiles failed:', {
      fileCount: Array.isArray(fileIds) ? fileIds.length : 0,
      error: e.message,
      timeout: e.message.includes('timeout')
    });
    return {
      success: false,
      error: e.message,
      timeout: e.message.includes('timeout')
    };
  }
}

/**
 * @param {SemanticHandlerDeps} deps
 * @param {IpcMainInvokeEvent} event
 * @param {{ query?: string, topK?: number, mode?: string, minScore?: number, chunkWeight?: number, chunkTopK?: number, expandSynonyms?: boolean, correctSpelling?: boolean, rerank?: boolean, rerankTopN?: number, graphExpansion?: boolean, graphExpansionWeight?: number, graphExpansionMaxNeighbors?: number, chunkContext?: boolean, chunkContextMaxNeighbors?: number }} [payload]
 */
async function handleSearch(
  { safeEnsureInit, logger, resolveOptionalService },
  event,
  {
    query,
    topK = SEARCH.DEFAULT_TOP_K,
    mode = 'hybrid',
    minScore,
    chunkWeight,
    chunkTopK,
    // Query processing options
    expandSynonyms = true,
    // Enabled with strict safeguards in QueryProcessor (stop-word allowlist,
    // minimum length checks, edit-distance constraints).
    correctSpelling = true,
    // Re-ranking options
    // Default false: each candidate requires a separate LLM inference call,
    // causing 30-50s latency. Callers that can tolerate the cost may opt in.
    rerank = false,
    rerankTopN = 10,
    // Graph expansion options
    graphExpansion,
    graphExpansionWeight,
    graphExpansionMaxNeighbors,
    // Contextual chunk options
    chunkContext,
    chunkContextMaxNeighbors
  } = {}
) {
  const initErr = await safeEnsureInit();
  if (initErr) return initErr;
  const { MAX_TOP_K } = LIMITS;

  let cleanQuery;
  try {
    cleanQuery = normalizeText(query, { maxLength: 2000 });
    if (!cleanQuery) {
      return { success: false, error: 'Query is required' };
    }
    if (cleanQuery.length < 2 || cleanQuery.length > 2000) {
      return { success: false, error: 'Query length must be between 2 and 2000 characters' };
    }

    // Validate topK parameter
    if (!Number.isInteger(topK) || topK < 1 || topK > MAX_TOP_K) {
      return {
        success: false,
        error: `topK must be between 1 and ${MAX_TOP_K}`
      };
    }

    // Validate rerankTopN parameter
    if (!Number.isInteger(rerankTopN) || rerankTopN < 1 || rerankTopN > 50) {
      rerankTopN = 10; // Reset to default if invalid
    }

    let settings = null;
    try {
      const settingsService = resolveOptionalService(ServiceIds.SETTINGS);
      if (settingsService?.load) {
        settings = await settingsService.load();
      }
    } catch (settingsErr) {
      logger.debug('[EMBEDDINGS] Failed to load settings for search', {
        error: settingsErr?.message || String(settingsErr)
      });
    }

    // NOTE on experience mode and graph/chunk toggles
    //
    // Earlier post-2.0.9 builds forced `graphExpansion` and `chunkContext`
    // OFF at search time whenever Simple mode was active. That dates from
    // when Simple meant "minimal features off". The policy was inverted in
    // 2026-04 (see SIMPLE_MODE_ENFORCED_VALUES in experienceMode.js): both
    // Simple and Advanced now ship with `graphExpansionEnabled: true` and
    // `chunkContextEnabled: true` as recommended defaults; the mode field
    // only controls which knobs the Settings UI exposes.
    //
    // Keeping the IPC override here meant the persisted setting said one
    // thing (`graphExpansionEnabled: true`) and the runtime did another
    // (forced `false`). The graph/chunk toggles in `GraphRetrievalSection`
    // had no observable effect for Simple-mode users, which is what the
    // audit flagged. Honor the user's explicit override; experienceMode
    // gates surfacing in the UI, not the runtime path.
    const graphExpansionSetting =
      typeof graphExpansion === 'boolean'
        ? graphExpansion
        : typeof settings?.graphExpansionEnabled === 'boolean'
          ? settings.graphExpansionEnabled
          : undefined;
    const graphExpansionWeightSetting = Number.isFinite(graphExpansionWeight)
      ? graphExpansionWeight
      : Number.isFinite(settings?.graphExpansionWeight)
        ? settings.graphExpansionWeight
        : undefined;
    const graphExpansionMaxNeighborsSetting = Number.isInteger(graphExpansionMaxNeighbors)
      ? graphExpansionMaxNeighbors
      : Number.isInteger(settings?.graphExpansionMaxNeighbors)
        ? settings.graphExpansionMaxNeighbors
        : undefined;
    const chunkContextSetting =
      typeof chunkContext === 'boolean'
        ? chunkContext
        : typeof settings?.chunkContextEnabled === 'boolean'
          ? settings.chunkContextEnabled
          : undefined;
    const chunkContextMaxNeighborsSetting = Number.isInteger(chunkContextMaxNeighbors)
      ? chunkContextMaxNeighbors
      : Number.isInteger(settings?.chunkContextMaxNeighbors)
        ? settings.chunkContextMaxNeighbors
        : undefined;

    // BM25-only mode doesn't need embeddings
    let effectiveMode = mode;
    let fallbackReason = null;
    if (mode !== 'bm25') {
      const modelCheck = await verifyEmbeddingModelAvailable(logger);
      if (!modelCheck.available) {
        if (mode === 'vector') {
          // Vector-only mode requires embeddings - fail gracefully
          return {
            success: false,
            error: `Embedding model not available: ${modelCheck.error}`,
            errorCode: 'MODEL_NOT_AVAILABLE',
            model: modelCheck.model
          };
        }
        logger.warn('[EMBEDDINGS] Embedding model unavailable, falling back to BM25-only search', {
          requestedMode: mode,
          error: modelCheck.error
        });
        effectiveMode = 'bm25';
        fallbackReason = modelCheck.error?.includes('not running')
          ? 'AI engine unavailable - using keyword search only'
          : `Embedding model unavailable: ${modelCheck.error}`;
      }
    }

    // Use SearchService for hybrid BM25 + vector search with quality filtering
    const service = getSearchService();
    if (!service) return SERVICE_UNAVAILABLE('SearchService');
    const searchOptions = {
      topK,
      mode: effectiveMode, // Use effective mode (may be fallback)
      ...(typeof minScore === 'number' && { minScore }),
      ...(typeof chunkWeight === 'number' && chunkWeight >= 0 && chunkWeight <= 1
        ? { chunkWeight }
        : {}),
      ...(Number.isInteger(chunkTopK) && chunkTopK >= 1 && chunkTopK <= MAX_TOP_K * 20
        ? { chunkTopK }
        : {}),
      ...(typeof graphExpansionSetting === 'boolean'
        ? { graphExpansion: graphExpansionSetting }
        : {}),
      ...(Number.isFinite(graphExpansionWeightSetting)
        ? { graphExpansionWeight: graphExpansionWeightSetting }
        : {}),
      ...(Number.isInteger(graphExpansionMaxNeighborsSetting)
        ? { graphExpansionMaxNeighbors: graphExpansionMaxNeighborsSetting }
        : {}),
      ...(typeof chunkContextSetting === 'boolean' ? { chunkContext: chunkContextSetting } : {}),
      ...(Number.isInteger(chunkContextMaxNeighborsSetting)
        ? { chunkContextMaxNeighbors: chunkContextMaxNeighborsSetting }
        : {}),
      // Query processing options
      expandSynonyms: Boolean(expandSynonyms),
      correctSpelling: Boolean(correctSpelling),
      // Re-ranking options
      rerank: Boolean(rerank),
      rerankTopN
    };

    const result = await service.hybridSearch(cleanQuery, searchOptions);

    if (!result.success) {
      const requiresRebuild = isDimensionMismatchError({ message: result.error });
      if (effectiveMode !== 'bm25') {
        logger.warn('[EMBEDDINGS] Search failed, attempting BM25 fallback', {
          originalMode: effectiveMode,
          error: result.error
        });
        const fallbackResult = await service.hybridSearch(cleanQuery, {
          ...searchOptions,
          mode: 'bm25'
        });
        if (fallbackResult.success) {
          return {
            success: true,
            results: fallbackResult.results,
            mode: 'bm25',
            meta: {
              ...fallbackResult.meta,
              fallback: true,
              originalMode: effectiveMode,
              fallbackReason: result.error
            }
          };
        }
      }
      return {
        success: false,
        error: result.error || 'Search failed',
        errorCode: requiresRebuild ? ERROR_CODES.VECTOR_DB_DIMENSION_MISMATCH : null,
        requiresRebuild
      };
    }

    return {
      success: true,
      results: result.results,
      mode: result.mode || effectiveMode,
      queryMeta: result.queryMeta, // Include query processing info (corrections, synonyms)
      meta: {
        ...result.meta,
        ...(effectiveMode !== mode && {
          fallback: true,
          originalMode: mode,
          fallbackReason: fallbackReason || 'Semantic search unavailable'
        })
      }
    };
  } catch (e) {
    const requiresRebuild = isDimensionMismatchError(e);
    logger.error('[EMBEDDINGS] Search failed:', {
      topK,
      error: e.message,
      timeout: e.message.includes('timeout')
    });

    if (mode !== 'bm25') {
      try {
        const service = getSearchService();
        if (!service) {
          return { success: false, error: 'SearchService not available for BM25 fallback' };
        }
        const fallbackResult = await service.hybridSearch(
          cleanQuery || (typeof query === 'string' ? query.trim() : ''),
          { topK, mode: 'bm25' }
        );
        if (fallbackResult.success) {
          return {
            success: true,
            results: fallbackResult.results,
            mode: 'bm25',
            meta: {
              ...fallbackResult.meta,
              fallback: true,
              originalMode: mode,
              fallbackReason: e.message
            }
          };
        }
      } catch (fallbackError) {
        logger.error('[EMBEDDINGS] BM25 fallback also failed:', {
          error: fallbackError.message
        });
      }
    }

    return {
      success: false,
      error: e.message,
      errorCode: e.code || (requiresRebuild ? ERROR_CODES.VECTOR_DB_DIMENSION_MISMATCH : null),
      requiresRebuild,
      timeout: e.message.includes('timeout')
    };
  }
}

/**
 * @param {SemanticHandlerDeps} deps
 * @param {IpcMainInvokeEvent} event
 * @param {{ fileId?: string, topK?: number }} [payload]
 */
async function handleFindSimilar(
  { safeEnsureInit, logger },
  event,
  { fileId, topK = SEARCH.DEFAULT_TOP_K_SIMILAR } = {}
) {
  const initErr = await safeEnsureInit();
  if (initErr) return initErr;
  // Add timeout and validation
  const QUERY_TIMEOUT = TIMEOUTS.SEMANTIC_QUERY;
  const { MAX_TOP_K } = LIMITS;

  try {
    if (!fileId) {
      return { success: false, error: 'File ID is required' };
    }

    // Validate topK parameter
    if (!Number.isInteger(topK) || topK < 1 || topK > MAX_TOP_K) {
      return {
        success: false,
        error: `topK must be between 1 and ${MAX_TOP_K}`
      };
    }

    // Create timeout promise
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Query timeout exceeded')), QUERY_TIMEOUT);
    });

    // Race query against timeout
    let similarFiles;
    try {
      similarFiles = await Promise.race([
        getFolderMatcher().findSimilarFiles(fileId, topK),
        timeoutPromise
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    return { success: true, results: similarFiles };
  } catch (e) {
    const requiresRebuild = isDimensionMismatchError(e);
    logger.error('[EMBEDDINGS] Find similar failed:', {
      fileId,
      topK,
      error: e.message,
      timeout: e.message.includes('timeout')
    });
    return {
      success: false,
      error: e.message,
      errorCode: e.code || (requiresRebuild ? ERROR_CODES.VECTOR_DB_DIMENSION_MISMATCH : null),
      requiresRebuild,
      timeout: e.message.includes('timeout')
    };
  }
}

/**
 * @param {SemanticHandlerDeps} deps
 * @param {IpcMainInvokeEvent} event
 * @param {{ testQuery?: string }} [payload]
 */
async function handleDiagnoseSearch(
  { safeEnsureInit, logger },
  event,
  { testQuery = 'test' } = {}
) {
  const initErr = await safeEnsureInit();
  if (initErr) return initErr;
  try {
    const searchSvc = await getSearchService();

    if (!searchSvc || !searchSvc.diagnoseSearchIssues) {
      return {
        success: false,
        error: 'SearchService not available or missing diagnoseSearchIssues method'
      };
    }

    const diagnostics = await searchSvc.diagnoseSearchIssues(testQuery);

    return {
      success: true,
      diagnostics
    };
  } catch (e) {
    logger.error('[EMBEDDINGS] Diagnose search failed:', {
      error: e.message,
      stack: e.stack
    });
    return {
      success: false,
      error: e.message
    };
  }
}

/** @param {SemanticHandlerDeps} deps */
async function handleGetStats({ safeEnsureInit, logger, getCustomFolders, getServiceIntegration }) {
  const initErr = await safeEnsureInit();
  if (initErr) return initErr;
  try {
    const stats = await getOramaService().getStats();

    // Provide lightweight context so the UI can explain *why* embeddings are empty.
    // This avoids confusing "rebuild embeddings" prompts when users already have analysis history.
    let analysisHistory = null;
    try {
      const serviceIntegration =
        typeof getServiceIntegration === 'function' ? getServiceIntegration() : null;
      const historyService = serviceIntegration?.analysisHistory;
      if (historyService?.getQuickStats) {
        analysisHistory = await historyService.getQuickStats();
      } else if (historyService?.getStatistics) {
        // Fallback (cached) stats if quick stats not available.
        const full = await historyService.getStatistics();
        analysisHistory = {
          totalFiles: typeof full?.totalFiles === 'number' ? full.totalFiles : 0
        };
      }
    } catch {
      // Non-fatal: stats still useful without history context
      analysisHistory = null;
    }

    const historyTotalRaw =
      typeof analysisHistory?.totalFiles === 'number' ? analysisHistory.totalFiles : 0;
    const embeddingEligibleTotal =
      typeof analysisHistory?.embedding?.eligibleFiles === 'number'
        ? analysisHistory.embedding.eligibleFiles
        : null;
    const historyTotal =
      typeof embeddingEligibleTotal === 'number' ? embeddingEligibleTotal : historyTotalRaw;
    const fileCount = typeof stats?.files === 'number' ? stats.files : 0;
    // Clamped: the store can legitimately hold more vectors than there are
    // eligible files (vectors for files whose history rows are now marked
    // skipped), and a ">100% indexed" reading looks like a bug to the user.
    const embeddingCoverage =
      historyTotal > 0 ? Number(Math.min(1, fileCount / historyTotal).toFixed(3)) : null;
    const embeddingBuildInProgress = isEmbeddingPipelineBusy();

    let embeddingIndex = null;
    try {
      embeddingIndex = await readEmbeddingIndexMetadata();
    } catch {
      embeddingIndex = null;
    }

    // A prior rebuild that crashed between resetAll() and final commit leaves
    // `rebuildInProgress: true` on disk. In that case the vector store is
    // torn regardless of current fileCount, so force a rebuild recommendation.
    const embeddingRebuildInterrupted = Boolean(embeddingIndex?.rebuildInProgress);

    const uncoveredFiles = Math.max(0, historyTotal - fileCount);

    // Two distinct states, because the UI words them differently:
    // - needsFileEmbeddingRebuild: the file index is EMPTY (or a rebuild was
    //   interrupted), so semantic search has nothing. The banner says "empty".
    // - embeddingCoverageLow (F-197 / K-02, decision D6): some files are
    //   indexed but fewer than 95% of eligible ones. "empty" used to be the
    //   only unhealthy state, so 11 vectors for 281 analyzed files read as
    //   fine. The startup repair (F-198) closes the gap; Rebuild does it now.
    // Folding partial coverage into needsFileEmbeddingRebuild made the banner
    // announce "Search index is empty" over an index holding 11 files.
    const needsFileEmbeddingRebuild =
      !embeddingBuildInProgress &&
      (embeddingRebuildInterrupted || (fileCount === 0 && historyTotal > 0));
    const embeddingCoverageLow =
      !embeddingBuildInProgress &&
      uncoveredFiles >= 1 &&
      embeddingCoverage !== null &&
      embeddingCoverage < MIN_HEALTHY_FILE_EMBEDDING_COVERAGE;

    const llamaSvc = getLlamaService();
    const cfg = llamaSvc ? await llamaSvc.getConfig() : {};
    const activeEmbeddingModel = cfg.embeddingModel || AI_DEFAULTS.EMBEDDING.MODEL;
    const embeddingModelMismatch =
      Boolean(embeddingIndex?.model) &&
      typeof embeddingIndex?.model === 'string' &&
      embeddingIndex.model !== activeEmbeddingModel;
    let smartFolderCount = 0;
    try {
      const customFolders = typeof getCustomFolders === 'function' ? getCustomFolders() : [];
      smartFolderCount = Array.isArray(customFolders) ? customFolders.length : 0;
    } catch (folderErr) {
      logger.warn('[SEMANTIC] smartFolderCount failed; defaulting to 0', {
        error: folderErr?.message
      });
    }

    return {
      success: true,
      ...stats,
      analysisHistory,
      embeddingCoverage,
      uncoveredFiles,
      embeddingCoverageLow,
      needsFileEmbeddingRebuild,
      embeddingRebuildInterrupted,
      embeddingBuildInProgress,
      smartFolderCount,
      embeddingIndex,
      activeEmbeddingModel,
      embeddingModelMismatch
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * @param {SemanticHandlerDeps} deps
 * @param {IpcMainInvokeEvent} _event
 * @param {string|Record<string, any>} [payload]
 */
async function handleReanalyzeFile({ logger, getServiceIntegration }, _event, payload = {}) {
  const filePath = typeof payload === 'string' ? payload : payload?.filePath;
  const applyNaming = /** @type {Record<string, any>} */ (payload)?.applyNaming;

  if (!filePath) {
    return {
      success: false,
      error: 'filePath is required',
      errorCode: 'MISSING_FILE_PATH'
    };
  }

  const validation = await validateFileOperationPath(filePath, { checkSymlinks: true });
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error,
      errorCode: 'INVALID_PATH'
    };
  }

  const serviceIntegration =
    typeof getServiceIntegration === 'function' ? getServiceIntegration() : null;
  const smartFolderWatcher = serviceIntegration?.smartFolderWatcher;
  if (!smartFolderWatcher) {
    return {
      success: false,
      error: 'Smart folder watcher not available. Configure smart folders first.',
      errorCode: 'WATCHER_NOT_AVAILABLE'
    };
  }

  if (!smartFolderWatcher.isRunning) {
    const started = await smartFolderWatcher.start();
    if (!started) {
      return {
        success: false,
        error: 'Failed to start smart folder watcher. Check smart folder configuration.',
        errorCode: 'WATCHER_START_FAILED'
      };
    }
  }

  // SECURITY: scope creep guard for force:true reanalysis.
  //
  // The previous implementation always passed `force: true`, which let
  // any renderer-supplied path (that passed generic sanitation) be
  // pulled through extraction → LLM analysis → embedding → vector DB
  // storage. That is effectively an on-demand file exfiltration
  // primitive scoped only to "not a dangerous system directory".
  //
  // We restrict force:true to two obviously-in-scope roots:
  //   1. Any currently watched smart folder (user explicitly opted in
  //      to indexing these paths).
  //   2. The app's userData directory (our own state, e.g. already-
  //      imported files or fixtures).
  //
  // For anything else we pass `force: false`, which means
  // reanalyzeFile will reject with NOT_IN_SMART_FOLDER — exactly the
  // behavior a user-initiated "reanalyze" button should have when
  // pointed outside the configured smart folders.
  const normalized = validation.normalizedPath;
  let inScope = false;
  try {
    const watchedPaths = smartFolderWatcher.watchedPaths;
    if (watchedPaths && typeof watchedPaths[Symbol.iterator] === 'function') {
      for (const rootRaw of watchedPaths) {
        if (!rootRaw) continue;
        const root = path.resolve(rootRaw);
        const rel = path.relative(root, normalized);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
          inScope = true;
          break;
        }
        if (normalized === root) {
          inScope = true;
          break;
        }
      }
    }
  } catch (scopeErr) {
    // Fail closed: if we can't determine scope, treat as out-of-scope.
    inScope = false;
    logger.warn?.('[EMB:REANALYZE] Smart-folder scope check failed', {
      error: scopeErr?.message || String(scopeErr)
    });
  }

  if (!inScope) {
    try {
      const { app } = require('electron');
      const userData = app?.getPath?.('userData');
      if (userData) {
        const rel = path.relative(path.resolve(userData), normalized);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
          inScope = true;
        }
      }
    } catch {
      // Electron unavailable (e.g. in test harness without app).
    }
  }

  const result = await smartFolderWatcher.reanalyzeFile(validation.normalizedPath, {
    applyNaming,
    // Only allow the "outside smart folders" escape hatch when the
    // path is demonstrably under a configured root or userData.
    force: inScope
  });
  if (!result?.queued) {
    return {
      success: false,
      error: result?.error || 'File not eligible for reanalysis',
      errorCode: result?.errorCode || 'REANALYZE_FILE_SKIPPED'
    };
  }

  return {
    success: true,
    queued: true,
    filePath: validation.normalizedPath,
    message: `Queued ${path.basename(validation.normalizedPath)} for reanalysis.`
  };
}

/**
 * Re-analyzes watched files and re-embeds the rest from history; never clears
 * the store.
 *
 * @param {SemanticHandlerDeps} deps
 * @param {IpcMainInvokeEvent} _event
 * @param {Record<string, any>} [options]
 */
async function handleReanalyzeAll(
  {
    safeEnsureInit,
    logger,
    getCustomFolders,
    getServiceIntegration,
    getMainWindow,
    shouldBuildChunkEmbeddings
  },
  _event,
  options = {}
) {
  const initErr = await safeEnsureInit();
  if (initErr) return initErr;

  const lockResult = acquireRebuildLock('REANALYZE_ALL');
  if (!lockResult.acquired) {
    return {
      success: false,
      error: lockResult.reason,
      errorCode: 'REBUILD_IN_PROGRESS'
    };
  }

  /**
   * Armed on the success path, fired from `finally` once the rebuild lock is
   * released — see the D8 note at the arming site. A throw after the arming
   * point (Step 8's interval setup) still fires it, deliberately: the
   * watcher's queue is already committed by then, and the backfill only
   * upserts, so running it can never make the store worse.
   * @type {null | (() => void)}
   */
  let startBackfill = null;

  try {
    logger.info('[EMBEDDINGS] Starting reanalyze all files operation...', {
      applyNaming: options.applyNaming
    });

    // Step 1: Verify text, vision, and embedding models are available
    const modelCheck = await verifyReanalyzeModelsAvailable(logger);
    if (!modelCheck.available) {
      return {
        success: false,
        error: `MODEL_NOT_AVAILABLE: ${modelCheck.error}`,
        errorCode: 'MODEL_NOT_AVAILABLE',
        model: modelCheck.model,
        modelType: modelCheck.modelType
      };
    }

    // Step 2: Get the smart folder watcher
    const serviceIntegration =
      typeof getServiceIntegration === 'function' ? getServiceIntegration() : null;
    const smartFolderWatcher = serviceIntegration?.smartFolderWatcher;

    if (!smartFolderWatcher) {
      return {
        success: false,
        error: 'Smart folder watcher not available. Configure smart folders first.',
        errorCode: 'WATCHER_NOT_AVAILABLE'
      };
    }

    // Step 3: Start the watcher if not running
    if (!smartFolderWatcher.isRunning) {
      logger.info('[EMBEDDINGS] Starting smart folder watcher...');
      const started = await smartFolderWatcher.start();
      if (!started) {
        return {
          success: false,
          error: 'Failed to start smart folder watcher. Check smart folder configuration.',
          errorCode: 'WATCHER_START_FAILED'
        };
      }
    }

    // Step 4: Optional dry run (no queues)
    if (options.dryRun === true) {
      const preview = await smartFolderWatcher.previewReanalyzeAll();
      return {
        success: true,
        dryRun: true,
        scanned: preview.scanned,
        watchedFolders: preview.watchedFolders,
        outsideWatched: preview.outsideWatched,
        message: `Dry run complete: ${preview.scanned} files would be queued for reanalysis.`
      };
    }

    // Steps 5–6 (history clear + vector resetAll) are intentionally gone
    // (F-189 / K-01, decision D5 "monotonic store"). Reanalysis is queued and
    // asynchronous, so clearing here destroyed every vector and history entry
    // minutes before any replacement existed; a crash, quit, or an unwatched
    // file left the store near-empty while the health banner reported it
    // fine (223 → 11 vectors on 2026-09-13). Each file's re-analysis
    // overwrites its own entry (history `pathLookup` re-points to the new
    // id; the vector store upserts by id), so nothing needs to be destroyed
    // first. Files that no longer exist are handled by the startup reconcile;
    // a changed embedding model is detected at store init and resets there,
    // and `FULL_REBUILD` remains the explicit "wipe and rebuild" path.

    // Step 6.5: Refresh folder embeddings (upsert; nothing is removed)
    logger.info('[EMBEDDINGS] Rebuilding folder embeddings...');
    const smartFolders = (typeof getCustomFolders === 'function' ? getCustomFolders() : []).filter(
      (f) => f && f.name
    );

    if (smartFolders.length > 0) {
      const folderPayloads = await Promise.all(
        smartFolders.map(async (folder) => {
          try {
            const folderText = enrichFolderTextForEmbedding(
              folder.name,
              folder.description,
              folder.keywords
            );
            const { vector, model } = await getFolderMatcher().embedText(folderText);
            const folderId = folder.id || getFolderMatcher().generateFolderId(folder);

            return {
              id: folderId,
              name: folder.name,
              description: folder.description || '',
              path: folder.path || '',
              vector,
              model,
              updatedAt: new Date().toISOString()
            };
          } catch (error) {
            logger.warn(`[EMBEDDINGS] Failed to embed folder ${folder.name}:`, error.message);
            return null;
          }
        })
      );

      const validFolderPayloads = folderPayloads.filter((p) => p !== null);
      if (validFolderPayloads.length > 0) {
        await getOramaService().batchUpsertFolders(validFolderPayloads);
      }
    }

    // Step 7: Queue all files for reanalysis with naming option
    logger.info('[EMBEDDINGS] Queueing all files for reanalysis...');
    const result = await smartFolderWatcher.forceReanalyzeAll({
      applyNaming: options.applyNaming === true // Default to false if not specified
    });

    logger.info('[EMBEDDINGS] Reanalyze all queued:', result);

    // Step 7.5 (D8): the knowledge layer covers everything ever analyzed. The
    // watcher only re-analyzes files inside smart folders; files analyzed
    // elsewhere keep their history and are re-embedded from it, without ever
    // clearing the store.
    //
    // handleRebuildFiles takes the same module-global rebuild lock
    // (acquireRebuildLock('REBUILD_FILES')) that this handler still holds, so
    // the call is armed here and fired from the `finally` below, after
    // releaseRebuildLock() — otherwise it would bounce off REBUILD_IN_PROGRESS
    // and silently leave every non-watched file unembedded.
    //
    // watchedPaths is a Set on the real SmartFolderWatcher; Array.from also
    // accepts the plain array some fakes hand back. No filtering here — the
    // callee drops non-strings and blank entries more strictly than we would.
    const watchedPrefixes = smartFolderWatcher.watchedPaths
      ? Array.from(smartFolderWatcher.watchedPaths)
      : [];
    startBackfill = () => {
      void (async () => {
        try {
          const backfill = await rebuildFilesImpl(
            {
              safeEnsureInit,
              logger,
              getCustomFolders,
              getServiceIntegration,
              shouldBuildChunkEmbeddings
            },
            { onlyMissing: false, excludePathPrefixes: watchedPrefixes },
            // Its own lock label, so a user who clicks Full rebuild while this
            // runs is told REANALYZE_ALL_BACKFILL is holding the lock rather
            // than a rebuild they never started.
            { lockLabel: 'REANALYZE_ALL_BACKFILL' }
          );
          // handleRebuildFiles reports failure by RETURNING { success: false,
          // errorCode, error } rather than throwing, so a plain info log here
          // would bury a model outage or a missing history service.
          const backfillLog =
            backfill?.success === true ? logger.info.bind(logger) : logger.warn.bind(logger);
          backfillLog('[EMBEDDINGS] Reanalyze-all backfill of non-watched files finished', {
            files: backfill?.files,
            skippedExcluded: backfill?.skippedExcluded,
            skippedMissing: backfill?.skippedMissing,
            success: backfill?.success,
            errorCode: backfill?.errorCode,
            error: backfill?.error
          });
        } catch (backfillErr) {
          logger.warn('[EMBEDDINGS] Reanalyze-all backfill failed:', backfillErr?.message);
        }
      })();
    };

    // Step 8: Start background polling to update UI progress
    const totalToProcess = result.queued;
    if (totalToProcess > 0) {
      const batchId = `reanalyze-all-${Date.now()}`;

      // Clear any existing polling interval to prevent duplicate progress bars
      if (/** @type {any} */ (global).__reanalyzePollInterval) {
        clearInterval(/** @type {any} */ (global).__reanalyzePollInterval);
      }

      /** @type {any} */ (global).__reanalyzePollInterval = setInterval(() => {
        if (!smartFolderWatcher.isRunning) {
          clearInterval(/** @type {any} */ (global).__reanalyzePollInterval);
          /** @type {any} */ (global).__reanalyzePollInterval = null;
          // Send a terminal event so the renderer clears its in-progress state
          // even when the watcher stops unexpectedly mid-run.
          if (typeof getMainWindow === 'function') {
            const win = getMainWindow();
            if (win && !win.isDestroyed()) {
              safeSend(win.webContents, IPC_EVENTS.OPERATION_PROGRESS, {
                type: 'batch_analyze',
                batchId,
                completed: totalToProcess,
                total: totalToProcess,
                percent: 100,
                message: 'Reanalysis stopped.'
              });
            }
          }
          return;
        }

        const status = smartFolderWatcher.getStatus();
        // Include the overflow buffer so progress reflects all files, not just
        // whatever fits in the bounded main queue at this instant.
        const remaining =
          status.queueLength + status.processingCount + (status.pendingReanalyzeCount || 0);
        const completed = Math.max(0, totalToProcess - remaining);

        if (typeof getMainWindow === 'function') {
          const win = getMainWindow();
          if (win && !win.isDestroyed()) {
            safeSend(win.webContents, IPC_EVENTS.OPERATION_PROGRESS, {
              type: 'batch_analyze',
              batchId,
              completed,
              total: totalToProcess,
              percent: Math.round((completed / totalToProcess) * 100),
              message: `Reanalyzing files... ${completed}/${totalToProcess}`
            });
          }
        }

        if (remaining === 0) {
          clearInterval(/** @type {any} */ (global).__reanalyzePollInterval);
          /** @type {any} */ (global).__reanalyzePollInterval = null;
          if (typeof getMainWindow === 'function') {
            const win = getMainWindow();
            if (win && !win.isDestroyed()) {
              safeSend(win.webContents, IPC_EVENTS.OPERATION_PROGRESS, {
                type: 'batch_analyze',
                batchId,
                completed: totalToProcess,
                total: totalToProcess,
                percent: 100,
                message: 'Reanalysis complete.'
              });
            }
          }
        }
      }, 1000);
      // unref so the interval doesn't gate process shutdown if the
      // user quits while a reanalyze poll is in flight. The interval
      // self-terminates when watcher stops or queue drains, but if
      // neither happens by quit time, we don't want to keep the
      // event loop alive waiting for it.
      if (typeof (/** @type {any} */ (global).__reanalyzePollInterval?.unref) === 'function') {
        /** @type {any} */ (global).__reanalyzePollInterval.unref();
      }
    }

    return {
      success: true,
      scanned: result.scanned,
      queued: result.queued,
      model: modelCheck.embeddingModel,
      message: `Queued ${result.queued} files for reanalysis. Analysis will run in the background and embeddings will be rebuilt automatically.`
    };
  } catch (e) {
    logger.error('[EMBEDDINGS] Reanalyze all failed:', e);
    return {
      success: false,
      error: e.message,
      errorCode: 'REANALYZE_ALL_FAILED'
    };
  } finally {
    releaseRebuildLock(lockResult.token);
    if (startBackfill) {
      // Defer so the IPC reply is sent before the backfill's synchronous
      // prefix (lazy requires, history load) runs on the main thread.
      const fire = startBackfill;
      setImmediate(() => fire());
    }
  }
}

/**
 * @param {SemanticHandlerDeps} deps
 * @param {IpcMainInvokeEvent} _event
 * @param {Record<string, any>} [options]
 */
async function handleFullRebuild(
  { safeEnsureInit, logger, getCustomFolders, getServiceIntegration, shouldBuildChunkEmbeddings },
  _event,
  options = {}
) {
  const initErr = await safeEnsureInit();
  if (initErr) return initErr;
  const lockResult = acquireRebuildLock('FULL_REBUILD');
  if (!lockResult.acquired) {
    return {
      success: false,
      error: lockResult.reason,
      errorCode: 'REBUILD_IN_PROGRESS'
    };
  }

  /** @type {{ folders: { success: number, failed: number }, files: { success: number, failed: number }, chunks: { success: number, failed: number }, bm25: boolean, model: string|null, errors: Array<Record<string, any>> }} */
  const results = {
    folders: { success: 0, failed: 0 },
    files: { success: 0, failed: 0 },
    chunks: { success: 0, failed: 0 },
    bm25: false,
    model: null,
    errors: []
  };
  /** @type {{ embeddingModel: string, embeddingContextSize: number | undefined } | null} */
  let embeddingModelOptions = null;
  let previousEmbeddingModel = null;
  let overrideApplied = false;
  let rebuildSucceeded = false;

  try {
    const embeddingService = getParallelEmbeddingService();
    if (!embeddingService) {
      return {
        success: false,
        error: 'ParallelEmbeddingService not available',
        errorCode: 'EMBEDDING_SERVICE_UNAVAILABLE'
      };
    }

    const requestedModelOverride =
      typeof options?.modelOverride === 'string' ? options.modelOverride.trim() : '';
    if (requestedModelOverride) {
      try {
        const llamaSvc = getLlamaService();
        if (!llamaSvc) {
          return {
            success: false,
            error: 'LlamaService not available for model override',
            errorCode: 'MODEL_SWITCH_FAILED'
          };
        }
        const cfg = await llamaSvc.getConfig();
        previousEmbeddingModel = cfg?.embeddingModel || AI_DEFAULTS.EMBEDDING.MODEL;
        if (previousEmbeddingModel !== requestedModelOverride) {
          await llamaSvc.updateConfig({ embeddingModel: requestedModelOverride });
          overrideApplied = true;
        }
      } catch (switchError) {
        return {
          success: false,
          error: `Failed to set embedding model for rebuild: ${switchError.message}`,
          errorCode: 'MODEL_SWITCH_FAILED'
        };
      }
    }

    // Step 1: Verify embedding model is available
    const modelCheck = await verifyEmbeddingModelAvailable(logger, requestedModelOverride || null);
    if (!modelCheck.available) {
      return {
        success: false,
        error: modelCheck.error,
        errorCode: 'MODEL_NOT_AVAILABLE',
        model: modelCheck.model,
        availableModels: modelCheck.availableModels
      };
    }
    results.model = modelCheck.model;

    logger.info('[EMBEDDINGS] Starting full rebuild', { model: modelCheck.model });

    // Wait for LlamaService to finish any in-flight model switch before
    // probing. A settings change (e.g. switching embedding model) triggers
    // unloadAll + config-change gate, leaving the service transiently
    // "unhealthy". Polling avoids a hard failure when the user changes
    // the model and immediately clicks Rebuild.
    const llamaSvc = getLlamaService();
    if (!llamaSvc) {
      return {
        success: false,
        error: 'AI engine is not available. Please wait for startup to complete and try again.',
        errorCode: 'SERVICE_NOT_READY'
      };
    }
    try {
      if (typeof llamaSvc.initialize === 'function') {
        await withTimeout(
          llamaSvc.initialize(),
          TIMEOUTS.SERVICE_STARTUP,
          'AI engine initialization'
        );
      }
    } catch (initError) {
      return {
        success: false,
        error: `AI engine did not become ready: ${initError?.message || String(initError)}`,
        errorCode: 'SERVICE_NOT_READY'
      };
    }

    // Probe the embedding model to verify it can actually generate vectors
    // and record which dimensions will be used for the index.
    // This MUST succeed before we wipe the DB — otherwise the user is left
    // with zero embeddings and a model that can't rebuild.
    try {
      const probe = await embeddingService.embedText('embedding index dimension probe');
      const dims = Array.isArray(probe?.vector) ? probe.vector.length : null;
      if (!Number.isFinite(dims) || dims <= 0) {
        return {
          success: false,
          error:
            'Embedding model returned an invalid vector during probe. Rebuild aborted to protect existing data.',
          errorCode: 'PROBE_INVALID_VECTOR'
        };
      }
      // Two-phase commit: flip `rebuildInProgress: true` BEFORE wiping the
      // store so that a crash between resetAll() and final completion leaves a
      // durable "index torn" signal that startup can act on.
      await markRebuildInProgress({
        model: probe?.model || modelCheck.model,
        dims,
        source: 'full-rebuild'
      });
    } catch (probeError) {
      logger.error(
        '[EMBEDDINGS] Probe embedding failed — aborting rebuild to protect existing data',
        {
          error: probeError?.message
        }
      );
      return {
        success: false,
        error: `Embedding model failed to generate a test vector: ${probeError?.message}. Rebuild aborted to protect existing data.`,
        errorCode: 'PROBE_EMBEDDING_FAILED'
      };
    }

    // Step 2: Clear all vector DB collections
    logger.info('[EMBEDDINGS] Clearing all vector DB collections...');
    await getOramaService().resetAll();

    // Step 3: Rebuild folder embeddings
    logger.info('[EMBEDDINGS] Rebuilding folder embeddings...');
    const smartFolders = (typeof getCustomFolders === 'function' ? getCustomFolders() : []).filter(
      (f) => f && f.name
    );

    if (smartFolders.length > 0) {
      const folderPayloads = await Promise.all(
        smartFolders.map(async (folder) => {
          try {
            const folderText = enrichFolderTextForEmbedding(
              folder.name,
              folder.description,
              folder.keywords
            );
            const { vector, model } = await getFolderMatcher().embedText(folderText);
            const folderId = folder.id || getFolderMatcher().generateFolderId(folder);

            results.folders.success++;
            return {
              id: folderId,
              name: folder.name,
              description: folder.description || '',
              path: folder.path || '',
              vector,
              model,
              updatedAt: new Date().toISOString()
            };
          } catch (error) {
            results.folders.failed++;
            results.errors.push({ type: 'folder', name: folder.name, error: error.message });
            return null;
          }
        })
      );

      const validFolderPayloads = folderPayloads.filter((p) => p !== null);
      if (validFolderPayloads.length > 0) {
        await getOramaService().batchUpsertFolders(validFolderPayloads);
      }
    }

    // Step 4: Rebuild file embeddings from analysis history
    logger.info('[EMBEDDINGS] Rebuilding file embeddings...');
    const serviceIntegration = getServiceIntegration && getServiceIntegration();
    const historyService = serviceIntegration?.analysisHistory;

    if (historyService?.getRecentAnalysis) {
      const MAX_FULL_REBUILD_ENTRIES = 50_000;
      const allEntries = await historyService.getRecentAnalysis(MAX_FULL_REBUILD_ENTRIES);
      const shouldRebuildChunks = await shouldBuildChunkEmbeddings();

      if (Array.isArray(allEntries) && allEntries.length > 0) {
        const filePayloads = [];
        const chunkPayloads = [];
        const processedFileIds = new Set();

        for (const entry of allEntries) {
          // Keep the rebuild lock's inactivity heartbeat alive — each entry
          // can take seconds of CPU embedding, and a silent lock steal would
          // let a second rebuild interleave with this one.
          touchRebuildLock(lockResult.token);
          try {
            const analysis = entry.analysis || {};
            const organization = entry.organization || {};

            // Use current path after organization if available
            const filePath = organization.actual || entry.originalPath;
            if (!filePath || typeof filePath !== 'string') {
              results.files.failed++;
              // Log per-file failures so the 187/249 success summary in the
              // rebuild-complete line is auditable (previously only the 5
              // truncated entries in results.errors were ever surfaced).
              logger.warn('[EMBEDDINGS] File failed during full rebuild', {
                path: entry.originalPath || null,
                reason: 'Invalid file path in analysis history',
                code: 'INVALID_PATH'
              });
              results.errors.push({
                type: 'file',
                file: entry.originalPath ? path.basename(entry.originalPath) : 'unknown',
                error: 'Invalid file path in analysis history'
              });
              continue;
            }

            try {
              await fs.access(filePath);
            } catch (accessError) {
              results.files.failed++;
              // ENOENT after organize/move is expected (file deleted/moved
              // during rebuild) — log at debug to avoid spamming warn for
              // mass-cleanup scenarios. Other access errors (EACCES, EIO)
              // are real and warn-worthy.
              const isEnoent = accessError.code === 'ENOENT';
              // .bind(logger) is load-bearing: a bare `logFn(...)` call detaches
              // the method from its receiver, so `this` is undefined inside
              // debug/warn and `this._safeWrite(...)` throws
              // "Cannot read properties of undefined (reading '_safeWrite')".
              // That throw escaped this catch into the outer per-file catch,
              // which double-counted the failure and masked the real reason.
              const logFn = (isEnoent ? logger.debug : logger.warn).bind(logger);
              logFn('[EMBEDDINGS] File failed during full rebuild', {
                path: filePath,
                reason: isEnoent ? 'File no longer exists' : accessError.message,
                code: accessError.code || 'ACCESS_ERROR'
              });
              results.errors.push({
                type: 'file',
                file: path.basename(filePath),
                error: isEnoent
                  ? 'File no longer exists'
                  : `File access error: ${accessError.message}`
              });
              continue;
            }

            const displayName = organization.newName || entry.fileName || path.basename(filePath);
            const ext = (path.extname(filePath) || '').toLowerCase();
            const isImage = SUPPORTED_IMAGE_EXTENSIONS.includes(ext);
            const fileId = getFileEmbeddingId(filePath, isImage ? 'image' : 'file');

            // Skip duplicate file IDs (history may contain multiple entries per file)
            if (processedFileIds.has(fileId)) {
              continue;
            }
            processedFileIds.add(fileId);

            // D7 / K-16: fallback analyses are provisional, not embedded.
            if (analysis.provisional === true || isFallbackAnalysis(analysis)) {
              continue;
            }

            // The same builder and model budget as every live route (CP-14).
            // This runs after an embedding-model change resets the index, and
            // its old ad-hoc join (name, subject, summary, tags, category, no
            // extracted text, purpose, entity or date) rebuilt the whole
            // library from thinner text than the vectors it replaced.
            if (!embeddingModelOptions) {
              embeddingModelOptions = await resolveEmbeddingModelOptions();
            }
            const embeddingText = buildEmbeddingSummary(
              analysis,
              analysis.extractedText ? String(analysis.extractedText) : '',
              ext,
              isImage ? 'image' : 'document',
              embeddingModelOptions
            ).text.trim();
            if (!embeddingText) continue;

            const { vector, model } = await embeddingService.embedText(embeddingText);
            if (!Array.isArray(vector) || vector.length === 0) continue;

            results.files.success++;
            filePayloads.push({
              id: fileId,
              vector,
              model,
              meta: {
                path: filePath,
                fileName: displayName,
                suggestedName: organization.newName || '',
                fileType: isImage ? 'image' : 'document',
                category: analysis.category || '',
                subject: analysis.subject || '',
                tags: Array.isArray(analysis.tags) ? analysis.tags : []
              },
              document: embeddingText.slice(0, 500),
              updatedAt: new Date().toISOString()
            });

            // Also process chunks from extracted text
            const extractedText = analysis.extractedText || '';
            if (shouldRebuildChunks && extractedText.length >= CHUNKING.MIN_TEXT_LENGTH) {
              const chunks = chunkText(extractedText, {
                chunkSize: CHUNKING.CHUNK_SIZE,
                overlap: CHUNKING.OVERLAP,
                maxChunks: CHUNKING.MAX_CHUNKS
              });

              for (const chunk of chunks) {
                touchRebuildLock(lockResult.token);
                try {
                  const { vector: chunkVector, model: chunkModel } =
                    await embeddingService.embedText(chunk.text);
                  if (!Array.isArray(chunkVector) || chunkVector.length === 0) continue;

                  results.chunks.success++;
                  const snippet = chunk.text.slice(0, 240);
                  chunkPayloads.push({
                    id: `chunk:${fileId}:${chunk.index}`,
                    vector: chunkVector,
                    model: chunkModel,
                    meta: {
                      fileId,
                      path: filePath,
                      name: displayName,
                      chunkIndex: chunk.index,
                      startOffset: chunk.charStart,
                      endOffset: chunk.charEnd,
                      text: chunk.text,
                      content: chunk.text,
                      charStart: chunk.charStart,
                      charEnd: chunk.charEnd,
                      snippet,
                      model: chunkModel || 'unknown'
                    },
                    document: snippet,
                    updatedAt: new Date().toISOString()
                  });
                } catch {
                  results.chunks.failed++;
                }
              }
            }
          } catch (e) {
            results.files.failed++;
            // Generic rebuild-loop exception — includes embedding-generation
            // failures, vector-DB upsert errors, etc. Always warn-level since
            // these are unexpected and worth investigating.
            logger.warn('[EMBEDDINGS] File failed during full rebuild', {
              path: entry.originalPath || null,
              name: entry.fileName || null,
              reason: e?.message,
              code: e?.code || 'REBUILD_ERROR'
            });
            results.errors.push({
              type: 'file',
              name: entry.fileName || 'unknown',
              error: e.message
            });
          }
        }

        // Batch upsert files
        const BATCH_SIZE = BATCH.SEMANTIC_BATCH_SIZE;
        for (let i = 0; i < filePayloads.length; i += BATCH_SIZE) {
          touchRebuildLock(lockResult.token);
          const batch = filePayloads.slice(i, i + BATCH_SIZE);
          try {
            await getOramaService().batchUpsertFiles(batch);
          } catch (e) {
            logger.warn('[EMBEDDINGS] Failed to batch upsert files:', e.message);
          }
        }

        // Batch upsert chunks
        for (let i = 0; i < chunkPayloads.length; i += BATCH_SIZE) {
          touchRebuildLock(lockResult.token);
          const batch = chunkPayloads.slice(i, i + BATCH_SIZE);
          try {
            await getOramaService().batchUpsertFileChunks(batch);
          } catch (e) {
            logger.warn('[EMBEDDINGS] Failed to batch upsert chunks:', e.message);
          }
        }
      }
    }

    // Step 5: Rebuild BM25 index
    logger.info('[EMBEDDINGS] Rebuilding BM25 search index...');
    try {
      const searchService = await getSearchService();
      if (searchService) {
        await searchService.buildBM25Index();
        results.bm25 = true;
      }
    } catch (e) {
      results.errors.push({ type: 'bm25', error: e.message });
    }

    logger.info('[EMBEDDINGS] Full rebuild complete', {
      folders: results.folders,
      files: results.files,
      chunks: results.chunks,
      bm25: results.bm25
    });

    // Clear the rebuildInProgress marker only after everything else succeeded.
    // If we crashed before this line, startup will see the flag still set and
    // prompt the user to rebuild rather than trusting the torn index.
    try {
      await clearRebuildInProgress();
    } catch (metaError) {
      logger.warn('[EMBEDDINGS] Failed to clear rebuildInProgress flag', {
        error: metaError?.message
      });
    }

    rebuildSucceeded = true;

    // The index is rebuilt with the active model — the model-change banner
    // (raised by OramaVectorService.handleEmbeddingModelChange) is now stale.
    try {
      require('../services/DegradedStateTracker')
        .getInstance()
        .clear('embeddings.model-change-reset');
    } catch {
      // tracker unavailable — banner clears on next model-change cycle
    }

    return {
      success: true,
      folders: results.folders.success,
      files: results.files.success,
      chunks: results.chunks.success,
      bm25Rebuilt: results.bm25,
      model: results.model,
      // Raised 5→50 so operators reviewing the IPC response (or the renderer
      // surfacing failed-file details) get enough signal to debug high
      // failure rates. Each entry is small ({type, file/name, error}), so
      // 50 stays well under IPC payload limits. Per-file logger.warn lines
      // above are the source of truth for the full failure list.
      errors: results.errors.slice(0, 50),
      message: `Full rebuild complete: ${results.folders.success} folders, ${results.files.success} files, ${results.chunks.success} chunks`
    };
  } catch (e) {
    logger.error('[EMBEDDINGS] Full rebuild failed:', e);
    return {
      success: false,
      error: e.message,
      errorCode: 'FULL_REBUILD_FAILED',
      partialResults: results
    };
  } finally {
    if (overrideApplied && previousEmbeddingModel && !rebuildSucceeded) {
      try {
        const llamaRollback = getLlamaService();
        if (llamaRollback) {
          await llamaRollback.updateConfig({ embeddingModel: previousEmbeddingModel });
        }
      } catch (rollbackError) {
        logger.error(
          '[EMBEDDINGS] Failed to rollback embedding model after rebuild failure:',
          rollbackError?.message
        );
      }
    }
    releaseRebuildLock(lockResult.token);
  }
}

/**
 * Rebuild file embeddings from analysis history.
 *
 * D5 (monotonic store): this NEVER clears a collection up front. Every file is
 * upserted over its live row, so a crash, a model outage, or a partial run can
 * only leave the store as good as it was — never empty.
 *
 * `onlyMissing` is NOT a remedy for an embedding-model change: the files schema
 * carries no per-row model, so a row embedded with the old model still counts
 * as having a usable vector and would be skipped. Use FULL_REBUILD for that.
 *
 * @param {SemanticHandlerDeps} deps
 * @param {{ onlyMissing?: boolean, excludePathPrefixes?: string[] }} [options]
 *   `onlyMissing` backfills only files that have no usable vector (Q4);
 *   `excludePathPrefixes` leaves paths under those folders to the watcher.
 *   This is the IPC-visible payload (see `rebuildFilesOptions` in
 *   validationSchemas) — never put a main-process-only knob here.
 * @param {{ lockLabel?: string }} [internalOptions] Main-process-only knobs,
 *   deliberately a separate parameter so the IPC registration (which forwards
 *   only `options`) cannot reach them. `lockLabel` names this run in the
 *   "another rebuild is in progress" message a competing operation sees.
 */
async function handleRebuildFiles(
  { safeEnsureInit, logger, getCustomFolders, getServiceIntegration, shouldBuildChunkEmbeddings },
  options = {},
  internalOptions = {}
) {
  const onlyMissing = options.onlyMissing === true;
  const excludePrefixes = Array.isArray(options.excludePathPrefixes)
    ? options.excludePathPrefixes.filter((p) => typeof p === 'string' && p.trim().length > 0)
    : [];

  // Containment is delegated to isPathWithinFolder(), which normalizes through
  // normalizePathForIndex (NFC + per-platform casing + forward slashes) and
  // only then appends the boundary '/'. That is what makes it correct for
  // root-ish bases the naive "normalize, then require a separator remainder"
  // check rejects: a UNC share root (\\srv\share), a drive root (C:\), and
  // posix '/'. It still refuses a sibling that merely shares leading
  // characters ("C:\Docs\Art" vs "C:\Docs\Articles\x.txt"), and it needs no
  // trailing-separator pre-strip from us.
  //
  // Required lazily: there is no require cycle back to this module, but
  // OrganizationSuggestionServiceCore drags in FolderMatchingService,
  // ParallelEmbeddingService and the whole suggestion-strategy tree, which has
  // no business loading with the IPC layer at startup for one path predicate.
  /** @type {(filePath: string) => boolean} */
  let isExcludedPath = () => false;
  if (excludePrefixes.length > 0) {
    const {
      isPathWithinFolder
    } = require('../services/organization/OrganizationSuggestionServiceCore');
    isExcludedPath = (filePath) => excludePrefixes.some((p) => isPathWithinFolder(filePath, p));
  }
  const initErr = await safeEnsureInit();
  if (initErr) return initErr;
  const lockResult = acquireRebuildLock(
    typeof internalOptions.lockLabel === 'string' && internalOptions.lockLabel
      ? internalOptions.lockLabel
      : 'REBUILD_FILES'
  );
  if (!lockResult.acquired) {
    return {
      success: false,
      error: lockResult.reason,
      errorCode: 'REBUILD_IN_PROGRESS'
    };
  }

  try {
    const modelCheck = await verifyEmbeddingModelAvailable(logger);
    if (!modelCheck.available) {
      return {
        success: false,
        error: modelCheck.error,
        errorCode: 'MODEL_NOT_AVAILABLE',
        model: modelCheck.model,
        availableModels: modelCheck.availableModels
      };
    }

    const serviceIntegration = getServiceIntegration && getServiceIntegration();
    const historyService = serviceIntegration?.analysisHistory;

    if (!historyService?.getRecentAnalysis) {
      return {
        success: false,
        error: 'Analysis history service unavailable',
        errorCode: 'HISTORY_SERVICE_UNAVAILABLE'
      };
    }

    const MAX_REBUILD_ENTRIES = 50_000;
    const allEntries = await historyService.getRecentAnalysis(MAX_REBUILD_ENTRIES);

    if (!Array.isArray(allEntries)) {
      logger.warn('[EMBEDDINGS] getRecentAnalysis returned non-array:', typeof allEntries);
      return {
        success: false,
        error: 'Failed to load analysis history - invalid data format',
        errorCode: 'INVALID_HISTORY_FORMAT'
      };
    }

    if (allEntries.length === 0) {
      return {
        success: true,
        files: 0,
        message: 'No analysis history to embed. Analyze some files first.'
      };
    }

    // De-dupe analysis history to unique file IDs.
    // History can contain multiple entries per file (reanalysis, retries), which previously caused
    // misleading "file counts" in UI.
    const uniqueHistoryFileIds = new Set();

    const smartFolders = (typeof getCustomFolders === 'function' ? getCustomFolders() : []).filter(
      (f) => f && f.name
    );

    // Track results for folders
    const folderResults = { success: 0, failed: 0 };

    // Process folder embeddings (silently continue on failure)
    if (smartFolders.length > 0) {
      const folderPayloads = await Promise.all(
        smartFolders.map(async (folder) => {
          try {
            const folderText = enrichFolderTextForEmbedding(
              folder.name,
              folder.description,
              folder.keywords
            );

            const { vector, model } = await getFolderMatcher().embedText(folderText);
            const folderId = folder.id || getFolderMatcher().generateFolderId(folder);

            folderResults.success++;
            return {
              id: folderId,
              name: folder.name,
              description: folder.description || '',
              path: folder.path || '',
              vector,
              model,
              updatedAt: new Date().toISOString()
            };
          } catch {
            folderResults.failed++;
            logger.warn('[EMBEDDINGS] Failed to generate folder embedding:', folder.name);
            return null;
          }
        })
      );

      const validFolderPayloads = folderPayloads.filter((p) => p !== null);
      if (validFolderPayloads.length > 0) {
        await getOramaService().batchUpsertFolders(validFolderPayloads);
      }
    }

    // D5: no resetFiles()/resetFileChunks() here. Clearing the collections
    // before the replacement vectors exist made every interrupted rebuild
    // (crash, model outage, user quit) destroy the knowledge store. Each file
    // is upserted over its own row instead, and chunk rows are replaced
    // per-file just before that file's chunks are re-embedded.
    const shouldRebuildChunks = await shouldBuildChunkEmbeddings();

    // Track results for files.
    // M1: the `*Rows` counters count HISTORY ROWS (several rows can name the
    // same file), and only exist so `attempted` below stays row-denominated.
    // Everything the user sees is counted in the fileId Sets underneath them.
    /** @type {{ prepared: number, persisted: number, failed: number, persistFailed: number, skippedExistingRows: number, skippedExcludedRows: number, skippedMissingRows: number, skippedProvisionalRows: number, errors: Array<Record<string, any>>, chunkFailures: number, chunkDeleteFailures: number, chunkFailureSamples: Array<Record<string, any>> }} */
    const fileResults = {
      prepared: 0,
      persisted: 0,
      failed: 0,
      persistFailed: 0,
      skippedExistingRows: 0,
      skippedExcludedRows: 0,
      skippedProvisionalRows: 0,
      skippedMissingRows: 0,
      errors: [],
      chunkFailures: 0,
      chunkDeleteFailures: 0,
      chunkFailureSamples: []
    };
    /** Unique files skipped because they already hold a usable vector. */
    const skippedExistingFileIds = new Set();
    /** Unique files skipped because they live under an excluded prefix. */
    const skippedExcludedFileIds = new Set();
    const skippedProvisionalFileIds = new Set();
    /** Unique files skipped because they are gone from disk (R2). */
    const skippedMissingFileIds = new Set();
    /**
     * fileId -> filePath for missing-on-disk files, so the history row can be
     * marked 'skipped' after the loop. Without this, getQuickStats() keeps
     * counting them in embedding.eligibleFiles forever (statistics.js
     * isSkipped only excludes status 'skipped' or policy 'skip'/'web_only'),
     * so a real library with any deleted files could never reach 100%
     * coverage no matter how complete a rebuild is (D6 follow-up).
     */
    const skippedMissingPathsByFileId = new Map();

    // Process file embeddings with proper error tracking.
    //
    // C1/I3: nothing is accumulated for the whole run. Prepared work is flushed
    // to the store every BATCH_SIZE files, and within a flush each file's OLD
    // chunk rows are deleted immediately before that same file's new chunks are
    // written. A delete is therefore never more than one upsert away from its
    // replacement: a crash can cost at most the chunks of the single file whose
    // delete had run and whose upsert had not yet completed — not a batch, and
    // certainly not every file processed so far in a 50k-entry run. It also
    // keeps peak memory proportional to one batch instead of the whole history.
    const BATCH_SIZE = BATCH.SEMANTIC_BATCH_SIZE;
    /** File ids already prepared this run — the dedupe record. */
    const preparedFileIds = new Set();
    /** @type {Array<Record<string, any>>} File payloads awaiting upsert. */
    let pendingFilePayloads = [];
    /** @type {Map<string, Array<Record<string, any>>>} fileId -> its new chunk payloads. */
    let pendingChunkGroups = new Map();
    const embeddingService = getParallelEmbeddingService();
    const embeddingModelOptions = await resolveEmbeddingModelOptions();

    let rebuilt = 0;
    let chunkRebuilt = 0;
    // Model/dims of the first payload PREPARED, for the index metadata record.
    // Only read on a complete pass (zero failures), where prepared == persisted.
    /** @type {{ model: string, dims: number }|null} */
    let indexProbe = null;

    const flushPending = async () => {
      if (pendingFilePayloads.length === 0 && pendingChunkGroups.size === 0) return;
      touchRebuildLock(lockResult.token);

      const batch = pendingFilePayloads;
      pendingFilePayloads = [];
      if (batch.length > 0) {
        try {
          const result = await getOramaService().batchUpsertFiles(batch);
          const persistedCount = Number(result?.count ?? result ?? 0);
          const safePersistedCount =
            Number.isFinite(persistedCount) && persistedCount > 0 ? persistedCount : 0;
          rebuilt += safePersistedCount;
          if (safePersistedCount < batch.length) {
            fileResults.persistFailed += batch.length - safePersistedCount;
            logger.warn('[EMBEDDINGS] Batch upsert persisted fewer files than prepared payloads', {
              prepared: batch.length,
              persisted: safePersistedCount
            });
          }
        } catch (e) {
          fileResults.persistFailed += batch.length;
          logger.warn('[EMBEDDINGS] Failed to batch upsert files:', e.message);
        }
      }

      const groups = pendingChunkGroups;
      pendingChunkGroups = new Map();
      for (const [groupFileId, payloads] of groups) {
        // D5: this file's old chunk rows go only now, with their replacements
        // already in hand. An empty group is still deleted — that is a file
        // whose extracted text shrank below the chunking threshold, and its
        // stale chunks must not outlive it.
        try {
          await getOramaService().deleteFileChunks(groupFileId);
        } catch (chunkDeleteErr) {
          fileResults.chunkDeleteFailures++;
          logger.warn('[EMBEDDINGS] Could not clear old chunks before rebuild:', {
            fileId: groupFileId,
            error: chunkDeleteErr?.message
          });
        }
        if (payloads.length === 0) continue;
        try {
          chunkRebuilt += await getOramaService().batchUpsertFileChunks(payloads);
        } catch (e) {
          logger.warn('[EMBEDDINGS] Failed to batch upsert file chunks:', e.message);
        }
      }

      await new Promise((resolve) => setImmediate(resolve));
    };

    const YIELD_EVERY_N = 50;
    let processedCount = 0;

    for (const entry of allEntries) {
      // Heartbeat the rebuild lock so stale-lock recovery never displaces
      // this live holder mid-rebuild (see acquireRebuildLock).
      touchRebuildLock(lockResult.token);
      processedCount++;
      if (processedCount % YIELD_EVERY_N === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      try {
        const organization = entry.organization || {};
        const filePath = organization.actual || entry.originalPath;
        if (!filePath || typeof filePath !== 'string') {
          fileResults.failed++;
          fileResults.errors.push({
            file: entry.originalPath ? path.basename(entry.originalPath) : 'unknown',
            error: 'Invalid file path in analysis history'
          });
          continue;
        }

        const ext = (path.extname(filePath) || '').toLowerCase();
        const isImage = SUPPORTED_IMAGE_EXTENSIONS.includes(ext);
        const fileId = getFileEmbeddingId(filePath, isImage ? 'image' : 'file');

        // Track unique file IDs in history even if we later skip embedding due to empty content.
        uniqueHistoryFileIds.add(fileId);

        // Skip duplicates (keep the most recent history entry; getRecentAnalysis is expected to be
        // ordered). This runs BEFORE the exclude/onlyMissing checks so repeat history rows for a
        // file already prepared in this run neither inflate the skip counters nor re-hit the store.
        // Rows for a file that was itself skipped still count once each in the `*Rows` counters:
        // `attempted` below subtracts them from allEntries.length, so the two stay in the same
        // unit. The user-facing counts come from the fileId Sets instead.
        if (preparedFileIds.has(fileId)) {
          continue;
        }

        if (isExcludedPath(filePath)) {
          fileResults.skippedExcludedRows++;
          skippedExcludedFileIds.add(fileId);
          continue;
        }
        // D7 / K-16: a fallback analysis is provisional, not embedded. Its
        // real re-analysis (watcher retry once the model exists) is.
        if (entry.analysis?.provisional === true || isFallbackAnalysis(entry.analysis)) {
          fileResults.skippedProvisionalRows++;
          skippedProvisionalFileIds.add(fileId);
          continue;
        }
        if (onlyMissing) {
          // I4b: ask the store's own usability rule (live row + a real,
          // non-placeholder embedding), not the raw getFile() fields — a row
          // can read `hasVector: true` and still be unsearchable. Memoized per
          // file id so duplicate history rows cost at most one lookup.
          const alreadyUsable =
            skippedExistingFileIds.has(fileId) || (await getOramaService().hasUsableVector(fileId));
          // A usable file vector whose passages were never built still counts
          // as missing when chunk rebuild applies: Discover-analyzed files had
          // no chunk leg before chunking was wired into that path, and the
          // Rebuild button is the only way existing installs backfill them.
          const passagesMissing =
            alreadyUsable &&
            shouldRebuildChunks &&
            !isImage &&
            String(entry.analysis?.extractedText ?? '').trim().length >= CHUNKING.MIN_TEXT_LENGTH &&
            !(await getOramaService().hasFileChunks(fileId));
          if (alreadyUsable && !passagesMissing) {
            fileResults.skippedExistingRows++;
            skippedExistingFileIds.add(fileId);
            continue;
          }
        }

        try {
          await fs.access(filePath);
        } catch (accessError) {
          if (accessError.code === 'ENOENT') {
            // R2: a history row whose file is gone from disk is unembeddable by
            // definition — no run can ever fix it. Counting it as a failure
            // would hold the index model stamp hostage forever (every rebuild
            // would look "partial"), so it is a skip, not a failure. Any OTHER
            // access error (permissions, I/O, a locked file) IS a failure: it
            // is transient and a later run may well succeed.
            fileResults.skippedMissingRows++;
            skippedMissingFileIds.add(fileId);
            skippedMissingPathsByFileId.set(fileId, filePath);
            continue;
          }
          fileResults.failed++;
          fileResults.errors.push({
            file: path.basename(filePath),
            error: `File access error: ${accessError.message}`
          });
          continue;
        }

        // CP-14: use the same builder the analysis pipeline embeds with, so a
        // rebuilt vector lands in the same place in the space as the original.
        // The old ad-hoc 4-field join dropped purpose/project/entity/keywords
        // and capped extracted text at a fixed 2000 chars.
        const summary = buildEmbeddingSummary(
          entry.analysis || {},
          entry.analysis?.extractedText ? String(entry.analysis.extractedText) : '',
          ext,
          isImage ? 'image' : 'document',
          embeddingModelOptions
        ).text;

        // Skip empty summaries
        if (!summary.trim()) {
          fileResults.failed++;
          fileResults.errors.push({
            file: path.basename(filePath),
            error: 'No content to embed'
          });
          continue;
        }

        // Generate embedding
        const { vector, model } = await getFolderMatcher().embedText(summary);

        // Use renamed name if available, otherwise fall back to original basename
        const displayName = entry.organization?.newName || path.basename(filePath);

        // Extract rich metadata for graph visualization
        const tags = Array.isArray(entry.analysis?.tags) ? entry.analysis.tags : [];
        const category = entry.analysis?.category || '';
        const subject = entry.analysis?.subject || '';
        const summaryText = (entry.analysis?.summary || '').slice(0, 200);

        pendingFilePayloads.push({
          id: fileId,
          vector,
          model,
          meta: {
            path: filePath,
            fileName: displayName,
            suggestedName: entry.organization?.newName || '',
            fileType: isImage ? 'image' : 'document',
            // Rich metadata for meaningful graph visualization
            tags: Array.isArray(tags) ? tags : [], // Orama expects string[] (not JSON string)
            category,
            subject,
            summary: summaryText
          },
          updatedAt: new Date().toISOString()
        });
        preparedFileIds.add(fileId);
        fileResults.prepared++;
        if (!indexProbe && Array.isArray(vector) && vector.length > 0) {
          indexProbe = { model, dims: vector.length };
        }

        // Chunk embeddings (analyzed-only): embed extracted text for deep semantic recall.
        // This is intentionally behind the \"Rebuild\" flow so users can opt in.
        const extractedText =
          entry.analysis?.extractedText != null ? String(entry.analysis.extractedText) : '';
        if (shouldRebuildChunks) {
          // D5/C1: register this file's chunk work; the flush deletes its old
          // rows and writes the new ones together. The group is registered even
          // when it ends up EMPTY — that is a file whose extracted text shrank
          // below the chunking threshold, and its stale chunks (which the old
          // global resetFileChunks() swept) must not outlive it. When chunk
          // rebuild is OFF nothing is registered and nothing is touched: the
          // stored chunks stay the best data we have.
          /** @type {Array<Record<string, any>>} */
          const fileChunkPayloads = [];
          pendingChunkGroups.set(fileId, fileChunkPayloads);

          if (extractedText.trim().length >= CHUNKING.MIN_TEXT_LENGTH) {
            const chunks = chunkText(extractedText, {
              chunkSize: CHUNKING.CHUNK_SIZE,
              overlap: CHUNKING.OVERLAP,
              maxChunks: CHUNKING.MAX_CHUNKS
            });

            for (const c of chunks) {
              try {
                const { vector: chunkVector, model: chunkModel } = await embeddingService.embedText(
                  c.text
                );
                if (!Array.isArray(chunkVector) || chunkVector.length === 0) continue;

                const snippet = c.text.slice(0, 240);
                fileChunkPayloads.push({
                  id: `chunk:${fileId}:${c.index}`,
                  vector: chunkVector,
                  model: chunkModel,
                  meta: {
                    fileId,
                    path: filePath,
                    name: displayName,
                    chunkIndex: c.index,
                    startOffset: c.charStart,
                    endOffset: c.charEnd,
                    text: c.text,
                    content: c.text,
                    charStart: c.charStart,
                    charEnd: c.charEnd,
                    snippet,
                    model: chunkModel || 'unknown'
                  },
                  document: snippet,
                  updatedAt: new Date().toISOString()
                });
              } catch (chunkErr) {
                fileResults.chunkFailures++;
                if (fileResults.chunkFailureSamples.length < 5) {
                  fileResults.chunkFailureSamples.push({
                    file: path.basename(filePath),
                    chunkIndex: c.index,
                    error: chunkErr?.message || String(chunkErr)
                  });
                }
                // Non-fatal: still keep file-level embedding even if a chunk fails
                logger.debug('[EMBEDDINGS] Failed to embed chunk:', {
                  file: path.basename(filePath),
                  chunkIndex: c.index,
                  error: chunkErr?.message
                });
              }
            }
          }
        }
      } catch (e) {
        fileResults.failed++;
        const fileName = entry.originalPath ? path.basename(entry.originalPath) : 'unknown';
        fileResults.errors.push({
          file: fileName,
          error: e.message
        });
        logger.warn('[EMBEDDINGS] Failed to prepare file entry:', e.message);
        // continue on individual entry failure
      }

      if (pendingFilePayloads.length >= BATCH_SIZE) {
        await flushPending();
      }
    }

    // Persist whatever the last partial batch prepared.
    await flushPending();
    fileResults.persisted = rebuilt;

    // Return detailed status
    const totalFileFailures = fileResults.failed + fileResults.persistFailed;
    // Rows, for the attempted math (same unit as allEntries.length)...
    const totalSkippedRows =
      fileResults.skippedExistingRows +
      fileResults.skippedExcludedRows +
      fileResults.skippedMissingRows +
      fileResults.skippedProvisionalRows;
    // ...and unique files, for anything a human reads (M1).
    const skippedExisting = skippedExistingFileIds.size;
    const skippedExcluded = skippedExcludedFileIds.size;
    const skippedMissing = skippedMissingFileIds.size;
    const skippedProvisional = skippedProvisionalFileIds.size;
    const totalSkippedFiles =
      skippedExisting + skippedExcluded + skippedMissing + skippedProvisional;
    // A deliberately skipped file is not a failure: an `onlyMissing` backfill
    // with nothing left to backfill must report success, not "all failed".
    const attempted = allEntries.length - totalSkippedRows;
    const allFailed = rebuilt === 0 && attempted > 0;
    const skipSuffix = totalSkippedFiles > 0 ? ` (${totalSkippedFiles} skipped)` : '';

    // D6 follow-up: persist the missing-on-disk skip so getQuickStats() stops
    // counting these files as eligible. Best-effort — a write failure here
    // must not fail the rebuild itself, so each mark is Promise.allSettled'd
    // in small batches and only logged on failure.
    let missingMarkedSkipped = 0;
    if (
      skippedMissingPathsByFileId.size > 0 &&
      typeof historyService.updateEmbeddingStateByPath === 'function'
    ) {
      const missingPaths = Array.from(skippedMissingPathsByFileId.values());
      const MARK_SKIPPED_BATCH_SIZE = 50;
      for (let i = 0; i < missingPaths.length; i += MARK_SKIPPED_BATCH_SIZE) {
        const batch = missingPaths.slice(i, i + MARK_SKIPPED_BATCH_SIZE);
        const outcomes = await Promise.allSettled(
          batch.map((missingPath) =>
            historyService.updateEmbeddingStateByPath(missingPath, { status: 'skipped' })
          )
        );
        for (const outcome of outcomes) {
          if (outcome.status === 'fulfilled') {
            // Count rows actually written, not calls that merely resolved:
            // updateEmbeddingStateByPath resolves { updated: 0, notFound: 1 } on a miss.
            missingMarkedSkipped += Number(outcome.value?.updated) || 0;
          } else {
            logger.warn('[EMBEDDINGS] Failed to mark missing-on-disk file as skipped:', {
              error: outcome.reason?.message || String(outcome.reason)
            });
          }
        }
      }
    }

    // Record which model/dimensions were used for the index (for UI mismatch warnings)
    // I2: MERGE, never replace. A full rebuild that crashed leaves
    // `rebuildInProgress: true` on disk, and a full write here would silently
    // clear that torn-index marker the startup check depends on.
    //
    // Only a COMPLETE pass may claim the index's model/dims: after a partial
    // run (onlyMissing, excluded prefixes, any skip or failure) some rows are
    // still embedded with whatever model wrote them, so stamping this run's
    // model would hide a real mismatch from the readers in handleGetStats and
    // OrganizationSuggestionServiceCore. A partial run only touches `source`
    // (no reader consumes it) and the `updatedAt` the merge helper stamps.
    // Files that are gone from disk deliberately do NOT count against this:
    // no run will ever embed them, so letting them block the stamp would mean
    // the index model is never recorded again after the first deletion.
    const wasCompletePass =
      !onlyMissing &&
      excludePrefixes.length === 0 &&
      fileResults.skippedExistingRows === 0 &&
      fileResults.skippedExcludedRows === 0 &&
      totalFileFailures === 0;
    try {
      if (wasCompletePass && Number.isFinite(indexProbe?.dims) && indexProbe.dims > 0) {
        await updateEmbeddingIndexMetadata({
          model: indexProbe.model || modelCheck.model,
          dims: indexProbe.dims,
          source: 'rebuild-files'
        });
      } else if (rebuilt > 0) {
        await updateEmbeddingIndexMetadata({ source: 'rebuild-files-partial' });
      }
    } catch {
      // Non-fatal
    }

    return {
      success: !allFailed,
      files: rebuilt,
      fileChunks: chunkRebuilt,
      total: allEntries.length,
      totalUniqueFiles: uniqueHistoryFileIds.size,
      uniquePrepared: preparedFileIds.size,
      succeeded: rebuilt,
      failed: totalFileFailures,
      prepared: fileResults.prepared,
      persistFailed: fileResults.persistFailed,
      // Unique files, not history rows (M1).
      skippedExisting,
      skippedExcluded,
      skippedMissing,
      skippedProvisional,
      missingMarkedSkipped,
      onlyMissing,
      // Whether this run was complete enough to claim the index's model/dims.
      indexModelStamped: wasCompletePass,
      errors: fileResults.errors.slice(0, 5), // Limit error details
      chunkFailures: fileResults.chunkFailures,
      chunkDeleteFailures: fileResults.chunkDeleteFailures,
      chunkFailureSamples: fileResults.chunkFailureSamples.slice(0, 3),
      folders: {
        succeeded: folderResults.success,
        failed: folderResults.failed
      },
      model: modelCheck.model,
      message: allFailed
        ? `All ${totalFileFailures} file embeddings failed. Check AI engine status.`
        : totalFileFailures > 0
          ? `${rebuilt} files embedded, ${totalFileFailures} failed${skipSuffix}`
          : `Successfully embedded ${rebuilt} files${skipSuffix}`
    };
  } catch (e) {
    logger.error('[EMBEDDINGS] Rebuild files failed:', e);
    return {
      success: false,
      error: e.message,
      errorCode: e.code || 'REBUILD_FAILED'
    };
  } finally {
    releaseRebuildLock(lockResult.token);
  }
}

/**
 * The rebuild implementation reanalyze-all backfills through. Indirected so a
 * test can observe the call without driving a whole embedding run.
 * @type {typeof handleRebuildFiles}
 */
let rebuildFilesImpl = handleRebuildFiles;

/**
 * Test seam: swap the rebuild implementation used by reanalyze-all.
 * @param {typeof handleRebuildFiles | null} fn
 */
function __setRebuildFilesForTest(fn) {
  rebuildFilesImpl = fn || handleRebuildFiles;
}

/** @param {SemanticHandlerDeps} deps */
async function handleRebuildFolders({ safeEnsureInit, logger, getCustomFolders }) {
  const initErr = await safeEnsureInit();
  if (initErr) return initErr;
  const lockResult = acquireRebuildLock('REBUILD_FOLDERS');
  if (!lockResult.acquired) {
    return {
      success: false,
      error: lockResult.reason,
      errorCode: 'REBUILD_IN_PROGRESS'
    };
  }

  try {
    const modelCheck = await verifyEmbeddingModelAvailable(logger);
    if (!modelCheck.available) {
      return {
        success: false,
        error: modelCheck.error,
        errorCode: 'MODEL_NOT_AVAILABLE',
        model: modelCheck.model,
        availableModels: modelCheck.availableModels
      };
    }

    const smartFolders = getCustomFolders().filter((f) => f && f.name);

    if (smartFolders.length === 0) {
      return {
        success: true,
        folders: 0,
        message: 'No smart folders to embed'
      };
    }

    // Track successes and failures
    /** @type {{ success: number, failed: number, errors: Array<Record<string, any>> }} */
    const results = { success: 0, failed: 0, errors: [] };

    // Process folder embeddings with error tracking
    const folderPayloads = await Promise.all(
      smartFolders.map(async (folder) => {
        try {
          const folderText = enrichFolderTextForEmbedding(
            folder.name,
            folder.description,
            folder.keywords
          );

          const { vector, model } = await getFolderMatcher().embedText(folderText);
          const folderId = folder.id || getFolderMatcher().generateFolderId(folder);

          results.success++;
          return {
            id: folderId,
            name: folder.name,
            description: folder.description || '',
            path: folder.path || '',
            vector,
            model,
            updatedAt: new Date().toISOString()
          };
        } catch (error) {
          results.failed++;
          results.errors.push({
            folder: folder.name,
            error: error.message
          });
          logger.warn(
            '[EMBEDDINGS] Failed to generate folder embedding:',
            folder.name,
            error.message
          );
          return null;
        }
      })
    );

    const validPayloads = folderPayloads.filter((p) => p !== null);

    // Do not mutate the existing folder index when every embedding generation fails.
    if (validPayloads.length === 0) {
      return {
        success: false,
        folders: 0,
        total: smartFolders.length,
        succeeded: 0,
        failed: results.failed,
        errors: results.errors.slice(0, 5),
        model: modelCheck.model,
        errorCode: 'REBUILD_FAILED_NO_VALID_FOLDERS',
        message: `All ${results.failed} folder embeddings failed. Existing folder index left unchanged.`
      };
    }

    const oramaService = getOramaService();
    const previousFolders =
      typeof oramaService.getAllFolders === 'function' ? await oramaService.getAllFolders() : [];
    const desiredFolderIds = new Set(validPayloads.map((payload) => payload.id).filter(Boolean));
    const staleFolderIds = previousFolders
      .map((/** @type {any} */ entry) => entry?.id)
      .filter(
        (/** @type {any} */ id) =>
          typeof id === 'string' && id.length > 0 && !desiredFolderIds.has(id)
      );

    // Upsert first, then delete stale IDs. This avoids wipe-first data loss on generation failures.
    const folderResult = await oramaService.batchUpsertFolders(validPayloads);
    const upsertedCount = folderResult?.count ?? folderResult ?? 0;

    if (staleFolderIds.length > 0) {
      if (typeof oramaService.batchDeleteFolders === 'function') {
        await oramaService.batchDeleteFolders(staleFolderIds);
      } else if (typeof oramaService.deleteFolderEmbedding === 'function') {
        for (const folderId of staleFolderIds) {
          await oramaService.deleteFolderEmbedding(folderId);
        }
      } else {
        logger.debug(
          '[EMBEDDINGS] Folder rebuild could not remove stale folder IDs; delete API unavailable'
        );
      }
    }

    // Record which model/dimensions were used for the index (for UI mismatch warnings)
    try {
      const probe = validPayloads[0];
      const dims = Array.isArray(probe?.vector) ? probe.vector.length : null;
      if (Number.isFinite(dims) && dims > 0) {
        await writeEmbeddingIndexMetadata({
          model: probe?.model || modelCheck.model,
          dims,
          source: 'rebuild-folders'
        });
      }
    } catch {
      // Non-fatal
    }

    // Return detailed status
    const allFailed = results.success === 0 && results.failed > 0;
    return {
      success: !allFailed,
      folders: upsertedCount,
      total: smartFolders.length,
      succeeded: results.success,
      failed: results.failed,
      errors: results.errors.slice(0, 5), // Limit error details
      model: modelCheck.model,
      message: allFailed
        ? `All ${results.failed} folder embeddings failed. Check AI engine status.`
        : results.failed > 0
          ? `${results.success} folders embedded, ${results.failed} failed`
          : `Successfully embedded ${results.success} folders`
    };
  } catch (e) {
    logger.error('[EMBEDDINGS] Rebuild folders failed:', e);
    return {
      success: false,
      error: e.message,
      errorCode: e.code || 'REBUILD_FAILED'
    };
  } finally {
    releaseRebuildLock(lockResult.token);
  }
}

/**
 * @param {IpcServiceContext|Record<string, any>} servicesOrParams - Service context or legacy parameters
 */
function registerEmbeddingsIpc(servicesOrParams) {
  let ipcContext;
  if (servicesOrParams instanceof IpcServiceContext) {
    ipcContext = servicesOrParams;
  } else {
    ipcContext = createFromLegacyParams(servicesOrParams);
  }

  const { ipcMain, IPC_CHANNELS, logger } = ipcContext.core;
  const { getCustomFolders } = ipcContext.folders;
  const { getServiceIntegration } = ipcContext;

  /** @param {string} serviceId */
  const resolveOptionalService = (serviceId) => {
    const integration = getServiceIntegration?.();
    if (serviceId === ServiceIds.SETTINGS && integration?.settingsService) {
      return integration.settingsService;
    }
    const integrationContainer = integration?.container;
    const resolutionTargets = [integrationContainer, container];

    for (const target of resolutionTargets) {
      if (!target) continue;
      try {
        if (typeof target.tryResolve === 'function') {
          const resolved = target.tryResolve(serviceId);
          if (resolved) return resolved;
          continue;
        }
        if (typeof target.resolve === 'function') {
          const resolved = target.resolve(serviceId);
          if (resolved) return resolved;
        }
      } catch {
        // Ignore resolution failures and continue to fallback target.
      }
    }

    return null;
  };

  const loadCurrentSettings = async () => {
    try {
      const settingsService = resolveOptionalService(ServiceIds.SETTINGS);
      if (settingsService?.load) {
        return await settingsService.load();
      }
    } catch (error) {
      logger.debug('[EMBEDDINGS] Failed to load settings', {
        error: error?.message || String(error)
      });
    }

    return null;
  };

  // Effective flag after experience-mode enforcement (F-192): Simple mode
  // enforces auto-chunking on, so the mode name must never veto chunk vectors.
  const shouldBuildChunkEmbeddings = async () => isAutoChunkEnabled(await loadCurrentSettings());

  // Use container-resolved services

  // SearchService and ClusteringService are resolved lazily via getters defined at module scope

  // State machine prevents concurrent re-initialization attempts
  const INIT_STATES = {
    PENDING: 'pending',
    IN_PROGRESS: 'in_progress',
    COMPLETED: 'completed',
    FAILED: 'failed'
  };

  let initState = INIT_STATES.PENDING;
  /** @type {Promise<void>|null} */
  let initPromise = null;
  let initMutexLocked = false;
  /** @type {Array<() => void>} */
  let initMutexWaiters = [];
  /** @type {string|null} */
  let initFailureReason = null;
  /** @type {number|null} */
  let initFailedAt = null;

  /**
   * Ensures services are initialized before IPC handlers execute
   * FIX: Uses state machine with mutex to prevent race conditions during initialization
   * @returns {Promise<void>}
   */
  async function ensureInitialized() {
    // Already initialized successfully
    if (initState === INIT_STATES.COMPLETED) {
      return Promise.resolve();
    }
    // Initialization previously failed - rate-limit retries but allow recovery
    if (initState === INIT_STATES.FAILED) {
      const now = Date.now();
      const retryDelayMs = 10000;
      if (initFailedAt && now - initFailedAt < retryDelayMs) {
        const err = /** @type {Error & { code?: string }} */ (
          new Error(initFailureReason || 'Vector DB is not available')
        );
        err.code = 'VECTOR_DB_UNAVAILABLE';
        throw err;
      }
      logger.info('[SEMANTIC] Retrying initialization after failure', {
        reason: initFailureReason
      });
      initState = INIT_STATES.PENDING;
      initFailureReason = null;
      initFailedAt = null;
    }

    // Initialization in progress - wait for it
    if (initState === INIT_STATES.IN_PROGRESS && initPromise) {
      return initPromise;
    }

    if (initMutexLocked) {
      const maxWaitMs = 30_000;
      let mutexTimedOut = false;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Initialization mutex timeout'));
        }, maxWaitMs);
        initMutexWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      }).catch((err) => {
        logger.error('[SEMANTIC] ' + err.message + ' - forcing unlock');
        mutexTimedOut = true;
        initMutexLocked = false;
        initMutexWaiters = [];
        initState = INIT_STATES.PENDING;
        initPromise = null;
        initFailureReason = err.message;
        initFailedAt = Date.now();
      });

      if (mutexTimedOut) {
        throw new Error('Semantic initialization timed out waiting for mutex');
      }

      if (initState === INIT_STATES.COMPLETED) {
        return Promise.resolve();
      }
      if (initState === INIT_STATES.IN_PROGRESS && initPromise) {
        return initPromise;
      }
    }

    // Acquire mutex for state transition
    initMutexLocked = true;

    try {
      // Double-check state after acquiring mutex (another caller may have completed)
      if (initState === INIT_STATES.COMPLETED) {
        return Promise.resolve();
      }

      if (initState === INIT_STATES.IN_PROGRESS && initPromise) {
        return initPromise;
      }

      // Previously failed - allow retry by resetting state
      if (initState === INIT_STATES.FAILED) {
        logger.info('[SEMANTIC] Previous initialization failed, retrying...');
      }

      // Start new initialization - atomically set both state and promise
      initState = INIT_STATES.IN_PROGRESS;

      initPromise = (async () => {
        // In-process Orama either works immediately or has a permanent error.
        // No point in long exponential backoff for a local in-memory database.
        const MAX_RETRIES = RETRY.MAX_ATTEMPTS_LOW; // 2
        const RETRY_DELAY_BASE = 500; // 500ms base delay

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            logger.info(
              `[SEMANTIC] Starting initialization (attempt ${attempt}/${MAX_RETRIES})...`
            );

            await getOramaService().initialize();

            await getFolderMatcher().initialize();

            logger.info('[SEMANTIC] Initialization complete');
            initState = INIT_STATES.COMPLETED;

            // Warm up search service in background (non-blocking)
            // This pre-builds the BM25 index for faster first search
            setImmediate(async () => {
              try {
                const searchSvc = await getSearchService();
                await searchSvc.warmUp({ buildBM25: true, warmVectorDb: true });
              } catch (warmErr) {
                logger.debug('[SEMANTIC] Search warm-up skipped:', warmErr.message);
              }
            });

            return; // Success - exit retry loop
          } catch (error) {
            logger.warn(`[SEMANTIC] Initialization attempt ${attempt} failed:`, error.message);

            if (attempt < MAX_RETRIES) {
              // Exponential backoff with jitter
              const delay = RETRY_DELAY_BASE * 2 ** (attempt - 1) + Math.random() * 1000;
              logger.info(`[SEMANTIC] Retrying in ${Math.round(delay)}ms...`);
              await new Promise((resolve) => {
                const timeoutId = setTimeout(resolve, delay);
                // Prevent timer from keeping process alive
                if (timeoutId && typeof timeoutId.unref === 'function') {
                  timeoutId.unref();
                }
              });
            } else {
              logger.error(
                '[SEMANTIC] All initialization attempts failed. Vector DB features will be unavailable.'
              );
              initState = INIT_STATES.FAILED;
              initFailureReason = 'Vector DB initialization failed';
              initFailedAt = Date.now();
              throw new Error(initFailureReason, { cause: error });
            }
          }
        }
      })();
    } finally {
      initMutexLocked = false;
      const waiters = initMutexWaiters.splice(0);
      for (const notify of waiters) notify();
    }

    return initPromise;
  }

  // with proper retry logic and exponential backoff in ensureInitialized().
  // This eliminates the race condition where users interact before the 5s delay.
  // Each handler calls ensureInitialized() which has built-in retry with backoff.
  //
  // Start background initialization after a shorter delay to pre-warm the service
  // but handlers will work correctly even if called before this completes.
  // before the pre-warm fires (prevents stale callback after shutdown).
  /** @type {ReturnType<typeof setTimeout>|null} */
  let _preWarmTimerId = null;
  if (process.env.NODE_ENV !== 'test') {
    setImmediate(() => {
      // Use setImmediate to ensure IPC handlers are registered first
      _preWarmTimerId = setTimeout(() => {
        _preWarmTimerId = null;
        ensureInitialized().catch((error) => {
          logger.warn('[SEMANTIC] Background pre-warm failed (non-fatal):', error.message);
          // Non-fatal - handlers will retry with proper backoff when called
        });
      }, 1000); // 1 second delay for pre-warming, handlers use retries if called earlier
    });
  }

  // Reusable Zod schemas for handler validation
  const context = 'Semantic';
  const schemaVoid = z ? z.void() : null;

  /**
   * Safely ensure vector DB is initialized, returning a graceful error response on failure.
   * Mirrors the safety net that withVectorDbInit previously provided.
   * @returns {Promise<Record<string, any>|null>} Error response object if init failed, null if successful
   */
  async function safeEnsureInit() {
    try {
      await ensureInitialized();
    } catch (e) {
      return {
        success: false,
        error: 'Vector DB is not available yet. Please try again in a moment.',
        code: e?.code || 'VECTOR_DB_UNAVAILABLE',
        unavailable: true
      };
    }
    return null;
  }

  /**
   * Rebuild folder embeddings from current smart folders
   * SAFE: Only resets the 'folder_embeddings' collection (not the entire DB directory).
   * This is a user-controlled, intentional rebuild that preserves all other data.
   */
  safeHandle(
    ipcMain,
    IPC_CHANNELS.EMBEDDINGS.REBUILD_FOLDERS,
    createHandler({
      logger,
      context,
      schema: schemaVoid,
      handler: () => handleRebuildFolders({ safeEnsureInit, logger, getCustomFolders })
    })
  );

  /**
   * Rebuild file embeddings from analysis history.
   * SAFE (D5): upserts over the live 'file_embeddings' collection — it never
   * clears anything, so an interrupted rebuild cannot empty the store.
   * Accepts `{ onlyMissing, excludePathPrefixes }` to backfill only files
   * without a usable vector and to skip watcher-owned folders.
   */
  safeHandle(
    ipcMain,
    IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES,
    createHandler({
      logger,
      context,
      schema: validationSchemas?.rebuildFilesOptions,
      handler: (_event, payload) =>
        handleRebuildFiles(
          {
            safeEnsureInit,
            logger,
            getCustomFolders,
            getServiceIntegration,
            shouldBuildChunkEmbeddings
          },
          payload && typeof payload === 'object' ? payload : {}
        )
    })
  );

  /**
   * Full rebuild: Clears all embeddings and rebuilds everything from scratch.
   * Use this when changing embedding models or to fix any sync issues.
   * This clears the vector DB, rebuilds folder embeddings, file embeddings,
   * file chunks, and the BM25 search index.
   */
  safeHandle(
    ipcMain,
    IPC_CHANNELS.EMBEDDINGS.FULL_REBUILD,
    createHandler({
      logger,
      context,
      schema: validationSchemas?.embeddingsFullRebuild,
      handler: (_event, options) =>
        handleFullRebuild(
          {
            safeEnsureInit,
            logger,
            getCustomFolders,
            getServiceIntegration,
            shouldBuildChunkEmbeddings
          },
          _event,
          options
        )
    })
  );

  /**
   * Reanalyze All: Forces re-analysis of ALL files in smart folders and refreshes
   * the embeddings of everything else that has ever been analyzed.
   * Use this when changing AI models to regenerate analysis and embeddings with the new model.
   * Nothing is deleted first: the watcher re-analyzes what it owns and the rest is
   * re-embedded from analysis history (D5/D8).
   */
  safeHandle(
    ipcMain,
    IPC_CHANNELS.EMBEDDINGS.REANALYZE_ALL,
    createHandler({
      logger,
      context,
      schema: validationSchemas?.embeddingsReanalyzeAll,
      handler: (_event, options) =>
        handleReanalyzeAll(
          {
            safeEnsureInit,
            logger,
            getCustomFolders,
            getServiceIntegration,
            getMainWindow: ipcContext.electron?.getMainWindow,
            shouldBuildChunkEmbeddings
          },
          _event,
          options
        )
    })
  );

  /**
   * Reanalyze File: Forces re-analysis of a single file in a smart folder.
   */
  safeHandle(
    ipcMain,
    IPC_CHANNELS.EMBEDDINGS.REANALYZE_FILE,
    createHandler({
      logger,
      context,
      schema: validationSchemas?.embeddingsReanalyzeFile,
      handler: (_event, payload) =>
        handleReanalyzeFile({ logger, getServiceIntegration }, _event, payload)
    })
  );

  // New endpoint for getting vector DB statistics
  safeHandle(
    ipcMain,
    IPC_CHANNELS.EMBEDDINGS.GET_STATS,
    createHandler({
      logger,
      context,
      schema: validationSchemas?.embeddingsEmptyPayload,
      handler: () =>
        handleGetStats({ safeEnsureInit, logger, getCustomFolders, getServiceIntegration })
    })
  );

  // Diagnostic endpoint for troubleshooting search issues
  // Returns detailed analysis of why search might return partial or no results
  safeHandle(
    ipcMain,
    IPC_CHANNELS.EMBEDDINGS.DIAGNOSE_SEARCH,
    createHandler({
      logger,
      context,
      schema: validationSchemas?.embeddingsDiagnoseSearch,
      handler: (event, payload) => handleDiagnoseSearch({ safeEnsureInit, logger }, event, payload)
    })
  );

  // New endpoint for finding similar documents
  safeHandle(
    ipcMain,
    IPC_CHANNELS.EMBEDDINGS.FIND_SIMILAR,
    createHandler({
      logger,
      context,
      schema: validationSchemas?.findSimilar,
      handler: (event, payload) => handleFindSimilar({ safeEnsureInit, logger }, event, payload)
    })
  );

  // Global semantic search (query -> ranked files)
  // Uses SearchService.hybridSearch for combined BM25 + vector search with RRF fusion
  // Enhanced with query processing (spell correction, synonyms) and LLM re-ranking
  safeHandle(
    ipcMain,
    IPC_CHANNELS.EMBEDDINGS.SEARCH,
    createHandler({
      logger,
      context,
      schema: validationSchemas?.semanticSearch,
      handler: (event, payload) =>
        handleSearch({ safeEnsureInit, logger, resolveOptionalService }, event, payload)
    })
  );

  // Score a subset of file IDs against a query (for "search within graph")
  safeHandle(
    ipcMain,
    IPC_CHANNELS.EMBEDDINGS.SCORE_FILES,
    createHandler({
      logger,
      context,
      schema: validationSchemas?.scoreFiles,
      handler: (event, payload) => handleScoreFiles({ safeEnsureInit, logger }, event, payload)
    })
  );

  // ============================================================================
  // Hybrid Search Handlers
  // ============================================================================

  // Hybrid search uses the SEARCH handler (mode: 'hybrid' | 'vector' | 'bm25')

  /**
   * Rebuild the BM25 keyword search index
   * Also extends QueryProcessor vocabulary for better spell correction
   */
  safeHandle(
    ipcMain,
    IPC_CHANNELS.EMBEDDINGS.REBUILD_BM25_INDEX,
    createHandler({
      logger,
      context,
      schema: schemaVoid,
      handler: () => handleRebuildBm25Index({ safeEnsureInit, logger, getServiceIntegration })
    })
  );

  /**
   * Get the current search index status
   */
  safeHandle(
    ipcMain,
    IPC_CHANNELS.EMBEDDINGS.GET_SEARCH_STATUS,
    createHandler({
      logger,
      context,
      schema: schemaVoid,
      handler: () => handleGetSearchStatus({ safeEnsureInit, logger })
    })
  );

  // ============================================================================
  // Multi-Hop Expansion Handlers
  // ============================================================================

  /**
   * Find similar files with multi-hop expansion
   * Explores neighbors of neighbors with decay scoring
   */
  safeHandle(
    ipcMain,
    IPC_CHANNELS.EMBEDDINGS.FIND_MULTI_HOP,
    createHandler({
      logger,
      context,
      schema: validationSchemas?.embeddingsFindMultiHop,
      handler: (event, payload) => handleFindMultiHop({ safeEnsureInit, logger }, event, payload)
    })
  );

  // ============================================================================
  // Clustering Handlers
  // ============================================================================

  /**
   * Compute semantic clusters of files
   */
  safeHandle(
    ipcMain,
    IPC_CHANNELS.EMBEDDINGS.COMPUTE_CLUSTERS,
    createHandler({
      logger,
      context,
      schema: validationSchemas?.computeClusters,
      handler: (event, payload) => handleComputeClusters({ safeEnsureInit, logger }, event, payload)
    })
  );

  /**
   * Get computed clusters
   */
  safeHandle(
    ipcMain,
    IPC_CHANNELS.EMBEDDINGS.GET_CLUSTERS,
    createHandler({
      logger,
      context,
      schema: schemaVoid,
      handler: () => handleGetClusters({ safeEnsureInit, logger })
    })
  );

  /**
   * FIX: Clear cluster cache manually
   * Allows users/admins to force cluster recalculation without waiting for staleness timeout
   */
  safeHandle(
    ipcMain,
    IPC_CHANNELS.EMBEDDINGS.CLEAR_CLUSTERS,
    createHandler({
      logger,
      context,
      schema: schemaVoid,
      handler: () => handleClearClusters({ safeEnsureInit, logger })
    })
  );

  /**
   * Rename a cluster with a user-supplied label (persisted to disk)
   */
  safeHandle(
    ipcMain,
    IPC_CHANNELS.EMBEDDINGS.RENAME_CLUSTER,
    createHandler({
      logger,
      context,
      schema: z.object({ clusterId: z.string(), newLabel: z.string().min(1).max(100) }),
      handler: (event, payload) => handleRenameCluster({ safeEnsureInit, logger }, event, payload)
    })
  );

  /**
   * Get members of a specific cluster
   */
  safeHandle(
    ipcMain,
    IPC_CHANNELS.EMBEDDINGS.GET_CLUSTER_MEMBERS,
    createHandler({
      logger,
      context,
      schema: validationSchemas?.getClusterMembers,
      handler: (event, payload) =>
        handleGetClusterMembers({ safeEnsureInit, logger }, event, payload)
    })
  );

  /**
   * Get similarity edges between files for graph visualization
   */
  safeHandle(
    ipcMain,
    IPC_CHANNELS.EMBEDDINGS.GET_SIMILARITY_EDGES,
    createHandler({
      logger,
      context,
      schema: validationSchemas?.similarityEdges,
      handler: (event, payload) =>
        handleGetSimilarityEdges({ safeEnsureInit, logger }, event, payload)
    })
  );

  /**
   * Find files by paths
   * Resolves file paths to vector DB IDs and metadata
   */
  safeHandle(
    ipcMain,
    IPC_CHANNELS.EMBEDDINGS.FIND_FILES_BY_PATHS,
    createHandler({
      logger,
      context,
      schema: validationSchemas?.embeddingsFindFilesByPaths,
      handler: (event, payload) =>
        handleFindFilesByPaths({ safeEnsureInit, logger }, event, payload)
    })
  );

  /**
   * Get fresh file metadata from vector DB
   * Used to get current file paths after files have been moved/organized
   */
  safeHandle(
    ipcMain,
    IPC_CHANNELS.EMBEDDINGS.GET_FILE_METADATA,
    createHandler({
      logger,
      context,
      schema: validationSchemas?.getFileMetadata,
      handler: (event, payload) => handleGetFileMetadata({ safeEnsureInit, logger }, event, payload)
    })
  );

  /**
   * Find near-duplicate files across the indexed collection
   * Groups files with high semantic similarity (>=0.9 by default)
   */
  safeHandle(
    ipcMain,
    IPC_CHANNELS.EMBEDDINGS.FIND_DUPLICATES,
    createHandler({
      logger,
      context,
      schema: validationSchemas?.findDuplicates,
      handler: (event, payload) => handleFindDuplicates({ safeEnsureInit, logger }, event, payload)
    })
  );

  /**
   * Trash a batch of duplicate files via shell.trashItem and record a single
   * undo entry. This is the delete path for the Duplicate Finder modal.
   */
  safeHandle(
    ipcMain,
    IPC_CHANNELS.EMBEDDINGS.TRASH_DUPLICATES,
    createHandler({
      logger,
      context,
      schema: validationSchemas?.trashDuplicates,
      handler: (event, payload) => handleTrashDuplicates({ logger }, event, payload)
    })
  );

  /**
   * Backfill fileHash for Orama files that don't have one yet. Walks the
   * files collection up to `maxFiles`, streams SHA-256 through the shared
   * hash cache, and calls OramaVectorService.updateFileHash for each.
   */
  safeHandle(
    ipcMain,
    IPC_CHANNELS.EMBEDDINGS.REINDEX_FILE_HASHES,
    createHandler({
      logger,
      context,
      schema: validationSchemas?.reindexFileHashes,
      handler: (event, payload) =>
        handleReindexFileHashes({ safeEnsureInit, logger }, event, payload)
    })
  );

  /**
   * Atlas latent-space projection: paginated 2D UMAP coords + color keys.
   */
  safeHandle(
    ipcMain,
    IPC_CHANNELS.ATLAS.GET_PROJECTION,
    createHandler({
      logger,
      context,
      schema: validationSchemas?.atlasGetProjection,
      handler: (event, payload) =>
        handleGetAtlasProjection({ safeEnsureInit, logger }, event, payload)
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.ATLAS.GET_STATUS,
    createHandler({
      logger,
      context,
      schema: validationSchemas?.embeddingsEmptyPayload,
      handler: () => handleGetAtlasStatus({ safeEnsureInit, logger })
    })
  );

  // Pre-warm timer cleanup on app quit.
  //
  // Note: We do NOT call `getOramaService().cleanup()` here — that would race with
  // `lifecycle.js`'s ordered `SHUTDOWN_ORDER` which already shuts down ORAMA_VECTOR
  // through the ServiceContainer. Electron fires multiple `before-quit` listeners
  // in parallel (it does not serialize async handlers), so duplicating Orama
  // cleanup here risks double-close / data corruption on exit.
  //
  // We only perform cheap synchronous cleanup (clearing a timer).
  const { app } = require('electron');
  app.once('before-quit', () => {
    if (_preWarmTimerId) {
      try {
        clearTimeout(_preWarmTimerId);
      } catch {
        /* ignore */
      }
      _preWarmTimerId = null;
    }
    // Terminate the Atlas UMAP worker_thread so it can't keep the process
    // alive. No-op if the atlas was never opened (worker is spawned lazily).
    try {
      getAtlasService()?.shutdown?.();
    } catch {
      /* ignore */
    }
  });
}

module.exports = registerEmbeddingsIpc;
module.exports.getSearchServiceInstance = getSearchServiceInstance;
module.exports.getClusteringServiceInstance = getClusteringServiceInstance;
module.exports.enrichDuplicateMemberSizes = enrichDuplicateMemberSizes;
// Exported for unit tests (lock semantics are safety-critical for rebuilds).
module.exports.acquireRebuildLock = acquireRebuildLock;
module.exports.touchRebuildLock = touchRebuildLock;
module.exports.releaseRebuildLock = releaseRebuildLock;
// Test seam for the reanalyze-all backfill (see __setRebuildFilesForTest).
module.exports.__setRebuildFilesForTest = __setRebuildFilesForTest;
