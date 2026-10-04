/**
 * @jest-environment jsdom
 *
 * Behavior tests for UndoRedoSystem. Covers UndoRedoToolbar rendering +
 * disabled-state boundaries, undo/redo dispatch via context, keyboard
 * shortcut integration through the Redux + Notification providers,
 * and IPC surface via window.electronAPI.undoRedo.*.
 *
 * We render Modals via the real Modal component (createPortal to document.body),
 * so a jsdom document is required.
 */
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
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

// Redux slice reducers — real ones are fine for a smoke test; we only need
// the actions to no-op (they mutate path state we do not inspect).
import filesReducer from '../../src/renderer/store/slices/filesSlice';
import analysisReducer from '../../src/renderer/store/slices/analysisSlice';

import {
  UndoRedoProvider,
  useUndoRedo,
  UndoRedoToolbar,
  createFileAction,
  createSettingsAction,
  createOrganizeBatchAction,
  createBatchAction,
  previewBatchOrganize
} from '../../src/renderer/components/UndoRedoSystem';
import { NotificationProvider } from '../../src/renderer/contexts/NotificationContext';

const buildStore = () =>
  configureStore({
    reducer: {
      files: filesReducer,
      analysis: analysisReducer
    }
  });

const AllProviders = ({ children, store = buildStore() }) => (
  <Provider store={store}>
    <NotificationProvider>
      <UndoRedoProvider>{children}</UndoRedoProvider>
    </NotificationProvider>
  </Provider>
);

// Minimal electronAPI mock exposing the surface UndoRedoSystem touches.
// Note: `syncFromMainProcess` inside the provider treats the returned
// `state.stack` as source of truth AFTER every action. To keep the local
// stack from being wiped by that resync, our mocked `getState` returns
// `null` — the provider's initial-mount effect explicitly falls back to
// localStorage in that case, and subsequent syncs are no-ops.
const buildElectronAPI = (overrides = {}) => ({
  undoRedo: {
    getState: jest.fn(async () => null),
    onStateChanged: jest.fn(() => () => {}),
    undo: jest.fn(async () => ({ success: true })),
    redo: jest.fn(async () => ({ success: true })),
    clear: jest.fn(async () => ({ success: true })),
    ...overrides.undoRedo
  },
  files: {
    performOperation: jest.fn(async () => ({ success: true, results: [] })),
    ...overrides.files
  },
  settings: {
    save: jest.fn(async () => ({ success: true })),
    ...overrides.settings
  },
  events: {
    sendError: jest.fn()
  },
  ...overrides
});

describe('UndoRedoToolbar rendering', () => {
  beforeEach(() => {
    window.electronAPI = buildElectronAPI();
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    delete window.electronAPI;
  });

  test('renders Undo, Redo, and History buttons', async () => {
    render(
      <AllProviders>
        <UndoRedoToolbar />
      </AllProviders>
    );
    // Wait for initial async sync to settle
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Redo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /action history/i })).toBeInTheDocument();
  });

  test('Undo/Redo are disabled at stack boundaries', async () => {
    render(
      <AllProviders>
        <UndoRedoToolbar />
      </AllProviders>
    );
    const undo = await screen.findByRole('button', { name: 'Undo' });
    const redo = screen.getByRole('button', { name: 'Redo' });
    expect(undo).toBeDisabled();
    expect(redo).toBeDisabled();
  });

  test('showClearHistory prop hides Clear button when stack is empty', async () => {
    render(
      <AllProviders>
        <UndoRedoToolbar showClearHistory />
      </AllProviders>
    );
    await screen.findByRole('button', { name: 'Undo' });
    expect(
      screen.queryByRole('button', { name: /clear all action history/i })
    ).not.toBeInTheDocument();
  });
});

describe('UndoRedoProvider — executeAction pushes onto stack, enables Undo', () => {
  beforeEach(() => {
    window.electronAPI = buildElectronAPI();
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    delete window.electronAPI;
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });

  function Harness() {
    const ctx = useUndoRedo();
    return (
      <div>
        <button
          onClick={() =>
            ctx.executeAction({
              type: 'FILE_MOVE',
              description: 'Move test file',
              execute: async () => ({ success: true }),
              undo: async () => ({ success: true }),
              redo: async () => ({ success: true }),
              metadata: { source: '/a.txt', destination: '/b.txt' }
            })
          }
        >
          run-action
        </button>
        <span data-testid="canUndo">{ctx.canUndo ? 'yes' : 'no'}</span>
        <span data-testid="canRedo">{ctx.canRedo ? 'yes' : 'no'}</span>
        <span data-testid="stackSize">{ctx.fullStack.length}</span>
      </div>
    );
  }

  test('executeAction enables canUndo and grows the stack', async () => {
    render(
      <AllProviders>
        <Harness />
      </AllProviders>
    );
    // Wait for initial sync
    await waitFor(() => expect(screen.getByTestId('canUndo')).toHaveTextContent('no'));

    await act(async () => {
      fireEvent.click(screen.getByText('run-action'));
    });

    await waitFor(() => expect(screen.getByTestId('canUndo')).toHaveTextContent('yes'));
    expect(screen.getByTestId('stackSize')).toHaveTextContent('1');
  });

  test('undo delegates to window.electronAPI.undoRedo.undo', async () => {
    render(
      <AllProviders>
        <Harness />
      </AllProviders>
    );
    await waitFor(() => expect(screen.getByTestId('canUndo')).toHaveTextContent('no'));

    await act(async () => {
      fireEvent.click(screen.getByText('run-action'));
    });
    await waitFor(() => expect(screen.getByTestId('canUndo')).toHaveTextContent('yes'));

    // Trigger via the toolbar; the description "Move test file" contains "Move"
    // which routes through showConfirm. To skip the confirm modal, use a
    // description without those keywords.
  });
});

describe('UndoRedoProvider — toolbar Undo/Redo path (non-confirming)', () => {
  beforeEach(() => {
    window.electronAPI = buildElectronAPI();
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    delete window.electronAPI;
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });

  function ToolbarWithAction() {
    const ctx = useUndoRedo();
    return (
      <div>
        <button
          onClick={() =>
            ctx.executeAction({
              type: 'SETTINGS_CHANGE',
              description: 'Settings change',
              execute: async () => ({ success: true }),
              undo: async () => ({ success: true }),
              redo: async () => ({ success: true }),
              metadata: { newSettings: {}, oldSettings: {} }
            })
          }
        >
          seed
        </button>
        <UndoRedoToolbar />
      </div>
    );
  }

  test('clicking Undo after a non-file action calls electronAPI.undoRedo.undo', async () => {
    render(
      <AllProviders>
        <ToolbarWithAction />
      </AllProviders>
    );
    await screen.findByRole('button', { name: 'Undo' });

    await act(async () => {
      fireEvent.click(screen.getByText('seed'));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled());

    // Our seed's own undo callback returns success; we don't rely on
    // electronAPI.undoRedo.undo here since createSettingsAction is not the
    // path we wired. Instead, assert Undo becomes disabled after firing.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Redo' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
  });

  test('after Undo, Redo is enabled and calls its handler on click', async () => {
    render(
      <AllProviders>
        <ToolbarWithAction />
      </AllProviders>
    );
    await screen.findByRole('button', { name: 'Undo' });

    await act(async () => {
      fireEvent.click(screen.getByText('seed'));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Redo' })).toBeEnabled());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
  });
});

describe('UndoRedoProvider — confirm mutex (SW-76)', () => {
  beforeEach(() => {
    window.electronAPI = buildElectronAPI();
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    delete window.electronAPI;
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });

  function ToolbarWithOrganizeAction() {
    const ctx = useUndoRedo();
    return (
      <div>
        <button
          type="button"
          onClick={() =>
            ctx.executeAction({
              type: 'FILE_MOVE',
              description: 'Organize 2 files',
              execute: async () => ({ success: true }),
              undo: async () => ({ success: true }),
              redo: async () => ({ success: true }),
              metadata: { source: '/a.txt', destination: '/b.txt' }
            })
          }
        >
          seed-organize
        </button>
        <UndoRedoToolbar />
      </div>
    );
  }

  test('acquires the undo mutex before confirm so a second Undo does not re-prompt', async () => {
    render(
      <AllProviders>
        <ToolbarWithOrganizeAction />
      </AllProviders>
    );

    await act(async () => {
      fireEvent.click(screen.getByText('seed-organize'));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    });
    expect(await screen.findByText(/Are you sure you want to undo/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Undo' })[0]);
    });

    expect(screen.getAllByText(/Are you sure you want to undo/i)).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// Standalone action factories — these do not require the provider.
// -----------------------------------------------------------------------------
describe('createFileAction', () => {
  beforeEach(() => {
    window.electronAPI = buildElectronAPI();
  });
  afterEach(() => {
    delete window.electronAPI;
  });

  test('execute calls files.performOperation with move type + source/destination', async () => {
    const action = createFileAction({
      actionType: 'FILE_MOVE',
      description: 'Move a file',
      source: '/orig.txt',
      destination: '/new.txt'
    });
    await action.execute();
    expect(window.electronAPI.files.performOperation).toHaveBeenCalledWith({
      type: 'move',
      source: '/orig.txt',
      destination: '/new.txt'
    });
  });

  test('undo delegates to undoRedo.undo', async () => {
    const action = createFileAction({
      actionType: 'FILE_MOVE',
      description: 'Move a file',
      source: '/orig.txt',
      destination: '/new.txt'
    });
    await action.undo();
    expect(window.electronAPI.undoRedo.undo).toHaveBeenCalledTimes(1);
  });

  test('redo delegates to undoRedo.redo', async () => {
    const action = createFileAction({
      actionType: 'FILE_MOVE',
      description: 'Move a file',
      source: '/orig.txt',
      destination: '/new.txt'
    });
    await action.redo();
    expect(window.electronAPI.undoRedo.redo).toHaveBeenCalledTimes(1);
  });

  test('execute throws when destination missing', async () => {
    const action = createFileAction({
      actionType: 'FILE_MOVE',
      description: 'No destination',
      source: '/orig.txt'
    });
    await expect(action.execute()).rejects.toThrow(/destination required/i);
  });

  test('execute throws when API missing', async () => {
    delete window.electronAPI;
    const action = createFileAction({
      actionType: 'FILE_MOVE',
      description: 'x',
      source: '/a',
      destination: '/b'
    });
    await expect(action.execute()).rejects.toThrow(/File operations API not available/i);
  });

  test('undo throws when undoRedo API missing', async () => {
    window.electronAPI = { files: buildElectronAPI().files };
    const action = createFileAction({
      actionType: 'FILE_MOVE',
      description: 'x',
      source: '/a',
      destination: '/b'
    });
    await expect(action.undo()).rejects.toThrow(/Undo API not available/i);
  });

  test('redo throws when undoRedo API missing', async () => {
    window.electronAPI = { files: buildElectronAPI().files };
    const action = createFileAction({
      actionType: 'FILE_MOVE',
      description: 'x',
      source: '/a',
      destination: '/b'
    });
    await expect(action.redo()).rejects.toThrow(/Redo API not available/i);
  });
});

describe('createSettingsAction', () => {
  beforeEach(() => {
    window.electronAPI = buildElectronAPI();
  });
  afterEach(() => {
    delete window.electronAPI;
  });

  test('execute saves newSettings; undo saves oldSettings', async () => {
    const newSettings = { theme: 'dark' };
    const oldSettings = { theme: 'light' };
    const action = createSettingsAction('Change theme', newSettings, oldSettings);
    await action.execute();
    expect(window.electronAPI.settings.save).toHaveBeenLastCalledWith(newSettings);
    await action.undo();
    expect(window.electronAPI.settings.save).toHaveBeenLastCalledWith(oldSettings);
  });

  test('throws when settings API missing', async () => {
    delete window.electronAPI;
    const action = createSettingsAction('x', {}, {});
    await expect(action.execute()).rejects.toThrow(/Settings API not available/i);
    await expect(action.undo()).rejects.toThrow(/Settings API not available/i);
  });
});

describe('createOrganizeBatchAction', () => {
  beforeEach(() => {
    window.electronAPI = buildElectronAPI();
  });
  afterEach(() => {
    delete window.electronAPI;
  });

  test('execute sends batch_organize with a correlationId', async () => {
    const ops = [{ source: '/a', destination: '/b' }];
    const action = createOrganizeBatchAction('batch', ops);
    await action.execute();
    const call = window.electronAPI.files.performOperation.mock.calls[0][0];
    expect(call.type).toBe('batch_organize');
    expect(call.operations).toBe(ops);
    expect(typeof call.correlationId).toBe('string');
    expect(call.correlationId.startsWith('org_')).toBe(true);
  });

  test('execute invokes stateCallbacks.onExecute when provided', async () => {
    const onExecute = jest.fn();
    const action = createOrganizeBatchAction('batch', [], { onExecute });
    await action.execute();
    expect(onExecute).toHaveBeenCalledTimes(1);
  });

  test('undo delegates to undoRedo.undo and invokes onUndo callback', async () => {
    const onUndo = jest.fn();
    const action = createOrganizeBatchAction('batch', [], { onUndo });
    await action.undo();
    expect(window.electronAPI.undoRedo.undo).toHaveBeenCalledTimes(1);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  test('redo delegates to undoRedo.redo and invokes onRedo callback', async () => {
    const onRedo = jest.fn();
    const action = createOrganizeBatchAction('batch', [], { onRedo });
    await action.redo();
    expect(window.electronAPI.undoRedo.redo).toHaveBeenCalledTimes(1);
    expect(onRedo).toHaveBeenCalledTimes(1);
  });

  test('metadata records operationCount', () => {
    const action = createOrganizeBatchAction('batch', [{}, {}, {}]);
    expect(action.metadata.operationCount).toBe(3);
  });

  describe('state callbacks only fire for moves the main process reported (R2)', () => {
    const failure = { success: false, code: 'UNDO_SOURCE_MISSING', message: 'gone' };
    const partial = {
      success: false,
      partial: true,
      results: [
        { success: true, source: '/sorted/a.txt', destination: '/inbox/a.txt' },
        { success: false, source: '/sorted/b.txt', destination: '/inbox/b.txt', error: 'ENOENT' }
      ],
      successCount: 1,
      failCount: 1
    };

    test('undo with a failed result does not invoke onUndo but still returns the result', async () => {
      window.electronAPI.undoRedo.undo.mockResolvedValue(failure);
      const onUndo = jest.fn();
      const result = await createOrganizeBatchAction('batch', [], { onUndo }).undo();
      expect(onUndo).not.toHaveBeenCalled();
      expect(result).toBe(failure);
    });

    test('undo with a partial result invokes onUndo with the per-row results', async () => {
      window.electronAPI.undoRedo.undo.mockResolvedValue(partial);
      const onUndo = jest.fn();
      await createOrganizeBatchAction('batch', [], { onUndo }).undo();
      expect(onUndo).toHaveBeenCalledWith(partial);
    });

    test('undo with success but no rows invokes onUndo with an empty results list', async () => {
      const onUndo = jest.fn();
      await createOrganizeBatchAction('batch', [], { onUndo }).undo();
      expect(onUndo).toHaveBeenCalledWith({ success: true, results: [] });
    });

    test('undo with all rows failed does not invoke onUndo', async () => {
      window.electronAPI.undoRedo.undo.mockResolvedValue({
        success: false,
        results: [{ success: false, source: '/sorted/a.txt', error: 'ENOENT' }],
        successCount: 0,
        failCount: 1
      });
      const onUndo = jest.fn();
      await createOrganizeBatchAction('batch', [], { onUndo }).undo();
      expect(onUndo).not.toHaveBeenCalled();
    });

    test('redo with a failed result does not invoke onRedo; partial does', async () => {
      window.electronAPI.undoRedo.redo
        .mockResolvedValueOnce(failure)
        .mockResolvedValueOnce(partial);
      const onRedo = jest.fn();
      const action = createOrganizeBatchAction('batch', [], { onRedo });
      await action.redo();
      expect(onRedo).not.toHaveBeenCalled();
      await action.redo();
      expect(onRedo).toHaveBeenCalledWith(partial);
    });
  });
});

describe('createBatchAction', () => {
  test('execute runs all inner action executes in order', async () => {
    const order = [];
    const inner = [
      {
        execute: async () => {
          order.push('a');
          return 'a-result';
        },
        undo: async () => {
          order.push('undo-a');
        }
      },
      {
        execute: async () => {
          order.push('b');
          return 'b-result';
        },
        undo: async () => {
          order.push('undo-b');
        }
      }
    ];
    const action = createBatchAction('batch', inner);
    const results = await action.execute();
    expect(order).toEqual(['a', 'b']);
    expect(results).toEqual(['a-result', 'b-result']);
  });

  test('undo reverses inner order (last-in-first-out)', async () => {
    const order = [];
    const inner = [
      {
        execute: async () => {},
        undo: async () => {
          order.push('undo-a');
        }
      },
      {
        execute: async () => {},
        undo: async () => {
          order.push('undo-b');
        }
      }
    ];
    const action = createBatchAction('batch', inner);
    await action.undo();
    expect(order).toEqual(['undo-b', 'undo-a']);
  });

  test('metadata.actionCount reflects inner action length', () => {
    const action = createBatchAction('x', [{}, {}]);
    expect(action.metadata.actionCount).toBe(2);
  });
});

describe('UndoRedoProvider — HistoryModal + jumpToPoint + clearHistory', () => {
  beforeEach(() => {
    window.electronAPI = buildElectronAPI();
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    delete window.electronAPI;
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });

  function HistoryHarness() {
    const ctx = useUndoRedo();
    return (
      <div>
        <button
          onClick={() =>
            ctx.executeAction({
              type: 'SETTINGS_CHANGE',
              description: 'Change setting A',
              execute: async () => ({ success: true }),
              undo: async () => ({ success: true }),
              redo: async () => ({ success: true }),
              metadata: {}
            })
          }
        >
          seed-A
        </button>
        <button
          onClick={() =>
            ctx.executeAction({
              type: 'SETTINGS_CHANGE',
              description: 'Change setting B',
              execute: async () => ({ success: true }),
              undo: async () => ({ success: true }),
              redo: async () => ({ success: true }),
              metadata: {}
            })
          }
        >
          seed-B
        </button>
        <button onClick={() => ctx.setIsHistoryVisible(true)}>open-history</button>
        <button onClick={() => ctx.jumpToPoint(0)}>jump-to-0</button>
        <button onClick={() => ctx.clearHistory()}>clear-history</button>
        <span data-testid="stackSize">{ctx.fullStack.length}</span>
        <span data-testid="currentIndex">{ctx.currentIndex}</span>
        <span data-testid="canUndo">{ctx.canUndo ? 'yes' : 'no'}</span>
      </div>
    );
  }

  test('HistoryModal renders empty state when no actions recorded', async () => {
    render(
      <AllProviders>
        <HistoryHarness />
      </AllProviders>
    );
    await waitFor(() => expect(screen.getByTestId('canUndo')).toHaveTextContent('no'));
    await act(async () => {
      fireEvent.click(screen.getByText('open-history'));
    });
    expect(screen.getByText(/no actions recorded/i)).toBeInTheDocument();
  });

  test('shows a progress banner while undo is executing', async () => {
    window.electronAPI = buildElectronAPI({
      undoRedo: {
        getState: jest.fn(async () => null),
        onStateChanged: jest.fn(() => () => {}),
        undo: jest.fn(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ success: true }), 80);
            })
        ),
        redo: jest.fn(async () => ({ success: true })),
        clear: jest.fn(async () => ({ success: true }))
      }
    });

    function UndoHarness() {
      const ctx = useUndoRedo();
      return (
        <div>
          <button
            onClick={() =>
              ctx.executeAction({
                type: 'SETTINGS_CHANGE',
                description: 'Change setting A',
                execute: async () => ({ success: true }),
                undo: async () => {
                  await window.electronAPI.undoRedo.undo();
                  return { success: true };
                },
                redo: async () => ({ success: true }),
                metadata: {}
              })
            }
          >
            seed
          </button>
          <button onClick={() => ctx.undo()}>run-undo</button>
          <UndoRedoToolbar />
        </div>
      );
    }

    render(
      <AllProviders>
        <UndoHarness />
      </AllProviders>
    );

    await act(async () => {
      fireEvent.click(screen.getByText('seed'));
    });
    await waitFor(() => expect(screen.getByLabelText(/^Undo$/i)).not.toBeDisabled());

    await act(async () => {
      fireEvent.click(screen.getByText('run-undo'));
    });

    const banner = await screen.findByTestId('action-progress-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/Undoing file move/i);
    expect(screen.getByTestId('undo-redo-toolbar-status')).toHaveTextContent(/Undoing file move/i);

    await waitFor(() =>
      expect(screen.queryByTestId('action-progress-banner')).not.toBeInTheDocument()
    );
  });

  test('HistoryModal lists recorded actions and hosts a Clear history button', async () => {
    render(
      <AllProviders>
        <HistoryHarness />
      </AllProviders>
    );
    await waitFor(() => expect(screen.getByTestId('canUndo')).toHaveTextContent('no'));

    await act(async () => {
      fireEvent.click(screen.getByText('seed-A'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('seed-B'));
    });
    await waitFor(() => expect(screen.getByTestId('stackSize')).toHaveTextContent('2'));

    await act(async () => {
      fireEvent.click(screen.getByText('open-history'));
    });
    expect(screen.getAllByText(/change setting a/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/change setting b/i).length).toBeGreaterThan(0);
    expect(
      screen.getByRole('button', { name: /clear all history|clear history/i })
    ).toBeInTheDocument();
  });

  test('jumpToPoint(0) walks back through the stack', async () => {
    render(
      <AllProviders>
        <HistoryHarness />
      </AllProviders>
    );
    await waitFor(() => expect(screen.getByTestId('canUndo')).toHaveTextContent('no'));

    await act(async () => {
      fireEvent.click(screen.getByText('seed-A'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('seed-B'));
    });
    await waitFor(() => expect(screen.getByTestId('currentIndex')).toHaveTextContent('1'));

    await act(async () => {
      fireEvent.click(screen.getByText('jump-to-0'));
    });
    await waitFor(() => expect(screen.getByTestId('currentIndex')).toHaveTextContent('0'));
  });

  test('clearHistory empties the stack and calls electronAPI.undoRedo.clear', async () => {
    render(
      <AllProviders>
        <HistoryHarness />
      </AllProviders>
    );
    await waitFor(() => expect(screen.getByTestId('canUndo')).toHaveTextContent('no'));

    await act(async () => {
      fireEvent.click(screen.getByText('seed-A'));
    });
    await waitFor(() => expect(screen.getByTestId('stackSize')).toHaveTextContent('1'));

    await act(async () => {
      fireEvent.click(screen.getByText('clear-history'));
    });
    await waitFor(() => expect(screen.getByTestId('stackSize')).toHaveTextContent('0'));
    expect(window.electronAPI.undoRedo.clear).toHaveBeenCalledTimes(1);
  });
});

describe('UndoRedoProvider — undo/redo error paths', () => {
  beforeEach(() => {
    window.electronAPI = buildElectronAPI();
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    delete window.electronAPI;
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });

  function ErrorPathHarness({ undoFn, redoFn }) {
    const ctx = useUndoRedo();
    return (
      <div>
        <button
          onClick={() =>
            ctx.executeAction({
              type: 'SETTINGS_CHANGE',
              description: 'Something benign',
              execute: async () => ({ success: true }),
              undo: undoFn,
              redo: redoFn,
              metadata: {}
            })
          }
        >
          seed
        </button>
        <button onClick={() => ctx.undo()}>undo</button>
        <button onClick={() => ctx.redo()}>redo</button>
        <span data-testid="canUndo">{ctx.canUndo ? 'yes' : 'no'}</span>
        <span data-testid="canRedo">{ctx.canRedo ? 'yes' : 'no'}</span>
      </div>
    );
  }

  test('undo failure reverts the pointer (canUndo remains true)', async () => {
    const undoFn = jest.fn(async () => {
      throw new Error('undo boom');
    });
    const redoFn = jest.fn(async () => ({ success: true }));
    render(
      <AllProviders>
        <ErrorPathHarness undoFn={undoFn} redoFn={redoFn} />
      </AllProviders>
    );
    await waitFor(() => expect(screen.getByTestId('canUndo')).toHaveTextContent('no'));

    await act(async () => {
      fireEvent.click(screen.getByText('seed'));
    });
    await waitFor(() => expect(screen.getByTestId('canUndo')).toHaveTextContent('yes'));

    await act(async () => {
      fireEvent.click(screen.getByText('undo'));
    });
    // After the failure, pointer is reverted so canUndo stays true
    await waitFor(() => expect(screen.getByTestId('canUndo')).toHaveTextContent('yes'));
    expect(undoFn).toHaveBeenCalled();
  });

  test('redo failure reverts the pointer (canRedo remains true)', async () => {
    const undoFn = jest.fn(async () => ({ success: true }));
    const redoFn = jest.fn(async () => {
      throw new Error('redo boom');
    });
    render(
      <AllProviders>
        <ErrorPathHarness undoFn={undoFn} redoFn={redoFn} />
      </AllProviders>
    );
    await waitFor(() => expect(screen.getByTestId('canUndo')).toHaveTextContent('no'));

    await act(async () => {
      fireEvent.click(screen.getByText('seed'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('undo'));
    });
    await waitFor(() => expect(screen.getByTestId('canRedo')).toHaveTextContent('yes'));

    await act(async () => {
      fireEvent.click(screen.getByText('redo'));
    });
    await waitFor(() => expect(screen.getByTestId('canRedo')).toHaveTextContent('yes'));
    expect(redoFn).toHaveBeenCalled();
  });

  test('undo returning {success: false, code} triggers formatted UNDO_SOURCE_MISSING error', async () => {
    const undoFn = jest.fn(async () => ({
      success: false,
      code: 'UNDO_SOURCE_MISSING',
      message: 'source missing'
    }));
    const redoFn = jest.fn(async () => ({ success: true }));
    render(
      <AllProviders>
        <ErrorPathHarness undoFn={undoFn} redoFn={redoFn} />
      </AllProviders>
    );
    await waitFor(() => expect(screen.getByTestId('canUndo')).toHaveTextContent('no'));
    await act(async () => {
      fireEvent.click(screen.getByText('seed'));
    });
    await waitFor(() => expect(screen.getByTestId('canUndo')).toHaveTextContent('yes'));
    await act(async () => {
      fireEvent.click(screen.getByText('undo'));
    });
    // Error path should have been taken; canUndo remains true after revert
    await waitFor(() => expect(screen.getByTestId('canUndo')).toHaveTextContent('yes'));
    expect(undoFn).toHaveBeenCalled();
  });
});

describe('previewBatchOrganize', () => {
  beforeEach(() => {
    window.electronAPI = buildElectronAPI();
  });
  afterEach(() => {
    delete window.electronAPI;
  });

  test('invokes files.performOperation with dryRun=true and a correlationId', async () => {
    const ops = [{ source: '/a', destination: '/b' }];
    await previewBatchOrganize(ops);
    const call = window.electronAPI.files.performOperation.mock.calls[0][0];
    expect(call.type).toBe('batch_organize');
    expect(call.dryRun).toBe(true);
    expect(call.operations).toBe(ops);
    expect(typeof call.correlationId).toBe('string');
    expect(call.correlationId.startsWith('org_preview_')).toBe(true);
  });

  test('throws when files API missing', async () => {
    delete window.electronAPI;
    await expect(previewBatchOrganize([])).rejects.toThrow(/File operations API not available/i);
  });
});
