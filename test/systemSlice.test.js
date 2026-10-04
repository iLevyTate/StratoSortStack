/**
 * Tests for System Slice
 * Covers notifications and async config/document path loading
 */

import { configureStore } from '@reduxjs/toolkit';

jest.mock('../src/renderer/services/ipc', () => ({
  filesIpc: {
    getDocumentsPath: jest.fn()
  },
  systemIpc: {
    getConfigValue: jest.fn(),
    dismissDegradedFlag: jest.fn()
  }
}));

import systemReducer, {
  addNotification,
  removeNotification,
  markNotificationSeen,
  markNotificationDismissed,
  markAllNotificationsSeen,
  setDocumentsPath,
  fetchDocumentsPath,
  fetchRedactPaths,
  dismissDegradedFlag
} from '../src/renderer/store/slices/systemSlice';
import { selectRedactPaths } from '../src/renderer/store/selectors';

const { filesIpc, systemIpc } = require('../src/renderer/services/ipc');

describe('systemSlice', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('initial state', () => {
    test('returns initial state', () => {
      const result = systemReducer(undefined, { type: 'unknown' });

      expect(result.metrics).toEqual({ cpu: 0, memory: 0, uptime: 0 });
      expect(result.notifications).toEqual([]);
      expect(result.unreadNotificationCount).toBe(0);
      expect(result.documentsPath).toBeNull();
      expect(result.documentsPathLoaded).toBe(false);
      expect(result.redactPathsLoaded).toBe(false);
    });
  });

  describe('notifications', () => {
    test('adds notification and increments unread count', () => {
      const result = systemReducer(
        undefined,
        addNotification({ message: 'Test', severity: 'info' })
      );

      expect(result.notifications).toHaveLength(1);
      expect(result.notifications[0].status).toBe('displayed');
      expect(result.unreadNotificationCount).toBe(1);
    });

    test('markNotificationSeen decrements unread count', () => {
      const state = systemReducer(
        undefined,
        addNotification({ id: 'n1', message: 'Test', severity: 'info' })
      );

      const result = systemReducer(state, markNotificationSeen('n1'));

      expect(result.notifications[0].status).toBe('seen');
      expect(result.unreadNotificationCount).toBe(0);
    });

    test('markNotificationDismissed decrements unread count', () => {
      const state = systemReducer(
        undefined,
        addNotification({ id: 'n1', message: 'Test', severity: 'info' })
      );

      const result = systemReducer(state, markNotificationDismissed('n1'));

      expect(result.notifications[0].status).toBe('dismissed');
      expect(result.unreadNotificationCount).toBe(0);
    });

    test('markAllNotificationsSeen clears unread count', () => {
      let state = systemReducer(
        undefined,
        addNotification({ id: 'n1', message: 'First', severity: 'info' })
      );
      state = systemReducer(state, addNotification({ id: 'n2', message: 'Second' }));

      const result = systemReducer(state, markAllNotificationsSeen());

      expect(result.notifications.every((n) => n.status === 'seen')).toBe(true);
      expect(result.unreadNotificationCount).toBe(0);
    });

    test('removeNotification decrements unread count when unseen', () => {
      const state = systemReducer(
        undefined,
        addNotification({ id: 'n1', message: 'Test', severity: 'info' })
      );

      const result = systemReducer(state, removeNotification('n1'));

      expect(result.notifications).toHaveLength(0);
      expect(result.unreadNotificationCount).toBe(0);
    });
  });

  describe('setDocumentsPath', () => {
    test('normalizes documents path from object payload', () => {
      const result = systemReducer(undefined, setDocumentsPath({ path: '/docs' }));
      expect(result.documentsPath).toBe('/docs');
    });
  });

  describe('fetchDocumentsPath', () => {
    test('returns cached documents path if already loaded', async () => {
      filesIpc.getDocumentsPath.mockResolvedValue('/should-not-call');

      const store = configureStore({
        reducer: { system: systemReducer },
        preloadedState: {
          system: {
            ...systemReducer(undefined, { type: 'init' }),
            documentsPath: '/cached',
            documentsPathLoaded: true
          }
        }
      });

      const action = await store.dispatch(fetchDocumentsPath());

      expect(action.payload).toBe('/cached');
      expect(filesIpc.getDocumentsPath).not.toHaveBeenCalled();
    });

    test('stores normalized documents path on success', async () => {
      filesIpc.getDocumentsPath.mockResolvedValue({ path: '/mock/documents' });

      const store = configureStore({ reducer: { system: systemReducer } });
      await store.dispatch(fetchDocumentsPath());

      const state = store.getState().system;
      expect(state.documentsPath).toBe('/mock/documents');
      expect(state.documentsPathLoaded).toBe(true);
      expect(state.documentsPathLoading).toBe(false);
      expect(state.documentsPathError).toBeNull();
    });

    test('stores error and fallback path on failure', async () => {
      filesIpc.getDocumentsPath.mockRejectedValue(new Error('boom'));

      const store = configureStore({ reducer: { system: systemReducer } });
      await store.dispatch(fetchDocumentsPath());

      const state = store.getState().system;
      expect(state.documentsPath).toBe('Documents');
      expect(state.documentsPathLoaded).toBe(false);
      expect(state.documentsPathError).toBe('boom');
    });

    test('retries after transient failure because failed fallback is not treated as loaded', async () => {
      filesIpc.getDocumentsPath
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce('/recovered');

      const store = configureStore({ reducer: { system: systemReducer } });
      await store.dispatch(fetchDocumentsPath());
      expect(store.getState().system.documentsPathLoaded).toBe(false);

      await store.dispatch(fetchDocumentsPath());
      const state = store.getState().system;
      expect(state.documentsPath).toBe('/recovered');
      expect(state.documentsPathLoaded).toBe(true);
      expect(filesIpc.getDocumentsPath).toHaveBeenCalledTimes(2);
    });
  });

  describe('fetchRedactPaths', () => {
    test('returns cached redactPaths if already loaded', async () => {
      systemIpc.getConfigValue.mockResolvedValue(true);

      const store = configureStore({
        reducer: { system: systemReducer },
        preloadedState: {
          system: {
            ...systemReducer(undefined, { type: 'init' }),
            redactPaths: true,
            redactPathsLoaded: true
          }
        }
      });

      const action = await store.dispatch(fetchRedactPaths());

      expect(action.payload).toBe(true);
      expect(systemIpc.getConfigValue).not.toHaveBeenCalled();
    });

    test('stores redactPaths flag on success', async () => {
      systemIpc.getConfigValue.mockResolvedValue('true');

      const store = configureStore({ reducer: { system: systemReducer } });
      await store.dispatch(fetchRedactPaths());

      const state = store.getState().system;
      expect(state.redactPaths).toBe(true);
      expect(state.redactPathsLoaded).toBe(true);
      expect(state.redactPathsLoading).toBe(false);
      expect(state.redactPathsError).toBeNull();
    });

    test('stores error on failure', async () => {
      systemIpc.getConfigValue.mockRejectedValue(new Error('nope'));

      const store = configureStore({ reducer: { system: systemReducer } });
      await store.dispatch(fetchRedactPaths());

      const state = store.getState().system;
      expect(state.redactPaths).toBeNull();
      expect(state.redactPathsLoaded).toBe(false);
      expect(state.redactPathsError).toBe('nope');
      expect(selectRedactPaths({ system: state })).toBe(true);
    });

    test('retries redact-path fetch after transient failure', async () => {
      systemIpc.getConfigValue
        .mockRejectedValueOnce(new Error('temporary'))
        .mockResolvedValueOnce(true);

      const store = configureStore({ reducer: { system: systemReducer } });
      await store.dispatch(fetchRedactPaths());
      expect(store.getState().system.redactPathsLoaded).toBe(false);

      await store.dispatch(fetchRedactPaths());
      const state = store.getState().system;
      expect(state.redactPaths).toBe(true);
      expect(state.redactPathsLoaded).toBe(true);
      expect(systemIpc.getConfigValue).toHaveBeenCalledTimes(2);
    });

    test('preserves the previous redactPaths value after a failed refresh', async () => {
      systemIpc.getConfigValue.mockRejectedValue(new Error('still failing'));

      const store = configureStore({
        reducer: { system: systemReducer },
        preloadedState: {
          system: {
            ...systemReducer(undefined, { type: 'init' }),
            redactPaths: false,
            redactPathsLoaded: true
          }
        }
      });

      await store.dispatch(fetchRedactPaths(true));
      const state = store.getState().system;
      expect(state.redactPaths).toBe(false);
      expect(state.redactPathsLoaded).toBe(false);
      expect(selectRedactPaths({ system: state })).toBe(false);
    });
  });

  describe('dismissDegradedFlag', () => {
    test('marks the matching flag dismissed on success', async () => {
      systemIpc.dismissDegradedFlag.mockResolvedValue({ success: true });

      const store = configureStore({
        reducer: { system: systemReducer },
        preloadedState: {
          system: {
            ...systemReducer(undefined, { type: 'init' }),
            degradedFlags: [
              { code: 'whisper.model-missing', message: 'x', dismissed: false },
              { code: 'other.flag', message: 'y', dismissed: false }
            ]
          }
        }
      });

      await store.dispatch(dismissDegradedFlag('whisper.model-missing'));

      const state = store.getState().system;
      expect(state.degradedFlags.find((f) => f.code === 'whisper.model-missing').dismissed).toBe(
        true
      );
      expect(state.degradedFlags.find((f) => f.code === 'other.flag').dismissed).toBe(false);
      expect(state.degradedFlagsError).toBeNull();
    });

    test('records degradedFlagsError when the dismiss IPC rejects', async () => {
      systemIpc.dismissDegradedFlag.mockRejectedValue(new Error('ipc down'));

      const store = configureStore({
        reducer: { system: systemReducer },
        preloadedState: {
          system: {
            ...systemReducer(undefined, { type: 'init' }),
            degradedFlags: [{ code: 'whisper.model-missing', message: 'x', dismissed: false }]
          }
        }
      });

      await store.dispatch(dismissDegradedFlag('whisper.model-missing'));

      const state = store.getState().system;
      // Flag stays visible (not falsely marked dismissed) and the error is recorded.
      expect(state.degradedFlags[0].dismissed).toBe(false);
      expect(state.degradedFlagsError).toBe('ipc down');
    });

    test('rejects without calling IPC when the code is missing', async () => {
      const store = configureStore({ reducer: { system: systemReducer } });

      const action = await store.dispatch(dismissDegradedFlag(''));

      expect(action.type).toBe('system/dismissDegradedFlag/rejected');
      expect(systemIpc.dismissDegradedFlag).not.toHaveBeenCalled();
      expect(store.getState().system.degradedFlagsError).toBe('Missing flag code');
    });
  });

  describe('selectRedactPaths', () => {
    test('defaults to redacted when setting is still unknown', () => {
      const state = { system: systemReducer(undefined, { type: 'init' }) };
      expect(selectRedactPaths(state)).toBe(true);
    });

    test('preserves a true value during a retryable reload state', () => {
      const state = {
        system: {
          ...systemReducer(undefined, { type: 'init' }),
          redactPaths: true,
          redactPathsLoaded: false
        }
      };
      expect(selectRedactPaths(state)).toBe(true);
    });

    test('preserves a false value during a retryable reload state', () => {
      const state = {
        system: {
          ...systemReducer(undefined, { type: 'init' }),
          redactPaths: false,
          redactPathsLoaded: false
        }
      };
      expect(selectRedactPaths(state)).toBe(false);
    });

    test('returns stored value after setting is loaded', () => {
      const state = {
        system: {
          ...systemReducer(undefined, { type: 'init' }),
          redactPaths: false,
          redactPathsLoaded: true
        }
      };
      expect(selectRedactPaths(state)).toBe(false);
    });
  });
});
