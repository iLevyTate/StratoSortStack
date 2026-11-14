// @ts-check
import { PHASES } from '../../../shared/constants';
import { DEFAULT_SETTINGS } from '../../../shared/defaultSettings';
import { logger } from '../../../shared/logger';
import { addNotification } from '../slices/systemSlice';
import { CURRENT_STATE_VERSION, clearSerializedStateBackup } from '../migrations';
import {
  MAX_ORGANIZED_PATH_INDEX,
  normalizeOrganizedPathIndex
} from '../../utils/organizedPathIndex';
import { summaryForNextLaunch } from '../../utils/organizeRunSummary';
import { normalizeRunResultRows } from '../../utils/organizeRunResults';

const SAVE_DEBOUNCE_MS = DEFAULT_SETTINGS.saveDebounceMs || 1000;
const MAX_DEBOUNCE_WAIT_MS = 5000;
// While a batch analysis runs, every finished file replaces analysis.results
// (and fileStates), and each save re-stringifies up to 200 results. On the
// normal 1 s / 5 s cadence that rewrote the whole blob every few seconds for
// the entire run. During a run that churn is saved at most this often (crash
// safety), and once more as soon as the run ends. Other changes keep the
// normal cadence.
const ANALYSIS_RUN_SAVE_INTERVAL_MS = 30000;
const MAX_LOCALSTORAGE_BYTES = 4 * 1024 * 1024;
// Rows of the last organize run ("See every file"), about 400 bytes each.
// Kept only with a summary that is kept for the next launch.
const MAX_PERSISTED_RUN_FILES = 2000;
// Files kept in the saved queue (selectedFiles) and analysis results. An
// analysis result held in memory carries the file's full extracted text,
// measured at about 130 KB (estimated bytes) for a typical spreadsheet
// export, so 200 of them were ~26 MB against the 4 MB budget and the save fell
// through to the quota fallbacks. Saved slim (slimAnalysisResult) a result is
// about 6 KB. 400 results plus 1,000 history rows fit the budget with room
// for longer summaries; 500 already measured 3.85 MB of the 4 MB
// (test/persistenceMiddleware.slimSnapshot.test.js).
const MAX_PERSISTED_QUEUE_FILES = 400;
// Organized-history rows kept. They are small (compactOrganizedEntry), and
// the Dashboard's Organized figure is their count.
const MAX_PERSISTED_ORGANIZED_FILES = 1000;
// Long text fields of an analysis result. The renderer only shows the start
// of them (the file details panel's "Extracted text" preview); search, chat
// and the organize engine read the full text in main, never from here.
const PREVIEW_TEXT_FIELDS = ['extractedText', 'ocrText', 'transcript', 'multimodalText'];
const PREVIEW_TEXT_CHARS = 500;
// Bulky analysis fields nothing in the renderer reads after a restart
// (rawText is a second copy of the start of extractedText). The details
// panel shows only the count of transcriptSegments, saved as
// transcriptSegmentCount; keyframes are kept slim (see slimAnalysisResult).
const DROPPED_ANALYSIS_FIELDS = [
  'rawText',
  'transcriptSegments',
  'embedding',
  'chunks',
  '_embeddingForPersistence'
];
// Keyframes the details panel lists (main already caps them at 50).
const MAX_PERSISTED_KEYFRAMES = 50;

/**
 * The saved form of an analysis result: long text cut to a preview, bulky
 * arrays left out. The live state keeps everything.
 * @param {any} result
 * @returns {any}
 */
function slimAnalysisResult(result) {
  const analysis = result?.analysis;
  if (!analysis || typeof analysis !== 'object') return result;
  /** @type {Record<string, any>} */
  const slim = { ...analysis };
  for (const key of DROPPED_ANALYSIS_FIELDS) delete slim[key];
  if (Array.isArray(analysis.transcriptSegments)) {
    slim.transcriptSegmentCount = analysis.transcriptSegments.length;
  }
  if (Array.isArray(analysis.keyframes)) {
    // Timestamp and caption only: all the details panel shows.
    slim.keyframes = analysis.keyframes
      .slice(0, MAX_PERSISTED_KEYFRAMES)
      .map((/** @type {any} */ k) => ({
        timestamp: k?.timestamp ?? null,
        caption: typeof k?.caption === 'string' ? k.caption : null
      }));
  }
  let fullTextLength = 0;
  let trimmed = false;
  for (const key of PREVIEW_TEXT_FIELDS) {
    if (typeof slim[key] !== 'string') continue;
    fullTextLength += slim[key].length;
    if (slim[key].length > PREVIEW_TEXT_CHARS) {
      slim[key] = slim[key].slice(0, PREVIEW_TEXT_CHARS);
      trimmed = true;
    }
  }
  // The details panel's "N characters total" would otherwise report the
  // preview length after a restart.
  if (trimmed) slim.savedTextFullLength = fullTextLength;
  return { ...result, analysis: slim };
}

/**
 * The saved form of an organized-history row: its own plain fields (paths,
 * names, folder, time, duplicateRemoval), without nested objects such as an
 * analysis payload a caller may have attached.
 * @param {any} entry
 * @returns {any}
 */
function compactOrganizedEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  /** @type {Record<string, any>} */
  const compact = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value === null || typeof value !== 'object') compact[key] = value;
  }
  return compact;
}
/** @type {NodeJS.Timeout | null} */
let saveTimeout = null;
let firstPendingRequestTime = 0; // Track when the first unsaved debounce request was made
/** @type {any} */
let lastSavedPhase = null;
/** @type {any} */
let lastSavedSidebarOpen = null;
// Reference-based change detection: Redux Toolkit (Immer) guarantees new references
// on state mutations. This catches content changes (e.g., file path updates after
// moves, re-analyzed results) even when array length is unchanged.
/** @type {any} */
let lastSavedSelectedFilesRef = null;
/** @type {any} */
let lastSavedOrganizedFilesRef = null;
/** @type {any} */
let lastSavedOrganizedPathIndexRef = null;
/** @type {any} */
let lastSavedSmartFoldersRef = null;
/** @type {any} */
let lastSavedResultsRef = null;
/** @type {any} */
let lastSavedFileStatesRef = null;
/** @type {any} */
let lastSavedNamingConventionRef = null;
// What was written for files.lastOrganizeRun, which is null for a summary that
// is not kept for the next launch. Comparing the live summary itself would
// save the whole snapshot again each time a clean run's summary came and went.
/** @type {any} */
let lastSavedLastOrganizeRunRef = null;
/** @type {any} */
let lastSavedLastOrganizeRunFilesRef = null;

/**
 * The run's file list as far as the next launch is concerned: the live array
 * while its summary is kept, otherwise null (a run that moved everything does
 * not trigger a save when its list changes).
 * @param {any} state
 */
function runFilesForNextLaunch(state) {
  return summaryForNextLaunch(state.files.lastOrganizeRun ?? null)
    ? (state.files.lastOrganizeRunFiles ?? null)
    : null;
}
/** @type {any} */
let lastSavedGraphTourDismissed = null;
/** @type {any} */
let lastSavedGraphInsightsSection = null;
/** @type {any} */
let lastSavedGraphLegendHintDismissed = null;
/** @type {any} */
let lastSavedGraphInsightsDockCollapsed = null;
/** @type {any} */
let lastSavedViewMode = null;
/** @type {any} */
let lastSavedSelectedTheme = null;
/** @type {any} */
let lastSavedSettingsRef = null;
// NOTE: showSettings is intentionally NOT persisted (transient overlay state).

let isSaving = false;
// Defer the migration backup clear until after the FIRST successful save.
// loadState() used to clear immediately on a successful load, but if the
// renderer reloaded between load and the first save (HMR, crash, quota
// fallback), the recoverable backup was wiped before the live blob got
// replaced — leaving no fallback. Clear here once we know a healthy save
// has actually landed.
let migrationBackupCleared = false;
// One-shot per session — fires when the unconditional queue cap in
// buildStateSnapshot first drops items from selectedFiles or analysis.results.
// Without this, users with >200 files in either slice silently lose the tail
// on every reload but only quota-driven truncation got a notification.
let hasNotifiedHardCap = false;

/**
 * FIX #1: Graceful quota handling - try progressively smaller saves
 * FIX CRIT-5: Returns degradation info for user notification
 * @param {string} key - localStorage key
 * @param {any} stateToSave - Full state object
 * @returns {{ success: boolean, degraded?: string }} - Result with optional degradation level
 */
function saveWithQuotaHandling(key, stateToSave) {
  // Pre-serialize once and reuse for both size estimation and storage
  let candidate = stateToSave;
  let preTruncated = false;
  let json;
  try {
    json = JSON.stringify(candidate);
  } catch {
    logger.error('Failed to serialize state');
    return { success: false };
  }

  // UTF-16 strings in JS use 2 bytes per code point; multiply by 2 as a realistic
  // estimate for typical English/path text (avoids a full TextEncoder re-encode pass).
  const estimatedBytes = json.length * 2;

  if (estimatedBytes > MAX_LOCALSTORAGE_BYTES) {
    preTruncated = true;
    candidate = {
      ...stateToSave,
      files: {
        ...stateToSave.files,
        selectedFiles: stateToSave.files.selectedFiles?.slice(-100) || [],
        organizedFiles: stateToSave.files.organizedFiles?.slice(-100) || [],
        // Keep the compact index even under size pressure — it is the durable
        // "already organized" signal Discover uses after restart.
        organizedPathIndex: normalizeOrganizedPathIndex(stateToSave.files.organizedPathIndex, {
          max: MAX_ORGANIZED_PATH_INDEX
        }),
        fileStates: Object.fromEntries(
          Object.entries(stateToSave.files.fileStates || {}).slice(-50)
        )
      },
      analysis: {
        ...stateToSave.analysis,
        results: stateToSave.analysis.results?.slice(-100) || []
      },
      _partial: true
    };
    try {
      json = JSON.stringify(candidate);
    } catch {
      logger.error('Failed to serialize reduced state');
      return { success: false };
    }
  }

  // Try full save first, reusing pre-serialized JSON
  try {
    localStorage.setItem(key, json);
    return { success: true, ...(preTruncated ? { degraded: 'reduced' } : {}) };
  } catch (error) {
    if (error.name !== 'QuotaExceededError') {
      logger.error('Failed to save state (non-quota error):', { error: error.message });
      return { success: false };
    }
  }

  // Quota exceeded - try progressively smaller saves
  logger.warn('localStorage quota exceeded, attempting graceful degradation');

  // Attempt 1: Reduce arrays to 50 items each
  try {
    const reducedState = {
      ...stateToSave,
      files: {
        ...stateToSave.files,
        selectedFiles: stateToSave.files.selectedFiles?.slice(-50) || [],
        organizedFiles: stateToSave.files.organizedFiles?.slice(-50) || [],
        organizedPathIndex: normalizeOrganizedPathIndex(stateToSave.files.organizedPathIndex, {
          max: MAX_ORGANIZED_PATH_INDEX
        }),
        fileStates: Object.fromEntries(
          Object.entries(stateToSave.files.fileStates || {}).slice(-25)
        )
      },
      analysis: {
        ...stateToSave.analysis,
        results: stateToSave.analysis.results?.slice(-50) || []
      }
    };
    localStorage.setItem(key, JSON.stringify(reducedState));
    logger.info('Saved reduced state (50 items per array)');
    return { success: true, degraded: 'reduced' };
  } catch (reducedError) {
    // Don't drop this on the floor — non-quota errors here (SecurityError when
    // storage is disabled, DOMException in private browsing) would otherwise
    // be invisible until attempt 3 also fails. Logging at warn keeps the
    // breadcrumb for postmortem without alarming users on the happy degraded
    // path where a later attempt succeeds.
    logger.warn('Reduced-state save failed; falling through to minimal state', {
      error: reducedError?.message,
      name: reducedError?.name
    });
  }

  // Attempt 2: Save only critical UI state
  try {
    const minimalState = {
      // Stamp the current schema version so the migration pipeline can
      // recognize this blob on next boot. Previously minimal/emergency
      // saves omitted `_version` entirely, which forced the migration
      // code to assume v0 and run the full chain against a partial
      // payload — sometimes succeeding, sometimes tripping the "future
      // version / unknown shape" fail-closed branch and wiping state.
      _version: CURRENT_STATE_VERSION,
      ui: stateToSave.ui,
      files: {
        smartFolders: stateToSave.files.smartFolders,
        namingConvention: stateToSave.files.namingConvention,
        /** @type {any[]} */
        selectedFiles: [],
        /** @type {any[]} */
        organizedFiles: [],
        // Prefer keeping the compact organize index over rich history when
        // quota is exhausted — this is what prevents "already organized"
        // files from looking like new Discover work after restart.
        organizedPathIndex: normalizeOrganizedPathIndex(stateToSave.files.organizedPathIndex, {
          max: MAX_ORGANIZED_PATH_INDEX
        }),
        /** @type {Record<string, any>} */
        fileStates: {}
      },
      analysis: {
        /** @type {any[]} */
        results: [],
        isAnalyzing: false,
        analysisProgress: { current: 0, total: 0, lastActivity: 0 },
        currentAnalysisFile: ''
      },
      timestamp: Date.now(),
      _partial: true // Flag to indicate partial save
    };
    localStorage.setItem(key, JSON.stringify(minimalState));
    logger.warn('Saved minimal state (UI + settings only) due to quota limits');
    return { success: true, degraded: 'minimal' };
  } catch (minimalError) {
    // Same rationale as the reduced-state catch above: log so a postmortem
    // can see all three attempts' outcomes, not just the final emergency one.
    logger.warn('Minimal-state save failed; falling through to emergency state', {
      error: minimalError?.message,
      name: minimalError?.name
    });
  }

  // Attempt 3: Clear old state and try minimal save again
  // Capture the current blob BEFORE removeItem: if the emergency setItem below
  // also fails, the old (possibly stale but real) persisted state would
  // otherwise already be gone and the next boot would start completely fresh.
  let previousBlob = null;
  try {
    previousBlob = localStorage.getItem(key);
  } catch {
    // Read failure means storage is unusable; nothing to preserve.
  }
  try {
    localStorage.removeItem(key);
    localStorage.removeItem('stratosort_workflow_state'); // Also clear old workflow state
    const emergencyState = {
      _version: CURRENT_STATE_VERSION,
      ui: { currentPhase: stateToSave.ui?.currentPhase || (PHASES?.WELCOME ?? 'welcome') },
      timestamp: Date.now(),
      _emergency: true
    };
    localStorage.setItem(key, JSON.stringify(emergencyState));
    logger.error('Emergency save: cleared old data, saved only current phase');
    return { success: true, degraded: 'emergency' };
  } catch (finalError) {
    if (typeof previousBlob === 'string') {
      try {
        localStorage.setItem(key, previousBlob);
        logger.error('Emergency save failed; restored previous persisted state');
      } catch {
        // Restore is best-effort — storage is fully broken at this point.
      }
    }
    logger.error('All save attempts failed:', { error: finalError.message });
    return { success: false, degraded: 'failed' };
  }
}

// Track beforeunload handler for cleanup. The handler is a stable closure
// that re-reads `currentStore` at fire time, so HMR or test paths that swap
// the store reference don't end up flushing a stale store. Previously the
// handler captured `store` at first registration; latent today via the HMR
// cache in store/index.js but breaks the moment that cache misses (e.g.
// hard reload after a webpack error, or future refactor of the cache).
/** @type {any} */
let persistenceUnloadHandler = null;
/** @type {any} */
let currentStore = null;

/**
 * Build the serializable state snapshot for persistence.
 * Centralizes the shape so the debounced save and cleanupPersistence
 * produce identical output — preventing drift between the two paths.
 *
 * @param {any} freshState - Current Redux state from store.getState()
 * @param {{ prioritizeFileStates?: boolean }} [options]
 * @returns {any} Serializable state object ready for localStorage
 */
function buildStateSnapshot(freshState, options = {}) {
  const { prioritizeFileStates = true } = options;
  const MAX_FILES = MAX_PERSISTED_QUEUE_FILES;
  const MAX_STATES = 100;

  const stateToSave = {
    _version: CURRENT_STATE_VERSION,
    ui: {
      currentPhase: freshState.ui.currentPhase,
      // `previousPhase` drives the "back" navigation affordance. Dropping
      // it from the snapshot meant every reload reset it to null and the
      // back button silently lost its target, which the e2e journey test
      // did not catch because it never reloads mid-flow. Persist it so
      // rehydration restores the real prior phase instead of falling
      // back to a hard-coded WELCOME guess.
      previousPhase: freshState.ui.previousPhase ?? null,
      sidebarOpen: freshState.ui.sidebarOpen,
      settings: freshState.ui.settings,
      graphTourDismissed: Boolean(freshState.ui.graphTourDismissed),
      graphInsightsSection: freshState.ui.graphInsightsSection ?? null,
      graphLegendHintDismissed: Boolean(freshState.ui.graphLegendHintDismissed),
      graphInsightsDockCollapsed: Boolean(freshState.ui.graphInsightsDockCollapsed),
      viewMode: freshState.ui.viewMode === 'dashboard' ? 'dashboard' : 'phased',
      selectedTheme: ['primary', 'light', 'dark'].includes(freshState.ui.selectedTheme)
        ? freshState.ui.selectedTheme
        : 'primary'
    },
    files: {
      selectedFiles: freshState.files.selectedFiles.slice(-MAX_FILES),
      smartFolders: freshState.files.smartFolders,
      // Tail slice: organizedFiles is append-ordered, so the most recent
      // organize results are at the end. Uncapped, a long organize history
      // blows the 4 MB pre-truncation budget and triggers the quota-fallback
      // ladder, which can wipe the rest of the session state. Rows are saved
      // compact so the Organized count and history survive a restart whole
      // up to MAX_PERSISTED_ORGANIZED_FILES.
      organizedFiles: (freshState.files.organizedFiles || [])
        .slice(-MAX_PERSISTED_ORGANIZED_FILES)
        .map(compactOrganizedEntry),
      // Compact path keys survive the rich-history cap (strings only).
      organizedPathIndex: normalizeOrganizedPathIndex(freshState.files.organizedPathIndex, {
        max: MAX_ORGANIZED_PATH_INDEX
      }),
      namingConvention: freshState.files.namingConvention,
      lastOrganizeRun: summaryForNextLaunch(freshState.files.lastOrganizeRun ?? null),
      lastOrganizeRunFiles: normalizeRunResultRows(
        runFilesForNextLaunch(freshState),
        MAX_PERSISTED_RUN_FILES
      ),
      fileStates: {}
    },
    analysis: {
      results: freshState.analysis.results.slice(-MAX_FILES).map(slimAnalysisResult),
      isAnalyzing: freshState.analysis.isAnalyzing,
      analysisProgress: freshState.analysis.analysisProgress,
      currentAnalysisFile: freshState.analysis.currentAnalysisFile
    },
    timestamp: Date.now()
  };

  // Persist fileStates with size limits
  const fileStatesEntries = Object.entries(freshState.files.fileStates || {});
  if (fileStatesEntries.length > 0) {
    if (fileStatesEntries.length <= MAX_STATES) {
      stateToSave.files.fileStates = Object.fromEntries(fileStatesEntries);
    } else if (prioritizeFileStates) {
      // Priority-based: in-progress/error states are more important than completed
      const priorityStates = [];
      const completedStates = [];
      for (const [path, stateInfo] of fileStatesEntries) {
        const stateType = stateInfo?.state || '';
        if (stateType === 'analyzing' || stateType === 'error' || stateType === 'pending') {
          priorityStates.push([path, stateInfo]);
        } else {
          completedStates.push([path, stateInfo]);
        }
      }
      const remainingSlots = MAX_STATES - priorityStates.length;
      const recentCompleted = completedStates.slice(-Math.max(0, remainingSlots));
      stateToSave.files.fileStates = Object.fromEntries(
        [...priorityStates, ...recentCompleted].slice(-MAX_STATES)
      );
    } else {
      // Simple tail slice (used by cleanup path where priority sort is less important)
      stateToSave.files.fileStates = Object.fromEntries(fileStatesEntries.slice(-MAX_STATES));
    }
  }

  return stateToSave;
}

/**
 * Compare the live state with what was last saved, split by kind of change.
 * `analysisChurn` covers the slices a running analysis rewrites per file;
 * `other` is everything else the snapshot persists.
 * @param {any} state
 * @returns {{ other: boolean, analysisChurn: boolean }}
 */
function detectUnsavedChanges(state) {
  const other =
    state.ui.graphTourDismissed !== lastSavedGraphTourDismissed ||
    state.ui.graphInsightsSection !== lastSavedGraphInsightsSection ||
    state.ui.graphLegendHintDismissed !== lastSavedGraphLegendHintDismissed ||
    state.ui.graphInsightsDockCollapsed !== lastSavedGraphInsightsDockCollapsed ||
    state.ui.viewMode !== lastSavedViewMode ||
    state.ui.selectedTheme !== lastSavedSelectedTheme ||
    state.ui.settings !== lastSavedSettingsRef ||
    state.ui.currentPhase !== lastSavedPhase ||
    state.ui.sidebarOpen !== lastSavedSidebarOpen ||
    state.files.organizedFiles !== lastSavedOrganizedFilesRef ||
    state.files.organizedPathIndex !== lastSavedOrganizedPathIndexRef ||
    state.files.smartFolders !== lastSavedSmartFoldersRef ||
    state.files.namingConvention !== lastSavedNamingConventionRef ||
    summaryForNextLaunch(state.files.lastOrganizeRun ?? null) !== lastSavedLastOrganizeRunRef ||
    runFilesForNextLaunch(state) !== lastSavedLastOrganizeRunFilesRef;
  const analysisChurn =
    state.analysis.results !== lastSavedResultsRef ||
    state.files.fileStates !== lastSavedFileStatesRef ||
    state.files.selectedFiles !== lastSavedSelectedFilesRef;
  return { other, analysisChurn };
}

/**
 * True when the only unsaved changes are the per-file churn of a running
 * analysis, which is saved on the slow ANALYSIS_RUN_SAVE_INTERVAL_MS cadence.
 * @param {any} state
 * @param {{ other: boolean, analysisChurn: boolean }} changes
 */
function isAnalysisRunChurnOnly(state, changes) {
  return Boolean(state.analysis?.isAnalyzing) && changes.analysisChurn && !changes.other;
}

const persistenceMiddleware = (/** @type {any} */ store) => {
  // Always update the module-scoped current-store ref so the unload handler
  // flushes the live store, not the first one we ever saw. (The handler is
  // registered once; without this re-binding, an HMR-swapped store would lose
  // its final-flush on window close.)
  currentStore = store;

  // Register a beforeunload handler to force a final save when the window closes.
  // Without this, up to 5s of debounced state changes could be lost on close.
  if (!persistenceUnloadHandler && typeof window !== 'undefined') {
    persistenceUnloadHandler = () => {
      if (currentStore) cleanupPersistence(currentStore);
    };
    window.addEventListener('beforeunload', persistenceUnloadHandler);
  }

  return (/** @type {any} */ next) => (/** @type {any} */ action) => {
    const result = next(action);
    const state = store.getState();

    if (isSaving) {
      return result;
    }

    const isWelcomePhase = state.ui.currentPhase === (PHASES?.WELCOME ?? 'welcome');
    const currentOrganizedFilesCount = state.files.organizedFiles.length;
    const currentOrganizedPathIndexCount = Array.isArray(state.files.organizedPathIndex)
      ? state.files.organizedPathIndex.length
      : 0;
    const currentSmartFoldersCount = state.files.smartFolders.length;
    const hasDurableData =
      currentOrganizedFilesCount > 0 ||
      currentOrganizedPathIndexCount > 0 ||
      currentSmartFoldersCount > 0;

    // This prevents persisting empty/default state when user hasn't done anything yet.
    // Exception: always persist graphTourDismissed so "Don't show again" survives sessions.
    const isGraphTourDismiss = action.type === 'ui/setGraphTourDismissed';
    const isGraphInsightsSection = action.type === 'ui/setGraphInsightsSection';
    const isGraphLegendHintDismiss = action.type === 'ui/setGraphLegendHintDismissed';
    const isGraphInsightsDockCollapsed = action.type === 'ui/setGraphInsightsDockCollapsed';
    // The first-run view-mode choice is dispatched on Welcome before any
    // durable data exists. Without this exception it would be dropped here and
    // the chosen surface wouldn't survive a reload.
    const isSetViewMode = action.type === 'ui/setViewMode';
    // Theme can be chosen on Welcome before any durable data exists; persist it
    // there too so the selection survives a reload (same rationale as viewMode).
    const isSetSelectedTheme = action.type === 'ui/setSelectedTheme';
    if (
      isWelcomePhase &&
      !hasDurableData &&
      !isGraphTourDismiss &&
      !isGraphInsightsSection &&
      !isGraphLegendHintDismiss &&
      !isGraphInsightsDockCollapsed &&
      !isSetViewMode &&
      !isSetSelectedTheme
    ) {
      return result;
    }

    // Only save if not the spinner-toggle action. Substring match is a
    // foot-gun: any future action whose name happens to contain 'setLoading'
    // (e.g. 'analysis/setLoadingState') would silently be excluded from
    // persistence. Compare the fully-qualified type instead.
    if (action.type !== 'ui/setLoading') {
      const changes = detectUnsavedChanges(state);

      if (!changes.other && !changes.analysisChurn) {
        return result;
      }

      const now = Date.now();
      // Track when the first pending request was made (reset after each save)
      if (firstPendingRequestTime === 0) {
        firstPendingRequestTime = now;
      }
      const shouldForceImmediate =
        firstPendingRequestTime > 0 && now - firstPendingRequestTime > MAX_DEBOUNCE_WAIT_MS;
      // Honor the live `saveDebounceMs` setting instead of the compile-time
      // default so a Settings change takes effect immediately. Clamp to the
      // same bounds enforced by VALIDATION_RULES (100..5000ms); fall back to the
      // packaged default for missing/out-of-range values.
      const configuredDebounce = Number(state?.ui?.settings?.saveDebounceMs);
      const effectiveDebounce =
        Number.isFinite(configuredDebounce) &&
        configuredDebounce >= 100 &&
        configuredDebounce <= 5000
          ? configuredDebounce
          : SAVE_DEBOUNCE_MS;

      const runSave = () => {
        // The timer that called this has fired; forget its id so "a save is
        // pending" checks (the analysis-run lane, cleanupPersistence) stay true.
        saveTimeout = null;
        // Double-check: another timeout may have set this flag if clearTimeout raced
        if (isSaving) return;
        isSaving = true;
        let saveSucceeded = false;

        try {
          // The debounce delay (up to 5s) means the state captured at dispatch time
          // may be significantly outdated by the time this callback fires.
          const freshState = store.getState();

          // Naming: there is one default naming convention, the persisted
          // settings keys (namingConvention, dateFormat, caseConvention,
          // separator). Settings saves it with the other settings, Discover's
          // naming dialog through uiSlice.saveNamingDefaults; watchers,
          // Reanalyze and Discover all read it (Discover via
          // selectNamingDefaults). The files.namingConvention saved in this
          // snapshot is only a renderer mirror, used until settings load;
          // this middleware never writes naming to settings.

          const stateToSave = buildStateSnapshot(freshState, { prioritizeFileStates: true });

          // Detect (once per session) that the hard queue cap actually
          // discarded items from one of the persisted lists. Quota-driven
          // truncation already notifies via saveResult.degraded; this catches
          // the orthogonal case where state fits comfortably in storage but
          // the snapshot builder still tail-trimmed it for safety.
          if (!hasNotifiedHardCap) {
            const selectedDropped =
              freshState.files.selectedFiles.length > stateToSave.files.selectedFiles.length;
            const resultsDropped =
              freshState.analysis.results.length > stateToSave.analysis.results.length;
            if (selectedDropped || resultsDropped) {
              hasNotifiedHardCap = true;
              store.dispatch(
                addNotification({
                  message: `More than ${MAX_PERSISTED_QUEUE_FILES} files are in this session. If you close StratoSort, only the ${MAX_PERSISTED_QUEUE_FILES} added most recently come back when you open it again.`,
                  severity: 'warning',
                  duration: 8000
                })
              );
            }
          }

          const saveResult = saveWithQuotaHandling('stratosort_redux_state', stateToSave);

          if (saveResult.degraded) {
            const messages = {
              reduced:
                'Storage space limited - some file history may not be preserved between sessions.',
              minimal:
                'Storage space very limited - only settings and current phase will be preserved.',
              emergency: 'Storage space critically low - cleared old data to continue.',
              failed: 'Unable to save any data - changes will be lost when you close the app.'
            };
            const severity = saveResult.degraded === 'failed' ? 'error' : 'warning';
            store.dispatch(
              addNotification({
                message: /** @type {Record<string, string>} */ (messages)[saveResult.degraded],
                severity,
                duration: saveResult.degraded === 'failed' ? 0 : 8000 // 0 = persistent
              })
            );
          }

          // This prevents state staleness where we think we saved but actually failed
          if (saveResult.success) {
            saveSucceeded = true;
            // First HEALTHY (non-degraded) save = the live blob is now a
            // full snapshot and authoritative, so it's safe to drop the
            // migration backup (deferred from loadState to survive an early
            // reload). DEGRADED saves (reduced/minimal/emergency) are still
            // saves but the live blob is incomplete — wiping the migration
            // backup at that point would leave the user with no fallback if
            // they then reload. Best-effort clear; failure is harmless.
            if (!migrationBackupCleared && !saveResult.degraded) {
              try {
                clearSerializedStateBackup(localStorage);
                migrationBackupCleared = true;
              } catch {
                // ignore — backup will get cleared on next save attempt
              }
            }
            lastSavedPhase = freshState.ui.currentPhase;
            lastSavedSidebarOpen = freshState.ui.sidebarOpen;
            lastSavedGraphTourDismissed = freshState.ui.graphTourDismissed;
            lastSavedGraphInsightsSection = freshState.ui.graphInsightsSection;
            lastSavedGraphLegendHintDismissed = freshState.ui.graphLegendHintDismissed;
            lastSavedGraphInsightsDockCollapsed = freshState.ui.graphInsightsDockCollapsed;
            lastSavedViewMode = freshState.ui.viewMode;
            lastSavedSelectedTheme = freshState.ui.selectedTheme;
            lastSavedSettingsRef = freshState.ui.settings;
            lastSavedSelectedFilesRef = freshState.files.selectedFiles;
            lastSavedOrganizedFilesRef = freshState.files.organizedFiles;
            lastSavedOrganizedPathIndexRef = freshState.files.organizedPathIndex;
            lastSavedSmartFoldersRef = freshState.files.smartFolders;
            lastSavedFileStatesRef = freshState.files.fileStates;
            lastSavedNamingConventionRef = freshState.files.namingConvention;
            lastSavedLastOrganizeRunRef = stateToSave.files.lastOrganizeRun;
            lastSavedLastOrganizeRunFilesRef = runFilesForNextLaunch(freshState);
            lastSavedResultsRef = freshState.analysis.results;
          }
        } finally {
          isSaving = false;
          // Always reset so failed saves don't cause a hot loop of
          // immediate (delay=0) retry attempts on every Redux action.
          firstPendingRequestTime = 0;
          // Actions dispatched while this save ran were skipped by the
          // isSaving gate, so a persisted-slice change landing in that window
          // would be stranded until the next unrelated action. After a
          // SUCCESSFUL save the lastSaved refs match the captured snapshot;
          // compare them against the live state and schedule one debounced
          // follow-up when they differ. Gating on success keeps the original
          // no-retry behavior for failed saves (no hot loop).
          if (saveSucceeded) {
            const liveState = store.getState();
            const liveChanges = detectUnsavedChanges(liveState);
            if (liveChanges.other || liveChanges.analysisChurn) {
              // Restore the invariant `saveTimeout != null ⇒
              // firstPendingRequestTime > 0` that cleanupPersistence relies
              // on for its forced unload flush — otherwise a window close
              // while this follow-up is pending silently drops exactly the
              // changes the follow-up exists to protect.
              firstPendingRequestTime = Date.now();
              saveTimeout = setTimeout(
                runSave,
                isAnalysisRunChurnOnly(liveState, liveChanges)
                  ? ANALYSIS_RUN_SAVE_INTERVAL_MS
                  : effectiveDebounce
              );
            }
          }
        }
      };

      if (isAnalysisRunChurnOnly(state, changes)) {
        // Mid-run churn: leave any pending save alone (a pending one is due
        // no later than this would be) and otherwise save at most once per
        // ANALYSIS_RUN_SAVE_INTERVAL_MS. Not debounced, so a steady stream of
        // finished files cannot push the save back forever. The action that
        // ends the run sees the unsaved results with isAnalyzing false and
        // takes the normal path below, which saves within the 5 s ceiling.
        if (!saveTimeout) {
          saveTimeout = setTimeout(
            runSave,
            Math.max(0, firstPendingRequestTime + ANALYSIS_RUN_SAVE_INTERVAL_MS - now)
          );
        }
        return result;
      }

      if (saveTimeout) {
        clearTimeout(saveTimeout);
      }

      if (shouldForceImmediate) {
        // The 5s max-wait ceiling has been exceeded. Run the save synchronously
        // rather than scheduling a clearable 0ms timer: under a sustained
        // back-to-back synchronous dispatch burst every new action's
        // `clearTimeout` would cancel the 0ms timer before its macrotask could
        // run, so the "forced" save would never fire and the ceiling would be
        // starved (risking a lost final save on a crash mid-burst). Re-entrant
        // `addNotification` dispatches inside runSave are guarded by the
        // top-level `isSaving` check, and errors are isolated so a failed save
        // never breaks the originating dispatch (mirrors cleanupPersistence's
        // forced flush). runSave's finally re-arms `saveTimeout` if a follow-up
        // is needed, so clearing it here keeps the
        // `saveTimeout != null ⇒ firstPendingRequestTime > 0` invariant intact.
        saveTimeout = null;
        try {
          runSave();
        } catch (err) {
          logger.error('Forced immediate persistence save failed:', { error: err?.message });
        }
      } else {
        saveTimeout = setTimeout(runSave, effectiveDebounce);
      }
    }

    return result;
  };
};

/**
 * Cancel any in-flight debounced save and forget what was last persisted,
 * WITHOUT flushing and WITHOUT detaching the beforeunload handler.
 *
 * Used by "Start over": the workflow reset clears the persisted blob from
 * localStorage, but a save scheduled by earlier durable work may still be
 * pending in the debounce window. If that writer fired after the removeItem it
 * would re-persist the just-cleared state. Cancelling here drops that writer.
 *
 * This deliberately differs from cleanupPersistence: the window stays open
 * after Start over, so the unload-flush handler must remain registered and we
 * must not force a final save (that is what we are trying to avoid).
 */
export const cancelPendingPersistence = () => {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  lastSavedPhase = null;
  lastSavedSidebarOpen = null;
  lastSavedGraphTourDismissed = null;
  lastSavedGraphInsightsSection = null;
  lastSavedGraphLegendHintDismissed = null;
  lastSavedGraphInsightsDockCollapsed = null;
  lastSavedViewMode = null;
  lastSavedSelectedTheme = null;
  lastSavedSettingsRef = null;
  lastSavedSelectedFilesRef = null;
  lastSavedOrganizedFilesRef = null;
  lastSavedOrganizedPathIndexRef = null;
  lastSavedSmartFoldersRef = null;
  lastSavedResultsRef = null;
  lastSavedFileStatesRef = null;
  lastSavedNamingConventionRef = null;
  lastSavedLastOrganizeRunRef = null;
  lastSavedLastOrganizeRunFilesRef = null;
  firstPendingRequestTime = 0;
  hasNotifiedHardCap = false;
};

/**
 * Cleanup function for HMR and app shutdown.
 * Forces a final synchronous save if a debounced save was pending,
 * then resets all tracking state.
 * @param {Object} [store] - Redux store instance for final save (optional)
 */
export const cleanupPersistence = (/** @type {any} */ store) => {
  // Remove beforeunload handler to prevent accumulation during HMR
  if (persistenceUnloadHandler && typeof window !== 'undefined') {
    window.removeEventListener('beforeunload', persistenceUnloadHandler);
    persistenceUnloadHandler = null;
  }

  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;

    // Force a final save if store is provided and there's pending data
    if (store && firstPendingRequestTime > 0) {
      try {
        const freshState = store.getState();
        // Use shared builder with simple file-state slicing (no priority sort
        // needed at shutdown — speed is more important here).
        const stateToSave = buildStateSnapshot(freshState, { prioritizeFileStates: false });
        saveWithQuotaHandling('stratosort_redux_state', stateToSave);
      } catch (err) {
        logger.error('Failed to save state during cleanup:', { error: err?.message });
      }
    }
  }
  lastSavedPhase = null;
  lastSavedSidebarOpen = null;
  lastSavedGraphTourDismissed = null;
  lastSavedGraphInsightsSection = null;
  lastSavedGraphLegendHintDismissed = null;
  lastSavedGraphInsightsDockCollapsed = null;
  lastSavedViewMode = null;
  lastSavedSelectedTheme = null;
  lastSavedSettingsRef = null;
  lastSavedSelectedFilesRef = null;
  lastSavedOrganizedFilesRef = null;
  lastSavedOrganizedPathIndexRef = null;
  lastSavedSmartFoldersRef = null;
  lastSavedResultsRef = null;
  lastSavedFileStatesRef = null;
  lastSavedNamingConventionRef = null;
  lastSavedLastOrganizeRunRef = null;
  lastSavedLastOrganizeRunFilesRef = null;
  firstPendingRequestTime = 0;
  hasNotifiedHardCap = false;
};

export { buildStateSnapshot };
export default persistenceMiddleware;
