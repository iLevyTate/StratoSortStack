// @ts-check
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { safeStorage, app } = require('electron');
const { PROVIDER_NAMES } = require('./schemas');
const { swallow } = require('../../../shared/promiseUtils');
const { readEncryptionMarker, serializeEncryptionMarker } = require('../encryptionMarker');

const KEY_DIR = 'ai-keys';
const _PROVIDER_SET = new Set(PROVIDER_NAMES);

function _assertProvider(/** @type {any} */ provider) {
  if (!_PROVIDER_SET.has(provider)) {
    throw new Error(`AIKeyStore: unknown provider '${provider}'`);
  }
}

class AIKeyStore {
  /** @param {{ logger?: any }} [opts] */
  constructor({ logger } = {}) {
    // Defer userData lookup so that constructing the store doesn't fail
    // when imported from a non-Electron test environment.
    this._dir = null;
    this._logger = logger || {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {}
    };
    // Per-provider write chain. Two parallel set('anthropic', k1) and
    // set('anthropic', k2) would otherwise both write to the same .tmp path,
    // racing on open/writeFile/sync/rename — and on Windows a failed second
    // call's catch-block unlink can delete the first call's file mid-rename.
    this._writeChains = new Map();
  }

  _resolveDir() {
    if (!this._dir) this._dir = path.join(app.getPath('userData'), KEY_DIR);
    return this._dir;
  }

  _resolvePath(/** @type {any} */ provider) {
    return path.join(this._resolveDir(), `${provider}.bin`);
  }

  _resolveMetaPath(/** @type {any} */ provider) {
    return path.join(this._resolveDir(), `${provider}.enc`);
  }

  async get(/** @type {any} */ provider) {
    _assertProvider(provider);
    try {
      const buf = await fs.promises.readFile(this._resolvePath(provider));
      const marker = await readEncryptionMarker(this._resolveMetaPath(provider));
      const encryptionAvailable = safeStorage.isEncryptionAvailable();
      if (marker === 'safeStorage') {
        if (!encryptionAvailable) {
          const err = /** @type {Error & { code?: string }} */ (
            new Error('Key is encrypted but OS secret storage is unavailable')
          );
          err.code = 'ENCRYPTION_UNAVAILABLE';
          throw err;
        }
        return safeStorage.decryptString(buf);
      }
      if (marker === 'plaintext') {
        return buf.toString('utf8');
      }
      if (encryptionAvailable) return safeStorage.decryptString(buf);
      return buf.toString('utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  // Stores `key` for `provider`. When OS-level encryption (Electron's
  // safeStorage / DPAPI / Keychain) is unavailable, this throws
  // ENCRYPTION_UNAVAILABLE unless the caller explicitly opts in to plaintext
  // via { allowPlaintext: true }. The renderer is expected to surface a
  // confirmation prompt in that case ("safe storage is not available — store
  // this key unprotected anyway?").
  //
  // Returns { encryption: 'safeStorage' | 'plaintext' } so the IPC layer can
  // forward it to the renderer for UI display.
  async set(/** @type {any} */ provider, /** @type {any} */ key, { allowPlaintext = false } = {}) {
    _assertProvider(provider);
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('AIKeyStore: key must be a non-empty string');
    }
    // Serialize all set() calls for this provider through a per-provider
    // promise chain. Concurrent writers would otherwise race on the .tmp
    // path; on Windows the loser's cleanup unlink could delete the winner's
    // file mid-rename.
    const prev = this._writeChains.get(provider) || Promise.resolve();
    const next = prev.then(
      () => this._writeOnce(provider, key, allowPlaintext),
      () => this._writeOnce(provider, key, allowPlaintext)
    );
    this._writeChains.set(
      provider,
      next.catch(() => {})
    );
    return next;
  }

  async _writeOnce(
    /** @type {any} */ provider,
    /** @type {any} */ key,
    /** @type {any} */ allowPlaintext
  ) {
    const encryptionAvailable = safeStorage.isEncryptionAvailable();
    if (!encryptionAvailable && !allowPlaintext) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error(
          'OS-level secret storage is unavailable on this system. ' +
            'Pass allowPlaintext: true to store the key unprotected.'
        )
      );
      err.code = 'ENCRYPTION_UNAVAILABLE';
      throw err;
    }
    if (!encryptionAvailable) {
      this._logger.warn('[ai] safeStorage unavailable; key stored unprotected', { provider });
    }
    await fs.promises.mkdir(this._resolveDir(), { recursive: true });
    const finalPath = this._resolvePath(provider);
    const tempPath = `${finalPath}.tmp`;
    const data = encryptionAvailable ? safeStorage.encryptString(key) : Buffer.from(key, 'utf8');

    let handle;
    try {
      // Open with mode 0o600 so the file is restricted from creation; chmod
      // afterwards is best-effort (Windows ignores unix mode).
      handle = await fs.promises.open(tempPath, 'w', 0o600);
      await handle.writeFile(data);
      try {
        // Best-effort fsync; some filesystems (mocked, in-memory) may reject.
        await handle.sync();
      } catch {
        /* ignore */
      }
      await handle.close();
      handle = null;
      try {
        await fs.promises.chmod(tempPath, 0o600);
      } catch {
        /* Windows: chmod is a no-op */
      }
      await fs.promises.rename(tempPath, finalPath);
      await fs.promises.writeFile(
        this._resolveMetaPath(provider),
        serializeEncryptionMarker(encryptionAvailable)
      );
    } catch (err) {
      // Clean up the .tmp on failure so plaintext fragments don't linger.
      if (handle) {
        await swallow(handle.close(), this._logger, 'cleanup:aiKey.handle');
      }
      await swallow(fs.promises.unlink(tempPath), this._logger, 'cleanup:aiKey.tempPath');
      throw err;
    }
    return { encryption: encryptionAvailable ? 'safeStorage' : 'plaintext' };
  }

  async remove(/** @type {any} */ provider) {
    _assertProvider(provider);
    try {
      await fs.promises.unlink(this._resolvePath(provider));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    try {
      await fs.promises.unlink(this._resolveMetaPath(provider));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  async status(/** @type {any} */ provider) {
    _assertProvider(provider);
    const key = await this.get(provider);
    if (!key) return { hasKey: false, lastFour: null };
    return { hasKey: true, lastFour: key.slice(-4) };
  }

  // Sanitized representation — never leak key material.
  toJSON() {
    return { type: 'AIKeyStore' };
  }

  toString() {
    return '[AIKeyStore]';
  }
}

module.exports = { AIKeyStore };
