// @ts-check
/**
 * Organize report handler: saves the per-file list of an organize run as a
 * CSV file the user picks in a save dialog. The rows come from the renderer
 * (utils/organizeRunResults), which already holds them; nothing leaves the
 * machine.
 *
 * @module ipc/files/reportHandlers
 */

const { IPC_CHANNELS } = require('../../../shared/constants');
const { createHandler, safeHandle, z } = require('../ipcWrappers');
const { createLogger } = require('../../../shared/logger');
const { safeWriteFile } = require('../../../shared/atomicFileOperations');
const { toOrganizeReportCsv } = require('../../services/organize/organizeReport');

const logger = createLogger('IPC:Files:Report');

/**
 * The most rows one export takes: the renderer keeps at most this many per
 * run (MAX_RUN_RESULT_ROWS), and the preload refuses longer arrays.
 */
const MAX_REPORT_ROWS = 10000;

const OUTCOMES = /** @type {const} */ ([
  'moved',
  'duplicate',
  'failed',
  'notMoved',
  'restored',
  'leftAtDestination'
]);

const exportOrganizeReportSchema = z
  ? z.object({
      rows: z
        .array(
          z.object({
            name: z.string().max(1024),
            originalPath: z.string().max(4096),
            plannedPath: z.string().max(4096).optional(),
            finalPath: z.string().max(4096).nullable().optional(),
            outcome: z.enum(OUTCOMES),
            reason: z.string().max(2000).optional(),
            renamedOnCollision: z.boolean().optional()
          })
        )
        .min(1)
        .max(MAX_REPORT_ROWS)
    })
  : null;

/**
 * "stratosort-organize-results-2026-11-13.csv", in the user's local date.
 * @param {Date} [now]
 * @returns {string}
 */
function defaultReportName(now = new Date()) {
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `stratosort-organize-results-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.csv`;
}

/**
 * Register the organize report handler.
 * @param {import('../IpcServiceContext').IpcServiceContext} container
 */
function registerReportHandlers(container) {
  const { ipcMain } = container.core;
  const { dialog, getMainWindow } = container.electron;

  safeHandle(
    ipcMain,
    IPC_CHANNELS.FILES.EXPORT_ORGANIZE_REPORT,
    createHandler({
      logger,
      context: 'OrganizeReport',
      schema: exportOrganizeReportSchema,
      handler: async (_event, /** @type {{ rows: any[] }} */ payload) => {
        try {
          const rows = Array.isArray(payload?.rows) ? payload.rows : [];
          if (rows.length === 0) {
            return { success: false, error: 'There are no files to save.' };
          }
          const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
          const options = {
            title: 'Save organize results',
            defaultPath: defaultReportName(),
            filters: [{ name: 'CSV Files', extensions: ['csv'] }]
          };
          const { filePath, canceled } = win
            ? await dialog.showSaveDialog(win, options)
            : await dialog.showSaveDialog(options);
          if (canceled || !filePath) {
            return { success: false, canceled: true };
          }
          await safeWriteFile(filePath, toOrganizeReportCsv(rows));
          logger.info('[OrganizeReport] Saved organize results', { rowCount: rows.length });
          return { success: true, filePath, rowCount: rows.length };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error('[OrganizeReport] Could not save organize results', { error: message });
          return { success: false, error: message || 'Could not save the file' };
        }
      }
    })
  );
}

module.exports = {
  registerReportHandlers,
  exportOrganizeReportSchema,
  defaultReportName,
  MAX_REPORT_ROWS
};
