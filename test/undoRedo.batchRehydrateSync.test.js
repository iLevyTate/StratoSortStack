/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react';

const mockDispatch = jest.fn();
const mockShowSuccess = jest.fn();
const mockShowError = jest.fn();
const mockShowInfo = jest.fn();

jest.mock('react-redux', () => ({
  useDispatch: () => mockDispatch
}));

jest.mock('../src/renderer/contexts/NotificationContext', () => ({
  useNotification: () => ({
    showSuccess: mockShowSuccess,
    showError: mockShowError,
    showInfo: mockShowInfo
  })
}));

jest.mock('../src/renderer/components/ui/Modal', () => {
  const Modal = ({ children }) => <div>{children}</div>;
  const ConfirmModal = () => null;
  return {
    __esModule: true,
    default: Modal,
    ConfirmModal
  };
});

jest.mock('../src/renderer/components/ui/Button', () => ({
  __esModule: true,
  default: ({ children, ...props }) => <button {...props}>{children}</button>
}));

jest.mock('../src/renderer/components/ui/StateMessage', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../src/renderer/components/ui/Typography', () => ({
  Text: ({ children }) => <span>{children}</span>
}));

import {
  UndoRedoProvider,
  createFileAction,
  createOrganizeBatchAction,
  useUndoRedo
} from '../src/renderer/components/UndoRedoSystem';

function UndoProbe() {
  const { undo, executeAction, currentIndex } = useUndoRedo();
  return (
    <>
      <button
        onClick={() =>
          executeAction({
            type: 'CUSTOM_ACTION',
            description: 'Custom action',
            execute: async () => ({ success: true }),
            undo: async () => ({ success: false, message: 'Main undo failed' }),
            redo: async () => ({ success: true })
          })
        }
      >
        add-action
      </button>
      <button onClick={undo}>trigger-undo</button>
      <div data-testid="current-index">{String(currentIndex)}</div>
    </>
  );
}

describe('UndoRedo batch rehydrated sync', () => {
  beforeEach(() => {
    mockDispatch.mockClear();
    mockShowSuccess.mockClear();
    mockShowError.mockClear();
    mockShowInfo.mockClear();
    localStorage.clear();
    window.electronAPI = {
      undoRedo: {
        getState: jest
          .fn()
          .mockResolvedValue({ stack: [], pointer: -1, canUndo: false, canRedo: false }),
        onStateChanged: jest.fn(() => () => {}),
        undo: jest.fn().mockResolvedValue({
          results: [{ success: true, source: '/old.txt', destination: '/new.txt' }]
        }),
        redo: jest.fn().mockResolvedValue({
          results: [{ success: true, source: '/old.txt', destination: '/new.txt' }]
        })
      },
      files: {
        performOperation: jest.fn().mockResolvedValue({ success: true })
      }
    };
  });

  test('applies global path sync for batch undo/redo without local callbacks', async () => {
    await act(async () => {
      render(
        <UndoRedoProvider>
          <div>child</div>
        </UndoRedoProvider>
      );
    });

    const action = createOrganizeBatchAction('Organize files', [
      { source: '/old.txt', destination: '/new.txt' }
    ]);

    mockDispatch.mockClear();
    await action.undo();
    const undoTypes = mockDispatch.mock.calls.map(([a]) => a.type);
    // Undo: unmark history/index BEFORE the remap (M4) — the remap rewrites the
    // row's destination path, which removeOrganizedFiles needs to drop its key.
    expect(undoTypes).toEqual([
      'files/removeOrganizedFiles',
      'analysis/updateResultPathsAfterMove',
      'files/updateFilePathsAfterMove'
    ]);
    expect(mockDispatch.mock.calls[0][0].payload).toEqual(['/new.txt']);

    mockDispatch.mockClear();
    await action.redo();
    const redoTypes = mockDispatch.mock.calls.map(([a]) => a.type);
    expect(redoTypes).toEqual([
      'analysis/updateResultPathsAfterMove',
      'files/updateFilePathsAfterMove',
      'files/addOrganizedFiles'
    ]);
    expect(mockDispatch.mock.calls[2][0].payload).toEqual([
      expect.objectContaining({
        originalPath: '/old.txt',
        path: '/new.txt',
        originalName: 'old.txt',
        newName: 'new.txt'
      })
    ]);
  });

  test('global undo/redo keeps organizedPathIndex in sync end-to-end (M4)', async () => {
    const filesReducer = require('../src/renderer/store/slices/filesSlice').default;
    const { addOrganizedFiles } = require('../src/renderer/store/slices/filesSlice');
    let files = filesReducer(
      undefined,
      addOrganizedFiles([{ originalPath: '/inbox/a.txt', path: '/sorted/a.txt' }])
    );
    expect(files.organizedPathIndex).toEqual(['/inbox/a.txt', '/sorted/a.txt']);

    window.electronAPI.undoRedo.undo.mockResolvedValue({
      results: [{ success: true, source: '/sorted/a.txt', destination: '/inbox/a.txt' }]
    });
    window.electronAPI.undoRedo.redo.mockResolvedValue({
      results: [{ success: true, source: '/inbox/a.txt', destination: '/sorted/a.txt' }]
    });
    mockDispatch.mockImplementation((action) => {
      if (String(action?.type).startsWith('files/')) {
        files = filesReducer(files, action);
      }
    });

    await act(async () => {
      render(
        <UndoRedoProvider>
          <div>child</div>
        </UndoRedoProvider>
      );
    });
    const action = createOrganizeBatchAction('Organize files', [
      { source: '/inbox/a.txt', destination: '/sorted/a.txt' }
    ]);

    await action.undo();
    // Both keys gone: the file is back in the active queue.
    expect(files.organizedPathIndex).toEqual([]);
    expect(files.organizedFiles).toEqual([]);

    await action.redo();
    expect(files.organizedPathIndex).toEqual(['/inbox/a.txt', '/sorted/a.txt']);
    expect(files.organizedFiles).toHaveLength(1);
    mockDispatch.mockReset();
  });

  describe('syncs Redux only for rows the main process reported as moved (R1/R2)', () => {
    const renderProvider = () =>
      act(async () => {
        render(
          <UndoRedoProvider>
            <div>child</div>
          </UndoRedoProvider>
        );
      });
    const fileAction = () =>
      createFileAction({
        actionType: 'FILE_MOVE',
        description: 'Move a.txt',
        source: '/inbox/a.txt',
        destination: '/sorted/a.txt'
      });

    test('createFileAction.undo: failed result leaves Redux untouched', async () => {
      window.electronAPI.undoRedo.undo.mockResolvedValue({
        success: false,
        code: 'UNDO_SOURCE_MISSING',
        message: 'x'
      });
      await renderProvider();
      mockDispatch.mockClear();

      const result = await fileAction().undo();

      expect(result).toEqual({ success: false, code: 'UNDO_SOURCE_MISSING', message: 'x' });
      expect(mockDispatch).not.toHaveBeenCalled();
    });

    test('createFileAction.undo: uses the real rows when main returns results', async () => {
      window.electronAPI.undoRedo.undo.mockResolvedValue({
        success: true,
        results: [{ success: true, source: '/sorted/renamed.txt', destination: '/inbox/a.txt' }]
      });
      await renderProvider();
      mockDispatch.mockClear();

      await fileAction().undo();

      expect(mockDispatch.mock.calls.map(([a]) => a.type)).toEqual([
        'files/removeOrganizedFiles',
        'analysis/updateResultPathsAfterMove',
        'files/updateFilePathsAfterMove'
      ]);
      expect(mockDispatch.mock.calls[2][0].payload).toEqual({
        oldPaths: ['/sorted/renamed.txt'],
        newPaths: ['/inbox/a.txt']
      });
    });

    test('createFileAction.undo: falls back to the single move row when main omits results', async () => {
      window.electronAPI.undoRedo.undo.mockResolvedValue({ success: true });
      await renderProvider();
      mockDispatch.mockClear();

      await fileAction().undo();

      expect(mockDispatch.mock.calls[0][0]).toEqual(
        expect.objectContaining({ type: 'files/removeOrganizedFiles', payload: ['/inbox/a.txt'] })
      );
      expect(mockDispatch.mock.calls[2][0].payload).toEqual({
        oldPaths: ['/sorted/a.txt'],
        newPaths: ['/inbox/a.txt']
      });
    });

    test('createFileAction.redo: failed result leaves Redux untouched; success uses the fallback row', async () => {
      window.electronAPI.undoRedo.redo
        .mockResolvedValueOnce({ success: false, code: 'UNDO_DESTINATION_OCCUPIED', message: 'x' })
        .mockResolvedValueOnce({ success: true });
      await renderProvider();
      mockDispatch.mockClear();

      await fileAction().redo();
      expect(mockDispatch).not.toHaveBeenCalled();

      await fileAction().redo();
      expect(mockDispatch.mock.calls.map(([a]) => a.type)).toEqual([
        'analysis/updateResultPathsAfterMove',
        'files/updateFilePathsAfterMove',
        'files/addOrganizedFiles'
      ]);
      expect(mockDispatch.mock.calls[0][0].payload).toEqual({
        oldPaths: ['/inbox/a.txt'],
        newPaths: ['/sorted/a.txt']
      });
    });

    test('createOrganizeBatchAction.undo: partial result syncs only the successful rows', async () => {
      window.electronAPI.undoRedo.undo.mockResolvedValue({
        success: false,
        partial: true,
        results: [
          { success: true, source: '/sorted/a.txt', destination: '/inbox/a.txt' },
          { success: false, source: '/sorted/b.txt', destination: '/inbox/b.txt', error: 'ENOENT' }
        ],
        successCount: 1,
        failCount: 1
      });
      await renderProvider();
      mockDispatch.mockClear();

      await createOrganizeBatchAction('Organize 2 files', [
        { source: '/inbox/a.txt', destination: '/sorted/a.txt' },
        { source: '/inbox/b.txt', destination: '/sorted/b.txt' }
      ]).undo();

      expect(mockDispatch.mock.calls[0][0]).toEqual(
        expect.objectContaining({ type: 'files/removeOrganizedFiles', payload: ['/inbox/a.txt'] })
      );
      expect(mockDispatch.mock.calls[2][0].payload).toEqual({
        oldPaths: ['/sorted/a.txt'],
        newPaths: ['/inbox/a.txt']
      });
    });

    test('createOrganizeBatchAction.undo: failed result without rows leaves Redux untouched', async () => {
      window.electronAPI.undoRedo.undo.mockResolvedValue({
        success: false,
        code: 'UNDO_SOURCE_MISSING',
        message: 'x'
      });
      await renderProvider();
      mockDispatch.mockClear();

      await createOrganizeBatchAction('Organize 1 file', [
        { source: '/inbox/a.txt', destination: '/sorted/a.txt' }
      ]).undo();

      expect(mockDispatch).not.toHaveBeenCalled();
    });
  });

  test('mirrors every entry main holds and undoes through main with its message (UR-01)', async () => {
    // MOVE_BATCH (Triage / batch move) and TRASH_BATCH (Duplicate Finder) are
    // recorded by main only. The renderer used to drop them from its mirror
    // and clamp the pointer, so Undo named one entry while main reversed
    // another. The third entry has no confirm keyword or type so the
    // (mocked) confirm modal is not needed to reach main's undo.
    const mainState = {
      stack: [
        {
          id: 'mv-1',
          type: 'MOVE_BATCH',
          description: 'Move files (60 files)',
          timestamp: new Date().toISOString(),
          reversible: true,
          metadata: { operationCount: 60 }
        },
        {
          id: 'tr-1',
          type: 'TRASH_BATCH',
          description: 'Send 3 files to Trash',
          timestamp: new Date().toISOString(),
          reversible: false,
          metadata: { operationCount: 3 }
        },
        {
          id: 'x-1',
          type: 'LIBRARY_REINDEX',
          description: 'Reindex library',
          timestamp: new Date().toISOString(),
          reversible: true,
          metadata: {}
        }
      ],
      pointer: 2,
      canUndo: true,
      canRedo: false
    };
    window.electronAPI.undoRedo.getState.mockResolvedValue(mainState);
    window.electronAPI.undoRedo.undo.mockResolvedValue({
      success: true,
      message: 'Undid: Reindex library'
    });

    let getByText;
    let getByTestId;
    await act(async () => {
      ({ getByText, getByTestId } = render(
        <UndoRedoProvider>
          <UndoProbe />
        </UndoRedoProvider>
      ));
    });
    // All three entries are mirrored: the pointer is main's, not a clamp.
    await waitFor(() => expect(getByTestId('current-index')).toHaveTextContent('2'));

    fireEvent.click(getByText('trigger-undo'));

    await waitFor(() => {
      expect(window.electronAPI.undoRedo.undo).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(mockShowSuccess).toHaveBeenCalledWith('Undid: Reindex library');
    });
  });

  test('a TRASH_NO_RESTORE result is reported as information, not as an undo or an error (UR-14)', async () => {
    // Sync is skipped (no getState) so the locally executed action stays on
    // the mirror; its undo answers the way main does for a trash-only entry.
    window.electronAPI.undoRedo.getState = undefined;
    window.electronAPI.undoRedo.onStateChanged = undefined;
    const message =
      'Nothing restored: 2 files are in the system Trash. Restore from the Trash manually.';
    const onDone = jest.fn();

    function TrashScenario() {
      const { executeAction, undo } = useUndoRedo();
      React.useEffect(() => {
        let active = true;
        const run = async () => {
          await executeAction({
            type: 'CUSTOM_ACTION',
            description: 'Custom cleanup',
            execute: async () => ({ success: true }),
            undo: async () => ({
              success: false,
              code: 'TRASH_NO_RESTORE',
              removedFromHistory: true,
              message
            }),
            redo: async () => ({ success: true })
          });
          await undo();
          if (active) onDone();
        };
        run();
        return () => {
          active = false;
        };
      }, [executeAction, undo]);
      return null;
    }

    render(
      <UndoRedoProvider>
        <TrashScenario />
      </UndoRedoProvider>
    );

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(mockShowInfo).toHaveBeenCalledWith(message);
    expect(mockShowError).not.toHaveBeenCalled();
    expect(mockShowSuccess).not.toHaveBeenCalledWith(expect.stringMatching(/^Undid/));
  });

  test('defers main-process sync while a multi-step jump is in progress', async () => {
    const getState = jest
      .fn()
      .mockResolvedValue({ stack: [], pointer: -1, canUndo: false, canRedo: false });
    let stateChangedHandler;
    window.electronAPI.undoRedo.getState = getState;
    window.electronAPI.undoRedo.onStateChanged = jest.fn((handler) => {
      stateChangedHandler = handler;
      return () => {};
    });
    window.electronAPI.undoRedo.undo = jest.fn().mockResolvedValue({
      success: true,
      results: [{ success: true, source: '/b.txt', destination: '/a.txt' }]
    });
    window.electronAPI.undoRedo.redo = jest.fn().mockResolvedValue({
      success: true,
      results: [{ success: true, source: '/a.txt', destination: '/b.txt' }]
    });

    function JumpProbe() {
      const { executeAction, jumpToPoint, getCurrentIndex } = useUndoRedo();
      const jumpedRef = React.useRef(false);
      React.useEffect(() => {
        if (jumpedRef.current) return;
        jumpedRef.current = true;
        const run = async () => {
          await executeAction(
            createOrganizeBatchAction('Organize 1', [{ source: '/a.txt', destination: '/b.txt' }])
          );
          await executeAction(
            createOrganizeBatchAction('Organize 2', [{ source: '/c.txt', destination: '/d.txt' }])
          );
          getState.mockClear();
          const jumpPromise = jumpToPoint(0);
          stateChangedHandler?.({ action: 'undo' });
          await jumpPromise;
        };
        run();
      }, [executeAction, jumpToPoint, getCurrentIndex]);
      return <div data-testid="jump-index">{String(getCurrentIndex())}</div>;
    }

    await act(async () => {
      render(
        <UndoRedoProvider>
          <JumpProbe />
        </UndoRedoProvider>
      );
    });

    await waitFor(() => {
      expect(getState).toHaveBeenCalled();
    });
    const callsDuringJump = getState.mock.calls.length;
    expect(callsDuringJump).toBeLessThanOrEqual(1);
  });

  test('reverts local pointer when main undo returns success false', async () => {
    window.electronAPI.undoRedo.getState = undefined;
    window.electronAPI.undoRedo.onStateChanged = undefined;
    const onDone = jest.fn();

    function UndoFailureScenario() {
      const { executeAction, undo, getCurrentIndex } = useUndoRedo();
      React.useEffect(() => {
        let active = true;
        const run = async () => {
          await executeAction({
            type: 'CUSTOM_ACTION',
            description: 'Custom action',
            execute: async () => ({ success: true }),
            undo: async () => ({ success: false, message: 'Main undo failed' }),
            redo: async () => ({ success: true })
          });
          const afterExecute = getCurrentIndex();
          await undo();
          const afterUndo = getCurrentIndex();
          if (active) {
            onDone({ afterExecute, afterUndo });
          }
        };
        run();
        return () => {
          active = false;
        };
      }, [executeAction, undo, getCurrentIndex]);
      return null;
    }

    render(
      <UndoRedoProvider>
        <UndoFailureScenario />
      </UndoRedoProvider>
    );

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledWith({ afterExecute: 0, afterUndo: 0 });
      expect(mockShowError).toHaveBeenCalled();
    });
  });
});
