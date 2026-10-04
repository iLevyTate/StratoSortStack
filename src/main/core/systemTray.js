// @ts-check
/**
 * System Tray
 *
 * System tray integration with quick actions.
 * Extracted from simple-main.js for better maintainability.
 *
 * @module core/systemTray
 */

const { app, BrowserWindow, Menu, Tray, nativeImage, globalShortcut, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { isWindows, isMacOS } = require('../../shared/platformUtils');
const { IPC_EVENTS } = require('../../shared/constants');
const { createLogger } = require('../../shared/logger');
const { safeSend } = require('../ipc/ipcWrappers');
const { getAppRoot } = require('../utils/bundledResourcePaths');

const logger = createLogger('Tray');

function _getAppRoot() {
  return getAppRoot(app);
}

function _getAssetPath(/** @type {string[]} */ ...pathSegments) {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(_getAppRoot(), 'assets');
  return path.join(base, ...pathSegments);
}

function getAssetPath(/** @type {string[]} */ ...pathSegments) {
  const primary = _getAssetPath(...pathSegments);
  if (app.isPackaged || fs.existsSync(primary)) {
    return primary;
  }
  // Dev fallbacks when app.getAppPath() points elsewhere. Prefer dist/assets because
  // local dev often copies generated icons there.
  const roots = Array.from(
    new Set([
      path.join(_getAppRoot(), 'dist', 'assets'),
      path.join(_getAppRoot(), 'assets'),
      path.join(process.cwd(), 'dist', 'assets'),
      path.join(process.cwd(), 'assets'),
      path.join(__dirname, '..', 'assets'),
      path.join(__dirname, '..', '..', 'assets')
    ])
  );
  for (const root of roots) {
    const candidate = path.join(root, ...pathSegments);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return primary;
}

/** @type {any} */
let tray = null;
/** @type {any} */
let trayConfig = {
  getDownloadWatcher: null,
  getSettingsService: null,
  handleSettingsChanged: null,
  createWindow: null,
  setIsQuitting: null
};

// Global shortcut for semantic search
const SEARCH_SHORTCUT = isWindows ? 'Ctrl+Shift+F' : 'Cmd+Shift+F';

/**
 * Initialize tray configuration
 * @param {any} config - Configuration object
 */
function initializeTrayConfig(config) {
  trayConfig = { ...trayConfig, ...config };
}

/**
 * Create the system tray
 */
function createSystemTray() {
  if (tray) return; // Prevent creating multiple tray icons

  try {
    const iconCandidates = isWindows
      ? ['icons/win/icon.ico', 'icons/png/32x32.png', 'icons/png/24x24.png']
      : isMacOS
        ? ['icons/png/24x24.png', 'icons/png/16x16.png']
        : ['icons/png/16x16.png', 'icons/png/24x24.png'];
    const iconPath =
      iconCandidates
        .map((candidate) => getAssetPath(...candidate.split('/')))
        .find((candidatePath) => fs.existsSync(candidatePath)) ||
      getAssetPath(...iconCandidates[0].split('/'));

    const trayIcon = nativeImage.createFromPath(iconPath);
    if (isMacOS) {
      trayIcon.setTemplateImage(true);
    }

    tray = new Tray(trayIcon);
    tray.setToolTip('StratoSort');

    // Single click on tray icon restores the window (except on macOS where it's context menu by default)
    if (!isMacOS) {
      tray.on('click', async () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        } else if (trayConfig.createWindow) {
          await trayConfig.createWindow();
        }
      });
    }

    updateTrayMenu();
  } catch (e) {
    logger.warn('[TRAY] initialization failed', e);
  }
}

/**
 * Open or show the main window and trigger semantic search
 */
async function openSemanticSearch() {
  let win = BrowserWindow.getAllWindows()[0];

  if (!win) {
    // Create window if it doesn't exist
    // before trying to use the window reference
    if (trayConfig.createWindow) {
      await trayConfig.createWindow();
      win = BrowserWindow.getAllWindows()[0];
    }
  }

  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();

    // Send message to renderer to open semantic search
    // Small delay to ensure window is ready
    const searchTimerId = setTimeout(() => {
      if (!win.isDestroyed()) {
        safeSend(win.webContents, IPC_EVENTS.OPEN_SEMANTIC_SEARCH);
      }
    }, 100);
    win.once('closed', () => clearTimeout(searchTimerId));
  }
}

/**
 * Register global keyboard shortcut for semantic search
 */
function registerGlobalShortcut() {
  try {
    const success = globalShortcut.register(SEARCH_SHORTCUT, () => {
      logger.info(`[TRAY] Global shortcut ${SEARCH_SHORTCUT} triggered`);
      openSemanticSearch();
    });

    if (success) {
      logger.info(`[TRAY] Registered global shortcut: ${SEARCH_SHORTCUT}`);
      // Use a dedicated flag instead of listenerCount (which includes unrelated listeners).
      const rgs = /** @type {any} */ (registerGlobalShortcut);
      if (!rgs._willQuitRegistered) {
        app.on('will-quit', unregisterGlobalShortcuts);
        rgs._willQuitRegistered = true;
      }
    } else {
      logger.warn(`[TRAY] Failed to register global shortcut: ${SEARCH_SHORTCUT}`);
    }
  } catch (error) {
    logger.warn('[TRAY] Error registering global shortcut:', error.message);
  }
}

/**
 * Unregister global shortcuts
 */
function unregisterGlobalShortcuts() {
  try {
    globalShortcut.unregisterAll();
    logger.info('[TRAY] Unregistered all global shortcuts');
  } catch (error) {
    logger.warn('[TRAY] Error unregistering shortcuts:', error.message);
  }
}

/**
 * Open the StratoSort logs folder from tray menu.
 */
async function openLogsFolder() {
  const logsDir = path.join(app.getPath('userData'), 'logs');
  try {
    await fs.promises.mkdir(logsDir, { recursive: true });
  } catch (error) {
    logger.warn('[TRAY] Failed to ensure logs directory exists:', error?.message);
  }

  try {
    const result = await shell.openPath(logsDir);
    if (typeof result === 'string' && result.length > 0) {
      logger.warn('[TRAY] Failed to open logs folder:', { logsDir, error: result });
      return;
    }
    logger.info('[TRAY] Opened logs folder:', logsDir);
  } catch (error) {
    logger.warn('[TRAY] Error opening logs folder:', error?.message);
  }
}

/**
 * Update the tray context menu
 */
function updateTrayMenu() {
  if (!tray) return;

  const downloadWatcher = trayConfig.getDownloadWatcher?.();

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open StratoSort',
      click: async () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        } else if (trayConfig.createWindow) {
          await trayConfig.createWindow();
        }
      }
    },
    { type: 'separator' },
    {
      label: `Semantic Search (${SEARCH_SHORTCUT})`,
      click: openSemanticSearch
    },
    { type: 'separator' },
    {
      label: 'Open Logs Folder',
      click: openLogsFolder
    },
    { type: 'separator' },
    {
      label: downloadWatcher ? 'Pause Auto-Sort' : 'Resume Auto-Sort',
      click: async () => {
        const enable = !downloadWatcher;
        try {
          const settingsService = trayConfig.getSettingsService?.();
          if (settingsService) {
            const saveResult = await settingsService.save({
              autoOrganize: enable
            });
            const normalizedSettings =
              saveResult &&
              typeof saveResult === 'object' &&
              saveResult.settings &&
              typeof saveResult.settings === 'object'
                ? saveResult.settings
                : saveResult && typeof saveResult === 'object'
                  ? saveResult
                  : null;
            trayConfig.handleSettingsChanged?.(
              normalizedSettings || {
                autoOrganize: enable
              }
            );
          } else {
            trayConfig.handleSettingsChanged?.({ autoOrganize: enable });
          }
        } catch (err) {
          logger.warn('[TRAY] Failed to toggle auto-sort:', err.message);
        }
        updateTrayMenu();
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        trayConfig.setIsQuitting?.(true);
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

/**
 * Destroy the system tray
 */
function destroyTray() {
  if (tray) {
    try {
      tray.destroy();
      tray = null;
      logger.info('[CLEANUP] System tray destroyed');
    } catch (error) {
      logger.error('[CLEANUP] Failed to destroy tray:', error);
    }
  }
}

/**
 * Get the tray instance
 * @returns {Tray|null}
 */
function getTray() {
  return tray;
}

module.exports = {
  initializeTrayConfig,
  createSystemTray,
  updateTrayMenu,
  destroyTray,
  getTray,
  registerGlobalShortcut,
  unregisterGlobalShortcuts,
  openSemanticSearch,
  SEARCH_SHORTCUT
};
