/**
 * @jest-environment jsdom
 *
 * fileops-organize-2 (renderer half): when main rolls an organize batch back
 * after a critical error, executeAction must not announce
 * '<description> completed' and must not push an undo entry. Main recorded no
 * history for the restored moves, so a local entry would point Undo at
 * whatever main's previous action was. The organize caller (onExecute) owns
 * the single error message for a rolled-back batch. The same holds for a
 * batch main stopped after failures before any move was confirmed.
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

const mockShowSuccess = jest.fn();
const mockShowError = jest.fn();
const mockShowInfo = jest.fn();
jest.mock('../../src/renderer/contexts/NotificationContext', () => ({
  useNotification: () => ({
    showSuccess: mockShowSuccess,
    showError: mockShowError,
    showInfo: mockShowInfo,
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

const ROLLED_BACK = {
  success: false,
  rolledBack: true,
  rollbackReason: 'Critical error: EACCES',
  results: [
    { success: false, rolledBack: true, source: '/in/a.txt', destination: '/out/a.txt' },
    { success: false, source: '/in/b.txt', destination: '/out/b.txt', error: 'EACCES' }
  ],
  successCount: 0,
  failCount: 1,
  rollbackFailCount: 0,
  criticalError: true
};

function Harness({ onResult, onExecute }) {
  const ctx = useUndoRedo();
  return (
    <div>
      <button
        onClick={async () => {
          const result = await ctx.executeAction(
            createOrganizeBatchAction(
              'Organize 2 files',
              [
                { source: '/in/a.txt', destination: '/out/a.txt' },
                { source: '/in/b.txt', destination: '/out/b.txt' }
              ],
              { onExecute }
            )
          );
          onResult(result);
        }}
      >
        run
      </button>
      <span data-testid="stackSize">{ctx.fullStack.length}</span>
      <span data-testid="canUndo">{ctx.canUndo ? 'yes' : 'no'}</span>
    </div>
  );
}

describe('UndoRedoProvider: rolled-back organize batch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    delete window.electronAPI;
  });

  function mount(performResult) {
    window.electronAPI = {
      undoRedo: {
        getState: jest.fn(async () => null),
        onStateChanged: jest.fn(() => () => {}),
        undo: jest.fn(async () => ({ success: true })),
        redo: jest.fn(async () => ({ success: true }))
      },
      files: { performOperation: jest.fn(async () => performResult) },
      events: { sendError: jest.fn() }
    };
    const onResult = jest.fn();
    const onExecute = jest.fn();
    render(
      <Provider store={buildStore()}>
        <UndoRedoProvider>
          <Harness onResult={onResult} onExecute={onExecute} />
        </UndoRedoProvider>
      </Provider>
    );
    return { onResult, onExecute };
  }

  test('no success toast and no undo entry; result and onExecute still reach the caller', async () => {
    const { onResult, onExecute } = mount(ROLLED_BACK);
    await waitFor(() => expect(screen.getByTestId('canUndo')).toHaveTextContent('no'));

    await act(async () => {
      fireEvent.click(screen.getByText('run'));
    });

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(ROLLED_BACK));
    expect(onExecute).toHaveBeenCalledWith(ROLLED_BACK);
    expect(mockShowSuccess).not.toHaveBeenCalled();
    expect(screen.getByTestId('stackSize')).toHaveTextContent('0');
    expect(screen.getByTestId('canUndo')).toHaveTextContent('no');
  });

  test('a batch main stopped before any move: no success toast and no undo entry', async () => {
    const stopped = {
      success: false,
      stoppedOnFailure: true,
      stopReason: 'Strict-mode failure on file 1/2: EACCES',
      notAttemptedCount: 1,
      results: [
        { success: false, source: '/in/a.txt', destination: '/out/a.txt', error: 'EACCES' },
        { success: false, notAttempted: true, source: '/in/b.txt', destination: '/out/b.txt' }
      ],
      successCount: 0,
      failCount: 1
    };
    const { onResult, onExecute } = mount(stopped);
    await waitFor(() => expect(screen.getByTestId('canUndo')).toHaveTextContent('no'));

    await act(async () => {
      fireEvent.click(screen.getByText('run'));
    });

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(stopped));
    expect(onExecute).toHaveBeenCalledWith(stopped);
    expect(mockShowSuccess).not.toHaveBeenCalled();
    expect(screen.getByTestId('stackSize')).toHaveTextContent('0');
    expect(screen.getByTestId('canUndo')).toHaveTextContent('no');
  });

  test('a batch that was not rolled back still pushes and announces completion', async () => {
    const ok = {
      success: true,
      results: [{ success: true, source: '/in/a.txt', destination: '/out/a.txt' }]
    };
    const { onResult } = mount(ok);
    await waitFor(() => expect(screen.getByTestId('canUndo')).toHaveTextContent('no'));

    await act(async () => {
      fireEvent.click(screen.getByText('run'));
    });

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(ok));
    expect(mockShowSuccess).toHaveBeenCalledWith('Organize 2 files completed');
    expect(screen.getByTestId('stackSize')).toHaveTextContent('1');
  });
});
