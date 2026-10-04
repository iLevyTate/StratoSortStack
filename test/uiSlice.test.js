/**
 * Tests for UI Slice
 * Tests Redux slice for UI state management
 */

// Mock constants
jest.mock('../src/shared/constants', () => ({
  PHASES: {
    WELCOME: 'welcome',
    SETUP: 'setup',
    DISCOVER: 'discover',
    ORGANIZE: 'organize',
    COMPLETE: 'complete'
  },
  PHASE_TRANSITIONS: {
    welcome: ['setup', 'discover'],
    setup: ['welcome', 'discover'],
    discover: ['welcome', 'setup', 'organize'],
    organize: ['welcome', 'discover', 'complete'],
    complete: ['welcome', 'discover', 'organize']
  },
  PHASE_ORDER: ['welcome', 'setup', 'discover', 'organize', 'complete']
}));

// Mock logger
jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

jest.mock('../src/renderer/services/ipc', () => ({
  settingsIpc: {
    get: jest.fn()
  }
}));

import { configureStore } from '@reduxjs/toolkit';

import uiReducer, {
  setPhase,
  setViewMode,
  setSelectedTheme,
  setCameFromDashboard,
  toggleSidebar,
  toggleSettings,
  setLoading,
  resetUi,
  updateSettings,
  setOrganizing,
  navigateToOrganizeFromNotification,
  fetchSettings,
  NAVIGATION_RULES,
  isValidPhase,
  canTransitionTo
} from '../src/renderer/store/slices/uiSlice';

const { settingsIpc } = require('../src/renderer/services/ipc');

describe('uiSlice', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const initialState = {
    currentPhase: 'welcome',
    previousPhase: null,
    sidebarOpen: true,
    showSettings: false,
    isLoading: false,
    loadingMessage: '',
    activeModal: null,
    settings: null,
    settingsLoaded: false,
    settingsLoading: false,
    settingsError: null,
    isOrganizing: false,
    navigationError: null
  };

  describe('initial state', () => {
    test('returns initial state', () => {
      const result = uiReducer(undefined, { type: 'unknown' });

      expect(result.currentPhase).toBe('welcome');
      expect(result.sidebarOpen).toBe(true);
    });
  });

  describe('setPhase', () => {
    test('sets valid phase', () => {
      const state = { ...initialState, currentPhase: 'welcome' };

      const result = uiReducer(state, setPhase('setup'));

      expect(result.currentPhase).toBe('setup');
      expect(result.previousPhase).toBe('welcome');
    });

    test('rejects invalid phase', () => {
      const state = { ...initialState, currentPhase: 'welcome' };

      const result = uiReducer(state, setPhase('invalid-phase'));

      expect(result.currentPhase).toBe('welcome');
      expect(result.navigationError).toContain('Invalid phase');
    });

    test('rejects null phase', () => {
      const state = { ...initialState, currentPhase: 'setup' };

      const result = uiReducer(state, setPhase(null));

      expect(result.currentPhase).toBe('welcome');
      expect(result.navigationError).toBeDefined();
    });

    test('allows same phase transition', () => {
      const state = { ...initialState, currentPhase: 'setup' };

      const result = uiReducer(state, setPhase('setup'));

      expect(result.currentPhase).toBe('setup');
      expect(result.navigationError).toBeNull();
    });

    test('blocks invalid transition and tracks error', () => {
      const state = { ...initialState, currentPhase: 'welcome' };

      // Direct transition from welcome to organize is not in PHASE_TRANSITIONS
      const result = uiReducer(state, setPhase('organize'));

      expect(result.currentPhase).toBe('welcome');
      expect(result.navigationError).toContain('Invalid phase transition');
    });

    test('recovers from invalid current phase and applies requested valid phase', () => {
      const state = {
        ...initialState,
        currentPhase: 'corrupted-phase',
        previousPhase: 'welcome',
        navigationError: 'stale'
      };

      const result = uiReducer(state, setPhase('setup'));

      expect(result.currentPhase).toBe('setup');
      expect(result.previousPhase).toBeNull();
      expect(result.navigationError).toBeNull();
    });

    test('clears previous navigation error', () => {
      const state = {
        ...initialState,
        currentPhase: 'welcome',
        navigationError: 'previous error'
      };

      const result = uiReducer(state, setPhase('setup'));

      expect(result.navigationError).toBeNull();
    });
  });

  describe('setViewMode', () => {
    test('defaults to phased in initial state', () => {
      const result = uiReducer(undefined, { type: '@@init' });
      expect(result.viewMode).toBe('phased');
    });

    test('accepts the dashboard mode', () => {
      const result = uiReducer(initialState, setViewMode('dashboard'));
      expect(result.viewMode).toBe('dashboard');
    });

    test('accepts switching back to phased', () => {
      const state = { ...initialState, viewMode: 'dashboard' };
      const result = uiReducer(state, setViewMode('phased'));
      expect(result.viewMode).toBe('phased');
    });

    test('falls back to phased for unknown values', () => {
      const state = { ...initialState, viewMode: 'dashboard' };
      expect(uiReducer(state, setViewMode('grid')).viewMode).toBe('phased');
      expect(uiReducer(state, setViewMode(null)).viewMode).toBe('phased');
      expect(uiReducer(state, setViewMode(undefined)).viewMode).toBe('phased');
      expect(uiReducer(state, setViewMode(42)).viewMode).toBe('phased');
    });

    test('clears the cameFromDashboard breadcrumb on any explicit surface switch', () => {
      const state = { ...initialState, viewMode: 'phased', cameFromDashboard: true };

      // Returning to the dashboard ends the excursion...
      expect(uiReducer(state, setViewMode('dashboard')).cameFromDashboard).toBe(false);
      // ...and so does committing to the guided flow.
      expect(uiReducer(state, setViewMode('phased')).cameFromDashboard).toBe(false);
      // Even a rejected value (which falls back to 'phased') resolves the breadcrumb.
      expect(uiReducer(state, setViewMode('grid')).cameFromDashboard).toBe(false);
    });
  });

  describe('setSelectedTheme', () => {
    test('defaults to primary in initial state', () => {
      const result = uiReducer(undefined, { type: '@@init' });
      expect(result.selectedTheme).toBe('primary');
    });

    test('accepts the light and dark palettes', () => {
      expect(uiReducer(initialState, setSelectedTheme('light')).selectedTheme).toBe('light');
      expect(uiReducer(initialState, setSelectedTheme('dark')).selectedTheme).toBe('dark');
    });

    test('accepts switching back to primary', () => {
      const state = { ...initialState, selectedTheme: 'dark' };
      expect(uiReducer(state, setSelectedTheme('primary')).selectedTheme).toBe('primary');
    });

    test('falls back to primary for unknown values', () => {
      const state = { ...initialState, selectedTheme: 'dark' };
      expect(uiReducer(state, setSelectedTheme('solarized')).selectedTheme).toBe('primary');
      expect(uiReducer(state, setSelectedTheme(null)).selectedTheme).toBe('primary');
      expect(uiReducer(state, setSelectedTheme(undefined)).selectedTheme).toBe('primary');
      expect(uiReducer(state, setSelectedTheme(42)).selectedTheme).toBe('primary');
    });
  });

  describe('setCameFromDashboard', () => {
    test('defaults to false in initial state', () => {
      const result = uiReducer(undefined, { type: '@@init' });
      expect(result.cameFromDashboard).toBe(false);
    });

    test('marks and clears the dashboard excursion', () => {
      const marked = uiReducer(initialState, setCameFromDashboard(true));
      expect(marked.cameFromDashboard).toBe(true);

      const cleared = uiReducer(marked, setCameFromDashboard(false));
      expect(cleared.cameFromDashboard).toBe(false);
    });

    test('coerces the payload to a boolean', () => {
      expect(uiReducer(initialState, setCameFromDashboard(1)).cameFromDashboard).toBe(true);
      expect(uiReducer(initialState, setCameFromDashboard('yes')).cameFromDashboard).toBe(true);
      expect(uiReducer(initialState, setCameFromDashboard(0)).cameFromDashboard).toBe(false);
      expect(uiReducer(initialState, setCameFromDashboard(null)).cameFromDashboard).toBe(false);
      expect(uiReducer(initialState, setCameFromDashboard(undefined)).cameFromDashboard).toBe(
        false
      );
    });
  });

  describe('navigateToOrganizeFromNotification', () => {
    test('leaves a dashboard breadcrumb when deep-linking out of dashboard mode', () => {
      // A dashboard user clicking an organize notification must keep the
      // "Back to dashboard" affordance, same as DashboardView.goToPhase.
      const dashboardState = { ...initialState, viewMode: 'dashboard', cameFromDashboard: false };

      const result = uiReducer(
        dashboardState,
        navigateToOrganizeFromNotification({ filePath: 'C:/x/a.pdf', fileName: 'a.pdf' })
      );

      expect(result.viewMode).toBe('phased');
      expect(result.cameFromDashboard).toBe(true);
      expect(result.currentPhase).toBe('organize');
      expect(result.organizeFocusRequest).toMatchObject({
        filePath: 'C:/x/a.pdf',
        fileName: 'a.pdf',
        openDetails: true
      });
    });

    test('does not set the breadcrumb when already in phased mode', () => {
      const phasedState = { ...initialState, viewMode: 'phased', cameFromDashboard: false };

      const result = uiReducer(phasedState, navigateToOrganizeFromNotification({}));

      expect(result.viewMode).toBe('phased');
      expect(result.cameFromDashboard).toBe(false);
      expect(result.currentPhase).toBe('organize');
    });
  });

  describe('setOrganizing', () => {
    test('sets organizing state to true', () => {
      const result = uiReducer(initialState, setOrganizing(true));

      expect(result.isOrganizing).toBe(true);
    });

    test('sets organizing state to false', () => {
      const state = { ...initialState, isOrganizing: true };

      const result = uiReducer(state, setOrganizing(false));

      expect(result.isOrganizing).toBe(false);
    });

    test('coerces truthy values to boolean', () => {
      const result = uiReducer(initialState, setOrganizing('yes'));

      expect(result.isOrganizing).toBe(true);
    });
  });

  describe('toggleSidebar', () => {
    test('toggles sidebar open to closed', () => {
      const result = uiReducer(initialState, toggleSidebar());

      expect(result.sidebarOpen).toBe(false);
    });

    test('toggles sidebar closed to open', () => {
      const state = { ...initialState, sidebarOpen: false };

      const result = uiReducer(state, toggleSidebar());

      expect(result.sidebarOpen).toBe(true);
    });
  });

  describe('toggleSettings', () => {
    test('toggles settings visibility', () => {
      const result = uiReducer(initialState, toggleSettings());

      expect(result.showSettings).toBe(true);
    });
  });

  describe('setLoading', () => {
    test('sets loading with boolean', () => {
      const result = uiReducer(initialState, setLoading(true));

      expect(result.isLoading).toBe(true);
      expect(result.loadingMessage).toBe('');
    });

    test('sets loading with object', () => {
      const result = uiReducer(
        initialState,
        setLoading({ isLoading: true, message: 'Processing...' })
      );

      expect(result.isLoading).toBe(true);
      expect(result.loadingMessage).toBe('Processing...');
    });

    test('clears loading message on false', () => {
      const state = {
        ...initialState,
        isLoading: true,
        loadingMessage: 'Loading...'
      };

      const result = uiReducer(state, setLoading(false));

      expect(result.isLoading).toBe(false);
      expect(result.loadingMessage).toBe('');
    });
  });

  describe('resetUi', () => {
    test('resets to initial state', () => {
      const modifiedState = {
        ...initialState,
        currentPhase: 'organize',
        isLoading: true,
        showSettings: true
      };

      const result = uiReducer(modifiedState, resetUi());

      expect(result.currentPhase).toBe('welcome');
      expect(result.isLoading).toBe(false);
      expect(result.showSettings).toBe(false);
    });

    test('preserves the chosen viewMode across reset', () => {
      const modifiedState = {
        ...initialState,
        currentPhase: 'organize',
        viewMode: 'dashboard'
      };

      const result = uiReducer(modifiedState, resetUi());

      expect(result.currentPhase).toBe('welcome');
      expect(result.viewMode).toBe('dashboard');
    });

    test('preserves durable selectedTheme and graphInsightsDockCollapsed preferences', () => {
      const modifiedState = {
        ...initialState,
        currentPhase: 'organize',
        selectedTheme: 'dark',
        graphInsightsDockCollapsed: true
      };

      const result = uiReducer(modifiedState, resetUi());

      expect(result.currentPhase).toBe('welcome');
      expect(result.selectedTheme).toBe('dark');
      expect(result.graphInsightsDockCollapsed).toBe(true);
    });
  });

  describe('updateSettings', () => {
    test('updates settings', () => {
      const result = uiReducer(initialState, updateSettings({ language: 'en', autoSave: true }));

      expect(result.settings.language).toBe('en');
      expect(result.settings.autoSave).toBe(true);
      expect(result.settingsLoaded).toBe(true);
    });

    test('merges with existing settings', () => {
      const state = {
        ...initialState,
        settings: { language: 'fr', existing: true }
      };

      const result = uiReducer(state, updateSettings({ language: 'en' }));

      expect(result.settings.language).toBe('en');
      expect(result.settings.existing).toBe(true);
      expect(result.settingsLoaded).toBe(true);
    });

    test('handles null settings', () => {
      const state = { ...initialState, settings: null };

      const result = uiReducer(state, updateSettings({ key: 'value' }));

      expect(result.settings.key).toBe('value');
      expect(result.settingsLoaded).toBe(true);
    });
  });

  describe('fetchSettings async thunk', () => {
    test('sets loading state on pending', () => {
      const result = uiReducer(initialState, {
        type: fetchSettings.pending.type
      });

      expect(result.settingsLoading).toBe(true);
    });

    test('sets settings on fulfilled', () => {
      const settings = { language: 'en' };

      const result = uiReducer(initialState, {
        type: fetchSettings.fulfilled.type,
        payload: settings
      });

      expect(result.settings).toEqual(settings);
      expect(result.settingsLoaded).toBe(true);
      expect(result.settingsLoading).toBe(false);
    });

    test('sets empty object on rejected', () => {
      const result = uiReducer(initialState, {
        type: fetchSettings.rejected.type
      });

      expect(result.settings).toEqual({});
      expect(result.settingsLoaded).toBe(false);
      expect(result.settingsLoading).toBe(false);
    });

    test('returns cached settings only after successful load', async () => {
      settingsIpc.get.mockResolvedValue({ language: 'server' });
      const store = configureStore({
        reducer: { ui: uiReducer },
        preloadedState: {
          ui: {
            ...uiReducer(undefined, { type: 'init' }),
            settings: { language: 'cached' },
            settingsLoaded: true
          }
        }
      });

      const action = await store.dispatch(fetchSettings());
      expect(action.payload).toEqual({ language: 'cached' });
      expect(settingsIpc.get).not.toHaveBeenCalled();
    });

    test('retries settings fetch after rejection', async () => {
      settingsIpc.get
        .mockRejectedValueOnce(new Error('temporary'))
        .mockResolvedValueOnce({ theme: 'dark' });

      const store = configureStore({ reducer: { ui: uiReducer } });
      await store.dispatch(fetchSettings());
      expect(store.getState().ui.settingsLoaded).toBe(false);

      await store.dispatch(fetchSettings());
      const state = store.getState().ui;
      expect(state.settings).toEqual({ theme: 'dark' });
      expect(state.settingsLoaded).toBe(true);
      expect(settingsIpc.get).toHaveBeenCalledTimes(2);
    });

    test('fulfilled clears a sticky settingsError from an earlier timeout', () => {
      const rejected = uiReducer(initialState, {
        type: fetchSettings.rejected.type,
        payload: 'IPC timeout'
      });
      expect(rejected.settingsError).toBe('IPC timeout');

      const recovered = uiReducer(rejected, {
        type: fetchSettings.fulfilled.type,
        payload: { theme: 'dark' }
      });
      expect(recovered.settingsError).toBeNull();
      expect(recovered.settingsLoaded).toBe(true);
      expect(recovered.settings).toEqual({ theme: 'dark' });
    });
  });

  describe('NAVIGATION_RULES', () => {
    describe('canGoBack', () => {
      test('returns false for welcome phase', () => {
        expect(NAVIGATION_RULES.canGoBack({ currentPhase: 'welcome' })).toBe(false);
      });

      test('returns false when loading', () => {
        expect(
          NAVIGATION_RULES.canGoBack({
            currentPhase: 'setup',
            isLoading: true
          })
        ).toBe(false);
      });

      test('returns false when organizing', () => {
        expect(
          NAVIGATION_RULES.canGoBack({
            currentPhase: 'organize',
            isOrganizing: true
          })
        ).toBe(false);
      });

      test('returns false when analyzing (via context)', () => {
        expect(
          NAVIGATION_RULES.canGoBack({ currentPhase: 'discover' }, { isAnalyzing: true })
        ).toBe(false);
      });

      test('returns true otherwise', () => {
        expect(
          NAVIGATION_RULES.canGoBack(
            {
              currentPhase: 'setup',
              isLoading: false,
              isOrganizing: false
            },
            { isAnalyzing: false }
          )
        ).toBe(true);
      });
    });

    describe('canGoNext', () => {
      test('returns false when loading', () => {
        expect(NAVIGATION_RULES.canGoNext({ currentPhase: 'setup', isLoading: true })).toBe(false);
      });

      test('checks hasSmartFolders for setup phase', () => {
        expect(
          NAVIGATION_RULES.canGoNext({ currentPhase: 'setup' }, { hasSmartFolders: true })
        ).toBe(true);
        expect(
          NAVIGATION_RULES.canGoNext({ currentPhase: 'setup' }, { hasSmartFolders: false })
        ).toBe(false);
        expect(NAVIGATION_RULES.canGoNext({ currentPhase: 'setup' }, {})).toBe(false);
      });

      test('checks hasAnalyzedFiles for discover phase', () => {
        expect(
          NAVIGATION_RULES.canGoNext({ currentPhase: 'discover' }, { hasAnalyzedFiles: true })
        ).toBe(true);
      });

      test('allows totalAnalysisFailure for discover phase', () => {
        expect(
          NAVIGATION_RULES.canGoNext({ currentPhase: 'discover' }, { totalAnalysisFailure: true })
        ).toBe(true);
      });

      test('checks hasProcessedFiles for organize phase', () => {
        expect(
          NAVIGATION_RULES.canGoNext({ currentPhase: 'organize' }, { hasProcessedFiles: true })
        ).toBe(true);
      });

      test('returns true for complete phase', () => {
        expect(NAVIGATION_RULES.canGoNext({ currentPhase: 'complete' })).toBe(true);
      });
    });

    describe('getAllowedTransitions', () => {
      test('returns allowed transitions for phase', () => {
        expect(NAVIGATION_RULES.getAllowedTransitions('welcome')).toEqual(['setup', 'discover']);
        expect(NAVIGATION_RULES.getAllowedTransitions('setup')).toContain('discover');
      });

      test('returns empty array for invalid phase', () => {
        expect(NAVIGATION_RULES.getAllowedTransitions('invalid')).toEqual([]);
      });
    });
  });

  describe('helper functions', () => {
    describe('isValidPhase', () => {
      test('returns true for valid phases', () => {
        expect(isValidPhase('welcome')).toBe(true);
        expect(isValidPhase('setup')).toBe(true);
        expect(isValidPhase('discover')).toBe(true);
        expect(isValidPhase('organize')).toBe(true);
        expect(isValidPhase('complete')).toBe(true);
      });

      test('returns false for invalid phases', () => {
        expect(isValidPhase('invalid')).toBe(false);
        expect(isValidPhase(null)).toBe(false);
        expect(isValidPhase(undefined)).toBe(false);
        expect(isValidPhase(123)).toBe(false);
      });
    });

    describe('canTransitionTo', () => {
      test('allows valid transitions', () => {
        expect(canTransitionTo('welcome', 'setup')).toBe(true);
        expect(canTransitionTo('welcome', 'discover')).toBe(true);
        expect(canTransitionTo('setup', 'discover')).toBe(true);
        expect(canTransitionTo('complete', 'organize')).toBe(true);
      });

      test('allows same phase transition', () => {
        expect(canTransitionTo('setup', 'setup')).toBe(true);
      });

      test('rejects invalid transitions', () => {
        expect(canTransitionTo('welcome', 'complete')).toBe(false);
      });

      test('rejects invalid phases', () => {
        expect(canTransitionTo('invalid', 'setup')).toBe(false);
        expect(canTransitionTo('welcome', 'invalid')).toBe(false);
      });
    });
  });
});
