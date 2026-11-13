/**
 * @jest-environment jsdom
 *
 * files.lastOrganizeRunFiles at launch: a saved file list is restored only
 * with the run summary it belongs to, and only in its stored shape.
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

function bootStore(storage) {
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
  installStorage(storage);
  const storeModule = require('../src/renderer/store/index');
  return storeModule.default || storeModule;
}

const partialRun = {
  outcome: 'partial',
  count: 1,
  headline: 'Moved 1 file; 1 could not be moved',
  detail: 'Access denied.',
  finishedAt: 1000
};
const rows = [
  { name: 'a.pdf', originalPath: 'C:/in/a.pdf', finalPath: 'C:/out/a.pdf', outcome: 'moved' },
  { name: 'b.pdf', originalPath: 'C:/in/b.pdf', finalPath: null, outcome: 'failed', reason: 'x' },
  { name: 'bad', originalPath: 'C:/in/c.pdf', outcome: 'deleted' }
];
const blobWith = (files) =>
  JSON.stringify({
    _version: 4,
    timestamp: Date.now(),
    ui: { currentPhase: 'organize' },
    files: {
      selectedFiles: [{ path: 'C:/in/b.pdf' }],
      organizedFiles: [],
      smartFolders: [],
      fileStates: {},
      ...files
    },
    analysis: { results: [] }
  });
const restoredRows = (files) =>
  bootStore({ [REDUX_STATE_KEY]: blobWith(files) }).getState().files.lastOrganizeRunFiles;

describe('last organize run file list at launch', () => {
  test('comes back with the summary it belongs to, without damaged rows', () => {
    expect(
      restoredRows({ lastOrganizeRun: partialRun, lastOrganizeRunFiles: rows }).map((r) => r.name)
    ).toEqual(['a.pdf', 'b.pdf']);
  });

  test('is dropped when its summary is not restored', () => {
    expect(
      restoredRows({
        lastOrganizeRun: { ...partialRun, outcome: 'moved' },
        lastOrganizeRunFiles: rows
      })
    ).toEqual([]);
    expect(restoredRows({ lastOrganizeRunFiles: rows })).toEqual([]);
  });

  test('state saved before the field existed restores an empty list', () => {
    expect(restoredRows({ lastOrganizeRun: partialRun })).toEqual([]);
  });
});
