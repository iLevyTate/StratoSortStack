/**
 * Tests for Redux state migrations
 */

jest.mock('../src/shared/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn()
  }
}));

import {
  clearSerializedStateBackup,
  CURRENT_STATE_VERSION,
  migrateState,
  MIGRATION_BACKUP_KEY,
  MIGRATION_BACKUP_MAX_BYTES,
  restoreSerializedStateBackup,
  safeBackupSerializedState
} from '../src/renderer/store/migrations';

describe('migrations', () => {
  test('CURRENT_STATE_VERSION is defined', () => {
    expect(CURRENT_STATE_VERSION).toBe(4);
  });

  test('returns state unchanged when null or undefined', () => {
    expect(migrateState(null)).toBe(null);
    expect(migrateState(undefined)).toBe(undefined);
  });

  test('returns state unchanged when already at current version', () => {
    const state = {
      _version: CURRENT_STATE_VERSION,
      files: { organizedPathIndex: [] },
      analysis: {},
      ui: {}
    };
    expect(migrateState(state)).toEqual(state);
  });

  test('migrates v0 to v1 - ensures slices and arrays exist', () => {
    const state = { _version: 0 };
    const migrated = migrateState(state);

    expect(migrated._version).toBe(4);
    expect(migrated.ui).toEqual({ selectedTheme: 'primary' });
    expect(migrated.files).toBeDefined();
    expect(migrated.analysis).toBeDefined();
    expect(Array.isArray(migrated.files.selectedFiles)).toBe(true);
    expect(Array.isArray(migrated.files.smartFolders)).toBe(true);
    expect(Array.isArray(migrated.files.organizedFiles)).toBe(true);
    expect(Array.isArray(migrated.analysis.results)).toBe(true);
  });

  test('migrates v1 to v2 - removes deprecated isAnalyzing from ui', () => {
    const state = {
      _version: 1,
      ui: { isAnalyzing: true, otherKey: 'keep' },
      files: {},
      analysis: {}
    };
    const migrated = migrateState(state);

    expect(migrated._version).toBe(4);
    expect(migrated.ui.isAnalyzing).toBeUndefined();
    expect(migrated.ui.otherKey).toBe('keep');
  });

  test('migrates v2 to v3 - defaults ui.selectedTheme to primary', () => {
    const state = {
      _version: 2,
      ui: { viewMode: 'dashboard' },
      files: {},
      analysis: {}
    };
    const migrated = migrateState(state);

    expect(migrated._version).toBe(4);
    expect(migrated.ui.selectedTheme).toBe('primary');
    // Unrelated ui preferences are preserved.
    expect(migrated.ui.viewMode).toBe('dashboard');
  });

  test('v2 to v3 preserves an already-set selectedTheme', () => {
    const state = {
      _version: 2,
      ui: { selectedTheme: 'dark' },
      files: {},
      analysis: {}
    };
    const migrated = migrateState(state);

    expect(migrated._version).toBe(4);
    expect(migrated.ui.selectedTheme).toBe('dark');
  });

  test('migrates v3 to v4 - seeds organizedPathIndex from organizedFiles', () => {
    const state = {
      _version: 3,
      ui: { selectedTheme: 'primary' },
      files: {
        organizedFiles: [
          {
            originalPath: 'C:\\Downloads\\a.pdf',
            path: 'C:\\Docs\\a.pdf'
          },
          {
            originalPath: 'C:\\Downloads\\b.pdf',
            path: 'C:\\Docs\\b.pdf'
          }
        ]
      },
      analysis: {}
    };
    const migrated = migrateState(state);

    expect(migrated._version).toBe(4);
    expect(migrated.files.organizedPathIndex).toEqual(
      expect.arrayContaining([
        'c:/downloads/a.pdf',
        'c:/docs/a.pdf',
        'c:/downloads/b.pdf',
        'c:/docs/b.pdf'
      ])
    );
  });

  test('handles legacy state without version tag (assumes v0)', () => {
    const state = { files: { selectedFiles: null } };
    const migrated = migrateState(state);

    expect(migrated._version).toBe(4);
    expect(Array.isArray(migrated.files.selectedFiles)).toBe(true);
  });

  test('returns null on migration error to force state reset', () => {
    const state = {
      _version: 0,
      files: {
        get selectedFiles() {
          throw new Error('cannot read');
        }
      }
    };
    const migrated = migrateState(state);

    expect(migrated).toBeNull();
  });

  test('rejects future _version by returning null (no down-migration)', () => {
    const state = { _version: CURRENT_STATE_VERSION + 1, files: {}, analysis: {}, ui: {} };
    expect(migrateState(state)).toBeNull();
  });

  test('rejects non-finite _version by returning null', () => {
    expect(migrateState({ _version: Number.NaN })).toBeNull();
    expect(migrateState({ _version: Number.POSITIVE_INFINITY })).toBeNull();
    expect(migrateState({ _version: -1 })).toBeNull();
  });

  test('signals future-version on globalThis.window when available', () => {
    const originalWindow = globalThis.window;
    globalThis.window = {};
    try {
      migrateState({ _version: 999 });
      expect(globalThis.window.__STRATOSORT_STATE_FUTURE_VERSION__).toMatchObject({
        rawVersion: 999,
        currentVersion: CURRENT_STATE_VERSION
      });
    } finally {
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
    }
  });

  test('creates and clears a migration backup for small serialized state', () => {
    const storage = {
      setItem: jest.fn(),
      getItem: jest.fn().mockReturnValue('{"_version":0}'),
      removeItem: jest.fn()
    };

    const result = safeBackupSerializedState('{"_version":0}', storage);
    expect(result.created).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(MIGRATION_BACKUP_KEY, '{"_version":0}');

    expect(restoreSerializedStateBackup(storage)).toBe(true);
    expect(storage.setItem).toHaveBeenLastCalledWith('stratosort_redux_state', '{"_version":0}');

    clearSerializedStateBackup(storage);
    expect(storage.removeItem).toHaveBeenCalledWith(MIGRATION_BACKUP_KEY);
  });

  test('skips migration backup when serialized state is too large', () => {
    const storage = {
      setItem: jest.fn()
    };
    const oversizedState = 'x'.repeat(MIGRATION_BACKUP_MAX_BYTES + 1);

    const result = safeBackupSerializedState(oversizedState, storage);

    expect(result.created).toBe(false);
    expect(result.reason).toBe('too_large');
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  describe('adversarial _version handling', () => {
    test('string _version is treated as legacy (non-number) and migrated from v0', () => {
      const state = { _version: '2', ui: { junk: 'x' }, files: {}, analysis: {} };
      const migrated = migrateState(state);

      expect(migrated).not.toBeNull();
      expect(migrated._version).toBe(CURRENT_STATE_VERSION);
      expect(Array.isArray(migrated.files.selectedFiles)).toBe(true);
    });

    test('boolean _version is treated as legacy v0 and migrated', () => {
      const state = { _version: true, files: {}, analysis: {}, ui: {} };
      const migrated = migrateState(state);

      expect(migrated).not.toBeNull();
      expect(migrated._version).toBe(CURRENT_STATE_VERSION);
    });

    test('fractional _version triggers migration gap and returns null', () => {
      const state = { _version: 0.5, files: {}, analysis: {}, ui: {} };
      expect(migrateState(state)).toBeNull();
    });

    test('extra top-level keys are preserved through migration', () => {
      const state = {
        _version: 1,
        files: {},
        analysis: {},
        ui: { isAnalyzing: true, other: 'keep' },
        customFutureSlice: { value: 42 }
      };
      const migrated = migrateState(state);

      expect(migrated._version).toBe(CURRENT_STATE_VERSION);
      expect(migrated.customFutureSlice).toEqual({ value: 42 });
      expect(migrated.ui.other).toBe('keep');
      expect(migrated.ui.isAnalyzing).toBeUndefined();
    });

    test('wrong-type slices are rebuilt defensively during v0->v1', () => {
      const state = {
        _version: 0,
        files: 'not-an-object',
        analysis: 42,
        ui: null
      };
      const migrated = migrateState(state);

      expect(migrated).not.toBeNull();
      expect(migrated._version).toBe(CURRENT_STATE_VERSION);
      expect(migrated.files).toEqual(
        expect.objectContaining({
          selectedFiles: [],
          smartFolders: [],
          organizedFiles: []
        })
      );
      expect(migrated.analysis).toEqual(expect.objectContaining({ results: [] }));
      expect(migrated.ui).toEqual({ selectedTheme: 'primary' });
    });

    test('non-object system slice is dropped during migration', () => {
      const state = {
        _version: 0,
        files: {},
        analysis: {},
        ui: {},
        system: 'corrupt'
      };
      const migrated = migrateState(state);

      expect(migrated).not.toBeNull();
      expect(migrated.system).toBeUndefined();
    });

    test('surfaces invalid-version signal on globalThis.window', () => {
      const originalWindow = globalThis.window;
      globalThis.window = {};
      try {
        const result = migrateState({ _version: -5 });
        expect(result).toBeNull();
        expect(globalThis.window.__STRATOSORT_STATE_INVALID_VERSION__).toMatchObject({
          rawVersion: -5,
          currentVersion: CURRENT_STATE_VERSION
        });
      } finally {
        if (originalWindow === undefined) delete globalThis.window;
        else globalThis.window = originalWindow;
      }
    });
  });
});
