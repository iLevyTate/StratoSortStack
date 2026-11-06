// @ts-check
/**
 * Live Activity panel on/off from anywhere in the app (the panel's Close
 * button and Ctrl/Cmd+Shift+L). The Settings → Diagnostics switch goes
 * through SettingsPanel's own local-state auto-save instead.
 *
 * The store is updated first so the panel opens or closes immediately; only
 * the one key is saved (settings:save merges partial objects). An open
 * SettingsPanel adopts the new value from the store like any other external
 * settings change.
 *
 * Rapid toggles: one save runs at a time per store. A request made while a
 * save is in flight only updates the store and the wanted value; when the
 * save answers, the newest wanted value is saved next if it differs. A failed
 * save is put back only when nothing newer was asked for, and it goes back to
 * the last value known to be saved — never to a value that was only ever
 * optimistic — so the store and the saved setting cannot drift apart.
 */
import { updateSettings } from '../slices/uiSlice';
import { settingsIpc } from '../../services/ipc';
import { logger } from '../../../shared/logger';

/**
 * @typedef {object} LiveActivitySync
 * @property {boolean} saved  Last value known to be saved.
 * @property {boolean} wanted Newest value asked for.
 * @property {Promise<boolean> | null} run The save loop in flight, if any.
 */

/**
 * Save state per store, keyed by its getState (stable for a store's life).
 * @type {WeakMap<Function, LiveActivitySync>}
 */
const syncByStore = new WeakMap();

/**
 * @param {() => any} getState
 * @returns {boolean}
 */
function readShowLiveActivity(getState) {
  return getState()?.ui?.settings?.showLiveActivity === true;
}

/**
 * @param {boolean} value
 * @returns {Promise<void>}
 */
async function saveShowLiveActivity(value) {
  const result = await settingsIpc.save({ showLiveActivity: value });
  if (result && typeof result === 'object' && result.success === false) {
    throw new Error(result.error || 'Settings save was rejected');
  }
}

/**
 * Save the wanted value until it is saved or a save of it fails.
 * @param {LiveActivitySync} sync
 * @param {(action: any) => any} dispatch
 * @returns {Promise<boolean>} true when the store's final value was saved
 */
async function saveUntilSettled(sync, dispatch) {
  try {
    let target = sync.wanted;
    for (;;) {
      let ok = false;
      try {
        await saveShowLiveActivity(target);
        sync.saved = target;
        ok = true;
      } catch (error) {
        logger.warn('[LiveActivity] Could not save the live activity setting', {
          error: /** @type {any} */ (error)?.message
        });
      }
      if (sync.wanted !== target) {
        // Asked for something else while this save was in flight.
        target = sync.wanted;
        continue;
      }
      if (ok) return true;
      sync.wanted = sync.saved;
      dispatch(updateSettings({ showLiveActivity: sync.saved }));
      return false;
    }
  } finally {
    sync.run = null;
  }
}

/**
 * @param {boolean} enabled
 * @returns {(dispatch: any, getState: () => any) => Promise<boolean>}
 */
export const setShowLiveActivity = (enabled) => (dispatch, getState) => {
  const next = enabled === true;
  let sync = syncByStore.get(getState);
  if (!sync) {
    sync = { saved: false, wanted: false, run: null };
    syncByStore.set(getState, sync);
  }
  if (!sync.run) {
    // Idle: the store mirrors the saved settings (main broadcasts every save).
    sync.saved = readShowLiveActivity(getState);
  }
  sync.wanted = next;
  dispatch(updateSettings({ showLiveActivity: next }));
  if (!sync.run) {
    sync.run = saveUntilSettled(sync, dispatch);
  }
  return sync.run;
};

/** @returns {(dispatch: any, getState: () => any) => Promise<boolean>} */
export const toggleShowLiveActivity = () => (dispatch, getState) =>
  dispatch(setShowLiveActivity(!readShowLiveActivity(getState)));
