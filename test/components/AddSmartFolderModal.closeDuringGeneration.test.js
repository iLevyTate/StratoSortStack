/**
 * @jest-environment jsdom
 *
 * Closing the modal while "Generate with AI" is in flight must discard the
 * late result. Callers keep the modal mounted while it is closed, so before
 * the fix the old request's description landed in the next folder's form
 * (with a "Description generated" toast) after the user reopened it.
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
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
  const system = createSlice({
    name: 'system',
    initialState: { redactPaths: false, redactPathsLoaded: true },
    reducers: {}
  });
  return configureStore({ reducer: { system: system.reducer } });
}

describe('AddSmartFolderModal — closing during description generation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockGetDocumentsPath.mockResolvedValue('C:/Users/Test/Documents');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('a late result after close + reopen does not overwrite the new form', async () => {
    let resolveGeneration;
    mockGenerateDescription.mockReturnValueOnce(
      new Promise((res) => {
        resolveGeneration = res;
      })
    );

    const store = makeStore();
    const showNotification = jest.fn();
    const onAdd = jest.fn().mockResolvedValue(true);
    const onClose = jest.fn();
    const ui = (isOpen) => (
      <Provider store={store}>
        <AddSmartFolderModal
          isOpen={isOpen}
          onClose={onClose}
          onAdd={onAdd}
          defaultLocation={'C:/Users/Test/Documents'}
          showNotification={showNotification}
          existingFolders={[]}
        />
      </Provider>
    );

    const { rerender } = render(ui(true));
    fireEvent.change(screen.getByLabelText(/Folder Name/i), { target: { value: 'Taxes' } });
    fireEvent.click(screen.getByRole('button', { name: /Generate with AI/i }));
    expect(screen.getByTitle(/Stop generating and write your own/i)).toBeInTheDocument();

    // Close through the footer Cancel (the modal-level one, not the
    // generation-specific button), then reopen the same mounted instance.
    const footerCancel = screen
      .getAllByRole('button', { name: /^Cancel$/i })
      .find((btn) => !/Stop generating/i.test(btn.getAttribute('title') || ''));
    fireEvent.click(footerCancel);
    expect(onClose).toHaveBeenCalled();
    rerender(ui(false));
    rerender(ui(true));

    // Fresh form: no stale spinner from the abandoned request.
    expect(screen.queryByTitle(/Stop generating and write your own/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Folder Name/i), { target: { value: 'Photos' } });
    const textarea = screen.getByPlaceholderText(/Describe what types of files/i);
    fireEvent.change(textarea, { target: { value: 'Vacation photos' } });

    await act(async () => {
      resolveGeneration({ success: true, description: 'Tax returns and receipts.' });
    });

    expect(screen.getByPlaceholderText(/Describe what types of files/i).value).toBe(
      'Vacation photos'
    );
    expect(showNotification).not.toHaveBeenCalledWith('Description generated', 'success');
    // Closing is not a user cancel of the generation, so no "cancelled" toast.
    expect(showNotification).not.toHaveBeenCalledWith('Description generation cancelled', 'info');
  });
});
