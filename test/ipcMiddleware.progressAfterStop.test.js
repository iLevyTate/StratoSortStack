/**
 * @jest-environment jsdom
 */
/**
 * Progress from main reaches the store at most every 80 ms; an update inside
 * that window is held and written when it ends. An analysis that was stopped
 * or reset inside the window got its counts written back afterwards, and
 * counts without a running analysis read as "Analysis paused. Click to
 * resume." in Discover. Real analysis reducer, real middleware.
 */
import { configureStore } from '@reduxjs/toolkit';

jest.mock('../src/shared/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger, createLogger: jest.fn(() => logger) };
});

describe('a held-back progress update and the end of its analysis', () => {
  let store;
  let fromMain;
  let slice;
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
    slice = require('../src/renderer/store/slices/analysisSlice');
    const middleware = require('../src/renderer/store/middleware/ipcMiddleware');
    cleanupIpcListeners = middleware.cleanupIpcListeners;
    store = configureStore({
      reducer: { analysis: slice.default },
      middleware: (getDefault) =>
        getDefault({ serializableCheck: false, immutableCheck: false }).concat(middleware.default)
    });
    middleware.markStoreReady();

    store.dispatch(slice.startAnalysis({ total: 7 }));
    fromMain({ type: 'batch_analyze', completed: 1, total: 7 });
    jest.advanceTimersByTime(20);
    // Inside the 80 ms window: held.
    fromMain({ type: 'batch_analyze', completed: 2, total: 7 });
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

  test('with the analysis still running, the held update is written', () => {
    expect(counts()).toEqual({ current: 1, total: 7 });

    jest.advanceTimersByTime(100);

    expect(counts()).toEqual({ current: 2, total: 7 });
  });

  test.each([
    [
      'stopped',
      () => {
        // What Stop dispatches.
        store.dispatch(slice.stopAnalysis());
        store.dispatch(slice.updateProgress({ current: 0, total: 0, lastActivity: 0 }));
      }
    ],
    ['reset', () => store.dispatch(slice.resetAnalysisState())],
    ['reset after an error', () => store.dispatch(slice.resetToSafeState())]
  ])('an analysis %s inside the window keeps its cleared counts', (_how, end) => {
    end();

    jest.advanceTimersByTime(100);

    expect(counts()).toEqual({ current: 0, total: 0 });
    expect(store.getState().analysis.isAnalyzing).toBe(false);
  });
});
