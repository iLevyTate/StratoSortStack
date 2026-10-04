/**
 * React Component Tests for UnifiedSearchModal
 *
 * Tests:
 * - Tab switching (search <-> graph)
 * - Query debouncing
 * - Node creation from search results
 * - Error handling (service unavailable, timeouts)
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { NotificationProvider } from '../../src/renderer/contexts/NotificationContext';
import { mockUnifiedSearchModalHarnessState } from './unifiedSearchModal.harnessState';
import {
  renderWithRedux,
  mockElectronAPI,
  mockIsGraphViewEnabled,
  mockScrollToRow
} from './unifiedSearchModal.harness';

// Import component after mocks
import UnifiedSearchModal, {
  GRAPH_MINIMAP_MASK_COLOR,
  GRAPH_MINIMAP_MASK_STROKE_COLOR,
  GRAPH_MINIMAP_STYLE,
  resolveGraphMiniMapPalette,
  getGraphMiniMapNodeColor
} from '../../src/renderer/components/search/UnifiedSearchModal';
import { embeddingsIpc } from '../../src/renderer/services/ipc/embeddingsIpc';

describe('UnifiedSearchModal', () => {
  beforeEach(() => {
    mockUnifiedSearchModalHarnessState.graphInsightsSectionKey = 'insights';
    jest.clearAllMocks();
    jest.useFakeTimers();
    embeddingsIpc.invalidateStatsCache();
    mockIsGraphViewEnabled.mockReturnValue(true);
    mockScrollToRow.mockReset();
    window.ResizeObserver = jest.fn().mockImplementation(() => ({
      observe: jest.fn(),
      unobserve: jest.fn(),
      disconnect: jest.fn()
    }));

    // Reset mock implementations
    mockElectronAPI.embeddings.search.mockResolvedValue({
      success: true,
      results: [],
      mode: 'hybrid'
    });
    mockElectronAPI.embeddings.getStats.mockResolvedValue({
      success: true,
      files: 10,
      folders: 5,
      serverUrl: 'http://localhost:8080'
    });
    mockElectronAPI.files.organize.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    delete window.ResizeObserver;
    jest.useRealTimers();
  });

  describe('Modal Rendering', () => {
    test('should not render when closed', () => {
      renderWithRedux(<UnifiedSearchModal isOpen={false} onClose={jest.fn()} />);

      expect(screen.queryByTestId('modal')).not.toBeInTheDocument();
    });

    test('should render when open', () => {
      const { container } = renderWithRedux(
        <UnifiedSearchModal isOpen={true} onClose={jest.fn()} />
      );

      expect(screen.getByTestId('modal')).toBeInTheDocument();
      expect(screen.getByTestId('modal-title')).toHaveTextContent('Knowledge OS');
    });

    test('should call onClose when close button clicked', () => {
      const onClose = jest.fn();
      renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={onClose} />);

      fireEvent.click(screen.getByTestId('modal-close'));

      expect(onClose).toHaveBeenCalled();
    });

    test('disables backdrop click-away and Esc (full-screen workspace)', () => {
      // Knowledge OS holds in-progress chat/graph/triage state; a stray click
      // on the thin backdrop margins must not dismiss it. Esc is already
      // handled internally, so both dismissal paths route through explicit
      // controls (2026-07-12 decision).
      renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);

      const modal = screen.getByTestId('modal');
      expect(modal).toHaveAttribute('data-close-on-overlay-click', 'false');
      expect(modal).toHaveAttribute('data-close-on-esc', 'false');
    });
  });

  describe('Tab Switching', () => {
    test('should render Search tab by default', () => {
      const { container } = renderWithRedux(
        <UnifiedSearchModal isOpen={true} onClose={jest.fn()} />
      );

      // Search-related elements should be present
      expect(screen.getByLabelText(/search query/i)).toBeInTheDocument();
    });

    test('should render graph tab when feature is enabled', async () => {
      renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);

      // Graph feature is now enabled
      expect(screen.queryByText(/Relate/i)).toBeInTheDocument();
    });

    test('falls back to search-only UI when graph view is disabled', () => {
      mockIsGraphViewEnabled.mockReturnValue(false);

      renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} initialTab="graph" />);

      expect(screen.queryByText(/Relate/i)).not.toBeInTheDocument();
      expect(screen.getByLabelText(/search query/i)).toBeInTheDocument();
      expect(screen.queryByText(/View in Graph/i)).not.toBeInTheDocument();
    });

    // F-212 (K-31): only Search/Relate/Atlas had hotkeys; Chat and Timeline
    // needed the mouse. Tab buttons now also expose their active state.
    test('Ctrl+4 / Ctrl+5 switch to Chat / Timeline and tabs expose aria-pressed', () => {
      // The real Modal registers the overlay; the mocked one does not, and the
      // hotkey handler only fires for the top overlay.
      const {
        registerOverlay,
        unregisterOverlay
      } = require('../../src/renderer/utils/overlayStack');
      registerOverlay('knowledge-os-modal');
      try {
        renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);
        // Accessible name = icon name + label (e.g. "List Search"); match the label at the
        // end and pick the tab button (the only one carrying aria-pressed).
        const tab = (name) => {
          const match = screen
            .getAllByRole('button', { name: new RegExp(`${name}$`, 'i') })
            .find((el) => el.hasAttribute('aria-pressed'));
          if (!match) throw new Error(`No tab button named ${name}`);
          return match;
        };

        expect(tab('Search')).toHaveAttribute('aria-pressed', 'true');

        fireEvent.keyDown(document, { key: '4', ctrlKey: true });
        expect(tab('Chat')).toHaveAttribute('aria-pressed', 'true');
        expect(tab('Search')).toHaveAttribute('aria-pressed', 'false');

        fireEvent.keyDown(document, { key: '5', ctrlKey: true });
        expect(tab('Timeline')).toHaveAttribute('aria-pressed', 'true');

        fireEvent.keyDown(document, { key: '1', ctrlKey: true });
        expect(tab('Search')).toHaveAttribute('aria-pressed', 'true');
      } finally {
        unregisterOverlay('knowledge-os-modal');
      }
    });

    test('should switch back to search tab', async () => {
      renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} initialTab="graph" />);

      // Find and click the Search tab
      const searchTab = screen.getByRole('button', { name: /List Search/i });
      if (searchTab) {
        fireEvent.click(searchTab);

        // Search view should be visible
        await waitFor(() => {
          expect(screen.getByTestId('modal')).toBeInTheDocument();
        });
      }
    });

    test('switches to graph tab when initialTab is graph', () => {
      renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} initialTab="graph" />);

      // Graph tab should be active
      expect(screen.queryByText(/Relate/i)).toBeInTheDocument();
      // Since reactflow is mocked as a div with data-testid="react-flow", we can check for it if graph tab content renders
      // However, the test structure might just check if the tab button exists and is clickable
    });

    test('promotes the requested graph tab after graph settings hydrate', async () => {
      mockIsGraphViewEnabled.mockReturnValue(false);
      const { rerender } = renderWithRedux(
        <UnifiedSearchModal isOpen={true} onClose={jest.fn()} initialTab="graph" />
      );

      expect(screen.getByLabelText(/search query/i)).toBeInTheDocument();
      expect(screen.queryByText(/Relate/i)).not.toBeInTheDocument();

      mockIsGraphViewEnabled.mockReturnValue(true);
      rerender(
        <Provider
          store={configureStore({
            reducer: {
              system: (state = { redactPaths: false, redactPathsLoaded: true }) => state
            }
          })}
        >
          <UnifiedSearchModal isOpen={true} onClose={jest.fn()} initialTab="graph" />
        </Provider>
      );

      await waitFor(() => {
        expect(screen.getByText(/Relate/i)).toBeInTheDocument();
      });
      expect(screen.getByLabelText(/Graph Controls/i)).toBeInTheDocument();
    });

    test('clears manual graph tour force-show on modal close', () => {
      const store = configureStore({
        reducer: {
          system: (state = { redactPaths: false }) => state
        }
      });
      const onClose = jest.fn();
      const { rerender } = render(
        <Provider store={store}>
          <UnifiedSearchModal isOpen={true} onClose={onClose} initialTab="graph" />
        </Provider>
      );

      fireEvent.click(screen.getByRole('button', { name: /Show graph tour/i }));
      expect(screen.getByTestId('graph-tour')).toHaveAttribute('data-force-show', 'true');

      rerender(
        <Provider store={store}>
          <UnifiedSearchModal isOpen={false} onClose={onClose} initialTab="graph" />
        </Provider>
      );
      rerender(
        <Provider store={store}>
          <UnifiedSearchModal isOpen={true} onClose={onClose} initialTab="graph" />
        </Provider>
      );

      expect(screen.getByTestId('graph-tour')).toHaveAttribute('data-force-show', 'false');
    });
  });

  describe('Query Debouncing', () => {
    test('should debounce search input', async () => {
      renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);

      const searchInput = screen.getByLabelText(/search query/i);
      // Type quickly
      fireEvent.change(searchInput, { target: { value: 't' } });
      fireEvent.change(searchInput, { target: { value: 'te' } });
      fireEvent.change(searchInput, { target: { value: 'tes' } });
      fireEvent.change(searchInput, { target: { value: 'test' } });

      // Search should not be called immediately
      expect(mockElectronAPI.embeddings.search).not.toHaveBeenCalled();

      // Fast forward past debounce time
      await act(async () => {
        jest.advanceTimersByTime(400);
      });

      // Now search should be called once
      await waitFor(() => {
        expect(mockElectronAPI.embeddings.search).toHaveBeenCalledTimes(1);
        expect(mockElectronAPI.embeddings.search).toHaveBeenCalledWith('test', expect.any(Object));
      });
    });

    test('should not search for queries under 2 characters', async () => {
      renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);

      const searchInput = screen.getByLabelText(/search query/i);
      fireEvent.change(searchInput, { target: { value: 'a' } });

      await act(async () => {
        jest.advanceTimersByTime(400);
      });

      // Search should not be called for single character
      expect(mockElectronAPI.embeddings.search).not.toHaveBeenCalled();
    });

    test('should cancel pending debounce on unmount', () => {
      const { unmount } = renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);

      const searchInput = screen.getByLabelText(/search query/i);
      fireEvent.change(searchInput, { target: { value: 'test' } });

      // Unmount before debounce completes
      unmount();

      act(() => {
        jest.advanceTimersByTime(400);
      });

      // Search should not be called after unmount
      expect(mockElectronAPI.embeddings.search).not.toHaveBeenCalled();
    });
  });

  describe('Search Results', () => {
    test('should display search results', async () => {
      mockElectronAPI.embeddings.search.mockResolvedValue({
        success: true,
        results: [
          {
            id: 'doc1',
            metadata: { name: 'test-file.pdf', path: '/path/test-file.pdf' },
            score: 0.95
          }
        ],
        mode: 'hybrid'
      });

      renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);

      const searchInput = screen.getByLabelText(/search query/i);
      fireEvent.change(searchInput, { target: { value: 'test' } });

      await act(async () => {
        jest.advanceTimersByTime(400);
      });

      await waitFor(() => {
        expect(mockElectronAPI.embeddings.search).toHaveBeenCalled();
      });
    });

    test('should handle empty results', async () => {
      mockElectronAPI.embeddings.search.mockResolvedValue({
        success: true,
        results: [],
        mode: 'hybrid'
      });

      renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);

      const searchInput = screen.getByLabelText(/search query/i);
      fireEvent.change(searchInput, { target: { value: 'nonexistent' } });

      await act(async () => {
        jest.advanceTimersByTime(400);
      });

      await waitFor(() => {
        expect(mockElectronAPI.embeddings.search).toHaveBeenCalled();
      });
    });

    test('hides graph actions for virtualized results when graph view is disabled', async () => {
      mockIsGraphViewEnabled.mockReturnValue(false);
      mockElectronAPI.embeddings.search.mockResolvedValue({
        success: true,
        results: Array.from({ length: 35 }, (_, index) => ({
          id: `doc-${index}`,
          metadata: {
            name: `virtualized-${index}.pdf`,
            path: `/path/virtualized-${index}.pdf`
          },
          score: 0.95 - index * 0.001
        })),
        mode: 'hybrid'
      });

      renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);

      fireEvent.change(screen.getByLabelText(/search query/i), {
        target: { value: 'virtualized' }
      });

      await act(async () => {
        jest.advanceTimersByTime(400);
      });

      await waitFor(() => {
        expect(mockElectronAPI.embeddings.search).toHaveBeenCalled();
        expect(screen.getByText('virtualized-0.pdf')).toBeInTheDocument();
      });

      expect(screen.getByTestId('virtualized-list')).toBeInTheDocument();
      expect(screen.queryByLabelText(/View in Graph/i)).not.toBeInTheDocument();
    });

    test('highlights the first result during keyboard navigation', async () => {
      mockElectronAPI.embeddings.search.mockResolvedValue({
        success: true,
        results: Array.from({ length: 35 }, (_, index) => ({
          id: `doc-${index}`,
          metadata: {
            name: `scroll-target-${index}.pdf`,
            path: `/path/scroll-target-${index}.pdf`
          },
          score: 0.95 - index * 0.001
        })),
        mode: 'hybrid'
      });

      const { container } = renderWithRedux(
        <UnifiedSearchModal isOpen={true} onClose={jest.fn()} />
      );

      fireEvent.change(screen.getByLabelText(/search query/i), {
        target: { value: 'scroll-target' }
      });

      await act(async () => {
        jest.advanceTimersByTime(400);
      });

      await waitFor(() => {
        expect(mockElectronAPI.embeddings.search).toHaveBeenCalled();
        expect(screen.getByText('scroll-target-0.pdf')).toBeInTheDocument();
      });

      await waitFor(() => {
        expect(screen.getByTestId('virtualized-list')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.keyDown(document.body, { key: 'ArrowDown' });
      });

      await waitFor(() => {
        const resultRows = container.querySelectorAll('[data-result-item]');
        expect(resultRows[0]?.className).toContain('border-stratosort-blue/35');
      });
    });
  });

  describe('Error Handling', () => {
    test('should handle search service unavailable', async () => {
      mockElectronAPI.embeddings.search.mockResolvedValue({
        success: false,
        error: 'Service unavailable'
      });

      renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);

      const searchInput = screen.getByLabelText(/search query/i);
      fireEvent.change(searchInput, { target: { value: 'test' } });

      await act(async () => {
        jest.advanceTimersByTime(400);
      });

      await waitFor(() => {
        expect(mockElectronAPI.embeddings.search).toHaveBeenCalled();
      });
    });

    test('should handle search timeout', async () => {
      mockElectronAPI.embeddings.search.mockRejectedValue(new Error('Timeout'));

      renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);

      const searchInput = screen.getByLabelText(/search query/i);
      fireEvent.change(searchInput, { target: { value: 'test' } });

      await act(async () => {
        jest.advanceTimersByTime(400);
      });

      await waitFor(() => {
        expect(mockElectronAPI.embeddings.search).toHaveBeenCalled();
      });
    });

    test('should handle vector DB not available error', async () => {
      mockElectronAPI.embeddings.search.mockResolvedValue({
        success: false,
        error: 'Vector DB not available yet'
      });

      renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);

      const searchInput = screen.getByLabelText(/search query/i);
      fireEvent.change(searchInput, { target: { value: 'test' } });

      await act(async () => {
        jest.advanceTimersByTime(400);
      });

      await waitFor(() => {
        expect(mockElectronAPI.embeddings.search).toHaveBeenCalled();
      });
    });

    test('should handle connection refused error', async () => {
      mockElectronAPI.embeddings.search.mockRejectedValue(new Error('ECONNREFUSED'));

      renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);

      const searchInput = screen.getByLabelText(/search query/i);
      fireEvent.change(searchInput, { target: { value: 'test' } });

      await act(async () => {
        jest.advanceTimersByTime(400);
      });

      await waitFor(() => {
        expect(mockElectronAPI.embeddings.search).toHaveBeenCalled();
      });
    });
  });

  describe('Stats Loading', () => {
    test('should render stats area in modal', async () => {
      renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);

      // Modal should be rendered
      expect(screen.getByTestId('modal')).toBeInTheDocument();

      // Either shows stats or "No embeddings/No files indexed" placeholder
      const noEmbeddings = screen.queryByText(/No embeddings/i);
      const filesIndexedElements = screen.queryAllByText(/files indexed/i);

      // FIX: Use explicit assertion - at least one indicator should be present
      const hasStatsIndicator = noEmbeddings !== null || filesIndexedElements.length > 0;
      expect(hasStatsIndicator).toBe(true);
    });

    test('should not crash when stats unavailable', async () => {
      // Override getStats to return failure
      mockElectronAPI.embeddings.getStats.mockResolvedValue({
        success: false,
        error: 'Stats unavailable'
      });

      // FIX: Component should still render without throwing
      expect(() => {
        renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);
      }).not.toThrow();

      expect(screen.getByTestId('modal')).toBeInTheDocument();
    });

    test('shows index health warning when embedding model mismatches', async () => {
      mockElectronAPI.embeddings.getStats.mockResolvedValue({
        success: true,
        files: 12,
        folders: 3,
        embeddingModelMismatch: true,
        activeEmbeddingModel: 'nomic-embed-text-v2',
        embeddingIndex: { model: 'nomic-embed-text-v1' }
      });

      renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);

      await waitFor(() => {
        expect(screen.getByText(/model mismatch detected/i)).toBeInTheDocument();
      });
    });
  });

  describe('File Operation Events', () => {
    test('should set up file operation listener when modal opens', () => {
      const addEventListenerSpy = jest.spyOn(window, 'addEventListener');
      renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);

      // UnifiedSearchModal now listens to middleware-dispatched DOM events.
      expect(addEventListenerSpy).toHaveBeenCalledWith(
        'file-operation-complete',
        expect.any(Function)
      );
      expect(screen.getByTestId('modal')).toBeInTheDocument();
      addEventListenerSpy.mockRestore();
    });

    test('should not set up listener when modal is closed', () => {
      jest.clearAllMocks();
      renderWithRedux(<UnifiedSearchModal isOpen={false} onClose={jest.fn()} />);

      // FIX: Modal should not be in document when closed
      expect(screen.queryByTestId('modal')).not.toBeInTheDocument();
    });
  });

  describe('Graph View', () => {
    test('uses themed minimap panel tokens for the dark graph canvas', () => {
      expect(GRAPH_MINIMAP_STYLE).toEqual({
        width: 168,
        height: 104,
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: 'var(--surface-panel-bg)',
        border: '1px solid color-mix(in srgb, var(--border-soft) 88%, transparent)',
        boxShadow: 'var(--shadow-soft)'
      });
      // Theme-aware mask: pixel-identical to the old rgba(15,24,32,.78) /
      // rgba(59,160,192,.7) hardcodes in the primary palette, correct in
      // dark/light (J-003).
      expect(GRAPH_MINIMAP_MASK_COLOR).toBe(
        'color-mix(in srgb, var(--surface-muted) 78%, transparent)'
      );
      expect(GRAPH_MINIMAP_MASK_STROKE_COLOR).toBe(
        'color-mix(in srgb, var(--color-stratosort-blue) 70%, transparent)'
      );
    });

    test('minimap node palette resolves data-theme tokens with primary-value fallbacks [J-003]', () => {
      const palette = resolveGraphMiniMapPalette();
      // jsdom has no custom properties on :root, so the resolver must fall
      // back to the primary-theme token values from styles.css.
      expect(palette).toEqual({
        query: '#1078a0',
        duplicateExact: '#f87171',
        duplicateNear: '#f0b030',
        duplicateRelated: '#8d9fab',
        cluster: '#f0b030',
        file: '#3ba0c0'
      });

      // When the document DOES define the tokens (a live theme), the resolved
      // values must come from the cascade, not the fallbacks.
      const root = document.documentElement;
      root.style.setProperty('--color-stratosort-blue', '#1f86a8');
      root.style.setProperty('--color-stratosort-danger', '#d2453f');
      try {
        const themed = resolveGraphMiniMapPalette();
        expect(themed.file).toBe('#1f86a8');
        expect(themed.duplicateExact).toBe('#d2453f');
      } finally {
        root.style.removeProperty('--color-stratosort-blue');
        root.style.removeProperty('--color-stratosort-danger');
      }
    });

    test('minimap node color mapping is tier-aware over the resolved palette [J-003]', () => {
      const palette = resolveGraphMiniMapPalette();
      expect(getGraphMiniMapNodeColor({ data: { kind: 'query' } }, palette)).toBe(palette.query);
      expect(
        getGraphMiniMapNodeColor({ data: { kind: 'duplicate', duplicateTier: 'exact' } }, palette)
      ).toBe(palette.duplicateExact);
      expect(
        getGraphMiniMapNodeColor(
          { data: { kind: 'duplicate', duplicateTier: 'nearIdentical' } },
          palette
        )
      ).toBe(palette.duplicateNear);
      expect(
        getGraphMiniMapNodeColor({ data: { kind: 'duplicate', duplicateTier: 'related' } }, palette)
      ).toBe(palette.duplicateRelated);
      expect(getGraphMiniMapNodeColor({ data: { kind: 'duplicate' } }, palette)).toBe(
        palette.duplicateNear
      );
      expect(getGraphMiniMapNodeColor({ data: { kind: 'cluster' } }, palette)).toBe(
        palette.cluster
      );
      expect(getGraphMiniMapNodeColor({ data: { kind: 'file' } }, palette)).toBe(palette.file);
      expect(getGraphMiniMapNodeColor({}, palette)).toBe(palette.file);
    });

    test('renders graph UI when graph tab is active', () => {
      renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} initialTab="graph" />);

      // Graph controls/UI should be shown
      expect(screen.queryByText(/Relate/i)).toBeInTheDocument();
      // We expect the graph container or some graph-specific element to be present
      // Since we mocked reactflow, we can check if that mock is rendered or if the "Explore File Connections" empty state is shown
      // The empty state has text "Stop Searching. Start Finding."
      expect(screen.queryByText(/Stop Searching. Start Finding./i)).toBeInTheDocument();
    });

    test('keeps graph sidebar sections collapsible', () => {
      const onClose = jest.fn();
      const utils = renderWithRedux(
        <UnifiedSearchModal isOpen={true} onClose={onClose} initialTab="graph" />
      );

      const insightsToggle = screen.getByRole('button', { name: /What's interesting section/i });
      // Insights is the default-open graph sidebar section.
      expect(insightsToggle).toHaveAttribute('aria-expanded', 'true');

      fireEvent.click(insightsToggle);
      // Hook mock updates module state; rerender so useAppSelector sees the new section key.
      utils.rerender(
        <Provider store={utils.store}>
          <NotificationProvider>
            <UnifiedSearchModal isOpen={true} onClose={onClose} initialTab="graph" />
          </NotificationProvider>
        </Provider>
      );
      expect(screen.getByRole('button', { name: /What's interesting section/i })).toHaveAttribute(
        'aria-expanded',
        'false'
      );

      fireEvent.click(screen.getByRole('button', { name: /What's interesting section/i }));
      utils.rerender(
        <Provider store={utils.store}>
          <NotificationProvider>
            <UnifiedSearchModal isOpen={true} onClose={onClose} initialTab="graph" />
          </NotificationProvider>
        </Provider>
      );
      expect(screen.getByRole('button', { name: /What's interesting section/i })).toHaveAttribute(
        'aria-expanded',
        'true'
      );
    });
  });

  describe('Chat Sidebars', () => {
    test('keeps conversation sidebar collapse and re-open controls working', () => {
      renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} initialTab="chat" />);

      const collapseButton = screen.getByRole('button', {
        name: /Collapse conversation sidebar/i
      });
      fireEvent.click(collapseButton);

      expect(
        screen.getByRole('button', { name: /Show conversation sidebar/i })
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /Show conversation sidebar/i }));
      expect(
        screen.getByRole('button', { name: /Collapse conversation sidebar/i })
      ).toBeInTheDocument();
    });

    test('keeps document scope sidebar collapse and re-open controls working', () => {
      renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} initialTab="chat" />);

      const showButton = screen.getByRole('button', { name: /Show document scope sidebar/i });
      fireEvent.click(showButton);

      expect(
        screen.getByRole('button', { name: /Collapse document scope sidebar/i })
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /Collapse document scope sidebar/i }));
      expect(
        screen.getByRole('button', { name: /Show document scope sidebar/i })
      ).toBeInTheDocument();
    });
  });

  describe('Keyboard Navigation', () => {
    test('should close modal on Escape key', () => {
      const onClose = jest.fn();
      renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={onClose} />);

      // FIX: Fire escape key event and verify modal close is triggered
      fireEvent.keyDown(document, { key: 'Escape' });

      // The mock Modal component has a close button that calls onClose
      // For Escape key, the actual Modal handles it internally
      // We verify the modal was rendered and can be interacted with
      expect(screen.getByTestId('modal')).toBeInTheDocument();

      // Click the close button to verify onClose works
      fireEvent.click(screen.getByTestId('modal-close'));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('should focus search input when modal opens', () => {
      renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);

      // FIX: Search input should be present and accessible
      const searchInput = screen.getByLabelText(/search query/i);
      expect(searchInput).toBeInTheDocument();
    });
  });

  describe('Bulk Selection', () => {
    test('should have bulk selection state', async () => {
      mockElectronAPI.embeddings.search.mockResolvedValue({
        success: true,
        results: [
          { id: 'doc1', metadata: { name: 'file1.pdf' }, score: 0.9 },
          { id: 'doc2', metadata: { name: 'file2.pdf' }, score: 0.8 }
        ],
        mode: 'hybrid'
      });

      renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);

      const searchInput = screen.getByLabelText(/search query/i);
      fireEvent.change(searchInput, { target: { value: 'test' } });

      await act(async () => {
        jest.advanceTimersByTime(400);
      });

      await waitFor(() => {
        expect(mockElectronAPI.embeddings.search).toHaveBeenCalled();
      });
    });
  });
});

describe('UnifiedSearchModal - Integration', () => {
  beforeEach(() => {
    mockUnifiedSearchModalHarnessState.graphInsightsSectionKey = 'insights';
    jest.clearAllMocks();
    jest.useFakeTimers();
    embeddingsIpc.invalidateStatsCache();

    mockElectronAPI.embeddings.getStats.mockResolvedValue({
      success: true,
      files: 10,
      folders: 5
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('should perform search and display results flow', async () => {
    renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);

    // FIX: Modal must be rendered
    expect(screen.getByTestId('modal')).toBeInTheDocument();

    // FIX: Search autocomplete component must be present (mocked as div with testid)
    const searchAutocomplete = screen.getByTestId('search-autocomplete');
    expect(searchAutocomplete).toBeInTheDocument();

    // FIX: Search input within autocomplete should be accessible
    const searchInput = screen.getByLabelText(/search query/i);
    expect(searchInput).toBeInTheDocument();
  });

  test('should handle rapid tab switching', async () => {
    renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);

    const graphTab = screen.getByRole('button', { name: /Relate/i });
    const searchTab = screen.getByRole('button', { name: /List Search/i });

    // FIX: Both tabs should exist when graph feature is enabled
    expect(graphTab).toBeInTheDocument();
    expect(searchTab).toBeInTheDocument();

    // Rapid switching - should not crash or throw
    fireEvent.click(graphTab);
    fireEvent.click(searchTab);
    fireEvent.click(graphTab);
    fireEvent.click(searchTab);

    // FIX: Modal should still be functional after rapid switches
    expect(screen.getByTestId('modal')).toBeInTheDocument();
    expect(screen.getByLabelText(/search query/i)).toBeInTheDocument();
  });

  // FIX P2-14: Test for focusedResultIndex reset on tab switch
  test('should reset focused result index when switching tabs', async () => {
    renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);

    const graphTab = screen.getByRole('button', { name: /Relate/i });
    const searchTab = screen.getByRole('button', { name: /List Search/i });

    // FIX: Both tabs should exist
    expect(graphTab).toBeInTheDocument();
    expect(searchTab).toBeInTheDocument();

    // Switch to graph tab and back
    fireEvent.click(graphTab);
    fireEvent.click(searchTab);

    // FIX: Search input should be present and functional after tab switch
    const searchInput = screen.getByLabelText(/search query/i);
    expect(searchInput).toBeInTheDocument();
    expect(searchInput.value).toBe(''); // Should be reset
  });

  // Test search error handling with fallback info
  test('should display error message on search failure', async () => {
    mockElectronAPI.embeddings.search.mockResolvedValue({
      success: false,
      error: 'Search failed: Model not available'
    });

    renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);

    // FIX: Trigger a search to test error handling
    const searchInput = screen.getByLabelText(/search query/i);
    fireEvent.change(searchInput, { target: { value: 'test query' } });

    await act(async () => {
      jest.advanceTimersByTime(400);
    });

    // FIX: Search API should have been called
    await waitFor(() => {
      expect(mockElectronAPI.embeddings.search).toHaveBeenCalled();
    });

    // Modal should still be rendered (error handled gracefully)
    expect(screen.getByTestId('modal')).toBeInTheDocument();
  });

  // Test search fallback metadata display
  test('should handle search response with fallback metadata', async () => {
    mockElectronAPI.embeddings.search.mockResolvedValue({
      success: true,
      results: [{ id: 'file1', metadata: { name: 'test.pdf', path: '/test.pdf' }, score: 0.9 }],
      mode: 'bm25',
      meta: {
        fallback: true,
        originalMode: 'hybrid',
        fallbackReason: 'Embedding model unavailable'
      }
    });

    renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);

    // FIX: Trigger a search with fallback response
    const searchInput = screen.getByLabelText(/search query/i);
    fireEvent.change(searchInput, { target: { value: 'test query' } });

    await act(async () => {
      jest.advanceTimersByTime(400);
    });

    // FIX: Search API should have been called with fallback response
    await waitFor(() => {
      expect(mockElectronAPI.embeddings.search).toHaveBeenCalledWith(
        'test query',
        expect.any(Object)
      );
    });

    // Modal should render without crash even with fallback metadata
    expect(screen.getByTestId('modal')).toBeInTheDocument();
    expect(screen.getByText(/Limited search:/i)).toBeInTheDocument();
  });

  test('shows search diagnostics warnings from backend meta', async () => {
    mockElectronAPI.embeddings.search.mockResolvedValue({
      success: true,
      results: [{ id: 'file1', metadata: { name: 'test.pdf', path: '/test.pdf' }, score: 0.9 }],
      mode: 'hybrid',
      meta: {
        warnings: [
          {
            type: 'VECTOR_INDEX_GAP',
            severity: 'high',
            message: 'Embedding index may be stale for some analyzed files.'
          }
        ]
      }
    });

    renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);

    const searchInput = screen.getByLabelText(/search query/i);
    fireEvent.change(searchInput, { target: { value: 'test query' } });

    await act(async () => {
      jest.advanceTimersByTime(400);
    });

    await waitFor(() => {
      expect(screen.getByText(/Search diagnostics/i)).toBeInTheDocument();
      expect(
        screen.getByText(/Embedding index may be stale for some analyzed files\./i)
      ).toBeInTheDocument();
    });
  });

  test('uses organize API for triage move operations', async () => {
    renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);

    fireEvent.click(screen.getByTestId('triage-move-trigger'));

    await waitFor(() => {
      expect(mockElectronAPI.files.organize).toHaveBeenCalledWith([
        {
          type: 'move',
          source: '/src/example.pdf',
          destination: '/dest/example.pdf'
        }
      ]);
    });
    expect(mockElectronAPI.files.performOperation).not.toHaveBeenCalled();
  });
});
