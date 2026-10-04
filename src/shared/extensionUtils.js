// @ts-check
/**
 * Shared file-extension helpers.
 */

/**
 * Normalize a file extension to bare lowercase form (no leading dot).
 * Expects a non-empty string (callers guard beforehand), matching the inline
 * `extension.toLowerCase().replace(/^\./, '')` it replaces.
 *
 * @param {string} extension - Extension with or without a leading dot (e.g. ".STL" or "stl")
 * @returns {string} Lowercase extension without the leading dot (e.g. "stl")
 */
function normalizeExtension(extension) {
  return extension.toLowerCase().replace(/^\./, '');
}

module.exports = { normalizeExtension };
