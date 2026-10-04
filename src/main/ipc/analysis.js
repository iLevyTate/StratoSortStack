// @ts-check
const fs = require('fs').promises;
const path = require('path');
const { IpcServiceContext, createFromLegacyParams } = require('./IpcServiceContext');
const { performance } = require('perf_hooks');
const { TIMEOUTS } = require('../../shared/performanceConstants');
const { createHandler, safeHandle, z } = require('./ipcWrappers');
const { schemas } = require('./validationSchemas');
const { generateSuggestedNameFromAnalysis } = require('../services/autoOrganize/namingUtils');
const { normalizeNamingConventionState } = require('../../shared/namingConventions');
const { safeFilePath } = require('../utils/safeAccess');
const { validateFileOperationPath } = require('../../shared/pathSanitization');
const { isFallbackAnalysis } = require('../../shared/analysisProvenance');
const { mapFoldersToCategories, getFolderNamesString } = require('../../shared/folderUtils');
const { recognizeIfAvailable } = require('../utils/tesseractUtils');
const {
  withProcessingState,
  buildErrorContext,
  createAnalysisFallback,
  recordAnalysisResult,
  getFolderCategories
} = require('./analysisUtils');
const BatchAnalysisService = require('../services/BatchAnalysisService');
const { sendOperationProgress, sendFileComplete } = require('./files/batchProgressReporter');
const { createMediaAnalyzerAdapter } = require('../services/mediaAnalyzerAdapter');
const { getInstance: getWhisperService } = require('../services/WhisperService');

function safeGetWhisperService() {
  try {
    return getWhisperService();
  } catch {
    return null;
  }
}

/** @type {InstanceType<typeof BatchAnalysisService> | null} */
let batchAnalysisService = null;
/** @type {Map<string, Record<string, any>>} */
const activeBatchRuns = new Map();

/**
 * Resolve naming settings from an IPC override (Discover session) or persisted Settings.
 * @param {Record<string, any>|null|undefined} settingsService
 * @param {Record<string, any>|null|undefined} namingOverride
 * @returns {Promise<{ convention: string, separator: string, dateFormat: string, caseConvention: string }|null>}
 */
async function resolveNamingSettings(settingsService, namingOverride) {
  if (namingOverride && typeof namingOverride === 'object') {
    return normalizeNamingConventionState(namingOverride);
  }
  if (!settingsService) {
    return null;
  }
  try {
    const settings =
      typeof settingsService.load === 'function'
        ? await settingsService.load()
        : settingsService.getAll?.();
    if (!settings || typeof settings !== 'object') {
      return null;
    }
    return normalizeNamingConventionState({
      convention: settings.namingConvention,
      separator: settings.separator,
      dateFormat: settings.dateFormat,
      caseConvention: settings.caseConvention
    });
  } catch {
    return null;
  }
}

/**
 * Apply persisted naming convention to analysis results from Discover/IPC (parity with watchers).
 * Preserves the raw model suggestion in `llmSuggestedName` when applying a convention-shaped `suggestedName`.
 * @param {string} filePath
 * @param {Record<string, any>|null|undefined} result - Analysis result (mutated in place when naming applies)
 * @param {Record<string, any>|null|undefined} settingsService
 * @param {import('./ipcWrappers').LoggerLike} logger
 * @param {string} logPrefix
 * @param {Record<string, any>|null|undefined} [namingOverride] - Discover session naming (wins over Settings when set)
 */
async function applyUserNamingFromSettings(
  filePath,
  result,
  settingsService,
  logger,
  logPrefix,
  namingOverride = null
) {
  if (!result || typeof result !== 'object') {
    return result;
  }
  // Pre-fix this guard short-circuited on ANY `result.error` — including
  // the structured fallbacks that downstream code emits when the model is
  // unavailable, the PDF is encrypted, or the cloud provider failed. Those
  // fallbacks DO carry a usable `suggestedName` (filename-derived); skipping
  // naming convention application meant the user's "subject-date" / kebab-case
  // settings silently stopped working in those degraded paths. Apply the
  // convention whenever a usable suggestedName is present, even on a
  // fallback result; pure errors with no suggestedName still skip.
  const hasUsableSuggestedName =
    typeof result.suggestedName === 'string' && result.suggestedName.trim().length > 0;
  if (result.error && !hasUsableSuggestedName) {
    return result;
  }
  try {
    const namingSettings = await resolveNamingSettings(settingsService, namingOverride);
    if (!namingSettings) {
      return result;
    }
    const stats = await fs.stat(filePath);
    const fileTimestamps = { created: stats.birthtime, modified: stats.mtime };
    const originalFileName = path.basename(filePath);
    const preservedLlm =
      typeof result.llmSuggestedName === 'string' && result.llmSuggestedName.trim()
        ? result.llmSuggestedName.trim()
        : typeof result.suggestedName === 'string' && result.suggestedName.trim()
          ? result.suggestedName.trim()
          : originalFileName;
    const suggestedName = generateSuggestedNameFromAnalysis({
      originalFileName,
      analysis: { ...result, suggestedName: preservedLlm },
      settings: namingSettings,
      fileTimestamps
    });
    if (suggestedName) {
      result.llmSuggestedName = preservedLlm;
      result.suggestedName = suggestedName;
      // Info-level so "naming convention not working" reports are diagnosable
      // straight from the session log without lowering global log level.
      logger.info(`${logPrefix} Naming convention applied`, {
        convention: namingSettings.convention,
        caseConvention: namingSettings.caseConvention,
        original: originalFileName,
        raw: preservedLlm,
        final: suggestedName
      });
    }
  } catch (e) {
    logger.debug(`${logPrefix} User naming convention not applied`, { error: e?.message });
  }
  return result;
}

function getBatchAnalysisService() {
  if (!batchAnalysisService) {
    batchAnalysisService = new BatchAnalysisService();
  }
  return batchAnalysisService;
}

async function shutdownBatchAnalysisService() {
  if (!batchAnalysisService) return;
  const activeRuns = Array.from(activeBatchRuns.values());
  for (const runState of activeRuns) {
    runState.cancelled = true;
    runState.abortController?.abort();
    if (!runState.reason) {
      runState.reason = 'Application shutdown';
      runState.requestedAt = Date.now();
    }
  }
  const drainPromises = activeRuns
    .map((runState) => runState.completionPromise)
    .filter((promise) => promise && typeof promise.then === 'function');
  if (drainPromises.length > 0) {
    await Promise.race([
      Promise.allSettled(drainPromises),
      new Promise((resolve) => setTimeout(resolve, TIMEOUTS.HEALTH_CHECK))
    ]);
  }
  const service = batchAnalysisService;
  batchAnalysisService = null;
  await service.shutdown();
}

/**
 * @param {IpcServiceContext|Record<string, any>} servicesOrParams - Service context or legacy parameters
 */
function registerAnalysisIpc(servicesOrParams) {
  let container;
  if (servicesOrParams instanceof IpcServiceContext) {
    container = servicesOrParams;
  } else {
    container = createFromLegacyParams(servicesOrParams);
  }

  const { ipcMain, IPC_CHANNELS, logger } = container.core;
  const { analyzeDocumentFile, analyzeImageFile } = container.analysis;
  const { systemAnalytics, getServiceIntegration } = container;
  const { getCustomFolders } = container.folders;
  const getMainWindow = container.electron?.getMainWindow;
  const settingsService = container.settings?.settingsService;

  // Fail closed: if Zod fails to load, fall back to the schemas module's
  // fallback validators (they implement safeParse so createHandler keeps
  // validating instead of silently accepting unvalidated payloads).
  // .max(4096) caps the IPC payload at the most permissive platform path
  // limit (linux PATH_MAX). Without this a renderer compromise (or a
  // pathological URL handler) could send a multi-MB string and burn
  // memory inside the Zod parse + downstream path-validation layers
  // before getting rejected. The actual per-platform path-length check
  // (260 on win32, 1024 on darwin, 4096 on linux) still happens further
  // down in validatePath; this is defense-in-depth at the IPC boundary.
  const stringSchema = z ? z.string().min(1).max(4096) : schemas.filePath;
  const namingSettingsSchema = z
    ? z.object({
        convention: z.string().max(64).optional(),
        separator: z.string().max(10).optional(),
        dateFormat: z.string().max(32).optional(),
        caseConvention: z.string().max(32).optional()
      })
    : null;
  const analyzeFilePayloadSchema = z
    ? z.union([
        stringSchema,
        z.object({
          filePath: z.string().min(1).max(4096),
          namingSettings: namingSettingsSchema.optional()
        })
      ])
    : {
        /** @param {any} data */
        safeParse(data) {
          if (typeof data === 'string' && data.length > 0) {
            return { success: true, data };
          }
          if (
            data &&
            typeof data === 'object' &&
            typeof data.filePath === 'string' &&
            data.filePath.length > 0
          ) {
            return { success: true, data };
          }
          return { success: false, error: { message: 'Invalid analyze file payload' } };
        }
      };

  /** @param {any} payload */
  function normalizeAnalyzeFilePayload(payload) {
    if (typeof payload === 'string') {
      return { filePath: payload, namingOverride: null };
    }
    if (payload && typeof payload === 'object') {
      return {
        filePath: payload.filePath,
        namingOverride: payload.namingSettings || null
      };
    }
    return { filePath: '', namingOverride: null };
  }
  // Defense-in-depth path refine for batch entries: the preload validator
  // rejects UNC/URL/etc, but a compromised renderer could bypass the preload
  // entirely. Schema-side check shrinks the surface to "compromised main
  // process or schema bug".
  /** @param {any} val */
  const isSafeAbsoluteBatchPath = (val) => {
    if (typeof val !== 'string' || val.length === 0) return false;
    // Normalize separators before traversal check so legitimate filenames
    // like `C:\Users\foo..bar\file.txt` or `/home/me/v1.2..3/build.log`
    // are not rejected as traversal. Mirrors the canonical `hasPathTraversal`
    // helper in validationSchemas.js.
    if (val.replace(/\\/g, '/').includes('../')) return false;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(val)) return false;
    if (val.startsWith('\\\\') || val.startsWith('//')) return false;
    return /^[a-zA-Z]:[\\/]/.test(val) || val.startsWith('/');
  };
  const SAFE_BATCH_PATH_MSG =
    'filePaths entries must be absolute and must not be UNC, URL, or contain ../ traversal';
  // Typed smart-folder shape with bounded fields. Loose object: handlers and
  // the prompt builder read more folder fields than we enumerate here, so
  // unknown keys pass through instead of being stripped by Zod's default mode.
  const batchSmartFolderSchema = z
    ? z.looseObject({
        id: z.string().max(160).optional(),
        name: z.string().min(1).max(255),
        path: z.string().max(2048).optional(),
        description: z.string().max(2000).optional(),
        keywords: z.array(z.string().max(200)).max(200).optional()
      })
    : null;
  const analyzeBatchSchema = z
    ? z.object({
        batchId: z.string().min(1).max(160).optional(),
        filePaths: z
          .array(z.string().min(1).max(2048).refine(isSafeAbsoluteBatchPath, SAFE_BATCH_PATH_MSG))
          .min(1)
          .max(10000),
        smartFolders: z.array(batchSmartFolderSchema).max(1000).optional(),
        options: z
          .object({
            concurrency: z.number().int().min(1).max(8).optional(),
            autoConcurrency: z.boolean().optional(),
            stopOnError: z.boolean().optional(),
            sectionOrder: z.enum(['documents-first', 'images-first']).optional(),
            enableVisionBatchMode: z.boolean().optional(),
            namingSettings: z
              .object({
                convention: z.string().max(64).optional(),
                separator: z.string().max(10).optional(),
                dateFormat: z.string().max(32).optional(),
                caseConvention: z.string().max(32).optional()
              })
              .optional()
          })
          .optional()
      })
    : {
        /** @param {any} data */
        safeParse(data) {
          if (!data || typeof data !== 'object') {
            return { success: false, error: { message: 'Batch payload must be an object' } };
          }
          if (!Array.isArray(data.filePaths) || data.filePaths.length === 0) {
            return {
              success: false,
              error: { message: 'filePaths must be a non-empty array' }
            };
          }
          for (const fp of data.filePaths) {
            if (typeof fp !== 'string' || fp.length === 0) {
              return {
                success: false,
                error: { message: 'filePaths entries must be non-empty strings' }
              };
            }
          }
          return { success: true, data };
        }
      };
  const cancelBatchSchema = z
    ? z.object({
        batchId: z.string().min(1).max(160),
        reason: z.string().min(1).max(200).optional()
      })
    : {
        /** @param {any} data */
        safeParse(data) {
          if (!data || typeof data !== 'object') {
            return { success: false, error: { message: 'Cancel payload must be an object' } };
          }
          if (typeof data.batchId !== 'string' || data.batchId.length === 0) {
            return {
              success: false,
              error: { message: 'batchId is required and must be a non-empty string' }
            };
          }
          if (data.batchId.length > 160) {
            return { success: false, error: { message: 'batchId exceeds 160 characters' } };
          }
          return { success: true, data };
        }
      };
  const LOG_PREFIX = '[IPC-ANALYSIS]';
  const READY_QUEUE_HYDRATION_LIMIT = 1000;

  /** @param {any} result */
  function classifyAnalysisOutcome(result) {
    if (!result || typeof result !== 'object') {
      return { outcome: 'error', reason: 'empty_result' };
    }
    if (result.error) {
      return { outcome: 'fallback', reason: 'analysis_error' };
    }

    const extractionMethod = String(result.extractionMethod || '').toLowerCase();
    const fallbackReason = String(result.fallbackReason || '').trim();
    const warning = String(result.analysisWarning || '').trim();
    const isFallbackFlag = Boolean(result.isFallback || result._isFallback);
    // The shared provenance list is the truth table for "no real content
    // analysis happened" (it knows `format_unsupported`, which the substring
    // heuristic did not); the substrings stay for methods stamped by older
    // producers that never made the list.
    const fallbackMethod =
      isFallbackAnalysis(result) ||
      extractionMethod.includes('fallback') ||
      extractionMethod.includes('failed') ||
      extractionMethod.includes('filename') ||
      extractionMethod.includes('pdf_no_text');

    if (isFallbackFlag || fallbackReason || warning || fallbackMethod) {
      return {
        outcome: 'fallback',
        reason:
          fallbackReason ||
          warning ||
          extractionMethod ||
          (isFallbackFlag ? 'fallback_flagged' : 'fallback')
      };
    }
    return { outcome: 'primary', reason: extractionMethod || 'ai_primary' };
  }

  /**
   * @param {any} systemAnalytics
   * @param {string} pipelineName
   * @param {any} resultLike
   */
  function recordPipelineOutcome(systemAnalytics, pipelineName, resultLike) {
    const { outcome, reason } = classifyAnalysisOutcome(resultLike);
    systemAnalytics?.recordPipelineOutcome?.(pipelineName, outcome, { reason });
  }

  /** @param {string} filePath */
  async function validateAnalysisPath(filePath) {
    const cleanPath = safeFilePath(filePath);
    if (!cleanPath) {
      throw new Error('Invalid file path provided');
    }

    // UNC paths are allowed by smart-folder registration (see
    // src/main/ipc/smartFolders.js and folderHandlers.js), so rejecting
    // them here left users unable to analyze files that live on a
    // network share they explicitly added as a watch root. Allow UNC
    // consistently across analyze / organize / smartFolder ingest; the
    // `allowedBasePaths` check in validateFileOperationPath still gates
    // which UNC shares are reachable.
    const validation = await validateFileOperationPath(cleanPath, {
      requireExists: true,
      checkSymlinks: true,
      requireAbsolute: true,
      disallowUNC: false,
      disallowUrlSchemes: true,
      allowFileUrl: false
    });

    if (!validation.valid) {
      throw new Error(validation.error || 'Invalid file path provided');
    }

    return validation.normalizedPath;
  }

  /**
   * Core document analysis logic - shared between with-zod and without-zod handlers
   * @param {string} filePath
   * @param {AbortSignal|undefined} abortSignal
   * @param {Record<string, any>|null} [namingOverride]
   */
  async function performDocumentAnalysis(filePath, abortSignal, namingOverride = null) {
    const serviceIntegration = getServiceIntegration?.();
    const cleanPath = await validateAnalysisPath(filePath);

    const startTime = performance.now();
    logger.info(`${LOG_PREFIX} Starting document analysis for: ${cleanPath}`);

    // Fast-fail on a signal that fired during validation — avoid the more
    // expensive extract/analyze steps below when the preload timeout has
    // already rejected the renderer promise.
    if (abortSignal?.aborted) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error(`document analysis aborted for ${cleanPath}`)
      );
      err.name = 'AbortError';
      err.code = 'ABORT_ERR';
      throw err;
    }

    try {
      return await withProcessingState({
        filePath: cleanPath,
        processingState: serviceIntegration?.processingState,
        logger,
        logPrefix: LOG_PREFIX,
        fn: async () => {
          const folderCategories = getFolderCategories(
            getCustomFolders,
            mapFoldersToCategories,
            logger
          );
          logger.info(
            `${LOG_PREFIX} Using ${folderCategories.length} smart folders for context:`,
            getFolderNamesString(folderCategories)
          );

          const result = await analyzeDocumentFile(cleanPath, folderCategories, { abortSignal });
          await applyUserNamingFromSettings(
            cleanPath,
            result,
            settingsService,
            logger,
            LOG_PREFIX,
            namingOverride
          );
          const duration = performance.now() - startTime;
          systemAnalytics?.recordProcessingTime?.(duration);
          systemAnalytics?.recordSuccess?.();

          const persistResult = await recordAnalysisResult({
            filePath: cleanPath,
            result,
            processingTime: duration,
            modelType: 'llm',
            analysisHistory: serviceIntegration?.analysisHistory,
            logger
          });
          if (persistResult && !persistResult.persisted) {
            result._persistenceWarning = persistResult.reason || 'unknown';
          }
          recordPipelineOutcome(systemAnalytics, 'document', result);

          return result;
        }
      });
    } catch (error) {
      // Cancellation must propagate, not degrade into a persisted fallback
      // analysis the user never asked for.
      if (
        error?.code === 'OPERATION_CANCELLED' ||
        error?.code === 'ABORT_ERR' ||
        error?.name === 'AbortError'
      ) {
        throw error;
      }
      const errorContext = buildErrorContext({
        operation: 'document-analysis',
        filePath: cleanPath,
        error
      });
      logger.error(`${LOG_PREFIX} Document analysis failed with context:`, errorContext);
      systemAnalytics?.recordFailure?.(error);
      const fallback = createAnalysisFallback(cleanPath, 'documents', error.message);
      await applyUserNamingFromSettings(
        cleanPath,
        fallback,
        settingsService,
        logger,
        LOG_PREFIX,
        namingOverride
      );
      try {
        await serviceIntegration?.processingState?.upsertReadyAnalysis?.(cleanPath, fallback);
      } catch (readyPersistError) {
        logger.debug(`${LOG_PREFIX} Failed to persist fallback ready entry`, {
          filePath: cleanPath,
          error: readyPersistError?.message
        });
      }
      recordPipelineOutcome(systemAnalytics, 'document', fallback);
      return fallback;
    }
  }

  const analyzeDocumentHandler = createHandler({
    logger,
    context: 'Analysis',
    schema: analyzeFilePayloadSchema,
    handler: (event, payload) => {
      const { filePath, namingOverride } = normalizeAnalyzeFilePayload(payload);
      return performDocumentAnalysis(filePath, event?.abortSignal, namingOverride);
    }
  });

  safeHandle(ipcMain, IPC_CHANNELS.ANALYSIS.ANALYZE_DOCUMENT, analyzeDocumentHandler);

  const IMAGE_LOG_PREFIX = '[IPC-IMAGE-ANALYSIS]';

  /**
   * Core image analysis logic - shared between with-zod and without-zod handlers
   * @param {string} filePath
   * @param {AbortSignal|undefined} abortSignal
   * @param {Record<string, any>|null} [namingOverride]
   */
  async function performImageAnalysis(filePath, abortSignal, namingOverride = null) {
    const serviceIntegration = getServiceIntegration?.();
    const cleanPath = await validateAnalysisPath(filePath);

    const startTime = performance.now();
    logger.info(`${IMAGE_LOG_PREFIX} Starting image analysis for: ${cleanPath}`);

    // Fast-fail if the preload timeout already fired — vision passes are
    // expensive and there is no point starting them after the renderer
    // has given up on the promise.
    if (abortSignal?.aborted) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error(`image analysis aborted for ${cleanPath}`)
      );
      err.name = 'AbortError';
      err.code = 'ABORT_ERR';
      throw err;
    }

    try {
      return await withProcessingState({
        filePath: cleanPath,
        processingState: serviceIntegration?.processingState,
        logger,
        logPrefix: IMAGE_LOG_PREFIX,
        fn: async () => {
          const folderCategories = getFolderCategories(
            getCustomFolders,
            mapFoldersToCategories,
            logger
          );
          logger.info(
            `${IMAGE_LOG_PREFIX} Using ${folderCategories.length} smart folders for context:`,
            getFolderNamesString(folderCategories)
          );

          const result = await analyzeImageFile(cleanPath, folderCategories, { abortSignal });
          await applyUserNamingFromSettings(
            cleanPath,
            result,
            settingsService,
            logger,
            IMAGE_LOG_PREFIX,
            namingOverride
          );
          const duration = performance.now() - startTime;
          systemAnalytics?.recordProcessingTime?.(duration);
          systemAnalytics?.recordSuccess?.();

          const persistResult = await recordAnalysisResult({
            filePath: cleanPath,
            result,
            processingTime: duration,
            modelType: 'vision',
            analysisHistory: serviceIntegration?.analysisHistory,
            logger
          });
          if (persistResult && !persistResult.persisted) {
            result._persistenceWarning = persistResult.reason || 'unknown';
          }
          recordPipelineOutcome(systemAnalytics, 'image', result);

          return result;
        }
      });
    } catch (error) {
      // Cancellation must propagate, not degrade into a persisted fallback
      // analysis the user never asked for.
      if (
        error?.code === 'OPERATION_CANCELLED' ||
        error?.code === 'ABORT_ERR' ||
        error?.name === 'AbortError'
      ) {
        throw error;
      }
      const errorContext = buildErrorContext({
        operation: 'image-analysis',
        filePath: cleanPath,
        error
      });
      logger.error(`${IMAGE_LOG_PREFIX} Image analysis failed with context:`, errorContext);
      systemAnalytics?.recordFailure?.(error);
      const fallback = createAnalysisFallback(cleanPath, 'images', error.message);
      await applyUserNamingFromSettings(
        cleanPath,
        fallback,
        settingsService,
        logger,
        IMAGE_LOG_PREFIX,
        namingOverride
      );
      try {
        await serviceIntegration?.processingState?.upsertReadyAnalysis?.(cleanPath, fallback);
      } catch (readyPersistError) {
        logger.debug(`${IMAGE_LOG_PREFIX} Failed to persist fallback ready entry`, {
          filePath: cleanPath,
          error: readyPersistError?.message
        });
      }
      recordPipelineOutcome(systemAnalytics, 'image', fallback);
      return fallback;
    }
  }

  const analyzeImageHandler = createHandler({
    logger,
    context: 'Analysis',
    schema: analyzeFilePayloadSchema,
    handler: (event, payload) => {
      const { filePath, namingOverride } = normalizeAnalyzeFilePayload(payload);
      return performImageAnalysis(filePath, event?.abortSignal, namingOverride);
    }
  });

  safeHandle(ipcMain, IPC_CHANNELS.ANALYSIS.ANALYZE_IMAGE, analyzeImageHandler);

  const MEDIA_LOG_PREFIX = '[IPC-MEDIA-ANALYSIS]';

  /**
   * Single-file media (audio/video) analysis. Mirrors performImageAnalysis;
   * routes through mediaAnalyzerAdapter so the Whisper-missing graceful skip
   * applies here too. The renderer can call window.api.analysis.media() to
   * analyze a single audio/video file directly without going through batch.
   * @param {string} filePath
   * @param {AbortSignal|undefined} abortSignal
   * @param {Record<string, any>|null} [namingOverride]
   */
  async function performMediaAnalysis(filePath, abortSignal, namingOverride = null) {
    const serviceIntegration = getServiceIntegration?.();
    const cleanPath = await validateAnalysisPath(filePath);

    const startTime = performance.now();
    logger.info(`${MEDIA_LOG_PREFIX} Starting media analysis for: ${cleanPath}`);

    if (abortSignal?.aborted) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error(`media analysis aborted for ${cleanPath}`)
      );
      err.name = 'AbortError';
      err.code = 'ABORT_ERR';
      throw err;
    }

    try {
      return await withProcessingState({
        filePath: cleanPath,
        processingState: serviceIntegration?.processingState,
        logger,
        logPrefix: MEDIA_LOG_PREFIX,
        fn: async () => {
          const folderCategories = getFolderCategories(
            getCustomFolders,
            mapFoldersToCategories,
            logger
          );
          logger.info(
            `${MEDIA_LOG_PREFIX} Using ${folderCategories.length} smart folders for context:`,
            getFolderNamesString(folderCategories)
          );

          const analyzer = createMediaAnalyzerAdapter(
            /** @type {any} */ ({
              whisperService: safeGetWhisperService()
            })
          );
          const isCancelled = () => Boolean(abortSignal?.aborted);
          const result = await analyzer(cleanPath, folderCategories, { isCancelled, abortSignal });
          await applyUserNamingFromSettings(
            cleanPath,
            result,
            settingsService,
            logger,
            MEDIA_LOG_PREFIX,
            namingOverride
          );
          const duration = performance.now() - startTime;
          systemAnalytics?.recordProcessingTime?.(duration);
          systemAnalytics?.recordSuccess?.();

          const persistResult = await recordAnalysisResult({
            filePath: cleanPath,
            result,
            processingTime: duration,
            modelType: 'whisper',
            analysisHistory: serviceIntegration?.analysisHistory,
            logger
          });
          if (persistResult && !persistResult.persisted) {
            result._persistenceWarning = persistResult.reason || 'unknown';
          }
          recordPipelineOutcome(systemAnalytics, 'media', result);

          return result;
        }
      });
    } catch (error) {
      // Cancellation must propagate, not degrade into a persisted fallback
      // analysis the user never asked for.
      if (
        error?.code === 'OPERATION_CANCELLED' ||
        error?.code === 'ABORT_ERR' ||
        error?.name === 'AbortError'
      ) {
        throw error;
      }
      const errorContext = buildErrorContext({
        operation: 'media-analysis',
        filePath: cleanPath,
        error
      });
      logger.error(`${MEDIA_LOG_PREFIX} Media analysis failed with context:`, errorContext);
      systemAnalytics?.recordFailure?.(error);
      const fallback = createAnalysisFallback(cleanPath, 'media', error.message);
      await applyUserNamingFromSettings(
        cleanPath,
        fallback,
        settingsService,
        logger,
        MEDIA_LOG_PREFIX,
        namingOverride
      );
      try {
        await serviceIntegration?.processingState?.upsertReadyAnalysis?.(cleanPath, fallback);
      } catch (readyPersistError) {
        logger.debug(`${MEDIA_LOG_PREFIX} Failed to persist fallback ready entry`, {
          filePath: cleanPath,
          error: readyPersistError?.message
        });
      }
      recordPipelineOutcome(systemAnalytics, 'media', fallback);
      return fallback;
    }
  }

  const analyzeMediaHandler = createHandler({
    logger,
    context: 'Analysis',
    schema: analyzeFilePayloadSchema,
    handler: (event, payload) => {
      const { filePath, namingOverride } = normalizeAnalyzeFilePayload(payload);
      return performMediaAnalysis(filePath, event?.abortSignal, namingOverride);
    }
  });

  safeHandle(ipcMain, IPC_CHANNELS.ANALYSIS.ANALYZE_MEDIA, analyzeMediaHandler);

  const analyzeBatchHandler = createHandler({
    logger,
    context: 'Analysis',
    schema: analyzeBatchSchema,
    handler: async (event, payload) => {
      const serviceIntegration = getServiceIntegration?.();
      const startedAt = performance.now();

      const normalizedPayload = Array.isArray(payload) ? { filePaths: payload } : payload || {};
      const rawPaths = Array.isArray(normalizedPayload.filePaths)
        ? normalizedPayload.filePaths
        : [];
      const options = normalizedPayload.options || {};
      const namingOverride = options.namingSettings || null;
      const requestedBatchId =
        typeof normalizedPayload.batchId === 'string' ? normalizedPayload.batchId.trim() : '';
      const batchId = requestedBatchId || `analysis_${require('crypto').randomUUID()}`;

      if (rawPaths.length === 0) {
        return {
          success: true,
          results: [],
          errors: [],
          total: 0,
          batchId
        };
      }

      if (activeBatchRuns.has(batchId)) {
        const existing = activeBatchRuns.get(batchId);
        const STALE_BATCH_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
        const isStale =
          existing?.startedAt && Date.now() - existing.startedAt > STALE_BATCH_TIMEOUT_MS;
        if (isStale) {
          logger.warn(`${LOG_PREFIX} Evicting stale batch entry`, {
            batchId,
            startedAt: existing.startedAt,
            ageMs: Date.now() - existing.startedAt
          });
          activeBatchRuns.delete(batchId);
        } else {
          logger.warn(`${LOG_PREFIX} Duplicate active batch id rejected`, { batchId });
          return {
            success: false,
            error: `Batch already active: ${batchId}`,
            batchId
          };
        }
      }

      const pathValidation = await Promise.allSettled(
        rawPaths.map((/** @type {string} */ filePath) => validateAnalysisPath(filePath))
      );
      /** @type {string[]} */
      const validatedPaths = [];
      /** @type {Array<Record<string, any>>} */
      const validationErrors = [];
      /** @type {Array<Record<string, any>>} */
      const validationFailureResults = [];

      pathValidation.forEach((result, index) => {
        const originalPath = rawPaths[index];
        if (result.status === 'fulfilled') {
          validatedPaths.push(result.value);
          return;
        }

        const reasonMessage =
          result.reason && typeof result.reason.message === 'string'
            ? result.reason.message
            : 'Invalid file path provided';
        const validationError = {
          filePath: originalPath,
          error: reasonMessage,
          code: 'INVALID_PATH'
        };
        validationErrors.push(validationError);
        validationFailureResults.push({
          filePath: originalPath,
          success: false,
          error: reasonMessage,
          code: 'INVALID_PATH'
        });
      });

      if (validationErrors.length > 0) {
        logger.warn(`${LOG_PREFIX} Batch path validation failed for some files`, {
          batchId,
          invalidCount: validationErrors.length,
          totalCount: rawPaths.length
        });
      }

      if (validatedPaths.length === 0 || (options.stopOnError && validationErrors.length > 0)) {
        return {
          success: false,
          cancelled: false,
          results: validationFailureResults,
          errors: validationErrors,
          total: rawPaths.length,
          processed: 0,
          successful: 0,
          hasErrors: validationErrors.length > 0,
          batchId
        };
      }
      /** @type {any[]} */
      let folderCategories = [];
      if (
        Array.isArray(normalizedPayload.smartFolders) &&
        normalizedPayload.smartFolders.length > 0
      ) {
        try {
          folderCategories = mapFoldersToCategories(normalizedPayload.smartFolders);
        } catch (folderError) {
          logger.warn(`${LOG_PREFIX} Failed to normalize provided smart folders`, {
            error: folderError?.message
          });
        }
      }
      if (!Array.isArray(folderCategories) || folderCategories.length === 0) {
        folderCategories = getFolderCategories(getCustomFolders, mapFoldersToCategories, logger);
      }

      logger.info(`${LOG_PREFIX} Starting batch analysis`, {
        batchId,
        totalFiles: validatedPaths.length,
        folders: folderCategories.length,
        sectionOrder: options.sectionOrder || 'documents-first'
      });

      // Batch-scoped AbortController: every cancel path (renderer
      // CANCEL_BATCH, IPC abort signal, app shutdown) aborts it so in-flight
      // LLM/vision inference stops immediately instead of waiting for the
      // next cooperative isCancelled() poll.
      const batchAbortController = new AbortController();
      /** @type {Record<string, any>} */
      const runState = {
        batchId,
        cancelled: false,
        reason: null,
        requestedAt: null,
        startedAt: Date.now(),
        completionPromise: null,
        abortController: batchAbortController
      };
      activeBatchRuns.set(batchId, runState);

      // Bridge the ipcRegistry AbortSignal into runState.cancelled so a
      // preload-timeout or renderer cancel flips the cooperative cancel
      // flag the batch service already polls. This is strictly additive:
      // ANALYSIS.CANCEL_BATCH still works, and the signal path just gives
      // us a second, automatic trigger when the caller goes away.
      /** @type {(() => void) | null} */
      let removeAbortListener = null;
      const ipcAbortSignal = event?.abortSignal;
      if (ipcAbortSignal) {
        if (ipcAbortSignal.aborted) {
          runState.cancelled = true;
          runState.reason = runState.reason || 'ipc-abort-signal';
          runState.requestedAt = runState.requestedAt || Date.now();
          batchAbortController.abort();
        } else {
          const onAbort = () => {
            runState.cancelled = true;
            if (!runState.reason) {
              runState.reason = 'ipc-abort-signal';
              runState.requestedAt = Date.now();
            }
            batchAbortController.abort();
          };
          ipcAbortSignal.addEventListener('abort', onAbort, { once: true });
          removeAbortListener = () => ipcAbortSignal.removeEventListener?.('abort', onAbort);
        }
      }

      try {
        // BatchAnalysisService.analyzeFiles' JSDoc enumerates only a subset of
        // the options it consumes and elides successful/cancelled from its
        // return type; cast until that service opts in to checkjs.
        const batchPromise = /** @type {Promise<any>} */ (
          getBatchAnalysisService().analyzeFiles(
            validatedPaths,
            folderCategories,
            /** @type {any} */ ({
              batchId,
              isCancelled: () => runState.cancelled,
              abortSignal: batchAbortController.signal,
              concurrency: options.concurrency,
              autoConcurrency: options.autoConcurrency,
              stopOnError: options.stopOnError,
              sectionOrder: options.sectionOrder,
              enableVisionBatchMode: options.enableVisionBatchMode,
              onProgress: (/** @type {any} */ progress) => {
                if (typeof getMainWindow === 'function') {
                  sendOperationProgress(getMainWindow, {
                    type: 'batch_analyze',
                    batchId,
                    ...progress
                  });
                }
              },
              onFileComplete: (/** @type {any} */ item) => {
                const itemType = item?.type;
                const pipelineName =
                  itemType === 'image' ? 'image' : itemType === 'media' ? 'media' : 'document';
                // Per-file metric accounting. The batch wall-clock is logged
                // below but NOT recorded as a processing sample, otherwise an
                // N-file batch would count as a single ~Nx-long "file".
                if (item?.success) {
                  if (Number.isFinite(item?.durationMs)) {
                    systemAnalytics?.recordProcessingTime?.(item.durationMs);
                  }
                  systemAnalytics?.recordSuccess?.();
                  recordPipelineOutcome(systemAnalytics, pipelineName, item?.result);
                } else {
                  systemAnalytics?.recordFailure?.(new Error(item?.error || 'batch_item_failed'));
                  systemAnalytics?.recordPipelineOutcome?.(pipelineName, 'error', {
                    reason: item?.error || 'batch_item_failed'
                  });
                }
                // Stream this file's outcome to the renderer immediately so the
                // Discover UI shows it in "ready for review" and decrements the
                // in-progress counter without waiting for the whole batch invoke
                // to resolve. The final invoke return remains the authoritative
                // reconciliation pass (idempotent, merge-by-path in the store).
                //
                // Suppress once the run is cancelled: a file that resolves after
                // the user cancelled would otherwise stream a phantom result into
                // "ready for review" post-cancel (the renderer dedups it, but it
                // still flickers in). runState.cancelled is set by every cancel
                // path (shutdown, ipc-abort-signal, explicit CANCEL_BATCH).
                if (
                  !runState.cancelled &&
                  typeof getMainWindow === 'function' &&
                  typeof item?.filePath === 'string'
                ) {
                  sendFileComplete(getMainWindow, {
                    batchId,
                    item: {
                      filePath: item.filePath,
                      success: Boolean(item?.success),
                      result: item?.result ?? null,
                      // Schema requires a string; a non-string/Error here would
                      // fail strict validation and silently drop the whole event,
                      // stranding the file in "analyzing". Coerce, omit when absent.
                      error: item?.error != null ? String(item.error) : undefined,
                      // pipelineName is always one of image|media|document; raw
                      // item.type could be null and null fails z.string().optional().
                      type: pipelineName
                    }
                  });
                }
              },
              documentAnalyzer: async (
                /** @type {string} */ filePath,
                /** @type {any[]} */ smartFolders
              ) => {
                return withProcessingState({
                  filePath,
                  processingState: serviceIntegration?.processingState,
                  logger,
                  logPrefix: LOG_PREFIX,
                  fn: async () => {
                    const started = performance.now();
                    const result = await analyzeDocumentFile(filePath, smartFolders, {
                      abortSignal: batchAbortController.signal
                    });
                    await applyUserNamingFromSettings(
                      filePath,
                      result,
                      settingsService,
                      logger,
                      LOG_PREFIX,
                      namingOverride
                    );
                    const processingTime = performance.now() - started;
                    await recordAnalysisResult({
                      filePath,
                      result,
                      processingTime,
                      modelType: 'llm',
                      analysisHistory: serviceIntegration?.analysisHistory,
                      logger
                    });
                    return result;
                  }
                });
              },
              imageAnalyzer: async (
                /** @type {string} */ filePath,
                /** @type {any[]} */ smartFolders
              ) => {
                return withProcessingState({
                  filePath,
                  processingState: serviceIntegration?.processingState,
                  logger,
                  logPrefix: '[IPC-IMAGE-ANALYSIS]',
                  fn: async () => {
                    const started = performance.now();
                    const result = await analyzeImageFile(filePath, smartFolders, {
                      abortSignal: batchAbortController.signal
                    });
                    await applyUserNamingFromSettings(
                      filePath,
                      result,
                      settingsService,
                      logger,
                      '[IPC-IMAGE-ANALYSIS]',
                      namingOverride
                    );
                    const processingTime = performance.now() - started;
                    await recordAnalysisResult({
                      filePath,
                      result,
                      processingTime,
                      modelType: 'vision',
                      analysisHistory: serviceIntegration?.analysisHistory,
                      logger
                    });
                    return result;
                  }
                });
              },
              // Wrap the default media adapter so audio/video files honour the
              // user's naming convention exactly like document/image. Prior to
              // this fix the IPC layer passed `mediaAnalyzer: undefined`, so
              // BatchAnalysisService fell back to a bare `createMediaAnalyzerAdapter()`
              // that bypassed `applyUserNamingFromSettings` — confirmed
              // post-2.0.9 regression for batch audio/video runs.
              //
              // We don't apply naming inside the cancelled-skip return path
              // (the adapter returns null/undefined when whisper is missing
              // or analysis was cancelled) — applyUserNamingFromSettings is
              // a no-op on null/non-object results so this is safe.
              mediaAnalyzer: async (
                /** @type {string} */ filePath,
                /** @type {any[]} */ smartFolders,
                opts = {}
              ) => {
                return withProcessingState({
                  filePath,
                  processingState: serviceIntegration?.processingState,
                  logger,
                  logPrefix: '[IPC-MEDIA-ANALYSIS]',
                  fn: async () => {
                    const started = performance.now();
                    const adapter = createMediaAnalyzerAdapter(
                      /** @type {any} */ ({
                        whisperService: safeGetWhisperService()
                      })
                    );
                    const result = await adapter(filePath, smartFolders, {
                      ...opts,
                      abortSignal: batchAbortController.signal
                    });
                    await applyUserNamingFromSettings(
                      filePath,
                      result,
                      settingsService,
                      logger,
                      '[IPC-MEDIA-ANALYSIS]',
                      namingOverride
                    );
                    const processingTime = performance.now() - started;
                    await recordAnalysisResult({
                      filePath,
                      result,
                      processingTime,
                      modelType: 'media',
                      analysisHistory: serviceIntegration?.analysisHistory,
                      logger
                    });
                    return result;
                  }
                });
              }
            })
          )
        );
        runState.completionPromise = batchPromise.catch(
          /** @type {() => undefined} */ (() => undefined)
        );
        const batchResult = await batchPromise;

        // Whole-batch wall-clock is used for the completion log only.
        // Per-file processing samples are recorded in onFileComplete so the
        // diagnostics avg reflects per-file timing, not the batch duration.
        const duration = performance.now() - startedAt;

        logger.info(`${LOG_PREFIX} Batch analysis complete`, {
          batchId,
          cancelled: Boolean(batchResult?.cancelled),
          totalFiles: batchResult.total,
          successful: batchResult.successful,
          failed: batchResult.errors?.length || 0,
          durationMs: Math.round(duration)
        });

        const combinedErrors = [...validationErrors, ...(batchResult?.errors || [])];
        const combinedResults = [...validationFailureResults, ...(batchResult?.results || [])];
        const successfulCount = Number(batchResult?.successful) || 0;

        return {
          ...batchResult,
          success: Boolean(batchResult?.success) && validationErrors.length === 0,
          results: combinedResults,
          errors: combinedErrors,
          total: rawPaths.length,
          successful: successfulCount,
          hasErrors: combinedErrors.length > 0,
          batchId
        };
      } finally {
        removeAbortListener?.();
        activeBatchRuns.delete(batchId);
      }
    }
  });

  safeHandle(ipcMain, IPC_CHANNELS.ANALYSIS.ANALYZE_BATCH, analyzeBatchHandler);

  const cancelBatchHandler = createHandler({
    logger,
    context: 'Analysis',
    schema: cancelBatchSchema,
    handler: async (event, payload) => {
      const batchId = String(payload?.batchId || '').trim();
      const reason =
        typeof payload?.reason === 'string' && payload.reason.trim().length > 0
          ? payload.reason.trim()
          : 'Cancelled by renderer';
      const runState = activeBatchRuns.get(batchId);
      if (!runState) {
        logger.warn(`${LOG_PREFIX} Cancel request received for unknown batch`, { batchId });
        return { success: true, batchId, cancelled: false, notFound: true };
      }
      const wasCancelled = runState.cancelled;
      runState.cancelled = true;
      runState.reason = reason;
      runState.requestedAt = Date.now();
      runState.abortController?.abort();
      logger.info(`${LOG_PREFIX} Cancel request acknowledged`, { batchId, reason, wasCancelled });
      return {
        success: true,
        batchId,
        cancelled: true,
        alreadyCancelled: wasCancelled
      };
    }
  });

  safeHandle(ipcMain, IPC_CHANNELS.ANALYSIS.CANCEL_BATCH, cancelBatchHandler);

  const getReadyQueueHandler = createHandler({
    logger,
    context: 'Analysis',
    // Matches sibling system.js handlers: zero-payload IPCs use the
    // shared ipcVoidPayload schema so a malformed renderer call (an
    // unexpected argument smuggled through the preload bridge) is
    // rejected at the validation layer instead of silently accepted.
    schema: schemas?.ipcVoidPayload,
    handler: async () => {
      const serviceIntegration = getServiceIntegration?.();
      const processingState = serviceIntegration?.processingState;
      if (!processingState?.getReadyAnalyses) {
        return { success: true, readyFiles: [] };
      }
      try {
        await processingState.initialize?.();
        return {
          success: true,
          readyFiles: processingState.getReadyAnalyses({ limit: READY_QUEUE_HYDRATION_LIMIT })
        };
      } catch (error) {
        logger.error(`${LOG_PREFIX} Failed to load ready analysis queue`, {
          error: error?.message
        });
        return {
          success: false,
          readyFiles: [],
          error: error?.message || 'Failed to load ready analysis queue'
        };
      }
    }
  });

  safeHandle(ipcMain, IPC_CHANNELS.ANALYSIS.GET_READY_QUEUE, getReadyQueueHandler);

  const clearReadyQueueHandler = createHandler({
    logger,
    context: 'Analysis',
    schema: schemas?.ipcVoidPayload,
    handler: async () => {
      const serviceIntegration = getServiceIntegration?.();
      const processingState = serviceIntegration?.processingState;
      if (!processingState?.clearAllReadyAnalyses) {
        return { success: true, cleared: 0 };
      }
      try {
        const result = await processingState.clearAllReadyAnalyses();
        return { success: true, cleared: result.cleared ?? 0 };
      } catch (error) {
        logger.error(`${LOG_PREFIX} Failed to clear ready queue`, {
          error: error?.message
        });
        return {
          success: false,
          cleared: 0,
          error: error?.message || 'Failed to clear ready queue'
        };
      }
    }
  });

  safeHandle(ipcMain, IPC_CHANNELS.ANALYSIS.CLEAR_READY_QUEUE, clearReadyQueueHandler);

  /** @param {string} filePath */
  async function runOcr(filePath) {
    const cleanPath = await validateAnalysisPath(filePath);
    const start = performance.now();
    const ocrResult = await recognizeIfAvailable(null, cleanPath, {
      lang: 'eng',
      oem: 1,
      psm: 3
    });
    if (!ocrResult.success) {
      const error = ocrResult.cause || new Error(ocrResult.error || 'OCR failed');
      logger.error('OCR failed:', error);
      systemAnalytics?.recordFailure?.(error);
      return { success: false, error: ocrResult.error || error.message };
    }
    const duration = performance.now() - start;
    systemAnalytics?.recordProcessingTime?.(duration);
    systemAnalytics?.recordSuccess?.();
    return { success: true, text: ocrResult.text };
  }

  const extractImageTextHandler = createHandler({
    logger,
    context: 'Analysis',
    schema: stringSchema,
    handler: async (event, filePath) => {
      try {
        return await runOcr(filePath);
      } catch (error) {
        logger.error('OCR failed:', error);
        systemAnalytics?.recordFailure?.(error);
        return { success: false, error: error.message };
      }
    }
  });
  safeHandle(ipcMain, IPC_CHANNELS.ANALYSIS.EXTRACT_IMAGE_TEXT, extractImageTextHandler);
}

module.exports = registerAnalysisIpc;
module.exports.shutdownBatchAnalysisService = shutdownBatchAnalysisService;
