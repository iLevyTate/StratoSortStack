// @ts-check
/**
 * File ID Utilities
 *
 * Centralized utilities for generating consistent semantic file IDs.
 * Used across SearchService, OrganizationSuggestionService, and DownloadWatcher.
 *
 * @module shared/fileIdUtils
 */

const path = require('path');
const {
  SUPPORTED_IMAGE_EXTENSIONS,
  SUPPORTED_AUDIO_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS
} = require('./constants');
const { getCanonicalFileId } = require('./pathSanitization');

const MEDIA_EXTENSIONS = new Set([
  ...(SUPPORTED_AUDIO_EXTENSIONS || []),
  ...(SUPPORTED_VIDEO_EXTENSIONS || [])
]);

/**
 * Generate a semantic file ID for vector storage.
 * Auto-detects image type from extension, then delegates to
 * {@link getCanonicalFileId} — the single source of truth for
 * the `"file:{path}"` / `"image:{path}"` format.
 *
 * @param {string} filePath - The file path
 * @returns {string} Semantic file ID
 */
function getSemanticFileId(filePath) {
  const safePath = typeof filePath === 'string' ? filePath : '';
  const ext = (path.extname(safePath) || '').toLowerCase();
  const isImage = SUPPORTED_IMAGE_EXTENSIONS.includes(ext);
  return getCanonicalFileId(safePath, isImage);
}

/**
 * Strip the semantic prefix from a file ID to get the path
 *
 * @param {string} fileId - Semantic file ID (e.g., "file:/path/to/file.txt")
 * @returns {string} File path without prefix
 */
function stripSemanticPrefix(fileId) {
  if (typeof fileId !== 'string') return '';
  let result = fileId;
  while (/^(file|image|doc|img):/.test(result)) {
    result = result.replace(/^(file|image|doc|img):/, '');
  }
  return result;
}

/**
 * Check if a path is an image based on extension
 *
 * @param {string} filePath - File path to check
 * @returns {boolean} True if file is an image
 */
function isImagePath(filePath) {
  const safePath = typeof filePath === 'string' ? filePath : '';
  const ext = (path.extname(safePath) || '').toLowerCase();
  return SUPPORTED_IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Check if a path is an audio or video file based on extension.
 * Mirrors {@link isImagePath} so file-discovery code (watchers, dispatchers)
 * can route media to the dedicated analyzer instead of falling through to
 * the document analyzer. Single source of truth via SUPPORTED_AUDIO/VIDEO_EXTENSIONS.
 *
 * @param {string} filePath - File path to check
 * @returns {boolean} True if file is audio or video
 */
function isMediaPath(filePath) {
  const safePath = typeof filePath === 'string' ? filePath : '';
  const ext = (path.extname(safePath) || '').toLowerCase();
  return MEDIA_EXTENSIONS.has(ext);
}

module.exports = {
  getSemanticFileId,
  stripSemanticPrefix,
  isImagePath,
  isMediaPath
};
