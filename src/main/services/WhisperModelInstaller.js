// @ts-check
/**
 * WhisperModelInstaller
 *
 * In-process installation path for the Whisper GGML model (and optional
 * Silero VAD companion). Reuses the audited supply-chain primitives from
 * `scripts/setup-whisper-model.js` (HTTPS-only, Hugging Face host
 * allowlist, LFS-pointer-derived sha256, partial+rename) but runs inside
 * the main process so production Electron users — who have no shell
 * access to the packaged app — can install via a UI button instead of
 * being told to "run npm run setup:whisper-model" in a banner that they
 * cannot action.
 *
 * The CLI script is intentionally left untouched: dev workflows still
 * use it, and changing it carries audit risk we don't need here. This
 * module is a thin orchestrator over the script's exported building
 * blocks (`setupOneModel`, validators, defaults), with three deltas:
 *   1. Resolves the install dir via `app.getPath('userData')` rather
 *      than the script's manual XDG/APPDATA logic. The two paths agree
 *      in production but the Electron API is the source of truth in our
 *      runtime.
 *   2. Always runs in `--auto` mode (no stdin prompts).
 *   3. Replaces console.log progress with a structured `onProgress`
 *      callback so the renderer can drive a progress UI later.
 *
 * Concurrency: a process-wide promise dedupes overlapping install
 * requests. If two banner clicks land within the install window, the
 * second awaits the first's result instead of starting a duplicate
 * download.
 */

const path = require('path');
const fs = require('fs').promises;
const { app } = require('electron');
const { createLogger } = require('../../shared/logger');
const {
  setupOneModel,
  fetchExpectedMetadata,
  ensureModelPresent,
  SUPPORTED_MODEL_PATTERN,
  DEFAULT_MODEL,
  DEFAULT_VAD_MODEL
} = require('../../../scripts/setup-whisper-model');

const logger = createLogger('WhisperModelInstaller');

const WHISPER_SUBDIR = 'whisper';

/** @type {Promise<any>|null} */
let _activeInstall = null;

/**
 * Resolve the on-disk directory the WhisperService reads models from.
 * Mirrors `WhisperService._resolveModelPath` so an install lands where
 * the service will look.
 */
function getInstallDir() {
  return path.join(app.getPath('userData'), 'models', WHISPER_SUBDIR);
}

/**
 * Check whether the requested model files are already present and pass
 * checksum verification. Returns a structured result the renderer can
 * surface without a full install attempt.
 */
/** @param {{ includeVad?: boolean }} [opts] */
async function checkInstallStatus({ includeVad = false } = {}) {
  const installDir = getInstallDir();
  /** @type {Record<string, any>} */
  const result = {
    installDir,
    whisper: { filename: DEFAULT_MODEL, present: false },
    vad: includeVad ? { filename: DEFAULT_VAD_MODEL, present: false } : null
  };
  try {
    const expected = await fetchExpectedMetadata(DEFAULT_MODEL);
    const status = await ensureModelPresent(path.join(installDir, DEFAULT_MODEL), expected);
    result.whisper.present = status.present;
    result.whisper.expectedBytes = expected.size;
  } catch (error) {
    logger.debug('checkInstallStatus: whisper metadata fetch failed', { error: error?.message });
    // Network-down case is non-fatal for status checks — treat as unknown.
    result.whisper.unknown = true;
  }
  if (includeVad) {
    try {
      const expected = await fetchExpectedMetadata(DEFAULT_VAD_MODEL);
      const status = await ensureModelPresent(path.join(installDir, DEFAULT_VAD_MODEL), expected);
      result.vad.present = status.present;
      result.vad.expectedBytes = expected.size;
    } catch (error) {
      logger.debug('checkInstallStatus: vad metadata fetch failed', { error: error?.message });
      result.vad.unknown = true;
    }
  }
  return result;
}

/**
 * Install the Whisper model (and optionally the Silero VAD model) into
 * userData/models/whisper. Idempotent — if the file already exists with
 * the right size+sha, returns `outcome: 'present'` without redownloading.
 *
 * @param {object} [options]
 * @param {string} [options.modelFilename] - GGML filename. Defaults to
 *   `ggml-base.en.bin`. Validated against SUPPORTED_MODEL_PATTERN.
 * @param {boolean} [options.installVad] - Also install the Silero
 *   VAD companion. The VAD path is opt-in because the binding only
 *   loads it when the service is told to enable VAD.
 * @param {string} [options.vadFilename] - Override the VAD filename.
 * @param {(...args: any[]) => any} [options.onProgress] - `(stage, payload) => void`.
 *   Stages: `'whisper:start'`, `'whisper:done'`, `'vad:start'`,
 *   `'vad:done'`. Errors are reported via reject, not onProgress.
 * @returns {Promise<{success: boolean, installDir: string, whisper: {outcome: string, filename: string}, vad?: {outcome: string, filename: string}}>}
 */
async function installWhisperModel(options = {}) {
  if (_activeInstall) {
    logger.info('Install already in flight; awaiting existing promise');
    return _activeInstall;
  }
  _activeInstall = (async () => {
    try {
      return await _installInternal(options);
    } finally {
      _activeInstall = null;
    }
  })();
  return _activeInstall;
}

/**
 * @param {{ modelFilename?: string, installVad?: boolean, vadFilename?: string, onProgress?: (...args: any[]) => any }} [opts]
 */
async function _installInternal({
  modelFilename = DEFAULT_MODEL,
  installVad = false,
  vadFilename = DEFAULT_VAD_MODEL,
  onProgress
} = {}) {
  const cleanWhisper = String(modelFilename || '').trim();
  if (!SUPPORTED_MODEL_PATTERN.test(cleanWhisper)) {
    throw new Error(
      `Invalid whisper model filename "${cleanWhisper}". Expected pattern: ggml-<name>.bin`
    );
  }
  const cleanVad = installVad ? String(vadFilename || '').trim() : null;
  if (cleanVad && !SUPPORTED_MODEL_PATTERN.test(cleanVad)) {
    throw new Error(`Invalid VAD model filename "${cleanVad}". Expected pattern: ggml-<name>.bin`);
  }

  const installDir = getInstallDir();
  await fs.mkdir(installDir, { recursive: true });
  logger.info('Whisper install starting', {
    installDir,
    modelFilename: cleanWhisper,
    installVad,
    vadFilename: cleanVad || null
  });

  try {
    onProgress?.('whisper:start', { filename: cleanWhisper });
    // setupOneModel runs in CLI mode by default (interactive prompt). We
    // pass `auto: true` so it proceeds without stdin and without TTY
    // dependencies. The script writes status to console.log; that lands
    // in the main process log via the global console capture.
    const whisperOutcome = await setupOneModel(
      cleanWhisper,
      installDir,
      { auto: true, check: false },
      'whisper'
    );
    onProgress?.('whisper:done', { filename: cleanWhisper, outcome: whisperOutcome });

    let vadResult = null;
    if (cleanVad) {
      onProgress?.('vad:start', { filename: cleanVad });
      const vadOutcome = await setupOneModel(
        cleanVad,
        installDir,
        { auto: true, check: false },
        'vad'
      );
      onProgress?.('vad:done', { filename: cleanVad, outcome: vadOutcome });
      vadResult = { outcome: vadOutcome, filename: cleanVad };
    }

    logger.info('Whisper install succeeded', {
      whisperOutcome,
      vadOutcome: vadResult?.outcome || null
    });

    return {
      success: true,
      installDir,
      whisper: { outcome: whisperOutcome, filename: cleanWhisper },
      ...(vadResult ? { vad: vadResult } : {})
    };
  } catch (error) {
    logger.error('Whisper install failed', { message: error?.message });
    throw error;
  }
}

module.exports = {
  getInstallDir,
  checkInstallStatus,
  installWhisperModel,
  WHISPER_SUBDIR,
  DEFAULT_WHISPER_MODEL: DEFAULT_MODEL,
  DEFAULT_VAD_MODEL,
  // Test exports
  _resetActiveInstallForTesting: () => {
    _activeInstall = null;
  }
};
