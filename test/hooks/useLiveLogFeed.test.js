/**
 * Renderer side of the Live Activity feed: subscribe while enabled, merge the
 * backlog and pushed batches by id, cap at 500, hold entries while paused,
 * and unsubscribe on unmount.
 */
import React from 'react';
import { renderHook, act } from '@testing-library/react';

const mockSubscribe = jest.fn();
const mockUnsubscribe = jest.fn();
const mockOff = jest.fn();
const mockOnLiveLogBatch = jest.fn();
let mockBatchListener = null;

jest.mock('../../src/renderer/services/ipc', () => ({
  systemIpc: {
    subscribeLiveLog: (...args) => mockSubscribe(...args),
    unsubscribeLiveLog: (...args) => mockUnsubscribe(...args),
    onLiveLogBatch: (...args) => mockOnLiveLogBatch(...args)
  }
}));

import {
  MAX_RENDERER_ENTRIES,
  RECENT_ACTIVITY_MS,
  __resetLiveLogFeedForTests,
  capEntries,
  selectFreshEntries,
  useLiveLogFeed
} from '../../src/renderer/hooks/useLiveLogFeed';

function entry(id, overrides = {}) {
  return {
    id,
    time: '2026-11-05T09:00:00.000Z',
    level: 'info',
    context: 'Test',
    msg: `message ${id}`,
    dataText: '',
    activity: null,
    ...overrides
  };
}

function range(from, to) {
  return Array.from({ length: to - from + 1 }, (_, i) => entry(from + i));
}

function ids(list) {
  return list.map((e) => e.id);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await act(async () => {});
}

describe('selectFreshEntries / capEntries', () => {
  test('keeps only entries newer than the last seen id', () => {
    expect(selectFreshEntries([entry(1), entry(2), entry(3)], 1)).toEqual({
      fresh: [entry(2), entry(3)],
      lastSeenId: 3
    });
  });

  test('ignores non-arrays and malformed entries', () => {
    expect(selectFreshEntries(undefined, 5)).toEqual({ fresh: [], lastSeenId: 5 });
    expect(selectFreshEntries([null, { id: 'x' }, entry(6)], 5)).toEqual({
      fresh: [entry(6)],
      lastSeenId: 6
    });
  });

  test('capEntries keeps the newest entries', () => {
    expect(ids(capEntries(range(1, 10), 3))).toEqual([8, 9, 10]);
    expect(MAX_RENDERER_ENTRIES).toBe(500);
  });
});

describe('useLiveLogFeed', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    __resetLiveLogFeedForTests();
    mockSubscribe.mockReset();
    mockUnsubscribe.mockReset();
    mockUnsubscribe.mockResolvedValue(undefined);
    mockOff.mockReset();
    mockOnLiveLogBatch.mockReset();
    mockOnLiveLogBatch.mockImplementation((callback) => {
      mockBatchListener = callback;
      return mockOff;
    });
    mockBatchListener = null;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('subscribes on mount and shows the backlog', async () => {
    mockSubscribe.mockResolvedValue({ entries: [entry(1), entry(2)] });
    const { result } = renderHook(() => useLiveLogFeed());

    expect(result.current.status).toBe('connecting');
    await settle();

    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('live');
    expect(ids(result.current.entries)).toEqual([1, 2]);
  });

  test('keeps a batch that arrives before the backlog, after the backlog', async () => {
    const pending = deferred();
    mockSubscribe.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useLiveLogFeed());
    await settle();
    expect(mockSubscribe).toHaveBeenCalledTimes(1);

    act(() => mockBatchListener({ entries: [entry(3)], dropped: 0 }));
    await act(async () => {
      pending.resolve({ entries: [entry(1), entry(2)] });
    });

    expect(ids(result.current.entries)).toEqual([1, 2, 3]);
  });

  test('an early batch that overlaps the backlog shows each entry once', async () => {
    const pending = deferred();
    mockSubscribe.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useLiveLogFeed());
    await settle();

    act(() => mockBatchListener({ entries: [entry(2), entry(3)], dropped: 1 }));
    await act(async () => {
      pending.resolve({ entries: [entry(1), entry(2)] });
    });

    expect(ids(result.current.entries)).toEqual([1, 2, 3]);
    expect(result.current.dropped).toBe(1);
  });

  test('appends batches, ignores ids already seen, and adds up dropped counts', async () => {
    mockSubscribe.mockResolvedValue({ entries: [entry(1)] });
    const { result } = renderHook(() => useLiveLogFeed());
    await settle();

    act(() => mockBatchListener({ entries: [entry(1), entry(2), entry(3)], dropped: 4 }));
    expect(ids(result.current.entries)).toEqual([1, 2, 3]);
    expect(result.current.dropped).toBe(4);

    act(() => mockBatchListener({ entries: [entry(4)], dropped: 1 }));
    expect(ids(result.current.entries)).toEqual([1, 2, 3, 4]);
    expect(result.current.dropped).toBe(5);
  });

  test('ignores batches without an entries array or a numeric dropped count', async () => {
    mockSubscribe.mockResolvedValue({ entries: [entry(1)] });
    const { result } = renderHook(() => useLiveLogFeed());
    await settle();

    act(() => {
      mockBatchListener(undefined);
      mockBatchListener(null);
      mockBatchListener({ entries: 'nope', dropped: 3 });
      mockBatchListener({ entries: [entry(2)] });
      mockBatchListener({ entries: [entry(3)], dropped: '2' });
      mockBatchListener({ entries: [entry(4)], dropped: Number.NaN });
      mockBatchListener({ entries: [entry(5)], dropped: -1 });
    });

    expect(ids(result.current.entries)).toEqual([1]);
    expect(result.current.dropped).toBe(0);

    act(() => mockBatchListener({ entries: [entry(6)], dropped: 0 }));
    expect(ids(result.current.entries)).toEqual([1, 6]);
  });

  test('a batch that throws while being read never escapes the listener', async () => {
    mockSubscribe.mockResolvedValue({ entries: [entry(1)] });
    const { result } = renderHook(() => useLiveLogFeed());
    await settle();

    const hostile = {
      get id() {
        throw new Error('boom');
      }
    };
    expect(() => act(() => mockBatchListener({ entries: [hostile], dropped: 0 }))).not.toThrow();

    act(() => mockBatchListener({ entries: [entry(2)], dropped: 0 }));
    expect(ids(result.current.entries)).toEqual([1, 2]);
  });

  test('keeps at most 500 entries', async () => {
    mockSubscribe.mockResolvedValue({ entries: range(1, 300) });
    const { result } = renderHook(() => useLiveLogFeed());
    await settle();

    act(() => mockBatchListener({ entries: range(301, 700), dropped: 0 }));

    expect(result.current.entries).toHaveLength(MAX_RENDERER_ENTRIES);
    expect(result.current.entries[0].id).toBe(201);
  });

  test('while paused, new entries are counted instead of shown; resume shows them', async () => {
    mockSubscribe.mockResolvedValue({ entries: [entry(1)] });
    const { result } = renderHook(() => useLiveLogFeed());
    await settle();

    act(() => result.current.pause());
    expect(result.current.paused).toBe(true);

    act(() => mockBatchListener({ entries: [entry(2), entry(3)], dropped: 0 }));
    expect(ids(result.current.entries)).toEqual([1]);
    expect(result.current.pausedCount).toBe(2);

    act(() => result.current.resume());
    expect(result.current.paused).toBe(false);
    expect(result.current.pausedCount).toBe(0);
    expect(ids(result.current.entries)).toEqual([1, 2, 3]);
  });

  test('pausedCount and the held entries stop at 500; resume shows the newest 500', async () => {
    mockSubscribe.mockResolvedValue({ entries: [entry(1)] });
    const { result } = renderHook(() => useLiveLogFeed());
    await settle();

    act(() => result.current.pause());
    act(() => mockBatchListener({ entries: range(2, 401), dropped: 0 }));
    act(() => mockBatchListener({ entries: range(402, 701), dropped: 0 }));
    expect(result.current.pausedCount).toBe(MAX_RENDERER_ENTRIES);
    expect(ids(result.current.entries)).toEqual([1]);

    act(() => result.current.resume());
    expect(result.current.pausedCount).toBe(0);
    expect(result.current.entries).toHaveLength(MAX_RENDERER_ENTRIES);
    expect(result.current.entries[0].id).toBe(202);
    expect(result.current.entries[MAX_RENDERER_ENTRIES - 1].id).toBe(701);
  });

  test('an overlapping batch while paused does not inflate pausedCount', async () => {
    mockSubscribe.mockResolvedValue({ entries: [entry(1)] });
    const { result } = renderHook(() => useLiveLogFeed());
    await settle();

    act(() => result.current.pause());
    act(() => mockBatchListener({ entries: [entry(1), entry(2), entry(3)], dropped: 0 }));
    act(() => mockBatchListener({ entries: [entry(2), entry(3), entry(4)], dropped: 0 }));
    expect(result.current.pausedCount).toBe(3);

    act(() => result.current.resume());
    expect(ids(result.current.entries)).toEqual([1, 2, 3, 4]);
  });

  test('clear while paused drops the held entries and stays paused', async () => {
    mockSubscribe.mockResolvedValue({ entries: [entry(1)] });
    const { result } = renderHook(() => useLiveLogFeed());
    await settle();

    act(() => result.current.pause());
    act(() => mockBatchListener({ entries: [entry(2), entry(3)], dropped: 0 }));
    act(() => result.current.clear());
    expect(result.current.pausedCount).toBe(0);
    expect(result.current.paused).toBe(true);
    expect(result.current.entries).toEqual([]);

    act(() => mockBatchListener({ entries: [entry(4)], dropped: 0 }));
    expect(result.current.pausedCount).toBe(1);
    act(() => result.current.resume());
    expect(ids(result.current.entries)).toEqual([4]);
  });

  test('clear while connecting also discards batches held for after the backlog', async () => {
    const pending = deferred();
    mockSubscribe.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useLiveLogFeed());
    await settle();

    act(() => mockBatchListener({ entries: [entry(3)], dropped: 2 }));
    act(() => result.current.clear());
    await act(async () => {
      pending.resolve({ entries: [entry(1), entry(2)] });
    });

    expect(ids(result.current.entries)).toEqual([1, 2]);
    expect(result.current.dropped).toBe(0);
  });

  test('clear empties the list and old entries do not come back', async () => {
    mockSubscribe.mockResolvedValue({ entries: [entry(1)] });
    const { result } = renderHook(() => useLiveLogFeed());
    await settle();

    act(() => mockBatchListener({ entries: [entry(2)], dropped: 3 }));
    act(() => result.current.clear());
    expect(result.current.entries).toEqual([]);
    expect(result.current.dropped).toBe(0);

    act(() => mockBatchListener({ entries: [entry(2), entry(3)], dropped: 0 }));
    expect(ids(result.current.entries)).toEqual([3]);
  });

  test('unsubscribes and removes the batch listener on unmount', async () => {
    mockSubscribe.mockResolvedValue({ entries: [] });
    const { unmount } = renderHook(() => useLiveLogFeed());
    await settle();

    unmount();

    expect(mockOff).toHaveBeenCalledTimes(1);
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  test('unmounting while subscribe is pending unsubscribes once it resolves, without updating', async () => {
    const pending = deferred();
    mockSubscribe.mockReturnValue(pending.promise);
    const { result, unmount } = renderHook(() => useLiveLogFeed());
    await settle();
    expect(mockSubscribe).toHaveBeenCalledTimes(1);

    unmount();
    expect(mockOff).toHaveBeenCalledTimes(1);
    expect(mockUnsubscribe).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve({ entries: [entry(1)] });
    });

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('connecting');
    expect(result.current.entries).toEqual([]);
    expect(result.current.recentlyActive).toBe(false);
  });

  test('a subscribe that fails after unmount still releases the subscription', async () => {
    const pending = deferred();
    mockSubscribe.mockReturnValue(pending.promise);
    const { unmount } = renderHook(() => useLiveLogFeed());
    await settle();

    unmount();
    await act(async () => {
      pending.reject(new Error('timed out'));
    });

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  test('React StrictMode double mount ends with exactly one subscription', async () => {
    mockSubscribe.mockResolvedValue({ entries: [entry(1)] });
    const { result } = renderHook(() => useLiveLogFeed(), { wrapper: React.StrictMode });
    await settle();

    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(mockUnsubscribe).not.toHaveBeenCalled();
    expect(result.current.status).toBe('live');
    expect(ids(result.current.entries)).toEqual([1]);

    // Only the surviving listener delivers.
    act(() => mockBatchListener({ entries: [entry(2)], dropped: 0 }));
    expect(ids(result.current.entries)).toEqual([1, 2]);
  });

  test('re-enabling waits for the previous unsubscribe before subscribing again', async () => {
    mockSubscribe.mockResolvedValue({ entries: [entry(1)] });
    const releaseUnsubscribe = deferred();
    mockUnsubscribe.mockReturnValue(releaseUnsubscribe.promise);
    const { result, rerender } = renderHook(({ enabled }) => useLiveLogFeed({ enabled }), {
      initialProps: { enabled: true }
    });
    await settle();
    expect(mockSubscribe).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('idle');

    rerender({ enabled: true });
    await settle();
    expect(mockSubscribe).toHaveBeenCalledTimes(1);

    mockSubscribe.mockResolvedValue({ entries: [entry(1), entry(2)] });
    await act(async () => {
      releaseUnsubscribe.resolve(undefined);
    });

    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('live');
    expect(ids(result.current.entries)).toEqual([1, 2]);
  });

  test('a remount after unmount waits for the old unsubscribe', async () => {
    mockSubscribe.mockResolvedValue({ entries: [] });
    const releaseUnsubscribe = deferred();
    mockUnsubscribe.mockReturnValue(releaseUnsubscribe.promise);
    const first = renderHook(() => useLiveLogFeed());
    await settle();
    first.unmount();

    const second = renderHook(() => useLiveLogFeed());
    await settle();
    expect(mockSubscribe).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseUnsubscribe.resolve(undefined);
    });
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    expect(second.result.current.status).toBe('live');
  });

  test('a batch from the old subscription during the release wait never reaches the new view', async () => {
    mockSubscribe.mockResolvedValue({ entries: [] });
    const releaseUnsubscribe = deferred();
    mockUnsubscribe.mockReturnValue(releaseUnsubscribe.promise);
    const first = renderHook(() => useLiveLogFeed());
    await settle();
    first.unmount();

    const second = renderHook(() => useLiveLogFeed());
    await settle();
    // Still in flight from the old subscription, ahead of the unsubscribe reply.
    act(() => mockBatchListener({ entries: [entry(5)], dropped: 7 }));

    mockSubscribe.mockResolvedValue({ entries: [entry(6)] });
    await act(async () => {
      releaseUnsubscribe.resolve(undefined);
    });

    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    expect(ids(second.result.current.entries)).toEqual([6]);
    expect(second.result.current.dropped).toBe(0);

    act(() => mockBatchListener({ entries: [entry(7)], dropped: 1 }));
    expect(ids(second.result.current.entries)).toEqual([6, 7]);
    expect(second.result.current.dropped).toBe(1);
  });

  test('a rejected unsubscribe does not block the next subscription', async () => {
    mockSubscribe.mockResolvedValue({ entries: [] });
    mockUnsubscribe.mockRejectedValue(new Error('IPC timeout'));
    const first = renderHook(() => useLiveLogFeed());
    await settle();
    first.unmount();

    const second = renderHook(() => useLiveLogFeed());
    await settle();
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    expect(second.result.current.status).toBe('live');
  });

  test('does nothing while disabled', () => {
    const { result } = renderHook(() => useLiveLogFeed({ enabled: false }));
    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(mockOnLiveLogBatch).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  test('reports unavailable when the subscribe call fails', async () => {
    mockSubscribe.mockRejectedValue(new Error('No handler registered'));
    const { result } = renderHook(() => useLiveLogFeed());
    await settle();
    expect(result.current.status).toBe('unavailable');
  });

  test('reports unavailable when the batch bridge cannot be registered', async () => {
    mockOnLiveLogBatch.mockImplementation(() => {
      throw new Error('electronAPI missing');
    });
    const { result } = renderHook(() => useLiveLogFeed());
    await settle();
    expect(result.current.status).toBe('unavailable');
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  test('recentlyActive stays on for 3 s after the last new entry', async () => {
    mockSubscribe.mockResolvedValue({ entries: [entry(1)] });
    const { result } = renderHook(() => useLiveLogFeed());
    await settle();
    expect(result.current.recentlyActive).toBe(true);

    act(() => jest.advanceTimersByTime(RECENT_ACTIVITY_MS - 1));
    expect(result.current.recentlyActive).toBe(true);

    act(() => mockBatchListener({ entries: [entry(2)], dropped: 0 }));
    act(() => jest.advanceTimersByTime(RECENT_ACTIVITY_MS - 1));
    expect(result.current.recentlyActive).toBe(true);

    act(() => jest.advanceTimersByTime(1));
    expect(result.current.recentlyActive).toBe(false);
  });

  test('an empty backlog does not light the activity dot', async () => {
    mockSubscribe.mockResolvedValue({ entries: [] });
    const { result } = renderHook(() => useLiveLogFeed());
    await settle();
    expect(result.current.recentlyActive).toBe(false);
  });

  test('unmount clears the activity timer', async () => {
    mockSubscribe.mockResolvedValue({ entries: [entry(1)] });
    const { result, unmount } = renderHook(() => useLiveLogFeed());
    await settle();
    expect(result.current.recentlyActive).toBe(true);
    const withPulseTimer = jest.getTimerCount();

    unmount();
    expect(jest.getTimerCount()).toBe(withPulseTimer - 1);
  });
});
