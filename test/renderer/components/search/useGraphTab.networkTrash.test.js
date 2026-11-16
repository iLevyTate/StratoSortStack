/**
 * @jest-environment jsdom
 */
/**
 * Duplicate cleanup reports copies left on a network drive with the reason,
 * since Windows has no Recycle Bin there, instead of "see logs".
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

function buildState() {
  return {
    ui: { currentPhase: 'organize', viewMode: 'phased', isOrganizing: false, isLoading: false },
    files: {
      smartFolders: [],
      selectedFiles: [],
      fileStates: {},
      organizedFiles: [],
      organizedPathIndex: []
    },
    analysis: { isAnalyzing: false, results: [] }
  };
}

test('a copy on a network drive is reported with its reason', async () => {
  mockState = buildState();
  const setError = jest.fn();
  window.electronAPI = {
    embeddings: {
      trashDuplicates: jest.fn(async () => ({
        success: false,
        trashed: [{ path: 'C:/docs/b.pdf', size: 1 }],
        failed: [{ path: 'Z:/team/c.pdf', code: 'NETWORK_NO_RECYCLE_BIN', error: 'network' }],
        skipped: []
      })),
      findDuplicates: jest.fn(async () => ({ success: true, groups: [] }))
    }
  };
  const ref = () => ({ current: null });
  const { result } = renderHook(() =>
    useGraphTab({
      isOpen: false,
      activeTab: 'search',
      onClose: jest.fn(),
      query: '',
      setQuery: jest.fn(),
      defaultTopK: 10,
      stats: null,
      graphViewEnabled: false,
      setError,
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

  await act(async () => {
    await result.current.handleResolveDuplicates([
      {
        tier: 'nearIdentical',
        keep: { path: 'C:/docs/a.pdf' },
        delete: [{ path: 'C:/docs/b.pdf' }, { path: 'Z:/team/c.pdf' }]
      }
    ]);
  });

  const messages = setError.mock.calls.map(([m]) => m).filter(Boolean);
  expect(messages.join(' ')).toMatch(/Trashed 1 of 2. Left 1 on a network drive/);
  expect(messages.join(' ')).not.toMatch(/see the logs/i);
  delete window.electronAPI;
});
