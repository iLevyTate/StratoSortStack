// @ts-check
/**
 * System Monitoring IPC Handlers
 *
 * Handles system metrics, application statistics, updates, and configuration.
 */
const { IpcServiceContext, createFromLegacyParams } = require('./IpcServiceContext');
const {
  createHandler,
  createErrorResponse,
  canceledResponse,
  safeHandle
} = require('./ipcWrappers');
const { dump: dumpConfig, validate: validateConfig } = require('../../shared/config/index');
const { schemas } = require('./validationSchemas');

// Single stable code so the renderer's polling banner sees one flag rather
// than flickering between get-statistics and get-metrics codes when both
// fail simultaneously (which is the common case — they share the same
// systemAnalytics dependency).
const SYSTEM_METRICS_DEGRADED_CODE = 'system.metrics-collection-failed';

// Lazy require: the existing GET_DEGRADED_STATE / DISMISS_DEGRADED_FLAG
// handlers in this file already use `require(...)` at call time so per-test
// `jest.doMock(...)` can override the singleton without conflicting with
// any module-load-time import. Match that pattern so this module stays
// consistent and the test suite's existing mocking strategy keeps working.
/**
 * Read the WhisperService status without forcing the service into existence.
 *
 * We deliberately PEEK at the DI container rather than calling
 * `WhisperService.getInstance()` — the singleton helper auto-creates a local
 * instance if the container doesn't have one, which would shadow the real
 * registration and could mislead diagnostics during early startup. If
 * whisper hasn't been registered yet (or has been deregistered), we return
 * `whisper: null` with a `reason` field so the renderer can distinguish
 * "not yet loaded" from "service crashed".
 *
 * Errors are logged but never propagated — GET_RUNTIME_INFO must always
 * succeed so the diagnostics screen can render even when one subsystem is
 * sick.
 *
 * @param {import('./ipcWrappers').LoggerLike} logger
 * @returns {{ whisper: Record<string, any>|null, reason?: string }}
 */
function readMediaStackInfo(logger) {
  try {
    const fs = require('fs');
    const path = require('path');
    const { app } = require('electron');
    const { DEFAULT_MODEL_FILENAME, WHISPER_SUBDIR } = require('../services/WhisperService');
    const { container, ServiceIds } = require('../services/ServiceContainer');
    const whisperServiceId = ServiceIds && ServiceIds.WHISPER_SERVICE;
    if (!whisperServiceId || typeof container.has !== 'function') {
      return { whisper: null, reason: 'service-container-unavailable' };
    }
    if (!container.has(whisperServiceId)) {
      return { whisper: null, reason: 'whisper-service-not-registered' };
    }
    const instance = container.resolve(whisperServiceId);
    if (!instance || typeof instance.getStatus !== 'function') {
      return { whisper: null, reason: 'whisper-instance-incomplete' };
    }
    const status = instance.getStatus();
    const modelFilename = status.modelFilename || DEFAULT_MODEL_FILENAME;
    let modelPresent = false;
    try {
      const whisperDir = path.join(app.getPath('userData'), 'models', WHISPER_SUBDIR);
      modelPresent = fs.existsSync(path.join(whisperDir, modelFilename));
    } catch {
      // Non-fatal — About still renders without on-disk model detection.
    }
    return {
      whisper: {
        resolvedVariant: status.resolvedVariant ?? null,
        backend: status.backend ?? null,
        loaded: !!status.loaded,
        modelFilename,
        modelPresent,
        vadEnabled: !!status.vad?.enabled,
        vadLoaded: !!status.vad?.loaded
      }
    };
  } catch (error) {
    logger.warn('readMediaStackInfo failed (non-fatal):', { message: error?.message });
    return { whisper: null, reason: 'media-stack-read-failed' };
  }
}

/** @param {Record<string, any>} detail */
function _raiseSystemMetricsDegraded(detail) {
  // Severity is `warning` rather than `error`: the user can keep working;
  // the only consequence is the in-app health pill / metrics dashboard shows
  // stale or zeroed data. An error-level banner here would cry wolf.
  // Without this flag, the dashboard silently shows zeros and users have no
  // way to tell "everything's fine" from "telemetry is broken".
  try {
    const { getInstance } = require('../services/DegradedStateTracker');
    getInstance().raise({
      code: SYSTEM_METRICS_DEGRADED_CODE,
      subsystem: 'metrics',
      severity: 'warning',
      message:
        "System health metrics couldn't be collected. The health indicator may be inaccurate; " +
        'restart the app if values stay frozen.',
      detail
    });
  } catch {
    /* tracker failures must not break the response */
  }
}

function _clearSystemMetricsDegraded() {
  try {
    const { getInstance } = require('../services/DegradedStateTracker');
    getInstance().clear(SYSTEM_METRICS_DEGRADED_CODE);
  } catch {
    /* never throw from a successful response path */
  }
}

const MAX_LOG_MESSAGE_CHARS = 8192;
const MAX_LOG_CONTEXT_CHARS = 120;
const MAX_LOG_SERIALIZED_DATA_BYTES = 16384;
const MAX_LOG_DATA_DEPTH = 4;
const MAX_LOG_DATA_KEYS = 100;
const MAX_LOG_ARRAY_ITEMS = 100;
const LOG_EXPORT_WORKER_TIMEOUT_MS = 120000;
const BLOCKED_LOG_DATA_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Facility/context labels are appended after "Renderer:" in the log line. We
// restrict the shape aggressively so a hostile renderer (e.g. via XSS into
// the React tree) can't smuggle log-ingestion markers, ANSI escapes, or fake
// severity prefixes that downstream tooling might trust. Anything outside
// this charset is replaced with '?' before truncation.
const SAFE_RENDERER_CONTEXT_PATTERN = /[^A-Za-z0-9 ._:\-/]/g;

// Control characters that enable log-line injection in JSONL/TSV sinks:
//   - CR (0x0D) / LF (0x0A) let attackers forge extra lines.
//   - ANSI/OSC escapes (0x1B) can rewrite terminal output viewing logs.
//   - NUL/DEL + other C0/C1 codes corrupt some log collectors.
// We replace all of them with a single space so the surrounding text stays
// readable but can no longer impersonate a log line boundary.
//
// We intentionally keep TAB (0x09) → space as well; a literal tab inside a
// renderer-supplied message is never load-bearing for diagnostics.
// eslint-disable-next-line no-control-regex
const LOG_UNSAFE_CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/**
 * @param {any} value
 * @param {number} maxChars
 */
function sanitizeLogLineString(value, maxChars) {
  let str;
  if (typeof value === 'string') {
    str = value;
  } else if (value != null && typeof value === 'object') {
    str = value.message || value.value || JSON.stringify(value);
  } else {
    str = String(value ?? '');
  }
  str = str.replace(LOG_UNSAFE_CONTROL_CHARS, ' ');
  if (str.length <= maxChars) return str;
  return `${str.slice(0, maxChars)}...[truncated]`;
}

/** @param {unknown} value */
function sanitizeRendererContext(value) {
  if (typeof value !== 'string') return '';
  const stripped = value
    .replace(LOG_UNSAFE_CONTROL_CHARS, '')
    .replace(SAFE_RENDERER_CONTEXT_PATTERN, '?');
  if (stripped.length <= MAX_LOG_CONTEXT_CHARS) return stripped;
  return stripped.slice(0, MAX_LOG_CONTEXT_CHARS);
}

/**
 * Walk a renderer-supplied log payload, capping depth / width / key count,
 * dropping prototype-polluting keys, and stripping log-line control
 * characters from any string value at any depth. Renderer log input is
 * treated as untrusted since bugs, XSS, or crafted extension content can
 * reach this channel.
 *
 * @param {any} value
 * @param {number} [depth]
 * @returns {any}
 */
function clampRendererLogPayload(value, depth = 0) {
  if (value == null) return value;
  if (depth >= MAX_LOG_DATA_DEPTH) return '[Truncated: max depth reached]';
  if (typeof value === 'string') {
    return value.replace(LOG_UNSAFE_CONTROL_CHARS, ' ');
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_LOG_ARRAY_ITEMS)
      .map((entry) => clampRendererLogPayload(entry, depth + 1));
  }
  if (typeof value !== 'object') return value;

  const sanitized = Object.create(null);
  let count = 0;
  for (const [key, nested] of Object.entries(value)) {
    if (BLOCKED_LOG_DATA_KEYS.has(String(key).toLowerCase())) {
      sanitized.__blockedKeys = true;
      continue;
    }
    if (count >= MAX_LOG_DATA_KEYS) {
      sanitized.__truncatedKeys = true;
      break;
    }
    sanitized[key] = clampRendererLogPayload(nested, depth + 1);
    count += 1;
  }
  return sanitized;
}

/** @param {any} value */
function clampRendererLogDataSize(value) {
  const sanitized = clampRendererLogPayload(value);
  try {
    const serialized = JSON.stringify(sanitized);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes <= MAX_LOG_SERIALIZED_DATA_BYTES) return sanitized;
    return {
      truncated: true,
      reason: 'payload_too_large',
      sizeBytes: bytes,
      maxBytes: MAX_LOG_SERIALIZED_DATA_BYTES
    };
  } catch {
    return {
      truncated: true,
      reason: 'payload_not_serializable'
    };
  }
}
const MAX_CONFIG_PATH_CHARS = 120;
const SAFE_CONFIG_PATH_PATTERN = /^[A-Za-z0-9_.-]+$/;
const BLOCKED_CONFIG_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * @param {unknown} configPath
 * @returns {string|null}
 */
function validateConfigPathInput(configPath) {
  if (typeof configPath !== 'string') {
    return 'Config path must be a non-empty string';
  }
  const normalized = configPath.trim();
  if (!normalized) {
    return 'Config path must be a non-empty string';
  }
  if (normalized.length > MAX_CONFIG_PATH_CHARS) {
    return `Config path exceeds ${MAX_CONFIG_PATH_CHARS} characters`;
  }
  if (!SAFE_CONFIG_PATH_PATTERN.test(normalized)) {
    return 'Config path contains invalid characters';
  }
  if (normalized.includes('..')) {
    return 'Config path contains invalid traversal segments';
  }
  const segments = normalized.split('.');
  if (segments.some((segment) => !segment)) {
    return 'Config path contains invalid empty segments';
  }
  if (segments.some((segment) => BLOCKED_CONFIG_SEGMENTS.has(segment.toLowerCase()))) {
    return 'Config path contains blocked segment';
  }
  return null;
}

/**
 * @param {IpcServiceContext|Record<string, any>} servicesOrParams - Service context or legacy parameters
 */
function registerSystemIpc(servicesOrParams) {
  let container;
  if (servicesOrParams instanceof IpcServiceContext) {
    container = servicesOrParams;
  } else {
    container = createFromLegacyParams(servicesOrParams);
  }

  const { ipcMain, IPC_CHANNELS, logger } = container.core;
  const { systemAnalytics, getServiceIntegration } = container;

  const context = 'System';

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SYSTEM.GET_APPLICATION_STATISTICS,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      handler: async () => {
        try {
          const serviceIntegration = getServiceIntegration();
          const [analysisStats, historyRecent] = await Promise.all([
            serviceIntegration?.analysisHistory?.getStatistics?.() || Promise.resolve({}),
            serviceIntegration?.analysisHistory?.getRecentAnalysis?.(20) || Promise.resolve([])
          ]);

          const value = {
            analysis: analysisStats,
            recentActions: serviceIntegration?.undoRedo?.getActionHistory?.(20) || [],
            recentAnalysis: historyRecent,
            timestamp: new Date().toISOString()
          };
          _clearSystemMetricsDegraded();
          return value;
        } catch (error) {
          logger.error('Failed to get system statistics:', error);
          _raiseSystemMetricsDegraded({ handler: 'GET_STATISTICS', error: error?.message });
          return {};
        }
      }
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SYSTEM.GET_METRICS,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      handler: async () => {
        try {
          const value = await systemAnalytics.collectMetrics();
          _clearSystemMetricsDegraded();
          return value;
        } catch (error) {
          logger.error('Failed to collect system metrics:', error);
          _raiseSystemMetricsDegraded({ handler: 'GET_METRICS', error: error?.message });
          return {};
        }
      }
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SYSTEM.GET_RUNTIME_INFO,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      handler: async () => {
        try {
          const { app } = require('electron');
          const versions = /** @type {Record<string, string|undefined>} */ (process.versions || {});
          return {
            success: true,
            appName: app.getName(),
            appVersion: app.getVersion(),
            electronVersion: versions.electron || null,
            chromeVersion: versions.chrome || null,
            nodeVersion: versions.node || null,
            v8Version: versions.v8 || null,
            platform: process.platform,
            arch: process.arch,
            osRelease: require('os').release(),
            isPackaged: app.isPackaged === true,
            buildSha: process.env.STRATOSORT_BUILD_SHA || null,
            // Media-stack diagnostics. We deliberately *do not* require the
            // service eagerly — if it isn't registered yet (early startup,
            // tests, or a future refactor), we return null fields rather
            // than failing the whole runtime-info call. The renderer's
            // diagnostics screen treats null as "not yet loaded".
            mediaStack: readMediaStackInfo(logger)
          };
        } catch (error) {
          logger.error('Failed to read runtime info:', error);
          return createErrorResponse(error);
        }
      }
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SYSTEM.GET_DEGRADED_STATE,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      handler: async () => {
        try {
          const { getInstance } = require('../services/DegradedStateTracker');
          return { flags: getInstance().list() };
        } catch (error) {
          logger.error('Failed to read degraded state:', error);
          return { flags: [] };
        }
      }
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SYSTEM.DISMISS_DEGRADED_FLAG,
    createHandler({
      logger,
      context,
      schema: schemas?.dismissDegradedFlagPayload,
      // `createHandler` invokes as `(event, validatedPayload)`, so the first arg
      // is the Electron IpcMainInvokeEvent. Previously we destructured it as
      // the payload, meaning `code` was always undefined and the dismiss path
      // would always fall through to the "code required" rejection regardless
      // of which flag the renderer asked us to clear.
      handler: async (_event, { code } = {}) => {
        try {
          if (typeof code !== 'string' || !code) {
            return createErrorResponse(new Error('code is required'));
          }
          const { getInstance } = require('../services/DegradedStateTracker');
          const dismissed = getInstance().dismiss(code);
          return { success: true, dismissed };
        } catch (error) {
          logger.error('Failed to dismiss degraded flag:', error);
          return createErrorResponse(error);
        }
      }
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SYSTEM.APPLY_UPDATE,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      handler: async () => {
        try {
          // Quitting mid file-move can strand a half-completed batch (the
          // journal recovers on next launch, but at the cost of rollbacks).
          // Give in-flight IPC work a bounded window to drain first —
          // allowedRemaining=1 accounts for this handler's own operation.
          try {
            const { waitForInFlightOperations } = require('../core/ipcRegistry');
            const drained = await waitForInFlightOperations(10000, 1);
            if (!drained) {
              logger.warn(
                '[UPDATER] In-flight operations did not drain before install; proceeding (journal will recover)'
              );
            }
          } catch (waitError) {
            logger.warn('[UPDATER] Drain wait failed, proceeding with install:', waitError.message);
          }
          const { quitAndInstall } = require('../core/autoUpdater');
          const result = quitAndInstall();
          return result?.success === false
            ? createErrorResponse(new Error(result.error || 'Failed to apply update'))
            : { success: true };
        } catch (error) {
          logger.error('Failed to apply update:', error);
          return createErrorResponse(error);
        }
      }
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SYSTEM.CHECK_FOR_UPDATES,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      handler: async () => {
        try {
          const { checkForUpdates } = require('../core/autoUpdater');
          // autoUpdater's `@returns {Promise<void>}` on checkForUpdates understates the
          // actual `{ success, ... }` result objects it returns; cast until that file opts in.
          const result = /** @type {any} */ (await checkForUpdates());
          // A copy that cannot update itself (zip extract, Store install,
          // non-AppImage Linux) is an answer, not a failure: pass its reason
          // through so Settings can show it instead of a generic error.
          if (result?.unsupported) {
            return { success: true, unsupported: true, reason: result.error };
          }
          if (result?.success === false) {
            return createErrorResponse(new Error(result.error || 'Failed to check for updates'));
          }
          return result?.disabled ? { success: true, disabled: true } : { success: true };
        } catch (error) {
          logger.error('Failed to check for updates:', error);
          return createErrorResponse(error);
        }
      }
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SYSTEM.DOWNLOAD_UPDATE,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      handler: async () => {
        try {
          const { downloadUpdate } = require('../core/autoUpdater');
          const result = await downloadUpdate();
          return result?.success === false
            ? createErrorResponse(new Error(result.error || 'Failed to download update'))
            : { success: true };
        } catch (error) {
          logger.error('Failed to download update:', error);
          return createErrorResponse(error);
        }
      }
    })
  );

  // Configuration inspection handler for debugging and support
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SYSTEM.GET_CONFIG,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      handler: async () => {
        try {
          const configDump = dumpConfig({ includeSensitive: false });
          const validation = validateConfig();

          return {
            success: true,
            config: configDump.config,
            metadata: configDump.metadata,
            validation: {
              valid: validation.valid,
              errorCount: validation.errors.length,
              warningCount: validation.warnings.length
            }
          };
        } catch (error) {
          logger.error('Failed to get app configuration:', error);
          return createErrorResponse(error);
        }
      }
    })
  );

  // Get configuration value by path
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SYSTEM.GET_CONFIG_VALUE,
    createHandler({
      logger,
      context,
      schema: schemas.configPath,
      handler: async (_event, configPath) => {
        try {
          const pathError = validateConfigPathInput(configPath);
          if (pathError) {
            return createErrorResponse({ message: pathError });
          }
          const { SENSITIVE_KEYS } = require('../../shared/config/configSchema');
          const normalizedPath = configPath.trim();
          const pathLower = normalizedPath.toLowerCase();
          if (SENSITIVE_KEYS.some((key) => pathLower.includes(key.toLowerCase()))) {
            return createErrorResponse({ message: 'Cannot access sensitive configuration values' });
          }
          const { get: getConfig } = require('../../shared/config/index');
          const value = getConfig(normalizedPath);
          return { success: true, path: normalizedPath, value };
        } catch (error) {
          logger.error('Failed to get config value:', error);
          return createErrorResponse(error);
        }
      }
    })
  );

  // Get recommended concurrency based on system capabilities
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SYSTEM.GET_RECOMMENDED_CONCURRENCY,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      handler: async () => {
        try {
          const { getRecommendedConcurrency } = require('../services/PerformanceService');
          const recommendation = await getRecommendedConcurrency();
          logger.info('[System] Recommended concurrency:', recommendation);
          return { success: true, ...recommendation };
        } catch (error) {
          logger.error('Failed to get recommended concurrency:', error);
          return { success: false, maxConcurrent: 1, reason: 'Error determining capabilities' };
        }
      }
    })
  );

  // Handle remote logs from Renderer process
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SYSTEM.LOG,
    createHandler({
      logger,
      context,
      schema: schemas.systemLog,
      handler: async (_event, payload) => {
        try {
          if (!payload || typeof payload !== 'object') return { success: false };
          const { level, message, data } = payload;

          // Validate log level to prevent arbitrary method invocation.
          const ALLOWED_LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
          const safeLevel = ALLOWED_LOG_LEVELS.has(level) ? level : 'info';

          // SECURITY: the renderer is an untrusted log source (bugs, XSS,
          // crafted extension content). Strip control characters from the
          // message and every string inside `data` so a malicious payload
          // can't forge log lines, inject ANSI escapes, or break JSONL
          // parsers downstream. Field caps are enforced in the clamp walker.
          const safeMessage = sanitizeLogLineString(message, MAX_LOG_MESSAGE_CHARS);
          const safeData = clampRendererLogDataSize(data || {});

          // Route to the shared logger pipeline so sanitization/redaction
          // remains consistent with all other app logs. The "Renderer:"
          // prefix is a separate facility — it makes it unambiguous in log
          // output that the line originated from the sandboxed renderer,
          // even if the renderer-supplied context tries to impersonate a
          // main-process component (e.g. "Security" or "Main:bootstrap").
          const rawContext = typeof safeData?.context === 'string' ? safeData.context : '';
          const safeContext = sanitizeRendererContext(rawContext);
          const rendererContext = `Renderer${safeContext ? `:${safeContext}` : ''}`;
          const logMethod = /** @type {Record<string, any>} */ (logger)[safeLevel];
          if (typeof logMethod === 'function') {
            logMethod.call(logger, `[${rendererContext}] ${safeMessage}`, safeData);
          }

          return { success: true };
        } catch {
          // Don't log this error to avoid infinite loops if logging itself fails
          return { success: false };
        }
      }
    })
  );

  // Export logs: zips userData/logs (JSONL text) and crash-dumps; see ErrorHandler.cleanupLogs for retention.
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SYSTEM.EXPORT_LOGS,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      handler: async () => {
        try {
          const { app, dialog } = require('electron');
          const path = require('path');
          const fs = require('fs');
          const { Worker } = require('worker_threads');

          const logsDir = path.join(app.getPath('userData'), 'logs');
          if (!fs.existsSync(logsDir)) {
            return { success: false, error: 'No logs found' };
          }

          const crashDumpsDir = path.join(app.getPath('userData'), 'crash-dumps');

          const { filePath } = await dialog.showSaveDialog({
            title: 'Export Debug Logs',
            defaultPath: `stratosort-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`,
            filters: [{ name: 'Zip Files', extensions: ['zip'] }]
          });

          if (!filePath) {
            return canceledResponse();
          }

          await new Promise((resolve, reject) => {
            let settled = false;
            /** @type {ReturnType<typeof setTimeout> | null} */
            let timeoutId = null;
            const { resolveWorkerPath } = require('../utils/workerPools');
            const workerPath = resolveWorkerPath('logExportWorker');
            if (!workerPath) throw new Error('Log export worker not found');
            const worker = new Worker(workerPath, {
              workerData: { logsDir, crashDumpsDir, outPath: filePath }
            });

            /** @param {Error|null} [error] */
            const finish = (error = null) => {
              if (settled) return;
              settled = true;
              if (timeoutId) clearTimeout(timeoutId);
              worker.removeAllListeners('message');
              worker.removeAllListeners('error');
              worker.removeAllListeners('exit');
              worker
                .terminate()
                .catch((e) => logger.debug('[SYSTEM] Worker terminate failed:', e?.message));
              if (error) reject(error);
              else resolve();
            };

            timeoutId = setTimeout(() => {
              worker
                .terminate()
                .catch((e) => logger.debug('[SYSTEM] Worker terminate failed:', e?.message));
              finish(
                new Error(
                  `Log export timed out after ${Math.round(LOG_EXPORT_WORKER_TIMEOUT_MS / 1000)}s`
                )
              );
            }, LOG_EXPORT_WORKER_TIMEOUT_MS);

            worker.on('message', (msg) => {
              if (msg?.success) {
                finish();
              } else {
                finish(new Error(msg?.error || 'Log export failed'));
              }
            });
            worker.on('error', (error) => finish(error));
            worker.on('exit', (code) => {
              if (!settled && code !== 0) {
                finish(new Error(`Worker stopped with exit code ${code}`));
              }
            });
          });

          return { success: true, filePath };
        } catch (error) {
          logger.error('Failed to export logs:', error);
          return createErrorResponse(error);
        }
      }
    })
  );

  // Read the bundled THIRD_PARTY_NOTICES.md so the renderer can show an
  // in-app Legal Notices view. The file is shipped to process.resourcesPath
  // by electron-builder.json (extraResources). In dev it lives at
  // <appRoot>/docs/THIRD_PARTY_NOTICES.md.
  //
  // This is a read-only handler that accepts no input, so it gets the void
  // schema from validationSchemas.
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SYSTEM.GET_LEGAL_NOTICES,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      handler: async () => {
        const fs = require('fs').promises;
        const path = require('path');
        const { app } = require('electron');
        const {
          listBundledResourceCandidates,
          readFirstExistingResource
        } = require('../utils/bundledResourcePaths');

        const candidates = listBundledResourceCandidates('THIRD_PARTY_NOTICES.md', app, {
          devRelativePath: path.join('docs', 'THIRD_PARTY_NOTICES.md')
        });

        const found = await readFirstExistingResource(candidates, fs, {
          onCandidateError: (/** @type {string} */ candidate, /** @type {any} */ err) => {
            logger.warn('Failed to read legal notices candidate', {
              candidate,
              error: err?.message
            });
          }
        });
        if (found) {
          return { success: true, content: found.content, sourcePath: found.path };
        }

        return createErrorResponse({
          message: 'Third-party notices file is unavailable. The build may be incomplete.'
        });
      }
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SYSTEM.OPEN_LEGAL_DOCUMENT,
    createHandler({
      logger,
      context,
      schema: schemas?.openLegalDocumentPayload,
      handler: async (_event, { kind } = {}) => {
        const fs = require('fs').promises;
        const { app, shell } = require('electron');
        const { LEGAL_DOCUMENT_FILES } = require('../../shared/legalDocuments');
        const {
          listBundledResourceCandidates,
          findFirstExistingResourcePath
        } = require('../utils/bundledResourcePaths');

        const filename = /** @type {Record<string, string>} */ (LEGAL_DOCUMENT_FILES)[kind];
        if (!filename) {
          return createErrorResponse({ message: `Unknown legal document kind: ${kind}` });
        }

        const candidates = listBundledResourceCandidates(filename, app);
        try {
          const resolvedPath = await findFirstExistingResourcePath(candidates, fs, {
            onCandidateError: (/** @type {string} */ candidate, /** @type {any} */ err) => {
              logger.warn('[SYSTEM] Failed to resolve legal document candidate', {
                kind,
                candidate,
                error: err?.message
              });
            }
          });
          if (!resolvedPath) {
            return createErrorResponse({
              message: `${filename} is unavailable in this build.`
            });
          }

          const result = await shell.openPath(resolvedPath);
          if (typeof result === 'string' && result.length > 0) {
            logger.warn('[SYSTEM] Failed to open legal document', {
              kind,
              resolvedPath,
              error: result
            });
            return createErrorResponse({ message: `Failed to open ${filename}: ${result}` });
          }

          return { success: true, path: resolvedPath, kind };
        } catch (error) {
          logger.error('[SYSTEM] Failed to open legal document', { kind, error });
          return createErrorResponse(error);
        }
      }
    })
  );
}

module.exports = registerSystemIpc;
