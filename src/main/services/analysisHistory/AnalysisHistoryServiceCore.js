// @ts-check
/**
 * Analysis History Service Core
 *
 * Slim coordinator class that composes all analysis history modules.
 * Extracted from the original 1,238-line AnalysisHistoryService.js.
 *
 * @module analysisHistory/AnalysisHistoryServiceCore
 */

const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { createLogger } = require('../../../shared/logger');
const { createBackgroundWorkTracker, createInitGuard } = require('../../../shared/promiseUtils');
const { analysisResultSchema, validateSchema } = require('../../../shared/normalization/schemas');
const { LIMITS, TIMEOUTS } = require('../../../shared/performanceConstants');
const { CircuitBreaker } = require('../../utils/CircuitBreaker');
const { traceHistoryUpdate } = require('../../../shared/pathTraceLogger');
const { deepClone } = require('../../../shared/safeJsonOps');

// Import decomposed modules
const {
  createCacheStore,
  getCacheTTLs,
  invalidateCachesOnAdd,
  updateIncrementalStatsOnAdd,
  updateIncrementalStatsOnRemove,
  invalidateCachesOnRemove,
  clearCaches: clearCachesHelper,
  warmCache: warmCacheHelper,
  subscribeToInvalidationBus
} = require('./cacheManager');

const {
  loadConfig: loadConfigFile,
  saveConfig: saveConfigFile,
  loadHistory: loadHistoryFile,
  saveHistory: saveHistoryFile,
  loadIndex: loadIndexFile,
  saveIndex: saveIndexFile,
  createDefaultStructures: createDefaultStructuresFiles,
  closeSqliteStore: closeHistorySqliteStore
} = require('./persistence');

const {
  createEmptyIndex,
  generateFileHash,
  updateIndexes,
  removeFromIndexes,
  updatePathIndexForMove
} = require('./indexManager');

const { searchAnalysis: searchAnalysisHelper } = require('./search');

const {
  getStatistics: getStatisticsHelper,
  getQuickStats: getQuickStatsHelper
} = require('./statistics');

const {
  getAnalysisByPath: getAnalysisByPathHelper,
  getAnalysisByHash: getAnalysisByHashHelper,
  getAnalysisByCategory: getAnalysisByCategoryHelper,
  getAnalysisByTag: getAnalysisByTagHelper,
  getRecentAnalysis: getRecentAnalysisHelper,
  getAnalysisByDateRange: getAnalysisByDateRangeHelper,
  buildTimelineItems,
  getCategories: getCategoriesHelper,
  getTags: getTagsHelper
} = require('./queries');

const { performMaintenanceIfNeeded, migrateHistory } = require('./maintenance');

const logger = createLogger('AnalysisHistoryService');
class AnalysisHistoryServiceCore {
  constructor() {
    this.userDataPath = app.getPath('userData');
    this.historyPath = path.join(this.userDataPath, 'analysis-history.json');
    this.indexPath = path.join(this.userDataPath, 'analysis-index.json');
    this.configPath = path.join(this.userDataPath, 'analysis-config.json');

    this.analysisHistory = null;
    this.analysisIndex = null;
    this.config = null;
    this._initGuard = createInitGuard('AnalysisHistoryService');
    this._readOnly = false;
    this._readOnlyReason = null;

    // Schema version for future migration support
    this.SCHEMA_VERSION = '1.0.0';
    this.MAX_HISTORY_ENTRIES = LIMITS.MAX_HISTORY_ENTRIES;

    // Get cache TTLs from config
    const ttls = getCacheTTLs();
    this.CACHE_TTL_MS = ttls.CACHE_TTL_MS;
    this.STATS_CACHE_TTL_MS = ttls.STATS_CACHE_TTL_MS;
    this.SEARCH_CACHE_TTL_MS = ttls.SEARCH_CACHE_TTL_MS;

    // Initialize cache store
    this._cache = createCacheStore();

    // Performance: Track if full recalculation is needed
    this._statsNeedFullRecalc = true;

    // Write lock to prevent concurrent modifications
    this._writeLock = null;
    this._writeLockMeta = null;

    // Set via setOnEntriesRemovedCallback from ServiceIntegration
    this._onEntriesRemovedCallback = null;

    /** @type {any[]} */
    this._pendingWrites = [];
    this._writeBufferTimer = null;
    this.WRITE_BUFFER_MS = 100;
    this.MAX_PENDING_WRITES = LIMITS.MAX_QUEUE_SIZE;

    // Circuit Breaker for file system operations
    this.circuitBreaker = new CircuitBreaker('AnalysisHistoryService', {
      failureThreshold: 8,
      timeout: TIMEOUTS.HEALTH_CHECK,
      resetTimeout: 10000
    });

    // Cache invalidation bus subscription handle for cleanup
    this._busUnsubscribe = null;

    /** @type {any} */
    this._bgWork = createBackgroundWorkTracker('AnalysisHistoryService');

    // Shutdown gate: set at the START of shutdown() so no new writes can
    // enter while the final flush loop drains the buffer. Without it, a
    // chatty producer (batch analysis finishing during quit) could keep
    // pushing into _pendingWrites after the flush and lose those entries.
    this._isShutdown = false;
  }

  /** @returns {boolean} Whether the service has been initialized */
  get initialized() {
    return this._initGuard.isInitialized();
  }

  /** @param {boolean} v - Set to false to reset initialization state */
  set initialized(v) {
    if (!v) {
      this._initGuard.reset();
    }
    // Setting to true is handled by the guard's initialize() callback completing.
    // External set-to-true is ignored — use initialize() instead.
  }

  /**
   * Set callback for cascade orphan marking when entries are removed during maintenance
   * Called from ServiceIntegration after vector DB service is initialized
   * @param {Function} callback - Async function receiving array of {id, fileHash, originalPath, actualPath?}
   */
  setOnEntriesRemovedCallback(callback) {
    if (typeof callback === 'function') {
      this._onEntriesRemovedCallback = callback;
      logger.debug('[AnalysisHistoryService] Set onEntriesRemoved callback for orphan marking');
    }
  }

  _normalizeResults(/** @type {any} */ result) {
    if (Array.isArray(result)) {
      return result;
    }

    if (result && Array.isArray(result.results)) {
      const normalized = result.results.slice();
      normalized.total = typeof result.total === 'number' ? result.total : normalized.length;
      normalized.hasMore = typeof result.hasMore === 'boolean' ? result.hasMore : false;
      if (typeof result.fromCache === 'boolean') {
        normalized.fromCache = result.fromCache;
      }
      return normalized;
    }

    return [];
  }

  getDefaultConfig() {
    return /** @type {Record<string, any>} */ ({
      schemaVersion: this.SCHEMA_VERSION,
      maxHistoryEntries: this.MAX_HISTORY_ENTRIES,
      retentionDays: 365, // Keep analysis for 1 year
      enableRAG: true,
      enableFullTextSearch: true,
      compressionEnabled: false, // For future use
      backupEnabled: true,
      backupFrequencyDays: 7,
      lastBackup: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  createEmptyHistory() {
    return /** @type {Record<string, any>} */ ({
      schemaVersion: this.SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      totalAnalyzed: 0,
      totalSize: 0,
      entries: {},
      metadata: {
        lastCleanup: null,
        totalEntries: 0,
        averageAnalysisTime: 0
      }
    });
  }

  async initialize() {
    // If initialized but read-only, reset the guard to allow re-initialization (recovery)
    if (this.initialized && this._readOnly) {
      logger.info('[AnalysisHistoryService] Attempting to recover from read-only mode');
      this._initGuard.reset();
    }

    return this._initGuard.initialize(async () => {
      try {
        await this.loadConfig();
        await this.loadHistory();
        await this.loadIndex();
        if (this._readOnly) {
          this._readOnly = false;
          this._readOnlyReason = null;
          logger.info('[AnalysisHistoryService] Read-only mode cleared after successful reload');
        }

        // Subscribe to cache invalidation bus for cross-service cache coordination
        if (!this._busUnsubscribe) {
          this._busUnsubscribe = subscribeToInvalidationBus(this._cache, this);
        }

        logger.info('[AnalysisHistoryService] Initialized successfully');
      } catch (error) {
        logger.error('[AnalysisHistoryService] Failed to initialize', {
          error: error.message
        });
        if (error?.transient || error?.preserveOnError) {
          logger.warn(
            '[AnalysisHistoryService] Initialization failed; preserving on-disk data and using in-memory defaults',
            { error: error.message, transient: Boolean(error?.transient) }
          );
          this._readOnly = true;
          this._readOnlyReason = error?.message || 'Initialization failed';
          this.config = this.config || this.getDefaultConfig();
          this.analysisHistory = this.analysisHistory || this.createEmptyHistory();
          this.analysisIndex = this.analysisIndex || createEmptyIndex(this.SCHEMA_VERSION);
          this._cache = createCacheStore();
          this._statsNeedFullRecalc = true;
          return;
        }
        await this.createDefaultStructures({ resetConfig: true });
        // Clear stale read-only state from a prior transient failure, since
        // createDefaultStructures has rebuilt valid state on disk.
        if (this._readOnly) {
          this._readOnly = false;
          this._readOnlyReason = null;
          logger.info(
            '[AnalysisHistoryService] Read-only mode cleared after createDefaultStructures'
          );
        }
      }
    });
  }

  _createReadOnlyError(/** @type {any} */ operation) {
    const reason = this._readOnlyReason ? `: ${this._readOnlyReason}` : '';
    const opSuffix = operation ? ` during ${operation}` : '';
    const error = /** @type {Error & { readOnly?: boolean }} */ (
      new Error(`Analysis history is read-only${opSuffix}${reason}`)
    );
    error.readOnly = true;
    return error;
  }

  _assertWritable(/** @type {any} */ operation) {
    if (this._isShutdown) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error(`Analysis history is shutting down${operation ? ` during ${operation}` : ''}`)
      );
      err.code = 'SHUTTING_DOWN';
      throw err;
    }
    if (!this._readOnly) return;
    throw this._createReadOnlyError(operation);
  }

  async loadConfig() {
    this.config = await loadConfigFile(
      this.configPath,
      () => this.getDefaultConfig(),
      async (/** @type {any} */ cfg) => saveConfigFile(this.configPath, cfg)
    );
  }

  async loadHistory() {
    this.analysisHistory = await loadHistoryFile(
      this.historyPath,
      this.SCHEMA_VERSION,
      () => this.createEmptyHistory(),
      async (/** @type {any} */ hist) => saveHistoryFile(this.historyPath, hist),
      migrateHistory
    );
  }

  async loadIndex() {
    this.analysisIndex = await loadIndexFile(
      this.indexPath,
      () => createEmptyIndex(this.SCHEMA_VERSION),
      async (/** @type {any} */ idx) => saveIndexFile(this.indexPath, idx)
    );
  }

  async createDefaultStructures(/** @type {{ resetConfig?: boolean }} */ options = {}) {
    const { resetConfig = false } = options;

    // Preserve existing configuration when requested to avoid wiping user prefs
    if (!this.config && !resetConfig) {
      try {
        await this.loadConfig();
      } catch (error) {
        logger.warn('[AnalysisHistoryService] Falling back to default config during reset', {
          error: error.message
        });
      }
    }

    const result = await createDefaultStructuresFiles(
      {
        configPath: this.configPath,
        historyPath: this.historyPath,
        indexPath: this.indexPath
      },
      resetConfig
        ? () => this.getDefaultConfig()
        : () => ({
            ...(this.config || this.getDefaultConfig()),
            updatedAt: new Date().toISOString()
          }),
      () => this.createEmptyHistory(),
      () => createEmptyIndex(this.SCHEMA_VERSION)
    );

    this.config = result.config;
    this.analysisHistory = result.history;
    this.analysisIndex = result.index;

    // Reset caches/stat tracking so subsequent reads reflect the cleared state
    this._cache = createCacheStore();
    this._statsNeedFullRecalc = true;

    return result;
  }

  async saveConfig() {
    await saveConfigFile(this.configPath, this.config);
  }

  async saveHistory() {
    await this.circuitBreaker.execute(() =>
      saveHistoryFile(this.historyPath, this.analysisHistory)
    );
  }

  async saveIndex() {
    await this.circuitBreaker.execute(() => saveIndexFile(this.indexPath, this.analysisIndex));
  }

  async recordAnalysis(/** @type {any} */ fileInfo, /** @type {any} */ analysisResults) {
    if (this._isShutdown) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error('Analysis history is shutting down')
      );
      err.code = 'SHUTTING_DOWN';
      return Promise.reject(err);
    }
    if (this._readOnly) {
      return Promise.reject(this._createReadOnlyError('recordAnalysis'));
    }
    if (this._pendingWrites.length >= this.MAX_PENDING_WRITES) {
      const error = /** @type {Error & { code?: string }} */ (
        new Error('Analysis history write buffer is full')
      );
      error.code = 'WRITE_BUFFER_FULL';
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      this._pendingWrites.push({ fileInfo, analysisResults, resolve, reject });
      this._scheduleFlush();
    });
  }

  /**
   * Acquire write lock using promise-chain serialization.
   * Each caller chains onto the previous lock holder, ensuring FIFO ordering
   * and preventing the multi-waiter race condition of the old polling approach.
   */
  async _acquireWriteLock(/** @type {any} */ context) {
    const maxWaitMs = TIMEOUTS.MUTEX_ACQUIRE;

    /** @type {(v?: any) => void} */
    let releaseLock = () => {};
    const lockToken = Symbol('analysis-history-write-lock');
    const nextLock = new Promise((resolve) => {
      releaseLock = resolve;
    });

    // Chain onto the previous lock (or resolve immediately if none)
    const previousLock = this._writeLock;
    this._writeLock = nextLock;
    this._writeLockMeta = { token: lockToken, startedAt: Date.now(), context: context || null };

    if (previousLock) {
      // Wait for previous holder to release, with a timeout
      let timeoutId;
      try {
        await Promise.race([
          previousLock,
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              const error = /** @type {Error & { code?: string }} */ (
                new Error(
                  `Analysis history write lock acquisition timed out${context ? ` (${context})` : ''}`
                )
              );
              error.code = 'WRITE_LOCK_TIMEOUT';
              reject(error);
            }, maxWaitMs);
            if (timeoutId && typeof timeoutId.unref === 'function') {
              timeoutId.unref();
            }
          })
        ]);
      } catch (error) {
        if (error.code === 'WRITE_LOCK_TIMEOUT') {
          // Previously we logged and proceeded as if we'd won the lock —
          // that turns a lock-timeout into a concurrent-writer race against
          // the true holder, which can corrupt the history blob + SQLite
          // side-tables. Instead, reject the write so the caller can
          // surface the failure (and optionally retry). Unwind cleanly:
          //   * resolve our own nextLock so any chained waiters can try
          //     their turn (they were waiting on us, not on the true
          //     holder).
          //   * clear _writeLockMeta / _writeLock if nobody chained after us
          //     so future callers don't see a stale "holder" record.
          logger.warn(
            '[AnalysisHistoryService] Write lock timeout; rejecting write to avoid concurrent-writer corruption',
            { context, maxWaitMs }
          );
          if (typeof releaseLock === 'function') {
            releaseLock();
          }
          if (this._writeLockMeta?.token === lockToken) {
            this._writeLockMeta = null;
            this._writeLock = null;
          }
          throw error;
        } else {
          throw error;
        }
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }

    return () => {
      if (typeof releaseLock === 'function') {
        releaseLock();
      }
      // Only clear lock state if we still own it (no subsequent waiter replaced us)
      if (this._writeLockMeta?.token === lockToken) {
        this._writeLockMeta = null;
        // Safe to null: if another waiter had replaced _writeLock, their token
        // wouldn't match ours, so we'd skip this branch entirely.
        this._writeLock = null;
      }
    };
  }

  _scheduleFlush() {
    if (!this._writeBufferTimer) {
      this._writeBufferTimer = setTimeout(() => {
        this._bgWork.track(
          this._flushWrites().catch((err) => {
            logger.error('[AnalysisHistoryService] Timer flush failed:', err.message);
          })
        );
      }, this.WRITE_BUFFER_MS);
    }
    // Force flush if queue gets too large
    if (this._pendingWrites.length >= 50) {
      if (this._writeBufferTimer) clearTimeout(this._writeBufferTimer);
      this._writeBufferTimer = null;
      this._bgWork.track(
        this._flushWrites().catch((err) => {
          logger.error('[AnalysisHistoryService] Forced flush failed:', err.message);
        })
      );
    }
  }

  async _flushWrites() {
    this._writeBufferTimer = null;
    if (this._pendingWrites.length === 0) return;

    try {
      await this.initialize();
    } catch (error) {
      // Reject all pending writes without splicing (they stay for retry)
      const snapshot = [...this._pendingWrites];
      this._pendingWrites.length = 0;
      snapshot.forEach(({ reject }) => reject(error));
      return;
    }
    if (this._readOnly) {
      const error = this._createReadOnlyError('flushWrites');
      const snapshot = [...this._pendingWrites];
      this._pendingWrites.length = 0;
      snapshot.forEach(({ reject }) => reject(error));
      return;
    }

    let releaseLock;
    try {
      releaseLock = await this._acquireWriteLock('flushWrites');
    } catch (error) {
      // Re-check _readOnly after lock acquisition wait — circuit breaker may have tripped
      if (this._readOnly) {
        const roError = this._createReadOnlyError('flushWrites (post-lock)');
        const snapshot = [...this._pendingWrites];
        this._pendingWrites.length = 0;
        snapshot.forEach(({ reject }) => reject(roError));
        return;
      }
      const snapshot = [...this._pendingWrites];
      this._pendingWrites.length = 0;
      snapshot.forEach(({ reject }) => reject(error));
      return;
    }

    // Splice AFTER acquiring lock to prevent concurrent flushes from competing
    const batch = this._pendingWrites.splice(0, this._pendingWrites.length);

    try {
      // `batchTimestamp` is the shared "this flush happened at" marker used
      // for the aggregate `updatedAt` field. Per-entry timestamps are captured
      // INSIDE the loop below so a 500-file flush doesn't collapse every
      // file's `timestamp` to the same millisecond — that collapsing was
      // tying queries like "group by month" into a single bucket and
      // starving the LRU recency caches which rely on distinct timestamps
      // to evict fairly. `Date.now()` is monotonic enough for this;
      // collisions within a single millisecond are benign because the
      // entry id is also unique.
      const batchTimestamp = new Date().toISOString();
      let hasChanges = false;
      const _originalHistorySnapshot = {
        totalAnalyzed: this.analysisHistory.totalAnalyzed,
        totalSize: this.analysisHistory.totalSize,
        totalEntries: this.analysisHistory.metadata.totalEntries,
        updatedAt: this.analysisHistory.updatedAt
      };
      const _originalIndexUpdatedAt = this.analysisIndex.updatedAt;
      const addedEntries = [];
      /** @type {any[]} Prior rows replaced by a re-analysis of the same path (F-208). */
      const replacedEntries = [];
      const pendingEntryResolutions = [];

      for (const { fileInfo, analysisResults, resolve, reject } of batch) {
        try {
          const timestamp = new Date().toISOString();
          const fileHash = generateFileHash(fileInfo.path, fileInfo.size, fileInfo.lastModified);
          const analysisValidation = validateSchema(analysisResultSchema, analysisResults || {});
          if (!analysisValidation.valid) {
            logger.warn('[AnalysisHistoryService] Invalid analysis result shape', {
              filePath: fileInfo.path,
              error: analysisValidation.error?.message
            });
          }
          const safeResults = analysisValidation.data || analysisResults || {};

          /** @type {Record<string, any>} */
          const analysisEntry = {
            id: crypto.randomUUID(),
            fileHash,
            timestamp,

            // File information
            originalPath: fileInfo.path,
            fileName: path.basename(fileInfo.path),
            fileExtension: path.extname(fileInfo.path).toLowerCase(),
            fileSize: fileInfo.size,
            lastModified: fileInfo.lastModified,
            mimeType: fileInfo.mimeType || null,

            // Analysis results - comprehensive data for document/image conversations
            analysis: {
              subject: safeResults.subject || null,
              category: safeResults.category || null,
              tags: safeResults.tags || [],
              confidence: safeResults.confidence || 0,
              summary: safeResults.summary || null,
              extractedText: safeResults.extractedText || null,
              // Audio/video routing flag: persisted so a BM25 rebuild from
              // history applies the lifted media-text cap on legacy
              // entries instead of falling back to mimeType inference.
              mediaKind: safeResults.mediaKind || null,
              // Document/image metadata for richer context
              documentType: safeResults.documentType || null,
              entity: safeResults.entity || null,
              project: safeResults.project || null,
              purpose: safeResults.purpose || null,
              reasoning: safeResults.reasoning || null,
              documentDate: safeResults.documentDate || safeResults.date || null,
              extractionMethod: safeResults.extractionMethod || null,
              // Structured data for queries
              keyEntities: safeResults.keyEntities || [],
              dates: safeResults.dates || [],
              amounts: safeResults.amounts || [],
              language: safeResults.language || null,
              sentiment: safeResults.sentiment || null,
              // Image-specific fields
              content_type: safeResults.content_type || null,
              has_text: safeResults.has_text ?? null,
              colors: safeResults.colors || null,
              // Provenance (F-195 / D7). The writer stamps these and the
              // watcher's retry reads `analysis.provisional`; leaving them out
              // of this literal made every fallback result final.
              provisional: safeResults.provisional === true,
              provisionalRetries: Number(safeResults.provisionalRetries) || 0,
              fallbackReason: safeResults.fallbackReason || null,
              // Audio/video: transcript export and the details view read these.
              transcript: safeResults.transcript || null,
              transcriptSegments: Array.isArray(safeResults.transcriptSegments)
                ? safeResults.transcriptSegments
                : null,
              ...(safeResults.transcriptSegmentsTruncated === true
                ? { transcriptSegmentsTruncated: true }
                : {}),
              durationSeconds: Number.isFinite(safeResults.durationSeconds)
                ? safeResults.durationSeconds
                : null,
              detectedLanguage: safeResults.detectedLanguage || null,
              keyframes: Array.isArray(safeResults.keyframes) ? safeResults.keyframes : null
            },

            // Processing metadata
            processing: {
              model: safeResults.model || 'unknown',
              processingTimeMs: safeResults.processingTime || 0,
              version: this.SCHEMA_VERSION,
              errorCount: safeResults.errorCount || 0,
              warnings: safeResults.warnings || []
            },

            // Organization results (if file was moved/renamed)
            organization: {
              suggested: safeResults.suggestedPath || null,
              actual: safeResults.actualPath || null,
              renamed: safeResults.renamed || false,
              newName: safeResults.newName || null,
              smartFolder: safeResults.smartFolder || null
            },

            // Future expansion fields
            embedding: {
              // User preference (per-file override). When null, treat as "inherit default".
              policy: safeResults.embeddingPolicy || null,
              // Operational status used by staged embedding pipeline.
              status: safeResults.embeddingStatus || 'unknown',
              // Model name used for last successful embed (when known).
              model: safeResults.embeddingModel || null,
              // ISO timestamp of last embedding state update.
              updatedAt: timestamp
            },
            relations: [], // Related files
            userFeedback: null, // User corrections/ratings
            exportHistory: [], // Export/share history
            accessCount: 0,
            lastAccessed: timestamp
          };

          // One row per path (F-208 / K-09): a re-analysis REPLACES the prior
          // entry for the same path instead of adding a fresh UUID row and only
          // re-pointing the index. Usage history carries over; the replaced
          // row is kept aside so a failed persist can put it back.
          const priorEntry = /** @type {any} */ (
            getAnalysisByPathHelper(this.analysisHistory, this.analysisIndex, fileInfo.path)
          );
          if (priorEntry && priorEntry.id && priorEntry.id !== analysisEntry.id) {
            analysisEntry.accessCount = Number(priorEntry.accessCount) || 0;
            if (Array.isArray(priorEntry.relations) && priorEntry.relations.length > 0) {
              analysisEntry.relations = priorEntry.relations;
            }
            delete this.analysisHistory.entries[priorEntry.id];
            this.analysisHistory.totalAnalyzed = Math.max(
              0,
              this.analysisHistory.totalAnalyzed - 1
            );
            this.analysisHistory.totalSize = Math.max(
              0,
              this.analysisHistory.totalSize - (priorEntry.fileSize || 0)
            );
            this.analysisHistory.metadata.totalEntries = Math.max(
              0,
              this.analysisHistory.metadata.totalEntries - 1
            );
            try {
              updateIncrementalStatsOnRemove(this._cache, priorEntry);
              removeFromIndexes(this.analysisIndex, priorEntry);
            } catch (dedupeErr) {
              logger.warn('[AnalysisHistoryService] Failed to unindex replaced entry', {
                entryId: priorEntry.id,
                error: /** @type {any} */ (dedupeErr)?.message
              });
            }
            replacedEntries.push(priorEntry);
          }

          // Store the entry
          this.analysisHistory.entries[analysisEntry.id] = analysisEntry;
          this.analysisHistory.totalAnalyzed++;
          this.analysisHistory.totalSize += fileInfo.size;
          this.analysisHistory.metadata.totalEntries++;

          // Update indexes
          updateIndexes(this.analysisIndex, analysisEntry);

          addedEntries.push(analysisEntry);
          pendingEntryResolutions.push({ resolve, reject, id: analysisEntry.id });
          hasChanges = true;
        } catch (err) {
          logger.error('[AnalysisHistoryService] Error processing batched item:', err);
          reject(err);
        }
      }

      if (hasChanges) {
        this.analysisHistory.updatedAt = batchTimestamp;

        // Save to disk
        const saveResults = await Promise.allSettled([this.saveHistory(), this.saveIndex()]);
        const saveFailures = saveResults.filter((result) => result.status === 'rejected');
        if (saveFailures.length > 0) {
          saveFailures.forEach((result, index) => {
            logger.warn(
              `[ANALYSIS-HISTORY] Save operation ${index} failed:`,
              result.reason?.message
            );
          });

          logger.error(
            '[AnalysisHistoryService] Persistence failed, rolling back in-memory changes and forcing re-initialization'
          );

          // Roll back in-memory changes before forcing re-init
          for (const entry of addedEntries) {
            delete this.analysisHistory.entries[entry.id];
            try {
              removeFromIndexes(this.analysisIndex, entry);
            } catch (indexError) {
              logger.warn('[AnalysisHistoryService] Failed to rollback index entry', {
                entryId: entry.id,
                error: indexError?.message
              });
            }
          }
          // Put back rows a re-analysis replaced (F-208) so a failed persist
          // never loses the previous knowledge of a path.
          for (const prior of replacedEntries) {
            this.analysisHistory.entries[prior.id] = prior;
            try {
              updateIndexes(this.analysisIndex, prior);
            } catch (indexError) {
              logger.warn('[AnalysisHistoryService] Failed to restore replaced entry index', {
                entryId: prior.id,
                error: /** @type {any} */ (indexError)?.message
              });
            }
          }
          this.analysisHistory.totalAnalyzed = _originalHistorySnapshot.totalAnalyzed;
          this.analysisHistory.totalSize = _originalHistorySnapshot.totalSize;
          this.analysisHistory.metadata.totalEntries = _originalHistorySnapshot.totalEntries;
          this.analysisHistory.updatedAt = _originalHistorySnapshot.updatedAt;
          this.analysisIndex.updatedAt = _originalIndexUpdatedAt;

          this.initialized = false;

          const error = new Error('Failed to persist analysis history');
          pendingEntryResolutions.forEach(({ reject }) => reject(error));
          return;
        }

        // Invalidate relevant caches (surgical invalidation, not full)
        invalidateCachesOnAdd(this._cache);
        addedEntries.forEach((entry) => updateIncrementalStatsOnAdd(this._cache, entry));
        pendingEntryResolutions.forEach(({ resolve, id }) => resolve(id));

        // Cleanup if needed
        await performMaintenanceIfNeeded(
          this.analysisHistory,
          this.analysisIndex,
          this._cache,
          this,
          this.config,
          () => this.saveHistory(),
          () => this.saveIndex(),
          { onEntriesRemoved: this._onEntriesRemovedCallback }
        );
      }
    } finally {
      // Release write lock
      if (typeof releaseLock === 'function') {
        releaseLock();
      }
    }
  }

  async searchAnalysis(/** @type {any} */ query, options = {}) {
    await this.initialize();
    const result = await searchAnalysisHelper(
      this.analysisHistory,
      this._cache,
      this.SEARCH_CACHE_TTL_MS,
      query,
      options
    );
    return this._normalizeResults(result);
  }

  async getAnalysisByPath(/** @type {any} */ filePath) {
    await this.initialize();
    return getAnalysisByPathHelper(this.analysisHistory, this.analysisIndex, filePath);
  }

  async getAnalysisByHash(/** @type {any} */ fileHash) {
    await this.initialize();
    return getAnalysisByHashHelper(this.analysisHistory, this.analysisIndex, fileHash);
  }

  async getAnalysisByCategory(/** @type {any} */ category, options = {}) {
    await this.initialize();
    const result = await getAnalysisByCategoryHelper(
      this.analysisHistory,
      this.analysisIndex,
      this._cache,
      this.CACHE_TTL_MS,
      category,
      options
    );
    return this._normalizeResults(result);
  }

  async getAnalysisByTag(/** @type {any} */ tag, options = {}) {
    await this.initialize();
    const result = await getAnalysisByTagHelper(
      this.analysisHistory,
      this.analysisIndex,
      this._cache,
      this.CACHE_TTL_MS,
      tag,
      options
    );
    return this._normalizeResults(result);
  }

  async getRecentAnalysis(limit = 50, offset = 0) {
    await this.initialize();
    const result = await getRecentAnalysisHelper(
      this.analysisHistory,
      this._cache,
      this.CACHE_TTL_MS,
      limit,
      offset
    );
    return this._normalizeResults(result);
  }

  async getStatistics() {
    await this.initialize();
    return getStatisticsHelper(
      this.analysisHistory,
      this.analysisIndex,
      this._cache,
      this,
      this.STATS_CACHE_TTL_MS
    );
  }

  async getQuickStats() {
    await this.initialize();
    return getQuickStatsHelper(this.analysisHistory, this.analysisIndex);
  }

  async getAnalysisByDateRange(
    /** @type {any} */ startDate,
    /** @type {any} */ endDate,
    options = {}
  ) {
    await this.initialize();
    const result = await getAnalysisByDateRangeHelper(
      this.analysisHistory,
      this.analysisIndex,
      startDate,
      endDate,
      options
    );
    return this._normalizeResults(result);
  }

  async getTimelineItems(options = {}) {
    await this.initialize();
    return buildTimelineItems(this.analysisHistory, options);
  }

  async getCategories() {
    await this.initialize();
    return getCategoriesHelper(this.analysisIndex);
  }

  async getTags() {
    await this.initialize();
    return getTagsHelper(this.analysisIndex);
  }

  async warmCache() {
    await this.initialize();
    await warmCacheHelper(
      this._cache,
      (/** @type {any} */ limit) => this.getRecentAnalysis(limit),
      this.analysisHistory,
      this
    );
  }

  clearCaches() {
    clearCachesHelper(this._cache, this);
  }

  /**
   * Shutdown the service and release resources
   * Should be called during app exit to cleanly unsubscribe from the cache invalidation bus
   */
  async shutdown() {
    // Gate new writes FIRST so the flush loop below can actually drain —
    // recordAnalysis and the mutating entry points reject from here on.
    this._isShutdown = true;

    // Drain tracked background work (forced flushes, etc.)
    await this._bgWork.drain();

    if (this._busUnsubscribe) {
      this._busUnsubscribe();
      this._busUnsubscribe = null;
      logger.debug('[AnalysisHistoryService] Unsubscribed from cache invalidation bus');
    }
    if (this._writeBufferTimer) {
      clearTimeout(this._writeBufferTimer);
      this._writeBufferTimer = null;
    }
    // Flush pending writes before shutdown. Bounded loop: a write that passed
    // the gate check just before the flag flipped may land in the buffer
    // after the first flush splices it.
    for (let round = 0; this._pendingWrites.length > 0 && round < 3; round += 1) {
      try {
        await this._flushWrites();
      } catch (err) {
        logger.error(
          '[AnalysisHistoryService] Failed to flush pending writes during shutdown:',
          err.message
        );
        // Reject remaining pending writes so callers don't hang
        const remaining = this._pendingWrites.splice(0, this._pendingWrites.length);
        const shutdownError = new Error('Analysis history shutting down');
        remaining.forEach(({ reject }) => reject(shutdownError));
        break;
      }
    }
    this.clearCaches();
    closeHistorySqliteStore();
  }

  /**
   * Update entry paths after files have been moved/organized.
   * This updates the organization.actual field so that search results
   * show the current file location, not the original path.
   *
   * When the destination resolves to a smart folder, callers can pass
   * `newCategory`/`newSmartFolder`/`newSmartFolderPath` to reconcile the
   * cached analysis with the file's new home. SearchService.enrichResults
   * reads `analysis.category` for display, so without this sync the UI
   * shows the LLM's original (potentially wrong) verdict forever.
   *
   * An explicit `newSmartFolder: null` / `newSmartFolderPath: null` clears
   * those fields: the file has left every Smart Folder (an undo back to
   * Downloads). The category is left alone — it is the analysis verdict,
   * not a property of the folder.
   *
   * @param {Array<{oldPath: string, newPath: string, newName?: string, newCategory?: string, newSmartFolder?: string|null, newSmartFolderPath?: string|null}>} pathUpdates - Path update mappings
   * @returns {Promise<{updated: number, notFound: number, divergences: Array<{entryId: string, filePath: string, oldCategory: string|null, newCategory: string}>}>} Update results, including per-entry category divergences (LLM-said vs destination) for downstream learning signals.
   */
  async updateEntryPaths(pathUpdates) {
    await this.initialize();
    this._assertWritable('updateEntryPaths');

    if (!pathUpdates || !Array.isArray(pathUpdates) || pathUpdates.length === 0) {
      return { updated: 0, notFound: 0, divergences: [] };
    }

    const releaseLock = await this._acquireWriteLock('updateEntryPaths');

    try {
      let updated = 0;
      let notFound = 0;
      const divergences = [];

      // Build a map of oldPath -> update info for faster lookup
      const updateMap = new Map();
      for (const update of pathUpdates) {
        if (update.oldPath && update.newPath) {
          updateMap.set(update.oldPath, update);
        }
      }

      // Scan through entries and update matching ones
      const entries = this.analysisHistory?.entries || {};
      for (const entry of Object.values(entries)) {
        const actualPath = entry.organization?.actual || null;
        const updateKey =
          entry.originalPath && updateMap.has(entry.originalPath)
            ? entry.originalPath
            : actualPath && updateMap.has(actualPath)
              ? actualPath
              : null;
        const update = updateKey ? updateMap.get(updateKey) : null;
        if (update) {
          // Track old actual path for index update
          const oldActualPath = actualPath;

          // Update the organization fields
          if (!entry.organization) {
            entry.organization = {};
          }
          entry.organization.actual = update.newPath;
          if (update.newName) {
            entry.organization.newName = update.newName;
            entry.organization.renamed = true;
            // Also update the base fileName field for BM25 index consistency
            // This ensures searches find the file by its new name immediately
            entry.fileName = update.newName;
          }

          // Category sync: when the caller supplies a category derived from the
          // destination smart folder, refresh `analysis.category` so search/UI
          // stop reporting the stale LLM verdict. Preserve the prior category in
          // `correctedFrom` so the learning loop can later treat (oldCategory,
          // newCategory) pairs as supervised training signal.
          if (typeof update.newCategory === 'string' && update.newCategory.length > 0) {
            if (!entry.analysis) entry.analysis = {};
            const prevCategory =
              typeof entry.analysis.category === 'string' ? entry.analysis.category : null;
            if (prevCategory !== update.newCategory) {
              if (prevCategory) {
                entry.analysis.correctedFrom = prevCategory;
              }
              entry.analysis.category = update.newCategory;
              divergences.push({
                entryId: entry.id,
                filePath: update.newPath,
                oldCategory: prevCategory,
                newCategory: update.newCategory
              });
            }
            if (typeof update.newSmartFolder === 'string') {
              entry.analysis.smartFolder = update.newSmartFolder;
            }
            if (typeof update.newSmartFolderPath === 'string') {
              entry.analysis.smartFolderPath = update.newSmartFolderPath;
            }
          }

          // Clearing is independent of the category gate: a file undone out of
          // every Smart Folder arrives with explicit nulls and no newCategory,
          // and the vector row has already been told the same thing.
          if (update.newSmartFolder === null || update.newSmartFolderPath === null) {
            if (!entry.analysis) entry.analysis = {};
            if (update.newSmartFolder === null) entry.analysis.smartFolder = null;
            if (update.newSmartFolderPath === null) entry.analysis.smartFolderPath = null;
          }

          if (this.analysisIndex) {
            updatePathIndexForMove(this.analysisIndex, entry, oldActualPath, update.newPath);
          }

          // PATH-TRACE: Log history entry path update
          traceHistoryUpdate(update.oldPath, update.newPath, entry.id, true);

          updated++;
          updateMap.delete(updateKey); // Remove to track not found
        }
      }

      notFound = updateMap.size;

      if (updated > 0) {
        const prevUpdatedAt = this.analysisHistory.updatedAt;
        this.analysisHistory.updatedAt = new Date().toISOString();

        // Save both files atomically — if either fails, the on-disk state is inconsistent
        const saveResults = await Promise.allSettled([this.saveHistory(), this.saveIndex()]);
        const saveFailures = saveResults.filter((r) => r.status === 'rejected');

        if (saveFailures.length > 0) {
          // Fail CLOSED. Returning success here made FilePathCoordinator skip
          // its compensating rollback, so the vector DB ended up pointing at
          // new paths while on-disk history still held the old ones — and the
          // forced re-init below discards the in-memory update, cementing the
          // divergence. Throwing lets the coordinator roll back its other
          // stores; the re-init reloads disk state so memory matches it.
          const errMsg = saveFailures.map((r) => r.reason?.message).join('; ');
          logger.error('[AnalysisHistoryService] updateEntryPaths persistence failed', {
            updated,
            errors: errMsg
          });
          this.analysisHistory.updatedAt = prevUpdatedAt;
          this.initialized = false; // Force re-init: reload disk state, dropping the unsaved update
          clearCachesHelper(this._cache, this);
          const persistError = /** @type {Error & { code?: string }} */ (
            new Error(`updateEntryPaths persistence failed: ${errMsg}`)
          );
          persistError.code = 'HISTORY_PERSIST_FAILED';
          throw persistError;
        }

        // Invalidate caches since paths have changed
        clearCachesHelper(this._cache, this);

        logger.info(
          `[AnalysisHistoryService] Updated ${updated} entry paths, ${notFound} not found` +
            (divergences.length > 0 ? `, ${divergences.length} category corrections` : '')
        );
      }

      return { updated, notFound, divergences };
    } finally {
      if (typeof releaseLock === 'function') {
        releaseLock();
      }
    }
  }

  /**
   * Update tags for an entry identified by path.
   *
   * @param {string} filePath
   * @param {string[]} tags
   * @returns {Promise<{updated: number, notFound: number, error?: string}>}
   */
  async updateTags(filePath, tags) {
    await this.initialize();
    this._assertWritable('updateTags');

    const target = typeof filePath === 'string' ? filePath : '';
    if (!target) return { updated: 0, notFound: 1 };

    if (!Array.isArray(tags)) return { updated: 0, notFound: 0, error: 'Tags must be an array' };

    const releaseLock = await this._acquireWriteLock('updateTags');
    try {
      const entries = this.analysisHistory?.entries || {};
      let updated = 0;
      const now = new Date().toISOString();

      for (const entry of Object.values(entries)) {
        const original = entry?.originalPath;
        const actual = entry?.organization?.actual;
        if (original !== target && actual !== target) continue;

        // Clone for index removal
        const oldEntry = deepClone(entry);
        removeFromIndexes(this.analysisIndex, oldEntry);

        if (!entry.analysis) entry.analysis = {};
        entry.analysis.tags = tags;
        entry.updatedAt = now;

        // Update index with new tags
        updateIndexes(this.analysisIndex, entry);

        updated++;
        break; // One path maps to one primary entry
      }

      if (updated > 0) {
        this.analysisHistory.updatedAt = now;
        await Promise.all([this.saveHistory(), this.saveIndex()]);
        clearCachesHelper(this._cache, this);
      }

      return { updated, notFound: updated > 0 ? 0 : 1 };
    } finally {
      if (typeof releaseLock === 'function') {
        releaseLock();
      }
    }
  }

  /**
   * Update embedding preference/state for an entry identified by path.
   *
   * This is the persistence layer for staged embedding workflows.
   *
   * Matches either the original path or the organization.actual path.
   *
   * @param {string} filePath
   * @param {{policy?: 'embed'|'skip'|'web_only'|null, status?: 'unknown'|'pending'|'done'|'skipped'|'error'|null, model?: string|null, error?: string|null}} update
   * @returns {Promise<{updated: number, notFound: number}>}
   */
  async updateEmbeddingStateByPath(filePath, update = {}) {
    await this.initialize();
    this._assertWritable('updateEmbeddingStateByPath');

    const target = typeof filePath === 'string' ? filePath : '';
    if (!target) return { updated: 0, notFound: 1 };

    const releaseLock = await this._acquireWriteLock('updateEmbeddingStateByPath');
    try {
      const entries = this.analysisHistory?.entries || {};
      let updated = 0;

      const now = new Date().toISOString();
      const normalizePolicy = (/** @type {any} */ value) => {
        if (value === 'embed' || value === 'skip' || value === 'web_only') return value;
        return null;
      };
      const normalizeStatus = (/** @type {any} */ value) => {
        if (
          value === 'unknown' ||
          value === 'pending' ||
          value === 'done' ||
          value === 'skipped' ||
          value === 'error'
        )
          return value;
        return null;
      };

      for (const entry of Object.values(entries)) {
        const original = entry?.originalPath;
        const actual = entry?.organization?.actual;
        if (original !== target && actual !== target) continue;

        if (!entry.embedding || typeof entry.embedding !== 'object') {
          entry.embedding = { policy: null, status: 'unknown', model: null, updatedAt: now };
        }

        const nextPolicy = normalizePolicy(update.policy);
        const nextStatus = normalizeStatus(update.status);
        if (nextPolicy !== null) entry.embedding.policy = nextPolicy;
        if (nextStatus !== null) entry.embedding.status = nextStatus;
        if (typeof update.model === 'string') entry.embedding.model = update.model;
        if (update.model === null) entry.embedding.model = null;
        if (typeof update.error === 'string') entry.embedding.error = update.error;
        if (update.error === null && entry.embedding.error) delete entry.embedding.error;

        entry.embedding.updatedAt = now;
        updated++;
        break; // One path maps to one primary entry
      }

      if (updated > 0) {
        const prevUpdatedAt = this.analysisHistory.updatedAt;
        this.analysisHistory.updatedAt = now;

        const saveResult = await Promise.allSettled([this.saveHistory()]);
        const failures = saveResult.filter((r) => r.status === 'rejected');
        if (failures.length > 0) {
          // Keep behavior consistent with other update methods: log + force re-init.
          logger.error('[AnalysisHistoryService] updateEmbeddingStateByPath persistence failed', {
            error: failures.map((r) => r.reason?.message).join('; ')
          });
          this.analysisHistory.updatedAt = prevUpdatedAt;
          this.initialized = false;
        }

        clearCachesHelper(this._cache, this);
      }

      return { updated, notFound: updated > 0 ? 0 : 1 };
    } finally {
      if (typeof releaseLock === 'function') {
        releaseLock();
      }
    }
  }

  /**
   * Convenience helper: set per-file embedding policy.
   *
   * @param {string} filePath
   * @param {'embed'|'skip'|'web_only'|null} policy
   */
  async setEmbeddingPolicyByPath(filePath, policy) {
    return this.updateEmbeddingStateByPath(filePath, { policy });
  }

  /**
   * Remove analysis history entries associated with a path.
   * Used to keep BM25/analysis-history-backed search in sync after deletes.
   *
   * Matches either the original path or the organization.actual path.
   *
   * @param {string} filePath
   * @returns {Promise<{removed: number, error?: string}>}
   */
  async removeEntriesByPath(filePath) {
    await this.initialize();
    this._assertWritable('removeEntriesByPath');

    const target = typeof filePath === 'string' ? filePath : '';
    if (!target) return { removed: 0 };

    const releaseLock = await this._acquireWriteLock('removeEntriesByPath');

    const removedEntries = [];
    try {
      const entries = this.analysisHistory?.entries || {};
      for (const [id, entry] of Object.entries(entries)) {
        const original = entry?.originalPath;
        const actual = entry?.organization?.actual;
        if (original === target || actual === target) {
          removedEntries.push({
            id,
            fileHash: entry.fileHash,
            originalPath: entry.originalPath,
            actualPath: entry.organization?.actual || null,
            _fullEntry: entry
          });

          delete entries[id];
          this.analysisHistory.totalAnalyzed = Math.max(0, this.analysisHistory.totalAnalyzed - 1);
          this.analysisHistory.totalSize = Math.max(
            0,
            this.analysisHistory.totalSize - (entry.fileSize || 0)
          );
          this.analysisHistory.metadata.totalEntries = Math.max(
            0,
            this.analysisHistory.metadata.totalEntries - 1
          );
          updateIncrementalStatsOnRemove(this._cache, entry);
          removeFromIndexes(this.analysisIndex, entry);
        }
      }

      if (removedEntries.length > 0) {
        invalidateCachesOnRemove(this._cache, this);
        const prevUpdatedAt = this.analysisHistory.updatedAt;
        this.analysisHistory.updatedAt = new Date().toISOString();

        const saveResults = await Promise.allSettled([this.saveHistory(), this.saveIndex()]);
        const saveFailures = saveResults.filter((r) => r.status === 'rejected');
        if (saveFailures.length > 0) {
          // Rollback in-memory mutations to match disk state
          for (const removed of removedEntries) {
            entries[removed.id] = removed._fullEntry;
            this.analysisHistory.totalAnalyzed++;
            this.analysisHistory.totalSize += removed._fullEntry.fileSize || 0;
            this.analysisHistory.metadata.totalEntries++;
            try {
              updateIndexes(this.analysisIndex, removed._fullEntry);
            } catch (indexErr) {
              logger.warn(
                '[AnalysisHistoryService] Index rollback error during removeEntriesByPath',
                {
                  error: indexErr?.message
                }
              );
            }
          }
          this.analysisHistory.updatedAt = prevUpdatedAt;
          this.initialized = false;
          logger.error(
            '[AnalysisHistoryService] removeEntriesByPath persistence failed, rolled back',
            {
              failures: saveFailures.map((r) => r.reason?.message)
            }
          );
          return { removed: 0, error: 'Persistence failed, changes rolled back' };
        }
      }

      // Notify about removals so vector DB can mark any remaining embeddings/chunks orphaned.
      // (For app-driven deletes we also delete embeddings directly, but this keeps behavior consistent.)
      if (this._onEntriesRemovedCallback && removedEntries.length > 0) {
        try {
          await this._onEntriesRemovedCallback(removedEntries);
        } catch (e) {
          logger.warn('[AnalysisHistoryService] onEntriesRemoved callback failed', {
            error: e.message,
            count: removedEntries.length
          });
        }
      }

      return { removed: removedEntries.length };
    } finally {
      if (typeof releaseLock === 'function') {
        releaseLock();
      }
    }
  }

  /**
   * Clone an analysis history entry for a copied file.
   * This creates a new entry for the destination with the same analysis data.
   *
   * @param {string} sourcePath - Original file path
   * @param {string} destPath - Copied file path
   * @returns {Promise<{success: boolean, cloned?: boolean, error?: string, newId?: string}>}
   */
  async cloneEntryForCopy(sourcePath, destPath) {
    await this.initialize();
    this._assertWritable('cloneEntryForCopy');

    if (!sourcePath || !destPath) {
      return { success: false, error: 'Source and destination paths required' };
    }

    const sourceEntry = /** @type {any} */ (await this.getAnalysisByPath(sourcePath));
    if (!sourceEntry) {
      return { success: true, cloned: false };
    }

    const releaseLock = await this._acquireWriteLock('cloneEntryForCopy');

    try {
      const newId = crypto.randomUUID();
      const destStats = await require('fs')
        .promises.stat(destPath)
        .catch(
          /** @param {any} err @returns {any} */ (err) => {
            logger.debug('[AnalysisHistory] stat(destPath) failed', {
              destPath,
              error: err?.message
            });
            return null;
          }
        );
      const newFileHash = generateFileHash(
        destPath,
        destStats?.size || sourceEntry.fileSize,
        destStats?.mtimeMs || Date.now()
      );

      /** @type {Record<string, any>} */
      const clonedEntry = {
        ...sourceEntry,
        analysis: sourceEntry.analysis ? deepClone(sourceEntry.analysis) : {},
        id: newId,
        fileHash: newFileHash,
        originalPath: destPath,
        fileName: path.basename(destPath),
        timestamp: new Date().toISOString(),
        lastModified: destStats?.mtimeMs || Date.now(),
        fileSize: destStats?.size || sourceEntry.fileSize,
        // Reset organization since this is a new file
        organization: {
          suggested: sourceEntry.organization?.suggested || null,
          actual: destPath,
          renamed: false,
          newName: null,
          smartFolder: sourceEntry.organization?.smartFolder || null
        },
        // Mark as cloned for audit purposes (deep clone processing to avoid shared mutable refs)
        processing: {
          ...(sourceEntry.processing ? deepClone(sourceEntry.processing) : {}),
          clonedFrom: sourcePath,
          clonedAt: new Date().toISOString()
        }
      };

      // Add to entries and update aggregate counters
      this.analysisHistory.entries[newId] = clonedEntry;
      this.analysisHistory.totalAnalyzed++;
      this.analysisHistory.totalSize += clonedEntry.fileSize || 0;
      this.analysisHistory.metadata.totalEntries++;

      // Update indexes
      updateIndexes(this.analysisIndex, clonedEntry);

      // Save to disk atomically — rollback in-memory state if either fails
      const prevUpdatedAt = this.analysisHistory.updatedAt;
      this.analysisHistory.updatedAt = new Date().toISOString();

      const saveResults = await Promise.allSettled([this.saveHistory(), this.saveIndex()]);
      const saveFailures = saveResults.filter((r) => r.status === 'rejected');

      if (saveFailures.length > 0) {
        // Rollback in-memory mutations
        delete this.analysisHistory.entries[newId];
        this.analysisHistory.totalAnalyzed = Math.max(0, this.analysisHistory.totalAnalyzed - 1);
        this.analysisHistory.totalSize = Math.max(
          0,
          this.analysisHistory.totalSize - (clonedEntry.fileSize || 0)
        );
        this.analysisHistory.metadata.totalEntries = Math.max(
          0,
          this.analysisHistory.metadata.totalEntries - 1
        );
        try {
          removeFromIndexes(this.analysisIndex, clonedEntry);
        } catch (indexErr) {
          logger.warn('[AnalysisHistoryService] Index rollback error during cloneEntryForCopy', {
            error: indexErr?.message
          });
        }
        this.analysisHistory.updatedAt = prevUpdatedAt;

        const errMsg = saveFailures.map((r) => r.reason?.message).join('; ');
        logger.error('[AnalysisHistoryService] Failed to persist cloned entry, rolled back', {
          source: sourcePath,
          dest: destPath,
          errors: errMsg
        });
        return { success: false, error: `Persistence failed: ${errMsg}` };
      }

      // Only update caches after successful persistence
      updateIncrementalStatsOnAdd(this._cache, clonedEntry);
      invalidateCachesOnAdd(this._cache);

      logger.info('[AnalysisHistoryService] Cloned entry for copied file', {
        source: sourcePath,
        dest: destPath,
        newId
      });

      return { success: true, cloned: true, newId };
    } catch (error) {
      logger.error('[AnalysisHistoryService] Failed to clone entry for copy', {
        error: error.message,
        source: sourcePath,
        dest: destPath
      });
      return { success: false, error: error.message };
    } finally {
      if (typeof releaseLock === 'function') {
        releaseLock();
      }
    }
  }
}

module.exports = AnalysisHistoryServiceCore;
