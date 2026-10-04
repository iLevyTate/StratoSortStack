// @ts-check
/**
 * Window Control IPC Handlers
 *
 * Handles window minimize, maximize, close operations for custom title bar.
 */
const path = require('path');
const { app } = require('electron');
const { IpcServiceContext, createFromLegacyParams } = require('./IpcServiceContext');
const { createHandler, safeHandle } = require('./ipcWrappers');
const { schemas } = require('./validationSchemas');
const { backupAndReplace } = require('../../shared/atomicFileOperations');
const { resolveThemeBackground, THEME_BACKGROUND_FILE } = require('../../shared/themeBackgrounds');

/**
 * @param {IpcServiceContext|Record<string, any>} servicesOrParams - Service context or legacy parameters
 */
function registerWindowIpc(servicesOrParams) {
  let container;
  if (servicesOrParams instanceof IpcServiceContext) {
    container = servicesOrParams;
  } else {
    container = createFromLegacyParams(servicesOrParams);
  }

  const { ipcMain, IPC_CHANNELS, logger } = container.core;
  const { getMainWindow } = container.electron;

  const context = 'Window';

  // Helper to get window safely
  const getWindow = () => {
    const win = getMainWindow();
    return win && !win.isDestroyed() ? win : null;
  };

  safeHandle(
    ipcMain,
    IPC_CHANNELS.WINDOW.MINIMIZE,
    createHandler({
      logger,
      context,
      handler: async () => {
        const win = getWindow();
        if (win) win.minimize();
        return true;
      }
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.WINDOW.TOGGLE_MAXIMIZE,
    createHandler({
      logger,
      context,
      handler: async () => {
        const win = getWindow();
        if (win) {
          if (win.isMaximized()) {
            win.unmaximize();
          } else {
            win.maximize();
          }
          return win.isMaximized();
        }
        return false;
      }
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.WINDOW.IS_MAXIMIZED,
    createHandler({
      logger,
      context,
      handler: async () => {
        const win = getWindow();
        return win ? win.isMaximized() : false;
      }
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.WINDOW.CLOSE,
    createHandler({
      logger,
      context,
      handler: async () => {
        const win = getWindow();
        if (win) win.close();
        return true;
      }
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.WINDOW.SET_THEME_BACKGROUND,
    createHandler({
      logger,
      context,
      schema: schemas?.themeName,
      handler: async (_event, theme) => {
        const background = resolveThemeBackground(theme);
        const win = getWindow();
        // Live: the native surface behind the HTML (resize gaps, GPU resets)
        // matches the renderer shell immediately.
        if (win) win.setBackgroundColor(background);
        // Durable: createWindow reads this at startup so the pre-HTML native
        // frame is already the right color on the NEXT launch (U-002).
        try {
          const themePath = path.join(app.getPath('userData'), THEME_BACKGROUND_FILE);
          await backupAndReplace(themePath, JSON.stringify({ theme }));
        } catch (error) {
          // Persistence is best-effort; the live window color already applied.
          logger.warn('[Window] Failed to persist theme background', {
            error: error?.message
          });
        }
        return true;
      }
    })
  );
}

module.exports = registerWindowIpc;
