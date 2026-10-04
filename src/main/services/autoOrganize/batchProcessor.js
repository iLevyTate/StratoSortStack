// @ts-check
/**
 * Batch Processor
 *
 * Batch processing operations for auto-organize.
 *
 * @module autoOrganize/batchProcessor
 */

const path = require('path');
const { createLogger } = require('../../../shared/logger');
const { TIMEOUTS } = require('../../../shared/performanceConstants');
const { withTimeout } = require('../../../shared/promiseUtils');
const { sanitizeFile } = require('./fileTypeUtils');
const { getFallbackDestination, buildDestinationPath } = require('./folderOperations');
const { safeSuggestion, resolveSuggestionToSmartFolder } = require('./pathUtils');
const { makeUniqueFileName } = require('../../../shared/namingConventions');
const { generateSecureId } = require('./idUtils');
const { holdForReview } = require('./reviewHold');

const logger = createLogger('AutoOrganize-Batch');
const CONFIDENCE_THRESHOLDS = {
  BASE: 0.75, // Minimum confidence for auto-organization
  FALLBACK: 0.3, // Confidence assigned to fallback destinations
  DEFAULT: 0.75 // Default threshold when not specified
};

/**
 * Process batch suggestion results
 * @param {Record<string, any>} batchSuggestions - Batch suggestions from suggestion service
 * @param {Array<any>} files - Files being processed
 * @param {Record<string, any>} options - Processing options (includes confidenceThreshold)
 * @param {Record<string, any>} results - Results object to populate
 * @param {Record<string, any>} suggestionService - Suggestion service for feedback
 * @param {Array<any>} smartFolders - Smart folders
 */
async function processBatchResults(
  batchSuggestions,
  files,
  options,
  results,
  suggestionService,
  smartFolders
) {
  const { confidenceThreshold, defaultLocation, preserveNames } = options;
  const effectiveThreshold = Number.isFinite(confidenceThreshold)
    ? confidenceThreshold
    : CONFIDENCE_THRESHOLDS.DEFAULT;

  const pendingFeedback = [];

  // Track planned destinations within batch to prevent overwrite collisions
  const plannedDestinations = new Map();

  // Create a map of files keyed by path (more stable than name)
  const fileMap = new Map(files.map((f) => [f.path || f.name, f]));

  // Validate groups array defensively
  const groups = Array.isArray(batchSuggestions?.groups) ? batchSuggestions.groups : [];

  for (const group of groups) {
    // Validate group.files is an array before iterating
    if (!Array.isArray(group?.files)) {
      logger.warn('[AutoOrganize] Skipping group with invalid files array', {
        folder: group?.folder || 'unknown'
      });
      continue;
    }

    for (const fileWithSuggestion of group.files) {
      const lookupKey = fileWithSuggestion.path || fileWithSuggestion.name;
      const file = fileMap.get(lookupKey) || fileWithSuggestion;
      let { suggestion } = fileWithSuggestion;
      const confidence = Number.isFinite(fileWithSuggestion?.confidence)
        ? fileWithSuggestion.confidence
        : group.confidence || 0;

      // Ensure we have a valid source path
      const sourcePath = file.path || fileWithSuggestion.path;
      if (!sourcePath) {
        logger.warn('[AutoOrganize] Skipping file with no path', { file: file.name || 'unknown' });
        continue;
      }

      const canonicalSuggestion = resolveSuggestionToSmartFolder(suggestion, smartFolders);

      if (!suggestion) {
        // D2: no suggestion, nothing confident. Offer the rule-based folder
        // for review instead of moving there.
        holdForReview(results, file, {
          explanation: 'No suggestion; held for review',
          fallbackDestination: getFallbackDestination(file, smartFolders, defaultLocation)
        });
        continue;
      }

      // Determine action based on confidence
      if (confidence >= effectiveThreshold && canonicalSuggestion) {
        // High confidence - organize automatically
        // Ensure suggestion folder/path are valid strings
        const safeSuggestionObj = safeSuggestion(canonicalSuggestion);
        let destination = buildDestinationPath(
          file,
          safeSuggestionObj,
          defaultLocation,
          preserveNames
        );
        destination = makeUniqueFileName(destination, plannedDestinations);

        results.organized.push({
          file: sanitizeFile(file),
          suggestion: canonicalSuggestion,
          destination,
          confidence,
          method: 'batch-automatic'
        });

        results.operations.push({
          type: 'move',
          source: sourcePath,
          destination
        });

        // Record feedback for learning (non-blocking with error handling)
        // Promise.resolve().then(): recordFeedback must never throw out of this
        // loop. A synchronous throw (or a non-promise return, which withTimeout
        // treats as a function and whose .catch then throws) aborted the batch
        // after its first file, and the caller re-ran the whole batch, so files
        // already planned for a move were planned twice.
        pendingFeedback.push(
          /** @type {Promise<any>} */ (
            withTimeout(
              Promise.resolve().then(() =>
                suggestionService.recordFeedback(file, canonicalSuggestion, true)
              ),
              TIMEOUTS.API_REQUEST,
              'AutoOrganize feedback'
            )
          ).catch((/** @type {any} */ err) => {
            logger.warn('[AutoOrganize] Failed to record feedback (non-critical):', {
              file: sourcePath,
              error: err.message
            });
          })
        );
      } else if (confidence >= effectiveThreshold && !canonicalSuggestion) {
        results.needsReview.push({
          file: sanitizeFile(file),
          suggestion,
          alternatives: fileWithSuggestion.alternatives,
          confidence,
          explanation:
            'Suggestion did not resolve to a configured smart folder. Review required before moving.'
        });
      } else {
        // D2: below threshold. Held for review with the engine's pick as the
        // suggestion; it used to be moved into Uncategorized.
        holdForReview(results, file, {
          suggestion,
          alternatives: fileWithSuggestion.alternatives,
          confidence,
          explanation: `Batch suggestion with ${Math.round(confidence * 100)}% confidence; held for review.`
        });
      }
    }
  }

  if (pendingFeedback.length > 0) {
    await Promise.allSettled(pendingFeedback);
  }
}

/**
 * Batch organize with automatic confidence-based filtering
 * @param {Array<any>} files - Files to organize
 * @param {Array<any>} smartFolders - Smart folders
 * @param {Record<string, any>} options - Options (includes confidenceThreshold)
 * @param {Record<string, any>} suggestionService - Suggestion service
 * @param {Record<string, any>} thresholds - Confidence thresholds (for backwards compatibility)
 * @param {(...args: any[]) => any} [buildDestFn] - Optional custom buildDestinationPath function
 * @returns {Promise<Object>} Batch results
 */
async function batchOrganize(
  files,
  smartFolders,
  options,
  suggestionService,
  thresholds = {},
  buildDestFn = buildDestinationPath
) {
  const { confidenceThreshold = thresholds.confidence ?? CONFIDENCE_THRESHOLDS.DEFAULT } = options;

  logger.info('[AutoOrganize] Starting batch organization', {
    fileCount: files.length
  });

  // Get batch suggestions
  const batchSuggestions = await suggestionService.getBatchSuggestions(files, smartFolders);

  if (!batchSuggestions?.success) {
    throw new Error('Failed to get batch suggestions');
  }

  /** @type {{ operations: any[], groups: any[], skipped: any[], failed: any[] }} */
  const results = {
    operations: [],
    groups: [],
    skipped: [],
    failed: []
  };
  /** @type {any[]} */
  const pendingFeedback = [];

  // Track planned destinations across all groups in the batch to prevent cross-group collisions
  const plannedDestinations = new Map();

  // Process groups with error handling
  const groups = Array.isArray(batchSuggestions.groups) ? batchSuggestions.groups : [];
  for (const group of groups) {
    if (!Array.isArray(smartFolders) || smartFolders.length === 0) {
      results.skipped.push({
        folder: group.folder,
        files: group.files,
        confidence: group.confidence,
        reason: 'No smart folders configured'
      });
      continue;
    }

    // Validate group.files is an array before iterating
    if (!Array.isArray(group?.files)) {
      logger.warn('[AutoOrganize] Skipping group with invalid files array in batchOrganize', {
        folder: group?.folder || 'unknown'
      });
      continue;
    }
    const groupFiles = group.files;

    try {
      if (group.confidence >= confidenceThreshold) {
        // Auto-approve high confidence groups, but only if they map to a smart folder.
        const canonicalGroup = resolveSuggestionToSmartFolder(group, smartFolders);
        if (!canonicalGroup) {
          // D2: a confident group whose folder is not a configured smart
          // folder is held, not dumped into Uncategorized.
          results.skipped.push({
            folder: group.folder,
            files: group.files,
            confidence: group.confidence,
            reason: 'Not a smart folder; held for review'
          });
          continue;
        }
        const groupOperations = [];
        const groupFailures = [];

        for (const file of groupFiles) {
          if (!file?.path) {
            const timestamp = new Date().toISOString();
            logger.warn('[AutoOrganize] Skipping file with missing path in batch', {
              fileName: file?.name || 'unknown'
            });
            groupFailures.push({
              file,
              error: 'Missing file path',
              filePath: file?.path || null,
              timestamp
            });
            continue;
          }

          try {
            // Ensure folder and path are valid strings
            const safeGroup = safeSuggestion(canonicalGroup);
            const folderName = safeGroup.folder;
            const folderPath = safeGroup.path;

            if (!folderPath) {
              throw new Error('Resolved smart folder is missing a path');
            }

            let destination = buildDestFn(
              file,
              { folder: folderName, path: folderPath },
              options.defaultLocation || 'Documents',
              options.preserveNames
            );

            destination = makeUniqueFileName(destination, plannedDestinations);

            groupOperations.push({
              type: 'move',
              source: file.path,
              destination
            });

            if (file.suggestion) {
              pendingFeedback.push(
                /** @type {Promise<any>} */ (
                  withTimeout(
                    suggestionService.recordFeedback(file, file.suggestion, true),
                    TIMEOUTS.API_REQUEST,
                    'AutoOrganize feedback'
                  )
                ).catch((/** @type {any} */ feedbackError) => {
                  logger.warn('[AutoOrganize] Failed to record feedback for file:', {
                    file: file.path,
                    error: feedbackError.message
                  });
                })
              );
            }
          } catch (fileError) {
            const errorDetails = {
              filePath: file.path,
              fileName: file.name || path.basename(file.path),
              batchId: generateSecureId('batch'),
              timestamp: new Date().toISOString(),
              error: fileError.message,
              errorStack: fileError.stack
            };

            logger.error('[AutoOrganize] Failed to process file in batch:', errorDetails);

            groupFailures.push({
              file,
              error: fileError.message,
              filePath: file.path,
              timestamp: errorDetails.timestamp
            });
          }
        }

        // Add successful operations
        results.operations.push(...groupOperations);

        // Track failed files
        if (groupFailures.length > 0) {
          results.failed.push(...groupFailures);
        }

        // Only add group if at least some files succeeded
        if (groupOperations.length > 0) {
          // Use path-based comparison instead of object reference equality
          const failedPaths = new Set(groupFailures.map((failure) => failure.filePath));
          results.groups.push({
            folder: canonicalGroup.folder,
            files: group.files.filter(
              (/** @type {any} */ f) => f?.path && !failedPaths.has(f.path)
            ),
            confidence: group.confidence,
            autoApproved: true,
            partialSuccess: groupFailures.length > 0
          });
        }
      } else {
        // Skip low confidence groups or groups with no valid smart folder, putting them in skipped/manual review
        results.skipped.push({
          folder: group.folder,
          files: group.files,
          confidence: group.confidence,
          reason: group.confidence < confidenceThreshold ? 'Low confidence' : 'Not a smart folder'
        });
      }
    } catch (groupError) {
      const groupErrorDetails = {
        folder: group.folder,
        folderPath: group.path,
        fileCount: group.files ? group.files.length : 0,
        batchId: generateSecureId('batch'),
        timestamp: new Date().toISOString(),
        error: groupError.message,
        errorStack: groupError.stack
      };

      logger.error('[AutoOrganize] Failed to process group in batch:', groupErrorDetails);

      results.failed.push({
        group: group.folder,
        files: group.files,
        error: groupError.message,
        timestamp: groupErrorDetails.timestamp,
        batchId: groupErrorDetails.batchId
      });
    }
  }

  logger.info('[AutoOrganize] Batch organization complete', {
    operationCount: results.operations.length,
    groupCount: results.groups.length,
    skippedCount: results.skipped.length
  });

  if (pendingFeedback.length > 0) {
    await Promise.allSettled(pendingFeedback);
  }
  return results;
}

module.exports = {
  generateSecureId,
  processBatchResults,
  batchOrganize
};
