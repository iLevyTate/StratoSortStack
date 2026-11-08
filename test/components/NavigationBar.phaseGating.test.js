/**
 * @jest-environment jsdom
 */
/**
 * Phase tabs follow one rule (uiSlice.getPhaseNavigation): a tab opens exactly
 * when the in-phase Continue button would, a closed tab says why in its
 * tooltip, and going back is always allowed. Uses the real uiSlice rules and
 * selectors; only the store hooks and the chrome around the tabs are mocked.
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockDispatch = jest.fn();
let mockState = {};

jest.mock('../../src/renderer/store/hooks', () => ({
  useAppDispatch: jest.fn(() => mockDispatch),
  useAppSelector: jest.fn((selector) => selector(mockState))
}));

jest.mock('../../src/renderer/store/slices/aiProviderSlice', () => ({
  fetchAiConfig: jest.fn(() => ({ type: 'aiProvider/fetch' }))
}));

const mockNotification = { showInfo: jest.fn() };

jest.mock('../../src/renderer/contexts/FloatingSearchContext', () => ({
  useFloatingSearch: jest.fn(() => ({
    isModalOpen: false,
    openSearchModal: jest.fn(),
    closeSearchModal: jest.fn()
  }))
}));

jest.mock('../../src/renderer/contexts/NotificationContext', () => ({
  useNotification: jest.fn(() => mockNotification)
}));

jest.mock('../../src/renderer/components/UpdateIndicator', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../src/renderer/components/common/AIProviderBadge', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../src/renderer/components/ui', () => ({
  Button: ({ children, leftIcon, ...props }) => (
    <button {...props}>
      {leftIcon}
      {children}
    </button>
  ),
  IconButton: ({ icon, children, ...props }) => (
    <button {...props}>
      {icon}
      {children}
    </button>
  )
}));

jest.mock('../../src/renderer/components/ui/Typography', () => ({
  Text: ({ as: Component = 'span', children, ...props }) => (
    <Component {...props}>{children}</Component>
  )
}));

jest.mock('../../src/renderer/utils/platform', () => ({ isMac: false }));

jest.mock('../../src/renderer/components/UndoRedoSystem', () => ({
  useUndoRedo: jest.fn(() => ({ isExecuting: false, executionStatus: null }))
}));

import NavigationBar from '../../src/renderer/components/NavigationBar';
import { PHASE_PREREQUISITE_REASONS } from '../../src/renderer/store/slices/uiSlice';

const UNCATEGORIZED = { id: 'uncat', name: 'Uncategorized', category: 'uncategorized' };
const INVOICES = { id: 'sf-1', name: 'Invoices' };

function buildState({
  phase = 'welcome',
  smartFolders = [UNCATEGORIZED, INVOICES],
  selectedFiles = [],
  results = [],
  organizedFiles = [],
  isAnalyzing = false
} = {}) {
  return {
    ui: {
      currentPhase: phase,
      viewMode: 'phased',
      isOrganizing: false,
      isLoading: false,
      resetCounter: 0
    },
    files: {
      smartFolders,
      selectedFiles,
      fileStates: {},
      organizedFiles,
      organizedPathIndex: []
    },
    analysis: { isAnalyzing, results },
    system: { health: { llama: 'online', vectorDb: 'online' } },
    aiProvider: { loaded: true }
  };
}

function tab(container, phase) {
  return container.querySelector(`[data-phase="${phase}"]`);
}

function setPhaseDispatches() {
  return mockDispatch.mock.calls
    .map(([action]) => action)
    .filter((action) => action && action.type === 'ui/setPhase')
    .map((action) => action.payload);
}

describe('NavigationBar phase tabs follow the in-phase prerequisites', () => {
  beforeEach(() => {
    mockDispatch.mockClear();
    mockNotification.showInfo.mockClear();
    window.electronAPI = {};
  });

  afterEach(() => {
    delete window.electronAPI;
  });

  test('Discover is closed on Welcome until a destination exists, and says why', () => {
    mockState = buildState({ phase: 'welcome', smartFolders: [UNCATEGORIZED] });
    const { container } = render(<NavigationBar />);

    const discover = tab(container, 'discover');
    expect(discover).toHaveAttribute('aria-disabled', 'true');
    expect(discover).toHaveAttribute('title', PHASE_PREREQUISITE_REASONS.needsDestination);
    // Still focusable so keyboard and screen-reader users can reach the reason.
    expect(discover).not.toHaveAttribute('disabled');

    fireEvent.click(discover);
    expect(setPhaseDispatches()).not.toContain('discover');
    expect(mockNotification.showInfo).toHaveBeenCalledWith(
      PHASE_PREREQUISITE_REASONS.needsDestination,
      expect.any(Number)
    );
  });

  test('Discover opens from Welcome once a destination exists', () => {
    mockState = buildState({ phase: 'welcome' });
    const { container } = render(<NavigationBar />);

    const discover = tab(container, 'discover');
    expect(discover).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(discover);
    expect(setPhaseDispatches()).toContain('discover');
  });

  test('Setup is always open from Welcome', () => {
    mockState = buildState({ phase: 'welcome', smartFolders: [] });
    const { container } = render(<NavigationBar />);

    expect(tab(container, 'setup')).toHaveAttribute('aria-disabled', 'false');
    expect(tab(container, 'welcome')).toHaveAttribute('aria-current', 'step');
  });

  test('Discover opens from Setup with the Uncategorized fallback, like Continue', () => {
    mockState = buildState({ phase: 'setup', smartFolders: [UNCATEGORIZED] });
    const { container } = render(<NavigationBar />);
    expect(tab(container, 'discover')).toHaveAttribute('aria-disabled', 'false');

    mockState = buildState({ phase: 'setup', smartFolders: [] });
    const empty = render(<NavigationBar />);
    expect(tab(empty.container, 'discover')).toHaveAttribute('aria-disabled', 'true');
    expect(tab(empty.container, 'discover')).toHaveAttribute(
      'title',
      PHASE_PREREQUISITE_REASONS.needsSmartFolder
    );
  });

  test('Organize is closed on Discover until a file is analyzed, with the Continue text', () => {
    mockState = buildState({
      phase: 'discover',
      selectedFiles: [{ path: '/docs/a.pdf', name: 'a.pdf' }]
    });
    const { container } = render(<NavigationBar />);

    const organize = tab(container, 'organize');
    expect(organize).toHaveAttribute('aria-disabled', 'true');
    expect(organize).toHaveAttribute('title', PHASE_PREREQUISITE_REASONS.needsAnalyzedFile);
  });

  test('a total analysis failure names the failure, like the Discover footer', () => {
    mockState = buildState({
      phase: 'discover',
      selectedFiles: [{ path: '/docs/a.pdf', name: 'a.pdf' }],
      results: [{ path: '/docs/a.pdf', error: 'boom' }]
    });
    const { container } = render(<NavigationBar />);

    expect(tab(container, 'organize')).toHaveAttribute(
      'title',
      PHASE_PREREQUISITE_REASONS.allAnalysisFailed
    );
  });

  test('Organize opens from Discover once a file is analyzed', () => {
    mockState = buildState({
      phase: 'discover',
      selectedFiles: [{ path: '/docs/a.pdf', name: 'a.pdf' }],
      results: [{ path: '/docs/a.pdf', analysis: { category: 'Invoices' } }]
    });
    const { container } = render(<NavigationBar />);

    const organize = tab(container, 'organize');
    expect(organize).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(organize);
    expect(setPhaseDispatches()).toContain('organize');
  });

  test('Results stay closed on Organize until a file was organized', () => {
    mockState = buildState({ phase: 'organize' });
    const { container } = render(<NavigationBar />);

    const complete = tab(container, 'complete');
    expect(complete).toHaveAttribute('aria-disabled', 'true');
    expect(complete).toHaveAttribute('title', PHASE_PREREQUISITE_REASONS.needsProcessedFile);

    mockState = buildState({
      phase: 'organize',
      organizedFiles: [{ originalPath: '/docs/a.pdf', path: '/Invoices/a.pdf' }]
    });
    const second = render(<NavigationBar />);
    expect(tab(second.container, 'complete')).toHaveAttribute('aria-disabled', 'false');
  });

  test('going back is always allowed, including Organize and Results back to Setup', () => {
    for (const phase of ['organize', 'complete']) {
      mockDispatch.mockClear();
      // No destination and nothing analyzed: forward prerequisites fail, but
      // earlier steps never lock.
      mockState = buildState({ phase, smartFolders: [] });
      const { container, unmount } = render(<NavigationBar />);

      for (const earlier of ['welcome', 'setup', 'discover']) {
        expect(tab(container, earlier)).toHaveAttribute('aria-disabled', 'false');
      }
      fireEvent.click(tab(container, 'setup'));
      expect(setPhaseDispatches()).toContain('setup');
      unmount();
    }
  });

  test('a forward jump the flow does not offer keeps its graph reason', () => {
    mockState = buildState({ phase: 'welcome' });
    const { container } = render(<NavigationBar />);

    expect(tab(container, 'organize')).toHaveAttribute('aria-disabled', 'true');
    expect(tab(container, 'organize')).toHaveAttribute(
      'title',
      'Organize opens from Discover. Go to Discover first.'
    );
  });
});
