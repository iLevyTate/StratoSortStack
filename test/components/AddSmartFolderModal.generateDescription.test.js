/**
 * @jest-environment jsdom
 *
 * Issue 4 regression — "Generate with AI" must show clear, evolving feedback
 * during long LLM calls on integrated-GPU hardware, must let the user
 * cancel, and must explain when the backend falls back to a template
 * because the model was too slow or unavailable.
 *
 * Pre-fix: the only feedback was a small button label change ("Loading
 * model…" → "Generating description…"). Users on iGPU machines reported
 * the modal looked frozen for 30+ seconds with no way out.
 */

import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
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
        existingFolders={[]}
        {...props}
      />
    </Provider>
  );
  return { ...utils, showNotification, onAdd, onClose };
}

// Returns a Promise plus an externally callable resolver. The component
// awaits the Promise; tests drive resolution to control IPC timing.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AddSmartFolderModal — Generate with AI feedback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockGetDocumentsPath.mockResolvedValue('C:\\Users\\Test\\Documents');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('transitions through Loading → Generating → Still working (long-wait)', async () => {
    const pending = deferred();
    mockGenerateDescription.mockReturnValueOnce(pending.promise);

    const { showNotification } = renderModal();
    fireEvent.change(screen.getByLabelText(/Folder Name/i), {
      target: { value: 'Resumes' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Generate with AI/i }));

    // Phase 1: "Loading model…" — the very first moments while genPhase
    // is still 'loading'.
    expect(screen.getByRole('button', { name: /Loading model…/i })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/Loading the language model/i);

    // Phase 2: after 3s, "Generating description…"
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(screen.getByRole('button', { name: /Generating description/i })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      /Generating description from your folder name/i
    );

    // Phase 3: at 15s the long-wait banner explains slow-hardware reality
    // and the button label changes to "Still working…".
    act(() => {
      jest.advanceTimersByTime(12000);
    });
    expect(screen.getByRole('button', { name: /Still working/i })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/can take up to a minute/i);

    // Wrap up cleanly so React doesn't warn about state updates on unmount.
    await act(async () => {
      pending.resolve({ success: true, description: 'Resume documents.' });
    });
    await waitFor(() =>
      expect(showNotification).toHaveBeenCalledWith('Description generated', 'success')
    );
  });

  test('Cancel button stops the spinner immediately and discards the late result', async () => {
    const pending = deferred();
    mockGenerateDescription.mockReturnValueOnce(pending.promise);

    const { showNotification } = renderModal();
    fireEvent.change(screen.getByLabelText(/Folder Name/i), {
      target: { value: 'Resumes' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Generate with AI/i }));

    // Cancel button only exists while a generation is in flight. Disambiguate
    // from the modal's own Cancel by using the title attribute we set on the
    // generation-specific button.
    const cancelBtn = screen.getByTitle(/Stop generating and write your own/i);
    expect(cancelBtn).toBeInTheDocument();

    fireEvent.click(cancelBtn);

    // Spinner is gone; "Generate with AI" is clickable again.
    expect(screen.queryByTitle(/Stop generating and write your own/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Generate with AI/i })).toBeInTheDocument();
    // Cancel notification fires.
    expect(showNotification).toHaveBeenCalledWith('Description generation cancelled', 'info');

    // The IPC eventually settles — its result must NOT be applied to the
    // description field or pop a success toast, because the user cancelled.
    const descriptionBefore = screen.getByPlaceholderText(/Describe what types of files/i).value;
    await act(async () => {
      pending.resolve({ success: true, description: 'Late description that should be ignored.' });
    });
    expect(screen.getByPlaceholderText(/Describe what types of files/i).value).toBe(
      descriptionBefore
    );
    expect(showNotification).not.toHaveBeenCalledWith('Description generated', 'success');
  });

  test('surfaces a fallback hint when the backend returned a template description', async () => {
    mockGenerateDescription.mockResolvedValueOnce({
      success: true,
      description: 'Generic template description.',
      fallback: true
    });

    const { showNotification } = renderModal();
    fireEvent.change(screen.getByLabelText(/Folder Name/i), {
      target: { value: 'Resumes' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Generate with AI/i }));

    await waitFor(() =>
      expect(showNotification).toHaveBeenCalledWith(
        'Template description used (AI unavailable)',
        'info'
      )
    );

    // The textarea got populated with the fallback content…
    expect(screen.getByPlaceholderText(/Describe what types of files/i).value).toBe(
      'Generic template description.'
    );
    // …and a static hint explains why so users don't think the AI failed silently.
    expect(screen.getByRole('status')).toHaveTextContent(/AI was unavailable or too slow/i);
  });

  test('timed-out response surfaces a hint asking the user to retry or type manually', async () => {
    mockGenerateDescription.mockResolvedValueOnce({
      success: false,
      error: 'Description generation timed out. Please try again.'
    });

    const { showNotification } = renderModal();
    fireEvent.change(screen.getByLabelText(/Folder Name/i), {
      target: { value: 'Resumes' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Generate with AI/i }));

    await waitFor(() =>
      expect(showNotification).toHaveBeenCalledWith(expect.stringMatching(/timed out/i), 'error')
    );

    expect(screen.getByRole('status')).toHaveTextContent(/AI took too long/i);
  });
});
