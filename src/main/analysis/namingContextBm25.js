// @ts-check
/**
 * Naming context for LLM prompts via BM25 over the SearchService index (no embedding call).
 * Keeps batch analysis from doing a duplicate embed before folder matching embeds again.
 */

const path = require('path');

const MAX_SNIPPET_CHARS = 400;
const MAX_QUERY_CHARS = 600;

/**
 * @param {string} fileName - Basename or path (basename is used for stem tokens)
 * @param {string} [textSnippet] - Short extracted or caption text
 * @returns {string}
 */
function buildNamingBm25Query(fileName, textSnippet = '') {
  const base = path.basename(String(fileName || '')) || '';
  const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  const snippet = String(textSnippet || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SNIPPET_CHARS);
  const combined = [stem, snippet].filter(Boolean).join(' ').trim();
  return combined.slice(0, MAX_QUERY_CHARS);
}

/**
 * @param {any} searchService - SearchService instance
 * @param {{ fileName: string, textSnippet?: string, topK?: number, logger?: { debug?: Function } }} options
 * @returns {Promise<string[]>} Basenames of similar files for naming consistency
 */
async function fetchNamingContextFromBm25(searchService, options) {
  const { fileName, textSnippet = '', topK = 5, logger } = options || {};
  if (!searchService || typeof searchService.bm25Search !== 'function') {
    return [];
  }

  try {
    // Never rebuild on every file: full history scan is O(history); batch analysis would degrade to O(n²).
    const needsBuild =
      typeof searchService.isIndexStale === 'function'
        ? searchService.isIndexStale()
        : !searchService.bm25Index;
    if (needsBuild && typeof searchService.buildBM25Index === 'function') {
      await searchService.buildBM25Index();
    }
  } catch (err) {
    if (logger?.debug) {
      logger.debug('[NamingContextBm25] buildBM25Index failed (non-fatal)', {
        error: err?.message || String(err)
      });
    }
  }

  const query = buildNamingBm25Query(fileName, textSnippet);
  if (!query.trim()) {
    return [];
  }

  try {
    const hits = await searchService.bm25Search(query, topK + 5);
    if (!Array.isArray(hits) || hits.length === 0) {
      return [];
    }
    const currentBase = path.basename(String(fileName || ''));
    const names = [];
    const seen = new Set();
    for (const hit of hits) {
      const name = hit?.metadata?.name;
      if (!name || typeof name !== 'string') continue;
      if (name === currentBase || name === fileName) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
      if (names.length >= topK) break;
    }
    return names;
  } catch (err) {
    if (logger?.debug) {
      logger.debug('[NamingContextBm25] bm25Search failed (non-fatal)', {
        error: err?.message || String(err)
      });
    }
    return [];
  }
}

module.exports = {
  buildNamingBm25Query,
  fetchNamingContextFromBm25
};
