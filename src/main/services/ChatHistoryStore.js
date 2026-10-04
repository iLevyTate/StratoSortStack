// @ts-check
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { app } = require('electron');
const { createLogger } = require('../../shared/logger');
const { sanitizeExportText } = require('../../shared/exportRedaction');
const { createSingletonHelpers } = require('../../shared/singletonFactory');
const { createInitGuard, delay } = require('../../shared/promiseUtils');
const { TIMEOUTS } = require('../../shared/performanceConstants');
const { safeParse: safeJsonParse } = require('../../shared/safeJsonOps');
const {
  encrypt: encryptForStorage,
  decryptIfNeeded: decryptFromStorage,
  isEncryptionAvailable: isStorageEncryptionAvailable
} = require('../../shared/safeStorageEncryption');

const logger = createLogger('ChatHistoryStore');

/**
 * Maximum conversations returned by searchConversations.
 */
const SEARCH_RESULT_LIMIT = 20;

/**
 * Cap on how many of the most-recently-updated conversations are
 * scanned in the decrypt-and-filter stage of searchConversations.
 * Bounds the wall-clock cost of search at the tail (huge histories);
 * tradeoff is that searches over very old conversations may miss if
 * the user has > SEARCH_DECRYPT_SCAN_CAP newer conversations.
 * 500 covers the 99th percentile of expected histories and runs in
 * well under 100 ms on modern hardware.
 */
const SEARCH_DECRYPT_SCAN_CAP = 500;

/**
 * Per-write input size limits — DoS prevention at the persistence boundary.
 * A buggy or malicious IPC caller could otherwise persist multi-MB rows that
 * bloat the encrypted SQLite store and hurt search performance. Limits are
 * generous (AI responses commonly run to a few KB, never tens of KB) but
 * finite. Exceeding any limit throws a structured ChatHistoryValidationError
 * — we do not silently truncate, because silent truncation would corrupt
 * user-visible history without a signal.
 */
const MAX_CONVERSATION_TITLE = 512;
const MAX_MESSAGE_TEXT = 64_000;
const MAX_DOCUMENT_SCOPE_ITEMS = 200;
const MAX_DOCUMENT_SCOPE_ITEM_BYTES = 16_384;
const MAX_MESSAGE_SOURCES_ITEMS = 1_000;
const MAX_MESSAGE_FOLLOWUPS_ITEMS = 50;
const MAX_MESSAGE_PAYLOAD_BYTES = 256_000;

class ChatHistoryValidationError extends Error {
  constructor(/** @type {any} */ message, /** @type {any} */ code, metadata = {}) {
    super(message);
    this.name = 'ChatHistoryValidationError';
    this.code = code;
    this.metadata = metadata;
    this.isOperational = true;
  }
}

function _byteLength(/** @type {any} */ value) {
  if (value == null) return 0;
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

function _validateConversationInputs(/** @type {any} */ title, /** @type {any} */ documentScope) {
  if (typeof title === 'string' && title.length > MAX_CONVERSATION_TITLE) {
    throw new ChatHistoryValidationError(
      `Conversation title exceeds ${MAX_CONVERSATION_TITLE} characters`,
      'CONVERSATION_TITLE_TOO_LONG',
      { limit: MAX_CONVERSATION_TITLE, actual: title.length }
    );
  }
  if (Array.isArray(documentScope)) {
    if (documentScope.length > MAX_DOCUMENT_SCOPE_ITEMS) {
      throw new ChatHistoryValidationError(
        `Document scope exceeds ${MAX_DOCUMENT_SCOPE_ITEMS} items`,
        'DOCUMENT_SCOPE_TOO_LARGE',
        { limit: MAX_DOCUMENT_SCOPE_ITEMS, actual: documentScope.length }
      );
    }
    for (let i = 0; i < documentScope.length; i += 1) {
      const itemBytes = _byteLength(documentScope[i]);
      if (itemBytes > MAX_DOCUMENT_SCOPE_ITEM_BYTES) {
        throw new ChatHistoryValidationError(
          `Document scope item at index ${i} exceeds ${MAX_DOCUMENT_SCOPE_ITEM_BYTES} bytes`,
          'DOCUMENT_SCOPE_ITEM_TOO_LARGE',
          { index: i, limit: MAX_DOCUMENT_SCOPE_ITEM_BYTES, actual: itemBytes }
        );
      }
    }
  } else if (documentScope != null && !Array.isArray(documentScope)) {
    throw new ChatHistoryValidationError(
      'documentScope must be an array',
      'DOCUMENT_SCOPE_INVALID_TYPE',
      { received: typeof documentScope }
    );
  }
}

function _validateMessageInputs(/** @type {any} */ message) {
  if (!message || typeof message !== 'object') {
    throw new ChatHistoryValidationError('message must be an object', 'MESSAGE_INVALID_TYPE', {
      received: message === null ? 'null' : typeof message
    });
  }
  if (typeof message.text === 'string' && message.text.length > MAX_MESSAGE_TEXT) {
    throw new ChatHistoryValidationError(
      `Message text exceeds ${MAX_MESSAGE_TEXT} characters`,
      'MESSAGE_TEXT_TOO_LONG',
      { limit: MAX_MESSAGE_TEXT, actual: message.text.length }
    );
  }
  if (Array.isArray(message.sources) && message.sources.length > MAX_MESSAGE_SOURCES_ITEMS) {
    throw new ChatHistoryValidationError(
      `Message sources exceeds ${MAX_MESSAGE_SOURCES_ITEMS} items`,
      'MESSAGE_SOURCES_TOO_MANY',
      { limit: MAX_MESSAGE_SOURCES_ITEMS, actual: message.sources.length }
    );
  }
  if (Array.isArray(message.followUps) && message.followUps.length > MAX_MESSAGE_FOLLOWUPS_ITEMS) {
    throw new ChatHistoryValidationError(
      `Message followUps exceeds ${MAX_MESSAGE_FOLLOWUPS_ITEMS} items`,
      'MESSAGE_FOLLOWUPS_TOO_MANY',
      { limit: MAX_MESSAGE_FOLLOWUPS_ITEMS, actual: message.followUps.length }
    );
  }
  const totalBytes =
    _byteLength(message.text) +
    _byteLength(message.documentAnswer) +
    _byteLength(message.modelAnswer) +
    _byteLength(message.sources) +
    _byteLength(message.followUps) +
    _byteLength(message.meta);
  if (totalBytes > MAX_MESSAGE_PAYLOAD_BYTES) {
    throw new ChatHistoryValidationError(
      `Message payload exceeds ${MAX_MESSAGE_PAYLOAD_BYTES} bytes total (text + answers + sources + followUps + meta)`,
      'MESSAGE_PAYLOAD_TOO_LARGE',
      { limit: MAX_MESSAGE_PAYLOAD_BYTES, actual: totalBytes }
    );
  }
}

/**
 * Wrap a JSON.stringify call in safeStorage encryption when the
 * platform supports it. Pass-through to plain JSON when the platform
 * can't encrypt (Linux without keychain, test envs without override).
 *
 * Encrypted output uses the `sse:v1:` marker, so reads can detect
 * which path produced each row and decrypt selectively. This makes
 * the rollout naturally lazy — pre-existing plain rows remain readable
 * after this change ships, and new writes are encrypted without a
 * forced migration step.
 *
 * @param {*} payload - Any JSON-serializable value.
 * @returns {string} Either plain JSON or the encrypted-payload marker.
 * @private
 */
function _encryptJsonPayload(payload) {
  const json = JSON.stringify(payload);
  if (!isStorageEncryptionAvailable()) return json;
  return encryptForStorage(json);
}

/**
 * Read a column that may be either plain JSON (legacy) or encrypted
 * (post-encryption-rollout). Decrypts via marker detection, then
 * delegates to safeJsonParse for prototype-pollution-safe parsing.
 *
 * @param {string} raw - Column value from SQLite.
 * @param {*} fallback - Value to return on parse failure.
 * @returns {*}
 * @private
 */
function _decryptJsonPayload(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const decrypted = decryptFromStorage(raw);
  return safeJsonParse(decrypted || JSON.stringify(fallback), fallback);
}

function parseDocumentScope(/** @type {any} */ raw) {
  // Row originates from SQLite on disk; strip `__proto__`/`constructor`/
  // `prototype` keys on parse in case a faulty writer injected them.
  return _decryptJsonPayload(raw, []);
}

/**
 * SQLite result codes that describe a file briefly held by something else
 * (antivirus, backup tooling, a second process finishing a checkpoint), not
 * a broken database. One failed open on these used to disable chat for the
 * rest of the session even though the next attempt would have succeeded.
 */
const TRANSIENT_OPEN_CODES = Object.freeze(
  new Set(['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_CANTOPEN'])
);
const DEFAULT_OPEN_RETRY_DELAYS_MS = Object.freeze([250, 500, 1000]);

class ChatHistoryStore {
  constructor() {
    this._db = null;
    /** @type {number[]} Backoff between open attempts; tests shorten it. */
    this._openRetryDelaysMs = [...DEFAULT_OPEN_RETRY_DELAYS_MS];
    this._initGuard = createInitGuard('ChatHistoryStore');
    this._hasMetaColumn = false;
    this._hasSortOrderColumn = false;
    this._conversationCache = new Map();
    this._conversationCacheLimit = 20;
  }

  get _initialized() {
    return this._initGuard.isInitialized();
  }

  async initialize() {
    return this._initGuard.initialize(async () => {
      const userDataPath = app.getPath('userData');
      const dbPath = path.join(userDataPath, 'chat_history.db');

      // Ensure directory exists — mkdir with recursive:true is idempotent
      const dir = path.dirname(dbPath);
      await fs.promises.mkdir(dir, { recursive: true });

      try {
        await this._openWithRetry(dbPath);
      } catch (openError) {
        // Corruption recovery (mirrors AnalysisHistory's quarantine-and-recreate
        // policy): a corrupt chat db must not brick the chat feature for the
        // rest of the install's lifetime. Quarantine the bad file so the user
        // can recover it manually, then start fresh.
        if (!this._isCorruptionError(openError)) throw openError;
        logger.error('[ChatHistoryStore] Database corrupt; quarantining and recreating', {
          dbPath,
          error: openError?.message
        });
        await this._quarantineCorruptDb(dbPath, openError);
        this._openAndMigrate(dbPath);
      }
      logger.info('Chat history database initialized', { path: dbPath });
    });
  }

  /**
   * Open the SQLite handle, apply pragmas, and run migrations. Split out of
   * initialize() so the corruption-recovery path can re-run it after
   * quarantining a corrupt file.
   * @private
   */
  _openAndMigrate(/** @type {any} */ dbPath) {
    this._db = new Database(dbPath, { timeout: TIMEOUTS.HEALTH_CHECK });
    // Align pragmas with `src/main/utils/sqliteStore.js` so the chat-history
    // store shares the same durability / concurrency / FK guarantees.
    try {
      this._db.pragma('journal_mode = WAL');
      this._db.pragma('synchronous = NORMAL');
      this._db.pragma(`busy_timeout = ${TIMEOUTS.HEALTH_CHECK}`);
      this._db.pragma('foreign_keys = ON');
    } catch (pragmaError) {
      logger.debug('[ChatHistoryStore] Failed to apply pragmas', {
        error: pragmaError?.message
      });
    }
    this._migrate();
  }

  /**
   * Open with a short backoff on transient result codes, then give up with
   * the last error so the corruption path (or the caller) can decide.
   * @private
   * @param {string} dbPath
   */
  async _openWithRetry(dbPath) {
    const delays = Array.isArray(this._openRetryDelaysMs) ? this._openRetryDelaysMs : [];
    for (let attempt = 0; ; attempt++) {
      try {
        this._openAndMigrate(dbPath);
        return;
      } catch (error) {
        if (!this._isTransientOpenError(error) || attempt >= delays.length) throw error;
        this._closeQuietly();
        logger.warn('[ChatHistoryStore] Transient open failure; retrying', {
          dbPath,
          code: error?.code,
          attempt: attempt + 1,
          remaining: delays.length - attempt,
          delayMs: delays[attempt]
        });
        await delay(delays[attempt]);
      }
    }
  }

  /** @private */
  _isTransientOpenError(/** @type {any} */ error) {
    return TRANSIENT_OPEN_CODES.has(String(error?.code || ''));
  }

  /** @private */
  _closeQuietly() {
    try {
      this._db?.close();
    } catch {
      /* handle may already be unusable */
    }
    this._db = null;
  }

  /** @private */
  _isCorruptionError(/** @type {any} */ error) {
    const code = String(error?.code || '');
    // Deliberately NOT SQLITE_CANTOPEN: that code covers transient open
    // failures (file briefly locked by AV/backup tooling, permission
    // hiccup), and quarantining on it would rename a perfectly healthy
    // chat history aside — silently wiping the user's conversations over
    // a one-off lock. Only true corruption signals trigger recovery.
    return code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB';
  }

  /**
   * Move a corrupt database (and its WAL/SHM sidecars) aside so a fresh one
   * can be created. Best-effort: a failed rename falls back to unlink so the
   * recreate still proceeds.
   * @private
   */
  async _quarantineCorruptDb(/** @type {any} */ dbPath, /** @type {any} */ reason) {
    try {
      this._db?.close();
    } catch {
      /* handle may already be unusable */
    }
    this._db = null;
    const suffix = `.corrupt.${Date.now()}`;
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        await fs.promises.rename(file, `${file}${suffix}`);
      } catch (renameError) {
        if (renameError?.code === 'ENOENT') continue;
        try {
          await fs.promises.unlink(file);
        } catch {
          /* leave it; Database() open below will surface a hard failure */
        }
      }
    }
    logger.warn('[ChatHistoryStore] Quarantined corrupt chat database', {
      dbPath,
      suffix,
      reason: reason?.message || String(reason)
    });
  }

  /**
   * Schema target version. Bump alongside a new entry in `_getMigrations()`.
   */
  static get SCHEMA_VERSION() {
    return 2;
  }

  _getMigrations() {
    // v1 → v2: `meta` + `sort_order` columns + composite index on
    // (conversation_id, sort_order). Kept idempotent via `table_info()`
    // probes so upgrades from any prior ad-hoc state converge cleanly.
    return [
      {
        target: 1,
        migrate: (/** @type {any} */ db) => {
          db.exec(`
            CREATE TABLE IF NOT EXISTS conversations (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL DEFAULT '',
              document_scope TEXT DEFAULT '[]',
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS messages (
              id TEXT PRIMARY KEY,
              conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
              role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
              text TEXT NOT NULL DEFAULT '',
              document_answer TEXT DEFAULT '[]',
              model_answer TEXT DEFAULT '[]',
              sources TEXT DEFAULT '[]',
              follow_ups TEXT DEFAULT '[]',
              created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
          `);
        }
      },
      {
        target: 2,
        migrate: (/** @type {any} */ db) => {
          const columns = db.pragma('table_info(messages)');
          if (!columns.some((/** @type {any} */ col) => col.name === 'meta')) {
            db.exec(`ALTER TABLE messages ADD COLUMN meta TEXT DEFAULT '{}'`);
          }
          if (!columns.some((/** @type {any} */ col) => col.name === 'sort_order')) {
            db.exec(`ALTER TABLE messages ADD COLUMN sort_order INTEGER DEFAULT 0`);
          }
          db.exec(
            `CREATE INDEX IF NOT EXISTS idx_messages_conv_sort ON messages(conversation_id, sort_order)`
          );
        }
      }
    ];
  }

  _migrate() {
    const db = this._db;
    const currentVersion = Number(db.pragma('user_version', { simple: true }) || 0);
    const migrations = this._getMigrations();

    for (const { target, migrate } of migrations) {
      if (currentVersion >= target) continue;
      const tx = db.transaction(() => {
        migrate(db);
        db.pragma(`user_version = ${target}`);
      });
      try {
        tx();
      } catch (migrateErr) {
        // Fail loud: we used to silently demote `_hasMetaColumn` /
        // `_hasSortOrderColumn` on any error, which kept the service running
        // against a schema it didn't match. Surface the failure instead so
        // callers see `ChatHistoryStore not initialized` rather than silent
        // data corruption.
        logger.error('[ChatHistoryStore] Migration failed', {
          target,
          error: migrateErr?.message
        });
        throw migrateErr;
      }
    }

    // Feature-flag probe remains so older-running code paths can branch on
    // column presence without a second schema lookup per call.
    const columns = db.pragma('table_info(messages)');
    this._hasMetaColumn = columns.some((/** @type {any} */ col) => col.name === 'meta');
    this._hasSortOrderColumn = columns.some((/** @type {any} */ col) => col.name === 'sort_order');
  }

  createConversation(
    title = 'New Conversation',
    /** @type {any} */ documentScope = [],
    /** @type {any} */ id = null
  ) {
    this._checkInit();
    _validateConversationInputs(title, documentScope);
    const finalId = id || crypto.randomUUID();
    const stmt = this._db.prepare(`
      INSERT INTO conversations (id, title, document_scope)
      VALUES (?, ?, ?)
    `);
    stmt.run(finalId, title, _encryptJsonPayload(documentScope));
    this._invalidateConversationCache(finalId);
    return { id: finalId, title, documentScope, createdAt: new Date().toISOString() };
  }

  getConversation(/** @type {any} */ id) {
    this._checkInit();
    const conv = this._db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    if (!conv) {
      this._invalidateConversationCache(id);
      return null;
    }

    const cached = this._conversationCache.get(id);
    if (cached && cached.updatedAt === conv.updated_at) {
      this._touchConversationCacheEntry(id, cached);
      return cached.value;
    }

    const messages = this._hasSortOrderColumn
      ? this._db
          .prepare(
            `SELECT * FROM messages WHERE conversation_id = ? ORDER BY sort_order ASC, created_at ASC`
          )
          .all(id)
      : this._db
          .prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`)
          .all(id);

    const parsed = {
      id: conv.id,
      title: conv.title,
      documentScope: parseDocumentScope(conv.document_scope),
      createdAt: conv.created_at,
      updatedAt: conv.updated_at,
      messages: messages.map(this._parseMessage)
    };
    this._setConversationCache(id, conv.updated_at, parsed);
    return parsed;
  }

  listConversations(limit = 50, offset = 0) {
    this._checkInit();
    const rows = this._db
      .prepare(
        `
      SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ? OFFSET ?
    `
      )
      .all(limit, offset);

    return rows.map((/** @type {any} */ row) => ({
      id: row.id,
      title: row.title,
      documentScope: parseDocumentScope(row.document_scope),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  addMessage(/** @type {any} */ conversationId, /** @type {any} */ message) {
    this._checkInit();
    _validateMessageInputs(message);
    const id = message.id || crypto.randomUUID();
    const nextSortOrder = this._hasSortOrderColumn
      ? (this._db
          .prepare(
            'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM messages WHERE conversation_id = ?'
          )
          .get(conversationId)?.max_order || 0) + 1
      : null;

    if (this._hasMetaColumn && this._hasSortOrderColumn) {
      const stmt = this._db.prepare(`
        INSERT INTO messages (
          id, conversation_id, role, text,
          document_answer, model_answer, sources, follow_ups, sort_order, meta
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        id,
        conversationId,
        message.role,
        message.text || '',
        _encryptJsonPayload(message.documentAnswer || []),
        _encryptJsonPayload(message.modelAnswer || []),
        _encryptJsonPayload(message.sources || []),
        _encryptJsonPayload(message.followUps || []),
        nextSortOrder,
        _encryptJsonPayload(message.meta || {})
      );
    } else if (this._hasMetaColumn) {
      const stmt = this._db.prepare(`
        INSERT INTO messages (
          id, conversation_id, role, text,
          document_answer, model_answer, sources, follow_ups, meta
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        id,
        conversationId,
        message.role,
        message.text || '',
        _encryptJsonPayload(message.documentAnswer || []),
        _encryptJsonPayload(message.modelAnswer || []),
        _encryptJsonPayload(message.sources || []),
        _encryptJsonPayload(message.followUps || []),
        _encryptJsonPayload(message.meta || {})
      );
    } else if (this._hasSortOrderColumn) {
      const stmt = this._db.prepare(`
        INSERT INTO messages (
          id, conversation_id, role, text,
          document_answer, model_answer, sources, follow_ups, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        id,
        conversationId,
        message.role,
        message.text || '',
        _encryptJsonPayload(message.documentAnswer || []),
        _encryptJsonPayload(message.modelAnswer || []),
        _encryptJsonPayload(message.sources || []),
        _encryptJsonPayload(message.followUps || []),
        nextSortOrder
      );
    } else {
      const stmt = this._db.prepare(`
        INSERT INTO messages (
          id, conversation_id, role, text,
          document_answer, model_answer, sources, follow_ups
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        id,
        conversationId,
        message.role,
        message.text || '',
        _encryptJsonPayload(message.documentAnswer || []),
        _encryptJsonPayload(message.modelAnswer || []),
        _encryptJsonPayload(message.sources || []),
        _encryptJsonPayload(message.followUps || [])
      );
    }

    // Update conversation timestamp
    this._db
      .prepare(
        `
      UPDATE conversations SET updated_at = datetime('now') WHERE id = ?
    `
      )
      .run(conversationId);
    this._invalidateConversationCache(conversationId);

    return { id, ...message };
  }

  deleteConversation(/** @type {any} */ id) {
    this._checkInit();
    this._db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    this._invalidateConversationCache(id);
  }

  /**
   * Search conversations by free-text query. The encryption rollout
   * (this PR) made on-disk columns ciphertext, which means SQL LIKE
   * matching against `document_answer` and `model_answer` is useless
   * for new rows (LIKE on ciphertext can't possibly match the
   * plaintext query term).
   *
   * To preserve search across the AI's responses without giving up
   * encryption, we split into two stages:
   *
   *   1. SQL stage — LIKE on PLAIN columns (`messages.text`,
   *      `conversations.title`). Fast, no decryption. Covers the
   *      most common case (user searching for terms they typed).
   *
   *   2. Decrypt-and-scan stage — for the most-recently-updated
   *      conversations NOT already matched by stage 1, fetch their
   *      messages, decrypt the JSON payload columns in memory,
   *      stringify, and substring-match against the query. Bounded
   *      at SEARCH_DECRYPT_SCAN_CAP candidate conversations so cost
   *      stays sublinear in total history size for typical users.
   *
   * Results from both stages are merged, deduped, sorted by
   * updated_at DESC, and capped at SEARCH_RESULT_LIMIT.
   *
   * Trade-off the previous implementation accepted (LIKE-against-
   * encrypted-columns silently misses) is gone — encryption no
   * longer interferes with search.
   *
   * @param {string} query
   * @returns {Array<{id: string, title: string, documentScope: any[], createdAt: string, updatedAt: string}>}
   */
  /**
   * @typedef {Object} ChatHistorySearchResult
   * @property {Array<{id: string, title: string, documentScope: any[], createdAt: string, updatedAt: string}>} items
   * @property {boolean} capped - true when stage 2 hit SEARCH_DECRYPT_SCAN_CAP
   *           and the total history exceeds it. When true, matches that live
   *           in encrypted columns of conversations OLDER than the most-recent
   *           SEARCH_DECRYPT_SCAN_CAP are not searched. The renderer should
   *           surface this so users know "showing recent N" is a deliberate
   *           bound, not a "no results" verdict on their full history.
   * @property {number} capLimit - the SEARCH_DECRYPT_SCAN_CAP value used
   * @property {number} scannedCount - actual rows scanned in stage 2
   */
  /**
   * @param {string} query
   * @returns {ChatHistorySearchResult}
   */
  searchConversations(query) {
    this._checkInit();
    if (typeof query !== 'string' || !query.trim()) {
      return { items: [], capped: false, capLimit: SEARCH_DECRYPT_SCAN_CAP, scannedCount: 0 };
    }

    // Escape LIKE special characters to prevent unintended wildcard matching
    const escapedQuery = query.replace(/[%_]/g, '\\$&');
    const pattern = `%${escapedQuery}%`;

    // Stage 1: fast SQL search on plain columns only.
    const sqlRows = this._db
      .prepare(
        `
      SELECT DISTINCT c.*
      FROM conversations c
      JOIN messages m ON c.id = m.conversation_id
      WHERE m.text LIKE ? ESCAPE '\\'
         OR c.title LIKE ? ESCAPE '\\'
      ORDER BY c.updated_at DESC
      LIMIT ${SEARCH_RESULT_LIMIT}
    `
      )
      .all(pattern, pattern);

    const matched = new Map();
    for (const row of sqlRows) matched.set(row.id, row);
    if (matched.size >= SEARCH_RESULT_LIMIT) {
      return {
        items: this._formatSearchResults(matched),
        capped: false,
        capLimit: SEARCH_DECRYPT_SCAN_CAP,
        scannedCount: 0
      };
    }

    // Stage 2: decrypt-and-scan over the most-recently-updated
    // conversations not yet matched. We bound this at
    // SEARCH_DECRYPT_SCAN_CAP rows so the wall-clock cost is
    // predictable on large histories. The 500-row default scans
    // ~5 MB of JSON+ciphertext per search on a typical user's data
    // — comfortably under 100 ms on a modern machine.
    const remaining = SEARCH_RESULT_LIMIT - matched.size;
    const candidateRows = this._db
      .prepare(
        `
      SELECT * FROM conversations
      ORDER BY updated_at DESC
      LIMIT ${SEARCH_DECRYPT_SCAN_CAP}
    `
      )
      .all();

    // The conversations table count gives us the "is the cap actually
    // binding?" signal. Cheap (single COUNT on indexed table) and avoids
    // false-positive "capped" notices for users with < 500 conversations.
    const totalCountRow = this._db.prepare('SELECT COUNT(*) AS n FROM conversations').get();
    const totalConversations = Number(totalCountRow?.n || 0);
    const capped = totalConversations > SEARCH_DECRYPT_SCAN_CAP;

    const needle = query.toLowerCase();
    const messageStmt = this._db.prepare(
      `SELECT document_answer, model_answer, meta FROM messages WHERE conversation_id = ?`
    );

    let added = 0;
    for (const conv of candidateRows) {
      if (added >= remaining) break;
      if (matched.has(conv.id)) continue;

      const msgs = messageStmt.all(conv.id);
      let convMatched = false;
      for (const m of msgs) {
        if (this._messageMatchesNeedle(m, needle)) {
          convMatched = true;
          break;
        }
      }
      if (convMatched) {
        matched.set(conv.id, conv);
        added += 1;
      }
    }

    return {
      items: this._formatSearchResults(matched),
      capped,
      capLimit: SEARCH_DECRYPT_SCAN_CAP,
      scannedCount: candidateRows.length
    };
  }

  /**
   * Decrypt one message row's JSON columns and check whether the
   * lowercase needle appears in any of them. Stops as soon as it
   * finds a hit; the JSON.stringify pass over each payload only runs
   * if the previous payloads didn't match. Encrypted-but-empty
   * decrypts (cross-machine handoff, corrupt ciphertext) return ''
   * which contains no needles, so the search just skips them.
   * @private
   */
  _messageMatchesNeedle(/** @type {any} */ row, /** @type {any} */ needle) {
    if (!row || !needle) return false;
    const sources = [row.document_answer, row.model_answer, row.meta];
    for (const raw of sources) {
      if (raw == null || raw === '') continue;
      const plain = decryptFromStorage(raw);
      if (!plain) continue;
      if (plain.toLowerCase().includes(needle)) return true;
    }
    return false;
  }

  /**
   * Convert the matched-row Map into the wire shape, preserving
   * updated_at-DESC ordering and applying SEARCH_RESULT_LIMIT.
   * @private
   */
  _formatSearchResults(/** @type {any} */ matched) {
    const rows = Array.from(matched.values());
    rows.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return rows.slice(0, SEARCH_RESULT_LIMIT).map((row) => ({
      id: row.id,
      title: row.title,
      documentScope: parseDocumentScope(row.document_scope),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  _parseMessage(/** @type {any} */ row) {
    // Row values live in SQLite on disk. _decryptJsonPayload handles both
    // pre-encryption plain rows AND new sse:v1: encrypted rows by
    // detecting the marker prefix — so a database with mixed plain and
    // encrypted rows (e.g. after the encryption rollout) reads back
    // identically. safeJsonParse downstream guarantees
    // prototype-pollution-safe parsing.
    return {
      id: row.id,
      role: row.role,
      text: row.text,
      documentAnswer: _decryptJsonPayload(row.document_answer, []),
      modelAnswer: _decryptJsonPayload(row.model_answer, []),
      sources: _decryptJsonPayload(row.sources, []),
      followUps: _decryptJsonPayload(row.follow_ups, []),
      meta: _decryptJsonPayload(row.meta, {}),
      createdAt: row.created_at
    };
  }

  _checkInit() {
    if (!this._initialized) throw new Error('ChatHistoryStore not initialized');
  }

  /**
   * Update the title of an existing conversation.
   * Used to replace the default "New Chat" title with a more descriptive one
   * derived from the first query/response exchange.
   * @param {string} conversationId
   * @param {string} title
   */
  updateTitle(conversationId, title) {
    this._checkInit();
    this._db
      .prepare("UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?")
      .run(title, conversationId);
    this._invalidateConversationCache(conversationId);
  }

  /**
   * Persist a changed document scope on an existing conversation. Without
   * this, scope is only written at createConversation time, so a scope
   * changed mid-conversation reverts to the original on reload.
   * @param {string} conversationId
   * @param {Array<any>} documentScope
   */
  updateDocumentScope(conversationId, documentScope) {
    this._checkInit();
    this._db
      .prepare(
        "UPDATE conversations SET document_scope = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .run(_encryptJsonPayload(Array.isArray(documentScope) ? documentScope : []), conversationId);
    this._invalidateConversationCache(conversationId);
  }

  exportAsMarkdown(/** @type {any} */ conversationId) {
    this._checkInit();
    const conv = this.getConversation(conversationId);
    if (!conv) return null;

    const lines = [`# ${conv.title || 'Conversation'}\n`];
    lines.push(`*Exported: ${new Date().toISOString()}*\n`);

    for (const msg of conv.messages || []) {
      const role = msg.role === 'user' ? '**You**' : '**StratoSort**';
      lines.push(`\n## ${role}\n`);

      if (msg.documentAnswer?.length > 0) {
        for (const doc of msg.documentAnswer) {
          if (doc.text) lines.push(doc.text + '\n');
        }
      }
      if (msg.modelAnswer?.length > 0) {
        for (const model of msg.modelAnswer) {
          if (model.text) lines.push(model.text + '\n');
        }
      }
      if (!msg.documentAnswer?.length && !msg.modelAnswer?.length && msg.text) {
        lines.push(msg.text + '\n');
      }
      if (msg.sources?.length > 0) {
        lines.push('\n**Sources:**\n');
        for (const src of msg.sources) {
          lines.push(
            `- [${src.id}] ${src.name || src.fileId}${src.path ? ` (${src.path})` : ''}\n`
          );
        }
      }
    }
    return sanitizeExportText(lines.join(''));
  }

  shutdown() {
    this._initGuard.reset();
    if (this._db) {
      // Truncate the WAL file before close so the on-disk database has all
      // committed writes in the main db file, not pending in the journal.
      // Without this, abrupt kills during the interval between close() and
      // the OS flushing the WAL can leave users with a large `*.db-wal`
      // file that the next launch has to checkpoint before reads work.
      try {
        this._db.pragma('wal_checkpoint(TRUNCATE)');
      } catch (checkpointError) {
        logger.debug('[ChatHistory] WAL checkpoint failed on close', {
          error: checkpointError.message
        });
      }
      this._db.close();
      this._db = null;
      this._hasMetaColumn = false;
      this._hasSortOrderColumn = false;
      this._conversationCache.clear();
    }
  }

  _setConversationCache(
    /** @type {any} */ id,
    /** @type {any} */ updatedAt,
    /** @type {any} */ value
  ) {
    if (!id) return;
    if (this._conversationCache.has(id)) {
      this._conversationCache.delete(id);
    }
    this._conversationCache.set(id, { updatedAt, value });
    if (this._conversationCache.size > this._conversationCacheLimit) {
      const oldestKey = this._conversationCache.keys().next().value;
      if (oldestKey) this._conversationCache.delete(oldestKey);
    }
  }

  _touchConversationCacheEntry(/** @type {any} */ id, /** @type {any} */ entry) {
    this._conversationCache.delete(id);
    this._conversationCache.set(id, entry);
  }

  _invalidateConversationCache(/** @type {any} */ id) {
    if (!id) return;
    this._conversationCache.delete(id);
  }
}

// Singleton export
const { getInstance, createInstance, registerWithContainer, resetInstance } =
  createSingletonHelpers({
    ServiceClass: ChatHistoryStore,
    serviceId: 'CHAT_HISTORY_STORE',
    serviceName: 'ChatHistoryStore',
    getContainer: () => require('./ServiceContainer'),
    shutdownMethod: 'shutdown'
  });

module.exports = {
  ChatHistoryStore,
  ChatHistoryValidationError,
  CHAT_HISTORY_LIMITS: Object.freeze({
    MAX_CONVERSATION_TITLE,
    MAX_MESSAGE_TEXT,
    MAX_DOCUMENT_SCOPE_ITEMS,
    MAX_DOCUMENT_SCOPE_ITEM_BYTES,
    MAX_MESSAGE_SOURCES_ITEMS,
    MAX_MESSAGE_FOLLOWUPS_ITEMS,
    MAX_MESSAGE_PAYLOAD_BYTES
  }),
  getInstance,
  createInstance,
  registerWithContainer,
  resetInstance
};
