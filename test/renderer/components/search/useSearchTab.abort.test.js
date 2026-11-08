/**
 * @jest-environment jsdom
 *
 * Superseded searches must not keep running in main: when a newer query
 * starts (or the hook unmounts) while an EMBEDDINGS.SEARCH invoke is still in
 * flight, useSearchTab signals the preload abort path so the main handler's
 * AbortSignal fires and the stale search stops holding the inference slot.
 * The abort names that invoke's own abortKey — never the whole channel — so
 * other EMBEDDINGS.SEARCH callers (chat name resolution) are not cancelled.
 * The request-id stale guard still keeps late answers out of the UI.
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
import { IPC_CHANNELS } from '../../../../src/shared/constants';

function deferred() {
  /** @type {(v: any) => void} */
  let resolve = () => {};
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function okResponse(id) {
  return {
    success: true,
    results: [{ id, metadata: { name: `${id}.pdf`, path: `/docs/${id}.pdf` }, score: 0.9 }],
    mode: 'hybrid',
    meta: {}
  };
}

describe('useSearchTab superseded-search abort', () => {
  /** @type {Array<ReturnType<typeof deferred>>} */
  let pending;
  /** @type {string[]} */
  let callLog;

  beforeEach(() => {
    jest.useFakeTimers();
    pending = [];
    callLog = [];
    global.window.electronAPI = {
      embeddings: {
        search: jest.fn((q) => {
          callLog.push(`search:${q}`);
          const d = deferred();
          pending.push(d);
          return d.promise;
        })
      },
      system: {
        abortInvoke: jest.fn((payload) => {
          callLog.push(`abort:${payload?.channel}`);
          return 1;
        })
      }
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** abortKey the hook passed with its Nth embeddings.search call. */
  function searchKeyOf(index) {
    return window.electronAPI.embeddings.search.mock.calls[index]?.[1]?.abortKey;
  }

  function mount(props = {}) {
    const setError = jest.fn();
    const hook = renderHook(() =>
      useSearchTab({
        isOpen: true,
        activeTab: 'search',
        defaultTopK: 20,
        error: '',
        setError,
        ...props
      })
    );
    return { ...hook, setError };
  }

  test('a newer query aborts the in-flight superseded search before starting its own', async () => {
    const { result, setError } = mount();

    act(() => {
      result.current.setQuery('first query');
    });
    await waitFor(() => expect(window.electronAPI.embeddings.search).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.setQuery('second query');
    });
    await waitFor(() => expect(window.electronAPI.embeddings.search).toHaveBeenCalledTimes(2));

    expect(window.electronAPI.system.abortInvoke).toHaveBeenCalledTimes(1);
    // The abort names the stale invoke's own abortKey, so other invokes on
    // the same channel (e.g. the chat tab's name-resolution search) survive.
    const firstKey = searchKeyOf(0);
    const secondKey = searchKeyOf(1);
    // Must satisfy the preload's abortKey validator (/^[\w.:-]{1,64}$/).
    expect(firstKey).toMatch(/^search-tab-[\w.:-]+$/);
    expect(secondKey).toMatch(/^search-tab-[\w.:-]+$/);
    expect(secondKey).not.toBe(firstKey);
    expect(window.electronAPI.system.abortInvoke).toHaveBeenCalledWith({
      channel: IPC_CHANNELS.EMBEDDINGS.SEARCH,
      abortKey: firstKey,
      reason: 'search-superseded'
    });
    expect(callLog).toEqual([
      'search:first query',
      `abort:${IPC_CHANNELS.EMBEDDINGS.SEARCH}`,
      'search:second query'
    ]);

    // Newer answer lands first; the stale (cancelled) answer arrives later and
    // must neither overwrite results nor surface as an error.
    await act(async () => {
      pending[1].resolve(okResponse('second'));
    });
    await waitFor(() => expect(result.current.searchResults.map((r) => r.id)).toEqual(['second']));

    await act(async () => {
      pending[0].resolve({ success: false, error: 'Search cancelled', cancelled: true });
    });
    expect(result.current.searchResults.map((r) => r.id)).toEqual(['second']);
    expect(result.current.isSearching).toBe(false);
    expect(setError).not.toHaveBeenCalledWith(expect.stringMatching(/cancel/i));
  });

  test('a stale answer resolving after the newer query started never overwrites it', async () => {
    const { result } = mount();

    act(() => {
      result.current.setQuery('first query');
    });
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => {
      result.current.setQuery('second query');
    });
    await waitFor(() => expect(pending).toHaveLength(2));

    // Stale request answers successfully (abort raced and lost) before the
    // newer one: the sequence guard must drop it.
    await act(async () => {
      pending[0].resolve(okResponse('first'));
    });
    expect(result.current.searchResults).toEqual([]);
    expect(result.current.isSearching).toBe(true);

    await act(async () => {
      pending[1].resolve(okResponse('second'));
    });
    await waitFor(() => expect(result.current.searchResults.map((r) => r.id)).toEqual(['second']));
  });

  test('unmount aborts an in-flight search', async () => {
    const { result, unmount } = mount();

    act(() => {
      result.current.setQuery('first query');
    });
    await waitFor(() => expect(pending).toHaveLength(1));

    unmount();
    expect(window.electronAPI.system.abortInvoke).toHaveBeenCalledWith({
      channel: IPC_CHANNELS.EMBEDDINGS.SEARCH,
      abortKey: searchKeyOf(0),
      reason: 'search-superseded'
    });
  });

  test('no abort is sent when the previous search already settled', async () => {
    const { result } = mount();

    act(() => {
      result.current.setQuery('first query');
    });
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending[0].resolve(okResponse('first'));
    });
    await waitFor(() => expect(result.current.searchResults.map((r) => r.id)).toEqual(['first']));

    act(() => {
      result.current.setQuery('second query');
    });
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(window.electronAPI.system.abortInvoke).not.toHaveBeenCalled();
  });

  test('a renderer-side timeout also aborts the abandoned search in main', async () => {
    const { result, setError } = mount();

    act(() => {
      result.current.setQuery('slow query');
    });
    await waitFor(() => expect(pending).toHaveLength(1));

    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(window.electronAPI.system.abortInvoke).toHaveBeenCalledWith({
      channel: IPC_CHANNELS.EMBEDDINGS.SEARCH,
      abortKey: searchKeyOf(0),
      reason: 'search-timeout'
    });
    await waitFor(() => expect(setError).toHaveBeenCalledWith(expect.stringMatching(/timed out/i)));
  });

  test('a missing abort bridge is tolerated (search still runs)', async () => {
    delete window.electronAPI.system;
    const { result } = mount();

    act(() => {
      result.current.setQuery('first query');
    });
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => {
      result.current.setQuery('second query');
    });
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => {
      pending[1].resolve(okResponse('second'));
    });
    await waitFor(() => expect(result.current.searchResults.map((r) => r.id)).toEqual(['second']));
  });
});
