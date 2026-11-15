/**
 * @jest-environment jsdom
 *
 * ui.smartFolderSampleHash remembers which Smart Folder definitions were
 * already tried on a sample (or skipped), so the offer before a large batch
 * does not come back after a restart or a "Start over", only after the
 * folders change. It is saved with the session, restored on launch, and
 * blobs saved before it existed restore as "no sample tried yet".
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

function bootWithUi(ui, { timestamp = Date.now() } = {}) {
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
      timestamp,
      ui,
      files: {
        selectedFiles: [],
        smartFolders: [{ id: '1', name: 'Invoices', path: '/Users/alex/Invoices' }],
        fileStates: {}
      },
      analysis: { results: [] }
    })
  });
  const storeModule = require('../src/renderer/store/index');
  return (storeModule.default || storeModule).getState();
}

describe('smartFolderSampleHash', () => {
  afterEach(() => {
    jest.dontMock('../src/renderer/store/middleware/ipcMiddleware');
    jest.dontMock('../src/renderer/store/middleware/persistenceMiddleware');
  });

  test('the reducer keeps a hash and clears anything else', () => {
    const reducer = require('../src/renderer/store/slices/uiSlice').default;
    const { setSmartFolderSampleHash } = require('../src/renderer/store/slices/uiSlice');
    let state = reducer(undefined, { type: '@@init' });
    expect(state.smartFolderSampleHash).toBeNull();
    state = reducer(state, setSmartFolderSampleHash('sf-0123456789abcd'));
    expect(state.smartFolderSampleHash).toBe('sf-0123456789abcd');
    state = reducer(state, setSmartFolderSampleHash(''));
    expect(state.smartFolderSampleHash).toBeNull();
  });

  test('"Start over" keeps it: the folders did not change', () => {
    const reducer = require('../src/renderer/store/slices/uiSlice').default;
    const { setSmartFolderSampleHash, resetUi } = require('../src/renderer/store/slices/uiSlice');
    let state = reducer(undefined, setSmartFolderSampleHash('sf-0123456789abcd'));
    state = reducer(state, resetUi());
    expect(state.smartFolderSampleHash).toBe('sf-0123456789abcd');
  });

  test('it is saved with the session', () => {
    jest.resetModules();
    const {
      buildStateSnapshot
    } = require('../src/renderer/store/middleware/persistenceMiddleware');
    const state = {
      ui: {
        currentPhase: 'discover',
        sidebarOpen: true,
        settings: null,
        viewMode: 'phased',
        selectedTheme: 'primary',
        smartFolderSampleHash: 'sf-0123456789abcd'
      },
      files: {
        selectedFiles: [],
        organizedFiles: [],
        organizedPathIndex: [],
        smartFolders: [],
        namingConvention: null,
        lastOrganizeRun: null,
        fileStates: {}
      },
      analysis: {
        results: [],
        isAnalyzing: false,
        analysisProgress: { current: 0, total: 0, lastActivity: 0 },
        currentAnalysisFile: ''
      }
    };
    expect(buildStateSnapshot(state).ui.smartFolderSampleHash).toBe('sf-0123456789abcd');
    state.ui.smartFolderSampleHash = undefined;
    expect(buildStateSnapshot(state).ui.smartFolderSampleHash).toBeNull();
  });

  test('it is restored on launch', () => {
    const state = bootWithUi({
      currentPhase: 'discover',
      smartFolderSampleHash: 'sf-0123456789abcd'
    });
    expect(state.ui.smartFolderSampleHash).toBe('sf-0123456789abcd');
  });

  test('a session saved before it existed restores as no sample tried', () => {
    const state = bootWithUi({ currentPhase: 'discover' });
    expect(state.ui.smartFolderSampleHash).toBeNull();
  });

  test('it outlives an expired session, like the Smart Folders it describes', () => {
    const state = bootWithUi(
      { currentPhase: 'discover', smartFolderSampleHash: 'sf-0123456789abcd' },
      { timestamp: Date.now() - 365 * 24 * 60 * 60 * 1000 }
    );
    expect(state.ui.currentPhase).toBe('welcome');
    expect(state.ui.smartFolderSampleHash).toBe('sf-0123456789abcd');
  });
});
