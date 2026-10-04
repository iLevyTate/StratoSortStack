// @ts-check
/**
 * Startup sweep for orphan atomic-write temp files in userData.
 *
 * Atomic writers create sibling temp files next to their targets —
 * `<name>.<uuid>.tmp` (organization/persistence.js) and
 * `<name>.tmp.<timestamp>.<hex>` (atomicFileOperations.js) — and unlink
 * them on every JS-observable failure. A process death between write and
 * rename (OOM-kill, force-quit, power loss) bypasses that cleanup and the
 * temp survives forever (observed in production as an orphaned
 * user-patterns.json.<uuid>.tmp).
 *
 * On startup we scan the top level of userData once for `*.tmp` /
 * `*.tmp.*` files older than `maxAgeMs` (default 1 h — long enough that
 * any in-flight atomic write has finished) and unlink them. Non-recursive
 * on purpose: Electron/Chromium own the subdirectories. Best-effort:
 * failures log at debug and never surface to the user.
 */

const fs = require('fs').promises;
const path = require('path');

const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

// Matches "<anything>.tmp" and "<anything>.tmp.<suffix>" — the two atomic
// temp naming schemes in this codebase — without matching real data files.
const TMP_FILE_PATTERN = /\.tmp(\.|$)/;

/**
 * Sweep orphaned atomic-write temp files from the userData directory.
 *
 * @param {object} options
 * @param {string} options.userDataDir - Directory to sweep (top level only).
 * @param {number} [options.maxAgeMs] - Only delete files older than this.
 * @param {any} [options.fsImpl] - Override fs.promises (testing).
 * @param {any} [options.logger] - Logger; info/debug methods used.
 * @returns {Promise<{ scanned: number, removed: number, skipped: number, errors: number }>}
 */
async function sweepOrphanUserDataTmpFiles({
  userDataDir,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  fsImpl = fs,
  logger = null
}) {
  const stats = { scanned: 0, removed: 0, skipped: 0, errors: 0 };
  let entries;
  try {
    entries = await fsImpl.readdir(userDataDir, { withFileTypes: true });
  } catch (err) {
    logger?.debug?.('[UserDataTmpSweeper] readdir failed; skipping sweep', {
      userDataDir,
      error: err?.message
    });
    return stats;
  }

  const cutoff = Date.now() - Math.max(0, maxAgeMs);

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (typeof entry.name !== 'string' || !TMP_FILE_PATTERN.test(entry.name)) continue;
    stats.scanned += 1;

    const filePath = path.join(userDataDir, entry.name);
    let fileStat;
    try {
      fileStat = await fsImpl.stat(filePath);
    } catch (err) {
      stats.errors += 1;
      logger?.debug?.('[UserDataTmpSweeper] stat failed', {
        file: entry.name,
        error: err?.message
      });
      continue;
    }

    // mtime newer than the cutoff means an atomic write may still be
    // in flight — leave it for its own writer to rename or clean up.
    if (fileStat.mtimeMs > cutoff) {
      stats.skipped += 1;
      continue;
    }

    try {
      await fsImpl.unlink(filePath);
      stats.removed += 1;
    } catch (err) {
      stats.errors += 1;
      logger?.debug?.('[UserDataTmpSweeper] unlink failed', {
        file: entry.name,
        error: err?.message
      });
    }
  }

  if (stats.removed > 0) {
    logger?.info?.('[UserDataTmpSweeper] Removed orphan atomic-write temp files', {
      removed: stats.removed,
      scanned: stats.scanned,
      skipped: stats.skipped,
      errors: stats.errors
    });
  }

  return stats;
}

// Rollback recovery manifests (userData/recovery/rollback_<batchId>.json)
// are written by batchRollback before restoring a failed batch and are kept
// on partial failure as manual-recovery breadcrumbs. Nothing consumes them
// programmatically, so without a retention window they accrue forever.
// 180 days keeps recent forensics while bounding accumulation.
const DEFAULT_MANIFEST_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

const RECOVERY_MANIFEST_PATTERN = /^rollback_.*\.json$/;

/**
 * Sweep stale batch-rollback recovery manifests from userData/recovery.
 *
 * @param {object} options
 * @param {string} options.userDataDir - userData root (recovery/ is derived).
 * @param {number} [options.maxAgeMs] - Only delete manifests older than this.
 * @param {any} [options.fsImpl] - Override fs.promises (testing).
 * @param {any} [options.logger] - Logger; info/debug methods used.
 * @returns {Promise<{ scanned: number, removed: number, skipped: number, errors: number }>}
 */
async function sweepStaleRecoveryManifests({
  userDataDir,
  maxAgeMs = DEFAULT_MANIFEST_MAX_AGE_MS,
  fsImpl = fs,
  logger = null
}) {
  const stats = { scanned: 0, removed: 0, skipped: 0, errors: 0 };
  const recoveryDir = path.join(userDataDir, 'recovery');
  let entries;
  try {
    entries = await fsImpl.readdir(recoveryDir, { withFileTypes: true });
  } catch (err) {
    // Missing directory is the common case (no rollback ever failed).
    logger?.debug?.('[RecoveryManifestSweeper] readdir failed; skipping sweep', {
      recoveryDir,
      error: err?.message
    });
    return stats;
  }

  const cutoff = Date.now() - Math.max(0, maxAgeMs);

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (typeof entry.name !== 'string' || !RECOVERY_MANIFEST_PATTERN.test(entry.name)) continue;
    stats.scanned += 1;

    const filePath = path.join(recoveryDir, entry.name);
    let fileStat;
    try {
      fileStat = await fsImpl.stat(filePath);
    } catch (err) {
      stats.errors += 1;
      logger?.debug?.('[RecoveryManifestSweeper] stat failed', {
        file: entry.name,
        error: err?.message
      });
      continue;
    }

    if (fileStat.mtimeMs > cutoff) {
      stats.skipped += 1;
      continue;
    }

    try {
      await fsImpl.unlink(filePath);
      stats.removed += 1;
    } catch (err) {
      stats.errors += 1;
      logger?.debug?.('[RecoveryManifestSweeper] unlink failed', {
        file: entry.name,
        error: err?.message
      });
    }
  }

  if (stats.removed > 0) {
    logger?.info?.('[RecoveryManifestSweeper] Removed stale rollback recovery manifests', {
      removed: stats.removed,
      scanned: stats.scanned,
      skipped: stats.skipped,
      errors: stats.errors
    });
  }

  return stats;
}

module.exports = {
  sweepOrphanUserDataTmpFiles,
  DEFAULT_MAX_AGE_MS,
  sweepStaleRecoveryManifests,
  DEFAULT_MANIFEST_MAX_AGE_MS
};
