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
