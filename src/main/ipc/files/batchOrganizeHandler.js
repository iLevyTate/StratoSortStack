// @ts-check
/**
 * Batch Organize Handler
 *
 * Extracted from files.js for better maintainability.
 * Handles batch file organization with rollback support.
 *
 * @module ipc/files/batchOrganizeHandler
 */

const path = require('path');
const crypto = require('crypto');
const fs = require('fs').promises;
const { ACTION_TYPES, PROCESSING_LIMITS } = require('../../../shared/constants');
const { LIMITS, TIMEOUTS, BATCH, RETRY } = require('../../../shared/performanceConstants');
const { logger: baseLogger, createLogger } = require('../../../shared/logger');
const { crossDeviceMove, renameNoReplace } = require('../../../shared/atomicFileOperations');
const { validateFileOperationPath } = require('../../../shared/pathSanitization');
const { getEffectiveMaxPathLength } = require('../../../shared/securityConfig');
const { withTimeout, delay } = require('../../../shared/promiseUtils');
const { withCorrelationId } = require('../../../shared/correlationId');
const { ERROR_CODES } = require('../../../shared/errorHandlingUtils');
const { deferGhostCleanup, resumeGhostCleanup } = require('../../../shared/ghostCleanupGuard');
const { isCaseInsensitiveFileSystem } = require('../../../shared/crossPlatformUtils');
const systemAnalytics = require('../../core/systemAnalytics');
const { acquireBatchLock, renewBatchLock, releaseBatchLock } = require('./batchLockManager');
const { validateBatchOperation, MAX_BATCH_SIZE } = require('./batchValidator');
const { executeRollback } = require('./batchRollback');
const {
  sendOperationProgress,
  sendChunkedResults,
  sendFileOperationBatchComplete
} = require('./batchProgressReporter');
const { getInstance: getFileOperationTracker } = require('../../../shared/fileOperationTracker');
const { removeEmbeddingsForPathBestEffort } = require('./embeddingSync');
const {
  computeFileChecksum,
  handleDuplicateMove,
  findSemanticDuplicates
} = require('../../utils/fileDedup');
const { getSemanticFileId } = require('../../../shared/fileIdUtils');
const {
  authorizeDestination,
  authorizeDestinations,
  decisionForDestination,
  buildStrictFileOpsAllowlist
} = require('./destinationPolicy');

/** @typedef {import('../ipcWrappers').LoggerLike} LoggerLike */
/** @typedef {import('./batchProgressReporter').GetMainWindowFn} GetMainWindowFn */

/**
 * Single move operation within a batch. `status` comes from the
 * processing-state journal on resume; underscore-prefixed fields are
 * attached in-flight by the handler.
 * @typedef {Object} BatchOp
 * @property {string} source
 * @property {string} destination
 * @property {string} [type]
 * @property {string} [status]
 * @property {string} [_originalDestination]
 * @property {{ similarFile: string, similarity: number }} [_semanticDuplicate]
 * @property {{ folder: string, path?: string, source?: string }} [suggestion] - What the
 *   app suggested before the user confirmed; a different landing folder is a correction
 */

/**
 * Batch-organize invoke payload (post-Zod `fileOperationSchema` shape).
 * @typedef {Object} BatchOrganizeOperation
 * @property {BatchOp[]} operations
 * @property {boolean} [dryRun]
 * @property {boolean} [strict]
 * @property {string} [resumeBatchId]
 */

const logger =
  typeof createLogger === 'function' ? createLogger('IPC:Files:BatchOrganize') : baseLogger;
if (typeof createLogger !== 'function' && logger?.setContext) {
  logger.setContext('IPC:Files:BatchOrganize');
}

// Resource limits from centralized constants (prevents config drift).
// MAX_TOTAL_BATCH_TIME is no longer a limit on a running batch (a batch that
// is still moving files is never cut off for taking long); it is only
// re-exported, and sizes the batch lock's lease in batchLockManager.
const MAX_TOTAL_BATCH_TIME = PROCESSING_LIMITS.MAX_TOTAL_BATCH_TIME;
const { MAX_NUMERIC_RETRIES } = LIMITS;
const FILE_LOCK_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const MOVE_LOCK_MAX_ATTEMPTS = RETRY?.MAX_ATTEMPTS_VERY_HIGH ?? 10;
const MOVE_LOCK_BACKOFF_STEP_MS = RETRY?.ATOMIC_BACKOFF_STEP_MS ?? 50;
const VERIFY_MAX_ATTEMPTS = RETRY?.FILE_OPERATION?.maxAttempts ?? RETRY?.MAX_ATTEMPTS_MEDIUM ?? 3;
const VERIFY_BACKOFF_STEP_MS =
  RETRY?.FILE_OPERATION?.initialDelay ?? TIMEOUTS?.DELAY_TINY ?? MOVE_LOCK_BACKOFF_STEP_MS;
const VERIFY_MAX_DELAY_MS = RETRY?.FILE_OPERATION?.maxDelay ?? 5000;
// How often a move still in flight renews the batch lock. A cross-volume move
// of a large file (copy plus a checksum of both sides) has no upper bound, so
// the lease is kept fresh for as long as the move runs.
const MOVE_LOCK_RENEW_INTERVAL_MS = 30 * 1000;
// How long a move that is still in flight gets after the batch is stopped
// before the batch ends without it.
const STUCK_MOVE_ABORT_GRACE_MS = 15 * 1000;
const MOVE_ABANDONED = Symbol('move-abandoned');

const MAX_RESULTS_PER_CHUNK = 100; // Max results per IPC message chunk
const YIELD_EVERY_N_OPS = 10; // Yield to event loop every N operations

// Cap for the dry-run preview's check-then-walk collision search. Lower than
// MAX_NUMERIC_RETRIES (5000) because the preview enumerates serially via
// fs.access — we want a snappy plan, not a worst-case enumeration. Real
// execution still walks up to MAX_NUMERIC_RETRIES via the rename+EEXIST loop
// before falling back to the UUID path.
const PREVIEW_MAX_NUMERIC_ATTEMPTS = 50;

/**
 * Format the Nth collision-suffixed candidate for a destination path.
 *
 * IMPORTANT: This is the single source of truth for the suffix shape so
 * the dry-run preview and the real move path stay byte-identical. They
 * had drifted post-2.0.9: the executor used `${base}_${N}${ext}` while
 * the preview used `${base} (${N})${ext}`, so the Preview button
 * displayed a destination that did not match what the move would produce.
 *
 * @param {string} originalDestination - The originally requested destination.
 * @param {number} counter - 1-based collision counter.
 * @returns {string} Suffixed candidate path.
 */
function formatNumberedCollisionCandidate(originalDestination, counter) {
  const ext = path.extname(originalDestination);
  // When ext is empty, -ext.length is -0 which equals 0, causing slice(0,0)
  // to return empty string — guard explicitly for the no-extension case.
  const baseName = ext.length > 0 ? originalDestination.slice(0, -ext.length) : originalDestination;
  return `${baseName}_${counter}${ext}`;
}

/**
 * Best-effort size+mtime snapshot of a source file for the organize journal.
 * Returns null when the file cannot be stat'ed — the move itself surfaces
 * the real error (ENOENT etc.) with proper handling.
 * @param {string} sourcePath
 * @returns {Promise<{ sourceSize: number, sourceMtime: number } | null>}
 */
async function captureSourceMetadata(sourcePath) {
  try {
    const stats = await fs.stat(sourcePath);
    if (typeof stats?.size !== 'number' || !Number.isFinite(stats?.mtimeMs)) {
      return null;
    }
    return { sourceSize: stats.size, sourceMtime: stats.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** @param {unknown} destination */
function destinationTargetsUncategorized(destination) {
  const normalized = String(destination || '')
    .replace(/\\/g, '/')
    .toLowerCase();
  return /\/uncategorized(\/|$)/.test(normalized);
}

/**
 * @param {string} sourcePath
 * @param {string} destinationPath
 */
function makeOperationDedupKey(sourcePath, destinationPath) {
  // A direct composite key is faster than hashing and remains collision-free
  // for exact source+destination pair matching within the batch.
  return `${sourcePath}\u0000${destinationPath}`;
}

/** @param {unknown} p */
function _canonicalizeForOverlapCheck(p) {
  if (!p || typeof p !== 'string') return '';
  // Path equality for overlap detection must be case-insensitive wherever the
  // default filesystem is (win32 NTFS, darwin APFS/HFS+): two ops whose
  // destinations differ only by case would otherwise run in parallel, both
  // renameNoReplace probes would see "free", and the loser would silently
  // replace the winner. We don't need full realpath here — the caller runs
  // before path validation normalizes each op; forward slashes + case folding
  // is enough.
  const unified = p.replace(/\\/g, '/');
  return isCaseInsensitiveFileSystem() ? unified.toLowerCase() : unified;
}

/**
 * Detect operations that must not run concurrently: an op whose destination
 * is another op's source, or two ops sharing the same destination (the
 * renameNoReplace preflight is check-then-rename, so parallel same-dest ops
 * could both see "free" and the loser would clobber the winner).
 * Returns the first such `{ from, to }` pair or null. O(n) — builds a set of
 * destinations (flagging duplicates), then scans sources for membership.
 *
 * @param {Array<{source:string,destination:string}>} ops
 * @returns {{ from: string, to: string } | null}
 */
function _detectPathOverlap(ops) {
  if (!Array.isArray(ops) || ops.length < 2) return null;
  const destinations = new Set();
  for (const op of ops) {
    const d = _canonicalizeForOverlapCheck(op?.destination);
    if (!d) continue;
    if (destinations.has(d)) {
      return { from: op.source, to: op.destination };
    }
    destinations.add(d);
  }
  for (const op of ops) {
    const src = _canonicalizeForOverlapCheck(op?.source);
    if (src && destinations.has(src)) {
      return { from: op.source, to: op.destination };
    }
  }
  return null;
}

/**
 * Concurrency limiter (p-limit pattern). Returns a function `limit(fn)` that
 * queues `fn` behind `concurrency` slots.
 *
 * Deliberately not the shared Semaphore: every operation of the batch queues
 * up-front, and the Semaphore's queue cap and waiter timeout rejected the
 * ones still waiting (ops 106+ of a large batch; every queued op once slow
 * cross-volume moves had held the slots for 5 minutes). The
 * unexpected-rejection safety net then rolled back every completed move. A
 * queued operation here waits for as long as the moves ahead of it take;
 * the abort signal is what ends a batch early.
 *
 * @param {number} concurrency - Max concurrent tasks
 * @returns {<T>(fn: () => Promise<T>) => Promise<T>}
 */
const pLimit = (concurrency) => {
  let active = 0;
  /** @type {Array<() => void>} */
  const waiting = [];
  return async (fn) => {
    if (active < concurrency) {
      active++;
    } else {
      // The finishing task hands its slot over, so `active` stays as it is.
      await new Promise((resolve) => {
        waiting.push(() => resolve(undefined));
      });
    }
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
};

// Use shared delay() from promiseUtils (supports .unref() for clean shutdown)

/**
 * Verify move operation completed correctly.
 * Checks that destination exists and source is gone.
 *
 * @param {string} source - Original source path
 * @param {string} destination - Destination path after move
 * @param {LoggerLike} log - Logger instance
 * @throws {Error} If verification fails
 */
async function verifyMoveCompletion(source, destination, log) {
  // Verify destination exists (retry to handle network/FS propagation delays)
  for (let attempt = 1; attempt <= VERIFY_MAX_ATTEMPTS; attempt++) {
    try {
      await fs.access(destination);
      break;
    } catch (error) {
      const isRetryable =
        error.code === 'ENOENT' || (error.code && FILE_LOCK_ERROR_CODES.has(error.code));
      if (!isRetryable || attempt === VERIFY_MAX_ATTEMPTS) {
        const message =
          error.code === 'ENOENT'
            ? `Move verification failed: destination does not exist after move: ${destination}`
            : `Move verification failed: destination not accessible after move: ${destination}`;
        const verificationError = /** @type {NodeJS.ErrnoException} */ (new Error(message));
        verificationError.code = error.code || 'MOVE_VERIFICATION_DESTINATION_FAILED';
        throw verificationError;
      }
      log.debug('[FILE-OPS] Destination not yet visible after move, retrying', {
        destination,
        attempt,
        maxAttempts: VERIFY_MAX_ATTEMPTS,
        code: error.code
      });
      const backoffMs = Math.min(VERIFY_BACKOFF_STEP_MS * attempt, VERIFY_MAX_DELAY_MS);
      await delay(backoffMs);
    }
  }

  // Verify source is gone unless this is a same-file target (including
  // case-only renames on case-insensitive filesystems, where access(source)
  // still succeeds after the rename).
  const shouldVerifySource = isCaseInsensitiveFileSystem()
    ? String(source).toLowerCase() !== String(destination).toLowerCase()
    : source !== destination;
  if (shouldVerifySource) {
    for (let attempt = 1; attempt <= VERIFY_MAX_ATTEMPTS; attempt++) {
      try {
        await fs.access(source);
        if (attempt === VERIFY_MAX_ATTEMPTS) {
          const verificationError = /** @type {NodeJS.ErrnoException} */ (
            new Error(
              `Move verification failed: source file still exists at original location: ${source}`
            )
          );
          verificationError.code = 'MOVE_VERIFICATION_SOURCE_EXISTS';
          throw verificationError;
        }
        log.debug('[FILE-OPS] Source still exists after move, retrying', {
          source,
          attempt,
          maxAttempts: VERIFY_MAX_ATTEMPTS
        });
        const backoffMs = Math.min(VERIFY_BACKOFF_STEP_MS * attempt, VERIFY_MAX_DELAY_MS);
        await delay(backoffMs);
      } catch (sourceCheckErr) {
        // ENOENT is expected (file was moved); any other error should halt processing
        if (sourceCheckErr.code === 'ENOENT') {
          break;
        }
        log.warn('[FILE-OPS] Move verification: unexpected source state', {
          error: sourceCheckErr.message,
          code: sourceCheckErr.code
        });
        throw sourceCheckErr;
      }
    }
  }
}

/**
 * Handle batch file organization with rollback support
 *
 * @param {Object} params - Handler parameters
 * @param {BatchOrganizeOperation} params.operation - Batch operation configuration
 * @param {LoggerLike} [params.logger] - Logger instance
 * @param {(() => any)|null} [params.getServiceIntegration] - Service integration getter
 * @param {GetMainWindowFn} params.getMainWindow - Main window getter
 * @param {AbortSignal|null} [params.abortSignal] - Caller (renderer) abort signal
 * @returns {Promise<Record<string, any>>} Batch operation result
 */
async function handleBatchOrganize(params) {
  return withCorrelationId(async () => {
    const {
      operation,
      logger: handlerLogger,
      getServiceIntegration,
      getMainWindow,
      abortSignal: callerAbortSignal
    } = params;

    const log = handlerLogger || logger;
    const requestedOperationTotal = Array.isArray(operation?.operations)
      ? operation.operations.length
      : 0;
    // Strict mode: any per-file failure triggers rollback. Default is
    // lenient (only the narrow "critical" classification triggers rollback),
    // preserving backward compatibility.
    const strictMode = operation?.strict === true;
    const serviceIntegration =
      typeof getServiceIntegration === 'function' ? getServiceIntegration() : null;
    const processingState = serviceIntegration?.processingState;
    let fileOperationTracker = null;
    try {
      fileOperationTracker = getFileOperationTracker();
    } catch {
      // Non-fatal: tracker is telemetry-only; continue without it.
    }

    // Validate batch
    const validationError = validateBatchOperation(operation, log);
    if (validationError) {
      return validationError;
    }

    // Dry-run path: return the plan WITHOUT acquiring the batch lock,
    // writing to the journal, or touching disk. The renderer can use this
    // for a "show me what would happen" preview before the user commits.
    // Routed before lock acquisition so previewing is concurrency-safe and
    // never blocks a real organize batch.
    if (operation?.dryRun === true) {
      return previewBatchOrganize({ operation, log });
    }

    // Resume support (pause/resume): a fresh invoke may carry the journal id
    // of a previously paused batch. Reusing that id makes
    // createOrLoadOrganizeBatch load the existing journal entry, whose
    // done-op statuses drive the skip-on-resume path below. Validated
    // strictly — a malformed id must fail loud, not silently start a new
    // batch that re-moves already-moved files.
    const rawResumeId =
      typeof operation?.resumeBatchId === 'string' ? operation.resumeBatchId : null;
    if (rawResumeId && !/^batch_\d+_[a-f0-9]{8}$/.test(rawResumeId)) {
      return {
        success: false,
        error: `Invalid resumeBatchId: ${rawResumeId.slice(0, 64)}`,
        errorCode: ERROR_CODES.INVALID_INPUT
      };
    }
    const isResume = Boolean(rawResumeId);

    // Destination policy: every landing folder must be one the user has shown
    // intent for (Smart Folder, folder chosen in a dialog this session,
    // Downloads, userData) or be confirmed in a main-process dialog, once per
    // folder. Decided before the lock so a dialog never holds the batch lock.
    const destinationDecisions = await authorizeDestinations(
      (Array.isArray(operation?.operations) ? operation.operations : []).filter(
        (op) => op && op.status !== 'done'
      ),
      { getServiceIntegration, getMainWindow, log, abortSignal: callerAbortSignal || null }
    );
    // STRATOSORT_STRICT_FILE_OPS applies to batch sources and destinations as
    // it does to single operations.
    const strictFileOps = buildStrictFileOpsAllowlist(getServiceIntegration);
    const strictPathOptions = strictFileOps.enabled
      ? { allowedBasePaths: strictFileOps.allowlist }
      : {};

    // Generate batch ID early for lock acquisition
    const batchId = isResume
      ? rawResumeId
      : `batch_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    // Undo entries for a resumed run get a distinct id so they can never
    // collide with (or be deduped against) the pre-pause run's undo entry —
    // each run's undo covers exactly the moves IT performed.
    const undoBatchId = isResume ? `${batchId}:r${Date.now()}` : batchId;

    // Abort plumbing is declared BEFORE the outer try so the matching
    // `finally` (which releases the lock and removes the listener) can
    // reach it. `let` inside a try-block is scoped to that block only,
    // so the finally cannot see declarations made after `try {`.
    const abortController = new AbortController();
    // Bridge the caller's (renderer's) AbortSignal into the local
    // controller. Without this, a preload timeout or user cancel would
    // unblock the renderer promise while the batch kept moving files
    // on disk — the exact "ghost mutation" this theme targets.
    let removeCallerAbortListener = null;
    if (callerAbortSignal) {
      if (callerAbortSignal.aborted) {
        abortController.abort(callerAbortSignal.reason || 'caller-aborted');
      } else {
        const onCallerAbort = () => {
          abortController.abort(callerAbortSignal.reason || 'caller-aborted');
        };
        callerAbortSignal.addEventListener('abort', onCallerAbort, { once: true });
        removeCallerAbortListener = () =>
          callerAbortSignal.removeEventListener?.('abort', onCallerAbort);
      }
    }

    // Declared before the outer try for the same scoping reason as the abort
    // plumbing above: the finally broadcasts these moves to the renderer.
    // Assigned on every exit path where completed moves STOOD (success,
    // partial failure, cancel, interruption); left null when the batch rolled
    // back — the disk state was restored, so there is nothing to remap.
    /** @type {Array<{ source: string, destination: string }>|null} */
    let movesToBroadcast = null;

    // Acquired immediately before the outer try so no statement can throw
    // between acquisition and the finally that releases it.
    const lockAcquired = await acquireBatchLock(batchId);
    if (!lockAcquired) {
      removeCallerAbortListener?.();
      log.warn('[FILE-OPS] Could not acquire batch lock - another batch operation is in progress');
      return {
        success: false,
        error: 'Another batch operation is already in progress. Please wait for it to complete.',
        errorCode: ERROR_CODES.BATCH_LOCK_TIMEOUT
      };
    }

    try {
      // First statement inside the try so the outer finally's
      // resumeGhostCleanup() is guaranteed to balance it.
      deferGhostCleanup();

      // Initialize tracking variables
      /** @type {Array<Record<string, any>>} */
      const results = [];
      /** @type {Array<{ index: number, source: string, destination: string, originalDestination?: string, rollbackAction?: string }>} */
      const completedOperations = [];
      let successCount = 0;
      let failCount = 0;
      let skippedCount = 0;
      // Ops skipped because the USER aborted (not rollback): reported as
      // `cancelled` entries so the renderer can say "Cancelled — N of M"
      // instead of silently dropping them from the results set.
      let cancelledCount = 0;
      // Ops skipped because a NON-user abort fired (ipc-timeout, shutdown
      // abortAll, registry-cap-evict): the run was interrupted, not
      // cancelled — these ops stay pending in the journal and are replayed
      // by OrganizeResumeService at next launch.
      let interruptedCount = 0;
      // batchId already defined above for lock acquisition
      let shouldRollback = false;
      let rollbackReason = null;
      // Permission failures since the last successful move; a run of them
      // means permissions are gone for the batch, not for one file.
      let consecutivePermissionFailures = 0;
      const processedKeys = new Set(); // For idempotency
      const mkdirPromises = new Map(); // Deduplicate mkdir across concurrent pLimit workers
      let postBatchPersistence = { undoRecorded: true, pathIndexUpdated: true };

      try {
        const svc = serviceIntegration;
        /** @type {{ operations: BatchOp[] } | undefined} */
        let batch;
        if (svc?.processingState?.createOrLoadOrganizeBatch) {
          batch = await svc.processingState.createOrLoadOrganizeBatch(
            batchId,
            operation.operations
          );
        }

        if (!batch || !batch.operations) {
          log.warn(`[FILE-OPS] Batch service unavailable, using direct operations for ${batchId}`);
          batch = {
            operations: operation.operations.map((op) => ({
              ...op,
              status: 'pending'
            }))
          };
        }

        if (isResume) {
          // The batch is live again — startup finalization must not treat it
          // as paused anymore, and a crash from here on should replay it.
          await svc?.processingState?.clearOrganizeBatchPaused?.(batchId);
        }

        const totalOperations = batch.operations.length;

        if (totalOperations > MAX_BATCH_SIZE) {
          log.warn(
            `[FILE-OPS] Batch size ${totalOperations} exceeds maximum ${MAX_BATCH_SIZE} after service load`
          );
          return {
            success: false,
            error: `Batch size exceeds maximum of ${MAX_BATCH_SIZE} operations`,
            errorCode: ERROR_CODES.BATCH_TOO_LARGE,
            maxAllowed: MAX_BATCH_SIZE,
            provided: totalOperations
          };
        }

        log.info(`[FILE-OPS] Starting batch operation ${batchId} with ${totalOperations} files`, {
          batchId,
          totalOperations
        });

        // If any operation's destination is another operation's source (e.g.
        // A -> staging then staging -> B), concurrent execution can reorder
        // them and produce ENOENT for the second move because the first
        // hasn't landed yet. Detect this up-front and force serial execution
        // for the whole batch — a cheap, conservative fix. A future pass can
        // topo-sort to keep concurrency across independent sub-DAGs.
        const pathOverlap = _detectPathOverlap(batch.operations);
        const requestedConcurrency = BATCH?.MAX_CONCURRENT_FILES || 5;
        const effectiveConcurrency = pathOverlap ? 1 : requestedConcurrency;
        if (pathOverlap) {
          log.warn(
            '[FILE-OPS] Batch has path overlap; forcing serial execution to prevent ENOENT',
            {
              batchId,
              sampleOverlap: pathOverlap
            }
          );
        }
        const batchOperationTotal = batch.operations.length;
        const limit = pLimit(effectiveConcurrency);
        // Files this batch has still to move. The duplicate check must not
        // take one of them for a copy that is already filed: it may be moved
        // or renamed away later in this batch. Built here because each
        // operation rewrites its paths to the validated form once it starts.
        const pendingSources = batch.operations
          .filter((op) => op.status !== 'done' && typeof op.source === 'string')
          .map((op) => op.source);

        // Abort reasons the USER deliberately triggered (renderer buttons).
        // Anything else on the signal — 'ipc-timeout', 'shutdown' (abortAll),
        // 'registry-cap-evict', the 'caller-aborted' fallback — is an
        // interruption the user didn't ask for and must not be reported as a
        // cancellation.
        const USER_ABORT_REASONS = new Set(['user-cancel-organize', 'user-pause-organize']);
        const isUserAbort = () => USER_ABORT_REASONS.has(abortController.signal.reason);

        // Push a result entry for an op skipped due to abort (rollback keeps
        // its silent early-exit — restore is coming anyway). User aborts mark
        // the op `cancelled`; non-user aborts mark it `interrupted` (the op
        // stays pending in the journal and resumes at next launch, so calling
        // it cancelled would misreport both intent and outcome).
        /** @param {BatchOp} op */
        const recordCancelledOp = (op) => {
          const userAbort = isUserAbort();
          results.push({
            success: false,
            source: op.source,
            destination: op.destination,
            operation: op.type || 'move',
            ...(userAbort ? { cancelled: true } : { interrupted: true })
          });
          if (userAbort) cancelledCount++;
          else interruptedCount++;
        };

        /** @param {number} i */
        const processOperation = async (i) => {
          // The abort signal is set atomically when a critical error occurs, ensuring
          // concurrent tasks don't continue processing after rollback is triggered
          if (shouldRollback) return;
          if (abortController.signal.aborted) {
            const op = batch.operations[i];
            // Already-done ops (resume) are handled below as successes.
            if (op.status !== 'done') {
              recordCancelledOp(op);
              return;
            }
          }

          // No elapsed-time limit: a batch of large files going to another
          // drive takes as long as the copies take. It used to be rolled back
          // when an operation started more than 5 minutes in.

          if (i > 0 && i % YIELD_EVERY_N_OPS === 0) {
            await new Promise((resolve) => setImmediate(resolve));
          }

          const op = batch.operations[i];

          // Capture original destination before any path normalization mutations
          op._originalDestination = op.destination;

          systemAnalytics.recordOrganizationRouting({
            resolvedToUncategorized: destinationTargetsUncategorized(op._originalDestination),
            reason: 'batch_organize_destination'
          });

          // Skip already completed operations (for resume)
          if (op.status === 'done') {
            results.push({
              success: true,
              source: op.source,
              destination: op.destination,
              operation: op.type || 'move',
              resumed: true
            });
            successCount++;
            return;
          }

          try {
            const opStart = Date.now();
            log.debug('[FILE-OPS] Operation start', {
              batchId,
              index: i,
              source: op.source,
              destination: op.destination,
              resumed: op.status === 'done'
            });

            if (!op.source || !op.destination) {
              throw new Error(
                `Invalid operation data: source="${op.source}", destination="${op.destination}"`
              );
            }

            // SECURITY: Validate paths before any file operations
            const sourceValidation = await validateFileOperationPath(op.source, {
              checkSymlinks: true,
              ...strictPathOptions
            });
            if (!sourceValidation.valid) {
              throw new Error(`Invalid source path: ${sourceValidation.error}`);
            }
            const destValidation = await validateFileOperationPath(op.destination, {
              checkSymlinks: false, // Destination may not exist yet
              ...strictPathOptions
            });
            if (!destValidation.valid) {
              throw new Error(`Invalid destination path: ${destValidation.error}`);
            }
            const destinationDecision =
              decisionForDestination(
                destinationDecisions,
                destValidation.normalizedPath,
                process.platform,
                sourceValidation.normalizedPath
              ) ||
              (await authorizeDestination(destValidation.normalizedPath, {
                sourcePath: sourceValidation.normalizedPath,
                getServiceIntegration,
                getMainWindow,
                log,
                intent: { count: 1, name: path.basename(destValidation.normalizedPath) }
              }));
            if (!destinationDecision.allowed) {
              // The code travels with the per-op result so the renderer can
              // say which folder rule refused the file instead of
              // "check logs for details".
              const refused = new Error(`Invalid destination path: ${destinationDecision.error}`);
              /** @type {any} */ (refused).code =
                destinationDecision.errorCode || 'DESTINATION_NOT_ALLOWED';
              throw refused;
            }
            // Use validated paths
            op.source = sourceValidation.normalizedPath;
            op.destination = destValidation.normalizedPath;

            // Journal the source's size+mtime alongside the in-progress mark so
            // that, after a crash between the rename and markOrganizeOpDone,
            // OrganizeResumeService can recognise the destination occupant as
            // this file rather than failing the op.
            await processingState?.markOrganizeOpStarted?.(
              batchId,
              i,
              await captureSourceMetadata(op.source)
            );

            // Idempotency check — computed AFTER path normalization so that
            // different representations of the same canonical path collapse.
            const idempotencyKey = makeOperationDedupKey(op.source, op.destination);

            if (processedKeys.has(idempotencyKey)) {
              log.warn('[FILE-OPS] Skipping duplicate operation', {
                batchId,
                source: op.source,
                destination: op.destination
              });
              results.push({
                success: true,
                source: op.source,
                destination: op.destination,
                operation: op.type || 'move',
                skipped: true,
                reason: 'duplicate'
              });
              skippedCount++;
              return;
            }
            processedKeys.add(idempotencyKey);

            // Ensure destination directory exists (deduplicate across batch)
            // Synchronous has/set pair is atomic — no await between — so
            // the first worker creates the promise, all others await it.
            const destDir = path.dirname(op.destination);
            if (!mkdirPromises.has(destDir)) {
              mkdirPromises.set(
                destDir,
                fs.mkdir(destDir, { recursive: true }).catch((mkdirError) => {
                  // Never cache a failure for the whole batch: a later op to
                  // this folder retries the mkdir instead of reusing it.
                  mkdirPromises.delete(destDir);
                  throw mkdirError;
                })
              );
            }
            await mkdirPromises.get(destDir);

            // Hard-cancel gate: never START a destructive move once the user
            // aborted. (An in-flight rename still finishes — we never
            // interrupt a syscall mid-move.) Rollback keeps the silent exit.
            if (shouldRollback || abortController.signal.aborted) {
              if (!shouldRollback) recordCancelledOp(op);
              return;
            }

            // Handle file move with collision handling
            // TOCTOU fix: removed verifySourceFile pre-check, handle ENOENT from move directly
            // The move is awaited to its end, never raced against a timer: a
            // timer cannot stop a copy, so the row would say "failed" while
            // the file went on to move with no undo entry or path update.
            // The batch lock is renewed while it runs, and the abort signal
            // is what stops a cross-volume move before it publishes.
            const moveToCompletion = async () => {
              const moveStartedAt = Date.now();
              const lockRenewal = setInterval(() => {
                renewBatchLock(batchId);
                // File name only (see the skipped-file line below for why).
                log.warn('[FILE-OPS] Move still running; the drive is slow or not answering', {
                  batchId,
                  index: i,
                  source: path.basename(op.source),
                  elapsedMs: Date.now() - moveStartedAt
                });
              }, MOVE_LOCK_RENEW_INTERVAL_MS);
              lockRenewal.unref?.();
              // A move on a drive that stopped answering can neither finish
              // nor be interrupted. Once the batch is stopped (Stop, shutdown,
              // rollback) it is given a short grace and then left behind, so
              // the batch can end; settleAbandonedMove deals with it if the
              // drive answers later.
              /** @type {ReturnType<typeof setTimeout> | undefined} */
              let graceTimer;
              /** @type {(value: typeof MOVE_ABANDONED) => void} */
              let abandon = () => {};
              const abandoned = new Promise((resolve) => {
                abandon = resolve;
              });
              const startGrace = () => {
                graceTimer = setTimeout(() => abandon(MOVE_ABANDONED), STUCK_MOVE_ABORT_GRACE_MS);
                graceTimer.unref?.();
              };
              const { signal } = abortController;
              if (signal.aborted) startGrace();
              else signal.addEventListener('abort', startGrace, { once: true });
              const movePromise = performFileMove(
                op,
                log,
                computeFileChecksum,
                signal,
                pendingSources
              );
              try {
                const outcome = await Promise.race([movePromise, abandoned]);
                if (outcome !== MOVE_ABANDONED) return outcome;
                log.warn(
                  '[FILE-OPS] Move did not answer after the batch was stopped; left behind',
                  {
                    batchId,
                    index: i,
                    source: path.basename(op.source),
                    elapsedMs: Date.now() - moveStartedAt
                  }
                );
                void settleAbandonedMove(
                  movePromise,
                  op.source,
                  () => isUserAbort() || shouldRollback,
                  log
                );
                return { cancelled: true };
              } finally {
                clearInterval(lockRenewal);
                clearTimeout(graceTimer);
                signal.removeEventListener('abort', startGrace);
              }
            };
            /** @type {any} */
            let moveResult;
            try {
              moveResult = await moveToCompletion();
            } catch (firstMoveError) {
              let moveError = firstMoveError;
              // A rename ENOENT is either a missing source or a destination
              // folder removed after the mkdir above (user, sync client).
              // Nothing moved in either case. When the source is still
              // there, recreate the folder (the per-batch mkdir is cached)
              // and retry once instead of calling the source missing.
              if (moveError.code === 'ENOENT' && (await pathExists(op.source))) {
                log.warn('[FILE-OPS] Destination folder missing at move time, recreating', {
                  batchId,
                  index: i,
                  destination: path.basename(op.destination)
                });
                mkdirPromises.delete(destDir);
                // Same hard-cancel gate as before the first attempt.
                if (shouldRollback || abortController.signal.aborted) {
                  if (!shouldRollback) recordCancelledOp(op);
                  return;
                }
                try {
                  await fs.mkdir(destDir, { recursive: true });
                  moveResult = await moveToCompletion();
                  moveError = null;
                } catch (retryError) {
                  moveError = retryError;
                  if (retryError.code === 'ENOENT' && (await pathExists(op.source))) {
                    const missingDir = /** @type {NodeJS.ErrnoException} */ (
                      new Error(`Destination folder missing: ${destDir}`)
                    );
                    missingDir.code = 'ENOENT';
                    throw missingDir;
                  }
                }
              }
              if (moveError && moveError.code === 'ENOENT') {
                log.warn('[FILE-OPS] Source file not found (ENOENT), cannot move', {
                  batchId,
                  index: i,
                  source: op.source,
                  destination: op.destination,
                  error: moveError.message
                });
                results.push({
                  success: false,
                  source: op.source,
                  destination: op.destination,
                  error: `Source file not found: ${op.source}`,
                  operation: op.type || 'move',
                  skipped: true
                });
                failCount++;
                return;
              }
              if (moveError) throw moveError;
            }

            if (moveResult && moveResult.cancelled) {
              // performFileMove bailed with the source untouched: the abort
              // landed between the gate above and the first rename attempt,
              // or during a cross-volume copy that was then never published.
              recordCancelledOp(op);
              return;
            }

            if (moveResult && moveResult.skipped) {
              const resolvedDestination = moveResult.destination || op.destination;
              const currentFileName = path.basename(op.source);

              // Verify state is consistent (dest exists, source gone) before
              // anything reports the file as filed.
              try {
                await verifyMoveCompletion(op.source, resolvedDestination, log);
              } catch (verifyError) {
                // The source was removed as a duplicate and the copy it
                // duplicated cannot be confirmed. Rollback has nothing to
                // copy back, so the message is where the user learns that the
                // file is in the trash.
                if (moveResult.sourceRemoval === 'trashed' && verifyError instanceof Error) {
                  verifyError.message +=
                    '. The original was moved to the system Trash / Recycle Bin as a duplicate and can be restored from there.';
                }
                throw verifyError;
              }

              consecutivePermissionFailures = 0;
              // A duplicate skip still mutates disk state by deleting the source file.
              // Track it so a later critical failure can restore the original path.
              completedOperations.push({
                index: i,
                source: op.source,
                destination: resolvedDestination,
                originalDestination: op._originalDestination,
                rollbackAction: 'restore_duplicate_source'
              });
              renewBatchLock(batchId);

              // One info line per skipped file in every build: the Live
              // Activity feed shows "Skipped <name> (already in place)". File
              // names only, never folders or content: the logger's POSIX path
              // redaction stops at the first space, so a full path could leak
              // folder names such as "Medical Records" into the log.
              log.info('[FILE-OPS] Move skipped (duplicate)', {
                batchId,
                source: path.basename(op.source),
                destination: path.basename(resolvedDestination)
              });

              // Rollback started while this skip was being verified: it
              // restores the source and reports the row (see the same check
              // on the move path below).
              if (shouldRollback) return;

              skippedCount++;
              results.push({
                success: true,
                source: op.source,
                destination: resolvedDestination,
                operation: op.type || 'move',
                skipped: true,
                reason: moveResult.reason,
                // 'trashed' or 'deleted': where the source went.
                sourceRemoval: moveResult.sourceRemoval
              });

              // Not awaited (see the success path below for why).
              void processingState?.markOrganizeOpDone?.(batchId, i, {
                destination: resolvedDestination,
                skipped: true
              });
              void processingState?.clearReadyAnalysis?.(op.source);

              sendOperationProgress(getMainWindow, {
                type: 'batch_organize',
                current: successCount + failCount + skippedCount,
                total: batchOperationTotal,
                currentFile: currentFileName
              });

              return;
            }

            op.destination = moveResult.destination;
            const currentFileName = path.basename(op.source);

            // This prevents "ghost" files or duplicates appearing in the UI
            if (fileOperationTracker) {
              try {
                fileOperationTracker.recordOperation(op.source, 'move', 'batchOrganize');
                fileOperationTracker.recordOperation(op.destination, 'move', 'batchOrganize');
              } catch (trackerErr) {
                log.warn('[FILE-OPS] Failed to record operation in tracker', {
                  error: trackerErr.message
                });
              }
            }

            // One info line per moved file in every build (not trace-only):
            // the Live Activity feed turns it into "Filed <name>". File names
            // only, never folders or content (see the skipped line above).
            log.info('[FILE-OPS] Move completed', {
              batchId,
              index: i,
              source: path.basename(op.source),
              destination: path.basename(op.destination),
              durationMs: Date.now() - opStart
            });

            // Post-move verification: ensure destination exists and source is gone
            await verifyMoveCompletion(op.source, op.destination, log);

            consecutivePermissionFailures = 0;
            // Push to completedOperations IMMEDIATELY after verify so rollback
            // can restore this file if another concurrent task triggers abort
            completedOperations.push({
              index: i,
              source: op.source,
              destination: op.destination,
              originalDestination: op._originalDestination
            });
            renewBatchLock(batchId);

            // Check if rollback was triggered while we were verifying.
            // USER abort deliberately does NOT exit here: the move already
            // happened on disk, so the op must still be reported and
            // journaled — otherwise successCount undercounts, the renderer's
            // Redux paths go stale, and the journal replays the op on next
            // launch (the file is gone from source by then).
            if (shouldRollback) return;

            // Not awaited: the done mark need not be durable before the next
            // op starts. A crash here leaves the op in_progress with its
            // source metadata, from which resume recognises the moved file at
            // the planned destination or, after a collision walk / UUID
            // fallback, under its suffixed sibling name (OrganizeResumeService
            // findMovedSibling). Only the started mark above is
            // awaited (it must precede the rename). completeOrganizeBatch at
            // the end awaits a flush that covers every mark issued before it.
            void processingState?.markOrganizeOpDone?.(batchId, i, {
              destination: op.destination
            });
            void processingState?.clearReadyAnalysis?.(op.source);

            /** @type {Record<string, any>} */
            const result = {
              success: true,
              source: op.source,
              destination: op.destination,
              operation: op.type || 'move'
            };
            // Surface semantic duplicate warning if detected during pre-move check
            if (op._semanticDuplicate) {
              result.semanticDuplicate = op._semanticDuplicate;
            }
            results.push(result);
            successCount++;

            log.debug('[FILE-OPS] Operation success', {
              batchId,
              index: i,
              source: op.source,
              destination: op.destination,
              semanticDuplicate: op._semanticDuplicate ? 'yes' : 'no'
            });

            // Send progress to renderer
            sendOperationProgress(getMainWindow, {
              type: 'batch_organize',
              current: successCount + failCount + skippedCount,
              total: batchOperationTotal,
              currentFile: currentFileName
            });
          } catch (error) {
            const errorMessage = error?.message || String(error || 'Unknown error');
            await processingState?.markOrganizeOpError?.(batchId, i, errorMessage);

            // Determine if critical error (always triggers rollback) or if
            // strict mode makes any failure terminal. One permission denial
            // is a per-file failure; a run of them is systemic.
            let isCriticalError = isCriticalFileError(error);
            if (isPermissionFileError(error)) {
              consecutivePermissionFailures++;
              if (consecutivePermissionFailures >= PERMISSION_FAILURE_ESCALATION_THRESHOLD) {
                isCriticalError = true;
              }
            }
            const rollbackThisFailure = isCriticalError || strictMode;

            if (rollbackThisFailure) {
              shouldRollback = true;
              const reasonKind = isCriticalError ? 'Critical error' : 'Strict-mode failure';
              rollbackReason = `${reasonKind} on file ${i + 1}/${batchOperationTotal}: ${errorMessage}`;
              abortController.abort();
              log.error(
                `[FILE-OPS] ${reasonKind} in batch ${batchId}, will rollback ${completedOperations.length} completed operations`,
                {
                  error: errorMessage,
                  errorCode: error?.code,
                  file: op.source,
                  strictMode
                }
              );
            }

            results.push({
              success: false,
              source: op.source,
              destination: op.destination,
              error: errorMessage,
              ...(typeof error?.code === 'string' && error.code ? { errorCode: error.code } : {}),
              operation: op.type || 'move',
              critical: isCriticalError,
              strictModeTriggered: !isCriticalError && rollbackThisFailure
            });
            failCount++;

            log.warn('[FILE-OPS] Operation failed', {
              batchId,
              index: i,
              source: op.source,
              destination: op.destination,
              error: errorMessage,
              critical: isCriticalError
            });
          }
        };

        const promises = batch.operations.map((_, i) => limit(() => processOperation(i)));
        const opResults = await Promise.allSettled(promises);

        // `processOperation` owns a try/catch that translates expected failures
        // into `results`/`failCount`/`shouldRollback` state. A rejection escaping
        // that catch is therefore *unexpected* — something threw before or after
        // the inner try (e.g. analytics, processingState adapter, or a bug in
        // the handler itself). Previously those rejections were silently
        // swallowed by Promise.allSettled, making the batch appear to complete
        // cleanly while dropping files from the results set. Treat any
        // rejection here as critical and trigger rollback so we never return
        // partial success to the UI without acknowledging the loss.
        const unexpectedRejections = [];
        for (let idx = 0; idx < opResults.length; idx += 1) {
          const r = opResults[idx];
          if (r.status !== 'rejected') continue;
          const op = batch.operations[idx];
          const errorMessage = r.reason?.message || String(r.reason || 'Unknown error');
          unexpectedRejections.push({ index: idx, source: op?.source, errorMessage });
          failCount++;
          results.push({
            success: false,
            source: op?.source,
            destination: op?.destination,
            error: `Unhandled batch worker failure: ${errorMessage}`,
            operation: op?.type || 'move',
            critical: true
          });
        }
        if (unexpectedRejections.length > 0) {
          shouldRollback = true;
          rollbackReason =
            rollbackReason ||
            `Unhandled batch worker failure on ${unexpectedRejections.length} operation(s)`;
          abortController.abort();
          log.error('[FILE-OPS] Unexpected rejections from batch workers', {
            batchId,
            count: unexpectedRejections.length,
            first: unexpectedRejections[0]
          });
        }

        // Execute rollback if needed. executeRollback also closes the
        // journal batch (rolledBackAt + completedAt) so the rolled-back
        // batch can never resurface in getIncompleteOrganizeBatches and be
        // auto-replayed at next launch.
        if (shouldRollback && completedOperations.length > 0) {
          const rollbackOutcome = await executeRollback(
            completedOperations,
            results,
            failCount,
            rollbackReason,
            batchId,
            log,
            processingState
          );
          // Moves the rollback could NOT undo stood on disk: tell the
          // renderer about them (finally block) and give them an undo entry
          // and path-index update, like the moves of a batch that finished.
          // Restored moves get neither.
          const unrestored = reconcileRolledBackResults(
            rollbackOutcome,
            completedOperations,
            rollbackReason
          );
          if (unrestored.length > 0) {
            movesToBroadcast = unrestored;
            try {
              await recordUndoAndUpdateDatabase(
                batch,
                rollbackOutcome.results,
                unrestored.length,
                undoBatchId,
                getServiceIntegration,
                log,
                abortController.signal,
                unrestored
              );
            } catch (persistError) {
              // Best-effort: the rollback outcome must still reach the caller.
              log.warn('[FILE-OPS] Failed to persist moves a rollback could not undo', {
                batchId,
                count: unrestored.length,
                error: persistError?.message || String(persistError)
              });
            }
          }
          return rollbackOutcome;
        }

        // Record undo and update database BEFORE marking the batch complete.
        // A crash mid-persistence leaves the batch incomplete in the journal,
        // so OrganizeResumeService re-runs persistence on next launch instead
        // of leaving undo/vector/history pointing at stale paths. Persistence
        // is journaled per op index, and only when BOTH the undo entry and
        // the path index landed: a partial result (coordinator down, undo
        // service missing) must stay uncovered so the resume pass retries
        // exactly those ops instead of treating the whole batch as done.
        if (!shouldRollback) {
          postBatchPersistence = await recordUndoAndUpdateDatabase(
            batch,
            results,
            successCount,
            undoBatchId,
            getServiceIntegration,
            log,
            abortController.signal,
            completedOperations
          );
          if (postBatchPersistence.undoRecorded && postBatchPersistence.pathIndexUpdated) {
            await processingState?.markOrganizeOpsPersisted?.(
              batchId,
              completedOperations.map((c) => c.index)
            );
          }
        }

        // Pause: finalize what happened (undo + persistence above) but leave
        // the journal batch OPEN with a pausedAt marker. Resume is a fresh
        // invoke carrying resumeBatchId; on app restart,
        // OrganizeResumeService finalizes paused batches WITHOUT replaying
        // their pending ops (an auto-running batch at launch would be
        // surprising).
        const pauseRequested =
          abortController.signal.aborted &&
          abortController.signal.reason === 'user-pause-organize' &&
          !shouldRollback;
        if (pauseRequested) {
          await processingState?.markOrganizeBatchPaused?.(batchId);
          const pausedSuccessCount = successCount + skippedCount;
          log.info('[FILE-OPS] Batch paused by user', {
            batchId,
            completed: pausedSuccessCount,
            remaining: cancelledCount
          });
          const pausedSummary = {
            success: pausedSuccessCount > 0 || failCount === 0,
            paused: true,
            batchId,
            successCount: pausedSuccessCount,
            failCount,
            cancelledCount,
            completedOperations: completedOperations.length,
            summary: `Paused after ${pausedSuccessCount} of ${requestedOperationTotal} files`,
            ...postBatchPersistence
          };
          // Same IPC-reply size guard as the completion path below: pausing
          // a large batch must not return thousands of result objects in one
          // reply. Fall back to inline results only if chunk delivery failed.
          if (results.length > MAX_RESULTS_PER_CHUNK) {
            const { sent, totalChunks } = await sendChunkedResults(
              getMainWindow,
              batchId,
              results,
              MAX_RESULTS_PER_CHUNK
            );
            if (sent) {
              return { ...pausedSummary, chunkedResults: true, totalChunks };
            }
          }
          return { ...pausedSummary, results };
        }

        // Non-user aborts (ipc-timeout, shutdown abortAll, registry-cap-evict)
        // interrupt the batch the way a crash would. Leave the journal batch
        // OPEN — no completedAt — so OrganizeResumeService replays the
        // remaining ops at next launch; completing it here would silently
        // drop them. User cancel still closes the batch (the user chose to
        // discard the remainder), and rollback-triggered aborts keep their
        // close semantics: executeRollback stamps the batch itself, and a
        // rollback with zero completed ops has nothing to replay.
        const interruptedByNonUserAbort =
          abortController.signal.aborted && !shouldRollback && !isUserAbort();
        if (!interruptedByNonUserAbort) {
          await processingState?.completeOrganizeBatch?.(batchId);
        }
      } catch (error) {
        const batchErrorMessage = error?.message || String(error || 'Unknown error');
        // Log the error - don't silently swallow it
        log.error('[FILE-OPS] Batch operation failed with error', {
          batchId,
          error: batchErrorMessage,
          successCount,
          failCount,
          completedOperations: completedOperations.length
        });

        // Whatever moved before the batch error stood (this path never rolls
        // back) — the renderer must still be told about those moves.
        movesToBroadcast = completedOperations;

        const errEffective = successCount + skippedCount;
        if (errEffective > 0) {
          // Round-3 audit fix: partial failure must NOT report success: true.
          // Pre-fix, a batch where some files moved and some didn't returned
          // success: true + partialFailure: true; renderers that branched on
          // result.success entered the happy path and may have rendered
          // "organized" without surfacing the failed entries to the user.
          // Reporting success: false here makes the renderer's error path
          // fire while partialFailure + successCount preserve the nuance
          // that *some* operations succeeded.
          return {
            success: false,
            partialFailure: true,
            results,
            successCount: errEffective,
            failCount,
            completedOperations: completedOperations.length,
            summary: `Processed ${requestedOperationTotal} files: ${errEffective} successful, ${failCount} failed (batch error: ${batchErrorMessage})`,
            batchId,
            error: batchErrorMessage,
            errorCode: ERROR_CODES.PARTIAL_FAILURE
          };
        }

        return {
          success: false,
          error: batchErrorMessage,
          errorCode: ERROR_CODES.BATCH_OPERATION_FAILED,
          results,
          successCount: 0,
          failCount,
          completedOperations: completedOperations.length,
          batchId
        };
      }

      // Skipped duplicates are successful outcomes — the file ended up at the
      // correct destination (the duplicate was kept, the source removed).
      // Include them in successCount so the renderer doesn't report "0 organized."
      const effectiveSuccessCount = successCount + skippedCount;
      // USER cancel (not rollback): completed moves stand + are undoable; the
      // renderer uses these fields for "Cancelled — N of M" messaging. The
      // signal also fires for non-user reasons (ipc-timeout, shutdown
      // abortAll, registry-cap-evict) — those are reported as `interrupted`
      // instead, and the journal batch was left open above so
      // OrganizeResumeService replays the remainder at next launch.
      // (A pause abort never reaches here — the pause branch returned.)
      const wasCancelled =
        abortController.signal.aborted &&
        !shouldRollback &&
        abortController.signal.reason === 'user-cancel-organize';
      const wasInterrupted = abortController.signal.aborted && !shouldRollback && !wasCancelled;
      const interruptionFields = wasInterrupted
        ? {
            interrupted: true,
            interruptedCount,
            abortReason: String(abortController.signal.reason ?? 'aborted')
          }
        : {};

      movesToBroadcast = completedOperations;

      if (results.length > MAX_RESULTS_PER_CHUNK) {
        const { sent, totalChunks } = await sendChunkedResults(
          getMainWindow,
          batchId,
          results,
          MAX_RESULTS_PER_CHUNK
        );

        if (!sent) {
          return {
            success: effectiveSuccessCount > 0 && !shouldRollback,
            cancelled: wasCancelled,
            cancelledCount,
            ...interruptionFields,
            results,
            successCount: effectiveSuccessCount,
            failCount,
            completedOperations: completedOperations.length,
            summary: `Processed ${requestedOperationTotal} files: ${effectiveSuccessCount} successful, ${failCount} failed`,
            batchId,
            ...postBatchPersistence
          };
        }

        // Return summary only (results sent via chunks)
        return {
          success: effectiveSuccessCount > 0 && !shouldRollback,
          cancelled: wasCancelled,
          cancelledCount,
          ...interruptionFields,
          successCount: effectiveSuccessCount,
          failCount,
          completedOperations: completedOperations.length,
          summary: `Processed ${requestedOperationTotal} files: ${effectiveSuccessCount} successful, ${failCount} failed`,
          batchId,
          chunkedResults: true,
          totalChunks,
          ...postBatchPersistence
        };
      }

      // For small result sets, return inline as before (backward compatible)
      return {
        success: effectiveSuccessCount > 0 && !shouldRollback,
        cancelled: wasCancelled,
        cancelledCount,
        ...interruptionFields,
        results,
        successCount: effectiveSuccessCount,
        failCount,
        completedOperations: completedOperations.length,
        summary: `Processed ${requestedOperationTotal} files: ${effectiveSuccessCount} successful, ${failCount} failed`,
        batchId,
        ...postBatchPersistence
      };
    } finally {
      // Batch-level FILE_OPERATION_COMPLETE on every exit path where completed
      // moves stood (success, partial failure, cancel mid-batch, interruption)
      // so the renderer's graph/timeline/recommendation-map remap listeners
      // fire for batch organize exactly like they do for single-file moves.
      // Rolled-back batches restored the disk state, so nothing is emitted.
      if (movesToBroadcast && movesToBroadcast.length > 0) {
        sendFileOperationBatchComplete(getMainWindow, {
          operation: 'move',
          files: movesToBroadcast.map((c) => c.source),
          destinations: movesToBroadcast.map((c) => c.destination)
        });
      }
      // Always release the batch lock when operation completes
      releaseBatchLock(batchId);
      removeCallerAbortListener?.();
      resumeGhostCleanup();
    }
  });
}

/**
 * Error codes that indicate systemic failure (not a single bad file) and
 * therefore must trigger rollback regardless of the caller's strict flag.
 *
 * Grouped by root cause:
 *  - Read-only FS:     EROFS
 *  - Storage/quota:    ENOSPC, EDQUOT, EFBIG
 *  - IO integrity:     EIO, checksum mismatch, verification failed
 *  - Path integrity:   ENAMETOOLONG, EUUID_EXHAUSTED,
 *                      MOVE_VERIFICATION_DESTINATION_FAILED,
 *                      MOVE_VERIFICATION_SOURCE_EXISTS
 *  - Resource pressure:EMFILE, ENFILE
 *  - Process lifecycle:ECANCELED
 *
 * NOTE: `PATH_TOO_LONG` is intentionally NOT critical. It's only thrown
 * inside the EEXIST collision-resolver loop when a single file's
 * suffix-grown destination exceeds the platform path cap (e.g. Windows
 * 260 without long paths enabled). Triggering rollback for the entire
 * batch on one such file punishes the other files in the batch for a
 * platform configuration issue affecting one destination — earlier
 * post-2.0.9 behavior was particularly painful for users with deeply
 * nested smart-folder trees on Windows. Demoting it to per-file failure
 * preserves the v2.0.9 outcome (organize the rest, surface the failure
 * for the one file).
 *
 * NOTE: `EACCES` / `EPERM` (and their mapped FILE_ACCESS_DENIED /
 * PERMISSION_DENIED) are NOT critical on their own either. The same codes
 * are FILE_LOCK_ERROR_CODES above: a Windows AV/indexer hold, a
 * delete-pending handle, or one source folder the user cannot write
 * surfaces as EPERM/EACCES for that one file, and rolling back every other
 * completed move for it discarded the whole organize. A run of
 * PERMISSION_FAILURE_ESCALATION_THRESHOLD permission failures with no
 * successful move in between is still treated as systemic (permissions
 * revoked on the destination) and rolls the batch back; see
 * isPermissionFileError and its use in handleBatchOrganize.
 */
const CRITICAL_ERROR_CODES = new Set([
  'EROFS',
  'ENOSPC',
  'EDQUOT',
  'EFBIG',
  'EIO',
  'ENAMETOOLONG',
  'EUUID_EXHAUSTED',
  'MOVE_VERIFICATION_DESTINATION_FAILED',
  'MOVE_VERIFICATION_SOURCE_EXISTS',
  'EMFILE',
  'ENFILE',
  'ECANCELED'
]);

/**
 * FileSystemError-mapped equivalents of the codes above. Kept in lockstep
 * with CRITICAL_ERROR_CODES — the PATH_TOO_LONG exclusion applies here too.
 */
const CRITICAL_MAPPED_ERROR_CODES = new Set([
  'DISK_FULL',
  'QUOTA_EXCEEDED',
  'IO_ERROR',
  'TOO_MANY_OPEN_FILES'
]);

const CRITICAL_MESSAGE_FRAGMENTS = ['checksum mismatch', 'verification failed'];

const PERMISSION_ERROR_CODES = new Set([
  'EACCES',
  'EPERM',
  'FILE_ACCESS_DENIED',
  'PERMISSION_DENIED'
]);

/**
 * Permission failures in a row (no successful move in between) after which
 * the batch treats them as systemic and rolls back, as it does for ENOSPC.
 */
const PERMISSION_FAILURE_ESCALATION_THRESHOLD = 3;

/**
 * Whether a failed op's error is a permission/access denial. On its own that
 * is a per-file failure (see CRITICAL_ERROR_CODES); repeated, it escalates.
 * @param {any} error
 * @returns {boolean}
 */
function isPermissionFileError(error) {
  if (!error || typeof error !== 'object') return false;
  if (typeof error.code === 'string' && PERMISSION_ERROR_CODES.has(error.code)) return true;
  const originalCode = error.metadata?.originalCode;
  return typeof originalCode === 'string' && PERMISSION_ERROR_CODES.has(originalCode);
}

/**
 * Check if an error is critical enough to trigger rollback regardless of
 * the caller's strict flag. A critical error almost always means continued
 * processing will fail the same way (out of disk, permissions revoked, FS
 * read-only, etc.) so we stop and undo any partial work.
 * @param {any} error - Error-like value from a failed operation
 * @returns {boolean}
 */
function isCriticalFileError(error) {
  if (!error || typeof error !== 'object') {
    return false;
  }
  if (error.code && CRITICAL_ERROR_CODES.has(error.code)) {
    return true;
  }
  const originalCode = error.metadata?.originalCode;
  if (typeof originalCode === 'string' && CRITICAL_ERROR_CODES.has(originalCode)) {
    return true;
  }
  if (error.code && CRITICAL_MAPPED_ERROR_CODES.has(error.code)) {
    return true;
  }
  const message = typeof error.message === 'string' ? error.message : '';
  return CRITICAL_MESSAGE_FRAGMENTS.some((fragment) => message.includes(fragment));
}

/**
 * Rewrite the per-op results of a rolled-back batch to match the disk.
 * executeRollback hands back the rows pushed before the rollback, so every
 * completed op still read `success: true` and the renderer filed restored
 * files under destinations the rollback had just emptied. A restored op
 * becomes `success: false, rolledBack: true`; an op whose restore failed
 * keeps `success: true` (the file really is at its destination) and gains
 * `rollbackFailed: true`. A completed op that never pushed its row (it
 * finished while the failing op was already rolling back) gets one. Every
 * success row for a source is rewritten, so a duplicate op's skip row cannot
 * outlive the restore. Mutates the rows array in place.
 * @param {any} rollbackOutcome - executeRollback's return value
 * @param {Array<{ index: number, source: string, destination: string, rollbackAction?: string }>} completedOperations
 * @param {string|null} rollbackReason
 * @returns {Array<{ index: number, source: string, destination: string, rollbackAction?: string }>}
 *   completed ops that are still at their destination
 */
function reconcileRolledBackResults(rollbackOutcome, completedOperations, rollbackReason) {
  /** @type {Array<Record<string, any>> | null} */
  const rows = Array.isArray(rollbackOutcome?.results) ? rollbackOutcome.results : null;
  const rollbackResults = Array.isArray(rollbackOutcome?.rollbackResults)
    ? rollbackOutcome.rollbackResults
    : null;
  if (!rows || !rollbackResults) return [];
  /** @type {Map<string, { success: boolean, error?: string }>} */
  const outcomeBySource = new Map();
  for (const rr of rollbackResults) {
    if (rr && typeof rr.file === 'string') outcomeBySource.set(rr.file, rr);
  }
  const unrestored = [];
  for (const completed of completedOperations) {
    const outcome = outcomeBySource.get(completed.source);
    if (!outcome) continue;
    // Every success row for this source, not just the first: a duplicate op
    // in the same batch (same source -> dest) hits the idempotency skip and
    // pushes its own success row, and leaving either row at success: true
    // would count a restored file as organized.
    /** @type {number[]} */
    const rowIndexes = [];
    rows.forEach((r, idx) => {
      if (r && r.success === true && r.source === completed.source) rowIndexes.push(idx);
    });
    if (!outcome.success) unrestored.push(completed);
    /** @param {Record<string, any>} row */
    const rewrite = (row) =>
      outcome.success
        ? { ...row, success: false, rolledBack: true, error: rollbackReason || 'Batch rolled back' }
        : { ...row, success: true, rollbackFailed: true, rollbackError: outcome.error };
    if (rowIndexes.length > 0) {
      for (const idx of rowIndexes) rows[idx] = rewrite(rows[idx]);
      continue;
    }
    // An op that completed while the failing op was already rolling the
    // batch back never pushed its row; every op that changed the disk
    // still gets one.
    rows.push(
      rewrite({
        source: completed.source,
        destination: completed.destination,
        operation: 'move',
        ...(completed.rollbackAction === 'restore_duplicate_source'
          ? { skipped: true, reason: 'duplicate' }
          : {})
      })
    );
  }
  return unrestored;
}

/**
 * Perform a single file move with collision handling
 * @param {BatchOp} op
 * @param {LoggerLike} log
 * @param {typeof computeFileChecksum} checksumFn
 * @param {AbortSignal|null} [abortSignal]
 * @param {string[]} [pendingSources] - Every source the caller's batch has
 *   still to move (the same array for each call), so the duplicate check does
 *   not count one of them as a copy already at the destination.
 */
async function performFileMove(op, log, checksumFn, abortSignal = null, pendingSources) {
  // This prevents creating numbered copies of files that already exist.
  const duplicateResult = await handleDuplicateMove({
    sourcePath: op.source,
    destinationPath: op.destination,
    checksumFn,
    logger: log,
    logPrefix: '[FILE-OPS]',
    dedupContext: 'batchOrganize',
    removeEmbeddings: removeEmbeddingsForPathBestEffort,
    pendingSources
  });
  if (duplicateResult) return duplicateResult;

  // Semantic duplicate check: warn if a highly similar file already exists
  // at the destination (catches near-duplicates that differ in binary content
  // but are semantically identical, e.g., different PDF exports of the same doc).
  try {
    const sourceFileId = getSemanticFileId(op.source);
    const destDir = path.dirname(op.destination);
    const semanticResult = await findSemanticDuplicates({
      sourceFileId,
      destinationDir: destDir,
      threshold: 0.95, // High threshold for batch organize to avoid false positives
      topK: 1,
      logger: log
    });
    if (semanticResult.hasDuplicates) {
      const match = /** @type {{ id: string, score: number, metadata?: Record<string, any> }} */ (
        semanticResult.matches[0]
      );
      log.info('[FILE-OPS] Semantic near-duplicate detected at destination', {
        source: op.source,
        similarFile: match.metadata?.filePath || match.id,
        similarity: match.score.toFixed(3),
        action: 'proceeding_with_move'
      });
      // Attach warning metadata to op for caller visibility.
      // We proceed with the move but callers can surface the warning to the user.
      op._semanticDuplicate = {
        similarFile: match.metadata?.filePath || match.id,
        similarity: match.score
      };
    }
  } catch (semanticErr) {
    // Non-fatal: semantic check is advisory, don't block the move
    log.debug('[FILE-OPS] Semantic duplicate check failed (non-fatal)', {
      error: semanticErr?.message
    });
  }

  // Last zero-side-effect point: the duplicate check above either returned a
  // result (skip path) or did nothing, and the semantic check is advisory.
  // Past here a rename mutates disk, so honor a user abort now or not at all.
  if (abortSignal?.aborted) {
    return { cancelled: true };
  }

  let counter = 0;
  let uniqueDestination = op.destination;
  const ext = path.extname(op.destination);
  // When ext is empty, -ext.length is -0 which equals 0, causing slice(0,0) to return empty string
  const baseName = ext.length > 0 ? op.destination.slice(0, -ext.length) : op.destination;
  let operationComplete = false;

  const advanceToNextCandidate = () => {
    counter++;
    // Single source of truth so preview and execute produce identical
    // suffixed paths; see formatNumberedCollisionCandidate at top of file.
    uniqueDestination = formatNumberedCollisionCandidate(op.destination, counter);
    const maxPathLength = getEffectiveMaxPathLength();
    if (uniqueDestination.length > maxPathLength) {
      const err = /** @type {NodeJS.ErrnoException} */ (
        new Error(
          `Destination path exceeds platform limit (${uniqueDestination.length} > ${maxPathLength})`
        )
      );
      err.code = 'PATH_TOO_LONG';
      throw err;
    }
  };

  while (!operationComplete && counter < MAX_NUMERIC_RETRIES) {
    try {
      await renameWithRetry(op.source, uniqueDestination, log);
      operationComplete = true;
    } catch (renameError) {
      if (renameError.code === 'EEXIST') {
        advanceToNextCandidate();
        continue;
      } else if (renameError.code === 'EXDEV') {
        // Cross-device move. Another writer can take the name while the copy
        // runs; the no-replace publish then refuses and the walk moves on to
        // the next suffix, exactly like a same-device EEXIST.
        try {
          await performCrossDeviceMove(op.source, uniqueDestination, log, checksumFn, abortSignal);
          operationComplete = true;
        } catch (crossDeviceError) {
          // Stopped by the abort before anything was published: nothing moved.
          if (isMoveAbortedError(crossDeviceError, abortSignal)) return { cancelled: true };
          if (!isNameTakenError(crossDeviceError)) throw crossDeviceError;
          advanceToNextCandidate();
        }
      } else {
        throw renameError;
      }
    }
  }

  // UUID fallback if numeric exhausted
  if (!operationComplete) {
    try {
      uniqueDestination = await performUUIDFallback(
        op,
        baseName,
        ext,
        log,
        checksumFn,
        abortSignal
      );
    } catch (fallbackError) {
      if (isMoveAbortedError(fallbackError, abortSignal)) return { cancelled: true };
      throw fallbackError;
    }
  }

  return { destination: uniqueDestination };
}

/**
 * Follow a move the batch stopped waiting for. The batch reported the file as
 * not moved, so when the drive answers after all and the move went through,
 * the file is put back where it was. That happens only when shouldReturn()
 * says the batch was cancelled or rolled back; an interrupted batch resumes
 * from its journal instead. It never rejects.
 * @param {Promise<any>} movePromise
 * @param {string} source
 * @param {() => boolean} shouldReturn
 * @param {LoggerLike} log
 * @returns {Promise<void>}
 */
async function settleAbandonedMove(movePromise, source, shouldReturn, log) {
  let movedTo;
  try {
    const outcome = await movePromise;
    movedTo = outcome && !outcome.cancelled && !outcome.skipped ? outcome.destination : null;
  } catch (lateError) {
    log.warn('[FILE-OPS] Move left behind by a stopped batch failed; the file did not move', {
      source: path.basename(source),
      error: /** @type {any} */ (lateError)?.message
    });
    return;
  }
  if (!movedTo) return;
  if (!shouldReturn()) {
    log.warn('[FILE-OPS] Move left behind by an interrupted batch finished late', {
      source: path.basename(source)
    });
    return;
  }
  try {
    try {
      await renameNoReplace(movedTo, source);
    } catch (renameError) {
      if (/** @type {any} */ (renameError)?.code !== 'EXDEV') throw renameError;
      await crossDeviceMove(movedTo, source, { verify: true });
    }
    log.warn('[FILE-OPS] Move finished after the batch was stopped; file put back', {
      source: path.basename(source)
    });
  } catch (returnError) {
    // Full paths on purpose: this file is at a place the app has no record
    // of, and the user needs to be able to find it.
    log.error('[FILE-OPS] Move finished after the batch was stopped and could not be put back', {
      source,
      movedTo,
      error: /** @type {any} */ (returnError)?.message
    });
  }
}

/**
 * Whether a cross-device move stopped because the batch's signal aborted. It
 * rejects that way only with the source left in place, so nothing moved.
 * @param {any} error
 * @param {AbortSignal|null} [abortSignal]
 * @returns {boolean}
 */
function isMoveAbortedError(error, abortSignal) {
  return Boolean(abortSignal?.aborted) && error?.name === 'AbortError';
}

/**
 * Whether a failed move means "that name is taken": a raw EEXIST, or the
 * FileSystemError(FILE_EXISTS) crossDeviceMove wraps its publish-time EEXIST in.
 * @param {any} error
 * @returns {boolean}
 */
function isNameTakenError(error) {
  return (
    error?.code === 'EEXIST' ||
    error?.code === 'FILE_EXISTS' ||
    error?.metadata?.originalCode === 'EEXIST'
  );
}

/**
 * @param {string} source
 * @param {string} destination
 * @param {LoggerLike} log
 */
async function renameWithRetry(source, destination, log) {
  let attempt = 0;
  while (true) {
    try {
      // renameNoReplace, not fs.rename: a bare rename silently REPLACES an
      // occupied destination on every platform, so the EEXIST collision walk
      // in performFileMove would never fire and the occupant would be lost.
      await renameNoReplace(source, destination);
      return;
    } catch (error) {
      if (error.code === 'EEXIST' || error.code === 'EXDEV') {
        throw error;
      }
      const isLockError = FILE_LOCK_ERROR_CODES.has(error.code);
      if (!isLockError || attempt >= MOVE_LOCK_MAX_ATTEMPTS - 1) {
        throw error;
      }
      attempt += 1;
      const lockBackoffMs = MOVE_LOCK_BACKOFF_STEP_MS * attempt;
      log.debug('[FILE-OPS] Rename blocked (likely file lock), retrying', {
        source,
        destination,
        attempt,
        maxAttempts: MOVE_LOCK_MAX_ATTEMPTS,
        delayMs: lockBackoffMs,
        code: error.code
      });
      await delay(lockBackoffMs);
    }
  }
}

/**
 * Perform cross-device move with verification
 * Uses the shared crossDeviceMove utility with checksum verification
 * @param {string} source
 * @param {string} destination
 * @param {LoggerLike} log
 * @param {typeof computeFileChecksum} checksumFn
 * @param {AbortSignal|null} [abortSignal] - Stops the move before it publishes
 */
async function performCrossDeviceMove(source, destination, log, checksumFn, abortSignal = null) {
  await crossDeviceMove(source, destination, {
    verify: true,
    checksumFn,
    signal: abortSignal
  });
}

/**
 * UUID-based filename fallback
 * @param {BatchOp} op
 * @param {string} baseName
 * @param {string} ext
 * @param {LoggerLike} log
 * @param {typeof computeFileChecksum} checksumFn
 * @param {AbortSignal|null} [abortSignal]
 */
async function performUUIDFallback(op, baseName, ext, log, checksumFn, abortSignal = null) {
  log.warn(`[FILE-OPS] Falling back to UUID for ${path.basename(op.source)}`);

  const maxPathLength = getEffectiveMaxPathLength();

  for (let i = 0; i < 3; i++) {
    const uuid = crypto.randomUUID().split('-')[0];
    const uniqueDestination = `${baseName}_${uuid}${ext}`;

    if (uniqueDestination.length > maxPathLength) {
      const err = /** @type {NodeJS.ErrnoException} */ (
        new Error(
          `Destination path exceeds platform limit (${uniqueDestination.length} > ${maxPathLength})`
        )
      );
      err.code = 'PATH_TOO_LONG';
      throw err;
    }

    try {
      await renameNoReplace(op.source, uniqueDestination);
      return uniqueDestination;
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      if (error.code === 'EXDEV') {
        try {
          await performCrossDeviceMove(op.source, uniqueDestination, log, checksumFn, abortSignal);
          return uniqueDestination;
        } catch (crossDeviceError) {
          if (isNameTakenError(crossDeviceError)) continue;
          throw crossDeviceError;
        }
      }
      throw error;
    }
  }

  const err = /** @type {NodeJS.ErrnoException} */ (
    new Error('Failed to create unique destination after UUID attempts')
  );
  err.code = 'EUUID_EXHAUSTED';
  throw err;
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
  } catch {
    // Service not available
  }
  return null;
}

/**
 * Resolve the currently configured smart folders so each move can be tagged
 * with its destination category. Returns [] on any failure — the category sync
 * is best-effort; path migration must still succeed when smart folders are
 * unavailable (fresh install, service not yet ready, etc.).
 * @returns {any[]} smart folder objects ({ name, path, ... }) or []
 */
function getSmartFoldersBestEffort() {
  try {
    const { container, ServiceIds } = require('../../services/ServiceContainer');
    if (!container.has(ServiceIds.LEARNING_FEEDBACK)) return [];
    const lfs = container.resolve(ServiceIds.LEARNING_FEEDBACK);
    const folders = lfs?.getSmartFolders?.();
    return Array.isArray(folders) ? folders : [];
  } catch {
    return [];
  }
}

/**
 * The moves this persistence pass still owes an undo entry.
 * The live run records under the batch id itself; resume paths record under
 * ids derived from it (`<id>:p<op>` at startup, `<id>:r<ts>` for a renderer
 * resume) and cover only the moves THEY performed. So an exact undo-id hit
 * means nothing is owed, but otherwise coverage is decided per move against
 * every entry already recorded for the batch: a retry after a crash
 * mid-persistence owes nothing (audit row UR-08), a run resumed after a pause
 * owes the moves it just made, and a startup resume replaying the union of
 * done ops owes only the moves the crashed run never recorded.
 * @template {{ originalPath: string, newPath: string }} T
 * @param {any} undoRedo
 * @param {string|null|undefined} undoBatchId
 * @param {string|null|undefined} liveBatchId
 * @param {T[]} undoOps
 * @returns {Promise<T[]>}
 */
async function undoOpsNotYetRecorded(undoRedo, undoBatchId, liveBatchId, undoOps) {
  if (undoBatchId && (await undoRedo?.hasBatchAction?.(undoBatchId))) return [];
  if (!liveBatchId || liveBatchId === undoBatchId) return undoOps;
  if (typeof undoRedo?.uncoveredBatchOperations !== 'function') return undoOps;
  const uncovered = await undoRedo.uncoveredBatchOperations(liveBatchId, undoOps, {
    includeDerived: true
  });
  return Array.isArray(uncovered) ? uncovered : undoOps;
}

/**
 * Record undo action and update database paths
 * Uses FilePathCoordinator when available for atomic batch updates.
 * Falls back to direct service calls if coordinator is unavailable.
 *
 * @param {{ id?: string, operations: BatchOp[] }} batch
 * @param {Array<Record<string, any>>} results
 * @param {number} successCount
 * @param {string} batchId
 * @param {(() => any)|null|undefined} getServiceIntegration
 * @param {LoggerLike} log
 * @param {AbortSignal|null} _abortSignal
 * @param {Array<Record<string, any>>} [completedOperations]
 * @returns {Promise<{ undoRecorded: boolean, pathIndexUpdated: boolean }>}
 */
async function recordUndoAndUpdateDatabase(
  batch,
  results,
  successCount,
  batchId,
  getServiceIntegration,
  log,
  _abortSignal,
  completedOperations = []
) {
  const meta = { undoRecorded: true, pathIndexUpdated: true };

  // Use completedOperations (not results) so undo matches every disk-changing move:
  // - Order is stable (batch index), so undo reverses in the correct sequence.
  // - Duplicate-merge skips have skipped:true in results but still completed a move.
  /** @param {Array<Record<string, any>>} ops */
  const buildUndoOpsFromCompleted = (ops) =>
    [...ops]
      .filter(
        (c) =>
          c &&
          typeof c.source === 'string' &&
          typeof c.destination === 'string' &&
          c.rollbackAction !== 'restore_duplicate_source' &&
          c.skipped !== true
      )
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((c) => ({
        type: 'move',
        originalPath: c.source,
        newPath: c.destination
      }));

  const undoOps =
    Array.isArray(completedOperations) && completedOperations.length > 0
      ? buildUndoOpsFromCompleted(completedOperations)
      : Array.isArray(results)
        ? [...results]
            .filter((r) => r && r.success && r.source && r.destination && !r.skipped)
            .map((r) => ({
              type: 'move',
              originalPath: r.source,
              newPath: r.destination
            }))
        : [];

  if (undoOps.length > 0) {
    try {
      const svc = typeof getServiceIntegration === 'function' ? getServiceIntegration() : null;
      if (!svc?.undoRedo?.recordAction) {
        meta.undoRecorded = false;
      } else {
        const opsToRecord = await undoOpsNotYetRecorded(svc.undoRedo, batchId, batch?.id, undoOps);
        if (opsToRecord.length === 0) {
          // Resume re-ran persistence after a crash that landed between
          // recordAction and the persistedAt marker: the undo entry already
          // exists, so recording again would double the user's undo step.
          log.info('[FILE-OPS] Undo action already recorded for batch, skipping', {
            batchId,
            liveBatchId: batch?.id
          });
        } else {
          await svc.undoRedo.recordAction(ACTION_TYPES.BATCH_OPERATION, {
            batchId,
            operations: opsToRecord
          });
        }
        meta.undoRecorded = true;
      }
    } catch (error) {
      meta.undoRecorded = false;
      log.warn('[FILE-OPS] Failed to record batch undo action (non-fatal)', {
        batchId,
        error: error?.message || String(error),
        operationCount: undoOps.length
      });
    }
  }

  // Update path-dependent systems for batch moves
  if (successCount > 0) {
    // Resolve smart folders once per batch so each pathChange can be tagged with
    // its destination category. AnalysisHistoryService reads these and refreshes
    // its cached `analysis.category` — without this sync, search results show
    // the original (possibly wrong) LLM verdict even after the user corrected
    // the destination.
    const smartFoldersForBatch = getSmartFoldersBestEffort();
    const { findContainingSmartFolder } = require('../../../shared/folderUtils');
    /** @param {Record<string, any>} change */
    const enrichWithCategory = (change) => {
      if (smartFoldersForBatch.length === 0) return change;
      const folder = findContainingSmartFolder(change.newPath, smartFoldersForBatch);
      if (!folder?.name) return change;
      return {
        ...change,
        newCategory: folder.name,
        newSmartFolder: folder.name,
        ...(typeof folder.path === 'string' ? { newSmartFolderPath: folder.path } : {})
      };
    };
    const pathChanges =
      Array.isArray(completedOperations) && completedOperations.length > 0
        ? [...completedOperations]
            .filter(
              (c) =>
                c &&
                typeof c.source === 'string' &&
                typeof c.destination === 'string' &&
                c.rollbackAction !== 'restore_duplicate_source' &&
                c.skipped !== true
            )
            .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
            .map((c) =>
              enrichWithCategory({
                oldPath: c.source,
                newPath: c.destination
              })
            )
        : results
            .filter((r) => r.success && r.source && r.destination && !r.skipped)
            .map((r) =>
              enrichWithCategory({
                oldPath: r.source,
                newPath: r.destination
              })
            );

    // Try to use FilePathCoordinator for atomic batch updates
    const coordinator = getFilePathCoordinator();
    /** @type {{ success?: boolean, errors?: Array<{ system?: string }>, summary?: any, divergences?: Array<{ filePath?: string, oldCategory?: string|null, newCategory?: string }> } | null} */
    let coordinatorResult = null;
    if (coordinator && pathChanges.length > 0) {
      log.debug('[FILE-OPS] Using FilePathCoordinator for batch path updates', {
        batchId,
        count: pathChanges.length
      });

      try {
        coordinatorResult = await coordinator.batchPathUpdate(pathChanges, { type: 'move' });

        if (!coordinatorResult.success) {
          meta.pathIndexUpdated = false;
          log.warn('[FILE-OPS] FilePathCoordinator batch update had errors', {
            batchId,
            errors: coordinatorResult.errors.map((e) => e.system).join(', ')
          });
        } else {
          meta.pathIndexUpdated = true;
          log.debug('[FILE-OPS] FilePathCoordinator batch update complete', {
            batchId,
            summary: coordinatorResult.summary
          });
        }
      } catch (coordError) {
        meta.pathIndexUpdated = false;
        log.warn('[FILE-OPS] FilePathCoordinator batch update failed', {
          batchId,
          error: coordError.message
        });
        // Fallback removed: FilePathCoordinator is the single source of truth.
        // If it fails, we log the error but do not attempt divergent updates.
      }
    } else if (pathChanges.length > 0) {
      // Coordinator unavailable
      meta.pathIndexUpdated = false;
      log.warn('[FILE-OPS] FilePathCoordinator unavailable for batch path updates', {
        batchId
      });
    }

    // Record learning feedback for smart-folder destinations. This teaches the
    // routing model from confirmed organize decisions — including the corrections
    // surfaced by the coordinator's `divergences` (LLM said X, user/destination
    // said Y). Best-effort: a learning failure must never block file operations.
    if (
      coordinatorResult?.success &&
      meta.pathIndexUpdated &&
      Array.isArray(pathChanges) &&
      pathChanges.length > 0
    ) {
      try {
        const {
          getInstance: getLearningFeedbackService,
          FEEDBACK_SOURCES
        } = require('../../services/organization/learningFeedback');
        const learningService = getLearningFeedbackService();
        if (learningService) {
          const FolderMatchingService = require('../../services/FolderMatchingService');
          const { isDefaultCategoryName } = require('../../../shared/categoryFolderMatching');
          const divergencesByPath = new Map(
            (coordinatorResult.divergences || []).map((d) => [d.filePath, d])
          );
          // What the app suggested for each file (Organize sends it per op).
          // Keyed by where the file landed, like the divergences above.
          /** @type {Map<string, { folder: string }>} */
          const suggestionsByNewPath = new Map();
          for (const c of Array.isArray(completedOperations) ? completedOperations : []) {
            const suggested = batch?.operations?.[c?.index]?.suggestion;
            if (typeof c?.destination === 'string' && typeof suggested?.folder === 'string') {
              suggestionsByNewPath.set(c.destination, suggested);
            }
          }
          let learned = 0;
          let corrected = 0;
          for (const change of pathChanges) {
            if (!change.newSmartFolder) continue; // Only smart-folder destinations
            try {
              // Learn "files the analysis called X go to this folder". The
              // analysis label is the divergence's oldCategory when it differed
              // from the destination; otherwise the two agree. Passing no
              // category stored every pattern as `<ext>:unknown:<folder>`,
              // which never matched an analyzed file.
              const divergenceForFile = divergencesByPath.get(change.newPath);
              const learnedCategory = divergenceForFile?.oldCategory || change.newCategory || null;
              const recorded = await learningService.recordFileMove(
                change.oldPath,
                change.newPath,
                learnedCategory ? { category: learnedCategory } : null,
                FEEDBACK_SOURCES.AUTO_ORGANIZE_CONFIRMED
              );
              if (recorded) learned++;

              // Corrective signal: penalize the folder the app would have picked
              // when the file landed somewhere else, so similar files stop
              // routing there. The positive signal for the correct folder is
              // recorded by recordFileMove above.
              //
              // When the op carries the app's suggestion, that suggestion is the
              // reference: a correction only when the user sent the file
              // elsewhere. Accepting it records nothing more, even if the LLM's
              // label named another folder, since the user overrode nothing.
              const divergence = divergencesByPath.get(change.newPath);
              const suggested = suggestionsByNewPath.get(change.newPath);
              if (suggested) {
                const wrongFolder = String(suggested.folder).trim();
                if (
                  wrongFolder &&
                  !isDefaultCategoryName(wrongFolder) &&
                  wrongFolder.toLowerCase() !== String(change.newSmartFolder).toLowerCase()
                ) {
                  const didCorrect = await learningService.recordCorrection({
                    filePath: change.newPath,
                    wrongFolder,
                    correctFolder: change.newSmartFolder,
                    oldCategory: divergence?.oldCategory || null
                  });
                  if (didCorrect) corrected++;
                }
              } else if (divergence?.oldCategory && smartFoldersForBatch.length > 0) {
                const wrongFolder = FolderMatchingService.matchCategoryToFolder(
                  divergence.oldCategory,
                  smartFoldersForBatch
                );
                if (
                  wrongFolder &&
                  !isDefaultCategoryName(wrongFolder) &&
                  wrongFolder.toLowerCase() !== String(change.newSmartFolder).toLowerCase()
                ) {
                  const didCorrect = await learningService.recordCorrection({
                    filePath: change.newPath,
                    wrongFolder,
                    correctFolder: change.newSmartFolder,
                    oldCategory: divergence.oldCategory
                  });
                  if (didCorrect) corrected++;
                }
              }
            } catch (perItemErr) {
              log.debug('[FILE-OPS] Per-item learning feedback failed (non-fatal)', {
                file: change.newPath,
                error: perItemErr.message
              });
            }
          }
          if (learned > 0 || divergencesByPath.size > 0) {
            log.info('[FILE-OPS] Recorded organize learning feedback', {
              batchId,
              learned,
              corrected,
              categoryCorrections: divergencesByPath.size
            });
          }
        }
      } catch (learnErr) {
        log.debug('[FILE-OPS] Learning feedback recording failed (non-fatal)', {
          batchId,
          error: learnErr.message
        });
      }
    }

    // Embedding path updates are handled by FilePathCoordinator.batchPathUpdate above.
    // A redundant syncEmbeddingForMove loop was removed here to prevent dual writes
    // that could race with the coordinator and leave embeddings in inconsistent state.

    // This ensures search results show new paths immediately (not after 15 min)
    if (successCount > 0) {
      try {
        const { getSearchServiceInstance } = require('../semantic');
        const searchService = getSearchServiceInstance?.();
        if (searchService?.invalidateAndRebuild) {
          const rebuildPromise = searchService.invalidateAndRebuild({
            immediate: true,
            reason: 'batch-organize'
          });

          // Wait for rebuild but with timeout to prevent blocking UI
          await /** @type {Promise<any>} */ (
            withTimeout(rebuildPromise, TIMEOUTS.SEARCH_INDEX_REBUILD, 'BM25 rebuild after batch')
          ).catch((rebuildErr) => {
            log.warn('[FILE-OPS] BM25 rebuild failed or timed out after batch', {
              error: rebuildErr?.message,
              batchId
            });
          });
        }
      } catch (invalidateErr) {
        log.warn('[FILE-OPS] Failed to trigger search index rebuild after batch', {
          error: invalidateErr.message,
          batchId
        });
      }
    }
  }

  log.debug('[FILE-OPS] Undo/DB update complete', {
    batchId,
    successCount,
    updatedPaths:
      Array.isArray(completedOperations) && completedOperations.length > 0
        ? completedOperations.length
        : results.filter((r) => r.success && r.source && r.destination).length
  });
  return meta;
}

/**
 * fs.access wrapper that returns true/false instead of throwing. Used by
 * previewBatchOrganize to walk the collision-resolution algorithm without
 * littering the loop body with try/catch.
 * @param {string} p
 * @private
 */
async function pathExistsSilent(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Dry-run preview for a batch-organize operation.
 *
 * Returns the plan that handleBatchOrganize WOULD execute — including
 * collision resolution (numeric suffixes for existing destinations) and
 * the set of folders that would be created — without acquiring the batch
 * lock, writing to the processing-state journal, or touching disk.
 *
 * Concurrency-safe: previewing while a real batch is in flight is fine
 * because the preview only reads. If a destination becomes occupied
 * between preview and commit, the real batch will resolve the new
 * collision at execute time — preview is a best-effort plan, not a
 * binding contract.
 *
 * @param {Object} params
 * @param {BatchOrganizeOperation} params.operation - Same shape handleBatchOrganize expects.
 *   Must contain `operations: [{ source, destination }]`.
 * @param {LoggerLike} [params.log] - Logger.
 * @returns {Promise<Record<string, any>>} Plan including wouldMove, skipped (e.g. for
 *   missing sources), conflicts count, and wouldCreateFolders.
 */
async function previewBatchOrganize({ operation, log }) {
  const ops = Array.isArray(operation?.operations) ? operation.operations : [];
  const wouldMove = [];
  const skipped = [];
  const wouldCreateFolders = new Set();
  let conflicts = 0;

  // The numeric-suffix collision resolver is normally driven by repeated
  // fs.rename + EEXIST retries. For preview we walk the same algorithm
  // using fs.access — same shape of result, no side effects.
  for (const op of ops) {
    if (!op?.source || !op?.destination) {
      skipped.push({
        source: op?.source || null,
        destination: op?.destination || null,
        reason: 'invalid-operation'
      });
      continue;
    }

    if (!(await pathExistsSilent(op.source))) {
      skipped.push({
        source: op.source,
        destination: op.destination,
        reason: 'source-missing'
      });
      continue;
    }

    const destDir = path.dirname(op.destination);
    if (!(await pathExistsSilent(destDir))) {
      wouldCreateFolders.add(destDir);
    }

    // Collision resolution: walk the same numeric-suffix algorithm the real
    // executor uses (formatNumberedCollisionCandidate), bounded at
    // PREVIEW_MAX_NUMERIC_ATTEMPTS so the preview stays snappy even when the
    // destination directory is densely packed. The real executor still
    // walks up to MAX_NUMERIC_RETRIES on collision before UUID-fallback.
    //
    // A file that is already at its destination (same path, or the same name
    // in another case where the filesystem ignores case) occupies that path
    // itself, so the executor's move does not collide with anything.
    let finalDestination = op.destination;
    let collision = false;
    const alreadyAtDestination =
      _canonicalizeForOverlapCheck(op.source) === _canonicalizeForOverlapCheck(op.destination);
    if (!alreadyAtDestination && (await pathExistsSilent(op.destination))) {
      collision = true;
      conflicts += 1;
      const ext = path.extname(op.destination);
      const baseName = ext.length > 0 ? op.destination.slice(0, -ext.length) : op.destination;
      let resolved = false;
      for (let i = 1; i <= PREVIEW_MAX_NUMERIC_ATTEMPTS; i += 1) {
        const candidate = formatNumberedCollisionCandidate(op.destination, i);
        if (!(await pathExistsSilent(candidate))) {
          finalDestination = candidate;
          resolved = true;
          break;
        }
      }
      if (!resolved) {
        // Match the real handler's UUID fallback shape so the preview's
        // suggested destination is reachable for the UI to display. We
        // can't reproduce the exact random UUID — flag the placeholder so
        // the renderer can render a warning chip.
        finalDestination = `${baseName}_uuid${ext}`;
        if (log?.warn) {
          log.warn('[FILE-OPS] Preview: numeric suffixes exhausted, would fall back to UUID', {
            destination: op.destination
          });
        }
      }
    }

    wouldMove.push({
      source: op.source,
      destination: finalDestination,
      originalDestination: op.destination,
      collision
    });
  }

  return {
    success: true,
    dryRun: true,
    total: ops.length,
    wouldMove,
    skipped,
    wouldCreateFolders: Array.from(wouldCreateFolders),
    conflicts
  };
}

module.exports = {
  handleBatchOrganize,
  previewBatchOrganize,
  computeFileChecksum,
  performFileMove,
  formatNumberedCollisionCandidate,
  recordUndoAndUpdateDatabase,
  isCriticalFileError,
  MAX_BATCH_SIZE,
  MAX_TOTAL_BATCH_TIME,
  PREVIEW_MAX_NUMERIC_ATTEMPTS
};
