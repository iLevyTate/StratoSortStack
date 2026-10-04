// @ts-check
import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { PHASES, PHASE_TRANSITIONS, PHASE_ORDER } from '../../../shared/constants';
import { logger } from '../../../shared/logger';
import { serializeData } from '../../utils/serialization';
import { settingsIpc } from '../../services/ipc';
import { BOOTSTRAP_IPC_OPTIONS, runIpcWithTimeoutRetry } from '../ipcTimeout';

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

// Disabled-tab tooltips. Keys are the *blocked target* phase the user is
// trying to reach; the message describes the prerequisite step they're
// missing. Surfaced on `aria-disabled` tabs in NavigationBar so users learn
// why a tab is unavailable instead of bouncing off it silently.
//
// Returns null when the transition is permitted (caller falls back to its
// usual descriptive tooltip).
const TRANSITION_BLOCK_REASONS = {
  [PHASES.SETUP]: 'Open Setup from the Welcome step.',
  [PHASES.DISCOVER]: 'Add files in Discover to get started.',
  [PHASES.ORGANIZE]: 'Analyze a file in Discover first.',
  [PHASES.COMPLETE]: 'Organize at least one file to see results.'
};

function getTransitionBlockReason(/** @type {any} */ fromPhase, /** @type {any} */ toPhase) {
  if (canTransitionTo(fromPhase, toPhase)) return null;
  return TRANSITION_BLOCK_REASONS[toPhase] || null;
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
        // Discover requires files to be analyzed (or total failure acknowledged)
        return context.hasAnalyzedFiles || context.totalAnalysisFailure;
      case PHASES?.ORGANIZE ?? 'organize':
        // Organize requires at least one processed file to view results
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

      // Validate that the transition is allowed by the central transition graph.
      if (state.currentPhase !== newPhase && !canTransitionTo(state.currentPhase, newPhase)) {
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

// Export navigation rules for use in components
export { NAVIGATION_RULES, isValidPhase, canTransitionTo, getTransitionBlockReason };

export default uiSlice.reducer;
