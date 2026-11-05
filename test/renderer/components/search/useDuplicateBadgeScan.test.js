/**
 * @jest-environment jsdom
 *
 * The graph tab's near-duplicate badge asks the main process for a scan that
 * compares every vector with every other one. During a batch the indexed-file
 * count changes every stats refresh (~1.5 s); the badge must not rescan on
 * each of those, only once the count settles and not more than once per 30 s.
 */
import { renderHook, act } from '@testing-library/react';
import {
  useDuplicateBadgeScan,
  RESCAN_SETTLE_MS,
  RESCAN_MIN_GAP_MS
} from '../../../../src/renderer/components/search/hooks/useDuplicateBadgeScan';

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

function mount(initial) {
  const setDuplicateSummary = jest.fn();
  const lastDuplicateFileCountRef = { current: null };
  const hook = renderHook(
    (p) =>
      useDuplicateBadgeScan({
        enabled: true,
        isComputingClusters: false,
        setDuplicateSummary,
        lastDuplicateFileCountRef,
        ...p
      }),
    { initialProps: initial }
  );
  return { ...hook, setDuplicateSummary, lastDuplicateFileCountRef };
}

describe('useDuplicateBadgeScan', () => {
  let findDuplicates;

  beforeEach(() => {
    jest.useFakeTimers();
    findDuplicates = jest.fn().mockResolvedValue({
      success: true,
      groups: [{ id: 'g1' }],
      totalDuplicates: 2
    });
    window.electronAPI = { embeddings: { findDuplicates } };
  });

  afterEach(() => {
    jest.useRealTimers();
    delete window.electronAPI;
  });

  test('the first scan for the open tab runs straight away and fills the badge', async () => {
    const { setDuplicateSummary } = mount({ fileCount: 10 });
    await flush();
    expect(findDuplicates).toHaveBeenCalledTimes(1);
    expect(setDuplicateSummary).toHaveBeenLastCalledWith({
      loading: false,
      groupCount: 1,
      totalDuplicates: 2
    });
  });

  test('a count that keeps moving during a batch does not rescan on every tick', async () => {
    const { rerender } = mount({ fileCount: 10 });
    await flush();
    expect(findDuplicates).toHaveBeenCalledTimes(1);

    // Two minutes of a batch: the count moves every 1.5 s and never settles.
    for (let n = 11; n <= 90; n++) {
      rerender({ fileCount: n });
      await act(async () => {
        jest.advanceTimersByTime(1500);
      });
      await flush();
    }
    expect(findDuplicates).toHaveBeenCalledTimes(1);

    // The batch ends; one rescan once the count has held still.
    await act(async () => {
      jest.advanceTimersByTime(RESCAN_SETTLE_MS);
    });
    await flush();
    expect(findDuplicates).toHaveBeenCalledTimes(2);
  });

  test('a settled change waits at least the minimum gap after the previous scan', async () => {
    const { rerender } = mount({ fileCount: 10 });
    await flush();

    rerender({ fileCount: 11 });
    await act(async () => {
      jest.advanceTimersByTime(RESCAN_MIN_GAP_MS - 1000);
    });
    await flush();
    expect(findDuplicates).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await flush();
    expect(findDuplicates).toHaveBeenCalledTimes(2);
  });

  test('a change long after the last scan still waits for the count to settle', async () => {
    const { rerender } = mount({ fileCount: 10 });
    await flush();
    await act(async () => {
      jest.advanceTimersByTime(RESCAN_MIN_GAP_MS * 2);
    });

    rerender({ fileCount: 12 });
    await act(async () => {
      jest.advanceTimersByTime(RESCAN_SETTLE_MS - 100);
    });
    await flush();
    expect(findDuplicates).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    await flush();
    expect(findDuplicates).toHaveBeenCalledTimes(2);
  });

  test('an unchanged count, a closed tab, or fewer than two files never scans', async () => {
    const { rerender, setDuplicateSummary } = mount({ fileCount: 10 });
    await flush();
    rerender({ fileCount: 10 });
    rerender({ fileCount: 15, enabled: false });
    await act(async () => {
      jest.advanceTimersByTime(RESCAN_MIN_GAP_MS * 2);
    });
    await flush();
    expect(findDuplicates).toHaveBeenCalledTimes(1);

    rerender({ fileCount: 1, enabled: true });
    await flush();
    expect(findDuplicates).toHaveBeenCalledTimes(1);
    const reset = setDuplicateSummary.mock.calls.at(-1)[0]({ loading: true, groupCount: 3 });
    expect(reset).toMatchObject({ loading: false, groupCount: 0, totalDuplicates: 0 });
  });

  test('a count that moves while the first scan is still running does not start back-to-back scans', async () => {
    // The first scan takes longer than a stats refresh.
    let finishFirst;
    findDuplicates.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = () => resolve({ success: true, groups: [], totalDuplicates: 0 });
        })
    );
    const { rerender } = mount({ fileCount: 10 });
    await flush();
    expect(findDuplicates).toHaveBeenCalledTimes(1);

    for (let n = 11; n <= 20; n++) {
      rerender({ fileCount: n });
      await act(async () => {
        jest.advanceTimersByTime(1500);
      });
      await flush();
    }
    finishFirst();
    await flush();
    // Before, each change re-ran the "first scan" at once: 11 scans here.
    expect(findDuplicates).toHaveBeenCalledTimes(1);

    // Once the count holds still, one scan fills the badge.
    await act(async () => {
      jest.advanceTimersByTime(RESCAN_MIN_GAP_MS);
    });
    await flush();
    expect(findDuplicates).toHaveBeenCalledTimes(2);
  });

  test('sets the user chose to keep are not counted in the badge', async () => {
    const kept = {
      id: 'g1',
      memberCount: 2,
      members: [{ path: '/a/x.pdf' }, { path: '/b/x.pdf' }]
    };
    const open = {
      id: 'g2',
      memberCount: 3,
      members: [{ path: '/a/y.pdf' }, { path: '/b/y.pdf' }, { path: '/c/y.pdf' }]
    };
    findDuplicates.mockResolvedValue({ success: true, groups: [kept, open], totalDuplicates: 5 });
    const {
      signatureForScannedGroup,
      DISMISSED_STORAGE_KEY
    } = require('../../../../src/renderer/components/organize/duplicateDismissals');
    window.localStorage.setItem(
      DISMISSED_STORAGE_KEY,
      JSON.stringify([signatureForScannedGroup(kept)])
    );
    try {
      const { setDuplicateSummary } = mount({ fileCount: 10 });
      await flush();
      expect(setDuplicateSummary).toHaveBeenLastCalledWith({
        loading: false,
        groupCount: 1,
        totalDuplicates: 3
      });
    } finally {
      window.localStorage.clear();
    }
  });

  test('the badge and the dialog agree on which set was kept', () => {
    const {
      signatureForScannedGroup,
      duplicateGroupSignature
    } = require('../../../../src/renderer/components/organize/duplicateDismissals');
    const group = {
      id: 'g1',
      members: [
        { id: 'b', path: '/b/x.pdf' },
        { id: 'a', path: '/a/x.pdf' }
      ]
    };
    expect(signatureForScannedGroup(group)).toBe(
      duplicateGroupSignature({ members: [{ path: '/a/x.pdf' }, { path: '/b/x.pdf' }] })
    );
  });
});
