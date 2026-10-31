// @ts-check
const { app, BrowserWindow, ipcMain, dialog, shell, crashReporter } = require('electron');

// `.env` is a developer convenience only. A packaged app must never load one:
// a `.env` dropped next to a portable exe could rewrite the update-feed
// allowlist, flip NODE_ENV to development (dev-permissive IPC sender checks)
// or redirect userData. webpack's DefinePlugin folds NODE_ENV at build time,
// so production bundles drop this block (and any dotenv reference) entirely;
// app.isPackaged additionally guards a development bundle that gets packaged.
// dotenv is also externalized in webpack.main.config.js so its source is never
// bundled.
if (process.env.NODE_ENV !== 'production' && !app.isPackaged) {
  try {
    require('dotenv').config();
  } catch {
    /* dotenv is a devDependency; tolerate a pruned install */
  }
}

// Set the application name as early as possible.
// On macOS this controls the dock label and application menu title.
// Electron defaults to package.json "productName" → "name", but the raw Electron
// binary in development reports itself as "Electron" to the OS.  An explicit
// assignment ensures the correct name in all contexts (dock, Activity Monitor menu
// label, window title fallback) regardless of dev vs packaged mode.
app.name = 'StratoSort Stack';

// Allow E2E benchmarks / tests to redirect the user-data directory to an
// isolated location.  Must run before any code calls app.getPath('userData').
if (process.env.STRATOSORT_E2E_USER_DATA) {
  app.setPath('userData', process.env.STRATOSORT_E2E_USER_DATA);
}

// After webpack rebuilds, a cached main bundle can still reference old async chunk IDs while
// dist/ only contains the new numeric chunks — causing "Loading chunk N failed" for missing chunks.
// Packaged builds serve a fixed bundle from asar; dev/unpackaged iteration needs fresh HTTP fetches.
if (!app.isPackaged) {
  app.commandLine.appendSwitch('disable-http-cache');
}

// Register the custom app:// scheme as privileged BEFORE app `ready`. The
// production renderer is served from app:// (not file://) so storage APIs work
// with the grantFileProtocolExtraPrivileges fuse disabled. The per-session
// request handler is registered later, at window creation, in createWindow.js.
const { registerAppSchemePrivileged } = require('./core/appProtocol');
registerAppSchemePrivileged();

const isDev = process.env.NODE_ENV === 'development';

// Tell the IPC sender validator whether this is a dev build. The validator
// no longer consults NODE_ENV directly (defense against env-var leaks in
// packaged builds); production calls this with false and origin checks stay
// strict. Permissive mode only relaxes the "missing senderURL" branch — bad
// origins are still rejected even in dev.
require('./ipc/ipcSenderValidator').setDevPermissive(isDev);

// Logging utility
const fs = require('fs').promises;
const path = require('path');
const {
  createLogger,
  configureFileLogging,
  configureConsoleLogging,
  setGlobalLogLevel
} = require('../shared/logger');
const { withTimeout } = require('../shared/promiseUtils');
const perfMarks = require('../shared/perfMarks');

// Main-process startup baseline. Dropped at require-time so every
// subsequent mark (app.whenReady, services ready, window created) can be
// measured back to module evaluation in DevTools / perf_hooks consumers.
perfMarks.mark('startup:main:module-eval');

const logger = createLogger('Main');

// Local crash dumps only. Crash minidumps are written under userData with
// `uploadToServer: false` — nothing is ever transmitted off the device. This
// is privacy-preserving by construction (no third-party crash telemetry, no
// upload endpoint) and runs unconditionally so post-mortem debugging is
// available without any opt-in.
app
  .whenReady()
  .then(
    /** @returns {void} */ () => {
      try {
        const crashDumpsDir = path.join(app.getPath('userData'), 'crash-dumps');
        app.setPath('crashDumps', crashDumpsDir);
        crashReporter.start({
          uploadToServer: false
        });
        logger.info('[CRASH-REPORTER] Initialized locally', { crashDumpsDir });
      } catch (error) {
        logger.error('[CRASH-REPORTER] Failed to initialize:', error.message);
      }
      return undefined;
    }
  )
  .catch((err) => {
    // app.whenReady() is documented as never rejecting, but a defensive
    // .catch() turns any future Electron change into a logged warning rather
    // than an unhandled rejection.
    logger.warn('[CRASH-REPORTER] whenReady chain rejected', { error: err?.message });
  });

// Import error handling system
const errorHandler = require('./errors/ErrorHandler');

const { scanDirectory } = require('./folderScanner');
const {
  setTextModel,
  setVisionModel,
  setEmbeddingModel,
  loadLlamaConfig
} = require('./llamaUtils');
const { getInstance: getSettingsService } = require('./services/SettingsService');
// Import service integration
const ServiceIntegration = require('./services/ServiceIntegration');

// Import startup manager
const { getStartupManager } = require('./services/startup');

// Import shared constants
const { IPC_CHANNELS, IPC_EVENTS } = require('../shared/constants');
const { TIMEOUTS } = require('../shared/performanceConstants');

// Import path sanitization for security checks
const { isPathDangerous } = require('../shared/pathSanitization');

// Import IPC wrappers for safe event sending
const { safeSend } = require('./ipc/ipcWrappers');

// Import services
const { analyzeDocumentFile } = require('./analysis/documentAnalysis');
const { analyzeImageFile } = require('./analysis/imageAnalysis');
const { createMediaAnalyzerAdapter } = require('./services/mediaAnalyzerAdapter');
const { getInstance: getWhisperService } = require('./services/WhisperService');

// Per-dispatch media analyzer. Resolves WhisperService at call time (not module
// load time) so the watcher gets the live singleton — building the adapter
// once at startup would capture a null reference if WhisperService isn't yet
// registered when watcher wiring runs. Mirrors BatchAnalysisService's
// resolveAnalyzerForSection('media') pattern.
function safeGetWhisperService() {
  try {
    return getWhisperService();
  } catch {
    return null;
  }
}

const analyzeMediaFile = (
  /** @type {any} */ filePath,
  /** @type {any} */ smartFolders,
  /** @type {any} */ options
) => {
  const adapter = createMediaAnalyzerAdapter({ whisperService: safeGetWhisperService() });
  return adapter(filePath, smartFolders, options);
};

// Import OCR library
// platformUtils imported in core/jumpList.js for Windows detection

// Extracted core modules
const {
  initializeGpuConfig,
  handleGpuProcessGone,
  forceSoftwareRenderer
} = require('./core/gpuConfig');
const {
  LEGACY_MACOS_SINGLE_INSTANCE_LOCK_DISABLED_BELOW_MAJOR,
  shouldUseSingleInstanceLock
} = require('./core/singleInstanceLockGate');
const { acquireUserDataLock, releaseUserDataLock } = require('./core/userDataLock');
const { createApplicationMenu } = require('./core/applicationMenu');
const {
  initializeTrayConfig,
  createSystemTray,
  updateTrayMenu,
  registerGlobalShortcut
} = require('./core/systemTray');
const { verifyIpcHandlersRegistered } = require('./core/ipcVerification');
const {
  initializeLifecycle,
  registerLifecycleHandlers,
  attachSessionEndFlush
} = require('./core/lifecycle');
const { initializeAutoUpdater, setAutoUpdateCheckEnabled } = require('./core/autoUpdater');
const { initializeJumpList, handleCommandLineTasks } = require('./core/jumpList');
const { runBackgroundSetup } = require('./core/backgroundSetup');
const { waitForFirstPaint } = require('./core/firstPaintGate');
const { migrateUserDataState } = require('./core/userDataMigration');

// Windows integrations (Jump List, notifications, taskbar grouping) require AppUserModelId.
// Set it as early as possible so it applies even before any windows are created.
if (process.platform === 'win32') {
  try {
    // In development, setting a custom AUMID causes Windows to ignore the window icon
    // and fall back to the electron.exe default icon because no shortcut exists for the AUMID.
    if (app.isPackaged) {
      app.setAppUserModelId('com.stratosort.app');
    } else {
      app.setAppUserModelId(process.execPath);
    }
  } catch (error) {
    logger.debug('Failed to set AppUserModelId', { error: error?.message });
  }
}

/** @type {any} */
let mainWindow;
/** @type {any[]} */
let customFolders = []; // Initialize customFolders at module level

// Initialize service integration
/** @type {any} */
let serviceIntegration;
/** @type {any} */
let settingsService;
/** @type {any} */
let licenseService;
/** @type {any} */
let downloadWatcher;
/** @type {Record<string, any>} */
let currentSettings = {};
let downloadWatcherStartInProgress = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let downloadWatcherRetryTimer = null;
let downloadWatcherRetryDelayMs = 250;
const DOWNLOAD_WATCHER_RETRY_MAX_MS = 5000;
// One-shot log gates for the AutoOrganize watcher start path. The retry
// loop self-resolves once StartupManager finishes wiring services; without
// these flags the same warning fired 6+ times during normal startup.
const _loggedAutoOrganizeNotReady = {
  servicesNotInitialized: false,
  serviceUnavailable: false
};
// Previously had separate isQuitting and _forceQuit flags that could get out of sync
const _shutdownState = {
  isQuitting: false, // Set by lifecycle during async cleanup
  forceQuit: false, // Set synchronously via prependListener before async cleanup
  get shouldClose() {
    // Combined getter - returns true if app is in any shutdown state
    return this.isQuitting || this.forceQuit;
  }
};
// Backward compatibility aliases (prefixed with _ as they're set via helpers, not used directly)
let _isQuitting = false;
let _forceQuit = false;
// Sync helper to update both the state object and legacy variables
const setIsQuitting = (/** @type {any} */ val) => {
  _isQuitting = val;
  _shutdownState.isQuitting = val;
};
const setForceQuit = (/** @type {any} */ val) => {
  _forceQuit = val;
  _shutdownState.forceQuit = val;
};
// Track cleanup handlers for proper memory management
/** @type {ReturnType<typeof setInterval> | null} */
let metricsInterval = null;
/** @type {any[]} */
let eventListeners = [];
/** @type {any[]} */
let childProcessListeners = [];
/** @type {any[]} */
let globalProcessListeners = [];

// Ensure any tracked timers are cleared during shutdown
eventListeners.push(() => {
  clearAllTrackedTimers();
});
// Worker pool cleanup (OCR + embedding) is handled by lifecycle.handleBeforeQuit
// via destroyPools(). Registering it here as well would cause redundant drain
// attempts and add ~5-10s to shutdown when drain timeouts are hit twice.

const trackedTimers = new Map();
const trackTimeout = (/** @type {any} */ handler, /** @type {any} */ delay) => {
  const timeout = setTimeout(() => {
    trackedTimers.delete(timeout);
    handler();
  }, delay);
  trackedTimers.set(timeout, 'timeout');
  return timeout;
};
const trackInterval = (/** @type {any} */ handler, /** @type {any} */ delay) => {
  const interval = setInterval(handler, delay);
  trackedTimers.set(interval, 'interval');
  return interval;
};
const clearTrackedTimer = (/** @type {any} */ id) => {
  if (!id) return;
  const type = trackedTimers.get(id);
  if (type === 'interval') {
    clearInterval(id);
  } else {
    clearTimeout(id);
  }
  trackedTimers.delete(id);
};
const clearAllTrackedTimers = () => {
  for (const [id, type] of trackedTimers.entries()) {
    if (type === 'interval') {
      clearInterval(id);
    } else {
      clearTimeout(id);
    }
  }
  trackedTimers.clear();
};

// Background setup status is now tracked in ./core/backgroundSetup module

// NOTE: Startup logic is handled by StartupManager and ServiceIntegration
// IPC verification is handled by ./core/ipcVerification

// ===== GPU PREFERENCES (Windows rendering stability) =====
// GPU configuration is now handled by ./core/gpuConfig
initializeGpuConfig();
app.on('child-process-gone', handleGpuProcessGone);
eventListeners.push(() => app.removeListener('child-process-gone', handleGpuProcessGone));

// Custom folders helpers
const { loadCustomFolders, saveCustomFolders } = require('./core/customFolders');

// System monitoring and analytics
const systemAnalytics = require('./core/systemAnalytics');

// Window creation
const createMainWindow = require('./core/createWindow');

// Application menu is now handled by ./core/applicationMenu
// createApplicationMenu is imported and called with getMainWindow callback

/** @type {Promise<void> | null} */
let _windowCreationPromise = null;

function createWindow() {
  if (_shutdownState.shouldClose) {
    logger.warn('[WINDOW] Ignoring createWindow() during shutdown');
    return Promise.resolve();
  }
  if (_windowCreationPromise) {
    logger.debug('[WINDOW] createWindow() already in progress, waiting...');
    return _windowCreationPromise;
  }

  logger.debug('[WINDOW] createWindow() called');

  // Use event-driven window state manager instead of nested setTimeout
  const { restoreWindow, ensureWindowOnScreen } = require('./core/windowState');

  if (mainWindow && !mainWindow.isDestroyed()) {
    logger.debug('[WINDOW] Window already exists, restoring state...');

    // Use event-driven restoration (replaces complex setTimeout chain)
    restoreWindow(mainWindow).catch((error) => {
      logger.error('[WINDOW] Error during window state restoration:', error);
    });

    // Ensure window is on screen (handle multi-monitor issues)
    ensureWindowOnScreen(mainWindow);

    return Promise.resolve();
  }

  // runs synchronously and may set _windowCreationPromise = null before the return statement
  const promise = new Promise((resolve) => {
    try {
      // Double-check after acquiring mutex (another call might have created window)
      if (mainWindow && !mainWindow.isDestroyed()) {
        logger.debug('[WINDOW] Window created by concurrent call, using existing');
        _windowCreationPromise = null;
        resolve();
        return;
      }

      _createWindowInternal();

      // Wait for window to be ready before releasing mutex
      if (mainWindow) {
        /** @type {any} */
        let creationTimeout;

        const onReadyToShow = () => {
          logger.debug('[WINDOW] Window ready, releasing creation mutex');
          if (creationTimeout) clearTrackedTimer(creationTimeout);
          _windowCreationPromise = null;
          resolve();
        };

        mainWindow.once('ready-to-show', onReadyToShow);

        creationTimeout = trackTimeout(() => {
          if (_windowCreationPromise) {
            logger.warn('[WINDOW] Window creation timeout, releasing mutex');
            // Remove the listener to avoid memory leak or late execution
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.removeListener('ready-to-show', onReadyToShow);
              // Last line of defence after createWindow.js's own show fallback:
              // a window that is still hidden after a minute must not stay so.
              if (!mainWindow.isVisible()) {
                logger.warn('[WINDOW] Force-showing window after creation timeout');
                mainWindow.show();
              }
            }
            _windowCreationPromise = null;
            resolve();
          }
        }, TIMEOUTS.WINDOW_CREATION_READY);
      } else {
        _windowCreationPromise = null;
        resolve();
      }
    } catch (error) {
      logger.error('[WINDOW] Error creating window:', error);
      _windowCreationPromise = null;
      resolve();
    }
  });
  _windowCreationPromise = promise;

  return promise;
}

/**
 * Internal window creation logic (extracted for mutex wrapper)
 * @private
 */
function _createWindowInternal() {
  // No existing window, create a new one
  mainWindow = createMainWindow();

  // Windows log off / restart / shutdown skips before-quit; flush through
  // the window's session-end event instead (audit row LC-07).
  attachSessionEndFlush(mainWindow);

  // Store event handlers for proper cleanup
  const windowEventHandlers = new Map();

  // Add state change event listeners for debugging
  const minimizeHandler = () => {
    logger.debug('[WINDOW] Window minimized');
  };
  windowEventHandlers.set('minimize', minimizeHandler);
  mainWindow.on('minimize', minimizeHandler);

  const restoreHandler = () => {
    logger.debug('[WINDOW] Window restored');
  };
  windowEventHandlers.set('restore', restoreHandler);
  mainWindow.on('restore', restoreHandler);

  const showHandler = () => {
    logger.debug('[WINDOW] Window shown');
  };
  windowEventHandlers.set('show', showHandler);
  mainWindow.on('show', showHandler);

  const hideHandler = () => {
    logger.debug('[WINDOW] Window hidden');
  };
  windowEventHandlers.set('hide', hideHandler);
  mainWindow.on('hide', hideHandler);

  const focusHandler = () => {
    logger.debug('[WINDOW] Window focused');
  };
  windowEventHandlers.set('focus', focusHandler);
  mainWindow.on('focus', focusHandler);

  const blurHandler = () => {
    logger.debug('[WINDOW] Window lost focus');
  };
  windowEventHandlers.set('blur', blurHandler);
  mainWindow.on('blur', blurHandler);

  const closeHandler = (/** @type {any} */ e) => {
    if (!_shutdownState.shouldClose && currentSettings?.backgroundMode) {
      e.preventDefault();
      mainWindow.hide();
    }
  };
  windowEventHandlers.set('close', closeHandler);
  mainWindow.on('close', closeHandler);

  const closedHandler = () => {
    if (windowEventHandlers.size > 0) {
      for (const [event, handler] of windowEventHandlers) {
        try {
          // Check if window still exists and is not destroyed before removing listener
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.removeListener(event, handler);
          }
        } catch (e) {
          logger.error(`[WINDOW] Failed to remove ${event} listener:`, e);
        }
      }
      windowEventHandlers.clear();
    }
    mainWindow = null;
  };
  windowEventHandlers.set('closed', closedHandler);
  mainWindow.on('closed', closedHandler);

  // is destroyed without triggering 'closed' event
  const destroyHandler = () => {
    logger.warn('[WINDOW] Window destroyed - forcing cleanup');
    closedHandler();
  };
  mainWindow.once('destroy', destroyHandler);

  // Register global cleanup to ensure listeners are removed on app quit
  // even if window is hidden (background mode)
  eventListeners.push(() => {
    if (windowEventHandlers.size > 0) {
      logger.debug('[CLEANUP] Forcing window listener cleanup on app quit');
      closedHandler();
    }
  });
}

function updateDownloadWatcher(/** @type {any} */ settings) {
  const enabled = settings?.autoOrganize;
  const clearDownloadWatcherRetry = () => {
    if (downloadWatcherRetryTimer) {
      clearTrackedTimer(downloadWatcherRetryTimer);
      downloadWatcherRetryTimer = null;
    }
    downloadWatcherRetryDelayMs = 250;
  };
  const scheduleDownloadWatcherRetry = (/** @type {any} */ reason) => {
    if (!enabled) return;
    if (downloadWatcher || downloadWatcherStartInProgress || downloadWatcherRetryTimer) return;
    const delayMs = downloadWatcherRetryDelayMs;
    downloadWatcherRetryDelayMs = Math.min(
      downloadWatcherRetryDelayMs * 2,
      DOWNLOAD_WATCHER_RETRY_MAX_MS
    );
    logger.debug('[AUTO-ORGANIZE] Scheduling watcher start retry', {
      reason,
      delayMs
    });
    downloadWatcherRetryTimer = trackTimeout(() => {
      downloadWatcherRetryTimer = null;
      updateDownloadWatcher(currentSettings || settings);
    }, delayMs);
  };

  if (enabled) {
    if (downloadWatcher) {
      clearDownloadWatcherRetry();
      return;
    }
    if (downloadWatcherStartInProgress) {
      return;
    }
    // This prevents race condition where watcher starts with null service references.
    // Demoted to debug + log-once because the caller is on a retry loop that
    // self-resolves once StartupManager finishes wiring services. The previous
    // warn-per-tick pattern produced 6+ identical warnings during normal startup
    // (observed in production logs over a ~10s window) with no actionable signal
    // beyond the first one. The retry mechanism still kicks in via
    // scheduleDownloadWatcherRetry; we just stop spamming the log with the same
    // string while it runs.
    if (!serviceIntegration?.initialized) {
      if (!_loggedAutoOrganizeNotReady.servicesNotInitialized) {
        _loggedAutoOrganizeNotReady.servicesNotInitialized = true;
        logger.debug('[AUTO-ORGANIZE] Deferring watcher start until services initialize');
      }
      scheduleDownloadWatcherRetry('service-integration-not-initialized');
      return;
    }
    if (!serviceIntegration?.autoOrganizeService) {
      if (!_loggedAutoOrganizeNotReady.serviceUnavailable) {
        _loggedAutoOrganizeNotReady.serviceUnavailable = true;
        logger.debug(
          '[AUTO-ORGANIZE] Deferring watcher start until autoOrganizeService is registered'
        );
      }
      scheduleDownloadWatcherRetry('auto-organize-service-unavailable');
      return;
    }
    // Both gates passed — reset the log-once flags so a future re-entry (e.g.
    // service teardown then re-init for a multi-window flow) gets its own
    // single warning if needed.
    _loggedAutoOrganizeNotReady.servicesNotInitialized = false;
    _loggedAutoOrganizeNotReady.serviceUnavailable = false;
    if (!downloadWatcher) {
      downloadWatcherStartInProgress = true;
      const finalizeStart = (/** @type {any} */ success) => {
        downloadWatcherStartInProgress = false;
        if (success) {
          clearDownloadWatcherRetry();
        }
      };
      const { container, ServiceIds } = require('./services/ServiceContainer');
      downloadWatcher = container.tryResolve(ServiceIds.DOWNLOAD_WATCHER);
      if (!downloadWatcher) {
        logger.warn('[AUTO-ORGANIZE] Download watcher not available');
        finalizeStart(false);
        scheduleDownloadWatcherRetry('download-watcher-not-available');
        return;
      }

      // Ensure container-managed watcher has required dependencies
      serviceIntegration?.configureDownloadWatcher?.({
        getCustomFolders: () => customFolders,
        analyzeDocumentFile,
        analyzeImageFile,
        analyzeMediaFile
      });

      try {
        const started = downloadWatcher.start?.();
        if (started && typeof started.then === 'function') {
          started
            .then(
              /** @returns {void} */ () => {
                logger.info('[AUTO-ORGANIZE] Download watcher started successfully');
                finalizeStart(true);
                return undefined;
              }
            )
            .catch((/** @type {any} */ error) => {
              logger.warn('[AUTO-ORGANIZE] Download watcher failed to start', {
                error: error?.message
              });
              downloadWatcher = null;
              finalizeStart(false);
              scheduleDownloadWatcherRetry('download-watcher-start-failed');
            });
          return;
        }
        logger.info('[AUTO-ORGANIZE] Download watcher started successfully');
        finalizeStart(true);
      } catch (error) {
        logger.warn('[AUTO-ORGANIZE] Download watcher failed to start', {
          error: error?.message
        });
        downloadWatcher = null;
        finalizeStart(false);
        scheduleDownloadWatcherRetry('download-watcher-start-threw');
      }
    }
  } else if (downloadWatcher) {
    clearDownloadWatcherRetry();
    downloadWatcherStartInProgress = false;
    // stop(), not shutdown(): the watcher is a container singleton and must
    // stay resumable for when auto-organize is re-enabled.
    downloadWatcher.stop().catch((/** @type {any} */ error) => {
      logger.warn('[AUTO-ORGANIZE] Download watcher stop failed', { error: error?.message });
    });
    downloadWatcher = null;
    logger.info('[AUTO-ORGANIZE] Download watcher stopped');
  } else {
    clearDownloadWatcherRetry();
    downloadWatcherStartInProgress = false;
  }
}

// Note: Smart folder watching is always enabled - files added to smart folders are automatically analyzed
// The watcher is started automatically during service initialization in ServiceIntegration.js

function handleSettingsChanged(/** @type {any} */ settings, /** @type {any} */ metadata = {}) {
  // Validate settings structure before use
  if (!settings || typeof settings !== 'object') {
    logger.warn('[SETTINGS] Invalid settings received, using defaults');
    currentSettings = {};
    return;
  }

  currentSettings = settings;
  const source =
    metadata && typeof metadata.source === 'string' && metadata.source ? metadata.source : 'main';
  const timestamp =
    metadata && typeof metadata.timestamp === 'number' ? metadata.timestamp : Date.now();

  // Keep renderer consumers in sync for runtime setting changes triggered
  // outside SettingsPanel (e.g., tray actions, imports, restores).
  try {
    const eventPayload = {
      settings,
      source,
      timestamp
    };
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((win) => {
      if (win && !win.isDestroyed() && win.webContents) {
        safeSend(win.webContents, IPC_EVENTS.SETTINGS_CHANGED_EXTERNAL, eventPayload);
      }
    });
  } catch (error) {
    logger.warn('[SETTINGS] Failed to notify renderer about settings change:', error?.message);
  }

  updateDownloadWatcher(settings);
  // Smart folder watching honors the `smartFolderWatchEnabled` setting live via
  // smartFolderWatcher.applySettings() below (start/stop), not just at startup.
  // Propagate confidence threshold to auto-organize service (so it doesn't stick to defaults)
  try {
    serviceIntegration?.autoOrganizeService?.applySettings?.(settings);
  } catch (error) {
    logger.warn('[SETTINGS] Failed to apply settings to auto-organize service:', error?.message);
  }
  try {
    serviceIntegration?.smartFolderWatcher?.applySettings?.(settings);
  } catch (error) {
    logger.warn('[SETTINGS] Failed to apply settings to smart folder watcher:', error?.message);
  }
  try {
    updateTrayMenu();
  } catch (error) {
    logger.warn('[SETTINGS] Failed to update tray menu:', error);
  }
}

async function runCoordinatedStartupInBackground(
  /** @type {any} */ startupManager,
  /** @type {any} */ integration
) {
  const COORDINATED_STARTUP_TIMEOUT = TIMEOUTS.SERVICE_STARTUP + 15000; // 45s
  const coordinatedStartupController = new AbortController();
  const { signal: coordinatedStartupSignal } = coordinatedStartupController;
  let timedOut = false;
  let timeoutId;

  const abortCoordinatedStartup = (/** @type {any} */ reason) => {
    if (!coordinatedStartupSignal.aborted) {
      coordinatedStartupController.abort(reason);
    }
  };

  const coordinatedStartup = async () => {
    logger.info('[STARTUP] Phase 1: Starting AI services...');
    const servicesResult = await startupManager.startup({ signal: coordinatedStartupSignal });
    if (coordinatedStartupSignal.aborted) {
      throw new Error('Coordinated startup aborted before service integration');
    }

    logger.info('[STARTUP] Phase 2: Initializing service integration...');
    await integration.initialize({
      startupResult: servicesResult,
      signal: coordinatedStartupSignal
    });

    return servicesResult;
  };

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      abortCoordinatedStartup('Coordinated startup timeout');
      startupManager.abortStartup('Coordinated startup timeout');
      reject(
        new Error(`Coordinated startup timeout after ${COORDINATED_STARTUP_TIMEOUT / 1000} seconds`)
      );
    }, COORDINATED_STARTUP_TIMEOUT);
  });

  try {
    const coordinatedStartupPromise = coordinatedStartup().catch((error) => {
      if (timedOut) {
        logger.error('[STARTUP] Coordinated startup failed after timeout', {
          message: error?.message || 'Unknown error',
          stack: error?.stack
        });
        return {
          degraded: true,
          error: error?.message || 'Coordinated startup failed after timeout',
          lateFailure: true
        };
      }
      throw error;
    });

    const startupResult = await Promise.race([coordinatedStartupPromise, timeoutPromise]);
    logger.info('[STARTUP] Coordinated startup completed successfully');
    return startupResult;
  } catch (error) {
    logger.error('[STARTUP] Coordinated startup failed:', {
      message: error?.message || 'Unknown error',
      stack: error?.stack
    });
    logger.warn('[STARTUP] Continuing startup in degraded mode');
    return { degraded: true, error: error.message };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function scheduleLearningStartupScan(/** @type {any} */ serviceIntegrationInstance) {
  const scheduleScan = () => {
    trackTimeout(() => {
      serviceIntegrationInstance
        ?.runLearningStartupScan?.({
          maxFilesPerFolder: 50,
          onlyWithAnalysis: true
        })
        .catch((/** @type {any} */ err) => {
          logger.debug('[MAIN] Learning startup scan failed (non-critical):', err?.message);
        });
    }, 10000);
  };

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.webContents.isLoading()) {
      mainWindow.webContents.once('did-finish-load', scheduleScan);
    } else {
      scheduleScan();
    }
    return;
  }

  scheduleScan();
}

async function verifyModelsInBackground(/** @type {any} */ startupManager) {
  const serviceStatus = startupManager?.getServiceStatus?.();
  if (serviceStatus?.services?.llama?.status !== 'running') return;

  const { getInstance: getModelManager } = require('./services/ModelManager');
  const modelManager = getModelManager();
  try {
    await withTimeout(
      modelManager.ensureWorkingModel(),
      10000, // 10 second timeout for model verification
      'Model verification'
    );
    logger.info('[STARTUP] ✅ AI models verified and ready');
  } catch (err) {
    if (err.message?.includes('timed out')) {
      logger.warn('[STARTUP] Model verification timed out - will retry on first use');
    } else {
      logger.warn('[STARTUP] Model verification warning:', err.message);
    }
  }
}

// ===== IPC HANDLERS =====
const { registerAllIpc, IpcServiceContext } = require('./ipc');
let _ipcHandlersRegistered = false;
let _lifecycleRegistered = false;

// Prevent multiple instances
// proceed anyway. This provides an escape hatch when a zombie process
// holds the lock and the user cannot start the app.
const macOSSystemVersion = process.platform === 'darwin' ? process.getSystemVersion() : null;
const shouldRequestSingleInstanceLock = shouldUseSingleInstanceLock({
  platform: process.platform,
  isPackaged: app.isPackaged,
  systemVersion: macOSSystemVersion,
  logger
});
const gotTheLock = shouldRequestSingleInstanceLock ? app.requestSingleInstanceLock() : true;

if (shouldRequestSingleInstanceLock) {
  logger.info('[STARTUP] Single instance lock:', gotTheLock);
} else {
  logger.warn(
    '[STARTUP] Skipping single-instance lock on older macOS to avoid Electron startup crash',
    {
      systemVersion: macOSSystemVersion,
      disabledBelowMajor: LEGACY_MACOS_SINGLE_INSTANCE_LOCK_DISABLED_BELOW_MAJOR
    }
  );
}

if (!gotTheLock) {
  if (process.env.STRATOSORT_FORCE_LAUNCH === '1') {
    logger.warn('[STARTUP] Lock failed but STRATOSORT_FORCE_LAUNCH is set — continuing');
  } else {
    logger.info(
      '[STARTUP] Failed to get lock, quitting (set STRATOSORT_FORCE_LAUNCH=1 to override)'
    );
    // app.quit() is async and allows further module-level execution.
    // Use app.exit() to terminate immediately before startup proceeds.
    app.exit(0);
  }
}

// Proceed with setup (runs for both lock holder and forced launches).
// Before we touch any persistent data we acquire a filesystem-level lock on
// the userData directory. This protects Orama / SQLite stores from two live
// processes writing concurrently when STRATOSORT_FORCE_LAUNCH bypasses the
// Electron single-instance lock (or when the Electron lock is skipped on
// macOS <14 to avoid a historical startup crash — see
// singleInstanceLockGate.js, LEGACY_MACOS_SINGLE_INSTANCE_LOCK_DISABLED_BELOW_MAJOR).
//
// The DB-level lock is the authority for data integrity: even FORCE_LAUNCH
// cannot bypass it. If we can't get it we exit.
if (gotTheLock || process.env.STRATOSORT_FORCE_LAUNCH === '1') {
  const userDataPathForLock = app.getPath('userData');
  const isForceLaunch = process.env.STRATOSORT_FORCE_LAUNCH === '1' && !gotTheLock;
  const dataLockResult = acquireUserDataLock({
    userDataPath: userDataPathForLock,
    logger,
    // FORCE_LAUNCH callers must refuse to reclaim a fresh / mid-startup
    // lock file. A normal launch (held Electron's single-instance token)
    // keeps the original aggressive reclaim because nothing else can be
    // legitimately holding the lock at that point.
    isForceLaunch
  });
  if (!dataLockResult.acquired) {
    logger.error('[STARTUP] Refusing to start: user-data lock unavailable', {
      reason: dataLockResult.reason,
      lockPath: dataLockResult.lockPath,
      holderPid: dataLockResult.holderPid,
      error: dataLockResult.error,
      forceLaunch: isForceLaunch,
      note:
        dataLockResult.reason === 'another-instance-starting'
          ? 'Another instance is mid-startup. Wait a few seconds and retry — FORCE_LAUNCH cannot race past an initializing primary.'
          : 'STRATOSORT_FORCE_LAUNCH cannot override this lock; it exists to prevent Orama/SQLite corruption from concurrent instances.'
    });
    // A refused lock used to exit with nothing on screen, so a user whose
    // last session died uncleanly saw the app "not launch" with no clue
    // (audit row LC-02). Say what happened and where the lock lives. The
    // heartbeat makes a lock from a dead holder reclaimable after five
    // minutes even when the OS has reused its PID.
    try {
      const lockHolderNote =
        dataLockResult.reason === 'another-instance-starting'
          ? 'Another copy of StratoSort is starting. Wait a few seconds and try again.'
          : dataLockResult.reason === 'another-instance-holds-lock'
            ? `Another copy of StratoSort (process ${dataLockResult.holderPid ?? 'unknown'}) is using your data folder. Close it first. If no other copy is running, wait five minutes and try again; the lock expires on its own.`
            : `StratoSort could not create its data lock: ${dataLockResult.error || dataLockResult.reason}.`;
      dialog.showErrorBox(
        dataLockResult.reason === 'io-error'
          ? 'StratoSort could not start'
          : 'StratoSort is already running',
        `${lockHolderNote}\n\nLock file: ${dataLockResult.lockPath}`
      );
    } catch (dialogError) {
      logger.warn('[STARTUP] Could not show lock-refusal dialog', {
        error: dialogError?.message
      });
    }
    app.exit(1);
  } else {
    // Skip the registrations below on the exit branch — they shouldn't run
    // on a process that's already on its way out. `app.exit(1)` does not
    // fire before-quit/will-quit, but the registrations were a clarity
    // hazard: any synchronous throw would land in the partially-exiting
    // runtime and produce confusing diagnostics. Using `else` instead of an
    // early-`return` because we're at module top level, not inside a fn.
    const releaseDataLockOnce = (() => {
      let released = false;
      return (/** @type {any} */ cause) => {
        if (released) return;
        released = true;
        logger.info('[SHUTDOWN] Releasing user-data lock', { cause });
        releaseUserDataLock(logger);
      };
    })();
    // Release on every exit path we can observe. Duplicate calls are safe.
    app.on('will-quit', () => releaseDataLockOnce('will-quit'));
    app.on('quit', () => releaseDataLockOnce('quit'));
    process.on('exit', () => releaseDataLockOnce('process-exit'));
    // Registering SIGINT/SIGTERM listeners suppresses Node's default
    // termination — the handler MUST also quit, or Ctrl+C / SIGTERM leaves
    // the app running with the lock already released (a live writer no lock
    // protects, killable only via SIGKILL which skips graceful shutdown).
    // app.quit() drives the normal before-quit/will-quit chain, which
    // releases the lock again via releaseDataLockOnce (idempotent).
    const quitOnSignal = (/** @type {any} */ signal) => {
      logger.info('[SHUTDOWN] Received termination signal; quitting', { signal });
      try {
        app.quit();
      } catch {
        releaseDataLockOnce(signal);
        process.exit(signal === 'SIGINT' ? 130 : 143);
      }
    };
    process.on('SIGINT', () => quitOnSignal('SIGINT'));
    process.on('SIGTERM', () => quitOnSignal('SIGTERM'));
  }
}

if (gotTheLock || process.env.STRATOSORT_FORCE_LAUNCH === '1') {
  const secondInstanceHandler = (/** @type {any} */ _event, /** @type {any} */ argv) => {
    // Someone tried to run a second instance, restore and focus our window
    // Use event-driven window state manager
    const { restoreWindow } = require('./core/windowState');

    // Windows: Jump List tasks are passed via argv when the app is already running.
    // Process them here so tasks work reliably in the single-instance scenario.
    try {
      if (Array.isArray(argv)) {
        handleCommandLineTasks(argv);
      }
    } catch (error) {
      logger.warn('[SECOND-INSTANCE] Failed to handle command-line tasks:', error?.message);
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      logger.debug('[SECOND-INSTANCE] Restoring window for second instance attempt');

      restoreWindow(mainWindow).catch((error) => {
        logger.error('[SECOND-INSTANCE] Error restoring window:', error);
      });
    } else {
      // No window exists, create one
      createWindow();
    }
  };
  app.on('second-instance', secondInstanceHandler);

  // Track for cleanup
  eventListeners.push(() => app.removeListener('second-instance', secondInstanceHandler));

  if (!forceSoftwareRenderer) {
    app.commandLine.appendSwitch('enable-gpu-rasterization');
    app.commandLine.appendSwitch('enable-zero-copy');
  }
  logger.info(
    `[${isDev ? 'DEVELOPMENT' : 'PRODUCTION'}] GPU acceleration flags ${forceSoftwareRenderer ? 'disabled (software renderer)' : 'enabled'}`
  );
} // End of else block for single instance lock

// Initialize services after app is ready
app
  .whenReady()
  .then(
    /** @returns {Promise<void>} */ async () => {
      logger.info('[STARTUP] app.whenReady resolved');
      perfMarks.mark('startup:main:app-ready');

      // macOS: Set the dock icon to the StratoSort logo so it replaces the default
      // Electron atom icon during development.  In production (packaged) builds
      // electron-builder bakes the icon into the .app bundle so this is a no-op.
      if (process.platform === 'darwin' && app.dock) {
        try {
          const { nativeImage } = require('electron');
          const iconPath = path.join(__dirname, '..', 'assets', 'icons', 'png', '512x512.png');
          // Resolve from repo root in dev, or from resources in packaged build
          const resolvedIcon = app.isPackaged
            ? path.join(process.resourcesPath, 'assets', 'icons', 'png', '512x512.png')
            : path.resolve(iconPath);
          const fsSync = require('fs');
          if (fsSync.existsSync(resolvedIcon)) {
            app.dock.setIcon(nativeImage.createFromPath(resolvedIcon));
            logger.info('[DOCK] Set macOS dock icon from', resolvedIcon);
          }
        } catch (dockErr) {
          logger.debug('[DOCK] Could not set macOS dock icon:', dockErr?.message);
        }
      }

      // This prevents premature exit when async operations use unreferenced timeouts
      const startupKeepalive = trackInterval(() => {}, 1000);

      try {
        // ---- Logging (best-practice defaults) ----
        // Use a single JSONL log file per app launch under userData/logs.
        // In production, we disable console logging by default (can be re-enabled via env var).
        const logsDir = path.join(app.getPath('userData'), 'logs');
        await fs.mkdir(logsDir, { recursive: true });
        const logTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const logFilePath = path.join(logsDir, `stratosort-${logTimestamp}.log`);
        const enableConsole = isDev || process.env.STRATOSORT_CONSOLE_LOGS === '1';

        // Parse optional env override for the per-session size cap. The unit here
        // is megabytes to keep the knob ergonomic from a shell. Invalid values are
        // silently ignored and the built-in default (100 MB) is used instead.
        const maxBytesOverride = (() => {
          const raw = process.env.STRATOSORT_MAX_LOG_MB;
          if (!raw) return undefined;
          const parsed = Number(raw);
          if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
          return Math.floor(parsed * 1024 * 1024);
        })();

        // Raise a degraded-state flag when the file logger cannot write (disk full,
        // read-only filesystem, permission issues). This is the only class of log
        // failure that is user-visible and actionable — everything else degrades
        // silently to the console stream.
        const raiseLogDiskFlag = (/** @type {any} */ err) => {
          try {
            const { getInstance: getDegradedTracker } = require('./services/DegradedStateTracker');
            const code = err?.code;
            const severity = code === 'ENOSPC' || code === 'EDQUOT' ? 'error' : 'warning';
            getDegradedTracker().raise({
              code: 'logging.file-stream-error',
              subsystem: 'logging',
              severity,
              message:
                code === 'ENOSPC' || code === 'EDQUOT'
                  ? 'StratoSort cannot write logs because the disk is full. Free up space to restore full diagnostics.'
                  : `StratoSort cannot write the session log (${code || 'I/O error'}). Check filesystem permissions.`,
              detail: { code, message: err?.message, path: logFilePath }
            });
          } catch (flagErr) {
            // Last-resort fallback: this callback fires when the file logger itself
            // is broken, and if the DegradedStateTracker also fails to load we have
            // no structured-logging path left. Console is the only signal available.
            // eslint-disable-next-line no-console
            console.error('[LOGGING] Failed to raise degraded flag', flagErr?.message);
          }
        };

        configureFileLogging(logFilePath, {
          enableConsole,
          maxBytes: maxBytesOverride,
          onFileError: raiseLogDiskFlag
        });
        configureConsoleLogging(enableConsole);
        // The log filename was stamped moments ago in this same process, so the
        // filename time already sits uptimeS seconds after process start.
        // uptimeS is the in-process share of the pre-log gap (module load,
        // single-instance lock, app ready); the rest of the gap between the
        // double-click and the filename time happened before this process ran.
        logger.info('[LOGGING] File logging enabled', {
          logFilePath,
          uptimeS: Math.round(process.uptime())
        });
        // Startup measures land in the JSONL file at info so a support log can
        // place a stall without a developer attaching DevTools tracing. The
        // measure is emitted here rather than where the mark was taken because
        // the file destination only exists from this point on (marks persist).
        perfMarks.measureAndLog(
          'startup:main:time-to-app-ready',
          'startup:main:module-eval',
          'startup:main:app-ready',
          logger,
          { level: 'info' }
        );
        logger.info('[DIAGNOSTICS] Runtime info', {
          appVersion: app.getVersion?.(),
          platform: process.platform,
          arch: process.arch,
          versions: process.versions,
          userDataPath: app.getPath('userData')
        });

        // Initialize error handler (uses same log file for consistency)
        await errorHandler.initialize({ logFilePath });

        // Clean up old log files (age + max file count; JSONL under userData/logs)
        await errorHandler.cleanupLogs(7, 50);

        // Sweep stale crash dumps (local-only; not uploaded). Electron's
        // CrashReporter never rotates these, so one bad week can leave hundreds
        // of megabytes of `.dmp` artifacts under userData.
        try {
          await errorHandler.cleanupCrashDumps(
            path.join(app.getPath('userData'), 'crash-dumps'),
            30,
            20
          );
        } catch (crashSweepErr) {
          logger.warn('[STARTUP] Crash-dump cleanup failed (non-fatal):', crashSweepErr?.message);
        }

        // Recover incomplete atomic file operations from crash journals
        try {
          const {
            configureAtomicFileOperations,
            recoverFromJournals,
            gcOrphanedBackupDirectories
          } = require('../shared/atomicFileOperations');
          configureAtomicFileOperations({
            journalBaseDirectory: app.getPath('userData'),
            // Colocate backups with userData so atomic-rename works across
            // a process exit. tmpdir() = %TEMP% (typically C:) on Windows
            // while user files often live on D: or a network drive — fs.rename
            // across volumes throws EXDEV and breaks the atomic-rename
            // invariant the backup-and-replace pattern depends on.
            backupBaseDirectory: app.getPath('userData')
          });
          const recovered = await recoverFromJournals();
          if (recovered && recovered.recovered > 0) {
            logger.info('[STARTUP] Recovered from crash journals', {
              recovered: recovered.recovered,
              cleaned: recovered.cleaned,
              errors: recovered.errors
            });
          }
          // Prune orphaned per-process backup directories. cleanupBackups is
          // scheduled via setTimeout after a successful commit; if the process
          // exits inside that window, the per-process subdir under
          // ${tmpdir}/stratosort-backups/ leaks forever. This runs once at
          // startup and is best-effort — failures don't block the app.
          gcOrphanedBackupDirectories().catch((gcErr) => {
            logger.debug('[STARTUP] Backup-dir GC failed (non-fatal):', gcErr?.message);
          });
        } catch (journalError) {
          logger.warn('[STARTUP] Journal recovery failed (non-fatal):', journalError?.message);
        }

        // Restore legacy state/history before services read userData
        await migrateUserDataState();

        // Get the startup manager instance
        const startupManager = getStartupManager();

        // Create the integration shell now so IPC and the renderer can come up quickly.
        // Heavy startup work runs after the first window is created.

        // Create ServiceIntegration early so it's available for the coordinated startup
        const { container, ServiceIds } = require('./services/ServiceContainer');
        if (!container.has(ServiceIds.SERVICE_INTEGRATION)) {
          container.registerSingleton(
            ServiceIds.SERVICE_INTEGRATION,
            () => new ServiceIntegration()
          );
        }
        serviceIntegration = container.resolve(ServiceIds.SERVICE_INTEGRATION);

        // Load custom folders
        // Validate custom folders structure
        try {
          const loadedFolders = await loadCustomFolders();

          // Validate loaded data
          if (!Array.isArray(loadedFolders)) {
            logger.warn('[STARTUP] Invalid custom folders data (not an array), using empty array');
            customFolders = [];
          } else {
            // Filter out invalid folder entries
            customFolders = loadedFolders.filter((folder) => {
              if (!folder || typeof folder !== 'object') {
                logger.warn('[STARTUP] Skipping invalid folder entry (not an object)');
                return false;
              }
              if (!folder.id || typeof folder.id !== 'string') {
                logger.warn('[STARTUP] Skipping folder without valid id:', folder);
                return false;
              }
              if (!folder.name || typeof folder.name !== 'string') {
                logger.warn('[STARTUP] Skipping folder without valid name:', folder);
                return false;
              }
              if (!folder.path || typeof folder.path !== 'string') {
                logger.warn('[STARTUP] Skipping folder without valid path:', folder);
                return false;
              }
              // Security: skip folders with dangerous system paths
              if (isPathDangerous(folder.path)) {
                logger.warn('[STARTUP] Skipping folder with dangerous path:', folder.path);
                return false;
              }
              return true;
            });

            if (customFolders.length !== loadedFolders.length) {
              logger.warn(
                `[STARTUP] Filtered out ${loadedFolders.length - customFolders.length} invalid folder entries`
              );
            }
          }

          logger.info('[STARTUP] Loaded custom folders:', customFolders.length, 'folders');
        } catch (error) {
          logger.error('[STARTUP] Failed to load custom folders:', error.message);
          customFolders = [];
        }

        // Ensure default "Uncategorized" folder exists
        const hasDefaultFolder =
          customFolders?.some((f) => f?.isDefault || f?.name?.toLowerCase() === 'uncategorized') ??
          false;

        if (!hasDefaultFolder) {
          const documentsDir = app.getPath('documents');
          if (!documentsDir || typeof documentsDir !== 'string') {
            throw new Error('Failed to get documents directory path');
          }
          const defaultFolderPath = path.join(documentsDir, 'Uncategorized');

          try {
            // Create directory if it doesn't exist
            await fs.mkdir(defaultFolderPath, { recursive: true });

            // Verify directory was created successfully
            const stats = await fs.stat(defaultFolderPath);
            if (!stats.isDirectory()) {
              throw new Error('Default folder path exists but is not a directory');
            }

            const defaultFolder = {
              id: `default-uncategorized-${Date.now()}`,
              name: 'Uncategorized',
              path: defaultFolderPath,
              description: "Default folder for files that don't match any category",
              keywords: /** @type {string[]} */ ([]),
              isDefault: true,
              createdAt: new Date().toISOString()
            };

            customFolders.push(defaultFolder);
            await saveCustomFolders(customFolders);

            // Verify folder was persisted
            const reloadedFolders = await loadCustomFolders();
            const persistedDefault = reloadedFolders.find(
              (f) => f?.isDefault || f?.name?.toLowerCase() === 'uncategorized'
            );

            if (!persistedDefault) {
              logger.error('[STARTUP] Default folder created but failed to persist');
            } else {
              logger.info(
                '[STARTUP] Created and verified default Uncategorized folder at:',
                defaultFolderPath
              );
            }
          } catch (error) {
            logger.error('[STARTUP] Failed to create default folder:', error);
            // This is critical - app should not proceed without default folder
            throw new Error(`Failed to create default Uncategorized folder: ${error.message}`, {
              cause: error
            });
          }
        } else {
          logger.info('[STARTUP] Default folder already exists, skipping creation');
        }

        // NOTE: ServiceIntegration is now initialized in the coordinated startup above

        // Initialize settings service
        settingsService = getSettingsService();
        if (typeof settingsService?.setExternalSettingsChangedHandler === 'function') {
          settingsService.setExternalSettingsChangedHandler(handleSettingsChanged);
        }
        const initialSettings = await settingsService.load();

        // Apply the persisted log verbosity as early as possible so the rest of
        // startup logs at the user's chosen level. Dev builds keep their
        // NODE_ENV-based default unless the user explicitly changed loggingLevel.
        try {
          if (typeof initialSettings?.loggingLevel === 'string') {
            setGlobalLogLevel(initialSettings.loggingLevel);
          }
        } catch (logLevelErr) {
          logger.warn('[STARTUP] Failed to apply persisted logging level:', logLevelErr?.message);
        }

        // Commercial license status (offline Ed25519 verification). It is
        // informational only: nothing in the app is gated on it, and a
        // failure here never blocks startup.
        try {
          const { LicenseService } = require('./services/LicenseService');
          licenseService = new LicenseService({
            // Injected by webpack DefinePlugin at build time (release date of
            // this build); dev/test bundles may not define it. Declared in
            // src/types/globals.d.ts so the reference typechecks.
            buildDate:
              typeof __STRATOSORT_BUILD_DATE__ !== 'undefined' ? __STRATOSORT_BUILD_DATE__ : null
          });
          await licenseService.initialize();
        } catch (licenseErr) {
          logger.warn('[STARTUP] License service init failed:', {
            error: licenseErr?.message
          });
          licenseService = null;
        }

        // Resume any incomplete organize batches (best-effort)
        try {
          const incompleteBatches =
            serviceIntegration?.processingState?.getIncompleteOrganizeBatches?.() || [];
          if (incompleteBatches.length > 0) {
            logger.warn(
              `[RESUME] Found ${incompleteBatches.length} incomplete organize batch(es). They will resume when a new organize request starts.`
            );
          }
        } catch (resumeErr) {
          logger.warn('[RESUME] Failed to check incomplete batches:', resumeErr.message);
        }

        // Register IPC groups now that services and state are ready
        const getMainWindow = () => mainWindow;
        const getServiceIntegration = () => serviceIntegration;
        const getCustomFolders = () => customFolders;
        const setCustomFolders = (/** @type {any} */ folders) => {
          customFolders = folders;
        };

        // Create configured IPC service context
        const ipcContext = new IpcServiceContext()
          .setCore({
            ipcMain,
            IPC_CHANNELS,
            logger
          })
          .setElectron({
            dialog,
            shell,
            getMainWindow
          })
          .setSystemAnalytics(systemAnalytics)
          .setServiceIntegration(getServiceIntegration)
          .setFolders({
            getCustomFolders,
            setCustomFolders,
            saveCustomFolders,
            scanDirectory
          })
          .setAnalysis({
            analyzeDocumentFile,
            analyzeImageFile
          })
          .setSettings({
            settingsService,
            onSettingsChanged: handleSettingsChanged
          })
          .setLicense({ licenseService });

        // Register all IPC handlers using the context
        registerAllIpc(ipcContext);
        _ipcHandlersRegistered = true;

        // Background sweep of orphaned keyframe workspaces. mediaAnalysis.js
        // cleans up `os.tmpdir()/stratosort-keyframes-*` on success and
        // most error paths, but a SIGKILL or Electron crash mid-analysis
        // bypasses both. We walk the temp dir once on startup and reap
        // entries older than 24 h. Fire-and-forget — failures stay at
        // debug level and never delay first paint.
        try {
          const { sweepOrphanKeyframeDirs } = require('./services/keyframeTmpSweeper');
          sweepOrphanKeyframeDirs({ logger }).catch((err) => {
            logger.debug?.('[KeyframeSweeper] background sweep failed', {
              error: err?.message
            });
          });
        } catch (err) {
          logger.debug?.('[KeyframeSweeper] could not schedule sweep', {
            error: err?.message
          });
        }

        // Background sweep of orphaned atomic-write temp files in userData.
        // Atomic writers unlink their `*.tmp` siblings on every JS-observable
        // failure, but a process death between write and rename bypasses the
        // cleanup. Fire-and-forget, same stance as the keyframe sweep.
        try {
          const {
            sweepOrphanUserDataTmpFiles,
            sweepStaleRecoveryManifests
          } = require('./services/userDataTmpSweeper');
          sweepOrphanUserDataTmpFiles({ userDataDir: app.getPath('userData'), logger }).catch(
            (err) => {
              logger.debug?.('[UserDataTmpSweeper] background sweep failed', {
                error: err?.message
              });
            }
          );
          // Rollback recovery manifests are kept as manual-recovery breadcrumbs
          // on partial failure; reap them after the 180-day retention window.
          sweepStaleRecoveryManifests({ userDataDir: app.getPath('userData'), logger }).catch(
            (err) => {
              logger.debug?.('[RecoveryManifestSweeper] background sweep failed', {
                error: err?.message
              });
            }
          );
        } catch (err) {
          logger.debug?.('[UserDataTmpSweeper] could not schedule sweep', {
            error: err?.message
          });
        }

        // Create application menu with theme
        createApplicationMenu(() => mainWindow);

        // Register IPC event listeners (not handlers) for renderer-to-main communication
        const rendererErrorReportHandler = (
          /** @type {any} */ event,
          /** @type {any} */ errorData
        ) => {
          try {
            logger.error('[RENDERER ERROR]', {
              message: errorData?.message || 'Unknown error',
              stack: errorData?.stack,
              componentStack: errorData?.componentStack,
              type: errorData?.type || 'unknown',
              timestamp: errorData?.timestamp || new Date().toISOString()
            });
          } catch (err) {
            logger.error('[RENDERER ERROR] Failed to process error report:', err);
          }
        };
        const { registerListener } = require('./core/ipcRegistry');
        registerListener(
          ipcMain,
          IPC_CHANNELS.SYSTEM.RENDERER_ERROR_REPORT,
          rendererErrorReportHandler
        );

        // Propagate preload-side invoke timeouts into cooperative abort signals.
        // The preload fires `SYSTEM.ABORT_INVOKE` with `{ requestId }` when a
        // timeout wins the race against `ipcRenderer.invoke`, and the main-side
        // ipcRegistry wrapper has already associated that requestId with an
        // AbortController (exposed to handlers as `event.abortSignal`).
        const ipcAbortRegistry = require('./core/ipcAbortRegistry');
        const abortInvokeHandler = (/** @type {any} */ _event, /** @type {any} */ payload) => {
          try {
            const requestId =
              payload && typeof payload === 'object' && typeof payload.requestId === 'string'
                ? payload.requestId
                : null;
            if (!requestId) return;
            const reason =
              payload && typeof payload.reason === 'string' && payload.reason.length <= 64
                ? payload.reason
                : 'ipc-timeout';
            ipcAbortRegistry.abort(requestId, reason);
          } catch (err) {
            logger.debug(`[IPC] abort-invoke handler error: ${err?.message || err}`);
          }
        };
        registerListener(ipcMain, IPC_CHANNELS.SYSTEM.ABORT_INVOKE, abortInvokeHandler);

        logger.info('[STARTUP] Creating window before heavyweight service startup', {
          uptimeS: Math.round(process.uptime())
        });
        perfMarks.mark('startup:main:before-window');
        createWindow();
        perfMarks.mark('startup:main:after-window');
        perfMarks.measureAndLog(
          'startup:main:time-to-first-window',
          'startup:main:module-eval',
          'startup:main:after-window',
          logger,
          { level: 'info' }
        );
        clearTrackedTimer(startupKeepalive);

        // BUG 1: Reset crash-loop counter after 30s of stable operation
        trackTimeout(() => {
          try {
            const crashMarkerPath = path.join(app.getPath('userData'), '.crash-timestamps');
            const fsSync = require('fs');
            if (fsSync.existsSync(crashMarkerPath)) {
              fsSync.unlinkSync(crashMarkerPath);
              logger.debug('[STARTUP] Crash loop counter cleared after stable operation');
            }
          } catch {
            /* best effort */
          }
        }, 30_000);
        handleSettingsChanged(initialSettings);

        Promise.resolve()
          .then(
            /** @returns {Promise<void>} */ async () => {
              logger.info('[STARTUP] Verifying IPC handlers in background...');
              const handlersReady = await verifyIpcHandlersRegistered();
              if (handlersReady) {
                logger.info('[STARTUP] ✅ All critical IPC handlers verified and ready');
                return;
              }

              logger.error(
                '[STARTUP] ⚠️ CRITICAL: Some IPC handlers not registered after verification timeout'
              );
              logger.error(
                '[STARTUP] App may not function correctly. Consider increasing timeout or checking handler registration logic.'
              );

              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.once('did-finish-load', () => {
                  safeSend(mainWindow.webContents, IPC_EVENTS.NOTIFICATION, {
                    severity: 'warning',
                    message: 'Some features may be unavailable. Restart recommended.'
                  });
                });
              }
              return undefined;
            }
          )
          .catch((err) => {
            logger.debug('[STARTUP] Background IPC verification failed', { error: err?.message });
          });

        // Heavyweight startup (node-llama-cpp import, GPU probing, Orama load)
        // waits for the window's first paint. Its synchronous stretches run on
        // this thread, which also serves app:// and dispatches ready-to-show,
        // so queuing it in the same tick as createWindow() delayed the first
        // visible frame 1:1. The gate is capped (FIRST_PAINT_GATE) so headless
        // and stuck-renderer runs still initialise services.
        waitForFirstPaint(mainWindow, { timeoutMs: TIMEOUTS.FIRST_PAINT_GATE })
          .then(
            /** @returns {Promise<void>} */ async (reason) => {
              logger.info('[STARTUP] First-paint gate released', {
                reason,
                uptimeS: Math.round(process.uptime())
              });

              // Run first-time setup in background (non-blocking)
              // Handled by ./core/backgroundSetup module
              runBackgroundSetup();

              const startupResult = await runCoordinatedStartupInBackground(
                startupManager,
                serviceIntegration
              );

              // Surface degraded startup to the user. Previously this state was
              // log-only: AI analysis/search would silently fail with no
              // explanation. The DegradedStateBanner polls this tracker.
              if (startupResult?.degraded) {
                try {
                  const tracker = require('./services/DegradedStateTracker').getInstance();
                  tracker.raise({
                    code: 'startup.coordinated-failure',
                    subsystem: 'startup',
                    severity: 'error',
                    message:
                      'AI services did not fully start — analysis and semantic search may be unavailable. Restart StratoSort to retry.',
                    detail: { error: startupResult.error || null }
                  });
                } catch (trackerErr) {
                  logger.warn('[STARTUP] Failed to raise degraded-startup flag', {
                    error: trackerErr?.message
                  });
                }
              }

              if (serviceIntegration?.initialized) {
                logger.info('[STARTUP] Applying deferred service wiring');
                serviceIntegration.configureSmartFolderWatcher({
                  getSmartFolders: getCustomFolders,
                  analyzeDocumentFile,
                  analyzeImageFile,
                  analyzeMediaFile
                });
                serviceIntegration.configureDownloadWatcher({
                  getCustomFolders: () => customFolders,
                  analyzeDocumentFile,
                  analyzeImageFile,
                  analyzeMediaFile
                });
                serviceIntegration.configureLearningFeedback({
                  getSmartFolders: getCustomFolders
                });
                handleSettingsChanged(currentSettings || initialSettings, {
                  source: 'startup-post-init',
                  timestamp: Date.now()
                });
                scheduleLearningStartupScan(serviceIntegration);

                // Resume interrupted organize batches only now: processingState is
                // null on the ServiceIntegration shell until initialize() attaches
                // it, so the previous fixed 500ms timer raced background startup
                // and silently skipped the resume whenever it lost.
                if (!_shutdownState.shouldClose) {
                  resumeIncompleteBatches(serviceIntegration, logger, getMainWindow).catch(
                    (err) => {
                      logger.warn('[RESUME] Resume of incomplete batches failed:', err?.message);
                    }
                  );
                }
              } else {
                logger.warn('[STARTUP] Service integration did not finish initializing');
              }

              if (!startupResult?.degraded) {
                await verifyModelsInBackground(startupManager);
              }
              return undefined;
            }
          )
          .catch((err) => {
            logger.error('[STARTUP] Deferred startup pipeline failed', {
              error: err?.message || String(err)
            });
            try {
              const tracker = require('./services/DegradedStateTracker').getInstance();
              tracker.raise({
                code: 'startup.coordinated-failure',
                subsystem: 'startup',
                severity: 'error',
                message:
                  'AI services did not fully start — analysis and semantic search may be unavailable. Restart StratoSort to retry.',
                detail: { error: err?.message || String(err) }
              });
            } catch {
              // tracker unavailable — already logged above
            }
          });

        // Start periodic system metrics broadcast to renderer
        try {
          // Clear any existing interval before creating a new one
          if (metricsInterval) {
            clearTrackedTimer(metricsInterval);
            metricsInterval = null;
          }

          // PERFORMANCE FIX: Increased interval from 10s to 30s to reduce overhead
          // Renderer component polls directly, so main process doesn't need to poll as frequently
          metricsInterval = trackInterval(async () => {
            try {
              const win = BrowserWindow.getAllWindows()[0];
              if (!win || win.isDestroyed()) return;
              const metrics = await systemAnalytics.collectMetrics();
              safeSend(win.webContents, IPC_EVENTS.SYSTEM_METRICS, metrics);
            } catch (error) {
              logger.error('[METRICS] Failed to collect or send metrics:', error);
            }
          }, TIMEOUTS.METRICS_BROADCAST);
          try {
            metricsInterval.unref();
          } catch (error) {
            logger.warn('[METRICS] Failed to unref interval:', error.message);
          }
        } catch (error) {
          logger.error('[METRICS] Failed to start metrics interval:', error);
        }

        // Periodic memory heartbeat — post-mortem rationale and pressure
        // hysteresis live in core/memoryHeartbeat.js. Registered via
        // trackInterval (swept by clearAllTrackedTimers on shutdown) and
        // unref'd so it never holds the event loop open.
        try {
          const MEMORY_HEARTBEAT_INTERVAL_MS = 15000;
          const { createMemoryPressureSampler } = require('./core/memoryHeartbeat');
          const memoryHeartbeat = trackInterval(
            createMemoryPressureSampler({ logger }),
            MEMORY_HEARTBEAT_INTERVAL_MS
          );
          try {
            memoryHeartbeat.unref();
          } catch (error) {
            logger.warn('[MEMORY-HEARTBEAT] Failed to unref interval:', error.message);
          }
        } catch (error) {
          logger.error('[MEMORY-HEARTBEAT] Failed to start heartbeat:', error.message);
        }

        // Create system tray with quick actions
        try {
          initializeTrayConfig({
            getDownloadWatcher: () => downloadWatcher,
            getSettingsService: () => settingsService,
            handleSettingsChanged,
            createWindow,
            setIsQuitting
          });
          createSystemTray();
          // Register global shortcut for quick semantic search
          registerGlobalShortcut();
        } catch (e) {
          logger.warn('[TRAY] Failed to initialize tray:', e.message);
        }

        // Initialize lifecycle module with state accessors
        initializeLifecycle({
          getMetricsInterval: () => metricsInterval,
          setMetricsInterval: (/** @type {any} */ val) => {
            metricsInterval = val;
          },
          getDownloadWatcher: () => downloadWatcher,
          setDownloadWatcher: (/** @type {any} */ val) => {
            downloadWatcher = val;
          },
          getServiceIntegration: () => serviceIntegration,
          getSettingsService: () => settingsService,
          getEventListeners: () => eventListeners,
          setEventListeners: (/** @type {any} */ val) => {
            eventListeners = val;
          },
          getChildProcessListeners: () => childProcessListeners,
          setChildProcessListeners: (/** @type {any} */ val) => {
            childProcessListeners = val;
          },
          getGlobalProcessListeners: () => globalProcessListeners,
          setGlobalProcessListeners: (/** @type {any} */ val) => {
            globalProcessListeners = val;
          },
          setIsQuitting
        });

        // Register lifecycle handlers (replaces inline before-quit, window-all-closed, etc.)
        const lifecycleCleanup = registerLifecycleHandlers(createWindow);
        eventListeners.push(lifecycleCleanup.cleanupAppListeners);
        globalProcessListeners.push(lifecycleCleanup.cleanupProcessListeners);
        _lifecycleRegistered = true;

        // This prevents the race condition where window close handler hides window during quit
        app.prependListener('before-quit', () => {
          setForceQuit(true);
        });

        // Handle Windows Jump List command-line tasks and setup
        // Handled by ./core/jumpList module
        initializeJumpList();

        // Load Llama config and apply any saved selections
        const llamaConfig = await loadLlamaConfig();
        if (llamaConfig.selectedTextModel) await setTextModel(llamaConfig.selectedTextModel);
        if (llamaConfig.selectedVisionModel) await setVisionModel(llamaConfig.selectedVisionModel);
        if (llamaConfig.selectedEmbeddingModel)
          await setEmbeddingModel(llamaConfig.selectedEmbeddingModel);
        logger.info('[STARTUP] Llama configuration loaded');

        // Install React DevTools in development (opt-in to avoid noisy warnings)
        try {
          if (isDev && process.env.REACT_DEVTOOLS === 'true') {
            const {
              default: installExtension,
              REACT_DEVELOPER_TOOLS
            } = require('electron-devtools-installer');
            try {
              await installExtension(REACT_DEVELOPER_TOOLS);
            } catch (error) {
              logger.warn('Failed to install React DevTools', {
                error: error.message,
                stack: error.stack
              });
            }
          }
        } catch (error) {
          logger.error('[DEVTOOLS] Failed to setup React DevTools:', error);
        }

        // Auto-updates (production only) - handled by ./core/autoUpdater module.
        // Mirror the persisted autoUpdateCheck preference before init so the
        // startup/periodic checks honor it (manual checks always remain allowed).
        try {
          setAutoUpdateCheckEnabled(initialSettings?.autoUpdateCheck !== false);
        } catch (updPrefErr) {
          logger.warn('[STARTUP] Failed to apply autoUpdateCheck preference:', updPrefErr?.message);
        }
        /** @type {any} */
        const autoUpdaterResult = await initializeAutoUpdater(isDev, getMainWindow);
        if (autoUpdaterResult.cleanup) {
          eventListeners.push(autoUpdaterResult.cleanup);
        }
      } catch (error) {
        // Log full error details for debugging
        logger.error('[STARTUP] Failed to initialize:', {
          message: error?.message || 'Unknown error',
          stack: error?.stack,
          error
        });

        // Register IPC handlers even in degraded mode so the renderer
        // doesn't hit "No handler registered" for every call.
        // Skip if the normal-path registration already succeeded.
        if (!_ipcHandlersRegistered) {
          try {
            const getMainWindow = () => mainWindow;
            const getServiceIntegration = () => serviceIntegration;
            const getCustomFolders = () => customFolders;
            const setCustomFolders = (/** @type {any} */ folders) => {
              customFolders = folders;
            };
            const degradedIpcContext = new IpcServiceContext()
              .setCore({ ipcMain, IPC_CHANNELS, logger })
              .setElectron({ dialog, shell, getMainWindow })
              .setSystemAnalytics(systemAnalytics)
              .setServiceIntegration(getServiceIntegration)
              .setFolders({
                getCustomFolders,
                setCustomFolders,
                saveCustomFolders,
                scanDirectory
              })
              .setAnalysis({ analyzeDocumentFile, analyzeImageFile })
              .setSettings({ settingsService, onSettingsChanged: handleSettingsChanged });
            registerAllIpc(degradedIpcContext);
            _ipcHandlersRegistered = true;
            logger.info('[STARTUP] IPC handlers registered in degraded mode');
          } catch (ipcErr) {
            logger.error(
              '[STARTUP] Failed to register IPC handlers in degraded mode:',
              ipcErr?.message
            );
          }
        }

        if (!_lifecycleRegistered) {
          try {
            initializeLifecycle({
              getMetricsInterval: () => metricsInterval,
              setMetricsInterval: (/** @type {any} */ val) => {
                metricsInterval = val;
              },
              getDownloadWatcher: () => downloadWatcher,
              setDownloadWatcher: (/** @type {any} */ val) => {
                downloadWatcher = val;
              },
              getServiceIntegration: () => serviceIntegration,
              getSettingsService: () => settingsService,
              getEventListeners: () => eventListeners,
              setEventListeners: (/** @type {any} */ val) => {
                eventListeners = val;
              },
              getChildProcessListeners: () => childProcessListeners,
              setChildProcessListeners: (/** @type {any} */ val) => {
                childProcessListeners = val;
              },
              getGlobalProcessListeners: () => globalProcessListeners,
              setGlobalProcessListeners: (/** @type {any} */ val) => {
                globalProcessListeners = val;
              },
              setIsQuitting
            });
            const lifecycleCleanup = registerLifecycleHandlers(createWindow);
            eventListeners.push(lifecycleCleanup.cleanupAppListeners);
            globalProcessListeners.push(lifecycleCleanup.cleanupProcessListeners);
            _lifecycleRegistered = true;
            logger.info('[STARTUP] Lifecycle handlers registered in degraded mode');
          } catch (lifeErr) {
            logger.error(
              '[STARTUP] Failed to register lifecycle handlers in degraded mode:',
              lifeErr?.message
            );
          }
        }

        try {
          const tracker = require('./services/DegradedStateTracker').getInstance();
          tracker.raise({
            code: 'STARTUP_DEGRADED',
            subsystem: 'startup',
            severity: 'error',
            message: error?.message || 'Startup failed; running in degraded mode'
          });
        } catch (trackerErr) {
          logger.debug('[STARTUP] DegradedStateTracker unavailable', {
            error: trackerErr?.message
          });
        }

        logger.warn('[STARTUP] Creating window in degraded mode due to startup errors');
        createWindow();
        clearTrackedTimer(startupKeepalive);
      }
      return undefined;
    }
  )
  .catch((err) => {
    // Defensive: app.whenReady() resolves once Electron is ready and is not
    // documented to reject, but the body's outer try/catch could miss a throw
    // before its `try` (e.g. a synchronous require failure). Logging here is
    // strictly better than an unhandled rejection during startup.
    logger.error('[STARTUP] whenReady chain rejected', {
      error: err?.message || String(err),
      stack: err?.stack
    });
  });

// ===== APP LIFECYCLE =====
// Lifecycle handlers (before-quit, window-all-closed, activate, error handling)
// are now managed by ./core/lifecycle module and registered via registerLifecycleHandlers()
logger.info('[STARTUP] Organizer AI App - Main Process Started with Full AI Features');
logger.info('[UI] Modern UI loaded with GPU acceleration');
logger.info('StratoSort main process initialized');

// All Analysis History and System metrics handlers are registered via ./ipc/* modules

// Audio analysis is not supported in this build.

// ===== TRAY INTEGRATION =====
// System tray is now handled by ./core/systemTray
// Functions createSystemTray and updateTrayMenu are imported
// tray variable is managed by the systemTray module (use getTray() to access)

// Resume service
const { resumeIncompleteBatches } = require('./services/OrganizeResumeService');

// Delete folder and its contents
