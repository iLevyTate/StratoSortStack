/**
 * @jest-environment jsdom
 *
 * A thrown action gets one error message. The organize batch reports its own
 * failure (with a summary that outlasts the toast), so the executor stays
 * quiet for it and only rethrows; any other action still gets the executor's
 * message.
 */
import React from 'react';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

jest.mock('../../src/shared/logger', () => {
  const noop = jest.fn();
  return {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    createLogger: jest.fn(() => ({ info: noop, warn: noop, error: noop, debug: noop }))
  };
});

const mockShowError = jest.fn();
jest.mock('../../src/renderer/contexts/NotificationContext', () => ({
  useNotification: () => ({
    showSuccess: jest.fn(),
    showError: mockShowError,
    showInfo: jest.fn(),
    showWarning: jest.fn(),
    addNotification: jest.fn()
  })
}));

import filesReducer from '../../src/renderer/store/slices/filesSlice';
import analysisReducer from '../../src/renderer/store/slices/analysisSlice';
import {
  UndoRedoProvider,
  useUndoRedo,
  createOrganizeBatchAction
} from '../../src/renderer/components/UndoRedoSystem';

const buildStore = () =>
  configureStore({ reducer: { files: filesReducer, analysis: analysisReducer } });

function Harness({ makeAction, onRejected }) {
  const ctx = useUndoRedo();
  return (
    <button
      onClick={async () => {
        try {
          await ctx.executeAction(makeAction());
        } catch (error) {
          onRejected(error);
        }
      }}
    >
      run
    </button>
  );
}

describe('executeAction when the action throws', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => {
    delete window.electronAPI;
  });

  function mount(makeAction) {
    window.electronAPI = {
      undoRedo: {
        getState: jest.fn(async () => null),
        onStateChanged: jest.fn(() => () => {}),
        undo: jest.fn(async () => ({ success: true })),
        redo: jest.fn(async () => ({ success: true }))
      },
      files: { performOperation: jest.fn(async () => Promise.reject(new Error('IPC timeout'))) },
      events: { sendError: jest.fn() }
    };
    const onRejected = jest.fn();
    render(
      <Provider store={buildStore()}>
        <UndoRedoProvider>
          <Harness makeAction={makeAction} onRejected={onRejected} />
        </UndoRedoProvider>
      </Provider>
    );
    return { onRejected };
  }

  test('the organize batch: no message from the executor, and the error reaches the caller', async () => {
    const { onRejected } = mount(() =>
      createOrganizeBatchAction('Organize 1 file', [{ source: '/a', destination: '/b' }], {})
    );
    await act(async () => {
      fireEvent.click(screen.getByText('run'));
    });

    await waitFor(() => expect(onRejected).toHaveBeenCalled());
    expect(onRejected.mock.calls[0][0].message).toBe('IPC timeout');
    expect(mockShowError).not.toHaveBeenCalled();
  });

  test('another action: the executor shows one error and rethrows', async () => {
    const { onRejected } = mount(() => ({
      type: 'other',
      description: 'Rename file',
      execute: async () => {
        throw new Error('disk full');
      },
      undo: async () => {}
    }));
    await act(async () => {
      fireEvent.click(screen.getByText('run'));
    });

    await waitFor(() => expect(onRejected).toHaveBeenCalled());
    expect(mockShowError).toHaveBeenCalledTimes(1);
    expect(mockShowError.mock.calls[0][0]).toBe('Failed to rename file: disk full');
  });
});
