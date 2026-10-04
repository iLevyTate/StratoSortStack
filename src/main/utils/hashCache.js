// @ts-check
const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const { createLogger } = require('../../shared/logger');
const { tryParse: safeJsonTryParse } = require('../../shared/safeJsonOps');
const { normalizePathForIndex } = require('../../shared/pathSanitization');

const logger = createLogger('HashCache');

const DEFAULT_FILE_NAME = 'hash-cache.json';
const SAVE_DEBOUNCE_MS = 500;
const MAX_ENTRIES = 50000;

// Cache keyed by absolute normalized path; value is { size, mtimeMs, sha256 }.
// On read, the caller passes size + mtimeMs; a mismatch is treated as cache miss.
// This is for files NOT in Orama (e.g. Downloads candidates, ad-hoc scans). Files
// that live in the vector DB carry their hash as an Orama column instead.

class HashCache {
  /** @param {{ filePath?: string, fileName?: string }} [options] */
  constructor(options = {}) {
    this._filePath =
      options.filePath || path.join(app.getPath('userData'), options.fileName || DEFAULT_FILE_NAME);
    /** @type {Map<string, { size: number, mtimeMs: number, sha256: string }>} */
    this._entries = new Map();
    this._loaded = false;
    this._dirty = false;
    /** @type {NodeJS.Timeout | null} */
    this._saveTimer = null;
  }

  /** @param {string} filePath */
  _key(filePath) {
    if (typeof filePath !== 'string' || !filePath) return '';
    try {
      return normalizePathForIndex(filePath);
    } catch {
      return filePath;
    }
  }

  async _load() {
    if (this._loaded) return;
    try {
      const raw = await fs.readFile(this._filePath, 'utf8');
      // tryParse returns a {success, value} envelope — reading .entries off
      // the envelope itself made hydration a silent no-op (every hash was
      // recomputed each launch).
      const { value: parsed } = safeJsonTryParse(raw);
      if (parsed && typeof parsed === 'object' && parsed.entries) {
        for (const [key, value] of Object.entries(parsed.entries)) {
          const val = /** @type {any} */ (value);
          if (val && typeof val.sha256 === 'string') {
            const nk = this._key(key) || key;
            this._entries.set(nk, val);
          }
        }
      }
    } catch (/** @type {any} */ err) {
      if (err?.code !== 'ENOENT') {
        logger.warn('[HashCache] load failed', { error: err?.message });
      }
    }
    this._loaded = true;
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._save().catch((/** @type {any} */ err) =>
        logger.warn('[HashCache] save failed', { error: err?.message })
      );
    }, SAVE_DEBOUNCE_MS);
  }

  async _save() {
    if (!this._dirty) return;
    this._dirty = false;
    const payload = {
      version: 1,
      entries: Object.fromEntries(this._entries)
    };
    const tmp = `${this._filePath}.tmp`;
    await fs.mkdir(path.dirname(this._filePath), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
    await fs.rename(tmp, this._filePath);
  }

  /**
   * @param {string} filePath
   * @param {{ size: number, mtimeMs: number }} stats
   */
  async get(filePath, { size, mtimeMs }) {
    await this._load();
    const entry = this._entries.get(this._key(filePath));
    if (!entry) return null;
    if (entry.size !== size) return null;
    if (Math.abs((entry.mtimeMs || 0) - (mtimeMs || 0)) > 1) return null;
    return entry.sha256;
  }

  /**
   * @param {string} filePath
   * @param {{ size: number, mtimeMs: number, sha256: string }} entry
   */
  async set(filePath, { size, mtimeMs, sha256 }) {
    await this._load();
    const k = this._key(filePath);
    if (this._entries.size >= MAX_ENTRIES && !this._entries.has(k)) {
      // Evict oldest-inserted entry (Map preserves insertion order).
      const oldestKey = this._entries.keys().next().value;
      if (oldestKey) this._entries.delete(oldestKey);
    }
    this._entries.set(k, { size, mtimeMs, sha256 });
    this._dirty = true;
    this._scheduleSave();
  }

  async flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    await this._save();
  }

  /** @param {string} filePath */
  async invalidate(filePath) {
    await this._load();
    if (this._entries.delete(this._key(filePath))) {
      this._dirty = true;
      this._scheduleSave();
    }
  }

  async clear() {
    await this._load();
    this._entries.clear();
    this._dirty = true;
    await this.flush();
  }

  size() {
    return this._entries.size;
  }
}

/** @type {HashCache | null} */
let _instance = null;

function getHashCache() {
  if (!_instance) _instance = new HashCache();
  return _instance;
}

module.exports = {
  HashCache,
  getHashCache
};
