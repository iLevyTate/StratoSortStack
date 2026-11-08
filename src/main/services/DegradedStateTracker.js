// @ts-check
/**
 * DegradedStateTracker
 *
 * Process-local registry of subsystems running in a degraded state. Several
 * subsystems previously log-and-continue on recoverable failures (Orama corrupt
 * persistence, dimension-change wipes, atomic-journal init, chat table migration,
 * Redux state migration gaps). That behaviour masks real data-integrity issues
 * from the user. This tracker gives them a single place to raise a flag so the
 * renderer can surface a banner and so diagnostics can see the state.
 *
 * Flags are identified by a short stable `code`. Re-raising the same code with
 * the same payload is a no-op (idempotent). `severity` is one of "warning" |
 * "error". The renderer is expected to poll via IPC (system:get-degraded-state)
 * or subscribe to the emitted events.
 *
 * Deliberately kept dependency-free of other services so it can be required
 * from anywhere without creating cycles.
 *
 * @module services/DegradedStateTracker
 */

const { EventEmitter } = require('events');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('DegradedStateTracker');

/** @typedef {'warning' | 'error'} DegradedSeverity */

/**
 * @typedef {Object} DegradedFlag
 * @property {string} code        Stable identifier (e.g. `orama.corrupt-persistence`)
 * @property {string} subsystem   High-level subsystem label (e.g. `vector-db`)
 * @property {DegradedSeverity} severity
 * @property {string} message     Human-readable description
 * @property {Record<string, any>} [detail]    Optional structured payload
 * @property {number} raisedAt    Epoch ms when first raised
 * @property {number} lastSeenAt  Epoch ms of most recent raise
 * @property {number} count       Number of times raised (>=1)
 * @property {boolean} dismissed  User-dismissed in UI (still tracked for logs)
 * @property {string[]} [sources] Subsystems currently holding the flag up, for a
 *   flag more than one subsystem raises (see raise({ source }))
 */

const MAX_FLAGS = 64;

class DegradedStateTracker extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, DegradedFlag>} */
    this._flags = new Map();
    // code -> the subsystems that raised it with a `source`. A flag two
    // subsystems share stays up until every one of them has cleared it, so
    // one recovering cannot lift the other's condition.
    /** @type {Map<string, Set<string>>} */
    this._sources = new Map();
  }

  /**
   * Raise or update a flag. Safe to call many times; duplicate raises just bump
   * `count` and `lastSeenAt`. Pass `source` when several subsystems raise the
   * same code; clear(code, source) then releases only that subsystem's hold.
   * @param {Omit<DegradedFlag, 'raisedAt' | 'lastSeenAt' | 'count' | 'dismissed' | 'sources'> & { source?: string }} input
   * @returns {DegradedFlag}
   */
  raise(input) {
    if (!input || typeof input.code !== 'string' || !input.code) {
      throw new TypeError('DegradedStateTracker.raise requires { code }');
    }
    const now = Date.now();
    let sourceJoined = false;
    if (typeof input.source === 'string' && input.source) {
      let sources = this._sources.get(input.code);
      if (!sources) {
        sources = new Set();
        this._sources.set(input.code, sources);
      }
      sourceJoined = !sources.has(input.source);
      sources.add(input.source);
    }
    const existing = this._flags.get(input.code);
    if (existing) {
      existing.lastSeenAt = now;
      existing.count += 1;
      // Allow severity to escalate (warning -> error) but not downgrade.
      const escalated = input.severity === 'error' && existing.severity !== 'error';
      if (escalated) {
        existing.severity = 'error';
      }
      // A dismissal covered the condition the user saw. Another subsystem
      // joining the flag, or an escalation, is new: show the banner again.
      // A plain repeat of the same raise stays dismissed.
      if (sourceJoined || escalated) existing.dismissed = false;
      if (input.message) existing.message = input.message;
      if (input.detail) existing.detail = input.detail;
      this._syncSources(existing);
      this.emit('update', snapshot(existing));
      return snapshot(existing);
    }

    if (this._flags.size >= MAX_FLAGS) {
      // Evict the oldest flag to keep the set bounded; degraded state should not
      // be a memory leak vector.
      const oldestKey = this._flags.keys().next().value;
      if (oldestKey) {
        this._flags.delete(oldestKey);
        this._sources.delete(oldestKey);
      }
    }

    /** @type {DegradedFlag} */
    const flag = {
      code: input.code,
      subsystem: input.subsystem || 'unknown',
      severity: input.severity === 'error' ? 'error' : 'warning',
      message: input.message || input.code,
      detail: input.detail,
      raisedAt: now,
      lastSeenAt: now,
      count: 1,
      dismissed: false
    };
    this._syncSources(flag);
    this._flags.set(flag.code, flag);
    logger.warn('[DegradedState] flag raised', {
      code: flag.code,
      subsystem: flag.subsystem,
      severity: flag.severity,
      message: flag.message
    });
    this.emit('raised', snapshot(flag));
    return snapshot(flag);
  }

  /**
   * @private
   * @param {DegradedFlag} flag
   */
  _syncSources(flag) {
    const sources = this._sources.get(flag.code);
    if (sources && sources.size > 0) flag.sources = [...sources];
    else delete flag.sources;
  }

  /**
   * Clear a flag entirely (e.g. after user runs a rebuild and the subsystem is
   * healthy again). Use `dismiss` instead to keep the record but hide from UI.
   *
   * With `source`, only that subsystem's hold is released: the flag goes away
   * once no source holds it, and a source that never raised it changes
   * nothing. While another source still holds it the flag stays, dismissed
   * or not.
   * @param {string} code
   * @param {string} [source]
   * @returns {boolean} true if a flag was removed
   */
  clear(code, source) {
    if (typeof source === 'string') {
      const sources = this._sources.get(code);
      if (!sources || !sources.delete(source)) return false;
      if (sources.size > 0) {
        const flag = this._flags.get(code);
        if (flag) {
          this._syncSources(flag);
          this.emit('update', snapshot(flag));
        }
        return false;
      }
    }
    this._sources.delete(code);
    const existed = this._flags.delete(code);
    if (existed) {
      logger.info('[DegradedState] flag cleared', { code });
      this.emit('cleared', { code });
    }
    return existed;
  }

  /**
   * Mark a flag as acknowledged. The flag remains for diagnostics but UI should
   * hide it from banners.
   * @param {string} code
   * @returns {boolean}
   */
  dismiss(code) {
    const flag = this._flags.get(code);
    if (!flag) return false;
    flag.dismissed = true;
    this.emit('dismissed', { code });
    return true;
  }

  /**
   * Subsystems currently holding a flag up (empty when none raised it with a
   * `source`).
   * @param {string} code
   * @returns {string[]}
   */
  sourcesOf(code) {
    return [...(this._sources.get(code) || [])];
  }

  /**
   * Replace a raised flag's message without counting it as another raise.
   * @param {string} code
   * @param {string} message
   * @returns {boolean} true when the flag exists
   */
  setMessage(code, message) {
    const flag = this._flags.get(code);
    if (!flag) return false;
    if (message && flag.message !== message) {
      flag.message = message;
      this.emit('update', snapshot(flag));
    }
    return true;
  }

  /**
   * Snapshot all flags. Returns a shallow copy; callers can pass this across IPC.
   * @returns {DegradedFlag[]}
   */
  list() {
    return Array.from(this._flags.values()).map(snapshot);
  }

  /**
   * True when at least one flag exists and is not dismissed.
   * @returns {boolean}
   */
  hasActive() {
    for (const flag of this._flags.values()) {
      if (!flag.dismissed) return true;
    }
    return false;
  }

  /**
   * True when the flag is raised, dismissed or not. Dismissing hides the
   * banner; it does not make the condition go away, so work gated on a flag
   * reads this rather than hasActive().
   * @param {string} code
   * @returns {boolean}
   */
  isRaised(code) {
    return this._flags.has(code);
  }

  /** Reset — intended for tests. */
  _reset() {
    this._flags.clear();
    this._sources.clear();
    this.removeAllListeners();
  }
}

/**
 * Copy of a flag that shares no arrays with the tracker's own record.
 * @param {DegradedFlag} flag
 * @returns {DegradedFlag}
 */
function snapshot(flag) {
  return flag.sources ? { ...flag, sources: [...flag.sources] } : { ...flag };
}

/** @type {DegradedStateTracker|null} */
let _instance = null;
function getInstance() {
  if (!_instance) _instance = new DegradedStateTracker();
  return _instance;
}

/**
 * Raised while the disk is too full for a store to save. Background analysis
 * holds until it clears, so new results are not computed into a store that
 * cannot keep them. Two stores raise it, each under its own source
 * (STORAGE_FULL_SOURCES), so it stays up until both can save again.
 */
const STORAGE_FULL_CODE = 'storage.full';

/** The stores that raise STORAGE_FULL_CODE. */
const STORAGE_FULL_SOURCES = Object.freeze({
  VECTOR_STORE: 'vector-store',
  ANALYSIS_HISTORY: 'analysis-history'
});
/** How the banner names each store. @type {Record<string, string>} */
const STORAGE_FULL_LABELS = {
  [STORAGE_FULL_SOURCES.VECTOR_STORE]: 'search index',
  [STORAGE_FULL_SOURCES.ANALYSIS_HISTORY]: 'analysis history'
};

/**
 * @param {string[]} sources
 * @returns {string}
 */
function storageFullMessage(sources) {
  const labels = sources.map((s) => STORAGE_FULL_LABELS[s] || s);
  const what = labels.length > 0 ? labels.join(' or its ') : 'data';
  return `Your disk is full, so StratoSort cannot save its ${what}. New files are not analyzed until there is free space; it will resume on its own.`;
}

/**
 * Hold the storage-full flag up on behalf of one store. The banner names
 * every store that currently cannot save.
 * @param {string} source One of STORAGE_FULL_SOURCES
 * @param {Record<string, any>} [detail]
 */
function raiseStorageFull(source, detail) {
  const tracker = getInstance();
  const sources = new Set(tracker.sourcesOf(STORAGE_FULL_CODE));
  sources.add(source);
  tracker.raise({
    code: STORAGE_FULL_CODE,
    subsystem: 'storage',
    severity: 'error',
    source,
    message: storageFullMessage([...sources]),
    detail: { ...detail, source }
  });
}

/**
 * Release one store's hold on the storage-full flag. The flag, and the
 * watchers' hold, stay while another store still cannot save.
 * @param {string} source One of STORAGE_FULL_SOURCES
 * @returns {boolean} true when no store holds the flag any more
 */
function clearStorageFull(source) {
  const tracker = getInstance();
  if (tracker.clear(STORAGE_FULL_CODE, source)) return true;
  const remaining = tracker.sourcesOf(STORAGE_FULL_CODE);
  if (remaining.length > 0) tracker.setMessage(STORAGE_FULL_CODE, storageFullMessage(remaining));
  return !tracker.isRaised(STORAGE_FULL_CODE);
}

/** @returns {boolean} */
function isStorageFull() {
  try {
    return getInstance().isRaised(STORAGE_FULL_CODE);
  } catch {
    return false;
  }
}

module.exports = {
  DegradedStateTracker,
  getInstance,
  STORAGE_FULL_CODE,
  STORAGE_FULL_SOURCES,
  raiseStorageFull,
  clearStorageFull,
  isStorageFull
};
