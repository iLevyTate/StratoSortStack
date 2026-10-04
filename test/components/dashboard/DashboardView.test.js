/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockDispatch = jest.fn();
let mockState = {};

jest.mock('../../../src/renderer/store/hooks', () => ({
  useAppDispatch: jest.fn(() => mockDispatch),
  useAppSelector: jest.fn((selector) => selector(mockState))
}));

const mockCanTransitionTo = jest.fn();

jest.mock('../../../src/renderer/store/slices/uiSlice', () => ({
  setPhase: jest.fn((phase) => ({ type: 'ui/setPhase', payload: phase })),
  setViewMode: jest.fn((mode) => ({ type: 'ui/setViewMode', payload: mode })),
  setCameFromDashboard: jest.fn((value) => ({
    type: 'ui/setCameFromDashboard',
    payload: value
  })),
  canTransitionTo: (...args) => mockCanTransitionTo(...args)
}));

// Each selector reads from the controllable mockSelectorValues object so a test
// can tune the rendered numbers/lists without standing up a real store.
let mockSelectorValues = {};

jest.mock('../../../src/renderer/store/selectors', () => ({
  selectFileStats: () => mockSelectorValues.fileStats,
  selectSmartFolders: () => mockSelectorValues.smartFolders,
  selectOrganizedFiles: () => mockSelectorValues.organizedFiles,
  selectOrganizedCount: () =>
    Array.isArray(mockSelectorValues.organizedFiles) ? mockSelectorValues.organizedFiles.length : 0,
  selectFilesWithAnalysis: () => mockSelectorValues.filesWithAnalysis,
  selectIsAnalyzing: () => mockSelectorValues.isAnalyzing,
  selectAnalysisProgress: () => mockSelectorValues.analysisProgress,
  selectRedactPaths: () => mockSelectorValues.redactPaths
}));

const mockFormatDisplayFileName = jest.fn((name) => name);

jest.mock('../../../src/renderer/utils/pathDisplay', () => ({
  formatDisplayFileName: (...args) => mockFormatDisplayFileName(...args)
}));

// Capture the drop callback the dashboard hands to useDragAndDrop so a test can
// invoke it directly — the hook's DOM-event parsing is covered by its own tests.
let capturedDropHandler = null;
let mockIsDragging = false;
jest.mock('../../../src/renderer/hooks/useDragAndDrop', () => ({
  useDragAndDrop: (onFilesDropped) => {
    capturedDropHandler = onFilesDropped;
    return { isDragging: mockIsDragging, dragProps: { 'data-testid': 'dashboard-dropzone' } };
  }
}));

jest.mock('../../../src/renderer/components/discover/AnalysisProgress', () => ({
  __esModule: true,
  default: () => <div data-testid="analysis-progress" />
}));

// KnowledgeStatsCard does an async fetch on mount; stub it out so DashboardView
// tests remain synchronous and don't need electronAPI wiring.
jest.mock('../../../src/renderer/components/dashboard/KnowledgeStatsCard', () => ({
  __esModule: true,
  default: () => <div data-testid="knowledge-stats-card" />
}));

jest.mock('../../../src/renderer/components/ui/Card', () => ({
  __esModule: true,
  default: ({ children, as, onClick, type }) =>
    as === 'button' ? (
      <button type={type || 'button'} data-testid="card-button" onClick={onClick}>
        {children}
      </button>
    ) : (
      <div data-testid="card">{children}</div>
    )
}));

jest.mock('../../../src/renderer/components/ui/Button', () => ({
  __esModule: true,
  // Strip design-system-only props (variant/size/leftIcon/...) so they don't leak
  // onto the DOM node and trip React's unknown-attribute warning.
  default: ({ children, onClick, type }) => (
    <button type={type || 'button'} onClick={onClick}>
      {children}
    </button>
  )
}));

jest.mock('../../../src/renderer/components/ui/StatusBadge', () => ({
  __esModule: true,
  default: ({ children, variant }) => (
    <span data-testid="status-badge" data-variant={variant}>
      {children}
    </span>
  )
}));

jest.mock('../../../src/renderer/components/layout/Stack', () => ({
  __esModule: true,
  default: ({ children }) => <div>{children}</div>
}));

jest.mock('../../../src/renderer/components/ui/AlertBox', () => ({
  __esModule: true,
  default: ({ children }) => <div role="alert">{children}</div>
}));

jest.mock('../../../src/renderer/components/ui/StateMessage', () => ({
  __esModule: true,
  default: ({ title, description, action }) => (
    <div data-testid="empty-state">
      <span>{title}</span>
      <span>{description}</span>
      {action}
    </div>
  )
}));

jest.mock('../../../src/renderer/components/ui/Typography', () => ({
  // Honor `as` so heading-outline oracles (U-T8) see the real tag levels.
  Heading: ({ children, as: Component = 'h2' }) => <Component>{children}</Component>,
  Text: ({ children }) => <span>{children}</span>,
  Caption: ({ children }) => <small>{children}</small>
}));

// Any lucide icon resolves to an empty span so icon names never need to be
// enumerated as the design's icon set evolves.
jest.mock('lucide-react', () => {
  const ReactLib = require('react');
  return new Proxy({}, { get: () => () => ReactLib.createElement('span') });
});

import DashboardView from '../../../src/renderer/components/dashboard/DashboardView';

const DEFAULT_FOLDERS = [
  { id: 'fin', name: 'Financial', description: 'Invoices, receipts' },
  { id: 'work', name: 'Work', description: 'Contracts, reports' },
  { id: 'shots', name: 'Screenshots', description: 'PNG & JPG' },
  { id: 'pers', name: 'Personal', description: 'IDs, letters' },
  { id: 'media', name: 'Media', description: 'Video & audio' },
  { id: 'inbox', name: 'Inbox', description: 'Unsorted' }
];

function setupState({
  currentPhase = 'welcome',
  fileStats = { total: 0, ready: 0, failed: 0, pending: 0 },
  smartFolders = DEFAULT_FOLDERS,
  organizedFiles = [],
  filesWithAnalysis = [],
  isAnalyzing = false,
  analysisProgress = null,
  redactPaths = false
} = {}) {
  mockState = { ui: { currentPhase } };
  mockSelectorValues = {
    fileStats,
    smartFolders,
    organizedFiles,
    filesWithAnalysis,
    isAnalyzing,
    analysisProgress,
    redactPaths
  };
}

function buttonFor(text) {
  return screen.getByText(text).closest('button');
}

function phasePayloads() {
  return mockDispatch.mock.calls.filter(([a]) => a.type === 'ui/setPhase').map(([a]) => a.payload);
}

describe('DashboardView', () => {
  beforeEach(() => {
    mockDispatch.mockClear();
    mockCanTransitionTo.mockReset();
    mockFormatDisplayFileName.mockClear();
    mockCanTransitionTo.mockReturnValue(true);
    capturedDropHandler = null;
    mockIsDragging = false;
    setupState();
  });

  describe('hero', () => {
    test('renders greeting and both Import folder / Add files actions', () => {
      setupState({ organizedFiles: [{ newName: 'done.pdf' }] });
      render(<DashboardView />);

      expect(screen.getByText('Welcome back')).toBeInTheDocument();
      expect(buttonFor('Import folder')).not.toBeNull();
      expect(buttonFor('Add files')).not.toBeNull();
    });

    test('Add files navigates to discover then opens the real file picker via the bridge', () => {
      jest.useFakeTimers();
      const dispatchSpy = jest.spyOn(window, 'dispatchEvent');
      try {
        setupState({ currentPhase: 'welcome', organizedFiles: [{ newName: 'done.pdf' }] });
        render(<DashboardView />);

        fireEvent.click(buttonFor('Add files'));
        // Routes into the phased discover workspace...
        expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setViewMode', payload: 'phased' });
        expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setPhase', payload: 'discover' });
        // ...then fires the picker bridge once DiscoverPhase has had time to mount.
        jest.runOnlyPendingTimers();
        const events = dispatchSpy.mock.calls.map(([e]) => e.type);
        expect(events).toContain('app:select-files');
      } finally {
        dispatchSpy.mockRestore();
        jest.useRealTimers();
      }
    });

    test('Import folder navigates to discover then opens the real folder picker via the bridge', () => {
      jest.useFakeTimers();
      const dispatchSpy = jest.spyOn(window, 'dispatchEvent');
      try {
        setupState({ currentPhase: 'welcome', organizedFiles: [{ newName: 'done.pdf' }] });
        render(<DashboardView />);

        fireEvent.click(buttonFor('Import folder'));
        expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setViewMode', payload: 'phased' });
        expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setPhase', payload: 'discover' });
        jest.runOnlyPendingTimers();
        const events = dispatchSpy.mock.calls.map(([e]) => e.type);
        expect(events).toContain('app:select-folder');
      } finally {
        dispatchSpy.mockRestore();
        jest.useRealTimers();
      }
    });

    test('dropping files onto the dashboard forwards them to discover via the drop bridge', () => {
      jest.useFakeTimers();
      const dispatchSpy = jest.spyOn(window, 'dispatchEvent');
      try {
        setupState({ currentPhase: 'welcome' });
        render(<DashboardView />);

        expect(typeof capturedDropHandler).toBe('function');
        const dropped = [{ path: '/a/b.pdf', name: 'b.pdf', type: 'file' }];
        capturedDropHandler(dropped);

        expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setPhase', payload: 'discover' });
        jest.runOnlyPendingTimers();
        const dropEvent = dispatchSpy.mock.calls
          .map(([e]) => e)
          .find((e) => e.type === 'app:drop-files');
        expect(dropEvent).toBeTruthy();
        expect(dropEvent.detail).toEqual(dropped);
      } finally {
        dispatchSpy.mockRestore();
        jest.useRealTimers();
      }
    });

    test('shows a drop-target ring while a drag is in progress', () => {
      mockIsDragging = true;
      setupState({ currentPhase: 'welcome' });
      render(<DashboardView />);

      const dropzone = screen.getByTestId('dashboard-dropzone');
      expect(dropzone.className).toMatch(/ring-2/);
    });

    test('an empty or non-array drop is ignored — no navigation, no bridge event', () => {
      jest.useFakeTimers();
      const dispatchSpy = jest.spyOn(window, 'dispatchEvent');
      try {
        setupState({ currentPhase: 'welcome' });
        render(<DashboardView />);

        expect(typeof capturedDropHandler).toBe('function');
        mockDispatch.mockClear();
        capturedDropHandler([]);
        capturedDropHandler(null);

        expect(mockDispatch).not.toHaveBeenCalled();
        jest.runOnlyPendingTimers();
        const events = dispatchSpy.mock.calls.map(([e]) => e.type);
        expect(events).not.toContain('app:drop-files');
      } finally {
        dispatchSpy.mockRestore();
        jest.useRealTimers();
      }
    });

    test('summary uses the onboarding phrasing when the pipeline is empty', () => {
      setupState({
        fileStats: { total: 0, ready: 0, failed: 0, pending: 0 },
        smartFolders: DEFAULT_FOLDERS
      });
      render(<DashboardView />);
      expect(
        screen.getByText('6 smart folders ready · add files to get started')
      ).toBeInTheDocument();
    });

    test('summary reflects pending and ready counts with consistent analysis wording', () => {
      setupState({
        fileStats: { total: 6, ready: 3, failed: 0, pending: 3 },
        smartFolders: DEFAULT_FOLDERS
      });
      render(<DashboardView />);
      expect(
        screen.getByText('6 smart folders ready · 3 awaiting analysis, 3 ready to organize')
      ).toBeInTheDocument();
    });

    test('summary is singular and reflects pending analysis when one file awaits', () => {
      setupState({
        fileStats: { total: 1, ready: 0, failed: 0, pending: 1 },
        smartFolders: [{ id: 'a', name: 'Financial' }]
      });
      render(<DashboardView />);
      expect(screen.getByText('1 smart folder ready · 1 awaiting analysis')).toBeInTheDocument();
    });
  });

  describe('adaptive status badge', () => {
    test('reads "All caught up" (success) when nothing is pending, ready, or failed', () => {
      setupState({ fileStats: { total: 0, ready: 0, failed: 0, pending: 0 } });
      render(<DashboardView />);
      const badge = screen.getByText('All caught up').closest('[data-testid="status-badge"]');
      expect(badge).toHaveAttribute('data-variant', 'success');
    });

    test('calls out pending analysis when files await', () => {
      setupState({ fileStats: { total: 4, ready: 0, failed: 0, pending: 4 } });
      render(<DashboardView />);
      expect(screen.getByText('4 awaiting analysis')).toBeInTheDocument();
    });

    test('calls out ready files when none are pending', () => {
      setupState({ fileStats: { total: 2, ready: 2, failed: 0, pending: 0 } });
      render(<DashboardView />);
      expect(screen.getByText('2 ready to organize')).toBeInTheDocument();
    });

    test('failures take priority and surface as an error-variant badge', () => {
      setupState({ fileStats: { total: 3, ready: 1, failed: 2, pending: 0 } });
      render(<DashboardView />);
      const badge = screen.getByText('2 need attention').closest('[data-testid="status-badge"]');
      expect(badge).toHaveAttribute('data-variant', 'error');
    });
  });

  describe('organization pipeline', () => {
    test('renders the three stage counts and an "in flight" tally', () => {
      setupState({
        fileStats: { total: 5, ready: 2, failed: 0, pending: 3 },
        organizedFiles: [{ newName: 'a.pdf' }, { newName: 'b.pdf' }]
      });
      render(<DashboardView />);

      expect(screen.getByText('Awaiting analysis')).toBeInTheDocument();
      expect(screen.getByText('Ready to organize')).toBeInTheDocument();
      expect(screen.getByText('Organized')).toBeInTheDocument();
      // in-flight = pending + ready, total = stats.total
      expect(screen.getByText('5 of 5 files in flight')).toBeInTheDocument();
    });

    test('shows an "All clear" pipeline badge when nothing is in flight', () => {
      setupState({ fileStats: { total: 0, ready: 0, failed: 0, pending: 0 } });
      render(<DashboardView />);
      expect(screen.getByText('All clear')).toBeInTheDocument();
      expect(screen.getByText('0 of 0 files in flight')).toBeInTheDocument();
    });

    test('the footer Failed chip deep-links to organize and an alert appears when files failed', () => {
      setupState({
        currentPhase: 'welcome',
        fileStats: { total: 3, ready: 1, failed: 2, pending: 0 }
      });
      render(<DashboardView />);

      expect(screen.getByRole('alert')).toHaveTextContent('2');
      const failedChip = screen.getByText('2 failed').closest('button');
      expect(failedChip).not.toBeNull();
      fireEvent.click(failedChip);
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setPhase', payload: 'organize' });
    });

    test('the footer Failed indicator is inert and no alert renders when nothing failed', () => {
      setupState({ fileStats: { total: 3, ready: 3, failed: 0, pending: 0 } });
      render(<DashboardView />);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByText('0 failed').closest('button')).toBeNull();
    });

    test('the failed alert uses singular wording for a single failure', () => {
      setupState({ fileStats: { total: 2, ready: 1, failed: 1, pending: 0 } });
      render(<DashboardView />);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('1 file');
      expect(alert).toHaveTextContent('review it');
    });
  });

  describe('recent activity', () => {
    test('empty rail Add files to start navigates to discover then opens the real file picker', () => {
      jest.useFakeTimers();
      const dispatchSpy = jest.spyOn(window, 'dispatchEvent');
      try {
        setupState({ currentPhase: 'welcome', organizedFiles: [] });
        render(<DashboardView />);

        expect(screen.getByTestId('empty-state')).toBeInTheDocument();
        expect(screen.queryByText('View all results')).not.toBeInTheDocument();

        fireEvent.click(buttonFor('Add files to start'));
        expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setPhase', payload: 'discover' });
        // The label promises adding files, so it must reach the real picker — not
        // dump the user on a blank discover screen.
        jest.runOnlyPendingTimers();
        const events = dispatchSpy.mock.calls.map(([e]) => e.type);
        expect(events).toContain('app:select-files');
      } finally {
        dispatchSpy.mockRestore();
        jest.useRealTimers();
      }
    });

    test('shows a pipeline queue preview when files are in flight but nothing is organized yet', () => {
      setupState({
        currentPhase: 'welcome',
        organizedFiles: [],
        filesWithAnalysis: [
          { path: '/a/pending.pdf', name: 'pending.pdf' },
          { path: '/a/ready.pdf', name: 'ready.pdf', analysis: { category: 'Work' } }
        ],
        fileStats: { total: 2, ready: 1, failed: 0, pending: 1 }
      });
      render(<DashboardView />);

      expect(screen.queryByTestId('empty-state')).not.toBeInTheDocument();
      expect(screen.getByText('pending.pdf')).toBeInTheDocument();
      expect(screen.getByText('ready.pdf')).toBeInTheDocument();
      expect(screen.getByText('Review ready files')).toBeInTheDocument();
    });

    test('queue preview routes to discover when nothing is ready yet', () => {
      setupState({
        currentPhase: 'welcome',
        organizedFiles: [],
        filesWithAnalysis: [{ path: '/a/pending.pdf', name: 'pending.pdf' }],
        fileStats: { total: 1, ready: 0, failed: 0, pending: 1 }
      });
      render(<DashboardView />);

      fireEvent.click(buttonFor('View in Discover'));
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setPhase', payload: 'discover' });
    });

    test('lists recent files newest-first, redaction-aware, with View all routing to organize', () => {
      setupState({
        currentPhase: 'welcome',
        organizedFiles: [
          { newName: 'one.pdf' },
          { newName: 'two.pdf' },
          { newName: 'three.pdf' },
          { newName: 'four.pdf' },
          { newName: 'five.pdf' }
        ],
        redactPaths: true
      });
      render(<DashboardView />);

      expect(screen.getByText('five.pdf')).toBeInTheDocument();
      expect(screen.getByText('two.pdf')).toBeInTheDocument();
      expect(screen.queryByText('one.pdf')).not.toBeInTheDocument();
      expect(mockFormatDisplayFileName).toHaveBeenCalledWith('five.pdf', { redact: true });

      fireEvent.click(buttonFor('View all results'));
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setPhase', payload: 'organize' });
    });

    test('recent entries fall back to originalName, then Unknown, when newName is absent', () => {
      setupState({
        currentPhase: 'welcome',
        organizedFiles: [{ originalName: 'scan.pdf' }, {}]
      });
      render(<DashboardView />);

      // newest-first: the nameless entry resolves to "Unknown", the prior to its originalName.
      expect(screen.getByText('scan.pdf')).toBeInTheDocument();
      expect(screen.getByText('Unknown')).toBeInTheDocument();
      expect(mockFormatDisplayFileName).toHaveBeenCalledWith('scan.pdf', { redact: false });
      expect(mockFormatDisplayFileName).toHaveBeenCalledWith('Unknown', { redact: false });
    });
  });

  describe('quick actions and routing semantics', () => {
    test('renders the three quick actions', () => {
      render(<DashboardView />);
      expect(screen.getByText('Add & analyze files')).toBeInTheDocument();
      expect(screen.getByText('Review & organize')).toBeInTheDocument();
      expect(screen.getByText('Manage smart folders')).toBeInTheDocument();
    });

    test('a legal transition navigates directly without the discover detour', () => {
      setupState({ currentPhase: 'welcome' });
      mockCanTransitionTo.mockReturnValue(true);
      render(<DashboardView />);

      fireEvent.click(buttonFor('Manage smart folders'));
      expect(phasePayloads()).toEqual(['setup']);
    });

    test('deep-linking out of the dashboard leaves a "came from dashboard" breadcrumb', () => {
      setupState({ currentPhase: 'welcome' });
      mockCanTransitionTo.mockReturnValue(true);
      render(<DashboardView />);

      fireEvent.click(buttonFor('Manage smart folders'));
      // Flips to the phased surface AND records the origin so the nav can offer
      // a one-click way back — in that order (setViewMode clears the flag).
      const types = mockDispatch.mock.calls.map(([action]) => action.type);
      expect(types.indexOf('ui/setViewMode')).toBeLessThan(
        types.indexOf('ui/setCameFromDashboard')
      );
      expect(mockDispatch).toHaveBeenCalledWith({
        type: 'ui/setCameFromDashboard',
        payload: true
      });
    });

    test('an illegal transition detours through the discover hub', () => {
      setupState({ currentPhase: 'welcome' });
      mockCanTransitionTo.mockReturnValue(false);
      render(<DashboardView />);

      fireEvent.click(buttonFor('Manage smart folders'));
      expect(phasePayloads()).toEqual(['discover', 'setup']);
    });

    test('routing to discover itself never double-dispatches, even when the transition is illegal', () => {
      jest.useFakeTimers();
      try {
        setupState({ currentPhase: 'welcome' });
        mockCanTransitionTo.mockReturnValue(false);
        render(<DashboardView />);

        // "Add & analyze files" routes to discover; the detour target is already
        // discover, so the second setPhase must be skipped (no ['discover','discover']).
        fireEvent.click(buttonFor('Add & analyze files'));
        expect(phasePayloads()).toEqual(['discover']);
      } finally {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
      }
    });

    test('Add & analyze files opens the real file picker; on the current phase it only switches the view mode', () => {
      jest.useFakeTimers();
      const dispatchSpy = jest.spyOn(window, 'dispatchEvent');
      try {
        setupState({ currentPhase: 'discover' });
        render(<DashboardView />);

        fireEvent.click(buttonFor('Add & analyze files'));
        // Already on discover, so no redundant setPhase — only the view-mode flip.
        expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setViewMode', payload: 'phased' });
        expect(phasePayloads()).toEqual([]);
        // Its description ("Pick files...") promises a picker, so the bridge fires.
        jest.runOnlyPendingTimers();
        const events = dispatchSpy.mock.calls.map(([e]) => e.type);
        expect(events).toContain('app:select-files');
      } finally {
        dispatchSpy.mockRestore();
        jest.useRealTimers();
      }
    });
  });

  describe('smart folders', () => {
    test('renders smart folder chips and Manage routes to setup', () => {
      setupState({ currentPhase: 'welcome', smartFolders: DEFAULT_FOLDERS });
      render(<DashboardView />);

      expect(screen.getByText('Financial')).toBeInTheDocument();
      expect(screen.getByText('Work')).toBeInTheDocument();
      fireEvent.click(buttonFor('Manage'));
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setPhase', payload: 'setup' });
    });
  });

  describe('section headings', () => {
    test('section labels are real h2 headings under the hero h1 (U-T8)', () => {
      setupState({ organizedFiles: [{ newName: 'done.pdf' }] });
      render(<DashboardView />);

      for (const name of [
        'Organization pipeline',
        'Smart folders',
        'Recent activity',
        'Quick actions'
      ]) {
        expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
      }
      // Outline sanity: the first heading in DOM order stays the hero h1, so
      // the new h2s cannot introduce an axe heading-order skip.
      const headings = screen.getAllByRole('heading');
      expect(headings[0].tagName).toBe('H1');
    });
  });

  describe('ambient cards', () => {
    test('shows AnalysisProgress only while analysis is in flight', () => {
      setupState({ isAnalyzing: true, analysisProgress: { current: 1, total: 4 } });
      const { rerender } = render(<DashboardView />);
      expect(screen.getByTestId('analysis-progress')).toBeInTheDocument();

      setupState({ isAnalyzing: false, analysisProgress: null });
      rerender(<DashboardView />);
      expect(screen.queryByTestId('analysis-progress')).not.toBeInTheDocument();
    });
  });
});
