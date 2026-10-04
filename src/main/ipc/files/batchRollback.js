// @ts-check
/**
 * Batch Rollback
 *
 * Handles rollback of completed batch operations.
 */

const path = require('path');
const crypto = require('crypto');
const fs = require('fs').promises;
const fsConstants = require('fs').constants;
const { app } = require('electron');
const { crossDeviceMove, renameNoReplace } = require('../../../shared/atomicFileOperations');
const { renewBatchLock } = require('./batchLockManager');

/**
 * Write file atomically via write-to-temp-then-rename.
 * @param {string} filePath
 * @param {string} data
 */
async function writeFileAtomic(filePath, data) {
  const tmpPath = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmpPath, data);
  await fs.rename(tmpPath, filePath);
}

/**
 * Execute rollback of completed operations
 * @param {Array<{ source: string, destination: string, rollbackAction?: string }>} completedOperations
 * @param {any[]} results
 * @param {number} failCount
 * @param {string} rollbackReason
 * @param {string} batchId
 * @param {import('../ipcWrappers').LoggerLike} log
 * @param {{ markOrganizeBatchRolledBack?: (batchId: string) => Promise<any>, completeOrganizeBatch?: (batchId: string) => Promise<any> } | null} [processingState]
 */
async function executeRollback(
  completedOperations,
  results,
  failCount,
  rollbackReason,
  batchId,
  log,
  processingState = null
) {
  log.warn(`[FILE-OPS] Executing rollback for batch ${batchId}`, {
    batchId,
    completedCount: completedOperations.length,
    failCount,
    reason: rollbackReason
  });

  // Persist recovery manifest before starting rollback
  /** @type {string|null} */
  let recoveryPath = null;
  /** @type {{ batchId: string, timestamp: string, reason: string, status: string, operations: any[], results: any[] } | null} */
  let recoveryManifest = null;
  try {
    const userDataPath = app.getPath('userData');
    const recoveryDir = path.join(userDataPath, 'recovery');
    await fs.mkdir(recoveryDir, { recursive: true });

    recoveryPath = path.join(recoveryDir, `rollback_${batchId}.json`);
    recoveryManifest = {
      batchId,
      timestamp: new Date().toISOString(),
      reason: rollbackReason,
      status: 'pending',
      operations: completedOperations,
      results: []
    };

    await writeFileAtomic(recoveryPath, JSON.stringify(recoveryManifest, null, 2));
    log.info(`[FILE-OPS] Recovery manifest saved to ${recoveryPath}`);
  } catch (err) {
    log.error(`[FILE-OPS] Failed to save recovery manifest: ${err.message}`);
  }

  const rollbackResults = [];
  let rollbackSuccessCount = 0;
  let rollbackFailCount = 0;

  for (const completedOp of [...completedOperations].reverse()) {
    try {
      // Ensure source directory exists (may have been removed after move)
      await fs.mkdir(path.dirname(completedOp.source), { recursive: true });
      // Occupancy guard: fs.rename/copyFile silently replace an occupied
      // destination, so a blind restore could destroy a file placed at the
      // original source path after the forward move. Fail the individual
      // rollback op instead (the moved file stays safe at its destination
      // and the failure is recorded in the manifest + rollbackResults).
      if (completedOp.rollbackAction === 'restore_duplicate_source') {
        await fs.copyFile(completedOp.destination, completedOp.source, fsConstants.COPYFILE_EXCL);
      } else {
        try {
          await renameNoReplace(completedOp.destination, completedOp.source);
        } catch (renameError) {
          if (renameError.code === 'EXDEV') {
            const sourceDir = path.dirname(completedOp.source);
            await fs.mkdir(sourceDir, { recursive: true });
            await crossDeviceMove(completedOp.destination, completedOp.source, {
              verify: true
            });
          } else {
            throw renameError;
          }
        }
      }
      rollbackSuccessCount++;
      rollbackResults.push({ success: true, file: completedOp.source });
    } catch (rollbackError) {
      rollbackFailCount++;
      rollbackResults.push({
        success: false,
        file: completedOp.source,
        error: rollbackError.message
      });
    }
    // Rollback typically runs after the batch already exhausted its time
    // budget; keep the lease alive so no second batch overlaps the restore.
    renewBatchLock(batchId);
  }

  // Update recovery manifest status
  if (recoveryPath) {
    try {
      if (rollbackFailCount === 0) {
        await fs.unlink(recoveryPath);
        log.info('[FILE-OPS] Rollback successful, recovery manifest deleted');
      } else {
        // Use in-memory manifest (already in scope) instead of re-reading from disk,
        // which would throw if the prior write at L57 failed.
        recoveryManifest.status = 'partial_failure';
        recoveryManifest.results = rollbackResults;
        await writeFileAtomic(recoveryPath, JSON.stringify(recoveryManifest, null, 2));
        log.warn(`[FILE-OPS] Rollback had failures, manifest updated at ${recoveryPath}`);
      }
    } catch (err) {
      log.warn(`[FILE-OPS] Failed to update recovery manifest: ${err.message}`);
    }
  }

  // Close the journal batch regardless of rollback outcome. Completed ops'
  // files were moved BACK to their sources, so if the batch stayed
  // "incomplete" (no completedAt) the next launch's resume pass would replay
  // it: 'done' ops would get undo entries/path-index updates for moves that
  // no longer exist, and pending/failed ops would silently re-move files the
  // user was told were rolled back. rolledBackAt is stamped before
  // completedAt so a crash between the two writes still leaves a marker
  // that getIncompleteOrganizeBatches / OrganizeResumeService skip.
  try {
    await processingState?.markOrganizeBatchRolledBack?.(batchId);
    await processingState?.completeOrganizeBatch?.(batchId);
  } catch (stateError) {
    log.warn(`[FILE-OPS] Failed to close journal batch after rollback: ${stateError.message}`);
  }

  log.warn('[FILE-OPS] Rollback summary', {
    batchId,
    rollbackSuccessCount,
    rollbackFailCount,
    completed: completedOperations.length
  });

  return {
    success: false,
    rolledBack: true,
    rollbackReason,
    results,
    rollbackResults,
    successCount: 0,
    failCount,
    rollbackSuccessCount,
    rollbackFailCount,
    summary: `Batch rolled back. ${rollbackSuccessCount}/${completedOperations.length} operations restored.`,
    batchId,
    recoveryPath,
    criticalError: true
  };
}

module.exports = {
  executeRollback
};
