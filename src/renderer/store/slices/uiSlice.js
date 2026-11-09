// @ts-check
import { createSlice, createAsyncThunk, createSelector } from '@reduxjs/toolkit';
import { PHASES, PHASE_TRANSITIONS, PHASE_ORDER } from '../../../shared/constants';
import { logger } from '../../../shared/logger';
import { serializeData } from '../../utils/serialization';
import { settingsIpc } from '../../services/ipc';
import { BOOTSTRAP_IPC_OPTIONS, runIpcWithTimeoutRetry } from '../ipcTimeout';
import { normalizeNamingConventionState } from '../../../shared/namingConventions';

// PHASE_ORDER is imported from constants
const VALID_PHASES = PHASE_ORDER || ['welcome', 'setup', 'discover', 'organize', 'complete'];

function isValidPhase(/** @type {any} */ phase) {
  return phase != null && typeof phase === 'string' && VALID_PHASES.includes(phase);
}

function canTransitionTo(/** @type {any} */ fromPhase, /** @type {any} */ toPhase) {
  if (!isValidPhase(fromPhase) || !isValidPhase(toPhase)) {
    return false;
  }

  if (fromPhase === toPhase) return true;

  const allowedTransitions = PHASE_TRANSITIONS[fromPhase];
  if (Array.isArray(allowedTransitions)) {
    return allowedTransitions.includes(toPhase);
  }
  return allowedTransitions === toPhase;
}

/**
 * True when `toPhase` comes before `fromPhase` in PHASE_ORDER. Going back to
 * an earlier step is always allowed: nothing a later step does is lost by
 * looking at an earlier one, and the graph alone left Organize and Complete
 * with no way back to Setup.
 * @param {any} fromPhase
 * @param {any} toPhase
 */
function isBackwardMove(fromPhase, toPhase) {
  if (!isValidPhase(fromPhase) || !isValidPhase(toPhase)) return false;
  return VALID_PHASES.indexOf(toPhase) < VALID_PHASES.indexOf(fromPhase);
}

/**
 * The moves `setPhase` accepts: the transition graph plus any step back.
 * @param {any} fromPhase
 * @param {any} toPhase
 */
function canReachPhase(fromPhase, toPhase) {
  return canTransitionTo(fromPhase, toPhase) || isBackwardMove(fromPhase, toPhase);
}

// Why a forward step the graph does not offer is closed. Keys are the
// *blocked target* phase. Setup and Discover never appear: Setup opens from
// Welcome and Discover from Welcome or Setup, and every other route to them
// is a step back.
const TRANSITION_BLOCK_REASONS = {
  [PHASES.ORGANIZE]: 'Organize opens from Discover. Go to Discover first.',
  [PHASES.COMPLETE]: 'Complete opens from Organize. Go to Organize first.'
};

/**
 * Reason a move `setPhase` would refuse, or null when it is accepted. Does not
 * look at files or folders; `getPhaseNavigation` adds those.
 * @param {any} fromPhase
 * @param {any} toPhase
 */
function getTransitionBlockReason(fromPhase, toPhase) {
  if (canReachPhase(fromPhase, toPhase)) return null;
  return /** @type {Record<string, string>} */ (TRANSITION_BLOCK_REASONS)[toPhase] || null;
}

// Why a phase's own Continue button is disabled. Each text is the one that
// button (or, for Welcome, its notice) shows, so a closed phase tab and the
// in-phase button never give two different reasons. Steps are named by their
// tab labels (PHASE_METADATA navLabel).
const PHASE_PREREQUISITE_REASONS = {
  needsDestination: 'Add at least one smart folder first so files have somewhere to go.',
  needsSmartFolder: 'Add at least one destination to continue.',
  needsAnalyzedFile: 'Analyze at least one file first.',
  allAnalysisFailed: 'All files failed analysis. Retry them, or clear the queue and try again.',
  needsProcessedFile: 'Organize at least one file to open Complete.'
};

/**
 * @typedef {object} PhaseNavigationContext
 * @property {boolean} [hasDestinationFolder] a smart folder other than Uncategorized exists (Welcome's rule)
 * @property {boolean} [hasSmartFolders] any smart folder exists (Setup's Continue rule)
 * @property {boolean} [hasAnalyzedFiles] at least one file in the queue is analyzed (Discover's Continue rule)
 * @property {boolean} [hasFailedFiles] at least one file in the queue failed analysis
 * @property {boolean} [hasProcessedFiles] the organized history is not empty (Organize's View
 *   results rule; it also opens Organize from Discover, so a returning user whose queue was
 *   cleared can still reach Organize and Complete)
 */

/**
 * The one rule for moving between phases, shared by the phase tabs and the
 * in-phase buttons:
 * - staying put or going back is always allowed;
 * - going forward follows the transition graph, and the step being left must
 *   pass the same check as its own Continue button (NAVIGATION_RULES.canGoNext;
 *   Welcome, which has no Continue, requires a destination folder like its
 *   "Organize files now" button).
 * Operations in flight (analysis, file moves) are not checked here; the
 * navigation bar pauses every tab for those.
 *
 * @param {any} fromPhase
 * @param {any} toPhase
 * @param {PhaseNavigationContext} [context]
 * @returns {{ allowed: boolean, reason: string | null }}
 */
function getPhaseNavigation(fromPhase, toPhase, context = {}) {
  if (!isValidPhase(fromPhase) || !isValidPhase(toPhase)) {
    return { allowed: false, reason: null };
  }
  if (fromPhase === toPhase || isBackwardMove(fromPhase, toPhase)) {
    return { allowed: true, reason: null };
  }
  if (!canTransitionTo(fromPhase, toPhase)) {
    return { allowed: false, reason: getTransitionBlockReason(fromPhase, toPhase) };
  }
  if (fromPhase === (PHASES?.WELCOME ?? 'welcome')) {
    if (toPhase === (PHASES?.DISCOVER ?? 'discover') && context.hasDestinationFolder !== true) {
      return { allowed: false, reason: PHASE_PREREQUISITE_REASONS.needsDestination };
    }
    return { allowed: true, reason: null };
  }
  if (NAVIGATION_RULES.canGoNext({ currentPhase: fromPhase }, context)) {
    return { allowed: true, reason: null };
  }
  switch (fromPhase) {
    case PHASES?.SETUP ?? 'setup':
      return { allowed: false, reason: PHASE_PREREQUISITE_REASONS.needsSmartFolder };
    case PHASES?.DISCOVER ?? 'discover':
      return {
        allowed: false,
        reason: context.hasFailedFiles
          ? PHASE_PREREQUISITE_REASONS.allAnalysisFailed
          : PHASE_PREREQUISITE_REASONS.needsAnalyzedFile
      };
    case PHASES?.ORGANIZE ?? 'organize':
      return { allowed: false, reason: PHASE_PREREQUISITE_REASONS.needsProcessedFile };
    default:
      return { allowed: false, reason: null };
  }
}

// Navigation state rules - determines when navigation buttons should be disabled
// This centralizes the logic to prevent inconsistencies across components
const NAVIGATION_RULES = {
  // Rules for when "Back" button should be disabled
  // context.isAnalyzing must be passed from analysisSlice.isAnalyzing
  canGoBack: (/** @type {any} */ state, /** @type {any} */ context = {}) => {
    // Cannot go back from welcome phase
    if (state.currentPhase === (PHASES?.WELCOME ?? 'welcome')) return false;
    // Cannot go back while loading/processing
    if (state.isLoading) return false;
    // Cannot go back during file operations
    if (state.isOrganizing || context.isAnalyzing) return false;
    return true;
  },
  // Rules for when "Next/Continue" button should be disabled
  canGoNext: (/** @type {any} */ state, /** @type {any} */ context = {}) => {
    // Cannot advance while loading
    if (state.isLoading) return false;
    // Cannot advance during file operations
    if (state.isOrganizing || context.isAnalyzing) return false;

    // Phase-specific rules
    switch (state.currentPhase) {
      case PHASES?.SETUP ?? 'setup':
        // Setup requires at least one smart folder (context provides this)
        return context.hasSmartFolders === true;
      case PHASES?.DISCOVER ?? 'discover':
        // Discover requires at least one analyzed file. A total analysis
        // failure does not unlock it: Organize lists only analyzed files, so
        // there would be nothing to organize (matches DiscoverPhase's footer).
        // Organized history opens it too: after the 24h state expiry the
        // queue is empty but the history (and Complete beyond Organize) is
        // still there to look at.
        return Boolean(context.hasAnalyzedFiles) || context.hasProcessedFiles === true;
      case PHASES?.ORGANIZE ?? 'organize':
        // Organize requires organized history to open Complete (View results)
        return context.hasProcessedFiles;
      case PHASES?.COMPLETE ?? 'complete':
        // Complete phase can always start a new session
        return true;
      default:
        return true;
    }
  },
  // Get allowed transitions from current phase
  getAllowedTransitions: (/** @type {any} */ fromPhase) => {
    if (!isValidPhase(fromPhase)) return [];
    return PHASE_TRANSITIONS[fromPhase] || [];
  }
};

// Thunk to fetch settings (only once, then cached)
export const fetchSettings = createAsyncThunk(
  'ui/fetchSettings',
  async (/** @type {boolean | undefined} */ arg, { getState, rejectWithValue }) => {
    const forceRefresh = arg === true;
    const { ui } = /** @type {any} */ (getState());
    // Return cached value only after a successful fetch.
    if (!forceRefresh && ui.settingsLoaded) {
      return ui.settings || {};
    }
    try {
      // Same cold-start budget as smart-folders: main may still be wiring
      // SettingsService (or the host is paging) when the renderer mounts.
      const settings = await runIpcWithTimeoutRetry(() => settingsIpc.get(), BOOTSTRAP_IPC_OPTIONS);
      return settings || {};
    } catch (error) {
      logger.error('[uiSlice] Failed to fetch settings', { error: error?.message });
      return rejectWithValue(error?.message || 'Failed to load settings');
    }
  }
);

const VALID_VIEW_MODES = ['phased', 'dashboard'];

/** Selectable color palettes. "primary" is the default dark-navy profile. */
export const VALID_THEMES = ['primary', 'light', 'dark'];

/** @type {any} */
const initialState = {
  currentPhase: PHASES?.WELCOME ?? 'welcome',
  previousPhase: null, // Track previous phase for back navigation
  // Which top-level surface the user sees: the guided 'phased' wizard (default)
  // or the concise 'dashboard' overview. Renderer-only presentation preference,
  // persisted in localStorage (no backend consumer).
  viewMode: 'phased',
  // Selected color palette ('primary' | 'light' | 'dark'). Renderer-only visual
  // preference, persisted in localStorage and applied as a data-theme attribute
  // on <html> (see App.js). No backend consumer.
  selectedTheme: 'primary',
  // True when the user reached the phased flow by deep-linking out of the
  // dashboard (a Quick Action tile, a smart-folder card, etc.). Drives a
  // contextual "Back to dashboard" affordance in the nav so the dashboard
  // behaves like a home base you return to — not a mode you're ejected from.
  // Survives phase-tab navigation; cleared only by an explicit surface switch
  // (setViewMode). Session-only, intentionally not persisted.
  cameFromDashboard: false,
  sidebarOpen: true,
  showSettings: false,
  /** When opening Settings, optional element `id` to scroll into view (e.g. experience level). */
  settingsScrollTargetId: null,
  /** Deep-link from notification click → scroll/select a file in Organize. */
  organizeFocusRequest: null,
  isLoading: false,
  loadingMessage: '',
  settings: null, // Cached settings from main process
  settingsLoaded: false,
  settingsLoading: false,
  settingsError: null,
  // Navigation state tracking for consistent button states
  isOrganizing: false, // True during file organization operations
  isDiscovering: false, // True during file discovery/scanning operations
  isProcessing: false, // Generic processing state for any background operation
  navigationError: null, // Last navigation error for debugging
  lastOperationError: null, // { operation: string, message: string, timestamp: number }
  resetCounter: 0, // Incremented on reset to invalidate selector caches
  graphTourDismissed: false, // Persisted so "Don't show again" survives sessions
  /** Which Knowledge OS graph sidebar accordion is open, or null if all collapsed */
  graphInsightsSection: 'insights',
  /**
   * Persisted dismissal flag for the one-time "Reading this graph" hint that
   * appears under the right-panel legend. Kept as a standalone boolean (not
   * an object) so future flags can join it without re-versioning a nested
   * shape.
   */
  graphLegendHintDismissed: false,
  /**
   * Persisted collapse state for the always-on InsightDock strip above the
   * graph canvas. Defaults to expanded so the most useful insights stay
   * easy to find; users can hide the strip to reclaim vertical space.
   */
  graphInsightsDockCollapsed: false
};

/** Valid accordion keys for the Knowledge OS graph sidebar (single-open). */
export const GRAPH_INSIGHTS_SECTION_KEYS = [
  'insights',
  'addToGraph',
  'explore',
  'actions',
  'filters',
  'advanced'
];
const ALLOWED_GRAPH_INSIGHTS_SECTIONS = new Set(GRAPH_INSIGHTS_SECTION_KEYS);

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    setPhase: (state, action) => {
      const newPhase = action.payload;

      // Clear any previous navigation error
      state.navigationError = null;

      // Validate that the new phase is a valid phase value
      if (!isValidPhase(newPhase)) {
        const error = `Invalid phase attempted: ${String(newPhase)}`;
        logger.error(`[uiSlice] ${error}`, {
          phase: newPhase,
          validPhases: VALID_PHASES
        });
        state.navigationError = error;
        // Reset to safe state instead of corrupting the store
        state.currentPhase = PHASES?.WELCOME ?? 'welcome';
        state.previousPhase = null;
        return;
      }

      const currentPhaseValid = isValidPhase(state.currentPhase);
      if (!currentPhaseValid) {
        logger.warn('[uiSlice] Recovering from invalid current phase during setPhase', {
          currentPhase: state.currentPhase,
          nextPhase: newPhase
        });
        state.previousPhase = null;
        state.currentPhase = newPhase;
        return;
      }

      // Validate the move: the central transition graph, plus any step back.
      if (state.currentPhase !== newPhase && !canReachPhase(state.currentPhase, newPhase)) {
        const warning = `Invalid phase transition: ${state.currentPhase} -> ${newPhase}`;
        logger.warn(`[uiSlice] ${warning}`, {
          from: state.currentPhase,
          to: newPhase,
          allowedTransitions: PHASE_TRANSITIONS[state.currentPhase] || []
        });
        state.navigationError = warning;
        return;
      }

      // Track previous phase for back navigation and clear stale operation flags
      if (state.currentPhase !== newPhase) {
        state.previousPhase = state.currentPhase;
        // Clear operation flags to prevent stuck UI after phase transitions
        // (e.g., setPhase('complete') fires before finally{} clears isOrganizing).
        // NAVIGATION_RULES.canGoBack/canGoNext also gate on isLoading, so a
        // stuck isLoading from a prior phase wedged navigation. Same for
        // lastOperationError surfacing stale errors after a successful
        // transition. Sweep the full set so the new rules don't leave
        // either flag dangling.
        state.isOrganizing = false;
        state.isDiscovering = false;
        state.isProcessing = false;
        state.isLoading = false;
        state.loadingMessage = '';
        state.lastOperationError = null;
      }

      state.currentPhase = newPhase;
    },

    // Set operation states that affect navigation
    setOrganizing: (state, action) => {
      state.isOrganizing = Boolean(action.payload);
    },
    toggleSidebar: (state) => {
      state.sidebarOpen = !state.sidebarOpen;
    },
    toggleSettings: (state) => {
      state.showSettings = !state.showSettings;
      if (!state.showSettings) {
        state.settingsScrollTargetId = null;
      }
    },
    openSettings: (state, action) => {
      state.showSettings = true;
      const id = action?.payload?.scrollToId;
      state.settingsScrollTargetId = typeof id === 'string' && id.length > 0 ? id : null;
    },
    closeSettings: (state) => {
      state.showSettings = false;
      state.settingsScrollTargetId = null;
    },
    clearSettingsScrollTarget: (state) => {
      state.settingsScrollTargetId = null;
    },
    navigateToOrganizeFromNotification: (state, action) => {
      const payload = action.payload || {};
      const filePath = typeof payload.filePath === 'string' ? payload.filePath : null;
      const fileName = typeof payload.fileName === 'string' ? payload.fileName : null;
      // Deep-linking out of the dashboard keeps the "Back to dashboard"
      // affordance, same as DashboardView.goToPhase.
      if (state.viewMode === 'dashboard') {
        state.cameFromDashboard = true;
      }
      state.viewMode = 'phased';
      state.organizeFocusRequest = {
        filePath,
        fileName,
        openDetails: payload.openDetails !== false,
        requestedAt: Date.now()
      };
      state.navigationError = null;
      if (state.currentPhase !== (PHASES?.ORGANIZE ?? 'organize')) {
        state.previousPhase = state.currentPhase;
        state.currentPhase = PHASES?.ORGANIZE ?? 'organize';
      }
    },
    clearOrganizeFocus: (state) => {
      state.organizeFocusRequest = null;
    },
    setLoading: (state, action) => {
      if (typeof action.payload === 'boolean') {
        state.isLoading = action.payload;
        state.loadingMessage = '';
      } else {
        state.isLoading = action.payload.isLoading;
        state.loadingMessage = action.payload.message || '';
      }
    },
    resetUi: (state) => {
      const nextResetCounter = (state?.resetCounter || 0) + 1;
      return {
        ...initialState,
        resetCounter: nextResetCounter,
        // Preserve the chosen surface across "Start over" / error resets so a
        // dashboard user isn't silently dropped back into the phased wizard.
        viewMode: state.viewMode,
        graphTourDismissed: state.graphTourDismissed, // Preserve user preference across sessions
        graphInsightsSection: state.graphInsightsSection,
        graphLegendHintDismissed: state.graphLegendHintDismissed,
        // Durable preferences that are persisted and rehydrated across the TTL
        // (see persistenceMiddleware + store/index.js). Without carrying them
        // forward, "Start over"/error recovery snaps the theme back to
        // 'primary' live (App.js re-applies selectedTheme to the DOM) and
        // re-expands the InsightDock, and the next persistence flush then
        // writes the reverted value to disk — losing the preference for good.
        selectedTheme: state?.selectedTheme ?? initialState.selectedTheme,
        graphInsightsDockCollapsed:
          state?.graphInsightsDockCollapsed ?? initialState.graphInsightsDockCollapsed,
        settingsScrollTargetId: null,
        organizeFocusRequest: null,
        // Preserve `previousPhase` across reset. The persistence layer
        // started persisting `ui.previousPhase` so reloads restore the
        // back-nav target — but a reset (PhaseErrorBoundary, CompletePhase
        // restart) was wiping it back to `null` from `initialState`. The
        // very next persistence flush then snapshotted that null and the
        // back button silently lost its target. Carry the existing value
        // forward so reset preserves the navigation breadcrumb.
        previousPhase: state?.previousPhase ?? initialState.previousPhase
      };
    },
    updateSettings: (state, action) => {
      state.settings = { ...(state.settings || {}), ...serializeData(action.payload) };
      state.settingsLoaded = true;
      state.settingsError = null;
    },
    // Optimistic write of the naming keys only (saveNamingDefaults). Unlike
    // updateSettings it does not mark settings as loaded: a partial object
    // must never satisfy fetchSettings' cache.
    mergeNamingSettings: (state, action) => {
      const patch = pickNamingSettings(action.payload);
      if (Object.keys(patch).length === 0) return;
      state.settings = { ...(state.settings || {}), ...patch };
    },
    setGraphTourDismissed: (state, action) => {
      state.graphTourDismissed = Boolean(action.payload);
    },
    setGraphInsightsSection: (state, action) => {
      const v = action.payload;
      if (v == null || v === '') {
        state.graphInsightsSection = null;
        return;
      }
      state.graphInsightsSection = ALLOWED_GRAPH_INSIGHTS_SECTIONS.has(v) ? v : 'insights';
    },
    setGraphLegendHintDismissed: (state, action) => {
      state.graphLegendHintDismissed = Boolean(action.payload);
    },
    setGraphInsightsDockCollapsed: (state, action) => {
      state.graphInsightsDockCollapsed = Boolean(action.payload);
    },
    setViewMode: (state, action) => {
      const next = action.payload;
      state.viewMode = VALID_VIEW_MODES.includes(next) ? next : 'phased';
      // Any explicit surface switch resolves a dashboard excursion: returning to
      // the dashboard or committing to the guided flow both end the breadcrumb.
      state.cameFromDashboard = false;
    },
    setCameFromDashboard: (state, action) => {
      state.cameFromDashboard = Boolean(action.payload);
    },
    setSelectedTheme: (state, action) => {
      const next = action.payload;
      state.selectedTheme = VALID_THEMES.includes(next) ? next : 'primary';
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchSettings.pending, (state) => {
        state.settingsLoading = true;
        state.settingsError = null;
      })
      .addCase(fetchSettings.fulfilled, (state, action) => {
        state.settings = action.payload;
        state.settingsLoaded = true;
        state.settingsLoading = false;
        state.settingsError = null;
      })
      .addCase(fetchSettings.rejected, (state, action) => {
        // Only set to empty object if no previous settings exist
        if (!state.settings) {
          state.settings = {};
        }
        state.settingsLoaded = false;
        state.settingsLoading = false;
        state.settingsError = action.payload || action.error?.message || 'Failed to load settings';
      });
  }
});

export const {
  setPhase,
  toggleSidebar,
  toggleSettings,
  openSettings,
  closeSettings,
  clearSettingsScrollTarget,
  navigateToOrganizeFromNotification,
  clearOrganizeFocus,
  setLoading,
  resetUi,
  updateSettings,
  setOrganizing,
  setGraphTourDismissed,
  setGraphInsightsSection,
  setGraphLegendHintDismissed,
  setGraphInsightsDockCollapsed,
  setViewMode,
  setCameFromDashboard,
  setSelectedTheme
} = uiSlice.actions;

// =============================================================================
// Default naming convention: one persisted value
// =============================================================================
//
// Settings -> File naming defaults and Discover's naming dialog edit the same
// thing: the persisted settings keys below (SettingsService, allowlisted in
// securityConfig). Watchers and Reanalyze read them in main; Discover reads
// them through selectNamingDefaults. files.namingConvention is only a renderer
// mirror (localStorage) used until settings arrive and by early startup code.

/** Persisted settings keys that hold the default naming convention. */
export const NAMING_SETTING_KEYS = [
  'namingConvention',
  'dateFormat',
  'caseConvention',
  'separator'
];

/**
 * The naming keys present on a settings-shaped object, string values only.
 * @param {any} source
 * @returns {Record<string, string>}
 */
function pickNamingSettings(source) {
  /** @type {Record<string, string>} */
  const picked = {};
  if (!source || typeof source !== 'object') return picked;
  for (const key of NAMING_SETTING_KEYS) {
    if (typeof source[key] === 'string') picked[key] = source[key];
  }
  return picked;
}

/**
 * Settings-shaped patch from either Discover's shape ({ convention, ... }) or
 * the settings keys ({ namingConvention, ... }).
 * @param {any} patch
 * @returns {Record<string, string>}
 */
function toNamingSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object') return {};
  const settingsShaped =
    typeof patch.convention === 'string' ? { ...patch, namingConvention: patch.convention } : patch;
  return pickNamingSettings(settingsShaped);
}

/**
 * The default naming convention in Discover's shape
 * ({ convention, separator, dateFormat, caseConvention }). Each persisted
 * setting wins over the renderer mirror; the mirror only fills keys settings
 * do not have yet (before the first settings load).
 */
export const selectNamingDefaults = createSelector(
  [
    (/** @type {any} */ state) => state.ui?.settings,
    (/** @type {any} */ state) => state.files?.namingConvention
  ],
  (settings, mirror) => {
    const base = normalizeNamingConventionState(mirror);
    const persisted = pickNamingSettings(settings);
    return normalizeNamingConventionState({
      convention: persisted.namingConvention || base.convention,
      separator: persisted.separator ?? base.separator,
      dateFormat: persisted.dateFormat || base.dateFormat,
      caseConvention: persisted.caseConvention || base.caseConvention
    });
  }
);

/**
 * Change the default naming convention from anywhere in the renderer.
 * Updates the cached settings at once (so Discover and the dashboard follow),
 * then persists through settings:save, which broadcasts the merged settings
 * back. A failed save puts the previous values back, but only on keys that
 * still hold this call's value: a newer change made while this save was in
 * flight is never rolled back.
 */
export const saveNamingDefaults = createAsyncThunk(
  'ui/saveNamingDefaults',
  async (/** @type {any} */ patch, { dispatch, getState, rejectWithValue }) => {
    const settingsPatch = toNamingSettingsPatch(patch);
    if (Object.keys(settingsPatch).length === 0) return settingsPatch;

    const previousAll = toNamingSettingsPatch(selectNamingDefaults(getState()));
    /** @type {Record<string, string>} */
    const previous = {};
    for (const key of Object.keys(settingsPatch)) {
      if (typeof previousAll[key] === 'string') previous[key] = previousAll[key];
    }

    dispatch(uiSlice.actions.mergeNamingSettings(settingsPatch));
    try {
      const result = await settingsIpc.save(settingsPatch);
      if (result && typeof result === 'object' && result.success === false) {
        throw new Error(result.error || 'Settings save failed');
      }
      return settingsPatch;
    } catch (error) {
      const current = /** @type {any} */ (getState()).ui?.settings || {};
      /** @type {Record<string, string>} */
      const rollback = {};
      for (const [key, value] of Object.entries(previous)) {
        if (current[key] === settingsPatch[key]) rollback[key] = value;
      }
      dispatch(uiSlice.actions.mergeNamingSettings(rollback));
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('[uiSlice] Failed to save naming defaults', { error: message });
      return rejectWithValue(message);
    }
  }
);

// Export navigation rules for use in components
export {
  NAVIGATION_RULES,
  PHASE_PREREQUISITE_REASONS,
  isValidPhase,
  canTransitionTo,
  canReachPhase,
  getTransitionBlockReason,
  getPhaseNavigation
};

export default uiSlice.reducer;
