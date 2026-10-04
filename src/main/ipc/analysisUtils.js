// @ts-check
/**
 * Analysis Handler Utilities
 *
 * Shared utilities for analysis IPC handlers to reduce duplication.
 * Provides wrappers for processing state lifecycle, history recording,
 * error context building, and fallback responses.
 *
 * @module ipc/analysisUtils
 */

const path = require('path');
const { isFallbackAnalysis } = require('../../shared/analysisProvenance');
const fs = require('fs').promises;
const {
  normalizeError,
  normalizeText,
  normalizeOptionalText,
  normalizeKeywords
} = require('../../shared/normalization');
const { crossPlatformBasename } = require('../../shared/crossPlatformUtils');

/** @typedef {import('./ipcWrappers').LoggerLike} LoggerLike */

/**
 * Subset of the processing-state service used by {@link withProcessingState}.
 * @typedef {Object} ProcessingStateLike
 * @property {(filePath: string) => any} markAnalysisStart
 * @property {(filePath: string, result?: any) => any} [markAnalysisComplete]
 * @property {(filePath: string, message?: string) => any} markAnalysisError
 * @property {(filePath: string) => string|undefined} [getState]
 * @property {(filePath: string) => any} [clearState]
 */

// Lazy-loaded to avoid pulling in the heavy FolderMatchingService -> LlamaService
// -> VisionService chain at module-load time (breaks test mocks that mock fs).
// Falls back gracefully if the chain can't resolve (e.g., in test environments).
/** @type {((opts: Record<string, any>) => Record<string, any>)|null|undefined} */
let _createFallbackAnalysis;
function getFallbackFactory() {
  if (_createFallbackAnalysis === undefined) {
    try {
      _createFallbackAnalysis = require('../analysis/fallbackUtils').createFallbackAnalysis;
    } catch {
      _createFallbackAnalysis = null; // Mark as unavailable
    }
  }
  return _createFallbackAnalysis;
}

/**
 * Wrapper for processing state lifecycle management.
 * Handles markAnalysisStart, markAnalysisComplete/markAnalysisError, and cleanup.
 *
 * @param {Object} options - Options
 * @param {string} options.filePath - File being analyzed
 * @param {ProcessingStateLike|null|undefined} options.processingState - Processing state service (optional)
 * @param {LoggerLike} options.logger - Logger instance
 * @param {string} options.logPrefix - Prefix for log messages (e.g., '[IPC-ANALYSIS]')
 * @param {() => Promise<any>} options.fn - The analysis function to execute
 * @returns {Promise<*>} Result from the analysis function
 */
async function withProcessingState({ filePath, processingState, logger, logPrefix, fn }) {
  let analysisStarted = false;
  let stateHandled = false;

  try {
    // Mark analysis start
    if (processingState) {
      try {
        await processingState.markAnalysisStart(filePath);
        analysisStarted = true;
      } catch (stateError) {
        logger.warn(`${logPrefix} Failed to mark analysis start:`, stateError.message);
      }
    }

    // Execute the analysis
    const result = await fn();

    // Mark analysis complete on success
    if (processingState) {
      try {
        await processingState.markAnalysisComplete?.(filePath, result);
        stateHandled = true; // Mark state as handled to prevent cleanup race
      } catch (completeError) {
        logger.debug(`${logPrefix} Failed to mark analysis complete:`, completeError.message);
      }
    }

    return result;
  } catch (error) {
    // Mark analysis error
    if (processingState) {
      try {
        await processingState.markAnalysisError(filePath, error.message);
        stateHandled = true; // Mark state as handled to prevent cleanup race
      } catch (stateError) {
        logger.warn(`${logPrefix} Failed to mark analysis error:`, {
          filePath,
          error: stateError.message
        });
      }
    }
    throw error;
  } finally {
    // This prevents the race condition where cleanup runs after markAnalysisComplete
    if (analysisStarted && processingState && !stateHandled) {
      try {
        const currentState = processingState.getState?.(filePath);
        if (currentState === 'in_progress') {
          await processingState.clearState?.(filePath);
          logger.debug(`${logPrefix} Cleaned up orphaned processing state for:`, filePath);
        }
      } catch (cleanupError) {
        logger.warn(`${logPrefix} Failed to cleanup processing state:`, cleanupError.message);
      }
    }
  }
}

/**
 * Build standardized error context for logging.
 *
 * @param {Object} options - Options
 * @param {string} options.operation - Operation name (e.g., 'document-analysis')
 * @param {string} options.filePath - File path
 * @param {Error & { code?: string }} options.error - The error object
 * @returns {Record<string, any>} Error context for logging
 */
function buildErrorContext({ operation, filePath, error }) {
  return {
    operation,
    filePath,
    fileName: crossPlatformBasename(filePath),
    fileExtension: path.extname(filePath),
    timestamp: new Date().toISOString(),
    error: error.message,
    errorStack: error.stack,
    errorCode: error.code
  };
}

/**
 * Create a standardized fallback response for failed analysis.
 *
 * Delegates to {@link createFallbackAnalysis} from fallbackUtils for rich
 * filename-derived keywords/category, then overlays error metadata for
 * debugging and retry logic.
 *
 * @param {string} filePath - File path
 * @param {string} category - Default category ('documents' or 'images')
 * @param {string} errorMessage - Error message
 * @param {Object} [errorContext] - Additional error context (optional)
 * @param {string} [errorContext.errorType] - Type of error (e.g., 'NETWORK', 'TIMEOUT', 'MODEL_NOT_FOUND')
 * @param {boolean} [errorContext.isRetryable] - Whether the error is retryable
 * @param {string} [errorContext.code] - Error code if available
 * @returns {Record<string, any>} Fallback analysis result with error context
 */
function createAnalysisFallback(filePath, category, errorMessage, errorContext = {}) {
  const fileName = crossPlatformBasename(filePath);
  const fileExtension = path.extname(filePath);
  const isImage = category === 'images';
  const isMedia = category === 'media';

  // Overlay structured error metadata for debugging/retry decisions
  const normalized = normalizeError(
    { message: errorMessage, code: errorContext.code },
    {
      errorType: errorContext.errorType,
      isRetryable: errorContext.isRetryable
    }
  );

  // Try to get rich fallback (intelligent keywords, category matching, suggested name).
  // Falls back to minimal result if the analysis pipeline isn't loadable (e.g., test env).
  const factory = getFallbackFactory();
  if (factory) {
    const richFallback = factory({
      fileName,
      fileExtension,
      reason: errorMessage,
      confidence: 0,
      type: isImage ? 'image' : isMedia ? 'audio' : 'document',
      options: { error: errorMessage }
    });

    return {
      ...richFallback,
      error: normalized.message,
      errorType: normalized.errorType,
      isRetryable: normalized.isRetryable,
      errorCode: normalized.code,
      suggestedName: richFallback.suggestedName || fileName
    };
  }

  // Minimal fallback when the rich factory is unavailable
  return {
    error: normalized.message,
    errorType: normalized.errorType,
    isRetryable: normalized.isRetryable,
    errorCode: normalized.code,
    suggestedName: fileName,
    category,
    keywords: [],
    confidence: 0
  };
}

/**
 * Normalize analysis result and record to history.
 *
 * @param {Object} options - Options
 * @param {string} options.filePath - File path
 * @param {Record<string, any>} options.result - Raw analysis result
 * @param {number} options.processingTime - Processing time in ms
 * @param {string} options.modelType - Model type ('llm' or 'vision')
 * @param {{ recordAnalysis: (fileInfo: any, normalized: any) => Promise<any> }|null|undefined} options.analysisHistory - Analysis history service (optional)
 * @param {LoggerLike} options.logger - Logger instance
 * @param {import('fs').Stats|null} [options.fileStats] - Pre-captured file stats (file may have moved since analysis)
 * @returns {Promise<{ persisted: boolean, reason?: string }>}
 */
async function recordAnalysisResult({
  filePath,
  result,
  processingTime,
  modelType,
  analysisHistory,
  logger,
  fileStats
}) {
  if (!analysisHistory) return { persisted: false, reason: 'no_history_service' };

  try {
    // Prefer pre-captured stats (file may have been moved since analysis)
    const stats = fileStats || (await fs.stat(filePath));
    /** @type {{ path: string, size: number, lastModified: number, mimeType: string|null }} */
    const fileInfo = {
      path: filePath,
      size: stats.size,
      lastModified: stats.mtimeMs,
      mimeType: null
    };

    // Provenance (F-195): a fallback-only result is stored as PROVISIONAL and
    // spends one unit of its retry budget each time a fallback replaces a
    // provisional entry for the same path; a real analysis resets both.
    const provisional = isFallbackAnalysis(result);
    let provisionalRetries = 0;
    const historyWithLookup = /** @type {any} */ (analysisHistory);
    if (provisional && typeof historyWithLookup.getAnalysisByPath === 'function') {
      try {
        const prior = await historyWithLookup.getAnalysisByPath(filePath);
        if (prior?.analysis?.provisional === true) {
          provisionalRetries = (Number(prior.analysis.provisionalRetries) || 0) + 1;
        }
      } catch {
        // Non-fatal: treat as first attempt.
      }
    }

    // Include all LLM-extracted fields for richer context in chat/queries
    const normalized = {
      provisional,
      provisionalRetries,
      fallbackReason: provisional
        ? normalizeOptionalText(result.fallbackReason || null, { maxLength: 200 })
        : null,
      subject: normalizeText(result.subject || result.suggestedName || path.basename(filePath), {
        maxLength: 255
      }),
      category: normalizeText(result.category || 'uncategorized', { maxLength: 100 }),
      tags: normalizeKeywords(Array.isArray(result.keywords) ? result.keywords : []),
      confidence: typeof result.confidence === 'number' ? result.confidence : 0,
      // Combine purpose and summary for comprehensive context
      summary: normalizeOptionalText(result.summary || result.purpose || result.description || '', {
        maxLength: 2000
      }),
      // Store full extracted text for conversation context (increased limit)
      extractedText: normalizeOptionalText(result.extractedText || '', { maxLength: 50000 }),
      model: normalizeText(result.model || modelType, { maxLength: 100 }),
      processingTime,
      smartFolder: normalizeOptionalText(result.smartFolder || null, { maxLength: 255 }),
      newName: normalizeOptionalText(result.suggestedName || null, { maxLength: 255 }),
      renamed: Boolean(result.suggestedName),
      // Embedding preference/state (staged pipeline)
      embeddingPolicy: normalizeOptionalText(result.embeddingPolicy || null, { maxLength: 20 }),
      embeddingStatus: normalizeOptionalText(result.embeddingStatus || null, { maxLength: 20 }),
      // Additional fields for richer document/image context
      documentType: normalizeOptionalText(result.documentType || result.type || null, {
        maxLength: 100
      }),
      entity: normalizeOptionalText(result.entity || null, { maxLength: 255 }),
      project: normalizeOptionalText(result.project || null, { maxLength: 255 }),
      purpose: normalizeOptionalText(result.purpose || null, { maxLength: 1000 }),
      reasoning: normalizeOptionalText(result.reasoning || null, { maxLength: 500 }),
      documentDate: normalizeOptionalText(result.documentDate || result.date || null, {
        maxLength: 50
      }),
      // Key entities for conversation (people, organizations, dates mentioned)
      keyEntities: Array.isArray(result.keyEntities)
        ? result.keyEntities.slice(0, 20).map((e) => normalizeText(e, { maxLength: 100 }))
        : [],
      // Store extraction method for debugging
      extractionMethod: normalizeOptionalText(result.extractionMethod || null, { maxLength: 50 }),
      // Image-specific fields
      content_type: normalizeOptionalText(result.content_type || null, { maxLength: 100 }),
      has_text: typeof result.has_text === 'boolean' ? result.has_text : null,
      colors: Array.isArray(result.colors) ? result.colors.slice(0, 10) : null,
      // Media-specific fields (audio/video). analyzeMediaFile produces all of
      // these and AnalysisDetails.jsx reads them when surfacing history; before
      // this addition they were silently dropped at persistence so reopening a
      // history entry showed an empty Duration / Language / Transcript while
      // the fresh-analysis view (which doesn't go through history) showed them
      // correctly. Apply the same normalization caps used for other long-text
      // fields above to keep the analysis history row size bounded.
      transcript: normalizeOptionalText(result.transcript || null, { maxLength: 50000 }),
      transcriptSegments: Array.isArray(result.transcriptSegments)
        ? result.transcriptSegments.slice(0, 1000)
        : null,
      // Record when the cap actually dropped cues (roughly >1-2h of speech):
      // transcript export reads only this history row, and without the flag a
      // VTT/SRT that silently ended mid-media was indistinguishable from a
      // complete one. Omitted (not false) when nothing was dropped.
      ...(Array.isArray(result.transcriptSegments) && result.transcriptSegments.length > 1000
        ? { transcriptSegmentsTruncated: true }
        : {}),
      durationSeconds:
        typeof result.durationSeconds === 'number' && Number.isFinite(result.durationSeconds)
          ? result.durationSeconds
          : null,
      detectedLanguage: normalizeOptionalText(result.detectedLanguage || null, { maxLength: 16 }),
      keyframes: Array.isArray(result.keyframes) ? result.keyframes.slice(0, 50) : null,
      mediaKind: normalizeOptionalText(result.mediaKind || null, { maxLength: 16 })
    };

    // WRITE_LOCK_TIMEOUT retry: AnalysisHistoryService rejects writes
    // when it can't acquire its write lock in time (post-2.0.9 hardening
    // to prevent the v2 "race-with-the-holder, corrupt the blob" path).
    // Bulk imports can legitimately produce contention, and a single
    // best-effort retry recovers most cases without giving up on the
    // analysis we just paid LLM tokens to compute. Backoff is short so
    // the retry doesn't measurably extend per-file latency in the happy
    // path. Subsequent failure falls through to the existing logging
    // branch — analysis result still lands in the ready queue, so the
    // file remains organizable; only the durable history miss.
    try {
      await analysisHistory.recordAnalysis(fileInfo, normalized);
    } catch (firstWriteErr) {
      const code = firstWriteErr?.code || firstWriteErr?.name;
      if (code === 'WRITE_LOCK_TIMEOUT') {
        logger.debug?.('[ANALYSIS-HISTORY] Write lock contention, retrying once', {
          filePath
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        await analysisHistory.recordAnalysis(fileInfo, normalized);
      } else {
        throw firstWriteErr;
      }
    }
    // Newly recorded analyses must become searchable without waiting for the
    // BM25 staleness timer; mark the index stale so the next search rebuilds.
    try {
      const { getSearchServiceInstance } = require('./semantic');
      getSearchServiceInstance()?.invalidateIndex({ reason: 'analysis-recorded' });
    } catch {
      // Search invalidation is best-effort; the staleness timer still applies.
    }
    return { persisted: true };
  } catch (historyError) {
    // error (not warn): the analysis itself succeeded — file content was
    // processed, tokens were spent — but the result didn't land in the
    // history. Downstream chat/search can't find this file. Most callers
    // ignore the returned `{ persisted: false, reason }` envelope, so the
    // log line is the only signal an operator has to diagnose "why isn't
    // this file showing up in chat?".
    logger.error('[ANALYSIS-HISTORY] Failed to record analysis:', {
      filePath,
      error: historyError.message
    });
    return { persisted: false, reason: historyError.message };
  }
}

/**
 * Get folder categories from custom folders function.
 *
 * @param {() => any[]} getCustomFolders - Function to get custom folders
 * @param {(folders: any[]) => any[]} mapFoldersToCategories - Function to map folders to categories
 * @param {LoggerLike} logger - Logger instance
 * @returns {any[]} Folder categories
 */
function getFolderCategories(getCustomFolders, mapFoldersToCategories, logger) {
  let folders = [];
  try {
    folders = typeof getCustomFolders === 'function' ? getCustomFolders() : [];
  } catch (folderError) {
    logger.warn('[ANALYSIS] Failed to get custom folders:', folderError.message);
  }
  return mapFoldersToCategories(folders);
}

module.exports = {
  withProcessingState,
  buildErrorContext,
  createAnalysisFallback,
  recordAnalysisResult,
  getFolderCategories
};
