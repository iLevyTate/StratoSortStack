// @ts-check
/**
 * Auto Organize Service Core
 *
 * Slim coordinator class that composes all auto-organize modules.
 * Extracted from the original 1,214-line AutoOrganizeService.js.
 *
 * @module autoOrganize/AutoOrganizeServiceCore
 */

const { createLogger } = require('../../../shared/logger');
const { BATCH } = require('../../../shared/performanceConstants');
const { DEFAULT_SETTINGS } = require('../../../shared/defaultSettings');

// Import decomposed modules
const { getFileTypeCategory, sanitizeFile } = require('./fileTypeUtils');
const { getFallbackDestination, buildDestinationPath } = require('./folderOperations');
const { processBatchResults, batchOrganize: batchOrganizeHelper } = require('./batchProcessor');
const {
  processFilesWithoutAnalysis,
  processFilesIndividually,
  processNewFile: processNewFileHelper
} = require('./fileProcessor');

// Normalize a confidence value into [0, 1], falling back when invalid
const coerceConfidence = (
  /** @type {any} */ val,
  fallback = DEFAULT_SETTINGS.confidenceThreshold
) => {
  const num = Number(val);
  if (Number.isFinite(num)) {
    return Math.min(1, Math.max(0, num));
  }
  return fallback;
};

const logger = createLogger('AutoOrganizeService');
// Batch size from centralized configuration
const DEFAULT_BATCH_SIZE = BATCH.AUTO_ORGANIZE_BATCH_SIZE;

/**
 * AutoOrganizeService - Handles automatic file organization
 *
 * This service orchestrates automatic file organization using AI-powered suggestions.
 * It uses constructor-based dependency injection for all its dependencies.
 */
class AutoOrganizeServiceCore {
  /**
   * Create an AutoOrganizeService instance
   *
   * @param {object} dependencies - Service dependencies
   * @param {object} dependencies.suggestionService - Organization suggestion service
   * @param {object} dependencies.settingsService - Settings service
   * @param {object} dependencies.folderMatchingService - Folder matching service
   * @param {object} dependencies.undoRedoService - Undo/redo service
   */
  /** @param {{ suggestionService: any, settingsService?: any, folderMatchingService?: any, undoRedoService: any }} deps */
  constructor({ suggestionService, settingsService, folderMatchingService, undoRedoService }) {
    if (!suggestionService) {
      throw new Error('AutoOrganizeServiceCore requires suggestionService');
    }
    if (!undoRedoService) {
      throw new Error('AutoOrganizeServiceCore requires undoRedoService');
    }
    /** @type {Record<string, any>} */
    this.suggestionService = suggestionService;
    this.settings = settingsService;
    this.folderMatcher = folderMatchingService;
    this.undoRedo = undoRedoService;

    // Simplified single confidence threshold (from user settings or default)
    this.thresholds = {
      confidence: DEFAULT_SETTINGS.confidenceThreshold // 0.75 - files must meet this to be auto-organized
    };

    // Keep thresholds in sync with persisted settings without blocking construction.
    // Store the promise so shutdown() can drain it and avoid writing thresholds
    // against a torn-down settings service after teardown begins.
    this._thresholdSyncPromise = this._syncThresholdFromSettingsService().catch(() => {
      // Errors logged inside _syncThresholdFromSettingsService
    });
  }

  /**
   * Apply settings updates (called when renderer saves settings)
   * @param {Record<string, any>} settings
   */
  applySettings(settings) {
    this.thresholds.confidence = coerceConfidence(settings?.confidenceThreshold);
  }

  /**
   * Load thresholds from SettingsService (best effort, non-blocking)
   * Ensures background services honor the persisted confidence threshold
   * even before an explicit onSettingsChanged notification arrives.
   * @private
   */
  async _syncThresholdFromSettingsService() {
    try {
      if (!this.settings || typeof this.settings.load !== 'function') return;
      const loaded = await this.settings.load();
      this.thresholds.confidence = coerceConfidence(
        loaded?.confidenceThreshold,
        DEFAULT_SETTINGS.confidenceThreshold
      );
    } catch (error) {
      logger.warn(
        '[AutoOrganize] Failed to sync confidence threshold from settings:',
        error.message
      );
      this.thresholds.confidence = DEFAULT_SETTINGS.confidenceThreshold;
    }
  }

  /**
   * Sanitize file object for IPC transmission
   */
  _sanitizeFile(/** @type {any} */ file) {
    return sanitizeFile(file);
  }

  /**
   * Automatically organize files based on their analysis
   * Uses batched suggestions for improved performance
   */
  async organizeFiles(
    /** @type {any} */ files,
    /** @type {any} */ smartFolders,
    /** @type {Record<string, any>} */ options = {}
  ) {
    const {
      confidenceThreshold,
      defaultLocation = 'Documents',
      preserveNames = false,
      batchSize = DEFAULT_BATCH_SIZE
    } = options;

    // IMPORTANT: Options may raise the threshold, but must not lower it below the
    // service's configured threshold (which is synced from settings).
    // This prevents callers from accidentally bypassing user safety preferences.
    const baseThreshold = coerceConfidence(
      this.thresholds.confidence,
      DEFAULT_SETTINGS.confidenceThreshold
    );
    const requestedThreshold =
      confidenceThreshold == null ? null : coerceConfidence(confidenceThreshold, baseThreshold);
    const effectiveThreshold =
      requestedThreshold == null ? baseThreshold : Math.max(baseThreshold, requestedThreshold);

    logger.info('[AutoOrganize] Starting automatic organization', {
      fileCount: files.length,
      smartFolderCount: smartFolders.length,
      confidenceThreshold: effectiveThreshold,
      batchSize
    });

    /** @type {{ organized: any[], needsReview: any[], failed: any[], operations: any[] }} */
    const results = {
      organized: [],
      needsReview: [],
      failed: [],
      operations: []
    };

    // Separate files with and without analysis
    const filesWithAnalysis = [];
    const filesWithoutAnalysis = [];

    for (const file of files) {
      if (!file.analysis) {
        filesWithoutAnalysis.push(file);
      } else {
        filesWithAnalysis.push(file);
      }
    }

    // Process files without analysis first (they use the default folder)
    if (filesWithoutAnalysis.length > 0) {
      await processFilesWithoutAnalysis(
        filesWithoutAnalysis,
        smartFolders,
        defaultLocation,
        results
      );
    }

    // Process files with analysis in batches
    if (filesWithAnalysis.length > 0) {
      // Split into batches for efficient processing
      const batches = [];
      for (let i = 0; i < filesWithAnalysis.length; i += batchSize) {
        batches.push(filesWithAnalysis.slice(i, i + batchSize));
      }

      logger.info('[AutoOrganize] Processing files in batches', {
        totalFiles: filesWithAnalysis.length,
        batchCount: batches.length,
        batchSize
      });

      // Process each batch
      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];

        logger.debug('[AutoOrganize] Processing batch', {
          batchIndex: batchIndex + 1,
          totalBatches: batches.length,
          filesInBatch: batch.length
        });

        try {
          // Get batch suggestions - this is the key optimization
          const batchSuggestions = await this.suggestionService.getBatchSuggestions(
            batch,
            smartFolders,
            {
              includeStructureAnalysis: false,
              includeAlternatives: false
            }
          );

          if (
            !batchSuggestions?.success ||
            !batchSuggestions.groups ||
            batchSuggestions.groups.length === 0
          ) {
            // Fallback to individual processing if batch fails
            logger.warn(
              '[AutoOrganize] Batch suggestions failed or empty, falling back to individual processing'
            );
            await processFilesIndividually(
              batch,
              smartFolders,
              { confidenceThreshold: effectiveThreshold, defaultLocation, preserveNames },
              results,
              this.suggestionService
            );
            continue;
          }

          // Process batch results
          await processBatchResults(
            batchSuggestions,
            batch,
            { confidenceThreshold: effectiveThreshold, defaultLocation, preserveNames },
            results,
            this.suggestionService,
            smartFolders
          );

          // Check if any files from the batch weren't processed
          const processedFileIdentifiers = new Set();
          for (const group of batchSuggestions.groups) {
            for (const fileWithSuggestion of group.files) {
              processedFileIdentifiers.add(fileWithSuggestion.path || fileWithSuggestion.name);
            }
          }

          // Process any unprocessed files individually as fallback
          const unprocessedFiles = batch.filter(
            (f) => !processedFileIdentifiers.has(f.path || f.name)
          );
          if (unprocessedFiles.length > 0) {
            logger.debug(
              '[AutoOrganize] Some files not in batch results, processing individually',
              { count: unprocessedFiles.length }
            );
            await processFilesIndividually(
              unprocessedFiles,
              smartFolders,
              { confidenceThreshold: effectiveThreshold, defaultLocation, preserveNames },
              results,
              this.suggestionService
            );
          }
        } catch (error) {
          logger.error('[AutoOrganize] Batch processing failed', {
            batchIndex: batchIndex + 1,
            error: error.message
          });

          // Fall back to individual processing only for the files this batch
          // had not placed yet. Re-running the whole batch planned a second
          // operation for every file processed before the throw.
          const handled = new Set(
            [...results.organized, ...results.needsReview, ...results.failed]
              .map((/** @type {any} */ r) => r?.file?.path || r?.filePath)
              .filter(Boolean)
          );
          const remaining = batch.filter((f) => !handled.has(f.path));
          if (remaining.length > 0) {
            await processFilesIndividually(
              remaining,
              smartFolders,
              { confidenceThreshold: effectiveThreshold, defaultLocation, preserveNames },
              results,
              this.suggestionService
            );
          }
        }
      }
    }

    // Log summary
    logger.info('[AutoOrganize] Organization complete', {
      organized: results.organized.length,
      needsReview: results.needsReview.length,
      failed: results.failed.length
    });

    return results;
  }

  /**
   * Batch organize with automatic confidence-based filtering
   */
  async batchOrganize(
    /** @type {any} */ files,
    /** @type {any} */ smartFolders,
    /** @type {Record<string, any>} */ options = {}
  ) {
    return batchOrganizeHelper(
      files,
      smartFolders,
      options,
      this.suggestionService,
      this.thresholds,
      this.buildDestinationPath.bind(this)
    );
  }

  /**
   * Get fallback destination for files with no good match
   */
  getFallbackDestination(
    /** @type {any} */ file,
    /** @type {any} */ smartFolders,
    /** @type {any} */ defaultLocation
  ) {
    return getFallbackDestination(file, smartFolders, defaultLocation);
  }

  /**
   * Build destination path for a file
   */
  buildDestinationPath(
    /** @type {any} */ file,
    /** @type {any} */ suggestion,
    /** @type {any} */ defaultLocation,
    /** @type {any} */ preserveNames
  ) {
    return buildDestinationPath(file, suggestion, defaultLocation, preserveNames);
  }

  /**
   * Get file type category
   */
  getFileTypeCategory(/** @type {any} */ extension) {
    return getFileTypeCategory(extension);
  }

  /**
   * Monitor and auto-organize new files (for Downloads folder watching)
   */
  async processNewFile(
    /** @type {any} */ filePath,
    /** @type {any} */ smartFolders,
    /** @type {Record<string, any>} */ options = {}
  ) {
    const baseThreshold = coerceConfidence(
      this.thresholds.confidence,
      DEFAULT_SETTINGS.confidenceThreshold
    );
    const requestedThreshold =
      options?.confidenceThreshold == null
        ? null
        : coerceConfidence(options.confidenceThreshold, baseThreshold);
    const effectiveThreshold =
      requestedThreshold == null ? baseThreshold : Math.max(baseThreshold, requestedThreshold);

    const optionsWithThreshold = {
      ...options,
      confidenceThreshold: effectiveThreshold
    };

    return processNewFileHelper(
      filePath,
      smartFolders,
      optionsWithThreshold,
      this.suggestionService,
      this.undoRedo
    );
  }

  /**
   * Get organization statistics
   */
  async getStatistics() {
    return {
      userPatterns: this.suggestionService?.userPatterns?.size ?? 0,
      feedbackHistory: this.suggestionService?.feedbackHistory?.length ?? 0,
      folderUsageStats: this.suggestionService?.folderUsageStats
        ? Array.from(this.suggestionService.folderUsageStats.entries())
        : [],
      thresholds: this.thresholds
    };
  }

  /**
   * Container shutdown hook. The constructor kicks off
   * _syncThresholdFromSettingsService() as fire-and-forget; if shutdown
   * runs before that resolves we want to drain it so we don't write
   * thresholds against a torn-down settings service. Without this method
   * the ServiceContainer logs a "no shutdown()" warning and skips us.
   */
  async shutdown() {
    if (this._thresholdSyncPromise) {
      try {
        await this._thresholdSyncPromise;
      } catch {
        // Errors logged in _syncThresholdFromSettingsService
      }
    }
  }
}

module.exports = AutoOrganizeServiceCore;
