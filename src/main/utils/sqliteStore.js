// @ts-check
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('SqliteStore');

const dbCache = new Map();
const storeCache = new Map();

const SQLITE_TRANSIENT_ERRORS = new Set([
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_IOERR',
  'SQLITE_CANTOPEN',
  'SQLITE_PROTOCOL',
  'SQLITE_CORRUPT'
]);

/** @param {string} backendName */
function shouldUseSqliteBackend(backendName) {
  const normalized = String(backendName || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_');
  const explicit = process.env[`STRATOSORT_${normalized}_BACKEND`];
  if (explicit) {
    return explicit.toLowerCase() === 'sqlite';
  }
  const global = process.env.STRATOSORT_PERSISTENCE_BACKEND;
  if (global) {
    return global.toLowerCase() === 'sqlite';
  }
  if (process.env.JEST_WORKER_ID || process.env.NODE_ENV === 'test') {
    return false;
  }
  return true;
}

/** @param {any} error */
function isSqliteTransientError(error) {
  return Boolean(error?.code && SQLITE_TRANSIENT_ERRORS.has(error.code));
}

/**
 * @param {string} dbPath
 * @param {{ timeoutMs?: number, busyTimeoutMs?: number }} [options]
 */
function getDatabase(dbPath, options = {}) {
  if (dbCache.has(dbPath)) {
    const cached = dbCache.get(dbPath);
    cached.refCount += 1;
    return cached.db;
  }

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (error) {
    logger.error('[SqliteStore] Failed to load better-sqlite3', { error: error.message });
    throw error;
  }

  const db = new Database(dbPath, {
    timeout: options.timeoutMs || 5000
  });

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma(`busy_timeout = ${options.busyTimeoutMs || 5000}`);
    db.pragma('foreign_keys = ON');
  } catch (pragmaError) {
    // warn (not debug): WAL is part of the crash-safety story for analysis
    // history and embedding queue. If it failed (filesystem unsupported,
    // EACCES on the DB file's directory, locked by another process), the
    // DB still works in default rollback-journal mode but durability and
    // concurrency characteristics differ. Failing-loud here would break
    // any test env where WAL isn't available; surfacing the warning lets
    // an operator notice the degraded mode in default-level logs.
    logger.warn('[SqliteStore] Failed to apply pragmas; continuing in default mode', {
      dbPath,
      error: pragmaError.message
    });
  }

  dbCache.set(dbPath, { db, refCount: 1 });
  return db;
}

/** @param {string} dbPath */
function releaseDatabase(dbPath) {
  const cached = dbCache.get(dbPath);
  if (!cached) return;
  cached.refCount -= 1;
  if (cached.refCount <= 0) {
    // Force a WAL checkpoint before close. When sqlite opens a database in
    // WAL mode, uncommitted frames accumulate in `*.db-wal`; without an
    // explicit checkpoint, those frames stay on disk even after close and
    // can leave a very large WAL file behind on crash-style shutdowns.
    // TRUNCATE also resets the WAL file to zero bytes so the next launch
    // starts clean (faster open, smaller footprint on backup). Failures here
    // are non-fatal — the subsequent close() still flushes what it can.
    try {
      cached.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (checkpointError) {
      logger.debug('[SqliteStore] WAL checkpoint failed on close', {
        dbPath,
        error: checkpointError.message
      });
    }
    try {
      cached.db.close();
    } catch (error) {
      logger.debug('[SqliteStore] Failed to close database', { error: error.message });
    }
    dbCache.delete(dbPath);
  }
}

/**
 * @param {{ dbPath: string, tableName?: string, timeoutMs?: number, busyTimeoutMs?: number, serialize?: Function, deserialize?: Function }} options
 */
function createKeyValueStore(options) {
  const {
    dbPath,
    tableName = 'kv',
    timeoutMs = 5000,
    busyTimeoutMs = 5000,
    serialize,
    deserialize
  } = options;

  if (!dbPath) {
    throw new Error('SqliteStore: dbPath is required');
  }

  // Validate tableName: it's interpolated directly into CREATE TABLE / SELECT
  // / INSERT / DELETE strings below (parameterized values, not identifiers).
  // All current callers pass static literals, but rejecting non-identifier
  // input here closes the foot-gun against any future caller that threads
  // user input through this argument.
  if (typeof tableName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error(
      `SqliteStore: tableName must be a SQL identifier ([A-Za-z_][A-Za-z0-9_]*); got: ${String(tableName)}`
    );
  }

  const cacheKey = `${dbPath}::${tableName}`;
  if (storeCache.has(cacheKey)) {
    return storeCache.get(cacheKey);
  }

  const db = getDatabase(dbPath, { timeoutMs, busyTimeoutMs });

  db.prepare(
    `CREATE TABLE IF NOT EXISTS ${tableName} (
      key TEXT PRIMARY KEY,
      value BLOB NOT NULL,
      updatedAt TEXT NOT NULL
    )`
  ).run();

  let getStmt = db.prepare(`SELECT value FROM ${tableName} WHERE key = ?`);
  let setStmt = db.prepare(
    `INSERT INTO ${tableName} (key, value, updatedAt)
     VALUES (@key, @value, @updatedAt)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`
  );
  let deleteStmt = db.prepare(`DELETE FROM ${tableName} WHERE key = ?`);

  const encode = serialize
    ? serialize
    : (/** @type {any} */ value) => Buffer.from(JSON.stringify(value), 'utf8');
  const decode = deserialize
    ? deserialize
    : (/** @type {any} */ raw) => {
        if (raw === null || raw === undefined) return undefined;
        const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
        try {
          return JSON.parse(text);
        } catch (err) {
          logger.warn('[SqliteStore] Corrupt JSON value for key decode', {
            error: err?.message || String(err)
          });
          return undefined;
        }
      };

  let closed = false;

  const store = {
    /** @param {string} key */
    get(key) {
      if (closed) throw new Error('Store is closed');
      const row = /** @type {any} */ (getStmt.get(key));
      if (!row) return undefined;
      return decode(row.value);
    },
    /**
     * @param {string} key
     * @param {any} value
     * @param {string} [updatedAt]
     */
    set(key, value, updatedAt = new Date().toISOString()) {
      if (closed) throw new Error('Store is closed');
      const payload = encode(value);
      setStmt.run({ key, value: payload, updatedAt });
    },
    /** @param {string} key */
    delete(key) {
      if (closed) throw new Error('Store is closed');
      deleteStmt.run(key);
    },
    close() {
      if (closed) return;
      closed = true;
      releaseDatabase(dbPath);
      storeCache.delete(cacheKey);
      // Release references to help GC
      getStmt = null;
      setStmt = null;
      deleteStmt = null;
    }
  };

  storeCache.set(cacheKey, store);
  return store;
}

module.exports = {
  createKeyValueStore,
  shouldUseSqliteBackend,
  isSqliteTransientError
};
