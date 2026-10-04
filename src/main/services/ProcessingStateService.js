// @ts-check
const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const { createLogger } = require('../../shared/logger');
const { isNotFoundError } = require('../../shared/errorClassifier');
const { RETRY } = require('../../shared/performanceConstants');
const { crossPlatformBasename } = require('../../shared/crossPlatformUtils');
const { normalizePathForIndex } = require('../../shared/pathSanitization');

const logger = createLogger('ProcessingStateService');

// Cleanup thresholds: how long completed/failed entries are retained before eviction
const COMPLETED_TTL_MS = 30 * 60 * 1000; // 30 minutes for done entries
const FAILED_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours for failed entries
const READY_ENTRY_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days for durable ready queue entries
const MAX_READY_ENTRIES = 2000; // Hard ceiling to prevent unbounded queue growth
const DEFAULT_READY_QUERY_LIMIT = 1000; // Cap IPC hydration payload size by default
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // Run sweep every 5 minutes
const getSafeTimestamp = (/** @type {any} */ value) => {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
};

/**
 * Union of two op-index lists as a sorted, de-duplicated array of
 * non-negative integers (anything else in either input is dropped).
 * @param {unknown} existing
 * @param {unknown} incoming
 * @returns {number[]}
 */
function mergeOpIndices(existing, incoming) {
  const merged = new Set();
  for (const list of [existing, incoming]) {
    if (!Array.isArray(list)) continue;
    for (const value of list) {
      if (Number.isInteger(value) && value >= 0) merged.add(value);
    }
  }
  return [...merged].sort((a, b) => a - b);
}

/**
 * Journals written before per-op persistence tracking carry a batch-wide
 * `persistedAt` stamp and no `persistedOpIndices`. Treat every op that was
 * 'done' at that point as covered so the upgrade never re-records undo
 * entries for moves that already have one. Returns true when migrated.
 * @param {any} batch
 * @returns {boolean}
 */
function migrateLegacyPersistedBatch(batch) {
  if (!batch || typeof batch !== 'object') return false;
  if (!batch.persistedAt || Array.isArray(batch.persistedOpIndices)) return false;
  const operations = Array.isArray(batch.operations) ? batch.operations : [];
  batch.persistedOpIndices = operations
    .map((/** @type {any} */ op, /** @type {number} */ index) =>
      op?.status === 'done' ? index : -1
    )
    .filter((/** @type {number} */ index) => index >= 0);
  return true;
}

/**
 * ProcessingStateService
 * - Persists analysis jobs and organize batches to disk so work can resume after crashes/restarts
 */
class ProcessingStateService {
  constructor() {
    this.userDataPath = app.getPath('userData');
    this.statePath = path.join(this.userDataPath, 'processing-state.json');
    this.state = null;
    this.initialized = false;
    this.SCHEMA_VERSION = '1.0.0';

    // Fixed: Add mutexes to prevent race conditions
    this._initPromise = null;
    /** @type {Promise<any>} */
    this._writeLock = Promise.resolve();
    // Serializes in-memory state mutations so markAnalysisStart / markAnalysisComplete
    // cannot interleave across await boundaries (e.g., completedAt: null overwriting a valid timestamp).
    /** @type {Promise<any>} */
    this._stateMutationLock = Promise.resolve();

    // Debounce persistence: coalesce rapid state transitions into a single
    // disk write. Callers that await saveState() wait up to one window, so
    // the window bounds organize throughput: five workers each awaiting the
    // journal before a rename yield about five ops per window.
    this._saveDebounceTimer = null;
    this._saveDebounceMs = 200;
    /** @type {Array<(v: any) => void>} */
    this._saveDebounceResolvers = [];

    // Track consecutive save failures for error monitoring
    this._consecutiveSaveFailures = 0;
    this._maxConsecutiveFailures = 3;
    this._lastSaveError = null;

    // Periodic cleanup interval reference (set during initialize, cleared on destroy)
    this._sweepInterval = null;
  }

  /**
   * Get last save error (null if last save succeeded)
   * FIX: Allows callers to check if saves are working without breaking the silent-failure pattern
   * @returns {Error|null}
   */
  getLastSaveError() {
    return this._lastSaveError;
  }

  /**
   * Check if saves are healthy (no recent failures)
   * @returns {boolean}
   */
  isSaveHealthy() {
    return this._consecutiveSaveFailures === 0;
  }

  async ensureParentDirectory(/** @type {any} */ filePath) {
    const parentDirectory = path.dirname(filePath);
    await fs.mkdir(parentDirectory, { recursive: true });
  }

  /**
   * Canonical map key for a file path. Jobs/ready entries are keyed by the
   * platform-normalized form (case-folded on Windows/macOS, forward slashes)
   * so `C:\Users\x\File.TXT` and `c:/users/x/file.txt` hit the same entry —
   * otherwise a watcher event and an IPC call for the same file create
   * divergent job records (one forever 'in_progress', one 'done').
   * The original-casing path is preserved inside the entry (`path` field).
   * @private
   */
  _pathKey(/** @type {any} */ filePath) {
    return normalizePathForIndex(filePath) || String(filePath || '');
  }

  /**
   * Re-key an object map by canonical path keys. Used at load time so state
   * persisted by older versions (raw-path keys) collapses into the canonical
   * scheme. On key collision the entry with the newer timestamp wins.
   * @private
   */
  _normalizeStateKeys(/** @type {any} */ map, /** @type {any} */ timestampOf) {
    if (!map || typeof map !== 'object') return { map: {}, changed: false };
    let changed = false;
    /** @type {Record<string, any>} */
    const normalized = {};
    for (const [rawKey, entry] of Object.entries(map)) {
      const key = this._pathKey(rawKey);
      if (key !== rawKey) changed = true;
      if (normalized[key] && timestampOf(normalized[key]) >= timestampOf(entry)) {
        changed = true;
        continue;
      }
      normalized[key] = entry;
    }
    return { map: normalized, changed };
  }

  async initialize() {
    // Fixed: Use initialization promise to prevent race conditions
    if (this._initPromise) {
      return this._initPromise;
    }

    if (this.initialized) {
      return Promise.resolve();
    }

    // to prevent the promise reference from being nulled before callers can observe it.
    this._initPromise = this._doInitialize();
    try {
      return await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  /** @private */
  async _doInitialize() {
    try {
      await this.loadState();
      this.initialized = true;
      this._startSweepInterval();
    } catch {
      try {
        this.state = this.createEmptyState();
        await this._saveStateInternal();
        this.initialized = true;
        this._startSweepInterval();
      } catch (saveError) {
        logger.error('[ProcessingStateService] Failed to save initial state:', saveError.message);
        this.initialized = false;
        throw saveError;
      }
    }
  }

  createEmptyState() {
    const now = new Date().toISOString();
    return {
      schemaVersion: this.SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
      analysis: {
        jobs: {}, // key: filePath, value: { status: 'pending'|'in_progress'|'done'|'failed', startedAt, completedAt, error }
        ready: {}, // key: filePath, value: { path, name, size, created, modified, analyzedAt, analysis }
        lastUpdated: now
      },
      organize: {
        batches: {}, // key: batchId, value: { id, operations: [{ source, destination, status, error }], startedAt, completedAt }
        lastUpdated: now
      }
    };
  }

  async loadState() {
    try {
      const raw = await fs.readFile(this.statePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const shapeError = /** @type {Error & { code?: string }} */ (
          new Error('Processing state has invalid shape')
        );
        shapeError.code = 'INVALID_PROCESSING_STATE_SHAPE';
        throw shapeError;
      }
      this.state = parsed;
      if (!this.state.schemaVersion) {
        this.state.schemaVersion = this.SCHEMA_VERSION;
      }
      if (!this.state.analysis || typeof this.state.analysis !== 'object') {
        this.state.analysis = { jobs: {}, ready: {}, lastUpdated: new Date().toISOString() };
      }
      if (!this.state.analysis.jobs || typeof this.state.analysis.jobs !== 'object') {
        this.state.analysis.jobs = {};
      }
      if (!this.state.analysis.ready || typeof this.state.analysis.ready !== 'object') {
        this.state.analysis.ready = {};
      }
      if (!this.state.analysis.lastUpdated) {
        this.state.analysis.lastUpdated = new Date().toISOString();
      }
      if (!this.state.organize || typeof this.state.organize !== 'object') {
        this.state.organize = { batches: {}, lastUpdated: new Date().toISOString() };
      }
      if (!this.state.organize.batches || typeof this.state.organize.batches !== 'object') {
        this.state.organize.batches = {};
      }
      if (!this.state.organize.lastUpdated) {
        this.state.organize.lastUpdated = new Date().toISOString();
      }

      // Migrate raw-path keys from older versions to canonical keys so
      // lookups with differently-cased/separated paths hit existing entries.
      const jobsMigration = this._normalizeStateKeys(
        this.state.analysis.jobs,
        (/** @type {any} */ j) => getSafeTimestamp(j?.completedAt || j?.startedAt)
      );
      const readyMigration = this._normalizeStateKeys(
        this.state.analysis.ready,
        (/** @type {any} */ e) => getSafeTimestamp(e?.analyzedAt || e?.modified || e?.created)
      );
      this.state.analysis.jobs = jobsMigration.map;
      this.state.analysis.ready = readyMigration.map;
      const keysMigrated = jobsMigration.changed || readyMigration.changed;

      let batchesMigrated = 0;
      for (const batch of Object.values(this.state.organize.batches)) {
        if (migrateLegacyPersistedBatch(batch)) batchesMigrated += 1;
      }
      if (batchesMigrated > 0) {
        this.state.organize.lastUpdated = new Date().toISOString();
      }

      const readyEvicted = this._evictStaleReadyEntries(Date.now()) + this._enforceReadyQueueCap();
      if (readyEvicted > 0 || keysMigrated) {
        this.state.analysis.lastUpdated = new Date().toISOString();
      }
      if (readyEvicted > 0 || keysMigrated || batchesMigrated > 0) {
        await this._saveStateInternal();
        logger.info('[ProcessingStateService] Normalized/pruned state entries during load', {
          evicted: readyEvicted,
          keysMigrated,
          batchesMigrated
        });
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        this.state = this.createEmptyState();
      } else if (error instanceof SyntaxError || error?.code === 'INVALID_PROCESSING_STATE_SHAPE') {
        logger.warn(
          '[ProcessingStateService] Corrupted processing state detected, resetting file',
          {
            error: error?.message
          }
        );
        this.state = this.createEmptyState();
        try {
          await this._saveStateInternal();
        } catch (persistError) {
          logger.warn('[ProcessingStateService] Failed to persist reset processing state', {
            error: persistError?.message
          });
        }
      } else {
        throw error;
      }
    }
  }

  /**
   * Internal save method without locking (for use within locked contexts)
   * @private
   */
  async _saveStateInternal() {
    this.state.updatedAt = new Date().toISOString();
    await this._performAtomicWrite(this.state);
  }

  /**
   * Write the state snapshot with the temp-write -> fsync -> rename -> fsync-dir
   * pattern (same crash-durability contract as `durableWriteJson` in
   * shared/atomicFileOperations.js, which is not exported from that module).
   * Plain writeFile+rename is only atomic against in-process partial writes:
   * a power loss can commit the rename target while its data is still in the
   * page cache, leaving a zero-byte organize journal that loadState treats as
   * corrupt and resets — silently discarding in-flight batches.
   */
  async _performAtomicWrite(/** @type {any} */ stateSnapshot) {
    await this.ensureParentDirectory(this.statePath);
    const tempPath = `${this.statePath}.tmp.${require('crypto').randomUUID()}`;
    /** @type {import('fs/promises').FileHandle | null} */
    let handle = null;
    try {
      handle = await fs.open(tempPath, 'w');
      await handle.writeFile(JSON.stringify(stateSnapshot, null, 2), 'utf8');
      try {
        await handle.sync();
      } catch (syncError) {
        // Some filesystems (network mounts) don't implement fsync — keep the
        // write itself rather than failing the save.
        logger.debug('[ProcessingStateService] fsync unsupported on temp state file:', {
          error: syncError?.message
        });
      }
      await handle.close();
      handle = null;
      // Retry rename on Windows EPERM errors (file handle race condition)
      let lastError;
      let renamed = false;
      for (let attempt = 0; attempt < 3 && !renamed; attempt++) {
        try {
          await fs.rename(tempPath, this.statePath);
          renamed = true;
        } catch (renameError) {
          lastError = renameError;
          if (renameError.code === 'EPERM' && attempt < 2) {
            await new Promise((resolve) =>
              setTimeout(resolve, RETRY.ATOMIC_BACKOFF_STEP_MS * (attempt + 1))
            );
            continue;
          }
          throw renameError;
        }
      }
      if (!renamed) throw lastError;
      // Flush the directory entry so the rename itself survives power loss.
      // Best-effort: Windows cannot open directories via fs.open.
      try {
        const dirHandle = await fs.open(path.dirname(this.statePath), 'r');
        try {
          await dirHandle.sync();
        } finally {
          await dirHandle.close();
        }
      } catch {
        // Directory fsync unavailable on this platform/filesystem
      }
    } catch (error) {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // Ignore cleanup errors
        }
      }
      // Clean up temp file on failure
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  _handleSaveSuccess() {
    this._consecutiveSaveFailures = 0;
    this._lastSaveError = null;
    return { success: true };
  }

  _handleSaveFailure(/** @type {any} */ err) {
    this._consecutiveSaveFailures++;
    this._lastSaveError = err;
    logger.error('[ProcessingStateService] Save failed:', {
      error: err?.message,
      consecutiveFailures: this._consecutiveSaveFailures
    });
    if (this._consecutiveSaveFailures >= this._maxConsecutiveFailures) {
      logger.error(
        '[ProcessingStateService] CRITICAL: Multiple consecutive save failures - state persistence may be compromised'
      );
    }
    return { success: false, error: err?.message };
  }

  /**
   * Save state with write lock to prevent concurrent writes
   * Race condition fix: Captures state snapshot before chaining to prevent
   * state mutations between queue and save
   */
  async saveState() {
    // Update the state timestamp immediately (for callers that check it)
    this.state.updatedAt = new Date().toISOString();

    // Debounce: coalesce rapid save calls into one disk write. Callers JOIN
    // the flush already scheduled rather than pushing it out: a trailing-edge
    // reset let a steady stream of callers defer the flush indefinitely and
    // made every awaited save cost a full window. Joining bounds each
    // caller's wait to one window from the first call.
    return new Promise((resolve) => {
      this._saveDebounceResolvers.push(resolve);
      if (this._saveDebounceTimer) return;
      this._saveDebounceTimer = setTimeout(() => {
        this._saveDebounceTimer = null;
        this._flushSaveState();
      }, this._saveDebounceMs);
      // Do NOT unref() the timer — allowing the process to exit with a pending
      // save causes silent data loss. The destroy() lifecycle hook must flush first.
    });
  }

  /**
   * Immediately flush debounced save (used during shutdown)
   */
  async flushSaveState() {
    if (this._saveDebounceTimer) {
      clearTimeout(this._saveDebounceTimer);
      this._saveDebounceTimer = null;
    }
    if (this._saveDebounceResolvers.length > 0) {
      await this._flushSaveState();
    }
    // A flush that began before this call has already taken its resolvers,
    // so the branch above sees nothing pending while its write is still in
    // flight. Shutdown calls this to make the journal durable; return only
    // once every chained write has landed.
    await this._writeLock;
  }

  /** @private */
  async _flushSaveState() {
    const resolvers = this._saveDebounceResolvers;
    this._saveDebounceResolvers = [];

    // Capture state snapshot NOW. structuredClone is ~3× faster than
    // JSON.parse(JSON.stringify(...)) and handles cycles + Maps/Sets
    // correctly. _flushSaveState runs on a 500 ms debounce; with
    // MAX_READY_ENTRIES=2000 the cloned tree can be several MB and the
    // GC pressure adds up over a long organize batch.
    const now = new Date().toISOString();
    this.state.updatedAt = now;
    let stateSnapshot;
    try {
      stateSnapshot =
        typeof structuredClone === 'function'
          ? structuredClone(this.state)
          : JSON.parse(JSON.stringify(this.state));
    } catch {
      const deepCopySafe = (/** @type {any} */ obj) => {
        try {
          return typeof structuredClone === 'function'
            ? structuredClone(obj)
            : JSON.parse(JSON.stringify(obj));
        } catch {
          return { ...(obj || {}) };
        }
      };
      stateSnapshot = {
        ...this.state,
        updatedAt: now,
        analysis: deepCopySafe(this.state.analysis),
        organize: deepCopySafe(this.state.organize)
      };
    }

    // Chain this save after any pending saves complete
    /** @type {() => Promise<any>} */
    const saveOperation = async () => this._performAtomicWrite(stateSnapshot);

    let saveResult = { success: true };
    this._writeLock = this._writeLock
      .then(() => saveOperation())
      .then(
        /** @returns {undefined} */ () => {
          saveResult = this._handleSaveSuccess();
          return undefined;
        }
      )
      .catch(
        /** @param {any} err */ (err) => {
          saveResult = this._handleSaveFailure(err);
        }
      );

    await this._writeLock;
    for (const r of resolvers) r(saveResult);
    return saveResult;
  }

  // ===== Stale entry cleanup =====

  /**
   * Start the periodic sweep interval. Safe to call multiple times; only one
   * interval will be active at a time.
   * @private
   */
  _startSweepInterval() {
    if (this._sweepInterval) return;
    this._sweepInterval = setInterval(() => {
      this._sweepStaleEntries().catch((err) => {
        logger.error('[ProcessingStateService] Sweep failed:', err?.message);
      });
    }, SWEEP_INTERVAL_MS);
    // Allow the Node process to exit even if the interval is still running
    if (this._sweepInterval.unref) {
      this._sweepInterval.unref();
    }
  }

  /**
   * Remove analysis jobs, durable ready entries, and organize batches that have reached a terminal
   * state (done / failed) and are older than their respective TTL thresholds.
   * Only persists to disk when at least one entry was evicted.
   * @private
   */
  async _sweepStaleEntries() {
    if (!this.state) return;

    const now = Date.now();
    let evicted = 0;

    // --- Analysis jobs ---
    const jobs = this.state.analysis.jobs;
    for (const filePath of Object.keys(jobs)) {
      const job = jobs[filePath];
      if (job.status === 'done' || job.status === 'failed') {
        const timestamp = job.completedAt || job.startedAt;
        if (!timestamp) {
          // No timestamp at all -- treat as stale
          delete jobs[filePath];
          evicted++;
          continue;
        }
        const age = now - new Date(timestamp).getTime();
        const ttl = job.status === 'done' ? COMPLETED_TTL_MS : FAILED_TTL_MS;
        if (age > ttl) {
          delete jobs[filePath];
          evicted++;
        }
      }
    }

    // --- Durable ready queue ---
    evicted += this._evictStaleReadyEntries(now);
    evicted += this._enforceReadyQueueCap();

    // --- Organize batches ---
    const batches = this.state.organize.batches;
    for (const batchId of Object.keys(batches)) {
      const batch = batches[batchId];
      // rolledBackAt is terminal too: a crash between the rolledBackAt and
      // completedAt stamps must not pin the entry on disk forever.
      const closedAt = batch.completedAt || batch.rolledBackAt;
      if (!closedAt) continue; // Still in-progress -- keep

      const age = now - new Date(closedAt).getTime();
      // Completed batches may contain failed ops; use the longer TTL
      const hasFailed =
        Array.isArray(batch.operations) &&
        batch.operations.some((/** @type {any} */ op) => op.status === 'failed');
      const ttl = hasFailed ? FAILED_TTL_MS : COMPLETED_TTL_MS;
      if (age > ttl) {
        delete batches[batchId];
        evicted++;
      }
    }

    if (evicted > 0) {
      logger.info(`[ProcessingStateService] Swept ${evicted} stale entries`);
      this.state.analysis.lastUpdated = new Date().toISOString();
      this.state.organize.lastUpdated = this.state.analysis.lastUpdated;
      await this.saveState();
    }
  }

  /**
   * Shutdown hook for ServiceContainer compatibility.
   * ServiceContainer calls shutdown() during coordinated teardown.
   */
  async shutdown() {
    await this.destroy();
  }

  /**
   * Tear down the service: stop the periodic sweep and run a final cleanup.
   * Safe to call multiple times.
   */
  async destroy() {
    if (this._sweepInterval) {
      clearInterval(this._sweepInterval);
      this._sweepInterval = null;
    }
    // Flush any pending debounced saves before shutdown
    await this.flushSaveState();
    // Final sweep before shutdown so stale entries do not persist on disk
    try {
      await this._sweepStaleEntries();
    } catch {
      // Best-effort during shutdown
    }
  }

  // ===== Analysis tracking =====
  _evictStaleReadyEntries(now = Date.now()) {
    const readyEntries =
      this.state?.analysis?.ready && typeof this.state.analysis.ready === 'object'
        ? this.state.analysis.ready
        : null;
    if (!readyEntries) return 0;

    let evicted = 0;
    for (const filePath of Object.keys(readyEntries)) {
      const entry = readyEntries[filePath];
      const timestamp = getSafeTimestamp(entry?.analyzedAt || entry?.modified || entry?.created);
      if (timestamp <= 0 || now - timestamp > READY_ENTRY_TTL_MS) {
        delete readyEntries[filePath];
        evicted++;
      }
    }
    return evicted;
  }

  _enforceReadyQueueCap() {
    const readyEntries =
      this.state?.analysis?.ready && typeof this.state.analysis.ready === 'object'
        ? this.state.analysis.ready
        : null;
    if (!readyEntries) return 0;

    const rankedEntries = Object.entries(readyEntries).sort(([, a], [, b]) => {
      const aTime = getSafeTimestamp(a?.analyzedAt || a?.modified || a?.created);
      const bTime = getSafeTimestamp(b?.analyzedAt || b?.modified || b?.created);
      return bTime - aTime;
    });
    if (rankedEntries.length <= MAX_READY_ENTRIES) return 0;

    let evicted = 0;
    for (let i = MAX_READY_ENTRIES; i < rankedEntries.length; i++) {
      const [filePath] = rankedEntries[i];
      delete readyEntries[filePath];
      evicted++;
    }
    return evicted;
  }

  _toSafeText(/** @type {any} */ value, { maxLength = 500 } = {}) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!text) return null;
    return text.length > maxLength ? text.slice(0, maxLength) : text;
  }

  _toSafeNumber(/** @type {any} */ value, { min = 0, max = 1 } = {}) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return Math.max(min, Math.min(max, num));
  }

  _toSafeStringList(/** @type {any} */ values, { maxItems = 20, maxItemLength = 100 } = {}) {
    if (!Array.isArray(values) || values.length === 0) return [];
    const seen = new Set();
    const list = [];
    for (const value of values) {
      const normalized = this._toSafeText(value, { maxLength: maxItemLength });
      if (!normalized) continue;
      const dedupeKey = normalized.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      list.push(normalized);
      if (list.length >= maxItems) break;
    }
    return list;
  }

  _sanitizeReadyAnalysis(/** @type {any} */ result) {
    if (!result || typeof result !== 'object') return null;
    const payload = {
      suggestedName: this._toSafeText(result.suggestedName || result.newName, { maxLength: 255 }),
      llmSuggestedName: this._toSafeText(result.llmSuggestedName, { maxLength: 255 }),
      category: this._toSafeText(result.category, { maxLength: 100 }),
      keywords: this._toSafeStringList(result.keywords, { maxItems: 30, maxItemLength: 80 }),
      confidence: this._toSafeNumber(result.confidence, { min: 0, max: 100 }),
      summary: this._toSafeText(result.summary || result.purpose || result.description, {
        maxLength: 2000
      }),
      purpose: this._toSafeText(result.purpose, { maxLength: 2000 }),
      reasoning: this._toSafeText(result.reasoning, { maxLength: 1000 }),
      subject: this._toSafeText(result.subject, { maxLength: 255 }),
      documentType: this._toSafeText(result.documentType || result.type, { maxLength: 100 }),
      entity: this._toSafeText(result.entity, { maxLength: 255 }),
      project: this._toSafeText(result.project, { maxLength: 255 }),
      documentDate: this._toSafeText(result.documentDate || result.date, { maxLength: 60 }),
      keyEntities: this._toSafeStringList(result.keyEntities, { maxItems: 20, maxItemLength: 100 }),
      smartFolder: this._toSafeText(result.smartFolder, { maxLength: 255 }),
      embeddingPolicy: this._toSafeText(result.embeddingPolicy, { maxLength: 20 }),
      embeddingStatus: this._toSafeText(result.embeddingStatus, { maxLength: 20 }),
      warning: this._toSafeText(result.error, { maxLength: 1000 }),
      errorType: this._toSafeText(result.errorType, { maxLength: 100 }),
      isRetryable: typeof result.isRetryable === 'boolean' ? result.isRetryable : null
    };

    if (!payload.suggestedName && !payload.category && payload.keywords.length === 0) {
      return null;
    }

    /** @type {Record<string, any>} */
    const compact = {};
    for (const [key, value] of Object.entries(payload)) {
      if (value === null || value === undefined) continue;
      if (Array.isArray(value) && value.length === 0) continue;
      compact[key] = value;
    }
    return compact;
  }

  async _buildReadyEntry(
    /** @type {any} */ filePath,
    /** @type {any} */ analysisResult,
    /** @type {any} */ analyzedAt
  ) {
    const sanitizedAnalysis = this._sanitizeReadyAnalysis(analysisResult);
    if (!sanitizedAnalysis) return null;

    const nameFromPath = crossPlatformBasename(filePath || '');
    let stats;
    try {
      stats = await fs.stat(filePath);
    } catch {
      stats = null;
    }

    return {
      path: filePath,
      name: nameFromPath || sanitizedAnalysis.suggestedName || 'Unknown',
      size: stats?.size ?? null,
      created: stats?.birthtime ? stats.birthtime.toISOString() : null,
      modified: stats?.mtime ? stats.mtime.toISOString() : null,
      analyzedAt,
      analysis: sanitizedAnalysis
    };
  }

  async _upsertReadyEntryInMemory(
    /** @type {any} */ filePath,
    /** @type {any} */ analysisResult,
    /** @type {any} */ analyzedAt
  ) {
    const entry = await this._buildReadyEntry(filePath, analysisResult, analyzedAt);
    if (!entry) return false;
    this.state.analysis.ready[this._pathKey(filePath)] = entry;
    this._enforceReadyQueueCap();
    return true;
  }

  async markAnalysisStart(/** @type {any} */ filePath) {
    const op = async () => {
      await this.initialize();
      const now = new Date().toISOString();
      const key = this._pathKey(filePath);
      this.state.analysis.jobs[key] = {
        ...(this.state.analysis.jobs[key] || {}),
        path: filePath,
        status: 'in_progress',
        startedAt: now,
        completedAt: null,
        error: null
      };
      this.state.analysis.lastUpdated = now;
      await this.saveState();
    };
    this._stateMutationLock = this._stateMutationLock.then(op, op).catch((err) => {
      logger.error('[ProcessingState] Mutation failed', { error: err?.message });
    });
    return this._stateMutationLock;
  }

  async markAnalysisComplete(
    /** @type {any} */ filePath,
    /** @type {any} */ analysisResult = null
  ) {
    const op = async () => {
      await this.initialize();
      const now = new Date().toISOString();
      const key = this._pathKey(filePath);
      this.state.analysis.jobs[key] = {
        ...(this.state.analysis.jobs[key] || {}),
        path: filePath,
        status: 'done',
        completedAt: now,
        error: null
      };
      if (analysisResult) {
        try {
          await this._upsertReadyEntryInMemory(filePath, analysisResult, now);
        } catch (error) {
          logger.debug('[ProcessingStateService] Failed to capture ready analysis entry', {
            filePath,
            error: error?.message
          });
        }
      }
      this.state.analysis.lastUpdated = now;
      await this.saveState();
    };
    this._stateMutationLock = this._stateMutationLock.then(op, op).catch((err) => {
      logger.error('[ProcessingState] markAnalysisComplete mutation failed', {
        error: err?.message
      });
    });
    return this._stateMutationLock;
  }

  async markAnalysisError(/** @type {any} */ filePath, /** @type {any} */ errorMessage) {
    const op = async () => {
      await this.initialize();
      const now = new Date().toISOString();
      const key = this._pathKey(filePath);
      this.state.analysis.jobs[key] = {
        ...(this.state.analysis.jobs[key] || {}),
        path: filePath,
        status: 'failed',
        completedAt: now,
        error: errorMessage || 'Unknown analysis error'
      };
      this.state.analysis.lastUpdated = now;
      const result = await this.saveState();
      if (!result.success) {
        logger.error('[ProcessingStateService] Failed to save analysis error state:', result.error);
      }
    };
    this._stateMutationLock = this._stateMutationLock.then(op, op).catch((err) => {
      logger.error('[ProcessingState] Mutation failed', { error: err?.message });
    });
    return this._stateMutationLock;
  }

  getIncompleteAnalysisJobs() {
    if (!this.state) return [];
    return Object.entries(this.state.analysis.jobs)
      .filter(([, j]) => j.status === 'in_progress' || j.status === 'pending')
      .map(([key, j]) => ({ ...j, filePath: j.path || key }));
  }

  /**
   * Get the current state of an analysis job
   * @param {string} filePath - Path to the file
   * @returns {string|null} The status ('pending', 'in_progress', 'done', 'failed') or null if not found
   */
  getState(filePath) {
    const key = this._pathKey(filePath);
    if (!this.state || !this.state.analysis.jobs[key]) {
      return null;
    }
    return this.state.analysis.jobs[key].status;
  }

  /**
   * Clear/remove an analysis job from tracking
   * @param {string} filePath - Path to the file
   */
  async clearState(filePath) {
    await this.initialize();
    const key = this._pathKey(filePath);
    let changed = false;
    if (this.state.analysis.jobs[key]) {
      delete this.state.analysis.jobs[key];
      changed = true;
    }
    if (this.state.analysis.ready[key]) {
      delete this.state.analysis.ready[key];
      changed = true;
    }
    if (changed) {
      this.state.analysis.lastUpdated = new Date().toISOString();
      await this.saveState();
    }
  }

  /**
   * Move a job entry from one file path to another
   * FIX: Provides a safe API for path updates that go through saveState's
   * write lock, instead of external callers mutating state.analysis.jobs directly.
   * @param {string} oldPath - Original file path
   * @param {string} newPath - New file path
   */
  async moveJob(oldPath, newPath) {
    await this.initialize();
    const oldKey = this._pathKey(oldPath);
    const newKey = this._pathKey(newPath);
    let changed = false;
    const job = this.state.analysis.jobs[oldKey];
    if (job) {
      this.state.analysis.jobs[newKey] = { ...job, path: newPath, movedFrom: oldPath };
      if (newKey !== oldKey) delete this.state.analysis.jobs[oldKey];
      changed = true;
    }
    const ready = this.state.analysis.ready[oldKey];
    if (ready) {
      this.state.analysis.ready[newKey] = {
        ...ready,
        path: newPath,
        name: crossPlatformBasename(newPath) || ready.name
      };
      if (newKey !== oldKey) delete this.state.analysis.ready[oldKey];
      changed = true;
    }
    if (changed) {
      this.state.analysis.lastUpdated = new Date().toISOString();
      await this.saveState();
    }
  }

  async upsertReadyAnalysis(/** @type {any} */ filePath, /** @type {any} */ analysisResult) {
    await this.initialize();
    const now = new Date().toISOString();
    const updated = await this._upsertReadyEntryInMemory(filePath, analysisResult, now);
    if (!updated) return false;
    this.state.analysis.lastUpdated = now;
    await this.saveState();
    return true;
  }

  /**
   * Update embeddingStatus on a durable ready-queue entry after the embedding
   * pipeline finishes indexing the file.
   *
   * @param {string} filePath
   * @param {string} embeddingStatus
   * @returns {Promise<{updated: boolean}>}
   */
  async updateReadyEmbeddingStatus(filePath, embeddingStatus) {
    const op = async () => {
      await this.initialize();
      const entry = this.state?.analysis?.ready?.[this._pathKey(filePath)];
      if (!entry) return { updated: false };
      entry.analysis = entry.analysis || {};
      entry.analysis.embeddingStatus = this._toSafeText(embeddingStatus, { maxLength: 20 });
      this.state.analysis.lastUpdated = new Date().toISOString();
      await this.saveState();
      return { updated: true };
    };
    this._stateMutationLock = this._stateMutationLock.then(op, op).catch((err) => {
      logger.error('[ProcessingState] updateReadyEmbeddingStatus mutation failed', {
        error: err?.message
      });
      return { updated: false };
    });
    return this._stateMutationLock;
  }

  async clearReadyAnalysis(/** @type {any} */ filePath) {
    await this.initialize();
    const key = this._pathKey(filePath);
    if (!this.state.analysis.ready[key]) return false;
    delete this.state.analysis.ready[key];
    this.state.analysis.lastUpdated = new Date().toISOString();
    await this.saveState();
    return true;
  }

  /**
   * Clear all ready analyses and pending jobs from the durable queue.
   * Used when the user explicitly clicks "Clear" in the Discover phase.
   */
  async clearAllReadyAnalyses() {
    await this.initialize();
    const readyCount = Object.keys(this.state.analysis.ready || {}).length;
    const jobsCount = Object.keys(this.state.analysis.jobs || {}).length;
    if (readyCount === 0 && jobsCount === 0) return { cleared: 0 };
    this.state.analysis.ready = {};
    this.state.analysis.jobs = {};
    this.state.analysis.lastUpdated = new Date().toISOString();
    await this.saveState();
    return { cleared: readyCount + jobsCount };
  }

  getReadyAnalyses({ limit = DEFAULT_READY_QUERY_LIMIT } = {}) {
    if (!this.state?.analysis?.ready) return [];
    const entries = Object.values(this.state.analysis.ready)
      .filter((entry) => entry && typeof entry === 'object' && typeof entry.path === 'string')
      .sort((a, b) => {
        const aTime = getSafeTimestamp(a.analyzedAt || a.modified || a.created);
        const bTime = getSafeTimestamp(b.analyzedAt || b.modified || b.created);
        return bTime - aTime;
      });
    if (!Number.isFinite(limit) || limit === null || limit <= 0) {
      return entries;
    }
    return entries.slice(0, limit);
  }

  // ===== Organize batch tracking =====
  // Organize-batch mutators route through the shared `_stateMutationLock` for
  // parity with the analysis mutators: every mutator below performs a
  // read-modify-write on `state.organize.batches` followed by `saveState()`,
  // and `saveState()` persists the entire state blob. Serializing them (and
  // against the analysis mutators) on one lock keeps concurrent writers from
  // interleaving on the same file and is immune to a future mid-mutation
  // `await` opening a torn read-modify-write.
  //
  // The per-op mutators (started / done / error) release the lock BEFORE the
  // save. Holding it across the debounced save serialized every op behind a
  // full window regardless of worker concurrency (about 1 s per file with
  // two awaited marks), which is what pushed batches past ~270 files over
  // MAX_TOTAL_BATCH_TIME and rolled them back. The mutation is synchronous
  // once initialize() has resolved, and the flush snapshots the state when
  // it fires, so a save issued after the lock still covers the mutation.

  /**
   * Run `mutate` under the state mutation lock, then persist outside it.
   * Resolves with the save result once the mutation is durable, or with
   * undefined when `mutate` returned false (nothing to persist) or threw.
   * @param {string} label  log breadcrumb
   * @param {() => (boolean | void)} mutate  synchronous after initialize()
   * @private
   */
  async _mutateThenSave(label, mutate) {
    let needsSave = false;
    const op = async () => {
      await this.initialize();
      needsSave = mutate() !== false;
    };
    const chained = this._stateMutationLock.then(op, op).catch((err) => {
      needsSave = false;
      logger.error(`[ProcessingState] ${label} mutation failed`, { error: err?.message });
    });
    this._stateMutationLock = chained;
    await chained;
    return needsSave ? this.saveState() : undefined;
  }

  async createOrLoadOrganizeBatch(/** @type {any} */ batchId, /** @type {any} */ operations) {
    /** @type {() => Promise<any>} */
    const op = async () => {
      await this.initialize();
      const now = new Date().toISOString();
      if (!this.state.organize.batches[batchId]) {
        this.state.organize.batches[batchId] = {
          id: batchId,
          operations: operations.map((/** @type {any} */ o) => ({
            ...o,
            status: 'pending',
            error: null
          })),
          startedAt: now,
          completedAt: null
        };
        this.state.organize.lastUpdated = now;
        await this.saveState();
      }
      return this.state.organize.batches[batchId];
    };
    this._stateMutationLock = this._stateMutationLock.then(op, op).catch(
      /** @param {any} err @returns {any} */ (err) => {
        logger.error('[ProcessingState] createOrLoadOrganizeBatch mutation failed', {
          error: err?.message
        });
        return undefined;
      }
    );
    return this._stateMutationLock;
  }

  /**
   * @param {string} batchId
   * @param {number} index
   * @param {{ sourceSize: number, sourceMtime: number } | null} [sourceMetadata]
   *   Pre-move identity of the source file; lets resume recognise the
   *   destination occupant after a crash between rename and markOrganizeOpDone.
   */
  async markOrganizeOpStarted(batchId, index, sourceMetadata = null) {
    return this._mutateThenSave('markOrganizeOpStarted', () => {
      const batch = this.state.organize.batches[batchId];
      if (!batch?.operations || index < 0 || index >= batch.operations.length) return false;
      if (sourceMetadata) {
        batch.operations[index] = { ...batch.operations[index], ...sourceMetadata };
      }
      batch.operations[index].status = 'in_progress';
      batch.operations[index].error = null;
      this.state.organize.lastUpdated = new Date().toISOString();
    });
  }

  async markOrganizeOpDone(
    /** @type {any} */ batchId,
    /** @type {any} */ index,
    /** @type {any} */ updatedOp = null
  ) {
    return this._mutateThenSave('markOrganizeOpDone', () => {
      const batch = this.state.organize.batches[batchId];
      if (!batch?.operations || index < 0 || index >= batch.operations.length) return false;
      if (updatedOp) {
        batch.operations[index] = { ...batch.operations[index], ...updatedOp };
      }
      batch.operations[index].status = 'done';
      batch.operations[index].error = null;
      this.state.organize.lastUpdated = new Date().toISOString();
    });
  }

  async markOrganizeOpError(
    /** @type {any} */ batchId,
    /** @type {any} */ index,
    /** @type {any} */ errorMessage
  ) {
    return this._mutateThenSave('markOrganizeOpError', () => {
      const batch = this.state.organize.batches[batchId];
      if (!batch?.operations || index < 0 || index >= batch.operations.length) return false;
      batch.operations[index].status = 'failed';
      batch.operations[index].error = errorMessage || 'Unknown organize error';
      this.state.organize.lastUpdated = new Date().toISOString();
    });
  }

  /**
   * Record that post-batch persistence (undo action + FilePathCoordinator
   * path updates) fully succeeded for the given op indices. Tracked per op —
   * not per batch — because a batch can persist in several passes (partial
   * run interrupted, then replayed at next launch; pause, resume, crash) and
   * each pass covers only the moves it performed. Resume persists exactly
   * the done ops that are still uncovered. `persistedAt` is kept as the
   * last-stamp timestamp for observability only.
   * @param {string} batchId
   * @param {number[]} opIndices
   */
  async markOrganizeOpsPersisted(batchId, opIndices) {
    const op = async () => {
      await this.initialize();
      const batch = this.state.organize.batches[batchId];
      if (!batch) return;
      const merged = mergeOpIndices(batch.persistedOpIndices, opIndices);
      if (merged.length === (batch.persistedOpIndices?.length ?? 0)) return;
      batch.persistedOpIndices = merged;
      batch.persistedAt = new Date().toISOString();
      this.state.organize.lastUpdated = batch.persistedAt;
      await this.saveState();
    };
    this._stateMutationLock = this._stateMutationLock.then(op, op).catch((err) => {
      logger.error('[ProcessingState] markOrganizeOpsPersisted mutation failed', {
        error: err?.message
      });
    });
    return this._stateMutationLock;
  }

  /**
   * Mark a batch as paused by the user: it stays incomplete (no completedAt)
   * so resume can pick it up, but startup recovery must FINALIZE it (persist
   * + complete) instead of replaying pending ops — see OrganizeResumeService.
   */
  async markOrganizeBatchPaused(/** @type {any} */ batchId) {
    const op = async () => {
      await this.initialize();
      const batch = this.state.organize.batches[batchId];
      if (!batch) return;
      batch.pausedAt = new Date().toISOString();
      this.state.organize.lastUpdated = batch.pausedAt;
      await this.saveState();
    };
    this._stateMutationLock = this._stateMutationLock.then(op, op).catch((err) => {
      logger.error('[ProcessingState] markOrganizeBatchPaused mutation failed', {
        error: err?.message
      });
    });
    return this._stateMutationLock;
  }

  async clearOrganizeBatchPaused(/** @type {any} */ batchId) {
    const op = async () => {
      await this.initialize();
      const batch = this.state.organize.batches[batchId];
      if (!batch || !batch.pausedAt) return;
      delete batch.pausedAt;
      this.state.organize.lastUpdated = new Date().toISOString();
      await this.saveState();
    };
    this._stateMutationLock = this._stateMutationLock.then(op, op).catch((err) => {
      logger.error('[ProcessingState] clearOrganizeBatchPaused mutation failed', {
        error: err?.message
      });
    });
    return this._stateMutationLock;
  }

  /**
   * Mark a batch as rolled back: its completed ops' files were moved BACK to
   * their sources, so startup recovery must never replay it — 'done' ops
   * would get undo entries/path-index updates for moves that no longer
   * exist, and pending/failed ops would silently re-move files the user was
   * told were restored. Callers stamp this BEFORE completeOrganizeBatch so a
   * crash between the two writes still leaves a marker that
   * getIncompleteOrganizeBatches (and OrganizeResumeService) skip.
   */
  async markOrganizeBatchRolledBack(/** @type {any} */ batchId) {
    const op = async () => {
      await this.initialize();
      const batch = this.state.organize.batches[batchId];
      if (!batch) return;
      batch.rolledBackAt = new Date().toISOString();
      this.state.organize.lastUpdated = batch.rolledBackAt;
      await this.saveState();
    };
    this._stateMutationLock = this._stateMutationLock.then(op, op).catch((err) => {
      logger.error('[ProcessingState] markOrganizeBatchRolledBack mutation failed', {
        error: err?.message
      });
    });
    return this._stateMutationLock;
  }

  async completeOrganizeBatch(/** @type {any} */ batchId) {
    const op = async () => {
      await this.initialize();
      const batch = this.state.organize.batches[batchId];
      if (!batch) return;
      batch.completedAt = new Date().toISOString();
      this.state.organize.lastUpdated = batch.completedAt;
      await this.saveState();
    };
    this._stateMutationLock = this._stateMutationLock.then(op, op).catch((err) => {
      logger.error('[ProcessingState] completeOrganizeBatch mutation failed', {
        error: err?.message
      });
    });
    return this._stateMutationLock;
  }

  getIncompleteOrganizeBatches() {
    if (!this.state) return [];
    // rolledBackAt without completedAt means a crash landed between the two
    // rollback-close stamps (or the journal was written by an older build
    // mid-rollback). The files were already restored, so the batch must
    // never resurface for resume/replay.
    return Object.values(this.state.organize.batches).filter(
      (batch) => !batch.completedAt && !batch.rolledBackAt
    );
  }
}

module.exports = ProcessingStateService;
module.exports.migrateLegacyPersistedBatch = migrateLegacyPersistedBatch;
