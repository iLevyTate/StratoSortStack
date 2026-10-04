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
 */

const MAX_FLAGS = 64;

class DegradedStateTracker extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, DegradedFlag>} */
    this._flags = new Map();
  }

  /**
   * Raise or update a flag. Safe to call many times; duplicate raises just bump
   * `count` and `lastSeenAt`.
   * @param {Omit<DegradedFlag, 'raisedAt' | 'lastSeenAt' | 'count' | 'dismissed'>} input
   * @returns {DegradedFlag}
   */
  raise(input) {
    if (!input || typeof input.code !== 'string' || !input.code) {
      throw new TypeError('DegradedStateTracker.raise requires { code }');
    }
    const now = Date.now();
    const existing = this._flags.get(input.code);
    if (existing) {
      existing.lastSeenAt = now;
      existing.count += 1;
      // Allow severity to escalate (warning -> error) but not downgrade.
      if (input.severity === 'error' && existing.severity !== 'error') {
        existing.severity = 'error';
      }
      if (input.message) existing.message = input.message;
      if (input.detail) existing.detail = input.detail;
      this.emit('update', { ...existing });
      return { ...existing };
    }

    if (this._flags.size >= MAX_FLAGS) {
      // Evict the oldest flag to keep the set bounded; degraded state should not
      // be a memory leak vector.
      const oldestKey = this._flags.keys().next().value;
      if (oldestKey) this._flags.delete(oldestKey);
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
    this._flags.set(flag.code, flag);
    logger.warn('[DegradedState] flag raised', {
      code: flag.code,
      subsystem: flag.subsystem,
      severity: flag.severity,
      message: flag.message
    });
    this.emit('raised', { ...flag });
    return { ...flag };
  }

  /**
   * Clear a flag entirely (e.g. after user runs a rebuild and the subsystem is
   * healthy again). Use `dismiss` instead to keep the record but hide from UI.
   * @param {string} code
   * @returns {boolean} true if a flag was removed
   */
  clear(code) {
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
   * Snapshot all flags. Returns a shallow copy; callers can pass this across IPC.
   * @returns {DegradedFlag[]}
   */
  list() {
    return Array.from(this._flags.values()).map((f) => ({ ...f }));
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

  /** Reset — intended for tests. */
  _reset() {
    this._flags.clear();
    this.removeAllListeners();
  }
}

/** @type {DegradedStateTracker|null} */
let _instance = null;
function getInstance() {
  if (!_instance) _instance = new DegradedStateTracker();
  return _instance;
}

module.exports = {
  DegradedStateTracker,
  getInstance
};
