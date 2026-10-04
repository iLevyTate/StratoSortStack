// @ts-check
/**
 * Undo/Redo IPC Handlers
 *
 * Handles undo, redo, and action history operations.
 * Demonstrates the service check pattern with fallback responses.
 */
const { IpcServiceContext, createFromLegacyParams } = require('./IpcServiceContext');
const { createHandler, safeHandle, safeSend } = require('./ipcWrappers');
const { schemas } = require('./validationSchemas');
const { getInstance: getDegradedStateTracker } = require('../services/DegradedStateTracker');
const { IPC_EVENTS } = require('../../shared/constants');

/**
 * Broadcast the moves an undo/redo just performed as FILE_OPERATION_COMPLETE
 * so the renderer's path listeners (graph node remap, timeline refresh,
 * recommendation map) track reverted/re-applied organizes exactly like the
 * forward operation (F-152). `pathMutations` is built by
 * UndoRedoService._collectMoveMutations. Best-effort — never fails the op.
 * @param {any} event
 * @param {any} result
 */
function notifyUndoRedoFileOperations(event, result) {
  try {
    const mutations = Array.isArray(result?.pathMutations) ? result.pathMutations : [];
    if (mutations.length === 0) return;
    if (!event?.sender || event.sender.isDestroyed()) return;
    safeSend(event.sender, IPC_EVENTS.FILE_OPERATION_COMPLETE, {
      operation: 'move',
      files: mutations.map((/** @type {any} */ m) => m.oldPath),
      destinations: mutations.map((/** @type {any} */ m) => m.newPath)
    });
  } catch {
    // Best-effort notification; the undo/redo already completed.
  }
}

const UNDO_REDO_DEGRADED_CODE = 'undo-redo.service-unavailable';

/**
 * @param {Record<string, any>} detail
 */
function _raiseUndoRedoDegraded(detail) {
  // CAN_UNDO and CAN_REDO are polled to drive the toolbar button enabled state.
  // Without this flag, a thrown service exception leaves both buttons disabled
  // — indistinguishable from "no history yet". Users mid-edit who hit Ctrl+Z
  // expecting to undo a destructive change will silently get no response and
  // proceed unaware. Severity: error — destructive-action recovery is the
  // user's most critical safety net.
  try {
    getDegradedStateTracker().raise({
      code: UNDO_REDO_DEGRADED_CODE,
      subsystem: 'undo-redo',
      severity: 'error',
      message:
        "Undo/redo isn't working — recent file moves can't be reversed from the toolbar. " +
        'Avoid further destructive actions and restart the app to recover history.',
      detail
    });
  } catch {
    /* tracker is best-effort */
  }
}

function _clearUndoRedoDegraded() {
  try {
    getDegradedStateTracker().clear(UNDO_REDO_DEGRADED_CODE);
  } catch {
    /* never throw from a successful response path */
  }
}

/**
 * @param {IpcServiceContext|Record<string, any>} servicesOrParams - Service context or legacy parameters
 */
function registerUndoRedoIpc(servicesOrParams) {
  let container;
  if (servicesOrParams instanceof IpcServiceContext) {
    container = servicesOrParams;
  } else {
    container = createFromLegacyParams(servicesOrParams);
  }

  const { ipcMain, IPC_CHANNELS, logger } = container.core;
  const { getServiceIntegration } = container;

  const context = 'UndoRedo';

  // Helper to get undo/redo service
  const getUndoRedoService = () => getServiceIntegration()?.undoRedo;

  // Undo action
  safeHandle(
    ipcMain,
    IPC_CHANNELS.UNDO_REDO.UNDO,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      serviceName: 'undoRedo',
      getService: getUndoRedoService,
      fallbackResponse: { success: false, message: 'Undo service unavailable' },
      handler: async (event, service) => {
        try {
          const result = (await service.undo()) || {
            success: false,
            message: 'Nothing to undo'
          };
          if (result?.success && event?.sender && !event.sender.isDestroyed()) {
            safeSend(event.sender, IPC_CHANNELS.UNDO_REDO.STATE_CHANGED, {
              action: 'undo',
              result
            });
          }
          // Partial undoes still moved the files they report — notify
          // regardless of the aggregate success flag.
          notifyUndoRedoFileOperations(event, result);
          return result;
        } catch (error) {
          logger.error('Failed to execute undo:', error);
          // Preserve the error code (UNDO_SOURCE_MISSING /
          // UNDO_DESTINATION_OCCUPIED) so the renderer can show actionable
          // guidance instead of a generic failure.
          return { success: false, message: error.message, code: error.code };
        }
      }
    })
  );

  // Redo action
  safeHandle(
    ipcMain,
    IPC_CHANNELS.UNDO_REDO.REDO,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      serviceName: 'undoRedo',
      getService: getUndoRedoService,
      fallbackResponse: { success: false, message: 'Redo service unavailable' },
      handler: async (event, service) => {
        try {
          const result = (await service.redo()) || {
            success: false,
            message: 'Nothing to redo'
          };
          if (result?.success && event?.sender && !event.sender.isDestroyed()) {
            safeSend(event.sender, IPC_CHANNELS.UNDO_REDO.STATE_CHANGED, {
              action: 'redo',
              result
            });
          }
          // Partial redoes still moved the files they report — notify
          // regardless of the aggregate success flag.
          notifyUndoRedoFileOperations(event, result);
          return result;
        } catch (error) {
          logger.error('Failed to execute redo:', error);
          return { success: false, message: error.message, code: error.code };
        }
      }
    })
  );

  // Get action history
  safeHandle(
    ipcMain,
    IPC_CHANNELS.UNDO_REDO.GET_HISTORY,
    createHandler({
      logger,
      context,
      schema: schemas?.undoRedoHistoryLimit,
      serviceName: 'undoRedo',
      getService: getUndoRedoService,
      fallbackResponse: [],
      handler: async (event, limit, service) => {
        try {
          const parsed = Number(limit);
          const safeLimit = Number.isFinite(parsed)
            ? Math.min(200, Math.max(1, Math.floor(parsed)))
            : 50;
          const value = (await service.getActionHistory(safeLimit)) || [];
          _clearUndoRedoDegraded();
          return value;
        } catch (error) {
          logger.error('Failed to get action history:', error);
          // A thrown store read (DB lock / corrupted journal) returns [] —
          // indistinguishable from "no history". Surface the same subsystem
          // degraded flag the polled CAN_UNDO/CAN_REDO handlers raise so the
          // history panel shows an actionable banner instead of a misleading
          // empty list.
          _raiseUndoRedoDegraded({ handler: 'GET_HISTORY', error: error?.message });
          return [];
        }
      }
    })
  );

  // Get full undo/redo state for UI synchronization
  safeHandle(
    ipcMain,
    IPC_CHANNELS.UNDO_REDO.GET_STATE,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      serviceName: 'undoRedo',
      getService: getUndoRedoService,
      fallbackResponse: { stack: [], pointer: -1, canUndo: false, canRedo: false },
      handler: async (event, service) => {
        try {
          const value = service.getFullState() || {
            stack: [],
            pointer: -1,
            canUndo: false,
            canRedo: false
          };
          _clearUndoRedoDegraded();
          return value;
        } catch (error) {
          logger.error('Failed to get undo/redo state:', error);
          // getFullState drives the same toolbar undo/redo enabled-state the
          // polled CAN_UNDO/CAN_REDO handlers do. A thrown read returns the
          // canonical empty state, which silently disables both buttons —
          // indistinguishable from "no history". Surface the shared subsystem
          // degraded flag the CAN_* handlers raise so the user sees an
          // actionable banner instead of dead toolbar buttons.
          _raiseUndoRedoDegraded({ handler: 'GET_STATE', error: error?.message });
          return { stack: [], pointer: -1, canUndo: false, canRedo: false };
        }
      }
    })
  );

  // Clear action history
  safeHandle(
    ipcMain,
    IPC_CHANNELS.UNDO_REDO.CLEAR_HISTORY,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      serviceName: 'undoRedo',
      getService: getUndoRedoService,
      fallbackResponse: { success: true },
      handler: async (event, service) => {
        try {
          return (await service.clearHistory()) || { success: true };
        } catch (error) {
          logger.error('Failed to clear action history:', error);
          return { success: false, message: error.message };
        }
      }
    })
  );

  // Check if undo is available
  safeHandle(
    ipcMain,
    IPC_CHANNELS.UNDO_REDO.CAN_UNDO,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      serviceName: 'undoRedo',
      getService: getUndoRedoService,
      fallbackResponse: false,
      handler: async (event, service) => {
        try {
          const value = (await service.canUndo()) || false;
          _clearUndoRedoDegraded();
          return value;
        } catch (error) {
          logger.error('Failed to check undo status:', error);
          _raiseUndoRedoDegraded({ handler: 'CAN_UNDO', error: error?.message });
          return false;
        }
      }
    })
  );

  // Check if redo is available
  safeHandle(
    ipcMain,
    IPC_CHANNELS.UNDO_REDO.CAN_REDO,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      serviceName: 'undoRedo',
      getService: getUndoRedoService,
      fallbackResponse: false,
      handler: async (event, service) => {
        try {
          const value = (await service.canRedo()) || false;
          _clearUndoRedoDegraded();
          return value;
        } catch (error) {
          logger.error('Failed to check redo status:', error);
          _raiseUndoRedoDegraded({ handler: 'CAN_REDO', error: error?.message });
          return false;
        }
      }
    })
  );
}

module.exports = registerUndoRedoIpc;
