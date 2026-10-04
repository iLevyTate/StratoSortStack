// @ts-check
/**
 * Redux State Migrations
 *
 * Handles migrating persisted Redux state between versions.
 * Ensure all migrations are idempotent and safe.
 */

import { logger } from '../../shared/logger';
import { collectOrganizedPathKeys, mergeOrganizedPathIndex } from '../utils/organizedPathIndex';

// Current schema version – bump this when adding a new migration
export const CURRENT_STATE_VERSION = 4;
export const MIGRATION_BACKUP_KEY = 'stratosort_redux_state_backup';
export const MIGRATION_BACKUP_MAX_BYTES = 1024 * 1024;

/**
 * Migration functions map
 * Key: Version to migrate FROM (e.g., 0 means migrate from v0 to v1)
 * Value: Function(state) => newState
 *
 * All migrations MUST be idempotent – running them twice on the same state
 * should produce the same result.
 */
const migrations = {
  // v0 → v1: Validate baseline state shape (no-op for well-formed state)
  0: (/** @type {any} */ state) => {
    const migrated = { ...state };
    const recoveredSlices = [];

    // Ensure top-level slices exist. Track which were recovered (replaced
    // with empty objects/arrays) so the user gets a banner explaining why
    // their persisted ui.settings / files.smartFolders / etc. came back blank.
    if (!migrated.ui || typeof migrated.ui !== 'object') {
      if (state && 'ui' in state) recoveredSlices.push('ui');
      migrated.ui = {};
    }
    if (!migrated.files || typeof migrated.files !== 'object') {
      if (state && 'files' in state) recoveredSlices.push('files');
      migrated.files = {};
    }
    if (!migrated.analysis || typeof migrated.analysis !== 'object') {
      if (state && 'analysis' in state) recoveredSlices.push('analysis');
      migrated.analysis = {};
    }
    // System slice is not persisted (uses initialState defaults), but validate
    // defensively in case stale data exists from an earlier version.
    if (migrated.system && typeof migrated.system !== 'object') delete migrated.system;

    // Ensure critical arrays are arrays
    if (!Array.isArray(migrated.files.selectedFiles)) migrated.files.selectedFiles = [];
    if (!Array.isArray(migrated.files.smartFolders)) migrated.files.smartFolders = [];
    if (!Array.isArray(migrated.files.organizedFiles)) migrated.files.organizedFiles = [];
    if (!Array.isArray(migrated.analysis.results)) migrated.analysis.results = [];

    if (recoveredSlices.length > 0) {
      logger.warn('[StateMigration] v0→v1 recovered malformed slice(s)', {
        recoveredSlices,
        rawTypes: recoveredSlices.map((slice) => typeof state?.[slice]).join(',')
      });
      // Surface the recovery to the user via DegradedStateBanner so they
      // understand why ui.settings / smartFolders / fileStates came back blank.
      // Without this, the migration silently zeroed slices and the only signal
      // was a console warning the user wouldn't see.
      _signalDegradedState('__STRATOSORT_STATE_SHAPE_RECOVERED__', {
        recoveredSlices,
        migrationStep: 'v0→v1'
      });
    }

    return migrated;
  },

  // v1 → v2: Remove deprecated ui.isAnalyzing (canonical source is analysisSlice)
  1: (/** @type {any} */ state) => {
    const migrated = { ...state };

    if (migrated.ui) {
      migrated.ui = { ...migrated.ui };
      delete migrated.ui.isAnalyzing;
    }

    return migrated;
  },

  // v2 → v3: Default ui.selectedTheme for state persisted before theming existed.
  2: (/** @type {any} */ state) => {
    const migrated = { ...state };

    if (migrated.ui) {
      migrated.ui = { ...migrated.ui };
      if (!migrated.ui.selectedTheme) {
        migrated.ui.selectedTheme = 'primary';
      }
    }

    return migrated;
  },

  // v3 → v4: Seed compact organizedPathIndex from rich organizedFiles history.
  // Rich history is persistence-capped at 200; the index keeps thousands of
  // path keys so already-organized files do not reappear as Discover work.
  3: (/** @type {any} */ state) => {
    const migrated = { ...state };
    const files = migrated.files && typeof migrated.files === 'object' ? { ...migrated.files } : {};
    const existingIndex = Array.isArray(files.organizedPathIndex) ? files.organizedPathIndex : [];
    const organizedFiles = Array.isArray(files.organizedFiles) ? files.organizedFiles : [];
    files.organizedPathIndex = mergeOrganizedPathIndex(
      existingIndex,
      collectOrganizedPathKeys(organizedFiles)
    );
    migrated.files = files;
    return migrated;
  }
};

export function safeBackupSerializedState(
  /** @type {any} */ serializedState,
  /** @type {any} */ storage
) {
  if (typeof serializedState !== 'string' || !storage?.setItem) {
    return { created: false, reason: 'unavailable' };
  }

  const serializedSize =
    typeof TextEncoder !== 'undefined'
      ? new TextEncoder().encode(serializedState).length
      : serializedState.length;
  if (serializedSize > MIGRATION_BACKUP_MAX_BYTES) {
    logger.warn(
      `[StateMigration] Skipping migration backup; state too large (${serializedSize} bytes)`
    );
    return { created: false, reason: 'too_large', size: serializedSize };
  }

  try {
    storage.setItem(MIGRATION_BACKUP_KEY, serializedState);
    return { created: true, size: serializedSize };
  } catch (error) {
    logger.warn('[StateMigration] Failed to persist migration backup:', error?.message);
    return { created: false, reason: 'write_failed', size: serializedSize };
  }
}

export function restoreSerializedStateBackup(
  /** @type {any} */ storage,
  targetKey = 'stratosort_redux_state'
) {
  if (!storage?.getItem || !storage?.setItem) {
    return false;
  }

  try {
    const backup = storage.getItem(MIGRATION_BACKUP_KEY);
    if (typeof backup !== 'string' || backup.length === 0) {
      return false;
    }
    storage.setItem(targetKey, backup);
    return true;
  } catch (error) {
    logger.warn('[StateMigration] Failed to restore migration backup:', error?.message);
    return false;
  }
}

export function clearSerializedStateBackup(/** @type {any} */ storage) {
  if (!storage?.removeItem) {
    return;
  }

  try {
    storage.removeItem(MIGRATION_BACKUP_KEY);
  } catch (error) {
    logger.warn('[StateMigration] Failed to clear migration backup:', error?.message);
  }
}

/**
 * Best-effort signal to any globals a host (e.g. the renderer shell) has installed
 * for degraded-mode reporting. Safe no-op in environments without `globalThis.window`.
 * @private
 */
function _signalDegradedState(/** @type {any} */ key, /** @type {any} */ detail) {
  try {
    const g = typeof globalThis !== 'undefined' ? globalThis : undefined;
    if (g?.window) {
      g.window[key] = detail ?? true;
    }
  } catch {
    // never let signalling throw
  }
}

/**
 * Migrate state to the latest version.
 *
 * Returns `null` when the persisted state cannot be safely loaded (corrupt version
 * tag, future version, or gap in the migration chain). Callers MUST treat `null` as
 * "discard and start fresh"; this is the only way to avoid loading partially-migrated
 * or forward-incompatible state that reducers will misinterpret.
 *
 * @param {Object} state - The persisted state object
 * @returns {Object|null} Migrated state object, or null to force a reset
 */
export function migrateState(state) {
  if (!state) return state;

  // Persisted state must be a plain object. An array (corrupt blob, hand-
  // edited storage, malicious downgrade) would silently spread into
  // `migrated` and pass the v0→v1 slice checks with empty defaults — no
  // banner, no warning, just a reset workspace. Refuse and signal so
  // DegradedStateBanner explains why state was discarded.
  if (Array.isArray(state)) {
    logger.error('[StateMigration] Persisted state is an array; expected object — discarding');
    _signalDegradedState('__STRATOSORT_STATE_INVALID_VERSION__', {
      rawVersion: /** @type {any} */ (state)?._version,
      currentVersion: CURRENT_STATE_VERSION,
      reason: 'root-not-object'
    });
    return null;
  }

  /** @type {any} */
  let migratedState = { ...state };
  const rawVersion = migratedState._version;
  let currentVersion = typeof rawVersion === 'number' ? rawVersion : 0;

  // Reject tampered / non-finite / negative version tags. Falling through with a
  // coerced 0 would either replay migrations over modern state or skip them entirely.
  if (!Number.isFinite(currentVersion) || currentVersion < 0) {
    logger.error(
      `[StateMigration] Invalid _version ${JSON.stringify(rawVersion)}; discarding persisted state`
    );
    _signalDegradedState('__STRATOSORT_STATE_INVALID_VERSION__', {
      rawVersion,
      currentVersion: CURRENT_STATE_VERSION
    });
    return null;
  }

  // Forward-incompatible: a newer build wrote this state. We cannot down-migrate
  // (there are no down-migration functions), and reducers for older shapes will
  // misinterpret unknown fields. Surface a degraded signal and discard.
  if (currentVersion > CURRENT_STATE_VERSION) {
    logger.error(
      `[StateMigration] Persisted _version ${currentVersion} is newer than CURRENT_STATE_VERSION ${CURRENT_STATE_VERSION}; discarding`
    );
    _signalDegradedState('__STRATOSORT_STATE_FUTURE_VERSION__', {
      rawVersion: currentVersion,
      currentVersion: CURRENT_STATE_VERSION
    });
    return null;
  }

  if (currentVersion === CURRENT_STATE_VERSION) {
    return migratedState;
  }

  logger.info(
    `[StateMigration] Migrating state from v${currentVersion} to v${CURRENT_STATE_VERSION}`
  );

  try {
    while (currentVersion < CURRENT_STATE_VERSION) {
      const migrationFn = /** @type {Record<number, Function>} */ (migrations)[currentVersion];
      // A missing migration for an older version means the chain is broken. Previous
      // behaviour silently incremented and stamped "migrated"; that produced a state
      // that reducers still trusted despite no work being done. Fail closed instead.
      if (typeof migrationFn !== 'function') {
        logger.error(
          `[StateMigration] Missing migration for v${currentVersion} -> v${currentVersion + 1}; discarding persisted state`
        );
        _signalDegradedState('__STRATOSORT_STATE_MIGRATION_GAP__', {
          fromVersion: currentVersion,
          toVersion: currentVersion + 1,
          currentVersion: CURRENT_STATE_VERSION
        });
        return null;
      }
      logger.info(
        `[StateMigration] Applying migration v${currentVersion} -> v${currentVersion + 1}`
      );
      migratedState = migrationFn(migratedState);
      currentVersion++;
    }

    migratedState._version = CURRENT_STATE_VERSION;
    logger.info('[StateMigration] Migration complete');

    return migratedState;
  } catch (error) {
    logger.error('[StateMigration] Migration failed:', error);
    // In case of fatal migration error, return null to force a state reset
    // rather than loading corrupted data
    return null;
  }
}
