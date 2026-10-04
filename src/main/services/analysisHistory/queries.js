// @ts-check
/**
 * Queries
 *
 * Query methods for analysis history.
 * Includes pagination, sorting, and caching support.
 *
 * @module analysisHistory/queries
 */

const { maintainCacheSize } = require('./cacheManager');
const {
  isPlausibleContentDate,
  isIsoDateOnly,
  toLocalCalendarDay
} = require('../../../shared/contentDateSanity');
const { normalizePathForIndex } = require('../../../shared/pathSanitization');

// Lookup normalizer must match the write side in `indexManager.js`, which uses
// `normalizePathForIndex` (NFC unicode + win32/darwin lowercase + forward-slash
// separator). The previous local helper used only `path.normalize` + win32
// lowercase, so macOS NFD paths and Windows forward-slash paths silently
// failed to find cached analysis even though their canonical key was indexed.
function normalizePathForLookup(/** @type {any} */ filePath) {
  if (!filePath) return filePath;
  return normalizePathForIndex(filePath);
}

/**
 * Sort entries by various fields
 * @param {Array<any>} entries - Entries to sort
 * @param {string} sortBy - Sort field: 'timestamp', 'fileName', 'confidence', 'fileSize'
 * @param {string} sortOrder - Sort order: 'asc' or 'desc'
 * @returns {Array<any>} Sorted entries
 */
function sortEntries(entries, sortBy, sortOrder) {
  const multiplier = sortOrder === 'desc' ? -1 : 1;

  return entries.sort((a, b) => {
    let comparison;
    switch (sortBy) {
      case 'timestamp':
        comparison = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
        break;
      case 'fileName':
        comparison = a.fileName.localeCompare(b.fileName);
        break;
      case 'confidence':
        comparison = (a.analysis?.confidence || 0) - (b.analysis?.confidence || 0);
        break;
      case 'fileSize':
        comparison = (a.fileSize || 0) - (b.fileSize || 0);
        break;
      default:
        comparison = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    }
    return comparison * multiplier;
  });
}

/**
 * Get analysis by file path
 * @param {Record<string, any>} analysisHistory - Analysis history data
 * @param {Record<string, any>} analysisIndex - Analysis index
 * @param {string} filePath - File path to look up
 * @returns {Object|null} Analysis entry or null
 */
function getAnalysisByPath(analysisHistory, analysisIndex, filePath) {
  if (!filePath) return null;

  const normalized = normalizePathForLookup(filePath);

  // Fast paths: exact key, then normalized key (for new indexes)
  let entryId =
    analysisIndex.pathLookup[filePath] ??
    (normalized ? analysisIndex.pathLookup[normalized] : undefined);

  // Backfill for legacy indexes that only stored the original-cased path on Windows
  if (!entryId && normalized && process.platform === 'win32') {
    for (const [storedPath, id] of Object.entries(analysisIndex.pathLookup)) {
      if (normalizePathForLookup(storedPath) === normalized) {
        entryId = id;
        // Cache the normalized key to avoid future scans
        analysisIndex.pathLookup[normalized] = id;
        break;
      }
    }
  }

  return entryId ? analysisHistory.entries[entryId] || null : null;
}

/**
 * Get analysis by file hash (size + mtime + path), used as a fallback when paths change
 * @param {Record<string, any>} analysisHistory - Analysis history data
 * @param {Record<string, any>} analysisIndex - Analysis index
 * @param {string} fileHash - Hash key
 * @returns {Object|null} Analysis entry or null
 */
function getAnalysisByHash(analysisHistory, analysisIndex, fileHash) {
  if (!fileHash) return null;
  const entryId = analysisIndex.fileHashes[fileHash];
  return entryId ? analysisHistory.entries[entryId] || null : null;
}

/**
 * Get analysis entries by category with pagination and caching
 * @param {Record<string, any>} analysisHistory - Analysis history data
 * @param {Record<string, any>} analysisIndex - Analysis index
 * @param {Record<string, any>} cache - Cache store
 * @param {number} cacheTTL - Cache TTL in ms
 * @param {string} category - Category to filter by
 * @param {Record<string, any>} options - Query options
 * @returns {{results: Array<any>, total: number, hasMore: boolean}}
 */
function getAnalysisByCategory(
  analysisHistory,
  analysisIndex,
  cache,
  cacheTTL,
  category,
  options = {}
) {
  const { limit = 100, offset = 0, sortBy = 'timestamp', sortOrder = 'desc' } = options;
  const cacheKey = `${category}:${sortBy}:${sortOrder}`;
  const now = Date.now();

  // Check cache
  if (cache.categoryResults.has(cacheKey)) {
    const cached = cache.categoryResults.get(cacheKey);
    if (now - cached.time < cacheTTL) {
      const paginatedResults = cached.results.slice(offset, offset + limit);
      return {
        results: paginatedResults,
        total: cached.results.length,
        hasMore: offset + limit < cached.results.length
      };
    }
    cache.categoryResults.delete(cacheKey);
  }

  const entryIds = analysisIndex.categoryIndex[category] || [];
  let entries = entryIds
    .map((/** @type {any} */ id) => analysisHistory.entries[id])
    .filter(Boolean);

  // Sort entries
  entries = sortEntries(entries, sortBy, sortOrder);

  // Cache sorted results
  cache.categoryResults.set(cacheKey, {
    results: entries,
    time: now
  });
  maintainCacheSize(cache.categoryResults, 20);

  // Return paginated results
  const paginatedResults = entries.slice(offset, offset + limit);
  return {
    results: paginatedResults,
    total: entries.length,
    hasMore: offset + limit < entries.length
  };
}

/**
 * Get analysis entries by tag with pagination and caching
 * @param {Record<string, any>} analysisHistory - Analysis history data
 * @param {Record<string, any>} analysisIndex - Analysis index
 * @param {Record<string, any>} cache - Cache store
 * @param {number} cacheTTL - Cache TTL in ms
 * @param {string} tag - Tag to filter by
 * @param {Record<string, any>} options - Query options
 * @returns {{results: Array<any>, total: number, hasMore: boolean}}
 */
function getAnalysisByTag(analysisHistory, analysisIndex, cache, cacheTTL, tag, options = {}) {
  const { limit = 100, offset = 0, sortBy = 'timestamp', sortOrder = 'desc' } = options;
  const cacheKey = `${tag}:${sortBy}:${sortOrder}`;
  const now = Date.now();

  // Check cache
  if (cache.tagResults.has(cacheKey)) {
    const cached = cache.tagResults.get(cacheKey);
    if (now - cached.time < cacheTTL) {
      const paginatedResults = cached.results.slice(offset, offset + limit);
      return {
        results: paginatedResults,
        total: cached.results.length,
        hasMore: offset + limit < cached.results.length
      };
    }
    cache.tagResults.delete(cacheKey);
  }

  const entryIds = analysisIndex.tagIndex[tag] || [];
  let entries = entryIds
    .map((/** @type {any} */ id) => analysisHistory.entries[id])
    .filter(Boolean);

  // Sort entries
  entries = sortEntries(entries, sortBy, sortOrder);

  // Cache sorted results
  cache.tagResults.set(cacheKey, {
    results: entries,
    time: now
  });
  maintainCacheSize(cache.tagResults, 20);

  // Return paginated results
  const paginatedResults = entries.slice(offset, offset + limit);
  return {
    results: paginatedResults,
    total: entries.length,
    hasMore: offset + limit < entries.length
  };
}

/**
 * Get recent analysis entries with caching and pagination
 * Performance: Uses cached sorted array to avoid O(n log n) on every call
 * @param {Record<string, any>} analysisHistory - Analysis history data
 * @param {Record<string, any>} cache - Cache store
 * @param {number} cacheTTL - Cache TTL in ms
 * @param {number} limit - Maximum entries to return (default: 50)
 * @param {number} offset - Offset for pagination (default: 0)
 * @returns {{results: Array<any>, total: number, hasMore: boolean}}
 */
function getRecentAnalysis(analysisHistory, cache, cacheTTL, limit = 50, offset = 0) {
  const now = Date.now();

  // Check if sorted cache is valid
  if (cache.sortedEntriesValid && cache.sortedEntries && now - cache.sortedEntriesTime < cacheTTL) {
    const results = cache.sortedEntries.slice(offset, offset + limit);
    return {
      results,
      total: cache.sortedEntries.length,
      hasMore: offset + limit < cache.sortedEntries.length
    };
  }

  // Rebuild sorted cache
  const entries = Object.values(analysisHistory.entries);

  // Sort by timestamp descending (most recent first)
  cache.sortedEntries = entries.sort(
    (/** @type {any} */ a, /** @type {any} */ b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  cache.sortedEntriesValid = true;
  cache.sortedEntriesTime = now;

  const results = cache.sortedEntries.slice(offset, offset + limit);
  return {
    results,
    total: cache.sortedEntries.length,
    hasMore: offset + limit < cache.sortedEntries.length
  };
}

/**
 * Get analysis entries by date range using the date index
 * Performance: Uses date index for O(1) month lookups instead of full scan
 * @param {Record<string, any>} analysisHistory - Analysis history data
 * @param {Record<string, any>} analysisIndex - Analysis index
 * @param {Date|string} startDate - Start of date range
 * @param {Date|string} endDate - End of date range
 * @param {Record<string, any>} options - Query options (limit, offset, sortBy, sortOrder)
 * @returns {{results: Array<any>, total: number, hasMore: boolean}}
 */
function getAnalysisByDateRange(analysisHistory, analysisIndex, startDate, endDate, options = {}) {
  const { limit = 100, offset = 0, sortBy = 'timestamp', sortOrder = 'desc' } = options;
  const start = new Date(startDate);
  const end = new Date(endDate);

  // Get all month keys in range
  const monthKeys = [];
  const current = new Date(start);
  current.setDate(1); // Start of month

  while (current <= end) {
    const key = current.toISOString().substring(0, 7); // YYYY-MM
    if (analysisIndex.dateIndex[key]) {
      monthKeys.push(key);
    }
    current.setMonth(current.getMonth() + 1);
  }

  // Collect entry IDs from relevant months
  const entryIds = new Set();
  for (const key of monthKeys) {
    for (const id of analysisIndex.dateIndex[key]) {
      entryIds.add(id);
    }
  }

  // Filter to exact date range and resolve entries
  let entries = [];
  for (const id of entryIds) {
    const entry = analysisHistory.entries[id];
    if (entry) {
      const entryDate = new Date(entry.timestamp);
      if (entryDate >= start && entryDate <= end) {
        entries.push(entry);
      }
    }
  }

  // Sort entries
  entries = sortEntries(entries, sortBy, sortOrder);

  // Return paginated results
  const paginatedResults = entries.slice(offset, offset + limit);
  return {
    results: paginatedResults,
    total: entries.length,
    hasMore: offset + limit < entries.length
  };
}

// Sorted-timeline snapshot per history store (see buildTimelineItems).
const TIMELINE_SNAPSHOT_TTL_MS = 2000;
/** @type {WeakMap<object, { key: string, builtAt: number, items: Array<any> }>} */
const timelineSnapshots = new WeakMap();

/**
 * Lean, paginated timeline projection over all entries, sorted by effective
 * date (content date when present, analyzed-at otherwise) descending.
 * Kept intentionally small: the preload payload guard caps arrays at 10k
 * items, so callers page through this rather than fetching full entries.
 * @param {any} analysisHistory
 * @param {{limit?: number, offset?: number}} [options]
 * @returns {{items: Array<any>, total: number, hasMore: boolean}}
 */
function buildTimelineItems(analysisHistory, options = {}) {
  const entries = analysisHistory?.entries;
  if (!entries || typeof entries !== 'object') {
    return { items: [], total: 0, hasMore: false };
  }
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 5000;
  const offset = Number.isInteger(options.offset) && options.offset >= 0 ? options.offset : 0;

  // Paging through a large history re-entered this function once per page,
  // rebuilding and re-sorting the WHOLE entries map each time (O(N log N)
  // per page). Serve pages from a per-store snapshot instead, keyed by
  // (updatedAt, entryCount) — every entry mutation path stamps updatedAt —
  // with a short TTL safety valve bounding staleness against any path that
  // does not.
  const snapshotKey = `${analysisHistory.updatedAt || ''}|${Object.keys(entries).length}`;
  const cached = timelineSnapshots.get(analysisHistory);
  if (
    cached &&
    cached.key === snapshotKey &&
    Date.now() - cached.builtAt < TIMELINE_SNAPSHOT_TTL_MS
  ) {
    const cachedPage = cached.items.slice(offset, offset + limit);
    return {
      items: cachedPage,
      total: cached.items.length,
      hasMore: offset + cachedPage.length < cached.items.length
    };
  }

  /** @type {Array<any>} */
  const mapped = [];
  for (const entry of Object.values(entries)) {
    if (!entry || typeof entry !== 'object') continue;
    const analysis = /** @type {any} */ (entry).analysis || {};
    const rawDocumentDate =
      typeof analysis.documentDate === 'string' ? analysis.documentDate : null;
    // Pre-gate entries can carry hallucinated years ("2103-…" pinned to the
    // top of the timeline forever) — fall back to the analyzed-at timestamp,
    // which also flips dateSource to 'analyzed' honestly.
    const documentDate =
      rawDocumentDate && isPlausibleContentDate(rawDocumentDate) ? rawDocumentDate : null;
    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : '';
    const effectiveDate = documentDate || timestamp;
    const sortMs = Date.parse(effectiveDate);
    // Sort primarily by the DISPLAYED calendar day (same policy as the
    // renderer's timelineRows grouping: date-only strings are UTC days,
    // timestamps are local days — main and renderer share the OS timezone).
    // Sorting by raw epoch ms while grouping by calendar produced
    // out-of-order / duplicate month headers at month boundaries west of
    // UTC (a local Mar-31-evening analysis is an Apr-1 UTC instant).
    const dayKey = !Number.isFinite(sortMs)
      ? ''
      : isIsoDateOnly(effectiveDate)
        ? effectiveDate
        : toLocalCalendarDay(sortMs);
    mapped.push({
      id: entry.id,
      fileName: typeof entry.fileName === 'string' ? entry.fileName : '',
      filePath:
        typeof entry.organization?.actual === 'string'
          ? entry.organization.actual
          : typeof entry.originalPath === 'string'
            ? entry.originalPath
            : '',
      category: typeof analysis.category === 'string' ? analysis.category : '',
      mediaKind: typeof analysis.mediaKind === 'string' ? analysis.mediaKind : null,
      subject: typeof analysis.subject === 'string' ? analysis.subject : '',
      effectiveDate,
      dateSource: documentDate ? 'content' : 'analyzed',
      _dayKey: dayKey,
      _sortMs: Number.isFinite(sortMs) ? sortMs : -Infinity
    });
  }
  // Calendar day desc ('' = undated sorts last), raw instant desc within a day.
  mapped.sort((x, y) => {
    if (x._dayKey !== y._dayKey) return x._dayKey > y._dayKey ? -1 : 1;
    return y._sortMs - x._sortMs;
  });
  // Strip the sort keys from the WHOLE snapshot (it is cached and later
  // pages slice it directly).
  for (const item of mapped) {
    delete item._sortMs;
    delete item._dayKey;
  }
  timelineSnapshots.set(analysisHistory, {
    key: snapshotKey,
    builtAt: Date.now(),
    items: mapped
  });
  const total = mapped.length;
  const page = mapped.slice(offset, offset + limit);
  return { items: page, total, hasMore: offset + page.length < total };
}

/**
 * Get all available categories with counts
 * Performance: Uses index directly, no iteration over entries
 * @param {Record<string, any>} analysisIndex - Analysis index
 * @returns {Array<any>} Categories with counts
 */
function getCategories(analysisIndex) {
  return Object.entries(analysisIndex.categoryIndex)
    .map(([name, ids]) => ({ name, count: ids.length }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Get all available tags with counts
 * Performance: Uses index directly, no iteration over entries
 * @param {Record<string, any>} analysisIndex - Analysis index
 * @returns {Array<any>} Tags with counts
 */
function getTags(analysisIndex) {
  return Object.entries(analysisIndex.tagIndex)
    .map(([name, ids]) => ({ name, count: ids.length }))
    .sort((a, b) => b.count - a.count);
}

module.exports = {
  sortEntries,
  getAnalysisByPath,
  getAnalysisByHash,
  getAnalysisByCategory,
  getAnalysisByTag,
  getRecentAnalysis,
  getAnalysisByDateRange,
  buildTimelineItems,
  getCategories,
  getTags
};
