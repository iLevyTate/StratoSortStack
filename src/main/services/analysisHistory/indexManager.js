// @ts-check
/**
 * Index Manager
 *
 * Manages indexes for efficient querying of analysis history.
 * Handles file hash, path lookup, tag, category, date, and size indexes.
 *
 * @module analysisHistory/indexManager
 */

const crypto = require('crypto');
// The canonical version also converts backslashes to forward slashes for consistent IDs
const { normalizePathForIndex } = require('../../../shared/pathSanitization');

/**
 * Create empty index structure
 * @param {string} schemaVersion - Schema version
 * @returns {Record<string, any>} Empty index
 */
function createEmptyIndex(schemaVersion) {
  return {
    schemaVersion,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    fileHashes: {},
    pathLookup: {},
    tagIndex: {},
    categoryIndex: {},
    dateIndex: {},
    sizeIndex: {},
    lastOptimized: null
  };
}

/**
 * Generate file hash from path, size, and last modified
 * @param {string} filePath - File path
 * @param {number} size - File size
 * @param {string} lastModified - Last modified timestamp
 * @returns {string} 16-character hash
 */
function generateFileHash(filePath, size, lastModified) {
  const hashInput = `${filePath}:${size}:${lastModified}`;
  return crypto.createHash('sha256').update(hashInput).digest('hex').substring(0, 16);
}

/**
 * Get size range category for file size
 * @param {number} size - File size in bytes
 * @returns {string} Size range category
 */
function getSizeRange(size) {
  if (size < 1024) return 'tiny'; // < 1KB
  if (size < 1024 * 1024) return 'small'; // < 1MB
  if (size < 10 * 1024 * 1024) return 'medium'; // < 10MB
  if (size < 100 * 1024 * 1024) return 'large'; // < 100MB
  return 'huge'; // >= 100MB
}

/**
 * Where the entry's file lives now: `organization.actual` once it has been
 * moved, `originalPath` until then. `originalPath` is never rewritten, so after
 * a move it names a place another file may since have taken.
 * @param {Record<string, any>} entry - Analysis entry
 * @returns {string|null} Current path, or null when the entry has none
 */
function getEntryCurrentPath(entry) {
  const actual = entry?.organization?.actual;
  if (typeof actual === 'string' && actual) return actual;
  const original = entry?.originalPath;
  return typeof original === 'string' && original ? original : null;
}

/**
 * Whether the entry's file currently lives at `filePath` (exact or
 * index-normalized match).
 * @param {Record<string, any>} entry - Analysis entry
 * @param {string} filePath - Path to compare
 * @returns {boolean}
 */
function entryLivesAtPath(entry, filePath) {
  const current = getEntryCurrentPath(entry);
  if (!current || typeof filePath !== 'string' || !filePath) return false;
  if (current === filePath) return true;
  const normalizedCurrent = normalizePathForIndex(current);
  return Boolean(normalizedCurrent) && normalizedCurrent === normalizePathForIndex(filePath);
}

/**
 * Drop a path's lookup keys, but only the ones that still point at this entry:
 * a newer entry for another file may own the same path by now.
 * @param {Record<string, any>} index - Analysis index
 * @param {string} filePath - Path whose keys to drop
 * @param {string} entryId - Entry the keys must belong to
 */
function deletePathKeysOwnedBy(index, filePath, entryId) {
  if (!filePath) return;
  if (index.pathLookup[filePath] === entryId) delete index.pathLookup[filePath];
  const normalized = normalizePathForIndex(filePath);
  if (normalized && normalized !== filePath && index.pathLookup[normalized] === entryId) {
    delete index.pathLookup[normalized];
  }
}

/**
 * Update all indexes for a new entry
 * @param {Record<string, any>} index - Analysis index
 * @param {Record<string, any>} entry - Analysis entry
 */
function updateIndexes(index, entry) {
  const timestamp = new Date().toISOString();
  // Ensure updatedAt always moves forward, even when called twice within the same ms
  index.updatedAt =
    timestamp === index.updatedAt ? new Date(Date.now() + 1).toISOString() : timestamp;

  // File hash index
  index.fileHashes[entry.fileHash] = entry.id;

  // Path lookup index (store both original and normalized for case-insensitive FS).
  // A moved entry is indexed under its current path only: its originalPath may
  // belong to another file now, and must not shadow that file's entry.
  if (!entry.organization?.actual || entryLivesAtPath(entry, entry.originalPath)) {
    index.pathLookup[entry.originalPath] = entry.id;
    const normalizedPath = normalizePathForIndex(entry.originalPath);
    if (normalizedPath && normalizedPath !== entry.originalPath) {
      index.pathLookup[normalizedPath] = entry.id;
    }
  }

  if (entry.organization?.actual) {
    index.pathLookup[entry.organization.actual] = entry.id;
    const normalizedActual = normalizePathForIndex(entry.organization.actual);
    if (normalizedActual && normalizedActual !== entry.organization.actual) {
      index.pathLookup[normalizedActual] = entry.id;
    }
  }

  // Tag index
  if (entry.analysis.tags) {
    entry.analysis.tags.forEach((/** @type {any} */ tag) => {
      if (!index.tagIndex[tag]) {
        index.tagIndex[tag] = [];
      }
      index.tagIndex[tag].push(entry.id);
    });
  }

  // Category index
  if (entry.analysis.category) {
    if (!index.categoryIndex[entry.analysis.category]) {
      index.categoryIndex[entry.analysis.category] = [];
    }
    index.categoryIndex[entry.analysis.category].push(entry.id);
  }

  // Date index (by month)
  const dateKey = entry.timestamp.substring(0, 7); // YYYY-MM
  if (!index.dateIndex[dateKey]) {
    index.dateIndex[dateKey] = [];
  }
  index.dateIndex[dateKey].push(entry.id);

  // Size index (by size ranges)
  const sizeRange = getSizeRange(entry.fileSize);
  if (!index.sizeIndex[sizeRange]) {
    index.sizeIndex[sizeRange] = [];
  }
  index.sizeIndex[sizeRange].push(entry.id);
}

/**
 * Remove an entry from all indexes
 * @param {Record<string, any>} index - Analysis index
 * @param {Record<string, any>} entry - Analysis entry to remove
 */
function removeFromIndexes(index, entry) {
  // Remove from various indexes
  delete index.fileHashes[entry.fileHash];
  // Path keys go only while they still point at this entry: the path a moved
  // entry left may be another file's key by now.
  deletePathKeysOwnedBy(index, entry.originalPath, entry.id);

  // Also remove organization.actual paths to prevent orphaned index entries
  if (entry.organization?.actual) {
    deletePathKeysOwnedBy(index, entry.organization.actual, entry.id);
  }

  // Remove from tag index
  if (entry.analysis.tags) {
    entry.analysis.tags.forEach((/** @type {any} */ tag) => {
      const tagEntries = index.tagIndex[tag] || [];
      index.tagIndex[tag] = tagEntries.filter((/** @type {any} */ id) => id !== entry.id);
      if (index.tagIndex[tag].length === 0) {
        delete index.tagIndex[tag];
      }
    });
  }

  // Remove from category index
  if (entry.analysis.category) {
    const categoryEntries = index.categoryIndex[entry.analysis.category] || [];
    index.categoryIndex[entry.analysis.category] = categoryEntries.filter(
      (/** @type {any} */ id) => id !== entry.id
    );
    if (index.categoryIndex[entry.analysis.category].length === 0) {
      delete index.categoryIndex[entry.analysis.category];
    }
  }

  // Remove from date index
  const dateKey = entry.timestamp.substring(0, 7); // YYYY-MM
  if (index.dateIndex[dateKey]) {
    index.dateIndex[dateKey] = index.dateIndex[dateKey].filter(
      (/** @type {any} */ id) => id !== entry.id
    );
    if (index.dateIndex[dateKey].length === 0) {
      delete index.dateIndex[dateKey];
    }
  }

  // Remove from size index
  const sizeRange = getSizeRange(entry.fileSize);
  if (index.sizeIndex[sizeRange]) {
    index.sizeIndex[sizeRange] = index.sizeIndex[sizeRange].filter(
      (/** @type {any} */ id) => id !== entry.id
    );
    if (index.sizeIndex[sizeRange].length === 0) {
      delete index.sizeIndex[sizeRange];
    }
  }
}

/**
 * Update path index when entry's organization.actual changes.
 * Call this after updateEntryPaths to keep path lookup index in sync.
 *
 * @param {Record<string, any>} index - Analysis index
 * @param {Record<string, any>} entry - Entry that was updated
 * @param {string|null} oldActualPath - Previous organization.actual path (if any)
 * @param {string} newActualPath - New organization.actual path
 */
function updatePathIndexForMove(index, entry, oldActualPath, newActualPath) {
  if (!index || !entry) return;

  // Remove old actual path from index (if any)
  if (oldActualPath) {
    deletePathKeysOwnedBy(index, oldActualPath, entry.id);
  }

  // The file has left originalPath too (a first move has no old actual path).
  // The keys are re-added below when the move brings it back there.
  if (entry.originalPath) {
    deletePathKeysOwnedBy(index, entry.originalPath, entry.id);
  }

  // Add new actual path to index
  if (newActualPath) {
    index.pathLookup[newActualPath] = entry.id;
    const normalizedNew = normalizePathForIndex(newActualPath);
    if (normalizedNew && normalizedNew !== newActualPath) {
      index.pathLookup[normalizedNew] = entry.id;
    }
  }

  // Update timestamp
  index.updatedAt = new Date().toISOString();
}

module.exports = {
  createEmptyIndex,
  generateFileHash,
  getSizeRange,
  updateIndexes,
  removeFromIndexes,
  updatePathIndexForMove,
  normalizePathForIndex
};
