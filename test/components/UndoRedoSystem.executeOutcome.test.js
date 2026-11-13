/**
 * @jest-environment jsdom
 *
 * What executeAction does with the result main returns for an organize batch.
 *
 * It shows no message of its own: the organize caller (onExecute) reports
 * what the run moved, left or refused, and a '<description> completed' toast
 * beside that report contradicted it whenever files had failed.
 *
 * It pushes no undo entry for a result main reports as failed
 * (fileops-organize-2, renderer half): a batch main rolled back after a
 * critical error, a batch main stopped after failures before any move was
 * confirmed, and a batch in which every file failed. Main recorded no history
 * for these, so a local entry would point Undo at whatever main's previous
 * action was.
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

describe('UndoRedoProvider: executeAction and the result of an organize batch', () => {
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

  test('a rolled-back batch: no success toast and no undo entry; result and onExecute still reach the caller', async () => {
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

  test('a batch in which every file failed: no success toast and no undo entry', async () => {
    const allFailed = {
      success: false,
      results: [
        { success: false, source: '/in/a.txt', destination: '/out/a.txt', error: 'EACCES' },
        { success: false, source: '/in/b.txt', destination: '/out/b.txt', error: 'EACCES' }
      ],
      successCount: 0,
      failCount: 2
    };
    const { onResult, onExecute } = mount(allFailed);
    await waitFor(() => expect(screen.getByTestId('canUndo')).toHaveTextContent('no'));

    await act(async () => {
      fireEvent.click(screen.getByText('run'));
    });

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(allFailed));
    expect(onExecute).toHaveBeenCalledWith(allFailed);
    expect(mockShowSuccess).not.toHaveBeenCalled();
    expect(screen.getByTestId('stackSize')).toHaveTextContent('0');
    expect(screen.getByTestId('canUndo')).toHaveTextContent('no');
  });

  test('a partly failed batch gets an undo entry and no toast from the provider', async () => {
    const partial = {
      success: true,
      results: [
        { success: true, source: '/in/a.txt', destination: '/out/a.txt' },
        { success: false, source: '/in/b.txt', destination: '/out/b.txt', error: 'EACCES' }
      ],
      successCount: 1,
      failCount: 1
    };
    const { onResult, onExecute } = mount(partial);
    await waitFor(() => expect(screen.getByTestId('canUndo')).toHaveTextContent('no'));

    await act(async () => {
      fireEvent.click(screen.getByText('run'));
    });

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(partial));
    expect(onExecute).toHaveBeenCalledWith(partial);
    expect(mockShowSuccess).not.toHaveBeenCalled();
    expect(mockShowError).not.toHaveBeenCalled();
    expect(mockShowInfo).not.toHaveBeenCalled();
    expect(screen.getByTestId('stackSize')).toHaveTextContent('1');
    expect(screen.getByTestId('canUndo')).toHaveTextContent('yes');
  });

  test('a batch that moved every file gets an undo entry; the caller reports it', async () => {
    const ok = {
      success: true,
      results: [
        { success: true, source: '/in/a.txt', destination: '/out/a.txt' },
        { success: true, source: '/in/b.txt', destination: '/out/b.txt' }
      ],
      successCount: 2,
      failCount: 0
    };
    const { onResult, onExecute } = mount(ok);
    await waitFor(() => expect(screen.getByTestId('canUndo')).toHaveTextContent('no'));

    await act(async () => {
      fireEvent.click(screen.getByText('run'));
    });

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(ok));
    expect(onExecute).toHaveBeenCalledWith(ok);
    expect(mockShowSuccess).not.toHaveBeenCalled();
    expect(mockShowError).not.toHaveBeenCalled();
    expect(mockShowInfo).not.toHaveBeenCalled();
    expect(screen.getByTestId('stackSize')).toHaveTextContent('1');
    expect(screen.getByTestId('canUndo')).toHaveTextContent('yes');
  });
});
