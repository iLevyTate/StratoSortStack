// @ts-check
const path = require('path');
const fs = require('fs').promises;
const { atomicFileOps } = require('../../shared/atomicFileOperations');
const { IPC_EVENTS } = require('../../shared/constants');
const { safeSend } = require('../ipc/ipcWrappers');
const { computeFileChecksum, handleDuplicateMove } = require('../utils/fileDedup');
const { removeEmbeddingsForPathBestEffort } = require('../ipc/files/embeddingSync');
const { validateFileOperationPath } = require('../../shared/pathSanitization');
const { acquireBatchLock, releaseBatchLock } = require('../ipc/files/batchLockManager');
const { deferGhostCleanup, resumeGhostCleanup } = require('../../shared/ghostCleanupGuard');
const { migrateLegacyPersistedBatch } = require('./ProcessingStateService');

/**
 * Resume runs replay operations from a persisted journal, so the source and
 * destination strings arrived via disk — anything on disk between sessions must
 * be treated as untrusted. A tampered or corrupt batch file could otherwise be
 * replayed straight into a dangerous system path (rm of /etc, overwrite of
 * Windows\\System32, etc.). Re-validate at the moment of use with the same
 * rules the live IPC path applies.
 *
 * @param {string} candidate
 * @param {string} role 'source' or 'destination' — for logging context.
 * @param {any} logger
 * @returns {Promise<string>} The validated, normalized path.
 * @throws {Error} When the path is unsafe; caller treats this as an op failure.
 */
async function validateResumeOperationPath(candidate, role, logger) {
  const validation = await validateFileOperationPath(candidate, {
    requireAbsolute: true,
    disallowUrlSchemes: true,
    allowFileUrl: false
  });
  if (!validation.valid) {
    logger?.warn?.('[RESUME] Rejecting op with unsafe path', {
      role,
      path: candidate,
      error: validation.error
    });
    throw new Error(`Unsafe ${role} path for resume: ${validation.error}`);
  }
  return validation.normalizedPath;
}

async function pathExists(
  /** @type {any} */ filePath,
  /** @type {any} */ logger,
  /** @type {any} */ label
) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    logger?.warn?.('[RESUME] Unexpected fs.access error:', {
      error: error.message,
      code: error.code,
      path: filePath,
      label
    });
    throw error;
  }
}

/**
 * Replay the live handler's post-batch persistence for the ops it never
 * covered.
 *
 * Persistence is journaled per op (`persistedOpIndices`): a batch can reach
 * this point with some ops already persisted by the live handler (partial
 * run interrupted by a non-user abort, pause → resume → crash) and others
 * — completed before the crash or replayed just now — still lacking their
 * undo entry and FilePathCoordinator path updates. Only the uncovered
 * subset is persisted, under an undo batch id derived from that subset so a
 * retry after a crash mid-persistence hits recordUndoAndUpdateDatabase's
 * hasBatchAction guard instead of doubling the user's undo step. The subset
 * is stamped persisted only when both the undo entry and the path index
 * landed; anything less stays uncovered for the next launch. Best-effort: a
 * persistence failure must not block batch completion, matching the live
 * handler's non-fatal treatment.
 */
async function runPostBatchPersistence(
  /** @type {any} */ batch,
  /** @type {any} */ serviceIntegration,
  /** @type {any} */ logger
) {
  const persisted = new Set(
    Array.isArray(batch.persistedOpIndices) ? batch.persistedOpIndices : []
  );
  const completedOps = (batch.operations || [])
    .map((/** @type {any} */ op, /** @type {any} */ index) => ({ op, index }))
    .filter(
      (/** @type {{ op: any, index: number }} */ { op, index }) =>
        !persisted.has(index) &&
        op?.status === 'done' &&
        op?.skipped !== true &&
        typeof op.source === 'string' &&
        typeof op.destination === 'string'
    )
    .map((/** @type {{ op: any, index: number }} */ { op, index }) => ({
      index,
      source: op.source,
      destination: op.destination
    }));
  if (completedOps.length === 0) return;

  const opIndices = completedOps.map((/** @type {{ index: number }} */ c) => c.index);
  const undoBatchId = `${batch.id}:p${opIndices[0]}`;
  try {
    // Lazy require to keep service construction free of the IPC layer.
    const { recordUndoAndUpdateDatabase } = require('../ipc/files/batchOrganizeHandler');
    const meta = await recordUndoAndUpdateDatabase(
      batch,
      [],
      completedOps.length,
      undoBatchId,
      () => serviceIntegration,
      logger,
      null,
      completedOps
    );
    if (!meta?.undoRecorded || !meta?.pathIndexUpdated) {
      logger?.warn?.('[RESUME] Post-batch persistence incomplete; will retry at next launch', {
        batchId: batch.id,
        operations: completedOps.length,
        undoRecorded: Boolean(meta?.undoRecorded),
        pathIndexUpdated: Boolean(meta?.pathIndexUpdated)
      });
      return;
    }
    await serviceIntegration.processingState.markOrganizeOpsPersisted?.(batch.id, opIndices);
    logger?.info?.('[RESUME] Post-batch persistence complete', {
      batchId: batch.id,
      operations: completedOps.length
    });
  } catch (persistErr) {
    logger?.warn?.('[RESUME] Post-batch persistence failed (non-fatal)', {
      batchId: batch.id,
      error: persistErr?.message || String(persistErr)
    });
  }
}

/**
 * Resume incomplete organize batches from a previous session.
 * Coordinates with ProcessingStateService to safely continue operations.
 *
 * Dependencies are injected for testability and modularity.
 */
async function resumeIncompleteBatches(
  /** @type {any} */ serviceIntegration,
  /** @type {any} */ logger,
  /** @type {any} */ getMainWindow
) {
  try {
    if (!serviceIntegration?.processingState) {
      // A silent skip here would strand interrupted batches for the whole
      // session — make the mis-wiring loud so it can't regress unnoticed.
      logger.warn('[RESUME] processingState unavailable — skipping resume of organize batches');
      return;
    }
    const incomplete = serviceIntegration.processingState.getIncompleteOrganizeBatches?.() || [];
    if (!incomplete.length) return;
    logger.warn(`[RESUME] Resuming ${incomplete.length} incomplete organize batch(es)`);

    for (const batch of incomplete) {
      // A rolled-back batch is normally closed by the rollback path itself
      // and filtered out by getIncompleteOrganizeBatches; seeing one here
      // means the journal was written by an older build (or a crash landed
      // between the rolledBackAt and completedAt stamps). The rollback
      // already moved the completed ops' files BACK to their sources, so
      // neither replay nor post-batch persistence may run — 'done' ops would
      // record undo/path-index entries for moves that no longer exist, and
      // pending/failed ops would silently re-move files the user was told
      // were restored. Just close the journal entry.
      if (batch.rolledBackAt) {
        logger?.info?.('[RESUME] Skipping rolled-back batch', { batchId: batch.id });
        try {
          await serviceIntegration.processingState.completeOrganizeBatch(batch.id);
        } catch {
          // ignore inner error
        }
        continue;
      }

      // Journals from before per-op persistence tracking must be classified
      // BEFORE replay: the rule is "every op done at load time was covered by
      // the batch-wide stamp", and replay turns pending ops into done ops.
      migrateLegacyPersistedBatch(batch);

      // Same exclusion the live handler holds: a user organize started while
      // this replay runs would otherwise race it (two unserialized
      // renameNoReplace probes on one destination), and the search ghost
      // sweep could drop embeddings for sources already renamed but not yet
      // remapped by post-batch persistence. A held lock means a live batch is
      // in flight — leave this journal entry for the next launch.
      const locked = await acquireBatchLock(batch.id);
      if (!locked) {
        logger.warn('[RESUME] Could not acquire batch lock; deferring batch to next launch', {
          batchId: batch.id
        });
        continue;
      }
      deferGhostCleanup();
      try {
        await resumeBatch(batch, serviceIntegration, logger, getMainWindow);
      } finally {
        releaseBatchLock(batch.id);
        resumeGhostCleanup();
      }
    }
  } catch (e) {
    logger?.warn?.('[RESUME] Resume batches failed:', e.message);
  }
}

/**
 * Replay one incomplete batch: skip done ops, re-run pending/failed ones,
 * then persist and close the journal entry. Caller holds the batch lock.
 */
async function resumeBatch(
  /** @type {any} */ batch,
  /** @type {any} */ serviceIntegration,
  /** @type {any} */ logger,
  /** @type {any} */ getMainWindow
) {
  // A USER-paused batch must never auto-replay at launch — files silently
  // moving on startup would be surprising, and the user explicitly
  // stopped this work. Finalize instead: persistence for the moves that
  // DID happen (per-op persistence tracking makes this a no-op for ops
  // the pause handler already covered), then close the journal entry.
  if (batch.pausedAt) {
    logger?.info?.('[RESUME] Finalizing paused batch without replaying pending ops', {
      batchId: batch.id
    });
    await runPostBatchPersistence(batch, serviceIntegration, logger);
    try {
      await serviceIntegration.processingState.completeOrganizeBatch(batch.id);
    } catch {
      // ignore inner error
    }
    return;
  }

  const total = batch.operations.length;
  for (let i = 0; i < total; i += 1) {
    const op = batch.operations[i];
    if (op.status === 'done') {
      const win = getMainWindow?.();
      if (win && !win.isDestroyed()) {
        safeSend(win.webContents, IPC_EVENTS.OPERATION_PROGRESS, {
          type: 'batch_organize',
          current: i + 1,
          total,
          currentFile: path.basename(op.source)
        });
      }
      continue;
    }
    try {
      // Revalidate BEFORE markOrganizeOpStarted (which itself writes to
      // the journal — an fs side effect against a poisoned entry). The
      // persisted journal is the only source for these paths, so a
      // corrupt/tampered state file is the exact attack surface this
      // covers. We check for validity but do not rewrite op.source /
      // op.destination — downstream code has always treated those as
      // the caller-supplied strings, and changing the shape would
      // ripple into progress events and dedup results.
      await validateResumeOperationPath(op.source, 'source', logger);
      await validateResumeOperationPath(op.destination, 'destination', logger);

      await serviceIntegration.processingState.markOrganizeOpStarted(batch.id, i);

      const sourceExists = await pathExists(op.source, logger, 'source');
      const destinationExists = await pathExists(op.destination, logger, 'destination');

      if (!sourceExists) {
        if (destinationExists) {
          const expectedSize = op.sourceSize ?? op.size;
          const expectedMtime = op.sourceMtime ?? op.mtimeMs ?? op.mtime;
          const hasSize = typeof expectedSize === 'number';
          const parsedMtime =
            typeof expectedMtime === 'number'
              ? expectedMtime
              : typeof expectedMtime === 'string'
                ? Date.parse(expectedMtime)
                : NaN;
          const hasMtime = Number.isFinite(parsedMtime);

          if (hasSize && hasMtime) {
            let destMatches = false;
            try {
              const destStat = await fs.stat(op.destination);
              destMatches =
                destStat.isFile() &&
                destStat.size === expectedSize &&
                Math.abs(destStat.mtimeMs - parsedMtime) < 2000;
            } catch {
              destMatches = false;
            }
            if (!destMatches) {
              throw new Error(
                'Source missing and destination occupant does not match the recorded file'
              );
            }
          } else {
            // Journals written before markOrganizeOpStarted persisted the
            // source's size+mtime carry nothing to verify against. The
            // pre-verification contract treated source-gone + destination-
            // present as a completed move; keep that so the file stays in
            // undo/path updates instead of being stranded as an error.
            logger?.warn?.(
              '[RESUME] Legacy journal entry lacks source metadata; assuming destination is the moved file',
              { batchId: batch.id, index: i, destination: op.destination }
            );
          }
          await serviceIntegration.processingState.markOrganizeOpDone(batch.id, i, {
            destination: op.destination
          });

          const win = getMainWindow?.();
          if (win && !win.isDestroyed()) {
            safeSend(win.webContents, IPC_EVENTS.OPERATION_PROGRESS, {
              type: 'batch_organize',
              current: i + 1,
              total,
              currentFile: path.basename(op.source)
            });
          }
          continue;
        }

        throw new Error('Source file missing; destination not found');
      }

      // Track the final destination in a local so we don't mutate the
      // persisted `op.destination` before we've actually committed a
      // move. Previously we rewrote `op.destination` in memory on
      // dedup/collision and only persisted in `markOrganizeOpDone`
      // after the rename; a crash between mutation and rename left
      // the on-disk state stale, so the next resume would race with
      // a half-applied new destination it had never persisted.
      let finalDestination = op.destination;

      // Ensure destination directory exists
      const destDir = path.dirname(finalDestination);
      await fs.mkdir(destDir, { recursive: true });

      const duplicateResult = await handleDuplicateMove({
        sourcePath: op.source,
        destinationPath: finalDestination,
        checksumFn: computeFileChecksum,
        logger,
        logPrefix: '[RESUME]',
        dedupContext: 'organizeResume',
        removeEmbeddings: removeEmbeddingsForPathBestEffort
      });
      if (duplicateResult) {
        finalDestination = duplicateResult.destination;
        // Only now do we mutate op.destination — and we immediately
        // persist via markOrganizeOpDone below, so the in-memory
        // view and the on-disk journal stay in lockstep.
        op.destination = finalDestination;
        await serviceIntegration.processingState.markOrganizeOpDone(batch.id, i, {
          destination: finalDestination,
          skipped: true
        });

        const win = getMainWindow?.();
        if (win && !win.isDestroyed()) {
          safeSend(win.webContents, IPC_EVENTS.OPERATION_PROGRESS, {
            type: 'batch_organize',
            current: i + 1,
            total,
            currentFile: path.basename(op.source)
          });
        }
        continue;
      }

      // Check destination collision and adjust. Resolve against the
      // local `finalDestination` first so we don't leave a
      // half-updated `op.destination` visible to observers.
      if (destinationExists) {
        let counter = 1;
        let uniqueDestination;
        const ext = path.extname(finalDestination);
        const baseName =
          ext && ext.length > 0 ? finalDestination.slice(0, -ext.length) : finalDestination;
        while (counter <= 1000) {
          const base = baseName || finalDestination;
          uniqueDestination = `${base}_${counter}${ext}`;
          try {
            await fs.access(uniqueDestination);
            counter += 1;
          } catch (accessErr) {
            if (accessErr?.code && accessErr.code !== 'ENOENT') {
              logger.warn('[RESUME] Unexpected fs.access error:', {
                error: accessErr.message,
                code: accessErr.code
              });
            }
            break;
          }
        }
        if (counter > 1000) throw new Error('Too many name collisions');
        if (uniqueDestination !== finalDestination) {
          finalDestination = uniqueDestination;
        }
      }

      // Route the move through the shared guarded mover rather than a bare
      // fs.rename. fs.rename silently overwrites an existing destination on
      // POSIX, so a file that appears at finalDestination in the TOCTOU
      // window between the collision check above and this move — or one that
      // is present when the collision loop was skipped because the
      // destination was absent at check time — would be clobbered with no
      // backup and no undo entry. atomicMove re-checks existence
      // immediately before the rename, resolves a fresh unique name on
      // EEXIST, and handles EXDEV (cross-device) moves internally. Adopt the
      // path it actually committed to so the journal stays in lockstep.
      finalDestination = await atomicFileOps.atomicMove(op.source, finalDestination);

      // Commit: move succeeded; now sync in-memory op + persisted
      // state to the same final destination atomically (within
      // markOrganizeOpDone's saveState).
      op.destination = finalDestination;
      await serviceIntegration.processingState.markOrganizeOpDone(batch.id, i, {
        destination: finalDestination
      });

      const win = getMainWindow?.();
      if (win && !win.isDestroyed()) {
        safeSend(win.webContents, IPC_EVENTS.OPERATION_PROGRESS, {
          type: 'batch_organize',
          current: i + 1,
          total,
          currentFile: path.basename(op.source)
        });
      }
    } catch (err) {
      logger?.warn?.('[RESUME] Failed to resume op', i + 1, 'in batch', batch.id, ':', err.message);
      try {
        await serviceIntegration.processingState.markOrganizeOpError(batch.id, i, err.message);
      } catch {
        // ignore inner error
      }
    }
  }
  // Run the same post-batch persistence (undo action + FilePathCoordinator
  // path updates) that the live batch handler runs. Without this, moves
  // completed before a crash (or replayed above) finish on disk but undo,
  // vector DB, and analysis history keep pointing at the old paths.
  // persistedOpIndices keeps ops the live handler already covered from
  // being recorded twice.
  await runPostBatchPersistence(batch, serviceIntegration, logger);

  try {
    await serviceIntegration.processingState.completeOrganizeBatch(batch.id);
  } catch {
    // ignore inner error
  }
  logger?.info?.('[RESUME] Completed batch resume:', batch.id);
}

module.exports = {
  resumeIncompleteBatches
};
