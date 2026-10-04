import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const mockReactWindowList = jest.fn(({ rowCount, rowComponent: Row, rowProps = {}, style }) => (
  <div data-testid="react-window-list" style={style}>
    {Array.from({ length: rowCount }).map((_, index) => (
      <Row key={index} index={index} style={{}} {...rowProps} />
    ))}
  </div>
));

const mockFetchAnalysisHistoryPages = jest.fn();
const mockAddNotification = jest.fn();
const mockOpenFile = jest.fn();
const mockRevealFile = jest.fn();

jest.mock('react-window', () => ({
  __esModule: true,
  List: (props) => mockReactWindowList(props)
}));

jest.mock('react-redux', () => ({
  useSelector: jest.fn((selector) =>
    selector({
      system: { redactPaths: false, redactPathsLoaded: true }
    })
  )
}));

jest.mock('lucide-react', () => ({
  TrendingUp: () => <span>TrendingUp</span>,
  ClipboardList: () => <span>ClipboardList</span>,
  Download: () => <span>Download</span>,
  Folder: () => <span>Folder</span>,
  RefreshCw: () => <span>RefreshCw</span>,
  FileText: () => <span>FileText</span>,
  FolderInput: () => <span>FolderInput</span>,
  Trash2: () => <span>Trash2</span>,
  Check: () => <span>Check</span>,
  CheckCircle: () => <span>CheckCircle</span>,
  XCircle: () => <span>XCircle</span>,
  // Phase 1 added collapsible tier sections to DuplicateResolutionModal.
  ChevronDown: () => <span>ChevronDown</span>,
  ChevronRight: () => <span>ChevronRight</span>
}));

jest.mock('../../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  })
}));

jest.mock('../../src/renderer/components/ui/Modal', () => ({
  __esModule: true,
  default: ({ children, isOpen = true, title, footer }) =>
    isOpen ? (
      <div data-testid="modal">
        <div>{title}</div>
        {children}
        {footer}
      </div>
    ) : null,
  ConfirmModal: ({ isOpen = false }) =>
    isOpen ? <div data-testid="confirm-modal">Confirm Modal</div> : null
}));

jest.mock('../../src/renderer/components/ui/Button', () => ({
  __esModule: true,
  default: ({ children, onClick, leftIcon, rightIcon, variant, size, isLoading, ...props }) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  )
}));

jest.mock('../../src/renderer/components/ui/Card', () => ({
  __esModule: true,
  default: ({ children, ...props }) => <div {...props}>{children}</div>
}));

jest.mock('../../src/renderer/components/ui/FileIcon', () => ({
  __esModule: true,
  default: ({ filename }) => <span>{filename}</span>
}));

jest.mock('../../src/renderer/components/ui', () => ({
  __esModule: true,
  Button: ({ children, onClick, leftIcon, rightIcon, variant, size, isLoading, ...props }) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
  Card: ({ children, ...props }) => <div {...props}>{children}</div>,
  StateMessage: ({ title, description, contentClassName, ...props }) => (
    <div data-testid="state-message" {...props}>
      {title}
      {description}
    </div>
  ),
  StatusBadge: ({ children, variant, ...props }) => <div {...props}>{children}</div>
}));

jest.mock('../../src/renderer/components/ui/Typography', () => ({
  __esModule: true,
  Heading: ({ children, as: Component = 'div', variant, ...props }) => (
    <Component {...props}>{children}</Component>
  ),
  Text: ({ children, as: Component = 'div', variant, ...props }) => (
    <Component {...props}>{children}</Component>
  )
}));

jest.mock('../../src/renderer/components/layout', () => ({
  __esModule: true,
  Inline: ({ children, ...props }) => <div {...props}>{children}</div>,
  Stack: ({ children, ...props }) => <div {...props}>{children}</div>
}));

jest.mock('../../src/renderer/components/ErrorBoundary', () => ({
  __esModule: true,
  ErrorBoundaryCore: ({ children }) => <>{children}</>
}));

jest.mock('../../src/renderer/contexts/NotificationContext', () => ({
  __esModule: true,
  useNotification: () => ({
    addNotification: mockAddNotification
  })
}));

jest.mock('../../src/renderer/hooks/useFileActions', () => ({
  __esModule: true,
  useFileActions: () => ({
    openFile: mockOpenFile,
    revealFile: mockRevealFile
  })
}));

jest.mock('../../src/renderer/utils/analysisHistoryFetch', () => ({
  __esModule: true,
  fetchAnalysisHistoryPages: (...args) => mockFetchAnalysisHistoryPages(...args)
}));

jest.mock('../../src/renderer/utils/requestGuard', () => ({
  __esModule: true,
  nextRequestId: () => 1,
  isCurrentRequest: () => true
}));

beforeAll(() => {
  Object.defineProperty(window, 'electronAPI', {
    value: {
      analysisHistory: {
        getStatistics: jest.fn(),
        export: jest.fn(),
        clear: jest.fn()
      },
      files: {
        selectDirectory: jest.fn()
      }
    },
    configurable: true
  });
});

beforeEach(() => {
  mockReactWindowList.mockClear();
  mockFetchAnalysisHistoryPages.mockReset();
  mockAddNotification.mockReset();
  mockOpenFile.mockReset();
  mockRevealFile.mockReset();
  window.electronAPI.analysisHistory.getStatistics.mockResolvedValue({
    totalFiles: 1,
    averageConfidence: 92,
    categoriesCount: 1,
    averageProcessingTime: 125
  });
  window.electronAPI.analysisHistory.export.mockResolvedValue({ success: true });
  window.electronAPI.analysisHistory.clear.mockResolvedValue({ success: true });
  window.electronAPI.files.selectDirectory.mockResolvedValue({
    success: true,
    path: '/organized'
  });

  window.ResizeObserver = jest.fn().mockImplementation(() => ({
    observe: jest.fn(),
    unobserve: jest.fn(),
    disconnect: jest.fn()
  }));
});

afterEach(() => {
  delete window.ResizeObserver;
});

import AnalysisHistoryModal from '../../src/renderer/components/AnalysisHistoryModal';
import TriageModal from '../../src/renderer/components/organize/TriageModal';
import DuplicateResolutionModal from '../../src/renderer/components/organize/DuplicateResolutionModal';

describe('Modal virtualization compatibility', () => {
  test('AnalysisHistoryModal renders history rows through react-window v2 List', async () => {
    mockFetchAnalysisHistoryPages.mockResolvedValue([
      {
        id: 'history-1',
        fileName: 'report.pdf',
        timestamp: '2026-03-11T12:00:00.000Z',
        keywords: ['finance'],
        analysis: { confidence: 91 }
      }
    ]);

    render(
      <AnalysisHistoryModal
        onClose={jest.fn()}
        analysisStats={{ totalFiles: 1 }}
        setAnalysisStats={jest.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /History/i }));

    await waitFor(() => {
      expect(screen.getByText('report.pdf')).toBeInTheDocument();
      const listProps = mockReactWindowList.mock.calls.at(-1)?.[0];
      expect(listProps).toEqual(
        expect.objectContaining({
          rowCount: 1,
          rowComponent: expect.anything(),
          rowProps: expect.any(Object)
        })
      );
    });
  });

  test('TriageModal renders file rows through react-window v2 List', async () => {
    render(
      <TriageModal
        isOpen={true}
        onClose={jest.fn()}
        files={[{ path: '/downloads/invoice.pdf', name: 'invoice.pdf' }]}
        onMoveFiles={jest.fn().mockResolvedValue(undefined)}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByText('invoice.pdf').length).toBeGreaterThan(0);
      const listProps = mockReactWindowList.mock.calls.at(-1)?.[0];
      expect(listProps).toEqual(
        expect.objectContaining({
          rowCount: 1,
          rowComponent: expect.anything(),
          rowProps: expect.any(Object)
        })
      );
    });
  });

  test('TriageModal per-row selection checkbox has an accessible name', async () => {
    render(
      <TriageModal
        isOpen={true}
        onClose={jest.fn()}
        files={[{ path: '/downloads/invoice.pdf', name: 'invoice.pdf' }]}
        onMoveFiles={jest.fn().mockResolvedValue(undefined)}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: /Select invoice\.pdf/i })).toBeInTheDocument();
    });
  });

  test('DuplicateResolutionModal renders duplicate groups through react-window v2 List', async () => {
    render(
      <DuplicateResolutionModal
        isOpen={true}
        onClose={jest.fn()}
        duplicateGroups={[
          {
            members: [
              { path: '/docs/keep.pdf', name: 'keep.pdf', size: 1024 },
              { path: '/docs/delete.pdf', name: 'delete.pdf', size: 1024 }
            ],
            averageSimilarity: 0.98
          }
        ]}
        onResolve={jest.fn().mockResolvedValue(undefined)}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/Duplicate Set 1/i)).toBeInTheDocument();
      expect(screen.getAllByText('keep.pdf').length).toBeGreaterThan(0);
      const listProps = mockReactWindowList.mock.calls.at(-1)?.[0];
      expect(listProps).toEqual(
        expect.objectContaining({
          rowCount: 1,
          rowComponent: expect.anything(),
          rowProps: expect.any(Object)
        })
      );
    });
  });
});
