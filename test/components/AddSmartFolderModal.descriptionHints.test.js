/**
 * @jest-environment jsdom
 *
 * AddSmartFolderModal shows plain, non-blocking warnings under the
 * description: missing, short, cut off, or reading like another folder's.
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

describe('AddSmartFolderModal — description hints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDocumentsPath.mockResolvedValue('C:\\Users\\Test\\Documents');
  });

  test('a name with no description shows "Add a description" and Add stays enabled', async () => {
    const { onAdd } = renderModal();

    fireEvent.change(screen.getByLabelText(/Folder Name/i), { target: { value: 'GSC' } });

    expect(screen.getByText(/Add a description\./)).toBeInTheDocument();
    const addButton = screen.getByRole('button', { name: /Add Folder/i });
    expect(addButton).toBeEnabled();

    fireEvent.click(addButton);
    await waitFor(() => expect(onAdd).toHaveBeenCalled());
  });

  test('no hint before a name is typed', () => {
    renderModal();
    expect(screen.queryByText(/Add a description\./)).not.toBeInTheDocument();
  });

  test("a description like another folder's names that folder", () => {
    renderModal({
      existingFolders: [
        {
          id: 'bing',
          name: 'Bing',
          path: 'C:\\Users\\Test\\Documents\\Bing',
          description: 'Bing Webmaster performance exports with queries pages clicks'
        }
      ]
    });

    fireEvent.change(screen.getByLabelText(/Folder Name/i), { target: { value: 'GSC' } });
    fireEvent.change(screen.getByLabelText(/Description/i), {
      target: { value: 'Google Search Console performance exports with queries pages clicks' }
    });

    expect(screen.getByText(/This reads much like "Bing"/)).toBeInTheDocument();
    expect(screen.queryByText(/Add a description\./)).not.toBeInTheDocument();
  });
});
