// @ts-check
/**
 * Commercial license IPC handlers.
 *
 * Thin bridge over LicenseService (src/main/services/LicenseService.js).
 * Verification is fully offline; these handlers never touch the network.
 */
const { IpcServiceContext, createFromLegacyParams } = require('./IpcServiceContext');
const { createHandler, safeHandle } = require('./ipcWrappers');
const { schemas } = require('./validationSchemas');

/**
 * @param {IpcServiceContext|Record<string, any>} servicesOrParams - Service context or legacy parameters
 */
function registerLicenseIpc(servicesOrParams) {
  let container;
  if (servicesOrParams instanceof IpcServiceContext) {
    container = servicesOrParams;
  } else {
    container = createFromLegacyParams(servicesOrParams);
  }

  const { ipcMain, IPC_CHANNELS, logger } = container.core;
  const context = 'License';

  const getService = () => container.license?.licenseService || null;

  safeHandle(
    ipcMain,
    IPC_CHANNELS.LICENSE.GET_STATUS,
    createHandler({
      logger,
      context,
      schema: schemas?.licenseStatus,
      handler: async () => {
        const service = getService();
        if (!service) return { success: false, error: 'License service unavailable' };
        return { success: true, snapshot: service.getSnapshot() };
      }
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.LICENSE.ACTIVATE,
    createHandler({
      logger,
      context,
      schema: schemas?.licenseActivate,
      handler: async (_event, payload) => {
        const service = getService();
        if (!service) return { success: false, error: 'License service unavailable' };
        return service.activate(payload?.key);
      }
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.LICENSE.DEACTIVATE,
    createHandler({
      logger,
      context,
      schema: schemas?.licenseDeactivate,
      handler: async () => {
        const service = getService();
        if (!service) return { success: false, error: 'License service unavailable' };
        return service.deactivate();
      }
    })
  );
}

module.exports = registerLicenseIpc;
