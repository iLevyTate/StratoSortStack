// @ts-check
/**
 * Shell Operation Handlers
 *
 * Simple file/folder shell operations (open, reveal).
 *
 * @module ipc/files/shellHandlers
 */

const fs = require('fs').promises;
const path = require('path');
const { createHandler, safeHandle, z } = require('../ipcWrappers');
const { createLogger } = require('../../../shared/logger');
const { validateFileOperationPath } = require('../../../shared/pathSanitization');
const { isExecutableExtension } = require('../../../shared/securityConfig');

const logger = createLogger('IPC:Files:Shell');

const EXECUTABLE_BLOCKED_RESULT = Object.freeze({
  success: false,
  error:
    'Executable files cannot be opened from within the app. Reveal the file in your file manager if you need to run it.',
  errorCode: 'EXECUTABLE_BLOCKED'
});
const schemaFilePath = z ? z.string().min(1) : null;
const { IpcServiceContext, createFromLegacyParams } = require('../IpcServiceContext');

/**
 * Register shell operation IPC handlers
 *
 * @param {IpcServiceContext|Record<string, any>} servicesOrParams - Service context or legacy parameters
 */
function registerShellHandlers(servicesOrParams) {
  let container;
  if (servicesOrParams instanceof IpcServiceContext) {
    container = servicesOrParams;
  } else {
    container = createFromLegacyParams(servicesOrParams);
  }

  const { ipcMain, IPC_CHANNELS } = container.core;
  const { shell } = container.electron;

  // Open file with default application
  safeHandle(
    ipcMain,
    IPC_CHANNELS.FILES.OPEN_FILE,
    createHandler({
      logger,
      context: 'ShellOps',
      schema: schemaFilePath,
      handler: async (event, filePath) => {
        try {
          if (!filePath || typeof filePath !== 'string') {
            return {
              success: false,
              error: 'Invalid file path provided',
              errorCode: 'INVALID_PATH'
            };
          }

          const validation = await validateFileOperationPath(filePath, {
            checkSymlinks: true
          });

          if (!validation.valid) {
            logger.warn('[FILE-OPS] Open file path validation failed', {
              filePath,
              error: validation.error
            });
            return {
              success: false,
              error: validation.error,
              errorCode: 'INVALID_PATH'
            };
          }

          // Executable denylist: even with a valid sanitized path, never hand
          // the OS shell a binary/script to launch. The user should explicitly
          // reveal-in-folder and double-click if they really mean to run it.
          if (isExecutableExtension(validation.normalizedPath)) {
            logger.warn('[FILE-OPS] Refusing to shell-open executable file', {
              filePath: validation.normalizedPath
            });
            return { ...EXECUTABLE_BLOCKED_RESULT };
          }

          // The check above saw the link name. Resolve the real path so a
          // symlink named report.pdf that points at evil.exe is caught too,
          // and refuse an extensionless file carrying an execute bit on
          // POSIX, where `open` and xdg-open run it rather than view it.
          let realPath = validation.normalizedPath;
          try {
            realPath = await fs.realpath(validation.normalizedPath);
          } catch {
            // Missing file: the access check below reports it.
          }
          if (realPath !== validation.normalizedPath && isExecutableExtension(realPath)) {
            logger.warn('[FILE-OPS] Refusing to shell-open a link to an executable', {
              filePath: validation.normalizedPath,
              target: realPath
            });
            return { ...EXECUTABLE_BLOCKED_RESULT };
          }
          if (process.platform !== 'win32' && path.extname(realPath) === '') {
            try {
              const stats = await fs.stat(realPath);
              if (stats.isFile() && (stats.mode & 0o111) !== 0) {
                logger.warn('[FILE-OPS] Refusing to shell-open an executable without extension', {
                  filePath: realPath
                });
                return { ...EXECUTABLE_BLOCKED_RESULT };
              }
            } catch {
              // Missing file: the access check below reports it.
            }
          }

          // Verify file exists before trying to open
          try {
            await fs.access(validation.normalizedPath);
          } catch {
            return {
              success: false,
              error: 'File not found or inaccessible',
              errorCode: 'FILE_NOT_FOUND'
            };
          }

          const result = await shell.openPath(validation.normalizedPath);
          // shell.openPath returns empty string on success, error message otherwise
          if (result) {
            logger.warn('[FILE-OPS] Shell openPath returned error:', result);
            return { success: false, error: result };
          }

          logger.info('[FILE-OPS] Opened file:', validation.normalizedPath);
          return { success: true };
        } catch (error) {
          logger.error('[FILE-OPS] Error opening file:', error);
          return { success: false, error: error.message };
        }
      }
    })
  );

  // Reveal file in file explorer
  safeHandle(
    ipcMain,
    IPC_CHANNELS.FILES.REVEAL_FILE,
    createHandler({
      logger,
      context: 'ShellOps',
      schema: schemaFilePath,
      handler: async (event, filePath) => {
        try {
          if (!filePath || typeof filePath !== 'string') {
            return {
              success: false,
              error: 'Invalid file path provided',
              errorCode: 'INVALID_PATH'
            };
          }

          const validation = await validateFileOperationPath(filePath, {
            checkSymlinks: true
          });

          if (!validation.valid) {
            logger.warn('[FILE-OPS] Reveal file path validation failed', {
              filePath,
              error: validation.error
            });
            return {
              success: false,
              error: validation.error,
              errorCode: 'INVALID_PATH'
            };
          }

          // Verify file exists before trying to reveal
          try {
            await fs.access(validation.normalizedPath);
          } catch {
            return {
              success: false,
              error: 'File not found or inaccessible',
              errorCode: 'FILE_NOT_FOUND'
            };
          }

          shell.showItemInFolder(validation.normalizedPath);
          logger.info('[FILE-OPS] Revealed file in folder:', validation.normalizedPath);
          return { success: true };
        } catch (error) {
          logger.error('[FILE-OPS] Error revealing file:', error);
          return { success: false, error: error.message };
        }
      }
    })
  );
}

module.exports = { registerShellHandlers };
