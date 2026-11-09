/**
 * @jest-environment jsdom
 */
/**
 * Knowledge OS "Go to Discover": a phase move from outside the tab strip, so
 * it follows the tabs' rule and their pause while work runs, and leaves the
 * dashboard so the move is visible. Real uiSlice rules and selectors; the
 * store hooks and the graph's own state are mocked.
 */
import { renderHook, act } from '@testing-library/react';

const mockDispatch = jest.fn();
let mockState = {};

jest.mock('../../../../src/renderer/store/hooks', () => ({
  useAppDispatch: jest.fn(() => mockDispatch),
  useAppSelector: jest.fn((selector) => selector(mockState))
}));

const mockNotification = { showInfo: jest.fn(), addNotification: jest.fn() };

jest.mock('../../../../src/renderer/contexts/NotificationContext', () => ({
  useNotification: jest.fn(() => mockNotification)
}));

jest.mock('../../../../src/renderer/hooks', () => {
  const actions = new Proxy({}, { get: () => jest.fn() });
  return {
    useGraphState: () => ({ nodes: [], edges: [], selectedNodeId: null, actions })
  };
});

jest.mock('../../../../src/renderer/components/search/hooks/useDuplicateBadgeScan', () => ({
  useDuplicateBadgeScan: jest.fn()
}));

jest.mock('../../../../src/renderer/utils/elkLayout', () => ({
  elkLayout: jest.fn(),
  cancelPendingLayout: jest.fn(),
  debouncedElkLayout: jest.fn(),
  smartLayout: jest.fn(),
  clusterRadialLayout: jest.fn(),
  clusterExpansionLayout: jest.fn(),
  LARGE_GRAPH_THRESHOLD: 1000
}));

import { useGraphTab } from '../../../../src/renderer/components/search/hooks/useGraphTab';
import { PHASE_PREREQUISITE_REASONS } from '../../../../src/renderer/store/slices/uiSlice';

const UNCATEGORIZED = { id: 'uncat', name: 'Uncategorized', category: 'uncategorized' };
const INVOICES = { id: 'sf-1', name: 'Invoices' };

function buildState({
  phase = 'organize',
  viewMode = 'phased',
  smartFolders = [UNCATEGORIZED, INVOICES],
  isAnalyzing = false,
  isOrganizing = false
} = {}) {
  return {
    ui: { currentPhase: phase, viewMode, isOrganizing, isLoading: false, selectedTheme: 'primary' },
    files: {
      smartFolders,
      selectedFiles: [],
      fileStates: {},
      organizedFiles: [],
      organizedPathIndex: []
    },
    analysis: { isAnalyzing, results: [] }
  };
}

function renderGraphTab(onClose) {
  const ref = () => ({ current: null });
  return renderHook(() =>
    useGraphTab({
      isOpen: false,
      activeTab: 'search',
      onClose,
      query: '',
      setQuery: jest.fn(),
      defaultTopK: 10,
      stats: null,
      graphViewEnabled: false,
      setError: jest.fn(),
      recommendationMap: {},
      sidebarSections: {},
      chatMessages: [],
      setChatMessages: jest.fn(),
      clusterActionRefs: ref(),
      handleMoveAllToFolderRef: ref(),
      layoutRequestCounterRef: { current: 0 },
      error: null,
      hasLoadedStats: false,
      refreshStats: jest.fn(),
      organizationalHealthRef: ref()
    })
  );
}

function dispatchedTypes() {
  return mockDispatch.mock.calls.map(([action]) => action?.type);
}

function setPhaseDispatches() {
  return mockDispatch.mock.calls
    .map(([action]) => action)
    .filter((action) => action && action.type === 'ui/setPhase')
    .map((action) => action.payload);
}

describe('Knowledge OS Go to Discover', () => {
  beforeEach(() => {
    mockDispatch.mockClear();
    mockNotification.showInfo.mockClear();
    window.electronAPI = {};
  });

  afterEach(() => {
    delete window.electronAPI;
  });

  test('from the dashboard it leaves the dashboard, opens Discover and closes the graph', () => {
    mockState = buildState({ phase: 'organize', viewMode: 'dashboard' });
    const onClose = jest.fn();
    const { result } = renderGraphTab(onClose);

    act(() => result.current.handleGoToDiscover());

    expect(dispatchedTypes()).toEqual(
      expect.arrayContaining(['ui/setViewMode', 'ui/setCameFromDashboard', 'ui/setPhase'])
    );
    expect(dispatchedTypes().indexOf('ui/setViewMode')).toBeLessThan(
      dispatchedTypes().indexOf('ui/setPhase')
    );
    expect(setPhaseDispatches()).toEqual(['discover']);
    expect(onClose).toHaveBeenCalled();
    expect(mockNotification.showInfo).not.toHaveBeenCalled();
  });

  test('from Welcome without a destination it stays put and says why', () => {
    mockState = buildState({ phase: 'welcome', smartFolders: [UNCATEGORIZED] });
    const onClose = jest.fn();
    const { result } = renderGraphTab(onClose);

    act(() => result.current.handleGoToDiscover());

    expect(setPhaseDispatches()).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    expect(mockNotification.showInfo).toHaveBeenCalledWith(
      PHASE_PREREQUISITE_REASONS.needsDestination,
      5200
    );
  });

  test('is paused while files are being organized', () => {
    mockState = buildState({ phase: 'organize', isOrganizing: true });
    const onClose = jest.fn();
    const { result } = renderGraphTab(onClose);

    act(() => result.current.handleGoToDiscover());

    expect(setPhaseDispatches()).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    expect(mockNotification.showInfo).toHaveBeenCalledWith(
      'Navigation is paused until the current operation finishes.',
      5200
    );
  });
});
