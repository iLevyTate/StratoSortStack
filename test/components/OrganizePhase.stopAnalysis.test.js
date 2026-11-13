/**
 * @jest-environment jsdom
 *
 * Analysis of a large batch can run for hours after the user moves on to
 * Organize. Organize shows the progress and a Stop analysis button, the same
 * control Discover has, so the user does not have to go back to stop it.
 * Mocks mirror OrganizePhase.test.js.
 */
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockAddNotification = jest.fn();
const mockCancelAnalysis = jest.fn();
let mockIsAnalyzing = false;
let mockAnalysisProgress = { current: 0, total: 0 };

jest.mock('../../src/renderer/contexts/NotificationContext', () => ({
  useNotification: jest.fn(() => ({ addNotification: mockAddNotification }))
}));

jest.mock('../../src/renderer/phases/discover/AnalysisRunProvider', () => ({
  useAnalysisRun: () => ({ reanalyzeFiles: jest.fn(), cancelAnalysis: mockCancelAnalysis })
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
  ),
  selectLastOrganizeRunFiles: jest.fn((state) => state?.files?.lastOrganizeRunFiles || [])
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
    isAnalyzing: mockIsAnalyzing,
    analysisProgress: mockAnalysisProgress,
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

describe('OrganizePhase Stop analysis', () => {
  afterEach(() => {
    jest.clearAllMocks();
    mockIsAnalyzing = false;
    mockAnalysisProgress = { current: 0, total: 0 };
  });

  test('shows the background progress and a Stop analysis button that cancels it', () => {
    mockIsAnalyzing = true;
    mockAnalysisProgress = { current: 26, total: 39 };
    render(<OrganizePhase />);

    expect(screen.getByRole('status')).toHaveTextContent(
      'Analyzing in the background: 26 of 39 files'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop analysis' }));
    expect(mockCancelAnalysis).toHaveBeenCalledTimes(1);
  });

  test('hides Stop analysis when no analysis runs', () => {
    render(<OrganizePhase />);

    expect(screen.queryByRole('button', { name: 'Stop analysis' })).toBeNull();
    expect(screen.queryByText(/Analyzing in the background/)).toBeNull();
  });
});
