/**
 * @jest-environment jsdom
 *
 * The diagnostics panel refreshes itself every 15 s while open. When the
 * vector-DB bridge is missing it falls back to the embedding stats call; the
 * periodic tick must read that through the short stats cache instead of
 * forcing a fresh read in the main process each time. Opening the panel and
 * the Refresh button still force one.
 */
import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockGetStatsCached = jest.fn();

jest.mock('../../src/shared/logger', () => ({
  createLogger: () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() })
}));

jest.mock('../../src/renderer/services/ipc', () => ({
  // No vectorDb bridge: the panel uses the embedding-stats fallback.
  getElectronAPI: () => ({ llama: {} }),
  systemIpc: {
    getMetrics: jest.fn().mockResolvedValue({ memory: {}, env: {} }),
    getDegradedState: jest.fn().mockResolvedValue({ flags: [] })
  },
  llamaIpc: {
    getConfig: jest.fn().mockResolvedValue({}),
    testConnection: jest.fn().mockResolvedValue({ success: true })
  },
  embeddingsIpc: {
    getStatsCached: (...args) => mockGetStatsCached(...args)
  }
}));

jest.mock('lucide-react', () => ({
  ClipboardCopy: (props) => <svg {...props} />,
  RefreshCw: (props) => <svg {...props} />
}));

jest.mock('../../src/renderer/components/ui/Button', () => ({
  __esModule: true,
  default: ({ children, leftIcon: _leftIcon, isLoading: _isLoading, ...props }) => (
    <button {...props}>{children}</button>
  )
}));

jest.mock('../../src/renderer/components/settings/SettingsCard', () => ({
  __esModule: true,
  default: ({ title, headerAction, children }) => (
    <section>
      <h3>{title}</h3>
      {headerAction}
      {children}
    </section>
  )
}));

jest.mock('../../src/renderer/components/ui/Typography', () => ({
  Heading: ({ as: Component = 'h4', children }) => <Component>{children}</Component>,
  Text: ({ as: Component = 'span', children, ...rest }) => (
    <Component {...rest}>{children}</Component>
  )
}));

import DiagnosticsSnapshotSection from '../../src/renderer/components/settings/DiagnosticsSnapshotSection';

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};

describe('DiagnosticsSnapshotSection stats refresh', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockGetStatsCached.mockReset();
    mockGetStatsCached.mockResolvedValue({ success: true, files: 3 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('the live tick uses cached stats; opening and Refresh force a fresh read', async () => {
    render(<DiagnosticsSnapshotSection />);
    await flush();
    expect(mockGetStatsCached).toHaveBeenCalledTimes(1);
    expect(mockGetStatsCached).toHaveBeenLastCalledWith({ forceRefresh: true });

    await act(async () => {
      jest.advanceTimersByTime(15000);
    });
    await flush();
    expect(mockGetStatsCached).toHaveBeenCalledTimes(2);
    expect(mockGetStatsCached).toHaveBeenLastCalledWith({ forceRefresh: false });

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await flush();
    expect(mockGetStatsCached).toHaveBeenCalledTimes(3);
    expect(mockGetStatsCached).toHaveBeenLastCalledWith({ forceRefresh: true });
  });
});
