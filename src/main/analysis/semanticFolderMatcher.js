// @ts-check
/**
 * Unified Semantic Folder Matching
 *
 * This module consolidates duplicate folder matching logic from:
 * - document analysis (applyDocumentFolderMatching)
 * - image analysis (applySemanticFolderMatching)
 *
 * Both implementations shared ~80% identical code for:
 * - Vector DB/FolderMatchingService initialization
 * - Embedding generation and folder matching
 * - Queue management for embeddings
 * - Confidence-based category override logic
 *
 * The main differences are handled via parameters:
 * - type: 'document' vs 'image'
 * - buildSummary: type-specific summary builder function
 * - metadata: type-specific metadata fields
 *
 * @module analysis/semanticFolderMatcher
 */

const { createLogger } = require('../../shared/logger');
const fs = require('fs').promises;
const { THRESHOLDS, TIMEOUTS } = require('../../shared/performanceConstants');
const { getCanonicalFileId } = require('../../shared/pathSanitization');
const { findContainingSmartFolder } = require('../../shared/folderUtils');
const { buildEmbeddingSummary } = require('./embeddingSummary');
const { embedFileChunks } = require('./chunkEmbedding');
const { container, ServiceIds } = require('../services/ServiceContainer');
const { analysisQueue } = require('./embeddingQueue/stageQueues');
const embeddingQueueManager = require('./embeddingQueue/queueManager');
const { resolveEmbeddingModelOptions } = require('./embeddingModelOptions');
const { withTimeout } = require('../../shared/promiseUtils');
const { shouldEmbed } = require('../services/embedding/embeddingGate');
const {
  stripCategorySubjectSuffix,
  findSmartFolderForLabel,
  isDefaultCategoryName
} = require('../../shared/categoryFolderMatching');

const logger = createLogger('SemanticFolderMatcher');
const ROUTING_MODES = Object.freeze({
  AUTO: 'auto',
  LLM: 'llm',
  EMBEDDING: 'embedding',
  HYBRID: 'hybrid'
});
const SMART_FOLDER_UPSERT_CACHE_MS = 30000;
const matcherFolderUpsertCache = new WeakMap();
/** Off by default: BatchAnalysisService already backpressures on queue depth. */
const { isPipelineEmbeddingQueueWaitEnabled } = require('./utils');
const ENABLE_PIPELINE_EMBEDDING_QUEUE_WAIT = isPipelineEmbeddingQueueWaitEnabled();

/** @param {any[]} folders */
function createSmartFolderFingerprint(folders) {
  if (!Array.isArray(folders) || folders.length === 0) return '';
  return folders
    .map((folder) => ({
      id: String(folder?.id || '').trim(),
      name: String(folder?.name || '').trim(),
      path: String(folder?.path || '').trim(),
      description: String(folder?.description || '').trim()
    }))
    .sort((a, b) =>
      `${a.id}|${a.name}|${a.path}|${a.description}`.localeCompare(
        `${b.id}|${b.name}|${b.path}|${b.description}`
      )
    )
    .map((folder) => `${folder.id}|${folder.name}|${folder.path}|${folder.description}`)
    .join('||');
}

/**
 * @param {any} matcher
 * @param {string} folderFingerprint
 * @param {number} [now]
 */
function shouldUpsertSmartFolders(matcher, folderFingerprint, now = Date.now()) {
  if (!folderFingerprint) return true;
  const cached = matcherFolderUpsertCache.get(matcher);
  return !(
    cached &&
    cached.fingerprint === folderFingerprint &&
    Number.isFinite(cached.expiresAt) &&
    cached.expiresAt > now
  );
}

/**
 * @param {any} matcher
 * @param {string} folderFingerprint
 * @param {number} [now]
 */
function rememberSmartFolderUpsert(matcher, folderFingerprint, now = Date.now()) {
  if (!folderFingerprint) return;
  matcherFolderUpsertCache.set(matcher, {
    fingerprint: folderFingerprint,
    expiresAt: now + SMART_FOLDER_UPSERT_CACHE_MS
  });
}
/**
 * Get or initialize vector DB and FolderMatchingService
 * Uses lazy initialization to prevent startup failures
 *
 * @returns {{ vectorDb: any, matcher: any }}
 */
function getServices() {
  const vectorDb = container.tryResolve(ServiceIds.ORAMA_VECTOR);
  const matcher = container.tryResolve(ServiceIds.FOLDER_MATCHING);
  return { vectorDb, matcher };
}

/**
 * Settings → Smart Folder routing. Auto and embedding-first let folder
 * vectors pick the destination; hybrid keeps the LLM unless the vector is
 * more sure; LLM-only never overrides.
 * @returns {Promise<'auto'|'llm'|'embedding'|'hybrid'>}
 */
async function loadSmartFolderRoutingMode() {
  try {
    const settingsService = container.tryResolve(ServiceIds.SETTINGS);
    if (!settingsService || typeof settingsService.load !== 'function') {
      return ROUTING_MODES.AUTO;
    }
    const settings = await settingsService.load();
    const mode = String(settings?.smartFolderRoutingMode || ROUTING_MODES.AUTO).toLowerCase();
    return Object.values(ROUTING_MODES).includes(/** @type {any} */ (mode))
      ? /** @type {'auto'|'llm'|'embedding'|'hybrid'} */ (mode)
      : ROUTING_MODES.AUTO;
  } catch (error) {
    logger.debug('[FolderMatcher] Could not read routing mode; using auto', {
      error: error?.message
    });
    return ROUTING_MODES.AUTO;
  }
}

/**
 * Validate that FolderMatchingService has required methods
 *
 * @param {any} matcher - Matcher instance
 * @returns {boolean} True if matcher has all required methods
 */
function validateMatcher(matcher) {
  return (
    matcher &&
    typeof matcher === 'object' &&
    typeof matcher.initialize === 'function' &&
    typeof matcher.batchUpsertFolders === 'function' &&
    typeof matcher.embedText === 'function' &&
    typeof matcher.matchVectorToFolders === 'function'
  );
}

/**
 * Unified semantic folder matching for documents and images
 *
 * This function:
 * 1. Initializes vector DB and FolderMatchingService if needed
 * 2. Upserts smart folder embeddings
 * 3. Generates embedding for the file's content summary
 * 4. Matches the embedding against folder embeddings
 * 5. Queues the embedding for batch persistence
 * 6. Optionally overrides the LLM category if embedding match is stronger
 *
 * @param {object} params - Parameters for folder matching
 * @param {Record<string, any>} params.analysis - Current analysis result (will be mutated)
 * @param {string} params.filePath - File path for embedding ID
 * @param {string} params.fileName - File name for metadata
 * @param {string} params.fileExtension - File extension
 * @param {number} [params.fileSize] - File size in bytes
 * @param {any[]} params.smartFolders - Available smart folders
 * @param {string} [params.extractedText] - Extracted text content
 * @param {'document' | 'image'} [params.type] - Analysis type
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<Record<string, any>>} The analysis object (possibly modified)
 *
 * @example
 * await applySemanticFolderMatching({
 *   analysis,
 *   filePath: '/path/to/file.pdf',
 *   fileName: 'file.pdf',
 *   fileExtension: '.pdf',
 *   fileSize: 12345,
 *   smartFolders: folders,
 *   extractedText: 'Document content...',
 *   type: 'document'
 * });
 */
/**
 * Normalize LLM confidence to 0..1. Integer and fractional percentages (1, 1.5, 50, 100)
 * are divided by 100. Values already on a 0..1 scale (e.g. 0.85) are clamped only.
 * Undefined/null/NaN fall back to 0.7 (70%).
 *
 * @param {number|undefined|null} raw - Raw confidence from analysis
 * @returns {number} Clamped confidence in [0, 1]
 */
function normalizeLlmConfidence(raw) {
  if (raw === undefined || raw === null) return 0.7;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0.7;
  const scaled = raw > 1 || raw === 1 ? raw / 100 : raw;
  return Math.min(1, Math.max(0, scaled));
}

/**
 * Sanity-check LLM-reported confidence against the embedding-side discrimination
 * signal. Small quantized models will report near-certain confidence on
 * decisions driven by surface-token overlap; this caps the displayed confidence
 * when the embedding model fails to corroborate that certainty.
 *
 * Caps only — never raises a low value. Returns the calibrated confidence
 * plus a `cap` (the binding cap) and `reason` (which rule won), both null when
 * no cap fired. Surfacing these makes the calibration auditable from logs and
 * UI debug panes without re-deriving it.
 *
 * @param {Object} params
 * @param {number} params.rawConfidence - 0-100 integer self-reported by the LLM
 * @param {number|null} params.topScore - top folder cosine similarity in [0, 1], or null
 * @param {number|null} params.runnerUpScore - second-best folder cosine in [0, 1], or null
 * @param {boolean} params.llmCategoryUnmatchable - LLM picked a label that maps to no folder
 * @returns {{confidence: number, cap: number, reason: string|null, original: number, spread: number|null}}
 */
function calibrateConfidence({ rawConfidence, topScore, runnerUpScore, llmCategoryUnmatchable }) {
  const original =
    typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)
      ? Math.max(0, Math.min(100, Math.round(rawConfidence)))
      : 0;

  let cap = 100;
  /** @type {string | null} */
  let reason = null;

  /**
   * @param {number} newCap
   * @param {string} newReason
   */
  const setCap = (newCap, newReason) => {
    if (newCap < cap) {
      cap = newCap;
      reason = newReason;
    }
  };

  /** @type {Record<string, number>} */
  const CAL = THRESHOLDS.CONFIDENCE_CALIBRATION || {};
  const hasEmbedding = typeof topScore === 'number' && Number.isFinite(topScore);

  let spread = null;
  if (!hasEmbedding) {
    // No embedding sanity check available — single-source confidence claim.
    setCap(CAL.NO_EMBEDDING_CAP ?? 80, 'no_embedding_signal');
  } else {
    const runnerUp =
      typeof runnerUpScore === 'number' && Number.isFinite(runnerUpScore) ? runnerUpScore : 0;
    spread = topScore - runnerUp;

    if (topScore < (THRESHOLDS.FOLDER_MATCH_CONFIDENCE ?? 0.55)) {
      setCap(CAL.LOW_TOP_SCORE_CAP ?? 70, 'low_top_embedding');
    }

    if (spread < (CAL.NO_SPREAD_THRESHOLD ?? 0.03)) {
      setCap(CAL.NO_SPREAD_CAP ?? 60, 'no_spread');
    } else if (spread < (CAL.NARROW_SPREAD_THRESHOLD ?? 0.07)) {
      setCap(CAL.NARROW_SPREAD_CAP ?? 75, 'narrow_spread');
    } else if (spread < (CAL.MODERATE_SPREAD_THRESHOLD ?? 0.12)) {
      setCap(CAL.MODERATE_SPREAD_CAP ?? 85, 'moderate_spread');
    }
  }

  if (llmCategoryUnmatchable) {
    setCap(CAL.UNMATCHABLE_CATEGORY_CAP ?? 75, 'unmatchable_category');
  }

  const confidence = Math.min(original, cap);
  return {
    confidence,
    cap,
    reason: confidence < original ? reason : null,
    original,
    spread
  };
}

/** @param {any} params */
async function applySemanticFolderMatching(params) {
  const {
    analysis,
    filePath,
    fileName,
    fileExtension,
    fileSize,
    smartFolders,
    extractedText = '',
    type = 'document',
    signal
  } = params;

  // Round-3 audit finding: when the user closes the window mid-analysis,
  // the abort signal cleanly cancels in-flight LLM generation but NOT the
  // downstream embedding work that runs inside this function. Without these
  // checks, the renderer is unblocked while post-abort embeddings keep
  // burning VRAM and writing stale vectors. The signal is best-effort —
  // we short-circuit at each await boundary that wraps a potentially
  // long-running call (embed, vector match, queue enqueue).
  const isAborted = () => Boolean(signal?.aborted);
  if (isAborted()) {
    logger.debug('[FolderMatcher] Abort signal already fired, skipping folder matching', {
      filePath
    });
    return analysis;
  }

  // Guard against invalid analysis
  if (!analysis || typeof analysis !== 'object') {
    logger.warn('[FolderMatcher] Invalid analysis object, skipping folder matching', {
      filePath,
      analysisType: typeof analysis
    });
    return analysis;
  }

  // Get services with lazy initialization
  const { vectorDb, matcher } = getServices();

  if (!vectorDb) {
    logger.warn('[FolderMatcher] Vector DB not available, skipping semantic folder matching');
    return analysis;
  }

  // Validate matcher
  if (!validateMatcher(matcher)) {
    logger.warn('[FolderMatcher] FolderMatcher invalid or missing required methods');
    return analysis;
  }

  // Initialize matcher if needed
  if (!matcher.embeddingCache?.initialized) {
    try {
      await matcher.initialize();
      logger.debug('[FolderMatcher] FolderMatchingService initialized');
    } catch (initError) {
      logger.warn('[FolderMatcher] Initialization error:', initError.message);
      return analysis;
    }
  }

  // Upsert smart folders
  if (smartFolders && Array.isArray(smartFolders) && smartFolders.length > 0) {
    try {
      const validFolders = smartFolders.filter(
        (f) => f && typeof f === 'object' && (f.name || f.id || f.path)
      );
      if (validFolders.length > 0) {
        const fingerprint = createSmartFolderFingerprint(validFolders);
        if (shouldUpsertSmartFolders(matcher, fingerprint)) {
          const upsertResult = await matcher.batchUpsertFolders(validFolders);
          const upsertCount = Number(upsertResult?.count) || 0;
          const skipped = Array.isArray(upsertResult?.skipped) ? upsertResult.skipped : [];
          const hasHardFailure =
            upsertResult?.requiresRebuild === true ||
            Boolean(upsertResult?.error) ||
            skipped.some(
              (/** @type {any} */ entry) =>
                entry?.error && entry.error !== 'already_upserted_this_session'
            );

          if (hasHardFailure && upsertCount === 0) {
            logger.warn(
              '[FolderMatcher] Smart-folder upsert did not persist embeddings; will retry',
              {
                folderCount: validFolders.length,
                skippedCount: skipped.length,
                error: upsertResult?.error || null,
                requiresRebuild: upsertResult?.requiresRebuild === true
              }
            );
          } else if (upsertCount > 0) {
            rememberSmartFolderUpsert(matcher, fingerprint);
            logger.debug('[FolderMatcher] Upserted folder embeddings', {
              folderCount: validFolders.length,
              persistedCount: upsertCount,
              skippedCount: skipped.length
            });
          } else {
            // All folders skipped (session-cached) with no hard failure.
            // Don't cache this result -- the DB may have been wiped and
            // the session cache stale, so let the next call retry.
            logger.debug('[FolderMatcher] Upserted folder embeddings', {
              folderCount: validFolders.length,
              persistedCount: 0,
              skippedCount: skipped.length
            });
          }
        } else {
          logger.debug('[FolderMatcher] Skipped repeated smart-folder upsert', {
            folderCount: validFolders.length
          });
        }
      }
    } catch (upsertError) {
      logger.warn('[FolderMatcher] Folder embedding upsert error:', upsertError.message);
    }
  }

  const resolvedSmartFolder = findContainingSmartFolder(filePath, smartFolders);

  // Size the summary from the real embedding model's context window (shared
  // with the watcher and post-move routes so all three embed the same text).
  const embeddingSummary = buildEmbeddingSummary(
    analysis,
    extractedText,
    fileExtension,
    type,
    await resolveEmbeddingModelOptions()
  );
  const summaryForEmbedding = embeddingSummary.text;

  if (!summaryForEmbedding || summaryForEmbedding.trim().length === 0) {
    logger.debug('[FolderMatcher] Empty summary, skipping folder matching');
    return analysis;
  }

  if (embeddingSummary.wasTruncated) {
    logger.warn('[FolderMatcher] Embedding summary truncated to token limit', {
      filePath,
      summaryLength: summaryForEmbedding.length,
      estimatedTokens: embeddingSummary.estimatedTokens
    });
  }

  try {
    // Initialize vector DB if needed
    if (vectorDb && typeof vectorDb.initialize === 'function') {
      await vectorDb.initialize();
    }

    if (isAborted()) {
      logger.debug('[FolderMatcher] Aborted before embedText, skipping', { filePath });
      return analysis;
    }
    // Generate embedding
    const embeddingResult = await withTimeout(
      matcher.embedText(summaryForEmbedding),
      TIMEOUTS.AI_ANALYSIS_LONG || 300000,
      'folder matcher embedText'
    );
    if (isAborted()) {
      logger.debug('[FolderMatcher] Aborted after embedText, dropping embedding', { filePath });
      return analysis;
    }
    if (
      !embeddingResult ||
      !embeddingResult.vector ||
      !Array.isArray(embeddingResult.vector) ||
      embeddingResult.vector.length === 0
    ) {
      logger.warn('[FolderMatcher] Failed to generate valid embedding vector', {
        filePath,
        hasResult: !!embeddingResult,
        hasVector: !!embeddingResult?.vector,
        vectorLength: embeddingResult?.vector?.length
      });
      return analysis;
    }

    const { vector, model } = embeddingResult;

    // Match against folders
    const candidates = await withTimeout(
      matcher.matchVectorToFolders(vector, 5),
      TIMEOUTS.SEMANTIC_QUERY || 30000,
      'folder matcher matchVectorToFolders'
    );
    if (isAborted()) {
      logger.debug('[FolderMatcher] Aborted after matchVectorToFolders, dropping result', {
        filePath
      });
      return analysis;
    }

    // Generate file ID using canonical source of truth
    const fileId = getCanonicalFileId(filePath, type === 'image');

    // Filter candidates against current smart folders to drop phantom hits left
    // over in the folder vector DB (e.g. "Images"/"Documents" from a removed
    // default file-type taxonomy). Without this, the override below would set
    // `analysis.category` to a folder name that no longer exists; downstream
    // `FolderMatchingService.matchCategoryToFolder` would then demote it to
    // "Uncategorized", losing both the embedding hit and the LLM category.
    const candidateCanon = (/** @type {any} */ s) =>
      String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    const validFolderNames =
      Array.isArray(smartFolders) && smartFolders.length > 0
        ? new Set(smartFolders.map((f) => candidateCanon(f?.name)).filter((n) => n.length > 0))
        : null;
    const liveCandidates =
      validFolderNames && Array.isArray(candidates)
        ? candidates.filter((c) => c?.name && validFolderNames.has(candidateCanon(c.name)))
        : candidates;

    if (
      validFolderNames &&
      Array.isArray(candidates) &&
      candidates.length > 0 &&
      liveCandidates.length === 0
    ) {
      logger.info(
        '[FolderMatcher] No vector hit resolved to a current smart folder; preserving LLM category',
        {
          fileId,
          droppedNames: candidates.map((c) => c?.name).filter(Boolean),
          llmCategory: analysis.category
        }
      );
    }

    // Hoisted so the calibration block at the bottom of this function can
    // read it regardless of which override branch fired.
    let llmCategoryUnmatchable = false;

    // Process candidates and potentially override category
    if (Array.isArray(liveCandidates) && liveCandidates.length > 0) {
      logger.debug('[FolderMatcher] Folder matching results', {
        fileId,
        candidateCount: liveCandidates.length,
        topScore: liveCandidates[0]?.score,
        topFolder: liveCandidates[0]?.name
      });

      const top = liveCandidates[0];
      if (top && typeof top === 'object' && typeof top.score === 'number' && top.name) {
        // The analysis pipeline outputs confidence as 0-100 integers.
        // Normalize to 0-1 for comparison with embedding cosine similarity scores.
        const llmConfidence = normalizeLlmConfidence(analysis.confidence);
        const routingMode = await loadSmartFolderRoutingMode();

        const rawCategory = typeof analysis.category === 'string' ? analysis.category.trim() : '';
        const normalizedCategory = rawCategory.toLowerCase();
        const categoryIsGeneric = [
          'image',
          'images',
          'document',
          'documents',
          'file',
          'files',
          'unknown',
          'default',
          'uncategorized'
        ].includes(normalizedCategory);
        const mappedFolder = findSmartFolderForLabel(rawCategory, smartFolders);
        const categoryMatchesFolder = Boolean(
          mappedFolder && !isDefaultCategoryName(mappedFolder.name)
        );
        llmCategoryUnmatchable = categoryIsGeneric || !categoryMatchesFolder;
        const effectiveLlmConfidence = llmCategoryUnmatchable ? 0 : llmConfidence;

        const overrideFloor = llmCategoryUnmatchable
          ? THRESHOLDS.FOLDER_MATCH_UNMATCHED_CATEGORY_FLOOR
          : THRESHOLDS.FOLDER_MATCH_CONFIDENCE;
        const runnerUp = liveCandidates[1];
        const spread = typeof runnerUp?.score === 'number' ? top.score - runnerUp.score : top.score;
        const minSpread = THRESHOLDS.CONFIDENCE_CALIBRATION?.NARROW_SPREAD_THRESHOLD ?? 0.07;
        const meaningFirst =
          routingMode === ROUTING_MODES.EMBEDDING || routingMode === ROUTING_MODES.AUTO;
        const skipOverride = routingMode === ROUTING_MODES.LLM;
        const mappedName = mappedFolder?.name;
        const mappedHit = mappedName
          ? liveCandidates.find(
              (/** @type {any} */ c) =>
                String(c?.name || '').toLowerCase() === String(mappedName).toLowerCase()
            )
          : null;
        const vectorAgrees =
          mappedHit && String(mappedHit.name).toLowerCase() === String(top.name).toLowerCase();

        let shouldOverride = false;
        if (!skipOverride) {
          if (meaningFirst) {
            if (vectorAgrees) {
              shouldOverride = false;
            } else {
              const mappedScore = typeof mappedHit?.score === 'number' ? mappedHit.score : 0;
              shouldOverride =
                top.score >= overrideFloor &&
                spread >= minSpread &&
                top.score - mappedScore >= minSpread;
            }
          } else {
            shouldOverride = top.score >= overrideFloor && top.score > effectiveLlmConfidence;
          }
        }

        if (shouldOverride) {
          logger.info('[FolderMatcher] Embedding override - folder match exceeds LLM confidence', {
            type,
            routingMode,
            llmCategory: analysis.category,
            llmConfidence,
            effectiveLlmConfidence,
            overrideFloor,
            embeddingCategory: top.name,
            embeddingScore: top.score,
            spread
          });
          analysis.llmOriginalCategory = analysis.category;
          analysis.category = top.name;
          analysis.categorySource = 'embedding_override';
          analysis.suggestedFolder = top.name;
          analysis.destinationFolder = top.path || top.name;
        } else if (top.score >= THRESHOLDS.FOLDER_MATCH_CONFIDENCE) {
          logger.debug(
            '[FolderMatcher] LLM category preserved - confidence higher than embedding',
            {
              type,
              routingMode,
              llmCategory: analysis.category,
              llmConfidence,
              effectiveLlmConfidence,
              embeddingCategory: top.name,
              embeddingScore: top.score
            }
          );
          analysis.categorySource = 'llm_preserved';
        }

        // When the LLM produced a meaningful category that doesn't match any
        // existing folder AND no override fired, surface the unmatched theme
        // as a new-folder suggestion. The downstream UI can then offer
        // "Create folder for '<theme>'?" instead of silently routing to
        // Uncategorized via the FolderMatchingService fallback.
        if (
          !shouldOverride &&
          llmCategoryUnmatchable &&
          !categoryIsGeneric &&
          typeof analysis.category === 'string' &&
          analysis.category.trim() &&
          analysis.category.trim().toLowerCase() !== 'uncategorized'
        ) {
          analysis.suggestedNewFolder = stripCategorySubjectSuffix(analysis.category.trim());
          logger.info('[FolderMatcher] Surfacing unmatched LLM category as new-folder suggestion', {
            type,
            suggestedNewFolder: analysis.suggestedNewFolder,
            topEmbeddingCategory: top?.name,
            topEmbeddingScore: top?.score
          });
        }
      }
    } else {
      logger.debug('[FolderMatcher] No folder matches found', { fileId });
    }
    // Preserve the unfiltered candidate list (including phantom hits) for the
    // UI debug surface even when no override fires, so users can see what the
    // vector DB actually returned. Only set when matchVectorToFolders gave us
    // something back.
    if (Array.isArray(candidates) && candidates.length > 0) {
      analysis.folderMatchCandidates = candidates;
    }

    // Calculate confidence percent
    const rawConfidence = analysis.confidence ?? 0;
    const preCalibrationPercent =
      typeof rawConfidence === 'number'
        ? rawConfidence > 1
          ? Math.round(rawConfidence)
          : Math.round(rawConfidence * 100)
        : 0;

    // Sanity-check the LLM's self-reported confidence against the
    // embedding-side discrimination signal. A small quantized model claiming
    // 95% on a route the embedding model can barely tell apart from the
    // runner-up is a false-precision UX trap (see Issue 2: resume → AVA at
    // 95% because both contained "Liberty University"). Caps only — never
    // boosts — and preserves the original for downstream learning signals.
    const topCandidate = Array.isArray(liveCandidates) ? liveCandidates[0] : null;
    const runnerUpCandidate = Array.isArray(liveCandidates) ? liveCandidates[1] : null;
    const calibration = calibrateConfidence({
      rawConfidence: preCalibrationPercent,
      topScore: typeof topCandidate?.score === 'number' ? topCandidate.score : null,
      runnerUpScore: typeof runnerUpCandidate?.score === 'number' ? runnerUpCandidate.score : null,
      llmCategoryUnmatchable
    });
    const confidencePercent = calibration.confidence;
    if (calibration.reason) {
      // Preserve the raw value so future learning / audit can compare
      // self-reported vs calibrated. Surface the binding reason for log /
      // UI debug consumers.
      analysis.rawLlmConfidence = preCalibrationPercent;
      analysis.confidence = confidencePercent;
      analysis.confidenceCalibration = {
        cap: calibration.cap,
        reason: calibration.reason,
        spread: calibration.spread,
        topScore: typeof topCandidate?.score === 'number' ? topCandidate.score : null
      };
      logger.info('[FolderMatcher] Confidence calibrated down', {
        fileId,
        original: preCalibrationPercent,
        calibrated: confidencePercent,
        reason: calibration.reason,
        spread: calibration.spread,
        topScore: typeof topCandidate?.score === 'number' ? topCandidate.score : null
      });
    } else {
      // No calibration fired — still normalize the stored field so downstream
      // consumers see an integer 0-100 regardless of the LLM's output shape.
      analysis.confidence = confidencePercent;
    }

    const overrideCategory =
      analysis.categorySource === 'embedding_override' &&
      typeof analysis.category === 'string' &&
      analysis.category.trim().length > 0
        ? analysis.category
        : null;
    const embeddingCategory =
      overrideCategory || resolvedSmartFolder?.name || analysis.category || 'Uncategorized';

    // Build metadata based on type - comprehensive for chat/search/graph
    const rawType = typeof analysis.type === 'string' ? analysis.type.trim() : '';
    const isGenericType = ['image', 'document', 'file', 'unknown'].includes(rawType.toLowerCase());
    const documentType = analysis.documentType || (!isGenericType && rawType ? rawType : '');
    const baseMeta = {
      path: filePath,
      name: fileName,
      fileExtension: (fileExtension || '').toLowerCase(),
      fileSize,
      category: embeddingCategory,
      confidence: confidencePercent,
      type,
      fileType: type,
      extractionMethod: analysis.extractionMethod || (extractedText ? 'content' : 'analysis'),
      summary: (summaryForEmbedding || analysis.summary || analysis.purpose || '').substring(
        0,
        2000
      ),
      tags: Array.isArray(analysis.keywords) ? analysis.keywords : [],
      keywords: Array.isArray(analysis.keywords) ? analysis.keywords : [],
      date: analysis.documentDate || analysis.date || null,
      suggestedName: analysis.suggestedName,
      keyEntities: Array.isArray(analysis.keyEntities) ? analysis.keyEntities.slice(0, 20) : [],
      // Common fields for all file types
      entity: analysis.entity || '',
      project: analysis.project || '',
      purpose: (analysis.purpose || '').substring(0, 1000),
      reasoning: (analysis.reasoning || '').substring(0, 500),
      documentType,
      extractedText: (extractedText || '').substring(0, 5000),
      smartFolder: resolvedSmartFolder?.name || null,
      smartFolderPath: resolvedSmartFolder?.path || null
    };

    // Add image-specific metadata
    if (type === 'image') {
      /** @type {Record<string, any>} */ (baseMeta).content_type =
        analysis.content_type || 'unknown';
      /** @type {Record<string, any>} */ (baseMeta).colors = Array.isArray(analysis.colors)
        ? analysis.colors
        : [];
      /** @type {Record<string, any>} */ (baseMeta).has_text = analysis.has_text === true;
    }

    if (type !== 'image') {
      // Queue embedding for batch persistence.
      // Scope is controlled by the embeddingScope setting:
      // - 'all_analyzed' (default): embed every analyzed file
      // - 'smart_folders_only': only embed files in a configured smart folder
      const gate = await shouldEmbed({
        stage: 'analysis',
        isInSmartFolder: !!resolvedSmartFolder,
        analysis
      });
      // Surface effective embedding behavior in analysis payload so renderer/UI
      // can explain search readiness per file.
      analysis.embeddingPolicy = gate.policy;
      analysis.embeddingStatus = gate.shouldEmbed ? 'pending' : 'skipped';
      if (gate.shouldEmbed) {
        try {
          await fs.access(filePath);
        } catch {
          logger.warn('[FolderMatcher] File moved/removed before embedding enqueue, skipping', {
            filePath
          });
          analysis._fileMovedDuringAnalysis = true;
          analysis.embeddingStatus = 'skipped';
          return analysis;
        }
        if (ENABLE_PIPELINE_EMBEDDING_QUEUE_WAIT) {
          const queueCapacity =
            typeof embeddingQueueManager.waitForAnalysisQueueCapacity === 'function'
              ? await embeddingQueueManager.waitForAnalysisQueueCapacity({
                  highWatermarkPercent: 75,
                  releasePercent: 50,
                  maxWaitMs: 60000
                })
              : /** @type {{ timedOut: boolean, capacityPercent: number | null }} */ ({
                  timedOut: false,
                  capacityPercent: null
                });
          if (queueCapacity.timedOut) {
            logger.warn(
              '[FolderMatcher] Analysis embedding queue remained saturated before enqueue',
              {
                filePath,
                capacityPercent: queueCapacity.capacityPercent
              }
            );
          }
        }
        // Drop any stale pending items for this file first: re-analysis can
        // produce a different id variant for the same path, and flushing both
        // would write duplicate vector entries for one file.
        if (typeof analysisQueue.removeByFilePath === 'function') {
          analysisQueue.removeByFilePath(filePath);
        }
        await analysisQueue.enqueue({
          id: fileId,
          vector,
          model,
          meta: baseMeta,
          updatedAt: new Date().toISOString()
        });
        // Passage vectors ride the same gate as the file vector. Discover and
        // Downloads used to leave this to the smart-folder watcher, which
        // never sees a Discover-analyzed file (it skips recently organized
        // paths), so those files had no deep-recall leg until a manual
        // Rebuild. The queue persists the file vector; chunks go straight to
        // the store because the queue has no chunk stage.
        if (!isAborted()) {
          await embedFileChunks({
            fileId,
            filePath,
            extractedText,
            embedText: (text) => matcher.embedText(text),
            vectorDb,
            signal
          });
        }
      } else {
        logger.debug('[FolderMatcher] Embedding skipped by policy/timing gate', {
          timing: gate.timing,
          policy: gate.policy,
          filePath
        });
      }
      // Attach precomputed embedding so SmartFolderWatcher can reuse instead of re-embedding
      analysis._embeddingForPersistence = {
        vector,
        model,
        meta: baseMeta,
        wasEnqueued: gate.shouldEmbed
      };
    } else {
      // Images handle their own embedding in the image analysis pipeline
      logger.debug('[FolderMatcher] Skipping image enqueue (handled by image pipeline)', {
        filePath
      });
      // Attach precomputed embedding so SmartFolderWatcher can reuse instead of re-embedding
      analysis._embeddingForPersistence = {
        vector,
        model,
        meta: baseMeta,
        wasEnqueued: false
      };
    }
  } catch (matchError) {
    logger.warn('[FolderMatcher] Folder matching error:', matchError.message);
    // 'pending' is set optimistically (line ~714) before the enqueue. If the
    // capacity wait or enqueue threw, the item was never queued — leaving
    // 'pending' would strand the file as "indexing" forever with nothing to
    // embed it. Downgrade to 'error' (a valid embeddingStatus enum value) so
    // the state reflects that no embedding is queued.
    if (analysis.embeddingStatus === 'pending') {
      analysis.embeddingStatus = 'error';
    }
  }

  return analysis;
}

/**
 * Clear the per-matcher upsert cache so the next analysis re-persists
 * folder embeddings.  Called during reanalysis after the vector DB is wiped.
 *
 * @param {Object} matcher - FolderMatchingService instance
 */
function clearSmartFolderUpsertCache(matcher) {
  if (matcher) {
    matcherFolderUpsertCache.delete(matcher);
  }
}

module.exports = {
  applySemanticFolderMatching,
  buildEmbeddingSummary,
  clearSmartFolderUpsertCache,
  normalizeLlmConfidence,
  calibrateConfidence,
  // For testing
  getServices,
  validateMatcher
};
