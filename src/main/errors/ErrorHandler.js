// @ts-check
/**
 * Centralized Error Handler
 * Manages all application errors with proper logging and user notification
 */

const { app, dialog, BrowserWindow } = require('electron');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { ERROR_TYPES, IPC_EVENTS } = require('../../shared/constants');
const { createLogger, sanitizeLogData } = require('../../shared/logger');
const { parseJsonLines } = require('../../shared/safeJsonOps');
const { safeSend } = require('../ipc/ipcWrappers');
const {
  isNotFoundError,
  isPermissionError,
  isNetworkError
} = require('../../shared/errorClassifier');
const { ERROR_CODES } = require('../../shared/errorCodes');
const { classifyLlamaError } = require('../../shared/llamaErrorClassifier');

const logger = createLogger('ErrorHandler');
/**
 * Extract a compact, user-friendly summary of Electron "process gone" details.
 * @param {any} details
 * @returns {string}
 */
function summarizeProcessGoneDetails(details) {
  if (!details || typeof details !== 'object') return '';

  const parts = [];
  if (details.type) parts.push(`type=${String(details.type)}`);
  if (details.reason) parts.push(`reason=${String(details.reason)}`);
  if (typeof details.exitCode === 'number') parts.push(`exitCode=${details.exitCode}`);
  if (details.serviceName) parts.push(`serviceName=${String(details.serviceName)}`);
  if (details.name) parts.push(`name=${String(details.name)}`);

  return parts.join(', ');
}

/**
 * Normalize unknown error-like values into a consistent log payload.
 * @param {any} err
 * @returns {{ errorText?: string, stack?: string, details?: any }}
 */
function normalizeErrorForLogging(err) {
  if (!err) return {};
  if (err instanceof Error) {
    return { errorText: err.toString(), stack: err.stack };
  }

  // Electron often passes plain objects (e.g., { type, reason, exitCode }) for crash events.
  return { details: err };
}

// NOTE: sanitizeLogData is imported from logger.js to avoid code duplication

class ErrorHandler {
  constructor() {
    /** @type {string | null} */
    this.logPath = null;
    /** @type {string | null} */
    this.currentLogFile = null;
    /** @type {any[]} */
    this.errorQueue = [];
    this.isInitialized = false;
  }

  /**
   * Initialize error handler and configure log file location.
   * @param {{ logFilePath?: string }} [options]
   */
  async initialize(options = {}) {
    try {
      this.logPath = path.join(app.getPath('userData'), 'logs');

      // Create logs directory
      await fs.mkdir(this.logPath, { recursive: true });

      // Set up log file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      this.currentLogFile =
        options.logFilePath || path.join(this.logPath, `stratosort-${timestamp}.log`);

      // Ensure the shared logger writes to the same log file (single source of truth).
      // Use optional chaining so unit tests can mock logger without full surface area.
      logger?.enableFileLogging?.(this.currentLogFile, { format: 'jsonl' });

      // Set up global error handlers
      this.setupGlobalHandlers();

      this.isInitialized = true;
      await this.log('info', 'ErrorHandler initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize ErrorHandler:', {
        error: error.message,
        stack: error.stack
      });
    }
  }

  setupGlobalHandlers() {
    if (this._globalHandlersRegistered) return;
    this._globalHandlersRegistered = true;

    // NOTE: process.on('uncaughtException') and process.on('unhandledRejection')
    // are handled by lifecycle.js with proper cleanup. Do NOT register them here
    // to avoid duplicate handlers which cause:
    // 1. Double logging of errors
    // 2. Memory leaks from untracked listeners
    // 3. Conflicting error handling logic

    // Handle Electron-specific errors only (these are not in lifecycle.js)
    app.on('render-process-gone', (event, webContents, details) => {
      // oom/crashed are owned by createWindow's webContents-level listener
      // (auto-reload budget, then escalation). This app-level event fires
      // before that one, so it cannot consult the budget — skip these reasons
      // unconditionally and escalate everything else.
      const reason = details?.reason;
      if (reason === 'oom' || reason === 'crashed') return;

      const summary = summarizeProcessGoneDetails(details);
      const message = summary
        ? `Renderer Process Crashed (${summary})`
        : 'Renderer Process Crashed';

      const urlSafe = (() => {
        try {
          return webContents?.getURL?.();
        } catch {
          return undefined;
        }
      })();

      this.handleCriticalError(message, {
        details,
        webContentsId: webContents?.id,
        url: urlSafe
      });
    });

    app.on('child-process-gone', (event, details) => {
      // Electron recovers automatically from several child-process types.
      // Forcing a full app quit for any of these is destructive and
      // throws away the user's in-progress work (analysis queue,
      // unsaved edits, log tail) for a transient crash the platform
      // was about to recover from on its own.
      //
      //   GPU               — Electron respawns the GPU process on next paint.
      //   Utility           — owning service (log export, Piscina worker,
      //                       node-llama-cpp utility) restarts it on
      //                       demand; crash does not affect UI thread.
      //   Sandbox helper    — respawned by OS-level Electron plumbing.
      //   Zygote            — Linux-only prefork; Electron respawns.
      //   Pepper Plugin /   — legacy Flash infra; Chromium fault-tolerant.
      //   Pepper Plugin Broker
      //
      // Everything else (Unknown, future types) still falls through to
      // handleCriticalError so we don't silently mask a regression.
      const RECOVERABLE_CHILD_PROCESS_TYPES = new Set([
        'GPU',
        'Utility',
        'Sandbox helper',
        'Zygote',
        'Pepper Plugin',
        'Pepper Plugin Broker'
      ]);

      if (RECOVERABLE_CHILD_PROCESS_TYPES.has(details?.type)) {
        const summary = summarizeProcessGoneDetails(details);
        const base = `${details.type} Process Exited`;
        this.log('warning', summary ? `${base} (${summary})` : base, { details });
        return;
      }

      const summary = summarizeProcessGoneDetails(details);
      const message = summary ? `Child Process Crashed (${summary})` : 'Child Process Crashed';
      this.handleCriticalError(message, { details });
    });
  }

  /**
   * Handle different types of errors
   * @param {any} error
   * @param {Record<string, any>} [context]
   */
  async handleError(error, context = {}) {
    const errorInfo = this.parseError(error);
    const severity = this.determineSeverity(errorInfo.type);

    // Log the error
    await this.log(severity, errorInfo.message, {
      ...errorInfo,
      context,
      timestamp: new Date().toISOString()
    });

    // Handle based on severity. Cast to string so `case 'critical'` remains a
    // future-proof branch — determineSeverity never returns 'critical' today
    // (permission/unknown are downgraded to 'error' to avoid a hard quit), but
    // preserving the branch documents the intent for future severity additions.
    switch (/** @type {string} */ (severity)) {
      case 'critical':
        await this.handleCriticalError(errorInfo.message, error);
        break;
      case 'error':
        await this.notifyUser(errorInfo.message, 'error');
        break;
      case 'warning':
        await this.notifyUser(errorInfo.message, 'warning');
        break;
      default:
        // Info level errors are just logged
        break;
    }

    return errorInfo;
  }

  /**
   * Parse error to extract useful information with user-friendly messages
   * @param {any} error
   */
  parseError(error) {
    const errorInfo = {
      type: ERROR_TYPES.UNKNOWN,
      message: 'Something went wrong. Please try again.',
      details: {},
      stack: error?.stack
    };

    if (error instanceof Error) {
      // Classification priority (most specific first):
      //   1. Explicit ERROR_CODES on `error.code` — source of truth when a
      //      service has already classified the failure.
      //   2. classifyLlamaError — word-aware regex patterns for CPU incompat,
      //      missing model, VRAM exhaust, corrupt GGUF, context overflow. This
      //      replaces the previous substring check for "AI"/"Llama"/"memory"
      //      which mis-labelled unrelated errors (e.g. anything mentioning
      //      "Authentication" matched "AI") as AI_UNAVAILABLE.
      //   3. File-system / permission / network classifiers (unchanged).
      //   4. Pass-through user-friendly message fallback.
      const explicitCode =
        typeof (/** @type {NodeJS.ErrnoException} */ (error).code) === 'string'
          ? /** @type {NodeJS.ErrnoException} */ (error).code
          : null;
      const llamaCode = classifyLlamaError(error);
      // Keyword fallback for AI pathway errors that classifyLlamaError doesn't
      // recognise. The previous pattern included a bare `ai` token which
      // matched any user path containing an "AI" folder
      // (`~/AI Projects/...`, `C:\Users\jane\Documents\AI\report.docx`),
      // misclassifying real ENOENT/EACCES errors as AI_UNAVAILABLE and
      // hiding the actual file failure behind a model-failure dialog.
      //
      // The fix: restrict the keyword set to tokens that are unambiguously
      // AI/inference-related — `llama`, `ggml`, `gguf` are project/format
      // names that don't appear in plausible user content. `ai` is dropped
      // entirely; AI-pathway errors that don't already have a `LLAMA_` code
      // OR a structured pattern in `classifyLlamaError` should explicitly
      // mention the engine by its real name (still common: "Llama …", "AI
      // engine …" — the latter caught by the explicit "ai engine" phrase
      // requiring the surrounding word.)
      // Note: `ai engine` (with the word "engine") IS still matched because
      // the test contract requires it; we anchor to that two-word phrase
      // rather than the lone `ai` token.
      const aiKeywordMatch =
        /(^|\W)(llama|ggml|gguf)(\W|$)/i.test(error.message || '') ||
        /\bai\s+(engine|model|service|runtime|server)\b/i.test(error.message || '');

      if (explicitCode === ERROR_CODES.FILE_NOT_FOUND || isNotFoundError(error)) {
        errorInfo.type = ERROR_TYPES.FILE_NOT_FOUND;
        errorInfo.message = 'Could not find the file or folder. It may have been moved or deleted.';
      } else if (explicitCode === ERROR_CODES.FILE_ACCESS_DENIED || isPermissionError(error)) {
        errorInfo.type = ERROR_TYPES.PERMISSION_DENIED;
        errorInfo.message =
          'Access denied. Check that you have permission to access this location.';
      } else if (
        llamaCode ||
        (explicitCode && explicitCode.startsWith('LLAMA_')) ||
        aiKeywordMatch
      ) {
        errorInfo.type = ERROR_TYPES.AI_UNAVAILABLE;
        const resolvedCode = explicitCode?.startsWith('LLAMA_') ? explicitCode : llamaCode;
        errorInfo.details = { ...errorInfo.details, llamaCode: resolvedCode };
        switch (resolvedCode) {
          case ERROR_CODES.LLAMA_MODEL_INCOMPATIBLE_CPU:
            errorInfo.message =
              'This build of the AI engine is not compatible with your CPU. Switch to the small Qwen 0.5B profile in Settings > Models.';
            break;
          case ERROR_CODES.LLAMA_MODEL_NOT_FOUND:
          case ERROR_CODES.LLAMA_MODEL_PATH_MISMATCH:
            errorInfo.message = 'AI model file is missing. Open Settings > Models to install it.';
            break;
          case ERROR_CODES.LLAMA_OOM:
            errorInfo.message = 'Out of memory. Try a smaller model or close other applications.';
            break;
          case ERROR_CODES.LLAMA_GPU_ERROR:
            errorInfo.message =
              'GPU memory was exhausted. Reduce GPU layers in Settings or switch to CPU-only inference.';
            break;
          case ERROR_CODES.LLAMA_MODEL_LOAD_FAILED:
            errorInfo.message =
              'Could not load the AI model. Re-download it from Settings > Models.';
            break;
          case ERROR_CODES.LLAMA_INFERENCE_FAILED:
            errorInfo.message =
              'AI inference failed. The prompt may be too long for this model — shorten the input or switch to a larger model.';
            break;
          default:
            errorInfo.message = 'AI engine unavailable. Check Settings > Models and try again.';
        }
      } else if (isNetworkError(error)) {
        errorInfo.type = ERROR_TYPES.NETWORK_ERROR;
        if (error.message.includes('timeout')) {
          errorInfo.message =
            'Request timed out. The AI model may be loading or your system is busy.';
        } else {
          errorInfo.message = 'A network-related error occurred. Please try again.';
        }
      } else {
        // Keep original message if it's user-friendly, otherwise provide generic
        const msg = error.message || '';
        // Check if message is already user-friendly (contains actionable language)
        if (msg.length < 100 && !msg.includes('undefined') && !msg.includes('null')) {
          errorInfo.message = msg;
        }
      }
      errorInfo.details = { ...errorInfo.details, originalMessage: error.message };
    }

    return errorInfo;
  }

  /**
   * Determine error severity
   * @param {string} errorType
   */
  determineSeverity(errorType) {
    switch (errorType) {
      case ERROR_TYPES.PERMISSION_DENIED:
      case ERROR_TYPES.UNKNOWN:
        // 'critical' triggers handleCriticalError which shows a restart/quit dialog.
        // Permission denied and unknown errors are recoverable and should not force an app quit.
        return 'error';
      case ERROR_TYPES.FILE_NOT_FOUND:
      case ERROR_TYPES.AI_UNAVAILABLE:
        return 'error';
      case ERROR_TYPES.INVALID_FORMAT:
      case ERROR_TYPES.FILE_TOO_LARGE:
        return 'warning';
      default:
        return 'info';
    }
  }

  /**
   * Handle critical errors that may crash the app.
   * Includes crash-loop detection: if 3+ crashes occur within 60 seconds,
   * the app enters safe mode instead of restarting.
   * @param {string} message
   * @param {unknown} [error]
   */
  async handleCriticalError(message, error) {
    const normalized = normalizeErrorForLogging(error);
    logger.error('[CRITICAL ERROR]', {
      message,
      ...normalized
    });

    // --- Crash-loop detection ---
    // Record the current crash timestamp and check if we're in a crash loop
    let inCrashLoop = false;
    const CRASH_LOOP_WINDOW_MS = 60_000; // 60 seconds
    const CRASH_LOOP_THRESHOLD = 3;
    let crashMarkerPath;
    try {
      crashMarkerPath = path.join(app.getPath('userData'), '.crash-timestamps');
      /** @type {number[]} */
      let timestamps = [];
      try {
        const data = fsSync.readFileSync(crashMarkerPath, 'utf-8');
        timestamps = JSON.parse(data);
        if (!Array.isArray(timestamps)) timestamps = [];
      } catch {
        /* no existing marker */
      }
      timestamps.push(Date.now());
      // Keep only timestamps within the crash loop window
      const cutoff = Date.now() - CRASH_LOOP_WINDOW_MS;
      timestamps = timestamps.filter((t) => typeof t === 'number' && t > cutoff);
      fsSync.writeFileSync(crashMarkerPath, JSON.stringify(timestamps));

      if (timestamps.length >= CRASH_LOOP_THRESHOLD) {
        inCrashLoop = true;
        logger.error('[CRITICAL ERROR] Crash loop detected', {
          crashCount: timestamps.length,
          windowMs: CRASH_LOOP_WINDOW_MS
        });
      }
    } catch (markerErr) {
      logger.debug('[CRITICAL ERROR] Failed to write crash marker:', markerErr?.message);
    }

    // Show error dialog with a hard timeout so we don't hang the main process
    // in cases where UI is unresponsive (e.g., renderer crash/freeze).
    const DIALOG_TIMEOUT_MS = 8000;
    let timeoutId;
    try {
      // If in a crash loop, show safe-mode dialog instead of restart option
      /** @type {import('electron').MessageBoxOptions} */
      const dialogOptions = inCrashLoop
        ? {
            type: 'error',
            title: 'Crash Loop Detected',
            message: 'StratoSort has crashed multiple times in quick succession',
            detail: `${message}\n\nThe app may have a configuration problem. Would you like to start in safe mode (software rendering, default settings) or quit?`,
            buttons: ['Safe Mode', 'Quit'],
            defaultId: 0
          }
        : {
            type: 'error',
            title: 'Critical Error',
            message: 'Stratosort encountered a critical error',
            detail: `${message}\n\nWould you like to restart the application?`,
            buttons: ['Restart', 'Quit'],
            defaultId: 0
          };

      const response = await Promise.race([
        dialog.showMessageBox(dialogOptions),
        new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`Critical error dialog timed out after ${DIALOG_TIMEOUT_MS}ms`)),
            DIALOG_TIMEOUT_MS
          );
        })
      ]);

      let userChoseAction = false;
      if (response?.response === 0) {
        userChoseAction = true;
        if (inCrashLoop) {
          // Safe mode: force software rendering and clear crash marker
          app.relaunch({ args: [...process.argv.slice(1), '--safe-mode'] });
          process.env.STRATOSORT_FORCE_SOFTWARE_GPU = '1';
          try {
            if (crashMarkerPath) fsSync.unlinkSync(crashMarkerPath);
          } catch {
            /* best effort */
          }
        } else {
          app.relaunch();
        }
        // Quit to allow the relaunch to take effect.
        app.quit();
      } else if (response?.response === 1) {
        // User explicitly chose Quit.
        userChoseAction = true;
        app.quit();
      }
      // If response is undefined/other (e.g. dialog dismissed by OS), fall
      // through without quitting — the user did NOT acknowledge the error,
      // and force-quitting on a transient renderer hang during a non-fatal
      // child-process crash would persist a crash marker that triggers
      // unwanted safe-mode on next launch.
      if (!userChoseAction) {
        logger.warn(
          '[CRITICAL ERROR] Dialog dismissed without an explicit user choice; not quitting'
        );
      }
    } catch (dialogError) {
      logger.error('[CRITICAL ERROR] Failed to show critical error dialog:', {
        error: dialogError?.message || String(dialogError)
      });
      // Dialog timeout / failure path: previously the finally block force-quit
      // the app even when the dialog hadn't been seen. That punished the user
      // for a transient renderer hang. Stay alive and let the user observe
      // the underlying issue; they can manually quit if needed.
      //
      // showMessageBox can hang when no window ever became ready (observed in
      // production alongside a window-creation timeout) — in that state the
      // user saw no error at all. showErrorBox is synchronous and needs no
      // window, so it still surfaces the message; informational only, no
      // restart/quit choice.
      try {
        dialog.showErrorBox(
          'Critical Error',
          `${message}\n\nStratoSort hit a critical error and could not show the interactive dialog. Check the app log for details.`
        );
      } catch {
        /* headless or display unavailable — the log entry above is the record */
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  /**
   * Notify user of errors
   * @param {string} message
   * @param {'error' | 'warning' | 'info' | 'none' | 'question'} [type]
   */
  async notifyUser(message, type = 'error') {
    const mainWindow = BrowserWindow.getFocusedWindow();

    if (mainWindow && !mainWindow.isDestroyed()) {
      // Send to renderer process with validated payload
      safeSend(mainWindow.webContents, IPC_EVENTS.APP_ERROR, {
        message,
        type,
        timestamp: new Date().toISOString()
      });
    } else {
      // Fallback to dialog
      await dialog.showMessageBox({
        type,
        title: type.charAt(0).toUpperCase() + type.slice(1),
        message,
        buttons: ['OK']
      });
    }
  }

  /**
   * Log messages to file
   * Sanitizes sensitive data (file paths) in production mode
   * @param {string} level
   * @param {string} message
   * @param {Record<string, any>} [data]
   */
  async log(level, message, data = {}) {
    // Sanitize data to remove sensitive information in production
    const sanitizedData = sanitizeLogData(data);
    const sanitizedMessage = sanitizeLogData(message);

    // Route everything through the shared logger (it handles console + JSONL file output).
    // We keep this method async for backwards compatibility with existing call sites.
    try {
      logger.log(level, sanitizedMessage, sanitizedData);
    } catch (e) {
      // Avoid recursive failures; best-effort only.
      void e;
    }
  }

  /**
   * Get recent errors for debugging
   */
  async getRecentErrors(count = 50) {
    try {
      if (!this.currentLogFile) return [];
      const logContent = await fs.readFile(this.currentLogFile, 'utf-8');
      const entries = parseJsonLines(logContent);
      const errors = entries
        .filter((entry) => {
          const normalizedLevel = String(entry?.level || '').toLowerCase();
          return normalizedLevel === 'error' || normalizedLevel === 'critical';
        })
        .slice(-count);

      return errors;
    } catch (error) {
      logger.error('Failed to read error log:', { error: error.message });
      return [];
    }
  }

  /**
   * Clean up old log files
   * PERF: Uses async file operations to avoid blocking the event loop
   */
  /**
   * Remove stale JSONL log files under userData/logs.
   * Export (`EXPORT_LOGS`) zips this directory as redacted plain-text logs — do not change extensions.
   * Binary crash dumps are not included in the shareable archive (see logExportWorker).
   *
   * @param {number} [daysToKeep=7] - Delete files with mtime older than this many days.
   * @param {number} [maxFiles=50] - After age cleanup, keep at most this many files (newest by mtime).
   *        The active `currentLogFile` is never deleted.
   */
  async cleanupLogs(daysToKeep = 7, maxFiles = 50) {
    try {
      if (!this.logPath) return;
      const files = await fs.readdir(this.logPath);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
      const currentResolved = this.currentLogFile ? path.resolve(this.currentLogFile) : null;

      const logFiles = files.filter(
        (file) => file.startsWith('stratosort-') && file.endsWith('.log')
      );

      const cleanupPromises = logFiles.map(async (file) => {
        const filePath = path.join(this.logPath, file);
        try {
          const stats = await fs.stat(filePath);
          if (stats.mtime < cutoffDate) {
            await fs.unlink(filePath);
            await this.log('info', `Cleaned up old log file: ${file}`);
          }
        } catch (fileError) {
          logger.debug('Failed to cleanup individual log file:', {
            file,
            error: fileError.message
          });
        }
      });

      await Promise.all(cleanupPromises);

      const remainingNames = (await fs.readdir(this.logPath)).filter(
        (file) => file.startsWith('stratosort-') && file.endsWith('.log')
      );
      if (remainingNames.length <= maxFiles) return;

      const withStats = await Promise.all(
        remainingNames.map(async (file) => {
          const filePath = path.join(this.logPath, file);
          const stats = await fs.stat(filePath);
          return { file, filePath, mtimeMs: stats.mtimeMs };
        })
      );
      withStats.sort((a, b) => a.mtimeMs - b.mtimeMs);
      let toRemove = withStats.length - maxFiles;
      for (const item of withStats) {
        if (toRemove <= 0) break;
        if (currentResolved && path.resolve(item.filePath) === currentResolved) {
          continue;
        }
        try {
          await fs.unlink(item.filePath);
          await this.log('info', `Removed excess log file (retention cap): ${item.file}`);
          toRemove -= 1;
        } catch (fileError) {
          logger.debug('Failed to remove excess log file:', {
            file: item.file,
            error: fileError.message
          });
        }
      }
    } catch (error) {
      logger.error('Failed to cleanup logs:', { error: error.message });
    }
  }

  /**
   * Remove stale Electron crash-dump files under userData/crash-dumps.
   *
   * Crash dumps are binary (`.dmp`) files written by Electron's local crash
   * reporter (`uploadToServer: false`). Without sweeps they accumulate
   * across every hard crash and occupy megabytes per incident, which is
   * especially painful on users who have set the app to launch at startup.
   *
   * @param {string} crashDumpsDir - Absolute path to the crash-dumps directory.
   * @param {number} [daysToKeep=30] - Delete files with mtime older than this.
   * @param {number} [maxFiles=20] - After age cleanup, keep at most this many
   *        (newest by mtime). Dumps are the only recovery signal for field
   *        issues, so the cap is intentionally higher than for verbose logs.
   */
  async cleanupCrashDumps(crashDumpsDir, daysToKeep = 30, maxFiles = 20) {
    if (!crashDumpsDir) return;
    try {
      let files;
      try {
        files = await fs.readdir(crashDumpsDir);
      } catch (readErr) {
        if (readErr?.code === 'ENOENT') return;
        throw readErr;
      }

      const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
      // Electron writes `.dmp` on Windows/Linux and `.ips`/`.dmp` on macOS;
      // the CrashReporter also leaves `metadata` files alongside dumps. Keep
      // the filter scoped to known crash-artifact extensions so we never
      // clobber anything an admin placed in this directory.
      /** @param {string} name */
      const isDumpFile = (name) =>
        name.endsWith('.dmp') ||
        name.endsWith('.ips') ||
        name.endsWith('.ips.synced') ||
        name === 'metadata' ||
        name === 'completed';

      const candidates = files.filter(isDumpFile);

      await Promise.all(
        candidates.map(async (file) => {
          const filePath = path.join(crashDumpsDir, file);
          try {
            const stats = await fs.stat(filePath);
            if (stats.isFile() && stats.mtimeMs < cutoff) {
              await fs.unlink(filePath);
              await this.log('info', `Cleaned up stale crash dump: ${file}`);
            }
          } catch (fileErr) {
            logger.debug('Failed to cleanup crash dump entry:', {
              file,
              error: fileErr.message
            });
          }
        })
      );

      // Secondary cap: even fresh dumps should be bounded.
      const remaining = (await fs.readdir(crashDumpsDir)).filter(isDumpFile);
      if (remaining.length <= maxFiles) return;

      const withStats = [];
      for (const file of remaining) {
        const filePath = path.join(crashDumpsDir, file);
        try {
          const stats = await fs.stat(filePath);
          if (stats.isFile()) {
            withStats.push({ file, filePath, mtimeMs: stats.mtimeMs });
          }
        } catch {
          // Ignore: entry may have been removed mid-sweep.
        }
      }
      withStats.sort((a, b) => a.mtimeMs - b.mtimeMs);
      let toRemove = withStats.length - maxFiles;
      for (const item of withStats) {
        if (toRemove <= 0) break;
        try {
          await fs.unlink(item.filePath);
          await this.log('info', `Removed excess crash dump (retention cap): ${item.file}`);
          toRemove -= 1;
        } catch (fileErr) {
          logger.debug('Failed to remove excess crash dump:', {
            file: item.file,
            error: fileErr.message
          });
        }
      }
    } catch (error) {
      logger.error('Failed to cleanup crash dumps:', { error: error.message });
    }
  }
}

// Export singleton instance
module.exports = new ErrorHandler();
