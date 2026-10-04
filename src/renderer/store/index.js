// @ts-check
import { configureStore } from '@reduxjs/toolkit';
import uiReducer, { GRAPH_INSIGHTS_SECTION_KEYS } from './slices/uiSlice';
import filesReducer from './slices/filesSlice';
import analysisReducer from './slices/analysisSlice';
import systemReducer from './slices/systemSlice';
import mcpReducer from './slices/mcpServerSlice';
import aiProviderReducer from './slices/aiProviderSlice';
import licenseReducer from './slices/licenseSlice';
import ipcMiddleware, { markStoreReady } from './middleware/ipcMiddleware';
import persistenceMiddleware from './middleware/persistenceMiddleware';
import {
  migrateState,
  restoreSerializedStateBackup,
  safeBackupSerializedState,
  MIGRATION_BACKUP_KEY
} from './migrations';
import { PHASES, PHASE_ORDER } from '../../shared/constants';
import { normalizeNamingConventionState } from '../../shared/namingConventions';
import { logger } from '../../shared/logger';
import {
  collectOrganizedPathKeys,
  mergeOrganizedPathIndex,
  normalizeOrganizedPathIndex
} from '../utils/organizedPathIndex';

// Helper to serialize file objects loaded from localStorage
// Converts Date objects to ISO strings for Redux compatibility
const serializeLoadedFile = (/** @type {any} */ file) => {
  if (!file || typeof file !== 'object') return file;
  const serialized = { ...file };
  ['created', 'modified', 'accessed', 'birthtime', 'mtime', 'atime', 'ctime'].forEach((key) => {
    if (serialized[key]) {
      // Handle both Date objects and date strings that might parse as Date
      if (serialized[key] instanceof Date) {
        serialized[key] = serialized[key].toISOString();
      } else if (typeof serialized[key] === 'string' && !serialized[key].endsWith('Z')) {
        // Already a string but might be invalid format - normalize it
        try {
          const date = new Date(serialized[key]);
          if (!isNaN(date.getTime())) {
            serialized[key] = date.toISOString();
          }
        } catch {
          // Keep original if parsing fails
        }
      }
    }
  });
  return serialized;
};

const serializeLoadedFiles = (/** @type {any} */ files) => {
  if (files == null) return [];
  if (!Array.isArray(files)) {
    logger.warn('[Store] serializeLoadedFiles received non-array input, returning empty array');
    return [];
  }
  return files.map(serializeLoadedFile);
};

/**
 * Normalize persisted fileStates for a fresh app bootstrap.
 *
 * We intentionally reset `analysis.isAnalyzing` during hydration, so any
 * persisted per-file "analyzing" markers are stale by definition on launch.
 */
const normalizeHydratedFileStates = (/** @type {any} */ fileStates) => {
  if (!fileStates || typeof fileStates !== 'object' || Array.isArray(fileStates)) {
    return {};
  }

  /** @type {Record<string, any>} */
  const normalized = {};
  for (const [filePath, stateInfo] of Object.entries(fileStates)) {
    if (!filePath || !stateInfo || typeof stateInfo !== 'object' || Array.isArray(stateInfo)) {
      continue;
    }

    const nextState = /** @type {any} */ ({ ...stateInfo });
    const currentState = String(nextState.state || '').toLowerCase();
    if (currentState === 'analyzing' || currentState === 'in_progress') {
      nextState.state = 'pending';
    }
    normalized[filePath] = nextState;
  }

  return normalized;
};

/**
 * Lightweight type validation for loaded state.
 * Fixes corrupted values to their defaults rather than rejecting the entire state.
 * This catches cases where persisted data was mangled (e.g., an array stored as a string).
 */
const validateLoadedState = (/** @type {any} */ rawState) => {
  if (!rawState || typeof rawState !== 'object') return null;

  // Clone before mutating so we never hand the caller a mutated reference
  // to their input. The old in-place fixes silently rewrote fields on the
  // input object, which is surprising for a function named "validate" and
  // makes migration debugging harder (the raw blob the caller logged
  // differs from the blob on disk). `structuredClone` is preferred; fall
  // back to JSON round-trip for objects that may contain non-cloneable
  // values so we never throw inside the hot loadState path.
  let state;
  try {
    state =
      typeof structuredClone === 'function'
        ? structuredClone(rawState)
        : JSON.parse(JSON.stringify(rawState));
  } catch {
    try {
      state = JSON.parse(JSON.stringify(rawState));
    } catch {
      return null;
    }
  }

  if (state.ui) {
    if (
      typeof state.ui.currentPhase !== 'string' ||
      !(PHASE_ORDER || []).includes(state.ui.currentPhase)
    ) {
      state.ui.currentPhase = PHASES?.WELCOME ?? 'welcome';
    }
  }

  if (state.files) {
    if (!Array.isArray(state.files.selectedFiles)) state.files.selectedFiles = [];
    if (!Array.isArray(state.files.smartFolders)) state.files.smartFolders = [];
    if (!Array.isArray(state.files.organizedFiles)) state.files.organizedFiles = [];
    state.files.organizedPathIndex = mergeOrganizedPathIndex(
      normalizeOrganizedPathIndex(state.files.organizedPathIndex),
      collectOrganizedPathKeys(state.files.organizedFiles)
    );
    if (
      state.files.fileStates == null ||
      typeof state.files.fileStates !== 'object' ||
      Array.isArray(state.files.fileStates)
    ) {
      state.files.fileStates = {};
    }
    state.files.namingConvention = normalizeNamingConventionState(state.files.namingConvention);
  }

  if (state.analysis) {
    if (!Array.isArray(state.analysis.results)) state.analysis.results = [];
  }

  if (state.system) {
    if (!Array.isArray(state.system.notifications)) state.system.notifications = [];
  }

  return state;
};

// Load persisted state
const loadState = () => {
  try {
    const serializedState = localStorage.getItem('stratosort_redux_state');
    if (serializedState === null) {
      // Try migration from legacy state
      const legacyState = localStorage.getItem('stratosort_workflow_state');
      if (legacyState) {
        try {
          const parsedLegacy = JSON.parse(legacyState);
          const hydratedSelectedFiles = serializeLoadedFiles(
            parsedLegacy.phaseData?.selectedFiles || []
          );
          return {
            ui: {
              currentPhase: parsedLegacy.currentPhase || (PHASES?.WELCOME ?? 'welcome'),
              previousPhase: null,
              sidebarOpen: true,
              showSettings: false,
              isLoading: false,
              loadingMessage: '',
              settings: null,
              settingsLoaded: false,
              settingsLoading: false,
              settingsError: null,
              isOrganizing: false,
              isDiscovering: false,
              isProcessing: false,
              navigationError: null,
              lastOperationError: null,
              resetCounter: 0,
              graphTourDismissed: false,
              graphInsightsSection: 'insights',
              graphLegendHintDismissed: false,
              graphInsightsDockCollapsed: false,
              // Session-only flag: a fresh boot is never mid dashboard excursion.
              cameFromDashboard: false,
              viewMode: 'phased',
              // Legacy workflow state predates theming — default to primary.
              selectedTheme: 'primary'
            },
            files: {
              // Serialize dates in legacy state
              selectedFiles: hydratedSelectedFiles,
              smartFolders: parsedLegacy.phaseData?.smartFolders || [],
              smartFoldersLoaded: false,
              smartFoldersLoading: false,
              smartFoldersError: null,
              organizedFiles: serializeLoadedFiles(parsedLegacy.phaseData?.organizedFiles || []),
              organizedPathIndex: normalizeOrganizedPathIndex(
                parsedLegacy.phaseData?.organizedPathIndex
              ),
              fileStates: normalizeHydratedFileStates(parsedLegacy.phaseData?.fileStates || {}),
              namingConvention: parsedLegacy.phaseData?.namingConvention || {
                convention: 'subject-date',
                dateFormat: 'YYYY-MM-DD',
                caseConvention: 'kebab-case',
                separator: '-'
              }
            },
            analysis: {
              results: serializeLoadedFiles(parsedLegacy.phaseData?.analysisResults || []),
              isAnalyzing: false,
              analysisProgress: { current: 0, total: 0, lastActivity: 0 },
              currentAnalysisFile: ''
            }
          };
        } catch {
          return undefined;
        }
      }
      return undefined;
    }
    // Parse FIRST, back up after. The backup key must always hold the last
    // KNOWN-GOOD blob: backing up before parsing meant a corrupt live blob
    // (quota-truncated write, crash mid-save) clobbered the previous good
    // backup — destroying the only recovery path at exactly the moment it
    // was needed. The corrupt blob is stashed under a separate forensics key.
    let parsedRaw;
    let recoveredFromBackup = false;
    try {
      parsedRaw = JSON.parse(serializedState);
    } catch (parseError) {
      // Live blob is unparseable — attempt recovery from the last-good backup
      // instead of silently dropping the user's workspace.
      try {
        localStorage.setItem('stratosort_redux_state_corrupt', serializedState.slice(0, 262144));
      } catch {
        // Forensics stash is best-effort only
      }
      const backup = localStorage.getItem(MIGRATION_BACKUP_KEY);
      if (typeof backup !== 'string' || backup.length === 0) {
        throw parseError; // No backup — outer catch starts fresh
      }
      parsedRaw = JSON.parse(backup); // If also corrupt, outer catch handles it
      recoveredFromBackup = true;
      restoreSerializedStateBackup(localStorage); // Re-seed the live key with the good blob
      logger.warn('[Store] Persisted state was corrupt; restored from last-good backup');
    }
    if (!recoveredFromBackup) {
      safeBackupSerializedState(serializedState, localStorage);
    }
    const migrated = migrateState(parsedRaw);
    const parsed = migrated ? validateLoadedState(migrated) : null;

    if (!parsed) {
      // Migration failed or returned null - start fresh
      restoreSerializedStateBackup(localStorage);
      logger.warn('[Store] State migration returned null, starting with fresh state');
      return undefined;
    }

    // Only claim the restore AFTER migration/validation succeeded — if the
    // backup blob fails migration the store starts fresh, and showing the
    // "restored from backup" banner then would be a lie.
    if (recoveredFromBackup) {
      /** @type {any} */ (window).__STRATOSORT_STATE_RESTORED_FROM_BACKUP__ = true;
    }

    // Don't clear the backup yet — defer to the first successful save in
    // persistenceMiddleware. If the renderer reloads (HMR, crash, quota-
    // degraded reset) between load and first save, clearing here would have
    // wiped the recoverable backup before the live blob was replaced.
    // persistenceMiddleware sets window.__STRATOSORT_BACKUP_CLEARED__ once
    // the first save lands.

    // State TTL: expire persisted state after the configured window to prevent
    // stale data issues when the app hasn't been used for a while, so users
    // start fresh rather than resuming an outdated workflow. Driven by the
    // user's `workflowRestoreMaxAge` setting (read from the same persisted blob
    // we're loading); clamped to the VALIDATION_RULES bounds (1m..24h) with a
    // 24h default for missing/out-of-range values.
    // P-005: same *value* as UI_WORKFLOW.RESTORE_MAX_AGE_MS (src/shared/constants.js)
    // but a DISTINCT concept (persisted-state TTL, not session-restore age) — keep
    // it a local literal; do not import/couple the two, they may diverge.
    const DEFAULT_STATE_TTL_MS = 24 * 60 * 60 * 1000;
    const configuredMaxAge = Number(parsed?.ui?.settings?.workflowRestoreMaxAge);
    const STATE_TTL_MS =
      Number.isFinite(configuredMaxAge) &&
      configuredMaxAge >= 60000 &&
      configuredMaxAge <= DEFAULT_STATE_TTL_MS
        ? configuredMaxAge
        : DEFAULT_STATE_TTL_MS;
    const parsedTimestamp = Number(parsed.timestamp);
    const hasValidTimestamp = Number.isFinite(parsedTimestamp);
    // Default missing timestamps to current time rather than POSITIVE_INFINITY.
    // This gives migrated or legacy states one more session before TTL applies,
    // and the next save will write a proper timestamp.
    const stateAgeMs = hasValidTimestamp ? Date.now() - parsedTimestamp : 0;

    if (!hasValidTimestamp) {
      logger.warn(
        '[Store] Persisted state missing/invalid timestamp; treating as fresh for this session'
      );
    }

    if (stateAgeMs > STATE_TTL_MS) {
      // This prevents silent data loss confusion
      /** @type {any} */ (window).__STRATOSORT_STATE_EXPIRED__ = true;
      /** @type {any} */ (window).__STRATOSORT_STATE_EXPIRED_AGE_HOURS__ = hasValidTimestamp
        ? Math.round(stateAgeMs / (1000 * 60 * 60))
        : 24;

      // Drop the expired blob so the next persistence flush writes a
      // fresh snapshot with a current timestamp. Without this, every
      // reload within the same browser session kept reading the same
      // stale timestamp and kept flipping the expired banner on until
      // a user action happened to trigger a save — users reported the
      // banner "wouldn't go away" on quick restarts.
      try {
        localStorage.removeItem('stratosort_redux_state');
      } catch {
        // Storage may be disabled or quota-exceeded; surfacing is not
        // critical here because the next save path has its own quota
        // fallback, and the in-memory return value below is correct.
      }

      // Preserve durable data (smart folders + organization history) while resetting session state.
      return /** @type {any} */ ({
        ui: {
          currentPhase: PHASES?.WELCOME ?? 'welcome',
          previousPhase: null,
          sidebarOpen: true,
          showSettings: false,
          isLoading: false,
          loadingMessage: '',
          settings: null,
          settingsLoaded: false,
          settingsLoading: false,
          settingsError: null,
          isOrganizing: false,
          isDiscovering: false,
          isProcessing: false,
          navigationError: null,
          lastOperationError: null,
          resetCounter: 0,
          graphTourDismissed: false,
          graphInsightsSection: 'insights',
          graphLegendHintDismissed: false,
          graphInsightsDockCollapsed: false,
          // Session-only flag: a fresh boot is never mid dashboard excursion.
          cameFromDashboard: false,
          // viewMode is a durable preference, not session state — preserve it
          // across TTL expiry the same way smart folders are preserved below.
          viewMode: parsed?.ui?.viewMode === 'dashboard' ? 'dashboard' : 'phased',
          // selectedTheme is a durable visual preference — preserve across TTL,
          // preferring the synchronous mirror key over the (maybe-stale) blob.
          selectedTheme: resolveDurableSelectedTheme(parsed?.ui?.selectedTheme)
        },
        files: {
          selectedFiles: [],
          organizedFiles: serializeLoadedFiles(parsed.files?.organizedFiles || []),
          organizedPathIndex: normalizeOrganizedPathIndex(parsed.files?.organizedPathIndex),
          smartFolders: parsed.files?.smartFolders || [],
          smartFoldersLoaded: false,
          smartFoldersLoading: false,
          smartFoldersError: null,
          fileStates: {},
          namingConvention: parsed.files?.namingConvention || {
            convention: 'subject-date',
            dateFormat: 'YYYY-MM-DD',
            caseConvention: 'kebab-case',
            separator: '-'
          }
        },
        analysis: {
          isAnalyzing: false,
          analysisProgress: { current: 0, total: 0, lastActivity: 0 },
          currentAnalysisFile: '',
          results: []
        },
        system: {
          metrics: { cpu: 0, memory: 0, uptime: 0 },
          health: {
            // In-process services (Orama, node-llama-cpp) are always online after init.
            // No IPC event updates these, so they must match systemSlice initialState.
            vectorDb: 'online',
            llama: 'online'
          },
          notifications: [],
          unreadNotificationCount: 0,
          version: '1.0.0',
          documentsPath: null, // Will be re-fetched by fetchDocumentsPath thunk
          documentsPathLoaded: false,
          documentsPathLoading: false,
          documentsPathError: null,
          redactPaths: null,
          redactPathsLoaded: false,
          redactPathsLoading: false,
          redactPathsError: null,
          degradedFlags: [],
          degradedFlagsLoaded: false,
          degradedFlagsError: null
        }
      });
    }

    // from persisted state overriding slice initial state defaults
    const hydratedSelectedFiles = serializeLoadedFiles(parsed.files?.selectedFiles || []);
    const hydratedFileStates = normalizeHydratedFileStates(parsed.files?.fileStates || {});
    return {
      ui: {
        currentPhase: parsed.ui?.currentPhase || (PHASES?.WELCOME ?? 'welcome'),
        previousPhase: parsed.ui?.previousPhase || null,
        sidebarOpen: parsed.ui?.sidebarOpen !== false, // default true
        // Do not rehydrate transient overlays on startup
        showSettings: false,
        isLoading: false, // Always reset loading state
        loadingMessage: '',
        settings: parsed.ui?.settings || null,
        settingsLoaded: false,
        settingsLoading: false,
        settingsError: null,
        isOrganizing: false,
        isDiscovering: false,
        isProcessing: false,
        navigationError: null,
        lastOperationError: null,
        resetCounter: 0,
        // "Don't show again" lives in two places by design: persisted Redux
        // state (saved by the debounced persistence middleware) and a
        // localStorage key that GraphTour writes *synchronously* on dismiss.
        // The synchronous key is the durable fallback for the case where the
        // debounced Redux save hasn't flushed before the app quits — so we
        // read it but MUST NOT delete it here, or an immediate close right
        // after dismissing would resurface the tour on next launch. `resetUi`
        // already preserves this preference intentionally, so there is no
        // "ghost after reset" to clean up; clearing is handled by the explicit
        // re-show flow (unchecking the box) which removes both stores.
        graphTourDismissed: (() => {
          const fromState = parsed.ui?.graphTourDismissed === true;
          let fromLegacy = false;
          if (typeof localStorage !== 'undefined') {
            try {
              fromLegacy = localStorage.getItem('graphTourDismissed') === 'true';
            } catch {
              /* private mode or quota — accept whatever we read */
            }
          }
          return fromState || fromLegacy;
        })(),
        graphInsightsSection: (() => {
          const v = parsed.ui?.graphInsightsSection;
          if (v == null) return 'insights';
          return GRAPH_INSIGHTS_SECTION_KEYS.includes(v) ? v : 'insights';
        })(),
        graphLegendHintDismissed: parsed.ui?.graphLegendHintDismissed === true,
        graphInsightsDockCollapsed: parsed.ui?.graphInsightsDockCollapsed === true,
        // Session-only flag: a fresh boot is never mid dashboard excursion.
        cameFromDashboard: false,
        viewMode: parsed.ui?.viewMode === 'dashboard' ? 'dashboard' : 'phased',
        selectedTheme: resolveDurableSelectedTheme(parsed.ui?.selectedTheme)
      },
      files: {
        // Ensure arrays and serialize dates, with explicit defaults for all properties
        selectedFiles: hydratedSelectedFiles,
        organizedFiles: serializeLoadedFiles(parsed.files?.organizedFiles || []),
        organizedPathIndex: normalizeOrganizedPathIndex(parsed.files?.organizedPathIndex),
        smartFolders: parsed.files?.smartFolders || [],
        smartFoldersLoaded: false,
        smartFoldersLoading: false,
        smartFoldersError: null,
        fileStates: hydratedFileStates,
        namingConvention: parsed.files?.namingConvention || {
          convention: 'subject-date',
          dateFormat: 'YYYY-MM-DD',
          caseConvention: 'kebab-case',
          separator: '-'
        }
      },
      analysis: {
        isAnalyzing: false, // Reset analysis state on reload
        analysisProgress: { current: 0, total: 0, lastActivity: 0 },
        currentAnalysisFile: '',
        // Serialize dates in analysis results too
        results: serializeLoadedFiles(parsed.analysis?.results || [])
      }
      // System slice is NOT restored from persistence. It uses its own initialState
      // defaults (systemSlice.js) and re-fetches documentsPath/redactPaths via IPC
      // thunks dispatched in index.js on every startup.
    };
  } catch {
    return undefined;
  }
};

const __REDUX_DEV_HMR_KEY__ = '__STRATOSORT_REDUX_STORE__';
const isDev = process.env.NODE_ENV === 'development';

const DURABLE_THEME_VALUES = ['primary', 'light', 'dark'];

/**
 * Resolve the palette to rehydrate. App.js mirrors the selected theme to a
 * dedicated `stratosort_theme` localStorage key synchronously on every change,
 * so it survives an abrupt close even when the debounced Redux persistence blob
 * did not flush (same durable-fallback pattern as graphTourDismissed). Preferring
 * the mirror keeps the rehydrated Redux theme in agreement with index.html's
 * pre-paint splash bootstrap, so reopening shows no theme flash.
 */
function resolveDurableSelectedTheme(/** @type {any} */ parsedTheme) {
  try {
    if (typeof localStorage !== 'undefined') {
      const mirror = localStorage.getItem('stratosort_theme');
      if (DURABLE_THEME_VALUES.includes(mirror)) return mirror;
    }
  } catch {
    /* private mode / storage disabled — fall back to the persisted blob */
  }
  return DURABLE_THEME_VALUES.includes(parsedTheme) ? parsedTheme : 'primary';
}

function createStratoSortStore() {
  const preloadedState = loadState();
  return configureStore(
    /** @type {any} */ ({
      reducer: {
        ui: uiReducer,
        files: filesReducer,
        analysis: analysisReducer,
        system: systemReducer,
        mcp: mcpReducer,
        aiProvider: aiProviderReducer,
        // Never persisted (see persistenceMiddleware): entitlement state is
        // always fetched fresh from the main process at startup.
        license: licenseReducer
      },
      middleware: (/** @type {any} */ getDefaultMiddleware) =>
        getDefaultMiddleware({
          immutableCheck: {
            // Large analysis result sets can exceed the default 32ms dev warning budget.
            // Keep immutability checks enabled, but tune hot large collections and
            // high-churn system slices fed by IPC notifications/metrics.
            warnAfter: 128,
            ignoredPaths: [
              'analysis.results',
              'files.selectedFiles',
              'files.organizedFiles',
              'files.fileStates',
              'system.notifications',
              'system.metrics'
            ]
          },
          serializableCheck: {
            // Keep serializable safety checks on in development, but relax the threshold
            // and skip known large, frequently-updated analysis/system payloads.
            // Note: ignoredActions skips only the action payload check; the full state is still
            // walked after each dispatch, so hot actions like analysis/updateProgress can exceed
            // a tight warnAfter when the rest of the tree is large.
            warnAfter: 512,
            // Ignore non-serializable values in actions if needed (e.g. Error objects)
            ignoredActions: [
              'analysis/startAnalysis',
              'analysis/updateProgress',
              'analysis/setAnalysisResults',
              'files/setSelectedFiles',
              'files/addSelectedFiles',
              'files/setFileStates',
              'files/setOrganizedFiles',
              'system/addNotification',
              'system/updateMetrics',
              'system/updateHealth'
            ],
            // Ignore date fields that might have Date objects from IPC responses
            ignoredActionPaths: [
              'payload.created',
              'payload.modified',
              'payload.accessed',
              'payload.birthtime',
              'payload.mtime',
              'payload.atime',
              'payload.ctime',
              'payload.analysis',
              'payload.results',
              'payload.fileStates',
              'meta.arg'
            ],
            ignoredPaths: [
              'analysis.results.error',
              'analysis.results',
              'files.selectedFiles',
              'files.organizedFiles',
              'files.fileStates',
              'system.notifications',
              'system.metrics',
              // File date fields - these are serialized but might briefly contain Date objects during IPC
              /files\.selectedFiles\.\d+\.(created|modified|accessed|birthtime|mtime|atime|ctime)/,
              /files\.organizedFiles\.\d+\.(created|modified|accessed|birthtime|mtime|atime|ctime)/,
              /analysis\.results\.\d+\.(created|modified|accessed|birthtime|mtime|atime|ctime)/,
              /system\.notifications\.\d+\.(timestamp|displayedAt|seenAt|dismissedAt)/
            ]
          }
        }).concat(ipcMiddleware, persistenceMiddleware),
      preloadedState
    })
  );
}

let store;
const windowAny = /** @type {any} */ (typeof window !== 'undefined' ? window : {});
const moduleAny = /** @type {any} */ (typeof module !== 'undefined' ? module : {});
const isWebpackHmr = isDev && typeof window !== 'undefined' && !!moduleAny.hot;

if (isWebpackHmr && windowAny[__REDUX_DEV_HMR_KEY__]) {
  store = windowAny[__REDUX_DEV_HMR_KEY__];
  logger.debug('[Store] Reusing Redux store across HMR (in-memory state preserved)');
} else {
  store = createStratoSortStore();
  if (isWebpackHmr) {
    windowAny[__REDUX_DEV_HMR_KEY__] = store;
  }
}

markStoreReady();

// NOTE: State-expiration notification is handled by WelcomePhase.jsx (which
// shows a visible toast). The TTL-expired loadState path always resets to the
// WELCOME phase, so WelcomePhase is guaranteed to mount and display the notice.
// A previous duplicate handler here dispatched a silent Redux entry, causing
// two notification records for the same event.

export default store;
