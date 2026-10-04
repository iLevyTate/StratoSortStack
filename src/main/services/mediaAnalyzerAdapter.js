// @ts-check
/**
 * MediaAnalyzerAdapter — wraps the audio/video pipeline with graceful
 * "Whisper not installed" handling.
 *
 * The media pipeline (Whisper transcription + keyframe vision) requires
 * the user to have downloaded the Whisper model. When the model is
 * missing, this adapter returns a normalized "skipped" result instead of
 * throwing, so a batch analysis containing media files completes
 * successfully and the UI can show the user how to install Whisper.
 */
const path = require('path');
const { ERROR_CODES } = require('../../shared/errorCodes');
const { createLogger } = require('../../shared/logger');
const { analyzeMediaFile, classifyMediaFile } = require('../analysis/mediaAnalysis');
const { normalizeAnalysisResult } = require('../analysis/utils');

const logger = createLogger('MediaAnalyzerAdapter');

/**
 * @param {string} filePath
 * @returns {any}
 */
function buildSkipResult(filePath) {
  const kind = classifyMediaFile(filePath) || 'audio';
  const baseName = path.basename(filePath, path.extname(filePath));
  const normalized = normalizeAnalysisResult(
    {
      category: kind === 'video' ? 'video' : 'audio',
      keywords: [kind, 'whisper-not-installed'],
      keyEntities: [],
      confidence: 0,
      suggestedName: baseName,
      extractionMethod: 'media-skipped-no-whisper',
      contentLength: 0,
      type: kind
    },
    {}
  );
  return {
    ...normalized,
    purpose: 'Media analysis skipped: Whisper model not installed.',
    mediaKind: kind,
    transcript: '',
    transcriptSegments: [],
    durationSeconds: 0,
    detectedLanguage: null,
    keyframes: [],
    keyframeWorkspace: null,
    multimodalText: null,
    _skipped: true
  };
}

function isWhisperMissingError(/** @type {any} */ err) {
  if (!err) return false;
  if (err.code === ERROR_CODES.LLAMA_MODEL_NOT_FOUND) return true;
  if (typeof err.message === 'string' && /whisper.+model not found/i.test(err.message)) {
    return true;
  }
  return false;
}

// Best-effort bridge from the dispatcher's `isCancelled` callback to an
// AbortSignal that analyzeMediaFile understands. Polls every
// CANCEL_POLL_INTERVAL_MS. Returns `{signal, dispose}` so the caller can
// clean up the interval on the SUCCESS path too — the abort listener only
// fires when the user actually cancels, so without an explicit dispose()
// every analyzed file would leak a polling closure (50ms × N until process
// exit). The interval is unref'd so it doesn't keep the event loop alive,
// but the closure itself retains the controller and `isCancelled` ref.
const CANCEL_POLL_INTERVAL_MS = 50;
function isCancelledToSignal(/** @type {any} */ isCancelled) {
  if (typeof isCancelled !== 'function') {
    return { signal: undefined, dispose: () => {} };
  }
  const controller = new AbortController();
  // Synchronous first check — covers the watcher-races-the-user case
  // where the cancel flag is already set by the time analyzeMediaFile
  // is invoked.
  try {
    if (isCancelled()) {
      controller.abort();
      return { signal: controller.signal, dispose: () => {} };
    }
  } catch {
    /* ignore */
  }
  const interval = setInterval(() => {
    try {
      if (isCancelled()) {
        clearInterval(interval);
        controller.abort();
      }
    } catch {
      /* ignore */
    }
  }, CANCEL_POLL_INTERVAL_MS);
  if (typeof interval.unref === 'function') interval.unref();
  controller.signal.addEventListener('abort', () => clearInterval(interval), { once: true });
  // dispose() aborts the controller so the existing abort listener fires
  // clearInterval. Idempotent: no-op if already aborted (user-cancelled path).
  const dispose = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  return { signal: controller.signal, dispose };
}

/**
 * Returns an analyzer with the dispatcher's signature
 * `(filePath, smartFolders, { isCancelled }) => Promise<analysisResult>`
 * that wraps `analyzeMediaFile` (which uses
 * `(filePath, dependencies, options)`).
 *
 * Whisper-missing graceful skip: if `whisperService` is null/undefined or
 * `analyzeMediaFile` throws `LLAMA_MODEL_NOT_FOUND`, returns a normalized
 * "skipped" result so downstream code (recordAnalysisResult, embedding
 * queue, vector store) flows unchanged. `SERVICE_UNAVAILABLE` from
 * in-flight shutdown still propagates.
 */
/**
 * Whether to caption video keyframes for this analysis. An explicit boolean
 * from the constructor wins (tests, special dispatchers); otherwise the
 * user's Settings toggle decides at call time, so flipping it applies to the
 * next video without a restart. Off when settings cannot be read.
 * @param {boolean|undefined} explicit
 * @returns {boolean}
 */
function resolveCaptionKeyframes(explicit) {
  if (typeof explicit === 'boolean') return explicit;
  try {
    const { getInstance: getSettingsService } = require('./SettingsService');
    return getSettingsService()?.getAll?.()?.captionVideoKeyframes === true;
  } catch {
    return false;
  }
}

/** @param {{ whisperService?: any, captionKeyframes?: boolean }} [deps] */
function createMediaAnalyzerAdapter({ whisperService, captionKeyframes } = {}) {
  return async (
    /** @type {any} */ filePath,
    /** @type {any} */ smartFolders,
    /** @type {Record<string, any>} */ dispatchOptions = {}
  ) => {
    // Watchers (SmartFolderWatcher / DownloadWatcher) and other dispatchers
    // pass `{ isCancelled, bypassCache, smartFolderId, ... }`. Earlier
    // versions of this adapter only destructured `isCancelled` and silently
    // dropped the rest, which meant:
    //   - watcher-driven re-analysis kept reusing cached transcripts even
    //     when the user explicitly forced re-analysis (`bypassCache: true`),
    //   - per-folder AI provider overrides keyed on `smartFolderId` could
    //     never fire on media files,
    //   - any future option added on the dispatcher side would silently no-op
    //     for media until someone noticed.
    // We forward all known fields explicitly. New options must be added here.
    const { isCancelled, bypassCache, smartFolderId } = dispatchOptions;

    if (!whisperService || typeof whisperService.transcribeMedia !== 'function') {
      logger.info('[MediaAdapter] Whisper unavailable; returning skip-shape', {
        file: path.basename(filePath || '')
      });
      return buildSkipResult(filePath);
    }
    const { signal, dispose } = isCancelledToSignal(isCancelled);
    try {
      return await analyzeMediaFile(
        filePath,
        { whisperService },
        {
          smartFolders,
          captionKeyframes: resolveCaptionKeyframes(captionKeyframes),
          signal,
          bypassCache,
          smartFolderId
        }
      );
    } catch (err) {
      if (isWhisperMissingError(err)) {
        logger.warn('[MediaAdapter] Whisper model missing; returning skip-shape', {
          file: path.basename(filePath || ''),
          error: err.message
        });
        return buildSkipResult(filePath);
      }
      throw err;
    } finally {
      // Tear down the cancel-poll interval whether we resolved or threw.
      // Without this, the interval keeps polling isCancelled() forever and
      // retains the closure (one zombie poller per analyzed file).
      dispose();
    }
  };
}

module.exports = { createMediaAnalyzerAdapter, buildSkipResult };
