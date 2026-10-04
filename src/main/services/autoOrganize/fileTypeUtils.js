// @ts-check
/**
 * File Type Utilities
 *
 * Utilities for file type categorization and sanitization.
 *
 * @module autoOrganize/fileTypeUtils
 */

const { normalizeExtension } = require('../../../shared/extensionUtils');

/**
 * File type categories with their extensions
 * FIX M-4: Added modern file formats (avif, webm, m4v, heif, opus, mkv, etc.)
 */
const FILE_TYPE_CATEGORIES = {
  documents: [
    'pdf',
    'doc',
    'docx',
    'txt',
    'rtf',
    'odt',
    'pages',
    'epub',
    'md',
    'markdown',
    'log',
    'eml',
    'msg'
  ],
  spreadsheets: ['xls', 'xlsx', 'csv', 'ods', 'numbers', 'tsv'],
  presentations: ['ppt', 'pptx', 'odp', 'key'],
  images: [
    'jpg',
    'jpeg',
    'png',
    'gif',
    'svg',
    'bmp',
    'webp',
    'tiff',
    'tif',
    'heic',
    'heif',
    'avif',
    'ico',
    'raw',
    'cr2',
    'nef',
    'arw'
  ],
  videos: ['mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mkv', 'mpeg', 'mpg', '3gp', 'ogv'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'opus', 'ogg', 'wma', 'aiff', 'alac'],
  code: [
    'js',
    'ts',
    'jsx',
    'tsx',
    'py',
    'java',
    'cpp',
    'c',
    'h',
    'hpp',
    'html',
    'htm',
    'css',
    'scss',
    'sass',
    'less',
    'go',
    'rs',
    'rb',
    'php',
    'swift',
    'kt',
    'vue',
    'svelte',
    'json',
    'yaml',
    'yml',
    'xml',
    'sql',
    'sh',
    'bash',
    'bat',
    'ps1',
    'ini'
  ],
  design: ['psd', 'ai', 'eps'],
  models: ['stl', 'obj', '3mf', 'scad', 'gcode'],
  archives: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'dmg', 'iso', 'cab']
};

/** @type {Record<string, string>} */
const CATEGORY_SINGULAR = {
  documents: 'document',
  spreadsheets: 'spreadsheet',
  presentations: 'presentation',
  images: 'image',
  videos: 'video',
  audio: 'audio',
  code: 'code',
  design: 'design',
  models: 'model',
  archives: 'archive'
};

const _extToCategoryMap = new Map();
const _extToSingularMap = new Map();
for (const [category, extensions] of Object.entries(FILE_TYPE_CATEGORIES)) {
  const displayName = category.charAt(0).toUpperCase() + category.slice(1);
  const singular = CATEGORY_SINGULAR[category] || category;
  for (const ext of extensions) {
    _extToCategoryMap.set(ext, displayName);
    _extToSingularMap.set(ext, singular);
  }
}

/**
 * Get file type category from extension.
 * O(1) lookup via pre-built Map.
 * @param {string} extension - File extension (with or without leading dot)
 * @returns {string} Title-cased category name (e.g. "Documents"), or "Files" if unknown
 */
function getFileTypeCategory(extension) {
  if (typeof extension !== 'string' || !extension) {
    return 'Files';
  }
  return _extToCategoryMap.get(normalizeExtension(extension)) || 'Files';
}

/**
 * Get the singular lowercase category key for an extension.
 * Useful for services that need "document" instead of "Documents".
 * @param {string} extension - File extension (with or without leading dot)
 * @returns {string} Singular category key (e.g. "document"), or "other" if unknown
 */
function getFileTypeSingular(extension) {
  if (typeof extension !== 'string' || !extension) {
    return 'other';
  }
  return _extToSingularMap.get(normalizeExtension(extension)) || 'other';
}

/**
 * Sanitize file object for IPC transmission
 * Removes large data and circular references
 * @param {Record<string, any>} file - File object to sanitize
 * @returns {Object|null} Sanitized file object
 */
function sanitizeFile(file) {
  if (!file) return null;

  // Create a clean lightweight copy
  return {
    name: file.name,
    path: file.path,
    size: file.size,
    extension: file.extension,
    type: file.type,
    // Only include essential analysis data if present
    analysis: file.analysis
      ? {
          category: file.analysis.category,
          suggestedName: file.analysis.suggestedName,
          confidence: file.analysis.confidence,
          summary: file.analysis.summary
        }
      : null
  };
}

module.exports = {
  FILE_TYPE_CATEGORIES,
  CATEGORY_SINGULAR,
  getFileTypeCategory,
  getFileTypeSingular,
  sanitizeFile
};
