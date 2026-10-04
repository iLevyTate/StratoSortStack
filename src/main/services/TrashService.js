// @ts-check
/**
 * TrashService — safe single-file or batch deletion to the OS trash.
 *
 * Wraps `shell.trashItem` with up-front path validation (rejects URI
 * schemes and resolves symlinks via realpath, so a malicious symlink in
 * Downloads can't trick a duplicates-flow user into trashing a system
 * file via its target). Also normalizes the platform-inconsistent errors
 * from `shell.trashItem` (especially Linux without gio/gvfs) into a
 * structured `{ success, path, error, code }` result so callers can show
 * actionable messaging instead of raw exceptions.
 */
const { shell } = require('electron');
const fs = require('fs').promises;
const { createLogger } = require('../../shared/logger');
const { validateFileOperationPath } = require('../../shared/pathSanitization');
const { mapWithConcurrency } = require('../../shared/promiseUtils');

const logger = createLogger('TrashService');

class TrashService {
  /** @param {{ maxBatchSize?: number, concurrency?: number }} [options] */
  constructor(options = {}) {
    this.maxBatchSize = options.maxBatchSize || 1000;
    // Bounded pool width for trashBatch. Each item does realpath validation,
    // a stat, and shell.trashItem — all I/O-bound, so a modest pool cuts
    // large duplicate-cleanup batches from serial N round-trips without
    // hammering the OS shell.
    this.concurrency = options.concurrency || 8;
  }

  async _validatePath(/** @type {any} */ filePath) {
    // checkSymlinks REJECTS dangerous symlink targets (system dirs etc.) but
    // validateFileOperationPath still returns the path.resolve()d ORIGINAL
    // path, never the realpath — trashItem therefore operates on the link
    // itself. That is the safe outcome for trash (the target survives; only
    // the link goes to the OS trash), but do not rely on a realpath here.
    const validation = await validateFileOperationPath(filePath, {
      requireAbsolute: true,
      checkSymlinks: true,
      disallowUrlSchemes: true,
      allowFileUrl: false
    });
    if (!validation.valid) {
      throw new Error(validation.error || 'Path validation failed');
    }
    return validation.normalizedPath;
  }

  /**
   * Move an already validated absolute file path to the OS trash.
   * @param {string} safePath
   * @returns {Promise<{ success: boolean, path: string, error?: string, code?: string }>}
   */
  async _trashValidatedAbsolutePath(safePath) {
    try {
      await fs.access(safePath);
    } catch (err) {
      return {
        success: false,
        path: safePath,
        error: `File not found: ${err.code || err.message}`,
        code: 'NOT_FOUND'
      };
    }
    try {
      await shell.trashItem(safePath);
      return { success: true, path: safePath };
    } catch (err) {
      logger.warn('[TrashService] trashItem failed', {
        path: safePath,
        error: err?.message
      });
      return {
        success: false,
        path: safePath,
        error: err?.message || 'Trash operation failed',
        code: 'TRASH_FAILED'
      };
    }
  }

  async trashOne(/** @type {any} */ filePath) {
    const safePath = await this._validatePath(filePath);
    return this._trashValidatedAbsolutePath(safePath);
  }

  async trashBatch(/** @type {any} */ paths) {
    if (!Array.isArray(paths) || paths.length === 0) {
      return { trashed: [], failed: [], totalBytes: 0 };
    }
    if (paths.length > this.maxBatchSize) {
      throw new Error(`Batch size ${paths.length} exceeds maximum ${this.maxBatchSize}`);
    }

    // Validate/stat/trash each path in a bounded pool (the per-item pipeline
    // never throws — every outcome is a structured result), then aggregate in
    // input order so callers see deterministic trashed/failed arrays.
    const outcomes = await mapWithConcurrency(paths, this.concurrency, async (p) => {
      let safePath;
      try {
        safePath = await this._validatePath(p);
      } catch (err) {
        return {
          success: false,
          path: typeof p === 'string' ? p : String(p),
          error: err?.message || 'Path validation failed',
          code: 'VALIDATION_ERROR'
        };
      }
      let sizeBefore;
      try {
        const stats = await fs.stat(safePath);
        // Duplicate cleanup trashes files it indexed; a directory here means a
        // caller is asking for something the finder never produced.
        if (typeof stats.isDirectory === 'function' && stats.isDirectory()) {
          return {
            success: false,
            path: safePath,
            error: 'Only files can be trashed from here',
            code: 'NOT_A_FILE'
          };
        }
        sizeBefore = stats.size || 0;
      } catch (err) {
        return {
          success: false,
          path: safePath,
          error: `File not found: ${err?.code || err?.message || 'stat failed'}`,
          code: 'NOT_FOUND'
        };
      }
      const result = await this._trashValidatedAbsolutePath(safePath);
      return result.success ? { ...result, size: sizeBefore } : result;
    });

    const trashed = [];
    const failed = [];
    let totalBytes = 0;
    for (const outcome of outcomes) {
      if (outcome.success) {
        trashed.push({ path: outcome.path, size: outcome.size });
        totalBytes += outcome.size;
      } else {
        failed.push(outcome);
      }
    }

    logger.info('[TrashService] Batch complete', {
      total: paths.length,
      trashed: trashed.length,
      failed: failed.length,
      totalBytes
    });

    return { trashed, failed, totalBytes };
  }
}

module.exports = { TrashService };
