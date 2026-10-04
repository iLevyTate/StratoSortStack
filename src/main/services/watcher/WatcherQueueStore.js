// @ts-check
/**
 * WatcherQueueStore
 *
 * File-backed store for the SmartFolderWatcher analysis queue (K-07).
 *
 * The watcher's queue previously lived only in memory, so a shutdown in the
 * middle of a reanalysis lost every queued item — and because chokidar is
 * started with `ignoreInitial: true`, nothing ever rediscovered those files.
 * Persisting the queue (debounced by the watcher) and restoring it on start
 * closes that hole.
 *
 * @module services/watcher/WatcherQueueStore
 */

const fs = require('fs').promises;
const path = require('path');
const { createLogger } = require('../../../shared/logger');
const { durableWriteJson } = require('../../../shared/atomicFileOperations');

const logger = createLogger('WatcherQueueStore');

const PERSISTED_FIELDS = [
  'filePath',
  'mtime',
  'eventType',
  'queuedAt',
  'retryCount',
  'applyNaming',
  'dedupKey',
  // forceReanalyzeAll's mark. The watcher's exclusion gates exempt a
  // hand-picked single-file reanalyze from the user's rules but not a bulk
  // one; without this on disk, every row of an interrupted bulk run came
  // back exempt after the restart.
  'bulk'
];

/**
 * @typedef {{ filePath: string, mtime?: number, eventType?: string, queuedAt?: number, retryCount?: number, applyNaming?: boolean, dedupKey?: string, bulk?: boolean }} PersistedQueueItem
 */

/**
 * Keep only the fields needed to resume an item; drop cached analyses and
 * anything private so the file stays small and never embeds file content.
 * @param {any} item
 * @returns {PersistedQueueItem | null}
 */
function toPersisted(item) {
  if (!item || typeof item.filePath !== 'string' || !item.filePath) return null;
  /** @type {any} */
  const out = {};
  for (const key of PERSISTED_FIELDS) {
    if (item[key] !== undefined) out[key] = item[key];
  }
  return out;
}

/**
 * Read a queue file and return its raw rows. Understands this store's shape
 * (`{ items }`) and the short-lived second queue file an earlier build wrote
 * (`{ queue, overflow }`). A missing file is an empty queue.
 * @param {string} file
 * @returns {Promise<any[]>}
 */
async function readQueueRows(file) {
  try {
    const parsed = JSON.parse(String(await fs.readFile(file, 'utf8')));
    if (Array.isArray(parsed?.items)) return parsed.items;
    return [
      ...(Array.isArray(parsed?.queue) ? parsed.queue : []),
      ...(Array.isArray(parsed?.overflow) ? parsed.overflow : [])
    ];
  } catch (err) {
    if (err && /** @type {any} */ (err).code !== 'ENOENT') {
      logger.warn('Could not read persisted queue; starting empty', {
        file: path.basename(file),
        error: /** @type {any} */ (err).message
      });
    }
    return [];
  }
}

/**
 * Build a file-backed store for the watcher analysis queue.
 *
 * `legacyFilePath` names the queue file a parallel implementation wrote for a
 * few days on main (smart-folder-watcher-queue.json). Its rows are merged on
 * load and the file is removed after the next durable save, so nothing that
 * build queued is lost and the file does not linger. The watcher dedupes the
 * merged rows by path.
 *
 * @param {string} filePath absolute path of the JSON file
 * @param {{ legacyFilePath?: string }} [options]
 */
function createWatcherQueueStore(filePath, options = {}) {
  const legacyFilePath = options.legacyFilePath || null;
  return {
    filePath,
    /** @returns {Promise<PersistedQueueItem[]>} */
    async load() {
      const rows = [
        ...(await readQueueRows(filePath)),
        ...(legacyFilePath ? await readQueueRows(legacyFilePath) : [])
      ];
      return /** @type {PersistedQueueItem[]} */ (
        rows.map(toPersisted).filter((/** @type {any} */ x) => x !== null)
      );
    },
    /**
     * Replace the persisted queue. An empty queue removes the file so a clean
     * shutdown doesn't leave a stale list behind for the next start.
     * @param {any[]} items
     */
    async save(items) {
      const persisted = (Array.isArray(items) ? items : [])
        .map(toPersisted)
        .filter((/** @type {any} */ x) => x !== null);
      if (persisted.length === 0) {
        await fs.rm(filePath, { force: true });
        if (legacyFilePath) await fs.rm(legacyFilePath, { force: true });
        return;
      }
      // durableWriteJson (not safeWriteFile) because the whole point of this
      // file is to survive a hard shutdown: it fsyncs the temp file before the
      // rename, so a power loss can't commit a zero-byte queue. It does not
      // create the parent directory, so do that first.
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await durableWriteJson(filePath, {
        version: 1,
        savedAt: new Date().toISOString(),
        items: persisted
      });
      // Only now that its rows are durably in the canonical file.
      if (legacyFilePath) await fs.rm(legacyFilePath, { force: true });
    }
  };
}

module.exports = { createWatcherQueueStore, toPersisted };
