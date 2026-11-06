/**
 * Live Activity on/off thunks: optimistic store update, single-key save,
 * rollback when the save fails, a toggle that reads the current value, and
 * rapid toggles that can never leave the store and the saved setting apart.
 */
jest.mock('../src/renderer/services/ipc', () => ({
  settingsIpc: { save: jest.fn() }
}));

jest.mock('../src/renderer/store/slices/uiSlice', () => ({
  updateSettings: jest.fn((payload) => ({ type: 'ui/updateSettings', payload }))
}));

const { settingsIpc } = require('../src/renderer/services/ipc');
const {
  setShowLiveActivity,
  toggleShowLiveActivity
} = require('../src/renderer/store/thunks/liveActivityThunks');

/**
 * A store whose state follows the ui/updateSettings actions it receives, so
 * a second toggle reads what the first one wrote.
 */
function makeStore(showLiveActivity) {
  const state = { ui: { settings: { showLiveActivity } } };
  const actions = [];
  const getState = () => state;
  const dispatch = jest.fn((action) => {
    if (typeof action === 'function') return action(dispatch, getState);
    actions.push(action);
    if (action.type === 'ui/updateSettings') {
      state.ui.settings = { ...state.ui.settings, ...action.payload };
    }
    return action;
  });
  return { dispatch, actions, current: () => state.ui.settings.showLiveActivity };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets queued promise callbacks (the thunk's await chain) run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** The value the main process would hold after every save that succeeded, in order. */
function persistedAfter(outcomes) {
  let persisted;
  settingsIpc.save.mock.calls.forEach(([payload], index) => {
    if (outcomes[index] === 'ok') persisted = payload.showLiveActivity;
  });
  return persisted;
}

describe('live activity thunks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('turning on updates the store first, then saves only that key', async () => {
    settingsIpc.save.mockResolvedValue({ success: true, settings: { showLiveActivity: true } });
    const store = makeStore(false);

    await expect(store.dispatch(setShowLiveActivity(true))).resolves.toBe(true);

    expect(store.actions).toEqual([
      { type: 'ui/updateSettings', payload: { showLiveActivity: true } }
    ]);
    expect(settingsIpc.save).toHaveBeenCalledWith({ showLiveActivity: true });
  });

  test('the store changes before the save answers', async () => {
    const save = deferred();
    settingsIpc.save.mockReturnValue(save.promise);
    const store = makeStore(false);

    const pending = store.dispatch(setShowLiveActivity(true));
    expect(store.current()).toBe(true);

    save.resolve({ success: true });
    await expect(pending).resolves.toBe(true);
  });

  test('a rejected save puts the previous value back', async () => {
    settingsIpc.save.mockResolvedValue({ success: false, error: 'Invalid settings provided' });
    const store = makeStore(false);

    await expect(store.dispatch(setShowLiveActivity(true))).resolves.toBe(false);

    expect(store.actions).toEqual([
      { type: 'ui/updateSettings', payload: { showLiveActivity: true } },
      { type: 'ui/updateSettings', payload: { showLiveActivity: false } }
    ]);
  });

  test('a thrown save puts the previous value back', async () => {
    settingsIpc.save.mockRejectedValue(new Error('IPC timeout'));
    const store = makeStore(true);

    await expect(store.dispatch(setShowLiveActivity(false))).resolves.toBe(false);

    expect(store.actions).toEqual([
      { type: 'ui/updateSettings', payload: { showLiveActivity: false } },
      { type: 'ui/updateSettings', payload: { showLiveActivity: true } }
    ]);
  });

  test('a save that throws synchronously (settings API missing) also rolls back', async () => {
    settingsIpc.save.mockImplementation(() => {
      throw new Error('Settings API method unavailable: save');
    });
    const store = makeStore(false);

    await expect(store.dispatch(setShowLiveActivity(true))).resolves.toBe(false);
    expect(store.current()).toBe(false);
  });

  test('toggle flips the current value', async () => {
    settingsIpc.save.mockResolvedValue({ success: true });
    const store = makeStore(true);

    await store.dispatch(toggleShowLiveActivity());

    expect(settingsIpc.save).toHaveBeenCalledWith({ showLiveActivity: false });
    expect(store.current()).toBe(false);
  });

  test('toggle treats a missing value as off', async () => {
    settingsIpc.save.mockResolvedValue({ success: true });
    const store = makeStore(undefined);

    await store.dispatch(toggleShowLiveActivity());

    expect(settingsIpc.save).toHaveBeenCalledWith({ showLiveActivity: true });
  });

  describe('rapid toggles', () => {
    test('a second toggle while the first save is in flight waits, then saves the newer value', async () => {
      const first = deferred();
      settingsIpc.save.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ success: true });
      const store = makeStore(false);

      const a = store.dispatch(toggleShowLiveActivity());
      const b = store.dispatch(toggleShowLiveActivity());

      // Both toggles reach the store at once; only one save is on the wire.
      expect(store.current()).toBe(false);
      expect(settingsIpc.save).toHaveBeenCalledTimes(1);
      expect(settingsIpc.save).toHaveBeenLastCalledWith({ showLiveActivity: true });

      first.resolve({ success: true });
      await expect(Promise.all([a, b])).resolves.toEqual([true, true]);

      expect(settingsIpc.save).toHaveBeenCalledTimes(2);
      expect(settingsIpc.save).toHaveBeenLastCalledWith({ showLiveActivity: false });
      expect(store.current()).toBe(false);
      expect(persistedAfter(['ok', 'ok'])).toBe(false);
    });

    test('a failed first save does not roll back over a newer toggle', async () => {
      const first = deferred();
      settingsIpc.save.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ success: true });
      const store = makeStore(false);

      const a = store.dispatch(setShowLiveActivity(true));
      const b = store.dispatch(setShowLiveActivity(false));

      first.reject(new Error('IPC timeout'));
      await expect(Promise.all([a, b])).resolves.toEqual([true, true]);

      // No rollback action: the store only ever saw the two requests.
      expect(store.actions).toEqual([
        { type: 'ui/updateSettings', payload: { showLiveActivity: true } },
        { type: 'ui/updateSettings', payload: { showLiveActivity: false } }
      ]);
      expect(store.current()).toBe(false);
      expect(persistedAfter(['fail', 'ok'])).toBe(false);
    });

    test('when both saves fail the store ends on the value that is actually saved', async () => {
      // Per-request rollback would end on `true` here: the second request's
      // "previous" was the first request's unsaved optimistic value.
      const first = deferred();
      const second = deferred();
      settingsIpc.save.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const store = makeStore(false);

      const a = store.dispatch(setShowLiveActivity(true));
      const b = store.dispatch(setShowLiveActivity(false));

      first.reject(new Error('IPC timeout'));
      await flush();
      expect(settingsIpc.save).toHaveBeenCalledTimes(2);
      expect(settingsIpc.save).toHaveBeenLastCalledWith({ showLiveActivity: false });

      second.reject(new Error('IPC timeout'));
      await expect(Promise.all([a, b])).resolves.toEqual([false, false]);

      expect(store.current()).toBe(false);
      expect(persistedAfter(['fail', 'fail'])).toBeUndefined();
    });

    test('toggling back to the value being saved needs no second save', async () => {
      const first = deferred();
      settingsIpc.save.mockReturnValueOnce(first.promise);
      const store = makeStore(false);

      const pending = [
        store.dispatch(toggleShowLiveActivity()),
        store.dispatch(toggleShowLiveActivity()),
        store.dispatch(toggleShowLiveActivity())
      ];
      expect(store.current()).toBe(true);

      first.resolve({ success: true });
      await expect(Promise.all(pending)).resolves.toEqual([true, true, true]);

      expect(settingsIpc.save).toHaveBeenCalledTimes(1);
      expect(store.current()).toBe(true);
      expect(persistedAfter(['ok'])).toBe(true);
    });

    test('toggling back to a value whose save then fails rolls back without a retry', async () => {
      const first = deferred();
      settingsIpc.save.mockReturnValueOnce(first.promise);
      const store = makeStore(false);

      const pending = [
        store.dispatch(toggleShowLiveActivity()),
        store.dispatch(toggleShowLiveActivity()),
        store.dispatch(toggleShowLiveActivity())
      ];

      first.reject(new Error('IPC timeout'));
      await expect(Promise.all(pending)).resolves.toEqual([false, false, false]);

      expect(settingsIpc.save).toHaveBeenCalledTimes(1);
      expect(store.current()).toBe(false);
    });

    test('after a run settles the next request starts from the store again', async () => {
      settingsIpc.save.mockResolvedValueOnce({ success: true });
      const store = makeStore(false);

      await store.dispatch(setShowLiveActivity(true));
      // A change that arrived from elsewhere (the Settings switch, a broadcast).
      store.dispatch({ type: 'ui/updateSettings', payload: { showLiveActivity: false } });

      settingsIpc.save.mockRejectedValueOnce(new Error('IPC timeout'));
      await expect(store.dispatch(setShowLiveActivity(true))).resolves.toBe(false);

      expect(store.current()).toBe(false);
    });

    test('separate stores keep separate save state', async () => {
      const first = deferred();
      settingsIpc.save.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ success: true });
      const storeA = makeStore(false);
      const storeB = makeStore(false);

      const a = storeA.dispatch(setShowLiveActivity(true));
      const b = storeB.dispatch(setShowLiveActivity(true));

      // B does not queue behind A's in-flight save.
      expect(settingsIpc.save).toHaveBeenCalledTimes(2);
      await expect(b).resolves.toBe(true);
      first.resolve({ success: true });
      await expect(a).resolves.toBe(true);
    });
  });
});
