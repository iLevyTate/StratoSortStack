// @ts-check
/**
 * Embedding Queue Persistence Module
 *
 * Handles file I/O operations for queue persistence with atomic writes.
 * Uses shared atomicFile utilities for consistent atomic file operations.
 *
 * @module embeddingQueue/persistence
 */

const path = require('path');
const fs = require('fs').promises;
const { logger } = require('../../../shared/logger');
const { createKeyValueStore, shouldUseSqliteBackend } = require('../../utils/sqliteStore');
const { compressSync: compress, uncompressSync: uncompress } = require('../../../shared/lz4Codec');
const {
  atomicWriteFile,
  safeUnlink,
  loadJsonFile,
  persistData,
  persistMap
} = require('../../../shared/atomicFile');

const SQLITE_DB_NAME = 'embedding-queue.db';
const SQLITE_TABLE = 'embedding_queue_kv';
const SQLITE_KEYS = {
  queue: 'queue',
  failedItems: 'failedItems',
  deadLetter: 'deadLetter'
};

const sqliteStores = new Map();
const SQLITE_COMPRESSION_ENABLED =
  String(process.env.STRATOSORT_SQLITE_COMPRESS || 'true').toLowerCase() !== 'false';

function shouldUseSqlite() {
  return shouldUseSqliteBackend('embeddingQueue');
}

/** @param {string} filePath */
function getSqliteDbPath(filePath) {
  return path.join(path.dirname(filePath), SQLITE_DB_NAME);
}

/** @param {string} filePath */
function getSqliteStore(filePath) {
  const dbPath = getSqliteDbPath(filePath);
  if (sqliteStores.has(dbPath)) {
    return sqliteStores.get(dbPath);
  }
  const store = createKeyValueStore({
    dbPath,
    tableName: SQLITE_TABLE,
    serialize: (/** @type {any} */ value) => {
      const json = JSON.stringify(value);
      if (!SQLITE_COMPRESSION_ENABLED) {
        return Buffer.from(json, 'utf8');
      }
      return compress(Buffer.from(json, 'utf8'));
    },
    deserialize: (/** @type {Buffer | Uint8Array} */ raw) => {
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const text = buffer.toString('utf8');
      try {
        return JSON.parse(text);
      } catch (jsonError) {
        try {
          const decompressed = uncompress(buffer);
          return JSON.parse(decompressed.toString('utf8'));
        } catch (decompressError) {
          throw Object.assign(new Error('SQLite blob decode failed'), {
            code: 'SQLITE_CORRUPT',
            originalError: jsonError,
            decompressError
          });
        }
      }
    }
  });
  sqliteStores.set(dbPath, store);
  return store;
}

/**
 * Close the SQLite store backing `filePath` (or every open store when omitted).
 * Closing runs a WAL checkpoint, so this must be called on clean shutdown
 * after the final persist. Idempotent; a no-op for stores never opened.
 * @param {string | null} [filePath]
 */
function closeSqliteStore(filePath = null) {
  if (filePath) {
    const dbPath = getSqliteDbPath(filePath);
    const store = sqliteStores.get(dbPath);
    if (store && typeof store.close === 'function') {
      store.close();
    }
    sqliteStores.delete(dbPath);
    return;
  }

  for (const [dbPath, store] of sqliteStores.entries()) {
    if (store && typeof store.close === 'function') {
      store.close();
    }
    sqliteStores.delete(dbPath);
  }
}

/**
 * @param {string} filePath
 * @param {any} reason
 */
async function backupSqliteDb(filePath, reason) {
  const dbPath = getSqliteDbPath(filePath);

  closeSqliteStore(filePath);

  const backupPath = `${dbPath}.corrupt.${Date.now()}`;
  try {
    await fs.copyFile(dbPath, backupPath);
    try {
      await fs.unlink(dbPath);
    } catch (unlinkError) {
      logger.warn('[EmbeddingQueue] Failed to delete corrupt sqlite db after backup', {
        dbPath,
        error: unlinkError?.message || unlinkError
      });
    }
    logger.warn('[EmbeddingQueue] Backed up corrupt sqlite db', {
      dbPath,
      backupPath,
      reason: reason?.message || reason
    });
  } catch (backupError) {
    logger.warn('[EmbeddingQueue] Failed to back up corrupt sqlite db', {
      dbPath,
      error: backupError?.message || backupError
    });
  }
}

/**
 * @param {string} filePath
 * @param {string} key
 * @param {string} description
 */
async function maybeMigrateLegacyFile(filePath, key, description) {
  const parsed = await loadJsonFile(filePath, {
    description,
    backupCorrupt: true
  });
  if (parsed === null || parsed === undefined) {
    return null;
  }
  const store = getSqliteStore(filePath);
  store.set(key, parsed);
  try {
    await fs.rename(filePath, `${filePath}.legacy.${Date.now()}`);
  } catch (error) {
    logger.debug('[EmbeddingQueue] Failed to rename legacy persistence file', {
      filePath,
      error: error.message
    });
  }
  return parsed;
}

/**
 * Load persisted data from a file
 * @param {string} filePath - Path to the file
 * @param {Function} onLoad - Callback with parsed data
 * @param {string} description - Description for logging
 * @param {{ key?: string, jsonPath?: string }} [options]
 */
async function loadPersistedData(filePath, onLoad, description, options = {}) {
  const key = options.key;
  if (shouldUseSqlite()) {
    try {
      const store = getSqliteStore(filePath);
      const existing = store.get(key);
      if (existing !== undefined) {
        if (onLoad) onLoad(existing);
        return;
      }
      const migrated = await maybeMigrateLegacyFile(filePath, key, description);
      if (migrated !== null && migrated !== undefined) {
        if (onLoad) onLoad(migrated);
      }
      return;
    } catch (error) {
      if (
        error?.code === 'SQLITE_CORRUPT' ||
        error?.code === 'SQLITE_NOTADB' ||
        (error?.message && error.message.includes('file is not a database'))
      ) {
        await backupSqliteDb(filePath, error);
        // closeSqliteStore() is handled inside backupSqliteDb
      }
      logger.warn('[EmbeddingQueue] SQLite load failed, falling back to JSON', {
        error: error.message
      });
    }
  }

  // JSON fallback honors an explicit `jsonPath` override so distinct logical
  // keys can occupy distinct files. Without it, multiple persist*() calls
  // sharing one filePath would clobber each other in JSON-only mode.
  const targetPath = options.jsonPath || filePath;
  await loadJsonFile(targetPath, {
    onLoad,
    description,
    backupCorrupt: true
  });
}

/**
 * Persist queue data to disk
 * @param {string} filePath - Path to persist to
 * @param {any[]} queue - Queue data to persist
 * @param {{ key?: string, jsonPath?: string, throwOnError?: boolean }} [options]
 */
async function persistQueueData(filePath, queue, options = {}) {
  const key = options.key || SQLITE_KEYS.queue;
  try {
    if (shouldUseSqlite()) {
      const store = getSqliteStore(filePath);
      store.set(key, queue);
      return;
    }
    // See loadPersistedData: jsonPath override prevents key collisions in
    // JSON-fallback mode where multiple keys would otherwise share one file.
    const targetPath = options.jsonPath || filePath;
    await persistData(targetPath, queue);
  } catch (error) {
    // When throwOnError is set (used by flush to prevent data loss),
    // propagate the error so the caller can re-add items to the queue.
    if (options.throwOnError) {
      throw error;
    }
    // Log but don't re-throw: persistence errors should not break callers
    // (shutdown, periodic save) who expect fire-and-forget semantics
    logger.error('[EmbeddingQueue] Error persisting queue to disk:', error.message);
  }
}

/**
 * Persist failed items to disk
 * @param {string} filePath - Path to persist to
 * @param {Map<any, any>} failedItems - Failed items map
 * @param {{ key?: string, jsonPath?: string }} [options]
 */
async function persistFailedItems(filePath, failedItems, options = {}) {
  const key = options.key || SQLITE_KEYS.failedItems;
  try {
    if (shouldUseSqlite()) {
      const store = getSqliteStore(filePath);
      const data = Array.from(failedItems.entries());
      store.set(key, data);
      return;
    }
    const targetPath = options.jsonPath || filePath;
    await persistMap(targetPath, failedItems);
  } catch (error) {
    logger.error('[EmbeddingQueue] Error persisting failed items:', error.message);
  }
}

/**
 * Persist dead letter queue to disk
 * @param {string} filePath - Path to persist to
 * @param {any[]} deadLetterQueue - Dead letter queue
 * @param {{ key?: string, jsonPath?: string }} [options]
 */
async function persistDeadLetterQueue(filePath, deadLetterQueue, options = {}) {
  const key = options.key || SQLITE_KEYS.deadLetter;
  try {
    if (shouldUseSqlite()) {
      const store = getSqliteStore(filePath);
      store.set(key, deadLetterQueue);
      return;
    }
    const targetPath = options.jsonPath || filePath;
    await persistData(targetPath, deadLetterQueue, { pretty: true });
  } catch (error) {
    logger.error('[EmbeddingQueue] Error persisting dead letter queue:', error.message);
  }
}

module.exports = {
  loadPersistedData,
  atomicWriteFile,
  safeUnlink,
  persistQueueData,
  persistFailedItems,
  persistDeadLetterQueue,
  closeSqliteStore,
  SQLITE_KEYS
};
