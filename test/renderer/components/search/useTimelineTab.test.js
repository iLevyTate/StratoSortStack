/**
 * @jest-environment jsdom
 */
import { renderHook, act, waitFor } from '@testing-library/react';

jest.mock('../../../../src/shared/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })
}));

import { useTimelineTab } from '../../../../src/renderer/components/search/useTimelineTab';

describe('useTimelineTab', () => {
  beforeEach(() => {
    window.electronAPI = {
      analysisHistory: {
        getTimeline: jest.fn(async ({ offset = 0 } = {}) =>
          offset === 0
            ? {
                items: [{ id: 'a', effectiveDate: '2024-12-01', fileName: 'a.pdf' }],
                total: 2,
                hasMore: true
              }
            : {
                items: [{ id: 'b', effectiveDate: '2019-06-14', fileName: 'b.jpg' }],
                total: 2,
                hasMore: false
              }
        )
      }
    };
  });

  test('loads first page when tab becomes active and appends on loadMore', async () => {
    const { result, rerender } = renderHook(
      ({ activeTab }) => useTimelineTab({ isOpen: true, activeTab }),
      { initialProps: { activeTab: 'search' } }
    );
    expect(result.current.items).toEqual([]);
    rerender({ activeTab: 'timeline' });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.hasMore).toBe(true);
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.items).toHaveLength(2);
    expect(result.current.hasMore).toBe(false);
  });

  test('surfaces an error message when the API is unavailable', async () => {
    window.electronAPI = {};
    const { result, rerender } = renderHook(
      ({ activeTab }) => useTimelineTab({ isOpen: true, activeTab }),
      { initialProps: { activeTab: 'search' } }
    );
    rerender({ activeTab: 'timeline' });
    await waitFor(() => expect(result.current.error).toBeTruthy());
  });

  test('refetches after the modal closes and reopens (no stale first-load snapshot)', async () => {
    const { result, rerender } = renderHook(
      ({ isOpen }) => useTimelineTab({ isOpen, activeTab: 'timeline' }),
      { initialProps: { isOpen: true } }
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.items[0].id).toBe('a');
    expect(window.electronAPI.analysisHistory.getTimeline).toHaveBeenCalledTimes(1);

    // Close: analyses/organizes can happen while the refresh listener is
    // detached, so the loaded page must be invalidated. The corpus changed
    // while closed — the reopened tab must show the new page, not the
    // first-load snapshot.
    window.electronAPI.analysisHistory.getTimeline.mockImplementation(async () => ({
      items: [{ id: 'fresh', effectiveDate: '2025-01-01', fileName: 'fresh.pdf' }],
      total: 1,
      hasMore: false
    }));
    rerender({ isOpen: false });
    rerender({ isOpen: true });
    await waitFor(() => expect(result.current.items[0]?.id).toBe('fresh'));
    expect(window.electronAPI.analysisHistory.getTimeline).toHaveBeenCalledTimes(2);
    expect(result.current.isLoading).toBe(false);
  });

  test('refresh() reloads the first page while the tab stays active', async () => {
    const { result, rerender } = renderHook(
      ({ activeTab }) => useTimelineTab({ isOpen: true, activeTab }),
      { initialProps: { activeTab: 'search' } }
    );
    rerender({ activeTab: 'timeline' });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(window.electronAPI.analysisHistory.getTimeline).toHaveBeenCalledTimes(1);
    act(() => {
      result.current.refresh();
    });
    await waitFor(() =>
      expect(window.electronAPI.analysisHistory.getTimeline).toHaveBeenCalledTimes(2)
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));
  });

  test('refresh() invalidates an in-flight loadMore — its stale page is dropped [F-163]', async () => {
    // Pre-fix, a loadMore already in flight when refresh() fired (one refresh
    // per file-operation-complete during bulk moves) resolved AFTER the
    // reset: its pre-move rows were appended back and offsetRef was bumped
    // against the zeroed offset, silently skipping unfetched rows on the
    // next page.
    let resolveStalePage;
    const stalePage = new Promise((resolve) => {
      resolveStalePage = resolve;
    });
    const { result, rerender } = renderHook(
      ({ activeTab }) => useTimelineTab({ isOpen: true, activeTab }),
      { initialProps: { activeTab: 'search' } }
    );
    rerender({ activeTab: 'timeline' });
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    // Park the next page fetch so refresh() can overtake it.
    window.electronAPI.analysisHistory.getTimeline.mockImplementationOnce(() => stalePage);
    let loadMorePromise;
    act(() => {
      loadMorePromise = result.current.loadMore();
    });

    // Fresh snapshot the refresh will load.
    window.electronAPI.analysisHistory.getTimeline.mockImplementation(async () => ({
      items: [{ id: 'fresh', effectiveDate: '2025-01-01', fileName: 'fresh.pdf' }],
      total: 1,
      hasMore: false
    }));
    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.items[0]?.id).toBe('fresh'));

    // The stale pre-move page lands late — it must be dropped entirely.
    await act(async () => {
      resolveStalePage({
        items: [{ id: 'stale-pre-move', effectiveDate: '2019-06-14', fileName: 'old.jpg' }],
        total: 2,
        hasMore: true
      });
      await loadMorePromise;
    });

    expect(result.current.items.map((it) => it.id)).toEqual(['fresh']);
    // hasMore still reflects the fresh snapshot, not the stale response.
    expect(result.current.hasMore).toBe(false);
    expect(result.current.isLoading).toBe(false);
  });
});
