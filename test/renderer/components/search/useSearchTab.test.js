/**
 * @jest-environment jsdom
 *
 * renderHook smokes for useSearchTab (§I Phase 3). Full behavior parity is
 * pinned by the existing modal suites; these cover the hook's own seams.
 */
import { renderHook, act, waitFor } from '@testing-library/react';

jest.mock('../../../../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock('../../../../src/shared/performanceConstants', () => ({
  TIMEOUTS: { DEBOUNCE_INPUT: 10, SEMANTIC_QUERY: 5000 }
}));

import { useSearchTab } from '../../../../src/renderer/components/search/hooks/useSearchTab';

describe('useSearchTab', () => {
  beforeEach(() => {
    // Deterministic debounce: RTL's waitFor auto-advances jest fake timers.
    jest.useFakeTimers();
    jest.clearAllMocks();
    global.window.electronAPI = {
      embeddings: {
        search: jest.fn().mockResolvedValue({
          success: true,
          results: [
            { id: 'r1', metadata: { name: 'alpha.pdf', path: '/docs/alpha.pdf' }, score: 0.9 },
            { id: 'r2', metadata: { name: 'beta.txt', path: '/docs/beta.txt' }, score: 0.7 }
          ],
          mode: 'hybrid',
          meta: {}
        })
      }
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function mount(props = {}) {
    return renderHook(() =>
      useSearchTab({
        isOpen: true,
        activeTab: 'search',
        defaultTopK: 20,
        error: '',
        setError: jest.fn(),
        ...props
      })
    );
  }

  test('debounced query drives a search and selects the first result', async () => {
    const { result } = mount();

    act(() => {
      result.current.setQuery('alpha report');
    });

    await waitFor(() => expect(result.current.searchResults).toHaveLength(2));
    expect(result.current.selectedSearchId).toBe('r1');
    expect(result.current.isSearching).toBe(false);
    expect(result.current.searchStatusLabel).toBe('2 results');
    expect(result.current.groupedResults).toBeTruthy();
    expect(result.current.resultIdToIndex.get('r2')).toBe(1);
  });

  test('short queries clear results without calling the API', async () => {
    const { result } = mount();

    act(() => {
      result.current.setQuery('a');
    });

    await waitFor(() => expect(result.current.debouncedQuery).toBe('a'));
    expect(window.electronAPI.embeddings.search).not.toHaveBeenCalled();
    expect(result.current.searchResults).toEqual([]);
  });

  test('resetSearchState returns the tab to a clean slate', async () => {
    const { result } = mount();
    act(() => {
      result.current.setQuery('gamma summary');
    });
    await waitFor(() => expect(result.current.debouncedQuery).toBe('gamma summary'));
    await waitFor(() => expect(result.current.searchResults).toHaveLength(2));

    act(() => {
      result.current.resetSearchState();
    });

    expect(result.current.query).toBe('');
    expect(result.current.searchResults).toEqual([]);
    expect(result.current.selectedSearchId).toBeNull();
    expect(result.current.bulkSelectedIds.size).toBe(0);
  });

  test('search errors surface via setError and clear results', async () => {
    const setError = jest.fn();
    window.electronAPI.embeddings.search = jest.fn().mockRejectedValue(new Error('index cold'));
    const { result } = mount({ setError });

    act(() => {
      result.current.setQuery('delta failing');
    });
    await waitFor(() => expect(result.current.debouncedQuery).toBe('delta failing'));

    await waitFor(() =>
      expect(setError).toHaveBeenCalledWith(expect.stringMatching(/index cold|Search/))
    );
    expect(result.current.searchResults).toEqual([]);
  });
});
