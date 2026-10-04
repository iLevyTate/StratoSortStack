// @ts-check
/**
 * McpServerLifecycleService — manages the local Model Context Protocol
 * server (start/stop, port binding, token persistence).
 *
 * The MCP SDK + @hono/node-server are loaded lazily inside
 * `_startHttpServer` rather than at module top so the whole transitive
 * graph stays out of cold-start when a user never enables MCP. The
 * server token is stored encrypted via `safeStorage` when available,
 * with a plain-file fallback only at first run before encryption is
 * ready; a sidecar marker records which mode was used so a later flip in
 * encryption availability can't misread the file. Port resolution is
 * strict — out-of-range or non-integer values for `STRATOSORT_MCP_PORT`
 * log a warning and fall back to the default instead of failing later
 * with a cryptic EACCES.
 */
'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { safeStorage, app } = require('electron');
const { withTimeout } = require('../../shared/promiseUtils');
const { readEncryptionMarker, serializeEncryptionMarker } = require('./encryptionMarker');

const TOKEN_FILENAME = 'mcp-token.bin';
const TOKEN_MARKER_FILENAME = 'mcp-token.enc';
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
// Bounds disable() so a transport close that never settles can't wedge the
// lifecycle mutex for the rest of the process.
const HTTP_CLOSE_TIMEOUT_MS = 10_000;
const DEFAULT_MCP_PORT = 53827;
const MIN_USER_PORT = 1024;
const MAX_USER_PORT = 65535;

function _generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Write-to-temp then rename, mode 0o600 from creation.
 * @param {string} file
 * @param {Buffer | string} data
 */
async function _writeFileAtomic(file, data) {
  const tempFile = `${file}.tmp`;
  let handle;
  try {
    handle = await fs.promises.open(tempFile, 'w', 0o600);
    await handle.writeFile(data);
    try {
      await handle.sync();
    } catch {
      /* ignore */
    }
    await handle.close();
    handle = null;
    try {
      await fs.promises.chmod(tempFile, 0o600);
    } catch {
      /* Windows: noop */
    }
    await fs.promises.rename(tempFile, file);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(tempFile).catch(() => {});
    throw err;
  }
}

// Validate STRATOSORT_MCP_PORT instead of `parseInt('80extra', 10) || default`,
// which silently accepted privileged ports (failing later with cryptic
// EACCES) and out-of-range values. We require a strict integer in the
// unprivileged user-port range; anything else falls back to the default
// with a logged warning so operators notice the misconfiguration.
function _resolveMcpPort(/** @type {any} */ rawValue, /** @type {any} */ logger) {
  if (rawValue === undefined || rawValue === '') return DEFAULT_MCP_PORT;
  const trimmed = String(rawValue).trim();
  if (!/^\d+$/.test(trimmed)) {
    logger?.warn?.('[mcp] STRATOSORT_MCP_PORT is not a number; using default', {
      value: trimmed
    });
    return DEFAULT_MCP_PORT;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < MIN_USER_PORT || parsed > MAX_USER_PORT) {
    logger?.warn?.('[mcp] STRATOSORT_MCP_PORT out of range; using default', {
      value: trimmed,
      min: MIN_USER_PORT,
      max: MAX_USER_PORT
    });
    return DEFAULT_MCP_PORT;
  }
  return parsed;
}

class McpServerLifecycleService extends EventEmitter {
  /** @param {{ services?: any, logger?: any }} [deps] */
  constructor({ services, logger } = {}) {
    super();
    this._services = services || {};
    this._logger = logger || console;
    this._status = 'stopped';
    /** @type {number|null} */
    this._port = null;
    /** @type {string|null} */
    this._token = null;
    /** @type {any} */
    this._httpHandle = null;
    /** @type {string[]} */
    this._toolNames = [];
    // Tracks "user wants this on" — set by enable(), cleared by disable().
    // Replaces the previous design that read from a hardcoded settings stub.
    this._enabled = false;
    // Single-flight mutex for enable()/disable(). Without this, a rapid UI
    // toggle (disable mid-await + concurrent enable) lets disable's
    // post-await `_httpHandle = null` overwrite the freshly-bound handle
    // from the parallel enable, leaking the new server. .then(t,t) keeps
    // the chain alive across rejections.
    this._lifecycleMutex = Promise.resolve();
  }

  status() {
    return {
      status: this._status,
      port: this._port,
      enabled: this._enabled
    };
  }

  // Run a state-mutating lifecycle op through the single-flight mutex so
  // enable()/disable() can't interleave their state writes.
  _runLifecycle(/** @type {any} */ op) {
    const next = this._lifecycleMutex.then(op, op);
    this._lifecycleMutex = next.catch(() => {});
    return next;
  }

  async enable() {
    return this._runLifecycle(async () => {
      this._enabled = true;
      if (this._status === 'running') return { port: this._port, token: this._token };
      this._status = 'starting';
      this._emitStatus();
      try {
        this._token = await this._loadOrCreateToken();
        this._httpHandle = await this._startHttpServer();
        this._port = this._httpHandle.port;
        this._toolNames = Array.isArray(this._httpHandle.toolNames)
          ? this._httpHandle.toolNames
          : [];
        this._status = 'running';
        this._emitStatus();
        return { port: this._port, token: this._token };
      } catch (err) {
        this._status = 'error';
        this._lastError = err.message;
        this._emitStatus();
        throw err;
      }
    });
  }

  async disable() {
    return this._runLifecycle(async () => {
      this._enabled = false;
      let closeError = null;
      if (this._httpHandle?.close) {
        try {
          await withTimeout(
            Promise.resolve(this._httpHandle.close()),
            HTTP_CLOSE_TIMEOUT_MS,
            'mcp:httpHandle.close'
          );
        } catch (err) {
          closeError = err;
          this._logger?.warn?.('[mcp] error closing HTTP handle', { error: err?.message });
        }
      }
      this._httpHandle = null;
      this._port = null;
      this._toolNames = [];
      // If close() rejected, the port may still be bound — surface that to
      // the renderer instead of pretending the stop was clean. Without this
      // the UI shows a stopped indicator while the socket is actually still
      // open.
      if (closeError) {
        this._status = 'error';
        this._lastError = closeError.message || 'Failed to close MCP transport';
        this._emitStatus();
        throw closeError;
      }
      this._status = 'stopped';
      this._lastError = null;
      this._emitStatus();
    });
  }

  async rotateToken() {
    // Persist BEFORE assigning this._token so the auth middleware (which
    // reads getToken() per request) never accepts a token that isn't yet
    // durable. The previous design assigned first and reverted on persist
    // failure — but any client that authenticated with the unconfirmed
    // token between the assign and the failure was permanently locked out
    // (the on-disk state still held the old token, and our in-memory state
    // reverted to match). Persist-then-assign closes that window.
    const next = _generateToken();
    try {
      await this._persistToken(next);
    } catch (err) {
      this._logger?.warn?.('[mcp] token rotation persist failed; current token unchanged', {
        error: err?.message
      });
      throw err;
    }
    this._token = next;
    this._emitStatus();
    return { token: this._token };
  }

  // Public accessor for { port, token }. The previous _currentRuntime() name
  // signaled "private" via the underscore but was called from IPC; that
  // contract was leaky (and any future caller could forget to mask the
  // returned token). This method preserves the same return shape so external
  // callers keep their masking logic at the boundary.
  getRuntime() {
    return { port: this._port, token: this._token };
  }

  getToolNames() {
    return this._toolNames;
  }

  // Back-compat alias.
  _currentRuntime() {
    return this.getRuntime();
  }

  /**
   * The token is rotatable, not user data: any unreadable or malformed
   * stored token is replaced rather than surfaced as a permanent enable()
   * failure. A plaintext token is re-persisted encrypted once safeStorage
   * becomes available.
   */
  async _loadOrCreateToken() {
    const dir = app.getPath('userData');
    let buf;
    try {
      buf = await fs.promises.readFile(path.join(dir, TOKEN_FILENAME));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      return this._createToken();
    }
    const stored = await this._decodeStoredToken(buf, dir);
    if (!stored) return this._createToken();
    if (!stored.encrypted && safeStorage.isEncryptionAvailable()) {
      await this._persistToken(stored.token).catch((/** @type {any} */ err) => {
        this._logger?.warn?.('[mcp] failed to re-encrypt plaintext token', {
          error: err?.message
        });
      });
    }
    return stored.token;
  }

  /**
   * @param {Buffer} buf
   * @param {string} dir
   * @returns {Promise<{ token: string, encrypted: boolean } | null>} null when
   *   the stored token cannot be trusted and must be regenerated.
   */
  async _decodeStoredToken(buf, dir) {
    try {
      const marker = await readEncryptionMarker(path.join(dir, TOKEN_MARKER_FILENAME));
      const encryptionAvailable = safeStorage.isEncryptionAvailable();
      // Legacy files predate the marker; fall back to the current availability.
      const encrypted = marker ? marker === 'safeStorage' : encryptionAvailable;
      if (encrypted && !encryptionAvailable) {
        throw new Error('token is encrypted but safeStorage is unavailable');
      }
      const token = encrypted ? safeStorage.decryptString(buf) : buf.toString('utf8');
      if (!TOKEN_PATTERN.test(token)) throw new Error('stored token is malformed');
      return { token, encrypted };
    } catch (err) {
      this._logger?.warn?.('[mcp] stored token unusable; generating a new one', {
        error: err?.message
      });
      return null;
    }
  }

  async _createToken() {
    const fresh = _generateToken();
    await this._persistToken(fresh);
    return fresh;
  }

  async _persistToken(/** @type {any} */ token) {
    const dir = app.getPath('userData');
    await fs.promises.mkdir(dir, { recursive: true });
    const encryptionAvailable = safeStorage.isEncryptionAvailable();
    if (!encryptionAvailable) {
      // The MCP token grants full access to all MCP tools. Storing it
      // plaintext is preferable to refusing to enable MCP entirely (the user
      // explicitly opted in by enabling the server), but we surface the
      // condition in logs so it's auditable.
      this._logger?.warn?.('[mcp] safeStorage unavailable; token stored unprotected');
    }
    const data = encryptionAvailable
      ? safeStorage.encryptString(token)
      : Buffer.from(token, 'utf8');
    await _writeFileAtomic(path.join(dir, TOKEN_FILENAME), data);
    await _writeFileAtomic(
      path.join(dir, TOKEN_MARKER_FILENAME),
      serializeEncryptionMarker(encryptionAvailable)
    );
  }

  _emitStatus() {
    this.emit('status-changed', this.status());
  }

  async _startHttpServer() {
    const { createMcpServer } = require('../transports/mcp');
    const port = _resolveMcpPort(process.env.STRATOSORT_MCP_PORT, this._logger);
    return createMcpServer({
      services: this._services,
      getToken: () => this._token,
      port,
      logger: this._logger || null
    });
  }
}

module.exports = { McpServerLifecycleService };
