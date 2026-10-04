// @ts-check
/** @typedef {import('../../shared/analysisSchema').AnalysisResult} AnalysisResult */
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const {
  SUPPORTED_TEXT_EXTENSIONS,
  SUPPORTED_DOCUMENT_EXTENSIONS,
  SUPPORTED_ARCHIVE_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS,
  SUPPORTED_3D_EXTENSIONS,
  SUPPORTED_DESIGN_EXTENSIONS,
  AI_DEFAULTS,
  DEFAULT_AI_MODELS,
  FILE_SIZE_LIMITS,
  LIMITS
} = require('../../shared/constants');
const { TRUNCATION, TIMEOUTS } = require('../../shared/performanceConstants');
const { withTimeout, delay } = require('../../shared/promiseUtils');
const { createLogger } = require('../../shared/logger');
const { getTextModel, getLlamaService } = require('../llamaUtils');
const { AppConfig } = require('./documentLlm');

// Enforce required dependency for AI-first operation
const {
  extractTextFromPdf,
  ocrPdfIfNeeded,
  isEncryptedPdfError,
  extractTextFromDoc,
  extractTextFromDocx,
  extractTextFromCsv,
  extractTextFromXlsx,
  extractTextFromPptx,
  extractTextFromXls,
  extractTextFromPpt,
  extractTextFromOdfZip,
  extractTextFromEpub,
  extractTextFromEml,
  extractTextFromMsg,
  extractTextFromKml,
  extractTextFromKmz,
  extractPlainTextFromRtf,
  extractPlainTextFromXml,
  extractPlainTextFromHtml,
  readTextFileWithEncoding
} = require('./documentExtractors');
const { analyzeTextWithLlama, normalizeCategoryToSmartFolders } = require('./documentLlm');
const { getAnalysisLimits } = require('./analysisLimits');
const { normalizeAnalysisResult } = require('./utils');
const { normalizeExtractedTextForStorage } = require('./analysisTextUtils');
const {
  getIntelligentCategory,
  getIntelligentKeywords,
  safeSuggestedName,
  createFallbackAnalysis
} = require('./fallbackUtils');
const { analysisQueue } = require('./embeddingQueue/stageQueues');
const { globalDeduplicator } = require('../utils/llmOptimization');
const {
  applySemanticFolderMatching: applyUnifiedFolderMatching
} = require('./semanticFolderMatcher');
const { fetchNamingContextFromBm25 } = require('./namingContextBm25');
const { container, ServiceIds } = require('../services/ServiceContainer');
const { LRUCache } = require('../../shared/LRUCache');

// Cache configuration constants
const CACHE_CONFIG = {
  MAX_FILE_CACHE: 500, // Maximum number of files to cache in memory
  FALLBACK_CONFIDENCE: 65, // Confidence score for fallback analysis
  DEFAULT_CONFIDENCE: 85, // Default confidence for successful analysis
  CACHE_TTL_MS: 30 * 60 * 1000 // 30 minute TTL to prevent memory leaks
};
const ANALYSIS_SIGNATURE_VERSION = 'v2';

// Office extraction is retried once only for OS-level contention (AV scanner
// holding a freshly copied file, descriptor exhaustion). Parse failures and
// timeouts are deterministic — retrying them just doubles the OCR bill.
const TRANSIENT_OFFICE_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'EAGAIN', 'EMFILE', 'ENFILE']);

/**
 * @param {any} err
 * @returns {boolean}
 */
function isTransientOfficeError(err) {
  return (
    TRANSIENT_OFFICE_ERROR_CODES.has(err?.code) ||
    TRANSIENT_OFFICE_ERROR_CODES.has(err?.osCode) ||
    TRANSIENT_OFFICE_ERROR_CODES.has(err?.cause?.code)
  );
}

/**
 * User cancellation surfaces either as an AbortError (throwIfAborted / DOM
 * AbortSignal) or as OPERATION_CANCELLED (withAbortableTimeout). It must
 * propagate untouched: wrapping it as a processing failure or downgrading to
 * the filename fallback would rerun work the user just cancelled.
 * @param {any} err
 * @returns {boolean}
 */
function isCancellationError(err) {
  return err?.name === 'AbortError' || err?.code === 'OPERATION_CANCELLED';
}

const fileAnalysisCache = new LRUCache({
  maxSize: CACHE_CONFIG.MAX_FILE_CACHE,
  ttlMs: CACHE_CONFIG.CACHE_TTL_MS,
  lruStrategy: 'insertion', // FIFO-style for file analysis cache
  name: 'FileAnalysisCache'
});

/**
 * Get cached value if exists and not expired
 * @param {string} signature - Cache key
 * @returns {Object|null} Cached value or null if expired/missing
 */
function getFileCache(signature) {
  if (!signature) return null;
  return fileAnalysisCache.get(signature);
}

/**
 * Set cache value with automatic TTL and LRU eviction
 * @param {string} signature - Cache key
 * @param {Object} value - Value to cache
 */
function setFileCache(signature, value) {
  if (!signature) return;
  fileAnalysisCache.set(signature, value);
}

/**
 * Cache result only if file remains unchanged, and evict if it changes immediately after.
 * @param {string} signature
 * @param {string} filePath
 * @param {import('fs').Stats | null} fileStats
 * @param {any} value
 * @returns {Promise<boolean>} whether the cache was written and retained
 */
async function setFileCacheIfUnchanged(signature, filePath, fileStats, value) {
  if (!signature) return false;
  if (!filePath || !fileStats) return false;
  try {
    // Single stat before write to confirm file is unchanged
    const beforeStats = await fs.stat(filePath);
    if (
      beforeStats.size !== fileStats.size ||
      Number(beforeStats.mtimeMs) !== Number(fileStats.mtimeMs)
    ) {
      return false;
    }
    setFileCache(signature, value);
    // Single stat after write to detect concurrent modification
    const afterStats = await fs.stat(filePath);
    if (
      afterStats.size !== fileStats.size ||
      Number(afterStats.mtimeMs) !== Number(fileStats.mtimeMs)
    ) {
      fileAnalysisCache.delete(signature);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
// Import error handling system
const { AnalysisError, FileProcessingError } = require('../errors/AnalysisError');
const { resolveProviderIdFromRouter, stampAnalysisProvider } = require('./providerStamp');

// Set logger context for this module
const logger = createLogger('DocumentAnalysis');

/**
 * Router-mediated wrapper around analyzeTextWithLlama.
 *
 * Checks whether the AIRouter has a cloud provider selected; if so, the routing
 * happens transparently inside documentLlm.js (via _getRouterInferenceBackend).
 * This wrapper adds router-level observability (logging, error surfacing) and
 * falls back to a direct analyzeTextWithLlama call when the router is unavailable
 * or throws — ensuring local-only users see zero behavior change.
 *
 * @param {string} textContent      Extracted document text
 * @param {string} fileName         Original filename (for prompts + logging)
 * @param {any[]}  smartFolders     Smart folder configurations
 * @param {string|null} fileDate    ISO date string for the file
 * @param {any[]}  namingContext    BM25 naming hints
 * @param {Record<string, any>} options          Options forwarded to analyzeTextWithLlama
 * @param {string|null} smartFolderId  Per-folder routing override (null = global default)
 * @returns {Promise<AnalysisResult>}       Analysis result object
 */
async function _analyzeWithProvider(
  textContent,
  fileName,
  smartFolders,
  fileDate,
  namingContext,
  options = {},
  smartFolderId = null
) {
  let routerAvailable = false;
  let router = null;
  try {
    // Lazy require to avoid module-load-time side effects and circular dependency
    // (aiProvider requires services tree; services require analysisQueue; etc.).

    const aiProvider = require('../ipc/aiProvider');
    router = aiProvider.getActiveAiRouter ? aiProvider.getActiveAiRouter() : null;
    if (router) {
      routerAvailable = true;
    }
  } catch {
    // Router not yet initialized — proceed with direct call
  }

  try {
    // documentLlm.js transparently routes to the cloud provider when one is active,
    // so we always call analyzeTextWithLlama; the routing decision happens inside it.
    const result = await analyzeTextWithLlama(
      textContent,
      fileName,
      smartFolders,
      fileDate,
      namingContext,
      {
        ...options,
        smartFolderId
      }
    );
    const providerId = result?.provider || resolveProviderIdFromRouter(router, smartFolderId);
    return stampAnalysisProvider(result, providerId);
  } catch (err) {
    // User cancellation must never trigger the local fallback — rerunning the
    // full analysis the user just cancelled defeats the cancel.
    if (isCancellationError(err)) {
      throw err;
    }
    // Surface user-visible cloud failures rather than silently downgrading
    // to local. AUTH_FAILED / BUDGET_EXCEEDED / RATE_LIMITED / CONTENT_TOO_LONG
    // / PROVIDER_DISABLED / CONSENT_REQUIRED all reflect deliberate user
    // configuration or quota state — masking them as a successful local
    // analysis hides the real problem (and in the case of BUDGET_EXCEEDED
    // would let cap-blocked routing silently proceed against a different
    // provider). Only fall back on transient-class errors.
    const FATAL_CODES = new Set([
      'AUTH_FAILED',
      'BUDGET_EXCEEDED',
      'RATE_LIMITED',
      'CONTENT_TOO_LONG',
      'PROVIDER_DISABLED',
      'CONSENT_REQUIRED',
      'NO_PROVIDER_READY'
    ]);
    if (routerAvailable && err && err.code && FATAL_CODES.has(err.code)) {
      logger.warn('[ai] router-mediated analyze failed with fatal code; not falling back', {
        error: err.message,
        code: err.code
      });
      throw err;
    }
    if (routerAvailable) {
      logger.warn('[ai] router-mediated analyze failed; falling back to direct llamaService', {
        error: err.message,
        code: err.code
      });
    }
    // Final fallback: re-invoke without router hint (documentLlm will use local llama)
    const fallback = await analyzeTextWithLlama(
      textContent,
      fileName,
      smartFolders,
      fileDate,
      namingContext,
      { ...options, smartFolderId: null }
    );
    return stampAnalysisProvider(fallback, 'local');
  }
}

/** @param {any} error */
function isPdfNoTextError(error) {
  if (error?.code === 'PDF_NO_TEXT_CONTENT') return true;
  const message = String(error?.message || '').toLowerCase();
  return message.includes('no extractable text') || message.includes('no text content');
}
/**
 * Analyzes a document file using AI or fallback methods
 * @param {string} filePath - Path to the document file
 * @param {any[]} smartFolders - Array of smart folder configurations
 * @param {{ bypassCache?: boolean, smartFolderId?: string | null, isCancelled?: () => boolean, abortSignal?: AbortSignal }} [options]
 * @returns {Promise<AnalysisResult>} Analysis result with metadata
 */
async function analyzeDocumentFile(filePath, smartFolders = [], options = {}) {
  logger.info('Analyzing document file', { path: filePath });
  const bypassCache = Boolean(options?.bypassCache);
  // smartFolderId is optional — callers that have pre-classified the file into a
  // smart folder (e.g. manual reanalysis from the folder view) can pass it so the
  // per-folder routing override (ai.routing.perFolder[id]) applies. Ad-hoc batch
  // analysis where the AI itself picks the folder leaves this null and uses the
  // default route.
  const smartFolderId = typeof options?.smartFolderId === 'string' ? options.smartFolderId : null;
  const fileExtension = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);
  const smartFolderSig = Array.isArray(smartFolders)
    ? smartFolders
        .map((f) => {
          const name = typeof f?.name === 'string' ? f.name.trim() : '';
          const description = typeof f?.description === 'string' ? f.description.trim() : '';
          if (!name && !description) return '';
          return `${name}:${description}`;
        })
        .filter(Boolean)
        .sort()
        .join('|')
    : '';

  // Determine model in advance for cache signatures and deduplication
  const defaultTextModel =
    (AppConfig &&
      AppConfig.ai &&
      AppConfig.ai.textAnalysis &&
      AppConfig.ai.textAnalysis.defaultModel) ||
    (AI_DEFAULTS && AI_DEFAULTS.TEXT && AI_DEFAULTS.TEXT.MODEL) ||
    DEFAULT_AI_MODELS.TEXT_ANALYSIS;

  let modelName = defaultTextModel;
  try {
    const llamaService = getLlamaService();
    if (llamaService && typeof llamaService.getConfig === 'function') {
      const cfg = await llamaService.getConfig();
      modelName = cfg?.textModel || cfg?.selectedTextModel || defaultTextModel;
    } else {
      modelName = getTextModel() || defaultTextModel;
    }
  } catch (err) {
    logger.debug('Failed to load llama config for signature, using default', {
      error: err.message
    });
  }

  // Step 1: Attempt to compute file signature and check cache (non-fatal if fails)
  let fileSignature = null;
  let fileStats = null;
  try {
    fileStats = await fs.stat(filePath);
    fileSignature = `${ANALYSIS_SIGNATURE_VERSION}|${modelName}|${smartFolderSig}|${filePath}|${fileStats.size}|${fileStats.mtimeMs}`;
    if (!bypassCache) {
      const cachedResult = getFileCache(fileSignature);
      if (cachedResult) {
        return cachedResult;
      }
      logger.debug('Cache miss, analyzing', { path: filePath });
    } else {
      logger.debug('Bypassing analysis cache for reanalysis', { path: filePath });
    }
  } catch (statError) {
    // Non-fatal: proceed without cache if stats fail
    logger.debug('Could not stat file for caching, proceeding with analysis', {
      path: filePath,
      error: statError.message
    });
  }

  // Get file date from stats or default to today
  // Some test fixtures (and some fs polyfills) may not provide a Date-valued mtime.
  const fileDate = (() => {
    const today = new Date().toISOString().split('T')[0];
    if (!fileStats) return today;

    // Prefer Date-valued mtime when available
    const { mtime } = fileStats;
    if (mtime && typeof mtime.toISOString === 'function') {
      return mtime.toISOString().split('T')[0];
    }

    // Fall back to numeric mtimeMs when present
    const { mtimeMs } = fileStats;
    if (typeof mtimeMs === 'number' && Number.isFinite(mtimeMs) && mtimeMs > 0) {
      return new Date(mtimeMs).toISOString().split('T')[0];
    }

    return today;
  })();

  // FAST SEMANTIC LABELING (Short-circuit)
  // Skip AI analysis for video files and use extension-based fallback immediately
  if ((SUPPORTED_VIDEO_EXTENSIONS || []).includes(fileExtension)) {
    const intelligentCategory = getIntelligentCategory(fileName, fileExtension, smartFolders);
    const intelligentKeywords = getIntelligentKeywords(fileName, fileExtension);
    const safeCategory = intelligentCategory || 'video';

    return {
      purpose: 'Video file',
      project: path.basename(fileName, fileExtension),
      category: safeCategory,
      date: fileDate,
      keywords: intelligentKeywords,
      confidence: 80, // High confidence for known types
      suggestedName: safeSuggestedName(fileName, fileExtension),
      extractionMethod: 'extension_short_circuit'
    };
  }

  // Step 2: Main content extraction and analysis (errors handled separately)
  try {
    /** @type {string | null} */
    let extractedText = null;
    /** True when only the head of an oversize text file was read. */
    let partialTextRead = false;
    let pdfNoTextFallback = false;
    /** @type {any} */
    let pdfOriginalError = null;

    if (fileExtension === '.pdf') {
      try {
        extractedText = await extractTextFromPdf(filePath, fileName, {
          signal: options?.abortSignal
        });

        if (!extractedText || extractedText.trim().length === 0) {
          const ocrText = await ocrPdfIfNeeded(filePath, { signal: options?.abortSignal });
          extractedText = ocrText || '';
        }
      } catch (pdfError) {
        if (isCancellationError(pdfError)) throw pdfError;
        // Encrypted PDFs can't be unlocked here, and rasterization-based OCR
        // also fails on encrypted streams. Short-circuit with a named error
        // so the user sees "this PDF is password-protected" instead of the
        // silent-empty-text path that ends in a failed analysis.
        if (typeof isEncryptedPdfError === 'function' && isEncryptedPdfError(pdfError)) {
          logger.warn('[PDF] Encrypted PDF cannot be analyzed', { fileName });
          throw new FileProcessingError('PDF_ENCRYPTED', fileName, {
            originalError: pdfError?.message || 'PDF is password-protected',
            suggestion: 'PDF is password-protected. Decrypt the file before analysis.'
          });
        }
        pdfOriginalError = pdfError?.message || 'Unknown PDF extraction error';
        pdfNoTextFallback = isPdfNoTextError(pdfError);
        // A thin text layer (a scanner's one-line footer) rides on the
        // no-text error; it is kept only if OCR produces nothing longer.
        const thinTextLayer =
          typeof pdfError?.metadata?.textLayer === 'string' ? pdfError.metadata.textLayer : '';
        if (pdfNoTextFallback) {
          logger.info(`[PDF] No extractable text from parser, attempting OCR fallback`, {
            fileName
          });
        } else {
          logger.error(`Error parsing PDF`, {
            fileName,
            error: pdfOriginalError
          });
        }
        try {
          const ocrText = await ocrPdfIfNeeded(filePath, { signal: options?.abortSignal });
          if (ocrText && ocrText.trim().length > thinTextLayer.trim().length) {
            extractedText = ocrText;
          } else if (pdfNoTextFallback) {
            extractedText = thinTextLayer;
          } else {
            throw new FileProcessingError('PDF_PROCESSING_FAILURE', fileName, {
              originalError: pdfOriginalError,
              suggestion: 'PDF may be corrupted, password-protected, or image-based'
            });
          }
        } catch (ocrError) {
          if (isCancellationError(ocrError)) throw ocrError;
          if (pdfNoTextFallback) {
            logger.warn(`[PDF] OCR fallback failed for no-text PDF`, {
              fileName,
              error: ocrError?.message || 'unknown OCR error'
            });
            extractedText = thinTextLayer;
          } else {
            throw new FileProcessingError('PDF_PROCESSING_FAILURE', fileName, {
              originalError: pdfOriginalError,
              suggestion: 'PDF may be corrupted, password-protected, or image-based'
            });
          }
        }
      }
    } else if (SUPPORTED_TEXT_EXTENSIONS.includes(fileExtension)) {
      // Guard against reading extremely large text files into memory. Honors the
      // user-configurable maxTextFileSize setting (falls back to the packaged
      // 50MB default via getAnalysisLimits when settings are unavailable).
      const { maxTextFileSize: maxText = FILE_SIZE_LIMITS.MAX_TEXT_FILE_SIZE } =
        /** @type {{ maxTextFileSize?: number }} */ (await getAnalysisLimits().catch(() => ({})));
      // The cache-signature stat above is best-effort; the size guard is not.
      // readTextFileWithEncoding has no cap of its own, so fail closed when
      // the size cannot be established rather than reading blind.
      let textStats = fileStats;
      if (!textStats) {
        try {
          textStats = await fs.stat(filePath);
        } catch (statError) {
          throw new FileProcessingError('FILE_READ_ERROR', fileName, {
            originalError: statError.message,
            osCode: statError.code,
            suggestion: 'Could not determine file size before reading',
            cause: statError
          });
        }
      }
      /** @type {number | null} */
      let textReadLimit = null;
      if (textStats.size > maxText) {
        // The streaming reader for oversize text files was dead code and was
        // deleted in 2026-09; such files then fell to the filename fallback.
        // Read the first maxText bytes instead and say so in the result.
        textReadLimit = maxText;
        partialTextRead = true;
        logger.warn('[TEXT] File exceeds the text size limit; analyzing the first part only', {
          fileName,
          fileSize: textStats.size,
          maxBytes: maxText
        });
      }
      try {
        if (fileExtension === '.csv') {
          extractedText = await withTimeout(
            extractTextFromCsv(filePath),
            TIMEOUTS.FILE_READ || 10000,
            'CSV extraction'
          );
        } else if (fileExtension === '.xml') {
          const raw = textReadLimit
            ? await readTextFileWithEncoding(filePath, { maxBytes: textReadLimit })
            : await readTextFileWithEncoding(filePath);
          extractedText = await extractPlainTextFromXml(raw);
        } else {
          // BOM/UTF-16 aware read: a bare utf8 decode of UTF-16 text yields
          // NUL-riddled garbage that poisons the LLM prompt and the index.
          const raw = textReadLimit
            ? await readTextFileWithEncoding(filePath, { maxBytes: textReadLimit })
            : await readTextFileWithEncoding(filePath);
          if (fileExtension === '.rtf') {
            extractedText = await extractPlainTextFromRtf(raw);
          } else if (fileExtension === '.html' || fileExtension === '.htm') {
            extractedText = await extractPlainTextFromHtml(raw);
          } else {
            extractedText = raw;
          }
        }

        if (!extractedText || extractedText.trim().length === 0) {
          throw new FileProcessingError('FILE_EMPTY', fileName, {
            suggestion: 'File appears to be empty or unreadable'
          });
        }

        logger.debug(`Extracted characters from text file`, {
          fileName,
          length: extractedText.length
        });
      } catch (textError) {
        // Operational AnalysisErrors (e.g. FILE_EMPTY) already carry a precise
        // code + message. Rethrow them as-is so the real reason survives instead
        // of being flattened into a generic "corrupted or access denied" wrap.
        // Empty files are expected and recoverable (filename fallback applies),
        // so log them at warn rather than error.
        if (textError instanceof AnalysisError) {
          logger.warn(`Could not extract text file content`, {
            fileName,
            code: textError.code,
            error: textError.message
          });
          throw textError;
        }

        // Genuine read/timeout failure: preserve the underlying cause and the
        // OS-level error code (ENOENT/EACCES/...) for diagnosis.
        logger.error(`Error reading text file`, {
          fileName,
          osCode: textError.code,
          error: textError.message
        });
        throw new FileProcessingError('FILE_READ_ERROR', fileName, {
          originalError: textError.message,
          osCode: textError.code,
          cause: textError
        });
      }
    } else if (SUPPORTED_DOCUMENT_EXTENSIONS.includes(fileExtension)) {
      // Extract content from extended document set (office/odf/eml/msg/kml)
      const signal = options?.abortSignal;
      const extractOfficeContent = async () => {
        if (fileExtension === '.doc') return extractTextFromDoc(filePath);
        if (fileExtension === '.docx') return extractTextFromDocx(filePath, { signal });
        if (fileExtension === '.xlsx') return extractTextFromXlsx(filePath);
        if (fileExtension === '.pptx') return extractTextFromPptx(filePath, { signal });
        if (fileExtension === '.xls') return extractTextFromXls(filePath);
        if (fileExtension === '.ppt') return extractTextFromPpt(filePath);
        if (fileExtension === '.odt' || fileExtension === '.ods' || fileExtension === '.odp')
          return extractTextFromOdfZip(filePath);
        if (fileExtension === '.epub') return extractTextFromEpub(filePath);
        if (fileExtension === '.eml') return extractTextFromEml(filePath);
        if (fileExtension === '.msg') return extractTextFromMsg(filePath);
        if (fileExtension === '.kml') return extractTextFromKml(filePath);
        if (fileExtension === '.kmz') return extractTextFromKmz(filePath);
        if (fileExtension === '.ipynb') {
          const { extractTextFromIpynb } = require('./extractors/notebookExtractor');
          return extractTextFromIpynb(filePath);
        }
        return '';
      };

      const logExtraction = () =>
        logger.info(`Extracting content from document`, {
          fileName,
          fileExtension
        });

      try {
        logExtraction();
        // to avoid killing XLSX/PPTX extractions that have 90s internal timeouts.
        extractedText = await withTimeout(
          extractOfficeContent(),
          TIMEOUTS.AI_ANALYSIS_LONG || 120000,
          `Office extraction for ${fileName}`
        );

        logger.debug(`Extracted characters from office document`, {
          fileName,
          length: extractedText.length
        });
      } catch (officeError) {
        if (isCancellationError(officeError)) throw officeError;
        let finalError = officeError;

        if (isTransientOfficeError(officeError)) {
          logger.warn(`Office extraction hit transient OS error, retrying once`, {
            fileName,
            fileExtension,
            error: officeError?.message,
            code: officeError?.code
          });
          try {
            await delay(TIMEOUTS.DELAY_LOCK_RETRY);
            logExtraction();
            extractedText = await withTimeout(
              extractOfficeContent(),
              TIMEOUTS.AI_ANALYSIS_LONG || 120000,
              `Retry office extraction for ${fileName}`
            );
            logger.info(`Office extraction recovered after retry`, {
              fileName,
              fileExtension
            });
          } catch (retryError) {
            if (isCancellationError(retryError)) throw retryError;
            finalError = retryError || officeError;
          }
        } else {
          logger.warn(`Office extraction failed; not retrying non-transient error`, {
            fileName,
            fileExtension,
            error: officeError?.message,
            code: officeError?.code
          });
        }

        // If still no extracted text, fall back to filename analysis
        if (!extractedText) {
          const errorMessage =
            finalError?.message || officeError?.message || 'Unknown extraction error';
          const errorCode = finalError?.code || 'UNKNOWN_ERROR';
          /** @type {AnalysisResult} */
          const errorDetails = {
            fileName,
            fileExtension,
            error: errorMessage,
            errorCode,
            errorStack: finalError?.stack || officeError?.stack,
            errorType: finalError?.constructor?.name || officeError?.constructor?.name || 'Error'
          };

          // FileProcessingError keeps its details under `metadata`; reading
          // them off the error itself left every hint and cause blank.
          const detailOf = (/** @type {string} */ key) =>
            finalError?.metadata?.[key] ??
            finalError?.[key] ??
            officeError?.metadata?.[key] ??
            officeError?.[key];
          const suggestion = detailOf('suggestion');
          const originalError = detailOf('originalError');
          if (suggestion) errorDetails.suggestion = suggestion;
          if (originalError) errorDetails.originalError = originalError;

          logger.error(`Error extracting office content`, errorDetails);

          // Fall back to intelligent filename-based analysis
          const intelligentCategory = getIntelligentCategory(fileName, fileExtension, smartFolders);
          const intelligentKeywords = getIntelligentKeywords(fileName, fileExtension);

          let purpose = 'Office document (content extraction failed)';
          const confidence = 70;
          // A reader this build lacks, or a password, is not a capability a
          // model install restores: stamp a method the watcher never
          // retries (analysisProvenance.format_unsupported).
          let extractionMethod = 'filename_fallback';
          // A stable label, not the extractor's message: the IPC outcome
          // classifier records it as the pipeline reason and Diagnostics
          // counts those per label.
          let fallbackReason = 'office extraction failed';

          if (errorCode === 'LEGACY_FORMAT_UNSUPPORTED') {
            // Not a failure of this file: the build has no reader for the
            // format. Say so, and say what to do, instead of implying the
            // document was corrupt.
            const label =
              fileExtension === '.xls'
                ? 'Excel 97-2003 workbook'
                : fileExtension === '.ppt'
                  ? 'PowerPoint 97-2003 presentation'
                  : 'Legacy office file';
            const hint = suggestion || '';
            purpose = `${label} (.${fileExtension.slice(1)}): contents not readable in this build, organized by filename.${hint ? ` ${hint}` : ''}`;
            extractionMethod = 'format_unsupported';
            fallbackReason = 'no reader for this format in this build';
          } else if (errorCode === 'DOC_ENCRYPTED') {
            purpose = `Word document is password-protected, so its contents were not read; organized by filename.${suggestion ? ` ${suggestion}` : ''}`;
            extractionMethod = 'format_unsupported';
            fallbackReason = 'document is password-protected';
          } else if (fileExtension === '.doc') {
            purpose = 'Word 97-2003 document - content extraction failed, using filename analysis';
          } else if (fileExtension === '.docx') {
            purpose = 'Word document - content extraction failed, using filename analysis';
          } else if (fileExtension === '.xlsx') {
            purpose = 'Excel spreadsheet - content extraction failed, using filename analysis';
          } else if (fileExtension === '.pptx') {
            purpose =
              'PowerPoint presentation - content extraction failed, using filename analysis';
          } else if (fileExtension === '.msg') {
            purpose = 'Outlook message - content extraction failed, using filename analysis';
          }

          const category = normalizeCategoryToSmartFolders(
            intelligentCategory || 'document',
            smartFolders
          );

          return {
            purpose,
            project: path.basename(fileName, fileExtension),
            category,
            date: fileDate,
            keywords: intelligentKeywords || [],
            confidence,
            suggestedName: safeSuggestedName(fileName, fileExtension),
            extractionError: errorMessage,
            extractionErrorCode: errorCode,
            extractionMethod,
            // Nothing was read: mark it the way createFallbackAnalysis does so
            // the history writer, the embedding gate and the IPC outcome
            // classifier all agree this is a fallback.
            fallbackReason,
            isFallback: true,
            _isFallback: true
          };
        }
      }
    } else if (
      SUPPORTED_3D_EXTENSIONS.includes(fileExtension) ||
      SUPPORTED_DESIGN_EXTENSIONS.includes(fileExtension)
    ) {
      // 3D models and design files: names, counts, dimensions, slicer settings
      // and DSC headers are read into text so the model can name and file
      // them. The README listed these types for months while Discover and the
      // watchers skipped them.
      try {
        extractedText = await withTimeout(
          extractCadOrDesignText(filePath, fileExtension),
          TIMEOUTS.AI_ANALYSIS_LONG || 120000,
          `Model/design extraction for ${fileName}`
        );
      } catch (cadError) {
        if (isCancellationError(cadError)) throw cadError;
        logger.warn('[CAD] Extraction failed; falling back to filename', {
          fileName,
          fileExtension,
          error: cadError?.message
        });
        extractedText = '';
      }
      if (!extractedText || extractedText.trim().length === 0) {
        return createFallbackAnalysis({
          fileName,
          fileExtension,
          reason:
            fileExtension === '.psd'
              ? 'no PSD reader in this build; organized by filename and date'
              : 'no readable metadata in this file; organized by filename and date',
          smartFolders,
          confidence: 70,
          type: 'document',
          options: { extractionMethod: 'filename', date: fileDate }
        });
      }
    } else if (SUPPORTED_ARCHIVE_EXTENSIONS.includes(fileExtension)) {
      // Archive metadata inspection (best-effort)
      const archiveInfo = await tryExtractArchiveMetadata(filePath);
      const keywords =
        archiveInfo.keywords?.slice(0, TRUNCATION.KEYWORDS_MAX) ||
        getIntelligentKeywords(fileName, fileExtension);

      const category = normalizeCategoryToSmartFolders('archive', smartFolders);

      return {
        purpose: archiveInfo.summary || 'Archive file',
        project: path.basename(fileName, fileExtension),
        category,
        date: fileDate,
        keywords,
        confidence: 70,
        suggestedName: safeSuggestedName(fileName, fileExtension),
        extractionMethod: 'archive'
      };
    } else {
      // No content parser available - use filename-based fallback
      logger.warn(`[FILENAME-FALLBACK] No content parser`, {
        extension: fileExtension,
        fileName
      });
      return createFallbackAnalysis({
        fileName,
        fileExtension,
        reason: 'No content parser available',
        smartFolders,
        confidence: 75,
        type: 'document',
        options: { extractionMethod: 'filename', date: fileDate }
      });
    }

    if (extractedText && extractedText.trim().length > 0) {
      logger.info(`[CONTENT-ANALYSIS] Processing`, {
        fileName,
        extractedChars: extractedText.length
      });
      // No text preview, even at debug: loggingLevel is a user setting and
      // the log export would carry the opening of every analyzed document
      // (including OCR of scans), which PRIVACY.md says it never does.
      logger.debug(`[CONTENT-PREVIEW]`, {
        previewChars: Math.min(TRUNCATION.PREVIEW_MEDIUM, extractedText.length)
      });

      // Naming consistency via BM25 (no extra embedding — folder matching embeds later)
      /** @type {string[]} */
      let namingContext = [];
      try {
        const searchService = container.tryResolve(ServiceIds.SEARCH_SERVICE);
        namingContext = await fetchNamingContextFromBm25(searchService, {
          fileName,
          textSnippet: extractedText.slice(0, 50000),
          topK: 5,
          logger
        });
        if (namingContext.length > 0) {
          logger.debug('[DocumentAnalysis] Found similar files for naming context (BM25)', {
            count: namingContext.length,
            examples: namingContext.slice(0, 3)
          });
        }
      } catch (namingError) {
        logger.debug('[DocumentAnalysis] Failed to get naming context (non-fatal)', {
          error: namingError.message
        });
      }

      // Check for cancellation before expensive LLM call
      if (typeof options.isCancelled === 'function' && options.isCancelled()) {
        throw new Error('Analysis cancelled');
      }

      // Backend Caching & Deduplication:
      // Hash a prefix + length instead of the full text to avoid blocking
      // the event loop on multi-MB documents. 8KB prefix + length is sufficient
      // for dedup — full-text identity is overkill for a cache key.
      const safeModelName = String(modelName || 'default-model');
      const hashInput =
        extractedText.length > 8192
          ? extractedText.slice(0, 8192) + '\0' + extractedText.length
          : extractedText;
      const contentHash = crypto
        .createHash('md5')
        .update(hashInput)
        .update(safeModelName)
        .digest('hex');

      // Folders are only relevant if they change the prompt structure, but analyzeTextWithLlama uses
      // folders in the prompt. So we SHOULD include folders. But model is in contentHash.
      // _analyzeWithProvider wraps analyzeTextWithLlama with AIRouter awareness — cloud providers
      // are engaged transparently; local-only users see no behavior change.
      const analysisFn = () =>
        _analyzeWithProvider(
          extractedText,
          fileName,
          smartFolders,
          fileDate,
          namingContext,
          // signal: thread the IPC/batch abort signal into the LLM call so
          // cancellation aborts in-flight inference instead of only being
          // checked at the next isCancelled() poll point.
          { bypassCache, signal: options?.abortSignal },
          smartFolderId
        );

      // Skip in-flight deduplication during forced reanalysis — we explicitly want fresh results
      let analysis;
      if (bypassCache) {
        analysis = await analysisFn();
      } else {
        const deduplicationKey = globalDeduplicator.generateKey({
          contentHash,
          fileName,
          task: 'analyzeTextWithLlama',
          folders: Array.isArray(smartFolders)
            ? smartFolders.map((f) => f?.name || '').join(',')
            : ''
        });
        analysis = await globalDeduplicator.deduplicate(deduplicationKey, analysisFn);
      }

      // Semantic folder refinement using embeddings
      if (analysis && typeof analysis === 'object' && !analysis.error) {
        try {
          // Round-3 audit fix: thread the abort signal so closing the window
          // mid-analysis cancels the downstream embedding work instead of
          // letting it burn VRAM and produce stale folder vectors after the
          // renderer has been unblocked. options.abortSignal is the same
          // signal the IPC handler forwards from event.abortSignal.
          await applyUnifiedFolderMatching({
            analysis,
            filePath,
            fileName,
            fileExtension,
            fileSize: fileStats?.size,
            smartFolders,
            extractedText,
            type: 'document',
            signal: options?.abortSignal
          });
        } catch (e) {
          logger.warn('[DocumentAnalysis] Folder matching failed (non-fatal):', {
            error: e.message,
            filePath
          });
        }
      }

      // Capture values needed from extractedText and release it for GC
      // Large documents can be 2MB+, holding this in memory during subsequent async
      // operations wastes memory. Capture what we need and null the reference.
      const extractedTextLength = extractedText?.length || 0;
      const extractedTextPreview = extractedText?.substring(0, 500) || '';
      const extractedTextForStorage = normalizeExtractedTextForStorage(extractedText);
      extractedText = null;

      if (analysis && !analysis.error) {
        // Shape only, never substance: purpose, project, entity, keywords and
        // the suggested name paraphrase the document, and PRIVACY.md promises
        // the logs (exportable from Diagnostics) carry no file content.
        logger.info(`[AI-ANALYSIS-SUCCESS] Document analyzed`, {
          fileName,
          category: analysis.category,
          type: analysis.type,
          confidence: analysis.confidence,
          keywordCount: Array.isArray(analysis.keywords) ? analysis.keywords.length : 0,
          hasDate: Boolean(analysis.date),
          hasSuggestedName: Boolean(analysis.suggestedName),
          provider: analysis.provider,
          contentChars: extractedTextLength,
          extractionMethod: 'content'
        });
        const normalized = normalizeAnalysisResult(
          {
            ...analysis,
            llmSuggestedName: analysis.suggestedName || null,
            contentLength: extractedTextLength,
            extractionMethod: 'content',
            partialContent: partialTextRead,
            extractedText: extractedTextForStorage
          },
          { category: 'document', keywords: [], confidence: 0 }
        );
        // Pass precomputed embedding so SmartFolderWatcher can reuse instead of re-embedding
        if (analysis._embeddingForPersistence) {
          normalized._embeddingForPersistence = analysis._embeddingForPersistence;
        }
        // Verify file still exists at original path — if moved/renamed during
        // analysis, flag so callers skip enqueueing with the stale path-based ID.
        try {
          await fs.access(filePath);
        } catch {
          logger.warn('[DocumentAnalysis] File moved/removed during analysis, flagging result', {
            filePath
          });
          normalized._fileMovedDuringAnalysis = true;
          return normalized;
        }
        // Use pre-computed signature if available, otherwise skip caching
        if (fileSignature && !normalized?._isFallback && !normalized?.isFallback) {
          const cached = await setFileCacheIfUnchanged(
            fileSignature,
            filePath,
            fileStats,
            normalized
          );
          if (!cached) {
            logger.warn('File changed during analysis; skipping cache write', { path: filePath });
          }
        }
        return normalized;
      }

      logger.warn(`[AI-ANALYSIS-FAILED] Content extracted but AI analysis failed`, { fileName });
      return normalizeAnalysisResult(
        {
          rawText: extractedTextPreview,
          extractedText: extractedTextForStorage,
          // Use optional chaining to prevent crash when analysis is null/undefined
          keywords: Array.isArray(analysis?.keywords)
            ? analysis.keywords
            : ['document', 'analysis_failed'],
          purpose: analysis?.error
            ? `Analysis failed: ${analysis.error}`
            : 'Text extracted, but AI analysis failed.',
          project: fileName,
          date: fileDate,
          category: 'document',
          confidence: 60,
          error: analysis?.error || 'AI analysis failed for document content.',
          contentLength: extractedTextLength,
          extractionMethod: 'content_fallback',
          fallbackReason: 'ai_analysis_failed',
          isFallback: true,
          _isFallback: true
        },
        { category: 'document', keywords: [], confidence: 60 }
      );
    }

    if (fileExtension === '.pdf' && pdfNoTextFallback) {
      logger.warn(`[PDF] No text extracted after OCR fallback; using filename fallback`, {
        fileName
      });
    } else {
      logger.error(`[EXTRACTION-FAILED] Could not extract any text content`, {
        fileName
      });
    }
    const result = createFallbackAnalysis({
      fileName,
      fileExtension,
      reason:
        fileExtension === '.pdf' && pdfNoTextFallback
          ? 'scanned pdf had no extractable text'
          : 'extraction failed',
      smartFolders,
      confidence: 50,
      type: 'document',
      options: {
        extractionMethod: fileExtension === '.pdf' && pdfNoTextFallback ? 'pdf_no_text' : 'failed',
        error:
          fileExtension === '.pdf' && pdfNoTextFallback
            ? pdfOriginalError || 'PDF contained no extractable text.'
            : 'Could not extract text or analyze document.'
      }
    });
    // Use pre-computed signature if available, otherwise skip caching
    if (fileSignature && !result?._isFallback && !result?.isFallback) {
      const cached = await setFileCacheIfUnchanged(fileSignature, filePath, fileStats, result);
      if (!cached) {
        logger.warn('File changed during analysis; skipping cache write', { path: filePath });
      }
    }
    return result;
  } catch (error) {
    // Re-throw programming errors (TypeError, ReferenceError, SyntaxError, RangeError)
    // so they surface in logs and tests instead of being silently swallowed as fallback
    // results, and user cancellation so the caller can stop rather than get a fallback.
    if (
      error instanceof TypeError ||
      error instanceof ReferenceError ||
      error instanceof SyntaxError ||
      error instanceof RangeError ||
      isCancellationError(error)
    ) {
      throw error;
    }
    // Operational AnalysisErrors (empty/too-large/unreadable file, encrypted PDF,
    // extraction failures) are expected, recoverable conditions handled by the
    // filename fallback below. Log them at warn to avoid false-alarm error noise;
    // reserve error for genuinely unexpected failures.
    const isOperational = error instanceof AnalysisError && error.isOperational;
    const logPayload = { path: filePath, code: error.code, error: error.message };
    if (isOperational) {
      logger.warn(`Error processing document`, logPayload);
    } else {
      logger.error(`Error processing document`, logPayload);
    }
    return createFallbackAnalysis({
      fileName,
      fileExtension,
      reason: 'Error processing document',
      smartFolders,
      confidence: 60,
      type: 'document',
      options: { date: fileDate, error: error.message, extractionMethod: 'failed' }
    });
  }
}

// Text normalization helpers moved to documentExtractors

/**
 * Read a 3D model or design file into descriptive text. .scad is plain text
 * and takes the text branch before this is reached; .psd has no reader yet.
 * @param {string} filePath
 * @param {string} fileExtension
 * @returns {Promise<string>}
 */
async function extractCadOrDesignText(filePath, fileExtension) {
  const cad = require('./extractors/cadDesignExtractors');
  switch (fileExtension) {
    case '.stl':
      return cad.extractTextFromStl(filePath);
    case '.obj':
      return cad.extractTextFromObj(filePath);
    case '.3mf':
      return cad.extractTextFrom3mf(filePath);
    case '.gcode':
      return cad.extractTextFromGcode(filePath);
    case '.eps':
      return cad.extractTextFromEps(filePath);
    case '.ai':
      return cad.extractTextFromAi(filePath, {
        extractTextFromPdf: (/** @type {string} */ p) => extractTextFromPdf(p, path.basename(p))
      });
    default:
      return '';
  }
}

// Best-effort archive metadata extraction: ZIP via adm-zip, tar/tgz/gz via the
// tar package and the gzip header; rar/7z/bz2 have no permissively licensed
// reader and get a bare summary.
/** @param {string} filePath */
async function tryExtractArchiveMetadata(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  /** @type {AnalysisResult} */
  const info = { keywords: [], summary: '' };
  try {
    const { describeArchive, classifyArchiveExtension } = require('./extractors/archiveListing');
    if (classifyArchiveExtension(path.basename(filePath))) {
      const listing = await describeArchive(filePath);
      if (listing) {
        info.keywords = deriveKeywordsFromFilenames(listing.entryNames);
        info.summary = listing.summary;
        if (typeof listing.totalEntries === 'number') info.totalEntries = listing.totalEntries;
        info.processedEntries = listing.entryNames.length;
        return info;
      }
      info.summary = `${ext.substring(1).toUpperCase()} archive (content listing unavailable)`;
      return info;
    }
  } catch (listingError) {
    logger.debug('[ARCHIVE] tar/gzip listing unavailable', { error: listingError?.message });
  }
  if (ext === '.zip') {
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > LIMITS.MAX_FILE_SIZE) {
        info.summary = 'ZIP archive (too large for content listing)';
        return info;
      }
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(filePath);
      const allEntries = zip.getEntries();
      const totalEntries = allEntries.length;
      const sampledEntries = allEntries.slice(0, 50);
      const names = sampledEntries.map((/** @type {any} */ e) => e.entryName);
      info.keywords = deriveKeywordsFromFilenames(names);
      info.totalEntries = totalEntries;
      info.processedEntries = sampledEntries.length;
      info.summary = `ZIP archive with ${totalEntries} entries`;
      return info;
    } catch (zipError) {
      info.summary = 'ZIP archive (content listing unavailable)';
      info.keywords = [];
      info.extractionError = zipError?.message || 'unknown';
      return info;
    }
  }
  info.summary = `${ext.substring(1).toUpperCase()} archive`;
  info.keywords = [];
  return info;
}

/** @param {string[]} names */
function deriveKeywordsFromFilenames(names) {
  /** @type {Record<string, number>} */
  const exts = {};
  /** @type {Set<string>} */
  const tokens = new Set();
  names.forEach((n) => {
    const parts = n.split('/');
    const b = parts.length > 0 ? parts[parts.length - 1] : '';
    if (!b) return; // Skip empty filenames
    const extParts = b.split('.');
    const e = extParts.length > 1 ? extParts[extParts.length - 1].toLowerCase() : '';
    if (e) exts[e] = (exts[e] || 0) + 1;
    b.replace(/[^a-zA-Z0-9]+/g, ' ')
      .toLowerCase()
      .split(' ')
      .forEach((w) => {
        if (w && w.length > 2 && w.length < 20) tokens.add(w);
      });
  });
  const topExts = Object.entries(exts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k);
  return [...topExts, ...Array.from(tokens)].slice(0, 15);
}

// Fallback helpers removed; sourced from fallbackUtils

/**
 * Force flush the embedding queue (useful for cleanup or end of batch)
 */
async function flushAllEmbeddings() {
  await analysisQueue.flush();
}

module.exports = {
  analyzeDocumentFile,
  flushAllEmbeddings
};
