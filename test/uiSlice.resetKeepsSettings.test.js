/**
 * @jest-environment node
 *
 * "Analyze more files" / "Go to Home" dispatch resetUi + resetFilesState.
 * Nothing refetches settings afterwards, so the cached settings must survive
 * the reset; otherwise selectNamingDefaults falls back to the hard-coded
 * defaults and Discover sends them to main as the naming override.
 */
import { configureStore } from '@reduxjs/toolkit';
import uiReducer, {
  resetUi,
  updateSettings,
  selectNamingDefaults
} from '../src/renderer/store/slices/uiSlice';
import filesReducer, { resetFilesState } from '../src/renderer/store/slices/filesSlice';

function makeStore() {
  return configureStore({
    reducer: { ui: uiReducer, files: filesReducer },
    middleware: (getDefault) => getDefault({ serializableCheck: false, immutableCheck: false })
  });
}

describe('resetUi keeps the settings cache', () => {
  test('settings, settingsLoaded and settingsError survive a reset', () => {
    const store = makeStore();
    store.dispatch(updateSettings({ namingConvention: 'keep-original', showLiveActivity: true }));
    store.dispatch(resetUi());

    const { ui } = store.getState();
    expect(ui.settings).toEqual(
      expect.objectContaining({ namingConvention: 'keep-original', showLiveActivity: true })
    );
    expect(ui.settingsLoaded).toBe(true);
    expect(ui.settingsError).toBeNull();
    expect(ui.currentPhase).toBe('welcome');
  });

  test('naming defaults after Start over still reflect saved settings', () => {
    const store = makeStore();
    store.dispatch(
      updateSettings({ namingConvention: 'keep-original', caseConvention: 'snake_case' })
    );
    store.dispatch(resetUi());
    store.dispatch(resetFilesState());

    const naming = selectNamingDefaults(store.getState());
    expect(naming.convention).toBe('keep-original');
    expect(naming.caseConvention).toBe('snake_case');
  });

  test('a reset with no cached settings leaves the cache empty', () => {
    const store = makeStore();
    store.dispatch(resetUi());
    const { ui } = store.getState();
    expect(ui.settings).toBeNull();
    expect(ui.settingsLoaded).toBe(false);
  });
});
