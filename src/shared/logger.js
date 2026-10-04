// @ts-check
/* global __non_webpack_require__ */
/**
 * Unified Logging System for StratoSort
 * Provides structured logging across main and renderer processes using Pino
 */

const pino = require('pino');
const util = require('util');
const path = require('path');
const { getCorrelationId } = require('./correlationId');

// Legacy level mapping for compatibility
const LOG_LEVELS = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  DEBUG: 'debug',
  TRACE: 'trace'
};

const LOG_LEVEL_NAMES = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];

// pino.transport() is only available in the Node.js build (main process).
// The preload (target: 'web') and renderer use pino/browser.js which lacks it.
const _hasPinoTransport = typeof pino.transport === 'function';

// Previously, every createLogger() call spawned a new pino transport worker,
// each registering its own process.on('exit') handler. With 100+ loggers in
// the main process, this caused MaxListenersExceededWarning at startup.
/** @type {any} */
let _sharedDevTransport = null;
let _transportDead = false;
const _activeLoggers = new Set();
/** @type {{ enableFile: boolean, logFile: string|null, enableConsole: boolean|undefined, level: string|undefined }} */
const _globalLogConfig = {
  enableFile: false,
  logFile: null,
  enableConsole: undefined,
  level: undefined
};

// ---- Log rotation / ENOSPC handling -----------------------------------------
// A long-running session can easily produce multi-GB log files if debug is on
// or if a bug triggers a write loop. We avoid unbounded growth by rolling the
// current log file to a numbered sibling once it crosses `maxBytes`, and we
// treat disk-full / read-only filesystem errors as a degraded condition rather
// than swallowing them silently.
//
// Rotation poll and file-error hooks are only meaningful for the Node build
// (main process). The browser/renderer build has no file stream to monitor.
const DEFAULT_MAX_LOG_BYTES = 100 * 1024 * 1024;
const DEFAULT_ROTATION_POLL_MS = 15_000;
// Per-session ceiling on rotated siblings (`-1.log` … `-24.log`). Beyond it
// the current file is allowed to grow so a write loop can't fan out into an
// unbounded number of files; the operator is warned once when that happens.
const MAX_LOG_ROTATIONS = 24;
const DISK_FATAL_CODES = new Set(['ENOSPC', 'EDQUOT', 'EROFS', 'EACCES', 'EPERM']);

/** @type {{ maxBytes: number, pollMs: number, timer: ReturnType<typeof setInterval>|null, onError: ((err: Error) => void)|null, diskErrorRaised: boolean, rotationIndex: number, rotationCapWarned: boolean, inFlight: boolean, basePath: string|null }} */
const _rotationState = {
  maxBytes: DEFAULT_MAX_LOG_BYTES,
  pollMs: DEFAULT_ROTATION_POLL_MS,
  timer: null,
  onError: null,
  diskErrorRaised: false,
  rotationIndex: 0,
  rotationCapWarned: false,
  inFlight: false,
  // Original (pre-rotation) log path. Rotated names are always derived from
  // this base so suffixes don't compound (`-1-2-3.log`) across rotations.
  basePath: null
};
const _fileStreams = new Set();
/** @type {Map<string, any>} */
const _destinationsByPath = new Map();

function _lazyFs() {
  // `fs` is a Node built-in that webpack's `electron-main` target leaves
  // external, so a plain require works in the bundled main process and is the
  // same reference the rest of the app (and Jest's memfs mock) sees.
  try {
    return require('fs');
  } catch {
    return null;
  }
}

/**
 * @param {NodeJS.ErrnoException} err
 */
function _emitFileError(err) {
  _rotationState.diskErrorRaised = true;
  const code = err?.code;
  console.error('[Logger] File log stream error', { code, message: err?.message });
  if (typeof _rotationState.onError === 'function') {
    try {
      _rotationState.onError(err);
    } catch (cbErr) {
      console.error('[Logger] onFileError callback threw', cbErr?.message);
    }
  }
  if (DISK_FATAL_CODES.has(code)) {
    // Disable further file writes so we don't log-storm into a full disk.
    _globalLogConfig.enableFile = false;
    _globalLogConfig.logFile = null;
    _stopRotationTimer();
  }
}

/**
 * @param {any} stream
 */
function _trackFileStream(stream) {
  if (!stream || typeof stream.on !== 'function') return;
  _fileStreams.add(stream);
  stream.on('error', _emitFileError);
  stream.once('close', () => _fileStreams.delete(stream));
}

/**
 * One sonic-boom destination per log path so N loggers don't open N fds.
 * @param {string} logFile
 */
function _getSharedFileDestination(logFile) {
  const existing = _destinationsByPath.get(logFile);
  if (existing) return existing;
  const fileStream = pino.destination({ dest: logFile, sync: false });
  _destinationsByPath.set(logFile, fileStream);
  _trackFileStream(fileStream);
  fileStream.once('close', () => {
    if (_destinationsByPath.get(logFile) === fileStream) {
      _destinationsByPath.delete(logFile);
    }
  });
  return fileStream;
}

/**
 * End every shared destination that no longer backs the active log path.
 * Must run only after every active logger has been re-pointed at
 * `activePath` (rotation / reconfigure); otherwise each rotation leaks an
 * open fd and, on Windows, the open handle pins the rotated-away file so
 * cleanupLogs cannot delete it.
 * @param {string} activePath
 */
function _closeStaleFileDestinations(activePath) {
  for (const [logFile, stream] of _destinationsByPath) {
    if (logFile === activePath) continue;
    _destinationsByPath.delete(logFile);
    try {
      stream.end();
    } catch {
      // Already closed/destroyed — nothing to release.
    }
  }
}

/**
 * @param {string} originalPath
 * @param {number} index
 */
function _buildRotatedPath(originalPath, index) {
  const parsed = path.parse(originalPath);
  // `stratosort-<ts>.log` -> `stratosort-<ts>-1.log`, `-2.log`, ...
  return path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext || '.log'}`);
}

/**
 * @param {string|null} filePath
 * @param {number} maxBytes
 */
function _shouldRotate(filePath, maxBytes) {
  const fs = _lazyFs();
  if (!fs || !filePath) return false;
  try {
    const st = fs.statSync(filePath);
    const size = typeof st.size === 'number' ? st.size : 0;
    return size >= maxBytes;
  } catch (err) {
    // Missing file is the normal case right after (re)configuring logging —
    // sonic-boom may not have flushed the first write yet. Silently treat it
    // as "no rotation needed". Anything else is surfaced through the degraded
    // flag path so it's still visible.
    if (err?.code && err.code !== 'ENOENT') {
      console.warn('[Logger] statSync failed during rotation check', {
        path: filePath,
        code: err.code
      });
    }
    return false;
  }
}

// Cross-process advisory lock for rotation. The in-memory `inFlight` flag
// only guards a single process; when the main process, utility processes,
// worker threads, and Piscina pools all write to the same log file via
// separate `logger.js` instances they each run their own rotation timer.
// Without a filesystem-level lock they can race: two of them observe the
// file is oversized on the same poll tick, both rename `stratosort.log` →
// `stratosort-N.log` in quick succession, and one of them ends up
// reconfiguring against a path the other already moved. The result is a
// dropped tail + duplicated rotation index in some rare cases.
const ROTATION_LOCK_STALE_MS = 30_000;

/**
 * @param {string} basePath
 * @returns {string|null}
 */
function _tryAcquireRotationLock(basePath) {
  const fs = _lazyFs();
  if (!fs) return null;
  const lockPath = `${basePath}.rotating`;
  try {
    const fd = fs.openSync(lockPath, 'wx');
    // Record pid so stale-recovery can distinguish a crashed writer from
    // a live one. We don't gate on pid-alive; mtime age is enough and
    // avoids pulling `process.kill(pid, 0)` into the logger hot path.
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    } catch {
      // Payload write is best-effort; losing it doesn't invalidate the lock.
    }
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    return lockPath;
  } catch (err) {
    if (err?.code !== 'EEXIST') return null;
    // Lock exists. If it's older than the stale window, reclaim it —
    // otherwise another live writer is handling this rotation and we
    // should skip this poll cycle rather than clobber them.
    try {
      const st = fs.statSync(lockPath);
      if (Date.now() - st.mtimeMs > ROTATION_LOCK_STALE_MS) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          return null;
        }
        try {
          const fd = fs.openSync(lockPath, 'wx');
          try {
            fs.closeSync(fd);
          } catch {
            /* ignore */
          }
          return lockPath;
        } catch {
          return null;
        }
      }
    } catch {
      // Lock stat unreadable — back off, another writer is probably live.
    }
    return null;
  }
}

/**
 * @param {string|null} lockPath
 */
function _releaseRotationLock(lockPath) {
  if (!lockPath) return;
  const fs = _lazyFs();
  if (!fs) return;
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Already gone (reclaimed by another process, or user deleted it).
  }
}

function _rotateLogFile() {
  if (_rotationState.inFlight) return;
  if (!_globalLogConfig.enableFile || !_globalLogConfig.logFile) return;
  const basePath = _globalLogConfig.logFile;
  if (!_shouldRotate(basePath, _rotationState.maxBytes)) return;
  if (_rotationState.rotationIndex >= MAX_LOG_ROTATIONS) {
    if (!_rotationState.rotationCapWarned) {
      _rotationState.rotationCapWarned = true;
      console.warn(
        `[Logger] Log rotation cap of ${MAX_LOG_ROTATIONS} reached; ${basePath} will grow unbounded for the rest of this session`
      );
    }
    return;
  }

  // Cross-process lock: only one writer should rotate at a time.
  const lockPath = _tryAcquireRotationLock(basePath);
  if (!lockPath) return;

  _rotationState.inFlight = true;
  try {
    // Re-check size under the lock. Another process may have just
    // completed rotation and truncated/rotated the file out from under
    // us between our pre-lock stat and the lock acquisition.
    if (!_shouldRotate(basePath, _rotationState.maxBytes)) return;

    _rotationState.rotationIndex += 1;
    // Derive from the stable original path, not the current (already
    // rotated) one — otherwise suffixes compound: `-1.log`, `-1-2.log`, ...
    const nextPath = _buildRotatedPath(
      _rotationState.basePath || basePath,
      _rotationState.rotationIndex
    );
    // Re-configure in place. This closes existing file streams and re-initializes
    // every active logger against the new path, keeping a single source of truth.
    configureFileLogging(nextPath, {
      enableConsole: _globalLogConfig.enableConsole,
      level: _globalLogConfig.level,
      maxBytes: _rotationState.maxBytes,
      pollMs: _rotationState.pollMs,
      onFileError: _rotationState.onError,
      _isRotation: true
    });
    console.info(`[Logger] Rotated log file due to size: ${nextPath}`);
  } catch (err) {
    console.error('[Logger] Log rotation failed', err?.message);
  } finally {
    _rotationState.inFlight = false;
    _releaseRotationLock(lockPath);
  }
}

function _startRotationTimer() {
  if (!_hasPinoTransport) return; // Renderer/browser has no file stream to rotate.
  if (_rotationState.timer) return;
  if (!_globalLogConfig.enableFile) return;
  const t = setInterval(_rotateLogFile, _rotationState.pollMs);
  if (typeof t.unref === 'function') t.unref();
  _rotationState.timer = t;
}

function _stopRotationTimer() {
  if (_rotationState.timer) {
    clearInterval(_rotationState.timer);
    _rotationState.timer = null;
  }
}

// Use webpack-safe require access (avoids bundling pino-pretty into renderer)
// __non_webpack_require__ is a webpack-injected global; access via globalThis to avoid TS4
const _safeRequire = /** @type {((id: string) => any)|null} */ (
  // @ts-expect-error __non_webpack_require__ is a webpack-injected global not in TS lib defs
  typeof __non_webpack_require__ === 'function'
    ? // @ts-expect-error __non_webpack_require__ is a webpack-injected global not in TS lib defs
      __non_webpack_require__
    : typeof module !== 'undefined' && typeof (/** @type {any} */ (module).require) === 'function'
      ? /** @type {any} */ (module).require.bind(module)
      : null
);

function _getSharedDevTransport() {
  if (_transportDead) return null;
  if (!_sharedDevTransport && _hasPinoTransport) {
    try {
      _sharedDevTransport = pino.transport({
        target: 'pino-pretty',
        options: { colorize: true }
      });
      // Prevent thread-stream worker death from becoming an uncaught exception.
      // If the worker ends, mark the transport as dead so we fall back to console.
      if (typeof _sharedDevTransport.on === 'function') {
        _sharedDevTransport.on('error', (/** @type {any} */ err) => {
          _transportDead = true;
          _sharedDevTransport = null;
          console.error(
            '[Logger] pino-pretty transport worker died, falling back to console:',
            err?.message
          );
        });
      }
    } catch {
      _transportDead = true;
      return null;
    }
  }
  return _sharedDevTransport;
}

/**
 * Best-effort redaction for production logs.
 * We keep this lightweight and dependency-free since it runs in both main/renderer.
 * @param {string|object} data
 * @returns {string|object}
 */
// Keys whose values should be fully redacted (case-insensitive substring
// match). Historically this was anchored with ^...$ which meant camelCase
// variants the app actually uses at runtime — `authToken`, `bearerToken`,
// `accessToken`, `clientSecret`, `sessionKey`, `refreshToken`,
// `cookieHeader`, `authHeader`, `huggingFaceToken` — did NOT redact, and the
// raw secrets were landing in structured log lines.
//
// Widening to a substring pattern errs on the side of redaction: a benign
// field whose name happens to contain "token" will log "[REDACTED]" instead
// of its real value. That's the correct failure direction for a logger.
const SENSITIVE_KEY_PATTERN =
  /(token|password|passwd|secret|apikey|api[_-]?key|authorization|auth[_-]?header|credential|priv(ate)?[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?key|cookie|bearer)/i;

// Hard cap on recursion depth for sanitizeLogData, layered on top of the
// WeakSet cycle guard inside the function: the seen-set stops cycles and
// shared references, the depth cap stops pathologically deep (acyclic)
// nesting. Beyond this depth we replace the subtree with a sentinel so the
// logger never crashes the process it is supposed to be diagnosing.
const MAX_SANITIZE_DEPTH = 12;

// Keys whose values are known to contain an absolute filesystem path to a
// user-identifying directory (home, userData, log directory). The generic
// string-level path regex handles most log messages, but object fields like
// `userDataPath` must *always* be reduced to their basename so startup
// diagnostics can't accidentally leak the OS username.
//
// NOTE: do NOT add user-content keys (filePath, sourcePath, destPath, etc.)
// to this pattern. Those are covered by the string-level absolute-path regex
// in `sanitizeLogData` which preserves the input separator style — adding
// them here would force forward-slash output and break the
// "does not aggressively redact unrelated *path keys like filePath" contract.
const PATH_LIKE_KEY_PATTERN =
  /^(userDataPath|userDataDir|userDataRoot|logFilePath|logFileDir|logsDir|logsPath|appDataPath|appDataDir|homeDir|homeDirectory|homePath|tempDir|tempPath|cacheDir|cachePath|crashDumpsDir|crashDumpsPath)$/i;

/**
 * @param {any} value
 */
function redactPathValue(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  // Normalize Windows separators and trim trailing slashes so we can pull a
  // clean basename regardless of how the path was formatted.
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = normalized.split('/').filter(Boolean);
  const basename = segments[segments.length - 1];
  if (!basename) return '[REDACTED_PATH]';
  return `[REDACTED_PATH]/${basename}`;
}

// Log-injection guard.
//
// Any user-derived string that reaches the logger (filenames, chat input,
// config values, error messages from external tools, IPC payloads, etc.) can
// in principle contain:
//   - newlines (\r, \n)       -> fake a separate log line that looks genuine
//   - ANSI escapes (\u001b)   -> forge colors / reposition the terminal cursor
//   - NUL / other C0 controls -> confuse line-oriented log consumers (tail,
//                                grep, shipping pipelines, SIEMs)
//
// We strip these at the logger boundary rather than trusting callers to
// sanitize every field they pass in. `\t` is allowed because many of our
// existing log lines already embed tabs for alignment.
//
// This runs inside `sanitizeLogData`, which is already invoked for every
// message + structured data object the logger emits, so there is exactly one
// chokepoint to maintain.
// eslint-disable-next-line no-control-regex
const LOG_CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000A-\u001F\u007F]/g;

/**
 * @param {any} value
 */
function stripLogControlChars(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (!LOG_CONTROL_CHAR_PATTERN.test(value)) {
    // Fast path: overwhelmingly common case — no-op.
    LOG_CONTROL_CHAR_PATTERN.lastIndex = 0;
    return value;
  }
  LOG_CONTROL_CHAR_PATTERN.lastIndex = 0;
  return value.replace(LOG_CONTROL_CHAR_PATTERN, (ch) => {
    const code = ch.charCodeAt(0);
    // Preserve visual newlines as an explicit escape so operators can still
    // see that the original payload had a newline — just without letting it
    // break line parsing downstream.
    if (code === 0x0a) return '\\n';
    if (code === 0x0d) return '\\r';
    return `\\x${code.toString(16).padStart(2, '0')}`;
  });
}

/**
 * @param {any} data
 * @param {number} [_depth]
 * @param {WeakSet<object>} [_seen]
 */
function sanitizeLogData(data, _depth = 0, _seen = undefined) {
  // Depth cap: guard against pathological nesting that would otherwise blow
  // the stack inside the logger itself.
  if (_depth > MAX_SANITIZE_DEPTH) {
    return '[REDACTED_DEPTH_EXCEEDED]';
  }
  // Strings: redact common absolute path patterns
  if (typeof data === 'string') {
    // Protect Node-internal module paths (`node:internal/...`) from path
    // redaction. These are public Node API references that appear in error
    // stacks and contain zero user info; redacting interior segments
    // produces strings like `node:internal[REDACTED_PATH]/task_queues:104:5`
    // that hide the actual call site (observed in runtime logs). Replace
    // each occurrence with a sentinel before redaction, then restore.
    /** @type {string[]} */
    const nodeInternalSentinels = [];
    let sanitized = data.replace(/node:internal\/[^\s)]+/g, (match) => {
      const idx = nodeInternalSentinels.length;
      nodeInternalSentinels.push(match);
      return `__STRATOSORT_NODEINTERNAL_${idx}__`;
    });
    sanitized = sanitized.replace(
      /[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*([^\\/:*?"<>|\r\n]+)/g,
      (_match, filename) => `[REDACTED_PATH]\\${filename}`
    );
    sanitized = sanitized.replace(
      /(?<!:)\/(?:[^/\s]+\/)+([^/\s]+)/g,
      (_match, filename) => `[REDACTED_PATH]/${filename}`
    );
    // Restore protected node:internal/... segments now that path redaction
    // has run. Sentinel uses control chars (/__) so it cannot
    // collide with any legitimate log content; stripLogControlChars below
    // would also remove them, so restore BEFORE that step.
    if (nodeInternalSentinels.length > 0) {
      sanitized = sanitized.replace(
        /__STRATOSORT_NODEINTERNAL_(\d+)__/g,
        (_match, idx) => nodeInternalSentinels[Number(idx)] || ''
      );
    }
    // Apply control-character stripping AFTER path redaction so the
    // replaced backslashes/forward slashes in the synthetic
    // `[REDACTED_PATH]/...` output aren't mistaken for control chars.
    return stripLogControlChars(sanitized);
  }

  if (typeof data === 'object' && data !== null) {
    // so message, stack, and code are preserved in log output
    if (data instanceof Error) {
      const _nodeErr = /** @type {NodeJS.ErrnoException} */ (data);
      return sanitizeLogData(
        {
          name: data.name,
          message: data.message,
          stack: data.stack,
          ...(_nodeErr.code ? { code: _nodeErr.code } : {})
        },
        _depth + 1,
        _seen
      );
    }
    // Cycle/shared-reference guard. The depth cap alone bounds stack depth
    // but not visit count: a self-referencing object with fanout k expands
    // to O(k^12) recursive visits, freezing the process synchronously
    // inside a log call. Track visited objects and short-circuit revisits.
    const seen = _seen || new WeakSet();
    if (seen.has(data)) {
      return '[CIRCULAR]';
    }
    seen.add(data);
    /** @type {Record<string, any>} */
    const sanitized = Array.isArray(data) ? [] : {};
    for (const [key, value] of Object.entries(data)) {
      // Redact values for sensitive key names
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        sanitized[key] = '[REDACTED]';
      } else if (PATH_LIKE_KEY_PATTERN.test(key) && typeof value === 'string') {
        sanitized[key] = redactPathValue(value);
      } else if (key === 'stack' && typeof value === 'string') {
        sanitized[key] = sanitizeLogData(value, _depth + 1, seen);
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = sanitizeLogData(value, _depth + 1, seen);
      } else if (typeof value === 'string') {
        sanitized[key] = sanitizeLogData(value, _depth + 1, seen);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  return data;
}

/**
 * @param {any} value
 */
function isStructuredLogValue(value) {
  return value instanceof Error || (typeof value === 'object' && value !== null);
}

/**
 * @param {any} message
 * @param {any[]} [args]
 */
function normalizeLogCall(message, args = []) {
  if (!args.length) {
    return { message, data: undefined };
  }

  if (args.length === 1 && isStructuredLogValue(args[0])) {
    return { message, data: args[0] };
  }

  if (args.length > 1 && isStructuredLogValue(args[args.length - 1])) {
    return {
      message: util.format(message, ...args.slice(0, -1)),
      data: args[args.length - 1]
    };
  }

  return {
    message: util.format(message, ...args),
    data: undefined
  };
}

/**
 * @param {any[]} [messages]
 */
function normalizeBrowserTransmit(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { message: '', data: {} };
  }

  if (isStructuredLogValue(messages[0]) && typeof messages[1] === 'string') {
    return {
      message: messages[1],
      data: messages[0]
    };
  }

  if (typeof messages[0] === 'string') {
    if (messages.length === 2 && isStructuredLogValue(messages[1])) {
      return {
        message: messages[0],
        data: messages[1]
      };
    }

    if (messages.length > 2 && isStructuredLogValue(messages[messages.length - 1])) {
      return {
        message: util.format(messages[0], ...messages.slice(1, -1)),
        data: messages[messages.length - 1]
      };
    }

    return {
      message: util.format(...messages),
      data: {}
    };
  }

  return {
    message: util.format(...messages),
    data: {}
  };
}

class Logger {
  /**
   * @param {string} [context]
   * @param {{ deferInit?: boolean, [key: string]: any }} [options]
   */
  constructor(context = '', options = {}) {
    this.context = context;
    this.enableFile = false;
    this.logFile = null;
    this.enableConsole = true;
    this.level = process.env.NODE_ENV === 'development' ? 'debug' : 'info';

    // Initialize Pino instance
    // Clean up dead weak refs occasionally
    if (_activeLoggers.size % 10 === 0) {
      for (const ref of _activeLoggers) {
        if (!ref.deref()) _activeLoggers.delete(ref);
      }
    }
    _activeLoggers.add(new WeakRef(this));
    this._applyGlobalConfig();
    // Allow deferring _initPino when the caller (e.g. createLogger) will
    // override properties and call _initPino itself, avoiding a wasted init.
    if (!options.deferInit) {
      this._initPino(options);
    }
  }

  _applyGlobalConfig() {
    if (_globalLogConfig.enableFile) {
      this.enableFile = true;
      this.logFile = _globalLogConfig.logFile;
    }
    if (typeof _globalLogConfig.enableConsole === 'boolean') {
      this.enableConsole = _globalLogConfig.enableConsole;
    }
    if (typeof _globalLogConfig.level === 'string') {
      this.level = _globalLogConfig.level;
    }
  }

  _initPino(options = {}) {
    const isDev = process.env.NODE_ENV === 'development';
    // Detect non-main contexts: renderer (process.type === 'renderer'),
    // preload (no process.type but window exists), or browser pino build.
    const isRenderer =
      (typeof process !== 'undefined' && process.type === 'renderer') || !_hasPinoTransport;

    // Shared destinations are ended centrally by configureFileLogging once
    // every logger has been re-pointed (see _closeStaleFileDestinations).
    this._fileStream = null;

    const pinoOptions = {
      level: this.level,
      base: {
        pid: typeof process !== 'undefined' ? process.pid : undefined,
        context: this.context
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (/** @type {string} */ label) => ({ level: label })
      },
      mixin: () => {
        const correlationId = getCorrelationId();
        return correlationId ? { correlationId } : {};
      },
      // Use built-in redaction for simple keys, but we rely on sanitizeLogData for complex logic
      redact: {
        paths: ['*.password', '*.token', '*.secret', '*.key'],
        remove: true
      },
      ...options
    };

    if (isRenderer) {
      // Browser/Renderer configuration
      this.pino = pino({
        ...pinoOptions,
        browser: {
          // Renderer logs are forwarded to main process via transmit below.
          // Avoid duplicate/noisy Chromium console output like "[object Object]".
          asObject: true,
          write: () => {},
          transmit: {
            level: this.level,
            send: (level, logEvent) => {
              /** @type {any} */
              const _win = typeof window !== 'undefined' ? window : undefined;
              if (
                _win &&
                _win.__STRATOSORT_SHUTTING_DOWN__ !== true &&
                _win.electronAPI?.system?.log
              ) {
                // Ensure messages property is serialized correctly
                const { message, data } = normalizeBrowserTransmit(logEvent.messages || []);

                // Use non-blocking fire-and-forget for logs
                _win.electronAPI.system.log(level, message, data).catch(() => {
                  // Silently fail if log transmission fails to avoid loops
                });
              }
            }
          }
        }
      });
    } else {
      // Main process configuration
      let transport;
      let streams = null;

      if (this.logFile && this.enableFile) {
        streams = [];
        try {
          const fileStream = _getSharedFileDestination(this.logFile);
          this._fileStream = fileStream;
          streams.push({ level: this.level, stream: fileStream });
        } catch (error) {
          console.error('[Logger] Failed to open log file stream:', error?.message);
          _emitFileError(error);
        }

        if (this.enableConsole !== false) {
          if (!isRenderer && isDev) {
            try {
              const prettyFactory = _safeRequire ? _safeRequire('pino-pretty') : null;
              if (typeof prettyFactory === 'function') {
                const pretty = prettyFactory({ colorize: true });
                streams.push({ level: this.level, stream: pretty });
              } else {
                throw new Error('pino-pretty not available');
              }
            } catch (error) {
              console.warn('[Logger] pino-pretty unavailable, using stdout:', error?.message);
              streams.push({ level: this.level, stream: process.stdout });
            }
          } else {
            streams.push({ level: this.level, stream: process.stdout });
          }
        }
      } else if (isDev) {
        // Console only — reuse module-level shared transport in dev
        transport = _getSharedDevTransport();
      }

      if (streams && streams.length > 0 && typeof pino.multistream === 'function') {
        this.pino = pino(pinoOptions, pino.multistream(streams));
      } else {
        // to avoid spawning a separate pino worker per logger instance.
        // Only custom transports (e.g. file logging) get their own stream.
        this.pino = pino(pinoOptions, transport || undefined);
      }
    }
  }

  /**
   * @param {string|number} level
   */
  setLevel(level) {
    // Map legacy numeric/string levels to Pino strings
    const allowed = ['error', 'warn', 'info', 'debug', 'trace'];
    if (typeof level === 'number') {
      this.level = allowed[level] || 'info';
    } else if (typeof level === 'string') {
      const normalized = level.toLowerCase();
      this.level = allowed.includes(normalized) ? normalized : 'info';
    } else {
      this.level = 'info';
    }
    if (this.pino) {
      this.pino.level = this.level;
    }
  }

  /**
   * @param {string} context
   */
  setContext(context) {
    this.context = context;
    // Re-bind pino child with new context
    this.pino = this.pino.child({ context });
  }

  /**
   * @param {string} logFile
   * @param {object} [_options]
   */
  enableFileLogging(logFile, _options = {}) {
    configureFileLogging(logFile, _options);
  }

  disableConsoleLogging() {
    configureConsoleLogging(false);
  }

  // API Compatibility methods
  /**
   * @param {string|number} level
   * @param {any} message
   * @param {...any} args
   */
  log(level, message, ...args) {
    // Legacy generic log method
    const lvl = typeof level === 'number' ? LOG_LEVEL_NAMES[level]?.toLowerCase() : level;
    if (/** @type {any} */ (this)[lvl]) {
      /** @type {any} */ (this)[lvl](message, ...args);
    } else {
      this.info(message, ...args);
    }
  }

  // Core logging methods — wrapped in _safeWrite to survive thread-stream death.
  // If the pino-pretty transport worker has ended, we degrade gracefully to
  // console output instead of crashing the Electron main process.
  /**
   * @param {string} level
   * @param {any} message
   * @param {any} [data]
   */
  _safeWrite(level, message, data) {
    // Sanitization must not crash the caller: Object.entries() invokes
    // getters, so a throwing getter (or revoked Proxy) in logged data would
    // otherwise propagate out of the logger into the operation it is
    // supposed to be diagnosing.
    let sanitizedMessage;
    let sanitized;
    try {
      sanitizedMessage = typeof message === 'string' ? sanitizeLogData(message) : message;
    } catch {
      sanitizedMessage = String(message);
    }
    try {
      sanitized = data ? sanitizeLogData(data) : undefined;
    } catch {
      // Keep object shape: pino treats a string first arg as the message.
      sanitized = { data: '[UNSERIALIZABLE_LOG_DATA]' };
    }
    try {
      const _pino = /** @type {any} */ (this.pino);
      if (sanitized) _pino[level](sanitized, sanitizedMessage);
      else _pino[level](sanitizedMessage);
    } catch (err) {
      if (
        /** @type {any} */ (err)?.message?.includes('worker is ending') ||
        /** @type {any} */ (err)?.message?.includes('stream')
      ) {
        // Transport died mid-write. Fall back to console to keep the app alive.
        _transportDead = true;
        _sharedDevTransport = null;
        const fallback = level === 'error' || level === 'warn' ? level : 'log';
        /** @type {any} */ (console)[fallback](
          `[${this.context || 'App'}] ${sanitizedMessage}`,
          sanitized || ''
        );
      } else {
        throw err; // Re-throw non-transport errors
      }
    }
  }

  /** @param {any} message @param {...any} args */
  error(message, ...args) {
    const normalized = normalizeLogCall(message, args);
    this._safeWrite('error', normalized.message, normalized.data);
  }

  /** @param {any} message @param {...any} args */
  warn(message, ...args) {
    const normalized = normalizeLogCall(message, args);
    this._safeWrite('warn', normalized.message, normalized.data);
  }

  /** @param {any} message @param {...any} args */
  info(message, ...args) {
    const normalized = normalizeLogCall(message, args);
    this._safeWrite('info', normalized.message, normalized.data);
  }

  /** @param {any} message @param {...any} args */
  debug(message, ...args) {
    const normalized = normalizeLogCall(message, args);
    this._safeWrite('debug', normalized.message, normalized.data);
  }

  /** @param {any} message @param {...any} args */
  trace(message, ...args) {
    const normalized = normalizeLogCall(message, args);
    this._safeWrite('trace', normalized.message, normalized.data);
  }

  // `fatal` is accepted by SYSTEM.LOG IPC (see ALLOWED_LOG_LEVELS in
  // `src/main/ipc/system.js`) but the Logger class previously had no
  // `fatal()` method, so renderer-side `logger.fatal(...)` calls (or any
  // dispatch that landed at this level) silently no-op'd. Pino itself
  // supports `fatal` natively, so we just route through `_safeWrite` and
  // existing transport behavior carries through.
  /** @param {any} message @param {...any} args */
  fatal(message, ...args) {
    const normalized = normalizeLogCall(message, args);
    this._safeWrite('fatal', normalized.message, normalized.data);
  }

  // Convenience methods
  /**
   * @param {string} operation
   * @param {string} filePath
   * @param {string} [result]
   */
  fileOperation(operation, filePath, result = 'success') {
    this.info(`File ${operation}`, { filePath, result });
  }

  /**
   * @param {string} filePath
   * @param {string} model
   * @param {number} duration
   * @param {number} confidence
   */
  aiAnalysis(filePath, model, duration, confidence) {
    this.info('AI Analysis completed', {
      filePath,
      model,
      duration: `${duration}ms`,
      confidence: `${confidence}%`
    });
  }

  /**
   * @param {string} fromPhase
   * @param {string} toPhase
   * @param {object} [data]
   */
  phaseTransition(fromPhase, toPhase, data = {}) {
    this.info(`Phase transition: ${fromPhase} → ${toPhase}`, data);
  }

  /**
   * @param {string} operation
   * @param {number} duration
   * @param {object} [metadata]
   */
  performance(operation, duration, metadata = {}) {
    this.debug(`Performance: ${operation}`, {
      duration: `${duration}ms`,
      ...metadata
    });
  }

  /**
   * @param {string} level
   * @param {any} message
   * @param {object} [data]
   */
  terminal(level, message, data = {}) {
    const lvl = (typeof level === 'string' ? level : 'info').toLowerCase();
    if (/** @type {any} */ (this.pino)[lvl]) {
      this._safeWrite(lvl, message, data);
    }
  }

  /** @param {any} text */
  terminalRaw(text) {
    this._safeWrite('info', text);
  }
}

// Create singleton instance
const logger = new Logger();

// Factory functions
/**
 * @param {string} context
 */
function createLogger(context) {
  // Defer init in constructor — we override properties below and init once.
  const contextLogger = new Logger(context, { deferInit: true });
  // Inherit settings from singleton
  contextLogger.level = logger.level;
  contextLogger.enableFile = logger.enableFile;
  contextLogger.logFile = logger.logFile;
  contextLogger.enableConsole = logger.enableConsole;
  contextLogger._initPino(); // Single init with inherited settings
  return contextLogger;
}

/**
 * Route main-process pino output to a JSONL file (and optional console).
 * Log retention (age + max files) is handled by ErrorHandler.cleanupLogs in simple-main.
 *
 * @param {string} logFilePath Absolute path to the session log file.
 * @param {object} [options]
 * @param {boolean} [options.enableConsole] Mirror logs to console.
 * @param {string}  [options.level] Override the log level.
 * @param {number}  [options.maxBytes] Rotate the file once it exceeds this size
 *   (bytes). Defaults to 100 MB. Set to 0/Infinity to disable rotation.
 * @param {number}  [options.pollMs] How often to check the file size for
 *   rotation. Defaults to 15s.
 * @param {(err: Error) => void} [options.onFileError] Invoked whenever the
 *   underlying file stream emits an error (disk full, read-only fs, etc.).
 *   Intended hook for raising a DegradedStateTracker flag.
 * @param {boolean} [options._isRotation] Internal: true when called recursively
 *   by the rotation timer, so we don't reset the rotation counter or onError.
 */
function configureFileLogging(logFilePath, options = {}) {
  _globalLogConfig.enableFile = true;
  _globalLogConfig.logFile = logFilePath;
  if (typeof options.enableConsole === 'boolean') {
    _globalLogConfig.enableConsole = options.enableConsole;
  }
  if (typeof options.level === 'string') {
    _globalLogConfig.level = options.level;
  }

  // Rotation config is sticky across calls except when caller explicitly
  // overrides. On a fresh `configureFileLogging` (not a rotation), reset the
  // sequence counter so the numbering restarts per session.
  if (typeof options.maxBytes === 'number' && options.maxBytes > 0) {
    _rotationState.maxBytes = options.maxBytes;
  }
  if (typeof options.pollMs === 'number' && options.pollMs > 0) {
    _rotationState.pollMs = options.pollMs;
  }
  if (typeof options.onFileError === 'function') {
    _rotationState.onError = options.onFileError;
  }
  if (!options._isRotation) {
    _rotationState.rotationIndex = 0;
    _rotationState.rotationCapWarned = false;
    _rotationState.diskErrorRaised = false;
    _rotationState.basePath = logFilePath;
  }

  for (const ref of _activeLoggers) {
    const instance = ref.deref();
    if (instance) {
      instance.enableFile = true;
      instance.logFile = logFilePath;
      if (typeof options.enableConsole === 'boolean') {
        instance.enableConsole = options.enableConsole;
      }
      if (typeof options.level === 'string') {
        instance.level = options.level;
      }
      instance._initPino();
    } else {
      _activeLoggers.delete(ref);
    }
  }
  _closeStaleFileDestinations(logFilePath);

  // Kick off (or reset) the rotation poll timer. Safe to call repeatedly.
  _stopRotationTimer();
  _startRotationTimer();
}

/**
 * Set the global log level at runtime and propagate it to the singleton plus
 * every active logger instance. Driven by the `loggingLevel` user setting so a
 * Settings change takes effect immediately without an app restart.
 *
 * @param {string} level One of error|warn|info|debug|trace (case-insensitive).
 */
function setGlobalLogLevel(level) {
  if (typeof level !== 'string' || level.trim() === '') return;
  logger.setLevel(level);
  // Persist the resolved (normalized) level so loggers created later inherit it.
  _globalLogConfig.level = logger.level;
  for (const ref of _activeLoggers) {
    const instance = ref.deref();
    if (instance) {
      instance.setLevel(level);
    } else {
      _activeLoggers.delete(ref);
    }
  }
}

/**
 * @param {boolean} enableConsole
 */
function configureConsoleLogging(enableConsole) {
  if (typeof enableConsole === 'boolean') {
    _globalLogConfig.enableConsole = enableConsole;
  }

  for (const ref of _activeLoggers) {
    const instance = ref.deref();
    if (instance) {
      if (typeof enableConsole === 'boolean') {
        instance.enableConsole = enableConsole;
      }
      instance._initPino();
    } else {
      _activeLoggers.delete(ref);
    }
  }
}

/**
 * Safe logger factory with console fallback for cross-process safety.
 * Use in shared modules that may be loaded before the logger is fully initialized.
 * @param {string} name
 */
function createSafeLogger(name) {
  try {
    return createLogger(name);
  } catch {
    return {
      debug: () => {},
      info: () => {},
      warn: console.warn.bind(console, `[${name}]`),
      error: console.error.bind(console, `[${name}]`)
    };
  }
}

/**
 * Gracefully flush and end all pino streams/transports before process exit.
 *
 * Pino's `sonic-boom` registers a synchronous `process.on('exit')` hook via
 * `on-exit-leak-free` that calls `flushSync()`. If the sonic-boom instance
 * hasn't finished its async open yet, `flushSync` throws
 * "sonic boom is not ready yet" — which Electron surfaces as an uncaught
 * exception dialog on quit.
 *
 * Call this *before* `app.exit()` to let streams finish writing and
 * deregister their exit hooks cleanly.
 *
 * @returns {Promise<void>}
 */
async function shutdownLogging() {
  const FLUSH_TIMEOUT = 3000;
  _stopRotationTimer();

  /** @param {any} pinoInstance */
  const flushOne = (pinoInstance) =>
    new Promise((resolve) => {
      if (!pinoInstance) return resolve();
      try {
        pinoInstance.flush?.();
      } catch {
        // flush may throw if stream already ended
      }
      const dest = pinoInstance[Symbol.for('pino.serializers')] ? undefined : pinoInstance;
      const stream = dest?.stream ?? pinoInstance[Symbol.for('pino.stream')];
      if (stream && typeof stream.end === 'function') {
        stream.once('close', resolve);
        stream.once('error', resolve);
        stream.end();
      } else {
        resolve();
      }
    });

  const tasks = [];
  for (const ref of _activeLoggers) {
    const instance = ref.deref();
    if (instance?.pino) {
      tasks.push(flushOne(instance.pino));
    }
  }

  if (_sharedDevTransport && typeof _sharedDevTransport.end === 'function') {
    tasks.push(
      new Promise((resolve) => {
        _sharedDevTransport.once('close', resolve);
        _sharedDevTransport.once('error', resolve);
        _sharedDevTransport.end();
      })
    );
    _transportDead = true;
    _sharedDevTransport = null;
  }

  if (tasks.length > 0) {
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise((resolve) => setTimeout(resolve, FLUSH_TIMEOUT))
    ]);
  }
}

module.exports = {
  Logger,
  logger,
  LOG_LEVELS,
  createLogger,
  createSafeLogger,
  sanitizeLogData,
  stripLogControlChars,
  _normalizeLogCall: normalizeLogCall,
  _normalizeBrowserTransmit: normalizeBrowserTransmit,
  configureFileLogging,
  configureConsoleLogging,
  setGlobalLogLevel,
  shutdownLogging,
  // Exposed for tests and for callers that need to force a rotation check
  // (e.g. after a known log-heavy burst). Not part of the public runtime API.
  _rotateLogFileNow: _rotateLogFile,
  _getLogRotationState: () => ({ ..._rotationState, timer: /** @type {undefined} */ (undefined) }),
  _getSharedFileDestinationPaths: () => [..._destinationsByPath.keys()],
  MAX_LOG_ROTATIONS
};
