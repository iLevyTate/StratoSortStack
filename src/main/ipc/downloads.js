// @ts-check
const { BrowserWindow } = require('electron');
const { registerHandlers, safeSend } = require('./ipcWrappers');
const { IpcServiceContext, createFromLegacyParams } = require('./IpcServiceContext');
const { schemas } = require('./validationSchemas');
const { getDownloadsTriageService } = require('../services/triage/DownloadsTriageService');
const { IPC_EVENTS } = require('../../shared/constants');

/**
 * Mirror the single-file move/delete FILE_OPERATION_COMPLETE contract for
 * triage act() results so the renderer's graph/timeline/recommendation-map
 * listeners remap trashed/organized files exactly like ordinary moves
 * (F-152). Keyed on the actual mutation arrays, not the success flag — a
 * partial failure still moved/trashed what it reports. Best-effort.
 * @param {Electron.IpcMainInvokeEvent} event
 * @param {any} result
 */
function notifyActFileOperations(event, result) {
  try {
    if (!result) return;
    const trashed = Array.isArray(result.trashed)
      ? result.trashed.map((/** @type {any} */ t) => t?.path).filter(Boolean)
      : [];
    if (trashed.length > 0) {
      safeSend(event.sender, IPC_EVENTS.FILE_OPERATION_COMPLETE, {
        operation: 'delete',
        files: trashed
      });
    }
    const moved = Array.isArray(result.moved)
      ? result.moved.filter((/** @type {any} */ m) => m?.path && m?.destination)
      : [];
    if (moved.length > 0) {
      safeSend(event.sender, IPC_EVENTS.FILE_OPERATION_COMPLETE, {
        operation: 'move',
        files: moved.map((/** @type {any} */ m) => m.path),
        destinations: moved.map((/** @type {any} */ m) => m.destination)
      });
    }
  } catch {
    // Best-effort notification; the act() outcome is already final.
  }
}

/**
 * IPC registration for Downloads Triage (Phase 3).
 *
 * Channels:
 *   - downloads:triage:start         -> FastTriageClassifier sweep of a chosen folder
 *   - downloads:triage:deep-scan     -> Embedding pass on the ambiguous remainder
 *   - downloads:triage:act           -> Batched trash / organize / ignore action
 *   - downloads:triage:export-report -> Save triage results as CSV via save dialog
 *
 * @param {IpcServiceContext|Record<string, any>} servicesOrParams - Service context or legacy parameters
 */
function registerDownloadsIpc(servicesOrParams) {
  let context;
  if (servicesOrParams instanceof IpcServiceContext) {
    context = servicesOrParams;
  } else {
    context = createFromLegacyParams(servicesOrParams);
  }

  const { ipcMain, IPC_CHANNELS, logger } = context.core;
  const service = getDownloadsTriageService();

  const TRIAGE_PROGRESS_THROTTLE_MS = 200;

  /**
   * @param {Electron.IpcMainInvokeEvent} event
   * @returns {(patch: any) => void} Throttled progress-event sender
   */
  function buildTriageProgressSender(event) {
    let lastSent = 0;
    return (patch) => {
      const now = Date.now();
      const done = Number(patch?.done);
      const total = Number(patch?.total);
      const isFinal = Number.isFinite(done) && Number.isFinite(total) && total > 0 && done >= total;
      if (!isFinal && now - lastSent < TRIAGE_PROGRESS_THROTTLE_MS) return;
      lastSent = now;
      safeSend(event.sender, IPC_CHANNELS.DOWNLOADS.TRIAGE_SCAN_PROGRESS, patch);
    };
  }

  registerHandlers({
    ipcMain,
    logger,
    context: 'Downloads',
    handlers: {
      [IPC_CHANNELS.DOWNLOADS.TRIAGE_START]: {
        schema: schemas.downloadsTriageStart,
        handler: async (event, payload = {}) => {
          try {
            const onProgress = buildTriageProgressSender(event);
            return await service.start(payload, {
              signal: event?.abortSignal,
              onProgress
            });
          } catch (err) {
            logger.error('[Downloads IPC] triage:start failed', { error: err?.message });
            return {
              success: false,
              error: err?.message || 'Triage start failed',
              buckets: { keep: [], trash: [], excluded: [], ambiguous: [] }
            };
          }
        }
      },
      [IPC_CHANNELS.DOWNLOADS.TRIAGE_DEEP_SCAN]: {
        schema: schemas.downloadsTriageDeepScan,
        handler: async (event, payload = {}) => {
          try {
            const onProgress = buildTriageProgressSender(event);
            return await service.deepScan(payload, {
              signal: event?.abortSignal,
              onProgress
            });
          } catch (err) {
            logger.error('[Downloads IPC] triage:deep-scan failed', { error: err?.message });
            return {
              success: false,
              error: err?.message || 'Deep scan failed'
            };
          }
        }
      },
      [IPC_CHANNELS.DOWNLOADS.TRIAGE_ACT]: {
        schema: schemas.downloadsTriageAct,
        handler: async (event, payload = {}) => {
          try {
            const result = await service.act(payload);
            notifyActFileOperations(event, result);
            return result;
          } catch (err) {
            logger.error('[Downloads IPC] triage:act failed', { error: err?.message });
            return {
              success: false,
              error: err?.message || 'Triage act failed'
            };
          }
        }
      },
      [IPC_CHANNELS.DOWNLOADS.TRIAGE_EXPORT_REPORT]: {
        schema: schemas.downloadsTriageExportReport,
        handler: async (event, payload = {}) => {
          try {
            const rows = service.getReportRows(payload?.triageId);
            if (rows === null) {
              return { success: false, error: 'Triage session expired or not found' };
            }
            if (rows.length === 0) {
              return { success: false, error: 'No triage results to export' };
            }
            const { toTriageCsv } = require('../services/triage/triageReport');
            const { dialog } = require('electron');
            const fs = require('fs');
            const win = BrowserWindow.getFocusedWindow() || null;
            const { filePath: savePath, canceled } = await dialog.showSaveDialog(win, {
              title: 'Export Triage Report',
              defaultPath: 'triage-report.csv',
              filters: [{ name: 'CSV Files', extensions: ['csv'] }]
            });
            if (canceled || !savePath) {
              return { success: false, canceled: true };
            }
            await fs.promises.writeFile(savePath, toTriageCsv(rows), 'utf8');
            return { success: true, filePath: savePath, rowCount: rows.length };
          } catch (err) {
            logger.error('[Downloads IPC] triage:export-report failed', { error: err?.message });
            return { success: false, error: err?.message || 'Report export failed' };
          }
        }
      }
    }
  });

  if (typeof service.setSessionEvictionBroadcaster === 'function') {
    service.setSessionEvictionBroadcaster((/** @type {string[]} */ evictedIds) => {
      if (!Array.isArray(evictedIds) || evictedIds.length === 0) return;
      try {
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed()) continue;
          safeSend(win.webContents, IPC_CHANNELS.DOWNLOADS.TRIAGE_SESSION_INVALIDATED, {
            evictedIds
          });
        }
      } catch (err) {
        logger.warn('[Downloads IPC] triage session eviction broadcast failed', {
          error: err?.message
        });
      }
    });
  }
}

module.exports = registerDownloadsIpc;
