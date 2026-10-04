/**
 * @jest-environment jsdom
 *
 * Render-level guard that AddSmartFolderModal performs a token-subset
 * preflight equivalence check BEFORE invoking onAdd / IPC.
 *
 * Why this test exists
 * --------------------
 * The IPC handler (src/main/ipc/smartFolders.js) rejects names that are
 * canonically equivalent to an existing folder with FOLDER_NAME_EQUIVALENT.
 * The renderer mirror of that guard exists so the user gets immediate
 * feedback ("Smart folder \"Logos\" already covers this concept") instead
 * of a generic "Failed to add" after the round trip — confirmed v3 UX
 * regression vs v2.0.9 which never let the duplicate be persisted in the
 * first place.
 *
 * Behavioral contract guarded here:
 *   1. "Logos and Graphic Design" while "Logos" exists -> warning naming
 *      "Logos" specifically; onAdd is NEVER called.
 *   2. A genuinely distinct name ("Tax Filings 2024") -> no equivalence
 *      warning; onAdd IS called with the new folder shape.
 *   3. The exact-name-match path still fires its OWN warning (no
 *      equivalence false-positive piling on).
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Provider } from 'react-redux';
import { configureStore, createSlice } from '@reduxjs/toolkit';

const mockGetDocumentsPath = jest.fn();
const mockSelectDirectory = jest.fn();
const mockGenerateDescription = jest.fn();

jest.mock('../../src/renderer/services/ipc', () => ({
  filesIpc: {
    getDocumentsPath: (...args) => mockGetDocumentsPath(...args),
    selectDirectory: (...args) => mockSelectDirectory(...args)
  },
  smartFoldersIpc: {
    generateDescription: (...args) => mockGenerateDescription(...args)
  }
}));

jest.mock('../../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

import AddSmartFolderModal from '../../src/renderer/components/setup/AddSmartFolderModal';

function makeStore() {
  // selectRedactPaths reads state.system.redactPaths/redactPathsLoaded.
  const system = createSlice({
    name: 'system',
    initialState: { redactPaths: false, redactPathsLoaded: true },
    reducers: {}
  });
  return configureStore({ reducer: { system: system.reducer } });
}

function renderModal(props = {}) {
  const store = makeStore();
  const showNotification = jest.fn();
  const onAdd = jest.fn().mockResolvedValue(true);
  const onClose = jest.fn();

  const utils = render(
    <Provider store={store}>
      <AddSmartFolderModal
        isOpen
        onClose={onClose}
        onAdd={onAdd}
        defaultLocation={'C:\\Users\\Test\\Documents'}
        showNotification={showNotification}
        {...props}
      />
    </Provider>
  );

  return { ...utils, showNotification, onAdd, onClose };
}

describe('AddSmartFolderModal — token-subset preflight', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: getDocumentsPath returns the supplied default location so
    // the path-resolution step succeeds without hitting the IPC mock.
    mockGetDocumentsPath.mockResolvedValue('C:\\Users\\Test\\Documents');
  });

  test('blocks "Logos and Graphic Design" when "Logos" already exists; warns by name; never calls onAdd', async () => {
    const { showNotification, onAdd } = renderModal({
      existingFolders: [
        {
          id: 'logos-1',
          name: 'Logos',
          path: 'C:\\Users\\Test\\Documents\\Logos',
          description: 'Logo assets'
        }
      ]
    });

    const nameInput = screen.getByLabelText(/Folder Name/i);
    fireEvent.change(nameInput, { target: { value: 'Logos and Graphic Design' } });

    fireEvent.click(screen.getByRole('button', { name: /Add Folder/i }));

    await waitFor(() => expect(showNotification).toHaveBeenCalled());

    // The warning MUST name "Logos" specifically so the user can decide to
    // use the existing folder instead. A generic "duplicate" message would
    // re-introduce the v3 UX regression.
    const equivalentCalls = showNotification.mock.calls.filter(
      ([msg, severity]) =>
        typeof msg === 'string' &&
        msg.toLowerCase().includes('logos') &&
        msg.toLowerCase().includes('already covers') &&
        severity === 'warning'
    );
    expect(equivalentCalls.length).toBeGreaterThan(0);

    // Critical: never invoked onAdd / IPC for the equivalent name.
    expect(onAdd).not.toHaveBeenCalled();
  });

  test('a genuinely distinct name passes the preflight and reaches onAdd', async () => {
    const { showNotification, onAdd } = renderModal({
      existingFolders: [
        {
          id: 'logos-1',
          name: 'Logos',
          path: 'C:\\Users\\Test\\Documents\\Logos'
        }
      ]
    });

    fireEvent.change(screen.getByLabelText(/Folder Name/i), {
      target: { value: 'Tax Filings 2024' }
    });

    fireEvent.click(screen.getByRole('button', { name: /Add Folder/i }));

    await waitFor(() => expect(onAdd).toHaveBeenCalled());

    // No equivalence warning fired for the distinct name.
    const equivalentCalls = showNotification.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.toLowerCase().includes('already covers')
    );
    expect(equivalentCalls).toHaveLength(0);

    // The folder shape passed to onAdd carries the entered name and a
    // resolved absolute path under the default location.
    const [submitted] = onAdd.mock.calls[0];
    expect(submitted.name).toBe('Tax Filings 2024');
    expect(submitted.path.toLowerCase()).toContain('tax filings 2024');
  });

  test('exact-name match fires the existing-name warning, not the token-subset warning', async () => {
    // Both guards reject the submit, but they emit DIFFERENT messages and
    // the exact-match guard must win when both would match (it's checked
    // first in the production code).
    const { showNotification, onAdd } = renderModal({
      existingFolders: [
        {
          id: 'logos-1',
          name: 'Logos',
          path: 'C:\\Users\\Test\\Documents\\Logos'
        }
      ]
    });

    fireEvent.change(screen.getByLabelText(/Folder Name/i), {
      target: { value: 'Logos' }
    });

    fireEvent.click(screen.getByRole('button', { name: /Add Folder/i }));

    await waitFor(() => expect(showNotification).toHaveBeenCalled());

    const messages = showNotification.mock.calls.map(([msg]) => msg);
    expect(
      messages.some((m) => typeof m === 'string' && m.toLowerCase().includes('already exists'))
    ).toBe(true);
    // The token-subset guard must NOT also fire — only one warning at a time.
    expect(
      messages.some((m) => typeof m === 'string' && m.toLowerCase().includes('already covers'))
    ).toBe(false);

    expect(onAdd).not.toHaveBeenCalled();
  });
});
