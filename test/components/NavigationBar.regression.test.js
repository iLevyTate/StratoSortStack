/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockDispatch = jest.fn();
let mockState = {};

jest.mock('../../src/renderer/store/hooks', () => ({
  useAppDispatch: jest.fn(() => mockDispatch),
  useAppSelector: jest.fn((selector) => selector(mockState))
}));

jest.mock('../../src/renderer/store/slices/uiSlice', () => ({
  setPhase: jest.fn((phase) => ({ type: 'ui/setPhase', payload: phase })),
  setViewMode: jest.fn((mode) => ({ type: 'ui/setViewMode', payload: mode })),
  openSettings: jest.fn(() => ({ type: 'ui/openSettings' })),
  toggleSettings: jest.fn(() => ({ type: 'ui/toggleSettings' })),
  canTransitionTo: jest.fn(() => true),
  getTransitionBlockReason: jest.fn(() => null)
}));

const mockFetchAiConfig = jest.fn(() => ({ type: 'aiProvider/fetch' }));

jest.mock('../../src/renderer/store/slices/aiProviderSlice', () => ({
  fetchAiConfig: (...args) => mockFetchAiConfig(...args)
}));

const mockFloatingSearch = {
  isModalOpen: false,
  openSearchModal: jest.fn(),
  closeSearchModal: jest.fn()
};

const mockNotification = {
  showInfo: jest.fn()
};

jest.mock('../../src/renderer/contexts/FloatingSearchContext', () => ({
  useFloatingSearch: jest.fn(() => mockFloatingSearch)
}));

jest.mock('../../src/renderer/contexts/NotificationContext', () => ({
  useNotification: jest.fn(() => mockNotification)
}));

jest.mock('../../src/renderer/components/UpdateIndicator', () => ({
  __esModule: true,
  default: () => <div data-testid="update-indicator" />
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

jest.mock('../../src/renderer/utils/platform', () => ({
  isMac: false
}));

jest.mock('../../src/renderer/components/UndoRedoSystem', () => ({
  useUndoRedo: jest.fn(() => ({
    isExecuting: false,
    executionStatus: { active: false, kind: null, label: '', detail: '' }
  }))
}));

jest.mock('lucide-react', () => ({
  Home: (props) => <svg data-testid="icon-home" {...props} />,
  Settings: (props) => <svg data-testid="icon-settings" {...props} />,
  Search: (props) => <svg data-testid="icon-search" {...props} />,
  FolderOpen: (props) => <svg data-testid="icon-folder-open" {...props} />,
  FolderTree: (props) => <svg data-testid="icon-folder-tree" {...props} />,
  CheckCircle2: (props) => <svg data-testid="icon-check" {...props} />,
  Loader2: (props) => <svg data-testid="icon-loader" {...props} />,
  Minus: (props) => <svg data-testid="icon-minus" {...props} />,
  Square: (props) => <svg data-testid="icon-square" {...props} />,
  X: (props) => <svg data-testid="icon-x" {...props} />,
  LayoutGrid: (props) => <svg data-testid="icon-layout-grid" {...props} />,
  List: (props) => <svg data-testid="icon-list" {...props} />,
  ArrowLeft: (props) => <svg data-testid="icon-arrow-left" {...props} />
}));

import NavigationBar from '../../src/renderer/components/NavigationBar';

describe('NavigationBar regression guards', () => {
  beforeEach(() => {
    mockDispatch.mockClear();
    mockFloatingSearch.isModalOpen = false;
    mockFloatingSearch.openSearchModal.mockClear();
    mockFloatingSearch.closeSearchModal.mockClear();
    mockNotification.showInfo.mockClear();
    mockState = {
      ui: {
        currentPhase: 'welcome',
        viewMode: 'phased',
        isOrganizing: false,
        isLoading: false
      },
      files: {
        // Default to a configured workspace so the Dashboard toggle is enabled;
        // tests that exercise the empty-workspace gate override this explicitly.
        smartFolders: [{ id: 'sf-1' }]
      },
      analysis: {
        isAnalyzing: false
      },
      system: {
        health: {
          llama: 'online',
          vectorDb: 'online'
        }
      },
      aiProvider: {
        loaded: false
      }
    };

    mockFetchAiConfig.mockClear();

    window.electronAPI = {
      aiProvider: {
        getConfig: jest.fn()
      },
      llama: {
        testConnection: jest.fn().mockResolvedValue({ status: 'healthy' })
      },
      vectorDb: {
        healthCheck: jest.fn().mockResolvedValue({ healthy: true })
      },
      window: {
        isMaximized: jest.fn().mockResolvedValue(false),
        minimize: jest.fn(),
        toggleMaximize: jest.fn().mockResolvedValue(false),
        close: jest.fn()
      }
    };
  });

  afterEach(() => {
    delete window.electronAPI;
  });

  test('a paused model type or the CPU fallback reads as degraded, not offline', async () => {
    window.electronAPI.llama.testConnection = jest.fn().mockResolvedValue({
      success: true,
      status: 'unhealthy',
      llamaHealth: { initialized: true, degraded: true, usingCPUFallback: true, openCircuits: [] }
    });
    render(<NavigationBar />);

    await waitFor(() => {
      expect(
        mockDispatch.mock.calls.some(
          ([action]) =>
            action && /updateHealth$/.test(action.type) && action.payload?.llama === 'degraded'
        )
      ).toBe(true);
    });
  });

  test('an engine that never initialized reads as offline', async () => {
    window.electronAPI.llama.testConnection = jest.fn().mockResolvedValue({
      success: false,
      status: 'unhealthy',
      error: 'boom',
      llamaHealth: { status: 'unhealthy', error: 'boom' }
    });
    render(<NavigationBar />);

    await waitFor(() => {
      expect(
        mockDispatch.mock.calls.some(
          ([action]) =>
            action && /updateHealth$/.test(action.type) && action.payload?.llama === 'offline'
        )
      ).toBe(true);
    });
  });

  test('a plain healthy answer with no health block still reads as online', async () => {
    render(<NavigationBar />);

    await waitFor(() => {
      expect(
        mockDispatch.mock.calls.some(
          ([action]) =>
            action && /updateHealth$/.test(action.type) && action.payload?.llama === 'online'
        )
      ).toBe(true);
    });
  });

  test('the indicator says reduced capacity while the engine is degraded', () => {
    mockState.system.health.llama = 'degraded';
    render(<NavigationBar />);

    expect(screen.getByTitle('Local AI running with reduced capacity')).toBeInTheDocument();
  });

  test('keeps center nav between brand and actions so they do not overlap', () => {
    const { container } = render(<NavigationBar />);

    const centerLayer = container.querySelector('[data-testid="phase-nav-center"]');
    expect(centerLayer).toBeInTheDocument();
    expect(centerLayer.querySelector('[data-testid="phase-nav"]')).toBeInTheDocument();

    const rightControls = container.querySelector('[data-testid="nav-actions"]');
    expect(rightControls).toBeInTheDocument();
  });

  test('aligns phase progress to step positions', () => {
    const { container, unmount } = render(<NavigationBar />);

    const progress = container.querySelector('.phase-nav-progress');
    expect(progress).toBeInTheDocument();
    // Content-progress math: (index+1)/totalSteps for a 5-phase order.
    // welcome (index 0) -> 1/5 = 0.2.
    expect(progress.style.getPropertyValue('--phase-progress')).toBe('0.2');

    unmount();
    mockState.ui.currentPhase = 'discover';
    const discoverRender = render(<NavigationBar />);
    // discover (index 2) -> 3/5 = 0.6.
    expect(
      discoverRender.container
        .querySelector('.phase-nav-progress')
        .style.getPropertyValue('--phase-progress')
    ).toBe('0.6');

    discoverRender.unmount();
    mockState.ui.currentPhase = 'complete';
    const completeRender = render(<NavigationBar />);
    expect(
      completeRender.container
        .querySelector('.phase-nav-progress')
        .style.getPropertyValue('--phase-progress')
    ).toBe('1');
  });

  test('allows phase navigation click dispatch when not blocked', async () => {
    render(<NavigationBar />);

    const setupTab = screen.getByRole('button', { name: /setup/i });
    fireEvent.click(setupTab);

    await waitFor(() => {
      expect(
        mockDispatch.mock.calls.some(
          ([action]) => action && action.type === 'ui/setPhase' && action.payload === 'setup'
        )
      ).toBe(true);
    });
  });

  test('header Search opens the search modal in one click', () => {
    render(<NavigationBar />);

    const searchBtn = screen.getByRole('button', { name: /Open Knowledge OS/i });
    fireEvent.click(searchBtn);

    expect(mockFloatingSearch.openSearchModal).toHaveBeenCalledTimes(1);
    expect(mockFloatingSearch.openSearchModal).toHaveBeenCalledWith('search');
  });

  test('header Search closes modal when modal already open', () => {
    mockFloatingSearch.isModalOpen = true;
    render(<NavigationBar />);

    fireEvent.click(screen.getByRole('button', { name: /Close Knowledge OS/i }));

    expect(mockFloatingSearch.closeSearchModal).toHaveBeenCalledTimes(1);
    expect(mockFloatingSearch.openSearchModal).not.toHaveBeenCalled();
  });

  test('dispatches fetchAiConfig on mount when AI provider config is not loaded', () => {
    render(<NavigationBar />);

    expect(mockFetchAiConfig).toHaveBeenCalledTimes(1);
    expect(
      mockDispatch.mock.calls.some(([action]) => action && action.type === 'aiProvider/fetch')
    ).toBe(true);
  });

  test('blocked Setup navigation opens settings and explains the current operation', () => {
    mockState.ui.isOrganizing = true;
    render(<NavigationBar />);

    fireEvent.click(screen.getByRole('button', { name: /setup/i }));

    expect(
      mockDispatch.mock.calls.some(([action]) => action && action.type === 'ui/openSettings')
    ).toBe(true);
    expect(mockNotification.showInfo).toHaveBeenCalledWith(
      expect.stringContaining('Settings opened while work continues'),
      6200
    );
  });

  test('renders the view-mode toggle and dispatches setViewMode on Dashboard click', () => {
    render(<NavigationBar />);

    const toggleGroup = screen.getByRole('group', { name: /view mode/i });
    fireEvent.click(within(toggleGroup).getByText('Dashboard').closest('button'));

    expect(
      mockDispatch.mock.calls.some(
        ([action]) => action && action.type === 'ui/setViewMode' && action.payload === 'dashboard'
      )
    ).toBe(true);
  });

  test('hides the phase tab strip in dashboard mode', () => {
    mockState.ui.viewMode = 'dashboard';
    const { container } = render(<NavigationBar />);

    // The center grid cell stays as a layout anchor, but the phase tab nav inside it is gone.
    expect(container.querySelector('[data-testid="phase-nav-center"]')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="phase-nav"]')).not.toBeInTheDocument();
  });

  test('keeps the view-mode toggle interactive while an operation blocks phase nav', () => {
    mockState.ui.viewMode = 'dashboard';
    mockState.ui.isOrganizing = true;
    render(<NavigationBar />);

    // Switching back to guided must work even mid-operation — it is a view
    // switch, not a phase transition, so it is never gated by the block banner.
    const toggleGroup = screen.getByRole('group', { name: /view mode/i });
    fireEvent.click(within(toggleGroup).getByText('Guided').closest('button'));

    expect(
      mockDispatch.mock.calls.some(
        ([action]) => action && action.type === 'ui/setViewMode' && action.payload === 'phased'
      )
    ).toBe(true);
  });

  test('disables the Dashboard toggle and ignores clicks when no smart folders exist', () => {
    // Mirrors App.js: the dashboard surface only renders once a smart folder
    // exists, so the toggle must not highlight Dashboard while the rendered
    // surface stays phased. It is aria-disabled and inert until then.
    mockState.files.smartFolders = [];
    render(<NavigationBar />);

    const toggleGroup = screen.getByRole('group', { name: /view mode/i });
    const dashboardButton = within(toggleGroup).getByText('Dashboard').closest('button');

    expect(dashboardButton).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(dashboardButton);

    expect(
      mockDispatch.mock.calls.some(([action]) => action && action.type === 'ui/setViewMode')
    ).toBe(false);
  });

  test('each view-mode toggle exposes a descriptive accessible name', () => {
    render(<NavigationBar />);

    const toggleGroup = screen.getByRole('group', { name: /view mode/i });
    // Below the lg breakpoint the visible text label collapses, so each control
    // must carry its own descriptive accessible name rather than relying on the
    // (CSS-hidden) span text — otherwise the toggle reads as two cryptic icons.
    expect(
      within(toggleGroup).getByRole('button', { name: 'Guided step-by-step flow' })
    ).toBeInTheDocument();
    expect(
      within(toggleGroup).getByRole('button', { name: 'Dashboard overview' })
    ).toBeInTheDocument();
  });

  test('disabled Dashboard toggle names itself with the unlock hint', () => {
    mockState.files.smartFolders = [];
    render(<NavigationBar />);

    const toggleGroup = screen.getByRole('group', { name: /view mode/i });
    expect(
      within(toggleGroup).getByRole('button', {
        name: /Add a smart folder in Setup to open the dashboard/i
      })
    ).toBeInTheDocument();
  });

  test('enables the Dashboard toggle once a smart folder exists', () => {
    mockState.files.smartFolders = [{ id: 'sf-1' }];
    render(<NavigationBar />);

    const toggleGroup = screen.getByRole('group', { name: /view mode/i });
    const dashboardButton = within(toggleGroup).getByText('Dashboard').closest('button');

    expect(dashboardButton).toHaveAttribute('aria-disabled', 'false');

    fireEvent.click(dashboardButton);

    expect(
      mockDispatch.mock.calls.some(
        ([action]) => action && action.type === 'ui/setViewMode' && action.payload === 'dashboard'
      )
    ).toBe(true);
  });

  test('shows the phased step counter subtitle in guided mode but a neutral tagline in dashboard mode', () => {
    const phased = render(<NavigationBar />);
    expect(phased.container).toHaveTextContent(/Step \d+ of \d+/);
    phased.unmount();

    mockState.ui.viewMode = 'dashboard';
    render(<NavigationBar />);

    // The "Step N of 5" counter is meaningless on the dashboard, so the Brand
    // subtitle falls back to the neutral product tagline.
    expect(screen.queryByText(/Step \d+ of \d+/)).not.toBeInTheDocument();
    expect(screen.getByText('Private file organization')).toBeInTheDocument();
  });

  test('offers a Back to dashboard breadcrumb after a dashboard deep-link, returning on click', () => {
    mockState.ui.cameFromDashboard = true;
    render(<NavigationBar />);

    const back = screen.getByRole('button', { name: /back to dashboard/i });
    fireEvent.click(back);

    expect(
      mockDispatch.mock.calls.some(
        ([action]) => action && action.type === 'ui/setViewMode' && action.payload === 'dashboard'
      )
    ).toBe(true);
  });

  test('does not show the Back to dashboard breadcrumb without a dashboard origin', () => {
    mockState.ui.cameFromDashboard = false;
    render(<NavigationBar />);

    expect(screen.queryByRole('button', { name: /back to dashboard/i })).not.toBeInTheDocument();
  });

  test('hides the Back to dashboard breadcrumb when the dashboard would dead-end (no smart folders)', () => {
    mockState.ui.cameFromDashboard = true;
    mockState.files.smartFolders = [];
    render(<NavigationBar />);

    expect(screen.queryByRole('button', { name: /back to dashboard/i })).not.toBeInTheDocument();
  });

  test('hides the Back to dashboard breadcrumb once already on the dashboard surface', () => {
    mockState.ui.viewMode = 'dashboard';
    mockState.ui.cameFromDashboard = true;
    render(<NavigationBar />);

    expect(screen.queryByRole('button', { name: /back to dashboard/i })).not.toBeInTheDocument();
  });

  test('suppresses the blocked-operation banner in dashboard mode even while organizing', () => {
    mockState.ui.isOrganizing = true;

    const phased = render(<NavigationBar />);
    // Guided mode surfaces the paused-navigation banner during an operation.
    expect(phased.container).toHaveTextContent(/Step navigation is paused/);
    phased.unmount();

    mockState.ui.viewMode = 'dashboard';
    render(<NavigationBar />);

    // Dashboard mode has no phase tabs to block, so the banner must not render.
    expect(screen.queryByText(/Step navigation is paused/)).not.toBeInTheDocument();
  });
});
