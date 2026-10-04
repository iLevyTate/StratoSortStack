// @ts-check
/**
 * Application Lifecycle Management
 *
 * Handles app lifecycle events including shutdown, cleanup, and error handling.
 * Extracted from simple-main.js for better maintainability.
 *
 * @module core/lifecycle
 */

const electron = require('electron');
const { app, BrowserWindow, ipcMain } = electron;
const { createLogger, shutdownLogging } = require('../../shared/logger');
const { hasPendingDownloadedUpdate } = require('./autoUpdater');
const { attachUserDataLockPowerMonitor } = require('./userDataLock');
const { destroyTray, getTray, unregisterGlobalShortcuts } = require('./systemTray');
const { getStartupManager } = require('../services/startup');
const systemAnalytics = require('./systemAnalytics');
const { withTimeout } = require('../../shared/promiseUtils');
const { getErrorCategory, ErrorCategory } = require('../../shared/errorClassifier');
const { classifyLlamaError } = require('../../shared/llamaErrorClassifier');

const logger = createLogger('Lifecycle');
// Module-level state (injected via initializeLifecycle)
/** @type {any} */
let lifecycleConfig = {
  getMetricsInterval: null,
  setMetricsInterval: null,
  getDownloadWatcher: null,
  setDownloadWatcher: null,
  getServiceIntegration: null,
  getSettingsService: null,
  getEventListeners: null,
  setEventListeners: null,
  getChildProcessListeners: null,
  setChildProcessListeners: null,
  getGlobalProcessListeners: null,
  setGlobalProcessListeners: null,
  setIsQuitting: null
};

/**
 * Initialize lifecycle configuration
 * @param {any} config - Configuration object with getters/setters for shared state
 */
function initializeLifecycle(config) {
  lifecycleConfig = { ...lifecycleConfig, ...config };
}

/**
 * Verify that all resources are properly released after shutdown
 * @returns {Promise<void>}
 */
async function verifyShutdownCleanup() {
  const issues = [];

  const metricsInterval = lifecycleConfig.getMetricsInterval?.();
  const childProcessListeners = lifecycleConfig.getChildProcessListeners?.() || [];
  const globalProcessListeners = lifecycleConfig.getGlobalProcessListeners?.() || [];
  const eventListeners = lifecycleConfig.getEventListeners?.() || [];
  const serviceIntegration = lifecycleConfig.getServiceIntegration?.();
  const downloadWatcher = lifecycleConfig.getDownloadWatcher?.();

  // 1. Verify intervals are cleared
  if (metricsInterval !== null) {
    issues.push('metricsInterval is not null');
  }

  // 2. Verify child process listeners are cleared
  if (childProcessListeners.length > 0) {
    issues.push(`childProcessListeners still has ${childProcessListeners.length} entries`);
  }

  // 3. Verify global process listeners are cleared
  if (globalProcessListeners.length > 0) {
    issues.push(`globalProcessListeners still has ${globalProcessListeners.length} entries`);
  }

  // 4. Verify app event listeners are cleared
  if (eventListeners.length > 0) {
    issues.push(`eventListeners still has ${eventListeners.length} entries`);
  }

  // 5. Verify service integration is nullified
  if (serviceIntegration && serviceIntegration.initialized !== false) {
    issues.push('ServiceIntegration may not be fully shut down');
  }

  // 6. Verify download watcher is cleared
  if (downloadWatcher != null) {
    issues.push('downloadWatcher is not null');
  }

  // 7. Verify tray is destroyed
  if (getTray() !== null) {
    issues.push('tray is not null');
  }

  // Log verification results
  if (issues.length === 0) {
    logger.info('[SHUTDOWN-VERIFY] All resources verified as released');
  } else {
    logger.warn(`[SHUTDOWN-VERIFY] Found ${issues.length} potential resource leaks:`);
    issues.forEach((issue) => logger.warn(`[SHUTDOWN-VERIFY]   - ${issue}`));
  }
}

/**
 * Handle before-quit event - performs all cleanup operations
 * @returns {Promise<void>}
 */
let _quitCleanupStarted = false;
async function handleBeforeQuit(/** @type {any} */ event) {
  if (event?.preventDefault) {
    event.preventDefault();
  }
  if (_quitCleanupStarted) return;
  _quitCleanupStarted = true;

  lifecycleConfig.setIsQuitting?.(true);

  // This must happen before any cleanup to prevent handlers accessing destroyed services
  try {
    const { setShuttingDown, waitForInFlightOperations } = require('./ipcRegistry');
    setShuttingDown(true);

    // Broadcast an abort to every in-flight IPC invoke that registered an
    // AbortController. Cooperative handlers (chat streams, batch organize,
    // embedding rebuilds) observe `event.abortSignal.aborted === true` and
    // bail out of long-running loops instead of fighting the drain below.
    try {
      const ipcAbortRegistry = require('./ipcAbortRegistry');
      const aborted = ipcAbortRegistry.abortAll('shutdown');
      if (aborted > 0) {
        logger.info(`[SHUTDOWN] Aborted ${aborted} in-flight IPC invocations`);
      }
    } catch (abortError) {
      logger.debug(`[SHUTDOWN] Abort broadcast skipped: ${abortError?.message || abortError}`);
    }

    try {
      const drained = await waitForInFlightOperations(5000);
      if (!drained) {
        logger.warn('[SHUTDOWN] In-flight IPC handlers did not finish before timeout');
      }
    } catch (ipcWaitError) {
      logger.warn('[SHUTDOWN] Failed waiting for IPC handlers to finish:', ipcWaitError.message);
    }
  } catch (e) {
    logger.warn('[SHUTDOWN] Could not set IPC shutdown gate:', e.message);
  }

  // Per-phase budgets avoid one slow step starving the others. The overall wall is the
  // sum + a small slack; any single phase that blows its budget is logged but the next
  // phase still runs. Prior behaviour was a single 12 s cap that could truncate Orama
  // final persist or embedding queue drain when earlier phases ran long.
  const PHASE_BUDGETS = {
    preCleanup: 2000, // shortcuts + timers + listener lists + IPC handlers
    ipcAndBatch: 10000, // batch analysis service drain + IPC takedown
    serviceIntegration: 20000, // SHUTDOWN_ORDER: watchers -> consumers -> Llama/Orama + Orama final persist
    workerPools: 10000, // piscina destroy (OCR/embedding/text extraction)
    startupManager: 5000, // idempotent; mostly clears health timers
    finalize: 2000 // tray, system analytics
  };
  const CLEANUP_WALL_MS = Object.values(PHASE_BUDGETS).reduce((a, b) => a + b, 0) + 5000; // slack
  const cleanupStartTime = Date.now();

  logger.info(`[SHUTDOWN] Starting cleanup (per-phase budgets, hard wall ${CLEANUP_WALL_MS}ms)...`);

  /** Runs a named phase with its own timeout; a timeout is logged, not thrown. */
  async function runPhase(
    /** @type {any} */ name,
    /** @type {any} */ budgetMs,
    /** @type {any} */ fn
  ) {
    const started = Date.now();
    try {
      await withTimeout(Promise.resolve().then(fn), budgetMs, `Shutdown phase "${name}"`);
      logger.info(`[CLEANUP] Phase "${name}" completed in ${Date.now() - started}ms`);
      return { ok: true };
    } catch (error) {
      const elapsed = Date.now() - started;
      if (error?.message?.includes('timed out')) {
        logger.error(
          `[CLEANUP] Phase "${name}" timed out after ${elapsed}ms (budget ${budgetMs}ms)`
        );
      } else {
        logger.error(`[CLEANUP] Phase "${name}" failed after ${elapsed}ms:`, error?.message);
      }
      return { ok: false, error };
    }
  }

  let shutdownExitCode = 0;

  const cleanupPromise = (async () => {
    // Phase 1: pre-cleanup (cheap, synchronous-ish). Cancel timers, unregister
    // shortcuts, remove listener lists. Must precede service shutdown so ticking
    // handlers don't fire against a half-torn-down stack.
    await runPhase('preCleanup', PHASE_BUDGETS.preCleanup, async () => {
      try {
        unregisterGlobalShortcuts();
        logger.info('[CLEANUP] Global shortcuts unregistered');
      } catch (error) {
        logger.warn('[CLEANUP] Failed to unregister global shortcuts:', error.message);
      }

      const metricsInterval = lifecycleConfig.getMetricsInterval?.();
      if (metricsInterval) {
        clearInterval(metricsInterval);
        lifecycleConfig.setMetricsInterval?.(null);
        logger.info('[CLEANUP] Metrics interval cleared');
      }

      const g = /** @type {any} */ (global);
      if (g.__reanalyzePollInterval) {
        clearInterval(g.__reanalyzePollInterval);
        g.__reanalyzePollInterval = null;
        logger.info('[CLEANUP] Reanalyze progress poll interval cleared');
      }

      _cancelUnhandledRejectionQuietTimer();

      const childProcessListeners = lifecycleConfig.getChildProcessListeners?.() || [];
      for (const cleanup of childProcessListeners) {
        try {
          cleanup();
        } catch (error) {
          logger.error('[CLEANUP] Failed to clean up child process listener:', error);
        }
      }
      lifecycleConfig.setChildProcessListeners?.([]);

      const globalProcessListeners = lifecycleConfig.getGlobalProcessListeners?.() || [];
      for (const cleanup of globalProcessListeners) {
        try {
          cleanup();
        } catch (error) {
          logger.error('[CLEANUP] Failed to clean up global process listener:', error);
        }
      }
      lifecycleConfig.setGlobalProcessListeners?.([]);

      const eventListeners = lifecycleConfig.getEventListeners?.() || [];
      for (const cleanup of eventListeners) {
        try {
          cleanup();
        } catch (error) {
          logger.error('[CLEANUP] Failed to clean up app event listener:', error);
        }
      }
      lifecycleConfig.setEventListeners?.([]);

      // DownloadWatcher is also reached via SHUTDOWN_ORDER; calling it here
      // first gives it its own budget and avoids it gating the serviceIntegration
      // phase. shutdown() (not stop()) latches the instance so an error-driven
      // restart queued mid-teardown cannot re-create the watcher.
      const downloadWatcher = lifecycleConfig.getDownloadWatcher?.();
      if (downloadWatcher) {
        try {
          await Promise.resolve(
            (downloadWatcher.shutdown ?? downloadWatcher.stop)?.call(downloadWatcher)
          );
          logger.info('[CLEANUP] Download watcher stopped');
        } catch (error) {
          logger.error('[CLEANUP] Failed to stop download watcher:', error);
        } finally {
          lifecycleConfig.setDownloadWatcher?.(null);
        }
      }
    });

    // Phase 2: drain IPC handlers + batch analysis service, then remove IPC listeners.
    // Batch analysis holds pending work that can race against vector/Llama shutdown if
    // left running past phase 3.
    await runPhase('ipcAndBatch', PHASE_BUDGETS.ipcAndBatch, async () => {
      try {
        const { shutdownBatchAnalysisService } = require('../ipc/analysis');
        await shutdownBatchAnalysisService?.();
        logger.info('[CLEANUP] Batch analysis service shut down');
      } catch (error) {
        logger.error('[CLEANUP] Failed to shut down batch analysis service:', error);
      }

      try {
        // Keep `system:log` registered past this pass so the renderer can keep
        // sending log lines while the rest of the cleanup runs. Without this
        // exclusion the shutdown log fills with 'No handler registered for
        // system:log' errors and we lose visibility into late-shutdown failures
        // (which are the most useful kind to diagnose). The handler dies
        // implicitly when the process exits.
        const { removeAllRegistered } = require('./ipcRegistry');
        const { IPC_CHANNELS } = require('../../shared/constants');
        const stats = removeAllRegistered(ipcMain, {
          excludeChannels: new Set([IPC_CHANNELS.SYSTEM.LOG])
        });
        logger.info(
          `[CLEANUP] IPC cleanup: ${stats.handlers} handlers, ${stats.listeners} listeners removed`
        );
      } catch (error) {
        logger.error('[CLEANUP] Failed to remove IPC listeners:', error);
      }

      // Dispose module-singleton services that live OUTSIDE the DI container.
      // Their lifetimes don't fit the container contract (ChatService swaps
      // with LlamaService, QueryProcessor uses local-fallback creation), so
      // container.shutdown() alone leaves them with active intervals and
      // subscriptions that prevent the process from exiting cleanly. This
      // runs before phase 3 so the instances release their references to
      // LlamaService / the cache invalidation bus before those are torn down.
      // MCP first: its chat_with_documents tool calls into ChatService, so
      // the HTTP server must stop accepting requests before ChatService is
      // disposed — otherwise an in-flight MCP call lands on a dead service.
      try {
        const { disposeMcp } = require('../ipc/mcp');
        await disposeMcp?.();
        logger.info('[CLEANUP] MCP server disposed');
      } catch (error) {
        logger.warn('[CLEANUP] disposeMcp failed:', error?.message || String(error));
      }

      try {
        const { disposeChatService } = require('../ipc/chat');
        disposeChatService?.();
        logger.info('[CLEANUP] ChatService disposed');
      } catch (error) {
        logger.warn('[CLEANUP] disposeChatService failed:', error?.message || String(error));
      }

      try {
        const {
          disposeLocalInstance: disposeQueryProcessor
        } = require('../services/QueryProcessor');
        await disposeQueryProcessor?.();
        logger.info('[CLEANUP] QueryProcessor local instance disposed');
      } catch (error) {
        logger.warn(
          '[CLEANUP] QueryProcessor.disposeLocalInstance failed:',
          error?.message || String(error)
        );
      }

      // Dispose the AI provider module singleton. It was previously ONLY
      // cleaned up via app.on('will-quit', ...) — but handleBeforeQuit ends
      // with `app.exit()` (line 415), which bypasses both before-quit and
      // will-quit per Electron docs. The will-quit handlers remain as a
      // fallback for SIGINT / SIGTERM / forced kills where this orderly
      // shutdown didn't run. (MCP, which had the same gap, is disposed above
      // before ChatService for ordering reasons.)
      try {
        const { disposeAiProvider } = require('../ipc/aiProvider');
        await disposeAiProvider?.();
        logger.info('[CLEANUP] AI provider disposed');
      } catch (error) {
        logger.warn('[CLEANUP] disposeAiProvider failed:', error?.message || String(error));
      }
    });

    // Phase 3: ServiceIntegration -> container.shutdown(SHUTDOWN_ORDER).
    // SHUTDOWN_ORDER guarantees watchers/consumers stop BEFORE LlamaService and
    // OramaVectorService, so nothing is still calling a dead AI/vector stack.
    // Orama final persist runs inside its own shutdown step here.
    const serviceIntegration = lifecycleConfig.getServiceIntegration?.();
    if (serviceIntegration) {
      await runPhase('serviceIntegration', PHASE_BUDGETS.serviceIntegration, async () => {
        await serviceIntegration.shutdown?.();
        logger.info('[CLEANUP] Service integration shut down');
      });
    }

    // Phase 4: destroy worker pools AFTER every consumer has been stopped in phase 3.
    // Destroying pools earlier (previous behaviour) could abort in-flight pool.run()
    // calls while ParallelEmbeddingService still believed the worker path was live.
    await runPhase('workerPools', PHASE_BUDGETS.workerPools, async () => {
      const { destroyPools } = require('../utils/workerPools');
      await destroyPools();
      logger.info('[CLEANUP] Worker pools destroyed');

      // Tesseract.js long-lived JS worker slots live OUTSIDE the Piscina pool
      // (they are spawned directly via Tesseract.createWorker() for CPU-cheap
      // repeat use). destroyPools() only kills the Piscina OCR pool, so these
      // slots would otherwise keep native child processes alive past the
      // lifecycle phase and block `app.quit()` from actually exiting.
      try {
        const { terminateJsWorker } = require('../utils/tesseractUtils');
        if (typeof terminateJsWorker === 'function') {
          await terminateJsWorker();
          logger.info('[CLEANUP] Tesseract JS workers terminated');
        }
      } catch (err) {
        logger.warn('[CLEANUP] Failed to terminate tesseract JS workers', {
          error: err?.message
        });
      }

      // The PDF extract→OCR buffer hand-off cache runs a sweep interval and
      // may still pin buffers from timed-out extractions.
      try {
        const { shutdownPdfBufferCache } = require('../analysis/documentExtractors');
        await shutdownPdfBufferCache();
      } catch (err) {
        logger.warn('[CLEANUP] Failed to shut down PDF buffer cache', { error: err?.message });
      }
    });

    // Phase 5: StartupManager cleanup is now mostly idempotent (LlamaService/Orama
    // already shut down in phase 3 and carry re-entrance guards). It still clears the
    // health monitor interval, which is its own concern.
    await runPhase('startupManager', PHASE_BUDGETS.startupManager, async () => {
      const startupManager = getStartupManager();
      await startupManager.shutdown();
      logger.info('[SHUTDOWN] StartupManager cleanup completed');
    });

    // Phase 6: tray + system analytics.
    await runPhase('finalize', PHASE_BUDGETS.finalize, async () => {
      destroyTray();

      if (!lifecycleConfig.getSettingsService?.()) {
        logger.warn(
          '[CLEANUP] Settings service not available — may indicate initialization failure'
        );
      }

      try {
        systemAnalytics.destroy();
        logger.info('[CLEANUP] System analytics destroyed');
      } catch (err) {
        logger.debug('[CLEANUP] systemAnalytics.destroy failed', {
          error: err?.message || String(err)
        });
      }
    });
  })();

  try {
    await withTimeout(cleanupPromise, CLEANUP_WALL_MS, 'Cleanup wall');
    const elapsed = Date.now() - cleanupStartTime;
    logger.info(`[SHUTDOWN] Cleanup completed in ${elapsed}ms`);
  } catch (error) {
    shutdownExitCode = 1;
    const elapsed = Date.now() - cleanupStartTime;
    if (error?.message?.includes('timed out')) {
      logger.error(
        `[SHUTDOWN] Cleanup exceeded hard wall of ${CLEANUP_WALL_MS}ms after ${elapsed}ms`
      );
    } else {
      logger.error(`[SHUTDOWN] Cleanup failed after ${elapsed}ms:`, error?.message);
    }
  }

  // This avoids the previous issue where 10s verification was nested inside 12s cleanup timeout
  try {
    await verifyShutdownCleanup();
  } catch (verifyError) {
    shutdownExitCode = 1;
    logger.warn('[SHUTDOWN-VERIFY] Verification failed:', verifyError.message);
  }

  // Flush and end all pino/sonic-boom streams before exiting.
  // This prevents the "sonic boom is not ready yet" uncaught exception
  // that occurs when process.exit fires while sonic-boom is still initializing.
  try {
    await shutdownLogging();
  } catch (logShutdownError) {
    shutdownExitCode = 1;
    // Best-effort; don't let logging teardown prevent app exit
    void logShutdownError;
  }

  // electron-updater skips autoInstallOnAppQuit when the process exits
  // non-zero. A degraded shutdown (cleanup timeout/rejection, verification or
  // log-flush failure) must not cost the user an already-downloaded update, so
  // the override is applied once here, at the single exit site.
  if (shutdownExitCode !== 0 && hasPendingDownloadedUpdate()) {
    logger.warn(
      '[SHUTDOWN] Shutdown degraded with a pending update; exiting 0 so the installer can run'
    );
    shutdownExitCode = 0;
  }

  // Cleanup complete — now exit the app (bypasses before-quit to avoid re-entrance)
  app.exit(shutdownExitCode);
}

/**
 * Handle window-all-closed event
 */
function handleWindowAllClosed() {
  // Check if background mode is enabled - if so, don't quit when windows are closed
  const settingsService = lifecycleConfig.getSettingsService?.();
  const backgroundMode = settingsService?.get?.('backgroundMode');

  if (backgroundMode) {
    logger.info('[LIFECYCLE] Background mode enabled - keeping app running in tray');
    return; // Don't quit, keep running in tray
  }

  // Use platform abstraction instead of direct isMacOS check
  const { shouldQuitOnAllWindowsClosed } = require('./platformBehavior');
  if (shouldQuitOnAllWindowsClosed()) {
    app.quit();
  }
}

/**
 * Handle activate event (macOS dock click)
 * @param {Function} createWindow - Function to create the main window
 */
function handleActivate(createWindow) {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
}

let _unhandledExceptionCount = 0;
let _unhandledRejectionCount = 0;
let _processWarningCount = 0;

/**
 * Classify error type for monitoring and debugging.
 * Delegates to the central errorClassifier for OS-level categories, then
 * extends with application-specific categories (MEMORY, VECTOR_DB, LLAMA).
 *
 * @param {Error|any} error - The error to classify
 * @returns {string} Error classification
 * @private
 * @see module:shared/errorClassifier
 */
function _classifyError(error) {
  // Delegate standard OS/FS/network categories to the central classifier
  const category = getErrorCategory(error);
  if (category !== ErrorCategory.UNKNOWN) {
    // Map central categories to the labels this module already uses in logs.
    // For categories without an explicit alias, return the raw classifier
    // category so newly-added categories (DISK_FULL, IO_ERROR, etc.) are not
    // silently flattened to UNKNOWN in the logs.
    const categoryMap = {
      [ErrorCategory.NETWORK_ERROR]: 'NETWORK',
      [ErrorCategory.TIMEOUT]: 'TIMEOUT',
      [ErrorCategory.FILE_NOT_FOUND]: 'FILE_NOT_FOUND',
      [ErrorCategory.PERMISSION_DENIED]: 'PERMISSION'
    };
    return categoryMap[category] ?? category;
  }

  // Application-specific categories not covered by errorClassifier
  const message = (error?.message || String(error)).toLowerCase();
  if (message.includes('out of memory') || message.includes('heap')) return 'MEMORY';
  if (message.includes('vector db') || message.includes('orama')) return 'VECTOR_DB';
  if (message.includes('llama')) return 'LLAMA';

  return 'UNKNOWN';
}

/**
 * True when an error is a benign cancellation/abort that leaked to the global
 * handler. An aborted or cancelled operation is an intentional stop, not a fatal
 * software fault — crashing the whole app on it (losing all in-progress work) is
 * strictly worse than logging and continuing. Covers AbortError, explicit
 * cancellation codes, "aborted/cancelled" messages, ECONNRESET from the
 * local llama/whisper subprocess dying under memory pressure, and EPIPE from
 * a worker's stdout closing (OCR/embedding pool under RAM pressure).
 *
 * @param {Error|any} error
 * @returns {boolean}
 * @private
 */
function _isBenignCancellation(error) {
  const name = error?.name;
  const code = /** @type {any} */ (error)?.code;
  if (name === 'AbortError') return true;
  if (
    code === 'ABORT_ERR' ||
    code === 'OPERATION_CANCELLED' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE'
  ) {
    return true;
  }
  const message = (error?.message || String(error)).toLowerCase();
  return /\b(aborted|cancelled|canceled)\b/.test(message);
}

/**
 * Handle uncaught exceptions
 * FIX: Enhanced with error classification and count tracking
 * @param {Error} error - The uncaught error
 */
function handleUncaughtException(error) {
  _unhandledExceptionCount++;
  const errorType = _classifyError(error);

  // A leaked abort/cancellation (e.g. "Vision request aborted" when a batch is
  // cancelled under memory pressure) must never exit the app. Log loudly and
  // continue instead of app.exit(1).
  if (_isBenignCancellation(error)) {
    logger.warn('[LIFECYCLE] Ignoring benign cancellation/abort in uncaughtException handler', {
      message: error?.message || String(error),
      code: /** @type {any} */ (error)?.code,
      name: error?.name,
      errorType,
      exceptionCount: _unhandledExceptionCount
    });
    return;
  }

  logger.error('UNCAUGHT EXCEPTION:', {
    message: error?.message || String(error),
    stack: error?.stack,
    code: /** @type {any} */ (error)?.code,
    errorType,
    exceptionCount: _unhandledExceptionCount
  });

  // For fatal errors (memory, etc.), we may want to force exit
  if (errorType === 'MEMORY') {
    logger.error('[LIFECYCLE] Critical memory error - application may become unstable');
  }

  // Trigger centralized error handler for critical failures to allow safe restart/quit
  try {
    const errorHandler = require('../errors/ErrorHandler');
    if (errorHandler.isInitialized) {
      errorHandler
        .handleCriticalError('An unexpected software error occurred.', error)
        .catch(() => {
          app.exit(1);
        });
    } else {
      app.exit(1);
    }
  } catch {
    app.exit(1);
  }
}

/**
 * Handle unhandled promise rejections
 * FIX: Enhanced with error classification, stack traces, and count tracking
 * @param {any} reason - The rejection reason
 * @param {Promise<any>} promise - The rejected promise
 */
function handleUnhandledRejection(reason, promise) {
  // Worker-stdio EPIPE / abort must not count toward the degraded-state
  // rejection volume (or look like a fatal async contract failure).
  if (_isBenignCancellation(reason)) {
    logger.warn('[LIFECYCLE] Ignoring benign cancellation/abort in unhandledRejection handler', {
      message: reason?.message || String(reason),
      code: /** @type {any} */ (reason)?.code,
      name: reason?.name
    });
    return;
  }

  _unhandledRejectionCount++;

  // Extract useful information from the reason
  const isError = reason instanceof Error;
  const message = isError ? reason.message : String(reason);
  const stack = isError ? reason.stack : new Error().stack;
  const code = reason?.code;
  const errorType = _classifyError(reason);
  // Run the Llama classifier too so a rejection that escapes from an AI
  // pathway gets a precise code (CPU incompat, VRAM exhaust, corrupt GGUF,
  // context overflow, model-not-found) in the structured log — previously
  // we only logged `errorType: LLAMA` which told an operator nothing about
  // which of those five very-different remediations actually applied.
  const llamaCode = classifyLlamaError(reason);

  logger.error('UNHANDLED REJECTION:', {
    message,
    stack,
    code,
    errorType,
    ...(llamaCode ? { llamaCode } : {}),
    rejectionCount: _unhandledRejectionCount,
    promiseInfo: String(promise)
  });

  // Log warning for common issues
  if (errorType === 'NETWORK') {
    logger.warn('[LIFECYCLE] Network-related unhandled rejection - check service connectivity');
  } else if (errorType === 'VECTOR_DB') {
    logger.warn('[LIFECYCLE] Vector DB-related unhandled rejection - check vector state');
  } else if (errorType === 'LLAMA') {
    logger.warn('[LIFECYCLE] AI engine-related unhandled rejection - check model state');
  }

  // Raise a degraded-state flag once rejection volume crosses a threshold.
  // A handful of unhandled rejections during bootstrap isn't actionable, but
  // sustained rejections indicate a broken async contract the user should be
  // aware of — otherwise `unhandledRejection` stays invisible forever while
  // data flow silently fails. Threshold is intentionally higher than the
  // exception handler's (which quits the app) because rejections are more
  // common to recover from.
  if (_unhandledRejectionCount === 5 || _unhandledRejectionCount === 25) {
    try {
      const tracker = require('../services/DegradedStateTracker').getInstance();
      tracker.raise({
        code: 'lifecycle.unhandled-rejection-volume',
        subsystem: 'lifecycle',
        severity: _unhandledRejectionCount >= 25 ? 'error' : 'warning',
        message:
          'Multiple unhandled promise rejections were observed. Some background work may be failing silently. Check the app log for details.',
        detail: {
          count: _unhandledRejectionCount,
          lastErrorType: errorType,
          ...(llamaCode ? { lastLlamaCode: llamaCode } : {})
        }
      });
      _unhandledRejectionDegradedRaised = true;
    } catch {
      // Tracker is best-effort; never re-throw from the global handler.
    }
  }
  // Renew (or set) the quiet-period timer that clears the banner once the
  // rejection storm subsides. Without this the banner sticks for the entire
  // session even when whatever async contract was broken has been fixed and
  // no further rejections fire — a long-running background-bug indicator
  // becomes a permanent UI blemish that operators learn to ignore.
  _scheduleUnhandledRejectionQuietClear();
}

/**
 * Handle Node.js process warnings (deprecations, experimental-API use, and
 * MaxListenersExceededWarning — a genuine memory-leak signal). Node prints
 * these to stderr only; without this handler they never reach the redacted
 * JSONL log that EXPORT_LOGS ships for field diagnostics, so a leak warning
 * that would explain a field issue stays invisible in the very artifact used
 * to debug it.
 * @param {Error & { code?: string, detail?: string }} warning - The warning
 */
function handleProcessWarning(warning) {
  _processWarningCount++;
  logger.warn('PROCESS WARNING:', {
    name: warning?.name || 'Warning',
    message: warning?.message || String(warning),
    code: warning?.code,
    stack: warning?.stack,
    ...(warning?.detail ? { detail: warning.detail } : {}),
    warningCount: _processWarningCount
  });
}

// 5 minutes of zero new rejections is enough to consider the storm over.
// Short enough that recoveries during a session are reflected, long enough
// that a flaky network spike (which can produce bursts spaced 30–60s apart)
// doesn't false-clear and re-raise repeatedly.
const UNHANDLED_REJECTION_QUIET_CLEAR_MS = 5 * 60 * 1000;
/** @type {any} */
let _unhandledRejectionQuietTimer = null;
let _unhandledRejectionDegradedRaised = false;

function _scheduleUnhandledRejectionQuietClear() {
  if (!_unhandledRejectionDegradedRaised) return;
  if (_unhandledRejectionQuietTimer) {
    clearTimeout(_unhandledRejectionQuietTimer);
  }
  _unhandledRejectionQuietTimer = setTimeout(() => {
    _unhandledRejectionQuietTimer = null;
    if (!_unhandledRejectionDegradedRaised) return;
    try {
      const tracker = require('../services/DegradedStateTracker').getInstance();
      tracker.clear('lifecycle.unhandled-rejection-volume');
      _unhandledRejectionDegradedRaised = false;
      logger.info('[LIFECYCLE] Unhandled-rejection banner cleared after quiet period', {
        quietMs: UNHANDLED_REJECTION_QUIET_CLEAR_MS,
        totalCount: _unhandledRejectionCount
      });
    } catch {
      // Tracker is best-effort; do not crash the lifecycle module.
    }
  }, UNHANDLED_REJECTION_QUIET_CLEAR_MS);
  if (typeof _unhandledRejectionQuietTimer.unref === 'function') {
    // Don't keep the event loop alive solely to clear a UI banner.
    _unhandledRejectionQuietTimer.unref();
  }
}

function _cancelUnhandledRejectionQuietTimer() {
  if (_unhandledRejectionQuietTimer) {
    clearTimeout(_unhandledRejectionQuietTimer);
    _unhandledRejectionQuietTimer = null;
  }
}

/**
 * Get unhandled error counts for monitoring
 * @returns {any} Counts of unhandled exceptions, rejections, and warnings
 */
function getUnhandledErrorCounts() {
  return {
    exceptions: _unhandledExceptionCount,
    rejections: _unhandledRejectionCount,
    warnings: _processWarningCount
  };
}

/**
 * Register all lifecycle event handlers
 * @param {Function} createWindow - Function to create the main window
 * @returns {any} Object containing cleanup functions
 */
function registerLifecycleHandlers(createWindow) {
  // Register before-quit handler
  app.on('before-quit', handleBeforeQuit);

  // OS shutdown and reboot do not go through before-quit. On macOS and
  // Linux, powerMonitor fires 'shutdown' first; preventDefault on that
  // event holds the OS off while the same cleanup runs (Orama final
  // persist, journal flush, user-data lock release). Windows has no
  // powerMonitor shutdown event; see attachSessionEndFlush. The guard
  // covers test doubles and Electron builds without powerMonitor.
  // powerMonitor is only usable after app ready, which is where this
  // function is called from (audit row LC-07).
  const powerMonitor = /** @type {any} */ (electron).powerMonitor;
  const shutdownHandler = (/** @type {any} */ event) => {
    logger.info('[SHUTDOWN] OS shutdown signalled; flushing state');
    void handleBeforeQuit(event);
  };
  if (powerMonitor && typeof powerMonitor.on === 'function') {
    powerMonitor.on('shutdown', shutdownHandler);
  }
  // The user-data lock's heartbeat timer sleeps with the machine; refresh it
  // the moment the machine is back so a launch right after wake never reads
  // this live instance as abandoned.
  const detachLockPowerMonitor = attachUserDataLockPowerMonitor(powerMonitor, logger);

  // Store handler references so they can be removed during cleanup
  const willQuitHandler = () => {
    logger.info('[SHUTDOWN] will-quit event - app will terminate');
  };
  const quitHandler = (/** @type {any} */ event, /** @type {any} */ exitCode) => {
    logger.info(`[SHUTDOWN] App quit with exit code: ${exitCode}`);
  };

  app.on('will-quit', willQuitHandler);
  app.on('quit', quitHandler);

  // Register window-all-closed handler
  app.on('window-all-closed', handleWindowAllClosed);

  // Register activate handler
  const activateHandler = () => handleActivate(createWindow);
  app.on('activate', activateHandler);

  // Global defense-in-depth for ANY webContents (not just the main window).
  // createWindow installs will-navigate / will-attach-webview / window-open
  // handlers on the main window, but a future BrowserWindow / WebContentsView
  // / DevTools surface / print-preview created elsewhere would inherit
  // Chromium defaults — outbound navigation to attacker URLs and arbitrary
  // window.open targets. Installing these guards on every webContents at
  // creation time closes that gap.
  const webContentsCreatedHandler = (/** @type {any} */ _event, /** @type {any} */ contents) => {
    contents.on('will-navigate', (/** @type {any} */ navEvent, /** @type {any} */ url) => {
      // Allow only local origins: app:// (production renderer), file:// (offline
      // fallback), and the dev http://localhost / http://127.0.0.1 servers.
      if (
        !url.startsWith('app://') &&
        !url.startsWith('file://') &&
        !url.startsWith('http://localhost') &&
        !url.startsWith('http://127.0.0.1')
      ) {
        logger.warn('[SECURITY] Blocked will-navigate to non-local URL', { url });
        navEvent.preventDefault();
      }
    });
    contents.on('will-attach-webview', (/** @type {any} */ attachEvent) => {
      logger.warn('[SECURITY] Blocked webview attachment');
      attachEvent.preventDefault();
    });
    contents.setWindowOpenHandler((/** @type {{ url: string }} */ { url }) => {
      logger.warn('[SECURITY] Blocked window.open', { url });
      return { action: 'deny' };
    });
  };
  app.on('web-contents-created', webContentsCreatedHandler);

  // Register process error handlers
  process.on('uncaughtException', handleUncaughtException);
  process.on('unhandledRejection', handleUnhandledRejection);
  process.on('warning', handleProcessWarning);

  logger.info('[LIFECYCLE] All lifecycle handlers registered');

  // Return cleanup functions for proper teardown
  return {
    cleanupAppListeners: () => {
      app.removeListener('before-quit', handleBeforeQuit);
      app.removeListener('will-quit', willQuitHandler);
      if (powerMonitor && typeof powerMonitor.removeListener === 'function') {
        powerMonitor.removeListener('shutdown', shutdownHandler);
      }
      detachLockPowerMonitor();
      app.removeListener('quit', quitHandler);
      app.removeListener('window-all-closed', handleWindowAllClosed);
      app.removeListener('activate', activateHandler);
    },
    cleanupProcessListeners: () => {
      process.removeListener('uncaughtException', handleUncaughtException);
      process.removeListener('unhandledRejection', handleUnhandledRejection);
      process.removeListener('warning', handleProcessWarning);
    }
  };
}

/**
 * Flush state when Windows ends the session (log off, restart, shutdown).
 * BrowserWindow emits 'session-end' on Windows only; other platforms are
 * covered by powerMonitor 'shutdown' in registerLifecycleHandlers. Windows
 * gives a process about five seconds after WM_ENDSESSION, so the cleanup
 * runs with its usual per-phase budgets and whatever finishes, finishes.
 * On an idle app the whole sequence takes well under that; a busy one
 * loses the tail (worker pool teardown, log shutdown), and a user-data
 * lock that never got released ages out through its heartbeat.
 * Idempotent: handleBeforeQuit runs once per process.
 * @param {any} window
 * @returns {() => void} detach function
 */
function attachSessionEndFlush(window) {
  if (!window || typeof window.on !== 'function') {
    return () => {};
  }
  const sessionEndHandler = () => {
    logger.info('[SHUTDOWN] Windows session end signalled; flushing state');
    void handleBeforeQuit();
  };
  window.on('session-end', sessionEndHandler);
  return () => {
    try {
      window.removeListener?.('session-end', sessionEndHandler);
    } catch {
      // window may already be destroyed
    }
  };
}

module.exports = {
  initializeLifecycle,
  registerLifecycleHandlers,
  attachSessionEndFlush,
  handleBeforeQuit,
  handleWindowAllClosed,
  handleActivate,
  handleUncaughtException,
  handleUnhandledRejection,
  handleProcessWarning,
  getUnhandledErrorCounts,
  verifyShutdownCleanup
};
