/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import RelatedDocumentsPanel from '../../src/renderer/components/search/RelatedDocumentsPanel';

jest.mock('lucide-react', () => {
  const React = require('react');
  const I = (n) => (p) => React.createElement('span', { 'data-icon': n, ...p });
  return { Link: I('link'), Sparkles: I('sparkles'), Layers: I('layers'), X: I('x') };
});

jest.mock('../../src/renderer/components/ui/FileIcon', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: function FileIcon() {
      return React.createElement('span', { 'data-testid': 'file-icon' });
    }
  };
});

jest.mock('../../src/shared/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), debug: jest.fn() })
}));

const deferreds = [];

function makeStore() {
  return configureStore({
    reducer: {
      system: (state = { redactPaths: false, redactPathsLoaded: true }) => state
    }
  });
}

function ControllablePanel({ fileId, onClose = jest.fn(), onFocus = jest.fn() }) {
  return (
    <RelatedDocumentsPanel
      isOpen
      fileId={fileId}
      fileName="seed.txt"
      filePath="C:\\seed.txt"
      onClose={onClose}
      onFocusFile={onFocus}
    />
  );
}

beforeEach(() => {
  deferreds.length = 0;
  window.electronAPI = {
    knowledge: {
      getRelatedDocuments: jest.fn((_fileId, _opts) => {
        return new Promise((resolve) => {
          deferreds.push({ resolve });
        });
      })
    }
  };
});

describe('RelatedDocumentsPanel', () => {
  test('ignores stale IPC response when fileId changes (slow A, fast B)', async () => {
    const store = makeStore();
    const { rerender } = render(
      <Provider store={store}>
        <ControllablePanel fileId="file-a" />
      </Provider>
    );

    expect(deferreds).toHaveLength(1);

    rerender(
      <Provider store={store}>
        <ControllablePanel fileId="file-b" />
      </Provider>
    );
    expect(deferreds).toHaveLength(2);

    // Resolve the second request (B) first
    deferreds[1].resolve({
      success: true,
      edges: [{ id: 'eb', source: 'file-b', target: 'nb', reasons: [] }],
      files: { nb: { fileName: 'B-Neighbor', filePath: 'C:\\b.txt' } }
    });

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Focus related file in graph: B-Neighbor/ })
      ).toBeInTheDocument();
    });

    // Late resolve for A (should not replace UI)
    deferreds[0].resolve({
      success: true,
      edges: [{ id: 'ea', source: 'file-a', target: 'na', reasons: [] }],
      files: { na: { fileName: 'A-Late', filePath: 'C:\\a.txt' } }
    });

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Focus related file in graph: B-Neighbor/ })
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole('button', { name: /Focus related file in graph: A-Late/ })
    ).not.toBeInTheDocument();
  });

  test('panel surface uses the themed raised token, not hardcoded white (U-016)', () => {
    const store = makeStore();
    render(
      <Provider store={store}>
        <ControllablePanel fileId="file-a" />
      </Provider>
    );

    const panel = screen.getByRole('complementary', { name: 'Related documents' });
    expect(panel.style.backgroundColor).toBe('var(--surface-raised)');
    expect(panel.className).not.toMatch(/bg-white/);
  });
});
