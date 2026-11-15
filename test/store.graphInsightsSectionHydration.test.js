/**
 * @jest-environment jsdom
 *
 * setGraphInsightsSection(null) means "every sidebar section collapsed" and
 * is persisted on purpose. loadState must hand that null back on restart
 * instead of reopening the Insights section.
 */

const REDUX_STATE_KEY = 'stratosort_redux_state';

function installStorage(storage) {
  const localStorageMock = {
    getItem: jest.fn((key) =>
      Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null
    ),
    setItem: jest.fn((key, value) => {
      storage[key] = String(value);
    }),
    removeItem: jest.fn((key) => {
      delete storage[key];
    }),
    clear: jest.fn(() => {
      Object.keys(storage).forEach((key) => delete storage[key]);
    })
  };
  Object.defineProperty(window, 'localStorage', {
    value: localStorageMock,
    configurable: true,
    writable: true
  });
  Object.defineProperty(global, 'localStorage', {
    value: localStorageMock,
    configurable: true,
    writable: true
  });
}

function bootWithUi(ui) {
  jest.resetModules();
  jest.doMock('../src/renderer/store/middleware/ipcMiddleware', () => ({
    __esModule: true,
    default: () => (next) => (action) => next(action),
    markStoreReady: jest.fn()
  }));
  jest.doMock('../src/renderer/store/middleware/persistenceMiddleware', () => ({
    __esModule: true,
    default: () => (next) => (action) => next(action)
  }));
  installStorage({
    [REDUX_STATE_KEY]: JSON.stringify({
      _version: 4,
      timestamp: Date.now(),
      ui,
      files: { selectedFiles: [], smartFolders: [], fileStates: {} },
      analysis: { results: [] }
    })
  });
  const storeModule = require('../src/renderer/store/index');
  return (storeModule.default || storeModule).getState();
}

describe('graphInsightsSection hydration', () => {
  test('a saved null (all sections collapsed) is restored as null', () => {
    const state = bootWithUi({ currentPhase: 'welcome', graphInsightsSection: null });
    expect(state.ui.graphInsightsSection).toBeNull();
  });

  test('a missing key falls back to insights', () => {
    const state = bootWithUi({ currentPhase: 'welcome' });
    expect(state.ui.graphInsightsSection).toBe('insights');
  });

  test('an unknown key falls back to insights', () => {
    const state = bootWithUi({ currentPhase: 'welcome', graphInsightsSection: 'bogus' });
    expect(state.ui.graphInsightsSection).toBe('insights');
  });

  test('a valid key is restored', () => {
    const state = bootWithUi({ currentPhase: 'welcome', graphInsightsSection: 'filters' });
    expect(state.ui.graphInsightsSection).toBe('filters');
  });
});
