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

jest.mock('../../src/renderer/components/ErrorBoundary', () => ({
  __esModule: true,
  default: ({ children }) => <>{children}</>
}));

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

import App from '../../src/renderer/App';

function setupState({
  currentPhase = 'discover',
  viewMode = 'phased',
  smartFolders = [],
  selectedTheme = 'primary',
  showSettings = false
} = {}) {
  mockState = {
    ui: { currentPhase, viewMode, selectedTheme, showSettings },
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

  test('renders the phased flow when viewMode is phased even with smart folders configured', async () => {
    setupState({ viewMode: 'phased', smartFolders: [{ id: 'sf-1' }] });
    render(<App />);

    expect(await screen.findByTestId('phase-renderer')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-view')).not.toBeInTheDocument();
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
