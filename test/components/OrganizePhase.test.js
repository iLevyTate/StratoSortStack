/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockAddNotification = jest.fn();

jest.mock('../../src/renderer/contexts/NotificationContext', () => ({
  useNotification: jest.fn(() => ({ addNotification: mockAddNotification }))
}));

jest.mock('../../src/renderer/components/UndoRedoSystem', () => ({
  UndoRedoToolbar: () => <div>UNDO_REDO</div>,
  useUndoRedo: jest.fn(() => ({ executeAction: jest.fn() }))
}));

jest.mock('../../src/renderer/store/hooks', () => ({
  useAppDispatch: jest.fn(() => jest.fn()),
  useAppSelector: jest.fn((selector) =>
    selector({
      ui: { currentPhase: 'organize', organizeFocusRequest: null }
    })
  )
}));

jest.mock('../../src/renderer/store/selectors', () => ({
  selectRedactPaths: jest.fn(() => false)
}));

jest.mock('../../src/renderer/store/slices/filesSlice', () => ({
  setFileStates: jest.fn()
}));

jest.mock('../../src/renderer/store/slices/analysisSlice', () => ({
  updateAnalysisResult: jest.fn()
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
  VirtualizedFileGrid: () => <div>FILE_GRID</div>,
  VirtualizedProcessedFiles: () => <div>PROCESSED_FILES</div>,
  UncategorizedActionsBar: () => <div>UNCATEGORIZED_ACTIONS_BAR</div>
}));

jest.mock('../../src/renderer/components/ui/Modal', () => ({
  __esModule: true,
  default: ({ isOpen, children }) => (isOpen ? <div>{children}</div> : null)
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
  formatDisplayPath: jest.fn((value) => value)
}));

jest.mock('lucide-react', () => ({
  FolderOpen: () => <span />,
  BarChart3: () => <span />,
  CheckCircle2: () => <span />,
  Inbox: () => <span />,
  Sparkles: () => <span />,
  AlertTriangle: () => <span />,
  FileText: () => <span />,
  ShieldCheck: () => <span />
}));

import OrganizePhase from '../../src/renderer/phases/OrganizePhase';

describe('OrganizePhase premium preflight copy', () => {
  afterEach(() => {
    jest.clearAllMocks();
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
