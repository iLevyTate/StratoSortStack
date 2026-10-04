// Undo/Redo System - Implementing Shneiderman's Golden Rule #6: Action Reversal Infrastructure
import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import PropTypes from 'prop-types';
import {
  FileText,
  Trash2,
  Edit2,
  FolderPlus,
  FolderMinus,
  FileEdit,
  Settings,
  Search,
  Package,
  Loader2,
  Undo2,
  Redo2
} from 'lucide-react';
import { createLogger } from '../../shared/logger';
import Modal, { ConfirmModal } from './ui/Modal';
import { useNotification } from '../contexts/NotificationContext';
import { ACTION_TYPES as SHARED_ACTION_TYPES } from '../../shared/constants';
import { useDispatch, useSelector } from 'react-redux';
import { updateResultPathsAfterMove } from '../store/slices/analysisSlice';
import {
  addOrganizedFiles,
  removeOrganizedFiles,
  updateFilePathsAfterMove
} from '../store/slices/filesSlice';
import { selectRedactPaths } from '../store/selectors';
import { formatHistoryActionDisplay } from '../utils/undoHistoryDisplay';
import Button from './ui/Button';
import StateMessage from './ui/StateMessage';
import StatusBadge from './ui/StatusBadge';
import { Text } from './ui/Typography';
import { Inline } from './layout';

const logger = createLogger('UndoRedoSystem');

const generateSecureId = () => {
  const array = new Uint8Array(6);
  crypto.getRandomValues(array);
  return `action-${Date.now()}-${Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('')}`;
};

const UndoRedoContext = createContext();
const ACTION_TYPES = SHARED_ACTION_TYPES;
let globalBatchStateCallbacks = null;

function registerGlobalBatchStateCallbacks(callbacks) {
  globalBatchStateCallbacks = callbacks || null;
  return () => {
    if (globalBatchStateCallbacks === callbacks) {
      globalBatchStateCallbacks = null;
    }
  };
}

// Map main-process undo/redo preflight error codes to actionable guidance.
// Without this, both surface as a generic "Failed to undo …" toast even
// though the user can resolve them without restarting anything.
function formatUndoRedoFailure(verb, actionDescription, error) {
  const detail = error?.message || String(error);
  switch (error?.code) {
    case 'UNDO_SOURCE_MISSING':
      return (
        `Cannot ${verb} "${actionDescription}": the file is no longer where StratoSort left it ` +
        '(it was moved or deleted outside the app). The history entry can no longer be reversed.'
      );
    case 'UNDO_DESTINATION_OCCUPIED':
      return (
        `Cannot ${verb} "${actionDescription}": another file now occupies the original location. ` +
        `Move or rename that file, then try again.`
      );
    default:
      return `Failed to ${verb} ${actionDescription}: ${detail}`;
  }
}

function invokeBatchStateCallback(type, result) {
  const cb = globalBatchStateCallbacks?.[type];
  if (typeof cb !== 'function') return;
  try {
    cb(result);
  } catch (error) {
    logger.warn('[UndoRedo] Global batch state callback failed', {
      type,
      error: error?.message
    });
  }
}

function isSuccessfulUndoRedoResult(result) {
  return result?.success === true;
}

// The main process resolves (never rejects) with `{ success: false, code }` on
// preflight failure, so a missing `success` key is treated as "not reported",
// not as failure — custom actions may return arbitrary values.
function isFailedUndoRedoResult(result) {
  return (
    result !== null &&
    typeof result === 'object' &&
    Object.prototype.hasOwnProperty.call(result, 'success') &&
    !isSuccessfulUndoRedoResult(result)
  );
}

function hasSuccessfulRows(result) {
  return Array.isArray(result?.results) && result.results.some((r) => r?.success === true);
}

// Invariant: a row reaches the Redux/organize state callbacks only if the main
// process reported it as moved — either as a `success: true` entry in
// `results` (authoritative when present, even on a partial-failure aggregate),
// or, when main returns no per-op rows, because the aggregate `success` is
// true and `fallbackRows` describe the single move this action represents.
function dispatchUndoRedoSync(kind, result, stateCallbacks, fallbackRows) {
  let payload;
  if (Array.isArray(result?.results)) {
    if (!hasSuccessfulRows(result)) return;
    payload = result;
  } else if (isSuccessfulUndoRedoResult(result)) {
    payload = { ...result, results: fallbackRows };
  } else {
    return;
  }

  const cb = stateCallbacks?.[kind];
  if (typeof cb === 'function') {
    try {
      cb(payload);
    } catch {
      // Non-fatal if state callback fails
    }
    return;
  }
  invokeBatchStateCallback(kind, payload);
}

const ACTION_METADATA = {
  [ACTION_TYPES.FILE_MOVE]: {
    description: 'Move file',
    icon: FileText,
    category: 'File Operations'
  },
  [ACTION_TYPES.FILE_DELETE]: {
    description: 'Delete file',
    icon: Trash2,
    category: 'File Operations'
  },
  [ACTION_TYPES.FILE_RENAME]: {
    description: 'Rename file',
    icon: Edit2,
    category: 'File Operations'
  },
  [ACTION_TYPES.FOLDER_CREATE]: {
    description: 'Create folder',
    icon: FolderPlus,
    category: 'Folder Operations'
  },
  [ACTION_TYPES.FOLDER_DELETE]: {
    description: 'Delete folder',
    icon: FolderMinus,
    category: 'Folder Operations'
  },
  [ACTION_TYPES.FOLDER_RENAME]: {
    description: 'Rename folder',
    icon: FileEdit,
    category: 'Folder Operations'
  },
  [ACTION_TYPES.SETTINGS_CHANGE]: {
    description: 'Change settings',
    icon: Settings,
    category: 'Configuration'
  },
  [ACTION_TYPES.ANALYSIS_RESULT]: {
    description: 'File analysis',
    icon: Search,
    category: 'Analysis'
  },
  [ACTION_TYPES.BATCH_OPERATION]: {
    description: 'Batch operation',
    icon: Package,
    category: 'Batch Operations'
  },
  [ACTION_TYPES.BATCH_ORGANIZE]: {
    description: 'Organize files',
    icon: Package,
    category: 'Batch Operations'
  },
  [ACTION_TYPES.MOVE_BATCH]: {
    description: 'Move files',
    icon: Package,
    category: 'Batch Operations'
  },
  [ACTION_TYPES.TRASH_BATCH]: {
    description: 'Send files to Trash',
    icon: Trash2,
    category: 'File Operations'
  },
  [ACTION_TYPES.FILE_COPY]: {
    description: 'Copy file',
    icon: FileText,
    category: 'File Operations'
  }
};

// Entries that move or remove files get a confirm before undo. Matched on
// the main-process type first, then on the description for custom actions.
const CONFIRM_UNDO_TYPES = new Set([
  ACTION_TYPES.FILE_MOVE,
  ACTION_TYPES.FILE_DELETE,
  ACTION_TYPES.FILE_COPY,
  ACTION_TYPES.BATCH_OPERATION,
  ACTION_TYPES.BATCH_ORGANIZE,
  ACTION_TYPES.MOVE_BATCH,
  ACTION_TYPES.TRASH_BATCH
]);
const CONFIRM_UNDO_KEYWORDS = ['organize', 'move', 'delete', 'trash'];

function needsUndoConfirm(action) {
  if (!action) return false;
  if (CONFIRM_UNDO_TYPES.has(action.type)) return true;
  const description = String(action.description || '').toLowerCase();
  return CONFIRM_UNDO_KEYWORDS.some((word) => description.includes(word));
}

/**
 * An entry the main process holds that the renderer only mirrors. Undo and
 * redo go to the main process, which owns the one history; the renderer
 * then syncs the Redux path state from the rows main reports as moved.
 * Covers every action type main records, including the batch types the
 * renderer never executes itself (MOVE_BATCH, TRASH_BATCH, FILE_COPY).
 */
const createMainDelegatedAction = ({ type, description, metadata }) => {
  const source = metadata?.source;
  const destination = metadata?.destination;
  const singleRowUndo =
    source && destination ? [{ success: true, source: destination, destination: source }] : [];
  const singleRowRedo = source && destination ? [{ success: true, source, destination }] : [];
  return {
    type,
    description,
    execute: async () => {
      throw new Error('History entries are replayed through redo, not executed again');
    },
    undo: async () => {
      if (!window?.electronAPI?.undoRedo?.undo) {
        throw new Error('Undo API not available');
      }
      const result = await window.electronAPI.undoRedo.undo();
      dispatchUndoRedoSync('onUndo', result, null, singleRowUndo);
      return result;
    },
    redo: async () => {
      if (!window?.electronAPI?.undoRedo?.redo) {
        throw new Error('Redo API not available');
      }
      const result = await window.electronAPI.undoRedo.redo();
      dispatchUndoRedoSync('onRedo', result, null, singleRowRedo);
      return result;
    },
    metadata: metadata || {}
  };
};

export const createFileAction = ({ actionType, description, source, destination }) => ({
  type: actionType,
  description,
  execute: async () => {
    if (destination) {
      if (!window?.electronAPI?.files?.performOperation) {
        throw new Error('File operations API not available');
      }
      return await window.electronAPI.files.performOperation({
        type: 'move',
        source,
        destination
      });
    }
    throw new Error('Unsupported operation: destination required for move');
  },
  undo: async () => {
    // Delegate to main process UndoRedoService to maintain history integrity
    if (!window?.electronAPI?.undoRedo?.undo) {
      throw new Error('Undo API not available');
    }
    const result = await window.electronAPI.undoRedo.undo();
    dispatchUndoRedoSync('onUndo', result, null, [
      { success: true, source: destination, destination: source }
    ]);
    return result;
  },
  redo: async () => {
    // Delegate to main process UndoRedoService to maintain history integrity
    if (!window?.electronAPI?.undoRedo?.redo) {
      throw new Error('Redo API not available');
    }
    const result = await window.electronAPI.undoRedo.redo();
    dispatchUndoRedoSync('onRedo', result, null, [{ success: true, source, destination }]);
    return result;
  },
  metadata: { source, destination }
});

export const createSettingsAction = (description, newSettings, oldSettings) => ({
  type: ACTION_TYPES.SETTINGS_CHANGE,
  description,
  execute: async () => {
    if (!window?.electronAPI?.settings?.save) {
      throw new Error('Settings API not available');
    }
    return await window.electronAPI.settings.save(newSettings);
  },
  undo: async () => {
    if (!window?.electronAPI?.settings?.save) {
      throw new Error('Settings API not available');
    }
    return await window.electronAPI.settings.save(oldSettings);
  },
  metadata: { newSettings, oldSettings }
});

/**
 * Run a dry-run preview of the same batch_organize payload that
 * createOrganizeBatchAction would commit. Returns the plan
 * (would-move list, would-create folder set, conflict count) without
 * acquiring the batch lock or writing to disk. Backed by the
 * `operation.dryRun` short-circuit added to handleBatchOrganize on
 * the main side — see src/main/ipc/files/batchOrganizeHandler.js.
 *
 * @param {Array<{source: string, destination: string}>} operations
 * @returns {Promise<{
 *   success: boolean,
 *   dryRun: true,
 *   total: number,
 *   wouldMove: Array<{source: string, destination: string, originalDestination: string, collision: boolean}>,
 *   skipped: Array<{source: string, destination: string, reason: string}>,
 *   wouldCreateFolders: string[],
 *   conflicts: number
 * }>}
 */
export const previewBatchOrganize = async (operations) => {
  if (!window?.electronAPI?.files?.performOperation) {
    throw new Error('File operations API not available');
  }
  const correlationId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? `org_preview_${crypto.randomUUID()}`
      : `org_preview_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return await window.electronAPI.files.performOperation({
    type: 'batch_organize',
    dryRun: true,
    operations,
    correlationId
  });
};

export const createOrganizeBatchAction = (
  description,
  operations,
  stateCallbacks = {},
  options = {}
) => ({
  type: ACTION_TYPES.BATCH_OPERATION,
  description,
  execute: async () => {
    if (!window?.electronAPI?.files?.performOperation) {
      throw new Error('File operations API not available');
    }
    const correlationId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `org_${crypto.randomUUID()}`
        : `org_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const result = await window.electronAPI.files.performOperation({
      type: 'batch_organize',
      operations,
      correlationId,
      // Resume of a paused batch: the main handler reuses this journal id so
      // already-done ops are skipped instead of re-moved.
      ...(options?.resumeBatchId ? { resumeBatchId: options.resumeBatchId } : {})
    });
    if (stateCallbacks.onExecute) {
      try {
        stateCallbacks.onExecute(result);
      } catch {
        // Non-fatal if state callback fails
      }
    } else {
      invokeBatchStateCallback('onExecute', result);
    }
    return result;
  },
  undo: async (_action) => {
    // Delegate to main process UndoRedoService to maintain history integrity
    // This ensures that:
    // 1. We don't create a NEW "move" action in the history stack
    // 2. We use the robust backup/restore logic in the main process
    // 3. The result structure is consistent (contains originalPath/newPath)
    if (!window?.electronAPI?.undoRedo?.undo) {
      throw new Error('Undo API not available');
    }
    const result = await window.electronAPI.undoRedo.undo();
    dispatchUndoRedoSync('onUndo', result, stateCallbacks, []);
    return result;
  },
  redo: async (_action) => {
    // Delegate to main process UndoRedoService
    if (!window?.electronAPI?.undoRedo?.redo) {
      throw new Error('Redo API not available');
    }
    const result = await window.electronAPI.undoRedo.redo();
    dispatchUndoRedoSync('onRedo', result, stateCallbacks, []);
    return result;
  },
  metadata: {
    operationCount: Array.isArray(operations) ? operations.length : 0,
    operations: operations
  }
});

const rehydrateAction = (serializedAction) => {
  const { type, metadata, description } = serializedAction;

  try {
    if (type === ACTION_TYPES.BATCH_OPERATION || type === 'BATCH_ORGANIZE') {
      if (metadata && metadata.operations) {
        return createOrganizeBatchAction(description, metadata.operations);
      }
    }

    if (
      type === ACTION_TYPES.FILE_MOVE ||
      type === ACTION_TYPES.FILE_DELETE ||
      type === ACTION_TYPES.FILE_RENAME ||
      type === ACTION_TYPES.FOLDER_CREATE ||
      type === ACTION_TYPES.FOLDER_DELETE ||
      type === ACTION_TYPES.FOLDER_RENAME
    ) {
      return createFileAction({
        actionType: type,
        description,
        source: metadata?.source,
        destination: metadata?.destination
      });
    }

    if (type === ACTION_TYPES.SETTINGS_CHANGE) {
      return createSettingsAction(description, metadata?.newSettings, metadata?.oldSettings);
    }
  } catch (err) {
    logger.error('Failed to rehydrate action', { type, error: err.message });
  }

  // Anything else main recorded (MOVE_BATCH from Triage or a batch move,
  // TRASH_BATCH from Duplicate Finder, FILE_COPY, a batch without its
  // operations list) stays in the mirror. Dropping it used to shorten the
  // renderer's stack and clamp the pointer, so the confirm dialog named one
  // action while main reversed another (audit row UR-01).
  if (typeof type === 'string' && type) {
    return createMainDelegatedAction({ type, description, metadata });
  }
  return null;
};

class UndoStack {
  constructor(maxSize = 100) {
    this.stack = [];
    this.pointer = -1;
    this.maxSize = maxSize;
    this.listeners = new Set();
  }

  push(action) {
    this.stack = this.stack.slice(0, this.pointer + 1);

    this.stack.push({
      ...action,
      id: generateSecureId(),
      timestamp: new Date().toISOString()
    });

    if (this.stack.length > this.maxSize) {
      this.stack.shift();
    } else {
      this.pointer++;
    }

    this.notifyListeners();
  }

  canUndo() {
    return this.pointer >= 0;
  }

  canRedo() {
    return this.pointer < this.stack.length - 1;
  }

  undo() {
    if (!this.canUndo()) return null;

    const action = this.stack[this.pointer];
    this.pointer--;
    this.notifyListeners();

    return action;
  }

  redo() {
    if (!this.canRedo()) return null;

    this.pointer++;
    const action = this.stack[this.pointer];
    this.notifyListeners();

    return action;
  }

  revertUndo() {
    if (this.pointer < this.stack.length - 1) {
      this.pointer++;
      this.notifyListeners();
    }
  }

  revertRedo() {
    if (this.pointer >= 0) {
      this.pointer--;
      this.notifyListeners();
    }
  }

  peek() {
    return this.canUndo() ? this.stack[this.pointer] : null;
  }

  peekRedo() {
    return this.canRedo() ? this.stack[this.pointer + 1] : null;
  }

  getHistory() {
    return this.stack.slice(0, this.pointer + 1);
  }

  getFullStack() {
    return this.stack.slice();
  }

  getCurrentIndex() {
    return this.pointer;
  }

  setPointer(newPointer) {
    if (newPointer >= -1 && newPointer < this.stack.length) {
      this.pointer = newPointer;
      this.notifyListeners();
    }
  }

  clear() {
    this.stack = [];
    this.pointer = -1;
    this.notifyListeners();
  }

  load(savedStack, savedPointer) {
    if (Array.isArray(savedStack)) {
      this.stack = savedStack;
      if (typeof savedPointer === 'number') {
        const maxPointer = savedStack.length - 1;
        this.pointer = Math.min(Math.max(savedPointer, -1), maxPointer);
      } else {
        this.pointer = savedStack.length - 1;
      }
      this.notifyListeners();
    }
  }

  addListener(listener) {
    this.listeners.add(listener);
  }

  removeListener(listener) {
    this.listeners.delete(listener);
  }

  notifyListeners() {
    this.listeners.forEach((listener) => listener());
  }
}

export function UndoRedoProvider({ children }) {
  const dispatch = useDispatch();
  const [undoStack] = useState(() => new UndoStack());
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [isHistoryVisible, setIsHistoryVisible] = useState(false);
  const [fullStackState, setFullStackState] = useState([]);
  const [currentIndexState, setCurrentIndexState] = useState(-1);
  const { showSuccess, showError, showInfo } = useNotification();

  const isMountedRef = React.useRef(true);
  const syncRequestIdRef = React.useRef(0);
  const actionMutexRef = React.useRef(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionStatus, setExecutionStatus] = useState({
    active: false,
    kind: null,
    label: '',
    detail: ''
  });

  const beginExecution = useCallback((kind, label, detail = '') => {
    actionMutexRef.current = true;
    if (!isMountedRef.current) return;
    setIsExecuting(true);
    setExecutionStatus({
      active: true,
      kind: kind || null,
      label: label || 'Working on file moves…',
      detail: detail || ''
    });
  }, []);

  // Sync with main process state
  const syncFromMainProcess = useCallback(async () => {
    const requestId = ++syncRequestIdRef.current;
    let state = null;
    try {
      state = await window.electronAPI?.undoRedo?.getState?.();
      if (state && isMountedRef.current && requestId === syncRequestIdRef.current) {
        // Update our local stack with main process state
        if (Array.isArray(state.stack) && state.stack.length > 0) {
          const rehydratedStack = state.stack
            .map((item) => {
              const action = rehydrateAction(item);
              return action ? { ...item, ...action } : null;
            })
            .filter(Boolean);

          if (rehydratedStack.length > 0) {
            undoStack.load(rehydratedStack, state.pointer);
          } else {
            // If actions can't be rehydrated (schema drift/corruption), avoid invalid pointer state.
            undoStack.load([], -1);
          }
        } else {
          undoStack.clear();
          try {
            localStorage.removeItem('stratosort_undo_stack');
          } catch {
            // ignore
          }
        }
        setCanUndo(state.canUndo);
        setCanRedo(state.canRedo);
        logger.debug('Synced undo/redo state from main process', {
          stackLength: state.stack?.length,
          pointer: state.pointer
        });
      }
    } catch (e) {
      logger.error('Failed to sync undo state from main process', e);
    }
    return state;
  }, [undoStack]);

  React.useEffect(() => {
    isMountedRef.current = true;

    // First, try to sync from main process (source of truth)
    syncFromMainProcess()
      .then((state) => {
        if (!isMountedRef.current) return undefined;
        // If main process not reachable, fall back to localStorage
        if (!state && undoStack.getFullStack().length === 0) {
          try {
            const saved = localStorage.getItem('stratosort_undo_stack');
            if (saved) {
              const { stack, pointer } = JSON.parse(saved);
              if (Array.isArray(stack)) {
                const rehydratedStack = stack
                  .map((item) => {
                    const action = rehydrateAction(item);
                    return action ? { ...item, ...action } : null;
                  })
                  .filter(Boolean);

                if (rehydratedStack.length > 0) {
                  undoStack.load(rehydratedStack, pointer);
                }
              }
            }
          } catch (e) {
            logger.error('Failed to load undo stack from localStorage', e);
          }
        }
        return undefined;
      })
      .catch((err) => {
        // syncFromMainProcess already swallows internal errors, so this branch
        // is defensive against unexpected throws (e.g. localStorage parse
        // failures escaping the try/catch on a future refactor).
        logger.error('Failed to initialize undo state on mount', err);
      });

    // Listen for state changes from main process
    const cleanup = window.electronAPI?.undoRedo?.onStateChanged?.((data) => {
      logger.debug('Undo/redo state changed in main process', data);
      // Multi-step jump/undo/redo drives the local stack; mid-flight sync reloads
      // from main and can desync pointer vs. in-progress UI path updates.
      if (actionMutexRef.current) {
        return;
      }
      syncFromMainProcess();
    });

    return () => {
      isMountedRef.current = false;
      if (typeof cleanup === 'function') {
        cleanup();
      }
    };
  }, [undoStack, syncFromMainProcess]);

  // Main owns the history. Before acting, reload its state so the entry we
  // confirm and name in the toast is the one main will reverse or replay.
  const refreshFromMainBeforeAction = useCallback(async () => {
    try {
      const state = await window.electronAPI?.undoRedo?.getState?.();
      if (!state || !Array.isArray(state.stack)) return;
      const localTop = undoStack.peek();
      const mainTop = state.pointer >= 0 ? state.stack[state.pointer] : null;
      const localRedo = undoStack.peekRedo();
      const mainRedo = state.stack[state.pointer + 1] || null;
      const inSync =
        undoStack.getFullStack().length === state.stack.length &&
        undoStack.getCurrentIndex() === state.pointer &&
        (localTop?.id ?? null) === (mainTop?.id ?? null) &&
        (localRedo?.id ?? null) === (mainRedo?.id ?? null);
      if (inSync) return;
      const rehydrated = state.stack
        .map((item) => {
          const action = rehydrateAction(item);
          return action ? { ...item, ...action } : null;
        })
        .filter(Boolean);
      undoStack.load(rehydrated, state.pointer);
    } catch (error) {
      logger.debug('Could not refresh undo state before action', { error: error?.message });
    }
  }, [undoStack]);

  const releaseUndoRedoLock = useCallback(async () => {
    actionMutexRef.current = false;
    if (isMountedRef.current) {
      setIsExecuting(false);
      setExecutionStatus({ active: false, kind: null, label: '', detail: '' });
    }
    await syncFromMainProcess();
  }, [syncFromMainProcess]);

  const [confirmState, setConfirmState] = useState({
    isOpen: false,
    title: '',
    message: '',
    confirmText: 'Confirm',
    cancelText: 'Cancel',
    variant: 'default',
    onConfirm: null,
    onClose: null
  });

  const showConfirm = useCallback(
    ({
      title = 'Confirm action',
      message = '',
      confirmText = 'Confirm',
      cancelText = 'Cancel',
      variant = 'default'
    }) => {
      return new Promise((resolve) => {
        setConfirmState({
          isOpen: true,
          title,
          message,
          confirmText,
          cancelText,
          variant,
          onConfirm: () => {
            resolve(true);
            setConfirmState((prev) => ({ ...prev, isOpen: false }));
          },
          onClose: () => {
            resolve(false);
            setConfirmState((prev) => ({ ...prev, isOpen: false }));
          }
        });
      });
    },
    []
  );

  const updateState = useCallback(() => {
    if (!isMountedRef.current) return;
    setCanUndo(undoStack.canUndo());
    setCanRedo(undoStack.canRedo());
    const stack = undoStack.getFullStack();
    const pointer = undoStack.getCurrentIndex();

    setFullStackState(stack);
    setCurrentIndexState(pointer);

    try {
      const simplifiedStack = stack.map((item) => ({
        id: item.id,
        timestamp: item.timestamp,
        type: item.type,
        description: item.description,
        metadata: item.metadata,
        result: item.result
      }));

      localStorage.setItem(
        'stratosort_undo_stack',
        JSON.stringify({
          stack: simplifiedStack,
          pointer
        })
      );
    } catch (e) {
      logger.error('Failed to save undo stack', e);
    }
  }, [undoStack]);

  const applyBatchPathSync = useCallback(
    (result, direction) => {
      const rows = Array.isArray(result?.results) ? result.results.filter((r) => r?.success) : [];
      if (rows.length === 0) return;

      const pairs = rows
        .map((r) => {
          if (direction === 'undo') {
            return {
              from: r.source || r.newPath,
              to: r.destination || r.originalPath || r.oldPath
            };
          }
          return {
            from: r.source || r.originalPath || r.oldPath,
            to: r.destination || r.newPath
          };
        })
        .filter((p) => typeof p.from === 'string' && p.from && typeof p.to === 'string' && p.to);

      if (pairs.length === 0) return;

      const oldPaths = pairs.map((p) => p.from);
      const newPaths = pairs.map((p) => p.to);
      // Mirror useOrganization.onUndo/onRedo: history rows and the durable
      // organizedPathIndex are owned by add/removeOrganizedFiles. On undo the
      // removal must run BEFORE the remap — removeOrganizedFiles collects the
      // destination key from the row's current `path`, which the remap rewrites
      // back to the original, leaving the destination key in the index forever.
      if (direction === 'undo') {
        dispatch(removeOrganizedFiles(newPaths));
      }
      dispatch(updateResultPathsAfterMove({ oldPaths, newPaths }));
      dispatch(updateFilePathsAfterMove({ oldPaths, newPaths }));
      if (direction !== 'undo') {
        const organizedAt = new Date().toISOString();
        dispatch(
          addOrganizedFiles(
            pairs.map(({ from, to }) => {
              const segments = to.split(/[\\/]/);
              return {
                originalPath: from,
                path: to,
                originalName: from.split(/[\\/]/).pop() || '',
                newName: segments[segments.length - 1] || '',
                smartFolder: segments.length >= 2 ? segments[segments.length - 2] : 'Organized',
                organizedAt
              };
            })
          )
        );
      }
    },
    [dispatch]
  );

  useEffect(() => {
    undoStack.addListener(updateState);
    return () => undoStack.removeListener(updateState);
  }, [undoStack, updateState]);

  useEffect(() => {
    return registerGlobalBatchStateCallbacks({
      onExecute: (result) => applyBatchPathSync(result, 'execute'),
      onUndo: (result) => applyBatchPathSync(result, 'undo'),
      onRedo: (result) => applyBatchPathSync(result, 'redo')
    });
  }, [applyBatchPathSync]);

  const assertSuccessfulUndoRedoResult = useCallback((result, actionLabel) => {
    if (isFailedUndoRedoResult(result)) {
      const detail = result.message || result.error || `Main process ${actionLabel} failed`;
      const error = new Error(detail);
      if (result.code) error.code = result.code;
      throw error;
    }
    return result;
  }, []);

  const executeAction = useCallback(
    async (actionConfig) => {
      if (actionMutexRef.current) {
        showInfo('Please wait for the current action to complete');
        return null;
      }

      beginExecution(
        'execute',
        actionConfig.description || 'Applying file operation…',
        'Moving files to their destinations'
      );

      try {
        const result = await actionConfig.execute();

        undoStack.push({
          type: actionConfig.type,
          description: actionConfig.description,
          undo: actionConfig.undo,
          redo: actionConfig.redo || actionConfig.execute,
          metadata: actionConfig.metadata || {},
          result
        });

        showSuccess(`${actionConfig.description} completed`);

        return result;
      } catch (error) {
        showError(
          `Failed to ${actionConfig.description.toLowerCase()}: ${error?.message || String(error)}`
        );
        throw error;
      } finally {
        await releaseUndoRedoLock();
      }
    },
    [undoStack, showInfo, showSuccess, showError, releaseUndoRedoLock, beginExecution]
  );

  const undo = useCallback(async () => {
    if (actionMutexRef.current) {
      showInfo('Please wait for the current action to complete');
      return;
    }

    if (!undoStack.peek()) return;

    // Acquire the mutex before the confirm dialog so key-repeat Ctrl+Z cannot
    // open a second prompt and reset the first (SW-76).
    actionMutexRef.current = true;

    await refreshFromMainBeforeAction();
    const action = undoStack.peek();
    if (!action) {
      actionMutexRef.current = false;
      return;
    }

    if (needsUndoConfirm(action)) {
      const notReversible = action.reversible === false;
      const confirmed = await showConfirm({
        title: 'Undo operation',
        message: (
          <>
            <p>Are you sure you want to undo: &quot;{action.description}&quot;?</p>
            <p className="mt-2">
              {notReversible
                ? 'These files are in the system Trash and StratoSort cannot restore them. Undoing removes this entry from history; restore the files from the Trash manually.'
                : 'This will reverse the file operation and move files back to their original locations.'}
            </p>
          </>
        ),
        confirmText: notReversible ? 'Remove entry' : 'Undo',
        cancelText: 'Cancel',
        variant: 'warning'
      });
      if (!confirmed) {
        actionMutexRef.current = false;
        return;
      }
    }

    const pending = undoStack.peek();
    beginExecution(
      'undo',
      'Undoing file move…',
      pending?.description ? `Reversing: ${pending.description}` : 'Restoring original locations'
    );

    const undoAction = undoStack.undo();
    if (!undoAction) {
      await releaseUndoRedoLock();
      return;
    }

    try {
      const result = await undoAction.undo(undoAction);
      if (result?.code === 'TRASH_NO_RESTORE') {
        // Main removed the entry: nothing was restored and nothing can be.
        // The sync in releaseUndoRedoLock picks up the shortened history.
        showInfo(result.message || 'Nothing restored: the files are in the system Trash.');
        return;
      }
      assertSuccessfulUndoRedoResult(result, 'undo');
      showSuccess(result?.message || `Undid: ${undoAction.description}`);
    } catch (error) {
      undoStack.revertUndo();
      const actionDescription = undoAction?.description || 'action';
      showError(formatUndoRedoFailure('undo', actionDescription, error));
    } finally {
      await releaseUndoRedoLock();
    }
  }, [
    undoStack,
    showInfo,
    showConfirm,
    showSuccess,
    showError,
    assertSuccessfulUndoRedoResult,
    releaseUndoRedoLock,
    refreshFromMainBeforeAction,
    beginExecution
  ]);

  const redo = useCallback(async () => {
    if (actionMutexRef.current) {
      showInfo('Please wait for the current action to complete');
      return;
    }

    actionMutexRef.current = true;
    await refreshFromMainBeforeAction();
    const pending = undoStack.peekRedo();
    if (!pending) {
      actionMutexRef.current = false;
      return;
    }
    beginExecution(
      'redo',
      'Redoing file move…',
      pending?.description ? `Re-applying: ${pending.description}` : 'Moving files again'
    );

    const action = undoStack.redo();
    if (!action) {
      await releaseUndoRedoLock();
      return;
    }

    try {
      const result = await action.redo(action);
      assertSuccessfulUndoRedoResult(result, 'redo');
      showSuccess(result?.message || `Redid: ${action.description}`);
    } catch (error) {
      undoStack.revertRedo();
      const actionDescription = action?.description || 'action';
      showError(formatUndoRedoFailure('redo', actionDescription, error));
    } finally {
      await releaseUndoRedoLock();
    }
  }, [
    undoStack,
    showInfo,
    showSuccess,
    showError,
    assertSuccessfulUndoRedoResult,
    releaseUndoRedoLock,
    refreshFromMainBeforeAction,
    beginExecution
  ]);

  const getActionDescription = useCallback((action) => {
    const metadata = ACTION_METADATA[action.type];
    if (metadata) {
      return action.description || metadata.description;
    }
    return action.description || 'Unknown action';
  }, []);

  const clearHistory = useCallback(async () => {
    try {
      // Clear in main process first (source of truth)
      await window.electronAPI?.undoRedo?.clear?.();
    } catch (e) {
      logger.error('Failed to clear history in main process', e);
    }
    // Then clear local state
    undoStack.clear();
    localStorage.removeItem('stratosort_undo_stack');
    showInfo('Undo/redo history cleared');
  }, [undoStack, showInfo]);

  const clearHistoryWithConfirm = useCallback(async () => {
    const confirmed = await showConfirm({
      title: 'Clear action history',
      message:
        'This removes all recorded undo and redo steps for this session. You cannot undo clearing history. Continue?',
      confirmText: 'Clear history',
      cancelText: 'Cancel',
      variant: 'danger'
    });
    if (!confirmed) return;
    await clearHistory();
  }, [showConfirm, clearHistory]);

  const jumpToPoint = useCallback(
    async (targetIndex) => {
      if (actionMutexRef.current) {
        showInfo('Please wait for the current action to complete');
        return;
      }

      const currentIndex = undoStack.getCurrentIndex();
      if (targetIndex === currentIndex) {
        return;
      }

      const fullStack = undoStack.getFullStack();
      if (targetIndex < -1 || targetIndex >= fullStack.length) {
        showError('Invalid history point');
        return;
      }

      const steps =
        targetIndex < currentIndex ? currentIndex - targetIndex : targetIndex - currentIndex;
      beginExecution(
        'jump',
        targetIndex < currentIndex ? 'Jumping back in history…' : 'Jumping forward in history…',
        `${steps} step${steps === 1 ? '' : 's'} — files will move as each step runs`
      );

      try {
        if (targetIndex < currentIndex) {
          const stepsToUndo = currentIndex - targetIndex;
          showInfo(`Jumping back ${stepsToUndo} step${stepsToUndo > 1 ? 's' : ''}...`);

          let completedSteps = 0;
          for (let i = 0; i < stepsToUndo; i++) {
            try {
              const action = undoStack.undo();
              if (action) {
                const result = await action.undo(action);
                assertSuccessfulUndoRedoResult(result, 'undo');
              }
              completedSteps++;
            } catch (stepError) {
              // Roll back already-completed jump steps to keep renderer/main process in sync.
              for (let rollbackStep = 0; rollbackStep < completedSteps; rollbackStep++) {
                const rollbackAction = undoStack.redo();
                if (!rollbackAction) break;
                try {
                  const rollbackResult = await rollbackAction.redo(rollbackAction);
                  assertSuccessfulUndoRedoResult(rollbackResult, 'redo rollback');
                } catch (rollbackError) {
                  logger.error('Jump rollback failed after undo error', rollbackError);
                  break;
                }
              }
              showError(
                `Jump failed at step ${completedSteps + 1}/${stepsToUndo}: ${stepError?.message || String(stepError)}`
              );
              return;
            }
          }
          showSuccess(`Jumped back to step ${targetIndex + 1}`);
        } else {
          const stepsToRedo = targetIndex - currentIndex;
          showInfo(`Jumping forward ${stepsToRedo} step${stepsToRedo > 1 ? 's' : ''}...`);

          let completedSteps = 0;
          for (let i = 0; i < stepsToRedo; i++) {
            try {
              const action = undoStack.redo();
              if (action) {
                const result = await action.redo(action);
                assertSuccessfulUndoRedoResult(result, 'redo');
              }
              completedSteps++;
            } catch (stepError) {
              // Roll back already-completed jump steps to keep renderer/main process in sync.
              for (let rollbackStep = 0; rollbackStep < completedSteps; rollbackStep++) {
                const rollbackAction = undoStack.undo();
                if (!rollbackAction) break;
                try {
                  const rollbackResult = await rollbackAction.undo(rollbackAction);
                  assertSuccessfulUndoRedoResult(rollbackResult, 'undo rollback');
                } catch (rollbackError) {
                  logger.error('Jump rollback failed after redo error', rollbackError);
                  break;
                }
              }
              showError(
                `Jump failed at step ${completedSteps + 1}/${stepsToRedo}: ${stepError?.message || String(stepError)}`
              );
              return;
            }
          }
          showSuccess(`Jumped forward to step ${targetIndex + 1}`);
        }
      } catch (error) {
        showError(`Jump failed: ${error?.message || String(error)}`);
      } finally {
        await releaseUndoRedoLock();
      }
    },
    [
      undoStack,
      showInfo,
      showSuccess,
      showError,
      assertSuccessfulUndoRedoResult,
      releaseUndoRedoLock,
      beginExecution
    ]
  );

  const contextValue = useMemo(
    () => ({
      executeAction,
      undo,
      redo,
      canUndo,
      canRedo,
      isExecuting,
      executionStatus,
      getHistory: () => undoStack.getHistory(),
      getFullStack: () => undoStack.getFullStack(),
      getCurrentIndex: () => undoStack.getCurrentIndex(),
      fullStack: fullStackState,
      currentIndex: currentIndexState,
      jumpToPoint,
      peek: () => undoStack.peek(),
      peekRedo: () => undoStack.peekRedo(),
      getActionDescription,
      clearHistory,
      clearHistoryWithConfirm,
      isHistoryVisible,
      setIsHistoryVisible
    }),
    [
      executeAction,
      undo,
      redo,
      canUndo,
      canRedo,
      executionStatus,
      isExecuting,
      undoStack,
      fullStackState,
      currentIndexState,
      jumpToPoint,
      getActionDescription,
      clearHistory,
      clearHistoryWithConfirm,
      isHistoryVisible,
      setIsHistoryVisible
    ]
  );

  return (
    <UndoRedoContext.Provider value={contextValue}>
      {children}
      <ActionProgressBanner status={executionStatus} />
      {isHistoryVisible && <HistoryModal />}
      <ConfirmModal
        isOpen={confirmState.isOpen}
        onClose={
          confirmState.onClose || (() => setConfirmState((prev) => ({ ...prev, isOpen: false })))
        }
        onConfirm={
          confirmState.onConfirm || (() => setConfirmState((prev) => ({ ...prev, isOpen: false })))
        }
        title={confirmState.title}
        message={confirmState.message}
        confirmText={confirmState.confirmText}
        cancelText={confirmState.cancelText}
        variant={confirmState.variant}
      />
    </UndoRedoContext.Provider>
  );
}

function ActionProgressBanner({ status }) {
  if (!status?.active || typeof document === 'undefined') return null;

  const KindIcon =
    status.kind === 'undo'
      ? Undo2
      : status.kind === 'redo'
        ? Redo2
        : status.kind === 'jump'
          ? Undo2
          : Loader2;

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-testid="action-progress-banner"
      className="pointer-events-none fixed inset-x-0 z-[var(--z-overlay)] flex justify-center px-4"
      style={{ top: 'calc(var(--app-nav-height, 3.5rem) + 0.75rem)' }}
    >
      <div className="pointer-events-auto flex max-w-xl items-center gap-cozy rounded-xl border border-stratosort-blue/25 bg-[var(--surface-primary)]/95 px-4 py-3 shadow-lg backdrop-blur-md">
        <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-stratosort-blue/10 text-stratosort-blue">
          <KindIcon className="h-4 w-4" aria-hidden="true" />
          <Loader2
            className="absolute inset-0 m-auto h-9 w-9 animate-spin text-stratosort-blue/35"
            aria-hidden="true"
          />
        </span>
        <div className="min-w-0 flex-1">
          <Text variant="small" className="font-semibold text-system-gray-900">
            {status.label}
          </Text>
          {status.detail ? (
            <Text variant="tiny" className="mt-0.5 truncate text-system-gray-600">
              {status.detail}
            </Text>
          ) : null}
          <div
            className="mt-2 h-1 overflow-hidden rounded-full bg-system-gray-200"
            aria-hidden="true"
          >
            <div className="h-full w-1/3 animate-pulse rounded-full bg-stratosort-blue" />
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

ActionProgressBanner.propTypes = {
  status: PropTypes.shape({
    active: PropTypes.bool,
    kind: PropTypes.string,
    label: PropTypes.string,
    detail: PropTypes.string
  })
};

UndoRedoProvider.propTypes = {
  children: PropTypes.node.isRequired
};

export function useUndoRedo() {
  const context = useContext(UndoRedoContext);
  if (!context) {
    throw new Error('useUndoRedo must be used within an UndoRedoProvider');
  }
  return context;
}

function HistoryModal() {
  const {
    fullStack,
    currentIndex,
    jumpToPoint,
    setIsHistoryVisible,
    clearHistoryWithConfirm,
    isExecuting
  } = useUndoRedo();
  const redactPaths = useSelector(selectRedactPaths);

  const handleJumpToPoint = async (targetIndex) => {
    await jumpToPoint(targetIndex);
  };

  const orderedActions = useMemo(
    () =>
      fullStack
        .slice()
        .reverse()
        .map((action, reversedIndex) => {
          const actualIndex = fullStack.length - 1 - reversedIndex;
          return {
            action,
            actualIndex,
            isCurrent: actualIndex === currentIndex,
            isFuture: actualIndex > currentIndex,
            display: formatHistoryActionDisplay(action, { redact: redactPaths })
          };
        }),
    [fullStack, currentIndex, redactPaths]
  );

  return (
    <Modal
      isOpen={true}
      onClose={() => setIsHistoryVisible(false)}
      title="Action history"
      description="Highlighted row is your current step. Click an earlier row to jump back, or a later row to redo forward."
      size="md"
      bodyClassName="!p-0"
      footer={
        <Inline className="w-full justify-between" gap="default" wrap>
          <Button
            onClick={clearHistoryWithConfirm}
            variant="danger"
            size="sm"
            disabled={isExecuting || fullStack.length === 0}
            title="Clear all history"
          >
            Clear history
          </Button>
          <Button onClick={() => setIsHistoryVisible(false)} variant="secondary" size="sm">
            Close
          </Button>
        </Inline>
      }
    >
      <div
        className="max-h-[min(50vh,28rem)] overflow-y-auto modern-scrollbar px-6 py-4"
        aria-live="polite"
      >
        {fullStack.length === 0 ? (
          <StateMessage
            icon={FileText}
            tone="neutral"
            size="lg"
            title="No actions recorded"
            description="Reversible file moves will appear here."
            className="text-center p-8 bg-system-gray-50/50 rounded-xl border border-dashed border-border-soft"
            contentClassName="max-w-sm"
          />
        ) : (
          <ul className="m-0 list-none space-y-2 p-0">
            {orderedActions.map(({ action, actualIndex, isCurrent, isFuture, display }) => {
              const timeLabel = new Date(action.timestamp).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit'
              });
              const rowTitle = isCurrent
                ? 'Current position (pick an earlier row to jump back)'
                : isFuture
                  ? 'Later step: click to redo forward to here'
                  : 'Earlier step: click to jump back to this point';

              return (
                <li key={action.id}>
                  <button
                    type="button"
                    onClick={() => handleJumpToPoint(actualIndex)}
                    disabled={isExecuting || isCurrent}
                    title={rowTitle}
                    aria-label={`${display.ariaLabel}. Step ${actualIndex + 1}. ${timeLabel}${
                      isCurrent ? '. Current step' : isFuture ? '. Later' : ''
                    }`}
                    aria-current={isCurrent ? 'step' : undefined}
                    className={`
                      list-row flex w-full items-start gap-cozy overflow-hidden p-3 text-left
                      ${
                        isCurrent
                          ? 'border-stratosort-blue/40 ring-1 ring-stratosort-blue/20 bg-stratosort-blue/[0.04]'
                          : isFuture
                            ? 'border-dashed opacity-80'
                            : ''
                      }
                      ${isExecuting ? 'cursor-wait opacity-50' : isCurrent ? 'cursor-default' : 'cursor-pointer'}
                      disabled:pointer-events-none
                    `}
                  >
                    <StatusBadge
                      size="sm"
                      variant={isCurrent ? 'info' : isFuture ? 'warning' : 'success'}
                      className="shrink-0"
                    >
                      {display.badge}
                    </StatusBadge>

                    <div className="min-w-0 flex-1 overflow-hidden">
                      <div className="flex items-start justify-between gap-compact">
                        <Text
                          variant="small"
                          className={`truncate font-medium ${
                            isCurrent ? 'text-stratosort-blue' : 'text-system-gray-900'
                          }`}
                        >
                          {display.title}
                        </Text>
                        <Text
                          as="span"
                          variant="tiny"
                          className="shrink-0 font-mono text-system-gray-400"
                        >
                          #{actualIndex + 1}
                        </Text>
                      </div>
                      {display.detail ? (
                        <Text variant="tiny" className="mt-0.5 truncate text-system-gray-500">
                          {display.detail}
                        </Text>
                      ) : null}
                      <div className="mt-1 flex flex-wrap items-center gap-compact">
                        <Text as="span" variant="tiny" className="text-system-gray-500">
                          {timeLabel}
                        </Text>
                        {isCurrent ? (
                          <StatusBadge appearance="label" variant="info">
                            Current
                          </StatusBadge>
                        ) : null}
                        {isFuture ? (
                          <StatusBadge appearance="label" variant="neutral">
                            Later
                          </StatusBadge>
                        ) : null}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}

export function UndoRedoToolbar({ className = '', showClearHistory = false }) {
  const {
    undo,
    redo,
    canUndo,
    canRedo,
    peek,
    peekRedo,
    getActionDescription,
    setIsHistoryVisible,
    clearHistoryWithConfirm,
    fullStack,
    isExecuting,
    executionStatus
  } = useUndoRedo();

  const lastAction = peek();
  const nextAction = peekRedo();
  const undoing = isExecuting && executionStatus?.kind === 'undo';
  const redoing = isExecuting && executionStatus?.kind === 'redo';
  const historyBusy = isExecuting && executionStatus?.kind === 'jump';

  const isImportantOperation =
    lastAction?.description &&
    (lastAction.description.toLowerCase().includes('organize') ||
      lastAction.description.toLowerCase().includes('move') ||
      lastAction.description.toLowerCase().includes('delete'));

  return (
    <div
      className={`flex items-center space-x-2 ${className}`}
      aria-busy={isExecuting || undefined}
    >
      {isExecuting && executionStatus?.label ? (
        <Text
          as="span"
          variant="tiny"
          className="mr-1 hidden max-w-[12rem] truncate font-medium text-stratosort-blue sm:inline"
          data-testid="undo-redo-toolbar-status"
        >
          {executionStatus.label}
        </Text>
      ) : null}
      <Button
        onClick={undo}
        disabled={!canUndo || isExecuting}
        variant="secondary"
        size="sm"
        aria-label={undoing ? 'Undoing…' : 'Undo'}
        isLoading={undoing}
        className={
          isImportantOperation
            ? 'text-stratosort-warning hover:bg-stratosort-warning/10 border-stratosort-warning/20'
            : ''
        }
        title={
          isExecuting
            ? executionStatus?.label || 'File operation in progress'
            : lastAction
              ? `Undo: ${getActionDescription(lastAction)}${isImportantOperation ? ' (Will ask for confirmation)' : ''}`
              : 'Nothing to undo'
        }
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
          />
        </svg>
      </Button>

      <Button
        onClick={redo}
        disabled={!canRedo || isExecuting}
        variant="secondary"
        size="sm"
        aria-label={redoing ? 'Redoing…' : 'Redo'}
        isLoading={redoing}
        title={
          isExecuting
            ? executionStatus?.label || 'File operation in progress'
            : nextAction
              ? `Redo: ${getActionDescription(nextAction)}`
              : 'Nothing to redo'
        }
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 10h-10a8 8 0 00-8 8v2m18-10l-6 6m6-6l-6-6"
          />
        </svg>
      </Button>

      <div className="w-px h-6 bg-system-gray-300 mx-1" />

      <Button
        onClick={() => setIsHistoryVisible(true)}
        variant="ghost"
        size="sm"
        disabled={isExecuting}
        isLoading={historyBusy}
        title={
          isExecuting
            ? executionStatus?.label || 'File operation in progress'
            : 'View action history'
        }
        aria-label={historyBusy ? 'Updating history…' : 'View action history'}
      >
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      </Button>

      {showClearHistory && Array.isArray(fullStack) && fullStack.length > 0 && (
        <Button
          onClick={clearHistoryWithConfirm}
          variant="ghost"
          size="sm"
          title="Clear all action history"
          aria-label="Clear all action history"
          className="shrink-0 whitespace-nowrap px-4 text-system-gray-600"
        >
          Clear history
        </Button>
      )}
    </div>
  );
}

UndoRedoToolbar.propTypes = {
  className: PropTypes.string,
  showClearHistory: PropTypes.bool
};

export const createBatchAction = (description, actions) => ({
  type: ACTION_TYPES.BATCH_OPERATION,
  description,
  execute: async () => {
    const results = [];
    for (const action of actions) {
      results.push(await action.execute());
    }
    return results;
  },
  undo: async () => {
    const results = [];
    for (const action of actions.slice().reverse()) {
      results.push(await action.undo());
    }
    return results;
  },
  metadata: { actionCount: actions.length }
});

export default {
  UndoRedoProvider,
  useUndoRedo,
  UndoRedoToolbar,
  ACTION_TYPES,
  createFileAction,
  createSettingsAction,
  createOrganizeBatchAction,
  createBatchAction
};
