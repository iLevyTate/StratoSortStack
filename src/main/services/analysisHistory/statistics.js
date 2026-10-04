// @ts-check
/**
 * Statistics
 *
 * Statistics calculation for analysis history.
 * Includes incremental updates and caching.
 *
 * @module analysisHistory/statistics
 */

const path = require('path');
const { recalculateIncrementalStats } = require('./cacheManager');
const { isPlausibleContentDate } = require('../../../shared/contentDateSanity');
const { isFallbackAnalysis } = require('../../../shared/analysisProvenance');

/**
 * Group key for "the same file": normalized, and case-folded on Windows where
 * the filesystem is case-insensitive (matching how the rest of the pipeline
 * compares paths).
 * @param {string} filePath
 * @returns {string}
 */
function normalizeFileKey(filePath) {
  const normalized = path.normalize(filePath).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Get oldest timestamp efficiently
 * @param {Record<string, any>} cache - Cache store
 * @param {Array<any>} entries - Analysis entries
 * @returns {string|null} Oldest timestamp or null
 */
function getOldestTimestamp(cache, entries) {
  // If sorted cache exists, use it (last item is oldest)
  if (cache.sortedEntriesValid && cache.sortedEntries?.length) {
    return cache.sortedEntries[cache.sortedEntries.length - 1].timestamp;
  }

  // Otherwise find it
  if (!entries || entries.length === 0) {
    return null;
  }
  let oldest = entries[0];
  for (let i = 1; i < entries.length; i++) {
    if (new Date(entries[i].timestamp) < new Date(oldest.timestamp)) {
      oldest = entries[i];
    }
  }
  return oldest.timestamp;
}

/**
 * Get newest timestamp efficiently
 * @param {Record<string, any>} cache - Cache store
 * @param {Array<any>} entries - Analysis entries
 * @returns {string|null} Newest timestamp or null
 */
function getNewestTimestamp(cache, entries) {
  // If sorted cache exists, use it (first item is newest)
  if (cache.sortedEntriesValid && cache.sortedEntries?.length) {
    return cache.sortedEntries?.[0]?.timestamp;
  }

  // Otherwise find it
  if (!entries || entries.length === 0) {
    return null;
  }
  let newest = entries[0];
  for (let i = 1; i < entries.length; i++) {
    if (new Date(entries[i].timestamp) > new Date(newest.timestamp)) {
      newest = entries[i];
    }
  }
  return newest.timestamp;
}

// documentDate is LLM output: the prompt asks for YYYY-MM-DD but the schema
// stores any non-empty string. Only ISO-shaped dates order correctly under
// string comparison — one "12/31/2019" or "March 2024" would otherwise
// lexicographically dominate every real ISO date. Accepts YYYY[-MM[-DD]]
// with in-range month/day (a "2024-13" would still dominate every real
// month) plus an optional time suffix, mirroring the timeline's handling
// of the same field (date-only vs full timestamp).
const ISO_DATE_RE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01])([T ].*)?)?)?$/;

/**
 * Min/max of analysis.documentDate across entries (ISO strings compare
 * lexicographically; non-ISO values are skipped). No incremental
 * maintenance — removals cannot decrement a min/max; mirrors the on-demand
 * timestamp helpers.
 * @param {Record<string, any>|null|undefined} entriesMap - Raw entries object (key → entry)
 * @returns {{ oldest: string|null, newest: string|null }} Content date range
 */
function getContentDateRange(entriesMap) {
  /** @type {string|null} */
  let oldest = null;
  /** @type {string|null} */
  let newest = null;
  for (const entry of Object.values(entriesMap || {})) {
    const d = entry?.analysis?.documentDate;
    if (typeof d !== 'string' || !ISO_DATE_RE.test(d)) continue;
    // Entries persisted before the extraction-side plausibility gate can
    // still carry hallucinated years — keep them out of the min/max.
    if (!isPlausibleContentDate(d)) continue;
    if (oldest === null || d < oldest) oldest = d;
    if (newest === null || d > newest) newest = d;
  }
  return { oldest, newest };
}

/**
 * Get top N items from an index by count
 * @param {Record<string, any>} index - Index object with arrays as values
 * @param {number} limit - Maximum items to return
 * @returns {Array<any>} Top items with name and count
 */
function getTopItems(index, limit) {
  return Object.entries(index)
    .map(([name, ids]) => ({ name, count: ids.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/**
 * Get size distribution from index
 * @param {Record<string, any>} sizeIndex - Size index
 * @returns {Record<string, any>} Size distribution
 */
function getSizeDistribution(sizeIndex) {
  /** @type {Record<string, number>} */
  const distribution = {};
  for (const [range, ids] of Object.entries(sizeIndex)) {
    distribution[range] = ids.length;
  }
  return distribution;
}

/**
 * Get statistics with incremental updates and caching
 * Performance optimizations:
 * - Uses pre-computed incremental stats when available
 * - Longer cache TTL since stats don't need real-time accuracy
 * - Avoids full iteration when possible
 *
 * @param {Record<string, any>} analysisHistory - Analysis history data
 * @param {Record<string, any>} analysisIndex - Analysis index
 * @param {Record<string, any>} cache - Cache store
 * @param {Record<string, any>} state - State object with _statsNeedFullRecalc flag
 * @param {number} statsCacheTTL - Stats cache TTL in ms
 * @returns {Record<string, any>} Statistics object
 */
function getStatistics(analysisHistory, analysisIndex, cache, state, statsCacheTTL) {
  const now = Date.now();

  // Check if cache is valid (use longer TTL for stats)
  if (cache.statistics && now - cache.statisticsTime < statsCacheTTL) {
    return cache.statistics;
  }

  // Initialize incremental stats if needed
  if (!cache.incrementalStats.initialized || state._statsNeedFullRecalc) {
    recalculateIncrementalStats(cache, analysisHistory, state);
  }

  const entries = Object.values(analysisHistory.entries);
  const categories = Object.keys(analysisIndex.categoryIndex);
  const tags = Object.keys(analysisIndex.tagIndex);

  const { entryCount } = cache.incrementalStats;
  const hasEntries = entryCount > 0;

  // Content-date range computed once per statistics call
  const contentDateRange = getContentDateRange(analysisHistory.entries);

  // Use incremental stats for averages
  const statistics = {
    totalFiles: entryCount,
    totalSize: analysisHistory.totalSize,
    categoriesCount: categories.length,
    tagsCount: tags.length,
    // Use pre-computed totals for averages
    averageConfidence: hasEntries ? cache.incrementalStats.totalConfidence / entryCount : 0,
    averageProcessingTime: hasEntries ? cache.incrementalStats.totalProcessingTime / entryCount : 0,
    // For min/max timestamps, use sorted cache if available
    oldestAnalysis: hasEntries ? getOldestTimestamp(cache, entries) : null,
    newestAnalysis: hasEntries ? getNewestTimestamp(cache, entries) : null,
    // Content-date range: on-demand scan (no incremental — removals can't decrement min/max)
    oldestContentDate: hasEntries ? contentDateRange.oldest : null,
    newestContentDate: hasEntries ? contentDateRange.newest : null,
    // Category and tag distribution (top 10)
    topCategories: getTopItems(analysisIndex.categoryIndex, 10),
    topTags: getTopItems(analysisIndex.tagIndex, 10),
    // Size distribution
    sizeDistribution: getSizeDistribution(analysisIndex.sizeIndex),
    // Additional metadata
    isEmpty: !hasEntries,
    lastUpdated: analysisHistory.updatedAt
  };

  // Cache the result
  cache.statistics = statistics;
  cache.statisticsTime = now;

  return statistics;
}

/**
 * Get quick summary stats without full calculation
 * Useful for UI that just needs counts
 * @param {Record<string, any>} analysisHistory - Analysis history data
 * @param {Record<string, any>} analysisIndex - Analysis index
 * @returns {Record<string, any>} Quick stats
 */
function getQuickStats(analysisHistory, analysisIndex) {
  const entries =
    analysisHistory?.entries && typeof analysisHistory.entries === 'object'
      ? Object.values(analysisHistory.entries)
      : [];

  // D6: these tallies are the denominator for embedding coverage, and the
  // numerator is the number of unique file vectors in the store. Counting
  // history ROWS here made the ratio unreachable whenever a file had been
  // analyzed more than once (281 rows for 188 unique paths on the store this
  // was found on), so the "search index is incomplete" banner never cleared.
  // Fold every row for one file together and count the file once.
  // Rows with no usable path cannot be grouped and stay individual.
  /** @type {Map<string, { skipped: boolean, done: boolean, pending: boolean, error: boolean }>} */
  const byFile = new Map();
  let anonymousKey = 0;

  for (const entry of entries) {
    const embedding = entry?.embedding;
    const policy = embedding?.policy ?? null;
    const status = embedding?.status ?? 'unknown';
    // A fallback (provisional) analysis is deliberately not embedded (D7); it
    // is re-analyzed once the missing model exists. Counting it as eligible
    // held coverage below 95% over files that are not supposed to have a
    // vector yet, so the "index incomplete" banner could never clear.
    const isSkipped =
      status === 'skipped' ||
      policy === 'skip' ||
      policy === 'web_only' ||
      entry?.analysis?.provisional === true ||
      isFallbackAnalysis(entry?.analysis);

    const currentPath = entry?.organization?.actual || entry?.originalPath;
    const key =
      typeof currentPath === 'string' && currentPath
        ? normalizeFileKey(currentPath)
        : `\u0000anonymous:${anonymousKey++}`;

    const state = byFile.get(key) || { skipped: true, done: false, pending: false, error: false };
    if (isSkipped) {
      byFile.set(key, state);
      continue;
    }
    // Any non-skipped row makes the file eligible.
    state.skipped = false;
    if (status === 'done') state.done = true;
    else if (status === 'pending') state.pending = true;
    else if (status === 'error') state.error = true;
    byFile.set(key, state);
  }

  let embeddingEligibleFiles = 0;
  let embeddingDoneFiles = 0;
  let embeddingPendingFiles = 0;
  let embeddingSkippedFiles = 0;
  let embeddingErrorFiles = 0;
  let embeddingUnknownFiles = 0;

  for (const state of byFile.values()) {
    if (state.skipped) {
      embeddingSkippedFiles++;
      continue;
    }
    embeddingEligibleFiles++;
    // Best status across the file's rows: a file embedded once is done even if
    // an older row for it is still marked pending.
    if (state.done) embeddingDoneFiles++;
    else if (state.pending) embeddingPendingFiles++;
    else if (state.error) embeddingErrorFiles++;
    else embeddingUnknownFiles++;
  }

  return {
    totalFiles: entries.length,
    totalSize: analysisHistory.totalSize,
    categoriesCount: Object.keys(analysisIndex.categoryIndex).length,
    tagsCount: Object.keys(analysisIndex.tagIndex).length,
    lastUpdated: analysisHistory.updatedAt,
    embedding: {
      eligibleFiles: embeddingEligibleFiles,
      doneFiles: embeddingDoneFiles,
      pendingFiles: embeddingPendingFiles,
      skippedFiles: embeddingSkippedFiles,
      errorFiles: embeddingErrorFiles,
      unknownFiles: embeddingUnknownFiles
    }
  };
}

module.exports = {
  getOldestTimestamp,
  getNewestTimestamp,
  getContentDateRange,
  getTopItems,
  getSizeDistribution,
  getStatistics,
  getQuickStats
};
