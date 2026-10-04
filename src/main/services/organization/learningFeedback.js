// @ts-check
/**
 * Learning Feedback Service
 *
 * Records implicit feedback when files are placed in smart folders,
 * allowing the system to learn from user organization decisions.
 *
 * This captures implicit signals:
 * - Files manually moved to smart folders (user preference)
 * - Files detected in smart folders by SmartFolderWatcher
 * - Existing file distribution in smart folders on startup
 *
 * @module services/organization/learningFeedback
 */

const path = require('path');
const { logger: baseLogger, createLogger } = require('../../../shared/logger');
const { findContainingSmartFolder: findSmartFolderInList } = require('../../../shared/folderUtils');
const { DEBOUNCE } = require('../../../shared/performanceConstants');
const { normalizePathForIndex } = require('../../../shared/pathSanitization');

const logger =
  typeof createLogger === 'function' ? createLogger('Organization:LearningFeedback') : baseLogger;
if (typeof createLogger !== 'function' && logger?.setContext) {
  logger.setContext('Organization:LearningFeedback');
}

/**
 * Sources of implicit feedback - used for analytics and weight adjustment
 */
const FEEDBACK_SOURCES = Object.freeze({
  // User explicitly moved file via UI or file explorer
  MANUAL_MOVE: 'manual_move',
  // File detected by SmartFolderWatcher in a smart folder
  WATCHER_DETECTION: 'watcher_detection',
  // Existing file found during startup scan
  STARTUP_SCAN: 'startup_scan',
  // File organized by auto-organize with user confirmation
  AUTO_ORGANIZE_CONFIRMED: 'auto_organize_confirmed',
  // File drag-dropped to smart folder
  DRAG_DROP: 'drag_drop'
});

/**
 * Confidence multipliers for different feedback sources
 * Higher = more weight in pattern learning
 */
const SOURCE_CONFIDENCE_WEIGHTS = Object.freeze({
  [FEEDBACK_SOURCES.MANUAL_MOVE]: 1.0, // User explicitly chose this
  [FEEDBACK_SOURCES.DRAG_DROP]: 1.0, // Direct user action
  [FEEDBACK_SOURCES.AUTO_ORGANIZE_CONFIRMED]: 0.9, // User approved
  [FEEDBACK_SOURCES.WATCHER_DETECTION]: 0.6, // File appeared, might not be intentional
  [FEEDBACK_SOURCES.STARTUP_SCAN]: 0.4 // Historical, less certainty about intent
});

/**
 * Build a file metadata object for pattern learning
 * @param {string} filePath - Full path to the file
 * @param {Record<string, any>|null} [analysis] - Analysis result if available
 * @returns {Record<string, any>} File metadata for pattern matching
 */
function buildFileMetadata(filePath, analysis = null) {
  const fileName = path.basename(filePath);
  const extension = path.extname(filePath).toLowerCase().replace('.', '');
  // If parent directory pattern matching is needed later, add it then

  return {
    name: fileName,
    path: filePath,
    extension: extension || 'unknown',
    // Include analysis data if available. patternMatcher.extractPattern reads
    // this top-level category for flat metadata like this.
    category: analysis?.category || analysis?.smartFolder || null,
    subject: analysis?.subject || null,
    keywords: analysis?.keywords || analysis?.tags || [],
    confidence: analysis?.confidence || null
  };
}

/**
 * Build a suggestion object representing the destination folder
 * FIX MED-7: Handle edge case where folder name is empty and path ends with separator
 * @param {Record<string, any>} smartFolder - Smart folder object
 * @param {number} confidenceWeight - Confidence multiplier from source
 * @returns {Record<string, any>|null} Suggestion object for pattern recording
 */
function buildFolderSuggestion(smartFolder, confidenceWeight = 1.0) {
  if (!smartFolder || !smartFolder.path) {
    return null;
  }

  // This can happen if path ends with a separator (e.g., '/documents/')
  let folderName = smartFolder.name;
  if (!folderName) {
    folderName = path.basename(smartFolder.path);
  }
  if (!folderName) {
    // Last resort: use the full path or a default
    folderName = smartFolder.path || 'Unknown';
  }

  return {
    folder: folderName,
    path: smartFolder.path,
    folderId: smartFolder.id || null,
    // Base confidence adjusted by source weight
    confidence: 0.85 * confidenceWeight,
    method: 'implicit_feedback',
    isSmartFolder: true,
    description: smartFolder.description || ''
  };
}

/**
 * LearningFeedbackService - Records and processes implicit organization feedback
 */
class LearningFeedbackService {
  /**
   * @param {object} deps - Dependencies
   * @param {object} deps.suggestionService - OrganizationSuggestionService for recording feedback
   * @param {(...args: any[]) => any} deps.getSmartFolders - Function to get current smart folders
   */
  constructor({ suggestionService, getSmartFolders }) {
    /** @type {any} */
    this.suggestionService = suggestionService;
    this.getSmartFolders = getSmartFolders;

    // Debounce tracking to prevent duplicate learning for the same file
    this._recentlyLearned = new Map(); // filePath -> timestamp
    this._dedupeWindowMs = DEBOUNCE.LEARNING_DEDUPE_WINDOW;

    // Stats for monitoring
    /** @type {{ totalLearned: number, corrections: number, bySource: Record<string, number>, lastLearnedAt: string|null }} */
    this.stats = {
      totalLearned: 0,
      corrections: 0,
      bySource: {},
      lastLearnedAt: null
    };

    logger.info('[LearningFeedback] Service initialized');
  }

  /**
   * Find which smart folder a file path belongs to
   * @param {string} filePath - File path to check
   * @returns {Object|null} Smart folder if file is inside one
   */
  findContainingSmartFolder(filePath) {
    const smartFolders = this.getSmartFolders();
    return findSmartFolderInList(filePath, smartFolders);
  }

  /**
   * Check if a folder is still in the registered smart folders list.
   * FIX MEDIUM-7: Prevents recording feedback for folders that have been removed.
   *
   * @param {Record<string, any>} folder - Folder object to validate
   * @returns {boolean} True if folder is registered
   * @private
   */
  _isValidSmartFolder(folder) {
    if (!folder || !folder.path) return false;

    const smartFolders = this.getSmartFolders();
    if (!smartFolders || smartFolders.length === 0) return false;

    // Check if the folder path matches any registered smart folder
    return smartFolders.some(
      (/** @type {any} */ sf) =>
        sf && sf.path && (sf.path === folder.path || (sf.id && sf.id === folder.id))
    );
  }

  /**
   * Record implicit feedback when a file is placed in a smart folder
   *
   * @param {{ filePath: string, smartFolder: Record<string, any>, analysis?: any, source?: string }} params
   * @returns {Promise<boolean>} True if feedback was recorded
   */
  async recordFilePlacement({
    filePath,
    smartFolder,
    analysis = null,
    source = FEEDBACK_SOURCES.MANUAL_MOVE
  }) {
    // Validate inputs
    if (!filePath || !smartFolder || !smartFolder.path) {
      logger.debug('[LearningFeedback] Missing required parameters', { filePath, smartFolder });
      return false;
    }

    // This prevents accumulating stale patterns for removed/renamed folders
    if (!this._isValidSmartFolder(smartFolder)) {
      logger.debug('[LearningFeedback] Folder not in registered smart folders', {
        folder: smartFolder.path
      });
      return false;
    }

    // Check suggestion service availability
    if (!this.suggestionService) {
      logger.warn('[LearningFeedback] Suggestion service not available');
      return false;
    }

    // Dedupe check - avoid learning the same file multiple times in quick
    // succession. Normalized key: the same move can be reported by multiple
    // sources (manual move, watcher, undo-redo) with differing separator or
    // case style on Windows.
    const now = Date.now();
    const dedupeKey = normalizePathForIndex(filePath);
    const lastLearned = this._recentlyLearned.get(dedupeKey);
    if (lastLearned && now - lastLearned < this._dedupeWindowMs) {
      logger.debug('[LearningFeedback] Skipping duplicate learning', { filePath });
      return false;
    }

    try {
      // Build file metadata
      const fileMetadata = buildFileMetadata(filePath, analysis);

      // Get confidence weight for this source
      const confidenceWeight =
        /** @type {Record<string, number>} */ (SOURCE_CONFIDENCE_WEIGHTS)[source] || 0.5;

      // Build suggestion object
      const suggestion = buildFolderSuggestion(smartFolder, confidenceWeight);
      if (!suggestion) {
        logger.debug('[LearningFeedback] Could not build suggestion', { smartFolder });
        return false;
      }

      // Record as positive feedback - user chose this folder for this file type
      await this.suggestionService.recordFeedback(fileMetadata, suggestion, true);

      // Update folder usage stats via pattern matcher
      if (this.suggestionService.patternMatcher) {
        this.suggestionService.patternMatcher.incrementFolderUsage(
          /** @type {any} */ (smartFolder).id || /** @type {any} */ (smartFolder).name
        );
      }

      // Update dedupe tracking
      this._recentlyLearned.set(dedupeKey, now);

      // Cleanup old entries periodically
      if (this._recentlyLearned.size > 1000) {
        this._cleanupDedupeCache(now);
      }

      // Update stats
      this.stats.totalLearned++;
      this.stats.bySource[source] = (this.stats.bySource[source] || 0) + 1;
      this.stats.lastLearnedAt = new Date().toISOString();

      logger.debug('[LearningFeedback] Recorded implicit feedback', {
        file: path.basename(filePath),
        folder: /** @type {any} */ (smartFolder).name,
        source,
        extension: fileMetadata.extension
      });

      return true;
    } catch (error) {
      logger.warn('[LearningFeedback] Failed to record feedback', {
        filePath,
        error: error.message,
        hint: error.message?.includes('Pattern storage failed to load')
          ? 'User patterns not loaded; retry after storage recovers'
          : undefined
      });
      return false;
    }
  }

  /**
   * Record feedback for a file move to a smart folder
   * Convenience method that auto-detects the destination smart folder
   *
   * @param {string} sourcePath - Original file path
   * @param {string} destPath - Destination file path
   * @param {object} analysis - Analysis result if available
   * @param {string} source - Source of the move
   * @returns {Promise<boolean>} True if feedback was recorded
   */
  async recordFileMove(
    sourcePath,
    destPath,
    analysis = null,
    source = FEEDBACK_SOURCES.MANUAL_MOVE
  ) {
    // Find which smart folder the file was moved to
    const smartFolder = this.findContainingSmartFolder(destPath);

    if (!smartFolder) {
      // File wasn't moved to a smart folder - no learning
      logger.debug('[LearningFeedback] Destination is not a smart folder', { destPath });
      return false;
    }

    return this.recordFilePlacement({
      filePath: destPath,
      smartFolder,
      analysis,
      source
    });
  }

  /**
   * Record a correction: a file was organized to a DIFFERENT folder than the
   * AI's category implied. The positive signal for the correct folder is already
   * captured by recordFilePlacement, so this adds the missing *penalty* half —
   * a feedback_reject memory against the wrong folder. Because that memory is
   * embedded on the file's identity (not the volatile LLM category), it
   * down-ranks the wrong folder for semantically-similar future files, letting a
   * repeated mistake self-correct over time (gentle, compounding).
   *
   * @param {{ filePath: string, wrongFolder: string, correctFolder: string, oldCategory?: string|null }} params
   * @returns {Promise<boolean>} True when a correction was recorded
   */
  async recordCorrection({ filePath, wrongFolder, correctFolder, oldCategory = null }) {
    if (!filePath || !wrongFolder || !correctFolder) return false;

    // No genuine divergence: the AI's folder equals where the file actually went.
    if (String(wrongFolder).trim().toLowerCase() === String(correctFolder).trim().toLowerCase()) {
      return false;
    }

    if (typeof this.suggestionService?.recordFeedbackNote !== 'function') {
      return false;
    }

    try {
      const base = path.basename(filePath) || filePath;
      const note =
        `Files like "${base}" do not belong in "${wrongFolder}"` +
        (oldCategory ? ` (auto-labeled "${oldCategory}")` : '') +
        `; they belong in "${correctFolder}".`;

      // accepted=false → a feedback_reject memory whose targetFolder is the wrong
      // folder, which applyFeedbackMemoryAdjustments penalizes for similar files.
      await this.suggestionService.recordFeedbackNote(
        buildFileMetadata(filePath, null),
        { folder: wrongFolder },
        false,
        note,
        { filePath }
      );

      this.stats.corrections = (this.stats.corrections || 0) + 1;
      logger.debug('[LearningFeedback] Recorded correction', {
        file: path.basename(filePath),
        wrongFolder,
        correctFolder
      });
      return true;
    } catch (error) {
      logger.warn('[LearningFeedback] Failed to record correction', {
        filePath,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Take back everything an organize taught us about `filePath` (F-202 /
   * K-12): the placement pattern for the smart folder it landed in, the
   * folder-usage tick, any correction memories recorded for that file, and the
   * dedupe window (so a later re-organize can learn again). Never throws.
   *
   * @param {string} filePath - Where the file landed (the path feedback was keyed on)
   * @returns {Promise<{ patternRetracted: boolean, memoriesRemoved: number }>}
   */
  async retractFileFeedback(filePath) {
    const result = { patternRetracted: false, memoriesRemoved: 0 };
    if (!filePath || !this.suggestionService) return result;

    const smartFolder = this.findContainingSmartFolder(filePath);
    if (smartFolder && typeof this.suggestionService.retractFeedback === 'function') {
      try {
        const suggestion = buildFolderSuggestion(smartFolder, 1);
        const retracted = await this.suggestionService.retractFeedback(
          buildFileMetadata(filePath, null),
          suggestion
        );
        result.patternRetracted = Boolean(retracted?.retracted);
        if (result.patternRetracted) {
          this.suggestionService.patternMatcher?.decrementFolderUsage?.(
            /** @type {any} */ (smartFolder).id || /** @type {any} */ (smartFolder).name
          );
        }
      } catch (error) {
        logger.debug('[LearningFeedback] Pattern retraction failed', {
          filePath,
          error: error.message
        });
      }
    }

    if (typeof this.suggestionService.listFeedbackMemory === 'function') {
      try {
        const key = normalizePathForIndex(filePath);
        const memories = await this.suggestionService.listFeedbackMemory();
        for (const memory of Array.isArray(memories) ? memories : []) {
          if (!memory?.id || !memory.filePath) continue;
          if (normalizePathForIndex(memory.filePath) !== key) continue;
          if (await this.suggestionService.deleteFeedbackMemory?.(memory.id)) {
            result.memoriesRemoved++;
          }
        }
      } catch (error) {
        logger.debug('[LearningFeedback] Correction memory retraction failed', {
          filePath,
          error: error.message
        });
      }
    }

    this._recentlyLearned.delete(normalizePathForIndex(filePath));
    return result;
  }

  /**
   * Learn from existing files in smart folders (startup scan)
   * This builds initial patterns from how files are already organized
   *
   * @param {any} analysisHistoryService - Service to lookup existing analysis
   * @param {{ maxFilesPerFolder?: number, onlyWithAnalysis?: boolean }} [options]
   * @returns {Promise<{scanned: number, learned: number}>}
   */
  async learnFromExistingFiles(analysisHistoryService, options = {}) {
    const { maxFilesPerFolder = 100, onlyWithAnalysis = true } = options;

    const smartFolders = this.getSmartFolders();
    if (!smartFolders || smartFolders.length === 0) {
      logger.info('[LearningFeedback] No smart folders to learn from');
      return { scanned: 0, learned: 0 };
    }

    let scanned = 0;
    let learned = 0;

    logger.info('[LearningFeedback] Starting learning scan', {
      folderCount: smartFolders.length,
      maxFilesPerFolder
    });

    for (const folder of smartFolders) {
      if (!folder || !folder.path) continue;

      try {
        const files = await this._scanFolderFiles(folder.path, maxFilesPerFolder);

        for (const filePath of files) {
          scanned++;

          // Get existing analysis if available
          let analysis = null;
          if (analysisHistoryService) {
            try {
              analysis = await analysisHistoryService.getAnalysisByPath(filePath);
            } catch {
              // Continue without analysis
            }
          }

          // Skip if we require analysis but don't have it
          if (onlyWithAnalysis && !analysis) {
            continue;
          }

          // Record the implicit feedback
          const success = await this.recordFilePlacement({
            filePath,
            smartFolder: folder,
            analysis,
            source: FEEDBACK_SOURCES.STARTUP_SCAN
          });

          if (success) {
            learned++;
          }
        }
      } catch (error) {
        logger.warn('[LearningFeedback] Error scanning folder', {
          folder: folder.path,
          error: error.message
        });
      }
    }

    logger.info('[LearningFeedback] Learning scan complete', { scanned, learned });
    return { scanned, learned };
  }

  /**
   * Scan folder for files (non-recursive, limited)
   * @private
   */
  async _scanFolderFiles(/** @type {any} */ folderPath, /** @type {any} */ maxFiles) {
    const fs = require('fs').promises;
    const files = [];

    try {
      const entries = await fs.readdir(folderPath, { withFileTypes: true });

      for (const entry of entries) {
        if (files.length >= maxFiles) break;

        if (entry.isFile() && !entry.name.startsWith('.')) {
          files.push(path.join(folderPath, entry.name));
        }
      }
    } catch (error) {
      logger.debug('[LearningFeedback] Cannot read folder', {
        folderPath,
        error: error.message
      });
    }

    return files;
  }

  /**
   * Clean up old entries from dedupe cache
   * @private
   */
  _cleanupDedupeCache(/** @type {any} */ now) {
    const cutoff = now - this._dedupeWindowMs * 2;
    for (const [filePath, timestamp] of this._recentlyLearned) {
      if (timestamp < cutoff) {
        this._recentlyLearned.delete(filePath);
      }
    }
  }

  /**
   * Get learning statistics
   * @returns {Record<string, any>} Statistics
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      totalLearned: 0,
      corrections: 0,
      bySource: {},
      lastLearnedAt: null
    };
  }

  /**
   * Shutdown - cleanup resources
   */
  shutdown() {
    this._recentlyLearned.clear();
    logger.debug('[LearningFeedback] Shutdown complete');
  }
}

// Singleton helpers - prefer container when available
/** @type {LearningFeedbackService|null} */
let instance = null;

/**
 * Get the LearningFeedbackService singleton
 * Prefers container resolution, falls back to manual singleton
 * @param {object} deps - Dependencies (only used if container unavailable)
 * @returns {LearningFeedbackService|null}
 */
function getInstance(deps = null) {
  // Try to resolve from container first
  try {
    const { container, ServiceIds } = require('../ServiceContainer');
    if (container && container.has(ServiceIds.LEARNING_FEEDBACK)) {
      return container.resolve(ServiceIds.LEARNING_FEEDBACK);
    }
  } catch {
    // Container not available, use manual singleton
  }

  // Fallback to manual singleton
  if (!instance && deps) {
    instance = new LearningFeedbackService(/** @type {any} */ (deps));
  }
  return instance;
}

/**
 * Reset the singleton (for testing)
 */
function resetInstance() {
  if (instance) {
    instance.shutdown();
    instance = null;
  }
}

module.exports = {
  LearningFeedbackService,
  FEEDBACK_SOURCES,
  getInstance,
  resetInstance,
  buildFileMetadata,
  buildFolderSuggestion
};
