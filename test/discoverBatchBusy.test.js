/**
 * src/renderer/phases/discover/batchBusy.js — a Discover run whose batch
 * request is refused because this window's earlier batch is still running
 * must wait for it, never start a second analysis of the same files.
 */
const {
  isBatchAlreadyRunning,
  runBatchPathWhenFree
} = require('../src/renderer/phases/discover/batchBusy');

const busy = () =>
  Object.assign(new Error('IPC Error: Operation already in progress: analysis:analyze-batch'), {
    code: 'CONCURRENCY_LIMIT'
  });

describe('isBatchAlreadyRunning', () => {
  test.each([
    [busy(), true],
    [new Error('IPC Error: Operation already in progress: analysis:analyze-batch'), true],
    [Object.assign(new Error('x'), { code: 'CONCURRENCY_LIMIT' }), true],
    [new Error('Batch analysis API not available'), false],
    [new Error('timed out after 30000ms: analysis:analyze-batch'), false],
    [null, false]
  ])('%p -> %p', (error, expected) => {
    expect(isBatchAlreadyRunning(error)).toBe(expected);
  });
});

describe('runBatchPathWhenFree', () => {
  const noSleep = jest.fn(async () => {});

  test('runs once when the batch is free', async () => {
    const runBatchPath = jest.fn(async () => {});
    await expect(
      runBatchPathWhenFree({ runBatchPath, isActiveRun: () => true, sleep: noSleep })
    ).resolves.toBe('ran');
    expect(runBatchPath).toHaveBeenCalledTimes(1);
  });

  test('waits while the earlier batch runs, announces once, then runs', async () => {
    const runBatchPath = jest
      .fn()
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
      .mockResolvedValueOnce(undefined);
    const onWaiting = jest.fn();
    await expect(
      runBatchPathWhenFree({
        runBatchPath,
        isActiveRun: () => true,
        onWaiting,
        sleep: noSleep
      })
    ).resolves.toBe('ran');
    expect(runBatchPath).toHaveBeenCalledTimes(3);
    expect(onWaiting).toHaveBeenCalledTimes(1);
  });

  test('a newer run supersedes a waiting one without running it', async () => {
    let active = true;
    const runBatchPath = jest.fn(async () => {
      throw busy();
    });
    const sleep = jest.fn(async () => {
      active = false;
    });
    await expect(
      runBatchPathWhenFree({ runBatchPath, isActiveRun: () => active, sleep })
    ).resolves.toBe('superseded');
    expect(runBatchPath).toHaveBeenCalledTimes(1);
  });

  test('an abort while waiting stops the run', async () => {
    const controller = new AbortController();
    const runBatchPath = jest.fn(async () => {
      throw busy();
    });
    const sleep = jest.fn(async () => controller.abort());
    await expect(
      runBatchPathWhenFree({
        runBatchPath,
        isActiveRun: () => true,
        abortSignal: controller.signal,
        sleep
      })
    ).resolves.toBe('superseded');
  });

  test('any other failure is rethrown for the per-file fallback', async () => {
    const failure = new Error('Batch analysis API not available');
    await expect(
      runBatchPathWhenFree({
        runBatchPath: jest.fn(async () => {
          throw failure;
        }),
        isActiveRun: () => true,
        sleep: noSleep
      })
    ).rejects.toBe(failure);
  });

  test('the real wait resolves early when aborted', async () => {
    const controller = new AbortController();
    const runBatchPath = jest.fn(async () => {
      throw busy();
    });
    const pending = runBatchPathWhenFree({
      runBatchPath,
      isActiveRun: () => true,
      abortSignal: controller.signal,
      retryMs: 60_000
    });
    controller.abort();
    await expect(pending).resolves.toBe('superseded');
  });
});

describe('runBatchPathWhenFree — only what the earlier batch left', () => {
  const noSleep = jest.fn(async () => {});

  test('after waiting, the retry sends only the remaining files', async () => {
    const runBatchPath = jest.fn().mockRejectedValueOnce(busy()).mockResolvedValueOnce(undefined);
    const remaining = [{ path: '/b.pdf' }];
    await expect(
      runBatchPathWhenFree({
        runBatchPath,
        isActiveRun: () => true,
        selectRemaining: async () => remaining,
        sleep: noSleep
      })
    ).resolves.toBe('ran');
    expect(runBatchPath.mock.calls[0][0]).toBeUndefined();
    expect(runBatchPath.mock.calls[1][0]).toBe(remaining);
  });

  test('nothing left: the run ends without another batch', async () => {
    const runBatchPath = jest.fn().mockRejectedValueOnce(busy());
    await expect(
      runBatchPathWhenFree({
        runBatchPath,
        isActiveRun: () => true,
        selectRemaining: async () => [],
        sleep: noSleep
      })
    ).resolves.toBe('finished-elsewhere');
    expect(runBatchPath).toHaveBeenCalledTimes(1);
  });

  test('an unreadable ready queue keeps the full list', async () => {
    const runBatchPath = jest.fn().mockRejectedValueOnce(busy()).mockResolvedValueOnce(undefined);
    await runBatchPathWhenFree({
      runBatchPath,
      isActiveRun: () => true,
      selectRemaining: async () => null,
      sleep: noSleep
    });
    expect(runBatchPath.mock.calls[1][0]).toBeUndefined();
  });
});

describe('filesNotYetReady', () => {
  const { filesNotYetReady } = require('../src/renderer/phases/discover/batchBusy');
  const canonical = (p) => String(p).toLowerCase();
  const t1 = '2026-11-09T10:00:00.000Z';
  const t2 = '2026-11-09T11:00:00.000Z';

  test('drops files with a current ready result, keeps the rest', () => {
    const files = [
      { path: '/A.pdf', modified: t1 },
      { path: '/b.pdf', modified: t1 }
    ];
    const ready = [{ path: '/a.pdf', modified: t1, analysis: { category: 'Work' } }];
    expect(filesNotYetReady(files, ready, canonical)).toEqual([{ path: '/b.pdf', modified: t1 }]);
  });

  test('a file changed since its ready result is analyzed again', () => {
    const files = [{ path: '/a.pdf', modified: t2 }];
    const ready = [{ path: '/a.pdf', modified: t1, analysis: {} }];
    expect(filesNotYetReady(files, ready, canonical)).toEqual(files);
  });

  test('entries without an analysis do not count', () => {
    const files = [{ path: '/a.pdf' }];
    expect(filesNotYetReady(files, [{ path: '/a.pdf' }], canonical)).toEqual(files);
  });

  test('without modified times on both sides a ready result counts as current', () => {
    expect(
      filesNotYetReady([{ path: '/a.pdf' }], [{ path: '/a.pdf', analysis: {} }], canonical)
    ).toEqual([]);
  });
});
