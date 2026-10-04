// @ts-check
/**
 * Folder Operation Handlers
 *
 * Handlers for folder operations (open, delete).
 *
 * @module ipc/files/folderHandlers
 */

const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const { app } = require('electron');
const { createHandler, safeHandle, z } = require('../ipcWrappers');
const { createLogger } = require('../../../shared/logger');
const { validateFileOperationPath } = require('../../../shared/pathSanitization');
const {
  isNotFoundError,
  isPermissionError,
  ErrorCategory,
  getErrorCategory
} = require('../../../shared/errorClassifier');
const { isUNCPath } = require('../../../shared/crossPlatformUtils');
const { authorizeDestination } = require('./destinationPolicy');
const { isExecutableExtension } = require('../../../shared/securityConfig');

const logger = createLogger('IPC:Files:Folders');
const schemaFilePath = z ? z.string().min(1) : null;
const { IpcServiceContext, createFromLegacyParams } = require('../IpcServiceContext');

/**
 * Register folder operation IPC handlers
 *
 * @param {IpcServiceContext|Record<string, any>} servicesOrParams - Service context or legacy parameters
 */
function registerFolderHandlers(servicesOrParams) {
  let container;
  if (servicesOrParams instanceof IpcServiceContext) {
    container = servicesOrParams;
  } else {
    container = createFromLegacyParams(servicesOrParams);
  }

  const { ipcMain, IPC_CHANNELS } = container.core;
  const { shell, getMainWindow } = container.electron;

  // Create folder directly
  safeHandle(
    ipcMain,
    IPC_CHANNELS.FILES.CREATE_FOLDER_DIRECT,
    createHandler({
      logger,
      context: 'FolderOps',
      schema: schemaFilePath,
      handler: async (event, fullPath) => {
        try {
          if (!fullPath || typeof fullPath !== 'string') {
            return {
              success: false,
              error: 'Invalid folder path provided',
              errorCode: 'INVALID_PATH'
            };
          }

          // Reject relative paths up front. `path.resolve(relative)` would
          // otherwise silently mix in `process.cwd()` (the Electron
          // install directory on packaged builds, or wherever the app
          // was spawned from), letting a caller reach files outside the
          // allowed base paths if cwd happens to sit under one.
          if (!path.isAbsolute(fullPath)) {
            logger.warn('[FILE-OPS] Folder creation rejected - non-absolute path', {
              path: fullPath
            });
            return {
              success: false,
              error: 'Folder path must be absolute',
              errorCode: 'INVALID_PATH'
            };
          }

          const normalizedPath = path.resolve(fullPath);

          // Validate path is within allowed directories to prevent path traversal
          const allowedPaths = [
            os.homedir(),
            app.getPath('documents'),
            app.getPath('downloads'),
            app.getPath('desktop')
          ];

          const isUNC = isUNCPath(normalizedPath);

          const validation = await validateFileOperationPath(normalizedPath, {
            allowedBasePaths: isUNC ? null : allowedPaths,
            checkSymlinks: true,
            disallowUNC: false
          });

          if (!validation.valid) {
            logger.warn('[FILE-OPS] Folder creation blocked - path traversal attempt', {
              path: fullPath,
              normalized: normalizedPath,
              error: validation.error
            });
            return {
              success: false,
              error: validation.error || 'Path is outside allowed directories',
              errorCode: 'PATH_NOT_ALLOWED'
            };
          }

          // The allowlist above spans the whole home directory. The parent
          // the folder goes into is held to the destination policy as a
          // file would be: Documents and the trusted roots need no prompt, a
          // startup folder is refused, anywhere else is confirmed by the user.
          /** @type {string[]} */
          const knownRoots = [];
          try {
            knownRoots.push(app.getPath('documents'));
          } catch {
            // No Documents folder on this platform.
          }
          const parentDir = path.dirname(normalizedPath);
          const decision = await authorizeDestination(normalizedPath, {
            log: logger,
            getMainWindow,
            knownRoots,
            abortSignal: event?.abortSignal || null,
            promptCopy: {
              message: `Create the folder "${path.basename(normalizedPath)}" in ${parentDir}?`,
              detail:
                'This location is not one of your Smart Folders and was not chosen in a file dialog during this session. Allowing it lets StratoSort place files there until the app closes.'
            }
          });
          if (!decision.allowed) {
            logger.warn('[FILE-OPS] Folder creation refused by destination policy', {
              path: normalizedPath,
              reason: decision.reason
            });
            return {
              success: false,
              error: decision.error || 'Folder location was not approved',
              errorCode: decision.errorCode || 'DESTINATION_NOT_ALLOWED'
            };
          }

          // Check if folder already exists
          try {
            const stats = await fs.stat(normalizedPath);
            if (stats.isDirectory()) {
              return {
                success: true,
                message: 'Folder already exists',
                path: normalizedPath,
                alreadyExisted: true
              };
            }
            return {
              success: false,
              error: 'A file with this name already exists',
              errorCode: 'FILE_EXISTS'
            };
          } catch (statError) {
            // ENOENT means folder doesn't exist, which is expected
            if (statError.code !== 'ENOENT') {
              throw statError;
            }
          }

          // Create the folder recursively
          await fs.mkdir(normalizedPath, { recursive: true });
          logger.info('[FILE-OPS] Created folder:', normalizedPath);
          if (isUNC) {
            logger.info('[FILE-OPS] UNC folder created:', normalizedPath);
          }

          return {
            success: true,
            message: 'Folder created successfully',
            path: normalizedPath,
            alreadyExisted: false
          };
        } catch (error) {
          logger.error('[FILE-OPS] Error creating folder:', error);

          let userMessage = 'Failed to create folder';
          let errorCode = 'CREATE_FAILED';

          if (isPermissionError(error)) {
            errorCode = 'PERMISSION_DENIED';
            userMessage = 'Permission denied - cannot create folder here';
          } else if (getErrorCategory(error) === ErrorCategory.DISK_FULL) {
            errorCode = 'NO_SPACE';
            userMessage = 'Insufficient disk space';
          } else if (getErrorCategory(error) === ErrorCategory.PATH_TOO_LONG) {
            errorCode = 'NAME_TOO_LONG';
            userMessage = 'Folder path is too long';
          }

          return {
            success: false,
            error: userMessage,
            errorCode,
            details: error.message,
            systemError: error.code
          };
        }
      }
    })
  );

  // Open folder in file explorer
  safeHandle(
    ipcMain,
    IPC_CHANNELS.FILES.OPEN_FOLDER,
    createHandler({
      logger,
      context: 'FolderOps',
      schema: schemaFilePath,
      handler: async (event, folderPath) => {
        try {
          if (!folderPath || typeof folderPath !== 'string') {
            return {
              success: false,
              error: 'Invalid folder path provided',
              errorCode: 'INVALID_PATH'
            };
          }

          // See folder-create handler above for rationale: relative
          // paths must not silently resolve against process.cwd().
          if (!path.isAbsolute(folderPath)) {
            return {
              success: false,
              error: 'Folder path must be absolute',
              errorCode: 'INVALID_PATH'
            };
          }

          const normalizedPath = path.resolve(folderPath);

          // SECURITY: Validate path before any filesystem operations
          const validation = await validateFileOperationPath(normalizedPath, {
            checkSymlinks: true
          });
          if (!validation.valid) {
            logger.warn('[FILE-OPS] Folder open blocked - unsafe path', {
              path: folderPath,
              error: validation.error
            });
            return {
              success: false,
              error: validation.error || 'Path is not allowed',
              errorCode: 'PATH_NOT_ALLOWED'
            };
          }

          // A directory can be launchable: shell.openPath on a macOS .app
          // bundle (or a .pkg / .appimage directory) runs it. Check the name
          // and, for a symlink, the real target.
          let realFolderPath = normalizedPath;
          try {
            realFolderPath = await fs.realpath(normalizedPath);
          } catch {
            // Missing folder: the stat below reports it.
          }
          if (isExecutableExtension(normalizedPath) || isExecutableExtension(realFolderPath)) {
            logger.warn('[FILE-OPS] Refusing to shell-open a launchable bundle', {
              path: normalizedPath,
              target: realFolderPath
            });
            return {
              success: false,
              error:
                'This folder is an application bundle and cannot be opened from within the app. Reveal it in your file manager instead.',
              errorCode: 'EXECUTABLE_BLOCKED'
            };
          }

          try {
            const stats = await fs.stat(normalizedPath);
            if (!stats.isDirectory()) {
              return {
                success: false,
                error: 'Path is not a directory',
                errorCode: 'NOT_A_DIRECTORY'
              };
            }
          } catch (accessError) {
            return {
              success: false,
              error: 'Folder not found or inaccessible',
              errorCode: 'FOLDER_NOT_FOUND',
              details: accessError.message
            };
          }

          const openResult = await shell.openPath(normalizedPath);
          if (openResult) {
            logger.warn('[FILE-OPS] Shell openPath returned error:', openResult);
            return {
              success: false,
              error: openResult,
              errorCode: 'OPEN_FAILED'
            };
          }
          logger.info('[FILE-OPS] Opened folder:', normalizedPath);

          return {
            success: true,
            message: 'Folder opened successfully',
            openedPath: normalizedPath
          };
        } catch (error) {
          logger.error('[FILE-OPS] Error opening folder:', error);
          return {
            success: false,
            error: 'Failed to open folder',
            errorCode: 'OPEN_FAILED',
            details: error.message
          };
        }
      }
    })
  );

  // Delete empty folder
  safeHandle(
    ipcMain,
    IPC_CHANNELS.FILES.DELETE_FOLDER,
    createHandler({
      logger,
      context: 'FolderOps',
      schema: schemaFilePath,
      handler: async (event, fullPath) => {
        if (!fullPath || typeof fullPath !== 'string') {
          return {
            success: false,
            error: 'Invalid folder path provided',
            errorCode: 'INVALID_PATH'
          };
        }

        if (!path.isAbsolute(fullPath)) {
          return {
            success: false,
            error: 'Folder path must be absolute',
            errorCode: 'INVALID_PATH'
          };
        }

        try {
          const normalizedPath = path.resolve(fullPath);

          // SECURITY: Validate path before any filesystem operations
          const validation = await validateFileOperationPath(normalizedPath, {
            checkSymlinks: true
          });
          if (!validation.valid) {
            logger.warn('[FILE-OPS] Folder deletion blocked - unsafe path', {
              path: fullPath,
              error: validation.error
            });
            return {
              success: false,
              error: validation.error || 'Path is not allowed',
              errorCode: 'PATH_NOT_ALLOWED'
            };
          }

          try {
            const stats = await fs.stat(normalizedPath);
            if (!stats.isDirectory()) {
              return {
                success: false,
                error: 'Path is not a directory',
                code: 'NOT_DIRECTORY'
              };
            }
          } catch (statError) {
            if (isNotFoundError(statError)) {
              return {
                success: true,
                message: 'Folder already deleted or does not exist',
                existed: false
              };
            }
            throw statError;
          }

          const contents = await fs.readdir(normalizedPath);
          if (contents.length > 0) {
            return {
              success: false,
              error: `Directory not empty - contains ${contents.length} items`,
              code: 'NOT_EMPTY',
              itemCount: contents.length
            };
          }

          await fs.rmdir(normalizedPath);
          logger.info('[FILE-OPS] Deleted folder:', normalizedPath);

          return {
            success: true,
            path: normalizedPath,
            message: 'Folder deleted successfully'
          };
        } catch (error) {
          logger.error('[FILE-OPS] Error deleting folder:', error);

          let userMessage = 'Failed to delete folder';
          if (isPermissionError(error)) {
            userMessage = 'Permission denied - check folder permissions';
          } else if (getErrorCategory(error) === ErrorCategory.DIRECTORY_NOT_EMPTY) {
            userMessage = 'Directory not empty - contains files or subfolders';
          } else if (getErrorCategory(error) === ErrorCategory.FILE_IN_USE) {
            userMessage = 'Directory is in use by another process';
          }

          return {
            success: false,
            error: userMessage,
            details: error.message,
            code: error.code
          };
        }
      }
    })
  );
}

module.exports = { registerFolderHandlers };
