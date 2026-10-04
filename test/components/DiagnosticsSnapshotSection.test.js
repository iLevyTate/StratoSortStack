/**
 * @jest-environment jsdom
 *
 * The preload serializes llama:test-connection. When a probe is already in
 * flight (NavigationBar's boot probe, StrictMode's dev double-effect), the
 * diagnostics snapshot's own probe rejects with "Operation already in
 * progress" — which is benign and must NOT render the Local AI section as an
 * error alert or log a warning (QA 2026-07-11: WARN "[DiagnosticsSnapshot]
 * llama health fetch failed" on every Settings open in dev).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockWarn = jest.fn();
const mockGetMetrics = jest.fn();
const mockGetDegradedState = jest.fn();
const mockGetConfig = jest.fn();
const mockTestConnection = jest.fn();
const mockGetStats = jest.fn();

jest.mock('../../src/shared/logger', () => ({
  createLogger: () => ({
    warn: (...args) => mockWarn(...args),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock('../../src/renderer/services/ipc', () => ({
  getElectronAPI: () => ({
    llama: {},
    vectorDb: { getStats: (...args) => mockGetStats(...args) }
  }),
  systemIpc: {
    getMetrics: (...args) => mockGetMetrics(...args),
    getDegradedState: (...args) => mockGetDegradedState(...args)
  },
  llamaIpc: {
    getConfig: (...args) => mockGetConfig(...args),
    testConnection: (...args) => mockTestConnection(...args)
  },
  embeddingsIpc: {
    getStatsCached: jest.fn()
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

describe('DiagnosticsSnapshotSection llama probe', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMetrics.mockResolvedValue({
      uptime: 1000,
      processedFiles: 1,
      successfulOperations: 1,
      failedOperations: 0,
      avgProcessingTime: 10,
      errorRate: 0,
      memory: { used: 1, total: 2, percentage: 50 },
      env: {}
    });
    mockGetDegradedState.mockResolvedValue({ flags: [] });
    mockGetConfig.mockResolvedValue({ textModel: 'text-m', embeddingModel: 'embed-m' });
    mockGetStats.mockResolvedValue({ totalDocuments: 3, dimensions: 768, healthy: true });
  });

  test('treats an in-flight llama:test-connection as benign (no alert, no warn)', async () => {
    mockTestConnection.mockRejectedValue(
      new Error('IPC Error: Operation already in progress: llama:test-connection')
    );

    render(<DiagnosticsSnapshotSection />);

    expect(await screen.findByText('Text model')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mockWarn).not.toHaveBeenCalledWith(
      expect.stringContaining('llama health'),
      expect.anything()
    );
  });

  test('still surfaces a genuine llama health failure', async () => {
    mockTestConnection.mockRejectedValue(new Error('model crashed'));

    render(<DiagnosticsSnapshotSection />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/model crashed/);
  });
});
