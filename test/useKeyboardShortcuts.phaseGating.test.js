/**
 * @jest-environment jsdom
 */
/**
 * Alt+Left / Alt+Right are the keyboard twin of the phase tabs, so they follow
 * the same rule (uiSlice.getPhaseNavigation) with the same inputs the
 * navigation bar reads: back is always open, forward opens only when the step
 * being left would let its own Continue through. A refused move does not
 * navigate and shows the reason the tab's tooltip gives. Uses the real
 * uiSlice rules and selectors; only the store hooks and the chrome are mocked.
 */
import { renderHook } from '@testing-library/react';

const mockDispatch = jest.fn();
let mockState = {};

jest.mock('../src/renderer/store/hooks', () => ({
  useAppDispatch: jest.fn(() => mockDispatch),
  useAppSelector: jest.fn((selector) => selector(mockState))
}));

const mockNotification = { addNotification: jest.fn(), showInfo: jest.fn() };

jest.mock('../src/renderer/contexts/NotificationContext', () => ({
  useNotification: jest.fn(() => mockNotification)
}));

jest.mock('../src/renderer/components/UndoRedoSystem', () => ({
  useUndoRedo: () => ({ undo: jest.fn(), redo: jest.fn(), canUndo: false, canRedo: false })
}));

jest.mock('../src/renderer/utils/overlayStack', () => ({
  isTopOverlay: jest.fn(() => false),
  canHotkeySwapSurface: jest.fn(() => true),
  hasActiveOverlay: jest.fn(() => false)
}));

jest.mock('../src/renderer/store/thunks/liveActivityThunks', () => ({
  toggleShowLiveActivity: jest.fn(() => ({ type: 'test/toggleShowLiveActivity' }))
}));

import { useKeyboardShortcuts } from '../src/renderer/hooks/useKeyboardShortcuts';
import { PHASE_PREREQUISITE_REASONS } from '../src/renderer/store/slices/uiSlice';

const UNCATEGORIZED = { id: 'uncat', name: 'Uncategorized', category: 'uncategorized' };
const INVOICES = { id: 'sf-1', name: 'Invoices' };

function buildState({
  phase = 'welcome',
  smartFolders = [UNCATEGORIZED, INVOICES],
  selectedFiles = [],
  results = [],
  organizedFiles = []
} = {}) {
  return {
    ui: { currentPhase: phase, viewMode: 'phased', showSettings: false },
    files: {
      smartFolders,
      selectedFiles,
      fileStates: {},
      organizedFiles,
      organizedPathIndex: []
    },
    analysis: { isAnalyzing: false, results }
  };
}

function setPhaseDispatches() {
  return mockDispatch.mock.calls
    .map(([action]) => action)
    .filter((action) => action && action.type === 'ui/setPhase')
    .map((action) => action.payload);
}

let keydownHandler = null;

function pressAlt(key) {
  const event = {
    key,
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    target: document.body,
    defaultPrevented: false,
    preventDefault: jest.fn()
  };
  if (keydownHandler) keydownHandler(event);
  return event;
}

describe('Alt+Arrow phase navigation follows the phase-tab rule', () => {
  beforeEach(() => {
    mockDispatch.mockClear();
    mockNotification.addNotification.mockClear();
    mockNotification.showInfo.mockClear();
    keydownHandler = null;
    jest.spyOn(document, 'addEventListener').mockImplementation((event, handler) => {
      if (event === 'keydown') keydownHandler = handler;
    });
    jest.spyOn(document, 'removeEventListener').mockImplementation(() => {});
    window.electronAPI = {};
  });

  afterEach(() => {
    document.addEventListener.mockRestore?.();
    document.removeEventListener.mockRestore?.();
    delete window.electronAPI;
  });

  test('Alt+Right from Setup without a smart folder stays put and says why', () => {
    mockState = buildState({ phase: 'setup', smartFolders: [] });
    renderHook(() => useKeyboardShortcuts());

    const event = pressAlt('ArrowRight');

    expect(event.preventDefault).toHaveBeenCalled();
    expect(setPhaseDispatches()).toEqual([]);
    expect(mockNotification.showInfo).toHaveBeenCalledWith(
      PHASE_PREREQUISITE_REASONS.needsSmartFolder,
      5200
    );
    expect(mockNotification.addNotification).not.toHaveBeenCalled();
  });

  test('Alt+Right from Discover with nothing analyzed stays put and says why', () => {
    mockState = buildState({
      phase: 'discover',
      selectedFiles: [{ path: '/docs/a.pdf', name: 'a.pdf' }]
    });
    renderHook(() => useKeyboardShortcuts());

    pressAlt('ArrowRight');

    expect(setPhaseDispatches()).toEqual([]);
    expect(mockNotification.showInfo).toHaveBeenCalledWith(
      PHASE_PREREQUISITE_REASONS.needsAnalyzedFile,
      5200
    );
  });

  test('Alt+Right from Discover when every file failed gives the failure reason', () => {
    mockState = buildState({
      phase: 'discover',
      selectedFiles: [{ path: '/docs/a.pdf', name: 'a.pdf' }],
      results: [{ path: '/docs/a.pdf', error: 'boom' }]
    });
    renderHook(() => useKeyboardShortcuts());

    pressAlt('ArrowRight');

    expect(setPhaseDispatches()).toEqual([]);
    expect(mockNotification.showInfo).toHaveBeenCalledWith(
      PHASE_PREREQUISITE_REASONS.allAnalysisFailed,
      5200
    );
  });

  test('Alt+Right from Discover with an analyzed file advances to Organize', () => {
    mockState = buildState({
      phase: 'discover',
      selectedFiles: [{ path: '/docs/a.pdf', name: 'a.pdf' }],
      results: [{ path: '/docs/a.pdf', analysis: { category: 'Invoices' } }]
    });
    renderHook(() => useKeyboardShortcuts());

    pressAlt('ArrowRight');

    expect(setPhaseDispatches()).toEqual(['organize']);
    expect(mockNotification.showInfo).not.toHaveBeenCalled();
    expect(mockNotification.addNotification).toHaveBeenCalledWith(
      expect.stringContaining('Organize'),
      'info',
      2000
    );
  });

  test('Alt+Right from Organize with nothing organized stays put and says why', () => {
    mockState = buildState({ phase: 'organize' });
    renderHook(() => useKeyboardShortcuts());

    pressAlt('ArrowRight');

    expect(setPhaseDispatches()).toEqual([]);
    expect(mockNotification.showInfo).toHaveBeenCalledWith(
      PHASE_PREREQUISITE_REASONS.needsProcessedFile,
      5200
    );
  });

  test('Alt+Right from Organize after a file was organized opens Results', () => {
    mockState = buildState({
      phase: 'organize',
      organizedFiles: [{ originalPath: '/docs/a.pdf', path: '/Invoices/a.pdf' }]
    });
    renderHook(() => useKeyboardShortcuts());

    pressAlt('ArrowRight');

    expect(setPhaseDispatches()).toEqual(['complete']);
  });

  test('Alt+Arrow is paused while analysis runs, like the phase tabs', () => {
    const state = buildState({
      phase: 'discover',
      selectedFiles: [{ path: '/docs/a.pdf', name: 'a.pdf' }],
      results: [{ path: '/docs/a.pdf', analysis: { category: 'Invoices' } }]
    });
    state.analysis.isAnalyzing = true;
    mockState = state;
    renderHook(() => useKeyboardShortcuts());

    pressAlt('ArrowRight');
    pressAlt('ArrowLeft');

    expect(setPhaseDispatches()).toEqual([]);
    expect(mockNotification.showInfo).toHaveBeenCalledWith(
      'Navigation is paused until the current operation finishes.',
      5200
    );
  });

  test('Alt+Arrow is paused while files are being organized', () => {
    const state = buildState({ phase: 'organize' });
    state.ui.isOrganizing = true;
    mockState = state;
    renderHook(() => useKeyboardShortcuts());

    pressAlt('ArrowLeft');

    expect(setPhaseDispatches()).toEqual([]);
  });

  test('Alt+Left is always open, even when the current step has nothing done', () => {
    mockState = buildState({ phase: 'complete' });
    renderHook(() => useKeyboardShortcuts());

    pressAlt('ArrowLeft');

    expect(setPhaseDispatches()).toEqual(['organize']);
    expect(mockNotification.showInfo).not.toHaveBeenCalled();
  });

  test('Alt+Left from Organize goes back to Discover with no files at all', () => {
    mockState = buildState({ phase: 'organize', smartFolders: [] });
    renderHook(() => useKeyboardShortcuts());

    pressAlt('ArrowLeft');

    expect(setPhaseDispatches()).toEqual(['discover']);
  });
});
