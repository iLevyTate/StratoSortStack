/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import '@testing-library/jest-dom';

jest.mock('../../src/renderer/components/ui/Button', () => ({
  __esModule: true,
  default: ({ children, ...props }) => <button {...props}>{children}</button>
}));

jest.mock('../../src/renderer/components/settings/SettingsCard', () => ({
  __esModule: true,
  default: ({ title, children }) => (
    <div>
      <h2>{title}</h2>
      {children}
    </div>
  )
}));

// Unlike McpServerSection.test.js, this mock renders the row description,
// which is where the "starts with StratoSort" line lives.
jest.mock('../../src/renderer/components/settings/SettingRow', () => ({
  __esModule: true,
  default: ({ label, description, children }) => (
    <div>
      {label && <h3>{label}</h3>}
      {description && <p>{description}</p>}
      {children}
    </div>
  )
}));

import mcpReducer from '../../src/renderer/store/slices/mcpServerSlice';
import McpServerSection from '../../src/renderer/components/settings/McpServerSection';

beforeEach(() => {
  global.window.electronAPI = {
    mcp: {
      // Never settles, so the preloaded state is what each test sees.
      status: jest.fn(() => new Promise(() => {})),
      onStatusChanged: jest.fn(() => () => {})
    }
  };
});

afterEach(() => {
  delete global.window.electronAPI;
});

const renderSection = (preloaded) => {
  const store = configureStore({
    reducer: { mcp: mcpReducer },
    preloadedState: {
      mcp: {
        enabled: true,
        status: 'running',
        port: 53827,
        tokenMasked: 'abcd....',
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

describe('McpServerSection plain words (tester retest)', () => {
  test('says the server starts with StratoSort while the box is ticked', () => {
    renderSection({ enabled: false, status: 'stopped', port: null });
    expect(
      screen.getByText('Starts with StratoSort while this box is ticked.')
    ).toBeInTheDocument();
  });

  test('describes each tool in plain words', () => {
    renderSection({});
    expect(screen.getByText(/Find documents by meaning or by exact words\./)).toBeInTheDocument();
    expect(
      screen.getByText(/Answer a question from your documents and name the files used\./)
    ).toBeInTheDocument();
    expect(screen.getByText(/Read the saved summary of one document\./)).toBeInTheDocument();
    expect(screen.getByText(/List your smart folders and where they are\./)).toBeInTheDocument();
    expect(screen.queryByText(/RAG|Hybrid semantic|Cached LLM|Enumerate/)).not.toBeInTheDocument();
  });

  test('says the tools only read and never move, rename or delete files', () => {
    renderSection({});
    expect(
      screen.getByText('These tools only read. None of them moves, renames or deletes files.')
    ).toBeInTheDocument();
  });

  test('the token button says it shows only the start of the token', () => {
    renderSection({});
    const show = screen.getByRole('button', { name: /show start of token/i });
    expect(show).toHaveTextContent('Show start');
    fireEvent.click(show);
    expect(screen.getByText('abcd....')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /hide/i })).toHaveTextContent('Hide');
  });

  test('no "Show start" button when the token start is not known yet (started on launch)', () => {
    renderSection({ tokenMasked: null });
    expect(screen.queryByRole('button', { name: /show start of token/i })).not.toBeInTheDocument();
    expect(screen.getByText('••••••••')).toBeInTheDocument();
  });

  test('a server that could not start says what to do, not just "error"', () => {
    renderSection({ status: 'error', port: null });
    expect(
      screen.getByText('Not running. Untick the box, then tick it again to retry.')
    ).toBeInTheDocument();
  });

  test('stopped and starting read as words, not raw states', () => {
    const { unmount } = renderSection({ status: 'starting', port: null });
    expect(screen.getByText('Starting…')).toBeInTheDocument();
    unmount();
    renderSection({ status: 'stopped', port: null });
    expect(screen.getByText('Stopped')).toBeInTheDocument();
  });
});
