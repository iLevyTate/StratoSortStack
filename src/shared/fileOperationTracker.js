// @ts-check
/**
 * FileOperationTracker - Shared registry for tracking file operations
 *
 * Prevents infinite loops by allowing watchers to skip self-triggered events.
 * When a watcher moves/renames/analyzes a file, it records the operation here.
 * Other watchers (or the same watcher) can then check if a file was recently
 * operated on before processing it.
 *
 * @module shared/fileOperationTracker
 */

const path = require('path');
const fs = require('fs').promises;
const { createLogger } = require('./logger');
const { isCaseInsensitiveFileSystem } = require('./crossPlatformUtils');

const logger = createLogger('FileOperationTracker');
/**
 * Default cooldown period in milliseconds.
 * Files operated on within this window will be skipped by watchers.
 */
const DEFAULT_COOLDOWN_MS = 5000;

/**
 * Cleanup interval - how often to purge expired entries
 */
const CLEANUP_INTERVAL_MS = 10000;

/**
 * Persistence debounce time - don't save more often than this
 */
const PERSISTENCE_DEBOUNCE_MS = 1000;

/**
 * Hard cap on the number of entries retained in memory. A single watcher
 * burst (mass copy/move, sync tool, git checkout, etc.) can fire tens of
 * thousands of events inside the 10s cleanup window. Without a ceiling
 * the Map grows unboundedly for the cooldown duration. When we hit the
 * cap we evict the oldest entries first — those are already closest to
 * expiring anyway, so cooldown semantics degrade gracefully.
 *
 * Sized to stay comfortably under ~1 MB of resident memory even with
 * long Windows path strings.
 */
const MAX_TRACKED_OPERATIONS = 10000;

/**
 * Once the Map exceeds the cap, we trim back to this floor in a single
 * pass. Leaving headroom avoids re-trimming on every subsequent insert.
 */
const TRIM_FLOOR = Math.floor(MAX_TRACKED_OPERATIONS * 0.8);

class FileOperationTracker {
  /**
   * @typedef {{ cooldownMs?: number, persistencePath?: string }} FileOpTrackerOptions
   */
  /**
   * @param {FileOpTrackerOptions|number} [optionsOrCooldownMs] - Options object or cooldown period
   */
  constructor(optionsOrCooldownMs = DEFAULT_COOLDOWN_MS) {
    // Support both old (number) and new (object) constructor signatures
    /** @type {FileOpTrackerOptions} */
    const options =
      typeof optionsOrCooldownMs === 'number'
        ? { cooldownMs: optionsOrCooldownMs }
        : optionsOrCooldownMs || {};

    /** @type {Map<string, {timestamp: number, operationType: string, source: string}>} */
    this.recentOperations = new Map();
    this.cooldownMs = options.cooldownMs || DEFAULT_COOLDOWN_MS;
    this._persistencePath = options.persistencePath || null;
    this._cleanupTimer = null;
    this._persistenceTimer = null;
    this._isShutdown = false;
    this._initialized = false;
    this._initPromise = null;
  }

  /**
   * Initialize the tracker by loading persisted operations
   * Call this before using if persistence is enabled
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this._initialized) return;
    if (this._initPromise) return this._initPromise;

    this._initPromise = this._loadPersistedOperations();
    await this._initPromise;
    this._initialized = true;
  }

  /**
   * Load persisted operations from disk
   * @private
   */
  async _loadPersistedOperations() {
    if (!this._persistencePath) return;

    try {
      const data = await fs.readFile(this._persistencePath, 'utf8');
      const parsed = JSON.parse(data);

      if (Array.isArray(parsed)) {
        const now = Date.now();
        let loaded = 0;

        // Hard-cap the load side too: a corrupted or tampered
        // persistence file must not be able to inflate the in-memory
        // Map beyond our ceiling on first read.
        for (const entry of parsed) {
          if (this.recentOperations.size >= MAX_TRACKED_OPERATIONS) break;
          // Only load non-expired entries
          if (entry && entry.path && entry.timestamp && now - entry.timestamp <= this.cooldownMs) {
            const normalizedPath = this._resolveForTracking(entry.path);
            this.recentOperations.set(normalizedPath, {
              timestamp: entry.timestamp,
              operationType: entry.operationType || 'unknown',
              source: entry.source || 'persisted'
            });
            loaded++;
          }
        }

        if (loaded > 0) {
          logger.info('[FILE-OP-TRACKER] Loaded persisted operations', { count: loaded });
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn('[FILE-OP-TRACKER] Error loading persisted operations:', error.message);
      }
    }
  }

  /**
   * Persist operations to disk (debounced)
   * @private
   */
  _schedulePersistence() {
    if (!this._persistencePath || this._isShutdown) return;

    if (this._persistenceTimer) {
      clearTimeout(this._persistenceTimer);
    }

    this._persistenceTimer = setTimeout(async () => {
      this._persistenceTimer = null;
      await this._persistOperations();
    }, PERSISTENCE_DEBOUNCE_MS);

    if (this._persistenceTimer.unref) {
      this._persistenceTimer.unref();
    }
  }

  /**
   * Persist current operations to disk
   * @private
   */
  async _persistOperations() {
    if (!this._persistencePath || this._isShutdown) return;

    try {
      const data = Array.from(this.recentOperations.entries()).map(([filePath, entry]) => ({
        path: filePath,
        timestamp: entry.timestamp,
        operationType: entry.operationType,
        source: entry.source
      }));

      await fs.mkdir(path.dirname(this._persistencePath), { recursive: true });
      await fs.writeFile(this._persistencePath, JSON.stringify(data), 'utf8');
    } catch (error) {
      logger.warn('[FILE-OP-TRACKER] Error persisting operations:', error.message);
    }
  }

  /**
   * Resolve and normalize a file path for consistent map lookups.
   * On Windows, lowercases for case-insensitive comparison.
   * Distinct from the security-oriented sanitizePath in pathSanitization.js.
   * @param {string} filePath - Path to normalize
   * @returns {string} Normalized path
   * @private
   */
  _resolveForTracking(filePath) {
    const normalized = path.normalize(filePath);
    return isCaseInsensitiveFileSystem() ? normalized.toLowerCase() : normalized;
  }

  /**
   * Record an operation on a file
   * @param {string} filePath - Path to the file that was operated on
   * @param {string} operationType - Type of operation ('move', 'analyze', 'rename', etc.)
   * @param {string} source - Source of the operation ('downloadWatcher', 'smartFolderWatcher', etc.)
   */
  recordOperation(filePath, operationType, source) {
    if (this._isShutdown) {
      return;
    }

    const normalizedPath = this._resolveForTracking(filePath);

    this.recentOperations.set(normalizedPath, {
      timestamp: Date.now(),
      operationType,
      source
    });

    // Defence-in-depth against unbounded growth between cleanup ticks.
    // A watcher burst can outrun the 10s timer; enforce a hard ceiling
    // so we never balloon the tracker to hundreds of MB before the
    // timer fires.
    if (this.recentOperations.size > MAX_TRACKED_OPERATIONS) {
      this._enforceSizeCap();
    }

    logger.debug('[FILE-OP-TRACKER] Recorded operation:', {
      path: normalizedPath,
      type: operationType,
      source,
      cooldownMs: this.cooldownMs
    });

    this._scheduleCleanup();
    this._schedulePersistence();
  }

  /**
   * Drop the oldest entries until we're back under {@link TRIM_FLOOR}.
   * Map iteration order preserves insertion order in ES2015+, so the
   * first entries are the oldest — no sort required.
   * @private
   */
  _enforceSizeCap() {
    const toDrop = this.recentOperations.size - TRIM_FLOOR;
    if (toDrop <= 0) return;

    let dropped = 0;
    for (const key of this.recentOperations.keys()) {
      if (dropped >= toDrop) break;
      this.recentOperations.delete(key);
      dropped += 1;
    }

    logger.warn('[FILE-OP-TRACKER] Hit size cap; evicted oldest entries', {
      dropped,
      remaining: this.recentOperations.size,
      cap: MAX_TRACKED_OPERATIONS
    });
  }

  /**
   * Check if a file was recently operated on
   * @param {string} filePath - Path to check
   * @param {string} [excludeSource] - Optional source to exclude (allows same source to re-process)
   * @returns {boolean} True if file is in cooldown period
   */
  wasRecentlyOperated(filePath, excludeSource = null) {
    if (this._isShutdown) {
      return false;
    }

    const normalizedPath = this._resolveForTracking(filePath);
    const entry = this.recentOperations.get(normalizedPath);

    if (!entry) {
      return false;
    }

    const elapsed = Date.now() - entry.timestamp;

    // Check if still within cooldown
    if (elapsed > this.cooldownMs) {
      // Expired - clean up and return false
      this.recentOperations.delete(normalizedPath);
      return false;
    }

    // Optionally allow same source to re-process (for legitimate re-analysis)
    if (excludeSource && entry.source === excludeSource) {
      return false;
    }

    logger.debug('[FILE-OP-TRACKER] File in cooldown:', {
      path: normalizedPath,
      source: entry.source,
      type: entry.operationType,
      elapsedMs: elapsed,
      remainingMs: this.cooldownMs - elapsed
    });

    return true;
  }

  /**
   * Get operation info for a file (for debugging/logging)
   * @param {string} filePath - Path to check
   * @returns {object|null} Operation info or null if not found/expired
   */
  getOperationInfo(filePath) {
    const normalizedPath = this._resolveForTracking(filePath);
    const entry = this.recentOperations.get(normalizedPath);

    if (!entry) {
      return null;
    }

    const elapsed = Date.now() - entry.timestamp;
    if (elapsed > this.cooldownMs) {
      this.recentOperations.delete(normalizedPath);
      return null;
    }

    return {
      ...entry,
      elapsedMs: elapsed,
      remainingMs: this.cooldownMs - elapsed
    };
  }

  /**
   * Schedule cleanup of expired entries
   * @private
   */
  _scheduleCleanup() {
    if (this._cleanupTimer || this._isShutdown) {
      return;
    }

    this._cleanupTimer = setTimeout(() => {
      this._cleanupTimer = null;
      this._cleanupExpired();
    }, CLEANUP_INTERVAL_MS);

    // Don't prevent process exit
    if (this._cleanupTimer.unref) {
      this._cleanupTimer.unref();
    }
  }

  /**
   * Remove expired entries from the map
   * @private
   */
  _cleanupExpired() {
    if (this._isShutdown) {
      return;
    }

    const now = Date.now();
    let cleaned = 0;

    for (const [filePath, entry] of this.recentOperations) {
      if (now - entry.timestamp > this.cooldownMs) {
        this.recentOperations.delete(filePath);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug('[FILE-OP-TRACKER] Cleaned expired entries', { count: cleaned });
    }

    // Schedule another cleanup if there are still entries
    if (this.recentOperations.size > 0) {
      this._scheduleCleanup();
    }
  }

  /**
   * Clear all tracked operations (useful for testing)
   */
  clear() {
    this.recentOperations.clear();
    if (this._cleanupTimer) {
      clearTimeout(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    if (this._persistenceTimer) {
      clearTimeout(this._persistenceTimer);
      this._persistenceTimer = null;
    }
  }

  /**
   * Shutdown the tracker and release resources
   * Persists remaining operations before shutdown
   */
  async shutdown() {
    // Persist any remaining operations before clearing
    if (this._persistencePath && this.recentOperations.size > 0) {
      await this._persistOperations();
    }

    this._isShutdown = true;
    this.clear();
    logger.debug('[FILE-OP-TRACKER] Shutdown complete');
  }
}

// Use singleton factory to prevent race conditions in getInstance()
const { createSingletonHelpers } = require('./singletonFactory');

const { getInstance, resetInstance, registerWithContainer } = /** @type {any} */ (
  createSingletonHelpers({
    ServiceClass: FileOperationTracker,
    serviceId: 'FILE_OPERATION_TRACKER',
    serviceName: 'FileOperationTracker',
    getContainer: () => require('../main/services/ServiceContainer'),
    shutdownMethod: 'shutdown'
  })
);

module.exports = {
  FileOperationTracker,
  getInstance,
  resetInstance,
  registerWithContainer,
  DEFAULT_COOLDOWN_MS
};
