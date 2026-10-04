// @ts-check
/**
 * Persistence
 *
 * File I/O operations for analysis history.
 * Handles atomic writes, loading, and saving of history, index, and config.
 *
 * @module analysisHistory/persistence
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('node:crypto');
const { createLogger } = require('../../../shared/logger');
const { replaceFileWithRetry } = require('../../../shared/atomicFile');
const {
  createKeyValueStore,
  shouldUseSqliteBackend,
  isSqliteTransientError
} = require('../../utils/sqliteStore');
const { compressSync: compress, uncompressSync: uncompress } = require('../../../shared/lz4Codec');
const { tryParse: safeJsonTryParse } = require('../../../shared/safeJsonOps');

// Persisted state is user-writable on disk. Route every parse through
// `safeJsonTryParse` so `__proto__` / `constructor` / `prototype` keys
// injected by on-disk tampering or a buggy upstream writer are stripped
// instead of polluting runtime object prototypes.
function parsePersistedJson(/** @type {any} */ text, /** @type {any} */ contextLabel) {
  const { success, value, error } = safeJsonTryParse(text);
  if (!success) {
    const err = error || new Error(`Failed to parse persisted ${contextLabel}`);
    throw err;
  }
  return value;
}

const logger = createLogger('AnalysisHistory-Persistence');
const TRANSIENT_ERROR_CODES = new Set([
  'EACCES',
  'EPERM',
  'EBUSY',
  'EMFILE',
  'ENFILE',
  'ETIMEDOUT'
]);

const SQLITE_DB_NAME = 'analysis-history.db';
const SQLITE_TABLE = 'analysis_history_kv';
const SQLITE_KEYS = {
  config: 'config',
  history: 'history',
  index: 'index'
};
const SQLITE_COMPRESSION_ENABLED =
  String(process.env.STRATOSORT_SQLITE_COMPRESS || 'true').toLowerCase() !== 'false';

const sqliteStores = new Map();

function getSqliteDbPath(/** @type {any} */ referencePath) {
  return path.join(path.dirname(referencePath), SQLITE_DB_NAME);
}

function isTransientError(/** @type {any} */ error) {
  return Boolean(error?.code && TRANSIENT_ERROR_CODES.has(error.code));
}

function shouldUseSqlite() {
  return shouldUseSqliteBackend('analysisHistory');
}

function getSqliteStore(/** @type {any} */ referencePath) {
  const dbPath = getSqliteDbPath(referencePath);
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
    deserialize: (/** @type {any} */ raw) => {
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const text = buffer.toString('utf8');
      const firstAttempt = safeJsonTryParse(text);
      if (firstAttempt.success) return firstAttempt.value;
      try {
        const decompressed = uncompress(buffer);
        const secondAttempt = safeJsonTryParse(decompressed.toString('utf8'));
        if (secondAttempt.success) return secondAttempt.value;
        const err =
          /** @type {Error & { code?: string, originalError?: any, decompressError?: any }} */ (
            new Error('SQLite blob decode failed')
          );
        err.code = 'SQLITE_CORRUPT';
        err.originalError = firstAttempt.error;
        err.decompressError = secondAttempt.error;
        throw err;
      } catch (decompressError) {
        const err =
          /** @type {Error & { code?: string, originalError?: any, decompressError?: any }} */ (
            new Error('SQLite blob decode failed')
          );
        err.code = 'SQLITE_CORRUPT';
        err.originalError = firstAttempt.error;
        err.decompressError = decompressError;
        throw err;
      }
    }
  });
  sqliteStores.set(dbPath, store);
  return store;
}

function closeSqliteStore(/** @type {any} */ referencePath = null) {
  if (referencePath) {
    const dbPath = getSqliteDbPath(referencePath);
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

async function backupSqliteDb(/** @type {any} */ referencePath, /** @type {any} */ reason) {
  const dbPath = getSqliteDbPath(referencePath);

  // Close store to release file lock before moving
  closeSqliteStore(referencePath);

  const backupPath = `${dbPath}.corrupt.${Date.now()}`;
  try {
    await fs.copyFile(dbPath, backupPath);
    try {
      await fs.unlink(dbPath);
    } catch (unlinkError) {
      logger.warn('[AnalysisHistory] Failed to delete corrupt sqlite db after backup', {
        dbPath,
        error: unlinkError?.message || unlinkError
      });
    }
    logger.warn('[AnalysisHistory] Backed up corrupt sqlite db', {
      dbPath,
      backupPath,
      reason: reason?.message || reason
    });
  } catch (backupError) {
    logger.warn('[AnalysisHistory] Failed to back up corrupt sqlite db', {
      dbPath,
      error: backupError?.message || backupError
    });
  }
}

async function backupCorruptFile(/** @type {any} */ filePath, /** @type {any} */ reason) {
  const backupPath = `${filePath}.corrupt.${Date.now()}`;
  try {
    await fs.copyFile(filePath, backupPath);
    logger.warn('[AnalysisHistory] Backed up corrupt file', {
      filePath,
      backupPath,
      reason: reason?.message || reason
    });
  } catch (backupError) {
    logger.warn('[AnalysisHistory] Failed to back up corrupt file', {
      filePath,
      error: backupError?.message || backupError
    });
  }
}

async function migrateLegacyJson(
  /** @type {any} */ filePath,
  /** @type {any} */ key,
  /** @type {any} */ description
) {
  try {
    const json = await fs.readFile(filePath, 'utf8');
    const parsed = parsePersistedJson(json, description);
    const store = getSqliteStore(filePath);
    store.set(key, parsed);
    try {
      await fs.rename(filePath, `${filePath}.legacy.${Date.now()}`);
    } catch (renameError) {
      logger.debug('[AnalysisHistory] Failed to rename legacy JSON file', {
        filePath,
        error: renameError.message
      });
    }
    logger.info(`[AnalysisHistory] Migrated ${description} to SQLite`);
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    if (error instanceof SyntaxError) {
      await backupCorruptFile(filePath, error);
      return null;
    }
    if (isTransientError(error)) {
      error.transient = true;
      throw error;
    }
    logger.warn(`[AnalysisHistory] Failed to migrate legacy ${description}`, {
      error: error.message
    });
    return null;
  }
}

/**
 * Ensure parent directory exists
 * @param {string} filePath - File path
 */
async function ensureParentDirectory(filePath) {
  const parentDirectory = path.dirname(filePath);
  await fs.mkdir(parentDirectory, { recursive: true });
}

/**
 * Atomic write helper - writes to temp file then renames to prevent corruption
 * @param {string} filePath - Target file path
 * @param {string} data - Data to write
 */
async function atomicWriteFile(filePath, data) {
  // Random suffix prevents two writers in the same millisecond from racing
  // on the same .tmp path. Without this, the loser's catch-block unlink
  // can delete the winner's file mid-rename on Windows.
  const tempPath = `${filePath}.tmp.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    await fs.writeFile(tempPath, data);
    await replaceFileWithRetry(tempPath, filePath);
  } catch (error) {
    // Clean up temp file on failure
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

async function loadConfigFromJson(
  /** @type {any} */ configPath,
  /** @type {any} */ getDefaultConfig,
  /** @type {any} */ saveConfig
) {
  try {
    const configData = await fs.readFile(configPath, 'utf8');
    return parsePersistedJson(configData, 'analysis-history config');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const config = getDefaultConfig();
      await saveConfig(config);
      return config;
    }
    if (isTransientError(error)) {
      error.transient = true;
      throw error;
    }
    if (error instanceof SyntaxError) {
      await backupCorruptFile(configPath, error);
      const config = getDefaultConfig();
      await saveConfig(config);
      return config;
    }
    error.preserveOnError = true;
    throw error;
  }
}

async function saveConfigToJson(/** @type {any} */ configPath, /** @type {any} */ config) {
  config.updatedAt = new Date().toISOString();
  await ensureParentDirectory(configPath);
  await atomicWriteFile(configPath, JSON.stringify(config, null, 2));
}

/**
 * Load config from disk (SQLite-backed when available)
 * @param {string} configPath - Path to config file
 * @param {Function} getDefaultConfig - Function to get default config
 * @param {Function} saveConfig - Function to save config
 * @returns {Promise<Object>} Config object
 */
async function loadConfig(configPath, getDefaultConfig, saveConfig) {
  if (!shouldUseSqlite()) {
    return loadConfigFromJson(configPath, getDefaultConfig, saveConfig);
  }

  try {
    const store = getSqliteStore(configPath);
    let existing;
    try {
      existing = store.get(SQLITE_KEYS.config);
    } catch (error) {
      if (error?.code === 'SQLITE_CORRUPT') {
        await backupSqliteDb(configPath, error);
      }
      throw error;
    }
    if (existing !== undefined && existing !== null) {
      return existing;
    }
    const migrated = await migrateLegacyJson(configPath, SQLITE_KEYS.config, 'config');
    if (migrated) {
      return migrated;
    }
    const config = getDefaultConfig();
    store.set(SQLITE_KEYS.config, config);
    return config;
  } catch (error) {
    if (
      error?.code === 'SQLITE_CORRUPT' ||
      error?.code === 'SQLITE_NOTADB' ||
      (error?.message && error.message.includes('file is not a database'))
    ) {
      await backupSqliteDb(configPath, error);
      // Fall through to JSON fallback
    }
    if (isSqliteTransientError(error)) {
      error.transient = true;
      throw error;
    }
    logger.warn('[AnalysisHistory] SQLite loadConfig failed, falling back to JSON', {
      error: error.message
    });
    return loadConfigFromJson(configPath, getDefaultConfig, saveConfig);
  }
}

/**
 * Save config to disk
 * @param {string} configPath - Path to config file
 * @param {Record<string, any>} config - Config object
 */
async function saveConfig(configPath, config) {
  if (!shouldUseSqlite()) {
    return saveConfigToJson(configPath, config);
  }
  const store = getSqliteStore(configPath);
  config.updatedAt = new Date().toISOString();
  store.set(SQLITE_KEYS.config, config, config.updatedAt);
}

async function loadHistoryFromJson(
  /** @type {any} */ historyPath,
  /** @type {any} */ schemaVersion,
  /** @type {any} */ createEmptyHistory,
  /** @type {any} */ saveHistory,
  /** @type {any} */ migrateHistory
) {
  try {
    const historyData = await fs.readFile(historyPath, 'utf8');
    let history = parsePersistedJson(historyData, 'analysis-history');

    if (history.schemaVersion !== schemaVersion) {
      history = await migrateHistory(history);
      await saveHistory(history);
    }

    return history;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const history = createEmptyHistory();
      await saveHistory(history);
      return history;
    }
    if (isTransientError(error)) {
      error.transient = true;
      throw error;
    }
    if (error instanceof SyntaxError) {
      await backupCorruptFile(historyPath, error);
      const history = createEmptyHistory();
      await saveHistory(history);
      return history;
    }
    if (error?.code === 'HISTORY_SCHEMA_TOO_NEW') {
      // Future-version history file: migrateHistory threw before we could
      // safely interpret it. Preserve the original file (via backup) and
      // start fresh so the running build doesn't corrupt it.
      logger.warn(
        '[AnalysisHistory] History file is newer than this build; backing up and starting empty',
        {
          historyVersion: error.historyVersion,
          currentVersion: error.currentVersion
        }
      );
      await backupCorruptFile(historyPath, error);
      const history = createEmptyHistory();
      await saveHistory(history);
      return history;
    }
    error.preserveOnError = true;
    throw error;
  }
}

async function saveHistoryToJson(/** @type {any} */ historyPath, /** @type {any} */ history) {
  history.updatedAt = new Date().toISOString();
  await ensureParentDirectory(historyPath);
  await atomicWriteFile(historyPath, JSON.stringify(history, null, 2));
}

/**
 * Load history from disk
 * @param {string} historyPath - Path to history file
 * @param {string} schemaVersion - Current schema version
 * @param {Function} createEmptyHistory - Function to create empty history
 * @param {Function} saveHistory - Function to save history
 * @param {Function} migrateHistory - Function to migrate history
 * @returns {Promise<Object>} History object
 */
async function loadHistory(
  historyPath,
  schemaVersion,
  createEmptyHistory,
  saveHistory,
  migrateHistory
) {
  if (!shouldUseSqlite()) {
    return loadHistoryFromJson(
      historyPath,
      schemaVersion,
      createEmptyHistory,
      saveHistory,
      migrateHistory
    );
  }

  try {
    const store = getSqliteStore(historyPath);
    let history;
    try {
      history = store.get(SQLITE_KEYS.history);
    } catch (error) {
      if (error?.code === 'SQLITE_CORRUPT') {
        await backupSqliteDb(historyPath, error);
      }
      throw error;
    }
    if (history === undefined || history === null) {
      history = await migrateLegacyJson(historyPath, SQLITE_KEYS.history, 'history');
    }
    if (history === undefined || history === null) {
      history = createEmptyHistory();
      store.set(SQLITE_KEYS.history, history);
      return history;
    }

    if (history.schemaVersion !== schemaVersion) {
      history = await migrateHistory(history);
      store.set(SQLITE_KEYS.history, history);
    }

    return history;
  } catch (error) {
    if (error?.code === 'HISTORY_SCHEMA_TOO_NEW') {
      // Future-version history in SQLite. Back up and reset the store
      // rather than letting the caller write over a newer schema.
      logger.warn(
        '[AnalysisHistory] SQLite history is newer than this build; backing up and starting empty',
        {
          historyVersion: error.historyVersion,
          currentVersion: error.currentVersion
        }
      );
      await backupSqliteDb(historyPath, error);
      const history = createEmptyHistory();
      try {
        const store = getSqliteStore(historyPath);
        store.set(SQLITE_KEYS.history, history);
      } catch (resetError) {
        logger.warn('[AnalysisHistory] Failed to reset SQLite history after version mismatch', {
          error: resetError.message
        });
      }
      return history;
    }
    if (
      error?.code === 'SQLITE_CORRUPT' ||
      error?.code === 'SQLITE_NOTADB' ||
      (error?.message && error.message.includes('file is not a database'))
    ) {
      await backupSqliteDb(historyPath, error);
      // Fall through to JSON fallback
    }
    if (isSqliteTransientError(error)) {
      error.transient = true;
      throw error;
    }
    logger.warn('[AnalysisHistory] SQLite loadHistory failed, falling back to JSON', {
      error: error.message
    });
    return loadHistoryFromJson(
      historyPath,
      schemaVersion,
      createEmptyHistory,
      saveHistory,
      migrateHistory
    );
  }
}

/**
 * Save history to disk
 * @param {string} historyPath - Path to history file
 * @param {Record<string, any>} history - History object
 */
async function saveHistory(historyPath, history) {
  if (!shouldUseSqlite()) {
    return saveHistoryToJson(historyPath, history);
  }
  const store = getSqliteStore(historyPath);
  history.updatedAt = new Date().toISOString();
  store.set(SQLITE_KEYS.history, history, history.updatedAt);
}

async function loadIndexFromJson(
  /** @type {any} */ indexPath,
  /** @type {any} */ createEmptyIndex,
  /** @type {any} */ saveIndex
) {
  try {
    const indexData = await fs.readFile(indexPath, 'utf8');
    return parsePersistedJson(indexData, 'analysis-history index');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const index = createEmptyIndex();
      await saveIndex(index);
      return index;
    }
    if (isTransientError(error)) {
      error.transient = true;
      throw error;
    }
    if (error instanceof SyntaxError) {
      await backupCorruptFile(indexPath, error);
      const index = createEmptyIndex();
      await saveIndex(index);
      return index;
    }
    error.preserveOnError = true;
    throw error;
  }
}

async function saveIndexToJson(/** @type {any} */ indexPath, /** @type {any} */ index) {
  index.updatedAt = new Date().toISOString();
  await ensureParentDirectory(indexPath);
  await atomicWriteFile(indexPath, JSON.stringify(index, null, 2));
}

/**
 * Load index from disk
 * @param {string} indexPath - Path to index file
 * @param {Function} createEmptyIndex - Function to create empty index
 * @param {Function} saveIndex - Function to save index
 * @returns {Promise<Object>} Index object
 */
async function loadIndex(indexPath, createEmptyIndex, saveIndex) {
  if (!shouldUseSqlite()) {
    return loadIndexFromJson(indexPath, createEmptyIndex, saveIndex);
  }

  try {
    const store = getSqliteStore(indexPath);
    let index;
    try {
      index = store.get(SQLITE_KEYS.index);
    } catch (error) {
      if (error?.code === 'SQLITE_CORRUPT') {
        await backupSqliteDb(indexPath, error);
      }
      throw error;
    }
    if (index === undefined || index === null) {
      index = await migrateLegacyJson(indexPath, SQLITE_KEYS.index, 'index');
    }
    if (index === undefined || index === null) {
      index = createEmptyIndex();
      store.set(SQLITE_KEYS.index, index);
    }
    return index;
  } catch (error) {
    if (
      error?.code === 'SQLITE_CORRUPT' ||
      error?.code === 'SQLITE_NOTADB' ||
      (error?.message && error.message.includes('file is not a database'))
    ) {
      await backupSqliteDb(indexPath, error);
      // Fall through to JSON fallback
    }
    if (isSqliteTransientError(error)) {
      error.transient = true;
      throw error;
    }
    logger.warn('[AnalysisHistory] SQLite loadIndex failed, falling back to JSON', {
      error: error.message
    });
    return loadIndexFromJson(indexPath, createEmptyIndex, saveIndex);
  }
}

/**
 * Save index to disk
 * @param {string} indexPath - Path to index file
 * @param {Record<string, any>} index - Index object
 */
async function saveIndex(indexPath, index) {
  if (!shouldUseSqlite()) {
    return saveIndexToJson(indexPath, index);
  }
  const store = getSqliteStore(indexPath);
  index.updatedAt = new Date().toISOString();
  store.set(SQLITE_KEYS.index, index, index.updatedAt);
}

/**
 * Create default structures and save to disk
 * @param {Record<string, any>} paths - Object with configPath, historyPath, indexPath
 * @param {Function} getDefaultConfig - Function to get default config
 * @param {Function} createEmptyHistory - Function to create empty history
 * @param {Function} createEmptyIndex - Function to create empty index
 * @returns {Promise<{config: Object, history: Object, index: Object}>}
 */
async function createDefaultStructures(
  paths,
  getDefaultConfig,
  createEmptyHistory,
  createEmptyIndex
) {
  const config = getDefaultConfig();
  const history = createEmptyHistory();
  const index = createEmptyIndex();

  if (shouldUseSqlite()) {
    const store = getSqliteStore(paths.configPath);
    const now = new Date().toISOString();
    config.updatedAt = now;
    history.updatedAt = now;
    index.updatedAt = now;
    store.set(SQLITE_KEYS.config, config, now);
    store.set(SQLITE_KEYS.history, history, now);
    store.set(SQLITE_KEYS.index, index, now);
  } else {
    await Promise.all([
      saveConfigToJson(paths.configPath, config),
      saveHistoryToJson(paths.historyPath, history),
      saveIndexToJson(paths.indexPath, index)
    ]);
  }

  return { config, history, index };
}

module.exports = {
  ensureParentDirectory,
  atomicWriteFile,
  loadConfig,
  saveConfig,
  loadHistory,
  saveHistory,
  loadIndex,
  saveIndex,
  createDefaultStructures,
  closeSqliteStore
};
