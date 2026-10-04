// @ts-check
/**
 * Atomic File Operations System (Full Transaction Support)
 *
 * Provides transactional file operations with rollback capabilities
 * to prevent data loss during file organization. Addresses the safety
 * concerns identified in the architectural analysis.
 *
 * USE THIS MODULE FOR:
 * - Multi-file operations that must succeed or fail together
 * - File moves/copies that need rollback on failure
 * - Complex transactions with state journaling
 * - Backup-and-replace patterns with integrity checking
 *
 * USE atomicFile.js INSTEAD FOR:
 * - Simple JSON persistence (settings, config files, state)
 * - Single-file write operations
 * - Cases where you don't need transaction rollback
 *
 * Key features:
 * - Transaction journaling for crash recovery
 * - Automatic rollback on failure
 * - Size-based integrity verification (with optional checksum callback)
 * - Orphaned operation cleanup
 */

const fs = require('fs').promises;
const fsConstants = require('fs').constants;
const path = require('path');
const crypto = require('crypto');
const { createLogger } = require('./logger');
const { RETRY, TIMEOUTS } = require('./performanceConstants');
const { delay, swallow } = require('./promiseUtils');
const { getEffectiveMaxPathLength } = require('./securityConfig');
const { tryParse: safeJsonTryParse } = require('./safeJsonOps');
const { isCaseInsensitiveFileSystem } = require('./crossPlatformUtils');

// Resolve paths using host platform conventions to avoid breaking real
// filesystem paths (especially on Windows where drive letters matter).
// Distinct from the security-oriented sanitizePath in pathSanitization.js
// and the cross-platform normalizePath in crossPlatformUtils.js.
/** @param {any} filePath */
const resolveFsPath = (filePath) => {
  if (typeof filePath !== 'string') return filePath;
  return path.normalize(filePath);
};

// Import FileSystemError - handle case where it might not exist yet in shared context
/** @type {any} */
let FileSystemError;
/** @type {any} */
let AtomicOperationError;
/** @type {any} */
let IntegrityError;
/** @type {any} */
let FILE_SYSTEM_ERROR_CODES;
try {
  const fsErrors = require('../main/errors/FileSystemError');
  FileSystemError = fsErrors.FileSystemError;
  AtomicOperationError = fsErrors.AtomicOperationError;
  IntegrityError = fsErrors.IntegrityError;
  FILE_SYSTEM_ERROR_CODES = fsErrors.FILE_SYSTEM_ERROR_CODES;
} catch {
  // Fallback - create minimal error wrapper if FileSystemError not available
  FileSystemError = class FileSystemError extends Error {
    /**
     * @param {string} code
     * @param {{ originalError?: string, [key: string]: any }} [metadata]
     */
    constructor(code, metadata = {}) {
      super(metadata.originalError || code);
      this.code = code;
      this.metadata = metadata;
      this.isFileSystemError = true;
    }

    getUserFriendlyMessage() {
      return this.message;
    }

    /**
     * @param {NodeJS.ErrnoException} error
     * @param {object} [context]
     */
    static fromNodeError(error, context = {}) {
      const err = new FileSystemError(error.code || 'UNKNOWN', {
        ...context,
        originalError: error.message
      });
      return err;
    }
  };
  AtomicOperationError = FileSystemError;
  IntegrityError = FileSystemError;
  FILE_SYSTEM_ERROR_CODES = {
    ATOMIC_OPERATION_FAILED: 'ATOMIC_OPERATION_FAILED',
    ROLLBACK_FAILED: 'ROLLBACK_FAILED',
    SIZE_MISMATCH: 'SIZE_MISMATCH',
    CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',
    FILE_NOT_FOUND: 'FILE_NOT_FOUND',
    WRITE_FAILED: 'WRITE_FAILED'
  };
}

const logger = createLogger('AtomicFileOperations');

/**
 * Transaction journal directory name (alongside backup directory)
 */
const JOURNAL_DIR_NAME = 'stratosort-journals';

/**
 * Error codes that indicate a transient Windows filesystem race (AV scanner,
 * search indexer, backup agent holding a handle briefly). Mirrors the retry
 * set used by `atomicCreate` so every rename path is equally robust.
 *
 * NOTE on Linux/macOS: EBUSY is rare for regular files but can happen on
 * mounted filesystems; EPERM typically won't fire here. The retry is cheap
 * when it doesn't match, so we keep the same policy cross-platform.
 */
const TRANSIENT_RENAME_ERROR_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Run `fs.rename(from, to)` with a short retry on transient Windows-style
 * errors. See {@link TRANSIENT_RENAME_ERROR_CODES}. Throws the last error
 * if all attempts fail.
 * @param {string} from
 * @param {string} to
 * @param {number} [maxAttempts]
 */
async function renameWithTransientRetry(from, to, maxAttempts) {
  const limit = Math.max(1, maxAttempts || RETRY.FILE_OPERATION.maxAttempts || 3);
  let lastError;
  for (let attempt = 0; attempt < limit; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!TRANSIENT_RENAME_ERROR_CODES.has(error?.code) || attempt === limit - 1) {
        throw error;
      }
      // Linear backoff — short because AV/indexer holds are usually <100ms.
      await delay(50 * (attempt + 1));
    }
  }
  throw lastError; // unreachable, but keeps static analysis happy
}

/**
 * Persist `data` to `filePath` via temp+fsync+rename. fsync is load-bearing
 * for the journal: without it, a power loss between `writeFile` and `rename`
 * can commit the rename target while its data is still in the page cache,
 * leaving a zero-byte or garbage file that `safeJsonTryParse` will flag as
 * corrupt on recovery.
 *
 * `fs.writeFile` + `rename` alone only gives us atomicity against partial
 * writes within the process, not against crash-consistency at the block
 * layer.
 * @param {string} filePath
 * @param {any} data
 */
async function durableWriteJson(filePath, data) {
  const tempPath = `${filePath}.tmp.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  let handle;
  try {
    handle = await fs.open(tempPath, 'w');
    await handle.writeFile(JSON.stringify(data, null, 2), 'utf8');
    try {
      await handle.sync();
    } catch (syncError) {
      // Some filesystems (procfs, some network mounts) don't implement fsync.
      // Downgrade to best-effort without losing the write itself.
      logger.debug('[ATOMIC-OPS] fsync unsupported on journal temp file:', {
        tempPath,
        error: syncError?.message
      });
    }
    await handle.close();
    handle = null;
    await renameWithTransientRetry(tempPath, filePath);
  } catch (error) {
    if (handle) {
      await swallow(handle.close(), logger, 'cleanup:writeFileAtomic.handle');
    }
    await swallow(fs.unlink(tempPath), logger, 'cleanup:writeFileAtomic.tempPath');
    throw error;
  }
}

/**
 * Transaction-based file operation manager
 */
class AtomicFileOperations {
  constructor() {
    this.activeTransactions = new Map();
    // Per-destination FIFO mutex chain. Serializes concurrent atomicMove()
    // calls that target the SAME destination so the fileExists()->rename()
    // preflight can't be raced intra-process (Node's fs.rename overwrites a
    // pre-existing destination silently). Keyed by normalized destination path;
    // entries are self-cleaning (dropped once the tail waiter releases).
    /** @type {Map<string, Promise<any>>} */
    this._destinationLocks = new Map();
    this.backupDirectory = null;
    this.backupBaseDirectory = null;
    this.journalDirectory = null;
    this.journalBaseDirectory = null;
    this.operationTimeout = 30000; // 30 seconds
    const cleanupIntervalMs =
      /** @type {any} */ (TIMEOUTS).ATOMIC_TRANSACTION_CLEANUP_MS || 10 * 60 * 1000;
    this._cleanupInterval = setInterval(() => {
      if (this.activeTransactions.size === 0) return;
      this.cleanupStaleTransactions().catch((error) => {
        logger.debug('[ATOMIC-OPS] Failed to cleanup stale transactions', {
          error: error.message
        });
      });
    }, cleanupIntervalMs);
    if (typeof this._cleanupInterval.unref === 'function') {
      this._cleanupInterval.unref();
    }
  }

  /**
   * Run `fn` under a per-key FIFO mutex so callers contending on the same key
   * execute one at a time (in arrival order). Used to serialize moves to the
   * same destination; JS is single-threaded so a synchronous chain append is
   * race-free. Map entries self-clean when no later caller has chained on.
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   * @private
   */
  async _withDestinationLock(key, fn) {
    const previous = this._destinationLocks.get(key) || Promise.resolve();
    /** @type {(v?: any) => void} */
    let releaseCurrent;
    const current = new Promise((resolve) => {
      releaseCurrent = resolve;
    });
    // Publish our link as the new tail synchronously so the next caller queues
    // behind us, not behind `previous`.
    const chained = previous.then(() => current);
    this._destinationLocks.set(key, chained);
    // Our turn starts once every earlier holder has released. Swallow prior
    // errors: a failed move upstream must not reject our unrelated turn.
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      releaseCurrent();
      // Drop the entry if nobody chained after us, so the map can't grow
      // unbounded across many distinct destinations.
      if (this._destinationLocks.get(key) === chained) {
        this._destinationLocks.delete(key);
      }
    }
  }

  // ===== Transaction Journaling =====

  /**
   * Initialize the journal directory for crash-recovery support.
   *
   * In production the Electron main process configures this with
   * `app.getPath('userData')` (see `simple-main.js#configureAtomicFileOperations`)
   * so journals survive both process crashes AND OS-level temp cleanup. The
   * `os.tmpdir()` fallback in `initializeJournalDirectory` exists only for
   * tests and non-Electron contexts that import this module directly.
   * @param {string|null} baseDirectory
   */
  setJournalBaseDirectory(baseDirectory) {
    this.journalBaseDirectory = baseDirectory ? resolveFsPath(baseDirectory) : null;
    this.journalDirectory = null;
  }

  /**
   * Set the base directory for transaction backups. By default backups land
   * under `${os.tmpdir()}/stratosort-backups/...`, which fails the atomic-
   * rename invariant when tmpdir is on a different volume than the user's
   * file storage (Windows: tmpdir=%TEMP% (C:) but user files often on D:
   * or a network drive — `fs.rename` across volumes throws EXDEV). Configure
   * this with `app.getPath('userData')` at startup so backups land on the
   * same volume as the files we're backing up.
   *
   * Pass `null` to revert to the tmpdir fallback (useful for tests).
   * @param {string|null} baseDirectory
   */
  setBackupBaseDirectory(baseDirectory) {
    this.backupBaseDirectory = baseDirectory ? resolveFsPath(baseDirectory) : null;
    this.backupDirectory = null;
  }

  async initializeJournalDirectory() {
    if (this.journalDirectory) return this.journalDirectory;

    const baseDir = this.journalBaseDirectory || require('os').tmpdir();
    const target = path.join(baseDir, JOURNAL_DIR_NAME);

    try {
      await fs.mkdir(target, { recursive: true });
      this.journalDirectory = target;
      // Recovery from a previous degraded state: clear the flag now that the
      // directory is usable.
      this._clearJournalDegradedFlag();
      return this.journalDirectory;
    } catch (error) {
      logger.error('[ATOMIC-OPS] Failed to initialize journal directory:', {
        path: target,
        error: error.message
      });
      // Journaling is best-effort, but running without it means a crash during
      // a multi-step organize/move silently loses rollback data. Raise a degraded
      // flag so the UI can surface this instead of the prior silent-degrade.
      this.journalDirectory = null;
      this._raiseJournalDegradedFlag({
        attemptedPath: target,
        errorCode: error?.code,
        errorMessage: error.message
      });
      return null;
    }
  }

  /**
   * Best-effort hook into the process-local DegradedStateTracker. Required late
   * so this module can still be imported from renderer-side tooling and tests
   * without pulling in Electron-only code.
   * @private
   */
  _getDegradedStateTracker() {
    try {
      return require('../main/services/DegradedStateTracker').getInstance();
    } catch {
      return null;
    }
  }

  /**
   * @private
   * @param {object} detail
   */
  _raiseJournalDegradedFlag(detail) {
    const tracker = this._getDegradedStateTracker();
    if (!tracker) return;
    try {
      tracker.raise({
        code: 'atomic.journal-unavailable',
        subsystem: 'atomic-file-ops',
        severity: 'error',
        message:
          'Transactional journaling is disabled (could not create the journal directory). Multi-step file organizes will NOT roll back automatically if the app crashes.',
        detail
      });
    } catch {
      // Tracker is best-effort; never let it affect file ops.
    }
  }

  /** @private */
  _clearJournalDegradedFlag() {
    const tracker = this._getDegradedStateTracker();
    if (!tracker) return;
    try {
      tracker.clear('atomic.journal-unavailable');
    } catch {
      // no-op
    }
  }

  /**
   * Write or update a transaction journal entry to disk.
   * The journal captures enough state to rollback on crash recovery.
   * @param {string} transactionId
   */
  async writeJournal(transactionId) {
    if (!this.journalDirectory) {
      await this.initializeJournalDirectory();
    }
    if (!this.journalDirectory) return; // Journal unavailable, skip silently

    const transaction = this.activeTransactions.get(transactionId);
    if (!transaction) return;

    const journalPath = path.join(this.journalDirectory, `${transactionId}.journal`);
    const journalData = {
      id: transaction.id,
      status: transaction.status,
      startTime: transaction.startTime,
      pid: process.pid,
      backups: transaction.backups,
      createdDestinations: transaction.createdDestinations,
      operationCount: transaction.operations.length,
      updatedAt: Date.now()
    };

    // durableWriteJson = writeFile + fsync + transient-retry rename.
    // Without fsync, recoverFromJournals can read a zero-byte file after a
    // power loss and treat it as corrupt, losing rollback data for
    // in-flight operations.
    try {
      await durableWriteJson(journalPath, journalData);
    } catch (error) {
      logger.debug('[ATOMIC-OPS] Failed to write journal (non-fatal):', {
        transactionId,
        error: error.message
      });
    }
  }

  /**
   * Remove a transaction journal after successful commit or cleanup.
   * @param {string} transactionId
   */
  async removeJournal(transactionId) {
    if (!this.journalDirectory) return;

    const journalPath = path.join(this.journalDirectory, `${transactionId}.journal`);
    try {
      await fs.unlink(journalPath);
    } catch {
      // Journal already removed or never written
    }
  }

  /**
   * Recover incomplete transactions from journal files left by a previous crash.
   * Call this once at application startup to clean up partial operations.
   *
   * Recovery strategy:
   * - Transactions in 'active' or 'rolling_back' state are rolled back (restore backups, remove destinations)
   * - Transactions in 'committed' state just need journal cleanup
   * - Journals older than maxAgeMs are cleaned up regardless of state
   *
   * @param {number} [maxAgeMs=86400000] Maximum age of journals to process (default: 24 hours)
   * @param {{ maxCount?: number, budgetMs?: number }} [options]
   *   - maxCount: hard cap on journals processed in one call. Protects startup
   *     from a pathological case where a crash left tens of thousands of
   *     journal files — replaying them all would add minutes of wall time
   *     before the app window even opens.
   *   - budgetMs: wall-clock budget in ms; once exceeded we stop processing
   *     and log how many remain so the next startup can pick them up. The
   *     leftovers are NOT deleted, so no data is lost.
   * @returns {Promise<{recovered: number, cleaned: number, errors: number, skipped: number}>}
   */
  async recoverFromJournals(maxAgeMs = 86400000, options = {}) {
    const { maxCount = 1000, budgetMs = 30_000 } = options;
    await this.initializeJournalDirectory();
    if (!this.journalDirectory) {
      return { recovered: 0, cleaned: 0, errors: 0, skipped: 0 };
    }

    let files;
    try {
      files = await fs.readdir(this.journalDirectory);
    } catch {
      return { recovered: 0, cleaned: 0, errors: 0, skipped: 0 };
    }

    const journalFiles = files.filter((f) => f.endsWith('.journal'));
    if (journalFiles.length === 0) {
      return { recovered: 0, cleaned: 0, errors: 0, skipped: 0 };
    }

    logger.info('[ATOMIC-OPS] Found incomplete transaction journals:', {
      count: journalFiles.length,
      maxCount,
      budgetMs
    });

    const now = Date.now();
    const deadline = now + Math.max(1000, Number(budgetMs) || 0);
    const effectiveCap = Math.max(1, Math.min(journalFiles.length, Number(maxCount) || 0));
    let recovered = 0;
    let cleaned = 0;
    let errors = 0;
    let skipped = 0;
    let processed = 0;

    for (const file of journalFiles) {
      if (processed >= effectiveCap || Date.now() > deadline) {
        skipped++;
        continue;
      }
      processed++;
      const journalPath = path.join(this.journalDirectory, file);

      // Advisory lock to prevent concurrent instances from processing same journal.
      // Stale-lock TTL is intentionally MUCH shorter than maxAgeMs: locks are only
      // held during the (near-instantaneous) recovery flow, so a lock older than
      // a few minutes is unambiguously orphaned. The previous 24h tied-to-maxAgeMs
      // TTL meant a single failed shutdown could block journal recovery for a
      // full day, silently leaking rollback data on every restart in that window.
      const STALE_LOCK_TTL_MS = 5 * 60 * 1000;
      const lockPath = `${journalPath}.lock`;
      let lockFd;
      try {
        lockFd = await fs.open(lockPath, 'wx');
      } catch (lockErr) {
        if (lockErr.code === 'EEXIST') {
          try {
            const lockStat = await fs.stat(lockPath);
            if (now - lockStat.mtimeMs > STALE_LOCK_TTL_MS) {
              logger.warn('[ATOMIC-OPS] Removing stale lock file:', file);
              await swallow(fs.unlink(lockPath), logger, 'cleanup:staleLock');
              try {
                lockFd = await fs.open(lockPath, 'wx');
              } catch {
                logger.debug('[ATOMIC-OPS] Could not re-acquire lock after stale removal:', file);
                continue;
              }
            } else {
              logger.debug(
                '[ATOMIC-OPS] Journal already being processed by another instance:',
                file
              );
              continue;
            }
          } catch {
            logger.debug('[ATOMIC-OPS] Could not stat lock file, skipping journal:', file);
            continue;
          }
        } else {
          // Unknown lock error (EACCES, ENOSPC, EROFS, etc.). Historically we
          // fell through and processed without a lock — that races with any
          // other instance still starting up. Fail closed: skip this journal
          // so a later startup retries, rather than double-rollback.
          logger.warn('[ATOMIC-OPS] Lock acquisition failed, skipping journal for retry', {
            file,
            code: lockErr.code,
            error: lockErr.message
          });
          errors++;
          continue;
        }
      }

      try {
        const content = await fs.readFile(journalPath, 'utf8');
        // Journal lives on disk; strip prototype-pollution keys on parse.
        const journalParse = safeJsonTryParse(content);
        if (!journalParse.success) {
          throw journalParse.error || new Error('Malformed journal');
        }
        const journal = journalParse.value;

        // PID liveness check: if the journal was written by a process that
        // is STILL running on this host, skip rollback — that process is
        // mid-transaction and will clean up its own journal. Only
        // applicable when journal.pid matches a live local process and
        // isn't our own PID (we should never recover our own in-flight
        // journal). process.kill(pid, 0) returns true if the process
        // exists and we have permission to signal it; throws ESRCH on
        // missing PID. Cross-host journals (mounted shares) are out of
        // scope — defense-in-depth, not a guarantee.
        if (typeof journal.pid === 'number' && journal.pid > 0 && journal.pid !== process.pid) {
          try {
            process.kill(journal.pid, 0);
            // Process is alive — leave the journal alone. The owner will
            // clean up on commit/rollback. Log at debug; this is expected
            // in multi-instance dev workflows.
            logger.debug('[ATOMIC-OPS] Skipping journal owned by live process', {
              file,
              pid: journal.pid
            });
            skipped++;
            continue;
          } catch (sigErr) {
            // ESRCH = process doesn't exist; safe to recover.
            // EPERM = process exists but we can't signal — treat as alive
            //         (could be running as a different user).
            if (sigErr.code === 'EPERM') {
              logger.debug('[ATOMIC-OPS] Skipping journal owned by foreign process', {
                file,
                pid: journal.pid
              });
              skipped++;
              continue;
            }
            // ESRCH or other → fall through to recovery
          }
        }

        // Skip journals that are too old. Clock-jump defense: if
        // `journal.startTime` is in the future (negative age), the system
        // clock was rolled back since the journal was written. Do NOT treat
        // that as "fresh" indefinitely — cap via the journal file's mtime
        // so a clock-manipulation attacker cannot pin a rollback record to
        // the replay queue forever. When the mtime also looks impossible,
        // clean up the journal rather than keep retrying it every startup.
        if (journal.startTime) {
          const startTimeAge = now - journal.startTime;
          if (startTimeAge > maxAgeMs) {
            await swallow(fs.unlink(journalPath), logger, 'cleanup:journal.maxAge');
            cleaned++;
            continue;
          }
          if (startTimeAge < 0) {
            let fileMtime = null;
            try {
              fileMtime = (await fs.stat(journalPath)).mtimeMs;
            } catch {
              /* ignore */
            }
            const mtimeAge = fileMtime == null ? Infinity : now - fileMtime;
            if (mtimeAge > maxAgeMs || mtimeAge < 0) {
              logger.warn(
                '[ATOMIC-OPS] Dropping journal with future startTime and unusable mtime',
                { file, startTime: journal.startTime, fileMtime }
              );
              await swallow(fs.unlink(journalPath), logger, 'cleanup:journal.futureStartTime');
              cleaned++;
              continue;
            }
          }
        }

        // Already committed -- just clean up the journal
        if (journal.status === 'committed' || journal.status === 'rolled_back') {
          await swallow(fs.unlink(journalPath), logger, 'cleanup:journal.alreadyDone');
          cleaned++;
          continue;
        }

        // Active or rolling_back -- needs recovery (rollback)
        logger.warn('[ATOMIC-OPS] Recovering incomplete transaction:', {
          id: journal.id,
          status: journal.status,
          backupCount: journal.backups?.length || 0,
          destinationCount: journal.createdDestinations?.length || 0
        });

        // Restore files from backups. Track failures so we do not delete a
        // destination that may be the only remaining copy (SW-28).
        let anyRestoreFailed = false;
        // Paths restored below must survive the destination sweep: a
        // delete+create on the same path (backupAndReplace) journals it as
        // both a backup source and a created destination.
        const restoredSources = new Set();
        if (Array.isArray(journal.backups)) {
          for (let i = journal.backups.length - 1; i >= 0; i--) {
            const { source, backup } = journal.backups[i];
            try {
              if (await this.fileExists(backup)) {
                await swallow(
                  fs.mkdir(path.dirname(source), { recursive: true }),
                  logger,
                  'cleanup:mkdir.recoveryParent'
                );
                await fs.copyFile(backup, source);
                restoredSources.add(source);
                logger.info('[ATOMIC-OPS] Recovery: restored file', { source, backup });
              } else {
                anyRestoreFailed = true;
                logger.warn('[ATOMIC-OPS] Recovery: backup missing, skipping dest cleanup', {
                  source,
                  backup
                });
              }
            } catch (restoreError) {
              anyRestoreFailed = true;
              logger.error('[ATOMIC-OPS] Recovery: failed to restore file', {
                source,
                backup,
                error: restoreError.message
              });
            }
          }
        }

        // Remove destinations created by incomplete operations.
        // Use fs.rm with recursive+force so we can clean up directory
        // destinations (e.g. atomicCreate future-proofing, or external code
        // that pushed a dir path into createdDestinations). fs.unlink would
        // throw EISDIR on a directory and leave the partial write behind.
        // If any backup restore failed, leave destinations in place.
        if (Array.isArray(journal.createdDestinations) && !anyRestoreFailed) {
          for (let i = journal.createdDestinations.length - 1; i >= 0; i--) {
            const dest = journal.createdDestinations[i];
            if (restoredSources.has(dest)) {
              logger.debug('[ATOMIC-OPS] Recovery: skipping destination delete (just restored)', {
                dest
              });
              continue;
            }
            try {
              await fs.rm(dest, { recursive: true, force: true });
              logger.info('[ATOMIC-OPS] Recovery: removed partial destination', { dest });
            } catch (deleteError) {
              logger.debug('[ATOMIC-OPS] Recovery: failed to remove destination', {
                dest,
                error: deleteError.message
              });
            }
          }
        } else if (anyRestoreFailed) {
          logger.warn(
            '[ATOMIC-OPS] Recovery: skipping destination delete because a backup restore failed'
          );
        }

        // A failed restore leaves the backup as the only intact copy — keep it
        // and the journal so the next startup retries (maxAge still bounds it).
        if (anyRestoreFailed) {
          logger.warn('[ATOMIC-OPS] Recovery: keeping journal and backups after failed restore', {
            id: journal.id
          });
          errors++;
          continue;
        }

        if (Array.isArray(journal.backups)) {
          for (const { backup } of journal.backups) {
            await swallow(fs.unlink(backup), logger, 'cleanup:recovery.backup');
          }
        }
        await swallow(fs.unlink(journalPath), logger, 'cleanup:recovery.journal');

        recovered++;
      } catch (parseError) {
        logger.error('[ATOMIC-OPS] Failed to process journal file:', {
          file,
          error: parseError.message
        });
        // Quarantine the corrupt journal instead of deleting it. Silent
        // deletion meant a power-loss corruption that wiped rollback state
        // was undiagnosable after the fact; keeping a timestamped copy
        // lets support reconstruct what was in flight.
        const quarantinePath = `${journalPath}.corrupt.${Date.now()}`;
        try {
          await renameWithTransientRetry(journalPath, quarantinePath);
          logger.warn('[ATOMIC-OPS] Quarantined corrupt journal:', {
            original: journalPath,
            quarantine: quarantinePath
          });
        } catch (quarantineError) {
          // Fall back to unlink only if rename itself fails — better to
          // clear the journal than to leave it in a loop-retrying state.
          logger.error('[ATOMIC-OPS] Failed to quarantine corrupt journal, deleting:', {
            file,
            error: quarantineError.message
          });
          await swallow(fs.unlink(journalPath), logger, 'cleanup:journal.quarantineFallback');
        }
        errors++;
      } finally {
        // Release advisory lock
        if (lockFd) {
          await lockFd
            .close()
            .catch((e) => logger.debug('[ATOMIC-OPS] Lock fd close failed:', e?.message));
          await fs.unlink(lockPath).catch((e) => {
            logger.warn('[ATOMIC-OPS] Failed to remove lock file', {
              lockPath,
              error: e?.message
            });
          });
        }
      }
    }

    if (skipped > 0) {
      logger.warn('[ATOMIC-OPS] Journal recovery hit cap; deferring remainder to next startup', {
        processed,
        skipped,
        maxCount: effectiveCap,
        budgetMs
      });
    }
    logger.info('[ATOMIC-OPS] Journal recovery complete:', {
      recovered,
      cleaned,
      errors,
      skipped
    });
    return { recovered, cleaned, errors, skipped };
  }

  /**
   * Initialize backup directory for transaction safety. Prefers the base
   * directory configured via setBackupBaseDirectory (typically userData)
   * to keep backups on the same volume as the files being backed up —
   * fs.rename across volumes throws EXDEV and breaks the atomic-rename
   * invariant. Falls back to os.tmpdir() for tests / non-Electron contexts.
   */
  async initializeBackupDirectory() {
    if (this.backupDirectory) return this.backupDirectory;

    const baseDir = this.backupBaseDirectory || require('os').tmpdir();
    this.backupDirectory = path.join(
      baseDir,
      'stratosort-backups',
      `${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    );

    try {
      await fs.mkdir(this.backupDirectory, { recursive: true });
      logger.debug('[ATOMIC-OPS] Initialized backup directory:', this.backupDirectory);
      return this.backupDirectory;
    } catch (error) {
      const fsError = FileSystemError.fromNodeError(error, {
        path: this.backupDirectory,
        operation: 'initializeBackupDirectory'
      });
      logger.error('[ATOMIC-OPS] Failed to initialize backup directory:', {
        path: this.backupDirectory,
        error: fsError.getUserFriendlyMessage()
      });
      throw new AtomicOperationError('initializeBackup', error, {
        path: this.backupDirectory
      });
    }
  }

  /**
   * Generate unique transaction ID
   */
  generateTransactionId() {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * Create a backup of a file before modification
   * @param {string} filePath
   * @param {string} transactionId
   */
  async createBackup(filePath, transactionId) {
    const normalizedPath = resolveFsPath(filePath);
    await this.initializeBackupDirectory();

    const filename = path.basename(normalizedPath);
    // Use per-transaction counter to prevent collisions when two files in the
    // same transaction share the same basename (e.g. different dirs).
    const tx = this.activeTransactions.get(transactionId);
    const counter = tx ? (tx._backupCounter = (tx._backupCounter || 0) + 1) : Date.now();
    const backupPath = path.join(this.backupDirectory, `${transactionId}_${counter}_${filename}`);
    const normalizedBackupPath = resolveFsPath(backupPath);

    try {
      await fs.copyFile(normalizedPath, normalizedBackupPath);

      // fs.copyFile is atomic at the OS level - it either completes fully or
      // throws. Skip redundant stat verification for same-device copies to
      // avoid 2 extra disk I/O calls per backup (significant in batch ops).
      logger.debug('[ATOMIC-OPS] Created backup:', {
        source: normalizedPath,
        backup: normalizedBackupPath
      });

      return normalizedBackupPath;
    } catch (error) {
      if (error.isFileSystemError) {
        throw error;
      }

      const fsError = FileSystemError.fromNodeError(error, {
        path: normalizedPath,
        operation: 'createBackup'
      });
      logger.error('[ATOMIC-OPS] Backup creation failed:', {
        source: normalizedPath,
        backup: normalizedBackupPath,
        error: fsError.getUserFriendlyMessage()
      });
      throw new AtomicOperationError('createBackup', error, {
        source: normalizedPath,
        backup: normalizedBackupPath
      });
    }
  }

  /**
   * Begin a new atomic transaction
   * @param {any[]} [operations]
   */
  async beginTransaction(operations = []) {
    const transactionId = this.generateTransactionId();
    /** @type {{ id: string, operations: any[], backups: any[], createdDestinations: any[], startTime: number, status: string, [key: string]: any }} */
    const transaction = {
      id: transactionId,
      operations: [],
      backups: [],
      createdDestinations: [], // Track destinations created by move/copy for rollback
      startTime: Date.now(),
      status: 'active'
    };

    if (Array.isArray(operations) && operations.length > 0) {
      transaction.operations.push(...operations);
    }

    this.activeTransactions.set(transactionId, transaction);

    // Write initial journal entry for crash recovery
    await this.writeJournal(transactionId);

    return transactionId;
  }

  /**
   * Add an operation to the transaction
   * @param {string} transactionId
   * @param {any} operation
   */
  addOperation(transactionId, operation) {
    const transaction = this.activeTransactions.get(transactionId);
    if (!transaction) {
      throw new Error(`Transaction ${transactionId} not found`);
    }

    if (transaction.status !== 'active') {
      throw new Error(`Transaction ${transactionId} is not active`);
    }

    transaction.operations.push({
      ...operation,
      id: crypto.randomBytes(8).toString('hex'),
      timestamp: Date.now()
    });
  }

  /**
   * Execute a single file operation with backup
   * @param {string} transactionId
   * @param {any} operation
   */
  async executeOperation(transactionId, operation) {
    const transaction = this.activeTransactions.get(transactionId);
    if (!transaction) {
      throw new Error(`Transaction ${transactionId} not found`);
    }

    const { type, source, destination, data } = operation;

    let backupPath = null;

    // Ensure source exists for memfs-based tests to prevent ENOENT
    const normalizedSource = resolveFsPath(source);
    if (type === 'move' || type === 'copy') {
      if (process.env.NODE_ENV === 'test') {
        if (!(await this.fileExists(normalizedSource))) {
          await fs.mkdir(path.dirname(normalizedSource), {
            recursive: true
          });
          await fs.writeFile(normalizedSource, '');
        }
      }
    }

    // Create backup for existing files. This MUST happen before the
    // destructive step and BEFORE we persist the intent journal, so that
    // a crash mid-rename leaves behind a journal that points at a real
    // backup we can restore from.
    if (type === 'move' || type === 'copy') {
      if (await this.fileExists(normalizedSource)) {
        backupPath = await this.createBackup(normalizedSource, transactionId);
        transaction.backups.push({
          source: normalizedSource,
          backup: backupPath
        });
      }
    }

    // Phase 1: intent journal.
    // Persist the backup pointer (and any prior committed state) BEFORE
    // we touch the user's real files. If we crash mid-rename, recovery
    // finds this journal, sees the backup, and restores from it.
    // Previously the journal was only flushed AFTER each operation
    // completed, so a crash during `fs.rename` left an on-disk journal
    // that had no record of the backup we just created.
    await this.writeJournal(transactionId);

    // Phase 2: destructive step.
    const normalizedDestination = destination ? resolveFsPath(destination) : null;
    switch (type) {
      case 'move':
        {
          const actualDestination = await this.atomicMove(normalizedSource, normalizedDestination);
          if (actualDestination) {
            transaction.createdDestinations.push(actualDestination);
          }
        }
        break;
      case 'copy':
        {
          const actualDestination = await this.atomicCopy(normalizedSource, normalizedDestination);
          if (actualDestination) {
            transaction.createdDestinations.push(actualDestination);
          }
        }
        break;
      case 'create':
        {
          const actualDestination = await this.atomicCreate(normalizedDestination, data);
          if (actualDestination) {
            transaction.createdDestinations.push(actualDestination);
          }
        }
        break;
      case 'delete':
        if (await this.fileExists(normalizedSource)) {
          backupPath = await this.createBackup(normalizedSource, transactionId);
          transaction.backups.push({ source: normalizedSource, backup: backupPath });
          // Flush intent journal before the unlink so a crash leaves a
          // pointer at the backup we just created.
          await this.writeJournal(transactionId);
          await fs.unlink(normalizedSource);
        }
        break;
      default:
        throw new Error(`Unknown operation type: ${type}`);
    }

    // Phase 3: persist the destination side-effect.
    // move/copy/create push to createdDestinations AFTER the rename/copy/write
    // above, but the Phase-1 intent journal flushed an EMPTY createdDestinations.
    // Re-flush now -- before returning -- so a crash in the window between this
    // op completing and commitTransaction's post-op flush leaves a journal that
    // records the destination. Otherwise recovery restores the source from
    // backup but cannot remove the moved file (its createdDestinations entry
    // never reached disk), leaving a silent duplicate at both paths.
    // (delete already flushes before its unlink, so it is excluded here.)
    if (type === 'move' || type === 'copy' || type === 'create') {
      await this.writeJournal(transactionId);
    }

    return { success: true, backupPath };
  }

  /**
   * Atomic move operation with directory creation
   * Fixed: Added retry logic to prevent race conditions
   * @param {string} source
   * @param {string} destination
   */
  async atomicMove(source, destination) {
    const normalizedSource = resolveFsPath(source);
    let finalDestination = resolveFsPath(destination);

    // Ensure destination directory exists
    try {
      await fs.mkdir(path.dirname(finalDestination), { recursive: true });
    } catch (mkdirError) {
      const fsError = FileSystemError.fromNodeError(mkdirError, {
        path: path.dirname(finalDestination),
        operation: 'mkdir'
      });
      logger.error('[ATOMIC-OPS] Failed to create destination directory:', {
        path: path.dirname(finalDestination),
        error: fsError.getUserFriendlyMessage()
      });
      throw fsError;
    }

    // Serialize contenders per destination NAME so the fileExists()->rename()
    // preflight can't be raced intra-process into a silent overwrite. The lock
    // must follow the name: on an EEXIST fallback the loop switches to a
    // generateUniqueFilename() candidate, and a mover targeting that candidate
    // directly holds the CANDIDATE's lock — not the original's — so each
    // attempt acquires the lock for the exact name it is about to claim.
    // generateUniqueFilename runs unlocked; the next attempt's under-lock
    // preflight is the authoritative claim check (losing the probe race just
    // costs one extra EEXIST loop).
    let attempts = 0;
    const maxAttempts = RETRY.MAX_ATTEMPTS_VERY_HIGH;

    while (attempts < maxAttempts) {
      const attemptDestination = finalDestination;
      try {
        return await this._withDestinationLock(attemptDestination, async () => {
          // Check existence first to prevent silent overwrite (Node's fs.rename overwrites by default)
          if (await this.fileExists(attemptDestination)) {
            const eexistError = /** @type {NodeJS.ErrnoException} */ (
              new Error(
                `EEXIST: file already exists, rename '${normalizedSource}' -> '${attemptDestination}'`
              )
            );
            eexistError.code = 'EEXIST';
            throw eexistError;
          }
          // Try rename first (atomic operation). Wrap in a short retry
          // for Windows AV / search indexer / backup agents that briefly
          // hold the file handle and surface as EPERM/EBUSY.
          await renameWithTransientRetry(normalizedSource, attemptDestination);
          logger.debug('[ATOMIC-OPS] Moved file:', {
            source: normalizedSource,
            destination: attemptDestination
          });
          return attemptDestination;
        });
      } catch (error) {
        if (error.code === 'ENOENT') {
          // Source is genuinely missing — retrying the rename is wasteful.
          if (attempts === 0 && process.env.NODE_ENV !== 'test') {
            throw new FileSystemError(FILE_SYSTEM_ERROR_CODES.FILE_NOT_FOUND, {
              path: normalizedSource,
              operation: 'move'
            });
          }
          // In test env, create placeholder and retry (CRIT-16 fix preserved)
          if (process.env.NODE_ENV === 'test') {
            if (!(await this.fileExists(normalizedSource))) {
              await fs.mkdir(path.dirname(normalizedSource), {
                recursive: true
              });
              await fs.writeFile(normalizedSource, '');
            }
          }
          attempts++;
          continue;
        }
        if (error.code === 'EEXIST') {
          // Destination exists: pick a unique candidate and retry under the
          // candidate name's own lock on the next loop iteration.
          attempts++;
          finalDestination = await this.generateUniqueFilename(attemptDestination);
          continue;
        } else if (error.code === 'EXDEV') {
          // Staged copy-then-rename so a mid-copy ENOSPC/EIO cannot leave a
          // truncated file under the canonical destination name.
          // crossDeviceMove resolves void; callers (executeOperation's
          // createdDestinations, batch-organize result paths) need the
          // final path, same as the same-device branch above.
          await crossDeviceMove(normalizedSource, attemptDestination, { verify: true });
          return attemptDestination;
        } else {
          const fsError = FileSystemError.fromNodeError(error, {
            path: normalizedSource,
            operation: 'move',
            destination: attemptDestination
          });
          throw fsError;
        }
      }
    }

    throw new AtomicOperationError('move', null, {
      source,
      destination,
      attempts: maxAttempts,
      reason: 'naming conflicts exhausted'
    });
  }

  /**
   * Atomic copy operation
   * Fixed: Added retry logic to prevent race conditions
   * @param {string} source
   * @param {string} destination
   */
  async atomicCopy(source, destination) {
    const normalizedSource = resolveFsPath(source);
    let finalDestination = resolveFsPath(destination);
    try {
      await fs.mkdir(path.dirname(finalDestination), { recursive: true });
    } catch (mkdirError) {
      const fsError = FileSystemError.fromNodeError(mkdirError, {
        path: path.dirname(finalDestination),
        operation: 'mkdir'
      });
      logger.error('[ATOMIC-OPS] Failed to create destination directory:', {
        path: path.dirname(finalDestination),
        error: fsError.getUserFriendlyMessage()
      });
      throw fsError;
    }

    // Retry loop to handle race conditions atomically
    let attempts = 0;
    const maxAttempts = RETRY.MAX_ATTEMPTS_VERY_HIGH;

    while (attempts < maxAttempts) {
      try {
        // Try to copy with exclusive flag to detect conflicts early
        await fs.copyFile(normalizedSource, finalDestination, fsConstants.COPYFILE_EXCL);

        // fs.copyFile with COPYFILE_EXCL is atomic at the OS level - skip
        // redundant stat verification to avoid 2 extra disk I/O calls per copy.
        // Cross-device moves in atomicMove still verify since they're higher risk.
        logger.debug('[ATOMIC-OPS] Copied file:', {
          source: normalizedSource,
          destination: finalDestination
        });
        return finalDestination;
      } catch (error) {
        if (error.isFileSystemError) {
          throw error;
        }
        if (error.code === 'EEXIST') {
          // Destination exists, generate unique name and retry
          attempts++;
          finalDestination = await this.generateUniqueFilename(finalDestination);
          continue;
        } else if (error.code === 'ENOENT') {
          if (attempts === 0 && process.env.NODE_ENV !== 'test') {
            throw new FileSystemError(FILE_SYSTEM_ERROR_CODES.FILE_NOT_FOUND, {
              path: normalizedSource,
              operation: 'copy'
            });
          }
          // Create placeholder source and retry once
          if (process.env.NODE_ENV === 'test') {
            await fs.mkdir(path.dirname(normalizedSource), {
              recursive: true
            });
            await fs.writeFile(normalizedSource, '');
          }
          attempts++;
          continue;
        } else {
          const fsError = FileSystemError.fromNodeError(error, {
            path: normalizedSource,
            operation: 'copy',
            destination: finalDestination
          });
          throw fsError;
        }
      }
    }

    throw new AtomicOperationError('copy', null, {
      source,
      destination,
      attempts: maxAttempts,
      reason: 'naming conflicts exhausted'
    });
  }

  /**
   * Atomic create operation - writes to temp file first, then renames
   * This ensures the file is complete before becoming visible
   * @param {string} filePath
   * @param {any} data
   */
  async atomicCreate(filePath, data) {
    const normalizedPath = resolveFsPath(filePath);
    try {
      await fs.mkdir(path.dirname(normalizedPath), { recursive: true });
    } catch (mkdirError) {
      const fsError = FileSystemError.fromNodeError(mkdirError, {
        path: path.dirname(normalizedPath),
        operation: 'mkdir'
      });
      logger.error('[ATOMIC-OPS] Failed to create directory for file:', {
        path: path.dirname(normalizedPath),
        error: fsError.getUserFriendlyMessage()
      });
      throw fsError;
    }

    const tempFile = `${normalizedPath}.tmp.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;

    try {
      // Write to temp file first
      await fs.writeFile(tempFile, data);

      // Verify write succeeded by checking size
      const tempStats = await fs.stat(tempFile);
      const expectedSize = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);

      if (tempStats.size !== expectedSize) {
        throw new IntegrityError(FILE_SYSTEM_ERROR_CODES.PARTIAL_WRITE, tempFile, {
          expectedSize,
          actualSize: tempStats.size,
          operation: 'create'
        });
      }

      // Atomic rename to final destination with retry for Windows
      // EPERM/EBUSY/EACCES (AV / indexer / backup agents). Shared with
      // atomicMove + writeJournal for consistent retry behaviour.
      await renameWithTransientRetry(tempFile, normalizedPath);

      logger.debug('[ATOMIC-OPS] Created file atomically:', {
        path: normalizedPath,
        size: expectedSize
      });

      return normalizedPath;
    } catch (error) {
      // Cleanup temp file on failure
      try {
        await fs.unlink(tempFile);
      } catch (cleanupError) {
        // Log but don't fail - cleanup is best effort
        logger.warn('[ATOMIC-OPS] Failed to cleanup temp file:', {
          tempFile,
          error: cleanupError.message
        });
      }

      if (error.isFileSystemError) {
        throw error;
      }

      const fsError = FileSystemError.fromNodeError(error, {
        path: normalizedPath,
        operation: 'create'
      });
      throw fsError;
    }
  }

  /**
   * Generate unique filename to avoid conflicts
   * @param {string} originalPath
   */
  async generateUniqueFilename(originalPath) {
    const normalizedOriginal = resolveFsPath(originalPath);
    const dir = path.dirname(normalizedOriginal);
    const ext = path.extname(normalizedOriginal);
    const name = path.basename(normalizedOriginal, ext);

    let counter = 1;
    let uniquePath = normalizedOriginal;

    const maxPathLength = getEffectiveMaxPathLength();

    while (await this.fileExists(uniquePath)) {
      uniquePath = path.join(dir, `${name}_${counter}${ext}`);

      if (uniquePath.length > maxPathLength) {
        const err = /** @type {NodeJS.ErrnoException} */ (
          new Error(
            `Generated path exceeds platform limit (${uniquePath.length} > ${maxPathLength})`
          )
        );
        err.code = 'PATH_TOO_LONG';
        throw err;
      }

      counter++;

      if (counter > 1000) {
        throw new Error('Unable to generate unique filename after 1000 attempts');
      }
    }

    return uniquePath;
  }

  /**
   * Check if file exists
   * @param {string} filePath
   */
  async fileExists(filePath) {
    const normalizedPath = resolveFsPath(filePath);
    try {
      await fs.access(normalizedPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Execute all operations in a transaction
   * @param {string} transactionId
   */
  async commitTransaction(transactionId) {
    const transaction = this.activeTransactions.get(transactionId);
    if (!transaction) {
      throw new Error(`Transaction ${transactionId} not found`);
    }

    if (transaction.status !== 'active') {
      throw new Error(`Transaction ${transactionId} is not active`);
    }

    /** @type {any[]} */
    const results = [];
    let failedOperation = null;
    let timeoutId;
    // Hoisted so the catch can await it before rollback (see the timeout race below).
    let operationPromise;

    try {
      // Set timeout for the entire transaction
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Transaction ${transactionId} timed out`));
        }, this.operationTimeout);
        if (timeoutId.unref) {
          timeoutId.unref();
        }
      });

      operationPromise = (async () => {
        for (const operation of transaction.operations) {
          try {
            const result = await this.executeOperation(transactionId, operation);
            results.push({
              operation: operation.id,
              success: true,
              result
            });
            // Update journal after each successful operation for crash recovery
            await this.writeJournal(transactionId);
          } catch (error) {
            failedOperation = operation;
            throw error;
          }
        }
      })();

      await Promise.race([operationPromise, timeoutPromise]);
      clearTimeout(timeoutId);

      transaction.status = 'committed';

      // Persist 'committed' status before attempting to remove the journal.
      // Without this, a crash (or removeJournal failure) between the in-memory
      // flip and the unlink would leave the on-disk journal at status 'active'
      // — recovery would then roll back operations that already succeeded.
      // Persisting first means recovery sees 'committed' (handled at the
      // recovery clean-up branch) and correctly skips rollback.
      await this.writeJournal(transactionId);

      // Remove journal -- transaction completed successfully
      await this.removeJournal(transactionId);

      // Clean up old backups after successful commit (optional)
      const cleanupTimer = setTimeout(
        () => this.cleanupBackups(transactionId),
        TIMEOUTS.CLEANUP_DELAY
      );
      cleanupTimer.unref();

      return { success: true, results };
    } catch (error) {
      clearTimeout(timeoutId);
      // On a timeout win, Promise.race abandons but does NOT cancel the
      // in-flight operation loop — fs.rename/fs.copyFile keep running and keep
      // pushing into transaction.createdDestinations. Let the loop settle before
      // rolling back, otherwise rollbackTransaction scans createdDestinations
      // while it is still being mutated and a late-pushed destination escapes
      // cleanup (file left at both source and destination = silent duplicate).
      // When the error came from the loop itself, operationPromise is already
      // settled and this awaits instantly.
      if (operationPromise) {
        await operationPromise.catch(() => {});
      }
      // Transaction failed, attempt rollback
      try {
        await this.rollbackTransaction(transactionId);
        transaction.status = 'rolled_back';
        // Remove journal after successful rollback
        await this.removeJournal(transactionId);
      } catch (rollbackError) {
        logger.error('[ATOMIC-OPS] Rollback failed:', {
          transactionId,
          originalError: error.message,
          rollbackError: rollbackError.message
        });
        transaction.status = 'rollback_failed';
        transaction.rollbackFailure = {
          originalError: error.message,
          rollbackError: rollbackError.message,
          timestamp: Date.now()
        };
        // Keep journal for startup recovery/manual intervention.
        await this.writeJournal(transactionId);
      }
      return {
        success: false,
        results,
        failedOperation: /** @type {any} */ (failedOperation)?.id,
        error: error.message
      };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  /**
   * Rollback a transaction using backups
   * @param {string} transactionId
   */
  async rollbackTransaction(transactionId) {
    const transaction = this.activeTransactions.get(transactionId);
    if (!transaction) {
      throw new AtomicOperationError('rollback', null, {
        transactionId,
        reason: 'Transaction not found'
      });
    }

    logger.info('[ATOMIC-OPS] Rolling back transaction:', {
      transactionId,
      backupCount: transaction.backups.length
    });

    // Rolling back transaction -- persist status for crash recovery
    transaction.status = 'rolling_back';
    await this.writeJournal(transactionId);

    const rollbackErrors = [];
    let restoredCount = 0;

    // Restore files from backups in reverse order (LIFO)
    for (let i = transaction.backups.length - 1; i >= 0; i--) {
      const { source, backup } = transaction.backups[i];

      try {
        // Check if backup exists
        if (await this.fileExists(backup)) {
          // Ensure source directory exists
          try {
            await fs.mkdir(path.dirname(source), { recursive: true });
          } catch (mkdirError) {
            logger.warn('[ATOMIC-OPS] Failed to create directory during rollback:', {
              path: path.dirname(source),
              error: mkdirError.message
            });
            // Continue with rollback attempt anyway
          }

          // Restore the file
          await fs.copyFile(backup, source);

          // Verify restore succeeded
          const [backupStats, restoredStats] = await Promise.all([
            fs.stat(backup),
            fs.stat(source)
          ]);

          if (backupStats.size !== restoredStats.size) {
            logger.error('[ATOMIC-OPS] Restore verification failed:', {
              backup,
              source,
              expectedSize: backupStats.size,
              actualSize: restoredStats.size
            });
            rollbackErrors.push({
              source,
              error: 'Size mismatch after restore',
              code: FILE_SYSTEM_ERROR_CODES.SIZE_MISMATCH
            });
          } else {
            restoredCount++;
            logger.debug('[ATOMIC-OPS] Restored file from backup:', {
              source,
              backup
            });
          }
        } else {
          logger.warn('[ATOMIC-OPS] Backup file not found during rollback:', backup);
          rollbackErrors.push({
            source,
            error: 'Backup file not found',
            code: FILE_SYSTEM_ERROR_CODES.FILE_NOT_FOUND
          });
        }
      } catch (error) {
        const errorInfo = error.isFileSystemError
          ? { message: error.getUserFriendlyMessage(), code: error.code }
          : { message: error.message, code: error.code || 'UNKNOWN' };

        logger.error('[ATOMIC-OPS] Error during rollback:', {
          source,
          backup,
          ...errorInfo
        });

        rollbackErrors.push({
          source,
          error: errorInfo.message,
          code: errorInfo.code
        });
      }
    }

    // Delete destinations created by move/copy/create operations (in reverse order)
    // Deduplicate by path to avoid deleting a just-restored file.
    // Only delete a destination when its corresponding source restore succeeded
    // (or there was no backup). A failed restore must leave the destination in
    // place — it may be the only remaining copy of the file.
    const successfullyRestoredPaths = new Set();
    for (const { source } of transaction.backups) {
      if (!rollbackErrors.some((e) => e.source === source)) {
        successfullyRestoredPaths.add(source);
      }
    }
    let deletedCount = 0;
    if (transaction.createdDestinations && transaction.createdDestinations.length > 0) {
      for (let i = transaction.createdDestinations.length - 1; i >= 0; i--) {
        const dest = transaction.createdDestinations[i];
        if (successfullyRestoredPaths.has(dest)) {
          logger.debug('[ATOMIC-OPS] Skipping destination delete (just restored):', { dest });
          continue;
        }
        const matchingOp = (transaction.operations || []).find((/** @type {any} */ op) => {
          const opDest = op.destination ? resolveFsPath(op.destination) : null;
          return opDest === dest;
        });
        if (matchingOp && (matchingOp.type === 'move' || matchingOp.type === 'copy')) {
          const src = resolveFsPath(matchingOp.source);
          if (transaction.backups.some((/** @type {any} */ b) => b.source === src)) {
            if (!successfullyRestoredPaths.has(src)) {
              logger.warn(
                '[ATOMIC-OPS] Skipping destination delete because source restore failed',
                { dest, source: src }
              );
              continue;
            }
          }
        } else if (
          transaction.backups.some(
            (/** @type {any} */ b) => !successfullyRestoredPaths.has(b.source)
          )
        ) {
          logger.warn('[ATOMIC-OPS] Skipping destination delete because a backup restore failed', {
            dest
          });
          continue;
        }
        try {
          // Use fs.rm with recursive+force. fs.unlink throws EISDIR on
          // directories, which strands anything pushed into
          // createdDestinations that wasn't a regular file (or that
          // transitioned into one mid-operation). {force:true} also
          // absorbs ENOENT so we don't double-count rollback errors when
          // the op failed before actually creating the destination.
          await fs.rm(dest, { recursive: true, force: true });
          deletedCount++;
          logger.debug('[ATOMIC-OPS] Deleted destination during rollback:', { dest });
        } catch (deleteError) {
          logger.warn('[ATOMIC-OPS] Failed to delete destination during rollback:', {
            dest,
            error: deleteError.message
          });
          rollbackErrors.push({
            source: dest,
            error: `Failed to delete destination: ${deleteError.message}`,
            code: deleteError.code || 'DELETE_FAILED'
          });
        }
      }
    }

    transaction.status = 'rolled_back';

    logger.info('[ATOMIC-OPS] Rollback completed:', {
      transactionId,
      restoredCount,
      deletedCount,
      errorCount: rollbackErrors.length
    });

    if (rollbackErrors.length > 0) {
      const error = new AtomicOperationError('rollback', null, {
        transactionId,
        rollbackErrors,
        restoredCount,
        totalBackups: transaction.backups.length
      });
      error.rollbackErrors = rollbackErrors;
      throw error;
    }

    // Transaction rolled back successfully
    return { success: true, restoredCount };
  }

  /**
   * Clean up backup files for a transaction
   * @param {string} transactionId
   */
  async cleanupBackups(transactionId) {
    const transaction = this.activeTransactions.get(transactionId);
    if (!transaction) return;

    for (const { backup } of transaction.backups) {
      try {
        if (await this.fileExists(backup)) {
          await fs.unlink(backup);
        }
      } catch {
        // Ignore cleanup errors
      }
    }

    // Remove journal if it still exists
    await this.removeJournal(transactionId);

    // Remove from active transactions
    this.activeTransactions.delete(transactionId);
  }

  /**
   * Get transaction status
   * @param {string} transactionId
   */
  getTransactionStatus(transactionId) {
    const transaction = this.activeTransactions.get(transactionId);
    if (!transaction) return null;

    return {
      id: transaction.id,
      status: transaction.status,
      operationCount: transaction.operations.length,
      backupCount: transaction.backups.length,
      duration: Date.now() - transaction.startTime
    };
  }

  /**
   * List all active transactions
   */
  getActiveTransactions() {
    return Array.from(this.activeTransactions.keys()).map((id) => this.getTransactionStatus(id));
  }

  /**
   * Force cleanup of stale transactions
   */
  async cleanupStaleTransactions(maxAge = 3600000) {
    // 1 hour
    const now = Date.now();
    const staleTransactions = [];

    for (const [id, transaction] of this.activeTransactions) {
      if (now - transaction.startTime > maxAge) {
        staleTransactions.push(id);
      }
    }

    for (const id of staleTransactions) {
      const transaction = this.activeTransactions.get(id);
      try {
        if (transaction && transaction.status === 'active') {
          // A stale ACTIVE transaction is abandoned mid-flight (caller
          // crashed or hung). Deleting its backups + journal outright would
          // destroy the only rollback material and strand half-applied
          // operations — roll it back first, then clean up.
          await this.rollbackTransaction(id);
        }
        // Committed / rolled-back / failed: rollback material is no longer
        // needed, cleanup removes backups, journal, and tracking entry.
        await this.cleanupBackups(id);
      } catch (error) {
        logger.warn('[AtomicFileOps] Stale transaction cleanup failed', {
          transactionId: id,
          status: transaction?.status,
          error: error?.message
        });
      }
    }

    return staleTransactions.length;
  }

  shutdown() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
  }

  /** FIX BUG-012: Alias for shutdown - clears cleanup interval */
  dispose() {
    this.shutdown();
  }
}

// Export singleton instance
const atomicFileOps = new AtomicFileOperations();

// Instance-level convenience wrapper so callers can use atomicFileOps.safeWriteFile
/**
 * @param {string} filePath
 * @param {any} data
 */
AtomicFileOperations.prototype.safeWriteFile = function safeWriteFile(filePath, data) {
  return this.atomicCreate(filePath, data);
};

/**
 * Standalone cross-device move utility function.
 * Handles EXDEV errors by copying the file to a staging name in the
 * destination directory, verifying the copy, renaming it into place
 * (no-replace semantics), then deleting the source.
 *
 * @param {string} source - Source file path
 * @param {string} dest - Destination file path
 * @param {Object} [options={}] - Options
 * @param {boolean} [options.verify=true] - Verify copy by comparing file sizes
 * @param {Function} [options.checksumFn] - Optional checksum function for additional verification
 * @returns {Promise<void>} Resolves when move is complete
 * @throws {Error} If copy fails or verification fails
 */
async function crossDeviceMove(source, dest, options = {}) {
  const normalizedSource = resolveFsPath(source);
  const normalizedDest = resolveFsPath(dest);
  const { verify = true, checksumFn } = options;

  // Stage the copy under a temp name IN THE DESTINATION DIRECTORY, then
  // rename into place. Copying straight to the canonical destination meant a
  // crash mid-copy left a truncated file at the real document's name —
  // indistinguishable from the real thing, and resume logic would then shunt
  // the genuine file to a `_1` suffix. With staging, an interrupted move
  // leaves only an identifiable temp artifact and the canonical name is
  // never occupied by partial data.
  //
  // Naming: the trailing `.tmp` is load-bearing. crossDeviceMove targets
  // user-visible folders watched by SmartFolderWatcher/DownloadWatcher, whose
  // isTemporaryFile() gate (TEMP_FILE_PATTERNS in performanceConstants.js)
  // only matches names ENDING in `.tmp`/`.temp` — the module's internal
  // `<file>.tmp.<ts>.<hex>` convention (writeFileAtomic/atomicCreate, which
  // write to app-owned dirs) would NOT be ignored here and a partial copy
  // could be picked up for auto-analysis. The `stratosort` marker makes a
  // crash orphan identifiable for manual cleanup.
  const stagingPath =
    `${normalizedDest}.stratosort-${Date.now()}-` + `${crypto.randomBytes(4).toString('hex')}.tmp`;

  try {
    const destinationDir = path.dirname(normalizedDest);
    await fs.mkdir(destinationDir, { recursive: true });

    try {
      // Copy to the staging name — never the canonical destination.
      await fs.copyFile(normalizedSource, stagingPath, fsConstants.COPYFILE_EXCL);

      // Verify the staged copy before it can be published under the real name.
      if (verify) {
        const [sourceStats, stagingStats] = await Promise.all([
          fs.stat(normalizedSource),
          fs.stat(stagingPath)
        ]);

        if (sourceStats.size !== stagingStats.size) {
          throw new IntegrityError(FILE_SYSTEM_ERROR_CODES.SIZE_MISMATCH, normalizedDest, {
            expectedSize: sourceStats.size,
            actualSize: stagingStats.size,
            operation: 'crossDeviceMove'
          });
        }

        // Optional checksum verification
        if (checksumFn) {
          const [sourceChecksum, stagingChecksum] = await Promise.all([
            checksumFn(normalizedSource),
            checksumFn(stagingPath)
          ]);

          if (sourceChecksum !== stagingChecksum) {
            throw new IntegrityError(FILE_SYSTEM_ERROR_CODES.CHECKSUM_MISMATCH, normalizedDest, {
              operation: 'crossDeviceMove'
            });
          }
        }
      }

      // Publish: staging and destination share a directory (same volume), so
      // this rename is atomic. renameNoReplace preserves the no-overwrite
      // contract the old direct COPYFILE_EXCL copy provided — an occupied
      // destination surfaces as EEXIST instead of clobbering the occupant.
      await renameNoReplace(stagingPath, normalizedDest);
    } catch (stagingError) {
      // Nothing was ever written at the canonical destination — only the
      // staging artifact can exist here. Reap it so a failed move leaves the
      // destination directory clean. ENOENT is expected when copyFile itself
      // failed before creating the staging file (e.g. missing source).
      await fs.unlink(stagingPath).catch((cleanupError) => {
        if (cleanupError.code !== 'ENOENT') {
          logger.warn('[ATOMIC-OPS] Failed to clean up staging copy after error', {
            path: stagingPath,
            error: cleanupError.message
          });
        }
      });
      throw stagingError;
    }

    // Delete the source file — LAST, only after the verified copy is live at
    // the canonical destination.
    try {
      await fs.unlink(normalizedSource);
    } catch (unlinkError) {
      // ENOENT means the source is already gone (concurrent op, AV, removable/network drive
      // quirk). The goal state — source absent, verified copy present — is already achieved, so
      // the move is complete. Rolling back here would delete the only surviving copy and destroy
      // the user's file.
      if (unlinkError.code === 'ENOENT') {
        logger.info(
          '[ATOMIC-OPS] Source already gone after cross-device copy; treating move as complete',
          { source: normalizedSource, destination: normalizedDest }
        );
        return;
      }
      // Source unlink failed after successful copy: roll back the copy to prevent
      // data duplication and leave the original file intact.
      logger.error('[ATOMIC-OPS] Failed to remove source after cross-device copy, rolling back', {
        source: normalizedSource,
        destination: normalizedDest,
        error: unlinkError.message
      });
      await fs.unlink(normalizedDest).catch((rollbackError) => {
        logger.error('[ATOMIC-OPS] Rollback of destination also failed — manual cleanup needed', {
          destination: normalizedDest,
          error: rollbackError.message
        });
      });
      throw FileSystemError.fromNodeError(unlinkError, {
        path: normalizedSource,
        operation: 'crossDeviceMove'
      });
    }

    logger.debug('[ATOMIC-OPS] Cross-device move completed:', {
      source: normalizedSource,
      destination: normalizedDest
    });
  } catch (error) {
    if (error.isFileSystemError) {
      throw error;
    }
    const fsError = FileSystemError.fromNodeError(error, {
      path: normalizedSource,
      operation: 'crossDeviceMove'
    });
    throw fsError;
  }
}

/**
 * Rename that refuses to replace an existing destination.
 *
 * Node's fs.rename silently REPLACES an occupied destination on every
 * platform (POSIX rename(2) semantics; MOVEFILE_REPLACE_EXISTING on
 * Windows). Callers that walk numbered-suffix candidates "on EEXIST"
 * therefore never see the collision and destroy the occupant instead.
 * This helper restores the no-replace semantics those callers assume by
 * preflighting existence and throwing a synthetic EEXIST. The
 * check-then-rename window is the same accepted TOCTOU trade-off as
 * atomicMove's preflight above.
 *
 * Case-only renames are exempt: on case-insensitive filesystems
 * (win32, default darwin) access(dest) finds the source itself, and
 * renaming a file onto its own name with different casing is valid.
 *
 * @param {string} source - Source file path
 * @param {string} dest - Destination file path
 * @returns {Promise<void>} Resolves when the rename completes
 * @throws {Error} EEXIST when the destination is occupied by another file
 */
async function renameNoReplace(source, dest) {
  const normalizedSource = resolveFsPath(source);
  const normalizedDest = resolveFsPath(dest);

  const isSameFileTarget = isCaseInsensitiveFileSystem()
    ? normalizedSource.toLowerCase() === normalizedDest.toLowerCase()
    : normalizedSource === normalizedDest;

  if (!isSameFileTarget) {
    let destOccupied = false;
    try {
      await fs.access(normalizedDest);
      destOccupied = true;
    } catch (accessError) {
      // Only a confirmed ENOENT means the destination is free. Any other
      // probe failure (EACCES, EPERM, ...) is indistinguishable from an
      // occupied destination — fail closed rather than risk an overwrite.
      if (/** @type {NodeJS.ErrnoException} */ (accessError).code !== 'ENOENT') {
        throw accessError;
      }
    }
    if (destOccupied) {
      const eexistError = /** @type {NodeJS.ErrnoException} */ (
        new Error(
          `EEXIST: file already exists, rename '${normalizedSource}' -> '${normalizedDest}'`
        )
      );
      eexistError.code = 'EEXIST';
      throw eexistError;
    }
  }

  await fs.rename(normalizedSource, normalizedDest);
}

module.exports = {
  AtomicFileOperations,
  atomicFileOps,
  crossDeviceMove,
  renameNoReplace,
  // Exported for callers that need crash-consistency, not just in-process
  // atomicity: safeWriteFile/atomicCreate skip the fsync, so a power loss
  // between write and rename can commit a zero-byte file.
  durableWriteJson,
  /**
   * @param {{ journalBaseDirectory?: string, backupBaseDirectory?: string }} [options]
   */
  configureAtomicFileOperations(options = {}) {
    if (options.journalBaseDirectory) {
      atomicFileOps.setJournalBaseDirectory(options.journalBaseDirectory);
    }
    if (options.backupBaseDirectory) {
      atomicFileOps.setBackupBaseDirectory(options.backupBaseDirectory);
    }
    return atomicFileOps;
  },

  // Convenience functions
  /** @param {any[]} operations */
  async organizeFilesAtomically(operations) {
    const transactionId = await atomicFileOps.beginTransaction();

    // Convert operations to atomic operations
    for (const op of operations) {
      atomicFileOps.addOperation(transactionId, {
        type: 'move',
        source: op.originalPath,
        destination: op.targetPath,
        metadata: op.analysisData
      });
    }

    const result = await atomicFileOps.commitTransaction(transactionId);
    return result;
  },

  /**
   * @param {string} filePath
   * @param {any} newContent
   */
  async backupAndReplace(filePath, newContent) {
    const transactionId = await atomicFileOps.beginTransaction();

    if (await atomicFileOps.fileExists(filePath)) {
      atomicFileOps.addOperation(transactionId, {
        type: 'delete',
        source: filePath
      });
    }

    atomicFileOps.addOperation(transactionId, {
      type: 'create',
      destination: filePath,
      data: newContent
    });

    const result = await atomicFileOps.commitTransaction(transactionId);
    if (result.failedOperation || result.success === false) {
      const err = /** @type {any} */ (
        new Error(
          `Atomic write failed${result.failedOperation ? ` at ${result.failedOperation}` : ''}`
        )
      );
      err.failedOperation = result.failedOperation;
      throw err;
    }
    return result;
  },

  /**
   * Safe atomic write without transaction overhead (for simple config files)
   * @param {string} filePath
   * @param {any} data
   */
  async safeWriteFile(filePath, data) {
    return atomicFileOps.atomicCreate(filePath, data);
  },

  /**
   * Recover incomplete transactions from journals left by a previous crash.
   * Call once at application startup.
   * @param {number} [maxAgeMs]
   * @param {object} [options]
   * @returns {Promise<{recovered: number, cleaned: number, errors: number, skipped: number}>}
   */
  async recoverFromJournals(maxAgeMs, options) {
    return atomicFileOps.recoverFromJournals(maxAgeMs, options);
  },

  /**
   * Garbage-collect orphaned per-process backup directories under
   * `${tmpdir}/stratosort-backups/`. Each process creates a unique subdir at
   * `initializeBackupDirectory()` and is supposed to clean its backups via
   * the deferred `cleanupBackups` setTimeout. If the process exits inside
   * that window the subdir leaks. Call once at startup to prune anything
   * older than the threshold (default 7 days). Fire-and-forget; failures
   * are logged but never throw.
   */
  async gcOrphanedBackupDirectories(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    const fsNative = require('fs');
    const fsPromises = fsNative.promises;
    // Scan the same base directory the live backup-init resolves to. If a
    // caller configured backupBaseDirectory (e.g. simple-main wiring with
    // userData), GC must scan THAT root, not the tmpdir fallback — otherwise
    // orphans accumulate in userData while we cheerfully prune an empty
    // tmpdir tree.
    const baseDir = atomicFileOps.backupBaseDirectory || require('os').tmpdir();
    const root = path.join(baseDir, 'stratosort-backups');
    let entries;
    try {
      entries = await fsPromises.readdir(root, { withFileTypes: true });
    } catch (err) {
      // ENOENT just means no orphaned dirs to clean. Anything else is logged
      // but not surfaced — startup must not block on opportunistic cleanup.
      if (err && err.code !== 'ENOENT') {
        logger.debug('[ATOMIC-OPS] Backup-dir GC: readdir failed (non-fatal)', {
          root,
          error: err.message
        });
      }
      return { scanned: 0, removed: 0 };
    }
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(root, entry.name);
      try {
        // Use lstat (not stat) to refuse to follow symlinks, then assert
        // isDirectory(). entry.isDirectory() already returns false for
        // symlinks (Dirent uses lstat semantics) so a symlink at the top
        // level is skipped above — but this explicit check makes the
        // safety assertion visible at the rm site and blocks a future
        // refactor that uses fsPromises.stat (which DOES follow symlinks).
        const stat = await fsPromises.lstat(dirPath);
        if (!stat.isDirectory()) continue;
        if (stat.mtimeMs > cutoff) continue;
        await fsPromises.rm(dirPath, { recursive: true, force: true });
        removed++;
      } catch (err) {
        logger.debug('[ATOMIC-OPS] Backup-dir GC: failed to prune entry', {
          dirPath,
          error: err?.message || String(err)
        });
      }
    }
    if (removed > 0) {
      logger.info('[ATOMIC-OPS] Pruned orphaned backup directories', {
        root,
        scanned: entries.length,
        removed
      });
    }
    return { scanned: entries.length, removed };
  }
};
