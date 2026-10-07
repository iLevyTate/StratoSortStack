// @ts-check
const { app } = require('electron');
const fs = require('fs').promises;
const path = require('path');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('UserDataMigration');
// Legacy folder names are intentionally preserved here for backward-compatible migrations.
// Includes the previous product folder 'StratoSort Core' and 'stratosort-core'
// (the old package name used in dev) so models and settings from those installs
// are discoverable when running this build (productName 'StratoSort Stack').
const LEGACY_USERDATA_FOLDERS = [
  'StratoSort Core',
  'stratosort-core',
  'StratoSort',
  'stratosort',
  'elstratosort',
  'Electron',
  'StratoSort-dev',
  'stratosort-dev',
  'stratosort-core-dev'
];

const STATE_FILES = [
  { name: 'settings.json', label: 'settings' },
  { name: 'analysis-history.json', label: 'analysis history' },
  { name: 'analysis-index.json', label: 'analysis index' },
  { name: 'analysis-config.json', label: 'analysis config' },
  { name: 'processing-state.json', label: 'processing state' },
  { name: 'undo-actions.json', label: 'undo history' },
  { name: 'user-patterns.json', label: 'organization patterns' },
  { name: 'feedback-memory.json', label: 'feedback memory' },
  { name: 'knowledge-relationships.json', label: 'knowledge graph' },
  { name: 'window-state.json', label: 'window state' }
];

function getUserDataRoot() {
  const currentUserDataPath = app.getPath('userData');
  return path.dirname(currentUserDataPath);
}

function getLegacyUserDataPaths() {
  const baseDir = getUserDataRoot();
  const currentUserDataPath = path.resolve(app.getPath('userData'));
  const candidates = LEGACY_USERDATA_FOLDERS.map((folder) => path.join(baseDir, folder));
  const uniquePaths = new Set();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (resolved === currentUserDataPath) continue;
    uniquePaths.add(resolved);
  }
  return Array.from(uniquePaths);
}

async function getFileStats(/** @type {any} */ filePath) {
  try {
    return await fs.stat(filePath);
  } catch (err) {
    logger.debug('[UserDataMigration] stat failed', {
      filePath,
      error: err?.message || String(err)
    });
    return null;
  }
}

async function isUsableFile(/** @type {any} */ filePath) {
  const stats = await getFileStats(filePath);
  return Boolean(stats && stats.isFile() && stats.size > 0);
}

async function findLatestLegacyFile(/** @type {any} */ fileName, /** @type {any} */ legacyPaths) {
  let best = null;
  for (const legacyPath of legacyPaths) {
    const candidatePath = path.join(legacyPath, fileName);
    const stats = await getFileStats(candidatePath);
    if (!stats || !stats.isFile() || stats.size === 0) continue;
    const mtime = stats.mtimeMs || stats.mtime?.getTime?.() || 0;
    if (!best || mtime > best.mtime) {
      best = { path: candidatePath, mtime };
    }
  }
  return best;
}

async function copyLegacyFileIfMissing(
  /** @type {any} */ fileName,
  /** @type {any} */ legacyPaths
) {
  const currentPath = path.join(app.getPath('userData'), fileName);
  if (await isUsableFile(currentPath)) {
    return { status: 'kept', currentPath };
  }

  const bestLegacy = await findLatestLegacyFile(fileName, legacyPaths);
  if (!bestLegacy) {
    return { status: 'missing', currentPath };
  }

  try {
    await fs.copyFile(bestLegacy.path, currentPath);
  } catch (error) {
    // Best-effort migration: a locked/unreadable legacy file (EBUSY, EACCES,
    // ENOSPC) must not reject the whole migration — that was escalating into
    // a fully degraded startup over an optional convenience copy.
    logger.warn('[USERDATA] Failed to copy legacy state file; skipping', {
      file: fileName,
      from: bestLegacy.path,
      error: error?.message
    });
    return { status: 'failed', currentPath, legacyPath: bestLegacy.path };
  }
  return { status: 'migrated', currentPath, legacyPath: bestLegacy.path };
}

/** @param {{ legacyPaths?: any[], files?: any[] }} [options] */
async function migrateUserDataState(options = {}) {
  const legacyPaths = Array.isArray(options.legacyPaths)
    ? options.legacyPaths
    : getLegacyUserDataPaths();
  const files =
    Array.isArray(options.files) && options.files.length > 0 ? options.files : STATE_FILES;
  /** @type {{ migrated: any[], skipped: any[], missing: any[], failed: any[] }} */
  const results = {
    migrated: [],
    skipped: [],
    missing: [],
    failed: []
  };

  for (const file of files) {
    const fileName = typeof file === 'string' ? file : file.name;
    if (!fileName) continue;
    const label = typeof file === 'string' ? file : file.label || fileName;
    const result = await copyLegacyFileIfMissing(fileName, legacyPaths);
    if (result.status === 'migrated') {
      results.migrated.push({ file: fileName, label, from: result.legacyPath });
    } else if (result.status === 'kept') {
      results.skipped.push({ file: fileName, label });
    } else if (result.status === 'failed') {
      results.failed.push({ file: fileName, label, from: result.legacyPath });
    } else {
      results.missing.push({ file: fileName, label });
    }
  }

  if (results.migrated.length > 0) {
    logger.warn('[USERDATA] Migrated legacy state files', {
      migrated: results.migrated.map((entry) => entry.file)
    });
  } else {
    logger.info('[USERDATA] No legacy state files needed migration');
  }

  return results;
}

module.exports = {
  migrateUserDataState,
  getLegacyUserDataPaths,
  LEGACY_USERDATA_FOLDERS,
  STATE_FILES
};
