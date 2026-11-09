/**
 * @jest-environment jsdom
 */
/**
 * Discover's naming dialog and Settings -> File naming defaults edit ONE
 * persisted value: the settings keys namingConvention / dateFormat /
 * caseConvention / separator. A change in the dialog is saved to settings
 * (so Settings shows it and it survives a restart), and a change saved from
 * Settings shows up in the dialog. Real reducers, real hook, real dialog;
 * only the settings IPC bridge is faked.
 */
import React from 'react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

import uiReducer, {
  updateSettings,
  saveNamingDefaults,
  selectNamingDefaults
} from '../../src/renderer/store/slices/uiSlice';
import filesReducer from '../../src/renderer/store/slices/filesSlice';
import analysisReducer from '../../src/renderer/store/slices/analysisSlice';
import { useDiscoverState } from '../../src/renderer/phases/discover/useDiscoverState';
import NamingSettingsModal from '../../src/renderer/components/discover/NamingSettingsModal';
import NamingSettingsSection from '../../src/renderer/components/settings/NamingSettingsSection';

function makeStore(settings = null) {
  const store = configureStore({
    reducer: { ui: uiReducer, files: filesReducer, analysis: analysisReducer },
    middleware: (getDefault) => getDefault({ serializableCheck: false, immutableCheck: false })
  });
  if (settings) store.dispatch(updateSettings(settings));
  return store;
}

function DiscoverNamingHarness() {
  const s = useDiscoverState();
  return (
    <NamingSettingsModal
      isOpen
      onClose={() => {}}
      namingConvention={s.namingConvention}
      setNamingConvention={s.setNamingConvention}
      dateFormat={s.dateFormat}
      setDateFormat={s.setDateFormat}
      caseConvention={s.caseConvention}
      setCaseConvention={s.setCaseConvention}
      separator={s.separator}
      setSeparator={s.setSeparator}
    />
  );
}

function renderDiscover(store) {
  return render(
    <Provider store={store}>
      <DiscoverNamingHarness />
    </Provider>
  );
}

// ui/Select is a combobox button plus a listbox of options.
const conventionSelect = () => document.getElementById('naming-convention');
const separatorSelect = () => document.getElementById('separator');
function choose(trigger, label) {
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('option', { name: label }));
}

describe('one naming default for Discover and Settings', () => {
  let saveMock;

  beforeEach(() => {
    saveMock = jest.fn(async (patch) => ({ success: true, settings: patch }));
    window.electronAPI = { settings: { save: saveMock, get: jest.fn(async () => ({})) } };
  });

  afterEach(() => {
    delete window.electronAPI;
  });

  test('a change in the Discover dialog is saved to Settings, once', async () => {
    const store = makeStore({ namingConvention: 'subject-date', separator: '-' });
    renderDiscover(store);

    choose(conventionSelect(), 'date-subject');

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalledWith({ namingConvention: 'date-subject' });
    // The cached settings (what Settings and every view read) follow at once.
    expect(store.getState().ui.settings.namingConvention).toBe('date-subject');
    // The renderer mirror Discover persists across reloads follows too.
    await waitFor(() =>
      expect(store.getState().files.namingConvention.convention).toBe('date-subject')
    );
    expect(conventionSelect()).toHaveTextContent('date-subject');
  });

  test('Discover shows the value Settings holds, not its own stale copy', async () => {
    const store = makeStore({ namingConvention: 'category-subject', separator: '_' });
    // Stale mirror from an earlier session.
    expect(store.getState().files.namingConvention.convention).toBe('subject-date');

    renderDiscover(store);

    expect(conventionSelect()).toHaveTextContent('category-subject');
    expect(separatorSelect()).toHaveTextContent('_ (underscore)');
    await waitFor(() =>
      expect(store.getState().files.namingConvention).toEqual(
        expect.objectContaining({ convention: 'category-subject', separator: '_' })
      )
    );
    // Reading Settings never writes it back.
    expect(saveMock).not.toHaveBeenCalled();
  });

  test('a change saved from Settings shows up in the Discover dialog', async () => {
    const store = makeStore({ namingConvention: 'subject-date' });
    renderDiscover(store);
    expect(conventionSelect()).toHaveTextContent('subject-date');

    // SettingsPanel save and the main-process settings-changed broadcast both
    // land as updateSettings.
    act(() => {
      store.dispatch(updateSettings({ namingConvention: 'keep-original', separator: '.' }));
    });

    expect(conventionSelect()).toHaveTextContent('keep-original');
    expect(separatorSelect()).toHaveTextContent('. (dot)');
    expect(saveMock).not.toHaveBeenCalled();
  });

  test('a failed save puts the previous default back', async () => {
    saveMock.mockResolvedValueOnce({ success: false, error: 'disk full' });
    const store = makeStore({ namingConvention: 'subject-date' });

    const result = await store.dispatch(saveNamingDefaults({ convention: 'date-subject' }));

    expect(result.meta.requestStatus).toBe('rejected');
    expect(store.getState().ui.settings.namingConvention).toBe('subject-date');
  });

  test('a failed save does not roll back over a newer change to the same key', async () => {
    let failFirst = () => {};
    saveMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          failFirst = () => resolve({ success: false, error: 'disk full' });
        })
    );
    const store = makeStore({ namingConvention: 'subject-date' });

    const first = store.dispatch(saveNamingDefaults({ convention: 'date-subject' }));
    const second = await store.dispatch(saveNamingDefaults({ convention: 'keep-original' }));
    expect(second.meta.requestStatus).toBe('fulfilled');

    failFirst();
    expect((await first).meta.requestStatus).toBe('rejected');
    // The newer, saved value stays; only a key still holding the failed
    // write's value is put back.
    expect(store.getState().ui.settings.namingConvention).toBe('keep-original');
  });

  test('a failed save still restores keys the newer save did not touch', async () => {
    let failFirst = () => {};
    saveMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          failFirst = () => resolve({ success: false, error: 'disk full' });
        })
    );
    const store = makeStore({ namingConvention: 'subject-date', separator: '-' });

    const first = store.dispatch(
      saveNamingDefaults({ namingConvention: 'date-subject', separator: '_' })
    );
    await store.dispatch(saveNamingDefaults({ namingConvention: 'keep-original' }));

    failFirst();
    await first;
    expect(store.getState().ui.settings.namingConvention).toBe('keep-original');
    expect(store.getState().ui.settings.separator).toBe('-');
  });

  test('the dialog says it changes the default that Settings shows', () => {
    renderDiscover(makeStore());
    expect(screen.getByText(/default/i, { selector: 'p, span, div' })).toBeInTheDocument();
    expect(screen.getByText(/Settings/, { selector: 'p, span, div' })).toBeInTheDocument();
  });

  test('Settings no longer claims its naming defaults skip Discover', () => {
    render(
      <NamingSettingsSection
        settings={{ namingConvention: 'subject-date' }}
        setSettings={() => {}}
      />
    );
    expect(screen.queryByText(/do not affect the Discover phase/i)).toBeNull();
    expect(screen.getByText(/Discover/)).toBeInTheDocument();
  });

  describe('selectNamingDefaults', () => {
    test('prefers persisted settings over the renderer mirror, key by key', () => {
      const state = {
        ui: { settings: { namingConvention: 'date-subject', separator: '' } },
        files: {
          namingConvention: {
            convention: 'subject-date',
            separator: '-',
            dateFormat: 'DD-MM-YYYY',
            caseConvention: 'snake_case'
          }
        }
      };
      expect(selectNamingDefaults(state)).toEqual({
        convention: 'date-subject',
        separator: '',
        dateFormat: 'DD-MM-YYYY',
        caseConvention: 'snake_case'
      });
    });

    test('falls back to the mirror before settings load', () => {
      const state = {
        ui: { settings: null },
        files: { namingConvention: { convention: 'keep-original' } }
      };
      expect(selectNamingDefaults(state).convention).toBe('keep-original');
    });
  });
});
