/**
 * @jest-environment jsdom
 */

// In "By Type" view the rows are ordered by category, so arrow keys must step
// through that on-screen order. They used to step through the flat result
// order: the highlight jumped between groups and scrollIntoView scrolled a
// different row from the highlighted one.

import React from 'react';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { mockElectronAPI, renderWithRedux } from './components/unifiedSearchModal.harness';
import UnifiedSearchModal from '../src/renderer/components/search/UnifiedSearchModal';
import { embeddingsIpc } from '../src/renderer/services/ipc/embeddingsIpc';
import { registerOverlay, unregisterOverlay } from '../src/renderer/utils/overlayStack';

const RESULTS = [
  { id: 'a', metadata: { name: 'a.pdf', path: '/path/a.pdf' }, score: 0.9 },
  { id: 'b', metadata: { name: 'b.jpg', path: '/path/b.jpg' }, score: 0.8 },
  { id: 'c', metadata: { name: 'c.pdf', path: '/path/c.pdf' }, score: 0.7 },
  { id: 'd', metadata: { name: 'd.pdf', path: '/path/d.pdf' }, score: 0.6 }
];

const rowName = (row) => row.textContent.match(/[a-d]\.(pdf|jpg)/)?.[0];
const focusedRowName = (container) => {
  const focused = Array.from(container.querySelectorAll('[data-result-item]')).find((row) =>
    row.className.includes('border-stratosort-blue/35')
  );
  return focused ? rowName(focused) : null;
};

describe('UnifiedSearchModal grouped view keyboard navigation', () => {
  let scrollSpy;
  let originalScrollIntoView;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    embeddingsIpc.invalidateStatsCache();
    window.ResizeObserver = jest.fn().mockImplementation(() => ({
      observe: jest.fn(),
      unobserve: jest.fn(),
      disconnect: jest.fn()
    }));
    mockElectronAPI.embeddings.search.mockResolvedValue({
      success: true,
      results: RESULTS,
      mode: 'hybrid'
    });
    mockElectronAPI.embeddings.getStats.mockResolvedValue({
      success: true,
      files: 10,
      folders: 5
    });
    originalScrollIntoView = Element.prototype.scrollIntoView;
    scrollSpy = jest.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    // The real Modal registers the overlay; the mocked one does not, and the
    // key handler only runs for the top overlay.
    registerOverlay('knowledge-os-modal');
  });

  afterEach(() => {
    unregisterOverlay('knowledge-os-modal');
    Element.prototype.scrollIntoView = originalScrollIntoView;
    delete window.ResizeObserver;
    jest.useRealTimers();
  });

  const searchAndGroup = async () => {
    const view = renderWithRedux(<UnifiedSearchModal isOpen={true} onClose={jest.fn()} />);
    fireEvent.change(screen.getByLabelText(/search query/i), { target: { value: 'files' } });
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    await waitFor(() => {
      expect(view.container.querySelectorAll('[data-result-item]')).toHaveLength(4);
    });
    fireEvent.click(screen.getByRole('button', { name: /group results by type/i }));
    // Documents (3) sort before Images (1).
    await waitFor(() => {
      const order = Array.from(view.container.querySelectorAll('[data-result-item]')).map(rowName);
      expect(order).toEqual(['a.pdf', 'c.pdf', 'd.pdf', 'b.jpg']);
    });
    return view;
  };

  const press = async (key) => {
    await act(async () => {
      fireEvent.keyDown(document.body, { key });
    });
  };

  test('ArrowDown follows the on-screen order and scrolls the highlighted row', async () => {
    const { container } = await searchAndGroup();

    await press('ArrowDown');
    await waitFor(() => expect(focusedRowName(container)).toBe('a.pdf'));

    await press('ArrowDown');
    await waitFor(() => expect(focusedRowName(container)).toBe('c.pdf'));
    const lastScrolled = scrollSpy.mock.instances[scrollSpy.mock.instances.length - 1];
    expect(rowName(lastScrolled)).toBe('c.pdf');

    await press('ArrowDown');
    await waitFor(() => expect(focusedRowName(container)).toBe('d.pdf'));
    await press('ArrowDown');
    await waitFor(() => expect(focusedRowName(container)).toBe('b.jpg'));

    await press('ArrowUp');
    await waitFor(() => expect(focusedRowName(container)).toBe('d.pdf'));
  });

  test('Enter opens the highlighted row, not the flat result at that index', async () => {
    mockElectronAPI.files.open.mockResolvedValue({ success: true });
    const { container } = await searchAndGroup();

    await press('ArrowDown');
    await press('ArrowDown');
    await waitFor(() => expect(focusedRowName(container)).toBe('c.pdf'));
    await press('Enter');

    expect(mockElectronAPI.files.open).toHaveBeenCalledWith('/path/c.pdf');
    expect(mockElectronAPI.files.open).not.toHaveBeenCalledWith('/path/b.jpg');
  });
});
