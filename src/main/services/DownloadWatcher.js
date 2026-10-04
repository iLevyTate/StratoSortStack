// @ts-check
/**
 * DownloadWatcher — chokidar watcher for the user's Downloads folder.
 *
 * On each new file: debounces, classifies via the smart-folder triage
 * pipeline, and (if a confident match) atomically moves the file into the
 * destination. Resolves the Downloads path through Electron's Known Folder
 * API rather than `os.homedir()` so Windows users who relocated Downloads
 * (OneDrive "Move to cloud", custom redirect) are watched correctly — the
 * homedir fallback is only for worker-thread / test contexts where the
 * `electron` module isn't reachable.
 */
const fs = require('fs').promises;
const fsConstants = require('fs').constants;
const path = require('path');
const os = require('os');
const chokidar = require('chokidar');
const { logger: baseLogger, createLogger } = require('../../shared/logger');
const {
  isNotFoundError,
  isCrossDeviceError,
  isExistsError,
  getErrorCategory,
  ErrorCategory
} = require('../../shared/errorClassifier');
const { FileSystemError, WatcherError } = require('../errors/FileSystemError');
const { crossDeviceMove, renameNoReplace } = require('../../shared/atomicFileOperations');
const { generateSuggestedNameFromAnalysis } = require('./autoOrganize/namingUtils');
const { recordAnalysisResult } = require('../ipc/analysisUtils');
const { deriveWatcherConfidencePercent } = require('./confidence/watcherConfidence');
const {
  normalizeConfidencePercent,
  normalizeThresholdPercent
} = require('../../shared/confidencePercent');
const { getSemanticFileId, isImagePath, isMediaPath } = require('../../shared/fileIdUtils');
const { findContainingSmartFolder } = require('../../shared/folderUtils');
const {
  getCanonicalFileId,
  validateFileOperationPath,
  normalizePathForIndex
} = require('../../shared/pathSanitization');
const { getInstance: getFileOperationTracker } = require('../../shared/fileOperationTracker');
const { isUNCPath } = require('../../shared/crossPlatformUtils');
const { isGhostCleanupDeferred } = require('../../shared/ghostCleanupGuard');
const { isTemporaryFile, RETRY, DEBOUNCE } = require('../../shared/performanceConstants');
const { ACTION_TYPES } = require('../../shared/constants');
const { findUserExclusion } = require('./watcherExclusions');
const { delay } = require('../../shared/promiseUtils');
const { shouldEmbed } = require('./embedding/embeddingGate');
const { embedFileChunks } = require('../analysis/chunkEmbedding');
const { buildEmbeddingSummary } = require('../analysis/embeddingSummary');
const { resolveEmbeddingModelOptions } = require('../analysis/embeddingModelOptions');
const { computeFileChecksum, handleDuplicateMove } = require('../utils/fileDedup');
const { removeEmbeddingsForPathBestEffort } = require('../ipc/files/embeddingSync');

const logger = typeof createLogger === 'function' ? createLogger('DownloadWatcher') : baseLogger;
if (typeof createLogger !== 'function' && logger?.setContext) {
  logger.setContext('DownloadWatcher');
}

// Resolve the user's Downloads directory through Electron's Known Folder
// API when available (handles Windows Known Folder redirection and OneDrive
// "Move to cloud" moves), and fall back to `~/Downloads` for worker threads
// and tests where `app` isn't reachable. Using `os.homedir()` unconditionally
// misses Windows users who relocated their Downloads folder and silently
// watched the wrong directory — producing zero events and making the feature
// look broken.
function resolveDownloadsPath() {
  try {
    // Lazy require: `electron` is not present inside worker threads; falling
    // back to homedir there is intentional and safe.
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      const fromKnownFolder = app.getPath('downloads');
      if (typeof fromKnownFolder === 'string' && fromKnownFolder.length > 0) {
        return fromKnownFolder;
      }
    }
  } catch {
    // Electron isn't available in this context (test / worker); fall through.
  }
  return path.join(os.homedir(), 'Downloads');
}

class DownloadWatcher {
  /**
   * @param {any} deps
   */
  constructor({
    analyzeDocumentFile,
    analyzeImageFile,
    analyzeMediaFile,
    getCustomFolders,
    autoOrganizeService,
    settingsService,
    notificationService,
    analysisHistoryService,
    vectorDbService,
    folderMatcher
  }) {
    if (!settingsService) {
      throw new Error('DownloadWatcher requires settingsService');
    }
    this.analyzeDocumentFile = analyzeDocumentFile;
    this.analyzeImageFile = analyzeImageFile;
    // Optional: when omitted, audio/video falls through to the document analyzer
    // (current pre-fix behavior). Caller should pass the result of
    // mediaAnalyzerAdapter.createMediaAnalyzerAdapter().
    this.analyzeMediaFile = analyzeMediaFile;
    this.getCustomFolders = getCustomFolders;
    this.autoOrganizeService = autoOrganizeService;
    this.settingsService = settingsService;
    this.notificationService = notificationService;
    this.analysisHistoryService = analysisHistoryService;
    this.vectorDbService = vectorDbService;
    this.folderMatcher = folderMatcher;
    this.watcher = null;
    /** The folder being watched, set by start(); the root the exclusion rules read against. */
    this.downloadsPath = null;
    this.isStarting = false;
    this._startPromise = null; // Mutex: concurrent start() callers await the same promise
    this.restartAttempts = 0;
    this.maxRestartAttempts = RETRY.MAX_ATTEMPTS_MEDIUM;
    this.restartDelay = DEBOUNCE.WATCHER_RESTART_BASE;
    this.lastError = null;
    this.processingFiles = new Set(); // Track files being processed to avoid duplicates
    this.debounceTimers = new Map(); // Debounce timers for each file
    // Events that arrived for a file while its pipeline was running. The
    // finally block re-debounces these once, so updated content is never
    // dropped — without a polling reschedule loop (a single analysis can
    // take ~50s on CPU; any bounded retry-with-debounce-interval scheme
    // either drops events or spins).
    this._dirtyWhileProcessing = new Map(); // pathKey -> latest raw filePath
    this._inFlightHandles = new Set(); // Running handleFile promises, drained by stop()
    this.debounceDelay = 500; // 500ms debounce for rapid events
    this.restartTimer = null; // Track restart timer for cleanup
    // Transient: true only while stop() is in progress (in-flight pipelines
    // and event handlers bail on it), reset at the end of stop() so the
    // error-driven restart timer can bring the watcher back mid-session.
    this._stopped = false;
    // Terminal: set by shutdown() and never cleared, so a restart queued
    // before or during shutdown can't re-create the watcher on a disposed
    // instance.
    this._shutdownRequested = false;
    // Bumped by every external stop(). An error-driven restart captures the
    // epoch before tearing down and bails if it changed, so a user disabling
    // the watcher mid-restart wins over the restart (this is a container
    // singleton, so the latch above can't be used for a resumable stop).
    this._restartEpoch = 0;
  }

  async _handleDuplicateMove(/** @type {any} */ source, /** @type {any} */ destination) {
    if (typeof fs.readdir !== 'function') {
      return null;
    }
    const duplicateResult = await handleDuplicateMove({
      sourcePath: source,
      destinationPath: destination,
      checksumFn: computeFileChecksum,
      logger,
      logPrefix: '[DOWNLOAD-WATCHER]',
      dedupContext: 'downloadWatcher',
      removeEmbeddings: removeEmbeddingsForPathBestEffort
    });
    if (!duplicateResult) return null;

    // Record operations to avoid reprocessing
    getFileOperationTracker().recordOperation(
      duplicateResult.destination,
      'move',
      'downloadWatcher'
    );
    getFileOperationTracker().recordOperation(source, 'delete', 'downloadWatcher');

    return { skipped: true, destination: duplicateResult.destination };
  }

  async start() {
    if (this.watcher) {
      logger.debug('[DOWNLOAD-WATCHER] Watcher already running');
      return;
    }

    // await the same promise instead of both proceeding past the flag check.
    if (this._startPromise) {
      logger.debug('[DOWNLOAD-WATCHER] Watcher is already starting, awaiting existing start');
      return this._startPromise;
    }

    this.isStarting = true;
    this._stopped = false;

    this._startPromise = this._doStart();
    try {
      await this._startPromise;
    } finally {
      this._startPromise = null;
    }
  }

  async _doStart() {
    try {
      const downloadsPath = resolveDownloadsPath();
      this.downloadsPath = downloadsPath;

      // Verify downloads directory exists and is accessible
      const isValid = await this._verifyDirectory(downloadsPath);
      if (!isValid) {
        this.isStarting = false;
        return;
      }

      // Prevent race condition: if stop() was called during _verifyDirectory, abort
      if (this._stopped) {
        logger.debug('[DOWNLOAD-WATCHER] Watcher stopped during startup, aborting');
        this.isStarting = false;
        return;
      }

      logger.info('[DOWNLOAD-WATCHER] Watching', downloadsPath);

      // Check for UNC path to enable polling for network drives
      const usePolling = isUNCPath(downloadsPath);
      if (usePolling) {
        logger.info('[DOWNLOAD-WATCHER] Downloads folder is on network drive, enabling polling');
      }

      // PERFORMANCE FIX: Optimize chokidar watcher configuration
      // - ignoreInitial: Don't process existing files on startup
      // - ignored: Comprehensive temp/system file filtering
      // - awaitWriteFinish: Wait for file writes to complete before processing
      // - usePolling: false by default for better performance, set to true for network drives
      this.watcher = chokidar.watch(downloadsPath, {
        ignoreInitial: true,
        ignored: [
          /(^|[\\/\\])\../, // Ignore dotfiles
          /\.tmp$/i, // Ignore temp files
          /\.temp$/i, // Ignore temp files
          /\.crdownload$/i, // Chrome download temp files
          /\.part$/i, // Firefox download temp files
          /\.!qB$/i, // qBittorrent temp files
          /\.download$/i, // Safari temp files
          /\.partial$/i, // Generic partial downloads
          /~\$/, // Microsoft Office temp files
          /^~/, // Unix temp files
          /\.swp$/i, // Vim swap files
          /\.lock$/i, // Lock files
          /\.lck$/i, // Alternative lock files
          /Thumbs\.db$/i, // Windows thumbnails
          /desktop\.ini$/i, // Windows desktop settings
          /\.DS_Store$/i, // macOS directory settings
          '**/node_modules/**', // Ignore node_modules
          '**/.git/**' // Ignore git directories
        ],
        awaitWriteFinish: {
          stabilityThreshold: 2000, // Wait 2s after last change
          pollInterval: 100 // Check every 100ms
        },
        // Error handling options
        persistent: true,
        usePolling: usePolling, // Use native watchers for better performance unless UNC
        interval: usePolling ? 2000 : 100,
        binaryInterval: usePolling ? 2000 : 300,
        alwaysStat: false, // Don't stat files we're ignoring
        depth: 0 // Only watch immediate directory, not subdirectories
      });

      if (!this.watcher) {
        logger.error('[DOWNLOAD-WATCHER] Failed to create file watcher');
        this.isStarting = false;
        return;
      }

      // Handle new files with debouncing
      this.watcher.on('add', (filePath) => {
        this._debouncedHandleFile(filePath);
      });

      // Handle deleted files (external deletion via File Explorer)
      this.watcher.on('unlink', (filePath) => {
        this._handleFileDeletion(filePath);
      });

      // Handle watcher errors with recovery
      this.watcher.on('error', (error) => {
        this._handleWatcherError(/** @type {any} */ (error));
      });

      // Handle ready event
      this.watcher.on('ready', () => {
        logger.info('[DOWNLOAD-WATCHER] Watcher ready and monitoring');
        this.restartAttempts = 0; // Reset restart counter on successful start
        this.lastError = null;
      });

      this.isStarting = false;
    } catch (error) {
      this.isStarting = false;
      this._handleWatcherError(error);
    }
  }

  /**
   * Verify that the downloads directory exists and is accessible
   * @param {string} dirPath - Path to verify
   * @returns {Promise<boolean>} True if directory is valid
   */
  async _verifyDirectory(dirPath) {
    try {
      const stats = await fs.stat(dirPath);
      if (!stats.isDirectory()) {
        logger.error('[DOWNLOAD-WATCHER] Path is not a directory:', dirPath);
        return false;
      }

      // Try to access the directory (read permissions check)
      await fs.access(dirPath, fsConstants.R_OK);
      return true;
    } catch (error) {
      const fsError = FileSystemError.fromNodeError(error, {
        path: dirPath,
        operation: 'verify'
      });

      logger.error('[DOWNLOAD-WATCHER] Cannot access downloads directory:', {
        path: dirPath,
        error: fsError.getUserFriendlyMessage(),
        code: fsError.code
      });

      this.lastError = fsError;
      return false;
    }
  }

  /**
   * Debounced file handling to avoid processing files multiple times
   * @param {string} filePath - Path to the file
   */
  _debouncedHandleFile(filePath) {
    const tracker = getFileOperationTracker();
    if (tracker.wasRecentlyOperated(filePath)) {
      logger.debug('[DOWNLOAD-WATCHER] Skipping recently-operated file:', filePath);
      return;
    }

    // Canonical key: chokidar can report the same file with different casing
    // or separators across events (Windows 8.3/long-name variants, network
    // shares). Keying by the raw string defeats both the debounce and the
    // already-processing dedup, double-running the pipeline for one file.
    const pathKey = normalizePathForIndex(filePath) || filePath;

    // Clear any existing timer for this file
    if (this.debounceTimers.has(pathKey)) {
      clearTimeout(this.debounceTimers.get(pathKey));
    }

    // Set new timer
    const timer = setTimeout(async () => {
      if (this._stopped) {
        this.debounceTimers.delete(pathKey);
        return;
      }

      this.debounceTimers.delete(pathKey);

      try {
        await fs.stat(filePath);
      } catch (statError) {
        if (isNotFoundError(statError)) {
          logger.debug('[DOWNLOAD-WATCHER] File disappeared during debounce:', filePath);
          return;
        }
        // For other errors, continue and let handleFile deal with it
      }

      // Check if already processing this file. Don't poll-reschedule —
      // mark it dirty and let the in-flight pipeline's finally block
      // re-debounce it once when processing completes.
      if (this.processingFiles.has(pathKey)) {
        logger.debug(
          '[DOWNLOAD-WATCHER] File already being processed, deferring re-run:',
          filePath
        );
        this._dirtyWhileProcessing.set(pathKey, filePath);
        return;
      }

      if (tracker.wasRecentlyOperated(filePath)) {
        logger.debug('[DOWNLOAD-WATCHER] File became recently-operated during debounce:', filePath);
        return;
      }

      let inFlight = null;
      try {
        this.processingFiles.add(pathKey);
        inFlight = this.handleFile(filePath);
        this._inFlightHandles.add(inFlight);
        await inFlight;
      } catch (e) {
        logger.error('[DOWNLOAD-WATCHER] Failed processing file', {
          filePath,
          ...this._formatErrorInfo(e),
          stack: e.stack
        });
      } finally {
        if (inFlight) this._inFlightHandles.delete(inFlight);
        this.processingFiles.delete(pathKey);
        // An event arrived for this file mid-pipeline (content changed
        // while we were analyzing the previous version) — run it again.
        const dirtyPath = this._dirtyWhileProcessing.get(pathKey);
        if (dirtyPath !== undefined) {
          this._dirtyWhileProcessing.delete(pathKey);
          if (!this._stopped) this._debouncedHandleFile(dirtyPath);
        }
      }
    }, this.debounceDelay);

    timer.unref(); // Don't prevent process exit
    this.debounceTimers.set(pathKey, timer);
  }

  /**
   * Handle watcher errors with automatic restart capability
   * @param {any} error - The error that occurred
   */
  _handleWatcherError(error) {
    const fsError = /** @type {any} */ (
      error.isFileSystemError
        ? error
        : new WatcherError(path.join(os.homedir(), 'Downloads'), error)
    );

    logger.error('[DOWNLOAD-WATCHER] Watcher error:', {
      message: fsError.getUserFriendlyMessage(),
      code: fsError.code,
      originalError: error.message
    });

    this.lastError = fsError;

    if (
      fsError.shouldRetry() &&
      this.restartAttempts < this.maxRestartAttempts &&
      !this._shutdownRequested
    ) {
      this.restartAttempts++;
      logger.info(
        `[DOWNLOAD-WATCHER] Attempting restart (${this.restartAttempts}/${this.maxRestartAttempts})...`
      );

      const epoch = this._restartEpoch;
      const restartStillWanted = () =>
        !this._shutdownRequested && this._restartEpoch === epoch && !this.watcher;

      this._teardown()
        .then(
          /** @returns {any} */ () => {
            if (!restartStillWanted()) return undefined;
            this.restartTimer = setTimeout(() => {
              this.restartTimer = null;
              if (!restartStillWanted()) return;
              this.start().catch((e) => {
                logger.error('[DOWNLOAD-WATCHER] Restart failed:', e?.message);
              });
            }, this.restartDelay * this.restartAttempts); // Exponential backoff
            this.restartTimer.unref();
            return undefined;
          }
        )
        .catch((stopErr) => {
          logger.error('[DOWNLOAD-WATCHER] Failed to stop before restart:', stopErr?.message);
        });
    } else if (this.restartAttempts >= this.maxRestartAttempts) {
      logger.error('[DOWNLOAD-WATCHER] Max restart attempts reached. Watcher disabled.');
      this.stop().catch((e) => {
        logger.error('[DOWNLOAD-WATCHER] Stop failed:', e?.message);
      });
    }
  }

  /**
   * Resumable stop: closes the watcher and cancels any pending error-driven
   * restart. A later start() (auto-organize re-enabled) brings it back.
   */
  async stop() {
    this._restartEpoch += 1;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    await this._teardown();
  }

  /**
   * Close the chokidar watcher and drain in-flight work without touching the
   * restart bookkeeping — the error-restart path uses this so its own
   * teardown does not cancel the restart it is about to schedule.
   * @private
   */
  async _teardown() {
    this._stopped = true;

    // A start() still in flight either sees _stopped and aborts, or lands its
    // watcher before we reach the close below — never after stop() resolves
    // (which is when _stopped is reset and the flag alone can't protect us).
    if (this._startPromise) {
      await this._startPromise.catch(/** @returns {void} */ () => undefined);
    }

    // Clear all debounce timers (prevents new pipelines from starting)
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this._dirtyWhileProcessing.clear();

    // Drain in-flight handleFile pipelines (bounded). Clearing
    // processingFiles while a pipeline still runs would let moves/history
    // writes land after "stopped" and lose dedup protection on restart.
    if (this._inFlightHandles.size > 0) {
      const drained = await Promise.race([
        Promise.allSettled([...this._inFlightHandles]).then(() => true),
        new Promise((resolve) => {
          const t = setTimeout(() => resolve(false), 10000);
          if (typeof t.unref === 'function') t.unref();
        })
      ]);
      if (!drained) {
        logger.warn('[DOWNLOAD-WATCHER] In-flight file pipelines did not drain before stop', {
          remaining: this._inFlightHandles.size
        });
      }
    }
    this.processingFiles.clear();

    if (this.watcher) {
      try {
        // Remove all listeners before closing
        this.watcher.removeAllListeners();
        const closeResult = this.watcher.close();
        if (closeResult && typeof closeResult.then === 'function') {
          await closeResult;
        }
        logger.info('[DOWNLOAD-WATCHER] Stopped watching downloads');
      } catch (error) {
        logger.error('[DOWNLOAD-WATCHER] Error stopping watcher:', error);
      } finally {
        this.watcher = null;
      }
    }

    this.isStarting = false;
    this._stopped = false;
  }

  /**
   * Check if a file exists and return true/false without throwing for ENOENT
   * @param {string} filePath - Path to check
   * @param {string} context - Context for logging
   * @returns {Promise<boolean>} True if file exists
   * @throws {Error} Re-throws non-ENOENT errors
   */
  async _ensureFileExists(filePath, context = 'processing') {
    try {
      await fs.access(filePath);
      return true;
    } catch (error) {
      if (isNotFoundError(error)) {
        logger.debug(`[DOWNLOAD-WATCHER] File no longer exists (${context}), skipping:`, filePath);
        return false;
      }
      throw error;
    }
  }

  /**
   * Format error information consistently for logging
   * @param {any} error - The error to format
   * @returns {any} Formatted error info object
   */
  _formatErrorInfo(error) {
    return error.isFileSystemError
      ? { code: error.code, message: error.getUserFriendlyMessage() }
      : { message: error.message };
  }

  /**
   * Ensure a directory exists, creating it if necessary
   * @param {string} dirPath - Path to the directory
   * @param {string} context - Context for logging
   * @param {boolean} throwOnError - Whether to throw on error (true) or return false (false)
   * @returns {Promise<boolean>} True if directory exists/created successfully
   * @throws {FileSystemError} If throwOnError is true and mkdir fails
   */
  async _ensureDirectory(dirPath, context = 'destination', throwOnError = true) {
    try {
      await fs.mkdir(dirPath, { recursive: true });
      return true;
    } catch (mkdirError) {
      const fsError = FileSystemError.forOperation('mkdir', mkdirError, dirPath);
      logger.error(`[DOWNLOAD-WATCHER] Failed to create ${context} directory:`, {
        path: dirPath,
        error: fsError.getUserFriendlyMessage(),
        code: fsError.code
      });
      if (throwOnError) {
        throw fsError;
      }
      return false;
    }
  }

  /**
   * Get the current status of the watcher
   * @returns {any} Status information
   */
  getStatus() {
    return {
      isRunning: this.watcher !== null,
      isStarting: this.isStarting,
      restartAttempts: this.restartAttempts,
      maxRestartAttempts: this.maxRestartAttempts,
      lastError: this.lastError ? /** @type {any} */ (this.lastError).toJSON() : null,
      processingCount: this.processingFiles.size,
      pendingDebounce: this.debounceTimers.size
    };
  }

  /**
   * Reset the watcher state and restart
   */
  async restart() {
    logger.info('[DOWNLOAD-WATCHER] Manual restart requested');
    this.restartAttempts = 0;
    this.lastError = null;
    await this.stop();
    await this.start();
  }

  /**
   * Main file handling pipeline - orchestrates validation, auto-organize, and fallback phases.
   * @param {string} filePath - Path to the file to process
   */
  async handleFile(filePath) {
    if (this._stopped) return;

    if (
      typeof this.analyzeDocumentFile !== 'function' ||
      typeof this.analyzeImageFile !== 'function'
    ) {
      logger.warn('[DOWNLOAD-WATCHER] Analysis functions not configured, skipping:', filePath);
      return;
    }

    // One settings read per event. SettingsService caches for 2 s, so for
    // downloads spaced further apart each load() is a settings.json read
    // plus parse and normalize; the three phases share this snapshot.
    const settings = await this._loadSettingsSnapshot();

    // Phase 1: Validation
    if (!(await this._validateFile(filePath, settings))) {
      return;
    }

    if (this._stopped) return;

    // Phase 2: Auto-organize attempt
    const autoResult = await this._attemptAutoOrganize(filePath, settings);
    if (autoResult.handled) {
      return;
    }

    if (this._stopped) return;

    // Phase 3: Fallback processing (only if auto-organize failed with error)
    if (autoResult.shouldFallback) {
      await this._fallbackOrganize(filePath, settings);
    }
  }

  /**
   * Current settings for one event, or null when they cannot be read. Each
   * phase falls back to its own defaults on null, so a settings failure never
   * stops the watcher.
   * @returns {Promise<Record<string, any>|null>}
   */
  async _loadSettingsSnapshot() {
    if (typeof this.settingsService?.load !== 'function') return null;
    try {
      return (await this.settingsService.load()) || null;
    } catch (error) {
      logger.debug('[DOWNLOAD-WATCHER] Could not load settings:', error?.message);
      return null;
    }
  }

  /**
   * Phase 3: Fallback processing
   * Analyzes file and optionally renames if auto-organize failed/skipped.
   * @param {string} filePath - Path to file
   */
  async _fallbackOrganize(filePath, /** @type {Record<string, any>|null} */ presetSettings = null) {
    logger.info('[DOWNLOAD-WATCHER] Fallback processing for:', filePath);

    try {
      try {
        await fs.stat(filePath);
      } catch (error) {
        if (isNotFoundError(error)) {
          logger.debug(
            '[DOWNLOAD-WATCHER] File no longer exists for fallback, skipping:',
            filePath
          );
          return;
        }
        throw error;
      }

      // Analyze file to generate metadata/embeddings even if not moved
      let analysisResult = null;
      const isImage = isImagePath(filePath);
      const isMedia = isMediaPath(filePath);
      const folders = this.getCustomFolders().filter((/** @type {any} */ f) => f && f.path);
      const folderCategories = folders.map((/** @type {any} */ f) => ({
        name: f.name,
        description: f.description || '',
        id: f.id,
        path: f.path
      }));

      try {
        if (isImage) {
          analysisResult = await this.analyzeImageFile(filePath, folderCategories);
        } else if (isMedia && typeof this.analyzeMediaFile === 'function') {
          // Audio/video: route to media analyzer (Whisper + optional vision-LLM keyframe
          // captioning). Adapter returns a graceful skip result when Whisper is unavailable.
          analysisResult = await this.analyzeMediaFile(filePath, folderCategories);
        } else {
          analysisResult = await this.analyzeDocumentFile(filePath, folderCategories);
        }
      } catch (e) {
        if (isNotFoundError(e)) {
          logger.debug(
            '[DOWNLOAD-WATCHER] File disappeared during analysis (TOCTOU race):',
            filePath
          );
          return;
        }
        throw e; // Re-throw to be caught by outer catch
      }

      if (analysisResult) {
        let finalPath = filePath;
        let renamed = false;

        // 1. Apply naming convention first so any later persistence uses the final path.
        const settings = presetSettings || (await this.settingsService.load());
        if (settings && settings.namingConvention) {
          // Construct naming settings object to match old implementation expectations
          const namingSettings = {
            convention: settings.namingConvention,
            separator: settings.separator ?? '-',
            dateFormat: settings.dateFormat || 'YYYY-MM-DD',
            caseConvention: settings.caseConvention || 'kebab-case'
          };

          // Get file timestamps for naming
          const fileStats = await fs.stat(filePath);
          const fileTimestamps = {
            created: fileStats.birthtime,
            modified: fileStats.mtime
          };

          const suggestedName = generateSuggestedNameFromAnalysis({
            originalFileName: path.basename(filePath),
            analysis: analysisResult,
            settings: namingSettings,
            fileTimestamps
          });

          if (suggestedName && suggestedName !== path.basename(filePath, path.extname(filePath))) {
            const dir = path.dirname(filePath);
            const ext = path.extname(filePath);
            // Preserve the original extension unless the suggested name already includes one
            const suggestedExt = path.extname(suggestedName);
            const finalName = suggestedExt ? suggestedName : suggestedName + ext;

            const newPath = path.join(dir, finalName);

            logger.info('[DOWNLOAD-WATCHER] Applying fallback naming convention:', {
              from: filePath,
              to: newPath
            });

            const moveResult = await this._moveFileWithConflictHandling(filePath, newPath, ext);
            if (moveResult?.skipped) {
              return;
            }
            if (moveResult?.destination) {
              finalPath = moveResult.destination;
              renamed = finalPath !== filePath;
              if (renamed) {
                await this._recordFallbackRenameUndo(filePath, finalPath);
              }
            }
          }
        }

        // 2. Record to analysis history for conversations and queries using the final path.
        if (this.analysisHistoryService) {
          try {
            await recordAnalysisResult({
              filePath: finalPath,
              result: {
                ...analysisResult,
                suggestedName: renamed
                  ? path.basename(finalPath)
                  : analysisResult?.suggestedName || null
              },
              processingTime: analysisResult.processingTime || 0,
              modelType: isImage ? 'vision' : 'llm',
              analysisHistory: this.analysisHistoryService,
              logger
            });
          } catch (historyError) {
            logger.warn('[DOWNLOAD-WATCHER] Failed to record analysis history:', {
              filePath: finalPath,
              error: historyError.message
            });
          }
        }

        // 3. Embed for search after persistence so policy overrides see the final path.
        await this._embedAnalyzedFile(finalPath, analysisResult);
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        // Already handled?
        return;
      }
      logger.warn('[DOWNLOAD-WATCHER] Fallback processing error:', error.message);
    }
  }

  /**
   * A fallback rename changes the name the user sees in Downloads, so it
   * gets the same undo entry every other watcher move gets. Auto-organize
   * moves already record theirs through `result.undoAction`; the naming-only
   * path had none, which left a renamed file with no way back.
   * @param {string} originalPath
   * @param {string} newPath
   */
  async _recordFallbackRenameUndo(originalPath, newPath) {
    const undoRedo = this.autoOrganizeService?.undoRedo;
    if (!undoRedo || typeof undoRedo.recordAction !== 'function') return;
    try {
      await undoRedo.recordAction(ACTION_TYPES.FILE_RENAME, {
        originalPath,
        newPath,
        source: 'download_watcher_fallback'
      });
    } catch (undoErr) {
      logger.debug('[DOWNLOAD-WATCHER] Failed to record fallback rename undo:', undoErr?.message);
    }
  }

  /**
   * First exclusion glob that matches the file, or null. The built-in
   * defaults (installers, disk images, partial downloads) apply here as they
   * do in the triage sweep: both read the Downloads folder, and an installer
   * analyzed by filename only produced a history entry and a "Manual Review
   * Needed" notice nobody asked for. The user's rules apply on top. A
   * relative folder rule (`archived/**`) reads beneath the watched Downloads
   * folder, never against that folder's own ancestors.
   * @param {string} filePath
   * @param {Record<string, any>|null} [settings]  snapshot from handleFile; loaded when absent
   * @returns {Promise<string|null>}
   */
  async _matchUserExclusion(filePath, settings = null) {
    const options = { includeDefaults: true, root: this.downloadsPath };
    try {
      const snapshot = settings || (await this.settingsService.load());
      return findUserExclusion(filePath, snapshot, options);
    } catch (error) {
      logger.debug('[DOWNLOAD-WATCHER] Could not read exclusion rules:', error?.message);
      return findUserExclusion(filePath, null, options);
    }
  }

  /**
   * Phase 1: Validate that the file should be processed.
   * Checks extension, temp file patterns, system directories, user exclusion
   * rules, and file existence.
   * @param {string} filePath - Path to validate
   * @param {Record<string, any>|null} [settings] - snapshot from handleFile
   * @returns {Promise<boolean>} True if file is valid for processing
   */
  async _validateFile(filePath, settings = null) {
    const ext = path.extname(filePath).toLowerCase();
    const basename = path.basename(filePath);

    // Enhanced temporary file detection using comprehensive patterns
    // to avoid false positives like 'project.gitignore' being skipped
    const pathSegments = String(filePath)
      .split(/[\\/]+/)
      .filter(Boolean);
    const hasGitDir = pathSegments.includes('.git');
    const hasNodeModules = pathSegments.includes('node_modules');

    if (
      ext === '' ||
      isTemporaryFile(filePath) ||
      hasGitDir ||
      hasNodeModules ||
      basename.startsWith('.')
    ) {
      logger.debug('[DOWNLOAD-WATCHER] Skipping system/temporary file:', filePath);
      return false;
    }

    // Exclusion rules apply to the live watcher, not only the triage sweep.
    const excludedBy = await this._matchUserExclusion(filePath, settings);
    if (excludedBy) {
      logger.debug('[DOWNLOAD-WATCHER] Skipping file excluded by user rule:', {
        filePath,
        pattern: excludedBy
      });
      return false;
    }

    // Defense in depth: chokidar yields whatever the OS reports, which on
    // some platforms (and in corrupted FS states) can include normalizable
    // traversal segments, null bytes, or paths that resolve outside the
    // downloads folder via symlinks. Gate the rest of the pipeline behind
    // the same validation the IPC layer uses so a bad path never reaches
    // `fs.rename`, `fs.stat`, or the analyzer.
    const pathValidation = await validateFileOperationPath(filePath, {
      requireAbsolute: true,
      disallowUrlSchemes: true,
      allowFileUrl: false
    });
    if (!pathValidation.valid) {
      logger.warn('[DOWNLOAD-WATCHER] Rejecting unsafe path from watcher event:', {
        filePath,
        error: pathValidation.error
      });
      return false;
    }

    // Files may be deleted quickly (e.g., git lock files)
    try {
      // Single atomic operation - stat provides both existence check and size
      const stats = await fs.stat(filePath);
      if (stats.size === 0) {
        logger.debug('[DOWNLOAD-WATCHER] Skipping empty file:', filePath);
        return false;
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        logger.debug('[DOWNLOAD-WATCHER] File no longer exists, skipping:', filePath);
        return false;
      }

      // Convert to FileSystemError for consistent handling
      const fsError = FileSystemError.fromNodeError(error, {
        path: filePath,
        operation: 'access'
      });

      // Log with context but don't crash
      logger.warn('[DOWNLOAD-WATCHER] Cannot access file:', {
        filePath,
        error: fsError.getUserFriendlyMessage(),
        code: fsError.code
      });

      // Only throw if it's a critical error
      if (!fsError.isRecoverable()) {
        throw fsError;
      }
      return false;
    }

    return true;
  }

  /**
   * Phase 2: Attempt to auto-organize the file using AutoOrganizeService.
   * @param {string} filePath - Path to the file
   * @param {Record<string, any>|null} [presetSettings] - snapshot from handleFile
   * @returns {Promise<{handled: boolean, shouldFallback: boolean}>} Result indicating if file was handled
   */
  async _attemptAutoOrganize(filePath, presetSettings = null) {
    const folders = this.getCustomFolders().filter((/** @type {any} */ f) => f && f.path);

    // Check if auto-organize service is available
    if (!this.autoOrganizeService || !this.settingsService) {
      return { handled: false, shouldFallback: true };
    }

    try {
      // IMPORTANT: Load naming conventions from persisted Settings, NOT Redux state
      // The DownloadWatcher uses the Settings naming conventions to ensure consistent
      // naming behavior across all automatic operations (watchers & reanalysis).
      // The Discover phase has its own session-based naming controls in Redux.
      const settings = presetSettings || (await this.settingsService.load());

      // Use the new auto-organize service with suggestions
      const result = await this.autoOrganizeService.processNewFile(filePath, folders, {
        autoOrganizeEnabled: settings.autoOrganize,
        confidenceThreshold: settings.confidenceThreshold ?? 0.75,
        defaultLocation: settings.defaultSmartFolderLocation || 'Documents',
        namingSettings: {
          // Default to subject-date so files are actually renamed when settings are missing
          convention: settings.namingConvention || 'subject-date',
          separator: settings.separator ?? '-',
          dateFormat: settings.dateFormat || 'YYYY-MM-DD',
          caseConvention: settings.caseConvention || 'kebab-case'
        }
      });
      logger.debug('[DOWNLOAD-WATCHER] Naming settings used for auto-organize', {
        namingConvention: settings.namingConvention,
        separator: settings.separator,
        dateFormat: settings.dateFormat,
        caseConvention: settings.caseConvention
      });

      if (result && result.destination) {
        const thresholdPercent = normalizeThresholdPercent(settings.confidenceThreshold);
        const routingConfidencePercent = normalizeConfidencePercent(result.confidence);
        const isManualReview = result.requiresManualReview === true;
        const displayConfidencePercent = isManualReview
          ? routingConfidencePercent
          : deriveWatcherConfidencePercent(result);

        // Create destination directory with error handling
        await this._ensureDirectory(path.dirname(result.destination), 'destination', true);

        // Move file with atomic error handling (TOCTOU fix: handle ENOENT from move directly)
        try {
          const moveResult = await this._moveFile(filePath, result.destination);
          if (moveResult?.skipped) {
            logger.debug('[DOWNLOAD-WATCHER] Duplicate skip; not recording undo', {
              filePath,
              destination: result.destination
            });
            return { handled: true, shouldFallback: false };
          }
        } catch (moveError) {
          if (isNotFoundError(moveError)) {
            logger.debug('[DOWNLOAD-WATCHER] File disappeared before move:', filePath);
            return { handled: true, shouldFallback: false };
          }
          throw moveError;
        }

        // Record undo action AFTER the move succeeds to avoid phantom undo entries
        if (result.undoAction && this.autoOrganizeService?.undoRedo) {
          try {
            const undoType = result.undoAction?.type;
            const undoData = result.undoAction?.data;
            if (typeof undoType === 'string' && undoData && typeof undoData === 'object') {
              await this.autoOrganizeService.undoRedo.recordAction(undoType, undoData);
            } else {
              logger.warn('[DOWNLOAD-WATCHER] Invalid undo action payload from auto-organize', {
                filePath,
                hasType: typeof undoType === 'string',
                hasData: Boolean(undoData)
              });
            }
          } catch (undoErr) {
            logger.debug('[DOWNLOAD-WATCHER] Failed to record undo action:', undoErr.message);
          }
        }

        // This ensures notifications show the actual filename the user will see
        const fileName = path.basename(result.destination);
        const destFolder = path.basename(path.dirname(result.destination));

        logger.info(
          '[DOWNLOAD-WATCHER] Auto-organized with',
          `${displayConfidencePercent}% confidence:`,
          filePath,
          '=>',
          result.destination
        );

        // Send notification via NotificationService
        if (this.notificationService) {
          if (isManualReview) {
            await this.notificationService.notifyLowConfidence(
              fileName,
              routingConfidencePercent,
              thresholdPercent,
              result.suggestedFolder || null,
              result.destination
            );
          } else {
            await this.notificationService.notifyFileOrganized(
              fileName,
              destFolder,
              displayConfidencePercent,
              result.destination
            );
          }
        }

        // Record to analysis history (post-move, use destination path)
        if (this.analysisHistoryService) {
          try {
            // Get analysis data from result (may be nested in result.analysis)
            const analysisForHistory = this._analysisForHistory(result, {
              filePath: result.destination,
              category: result.category || result.folder || destFolder || 'organized',
              confidencePercent: isManualReview
                ? routingConfidencePercent
                : displayConfidencePercent,
              moved: true
            });

            await recordAnalysisResult({
              filePath: result.destination,
              result: analysisForHistory,
              processingTime: result.processingTime || 0,
              modelType: 'auto-organize',
              analysisHistory: this.analysisHistoryService,
              logger
            });

            // This ensures DownloadWatcher-organized files are searchable
            await this._embedAnalyzedFile(result.destination, result);
          } catch (historyErr) {
            logger.debug('[DOWNLOAD-WATCHER] Failed to record history entry:', historyErr.message);
          }
        }
        return { handled: true, shouldFallback: false };
      }
      // File not auto-organized - notify user if it's due to low confidence
      const fileName = path.basename(filePath);
      logger.info('[DOWNLOAD-WATCHER] File not auto-organized (low confidence or disabled)');

      // D2: a held file stays where it is. Keep its analysis so it is
      // searchable now and the review can offer the suggested folder; the
      // work is not thrown away just because it was not confident.
      if (result?.held && this.analysisHistoryService) {
        try {
          await recordAnalysisResult({
            filePath,
            result: this._analysisForHistory(result, {
              filePath,
              category:
                (typeof result.analysis?.category === 'string' && result.analysis.category) ||
                result.suggestedFolder ||
                'uncategorized',
              confidencePercent: normalizeConfidencePercent(result.confidence),
              moved: false
            }),
            processingTime: result.processingTime || 0,
            modelType: 'auto-organize',
            analysisHistory: this.analysisHistoryService,
            logger
          });
        } catch (historyErr) {
          logger.debug('[DOWNLOAD-WATCHER] Failed to record held file:', historyErr.message);
        }
      }

      // Check if we have analysis result to show low-confidence notification
      if (this.notificationService && result) {
        const confidencePercent = normalizeConfidencePercent(result.confidence);
        const thresholdPercent = normalizeThresholdPercent(settings.confidenceThreshold);
        // A held file needs review even when its confidence cleared the bar
        // (the suggested folder is not a configured smart folder).
        if (result.requiresManualReview === true || confidencePercent < thresholdPercent) {
          await this.notificationService.notifyLowConfidence(
            fileName,
            confidencePercent,
            thresholdPercent,
            result.suggestedFolder || null,
            filePath
          );
        }
      }
      return { handled: true, shouldFallback: false };
    } catch (e) {
      // Log with appropriate detail based on error type
      logger.warn(
        '[DOWNLOAD-WATCHER] Auto-organize service failed, falling back:',
        this._formatErrorInfo(e)
      );
      // Fall through to fallback logic
      return { handled: false, shouldFallback: true };
    }
  }

  /**
   * The analysis record written to history for a Downloads file, moved or
   * held (D2). One builder so both paths persist the same fields, including
   * extractionMethod (provenance) and the media fields.
   * @private
   * @param {any} result - auto-organize result (analysis may be nested)
   * @param {{ filePath: string, category: string, confidencePercent: number, moved: boolean }} where
   * @returns {Record<string, any>}
   */
  _analysisForHistory(result, { filePath, category, confidencePercent, moved }) {
    const analysis = result.analysis || result;
    const name = path.basename(filePath);
    return {
      suggestedName: moved ? name : analysis.suggestedName || name,
      category,
      keywords: result.keywords || analysis.keywords || [],
      // UI expects percentage, not fraction
      confidence: confidencePercent,
      smartFolder: moved ? result.smartFolder || null : null,
      summary: result.summary || analysis.summary || '',
      model: 'auto-organize',
      suggestedPath: moved ? filePath : null,
      actualPath: moved ? filePath : null,
      renamed: moved,
      newName: moved ? name : null,
      // Extended fields for richer context in chat/search
      documentType: analysis.type || null,
      entity: analysis.entity || null,
      project: analysis.project || null,
      purpose: analysis.purpose || null,
      reasoning: analysis.reasoning || null,
      documentDate: analysis.date || null,
      keyEntities: analysis.keyEntities || [],
      extractionMethod: analysis.extractionMethod || null,
      extractedText: analysis.extractedText || null,
      // Image-specific fields
      content_type: analysis.content_type || null,
      has_text: typeof analysis.has_text === 'boolean' ? analysis.has_text : null,
      colors: Array.isArray(analysis.colors) ? analysis.colors : null,
      // Media-specific fields (audio/video): recordAnalysisResult normalizes and caps them.
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
  }

  /**
   * Move a file to destination, handling cross-device moves and FILE_IN_USE retries.
   * @param {string} source - Source file path
   * @param {string} destination - Destination file path
   * @param {number} [retryCount=0] - Current retry attempt (internal use)
   * @returns {Promise<any>}
   */
  async _moveFile(source, destination, retryCount = 0) {
    const MAX_RETRIES = RETRY.MAX_ATTEMPTS_HIGH;
    const RETRY_DELAY_MS = 2000; // 2 seconds between retries

    try {
      const duplicateResult = await this._handleDuplicateMove(source, destination);
      if (duplicateResult?.skipped) {
        return { skipped: true, destination };
      }

      // renameNoReplace, not fs.rename: a bare rename silently REPLACES an
      // occupied destination. The auto-organize service pre-computes unique
      // destinations, so an EEXIST here is the external-race window — fail
      // closed (the caller falls back to the triage flow, which walks
      // collision suffixes) rather than destroy the occupant.
      await renameNoReplace(source, destination);
      getFileOperationTracker().recordOperation(destination, 'move', 'downloadWatcher');
      getFileOperationTracker().recordOperation(source, 'move', 'downloadWatcher');
      return { skipped: false, destination };
    } catch (renameError) {
      // Handle cross-device move (different drives)
      if (isCrossDeviceError(renameError)) {
        logger.debug(
          '[DOWNLOAD-WATCHER] Cross-device move detected, using crossDeviceMove utility'
        );
        try {
          await crossDeviceMove(source, destination, { verify: true });
          getFileOperationTracker().recordOperation(destination, 'move', 'downloadWatcher');
          getFileOperationTracker().recordOperation(source, 'move', 'downloadWatcher');
          return { skipped: false, destination };
        } catch (copyError) {
          const fsError = copyError.isFileSystemError
            ? copyError
            : FileSystemError.forOperation('copy', copyError, source);
          logger.error('[DOWNLOAD-WATCHER] Cross-device move failed:', {
            source,
            destination,
            error: fsError.getUserFriendlyMessage()
          });
          throw fsError;
        }
      } else {
        const errorCategory = getErrorCategory(renameError);
        const isFileInUse = errorCategory === ErrorCategory.FILE_IN_USE;

        if (isFileInUse && retryCount < MAX_RETRIES) {
          const nextRetry = retryCount + 1;
          logger.info('[DOWNLOAD-WATCHER] File in use, scheduling retry', {
            source,
            attempt: nextRetry,
            maxRetries: MAX_RETRIES,
            delayMs: RETRY_DELAY_MS
          });

          // Wait before retrying
          await delay(RETRY_DELAY_MS);

          try {
            await fs.stat(source);
          } catch (statError) {
            if (isNotFoundError(statError)) {
              logger.debug('[DOWNLOAD-WATCHER] File no longer exists, skipping retry:', source);
              // Propagate the ENOENT so the caller's not-found branch runs. A
              // bare return read as a completed move and recorded undo,
              // history and a notification for a file that never moved.
              throw statError;
            }
            // Log and continue to next retry instead of aborting
            logger.warn(
              '[DOWNLOAD-WATCHER] Transient error checking file existence during retry:',
              {
                source,
                error: statError.message
              }
            );
            // Fall through to recursive retry
          }

          // Recursive retry
          return this._moveFile(source, destination, nextRetry);
        }

        const fsError = FileSystemError.forOperation('move', renameError, source);

        // Enhanced logging for FILE_IN_USE to help debugging
        if (isFileInUse) {
          logger.error('[DOWNLOAD-WATCHER] Failed to move file after retries:', {
            source,
            destination,
            error: fsError.getUserFriendlyMessage(),
            code: fsError.code,
            retriesAttempted: retryCount
          });
        } else {
          logger.error('[DOWNLOAD-WATCHER] Failed to move file:', {
            source,
            destination,
            error: fsError.getUserFriendlyMessage(),
            code: fsError.code
          });
        }
        throw fsError;
      }
    }
  }

  /**
   * Move a file with conflict handling (generates unique name if file exists).
   * @param {string} source - Source file path
   * @param {string} destPath - Destination file path
   * @param {string} extname - File extension
   */
  async _moveFileWithConflictHandling(source, destPath, extname) {
    try {
      const duplicateResult = await this._handleDuplicateMove(source, destPath);
      if (duplicateResult?.skipped) {
        return duplicateResult;
      }

      // renameNoReplace, not fs.rename: a bare rename silently REPLACES an
      // occupied destination, so the isExistsError collision walk below
      // would never fire and the occupant would be destroyed.
      await renameNoReplace(source, destPath);
      // Record operation to prevent other watchers from re-processing this file
      getFileOperationTracker().recordOperation(destPath, 'move', 'downloadWatcher');
      getFileOperationTracker().recordOperation(source, 'move', 'downloadWatcher');
      return { destination: destPath, skipped: false };
    } catch (renameError) {
      if (isCrossDeviceError(renameError)) {
        // Cross-device move using shared utility
        logger.debug(
          '[DOWNLOAD-WATCHER] Cross-device move in fallback, using crossDeviceMove utility'
        );
        await crossDeviceMove(source, destPath, { verify: true });
        getFileOperationTracker().recordOperation(destPath, 'move', 'downloadWatcher');
        getFileOperationTracker().recordOperation(source, 'move', 'downloadWatcher');
        return { destination: destPath, skipped: false };
      } else if (isExistsError(renameError)) {
        // Destination occupied: walk numbered suffixes until a free slot is
        // found. Each candidate goes through renameNoReplace's occupancy
        // preflight (check-then-rename; the small TOCTOU window is the same
        // accepted trade-off as atomicMove's).
        const nameWithoutExt = path.basename(destPath, extname);
        const destDir = path.dirname(destPath);
        let moved = false;

        for (let counter = 1; counter < 1000; counter++) {
          const uniquePath = path.join(destDir, `${nameWithoutExt}_${counter}${extname}`);
          try {
            await renameNoReplace(source, uniquePath);
            moved = true;
            destPath = uniquePath;
            break;
          } catch (retryError) {
            if (isCrossDeviceError(retryError)) {
              await crossDeviceMove(source, uniquePath, { verify: true });
              moved = true;
              destPath = uniquePath;
              break;
            }
            if (!isExistsError(retryError)) {
              throw retryError;
            }
            // EEXIST -- try next suffix
          }
        }

        if (!moved) {
          throw new Error(
            `Could not find unique name for ${path.basename(destPath)} after 999 attempts`,
            { cause: renameError }
          );
        }
        // Record operation after successful conflict resolution move
        getFileOperationTracker().recordOperation(destPath, 'move', 'downloadWatcher');
        getFileOperationTracker().recordOperation(source, 'move', 'downloadWatcher');
        logger.info(
          '[DOWNLOAD-WATCHER] Moved (fallback, renamed due to conflict)',
          source,
          '=>',
          destPath
        );
        return { destination: destPath, skipped: false };
      } else {
        throw renameError;
      }
    }
  }

  /**
   * Permanent stop for app shutdown / disposal (DI container `shutdown()`
   * pattern). Unlike stop(), this latches the instance so an error-driven
   * restart queued before or during the stop can never re-create the watcher.
   * @returns {Promise<void>}
   */
  async shutdown() {
    this._shutdownRequested = true;
    await this.stop();
  }

  /**
   * Embed an analyzed file into the vector DB for semantic search
   * This is called after successful auto-organization to keep embeddings in sync
   * FIX: Ensures DownloadWatcher-organized files are searchable via semantic search
   * @private
   * @param {string} filePath - Path to the file (destination after move)
   * @param {any} analysisResult - Result from auto-organize analysis
   */
  async _embedAnalyzedFile(filePath, analysisResult) {
    // Skip if dependencies not available
    if (!this.folderMatcher || !this.vectorDbService) {
      logger.debug('[DOWNLOAD-WATCHER] Skipping embedding - services not available');
      return;
    }

    // Respect global embedding timing/policy. DownloadWatcher embeds after final placement.
    // If we have a persisted per-file override, apply it here.
    let policyOverride = null;
    try {
      const entry = await this.analysisHistoryService?.getAnalysisByPath?.(filePath);
      policyOverride = entry?.embedding?.policy || null;
    } catch {
      // Non-fatal
    }
    const gate = await shouldEmbed({
      stage: 'final',
      policyOverride,
      analysis: analysisResult?.analysis || analysisResult || null
    });
    if (!gate.shouldEmbed) {
      logger.debug('[DOWNLOAD-WATCHER] Skipping embedding by policy/timing/provenance gate', {
        timing: gate.timing,
        policy: gate.policy,
        reason: gate.reason,
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
        logger.debug('[DOWNLOAD-WATCHER] File no longer exists, skipping embedding:', filePath);
        return;
      }
      // For other stat errors, continue and let embedding logic handle it
    }

    try {
      // Extract analysis data - handle different result structures
      const analysis = analysisResult.analysis || analysisResult;
      const finalFileName = path.basename(filePath);
      const summary = analysis.summary || analysis.description || analysis.purpose || '';
      const category = analysis.category || analysis.folder || 'Uncategorized';
      const keywords = analysis.keywords || analysis.tags || [];
      const subject = analysis.subject || analysis.suggestedName || '';
      const rawConfidence = analysis.confidence ?? analysisResult.confidence ?? 0;
      const confidence =
        typeof rawConfidence === 'number'
          ? rawConfidence > 1
            ? Math.round(rawConfidence)
            : Math.round(rawConfidence * 100)
          : 0;

      // Skip if no meaningful content to embed
      if (!summary && !subject) {
        logger.debug('[DOWNLOAD-WATCHER] Skipping embedding - no content:', filePath);
        return;
      }

      const smartFolders = this.getCustomFolders?.() || [];
      const resolvedSmartFolder = findContainingSmartFolder(filePath, smartFolders);
      if (!resolvedSmartFolder) {
        logger.debug('[DOWNLOAD-WATCHER] Skipping embedding - not in smart folder:', filePath);
        return;
      }

      const purpose = analysis.purpose || '';
      const entity = analysis.entity || '';
      const project = analysis.project || '';
      const documentType = analysis.type || '';
      const extractedText = analysis.extractedText || '';
      const keyEntities = Array.isArray(analysis.keyEntities) ? analysis.keyEntities : [];

      // Same builder and model budget as every other ingestion route, so a
      // Downloads-organized file lands where a Discover-analyzed copy of it
      // would (CP-14). The old ad-hoc join had no extracted text, no entity,
      // project or date, and no model-aware cap.
      const textToEmbed = buildEmbeddingSummary(
        // The name the user sees after rename/collision handling, not the
        // model's pre-rename suggestion.
        { ...analysis, suggestedName: finalFileName },
        extractedText,
        path.extname(filePath).toLowerCase(),
        isImagePath(filePath) ? 'image' : 'document',
        await resolveEmbeddingModelOptions()
      ).text;
      if (!textToEmbed || !textToEmbed.trim()) {
        logger.debug('[DOWNLOAD-WATCHER] Skipping embedding - empty summary:', filePath);
        return;
      }
      const embedding = await this.folderMatcher.embedText(textToEmbed);

      if (!embedding || !embedding.vector || !Array.isArray(embedding.vector)) {
        throw new Error('Failed to generate embedding vector');
      }

      // Prepare metadata for vector DB
      // IMPORTANT: IDs must match the rest of the semantic pipeline
      const fileId = getSemanticFileId(filePath);
      const isImage = isImagePath(filePath);
      const fileName = finalFileName;

      // Build metadata object - shared for documents and images
      /** @type {Record<string, any>} */
      const baseMeta = {
        path: filePath,
        name: fileName,
        category: resolvedSmartFolder?.name || category,
        subject,
        summary: summary.substring(0, 2000), // Increased limit for richer context
        purpose: purpose.substring(0, 1000),
        tags: JSON.stringify(keywords.slice(0, 15)), // Increased tag limit
        type: isImage ? 'image' : 'document',
        confidence,
        // Additional fields for document/image conversations
        entity: entity.substring(0, 255),
        project: project.substring(0, 255),
        documentType: documentType.substring(0, 100),
        keyEntities: JSON.stringify(keyEntities.slice(0, 20)),
        reasoning: (analysis.reasoning || '').substring(0, 500),
        // Store truncated extracted text for conversation context
        extractedText: extractedText.substring(0, 5000),
        extractionMethod: analysis.extractionMethod || 'unknown',
        // Document date for time-based queries
        date: analysis.date || null,
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
        logger.debug('[DOWNLOAD-WATCHER] Skipping vector upsert — vector DB unavailable', filePath);
        return;
      }
      await this.vectorDbService.upsertFile({
        id: fileId,
        vector: embedding.vector,
        model: embedding.model || 'unknown',
        meta: baseMeta,
        updatedAt: new Date().toISOString()
      });

      logger.debug('[DOWNLOAD-WATCHER] Embedded file:', filePath);

      // Same passage vectors a Discover- or watcher-analyzed copy would get.
      if (!isImage) {
        await embedFileChunks({
          fileId,
          filePath,
          extractedText,
          embedText: (text) => this.folderMatcher.embedText(text),
          vectorDb: this.vectorDbService
        });
      }

      // Persist done state (direct upsert).
      try {
        await this.analysisHistoryService?.updateEmbeddingStateByPath?.(filePath, {
          status: 'done',
          model: embedding.model || null
        });
      } catch {
        // Non-fatal
      }
    } catch (embedError) {
      // Non-critical - log but don't fail the operation
      logger.warn('[DOWNLOAD-WATCHER] Failed to embed file:', {
        filePath,
        error: embedError.message
      });
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
    if (this._stopped) return;
    // Skip temp files
    if (isTemporaryFile(filePath)) {
      return;
    }

    // An unlink is also what a MOVE out of Downloads looks like. Batch
    // organize fires one per source before its end-of-batch path remap, and
    // undo/redo moves record into the operation tracker — deleting here
    // would strip vectors from files that still exist at their new path.
    if (isGhostCleanupDeferred()) {
      logger.debug(
        '[DOWNLOAD-WATCHER] Skipping deletion cleanup: batch organize in progress',
        filePath
      );
      return;
    }
    if (getFileOperationTracker().wasRecentlyOperated(filePath)) {
      logger.debug('[DOWNLOAD-WATCHER] Skipping deletion cleanup: recently moved by app', filePath);
      return;
    }

    logger.info('[DOWNLOAD-WATCHER] Detected external file deletion:', filePath);

    try {
      // Remove from vector DB (both file: and image: prefixes)
      if (this.vectorDbService) {
        // Use canonical file ID source of truth + legacy raw-path IDs for backward compat
        const canonicalFileId = getCanonicalFileId(filePath, false);
        const canonicalImageId = getCanonicalFileId(filePath, true);
        const idsToDelete =
          canonicalFileId === `file:${filePath}`
            ? [canonicalFileId, canonicalImageId]
            : [canonicalFileId, canonicalImageId, `file:${filePath}`, `image:${filePath}`];

        if (typeof this.vectorDbService.batchDeleteFileEmbeddings === 'function') {
          await this.vectorDbService.batchDeleteFileEmbeddings(idsToDelete);
        } else {
          // Fallback to individual deletes
          for (const id of idsToDelete) {
            await this.vectorDbService.deleteFileEmbedding(id);
          }
        }

        // Delete associated chunks
        if (typeof this.vectorDbService.deleteFileChunks === 'function') {
          for (const id of idsToDelete) {
            await this.vectorDbService.deleteFileChunks(id);
          }
        }

        logger.debug('[DOWNLOAD-WATCHER] Removed embeddings for deleted file:', filePath);
      }

      // Remove from analysis history
      if (this.analysisHistoryService?.removeEntriesByPath) {
        await this.analysisHistoryService.removeEntriesByPath(filePath);
        logger.debug('[DOWNLOAD-WATCHER] Removed history for deleted file:', filePath);
      }
    } catch (error) {
      logger.warn('[DOWNLOAD-WATCHER] Error cleaning up deleted file:', {
        filePath,
        error: error.message
      });
    }
  }

  resolveDestinationFolder(/** @type {any} */ result, /** @type {any} */ folders) {
    if (!result) return null;
    // Prefer explicit smartFolder id
    if (result.smartFolder && result.smartFolder.id) {
      return folders.find((/** @type {any} */ f) => f.id === result.smartFolder.id);
    }
    // Try folder match candidates
    if (Array.isArray(result.folderMatchCandidates)) {
      for (const cand of result.folderMatchCandidates) {
        const found = folders.find(
          (/** @type {any} */ f) => f.id === cand.id || f.name === cand.name
        );
        if (found) return found;
      }
    }
    // Fallback to category name match
    if (result.category) {
      return folders.find(
        (/** @type {any} */ f) => f.name.toLowerCase() === result.category.toLowerCase()
      );
    }
    return null;
  }
}

/**
 * Pure dispatch helper exposed for the regression-prevention gate
 * (scripts/verify-analysis-routing.js). Returns the analyzer name the watcher
 * would invoke for a given file path. Mirrors the branch logic in `handleFile`
 * (around line 581-595). DownloadWatcher does not pre-filter by extension —
 * unsupported types simply fall through to the document analyzer (existing
 * behavior preserved).
 *
 * @param {string} filePath
 * @param {{ hasMediaAnalyzer?: boolean }} [opts]
 * @returns {'media'|'image'|'document'}
 */
function chooseAnalyzerForFile(filePath, { hasMediaAnalyzer = true } = {}) {
  if (isImagePath(filePath)) return 'image';
  if (isMediaPath(filePath) && hasMediaAnalyzer) return 'media';
  return 'document';
}

module.exports = DownloadWatcher;
module.exports.chooseAnalyzerForFile = chooseAnalyzerForFile;
