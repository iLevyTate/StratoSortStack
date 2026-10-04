// @ts-check
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { createLogger } = require('../../shared/logger');
const { buildPathUpdatePairs } = require('../utils/fileIdUtils');
const {
  crossDeviceMove,
  renameNoReplace,
  durableWriteJson
} = require('../../shared/atomicFileOperations');
const { validateFileOperationPath } = require('../../shared/pathSanitization');
const { getInstance: getFileOperationTracker } = require('../../shared/fileOperationTracker');
const { tryParse: tryJsonParse } = require('../../shared/safeJsonOps');
const { withGhostCleanupDeferred } = require('../../shared/ghostCleanupGuard');
const { isCaseInsensitiveFileSystem } = require('../../shared/crossPlatformUtils');

const logger = createLogger('UndoRedoService');

/**
 * Trash undo cannot restore from the OS trash programmatically; we still return
 * per-op results with TRASH_NO_RESTORE. That must not count as a "partial
 * failure" for stack progression, or undo stays pinned forever.
 * @param {{ success?: boolean, code?: string }} result
 * @returns {boolean}
 */
function isExpectedTrashNoRestore(result) {
  return Boolean(result && result.success === false && result.code === 'TRASH_NO_RESTORE');
}

/**
 * A batch whose every operation is a trash cannot be undone by this app:
 * Electron has no restore-from-Trash API (audit row UR-14).
 * @param {any} action
 */
function isTrashOnlyAction(action) {
  const operations = action?.data?.operations;
  if (!Array.isArray(operations) || operations.length === 0) return false;
  return operations.every((op) => op?.type === 'trash');
}

/**
 * Identity of a recorded batch move for coverage checks: a move is the same
 * move when it took the same file to the same place, whatever its `type`.
 * @param {any} op
 * @returns {string|null}
 */
function batchOperationKey(op) {
  return op && typeof op.originalPath === 'string' && typeof op.newPath === 'string'
    ? `${op.originalPath}\u0000${op.newPath}`
    : null;
}

const { container, ServiceIds } = require('./ServiceContainer');

// Lazy-load vector DB to avoid circular dependencies
function getVectorDbService() {
  try {
    return container.tryResolve(ServiceIds.ORAMA_VECTOR);
  } catch {
    return null;
  }
}

// Use FilePathCoordinator when available for atomic updates
function getFilePathCoordinator() {
  try {
    if (container.has(ServiceIds.FILE_PATH_COORDINATOR)) {
      return container.resolve(ServiceIds.FILE_PATH_COORDINATOR);
    }
  } catch {
    return null;
  }
  return null;
}

// Helper to generate secure random IDs
const generateSecureId = () =>
  `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;

// Minimum age before an UNREFERENCED backup may be reaped by
// cleanupOldBackups. A backup can be legitimately unreferenced for a short
// window: recordAction persists through a debounced save, so a crash between
// the file's unlink and the flush leaves a backup that IS the only surviving
// copy of the user's file but is referenced by nothing on disk. Age-gating
// the orphan sweep means such a backup survives long enough for the user to
// recover it manually; truly abandoned backups still get cleaned up on a
// later launch.
const BACKUP_ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

// Read errors that usually clear within a moment: an antivirus or backup
// agent holding undo-actions.json open without share-read on Windows, or a
// permission flap during a sync client's rewrite. loadActions retries these
// before deciding the file cannot be read.
const TRANSIENT_HISTORY_READ_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN']);
const HISTORY_READ_RETRY_DELAYS_MS = [100, 250, 500];

class UndoRedoService {
  /**
   * @param {{ maxActions?: number, maxMemoryMB?: number, maxBatchSize?: number, saveDebounceMs?: number, historyReadRetryDelaysMs?: number[] }} [options]
   */
  constructor(options = {}) {
    this.userDataPath = app.getPath('userData');
    this.actionsPath = path.join(this.userDataPath, 'undo-actions.json');

    this.maxActions = options.maxActions || 50;
    this.maxMemoryMB = options.maxMemoryMB || 10;
    this.maxBatchSize = options.maxBatchSize || 1000;

    /** @type {any[]} */
    this.actions = [];
    this.currentIndex = -1;
    this.initialized = false;
    this.currentMemoryEstimate = 0;

    /** @type {Promise<any>} */
    this._mutex = Promise.resolve();

    // Observers of history changes (record, remove, clear). The renderer's
    // undo toolbar mirrors this service; before this every recorder that is
    // not the undo/redo handler itself (Search, Atlas, graph, Duplicate
    // Finder, Triage, DownloadWatcher, organize resume) changed history
    // without telling the renderer (audit row UR-01).
    /** @type {Set<(change: { reason: string }) => void>} */
    this._changeListeners = new Set();

    // Coalesce frequent recordAction writes to reduce burst disk I/O.
    // Undo/redo/clear paths still force an immediate flush.
    this._saveDebounceMs =
      Number.isFinite(options.saveDebounceMs) && options.saveDebounceMs >= 0
        ? options.saveDebounceMs
        : 250;
    this._pendingSaveTimer = null;
    this._pendingSavePromise = null;
    this._pendingSaveResolve = null;
    this._pendingSaveReject = null;
    // loadActions read-retry schedule (tests shorten it), the path an
    // unreadable live history will be moved to once it can be, and the
    // set-aside copy the backup sweep has yet to read successfully.
    /** @type {number[]} */
    this._historyReadRetryDelaysMs = Array.isArray(options.historyReadRetryDelaysMs)
      ? options.historyReadRetryDelaysMs
      : HISTORY_READ_RETRY_DELAYS_MS;
    /** @type {string|null} */
    this._shieldedHistoryPath = null;
    this._shieldWarned = false;
    /** @type {string|null} */
    this._unverifiedSetAsidePath = null;
  }

  async _validateActionPath(/** @type {any} */ filePath, fieldName = 'path') {
    const candidate = typeof filePath === 'string' ? filePath.trim() : filePath;
    const validation = await validateFileOperationPath(candidate, {
      requireAbsolute: true,
      checkSymlinks: false,
      disallowUrlSchemes: true,
      allowFileUrl: false
    });
    if (!validation.valid) {
      throw new Error(
        `Unsafe action path blocked (${fieldName}): ${validation.error || 'Path validation failed'}`
      );
    }
    return validation.normalizedPath;
  }

  async ensureParentDirectory(/** @type {any} */ filePath) {
    const normalizedPath = await this._validateActionPath(filePath, 'parent-target');
    const parentDirectory = await this._validateActionPath(
      path.dirname(normalizedPath),
      'parent-directory'
    );
    await fs.mkdir(parentDirectory, { recursive: true });
  }

  async safeMove(/** @type {any} */ sourcePath, /** @type {any} */ destinationPath) {
    const normalizedSource = await this._validateActionPath(sourcePath, 'move-source');
    const normalizedDestination = await this._validateActionPath(
      destinationPath,
      'move-destination'
    );

    // Preflight (fail closed). POSIX rename() silently overwrites an existing
    // destination, so a blind undo could destroy a file the user created or
    // moved to the original path after this action was recorded. Verify the
    // source still exists and the destination is unoccupied before touching
    // disk. Case-only renames are exempt: source and destination are the same
    // file on case-insensitive filesystems (Windows, default macOS).
    const isSameFileTarget = isCaseInsensitiveFileSystem()
      ? normalizedSource.toLowerCase() === normalizedDestination.toLowerCase()
      : normalizedSource === normalizedDestination;
    if (!(await this.fileExists(normalizedSource))) {
      const missingErr = /** @type {Error & { code?: string }} */ (
        new Error(
          `Cannot move: source no longer exists (moved or deleted outside the app): ${normalizedSource}`
        )
      );
      missingErr.code = 'UNDO_SOURCE_MISSING';
      throw missingErr;
    }
    if (!isSameFileTarget && (await this.fileExists(normalizedDestination))) {
      const occupiedErr = /** @type {Error & { code?: string }} */ (
        new Error(
          `Cannot move: destination already occupied by another file: ${normalizedDestination}`
        )
      );
      occupiedErr.code = 'UNDO_DESTINATION_OCCUPIED';
      throw occupiedErr;
    }

    await this.ensureParentDirectory(normalizedDestination);
    try {
      // renameNoReplace, not bare fs.rename: the fileExists() preflight above
      // fails OPEN (any fs.access error — EACCES included — reads as "free"),
      // so an occupied-but-unreadable destination would be silently replaced
      // by POSIX rename semantics. renameNoReplace re-probes the destination
      // and fails CLOSED: only a confirmed ENOENT counts as free; every other
      // probe error propagates instead of risking an overwrite.
      await renameNoReplace(normalizedSource, normalizedDestination);
    } catch (error) {
      if (error && error.code === 'EXDEV') {
        // Cross-device move: use shared utility with verification
        await crossDeviceMove(normalizedSource, normalizedDestination, {
          verify: true
        });
      } else if (error && error.code === 'EEXIST') {
        // Map the synthetic EEXIST to the same structured code the preflight
        // uses, so callers see one occupancy signal regardless of which
        // probe caught it.
        const occupiedErr = /** @type {Error & { code?: string }} */ (
          new Error(
            `Cannot move: destination already occupied by another file: ${normalizedDestination}`
          )
        );
        occupiedErr.code = 'UNDO_DESTINATION_OCCUPIED';
        throw occupiedErr;
      } else {
        throw error;
      }
    }

    try {
      const tracker = getFileOperationTracker();
      tracker.recordOperation(normalizedSource, 'move', 'undoRedo');
      tracker.recordOperation(normalizedDestination, 'move', 'undoRedo');
    } catch (trackerErr) {
      logger.warn('[UndoRedoService] Failed to record operation in tracker', {
        error: trackerErr.message
      });
    }
  }

  async initialize() {
    if (this.initialized) return;

    try {
      await this.loadActions();
      this.initialized = true;
      logger.info('[UndoRedoService] Initialized successfully');

      this.cleanupOldBackups().catch((error) => {
        logger.warn('[UndoRedoService] Startup backup cleanup failed:', error.message);
      });
    } catch (error) {
      logger.error('[UndoRedoService] Failed to initialize', {
        error: error.message
      });
      this.actions = [];
      this.currentIndex = -1;
      this.initialized = true;
    }
  }

  async loadActions() {
    let actionsData;
    try {
      actionsData = await this._readHistoryWithRetry();
    } catch (readError) {
      if (readError?.code === 'ENOENT') {
        // A missing file is the normal first run.
        await this._startFreshHistory();
        return;
      }
      // The file is there but could not be read: a scanner holding it, a
      // permission or I/O error. Writing an empty history over it would
      // turn a passing hold into permanent loss, so the bytes are set aside
      // where that is possible and the live path is otherwise shielded
      // from writes until it can be.
      await this._preserveUnreadableHistory(readError);
      return;
    }

    // Persisted on disk: strip prototype-pollution keys on parse.
    const parsed = tryJsonParse(actionsData);
    const data =
      parsed.success &&
      parsed.value &&
      typeof parsed.value === 'object' &&
      !Array.isArray(parsed.value)
        ? parsed.value
        : null;
    if (!data) {
      await this._quarantineUnreadableHistory(parsed.error);
      await this._startFreshHistory();
      return;
    }

    this.actions = Array.isArray(data.actions) ? data.actions : [];
    const rawIndex = Number.isInteger(data.currentIndex) ? data.currentIndex : -1;
    // Clamp currentIndex to valid range to prevent out-of-bounds access on corrupted/truncated data
    this.currentIndex =
      this.actions.length === 0 ? -1 : Math.max(-1, Math.min(rawIndex, this.actions.length - 1));

    // Fixed: Recalculate memory estimate after loading
    this._recalculateMemoryEstimate();
  }

  /**
   * Reset to an empty history and persist it.
   * @private
   */
  async _startFreshHistory() {
    this.actions = [];
    this.currentIndex = -1;
    this.currentMemoryEstimate = 0;
    try {
      await this.saveActions();
    } catch (saveErr) {
      logger.warn('[UndoRedo] Failed to persist fresh state:', saveErr?.message);
    }
  }

  /**
   * Read the history file, retrying the codes a passing file hold produces.
   * @private
   * @returns {Promise<string>}
   */
  async _readHistoryWithRetry() {
    const delays = this._historyReadRetryDelaysMs;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fs.readFile(this.actionsPath, 'utf8');
      } catch (error) {
        const code = /** @type {any} */ (error)?.code;
        if (!TRANSIENT_HISTORY_READ_CODES.has(code) || attempt >= delays.length) throw error;
        logger.debug('[UndoRedoService] Undo history busy; retrying read', {
          code,
          attempt: attempt + 1
        });
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  }

  /**
   * The history file exists but cannot be read. Set the bytes aside (rename,
   * else copy) and start an empty history. When neither works the file is
   * left exactly as it is: this session's history stays in memory and
   * saveActions refuses to write over the intact file until a later attempt
   * manages to move it aside. The degraded flag explains the empty stack.
   * @private
   * @param {any} readError
   */
  async _preserveUnreadableHistory(readError) {
    const quarantinePath = `${this.actionsPath}.unreadable.${Date.now()}`;
    const code = readError?.code || 'read-error';
    let preserved = null;
    try {
      await fs.rename(this.actionsPath, quarantinePath);
      preserved = 'moved';
    } catch (renameError) {
      try {
        await fs.copyFile(this.actionsPath, quarantinePath);
        preserved = 'copied';
      } catch (copyError) {
        logger.warn('[UndoRedoService] Could not set unreadable undo history aside', {
          path: this.actionsPath,
          renameError: renameError?.message,
          copyError: /** @type {any} */ (copyError)?.message
        });
      }
    }
    this.actions = [];
    this.currentIndex = -1;
    this.currentMemoryEstimate = 0;
    // Whatever could not be read at the live path may stay unreadable under
    // the quarantine name (a read-denying ACL, a share-delete-only hold, a
    // bad sector all survive a rename). The backup sweep reads it once
    // before trusting its own reference count; see cleanupOldBackups.
    this._unverifiedSetAsidePath = quarantinePath;
    if (preserved === 'moved') {
      await this._startFreshHistory();
    } else {
      // The original is still at the live path. Shield it from writes;
      // saveActions retries the rename before every write and only writes
      // once the file has been moved out of the way.
      this._shieldedHistoryPath = quarantinePath;
    }
    logger.error('[UndoRedoService] Undo history unreadable; starting with an empty history', {
      path: this.actionsPath,
      code,
      preserved,
      quarantinePath: preserved ? quarantinePath : null
    });
    const kept = path.basename(quarantinePath);
    const message =
      preserved === 'moved'
        ? `Undo history could not be read (${code}) and was set aside as ${kept}. A new history starts now.`
        : preserved === 'copied'
          ? `Undo history could not be read (${code}). A copy was kept as ${kept}; the original is left in place and this session's undo history stays in memory until it can be set aside.`
          : `Undo history could not be read (${code}). The file was left untouched and this session's undo history stays in memory until it can be set aside.`;
    this._raiseHistoryFlag(message, {
      path: this.actionsPath,
      code,
      preserved,
      quarantinePath: preserved ? quarantinePath : null,
      error: readError?.message || null
    });
  }

  /**
   * While the live history file is shielded (see _preserveUnreadableHistory),
   * try once more to move it aside. Returns true when the path is free to
   * write.
   * @private
   */
  async _releaseShieldedHistory() {
    if (!this._shieldedHistoryPath) return true;
    try {
      await fs.rename(this.actionsPath, this._shieldedHistoryPath);
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'ENOENT') {
        if (!this._shieldWarned) {
          this._shieldWarned = true;
          logger.warn(
            "[UndoRedoService] Unreadable undo history still in place; keeping this session's history in memory only",
            { path: this.actionsPath, error: /** @type {any} */ (error)?.message }
          );
        }
        return false;
      }
    }
    logger.info('[UndoRedoService] Unreadable undo history set aside; persisting again', {
      quarantinePath: this._shieldedHistoryPath
    });
    this._shieldedHistoryPath = null;
    return true;
  }

  /**
   * @private
   * @param {string} message
   * @param {Record<string, any>} detail
   */
  _raiseHistoryFlag(message, detail) {
    try {
      require('./DegradedStateTracker').getInstance().raise({
        code: 'undo.history-unreadable',
        subsystem: 'undo',
        severity: 'warning',
        message,
        detail
      });
    } catch (flagError) {
      logger.debug('[UndoRedoService] Could not raise degraded flag', {
        error: flagError?.message
      });
    }
  }

  /**
   * An unparseable undo-actions.json used to be overwritten with an empty
   * history without a word. Keep the bytes beside the live file and raise a
   * degraded-state flag so a vanished undo stack is explained in the UI.
   * @private
   * @param {any} parseError
   */
  async _quarantineUnreadableHistory(parseError) {
    const quarantinePath = `${this.actionsPath}.corrupt.${Date.now()}`;
    let quarantined = false;
    try {
      await fs.rename(this.actionsPath, quarantinePath);
      quarantined = true;
    } catch (renameError) {
      logger.warn('[UndoRedoService] Could not quarantine unreadable undo history', {
        path: this.actionsPath,
        error: renameError?.message
      });
    }
    logger.error('[UndoRedoService] Undo history unreadable; starting fresh', {
      path: this.actionsPath,
      quarantinePath: quarantined ? quarantinePath : null,
      error: parseError?.message
    });
    this._raiseHistoryFlag(
      quarantined
        ? `Undo history could not be read and was reset. The old file was kept as ${path.basename(quarantinePath)}.`
        : 'Undo history could not be read and was reset.',
      {
        path: this.actionsPath,
        quarantinePath: quarantined ? quarantinePath : null,
        error: parseError?.message || null
      }
    );
  }

  /**
   * Estimate memory usage of an action in bytes
   * @private
   */
  _estimateActionSize(/** @type {any} */ action) {
    // Rough estimate: JSON.stringify length * 2 (for UTF-16 encoding)
    // Actions may contain service references or error objects with cause chains.
    try {
      return JSON.stringify(action).length * 2;
    } catch {
      // Fallback: estimate based on the action's top-level keys
      // This is a rough heuristic but prevents crashes on circular data
      return 1024;
    }
  }

  /**
   * Recalculate total memory estimate for all actions
   * @private
   */
  _recalculateMemoryEstimate() {
    this.currentMemoryEstimate = this.actions.reduce((total, action) => {
      return total + this._estimateActionSize(action);
    }, 0);
  }

  async saveActions() {
    if (!(await this._releaseShieldedHistory())) return;
    const data = {
      actions: this.actions,
      currentIndex: this.currentIndex,
      lastSaved: new Date().toISOString()
    };
    await this.ensureParentDirectory(this.actionsPath);
    // Same durability as the file-operation journal: write a uniquely named
    // temp file, fsync it, then rename with a retry on transient Windows
    // codes (EPERM/EBUSY/EACCES). The previous writeFile + rename had no
    // fsync, so a crash right after the rename could still leave a torn
    // history behind on disk.
    await durableWriteJson(this.actionsPath, data);
  }

  _clearPendingSaveState() {
    this._pendingSaveTimer = null;
    this._pendingSavePromise = null;
    this._pendingSaveResolve = null;
    this._pendingSaveReject = null;
  }

  _cancelScheduledSave() {
    if (!this._pendingSaveTimer) {
      return false;
    }
    clearTimeout(this._pendingSaveTimer);
    const resolve = this._pendingSaveResolve;
    this._clearPendingSaveState();
    if (typeof resolve === 'function') {
      // Resolve any waiters since a caller is about to perform an immediate save.
      resolve();
    }
    return true;
  }

  _scheduleSaveActions() {
    if (this._saveDebounceMs <= 0) {
      return this.saveActions();
    }
    if (this._pendingSavePromise) {
      return this._pendingSavePromise;
    }

    this._pendingSavePromise = new Promise((resolve, reject) => {
      this._pendingSaveResolve = resolve;
      this._pendingSaveReject = reject;
    });

    this._pendingSaveTimer = setTimeout(async () => {
      const resolve = this._pendingSaveResolve;
      const reject = this._pendingSaveReject;
      this._pendingSaveTimer = null;
      try {
        await this.saveActions();
        if (typeof resolve === 'function') resolve();
      } catch (error) {
        if (typeof reject === 'function') reject(error);
      } finally {
        this._clearPendingSaveState();
      }
    }, this._saveDebounceMs);

    return this._pendingSavePromise;
  }

  async _saveActionsNow() {
    const canceledPendingTimer = this._cancelScheduledSave();
    if (!canceledPendingTimer && this._pendingSavePromise) {
      try {
        await this._pendingSavePromise;
      } catch (error) {
        logger.warn('[UndoRedoService] Pending scheduled save failed before forced flush', {
          error: error.message
        });
      }
    }
    await this.saveActions();
  }

  /**
   * Called by ServiceContainer during coordinated shutdown. Cancels any
   * debounced save timer and flushes a pending write synchronously so that
   * actions taken in the final moments of the session are never lost — the
   * historical failure mode was the debounce firing after teardown had
   * already set shutdown guards, at which point the save was silently skipped.
   */
  async shutdown() {
    // _saveActionsNow internally cancels the debounce timer (via
    // _cancelScheduledSave) and resolves any pending save promise BEFORE
    // running the synchronous flush, so the post-shutdown setTimeout-fire
    // hazard the audit flagged is already handled. Earlier we tried to also
    // clearTimeout here, but doing so without resolving the paired promise
    // caused _saveActionsNow's `await this._pendingSavePromise` branch to
    // hang forever — the test timeout caught the regression.
    try {
      await this._saveActionsNow();
    } catch (error) {
      logger.error('[UndoRedoService] Failed to flush pending save during shutdown', {
        error: error?.message || String(error)
      });
    }
  }

  /**
   * Promise-based mutex to serialize async operations that modify shared state.
   * Prevents race conditions when undo/redo/recordAction are called concurrently.
   * @private
   */
  async _withMutex(/** @type {any} */ fn) {
    const prev = this._mutex;
    /** @type {(v?: any) => void} */
    let resolve = () => {};
    this._mutex = new Promise((r) => {
      resolve = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      resolve();
    }
  }

  /**
   * Record an action in the undo history.
   *
   * @param {any} actionType
   * @param {any} actionData
   * @param {{ durable?: boolean }} [options] - `durable: true` force-flushes
   *   the actions file to disk before resolving (bypassing the debounced
   *   save). Callers that persist a reference to an on-disk artifact (e.g. a
   *   delete backup) MUST use this before performing the destructive fs op,
   *   otherwise a crash inside the debounce window leaves the artifact
   *   unreferenced and eligible for orphan cleanup.
   * @returns {Promise<string>} The recorded action's id.
   */
  async recordAction(
    /** @type {any} */ actionType,
    /** @type {any} */ actionData,
    /** @type {{ durable?: boolean }} */ options = {}
  ) {
    return this._withMutex(() => this._doRecordAction(actionType, actionData, options));
  }

  /**
   * Remove a previously recorded action by id and force-flush the change.
   *
   * Used to retract a durably pre-recorded action when the fs operation it
   * describes subsequently failed (e.g. FILE_DELETE is recorded before the
   * unlink; if the unlink then throws, leaving the action would offer an
   * undo that "restores" a file that was never deleted).
   *
   * @param {string} actionId
   * @returns {Promise<boolean>} true if an action was found and removed.
   */
  async removeAction(/** @type {string} */ actionId) {
    return this._withMutex(async () => {
      await this.initialize();
      const index = this.actions.findIndex((action) => action?.id === actionId);
      if (index === -1) {
        return false;
      }
      const [removed] = this.actions.splice(index, 1);
      if (index <= this.currentIndex) {
        this.currentIndex--;
      }
      this.currentMemoryEstimate = Math.max(
        0,
        this.currentMemoryEstimate - this._estimateActionSize(removed)
      );
      await this._saveActionsNow();
      logger.info('[UndoRedoService] Removed retracted action from history', {
        actionId,
        type: removed?.type
      });
      this._notifyStateChanged('remove');
      return true;
    });
  }

  /**
   * Whether an action carrying the given batch id already exists in history.
   * Organize records its batch undo with `data.batchId`; resume checks this
   * before re-recording so a crash between recordAction and the journal's
   * persistedAt marker can never produce a duplicate undo entry.
   */
  async hasBatchAction(/** @type {any} */ batchId, { includeDerived = false } = {}) {
    if (!batchId) return false;
    await this.initialize();
    const id = String(batchId);
    return this.actions.some((action) => {
      const recorded = action?.data?.batchId;
      if (recorded === undefined || recorded === null) return false;
      if (recorded === batchId) return true;
      // Resume paths record under ids derived from the live batch id
      // (`<id>:p<firstOp>` at startup, `<id>:r<ts>` for a renderer resume).
      // Any of them means the batch already has an undo entry.
      return includeDerived && String(recorded).startsWith(`${id}:`);
    });
  }

  /**
   * Whether the entries already recorded for a batch (under its own id or an
   * id derived from it) between them list every one of `operations`.
   * Resume paths record only the moves THEY performed, so a match on the
   * batch id alone says nothing about the moves at hand: a run resumed after
   * a pause must still get its own entry, while a retry after a crash
   * between recordAction and the journal marker must not double one.
   * @param {any} batchId
   * @param {Array<{ originalPath?: string, newPath?: string }>} operations
   */
  async hasBatchActionCovering(batchId, operations, { includeDerived = true } = {}) {
    if (!batchId || !Array.isArray(operations) || operations.length === 0) return false;
    const wanted = operations.filter((op) => batchOperationKey(op) !== null);
    if (wanted.length === 0) return false;
    const uncovered = await this.uncoveredBatchOperations(batchId, wanted, { includeDerived });
    return uncovered.length === 0;
  }

  /**
   * The subset of `operations` that no entry recorded for the batch (under its
   * own id or, with `includeDerived`, an id derived from it) lists yet: the
   * moves a resume persisting the union of done ops still owes an undo entry.
   * Same move identity as hasBatchActionCovering (original path + new path).
   * @template {{ originalPath?: string, newPath?: string }} T
   * @param {any} batchId
   * @param {T[]} operations
   * @param {{ includeDerived?: boolean }} [options]
   * @returns {Promise<T[]>}
   */
  async uncoveredBatchOperations(batchId, operations, { includeDerived = true } = {}) {
    if (!Array.isArray(operations)) return [];
    if (!batchId) return [...operations];
    await this.initialize();
    const id = String(batchId);
    const recordedKeys = new Set();
    for (const action of this.actions) {
      const recorded = action?.data?.batchId;
      if (recorded === undefined || recorded === null) continue;
      const matches =
        recorded === batchId || (includeDerived && String(recorded).startsWith(`${id}:`));
      if (!matches) continue;
      const ops = Array.isArray(action.data?.operations) ? action.data.operations : [];
      for (const op of ops) {
        const key = batchOperationKey(op);
        if (key !== null) recordedKeys.add(key);
      }
    }
    return operations.filter((op) => {
      const key = batchOperationKey(op);
      return key === null || !recordedKeys.has(key);
    });
  }

  /**
   * Subscribe to history changes that happen outside the undo/redo IPC
   * handlers (which notify their own sender). Returns an unsubscribe.
   * @param {(change: { reason: string }) => void} listener
   */
  onStateChanged(listener) {
    if (typeof listener !== 'function') return () => {};
    this._changeListeners.add(listener);
    return () => {
      this._changeListeners.delete(listener);
    };
  }

  /**
   * Tell listeners and every renderer window that history changed. Best
   * effort: the renderer re-reads the full state on receipt, so a missed
   * notification costs staleness, never correctness.
   * @param {string} reason
   */
  _notifyStateChanged(reason) {
    for (const listener of this._changeListeners) {
      try {
        listener({ reason });
      } catch (listenerErr) {
        logger.debug('[UndoRedoService] State listener threw', {
          error: /** @type {any} */ (listenerErr)?.message
        });
      }
    }
    try {
      const { BrowserWindow } = require('electron');
      if (typeof BrowserWindow?.getAllWindows !== 'function') return;
      const { safeSend } = require('../ipc/ipcWrappers');
      const { IPC_CHANNELS } = require('../../shared/constants');
      for (const win of BrowserWindow.getAllWindows()) {
        if (win?.isDestroyed?.()) continue;
        safeSend(win.webContents, IPC_CHANNELS.UNDO_REDO.STATE_CHANGED, { action: reason });
      }
    } catch (sendErr) {
      logger.debug('[UndoRedoService] State broadcast skipped', {
        error: /** @type {any} */ (sendErr)?.message
      });
    }
  }

  /**
   * Record a batch of child operations as a single undo entry.
   * Each child operation must carry its own `type` (e.g. 'move', 'rename', 'trash')
   * plus the paths needed to execute/reverse it.
   *
   * This is the public entry point for flows that perform many file operations
   * in one user action (e.g. Duplicate Finder "Delete selected", Downloads Triage
   * "Send to Trash"). Callers get exactly one undo step for the whole batch.
   */
  async recordBatch(
    /** @type {any} */ actionType,
    /** @type {any} */ operations,
    /** @type {{ summary?: string }} */ options = {}
  ) {
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new Error('recordBatch requires a non-empty operations array');
    }
    // Bound the array BEFORE acquiring the mutex. Previously the size check
    // ran inside _doRecordAction (post-mutex), so a million-entry array sat
    // in memory across the lock acquisition and any debug-logger JSON.stringify
    // along the way. Reject up front instead.
    if (operations.length > this.maxBatchSize) {
      throw new Error(
        `recordBatch operations array exceeds maxBatchSize (${operations.length} > ${this.maxBatchSize})`
      );
    }
    // Strip per-op shape to a known set so callers can't accidentally smuggle
    // multi-megabyte payloads (analysis blobs, embedding vectors) into the
    // history file. The persisted form is small JSON; anything richer should
    // live in its own service.
    const allowedOpKeys = new Set([
      'type',
      'originalPath',
      'newPath',
      'backupPath',
      'metadata',
      'analysisData'
    ]);
    const sanitizedOps = operations.map((/** @type {any} */ op) => {
      if (!op || typeof op !== 'object') {
        throw new Error('recordBatch: every operation must be an object');
      }
      /** @type {Record<string, any>} */
      const cleaned = {};
      for (const k of Object.keys(op)) {
        if (allowedOpKeys.has(k)) cleaned[k] = op[k];
      }
      return cleaned;
    });
    const data = {
      operations: sanitizedOps,
      summary: options.summary || null,
      recordedAt: new Date().toISOString()
    };
    return this.recordAction(actionType, data);
  }

  async _doRecordAction(
    /** @type {any} */ actionType,
    /** @type {any} */ actionData,
    /** @type {{ durable?: boolean }} */ options = {}
  ) {
    await this.initialize();

    // Fixed: Limit batch operation sizes to prevent memory issues
    if (
      (actionType === 'BATCH_ORGANIZE' ||
        actionType === 'BATCH_OPERATION' ||
        actionType === 'MOVE_BATCH' ||
        actionType === 'TRASH_BATCH') &&
      actionData.operations &&
      actionData.operations.length > this.maxBatchSize
    ) {
      logger.warn(
        `[UndoRedoService] Batch operation has ${actionData.operations.length} items, limiting to ${this.maxBatchSize}`
      );
      actionData = { ...actionData, operations: actionData.operations.slice(0, this.maxBatchSize) };
    }

    const action = {
      id: this.generateId(),
      type: actionType,
      timestamp: new Date().toISOString(),
      data: actionData,
      description: this.getActionDescription(actionType, actionData)
    };

    const actionSize = this._estimateActionSize(action);

    // Remove any actions after the current index (if we're not at the end)
    if (this.currentIndex < this.actions.length - 1) {
      const removedActions = this.actions.slice(this.currentIndex + 1);
      this.actions = this.actions.slice(0, this.currentIndex + 1);

      // Update memory estimate for removed actions
      removedActions.forEach((a) => {
        this.currentMemoryEstimate -= this._estimateActionSize(a);
      });
    }

    // Add the new action
    this.actions.push(action);
    this.currentIndex = this.actions.length - 1;
    this.currentMemoryEstimate += actionSize;

    // BUG FIX #7: Prevent infinite loop when single action exceeds memory limit
    // CRITICAL: If we only have 1 action and it's oversized, the while loop would run forever
    // We need to either truncate the single action OR accept it exceeds the limit
    const maxMemoryBytes = this.maxMemoryMB * 1024 * 1024;

    // Safety check: Prevent infinite loop by tracking iterations
    let pruneIterations = 0;
    const maxPruneIterations = this.maxActions + 10; // Safety margin

    while (
      this.actions.length > 1 && // Must have more than 1 to remove
      (this.actions.length > this.maxActions || this.currentMemoryEstimate > maxMemoryBytes) &&
      pruneIterations < maxPruneIterations // ESCAPE CONDITION
    ) {
      const removedAction = this.actions.shift();
      this.currentIndex--;
      this.currentMemoryEstimate -= this._estimateActionSize(removedAction);
      pruneIterations++;
    }

    // Check if we hit the iteration limit (should never happen, but log if it does)
    if (pruneIterations >= maxPruneIterations) {
      logger.error(
        `[UndoRedoService] Pruning loop hit safety limit at ${pruneIterations} iterations`,
        {
          actionsRemaining: this.actions.length,
          memoryEstimateMB: (this.currentMemoryEstimate / 1024 / 1024).toFixed(2),
          maxMemoryMB: this.maxMemoryMB
        }
      );
    }

    // BUG FIX #7: Handle single oversized action
    // If we only have 1 action left and it still exceeds the memory limit,
    // we have two options:
    // 1. Truncate the action data to fit within limits
    // 2. Clear the entire action history
    if (this.currentMemoryEstimate > maxMemoryBytes && this.actions.length === 1) {
      logger.warn(
        `[UndoRedoService] Single action exceeds memory limit (${(this.currentMemoryEstimate / 1024 / 1024).toFixed(2)}MB > ${this.maxMemoryMB}MB), truncating data`
      );

      // Truncate the action's data to prevent unbounded memory growth
      const largeAction = this.actions[0];
      const operationCount = largeAction.data?.operations?.length || 0;

      largeAction.data = {
        truncated: true,
        originalType: largeAction.type,
        originalOperationCount: operationCount,
        message: `Action data truncated due to size (${(this.currentMemoryEstimate / 1024 / 1024).toFixed(2)}MB)`,
        timestamp: largeAction.timestamp
      };

      // Recalculate memory estimate after truncation
      this._recalculateMemoryEstimate();

      // SAFETY CHECK: If still over limit after truncation, clear everything
      if (this.currentMemoryEstimate > maxMemoryBytes) {
        logger.error(
          `[UndoRedoService] Even after truncation, action exceeds memory limit. Clearing all undo history.`,
          {
            truncatedSizeMB: (this.currentMemoryEstimate / 1024 / 1024).toFixed(2),
            maxMemoryMB: this.maxMemoryMB
          }
        );
        this.actions = [];
        this.currentIndex = -1;
        this.currentMemoryEstimate = 0;
      }
    }

    // EDGE CASE: If we somehow have 0 actions but non-zero memory estimate, reset
    if (this.actions.length === 0 && this.currentMemoryEstimate !== 0) {
      logger.warn('[UndoRedoService] Memory estimate desync detected, resetting to 0');
      this.currentMemoryEstimate = 0;
    }

    if (options.durable) {
      // Force-flush before resolving so the action (and any backupPath it
      // references) is durable on disk BEFORE the caller performs the
      // destructive fs operation it describes.
      await this._saveActionsNow();
    } else if (this._saveDebounceMs <= 0) {
      await this.saveActions();
    } else {
      this._scheduleSaveActions().catch((error) => {
        logger.error('[UndoRedoService] Failed to persist scheduled undo/redo state', {
          error: error.message
        });
      });
    }
    this._notifyStateChanged('record');
    return action.id;
  }

  // Files are moved before the vector/history paths are remapped; the ghost
  // sweep must not delete embeddings for the old paths in that window.
  async undo() {
    return this._withMutex(() => withGhostCleanupDeferred(() => this._doUndo()));
  }

  async _doUndo() {
    await this.initialize();

    if (!this.canUndo()) {
      throw new Error('No actions to undo');
    }

    const action = this.actions[this.currentIndex];

    try {
      // Clear any previous operation results
      delete action._operationResults;

      await this.executeReverseAction(action);
      const operationResults = action._operationResults;
      delete action._operationResults;

      // Detect batch partial failure. Previously we always decremented
      // currentIndex, which silently moved the half-undone action onto
      // the redo stack and discarded everything above it — if the user
      // then hit redo, the forward path tried to move files whose sources
      // no longer existed, and the partial-failure information was lost.
      // Policy: any per-file failure in a batch undo keeps currentIndex
      // pinned so the action stays "undoable"; the caller receives the
      // per-op results and can decide whether to retry or accept the
      // partial state. Non-batch actions still advance the index on
      // success (executeReverseAction would have thrown otherwise).
      const hasPartialFailure = Boolean(
        operationResults &&
        operationResults.some((/** @type {any} */ r) => !r.success && !isExpectedTrashNoRestore(r))
      );

      // Nothing restored: every operation was a trash the OS keeps. Saying
      // "Undid: Send N files to Trash" here was false (audit row UR-14). The
      // entry cannot be reversed and a redo would re-trash files already in
      // the Trash, so drop it from history and report plainly.
      const trashOnly = Boolean(
        operationResults &&
        operationResults.length > 0 &&
        operationResults.every((/** @type {any} */ r) => isExpectedTrashNoRestore(r))
      );
      if (trashOnly) {
        this.actions.splice(this.currentIndex, 1);
        this.currentIndex--;
        this._recalculateMemoryEstimate();
        await this._saveActionsNow();
        const count = operationResults.length;
        logger.info('[UndoRedoService] Trash-only entry removed from history; nothing to restore', {
          actionId: action.id,
          count
        });
        return {
          success: false,
          code: 'TRASH_NO_RESTORE',
          removedFromHistory: true,
          action: {
            id: action.id,
            type: action.type,
            description: action.description,
            timestamp: action.timestamp
          },
          message:
            `Nothing restored: ${count} file${count === 1 ? ' is' : 's are'} in the system Trash. ` +
            'Restore from the Trash manually.',
          results: operationResults,
          successCount: 0,
          failCount: 0,
          operations: action.data?.operations || [],
          pathMutations: []
        };
      }
      const trashLeftBehind = operationResults
        ? operationResults.filter((/** @type {any} */ r) => isExpectedTrashNoRestore(r)).length
        : 0;

      // Always advance the cursor on completion — even when some operations
      // failed. Pinning the cursor was supposed to let the user retry, but
      // retrying just re-runs the same reverse on the (now-restored) majority
      // and immediately fails with ENOENT, leaving the cursor stuck forever
      // with no recovery path. Advancing + flagging `partial: true` lets the
      // renderer show "partially undone" with the per-op result list and
      // gives the user real options (manual fix, redo, ignore).
      this.currentIndex--;
      if (hasPartialFailure) {
        logger.warn(
          '[UndoRedoService] Batch undo completed with partial failures; advancing cursor and flagging partial',
          {
            actionId: action.id,
            total: operationResults.length,
            failed: operationResults.filter(
              (/** @type {any} */ r) => !r.success && !isExpectedTrashNoRestore(r)
            ).length
          }
        );
      }
      await this._saveActionsNow();

      // Build response with operation results for batch operations
      /** @type {Record<string, any>} */
      const response = {
        success: !hasPartialFailure,
        action: {
          id: action.id,
          type: action.type,
          description: action.description,
          timestamp: action.timestamp
        },
        message:
          (hasPartialFailure
            ? `Partially undid: ${action.description}`
            : `Undid: ${action.description}`) +
          (trashLeftBehind > 0
            ? ` (${trashLeftBehind} file${trashLeftBehind === 1 ? ' stays' : 's stay'} in the system Trash)`
            : ''),
        partial: hasPartialFailure
      };

      // Include operation results for batch operations (for UI state updates)
      if (operationResults) {
        response.results = operationResults;
        response.successCount = operationResults.filter((/** @type {any} */ r) => r.success).length;
        response.failCount = operationResults.filter(
          (/** @type {any} */ r) => !r.success && !isExpectedTrashNoRestore(r)
        ).length;
        this._attachIndexWarnings(response, operationResults);
        response.trashNotRestored = trashLeftBehind;
        // Include original operation data for state reconstruction
        response.operations = action.data?.operations || [];
      }

      // Normalized on-disk move list for the IPC layer to broadcast as
      // FILE_OPERATION_COMPLETE so renderer path listeners (graph/timeline
      // remap) fire for undo like they do for the forward operation.
      response.pathMutations = this._collectMoveMutations(action, operationResults, 'undo');

      return response;
    } catch (error) {
      logger.error('[UndoRedoService] Failed to undo action', {
        error: error.message
      });
      throw new Error(`Failed to undo action: ${error.message}`, { cause: error });
    }
  }

  /**
   * Normalized list of on-disk moves an undo/redo just performed, for the
   * IPC layer to broadcast as FILE_OPERATION_COMPLETE (the renderer's
   * graph/timeline listeners remap moved paths from it). Only move-shaped
   * mutations are reported: restorations create paths no renderer node
   * references, and trash undoes mutate nothing (TRASH_NO_RESTORE).
   * @param {any} action
   * @param {any[]|undefined} operationResults - per-op batch results, pushed in operations order
   * @param {'undo'|'redo'} direction - undo moves newPath->originalPath, redo the reverse
   * @returns {Array<{ oldPath: string, newPath: string }>}
   */
  _collectMoveMutations(action, operationResults, direction) {
    const flip = direction === 'undo';
    /** @type {Array<{ oldPath: string, newPath: string }>} */
    const pairs = [];
    const batchOps = Array.isArray(action?.data?.operations) ? action.data.operations : null;
    // Results are matched to operations by the opIndex each loop stamps on
    // them. Undo walks the batch backwards, so position alone would pair a
    // result with the wrong operation; results without an index (older
    // callers) are read in the order that loop produced them.
    /** @type {Map<number, any>} */
    const resultByOp = new Map();
    if (batchOps && Array.isArray(operationResults)) {
      const indexed = operationResults.every((r) => Number.isInteger(r?.opIndex));
      if (indexed) {
        for (const result of operationResults) resultByOp.set(result.opIndex, result);
      } else if (operationResults.length === batchOps.length) {
        operationResults.forEach((result, position) => {
          resultByOp.set(flip ? batchOps.length - 1 - position : position, result);
        });
      }
    }
    const pushOp = (/** @type {any} */ op, /** @type {number} */ index) => {
      if (!op || (op.type !== 'move' && op.type !== 'rename')) return;
      const from = flip ? op.newPath : op.originalPath;
      const to = flip ? op.originalPath : op.newPath;
      if (typeof from !== 'string' || !from || typeof to !== 'string' || !to) return;
      // Skip ops whose reverse/forward failed — those files did not move.
      if (resultByOp.size > 0 && resultByOp.get(index)?.success === false) return;
      pairs.push({ oldPath: from, newPath: to });
    };
    if (batchOps) {
      batchOps.forEach(pushOp);
    } else if (action?.type === 'FILE_MOVE') {
      pushOp(
        {
          type: 'move',
          originalPath: action.data?.originalPath,
          newPath: action.data?.newPath
        },
        -1
      );
    }
    return pairs;
  }

  async redo() {
    return this._withMutex(() => withGhostCleanupDeferred(() => this._doRedo()));
  }

  async _doRedo() {
    await this.initialize();

    if (!this.canRedo()) {
      throw new Error('No actions to redo');
    }

    const action = this.actions[this.currentIndex + 1];

    try {
      // Clear any previous operation results
      delete action._operationResults;

      await this.executeForwardAction(action);
      const operationResults = action._operationResults;
      delete action._operationResults;

      const hasPartialFailure = Boolean(
        operationResults &&
        operationResults.some((/** @type {any} */ r) => !r.success && !isExpectedTrashNoRestore(r))
      );

      // Same rationale as undo (above): advance on completion regardless of
      // partial state and let the renderer surface the per-op breakdown.
      this.currentIndex++;
      if (hasPartialFailure) {
        logger.warn(
          '[UndoRedoService] Batch redo completed with partial failures; advancing cursor and flagging partial',
          {
            actionId: action.id,
            total: operationResults.length,
            failed: operationResults.filter(
              (/** @type {any} */ r) => !r.success && !isExpectedTrashNoRestore(r)
            ).length
          }
        );
      }
      await this._saveActionsNow();

      // Build response with operation results for batch operations
      /** @type {Record<string, any>} */
      const response = {
        success: !hasPartialFailure,
        action: {
          id: action.id,
          type: action.type,
          description: action.description,
          timestamp: action.timestamp
        },
        message: hasPartialFailure
          ? `Partially redid: ${action.description}`
          : `Redid: ${action.description}`,
        partial: hasPartialFailure
      };

      // Include operation results for batch operations (for UI state updates)
      if (operationResults) {
        response.results = operationResults;
        response.successCount = operationResults.filter(
          (/** @type {any} */ r) => r.success || isExpectedTrashNoRestore(r)
        ).length;
        response.failCount = operationResults.filter(
          (/** @type {any} */ r) => !r.success && !isExpectedTrashNoRestore(r)
        ).length;
        // Include original operation data for state reconstruction
        response.operations = action.data?.operations || [];
      }

      // Same broadcast source as undo (see _collectMoveMutations).
      response.pathMutations = this._collectMoveMutations(action, operationResults, 'redo');

      return response;
    } catch (error) {
      logger.error('[UndoRedoService] Failed to redo action', {
        error: error.message
      });
      throw new Error(`Failed to redo action: ${error.message}`, { cause: error });
    }
  }

  canUndo() {
    return this.currentIndex >= 0;
  }

  canRedo() {
    return this.currentIndex < this.actions.length - 1;
  }

  /**
   * True when the file currently at a copy action's destination is (still)
   * the file the copy created, judged by recorded size + mtime. Actions
   * recorded before identity capture existed (no copiedSize) match
   * unconditionally, preserving their old behavior. Mtime uses a 2s
   * tolerance for coarse filesystems (FAT).
   * @param {any} data - action.data of a FILE_COPY action
   * @param {import('fs').Stats} stat - stat of the current occupant
   * @returns {boolean}
   */
  _copyIdentityMatches(data, stat) {
    if (!Number.isFinite(data?.copiedSize)) return true;
    if (stat.size !== data.copiedSize) return false;
    if (
      Number.isFinite(data?.copiedMtimeMs) &&
      Math.abs(stat.mtimeMs - data.copiedMtimeMs) > 2000
    ) {
      return false;
    }
    return true;
  }

  async executeReverseAction(/** @type {any} */ action) {
    switch (action.type) {
      case 'FILE_MOVE':
        // Move file back to original location
        await this.safeMove(action.data.newPath, action.data.originalPath);
        // Update vector DB path. The folder metadata follows the file as it
        // does in the batch loops: the move stamped its Smart Folder onto the
        // row and the history entry, and the file is no longer there.
        await this.updateVectorDbPath(action.data.newPath, action.data.originalPath, {
          folderMeta: await this._folderMetaForDestination(action.data.originalPath)
        });
        break;

      case 'FILE_COPY': {
        // Undo a copy: remove the copied destination (the source at originalPath
        // is untouched by the copy). Trash it rather than hard-delete so the
        // undo is itself recoverable; idempotent if it was already removed.
        const copyDest = action.data.newPath;
        /** @type {import('fs').Stats} */
        let destStat;
        try {
          destStat = await fs.stat(copyDest);
        } catch {
          break; // destination already gone — nothing to undo
        }
        // Identity check: only trash the file we actually copied. A user's
        // new file saved at this path after the undo (or an edited/replaced
        // copy) must not be sent to the Trash by a stale undo entry.
        if (!this._copyIdentityMatches(action.data, destStat)) {
          const identityErr = /** @type {Error & { code?: string }} */ (
            new Error(
              `Cannot undo copy: the file at ${copyDest} is no longer the copied file (it was modified or replaced)`
            )
          );
          identityErr.code = 'UNDO_TARGET_CHANGED';
          throw identityErr;
        }
        const { TrashService } = require('./TrashService');
        const trasher = new TrashService();
        const trashResult = await trasher.trashOne(copyDest);
        if (!trashResult.success) {
          throw new Error(trashResult.error || 'Cannot undo copy: failed to trash the copied file');
        }
        // The copy cloned vector-DB + analysis-history entries for the
        // destination (FilePathCoordinator.handleFileCopy); remove them so
        // search/graph stop surfacing the trashed path. Best-effort — the
        // file removal is the user-visible undo.
        try {
          await getFilePathCoordinator()?.handleFileDeletion?.(copyDest, { type: 'undo_redo' });
        } catch (cleanupErr) {
          logger.debug('[UndoRedoService] Copy-undo DB cleanup failed (non-fatal)', {
            error: /** @type {any} */ (cleanupErr)?.message
          });
        }
        break;
      }

      case 'FILE_RENAME':
        // Rename file back to original name
        await this.safeMove(action.data.newPath, action.data.originalPath);
        // Update vector DB path
        await this.updateVectorDbPath(action.data.newPath, action.data.originalPath);
        break;

      case 'FILE_DELETE': {
        // Previous code didn't persist backup paths immediately, risking data loss on crashes
        // Now we check multiple backup locations and provide detailed error information
        if (!action.data.backupPath) {
          throw new Error(
            'Cannot restore deleted file - no backup path was recorded. ' +
              'File may have been permanently deleted without backup. ' +
              `Original path: ${action.data.originalPath}`
          );
        }

        const backupExists = await this.fileExists(action.data.backupPath);
        if (!backupExists) {
          // CRITICAL: Backup path was recorded but file doesn't exist
          // This indicates either: backup failed, backup was deleted, or path is incorrect
          logger.error('[UndoRedoService] Backup file not found at expected location', {
            backupPath: action.data.backupPath,
            originalPath: action.data.originalPath,
            actionId: action.id,
            timestamp: action.timestamp
          });

          throw new Error(
            `Cannot restore deleted file - backup not found at expected location.\n` +
              `Original file: ${action.data.originalPath}\n` +
              `Expected backup: ${action.data.backupPath}\n` +
              `This may indicate the backup was never created, was deleted, or the path is incorrect.\n` +
              `Action ID: ${action.id}, Timestamp: ${action.timestamp}`
          );
        }

        // Restore file from backup
        logger.info('[UndoRedoService] Restoring file from backup', {
          from: action.data.backupPath,
          to: action.data.originalPath
        });

        await this.safeMove(action.data.backupPath, action.data.originalPath);
        break;
      }

      case 'FOLDER_CREATE':
        // Remove the created folder (if empty)
        try {
          const folderPath = await this._validateActionPath(
            action.data.folderPath,
            'folder-create-path'
          );
          await fs.rmdir(folderPath);
        } catch (error) {
          // Folder might not be empty, try to restore to original state
          logger.warn(
            `[UndoRedoService] Could not remove folder, might contain files: ${error.message}`
          );
        }
        break;

      case 'BATCH_ORGANIZE':
      case 'BATCH_OPERATION':
      case 'MOVE_BATCH':
      case 'TRASH_BATCH': {
        // Backwards/forwards compatibility with shared ACTION_TYPES
        // Reverse each file operation in the batch with result tracking
        const operations = Array.isArray(action.data?.operations) ? action.data.operations : null;
        if (!operations) {
          const reason = action.data?.truncated
            ? 'Cannot undo truncated batch action data'
            : 'Cannot undo batch action with invalid operations data';
          throw new Error(reason);
        }
        const pathChanges = [];
        const operationResults = [];

        for (let opIndex = operations.length - 1; opIndex >= 0; opIndex--) {
          const operation = operations[opIndex];
          try {
            const result = await this.reverseFileOperation(operation);
            operationResults.push({
              ...result,
              opIndex,
              originalPath: operation.originalPath,
              newPath: operation.newPath,
              type: operation.type
            });
            if (result.success && (operation.type === 'move' || operation.type === 'rename')) {
              const change = { oldPath: operation.newPath, newPath: operation.originalPath };
              // Update the index for this file now rather than once after the
              // loop: a crash, shutdown or later-op failure mid-batch must not
              // leave files already moved back pointing at stale vector rows.
              // The folder metadata follows the file too: the organize wrote
              // its Smart Folder onto the row and history, and the file is
              // no longer there.
              const sync = await this.updateVectorDbPath(change.oldPath, change.newPath, {
                rebuildSearchIndex: false,
                folderMeta: await this._folderMetaForDestination(change.newPath)
              });
              this._noteIndexSync(operationResults[operationResults.length - 1], sync);
              pathChanges.push(change);
            }
          } catch (error) {
            logger.warn('[UndoRedoService] Operation failed during undo', {
              operation,
              error: error.message
            });
            operationResults.push({
              success: false,
              opIndex,
              originalPath: operation.originalPath,
              newPath: operation.newPath,
              type: operation.type,
              error: error.message
            });
          }
        }
        // Per-op updates above skipped the search rebuild; run it once here.
        if (pathChanges.length > 0) {
          this._requestSearchIndexRebuild({ reason: 'undo-redo-batch', count: pathChanges.length });
        }
        // The batch taught the feedback memory where these files belong; the
        // user just said otherwise (F-202 / K-12). Retract per reverted move.
        await this._retractLearningForRevertedMoves(pathChanges);
        // Store results for return
        action._operationResults = operationResults;
        break;
      }

      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  }

  async executeForwardAction(/** @type {any} */ action) {
    switch (action.type) {
      case 'FILE_MOVE':
        // Move file to new location
        await this.safeMove(action.data.originalPath, action.data.newPath);
        // Update vector DB path, stamping the destination's Smart Folder again.
        await this.updateVectorDbPath(action.data.originalPath, action.data.newPath, {
          folderMeta: await this._folderMetaForDestination(action.data.newPath)
        });
        break;

      case 'FILE_COPY': {
        // Redo a copy: re-copy source -> destination. The source is untouched by
        // undo, so this reproduces the original file. Refuse to overwrite an
        // occupied destination (COPYFILE_EXCL); idempotent if it already exists.
        const copySrc = await this._validateActionPath(action.data.originalPath, 'copy-source');
        const copyDest = await this._validateActionPath(action.data.newPath, 'copy-destination');
        if (!(await this.fileExists(copySrc))) {
          const missingErr = /** @type {Error & { code?: string }} */ (
            new Error(`Cannot redo copy: source no longer exists: ${copySrc}`)
          );
          missingErr.code = 'UNDO_SOURCE_MISSING';
          throw missingErr;
        }
        try {
          const occupantStat = await fs.stat(copyDest);
          // Only treat an occupied destination as "copy already present" when
          // it IS our copy; an unrelated file that appeared here must not be
          // silently adopted (a later undo would trash it).
          if (this._copyIdentityMatches(action.data, occupantStat)) {
            break; // destination already present — redo is a no-op
          }
          const occupiedErr = /** @type {Error & { code?: string }} */ (
            new Error(`Cannot redo copy: an unrelated file now occupies ${copyDest}`)
          );
          occupiedErr.code = 'REDO_TARGET_OCCUPIED';
          throw occupiedErr;
        } catch (statErr) {
          if (/** @type {any} */ (statErr)?.code === 'REDO_TARGET_OCCUPIED') throw statErr;
          // stat failed → destination absent; proceed with the re-copy.
        }
        await this.ensureParentDirectory(copyDest);
        const { constants: fsConstants } = require('fs');
        await fs.copyFile(copySrc, copyDest, fsConstants.COPYFILE_EXCL);
        // Refresh the recorded identity: the re-copy has a fresh mtime, and
        // the next undo must recognize it. Re-clone the DB entries the undo
        // removed. Both best-effort.
        try {
          const redoneStat = await fs.stat(copyDest);
          action.data.copiedSize = redoneStat.size;
          action.data.copiedMtimeMs = redoneStat.mtimeMs;
          await this.saveActions?.();
        } catch {
          /* identity refresh is best-effort */
        }
        try {
          await getFilePathCoordinator()?.handleFileCopy?.(copySrc, copyDest);
        } catch (cloneErr) {
          logger.debug('[UndoRedoService] Copy-redo DB re-clone failed (non-fatal)', {
            error: /** @type {any} */ (cloneErr)?.message
          });
        }
        break;
      }

      case 'FILE_RENAME':
        // Rename file to new name
        await this.safeMove(action.data.originalPath, action.data.newPath);
        // Update vector DB path
        await this.updateVectorDbPath(action.data.originalPath, action.data.newPath);
        break;

      case 'FILE_DELETE':
        // Delete file again (move to backup if configured)
        if (action.data.createBackup) {
          await this.safeMove(action.data.originalPath, action.data.backupPath);
        } else {
          const originalPath = await this._validateActionPath(
            action.data.originalPath,
            'file-delete-path'
          );
          await fs.unlink(originalPath);
        }
        break;

      case 'FOLDER_CREATE':
        // Create the folder again
        await fs.mkdir(
          await this._validateActionPath(action.data.folderPath, 'folder-create-path'),
          { recursive: true }
        );
        break;

      case 'BATCH_ORGANIZE':
      case 'BATCH_OPERATION':
      case 'MOVE_BATCH':
      case 'TRASH_BATCH': {
        // Backwards/forwards compatibility with shared ACTION_TYPES
        // Re-execute each file operation in the batch with result tracking
        const operations = Array.isArray(action.data?.operations) ? action.data.operations : null;
        if (!operations) {
          const reason = action.data?.truncated
            ? 'Cannot redo truncated batch action data'
            : 'Cannot redo batch action with invalid operations data';
          throw new Error(reason);
        }
        const pathChanges = [];
        const operationResults = [];

        for (let opIndex = 0; opIndex < operations.length; opIndex++) {
          const operation = operations[opIndex];
          try {
            await this.executeFileOperation(operation);
            operationResults.push({
              success: true,
              opIndex,
              source: operation.originalPath,
              destination: operation.newPath,
              type: operation.type
            });
            if (operation.type === 'move' || operation.type === 'rename') {
              const change = { oldPath: operation.originalPath, newPath: operation.newPath };
              // Same per-op discipline as undo: the index follows each file
              // as it moves, not after the whole batch has finished.
              const sync = await this.updateVectorDbPath(change.oldPath, change.newPath, {
                rebuildSearchIndex: false,
                folderMeta: await this._folderMetaForDestination(change.newPath)
              });
              this._noteIndexSync(operationResults[operationResults.length - 1], sync);
              pathChanges.push(change);
            }
          } catch (error) {
            logger.warn('[UndoRedoService] Operation failed during redo', {
              operation,
              error: error.message
            });
            operationResults.push({
              success: false,
              opIndex,
              source: operation.originalPath,
              destination: operation.newPath,
              type: operation.type,
              error: error.message
            });
          }
        }
        // Per-op updates above skipped the search rebuild; run it once here.
        if (pathChanges.length > 0) {
          this._requestSearchIndexRebuild({ reason: 'undo-redo-batch', count: pathChanges.length });
        }
        // Store results for return
        action._operationResults = operationResults;
        break;
      }

      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  }

  async reverseFileOperation(/** @type {any} */ operation) {
    switch (operation.type) {
      case 'move':
        await this.safeMove(operation.newPath, operation.originalPath);
        return {
          success: true,
          source: operation.newPath,
          destination: operation.originalPath
        };
      case 'rename':
        await this.safeMove(operation.newPath, operation.originalPath);
        return {
          success: true,
          source: operation.newPath,
          destination: operation.originalPath
        };
      case 'delete':
        if (operation.backupPath && (await this.fileExists(operation.backupPath))) {
          await this.safeMove(operation.backupPath, operation.originalPath);
          return { success: true, restored: operation.originalPath };
        }
        return { success: false, error: 'Backup not found' };
      case 'trash':
        // Electron does not expose a programmatic restore-from-trash API.
        // Surface a structured non-success so the UI can tell the user the
        // items are in the OS trash and must be restored manually.
        return {
          success: false,
          code: 'TRASH_NO_RESTORE',
          error: 'Restore from system Trash manually',
          originalPath: operation.originalPath
        };
      default:
        return {
          success: false,
          error: `Unknown operation type: ${operation.type}`
        };
    }
  }

  async executeFileOperation(/** @type {any} */ operation) {
    switch (operation.type) {
      case 'move':
        await this.safeMove(operation.originalPath, operation.newPath);
        break;
      case 'rename':
        await this.safeMove(operation.originalPath, operation.newPath);
        break;
      case 'delete':
        if (operation.createBackup) {
          await this.safeMove(operation.originalPath, operation.backupPath);
        } else {
          const originalPath = await this._validateActionPath(
            operation.originalPath,
            'batch-delete-path'
          );
          await fs.unlink(originalPath);
        }
        break;
      case 'trash': {
        // Forward (redo) path for a previously-trashed item. If the file was
        // restored manually it will be at originalPath; re-trash via shell.
        // If it's not there, treat as already-trashed (idempotent).
        try {
          await fs.access(operation.originalPath);
        } catch {
          return; // already gone — redo is a no-op
        }
        const { TrashService } = require('./TrashService');
        const trasher = new TrashService();
        const result = await trasher.trashOne(operation.originalPath);
        if (!result.success) {
          throw new Error(result.error || 'Trash redo failed');
        }
        break;
      }
    }
  }

  async fileExists(/** @type {any} */ filePath) {
    const normalizedPath = await this._validateActionPath(filePath, 'exists-check-path');
    try {
      await fs.access(normalizedPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Retract the learning feedback a batch organize recorded for each move
   * that was just reverted (F-202 / K-12). `pathChanges` are the undo pairs
   * ({ oldPath: whereItLanded, newPath: whereItCameFrom }); feedback was keyed
   * on where it landed. Best effort; never fails the undo.
   * @private
   * @param {Array<{ oldPath: string, newPath: string }>} pathChanges
   */
  async _retractLearningForRevertedMoves(pathChanges) {
    if (!Array.isArray(pathChanges) || pathChanges.length === 0) return;
    let learning;
    try {
      learning = container.tryResolve(ServiceIds.LEARNING_FEEDBACK);
    } catch {
      learning = null;
    }
    if (!learning || typeof learning.retractFileFeedback !== 'function') return;
    for (const change of pathChanges) {
      if (!change?.oldPath) continue;
      try {
        await learning.retractFileFeedback(change.oldPath);
      } catch (error) {
        logger.debug('[UndoRedoService] Feedback retraction failed (non-fatal)', {
          path: change.oldPath,
          error: /** @type {any} */ (error)?.message
        });
      }
    }
  }

  /**
   * Ask the search service for a deferred index rebuild. Fire-and-forget and
   * never throws; the rebuild is a consistency nicety, not part of the move.
   * @private
   * @param {{ reason: string, oldPath?: string, newPath?: string, count?: number }} detail
   */
  _requestSearchIndexRebuild(detail) {
    try {
      const searchService = container.tryResolve(ServiceIds.SEARCH_SERVICE);
      if (searchService?.invalidateAndRebuild) {
        searchService
          .invalidateAndRebuild({ immediate: false, ...detail })
          .catch((/** @type {any} */ err) => {
            logger.debug('[UndoRedoService] Search index rebuild failed (non-fatal)', {
              reason: detail.reason,
              error: err.message
            });
          });
      }
    } catch {
      // Non-fatal
    }
  }

  /**
   * Update vector DB path after file move
   * @param {string} oldPath - Original file path
   * @param {string} newPath - New file path
   * @param {{ rebuildSearchIndex?: boolean, folderMeta?: Record<string, any>|null }} [options]
   *   Batch callers pass `rebuildSearchIndex: false` and request one rebuild
   *   after the loop. `folderMeta` is the destination's Smart Folder context
   *   (or `{ clearSmartFolder: true }`) so the vector row and the history
   *   entry follow the file, not only its path.
   * @returns {Promise<{ synced: boolean, warning?: string }>}
   */
  async updateVectorDbPath(oldPath, newPath, options = {}) {
    const rebuildSearchIndex = options?.rebuildSearchIndex !== false;
    try {
      const coordinator = getFilePathCoordinator();
      if (coordinator) {
        const outcome = await coordinator.atomicPathUpdate(oldPath, newPath, {
          type: 'undo_redo',
          skipProcessingState: true,
          folderMeta: options?.folderMeta || null
        });
        // The coordinator emits Orama's search-data-mutated, which only
        // drops the result cache; the BM25 index itself refreshed on its
        // 15-minute staleness timer, so keyword search kept answering with
        // the pre-undo path. Ask for the rebuild here as the fallback does.
        if (rebuildSearchIndex) {
          this._requestSearchIndexRebuild({ reason: 'undo-redo-move', oldPath, newPath });
        }
        if (outcome && outcome.success === false) {
          const systems = Array.isArray(outcome.errors)
            ? outcome.errors.map((/** @type {any} */ e) => e?.system).filter(Boolean)
            : [];
          return {
            synced: false,
            warning: `Index not fully updated for ${path.basename(newPath)}${systems.length ? ` (${systems.join(', ')})` : ''}`
          };
        }
        return { synced: true };
      }

      const vectorDb = getVectorDbService();
      if (vectorDb) {
        const updates = buildPathUpdatePairs(oldPath, newPath);
        await vectorDb.updateFilePaths(updates);
      }

      // Keep pending embedding queue IDs consistent with undo/redo moves too.
      try {
        const embeddingQueue = require('../analysis/embeddingQueue/queueManager');
        embeddingQueue.updateByFilePath?.(oldPath, newPath);
      } catch {
        // Non-fatal
      }

      if (rebuildSearchIndex) {
        this._requestSearchIndexRebuild({ reason: 'undo-redo-move', oldPath, newPath });
      }
      return { synced: true };
    } catch (error) {
      // Non-fatal - log but don't fail the undo/redo
      logger.warn('[UndoRedoService] Failed to update vector DB path', {
        oldPath,
        newPath,
        error: error.message
      });
      return { synced: false, warning: `Index not updated for ${path.basename(newPath)}` };
    }
  }

  /**
   * Folder metadata for a file that just landed at `destinationPath`: the
   * Smart Folder containing it, or an explicit clear when none does.
   * Best-effort; null leaves the row's folder fields alone.
   * @param {string} destinationPath
   * @returns {Promise<Record<string, any>|null>}
   */
  async _folderMetaForDestination(destinationPath) {
    try {
      const { loadCustomFolders } = require('../core/customFolders');
      const { findContainingSmartFolder } = require('../../shared/folderUtils');
      const folders = await loadCustomFolders();
      const containing = findContainingSmartFolder(destinationPath, folders);
      if (containing?.path) {
        return {
          newSmartFolder: containing.name,
          newSmartFolderPath: containing.path,
          newCategory: containing.name
        };
      }
      return { clearSmartFolder: true };
    } catch (error) {
      logger.debug('[UndoRedoService] Could not resolve folder metadata for restore', {
        error: /** @type {any} */ (error)?.message
      });
      return null;
    }
  }

  /**
   * Record on a per-op result whether the indexes followed the move.
   * @param {any} opResult
   * @param {{ synced?: boolean, warning?: string }|null|undefined} sync
   */
  _noteIndexSync(opResult, sync) {
    if (!opResult || !sync) return;
    opResult.indexSynced = sync.synced !== false;
    if (sync.synced === false && sync.warning) opResult.warning = sync.warning;
  }

  /**
   * A batch whose files moved but whose index updates did not all land is
   * partial, and says so, instead of reporting a clean success while search
   * and history still point at the old paths.
   * @param {Record<string, any>} response
   * @param {any[]} operationResults
   */
  _attachIndexWarnings(response, operationResults) {
    const warnings = operationResults
      .filter((/** @type {any} */ r) => r?.indexSynced === false)
      .map((/** @type {any} */ r) => r.warning)
      .filter(Boolean);
    if (warnings.length === 0) return;
    response.warnings = warnings;
    response.partial = true;
    response.message += ` (${warnings.length} index update${warnings.length === 1 ? '' : 's'} incomplete)`;
  }

  /**
   * Batch update vector DB paths
   * @param {Array<{oldPath: string, newPath: string}>} pathChanges
   */
  async updateVectorDbPaths(pathChanges) {
    if (!pathChanges || pathChanges.length === 0) return;

    try {
      const coordinator = getFilePathCoordinator();
      if (coordinator) {
        await coordinator.batchPathUpdate(pathChanges, { type: 'undo_redo' });
        return;
      }

      const vectorDb = getVectorDbService();
      if (vectorDb) {
        const updates = pathChanges.flatMap(({ oldPath, newPath }) =>
          buildPathUpdatePairs(oldPath, newPath)
        );
        await vectorDb.updateFilePaths(updates);
      }

      // Also update any pending embeddings in the queue (so they flush under the new IDs).
      try {
        const embeddingQueue = require('../analysis/embeddingQueue/queueManager');
        embeddingQueue.updateByFilePaths?.(pathChanges);
      } catch {
        // Non-fatal
      }

      this._requestSearchIndexRebuild({ reason: 'undo-redo-batch', count: pathChanges.length });
    } catch (error) {
      logger.warn('[UndoRedoService] Failed to batch update vector DB paths', {
        count: pathChanges.length,
        error: error.message
      });
    }
  }

  /**
   * CRITICAL FIX (BUG #2): Create backup for file deletion with immediate persistence
   * This ensures backups are created and tracked BEFORE the actual deletion occurs
   *
   * @param {string} filePath - Path to file to backup
   * @returns {Promise<string>} Path to backup file
   */
  /**
   * Public createBackup. NON-REENTRANT — do NOT call from inside another
   * mutex-held section (e.g. _doRecordAction). The promise-based mutex used
   * here doesn't track the holding "thread" and will deadlock. Internal
   * callers that already hold the lock should use _createBackupInternal
   * directly.
   */
  async createBackup(/** @type {any} */ filePath) {
    return this._withMutex(() => this._createBackupInternal(filePath));
  }

  async _createBackupInternal(/** @type {any} */ filePath) {
    const normalizedPath = await this._validateActionPath(filePath, 'backup-source-path');
    const backupDir = await this._validateActionPath(
      path.join(this.userDataPath, 'undo-backups'),
      'backup-directory'
    );
    await this.ensureParentDirectory(path.join(backupDir, 'dummy'));

    // Create unique backup filename with timestamp and secure random component
    const originalName = path.basename(normalizedPath);
    const timestamp = Date.now();
    const randomId = crypto.randomBytes(4).toString('hex');
    const backupName = `${timestamp}_${randomId}_${originalName}`;
    const backupPath = await this._validateActionPath(
      path.join(backupDir, backupName),
      'backup-target-path'
    );

    // Verify source file exists before attempting backup
    if (!(await this.fileExists(normalizedPath))) {
      throw new Error(`Cannot create backup - source file does not exist: ${filePath}`);
    }

    try {
      // Create backup using safeMove which includes verification
      await fs.copyFile(normalizedPath, backupPath);

      // Verify backup was created successfully
      const [sourceStats, backupStats] = await Promise.all([
        fs.stat(normalizedPath),
        fs.stat(backupPath)
      ]);

      if (sourceStats.size !== backupStats.size) {
        await fs.unlink(backupPath).catch((unlinkError) => {
          logger.warn('Failed to cleanup backup file after size mismatch', {
            backupPath,
            error: unlinkError.message
          });
        });
        throw new Error(
          `Backup verification failed - size mismatch (source: ${sourceStats.size}, backup: ${backupStats.size})`
        );
      }

      logger.info('[UndoRedoService] Created backup successfully', {
        original: normalizedPath,
        backup: backupPath,
        size: sourceStats.size
      });

      // CRITICAL: Immediately persist the backup path to disk BEFORE deleting the original
      // This ensures we can recover even if the process crashes
      await this._saveActionsNow();

      return backupPath;
    } catch (error) {
      // Clean up failed backup attempt
      await fs.unlink(backupPath).catch((unlinkError) => {
        logger.warn('Failed to cleanup backup file after backup creation error', {
          backupPath,
          error: unlinkError.message
        });
      });
      throw new Error(`Failed to create backup: ${error.message}`, { cause: error });
    }
  }

  /**
   * CRITICAL FIX (BUG #2): Clean up old backup files to prevent unbounded disk usage
   * Call this periodically to remove backups for actions that are no longer in history
   */
  async cleanupOldBackups() {
    const backupDir = path.join(this.userDataPath, 'undo-backups');

    // The live history is unreadable and still in place (see
    // _preserveUnreadableHistory). Only that file knows which backups the
    // user's recorded deletes point at, and it is not one of the set-aside
    // names read below, so the sweep would reap every one of them older
    // than the age gate. Stand down until saveActions has moved it aside.
    if (this._shieldedHistoryPath) {
      logger.warn(
        '[UndoRedoService] Skipping backup cleanup; unreadable undo history still holds the only references',
        { path: this.actionsPath }
      );
      return { removed: 0, errors: 0, skippedYoung: 0 };
    }
    // The file was set aside, but set aside is not the same as readable:
    // until the copy has parsed once, its references are unknown and the
    // sweep would reap every backup it names. Stand down until it reads.
    if (this._unverifiedSetAsidePath && !(await this._verifySetAsideHistory())) {
      return { removed: 0, errors: 0, skippedYoung: 0 };
    }

    try {
      await fs.access(backupDir);
    } catch {
      // Backup directory doesn't exist, nothing to clean
      return { removed: 0, errors: 0 };
    }

    // Get all backup paths currently referenced in actions
    const referencedBackups = new Set();
    for (const action of this.actions) {
      if (action.data?.backupPath) {
        referencedBackups.add(path.basename(action.data.backupPath));
      }
      if (action.data?.operations) {
        for (const op of action.data.operations) {
          if (op.backupPath) {
            referencedBackups.add(path.basename(op.backupPath));
          }
        }
      }
    }
    // A history file set aside by loadActions (unparseable or unreadable)
    // still references backups a user may recover by hand. They stay out
    // of the sweep for as long as that file sits beside the live one.
    await this._collectSetAsideBackupRefs(referencedBackups);

    // Find and remove unreferenced backups. AGE GATE: an unreferenced
    // backup younger than BACKUP_ORPHAN_MIN_AGE_MS is spared — it may be the
    // only surviving copy of a file whose FILE_DELETE action never reached
    // disk (crash inside the debounced-save window). See the constant's
    // comment for the full rationale.
    const files = await fs.readdir(backupDir);
    let removed = 0;
    let errors = 0;
    let skippedYoung = 0;

    for (const file of files) {
      if (referencedBackups.has(file)) {
        continue;
      }
      const ageMs = await this._backupAgeMs(backupDir, file);
      if (ageMs === null || ageMs < BACKUP_ORPHAN_MIN_AGE_MS) {
        // Unknown age also counts as "too young": when we can't prove the
        // backup is stale, keeping it is the only safe choice — it might be
        // someone's last copy of a deleted file.
        skippedYoung++;
        continue;
      }
      try {
        await fs.unlink(path.join(backupDir, file));
        removed++;
        logger.info(`[UndoRedoService] Removed orphaned backup: ${file}`);
      } catch (error) {
        errors++;
        logger.warn(`[UndoRedoService] Failed to remove orphaned backup ${file}:`, error.message);
      }
    }

    logger.info(
      `[UndoRedoService] Backup cleanup complete - removed ${removed} orphaned backups, ${errors} errors, ${skippedYoung} kept (younger than age gate or unknown age)`
    );
    return { removed, errors, skippedYoung };
  }

  /**
   * Read the history copy _preserveUnreadableHistory set aside. True once
   * it parses, after which _collectSetAsideBackupRefs can be trusted to
   * find its references; false (and a warning) while it still cannot be
   * read, so the sweep keeps standing down.
   * @private
   * @returns {Promise<boolean>}
   */
  async _verifySetAsideHistory() {
    const setAsidePath = this._unverifiedSetAsidePath;
    if (!setAsidePath) return true;
    let reason;
    try {
      const parsed = tryJsonParse(await fs.readFile(setAsidePath, 'utf8'));
      if (parsed.success && parsed.value && typeof parsed.value === 'object') {
        this._unverifiedSetAsidePath = null;
        return true;
      }
      reason = parsed.error?.message || 'not a JSON object';
    } catch (error) {
      reason = /** @type {any} */ (error)?.message;
    }
    logger.warn(
      '[UndoRedoService] Skipping backup cleanup; set-aside undo history still cannot be read',
      { quarantinePath: setAsidePath, error: reason }
    );
    return false;
  }

  /**
   * Add the backup basenames named in any `undo-actions.json.corrupt.*` or
   * `.unreadable.*` sibling to `referencedBackups`. Tolerant of broken JSON:
   * the `"backupPath": "..."` pairs are lifted straight from the text.
   * @private
   * @param {Set<string>} referencedBackups
   * @returns {Promise<number>} references found
   */
  async _collectSetAsideBackupRefs(referencedBackups) {
    const dir = path.dirname(this.actionsPath);
    const base = path.basename(this.actionsPath);
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      return 0;
    }
    let found = 0;
    for (const name of names) {
      if (!name.startsWith(`${base}.corrupt.`) && !name.startsWith(`${base}.unreadable.`)) {
        continue;
      }
      let text;
      try {
        text = await fs.readFile(path.join(dir, name), 'utf8');
      } catch {
        continue;
      }
      for (const match of text.matchAll(/"backupPath"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
        let value = match[1];
        try {
          value = JSON.parse(`"${value}"`);
        } catch {
          // Keep the raw text; a basename is still better than nothing.
        }
        if (value) {
          referencedBackups.add(path.basename(value));
          found++;
        }
      }
    }
    if (found > 0) {
      logger.info('[UndoRedoService] Backups named by set-aside undo history kept', { found });
    }
    return found;
  }

  /**
   * Best-effort age of a backup file in milliseconds.
   *
   * Prefers the millisecond-timestamp prefix that _createBackupInternal
   * embeds in every backup filename (`<ts>_<rand>_<name>`); falls back to
   * the file's mtime. Returns null when neither is available so the caller
   * can fail closed (keep the file).
   *
   * @param {string} backupDir
   * @param {string} fileName
   * @returns {Promise<number|null>}
   */
  async _backupAgeMs(backupDir, fileName) {
    const prefixMatch = /^(\d{10,})_/.exec(fileName);
    if (prefixMatch) {
      const createdAt = Number(prefixMatch[1]);
      if (Number.isFinite(createdAt) && createdAt > 0) {
        return Date.now() - createdAt;
      }
    }
    try {
      const stats = await fs.stat(path.join(backupDir, fileName));
      return Date.now() - stats.mtimeMs;
    } catch {
      return null;
    }
  }

  getActionDescription(/** @type {any} */ actionType, /** @type {any} */ actionData) {
    const safe = actionData && typeof actionData === 'object' ? actionData : {};
    switch (actionType) {
      case 'FILE_MOVE':
        return `Move ${path.basename(safe.originalPath || '')} to ${path.dirname(safe.newPath || '')}`;
      case 'FILE_COPY':
        return `Copy ${path.basename(safe.originalPath || '')} to ${path.dirname(safe.newPath || '')}`;
      case 'FILE_RENAME':
        return `Rename ${path.basename(safe.originalPath || '')} to ${path.basename(safe.newPath || '')}`;
      case 'FILE_DELETE':
        return `Delete ${path.basename(safe.originalPath || '')}`;
      case 'FOLDER_CREATE':
        return `Create folder ${path.basename(safe.folderPath || '')}`;
      case 'BATCH_ORGANIZE':
      case 'BATCH_OPERATION':
        return `Organize ${Array.isArray(safe.operations) ? safe.operations.length : 0} files`;
      case 'MOVE_BATCH': {
        const count = Array.isArray(safe.operations) ? safe.operations.length : 0;
        const label = safe.summary?.label;
        return label ? `${label} (${count} files)` : `Move ${count} files (Downloads Triage)`;
      }
      case 'TRASH_BATCH': {
        const count = Array.isArray(safe.operations) ? safe.operations.length : 0;
        const label = safe.summary?.label;
        return label ? `${label} (${count} files)` : `Send ${count} files to Trash`;
      }
      default:
        return `Unknown action: ${actionType}`;
    }
  }

  generateId() {
    return generateSecureId();
  }

  getActionHistory(limit = 10) {
    const history = this.actions.slice(
      Math.max(0, this.currentIndex - limit + 1),
      this.currentIndex + 1
    );
    return history.map((action) => ({
      id: action.id,
      description: action.description,
      timestamp: action.timestamp,
      type: action.type
    }));
  }

  getRedoHistory(limit = 10) {
    const history = this.actions.slice(this.currentIndex + 1, this.currentIndex + 1 + limit);
    return history.map((action) => ({
      id: action.id,
      description: action.description,
      timestamp: action.timestamp,
      type: action.type
    }));
  }

  /**
   * Get the full undo/redo state for UI synchronization
   * @returns {Object} Full state including stack and pointer
   */
  getFullState() {
    return {
      stack: this.actions.map((action) => ({
        id: action.id,
        description: action.description,
        timestamp: action.timestamp,
        type: action.type,
        // Trash cannot be restored programmatically (TRASH_NO_RESTORE); an
        // entry made only of trash operations is not reversible and the
        // renderer says so before the user tries.
        reversible: !isTrashOnlyAction(action),
        metadata: action.data
          ? {
              source: action.data.originalPath,
              destination: action.data.newPath,
              operationCount: action.data.operations?.length,
              operations: Array.isArray(action.data.operations)
                ? action.data.operations
                : undefined,
              batchId: action.data.batchId,
              summary: action.data.summary,
              newSettings: action.data.newSettings,
              oldSettings: action.data.oldSettings
            }
          : {}
      })),
      pointer: this.currentIndex,
      canUndo: this.canUndo(),
      canRedo: this.canRedo()
    };
  }

  async clearHistory() {
    this.actions = [];
    this.currentIndex = -1;
    this.currentMemoryEstimate = 0; // Fixed: Reset memory estimate
    await this._saveActionsNow();
    this._notifyStateChanged('clear');
  }

  /**
   * Get memory and usage statistics
   * @returns {Object} Statistics about undo/redo usage
   */
  getStats() {
    return {
      totalActions: this.actions.length,
      currentIndex: this.currentIndex,
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      memoryUsageMB: (this.currentMemoryEstimate / (1024 * 1024)).toFixed(2),
      memoryLimitMB: this.maxMemoryMB,
      actionLimit: this.maxActions,
      batchSizeLimit: this.maxBatchSize
    };
  }
}

module.exports = UndoRedoService;
