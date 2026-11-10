/**
 * @jest-environment jsdom
 *
 * Renderer bootstrap must not lose durable persisted state across reloads:
 * - a TTL-expired blob is replaced by a fresh durable snapshot right away, so
 *   a reload before the first debounced save still has the organize history;
 * - a parseable but un-migratable blob (newer/invalid version) never
 *   overwrites the last known-good backup.
 */

const REDUX_STATE_KEY = 'stratosort_redux_state';
const BACKUP_KEY = 'stratosort_redux_state_backup';
const CORRUPT_KEY = 'stratosort_redux_state_corrupt';

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

/** Boot the store against `storage` (shared across calls = a renderer reload). */
function bootStore(storage) {
  jest.resetModules();
  jest.doMock('../src/renderer/store/middleware/ipcMiddleware', () => ({
    __esModule: true,
    default: () => (next) => (action) => next(action),
    markStoreReady: jest.fn()
  }));
  // No saves: models a reload that happens before the first debounced flush.
  jest.doMock('../src/renderer/store/middleware/persistenceMiddleware', () => ({
    __esModule: true,
    default: () => (next) => (action) => next(action)
  }));
  installStorage(storage);
  delete window.__STRATOSORT_STATE_EXPIRED__;
  delete window.__STRATOSORT_STATE_EXPIRED_AGE_HOURS__;
  delete window.__STRATOSORT_STATE_RESTORED_FROM_BACKUP__;
  delete window.__STRATOSORT_STATE_FUTURE_VERSION__;
  const storeModule = require('../src/renderer/store/index');
  return storeModule.default || storeModule;
}

describe('persisted Redux state recovery across reloads', () => {
  test('a TTL-expired blob keeps organize history when the renderer reloads before any save', () => {
    const staleBlob = JSON.stringify({
      _version: 4,
      timestamp: Date.now() - 48 * 60 * 60 * 1000,
      ui: { currentPhase: 'organize', viewMode: 'dashboard' },
      files: {
        selectedFiles: [{ path: 'C:/docs/pending.pdf' }],
        organizedFiles: [{ path: 'C:/docs/a.pdf' }],
        organizedPathIndex: ['c:/docs/a.pdf', 'c:/docs/b.pdf'],
        smartFolders: [{ id: 'sf-keep', name: 'Keep Me' }],
        fileStates: {}
      },
      analysis: { results: [] }
    });
    const storage = { [REDUX_STATE_KEY]: staleBlob };

    const first = bootStore(storage).getState();
    expect(window.__STRATOSORT_STATE_EXPIRED__).toBe(true);
    expect(first.files.organizedPathIndex).toEqual(
      expect.arrayContaining(['c:/docs/a.pdf', 'c:/docs/b.pdf'])
    );

    // The live key already holds a fresh durable snapshot, not nothing.
    const live = JSON.parse(storage[REDUX_STATE_KEY]);
    expect(Date.now() - live.timestamp).toBeLessThan(60 * 1000);

    const second = bootStore(storage).getState();
    expect(second.files.organizedPathIndex).toEqual(
      expect.arrayContaining(['c:/docs/a.pdf', 'c:/docs/b.pdf'])
    );
    expect(second.files.organizedFiles).toHaveLength(1);
    expect(second.files.smartFolders).toHaveLength(1);
    expect(second.files.selectedFiles).toEqual([]);
    expect(second.ui.currentPhase).toBe('welcome');
    expect(second.ui.viewMode).toBe('dashboard');
    // The fresh snapshot is not itself stale, so the banner does not repeat.
    expect(window.__STRATOSORT_STATE_EXPIRED__).toBeUndefined();
  });

  test('a TTL-expired blob keeps the graph hint, dock and tour preferences', () => {
    const staleBlob = JSON.stringify({
      _version: 4,
      timestamp: Date.now() - 48 * 60 * 60 * 1000,
      ui: {
        currentPhase: 'organize',
        graphTourDismissed: true,
        graphLegendHintDismissed: true,
        graphInsightsDockCollapsed: true
      },
      files: { selectedFiles: [], smartFolders: [], fileStates: {} },
      analysis: { results: [] }
    });
    const storage = { [REDUX_STATE_KEY]: staleBlob };

    const first = bootStore(storage).getState();
    expect(window.__STRATOSORT_STATE_EXPIRED__).toBe(true);
    expect(first.ui.currentPhase).toBe('welcome');
    expect(first.ui.graphLegendHintDismissed).toBe(true);
    expect(first.ui.graphInsightsDockCollapsed).toBe(true);
    expect(first.ui.graphTourDismissed).toBe(true);

    // The replacement snapshot carries them, so a reload before the first
    // debounced save keeps them too.
    const live = JSON.parse(storage[REDUX_STATE_KEY]);
    expect(live.ui).toEqual(
      expect.objectContaining({
        graphTourDismissed: true,
        graphLegendHintDismissed: true,
        graphInsightsDockCollapsed: true
      })
    );
    const second = bootStore(storage).getState();
    expect(window.__STRATOSORT_STATE_EXPIRED__).toBeUndefined();
    expect(second.ui.graphLegendHintDismissed).toBe(true);
    expect(second.ui.graphInsightsDockCollapsed).toBe(true);
    expect(second.ui.graphTourDismissed).toBe(true);
  });

  test('a TTL-expired blob reads the tour dismissal from its own storage key and invents no preference', () => {
    const staleBlob = JSON.stringify({
      _version: 4,
      timestamp: Date.now() - 48 * 60 * 60 * 1000,
      ui: { currentPhase: 'organize', graphLegendHintDismissed: 'yes' },
      files: { selectedFiles: [], smartFolders: [], fileStates: {} },
      analysis: { results: [] }
    });
    const storage = { [REDUX_STATE_KEY]: staleBlob, graphTourDismissed: 'true' };

    const state = bootStore(storage).getState();
    expect(window.__STRATOSORT_STATE_EXPIRED__).toBe(true);
    expect(state.ui.graphTourDismissed).toBe(true);
    expect(state.ui.graphLegendHintDismissed).toBe(false);
    expect(state.ui.graphInsightsDockCollapsed).toBe(false);
    // The synchronous mirror key is the durable fallback; loading never removes it.
    expect(storage.graphTourDismissed).toBe('true');
  });

  test('a future-version blob does not overwrite the last known-good backup', () => {
    const goodBackup = JSON.stringify({
      _version: 4,
      timestamp: Date.now(),
      ui: { currentPhase: 'discover' },
      files: { selectedFiles: [], smartFolders: [{ id: 'sf-1', name: 'Invoices' }] },
      analysis: { results: [] }
    });
    const futureBlob = JSON.stringify({
      _version: 99,
      timestamp: Date.now(),
      ui: { currentPhase: 'organize' },
      files: {},
      analysis: {}
    });
    const storage = { [REDUX_STATE_KEY]: futureBlob, [BACKUP_KEY]: goodBackup };

    const state = bootStore(storage).getState();

    expect(window.__STRATOSORT_STATE_FUTURE_VERSION__).toBeTruthy();
    expect(state.ui.currentPhase).toBe('welcome');
    expect(storage[BACKUP_KEY]).toBe(goodBackup);
    expect(storage[REDUX_STATE_KEY]).not.toBe(futureBlob);
    expect(storage[CORRUPT_KEY]).toBe(futureBlob);
  });

  test('a valid blob is still backed up before it is replaced', () => {
    const blob = JSON.stringify({
      _version: 4,
      timestamp: Date.now(),
      ui: { currentPhase: 'discover' },
      files: { selectedFiles: [], smartFolders: [] },
      analysis: { results: [] }
    });
    const storage = { [REDUX_STATE_KEY]: blob };

    bootStore(storage);

    expect(storage[BACKUP_KEY]).toBe(blob);
  });
});
