// @ts-check
/**
 * Windows Jump List Module
 *
 * Handles Windows Jump List integration and command-line task handling.
 * Extracted from simple-main.js for better maintainability.
 *
 * @module core/jumpList
 */

const { app, BrowserWindow, shell } = require('electron');
const { isWindows } = require('../../shared/platformUtils');
const { IPC_EVENTS } = require('../../shared/constants');
const { createLogger } = require('../../shared/logger');
const { safeSend } = require('../ipc/ipcWrappers');

const logger = createLogger('JumpList');
/**
 * Handle command-line tasks from Jump List
 *
 * `args` may come from a second-instance launch — i.e. an arbitrary user
 * (or attacker) shortcut whose target embedded the StratoSort exe with
 * extra flags. Treat the input as untrusted and only honor a strict
 * allowlist of flag tokens. Any other value is ignored. We do NOT pass
 * positional values from `args` into shell APIs; both supported flags
 * are no-arg and the side effects use trusted local state (`app.getPath`,
 * a static hint string).
 *
 * @param {string[]} args - Command line arguments
 */
const ALLOWED_JUMP_LIST_FLAGS = Object.freeze(['--open-documents', '--analyze-folder']);

function handleCommandLineTasks(/** @type {any} */ args) {
  try {
    if (!Array.isArray(args)) return;
    // Reduce the input to a small set of known flag tokens. Anything else
    // (positional arguments, other flags, malformed strings) is dropped
    // before any side effect runs.
    const present = new Set(
      args.filter((arg) => typeof arg === 'string' && ALLOWED_JUMP_LIST_FLAGS.includes(arg))
    );

    if (present.has('--open-documents')) {
      try {
        const docs = app.getPath('documents');
        shell.openPath(docs);
        logger.info('[JUMP-LIST] Opened documents folder');
      } catch (error) {
        logger.error('[JUMP-LIST] Failed to open documents folder:', error);
      }
    }

    if (present.has('--analyze-folder')) {
      // Bring window to front and trigger select directory hint
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.focus();
        try {
          if (!win.isDestroyed()) {
            safeSend(win.webContents, IPC_EVENTS.OPERATION_PROGRESS, {
              type: 'hint',
              message: 'Use Select Directory to analyze a folder'
            });
            logger.info('[JUMP-LIST] Sent analyze folder hint to renderer');
          }
        } catch (error) {
          logger.error('[JUMP-LIST] Failed to send hint message:', error);
        }
      }
    }
  } catch (error) {
    logger.error('[JUMP-LIST] Failed to handle command-line tasks:', error);
  }
}

/**
 * The given command-line arguments without Jump List task flags. Used for the
 * relaunch after shutdown: app.relaunch() replays this instance's own argv by
 * default, so an instance started from a Jump List task would run the task
 * again in the new instance.
 * @param {string[]} args
 * @returns {string[]}
 */
function withoutJumpListTasks(args) {
  return (Array.isArray(args) ? args : []).filter((arg) => !ALLOWED_JUMP_LIST_FLAGS.includes(arg));
}

/**
 * Setup Windows Jump List tasks
 */
function setupWindowsJumpList() {
  if (!isWindows) {
    logger.debug('[JUMP-LIST] Skipping Jump List setup (not Windows)');
    return;
  }

  try {
    if (app.isPackaged) {
      app.setAppUserModelId('com.stratosort.app');
    } else {
      app.setAppUserModelId(process.execPath);
    }
    app.setJumpList([
      {
        type: 'tasks',
        items: [
          {
            type: 'task',
            title: 'Analyze Folder…',
            program: process.execPath,
            args: '--analyze-folder',
            iconPath: process.execPath,
            iconIndex: 0
          },
          {
            type: 'task',
            title: 'Open Documents Folder',
            program: process.execPath,
            args: '--open-documents',
            iconPath: process.execPath,
            iconIndex: 0
          }
        ]
      }
    ]);
    logger.info('[JUMP-LIST] Windows Jump List configured');
  } catch (error) {
    logger.error('[JUMP-LIST] Failed to set Windows Jump List:', error);
  }
}

/**
 * Initialize Jump List functionality
 * - Handles command-line tasks from previous invocation
 * - Sets up Jump List for future invocations
 */
function initializeJumpList() {
  const args = process.argv.slice(1);
  handleCommandLineTasks(args);
  setupWindowsJumpList();
}

module.exports = {
  initializeJumpList,
  handleCommandLineTasks,
  setupWindowsJumpList,
  withoutJumpListTasks
};
