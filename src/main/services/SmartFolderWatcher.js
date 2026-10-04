// @ts-check
/**
 * SmartFolderWatcher Service
 *
 * Watches smart folders for new and modified files, automatically
 * analyzing them and updating embeddings when changes are detected.
 *
 * Features:
 * - Watches all configured smart folders
 * - Auto-analyzes new files added to smart folders
 * - Re-analyzes files when modified (based on mtime)
 *   - Content updates (file edited & saved) only refresh details
 *     (summary, keywords, embeddings) — naming and folder/category
 *     assignment are preserved
 * - Debouncing to wait for file saves to complete
 * - Startup reconciliation: detects files deleted while the watcher
 *   was stopped and cleans up orphaned embeddings/history
 * - Opt-in via settings
 *
 * @module services/SmartFolderWatcher
 */

const fs = require('fs').promises;
const path = require('path');
const chokidar = require('chokidar');
const { logger: baseLogger, createLogger } = require('../../shared/logger');
const { ANALYSIS_SUPPORTED_EXTENSIONS } = require('../../shared/constants');
const { isNotFoundError } = require('../../shared/errorClassifier');
const { findContainingSmartFolder } = require('../../shared/folderUtils');
const { WatcherError } = require('../errors/FileSystemError');
const { generateSuggestedNameFromAnalysis } = require('./autoOrganize/namingUtils');
const { generateFileHash } = require('./analysisHistory/indexManager');
const {
  isFallbackAnalysis,
  isCapabilityFallback,
  PROVISIONAL_MAX_RETRIES
} = require('../../shared/analysisProvenance');
const { findInstalledModelMatch } = require('../../shared/modelNameMatch');
// Orphan-marked vectors (F-187) are reaped by the startup reconcile only after
// staying missing this long (F-222 / D5 "sustained period").
const ORPHAN_REAP_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const { deriveWatcherConfidencePercent } = require('./confidence/watcherConfidence');
const { normalizeThresholdPercent } = require('../../shared/confidencePercent');
const { recordAnalysisResult } = require('../ipc/analysisUtils');
const { embedFileChunks } = require('../analysis/chunkEmbedding');
const { buildEmbeddingSummary } = require('../analysis/embeddingSummary');
const {
  TIMEOUTS,
  TEMP_FILE_PATTERNS,
  isTemporaryFile,
  RETRY,
  LIMITS
} = require('../../shared/performanceConstants');
const { findUserExclusion } = require('./watcherExclusions');
const { getInstance: getFileOperationTracker } = require('../../shared/fileOperationTracker');
const { normalizePathForIndex, getCanonicalFileId } = require('../../shared/pathSanitization');
const { isImagePath, isMediaPath } = require('../../shared/fileIdUtils');
const { isUNCPath } = require('../../shared/crossPlatformUtils');
const { normalizeKeywords } = require('../../shared/normalization');
const {
  getInstance: getLearningFeedbackService,
  FEEDBACK_SOURCES
} = require('./organization/learningFeedback');
const { withTimeout, delay, createBackgroundWorkTracker } = require('../../shared/promiseUtils');
const { shouldEmbed } = require('./embedding/embeddingGate');
const { resetLlamaCircuit } = require('./LlamaResilience');
const { clearSmartFolderUpsertCache } = require('../analysis/semanticFolderMatcher');
const { resolveEmbeddingModelOptions } = require('../analysis/embeddingModelOptions');
const { findSmartFolderForExtension } = require('../../shared/categoryFolderMatching');
const { CONCURRENCY } = require('../../shared/performanceConstants');

const logger = typeof createLogger === 'function' ? createLogger('SmartFolderWatcher') : baseLogger;
if (typeof createLogger !== 'function' && logger?.setContext) {
  logger.setContext('SmartFolderWatcher');
}

// Limit how many times a file is retried after transient failures (timeouts, embed errors)
const MAX_ANALYSIS_RETRIES = RETRY.MAX_ATTEMPTS_MEDIUM;

// CRITICAL: Prevent unbounded memory growth under heavy file activity (e.g., large archive extraction).
// We bound the analysis queue and apply light deduplication by filePath.
const MAX_ANALYSIS_QUEUE_SIZE = LIMITS.ANALYSIS_QUEUE_SIZE ?? 1000;
const QUEUE_DROP_LOG_INTERVAL_MS = 10_000;
// K-07: coalesce queue writes. Enqueue/dequeue can fire many times a second
// during a burst; one write per second is plenty to survive a crash. A big
// backlog makes each write expensive (serialize + fsync tens of thousands of
// entries), so back the debounce off once the queue is large — losing 10s of
// progress on a multi-hour reanalysis is a far better trade than writing a
// megabyte-scale file every second.
const QUEUE_PERSIST_DEBOUNCE_MS = 1000;
const QUEUE_PERSIST_DEBOUNCE_LARGE_MS = 10_000;
const QUEUE_PERSIST_LARGE_THRESHOLD = 2000;
const MOVE_DETECTION_WINDOW_MS = 3000;
const MOVE_MTIME_TOLERANCE_MS = 2000;

// File extensions that have dedicated parsers/AI analysis paths.
const SUPPORTED_EXTENSIONS = new Set(ANALYSIS_SUPPORTED_EXTENSIONS || []);

/**
 * Check if file extension is supported for analysis
 * @param {string} filePath - Path to check
 * @returns {boolean} True if supported
 */
function isSupportedFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

function createUnsupportedFileFallback(
  /** @type {any} */ filePath,
  /** @type {any} */ smartFolders
) {
  const fileName = path.basename(filePath);
  const fileExtension = path.extname(filePath).toLowerCase();
  const folderMatch = findContainingSmartFolder(filePath, smartFolders);
  const extensionFolder = findSmartFolderForExtension(fileExtension, smartFolders);
  const category = extensionFolder?.name || folderMatch?.name || 'Uncategorized';
  const extKeyword = fileExtension.replace(/^\./, '');

  return /** @type {Record<string, any>} */ ({
    purpose: 'Document (fallback - unsupported file type - metadata fallback)',
    project: path.basename(fileName, fileExtension),
    category,
    date: null,
    keywords: extKeyword ? [extKeyword, 'metadata', 'fallback'] : ['metadata', 'fallback'],
    confidence: 35,
    suggestedName: fileName,
    extractionMethod: 'unsupported_fallback',
    fallbackReason: 'unsupported file type - metadata fallback',
    summary: `${fileName} - ${category}. ${extKeyword || 'unknown'} file preserved via metadata fallback.`,
    isFallback: true,
    _isFallback: true
  });
}

const WATCHER_DEGRADED_CODE = 'smart-folder-watcher.unavailable';

function _maybeRaiseWatcherUnavailable(/** @type {any} */ error) {
  try {
    const tracker = require('./DegradedStateTracker').getInstance();
    tracker.raise({
      code: WATCHER_DEGRADED_CODE,
      subsystem: 'smart-folder-watcher',
      severity: 'error',
      message:
        'Smart folder watching has been disabled after repeated failures. Files added to ' +
        'smart folders will not be auto-analyzed until you restart the app or fix the ' +
        'underlying error (typically OS-level inotify exhaustion or USN journal slot).',
      detail: {
        errorMessage: String(error?.message || error || '').slice(0, 200),
        errorCode: error?.code
      }
    });
  } catch {
    /* tracker is best-effort; never throw from a watcher error path */
  }
}

function _clearWatcherUnavailable() {
  try {
    require('./DegradedStateTracker').getInstance().clear(WATCHER_DEGRADED_CODE);
  } catch {
    /* never throw from a watcher recovery path */
  }
}

class SmartFolderWatcher {
  /**
   * @param {any} deps
   */
  constructor({
    getSmartFolders,
    analysisHistoryService,
    analyzeDocumentFile,
    analyzeImageFile,
    analyzeMediaFile,
    settingsService,
    vectorDbService,
    filePathCoordinator,
    folderMatcher,
    notificationService,
    queueStore
  }) {
    if (!analysisHistoryService) {
      throw new Error('SmartFolderWatcher requires analysisHistoryService');
    }
    if (!settingsService) {
      throw new Error('SmartFolderWatcher requires settingsService');
    }
    this.getSmartFolders = getSmartFolders;
    /** @type {{ at: number, text: boolean, vision: boolean, whisper: boolean } | null} */
    this._capabilityProbeCache = null;
    this.analysisHistoryService = analysisHistoryService;
    this.analyzeDocumentFile = analyzeDocumentFile;
    this.analyzeImageFile = analyzeImageFile;
    this.analyzeMediaFile = analyzeMediaFile;
    this.settingsService = settingsService;
    this.vectorDbService = vectorDbService;
    this.filePathCoordinator = filePathCoordinator || null;
    this.folderMatcher = folderMatcher;
    this.notificationService = notificationService;

    this.watcher = null;
    this.isRunning = false;
    this.isStarting = false;
    this.watchedPaths = new Set();

    this._startPromise = null;

    this._isStopping = false;
    // Terminal flag: stop() deliberately resets _isStopping so error-driven
    // restarts work mid-session, but after shutdown() the restart path must
    // stay dead or a queued restart/late chokidar error re-creates the
    // watcher past app shutdown. Reset only by an explicit start().
    this._shutdownRequested = false;

    // Restart machinery for chokidar 'error' recovery. Without this the
    // previous behavior was: log + bump errors counter, isRunning stays
    // true, OS-level inotify/USN journal slot dies, watcher silently goes
    // deaf to file events. Mirrors DownloadWatcher's pattern.
    this.lastError = null;
    this.restartAttempts = 0;
    this.maxRestartAttempts = 5;
    this.restartDelay = 2000; // exponential backoff: 2s, 4s, 6s, ...
    this.restartTimer = null;

    // Processing state
    this.processingFiles = new Set();
    this.pendingAnalysis = new Map(); // filePath -> { mtime, timeout }
    /** @type {any[]} */
    this.analysisQueue = [];
    this.isProcessingQueue = false;
    this._pendingMoveCandidates = new Map();
    /** @type {any[]} */
    this._pendingReanalyzeItems = [];

    // K-07: optional file-backed queue store. Without it the queue is
    // in-memory only and every queued item is lost on shutdown — and because
    // chokidar runs with `ignoreInitial: true`, nothing ever rediscovers
    // those files. Null in tests / CLI tools (no Electron userData path).
    /** @type {{ load: () => Promise<any[]>, save: (items: any[]) => Promise<void> } | null} */
    this.queueStore = queueStore || null;
    /** @type {any} */
    this._queuePersistTimer = null;
    /** @type {Promise<void> | null} */
    this._queuePersistPromise = null;
    // Items spliced out of analysisQueue and handed to _analyzeFile. They are
    // in no queue for up to the 10-minute analysis timeout, so without this
    // they'd be absent from the durable record for that whole window.
    /** @type {Map<string, any>} */
    this._inFlightItems = new Map();
    // Restored items whose smart folder is configured but not currently
    // watched (unmounted USB, SMB share before the VPN). Deliberately its OWN
    // list, not part of _pendingReanalyzeItems: forceReanalyzeAll resets the
    // overflow buffer wholesale, which would wipe parked work and — via the
    // next flush — erase it from disk.
    /** @type {any[]} */
    this._parkedItems = [];

    // Configuration
    this.debounceDelay = 1000; // 1 second debounce
    // Maximum time to keep deferring analysis for a hot file (prevents indefinite postponement)
    this.maxDebounceWaitMs = 5000;
    this.stabilityThreshold = 3000; // 3 seconds - file must be stable for this long
    this.queueProcessInterval = 2000; // Process queue every 2 seconds
    this.maxConcurrentAnalysis = 2; // Max files to analyze at once (synced from settings)
    // Watch subdirectories up to 10 levels deep by default — same depth the
    // manual scanner uses, so live `add`/`change` events and manual rescans
    // see the same files. Earlier post-2.0.9 builds shipped a default of 5
    // here while `_scanDirectory` still walked depth 10, which silently
    // dropped files in 6–10-level trees from auto-ingest. Power users can
    // override via the STRATOSORT_WATCHER_DEPTH env var without patching.
    const envDepth = parseInt(process.env.STRATOSORT_WATCHER_DEPTH, 10);
    this.watcherDepth =
      Number.isFinite(envDepth) && envDepth >= 0 && envDepth <= 32 ? envDepth : 10;
    this._moveDetectionWindowMs = MOVE_DETECTION_WINDOW_MS;
    this._moveMtimeToleranceMs = MOVE_MTIME_TOLERANCE_MS;

    // Sync concurrency from settings (non-blocking)
    this._syncConcurrencyFromSettingsService().catch(() => {
      // Errors logged inside _syncConcurrencyFromSettingsService
    });

    // Timers
    this.queueTimer = null;

    // Queue backpressure state (for bounded queue + rate-limited logging)
    this._lastQueueDropLogAt = 0;
    this._queueDropsSinceLog = 0;

    // Stats
    this.stats = {
      filesAnalyzed: 0,
      filesReanalyzed: 0,
      errors: 0,
      queueDropped: 0,
      orphansReconciled: 0,
      lastActivity: null
    };

    // Track fire-and-forget promises
    /** @type {any} */
    this._bgWork = createBackgroundWorkTracker('SmartFolderWatcher');
  }

  /**
   * Apply settings updates (called when renderer saves settings)
   * @param {any} settings
   */
  applySettings(settings) {
    if (!settings || typeof settings !== 'object') return;
    // Resolve the background-analysis concurrency against the hardware-aware
    // auto/manual choice. Auto (default) defers to the live hardware probe;
    // manual honors the user's explicit value. Done off the hot path because
    // the hardware probe is async.
    if (settings.autoConcurrency !== undefined || settings.maxConcurrentAnalysis !== undefined) {
      this._bgWork.track(
        this._resolveAndApplyConcurrency(
          settings.autoConcurrency !== false,
          settings.maxConcurrentAnalysis,
          'applySettings'
        )
      );
    }

    // Honor live toggling of `smartFolderWatchEnabled`. Without this the toggle
    // was only read once at startup (in _doStart), so flipping it while the app
    // ran was a no-op until the next launch. Explicit `false` stops a running
    // watcher; any other value (including missing) re-enables it, matching the
    // historical always-on default and the fail-open logic in _readWatchEnabled.
    //
    // We deliberately do NOT route this through `_bgWork`: stop() itself drains
    // `_bgWork`, so tracking the stop promise there would be self-referential.
    // The latest toggle promise is exposed on `_watchToggleWork` for tests and
    // graceful shutdown to await.
    const wantsDisabled = settings.smartFolderWatchEnabled === false;
    const shouldStop = wantsDisabled && (this.isRunning || this.isStarting);
    const shouldStart = !wantsDisabled && !this.isRunning && !this.isStarting;
    if (shouldStop || shouldStart) {
      const toggle = shouldStop ? this.stop() : this.start();
      this._watchToggleWork = Promise.resolve(toggle).catch((error) => {
        logger.debug(
          '[SMART-FOLDER-WATCHER] applySettings toggle failed:',
          error?.message || String(error)
        );
      });
    }
  }

  /**
   * Sync maxConcurrentAnalysis from SettingsService (best effort, non-blocking)
   * @private
   */
  async _syncConcurrencyFromSettingsService() {
    try {
      if (!this.settingsService?.load) return;
      const loaded = await this.settingsService.load();
      await this._resolveAndApplyConcurrency(
        loaded?.autoConcurrency !== false,
        loaded?.maxConcurrentAnalysis,
        'settingsService'
      );
    } catch (error) {
      logger.debug(
        '[SMART-FOLDER-WATCHER] Failed to sync concurrency from settings:',
        error?.message
      );
    }
  }

  /**
   * Resolve the effective background-analysis concurrency from the hardware-aware
   * auto/manual choice and apply it to `this.maxConcurrentAnalysis`.
   * @param {boolean} autoConcurrency
   * @param {number|undefined} manualValue
   * @param {string} source
   * @private
   */
  async _resolveAndApplyConcurrency(autoConcurrency, manualValue, source) {
    const clamp = (/** @type {any} */ v) =>
      Math.min(CONCURRENCY.MAX_WORKERS, Math.max(CONCURRENCY.MIN_WORKERS, v));
    const manualNum = Math.round(Number(manualValue));
    const hasManual = Number.isFinite(manualNum) && manualNum >= CONCURRENCY.MIN_WORKERS;

    // Manual mode with a valid value: honor it directly. No hardware probe
    // needed — the user has explicitly opted out of the hardware cap.
    if (autoConcurrency === false && hasManual) {
      this.maxConcurrentAnalysis = clamp(manualNum);
      return;
    }

    try {
      const {
        getRecommendedConcurrency,
        resolveEffectiveConcurrency
      } = require('./PerformanceService');
      const rec = await getRecommendedConcurrency();
      this.maxConcurrentAnalysis = clamp(
        resolveEffectiveConcurrency({
          autoConcurrency,
          manualValue,
          recommendedMax: rec?.maxConcurrent
        })
      );
    } catch (error) {
      // Hardware probe unavailable: fall back to clamping the manual value so
      // the watcher still respects an explicit setting even without the cap.
      if (hasManual) {
        this.maxConcurrentAnalysis = clamp(manualNum);
      }
      logger.debug('[SMART-FOLDER-WATCHER] Failed to resolve hardware-aware concurrency:', {
        error: error?.message,
        source
      });
    }
  }

  /**
   * Read the user-facing `smartFolderWatchEnabled` setting. Defaults to `true`
   * so that existing installs without an explicit value preserve the old
   * "always-on" behavior. Returns `true` if the SettingsService is unavailable
   * for the same reason — the watcher should fail open, not silently disable
   * itself when settings can't be loaded.
   * @private
   */
  async _readWatchEnabled() {
    try {
      if (!this.settingsService?.load) return true;
      const loaded = await this.settingsService.load();
      // Explicit `false` disables; any other value (including missing) is on.
      if (loaded && loaded.smartFolderWatchEnabled === false) return false;
      return true;
    } catch (error) {
      logger.debug('[SMART-FOLDER-WATCHER] Failed to read watch-enabled flag:', error?.message);
      return true;
    }
  }

  /**
   * Start watching smart folders.
   *
   * The user can disable smart-folder watching via the
   * `smartFolderWatchEnabled` setting. When disabled, start() returns false
   * with a clear `_lastStartError` instead of attaching chokidar listeners.
   * The setting was added in 3.0 but never wired — this method now honors it.
   *
   * @returns {Promise<boolean>} True if started successfully
   */
  async start() {
    if (this.isRunning) {
      logger.debug('[SMART-FOLDER-WATCHER] Already running');
      return true;
    }
    this._isStopping = false;
    // Explicit start() is intentional operator/service re-init — lift the
    // terminal shutdown latch.
    this._shutdownRequested = false;

    // This prevents race condition where concurrent callers get false
    if (this._startPromise) {
      logger.debug('[SMART-FOLDER-WATCHER] Returning existing start promise');
      return this._startPromise;
    }

    this.isStarting = true;
    this._startPromise = this._doStart();

    try {
      return await this._startPromise;
    } finally {
      this._startPromise = null;
      this.isStarting = false;
    }
  }

  /**
   * Internal start implementation
   * @private
   * @returns {Promise<boolean>} True if started successfully
   */
  async _doStart() {
    try {
      // Honor the user-facing `smartFolderWatchEnabled` setting. Without
      // this guard, the toggle was a dead control: the value was persisted
      // and validated but no code consumed it, leaving disabled-state users
      // with the watcher still running.
      const watchEnabled = await this._readWatchEnabled();
      if (!watchEnabled) {
        const errorMsg = 'Smart folder watching is disabled in Settings.';
        logger.info('[SMART-FOLDER-WATCHER]', errorMsg);
        this._lastStartError = errorMsg;
        return false;
      }

      // Get smart folders to watch
      const folders = this.getSmartFolders();

      if (!folders || folders.length === 0) {
        const errorMsg =
          'No smart folders configured. Please add smart folders in the Setup phase first.';
        logger.warn('[SMART-FOLDER-WATCHER] Start failed:', errorMsg);
        this._lastStartError = errorMsg;
        return false;
      }

      const validPaths = await this._getValidFolderPaths(folders);

      if (validPaths.length === 0) {
        const errorMsg = `All ${folders.length} smart folder path(s) are inaccessible. Please check that the folders exist and you have read permissions.`;
        logger.warn('[SMART-FOLDER-WATCHER] Start failed:', errorMsg);
        this._lastStartError = errorMsg;
        return false;
      }

      // Prevent race condition: if stop() was called during async operations, abort
      if (this._isStopping) {
        logger.debug('[SMART-FOLDER-WATCHER] Watcher stopped during startup, aborting');
        return false;
      }

      // Clear any previous error
      this._lastStartError = null;

      logger.info('[SMART-FOLDER-WATCHER] Starting to watch folders:', validPaths);

      // Chokidar's inotify / ReadDirectoryChangesW backends drop events on
      // network filesystems (UNC shares, mapped drives backed by SMB/DFS,
      // and Windows "offline files" redirection). Detect those paths up
      // front so we flip to polling mode for the whole watcher — mixing
      // polling and native events on a single watcher instance produces
      // duplicate/out-of-order events.
      // Mapped-drive detection is now async (with a 500ms timeout per probe)
      // so a hung SMB share doesn't block startup for the OS SMB timeout.
      // Run probes in parallel; if any returns true OR any is a UNC path, we
      // enable polling mode for the whole watcher.
      let usePolling = validPaths.some((p) => isUNCPath(p));
      if (!usePolling) {
        const mappedDriveResults = await Promise.all(
          validPaths.map((p) => this._looksLikeMappedDrive(p))
        );
        usePolling = mappedDriveResults.some(Boolean);
      }
      if (usePolling) {
        logger.info(
          '[SMART-FOLDER-WATCHER] Network / mapped drives detected, enabling polling mode'
        );
      }

      // Log the chosen depth so users debugging "my deeply-nested file
      // wasn't picked up" can correlate without reading source. Default
      // dropped from 10 → 5 in this release window; users with deeper
      // trees can override via the STRATOSORT_WATCHER_DEPTH env var.
      logger.info('[SMART-FOLDER-WATCHER] Watcher configuration', {
        depth: this.watcherDepth,
        polling: usePolling
      });

      // Create watcher with stability detection.
      //
      // `alwaysStat: false` deliberately defers the `fs.stat` syscall: chokidar
      // would otherwise stat every path before we even check for recently-
      // operated files, temp files, or a saturated analysis queue — the three
      // early-exit filters inside `_handleFileEvent`. Downstream helpers
      // (`_attemptMoveResolution`, `_needsAnalysis`) still stat on demand the
      // first time they actually need size/mtime, so the total stat count
      // does not increase for files we keep, and drops to zero for files we
      // reject up front.
      //
      // `depth: 5` covers every real-world personal-document tree we've seen
      // in user data (Downloads, Documents, Desktop trees top out at 3-4
      // nested folders). The old `depth: 10` was speculative and multiplied
      // watch-handle cost on large folders without benefit. Users with
      // deeper trees can adjust via the `watcherDepth` setting below.
      this.watcher = chokidar.watch(validPaths, {
        ignoreInitial: true, // Don't process existing files on startup
        // The dotfile pattern already covers `.git/` directories; an
        // unanchored /\.git/ also swallowed `report.github-export.csv`.
        ignored: [
          /(^|[/\\])\../, // Dotfiles
          /node_modules/,
          ...TEMP_FILE_PATTERNS
        ],
        persistent: true,
        usePolling: usePolling,
        interval: usePolling ? 2000 : 100, // Slower polling for network drives
        binaryInterval: usePolling ? 2000 : 300,
        awaitWriteFinish: {
          stabilityThreshold: this.stabilityThreshold,
          pollInterval: 200
        },
        depth: this.watcherDepth,
        alwaysStat: false,
        // Containment: chokidar follows symlinks by default, which would emit
        // events for paths OUTSIDE the smart-folder root via a planted link
        // and feed them into auto-analysis. Matches _scanDirectory and
        // folderScanner.js, which both skip symlinks.
        followSymlinks: false
      });

      // Handle new files
      this.watcher.on('add', (filePath, stats) => {
        this._handleFileEvent('add', filePath, stats);
      });

      // Handle modified files
      this.watcher.on('change', (filePath, stats) => {
        this._handleFileEvent('change', filePath, stats);
      });

      // Handle deleted files (external deletion via File Explorer)
      this.watcher.on('unlink', (filePath) => {
        this._handleFileDeletion(filePath);
      });

      // Handle errors
      this.watcher.on('error', (error) => {
        this._handleError(error);
      });

      // Wait for chokidar to finish its initial scan before returning.
      // This ensures isRunning is true and the watcher is fully operational
      // before callers act on the start() result.
      // from calling reject() on an already-resolved promise (listener leak)
      const readyOutcome = await new Promise((resolve, reject) => {
        /** @type {any} */
        let checkInterval;

        const readyHandler = () => {
          if (checkInterval) clearInterval(checkInterval);
          if (this.watcher) this.watcher.removeListener('error', errorHandler);
          logger.info(
            '[SMART-FOLDER-WATCHER] Watcher ready, monitoring',
            validPaths.length,
            'folders'
          );
          this.watchedPaths = new Set(validPaths);
          this.isRunning = true;
          // Successful start clears the restart counter so transient
          // failures don't permanently use up the budget.
          this.restartAttempts = 0;
          // Watcher is healthy again; drop any prior degraded banner so the
          // UI reflects recovery. raise()/clear() are idempotent so calling
          // clear when no banner is up is harmless.
          _clearWatcherUnavailable();
          // Note: isStarting is cleared in start() finally block
          resolve({ stopped: false });
        };
        const errorHandler = (/** @type {any} */ err) => {
          if (checkInterval) clearInterval(checkInterval);
          if (this.watcher) this.watcher.removeListener('ready', readyHandler);
          reject(err);
        };

        this.watcher.once('ready', readyHandler);
        this.watcher.once('error', errorHandler);

        // Prevent hanging if stop() is called while waiting for ready
        checkInterval = setInterval(() => {
          if (this._isStopping || !this.watcher) {
            clearInterval(checkInterval);
            if (this.watcher) {
              this.watcher.removeListener('ready', readyHandler);
              this.watcher.removeListener('error', errorHandler);
            }
            // Signal to the caller that we never reached the READY
            // state so the queue processor can be skipped. Without this
            // flag, the caller would fall through and `_startQueueProcessor()`
            // which set a queueTimer that stop() had ALREADY cleared,
            // leaving a live interval with isRunning===false.
            resolve({ stopped: true });
          }
        }, 100);
      });

      if (readyOutcome?.stopped) {
        // stop() was called mid-start. Close the partially-initialized
        // chokidar watcher if it exists; returning early here prevents
        // a phantom queue interval from outliving the stop() call and
        // churning forever on an unresolvable pending set.
        if (this.watcher) {
          try {
            await this.watcher.close();
          } catch (closeErr) {
            logger.debug(
              '[SMART-FOLDER-WATCHER] Partial watcher close failed during start/stop race:',
              {
                error: closeErr?.message
              }
            );
          }
          this.watcher = null;
        }
        this.isRunning = false;
        logger.info(
          '[SMART-FOLDER-WATCHER] start() aborted because stop() was called before ready'
        );
        return false;
      }

      // Start queue processor
      this._startQueueProcessor();

      // K-07: re-enqueue anything a previous session left queued. Must run
      // after isRunning/_startQueueProcessor so the restored items actually
      // drain; chokidar's `ignoreInitial: true` means nothing else would
      // ever rediscover them.
      await this._restoreQueue();

      // Run startup reconciliation in background — removes orphaned
      // embeddings/history for files deleted while the watcher was stopped —
      // then the delta scan: chokidar runs with `ignoreInitial`, so files
      // added or changed while the app was closed were never seen, and the
      // reconcile only ever removed (F-193 / K-04). `_needsAnalysis` skips
      // everything already indexed, so the steady-state cost is one stat and
      // one history lookup per file.
      this._bgWork.track(
        this._reconcileOrphanedEntries()
          .catch((err) => {
            logger.debug('[SMART-FOLDER-WATCHER] Startup reconciliation failed:', err.message);
          })
          .then(() => {
            if (this._isStopping || !this.isRunning) return null;
            return this.scanForUnanalyzedFiles();
          })
          .catch((err) => {
            logger.warn('[SMART-FOLDER-WATCHER] Startup delta scan failed:', {
              error: /** @type {any} */ (err)?.message
            });
          })
      );

      return true;
    } catch (error) {
      logger.error('[SMART-FOLDER-WATCHER] Failed to start:', error.message);
      // Note: isStarting is cleared in start() finally block
      this.stats.errors++;
      return false;
    }
  }

  /**
   * Stop watching
   * FIX MED-6: Clean up pending move detection timeouts to prevent callbacks after stop
   */
  async stop() {
    logger.info('[SMART-FOLDER-WATCHER] Stopping...');
    this._isStopping = true;

    // K-07: flush before anything clears the queue below, so a shutdown
    // mid-reanalysis leaves the remaining work on disk for the next start.
    // In-flight items are in the snapshot too (_inFlightItems), so running
    // ahead of the 30s in-flight wait below costs us nothing. Bounded: a hung
    // disk must not hold up app shutdown.
    try {
      await withTimeout(this._flushQueuePersist(), 5000, 'watcher queue flush');
    } catch (flushErr) {
      logger.warn('[SMART-FOLDER-WATCHER] Queue flush did not complete during stop', {
        error: /** @type {any} */ (flushErr)?.message
      });
    }

    // Cancel any pending restart so a stop()→start() cycle isn't surprised
    // by an old restart firing after the new start has bound its watcher.
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    // Drain tracked background work (startup reconciliation, etc.)
    await this._bgWork.drain();

    // Stop queue processor
    if (this.queueTimer) {
      clearInterval(this.queueTimer);
      this.queueTimer = null;
    }

    // Wait for in-flight queue processing to finish (up to 30s)
    if (this.isProcessingQueue) {
      logger.debug('[SMART-FOLDER-WATCHER] Waiting for in-flight queue processing to finish...');
      const deadline = Date.now() + 30000;
      while (this.isProcessingQueue && Date.now() < deadline) {
        await delay(200);
      }
      if (this.isProcessingQueue) {
        logger.warn('[SMART-FOLDER-WATCHER] Timed out waiting for queue processing during stop');
      }
    }

    // Clear pending analysis timeouts
    for (const pending of this.pendingAnalysis.values()) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
    }
    this.pendingAnalysis.clear();

    // callbacks firing after watcher is stopped
    for (const candidate of this._pendingMoveCandidates.values()) {
      if (candidate.timeoutId) {
        clearTimeout(candidate.timeoutId);
      }
    }
    this._pendingMoveCandidates.clear();

    // Stop watcher
    if (this.watcher) {
      try {
        this.watcher.removeAllListeners();
        const closeResult = this.watcher.close();
        if (closeResult && typeof closeResult.then === 'function') {
          await closeResult;
        }
      } catch (error) {
        logger.error('[SMART-FOLDER-WATCHER] Error closing watcher:', error.message);
      }
      this.watcher = null;
    }

    this.isRunning = false;
    this.isStarting = false;
    this.watchedPaths.clear();
    this.processingFiles.clear();
    this.analysisQueue = [];
    // K-07: the overflow buffer must be cleared alongside the main queue.
    // _restoreQueue pushes onto it, so leaving it populated made every
    // stop→start cycle (chokidar error restart, settings restart) duplicate
    // the whole backlog in memory and — via the next flush — on disk.
    this._pendingReanalyzeItems = [];
    this._inFlightItems.clear();
    this._parkedItems = [];
    this._lastQueueDropLogAt = 0;
    this._queueDropsSinceLog = 0;
    this._lastDropNotification = null;
    // Clear the stopping flag so a subsequent restart() (from _handleError)
    // or a new manual start() isn't blocked by a stale guard.
    this._isStopping = false;

    logger.info('[SMART-FOLDER-WATCHER] Stopped');
  }

  /**
   * Heuristic: detect Windows drive letters that resolve to a network
   * share (SMB/DFS "mapped drives") so we can force polling mode.
   * Native Windows change notifications silently drop events on these
   * drives. We probe with `fs.realpathSync` because mapped drives
   * typically resolve to a `\\server\share\...` path, whereas local
   * drives return another drive-letter path.
   *
   * Kept intentionally conservative: on non-Windows, on non-drive-letter
   * inputs, and on any error, we return false so the caller stays on
   * native backend. The probe is synchronous but runs at most once per
   * `start()`.
   *
   * @private
   * @param {string} candidatePath
   * @returns {Promise<boolean>}
   */
  async _looksLikeMappedDrive(candidatePath) {
    if (process.platform !== 'win32') return false;
    if (typeof candidatePath !== 'string' || candidatePath.length < 2) return false;
    if (isUNCPath(candidatePath)) return false;
    if (!/^[A-Za-z]:[\\/]/.test(candidatePath)) return false;

    // System drive is always local; short-circuit to avoid the realpath
    // probe on the vast majority of personal paths.
    const systemDrive = (process.env.SystemDrive || 'C:').toUpperCase();
    if (candidatePath.slice(0, 2).toUpperCase() === systemDrive) return false;

    // Async probe with a hard 500ms timeout. The whole point of detecting
    // mapped drives is that they're likely SMB-backed and may be unresponsive.
    // Synchronous realpath could block the main process for 30-60s on a hung
    // share (the OS SMB timeout). Falling back to false (keep native backend)
    // is acceptable: chokidar's polling mode is an optimization, not a
    // correctness requirement, and a hung share will produce zero events
    // either way until reconnected.
    const PROBE_TIMEOUT_MS = 500;
    try {
      const realpath = /** @type {any} */ (fs.realpath).native || fs.realpath;
      const resolved = await Promise.race([
        realpath(candidatePath),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('realpath probe timeout')), PROBE_TIMEOUT_MS)
        )
      ]);
      return typeof resolved === 'string' && isUNCPath(resolved);
    } catch {
      return false;
    }
  }

  /**
   * Restart the watcher (e.g., when smart folders change)
   */
  async restart() {
    logger.info('[SMART-FOLDER-WATCHER] Restarting...');
    await this.stop();
    return this.start();
  }

  /**
   * Update watched folders (called when smart folders are added/removed)
   * @param {any[]} folders - New list of smart folders
   */
  async updateWatchedFolders(folders) {
    if (!this.isRunning || !this.watcher || this._isStopping) {
      return;
    }

    const validPaths = await this._getValidFolderPaths(folders);

    // Compare against the currently watched set using the same
    // canonicalization we use for indexing (lowercase drive letter on
    // Windows, separator normalization, trailing-slash stripping). Raw
    // string equality missed cases where a folder was registered once
    // as `C:/foo` and again as `c:\foo\`, causing the same directory to
    // be both added to chokidar twice and never removed on update.
    const canonicalize = (/** @type {any} */ p) => {
      if (typeof p !== 'string' || p.length === 0) return null;
      const normalized = normalizePathForIndex(p);
      return normalized || p;
    };

    const currentByCanonical = new Map();
    for (const existing of this.watchedPaths) {
      const key = canonicalize(existing);
      if (key && !currentByCanonical.has(key)) {
        currentByCanonical.set(key, existing);
      }
    }

    const desiredByCanonical = new Map();
    for (const candidate of validPaths) {
      const key = canonicalize(candidate);
      if (key && !desiredByCanonical.has(key)) {
        desiredByCanonical.set(key, candidate);
      }
    }

    // Add paths present in desired but not already watched.
    let unparked = 0;
    for (const [key, addPath] of desiredByCanonical) {
      if (currentByCanonical.has(key)) continue;
      logger.info('[SMART-FOLDER-WATCHER] Adding watch path:', addPath);
      this.watcher.add(addPath);
      this.watchedPaths.add(addPath);
      unparked += this._unparkItemsUnder(addPath);
    }
    if (unparked > 0) {
      // Drain and start work immediately: the folder that was missing is back,
      // and nothing else would wake these items until an unrelated fs event.
      logger.info('[SMART-FOLDER-WATCHER] Folder remounted; resuming parked work', { unparked });
      this._fillFromPendingReanalyze();
      this._scheduleQueuePersist();
      void this._processQueue();
    }

    // Remove paths that no longer appear in the desired set, using the
    // original string we registered with chokidar to keep its internal
    // accounting consistent.
    //
    // `validPaths` is the stat-able subset of `folders`, so a path can drop out
    // of the desired set for two very different reasons: the user removed the
    // smart folder, or the folder is simply unavailable right now. Only the
    // former should discard parked work — purging on a transient unmount is the
    // exact data loss parking exists to prevent.
    const configuredRoots = this._normalizedRoots(
      (Array.isArray(folders) ? folders : []).map((/** @type {any} */ f) => f?.path)
    );
    for (const [key, removePath] of currentByCanonical) {
      if (desiredByCanonical.has(key)) continue;
      const stillConfigured = this._isUnderRoots(removePath, configuredRoots);
      logger.info('[SMART-FOLDER-WATCHER] Removing watch path:', removePath, {
        reason: stillConfigured ? 'unavailable' : 'removed-from-config'
      });
      this.watcher.unwatch(removePath);
      this.watchedPaths.delete(removePath);
      this._purgeQueuedWorkForRemovedFolder(removePath, { purgeParked: !stillConfigured });
    }
  }

  /**
   * Move parked items that live under `folderPath` back into the overflow
   * buffer so the normal drain picks them up.
   * @private
   * @param {string} folderPath
   * @returns {number} how many items were unparked
   */
  _unparkItemsUnder(folderPath) {
    if (this._parkedItems.length === 0) return 0;
    const roots = this._normalizedRoots([folderPath]);
    if (roots.length === 0) return 0;

    /** @type {any[]} */
    const revived = [];
    /** @type {any[]} */
    const stillParked = [];
    for (const item of this._parkedItems) {
      if (this._isUnderRoots(item?.filePath, roots)) {
        revived.push(item);
      } else {
        stillParked.push(item);
      }
    }
    if (revived.length === 0) return 0;
    this._parkedItems = stillParked;
    this._pendingReanalyzeItems.push(...revived);
    return revived.length;
  }

  /**
   * Drop debounce timers, queued/overflow analysis and pending move candidates
   * for a folder that is no longer watched. Compares canonical forms so
   * `C:\Docs\` and `c:/docs` purge the same entries.
   * @param {string} removedFolderPath
   * @param {{ purgeParked?: boolean }} [options] purgeParked drops the folder's
   *   parked backlog too. Only pass it when the folder left the smart-folder
   *   CONFIG — a folder that is merely unavailable keeps its parked work.
   * @private
   */
  _purgeQueuedWorkForRemovedFolder(removedFolderPath, options = {}) {
    const normalizedFolder = normalizePathForIndex(removedFolderPath).replace(/\/+$/, '');
    if (!normalizedFolder) return;
    const prefix = `${normalizedFolder}/`;
    const matches = (/** @type {any} */ filePath) => {
      const p = normalizePathForIndex(filePath);
      return p === normalizedFolder || p.startsWith(prefix);
    };

    for (const [key, pending] of this.pendingAnalysis.entries()) {
      if (matches(pending?.filePath || key)) {
        if (pending?.timeout) clearTimeout(pending.timeout);
        this.pendingAnalysis.delete(key);
      }
    }
    const itemPath = (/** @type {any} */ item) => item?.filePath || item?.path;
    this.analysisQueue = this.analysisQueue.filter((item) => !matches(itemPath(item)));
    // Overflow items are drained back into analysisQueue later; purge them too
    // or the removed folder's files resurface after the next processing cycle.
    this._pendingReanalyzeItems = this._pendingReanalyzeItems.filter(
      (item) => !matches(itemPath(item))
    );
    if (options.purgeParked) {
      this._parkedItems = this._parkedItems.filter((item) => !matches(itemPath(item)));
    }
    for (const [oldPath, candidate] of this._pendingMoveCandidates.entries()) {
      if (matches(candidate?.oldPath || oldPath)) {
        if (candidate?.timeoutId) clearTimeout(candidate.timeoutId);
        this._pendingMoveCandidates.delete(oldPath);
      }
    }
    // K-07: both queues just shrank. Without this the persisted file keeps the
    // un-watched folder's files and the next start restores work for a folder
    // the user removed.
    this._scheduleQueuePersist();
  }

  /**
   * Get valid folder paths from smart folders
   * @private
   */
  async _getValidFolderPaths(/** @type {any} */ folders) {
    const validPaths = [];

    for (const folder of folders) {
      if (!folder || !folder.path) continue;

      try {
        const stats = await fs.stat(folder.path);
        if (stats.isDirectory()) {
          validPaths.push(folder.path);
        }
      } catch (error) {
        if (!isNotFoundError(error)) {
          logger.warn('[SMART-FOLDER-WATCHER] Cannot access folder:', {
            folderPath: folder.path,
            error: error.message
          });
        }
      }
    }

    return validPaths;
  }

  /**
   * Handle file add/change events
   * @private
   */
  /**
   * First user exclusion glob that matches the file, or null. This handler
   * is synchronous, so it reads the cached settings snapshot (`getAll`)
   * rather than awaiting `load()`. A relative folder rule (`archived/**`)
   * reads beneath the Smart Folder the file lies under, never against that
   * folder's own ancestors; a file under no configured folder (a history
   * entry outside every root) gets only the basename and absolute rules.
   * @param {string} filePath
   * @returns {string|null}
   */
  _matchUserExclusion(filePath) {
    try {
      const settings =
        typeof this.settingsService?.getAll === 'function' ? this.settingsService.getAll() : null;
      return findUserExclusion(filePath, settings, { root: this._exclusionRootFor(filePath) });
    } catch (error) {
      logger.debug('[SMART-FOLDER-WATCHER] Could not read exclusion rules:', error?.message);
      return null;
    }
  }

  /**
   * The single queue item the exclusion rules do NOT apply to: one file the
   * user hand-picked for reanalysis. That is an explicit request, so it wins
   * over a standing rule. Bulk reanalysis is not exempt — "reanalyze all"
   * means "all of what you still watch", and a rule is how the user says
   * what that leaves out.
   *
   * Every gate that consults the rules asks this one question, so the
   * exemption cannot drift between the live path (`_analyzeFile`) and the
   * restored one (`_restoreQueue`): an item the gate would let through is an
   * item restore must keep.
   * @private
   * @param {any} item
   * @returns {boolean}
   */
  _isExclusionExempt(item) {
    return item?.eventType === 'reanalyze' && !item?.bulk;
  }

  _handleFileEvent(
    /** @type {any} */ eventType,
    /** @type {any} */ filePath,
    /** @type {any} */ stats
  ) {
    const tracker = getFileOperationTracker();
    if (tracker.wasRecentlyOperated(filePath)) {
      logger.debug('[SMART-FOLDER-WATCHER] Skipping recently-operated file:', filePath);
      return;
    }

    // Skip temp files
    if (isTemporaryFile(filePath)) {
      logger.debug('[SMART-FOLDER-WATCHER] Skipping temp file:', filePath);
      return;
    }

    // User exclusion rules (Settings → Exclusion rules) apply here too.
    const excludedBy = this._matchUserExclusion(filePath);
    if (excludedBy) {
      logger.debug('[SMART-FOLDER-WATCHER] Skipping file excluded by user rule:', {
        filePath,
        pattern: excludedBy
      });
      return;
    }

    // Dedup under the same index key we use everywhere else (lowercased on
    // case-insensitive FS, NFC-normalized, forward-slashed). Chokidar on
    // Windows can emit both `C:\Users\x\a.txt` and `c:/Users/x/a.txt` for
    // the same file, and a network-mounted macOS share can emit NFD then
    // NFC. Keying the Map by the raw event path let the same file slip
    // into the queue twice and double-analyze (wasting a model slot and
    // sometimes creating duplicate vector rows). Store the original path
    // inside the entry so downstream fs.access / embed work keeps using
    // the OS-native spelling.
    const dedupKey = normalizePathForIndex(filePath) || filePath;

    if (
      !this.pendingAnalysis.has(dedupKey) &&
      this.pendingAnalysis.size >= MAX_ANALYSIS_QUEUE_SIZE
    ) {
      const nowMs = Date.now();
      if (nowMs - this._lastQueueDropLogAt >= QUEUE_DROP_LOG_INTERVAL_MS) {
        logger.warn('[SMART-FOLDER-WATCHER] Pending analysis map full, dropping event', {
          pendingSize: this.pendingAnalysis.size,
          maxSize: MAX_ANALYSIS_QUEUE_SIZE,
          droppedSinceLastLog: this._queueDropsSinceLog
        });
        this._lastQueueDropLogAt = nowMs;
        this._queueDropsSinceLog = 0;
      }
      this._queueDropsSinceLog++;
      this.stats.queueDropped++;

      // Surface the skip to the user like the analysis-queue drop path does —
      // a silent warn-log means files vanish from a storm (e.g. extracting an
      // archive into a watched folder) with no UI signal. Shares
      // _lastDropNotification with that path so the two gates can't
      // double-notify within the same minute.
      if (
        this.notificationService &&
        (!this._lastDropNotification || nowMs - this._lastDropNotification > 60000)
      ) {
        this.notificationService
          .notifyWatcherError(
            'High Load',
            `Analysis backlog full. Some files (e.g. ${path.basename(filePath)}) were skipped to maintain performance.`
          )
          .catch((/** @type {any} */ err) =>
            logger.debug('[SmartFolderWatcher] Failed to notify watcher error', {
              error: err.message
            })
          );
        this._lastDropNotification = nowMs;
      }
      return;
    }

    const mtime = stats?.mtime ? new Date(stats.mtime).getTime() : Date.now();

    logger.debug('[SMART-FOLDER-WATCHER] File event:', { eventType, filePath });

    const now = Date.now();

    // Debounce - clear existing timeout for this file
    let firstEventAt = now;
    if (this.pendingAnalysis.has(dedupKey)) {
      const existing = this.pendingAnalysis.get(dedupKey);
      firstEventAt = typeof existing.firstEventAt === 'number' ? existing.firstEventAt : now;
      if (existing.timeout) {
        clearTimeout(existing.timeout);
      }
    }

    // Set new debounce timeout
    const elapsed = now - firstEventAt;
    const delay = elapsed >= this.maxDebounceWaitMs ? 0 : this.debounceDelay;
    const timeout = setTimeout(() => {
      if (this._isStopping) {
        return;
      }
      this._queueFileForAnalysis(filePath, mtime, eventType, stats, dedupKey);
    }, delay);
    timeout.unref(); // Don't prevent process exit during shutdown

    this.pendingAnalysis.set(dedupKey, { mtime, timeout, eventType, firstEventAt, filePath });
  }

  /**
   * Queue a file for analysis
   * @private
   */
  async _queueFileForAnalysis(
    /** @type {any} */ filePath,
    /** @type {any} */ mtime,
    /** @type {any} */ eventType,
    /** @type {any} */ stats,
    /** @type {any} */ dedupKey
  ) {
    const lookupKey = dedupKey || normalizePathForIndex(filePath) || filePath;
    const pending = this.pendingAnalysis.get(lookupKey);
    if (pending && pending.timeout) {
      clearTimeout(pending.timeout);
    }
    this.pendingAnalysis.delete(lookupKey);

    try {
      // Verify file still exists
      await fs.access(filePath);

      // If this is a move/rename within smart folders, update paths instead of re-analysis
      if (eventType === 'add') {
        const moveHandled = await this._attemptMoveResolution(filePath, stats);
        if (moveHandled) {
          return;
        }
      }

      // Check if analysis is needed
      const needsAnalysis = await this._needsAnalysis(filePath, mtime, stats);

      if (!needsAnalysis) {
        logger.debug('[SMART-FOLDER-WATCHER] File already up-to-date:', filePath);
        return;
      }

      // Add to queue (bounded + deduplicated). Carry `dedupKey` through so
      // the queue's findIndex check and the processingFiles Set use the same
      // canonical key as `pendingAnalysis`. Without this, Windows/macOS
      // case-variant emissions (e.g. `C:\X\a.txt` and `c:/X/a.txt`) bypass
      // the canonical-key dedup at the queue layer that the recent diff
      // claimed to fix at the debounce-Map layer.
      this._enqueueAnalysisItem({
        filePath,
        dedupKey: lookupKey,
        mtime,
        eventType,
        queuedAt: Date.now()
      });

      logger.info('[SMART-FOLDER-WATCHER] Queued for analysis:', { filePath, eventType });
      this.stats.lastActivity = new Date().toISOString();
    } catch (error) {
      if (isNotFoundError(error)) {
        logger.debug('[SMART-FOLDER-WATCHER] File no longer exists:', filePath);
      } else {
        logger.error('[SMART-FOLDER-WATCHER] Error queueing file:', {
          filePath,
          error: error.message
        });
        this.stats.errors++;
      }
    }
  }

  /**
   * Add an item to the analysis queue with bounds + best-effort deduplication.
   * @private
   * @param {any} item
   */
  _enqueueAnalysisItem(item) {
    if (this._isStopping) {
      return;
    }

    const { filePath } = item;
    // Compute (or accept) a canonical key for queue-level dedup so two
    // case-variant chokidar emissions don't produce two queue entries.
    const dedupKey = item.dedupKey || normalizePathForIndex(filePath) || filePath;
    item.dedupKey = dedupKey;

    // If already queued, replace the existing entry with the latest metadata.
    // Compare by dedupKey when present so case variants merge.
    const existingIndex = this.analysisQueue.findIndex(
      (q) => (q.dedupKey || q.filePath) === dedupKey || q.filePath === filePath
    );
    if (existingIndex !== -1) {
      this.analysisQueue[existingIndex] = item;
      this._scheduleQueuePersist();
      return;
    }

    // Enforce a maximum queue size by dropping the oldest item.
    if (this.analysisQueue.length >= MAX_ANALYSIS_QUEUE_SIZE) {
      const dropped = this.analysisQueue.shift();
      if (dropped) {
        this.stats.queueDropped++;
        this._queueDropsSinceLog++;

        if (dropped.retryCount > 0) {
          logger.warn(
            '[SMART-FOLDER-WATCHER] Dropped retried analysis item due to queue pressure',
            {
              filePath: dropped.filePath,
              retryCount: dropped.retryCount
            }
          );
        }

        // We rate limit this notification to avoid spamming
        const now = Date.now();
        if (
          this.notificationService &&
          (!this._lastDropNotification || now - this._lastDropNotification > 60000)
        ) {
          this.notificationService
            .notifyWatcherError(
              'High Load',
              `Analysis queue full. Some files (e.g. ${path.basename(dropped.filePath)}) were skipped to maintain performance.`
            )
            .catch((/** @type {any} */ err) =>
              logger.debug('[SmartFolderWatcher] Failed to notify watcher error', {
                error: err.message
              })
            );
          this._lastDropNotification = now;
        }
      }

      const now = Date.now();
      if (now - this._lastQueueDropLogAt >= QUEUE_DROP_LOG_INTERVAL_MS) {
        logger.warn('[SMART-FOLDER-WATCHER] Analysis queue full; dropping oldest items', {
          maxQueueSize: MAX_ANALYSIS_QUEUE_SIZE,
          droppedSinceLastLog: this._queueDropsSinceLog,
          queueLength: this.analysisQueue.length
        });
        this._lastQueueDropLogAt = now;
        this._queueDropsSinceLog = 0;
      }
    }

    this.analysisQueue.push(item);
    this._scheduleQueuePersist();
  }

  /**
   * Debounced persistence of the analysis queue (K-07). Safe no-op without a store.
   * @private
   */
  _scheduleQueuePersist() {
    if (!this.queueStore) return;
    // stop() flushes once and then empties analysisQueue; a debounced write
    // landing after that would persist an empty queue and delete the file we
    // just wrote. `_isStopping` covers the stop() window itself, but stop()
    // deliberately resets it on the way out — and a _processQueue that blew
    // through stop's 30s in-flight wait can still call us afterwards. stop()
    // sets isRunning=false BEFORE clearing _isStopping, so the pair leaves no
    // permissive gap.
    if (this._isStopping || !this.isRunning) return;
    if (this._queuePersistTimer) return;
    const backlog = this.analysisQueue.length + this._pendingReanalyzeItems.length;
    const debounceMs =
      backlog <= QUEUE_PERSIST_LARGE_THRESHOLD
        ? QUEUE_PERSIST_DEBOUNCE_MS
        : QUEUE_PERSIST_DEBOUNCE_LARGE_MS;
    this._queuePersistTimer = setTimeout(() => {
      this._queuePersistTimer = null;
      void this._flushQueuePersist();
    }, debounceMs);
    if (typeof this._queuePersistTimer.unref === 'function') this._queuePersistTimer.unref();
  }

  /**
   * Write the current queue (immediate + overflow + in-flight) to the store now.
   * @private
   * @returns {Promise<void>}
   */
  async _flushQueuePersist() {
    if (!this.queueStore) return;
    if (this._queuePersistTimer) {
      clearTimeout(this._queuePersistTimer);
      this._queuePersistTimer = null;
    }
    // In-flight items last, first-occurrence wins: a _handleAnalysisError
    // re-enqueue puts a copy with the bumped retryCount back on the queue
    // before the in-flight entry is dropped, and that copy is the current one.
    /** @type {any[]} */
    const snapshot = [];
    /** @type {Set<string>} */
    const seen = new Set();
    for (const item of [
      ...this.analysisQueue,
      ...this._pendingReanalyzeItems,
      ...this._inFlightItems.values(),
      ...this._parkedItems
    ]) {
      const key = this._queueItemKey(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      snapshot.push(item);
    }
    // Serialize writes behind the previous flush. Two overlapping saves race
    // on the tmp→rename, so the file could end up holding the OLDER snapshot
    // (last rename wins, not last caller). The chain never rejects — each
    // link ends in a catch — so one failed save can't wedge the next.
    const run = (this._queuePersistPromise || Promise.resolve())
      .then(() => /** @type {any} */ (this.queueStore).save(snapshot))
      .catch((/** @type {any} */ err) => {
        logger.warn('[SMART-FOLDER-WATCHER] Failed to persist analysis queue', {
          error: err?.message
        });
      });
    this._queuePersistPromise = run;
    await run;
  }

  /**
   * Canonical queue key for an item — the same key _enqueueAnalysisItem and
   * _processQueue dedupe on, so case variants of one path collapse to one entry.
   * @private
   * @param {any} item
   * @returns {string}
   */
  _queueItemKey(item) {
    if (!item) return '';
    return item.dedupKey || normalizePathForIndex(item.filePath) || item.filePath || '';
  }

  /**
   * Normalize a list of folder paths into comparable, trailing-slash-free
   * roots. Hoisted out of the containment check so a caller iterating many
   * items pays for the normalization once, not per item.
   * @private
   * @param {Iterable<any>} paths
   * @returns {string[]}
   */
  _normalizedRoots(paths) {
    /** @type {string[]} */
    const roots = [];
    for (const candidate of paths) {
      if (typeof candidate !== 'string' || !candidate) continue;
      const root = normalizePathForIndex(candidate).replace(/\/+$/, '');
      if (root) roots.push(root);
    }
    return roots;
  }

  /**
   * True when `filePath` sits inside one of `roots`. Same prefix comparison
   * _purgeQueuedWorkForRemovedFolder uses.
   * @private
   * @param {any} filePath
   * @param {string[]} roots
   * @returns {boolean}
   */
  _isUnderRoots(filePath, roots) {
    const p = normalizePathForIndex(filePath);
    if (!p) return false;
    return roots.some((root) => p === root || p.startsWith(`${root}/`));
  }

  /**
   * Roots of every CONFIGURED smart folder — not `watchedPaths`, which holds
   * only the subset that stat-ed successfully at start.
   * @private
   * @returns {string[]}
   */
  _configuredFolderRoots() {
    let folders;
    try {
      folders = this.getSmartFolders() || [];
    } catch (err) {
      logger.debug('[SMART-FOLDER-WATCHER] Could not read smart folders', {
        error: /** @type {any} */ (err)?.message
      });
      return [];
    }
    if (!Array.isArray(folders)) return [];
    return this._normalizedRoots(folders.map((/** @type {any} */ f) => f?.path));
  }

  /**
   * True when `filePath` sits inside one of the configured smart folders.
   * @private
   * @param {any} filePath
   * @returns {boolean}
   */
  _isUnderConfiguredFolder(filePath) {
    return this._isUnderRoots(filePath, this._configuredFolderRoots());
  }

  /**
   * The configured Smart Folder `filePath` lies under, as the user spelled
   * it, or null when none does. Where Smart Folders nest, the deepest one
   * wins: the user asked for that folder to be watched, so a rule naming a
   * folder of its name (`archived/**`) does not fold it away as a subfolder
   * of the outer one. This is the root the exclusion rules read relative
   * folder globs against.
   * @private
   * @param {any} filePath
   * @returns {string|null}
   */
  _exclusionRootFor(filePath) {
    let folders;
    try {
      folders = this.getSmartFolders() || [];
    } catch {
      return null;
    }
    if (!Array.isArray(folders)) return null;
    /** @type {string|null} */
    let deepest = null;
    let deepestLength = -1;
    for (const folder of folders) {
      const candidate = folder?.path;
      const [root] = this._normalizedRoots([candidate]);
      if (!root || root.length <= deepestLength) continue;
      if (this._isUnderRoots(filePath, [root])) {
        deepest = candidate;
        deepestLength = root.length;
      }
    }
    return deepest;
  }

  /**
   * A restored item whose smart folder is configured but is not currently
   * being watched — an unmounted USB drive, an SMB share that wasn't up when
   * the VPN connected. Dequeuing it is worse than leaving it parked:
   * `_analyzeFile` swallows not-found errors (`isNotFoundError` short-circuits
   * its catch without rethrowing), so the item never reaches
   * `_handleAnalysisError` and disappears on its very first dequeue — no
   * retries, no give-up log. Parked items stay in the overflow buffer, and
   * therefore in the persisted file, until the folder comes back.
   * @private
   * @param {any} item
   * @param {string[]} watchedRoots
   * @returns {boolean}
   */
  _isAwaitingFolderMount(item, watchedRoots) {
    if (!item?.restored) return false;
    return !this._isUnderRoots(item.filePath, watchedRoots);
  }

  /**
   * Re-enqueue items persisted by a previous session. Called once from _doStart.
   *
   * Parked items (configured folder not currently watched) carry no TTL — they
   * are cleaned up when the folder is removed from the smart-folder config, via
   * updateWatchedFolders → _purgeQueuedWorkForRemovedFolder.
   * @private
   * @returns {Promise<number>} number of items restored
   */
  async _restoreQueue() {
    if (!this.queueStore) return 0;
    /** @type {any[]} */
    let items;
    try {
      items = (await this.queueStore.load()) || [];
    } catch (err) {
      logger.warn('[SMART-FOLDER-WATCHER] Failed to load persisted queue', {
        error: /** @type {any} */ (err)?.message
      });
      return 0;
    }

    const normalize = (/** @type {any} */ item) => ({
      ...item,
      eventType: item.eventType || 'add',
      queuedAt: Date.now(),
      // Marks the item as coming off disk rather than off a live fs event, so
      // _analyzeFile knows to re-check _needsAnalysis before spending an LLM
      // pass (see the gate there).
      restored: true
    });

    // Scope restored work to the CONFIGURED smart folders. The queue file is
    // plain JSON under userData; a stale copy (folders removed since the crash)
    // or a hand-edited one must not make the watcher analyze arbitrary paths.
    //
    // Deliberately NOT watchedPaths: that is only the subset of folders that
    // stat-ed successfully at start, so scoping to it would discard the whole
    // backlog of a transiently unavailable folder (unmounted USB, SMB share
    // before the VPN is up) — and the next flush would erase it from the file
    // permanently. Items for a configured-but-unwatched folder are parked
    // below instead.
    const configuredRoots = this._configuredFolderRoots();
    const watchedRoots = this._normalizedRoots(this.watchedPaths);
    let discardedOutsideConfigured = 0;
    // Dedupe against whatever is already queued AND within the restored batch
    // itself. stop() clears both queues, but an error-driven restart can race
    // live events in, and a double _restoreQueue would otherwise duplicate the
    // whole backlog in memory and on disk (_fillFromPendingReanalyze does not
    // dedupe when it drains).
    const seen = new Set(
      [...this.analysisQueue, ...this._pendingReanalyzeItems, ...this._parkedItems].map((item) =>
        this._queueItemKey(item)
      )
    );
    let skippedDuplicate = 0;
    // Rules added since the queue was written apply to what comes back —
    // on exactly the terms _analyzeFile's gate uses, so a hand-picked
    // single-file reanalyze survives the restart it was interrupted by
    // instead of dying silently.
    let droppedExcluded = 0;

    /** @type {any[]} */
    const ready = [];
    /** @type {any[]} */
    const awaitingMount = [];
    for (const item of items) {
      if (!item || typeof item.filePath !== 'string') continue;
      if (!this._isUnderRoots(item.filePath, configuredRoots)) {
        discardedOutsideConfigured++;
        continue;
      }
      if (!this._isExclusionExempt(item) && this._matchUserExclusion(item.filePath)) {
        droppedExcluded++;
        continue;
      }
      const key = this._queueItemKey(item);
      if (key && seen.has(key)) {
        skippedDuplicate++;
        continue;
      }
      if (key) seen.add(key);
      const normalized = normalize(item);
      if (this._isAwaitingFolderMount(normalized, watchedRoots)) {
        awaitingMount.push(normalized);
      } else {
        ready.push(normalized);
      }
    }

    // Mirror forceReanalyzeAll's capacity split rather than funnelling
    // everything through _enqueueAnalysisItem: its overflow path SHIFTS the
    // oldest entry, so restoring an interrupted 50k-file reanalysis would keep
    // only the last MAX items (images first, since forceReanalyzeAll sorts
    // docs ahead of images), fire ~49k queueDropped increments plus the "High
    // Load" toast at startup, and evict live events enqueued between
    // watcher-ready and restore. _fillFromPendingReanalyze drains the
    // overflow buffer at the end of every processing cycle.
    const capacity = Math.max(0, MAX_ANALYSIS_QUEUE_SIZE - this.analysisQueue.length);
    for (const item of ready.slice(0, capacity)) {
      this._enqueueAnalysisItem(item);
    }
    this._pendingReanalyzeItems.push(...ready.slice(capacity));
    // Parked items live outside the drain path entirely, so real work never
    // queues behind a folder that may not come back this session.
    this._parkedItems.push(...awaitingMount);

    const restored = ready.length + awaitingMount.length;
    if (
      restored > 0 ||
      discardedOutsideConfigured > 0 ||
      skippedDuplicate > 0 ||
      droppedExcluded > 0
    ) {
      logger.info('[SMART-FOLDER-WATCHER] Restored persisted analysis queue', {
        restored,
        immediate: Math.min(ready.length, capacity),
        overflow: Math.max(0, ready.length - capacity),
        awaitingFolderMount: awaitingMount.length,
        discardedOutsideConfigured,
        skippedDuplicate,
        droppedExcluded
      });
    }
    if (restored > 0) {
      // `_enqueueAnalysisItem` only appends — it never kicks processing — so
      // the restored batch would otherwise sit idle until the 2s queueTimer
      // interval fires. Start it now; `_processQueue` is re-entrancy guarded.
      void this._processQueue();
    }
    return restored;
  }

  /**
   * Attempt to resolve a move by matching recent deletions.
   * If matched, update path-dependent systems and skip re-analysis.
   *
   * FIX: When multiple candidates match, attempt to disambiguate by base name
   * before falling back to full re-analysis.
   *
   * @private
   */
  async _attemptMoveResolution(/** @type {any} */ filePath, /** @type {any} */ stats) {
    if (this._pendingMoveCandidates.size === 0) {
      return false;
    }

    let fileStats = stats;
    try {
      if (!fileStats || !Number.isFinite(fileStats.size)) {
        fileStats = await fs.stat(filePath);
      }
    } catch (error) {
      if (isNotFoundError(error)) return false;
      logger.debug('[SMART-FOLDER-WATCHER] Move check stat failed:', error.message);
      return false;
    }

    const size = fileStats.size;
    const mtimeMs = Number.isFinite(fileStats.mtimeMs)
      ? fileStats.mtimeMs
      : fileStats.mtime
        ? new Date(fileStats.mtime).getTime()
        : null;
    if (!Number.isFinite(mtimeMs)) return false;

    const ext = path.extname(filePath).toLowerCase();

    // First pass: find candidates matching size, extension, and mtime tolerance
    const matches = [];
    let bestDiff = Infinity;
    for (const candidate of this._pendingMoveCandidates.values()) {
      if (candidate.size !== size || candidate.ext !== ext) continue;
      const diff = Math.abs(candidate.mtimeMs - mtimeMs);
      if (diff <= this._moveMtimeToleranceMs) {
        matches.push({ candidate, diff });
        if (diff < bestDiff) {
          bestDiff = diff;
        }
      }
    }

    if (matches.length === 0) {
      return false;
    }

    let match;
    if (matches.length > 1) {
      const newBaseName = path.basename(filePath).toLowerCase();
      const nameMatches = matches.filter(
        (m) => String(m.candidate.baseName || '').toLowerCase() === newBaseName
      );

      if (nameMatches.length === 1) {
        match = nameMatches[0].candidate;
        logger.debug('[SMART-FOLDER-WATCHER] Resolved ambiguous move via base-name match', {
          newPath: path.basename(filePath),
          matchedName: newBaseName
        });
      } else {
        logger.debug('[SMART-FOLDER-WATCHER] Ambiguous move match; skipping auto-update', {
          newPath: path.basename(filePath),
          candidates: matches.length,
          baseNameMatches: nameMatches.length,
          bestDiffMs: bestDiff
        });
        return false;
      }
    } else {
      match = matches[0].candidate;
    }
    if (match.oldPath === filePath) {
      return false;
    }

    const coordinator = this.filePathCoordinator;
    if (!coordinator || typeof coordinator.atomicPathUpdate !== 'function') {
      logger.warn('[SMART-FOLDER-WATCHER] FilePathCoordinator unavailable for move update', {
        oldPath: match.oldPath,
        newPath: filePath
      });
      return false;
    }

    try {
      await coordinator.atomicPathUpdate(match.oldPath, filePath, { type: 'move' });
      if (match.timeoutId) clearTimeout(match.timeoutId);
      this._pendingMoveCandidates.delete(match.oldPath);

      // Prevent re-processing loops for the moved file
      const tracker = getFileOperationTracker();
      tracker.recordOperation(match.oldPath, 'move', 'smartFolderWatcher');
      tracker.recordOperation(filePath, 'move', 'smartFolderWatcher');

      // Invalidate BM25 index so searches reflect the new path
      if (!this._isStopping) {
        try {
          const { getSearchServiceInstance } = require('../ipc/semantic');
          const searchService = getSearchServiceInstance?.();
          if (searchService?.invalidateIndex) {
            searchService.invalidateIndex({
              reason: 'smart-folder-move',
              oldPath: match.oldPath,
              newPath: filePath
            });
          }
        } catch (indexErr) {
          logger.debug(
            '[SMART-FOLDER-WATCHER] Could not invalidate search index after move:',
            indexErr.message
          );
        }
      }

      this.stats.lastActivity = new Date().toISOString();
      logger.info('[SMART-FOLDER-WATCHER] Resolved move within smart folders', {
        oldPath: path.basename(match.oldPath),
        newPath: path.basename(filePath)
      });

      return true;
    } catch (error) {
      logger.warn('[SMART-FOLDER-WATCHER] Move update failed, will re-analyze', {
        oldPath: match.oldPath,
        newPath: filePath,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Check if a file needs analysis
   * @private
   */
  async _needsAnalysis(
    /** @type {any} */ filePath,
    /** @type {any} */ mtime,
    /** @type {any} */ stats = null
  ) {
    try {
      let fileStats = stats;
      if (!fileStats) {
        fileStats = await fs.stat(filePath);
      }

      const currentMtimeMs = Number.isFinite(fileStats.mtimeMs)
        ? fileStats.mtimeMs
        : fileStats.mtime
          ? new Date(fileStats.mtime).getTime()
          : Number(mtime);

      // Get existing analysis for this file
      const existingAnalysis = await this.analysisHistoryService.getAnalysisByPath(filePath);

      // If not found by path, try by file hash (helps when paths change case).
      // Hash the same inputs the history writer does (path, size and the
      // NUMERIC mtimeMs, see analysisUtils.recordAnalysisResult), or the
      // lookup can never hit. This used to hash an ISO string.
      let matchedAnalysis = existingAnalysis;
      if (!matchedAnalysis && Number.isFinite(currentMtimeMs)) {
        matchedAnalysis = await this.analysisHistoryService.getAnalysisByHash(
          generateFileHash(filePath, fileStats.size, currentMtimeMs)
        );
      }

      if (!matchedAnalysis) {
        // New file - needs analysis
        return true;
      }

      if (
        Number.isFinite(matchedAnalysis.fileSize) &&
        matchedAnalysis.fileSize !== fileStats.size
      ) {
        return true;
      }

      // No stored-fileHash comparison. The hash embeds the path, and an
      // organize move re-keys the entry's path without recomputing it, so an
      // untouched organized file would always "differ". Size (above) and
      // mtime (below) are the content signal the hash was standing in for.
      // Comparing it, with the ISO-vs-number mismatch on top, made the
      // startup delta scan re-analyze every file on every launch.

      // Check if file was modified after last analysis
      const analysisTime = new Date(
        matchedAnalysis.lastModified ?? matchedAnalysis.timestamp
      ).getTime();

      // FIX: Re-analyze if the embedding previously failed
      if (matchedAnalysis.embedding?.status === 'failed') {
        return true;
      }

      // Provisional (fallback-only) analyses are retried once the capability
      // they lacked is present — a bounded number of times, and never for
      // content limitations a new model cannot fix (F-195 / K-06, D7).
      const stored = matchedAnalysis.analysis || {};
      if (
        stored.provisional === true &&
        (Number(stored.provisionalRetries) || 0) < PROVISIONAL_MAX_RETRIES &&
        isCapabilityFallback(stored) &&
        (await this._capabilityNowAvailable(filePath))
      ) {
        return true;
      }

      if (!Number.isFinite(currentMtimeMs) || !Number.isFinite(analysisTime)) {
        return true;
      }

      // Whole milliseconds on both sides: history stores the fractional
      // mtimeMs (e.g. 1790639260670.4954) and Date truncates it to ...670,
      // so a raw compare called every untouched file "modified".
      return Math.floor(currentMtimeMs) > Math.floor(analysisTime);
    } catch (error) {
      logger.warn('[SMART-FOLDER-WATCHER] Error checking analysis history:', error.message);
      // If we can't check, assume it needs analysis
      return true;
    }
  }

  /**
   * Run one analysis under the global timeout AND abort the work when the
   * timeout fires. Before this the timed-out promise kept running (pinning a
   * worker for the full OCR/LLM call) while the item was re-queued behind it
   * (F-196 / K-07).
   * @private
   * @param {any} item
   * @returns {Promise<any>}
   */
  async _analyzeWithTimeout(item) {
    const controller = new AbortController();
    try {
      return await withTimeout(
        this._analyzeFile(item, controller.signal),
        TIMEOUTS.GLOBAL_ANALYSIS || 10 * 60 * 1000,
        `SmartFolderWatcher analyze ${item?.filePath}`
      );
    } catch (error) {
      controller.abort();
      throw error;
    }
  }

  /**
   * Resolve the in-process AI service (overridable in tests).
   * @private
   * @returns {any}
   */
  _getLlamaService() {
    try {
      const { getInstance } = require('./LlamaService');
      return getInstance();
    } catch {
      return null;
    }
  }

  /**
   * Is the model a provisional analysis of `filePath` was missing installed
   * now? Documents need the text model, images the vision model. The probe
   * (config + installed list) is cached briefly so a scan over thousands of
   * files costs one lookup, not one per file.
   * @private
   * @param {string} filePath
   * @returns {Promise<boolean>}
   */
  async _capabilityNowAvailable(filePath) {
    const now = Date.now();
    const cache = this._capabilityProbeCache;
    let probe = cache && now - cache.at < 60000 ? cache : null;
    if (!probe) {
      let textModel;
      let visionModel;
      let installed;
      try {
        const llama = this._getLlamaService();
        if (!llama) return false;
        const cfg = typeof llama.getConfig === 'function' ? await llama.getConfig() : {};
        textModel = cfg?.textModel || null;
        visionModel = cfg?.visionModel || null;
        const models = typeof llama.listModels === 'function' ? await llama.listModels() : [];
        installed = (Array.isArray(models) ? models : [])
          .map((m) => String(m?.name || m?.filename || m || '').trim())
          .filter(Boolean);
      } catch (probeErr) {
        logger.debug('[SMART-FOLDER-WATCHER] Capability probe failed', {
          error: /** @type {any} */ (probeErr)?.message
        });
        return false;
      }
      probe = {
        at: now,
        text: Boolean(textModel && findInstalledModelMatch(installed, textModel)),
        vision: Boolean(visionModel && findInstalledModelMatch(installed, visionModel)),
        whisper: await this._whisperAvailable()
      };
      this._capabilityProbeCache = probe;
    }
    if (isImagePath(filePath)) return probe.vision;
    // Audio/video fall back because Whisper is missing, not the text model.
    // Probing the text model retried every skipped video while Whisper was
    // still absent, spent the retry budget, and never retried once it arrived.
    if (isMediaPath(filePath)) return probe.whisper;
    return probe.text;
  }

  /**
   * Is the Whisper model installed and loadable? False when the service is
   * not registered or the probe fails.
   * @private
   * @returns {Promise<boolean>}
   */
  async _whisperAvailable() {
    try {
      const { container, ServiceIds } = require('./ServiceContainer');
      const whisper = container.tryResolve(ServiceIds.WHISPER_SERVICE);
      return Boolean(
        whisper && typeof whisper.isAvailable === 'function' && (await whisper.isAvailable())
      );
    } catch {
      return false;
    }
  }

  /**
   * Start the queue processor
   * @private
   */
  _startQueueProcessor() {
    if (this.queueTimer) {
      clearInterval(this.queueTimer);
    }

    this.queueTimer = setInterval(() => {
      this._processQueue();
    }, this.queueProcessInterval);

    // Don't prevent process exit
    if (this.queueTimer.unref) {
      this.queueTimer.unref();
    }
  }

  /**
   * Process the analysis queue
   * @private
   */
  async _processQueue() {
    if (this._isStopping || this.isProcessingQueue || this.analysisQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      // Find the first available item that is NOT currently being processed.
      // Compare by canonical dedupKey so case-variant duplicates are caught.
      const procKey = (/** @type {any} */ item) => item.dedupKey || item.filePath;
      const firstAvailableIndex = this.analysisQueue.findIndex(
        (item) => !this.processingFiles.has(procKey(item))
      );

      // If all queued items are currently processing, wait for next tick
      if (firstAvailableIndex === -1) {
        return;
      }

      const firstItem = this.analysisQueue[firstAvailableIndex];
      const firstIsImage = isImagePath(firstItem.filePath);

      if (firstIsImage) {
        // Image batch: take consecutive images (up to 20) that are not currently processing
        const batch = [];
        const maxImageBatch = 20;
        let i = firstAvailableIndex;

        while (i < this.analysisQueue.length && batch.length < maxImageBatch) {
          const item = this.analysisQueue[i];
          if (!this.processingFiles.has(procKey(item)) && isImagePath(item.filePath)) {
            batch.push(item);
            this.analysisQueue.splice(i, 1);
            // Keep the item in the durable record while it is off both queues.
            this._inFlightItems.set(procKey(item), item);
          } else {
            i++;
          }
        }
        this._scheduleQueuePersist();

        // Enter vision batch mode once for the whole batch
        let llamaService;
        try {
          const { getInstance: getLlamaService } = require('./LlamaService');
          llamaService = getLlamaService();
        } catch {
          llamaService = null;
        }

        if (llamaService) {
          try {
            await llamaService.enterVisionBatchMode();
          } catch (err) {
            logger.warn('[SMART-FOLDER-WATCHER] Failed to enter vision batch mode', {
              error: err.message
            });
          }
        }

        try {
          for (const item of batch) {
            try {
              await this._analyzeWithTimeout(item);
            } catch (error) {
              try {
                this._handleAnalysisError(item, error);
              } catch (handlerError) {
                // A throw here would abort the whole sequential batch and leak
                // every remaining _inFlightItems entry.
                logger.error('[SMART-FOLDER-WATCHER] Analysis error handler threw', {
                  filePath: item?.filePath,
                  error: handlerError?.message
                });
              }
            } finally {
              // After _handleAnalysisError: a retry re-enqueues a fresh copy
              // onto analysisQueue, so dropping the in-flight entry here never
              // loses the item.
              this._inFlightItems.delete(procKey(item));
            }
          }
        } finally {
          // Belt and braces: if anything above escaped the per-item handling,
          // the batch's keys must not linger in the durable snapshot forever.
          for (const item of batch) {
            this._inFlightItems.delete(procKey(item));
          }
          if (llamaService) {
            try {
              await llamaService.exitVisionBatchMode();
            } catch (err) {
              logger.warn('[SMART-FOLDER-WATCHER] Failed to exit vision batch mode', {
                error: err.message
              });
            }
          }
        }
      } else {
        // Document batch: take up to maxConcurrentAnalysis that are not currently processing
        const batchSize = Math.max(1, this.maxConcurrentAnalysis || 1);
        const batch = [];
        let i = firstAvailableIndex;

        while (i < this.analysisQueue.length && batch.length < batchSize) {
          const item = this.analysisQueue[i];
          if (!this.processingFiles.has(procKey(item)) && !isImagePath(item.filePath)) {
            batch.push(item);
            this.analysisQueue.splice(i, 1);
            // Keep the item in the durable record while it is off both queues.
            this._inFlightItems.set(procKey(item), item);
          } else {
            i++;
          }
        }
        this._scheduleQueuePersist();

        const results = await Promise.allSettled(
          batch.map((/** @type {any} */ item) =>
            this._analyzeWithTimeout(item)
              .catch((/** @type {any} */ error) => {
                this._handleAnalysisError(item, error);
              })
              .finally(() => this._inFlightItems.delete(procKey(item)))
          )
        );
        void results; // Errors handled per-item above
      }
    } catch (error) {
      logger.error('[SMART-FOLDER-WATCHER] Queue processing error:', error.message);
      this.stats.errors++;
    } finally {
      this.isProcessingQueue = false;
      // Drain overflow buffer into the main queue before checking if more work remains
      this._fillFromPendingReanalyze();
      // Re-trigger if more items remain instead of waiting for the 2s interval.
      //
      // Subtle: `setImmediate` reschedules us at the very front of the
      // next event-loop iteration. When the queue is draining a long
      // reanalyze burst and every `_analyzeFile` resolves quickly (e.g.
      // cached embeddings), back-to-back `setImmediate` tail-calls can
      // monopolize the loop and starve timers (debounce flushes, tray
      // heartbeats, stability checks). `setTimeout(fn, 0)` routes the
      // re-entry through the timers phase instead, which gives queued
      // `setTimeout` / `setInterval` callbacks a chance to interleave.
      // The extra nominal delay is <1ms in practice.
      if (this.analysisQueue.length > 0 && !this._isStopping && this.isRunning) {
        // Per-cycle re-entry timer is intentionally NOT .unref()'d. The
        // queueTimer interval already keeps the loop alive when idle; this
        // re-entry guarantees we keep the process alive while there's still
        // work to drain. Previously `.unref()` here let the process exit
        // mid-drain during graceful shutdown, silently losing queued items.
        setTimeout(() => {
          this._processQueue();
        }, 0);
      }
    }
  }

  /**
   * Move items from the pending reanalyze overflow buffer into the main analysis queue,
   * up to the available capacity. Called after each processing cycle so large reanalysis
   * jobs (>MAX_ANALYSIS_QUEUE_SIZE files) stream through without dropping items.
   * @private
   */
  _fillFromPendingReanalyze() {
    if (this._pendingReanalyzeItems.length === 0) return;

    const capacity = MAX_ANALYSIS_QUEUE_SIZE - this.analysisQueue.length;
    if (capacity <= 0) return;

    // Items awaiting a folder mount are held in _parkedItems, not here, so
    // this stays a plain O(capacity) drain with no per-cycle scanning.
    const toMove = this._pendingReanalyzeItems.splice(0, capacity);
    for (const item of toMove) {
      this.analysisQueue.push(item);
    }

    if (toMove.length > 0) {
      logger.debug('[SMART-FOLDER-WATCHER] Drained overflow into queue', {
        moved: toMove.length,
        remainingOverflow: this._pendingReanalyzeItems.length,
        queueLength: this.analysisQueue.length
      });
    }
  }

  /**
   * Handle analysis error for a single item — retry or give up
   * @private
   */
  _handleAnalysisError(/** @type {any} */ item, /** @type {any} */ error) {
    logger.warn('[SMART-FOLDER-WATCHER] Analysis timed out or failed', {
      filePath: item.filePath,
      error: error.message
    });
    this.stats.errors++;

    const nextRetry = (item.retryCount || 0) + 1;
    if (nextRetry <= MAX_ANALYSIS_RETRIES) {
      this._enqueueAnalysisItem({
        ...item,
        retryCount: nextRetry,
        cachedAnalysis: item._lastAnalysis || item.cachedAnalysis || null
      });
      logger.debug('[SMART-FOLDER-WATCHER] Re-queued file after failure', {
        filePath: item.filePath,
        retryCount: nextRetry,
        hasCachedAnalysis: !!(item._lastAnalysis || item.cachedAnalysis)
      });
    } else {
      logger.error('[SMART-FOLDER-WATCHER] Max retries reached, giving up', {
        filePath: item.filePath,
        retries: nextRetry
      });

      // Record a failed analysis state so we don't infinitely retry this file on every startup
      if (this.analysisHistoryService) {
        const dummyResult = {
          subject: 'Analysis Failed',
          category: 'error',
          summary: `Failed to analyze file after ${nextRetry} attempts: ${error?.message || 'Unknown error'}`,
          errorCount: 1,
          warnings: [error?.message || 'Unknown error'],
          confidence: 0
        };
        recordAnalysisResult({
          filePath: item.filePath,
          result: dummyResult,
          processingTime: 0,
          modelType: 'unknown',
          analysisHistory: this.analysisHistoryService,
          logger
        }).catch((err) =>
          logger.debug('[SMART-FOLDER-WATCHER] Failed to record error state', {
            error: err.message
          })
        );
      }

      if (this.notificationService) {
        this.notificationService
          .notifyWatcherError(
            'Analysis Failed',
            `File "${path.basename(item.filePath)}" failed after ${nextRetry} attempts: ${error?.message || 'Max retries exceeded'}`
          )
          .catch((/** @type {any} */ err) =>
            logger.debug('[SmartFolderWatcher] Failed to notify analysis error', {
              error: err.message
            })
          );
      }
    }

    // Persist the post-retry queue shape (K-07): either the item came back
    // with a bumped retryCount, or it was dropped for good.
    this._scheduleQueuePersist();
  }

  /**
   * Analyze a single file
   * @private
   */
  async _analyzeFile(/** @type {any} */ item, /** @type {AbortSignal=} */ signal) {
    if (this._isStopping) return;

    if (
      typeof this.analyzeDocumentFile !== 'function' ||
      typeof this.analyzeImageFile !== 'function'
    ) {
      logger.warn(
        '[SMART-FOLDER-WATCHER] Analysis functions not configured, skipping:',
        item?.filePath
      );
      return;
    }

    const { filePath, eventType, applyNaming } = item;
    const isReanalyze = eventType === 'reanalyze';
    // Content update: file was modified in-place (e.g. user edited & saved).
    // Only update details (summary, keywords, embeddings) — preserve the
    // existing name and smart-folder/category assignment.
    const isContentUpdate = eventType === 'change';

    // Exclusion rules apply at the one point every queue path shares: live
    // events, the startup and folder-add scans, items restored from disk and
    // bulk reanalysis all land here. A single file the user asked to
    // reanalyze by hand is the one explicit request that goes through
    // (_isExclusionExempt owns that rule for every gate).
    if (!this._isExclusionExempt(item)) {
      const excludedBy = this._matchUserExclusion(filePath);
      if (excludedBy) {
        logger.debug('[SMART-FOLDER-WATCHER] Skipping queued file excluded by user rule:', {
          filePath,
          pattern: excludedBy
        });
        return;
      }
    }

    // Use the canonical dedup key so a case-variant of an in-flight file
    // doesn't slip past the processing-set guard and double-analyze.
    const processingKey = item.dedupKey || normalizePathForIndex(filePath) || filePath;

    if (this.processingFiles.has(processingKey)) {
      return;
    }

    this.processingFiles.add(processingKey);

    try {
      // Verify file still exists and capture stats for reuse below
      const fileStats = await fs.stat(filePath);

      // Restored items skipped the _needsAnalysis gate that _handleFileEvent
      // and the startup scan both apply — they came straight off disk. Between
      // the crash and this restart the file may well have been analyzed
      // another way (Discover, a manual run), so re-check now rather than
      // spending a full LLM pass. Done lazily here, not at restore time, so a
      // 50k-item backlog doesn't stat and hash every file up front. Explicit
      // reanalyze requests intentionally bypass the gate.
      if (item.restored && !isReanalyze) {
        const stillNeedsAnalysis = await this._needsAnalysis(filePath, item.mtime, fileStats);
        if (!stillNeedsAnalysis) {
          logger.debug(
            '[SMART-FOLDER-WATCHER] Restored item already analyzed elsewhere; skipping',
            { filePath }
          );
          return;
        }
      }

      logger.info('[SMART-FOLDER-WATCHER] Analyzing file:', filePath, {
        applyNaming: applyNaming !== false,
        isContentUpdate
      });

      // Get smart folders for categorization
      const smartFolders = this.getSmartFolders() || [];
      const folderCategories = smartFolders.map((/** @type {any} */ f) => ({
        name: f.name,
        description: f.description || '',
        id: f.id,
        path: f.path
      }));

      // Reuse cached LLM analysis when retrying after an embedding failure.
      // This avoids repeating the expensive LLM call for a transient embedding issue.
      let result;
      const isEmbeddingRetry = Boolean(item.cachedAnalysis);
      const supportsStructuredAnalysis = isSupportedFile(filePath);
      if (isEmbeddingRetry) {
        result = item.cachedAnalysis;
        logger.debug(
          '[SMART-FOLDER-WATCHER] Reusing cached LLM analysis for embedding retry:',
          filePath
        );
      } else if (!supportsStructuredAnalysis) {
        result = createUnsupportedFileFallback(filePath, folderCategories);
        logger.info('[SMART-FOLDER-WATCHER] Using metadata fallback for unsupported file', {
          filePath,
          extension: path.extname(filePath).toLowerCase() || null
        });
      } else if (isImagePath(filePath)) {
        // smartFolderId resolves to the smart folder that owns this path
        // so per-folder AI overrides (settings.routing.perFolder) fire.
        // Image analysis currently forces local routing for OCR text
        // (privacy-first), so this value is plumbed but ignored today;
        // it stays here for symmetry and future use.
        result = await this.analyzeImageFile(filePath, folderCategories, {
          bypassCache: isReanalyze,
          smartFolderId: this._resolveFolderIdForPath(filePath),
          // Both spellings: documents read `abortSignal`, images read `signal`.
          abortSignal: signal,
          signal
        });
      } else if (isMediaPath(filePath) && typeof this.analyzeMediaFile === 'function') {
        // Audio/video files: route to the dedicated media analyzer (Whisper transcription
        // + optional vision-LLM keyframe captioning). The adapter handles graceful skip
        // when Whisper isn't available, returning a normalized result that flows through
        // the same recordAnalysisResult / embedding path as documents and images.
        result = await this.analyzeMediaFile(filePath, folderCategories, {
          bypassCache: isReanalyze,
          smartFolderId: this._resolveFolderIdForPath(filePath),
          // Both spellings: documents read `abortSignal`, images read `signal`.
          abortSignal: signal,
          signal
        });
      } else {
        result = await this.analyzeDocumentFile(filePath, folderCategories, {
          bypassCache: isReanalyze,
          smartFolderId: this._resolveFolderIdForPath(filePath),
          // Both spellings: documents read `abortSignal`, images read `signal`.
          abortSignal: signal,
          signal
        });
      }

      if (this._isStopping) return;

      if (result) {
        const analysis = result.analysis || result;
        const originalFileName = path.basename(filePath);
        if (analysis) {
          const llmSuggestedName =
            analysis.llmSuggestedName ||
            analysis.originalSuggestedName ||
            analysis.suggestedName ||
            originalFileName;
          analysis.llmSuggestedName = llmSuggestedName;
          analysis.originalSuggestedName = llmSuggestedName;
        }

        // Embedding-only retry: skip all post-analysis side effects (naming, history,
        // notification, learning feedback) since they already ran on the original pass.
        // Only re-attempt the embedding.
        if (isEmbeddingRetry) {
          try {
            // Embedding retry should only retry embedding and then stop.
            // Do not run analysis side effects or stats updates.
            await this._embedAnalyzedFile(filePath, result);
            logger.debug('[SMART-FOLDER-WATCHER] Embedding retry succeeded', { filePath });
          } catch (embedErr) {
            logger.warn('[SMART-FOLDER-WATCHER] Embedding retry failed again', {
              filePath,
              error: embedErr.message
            });
            const retryCount = (item.retryCount || 0) + 1;
            if (retryCount <= MAX_ANALYSIS_RETRIES) {
              this._enqueueAnalysisItem({
                ...item,
                retryCount,
                cachedAnalysis: result
              });
            } else {
              logger.error('[SMART-FOLDER-WATCHER] Embedding retries exhausted', {
                filePath,
                retryCount
              });
            }
          }
          return;
        }

        // Apply user's naming convention to the suggested name (unless explicitly disabled)
        // Default behavior is to apply naming (backward compatibility)
        const shouldApplyNaming = applyNaming !== false && !isEmbeddingRetry && !isContentUpdate;

        if (shouldApplyNaming) {
          try {
            // IMPORTANT: Load naming conventions from persisted Settings, NOT Redux state
            // The SmartFolderWatcher uses the Settings naming conventions to ensure consistent
            // naming behavior across all automatic operations (watchers & reanalysis).
            // The Discover phase has its own session-based naming controls in Redux.
            const settings = await this.settingsService.load();
            const namingSettings = {
              convention: settings.namingConvention || 'keep-original',
              separator: settings.separator ?? '-',
              dateFormat: settings.dateFormat || 'YYYY-MM-DD',
              caseConvention: settings.caseConvention
            };

            // Reuse fileStats from existence check above
            const fileTimestamps = {
              created: fileStats.birthtime,
              modified: fileStats.mtime
            };

            // Generate suggested name using user's naming convention
            const suggestedName = generateSuggestedNameFromAnalysis({
              originalFileName,
              analysis,
              settings: namingSettings,
              fileTimestamps
            });

            if (suggestedName && analysis) {
              analysis.suggestedName = suggestedName;
              analysis.finalSuggestedName = suggestedName;
              logger.debug('[SMART-FOLDER-WATCHER] Applied naming convention:', {
                original: originalFileName,
                llmSuggestedName: analysis.llmSuggestedName,
                finalSuggestedName: suggestedName,
                convention: namingSettings.convention
              });
            }
          } catch (namingError) {
            logger.debug(
              '[SMART-FOLDER-WATCHER] Could not apply naming convention:',
              namingError.message
            );
          }
        } else {
          // Keep original name when applyNaming is false
          if (analysis) {
            analysis.suggestedName = originalFileName;
            analysis.finalSuggestedName = originalFileName;
            logger.debug('[SMART-FOLDER-WATCHER] Keeping original name:', {
              original: originalFileName,
              llmSuggestedName: analysis.llmSuggestedName,
              finalSuggestedName: originalFileName
            });
          }
        }

        // Cache the LLM analysis result on the item so that if embedding fails
        // and the item is re-enqueued for retry, the expensive LLM call is not repeated.
        if (!isEmbeddingRetry) {
          item._lastAnalysis = result;
        }

        // Skip persisting fallback-only results to analysis history so that
        // _needsAnalysis() will pick the file up again on the next scan when
        // the model becomes available. Also skip embedding — fallback results
        // have no meaningful content to embed.
        // Also skip entirely for embedding retries (handled above).
        const analysis_check = result?.analysis || result || {};
        // One shared definition (F-205 / K-16): this used to miss
        // `media-skipped-no-whisper` and `extension_short_circuit`, so "no
        // transcript" placeholders got vectors and outranked real content.
        const isFallbackOnly = !isEmbeddingRetry && isFallbackAnalysis(analysis_check);

        if (!isEmbeddingRetry && !isFallbackOnly) {
          // Embed the analyzed file into the vector DB for semantic search (fire-and-forget).
          // Decoupled from the analysis pipeline so embedding latency doesn't block the next file.
          // On failure, re-enqueue with the cached LLM result so only embedding is retried.
          this._embedAnalyzedFile(filePath, result).catch((embedErr) => {
            logger.warn(
              '[SMART-FOLDER-WATCHER] Background embedding failed, re-queuing for retry',
              {
                filePath,
                error: embedErr.message
              }
            );
            const retryCount = (item.retryCount || 0) + 1;
            if (retryCount <= MAX_ANALYSIS_RETRIES) {
              this._enqueueAnalysisItem({
                ...item,
                retryCount,
                cachedAnalysis: result // Skip LLM, retry only embedding
              });
            } else {
              logger.error('[SMART-FOLDER-WATCHER] Embedding retries exhausted', {
                filePath,
                retryCount
              });
            }
          });
        } else if (isFallbackOnly) {
          logger.info('[SMART-FOLDER-WATCHER] Fallback-only result persisted without embedding', {
            filePath,
            extractionMethod: analysis_check.extractionMethod || null
          });
        }

        if (!isEmbeddingRetry) {
          // Record to analysis history so smart folder analysis appears in history
          {
            const analysis = result?.analysis || result || {};
            const keywords = Array.isArray(analysis.keywords)
              ? analysis.keywords
              : Array.isArray(analysis.tags)
                ? analysis.tags
                : [];

            const derivedConfidence = deriveWatcherConfidencePercent(analysis);
            const historyConfidence =
              typeof analysis.confidence === 'number' &&
              (analysis.confidence !== 0 || analysis.error)
                ? analysis.confidence
                : derivedConfidence;

            const isImage = isImagePath(filePath);
            // For content updates (file edited & saved in place), preserve the
            // existing smart-folder assignment instead of using the LLM's
            // re-categorization — the user intentionally placed the file here.
            let resolvedCategory = analysis.category || analysis.folder || 'uncategorized';
            let resolvedSmartFolderName = analysis.smartFolder || analysis.folder || null;

            if (isContentUpdate) {
              const learningService = getLearningFeedbackService();
              const containingFolder = /** @type {any} */ (
                learningService?.findContainingSmartFolder?.(filePath)
              );
              if (containingFolder) {
                resolvedCategory = containingFolder.name;
                resolvedSmartFolderName = containingFolder.name;
              }
            }

            const historyPayload = {
              // The history utility uses suggestedName as the subject fallback.
              // Prefer any naming-convention output; otherwise keep the original basename.
              suggestedName: analysis.suggestedName || path.basename(filePath),
              category: resolvedCategory,
              keywords,
              confidence: historyConfidence,
              summary: analysis.summary || analysis.description || '',
              extractedText: analysis.extractedText || null,
              smartFolder: resolvedSmartFolderName,
              model: analysis.model || result.model || (isImage ? 'vision' : 'llm'),
              // Extended fields for document/image conversations
              // CRITICAL: Use field names that match AnalysisHistoryServiceCore expectations
              documentType: analysis.type || null,
              entity: analysis.entity || null,
              project: analysis.project || null,
              purpose: analysis.purpose || null,
              reasoning: analysis.reasoning || null,
              documentDate: analysis.date || null,
              keyEntities: analysis.keyEntities || [],
              extractionMethod: analysis.extractionMethod || null,
              // Provenance (F-195): lets recordAnalysisResult stamp fallback-only
              // results provisional so the next scan can retry them once the
              // missing model is installed.
              _isFallback: analysis._isFallback === true || analysis.isFallback === true,
              fallbackReason: analysis.fallbackReason || null,
              // Image-specific fields
              content_type: isImage ? analysis.content_type || null : null,
              has_text: isImage ? Boolean(analysis.has_text) : null,
              colors: isImage && Array.isArray(analysis.colors) ? analysis.colors : null,
              // Media-specific fields (audio/video). analyzeMediaFile emits all
              // of these; without forwarding them the history entry loses the
              // transcript and AnalysisDetails shows empty Duration/Language.
              // recordAnalysisResult applies the same normalization caps as the
              // direct-analysis path.
              transcript: analysis.transcript || null,
              transcriptSegments: Array.isArray(analysis.transcriptSegments)
                ? analysis.transcriptSegments
                : null,
              durationSeconds:
                typeof analysis.durationSeconds === 'number' ? analysis.durationSeconds : null,
              detectedLanguage: analysis.detectedLanguage || null,
              keyframes: Array.isArray(analysis.keyframes) ? analysis.keyframes : null,
              mediaKind: analysis.mediaKind || null
            };

            await recordAnalysisResult({
              filePath,
              result: historyPayload,
              processingTime: Number(result.processingTimeMs || result.processingTime || 0),
              modelType: isImagePath(filePath) ? 'vision' : 'llm',
              analysisHistory: this.analysisHistoryService,
              logger
            });

            // This triggers a rebuild on the next search instead of waiting 15 minutes
            if (!this._isStopping) {
              try {
                const { getSearchServiceInstance } = require('../ipc/semantic');
                const searchService = getSearchServiceInstance?.();
                if (searchService?.invalidateIndex) {
                  searchService.invalidateIndex();
                  logger.debug('[SMART-FOLDER-WATCHER] Invalidated BM25 index for new analysis');
                }
              } catch (invalidateErr) {
                // Non-fatal - search will still work with stale index
                logger.debug(
                  '[SMART-FOLDER-WATCHER] Could not invalidate BM25 index:',
                  invalidateErr.message
                );
              }
            }
          }
        }

        // Update stats
        if (eventType === 'add') {
          this.stats.filesAnalyzed++;
        } else {
          this.stats.filesReanalyzed++;
        }

        logger.info('[SMART-FOLDER-WATCHER] Analysis complete:', filePath);

        getFileOperationTracker().recordOperation(filePath, 'analyze', 'smartFolderWatcher');

        // Send notification about the analyzed file
        const fileName = path.basename(filePath);
        const notificationAnalysis = result.analysis || result;
        const confidence = deriveWatcherConfidencePercent(notificationAnalysis);
        let confidenceThreshold = 75;

        try {
          const settings = await this.settingsService.load();
          confidenceThreshold = normalizeThresholdPercent(settings?.confidenceThreshold);
        } catch (settingsErr) {
          logger.debug(
            '[SMART-FOLDER-WATCHER] Could not load confidence threshold; using default:',
            settingsErr.message
          );
        }

        // Skip learning feedback for fallback-only or low-confidence analyses.
        // This prevents noisy fallback classification from polluting placement learning.
        if (!isEmbeddingRetry) {
          if (isFallbackOnly || confidence < confidenceThreshold) {
            logger.debug(
              '[SMART-FOLDER-WATCHER] Skipping learning feedback for non-actionable analysis',
              {
                fileName,
                extractionMethod: analysis?.extractionMethod || null,
                confidence,
                threshold: confidenceThreshold,
                reason: isFallbackOnly ? 'fallback_only' : 'low_confidence'
              }
            );
          } else {
            // Record implicit learning feedback - file in smart folder = positive signal
            await this._recordLearningFeedback(filePath, result);
          }
        }

        if (this.notificationService && !isEmbeddingRetry) {
          // Notify about file analysis
          await this.notificationService.notifyFileAnalyzed(fileName, 'smart_folder', {
            category: analysis.category || 'Unknown',
            confidence
          });

          // Check if confidence is below threshold for auto-organization
          if (confidence < confidenceThreshold) {
            await this.notificationService.notifyLowConfidence(
              fileName,
              confidence,
              confidenceThreshold,
              analysis.category || null,
              filePath
            );
          }
        }
      } else {
        logger.warn('[SMART-FOLDER-WATCHER] Analysis returned no result for:', filePath);
        this.stats.errors++;
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        logger.debug('[SMART-FOLDER-WATCHER] File no longer exists:', filePath);
      } else {
        logger.error('[SMART-FOLDER-WATCHER] Error analyzing file:', {
          filePath,
          error: error.message
        });
        this.stats.errors++;
        throw error;
      }
    } finally {
      this.processingFiles.delete(processingKey);
    }
  }

  /**
   * Embed an analyzed file into the vector DB for semantic search
   * This is called immediately after successful analysis to keep embeddings in sync
   * @private
   * @param {string} filePath - Path to the analyzed file
   * @param {any} analysisResult - Result from analyzeDocumentFile or analyzeImageFile
   */
  async _embedAnalyzedFile(filePath, analysisResult) {
    // Skip if watcher is stopping — prevents fire-and-forget embeddings after shutdown
    if (this._isStopping) {
      logger.debug('[SMART-FOLDER-WATCHER] Skipping embedding - watcher is stopping');
      return;
    }

    // Skip if dependencies not available
    if (!this.folderMatcher || !this.vectorDbService) {
      logger.debug('[SMART-FOLDER-WATCHER] Skipping embedding - services not available');
      return;
    }

    // Respect global embedding timing/policy. The watcher IS the analysis path,
    // so this is `stage: 'analysis'` (not 'final'). With the default timing of
    // 'during_analysis', only 'analysis' stage embeds are permitted.
    // If we have a persisted per-file override, apply it here.
    let policyOverride = null;
    try {
      const entry = await this.analysisHistoryService?.getAnalysisByPath?.(filePath);
      policyOverride = entry?.embedding?.policy || null;
    } catch {
      // Non-fatal
    }
    const gate = await shouldEmbed({ stage: 'analysis', policyOverride });
    if (!gate.shouldEmbed) {
      logger.debug('[SMART-FOLDER-WATCHER] Skipping embedding by policy/timing gate', {
        timing: gate.timing,
        policy: gate.policy,
        filePath
      });
      try {
        await this.analysisHistoryService?.updateEmbeddingStateByPath?.(filePath, {
          status: 'skipped'
        });
      } catch {
        // Non-fatal
      }
      return;
    }

    try {
      await fs.stat(filePath);
    } catch (statError) {
      if (isNotFoundError(statError)) {
        logger.debug('[SMART-FOLDER-WATCHER] File no longer exists, skipping embedding:', {
          filePath
        });
        return;
      }
      // For other stat errors, continue and let embedding logic handle it
    }

    // Documents: applyUnifiedFolderMatching already embeds and either enqueues or attaches vector.
    // Images: have a different embedding path (image analysis block), so we skip reuse for them.
    const precomputed =
      analysisResult._embeddingForPersistence || analysisResult.analysis?._embeddingForPersistence;
    if (precomputed && !isImagePath(filePath)) {
      const { vector, model, meta, wasEnqueued } = precomputed;
      if (vector && Array.isArray(vector) && vector.length > 0 && meta) {
        if (wasEnqueued) {
          // Document analysis enqueued to EmbeddingQueue; queue will persist the file-level vector.
          // We still handle chunk embeddings here so they are never skipped.
          logger.debug('[SMART-FOLDER-WATCHER] Reusing precomputed embedding (queued)', {
            filePath
          });
          try {
            await this.analysisHistoryService?.updateEmbeddingStateByPath?.(filePath, {
              status: 'pending',
              model: model || null
            });
          } catch {
            // Non-fatal
          }
          const fileId = getCanonicalFileId(filePath, false);
          await this._embedChunksForFile(fileId, filePath, analysisResult);
          return;
        }
        // wasEnqueued: false — policy skipped enqueue but we have the vector; use it for direct upsert
        const fileId = getCanonicalFileId(filePath, false);
        try {
          if (!this.vectorDbService) {
            logger.warn('[SMART-FOLDER-WATCHER] Skipping vector upsert — vector DB unavailable', {
              filePath
            });
            return;
          }
          await this.vectorDbService.upsertFile({
            id: fileId,
            vector,
            model: model || 'unknown',
            meta: { ...meta, path: filePath, name: path.basename(filePath) },
            updatedAt: new Date().toISOString()
          });
          logger.debug('[SMART-FOLDER-WATCHER] Reused precomputed embedding (direct upsert)', {
            filePath
          });
          try {
            await this.analysisHistoryService?.updateEmbeddingStateByPath?.(filePath, {
              status: 'done',
              model: model || null
            });
          } catch {
            // Non-fatal
          }
          await this._embedChunksForFile(fileId, filePath, analysisResult);
          return;
        } catch (upsertErr) {
          logger.warn(
            '[SMART-FOLDER-WATCHER] Precomputed embedding upsert failed, falling back to full flow',
            {
              filePath,
              error: upsertErr?.message
            }
          );
          // Fall through to normal embed+upsert
        }
      }
    }

    try {
      // Extract analysis data - handle different result structures
      const analysis = analysisResult.analysis || analysisResult;
      const fileExtension = path.extname(filePath).toLowerCase();
      const rawKeywords = (() => {
        if (Array.isArray(analysis.keywords)) return analysis.keywords;
        if (Array.isArray(analysis.tags)) return analysis.tags;
        if (typeof analysis.tags === 'string' && analysis.tags.trim().length > 0) {
          try {
            const parsed = JSON.parse(analysis.tags);
            if (Array.isArray(parsed)) return parsed;
          } catch {
            // Fall back to comma-separated list
          }
          return analysis.tags.split(',').map((/** @type {any} */ entry) => entry.trim());
        }
        return [];
      })();
      const keywords = normalizeKeywords(rawKeywords);
      const summary = analysis.summary || analysis.description || analysis.purpose || '';
      const learningService = getLearningFeedbackService();
      const resolvedSmartFolder =
        /** @type {any} */ (learningService?.findContainingSmartFolder?.(filePath)) || null;
      const category = resolvedSmartFolder?.name || analysis.category || 'Uncategorized';
      const subject =
        analysis.subject || analysis.suggestedName || analysis.project || analysis.entity || '';
      const rawConfidence = analysis.confidence ?? analysisResult.confidence ?? 0;
      const confidence =
        typeof rawConfidence === 'number'
          ? rawConfidence > 1
            ? Math.round(rawConfidence)
            : Math.round(rawConfidence * 100)
          : 0;

      const purpose = analysis.purpose || '';
      const entity = analysis.entity || '';
      const project = analysis.project || '';
      const rawType = typeof analysis.type === 'string' ? analysis.type.trim() : '';
      const isGenericType = ['image', 'document', 'file', 'unknown'].includes(
        rawType.toLowerCase()
      );
      const documentType = analysis.documentType || (!isGenericType && rawType ? rawType : '');
      const documentDate = analysis.documentDate || analysis.date || null;
      const extractedText =
        typeof analysis.extractedText === 'string' ? analysis.extractedText : '';
      const isImage = isImagePath(filePath);
      const analysisForEmbedding = {
        ...analysis,
        keywords,
        subject,
        documentType,
        documentDate
      };

      // Same budget as the analysis route, so a watcher-ingested file embeds
      // the same text a Discover-analyzed one does (F-191 / CP-11).
      const embeddingSummary = buildEmbeddingSummary(
        analysisForEmbedding,
        extractedText,
        fileExtension,
        isImage ? 'image' : 'document',
        await resolveEmbeddingModelOptions()
      );
      const textToEmbed = embeddingSummary.text;

      // Skip if no meaningful content to embed
      if (!textToEmbed || !textToEmbed.trim()) {
        logger.debug('[SMART-FOLDER-WATCHER] Skipping embedding - no content:', filePath);
        return;
      }
      const embedding = await this.folderMatcher.embedText(textToEmbed);

      // This ensures the file is retried later instead of being marked as done
      if (!embedding || !embedding.vector || !Array.isArray(embedding.vector)) {
        throw new Error('Failed to generate embedding vector');
      }

      // Prepare metadata for vector DB
      // IMPORTANT: IDs must match the rest of the semantic pipeline.
      const fileId = getCanonicalFileId(filePath, isImagePath(filePath));
      const fileName = path.basename(filePath);

      // Build metadata object - shared for documents and images
      /** @type {Record<string, any>} */
      const baseMeta = {
        path: filePath,
        name: fileName,
        category,
        subject,
        summary: summary.substring(0, 2000), // Increased limit for richer context
        purpose: purpose.substring(0, 1000),
        tags: keywords.slice(0, 15),
        keywords: keywords.slice(0, 15),
        type: isImage ? 'image' : 'document',
        confidence,
        // Additional fields for document/image conversations
        entity: entity.substring(0, 255),
        project: project.substring(0, 255),
        documentType: documentType.substring(0, 100),
        reasoning: (analysis.reasoning || '').substring(0, 500),
        // Store truncated extracted text for conversation context
        extractedText: extractedText.substring(0, 5000),
        extractionMethod: analysis.extractionMethod || 'unknown',
        // Document date for time-based queries
        date: documentDate,
        smartFolder: resolvedSmartFolder?.name || null,
        smartFolderPath: resolvedSmartFolder?.path || null
      };

      // Add image-specific metadata for richer image conversations
      if (isImage) {
        baseMeta.content_type = analysis.content_type || 'unknown';
        baseMeta.has_text = Boolean(analysis.has_text);
        if (Array.isArray(analysis.colors) && analysis.colors.length > 0) {
          baseMeta.colors = JSON.stringify(analysis.colors.slice(0, 10));
        }
      }

      // Upsert to vector DB with comprehensive metadata for conversations
      if (!this.vectorDbService) {
        logger.warn('[SMART-FOLDER-WATCHER] Skipping vector upsert — vector DB unavailable', {
          filePath
        });
        return;
      }
      await this.vectorDbService.upsertFile({
        id: fileId,
        vector: embedding.vector,
        model: embedding.model || 'unknown',
        meta: baseMeta,
        updatedAt: new Date().toISOString()
      });

      logger.debug('[SMART-FOLDER-WATCHER] Embedded file:', filePath);

      // Persist done state (direct upsert).
      try {
        await this.analysisHistoryService?.updateEmbeddingStateByPath?.(filePath, {
          status: 'done',
          model: embedding.model || null
        });
      } catch {
        // Non-fatal
      }

      await this._embedChunksForFile(fileId, filePath, analysisResult);
    } catch (error) {
      logger.warn('[SMART-FOLDER-WATCHER] Failed to embed file:', {
        filePath,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Generate and persist chunk embeddings for a single file.
   *
   * Atomicity guarantee: all chunk vectors are computed BEFORE any old chunks are
   * deleted. If embedding fails mid-batch the previous chunks remain intact and the
   * file stays searchable at chunk level until the next successful reanalysis.
   *
   * @private
   * @param {string} fileId - Canonical file ID for the vector DB
   * @param {string} filePath - Absolute path to the file on disk
   * @param {any} analysisResult - Raw result from analyzeDocumentFile / analyzeImageFile
   */
  async _embedChunksForFile(fileId, filePath, analysisResult) {
    const analysis = analysisResult.analysis || analysisResult;
    // Shared with Discover and Downloads (chunkEmbedding.js): one gate, one
    // payload shape, and old chunks replaced only once new ones exist.
    await embedFileChunks({
      fileId,
      filePath,
      extractedText: analysis.extractedText,
      embedText: (text) => this.folderMatcher.embedText(text),
      vectorDb: this.vectorDbService,
      loadSettings: () => this.settingsService.load()
    });
  }

  /**
   * Record learning feedback for a file in a smart folder
   * This teaches the system that files like this belong in this folder
   * @private
   * @param {string} filePath - Path to the analyzed file
   * @param {any} analysisResult - Analysis result
   */
  async _recordLearningFeedback(filePath, analysisResult) {
    try {
      const learningService = getLearningFeedbackService();
      if (!learningService) {
        // Service not initialized yet - skip silently
        return;
      }

      // Find which smart folder this file is in
      const smartFolder = /** @type {any} */ (learningService.findContainingSmartFolder(filePath));
      if (!smartFolder) {
        // Not in a smart folder - shouldn't happen but guard anyway
        return;
      }

      // Extract analysis data
      const analysis = analysisResult?.analysis || analysisResult || {};
      const extractionMethod = String(analysis?.extractionMethod || '').toLowerCase();

      // Defensive guard: never learn from fallback/no-content analyses.
      if (
        analysis?._isFallback ||
        extractionMethod === 'pdf_no_text' ||
        extractionMethod === 'failed' ||
        extractionMethod === 'filename' ||
        extractionMethod.includes('fallback')
      ) {
        return;
      }

      // Record the implicit feedback
      await learningService.recordFilePlacement({
        filePath,
        smartFolder,
        analysis,
        source: FEEDBACK_SOURCES.WATCHER_DETECTION
      });

      logger.debug('[SMART-FOLDER-WATCHER] Recorded learning feedback:', {
        file: path.basename(filePath),
        folder: smartFolder.name
      });
    } catch (error) {
      // Non-fatal - learning failure shouldn't block analysis
      logger.debug('[SMART-FOLDER-WATCHER] Learning feedback failed:', error.message);
    }
  }

  /**
   * Handle file deletion events from the watcher
   * Removes embeddings and analysis history for externally deleted files
   * FIX: Prevents ghost entries when files are deleted via File Explorer
   * @private
   * @param {string} filePath - Path to the deleted file
   */
  async _handleFileDeletion(filePath) {
    // Skip temp files
    if (isTemporaryFile(filePath)) {
      logger.debug('[SMART-FOLDER-WATCHER] Skipping temp file deletion:', filePath);
      return;
    }

    logger.info('[SMART-FOLDER-WATCHER] Detected external file deletion:', filePath);

    try {
      const deferred = await this._deferDeletionForMove(filePath);
      if (deferred) {
        return;
      }
    } catch (deferError) {
      logger.debug(
        '[SMART-FOLDER-WATCHER] Move detection setup failed, deleting immediately:',
        deferError.message
      );
    }

    await this._finalizeDeletion(filePath);
  }

  /**
   * Defer deletion briefly to detect move/rename events.
   *
   * FIX: Store baseName for disambiguation when multiple candidates exist.
   *
   * @private
   * @returns {Promise<boolean>} True if deletion was deferred
   */
  async _deferDeletionForMove(/** @type {any} */ filePath) {
    if (!this.analysisHistoryService?.getAnalysisByPath) {
      return false;
    }

    const entry = await this.analysisHistoryService.getAnalysisByPath(filePath);

    // Parse persisted metadata strictly to avoid false-positive move matches from malformed values.
    const parsedSize = Number(entry?.fileSize);
    const parseLastModified = (/** @type {any} */ value) => {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!trimmed) return null;

      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) return numeric;

      const parsedDate = Date.parse(trimmed);
      return Number.isFinite(parsedDate) ? parsedDate : null;
    };
    const parsedLastModified = parseLastModified(entry?.lastModified);

    if (!entry || !Number.isFinite(parsedSize) || !Number.isFinite(parsedLastModified)) {
      return false;
    }

    // Replace any existing candidate for the same path
    const existing = this._pendingMoveCandidates.get(filePath);
    if (existing?.timeoutId) {
      clearTimeout(existing.timeoutId);
    }

    /** @type {Record<string, any>} */
    const candidate = {
      oldPath: filePath,
      size: parsedSize,
      mtimeMs: parsedLastModified,
      ext: path.extname(filePath).toLowerCase(),
      baseName: path.basename(filePath),
      createdAt: Date.now(),
      timeoutId: null
    };

    candidate.timeoutId = setTimeout(() => {
      this._pendingMoveCandidates.delete(filePath);
      this._finalizeDeletion(filePath).catch((err) => {
        logger.warn('[SMART-FOLDER-WATCHER] Deferred deletion failed:', err.message);
      });
    }, this._moveDetectionWindowMs);

    if (candidate.timeoutId && typeof candidate.timeoutId.unref === 'function') {
      candidate.timeoutId.unref();
    }

    // Bound the move candidates map to prevent unbounded growth during mass deletions.
    // 500 accommodates bulk operations (large folder reorganization) while still
    // capping memory. Evict by oldest createdAt rather than insertion order.
    const MAX_PENDING_MOVES = 500;
    if (this._pendingMoveCandidates.size >= MAX_PENDING_MOVES) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [key, val] of this._pendingMoveCandidates) {
        const createdAt = val?.createdAt || 0;
        if (createdAt < oldestTime) {
          oldestTime = createdAt;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        const oldest = this._pendingMoveCandidates.get(oldestKey);
        if (oldest?.timeoutId) clearTimeout(oldest.timeoutId);
        this._pendingMoveCandidates.delete(oldestKey);
        logger.debug('[SMART-FOLDER-WATCHER] Evicted oldest pending move candidate due to limit', {
          evicted: path.basename(oldestKey)
        });
      }
    }

    this._pendingMoveCandidates.set(filePath, candidate);

    logger.debug('[SMART-FOLDER-WATCHER] Deferring deletion to detect move', {
      file: path.basename(filePath),
      windowMs: this._moveDetectionWindowMs
    });

    return true;
  }

  /**
   * Finalize deletion cleanup for a removed file.
   * @private
   */
  async _finalizeDeletion(/** @type {any} */ filePath) {
    try {
      // Remove from vector DB (both file: and image: prefixes)
      if (this.vectorDbService) {
        const filePrefix = getCanonicalFileId(filePath, false);
        const imagePrefix = getCanonicalFileId(filePath, true);
        const legacyFilePrefix = `file:${filePath}`;
        const legacyImagePrefix = `image:${filePath}`;
        const idsToDelete =
          filePrefix === `file:${filePath}`
            ? [filePrefix, imagePrefix]
            : [filePrefix, imagePrefix, legacyFilePrefix, legacyImagePrefix];

        // Use batch delete for atomicity when available
        if (typeof this.vectorDbService.batchDeleteFileEmbeddings === 'function') {
          await this.vectorDbService.batchDeleteFileEmbeddings(idsToDelete);
        } else {
          // Fallback to individual deletes
          for (const id of idsToDelete) {
            try {
              await this.vectorDbService.deleteFileEmbedding(id);
            } catch (delErr) {
              logger.debug(
                '[SMART-FOLDER-WATCHER] Failed to delete embedding:',
                id,
                delErr.message
              );
              // Continue with remaining IDs
            }
          }
        }

        // Delete associated chunks
        if (typeof this.vectorDbService.deleteFileChunks === 'function') {
          for (const id of idsToDelete) {
            try {
              await this.vectorDbService.deleteFileChunks(id);
            } catch (chunkErr) {
              logger.debug('[SMART-FOLDER-WATCHER] Failed to delete chunks:', id, chunkErr.message);
              // Continue with remaining IDs
            }
          }
        }

        logger.debug('[SMART-FOLDER-WATCHER] Removed embeddings for deleted file:', filePath);
      }

      // Remove from analysis history
      if (this.analysisHistoryService?.removeEntriesByPath) {
        try {
          await this.analysisHistoryService.removeEntriesByPath(filePath);
          logger.debug('[SMART-FOLDER-WATCHER] Removed history for deleted file:', filePath);
        } catch (historyErr) {
          logger.debug(
            '[SMART-FOLDER-WATCHER] Failed to remove history:',
            filePath,
            historyErr.message
          );
          // Continue with remaining cleanup
        }
      }

      // Invalidate BM25 search index
      if (!this._isStopping) {
        try {
          const { getSearchServiceInstance } = require('../ipc/semantic');
          const searchService = getSearchServiceInstance?.();
          if (searchService?.invalidateIndex) {
            searchService.invalidateIndex({ reason: 'external-deletion', oldPath: filePath });
          }
        } catch (indexErr) {
          logger.debug(
            '[SMART-FOLDER-WATCHER] Could not invalidate search index:',
            indexErr.message
          );
        }
      }

      this.stats.lastActivity = new Date().toISOString();
    } catch (error) {
      logger.warn(
        '[SMART-FOLDER-WATCHER] Error cleaning up deleted file:',
        filePath,
        error.message
      );
      this.stats.errors++;
    }
  }

  /**
   * Reconcile orphaned entries on startup.
   *
   * When the watcher is stopped (e.g. app closed), files may be deleted or
   * moved out of smart folders externally. On next startup, this sweep checks
   * analysis history for files within watched smart folders that no longer
   * exist on disk and cleans up their embeddings, chunks, and history.
   *
   * Runs in the background with yielding so it never blocks the main thread
   * or delays normal watcher operation.
   * @private
   */
  async _reconcileOrphanedEntries() {
    // Let the system settle after startup before sweeping
    await delay(5000);

    if (this._isStopping || !this.isRunning) return;

    const entries = this.analysisHistoryService?.analysisHistory?.entries;
    if (!entries || typeof entries !== 'object') {
      logger.debug('[SMART-FOLDER-WATCHER] Reconciliation skipped — no history entries available');
      return;
    }

    // Snapshot the entries to avoid mutation during iteration
    const allEntries = Object.values(entries);
    let checked = 0;
    let removed = 0;

    for (const entry of allEntries) {
      if (this._isStopping) break;

      // Resolve the file's current path (actual if moved, otherwise original)
      const filePath = entry?.organization?.actual || entry?.originalPath;
      if (!filePath) continue;

      // Only reconcile files within watched smart folders
      if (!this._isInWatchedPath(filePath)) continue;

      checked++;

      try {
        await fs.access(filePath);
      } catch {
        // File no longer exists — clean up embeddings, chunks, and history
        try {
          await this._finalizeDeletion(filePath);
          removed++;
          logger.debug('[SMART-FOLDER-WATCHER] Reconciled orphaned entry:', {
            file: path.basename(filePath)
          });
        } catch (cleanupErr) {
          logger.debug('[SMART-FOLDER-WATCHER] Reconciliation cleanup failed:', {
            file: path.basename(filePath),
            error: cleanupErr.message
          });
        }
      }

      // Yield every 50 files to avoid blocking the event loop
      if (checked % 50 === 0) {
        await delay(100);
      }
    }

    // Reap orphan-marked vectors that have stayed missing for a sustained
    // period (F-222 / D5). Inline marking (F-187) never deletes; this is the
    // only place a long-gone file's knowledge is finally removed.
    try {
      await this._reapStaleOrphans();
    } catch (reapErr) {
      logger.debug('[SMART-FOLDER-WATCHER] Orphan reap failed', {
        error: /** @type {any} */ (reapErr)?.message
      });
    }

    if (removed > 0) {
      this.stats.orphansReconciled += removed;
      this.stats.lastActivity = new Date().toISOString();
      logger.info('[SMART-FOLDER-WATCHER] Startup reconciliation complete', { checked, removed });
    } else {
      logger.debug('[SMART-FOLDER-WATCHER] Startup reconciliation — no orphans found', {
        checked
      });
    }
  }

  /**
   * Remove the knowledge of files that have been orphan-marked for at least
   * ORPHAN_REAP_AGE_MS and are STILL missing; anything that reappeared is
   * left for the startup repair to restore (F-221). Never throws.
   * @private
   * @returns {Promise<{ reaped: number, kept: number, skipped: number }>}
   */
  async _reapStaleOrphans() {
    const summary = { reaped: 0, kept: 0, skipped: 0 };
    const store = this.vectorDbService;
    if (!store || typeof store.getOrphanedFileDocs !== 'function') return summary;

    let docs;
    try {
      docs = await store.getOrphanedFileDocs(ORPHAN_REAP_AGE_MS);
    } catch (err) {
      logger.debug('[SMART-FOLDER-WATCHER] Could not list orphaned vectors', {
        error: /** @type {any} */ (err)?.message
      });
      return summary;
    }

    for (const doc of Array.isArray(docs) ? docs : []) {
      if (this._isStopping) break;
      const filePath = doc?.path;
      if (typeof filePath !== 'string' || !filePath) {
        summary.skipped++;
        continue;
      }
      let stillMissing = false;
      try {
        await fs.stat(filePath);
      } catch {
        stillMissing = true;
      }
      if (!stillMissing) {
        summary.kept++;
        continue;
      }
      try {
        await this._finalizeDeletion(filePath);
        summary.reaped++;
      } catch (err) {
        logger.debug('[SMART-FOLDER-WATCHER] Orphan reap failed for file', {
          file: path.basename(filePath),
          error: /** @type {any} */ (err)?.message
        });
        summary.skipped++;
      }
    }

    if (summary.reaped > 0) {
      logger.info('[SMART-FOLDER-WATCHER] Reaped long-orphaned knowledge', summary);
    }
    return summary;
  }

  /**
   * Handle watcher errors
   * @private
   */
  _handleError(/** @type {any} */ error) {
    const fsError = error.isFileSystemError ? error : new WatcherError('smart-folders', error);

    logger.error('[SMART-FOLDER-WATCHER] Watcher error:', {
      message: fsError.getUserFriendlyMessage?.() || error.message,
      code: fsError.code
    });

    this.stats.errors++;
    this.lastError = fsError;

    // Recoverable errors trigger an automatic restart. Without this, an
    // OS-level inotify slot exhaustion / USN journal failure leaves the
    // watcher reporting isRunning=true but silently deaf — files copied
    // into a smart folder are never picked up.
    const shouldRetry = typeof fsError.shouldRetry === 'function' ? fsError.shouldRetry() : true;
    if (
      shouldRetry &&
      this.restartAttempts < this.maxRestartAttempts &&
      !this._isStopping &&
      !this._shutdownRequested
    ) {
      this.restartAttempts += 1;
      logger.info(
        `[SMART-FOLDER-WATCHER] Attempting restart (${this.restartAttempts}/${this.maxRestartAttempts})`
      );
      this.stop()
        .then(
          /** @returns {any} */ () => {
            this.restartTimer = setTimeout(() => {
              this.restartTimer = null;
              if (this._shutdownRequested || this._isStopping || this.watcher) return;
              this.start().catch((e) => {
                logger.error('[SMART-FOLDER-WATCHER] Restart failed:', e?.message);
              });
            }, this.restartDelay * this.restartAttempts);
            this.restartTimer?.unref?.();
            return undefined;
          }
        )
        .catch((stopErr) => {
          logger.error('[SMART-FOLDER-WATCHER] Failed to stop before restart:', stopErr?.message);
        });
    } else if (this.restartAttempts >= this.maxRestartAttempts) {
      logger.error('[SMART-FOLDER-WATCHER] Max restart attempts reached. Watcher disabled.');
      // Smart folders are now silently un-watched: copies into them stop
      // triggering analysis, but isRunning will be false after stop()
      // completes — there's no in-app cue. Raise the banner so the user
      // sees the disable explicitly and can address the underlying error
      // (typically OS-level inotify exhaustion or USN journal slot).
      _maybeRaiseWatcherUnavailable(fsError);
      this.stop().catch((e) => {
        logger.error('[SMART-FOLDER-WATCHER] Stop failed:', e?.message);
      });
    }
  }

  /**
   * Get current status
   * @returns {any} Status information
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      isStarting: this.isStarting,
      watchedFolders: [...this.watchedPaths],
      watchedCount: this.watchedPaths.size,
      queueLength: this.analysisQueue.length,
      processingCount: this.processingFiles.size,
      pendingReanalyzeCount: this._pendingReanalyzeItems.length,
      parkedCount: this._parkedItems.length,
      stats: { ...this.stats },
      lastStartError: this._lastStartError || null
    };
  }

  /**
   * Manually trigger a scan of all smart folders for unanalyzed files
   * @returns {Promise<{scanned: number, queued: number}>}
   */
  async scanForUnanalyzedFiles() {
    logger.info('[SMART-FOLDER-WATCHER] Scanning for unanalyzed files...');

    let scanned = 0;
    let queued = 0;

    for (const folderPath of this.watchedPaths) {
      const result = await this.scanFolderForUnanalyzedFiles(folderPath);
      scanned += result.scanned;
      queued += result.queued;
    }

    logger.info('[SMART-FOLDER-WATCHER] Scan complete:', { scanned, queued });
    return { scanned, queued };
  }

  /**
   * Scan ONE folder and queue the files that still need analysis (new,
   * changed, or never embedded — `_needsAnalysis` decides). Used for every
   * watched folder at startup and for a folder the user just added while the
   * app is running (F-194 / K-05), so a folder is never "watched" without its
   * existing contents being picked up. Never throws: an unreadable folder
   * reports zero.
   * @param {string} folderPath
   * @returns {Promise<{scanned: number, queued: number}>}
   */
  async scanFolderForUnanalyzedFiles(folderPath) {
    let scanned = 0;
    let queued = 0;
    /** @type {Set<string> | null} built on first overflow, then reused */
    let overflowKeys = null;
    try {
      const files = await this._scanDirectory(folderPath);
      scanned = files.length;

      for (const file of files) {
        if (this._isStopping) break;
        let stats;
        try {
          stats = await fs.stat(file);
        } catch (statErr) {
          // Deleted or locked since the directory listing: skip this file,
          // not the rest of the folder.
          logger.debug('[SMART-FOLDER-WATCHER] Scan skipped unreadable file', {
            file,
            error: /** @type {any} */ (statErr)?.message
          });
          continue;
        }
        const mtime = new Date(stats.mtime).getTime();
        const needsAnalysis = await this._needsAnalysis(file, mtime, stats);
        if (!needsAnalysis) continue;

        const item = { filePath: file, mtime, eventType: 'scan', queuedAt: Date.now() };
        if (this._isStopping) break;
        if (this.analysisQueue.length < MAX_ANALYSIS_QUEUE_SIZE) {
          this._enqueueAnalysisItem(item);
          queued++;
          continue;
        }
        // Queue full: spill into the overflow buffer the queue drains after
        // every cycle. _enqueueAnalysisItem would instead evict the oldest
        // entry, so adding a 5,000-file folder kept only the last 1,000
        // (and raised a "High Load" toast for the rest).
        if (!overflowKeys) {
          overflowKeys = new Set(
            [...this.analysisQueue, ...this._pendingReanalyzeItems].map((q) =>
              this._queueItemKey(q)
            )
          );
        }
        const key = this._queueItemKey(item);
        if (overflowKeys.has(key)) continue;
        overflowKeys.add(key);
        this._pendingReanalyzeItems.push({ ...item, dedupKey: key });
        queued++;
      }
      if (overflowKeys) this._scheduleQueuePersist();
    } catch (error) {
      logger.warn('[SMART-FOLDER-WATCHER] Error scanning folder:', {
        folderPath,
        error: /** @type {any} */ (error)?.message
      });
    }
    return { scanned, queued };
  }

  /**
   * Preview reanalysis scope without enqueueing work.
   * @returns {Promise<{scanned: number, watchedFolders: number, outsideWatched: number}>}
   */
  async previewReanalyzeAll() {
    let scanned = 0;
    for (const folderPath of this.watchedPaths) {
      try {
        const files = await this._scanDirectory(folderPath);
        scanned += files.length;
      } catch (error) {
        logger.warn('[SMART-FOLDER-WATCHER] Preview scan failed:', {
          folderPath,
          error: error.message
        });
      }
    }

    // Same scope as the real run (F-223): analyzed files outside every
    // watched folder that still exist are part of "every file".
    const outsideWatched = (await this._collectAnalyzedFilesOutsideWatchedPaths()).length;
    scanned += outsideWatched;

    return { scanned, watchedFolders: this.watchedPaths.size, outsideWatched };
  }

  /**
   * History entries whose current path is outside every watched folder and
   * still exists on disk, deduped by canonical path. Used by reanalyze-all
   * (queue + preview) so the knowledge layer covers everything ever
   * analyzed, not just the folders currently watched (F-223 / D8).
   *
   * Excluded files are filtered here rather than at the queue, because this
   * is the one function both the preview and the real run read: the
   * "will reanalyze N files" number and the work that actually happens come
   * out of the same list. (The watched-folder leg gets the same treatment
   * from `_scanDirectory`.)
   * @private
   * @returns {Promise<Array<{ filePath: string, mtime: number }>>}
   */
  async _collectAnalyzedFilesOutsideWatchedPaths() {
    const entries = this.analysisHistoryService?.analysisHistory?.entries;
    if (!entries || typeof entries !== 'object') return [];

    /** @type {Array<{ filePath: string, mtime: number }>} */
    const found = [];
    const seen = new Set();
    for (const entry of Object.values(entries)) {
      if (this._isStopping) break;
      const filePath = entry?.organization?.actual || entry?.originalPath;
      if (typeof filePath !== 'string' || !filePath) continue;
      if (this._isInWatchedPath(filePath)) continue;
      const excludedBy = this._matchUserExclusion(filePath);
      if (excludedBy) {
        logger.debug('[SMART-FOLDER-WATCHER] Reanalyze-all skipping excluded history entry:', {
          filePath,
          pattern: excludedBy
        });
        continue;
      }
      const key = normalizePathForIndex(filePath) || filePath;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const stats = await fs.stat(filePath);
        if (typeof stats?.isDirectory === 'function' && stats.isDirectory()) continue;
        found.push({ filePath, mtime: new Date(stats.mtime).getTime() });
      } catch {
        // Gone (or unreadable): nothing to reanalyze; the reconcile owns cleanup.
      }
    }
    return found;
  }

  _isInWatchedPath(/** @type {any} */ filePath) {
    if (!filePath || this.watchedPaths.size === 0) return false;
    const normalizedPath = normalizePathForIndex(filePath);
    if (!normalizedPath) return false;

    for (const folderPath of this.watchedPaths) {
      const normalizedFolder = normalizePathForIndex(folderPath);
      if (!normalizedFolder) continue;
      const prefix = normalizedFolder.endsWith('/') ? normalizedFolder : `${normalizedFolder}/`;
      if (normalizedPath.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Resolve the smart folder id whose configured path contains `filePath`,
   * if any. Returns null when no folder owns the file. Used to thread
   * `smartFolderId` into the analysis pipeline so per-folder AI provider
   * overrides (settings.routing.perFolder[folderId], honored by AIRouter)
   * actually fire on watcher-driven analysis.
   *
   * Initial classification (drag-drop, single-file IPC) intentionally does
   * NOT use this helper because the destination folder is the *output* of
   * analysis, not the input. The override applies once the file is already
   * pinned to a folder and the watcher re-analyzes it.
   */
  _resolveFolderIdForPath(/** @type {any} */ filePath) {
    if (typeof filePath !== 'string' || !filePath) return null;
    const folders = this.getSmartFolders?.() || [];
    if (!Array.isArray(folders) || folders.length === 0) return null;
    const normalizedPath = normalizePathForIndex(filePath);
    if (!normalizedPath) return null;

    let bestMatch = null;
    let bestPrefixLength = -1;
    for (const folder of folders) {
      if (!folder?.id || !folder?.path) continue;
      const normalizedFolder = normalizePathForIndex(folder.path);
      if (!normalizedFolder) continue;
      const prefix = normalizedFolder.endsWith('/') ? normalizedFolder : `${normalizedFolder}/`;
      if (normalizedPath.startsWith(prefix) && prefix.length > bestPrefixLength) {
        bestMatch = folder.id;
        bestPrefixLength = prefix.length;
      }
    }
    return bestMatch;
  }

  /**
   * Queue a single file for reanalysis.
   * @param {string} filePath
   * @param {any} [options]
   * @returns {Promise<any>}
   */
  async reanalyzeFile(filePath, /** @type {any} */ options = {}) {
    if (!filePath) {
      return { queued: false, error: 'filePath is required', errorCode: 'MISSING_FILE_PATH' };
    }

    if (!options.force && !this._isInWatchedPath(filePath)) {
      return {
        queued: false,
        error: 'File is not inside a watched smart folder',
        errorCode: 'NOT_IN_SMART_FOLDER'
      };
    }

    const stats = await fs.stat(filePath);
    const mtime = stats?.mtime ? new Date(stats.mtime).getTime() : Date.now();

    this._enqueueAnalysisItem({
      filePath,
      mtime,
      eventType: 'reanalyze',
      applyNaming: options.applyNaming,
      queuedAt: Date.now()
    });

    logger.info('[SMART-FOLDER-WATCHER] Queued single file for reanalysis', {
      filePath
    });

    return { queued: true };
  }

  /**
   * Force reanalysis of ALL files in smart folders, regardless of existing analysis.
   * Use this when changing AI models to regenerate all analysis with the new model.
   * @returns {Promise<{scanned: number, queued: number}>}
   */
  async forceReanalyzeAll(/** @type {any} */ options = {}) {
    if (this._isStopping) {
      logger.debug('[SMART-FOLDER-WATCHER] Skipping forceReanalyzeAll — watcher is stopping');
      return { scanned: 0, queued: 0 };
    }

    logger.info('[SMART-FOLDER-WATCHER] Force reanalyzing ALL files...', {
      applyNaming: options.applyNaming
    });

    // Reset circuit breakers so prior failures don't block bulk reanalysis
    for (const modelType of ['text', 'vision', 'embedding']) {
      resetLlamaCircuit(modelType);
    }

    // Reset folder matching caches so the reanalysis re-embeds and upserts
    // every file instead of reusing cached vectors. The vector DB is NOT
    // cleared first (D5: replacements are written over the old rows).
    try {
      if (this.folderMatcher?.resetForReanalysis) {
        this.folderMatcher.resetForReanalysis();
      }
      clearSmartFolderUpsertCache(this.folderMatcher);
    } catch (cacheErr) {
      logger.debug('[SMART-FOLDER-WATCHER] Could not reset folder matcher:', cacheErr?.message);
    }

    // Phase 1: Collect all items up front so we can sort before touching the queue.
    const allItems = [];
    let scanned = 0;

    for (const folderPath of this.watchedPaths) {
      try {
        const files = await this._scanDirectory(folderPath);
        scanned += files.length;

        for (const file of files) {
          try {
            const stats = await fs.stat(file);
            const mtime = new Date(stats.mtime).getTime();
            allItems.push({
              filePath: file,
              mtime,
              eventType: 'reanalyze',
              bulk: true,
              queuedAt: Date.now(),
              applyNaming: options.applyNaming
            });
          } catch (fileErr) {
            logger.debug('[SMART-FOLDER-WATCHER] Cannot stat file:', {
              file,
              error: fileErr.message
            });
          }
        }
      } catch (error) {
        logger.warn('[SMART-FOLDER-WATCHER] Error scanning folder:', {
          folderPath,
          error: error.message
        });
      }
    }

    // Phase 1b: everything the app ever analyzed that lives OUTSIDE the
    // watched folders and still exists on disk (Discover-analyzed files,
    // files organized into non-smart folders). Without this "reanalyze all"
    // silently meant "reanalyze what is inside a smart folder right now"
    // (F-223 / K-01 scope, decision D8).
    const outside = await this._collectAnalyzedFilesOutsideWatchedPaths();
    scanned += outside.length;
    for (const { filePath, mtime } of outside) {
      allItems.push({
        filePath,
        mtime,
        eventType: 'reanalyze',
        // Same flag as the watched-folder leg above: these are part of a
        // bulk run, not a hand-picked file, so _analyzeFile's gate must
        // check them against the exclusion rules. Without it a rule added
        // between this collection and the analysis (or one the collector
        // could not read) would be skipped for exactly these files.
        bulk: true,
        queuedAt: Date.now(),
        applyNaming: options.applyNaming
      });
    }

    // Phase 2: Sort docs before images to eliminate text↔vision model thrashing.
    allItems.sort((a, b) => {
      const aImg = isImagePath(a.filePath) ? 1 : 0;
      const bImg = isImagePath(b.filePath) ? 1 : 0;
      return aImg - bImg;
    });

    // Phase 3: Fill the main queue up to capacity, put the rest in the overflow buffer.
    // The overflow buffer is drained into the queue at the end of each _processQueue cycle,
    // so all files are guaranteed to be processed regardless of collection size.
    this._pendingReanalyzeItems = []; // Clear any stale overflow from a prior run
    const capacity = MAX_ANALYSIS_QUEUE_SIZE - this.analysisQueue.length;
    const immediate = allItems.slice(0, Math.max(0, capacity));
    const overflow = allItems.slice(Math.max(0, capacity));

    for (const item of immediate) {
      this.analysisQueue.push(item);
    }
    this._pendingReanalyzeItems = overflow;

    const queued = allItems.length;

    logger.info('[SMART-FOLDER-WATCHER] Force reanalyze queued:', {
      scanned,
      queued,
      immediate: immediate.length,
      overflow: overflow.length
    });
    // K-07: the immediate + overflow items bypass _enqueueAnalysisItem, so
    // persist explicitly — a bulk reanalysis is exactly the case where an
    // interrupted run used to lose everything.
    this._scheduleQueuePersist();
    return { scanned, queued };
  }

  /**
   * Recursively scan a directory for processable files.
   *
   * Defaults to `this.watcherDepth` so manual scans match the chokidar
   * live-watcher's reach. The manual default used to be hard-coded at 10
   * regardless of watcherDepth — a drift that produced the "I see this
   * file in the index after a rescan but not when I drop a new copy in"
   * bug class. Pass an explicit `maxDepth` only when a caller needs a
   * different bound.
   * @private
   * @returns {Promise<any[]>}
   */
  async _scanDirectory(/** @type {any} */ dirPath, maxDepth = this.watcherDepth, currentDepth = 0) {
    if (currentDepth >= maxDepth) return [];

    /** @type {any[]} */
    const files = [];

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        // Skip hidden files/folders
        if (entry.name.startsWith('.')) continue;

        // Containment: never follow symlinks. A link inside a smart folder
        // pointing outside the watch root would pull foreign files into
        // auto-analysis/indexing (matches folderScanner.js policy; the live
        // chokidar watcher sets followSymlinks: false for the same reason).
        if (entry.isSymbolicLink()) continue;

        if (entry.isDirectory()) {
          // Skip system directories
          if (entry.name === 'node_modules' || entry.name === '.git') continue;

          const subFiles = await this._scanDirectory(fullPath, maxDepth, currentDepth + 1);
          files.push(...subFiles);
        } else if (entry.isFile()) {
          // The same gates the live event path applies: temp files and the
          // user's exclusion rules, so a startup or folder-add scan never
          // queues what a live event would have dropped.
          if (!isTemporaryFile(fullPath) && !this._matchUserExclusion(fullPath)) {
            files.push(fullPath);
          }
        }
      }
    } catch (error) {
      logger.debug('[SMART-FOLDER-WATCHER] Cannot read directory:', {
        dirPath,
        error: error.message
      });
    }

    return files;
  }

  /**
   * Shutdown handler for DI container compatibility
   */
  async shutdown() {
    this._shutdownRequested = true;
    await this.stop();
    // A restart .then queued before the latch was set may have scheduled a
    // timer while stop() ran — clear it; the latch also guards the callback.
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }
}

/**
 * Pure dispatch helper exposed for the regression-prevention gate
 * (scripts/verify-analysis-routing.js). Returns the analyzer name the watcher
 * would invoke for a given file path. Mirrors the branch logic in
 * `_analyzeFile` (around line 1528-1559) so the verifier does not need to
 * instantiate the watcher.
 *
 * @param {string} filePath
 * @param {{ hasMediaAnalyzer?: boolean }} [opts]
 * @returns {'media'|'image'|'document'|'unsupported'}
 */
function chooseAnalyzerForFile(filePath, { hasMediaAnalyzer = true } = {}) {
  if (!isSupportedFile(filePath)) return 'unsupported';
  if (isImagePath(filePath)) return 'image';
  if (isMediaPath(filePath) && hasMediaAnalyzer) return 'media';
  return 'document';
}

module.exports = SmartFolderWatcher;
module.exports.chooseAnalyzerForFile = chooseAnalyzerForFile;
