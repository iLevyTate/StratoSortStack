// @ts-check
/**
 * Path Sanitization Utilities
 * Provides secure path validation and sanitization for database storage
 */

const path = require('path');

// Guard Node.js-only modules that are unavailable in preload/renderer
// (webpack sets os: false, fs: false for target: 'web')
let _platform;
try {
  const os = require('os');
  _platform = typeof os.platform === 'function' ? os.platform() : null;
} catch {
  _platform = null;
}
// Fallback to process.platform which is available in all Electron contexts
const PLATFORM = _platform || (typeof process !== 'undefined' ? process.platform : 'linux');

/** @type {typeof import('fs').promises | null} */
let fs;
try {
  fs = require('fs').promises;
} catch {
  // fs module not available (e.g. in sandboxed environment)
  fs = null;
}

const SYMLINK_CHECK_TIMEOUT_MS = 5000;
const URL_SCHEME_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/** @param {any} value @returns {boolean} */
const isFileUrl = (value) => typeof value === 'string' && value.toLowerCase().startsWith('file://');

// Import centralized security configuration
const {
  MAX_PATH_DEPTH,
  RESERVED_WINDOWS_NAMES,
  PROTOTYPE_POLLUTION_KEYS,
  ALLOWED_METADATA_FIELDS,
  getDangerousPaths,
  getEffectiveMaxPathLength
} = require('./securityConfig');

/**
 * Minimal Windows path normalize for environments where `path.win32` is missing.
 * Sandboxed preload bundles `path-browserify`, which sets `path.win32 = null`.
 * Without this fallback, every Windows drag/drop path crashes in sanitizePath
 * (`Cannot read properties of null (reading 'normalize')`) and Discover reports
 * "no stable absolute path".
 *
 * @param {string} input
 * @returns {string}
 */
function normalizeWindowsPathCompat(input) {
  let p = String(input || '');
  let devicePrefix = '';
  const deviceMatch = p.match(/^(\\\\[?.]\\)([\s\S]*)$/);
  if (deviceMatch) {
    devicePrefix = deviceMatch[1];
    p = deviceMatch[2] || '';
  }

  if (!devicePrefix && p.startsWith('\\\\')) {
    const uncBody = p.slice(2).replace(/\//g, '\\');
    const uncParts = uncBody.split('\\').filter((part) => part.length > 0);
    if (uncParts.length >= 2) {
      const server = uncParts[0];
      const share = uncParts[1];
      const rest = collapseWindowsSegments(uncParts.slice(2), true);
      return `\\\\${server}\\${share}${rest.length ? `\\${rest.join('\\')}` : '\\'}`;
    }
  }

  p = p.replace(/\//g, '\\');
  let drive = '';
  const driveMatch = p.match(/^([a-zA-Z]:)([\s\S]*)$/);
  if (driveMatch) {
    drive = driveMatch[1];
    p = driveMatch[2] || '';
  }

  const absolute = Boolean(drive) || p.startsWith('\\');
  const trailingSlash = /[\\/]$/.test(p) && p.length > 1;
  const rawSegments = p.split('\\').filter((part) => part.length > 0);
  const segments = collapseWindowsSegments(rawSegments, absolute);

  let result;
  if (drive) {
    result = `${drive}\\${segments.join('\\')}`;
  } else if (absolute) {
    result = `\\${segments.join('\\')}`;
  } else {
    result = segments.length > 0 ? segments.join('\\') : '.';
  }
  if (trailingSlash && result !== '\\' && !/\\$/.test(result)) {
    result += '\\';
  }
  return `${devicePrefix}${result}`;
}

/**
 * @param {string[]} segments
 * @param {boolean} absolute
 * @returns {string[]}
 */
function collapseWindowsSegments(segments, absolute) {
  /** @type {string[]} */
  const stack = [];
  for (const segment of segments) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop();
      } else if (!absolute) {
        stack.push('..');
      }
      continue;
    }
    stack.push(segment);
  }
  return stack;
}

/**
 * Prefer Node's platform-specific normalize; fall back when preload polyfills
 * omit `path.win32` / `path.posix`.
 *
 * @param {string} input
 * @param {boolean} preferWin32
 * @returns {string}
 */
function normalizePathForSanitize(input, preferWin32) {
  if (preferWin32) {
    if (path.win32 && typeof path.win32.normalize === 'function') {
      return path.win32.normalize(input);
    }
    return normalizeWindowsPathCompat(input);
  }
  if (path.posix && typeof path.posix.normalize === 'function') {
    return path.posix.normalize(input);
  }
  return path.normalize(input);
}

/**
 * Sanitize a file path for safe storage in database
 * Prevents directory traversal and normalizes path format
 * FIX: Added file:// URL handling for consistency with preload
 *
 * @param {string} filePath - The file path to sanitize
 * @returns {string} Sanitized path, or empty string if input is null/undefined/non-string
 * @throws {Error} If path contains traversal, exceeds depth limit, or uses reserved names
 */
function sanitizePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return '';
  }

  // This ensures main process handles file:// URLs the same way as the renderer
  let processedPath = filePath;
  if (processedPath.toLowerCase().startsWith('file://')) {
    try {
      const url = new URL(processedPath);
      const pathname = decodeURIComponent(url.pathname || '');
      // Windows: /C:/path -> C:/path (drop leading slash before drive letter)
      if (/^\/[a-zA-Z]:[\\/]/.test(pathname)) {
        processedPath = pathname.slice(1);
      } else {
        processedPath = pathname;
      }
    } catch {
      // Invalid URL - fall through to regular processing
    }
  }

  // 1. Reject null bytes (security critical). Stripping them would silently
  // transform the input into a *different* path that can pass later checks
  // while referring to an unintended file (classic POSIX truncation bypass:
  // "/safe/path\0/etc/passwd"). No legitimate path contains NUL — fail loud,
  // matching the preload gate's behavior.
  if (processedPath.indexOf('\0') !== -1) {
    throw new Error('Invalid path: null byte not allowed');
  }
  const sanitized = processedPath;

  // 2. Unicode normalization (NFD to NFC for consistency)
  // This helps prevent homograph attacks and ensures consistent encoding
  let normalized = sanitized.normalize('NFC');

  // 3. Normalize the path first (resolves .., ., etc.)
  // This must happen BEFORE the length check so that ".." segments are
  // resolved and the measured length reflects the real path.
  const isWin32Path =
    PLATFORM === 'win32' || /^[a-zA-Z]:[\\/]/.test(normalized) || normalized.includes('\\');
  normalized = normalizePathForSanitize(normalized, isWin32Path);

  // 4. Check for path traversal attempts AFTER normalization
  // Only treat ".." as traversal when it's an actual path segment.
  const normalizedParts = normalized.split(/[\\/]/).filter((part) => part.length > 0);
  if (normalizedParts.some((part) => part === '..')) {
    throw new Error('Invalid path: path traversal detected');
  }

  // 4b. Reject NTFS alternate data stream (ADS) syntax. The only legitimate
  // colon in a Win32 path is the drive designator (`C:`), optionally behind a
  // DOS device prefix (`\\?\C:`). Anything else — `file.txt:hidden`,
  // `file.txt::$DATA` — addresses an alternate stream, which can hide payloads
  // from extension checks and size accounting. POSIX paths without Windows
  // separators are unaffected (colons are legal in Unix filenames).
  if (isWin32Path) {
    const deviceStripped = _stripWindowsDevicePrefix(normalized.toLowerCase());
    const withoutDrive = /^[a-z]:/.test(deviceStripped) ? deviceStripped.slice(2) : deviceStripped;
    if (withoutDrive.includes(':')) {
      throw new Error('Invalid path: Windows alternate data stream syntax is not allowed');
    }
  }

  // 5. Enforce path length limits AFTER normalization and traversal check.
  // Reject rather than truncate: a truncated path silently names a DIFFERENT
  // file than the caller asked for, so any downstream operation would
  // read/move/delete the wrong target (or scatter records under a key that
  // matches no real file). On Windows the limit honours the LongPathsEnabled
  // probe so we don't reject paths the filesystem actually supports.
  const platform = PLATFORM;
  const maxLength = getEffectiveMaxPathLength(platform);
  if (normalized.length > maxLength) {
    const lengthError = /** @type {Error & { code?: string }} */ (
      new Error(`Invalid path: path length (${normalized.length}) exceeds maximum (${maxLength})`)
    );
    lengthError.code = 'PATH_TOO_LONG';
    throw lengthError;
  }

  // 6. Validate path depth to prevent deep nesting attacks
  if (normalizedParts.length > MAX_PATH_DEPTH) {
    // Tag with a code (like PATH_TOO_LONG above) so callers can distinguish a
    // legitimate-but-oversized real path from a genuinely dangerous rejection
    // (traversal, ADS, reserved name, null byte) and choose a different fallback.
    const depthError = /** @type {Error & { code?: string }} */ (
      new Error(
        `Invalid path: path depth (${normalizedParts.length}) exceeds maximum (${MAX_PATH_DEPTH})`
      )
    );
    depthError.code = 'PATH_TOO_DEEP';
    throw depthError;
  }

  // 7. Check for reserved Windows filenames (case-insensitive)
  if (platform === 'win32') {
    for (const part of normalizedParts) {
      const nameWithoutExt = path.parse(part).name.toUpperCase();
      if (RESERVED_WINDOWS_NAMES.has(nameWithoutExt)) {
        throw new Error(`Invalid path: reserved Windows filename detected: ${nameWithoutExt}`);
      }
    }
  }

  // 8. Ensure it's an absolute path for consistency
  if (!path.isAbsolute(normalized)) {
    // For relative paths, we just normalize them
    // The calling code should handle making them absolute if needed
    return normalized;
  }

  return normalized;
}

/**
 * Validate that a path is safe for database storage
 *
 * @param {string} filePath - The file path to validate
 * @returns {boolean} True if path is safe
 */
function isPathSafe(filePath) {
  try {
    sanitizePath(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitize metadata object, filtering out dangerous or unnecessary fields
 *
 * @param {Object} metadata - Metadata object to sanitize
 * @param {Array<string>} allowedFields - List of allowed field names
 * @returns {Object} Sanitized metadata
 */
function sanitizeMetadata(metadata, allowedFields = null) {
  if (!metadata || typeof metadata !== 'object') {
    return {};
  }

  const sanitized = /** @type {Record<string, any>} */ ({});

  /** @type {(value: any) => string | number | boolean | null} */
  const normalizeMetadataValue = (value) => {
    if (value === undefined || value === null) return null;

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (Array.isArray(value)) {
      const flat = /** @type {(string | number | boolean)[]} */ (
        value.map((item) => normalizeMetadataValue(item)).filter((item) => item !== null)
      );
      if (flat.length === 0) return null;
      if (flat.every((/** @type {any} */ item) => typeof item === 'string')) {
        return /** @type {string[]} */ (flat).join(',');
      }
      try {
        return JSON.stringify(flat);
      } catch {
        return String(value);
      }
    }

    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }

    return String(value);
  };

  // Use centralized config for allowed metadata fields
  const allowed = allowedFields || ALLOWED_METADATA_FIELDS;

  for (const [key, value] of Object.entries(metadata)) {
    // Skip if not in allowed list
    if (!allowed.includes(key)) {
      continue;
    }

    // Skip dangerous keys using centralized config
    if (PROTOTYPE_POLLUTION_KEYS.includes(key)) {
      continue;
    }

    // Sanitize path fields
    if (key === 'path' && typeof value === 'string') {
      try {
        sanitized[key] = sanitizePath(value);
      } catch {
        // Paths that are invalid for security reasons (traversal, null bytes,
        // ADS, reserved names) are skipped entirely.
        continue;
      }
    }
    // Copy other allowed fields
    else if (value !== undefined && value !== null) {
      // Prevent storing functions or objects with methods
      if (typeof value === 'function') {
        continue;
      }

      const normalized = normalizeMetadataValue(value);
      if (normalized !== null) {
        sanitized[key] = normalized;
      }
    }
  }

  return sanitized;
}

/**
 * Check if a path is within allowed base directories
 *
 * @param {string} targetPath - The resolved absolute path to check
 * @param {string[]} allowedBasePaths - Array of allowed base directory paths
 * @returns {boolean} True if path is within allowed directories
 */
function isPathWithinAllowed(targetPath, allowedBasePaths) {
  if (!targetPath || !Array.isArray(allowedBasePaths)) {
    return false;
  }

  // Windows and macOS (HFS+) are case-insensitive, Linux is case-sensitive
  const isWindows = process.platform === 'win32';
  const isMacOS = process.platform === 'darwin';
  const isCaseInsensitive = isWindows || isMacOS;

  const normalizedTarget = isCaseInsensitive
    ? path.normalize(targetPath).toLowerCase()
    : path.normalize(targetPath);

  for (const basePath of allowedBasePaths) {
    if (!basePath) continue;
    const normalizedBase = isCaseInsensitive
      ? path.normalize(basePath).toLowerCase()
      : path.normalize(basePath);

    // Check if target starts with base path
    if (normalizedTarget.startsWith(normalizedBase)) {
      // Ensure it's a proper subdirectory (not just a prefix match)
      const remainder = normalizedTarget.slice(normalizedBase.length);
      if (remainder === '' || remainder.startsWith(path.sep)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a path is in a dangerous system directory
 *
 * @param {string} filePath - Path to check
 * @returns {boolean} True if path is dangerous
 */
// Dangerous Windows subdirectory names (case-insensitive).
// Checked against ANY drive letter, not just enumerated ones, so that
// D:\Windows, E:\Program Files, etc. are caught on multi-drive systems.
const _DANGEROUS_WIN_SUBDIRS = new Set([
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'system volume information',
  'boot',
  'recovery'
]);

// Windows DOS device path prefixes bypass the normal Win32 path parser
// (they disable normalization, enable long paths, and can name devices or
// the NT object namespace). Without stripping them, a path like
// `\\?\C:\Windows\System32` survives `path.normalize` unchanged and then
// fails to match deny prefixes like `c:\windows` via startsWith.
//
// References:
//   https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file#win32-file-namespaces
//
// Forms handled:
//   \\?\UNC\server\share\...  → \\server\share\...   (long-path UNC form)
//   \\.\UNC\server\share\...  → \\server\share\...   (device UNC form)
//   \\?\<rest>                → <rest>               (long-path local)
//   \\.\<rest>                → <rest>               (device local)
//
// NT object namespace (\\?\GLOBALROOT\..., \\.\GLOBALROOT\...) is treated
// as dangerous unconditionally because it exposes raw device/driver objects.
/**
 * @param {string} loweredPath
 * @returns {string}
 */
function _stripWindowsDevicePrefix(loweredPath) {
  if (typeof loweredPath !== 'string' || loweredPath.length < 4) {
    return loweredPath;
  }
  if (loweredPath.startsWith('\\\\?\\unc\\') || loweredPath.startsWith('\\\\.\\unc\\')) {
    return '\\\\' + loweredPath.slice(8);
  }
  if (loweredPath.startsWith('\\\\?\\') || loweredPath.startsWith('\\\\.\\')) {
    return loweredPath.slice(4);
  }
  return loweredPath;
}

/**
 * @param {string} loweredPath
 * @returns {boolean}
 */
function _isWindowsNtObjectNamespace(loweredPath) {
  if (typeof loweredPath !== 'string') return false;
  return loweredPath.startsWith('\\\\?\\globalroot') || loweredPath.startsWith('\\\\.\\globalroot');
}

/**
 * @param {any} filePath
 * @returns {boolean}
 */
function isPathDangerous(filePath) {
  if (!filePath) return true;

  const rawNormalized = path.normalize(filePath).toLowerCase();

  // Reject the NT object namespace outright — there's no legitimate reason
  // for a user-facing file op to traverse it.
  if (_isWindowsNtObjectNamespace(rawNormalized)) {
    return true;
  }

  // Strip DOS device prefixes BEFORE comparing against deny prefixes, so
  // `\\?\c:\windows\system32` is caught just like `c:\windows\system32`.
  const normalizedPath = _stripWindowsDevicePrefix(rawNormalized);
  const dangerousPaths = getDangerousPaths();

  for (const dangerous of dangerousPaths) {
    const normalizedDangerous = path.normalize(dangerous).toLowerCase();
    if (normalizedPath.startsWith(normalizedDangerous)) {
      const remainder = normalizedPath.slice(normalizedDangerous.length);
      if (remainder.length === 0 || remainder.startsWith(path.sep)) {
        return true;
      }
    }
  }

  // Windows: check subdirectory name patterns on any drive letter (D:\Windows, E:\Program Files, etc.)
  if (PLATFORM === 'win32') {
    const driveMatch = /^[a-z]:\\(.+)/.exec(normalizedPath);
    if (driveMatch) {
      const afterDrive = driveMatch[1];
      const firstSegment = afterDrive.split('\\')[0];
      if (_DANGEROUS_WIN_SUBDIRS.has(firstSegment)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a path is a symbolic link and if so, whether it's safe
 * Returns info about the symlink status and resolved target
 *
 * HIGH FIX (HIGH-13): Added timeout parameter to prevent hangs on network mounts
 *
 * @param {string} filePath - Path to check
 * @param {string[]} [allowedBasePaths] - Optional allowed base paths for symlink targets
 * @param {number} [timeoutMs] - Timeout in milliseconds (default: SYMLINK_CHECK_TIMEOUT_MS)
 * @returns {Promise<{isSymlink: boolean, isSafe: boolean, realPath?: string, error?: string}>}
 */
async function checkSymlinkSafety(
  filePath,
  allowedBasePaths = null,
  timeoutMs = SYMLINK_CHECK_TIMEOUT_MS
) {
  // Check if fs is available
  if (!fs) {
    // In sandboxed environments without fs, we can't check symlinks.
    // Assume safe or return error depending on security posture.
    // Returning safe=true because we can't verify, and usually sandbox restricts access anyway.
    return { isSymlink: false, isSafe: true };
  }

  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error(
          `Symlink check timeout after ${timeoutMs}ms - path may be on unresponsive network mount`
        )
      );
    }, timeoutMs);
    // Prevent timeout from keeping process alive during shutdown
    if (timeoutId.unref) timeoutId.unref();
  });

  const checkPromise = (async () => {
    try {
      const stats = await fs.lstat(filePath);

      if (!stats.isSymbolicLink()) {
        return { isSymlink: false, isSafe: true };
      }

      // It's a symlink - resolve it and check where it points
      const realPath = await fs.realpath(filePath);

      // Check if resolved path is in dangerous locations
      if (isPathDangerous(realPath)) {
        return {
          isSymlink: true,
          isSafe: false,
          realPath,
          error: 'Symbolic link points to a dangerous system directory'
        };
      }

      // If allowed base paths provided, check resolved path is within them
      if (allowedBasePaths && allowedBasePaths.length > 0) {
        if (!isPathWithinAllowed(realPath, allowedBasePaths)) {
          return {
            isSymlink: true,
            isSafe: false,
            realPath,
            error: 'Symbolic link points outside allowed directories'
          };
        }
      }

      return { isSymlink: true, isSafe: true, realPath };
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Path doesn't exist - that's okay for some operations
        return { isSymlink: false, isSafe: true, error: 'Path does not exist' };
      }
      return {
        isSymlink: false,
        isSafe: false,
        error: `Failed to check symlink: ${error.message}`
      };
    }
  })();

  // checkPromise resolves (never rejects) by design, but guard defensively:
  // if the timeout wins, an unexpected late rejection must not go unhandled.
  checkPromise.catch(() => {});
  try {
    const result = await Promise.race([checkPromise, timeoutPromise]);
    clearTimeout(timeoutId);
    return result;
  } catch (error) {
    clearTimeout(timeoutId);
    return {
      isSymlink: false,
      isSafe: false,
      error: error.message
    };
  }
}

/**
 * Validate a file path for file operations (move, copy, delete, open)
 * Performs comprehensive security checks including:
 * - Path traversal detection
 * - Dangerous directory detection
 * - Symlink safety (optional)
 * - Allowed directory validation (optional)
 *
 * @param {string} filePath - Path to validate
 * @param {Object} [options] - Validation options
 * @param {string[]} [options.allowedBasePaths] - If provided, path must be within these directories
 * @param {boolean} [options.checkSymlinks=false] - Whether to check symlink safety
 * @param {boolean} [options.requireExists=false] - Whether the path must exist
 * @param {boolean} [options.requireAbsolute=false] - Whether input must be absolute
 * @param {boolean} [options.disallowUNC=false] - Block UNC/network paths
 * @param {boolean} [options.disallowUrlSchemes=false] - Block non-file URL schemes
 * @param {boolean} [options.allowFileUrl=true] - Allow file:// URLs when scheme checks enabled
 * @returns {Promise<{valid: boolean, normalizedPath: string, error?: string}>}
 */
async function validateFileOperationPath(filePath, options = {}) {
  const {
    allowedBasePaths = null,
    checkSymlinks = false,
    requireExists = false,
    requireAbsolute = false,
    disallowUNC = false,
    disallowUrlSchemes = false,
    allowFileUrl = true
  } = options;

  // Basic validation
  if (!filePath || typeof filePath !== 'string') {
    return {
      valid: false,
      normalizedPath: '',
      error: 'Invalid path: path must be a non-empty string'
    };
  }

  try {
    if (disallowUrlSchemes && URL_SCHEME_REGEX.test(filePath)) {
      if (!allowFileUrl || !isFileUrl(filePath)) {
        return {
          valid: false,
          normalizedPath: '',
          error: 'Invalid path: URL schemes are not allowed'
        };
      }
    }

    // Sanitize the path (rejects null bytes, normalizes, checks traversal)
    const sanitized = sanitizePath(filePath);

    if (requireAbsolute && !path.isAbsolute(sanitized)) {
      return {
        valid: false,
        normalizedPath: '',
        error: 'Invalid path: must be an absolute path'
      };
    }

    // Resolve to absolute path
    const normalizedPath = path.resolve(sanitized);

    if (disallowUNC && (normalizedPath.startsWith('\\\\') || normalizedPath.startsWith('//'))) {
      return {
        valid: false,
        normalizedPath,
        error: 'Invalid path: network/UNC paths are not allowed'
      };
    }

    // Check for dangerous system directories
    if (isPathDangerous(normalizedPath)) {
      return {
        valid: false,
        normalizedPath,
        error: 'Invalid path: access to system directories is not allowed'
      };
    }

    // Check allowed base paths if provided
    if (allowedBasePaths && allowedBasePaths.length > 0) {
      if (!isPathWithinAllowed(normalizedPath, allowedBasePaths)) {
        return {
          valid: false,
          normalizedPath,
          error: 'Invalid path: path is outside allowed directories'
        };
      }
    }

    // Check symlink safety if requested
    if (checkSymlinks) {
      const symlinkResult = await checkSymlinkSafety(normalizedPath, allowedBasePaths);
      if (!symlinkResult.isSafe) {
        return {
          valid: false,
          normalizedPath,
          error: symlinkResult.error || 'Invalid path: unsafe symbolic link'
        };
      }
    }

    // Check existence if required
    if (requireExists && fs) {
      try {
        await fs.access(normalizedPath);
      } catch {
        return {
          valid: false,
          normalizedPath,
          error: 'Invalid path: file or directory does not exist'
        };
      }
    }

    return { valid: true, normalizedPath };
  } catch (error) {
    return {
      valid: false,
      normalizedPath: '',
      error: error.message || 'Path validation failed'
    };
  }
}

/**
 * Synchronous path validation for simple checks (no symlink or existence checks)
 * Use this when async operations aren't possible
 *
 * @param {string} filePath - Path to validate
 * @param {string[]} [allowedBasePaths] - If provided, path must be within these directories
 * @param {Object} [options] - Validation options
 * @param {boolean} [options.requireAbsolute=false] - Whether input must be absolute
 * @param {boolean} [options.disallowUNC=false] - Block UNC/network paths
 * @param {boolean} [options.disallowUrlSchemes=false] - Block non-file URL schemes
 * @param {boolean} [options.allowFileUrl=true] - Allow file:// URLs when scheme checks enabled
 * @returns {{valid: boolean, normalizedPath: string, error?: string}}
 */
function validateFileOperationPathSync(filePath, allowedBasePaths = null, options = {}) {
  const {
    requireAbsolute = false,
    disallowUNC = false,
    disallowUrlSchemes = false,
    allowFileUrl = true
  } = options;

  if (!filePath || typeof filePath !== 'string') {
    return {
      valid: false,
      normalizedPath: '',
      error: 'Invalid path: path must be a non-empty string'
    };
  }

  try {
    if (disallowUrlSchemes && URL_SCHEME_REGEX.test(filePath)) {
      if (!allowFileUrl || !isFileUrl(filePath)) {
        return {
          valid: false,
          normalizedPath: '',
          error: 'Invalid path: URL schemes are not allowed'
        };
      }
    }

    const sanitized = sanitizePath(filePath);

    if (requireAbsolute && !path.isAbsolute(sanitized)) {
      return {
        valid: false,
        normalizedPath: '',
        error: 'Invalid path: must be an absolute path'
      };
    }
    const normalizedPath = path.resolve(sanitized);

    if (disallowUNC && (normalizedPath.startsWith('\\\\') || normalizedPath.startsWith('//'))) {
      return {
        valid: false,
        normalizedPath,
        error: 'Invalid path: network/UNC paths are not allowed'
      };
    }

    if (isPathDangerous(normalizedPath)) {
      return {
        valid: false,
        normalizedPath,
        error: 'Invalid path: access to system directories is not allowed'
      };
    }

    if (allowedBasePaths && allowedBasePaths.length > 0) {
      if (!isPathWithinAllowed(normalizedPath, allowedBasePaths)) {
        return {
          valid: false,
          normalizedPath,
          error: 'Invalid path: path is outside allowed directories'
        };
      }
    }

    return { valid: true, normalizedPath };
  } catch (error) {
    return {
      valid: false,
      normalizedPath: '',
      error: error.message || 'Path validation failed'
    };
  }
}

/**
 * Prepare file metadata for vector DB storage
 * Combines base metadata with file.meta and sanitizes the result.
 *
 * @param {Record<string,any>} file - File object with id, meta, model, updatedAt
 * @returns {Record<string,any>} Sanitized metadata ready for vector DB
 */
function prepareFileMetadata(file) {
  if (!file) return {};

  const baseMetadata = {
    path: file.meta?.path || '',
    name: file.meta?.name || '',
    model: file.model || '',
    updatedAt: file.updatedAt || new Date().toISOString()
  };

  return sanitizeMetadata({
    ...baseMetadata,
    ...file.meta
  });
}

/**
 * Prepare folder metadata for vector DB storage
 * Creates base metadata from folder properties and sanitizes the result.
 *
 * @param {Record<string,any>} folder - Folder object with id, name, description, path, model, updatedAt
 * @returns {Record<string,any>} Sanitized metadata ready for vector DB
 */
function prepareFolderMetadata(folder) {
  if (!folder) return {};

  const metadata = {
    name: folder.name || '',
    description: folder.description || '',
    path: folder.path || '',
    model: folder.model || '',
    updatedAt: folder.updatedAt || new Date().toISOString()
  };

  return sanitizeMetadata(metadata);
}

/**
 * Normalize a file path for use as an index key
 * Ensures consistent lookups across case-sensitive and case-insensitive filesystems
 *
 * On Windows (case-insensitive): converts path to lowercase
 * On Unix (case-sensitive): preserves original case
 *
 * Unicode normalization (NFC) is applied on every platform. macOS HFS+/APFS
 * historically return NFD-decomposed filenames via Node `fs.readdir`, while
 * the same paths typed by the user or returned from APFS tools can be NFC.
 * Without NFC canonicalization we index the same file twice (one NFC, one NFD)
 * because their code-unit sequences differ even though they display identically.
 *
 * This is critical for BM25 index, vector DB lookups, and analysis history
 * to ensure renamed/moved files are found consistently.
 *
 * @param {string} filePath - The file path to normalize for indexing
 * @returns {string} Normalized path suitable for use as a lookup key
 */
function normalizePathForIndex(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return '';
  }

  let normalized = path.normalize(filePath);

  // Canonicalize Unicode BEFORE casing so NFC/NFD variants of non-ASCII
  // characters (common on macOS) collapse to the same index key.
  try {
    normalized = normalized.normalize('NFC');
  } catch {
    // String.prototype.normalize throws RangeError only for an invalid form
    // argument, which we never pass. Guard defensively so a pathological
    // input (e.g. an invalid surrogate pair) cannot poison indexing.
  }

  // On case-insensitive filesystems (Windows, macOS default), lowercase for consistent comparison
  if (PLATFORM === 'win32' || PLATFORM === 'darwin') {
    normalized = normalized.toLowerCase();
  }

  // Use forward slashes for canonical IDs to avoid platform-specific separators
  normalized = normalized.replace(/\\/g, '/');

  return normalized;
}

/**
 * Create a canonical file ID for use in search indexes and vector DB
 * Format: "file:{normalizedPath}" or "image:{normalizedPath}"
 *
 * Uses normalizePathForIndex for consistent lookups on case-insensitive filesystems
 *
 * @param {string} filePath - The file path
 * @param {boolean} [isImage=false] - Whether this is an image file
 * @returns {string} Canonical ID in format "file:{path}" or "image:{path}"
 */
function getCanonicalFileId(filePath, isImage = false) {
  if (!filePath || typeof filePath !== 'string') return '';
  const normalizedPath = normalizePathForIndex(filePath);
  const prefix = isImage ? 'image' : 'file';
  return `${prefix}:${normalizedPath}`;
}

/**
 * Check if two file paths refer to the same file (accounting for case sensitivity)
 *
 * @param {string} path1 - First file path
 * @param {string} path2 - Second file path
 * @returns {boolean} True if paths are equivalent on the current platform
 */
function arePathsEquivalent(path1, path2) {
  return normalizePathForIndex(path1) === normalizePathForIndex(path2);
}

// Characters that are illegal in a Windows file name (the strictest common
// target), plus path separators and ASCII control characters. NTFS also treats
// ':' as an alternate-data-stream delimiter, so it must go even on POSIX hosts.
// eslint-disable-next-line no-control-regex
const ILLEGAL_BASENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

/**
 * Sanitize an untrusted (LLM- or template-generated) file base name into
 * something safe to join onto a directory on every supported platform.
 *
 * Strips illegal/control characters, collapses whitespace, trims trailing dots
 * and spaces (Windows silently drops them, causing rename mismatches) and
 * prefixes reserved device names (`CON`, `NUL`, `COM1`, ...) with `_`.
 * Unicode letters are preserved. Callers pass the name WITHOUT extension.
 *
 * @param {unknown} input
 * @returns {string | null} Sanitized base name, or null when nothing usable remains
 */
function sanitizeSuggestedBaseName(input) {
  if (typeof input !== 'string') return null;

  let name = input
    // Tabs/newlines are control characters too; fold them into spaces before
    // the illegal-char strip so words stay separated.
    .replace(/\s+/g, ' ')
    .replace(ILLEGAL_BASENAME_CHARS, '')
    .replace(/ {2,}/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (!name) return null;

  // Windows reserves the stem before the first dot regardless of what follows
  // ("CON.final" is still the console device).
  const stem = name.split('.')[0].toUpperCase();
  if (RESERVED_WINDOWS_NAMES.has(stem)) {
    name = `_${name}`;
  }
  return name;
}

module.exports = {
  sanitizePath,
  isPathSafe,
  sanitizeMetadata,
  // Vector DB metadata helpers
  prepareFileMetadata,
  prepareFolderMetadata,
  // New exports for file operation security
  validateFileOperationPath,
  validateFileOperationPathSync,
  checkSymlinkSafety,
  isPathDangerous,
  isPathWithinAllowed,
  // Path normalization for index keys
  normalizePathForIndex,
  getCanonicalFileId,
  arePathsEquivalent,
  // Untrusted file-name material (LLM output, naming templates)
  sanitizeSuggestedBaseName
};
