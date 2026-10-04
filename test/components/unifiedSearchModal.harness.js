/**
 * Shared Jest harness for UnifiedSearchModal (mocks + test helpers).
 * Import this module before importing UnifiedSearchModal.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { NotificationProvider } from '../../src/renderer/contexts/NotificationContext';
import { mockUnifiedSearchModalHarnessState } from './unifiedSearchModal.harnessState';

export { mockUnifiedSearchModalHarnessState } from './unifiedSearchModal.harnessState';

/** Populated when the store/hooks mock factory runs. */
export let mockDispatch;

const mockIsGraphViewEnabled = jest.fn(() => true);

jest.mock('../../src/renderer/store/hooks', () => {
  const { GRAPH_INSIGHTS_SECTION_KEYS } = require('../../src/renderer/store/slices/uiSlice');
  const allowedGraphInsightsSections = new Set(GRAPH_INSIGHTS_SECTION_KEYS);

  mockDispatch = jest.fn((action) => {
    if (action?.type === 'ui/setGraphInsightsSection') {
      const v = action.payload;
      if (v == null || v === '') {
        mockUnifiedSearchModalHarnessState.graphInsightsSectionKey = null;
      } else {
        mockUnifiedSearchModalHarnessState.graphInsightsSectionKey =
          allowedGraphInsightsSections.has(v) ? v : 'insights';
      }
    }
    return action;
  });
  return {
    useAppDispatch: jest.fn(() => mockDispatch),
    useAppSelector: jest.fn((selector) =>
      selector({
        ui: {
          settings: {},
          graphInsightsSection:
            mockUnifiedSearchModalHarnessState.graphInsightsSectionKey === undefined
              ? 'insights'
              : mockUnifiedSearchModalHarnessState.graphInsightsSectionKey
        },
        system: { redactPaths: false, redactPathsLoaded: true }
      })
    )
  };
});

jest.mock('../../src/renderer/contexts/NotificationContext', () => ({
  useNotification: () => ({
    showSuccess: jest.fn(),
    showError: jest.fn(),
    showWarning: jest.fn(),
    showInfo: jest.fn(),
    addNotification: jest.fn()
  }),
  NotificationProvider: ({ children }) => <>{children}</>
}));

export const renderWithRedux = (ui, { preloadedState } = {}) => {
  const store = configureStore({
    reducer: {
      system: (state = { redactPaths: false, redactPathsLoaded: true }) => state
    },
    preloadedState
  });

  return {
    store,
    ...render(
      <Provider store={store}>
        <NotificationProvider>{ui}</NotificationProvider>
      </Provider>
    )
  };
};

export const mockScrollToRow = jest.fn();

jest.mock('react-window', () => {
  const ReactWindowReact = require('react');

  return {
    __esModule: true,
    List: ({ listRef, rowCount, rowComponent: Row, rowProps = {}, style, className }) => {
      ReactWindowReact.useEffect(() => {
        const api = {
          scrollToRow: mockScrollToRow,
          get element() {
            return null;
          }
        };

        if (typeof listRef === 'function') {
          listRef(api);
        } else if (listRef && typeof listRef === 'object') {
          listRef.current = api;
        }
      }, [listRef]);

      return (
        <div data-testid="virtualized-list" style={style} className={className}>
          {Array.from({ length: rowCount }).map((_, index) => (
            <Row key={index} index={index} style={{}} {...rowProps} />
          ))}
        </div>
      );
    }
  };
});

jest.mock('@xyflow/react', () => ({
  __esModule: true,
  ReactFlow: ({ children }) => <div data-testid="react-flow">{children}</div>,
  Background: () => <div data-testid="rf-background" />,
  Controls: () => <div data-testid="rf-controls" />,
  MiniMap: () => <div data-testid="rf-minimap" />,
  Panel: ({ children }) => <div data-testid="rf-panel">{children}</div>,
  Handle: () => <div data-testid="rf-handle" />,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  useNodesState: () => [[], jest.fn(), jest.fn()],
  useEdgesState: () => [[], jest.fn(), jest.fn()]
}));

jest.mock('lucide-react', () => ({
  Zap: () => <span data-testid="icon-zap">Zap</span>,
  ExternalLink: () => <span data-testid="icon-external-link">ExternalLink</span>,
  FolderOpen: () => <span data-testid="icon-folder-open">FolderOpen</span>,
  FolderInput: () => <span data-testid="icon-folder-input">FolderInput</span>,
  FolderPlus: () => <span data-testid="icon-folder-plus">FolderPlus</span>,
  RefreshCw: () => <span data-testid="icon-refresh">RefreshCw</span>,
  Search: () => <span data-testid="icon-search">Search</span>,
  Sparkles: () => <span data-testid="icon-sparkles">Sparkles</span>,
  Copy: () => <span data-testid="icon-copy">Copy</span>,
  Network: () => <span data-testid="icon-network">Network</span>,
  Orbit: () => <span data-testid="icon-orbit">Orbit</span>,
  List: () => <span data-testid="icon-list">List</span>,
  HelpCircle: () => <span data-testid="icon-help">HelpCircle</span>,
  Inbox: () => <span data-testid="icon-inbox">Inbox</span>,
  Crosshair: () => <span data-testid="icon-crosshair">Crosshair</span>,
  FileText: () => <span data-testid="icon-file">FileText</span>,
  MessageSquare: () => <span data-testid="icon-message">MessageSquare</span>,
  LayoutGrid: () => <span data-testid="icon-grid">LayoutGrid</span>,
  Layers: () => <span data-testid="icon-layers">Layers</span>,
  GitBranch: () => <span data-testid="icon-branch">GitBranch</span>,
  CheckSquare: () => <span data-testid="icon-check-square">CheckSquare</span>,
  Square: () => <span data-testid="icon-square">Square</span>,
  X: () => <span data-testid="icon-x">X</span>,
  AlertCircle: () => <span data-testid="icon-alert">AlertCircle</span>,
  AlertTriangle: () => <span data-testid="icon-alert-triangle">AlertTriangle</span>,
  Loader2: () => <span data-testid="icon-loader">Loader2</span>,
  ChevronDown: () => <span data-testid="icon-chevron-down">ChevronDown</span>,
  ChevronLeft: () => <span data-testid="icon-chevron-left">ChevronLeft</span>,
  ChevronRight: () => <span data-testid="icon-chevron-right">ChevronRight</span>,
  ChevronUp: () => <span data-testid="icon-chevron-up">ChevronUp</span>,
  Plus: () => <span data-testid="icon-plus">Plus</span>,
  Minus: () => <span data-testid="icon-minus">Minus</span>,
  ZoomIn: () => <span data-testid="icon-zoom-in">ZoomIn</span>,
  ZoomOut: () => <span data-testid="icon-zoom-out">ZoomOut</span>,
  Maximize2: () => <span data-testid="icon-maximize">Maximize2</span>,
  Minimize2: () => <span data-testid="icon-minimize">Minimize2</span>,
  Settings: () => <span data-testid="icon-settings">Settings</span>,
  Trash2: () => <span data-testid="icon-trash">Trash2</span>,
  Move: () => <span data-testid="icon-move">Move</span>,
  Clock: () => <span data-testid="icon-clock">Clock</span>,
  Lightbulb: () => <span data-testid="icon-lightbulb">Lightbulb</span>,
  ArrowRight: () => <span data-testid="icon-arrow-right">ArrowRight</span>,
  ArrowUp: () => <span data-testid="icon-arrow-up">ArrowUp</span>,
  ArrowDown: () => <span data-testid="icon-arrow-down">ArrowDown</span>,
  File: () => <span data-testid="icon-file-generic">File</span>,
  FileImage: () => <span data-testid="icon-file-image">FileImage</span>,
  FileVideo: () => <span data-testid="icon-file-video">FileVideo</span>,
  FileAudio: () => <span data-testid="icon-file-audio">FileAudio</span>,
  FileCode: () => <span data-testid="icon-file-code">FileCode</span>,
  FileSpreadsheet: () => <span data-testid="icon-file-spreadsheet">FileSpreadsheet</span>,
  FileArchive: () => <span data-testid="icon-file-archive">FileArchive</span>,
  FileJson: () => <span data-testid="icon-file-json">FileJson</span>,
  Presentation: () => <span data-testid="icon-presentation">Presentation</span>,
  Tag: () => <span data-testid="icon-tag">Tag</span>,
  Activity: () => <span data-testid="icon-activity">Activity</span>,
  Filter: () => <span data-testid="icon-filter">Filter</span>,
  CalendarDays: () => <span data-testid="icon-calendar-days">CalendarDays</span>
}));

jest.mock('../../src/renderer/components/ui/Modal', () => ({
  __esModule: true,
  default: ({ children, isOpen, onClose, title, closeOnOverlayClick, closeOnEsc }) =>
    isOpen ? (
      <div
        data-testid="modal"
        role="dialog"
        data-close-on-overlay-click={String(closeOnOverlayClick)}
        data-close-on-esc={String(closeOnEsc)}
      >
        <div data-testid="modal-title">{title}</div>
        <button data-testid="modal-close" onClick={onClose}>
          Close
        </button>
        {children}
      </div>
    ) : null,
  ConfirmModal: ({ isOpen, onConfirm, onClose, title }) =>
    isOpen ? (
      <div data-testid="confirm-modal">
        <div>{title}</div>
        <button onClick={onConfirm}>Confirm</button>
        <button onClick={onClose}>Cancel</button>
      </div>
    ) : null
}));

jest.mock('../../src/renderer/components/ui', () => {
  const actual = jest.requireActual('../../src/renderer/components/ui');
  return {
    __esModule: true,
    ...actual,
    Button: ({ children, onClick, disabled, className, leftIcon, rightIcon, ...props }) => (
      <button onClick={onClick} disabled={disabled} className={className} {...props}>
        {leftIcon ? <span data-testid="button-left-icon">{leftIcon}</span> : null}
        {children}
        {rightIcon ? <span data-testid="button-right-icon">{rightIcon}</span> : null}
      </button>
    ),
    IconButton: ({ children, onClick, disabled, className, icon, ...props }) => (
      <button onClick={onClick} disabled={disabled} className={className} {...props}>
        {icon ? <span data-testid="icon-button-icon">{icon}</span> : null}
        {children}
      </button>
    ),
    Input: ({ value, onChange, placeholder, className, ...props }) => (
      <input
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className={className}
        {...props}
      />
    ),
    Select: ({ value, onChange, className, children, ...props }) => (
      <select value={value} onChange={onChange} className={className} {...props}>
        {children}
      </select>
    ),
    StateMessage: ({ title, description, children, ...props }) => (
      <div data-testid="state-message" {...props}>
        {title ? <div>{title}</div> : null}
        {description ? <div>{description}</div> : null}
        {children}
      </div>
    ),
    Textarea: ({ value, onChange, placeholder, className, ...props }) => (
      <textarea
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className={className}
        {...props}
      />
    )
  };
});

jest.mock('../../src/renderer/components/search/ClusterNode', () => ({
  __esModule: true,
  default: ({ data }) => <div data-testid="cluster-node">{data?.label}</div>
}));

jest.mock('../../src/renderer/components/search/SimilarityEdge', () => ({
  __esModule: true,
  default: () => <div data-testid="similarity-edge" />
}));

jest.mock('../../src/renderer/components/search/QueryMatchEdge', () => ({
  __esModule: true,
  default: () => <div data-testid="query-match-edge" />
}));

jest.mock('../../src/renderer/components/search/SearchAutocomplete', () => ({
  __esModule: true,
  addToRecentSearches: jest.fn(),
  default: ({ value = '', onChange, onSelect, placeholder = 'Search...' }) => (
    <div data-testid="search-autocomplete">
      <input
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        aria-label="Search query"
      />
      <button onClick={() => onSelect('test query')}>Autocomplete</button>
    </div>
  )
}));

jest.mock('../../src/renderer/components/search/ClusterLegend', () => ({
  __esModule: true,
  default: () => <div data-testid="cluster-legend" />
}));

jest.mock('../../src/renderer/components/search/EmptySearchState', () => ({
  __esModule: true,
  default: ({ query, hasIndexedFiles, onSearchClick }) => (
    <div data-testid="empty-search-state">
      {!hasIndexedFiles && <span>No files indexed</span>}
      {hasIndexedFiles && !query && <span>Search tips</span>}
      {hasIndexedFiles && query && <span>No results for {query}</span>}
      <button onClick={() => onSearchClick?.('test suggestion')}>Suggestion</button>
    </div>
  )
}));

jest.mock('../../src/renderer/components/search/ChatPanel', () => ({
  __esModule: true,
  default: () => <div data-testid="chat-panel" />
}));

jest.mock('../../src/renderer/components/search/GraphTour', () => ({
  __esModule: true,
  default: ({ forceShow = false }) => (
    <div data-testid="graph-tour" data-force-show={forceShow ? 'true' : 'false'} />
  )
}));

// regl-scatterplot needs WebGL at module scope, which jsdom cannot provide.
jest.mock('../../src/renderer/components/search/AtlasTabContent', () => ({
  __esModule: true,
  default: () => <div data-testid="atlas-tab" />
}));

jest.mock('../../src/renderer/components/organize/TriageModal', () => ({
  __esModule: true,
  default: ({ onMoveFiles }) => (
    <button
      type="button"
      data-testid="triage-move-trigger"
      onClick={() => onMoveFiles?.([{ path: '/src/example.pdf' }], '/dest')}
    >
      Trigger Triage Move
    </button>
  )
}));

jest.mock('../../src/shared/performanceConstants', () => ({
  TIMEOUTS: {
    DEBOUNCE_INPUT: 300,
    SEARCH: 5000
  }
}));

jest.mock('../../src/shared/featureFlags', () => ({
  GRAPH_FEATURE_FLAGS: {
    SHOW_GRAPH: true,
    GRAPH_CLUSTERS: true,
    GRAPH_SIMILARITY_EDGES: true,
    GRAPH_MULTI_HOP: true,
    GRAPH_PROGRESSIVE_LAYOUT: true,
    GRAPH_KEYBOARD_NAV: true,
    GRAPH_CONTEXT_MENUS: true
  },
  isGraphViewEnabled: (...args) => mockIsGraphViewEnabled(...args)
}));

jest.mock('../../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

jest.mock('../../src/renderer/utils/pathUtils', () => ({
  safeBasename: (path) => path?.split('/').pop() || ''
}));

jest.mock('../../src/renderer/utils/scoreUtils', () => ({
  formatScore: (score) => `${Math.round(score * 100)}%`,
  scoreToOpacity: (score) => Math.max(0.3, score),
  clamp01: (val) => Math.max(0, Math.min(1, val)),
  normalizeConfidence: (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    const normalized = value > 1 ? value : value * 100;
    return Math.round(Math.min(100, Math.max(0, normalized)));
  }
}));

jest.mock('../../src/renderer/utils/graphUtils', () => ({
  makeQueryNodeId: (query) => `query-${query}`,
  defaultNodePosition: () => ({ x: 0, y: 0 })
}));

jest.mock('../../src/renderer/utils/elkLayout', () => ({
  elkLayout: jest.fn().mockResolvedValue({ nodes: [], edges: [] }),
  debouncedElkLayout: jest.fn().mockResolvedValue({ nodes: [], edges: [] }),
  cancelPendingLayout: jest.fn(),
  smartLayout: jest.fn().mockResolvedValue({ nodes: [], edges: [] }),
  clusterRadialLayout: jest.fn().mockResolvedValue({ nodes: [], edges: [] }),
  clusterExpansionLayout: jest.fn().mockResolvedValue({ nodes: [], edges: [] }),
  LARGE_GRAPH_THRESHOLD: 100
}));

export const mockElectronAPI = {
  embeddings: {
    search: jest.fn(),
    getStats: jest.fn(),
    rebuildFolders: jest.fn(),
    rebuildFiles: jest.fn(),
    findSimilar: jest.fn(),
    findDuplicates: jest.fn(),
    getFileMetadata: jest.fn()
  },
  files: {
    open: jest.fn(),
    reveal: jest.fn(),
    move: jest.fn(),
    organize: jest.fn(),
    performOperation: jest.fn()
  },
  events: {
    onFileOperationComplete: jest.fn()
  },
  smartFolders: {
    create: jest.fn()
  },
  clipboard: {
    writeText: jest.fn()
  },
  analysisHistory: {
    getTimeline: jest.fn().mockResolvedValue({ items: [], total: 0, hasMore: false })
  }
};

beforeAll(() => {
  Object.defineProperty(window, 'electronAPI', {
    value: mockElectronAPI,
    configurable: true
  });
});

export { mockIsGraphViewEnabled };
