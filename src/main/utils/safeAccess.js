// @ts-check
/**
 * Safe access utilities to prevent null reference errors.
 *
 * @module main/utils/safeAccess
 */

/**
 * Safely access and validate file path
 * @param {string} filePath - Path to validate
 * @returns {string|null} Valid path or null
 */
function safeFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return null;
  }

  // Decode percent-encoded sequences first to catch encoded traversal attempts
  // e.g., %2e%2e%2f -> ../ , %2e%2e%5c -> ..\
  let cleanPath = filePath;
  try {
    cleanPath = decodeURIComponent(cleanPath);
  } catch {
    // If decoding fails (malformed encoding), proceed with the raw string
  }

  // Remove null bytes and control characters (ASCII 0x00-0x1f except tab/newline)
  // eslint-disable-next-line no-control-regex
  cleanPath = cleanPath.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim();

  if (!cleanPath || cleanPath.length === 0) {
    return null;
  }

  // Reject path traversal sequences (both forward and backslash variants)
  // Matches: ../ , ..\ , or bare .. at start/end of path
  if (/(^|[\\/])\.\.($|[\\/])/.test(cleanPath)) {
    return null;
  }

  return cleanPath;
}

module.exports = {
  safeFilePath
};
