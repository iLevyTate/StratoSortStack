// @ts-check
/**
 * BatchAnalysisService — concurrent multi-file analysis orchestrator.
 *
 * Partitions an input file list by modality (document / image / media) via
 * `analysisRouting`, then runs each partition through its analyzer with a
 * semaphore-bounded concurrency cap. Tracks in-flight + completed counts
 * per section so the renderer can render accurate progress bars across
 * mixed batches. Whisper is loaded lazily so an analysis that has no
 * media files never pays the model-load cost.
 */
const { BatchProcessor } = require('../utils/llmOptimization');
const { createLogger } = require('../../shared/logger');
const { Semaphore, delay } = require('../../shared/promiseUtils');

const logger = createLogger('BatchAnalysisService');
const { analyzeDocumentFile } = require('../analysis/documentAnalysis');
const { analyzeImageFile } = require('../analysis/imageAnalysis');
const { getInstance: getWhisperService } = require('./WhisperService');
const { createMediaAnalyzerAdapter } = require('./mediaAnalyzerAdapter');
const {
  partitionFilesByModality: routingPartitionFilesByModality,
  isImageFile: routingIsImageFile,
  isMediaFile: routingIsMediaFile
} = require('./analysisRouting');

function getSectionKeys(/** @type {any} */ section) {
  switch (section) {
    case 'images':
      return { inFlight: 'imageInFlight', completed: 'imagesCompleted', type: 'image' };
    case 'media':
      return { inFlight: 'mediaInFlight', completed: 'mediaCompleted', type: 'media' };
    default:
      return { inFlight: 'docInFlight', completed: 'documentsCompleted', type: 'document' };
  }
}

function safeGetWhisperService() {
  try {
    return getWhisperService();
  } catch {
    return null;
  }
}

function resolveAnalyzerForSection(/** @type {any} */ section, /** @type {any} */ analyzers) {
  if (section === 'images') {
    return analyzers?.image || analyzeImageFile;
  }
  if (section === 'media') {
    if (analyzers?.media) return analyzers.media;
    return createMediaAnalyzerAdapter({ whisperService: safeGetWhisperService() });
  }
  return analyzers?.document || analyzeDocumentFile;
}
const { getInstance: getParallelEmbeddingService } = require('./ParallelEmbeddingService');
const { analysisQueue } = require('../analysis/embeddingQueue/stageQueues');
const embeddingQueueManager = require('../analysis/embeddingQueue/queueManager');
const path = require('path');
const os = require('os');
const { get: getConfig } = require('../../shared/config/index');
const { getInstance: getLlamaService } = require('./LlamaService');
const { getRecommendedConcurrency } = require('./PerformanceService');
const { getInstance: getModelAccessCoordinator } = require('./ModelAccessCoordinator');

const { getFileTypeSingular } = require('./autoOrganize/fileTypeUtils');

/**
 * BatchAnalysisService
 * Processes multiple files in parallel with intelligent concurrency control
 * Reduces total processing time by analyzing files concurrently
 *
 * FIX: Now integrates with ParallelEmbeddingService for improved embedding throughput
 */
class BatchAnalysisService {
  /**
   * @param {any} [options]
   */
  constructor(options = {}) {
    // Get max concurrency from unified config
    const configMaxConcurrency = getConfig('ANALYSIS.maxConcurrency', 3);
    const configRetryAttempts = getConfig('ANALYSIS.retryAttempts', 3);

    // Calculate optimal concurrency based on CPU cores if not specified
    this.concurrency =
      options.concurrency || Math.min(this.calculateOptimalConcurrency(), configMaxConcurrency);
    this.batchProcessor = new BatchProcessor(this.concurrency);

    // Store the initial config but always access the live singleton via getter
    // to avoid holding a stale reference if the service is reset/recreated.
    this._embeddingServiceConfig = {
      concurrencyLimit: Math.min(this.concurrency, 5),
      maxRetries: configRetryAttempts
    };
    // Ensure singleton is created with initial config
    getParallelEmbeddingService(this._embeddingServiceConfig);

    // Ensures only one worker checks the queue capacity at a time, preventing "check-then-act" races
    this.backpressureLock = new Semaphore(1);

    this._embeddingProgressUnsubscribe = null;
    this._backpressureWaitPromise = null;
    this._adaptiveRecommendation = null;
    this._adaptiveRecommendationAt = 0;
    this._adaptiveRecommendationTtlMs = 30000;

    logger.info('[BATCH-ANALYSIS] Service initialized', {
      concurrency: this.concurrency,
      embeddingConcurrency: this._embeddingServiceConfig.concurrencyLimit,
      cpuCores: os.cpus().length
    });
  }

  /**
   * Derive a safe default concurrency from the host: 75% of CPU cores, halved
   * under memory pressure (>85% used), and hard-capped at 3 to match the
   * global AI semaphore — higher values would only hold file buffers in
   * memory while waiting for an inference slot.
   *
   * @returns {number} Concurrency in the range [2, 3]
   */
  calculateOptimalConcurrency() {
    const cpuCores = os.cpus().length;
    const freeMem = os.freemem();
    const totalMem = os.totalmem();
    const memUsage = totalMem > 0 ? Math.max(0, Math.min(1, 1 - freeMem / totalMem)) : 0.5;

    // Base concurrency on CPU cores (75% utilization to leave headroom)
    let concurrency = Math.max(2, Math.floor(cpuCores * 0.75));

    // Reduce if memory pressure is high (>85% usage)
    if (memUsage > 0.85) {
      concurrency = Math.max(2, Math.floor(concurrency * 0.5));
      logger.warn('[BATCH-ANALYSIS] High memory usage detected, reducing concurrency', {
        memUsage: `${(memUsage * 100).toFixed(1)}%`,
        reducedConcurrency: concurrency
      });
    }

    // Cap at global AI semaphore limit (3) to avoid holding memory while waiting for slots
    concurrency = Math.min(concurrency, 3);

    logger.debug('[BATCH-ANALYSIS] Calculated optimal concurrency', {
      cpuCores,
      memUsage: `${(memUsage * 100).toFixed(1)}%`,
      concurrency
    });

    return concurrency;
  }

  /**
   * Deterministically partition files into document, image, and media sections.
   * Preserves input order inside each modality lane.
   * Delegates to ./analysisRouting so verify scripts can call the partitioner
   * without instantiating this service.
   * @param {string[]} filePaths
   * @returns {Record<string, string[]>}
   */
  partitionFilesByModality(filePaths) {
    return routingPartitionFilesByModality(filePaths);
  }

  _resolveSectionOrder(/** @type {any} */ option) {
    if (option === 'images-first') {
      return ['images', 'documents', 'media'];
    }
    return ['documents', 'images', 'media'];
  }

  _safeCoordinatorQueueStats() {
    try {
      return getModelAccessCoordinator()?.getQueueStats?.() || null;
    } catch (error) {
      logger.debug('[BATCH-ANALYSIS] Failed to read coordinator queue stats', {
        error: error?.message
      });
      return null;
    }
  }

  async _getAdaptiveConcurrency(/** @type {any} */ requestedConcurrency, autoConcurrency = true) {
    let capped = requestedConcurrency;
    let perfRecommendation = null;

    try {
      const now = Date.now();
      if (
        this._adaptiveRecommendation &&
        now - this._adaptiveRecommendationAt < this._adaptiveRecommendationTtlMs
      ) {
        perfRecommendation = this._adaptiveRecommendation;
      } else {
        perfRecommendation = await getRecommendedConcurrency();
        this._adaptiveRecommendation = perfRecommendation;
        this._adaptiveRecommendationAt = now;
      }

      // The *static* hardware cap only applies in hardware-aware (auto) mode.
      // When the user has explicitly opted into manual concurrency, we honor
      // their value here; the queue-pressure reductions below (runtime
      // backpressure) still apply in both modes to protect against OOM.
      if (
        autoConcurrency !== false &&
        Number.isFinite(perfRecommendation?.maxConcurrent) &&
        perfRecommendation.maxConcurrent > 0
      ) {
        capped = Math.min(capped, perfRecommendation.maxConcurrent);
      }
    } catch (error) {
      logger.debug('[BATCH-ANALYSIS] Performance-based concurrency recommendation unavailable', {
        error: error?.message
      });
    }

    const queueStats = this._safeCoordinatorQueueStats();
    if (queueStats) {
      const modelTypes = Object.keys(queueStats);
      const totalQueued = modelTypes.reduce(
        (sum, type) => sum + (Number(queueStats[type]?.queued) || 0),
        0
      );
      const totalPending = modelTypes.reduce(
        (sum, type) => sum + (Number(queueStats[type]?.pending) || 0),
        0
      );
      const visionPressure =
        (Number(queueStats.vision?.queued) || 0) + (Number(queueStats.vision?.pending) || 0);

      if (visionPressure > 0) {
        capped = Math.min(capped, 1);
      } else if (totalQueued + totalPending >= 4) {
        capped = Math.min(capped, 2);
      }
    }

    const adaptiveConcurrency = Math.max(1, Math.min(Number(capped) || 1, 8));

    logger.debug('[BATCH-ANALYSIS] Adaptive concurrency resolved', {
      requestedConcurrency,
      adaptiveConcurrency,
      perfMaxConcurrent: perfRecommendation?.maxConcurrent ?? null
    });

    return adaptiveConcurrency;
  }

  /**
   * Analyze multiple files in parallel with concurrency and adaptive backpressure.
   *
   * @param {string[]} filePaths
   * @param {any[]} [smartFolders]
   * @param {any} [options]
   * @returns {Promise<any>}
   */
  async analyzeFiles(filePaths, smartFolders = [], options = {}) {
    const {
      onProgress = null,
      onEmbeddingProgress = null,
      stopOnError = false,
      concurrency: rawConcurrency = this.concurrency,
      autoConcurrency = true,
      sectionOrder = 'documents-first',
      documentAnalyzer = null,
      imageAnalyzer = null,
      mediaAnalyzer = null,
      onFileComplete = null,
      disableAdaptiveConcurrency = false,
      isCancelled = null,
      abortSignal = null,
      batchId = null
    } = options;
    const cancellationRequested = () =>
      (typeof isCancelled === 'function' && isCancelled()) || false;

    const requestedConcurrency = Math.max(
      1,
      Math.min(Number.isFinite(rawConcurrency) ? rawConcurrency : this.concurrency, 8)
    );
    const concurrency = disableAdaptiveConcurrency
      ? requestedConcurrency
      : await this._getAdaptiveConcurrency(requestedConcurrency, autoConcurrency);

    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      return {
        success: true,
        results: [],
        errors: [],
        total: 0
      };
    }

    const partitioned = this.partitionFilesByModality(filePaths);
    const orderedSections = this._resolveSectionOrder(sectionOrder).filter(
      (section) => partitioned[section]?.length > 0
    );

    logger.info('[BATCH-ANALYSIS] Starting batch file analysis', {
      fileCount: filePaths.length,
      requestedConcurrency,
      concurrency,
      sectionOrder: orderedSections,
      documentCount: partitioned.documents.length,
      imageCount: partitioned.images.length,
      mediaCount: partitioned.media.length,
      smartFolders: smartFolders.length
    });

    const startTime = Date.now();
    const progressState = {
      total: filePaths.length,
      completed: 0,
      documentsTotal: partitioned.documents.length,
      imagesTotal: partitioned.images.length,
      mediaTotal: partitioned.media.length,
      documentsCompleted: 0,
      imagesCompleted: 0,
      mediaCompleted: 0,
      docInFlight: 0,
      imageInFlight: 0,
      mediaInFlight: 0
    };
    /** @type {Record<string, any>} */
    const sectionStats = {
      documents: { total: partitioned.documents.length, durationMs: 0, successful: 0, failed: 0 },
      images: { total: partitioned.images.length, durationMs: 0, successful: 0, failed: 0 },
      media: { total: partitioned.media.length, durationMs: 0, successful: 0, failed: 0 }
    };
    const embeddingStats = {
      startQueueSize: analysisQueue.getStats().queueLength,
      embeddings: 0
    };
    const warnings = [];

    let embeddingProgressUnsubscribe = null;
    if (onEmbeddingProgress) {
      embeddingProgressUnsubscribe = analysisQueue.onProgress(onEmbeddingProgress);
      this._embeddingProgressUnsubscribe = embeddingProgressUnsubscribe;
    }

    try {
      if (onProgress) {
        onProgress({
          ...this._buildProgressSnapshot(progressState, 'partitioned'),
          message: `Partitioned ${partitioned.documents.length} documents, ${partitioned.images.length} images, and ${partitioned.media.length} media`,
          sectionOrder: orderedSections
        });
      }

      const sectionResults = [];
      let cancelled = false;
      let processedCount = 0;
      for (const section of orderedSections) {
        if (cancellationRequested()) {
          cancelled = true;
          logger.info('[BATCH-ANALYSIS] Cancellation requested before section start', {
            batchId,
            section
          });
          break;
        }
        const sectionFiles = partitioned[section];
        const sectionIsImage = section === 'images';
        const sectionConcurrency = Math.max(1, Math.min(concurrency, sectionFiles.length || 1));
        const sectionStart = Date.now();
        // Vision batch mode is on by default in production. Tests can opt out
        // by passing { enableVisionBatchMode: false } in options. The previous
        // design defaulted to disabled in NODE_ENV=test, which meant batch-
        // mode bugs were invisible to the unit suite — there was no way for
        // a test to actually exercise the batch-mode code path. Now batch
        // mode runs in tests too unless the caller explicitly disables it.
        const visionBatchModeEnabled = options.enableVisionBatchMode !== false;
        const shouldUseVisionBatchMode =
          sectionIsImage && visionBatchModeEnabled && sectionFiles.length > 1;
        let visionBatchModeEntered = false;

        if (shouldUseVisionBatchMode) {
          try {
            await getLlamaService().enterVisionBatchMode();
            visionBatchModeEntered = true;
            logger.info('[BATCH-ANALYSIS] Entered vision batch mode for image section', {
              imageCount: sectionFiles.length
            });
          } catch (error) {
            logger.warn('[BATCH-ANALYSIS] Failed to enter vision batch mode, continuing', {
              error: error?.message
            });
            warnings.push(`Vision batch mode entry failed: ${error?.message}`);
          }
        }

        try {
          const sectionResult = await this._analyzeSection(sectionFiles, smartFolders, {
            section,
            sectionConcurrency,
            stopOnError,
            onProgress,
            onFileComplete,
            progressState,
            embeddingStats,
            isCancelled: cancellationRequested,
            abortSignal,
            analyzers: {
              document: documentAnalyzer,
              image: imageAnalyzer,
              media: mediaAnalyzer
            }
          });

          sectionResults.push(sectionResult);
          processedCount += Number(sectionResult.processed || 0);
          if (sectionResult.cancelled) {
            cancelled = true;
          }
          sectionStats[section].durationMs = Date.now() - sectionStart;
          sectionStats[section].successful = sectionResult.successful;
          sectionStats[section].failed = sectionResult.errors.length;

          if (stopOnError && sectionResult.errors.length > 0) {
            logger.warn('[BATCH-ANALYSIS] Stopping early after section error', {
              section,
              failed: sectionResult.errors.length
            });
            break;
          }
          if (cancelled || cancellationRequested()) {
            cancelled = true;
            logger.info('[BATCH-ANALYSIS] Stopping remaining sections due to cancellation', {
              batchId,
              section
            });
            break;
          }
        } finally {
          if (visionBatchModeEntered) {
            try {
              await getLlamaService().exitVisionBatchMode();
              logger.info('[BATCH-ANALYSIS] Exited vision batch mode after image section');
            } catch (error) {
              logger.warn('[BATCH-ANALYSIS] Failed to exit vision batch mode', {
                error: error?.message
              });
              warnings.push(`Vision batch mode exit failed: ${error?.message}`);
            }
          }
        }
      }

      const combinedResults = sectionResults.flatMap((result) => result.results || []);
      const combinedErrors = sectionResults.flatMap((result) => result.errors || []);
      const resultByPath = new Map();
      for (const result of combinedResults) {
        if (result?.filePath) {
          resultByPath.set(result.filePath, result);
        }
      }
      const orderedResults = filePaths
        .map((filePath) => resultByPath.get(filePath))
        .filter(Boolean);
      const successful = orderedResults.filter((result) => result.success).length;

      return await this._finalizeBatch({
        filePaths,
        startTime,
        onProgress,
        embeddingStats,
        orderedResults,
        combinedErrors,
        successful,
        cancelled,
        processedCount,
        concurrency,
        requestedConcurrency,
        sectionStats,
        warnings
      });
    } finally {
      if (embeddingProgressUnsubscribe) {
        embeddingProgressUnsubscribe();
      }
      this._embeddingProgressUnsubscribe = null;
    }
  }

  async _analyzeSection(
    /** @type {any} */ filePaths,
    /** @type {any} */ smartFolders,
    /** @type {any} */ options
  ) {
    const {
      section,
      sectionConcurrency,
      stopOnError,
      onProgress,
      onFileComplete,
      progressState,
      embeddingStats,
      isCancelled,
      abortSignal = null,
      analyzers
    } = options;
    const analyzer = resolveAnalyzerForSection(section, analyzers);

    const BACKPRESSURE_TIMEOUT_MS = 60000;
    const BACKPRESSURE_INITIAL_DELAY_MS = 500;
    const BACKPRESSURE_MAX_DELAY_MS = 5000;

    // Absolute-floor memory guard (crash hardening). Batch analysis on
    // constrained hosts (e.g. 16GB RAM / 6GB VRAM) can drive the OS to
    // near-OOM while the resident text model holds ~4GB; a large image/OCR
    // file or a second model load can then tip it into an OS kill that shows
    // as an app crash + restart. A PERCENTAGE gate is useless here because the
    // resident model legitimately keeps free memory low for the whole batch —
    // it would stall indefinitely. Instead we pause the NEXT file start only
    // when free memory falls into genuine near-OOM territory, and only briefly,
    // so a transient allocation spike can clear before more heavy work begins.
    const MEMORY_FLOOR_BYTES = 300 * 1024 * 1024; // pause below ~300MB free
    const MEMORY_WAIT_TIMEOUT_MS = 8000;
    const MEMORY_WAIT_POLL_MS = 1000;

    const waitForMemoryHeadroom = async () => {
      if (os.freemem() >= MEMORY_FLOOR_BYTES) return true;
      const start = Date.now();
      logger.warn('[BATCH-ANALYSIS] Pausing next file: system memory near capacity', {
        freeMemMB: Math.round(os.freemem() / (1024 * 1024)),
        floorMB: Math.round(MEMORY_FLOOR_BYTES / (1024 * 1024))
      });
      while (os.freemem() < MEMORY_FLOOR_BYTES) {
        if (typeof isCancelled === 'function' && isCancelled()) return false;
        if (Date.now() - start >= MEMORY_WAIT_TIMEOUT_MS) {
          logger.warn('[BATCH-ANALYSIS] Memory-pressure wait timed out; proceeding anyway', {
            freeMemMB: Math.round(os.freemem() / (1024 * 1024))
          });
          break;
        }
        await delay(MEMORY_WAIT_POLL_MS);
      }
      return true;
    };

    const checkBackpressure = async () => {
      if (typeof isCancelled === 'function' && isCancelled()) {
        return false;
      }
      let shouldWait = false;
      await this.backpressureLock.acquire();
      try {
        const stats = analysisQueue.getStats();
        if (stats.capacityPercent >= 75) {
          shouldWait = true;
          logger.warn('[BATCH-ANALYSIS] Backpressure: embedding queue at capacity', {
            capacityPercent: stats.capacityPercent,
            queueLength: stats.queueLength
          });
        }
      } finally {
        this.backpressureLock.release();
      }

      if (!shouldWait) {
        return true;
      }

      if (!this._backpressureWaitPromise) {
        this._backpressureWaitPromise = (async () => {
          const backpressureStart = Date.now();
          let backpressureDelay = BACKPRESSURE_INITIAL_DELAY_MS;
          let iterations = 0;
          let lastQueueLength = -1;
          let stalledChecks = 0;

          while (true) {
            if (typeof isCancelled === 'function' && isCancelled()) {
              logger.info('[BATCH-ANALYSIS] Backpressure wait exited due to cancellation', {
                section
              });
              return false;
            }
            const elapsed = Date.now() - backpressureStart;
            if (elapsed >= BACKPRESSURE_TIMEOUT_MS) {
              logger.warn('[BATCH-ANALYSIS] Backpressure timeout reached, continuing anyway', {
                elapsed
              });
              break;
            }

            await delay(backpressureDelay);
            backpressureDelay = Math.min(backpressureDelay * 1.5, BACKPRESSURE_MAX_DELAY_MS);
            iterations++;

            let stillFull = false;
            await this.backpressureLock.acquire();
            try {
              const currentStats = analysisQueue.getStats();

              // Check if queue is actually draining
              // If queue length hasn't decreased (and we are waiting), it might be stalled
              if (lastQueueLength !== -1 && currentStats.queueLength >= lastQueueLength) {
                stalledChecks++;
              } else {
                stalledChecks = 0;
              }
              lastQueueLength = currentStats.queueLength;

              // If queue hasn't moved for 5 consecutive checks, assume consumer is dead/stuck and proceed
              // This prevents the batch from hanging for 60s per file
              if (stalledChecks >= 5) {
                logger.warn(
                  '[BATCH-ANALYSIS] Embedding queue appears stalled (not draining), bypassing backpressure',
                  {
                    queueLength: currentStats.queueLength,
                    stalledChecks
                  }
                );
                break;
              }

              if (currentStats.capacityPercent > 50) {
                stillFull = true;
                if (iterations % 10 === 0) {
                  logger.debug('[BATCH-ANALYSIS] Waiting for embedding queue to drain', {
                    elapsed,
                    capacityPercent: currentStats.capacityPercent,
                    iterations
                  });
                }
              }
            } finally {
              this.backpressureLock.release();
            }

            if (!stillFull) {
              logger.info('[BATCH-ANALYSIS] Embedding queue drained, resuming analysis', {
                waitTime: Date.now() - backpressureStart
              });
              break;
            }
          }
          return true;
        })()
          .catch((err) => {
            logger.error('[BATCH-ANALYSIS] Backpressure wait failed', { error: err?.message });
            return true; // proceed anyway on error
          })
          .finally(() => {
            this._backpressureWaitPromise = null;
          });
      }

      const canProceed = await this._backpressureWaitPromise;
      return canProceed !== false;
    };

    const processFile = async (/** @type {any} */ filePath, /** @type {any} */ index) => {
      if (typeof isCancelled === 'function' && isCancelled()) {
        return null;
      }
      const sectionKeys = getSectionKeys(section);
      const inFlightKey = sectionKeys.inFlight;
      const completedKey = sectionKeys.completed;
      let shouldFinalizeProgress = false;
      let fileStartedAt = null;

      progressState[inFlightKey] += 1;
      this._emitProgressUpdate(onProgress, progressState, 'analysis', {
        section,
        currentFile: filePath,
        sectionCurrent: index + 1,
        sectionTotal: filePaths.length
      });

      try {
        // Crash hardening: give the OS a chance to reclaim memory before
        // starting another heavy inference when we're in near-OOM territory.
        const hasMemoryHeadroom = await waitForMemoryHeadroom();
        if (!hasMemoryHeadroom) {
          shouldFinalizeProgress = true;
          return null;
        }
        const canProceed = await checkBackpressure();
        if (!canProceed || (typeof isCancelled === 'function' && isCancelled())) {
          // Count this file as completed even though it was skipped, otherwise
          // the progress percentage stalls below 100% on cancellation. The
          // finally block decrements inFlight unconditionally; we set the
          // finalize flag here so it ALSO bumps completedKey for skipped files.
          shouldFinalizeProgress = true;
          return null;
        }
        shouldFinalizeProgress = true;
        fileStartedAt = performance.now();
        const result = await analyzer(filePath, smartFolders, {
          isCancelled,
          // Default analyzers (analyzeDocumentFile/analyzeImageFile) read
          // `abortSignal`; custom IPC analyzers may close over their own.
          abortSignal
        });
        embeddingStats.embeddings += 1;

        const normalized = {
          filePath,
          success: true,
          result,
          type: sectionKeys.type,
          durationMs: performance.now() - fileStartedAt
        };

        if (typeof onFileComplete === 'function') {
          onFileComplete(normalized);
        }

        return normalized;
      } catch (error) {
        // User cancellation: treat like the skip path (null result, progress
        // finalized) instead of recording a per-file failure for every file
        // that was mid-inference when the user hit cancel.
        if (error?.code === 'OPERATION_CANCELLED') {
          logger.info('[BATCH-ANALYSIS] File analysis cancelled', { path: filePath, section });
          return null;
        }
        /** @type {Record<string, any>} */
        const normalized = {
          filePath,
          success: false,
          error: error?.message || 'Unknown error',
          result: null,
          type: sectionKeys.type,
          durationMs: fileStartedAt === null ? 0 : performance.now() - fileStartedAt
        };

        logger.error('[BATCH-ANALYSIS] File analysis failed', {
          index,
          path: filePath,
          section,
          error: normalized.error
        });

        if (typeof onFileComplete === 'function') {
          onFileComplete(normalized);
        }

        return normalized;
      } finally {
        progressState[inFlightKey] = Math.max(0, progressState[inFlightKey] - 1);
        if (shouldFinalizeProgress) {
          progressState[completedKey] = Math.min(progressState[completedKey] + 1, filePaths.length);
          progressState.completed = Math.min(progressState.completed + 1, progressState.total);
          this._emitProgressUpdate(onProgress, progressState, 'analysis', {
            section,
            currentFile: filePath,
            sectionCurrent: Math.min(progressState[completedKey], filePaths.length),
            sectionTotal: filePaths.length
          });
        }
      }
    };

    const batchResult = await this.batchProcessor.processBatch(filePaths, processFile, {
      concurrency: sectionConcurrency,
      stopOnError,
      shouldStop: () => (typeof isCancelled === 'function' ? isCancelled() : false)
    });

    const _br = /** @type {any} */ (batchResult);
    const normalizedResults = (_br.results || []).filter(
      (/** @type {any} */ result) => result !== null && result !== undefined
    );
    const failedResults = normalizedResults.filter(
      (/** @type {any} */ result) => result?.success === false
    );
    const normalizedErrors = [
      ...(_br.errors || []),
      ...failedResults.map((/** @type {any} */ result) => ({
        filePath: result.filePath,
        error: result.error
      }))
    ];
    const successful = normalizedResults.filter(
      (/** @type {any} */ result) => result?.success
    ).length;

    return {
      ..._br,
      results: normalizedResults,
      processed: normalizedResults.length,
      cancelled:
        Boolean(_br.cancelled) ||
        (typeof isCancelled === 'function' &&
          isCancelled() &&
          normalizedResults.length < filePaths.length),
      successful,
      errors: normalizedErrors
    };
  }

  _buildProgressSnapshot(/** @type {any} */ progressState, /** @type {any} */ phase) {
    const queueStats = analysisQueue.getStats();
    const percent =
      progressState.total > 0
        ? Math.round((progressState.completed / progressState.total) * 100)
        : 0;

    return {
      phase,
      completed: progressState.completed,
      total: progressState.total,
      percent,
      percentage: percent,
      docCompleted: progressState.documentsCompleted,
      imageCompleted: progressState.imagesCompleted,
      documentsTotal: progressState.documentsTotal,
      imagesTotal: progressState.imagesTotal,
      docInFlight: progressState.docInFlight,
      imageInFlight: progressState.imageInFlight,
      embeddingQueueSize: queueStats.queueLength,
      embeddingQueueCapacity: queueStats.capacityPercent
    };
  }

  _emitProgressUpdate(
    /** @type {any} */ onProgress,
    /** @type {any} */ progressState,
    /** @type {any} */ phase,
    extra = {}
  ) {
    if (!onProgress) return;
    onProgress({
      ...this._buildProgressSnapshot(progressState, phase),
      ...extra
    });
  }

  async _flushEmbeddings(/** @type {any} */ warnings = []) {
    const flushStartTime = Date.now();
    try {
      const {
        flushAllEmbeddings: flushDocumentEmbeddings
      } = require('../analysis/documentAnalysis');
      const { flushAllEmbeddings: flushImageEmbeddings } = require('../analysis/imageAnalysis');

      const results = await Promise.allSettled([flushDocumentEmbeddings(), flushImageEmbeddings()]);
      const labels = ['Document', 'Image'];
      results.forEach((result, i) => {
        if (result.status === 'rejected') {
          const msg = result.reason?.message || String(result.reason);
          logger.warn(`[BATCH-ANALYSIS] Failed to flush ${labels[i].toLowerCase()} embeddings`, {
            error: msg
          });
          warnings.push(`${labels[i]} embedding flush failed: ${msg}`);
        }
      });
    } catch (error) {
      logger.warn('[BATCH-ANALYSIS] Error flushing embedding queues', {
        error: error.message
      });
      warnings.push(`Embedding queue flush error: ${error.message}`);
    }
    return Date.now() - flushStartTime;
  }

  /** @param {any} params */
  async _finalizeBatch({
    filePaths,
    startTime,
    onProgress,
    embeddingStats,
    orderedResults,
    combinedErrors,
    successful,
    cancelled = false,
    processedCount = null,
    concurrency,
    requestedConcurrency,
    sectionStats,
    warnings = []
  }) {
    const analysisDuration = Date.now() - startTime;
    const processed = Number.isFinite(processedCount) ? processedCount : orderedResults.length;
    const completionCount = cancelled ? processed : filePaths.length;
    const completionPercent =
      filePaths.length > 0 ? Math.round((completionCount / filePaths.length) * 100) : 100;

    if (onProgress) {
      onProgress({
        phase: 'flushing_embeddings',
        completed: completionCount,
        total: filePaths.length,
        percent: completionPercent,
        percentage: completionPercent,
        message: cancelled
          ? 'Stopping analysis and flushing embeddings...'
          : 'Flushing embeddings to database...'
      });
    }

    const flushDuration = await this._flushEmbeddings(warnings);
    const totalDuration = Date.now() - startTime;
    const avgTime = processed > 0 ? totalDuration / processed : 0;
    const finalQueueStats = analysisQueue.getStats();
    const embeddingServiceStats = getParallelEmbeddingService().getStats();

    const errorDetails = orderedResults
      .filter((/** @type {any} */ result) => !result?.success || result?.error)
      .map((/** @type {any} */ result) => ({
        file: result?.filePath || result?.path || result?.name,
        error: result?.error?.message || result?.error || 'Unknown error',
        code: result?.error?.code
      }));

    if (errorDetails.length > 0) {
      logger.warn(`[BATCH-ANALYSIS] ${errorDetails.length} files failed analysis`, {
        failedCount: errorDetails.length,
        errors: errorDetails.slice(0, 10)
      });
    }

    logger.info('[BATCH-ANALYSIS] Batch analysis complete', {
      total: filePaths.length,
      processed,
      successful,
      failed: combinedErrors.length,
      cancelled,
      requestedConcurrency,
      effectiveConcurrency: concurrency,
      analysisDuration: `${analysisDuration}ms`,
      flushDuration: `${flushDuration}ms`,
      totalDuration: `${totalDuration}ms`,
      avgPerFile: `${Math.round(avgTime)}ms`,
      throughput:
        totalDuration > 0
          ? `${(processed / (totalDuration / 1000)).toFixed(2)} files/sec`
          : 'instant',
      sectionStats,
      embeddingStats: {
        queueProcessed: embeddingStats.startQueueSize - finalQueueStats.queueLength,
        remainingInQueue: finalQueueStats.queueLength,
        failedItems: finalQueueStats.failedItemsCount
      }
    });

    return {
      success: !cancelled && combinedErrors.length === 0,
      cancelled,
      results: orderedResults,
      errors: combinedErrors,
      warnings,
      total: filePaths.length,
      processed,
      successful,
      hasErrors: combinedErrors.length > 0,
      errorSummary: errorDetails,
      stats: {
        requestedConcurrency,
        effectiveConcurrency: concurrency,
        totalDuration,
        analysisDuration,
        flushDuration,
        avgPerFile: avgTime,
        filesPerSecond: totalDuration > 0 ? processed / (totalDuration / 1000) : Infinity,
        modalities: sectionStats,
        embedding: {
          queueSize: finalQueueStats.queueLength,
          failedItems: finalQueueStats.failedItemsCount,
          deadLetterItems: finalQueueStats.deadLetterCount,
          serviceStats: embeddingServiceStats
        }
      }
    };
  }

  /**
   * Run analyzeFiles once per extension-type group so same-type files are
   * processed consecutively and maximize LLM prompt/cache reuse. Groups run
   * with bounded parallelism (options.groupConcurrency, default 1 =
   * sequential); a group whose run rejects is logged and dropped rather than
   * failing the whole batch.
   *
   * @param {string[]} filePaths
   * @param {any[]} [smartFolders]
   * @param {any} [options]
   * @returns {Promise<any>}
   */
  async analyzeFilesGrouped(filePaths, smartFolders = [], options = {}) {
    // Group files by extension for better caching
    const groups = this.groupFilesByType(filePaths);
    const groupEntries = Object.entries(groups);
    const rawGroupConcurrency = Number.isFinite(options.groupConcurrency)
      ? options.groupConcurrency
      : 1;
    const groupConcurrency = Math.max(
      1,
      Math.min(Math.floor(rawGroupConcurrency), groupEntries.length || 1)
    );

    logger.info('[BATCH-ANALYSIS] Analyzing files in groups', {
      totalFiles: filePaths.length,
      groups: Object.keys(groups).length,
      groupConcurrency
    });

    /** @type {Record<string, any>} */
    const allResults = {
      results: [],
      errors: [],
      successful: 0,
      total: filePaths.length
    };

    for (let i = 0; i < groupEntries.length; i += groupConcurrency) {
      const groupSlice = groupEntries.slice(i, i + groupConcurrency);
      const groupResults = await Promise.allSettled(
        groupSlice.map(([type, files]) => {
          logger.info(`[BATCH-ANALYSIS] Processing ${type} group`, { count: files.length });
          return this.analyzeFiles(files, smartFolders, options);
        })
      );

      // Merge results from this bounded-concurrency slice
      for (const result of groupResults) {
        if (result.status === 'fulfilled') {
          allResults.results.push(...result.value.results);
          allResults.errors.push(...result.value.errors);
          allResults.successful += result.value.successful;
        } else {
          logger.error('[BATCH-ANALYSIS] Group processing failed', {
            error: result.reason?.message
          });
        }
      }
    }

    return {
      success: allResults.errors.length === 0,
      ...allResults
    };
  }

  /**
   * Bucket paths by singular file-type category (resolved from the extension)
   * to drive analyzeFilesGrouped's cache-friendly ordering. Unrecognized
   * extensions still land in a bucket, so no input path is ever dropped.
   *
   * @param {string[]} filePaths
   * @returns {Object<string, string[]>} Map of type category to file paths
   */
  groupFilesByType(filePaths) {
    /** @type {Record<string, string[]>} */
    const groups = {};

    filePaths.forEach((filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      const type = this.getFileType(ext);

      if (!groups[type]) {
        groups[type] = [];
      }
      groups[type].push(filePath);
    });

    return groups;
  }

  /**
   * Map a file extension to the singular type category used for grouping and
   * result labels. Delegates to autoOrganize/fileTypeUtils so batch analysis
   * and auto-organize agree on category names.
   *
   * @param {string} extension - Extension including the dot (e.g. '.pdf')
   * @returns {string} Singular category label (e.g. 'document', 'image')
   */
  getFileType(extension) {
    return getFileTypeSingular(extension);
  }

  /**
   * True when the extension routes to the image-analysis lane. Delegates to
   * ./analysisRouting so partitioning stays consistent with verify scripts.
   *
   * @param {string} extension - Extension including the dot
   * @returns {boolean}
   */
  isImageFile(extension) {
    return routingIsImageFile(extension);
  }

  /**
   * True when the path routes to the audio/video (Whisper) lane. Delegates to
   * ./analysisRouting so partitioning stays consistent with verify scripts.
   *
   * @param {string} filePath - Full path or filename (extension is inspected)
   * @returns {boolean}
   */
  isMediaFile(filePath) {
    return routingIsMediaFile(filePath);
  }

  /**
   * Update the default per-batch concurrency for subsequent analyzeFiles
   * calls. Non-finite input falls back to 1; values are clamped to [1, 10].
   * Applies immediately to the shared BatchProcessor but does not affect
   * batches already in flight.
   *
   * @param {number} concurrency - Requested concurrent file analyses
   */
  setConcurrency(concurrency) {
    const n = Number.isFinite(concurrency) ? concurrency : 1;
    this.concurrency = Math.max(1, Math.min(n, 10)); // Limit 1-10
    this.batchProcessor.concurrencyLimit = this.concurrency;
    logger.info('[BATCH-ANALYSIS] Concurrency updated', {
      concurrency: this.concurrency
    });
  }

  /**
   * Combined batch + embedding pipeline counters for diagnostics: current
   * concurrency, BatchProcessor totals, embedding queue depth, and
   * ParallelEmbeddingService throughput — one call shows where a slow batch
   * is spending its time.
   *
   * @returns {Record<string, any>}
   */
  getStats() {
    const queueStats = analysisQueue.getStats();
    const embeddingServiceStats = getParallelEmbeddingService().getStats();

    return {
      concurrency: this.concurrency,
      ...this.batchProcessor.getStats(),
      embedding: {
        queue: queueStats,
        service: embeddingServiceStats
      }
    };
  }

  /**
   * Live depth/capacity counters of the analysis embedding queue — the same
   * numbers the backpressure logic reads, exposed so callers can observe why
   * a batch is throttling.
   *
   * @returns {Record<string, any>} Queue statistics from analysisQueue.getStats()
   */
  getEmbeddingQueueStats() {
    return analysisQueue.getStats();
  }

  /**
   * Throughput counters from the ParallelEmbeddingService singleton, fetched
   * live so a service reset never yields stale numbers.
   *
   * @returns {Record<string, any>} Service statistics
   */
  getEmbeddingServiceStats() {
    return getParallelEmbeddingService().getStats();
  }

  /**
   * Adjust how many embeddings the ParallelEmbeddingService computes
   * concurrently, independent of file-analysis concurrency. Applies to the
   * live singleton, so it also affects a queue that is currently draining.
   *
   * @param {number} limit - New concurrency limit (1-10)
   */
  setEmbeddingConcurrency(limit) {
    getParallelEmbeddingService().setConcurrencyLimit(limit);
    logger.info('[BATCH-ANALYSIS] Embedding concurrency updated', {
      embeddingConcurrency: getParallelEmbeddingService().concurrencyLimit
    });
  }

  /**
   * Force flush the embedding queue
   * Useful for ensuring all embeddings are persisted before shutdown
   * @returns {Promise<void>}
   */
  async flushEmbeddings() {
    logger.info('[BATCH-ANALYSIS] Force flushing embedding queue');
    await embeddingQueueManager.forceFlush();
  }

  /**
   * Graceful shutdown - flush embeddings and cleanup
   * @returns {Promise<void>}
   */
  async shutdown() {
    logger.info('[BATCH-ANALYSIS] Shutting down...');

    // Unsubscribe from progress events
    if (this._embeddingProgressUnsubscribe) {
      this._embeddingProgressUnsubscribe();
      this._embeddingProgressUnsubscribe = null;
    }

    // Flush embeddings
    await embeddingQueueManager.shutdown();

    logger.info('[BATCH-ANALYSIS] Shutdown complete');
  }
}

module.exports = BatchAnalysisService;
