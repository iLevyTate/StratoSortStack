/**
 * Graph sidebar accordion defaults (uiSlice.graphInsightsSection → Redux hook mock).
 *
 * Graph sidebar accordion state is driven by uiSlice.graphInsightsSection.
 * Default opens "What's interesting" (`insights`); other sections toggle
 * independently via setGraphInsightsSection.
 *
 * @jest-environment jsdom
 */
import React from 'react';
import { Provider } from 'react-redux';
import { screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { NotificationProvider } from '../../../../src/renderer/contexts/NotificationContext';
import { mockUnifiedSearchModalHarnessState } from '../../../components/unifiedSearchModal.harnessState';
import {
  renderWithRedux,
  mockDispatch,
  mockElectronAPI,
  mockIsGraphViewEnabled,
  mockScrollToRow
} from '../../../components/unifiedSearchModal.harness';
import UnifiedSearchModal from '../../../../src/renderer/components/search/UnifiedSearchModal';
import { embeddingsIpc } from '../../../../src/renderer/services/ipc/embeddingsIpc';

function rerenderGraphModal(utils, onClose = jest.fn()) {
  utils.rerender(
    <Provider store={utils.store}>
      <NotificationProvider>
        <UnifiedSearchModal isOpen={true} onClose={onClose} initialTab="graph" />
      </NotificationProvider>
    </Provider>
  );
}

describe('UnifiedSearchModal graph insights defaults', () => {
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

  test("opens graph with 'What's interesting' expanded and 'Filters' collapsed by default", () => {
    renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} initialTab="graph" />);

    expect(screen.getByRole('button', { name: /What's interesting section/i })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByRole('button', { name: /Filters section/i })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  test("opens graph with 'Filters' expanded when graphInsightsSection is filters", () => {
    mockUnifiedSearchModalHarnessState.graphInsightsSectionKey = 'filters';
    renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} initialTab="graph" />);

    expect(screen.getByRole('button', { name: /Filters section/i })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByRole('button', { name: /What's interesting section/i })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  test.each([
    ['Add to graph', 'addToGraph'],
    ['Explore', 'explore'],
    ['Actions', 'actions']
  ])("clicking '%s' expands that section and collapses Insights", (title, key) => {
    const onClose = jest.fn();
    const utils = renderWithRedux(
      <UnifiedSearchModal isOpen={true} onClose={onClose} initialTab="graph" />
    );

    expect(screen.getByRole('button', { name: /What's interesting section/i })).toHaveAttribute(
      'aria-expanded',
      'true'
    );

    fireEvent.click(screen.getByRole('button', { name: new RegExp(`${title} section`, 'i') }));
    rerenderGraphModal(utils, onClose);

    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ui/setGraphInsightsSection', payload: key })
    );
    expect(
      screen.getByRole('button', { name: new RegExp(`${title} section`, 'i') })
    ).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /What's interesting section/i })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });
});
