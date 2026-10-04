/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockShowConfirm = jest.fn();
const mockOpenSearchModal = jest.fn();
const mockAnalyzeFiles = jest.fn();
const mockCancelAnalysis = jest.fn();
const mockClearAnalysisQueue = jest.fn();
const mockRetryFailedFiles = jest.fn();
const mockHandleFileSelection = jest.fn();
const mockHandleFolderSelection = jest.fn();
const mockHandleFileDrop = jest.fn();
const mockHandleFileAction = jest.fn();
const mockResetAnalysisState = jest.fn();
const mockAddNotification = jest.fn();

jest.mock('../../src/renderer/contexts/NotificationContext', () => ({
  useNotification: jest.fn(() => ({ addNotification: mockAddNotification }))
}));

jest.mock('../../src/renderer/contexts/FloatingSearchContext', () => ({
  useFloatingSearch: jest.fn(() => ({ openSearchModal: mockOpenSearchModal }))
}));

jest.mock('../../src/renderer/hooks', () => ({
  useConfirmDialog: jest.fn(() => ({
    showConfirm: mockShowConfirm,
    ConfirmDialog: () => <div data-testid="confirm-dialog" />
  })),
  useDragAndDrop: jest.fn(() => ({
    isDragging: false,
    dragProps: {}
  })),
  useSettingsSubscription: jest.fn()
}));

jest.mock('../../src/renderer/components/ui', () => ({
  Button: ({ children, ...props }) => <button {...props}>{children}</button>,
  IconButton: ({ icon, ...props }) => <button {...props}>{icon}</button>,
  Card: ({ children, className }) => <div className={className}>{children}</div>,
  StatusBadge: ({ children }) => <div>{children}</div>,
  MinimizableGuideCard: ({ children, collapsedSummary }) => {
    const React = require('react');
    const [isOpen, setIsOpen] = React.useState(true);

    return isOpen ? (
      <div>
        <button aria-label="Minimize guide" onClick={() => setIsOpen(false)} type="button">
          Minimize
        </button>
        {children}
      </div>
    ) : (
      <div>
        {collapsedSummary}
        <button aria-label="Expand guide" onClick={() => setIsOpen(true)} type="button">
          Expand
        </button>
      </div>
    );
  }
}));

jest.mock('../../src/renderer/components/ui/Typography', () => ({
  Heading: ({ children, className, id }) => (
    <h1 className={className} id={id}>
      {children}
    </h1>
  ),
  Text: ({ children, className }) => <span className={className}>{children}</span>
}));

jest.mock('../../src/renderer/components/layout', () => ({
  ActionBar: ({ children }) => <div>{children}</div>,
  Inline: ({ children, className }) => <div className={className}>{children}</div>,
  Stack: ({ children, className }) => <div className={className}>{children}</div>
}));

jest.mock('../../src/renderer/components/discover', () => ({
  NamingSettingsModal: ({ isOpen }) => (isOpen ? <div>NAMING_MODAL</div> : null),
  SelectionControls: () => <div>SELECTION_CONTROLS</div>,
  AnalysisResultsList: ({ results }) => <div>{`RESULTS:${results.length}`}</div>,
  AnalysisProgress: () => <div>ANALYSIS_PROGRESS</div>
}));

jest.mock('../../src/renderer/components/ui/LoadingSkeleton', () => ({
  FileListSkeleton: () => <div>FILE_LIST_SKELETON</div>
}));

jest.mock('../../src/renderer/store', () => ({
  getState: jest.fn(() => ({
    analysis: {
      isAnalyzing: false,
      analysisProgress: {
        current: 0,
        total: 0,
        lastActivity: Date.now()
      }
    },
    license: { snapshot: { state: 'free' } }
  }))
}));

jest.mock('../../src/renderer/store/hooks', () => ({
  useAppSelector: jest.fn((selector) => selector({ license: { snapshot: { state: 'free' } } })),
  useAppDispatch: jest.fn(() => jest.fn())
}));

jest.mock('../../src/renderer/phases/discover', () => ({
  useDiscoverState: jest.fn(() => ({
    selectedFiles: [{ path: '/tmp/example.pdf', name: 'example.pdf', size: 1024 }],
    analysisResults: [
      {
        path: '/tmp/example.pdf',
        name: 'example.pdf',
        analysis: {
          category: 'Documents',
          suggestedName: 'example-renamed.pdf',
          confidence: 0.92
        }
      }
    ],
    isAnalyzing: false,
    analysisProgress: { current: 0, total: 0, lastActivity: Date.now() },
    currentAnalysisFile: null,
    fileStates: {},
    namingConvention: 'descriptive',
    dateFormat: 'YYYY-MM-DD',
    caseConvention: 'title',
    separator: '-',
    namingSettings: {},
    setSelectedFiles: jest.fn(),
    setAnalysisResults: jest.fn(),
    setIsAnalyzing: jest.fn(),
    setAnalysisProgress: jest.fn(),
    setCurrentAnalysisFile: jest.fn(),
    setNamingConvention: jest.fn(),
    setDateFormat: jest.fn(),
    setCaseConvention: jest.fn(),
    setSeparator: jest.fn(),
    setFileStates: jest.fn(),
    updateFileState: jest.fn(),
    resetAnalysisState: mockResetAnalysisState,
    actions: {
      setPhaseData: jest.fn(),
      advancePhase: jest.fn()
    },
    readySelectedFilesCount: 1,
    fileStats: { total: 1, ready: 1, failed: 0, pending: 0 },
    getCurrentPhase: jest.fn(() => 'discover'),
    organizedFiles: [],
    organizedPathIndex: []
  })),
  useAnalysis: jest.fn(() => ({
    analyzeFiles: mockAnalyzeFiles,
    cancelAnalysis: mockCancelAnalysis,
    clearAnalysisQueue: mockClearAnalysisQueue,
    retryFailedFiles: mockRetryFailedFiles
  })),
  useFileHandlers: jest.fn(() => ({
    isScanning: false,
    handleFileSelection: mockHandleFileSelection,
    handleFolderSelection: mockHandleFolderSelection,
    handleFileDrop: mockHandleFileDrop
  })),
  useFileActions: jest.fn(() => ({
    handleFileAction: mockHandleFileAction
  })),
  getFileStateDisplayInfo: jest.fn(() => ({
    label: 'Ready',
    icon: null,
    color: 'text-green-500',
    spinning: false
  }))
}));

jest.mock('lucide-react', () => ({
  AlertTriangle: () => <span />,
  X: () => <span />,
  Sparkles: () => <span />,
  RefreshCw: () => <span />,
  Network: () => <span />,
  FolderOpen: () => <span />,
  Settings: () => <span />,
  ShieldCheck: () => <span />,
  WandSparkles: () => <span />
}));

import DiscoverPhase from '../../src/renderer/phases/DiscoverPhase';

describe('DiscoverPhase premium guidance', () => {
  afterEach(() => {
    jest.clearAllMocks();
    const { useAppSelector } = require('../../src/renderer/store/hooks');
    useAppSelector.mockImplementation((selector) =>
      selector({ license: { snapshot: { state: 'free' } } })
    );
  });

  test('renders premium guidance and review-first results framing', () => {
    render(<DiscoverPhase />);

    expect(screen.getByText(/Step 3 of 5/i)).toBeInTheDocument();
    expect(screen.getByText(/Files ready for review/i)).toBeInTheDocument();
  });

  test('allows the top guidance card to be minimized', () => {
    render(<DiscoverPhase />);

    expect(screen.getByText(/Build a clean review queue/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /minimize .*guide/i }));

    expect(screen.queryByText(/Build a clean review queue/i)).not.toBeInTheDocument();
    expect(screen.getByText(/1 file ready to review/i)).toBeInTheDocument();
  });

  // Regression: after analysis, successful results must not keep the sticky
  // queue bar stuck on "waiting for analysis" just because fileStates is empty
  // or still lists the path as pending/ready for re-run.
  test('does not show waiting-for-analysis when review results are already prepared', () => {
    render(<DiscoverPhase />);

    expect(screen.getByText(/Review queue ready/i)).toBeInTheDocument();
    expect(screen.getByText(/1 prepared/i)).toBeInTheDocument();
    expect(screen.queryByText(/waiting for analysis/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Analyze \d+ file/i })).not.toBeInTheDocument();
  });

  // The dashboard surface can't run the drop pipeline itself (it isn't mounted
  // alongside DiscoverPhase), so it forwards dropped files through a window
  // CustomEvent. This proves DiscoverPhase honors that bridge the same way it
  // already honors app:select-files / app:select-folder.
  test('forwards window app:drop-files bridge events into the file-drop handler', () => {
    render(<DiscoverPhase />);

    const files = [{ path: '/tmp/dropped.pdf', name: 'dropped.pdf', type: 'file' }];
    act(() => {
      window.dispatchEvent(new CustomEvent('app:drop-files', { detail: files }));
    });

    expect(mockHandleFileDrop).toHaveBeenCalledWith(files);
  });

  // The dashboard's "Add files" / "Import folder" controls and the File menu both
  // reach the real OS pickers through these two window events, so the bridge that
  // forwards them must stay wired alongside app:drop-files.
  test('forwards window app:select-files bridge events into the file-selection handler', () => {
    render(<DiscoverPhase />);

    act(() => {
      window.dispatchEvent(new CustomEvent('app:select-files'));
    });

    expect(mockHandleFileSelection).toHaveBeenCalled();
  });

  test('forwards window app:select-folder bridge events into the folder-selection handler', () => {
    render(<DiscoverPhase />);

    act(() => {
      window.dispatchEvent(new CustomEvent('app:select-folder'));
    });

    expect(mockHandleFolderSelection).toHaveBeenCalled();
  });

  // The public release has no trial gate. Analyze must stay live even when
  // the store still holds a snapshot from a trial build.
  test('Analyze stays enabled whatever the license snapshot says', () => {
    const { useDiscoverState } = require('../../src/renderer/phases/discover');
    const { useAppSelector } = require('../../src/renderer/store/hooks');
    const defaults = useDiscoverState();
    const pendingFile = { path: '/tmp/pending.pdf', name: 'pending.pdf', size: 100 };

    useAppSelector.mockImplementation((selector) =>
      selector({ license: { snapshot: { state: 'trial_expired', daysLeft: 0 } } })
    );
    useDiscoverState.mockReturnValueOnce({
      ...defaults,
      selectedFiles: [pendingFile],
      analysisResults: [],
      fileStates: { '/tmp/pending.pdf': { state: 'pending' } },
      fileStats: { total: 1, ready: 0, failed: 0, pending: 1 }
    });

    render(<DiscoverPhase />);

    const analyze = screen.getByRole('button', { name: /Analyze 1 file/i });
    expect(analyze).toBeEnabled();
    expect(analyze.getAttribute('title') || '').not.toMatch(/license|trial/i);
  });
});
