/**
 * @jest-environment jsdom
 */
/**
 * Stop clears the counts of an analysis and tells main. A report main sent
 * just before it heard of the Stop arrives after that. Written to the store,
 * it put counts back with no analysis running, and Discover reads those as
 * "Analysis paused. Click to resume." Real analysis reducer, real middleware.
 */
import { configureStore } from '@reduxjs/toolkit';

jest.mock('../src/shared/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger, createLogger: jest.fn(() => logger) };
});

describe('a batch report that arrives with no analysis running', () => {
  let store;
  let fromMain;
  let slice;
  let cleanupIpcListeners;
  let domEvents;
  const onDomEvent = (event) => domEvents.push(event.detail);

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
    domEvents = [];
    window.addEventListener('operation-progress', onDomEvent);
  });

  afterEach(() => {
    window.removeEventListener('operation-progress', onDomEvent);
    cleanupIpcListeners(true);
    jest.useRealTimers();
    delete window.electronAPI;
  });

  const counts = () => {
    const { current, total } = store.getState().analysis.analysisProgress;
    return { current, total };
  };

  test('after Stop, a report that was on its way is not written', () => {
    store.dispatch(slice.startAnalysis({ total: 7 }));
    fromMain({ type: 'batch_analyze', completed: 1, total: 7 });
    expect(counts()).toEqual({ current: 1, total: 7 });
    // What Stop dispatches.
    store.dispatch(slice.stopAnalysis());
    store.dispatch(slice.updateProgress({ current: 0, total: 0, lastActivity: 0 }));
    jest.advanceTimersByTime(200);

    fromMain({ type: 'batch_analyze', completed: 2, total: 7 });
    jest.advanceTimersByTime(200);

    expect(counts()).toEqual({ current: 0, total: 0 });
    expect(store.getState().analysis.isAnalyzing).toBe(false);
  });

  test('before any analysis, a report of a batch nobody here started is not written', () => {
    fromMain({ type: 'batch_analyze', completed: 3, total: 9 });
    jest.advanceTimersByTime(200);

    expect(counts()).toEqual({ current: 0, total: 0 });
  });

  test('the report still reaches the listeners of the page', () => {
    fromMain({ type: 'batch_analyze', completed: 3, total: 9 });

    expect(domEvents).toEqual([expect.objectContaining({ type: 'batch_analyze', completed: 3 })]);
  });

  test('with an analysis running, a report is written as before', () => {
    store.dispatch(slice.startAnalysis({ total: 7 }));

    fromMain({ type: 'batch_analyze', completed: 4, total: 7 });
    jest.advanceTimersByTime(200);

    expect(counts()).toEqual({ current: 4, total: 7 });
  });

  test('the next analysis shows its own reports', () => {
    store.dispatch(slice.startAnalysis({ total: 7 }));
    store.dispatch(slice.stopAnalysis());
    store.dispatch(slice.updateProgress({ current: 0, total: 0, lastActivity: 0 }));
    fromMain({ type: 'batch_analyze', completed: 6, total: 7 });
    jest.advanceTimersByTime(200);

    store.dispatch(slice.startAnalysis({ total: 3 }));
    fromMain({ type: 'batch_analyze', completed: 1, total: 3 });
    jest.advanceTimersByTime(200);

    expect(counts()).toEqual({ current: 1, total: 3 });
  });
});
