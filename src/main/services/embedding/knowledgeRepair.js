// @ts-check
/**
 * Startup knowledge repair: make the vector store agree with the analysis
 * history for every file that still exists on disk.
 *
 *  - A row that was orphan-marked (search saw a stale path, F-187) but whose
 *    file is present is restored — the vector is intact (F-221).
 *  - A history entry with no row, or a zero-vector placeholder row, is
 *    re-embedded from the STORED analysis (no LLM run) — the backfill that the
 *    2026-03 → 2026-05 era never got (F-198 / K-03).
 *
 * Pure orchestration: every side effect is injected so the policy is unit
 * testable and the caller decides where `fs`, the store and the embedder come
 * from. Never throws; counts everything it did and did not do.
 */
const { getSemanticFileId } = require('../../../shared/fileIdUtils');
const { normalizePathForIndex } = require('../../../shared/pathSanitization');
const { isFallbackAnalysis } = require('../../../shared/analysisProvenance');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('KnowledgeRepair');

/** Default per-launch cap on re-embeds: each one is an embedding-model call. */
const DEFAULT_MAX_EMBEDS = 500;

/**
 * Analyses that carry nothing worth embedding (F-195 owns retrying them).
 * Provisional entries are fallbacks by construction; the explicit flag covers
 * entries written before the provenance fields existed.
 * @param {Record<string, any> | null | undefined} entry
 * @returns {boolean}
 */
function isFallbackOnly(entry) {
  const analysis = entry?.analysis || {};
  return analysis.provisional === true || isFallbackAnalysis(analysis);
}

/**
 * @typedef {{
 *   checked: number, healthy: number, restored: number, embedded: number,
 *   failed: number, deferred: number, skippedMissing: number,
 *   skippedFallback: number, skippedGate: number, stopped: boolean
 * }} RepairSummary
 */

/**
 * @param {{
 *   entries: Record<string, any> | null | undefined,
 *   vectorDb: { getFile: (id: string) => Promise<any>,
 *               restoreOrphanedEmbeddings?: (ids: string[]) => Promise<any> } | null | undefined,
 *   embedEntry: (args: { entry: Record<string, any>, filePath: string }) => Promise<{ action?: string, reason?: string }>,
 *   fileExists: (filePath: string) => Promise<boolean>,
 *   shouldStop?: () => boolean,
 *   maxEmbeds?: number,
 *   log?: { info: Function, warn: Function, debug: Function }
 * }} args
 * @returns {Promise<RepairSummary>}
 */
async function repairKnowledge({
  entries,
  vectorDb,
  embedEntry,
  fileExists,
  shouldStop = () => false,
  maxEmbeds = DEFAULT_MAX_EMBEDS,
  log = logger
}) {
  /** @type {RepairSummary} */
  const summary = {
    checked: 0,
    healthy: 0,
    restored: 0,
    embedded: 0,
    failed: 0,
    deferred: 0,
    skippedMissing: 0,
    skippedFallback: 0,
    skippedGate: 0,
    stopped: false
  };
  if (
    !entries ||
    typeof entries !== 'object' ||
    !vectorDb ||
    typeof vectorDb.getFile !== 'function'
  ) {
    return summary;
  }

  /** @type {string[]} */
  const toRestore = [];
  const seen = new Set();

  for (const entry of Object.values(entries)) {
    if (shouldStop()) {
      summary.stopped = true;
      break;
    }
    const filePath = entry?.organization?.actual || entry?.originalPath;
    if (typeof filePath !== 'string' || !filePath) continue;
    const key = normalizePathForIndex(filePath) || filePath;
    if (seen.has(key)) continue;
    seen.add(key);

    if (isFallbackOnly(entry)) {
      summary.skippedFallback++;
      continue;
    }
    if (!(await fileExists(filePath))) {
      summary.skippedMissing++;
      continue;
    }

    summary.checked++;
    const id = getSemanticFileId(filePath);
    let doc = null;
    try {
      doc = await vectorDb.getFile(id);
    } catch (error) {
      log.debug('Vector lookup failed during repair', {
        filePath,
        error: /** @type {any} */ (error)?.message
      });
    }

    if (doc?.isOrphaned && doc.hasVector !== false) {
      toRestore.push(id);
      continue;
    }
    if (doc && doc.hasVector !== false) {
      summary.healthy++;
      continue;
    }

    if (summary.embedded + summary.failed >= maxEmbeds) {
      summary.deferred++;
      continue;
    }
    try {
      const result = await embedEntry({ entry, filePath });
      if (result?.action === 'enqueued') summary.embedded++;
      else summary.skippedGate++;
    } catch (error) {
      summary.failed++;
      log.debug('Re-embed failed during repair', {
        filePath,
        error: /** @type {any} */ (error)?.message
      });
    }
  }

  if (toRestore.length > 0 && typeof vectorDb.restoreOrphanedEmbeddings === 'function') {
    try {
      const result = await vectorDb.restoreOrphanedEmbeddings(toRestore);
      summary.restored = Number(result?.restored) || 0;
    } catch (error) {
      log.warn('Restoring orphan-marked vectors failed', {
        count: toRestore.length,
        error: /** @type {any} */ (error)?.message
      });
    }
  }

  return summary;
}

/**
 * Wire the repair to the live services and run it once in the background,
 * after startup has settled. Called from ServiceIntegration once the vector
 * store and the embedder are up. Returns the pending run so a caller can
 * await it (tests, shutdown); never rejects.
 *
 * @param {{
 *   vectorDb: any, analysisHistory: any,
 *   delayMs?: number, shouldStop?: () => boolean, maxEmbeds?: number
 * }} args
 * @returns {Promise<RepairSummary | null>}
 */
function scheduleStartupKnowledgeRepair({
  vectorDb,
  analysisHistory,
  delayMs = 15000,
  shouldStop = () => false,
  maxEmbeds = DEFAULT_MAX_EMBEDS
}) {
  const { delay } = require('../../../shared/promiseUtils');
  const fs = require('fs').promises;
  return delay(delayMs)
    .then(async () => {
      if (shouldStop()) return null;
      const {
        embedHistoryEntry,
        resolveServices,
        getSmartFolderForPath
      } = require('../../ipc/files/embeddingSync');
      const services = resolveServices();
      const summary = await repairKnowledge({
        entries: analysisHistory?.analysisHistory?.entries,
        vectorDb,
        shouldStop,
        maxEmbeds,
        fileExists: async (/** @type {string} */ p) => {
          try {
            const stats = await fs.stat(p);
            return !stats.isDirectory();
          } catch {
            return false;
          }
        },
        embedEntry: ({ entry, filePath }) =>
          embedHistoryEntry({
            entry,
            filePath,
            smartFolder: getSmartFolderForPath(filePath, services),
            services
          })
      });
      const touched = summary.restored + summary.embedded + summary.failed + summary.deferred;
      (touched > 0 ? logger.info : logger.debug).call(
        logger,
        'Startup knowledge repair complete',
        summary
      );
      return summary;
    })
    .catch((/** @type {any} */ error) => {
      logger.warn('Startup knowledge repair failed', { error: error?.message });
      return /** @type {RepairSummary | null} */ (null);
    });
}

module.exports = {
  repairKnowledge,
  scheduleStartupKnowledgeRepair,
  isFallbackOnly,
  DEFAULT_MAX_EMBEDS
};
