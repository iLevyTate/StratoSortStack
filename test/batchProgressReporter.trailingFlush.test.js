/**
 * @jest-environment node
 *
 * Progress is sent at most once per window; a report inside the window is
 * held and sent when the window closes. The operation can have ended or been
 * stopped by then. A Discover analysis that was stopped got its held counts
 * sent after the renderer had cleared them, and counts without a running
 * analysis read as "Analysis paused. Click to resume."
 */
jest.mock('../src/main/ipc/ipcWrappers', () => ({
  safeSend: jest.fn()
}));

const { BATCH } = require('../src/shared/performanceConstants');

const WINDOW_MS = BATCH.PROGRESS_UPDATE_INTERVAL;

describe('a progress report held back by the throttle', () => {
  let safeSend;
  let sendOperationProgress;
  let flushOperationProgress;
  const getMainWindow = () => ({ isDestroyed: () => false, webContents: {} });
  const sentPayloads = () => safeSend.mock.calls.map((call) => call[2]);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();
    ({ safeSend } = require('../src/main/ipc/ipcWrappers'));
    ({
      sendOperationProgress,
      flushOperationProgress
    } = require('../src/main/ipc/files/batchProgressReporter'));
    // The first report of a window is sent at once; the next one is held.
    sendOperationProgress(getMainWindow, { completed: 1 });
    jest.advanceTimersByTime(10);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('is sent when the window closes', () => {
    sendOperationProgress(getMainWindow, { completed: 2 });
    expect(sentPayloads()).toEqual([{ completed: 1 }]);

    jest.advanceTimersByTime(WINDOW_MS);

    expect(sentPayloads()).toEqual([{ completed: 1 }, { completed: 2 }]);
  });

  test('is sent when its operation still wants it', () => {
    const stillWanted = jest.fn(() => true);
    sendOperationProgress(getMainWindow, { completed: 2 }, { stillWanted });
    // Asked when the window closes, not when the report is handed in.
    expect(stillWanted).not.toHaveBeenCalled();

    jest.advanceTimersByTime(WINDOW_MS);

    expect(stillWanted).toHaveBeenCalledTimes(1);
    expect(sentPayloads()).toEqual([{ completed: 1 }, { completed: 2 }]);
  });

  test('the closing report of an operation is sent at once, and once', () => {
    // The operation ends inside the window, so its check answers false and
    // the held report is dropped. Listeners that refresh on the closing
    // report (search and embedding counts) never heard that it finished.
    let running = true;
    const closing = { batchId: 'b1', completed: 2, total: 2 };
    sendOperationProgress(getMainWindow, closing, { stillWanted: () => running });

    flushOperationProgress(getMainWindow, closing);
    running = false;

    expect(sentPayloads()).toEqual([{ completed: 1 }, closing]);
    jest.advanceTimersByTime(WINDOW_MS);
    expect(sentPayloads()).toEqual([{ completed: 1 }, closing]);
  });

  test('is dropped when its operation was stopped inside the window', () => {
    let running = true;
    sendOperationProgress(getMainWindow, { completed: 2 }, { stillWanted: () => running });

    running = false;
    jest.advanceTimersByTime(WINDOW_MS);

    expect(sentPayloads()).toEqual([{ completed: 1 }]);
  });

  test('a dropped report does not hold back the report after it', () => {
    sendOperationProgress(getMainWindow, { completed: 2 }, { stillWanted: () => false });
    jest.advanceTimersByTime(WINDOW_MS);
    expect(sentPayloads()).toEqual([{ completed: 1 }]);

    // Nothing was sent in that window, so this one is not throttled by it.
    sendOperationProgress(getMainWindow, { completed: 3 });

    expect(sentPayloads()).toEqual([{ completed: 1 }, { completed: 3 }]);
  });

  test('a later report of another sender is not held back by the check before it', () => {
    // A stopped analysis and an organize batch share the throttle.
    sendOperationProgress(getMainWindow, { type: 'batch_analyze' }, { stillWanted: () => false });
    sendOperationProgress(getMainWindow, { type: 'batch_organize' });

    jest.advanceTimersByTime(WINDOW_MS);

    expect(sentPayloads()).toEqual([{ completed: 1 }, { type: 'batch_organize' }]);
  });

  test('a report sent at once clears the check of the report it replaces', () => {
    sendOperationProgress(getMainWindow, { completed: 2 }, { stillWanted: () => false });
    jest.advanceTimersByTime(WINDOW_MS + 10);
    expect(sentPayloads()).toEqual([{ completed: 1 }]);

    sendOperationProgress(getMainWindow, { completed: 3 });
    jest.advanceTimersByTime(10);
    sendOperationProgress(getMainWindow, { completed: 4 });
    jest.advanceTimersByTime(WINDOW_MS);

    expect(sentPayloads()).toEqual([{ completed: 1 }, { completed: 3 }, { completed: 4 }]);
  });
});
