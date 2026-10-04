// @ts-check
/**
 * File Processor
 *
 * Individual file processing and new file monitoring.
 *
 * @module autoOrganize/fileProcessor
 */

const path = require('path');
const fs = require('fs').promises;
const { createLogger } = require('../../../shared/logger');
const { SUPPORTED_IMAGE_EXTENSIONS } = require('../../../shared/constants');
const { crossPlatformBasename } = require('../../../shared/crossPlatformUtils');
const { sanitizeFile } = require('./fileTypeUtils');
const { generateSuggestedNameFromAnalysis } = require('./namingUtils');
const { getFallbackDestination, buildDestinationPath } = require('./folderOperations');
const { safeSuggestion, resolveSuggestionToSmartFolder } = require('./pathUtils');
// FIX C-5: Import from shared idUtils to break circular dependency with batchProcessor
const { generateSecureId } = require('./idUtils');
const { holdForReview } = require('./reviewHold');

const logger = createLogger('AutoOrganize-FileProcessor');
/** Safety-net release for destination collision lock (ms) */
const DESTINATION_LOCK_TTL_MS = 30000;
// FIX CRIT-24: Module-level lock to prevent concurrent processing of the same file
const processingLocks = new Set();
const destinationLocks = new Set();

// Normalize file paths for lock comparison (case-insensitive on Windows)
const normalizeLockPath = (/** @type {any} */ filePath) =>
  process.platform === 'win32' ? path.resolve(filePath).toLowerCase() : path.resolve(filePath);

/**
 * Resolve a destination path against disk + in-memory locks, bumping a numeric
 * suffix until a free slot is found. The acquired lock intentionally survives
 * until the safety-net timeout so the caller can perform the actual move
 * without another concurrent job reusing the same destination first.
 */
async function resolveDestinationCollision(
  /** @type {any} */ initialDestination,
  maxAttempts = 50
) {
  let destination = initialDestination;
  let attempt = 0;
  const ext = path.extname(destination);
  const base = destination.slice(0, destination.length - ext.length);
  let normalizedDest = normalizeLockPath(destination);

  while (attempt < maxAttempts) {
    try {
      await fs.access(destination);
      attempt++;
      destination = `${base}_${attempt + 1}${ext}`;
      normalizedDest = normalizeLockPath(destination);
      continue;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    if (destinationLocks.has(normalizedDest)) {
      attempt++;
      destination = `${base}_${attempt + 1}${ext}`;
      normalizedDest = normalizeLockPath(destination);
      continue;
    }

    destinationLocks.add(normalizedDest);
    const timer = setTimeout(
      () => destinationLocks.delete(normalizedDest),
      DESTINATION_LOCK_TTL_MS
    );
    if (timer && typeof timer.unref === 'function') timer.unref();

    return { destination };
  }

  throw new Error(`Failed to find unique destination after ${maxAttempts} attempts`);
}

/**
 * Get a unique destination path within a batch run to avoid overwriting files
 * with the same name.
 */
function getUniqueBatchDestination(
  /** @type {any} */ initialDestination,
  /** @type {any} */ plannedDestinations
) {
  let attempt = 0;
  let destination = initialDestination;
  const ext = path.extname(destination);
  const base = destination.slice(0, destination.length - ext.length);

  while (plannedDestinations.has(normalizeLockPath(destination)) && attempt < 50) {
    attempt++;
    destination = `${base}_${attempt + 1}${ext}`;
  }

  if (plannedDestinations.has(normalizeLockPath(destination))) {
    // Exhausting the cap and returning anyway would plan two moves onto the
    // same destination — the second silently clobbers the first. Fail this
    // file into the per-file error handling instead.
    throw new Error(
      `Could not find a unique destination for "${initialDestination}" after 50 attempts`
    );
  }

  plannedDestinations.add(normalizeLockPath(destination));
  return destination;
}

/**
 * Process files without analysis (use default folder)
 * @param {Array<any>} files - Files without analysis
 * @param {Array<any>} smartFolders - Smart folders
 * @param {string} [_defaultLocation] - Default location (unused)
 * @param {Record<string, any>} [results] - Results object to populate
 */
async function processFilesWithoutAnalysis(files, smartFolders, _defaultLocation, results) {
  logger.info('[AutoOrganize] Processing files without analysis', {
    count: files.length
  });

  // D2: no analysis means no basis for a destination. Hold every file for
  // review; they used to be moved into the default folder at confidence 0.1.
  for (const file of files) {
    holdForReview(results, file, {
      explanation: 'No analysis available; held for review instead of being moved'
    });
  }
}

/**
 * Process files individually as fallback
 * @param {Array<any>} files - Files to process
 * @param {Array<any>} smartFolders - Smart folders
 * @param {Record<string, any>} options - Processing options (includes confidenceThreshold)
 * @param {Record<string, any>} results - Results object to populate
 * @param {Record<string, any>} suggestionService - Suggestion service
 */
async function processFilesIndividually(files, smartFolders, options, results, suggestionService) {
  const { confidenceThreshold, defaultLocation, preserveNames } = options;
  // FIX: Use user's configured threshold directly - don't override with minimum
  // This allows users to organize files with lower confidence (e.g., filename-only analysis)
  const effectiveThreshold = Number.isFinite(confidenceThreshold) ? confidenceThreshold : 0.75;

  // Initialize planned destinations set to prevent duplicates in same batch
  if (!results._plannedDestinations) {
    results._plannedDestinations = new Set();
  }

  for (const file of files) {
    try {
      // Get suggestion for the file
      let suggestion;
      try {
        suggestion = await suggestionService.getSuggestionsForFile(file, smartFolders, {
          includeAlternatives: false
        });
      } catch (suggestionError) {
        logger.error('[AutoOrganize] Failed to get suggestion for file:', {
          file: file.name,
          error: suggestionError.message
        });

        // D2: the engine failed, so nothing is confident. Offer the rule-based
        // folder as the suggestion instead of moving there at confidence 0.2.
        holdForReview(results, file, {
          explanation: 'Suggestion failed; held for review',
          fallbackDestination: getFallbackDestination(file, smartFolders, defaultLocation)
        });
        continue;
      }

      if (!suggestion || !suggestion.success || !suggestion.primary) {
        // D2: no suggestion, nothing confident. Offer the rule-based folder
        // for review instead of moving there at confidence 0.3.
        holdForReview(results, file, {
          explanation: 'No suggestion; held for review',
          fallbackDestination: getFallbackDestination(file, smartFolders, defaultLocation)
        });
        continue;
      }

      const { primary } = suggestion;
      const confidence = suggestion.confidence || 0;

      const canonicalPrimary = resolveSuggestionToSmartFolder(primary, smartFolders);

      // Determine action based on confidence
      if (confidence >= effectiveThreshold && canonicalPrimary) {
        // High confidence - organize automatically
        const safePrimary = safeSuggestion(canonicalPrimary);
        let destination = buildDestinationPath(file, safePrimary, defaultLocation, preserveNames);
        destination = getUniqueBatchDestination(destination, results._plannedDestinations);

        results.organized.push({
          file: sanitizeFile(file),
          suggestion: canonicalPrimary,
          destination,
          confidence,
          method: 'automatic'
        });

        results.operations.push({
          type: 'move',
          source: file.path,
          destination
        });

        // Record feedback with proper error handling
        try {
          await suggestionService.recordFeedback(file, canonicalPrimary, true);
        } catch (feedbackError) {
          logger.warn('[AutoOrganize] Failed to record feedback (non-critical):', {
            file: file.path,
            error: feedbackError.message
          });
        }
      } else if (confidence >= effectiveThreshold && !canonicalPrimary) {
        // High confidence but unresolved folder => review only (never auto-create unknown destinations)
        results.needsReview.push({
          file: sanitizeFile(file),
          suggestion: primary,
          alternatives: suggestion.alternatives,
          confidence,
          explanation:
            'Suggestion did not resolve to a configured smart folder. Review required before moving.'
        });
      } else {
        // D2: below threshold. Held for review with the engine's pick as the
        // suggestion; it used to be moved into Uncategorized.
        holdForReview(results, file, {
          suggestion: primary,
          alternatives: suggestion.alternatives,
          confidence,
          explanation: suggestion.explanation || 'Below the confidence threshold; held for review'
        });
      }
    } catch (error) {
      const fileErrorDetails = {
        fileName: file.name,
        filePath: file.path,
        fileSize: file.size,
        batchId: generateSecureId('organize'),
        timestamp: new Date().toISOString(),
        error: error.message,
        errorStack: error.stack
      };

      logger.error('[AutoOrganize] Failed to process file:', fileErrorDetails);

      results.failed.push({
        file: sanitizeFile(file),
        reason: error.message,
        filePath: file.path,
        timestamp: fileErrorDetails.timestamp,
        batchId: fileErrorDetails.batchId
      });
    }
  }
}

/**
 * Process a new file for auto-organization
 * @param {string} filePath - File path
 * @param {Array<any>} smartFolders - Smart folders
 * @param {Record<string, any>} options - Options
 * @param {Record<string, any>} suggestionService - Suggestion service
 * @param {any} [_undoRedo] - Unused
 * @returns {Promise<Record<string, any>|null>} Organization result or null
 */
async function processNewFile(filePath, smartFolders, options, suggestionService, _undoRedo) {
  const {
    autoOrganizeEnabled = false,
    // Default confidence threshold - user can override via settings
    confidenceThreshold = 0.75
  } = options;
  // FIX: Use user's configured threshold directly - don't override with minimum
  // This allows users to organize files with lower confidence (e.g., filename-only analysis)
  const effectiveThreshold = Number.isFinite(confidenceThreshold) ? confidenceThreshold : 0.75;

  if (!autoOrganizeEnabled) {
    logger.info('[AutoOrganize] Auto-organize disabled, skipping file:', filePath);
    return null;
  }

  // FIX CRIT-24: Check and acquire lock for this file
  // FIX: Normalize path for case-insensitive comparison on Windows
  const lockKey = normalizeLockPath(filePath);
  if (processingLocks.has(lockKey)) {
    logger.debug('[AutoOrganize] File already being processed, skipping:', filePath);
    return null;
  }
  processingLocks.add(lockKey);
  try {
    // Analyze the file first
    const { analyzeDocumentFile } = require('../../analysis/documentAnalysis');
    const { analyzeImageFile } = require('../../analysis/imageAnalysis');
    const extension = path.extname(filePath).toLowerCase();

    let analysis;
    if (SUPPORTED_IMAGE_EXTENSIONS.includes(extension)) {
      analysis = await analyzeImageFile(filePath, smartFolders);
    } else {
      analysis = await analyzeDocumentFile(filePath, smartFolders);
    }

    if (!analysis || analysis.error) {
      logger.warn('[AutoOrganize] Could not analyze file:', filePath);
      return null;
    }

    // FIX H-4: Re-verify file still exists after analysis (could be deleted during analysis)
    try {
      await fs.access(filePath);
    } catch (accessError) {
      if (accessError.code === 'ENOENT') {
        logger.warn('[AutoOrganize] File no longer exists after analysis:', filePath);
        return null;
      }
      throw accessError;
    }

    // Create file object
    const file = {
      name: crossPlatformBasename(filePath),
      path: filePath,
      extension,
      analysis
    };

    // Apply naming convention if settings are provided
    if (options.namingSettings) {
      try {
        const stats = await fs.stat(filePath);
        const fileTimestamps = {
          created: stats.birthtime,
          modified: stats.mtime
        };

        const suggestedName = generateSuggestedNameFromAnalysis({
          originalFileName: file.name,
          analysis,
          settings: options.namingSettings,
          fileTimestamps
        });

        if (suggestedName) {
          analysis.suggestedName = suggestedName;
          logger.debug('[AutoOrganize] Applied naming convention:', suggestedName);
        }
      } catch (namingError) {
        logger.warn('[AutoOrganize] Failed to apply naming convention:', namingError.message);
      }
    }

    // Get suggestion
    const suggestion = await suggestionService.getSuggestionsForFile(file, smartFolders, {
      includeAlternatives: false
    });

    const canonicalPrimary = resolveSuggestionToSmartFolder(suggestion?.primary, smartFolders);

    // Only auto-organize if confidence is very high and destination resolves to a configured smart folder
    if (suggestion?.success && canonicalPrimary && suggestion.confidence >= effectiveThreshold) {
      const safePrimary = safeSuggestion(canonicalPrimary);
      const initialDest = buildDestinationPath(file, safePrimary, options.defaultLocation, false);
      const resolved = await resolveDestinationCollision(initialDest);
      const destination = resolved.destination;

      logger.info('[AutoOrganize] Auto-organizing new file', {
        file: filePath,
        destination,
        confidence: suggestion.confidence
      });

      // Return the undo action data so the caller can record it AFTER the
      // actual file move succeeds. Recording before the move creates a
      // phantom undo entry if the move later fails.
      const undoAction = {
        type: 'FILE_MOVE',
        data: {
          originalPath: filePath,
          newPath: destination
        },
        timestamp: Date.now(),
        description: `Auto-organized ${file.name}`
      };

      return {
        source: filePath,
        destination,
        analysis,
        confidence: suggestion.confidence,
        analysisConfidence: analysis.confidence,
        suggestion: canonicalPrimary,
        undoAction
      };
    }

    // Decision D2 (2026-09-29): a file that does not clear the threshold, or
    // whose suggestion resolves to no configured smart folder, is HELD where it
    // is and flagged for review. It used to be moved into Uncategorized, which
    // left it both moved and unorganized and contradicted the setting's own
    // copy ("Lower confidence matches require manual review").
    const confidence = suggestion?.confidence || 0;
    const suggestedFolder =
      canonicalPrimary?.name ||
      suggestion?.primary?.folder ||
      suggestion?.primary?.name ||
      (typeof analysis?.category === 'string' ? analysis.category : null);

    logger.info('[AutoOrganize] Holding file for review (not moved)', {
      file: filePath,
      confidence,
      threshold: effectiveThreshold,
      suggestedFolder,
      resolvedToSmartFolder: Boolean(canonicalPrimary)
    });

    return {
      source: filePath,
      destination: null,
      held: true,
      analysis,
      confidence,
      analysisConfidence: analysis.confidence,
      requiresManualReview: true,
      suggestedFolder
    };
  } catch (error) {
    logger.error('[AutoOrganize] Error processing new file:', {
      file: filePath,
      error: error.message
    });
    return null;
  } finally {
    // FIX CRIT-24: Release lock (use normalized key)
    processingLocks.delete(lockKey);
  }
}

module.exports = {
  generateSecureId,
  processFilesWithoutAnalysis,
  processFilesIndividually,
  processNewFile
};
