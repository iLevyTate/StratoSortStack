// @ts-check
/**
 * Folder Utilities
 *
 * Shared utilities for folder mapping and category extraction.
 * Used across analysis and organization modules.
 *
 * @module shared/folderUtils
 */

const path = require('path');
const { normalizePathForIndex } = require('./pathSanitization');

/**
 * Ensure value is an array (internal helper)
 * @param {any} val - Value to check
 * @returns {any[]} The value as an array, or empty array if not array-like
 */
function ensureArray(val) {
  if (Array.isArray(val)) return val;
  if (val == null) return [];
  return [val];
}

/**
 * Safely get a property with default value (internal helper)
 * @param {Record<string, any>} obj - Object to access
 * @param {string} key - Property key
 * @param {any} defaultVal - Default value if property doesn't exist
 * @returns {any} The property value or default
 */
function safeGet(obj, key, defaultVal) {
  if (obj == null || typeof obj !== 'object') return defaultVal;
  const val = obj[key];
  return val !== undefined && val !== null ? val : defaultVal;
}

/**
 * Filter folders to get only custom/valid folders (internal helper)
 * @param {any[]} folders - Array of folder objects
 * @returns {any[]} Filtered array of custom folders
 */
function filterCustomFolders(folders) {
  return ensureArray(folders).filter((f) => f && (!f.isDefault || f.path));
}

/**
 * Map folders to category objects with standardized structure.
 * This extracts the essential folder information for analysis context.
 *
 * @param {any[]} folders - Array of folder objects
 * @param {{ includeId?: boolean, nameMax?: number, descriptionMax?: number, limit?: number }} [options] - Mapping options
 * @returns {Array<{name: any, description: any, path: any, id?: any}>}
 */
function mapFoldersToCategories(folders, options = {}) {
  const { includeId = true, nameMax, descriptionMax, limit } = options;

  let customFolders = filterCustomFolders(folders);

  // Apply limit if specified
  if (limit && limit > 0) {
    customFolders = customFolders.slice(0, limit);
  }

  return customFolders.map((f) => {
    let name = safeGet(f, 'name', 'Unknown');
    let description = safeGet(f, 'description', '');

    // Apply truncation if specified
    if (nameMax && typeof name === 'string') {
      name = name.trim().slice(0, nameMax);
    }
    if (descriptionMax && typeof description === 'string') {
      description = description.trim().slice(0, descriptionMax);
    }

    /** @type {{ name: any, description: any, path: any, id?: any }} */
    const result = { name, description, path: safeGet(f, 'path', '') };

    if (includeId) {
      result.id = safeGet(f, 'id', null);
    }

    return result;
  });
}

/**
 * Get folder names as a comma-separated string for logging
 * @param {any[]} folderCategories - Array of category objects
 * @returns {string} Comma-separated folder names
 */
function getFolderNamesString(folderCategories) {
  return ensureArray(folderCategories)
    .map((f) => f?.name || 'Unknown')
    .join(', ');
}

/**
 * Find the containing smart folder for a file path.
 * Uses normalized paths for consistent comparisons across platforms.
 *
 * @param {string} filePath - File path to check
 * @param {any[]} [smartFolders] - Array of smart folder objects with paths
 * @returns {any|null} Matching smart folder or null
 */
function findContainingSmartFolder(filePath, smartFolders = []) {
  if (!filePath || !Array.isArray(smartFolders) || smartFolders.length === 0) {
    return null;
  }

  const normalizedFile = normalizePathForIndex(filePath);
  if (!normalizedFile) return null;

  let bestMatch = null;
  let bestLength = 0;

  for (const folder of smartFolders) {
    if (!folder || !folder.path) continue;
    let normalizedFolder = normalizePathForIndex(folder.path);
    if (!normalizedFolder) continue;

    // Trim trailing separators for consistent prefix checks
    normalizedFolder = normalizedFolder.replace(/\/+$/g, '');
    if (!normalizedFolder) continue;

    // Match nested paths only (folder path + separator)
    const prefix = normalizedFolder + path.posix.sep;
    if (normalizedFile.startsWith(prefix)) {
      if (normalizedFolder.length > bestLength) {
        bestMatch = folder;
        bestLength = normalizedFolder.length;
      }
    }
  }

  return bestMatch;
}

module.exports = {
  mapFoldersToCategories,
  getFolderNamesString,
  findContainingSmartFolder
};
