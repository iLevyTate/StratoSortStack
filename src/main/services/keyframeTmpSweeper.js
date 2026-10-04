// @ts-check
/**
 * Startup sweep for orphan keyframe workspaces.
 *
 * `mediaAnalysis.js` writes scratch keyframe stills to
 * `os.tmpdir()/stratosort-keyframes-<basename>-<hex>` and cleans them up on
 * the success and error paths. A SIGKILL (OOM, force-quit, hard power-off)
 * or an Electron crash mid-analysis bypasses both, so the directory leaks
 * until the OS rotates `/tmp`.
 *
 * On startup we walk `os.tmpdir()` once for `stratosort-keyframes-*` entries
 * older than `maxAgeMs` (default 24 h) and `fs.rm`-recursive them. This
 * runs after services boot so it never delays the first window paint;
 * failures are logged at debug and never surface to the user — temp
 * cleanup is best-effort by definition.
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const KEYFRAME_PREFIX = 'stratosort-keyframes-';
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Sweep orphaned keyframe directories from the OS temp dir.
 *
 * @param {object} [options]
 * @param {string} [options.tmpDir] - Override tmpdir (testing).
 * @param {number} [options.maxAgeMs] - Only delete entries older than this.
 * @param {any} [options.fsImpl] - Override fs.promises (testing).
 * @param {any} [options.logger] - Logger; warn/debug methods used.
 * @returns {Promise<{ scanned: number, removed: number, skipped: number, errors: number }>}
 */
async function sweepOrphanKeyframeDirs({
  tmpDir = os.tmpdir(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  fsImpl = fs,
  logger = null
} = {}) {
  const stats = { scanned: 0, removed: 0, skipped: 0, errors: 0 };
  let entries;
  try {
    entries = await fsImpl.readdir(tmpDir, { withFileTypes: true });
  } catch (err) {
    logger?.debug?.('[KeyframeSweeper] readdir failed; skipping sweep', {
      tmpDir,
      error: err?.message
    });
    return stats;
  }

  const cutoff = Date.now() - Math.max(0, maxAgeMs);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (typeof entry.name !== 'string' || !entry.name.startsWith(KEYFRAME_PREFIX)) continue;
    stats.scanned += 1;

    const dirPath = path.join(tmpDir, entry.name);
    let dirStat;
    try {
      dirStat = await fsImpl.stat(dirPath);
    } catch (err) {
      stats.errors += 1;
      logger?.debug?.('[KeyframeSweeper] stat failed', {
        dir: entry.name,
        error: err?.message
      });
      continue;
    }

    // Use mtimeMs as a conservative "last touched" signal. atime is unreliable
    // (often disabled with noatime); ctime is fine but mtime is the field
    // ffmpeg/extraction writes during the run, so mtime > age means the
    // workspace is for an in-flight analysis we should leave alone.
    if (dirStat.mtimeMs > cutoff) {
      stats.skipped += 1;
      continue;
    }

    try {
      await fsImpl.rm(dirPath, { recursive: true, force: true });
      stats.removed += 1;
    } catch (err) {
      stats.errors += 1;
      logger?.debug?.('[KeyframeSweeper] rm failed', {
        dir: entry.name,
        error: err?.message
      });
    }
  }

  if (stats.removed > 0) {
    logger?.info?.('[KeyframeSweeper] Removed orphan keyframe workspaces', {
      removed: stats.removed,
      scanned: stats.scanned,
      skipped: stats.skipped,
      errors: stats.errors
    });
  }

  return stats;
}

module.exports = { sweepOrphanKeyframeDirs, KEYFRAME_PREFIX, DEFAULT_MAX_AGE_MS };
