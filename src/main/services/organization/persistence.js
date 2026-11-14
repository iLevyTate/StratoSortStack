// @ts-check
/**
 * Persistence
 *
 * User pattern persistence for organization service.
 * JSON-only storage with atomic writes and throttled saves.
 *
 * @module services/organization/persistence
 */

const path = require('path');
const fs = require('fs').promises;
const { app } = require('electron');
const { logger: baseLogger, createLogger } = require('../../../shared/logger');
const { z } = require('zod');
const { tryParse: safeJsonTryParse } = require('../../../shared/safeJsonOps');

const logger =
  typeof createLogger === 'function' ? createLogger('Organization:Persistence') : baseLogger;
if (typeof createLogger !== 'function' && logger?.setContext) {
  logger.setContext('Organization:Persistence');
}

// Metrics tracking for monitoring persistence health
/** @type {{ jsonWrites: number, jsonReads: number, lastSyncAt: string|null, lastError: string|null }} */
const metrics = {
  jsonWrites: 0,
  jsonReads: 0,
  lastSyncAt: null,
  lastError: null
};

function getMetrics() {
  return { ...metrics };
}

function resetMetrics() {
  metrics.jsonWrites = 0;
  metrics.jsonReads = 0;
  metrics.lastSyncAt = null;
  metrics.lastError = null;
}

const patternEntrySchema = z.object({
  folder: z.string().optional(),
  path: z.string().optional(),
  count: z.number().optional(),
  confidence: z.number().optional(),
  lastUsed: z.number().optional(),
  createdAt: z.number().optional()
});

const feedbackEntrySchema = z.object({
  timestamp: z.number().optional(),
  accepted: z.boolean().optional(),
  file: z
    .object({
      name: z.string().optional(),
      type: z.string().optional()
    })
    .optional(),
  suggestion: z.object({}).passthrough().optional(),
  // Key the row changed in userPatterns; absent on rows saved before it existed.
  pattern: z.string().optional()
});

const patternsSchema = z.object({
  patterns: z.array(z.tuple([z.string(), patternEntrySchema])).optional(),
  feedbackHistory: z.array(feedbackEntrySchema).optional(),
  folderUsageStats: z
    .array(
      z.tuple([
        z.string(),
        z
          .object({
            count: z.number().optional(),
            lastUsed: z.number().optional()
          })
          .passthrough()
      ])
    )
    .optional(),
  lastUpdated: z.string().optional()
});

class PatternPersistence {
  /** @param {{ filename?: string, saveThrottleMs?: number }} [options] */
  constructor(options = {}) {
    this.userDataPath = app.getPath('userData');
    this.patternsFilePath = path.join(this.userDataPath, options.filename || 'user-patterns.json');
    this.backupFilePath = path.join(this.userDataPath, 'user-patterns.backup.json');
    // Start at 0 so the first save is never throttled.
    this.lastSaveTime = 0;
    this.saveThrottleMs = options.saveThrottleMs || 5000;
    this.pendingSave = null;
    this._pendingSaveData = null;
    /** @type {Array<(v: any) => void>} */
    this._pendingSaveWaiters = [];
    /** @type {Promise<any>} */
    this._saveChain = Promise.resolve();
  }

  async recover() {
    try {
      if (await this._fileExists(this.patternsFilePath)) {
        await fs.copyFile(this.patternsFilePath, this.backupFilePath);
        logger.info(`[Persistence] Backed up corrupt patterns to ${this.backupFilePath}`);
      }
    } catch (error) {
      logger.warn('[Persistence] Failed to backup corrupt patterns:', error.message);
    }
    // Reset internal state
    this.lastSaveTime = 0;
    return { success: true };
  }

  async _fileExists(/** @type {any} */ filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async _loadFromJson() {
    try {
      const raw = await fs.readFile(this.patternsFilePath, 'utf-8');
      // Reject corrupt blobs without throwing so the caller can fall through
      // to empty defaults. safeJsonTryParse also strips prototype-pollution
      // keys, which matters here because this file is editable by the user.
      const parseResult = safeJsonTryParse(raw);
      if (!parseResult.success) {
        metrics.lastError = parseResult.error?.message || 'parse_failed';
        logger.warn('[Persistence] Patterns JSON is corrupt; using empty defaults', {
          error: parseResult.error?.message
        });
        return /** @type {{ patterns: any[], feedbackHistory: any[], folderUsageStats: any[] }} */ ({
          patterns: [],
          feedbackHistory: [],
          folderUsageStats: []
        });
      }
      const parsed = parseResult.value;
      const validated = patternsSchema.safeParse(parsed);
      if (!validated.success) {
        metrics.lastError = validated.error?.message;
        logger.warn('[Persistence] Invalid patterns schema; using empty defaults');
        return /** @type {{ patterns: any[], feedbackHistory: any[], folderUsageStats: any[] }} */ ({
          patterns: [],
          feedbackHistory: [],
          folderUsageStats: []
        });
      }
      metrics.jsonReads++;
      return {
        patterns: validated.data.patterns || [],
        feedbackHistory: validated.data.feedbackHistory || [],
        folderUsageStats: validated.data.folderUsageStats || [],
        lastUpdated: validated.data.lastUpdated
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        metrics.lastError = error.message;
        logger.warn('[Persistence] Failed to load patterns:', error.message);
      }
      return null;
    }
  }

  async load() {
    const jsonData = await this._loadFromJson();
    if (jsonData) {
      logger.info(`[Persistence] Loaded patterns from ${this.patternsFilePath}`);
      return jsonData;
    }
    return null;
  }

  _resolvePendingSaveWaiters(/** @type {any} */ result) {
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

  async _saveNow(/** @type {any} */ data) {
    let tempPath;
    try {
      const now = Date.now();
      this.lastSaveTime = now;
      this._pendingSaveData = null;

      const saveData = {
        ...data,
        lastUpdated: new Date().toISOString()
      };

      await fs.mkdir(path.dirname(this.patternsFilePath), { recursive: true });
      const randomId = require('crypto').randomUUID();
      tempPath = `${this.patternsFilePath}.${randomId}.tmp`;
      const serialized = JSON.stringify(saveData, null, 2);
      await fs.writeFile(tempPath, serialized);
      const expectedSize = Buffer.byteLength(serialized);
      const tempStats = await fs.stat(tempPath);
      if (tempStats.size !== expectedSize) {
        throw new Error(
          `[Persistence] Atomic write size mismatch: expected ${expectedSize}, got ${tempStats.size}`
        );
      }
      await fs.rename(tempPath, this.patternsFilePath);

      metrics.jsonWrites++;
      metrics.lastSyncAt = new Date().toISOString();
      logger.debug(`[Persistence] Saved patterns to ${this.patternsFilePath}`);
      return { success: true };
    } catch (error) {
      metrics.lastError = error.message;
      logger.error('[Persistence] Failed to save patterns:', error);
      this.pendingSave = null;
      if (tempPath) {
        fs.unlink(tempPath).catch((unlinkErr) => {
          logger.debug('[Persistence] Failed to clean up temp file:', unlinkErr?.message);
        });
      }
      return { success: false, error: error.message };
    }
  }

  async save(/** @type {any} */ data, /** @type {{ waitForFlush?: boolean }} */ options = {}) {
    const waitForFlush = options.waitForFlush === true;
    const now = Date.now();
    const waitForDeferredFlush = waitForFlush
      ? new Promise((resolve) => {
          this._pendingSaveWaiters.push(resolve);
        })
      : null;

    if (now - this.lastSaveTime < this.saveThrottleMs) {
      // Every save is the complete PatternMatcher state, so the newest
      // snapshot wins. Merging it with an older queued one brought back
      // patterns deleted in between (an undo inside the throttle window).
      this._pendingSaveData = data;
      if (!this.pendingSave) {
        const delayMs = this.saveThrottleMs - (now - this.lastSaveTime);
        this.pendingSave = setTimeout(() => {
          this.pendingSave = null;
          const dataToSave = this._pendingSaveData;
          this._pendingSaveData = null;
          const savePromise = this._saveChain.then(() =>
            dataToSave ? this._saveNow(dataToSave) : { success: true, skipped: true }
          );
          // _saveChain absorbs the rejection and resolves to a {success:false}
          // shape, so chaining waiter notification off it (rather than off the
          // raw savePromise) ensures we never leak an unhandled rejection while
          // still delivering the same result object to callers.
          this._saveChain = savePromise.catch((err) => {
            logger.error('[Persistence] Failed to save patterns:', err);
            return { success: false, error: err?.message };
          });
          this._saveChain
            .then((result) => this._resolvePendingSaveWaiters(result))
            .catch((notifyErr) => {
              // _saveChain already absorbs save failures into a {success:false}
              // shape, so this branch should be unreachable. The defensive
              // .catch keeps the chain lint-clean and prevents
              // unhandledRejection if _resolvePendingSaveWaiters ever throws.
              logger.error(
                '[Persistence] Failed to notify save waiters:',
                notifyErr?.message || notifyErr
              );
            });
        }, delayMs);
        if (typeof this.pendingSave.unref === 'function') {
          this.pendingSave.unref();
        }
      }
      return waitForDeferredFlush || { success: true, throttled: true };
    }

    if (this.pendingSave) {
      clearTimeout(this.pendingSave);
      this.pendingSave = null;
    }
    this._pendingSaveData = null;
    const savePromise = this._saveChain.then(() => this._saveNow(data));
    this._saveChain = savePromise.catch((err) => {
      logger.error('[Persistence] Failed to save patterns:', err);
      return { success: false, error: err?.message };
    });
    const result = await savePromise;
    this._resolvePendingSaveWaiters(result);
    return result;
  }

  cancelPendingSave() {
    if (this.pendingSave) {
      clearTimeout(this.pendingSave);
      this.pendingSave = null;
    }
    this._pendingSaveData = null;
  }

  async shutdown() {
    if (this.pendingSave) {
      clearTimeout(this.pendingSave);
      this.pendingSave = null;
    }

    const dataToFlush = this._pendingSaveData;
    this._pendingSaveData = null;
    if (dataToFlush) {
      logger.info('[Persistence] Flushing pending save on shutdown');
      try {
        this.lastSaveTime = 0;
        const savePromise = this._saveChain.then(() => this._saveNow(dataToFlush));
        this._saveChain = savePromise.catch((err) => {
          logger.error('[Persistence] Failed to save patterns:', err);
          return { success: false, error: err?.message };
        });
        const result = await savePromise;
        this._resolvePendingSaveWaiters(result);
      } catch (error) {
        logger.error('[Persistence] Failed to flush pending save on shutdown:', error.message);
        this._resolvePendingSaveWaiters({ success: false, error: error.message });
      }
    } else {
      this._resolvePendingSaveWaiters({ success: true, skipped: true });
    }
    logger.debug('[Persistence] Shutdown complete');
  }
}

module.exports = {
  PatternPersistence,
  getMetrics,
  resetMetrics
};
