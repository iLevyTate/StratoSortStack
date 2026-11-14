/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockAddNotification = jest.fn();

jest.mock('../../src/renderer/contexts/NotificationContext', () => ({
  useNotification: jest.fn(() => ({ addNotification: mockAddNotification }))
}));

jest.mock('../../src/renderer/phases/discover/AnalysisRunProvider', () => ({
  useAnalysisRun: () => ({ reanalyzeFiles: jest.fn() })
}));

jest.mock('../../src/renderer/components/UndoRedoSystem', () => ({
  UndoRedoToolbar: () => <div>UNDO_REDO</div>,
  useUndoRedo: jest.fn(() => ({ executeAction: jest.fn() }))
}));

// Organized history in the store (files.organizedFiles), which survives the
// queue being cleared.
let mockOrganizedHistory = [];
// files.lastOrganizeRunFiles and the queue (files.selectedFiles).
let mockLastRunFiles = [];
let mockQueue = [];

jest.mock('../../src/renderer/store/hooks', () => ({
  useAppDispatch: jest.fn(() => jest.fn()),
  useAppSelector: jest.fn((selector) =>
    selector({
      ui: { currentPhase: 'organize', organizeFocusRequest: null },
      files: {
        organizedFiles: mockOrganizedHistory,
        lastOrganizeRunFiles: mockLastRunFiles,
        selectedFiles: mockQueue
      }
    })
  )
}));

jest.mock('../../src/renderer/store/selectors', () => ({
  selectRedactPaths: jest.fn(() => false),
  selectOrganizedCount: jest.fn((state) =>
    Array.isArray(state?.files?.organizedFiles) ? state.files.organizedFiles.length : 0
  )
}));

jest.mock('../../src/renderer/store/slices/filesSlice', () => ({
  setFileStates: jest.fn()
}));

jest.mock('../../src/renderer/hooks/useLastOrganizeRun', () => ({
  useLastOrganizeRun: jest.fn(() => ({
    lastOrganizeRun: null,
    finishedWhileOpen: false,
    setLastOrganizeRun: jest.fn(),
    dismissLastOrganizeRun: jest.fn()
  }))
}));

jest.mock('../../src/renderer/store/slices/analysisSlice', () => ({
  updateAnalysisResult: jest.fn(),
  updateAnalysisResultsByPaths: jest.fn()
}));

jest.mock('../../src/renderer/components/ui', () => ({
  Button: ({ children, className, disabled, title, type, onClick, 'aria-label': ariaLabel }) => (
    <button
      className={className}
      disabled={disabled}
      title={title}
      type={type}
      onClick={onClick}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  ),
  Card: ({ children, className }) => <div className={className}>{children}</div>,
  SidePanel: ({ isOpen, children }) => (isOpen ? <div>{children}</div> : null),
  StateMessage: ({ title, description, action }) => (
    <div>
      <div>{title}</div>
      <div>{description}</div>
      {action}
    </div>
  ),
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
  Heading: ({ children, className }) => <h1 className={className}>{children}</h1>,
  Text: ({ children, className }) => <span className={className}>{children}</span>
}));

jest.mock('../../src/renderer/components/ErrorBoundary', () => ({
  ErrorBoundaryCore: ({ children }) => <div>{children}</div>
}));

jest.mock('../../src/renderer/components/layout', () => ({
  ActionBar: ({ children }) => <div>{children}</div>,
  Inline: ({ children, className }) => <div className={className}>{children}</div>,
  Stack: ({ children, className }) => <div className={className}>{children}</div>
}));

jest.mock('../../src/renderer/components/organize', () => ({
  StatusOverview: () => <div>STATUS_OVERVIEW</div>,
  TargetFolderList: () => <div>TARGET_FOLDER_LIST</div>,
  BulkOperations: () => <div>BULK_OPERATIONS</div>,
  OrganizeProgress: () => <div>ORGANIZE_PROGRESS</div>,
  OrganizeSummaryBanner: ({ summary, onDismiss, announce, action }) => (
    <div>
      <button type="button" onClick={onDismiss} data-announce={String(announce)}>
        SUMMARY_BANNER:{summary.outcome}
      </button>
      <span>{summary.detail}</span>
      {action && (
        <button type="button" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  ),
  InPlaceMoveNotice: ({ moves }) =>
    moves?.length ? <div>IN_PLACE_NOTICE:{moves.length}</div> : null,
  VirtualizedFileGrid: () => <div>FILE_GRID</div>,
  VirtualizedProcessedFiles: () => <div>PROCESSED_FILES</div>,
  RunResultsList: jest.requireActual('../../src/renderer/components/organize/RunResultsList')
    .default,
  UncategorizedActionsBar: () => <div>UNCATEGORIZED_ACTIONS_BAR</div>
}));

jest.mock('../../src/renderer/components/ui/Modal', () => ({
  __esModule: true,
  default: ({ isOpen, children }) => (isOpen ? <div>{children}</div> : null)
}));

jest.mock('../../src/renderer/components/organize/OrganizePreviewModal', () => ({
  __esModule: true,
  default: ({ isOpen, plan }) => (isOpen ? <div>PREVIEW_MODAL:{plan.wouldMove.length}</div> : null)
}));

jest.mock('../../src/renderer/components/AnalysisDetails', () => ({
  __esModule: true,
  default: () => <div>ANALYSIS_DETAILS</div>
}));

jest.mock('../../src/renderer/phases/organize/useOrganizeState', () => ({
  useOrganizeState: jest.fn(() => ({
    organizedFiles: [],
    filesWithAnalysis: [
      {
        path: '/tmp/invoice.pdf',
        name: 'invoice.pdf',
        analysis: { category: 'Finance', suggestedName: '2026-01-Invoice.pdf' }
      },
      {
        path: '/tmp/notes.txt',
        name: 'notes.txt',
        analysis: { category: 'Notes', suggestedName: 'Project Notes.txt' }
      }
    ],
    analysisResults: [],
    isAnalyzing: false,
    analysisProgress: { current: 0, total: 0 },
    smartFolders: [{ id: '1', name: 'Finance', path: '/dest/finance' }],
    fileStates: {},
    defaultLocation: '/dest',
    failedCount: 0,
    smartFoldersRef: { current: [] },
    dispatchRef: { current: jest.fn() },
    dispatch: jest.fn(),
    setOrganizedFiles: jest.fn(),
    addOrganizedFiles: jest.fn(),
    removeOrganizedFiles: jest.fn(),
    setOrganizingState: jest.fn(),
    phaseData: {},
    actions: {
      advancePhase: jest.fn()
    }
  })),
  useLoadInitialData: jest.fn()
}));

jest.mock('../../src/renderer/phases/organize/useSmartFolderMatcher', () => ({
  useSmartFolderMatcher: jest.fn(() => jest.fn(() => ({ name: 'Finance', path: '/dest/finance' }))),
  useSmartFolderMatcherForFile: jest.fn(() => jest.fn(() => null))
}));

jest.mock('../../src/renderer/phases/organize/useFileEditing', () => ({
  useFileStateDisplay: jest.fn(() => ({
    getFileStateDisplay: jest.fn(() => ({
      label: 'Ready',
      icon: null,
      color: 'text-green-500',
      spinning: false
    }))
  })),
  useFileEditing: jest.fn(() => ({
    editingFiles: {},
    setEditingFiles: jest.fn(),
    handleEditFile: jest.fn(),
    getFileWithEdits: (file) => file
  })),
  useFileSelection: jest.fn(() => ({
    selectedFiles: new Set(),
    setSelectedFiles: jest.fn(),
    toggleFileSelection: jest.fn(),
    selectAllFiles: jest.fn()
  })),
  useBulkOperations: jest.fn(() => ({
    bulkEditMode: false,
    setBulkEditMode: jest.fn(),
    bulkCategory: '',
    setBulkCategory: jest.fn(),
    applyBulkCategoryChange: jest.fn()
  })),
  useProcessedFiles: jest.fn(() => ({
    setProcessedFileIds: jest.fn(),
    markFilesAsProcessed: jest.fn(),
    unmarkFilesAsProcessed: jest.fn(),
    getFilteredFiles: (files) => ({ unprocessedFiles: files, processedFiles: [] }),
    normalizePath: (value) => value
  }))
}));

jest.mock('../../src/renderer/phases/organize/useOrganization', () => ({
  useOrganization: jest.fn(() => ({
    isOrganizing: false,
    batchProgress: null,
    organizePreview: [],
    handleOrganizeFiles: jest.fn(),
    organizeConflicts: []
  }))
}));

jest.mock('../../src/renderer/utils/pathDisplay', () => ({
  formatDisplayPath: jest.fn((value) => value),
  formatDisplayFileName: jest.fn((value) => value)
}));

jest.mock('lucide-react', () => ({
  FolderOpen: () => <span />,
  BarChart3: () => <span />,
  CheckCircle2: () => <span />,
  Inbox: () => <span />,
  Database: () => <span />,
  FolderInput: () => <span />,
  ScanSearch: () => <span />,
  Lightbulb: () => <span />,
  FolderPlus: () => <span />,
  Cpu: () => <span />,
  PenLine: () => <span />,
  ScrollText: () => <span />,
  ListChecks: () => <span />,
  BadgeCheck: () => <span />,
  Tags: () => <span />,
  SpellCheck: () => <span />,
  Info: () => <span />,
  MousePointerClick: () => <span />,
  Bot: () => <span />,
  AlertTriangle: () => <span />,
  FileText: () => <span />,
  ShieldCheck: () => <span />,
  // RunResultsList's icons.
  AlertCircle: () => <span />,
  Check: () => <span />,
  Clock: () => <span />,
  Copy: () => <span />,
  Download: () => <span />,
  Undo2: () => <span />
}));

import OrganizePhase from '../../src/renderer/phases/OrganizePhase';

describe('OrganizePhase premium preflight copy', () => {
  afterEach(() => {
    jest.clearAllMocks();
    mockOrganizedHistory = [];
  });

  // The Complete tab opens on the organized history (selectOrganizedCount);
  // View results reads the same count, so a returning user whose queue was
  // cleared can still open Complete from here.
  test('View results opens on organized history, like the Complete tab', () => {
    mockOrganizedHistory = [{ originalPath: '/old/a.pdf', path: '/dest/a.pdf' }];
    render(<OrganizePhase />);

    const viewResults = screen.getByRole('button', { name: /View results/i });
    expect(viewResults).not.toBeDisabled();
  });

  test('with no organized history View results says why, in the Complete tab words', () => {
    const { PHASE_PREREQUISITE_REASONS } = require('../../src/renderer/store/slices/uiSlice');
    render(<OrganizePhase />);

    const viewResults = screen.getByRole('button', { name: /View results/i });
    expect(viewResults).toBeDisabled();
    expect(viewResults).toHaveAttribute('title', PHASE_PREREQUISITE_REASONS.needsProcessedFile);
  });

  test('renders premium review guidance and move-focused CTA copy', () => {
    render(<OrganizePhase />);

    expect(screen.getByText(/Step 4 of 5/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Review queue/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Move 2 files/i)).toBeInTheDocument();
  });

  test('allows the top review card to be minimized', () => {
    render(<OrganizePhase />);

    expect(screen.getByText(/Approve the move plan with confidence/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /minimize .*guide/i }));

    expect(screen.queryByText(/Approve the move plan with confidence/i)).not.toBeInTheDocument();
    expect(screen.getByText(/2 files ready for review/i)).toBeInTheDocument();
  });

  test('keeps organize progress mounted after organize completes (SW-78)', async () => {
    const { useOrganization } = require('../../src/renderer/phases/organize/useOrganization');
    useOrganization.mockReturnValue({
      isOrganizing: true,
      isPaused: false,
      batchProgress: { current: 2, total: 2, currentFile: '/tmp/invoice.pdf' },
      organizePreview: [],
      handleOrganizeFiles: jest.fn(),
      organizeConflicts: []
    });

    const { rerender } = render(<OrganizePhase />);
    expect(screen.getByText('ORGANIZE_PROGRESS')).toBeInTheDocument();

    useOrganization.mockReturnValue({
      isOrganizing: false,
      isPaused: false,
      batchProgress: { current: 2, total: 2, currentFile: '/tmp/invoice.pdf' },
      organizePreview: [],
      handleOrganizeFiles: jest.fn(),
      organizeConflicts: []
    });
    rerender(<OrganizePhase />);

    expect(await screen.findByText('ORGANIZE_PROGRESS')).toBeInTheDocument();
  });

  test('a destination conflict names the files by their own names, not the shared new one', () => {
    const { useOrganization } = require('../../src/renderer/phases/organize/useOrganization');
    useOrganization.mockReturnValue({
      isOrganizing: false,
      isPaused: false,
      batchProgress: null,
      organizePreview: [],
      handleOrganizeFiles: jest.fn(),
      organizeConflicts: [
        {
          destination: '/Users/alex/Exports/search-performance-2026-09-03.xlsx',
          files: [
            {
              fileName: 'search-performance-2026-09-03.xlsx',
              sourcePath: '/Users/alex/Inbox/export (1).xlsx'
            },
            {
              fileName: 'search-performance-2026-09-03.xlsx',
              sourcePath: '/Users/alex/Inbox/export (2).xlsx'
            }
          ]
        }
      ]
    });

    render(<OrganizePhase />);

    expect(screen.getByText('export (1).xlsx, export (2).xlsx')).toBeInTheDocument();
    expect(
      screen.queryByText(/search-performance-2026-09-03\.xlsx, search-performance/)
    ).not.toBeInTheDocument();
    useOrganization.mockReturnValue({
      isOrganizing: false,
      batchProgress: null,
      organizePreview: [],
      handleOrganizeFiles: jest.fn(),
      organizeConflicts: []
    });
  });

  test('shows how the last run ended, and lets the user dismiss it', () => {
    const { useLastOrganizeRun } = require('../../src/renderer/hooks/useLastOrganizeRun');
    const { useOrganization } = require('../../src/renderer/phases/organize/useOrganization');
    const setLastOrganizeRun = jest.fn();
    const dismissLastOrganizeRun = jest.fn();
    const hookValue = {
      lastOrganizeRun: null,
      finishedWhileOpen: false,
      setLastOrganizeRun,
      dismissLastOrganizeRun
    };
    useLastOrganizeRun.mockReturnValue(hookValue);

    const { rerender } = render(<OrganizePhase />);
    expect(screen.queryByText(/SUMMARY_BANNER/)).not.toBeInTheDocument();
    // The run reports its outcome through the same store field the banner reads.
    expect(useOrganization.mock.calls.at(-1)[0].setLastOrganizeRun).toBe(setLastOrganizeRun);

    useLastOrganizeRun.mockReturnValue({
      ...hookValue,
      lastOrganizeRun: {
        outcome: 'partial',
        count: 1,
        headline: 'Moved 1 file; 1 could not be moved',
        detail: 'EEXIST: destination exists',
        finishedAt: 1
      }
    });
    rerender(<OrganizePhase />);

    fireEvent.click(screen.getByText('SUMMARY_BANNER:partial'));
    expect(dismissLastOrganizeRun).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['a run that finished on this screen is announced', true],
    ['a run that was over when the screen opened is not announced again', false]
  ])('%s', (_label, finishedWhileOpen) => {
    const { useLastOrganizeRun } = require('../../src/renderer/hooks/useLastOrganizeRun');
    useLastOrganizeRun.mockReturnValue({
      lastOrganizeRun: {
        outcome: 'none',
        count: 0,
        headline: 'No files were organized',
        detail: 'EACCES: permission denied',
        finishedAt: 1
      },
      finishedWhileOpen,
      setLastOrganizeRun: jest.fn(),
      dismissLastOrganizeRun: jest.fn()
    });

    render(<OrganizePhase />);

    expect(screen.getByText('SUMMARY_BANNER:none')).toHaveAttribute(
      'data-announce',
      String(finishedWhileOpen)
    );
  });

  test('says which files stay in their folder, but not while a run is under way', () => {
    const { useOrganization } = require('../../src/renderer/phases/organize/useOrganization');
    const hookValue = {
      isOrganizing: false,
      isPaused: false,
      batchProgress: null,
      organizePreview: [],
      handleOrganizeFiles: jest.fn(),
      organizeConflicts: [],
      inPlaceMoves: [
        { sourcePath: '/in/a.csv', fileName: 'a.csv', folderName: 'Strato Input', renamed: false }
      ]
    };
    useOrganization.mockReturnValue(hookValue);

    const { rerender } = render(<OrganizePhase />);
    expect(screen.getByText('IN_PLACE_NOTICE:1')).toBeInTheDocument();

    useOrganization.mockReturnValue({ ...hookValue, isOrganizing: true });
    rerender(<OrganizePhase />);
    expect(screen.queryByText(/IN_PLACE_NOTICE/)).not.toBeInTheDocument();

    useOrganization.mockReturnValue({ ...hookValue, isPaused: true });
    rerender(<OrganizePhase />);
    expect(screen.queryByText(/IN_PLACE_NOTICE/)).not.toBeInTheDocument();

    useOrganization.mockReturnValue({ ...hookValue, inPlaceMoves: [] });
    rerender(<OrganizePhase />);
    expect(screen.queryByText(/IN_PLACE_NOTICE/)).not.toBeInTheDocument();
  });

  test('keeps edits for files hidden only while their move is in flight (L11)', () => {
    const { useOrganization } = require('../../src/renderer/phases/organize/useOrganization');
    const { useFileEditing } = require('../../src/renderer/phases/organize/useFileEditing');
    useOrganization.mockReturnValue({
      isOrganizing: true,
      isPaused: false,
      batchProgress: { current: 0, total: 1, currentFile: '/tmp/invoice.pdf' },
      organizePreview: [{ sourcePath: '/tmp/invoice.pdf' }],
      handleOrganizeFiles: jest.fn(),
      organizeConflicts: []
    });
    const editingFiles = {
      '/tmp/invoice.pdf': { category: 'Receipts' },
      '/tmp/gone.txt': { category: 'Stale' }
    };
    const setEditingFiles = jest.fn();
    useFileEditing.mockReturnValue({
      editingFiles,
      setEditingFiles,
      handleEditFile: jest.fn(),
      getFileWithEdits: (file) => file
    });

    render(<OrganizePhase />);

    const pruned = setEditingFiles.mock.calls
      .map(([updater]) => (typeof updater === 'function' ? updater(editingFiles) : updater))
      .pop();
    expect(pruned).toEqual({ '/tmp/invoice.pdf': { category: 'Receipts' } });
  });
});

describe('OrganizePhase Preview button', () => {
  const PLAN = {
    success: true,
    dryRun: true,
    wouldMove: [{ source: '/tmp/invoice.pdf', destination: '/dest/finance/invoice.pdf' }],
    skipped: [],
    wouldCreateFolders: [],
    sameDestination: []
  };

  const renderWithPreview = (handlePreviewOrganize) => {
    const { useOrganization } = require('../../src/renderer/phases/organize/useOrganization');
    useOrganization.mockReturnValue({
      isOrganizing: false,
      batchProgress: null,
      organizePreview: [],
      handleOrganizeFiles: jest.fn(),
      handlePreviewOrganize,
      organizeConflicts: []
    });
    render(<OrganizePhase />);
    return screen.getByRole('button', { name: 'Preview' });
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('opens the plan for every file in the queue', async () => {
    const handlePreviewOrganize = jest.fn().mockResolvedValue(PLAN);
    fireEvent.click(renderWithPreview(handlePreviewOrganize));

    expect(await screen.findByText('PREVIEW_MODAL:1')).toBeInTheDocument();
    expect(handlePreviewOrganize.mock.calls[0][0].map((f) => f.path)).toEqual([
      '/tmp/invoice.pdf',
      '/tmp/notes.txt'
    ]);
    expect(mockAddNotification).not.toHaveBeenCalled();
  });

  // A large queue takes a moment to check on disk. Pressing again must not
  // start a second request.
  test('a second press while the plan is being built does not ask again', async () => {
    let finish;
    const handlePreviewOrganize = jest.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const preview = renderWithPreview(handlePreviewOrganize);

    fireEvent.click(preview);
    fireEvent.click(preview);
    expect(handlePreviewOrganize).toHaveBeenCalledTimes(1);

    await act(async () => finish(PLAN));
    expect(screen.getByText('PREVIEW_MODAL:1')).toBeInTheDocument();

    // Once the first request has finished, the button works again.
    fireEvent.click(preview);
    expect(handlePreviewOrganize).toHaveBeenCalledTimes(2);
    await act(async () => finish(PLAN));
  });

  test('says why when the plan could not be built, and opens nothing', async () => {
    const handlePreviewOrganize = jest
      .fn()
      .mockRejectedValue(new Error('Batch size exceeds maximum of 1000'));
    fireEvent.click(renderWithPreview(handlePreviewOrganize));

    await waitFor(() =>
      expect(mockAddNotification).toHaveBeenCalledWith(
        'The preview could not be built: Batch size exceeds maximum of 1000',
        'error',
        8000,
        'organize-preview'
      )
    );
    expect(screen.queryByText(/PREVIEW_MODAL/)).not.toBeInTheDocument();
  });

  test('says so when no file has a destination to preview', async () => {
    const handlePreviewOrganize = jest.fn().mockResolvedValue(null);
    fireEvent.click(renderWithPreview(handlePreviewOrganize));

    await waitFor(() =>
      expect(mockAddNotification).toHaveBeenCalledWith(
        'None of these files has a destination yet, so there is nothing to preview.',
        'info',
        4000,
        'organize-preview'
      )
    );
    expect(screen.queryByText(/PREVIEW_MODAL/)).not.toBeInTheDocument();
  });
});

describe('OrganizePhase and license state (CP-19)', () => {
  // There is no trial gate. A snapshot left over from a trial build must not
  // disable the move CTA.
  test('the Move button stays enabled and moves with a stale trial_expired snapshot', () => {
    const { useAppSelector } = require('../../src/renderer/store/hooks');
    const { useOrganization } = require('../../src/renderer/phases/organize/useOrganization');
    const handleOrganizeFiles = jest.fn();
    useOrganization.mockReturnValueOnce({
      isOrganizing: false,
      batchProgress: null,
      organizePreview: [],
      handleOrganizeFiles,
      organizeConflicts: []
    });
    const previous = useAppSelector.getMockImplementation();
    useAppSelector.mockImplementation((selector) =>
      selector({
        ui: { currentPhase: 'organize', organizeFocusRequest: null },
        license: { snapshot: { state: 'trial_expired', daysLeft: 0 } }
      })
    );
    try {
      render(<OrganizePhase />);
      const move = screen.getByRole('button', { name: /Move 2 files/i });
      expect(move).toBeEnabled();
      fireEvent.click(move);
      expect(handleOrganizeFiles).toHaveBeenCalledTimes(1);
      expect(mockAddNotification).not.toHaveBeenCalledWith(
        expect.stringMatching(/license|trial/i),
        expect.anything(),
        expect.anything(),
        'license-gate'
      );
    } finally {
      useAppSelector.mockImplementation(previous);
    }
  });
});

// Where every file of the last run went (P3c) and the organized history with
// full locations (P3b).
describe('OrganizePhase: every file of the last run', () => {
  const partialRun = {
    outcome: 'partial',
    count: 1,
    headline: 'Moved 1 file; 1 could not be moved',
    detail: 'Access denied. Files that were not moved are still listed.',
    finishedAt: 1
  };
  const runFiles = [
    {
      name: 'gsc.xlsx',
      originalPath: '/in/gsc.xlsx',
      finalPath: '/dest/finance/gsc.xlsx',
      outcome: 'moved',
      reason: ''
    },
    {
      name: 'bing.csv',
      originalPath: '/in/bing.csv',
      finalPath: null,
      outcome: 'failed',
      reason: 'Access denied.'
    }
  ];

  function showRun() {
    const { useLastOrganizeRun } = require('../../src/renderer/hooks/useLastOrganizeRun');
    useLastOrganizeRun.mockReturnValue({
      lastOrganizeRun: partialRun,
      finishedWhileOpen: false,
      setLastOrganizeRun: jest.fn(),
      dismissLastOrganizeRun: jest.fn()
    });
    mockLastRunFiles = runFiles;
  }

  afterEach(() => {
    const { useLastOrganizeRun } = require('../../src/renderer/hooks/useLastOrganizeRun');
    useLastOrganizeRun.mockReturnValue({
      lastOrganizeRun: null,
      finishedWhileOpen: false,
      setLastOrganizeRun: jest.fn(),
      dismissLastOrganizeRun: jest.fn()
    });
    mockLastRunFiles = [];
    mockQueue = [];
    delete window.electronAPI;
  });

  test('"See every file" lists the file that failed, with its reason', () => {
    showRun();
    mockQueue = [{ path: '/in/bing.csv' }];
    render(<OrganizePhase />);

    expect(screen.getByText(partialRun.detail)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'See every file' }));
    expect(screen.getByText('Not moved: Access denied.')).toBeInTheDocument();
    expect(screen.getByText('Still at /in/bing.csv')).toBeInTheDocument();
    expect(screen.getByText('Now at /dest/finance/gsc.xlsx')).toBeInTheDocument();
  });

  test('once the unmoved files leave the queue, the banner says where they are', () => {
    showRun();
    mockQueue = [];
    render(<OrganizePhase />);

    expect(
      screen.getByText(
        'Access denied. The files that were not moved are no longer in the queue. They are still in their original folders.'
      )
    ).toBeInTheDocument();
  });

  test('no "See every file" without a file list', () => {
    showRun();
    mockLastRunFiles = [];
    render(<OrganizePhase />);
    expect(screen.queryByRole('button', { name: 'See every file' })).not.toBeInTheDocument();
  });

  test('the run hands its file list to the store', () => {
    const { useOrganization } = require('../../src/renderer/phases/organize/useOrganization');
    render(<OrganizePhase />);
    expect(typeof useOrganization.mock.calls.at(-1)[0].setLastOrganizeRunFiles).toBe('function');
  });

  test('previously organized files show their full location and can be revealed', () => {
    const { useProcessedFiles } = require('../../src/renderer/phases/organize/useFileEditing');
    const organized = {
      originalPath: '/in/gsc.xlsx',
      originalName: 'gsc.xlsx',
      path: '/dest/finance/GSC 2026.xlsx',
      smartFolder: 'finance'
    };
    mockOrganizedHistory = [organized];
    useProcessedFiles.mockReturnValue({
      setProcessedFileIds: jest.fn(),
      markFilesAsProcessed: jest.fn(),
      unmarkFilesAsProcessed: jest.fn(),
      getFilteredFiles: (files) => ({ unprocessedFiles: files, processedFiles: [organized] }),
      normalizePath: (value) => value
    });
    const reveal = jest.fn().mockResolvedValue({ success: true });
    window.electronAPI = { files: { reveal } };

    render(<OrganizePhase />);
    fireEvent.click(screen.getByRole('button', { name: /View 1 organized files history/i }));

    expect(screen.getByText('Now at /dest/finance/GSC 2026.xlsx')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show gsc.xlsx in its folder' }));
    expect(reveal).toHaveBeenCalledWith('/dest/finance/GSC 2026.xlsx');
  });
});
