// @ts-check
/**
 * Whisper IPC Handlers
 *
 * Lets the renderer trigger an in-process install of the Whisper GGML
 * model (and optionally the Silero VAD companion). This is the
 * production path that replaces the "run npm run setup:whisper-model"
 * banner CTA — packaged Electron users have no shell, so a UI button
 * that calls this handler is the only way to recover from a missing
 * model in the field.
 *
 * @module ipc/whisper
 */

const { IpcServiceContext, createFromLegacyParams } = require('./IpcServiceContext');
const { createHandler, safeHandle, z } = require('./ipcWrappers');
const { installWhisperModel, checkInstallStatus } = require('../services/WhisperModelInstaller');

/**
 * @param {*} error
 * @returns {import('../../shared/types/ipc').IpcFailure}
 */
function _errorEnvelope(error) {
  return {
    success: false,
    error: error?.message || 'Whisper install operation failed',
    code: (error && typeof error.code === 'string' && error.code) || 'WHISPER_INSTALL_FAILED'
  };
}

/**
 * @param {IpcServiceContext|Record<string, any>} servicesOrParams - Service context or legacy parameters
 */
function registerWhisperIpc(servicesOrParams) {
  const container =
    servicesOrParams instanceof IpcServiceContext
      ? servicesOrParams
      : createFromLegacyParams(servicesOrParams);
  const { ipcMain, IPC_CHANNELS, logger } = container.core;

  const context = 'Whisper';
  const schemaVoid = z ? z.void() : null;
  const installSchema = z
    ? z
        .object({
          installVad: z.boolean().optional(),
          modelFilename: z.string().min(1).max(120).optional(),
          vadFilename: z.string().min(1).max(120).optional()
        })
        .strict()
        .optional()
    : null;

  // Status check — used by the Settings panel and DegradedStateBanner to
  // know whether the install button should read "Install" or "Reinstall".
  // Best-effort: a network blip during the LFS pointer fetch surfaces as
  // `unknown: true` rather than throwing — the install handler does the
  // authoritative check anyway.
  safeHandle(
    ipcMain,
    IPC_CHANNELS.WHISPER.GET_INSTALL_STATUS,
    createHandler({
      logger,
      context,
      schema: schemaVoid,
      handler: async () => {
        try {
          const status = await checkInstallStatus({ includeVad: true });
          return { success: true, ...status };
        } catch (error) {
          logger.warn('[IPC:Whisper] GET_INSTALL_STATUS failed', { error: error?.message });
          return _errorEnvelope(error);
        }
      }
    })
  );

  // Trigger an in-process install. Idempotent and dedup'd inside
  // `installWhisperModel` — overlapping calls share the same promise.
  // Synchronous wrt the renderer for now (no streaming progress events
  // yet); a future iteration can lift onProgress into IPC_EVENTS once
  // the download UX needs a progress bar.
  safeHandle(
    ipcMain,
    IPC_CHANNELS.WHISPER.INSTALL_MODEL,
    createHandler({
      logger,
      context,
      schema: installSchema,
      handler: async (_event, payload = {}) => {
        try {
          const result = await installWhisperModel({
            installVad: !!payload?.installVad,
            ...(payload?.modelFilename ? { modelFilename: payload.modelFilename } : {}),
            ...(payload?.vadFilename ? { vadFilename: payload.vadFilename } : {})
          });
          // After a successful install, attempt to clear the
          // whisper-unavailable degraded flag — the next transcribe call
          // would clear it anyway, but doing it here removes the
          // "install successful but banner still showing" UX wart.
          try {
            const { getInstance } = require('../services/DegradedStateTracker');
            getInstance().clear('whisper.unavailable');
          } catch {
            /* tracker is best-effort */
          }
          return result;
        } catch (error) {
          logger.error('[IPC:Whisper] INSTALL_MODEL failed', { error: error?.message });
          return _errorEnvelope(error);
        }
      }
    })
  );
}

module.exports = registerWhisperIpc;
module.exports.registerWhisperIpc = registerWhisperIpc;
