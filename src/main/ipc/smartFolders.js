// @ts-check
const path = require('path');
const crypto = require('crypto');
const fs = require('fs').promises;
const { app } = require('electron');
const { getInstance: getLlamaService } = require('../services/LlamaService');
const { getTextModel } = require('../llamaUtils');
const { TIMEOUTS } = require('../../shared/performanceConstants');
const { withAbortableTimeout, delay } = require('../../shared/promiseUtils');
const { AI_DEFAULTS, IPC_EVENTS } = require('../../shared/constants');
const { enhanceSmartFolderWithLLM } = require('../services/SmartFoldersLLMService');
const { createHandler, safeHandle, safeSend, z } = require('./ipcWrappers');
const { schemaFolderMatch, schemas: validationSchemas } = require('./validationSchemas');
const { extractAndParseJSON } = require('../utils/jsonRepair');
const { cosineSimilarity } = require('../../shared/vectorMath');
const { isNotFoundError } = require('../../shared/errorClassifier');
const FolderMatchingService = require('../services/FolderMatchingService');
const {
  getInstance: getParallelEmbeddingService
} = require('../services/ParallelEmbeddingService');
const {
  enrichFolderTextForEmbedding,
  enrichFileTextForEmbedding
} = require('../analysis/semanticExtensionMap');

// Import centralized security configuration
const { ALLOWED_APP_PATHS } = require('../../shared/securityConfig');
const {
  validateFileOperationPathSync,
  validateFileOperationPath
} = require('../../shared/pathSanitization');
const { renameNoReplace } = require('../../shared/atomicFileOperations');
const { authorizeSmartFolderRoot } = require('./files/destinationPolicy');
const { buildFolderRenamePathChanges } = require('../utils/folderRenamePathChanges');

const { ERROR_CODES } = require('../../shared/errorHandlingUtils');

const {
  isUNCPath,
  isWindowsDeviceNamespacePath,
  isCaseInsensitiveFileSystem
} = require('../../shared/crossPlatformUtils');
const {
  validateSmartFolderName,
  namesAreEquivalent
} = require('../../shared/smartFolderNameValidation');

/** @typedef {import('./ipcWrappers').LoggerLike} LoggerLike */
/**
 * Invoke event as delivered by ipcRegistry: Electron's IpcMainInvokeEvent plus
 * the cooperative-cancellation signal attached as a non-enumerable property in
 * src/main/core/ipcRegistry.js.
 * @typedef {import('electron').IpcMainInvokeEvent & { abortSignal?: AbortSignal }} IpcMainInvokeEvent
 */

/**
 * Register-time dependencies threaded into each named handler. Every handler
 * destructures only the members it uses, so the service accessors are
 * optional in the type; call sites always pass what the handler needs.
 * @typedef {Object} SmartFoldersHandlerContext
 * @property {LoggerLike} logger
 * @property {() => Record<string, any>[]} [getCustomFolders]
 * @property {(folders: Record<string, any>[]) => void} [setCustomFolders]
 * @property {(folders: Record<string, any>[]) => Promise<any>} [saveCustomFolders]
 * @property {() => (Record<string, any>|null)} [getSmartFolderWatcher]
 * @property {() => (Record<string, any>|null|undefined)} [getServiceIntegration]
 * @property {(...args: any[]) => Promise<any>} [scanDirectory]
 * @property {() => (Record<string, any>|null)} [getServiceIntegration]
 * @property {() => (Record<string, any>|null)} [getFilePathCoordinator]
 * @property {() => (Record<string, any>|null)} [getMainWindow]
 */

/**
 * A Smart Folder root is trusted by every later move, so registering one is
 * held to the destination policy: a startup folder is refused, a folder the
 * user picked or one under Documents or an existing Smart Folder passes, any
 * other is confirmed in a main-process dialog. The dialog follows the IPC
 * request's abortSignal: the preload gives up on an invoke after its timeout
 * (30 s for an edit), and an answer given after that must close nothing and
 * move nothing. Returns the refusal response or null.
 * @param {{ folderPath: string, previousPath?: string|null, logger: LoggerLike, getCustomFolders?: () => Record<string, any>[], getMainWindow?: () => any, getServiceIntegration?: () => any, abortSignal?: AbortSignal|null }} params
 * @returns {Promise<Record<string, any>|null>}
 */
async function vetSmartFolderRoot({
  folderPath,
  previousPath = null,
  logger,
  getCustomFolders,
  getMainWindow,
  getServiceIntegration,
  abortSignal = null
}) {
  /** @type {string[]} */
  const knownRoots = [];
  try {
    const documents = app.getPath('documents');
    if (typeof documents === 'string' && documents) knownRoots.push(documents);
  } catch {
    // No Documents folder on this platform; the other roots still apply.
  }
  for (const folder of typeof getCustomFolders === 'function' ? getCustomFolders() || [] : []) {
    if (typeof folder?.path === 'string' && folder.path) knownRoots.push(folder.path);
  }
  const decision = await authorizeSmartFolderRoot(folderPath, {
    knownRoots,
    sourcePath: previousPath,
    getMainWindow,
    getServiceIntegration,
    log: logger,
    abortSignal
  });
  if (decision.allowed) return null;
  logger.warn('[SMART-FOLDERS] Folder refused as a Smart Folder root', {
    path: folderPath,
    reason: decision.reason
  });
  return {
    success: false,
    error: decision.error || 'Folder was not approved as a Smart Folder.',
    errorCode: decision.errorCode || 'DESTINATION_NOT_ALLOWED'
  };
}

/** Upper bound on history entries consulted for a rename (well above any real store). */
const FOLDER_RENAME_HISTORY_LIMIT = 50_000;

/**
 * Compare filesystem paths with platform-aware case sensitivity.
 * Windows is always case-insensitive. macOS APFS/HFS+ defaults to
 * case-insensitive (case-sensitive volumes are rare and opt-in), so darwin
 * is treated the same way to prevent silent duplicate-path entries that the
 * underlying filesystem would treat as the same location.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function areEquivalentPaths(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const normA = path.resolve(a);
  const normB = path.resolve(b);
  if (isCaseInsensitiveFileSystem()) {
    return normA.toLowerCase() === normB.toLowerCase();
  }
  return normA === normB;
}

// Serialize the entire ADD smart-folder handler. Without this, two concurrent
// ADD requests can both pass the in-memory uniqueness check (line ~1209) before
// either persists the folder list, then both write — the second clobbers the
// first. The handler is short and rare-fire, so a single-slot promise chain is
// the simplest correct lock; per-key isolation isn't needed because the gate
// we're protecting is "duplicate folder name across the whole list."
let _addSmartFolderLockTail = Promise.resolve();
/**
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
function _withAddSmartFolderLock(fn) {
  const next = _addSmartFolderLockTail.then(fn, fn);
  _addSmartFolderLockTail = next.catch(() => {});
  return next;
}

/**
 * @param {Record<string, any>|null|undefined} folder
 * @param {Record<string, any>|null|undefined} folderMatcher
 * @returns {string|null}
 */
function getFolderEmbeddingId(folder, folderMatcher) {
  if (!folder || typeof folder !== 'object') return null;
  if (typeof folder.id === 'string' && folder.id.trim()) return folder.id;
  if (typeof folderMatcher?.generateFolderId === 'function') {
    try {
      const generated = folderMatcher.generateFolderId(folder);
      return typeof generated === 'string' && generated.trim() ? generated : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Broadcast a signal-only smart-folders-updated event so any open renderer
 * re-fetches the folder list after a main-process-initiated mutation (the
 * background LLM enhancement lands seconds after smart-folders:add returns,
 * and without this the Setup screen shows the pre-enhancement folder until
 * remount). Non-fatal by design: folder persistence already succeeded.
 * @param {Record<string, any>} payload
 * @param {LoggerLike} [logger]
 */
function broadcastSmartFoldersUpdated(payload, logger) {
  try {
    const { BrowserWindow } = require('electron');
    for (const win of BrowserWindow.getAllWindows()) {
      if (win && !win.isDestroyed() && win.webContents) {
        safeSend(win.webContents, IPC_EVENTS.SMART_FOLDERS_UPDATED, payload);
      }
    }
  } catch (error) {
    logger?.warn?.('[SMART-FOLDERS] Failed to broadcast smart-folders-updated:', error?.message);
  }
}

/**
 * @param {string} folderName
 * @returns {string}
 */
function getDescriptionFallback(folderName) {
  const cleanedFolderName =
    typeof folderName === 'string' && folderName.trim() ? folderName.trim() : 'this folder';
  return `Contains files related to ${cleanedFolderName}. Store documents and media that belong to this category.`;
}

/**
 * Keep vector DB folder embeddings in sync with smart folder configuration.
 * This is intentionally non-fatal: folder config writes must not fail because
 * background embedding sync could not complete.
 * @param {{ previousFolders?: Record<string, any>[], nextFolders?: Record<string, any>[], logger: LoggerLike, reason?: string }} params
 */
async function syncSmartFolderEmbeddings({
  previousFolders = [],
  nextFolders = [],
  logger,
  reason = 'unknown'
}) {
  try {
    const folderMatcher = FolderMatchingService.getInstance();
    if (!folderMatcher) return;

    if (typeof folderMatcher.initialize === 'function') {
      await folderMatcher.initialize().catch((/** @type {any} */ err) => {
        logger.warn('[SMART-FOLDERS] Embedding sync init warning:', err.message);
      });
    }

    const validNextFolders = (Array.isArray(nextFolders) ? nextFolders : []).filter(
      (folder) => folder && typeof folder.name === 'string' && folder.name.trim()
    );

    let upsertCount = 0;
    if (typeof folderMatcher.batchUpsertFolders === 'function' && validNextFolders.length > 0) {
      const upsertResult = await folderMatcher.batchUpsertFolders(validNextFolders, {
        // Smart-folder config writes must refresh embeddings even if this session has
        // already upserted these IDs (name/description/path can change).
        forceRefresh: true
      });
      upsertCount = Number(upsertResult?.count) || 0;
      const skipped = Array.isArray(upsertResult?.skipped) ? upsertResult.skipped : [];
      const hasHardFailure =
        upsertResult?.requiresRebuild === true ||
        Boolean(upsertResult?.error) ||
        skipped.some((/** @type {any} */ entry) => {
          const err = entry?.error;
          return Boolean(err) && err !== 'already_upserted_this_session';
        });
      if (hasHardFailure) {
        logger.warn('[SMART-FOLDERS] Embedding sync degraded', {
          reason,
          folders: validNextFolders.length,
          upserted: upsertCount,
          skipped: skipped.length,
          error: upsertResult?.error || null,
          requiresRebuild: upsertResult?.requiresRebuild === true
        });
      }
    }

    const previousIds = new Set(
      (Array.isArray(previousFolders) ? previousFolders : [])
        .map((folder) => getFolderEmbeddingId(folder, folderMatcher))
        .filter(Boolean)
    );
    const nextIds = new Set(
      (Array.isArray(nextFolders) ? nextFolders : [])
        .map((folder) => getFolderEmbeddingId(folder, folderMatcher))
        .filter(Boolean)
    );
    const deletedIds = [...previousIds].filter((id) => !nextIds.has(id));

    let deletedCount = 0;
    if (deletedIds.length > 0) {
      const vectorDbService = folderMatcher.vectorDbService;
      if (typeof vectorDbService?.batchDeleteFolders === 'function') {
        const deleteResult = await vectorDbService.batchDeleteFolders(deletedIds);
        deletedCount = Number(deleteResult?.count) || 0;
      } else if (typeof vectorDbService?.deleteFolderEmbedding === 'function') {
        for (const id of deletedIds) {
          const deleteResult = await vectorDbService.deleteFolderEmbedding(id);
          if (deleteResult?.success) deletedCount++;
        }
      } else {
        logger.debug(
          '[SMART-FOLDERS] Embedding sync: vector DB delete API unavailable, skipping deletes'
        );
      }
    }

    logger.info('[SMART-FOLDERS] Embedding sync complete', {
      reason,
      folders: validNextFolders.length,
      upserted: upsertCount,
      deleted: deletedCount
    });
  } catch (error) {
    logger.warn('[SMART-FOLDERS] Embedding sync skipped due to error:', error.message);
  }
}

/**
 * CRITICAL SECURITY FIX: Sanitize and validate folder paths to prevent path traversal attacks
 * @param {string} inputPath - User-provided path to validate
 * @returns {string} - Sanitized, validated path
 * @throws {Error} - If path is invalid or violates security constraints
 */
function sanitizeFolderPath(inputPath) {
  // Get allowed base paths from centralized config
  const ALLOWED_BASE_PATHS = ALLOWED_APP_PATHS.map((appPath) => {
    try {
      return app.getPath(/** @type {Parameters<typeof app.getPath>[0]} */ (appPath));
    } catch {
      return null;
    }
  }).filter(Boolean);

  // Network shares are exempt from the allowed-base containment below, so a
  // DOS device path (`\\.\C:\Temp`, `\\?\C:\Temp`) must not be mistaken for
  // one: it would name any local drive while skipping containment entirely.
  if (isWindowsDeviceNamespacePath(inputPath)) {
    throw new Error('Invalid path: Windows device namespace paths are not allowed');
  }

  const isUNC = isUNCPath(inputPath);

  const validation = validateFileOperationPathSync(
    inputPath,
    isUNC ? null : ALLOWED_BASE_PATHS, // Bypass allowed base paths for UNC
    {
      requireAbsolute: true,
      disallowUNC: false, // Allow UNC paths
      disallowUrlSchemes: true
    }
  );

  if (validation.valid) {
    return validation.normalizedPath;
  }

  // Cross-platform fallback: allow POSIX-style paths on Windows in test/mocked environments.
  if (
    process.platform === 'win32' &&
    typeof inputPath === 'string' &&
    inputPath.startsWith('/') &&
    ALLOWED_BASE_PATHS.some((base) => typeof base === 'string' && base.startsWith('/'))
  ) {
    const normalized = path.posix.normalize(inputPath);
    if (!path.posix.isAbsolute(normalized)) {
      throw new Error('Invalid path: must be absolute');
    }
    const parts = normalized.split('/').filter(Boolean);
    if (parts.some((part) => part === '..')) {
      throw new Error('Invalid path: path traversal detected');
    }
    const allowed = ALLOWED_BASE_PATHS.some((base) => {
      if (!base || !base.startsWith('/')) return false;
      const baseNormalized = path.posix.normalize(base);
      if (normalized === baseNormalized) return true;
      return normalized.startsWith(`${baseNormalized}/`);
    });
    if (!allowed) {
      throw new Error(
        'Invalid path: must be within allowed directories (Documents, Downloads, Desktop, Pictures, Videos, Music, or Home)'
      );
    }
    return normalized;
  }

  throw new Error(
    validation.error ||
      'Invalid path: must be within allowed directories (Documents, Downloads, Desktop, Pictures, Videos, Music, or Home)'
  );
}

const { IpcServiceContext, createFromLegacyParams } = require('./IpcServiceContext');

// Named handler bodies extracted from registerSmartFoldersIpc.
// Pulled to module top so each can be reasoned about and unit-tested in
// isolation rather than buried inside a multi-thousand-line closure.

/** @param {SmartFoldersHandlerContext} ctx */
async function handleSmartFoldersGetCustom({ logger, getCustomFolders }) {
  const customFolders = getCustomFolders();
  logger.info('[SMART-FOLDERS] Getting Custom Folders for UI:', customFolders.length);
  return customFolders;
}

/**
 * @param {SmartFoldersHandlerContext} ctx
 * @param {IpcMainInvokeEvent} event
 * @param {string} folderId
 */
async function handleSmartFoldersDelete(
  { logger, getCustomFolders, setCustomFolders, saveCustomFolders, getSmartFolderWatcher },
  event,
  folderId
) {
  try {
    if (!folderId || typeof folderId !== 'string')
      return {
        success: false,
        error: 'Valid folder ID is required',
        errorCode: ERROR_CODES.INVALID_FOLDER_ID
      };
    const customFolders = getCustomFolders();
    const folderIndex = customFolders.findIndex((f) => f.id === folderId);
    if (folderIndex === -1)
      return {
        success: false,
        error: 'Folder not found',
        errorCode: ERROR_CODES.FOLDER_NOT_FOUND
      };

    const folderToDelete = customFolders[folderIndex];
    if (folderToDelete.isDefault && folderToDelete.name?.toLowerCase() === 'uncategorized') {
      logger.warn('[SMART-FOLDERS] Rejecting deletion of Uncategorized folder');
      return {
        success: false,
        error: 'The Uncategorized default folder cannot be deleted.',
        errorCode: ERROR_CODES.INVALID_INPUT
      };
    }

    const originalFolders = [...customFolders];
    const deletedFolder = customFolders[folderIndex];
    try {
      const updated = customFolders.filter((f) => f.id !== folderId);
      setCustomFolders(updated);
      await saveCustomFolders(updated);
      await syncSmartFolderEmbeddings({
        previousFolders: originalFolders,
        nextFolders: updated,
        logger,
        reason: 'delete'
      });
      await refreshWatcherAfterFolderChange({ logger, folders: updated, getSmartFolderWatcher });
      logger.info('[SMART-FOLDERS] Deleted Smart Folder:', folderId);
      // Note: We intentionally do NOT delete the physical directory.
      // The UI promises "This will not delete the physical directory or its files."
      // Users can manually delete the folder if desired.
      return {
        success: true,
        folders: updated,
        deletedFolder,
        directoryRemoved: false,
        message: `Smart folder "${deletedFolder.name}" removed from StratoSort`
      };
    } catch (saveError) {
      setCustomFolders(originalFolders);
      throw saveError;
    }
  } catch (error) {
    logger.error('[ERROR] Failed to delete smart folder:', error);
    return {
      success: false,
      error: error.message,
      errorCode: ERROR_CODES.DELETE_FAILED
    };
  }
}

/** @param {SmartFoldersHandlerContext} ctx */
async function handleSmartFoldersWatcherStatus({ logger, getSmartFolderWatcher }) {
  try {
    const smartFolderWatcher = getSmartFolderWatcher?.();
    if (!smartFolderWatcher) {
      return {
        success: true,
        status: {
          isRunning: false,
          isStarting: false,
          watchedFolders: [],
          watchedCount: 0,
          queueLength: 0,
          processingCount: 0,
          available: false
        }
      };
    }

    return {
      success: true,
      status: {
        ...smartFolderWatcher.getStatus(),
        available: true
      }
    };
  } catch (error) {
    logger.error('[SMART-FOLDER-WATCHER] Failed to get status:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/** @param {SmartFoldersHandlerContext} ctx */
async function handleSmartFoldersWatcherStop({ logger, getSmartFolderWatcher }) {
  try {
    const smartFolderWatcher = getSmartFolderWatcher?.();
    if (!smartFolderWatcher) {
      return {
        success: false,
        error: 'Smart folder watcher not available'
      };
    }

    smartFolderWatcher.stop();
    return {
      success: true,
      message: 'Smart folder watcher stopped',
      status: smartFolderWatcher.getStatus()
    };
  } catch (error) {
    logger.error('[SMART-FOLDER-WATCHER] Failed to stop:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/** @param {SmartFoldersHandlerContext} ctx */
async function handleSmartFoldersWatcherStart({ logger, getSmartFolderWatcher }) {
  try {
    const smartFolderWatcher = getSmartFolderWatcher?.();
    if (!smartFolderWatcher) {
      return {
        success: false,
        error: 'Smart folder watcher not available'
      };
    }

    const started = await smartFolderWatcher.start();
    const status = smartFolderWatcher.getStatus();

    let errorMessage = null;
    if (!started) {
      errorMessage = status.lastStartError || 'Failed to start watcher (unknown reason)';
      logger.warn('[SMART-FOLDER-WATCHER] Start returned false:', errorMessage);
    }

    return {
      success: started,
      message: started ? 'Smart folder watcher started' : errorMessage,
      error: errorMessage,
      status
    };
  } catch (error) {
    logger.error('[SMART-FOLDER-WATCHER] Failed to start:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/** @param {SmartFoldersHandlerContext} ctx */
async function handleSmartFoldersResetToDefaults({
  logger,
  getCustomFolders,
  setCustomFolders,
  getSmartFolderWatcher
}) {
  try {
    logger.info('[SMART-FOLDERS] Resetting to default smart folders');
    const originalFolders = [...getCustomFolders()];
    const { resetToDefaultFolders } = require('../core/customFolders');
    const defaultFolders = await resetToDefaultFolders();
    setCustomFolders(defaultFolders);
    await syncSmartFolderEmbeddings({
      previousFolders: originalFolders,
      nextFolders: defaultFolders,
      logger,
      reason: 'reset-to-defaults'
    });
    await refreshWatcherAfterFolderChange({
      logger,
      folders: defaultFolders,
      scanPaths: defaultFolders.map((f) => f?.path).filter(Boolean),
      getSmartFolderWatcher
    });
    logger.info('[SMART-FOLDERS] Reset complete, created', defaultFolders.length, 'folders');
    return {
      success: true,
      folders: defaultFolders,
      message: `Reset to ${defaultFolders.length} default smart folders`
    };
  } catch (error) {
    logger.error('[ERROR] Failed to reset smart folders:', error);
    return {
      success: false,
      error: error.message,
      errorCode: ERROR_CODES.RESET_FAILED
    };
  }
}

/**
 * @param {SmartFoldersHandlerContext} ctx
 * @param {IpcMainInvokeEvent} event
 * @param {string} rootPath
 */
async function handleSmartFoldersScanStructure({ logger, scanDirectory }, event, rootPath) {
  try {
    // CRITICAL SECURITY FIX: Sanitize path to prevent directory traversal
    let sanitizedPath;
    try {
      sanitizedPath = sanitizeFolderPath(rootPath);
    } catch (securityError) {
      return {
        success: false,
        error: securityError.message,
        errorCode: ERROR_CODES.SECURITY_PATH_VIOLATION
      };
    }

    const scanStartedAt = Date.now();
    logger.info('[FOLDER-SCAN] Scanning folder structure', {
      path: sanitizedPath,
      isUNC: isUNCPath(sanitizedPath),
      timeoutMs: TIMEOUTS.DIRECTORY_SCAN || 60000
    });

    // Dev-only: allow simulating slow folder scans without a network drive.
    // Guardrails:
    // - opt-in via env var
    // - disabled under Jest
    // - clamped to prevent accidental multi-minute stalls
    // Set STRATOSORT_SCAN_STRUCTURE_DELAY_MS=35000 to verify IPC timeout behavior.
    if (process.env.NODE_ENV === 'development' && !process.env.JEST_WORKER_ID) {
      const rawDelayMs = Number.parseInt(process.env.STRATOSORT_SCAN_STRUCTURE_DELAY_MS, 10);
      const devDelayMs =
        Number.isFinite(rawDelayMs) && rawDelayMs > 0
          ? Math.min(rawDelayMs, TIMEOUTS.DIRECTORY_SCAN || 60000)
          : 0;

      if (devDelayMs > 0) {
        logger.warn('[FOLDER-SCAN] Dev scan delay enabled', {
          delayMs: devDelayMs,
          requestedDelayMs: rawDelayMs
        });
        await delay(devDelayMs);
      }
    }

    // Reuse existing scanner (shallow aggregation is done in renderer today)
    const items = await scanDirectory(sanitizedPath, undefined, {
      // For folder selection we only need names/paths; stats are very expensive on network shares.
      includeStats: false,
      // Avoid runaway scans on giant folders / network drives.
      maxDepth: 10,
      maxFiles: 5000,
      timeoutMs: TIMEOUTS.DIRECTORY_SCAN || 60000,
      perDirectoryTimeoutMs: TIMEOUTS.FILE_READ || 5000
    });
    const scanMeta = items && items.__scanMeta ? items.__scanMeta : null;
    // Flatten file-like items with basic filtering similar to prior inline implementation
    /** @type {(nodes: any[]) => Record<string, any>[]} */
    const flatten = (nodes) => {
      const out = [];
      for (const n of nodes) {
        if (n.type === 'file')
          out.push({
            name: n.name,
            path: n.path,
            type: 'file',
            size: n.size
          });
        if (Array.isArray(n.children)) out.push(...flatten(n.children));
      }
      return out;
    };
    const files = flatten(items);
    const partial = !!scanMeta?.partial;
    logger.info('[FOLDER-SCAN] Completed scan', {
      durationMs: Date.now() - scanStartedAt,
      path: sanitizedPath,
      fileCount: files.length,
      partial,
      reasons: scanMeta?.reasons,
      timeouts: scanMeta?.timeouts,
      skippedDirectories: scanMeta?.skippedDirectories,
      skippedErrors: scanMeta?.skippedErrors,
      directoriesVisited: scanMeta?.directoriesVisited,
      filesIncluded: scanMeta?.filesIncluded,
      lastDirectory: scanMeta?.lastDirectory,
      lastEntry: scanMeta?.lastEntry,
      errorSamples: scanMeta?.errorSamples
    });
    return {
      success: true,
      files,
      ...(partial && {
        partial: true,
        skippedDirectories: scanMeta?.skippedDirectories || 0,
        skippedErrors: scanMeta?.skippedErrors || 0
      })
    };
  } catch (error) {
    logger.error('[FOLDER-SCAN] Error scanning folder structure:', error);
    return { success: false, error: error.message };
  }
}

/**
 * @param {SmartFoldersHandlerContext} ctx
 * @param {IpcMainInvokeEvent} event
 * @param {Record<string, any>} folder
 */
async function handleSmartFoldersAdd(
  {
    logger,
    getCustomFolders,
    setCustomFolders,
    saveCustomFolders,
    getSmartFolderWatcher,
    getMainWindow,
    getServiceIntegration
  },
  event,
  folder
) {
  return _withAddSmartFolderLock(async () => {
    try {
      if (!folder || typeof folder !== 'object')
        return {
          success: false,
          error: 'Invalid folder data provided',
          errorCode: ERROR_CODES.INVALID_FOLDER_DATA
        };
      // Name validation lives in the shared module so the renderer's modal
      // can pre-validate against the same rules and avoid post-submit
      // surprises (see src/shared/smartFolderNameValidation.js).
      const nameValidation = validateSmartFolderName(folder?.name);
      if (!nameValidation.valid) {
        return {
          success: false,
          error: nameValidation.error,
          errorCode: nameValidation.errorCode
        };
      }
      const sanitizedName = nameValidation.sanitizedName;
      if (nameValidation.warning) {
        logger.info('[SMART-FOLDERS] Folder name normalized', {
          original: folder.name,
          sanitized: sanitizedName,
          warning: nameValidation.warning
        });
      }

      if (!folder.path || typeof folder.path !== 'string' || !folder.path.trim())
        return {
          success: false,
          error: 'Folder path is required and must be a non-empty string',
          errorCode: ERROR_CODES.INVALID_FOLDER_PATH
        };

      const customFolders = getCustomFolders();

      // CRITICAL SECURITY FIX: Sanitize path before any operations
      let normalizedPath;
      try {
        normalizedPath = sanitizeFolderPath(folder.path);
        if (isUNCPath(normalizedPath)) {
          logger.info('[SMART-FOLDERS] UNC path accepted for new folder:', normalizedPath);
        }
      } catch (securityError) {
        return {
          success: false,
          error: securityError.message,
          errorCode: ERROR_CODES.SECURITY_PATH_VIOLATION
        };
      }
      const rootRefusal = await vetSmartFolderRoot({
        folderPath: normalizedPath,
        logger,
        getCustomFolders,
        getMainWindow,
        getServiceIntegration,
        abortSignal: event?.abortSignal || null
      });
      if (rootRefusal) return rootRefusal;

      const existingFolder = customFolders.find(
        (f) =>
          f.name.toLowerCase() === sanitizedName.toLowerCase() ||
          areEquivalentPaths(f.path, normalizedPath)
      );
      if (existingFolder)
        return {
          success: false,
          error: `A smart folder with name "${existingFolder.name}" or path "${existingFolder.path}" already exists`,
          errorCode: ERROR_CODES.FOLDER_ALREADY_EXISTS
        };

      // Canonical-name dedup: catch "Logos and Graphic Design" when "Logos"
      // exists, "Marketing Materials" when "Marketing" exists, etc. The
      // analysis pipeline kept producing both names and the embedding matcher
      // flip-flopped between them. Surface as a distinct error code so the UI
      // can offer "use existing 'X'" rather than the generic "already exists"
      // message — the user may have legitimately wanted to add the variant,
      // but more often this is the recommender duplicating an existing folder.
      const equivalentFolder = customFolders.find((f) => namesAreEquivalent(f.name, sanitizedName));
      if (equivalentFolder)
        return {
          success: false,
          error: `Smart folder "${equivalentFolder.name}" already covers this concept. Use the existing folder, or pick a more distinct name.`,
          errorCode: ERROR_CODES.FOLDER_NAME_EQUIVALENT,
          existingFolder: {
            id: equivalentFolder.id,
            name: equivalentFolder.name,
            path: equivalentFolder.path
          }
        };
      const parentDir = path.dirname(normalizedPath);
      try {
        const parentStats = await fs.stat(parentDir);
        if (!parentStats.isDirectory()) {
          return {
            success: false,
            error: `Parent directory "${parentDir}" is not a directory`,
            errorCode: ERROR_CODES.PARENT_NOT_DIRECTORY
          };
        }
      } catch (parentError) {
        // Parent doesn't exist - create it recursively
        if (parentError.code === 'ENOENT') {
          try {
            await fs.mkdir(parentDir, { recursive: true });
            logger.info('[SMART-FOLDERS] Created parent directory:', parentDir);
          } catch (mkdirError) {
            return {
              success: false,
              error: `Failed to create parent directory "${parentDir}": ${mkdirError.message}`,
              errorCode: ERROR_CODES.PARENT_NOT_ACCESSIBLE
            };
          }
        } else {
          return {
            success: false,
            error: `Cannot access parent directory "${parentDir}": ${parentError.message}`,
            errorCode: ERROR_CODES.PARENT_NOT_ACCESSIBLE
          };
        }
      }

      // Test write permission in parent directory
      const tempFile = path.join(parentDir, `.stratotest_${Date.now()}`);
      try {
        await fs.writeFile(tempFile, 'test');
        await fs.unlink(tempFile);
      } catch {
        return {
          success: false,
          error: `No write permission in parent directory "${parentDir}"`,
          errorCode: ERROR_CODES.PARENT_NOT_WRITABLE
        };
      }

      /** @type {Record<string, any>} */
      const newFolder = {
        id: `sf-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        name: sanitizedName,
        path: normalizedPath,
        description: folder.description?.trim() || `Smart folder for ${sanitizedName}`,
        keywords: [],
        category: 'general',
        isDefault: folder.isDefault || false,
        createdAt: new Date().toISOString(),
        semanticTags: [],
        relatedFolders: [],
        confidenceScore: 0.8,
        usageCount: 0,
        lastUsed: null
      };

      /** @type {() => Promise<any>} */
      const runBackgroundLlmEnhancement = () =>
        enhanceSmartFolderWithLLM(folder, customFolders, getTextModel)
          .then(
            /** @returns {Promise<void>} */
            async (/** @type {Record<string, any>} */ llmAnalysis) => {
              if (!llmAnalysis || llmAnalysis.error) return;
              try {
                // F-086: the LLM call above ran outside any lock (seconds long), but the
                // resulting read-modify-write must be atomic vs. concurrent folder writes.
                // Serialize it through the same lock as adds; the fresh read below runs
                // INSIDE the lock (compare-and-set) so it cannot clobber a concurrent edit.
                await _withAddSmartFolderLock(async () => {
                  // Get fresh state and skip if the folder was deleted.
                  const currentFolders = getCustomFolders();
                  const folderIndex = currentFolders.findIndex((f) => f.id === newFolder.id);
                  if (folderIndex === -1) return;

                  const descriptionFromLlm =
                    (typeof llmAnalysis.improvedDescription === 'string' &&
                      llmAnalysis.improvedDescription.trim()) ||
                    (typeof llmAnalysis.enhancedDescription === 'string' &&
                      llmAnalysis.enhancedDescription.trim()) ||
                    '';
                  const keywordsFromLlm = Array.isArray(llmAnalysis.suggestedKeywords)
                    ? llmAnalysis.suggestedKeywords
                        .map((v) => String(v || '').trim())
                        .filter(Boolean)
                        .slice(0, 12)
                    : [];
                  const semanticTagsFromLlm = Array.isArray(llmAnalysis.semanticTags)
                    ? llmAnalysis.semanticTags
                        .map((v) => String(v || '').trim())
                        .filter(Boolean)
                        .slice(0, 12)
                    : [];

                  const existingFolderNameLookup = new Map(
                    currentFolders
                      .filter((f) => f && typeof f.name === 'string' && f.name.trim())
                      .map((f) => [f.name.toLowerCase(), f.name])
                  );
                  const relatedFoldersFromLlm = Array.isArray(llmAnalysis.relatedFolders)
                    ? llmAnalysis.relatedFolders
                        .map((v) => String(v || '').trim())
                        .filter(Boolean)
                        .map((name) => existingFolderNameLookup.get(name.toLowerCase()) || null)
                        .filter(Boolean)
                        .slice(0, 8)
                    : [];

                  const confidenceFromLlm = Number(llmAnalysis.confidence);
                  const normalizedConfidence = Number.isFinite(confidenceFromLlm)
                    ? Math.max(
                        0,
                        Math.min(
                          1,
                          confidenceFromLlm > 1 ? confidenceFromLlm / 100 : confidenceFromLlm
                        )
                      )
                    : 0.8;

                  const categoryFromLlm =
                    typeof llmAnalysis.suggestedCategory === 'string' &&
                    llmAnalysis.suggestedCategory.trim()
                      ? llmAnalysis.suggestedCategory.trim().toLowerCase().slice(0, 60)
                      : 'general';

                  const originalFoldersSnapshot = [...currentFolders];
                  /** @type {Record<string, any>} */
                  const updatedFolder = {
                    ...currentFolders[folderIndex],
                    description: descriptionFromLlm || currentFolders[folderIndex].description,
                    keywords: keywordsFromLlm,
                    category: categoryFromLlm,
                    semanticTags: semanticTagsFromLlm,
                    relatedFolders: relatedFoldersFromLlm,
                    confidenceScore: normalizedConfidence,
                    updatedAt: new Date().toISOString()
                  };

                  currentFolders[folderIndex] = updatedFolder;
                  setCustomFolders(currentFolders);
                  await saveCustomFolders(currentFolders);
                  await syncSmartFolderEmbeddings({
                    previousFolders: originalFoldersSnapshot,
                    nextFolders: currentFolders,
                    logger,
                    reason: 'add-llm-enhancement'
                  });

                  logger.info('[SMART-FOLDERS] Smart folder enhanced by AI', {
                    folderId: updatedFolder.id,
                    folderName: updatedFolder.name
                  });

                  broadcastSmartFoldersUpdated(
                    {
                      folderId: updatedFolder.id,
                      reason: 'llm-enhancement',
                      timestamp: Date.now()
                    },
                    logger
                  );
                });
              } catch (updateErr) {
                logger.error(
                  '[SMART-FOLDERS] Background LLM folder update failed:',
                  updateErr.message
                );
              }
              return undefined;
            }
          )
          .catch((e) => {
            logger.warn('[SMART-FOLDERS] LLM enhancement failed in background:', e.message);
          });

      let directoryCreated = false;
      let directoryExisted = false;
      try {
        const existingStats = await fs.stat(normalizedPath);
        if (existingStats.isDirectory()) {
          directoryExisted = true;
        } else {
          return {
            success: false,
            error:
              'Path exists as a file, not a folder. Choose a different location, or move/rename the existing file before reusing this path.',
            errorCode: ERROR_CODES.PATH_NOT_DIRECTORY
          };
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') {
          try {
            await fs.mkdir(normalizedPath, { recursive: true });
            const stats = await fs.stat(normalizedPath);
            if (!stats.isDirectory())
              throw new Error('Created path is not a directory', { cause: statError });
            directoryCreated = true;
          } catch (dirError) {
            return {
              success: false,
              error: 'Failed to create directory',
              errorCode: ERROR_CODES.DIRECTORY_CREATION_FAILED,
              details: dirError.message
            };
          }
        } else {
          return {
            success: false,
            error: 'Failed to access directory path',
            errorCode: ERROR_CODES.PATH_ACCESS_FAILED,
            details: statError.message
          };
        }
      }

      const originalFolders = [...customFolders];
      try {
        customFolders.push(newFolder);
        setCustomFolders(customFolders);
        await saveCustomFolders(customFolders);
        await syncSmartFolderEmbeddings({
          previousFolders: originalFolders,
          nextFolders: customFolders,
          logger,
          reason: 'add'
        });
        await refreshWatcherAfterFolderChange({
          logger,
          folders: customFolders,
          scanPaths: [newFolder.path],
          getSmartFolderWatcher
        });
        runBackgroundLlmEnhancement().catch((err) =>
          logger.warn('[SMART-FOLDERS] LLM enhancement failed in background:', err?.message)
        );
        logger.info(
          '[SMART-FOLDERS] Added folder:',
          newFolder.id,
          'Directory created:',
          directoryCreated,
          'Existed:',
          directoryExisted
        );
        return {
          success: true,
          folder: newFolder,
          folders: customFolders,
          message: directoryCreated
            ? 'Smart folder created successfully'
            : 'Smart folder added (directory already existed)',
          directoryCreated,
          directoryExisted
        };
      } catch (saveError) {
        setCustomFolders(originalFolders);
        if (directoryCreated && !directoryExisted) {
          try {
            await fs.rm(normalizedPath, { recursive: true, force: true });
          } catch (rmErr) {
            // Cleanup failure isn't fatal — but stay loud about it so an
            // orphaned directory left behind on disk doesn't surface only
            // as a confusing "directory already exists" error on the
            // user's next retry with the same path.
            logger.warn(
              '[SMART-FOLDERS] Rollback cleanup failed; orphaned directory may remain at:',
              normalizedPath,
              rmErr?.message || rmErr
            );
          }
        }
        return {
          success: false,
          error: 'Failed to save configuration, changes rolled back',
          errorCode: ERROR_CODES.CONFIG_SAVE_FAILED,
          details: saveError.message
        };
      }
    } catch (error) {
      logger.error('[ERROR] Failed to add smart folder:', error);
      return {
        success: false,
        error: 'Failed to add smart folder',
        errorCode: ERROR_CODES.ADD_FOLDER_FAILED,
        details: error.message
      };
    }
  });
}

/**
 * @param {SmartFoldersHandlerContext} ctx
 * @param {IpcMainInvokeEvent} event
 * @param {string} folderName
 */
async function handleSmartFoldersGenerateDescription({ logger }, event, folderName) {
  try {
    if (!folderName || typeof folderName !== 'string') {
      return {
        success: false,
        error: 'Folder name is required'
      };
    }

    // Generate description using LLM
    const prompt = `You are helping organize files on a computer. Generate a brief, helpful description (1-2 sentences) for a folder called "${folderName}".
The description should explain what types of files belong in this folder to help an AI system match files to folders.
Use only the folder name as context and avoid making up company- or project-specific details.
Return plain text only (no markdown, no quotes, no bullet points).

Example for "Work Documents": "Contains professional documents, reports, and work-related files such as meeting notes, project plans, and business correspondence."

Now generate a description for "${folderName}":`;

    try {
      const model = getTextModel() || AI_DEFAULTS.TEXT.MODEL;
      const llamaService = getLlamaService();
      await llamaService.initialize();
      // 120 tokens is plenty for a 1-2 sentence description (example output
      // is ~25 tokens). 45s budget gives cold-load systems room.
      const result = await withAbortableTimeout(
        (abortController) =>
          llamaService.generateText({
            model,
            prompt,
            maxTokens: 120,
            temperature: 0.3,
            signal: abortController.signal
          }),
        45000,
        'Smart folder description generation'
      );

      if (result?.response && result.response.trim()) {
        const description = String(result.response)
          .replace(/```[\s\S]*?```/g, ' ')
          .replace(/\s+/g, ' ')
          .replace(/^["'\s]+|["'\s]+$/g, '')
          .slice(0, 320)
          .trim();
        if (!description) {
          return {
            success: false,
            error: 'No usable description from AI'
          };
        }
        return {
          success: true,
          description
        };
      }
      return {
        success: false,
        error: 'No response from AI'
      };
    } catch (llmError) {
      logger.error('[SMART-FOLDERS] LLM description generation failed:', llmError.message);
      return {
        success: true,
        description: getDescriptionFallback(folderName),
        fallback: true
      };
    }
  } catch (error) {
    logger.error('[ERROR] Failed to generate description:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Tell the running watcher about a changed folder list right away and scan
 * any newly watched paths for files that already exist in them. Until this,
 * a folder added (or re-pointed) while the app was open was neither watched
 * nor scanned until the next restart (F-194 / K-05). Never fails the caller:
 * the folder record is already saved; the watcher catching up is best-effort
 * and logged.
 *
 * @param {{ logger: LoggerLike, folders: Record<string, any>[], scanPaths?: string[],
 *   getSmartFolderWatcher?: () => (Record<string, any>|null) }} args
 * @returns {Promise<void>}
 */
async function refreshWatcherAfterFolderChange({
  logger,
  folders,
  scanPaths = [],
  getSmartFolderWatcher
}) {
  const watcher = typeof getSmartFolderWatcher === 'function' ? getSmartFolderWatcher() : null;
  if (!watcher) return;
  try {
    if (typeof watcher.updateWatchedFolders === 'function') {
      await watcher.updateWatchedFolders(folders);
    }
    for (const folderPath of scanPaths) {
      if (typeof folderPath !== 'string' || !folderPath) continue;
      if (typeof watcher.scanFolderForUnanalyzedFiles !== 'function') break;
      // Fire-and-forget: scanning can take a while on a big folder and the
      // IPC reply must not wait for it. Results land through the normal
      // watcher queue and progress events.
      watcher
        .scanFolderForUnanalyzedFiles(folderPath)
        .then((/** @type {any} */ result) => {
          logger.info('[SMART-FOLDERS] Scanned newly watched folder', {
            folderPath,
            scanned: result?.scanned ?? 0,
            queued: result?.queued ?? 0
          });
          return result;
        })
        .catch((/** @type {any} */ err) => {
          logger.warn('[SMART-FOLDERS] Initial scan of new folder failed', {
            folderPath,
            error: err?.message
          });
        });
    }
  } catch (err) {
    logger.warn('[SMART-FOLDERS] Watcher did not pick up the folder change (restart will)', {
      error: /** @type {any} */ (err)?.message
    });
  }
}

/**
 * Read every analysis-history entry for a folder rename. Prefers the service
 * API (it initializes and loads the store first); falls back to the in-memory
 * map for callers that hand in a bare history object.
 *
 * @param {Record<string, any>|null|undefined} historyService
 * @returns {Promise<any[]>}
 */
async function readHistoryEntriesForRename(historyService) {
  if (typeof historyService?.getRecentAnalysis === 'function') {
    // Whole history: a smart folder can hold far more than the default page.
    const entries = await historyService.getRecentAnalysis(FOLDER_RENAME_HISTORY_LIMIT);
    return Array.isArray(entries) ? entries : [];
  }
  return Object.values(historyService?.analysisHistory?.entries || {});
}

/**
 * Re-key every history entry (and, through the coordinator, its vectors,
 * chunks, queue and processing-state rows) that lives under a smart folder
 * that was just renamed on disk. Without this the entries keep the old child
 * paths, the startup reconcile treats all of them as deleted, and one rename
 * forgets everything the app learned about that folder (F-188 / K-08).
 *
 * Runs AFTER the directory rename succeeded, so a remap failure is logged
 * (and surfaced by the coordinator's degraded flags) — never turned into a
 * failed rename: the files already moved, refusing now would strand them.
 * The next "Build file embeddings" run backfills whatever this could not move.
 *
 * @param {{ oldPath: string, newPath: string, logger: LoggerLike,
 *   getServiceIntegration?: () => (Record<string, any>|null),
 *   getFilePathCoordinator?: () => (Record<string, any>|null) }} args
 * @returns {Promise<{ remapped: number, failed: number }>}
 */
async function remapKnowledgeUnderRenamedFolder({
  oldPath,
  newPath,
  logger,
  getServiceIntegration,
  getFilePathCoordinator
}) {
  const coordinator =
    typeof getFilePathCoordinator === 'function' ? getFilePathCoordinator() : null;
  if (!coordinator || typeof coordinator.batchPathUpdate !== 'function') {
    logger.warn(
      '[SMART-FOLDERS] Renamed directory but no FilePathCoordinator — knowledge under it was not re-keyed',
      { oldPath, newPath }
    );
    return { remapped: 0, failed: 0 };
  }

  /** @type {Array<{oldPath: string, newPath: string}>} */
  let changes;
  try {
    const serviceIntegration =
      typeof getServiceIntegration === 'function' ? getServiceIntegration() : null;
    const entries = await readHistoryEntriesForRename(serviceIntegration?.analysisHistory);
    changes = buildFolderRenamePathChanges(entries, oldPath, newPath);
  } catch (err) {
    logger.warn(
      '[SMART-FOLDERS] Failed to relocate knowledge after folder rename: history read failed',
      {
        oldPath,
        newPath,
        error: /** @type {any} */ (err)?.message
      }
    );
    return { remapped: 0, failed: 0 };
  }
  if (changes.length === 0) return { remapped: 0, failed: 0 };

  try {
    const result = await coordinator.batchPathUpdate(changes, { type: 'move' });
    const summary = result?.summary || {};
    const failed = summary.failed ?? (result?.success ? 0 : changes.length);
    if (!result?.success || failed > 0) {
      logger.warn('[SMART-FOLDERS] Renamed directory but re-keying its knowledge had errors', {
        oldPath,
        newPath,
        total: changes.length,
        failed,
        systems: Array.isArray(result?.errors)
          ? result.errors.map((/** @type {any} */ e) => e?.system).join(', ')
          : ''
      });
      return { remapped: summary.successful || 0, failed };
    }
    logger.info('[SMART-FOLDERS] Re-keyed knowledge under renamed directory', {
      oldPath,
      newPath,
      count: changes.length
    });
    return { remapped: changes.length, failed: 0 };
  } catch (err) {
    logger.warn('[SMART-FOLDERS] Failed to relocate knowledge after folder rename', {
      oldPath,
      newPath,
      error: /** @type {any} */ (err)?.message
    });
    return { remapped: 0, failed: changes.length };
  }
}

/**
 * @param {SmartFoldersHandlerContext} ctx
 * @param {IpcMainInvokeEvent} event
 * @param {string} folderId
 * @param {Record<string, any>} updatedFolder
 */
async function handleSmartFoldersEdit(
  {
    logger,
    getCustomFolders,
    setCustomFolders,
    saveCustomFolders,
    getServiceIntegration,
    getFilePathCoordinator,
    getSmartFolderWatcher,
    getMainWindow
  },
  event,
  folderId,
  updatedFolder
) {
  try {
    if (!folderId || typeof folderId !== 'string')
      return {
        success: false,
        error: 'Valid folder ID is required',
        errorCode: ERROR_CODES.INVALID_FOLDER_ID
      };
    if (!updatedFolder || typeof updatedFolder !== 'object')
      return {
        success: false,
        error: 'Valid folder data is required',
        errorCode: ERROR_CODES.INVALID_FOLDER_DATA
      };
    const customFolders = getCustomFolders();
    const folderIndex = customFolders.findIndex((f) => f.id === folderId);
    if (folderIndex === -1)
      return {
        success: false,
        error: 'Folder not found',
        errorCode: ERROR_CODES.FOLDER_NOT_FOUND
      };
    if (updatedFolder.name) {
      if (updatedFolder.name.includes(' > ')) {
        updatedFolder.name = updatedFolder.name.split(' > ')[0].trim();
      }

      const illegalChars = /([<>:"|?*])/g;
      if (illegalChars.test(updatedFolder.name)) {
        return {
          success: false,
          error: 'Folder name contains invalid characters. Please avoid: < > : " | ? *',
          errorCode: ERROR_CODES.INVALID_FOLDER_NAME_CHARS
        };
      }
      const existingFolder = customFolders.find(
        (f) => f.id !== folderId && f.name.toLowerCase() === updatedFolder.name.trim().toLowerCase()
      );
      if (existingFolder)
        return {
          success: false,
          error: `A smart folder with name "${updatedFolder.name}" already exists`,
          errorCode: ERROR_CODES.FOLDER_NAME_EXISTS
        };
    }
    if (updatedFolder.path) {
      try {
        // CRITICAL SECURITY FIX: Sanitize path before any operations
        const normalizedPath = sanitizeFolderPath(updatedFolder.path);
        if (isUNCPath(normalizedPath)) {
          logger.info('[SMART-FOLDERS] UNC path accepted for folder update:', normalizedPath);
        }
        // A new root is held to the destination policy before any directory
        // is created for it; a rename beside the old root passes on its own.
        if (!areEquivalentPaths(normalizedPath, customFolders[folderIndex].path)) {
          const rootRefusal = await vetSmartFolderRoot({
            folderPath: normalizedPath,
            previousPath: customFolders[folderIndex].path,
            logger,
            getCustomFolders,
            getMainWindow,
            getServiceIntegration,
            abortSignal: event?.abortSignal || null
          });
          if (rootRefusal) return rootRefusal;
        }
        const parentDir = path.dirname(normalizedPath);

        try {
          const parentStats = await fs.stat(parentDir);
          if (!parentStats.isDirectory()) {
            return {
              success: false,
              error: `Parent directory "${parentDir}" is not a directory`,
              errorCode: ERROR_CODES.PARENT_NOT_DIRECTORY
            };
          }
        } catch (parentError) {
          if (parentError.code === 'ENOENT') {
            // Parent doesn't exist - create it recursively
            await fs.mkdir(parentDir, { recursive: true });
            logger.info('[SMART-FOLDERS] Created parent directory for edit:', parentDir);
          } else {
            throw parentError;
          }
        }

        updatedFolder.path = normalizedPath;
      } catch (pathError) {
        return {
          success: false,
          error: `Invalid path: ${pathError.message}`,
          errorCode: ERROR_CODES.INVALID_PATH
        };
      }
    }
    const originalFolder = { ...customFolders[folderIndex] };
    const originalFolders = customFolders.map((folder) => ({ ...folder }));
    if (updatedFolder.path && !areEquivalentPaths(updatedFolder.path, originalFolder.path)) {
      try {
        const oldPath = originalFolder.path;
        const newPath = updatedFolder.path;
        let oldExists = false;
        let oldIsDirectory = false;
        let newExists = false;
        let newIsDirectory = false;

        try {
          const oldStats = await fs.stat(oldPath);
          oldExists = true;
          oldIsDirectory = oldStats.isDirectory();
        } catch (oldErr) {
          if (oldErr?.code !== 'ENOENT') throw oldErr;
        }

        try {
          const newStats = await fs.stat(newPath);
          newExists = true;
          newIsDirectory = newStats.isDirectory();
        } catch (newErr) {
          if (newErr?.code !== 'ENOENT') throw newErr;
        }

        if (newExists && !newIsDirectory) {
          return {
            success: false,
            error: 'Target path exists but is not a directory',
            errorCode: ERROR_CODES.INVALID_PATH
          };
        }

        if (oldExists && !oldIsDirectory) {
          return {
            success: false,
            error: 'Original path is not a directory',
            errorCode: ERROR_CODES.ORIGINAL_NOT_DIRECTORY
          };
        }

        if (oldExists && oldIsDirectory && !newExists) {
          // Revalidate oldPath at the moment of rename. It comes from
          // persisted customFolders on disk and was sanitized when
          // written, but the JSON file is user-writable — a tampered
          // entry pointing at a system directory must not be moved.
          // The async variant is used here to keep parity with the
          // future checkSymlinks upgrade path.
          const oldValidation = await validateFileOperationPath(oldPath, {
            requireAbsolute: true,
            disallowUrlSchemes: true,
            allowFileUrl: false
          });
          if (!oldValidation.valid) {
            logger.error('[SMART-FOLDERS] Refusing to rename from unsafe stored path:', {
              oldPath,
              error: oldValidation.error
            });
            return {
              success: false,
              error: `Refusing rename: stored folder path is unsafe (${oldValidation.error})`,
              errorCode: ERROR_CODES.INVALID_PATH
            };
          }
          // renameNoReplace closes the TOCTOU window widened by the async
          // path validation above: if a squatter created newPath between our
          // preflight fs.stat and this call, we now fail closed with EEXIST
          // instead of silently overwriting via POSIX/NTFS rename semantics.
          try {
            await renameNoReplace(oldPath, newPath);
          } catch (renameFailure) {
            if (renameFailure?.code === 'EEXIST') {
              return {
                success: false,
                error: 'Destination directory now occupied — refusing overwrite',
                errorCode: ERROR_CODES.RENAME_FAILED,
                details: renameFailure.message
              };
            }
            throw renameFailure;
          }
          logger.info(`[SMART-FOLDERS] Renamed directory "${oldPath}" -> "${newPath}"`);
          await remapKnowledgeUnderRenamedFolder({
            oldPath,
            newPath,
            logger,
            getServiceIntegration,
            getFilePathCoordinator
          });
        } else if (!newExists) {
          // Source folder was removed externally; create destination so folder remains valid.
          await fs.mkdir(newPath, { recursive: true });
          logger.info(
            '[SMART-FOLDERS] Source directory missing during edit, created destination directory instead:',
            { oldPath, newPath }
          );
        } else {
          // Destination already exists and is a directory; treat as a repoint.
          logger.info(
            '[SMART-FOLDERS] Destination directory already exists, updating smart folder path without rename:',
            { oldPath, newPath }
          );
        }
      } catch (renameErr) {
        logger.error('[SMART-FOLDERS] Directory rename failed:', renameErr.message);
        return {
          success: false,
          error: 'Failed to rename directory',
          errorCode: ERROR_CODES.RENAME_FAILED,
          details: renameErr.message
        };
      }
    }
    try {
      customFolders[folderIndex] = {
        ...customFolders[folderIndex],
        ...updatedFolder,
        updatedAt: new Date().toISOString()
      };
      setCustomFolders(customFolders);
      await saveCustomFolders(customFolders);
      await syncSmartFolderEmbeddings({
        previousFolders: originalFolders,
        nextFolders: customFolders,
        logger,
        reason: 'edit'
      });
      // A re-pointed folder (path changed) is a new watch target whose
      // existing files must be picked up; a rename that moved the directory
      // carried its files (and their knowledge, see remapKnowledge...) along,
      // and the scan is cheap for those because `_needsAnalysis` skips them.
      const pathChanged =
        typeof customFolders[folderIndex]?.path === 'string' &&
        !areEquivalentPaths(customFolders[folderIndex].path, originalFolder?.path);
      await refreshWatcherAfterFolderChange({
        logger,
        folders: customFolders,
        scanPaths: pathChanged ? [customFolders[folderIndex].path] : [],
        getSmartFolderWatcher
      });
      logger.info('[SMART-FOLDERS] Edited Smart Folder:', folderId);
      return {
        success: true,
        folder: customFolders[folderIndex],
        message: 'Smart folder updated successfully'
      };
    } catch (saveError) {
      customFolders[folderIndex] = originalFolder;
      throw saveError;
    }
  } catch (error) {
    logger.error('[ERROR] Failed to edit smart folder:', error);
    return {
      success: false,
      error: error.message,
      errorCode: ERROR_CODES.EDIT_FAILED
    };
  }
}

/**
 * @param {SmartFoldersHandlerContext} ctx
 * @param {IpcMainInvokeEvent} event
 * @param {Record<string, any>[]} folders
 */
async function handleSmartFoldersUpdateCustom(
  { logger, getCustomFolders, setCustomFolders, saveCustomFolders, getMainWindow },
  event,
  folders
) {
  try {
    if (!Array.isArray(folders))
      return {
        success: false,
        error: 'Folders must be an array',
        errorCode: ERROR_CODES.INVALID_INPUT
      };

    if (folders.length === 0) {
      logger.warn('[SMART-FOLDERS] Rejecting update with empty folders array');
      return {
        success: false,
        error: 'Cannot save empty folders list. At least one folder is required.',
        errorCode: ERROR_CODES.INVALID_INPUT
      };
    }

    const hasUncategorized = folders.some(
      (f) => f.isDefault && f.name?.toLowerCase() === 'uncategorized'
    );
    if (!hasUncategorized) {
      logger.warn('[SMART-FOLDERS] Rejecting update without Uncategorized folder');
      return {
        success: false,
        error: 'The Uncategorized default folder cannot be removed.',
        errorCode: ERROR_CODES.INVALID_INPUT
      };
    }

    for (const folder of folders) {
      if (folder.path) {
        try {
          folder.path = sanitizeFolderPath(folder.path);
        } catch (sanitizeError) {
          return {
            success: false,
            error: `Invalid folder path "${folder.path}": ${sanitizeError.message}`,
            errorCode: ERROR_CODES.INVALID_PATH
          };
        }
        // Folders already on record pass at once; a path new to the list is
        // held to the destination policy before its directory is created.
        const rootRefusal = await vetSmartFolderRoot({
          folderPath: folder.path,
          logger,
          getCustomFolders,
          getMainWindow,
          abortSignal: event?.abortSignal || null
        });
        if (rootRefusal) return rootRefusal;
        try {
          const stats = await fs.stat(folder.path);
          if (!stats.isDirectory()) {
            return {
              success: false,
              error: `Path "${folder.path}" exists but is not a directory`,
              errorCode: ERROR_CODES.INVALID_PATH
            };
          }
        } catch (error) {
          if (isNotFoundError(error)) {
            // Directory doesn't exist, create it
            try {
              await fs.mkdir(folder.path, { recursive: true });
              logger.info('[SMART-FOLDERS] Created directory:', folder.path);
            } catch (createError) {
              return {
                success: false,
                error: `Failed to create directory "${folder.path}": ${createError.message}`,
                errorCode: ERROR_CODES.DIRECTORY_CREATION_FAILED
              };
            }
          } else {
            throw error;
          }
        }
      }
    }

    const originalFolders = [...getCustomFolders()];
    try {
      setCustomFolders(folders);
      await saveCustomFolders(folders);
      await syncSmartFolderEmbeddings({
        previousFolders: originalFolders,
        nextFolders: folders,
        logger,
        reason: 'update-custom'
      });
      logger.info('[SMART-FOLDERS] Updated Custom Folders:', folders.length);
      return { success: true, folders: getCustomFolders() };
    } catch (saveError) {
      setCustomFolders(originalFolders);
      throw saveError;
    }
  } catch (error) {
    logger.error('[ERROR] Failed to update custom folders:', error);
    return {
      success: false,
      error: error.message,
      errorCode: ERROR_CODES.UPDATE_FAILED
    };
  }
}

/**
 * @param {SmartFoldersHandlerContext} ctx
 * @param {IpcMainInvokeEvent} event
 * @param {Record<string, any>[]} folders
 */
async function handleSmartFoldersSave(
  { logger, getCustomFolders, setCustomFolders, saveCustomFolders, getMainWindow },
  event,
  folders
) {
  try {
    if (!Array.isArray(folders))
      return {
        success: false,
        error: 'Folders must be an array',
        errorCode: ERROR_CODES.INVALID_INPUT
      };

    if (folders.length === 0) {
      logger.warn('[SMART-FOLDERS] Rejecting save of empty folders array');
      return {
        success: false,
        error: 'Cannot save empty folders list. At least one folder is required.',
        errorCode: ERROR_CODES.INVALID_INPUT
      };
    }

    const hasUncategorized = folders.some(
      (f) => f.isDefault && f.name?.toLowerCase() === 'uncategorized'
    );
    if (!hasUncategorized) {
      logger.warn('[SMART-FOLDERS] Rejecting save without Uncategorized folder');
      return {
        success: false,
        error: 'The Uncategorized default folder cannot be removed.',
        errorCode: ERROR_CODES.INVALID_INPUT
      };
    }

    for (const folder of folders) {
      if (folder.path) {
        try {
          folder.path = sanitizeFolderPath(folder.path);
        } catch (sanitizeError) {
          return {
            success: false,
            error: `Invalid folder path "${folder.path}": ${sanitizeError.message}`,
            errorCode: ERROR_CODES.INVALID_PATH
          };
        }
        const rootRefusal = await vetSmartFolderRoot({
          folderPath: folder.path,
          logger,
          getCustomFolders,
          getMainWindow,
          abortSignal: event?.abortSignal || null
        });
        if (rootRefusal) return rootRefusal;
        try {
          const stats = await fs.stat(folder.path);
          if (!stats.isDirectory()) {
            return {
              success: false,
              error: `Path "${folder.path}" exists but is not a directory`,
              errorCode: ERROR_CODES.INVALID_PATH
            };
          }
        } catch (error) {
          if (isNotFoundError(error)) {
            // Directory doesn't exist, create it
            try {
              await fs.mkdir(folder.path, { recursive: true });
              logger.info('[SMART-FOLDERS] Created directory:', folder.path);
            } catch (createError) {
              return {
                success: false,
                error: `Failed to create directory "${folder.path}": ${createError.message}`,
                errorCode: ERROR_CODES.DIRECTORY_CREATION_FAILED
              };
            }
          } else {
            throw error;
          }
        }
      }
    }

    const originalFolders = [...getCustomFolders()];
    try {
      setCustomFolders(folders);
      await saveCustomFolders(folders);
      await syncSmartFolderEmbeddings({
        previousFolders: originalFolders,
        nextFolders: folders,
        logger,
        reason: 'save'
      });
      logger.info('[SMART-FOLDERS] Saved Smart Folders:', folders.length);
      return { success: true, folders: getCustomFolders() };
    } catch (saveError) {
      setCustomFolders(originalFolders);
      throw saveError;
    }
  } catch (error) {
    logger.error('[ERROR] Failed to save smart folders:', error);
    return {
      success: false,
      error: error.message,
      errorCode: ERROR_CODES.SAVE_FAILED
    };
  }
}

/**
 * @param {SmartFoldersHandlerContext} ctx
 * @param {IpcMainInvokeEvent} event
 * @param {{ text?: string, smartFolders?: Record<string, any>[] }} payload
 */
async function handleSmartFoldersMatch({ logger }, event, payload) {
  try {
    const { text, smartFolders = [] } = payload || {};
    if (!text || !Array.isArray(smartFolders) || smartFolders.length === 0) {
      return {
        success: false,
        error: 'Invalid input for SMART_FOLDERS.MATCH'
      };
    }

    try {
      // Use FolderMatchingService for efficient embedding generation with caching
      const folderMatchingService = FolderMatchingService.getInstance();

      // Ensure service is initialized (handled internally, but good practice)
      await folderMatchingService.initialize().catch((/** @type {any} */ err) => {
        logger.warn('[SMART_FOLDERS.MATCH] FolderMatchingService init warning:', err.message);
      });

      // Embed the query text
      // embedText handles capping, model selection, and caching automatically

      // This ensures preview matches align with background analysis
      let queryText = text;
      // Simple extension check: dot followed by 1-5 alphanumeric chars at end of string
      const extMatch = text.match(/\.([a-zA-Z0-9]{1,5})$/);
      if (extMatch) {
        queryText = enrichFileTextForEmbedding(text, extMatch[0]);
        logger.debug('[SMART_FOLDERS.MATCH] Enriched query text with semantic keywords', {
          original: text,
          enriched: queryText
        });
      }

      const queryResult = await folderMatchingService.embedText(queryText);
      const queryVector = queryResult.vector;

      if (!queryVector || queryVector.length === 0) {
        throw new Error('Failed to generate query embedding');
      }

      const scored = [];
      const parallelEmbedding = getParallelEmbeddingService();
      const folderItems = smartFolders.map((folder, index) => ({
        id: folder.id || `smart-folder-match:${index}`,
        text: enrichFolderTextForEmbedding(folder.name, folder.description, folder.keywords),
        meta: { folderIndex: index }
      }));

      const { results: folderEmbedResults } = await parallelEmbedding.batchEmbedTexts(folderItems, {
        stopOnError: false
      });

      for (let i = 0; i < smartFolders.length; i += 1) {
        const folder = smartFolders[i];
        const r = folderEmbedResults[i];
        if (!r || !r.success || !Array.isArray(r.vector) || r.vector.length === 0) {
          logger.warn(
            `[SMART_FOLDERS.MATCH] Failed to embed folder "${folder.name}":`,
            r?.error || 'no vector'
          );
          continue;
        }
        const score = cosineSimilarity(queryVector, r.vector);
        scored.push({ folder, score });
      }

      scored.sort((a, b) => b.score - a.score);

      // Bounds check: ensure scored array is not empty
      if (scored.length === 0) {
        throw new Error('No folder scores computed');
      }

      const best = scored[0];
      return {
        success: true,
        folder: best.folder,
        score: best.score,
        method: 'embeddings'
      };
    } catch {
      try {
        const llamaService = getLlamaService();
        await llamaService.initialize();
        const prompt = `You are ranking folders for organizing a file.
Given this description:
"""${text}"""

Folders:
${smartFolders.map((f, i) => `${i + 1}. ${f.name} - ${f.description || ''}`).join('\n')}

Rules:
- Choose exactly ONE folder from the list.
- Do NOT invent new folder names.
- Return ONLY valid JSON in this exact shape:
  {"index": <1-based best folder index>, "reason": "short reason"}`;
        const timeoutMs = TIMEOUTS.AI_ANALYSIS_LONG;
        logger.debug('[SMART_FOLDERS.MATCH] Using text model', {
          model: getTextModel() || AI_DEFAULTS.TEXT.MODEL,
          timeoutMs
        });
        const resp = await withAbortableTimeout(
          (abortController) =>
            llamaService.generateText({
              model: getTextModel() || AI_DEFAULTS.TEXT.MODEL,
              prompt,
              temperature: 0.1,
              maxTokens: 200,
              signal: abortController.signal
            }),
          timeoutMs,
          'Smart folder LLM match'
        );
        // Use robust JSON extraction with repair for malformed LLM responses
        const parsed = /** @type {Record<string, any>|null} */ (
          extractAndParseJSON(resp.response, null)
        );
        if (!parsed) {
          throw new Error('Failed to parse LLM JSON response');
        }
        const parsedIdx = parseInt(parsed.index, 10);
        // Validate parsed index is a valid number
        if (isNaN(parsedIdx) || parsedIdx < 1) {
          throw new Error('Invalid folder index from LLM response');
        }
        const idx = Math.max(1, Math.min(smartFolders.length, parsedIdx));
        return {
          success: true,
          folder: smartFolders[idx - 1],
          reason: parsed.reason,
          method: 'llm'
        };
      } catch {
        const scored = smartFolders
          .map((f) => {
            const textLower = text.toLowerCase();
            const hay = [f.name, f.description].filter(Boolean).join(' ').toLowerCase();
            let score = 0;
            textLower.split(/\W+/).forEach((w) => {
              if (w && hay.includes(w)) score += 1;
            });
            return { folder: f, score };
          })
          .sort((a, b) => b.score - a.score);
        return {
          success: true,
          folder: scored[0]?.folder || smartFolders[0],
          method: 'fallback'
        };
      }
    }
  } catch (error) {
    logger.error('[SMART_FOLDERS.MATCH] Failed:', error);
    return { success: false, error: error.message };
  }
}

/** @param {SmartFoldersHandlerContext} ctx */
async function handleSmartFoldersGet({ logger, getCustomFolders }) {
  try {
    const customFolders = getCustomFolders();
    logger.info(
      '[SMART-FOLDERS] Getting Smart Folders for UI:',
      customFolders?.length || 0,
      'folders'
    );

    if (!Array.isArray(customFolders)) {
      logger.warn('[SMART-FOLDERS] getCustomFolders() returned non-array:', typeof customFolders);
      return [];
    }

    if (customFolders.length === 0) {
      logger.info('[SMART-FOLDERS] No custom folders found, returning empty array');
      return [];
    }

    const folderSettled = await Promise.allSettled(
      customFolders.map(async (folder) => {
        // Skip path check if path is null or empty (default folders)
        if (!folder || !folder.path || folder.path.trim() === '') {
          return { ...folder, physicallyExists: false };
        }
        try {
          const stats = await fs.stat(folder.path);
          return { ...folder, physicallyExists: stats.isDirectory() };
        } catch (error) {
          logger.debug('[SMART-FOLDERS] Path check failed for:', folder.path, error.message);
          return { ...folder, physicallyExists: false };
        }
      })
    );
    const foldersWithStatus = folderSettled.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      logger.warn('[SMART-FOLDERS] Unexpected folder status check failure', {
        index: i,
        reason: r.reason?.message || String(r.reason)
      });
      const folder = customFolders[i];
      return folder && typeof folder === 'object'
        ? { ...folder, physicallyExists: false }
        : { physicallyExists: false };
    });

    logger.info('[SMART-FOLDERS] Returning', foldersWithStatus.length, 'folders with status');
    return foldersWithStatus;
  } catch (error) {
    logger.error('[SMART-FOLDERS] Error in GET handler:', error);
    // Return error response with empty folders array so callers can check success
    // and still safely iterate over folders if they don't check
    return { success: false, error: error.message, folders: /** @type {any[]} */ ([]) };
  }
}

/**
 * @param {IpcServiceContext|Record<string, any>} servicesOrParams - Service context or legacy parameters
 */
function registerSmartFoldersIpc(servicesOrParams) {
  let container;
  if (servicesOrParams instanceof IpcServiceContext) {
    container = servicesOrParams;
  } else {
    // Handling the case where getSmartFolderWatcher might be passed in legacy params
    // but createFromLegacyParams doesn't explicitly handle it in the 'set' methods
    // unless we add it or just extract it from params if it's there.
    // However, the new pattern is to derive it from serviceIntegration.
    container = createFromLegacyParams(servicesOrParams);
  }

  const { ipcMain, IPC_CHANNELS, logger } = container.core;
  const { getCustomFolders, setCustomFolders, saveCustomFolders, scanDirectory } =
    container.folders;
  const { getServiceIntegration } = container;
  const getMainWindow = container.electron?.getMainWindow;

  // Derive getSmartFolderWatcher from serviceIntegration if not provided
  // (In legacy mode, it might have been passed directly, but we want to move away from that)
  // Actually, registerAllIpc passes a custom function.
  // If I use IpcServiceContext, I should replicate that logic here.

  // Same resolution the batch organize handler uses; tests inject their own.
  const getFilePathCoordinator = () => {
    const injected = /** @type {Record<string, any>} */ (servicesOrParams)?.getFilePathCoordinator;
    if (typeof injected === 'function') return injected();
    try {
      const { container: sc, ServiceIds } = require('../services/ServiceContainer');
      if (sc.has(ServiceIds.FILE_PATH_COORDINATOR)) {
        return sc.resolve(ServiceIds.FILE_PATH_COORDINATOR);
      }
    } catch {
      // Container not wired (tests / legacy params) — the handler logs the gap.
    }
    return null;
  };

  const getSmartFolderWatcher = () => {
    if (getServiceIntegration) {
      const serviceIntegration = getServiceIntegration();
      return serviceIntegration?.smartFolderWatcher || null;
    }
    // Fallback for legacy params if it was passed directly (though createFromLegacyParams doesn't store it)
    // If servicesOrParams is object and has getSmartFolderWatcher, use it?
    if (/** @type {Record<string, any>} */ (servicesOrParams).getSmartFolderWatcher) {
      return /** @type {Record<string, any>} */ (servicesOrParams).getSmartFolderWatcher();
    }
    return null;
  };

  const context = 'SmartFolders';
  const schemaVoid = z ? z.void() : null;
  const schemaString = z ? z.string().min(1) : null;
  const schemaFolder = validationSchemas?.smartFolder ?? null;
  const schemaFolderArray = validationSchemas?.smartFoldersArray ?? null;
  const schemaEditFolder = validationSchemas?.smartFolderEdit ?? null;

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SMART_FOLDERS.GET,
    createHandler({
      logger,
      context,
      schema: schemaVoid,
      handler: () => handleSmartFoldersGet({ logger, getCustomFolders })
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SMART_FOLDERS.GET_CUSTOM,
    createHandler({
      logger,
      context,
      schema: schemaVoid,
      handler: () => handleSmartFoldersGetCustom({ logger, getCustomFolders })
    })
  );

  // Smart folder matching using embeddings/LLM with fallbacks
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SMART_FOLDERS.MATCH,
    createHandler({
      logger,
      context,
      schema: schemaFolderMatch,
      handler: (event, payload) => handleSmartFoldersMatch({ logger }, event, payload)
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SMART_FOLDERS.SAVE,
    createHandler({
      logger,
      context,
      schema: schemaFolderArray,
      handler: (event, folders) =>
        handleSmartFoldersSave(
          {
            logger,
            getCustomFolders,
            setCustomFolders,
            saveCustomFolders,
            getSmartFolderWatcher,
            getMainWindow
          },
          event,
          folders
        )
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SMART_FOLDERS.UPDATE_CUSTOM,
    createHandler({
      logger,
      context,
      schema: schemaFolderArray,
      handler: (event, folders) =>
        handleSmartFoldersUpdateCustom(
          {
            logger,
            getCustomFolders,
            setCustomFolders,
            saveCustomFolders,
            getSmartFolderWatcher,
            getMainWindow
          },
          event,
          folders
        )
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SMART_FOLDERS.EDIT,
    createHandler({
      logger,
      context,
      schema: schemaEditFolder,
      handler: (event, folderId, updatedFolder) =>
        handleSmartFoldersEdit(
          {
            logger,
            getCustomFolders,
            setCustomFolders,
            saveCustomFolders,
            getServiceIntegration,
            getFilePathCoordinator,
            getSmartFolderWatcher,
            getMainWindow
          },
          event,
          folderId,
          updatedFolder
        )
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SMART_FOLDERS.DELETE,
    createHandler({
      logger,
      context,
      schema: schemaString,
      handler: (event, folderId) =>
        handleSmartFoldersDelete(
          { logger, getCustomFolders, setCustomFolders, saveCustomFolders, getSmartFolderWatcher },
          event,
          folderId
        )
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SMART_FOLDERS.GENERATE_DESCRIPTION,
    createHandler({
      logger,
      context,
      schema: schemaString,
      handler: (event, folderName) =>
        handleSmartFoldersGenerateDescription({ logger }, event, folderName)
    })
  );

  // Create/add new smart folder with LLM enhancement
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SMART_FOLDERS.ADD,
    createHandler({
      logger,
      context,
      schema: schemaFolder,
      handler: (event, folder) =>
        handleSmartFoldersAdd(
          {
            logger,
            getCustomFolders,
            setCustomFolders,
            saveCustomFolders,
            getSmartFolderWatcher,
            getMainWindow,
            getServiceIntegration
          },
          event,
          folder
        )
    })
  );

  // Scan folder structure
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SMART_FOLDERS.SCAN_STRUCTURE,
    createHandler({
      logger,
      context,
      schema: schemaString,
      handler: (event, rootPath) =>
        handleSmartFoldersScanStructure({ logger, scanDirectory }, event, rootPath)
    })
  );

  // Reset smart folders to defaults
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SMART_FOLDERS.RESET_TO_DEFAULTS,
    createHandler({
      logger,
      context,
      schema: schemaVoid,
      handler: () =>
        handleSmartFoldersResetToDefaults({
          logger,
          getCustomFolders,
          setCustomFolders,
          getSmartFolderWatcher
        })
    })
  );

  // ============== Smart Folder Watcher IPC Handlers ==============

  // Start the smart folder watcher
  // Note: Smart folder watching is always enabled - this is mainly used for restart/recovery
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SMART_FOLDERS.WATCHER_START,
    createHandler({
      logger,
      context,
      schema: schemaVoid,
      handler: () => handleSmartFoldersWatcherStart({ logger, getSmartFolderWatcher })
    })
  );

  // Stop the smart folder watcher
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SMART_FOLDERS.WATCHER_STOP,
    createHandler({
      logger,
      context,
      schema: schemaVoid,
      handler: () => handleSmartFoldersWatcherStop({ logger, getSmartFolderWatcher })
    })
  );

  // Get watcher status
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SMART_FOLDERS.WATCHER_STATUS,
    createHandler({
      logger,
      context,
      schema: schemaVoid,
      handler: () => handleSmartFoldersWatcherStatus({ logger, getSmartFolderWatcher })
    })
  );
}

module.exports = registerSmartFoldersIpc;
module.exports.sanitizeFolderPath = sanitizeFolderPath;
