// @ts-check
/**
 * Organization Suggestion Service Core
 *
 * Slim coordinator class that composes the extracted modules.
 * Maintains full backward compatibility with the original API.
 *
 * @module services/organization/OrganizationSuggestionServiceCore
 */

const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const { logger: baseLogger, createLogger } = require('../../../shared/logger');
const { LIMITS } = require('../../../shared/performanceConstants');
const { withTimeout, throwIfAborted } = require('../../../shared/promiseUtils');
const systemAnalytics = require('../../core/systemAnalytics');
const { globalBatchProcessor } = require('../../utils/llmOptimization');
const { getRecommendedConcurrency } = require('../PerformanceService');
const { cosineSimilarity } = require('../../../shared/vectorMath');
const { getSemanticFileId, stripSemanticPrefix } = require('../../../shared/fileIdUtils');
const { normalizePathForIndex } = require('../../../shared/pathSanitization');
const { findDefaultFolder } = require('../autoOrganize/folderOperations');
const { readEmbeddingIndexMetadata } = require('../vectorDb/embeddingIndexMetadata');
const FolderMatchingService = require('../FolderMatchingService');
const { getInstance: getParallelEmbeddingService } = require('../ParallelEmbeddingService');
const { isInteractiveTextRequestActive } = require('../textModelActivity');
const { isGenericClusterLabel } = require('../../../shared/clusterDisplayLabel');
const { isFallbackAnalysis } = require('../../../shared/analysisProvenance');

// Extracted modules
const {
  strategies,
  getFileTypeCategory,
  getStrategyBasedSuggestions,
  getApplicableStrategies,
  selectBestStrategy,
  getFallbackSuggestion
} = require('./strategies');

const { PatternMatcher } = require('./patternMatcher');
const { FeedbackMemoryStore, getMetrics: getFeedbackMetrics } = require('./feedbackMemoryStore');
const {
  buildMemoryEntry,
  applyMemoryRuleAdjustments,
  normalizeText
} = require('./feedbackMemoryUtils');
const { getMetrics: getPatternMetrics } = require('./persistence');

const { rankSuggestions, calculateConfidence, generateExplanation } = require('./suggestionRanker');

const {
  calculateFolderFitScore,
  suggestFolderImprovement,
  suggestNewSmartFolder,
  analyzeFolderStructure,
  identifyMissingCategories,
  findOverlappingFolders
} = require('./folderAnalyzer');

const { getLLMAlternativeSuggestions } = require('./llmSuggester');

const { PatternPersistence } = require('./persistence');

const {
  analyzeFilePatterns,
  generateBatchRecommendations,
  generateFileSummary
} = require('./filePatternAnalyzer');

const logger =
  typeof createLogger === 'function' ? createLogger('OrganizationSuggestionService') : baseLogger;
if (typeof createLogger !== 'function' && logger?.setContext) {
  logger.setContext('OrganizationSuggestionService');
}

const ROUTING_MODES = Object.freeze({
  AUTO: 'auto',
  LLM: 'llm',
  EMBEDDING: 'embedding',
  HYBRID: 'hybrid'
});

const DEFAULT_ROUTING_MODE = ROUTING_MODES.AUTO;

/**
 * Calculate optimal concurrency based on CPU cores
 */
function calculateOptimalConcurrency() {
  const cpuCores = os.cpus().length;
  return Math.min(Math.max(2, Math.floor(cpuCores * 0.75)), 8);
}

function buildSmartFolderIndex(/** @type {any} */ smartFolders = []) {
  const byId = new Map();
  const byName = new Map();
  const byPath = new Map();

  for (const folder of smartFolders) {
    // Validate smartFolders elements
    if (!folder || typeof folder !== 'object') continue;
    if (!folder.id && !folder.name && !folder.path) continue;

    if (folder.id) {
      byId.set(String(folder.id), folder);
    }
    if (folder.name) {
      byName.set(String(folder.name).toLowerCase(), folder);
    }
    if (folder.path) {
      byPath.set(normalizePathForIndex(String(folder.path)), folder);
    }
  }

  return { byId, byName, byPath };
}

function findSmartFolderMatch(/** @type {any} */ suggestion, /** @type {any} */ index) {
  if (!suggestion || !index) return null;

  const idCandidate = suggestion.folderId || suggestion.id;
  if (idCandidate && index.byId.has(String(idCandidate))) {
    return index.byId.get(String(idCandidate));
  }

  if (suggestion.path) {
    const normalizedPath = normalizePathForIndex(String(suggestion.path));
    if (index.byPath.has(normalizedPath)) {
      return index.byPath.get(normalizedPath);
    }
  }

  const nameCandidate = suggestion.folder || suggestion.name;
  if (nameCandidate && index.byName.has(String(nameCandidate).toLowerCase())) {
    return index.byName.get(String(nameCandidate).toLowerCase());
  }

  return null;
}

/**
 * LLM self-confidence for audit only. Do not multiply folder-vector scores by
 * this — a strong description match must not fall below the semantic threshold
 * just because the language model was unsure (or over-sure) about a label.
 *
 * @param {unknown} raw
 * @returns {number}
 */
function normalizeAnalysisConfidence(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0.7;
  if (raw > 1) return Math.max(0, Math.min(1, raw / 100));
  return Math.max(0, Math.min(1, raw));
}

function canonicalizeSuggestionToSmartFolder(
  /** @type {any} */ suggestion,
  /** @type {any} */ index
) {
  if (!suggestion || !index) return suggestion;
  const match = findSmartFolderMatch(suggestion, index);
  if (!match) return null;
  if (typeof match.path !== 'string' || !match.path.trim()) return null;
  return {
    ...suggestion,
    folder: match.name || suggestion.folder,
    path: match.path,
    description: match.description || suggestion.description,
    folderId: match.id || suggestion.folderId,
    isSmartFolder: true
  };
}

/**
 * Test whether a file path lives inside a folder, with a real path-segment
 * boundary check. A naive `startsWith` matches "C:/Docs/Art" against
 * "C:/Docs/Articles/x.pdf", leaking votes/membership between sibling folders
 * that share a name prefix. Both paths are normalized (slashes + case) first.
 *
 * @param {string} childPath - Candidate file/member path
 * @param {string} folderPath - Folder path to test containment against
 * @returns {boolean}
 */
function isPathWithinFolder(childPath, folderPath) {
  if (!childPath || !folderPath) return false;
  const child = normalizePathForIndex(String(childPath));
  let parent = normalizePathForIndex(String(folderPath));
  if (!child || !parent) return false;
  if (child === parent) return true;
  if (!parent.endsWith('/')) parent += '/';
  return child.startsWith(parent);
}

/**
 * OrganizationSuggestionService - AI-powered file organization suggestions
 */
class OrganizationSuggestionServiceCore {
  /**
   * @param {any} [dependencies] - Service dependencies
   */
  constructor(
    {
      vectorDbService,
      folderMatchingService,
      settingsService,
      clusteringService,
      getClusteringService,
      config = {}
    } = /** @type {any} */ ({})
  ) {
    // Validate required dependencies
    if (!vectorDbService) {
      throw new Error('OrganizationSuggestionServiceCore requires vectorDbService dependency');
    }
    if (!folderMatchingService) {
      throw new Error(
        'OrganizationSuggestionServiceCore requires folderMatchingService dependency'
      );
    }
    if (!settingsService) {
      throw new Error('OrganizationSuggestionServiceCore requires settingsService dependency');
    }

    this.vectorDb = vectorDbService;
    this.folderMatcher = folderMatchingService;
    this.settings = settingsService;

    // Lazy getter is preferred as it allows ClusteringService to be resolved when first needed
    this._clusteringService = clusteringService || null;
    this._getClusteringService = getClusteringService || null;

    // Configuration
    const safeConfig = config || {};
    this.config = {
      ...safeConfig,
      semanticMatchThreshold: Number.isFinite(safeConfig.semanticMatchThreshold)
        ? safeConfig.semanticMatchThreshold
        : 0.4,
      strategyMatchThreshold: Number.isFinite(safeConfig.strategyMatchThreshold)
        ? safeConfig.strategyMatchThreshold
        : 0.3,
      patternSimilarityThreshold: Number.isFinite(safeConfig.patternSimilarityThreshold)
        ? safeConfig.patternSimilarityThreshold
        : 0.5,
      topKSemanticMatches: Number.isFinite(safeConfig.topKSemanticMatches)
        ? safeConfig.topKSemanticMatches
        : 8,
      hybridLLMThreshold: Number.isFinite(safeConfig.hybridLLMThreshold)
        ? safeConfig.hybridLLMThreshold
        : 0.55,
      embeddingFirstMinFileEmbeddings: Number.isFinite(safeConfig.embeddingFirstMinFileEmbeddings)
        ? safeConfig.embeddingFirstMinFileEmbeddings
        : 50,
      maxFeedbackHistory: Number.isFinite(safeConfig.maxFeedbackHistory)
        ? safeConfig.maxFeedbackHistory
        : 1000,
      llmTemperature: Number.isFinite(safeConfig.llmTemperature) ? safeConfig.llmTemperature : 0.7,
      llmMaxTokens: Number.isFinite(safeConfig.llmMaxTokens) ? safeConfig.llmMaxTokens : 500,
      // Cluster-based organization settings
      useClusterSuggestions: safeConfig.useClusterSuggestions !== false, // Enabled by default
      clusterBoostFactor: Number.isFinite(safeConfig.clusterBoostFactor)
        ? safeConfig.clusterBoostFactor
        : 1.3, // Boost for cluster-consistent suggestions
      minClusterConfidence: Number.isFinite(safeConfig.minClusterConfidence)
        ? safeConfig.minClusterConfidence
        : 0.5,
      outlierThreshold: Number.isFinite(safeConfig.outlierThreshold)
        ? safeConfig.outlierThreshold
        : 0.3 // Below this = outlier
    };

    // Strategy definitions (from extracted module)
    this.strategies = strategies;

    // Initialize pattern matcher
    this.patternMatcher = new PatternMatcher({
      maxUserPatterns: config.maxUserPatterns || 5000,
      maxMemoryMB: config.maxMemoryMB || 50,
      patternSimilarityThreshold: this.config.patternSimilarityThreshold,
      maxFeedbackHistory: this.config.maxFeedbackHistory
    });

    // Initialize persistence
    this.persistence = new PatternPersistence({
      filename: 'user-patterns.json',
      saveThrottleMs: 5000
    });

    this.feedbackMemoryStore = new FeedbackMemoryStore({
      filename: 'feedback-memory.json',
      saveThrottleMs: 5000
    });

    // Previously, this was fire-and-forget which could cause:
    // 1. Suggestions generated without historical patterns
    // 2. recordFeedback overwriting patterns before they're loaded
    this._loadingPatterns = this._loadPatternsAsync();
    this._loadingFeedbackMemory = this._loadFeedbackMemoryAsync();
    this._rebuildingFeedbackMemory = false;
    /** @type {any} */
    this._lastEmbeddingMismatchSignature = null;
    this._patternsLoaded = false;
  }

  /**
   * FIX: Ensure patterns are loaded before accessing them
   * Must be called by any method that reads or writes patterns
   * @private
   * @returns {Promise<void>}
   */
  async _ensurePatternsLoaded() {
    if (this._patternsLoaded && this._patternsLoadedSuccessfully) {
      return;
    }
    // If loaded but failed, retry loading
    if (this._patternsLoaded && !this._patternsLoadedSuccessfully && !this._loadingPatterns) {
      this._loadingPatterns = this._loadPatternsAsync();
    }
    // Wait for loading if in progress
    if (this._loadingPatterns) {
      await this._loadingPatterns;
    }
    // Note: _patternsLoaded is set by _loadPatternsAsync on success
  }

  async _loadFeedbackMemoryAsync() {
    try {
      await this.feedbackMemoryStore.load();
    } catch (error) {
      logger.warn('Failed to load feedback memory', { error: error.message });
    }
  }

  async _ensureFeedbackMemoryLoaded() {
    if (this._loadingFeedbackMemory) {
      await this._loadingFeedbackMemory;
      this._loadingFeedbackMemory = null;
    }
  }

  async _getRoutingModeSetting() {
    try {
      if (!this.settings || typeof this.settings.load !== 'function') {
        return DEFAULT_ROUTING_MODE;
      }
      const settings = await this.settings.load();
      const mode = String(settings?.smartFolderRoutingMode || DEFAULT_ROUTING_MODE).toLowerCase();
      return Object.values(ROUTING_MODES).includes(/** @type {any} */ (mode))
        ? /** @type {any} */ (mode)
        : DEFAULT_ROUTING_MODE;
    } catch (error) {
      logger.warn('[OrganizationSuggestionService] Failed to load routing mode setting', {
        error: error.message
      });
      return DEFAULT_ROUTING_MODE;
    }
  }

  async _getEmbeddingHealth() {
    let stats;
    try {
      stats = await this.vectorDb.getStats();
    } catch (error) {
      return {
        available: false,
        reason: 'vector_stats_failed',
        error: error.message
      };
    }

    const fileCount = Number(stats?.files ?? 0);
    const folderCount = Number(stats?.folders ?? 0);
    const hasFileEmbeddings = fileCount > 0;
    const hasFolderEmbeddings = folderCount > 0;

    let settings;
    try {
      settings = await this.settings?.load?.();
    } catch {
      settings = null;
    }

    let embeddingIndex;
    try {
      embeddingIndex = await readEmbeddingIndexMetadata();
    } catch {
      embeddingIndex = null;
    }

    const configuredEmbeddingModel = settings?.embeddingModel;
    const embeddingModelMismatch =
      Boolean(embeddingIndex?.model) &&
      typeof configuredEmbeddingModel === 'string' &&
      embeddingIndex.model !== configuredEmbeddingModel;

    if (embeddingModelMismatch) {
      const mismatchSignature = `${embeddingIndex.model}->${configuredEmbeddingModel}`;
      const remediation = {
        action: 'rebuild_embeddings',
        message:
          'Embedding model has changed. Rebuild embeddings to restore semantic folder routing.',
        currentConfiguredModel: configuredEmbeddingModel,
        indexedModel: embeddingIndex.model
      };
      if (this._lastEmbeddingMismatchSignature !== mismatchSignature) {
        this._lastEmbeddingMismatchSignature = mismatchSignature;
        logger.warn(
          '[OrganizationSuggestionService] Embedding model mismatch detected',
          remediation
        );
      }
      return {
        available: false,
        reason: 'embedding_model_mismatch',
        stats,
        embeddingIndex,
        configuredEmbeddingModel,
        remediation
      };
    }

    if (!hasFileEmbeddings && !hasFolderEmbeddings) {
      return {
        available: false,
        reason: 'no_embeddings',
        stats
      };
    }

    // Destination routing compares the file to folder description vectors.
    // File-embedding coverage only matters when those folder vectors are missing
    // (similar-file fallback). Requiring 50 file embeddings demoted Auto to
    // LLM-first even after Smart Folders were already indexed.
    const lowCoverage = hasFolderEmbeddings
      ? false
      : fileCount < this.config.embeddingFirstMinFileEmbeddings;

    const persistenceMetrics = this._getPersistenceMetrics();

    return {
      available: true,
      reason: lowCoverage ? 'partial_embeddings' : 'healthy_embeddings',
      stats,
      embeddingIndex,
      lowCoverage,
      persistenceMetrics
    };
  }

  /**
   * Get persistence metrics for monitoring and debugging
   *
   * @returns {any} Combined metrics from feedback and pattern persistence
   */
  _getPersistenceMetrics() {
    /** @type {Record<string, any>} */
    const emptyMetrics = {
      jsonWrites: 0,
      jsonReads: 0,
      lastSyncAt: null,
      lastError: null
    };

    let feedbackMetrics = emptyMetrics;
    let patternMetrics = emptyMetrics;

    try {
      if (typeof getFeedbackMetrics === 'function') {
        feedbackMetrics = getFeedbackMetrics();
      }
    } catch (err) {
      logger.debug('[OrganizationSuggestionService] Feedback metrics unavailable', {
        error: err?.message
      });
    }

    try {
      if (typeof getPatternMetrics === 'function') {
        patternMetrics = getPatternMetrics();
      }
    } catch (err) {
      logger.debug('[OrganizationSuggestionService] Pattern metrics unavailable', {
        error: err?.message
      });
    }

    return {
      feedback: {
        jsonWrites: feedbackMetrics.jsonWrites,
        jsonReads: feedbackMetrics.jsonReads,
        lastSyncAt: feedbackMetrics.lastSyncAt,
        lastError: feedbackMetrics.lastError
      },
      patterns: {
        jsonWrites: patternMetrics.jsonWrites,
        jsonReads: patternMetrics.jsonReads,
        lastSyncAt: patternMetrics.lastSyncAt,
        lastError: patternMetrics.lastError
      }
    };
  }

  async _resolveRoutingMode() {
    const settingMode = await this._getRoutingModeSetting();
    if (settingMode !== ROUTING_MODES.AUTO) {
      return { mode: settingMode, reason: 'settings_override' };
    }

    const health = await this._getEmbeddingHealth();
    if (!health.available) {
      return { mode: ROUTING_MODES.LLM, reason: health.reason, health };
    }

    if (health.lowCoverage) {
      return { mode: ROUTING_MODES.HYBRID, reason: health.reason, health };
    }

    return { mode: ROUTING_MODES.EMBEDDING, reason: health.reason, health };
  }

  _buildLlmCategorySuggestion(/** @type {any} */ file, /** @type {any} */ smartFolders) {
    const analysis = file?.analysis || {};
    // Prefer short label-like fields. analysis.purpose is a free-text
    // sentence that can latch onto an unrelated folder via token overlap,
    // so it is a LAST resort: only consulted when every label-like field
    // is missing or unmatchably generic ("document", "image", "file").
    // This restores v2.0.9 behavior for the documented case where the
    // LLM produced a meaningful purpose ("Q3 sales pipeline review")
    // alongside a generic category ("document") — pre-fix that file
    // routed to Uncategorized despite carrying a clear signal.
    const GENERIC_CATEGORIES = new Set([
      'document',
      'documents',
      'image',
      'images',
      'file',
      'files',
      'media',
      'misc',
      'miscellaneous',
      'other',
      'uncategorized'
    ]);
    const isGeneric = (/** @type {any} */ value) =>
      typeof value === 'string' && GENERIC_CATEGORIES.has(value.trim().toLowerCase());

    const labelCandidate =
      analysis.smartFolder || analysis.folder || analysis.category || analysis.type;

    let rawCategory = labelCandidate;
    if (
      (typeof rawCategory !== 'string' || !rawCategory.trim() || isGeneric(rawCategory)) &&
      typeof analysis.purpose === 'string' &&
      analysis.purpose.trim()
    ) {
      // Take the first short fragment of `purpose` (up to a clause break)
      // so we don't feed a full sentence into matchCategoryToFolder. The
      // matcher uses token overlap and works best on label-shaped input.
      const fragment = analysis.purpose
        .split(/[.,;:!?\n]/)[0]
        .split(/\s+/)
        .slice(0, 6)
        .join(' ')
        .trim();
      if (fragment) rawCategory = fragment;
    }

    // Ensure rawCategory is string before trim()
    if (typeof rawCategory !== 'string' || !rawCategory.trim()) {
      return null;
    }

    // Rich variant also surfaces `suggestedNewFolder` when the category fell
    // through to Uncategorized — the batch recommendation layer uses it to
    // recommend creating a new folder instead of silently discarding the theme.
    // `.folder` is identical to the old matchCategoryToFolder() return.
    const matchResult = FolderMatchingService.matchCategoryToFolderWithSuggestion(
      rawCategory,
      smartFolders
    );
    const matchedFolder = matchResult.folder;
    const folderMatch = smartFolders.find(
      (/** @type {any} */ f) =>
        String(f?.name || '').toLowerCase() === String(matchedFolder || '').toLowerCase()
    );

    // Verify match quality to avoid boosting fallbacks
    // matchCategoryToFolder may return the first folder as a fallback if no match is found.
    // We only want to boost if the LLM output actually resembles the folder name.
    let isHighQualityMatch = false;
    if (folderMatch) {
      const rawLower = rawCategory.toLowerCase();
      const matchLower = matchedFolder.toLowerCase();

      // Check for exact/partial match or reasonable edit distance
      if (
        rawLower === matchLower ||
        rawLower.includes(matchLower) ||
        matchLower.includes(rawLower)
      ) {
        isHighQualityMatch = true;
      } else {
        const dist = FolderMatchingService.levenshteinDistance(rawLower, matchLower);
        const len = Math.max(rawLower.length, matchLower.length);
        // Allow ~30% difference or up to 3 chars
        if (dist <= 3 || dist / len < 0.3) {
          isHighQualityMatch = true;
        }
      }
    }

    const rawConfidence = Number(analysis.confidence);
    const confidence =
      Number.isFinite(rawConfidence) && rawConfidence > 1
        ? Math.min(1, rawConfidence / 100)
        : Number.isFinite(rawConfidence)
          ? Math.min(1, Math.max(0, rawConfidence))
          : 0.6;

    // If the LLM explicitly categorized it and we matched it to a folder, trust it.
    // A fallback analysis did not come from the LLM: its category is a
    // filename/extension guess, and the 0.95 lift made such guesses clear the
    // auto-organize threshold (0.75) and move files on no content at all.
    const score =
      folderMatch && isHighQualityMatch && !isFallbackAnalysis(analysis)
        ? Math.max(confidence, 0.95)
        : confidence;

    return {
      folder: matchedFolder,
      path: folderMatch?.path || '',
      description: folderMatch?.description || '',
      score: score,
      confidence,
      method: 'llm_category',
      source: 'llm',
      isSmartFolder: Boolean(folderMatch),
      // Present only when the LLM category fell through to Uncategorized; the
      // batch layer groups these into "create a new folder" recommendations.
      suggestedNewFolder: matchResult.suggestedNewFolder || null
    };
  }

  /**
   * FIX: Lazy getter for clustering service
   * Resolves the clustering service on first access to break circular dependencies
   * @returns {any} ClusteringService instance or null if not available
   */
  get clustering() {
    // Return cached instance if available
    if (this._clusteringService) {
      return this._clusteringService;
    }

    // Try lazy resolution if getter is provided
    if (this._getClusteringService && typeof this._getClusteringService === 'function') {
      try {
        this._clusteringService = this._getClusteringService();
        return this._clusteringService;
      } catch (error) {
        logger.warn(
          '[OrganizationSuggestionService] Failed to resolve ClusteringService:',
          error.message
        );
        return null;
      }
    }

    return null;
  }

  /**
   * Load patterns asynchronously
   * @private
   */
  async _loadPatternsAsync() {
    try {
      const stored = await this.persistence.load();
      if (stored) {
        this.patternMatcher.loadPatterns(stored);
      }
      this._patternsLoaded = true;
      this._patternsLoadedSuccessfully = true;
    } catch (error) {
      logger.warn('Failed to load user patterns', { error: error.message });
      // This allows future operations to check if patterns were actually loaded successfully
      this._patternsLoaded = true;
      this._patternsLoadedSuccessfully = false;
    } finally {
      // Clear the loading promise reference
      this._loadingPatterns = null;
    }
  }

  /**
   * Save patterns to storage
   * @private
   */
  async _savePatterns() {
    try {
      const data = this.patternMatcher.exportPatterns();
      await this.persistence.save(data);
    } catch (error) {
      logger.error('Failed to save patterns:', error);
    }
  }

  // Legacy compatibility methods
  async loadUserPatterns() {
    return this._loadPatternsAsync();
  }

  async saveUserPatterns() {
    return this._savePatterns();
  }

  /**
   * Get organization suggestions for a single file
   */
  async getSuggestionsForFile(
    /** @type {any} */ file,
    /** @type {any} */ smartFolders = [],
    /** @type {any} */ options = {}
  ) {
    await this._ensurePatternsLoaded();
    await this._ensureFeedbackMemoryLoaded();

    const {
      includeStructureAnalysis = true,
      includeAlternatives = true,
      allowLlmAlternatives = true,
      // Interactive ranking (the Organize grid) must not wait on text
      // generation: in LLM routing mode that is one call per file. Ranking
      // then uses embeddings, learned patterns and the analysis-time label.
      skipGeneration = false,
      // Folder-improvement candidates are name/keyword overlap scored 0.5-0.9
      // and can outrank a semantic match; a destination ranking leaves them out.
      skipImprovementCandidates = false,
      routingModeOverride,
      routingReason,
      signal
    } = options;

    throwIfAborted(signal, 'Suggestion request cancelled');

    // Validate inputs
    if (!file || typeof file !== 'object') {
      throw new Error('Invalid file object: file must be an object');
    }
    if (!file.name || typeof file.name !== 'string') {
      throw new Error('Invalid file object: file.name is required');
    }
    const providedExtension = typeof file.extension === 'string' ? file.extension.trim() : '';
    const inferredExtension =
      providedExtension ||
      path
        .extname(file.path || file.name || '')
        .replace('.', '')
        .trim();
    if (!inferredExtension) {
      throw new Error('Invalid file object: file.extension is required');
    }
    if (!Array.isArray(smartFolders)) {
      throw new Error('smartFolders must be an array');
    }
    if (file.name.length > LIMITS.MAX_FILENAME_LENGTH) {
      throw new Error('Invalid file object: file.name exceeds maximum length');
    }
    if (inferredExtension.length > 50) {
      throw new Error('Invalid file object: file.extension exceeds maximum length');
    }
    if (!file.path || typeof file.path !== 'string') {
      throw new Error('Invalid file object: file.path is required');
    }

    let normalizedFile = file;
    if (providedExtension !== inferredExtension) {
      normalizedFile = { ...file, extension: inferredExtension };
    }

    let routing = null;
    try {
      // Build folder vectors before Auto decides whether embeddings are
      // "ready". Otherwise Auto with an empty folder index picks LLM-only and
      // skips the upsert that would have made vectors available.
      const skipSmartFolderEmbeddings = options.skipSmartFolderEmbeddings === true;
      const resolvedOverride =
        routingModeOverride && Object.values(ROUTING_MODES).includes(routingModeOverride)
          ? routingModeOverride
          : null;
      const settingMode = resolvedOverride || (await this._getRoutingModeSetting());
      if (
        !skipSmartFolderEmbeddings &&
        settingMode !== ROUTING_MODES.LLM &&
        smartFolders &&
        smartFolders.length > 0
      ) {
        throwIfAborted(signal, 'Suggestion request cancelled');
        await this.ensureSmartFolderEmbeddings(smartFolders);
      }

      routing = resolvedOverride
        ? { mode: resolvedOverride, reason: routingReason || 'override' }
        : await this._resolveRoutingMode();

      if (routing.mode === ROUTING_MODES.LLM) {
        logger.debug('[OrganizationSuggestionService] Routing mode: LLM-only', {
          reason: routing.reason
        });
        if (routing.reason === 'embedding_model_mismatch' && routing.health?.remediation) {
          logger.warn(
            '[OrganizationSuggestionService] Semantic routing disabled until remediation',
            {
              reason: routing.reason,
              remediation: routing.health.remediation
            }
          );
        }
      } else {
        logger.debug('[OrganizationSuggestionService] Routing mode selected', {
          mode: routing.mode,
          reason: routing.reason
        });
      }

      // Get suggestions from all sources
      const semanticMatches =
        routing.mode === ROUTING_MODES.LLM
          ? []
          : await this.getSemanticFolderMatches(normalizedFile, smartFolders);
      const strategyMatches = getStrategyBasedSuggestions(
        normalizedFile,
        smartFolders,
        this.config.strategyMatchThreshold
      );
      const patternMatches = this.patternMatcher.getPatternBasedSuggestions(normalizedFile);

      const semanticTopScore =
        semanticMatches.length > 0 ? Number(semanticMatches[0]?.score || 0) : 0;
      const hybridNeedsLlm =
        routing.mode === ROUTING_MODES.HYBRID &&
        (semanticMatches.length === 0 || semanticTopScore < this.config.hybridLLMThreshold);
      const forceLlmSuggestions = routing.mode === ROUTING_MODES.LLM || hybridNeedsLlm;

      // Request creative LLM alternatives only when allowed, or when LLM is required
      // as the primary decision path (LLM mode / hybrid low-semantic fallback).
      const shouldRequestLlmSuggestions =
        !skipGeneration && (forceLlmSuggestions || (includeAlternatives && allowLlmAlternatives));
      const llmSuggestions = shouldRequestLlmSuggestions
        ? await getLLMAlternativeSuggestions(normalizedFile, smartFolders, {
            ...this.config,
            signal
          })
        : [];

      const llmCategorySuggestion = this._buildLlmCategorySuggestion(normalizedFile, smartFolders);
      // Only let the LLM's explicit category drive ranking when routing actually relies on the LLM.
      // In embedding/hybrid modes, a low-quality/undersized LLM can confidently mislabel files,
      // overpowering semantic routing and causing systematic misclassification.
      const shouldIncludeLlmCategory =
        Boolean(llmCategorySuggestion) &&
        (routing.mode === ROUTING_MODES.LLM ||
          (routing.mode === ROUTING_MODES.HYBRID && hybridNeedsLlm));

      const improvementSuggestions = skipImprovementCandidates
        ? []
        : await this.getImprovementSuggestions(normalizedFile, smartFolders);

      // Get cluster-based suggestions (if clustering is available)
      const clusterSuggestions = await this.getClusterBasedSuggestions(
        normalizedFile,
        smartFolders
      );

      // Combine and tag suggestions
      const allSuggestions = [];
      for (const _m of semanticMatches) {
        const match = /** @type {any} */ (_m);
        match.source = 'semantic';
        allSuggestions.push(match);
      }
      for (const _m of strategyMatches) {
        const match = /** @type {any} */ (_m);
        match.source = 'strategy';
        allSuggestions.push(match);
      }
      for (const _m of patternMatches) {
        const match = /** @type {any} */ (_m);
        match.source = match.method === 'user_pattern' ? 'user_pattern' : 'pattern';
        allSuggestions.push(match);
      }
      for (const _s of llmSuggestions) {
        const suggestion = /** @type {any} */ (_s);
        suggestion.source = suggestion.source || 'llm';
        allSuggestions.push(suggestion);
      }
      if (shouldIncludeLlmCategory) {
        allSuggestions.push(llmCategorySuggestion);
      }
      for (const _s of improvementSuggestions) {
        const suggestion = /** @type {any} */ (_s);
        suggestion.source = 'improvement';
        allSuggestions.push(suggestion);
      }
      for (const _s of clusterSuggestions) {
        const suggestion = /** @type {any} */ (_s);
        suggestion.source = 'cluster';
        allSuggestions.push(suggestion);
      }

      const smartFolderIndex = buildSmartFolderIndex(smartFolders);
      const normalizedSuggestions = allSuggestions
        .map((suggestion) => {
          const canonical = canonicalizeSuggestionToSmartFolder(suggestion, smartFolderIndex);
          if (canonical) return canonical;
          // Demote unresolved suggestions so they cannot dominate ranking/auto-move logic.
          return {
            ...suggestion,
            isSmartFolder: false,
            score: Math.min(Number(suggestion?.score || 0), 0.2),
            confidence: Math.min(Number(suggestion?.confidence || 0), 0.2),
            unresolvedSmartFolder: true
          };
        })
        .filter(Boolean);

      // Rank suggestions (cluster-consistent ones get boosted)
      let rankedSuggestions = rankSuggestions(normalizedSuggestions);

      // Apply additional cluster boost to top suggestions
      rankedSuggestions = await this.boostClusterConsistentSuggestions(
        normalizedFile,
        rankedSuggestions,
        smartFolders
      );

      // Apply memory-based adjustments (natural-language feedback)
      rankedSuggestions = await this.applyFeedbackMemoryAdjustments(
        normalizedFile,
        rankedSuggestions
      );

      let primary = rankedSuggestions.find((suggestion) => suggestion.isSmartFolder) || null;
      if (!primary) {
        const defaultSuggestion = await this._getDefaultFolderSuggestion(
          normalizedFile,
          smartFolders
        );
        if (defaultSuggestion) {
          primary = defaultSuggestion;
          rankedSuggestions = [defaultSuggestion, ...rankedSuggestions];
        } else if (rankedSuggestions.length > 0) {
          primary = rankedSuggestions[0];
        }
      }

      // Get folder improvements
      let folderImprovements = [];
      if (includeStructureAnalysis) {
        folderImprovements = analyzeFolderStructure(
          smartFolders,
          [normalizedFile],
          this.patternMatcher.folderUsageStats
        );
      }

      const primaryFolderName = String(primary?.folder || '').toLowerCase();
      systemAnalytics.recordOrganizationRouting({
        resolvedToUncategorized: primaryFolderName === 'uncategorized',
        reason: primary?.method || primary?.source || routing?.reason || 'primary'
      });

      return {
        success: true,
        primary,
        alternatives: includeAlternatives
          ? rankedSuggestions.filter((suggestion) => suggestion !== primary).slice(0, 5)
          : [],
        strategies: getApplicableStrategies(normalizedFile),
        confidence: calculateConfidence(primary),
        explanation: generateExplanation(primary, normalizedFile),
        folderImprovements,
        routing: {
          mode: routing.mode,
          reason: routing.reason
        },
        remediation: routing.health?.remediation || null
      };
    } catch (error) {
      logger.error('[OrganizationSuggestionService] Failed to get suggestions:', error);
      const fallback = getFallbackSuggestion(normalizedFile, smartFolders);
      const fallbackFolderName = String(fallback?.folder || '').toLowerCase();
      systemAnalytics.recordOrganizationRouting({
        resolvedToUncategorized: fallbackFolderName === 'uncategorized',
        reason: 'error_fallback'
      });
      return {
        success: false,
        error: error.message,
        fallback,
        routing: routing
          ? {
              mode: routing.mode,
              reason: routing.reason
            }
          : null,
        remediation: routing?.health?.remediation || null
      };
    }
  }

  /**
   * Get default folder suggestion when no matches found
   * Uses secure folder creation from folderOperations with proper path validation
   * @private
   */
  async _getDefaultFolderSuggestion(/** @type {any} */ file, /** @type {any} */ smartFolders) {
    // Use shared findDefaultFolder for consistent lookup
    const defaultFolder = findDefaultFolder(smartFolders);

    if (!defaultFolder || !defaultFolder.path) {
      logger.warn('[OrganizationSuggestionService] No default smart folder configured');
      return null;
    }

    return {
      folder: defaultFolder.name,
      path: defaultFolder.path,
      score: 0.1,
      confidence: 0.1,
      method: 'default_fallback',
      description: defaultFolder.description || 'Default folder for unmatched files',
      source: 'default',
      isSmartFolder: true,
      // Consistent return structure (add folderId)
      folderId: defaultFolder.id
    };
  }

  /**
   * Get suggestions for batch organization
   */
  async getBatchSuggestions(
    /** @type {any} */ files,
    /** @type {any} */ smartFolders = [],
    /** @type {any} */ options = {}
  ) {
    const { signal, ...restOptions } = options;
    await this._ensurePatternsLoaded();

    try {
      const settingMode = await this._getRoutingModeSetting();
      if (settingMode !== ROUTING_MODES.LLM && smartFolders && smartFolders.length > 0) {
        await this.ensureSmartFolderEmbeddings(smartFolders);
      }

      const routing = await this._resolveRoutingMode();
      const patterns = analyzeFilePatterns(files);
      const groups = new Map();
      const fileOrder = new Map(
        files.map((/** @type {any} */ f, /** @type {any} */ idx) => [f.path || f.name, idx])
      );

      const chatActive = isInteractiveTextRequestActive();
      const cpuSuggestedConcurrency = chatActive ? 1 : calculateOptimalConcurrency();
      const batchAllowLlmAlternatives =
        typeof restOptions.allowLlmAlternatives === 'boolean'
          ? restOptions.allowLlmAlternatives
          : routing.mode !== ROUTING_MODES.EMBEDDING;

      // LLM-only and hybrid modes can route calls through text inference.
      // Embedding mode should stay on the embedding/vector path unless explicitly configured otherwise.
      const llmPathActive =
        restOptions.skipGeneration !== true &&
        (routing.mode === ROUTING_MODES.LLM ||
          routing.mode === ROUTING_MODES.HYBRID ||
          batchAllowLlmAlternatives);

      let recommendedConcurrency = null;
      try {
        recommendedConcurrency = await getRecommendedConcurrency();
      } catch (error) {
        logger.warn('[OrganizationSuggestionService] Failed to resolve recommended concurrency', {
          error: error?.message
        });
      }

      const textInferenceSlots = Math.max(1, Number(recommendedConcurrency?.maxConcurrent) || 1);
      const embeddingConcurrency = Math.max(
        1,
        Number(recommendedConcurrency?.embeddingConcurrency) || textInferenceSlots
      );
      const resourceCap = llmPathActive ? textInferenceSlots : embeddingConcurrency;
      const effectiveConcurrency = Math.max(1, Math.min(cpuSuggestedConcurrency, resourceCap));

      logger.info('[OrganizationSuggestionService] Processing batch', {
        fileCount: files.length,
        routingMode: routing.mode,
        chatActive,
        llmPathActive,
        allowLlmAlternatives: batchAllowLlmAlternatives,
        cpuSuggestedConcurrency,
        textInferenceSlots,
        embeddingConcurrency,
        effectiveConcurrency
      });

      const batchResult = await globalBatchProcessor.processBatch(
        files,
        async (/** @type {any} */ file) => {
          // Abort immediately if the caller has cancelled the batch
          if (signal?.aborted) {
            return {
              file,
              suggestion: { success: false, error: 'Batch cancelled', fallback: null },
              error: 'Batch cancelled'
            };
          }
          try {
            return await withTimeout(
              (async () => {
                const suggestion = await this.getSuggestionsForFile(file, smartFolders, {
                  ...restOptions,
                  signal,
                  allowLlmAlternatives: batchAllowLlmAlternatives,
                  routingModeOverride: routing.mode,
                  routingReason: routing.reason,
                  skipSmartFolderEmbeddings: true
                });
                return { file, suggestion };
              })(),
              (() => {
                const fileIndex = fileOrder.get(file.path || file.name) || 0;
                const queueWave = Math.floor(fileIndex / Math.max(1, effectiveConcurrency));
                const baseTimeoutMs = effectiveConcurrency === 1 ? 90000 : 60000;
                const queueBudgetPerWaveMs = 20000;
                const maxTimeoutMs = 180000;
                return Math.min(maxTimeoutMs, baseTimeoutMs + queueWave * queueBudgetPerWaveMs);
              })(),
              `Suggestion analysis for ${file.name}`
            );
          } catch (error) {
            logger.warn(`[OrganizationSuggestionService] File suggestion timed out or failed`, {
              file: file.name,
              error: error.message,
              routingMode: routing.mode,
              routingReason: routing.reason
            });
            return {
              file,
              suggestion: {
                success: false,
                error: error.message,
                fallback: null
              },
              error: error.message
            };
          }
        },
        {
          concurrency: effectiveConcurrency,
          stopOnError: false,
          shouldStop: () => signal?.aborted === true
        }
      );

      for (const result of /** @type {any} */ (batchResult).results) {
        if (result.error) {
          logger.warn('[OrganizationSuggestionService] File failed', {
            file: result.file?.name,
            error: result.error
          });
          continue;
        }

        const { file, suggestion } = result;
        if (!suggestion?.success || !suggestion.primary) {
          logger.warn('[OrganizationSuggestionService] Skipping file with no primary suggestion', {
            file: file?.name
          });
          continue;
        }

        // Group by the resolved destination (folderId, else path), NOT the display
        // name. Two distinct smart folders can share a name; keying by name would
        // merge them and route files to whichever path was seen first.
        const primary = suggestion.primary;
        const key = primary?.folderId || primary?.path || primary?.folder || 'Uncategorized';

        if (!groups.has(key)) {
          groups.set(key, {
            folder: primary?.folder || (typeof key === 'string' ? key : 'Uncategorized'),
            path: primary?.path, // Include path for destination building
            folderId: primary?.folderId,
            files: [],
            confidence: 0,
            strategy: primary?.strategy
          });
        }

        // Derive a new-folder theme for files that fell through to
        // Uncategorized so generateBatchRecommendations can recommend creating
        // the folder. Prefer the values the suggestion/analysis already carry;
        // otherwise derive from the raw LLM category so the recommendation
        // fires regardless of routing mode or whether suggestedNewFolder was
        // persisted with the analysis record.
        let suggestedNewFolder =
          primary?.suggestedNewFolder || file?.analysis?.suggestedNewFolder || null;
        if (
          !suggestedNewFolder &&
          String(primary?.folder || '').toLowerCase() === 'uncategorized'
        ) {
          const rawCategory = file?.analysis?.category || '';
          if (rawCategory) {
            suggestedNewFolder =
              FolderMatchingService.matchCategoryToFolderWithSuggestion(rawCategory, smartFolders)
                .suggestedNewFolder || null;
          }
        }

        const group = groups.get(key);
        group.files.push({
          ...file,
          suggestion: suggestion.primary,
          alternatives: suggestion.alternatives,
          confidence: suggestion.confidence,
          explanation: suggestion.explanation,
          suggestedNewFolder
        });

        // Update average confidence (guard against division by zero)
        const fileCount = group.files.length;
        if (fileCount > 0) {
          const currentTotal = group.confidence * (fileCount - 1);
          const newTotal = currentTotal + (suggestion.confidence || 0);
          group.confidence = newTotal / fileCount;
        }
      }

      const recommendations = generateBatchRecommendations(groups, patterns);

      return {
        success: true,
        groups: Array.from(groups.values()),
        patterns,
        recommendations,
        suggestedStrategy: selectBestStrategy(patterns, files),
        routing: {
          mode: routing.mode,
          reason: routing.reason
        },
        remediation: routing.health?.remediation || null
      };
    } catch (error) {
      logger.error('[OrganizationSuggestionService] Batch failed:', error);
      return /** @type {Record<string, any>} */ ({
        success: false,
        error: error.message,
        groups: []
      });
    }
  }

  /**
   * Ensure smart folders have embeddings (batch via FolderMatchingService for cache + enrichment parity).
   */
  async ensureSmartFolderEmbeddings(/** @type {any} */ smartFolders) {
    try {
      if (!smartFolders || smartFolders.length === 0) {
        return 0;
      }

      if (!this.folderMatcher || typeof this.folderMatcher.batchUpsertFolders !== 'function') {
        logger.warn(
          '[OrganizationSuggestionService] Folder matcher batch upsert unavailable; skipping ensure embeddings'
        );
        return 0;
      }

      const validFolders = [];

      for (const folder of smartFolders) {
        if (!folder || typeof folder !== 'object') {
          logger.warn('[OrganizationSuggestionService] Invalid folder object skipped');
          continue;
        }

        const folderName = folder.name || '';
        const baseDesc = folder.description || '';
        const keywords = Array.isArray(folder.keywords) ? folder.keywords : [];
        const keywordParts = keywords
          .map((/** @type {any} */ k) => String(k).trim())
          .filter(Boolean);
        // Same tail as legacy folderText: [name, desc, ...keywords].join(' - ') via enrich(name, tail)
        const descriptionForMatcher = [baseDesc, ...keywordParts].filter(Boolean).join(' - ');

        const legacyJoin = [folderName, baseDesc, ...keywordParts].filter(Boolean).join(' - ');
        if (!legacyJoin.trim()) {
          logger.warn('[OrganizationSuggestionService] Empty folder text skipped');
          continue;
        }

        validFolders.push({
          id: folder.id,
          name: folderName,
          description: descriptionForMatcher,
          path: folder.path || ''
        });
      }

      if (validFolders.length === 0) {
        return 0;
      }

      const upsertResult = await this.folderMatcher.batchUpsertFolders(validFolders, {
        forceRefresh: true
      });

      const upsertedCount = Number(upsertResult?.count) || 0;
      logger.debug(`[OrganizationSuggestionService] Upserted ${upsertedCount} folder embeddings`);
      return upsertedCount;
    } catch (error) {
      logger.warn('[OrganizationSuggestionService] Failed to ensure embeddings:', error);
      return 0;
    }
  }

  /**
   * Get semantic folder matches using embeddings
   * Weights match scores by analysis confidence - low-confidence analyses produce lower folder match scores
   */
  async getSemanticFolderMatches(/** @type {any} */ file, /** @type {any} */ smartFolders) {
    try {
      // Prefer using the file's stored embedding (built from extracted content) when available.
      // This avoids relying on potentially low-quality LLM analysis fields for semantic routing.
      if (this.vectorDb && typeof this.vectorDb.queryFolders === 'function') {
        let fileId = null;
        try {
          fileId = getSemanticFileId(file.path);
        } catch {
          fileId = null;
        }

        if (fileId) {
          const dbMatches = await this.vectorDb.queryFolders(
            fileId,
            this.config.topKSemanticMatches
          );
          if (Array.isArray(dbMatches) && dbMatches.length > 0) {
            const normalizedConfidence = normalizeAnalysisConfidence(file.analysis?.confidence);

            const suggestions = [];
            for (const match of dbMatches) {
              const meta = match?.metadata || {};
              const matchPath = meta.path || meta.folderPath || '';
              const matchName = meta.folderName || '';
              const smartFolder = smartFolders.find(
                (/** @type {any} */ f) =>
                  f?.id === match.id ||
                  (matchPath && f?.path === matchPath) ||
                  f?.name === matchName
              );
              if (!smartFolder) continue;

              const score = Number(match.score || 0);
              if (score < this.config.semanticMatchThreshold) continue;

              suggestions.push({
                folder: smartFolder.name,
                path: smartFolder.path,
                score,
                confidence: score,
                baseScore: match.score,
                analysisConfidence: normalizedConfidence,
                description: smartFolder.description || meta.description,
                method: 'semantic_vector_db',
                isSmartFolder: true
              });
            }

            if (suggestions.length > 0) {
              return suggestions;
            }
          }
        }
      }

      let summary = generateFileSummary(file);

      // Best-effort: for small, text-like files, include a short content snippet to improve
      // semantic routing even when LLM-derived fields are low quality and embeddings aren't ready yet.
      // (Never read large/binary files here — this runs during UI suggestion generation.)
      try {
        const ext = String(file?.extension || '')
          .replace('.', '')
          .trim()
          .toLowerCase();
        const TEXT_LIKE_EXTS = new Set([
          'txt',
          'md',
          'csv',
          'json',
          'yaml',
          'yml',
          'sql',
          'js',
          'jsx',
          'ts',
          'tsx',
          'py',
          'java',
          'go',
          'rs',
          'c',
          'cpp',
          'h',
          'hpp',
          'ini',
          'toml',
          'log'
        ]);
        if (ext && TEXT_LIKE_EXTS.has(ext) && typeof file?.path === 'string' && file.path) {
          const stat = await fs.stat(file.path);
          const maxBytes = 256 * 1024; // 256KB
          if (stat?.isFile?.() && stat.size > 0 && stat.size <= maxBytes) {
            const raw = await fs.readFile(file.path, 'utf8');
            const snippet = String(raw || '').slice(0, 20000);
            if (snippet.trim()) {
              summary = `${summary}\n\nCONTENT:\n${snippet}`;
            }
          }
        }
      } catch {
        // Non-fatal; fall back to summary-only embedding
      }

      const embedding = await this.folderMatcher.embedText(summary);
      if (!embedding || !Array.isArray(embedding.vector) || embedding.vector.length === 0) {
        logger.warn('[OrganizationSuggestionService] Failed to generate embedding for matching', {
          filePath: file.path
        });
        return [];
      }

      const matches = await this.folderMatcher.matchVectorToFolders(
        embedding.vector,
        this.config.topKSemanticMatches
      );

      // Folder cosine is the destination vote. Record LLM confidence for audit
      // but do not shrink a strong folder match when the label was unsure.
      const normalizedConfidence = normalizeAnalysisConfidence(file.analysis?.confidence);

      const suggestions = [];
      for (const match of matches) {
        const smartFolder = smartFolders.find(
          (/** @type {any} */ f) =>
            f?.id === match.folderId || f?.name === match.name || f?.path === match.path
        );

        const score = Number(match.score || 0);

        if (!smartFolder) {
          continue;
        }
        if (score < this.config.semanticMatchThreshold) {
          continue;
        }

        suggestions.push({
          folder: smartFolder.name,
          path: smartFolder.path,
          score,
          confidence: score,
          baseScore: match.score,
          analysisConfidence: normalizedConfidence,
          description: smartFolder.description || match.description,
          method: 'semantic_embedding',
          isSmartFolder: true
        });
      }

      return suggestions;
    } catch (error) {
      logger.warn('[OrganizationSuggestionService] Semantic matching failed:', error);
      return [];
    }
  }

  /**
   * Get improvement suggestions for existing folders
   */
  async getImprovementSuggestions(/** @type {any} */ file, /** @type {any} */ smartFolders) {
    const suggestions = [];

    for (const folder of smartFolders) {
      const fitScore = calculateFolderFitScore(file, folder);

      if (fitScore > 0.3 && fitScore < 0.7) {
        suggestions.push({
          folder: folder.name,
          path: folder.path,
          score: fitScore + 0.2,
          confidence: fitScore,
          description: folder.description,
          improvement: suggestFolderImprovement(file, folder),
          method: 'folder_improvement'
        });
      }
    }

    if (suggestions.length === 0) {
      const newFolderSuggestion = suggestNewSmartFolder(file, smartFolders, getFileTypeCategory);
      if (newFolderSuggestion) {
        suggestions.push(newFolderSuggestion);
      }
    }

    return suggestions;
  }

  /**
   * Propose a new smart folder for a file that doesn't fit the existing set.
   * Public delegate for the suggestions:suggest-new-folder IPC handler, which
   * called this method since its introduction while only the module-level
   * helper existed — every invocation threw and returned an error envelope.
   * @param {any} file
   * @param {any[]} smartFolders
   * @returns {Promise<Record<string, any>|null>} suggestion, or null when the
   *   file has no genuine theme to name a folder after
   */
  async suggestNewSmartFolder(file, smartFolders) {
    return suggestNewSmartFolder(file, smartFolders, getFileTypeCategory);
  }

  /**
   * Record user feedback
   * @returns {Promise<void>}
   */
  async recordFeedback(
    /** @type {any} */ file,
    /** @type {any} */ suggestion,
    /** @type {any} */ accepted,
    /** @type {any} */ note
  ) {
    // This prevents overwriting patterns that haven't been loaded yet
    await this._ensurePatternsLoaded();

    if (!this._patternsLoadedSuccessfully) {
      logger.warn(
        '[OrganizationSuggestionService] Pattern storage failed to load. Attempting to recover...'
      );
      try {
        if (this.persistence && typeof this.persistence.recover === 'function') {
          await this.persistence.recover();
        }
        // Reset to empty state and mark as loaded so we can proceed
        this.patternMatcher.loadPatterns({ patterns: [], feedbackHistory: [] });
        this._patternsLoadedSuccessfully = true;
        logger.info(
          '[OrganizationSuggestionService] Recovery successful. Starting with empty patterns.'
        );
      } catch (recoveryError) {
        throw new Error(
          `Cannot record feedback: Pattern storage failed to load and recovery failed: ${recoveryError.message}`,
          { cause: recoveryError }
        );
      }
    }

    this.patternMatcher.recordFeedback(file, suggestion, accepted);
    if (accepted) {
      await this._maybeStoreAutoFeedbackReason(file, suggestion, note);
    }
    if (suggestion?.note || suggestion?.feedbackNote) {
      logger.debug(
        '[OrganizationSuggestionService] Suggestion contains note field; use recordFeedbackNote.'
      );
    }
    return this._savePatterns();
  }

  async _maybeStoreAutoFeedbackReason(
    /** @type {any} */ file,
    /** @type {any} */ suggestion,
    /** @type {any} */ note
  ) {
    if (!file || !suggestion || note) return;
    const folderLabel = suggestion.folder || suggestion.path;
    if (!folderLabel) return;
    if (suggestion.method === 'implicit_feedback') return;
    if (suggestion.source === 'default' || suggestion.source === 'default_fallback') return;

    await this._ensureFeedbackMemoryLoaded();
    if (!this.feedbackMemoryStore) return;

    const extension = String(file.extension || '')
      .replace('.', '')
      .toLowerCase();
    const category = String(file.analysis?.category || file.category || 'unknown').toLowerCase();
    const autoKey = `${extension || 'unknown'}:${category}:${folderLabel.toLowerCase()}`;

    const existing = await this.feedbackMemoryStore.list();
    if (existing.some((entry) => entry?.autoKey === autoKey)) {
      return;
    }

    const summary = generateFileSummary(file);
    const explanation = suggestion.reasoning || generateExplanation(suggestion, file);
    const baseSummary = summary || file.name || file.path || 'this file';
    const text = normalizeText(
      `Files like "${baseSummary}" belong in "${folderLabel}" because ${explanation || 'this matches your organization preferences'}.`
    );
    if (!text) return;

    const entry = await this.addFeedbackMemory(text, {
      source: 'auto_feedback',
      targetFolder: folderLabel,
      scope: { type: 'folder', value: folderLabel }
    });
    if (!entry) return;

    const rules = [];
    if (extension) {
      rules.push({
        type: 'extension_to_folder',
        extension,
        folder: folderLabel,
        confidence: 0.7
      });
    }

    await this.feedbackMemoryStore.update(
      entry.id,
      {
        autoKey,
        rules,
        updatedAt: new Date().toISOString()
      },
      {}
    );
  }

  async recordFeedbackNote(
    /** @type {any} */ file,
    /** @type {any} */ suggestion,
    /** @type {any} */ accepted,
    /** @type {any} */ note,
    /** @type {{ filePath?: string }} */ extraMetadata = {}
  ) {
    await this._ensureFeedbackMemoryLoaded();
    const normalized = normalizeText(note);
    if (!normalized) return null;

    const entry = await this.addFeedbackMemory(normalized, {
      source: accepted ? 'feedback_accept' : 'feedback_reject',
      targetFolder: suggestion?.folder || null,
      scope: suggestion?.folder ? { type: 'folder', value: suggestion.folder } : { type: 'global' },
      // F-202: remember which file a correction was about so an undo can find it.
      ...(extraMetadata?.filePath ? { filePath: extraMetadata.filePath } : {})
    });
    return entry;
  }

  /**
   * Inverse of `recordFeedback(file, suggestion, true)` (F-202 / K-12): the
   * pattern step and history row are taken back without a penalty.
   * @param {any} file
   * @param {any} suggestion
   * @returns {Promise<{ retracted: boolean }>}
   */
  async retractFeedback(file, suggestion) {
    await this._ensurePatternsLoaded();
    if (!this._patternsLoadedSuccessfully) return { retracted: false };
    const result = this.patternMatcher.retractFeedback(file, suggestion);
    if (result.retracted) {
      await this._savePatterns();
    }
    return result;
  }

  async addFeedbackMemory(/** @type {any} */ text, metadata = {}) {
    await this._ensureFeedbackMemoryLoaded();
    const entry = buildMemoryEntry(text, metadata);
    if (!entry) return null;

    let stored;
    try {
      stored = await this.feedbackMemoryStore.add(entry);
    } catch (storeError) {
      logger.error('[OrganizationSuggestionService] Failed to add feedback memory to store:', {
        error: storeError.message
      });
      return null;
    }

    if (this.vectorDb && this.folderMatcher) {
      try {
        const { vector, model } = await this.folderMatcher.embedText(stored.text);
        const payload = {
          id: stored.id,
          vector,
          metadata: {
            targetFolder: stored.targetFolder,
            source: stored.source,
            model
          },
          document: stored.text
        };
        await this.vectorDb.upsertFeedbackMemory(payload);
        await this.feedbackMemoryStore.update(stored.id, { embeddingModel: model }, {});
      } catch (error) {
        if (String(error.message).includes('dimension mismatch')) {
          logger.warn('[OrganizationSuggestionService] Resetting feedback memory collection');
          await this.vectorDb.resetFeedbackMemory();
          try {
            const { vector, model } = await this.folderMatcher.embedText(stored.text);
            await this.vectorDb.upsertFeedbackMemory({
              id: stored.id,
              vector,
              metadata: {
                targetFolder: stored.targetFolder,
                source: stored.source,
                model
              },
              document: stored.text
            });
            await this.feedbackMemoryStore.update(stored.id, { embeddingModel: model }, {});
          } catch (retryError) {
            logger.warn('[OrganizationSuggestionService] Retry upsert failed', {
              error: retryError.message
            });
            try {
              await this.rebuildFeedbackMemoryEmbeddings();
            } catch (rebuildError) {
              logger.warn('[OrganizationSuggestionService] Feedback memory rebuild failed', {
                error: rebuildError.message
              });
            }
          }
        } else {
          logger.warn('[OrganizationSuggestionService] Failed to upsert feedback memory', {
            error: error.message
          });
        }
      }
    }

    return stored;
  }

  async listFeedbackMemory() {
    await this._ensureFeedbackMemoryLoaded();
    return this.feedbackMemoryStore.list();
  }

  async updateFeedbackMemory(/** @type {any} */ id, /** @type {any} */ text, metadata = {}) {
    await this._ensureFeedbackMemoryLoaded();
    const normalized = normalizeText(text);
    if (!normalized) return null;

    const existingList = await this.feedbackMemoryStore.list();
    const existing = existingList.find((entry) => entry.id === id);
    if (!existing) return null;

    const { rules, targetFolder } = buildMemoryEntry(normalized, metadata) || {};
    const updatedAt = new Date().toISOString();
    const updated = await this.feedbackMemoryStore.update(
      id,
      {
        text: normalized,
        rules: rules || [],
        targetFolder:
          /** @type {any} */ (metadata).targetFolder ||
          targetFolder ||
          existing.targetFolder ||
          null,
        scope: /** @type {any} */ (metadata).scope || existing.scope,
        source: /** @type {any} */ (metadata).source || existing.source,
        updatedAt
      },
      {}
    );

    if (updated && this.vectorDb && this.folderMatcher) {
      try {
        const { vector, model } = await this.folderMatcher.embedText(updated.text);
        await this.vectorDb.upsertFeedbackMemory({
          id: updated.id,
          vector,
          metadata: {
            targetFolder: updated.targetFolder,
            source: updated.source,
            model
          },
          document: updated.text
        });
        await this.feedbackMemoryStore.update(updated.id, { embeddingModel: model }, {});
      } catch (error) {
        if (String(error.message).includes('dimension mismatch')) {
          try {
            await this.rebuildFeedbackMemoryEmbeddings();
          } catch (rebuildError) {
            logger.warn('[OrganizationSuggestionService] Feedback memory rebuild failed', {
              error: rebuildError.message
            });
          }
        } else {
          logger.warn(
            '[OrganizationSuggestionService] Failed to update feedback memory embedding',
            {
              error: error.message
            }
          );
        }
      }
    }

    return updated;
  }

  async deleteFeedbackMemory(/** @type {any} */ id) {
    await this._ensureFeedbackMemoryLoaded();
    const removed = await this.feedbackMemoryStore.remove(id);
    if (removed && this.vectorDb) {
      try {
        await this.vectorDb.deleteFeedbackMemory(id);
      } catch (error) {
        logger.warn('[OrganizationSuggestionService] Failed to delete feedback memory vector', {
          error: error.message
        });
      }
    }
    return removed;
  }

  async applyFeedbackMemoryAdjustments(
    /** @type {any} */ file,
    /** @type {any} */ rankedSuggestions
  ) {
    if (!Array.isArray(rankedSuggestions) || rankedSuggestions.length === 0) {
      return rankedSuggestions;
    }

    const memories = await this.feedbackMemoryStore.list();
    if (!memories || memories.length === 0) {
      return rankedSuggestions;
    }

    let memoryMatches = [];
    if (this.vectorDb && this.folderMatcher) {
      try {
        const summary = generateFileSummary(file);
        const { vector } = await this.folderMatcher.embedText(summary || file.name);
        memoryMatches = await this.vectorDb.queryFeedbackMemory(vector, 5);
        // Validate response is array
        if (!Array.isArray(memoryMatches)) {
          memoryMatches = [];
        }
      } catch (error) {
        logger.warn('[OrganizationSuggestionService] Feedback memory query failed', {
          error: error.message
        });
        if (String(error.message).includes('dimension mismatch')) {
          await this.rebuildFeedbackMemoryEmbeddings();
        }
      }
    }

    const memoryById = new Map(memories.map((entry) => [entry.id, entry]));

    const latestExtensionRules = new Map();
    for (const entry of memories) {
      for (const rule of entry.rules || []) {
        if (rule.type !== 'extension_to_folder') continue;
        const ext = rule.extension?.toLowerCase();
        if (!ext) continue;
        const timestamp = Date.parse(entry.updatedAt || entry.createdAt || 0) || 0;
        const existing = latestExtensionRules.get(ext);
        if (!existing || timestamp > existing.timestamp) {
          latestExtensionRules.set(ext, { rule, timestamp });
        }
      }
    }

    const adjusted = rankedSuggestions.map((suggestion) => {
      const suggestionFolder = suggestion.folder || suggestion.path;
      const baseScore = Number.isFinite(suggestion.weightedScore)
        ? suggestion.weightedScore
        : Number.isFinite(suggestion.score)
          ? suggestion.score
          : Number.isFinite(suggestion.confidence)
            ? suggestion.confidence
            : 0;

      let boost = 0;
      let penalty = 0;

      const extKey = String(file.extension || '')
        .replace('.', '')
        .toLowerCase();
      const latestRule = latestExtensionRules.get(extKey);
      if (latestRule?.rule) {
        const ruleAdjust = applyMemoryRuleAdjustments({
          fileExtension: file.extension,
          suggestionFolder,
          rules: [latestRule.rule]
        });
        boost = Math.max(boost, ruleAdjust.boost);
        penalty = Math.max(penalty, ruleAdjust.penalty);
      }

      for (const match of memoryMatches) {
        const entry = memoryById.get(match.id);
        if (!entry?.targetFolder) continue;
        const folderMatches =
          suggestionFolder && entry.targetFolder.toLowerCase() === suggestionFolder.toLowerCase();

        if (entry.source === 'feedback_reject') {
          if (folderMatches) {
            penalty = Math.max(penalty, Math.min(0.15, match.score * 0.15));
          }
        } else if (folderMatches) {
          boost = Math.max(boost, Math.min(0.15, match.score * 0.15));
        }
      }

      const adjustedScore = Math.max(0, Math.min(1, baseScore + boost - penalty));
      const updated = {
        ...suggestion,
        score: adjustedScore,
        confidence: adjustedScore,
        weightedScore: adjustedScore
      };

      if (boost > 0 || penalty > 0) {
        updated.memoryAdjustment = {
          boost,
          penalty
        };
      }

      return updated;
    });

    return adjusted.sort(
      (a, b) => (b.weightedScore || b.score || 0) - (a.weightedScore || a.score || 0)
    );
  }

  async rebuildFeedbackMemoryEmbeddings() {
    if (this._rebuildingFeedbackMemory) return;
    if (!this.vectorDb || !this.folderMatcher) return;
    this._rebuildingFeedbackMemory = true;
    try {
      const entries = await this.feedbackMemoryStore.list();
      if (!entries || entries.length === 0) return;
      await this.vectorDb.resetFeedbackMemory();

      const embeddingService = getParallelEmbeddingService();
      const items = entries.map((entry) => ({
        id: entry.id,
        text: entry.text,
        meta: {}
      }));
      const { results, errors } = await embeddingService.batchEmbedTexts(items, {
        stopOnError: false
      });

      if (Array.isArray(errors) && errors.length > 0) {
        logger.debug('[OrganizationSuggestionService] Some feedback memory embeddings failed', {
          failed: errors.length,
          total: entries.length
        });
      }

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const r = results[i];
        if (!r || !r.success || !Array.isArray(r.vector) || r.vector.length === 0) {
          logger.warn('[OrganizationSuggestionService] Failed to rebuild memory entry', {
            id: entry.id,
            error: r?.error || 'no vector'
          });
          continue;
        }
        try {
          await this.vectorDb.upsertFeedbackMemory({
            id: entry.id,
            vector: r.vector,
            metadata: {
              targetFolder: entry.targetFolder,
              source: entry.source,
              model: r.model
            },
            document: entry.text
          });
          await this.feedbackMemoryStore.update(entry.id, { embeddingModel: r.model }, {});
        } catch (error) {
          logger.warn('[OrganizationSuggestionService] Failed to rebuild memory entry', {
            id: entry.id,
            error: error.message
          });
        }
      }
    } finally {
      this._rebuildingFeedbackMemory = false;
    }
  }

  /**
   * Analyze folder structure
   */
  async analyzeFolderStructure(/** @type {any} */ smartFolders, /** @type {any} */ files = []) {
    return analyzeFolderStructure(smartFolders, files, this.patternMatcher.folderUsageStats);
  }

  /**
   * Extract pattern from file and suggestion
   * @param {any} file - File object
   * @param {any} suggestion - Suggestion object
   * @returns {Object|null} Extracted pattern
   */
  extractPattern(file, suggestion = null) {
    return this.patternMatcher.extractPattern(file, suggestion);
  }

  /**
   * Identify missing categories based on files
   * @param {any[]} smartFolders - Smart folders
   * @param {any[]} files - Files to analyze
   * @returns {any[]} Missing categories
   */
  identifyMissingCategories(smartFolders, files) {
    return identifyMissingCategories(smartFolders, files);
  }

  /**
   * Find overlapping folders
   * @param {any[]} smartFolders - Smart folders to analyze
   * @returns {any[]} Overlapping folder pairs
   */
  findOverlappingFolders(smartFolders) {
    return findOverlappingFolders(smartFolders);
  }

  // ============================================================================
  // Cluster-Based Organization Methods
  // ============================================================================

  /**
   * Get cluster-based suggestions for a file
   * Uses cluster membership to suggest organizing files with their cluster peers
   *
   * @param {any} file - File to get suggestions for
   * @param {any[]} smartFolders - Available smart folders
   * @returns {Promise<any[]>} Cluster-based suggestions
   */
  async getClusterBasedSuggestions(file, smartFolders) {
    if (!this.clustering || !this.config.useClusterSuggestions) {
      return [];
    }

    try {
      const fileId = getSemanticFileId(file.path);

      // Ensure clusters are computed (use cached if fresh)
      if (this.clustering.isClustersStale()) {
        await this.clustering.computeClusters('auto');
      }

      // Find which cluster this file belongs to
      const clusters = this.clustering.clusters || [];
      let fileCluster = null;
      let fileClusterScore = 0;

      for (const cluster of clusters) {
        const member = cluster.members?.find((/** @type {any} */ m) => m.id === fileId);
        if (member) {
          // Calculate how central this file is to the cluster
          const centroid = this.clustering.centroids[cluster.id];
          if (centroid && member.embedding) {
            fileClusterScore = cosineSimilarity(member.embedding, centroid);
          } else {
            fileClusterScore = 0.7; // Default if no embedding available
          }
          fileCluster = cluster;
          break;
        }
      }

      if (!fileCluster || fileClusterScore < this.config.minClusterConfidence) {
        return [];
      }

      // Get the most common folder assignments for cluster members
      const folderVotes = new Map();
      const clusterMembers = fileCluster.members || [];

      for (const member of clusterMembers) {
        if (member.id === fileId) continue;

        const memberPath = member.metadata?.path || stripSemanticPrefix(member.id);
        // Check if this cluster member has been organized to a smart folder
        for (const folder of smartFolders) {
          if (isPathWithinFolder(memberPath, folder.path)) {
            const current = folderVotes.get(folder.path) || { folder, count: 0, totalScore: 0 };
            current.count++;
            current.totalScore += member.score || 0.5;
            folderVotes.set(folder.path, current);
          }
        }
      }

      // Convert votes to suggestions
      const suggestions = [];
      for (const [, vote] of folderVotes) {
        const avgScore = vote.count > 0 ? vote.totalScore / vote.count : 0;
        const memberCount = clusterMembers.length || 1;
        const clusterConsistency = memberCount > 0 ? vote.count / memberCount : 0;

        suggestions.push({
          folder: vote.folder.name,
          path: vote.folder.path,
          score: avgScore * clusterConsistency * this.config.clusterBoostFactor,
          confidence: clusterConsistency,
          description: vote.folder.description,
          method: 'cluster_membership',
          clusterLabel: fileCluster.label || `Cluster ${fileCluster.id}`,
          clusterSize: clusterMembers.length,
          clusterPeersInFolder: vote.count,
          isSmartFolder: true
        });
      }

      // If no cluster members are in folders yet, suggest based on cluster label
      if (suggestions.length === 0 && fileCluster.label) {
        const labelLower = fileCluster.label.toLowerCase();
        for (const folder of smartFolders) {
          const folderNameLower = (folder?.name || '').toLowerCase();
          const folderDescLower = (folder?.description || '').toLowerCase();
          if (!folderNameLower && !folderDescLower) {
            continue;
          }

          // Check if folder name/description matches cluster label
          if (
            folderNameLower.includes(labelLower) ||
            labelLower.includes(folderNameLower) ||
            folderDescLower.includes(labelLower)
          ) {
            suggestions.push({
              folder: folder.name,
              path: folder.path,
              score: 0.6 * this.config.clusterBoostFactor,
              confidence: 0.6,
              description: folder.description,
              method: 'cluster_label_match',
              clusterLabel: fileCluster.label,
              clusterSize: clusterMembers.length,
              isSmartFolder: true
            });
          }
        }
      }

      return suggestions.sort((a, b) => b.score - a.score);
    } catch (error) {
      logger.warn('[OrganizationSuggestionService] Cluster suggestions failed:', error);
      return [];
    }
  }

  /**
   * Get batch suggestions organized by clusters
   * Groups files by their cluster and suggests organizing each cluster together
   *
   * @param {any[]} files - Files to organize
   * @param {any[]} smartFolders - Available smart folders
   * @returns {Promise<Object>} Cluster-based batch suggestions
   */
  async getClusterBatchSuggestions(files, smartFolders = []) {
    if (!this.clustering) {
      return { success: false, error: 'Clustering service not available', groups: [] };
    }

    try {
      // Ensure clusters are fresh
      const computeResult = await this.clustering.computeClusters('auto');
      if (!computeResult.success) {
        return { success: false, error: computeResult.error, groups: [] };
      }

      // Phase 1: fast metadata labels (no LLM) so suggestions have usable cluster names.
      await this.clustering.generateClusterLabels({ skipLLM: true });

      // Phase 2: optional LLM refinement when memory allows — best-effort, non-blocking.
      if (this.clustering.llama?.canRunOptionalInference?.('text')) {
        this.clustering
          .generateClusterLabels({ skipLLM: false })
          .catch((/** @type {any} */ err) => {
            logger.warn(
              '[OrganizationSuggestionService] Background cluster label refinement failed:',
              err?.message
            );
          });
      }

      const clusters = this.clustering.clusters || [];
      const fileIdSet = new Set(
        files
          .map((f) => {
            try {
              return getSemanticFileId(f.path);
            } catch {
              logger.warn('[OrganizationSuggestionService] Failed to get file ID:', f.path);
              return null;
            }
          })
          .filter(Boolean)
      );
      const groups = [];
      const outliers = [];

      // Group files by cluster
      for (const cluster of clusters) {
        const clusterFiles = [];
        const members = cluster.members || [];

        for (const member of members) {
          if (fileIdSet.has(member.id)) {
            const file = files.find((f) => getSemanticFileId(f.path) === member.id);
            if (file) {
              clusterFiles.push({
                ...file,
                clusterScore: member.score || 0.7
              });
            }
          }
        }

        if (clusterFiles.length > 0) {
          // Find best folder for this cluster
          const clusterSuggestion = await this._suggestFolderForCluster(cluster, smartFolders);

          groups.push({
            clusterId: cluster.id,
            clusterLabel: cluster.label || `Cluster ${cluster.id + 1}`,
            files: clusterFiles,
            fileCount: clusterFiles.length,
            suggestedFolder: clusterSuggestion,
            confidence: clusterSuggestion?.confidence || 0.5,
            method: 'cluster_batch'
          });
        }
      }

      // Find files not in any cluster (outliers)
      const clusteredFileIds = new Set();
      for (const cluster of clusters) {
        for (const member of cluster.members) {
          clusteredFileIds.add(member.id);
        }
      }

      for (const file of files) {
        const fileId = getSemanticFileId(file.path);
        if (!clusteredFileIds.has(fileId)) {
          outliers.push({
            ...file,
            reason: 'not_in_cluster'
          });
        }
      }

      return {
        success: true,
        groups: groups.sort((a, b) => b.fileCount - a.fileCount),
        outliers,
        totalClustered: groups.reduce((sum, g) => sum + g.fileCount, 0),
        totalOutliers: outliers.length,
        clusterCount: groups.length
      };
    } catch (error) {
      logger.error('[OrganizationSuggestionService] Cluster batch suggestions failed:', error);
      return { success: false, error: error.message, groups: [] };
    }
  }

  /**
   * Suggest the best folder for a cluster
   * @private
   */
  async _suggestFolderForCluster(/** @type {any} */ cluster, /** @type {any} */ smartFolders) {
    if (!smartFolders || smartFolders.length === 0) {
      return null;
    }

    // Try to match cluster label to folder
    const labelLower = (cluster.label || '').toLowerCase();

    // First pass: exact or close match on folder name
    for (const folder of smartFolders) {
      const folderNameLower = (folder?.name || '').toLowerCase();
      if (!folderNameLower) {
        continue;
      }
      if (folderNameLower === labelLower || folderNameLower.includes(labelLower)) {
        return {
          folder: folder.name,
          path: folder.path,
          confidence: 0.85,
          method: 'cluster_label_match'
        };
      }
    }

    // Second pass: keyword overlap
    // Limit split results to prevent memory issues with massive labels
    const labelWords = labelLower.split(/\s+/).slice(0, 50);
    let bestMatch = null;
    let bestScore = 0;

    for (const folder of smartFolders) {
      const folderName = folder?.name || '';
      if (!folderName && !folder?.description && !Array.isArray(folder?.keywords)) {
        continue;
      }
      const folderWords = [
        folderName.toLowerCase(),
        ...(folder?.description || '').toLowerCase().split(/\s+/),
        ...(Array.isArray(folder?.keywords) ? folder.keywords : []).map((/** @type {any} */ k) =>
          String(k).toLowerCase()
        )
      ];

      const overlap = labelWords.filter((/** @type {any} */ w) =>
        folderWords.some((fw) => fw.includes(w))
      ).length;
      // Prevent division by zero if labelWords is empty
      const score = labelWords.length > 0 ? overlap / labelWords.length : 0;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = folder;
      }
    }

    if (bestMatch && bestScore > 0.3) {
      return {
        folder: bestMatch.name,
        path: bestMatch.path,
        confidence: bestScore * 0.8,
        method: 'cluster_keyword_match'
      };
    }

    // Fallback: suggest creating a new folder based on cluster label
    if (cluster.label && !isGenericClusterLabel(cluster.label)) {
      return /** @type {Record<string, any>} */ ({
        folder: cluster.label,
        path: null,
        confidence: 0.6,
        method: 'cluster_new_folder',
        isNewFolder: true
      });
    }

    return null;
  }

  /**
   * Identify outlier files that don't fit well into any cluster
   *
   * @param {any[]} files - Files to analyze
   * @returns {Promise<Object>} Outlier analysis results
   */
  async identifyOutliers(files) {
    if (!this.clustering) {
      return { success: false, error: 'Clustering service not available', outliers: [] };
    }

    try {
      // Ensure clusters are computed
      if (this.clustering.isClustersStale()) {
        await this.clustering.computeClusters('auto');
      }

      const clusters = this.clustering.clusters || [];
      const centroids = this.clustering.centroids || [];
      const outliers = [];
      const wellClustered = [];

      for (const file of files) {
        const fileId = getSemanticFileId(file.path);

        // Find this file's cluster membership
        let bestClusterScore = 0;
        let belongsToCluster = null;

        for (const cluster of clusters) {
          const member = cluster.members?.find((/** @type {any} */ m) => m.id === fileId);
          if (member) {
            const centroid = centroids[cluster.id];
            if (centroid && member.embedding) {
              const score = cosineSimilarity(member.embedding, centroid);
              if (score > bestClusterScore) {
                bestClusterScore = score;
                belongsToCluster = cluster;
              }
            }
          }
        }

        if (bestClusterScore < this.config.outlierThreshold || !belongsToCluster) {
          outliers.push({
            file,
            clusterScore: bestClusterScore,
            reason: bestClusterScore === 0 ? 'not_in_cluster' : 'weak_cluster_fit',
            suggestedAction: 'review_manually'
          });
        } else {
          wellClustered.push({
            file,
            clusterId: belongsToCluster.id,
            clusterLabel: belongsToCluster.label,
            clusterScore: bestClusterScore
          });
        }
      }

      return {
        success: true,
        outliers,
        wellClustered,
        outlierCount: outliers.length,
        clusteredCount: wellClustered.length,
        outlierRatio: files.length > 0 ? outliers.length / files.length : 0
      };
    } catch (error) {
      logger.error('[OrganizationSuggestionService] Outlier detection failed:', error);
      return { success: false, error: error.message, outliers: [] };
    }
  }

  /**
   * Boost suggestions that are consistent with cluster membership
   * Called internally to enhance ranking
   *
   * @param {any} file - File being organized
   * @param {any[]} suggestions - Current suggestions
   * @returns {Promise<any[]>} Boosted suggestions
   */
  async boostClusterConsistentSuggestions(file, suggestions, /** @type {any} */ smartFolders = []) {
    if (!this.clustering || !this.config.useClusterSuggestions || suggestions.length === 0) {
      return suggestions;
    }

    try {
      const clusterSuggestions = await this.getClusterBasedSuggestions(file, smartFolders);

      if (clusterSuggestions.length === 0) {
        return suggestions;
      }

      // Create a set of folders recommended by cluster analysis
      const clusterRecommendedFolders = new Set(clusterSuggestions.map((s) => s.path));

      return suggestions.map((s) => {
        if (clusterRecommendedFolders.has(s.path)) {
          const boostedScore = s.score * this.config.clusterBoostFactor;
          return {
            ...s,
            score: boostedScore,
            weightedScore: Number.isFinite(s.weightedScore)
              ? s.weightedScore * this.config.clusterBoostFactor
              : boostedScore,
            clusterBoosted: true
          };
        }
        return s;
      });
    } catch (error) {
      logger.warn('[OrganizationSuggestionService] Cluster boost failed:', error);
      return suggestions;
    }
  }

  /**
   * Generate file summary for embedding
   * @param {any} file - File object
   * @returns {string} File summary
   */
  generateFileSummary(file) {
    return generateFileSummary(file);
  }

  /**
   * Get file type category
   * @param {string} extension - File extension
   * @returns {string} Category name
   */
  getFileTypeCategory(extension) {
    return getFileTypeCategory(extension);
  }

  /**
   * Calculate pattern similarity
   * @param {any} file - File object
   * @param {any} pattern - Pattern object
   * @returns {number} Similarity score
   */
  calculatePatternSimilarity(file, pattern) {
    return this.patternMatcher.calculatePatternSimilarity(file, pattern);
  }

  /**
   * Shutdown the service, cancelling any pending operations
   * FIX C-1: Call shutdown on persistence layers to prevent timer leaks
   */
  shutdown() {
    try {
      if (this.persistence) {
        this.persistence.shutdown();
      }
      if (this.feedbackMemoryStore) {
        this.feedbackMemoryStore.shutdown();
      }
      logger.info('[OrganizationSuggestionService] Shutdown complete');
    } catch (error) {
      logger.warn('[OrganizationSuggestionService] Error during shutdown:', error.message);
    }
  }

  // Legacy compatibility getters and setters
  get userPatterns() {
    return this.patternMatcher.userPatterns;
  }

  set userPatterns(value) {
    this.patternMatcher.userPatterns = value;
  }

  get feedbackHistory() {
    return this.patternMatcher.feedbackHistory;
  }

  set feedbackHistory(value) {
    this.patternMatcher.feedbackHistory = value;
  }

  get folderUsageStats() {
    return this.patternMatcher.folderUsageStats;
  }

  set folderUsageStats(value) {
    this.patternMatcher.folderUsageStats = value;
  }
}

module.exports = { OrganizationSuggestionServiceCore, isPathWithinFolder };
