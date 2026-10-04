/**
 * @jest-environment jsdom
 */

const REDUX_STATE_KEY = 'stratosort_redux_state';
const LEGACY_STATE_KEY = 'stratosort_workflow_state';

function loadStoreWithStorage({ reduxState, legacyState, backupState, themeMirror } = {}) {
  jest.resetModules();

  const markStoreReadyMock = jest.fn();

  jest.doMock('../src/renderer/store/middleware/ipcMiddleware', () => ({
    __esModule: true,
    default: () => (next) => (action) => next(action),
    markStoreReady: markStoreReadyMock
  }));

  jest.doMock('../src/renderer/store/middleware/persistenceMiddleware', () => ({
    __esModule: true,
    default: () => (next) => (action) => next(action)
  }));

  const storage = {};
  if (reduxState !== undefined) {
    storage[REDUX_STATE_KEY] = reduxState;
  }
  if (legacyState !== undefined) {
    storage[LEGACY_STATE_KEY] = legacyState;
  }
  if (backupState !== undefined) {
    storage['stratosort_redux_state_backup'] = backupState;
  }
  if (themeMirror !== undefined) {
    storage['stratosort_theme'] = themeMirror;
  }

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

  delete window.__STRATOSORT_STATE_EXPIRED__;
  delete window.__STRATOSORT_STATE_EXPIRED_AGE_HOURS__;
  delete window.__STRATOSORT_STATE_RESTORED_FROM_BACKUP__;

  const storeModule = require('../src/renderer/store/index');
  const store = storeModule.default || storeModule;

  return { store, markStoreReadyMock };
}

describe('store bootstrap persistence recovery', () => {
  test('falls back to initial state when persisted JSON is corrupted', () => {
    const { store, markStoreReadyMock } = loadStoreWithStorage({
      reduxState: '{not-valid-json'
    });

    const state = store.getState();
    expect(state.ui.currentPhase).toBe('welcome');
    expect(Array.isArray(state.files.selectedFiles)).toBe(true);
    expect(markStoreReadyMock).toHaveBeenCalledTimes(1);
  });

  test('stashes a corrupt blob under the forensics key without clobbering the backup', () => {
    const corrupt = '{this is not valid json';
    const goodBackup = JSON.stringify({
      _version: 2,
      timestamp: Date.now(),
      ui: { currentPhase: 'discover' },
      files: { selectedFiles: [], smartFolders: [{ id: 'sf-1', name: 'Invoices' }] },
      analysis: { results: [] }
    });
    const { store } = loadStoreWithStorage({ reduxState: corrupt, backupState: goodBackup });

    // The backup key must keep the last KNOWN-GOOD blob — writing the corrupt
    // blob there would destroy the recovery path. Corrupt blob goes to a
    // separate forensics key instead.
    expect(localStorage.getItem('stratosort_redux_state_backup')).toBe(goodBackup);
    expect(localStorage.getItem('stratosort_redux_state_corrupt')).toBe(corrupt);
    // State recovered from the backup rather than discarded.
    expect(window.__STRATOSORT_STATE_RESTORED_FROM_BACKUP__).toBe(true);
    expect(store.getState().ui.currentPhase).toBe('discover');
    expect(store.getState().files.smartFolders).toHaveLength(1);
    // Live key re-seeded with the good blob for the next boot.
    expect(localStorage.getItem(REDUX_STATE_KEY)).toBe(goodBackup);
  });

  test('falls back to fresh state when both the live blob and backup are corrupt', () => {
    const { store } = loadStoreWithStorage({
      reduxState: '{not-valid-json',
      backupState: '{also-not-valid'
    });

    expect(store.getState().ui.currentPhase).toBe('welcome');
    expect(window.__STRATOSORT_STATE_RESTORED_FROM_BACKUP__).toBeUndefined();
  });

  test('falls back to fresh state when the live blob is corrupt and no backup exists', () => {
    const corrupt = '{this is not valid json';
    const { store } = loadStoreWithStorage({ reduxState: corrupt });

    expect(store.getState().ui.currentPhase).toBe('welcome');
    expect(localStorage.getItem('stratosort_redux_state_corrupt')).toBe(corrupt);
    expect(localStorage.getItem('stratosort_redux_state_backup')).toBeNull();
  });

  test('hydrates legacy workflow state when redux state is missing', () => {
    const legacyState = JSON.stringify({
      currentPhase: 'discover',
      phaseData: {
        selectedFiles: [{ path: 'C:/docs/a.pdf', created: '2025-01-01T00:00:00.000Z' }],
        organizedFiles: [{ path: 'C:/docs/organized.pdf' }],
        smartFolders: [{ id: 'sf-1', name: 'Invoices' }],
        analysisResults: [{ path: 'C:/docs/a.pdf', analysis: { category: 'finance' } }],
        fileStates: { 'C:/docs/a.pdf': { state: 'analyzed' } }
      }
    });

    const { store, markStoreReadyMock } = loadStoreWithStorage({
      legacyState
    });

    const state = store.getState();
    expect(state.ui.currentPhase).toBe('discover');
    expect(state.files.selectedFiles).toHaveLength(1);
    expect(state.files.smartFolders).toHaveLength(1);
    expect(state.analysis.results).toHaveLength(1);
    expect(markStoreReadyMock).toHaveBeenCalledTimes(1);
  });

  test('expires stale state but preserves durable smart folder data', () => {
    const staleTimestamp = Date.now() - 26 * 60 * 60 * 1000;
    const staleState = JSON.stringify({
      _version: 2,
      timestamp: staleTimestamp,
      ui: { currentPhase: 'organize' },
      files: {
        selectedFiles: [{ path: 'C:/docs/pending.pdf' }],
        organizedFiles: [{ path: 'C:/docs/already-organized.pdf' }],
        smartFolders: [{ id: 'sf-keep', name: 'Keep Me' }],
        fileStates: { 'C:/docs/pending.pdf': { state: 'pending' } }
      },
      analysis: {
        results: [{ path: 'C:/docs/pending.pdf', analysis: { category: 'misc' } }]
      },
      system: {
        documentsPath: 'C:/Users/test/Documents'
      }
    });

    const { store } = loadStoreWithStorage({ reduxState: staleState });
    const state = store.getState();

    expect(state.ui.currentPhase).toBe('welcome');
    expect(state.files.selectedFiles).toEqual([]);
    expect(state.files.smartFolders).toHaveLength(1);
    expect(state.files.organizedFiles).toHaveLength(1);
    expect(window.__STRATOSORT_STATE_EXPIRED__).toBe(true);
    expect(window.__STRATOSORT_STATE_EXPIRED_AGE_HOURS__).toBeGreaterThanOrEqual(25);
  });

  test('sanitizes malformed persisted slices instead of crashing', () => {
    const malformedState = JSON.stringify({
      _version: 2,
      timestamp: Date.now(),
      ui: { currentPhase: '__broken__' },
      files: {
        selectedFiles: 'oops',
        smartFolders: null,
        organizedFiles: {},
        fileStates: []
      },
      analysis: {
        results: { bad: true }
      },
      system: {
        notifications: 'not-an-array'
      }
    });

    const { store } = loadStoreWithStorage({ reduxState: malformedState });
    const state = store.getState();

    expect(state.ui.currentPhase).toBe('welcome');
    expect(Array.isArray(state.files.selectedFiles)).toBe(true);
    expect(Array.isArray(state.files.smartFolders)).toBe(true);
    expect(Array.isArray(state.files.organizedFiles)).toBe(true);
    expect(Array.isArray(state.analysis.results)).toBe(true);
    expect(Array.isArray(state.system.notifications)).toBe(true);
  });

  test('normalizes stale analyzing file states on startup', () => {
    const persistedState = JSON.stringify({
      _version: 2,
      timestamp: Date.now(),
      ui: { currentPhase: 'discover' },
      files: {
        selectedFiles: [{ path: 'C:/docs/a.pdf' }, { path: 'C:/docs/b.pdf' }],
        smartFolders: [],
        organizedFiles: [],
        fileStates: {
          'C:/docs/a.pdf': { state: 'analyzing' },
          'C:/docs/b.pdf': { state: 'in_progress' },
          'C:/docs/c.pdf': { state: 'ready' }
        }
      },
      analysis: {
        isAnalyzing: true,
        results: []
      }
    });

    const { store } = loadStoreWithStorage({ reduxState: persistedState });
    const state = store.getState();

    expect(state.analysis.isAnalyzing).toBe(false);
    expect(state.files.fileStates['C:/docs/a.pdf'].state).toBe('pending');
    expect(state.files.fileStates['C:/docs/b.pdf'].state).toBe('pending');
    expect(state.files.fileStates['C:/docs/c.pdf'].state).toBe('ready');
  });

  test('rehydrates a persisted dashboard viewMode', () => {
    const persistedState = JSON.stringify({
      _version: 2,
      timestamp: Date.now(),
      ui: { currentPhase: 'discover', viewMode: 'dashboard' },
      files: { selectedFiles: [], smartFolders: [], organizedFiles: [] },
      analysis: { results: [] }
    });

    const { store } = loadStoreWithStorage({ reduxState: persistedState });

    expect(store.getState().ui.viewMode).toBe('dashboard');
  });

  test('normalizes an unknown persisted viewMode back to phased', () => {
    const persistedState = JSON.stringify({
      _version: 2,
      timestamp: Date.now(),
      ui: { currentPhase: 'discover', viewMode: 'kanban' },
      files: { selectedFiles: [], smartFolders: [], organizedFiles: [] },
      analysis: { results: [] }
    });

    const { store } = loadStoreWithStorage({ reduxState: persistedState });

    expect(store.getState().ui.viewMode).toBe('phased');
  });

  test('defaults viewMode to phased when the persisted blob omits it', () => {
    const persistedState = JSON.stringify({
      _version: 2,
      timestamp: Date.now(),
      ui: { currentPhase: 'discover' },
      files: { selectedFiles: [], smartFolders: [], organizedFiles: [] },
      analysis: { results: [] }
    });

    const { store } = loadStoreWithStorage({ reduxState: persistedState });

    expect(store.getState().ui.viewMode).toBe('phased');
  });
});

describe('store bootstrap durable theme (no reopen flash)', () => {
  const freshBlob = (selectedTheme) =>
    JSON.stringify({
      _version: 2,
      timestamp: Date.now(),
      ui: { currentPhase: 'discover', ...(selectedTheme ? { selectedTheme } : {}) },
      files: { selectedFiles: [], smartFolders: [], organizedFiles: [] },
      analysis: { results: [] }
    });

  test('prefers the synchronous mirror key over a stale blob theme', () => {
    // The Redux blob is flushed on a debounce/beforeunload and can be lost on an
    // abrupt close; the mirror key (written synchronously by App.js) is the
    // durable record. When they disagree, the mirror must win so the palette the
    // user last chose survives the reopen and React does not flash back.
    const { store } = loadStoreWithStorage({
      reduxState: freshBlob('primary'),
      themeMirror: 'dark'
    });

    expect(store.getState().ui.selectedTheme).toBe('dark');
  });

  test('falls back to the blob theme when no mirror key exists', () => {
    const { store } = loadStoreWithStorage({ reduxState: freshBlob('light') });

    expect(store.getState().ui.selectedTheme).toBe('light');
  });

  test('ignores an invalid mirror key and uses the blob theme', () => {
    const { store } = loadStoreWithStorage({
      reduxState: freshBlob('light'),
      themeMirror: 'chartreuse'
    });

    expect(store.getState().ui.selectedTheme).toBe('light');
  });

  test('preserves the mirror theme across TTL expiry', () => {
    const staleTimestamp = Date.now() - 26 * 60 * 60 * 1000;
    const staleState = JSON.stringify({
      _version: 2,
      timestamp: staleTimestamp,
      ui: { currentPhase: 'organize', selectedTheme: 'primary' },
      files: {
        selectedFiles: [],
        smartFolders: [{ id: 'sf-keep', name: 'Keep Me' }],
        organizedFiles: []
      },
      analysis: { results: [] }
    });

    const { store } = loadStoreWithStorage({ reduxState: staleState, themeMirror: 'light' });

    expect(store.getState().ui.currentPhase).toBe('welcome'); // expired session state
    expect(store.getState().ui.selectedTheme).toBe('light'); // durable visual pref kept
  });
});
