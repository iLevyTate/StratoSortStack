/**
 * @jest-environment jsdom
 *
 * Settings → Diagnostics: the "Show live activity" switch reads the store and
 * saves through the live-activity thunk (the same path as Ctrl/Cmd+Shift+L
 * and the panel's Close button), never through SettingsPanel's auto-save.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

let mockState = {};
const mockDispatch = jest.fn();
const mockSetShowLiveActivity = jest.fn((enabled) => ({
  type: 'test/setShowLiveActivity',
  enabled
}));

jest.mock('../../src/renderer/store/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector) => selector(mockState)
}));

jest.mock('../../src/renderer/store/thunks/liveActivityThunks', () => ({
  setShowLiveActivity: (...args) => mockSetShowLiveActivity(...args)
}));

let mockIsMac = false;
jest.mock('../../src/renderer/utils/platform', () => ({
  get isMac() {
    return mockIsMac;
  }
}));

jest.mock('../../src/renderer/services/ipc', () => ({
  getElectronAPI: () => ({ settings: {}, system: {} }),
  settingsIpc: { openLogsFolder: jest.fn() },
  systemIpc: { exportLogs: jest.fn() }
}));

jest.mock('../../src/renderer/components/ui/Button', () => ({
  __esModule: true,
  default: ({ children, isLoading: _isLoading, ...props }) => <button {...props}>{children}</button>
}));

import DiagnosticsLogsSection from '../../src/renderer/components/settings/DiagnosticsLogsSection';

describe('DiagnosticsLogsSection — Show live activity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDispatch.mockResolvedValue(true);
    mockState = { ui: { settings: { showLiveActivity: false } } };
    mockIsMac = false;
  });

  test('is off when the setting is off, and turning it on saves through the thunk', () => {
    render(<DiagnosticsLogsSection />);

    const toggle = screen.getByRole('switch', { name: 'Show live activity' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);

    expect(mockSetShowLiveActivity).toHaveBeenCalledTimes(1);
    expect(mockSetShowLiveActivity).toHaveBeenCalledWith(true);
    expect(mockDispatch).toHaveBeenCalledWith({ type: 'test/setShowLiveActivity', enabled: true });
  });

  test('is on when the setting is on, and turns it off', () => {
    mockState = { ui: { settings: { showLiveActivity: true } } };
    render(<DiagnosticsLogsSection />);

    const toggle = screen.getByRole('switch', { name: 'Show live activity' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle);
    expect(mockSetShowLiveActivity).toHaveBeenCalledWith(false);
  });

  test('renders off before settings have loaded', () => {
    mockState = { ui: { settings: null } };
    render(<DiagnosticsLogsSection />);
    expect(screen.getByRole('switch', { name: 'Show live activity' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  test('shows the Ctrl shortcut on Windows and Linux', () => {
    mockIsMac = false;
    render(<DiagnosticsLogsSection />);
    expect(screen.getByText(/Shortcut: Ctrl\+Shift\+L\./)).toBeInTheDocument();
    expect(screen.queryByText(/Cmd\+Shift\+L/)).not.toBeInTheDocument();
  });

  test('shows the Cmd shortcut on macOS', () => {
    mockIsMac = true;
    render(<DiagnosticsLogsSection />);
    expect(screen.getByText(/Shortcut: Cmd\+Shift\+L\./)).toBeInTheDocument();
    expect(screen.queryByText(/Ctrl\+Shift\+L/)).not.toBeInTheDocument();
  });

  test('says so when the save fails (the thunk has already put the switch back)', async () => {
    mockDispatch.mockResolvedValue(false);
    const addNotification = jest.fn();
    render(<DiagnosticsLogsSection addNotification={addNotification} />);

    fireEvent.click(screen.getByRole('switch', { name: 'Show live activity' }));

    await waitFor(() =>
      expect(addNotification).toHaveBeenCalledWith(
        "Couldn't save the live activity setting",
        'error',
        expect.any(Number),
        // Grouped: repeated failed clicks update one toast instead of stacking.
        'live-activity-save-error'
      )
    );
  });

  test('a successful save raises no notification', async () => {
    const addNotification = jest.fn();
    render(<DiagnosticsLogsSection addNotification={addNotification} />);

    fireEvent.click(screen.getByRole('switch', { name: 'Show live activity' }));

    await waitFor(() => expect(mockDispatch).toHaveBeenCalled());
    await Promise.resolve();
    expect(addNotification).not.toHaveBeenCalled();
  });
});
