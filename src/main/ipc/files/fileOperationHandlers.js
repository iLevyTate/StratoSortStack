// @ts-check
/**
 * File Operation Handlers
 *
 * Handlers for individual file operations (move, copy, delete).
 *
 * @module ipc/files/fileOperationHandlers
 */

const path = require('path');
const fs = require('fs').promises;
const fsConstants = require('fs').constants;
const { ACTION_TYPES, IPC_EVENTS } = require('../../../shared/constants');
const { createHandler, safeHandle, safeSend, z } = require('../ipcWrappers');
const { logger: baseLogger, createLogger } = require('../../../shared/logger');
const { handleBatchOrganize } = require('./batchOrganizeHandler');
const { schemas } = require('../validationSchemas');
const { validateFileOperationPath } = require('../../../shared/pathSanitization');
const {
  isNotFoundError,
  isPermissionError,
  isExistsError,
  ErrorCategory,
  getErrorCategory
} = require('../../../shared/errorClassifier');
const {
  traceMoveStart,
  traceMoveComplete,
  traceCopyStart,
  traceCopyComplete,
  traceDeleteStart,
  traceDeleteComplete,
  traceDbUpdate,
  PathChangeReason
} = require('../../../shared/pathTraceLogger');
const {
  getInstance: getLearningFeedbackService,
  FEEDBACK_SOURCES
} = require('../../services/organization/learningFeedback');
const {
  syncEmbeddingForMove,
  removeEmbeddingsForPathBestEffort,
  verifyEmbeddingAfterMove
} = require('./embeddingSync');
const { withTimeout } = require('../../../shared/promiseUtils');
const { crossDeviceMove, renameNoReplace } = require('../../../shared/atomicFileOperations');
const { handleDuplicateMove } = require('../../utils/fileDedup');
// Destination containment, the main-process folder prompt and the optional
// STRATOSORT_STRICT_FILE_OPS allowlist (shared with batch organize).
const {
  authorizeDestination,
  authorizeDestinations,
  decisionForDestination,
  buildStrictFileOpsAllowlist
} = require('./destinationPolicy');

// Alias for backward compatibility
const operationSchema = schemas?.fileOperation || null;
const schemaFilePath = z ? z.string().min(1) : null;
const schemaCopyPaths = z ? z.tuple([z.string().min(1), z.string().min(1)]) : null;
// files:delete takes the path alone, or the path plus `{ permanent: true }`
// once the user has confirmed a permanent delete after the OS trash failed.
const schemaDeleteFile = z
  ? z.union([
      z.string().min(1),
      z.tuple([z.string().min(1), z.object({ permanent: z.boolean().optional() })])
    ])
  : null;

const logger =
  typeof createLogger === 'function' ? createLogger('IPC:Files:Operations') : baseLogger;
if (typeof createLogger !== 'function' && logger?.setContext) {
  logger.setContext('IPC:Files:Operations');
}

/**
 * Invalidate clustering cache after file operations.
 * Extracted from 6 identical inline blocks.
 * @param {import('../ipcWrappers').LoggerLike} log
 */
function invalidateClustersIfAvailable(log) {
  try {
    const { getClusteringServiceInstance } = require('../semantic');
    const clusteringService = getClusteringServiceInstance?.();
    if (clusteringService) {
      clusteringService.invalidateClusters();
    }
  } catch (invalidateErr) {
    log.warn('[FILE-OPS] Failed to invalidate clustering cache', {
      error: invalidateErr.message
    });
  }
}

/**
 * Validate source and destination paths for file operations
 * @param {string} source - Source file path
 * @param {string|null|undefined} destination - Destination file path (optional for delete)
 * @param {import('../ipcWrappers').LoggerLike} log - Logger instance
 * @param {(() => any)|null|undefined} [getServiceIntegration] - Service accessor for strict-mode allowlist
 * @returns {Promise<{valid: boolean, source?: string, destination?: string, error?: string}>}
 */
async function validateOperationPaths(source, destination, log, getServiceIntegration) {
  const strict = buildStrictFileOpsAllowlist(getServiceIntegration);
  const extraOpts = strict.enabled ? { allowedBasePaths: strict.allowlist } : {};

  // Validate source path
  const sourceResult = await validateFileOperationPath(source, {
    checkSymlinks: true,
    ...extraOpts
  });

  if (!sourceResult.valid) {
    log.warn('[FILE-OPS] Source path validation failed', {
      source,
      error: sourceResult.error
    });
    return {
      valid: false,
      error: `Invalid source path: ${sourceResult.error}`
    };
  }

  // If no destination, return validated source only
  if (!destination) {
    return { valid: true, source: sourceResult.normalizedPath };
  }

  // Validate destination path
  const destResult = await validateFileOperationPath(destination, {
    checkSymlinks: true,
    ...extraOpts
  });

  if (!destResult.valid) {
    log.warn('[FILE-OPS] Destination path validation failed', {
      destination,
      error: destResult.error
    });
    return {
      valid: false,
      error: `Invalid destination path: ${destResult.error}`
    };
  }

  return {
    valid: true,
    source: sourceResult.normalizedPath,
    destination: destResult.normalizedPath
  };
}

/**
 * TOCTOU mitigation: re-run symlink-aware validation on the source path
 * immediately before a destructive fs op (rename, copyFile). Between the
 * initial `validateOperationPaths` call and the op itself we do several
 * async awaits (dedup check, DB writes, embedding sync prep), which opens
 * a window where an attacker with write access to the source's parent
 * directory could swap the file for a symlink pointing at e.g. a system
 * secret. Node's fs API has no fd-based rename/copyFile, so the best we
 * can do is narrow the window to a single await and re-verify that the
 * resolved realpath still passes `validateFileOperationPath`.
 *
 * On mismatch we throw `EPATHCHANGED` so the caller's safeHandle wrapper
 * surfaces a structured error and the op never touches disk.
 *
 * @param {string} sourcePath - Source path that was validated earlier.
 * @param {import('../ipcWrappers').LoggerLike} log - Logger instance.
 * @param {string} [context='op'] - Op name for logs (e.g. 'move', 'copy').
 * @returns {Promise<void>}
 */
// Short backoff before the single retry: long enough to outlast a typical
// AV scan / OneDrive Files-On-Demand stat completion, short enough that
// genuine path tampering is still detected in well under a second total.
const EPATHCHANGED_RETRY_DELAY_MS = 75;

/**
 * @param {string} sourcePath - Source path that was validated earlier.
 * @param {import('../ipcWrappers').LoggerLike} log - Logger instance.
 * @param {string} [context='op'] - Op name for logs (e.g. 'move', 'copy').
 * @returns {Promise<void>}
 */
async function preflightSourceForMutation(sourcePath, log, context = 'op') {
  const runCheck = () =>
    validateFileOperationPath(sourcePath, {
      checkSymlinks: true
    });

  let recheck = await runCheck();
  if (!recheck.valid) {
    // On Windows, aggressive AV scanning and OneDrive Files-On-Demand can
    // briefly stat the source as something that fails our symlink check
    // (e.g. transient reparse-point markers). One short retry distinguishes
    // those benign blips from a real attacker swapping the source for a
    // symlink to a secret. If the second check still fails we keep the
    // original fail-closed behavior.
    log.debug(`[FILE-OPS] TOCTOU recheck transient failure, retrying once`, {
      sourcePath,
      context,
      error: recheck.error,
      retryDelayMs: EPATHCHANGED_RETRY_DELAY_MS
    });
    await new Promise((resolve) => setTimeout(resolve, EPATHCHANGED_RETRY_DELAY_MS));
    recheck = await runCheck();
  }

  if (!recheck.valid) {
    log.warn(`[FILE-OPS] TOCTOU guard rejected source before ${context}`, {
      sourcePath,
      error: recheck.error
    });
    const err = /** @type {Error & { code?: string }} */ (
      new Error(`Path validation changed between check and use (${context}): ${recheck.error}`)
    );
    err.code = 'EPATHCHANGED';
    throw err;
  }
}

/**
 * Get FilePathCoordinator from ServiceContainer if available
 * @returns {Record<string, any>|null} FilePathCoordinator instance or null
 */
function getFilePathCoordinator() {
  try {
    const { container, ServiceIds } = require('../../services/ServiceContainer');
    if (container.has(ServiceIds.FILE_PATH_COORDINATOR)) {
      return container.resolve(ServiceIds.FILE_PATH_COORDINATOR);
    }
  } catch (error) {
    logger.debug('[FILE-OPS] FilePathCoordinator unavailable:', error?.message);
  }
  return null;
}

/**
 * Get AnalysisHistoryService from ServiceContainer if available
 * @returns {Record<string, any>|null} AnalysisHistoryService instance or null
 */
function getAnalysisHistoryService() {
  try {
    const { container, ServiceIds } = require('../../services/ServiceContainer');
    if (container.has(ServiceIds.ANALYSIS_HISTORY)) {
      return container.resolve(ServiceIds.ANALYSIS_HISTORY);
    }
  } catch (error) {
    logger.debug('[FILE-OPS] AnalysisHistoryService unavailable:', error?.message);
  }
  return null;
}

/**
 * @param {{ sourcePath: string|null|undefined, destPath: string, log: import('../ipcWrappers').LoggerLike, context: string }} args
 */
async function syncEmbeddingsBestEffort({ sourcePath, destPath, log, context }) {
  const timeoutMs = 5000;
  const operation = context === 'copy' ? 'copy' : 'move';
  const label = context ? `Embedding sync (${context})` : 'Embedding sync';
  try {
    await withTimeout(
      syncEmbeddingForMove({
        sourcePath,
        destPath,
        operation,
        log
      }),
      timeoutMs,
      label
    );
  } catch (syncErr) {
    // warn (not debug): stale embeddings make files invisible to search,
    // which the user notices but can't easily diagnose if the only signal
    // is a debug log. Operators / support need this in default logs.
    log.warn(`[FILE-OPS] ${label} failed (non-fatal):`, {
      error: syncErr.message
    });
  }

  // Post-sync verification: ensure the embedding is correctly stored at the
  // destination and no stale embedding lingers at the source.
  try {
    const verification = await withTimeout(
      verifyEmbeddingAfterMove({ sourcePath, destPath, operation, log }),
      3000,
      'Post-move embedding verification'
    );
    if (!verification.valid && verification.issues.length > 0) {
      log.warn(`[FILE-OPS] Embedding verification after ${context} found issues`, {
        sourcePath: sourcePath ? path.basename(sourcePath) : null,
        destPath: path.basename(destPath),
        issues: verification.issues
      });
    }
  } catch (verifyErr) {
    // Non-fatal: verification is advisory
    log.debug('[FILE-OPS] Post-move embedding verification timed out or failed', {
      error: verifyErr?.message
    });
  }
}

/**
 * Update database path after file move
 * Uses FilePathCoordinator when available for atomic updates across all systems.
 * Falls back to direct service calls if coordinator is unavailable.
 * Updates both file: and image: prefixes to handle all file types.
 * @param {string} source
 * @param {string} destination
 * @param {import('../ipcWrappers').LoggerLike} log
 */
async function updateDatabasePath(source, destination, log) {
  let dbSyncWarning = null;
  try {
    // Re-validate paths before database update to prevent path traversal
    const sourceValidation = await validateFileOperationPath(source, { checkSymlinks: false });
    const destValidation = await validateFileOperationPath(destination, { checkSymlinks: false });

    if (!sourceValidation.valid) {
      log.warn('[FILE-OPS] Invalid source path for DB update', {
        source,
        error: sourceValidation.error
      });
      return `Database sync skipped: Invalid source path`;
    }
    if (!destValidation.valid) {
      log.warn('[FILE-OPS] Invalid destination path for DB update', {
        destination,
        error: destValidation.error
      });
      return `Database sync skipped: Invalid destination path`;
    }

    const safeSource = sourceValidation.normalizedPath;
    const safeDest = destValidation.normalizedPath;

    // Use FilePathCoordinator for atomic updates across all systems
    const coordinator = getFilePathCoordinator();
    if (coordinator) {
      log.debug('[FILE-OPS] Using FilePathCoordinator for atomic path update');

      // PATH-TRACE: Log coordinator path update start
      traceDbUpdate('coordinator', safeSource, safeDest, true);

      const result = await coordinator.atomicPathUpdate(safeSource, safeDest, {
        type: 'move',
        skipProcessingState: true // Processing state is managed by the caller
      });

      if (!result.success && result.errors.length > 0) {
        dbSyncWarning = `Some systems failed to update: ${result.errors.map((/** @type {any} */ e) => e.system).join(', ')}`;
        // PATH-TRACE: Log coordinator path update with errors
        traceDbUpdate('coordinator', safeSource, safeDest, false, dbSyncWarning);
      }
      return dbSyncWarning;
    }

    log.warn('[FILE-OPS] FilePathCoordinator unavailable, skipping database update');
    return 'Database sync skipped: Coordinator unavailable';
  } catch (dbError) {
    log.warn('[FILE-OPS] Database path update failed after move', {
      error: dbError.message
    });
    dbSyncWarning = `File moved but database sync failed: ${dbError.message}`;
  }
  return dbSyncWarning;
}

/**
 * Delete file from database and clean up pending embeddings
 * Uses FilePathCoordinator when available for atomic cleanup across all systems.
 * Falls back to direct service calls if coordinator is unavailable.
 * Deletes both file: and image: prefixes to handle all file types.
 * @param {string} filePath
 * @param {import('../ipcWrappers').LoggerLike} log
 */
async function deleteFromDatabase(filePath, log) {
  let dbDeleteWarning = null;

  // Use FilePathCoordinator for atomic cleanup across all systems
  const coordinator = getFilePathCoordinator();
  if (coordinator) {
    log.debug('[FILE-OPS] Using FilePathCoordinator for atomic file deletion cleanup');
    try {
      const result = await coordinator.handleFileDeletion(filePath);
      if (!result.success && result.errors.length > 0) {
        dbDeleteWarning = `Some systems failed to cleanup: ${result.errors.map((/** @type {any} */ e) => e.system).join(', ')}`;
      }
      return dbDeleteWarning;
    } catch (coordError) {
      log.warn('[FILE-OPS] FilePathCoordinator deletion failed', {
        error: coordError.message
      });
    }
  } else {
    log.warn('[FILE-OPS] FilePathCoordinator unavailable, skipping atomic deletion cleanup');
  }

  return dbDeleteWarning;
}

/**
 * @param {string} filePath
 * @param {(() => any)|null|undefined} getServiceIntegration
 * @param {import('../ipcWrappers').LoggerLike} log
 */
async function clearReadyQueueEntryBestEffort(filePath, getServiceIntegration, log) {
  try {
    await getServiceIntegration?.()?.processingState?.clearReadyAnalysis?.(filePath);
  } catch (error) {
    log.debug('[FILE-OPS] Failed to clear durable ready queue entry (non-fatal)', {
      filePath,
      error: error?.message
    });
  }
}

/**
 * @param {{ operation: string, oldPath?: string|null, newPath?: string|null, getMainWindow: (() => any)|null|undefined, log: import('../ipcWrappers').LoggerLike, context: string }} args
 */
function notifyRendererFileOperation({ operation, oldPath, newPath, getMainWindow, log, context }) {
  try {
    const mainWindow = getMainWindow?.();
    if (mainWindow && !mainWindow.isDestroyed()) {
      const payload = {
        operation,
        ...(oldPath ? { oldPath } : {}),
        ...(newPath ? { newPath } : {})
      };
      safeSend(mainWindow.webContents, IPC_EVENTS.FILE_OPERATION_COMPLETE, payload);
    }
  } catch (notifyErr) {
    log.warn(`[FILE-OPS] Failed to notify renderer of ${context}`, {
      error: notifyErr.message
    });
  }
}

/**
 * @param {{ reason: string, oldPath?: string|null, newPath?: string|null, log: import('../ipcWrappers').LoggerLike, context: string }} args
 */
function invalidateSearchIndexBestEffort({ reason, oldPath, newPath, log, context }) {
  try {
    const { getSearchServiceInstance } = require('../semantic');
    const searchService = getSearchServiceInstance?.();
    if (searchService) {
      searchService
        .invalidateAndRebuild({
          immediate: false,
          reason,
          ...(oldPath ? { oldPath } : {}),
          ...(newPath ? { newPath } : {})
        })
        .catch((/** @type {any} */ rebuildErr) => {
          log.warn(`[FILE-OPS] Background BM25 rebuild failed after ${context}`, {
            error: rebuildErr?.message
          });
        });
    }
  } catch (invalidateErr) {
    log.warn(`[FILE-OPS] Failed to trigger search index rebuild after ${context}`, {
      error: invalidateErr.message
    });
  }
}

/**
 * @param {{ sourcePath: string, destinationPath: string, log: import('../ipcWrappers').LoggerLike, getServiceIntegration: (() => any)|null|undefined, getMainWindow: (() => any)|null|undefined }} args
 */
async function finalizeMoveSideEffects({
  sourcePath,
  destinationPath,
  log,
  getServiceIntegration,
  getMainWindow
}) {
  const dbSyncWarning = await updateDatabasePath(sourcePath, destinationPath, log);
  await clearReadyQueueEntryBestEffort(sourcePath, getServiceIntegration, log);

  notifyRendererFileOperation({
    operation: 'move',
    oldPath: sourcePath,
    newPath: destinationPath,
    getMainWindow,
    log,
    context: 'file move'
  });

  invalidateSearchIndexBestEffort({
    reason: 'file-move',
    oldPath: sourcePath,
    newPath: destinationPath,
    log,
    context: 'move'
  });
  invalidateClustersIfAvailable(log);

  return dbSyncWarning;
}

/**
 * @param {{ filePath: string, log: import('../ipcWrappers').LoggerLike, getServiceIntegration: (() => any)|null|undefined, getMainWindow: (() => any)|null|undefined, searchReason?: string, context?: string }} args
 */
async function finalizeDeleteSideEffects({
  filePath,
  log,
  getServiceIntegration,
  getMainWindow,
  searchReason = 'file-delete',
  context = 'delete'
}) {
  const dbDeleteWarning = await deleteFromDatabase(filePath, log);
  await clearReadyQueueEntryBestEffort(filePath, getServiceIntegration, log);

  notifyRendererFileOperation({
    operation: 'delete',
    oldPath: filePath,
    getMainWindow,
    log,
    context: `file ${context}`
  });

  invalidateSearchIndexBestEffort({
    reason: searchReason,
    oldPath: filePath,
    log,
    context
  });
  invalidateClustersIfAvailable(log);

  return dbDeleteWarning;
}

/**
 * Move one file with every side effect of the `move` operation (validation,
 * duplicate detection, no-replace rename, path index, learning feedback,
 * embeddings). Shared by `move` (one undo entry per call) and `batch_move`
 * (one MOVE_BATCH entry for the whole selection, recorded by the caller).
 * `movedFrom` / `movedTo` carry the validated paths for the caller's undo
 * record; the `move` case strips them from its public result.
 *
 * @param {{ source?: string, destination?: string }} operation
 * @param {{ log: import('../ipcWrappers').LoggerLike, getServiceIntegration: (() => any)|null|undefined, getMainWindow: (() => any)|null|undefined, recordUndo: boolean, destinationDecision?: import('./destinationPolicy').DestinationDecision|null, abortSignal?: AbortSignal|null }} deps
 * @returns {Promise<Record<string, any>>}
 */
async function moveOneFile(
  operation,
  {
    log,
    getServiceIntegration,
    getMainWindow,
    recordUndo,
    destinationDecision: preset = null,
    abortSignal = null
  }
) {
  const moveValidation = await validateOperationPaths(
    operation.source,
    operation.destination,
    log,
    getServiceIntegration
  );
  if (!moveValidation.valid) {
    return {
      success: false,
      error: moveValidation.error,
      errorCode: 'INVALID_PATH'
    };
  }
  // Destination policy: the landing folder must be one the user has shown
  // intent for, or be confirmed in a main-process dialog (destinationPolicy).
  const destinationDecision =
    preset ||
    (await authorizeDestination(moveValidation.destination, {
      sourcePath: moveValidation.source,
      getServiceIntegration,
      getMainWindow,
      log,
      abortSignal,
      intent: { count: 1, name: path.basename(moveValidation.destination) }
    }));
  if (!destinationDecision.allowed) {
    return {
      success: false,
      error: destinationDecision.error,
      errorCode: destinationDecision.errorCode || 'DESTINATION_NOT_ALLOWED'
    };
  }

  // PATH-TRACE: Log move start
  traceMoveStart(
    moveValidation.source,
    moveValidation.destination,
    'fileOperationHandlers',
    PathChangeReason.USER_MOVE
  );

  // Check for identical content at destination before moving.
  // Prevents creating duplicates when the same file already exists there.
  const duplicateResult = await handleDuplicateMove({
    sourcePath: moveValidation.source,
    destinationPath: moveValidation.destination,
    logger: log,
    logPrefix: '[FILE-OPS]',
    dedupContext: 'singleMove',
    removeEmbeddings: removeEmbeddingsForPathBestEffort
  });
  if (duplicateResult) {
    traceMoveComplete(
      moveValidation.source,
      duplicateResult.destination,
      'fileOperationHandlers',
      true
    );
    const dbDeleteWarning = await finalizeDeleteSideEffects({
      filePath: moveValidation.source,
      log,
      getServiceIntegration,
      getMainWindow,
      searchReason: 'file-dedup-delete',
      context: 'dedup-move'
    });
    const removal =
      duplicateResult.sourceRemoval === 'trashed' ? 'source moved to the trash' : 'source removed';
    return {
      success: true,
      message: `Duplicate detected - ${removal}, identical file already at ${duplicateResult.destination}`,
      skipped: true,
      reason: 'duplicate',
      destination: duplicateResult.destination,
      sourceRemoval: duplicateResult.sourceRemoval || 'deleted',
      ...(dbDeleteWarning && { warning: dbDeleteWarning })
    };
  }

  // TOCTOU guard: re-verify the source right before touching disk.
  await preflightSourceForMutation(moveValidation.source, log, 'move');

  try {
    // renameNoReplace, not fs.rename: a bare rename silently REPLACES
    // an occupied destination on every platform. A manual move targets
    // an exact user-chosen destination, so refuse loudly (FILE_EXISTS)
    // instead of destroying the occupant or silently suffixing.
    await renameNoReplace(moveValidation.source, moveValidation.destination);
  } catch (renameError) {
    if (renameError.code === 'EEXIST') {
      return {
        success: false,
        error: `A different file already exists at ${moveValidation.destination}`,
        errorCode: 'FILE_EXISTS'
      };
    }
    if (renameError.code === 'EXDEV') {
      // Cross-device move: fall back to copy + delete. copyFile
      // follows symlinks on the source, so the TOCTOU re-check
      // we just did is load-bearing — but `fs.rename` returning
      // EXDEV took at least one syscall's worth of time, and on a
      // contended Windows AV system that window can stretch.
      // Re-validate immediately before we hand the source path to
      // copyFile.
      await preflightSourceForMutation(moveValidation.source, log, 'move-exdev');
      await crossDeviceMove(moveValidation.source, moveValidation.destination);
    } else {
      throw renameError;
    }
  }

  // PATH-TRACE: Log move complete (fs operation)
  traceMoveComplete(
    moveValidation.source,
    moveValidation.destination,
    'fileOperationHandlers',
    true
  );

  if (recordUndo) {
    try {
      await getServiceIntegration()?.undoRedo?.recordAction?.(ACTION_TYPES.FILE_MOVE, {
        originalPath: moveValidation.source,
        newPath: moveValidation.destination
      });
    } catch (undoErr) {
      // Non-fatal: file move succeeded, undo history may be incomplete
      log.debug('[FILE-OPS] Failed to record undo action', { error: undoErr?.message });
    }
  }

  const dbSyncWarning = await finalizeMoveSideEffects({
    sourcePath: moveValidation.source,
    destinationPath: moveValidation.destination,
    log,
    getServiceIntegration,
    getMainWindow
  });

  // Record learning feedback if file was moved to a smart folder
  // This teaches the system from user's manual organization decisions
  try {
    const learningService = getLearningFeedbackService();
    if (learningService) {
      await learningService.recordFileMove(
        moveValidation.source,
        moveValidation.destination,
        null, // No analysis available for manual moves
        FEEDBACK_SOURCES.MANUAL_MOVE
      );
    }
  } catch (learnErr) {
    // Non-fatal - learning failure shouldn't block the move operation
    log.debug('[FILE-OPS] Learning feedback recording failed', {
      error: learnErr.message
    });
  }

  // Ensure embeddings reflect the final smart folder destination (best effort)
  // Required to update metadata (smartFolder field) and handle "move out" cleanup
  await syncEmbeddingsBestEffort({
    sourcePath: moveValidation.source,
    destPath: moveValidation.destination,
    log,
    context: 'move'
  });

  return {
    success: true,
    message: `Moved ${moveValidation.source} to ${moveValidation.destination}`,
    movedFrom: moveValidation.source,
    movedTo: moveValidation.destination,
    ...(dbSyncWarning && { warning: dbSyncWarning })
  };
}

/**
 * Create the perform operation handler
 * @param {{ logger: import('../ipcWrappers').LoggerLike, getServiceIntegration: (() => any)|null|undefined, getMainWindow: (() => any)|null|undefined }} deps
 * @returns {import('../ipcWrappers').IpcHandlerFn}
 */
function createPerformOperationHandler({ logger: log, getServiceIntegration, getMainWindow }) {
  return async (event, operation) => {
    if (!operation || typeof operation !== 'object') {
      return {
        success: false,
        error: 'Invalid operation: expected an object',
        errorCode: 'INVALID_OPERATION'
      };
    }

    if (!operation.type || typeof operation.type !== 'string') {
      return {
        success: false,
        error: 'Invalid operation: missing or invalid type',
        errorCode: 'INVALID_OPERATION_TYPE'
      };
    }

    try {
      log.info('[FILE-OPS] Performing operation:', {
        type: operation.type,
        source: operation.source ? path.basename(operation.source) : 'N/A',
        destination: operation.destination ? path.basename(operation.destination) : 'N/A'
      });

      switch (operation.type) {
        case 'move': {
          const single = await moveOneFile(operation, {
            log,
            getServiceIntegration,
            getMainWindow,
            recordUndo: true,
            abortSignal: event?.abortSignal || null
          });
          const { movedFrom: _from, movedTo: _to, ...publicResult } = single;
          return publicResult;
        }

        case 'copy': {
          const copyValidation = await validateOperationPaths(
            operation.source,
            operation.destination,
            log,
            getServiceIntegration
          );
          if (!copyValidation.valid) {
            return {
              success: false,
              error: copyValidation.error,
              errorCode: 'INVALID_PATH'
            };
          }
          const copyDestination = await authorizeDestination(copyValidation.destination, {
            sourcePath: copyValidation.source,
            getServiceIntegration,
            getMainWindow,
            log,
            abortSignal: event?.abortSignal || null,
            intent: { count: 1, name: path.basename(copyValidation.destination) }
          });
          if (!copyDestination.allowed) {
            return {
              success: false,
              error: copyDestination.error,
              errorCode: copyDestination.errorCode || 'DESTINATION_NOT_ALLOWED'
            };
          }

          // PATH-TRACE: Log copy start
          traceCopyStart(
            copyValidation.source,
            copyValidation.destination,
            'fileOperationHandlers'
          );

          const destinationDir = path.dirname(copyValidation.destination);
          await fs.mkdir(destinationDir, { recursive: true });

          // TOCTOU guard: copyFile follows symlinks on the source, so an
          // attacker who swapped the source for a link to a secret between
          // validation and here could exfiltrate it into the dest dir.
          await preflightSourceForMutation(copyValidation.source, log, 'copy');

          try {
            // COPYFILE_EXCL: without it copyFile silently REPLACES an
            // occupied destination. A manual copy targets an exact
            // user-chosen destination, so refuse loudly (FILE_EXISTS) —
            // mirroring the move case above — instead of destroying the
            // occupant.
            await fs.copyFile(
              copyValidation.source,
              copyValidation.destination,
              fsConstants.COPYFILE_EXCL
            );
          } catch (copyError) {
            if (isExistsError(copyError)) {
              return {
                success: false,
                error: `A different file already exists at ${copyValidation.destination}`,
                errorCode: 'FILE_EXISTS'
              };
            }
            throw copyError;
          }

          // PATH-TRACE: Log copy complete (fs operation)
          traceCopyComplete(
            copyValidation.source,
            copyValidation.destination,
            'fileOperationHandlers',
            true
          );

          // Use FilePathCoordinator for atomic copy handling across all systems
          // This ensures analysis history and vector DB entries are cloned atomically
          const coordinator = getFilePathCoordinator();
          let copyDbSyncWarning = null;
          if (coordinator) {
            log.debug('[FILE-OPS] Using FilePathCoordinator for atomic copy handling');
            const copyResult = await coordinator.handleFileCopy(
              copyValidation.source,
              copyValidation.destination
            );
            if (!copyResult.success && copyResult.errors.length > 0) {
              copyDbSyncWarning = `Copy succeeded but database sync failed: ${copyResult.errors.map((/** @type {any} */ e) => e.system).join(', ')}`;
              log.warn('[FILE-OPS] Some systems failed during copy', {
                errors: copyResult.errors.map((/** @type {any} */ e) => e.system)
              });
            }
          } else {
            copyDbSyncWarning =
              'Copy succeeded but FilePathCoordinator unavailable; analysis history / embeddings not cloned';
            log.warn(
              '[FILE-OPS] FilePathCoordinator unavailable, copy operations skipped for database/history'
            );
          }

          // Invalidate search index in background to include the copy
          try {
            const { getSearchServiceInstance } = require('../semantic');
            const searchService = getSearchServiceInstance?.();
            if (searchService) {
              searchService
                .invalidateAndRebuild({
                  immediate: false,
                  reason: 'file-copy',
                  newPath: copyValidation.destination
                })
                .catch((/** @type {any} */ rebuildErr) => {
                  log.warn('[FILE-OPS] Background BM25 rebuild failed after copy', {
                    error: rebuildErr.message
                  });
                });
            }
          } catch (invalidateErr) {
            log.warn('[FILE-OPS] Failed to trigger search index rebuild after copy', {
              error: invalidateErr.message
            });
          }

          invalidateClustersIfAvailable(log);

          // Ensure embeddings reflect the final smart folder destination (best effort)
          await syncEmbeddingsBestEffort({
            sourcePath: copyValidation.source,
            destPath: copyValidation.destination,
            log,
            context: 'copy'
          });

          // P04-C: record the copy so it can be undone (undo trashes the copied
          // destination; the source is left untouched). Mirrors the FILE_MOVE
          // recording above; non-fatal if the undo service is unavailable.
          try {
            // Record the copy's identity (size + mtime) so undo/redo can tell
            // "still the file we copied" from "user's unrelated file that now
            // occupies this path" — undo must never trash the latter.
            let copiedSize = null;
            let copiedMtimeMs = null;
            try {
              const copiedStat = await fs.stat(copyValidation.destination);
              copiedSize = copiedStat.size;
              copiedMtimeMs = copiedStat.mtimeMs;
            } catch {
              /* identity check degrades gracefully when absent */
            }
            await getServiceIntegration()?.undoRedo?.recordAction?.(ACTION_TYPES.FILE_COPY, {
              originalPath: copyValidation.source,
              newPath: copyValidation.destination,
              copiedSize,
              copiedMtimeMs
            });
          } catch (undoErr) {
            log.debug('[FILE-OPS] Failed to record copy undo action', { error: undoErr?.message });
          }

          return {
            success: true,
            message: `Copied ${copyValidation.source} to ${copyValidation.destination}`,
            // Surface DB sync failure to the renderer so the user knows the
            // copied file may not appear in search results until they retry
            // analysis. Mirrors the move handler's `warning` field.
            ...(copyDbSyncWarning && { warning: copyDbSyncWarning })
          };
        }

        case 'delete': {
          const deleteValidation = await validateOperationPaths(
            operation.source,
            null,
            log,
            getServiceIntegration
          );
          if (!deleteValidation.valid) {
            return {
              success: false,
              error: deleteValidation.error,
              errorCode: 'INVALID_PATH'
            };
          }

          // PATH-TRACE: Log delete start
          traceDeleteStart(deleteValidation.source, 'fileOperationHandlers');

          // Snapshot before unlink so Undo has something to restore from.
          // On backup failure we still honor the user's delete but the
          // action is un-undoable — silent degradation is preferable to
          // refusing the user's requested operation.
          let deleteBackupPath = null;
          try {
            const undoRedoForBackup = getServiceIntegration()?.undoRedo;
            if (undoRedoForBackup?.createBackup) {
              deleteBackupPath = await undoRedoForBackup.createBackup(deleteValidation.source);
            }
          } catch (backupErr) {
            log.warn('[FILE-OPS] Delete backup failed — undo will not be available', {
              path: deleteValidation.source,
              error: backupErr?.message
            });
          }

          // CRASH-WINDOW ORDERING: record the FILE_DELETE action and force
          // its flush to disk (durable: true) BEFORE the unlink. recordAction
          // alone persists via a debounced save; a crash between the unlink
          // and that flush would leave the backup referenced by nothing, and
          // the next launch's orphan sweep (cleanupOldBackups) could destroy
          // the only remaining copy of the user's file. Recording first means
          // the worst crash outcome is a recorded delete whose original still
          // exists — undo of that action fails loudly instead of losing data.
          // If the unlink subsequently fails, the pre-recorded action is
          // retracted below so the undo stack never offers to "restore" a
          // file that was never deleted.
          let deleteActionId = null;
          if (deleteBackupPath) {
            try {
              deleteActionId = await getServiceIntegration()?.undoRedo?.recordAction?.(
                ACTION_TYPES.FILE_DELETE,
                {
                  originalPath: deleteValidation.source,
                  backupPath: deleteBackupPath,
                  createBackup: true
                },
                { durable: true }
              );
            } catch (undoErr) {
              log.debug('[FILE-OPS] Failed to record delete undo action', {
                error: undoErr?.message
              });
            }
          }

          try {
            await fs.unlink(deleteValidation.source);
          } catch (unlinkErr) {
            if (deleteActionId) {
              try {
                await getServiceIntegration()?.undoRedo?.removeAction?.(deleteActionId);
              } catch (removeErr) {
                log.warn('[FILE-OPS] Failed to retract delete undo action after unlink failure', {
                  actionId: deleteActionId,
                  error: removeErr?.message
                });
              }
            }
            throw unlinkErr;
          }

          // PATH-TRACE: Log delete complete (fs operation)
          traceDeleteComplete(deleteValidation.source, 'fileOperationHandlers', true);

          const dbDeleteWarning = await finalizeDeleteSideEffects({
            filePath: deleteValidation.source,
            log,
            getServiceIntegration,
            getMainWindow,
            searchReason: 'file-delete',
            context: 'perform-delete'
          });

          return {
            success: true,
            message: `Deleted ${deleteValidation.source}`,
            ...(dbDeleteWarning && { warning: dbDeleteWarning })
          };
        }

        case 'batch_move': {
          // Several user-chosen moves, one undo entry. Each move runs the
          // same path as `move` (validation, no-replace rename, side
          // effects); the undo record is a single MOVE_BATCH afterwards, so
          // Ctrl+Z reverses the whole selection and a large move no longer
          // pushes earlier history out of the 50-entry window.
          const requested = Array.isArray(operation.operations) ? operation.operations : [];
          if (requested.length === 0) {
            return {
              success: false,
              error: 'Batch move requires at least one operation',
              errorCode: 'INVALID_OPERATION'
            };
          }
          // One destination decision (and at most one dialog) per landing
          // folder for the whole selection.
          const batchMoveDecisions = await authorizeDestinations(requested, {
            getServiceIntegration,
            getMainWindow,
            log,
            abortSignal: event?.abortSignal || null
          });
          /** @type {Array<Record<string, any>>} */
          const moveResults = [];
          /** @type {Array<{ type: 'move', originalPath: string, newPath: string }>} */
          const movedOps = [];
          for (const op of requested) {
            if (event?.abortSignal?.aborted) {
              moveResults.push({
                success: false,
                source: op?.source,
                destination: op?.destination,
                error: 'Batch move cancelled',
                errorCode: 'ABORTED'
              });
              continue;
            }
            const single = await moveOneFile(op, {
              log,
              getServiceIntegration,
              getMainWindow,
              recordUndo: false,
              destinationDecision: decisionForDestination(
                batchMoveDecisions,
                op?.destination,
                process.platform,
                op?.source
              )
            });
            moveResults.push({ ...single, source: op?.source, destination: op?.destination });
            if (single.success && !single.skipped && single.movedTo) {
              movedOps.push({
                type: 'move',
                originalPath: single.movedFrom,
                newPath: single.movedTo
              });
            }
          }
          if (movedOps.length > 0) {
            try {
              await getServiceIntegration()?.undoRedo?.recordBatch?.(
                ACTION_TYPES.MOVE_BATCH,
                movedOps,
                { summary: { label: operation.label || 'Move files', source: 'manual_batch_move' } }
              );
            } catch (undoErr) {
              log.debug('[FILE-OPS] Failed to record batch move undo action', {
                error: undoErr?.message
              });
            }
          }
          const moved = movedOps.length;
          const skipped = moveResults.filter((r) => r.success && r.skipped).length;
          const failed = moveResults.filter((r) => !r.success).length;
          return {
            success: failed === 0,
            moved,
            skipped,
            failed,
            results: moveResults,
            message: `Moved ${moved} of ${requested.length} file(s)`
          };
        }

        case 'batch_organize':
          return await handleBatchOrganize(
            /** @type {any} */ ({
              operation,
              logger: log,
              getServiceIntegration,
              getMainWindow,
              // Propagate the renderer's AbortSignal so a preload timeout or
              // explicit user cancel (via ABORT_INVOKE) terminates the batch
              // loop cooperatively, not just the renderer's own promise.
              abortSignal: event?.abortSignal
            })
          );

        default:
          log.error(`[FILE-OPS] Unknown operation type: ${operation.type}`);
          return {
            success: false,
            error: `Unknown operation type: ${operation.type}`
          };
      }
    } catch (error) {
      log.error('[FILE-OPS] Error performing operation:', error);
      return { success: false, error: error.message };
    }
  };
}

const { IpcServiceContext, createFromLegacyParams } = require('../IpcServiceContext');

/**
 * Register file operation IPC handlers
 * @param {IpcServiceContext|Record<string, any>} servicesOrParams - Service context or legacy parameters
 */
function registerFileOperationHandlers(servicesOrParams) {
  let container;
  if (servicesOrParams instanceof IpcServiceContext) {
    container = servicesOrParams;
  } else {
    container = createFromLegacyParams(servicesOrParams);
  }

  const { ipcMain, IPC_CHANNELS, logger } = container.core;
  const { getMainWindow } = container.electron;
  const { getServiceIntegration } = container;

  const log = logger || require('../../../shared/logger').logger;
  const baseHandler = createPerformOperationHandler({
    logger: log,
    getServiceIntegration,
    getMainWindow
  });

  const performOperationHandler = createHandler({
    logger: log,
    context: 'FileOps',
    schema: operationSchema,
    handler: baseHandler
  });

  safeHandle(ipcMain, IPC_CHANNELS.FILES.PERFORM_OPERATION, performOperationHandler);

  // Delete file handler
  safeHandle(
    ipcMain,
    IPC_CHANNELS.FILES.DELETE_FILE,
    createHandler({
      logger: log,
      context: 'FileOps',
      schema: schemaDeleteFile,
      handler: async (event, filePath, options = {}) => {
        try {
          if (!filePath || typeof filePath !== 'string') {
            return {
              success: false,
              error: 'Invalid file path provided',
              errorCode: 'INVALID_PATH'
            };
          }
          const permanentConfirmed = options?.permanent === true;

          const strict = buildStrictFileOpsAllowlist(getServiceIntegration);
          const validation = await validateFileOperationPath(filePath, {
            checkSymlinks: true,
            ...(strict.enabled ? { allowedBasePaths: strict.allowlist } : {})
          });

          if (!validation.valid) {
            log.warn('[FILE-OPS] Delete path validation failed', {
              filePath,
              error: validation.error
            });
            return {
              success: false,
              error: validation.error,
              errorCode: 'INVALID_PATH'
            };
          }

          const validatedPath = validation.normalizedPath;

          // TOCTOU FIX: Get stats in try-catch, handle errors gracefully
          // Combine stat + unlink - if stat fails, we'll get the error
          // If file is deleted between stat and unlink, unlink will also fail with ENOENT
          let fileSize = 0;
          try {
            const stats = await fs.stat(validatedPath);
            fileSize = stats.size;
          } catch (statError) {
            if (statError.code === 'ENOENT') {
              return {
                success: false,
                error: 'File not found or inaccessible',
                errorCode: 'FILE_NOT_FOUND',
                details: statError.message
              };
            }
            // For other errors, try to proceed with delete anyway
            log.warn('[FILE-OPS] Could not stat file before delete', {
              error: statError.message
            });
          }

          // Prefer the OS trash over a hard unlink: this channel is reachable
          // straight from the Discover list and previously had no
          // backup/undo path at all — a misclick was unrecoverable. Trash
          // keeps the file restorable via the system Trash / Recycle Bin.
          // When trash fails, a hard unlink runs ONLY if the caller passed
          // `permanent: true`, which the renderer sends after a second
          // dialog that says "permanently". The dialog the user confirmed
          // first promised the Trash, so falling through on our own would
          // make it lie.
          let trashed = false;
          let trashWarning = null;
          try {
            const { TrashService } = require('../../services/TrashService');
            const trashService = new TrashService();
            const trashResult = await trashService.trashOne(validatedPath);
            if (trashResult.success) {
              trashed = true;
            } else if (trashResult.code === 'NOT_FOUND') {
              return {
                success: false,
                error: 'File not found or inaccessible',
                errorCode: 'FILE_NOT_FOUND',
                details: trashResult.error
              };
            } else {
              trashWarning = trashResult.error || 'Trash operation failed';
            }
          } catch (trashErr) {
            trashWarning = trashErr?.message || 'Trash operation failed';
          }

          if (!trashed && !permanentConfirmed) {
            log.warn('[FILE-OPS] Trash failed; permanent delete needs explicit confirmation', {
              path: validatedPath,
              error: trashWarning
            });
            return {
              success: false,
              error: `Could not move file to the system Trash (${trashWarning})`,
              errorCode: 'TRASH_UNAVAILABLE',
              trashError: trashWarning
            };
          }

          if (!trashed) {
            log.warn('[FILE-OPS] Trash failed; deleting permanently as confirmed', {
              path: validatedPath,
              error: trashWarning
            });
            await fs.unlink(validatedPath);
            trashWarning = `Could not move file to the system Trash (${trashWarning}); it was permanently deleted as confirmed`;
          }

          const dbDeleteWarning = await finalizeDeleteSideEffects({
            filePath: validatedPath,
            log,
            getServiceIntegration,
            getMainWindow,
            searchReason: 'file-delete',
            context: 'delete'
          });

          log.info(
            trashed ? '[FILE-OPS] Moved file to trash:' : '[FILE-OPS] Deleted file:',
            validatedPath,
            `(${fileSize} bytes)`
          );

          const responseWarning = [trashed ? null : trashWarning, dbDeleteWarning]
            .filter(Boolean)
            .join('; ');

          return {
            success: true,
            message: trashed ? 'File moved to system Trash' : 'File deleted permanently',
            trashed,
            deletedFile: {
              path: validatedPath,
              size: fileSize,
              deletedAt: new Date().toISOString()
            },
            ...(responseWarning && { warning: responseWarning })
          };
        } catch (error) {
          log.error('[FILE-OPS] Error deleting file:', error);

          let errorCode = 'DELETE_FAILED';
          let userMessage = 'Failed to delete file';

          if (isNotFoundError(error)) {
            errorCode = 'FILE_NOT_FOUND';
            userMessage = 'File not found';
          } else if (isPermissionError(error)) {
            errorCode = 'PERMISSION_DENIED';
            userMessage = 'Permission denied - file may be in use';
          } else if (getErrorCategory(error) === ErrorCategory.FILE_IN_USE) {
            errorCode = 'FILE_IN_USE';
            userMessage = 'File is currently in use';
          }

          return {
            success: false,
            error: userMessage,
            errorCode,
            details: error.message,
            systemError: error.code
          };
        }
      }
    })
  );

  // Copy file handler
  safeHandle(
    ipcMain,
    IPC_CHANNELS.FILES.COPY_FILE,
    createHandler({
      logger: log,
      context: 'FileOps',
      schema: schemaCopyPaths,
      handler: async (event, sourcePath, destinationPath) => {
        try {
          if (!sourcePath || !destinationPath) {
            return {
              success: false,
              error: 'Source and destination paths are required',
              errorCode: 'INVALID_PATHS'
            };
          }

          const validation = await validateOperationPaths(
            sourcePath,
            destinationPath,
            log,
            getServiceIntegration
          );

          if (!validation.valid) {
            return {
              success: false,
              error: validation.error,
              errorCode: 'INVALID_PATH'
            };
          }
          const destinationDecision = await authorizeDestination(validation.destination, {
            sourcePath: validation.source,
            getServiceIntegration,
            getMainWindow,
            log,
            abortSignal: event?.abortSignal || null,
            intent: { count: 1, name: path.basename(validation.destination) }
          });
          if (!destinationDecision.allowed) {
            return {
              success: false,
              error: destinationDecision.error,
              errorCode: destinationDecision.errorCode || 'DESTINATION_NOT_ALLOWED'
            };
          }

          const normalizedSource = validation.source;
          const normalizedDestination = validation.destination;

          // TOCTOU FIX: Don't pre-check with access(), let copyFile handle errors
          // Get stats for return value, but don't gate on it
          let fileSize = 0;
          try {
            const sourceStats = await fs.stat(normalizedSource);
            fileSize = sourceStats.size;
          } catch (statError) {
            if (statError.code === 'ENOENT') {
              return {
                success: false,
                error: 'Source file not found',
                errorCode: 'SOURCE_NOT_FOUND',
                details: statError.message
              };
            }
            // For other errors, try to proceed anyway
            log.warn('[FILE-OPS] Could not stat source file before copy', {
              error: statError.message
            });
          }

          const destDir = path.dirname(normalizedDestination);
          await fs.mkdir(destDir, { recursive: true });

          // PATH-TRACE: Log copy start
          traceCopyStart(normalizedSource, normalizedDestination, 'fileOperationHandlers');

          // TOCTOU guard: see preflightSourceForMutation jsdoc for rationale.
          await preflightSourceForMutation(normalizedSource, log, 'copy');

          // COPYFILE_EXCL: fail closed on an occupied destination. The EEXIST
          // this raises surfaces through the isExistsError → FILE_EXISTS
          // mapping in this handler's catch block below.
          await fs.copyFile(normalizedSource, normalizedDestination, fsConstants.COPYFILE_EXCL);

          // PATH-TRACE: Log copy complete (fs operation)
          traceCopyComplete(normalizedSource, normalizedDestination, 'fileOperationHandlers', true);

          log.info('[FILE-OPS] Copied file:', normalizedSource, 'to', normalizedDestination);

          // Use FilePathCoordinator for atomic copy handling across all systems
          const coordinator = getFilePathCoordinator();
          let copyDbSyncWarning = null;
          if (coordinator) {
            log.debug('[FILE-OPS] Using FilePathCoordinator for atomic copy handling');
            const copyResult = await coordinator.handleFileCopy(
              normalizedSource,
              normalizedDestination
            );
            if (!copyResult.success && copyResult.errors.length > 0) {
              copyDbSyncWarning = `Copy succeeded but database sync failed: ${copyResult.errors.map((/** @type {any} */ e) => e.system).join(', ')}`;
              log.warn('[FILE-OPS] Some systems failed during copy', {
                errors: copyResult.errors.map((/** @type {any} */ e) => e.system)
              });
            }
          } else {
            copyDbSyncWarning =
              'Copy succeeded but FilePathCoordinator unavailable; analysis history / embeddings not cloned';
            log.warn(
              '[FILE-OPS] FilePathCoordinator unavailable, copy operations skipped for database/history'
            );
          }

          // Invalidate and rebuild search index to include the copy
          try {
            const { getSearchServiceInstance } = require('../semantic');
            const searchService = getSearchServiceInstance?.();
            if (searchService) {
              searchService
                .invalidateAndRebuild({
                  immediate: false,
                  reason: 'file-copy',
                  newPath: normalizedDestination
                })
                .catch((/** @type {any} */ rebuildErr) => {
                  log.warn('[FILE-OPS] Background BM25 rebuild failed after copy', {
                    error: rebuildErr.message
                  });
                });
            }
          } catch (invalidateErr) {
            log.warn('[FILE-OPS] Failed to trigger search index rebuild after copy', {
              error: invalidateErr.message
            });
          }

          invalidateClustersIfAvailable(log);

          // Ensure embeddings reflect the final smart folder destination (best effort)
          // Required to update metadata (smartFolder field)
          await syncEmbeddingsBestEffort({
            sourcePath: normalizedSource,
            destPath: normalizedDestination,
            log,
            context: 'copy'
          });

          return {
            success: true,
            message: 'File copied successfully',
            operation: {
              source: normalizedSource,
              destination: normalizedDestination,
              size: fileSize,
              copiedAt: new Date().toISOString()
            },
            // Surface DB sync failure: copied file may not appear in search.
            ...(copyDbSyncWarning && { warning: copyDbSyncWarning })
          };
        } catch (error) {
          log.error('[FILE-OPS] Error copying file:', error);

          let errorCode = 'COPY_FAILED';
          let userMessage = 'Failed to copy file';

          if (getErrorCategory(error) === ErrorCategory.DISK_FULL) {
            errorCode = 'INSUFFICIENT_SPACE';
            userMessage = 'Insufficient disk space';
          } else if (isPermissionError(error)) {
            errorCode = 'PERMISSION_DENIED';
            userMessage = 'Permission denied';
          } else if (isExistsError(error)) {
            errorCode = 'FILE_EXISTS';
            userMessage = 'Destination file already exists';
          } else if (isNotFoundError(error)) {
            errorCode = 'SOURCE_NOT_FOUND';
            userMessage = 'Source file not found';
          }

          return {
            success: false,
            error: userMessage,
            errorCode,
            details: error.message
          };
        }
      }
    })
  );

  // Cleanup analysis/index data for a file without deleting it
  safeHandle(
    ipcMain,
    IPC_CHANNELS.FILES.CLEANUP_ANALYSIS,
    createHandler({
      logger: log,
      context: 'FileOps',
      schema: schemaFilePath,
      handler: async (event, filePath) => {
        try {
          if (!filePath || typeof filePath !== 'string') {
            return {
              success: false,
              error: 'Invalid file path provided',
              errorCode: 'INVALID_PATH'
            };
          }

          const strict = buildStrictFileOpsAllowlist(getServiceIntegration);
          const validation = await validateFileOperationPath(filePath, {
            checkSymlinks: false,
            ...(strict.enabled ? { allowedBasePaths: strict.allowlist } : {})
          });

          if (!validation.valid) {
            log.warn('[FILE-OPS] Cleanup path validation failed', {
              filePath,
              error: validation.error
            });
            return {
              success: false,
              error: validation.error,
              errorCode: 'INVALID_PATH'
            };
          }

          const validatedPath = validation.normalizedPath;

          // If analysis history shows the file already moved, update paths instead of deleting.
          const historyService = getAnalysisHistoryService();
          if (historyService?.getAnalysisByPath) {
            try {
              const entry = await historyService.getAnalysisByPath(validatedPath);
              const actualPath = entry?.organization?.actual;
              if (actualPath && typeof actualPath === 'string') {
                let actualExists = false;
                try {
                  await fs.access(actualPath);
                  actualExists = true;
                } catch {
                  actualExists = false;
                }

                if (actualExists) {
                  const coordinator = getFilePathCoordinator();
                  if (actualPath !== validatedPath && coordinator) {
                    const updateResult = await coordinator.atomicPathUpdate(
                      validatedPath,
                      actualPath,
                      {
                        type: 'move',
                        skipProcessingState: true
                      }
                    );

                    // Invalidate search indexes after alignment (best effort)
                    try {
                      // Cast: keeps tsc from registering this block-scoped
                      // require as a module-level import alias, which would
                      // collide (TS2300) with the sibling require below.
                      const { getSearchServiceInstance } = /** @type {any} */ (
                        require('../semantic')
                      );
                      const searchService = getSearchServiceInstance?.();
                      if (searchService) {
                        searchService
                          .invalidateAndRebuild({
                            immediate: false,
                            reason: 'analysis-alignment',
                            oldPath: validatedPath,
                            newPath: actualPath
                          })
                          .catch((/** @type {any} */ rebuildErr) => {
                            log.warn('[FILE-OPS] Background BM25 rebuild failed', {
                              error: rebuildErr.message
                            });
                          });
                      }
                    } catch (invalidateErr) {
                      log.warn('[FILE-OPS] Failed to trigger search index rebuild', {
                        error: invalidateErr.message
                      });
                    }

                    invalidateClustersIfAvailable(log);

                    // Notify renderer about move alignment (best effort)
                    try {
                      const mainWindow = getMainWindow();
                      if (mainWindow && !mainWindow.isDestroyed()) {
                        safeSend(mainWindow.webContents, IPC_EVENTS.FILE_OPERATION_COMPLETE, {
                          operation: 'move',
                          oldPath: validatedPath,
                          newPath: actualPath
                        });
                      }
                    } catch (notifyErr) {
                      log.warn('[FILE-OPS] Failed to notify renderer of move alignment', {
                        error: notifyErr.message
                      });
                    }

                    return {
                      success: updateResult.success,
                      updated: updateResult.updated,
                      errors: updateResult.errors,
                      ...(updateResult.errors?.length && {
                        warning: `Some systems failed to update: ${updateResult.errors
                          .map((/** @type {any} */ e) => e.system)
                          .join(', ')}`
                      })
                    };
                  }

                  // Already aligned to actual path; skip cleanup to avoid orphaning organized files.
                  return {
                    success: true,
                    skipped: true,
                    reason: 'already-organized'
                  };
                }
              }
            } catch (historyErr) {
              log.debug('[FILE-OPS] Analysis history check failed during cleanup', {
                error: historyErr.message
              });
            }
          }

          let cleanupResult = null;
          let cleanupWarning = null;

          const coordinator = getFilePathCoordinator();
          if (coordinator) {
            try {
              cleanupResult = await coordinator.handleFileDeletion(validatedPath);
              if (!cleanupResult.success && cleanupResult.errors?.length) {
                cleanupWarning = `Some systems failed to cleanup: ${cleanupResult.errors
                  .map((/** @type {any} */ e) => e.system)
                  .join(', ')}`;
              }
            } catch (coordError) {
              cleanupWarning = `Cleanup failed: ${coordError.message}`;
              log.warn('[FILE-OPS] FilePathCoordinator cleanup failed', {
                error: coordError.message
              });
            }
          } else {
            cleanupWarning = 'Coordinator unavailable for cleanup';
            log.warn('[FILE-OPS] FilePathCoordinator unavailable for cleanup');
          }

          // Invalidate search index after cleanup
          try {
            // Cast: see TS2300 note on the sibling require above.
            const { getSearchServiceInstance } = /** @type {any} */ (require('../semantic'));
            const searchService = getSearchServiceInstance?.();
            if (searchService) {
              searchService
                .invalidateAndRebuild({
                  immediate: false,
                  reason: 'analysis-remove',
                  oldPath: validatedPath
                })
                .catch((/** @type {any} */ rebuildErr) => {
                  log.warn('[FILE-OPS] Background BM25 rebuild failed', {
                    error: rebuildErr.message
                  });
                });
            }
          } catch (invalidateErr) {
            log.warn('[FILE-OPS] Failed to trigger search index rebuild', {
              error: invalidateErr.message
            });
          }

          invalidateClustersIfAvailable(log);

          return {
            success: !cleanupWarning,
            ...(cleanupResult?.cleaned && { cleaned: cleanupResult.cleaned }),
            ...(cleanupResult?.errors && { errors: cleanupResult.errors }),
            ...(cleanupWarning && { warning: cleanupWarning })
          };
        } catch (error) {
          log.error('[FILE-OPS] Cleanup analysis error:', error);
          return { success: false, error: error.message };
        }
      }
    })
  );
}

module.exports = { registerFileOperationHandlers };
