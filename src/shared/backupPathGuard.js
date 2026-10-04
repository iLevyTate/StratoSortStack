// @ts-check
const path = require('path');

/**
 * Normalize and assert that `backupPath` is strictly inside `backupDir`.
 * Uses a separator-anchored prefix so `backupDir + "evil"` cannot match.
 *
 * Every current caller validates a backup *file*, so a path equal to the
 * directory itself is rejected by default; pass `allowExact` only when the
 * directory itself is a legitimate target.
 *
 * @param {string} backupPath
 * @param {string} backupDir
 * @param {{ allowExact?: boolean }} [options]
 * @returns {string} platform-normalized absolute path
 */
function assertBackupPathContained(backupPath, backupDir, { allowExact = false } = {}) {
  if (!backupPath || typeof backupPath !== 'string') {
    throw new Error('Invalid backup path: must be a non-empty string');
  }
  if (!backupDir) {
    throw new Error('Cannot determine backup directory');
  }
  let normalizedPath = path.normalize(path.resolve(backupPath));
  let normalizedBackupDir = path.normalize(path.resolve(backupDir));
  if (process.platform === 'win32') {
    normalizedPath = normalizedPath.toLowerCase();
    normalizedBackupDir = normalizedBackupDir.toLowerCase();
  }
  if (normalizedPath === normalizedBackupDir) {
    if (allowExact) return normalizedPath;
    throw new Error(
      'Invalid backup path: must be a file inside the backup directory, not the directory itself'
    );
  }
  if (!normalizedPath.startsWith(normalizedBackupDir + path.sep)) {
    throw new Error('Invalid backup path: must be within backup directory');
  }
  return normalizedPath;
}

/**
 * Reject a backup path that is a symlink (prefix checks cannot follow it).
 * ENOENT is ignored so the caller can surface a clearer missing-file error.
 *
 * @param {string} backupPath
 * @param {{ lstat: (p: string) => Promise<{ isSymbolicLink: () => boolean }> }} fsPromises
 * @returns {Promise<void>}
 */
async function assertBackupPathNotSymlink(backupPath, fsPromises) {
  try {
    const stat = await fsPromises.lstat(backupPath);
    if (stat.isSymbolicLink()) {
      throw new Error('Backup path is a symbolic link - refused');
    }
  } catch (err) {
    if (/** @type {any} */ (err).code !== 'ENOENT') throw err;
  }
}

module.exports = {
  assertBackupPathContained,
  assertBackupPathNotSymlink
};
