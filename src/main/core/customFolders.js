// @ts-check
const { app } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const { createLogger } = require('../../shared/logger');
const { getLegacyUserDataPaths } = require('./userDataMigration');
const { safeWriteFile } = require('../../shared/atomicFileOperations');
const { tryParse: safeJsonTryParse } = require('../../shared/safeJsonOps');
const { findEquivalentFolderGroups } = require('../../shared/smartFolderNameValidation');
const { scoreFolderNameForDedup } = require('../../shared/categoryFolderMatching');
const { withTimeout } = require('../../shared/promiseUtils');
const { TIMEOUTS } = require('../../shared/performanceConstants');

const logger = createLogger('CustomFolders');
const CUSTOM_FOLDERS_FILENAME = 'custom-folders.json';
const LEGACY_RECOVERY_MARKER_FILENAME = 'custom-folders-legacy-recovery.v2.json';
const LEGACY_DEFAULT_FOLDER_NAMES = new Set([
  'uncategorized',
  'documents',
  'images',
  'videos',
  'music',
  'spreadsheets',
  'presentations',
  'archives',
  // Legacy default bundle names from older builds.
  '3d print',
  'financial',
  'research',
  'work',
  'logos',
  'code'
]);

// Serialize concurrent save operations to prevent race conditions
let _saveQueue = Promise.resolve();

const normalizeName = (/** @type {any} */ value) =>
  String(value || '')
    .trim()
    .toLowerCase();

const normalizeFolderPath = (/** @type {any} */ value) => {
  if (typeof value !== 'string') return '';
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const buildFolderKey = (/** @type {any} */ folder) =>
  `${normalizeName(folder?.name)}|${normalizeFolderPath(folder?.path)}`;

let _defaultFoldersBaseDirLogged = false;

/**
 * Base directory for the default folders: the user's Documents folder, or
 * `<home>/Documents` when the OS cannot resolve Documents (app.getPath
 * throws). Never userData: organize moves user files into these folders, and
 * the uninstaller's "remove settings and data" option deletes userData
 * recursively. Logged once per process so a support log shows where
 * Uncategorized is expected.
 * @returns {string}
 */
function getDefaultFoldersBaseDir() {
  /** @type {string} */
  let documentsPath = '';
  /** @type {string | undefined} */
  let resolveError;
  try {
    documentsPath = app.getPath('documents');
  } catch (error) {
    resolveError = error?.message || String(error);
  }
  const baseDir = documentsPath || path.join(app.getPath('home'), 'Documents');
  if (!_defaultFoldersBaseDirLogged) {
    _defaultFoldersBaseDirLogged = true;
    if (documentsPath) {
      logger.info('[STORAGE] Documents folder resolved for Uncategorized', { documentsPath });
    } else {
      logger.warn('[STORAGE] Documents folder unavailable; using Documents under the home folder', {
        baseDir,
        error: resolveError
      });
    }
  }
  return baseDir;
}

/**
 * Run one stat/mkdir on an Uncategorized folder with a time bound. These calls
 * run before the main window exists, and Documents can sit on a slow or
 * offline volume (folder redirection to a network share, a cloud placeholder).
 * withTimeout cannot cancel the fs call: after a timeout it keeps running in
 * the background and may still succeed.
 * @param {() => Promise<any>} op
 * @param {string} label
 * @returns {Promise<{ ok: boolean, timedOut: boolean, value?: any, error?: any }>}
 */
async function probeFolder(op, label) {
  try {
    const value = await withTimeout(
      Promise.resolve().then(op),
      TIMEOUTS.DEFAULT_FOLDER_PROBE,
      label
    );
    return { ok: true, timedOut: false, value };
  } catch (error) {
    // withTimeout's own rejection has no errno code; an fs ETIMEDOUT does.
    const timedOut = !error?.code && /timed out after/.test(String(error?.message));
    return { ok: false, timedOut, error };
  }
}

/**
 * Create the directory for a new or healed Uncategorized entry. Never throws,
 * and the entry always keeps `preferredPath`.
 * - Timed out: the mkdir keeps running and usually lands, and organize creates
 *   a missing target directory on the first move.
 * - Failed (Controlled Folder Access, read-only or missing volume): logged and
 *   raised as a degraded-state warning. There is deliberately no fallback
 *   location: a path saved under userData would make organize move user files
 *   into the folder the uninstaller deletes. The saved Documents path is
 *   retried, and the warning raised again, on every launch until it works.
 * @param {string} preferredPath
 * @returns {Promise<string>}
 */
async function createUncategorizedDirectory(preferredPath) {
  const created = await probeFolder(
    () => fs.mkdir(preferredPath, { recursive: true }),
    'Uncategorized folder creation'
  );
  if (created.ok) {
    logger.info('[STORAGE] Created Uncategorized directory at:', preferredPath);
    return preferredPath;
  }
  if (created.timedOut) {
    logger.warn('[STORAGE] Creating the Uncategorized folder is slow; continuing without it', {
      path: preferredPath,
      timeoutMs: TIMEOUTS.DEFAULT_FOLDER_PROBE
    });
    return preferredPath;
  }

  logger.warn('[STORAGE] Could not create the Uncategorized folder', {
    path: preferredPath,
    code: created.error?.code,
    error: created.error?.message
  });
  try {
    require('../services/DegradedStateTracker')
      .getInstance()
      .raise({
        code: 'storage.uncategorized-unavailable',
        subsystem: 'storage',
        severity: 'warning',
        message: `StratoSort could not create the Uncategorized folder at ${preferredPath}, so files that match no smart folder cannot be moved there. If Windows Security's Controlled folder access is on, allow StratoSort Stack through it.`,
        detail: { path: preferredPath, code: created.error?.code }
      });
  } catch {
    // Tracker is best-effort; the warning above is already logged.
  }
  return preferredPath;
}

function getCustomFoldersPath() {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, CUSTOM_FOLDERS_FILENAME);
}

function getLegacyRecoveryMarkerPath() {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, LEGACY_RECOVERY_MARKER_FILENAME);
}

function normalizeFolderPaths(/** @type {any} */ folders) {
  try {
    return (Array.isArray(folders) ? folders : []).map((f) => {
      const normalized = { ...f };
      const normalizedName = normalizeName(normalized?.name);
      const normalizedPathKey = normalizeFolderPath(normalized?.path);

      // Backward-compat: older custom-folders.json entries may miss an id.
      // Heal ids during load so startup validation doesn't drop legitimate folders.
      if (typeof normalized.id !== 'string' || !normalized.id.trim()) {
        if (normalizedName && normalizedPathKey) {
          const hash = crypto
            .createHash('sha1')
            .update(`${normalizedName}|${normalizedPathKey}`)
            .digest('hex')
            .slice(0, 12);
          normalized.id = `custom-${hash}`;
        } else {
          normalized.id = `custom-${crypto.randomUUID().slice(0, 8)}`;
        }
      } else {
        normalized.id = normalized.id.trim();
      }

      if (normalized && typeof normalized.path === 'string' && normalized.path.trim()) {
        normalized.path = path.normalize(normalized.path);
      }
      return normalized;
    });
  } catch (err) {
    logger.debug('[STORAGE] normalizeFolderList failed', { error: err?.message || String(err) });
    return Array.isArray(folders) ? folders : [];
  }
}

/**
 * Ensure the essential Uncategorized fallback folder exists.
 * We no longer auto-inject the full default set — users choose their own
 * folder structure. The full defaults are only applied via "Reset to Defaults".
 */
async function ensureUncategorizedFolder(/** @type {any} */ folders) {
  const safeFolders = Array.isArray(folders) ? folders : [];
  const baseDir = getDefaultFoldersBaseDir();
  const uncategorizedIndex = safeFolders.findIndex(
    (folder) => normalizeName(folder?.name) === 'uncategorized'
  );

  if (uncategorizedIndex >= 0) {
    const existingFolder = safeFolders[uncategorizedIndex] || {};
    const existingPath = String(existingFolder.path || '').trim();
    if (existingPath) {
      // A probe that times out leaves the saved entry alone: rewriting the
      // user's configuration because one launch found the volume slow would
      // be worse than a folder that organize creates on its first move.
      const statResult = await probeFolder(
        () => fs.stat(existingPath),
        'Uncategorized folder check'
      );
      if (statResult.ok && statResult.value?.isDirectory?.()) {
        return safeFolders;
      }
      if (statResult.ok) {
        logger.warn(
          '[STORAGE] Uncategorized path exists but is not a directory; healing to canonical path',
          { path: existingPath }
        );
      } else if (statResult.timedOut) {
        logger.warn('[STORAGE] Uncategorized folder check is slow; keeping the saved path', {
          path: existingPath,
          timeoutMs: TIMEOUTS.DEFAULT_FOLDER_PROBE
        });
        return safeFolders;
      } else {
        logger.debug('[STORAGE] stat failed for Uncategorized path', {
          path: existingPath,
          error: statResult.error?.message || String(statResult.error)
        });
        const recreated = await probeFolder(
          () => fs.mkdir(existingPath, { recursive: true }),
          'Uncategorized folder re-creation'
        );
        if (recreated.ok) {
          logger.info('[STORAGE] Recreated missing Uncategorized directory at:', existingPath);
          return safeFolders;
        }
        if (recreated.timedOut) {
          logger.warn(
            '[STORAGE] Recreating the Uncategorized folder is slow; keeping the saved path',
            {
              path: existingPath,
              timeoutMs: TIMEOUTS.DEFAULT_FOLDER_PROBE
            }
          );
          return safeFolders;
        }
        logger.warn(
          '[STORAGE] Failed to recreate existing Uncategorized path; healing to canonical path',
          { path: existingPath, error: recreated.error?.message }
        );
      }
    }

    const canonical = createUncategorizedFolder(baseDir);
    const healedPath = await createUncategorizedDirectory(canonical.path);
    const healedFolder = {
      ...canonical,
      ...existingFolder,
      path: healedPath,
      name: existingFolder.name || canonical.name,
      isDefault: true
    };
    const updatedFolders = [...safeFolders];
    updatedFolders[uncategorizedIndex] = healedFolder;
    logger.info('[STORAGE] Healed Uncategorized folder path:', healedFolder.path);

    try {
      await saveCustomFolders(updatedFolders);
      logger.info('[STORAGE] Persisted healed Uncategorized folder path');
    } catch (error) {
      logger.error('[STORAGE] Failed to persist healed Uncategorized folder path:', error);
    }

    return updatedFolders;
  }

  const uncategorized = createUncategorizedFolder(baseDir);

  logger.info('[STORAGE] Adding missing Uncategorized fallback folder');
  uncategorized.path = await createUncategorizedDirectory(uncategorized.path);

  const updatedFolders = [...safeFolders, uncategorized];

  try {
    await saveCustomFolders(updatedFolders);
    logger.info('[STORAGE] Persisted Uncategorized folder to custom-folders.json');
  } catch (error) {
    logger.error('[STORAGE] Failed to persist Uncategorized folder:', error);
  }

  return updatedFolders;
}

async function readCustomFoldersFile(/** @type {any} */ filePath) {
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    if (!data || typeof data !== 'string') return null;
    // safeJsonTryParse discards __proto__-style injection and surfaces parse
    // failures without throwing, so a corrupt user-writable file doesn't take
    // down the calling flow — we just return null and the caller falls back
    // to defaults / backup recovery.
    const parseResult = safeJsonTryParse(data);
    if (!parseResult.success) {
      logger.warn('[STORAGE] custom-folders file is corrupt; falling back to recovery', {
        error: parseResult.error?.message
      });
      return null;
    }
    const parsed = parseResult.value;
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch (err) {
    logger.debug('[STORAGE] readCustomFoldersFile failed', { error: err?.message || String(err) });
    return null;
  }
}

async function readLegacyRecoveryMarker() {
  try {
    const raw = await fs.readFile(getLegacyRecoveryMarkerPath(), 'utf-8');
    if (!raw || typeof raw !== 'string') return null;
    const parseResult = safeJsonTryParse(raw);
    if (!parseResult.success) {
      logger.debug('[STORAGE] legacy recovery marker is corrupt; ignoring', {
        error: parseResult.error?.message
      });
      return null;
    }
    const parsed = parseResult.value;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    logger.debug('[STORAGE] readLegacyRecoveryMarker failed', {
      error: err?.message || String(err)
    });
    return null;
  }
}

async function writeLegacyRecoveryMarker(/** @type {any} */ payload) {
  try {
    await fs.writeFile(
      getLegacyRecoveryMarkerPath(),
      JSON.stringify(
        {
          completed: true,
          markerVersion: 2,
          updatedAt: new Date().toISOString(),
          ...payload
        },
        null,
        2
      )
    );
  } catch (error) {
    logger.warn('[STORAGE] Failed to persist legacy recovery marker', { error: error.message });
  }
}

function isRecoverableCustomFolder(
  /** @type {any} */ folder,
  /** @type {any} */ defaultNameSet,
  /** @type {any} */ defaultPathByName = null,
  { allowDefaultNameCustomPath = false, treatLegacyNameNonDefaultAsCustom = false } = {}
) {
  const nameKey = normalizeName(folder?.name);
  if (!nameKey) return false;
  if (folder?.isDefault === true) return false;

  // Treat known default names as defaults even if legacy metadata incorrectly
  // marked them as non-default, unless the path clearly differs from the
  // canonical default path (which indicates a real custom folder).
  if (defaultNameSet.has(nameKey)) {
    const canonicalPath = defaultPathByName?.get(nameKey) || '';
    const candidatePath = normalizeFolderPath(folder?.path);
    // If this name maps to a known current default path and matches it,
    // it is definitely a default entry and should never be recovered.
    if (canonicalPath && candidatePath && candidatePath === canonicalPath) {
      return false;
    }

    // Current default names (e.g. Documents/Images) are only recoverable
    // when explicitly allowed and their path differs from the canonical path.
    if (
      allowDefaultNameCustomPath &&
      folder?.isDefault === false &&
      canonicalPath &&
      candidatePath &&
      candidatePath !== canonicalPath
    ) {
      return true;
    }

    // Legacy-only default names (e.g. Work/Research from old bundles) can be
    // legitimate user folders when persisted as non-default entries.
    if (treatLegacyNameNonDefaultAsCustom && folder?.isDefault === false && !canonicalPath) {
      return true;
    }

    return false;
  }
  if (folder?.isDefault === false) return true;
  return true;
}

function shouldPruneLegacyDefaultBundle(
  /** @type {any} */ folders,
  /** @type {any} */ currentDefaultNameSet
) {
  const safeFolders = Array.isArray(folders) ? folders : [];
  if (safeFolders.length === 0) return false;

  const allEntriesMarkedDefault = safeFolders.every((folder) => folder?.isDefault === true);
  if (!allEntriesMarkedDefault) return false;

  const hasLegacyOnlyDefaultName = safeFolders.some((folder) => {
    const nameKey = normalizeName(folder?.name);
    return (
      nameKey && LEGACY_DEFAULT_FOLDER_NAMES.has(nameKey) && !currentDefaultNameSet.has(nameKey)
    );
  });

  return hasLegacyOnlyDefaultName;
}

async function pruneToUncategorizedOnly(/** @type {any} */ folders) {
  const safeFolders = Array.isArray(folders) ? folders : [];
  const uncategorizedOnly = safeFolders.filter(
    (folder) => normalizeName(folder?.name) === 'uncategorized'
  );
  const prunedInput = uncategorizedOnly.length > 0 ? [uncategorizedOnly[0]] : [];
  const ensured = await ensureUncategorizedFolder(prunedInput);
  await saveCustomFolders(ensured);
  return ensured;
}

function mergeFolders(/** @type {any} */ currentFolders, /** @type {any} */ legacyFolders) {
  const merged = [];
  const seenKeys = new Set();

  for (const folder of currentFolders) {
    const key = buildFolderKey(folder);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    merged.push(folder);
  }

  for (const folder of legacyFolders) {
    const key = buildFolderKey(folder);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    merged.push(folder);
  }

  return merged;
}

function getRecoverableFolderKeys(
  /** @type {any} */ folders,
  /** @type {any} */ defaultNameSet,
  /** @type {any} */ defaultPathByName = null,
  options = {}
) {
  return (Array.isArray(folders) ? folders : [])
    .filter((folder) =>
      isRecoverableCustomFolder(folder, defaultNameSet, defaultPathByName, {
        allowDefaultNameCustomPath: true,
        treatLegacyNameNonDefaultAsCustom: true,
        ...options
      })
    )
    .map((folder) => buildFolderKey(folder))
    .filter(Boolean);
}

async function recoverLegacyCustomFolders(
  /** @type {any} */ currentFolders,
  /** @type {any} */ defaultNameSet,
  /** @type {any} */ defaultPathByName = null
) {
  const recoveryMarker = await readLegacyRecoveryMarker();
  const currentRecoverableKeys = new Set(
    getRecoverableFolderKeys(currentFolders, defaultNameSet, defaultPathByName)
  );
  const markerFolderKeys = Array.isArray(recoveryMarker?.folderKeys)
    ? recoveryMarker.folderKeys.filter(
        (/** @type {any} */ key) => typeof key === 'string' && key.length > 0
      )
    : [];
  const markerStillMatchesCurrentState =
    markerFolderKeys.length > 0
      ? markerFolderKeys.every((/** @type {any} */ key) => currentRecoverableKeys.has(key))
      : currentRecoverableKeys.size > 0;

  if (recoveryMarker?.completed === true && markerStillMatchesCurrentState) {
    return currentFolders;
  }

  const legacyPaths = getLegacyUserDataPaths();
  const recoveredFolders = [];
  const sources = [];
  const scannedSources = [];

  for (const legacyPath of legacyPaths) {
    const legacyFilePath = path.join(legacyPath, CUSTOM_FOLDERS_FILENAME);
    const legacyData = await readCustomFoldersFile(legacyFilePath);
    if (!legacyData) continue;
    scannedSources.push(legacyFilePath);
    if (legacyData.length === 0) continue;
    const normalizedLegacy = normalizeFolderPaths(legacyData);
    const recoverableLegacy = normalizedLegacy.filter((folder) =>
      isRecoverableCustomFolder(folder, defaultNameSet, defaultPathByName, {
        treatLegacyNameNonDefaultAsCustom: true
      })
    );
    if (recoverableLegacy.length === 0) continue;
    recoveredFolders.push(...recoverableLegacy);
    sources.push(legacyFilePath);
  }

  if (recoveredFolders.length === 0) {
    // Only mark recovery complete after at least one legacy source was
    // successfully scanned. This avoids permanently disabling recovery when
    // legacy paths are transiently unavailable during startup/migration.
    if (scannedSources.length > 0) {
      await writeLegacyRecoveryMarker({
        addedCount: 0,
        sources: scannedSources,
        folderKeys: Array.from(currentRecoverableKeys)
      });
    }
    return currentFolders;
  }

  const merged = mergeFolders(currentFolders, recoveredFolders);
  const addedCount = merged.length - currentFolders.length;
  const mergedRecoverableKeys = getRecoverableFolderKeys(merged, defaultNameSet, defaultPathByName);
  if (addedCount <= 0) {
    await writeLegacyRecoveryMarker({
      addedCount: 0,
      sources,
      folderKeys: mergedRecoverableKeys
    });
    return currentFolders;
  }

  try {
    await saveCustomFolders(merged);
    await writeLegacyRecoveryMarker({
      addedCount,
      sources,
      folderKeys: mergedRecoverableKeys
    });
    logger.warn('[STORAGE] Recovered custom smart folders from legacy data', {
      addedCount,
      sources
    });
  } catch (error) {
    logger.error('[STORAGE] Failed to persist recovered custom folders:', error);
  }

  return merged;
}

/**
 * Create a single Uncategorized folder entry.
 * Used for first-launch bootstrapping and the ensureUncategorizedFolder guard.
 */
function createUncategorizedFolder(/** @type {any} */ baseDir) {
  return {
    id: `default-uncategorized-${crypto.randomUUID().slice(0, 8)}`,
    name: 'Uncategorized',
    path: path.join(baseDir, 'Uncategorized'),
    description: "Default folder for files that don't match any smart folder",
    /** @type {string[]} */
    keywords: [],
    category: 'uncategorized',
    isDefault: true,
    createdAt: new Date().toISOString()
  };
}

/**
 * Build a new Uncategorized entry with its directory created (bounded, never
 * throws; see createUncategorizedDirectory). Startup uses it when no default
 * folder survived loading and validation.
 */
async function createDefaultUncategorizedFolder() {
  const folder = createUncategorizedFolder(getDefaultFoldersBaseDir());
  folder.path = await createUncategorizedDirectory(folder.path);
  return folder;
}

/**
 * Full default smart folders that match the categorization system in fallbackUtils.js
 * Only used when the user explicitly clicks "Reset to Defaults"
 */
function getDefaultSmartFolders(/** @type {any} */ baseDir) {
  // Two calls in the same millisecond previously produced identical IDs.
  const uid = () => crypto.randomUUID().slice(0, 8);
  return [
    {
      id: `default-documents-${uid()}`,
      name: 'Documents',
      path: path.join(baseDir, 'Documents'),
      description: 'PDF, Word, and text documents',
      keywords: ['document', 'pdf', 'doc', 'docx', 'txt', 'rtf', 'odt'],
      category: 'documents',
      isDefault: true,
      createdAt: new Date().toISOString()
    },
    {
      id: `default-images-${uid()}`,
      name: 'Images',
      path: path.join(baseDir, 'Images'),
      description: 'Photos and image files',
      keywords: ['image', 'photo', 'picture', 'png', 'jpg', 'jpeg', 'gif', 'svg'],
      category: 'images',
      isDefault: true,
      createdAt: new Date().toISOString()
    },
    {
      id: `default-videos-${uid()}`,
      name: 'Videos',
      path: path.join(baseDir, 'Videos'),
      description: 'Video and movie files',
      keywords: ['video', 'movie', 'mp4', 'avi', 'mov', 'mkv', 'recording'],
      category: 'videos',
      isDefault: true,
      createdAt: new Date().toISOString()
    },
    {
      id: `default-music-${uid()}`,
      name: 'Music',
      path: path.join(baseDir, 'Music'),
      description: 'Audio and music files',
      keywords: ['music', 'audio', 'mp3', 'wav', 'flac', 'song', 'sound'],
      category: 'music',
      isDefault: true,
      createdAt: new Date().toISOString()
    },
    {
      id: `default-spreadsheets-${uid()}`,
      name: 'Spreadsheets',
      path: path.join(baseDir, 'Spreadsheets'),
      description: 'Excel and spreadsheet files',
      keywords: ['spreadsheet', 'excel', 'xlsx', 'xls', 'csv', 'table', 'data'],
      category: 'spreadsheets',
      isDefault: true,
      createdAt: new Date().toISOString()
    },
    {
      id: `default-presentations-${uid()}`,
      name: 'Presentations',
      path: path.join(baseDir, 'Presentations'),
      description: 'PowerPoint and presentation files',
      keywords: ['presentation', 'powerpoint', 'pptx', 'ppt', 'slides', 'deck'],
      category: 'presentations',
      isDefault: true,
      createdAt: new Date().toISOString()
    },
    {
      id: `default-archives-${uid()}`,
      name: 'Archives',
      path: path.join(baseDir, 'Archives'),
      description: 'Compressed and archive files',
      keywords: ['archive', 'zip', 'rar', '7z', 'tar', 'compressed', 'backup'],
      category: 'archives',
      isDefault: true,
      createdAt: new Date().toISOString()
    },
    {
      id: `default-uncategorized-${uid()}`,
      name: 'Uncategorized',
      path: path.join(baseDir, 'Uncategorized'),
      description: "Default folder for files that don't match any smart folder",
      keywords: [],
      category: 'uncategorized',
      isDefault: true,
      createdAt: new Date().toISOString()
    }
  ];
}

/**
 * Surface canonical-equivalent smart-folder pairs (e.g. "Logos" +
 * "Logos and Graphic Design") at startup as a single warn-level line per
 * group. The dedup guard in `handleSmartFoldersAdd` prevents NEW
 * duplicates from being added (returns FOLDER_NAME_EQUIVALENT), but any
 * pair that already existed in `custom-folders.json` before that guard
 * landed will silently survive. This log lets the user spot them without
 * digging through analysis logs, and gives reviewers a runtime signal
 * that the existing-duplicate-migration follow-up is still needed.
 *
 * @param {Array<{name?: string, id?: string, path?: string}>} folders
 */
function warnAboutEquivalentFolders(folders) {
  try {
    const groups = findEquivalentFolderGroups(folders);
    for (const group of groups) {
      const entries = group.indices
        .map((idx) => {
          const f = folders[idx] || {};
          return {
            id: typeof f.id === 'string' ? f.id : null,
            name: typeof f.name === 'string' ? f.name : null,
            path: typeof f.path === 'string' ? f.path : null
          };
        })
        .filter((entry) => entry.name);
      logger.warn(
        '[SMART-FOLDERS] Canonical-equivalent folders detected — consider merging one side via Settings',
        {
          names: group.names,
          entries
        }
      );
    }
  } catch (err) {
    // Detection is observability, not correctness — never let it crash
    // the startup load. A failure here just means no warning is emitted.
    logger.debug('[SMART-FOLDERS] Equivalent-folder detector failed (non-fatal)', {
      error: err?.message || String(err)
    });
  }
}

/**
 * Remove duplicate smart-folder records that share the same id and path, and
 * collapse canonical-equivalent name groups (keep the longest name). Returns
 * a new array; does not mutate the input.
 *
 * @param {Array<{id?: string, path?: string, name?: string}>} folders
 * @returns {{folders: any[], removedCount: number}}
 */
function dedupeSmartFoldersOnLoad(folders) {
  const safe = Array.isArray(folders) ? folders : [];
  if (safe.length === 0) return { folders: safe, removedCount: 0 };

  const byIdPath = new Map();
  const withoutIdPath = [];
  for (const folder of safe) {
    const id = typeof folder?.id === 'string' ? folder.id.trim() : '';
    const folderPath = typeof folder?.path === 'string' ? normalizeFolderPath(folder.path) : '';
    if (id && folderPath) {
      const key = `${id.toLowerCase()}::${folderPath.toLowerCase()}`;
      const existing = byIdPath.get(key);
      if (!existing) {
        byIdPath.set(key, folder);
        continue;
      }
      const keepExisting =
        scoreFolderNameForDedup(existing.name) >= scoreFolderNameForDedup(folder.name);
      byIdPath.set(key, keepExisting ? existing : folder);
    } else {
      withoutIdPath.push(folder);
    }
  }

  let deduped = [...byIdPath.values(), ...withoutIdPath];
  const groups = findEquivalentFolderGroups(deduped);
  if (groups.length === 0) {
    const removedCount = safe.length - deduped.length;
    return { folders: deduped, removedCount };
  }

  const dropIndices = new Set();
  for (const group of groups) {
    const indices = group.indices || [];
    if (indices.length < 2) continue;
    let keepIdx = indices[0];
    for (const idx of indices) {
      const candidateScore = scoreFolderNameForDedup(deduped[idx]?.name);
      const keepScore = scoreFolderNameForDedup(deduped[keepIdx]?.name);
      if (candidateScore > keepScore) keepIdx = idx;
    }
    for (const idx of indices) {
      if (idx !== keepIdx) dropIndices.add(idx);
    }
  }

  if (dropIndices.size > 0) {
    deduped = deduped.filter((_, idx) => !dropIndices.has(idx));
    logger.info('[SMART-FOLDERS] Auto-deduped canonical-equivalent folders on load', {
      removedCount: dropIndices.size,
      groups: groups.map((g) => g.names)
    });
  }

  const removedCount = safe.length - deduped.length;
  return { folders: deduped, removedCount };
}

async function loadCustomFolders() {
  const folders = await _loadCustomFoldersImpl();
  const { folders: deduped, removedCount } = dedupeSmartFoldersOnLoad(folders);
  if (removedCount > 0) {
    try {
      await saveCustomFolders(deduped);
      logger.info('[SMART-FOLDERS] Persisted deduplicated custom folders', { removedCount });
    } catch (err) {
      logger.warn('[SMART-FOLDERS] Failed to persist deduplicated folders (non-fatal)', {
        error: err?.message
      });
    }
  }
  warnAboutEquivalentFolders(deduped);
  return deduped;
}

async function _loadCustomFoldersImpl() {
  try {
    const filePath = getCustomFoldersPath();
    const data = await fs.readFile(filePath, 'utf-8');
    const parseResult = safeJsonTryParse(data);
    if (!parseResult.success) {
      throw new Error(
        `Invalid custom folders JSON: ${parseResult.error?.message || 'parse failed'}`
      );
    }
    const parsed = parseResult.value;
    if (!Array.isArray(parsed)) {
      throw new Error('Invalid custom folders format: expected array');
    }
    const normalized = normalizeFolderPaths(parsed);
    const baseDir = getDefaultFoldersBaseDir();
    const currentDefaultNameSet = new Set(
      getDefaultSmartFolders(baseDir).map((folder) => normalizeName(folder.name))
    );
    const defaultPathByName = new Map(
      getDefaultSmartFolders(baseDir).map((folder) => [
        normalizeName(folder.name),
        normalizeFolderPath(folder.path)
      ])
    );
    const defaultNameSet = new Set([...currentDefaultNameSet, ...LEGACY_DEFAULT_FOLDER_NAMES]);

    if (shouldPruneLegacyDefaultBundle(normalized, currentDefaultNameSet)) {
      logger.warn(
        '[STARTUP] Detected legacy default-only smart-folder bundle; pruning to fallback'
      );
      return await pruneToUncategorizedOnly(normalized);
    }

    const recovered = await recoverLegacyCustomFolders(
      normalized,
      defaultNameSet,
      defaultPathByName
    );

    // Only ensure the essential Uncategorized fallback exists
    return await ensureUncategorizedFolder(recovered);
  } catch (err) {
    logger.debug('[STORAGE] loadCustomFolders primary path failed, attempting recovery', {
      error: err?.message || String(err)
    });
    const baseDir = getDefaultFoldersBaseDir();
    const currentDefaultNameSet = new Set(
      getDefaultSmartFolders(baseDir).map((folder) => normalizeName(folder.name))
    );
    const defaultPathByName = new Map(
      getDefaultSmartFolders(baseDir).map((folder) => [
        normalizeName(folder.name),
        normalizeFolderPath(folder.path)
      ])
    );
    const defaultNameSet = new Set([...currentDefaultNameSet, ...LEGACY_DEFAULT_FOLDER_NAMES]);

    const backupRestore = await restoreFromBackup();
    if (backupRestore?.success && Array.isArray(backupRestore.folders)) {
      const normalizedBackup = normalizeFolderPaths(backupRestore.folders);
      if (shouldPruneLegacyDefaultBundle(normalizedBackup, currentDefaultNameSet)) {
        logger.warn(
          '[STARTUP] Detected legacy default-only smart-folder backup; pruning to fallback'
        );
        return await pruneToUncategorizedOnly(normalizedBackup);
      }
      const recoveredFromBackup = await recoverLegacyCustomFolders(
        normalizedBackup,
        defaultNameSet,
        defaultPathByName
      );
      return await ensureUncategorizedFolder(recoveredFromBackup);
    }

    const recoveredLegacy = await recoverLegacyCustomFolders([], defaultNameSet, defaultPathByName);
    if (recoveredLegacy.length > 0) {
      return await ensureUncategorizedFolder(recoveredLegacy);
    }

    logger.info('[STARTUP] No saved custom folders found, creating Uncategorized fallback');

    // First launch: only create the essential Uncategorized folder.
    // Users build their own folder structure; full defaults are available via "Reset to Defaults".
    const uncategorized = createUncategorizedFolder(baseDir);
    uncategorized.path = await createUncategorizedDirectory(uncategorized.path);

    try {
      await saveCustomFolders([uncategorized]);
      logger.info('[STARTUP] Saved Uncategorized folder to disk');
    } catch (err) {
      logger.error('[STARTUP] Failed to save Uncategorized folder:', err);
    }

    return [uncategorized];
  }
}

function saveCustomFolders(/** @type {any} */ folders) {
  // Serialize saves through a queue to prevent concurrent write races
  const op = _saveQueue
    .then(() => _doSaveCustomFolders(folders))
    .catch((error) => {
      logger.error('[ERROR] Failed to save custom folders:', error);
      throw error;
    });
  _saveQueue = op.catch((err) => {
    if (err?.code !== 'ENOENT') {
      logger.debug('[CustomFolders] Save queue error suppressed:', err?.message);
    }
  }); // Ensure queue continues even after errors
  return op;
}

async function _doSaveCustomFolders(/** @type {any} */ folders) {
  const filePath = getCustomFoldersPath();
  const toSave = normalizeFolderPaths(folders);
  const data = JSON.stringify(toSave, null, 2);

  // Create backup before saving to prevent data loss
  try {
    const existingData = await fs.readFile(filePath, 'utf-8');
    if (existingData && existingData.trim()) {
      const backupPath = `${filePath}.backup`;
      await fs.writeFile(backupPath, existingData);
      logger.debug('[STORAGE] Created backup of custom folders');
    }
  } catch (backupError) {
    // File might not exist yet, that's OK
    if (backupError.code !== 'ENOENT') {
      logger.warn('[STORAGE] Failed to create backup:', backupError.message);
    }
  }

  await safeWriteFile(filePath, data);

  logger.info('[STORAGE] Saved custom folders to:', filePath);
}

/**
 * Reset smart folders to defaults.
 * Replaces saved configuration and creates each default folder path directly
 * under the user's Documents directory (mkdir recursive) when missing.
 */
async function resetToDefaultFolders() {
  const baseDir = getDefaultFoldersBaseDir();
  const defaultFolders = getDefaultSmartFolders(baseDir);

  // Create physical directories for each folder
  for (const folder of defaultFolders) {
    try {
      await fs.mkdir(folder.path, { recursive: true });
      logger.info(`[RESET] Created directory: ${folder.name}`);
    } catch (err) {
      logger.error(`[RESET] Failed to create ${folder.name} directory:`, err);
    }
  }

  // Save the default folders
  await saveCustomFolders(defaultFolders);
  logger.info('[RESET] Reset smart folders to defaults');

  return defaultFolders;
}

/**
 * Restore smart folders from backup
 * Used when the main file is corrupted
 */
async function restoreFromBackup() {
  const filePath = getCustomFoldersPath();
  const backupPath = `${filePath}.backup`;

  try {
    const backupData = await fs.readFile(backupPath, 'utf-8');
    const parseResult = safeJsonTryParse(backupData);
    if (!parseResult.success) {
      logger.warn('[STORAGE] Backup file contains invalid JSON', {
        error: parseResult.error?.message
      });
      return { success: false, error: 'Backup file contains invalid JSON' };
    }
    const parsed = parseResult.value;

    if (!Array.isArray(parsed) || parsed.length === 0) {
      logger.warn('[STORAGE] Backup file is empty or invalid');
      return { success: false, error: 'Backup file is empty or invalid' };
    }

    // Restore the backup using atomic write (temp + rename). Random suffix
    // prevents two writers in the same millisecond from racing on the .tmp
    // path; on Windows the loser's catch-block unlink could delete the
    // winner's file mid-rename.
    const tempPath = `${filePath}.tmp.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
    try {
      await fs.writeFile(tempPath, backupData);
      await fs.rename(tempPath, filePath);
    } catch (restoreError) {
      try {
        await fs.unlink(tempPath);
      } catch (unlinkErr) {
        logger.debug('[STORAGE] Temp cleanup after restore failed', {
          tempPath,
          error: unlinkErr?.message || String(unlinkErr)
        });
      }
      throw restoreError;
    }
    logger.info('[STORAGE] Restored custom folders from backup');

    return { success: true, folders: parsed };
  } catch (error) {
    logger.error('[STORAGE] Failed to restore from backup:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  getCustomFoldersPath,
  loadCustomFolders,
  saveCustomFolders,
  createDefaultUncategorizedFolder,
  getDefaultSmartFolders,
  resetToDefaultFolders,
  restoreFromBackup,
  dedupeSmartFoldersOnLoad
};
