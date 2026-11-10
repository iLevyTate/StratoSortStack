/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockDispatch = jest.fn();
let mockState;

jest.mock('../../src/renderer/store/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector) => selector(mockState)
}));

jest.mock('../../src/renderer/hooks/useSettingsSubscription', () => ({
  useSettingsSubscription: () => {}
}));

jest.mock('../../src/renderer/store/slices/uiSlice', () => ({
  updateSettings: jest.fn((payload) => ({ type: 'ui/updateSettings', payload }))
}));

const mockAddNotification = jest.fn();
jest.mock('../../src/renderer/contexts/NotificationContext', () => ({
  useNotification: () => ({ addNotification: mockAddNotification })
}));

jest.mock('../../src/shared/constants', () => ({
  PHASES: {
    WELCOME: 'welcome',
    SETUP: 'setup',
    DISCOVER: 'discover',
    ORGANIZE: 'organize',
    COMPLETE: 'complete'
  }
}));

// AppProviders and ErrorBoundary are pass-throughs here so the test exercises
// AppContent's routing decision without standing up the real store/providers.
jest.mock('../../src/renderer/components/AppProviders', () => ({
  __esModule: true,
  default: ({ children }) => <>{children}</>
}));

// Pass-through by default; the live-activity crash test flips this to the
// real boundary so it can prove a panel crash stays contained.
let mockUseRealErrorBoundary = false;
jest.mock('../../src/renderer/components/ErrorBoundary', () => {
  const RealErrorBoundary = jest.requireActual(
    '../../src/renderer/components/ErrorBoundary'
  ).default;
  return {
    __esModule: true,
    default: (props) =>
      mockUseRealErrorBoundary ? <RealErrorBoundary {...props} /> : <>{props.children}</>
  };
});

jest.mock('../../src/renderer/components/NavigationBar', () => ({
  __esModule: true,
  default: () => <div data-testid="navbar" />
}));

jest.mock('../../src/renderer/components/TooltipManager', () => ({
  __esModule: true,
  default: () => <div data-testid="tooltip-manager" />
}));

jest.mock('../../src/renderer/components/layout/DegradedStateBanner', () => ({
  __esModule: true,
  default: () => <div data-testid="degraded-banner" />
}));

jest.mock('../../src/renderer/components/layout/AppShell', () => ({
  __esModule: true,
  default: ({ header, subheader, children, contentClassName }) => (
    <div data-testid="app-shell" data-content-class={contentClassName}>
      {header}
      {subheader}
      {children}
    </div>
  )
}));

jest.mock('../../src/renderer/components/ui/LoadingSkeleton', () => ({
  LazyLoadingSpinner: () => <div data-testid="spinner" />,
  ModalLoadingOverlay: () => <div data-testid="modal-spinner" />
}));

jest.mock('../../src/renderer/components/PhaseRenderer', () => ({
  __esModule: true,
  default: () => <div data-testid="phase-renderer" />
}));

jest.mock('../../src/renderer/components/dashboard/DashboardView', () => ({
  __esModule: true,
  default: () => <div data-testid="dashboard-view" />
}));

jest.mock('../../src/renderer/hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: jest.fn()
}));

jest.mock('../../src/renderer/components/PhaseErrorBoundary', () => ({
  __esModule: true,
  default: ({ children }) => <>{children}</>
}));

jest.mock('../../src/renderer/components/SettingsPanel', () => ({
  __esModule: true,
  default: () => <div data-testid="settings-panel" />
}));

// Mocked so App-level tests never stand up react-window / ResizeObserver or
// the live-log IPC feed; the panel itself is covered by its own suite.
let mockPanelThrows = false;
jest.mock('../../src/renderer/components/diagnostics/LiveActivityPanel', () => ({
  __esModule: true,
  default: () => {
    if (mockPanelThrows) throw new Error('live activity panel boom');
    return <div data-testid="live-activity-panel" />;
  }
}));

import App from '../../src/renderer/App';
import { logger as mockLogger } from '../../src/shared/logger';

function setupState({
  currentPhase = 'discover',
  viewMode = 'phased',
  smartFolders = [],
  selectedTheme = 'primary',
  showSettings = false,
  settings = null
} = {}) {
  mockState = {
    ui: { currentPhase, viewMode, selectedTheme, showSettings, settings },
    files: { smartFolders }
  };
}

describe('App view-mode routing', () => {
  beforeEach(() => {
    mockDispatch.mockClear();
    setupState();
  });

  test('renders the dashboard when viewMode is dashboard and a smart folder exists', async () => {
    setupState({ viewMode: 'dashboard', smartFolders: [{ id: 'sf-1' }] });
    render(<App />);

    expect(await screen.findByTestId('dashboard-view')).toBeInTheDocument();
    expect(screen.queryByTestId('phase-renderer')).not.toBeInTheDocument();
  });

  test('falls back to the phased flow when dashboard is preferred but no smart folders exist', async () => {
    // First-run guard: a remembered dashboard preference must not strand the user
    // on an empty screen before onboarding has produced a smart folder.
    setupState({ viewMode: 'dashboard', smartFolders: [] });
    render(<App />);

    expect(await screen.findByTestId('phase-renderer')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-view')).not.toBeInTheDocument();
  });

  test('stays on the phased flow when the only smart folder is the Uncategorized fallback', async () => {
    // Main seeds Uncategorized on every fresh profile, so it is in Redux before
    // Welcome renders. It is not a destination: a Dashboard pick on first run
    // must still go through Setup instead of landing on the dashboard.
    setupState({
      viewMode: 'dashboard',
      currentPhase: 'setup',
      smartFolders: [
        {
          id: 'uncat',
          name: 'Uncategorized',
          category: 'uncategorized',
          isDefault: true,
          path: 'C:/x/Uncategorized'
        }
      ]
    });
    render(<App />);

    expect(await screen.findByTestId('phase-renderer')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-view')).not.toBeInTheDocument();
  });

  test('renders the phased flow when viewMode is phased even with smart folders configured', async () => {
    setupState({ viewMode: 'phased', smartFolders: [{ id: 'sf-1' }] });
    render(<App />);

    expect(await screen.findByTestId('phase-renderer')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-view')).not.toBeInTheDocument();
  });
});

describe('App expired-session notice', () => {
  // store/index.js keeps viewMode across a TTL expiry, so a dashboard user
  // never mounts WelcomePhase at startup. The notice has to come from the
  // shell, which is mounted on both surfaces.
  beforeEach(() => {
    mockDispatch.mockClear();
    mockAddNotification.mockClear();
    delete window.__STRATOSORT_STATE_EXPIRED__;
    delete window.__STRATOSORT_STATE_EXPIRED_AGE_HOURS__;
  });

  afterEach(() => {
    delete window.__STRATOSORT_STATE_EXPIRED__;
    delete window.__STRATOSORT_STATE_EXPIRED_AGE_HOURS__;
  });

  const expiredNotices = () =>
    mockAddNotification.mock.calls.filter(([message]) =>
      String(message).includes('Previous session')
    );

  test('is shown once at startup on the dashboard surface and clears the flag', async () => {
    window.__STRATOSORT_STATE_EXPIRED__ = true;
    window.__STRATOSORT_STATE_EXPIRED_AGE_HOURS__ = 48;
    setupState({ viewMode: 'dashboard', currentPhase: 'welcome', smartFolders: [{ id: 'sf-1' }] });
    const { rerender } = render(<App />);

    expect(await screen.findByTestId('dashboard-view')).toBeInTheDocument();
    expect(screen.queryByTestId('phase-renderer')).not.toBeInTheDocument();
    expect(expiredNotices()).toHaveLength(1);
    expect(expiredNotices()[0][0]).toContain('48h old');
    expect(expiredNotices()[0][1]).toBe('info');
    expect(window.__STRATOSORT_STATE_EXPIRED__).toBeUndefined();
    expect(window.__STRATOSORT_STATE_EXPIRED_AGE_HOURS__).toBeUndefined();

    rerender(<App />);
    expect(expiredNotices()).toHaveLength(1);
  });

  test('is shown once on the phased surface', async () => {
    window.__STRATOSORT_STATE_EXPIRED__ = true;
    window.__STRATOSORT_STATE_EXPIRED_AGE_HOURS__ = 30;
    setupState({ viewMode: 'phased', currentPhase: 'welcome' });
    render(<App />);

    expect(await screen.findByTestId('phase-renderer')).toBeInTheDocument();
    expect(expiredNotices()).toHaveLength(1);
    expect(window.__STRATOSORT_STATE_EXPIRED__).toBeUndefined();
  });

  test('is not shown when no session expired', async () => {
    setupState({ viewMode: 'dashboard', smartFolders: [{ id: 'sf-1' }] });
    render(<App />);

    expect(await screen.findByTestId('dashboard-view')).toBeInTheDocument();
    expect(expiredNotices()).toHaveLength(0);
  });
});

describe('App settings overlay hoisting', () => {
  // The settings overlay must be mounted at App level, NOT inside
  // PhaseRenderer: the dashboard surface replaces PhaseRenderer entirely, so
  // a PhaseRenderer-mounted overlay silently no-ops there (the gear click set
  // ui.showSettings with no consumer, then ambushed the user with a stale
  // open panel when they returned to the guided flow).
  beforeEach(() => {
    mockDispatch.mockClear();
  });

  test('renders the settings overlay on the dashboard surface', async () => {
    setupState({ viewMode: 'dashboard', smartFolders: [{ id: 'sf-1' }], showSettings: true });
    render(<App />);

    expect(await screen.findByTestId('dashboard-view')).toBeInTheDocument();
    expect(await screen.findByTestId('settings-panel')).toBeInTheDocument();
  });

  test('renders the settings overlay on the phased surface', async () => {
    setupState({ viewMode: 'phased', showSettings: true });
    render(<App />);

    expect(await screen.findByTestId('phase-renderer')).toBeInTheDocument();
    expect(await screen.findByTestId('settings-panel')).toBeInTheDocument();
  });

  test('does not render the settings overlay when closed', async () => {
    setupState({ viewMode: 'dashboard', smartFolders: [{ id: 'sf-1' }], showSettings: false });
    render(<App />);

    await screen.findByTestId('dashboard-view');
    expect(screen.queryByTestId('settings-panel')).not.toBeInTheDocument();
  });
});

describe('App theme application', () => {
  beforeEach(() => {
    mockDispatch.mockClear();
    document.documentElement.removeAttribute('data-theme');
    setupState();
  });

  test('applies the selected palette to <html> data-theme on mount', () => {
    setupState({ selectedTheme: 'dark' });
    render(<App />);

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  test('falls back to primary when selectedTheme is unset or invalid', () => {
    setupState({ selectedTheme: 'solarized' });
    render(<App />);

    expect(document.documentElement.getAttribute('data-theme')).toBe('primary');
  });
});

describe('App live activity panel', () => {
  beforeEach(() => {
    mockDispatch.mockClear();
    mockPanelThrows = false;
    mockUseRealErrorBoundary = false;
    setupState();
  });

  afterEach(() => {
    mockPanelThrows = false;
    mockUseRealErrorBoundary = false;
  });

  test('is not mounted before settings load', async () => {
    render(<App />);
    expect(await screen.findByTestId('phase-renderer')).toBeInTheDocument();
    expect(screen.queryByTestId('live-activity-panel')).not.toBeInTheDocument();
  });

  test('is not mounted while showLiveActivity is off', async () => {
    setupState({ settings: { showLiveActivity: false } });
    render(<App />);
    expect(await screen.findByTestId('phase-renderer')).toBeInTheDocument();
    expect(screen.queryByTestId('live-activity-panel')).not.toBeInTheDocument();
  });

  test('is not mounted for a truthy non-boolean flag', async () => {
    setupState({ settings: { showLiveActivity: 'true' } });
    render(<App />);
    expect(await screen.findByTestId('phase-renderer')).toBeInTheDocument();
    expect(screen.queryByTestId('live-activity-panel')).not.toBeInTheDocument();
  });

  test('mounts exactly one panel when showLiveActivity is on, on either surface', async () => {
    setupState({ settings: { showLiveActivity: true } });
    const { unmount } = render(<App />);
    expect(await screen.findByTestId('live-activity-panel')).toBeInTheDocument();
    expect(screen.getAllByTestId('live-activity-panel')).toHaveLength(1);
    unmount();

    setupState({
      viewMode: 'dashboard',
      smartFolders: [{ id: 'sf-1' }],
      settings: { showLiveActivity: true }
    });
    render(<App />);
    expect(await screen.findByTestId('dashboard-view')).toBeInTheDocument();
    expect(await screen.findByTestId('live-activity-panel')).toBeInTheDocument();
    expect(screen.getAllByTestId('live-activity-panel')).toHaveLength(1);
  });

  test('unmounts when the setting is turned off', async () => {
    setupState({ settings: { showLiveActivity: true } });
    const { rerender } = render(<App />);
    expect(await screen.findByTestId('live-activity-panel')).toBeInTheDocument();

    setupState({ settings: { showLiveActivity: false } });
    rerender(<App />);
    expect(screen.queryByTestId('live-activity-panel')).not.toBeInTheDocument();
  });

  test('a crashing panel is dropped and logged once without taking down the app', async () => {
    mockUseRealErrorBoundary = true;
    mockPanelThrows = true;
    mockLogger.error.mockClear();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      setupState({ settings: { showLiveActivity: true } });
      render(<App />);

      expect(await screen.findByTestId('phase-renderer')).toBeInTheDocument();
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
      expect(screen.queryByTestId('live-activity-panel')).not.toBeInTheDocument();
      const panelErrors = mockLogger.error.mock.calls.filter(([message]) =>
        String(message).includes('LiveActivityPanel')
      );
      expect(panelErrors).toHaveLength(1);
    } finally {
      consoleError.mockRestore();
    }
  });
});
