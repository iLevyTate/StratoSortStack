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
// Set by shutdownLogging. A file stream can still be opening when logging
// shuts down (sonic-boom opens asynchronously); if its open then fails, there
// is no one left to tell, and in Jest the late console.error lands after the
// test has finished ("Cannot log after tests are done"), which failed whole
// CI runs on otherwise green suites. Cleared when file logging is configured.
// Streams are deliberately left open here: the app keeps logging until it
// exits, and pino's exit hook flushes them (see shutdownLogging).
let _loggingShutDown = false;
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
  if (_loggingShutDown) return;
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
  if (isHomeFolderPath(normalized)) return '[REDACTED_PATH]';
  return `[REDACTED_PATH]/${basename}`;
}

// A path whose last segment sits directly in a user root (`Users`, `home`)
// is a home folder, and that last segment is the OS account name, so it is
// not kept (see redactHomeFolderName). This also hides `C:\Users\Public` or
// a file stored right in a user root, which is the safe direction.
const HOME_FOLDER_PATH_PATTERN = /(?:^|[\\/])(?:users|home)[\\/]+[^\\/]+$/i;
// The account name in a matched last segment: everything up to a quote or
// closing punctuation, which belongs to the text around the path
// (`'C:\Users\jdoe'`, `"/Users/jdoe","to"`). A Windows segment may run on
// into prose after a space; that prose is hidden with the name, since a
// Windows account name can itself contain spaces. A POSIX segment already
// stops at whitespace, so in free text `/Users/jane doe` still shows "doe".
const HOME_FOLDER_NAME_PATTERN = /^[^"'\x60)\]},;]*/;

/**
 * @param {string} matched A whole path with no trailing separator.
 */
function isHomeFolderPath(matched) {
  return HOME_FOLDER_PATH_PATTERN.test(matched);
}

/**
 * `[REDACTED_PATH]` in place of the account name at the start of a home
 * folder's last segment, keeping what follows the name (and trailing dots
 * that end a sentence).
 * @param {string} segment
 */
function redactHomeFolderName(segment) {
  const name = (segment.match(HOME_FOLDER_NAME_PATTERN)?.[0] ?? '').replace(/\.+$/, '');
  if (!name) return '[REDACTED_PATH]';
  return `[REDACTED_PATH]${segment.slice(name.length)}`;
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

// Windows absolute-path redaction (drive and UNC), reduced to
// `[REDACTED_PATH]<sep>basename` where <sep> is the separator the path used
// before its last segment, so a JSON-escaped path (`C:\\Users\\x.pdf`) stays
// valid JSON as `[REDACTED_PATH]\\x.pdf`.
//
// A path segment runs to a character Windows forbids in names, so names with
// spaces, brackets and parentheses stay whole. It also stops before the next
// drive (`D:\`, `D:/`): otherwise the last segment of the first path in
// `move C:\a\x.pdf to D:\b\x.pdf` swallows " to D" and the second path is left
// raw, user folders and all.
//
// A path keeps the separator style it starts with (captured as group 1 and
// matched again by back-reference): `C:\...` continues only on single `\`,
// JSON-escaped `C:\\...` only on `\\`, and `C:/...` only on `/`. A later `/`
// on the same line therefore ends a backslash path instead of extending it:
// `Moved C:\a\x.pdf to Finance/Taxes` keeps " to Finance/Taxes" after the
// name rather than collapsing to `[REDACTED_PATH]/Taxes`. Segments never
// contain `\` or `/`, so segment and separator are disjoint and matching
// stays linear.
//
// The style may switch where the segment before the other separator has no
// whitespace (`C:\Users\jdoe/Documents/x.pdf`, `C:/Users/jdoe\Docs\x.pdf`):
// such a segment cannot be a file name followed by prose, and ending the
// path there would leave the user folder raw in front of a second,
// separately redacted path. After a switch the path continues on the new
// style (see redactWindowsPaths).
const PATH_SEGMENT = String.raw`(?:(?![A-Za-z]:[\\/])[^\\/:*?"<>|\r\n])+`;
// A drive letter preceded by a letter or digit is not a drive: it is the tail
// of a URL scheme (`https://`) or a word, which the POSIX pass handles.
const WINDOWS_DRIVE_PATH_PATTERN = new RegExp(
  String.raw`(?<![A-Za-z0-9])[A-Za-z]:(\\+|\/)(?:${PATH_SEGMENT}\1)*${PATH_SEGMENT}`,
  'g'
);
// `\\server\share\...` (or `\\\\server\\share\\...` once JSON-escaped): the
// prefix is the separator written twice. Only backslashes open it, so `//` in
// a URL never does. A server and at least one more segment are required. It
// only starts at the first backslash of a run, and the separator is at most
// four backslashes, so a long run is never retried from every position.
const WINDOWS_UNC_PATH_PATTERN = new RegExp(
  String.raw`(?<!\\)(\\{1,4})\1${PATH_SEGMENT}(?:\1${PATH_SEGMENT})+`,
  'g'
);
// The last separator run and the basename of a matched Windows path.
const WINDOWS_PATH_TAIL_PATTERN = /([\\/]+)([^\\/]+)$/;
// The rest of a Windows path after a separator-style switch: a separator run
// of the new style, then segments on that style. Sticky, so it only matches
// exactly where the switch is.
const WINDOWS_PATH_CONTINUATION_PATTERN = new RegExp(
  String.raw`(\\+|\/)(?:${PATH_SEGMENT}\1)*${PATH_SEGMENT}`,
  'y'
);
const HAS_WHITESPACE_PATTERN = /\s/;

/**
 * @param {string} matched A whole drive or UNC path matched above.
 */
function redactWindowsPathMatch(matched) {
  const tail = matched.match(WINDOWS_PATH_TAIL_PATTERN);
  // Both patterns end in a separator followed by a segment, so this holds.
  if (!tail) return '[REDACTED_PATH]';
  if (isHomeFolderPath(matched)) return redactHomeFolderName(tail[2]);
  return `[REDACTED_PATH]${tail[1]}${tail[2]}`;
}

/**
 * Redact every path `pattern` (the drive or UNC pattern; group 1 is the
 * separator the path starts with) finds in `text`, first extending each
 * match across separator-style switches, then reducing it to its basename.
 * Every character is consumed by at most one match or continuation, so this
 * stays linear like the patterns themselves.
 * @param {string} text
 * @param {RegExp} pattern
 */
function redactWindowsPaths(text, pattern) {
  pattern.lastIndex = 0;
  let out = '';
  let copiedTo = 0;
  /** @type {RegExpExecArray | null} */
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    let end = start + match[0].length;
    let separator = match[1];
    let lastSegment = match[0].match(WINDOWS_PATH_TAIL_PATTERN)?.[2] ?? '';
    // Only a switch to the other separator character extends the path; a
    // different run of the same character (`\` after `\\`) still ends it.
    while (
      (text[end] === '\\' || text[end] === '/') &&
      text[end] !== separator[0] &&
      !HAS_WHITESPACE_PATTERN.test(lastSegment)
    ) {
      WINDOWS_PATH_CONTINUATION_PATTERN.lastIndex = end;
      const rest = WINDOWS_PATH_CONTINUATION_PATTERN.exec(text);
      if (!rest) break;
      end += rest[0].length;
      separator = rest[1];
      lastSegment = rest[0].match(WINDOWS_PATH_TAIL_PATTERN)?.[2] ?? '';
    }
    out += text.slice(copiedTo, start) + redactWindowsPathMatch(text.slice(start, end));
    copiedTo = end;
    pattern.lastIndex = end;
  }
  pattern.lastIndex = 0;
  return copiedTo === 0 ? text : out + text.slice(copiedTo);
}

// POSIX absolute-path redaction, reduced to `[REDACTED_PATH]/basename`.
//
// Free text cannot say where a POSIX path ends: `/a/b c/d` may be one path
// whose folder is "b c", or the path `/a/b` followed by prose. So spaces are
// only allowed inside folder names when the path starts at a root where
// macOS and Linux keep user folders (`/Users`, `/home`, `/Volumes`, ...) or
// at `~/`. The macOS roots are also matched in lower case, because the app's
// own file ids lower-case the path on darwin (`file:/users/<name>/...`, from
// normalizePathForIndex). Any other path (and a path glued to a word, as in a URL)
// keeps the old rule, cut at the first whitespace, so prose such as
// "read/write and/or" is redacted no more than before.
//
// Under a known root a folder name is words joined by single spaces (a
// no-break space U+00A0 or narrow no-break space U+202F counts) and must
// be followed by `/`; the last segment (the file name, which is kept) still
// stops at whitespace. To keep two paths on one line apart, a word after a
// space cannot contain `" \` : ; = < > | * ?` or a backtick, cannot be only
// opening punctuation (`(`, `[`, `{`, `'`), and cannot start a
// `[REDACTED_PATH]` token, so `'/a/x.pdf' '/a/y.pdf'`, `(…) (…)`,
// `src=… dest=…`, `x.pdf: /…` and `x.pdf -> /…` all split. `, ` is allowed
// inside a folder name ("Smith, John"); a path after `, ` still splits
// because it starts with a space and `/`. The first word of a folder name
// takes anything the old rule took, except a `"` that closes a JSON string
// (followed by `, : } ]`), so a JSON array of paths keeps each file name.
// A word that looks like a file name (`x.pdf`) followed by a space ends the
// path at that word (web endings `.com .org .net .io .edu .gov` do not
// count, so "Amazon.com Orders" stays one folder), so in `Moved /Users/a/x.pdf to Finance/Taxes` the name
// and the relative destination after it stay readable. The cost: a folder
// name with a file-like word before a space (`notes.txt and more`) ends
// protection there and the rest of the path shows. A relative path after a
// path whose last word does not look like a file name is still read as part
// of it, hiding too much, which is the safe direction.
//
// The rooted path may follow the start of the text, whitespace, a quote,
// opening punctuation, `= , ; | < > :`, or `file://` (an unencoded file
// URL). `:` covers `file:/users/...` ids and `cwd:/Users/...` labels; a
// Windows drive (`C:/`) is redacted by the earlier pass, `node:internal/...`
// is protected before any pass, and a URL path has a host, not `:`, before
// its first slash.
// Words and separators are disjoint character sets, each word has a single
// way to end, and every quantifier is bounded by a character the next one
// cannot take, so matching stays linear.
const POSIX_ROOTS = [
  'Users',
  'home',
  'Volumes',
  'private',
  'var',
  'tmp',
  'mnt',
  'media',
  'opt',
  'Library',
  'Applications',
  'System',
  'Network',
  'users',
  'volumes',
  'library',
  'applications',
  'system',
  'network',
  'root',
  'srv',
  'run/media',
  'run/user',
  'net'
].join('|');
// Where a POSIX path may start (see above): the start of the text,
// whitespace, a quote, opening punctuation, `= , ; | < > :` or `file://`.
const POSIX_PATH_BOUNDARY = String.raw`(?<=^|[\s"'\x60([{<>=,;|:]|file:\/\/)`;
const POSIX_ROOTED_START = String.raw`${POSIX_PATH_BOUNDARY}(?:\/(?:${POSIX_ROOTS})|~)(?=\/)`;
// First word of a folder name: the old segment rule minus a closing JSON quote.
const POSIX_FIRST_WORD = String.raw`(?:[^\s/"]|"(?![,:}\]]))+`;
// A later word: optional opening punctuation, then at least one other character.
const POSIX_WORD_CHAR = String.raw`[^\s/\\"\x60:;=<>|*?]`;
const POSIX_WORD_CORE = String.raw`[^\s/\\"\x60:;=<>|*?([{']`;
const POSIX_LATER_WORD = String.raw`(?!\[REDACTED_PATH\])[([{']*${POSIX_WORD_CORE}${POSIX_WORD_CHAR}*`;
// A word that ends like a file name (`.` + a letter + up to 7 letters or
// digits: `x.pdf`, `scan.JPG`; not `v1.2` or `1.2.3`) cannot be followed by
// a space inside a folder name, so the path ends at that word.
const POSIX_WEB_ENDING = String.raw`\.(?:[Cc][Oo][Mm]|[Oo][Rr][Gg]|[Nn][Ee][Tt]|[Ii][Oo]|[Ee][Dd][Uu]|[Gg][Oo][Vv])`;
const POSIX_NOT_AFTER_FILE_NAME = String.raw`(?:(?<!\.[A-Za-z][A-Za-z0-9]{0,7})|(?<=${POSIX_WEB_ENDING}))`;
// The space between two words of a folder name.
const POSIX_WORD_SPACE = String.raw`[ \u00A0\u202F]`;
const POSIX_FOLDER = String.raw`${POSIX_FIRST_WORD}(?:${POSIX_NOT_AFTER_FILE_NAME}${POSIX_WORD_SPACE}${POSIX_LATER_WORD})*`;
// Group 1: the basename of a rooted path. Group 2: the basename of a path
// under any other root whose top-level folder has a space (`/Shared Drives/
// Team X/x.pdf`): no other rule could anchor on it, so it would be left
// whole. It starts only at a path boundary and its folders follow the rooted
// rule, so prose such as "the /a b c route" (no `/` after the words) is not
// a path. Group 3: the basename of any other path (the old rule, which never
// starts right after `:` so `https://` and `file://` keep their scheme).
const POSIX_PATH_PATTERN = new RegExp(
  String.raw`${POSIX_ROOTED_START}(?:\/${POSIX_FOLDER})*\/([^/\s]+)` +
    String.raw`|${POSIX_PATH_BOUNDARY}\/(?=${POSIX_FIRST_WORD}${POSIX_WORD_SPACE})${POSIX_FOLDER}(?:\/${POSIX_FOLDER})*\/([^/\s]+)` +
    String.raw`|(?<!:)\/(?:[^/\s]+\/)+([^/\s]+)`,
  'g'
);

// A character after which a path stands on its own (POSIX_PATH_BOUNDARY
// minus `:`, which the old rule never follows). A match of the old rule
// glued to a word, as in a URL (`https://host/home/x`), is a route rather
// than a home folder.
const POSIX_STANDALONE_BEFORE_PATTERN = /[\s"'\x60([{<>=,;|]/;

/**
 * @param {string} match
 * @param {string | undefined} rootedName
 * @param {string | undefined} spacedRootName
 * @param {string | undefined} otherName
 * @param {number} offset
 * @param {string} text
 */
function redactPosixPathMatch(match, rootedName, spacedRootName, otherName, offset, text) {
  const name = rootedName ?? spacedRootName ?? otherName ?? '';
  const standalone =
    otherName === undefined ||
    offset === 0 ||
    POSIX_STANDALONE_BEFORE_PATTERN.test(text.charAt(offset - 1));
  if (standalone && isHomeFolderPath(match)) return redactHomeFolderName(name);
  return `[REDACTED_PATH]/${name}`;
}

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

// A key that could carry a path (a separator) or a forged line (a control
// character). Every other key is copied as is, so the common case costs one
// test.
// eslint-disable-next-line no-control-regex
const KEY_NEEDS_SANITIZING_PATTERN = /[\\/\u0000-\u0008\u000A-\u001F\u007F]/;

/**
 * An object key as it may be written: run through the same string rules as
 * values (a per-file map keyed by path must not print the path), and made
 * unique within `target` so two keys that reduce to the same text
 * (`[REDACTED_PATH]\x.pdf`) both keep their value.
 * @param {string} key
 * @param {Record<string, any>} target The object being built.
 */
function sanitizeLogKey(key, target) {
  if (!KEY_NEEDS_SANITIZING_PATTERN.test(key)) return key;
  const safeKey = sanitizeLogData(key);
  if (!Object.prototype.hasOwnProperty.call(target, safeKey)) return safeKey;
  let n = 2;
  while (Object.prototype.hasOwnProperty.call(target, `${safeKey} #${n}`)) n += 1;
  return `${safeKey} #${n}`;
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
    sanitized = redactWindowsPaths(sanitized, WINDOWS_DRIVE_PATH_PATTERN);
    sanitized = redactWindowsPaths(sanitized, WINDOWS_UNC_PATH_PATTERN);
    sanitized = sanitized.replace(POSIX_PATH_PATTERN, redactPosixPathMatch);
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
    const isArray = Array.isArray(data);
    /** @type {Record<string, any>} */
    const sanitized = isArray ? [] : {};
    for (const [key, value] of Object.entries(data)) {
      /** @type {any} */
      let safeValue;
      // Redact values for sensitive key names
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        safeValue = '[REDACTED]';
      } else if (PATH_LIKE_KEY_PATTERN.test(key) && typeof value === 'string') {
        safeValue = redactPathValue(value);
      } else if (key === 'stack' && typeof value === 'string') {
        safeValue = sanitizeLogData(value, _depth + 1, seen);
      } else if (typeof value === 'object' && value !== null) {
        safeValue = sanitizeLogData(value, _depth + 1, seen);
      } else if (typeof value === 'string') {
        safeValue = sanitizeLogData(value, _depth + 1, seen);
      } else {
        safeValue = value;
      }
      sanitized[isArray ? key : sanitizeLogKey(key, sanitized)] = safeValue;
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

/**
 * One sanitized log record as the Live Activity feed sees it.
 * @typedef {{ time: string, level: string, context: string, msg: string, data?: any }} LiveLogRecord
 */

/**
 * Opt-in observers of every record this process writes. Only the main
 * process registers here (src/main/services/liveLogFeed.js, while a window
 * is subscribed to the Live Activity panel). Empty by default, so logging
 * pays nothing for the feature until someone listens.
 * @type {Set<(record: LiveLogRecord) => void>}
 */
const _liveRecordListeners = new Set();

/**
 * True while listeners are being handed a record. A listener that logs
 * synchronously would otherwise recurse (log -> listener -> log -> ...) until
 * the stack overflows; its own line is still written, just not re-announced.
 */
let _emittingLiveRecord = false;

/** @param {(record: LiveLogRecord) => void} listener */
function addLiveRecordListener(listener) {
  if (typeof listener === 'function') _liveRecordListeners.add(listener);
}

/** @param {(record: LiveLogRecord) => void} listener */
function removeLiveRecordListener(listener) {
  _liveRecordListeners.delete(listener);
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
    // The browser build still transmits a record below its own level when
    // the record is at or above the transmit level, which is fixed here
    // while setLevel later moves the pino level (see _dropsLevel).
    this._transmitLevel = isRenderer ? this.level : undefined;

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

  /**
   * True when pino would discard a record at `level` anyway, so the caller
   * can skip formatting and sanitizing it (a disabled logger.debug in a hot
   * path otherwise pays the full redaction pass for nothing). Reads pino's
   * numeric level fields, present in the node and browser builds alike;
   * anything unexpected (unknown level, a pino without them) returns false
   * and the record takes the normal path, where pino decides.
   * @param {string} level
   */
  _dropsLevel(level) {
    const _pino = /** @type {any} */ (this.pino);
    const values = _pino?.levels?.values;
    if (!values || typeof _pino.levelVal !== 'number') return false;
    const value = values[level];
    if (typeof value !== 'number' || value >= _pino.levelVal) return false;
    const transmitValue = this._transmitLevel ? values[this._transmitLevel] : undefined;
    return !(typeof transmitValue === 'number' && value >= transmitValue);
  }

  /**
   * @param {string} level
   * @param {any} message
   * @param {any[]} args
   */
  _write(level, message, args) {
    if (this._dropsLevel(level)) return;
    const normalized = normalizeLogCall(message, args);
    this._safeWrite(level, normalized.message, normalized.data);
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
    // Direct callers (terminal, terminalRaw) skip a dropped level here too.
    if (this._dropsLevel(level)) return;
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
    // Announce only records that were actually written (pino or the console
    // fallback), and only after the write, so a listener can never alter what
    // pino serializes.
    if (_liveRecordListeners.size > 0) {
      this._emitLiveRecord(level, sanitizedMessage, sanitized);
    }
  }

  /**
   * Hand one sanitized record to the live listeners, only at levels this
   * logger would write. Never throws: a broken listener must not break the
   * log call it is observing, and a listener that logs is not re-entered.
   * @param {string} level
   * @param {any} message
   * @param {any} data
   */
  _emitLiveRecord(level, message, data) {
    if (_emittingLiveRecord) return;
    _emittingLiveRecord = true;
    try {
      const _pino = /** @type {any} */ (this.pino);
      if (_pino && typeof _pino.isLevelEnabled === 'function' && !_pino.isLevelEnabled(level)) {
        return;
      }
      /** @type {LiveLogRecord} */
      const record = {
        time: new Date().toISOString(),
        level,
        context: this.context || '',
        // A non-string message (e.g. logger.error(err)) reaches here
        // unsanitized; redact its string form before it leaves the logger.
        msg: typeof message === 'string' ? message : sanitizeLogData(String(message)),
        data
      };
      for (const listener of _liveRecordListeners) {
        try {
          listener(record);
        } catch {
          // A listener failure never reaches the caller of the log method.
        }
      }
    } catch {
      // The live feed is best-effort; logging continues regardless.
    } finally {
      _emittingLiveRecord = false;
    }
  }

  /** @param {any} message @param {...any} args */
  error(message, ...args) {
    this._write('error', message, args);
  }

  /** @param {any} message @param {...any} args */
  warn(message, ...args) {
    this._write('warn', message, args);
  }

  /** @param {any} message @param {...any} args */
  info(message, ...args) {
    this._write('info', message, args);
  }

  /** @param {any} message @param {...any} args */
  debug(message, ...args) {
    this._write('debug', message, args);
  }

  /** @param {any} message @param {...any} args */
  trace(message, ...args) {
    this._write('trace', message, args);
  }

  // `fatal` is accepted by SYSTEM.LOG IPC (see ALLOWED_LOG_LEVELS in
  // `src/main/ipc/system.js`) but the Logger class previously had no
  // `fatal()` method, so renderer-side `logger.fatal(...)` calls (or any
  // dispatch that landed at this level) silently no-op'd. Pino itself
  // supports `fatal` natively, so we just route through `_safeWrite` and
  // existing transport behavior carries through.
  /** @param {any} message @param {...any} args */
  fatal(message, ...args) {
    this._write('fatal', message, args);
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
  _loggingShutDown = false;
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
  _loggingShutDown = true;

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
  addLiveRecordListener,
  removeLiveRecordListener,
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
