/**
 * @jest-environment jsdom
 */
/**
 * A Discover run that waited for an earlier batch sends main only the files
 * that batch did not finish. Main counts within what it was sent, and those
 * counts were written to the store as they came: a run of 7 with 4 done showed
 * "1 of 3", and ended as incomplete or complete by a total that was not its
 * own. Real analysis reducer, real middleware.
 */
import { configureStore } from '@reduxjs/toolkit';

jest.mock('../src/shared/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger, createLogger: jest.fn(() => logger) };
});

describe('progress of a batch that is the rest of a run', () => {
  let store;
  let fromMain;
  let runBase;
  let cleanupIpcListeners;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();
    window.electronAPI = {
      events: {
        onOperationProgress: jest.fn((handler) => {
          fromMain = handler;
          return jest.fn();
        })
      }
    };
    const slice = require('../src/renderer/store/slices/analysisSlice');
    const middleware = require('../src/renderer/store/middleware/ipcMiddleware');
    runBase = require('../src/renderer/store/analysisRunBase');
    cleanupIpcListeners = middleware.cleanupIpcListeners;
    store = configureStore({
      reducer: { analysis: slice.default },
      middleware: (getDefault) =>
        getDefault({ serializableCheck: false, immutableCheck: false }).concat(middleware.default)
    });
    middleware.markStoreReady();

    store.dispatch(slice.startAnalysis({ total: 7 }));
    runBase.setAnalysisRunBase({ batchId: 'rest-of-run', done: 4, total: 7 });
  });

  afterEach(() => {
    cleanupIpcListeners(true);
    jest.useRealTimers();
    delete window.electronAPI;
  });

  const counts = () => {
    const { current, total } = store.getState().analysis.analysisProgress;
    return { current, total };
  };
  const progress = (batchId, completed, total) =>
    fromMain({ type: 'batch_analyze', batchId, completed, total });

  test('is counted from what the run had done before it', () => {
    progress('rest-of-run', 1, 3);

    expect(counts()).toEqual({ current: 5, total: 7 });
  });

  test('is counted the same way when the update was held back', () => {
    progress('rest-of-run', 1, 3);
    jest.advanceTimersByTime(20);
    progress('rest-of-run', 2, 3);

    jest.advanceTimersByTime(100);

    expect(counts()).toEqual({ current: 6, total: 7 });
  });

  test('never passes the size of the run', () => {
    progress('rest-of-run', 9, 3);

    expect(counts()).toEqual({ current: 7, total: 7 });
  });

  test('the page still gets the counts as main sent them', () => {
    // runBatchPath listens to this event and adds the offset itself.
    const seen = [];
    const listener = (event) => seen.push(event.detail);
    window.addEventListener('operation-progress', listener);
    try {
      progress('rest-of-run', 1, 3);
    } finally {
      window.removeEventListener('operation-progress', listener);
    }

    expect(seen).toEqual([
      expect.objectContaining({ batchId: 'rest-of-run', completed: 1, total: 3 })
    ]);
  });

  test('another batch is written as main sent it', () => {
    progress('some-other-batch', 1, 3);

    expect(counts()).toEqual({ current: 1, total: 3 });
  });

  test('once the batch is over, later progress is written as main sent it', () => {
    runBase.clearAnalysisRunBase('rest-of-run');

    progress('rest-of-run', 1, 3);

    expect(counts()).toEqual({ current: 1, total: 3 });
  });

  test('a batch that is over does not clear the offset of the one after it', () => {
    runBase.clearAnalysisRunBase('the-batch-before');

    progress('rest-of-run', 1, 3);

    expect(counts()).toEqual({ current: 5, total: 7 });
  });
});
