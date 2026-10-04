// @ts-check
import { requireElectronAPI } from './electronApi';

/**
 * WhisperIpc - in-process whisper model install operations.
 *
 * Backed by `WhisperModelInstaller` in the main process. Used by the
 * Settings panel and the DegradedStateBanner action button to recover
 * from a missing whisper model in production builds (where there's no
 * shell access to run `npm run setup:whisper-model`).
 */
export const whisperIpc = {
  /**
   * Probe whether the default whisper + VAD models are present and
   * checksum-verified. Returns `{ success, installDir, whisper, vad }`.
   */
  getInstallStatus() {
    return requireElectronAPI().whisper.getInstallStatus();
  },

  /**
   * Trigger an in-process install of the whisper model (and optionally
   * the Silero VAD companion). Resolves once the download completes
   * and the file passes sha256 verification. Idempotent — overlapping
   * calls are dedup'd in the main process.
   *
   * @param {{ installVad?: boolean, modelFilename?: string, vadFilename?: string }} [options]
   *   - installVad: also install the Silero VAD model;
   *     modelFilename: override the whisper GGML filename;
   *     vadFilename: override the VAD GGML filename.
   */
  installModel(options) {
    return requireElectronAPI().whisper.installModel(options);
  }
};
