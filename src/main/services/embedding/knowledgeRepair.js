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
 *    repaired on a later launch (see repairStoredPassages for the rule). A
 *    file vector that looks present does not hide an empty passage. Files the
 *    embedding gate keeps out of the index (policy 'skip' / 'web_only',
 *    manual timing, out of scope) never get passages from the repair.
 *
 * It runs on every launch, and on almost every launch nothing needs doing. So
 * the vector store (in memory) is read first, and only files that need a
 * repair are checked on disk or handed to the embedder. A healthy launch costs
 * one in-memory lookup per history entry plus ONE pass over the passage rows
 * for the whole library: no file stats, no model load.
 *
 * Pure orchestration: every side effect is injected so the policy is unit
 * testable and the caller decides where `fs`, the store and the embedder come
 * from. Never throws; counts everything it did and did not do.
 */
const path = require('path');
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
 * `checked` counts healthy entries plus entries that needed work and whose
 * file was found; `skippedMissing` counts only entries that needed work and
 * whose file is gone (a healthy row is not checked on disk).
 * @typedef {{
 *   checked: number, healthy: number, restored: number, embedded: number,
 *   passages: number, failed: number, deferred: number, skippedMissing: number,
 *   skippedFallback: number, skippedGate: number, stopped: boolean
 * }} RepairSummary
 */

/**
 * A passage set is due when the stored text is long enough to split and the
 * file is not an image. Images keep a single file vector. A file the user set
 * to 'skip' or 'web_only' is never due: it is kept out of the local index on
 * purpose. (The global policy and timing are checked by the embedding gate in
 * repairStoredPassages; this only saves a lookup for the per-file override.)
 * @param {Record<string, any>} entry
 * @param {string} filePath
 * @returns {boolean}
 */
function passagesExpected(entry, filePath) {
  if (isImagePath(filePath)) return false;
  const policy = entry?.embedding?.policy;
  if (policy === 'skip' || policy === 'web_only') return false;
  const text = String(entry?.analysis?.extractedText || '').trim();
  return text.length >= CHUNKING.MIN_TEXT_LENGTH;
}

/**
 * @typedef {{ count: number, placeholderCount: number, missingVectorCount: number }} ChunkHealth
 * @typedef {(fileId: string) => Promise<ChunkHealth | null>} PassageHealthReader
 */

/**
 * Passage health for one run of the repair. With describeAllFileChunks the
 * chunk collection is read ONCE, the first time a file needs a look, and
 * every file after that is a map lookup. Asking describeFileChunks per file
 * paged through every chunk in the store each time (its string filter is not
 * exact), so a launch cost files x chunks. Without the bulk read, or when it
 * fails, each file is described on its own as before.
 *
 * The snapshot only picks which files to look at. The repair itself reads
 * that one file again (repairStoredPassages), so a file whose passages were
 * written after the snapshot is not rebuilt over.
 * @param {any} vectorDb
 * @returns {PassageHealthReader | null} null when the store cannot describe passages
 */
function createPassageHealthReader(vectorDb) {
  const canBulk = typeof vectorDb?.describeAllFileChunks === 'function';
  const canSingle = typeof vectorDb?.describeFileChunks === 'function';
  if (!canBulk && !canSingle) return null;
  /** @type {Map<string, ChunkHealth> | null | undefined} undefined until the first read */
  let index;
  return async (fileId) => {
    if (index === undefined) {
      index = null;
      if (canBulk) {
        try {
          const all = await vectorDb.describeAllFileChunks();
          index = all instanceof Map ? all : null;
        } catch {
          index = null;
        }
      }
    }
    if (index) return index.get(fileId) || { count: 0, placeholderCount: 0, missingVectorCount: 0 };
    if (!canSingle) return null;
    return vectorDb.describeFileChunks(fileId);
  };
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
 * @param {PassageHealthReader | null} readHealth
 * @param {string} fileId
 * @param {Record<string, any>} entry
 * @param {string} filePath
 * @param {boolean} checkPassages
 * @returns {Promise<boolean>}
 */
async function passagesNeedRepair(readHealth, fileId, entry, filePath, checkPassages) {
  if (!checkPassages) return false;
  if (!passagesExpected(entry, filePath)) return false;
  if (!readHealth) return false;
  let described;
  try {
    described = await readHealth(fileId);
  } catch {
    return false;
  }
  if (!described) return false;
  return (
    described.count === 0 || described.placeholderCount > 0 || described.missingVectorCount > 0
  );
}

/**
 * passagesNeedRepair, with a lookup failure logged and read as "fine" (the
 * file is looked at again next launch).
 * @param {PassageHealthReader | null} readHealth
 * @param {string} fileId
 * @param {Record<string, any>} entry
 * @param {string} filePath
 * @param {boolean} checkPassages
 * @param {{ debug: Function }} log
 * @returns {Promise<boolean>}
 */
async function checkPassagesSafely(readHealth, fileId, entry, filePath, checkPassages, log) {
  try {
    return await passagesNeedRepair(readHealth, fileId, entry, filePath, checkPassages);
  } catch (error) {
    log.debug('Passage lookup failed during repair', {
      filePath,
      error: /** @type {any} */ (error)?.message
    });
    return false;
  }
}

/**
 * Ask the injected pre-gate whether the repair could embed this file at all.
 * No pre-gate, or one that fails, reads as yes: the embedder and the passage
 * repair still ask the full gate themselves.
 * @param {((args: { entry: Record<string, any>, filePath: string }) => Promise<boolean>) | undefined} wouldEmbed
 * @param {Record<string, any>} entry
 * @param {string} filePath
 * @param {{ debug: Function }} log
 * @returns {Promise<boolean>}
 */
async function wouldEmbedSafely(wouldEmbed, entry, filePath, log) {
  if (typeof wouldEmbed !== 'function') return true;
  try {
    return (await wouldEmbed({ entry, filePath })) !== false;
  } catch (error) {
    log.debug('Embedding gate check failed during repair', {
      filePath,
      error: /** @type {any} */ (error)?.message
    });
    return true;
  }
}

/**
 * @param {{
 *   entries: Record<string, any> | null | undefined,
 *   vectorDb: { getFile: (id: string) => Promise<any>,
 *               restoreOrphanedEmbeddings?: (ids: string[]) => Promise<any> } | null | undefined,
 *   embedEntry: (args: { entry: Record<string, any>, filePath: string }) => Promise<{ action?: string, reason?: string }>,
 *   repairPassages?: (args: { entry: Record<string, any>, filePath: string }) => Promise<{ action?: string, reason?: string }>,
 *   wouldEmbed?: (args: { entry: Record<string, any>, filePath: string }) => Promise<boolean>,
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
  wouldEmbed,
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
  const readHealth = createPassageHealthReader(vectorDb);
  /**
   * @type {Array<{ entry: Record<string, any>, filePath: string, id: string, doc: any,
   *   usable: boolean, restoring: boolean, passagesBroken: boolean | null }>}
   */
  const needsWork = [];

  // Pass 1 reads only the in-memory vector store. A file whose row is live,
  // carries a real vector and has the passages it should have gets no repair
  // whether or not it is still on disk, so it is counted healthy without a
  // disk check. On a normal launch that is every entry, and the run ends here
  // without touching the disk or the embedding model.
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
    // The store reads an orphan-marked row as unusable whatever its vector,
    // so whether the vector is intact is only known once the row is restored
    // (pass 2). Deciding here from `usable` sent every orphan to the embedder.
    const restoring = Boolean(doc?.isOrphaned && doc.hasVector !== false);
    // Passages are only looked at here when the file vector needs nothing;
    // otherwise pass 2 looks after the re-embed, in the original order.
    /** @type {boolean | null} */
    let passagesBroken = null;
    if (usable && !restoring) {
      passagesBroken = await checkPassagesSafely(
        readHealth,
        id,
        entry,
        filePath,
        checkPassages,
        log
      );
      if (!passagesBroken) {
        summary.checked++;
        summary.healthy++;
        continue;
      }
    }
    // Re-embedding and passage repair both go through the embedding gate. A
    // file the gate keeps out of the index ('manual' timing, a 'skip' policy,
    // outside a smart-folders-only scope) would be stat-ed, refused and its
    // history rewritten on every launch, so it is set aside here, unstat-ed.
    // An orphan restore is not embedding work and still goes ahead.
    if (!restoring && !(await wouldEmbedSafely(wouldEmbed, entry, filePath, log))) {
      summary.skippedGate++;
      continue;
    }
    needsWork.push({ entry, filePath, id, doc, usable, restoring, passagesBroken });
  }

  // Pass 2: only files that need something. Each is checked on disk first,
  // as before — a missing file is never restored or re-embedded.
  /** @type {typeof needsWork} */
  const present = [];
  for (const item of needsWork) {
    if (shouldStop()) {
      summary.stopped = true;
      break;
    }
    if (!(await fileExists(item.filePath))) {
      summary.skippedMissing++;
      continue;
    }
    summary.checked++;
    present.push(item);
    if (item.restoring) toRestore.push(item.id);
  }

  // Orphan-marked rows whose file is back are un-flagged first, in one call:
  // the file exists, so the stale-path mark is wrong whatever the vector. The
  // vector is then judged like any other row's, and only a missing or zero
  // one is re-embedded (F-221).
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

  for (const item of present) {
    if (shouldStop()) {
      summary.stopped = true;
      break;
    }
    const { entry, filePath, id, restoring } = item;
    const usable = restoring ? await fileVectorUsable(vectorDb, item.doc, id) : item.usable;
    const atCap = () => summary.embedded + summary.passages + summary.failed >= maxEmbeds;

    if (!usable) {
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

    const passagesBroken =
      item.passagesBroken ??
      (await checkPassagesSafely(readHealth, id, entry, filePath, checkPassages, log));
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

  return summary;
}

/**
 * Re-embed the given chunk rows in place: same id, same offsets, each from
 * its OWN stored text. Nothing is deleted and nothing is added, so the set
 * keeps its size. A row whose embedding fails is left as it was (it is
 * looked at again next launch).
 * @param {{ fileId: string, filePath: string,
 *   rows: Array<{ id?: string, chunkIndex?: number, content?: string,
 *     startOffset?: number, endOffset?: number }>,
 *   embedText: (text: string) => Promise<any>, vectorDb: any }} args
 * @returns {Promise<{ action: 'repaired' | 'skipped', reason?: string }>}
 */
async function reembedChunkRowsInPlace({ fileId, filePath, rows, embedText, vectorDb }) {
  if (typeof vectorDb?.batchUpsertFileChunks !== 'function') {
    return { action: 'skipped', reason: 'no_store' };
  }
  const name = path.basename(filePath);
  /** @type {Array<Record<string, any>>} */
  const payloads = [];
  for (const row of rows) {
    const text = typeof row?.content === 'string' ? row.content : '';
    if (typeof row?.id !== 'string' || !row.id || !text.trim()) continue;
    let embedding;
    try {
      embedding = await embedText(text);
    } catch {
      continue;
    }
    if (!Array.isArray(embedding?.vector) || embedding.vector.length === 0) continue;
    const startOffset = Number(row.startOffset) || 0;
    const endOffset = Number(row.endOffset) || 0;
    const snippet = text.slice(0, 240);
    payloads.push({
      id: row.id,
      vector: embedding.vector,
      model: embedding.model,
      meta: {
        fileId,
        path: filePath,
        name,
        chunkIndex: Number(row.chunkIndex) || 0,
        startOffset,
        endOffset,
        text,
        content: text,
        charStart: startOffset,
        charEnd: endOffset,
        snippet,
        model: embedding.model || 'unknown'
      },
      document: snippet,
      updatedAt: new Date().toISOString()
    });
  }
  if (payloads.length === 0) return { action: 'skipped', reason: 'no_embeddings' };
  const count = await vectorDb.batchUpsertFileChunks(payloads);
  const persisted = Number.isFinite(Number(count)) ? Number(count) : payloads.length;
  if (persisted > 0) return { action: 'repaired' };
  return { action: 'skipped', reason: 'no-passages' };
}

/**
 * Repair one file's passages. No language-model call. The rule:
 *
 *  1. Ask the embedding gate first, the same question the analysis path asks
 *     before it builds passages (stage 'analysis', the file's own policy
 *     override, the global policy, timing and scope). A file the user keeps
 *     out of the local index ('skip', 'web_only', manual timing, outside a
 *     smart-folders-only scope) gets no passages, so its text cannot surface
 *     in passage search or chat.
 *  2. Read this one file's passage rows again (the startup snapshot may be
 *     stale: the file may have been re-analysed since).
 *  3. No rows at all: build the set from the text stored on the history
 *     entry. Nothing exists, so nothing can be lost.
 *  4. Rows exist: re-embed ONLY the zero or vector-less rows, each from its
 *     own stored text, under its own id. The history copy of the text is
 *     capped (50k characters) and the original passages may cover more of the
 *     document, so a rebuild from that copy would delete every passage past
 *     the cap. Filling rows in place never shrinks the set.
 *  5. Rows are healthy by now, or the store cannot say: do nothing.
 *
 * @param {{ entry: Record<string, any>, filePath: string,
 *   embedText: ((text: string) => Promise<any>) | undefined,
 *   vectorDb: any, isInSmartFolder?: boolean }} args
 * @returns {Promise<{ action: 'repaired' | 'skipped', reason?: string }>}
 */
async function repairStoredPassages({ entry, filePath, embedText, vectorDb, isInSmartFolder }) {
  if (typeof embedText !== 'function') {
    return { action: 'skipped', reason: 'no-embedder' };
  }

  const { shouldEmbedForRepair } = require('./embeddingGate');
  const gate = await shouldEmbedForRepair({
    policyOverride: entry?.embedding?.policy || undefined,
    analysis: entry?.analysis || null,
    isInSmartFolder
  });
  if (!gate?.shouldEmbed) {
    return {
      action: 'skipped',
      reason: gate?.reason || `disabled:${gate?.timing}:${gate?.policy}`
    };
  }

  const fileId = getSemanticFileId(filePath);
  if (typeof vectorDb?.describeFileChunks === 'function') {
    const described = await vectorDb.describeFileChunks(fileId, { includeUnusable: true });
    // Unknown state: a rebuild deletes first, so never rebuild over rows we
    // could not see.
    if (!described) return { action: 'skipped', reason: 'chunk-state-unknown' };
    if (described.count > 0) {
      const rows = Array.isArray(described.unusable) ? described.unusable : [];
      if (rows.length === 0) return { action: 'skipped', reason: 'already-healthy' };
      return reembedChunkRowsInPlace({ fileId, filePath, rows, embedText, vectorDb });
    }
  }

  const { embedFileChunks } = require('../../analysis/chunkEmbedding');
  const result = await embedFileChunks({
    fileId,
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
      // Resolved on first use: a launch where every file is healthy never
      // reaches the embedder, so it should not wire one up either.
      /** @type {ReturnType<typeof resolveServices> | null} */
      let services = null;
      const getServices = () => (services ??= resolveServices());
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
        // The gate's own answer for this file, before any disk or model work.
        // Scope needs the smart-folder list, so services are only wired up
        // when the library is smart-folders-only.
        wouldEmbed: async ({ entry, filePath }) => {
          const { shouldEmbedForRepair } = require('./embeddingGate');
          const gate = await shouldEmbedForRepair({
            policyOverride: entry?.embedding?.policy || null,
            analysis: entry?.analysis || null
          });
          if (!gate?.shouldEmbed) return false;
          if (gate.scope === 'smart_folders_only') {
            return Boolean(getSmartFolderForPath(filePath, getServices()));
          }
          return true;
        },
        embedEntry: ({ entry, filePath }) =>
          embedHistoryEntry({
            entry,
            filePath,
            smartFolder: getSmartFolderForPath(filePath, getServices()),
            services: getServices()
          }),
        repairPassages: checkPassages
          ? ({ entry, filePath }) => {
              const resolved = getServices();
              const { folderMatchingService } = resolved;
              return repairStoredPassages({
                entry,
                filePath,
                embedText: folderMatchingService?.embedText?.bind(folderMatchingService),
                vectorDb,
                // Scope gate input, as the analysis path gives it. With no
                // smart folder list this reads "outside", so a
                // smart-folders-only library fails closed.
                isInSmartFolder: Boolean(getSmartFolderForPath(filePath, resolved))
              });
            }
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
