/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import '@testing-library/jest-dom';

jest.mock('../../src/renderer/components/ui/Button', () => ({
  __esModule: true,
  default: ({ children, ...props }) => <button {...props}>{children}</button>
}));

jest.mock('../../src/renderer/components/settings/SettingsCard', () => ({
  __esModule: true,
  default: ({ title, description, children }) => (
    <div data-testid="settings-card">
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </div>
  )
}));

jest.mock('../../src/renderer/components/settings/SettingRow', () => ({
  __esModule: true,
  default: ({ label, children }) => (
    <div data-testid="setting-row">
      {label && <label>{label}</label>}
      {children}
    </div>
  )
}));

import mcpReducer, {
  enableMcpServer,
  disableMcpServer,
  rotateToken,
  getConfigSnippet,
  testConnection,
  refreshStatus
} from '../../src/renderer/store/slices/mcpServerSlice';
import McpServerSection from '../../src/renderer/components/settings/McpServerSection';

beforeEach(() => {
  global.window.electronAPI = {
    mcp: {
      enable: jest.fn(async () => ({ port: 53827, tokenMasked: 'abcd....' })),
      disable: jest.fn(async () => undefined),
      rotateToken: jest.fn(async () => ({ tokenMasked: 'efgh....' })),
      getConfigSnippet: jest.fn(async (c) => ({ snippet: `${c}-snippet` })),
      testConnection: jest.fn(async () => ({ tools: ['list_smart_folders'] })),
      status: jest.fn(async () => ({ status: 'stopped', port: null, enabled: false })),
      onStatusChanged: jest.fn(() => () => {})
    }
  };
  global.navigator.clipboard = {
    writeText: jest.fn(async () => {})
  };
});

const renderSection = (preloaded) => {
  const store = configureStore({
    reducer: { mcp: mcpReducer },
    preloadedState: {
      mcp: {
        enabled: false,
        status: 'stopped',
        port: null,
        tokenMasked: null,
        lastError: null,
        isWorking: false,
        ...preloaded
      }
    }
  });
  return render(
    <Provider store={store}>
      <McpServerSection addNotification={jest.fn()} />
    </Provider>
  );
};

describe('McpServerSection', () => {
  afterEach(() => {
    delete global.window.electronAPI;
    delete global.navigator.clipboard;
  });

  test('renders with master toggle off by default', () => {
    renderSection({});
    const checkbox = screen.getByLabelText(/Enable MCP server/i);
    expect(checkbox).not.toBeChecked();
  });

  test('renders title and description', () => {
    renderSection({});
    expect(screen.getByRole('heading', { name: /MCP Server/i })).toBeInTheDocument();
    expect(screen.getByText(/Let Claude, Cursor, Zed/i)).toBeInTheDocument();
  });

  test('shows status and tools when enabled', () => {
    renderSection({ enabled: true, status: 'running', port: 53827 });
    expect(screen.getByText(/Running on http:\/\/127.0.0.1:53827\/mcp/)).toBeInTheDocument();
    expect(screen.getByText(/search_documents/)).toBeInTheDocument();
    expect(screen.getByText(/chat_with_documents/)).toBeInTheDocument();
  });

  test('hides status and tools when disabled', () => {
    renderSection({ enabled: false });
    expect(screen.queryByText(/search_documents/)).not.toBeInTheDocument();
  });

  test('displays error message when lastError is set', () => {
    renderSection({ lastError: 'Server failed to start' });
    expect(screen.getByRole('alert')).toHaveTextContent('Server failed to start');
  });

  test('shows masked token by default', () => {
    renderSection({ enabled: true, tokenMasked: 'abcd....' });
    const codeElements = screen.getAllByText('••••••••');
    expect(codeElements.length).toBeGreaterThan(0);
  });

  test('toggles token visibility', () => {
    renderSection({ enabled: true, tokenMasked: 'abcd....' });
    const showButton = screen.getByRole('button', { name: /Show/i });
    fireEvent.click(showButton);
    expect(screen.getByText('abcd....')).toBeInTheDocument();
  });

  test('disables test connection button when status is not running', () => {
    renderSection({ enabled: true, status: 'stopped' });
    const testButton = screen.getByRole('button', { name: /Test connection/i });
    expect(testButton).toBeDisabled();
  });

  test('enables test connection button when status is running', () => {
    renderSection({ enabled: true, status: 'running', port: 53827 });
    const testButton = screen.getByRole('button', { name: /Test connection/i });
    expect(testButton).not.toBeDisabled();
  });

  test('clicking test connection calls testConnection thunk', async () => {
    renderSection({ enabled: true, status: 'running', port: 53827 });
    const testButton = screen.getByRole('button', { name: /Test connection/i });
    fireEvent.click(testButton);
    await waitFor(() => expect(window.electronAPI.mcp.testConnection).toHaveBeenCalled());
  });

  test('calls addNotification on test connection success', async () => {
    const addNotification = jest.fn();
    const store = configureStore({
      reducer: { mcp: mcpReducer },
      preloadedState: {
        mcp: {
          enabled: true,
          status: 'running',
          port: 53827,
          tokenMasked: 'test',
          lastError: null,
          isWorking: false
        }
      }
    });
    render(
      <Provider store={store}>
        <McpServerSection addNotification={addNotification} />
      </Provider>
    );
    const testButton = screen.getByRole('button', { name: /Test connection/i });
    fireEvent.click(testButton);
    await waitFor(() => {
      expect(addNotification).toHaveBeenCalledWith(expect.stringContaining('Connected'), 'success');
    });
  });

  test('calls addNotification on rotate token success', async () => {
    const addNotification = jest.fn();
    global.window.confirm = jest.fn(() => true);
    const store = configureStore({
      reducer: { mcp: mcpReducer },
      preloadedState: {
        mcp: {
          enabled: true,
          status: 'running',
          port: 53827,
          tokenMasked: 'test',
          lastError: null,
          isWorking: false
        }
      }
    });
    render(
      <Provider store={store}>
        <McpServerSection addNotification={addNotification} />
      </Provider>
    );
    const rotateButton = screen.getByRole('button', { name: /Rotate/i });
    fireEvent.click(rotateButton);
    await waitFor(() => {
      expect(addNotification).toHaveBeenCalledWith('Token rotated.', 'success');
    });
  });

  test('copies config snippet on button click', async () => {
    const addNotification = jest.fn();
    const store = configureStore({
      reducer: { mcp: mcpReducer },
      preloadedState: {
        mcp: {
          enabled: true,
          status: 'running',
          port: 53827,
          tokenMasked: 'test',
          lastError: null,
          isWorking: false
        }
      }
    });
    render(
      <Provider store={store}>
        <McpServerSection addNotification={addNotification} />
      </Provider>
    );
    const copyButton = screen.getByRole('button', { name: /Copy Claude Desktop config/i });
    fireEvent.click(copyButton);
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('claudeDesktop-snippet');
      expect(addNotification).toHaveBeenCalledWith('Copied claudeDesktop snippet.', 'success');
    });
  });

  test('disables toggle button when isWorking is true', () => {
    renderSection({ isWorking: true });
    const checkbox = screen.getByLabelText(/Enable MCP server/i);
    expect(checkbox).toBeDisabled();
  });

  test('calls refreshStatus on mount', async () => {
    renderSection({});
    await waitFor(() => expect(window.electronAPI.mcp.status).toHaveBeenCalled());
  });

  test('subscribes to onStatusChanged on mount', async () => {
    renderSection({});
    await waitFor(() => expect(window.electronAPI.mcp.onStatusChanged).toHaveBeenCalled());
  });

  test('shows all four tools when enabled', () => {
    renderSection({ enabled: true });
    expect(screen.getByText('search_documents')).toBeInTheDocument();
    expect(screen.getByText('chat_with_documents')).toBeInTheDocument();
    expect(screen.getByText('get_document_summary')).toBeInTheDocument();
    expect(screen.getByText('list_smart_folders')).toBeInTheDocument();
  });

  test('cancel token rotation does nothing', async () => {
    const addNotification = jest.fn();
    global.window.confirm = jest.fn(() => false);
    const store = configureStore({
      reducer: { mcp: mcpReducer },
      preloadedState: {
        mcp: {
          enabled: true,
          status: 'running',
          port: 53827,
          tokenMasked: 'test',
          lastError: null,
          isWorking: false
        }
      }
    });
    render(
      <Provider store={store}>
        <McpServerSection addNotification={addNotification} />
      </Provider>
    );
    const rotateButton = screen.getByRole('button', { name: /Rotate/i });
    fireEvent.click(rotateButton);
    await waitFor(() => {
      expect(window.electronAPI.mcp.rotateToken).not.toHaveBeenCalled();
    });
  });
});
