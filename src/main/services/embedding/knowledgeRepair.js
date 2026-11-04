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
 *  - Passage rows that were never written, or that are still all zeros, are
 *    rebuilt from the stored extracted text on a later launch. A file vector
 *    that looks present does not hide an empty passage.
 *
 * Pure orchestration: every side effect is injected so the policy is unit
 * testable and the caller decides where `fs`, the store and the embedder come
 * from. Never throws; counts everything it did and did not do.
 */
const { getSemanticFileId, isImagePath } = require('../../../shared/fileIdUtils');
const { normalizePathForIndex } = require('../../../shared/pathSanitization');
const { isFallbackAnalysis } = require('../../../shared/analysisProvenance');
const { CHUNKING } = require('../../../shared/performanceConstants');
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
 *   passages: number, failed: number, deferred: number, skippedMissing: number,
 *   skippedFallback: number, skippedGate: number, stopped: boolean
 * }} RepairSummary
 */

/**
 * A passage set is due when the stored text is long enough to split and the
 * file is not an image. Images keep a single file vector.
 * @param {Record<string, any>} entry
 * @param {string} filePath
 * @returns {boolean}
 */
function passagesExpected(entry, filePath) {
  if (isImagePath(filePath)) return false;
  const text = String(entry?.analysis?.extractedText || '').trim();
  return text.length >= CHUNKING.MIN_TEXT_LENGTH;
}

/**
 * @param {any} vectorDb
 * @param {any} doc
 * @param {string} fileId
 * @returns {Promise<boolean>}
 */
async function fileVectorUsable(vectorDb, doc, fileId) {
  if (typeof vectorDb.hasUsableVector === 'function') {
    try {
      return await vectorDb.hasUsableVector(fileId);
    } catch {
      return false;
    }
  }
  return Boolean(doc && doc.hasVector !== false);
}

/**
 * True when this file should have passages and the store has none, or the
 * ones it has are zeros or missing. No describer means the caller cannot
 * see passage health, so nothing is flagged.
 * @param {any} vectorDb
 * @param {string} fileId
 * @param {Record<string, any>} entry
 * @param {string} filePath
 * @param {boolean} checkPassages
 * @returns {Promise<boolean>}
 */
async function passagesNeedRepair(vectorDb, fileId, entry, filePath, checkPassages) {
  if (!checkPassages) return false;
  if (!passagesExpected(entry, filePath)) return false;
  if (typeof vectorDb.describeFileChunks !== 'function') return false;
  let described;
  try {
    described = await vectorDb.describeFileChunks(fileId);
  } catch {
    return false;
  }
  if (!described) return false;
  return (
    described.count === 0 || described.placeholderCount > 0 || described.missingVectorCount > 0
  );
}

/**
 * @param {{
 *   entries: Record<string, any> | null | undefined,
 *   vectorDb: { getFile: (id: string) => Promise<any>,
 *               restoreOrphanedEmbeddings?: (ids: string[]) => Promise<any> } | null | undefined,
 *   embedEntry: (args: { entry: Record<string, any>, filePath: string }) => Promise<{ action?: string, reason?: string }>,
 *   repairPassages?: (args: { entry: Record<string, any>, filePath: string }) => Promise<{ action?: string, reason?: string }>,
 *   checkPassages?: boolean,
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
  repairPassages,
  checkPassages = true,
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
    passages: 0,
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

    const usable = await fileVectorUsable(vectorDb, doc, id);
    const atCap = () => summary.embedded + summary.passages + summary.failed >= maxEmbeds;
    const restoring = Boolean(doc?.isOrphaned && doc.hasVector !== false && usable);

    if (restoring) {
      toRestore.push(id);
    } else if (!usable) {
      if (atCap()) {
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

    let passagesBroken = false;
    try {
      passagesBroken = await passagesNeedRepair(vectorDb, id, entry, filePath, checkPassages);
    } catch (error) {
      log.debug('Passage lookup failed during repair', {
        filePath,
        error: /** @type {any} */ (error)?.message
      });
    }
    if (passagesBroken) {
      if (atCap()) {
        summary.deferred++;
        continue;
      }
      if (typeof repairPassages !== 'function') {
        summary.skippedGate++;
        continue;
      }
      try {
        const result = await repairPassages({ entry, filePath });
        if (result?.action === 'repaired') summary.passages++;
        else summary.skippedGate++;
      } catch (error) {
        summary.failed++;
        log.debug('Passage repair failed', {
          filePath,
          error: /** @type {any} */ (error)?.message
        });
      }
      continue;
    }

    if (usable && !restoring) summary.healthy++;
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
 * Rebuild one file's passages from the text already stored on its history
 * entry. Same chunk ids the analysis path uses, so a zero row is replaced
 * and a second copy is not inserted. No language-model call.
 * @param {{ entry: Record<string, any>, filePath: string,
 *   embedText: ((text: string) => Promise<any>) | undefined,
 *   vectorDb: any }} args
 * @returns {Promise<{ action: 'repaired' | 'skipped', reason?: string }>}
 */
async function repairStoredPassages({ entry, filePath, embedText, vectorDb }) {
  if (typeof embedText !== 'function') {
    return { action: 'skipped', reason: 'no-embedder' };
  }
  const { embedFileChunks } = require('../../analysis/chunkEmbedding');
  const result = await embedFileChunks({
    fileId: getSemanticFileId(filePath),
    filePath,
    extractedText: entry?.analysis?.extractedText,
    embedText,
    vectorDb
  });
  if (Number(result?.persisted) > 0) return { action: 'repaired' };
  return { action: 'skipped', reason: result?.skipped || 'no-passages' };
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
      const { isAutoChunkEnabled } = require('../../../shared/experienceMode');
      const services = resolveServices();
      let checkPassages;
      try {
        const { getInstance } = require('../SettingsService');
        checkPassages = isAutoChunkEnabled(await getInstance().load());
      } catch {
        checkPassages = true;
      }
      const summary = await repairKnowledge({
        entries: analysisHistory?.analysisHistory?.entries,
        vectorDb,
        shouldStop,
        maxEmbeds,
        checkPassages,
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
          }),
        repairPassages: checkPassages
          ? ({ entry, filePath }) =>
              repairStoredPassages({
                entry,
                filePath,
                embedText: services.folderMatchingService?.embedText?.bind(
                  services.folderMatchingService
                ),
                vectorDb
              })
          : undefined
      });
      const touched =
        summary.restored + summary.embedded + summary.passages + summary.failed + summary.deferred;
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
  repairStoredPassages,
  isFallbackOnly,
  DEFAULT_MAX_EMBEDS
};
