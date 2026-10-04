// @ts-check
/**
 * Feedback Memory Store
 *
 * Persists natural-language feedback memories for recommendation tuning.
 * JSON-only storage with throttled saves.
 *
 * @module services/organization/feedbackMemoryStore
 */

const path = require('path');
const fs = require('fs').promises;
const { app } = require('electron');
const { logger: baseLogger, createLogger } = require('../../../shared/logger');
const { z } = require('zod');
const { tryParse: safeJsonTryParse } = require('../../../shared/safeJsonOps');

const logger =
  typeof createLogger === 'function'
    ? createLogger('Organization:FeedbackMemoryStore')
    : baseLogger;
if (typeof createLogger !== 'function' && logger?.setContext) {
  logger.setContext('Organization:FeedbackMemoryStore');
}

/** @type {{ jsonWrites: number, jsonReads: number, lastSyncAt: string|null, lastError: string|null }} */
const feedbackMetrics = {
  jsonWrites: 0,
  jsonReads: 0,
  lastSyncAt: null,
  lastError: null
};

function getMetrics() {
  return { ...feedbackMetrics };
}

function resetMetrics() {
  feedbackMetrics.jsonWrites = 0;
  feedbackMetrics.jsonReads = 0;
  feedbackMetrics.lastSyncAt = null;
  feedbackMetrics.lastError = null;
}

const feedbackEntrySchema = z
  .object({
    id: z.string(),
    text: z.string(),
    source: z.string().optional(),
    targetFolder: z.string().nullable().optional(),
    scope: z.object({}).passthrough().optional(),
    embeddingModel: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional()
  })
  .passthrough();

// Caps to prevent the feedback store from growing unboundedly. Every
// add/update fully rewrites the JSON file, so a linear-growth entry list
// turns into quadratic total I/O over a long-lived install. Defaults sized
// for heavy daily use (~5 years of 100 feedback/day before hitting the
// entry cap, ~90-day freshness window, ~2 MiB on-disk budget).
const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_PERSISTED_BYTES = 2 * 1024 * 1024;

class FeedbackMemoryStore {
  /** @param {{ maxEntries?: number, maxAgeMs?: number|null, maxPersistedBytes?: number, saveThrottleMs?: number, filename?: string }} [options] */
  constructor(options = {}) {
    this.userDataPath = app.getPath('userData');
    this.filePath = path.join(this.userDataPath, options.filename || 'feedback-memory.json');
    this.backupFilePath = path.join(this.userDataPath, 'feedback-memory.backup.json');
    this.saveThrottleMs = options.saveThrottleMs || 5000;
    this.maxEntries = Number.isFinite(options.maxEntries)
      ? Math.max(1, options.maxEntries)
      : DEFAULT_MAX_ENTRIES;
    this.maxAgeMs =
      options.maxAgeMs === null
        ? null
        : Number.isFinite(options.maxAgeMs)
          ? Math.max(0, options.maxAgeMs)
          : DEFAULT_MAX_AGE_MS;
    this.maxPersistedBytes = Number.isFinite(options.maxPersistedBytes)
      ? Math.max(64 * 1024, options.maxPersistedBytes)
      : DEFAULT_MAX_PERSISTED_BYTES;
    // Start at 0 so the first save is never throttled.
    this.lastSaveTime = 0;
    this.pendingSave = null;
    this._needsSave = false;
    this._loaded = false;
    /** @type {any[]} */
    this._entries = [];
    this._saving = false;
    /** @type {Array<(v: any) => void>} */
    this._pendingSaveWaiters = [];
    /** @type {Promise<any>} */
    this._opChain = Promise.resolve();
  }

  /**
   * Apply LRU / TTL / size caps in-place on the entries array.
   * Entries are ordered newest-first (add() uses unshift), so TTL trims the
   * tail while LRU keeps the head. Returns { droppedTtl, droppedLru, droppedSize }
   * for observability.
   */
  _enforceCaps() {
    let droppedTtl = 0;
    let droppedLru = 0;
    let droppedSize = 0;

    if (this.maxAgeMs !== null && this.maxAgeMs > 0) {
      const cutoffMs = Date.now() - this.maxAgeMs;
      const before = this._entries.length;
      this._entries = this._entries.filter((entry) => {
        const ts = entry?.updatedAt || entry?.createdAt;
        if (!ts || typeof ts !== 'string') return true;
        const parsed = Date.parse(ts);
        if (!Number.isFinite(parsed)) return true;
        return parsed >= cutoffMs;
      });
      droppedTtl = before - this._entries.length;
    }

    if (this._entries.length > this.maxEntries) {
      droppedLru = this._entries.length - this.maxEntries;
      this._entries.length = this.maxEntries;
    }

    // Size-based eviction: estimate serialized payload size and drop oldest
    // entries until it fits. We intentionally estimate per-entry (JSON.stringify
    // is O(n) in entry count) to avoid re-serializing the whole blob each loop.
    if (this._entries.length > 0 && this.maxPersistedBytes > 0) {
      let totalBytes = 0;
      const perEntryBytes = new Array(this._entries.length);
      for (let i = 0; i < this._entries.length; i++) {
        const bytes = Buffer.byteLength(JSON.stringify(this._entries[i]), 'utf8');
        perEntryBytes[i] = bytes;
        totalBytes += bytes;
      }
      // Budget minus fixed wrapper overhead (items:[], lastUpdated, separators).
      const wrapperOverhead = 128;
      const budget = Math.max(0, this.maxPersistedBytes - wrapperOverhead);
      while (totalBytes > budget && this._entries.length > 0) {
        this._entries.pop();
        totalBytes -= perEntryBytes.pop();
        droppedSize += 1;
      }
    }

    if (droppedTtl || droppedLru || droppedSize) {
      logger.debug('[FeedbackMemoryStore] Enforced caps', {
        droppedTtl,
        droppedLru,
        droppedSize,
        remaining: this._entries.length
      });
    }
    return { droppedTtl, droppedLru, droppedSize };
  }

  async _loadFromJson() {
    try {
      const data = await fs.readFile(this.filePath, 'utf-8');
      // Uses a prototype-pollution-safe reviver and reports parse failures
      // explicitly instead of throwing. The feedback file lives in userData
      // and can be edited or corrupted out-of-band — a raw JSON.parse would
      // throw and the entries array would be lost; here we fall through to
      // the empty list and log, so the store self-heals on next save.
      const parseResult = safeJsonTryParse(data);
      if (!parseResult.success) {
        feedbackMetrics.lastError = parseResult.error?.message || 'parse_failed';
        logger.warn('[FeedbackMemoryStore] Discarding corrupt feedback JSON', {
          error: parseResult.error?.message
        });
        return [];
      }
      const parsed = parseResult.value;
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      const validated = [];
      let invalidCount = 0;
      for (const item of items) {
        const result = feedbackEntrySchema.safeParse(item);
        if (result.success) {
          validated.push(result.data);
        } else {
          invalidCount += 1;
        }
      }
      if (invalidCount > 0) {
        logger.warn('[FeedbackMemoryStore] Dropped invalid feedback entries', {
          invalidCount
        });
      }
      feedbackMetrics.jsonReads++;
      return validated;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        feedbackMetrics.lastError = error.message;
        logger.warn('[FeedbackMemoryStore] Failed to load JSON file:', error.message);
      }
      return [];
    }
  }

  async load() {
    if (this._loaded) return this._entries;
    this._entries = await this._loadFromJson();
    this._loaded = true;
    // Prune on load so a file that grew unbounded pre-cap or was edited
    // out-of-band gets trimmed on the first read, not silently kept around
    // until the next add.
    this._enforceCaps();
    return this._entries;
  }

  async list() {
    await this.load();
    return this._entries.slice();
  }

  async add(/** @type {any} */ entry, /** @type {Record<string, any>} */ options = {}) {
    const op = this._opChain.then(async () => {
      await this.load();
      this._entries.unshift(entry);
      await this._save(options);
      return entry;
    });
    this._opChain = op.catch((err) => {
      logger.warn('[FeedbackMemoryStore] add failed:', err?.message);
    });
    return op;
  }

  async update(
    /** @type {any} */ id,
    /** @type {any} */ patch,
    /** @type {Record<string, any>} */ options = {}
  ) {
    const op = this._opChain.then(async () => {
      await this.load();
      const index = this._entries.findIndex((item) => item.id === id);
      if (index === -1) return null;
      this._entries[index] = { ...this._entries[index], ...patch };
      await this._save(options);
      return this._entries[index];
    });
    this._opChain = op.catch((err) => {
      logger.warn('[FeedbackMemoryStore] update failed:', err?.message);
    });
    return op;
  }

  async remove(/** @type {any} */ id, /** @type {Record<string, any>} */ options = {}) {
    /** @type {Promise<any>} */
    const op = this._opChain.then(async () => {
      await this.load();
      const originalLength = this._entries.length;
      this._entries = this._entries.filter((item) => item.id !== id);
      if (this._entries.length !== originalLength) {
        await this._save(options);
        return true;
      }
      return false;
    });
    this._opChain = op.catch((err) => {
      logger.warn('[FeedbackMemoryStore] remove failed:', err?.message);
    });
    return op;
  }

  _enqueueSaveWaiter() {
    return new Promise((resolve) => {
      this._pendingSaveWaiters.push(resolve);
    });
  }

  _resolveSaveWaiters(/** @type {any} */ result) {
    if (this._pendingSaveWaiters.length === 0) return;
    const waiters = this._pendingSaveWaiters;
    this._pendingSaveWaiters = [];
    for (const resolve of waiters) {
      try {
        resolve(result);
      } catch {
        // Ignore waiter callback errors.
      }
    }
  }

  /** @param {{ waitForFlush?: boolean }} [options] */
  async _save(options = {}) {
    const waitForFlush = options.waitForFlush === true;

    if (this._saving) {
      this._needsSave = true;
      return waitForFlush ? this._enqueueSaveWaiter() : { success: true, queued: true };
    }

    const now = Date.now();
    if (now - this.lastSaveTime < this.saveThrottleMs) {
      this._needsSave = true;
      const flushWaiter = waitForFlush ? this._enqueueSaveWaiter() : null;
      if (!this.pendingSave) {
        this.pendingSave = setTimeout(
          () => {
            this.pendingSave = null;
            if (this._needsSave) {
              void this._save();
            } else {
              this._resolveSaveWaiters({ success: true, skipped: true });
            }
          },
          this.saveThrottleMs - (now - this.lastSaveTime)
        );
        if (typeof this.pendingSave.unref === 'function') {
          this.pendingSave.unref();
        }
      }
      return flushWaiter || { success: true, throttled: true };
    }

    this.lastSaveTime = now;
    this._needsSave = false;
    this._saving = true;
    /** @type {{ success: boolean, error?: string }} */
    let saveResult = { success: true };

    try {
      // Enforce caps immediately before serializing so we don't persist
      // entries that would just be pruned on next load.
      this._enforceCaps();
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const payload = {
        items: this._entries,
        lastUpdated: new Date().toISOString()
      };
      const tempPath = `${this.filePath}.${Date.now()}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(payload, null, 2));
      await fs.rename(tempPath, this.filePath);
      feedbackMetrics.jsonWrites++;
      feedbackMetrics.lastSyncAt = new Date().toISOString();
      logger.debug('[FeedbackMemoryStore] Saved feedback memory');
    } catch (error) {
      feedbackMetrics.lastError = error.message;
      logger.warn('[FeedbackMemoryStore] Failed to save feedback memory:', error.message);
      saveResult = { success: false, error: error.message };
    } finally {
      this._saving = false;
      if (this._needsSave) {
        void this._save();
      } else {
        this._resolveSaveWaiters(saveResult);
      }
    }

    return saveResult;
  }

  async shutdown() {
    if (this.pendingSave) {
      clearTimeout(this.pendingSave);
      this.pendingSave = null;
    }
    if (this._needsSave) {
      this.lastSaveTime = 0;
      await this._save();
    } else {
      this._resolveSaveWaiters({ success: true, skipped: true });
    }
    logger.debug('[FeedbackMemoryStore] Shutdown complete');
  }
}

module.exports = {
  FeedbackMemoryStore,
  getMetrics,
  resetMetrics
};
