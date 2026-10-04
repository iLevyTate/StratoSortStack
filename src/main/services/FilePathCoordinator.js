// @ts-check
/**
 * FilePathCoordinator - Central coordinator for atomic path updates
 *
 * This service ensures all path-dependent systems are updated atomically
 * when files are moved, renamed, copied, or deleted. It prevents split-brain
 * scenarios where some systems have the new path while others have the old.
 *
 * Systems coordinated:
 * - Vector DB metadata (embeddings)
 * - AnalysisHistoryService (search indexes)
 * - EmbeddingQueue (pending embeddings)
 * - ProcessingStateService (in-progress jobs)
 * - Cache invalidation bus (all caches)
 * - RelationshipIndexService (knowledge graph staleness)
 *
 * @module services/FilePathCoordinator
 */

const path = require('path');
const { logger: baseLogger, createLogger } = require('../../shared/logger');
const {
  getAllIdVariants,
  getFileEmbeddingId,
  buildPathUpdatePairs
} = require('../utils/fileIdUtils');
const { EventEmitter } = require('events');
const {
  traceCoordinatorStart,
  traceCoordinatorComplete,
  traceDbUpdate
} = require('../../shared/pathTraceLogger');
const { crossPlatformBasename } = require('../../shared/crossPlatformUtils');

const logger =
  typeof createLogger === 'function' ? createLogger('FilePathCoordinator') : baseLogger;
if (typeof createLogger !== 'function' && logger?.setContext) {
  logger.setContext('FilePathCoordinator');
}

/**
 * Path change event types
 * @readonly
 * @enum {string}
 */
const PathChangeType = {
  MOVE: 'move',
  COPY: 'copy',
  DELETE: 'delete',
  RENAME: 'rename'
};

/**
 * FilePathCoordinator class
 *
 * Centralizes all path update operations to ensure atomicity across
 * all path-dependent systems in the application.
 */
class FilePathCoordinator extends EventEmitter {
  /**
   * @param {any} [options]
   */
  constructor(options = {}) {
    super();

    // Service references - set via setServices() after construction
    this._vectorDbService = options.vectorDbService || null;
    this._analysisHistoryService = options.analysisHistoryService || null;
    this._embeddingQueue = options.embeddingQueue || null;
    this._processingStateService = options.processingStateService || null;
    this._cacheInvalidationBus = options.cacheInvalidationBus || null;
    this._relationshipIndexService = options.relationshipIndexService || null;

    // Track pending operations for debugging
    this._pendingOperations = new Map();
    this._operationIdCounter = 0;

    // Per-path mutex locks to prevent concurrent updates on the same file
    this._pathLocks = new Map();

    // Shutdown gate + in-flight counter. shutdown() flips the gate so no new
    // path updates can start, then drains in-flight ones (bounded) before
    // clearing locks — clearing while an update is mid-flight would release
    // its mutexes and let a concurrent op interleave half-applied state.
    this._isShutdown = false;
    this._inFlightCount = 0;

    // Configuration
    this._batchSize = options.batchSize || 50;

    logger.info('[FilePathCoordinator] Initialized');
  }

  /**
   * Set service references after construction
   * This allows for lazy resolution of dependencies
   *
   * @param {any} services - Service instances
   */
  setServices(services) {
    if (services.vectorDbService) this._vectorDbService = services.vectorDbService;
    if (services.analysisHistoryService)
      this._analysisHistoryService = services.analysisHistoryService;
    if (services.embeddingQueue) this._embeddingQueue = services.embeddingQueue;
    if (services.processingStateService)
      this._processingStateService = services.processingStateService;
    if (services.cacheInvalidationBus) this._cacheInvalidationBus = services.cacheInvalidationBus;
    if (services.relationshipIndexService)
      this._relationshipIndexService = services.relationshipIndexService;

    logger.debug('[FilePathCoordinator] Services updated', {
      hasVectorDb: !!this._vectorDbService,
      hasAnalysisHistory: !!this._analysisHistoryService,
      hasEmbeddingQueue: !!this._embeddingQueue,
      hasProcessingState: !!this._processingStateService,
      hasCacheInvalidation: !!this._cacheInvalidationBus,
      hasRelationshipIndex: !!this._relationshipIndexService
    });
  }

  /**
   * Atomically update a file path across all systems
   *
   * @param {string} oldPath
   * @param {string} newPath
   * @param {any} [options]
   * @returns {Promise<{success: boolean, errors: Array<any>, updated: any}>}
   */
  async atomicPathUpdate(oldPath, newPath, options = {}) {
    // Per-path concurrency guard: queue concurrent updates that touch either
    // endpoint of this move/rename. Previously we only locked on `oldPath`,
    // which allowed two ops (A->B and B->C) to run concurrently — the second
    // op's "source" was the first op's "destination" and could enter the
    // coordinator while the first was still updating vectorDb / history /
    // embedding-queue for path B, producing inconsistent cross-system state.
    //
    // Lock on BOTH endpoints. To prevent deadlock when two concurrent ops
    // share a pair in opposite orders, acquire the keys in a stable sort
    // order. Same endpoints (oldPath === newPath) collapse to one lock.
    if (this._isShutdown) {
      return {
        success: false,
        errors: [{ system: 'coordinator', error: 'FilePathCoordinator is shutting down' }],
        updated: {}
      };
    }

    const oldKey = path.resolve(oldPath).toLowerCase();
    const newKey = path.resolve(newPath).toLowerCase();
    const lockKeys = oldKey === newKey ? [oldKey] : [oldKey, newKey].sort();

    const acquired = [];
    this._inFlightCount += 1;
    try {
      for (const lockKey of lockKeys) {
        while (this._pathLocks.has(lockKey)) {
          await this._pathLocks.get(lockKey);
        }
        /** @type {(v?: any) => void} */
        let resolveLock = () => {};
        const lockPromise = new Promise((resolve) => {
          resolveLock = resolve;
        });
        this._pathLocks.set(lockKey, lockPromise);
        acquired.push({ lockKey, lockPromise, resolveLock });
      }

      return await this._executeAtomicPathUpdate(oldPath, newPath, options);
    } finally {
      // Release in reverse acquisition order for tidy contention behavior.
      for (let i = acquired.length - 1; i >= 0; i -= 1) {
        const { lockKey, lockPromise, resolveLock } = acquired[i];
        if (this._pathLocks.get(lockKey) === lockPromise) {
          this._pathLocks.delete(lockKey);
        }
        resolveLock();
      }
      this._inFlightCount -= 1;
    }
  }

  /**
   * Internal implementation of atomic path update with compensating rollback
   * @private
   */
  async _executeAtomicPathUpdate(
    /** @type {any} */ oldPath,
    /** @type {any} */ newPath,
    /** @type {any} */ options = {}
  ) {
    const operationId = ++this._operationIdCounter;
    const startTime = Date.now();

    logger.info('[FilePathCoordinator] Starting atomic path update', {
      operationId,
      oldPath: crossPlatformBasename(oldPath),
      newPath: crossPlatformBasename(newPath),
      type: options.type || PathChangeType.MOVE
    });

    // PATH-TRACE: Log coordinator start
    traceCoordinatorStart(oldPath, newPath, options.type || PathChangeType.MOVE);

    const errors = [];
    const updated = {
      vectorDb: false,
      analysisHistory: false,
      embeddingQueue: false,
      processingState: false,
      cacheInvalidated: false
    };

    try {
      this._pendingOperations.set(operationId, {
        oldPath,
        newPath,
        startTime,
        type: options.type || PathChangeType.MOVE
      });
      // 1. Update vector DB metadata (embeddings)
      if (!options.skipVectorDb && this._vectorDbService) {
        try {
          await this._updateVectorDbPath(oldPath, newPath, options.folderMeta);
          updated.vectorDb = true;
          // PATH-TRACE: Log vector DB update success
          traceDbUpdate('vectordb', oldPath, newPath, true);
        } catch (err) {
          errors.push({ system: 'vectorDb', error: err.message });
          logger.warn('[FilePathCoordinator] Vector DB update failed', { error: err.message });
          // PATH-TRACE: Log vector DB update failure
          traceDbUpdate('vectordb', oldPath, newPath, false, err.message);
        }
      } else if (!options.skipVectorDb) {
        errors.push({ system: 'vectorDb', error: 'Vector DB service unavailable' });
        logger.warn('[FilePathCoordinator] Vector DB service unavailable for path update');
      }

      // 2. Update AnalysisHistoryService (search indexes)
      if (!options.skipAnalysisHistory && this._analysisHistoryService) {
        try {
          await this._updateAnalysisHistoryPath(oldPath, newPath, options.folderMeta || {});
          updated.analysisHistory = true;
          // PATH-TRACE: Log analysis history update success
          traceDbUpdate('history', oldPath, newPath, true);
        } catch (err) {
          errors.push({ system: 'analysisHistory', error: err.message });
          logger.warn('[FilePathCoordinator] Analysis history update failed', {
            error: err.message
          });
          // PATH-TRACE: Log analysis history update failure
          traceDbUpdate('history', oldPath, newPath, false, err.message);

          // Compensating rollback: revert vectorDb if it succeeded
          if (updated.vectorDb) {
            try {
              await this._updateVectorDbPath(newPath, oldPath);
              updated.vectorDb = false;
              logger.info(
                '[FilePathCoordinator] Rolled back vectorDb after analysisHistory failure'
              );
            } catch (rollbackErr) {
              logger.error(
                '[FilePathCoordinator] IRRECOVERABLE: Failed to rollback vectorDb after analysisHistory failure',
                {
                  rollbackError: rollbackErr.message,
                  oldPath: crossPlatformBasename(oldPath),
                  newPath: crossPlatformBasename(newPath)
                }
              );
            }
          }
        }
      } else if (!options.skipAnalysisHistory) {
        errors.push({ system: 'analysisHistory', error: 'Analysis history service unavailable' });
        logger.warn('[FilePathCoordinator] Analysis history service unavailable for path update');
      }

      // 3. Update EmbeddingQueue pending items
      if (!options.skipEmbeddingQueue && this._embeddingQueue) {
        try {
          this._updateEmbeddingQueuePath(oldPath, newPath);
          updated.embeddingQueue = true;
          // PATH-TRACE: Log embedding queue update success
          traceDbUpdate('queue', oldPath, newPath, true);
        } catch (err) {
          errors.push({ system: 'embeddingQueue', error: err.message });
          logger.warn('[FilePathCoordinator] Embedding queue update failed', {
            error: err.message
          });
          // PATH-TRACE: Log embedding queue update failure
          traceDbUpdate('queue', oldPath, newPath, false, err.message);

          // Compensating rollback: revert prior successful updates
          if (updated.vectorDb) {
            try {
              await this._updateVectorDbPath(newPath, oldPath);
              updated.vectorDb = false;
              logger.info(
                '[FilePathCoordinator] Rolled back vectorDb after embeddingQueue failure'
              );
            } catch (rollbackErr) {
              logger.error(
                '[FilePathCoordinator] IRRECOVERABLE: Failed to rollback vectorDb after embeddingQueue failure',
                {
                  rollbackError: rollbackErr.message,
                  oldPath: crossPlatformBasename(oldPath),
                  newPath: crossPlatformBasename(newPath)
                }
              );
            }
          }
          if (updated.analysisHistory) {
            try {
              await this._updateAnalysisHistoryPath(newPath, oldPath);
              updated.analysisHistory = false;
              logger.info(
                '[FilePathCoordinator] Rolled back analysisHistory after embeddingQueue failure'
              );
            } catch (rollbackErr) {
              logger.error(
                '[FilePathCoordinator] IRRECOVERABLE: Failed to rollback analysisHistory after embeddingQueue failure',
                {
                  rollbackError: rollbackErr.message,
                  oldPath: crossPlatformBasename(oldPath),
                  newPath: crossPlatformBasename(newPath)
                }
              );
            }
          }
        }
      } else if (!options.skipEmbeddingQueue) {
        errors.push({ system: 'embeddingQueue', error: 'Embedding queue unavailable' });
        logger.warn('[FilePathCoordinator] Embedding queue unavailable for path update');
      }

      // 4. Update ProcessingStateService
      if (!options.skipProcessingState && this._processingStateService) {
        try {
          await this._updateProcessingStatePath(oldPath, newPath);
          updated.processingState = true;
          // PATH-TRACE: Log processing state update success
          traceDbUpdate('processingState', oldPath, newPath, true);
        } catch (err) {
          errors.push({ system: 'processingState', error: err.message });
          logger.warn('[FilePathCoordinator] Processing state update failed', {
            error: err.message
          });
          // PATH-TRACE: Log processing state update failure
          traceDbUpdate('processingState', oldPath, newPath, false, err.message);

          // Compensating rollback: revert prior successful updates
          if (updated.vectorDb) {
            try {
              await this._updateVectorDbPath(newPath, oldPath);
              updated.vectorDb = false;
              logger.info(
                '[FilePathCoordinator] Rolled back vectorDb after processingState failure'
              );
            } catch (rollbackErr) {
              logger.error(
                '[FilePathCoordinator] IRRECOVERABLE: Failed to rollback vectorDb after processingState failure',
                {
                  rollbackError: rollbackErr.message,
                  oldPath: crossPlatformBasename(oldPath),
                  newPath: crossPlatformBasename(newPath)
                }
              );
            }
          }
          if (updated.analysisHistory) {
            try {
              await this._updateAnalysisHistoryPath(newPath, oldPath);
              updated.analysisHistory = false;
              logger.info(
                '[FilePathCoordinator] Rolled back analysisHistory after processingState failure'
              );
            } catch (rollbackErr) {
              logger.error(
                '[FilePathCoordinator] IRRECOVERABLE: Failed to rollback analysisHistory after processingState failure',
                {
                  rollbackError: rollbackErr.message,
                  oldPath: crossPlatformBasename(oldPath),
                  newPath: crossPlatformBasename(newPath)
                }
              );
            }
          }
          if (updated.embeddingQueue) {
            try {
              this._updateEmbeddingQueuePath(newPath, oldPath);
              updated.embeddingQueue = false;
              logger.info(
                '[FilePathCoordinator] Rolled back embeddingQueue after processingState failure'
              );
            } catch (rollbackErr) {
              logger.error(
                '[FilePathCoordinator] IRRECOVERABLE: Failed to rollback embeddingQueue after processingState failure',
                {
                  rollbackError: rollbackErr.message,
                  oldPath: crossPlatformBasename(oldPath),
                  newPath: crossPlatformBasename(newPath)
                }
              );
            }
          }
        }
      } else if (!options.skipProcessingState) {
        errors.push({ system: 'processingState', error: 'Processing state service unavailable' });
        logger.warn('[FilePathCoordinator] Processing state service unavailable for path update');
      }

      // 5. Broadcast cache invalidation. If this fails after the stores have
      // already been updated, caches (search, render, etc.) will continue
      // answering against the old path. We can't roll back the stores at this
      // point (they're the source of truth), so we compensate by (a) retrying
      // the targeted invalidation once, (b) falling back to a broad invalidateAll
      // so nothing reads stale data, and (c) raising a degraded flag if even
      // that fails so the UI surfaces the divergence.
      const storesTouched = updated.vectorDb || updated.analysisHistory || updated.processingState;
      if (this._cacheInvalidationBus) {
        try {
          this._cacheInvalidationBus.invalidateForPathChange(oldPath, newPath, options.type);
          updated.cacheInvalidated = true;
          // Happy path: a prior session may have raised cache-bus-unavailable
          // or cache-divergence; a clean invalidation now proves the bus is
          // working, so drop those flags.
          this._clearRecoverableDegradedFlags({ clearRelationship: false });
        } catch (err) {
          errors.push({ system: 'cacheInvalidation', error: err.message });
          logger.warn('[FilePathCoordinator] Cache invalidation failed, retrying', {
            error: err.message
          });
          try {
            this._cacheInvalidationBus.invalidateForPathChange(oldPath, newPath, options.type);
            updated.cacheInvalidated = true;
          } catch (retryErr) {
            // Last-resort compensating invalidation: drop every path-keyed cache so
            // the next read comes from the (now-updated) stores of truth.
            let fellBack = false;
            try {
              if (typeof this._cacheInvalidationBus.invalidateAll === 'function') {
                this._cacheInvalidationBus.invalidateAll('path-change-compensate');
                fellBack = true;
              }
            } catch (fallbackErr) {
              logger.error('[FilePathCoordinator] invalidateAll fallback failed', {
                error: fallbackErr.message
              });
            }
            errors.push({
              system: 'cacheInvalidation',
              error: `retry failed: ${retryErr.message}; fallback ${fellBack ? 'ok' : 'failed'}`
            });
            if (storesTouched && !fellBack) {
              try {
                const tracker = require('./DegradedStateTracker').getInstance();
                tracker.raise({
                  code: 'filepath.cache-divergence',
                  subsystem: 'file-path-coordinator',
                  severity: 'warning',
                  message:
                    'File caches could not be invalidated after a path update. Some search or preview results may be out of sync until you reload the app.',
                  detail: {
                    oldPath: crossPlatformBasename(oldPath),
                    newPath: crossPlatformBasename(newPath),
                    retryError: retryErr.message
                  }
                });
              } catch {
                // Tracker is best-effort
              }
            }
          }
        }
      } else {
        errors.push({ system: 'cacheInvalidation', error: 'Cache invalidation bus unavailable' });
        logger.warn('[FilePathCoordinator] Cache invalidation bus unavailable for path update');
        if (storesTouched) {
          try {
            const tracker = require('./DegradedStateTracker').getInstance();
            tracker.raise({
              code: 'filepath.cache-bus-unavailable',
              subsystem: 'file-path-coordinator',
              severity: 'warning',
              message:
                'Cache invalidation bus unavailable during a path update; caches may be stale until the app restarts.',
              detail: { oldPath: crossPlatformBasename(oldPath) }
            });
          } catch {
            // Tracker is best-effort
          }
        }
      }

      // 6. Invalidate relationship index (graph edges use semantic IDs tied to paths)
      this._invalidateRelationshipIndex();

      // Emit path-changed event for any listeners (e.g., IPC to renderer)
      this.emit('path-changed', {
        type: options.type || PathChangeType.MOVE,
        oldPath,
        newPath,
        updated,
        errors
      });

      const duration = Date.now() - startTime;
      logger.info('[FilePathCoordinator] Atomic path update complete', {
        operationId,
        duration,
        updated,
        errorCount: errors.length
      });

      // PATH-TRACE: Log coordinator completion with full summary
      traceCoordinatorComplete(oldPath, newPath, updated, errors.length);

      return {
        success: errors.length === 0,
        errors,
        updated
      };
    } finally {
      this._pendingOperations.delete(operationId);
    }
  }

  /**
   * Batch update multiple file paths atomically
   *
   * @param {Array<{oldPath: string, newPath: string}>} pathChanges - Path change pairs
   * @param {any} options - Options (same as atomicPathUpdate)
   * @returns {Promise<Record<string, any>>}
   */
  async batchPathUpdate(pathChanges, options = {}) {
    if (!Array.isArray(pathChanges) || pathChanges.length === 0) {
      return /** @type {any} */ ({
        success: true,
        results: [],
        summary: { total: 0, successful: 0, failed: 0 }
      });
    }

    if (this._isShutdown) {
      return {
        success: false,
        results: [],
        errors: [{ system: 'coordinator', error: 'FilePathCoordinator is shutting down' }],
        summary: { total: pathChanges.length, successful: 0, failed: pathChanges.length }
      };
    }

    // Acquire locks for BOTH endpoints of every change, matching
    // atomicPathUpdate. Locking only sources allowed a concurrent single-path
    // update touching one of this batch's destinations to interleave and
    // corrupt cross-system state. Deadlock prevention via sorted acquisition
    // order (same global ordering as atomicPathUpdate).
    const lockKeys = [
      ...new Set(
        pathChanges.flatMap((c) => [
          path.resolve(c.oldPath).toLowerCase(),
          path.resolve(c.newPath).toLowerCase()
        ])
      )
    ].sort();
    const resolveLocks = [];

    this._inFlightCount += 1;
    for (const lockKey of lockKeys) {
      while (this._pathLocks.has(lockKey)) {
        await this._pathLocks.get(lockKey);
      }
      let resolveLock;
      const lockPromise = new Promise((resolve) => {
        resolveLock = resolve;
      });
      this._pathLocks.set(lockKey, lockPromise);
      resolveLocks.push({ key: lockKey, resolve: resolveLock, promise: lockPromise });
    }

    try {
      const startTime = Date.now();
      logger.info('[FilePathCoordinator] Starting batch path update', {
        count: pathChanges.length,
        type: options.type || PathChangeType.MOVE
      });

      /** @type {any[]} */
      const results = [];
      /** @type {any[]} */
      const errors = [];
      const missingSystems = new Set();
      // Aggregate per-batch category corrections so the caller can attribute
      // them to learning-feedback. Each entry: {entryId, filePath, oldCategory, newCategory}.
      const divergences = [];

      // Process in batches for large updates
      for (let i = 0; i < pathChanges.length; i += this._batchSize) {
        const batch = pathChanges.slice(i, i + this._batchSize);

        const errorCountBeforeBatch = errors.length;
        const batchIndex = i / this._batchSize;
        const reverseBatch = this._reversePathBatch(batch);

        let vectorDbSucceeded = false;
        let analysisHistorySucceeded = false;
        let embeddingQueueSucceeded = false;

        // 1. Batch update vector DB
        if (!options.skipVectorDb && this._vectorDbService) {
          try {
            await this._batchUpdateVectorDbPaths(batch);
            vectorDbSucceeded = true;
          } catch (err) {
            errors.push({ system: 'vectorDb', error: err.message, batch: batchIndex });
            logger.warn('[FilePathCoordinator] Vector DB batch update failed', {
              error: err.message
            });
          }
        } else if (!options.skipVectorDb && !missingSystems.has('vectorDb')) {
          errors.push({ system: 'vectorDb', error: 'Vector DB service unavailable' });
          missingSystems.add('vectorDb');
          logger.warn('[FilePathCoordinator] Vector DB service unavailable for batch update');
        }

        // 2. Batch update Analysis History
        if (!options.skipAnalysisHistory && this._analysisHistoryService) {
          try {
            const historyResult = await this._batchUpdateAnalysisHistoryPaths(batch);
            if (Array.isArray(historyResult?.divergences) && historyResult.divergences.length > 0) {
              divergences.push(...historyResult.divergences);
            }
            analysisHistorySucceeded = true;
          } catch (err) {
            errors.push({
              system: 'analysisHistory',
              error: err.message,
              batch: batchIndex
            });
            logger.warn('[FilePathCoordinator] Analysis history batch update failed', {
              error: err.message
            });

            if (vectorDbSucceeded) {
              try {
                await this._batchUpdateVectorDbPaths(reverseBatch);
                vectorDbSucceeded = false;
                logger.info('[FilePathCoordinator] Rolled back vectorDb batch');
              } catch (rbErr) {
                logger.error(
                  '[FilePathCoordinator] IRRECOVERABLE: batch vectorDb rollback failed',
                  { error: rbErr.message }
                );
              }
            }
          }
        } else if (!options.skipAnalysisHistory && !missingSystems.has('analysisHistory')) {
          errors.push({ system: 'analysisHistory', error: 'Analysis history service unavailable' });
          missingSystems.add('analysisHistory');
          logger.warn(
            '[FilePathCoordinator] Analysis history service unavailable for batch update'
          );
        }

        // 3. Batch update Embedding Queue
        if (!options.skipEmbeddingQueue && this._embeddingQueue) {
          try {
            this._batchUpdateEmbeddingQueuePaths(batch);
            embeddingQueueSucceeded = true;
          } catch (err) {
            errors.push({
              system: 'embeddingQueue',
              error: err.message,
              batch: batchIndex
            });
            logger.warn('[FilePathCoordinator] Embedding queue batch update failed', {
              error: err.message
            });

            if (vectorDbSucceeded) {
              try {
                await this._batchUpdateVectorDbPaths(reverseBatch);
                vectorDbSucceeded = false;
                logger.info('[FilePathCoordinator] Rolled back vectorDb batch');
              } catch (rbErr) {
                logger.error(
                  '[FilePathCoordinator] IRRECOVERABLE: batch vectorDb rollback failed',
                  { error: rbErr.message }
                );
              }
            }
            if (analysisHistorySucceeded) {
              try {
                await this._batchUpdateAnalysisHistoryPaths(reverseBatch);
                analysisHistorySucceeded = false;
                logger.info('[FilePathCoordinator] Rolled back analysisHistory batch');
              } catch (rbErr) {
                logger.error(
                  '[FilePathCoordinator] IRRECOVERABLE: batch analysisHistory rollback failed',
                  { error: rbErr.message }
                );
              }
            }
          }
        } else if (!options.skipEmbeddingQueue && !missingSystems.has('embeddingQueue')) {
          errors.push({ system: 'embeddingQueue', error: 'Embedding queue unavailable' });
          missingSystems.add('embeddingQueue');
          logger.warn('[FilePathCoordinator] Embedding queue unavailable for batch update');
        }

        // 4. Batch update ProcessingStateService
        let processingStateAllOk = true;
        if (!options.skipProcessingState && this._processingStateService) {
          for (const change of batch) {
            try {
              await this._updateProcessingStatePath(change.oldPath, change.newPath);
            } catch (err) {
              processingStateAllOk = false;
              errors.push({
                system: 'processingState',
                error: err.message,
                batch: batchIndex,
                file: change.oldPath
              });
              logger.warn('[FilePathCoordinator] Processing state batch update failed for file', {
                error: err.message,
                oldPath: crossPlatformBasename(change.oldPath)
              });
            }
          }

          if (!processingStateAllOk) {
            if (embeddingQueueSucceeded) {
              try {
                this._batchUpdateEmbeddingQueuePaths(reverseBatch);
                embeddingQueueSucceeded = false;
                logger.info('[FilePathCoordinator] Rolled back embeddingQueue batch');
              } catch (rbErr) {
                logger.error(
                  '[FilePathCoordinator] IRRECOVERABLE: batch embeddingQueue rollback failed',
                  { error: rbErr.message }
                );
              }
            }
            if (analysisHistorySucceeded) {
              try {
                await this._batchUpdateAnalysisHistoryPaths(reverseBatch);
                analysisHistorySucceeded = false;
                logger.info('[FilePathCoordinator] Rolled back analysisHistory batch');
              } catch (rbErr) {
                logger.error(
                  '[FilePathCoordinator] IRRECOVERABLE: batch analysisHistory rollback failed',
                  { error: rbErr.message }
                );
              }
            }
            if (vectorDbSucceeded) {
              try {
                await this._batchUpdateVectorDbPaths(reverseBatch);
                vectorDbSucceeded = false;
                logger.info('[FilePathCoordinator] Rolled back vectorDb batch');
              } catch (rbErr) {
                logger.error(
                  '[FilePathCoordinator] IRRECOVERABLE: batch vectorDb rollback failed',
                  { error: rbErr.message }
                );
              }
            }
          }
        } else if (!options.skipProcessingState && !missingSystems.has('processingState')) {
          errors.push({
            system: 'processingState',
            error: 'Processing state service unavailable'
          });
          missingSystems.add('processingState');
          logger.warn(
            '[FilePathCoordinator] Processing state service unavailable for batch update'
          );
        }

        const batchHadErrors = errors.length > errorCountBeforeBatch;
        const batchErrors = errors.slice(errorCountBeforeBatch);
        // Dedupe by system: processingState pushes one error entry per file, so a
        // raw entry count over-states how many distinct systems actually failed and
        // would mislabel a processingState-only failure of >=3 files as a total loss.
        const failedSystems = [...new Set(batchErrors.map((e) => e.system))];

        // Track results for each path change
        batch.forEach((change) => {
          results.push({
            oldPath: change.oldPath,
            newPath: change.newPath,
            success: !batchHadErrors,
            // Partial when fewer than 3 of the (up to 4) distinct systems failed —
            // i.e. at least one system still landed the update.
            partialSuccess: batchHadErrors && failedSystems.length < 3,
            failedSystems
          });
        });
      }

      // 4. Single cache invalidation for all paths. As with atomicPathUpdate, a
      // failure here after the stores of truth were already mutated leaves caches
      // answering against stale paths. We compensate the same way: (a) retry the
      // batch invalidation once, (b) fall back to a broad invalidateAll so nothing
      // reads stale data, and (c) raise a degraded flag if even that fails so the
      // UI surfaces the divergence.
      const storesTouched = results.some((result) => result.success || result.partialSuccess);
      if (this._cacheInvalidationBus) {
        try {
          this._cacheInvalidationBus.invalidateBatch(pathChanges, options.type);
        } catch (err) {
          errors.push({ system: 'cacheInvalidation', error: err.message });
          logger.warn('[FilePathCoordinator] Cache invalidation failed, retrying', {
            error: err.message
          });
          try {
            this._cacheInvalidationBus.invalidateBatch(pathChanges, options.type);
          } catch (retryErr) {
            let fellBack = false;
            try {
              if (typeof this._cacheInvalidationBus.invalidateAll === 'function') {
                this._cacheInvalidationBus.invalidateAll('path-change-compensate');
                fellBack = true;
              }
            } catch (fallbackErr) {
              logger.error('[FilePathCoordinator] invalidateAll fallback failed', {
                error: fallbackErr.message
              });
            }
            errors.push({
              system: 'cacheInvalidation',
              error: `retry failed: ${retryErr.message}; fallback ${fellBack ? 'ok' : 'failed'}`
            });
            if (storesTouched && !fellBack) {
              try {
                const tracker = require('./DegradedStateTracker').getInstance();
                tracker.raise({
                  code: 'filepath.cache-divergence',
                  subsystem: 'file-path-coordinator',
                  severity: 'warning',
                  message:
                    'File caches could not be invalidated after a batch path update. Some search or preview results may be out of sync until you reload the app.',
                  detail: { changeCount: pathChanges.length, retryError: retryErr.message }
                });
              } catch {
                // Tracker is best-effort
              }
            }
          }
        }
      } else if (!missingSystems.has('cacheInvalidation')) {
        errors.push({ system: 'cacheInvalidation', error: 'Cache invalidation bus unavailable' });
        missingSystems.add('cacheInvalidation');
        logger.warn('[FilePathCoordinator] Cache invalidation bus unavailable for batch update');
        if (storesTouched) {
          try {
            const tracker = require('./DegradedStateTracker').getInstance();
            tracker.raise({
              code: 'filepath.cache-bus-unavailable',
              subsystem: 'file-path-coordinator',
              severity: 'warning',
              message:
                'Cache invalidation bus unavailable during a batch path update; caches may be stale until the app restarts.',
              detail: { changeCount: pathChanges.length }
            });
          } catch {
            // Tracker is best-effort
          }
        }
      }

      this._invalidateRelationshipIndex();

      // Emit batch event
      this.emit('paths-changed', {
        type: options.type || PathChangeType.MOVE,
        changes: pathChanges,
        errors
      });

      const duration = Date.now() - startTime;
      const successful = results.filter((result) => result.success).length;
      const summary = {
        total: pathChanges.length,
        successful,
        failed: pathChanges.length - successful,
        duration,
        categoryCorrections: divergences.length
      };

      logger.info('[FilePathCoordinator] Batch path update complete', summary);

      return /** @type {any} */ ({
        success: errors.length === 0,
        results,
        errors,
        summary,
        divergences
      });
    } finally {
      for (const _l of resolveLocks) {
        const { key, resolve, promise } = /** @type {any} */ (_l);
        if (this._pathLocks.get(key) === promise) {
          this._pathLocks.delete(key);
        }
        resolve();
      }
      this._inFlightCount -= 1;
    }
  }

  /**
   * Handle file deletion across all systems
   *
   * @param {string} filePath - Path of deleted file
   * @param {any} [options]
   * @returns {Promise<{success: boolean, errors: Array<any>, cleaned: any}>}
   */
  async handleFileDeletion(filePath, options = {}) {
    const startTime = Date.now();

    logger.info('[FilePathCoordinator] Handling file deletion', {
      path: crossPlatformBasename(filePath)
    });

    const errors = [];
    const cleaned = {
      vectorDb: false,
      analysisHistory: false,
      embeddingQueue: false,
      processingState: false,
      cacheInvalidated: false
    };

    // 1. Remove from vector DB
    if (!options.skipVectorDb && this._vectorDbService) {
      try {
        await this._deleteFromVectorDb(filePath);
        cleaned.vectorDb = true;
      } catch (err) {
        errors.push({ system: 'vectorDb', error: err.message });
        logger.warn('[FilePathCoordinator] Vector DB deletion failed', { error: err.message });
      }
    } else if (!options.skipVectorDb) {
      errors.push({ system: 'vectorDb', error: 'Vector DB service unavailable' });
      logger.warn('[FilePathCoordinator] Vector DB service unavailable for deletion');
    }

    // 2. Remove from Analysis History
    if (!options.skipAnalysisHistory && this._analysisHistoryService) {
      try {
        await this._deleteFromAnalysisHistory(filePath);
        cleaned.analysisHistory = true;
      } catch (err) {
        errors.push({ system: 'analysisHistory', error: err.message });
        logger.warn('[FilePathCoordinator] Analysis history deletion failed', {
          error: err.message
        });
      }
    } else if (!options.skipAnalysisHistory) {
      errors.push({ system: 'analysisHistory', error: 'Analysis history service unavailable' });
      logger.warn('[FilePathCoordinator] Analysis history service unavailable for deletion');
    }

    // 3. Remove from Embedding Queue
    if (!options.skipEmbeddingQueue && this._embeddingQueue) {
      try {
        this._removeFromEmbeddingQueue(filePath);
        cleaned.embeddingQueue = true;
      } catch (err) {
        errors.push({ system: 'embeddingQueue', error: err.message });
        logger.warn('[FilePathCoordinator] Embedding queue removal failed', { error: err.message });
      }
    } else if (!options.skipEmbeddingQueue) {
      errors.push({ system: 'embeddingQueue', error: 'Embedding queue unavailable' });
      logger.warn('[FilePathCoordinator] Embedding queue unavailable for deletion');
    }

    // 4. Clear from Processing State
    if (!options.skipProcessingState && this._processingStateService) {
      try {
        await this._clearFromProcessingState(filePath);
        cleaned.processingState = true;
      } catch (err) {
        errors.push({ system: 'processingState', error: err.message });
        logger.warn('[FilePathCoordinator] Processing state clear failed', { error: err.message });
      }
    } else if (!options.skipProcessingState) {
      errors.push({ system: 'processingState', error: 'Processing state service unavailable' });
      logger.warn('[FilePathCoordinator] Processing state service unavailable for deletion');
    }

    // 5. Broadcast cache invalidation. If deletion broadcast fails after
    // stores have already pruned the file we must not leave caches claiming
    // it still exists. Retry once, then fall back to a coarse invalidateAll,
    // then surface a degraded flag.
    const storesPruned = cleaned.vectorDb || cleaned.analysisHistory || cleaned.processingState;
    if (this._cacheInvalidationBus) {
      try {
        this._cacheInvalidationBus.invalidateForDeletion(filePath);
        cleaned.cacheInvalidated = true;
        this._clearRecoverableDegradedFlags({ clearRelationship: false });
      } catch (err) {
        errors.push({ system: 'cacheInvalidation', error: err.message });
        logger.warn('[FilePathCoordinator] Cache invalidation failed, retrying', {
          error: err.message
        });
        try {
          this._cacheInvalidationBus.invalidateForDeletion(filePath);
          cleaned.cacheInvalidated = true;
        } catch (retryErr) {
          let fellBack = false;
          try {
            if (typeof this._cacheInvalidationBus.invalidateAll === 'function') {
              this._cacheInvalidationBus.invalidateAll('deletion-compensate');
              fellBack = true;
            }
          } catch (fallbackErr) {
            logger.error('[FilePathCoordinator] invalidateAll fallback failed on deletion', {
              error: fallbackErr.message
            });
          }
          errors.push({
            system: 'cacheInvalidation',
            error: `retry failed: ${retryErr.message}; fallback ${fellBack ? 'ok' : 'failed'}`
          });
          if (storesPruned && !fellBack) {
            try {
              const tracker = require('./DegradedStateTracker').getInstance();
              tracker.raise({
                code: 'filepath.cache-divergence',
                subsystem: 'file-path-coordinator',
                severity: 'warning',
                message:
                  'File caches could not be invalidated after a deletion. Some results may list files that no longer exist until you reload the app.',
                detail: {
                  path: crossPlatformBasename(filePath),
                  retryError: retryErr.message
                }
              });
            } catch {
              // Tracker is best-effort
            }
          }
        }
      }
    } else {
      errors.push({ system: 'cacheInvalidation', error: 'Cache invalidation bus unavailable' });
      logger.warn('[FilePathCoordinator] Cache invalidation bus unavailable for deletion');
      if (storesPruned) {
        try {
          const tracker = require('./DegradedStateTracker').getInstance();
          tracker.raise({
            code: 'filepath.cache-bus-unavailable',
            subsystem: 'file-path-coordinator',
            severity: 'warning',
            message:
              'Cache invalidation bus unavailable during a deletion; caches may be stale until the app restarts.',
            detail: { path: crossPlatformBasename(filePath) }
          });
        } catch {
          // Tracker is best-effort
        }
      }
    }

    // Emit deletion event
    this.emit('file-deleted', {
      path: filePath,
      cleaned,
      errors
    });

    const duration = Date.now() - startTime;
    logger.info('[FilePathCoordinator] File deletion handling complete', {
      duration,
      cleaned,
      errorCount: errors.length
    });

    return {
      success: errors.length === 0,
      errors,
      cleaned
    };
  }

  /**
   * Handle file copy (clone entries to new path)
   *
   * @param {string} sourcePath - Source file path
   * @param {string} destPath - Destination file path
   * @param {any} options - Options
   * @returns {Promise<{success: boolean, errors: Array<any>, cloned: any}>}
   */
  async handleFileCopy(sourcePath, destPath, options = {}) {
    const startTime = Date.now();

    logger.info('[FilePathCoordinator] Handling file copy', {
      source: crossPlatformBasename(sourcePath),
      dest: crossPlatformBasename(destPath)
    });

    const errors = [];
    const cloned = {
      vectorDb: false,
      analysisHistory: false,
      cacheInvalidated: false
    };

    // 1. Clone vector DB embedding
    if (!options.skipVectorDb && this._vectorDbService) {
      try {
        await this._cloneVectorDbEntry(sourcePath, destPath);
        cloned.vectorDb = true;
      } catch (err) {
        errors.push({ system: 'vectorDb', error: err.message });
        logger.warn('[FilePathCoordinator] Vector DB clone failed', { error: err.message });
      }
    } else if (!options.skipVectorDb) {
      errors.push({ system: 'vectorDb', error: 'Vector DB service unavailable' });
      logger.warn('[FilePathCoordinator] Vector DB service unavailable for copy');
    }

    // 2. Clone Analysis History entry
    if (!options.skipAnalysisHistory && this._analysisHistoryService) {
      try {
        await this._cloneAnalysisHistoryEntry(sourcePath, destPath);
        cloned.analysisHistory = true;
      } catch (err) {
        errors.push({ system: 'analysisHistory', error: err.message });
        logger.warn('[FilePathCoordinator] Analysis history clone failed', { error: err.message });
      }
    } else if (!options.skipAnalysisHistory) {
      errors.push({ system: 'analysisHistory', error: 'Analysis history service unavailable' });
      logger.warn('[FilePathCoordinator] Analysis history service unavailable for copy');
    }

    // 3. Broadcast cache invalidation. Same pattern as move: retry, coarse
    // fallback, then a degraded flag if neither succeeds after stores were
    // mutated.
    const copyStoresTouched = cloned.vectorDb || cloned.analysisHistory;
    if (this._cacheInvalidationBus) {
      try {
        this._cacheInvalidationBus.invalidateForPathChange(
          sourcePath,
          destPath,
          PathChangeType.COPY
        );
        cloned.cacheInvalidated = true;
        this._clearRecoverableDegradedFlags({ clearRelationship: false });
      } catch (err) {
        errors.push({ system: 'cacheInvalidation', error: err.message });
        logger.warn('[FilePathCoordinator] Cache invalidation failed on copy, retrying', {
          error: err.message
        });
        try {
          this._cacheInvalidationBus.invalidateForPathChange(
            sourcePath,
            destPath,
            PathChangeType.COPY
          );
          cloned.cacheInvalidated = true;
        } catch (retryErr) {
          let fellBack = false;
          try {
            if (typeof this._cacheInvalidationBus.invalidateAll === 'function') {
              this._cacheInvalidationBus.invalidateAll('copy-compensate');
              fellBack = true;
            }
          } catch (fallbackErr) {
            logger.error('[FilePathCoordinator] invalidateAll fallback failed on copy', {
              error: fallbackErr.message
            });
          }
          errors.push({
            system: 'cacheInvalidation',
            error: `retry failed: ${retryErr.message}; fallback ${fellBack ? 'ok' : 'failed'}`
          });
          if (copyStoresTouched && !fellBack) {
            try {
              const tracker = require('./DegradedStateTracker').getInstance();
              tracker.raise({
                code: 'filepath.cache-divergence',
                subsystem: 'file-path-coordinator',
                severity: 'warning',
                message:
                  'File caches could not be invalidated after a copy. Some search or preview results may be out of sync until you reload the app.',
                detail: {
                  source: crossPlatformBasename(sourcePath),
                  dest: crossPlatformBasename(destPath),
                  retryError: retryErr.message
                }
              });
            } catch {
              // Tracker is best-effort
            }
          }
        }
      }
    } else {
      errors.push({ system: 'cacheInvalidation', error: 'Cache invalidation bus unavailable' });
      logger.warn('[FilePathCoordinator] Cache invalidation bus unavailable for copy');
      if (copyStoresTouched) {
        try {
          const tracker = require('./DegradedStateTracker').getInstance();
          tracker.raise({
            code: 'filepath.cache-bus-unavailable',
            subsystem: 'file-path-coordinator',
            severity: 'warning',
            message:
              'Cache invalidation bus unavailable during a copy; caches may be stale until the app restarts.',
            detail: { source: crossPlatformBasename(sourcePath) }
          });
        } catch {
          // Tracker is best-effort
        }
      }
    }

    // Emit copy event
    this.emit('file-copied', {
      sourcePath,
      destPath,
      cloned,
      errors
    });

    const duration = Date.now() - startTime;
    logger.info('[FilePathCoordinator] File copy handling complete', {
      duration,
      cloned,
      errorCount: errors.length
    });

    return {
      success: errors.length === 0,
      errors,
      cloned
    };
  }

  // ==================== Private Helper Methods ====================

  /**
   * @param {Array<{oldPath: string, newPath: string}>} batch
   * @returns {Array<{oldPath: string, newPath: string}>}
   * @private
   */
  _reversePathBatch(batch) {
    return batch.map((c) => ({ oldPath: c.newPath, newPath: c.oldPath }));
  }

  /**
   * Clear degraded flags raised by this coordinator after a successful
   * operation. Called on the happy path so banners raised by a prior failure
   * (cache bus unavailable, cache divergence, relationship-index stale) drop
   * once the subsystem recovers — otherwise they stick across the session
   * even after the underlying condition has resolved.
   * @param {any} [opts]
   * @private
   */
  _clearRecoverableDegradedFlags({ clearCache = true, clearRelationship = true } = {}) {
    try {
      const tracker = require('./DegradedStateTracker').getInstance();
      if (!tracker || typeof tracker.clear !== 'function') return;
      if (clearCache) {
        tracker.clear('filepath.cache-bus-unavailable');
        tracker.clear('filepath.cache-divergence');
      }
      if (clearRelationship) {
        tracker.clear('filepath.relationship-index-stale');
      }
    } catch {
      // Tracker is best-effort; never throw from a recovery hook.
    }
  }

  /**
   * Force knowledge graph index to rebuild on next read after path changes.
   * Never throws: a failed invalidation is retried once, then surfaced as a
   * degraded-state flag instead of failing the parent path update.
   * @returns {{success: boolean, reason?: string, error?: string}}
   * @private
   */
  _invalidateRelationshipIndex() {
    if (!this._relationshipIndexService) {
      return { success: true, reason: 'no-service' };
    }
    if (typeof this._relationshipIndexService.invalidateIndex !== 'function') {
      return { success: true, reason: 'no-op' };
    }
    try {
      this._relationshipIndexService.invalidateIndex();
      this._clearRecoverableDegradedFlags({ clearCache: false });
      return { success: true };
    } catch (err) {
      logger.warn('[FilePathCoordinator] Relationship index invalidation failed, retrying', {
        error: err.message
      });
      try {
        this._relationshipIndexService.invalidateIndex();
        this._clearRecoverableDegradedFlags({ clearCache: false });
        return { success: true };
      } catch (retryErr) {
        logger.error('[FilePathCoordinator] Relationship index invalidation failed after retry', {
          error: retryErr.message
        });
        try {
          const tracker = require('./DegradedStateTracker').getInstance();
          tracker.raise({
            code: 'filepath.relationship-index-stale',
            subsystem: 'file-path-coordinator',
            severity: 'warning',
            message:
              'Knowledge graph edges could not be refreshed after a path change; graph views may show stale relationships until the app restarts.',
            detail: { error: retryErr.message }
          });
        } catch {
          // Tracker is best-effort
        }
        return { success: false, error: retryErr.message };
      }
    }
  }

  /**
   * Update vector DB path for a single file
   * @private
   */
  async _updateVectorDbPath(
    /** @type {any} */ oldPath,
    /** @type {any} */ newPath,
    /** @type {any} */ folderMeta = null
  ) {
    // Same folder metadata the batch path carries (K-11): without it an undo
    // that moved a file back out of a Smart Folder left the vector row, and
    // so the Atlas, showing it in the folder it had just left.
    const newMeta = folderMeta ? this._buildVectorFolderMeta(folderMeta) : null;
    const pathUpdates = buildPathUpdatePairs(
      oldPath,
      newPath,
      newMeta && Object.keys(newMeta).length > 0 ? { newMeta } : undefined
    );

    if (pathUpdates.length > 0 && this._vectorDbService.updateFilePaths) {
      await this._vectorDbService.updateFilePaths(pathUpdates);
    }

    await this._rekeyFileChunks(oldPath, pathUpdates);
  }

  /**
   * Move a file's chunk vectors to its new id (F-199 / CP-13, K-11). The old
   * behaviour deleted them and never rebuilt, so organizing a file removed
   * its deep-recall search. Clone first, delete the old variants only when
   * every clone succeeded — a failed clone keeps the old chunks (still
   * reachable via the old id) rather than leaving nothing.
   * @private
   * @param {string} oldPath
   * @param {Array<{oldId: string, newId: string}>} pathUpdates
   */
  async _rekeyFileChunks(oldPath, pathUpdates) {
    const store = this._vectorDbService;
    if (typeof store?.deleteFileChunks !== 'function') return;

    let cloneFailed = false;
    if (typeof store.cloneFileChunks === 'function') {
      for (const { oldId, newId } of pathUpdates) {
        if (!oldId || !newId || oldId === newId) continue;
        try {
          await store.cloneFileChunks(oldId, newId);
        } catch (error) {
          cloneFailed = true;
          logger.warn('[FilePathCoordinator] Chunk re-key failed; keeping old chunks', {
            oldId,
            newId,
            error: /** @type {any} */ (error)?.message
          });
        }
      }
    }
    if (cloneFailed) return;

    const newIds = new Set(pathUpdates.map((u) => u.newId));
    for (const id of getAllIdVariants(oldPath)) {
      if (newIds.has(id)) continue;
      await store.deleteFileChunks(id);
    }
  }

  /**
   * Batch update vector DB paths
   * @private
   */
  async _batchUpdateVectorDbPaths(/** @type {any} */ changes) {
    // buildPathUpdatePairs already deduplicates internally via seen-set.
    // Carry the destination folder into the vector row too (K-11): history
    // got it via _buildHistoryCategorySync, but the vector kept the pre-move
    // category/smartFolder, so the Atlas and anything reading vector metadata
    // placed an organized file in the folder it had just left.
    const perChange = changes.map((/** @type {any} */ change) => ({
      change,
      pairs: buildPathUpdatePairs(change.oldPath, change.newPath, {
        newMeta: this._buildVectorFolderMeta(change)
      })
    }));
    const pathUpdates = perChange.flatMap((/** @type {any} */ entry) => entry.pairs);

    if (pathUpdates.length > 0 && this._vectorDbService.updateFilePaths) {
      await this._vectorDbService.updateFilePaths(pathUpdates);
    }

    for (const { change, pairs } of perChange) {
      await this._rekeyFileChunks(change.oldPath, pairs);
    }
  }

  /**
   * Delete from vector DB
   * @private
   */
  async _deleteFromVectorDb(/** @type {any} */ filePath) {
    const ids = getAllIdVariants(filePath);
    if (typeof this._vectorDbService.batchDeleteFileEmbeddings === 'function') {
      await this._vectorDbService.batchDeleteFileEmbeddings(ids);
    } else {
      for (const id of ids) {
        if (this._vectorDbService.deleteFileEmbedding) {
          await this._vectorDbService.deleteFileEmbedding(id);
        }
      }
    }

    // Also delete associated chunks (need raw path variants as parent ID prefixes)
    if (typeof this._vectorDbService.deleteFileChunks === 'function') {
      for (const id of ids) {
        await this._vectorDbService.deleteFileChunks(id);
      }
    }
  }

  /**
   * Clone vector DB entry for file copy
   * @private
   */
  async _cloneVectorDbEntry(/** @type {any} */ sourcePath, /** @type {any} */ destPath) {
    const sourceId = getFileEmbeddingId(sourcePath, 'file');
    const destId = getFileEmbeddingId(destPath, 'file');
    const destMeta = {
      path: destPath,
      name: crossPlatformBasename(destPath)
    };

    if (this._vectorDbService.cloneFileEmbedding) {
      await this._vectorDbService.cloneFileEmbedding(sourceId, destId, destMeta);
    } else {
      throw new Error('Vector DB cloneFileEmbedding not available');
    }

    if (typeof this._vectorDbService.cloneFileChunks === 'function') {
      await this._vectorDbService.cloneFileChunks(sourceId, destId, destMeta);
    } else {
      throw new Error('Vector DB cloneFileChunks not available');
    }
  }

  /**
   * Destination-folder fields for the vector row, from the same per-change
   * context _buildHistoryCategorySync uses. Empty when the caller supplied
   * none (plain renames, rollbacks), so those only touch path and name.
   * @private
   * @param {any} change
   * @returns {Record<string, string|null>}
   */
  _buildVectorFolderMeta(change) {
    const sync = this._buildHistoryCategorySync(change);
    /** @type {Record<string, string|null>} */
    const meta = {};
    if (sync.newCategory) meta.category = sync.newCategory;
    if (sync.newSmartFolder !== undefined) meta.smartFolder = sync.newSmartFolder;
    if (sync.newSmartFolderPath !== undefined) meta.smartFolderPath = sync.newSmartFolderPath;
    return meta;
  }

  /**
   * Build the optional category-sync fields for AnalysisHistory.updateEntryPaths.
   * Callers pass smart-folder context per pathChange so the analysis-history
   * record can reconcile its cached category with the file's new home.
   * A file leaving every Smart Folder (an undo back to Downloads) must have
   * its folder fields cleared, not kept; callers say so with
   * `clearSmartFolder`, which becomes explicit nulls here so the vector row
   * and the history entry are told the same thing. The category is left
   * alone: it is the analysis verdict, not a property of the folder.
   * @private
   * @param {any} change
   * @returns {{ newCategory?: string, newSmartFolder?: string|null, newSmartFolderPath?: string|null }}
   */
  _buildHistoryCategorySync(change) {
    /** @type {{ newCategory?: string, newSmartFolder?: string|null, newSmartFolderPath?: string|null }} */
    const sync = {};
    if (typeof change?.newCategory === 'string' && change.newCategory.length > 0) {
      sync.newCategory = change.newCategory;
    }
    if (typeof change?.newSmartFolder === 'string' && change.newSmartFolder.length > 0) {
      sync.newSmartFolder = change.newSmartFolder;
    }
    if (typeof change?.newSmartFolderPath === 'string' && change.newSmartFolderPath.length > 0) {
      sync.newSmartFolderPath = change.newSmartFolderPath;
    }
    if (change?.clearSmartFolder === true) {
      sync.newSmartFolder = null;
      sync.newSmartFolderPath = null;
    }
    return sync;
  }

  /**
   * Update Analysis History path for a single file
   * @private
   */
  async _updateAnalysisHistoryPath(
    /** @type {any} */ oldPath,
    /** @type {any} */ newPath,
    change = {}
  ) {
    if (!this._analysisHistoryService.updateEntryPaths) {
      throw new Error('AnalysisHistory updateEntryPaths not available');
    }
    await this._analysisHistoryService.updateEntryPaths([
      {
        oldPath,
        newPath,
        newName: crossPlatformBasename(newPath),
        ...this._buildHistoryCategorySync(change)
      }
    ]);
  }

  /**
   * Batch update Analysis History paths
   * @private
   */
  async _batchUpdateAnalysisHistoryPaths(/** @type {any} */ changes) {
    if (!this._analysisHistoryService.updateEntryPaths) {
      throw new Error('AnalysisHistory updateEntryPaths not available');
    }
    const historyUpdates = changes.map((/** @type {any} */ c) => ({
      oldPath: c.oldPath,
      newPath: c.newPath,
      newName: crossPlatformBasename(c.newPath),
      ...this._buildHistoryCategorySync(c)
    }));
    return await this._analysisHistoryService.updateEntryPaths(historyUpdates);
  }

  /**
   * Delete from Analysis History
   * @private
   */
  async _deleteFromAnalysisHistory(/** @type {any} */ filePath) {
    if (!this._analysisHistoryService.removeEntriesByPath) {
      throw new Error('AnalysisHistory removeEntriesByPath not available');
    }
    await this._analysisHistoryService.removeEntriesByPath(filePath);
  }

  /**
   * Clone Analysis History entry for file copy
   * @private
   */
  async _cloneAnalysisHistoryEntry(/** @type {any} */ sourcePath, /** @type {any} */ destPath) {
    if (!this._analysisHistoryService.cloneEntryForCopy) {
      throw new Error('AnalysisHistory cloneEntryForCopy not available');
    }
    await this._analysisHistoryService.cloneEntryForCopy(sourcePath, destPath);
  }

  /**
   * Update Embedding Queue path for a single file
   * @private
   */
  _updateEmbeddingQueuePath(/** @type {any} */ oldPath, /** @type {any} */ newPath) {
    if (!this._embeddingQueue.updateByFilePath) {
      throw new Error('EmbeddingQueue updateByFilePath not available');
    }
    this._embeddingQueue.updateByFilePath(oldPath, newPath);
  }

  /**
   * Batch update Embedding Queue paths
   * @private
   */
  _batchUpdateEmbeddingQueuePaths(/** @type {any} */ changes) {
    if (!this._embeddingQueue.updateByFilePaths) {
      throw new Error('EmbeddingQueue updateByFilePaths not available');
    }
    this._embeddingQueue.updateByFilePaths(changes);
  }

  /**
   * Remove from Embedding Queue
   * @private
   */
  _removeFromEmbeddingQueue(/** @type {any} */ filePath) {
    if (!this._embeddingQueue.removeByFilePath) {
      throw new Error('EmbeddingQueue removeByFilePath not available');
    }
    this._embeddingQueue.removeByFilePath(filePath);
  }

  /**
   * Update Processing State path
   * @private
   */
  async _updateProcessingStatePath(/** @type {any} */ oldPath, /** @type {any} */ newPath) {
    // directly mutating state.analysis.jobs, which bypassed the _writeLock mutex
    // and created TOCTOU race conditions with concurrent markAnalysis* calls.
    if (typeof this._processingStateService.moveJob !== 'function') {
      throw new Error('ProcessingState moveJob not available');
    }
    await this._processingStateService.moveJob(oldPath, newPath);
  }

  /**
   * Clear from Processing State
   * @private
   */
  async _clearFromProcessingState(/** @type {any} */ filePath) {
    if (!this._processingStateService.clearState) {
      throw new Error('ProcessingState clearState not available');
    }
    await this._processingStateService.clearState(filePath);
  }

  /**
   * Snapshot of coordinator wiring and load for diagnostics: which dependent
   * systems are currently connected and how many path updates are mid-flight.
   * Synchronous and side-effect free, so it is safe to poll from health checks.
   *
   * @returns {{pendingOperations: number, hasVectorDb: boolean, hasAnalysisHistory: boolean, hasEmbeddingQueue: boolean, hasProcessingState: boolean, hasCacheInvalidation: boolean, hasRelationshipIndex: boolean}}
   */
  getStats() {
    return {
      pendingOperations: this._pendingOperations.size,
      hasVectorDb: !!this._vectorDbService,
      hasAnalysisHistory: !!this._analysisHistoryService,
      hasEmbeddingQueue: !!this._embeddingQueue,
      hasProcessingState: !!this._processingStateService,
      hasCacheInvalidation: !!this._cacheInvalidationBus,
      hasRelationshipIndex: !!this._relationshipIndexService
    };
  }

  /**
   * Shutdown the coordinator. Gates new path updates immediately, then waits
   * (bounded) for in-flight updates to finish before clearing locks — a
   * synchronous clear mid-update would release mutexes under an active
   * operation and let half-applied cross-system state interleave.
   *
   * @param {any} [options]
   * @returns {Promise<void>}
   */
  async shutdown({ drainTimeoutMs = 5000 } = {}) {
    this._isShutdown = true;

    const deadline = Date.now() + drainTimeoutMs;
    while (this._inFlightCount > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (this._inFlightCount > 0) {
      logger.warn('[FilePathCoordinator] Shutdown drain timed out with in-flight updates', {
        inFlight: this._inFlightCount,
        drainTimeoutMs
      });
    }

    this.removeAllListeners();
    this._pendingOperations.clear();
    this._pathLocks.clear();
    logger.info('[FilePathCoordinator] Shutdown complete');
  }
}

// Singleton management
const { createSingletonHelpers } = require('../../shared/singletonFactory');

const { getInstance, resetInstance, registerWithContainer } = createSingletonHelpers({
  ServiceClass: FilePathCoordinator,
  serviceId: 'FILE_PATH_COORDINATOR',
  serviceName: 'FilePathCoordinator',
  getContainer: () => require('./ServiceContainer'),
  shutdownMethod: 'shutdown'
});

module.exports = {
  FilePathCoordinator,
  PathChangeType,
  getInstance,
  resetInstance,
  registerWithContainer
};
