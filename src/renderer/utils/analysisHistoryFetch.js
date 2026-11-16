// @ts-check
import { createLogger } from '../../shared/logger';

const logger = createLogger('AnalysisHistoryFetch');

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_MAX_ENTRIES = 50000;
const MAX_PAGE_SIZE = 1000;

function toPositiveInt(/** @type {any} */ value, /** @type {any} */ fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/**
 * @param {{ pageSize?: number, maxEntries?: number }} [options]
 */
export async function fetchAnalysisHistoryPages(options = {}) {
  const getHistory = window?.electronAPI?.analysisHistory?.get;
  if (typeof getHistory !== 'function') return [];

  const basePageSize = Math.min(MAX_PAGE_SIZE, toPositiveInt(options.pageSize, DEFAULT_PAGE_SIZE));
  const maxEntries = Math.max(basePageSize, toPositiveInt(options.maxEntries, DEFAULT_MAX_ENTRIES));
  let pageSize = basePageSize;

  /** @type {any[]} */
  const allEntries = [];
  let offset = 0;

  while (offset < maxEntries) {
    let page;
    try {
      page = await getHistory({ limit: pageSize, offset });
    } catch (error) {
      logger.warn('Failed to fetch analysis history page', {
        offset,
        pageSize,
        error: error?.message
      });
      break;
    }

    // The preload rejects a response over its size cap (entries carry full
    // transcript segments). Retry the same offset with a smaller page; at
    // one entry, skip that entry rather than end the whole history there.
    // The reason string is set by validateResult in src/preload/ipcValidator.js.
    if (page && page.reason === 'payload-too-large') {
      if (pageSize > 1) {
        pageSize = Math.max(1, Math.floor(pageSize / 2));
        logger.warn('History page too large; retrying with a smaller page', { offset, pageSize });
        continue;
      }
      logger.warn('Skipping a history entry that exceeds the IPC size cap', { offset });
      offset += 1;
      // Keep the small page: the next entries are often large too, and
      // jumping back to the full size would re-read and reject a full page
      // per skipped entry. The doubling below grows it back once pages
      // succeed, so a lone large entry costs a few small calls.
      continue;
    }

    if (!Array.isArray(page)) {
      logger.warn('History page payload is invalid; stopping pagination', {
        offset,
        pageSize,
        payloadType: typeof page
      });
      break;
    }

    if (page.length === 0) {
      break;
    }

    allEntries.push(...page);
    offset += page.length;

    if (page.length < pageSize) {
      break;
    }

    // Grow back after a shrunken page succeeds, so only the window of large
    // entries is read in small pages.
    if (pageSize < basePageSize) {
      pageSize = Math.min(basePageSize, pageSize * 2);
    }
  }

  return allEntries.slice(0, maxEntries);
}
