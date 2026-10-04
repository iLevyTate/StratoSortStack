// @ts-check
/**
 * Folder rename path changes (K-08)
 *
 * A smart-folder rename physically moves every file inside the directory. The
 * knowledge about those files (analysis-history entries, file vectors, chunk
 * vectors, graph ids) is keyed by path, so it has to move too. This module
 * turns the analysis history into the {oldPath,newPath} pairs that
 * FilePathCoordinator.batchPathUpdate expects. Pure: no fs, no side effects.
 *
 * @module utils/folderRenamePathChanges
 */
const path = require('path');

/**
 * @param {string} platform
 */
function pathModuleFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * Normalize a path and strip any trailing separators (so "C:\A\" == "C:\A").
 * @param {string} p
 * @param {string} platform
 */
function normalizeRoot(p, platform) {
  return pathModuleFor(platform)
    .normalize(p)
    .replace(/[\\/]+$/, '');
}

/**
 * Comparison key: normalized, trailing separators stripped, case-folded where
 * the default filesystem is case-insensitive (NTFS on Windows, APFS/HFS+ on
 * macOS) and left alone elsewhere.
 * @param {string} p
 * @param {string} platform
 */
function compareKey(p, platform) {
  const normalized = normalizeRoot(p, platform);
  return platform === 'win32' || platform === 'darwin' ? normalized.toLowerCase() : normalized;
}

/**
 * A drive-letter or UNC path can only have come from Windows, so posix rules
 * (which treat a backslash as an ordinary character) would never match it.
 * @param {string} p
 */
function looksLikeWindowsPath(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/**
 * Build {oldPath,newPath} pairs for every analysis-history entry whose current
 * path lives inside `oldFolder`, so a smart-folder rename can hand them to
 * FilePathCoordinator.batchPathUpdate (K-08).
 *
 * - "current path" is the organized location (`organization.actual`) when the
 *   file was moved after analysis, otherwise `originalPath`.
 * - Duplicate history entries for one path produce a single change.
 * - Entries whose path merely shares a prefix string ("C:\Docs\Older" vs
 *   "C:\Docs\Old") are not matched: containment is checked on whole segments.
 *
 * @param {Array<{ originalPath?: string, organization?: { actual?: string | null } | null } | null> | null | undefined} entries
 * @param {string} oldFolder
 * @param {string} newFolder
 * @param {{ platform?: string }} [options] - `platform` overrides process.platform (tests)
 * @returns {Array<{ oldPath: string, newPath: string }>}
 */
function buildFolderRenamePathChanges(entries, oldFolder, newFolder, options = {}) {
  if (typeof oldFolder !== 'string' || typeof newFolder !== 'string') return [];
  const platform =
    options.platform || (looksLikeWindowsPath(oldFolder) ? 'win32' : process.platform);
  const mod = pathModuleFor(platform);
  const oldKey = compareKey(oldFolder, platform);
  const newKey = compareKey(newFolder, platform);
  if (!oldKey || !newKey || oldKey === newKey) return [];

  const prefix = oldKey + mod.sep;
  const newRoot = normalizeRoot(newFolder, platform);

  /** @type {Map<string, { oldPath: string, newPath: string }>} */
  const byOld = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const current = entry?.organization?.actual || entry?.originalPath;
    if (typeof current !== 'string' || !current) continue;
    const key = compareKey(current, platform);
    if (!key.startsWith(prefix) || byOld.has(key)) continue;
    const oldPath = mod.normalize(current);
    const relative = oldPath.slice(prefix.length);
    byOld.set(key, { oldPath, newPath: mod.join(newRoot, relative) });
  }
  return [...byOld.values()];
}

module.exports = { buildFolderRenamePathChanges };
