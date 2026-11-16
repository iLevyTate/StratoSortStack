// @ts-check
/**
 * Safe access utilities to prevent null reference errors.
 *
 * @module main/utils/safeAccess
 */

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;
const TRAVERSAL = /(^|[\\/])\.\.($|[\\/])/;
const MAX_DECODE_PASSES = 5;

/**
 * True when the path, or any percent-decoded form of it (up to a few passes,
 * so double-encoded `%252e%252e` is caught too), contains a `..` segment.
 * @param {string} p
 */
function hasEncodedTraversal(p) {
  let current = p;
  for (let i = 0; i <= MAX_DECODE_PASSES; i++) {
    if (TRAVERSAL.test(current)) return true;
    let next;
    try {
      next = decodeURIComponent(current);
    } catch {
      // A malformed escape elsewhere (e.g. "%zz") makes decodeURIComponent
      // throw, so decode just the dot and separator escapes one last time.
      return TRAVERSAL.test(
        current.replace(/%2e/gi, '.').replace(/%2f/gi, '/').replace(/%5c/gi, '\\')
      );
    }
    if (next === current) return false;
    current = next;
  }
  return false;
}

/**
 * Validate a filesystem path received over IPC. The path is returned exactly
 * as given: `%20` or surrounding spaces are legal in real file names, so
 * decoding or trimming here would point the caller at a different file.
 * Percent-decoding is used only to detect obfuscated traversal.
 * @param {string} filePath - Path to validate
 * @returns {string|null} The unchanged path, or null when it is rejected
 */
function safeFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string' || filePath.trim().length === 0) {
    return null;
  }

  // Reject rather than strip: stripping would also yield a different path.
  if (CONTROL_CHARS.test(filePath)) {
    return null;
  }

  // Reject path traversal sequences (both forward and backslash variants),
  // including percent-encoded forms such as %2e%2e%2f.
  if (hasEncodedTraversal(filePath)) {
    return null;
  }

  return filePath;
}

module.exports = {
  safeFilePath
};
