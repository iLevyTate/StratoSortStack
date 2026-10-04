// @ts-check
/**
 * MediaTranscoder
 *
 * Thin wrapper around an LGPL-licensed FFmpeg binary that converts any
 * supported audio or video file into the exact PCM format whisper.cpp
 * requires: 16-bit signed little-endian, mono, 16 kHz.
 *
 * The ffmpeg binary is resolved at runtime via `resolveFfmpegPath()` —
 * env override, then a bundled copy under `assets/runtime/ffmpeg/` populated
 * by `scripts/setup-ffmpeg-runtime.js`, then PATH-based fallback. Subprocess
 * invocation only — no FFI linking, so the LGPL relink-ability obligation
 * does not apply. See `assets/runtime/ffmpeg/NOTICE.md` for attribution.
 *
 * Returns a `Buffer` containing raw PCM samples. The buffer is what the
 * `@fugood/whisper.node` binding accepts directly via `transcribeData()`,
 * skipping a redundant round-trip through a temp WAV file.
 *
 * @module services/MediaTranscoder
 */

const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { spawn } = require('child_process');
const { createLogger } = require('../../shared/logger');
const { ERROR_CODES } = require('../../shared/errorCodes');
const { attachErrorCode } = require('../../shared/errorHandlingUtils');
const { resolveRuntimePath } = require('../utils/runtimePaths');

const logger = createLogger('MediaTranscoder');

const FFMPEG_BINARY_NAME = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

const WHISPER_SAMPLE_RATE = 16000;
const WHISPER_CHANNELS = 1;
const WHISPER_BYTES_PER_SAMPLE = 2;
const DEFAULT_MAX_DURATION_SECONDS = 60 * 60 * 4; // 4 hours
const DEFAULT_TRANSCODE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
// Hard cap on the source file size. Even a wildly compressed 50 GB video
// stalls the queue and risks OOM before the duration cap fires (the duration
// cap measures growth of the PCM output, which can lag heavy I/O). 10 GB is
// well above any expected user audio/video file but small enough to fail
// fast when something pathological is queued.
const DEFAULT_MAX_SOURCE_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
const MAX_PCM_BYTES_PER_HOUR =
  WHISPER_SAMPLE_RATE * WHISPER_CHANNELS * WHISPER_BYTES_PER_SAMPLE * 3600;

// Transient ffmpeg retry. On Windows, antivirus briefly locks newly
// copied files; ffmpeg returns non-zero with a "Permission denied" /
// "Resource busy" stderr while the file is held. Without retry the
// user sees a hard failure and has to manually re-trigger the analysis.
// 3 attempts with 500 ms / 1 s / 2 s backoff covers typical AV scan
// windows without delaying real failures more than ~3.5 s.
const DEFAULT_FFMPEG_RETRY_ATTEMPTS = 3;
const DEFAULT_FFMPEG_RETRY_BASE_MS = 500;

// ffmpeg at `-loglevel info` (needed for showinfo) can emit hundreds of MB of
// stderr on long inputs. Everything this module parses — the Duration line,
// showinfo pts_time entries, and the leading error text — appears early, so
// only the head of the stream is retained.
const MAX_FFMPEG_STDERR_BYTES = 256 * 1024;

// ffmpeg's wording when `-vn -sn -dn` leaves nothing to encode: the input has
// no audio stream (a silent screen recording). A property of the file, so it
// is reported as MEDIA_NO_AUDIO_STREAM and never retried.
const NO_AUDIO_STREAM_PATTERNS = [
  /does not contain any stream/i,
  /Stream map '[^']*' matches no streams/i,
  /Output file is empty, nothing was encoded/i
];

/** @param {string|null|undefined} stderrText */
function describesMissingAudioStream(stderrText) {
  const text = typeof stderrText === 'string' ? stderrText : '';
  return NO_AUDIO_STREAM_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Collects child-process stderr, keeping only the first `maxBytes`.
 * Later chunks are counted and dropped so an unbounded stream cannot grow
 * memory for the lifetime of the process.
 *
 * @param {number} [maxBytes]
 * @returns {{ push: (chunk: Buffer) => void, text: () => string, readonly truncated: boolean }}
 */
function createBoundedStderrCollector(maxBytes = MAX_FFMPEG_STDERR_BYTES) {
  /** @type {Buffer[]} */
  const chunks = [];
  let kept = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (truncated) return;
      const remaining = maxBytes - kept;
      if (chunk.length <= remaining) {
        chunks.push(chunk);
        kept += chunk.length;
        return;
      }
      if (remaining > 0) {
        chunks.push(chunk.subarray(0, remaining));
        kept = maxBytes;
      }
      truncated = true;
    },
    text() {
      return Buffer.concat(chunks, kept).toString('utf8');
    },
    get truncated() {
      return truncated;
    }
  };
}

/**
 * Resolves the ffmpeg binary path using a multi-source lookup so the same
 * code path works in dev, packaged installs, and CI without dragging in the
 * GPL-3 `ffmpeg-static` package (which is incompatible with closed-source
 * commercial distribution).
 *
 * Resolution order:
 *   1. STRATOSORT_FFMPEG_PATH env var (explicit override; useful for tests
 *      and for end-users who want to point at a system-managed binary).
 *   2. assets/runtime/ffmpeg/<binary> bundled by scripts/setup-ffmpeg-runtime.js
 *      (production-default; LGPL-3 build, attribution in NOTICE.md).
 *   3. The bare binary name, allowing the OS to resolve via PATH. This is a
 *      defensive fallback for developers who have ffmpeg installed system-wide
 *      and haven't run setup-ffmpeg-runtime; child_process.spawn will throw
 *      ENOENT if PATH lookup fails, surfacing a clear error to the caller.
 *
 * @returns {string} Absolute path or PATH-resolvable name for ffmpeg.
 * @throws {Error} Only if the env-var override is set but does not exist.
 */
// Single-fire warning so a missing-bundled-ffmpeg log appears once per process,
// not on every transcode attempt. Surfacing this clearly turns an opaque
// "spawn ffmpeg ENOENT" deep in the analysis pipeline into a one-line fix
// instruction. We do not THROW here because some users legitimately rely on
// system-PATH ffmpeg (LGPL-built, e.g. macOS dev without bundled binary yet).
let _ffmpegMissingWarned = false;
function _warnFfmpegFallbackOnce() {
  if (_ffmpegMissingWarned) return;
  _ffmpegMissingWarned = true;
  logger.warn(
    '[MediaTranscoder] No bundled ffmpeg found and STRATOSORT_FFMPEG_PATH is not set; ' +
      'falling back to PATH lookup. If audio/video analysis fails with ENOENT, run: ' +
      'npm run setup:ffmpeg-runtime'
  );
}

// Returns true iff `binPath` exists on disk AND has the execute bit. existsSync
// alone is insufficient: a binary that lost its execute bit (read-only
// filesystem, broken chmod 0o755 on extract, restrictive umask, antivirus
// quarantine) crashes deep inside child_process.spawn with EACCES instead of
// surfacing the actionable warn-once log. On Windows X_OK is best-effort —
// Node maps it to GENERIC_EXECUTE on the file ACL, which is good enough as a
// "do not pass an obviously broken file to spawn" gate.
function _isExecutable(/** @type {any} */ binPath) {
  // On Windows, fs.accessSync(p, X_OK) maps to GENERIC_EXECUTE on the file
  // ACL via libuv. That mapping is unreliable for files extracted from a
  // zip via Windows Explorer or some CI runners — the bundled ffmpeg.exe
  // can exist on disk and run correctly when spawned but report as not
  // executable here, falling through to PATH unnecessarily. Skip the gate
  // on Windows; spawn ENOENT/EACCES still surfaces real failures via the
  // SERVICE_UNAVAILABLE classifier in child.on('error').
  if (process.platform === 'win32') return true;
  try {
    fsSync.accessSync(binPath, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveFfmpegPath() {
  const override = process.env.STRATOSORT_FFMPEG_PATH;
  if (override && override.trim()) {
    const trimmed = override.trim();
    if (!fsSync.existsSync(trimmed)) {
      const error = new Error(`STRATOSORT_FFMPEG_PATH points at a non-existent file: ${trimmed}`);
      throw attachErrorCode(error, ERROR_CODES.SERVICE_UNAVAILABLE);
    }
    return trimmed;
  }

  try {
    const bundled = resolveRuntimePath('ffmpeg', FFMPEG_BINARY_NAME);
    if (fsSync.existsSync(bundled) && _isExecutable(bundled)) {
      return bundled;
    }
    if (fsSync.existsSync(bundled) && !_isExecutable(bundled)) {
      // Present but unexecutable: don't silently use it (spawn would EACCES);
      // fall through to PATH so the warn-once message points the developer at
      // setup:ffmpeg-runtime, which re-applies chmod 0o755 on extraction.
      logger.warn(
        '[MediaTranscoder] Bundled ffmpeg exists but is not executable; falling back to PATH',
        { bundledPath: bundled }
      );
    }
  } catch {
    // resolveRuntimePath requires `electron`; in non-Electron contexts (e.g.
    // some Jest setups) it throws. Fall through to PATH-based fallback.
  }

  _warnFfmpegFallbackOnce();
  return FFMPEG_BINARY_NAME;
}

/**
 * Convert any audio/video file into 16 kHz mono PCM s16le.
 *
 * @param {string} inputPath - Absolute path to the source media file.
 * @param {Record<string, any>} [options] - { signal, maxDurationSeconds, timeoutMs }
 * @returns {Promise<{ pcm: Buffer, sampleRate: number, channels: number, durationSeconds: number }>}
 */
async function transcodeToWhisperPcm(inputPath, options = {}) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    const error = new TypeError('[MediaTranscoder] inputPath must be a non-empty string');
    throw attachErrorCode(error, ERROR_CODES.INVALID_INPUT);
  }

  const {
    signal,
    maxDurationSeconds = DEFAULT_MAX_DURATION_SECONDS,
    timeoutMs = DEFAULT_TRANSCODE_TIMEOUT_MS,
    maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES,
    retryAttempts = DEFAULT_FFMPEG_RETRY_ATTEMPTS,
    retryBaseMs = DEFAULT_FFMPEG_RETRY_BASE_MS
  } = options;

  if (signal?.aborted) {
    const error = new Error('Transcode cancelled before start');
    throw attachErrorCode(error, ERROR_CODES.OPERATION_CANCELLED);
  }

  // Pre-flight size check. The PCM-bytes growth check (line ~228) is reactive
  // — by the time it fires the process has already started piping a multi-GB
  // input through ffmpeg, eating memory. A stat() before spawn lets us
  // refuse pathological inputs immediately.
  if (Number.isFinite(maxSourceBytes) && maxSourceBytes > 0) {
    let stat;
    try {
      stat = await fs.stat(inputPath);
    } catch (err) {
      const error = new Error(
        `[MediaTranscoder] Failed to stat source for size check: ${err.message}`
      );
      throw attachErrorCode(error, ERROR_CODES.INVALID_INPUT);
    }
    if (stat.size > maxSourceBytes) {
      const error = new Error(
        `[MediaTranscoder] Source file exceeds ${maxSourceBytes} bytes (got ${stat.size}); skipping transcode to avoid OOM.`
      );
      throw attachErrorCode(error, ERROR_CODES.INVALID_INPUT);
    }
  }

  const ffmpegPath = resolveFfmpegPath();

  // ffmpeg arguments: read input, force decode to s16le PCM, downmix to mono,
  // resample to 16 kHz, write raw PCM to stdout. No container/headers — the
  // whisper binding takes raw samples directly.
  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-vn', // ignore any video stream
    '-sn', // ignore subtitles
    '-dn', // ignore data streams
    '-f',
    's16le',
    '-ac',
    String(WHISPER_CHANNELS),
    '-ar',
    String(WHISPER_SAMPLE_RATE),
    '-acodec',
    'pcm_s16le',
    'pipe:1'
  ];

  const runOnce = () =>
    new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      /** @type {Buffer[]} */
      const pcmChunks = [];
      const stderr = createBoundedStderrCollector();
      let pcmBytes = 0;
      const maxPcmBytes = Math.ceil((maxDurationSeconds / 3600) * MAX_PCM_BYTES_PER_HOUR);
      let settled = false;
      /** @type {ReturnType<typeof setTimeout>|null} */
      let killTimer = null;

      const cleanup = () => {
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        if (signal && onAbort) {
          try {
            signal.removeEventListener('abort', onAbort);
          } catch {
            /* defensive */
          }
        }
      };

      const fail = (/** @type {any} */ error) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        reject(error);
      };

      const succeed = (/** @type {any} */ value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const onAbort = () => {
        const error = new Error('Transcode cancelled');
        fail(attachErrorCode(error, ERROR_CODES.OPERATION_CANCELLED));
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      killTimer = setTimeout(() => {
        const error = new Error(`Transcode timed out after ${timeoutMs}ms`);
        fail(attachErrorCode(error, ERROR_CODES.TIMEOUT));
      }, timeoutMs);
      // .unref() so an in-flight transcode doesn't keep the event loop alive
      // and block process exit for up to `timeoutMs` (default 30 min).
      if (killTimer.unref) killTimer.unref();

      child.stdout.on('data', (chunk) => {
        pcmBytes += chunk.length;
        if (pcmBytes > maxPcmBytes) {
          const error = new Error(
            `Media exceeds maximum supported duration (${maxDurationSeconds}s). ` +
              `Split the file into smaller chunks before transcribing.`
          );
          fail(attachErrorCode(error, ERROR_CODES.INVALID_INPUT));
          return;
        }
        pcmChunks.push(chunk);
      });

      child.stderr.on('data', (chunk) => stderr.push(chunk));

      child.on('error', (/** @type {any} */ error) => {
        // spawn ENOENT means the resolved ffmpeg path no longer exists or PATH
        // lookup found nothing. Without an error code the WhisperService catch
        // layer can't tell this apart from a transient transcode failure, so
        // it would not raise the audio-transcription degraded banner. Tag it
        // explicitly so the user gets an actionable subsystem-down signal.
        if (error && (error.code === 'ENOENT' || error.code === 'EACCES')) {
          fail(
            attachErrorCode(
              new Error(
                `ffmpeg is unavailable (${error.code}): ${error.message}. ` +
                  `Run 'npm run setup:ffmpeg-runtime' or set STRATOSORT_FFMPEG_PATH to a valid binary.`
              ),
              ERROR_CODES.SERVICE_UNAVAILABLE
            )
          );
          return;
        }
        fail(error);
      });

      child.on('close', (code, killSignal) => {
        if (settled) return;
        if (code === 0) {
          const pcm = Buffer.concat(pcmChunks, pcmBytes);
          const sampleCount = pcm.length / WHISPER_BYTES_PER_SAMPLE;
          const durationSeconds = sampleCount / WHISPER_SAMPLE_RATE;
          logger.debug('[MediaTranscoder] Transcode complete', {
            inputPath,
            pcmBytes: pcm.length,
            durationSeconds: Math.round(durationSeconds * 100) / 100
          });
          succeed({
            pcm,
            sampleRate: WHISPER_SAMPLE_RATE,
            channels: WHISPER_CHANNELS,
            durationSeconds
          });
          return;
        }
        const stderrText = stderr.text().trim();
        if (describesMissingAudioStream(stderrText)) {
          fail(
            attachErrorCode(
              new Error(`No audio stream to transcribe in ${path.basename(inputPath)}`),
              ERROR_CODES.MEDIA_NO_AUDIO_STREAM
            )
          );
          return;
        }
        const reason = killSignal ? `signal=${killSignal}` : `exit=${code}`;
        const error = new Error(
          `ffmpeg failed (${reason})${stderrText ? `: ${stderrText.slice(0, 500)}` : ''}`
        );
        fail(attachErrorCode(error, ERROR_CODES.ANALYSIS_FAILED));
      });
    });

  // Retry loop. Only retries on `ANALYSIS_FAILED` (the generic "ffmpeg
  // exited non-zero" path) — not on cancellation, timeout, ENOENT, or
  // input-validation errors, which are not transient. The most common
  // real-world cause is Windows AV briefly locking a freshly-copied
  // file; ffmpeg returns "Permission denied" or "Resource busy" on
  // open and a 500 ms wait usually clears it.
  const totalAttempts = Math.max(1, Math.floor(retryAttempts));
  let lastError;
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    if (signal?.aborted) {
      const error = new Error('Transcode cancelled');
      throw attachErrorCode(error, ERROR_CODES.OPERATION_CANCELLED);
    }
    try {
      return await runOnce();
    } catch (error) {
      lastError = error;
      const isTransient = error?.code === ERROR_CODES.ANALYSIS_FAILED;
      const hasMoreAttempts = attempt + 1 < totalAttempts;
      if (!isTransient || !hasMoreAttempts) throw error;
      const backoffMs = Math.max(0, retryBaseMs) * Math.pow(2, attempt);
      logger.warn('[MediaTranscoder] ffmpeg failed transiently; retrying', {
        attempt: attempt + 1,
        nextAttempt: attempt + 2,
        totalAttempts,
        backoffMs,
        error: error?.message
      });
      await new Promise((resolve, reject) => {
        // The previous form added an `abort` listener with `{once:true}` but
        // never removed it on the normal timer-fire path. Across N retries on
        // the same long-lived AbortSignal (the polled signal mediaAnalyzerAdapter
        // produces from `isCancelled`), listeners would accumulate one-per-retry
        // and Node warns at 10. Capture onAbort and remove it on the resolve
        // path. Also `.unref()` the timer so a long backoff doesn't keep the
        // event loop alive past quit (every other timer in this module is
        // unref'd; this one was the lone exception).
        /** @type {((ev?: any) => void)|null} */
        let onAbort = null;
        const timer = setTimeout(() => {
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
          resolve();
        }, backoffMs);
        if (timer.unref) timer.unref();
        if (signal) {
          onAbort = () => {
            clearTimeout(timer);
            const cancelErr = new Error('Transcode cancelled');
            reject(attachErrorCode(cancelErr, ERROR_CODES.OPERATION_CANCELLED));
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }
  }
  throw lastError;
}

/**
 * Extract representative keyframes from a video file via scene-change
 * detection. Returns an array of `{ timestamp, framePath }` entries written
 * to `outputDir`. The output frames are JPEG (smaller than PNG, identical
 * fidelity for downstream vision-LLM analysis).
 *
 * Implementation notes:
 *   - `select='gt(scene,T)'` emits a frame whenever the inter-frame scene
 *     score exceeds T. Tunable via `sceneThreshold`. Default 0.4 is the
 *     common ffmpeg recipe for "real" cuts in mixed content.
 *   - `showinfo` writes per-frame metadata (pts_time) to stderr so we can
 *     pair each output filename with its timestamp.
 *   - `maxFrames` caps output to keep vision-LLM cost bounded on long videos.
 *
 * @param {string} videoPath - Absolute path to the source video.
 * @param {string} outputDir - Existing directory to write frames into.
 *   Caller is responsible for creating and cleaning up the directory.
 * @param {Record<string, any>} [options] - { sceneThreshold, maxFrames, signal, timeoutMs }
 * @returns {Promise<Array<{ timestamp: number, framePath: string }>>}
 */
async function extractKeyframes(videoPath, outputDir, options = {}) {
  if (typeof videoPath !== 'string' || !videoPath.trim()) {
    const error = new TypeError('[MediaTranscoder] videoPath must be a non-empty string');
    throw attachErrorCode(error, ERROR_CODES.INVALID_INPUT);
  }
  if (typeof outputDir !== 'string' || !outputDir.trim()) {
    const error = new TypeError('[MediaTranscoder] outputDir must be a non-empty string');
    throw attachErrorCode(error, ERROR_CODES.INVALID_INPUT);
  }

  const {
    sceneThreshold = 0.4,
    maxFrames = 20,
    signal,
    timeoutMs = 10 * 60 * 1000,
    // 'even-spaced' (default) → if scene detection finds zero frames, fall
    //   back to evenly-spaced sampling so static/slow videos still yield
    //   visual signal for the multimodal LLM step. 'none' preserves the
    //   pre-fix behavior (return [] when scene cuts find nothing) — used
    //   by callers that want strict scene-only output.
    keyframeFallback = 'even-spaced'
  } = options;

  if (signal?.aborted) {
    const error = new Error('Keyframe extraction cancelled before start');
    throw attachErrorCode(error, ERROR_CODES.OPERATION_CANCELLED);
  }

  if (!Number.isFinite(sceneThreshold) || sceneThreshold <= 0 || sceneThreshold > 1) {
    const error = new Error('sceneThreshold must be in (0, 1]');
    throw attachErrorCode(error, ERROR_CODES.INVALID_INPUT);
  }
  if (!Number.isInteger(maxFrames) || maxFrames <= 0) {
    const error = new Error('maxFrames must be a positive integer');
    throw attachErrorCode(error, ERROR_CODES.INVALID_INPUT);
  }

  const ffmpegPath = resolveFfmpegPath();
  // Output filename pattern. ffmpeg substitutes %04d with a 1-based frame
  // index. Pairing those indices with the timestamps reported by showinfo
  // happens in the stderr parser below.
  const outputPattern = path.join(outputDir, 'frame-%04d.jpg');

  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'info', // need 'info' so showinfo lines are emitted to stderr
    '-i',
    videoPath,
    '-vf',
    `select='gt(scene\\,${sceneThreshold})',showinfo`,
    '-frames:v',
    String(maxFrames),
    // -fps_mode replaces the deprecated -vsync since FFmpeg 5.0; the bundled
    // LGPL build (May-2026 git, N-124419-gc8a4770599) hard-fails with
    // EINVAL on -vsync so it's not just a deprecation warning, it's broken.
    '-fps_mode',
    'vfr',
    '-q:v',
    '4', // visually lossless enough for vision LLMs
    // Force JFIF full-range YUV on output. H.264 sources default to limited-
    // range yuv420p; the MJPEG encoder on the bundled FFmpeg refuses that
    // ('Non full-range YUV is non-standard') and the encoder init fails with
    // -22 EINVAL — extract returns zero frames despite no visible error in
    // the default loglevel. yuvj420p is the JPEG-spec full-range variant
    // and writes JPEGs identical in fidelity for the vision-LLM consumer.
    '-pix_fmt',
    'yuvj420p',
    '-an',
    '-sn',
    '-dn',
    outputPattern
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr = createBoundedStderrCollector();
    let settled = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let killTimer = null;
    /** @type {((ev?: any) => void)|null} */
    let onAbort = null;

    const cleanup = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (signal && onAbort) {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {
          /* defensive */
        }
      }
    };

    const fail = (/** @type {any} */ error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(error);
    };

    const succeed = (/** @type {any} */ value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    onAbort = () => {
      const error = new Error('Keyframe extraction cancelled');
      fail(attachErrorCode(error, ERROR_CODES.OPERATION_CANCELLED));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    killTimer = setTimeout(() => {
      const error = new Error(`Keyframe extraction timed out after ${timeoutMs}ms`);
      fail(attachErrorCode(error, ERROR_CODES.TIMEOUT));
    }, timeoutMs);
    if (killTimer.unref) killTimer.unref();

    child.stdout.on('data', () => {
      /* ffmpeg writes nothing to stdout in this mode but listen to drain. */
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (/** @type {any} */ error) => {
      // Mirror the tagging at the transcode site so keyframe extraction
      // failures from a missing or unexecutable ffmpeg also surface as
      // SERVICE_UNAVAILABLE rather than a raw spawn error. Failures here
      // are also non-fatal at the orchestrator layer (mediaAnalysis.js
      // catches and proceeds transcript-only), but the error code drives
      // the DegradedStateBanner upstream.
      if (error && (error.code === 'ENOENT' || error.code === 'EACCES')) {
        fail(
          attachErrorCode(
            new Error(
              `ffmpeg is unavailable (${error.code}): ${error.message}. ` +
                `Run 'npm run setup:ffmpeg-runtime' or set STRATOSORT_FFMPEG_PATH to a valid binary.`
            ),
            ERROR_CODES.SERVICE_UNAVAILABLE
          )
        );
        return;
      }
      fail(error);
    });
    child.on('close', async (code, killSignal) => {
      if (settled) return;
      if (code !== 0) {
        const stderrText = stderr.text().trim();
        const reason = killSignal ? `signal=${killSignal}` : `exit=${code}`;
        const error = new Error(
          `ffmpeg keyframe extraction failed (${reason})${stderrText ? `: ${stderrText.slice(0, 500)}` : ''}`
        );
        fail(attachErrorCode(error, ERROR_CODES.ANALYSIS_FAILED));
        return;
      }

      // Parse showinfo lines: each accepted frame produces a line like
      //   [Parsed_showinfo_1 @ 0x...] n:   0 pts:    0 pts_time:0
      // We capture pts_time values in emission order; ffmpeg writes
      // frames with sequential indices that match.
      const stderrText = stderr.text();
      if (stderr.truncated) {
        logger.debug('[MediaTranscoder] ffmpeg stderr exceeded retention cap; parsed head only', {
          videoPath,
          maxBytes: MAX_FFMPEG_STDERR_BYTES
        });
      }
      /** @type {number[]} */
      const timestamps = [];
      const re = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;
      let match;
      while ((match = re.exec(stderrText)) !== null) {
        timestamps.push(Number(match[1]));
      }

      try {
        const entries = await fs.readdir(outputDir);
        const frameFiles = entries.filter((name) => /^frame-\d+\.jpg$/.test(name)).sort();

        if (frameFiles.length > 0) {
          const result = frameFiles.slice(0, maxFrames).map((file, idx) => ({
            timestamp:
              typeof timestamps[idx] === 'number' && Number.isFinite(timestamps[idx])
                ? timestamps[idx]
                : null,
            framePath: path.join(outputDir, file)
          }));

          logger.debug('[MediaTranscoder] Keyframe extraction complete', {
            videoPath,
            frames: result.length
          });
          succeed(result);
          return;
        }

        // Scene-change selector returned zero frames. This is common on
        // real-world videos with gradual motion (slow pans, talking heads,
        // static product demos) — at threshold 0.4 the inter-frame delta
        // never crosses the cut bar, so the orchestrator gets nothing
        // visual to feed the LLM and silently degrades to transcript-only.
        // Fall back to an evenly-spaced sampler so the multimodal pipeline
        // still gets a useful set of frames in those cases. The fallback
        // is opt-out via `keyframeFallback: 'none'` for callers that
        // genuinely want scene-cut-only behavior.
        if (keyframeFallback === 'none') {
          succeed([]);
          return;
        }

        try {
          const fallbackFrames = await _extractEvenlySpacedFrames(videoPath, outputDir, {
            maxFrames,
            timeoutMs,
            signal
          });
          logger.debug('[MediaTranscoder] Scene detection found 0 frames; even-spaced fallback', {
            videoPath,
            frames: fallbackFrames.length
          });
          succeed(fallbackFrames);
        } catch (fallbackError) {
          // Fallback failure is non-fatal at the orchestrator (mediaAnalysis
          // catches and proceeds transcript-only); surface the original
          // empty result so downstream behavior is unchanged on top of
          // the new path.
          logger.warn('[MediaTranscoder] Even-spaced keyframe fallback failed', {
            videoPath,
            error: fallbackError?.message
          });
          succeed([]);
        }
      } catch (readError) {
        fail(readError);
      }
    });
  });
}

/**
 * Probe the video duration via ffprobe-equivalent (`ffmpeg -i` parsing of
 * stderr). Used by the even-spaced keyframe fallback to space frames
 * across the timeline without an external ffprobe dependency.
 * @private
 */
async function _probeDurationSeconds(
  /** @type {any} */ videoPath,
  /** @type {{ timeoutMs?: number, signal?: AbortSignal }} */ { timeoutMs = 30 * 1000, signal } = {}
) {
  if (signal?.aborted) {
    const error = new Error('Duration probe cancelled before start');
    throw attachErrorCode(error, ERROR_CODES.OPERATION_CANCELLED);
  }
  const ffmpegPath = resolveFfmpegPath();
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', videoPath], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    const stderr = createBoundedStderrCollector();
    let settled = false;
    /** @type {((ev?: any) => void)|null} */
    let onAbort = null;
    const removeAbortListener = () => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };
    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      try {
        child.kill('SIGKILL');
      } catch {
        /* spawn target may already be dead */
      }
      reject(new Error(`Duration probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (killTimer.unref) killTimer.unref();
    if (signal) {
      onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        try {
          child.kill('SIGKILL');
        } catch {
          /* spawn target may already be dead */
        }
        reject(
          attachErrorCode(new Error('Duration probe cancelled'), ERROR_CODES.OPERATION_CANCELLED)
        );
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      removeAbortListener();
      reject(err);
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      removeAbortListener();
      // ffmpeg without an output target exits non-zero but still emits
      // the Duration line we need to stderr — parse and resolve.
      const text = stderr.text();
      const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
      if (!match) {
        reject(new Error('Could not parse Duration from ffmpeg probe output'));
        return;
      }
      const [, hh, mm, ss] = match;
      resolve(Number(hh) * 3600 + Number(mm) * 60 + Number(ss));
    });
  });
}

/**
 * Even-spaced keyframe extractor used as a fallback when scene-change
 * selection yields no frames. Uses ffmpeg's fps filter at a derived
 * rate (target N frames across the duration) and writes JPEGs that
 * match the scene-cut path's output naming so callers cannot tell which
 * source produced them.
 * @private
 */
async function _extractEvenlySpacedFrames(
  /** @type {any} */ videoPath,
  /** @type {any} */ outputDir,
  /** @type {{ maxFrames?: number, timeoutMs?: number, signal?: AbortSignal }} */ options = {}
) {
  const { maxFrames = 12, timeoutMs = 10 * 60 * 1000, signal } = options;
  const ffmpegPath = resolveFfmpegPath();

  // Pass signal into the probe so an abort during the up-to-30s probe
  // is honored instead of waiting for the timeout. Without this, a user
  // cancel during the scene-cut → fallback transition would still wait
  // the full probe duration before bailing.
  const duration = await _probeDurationSeconds(videoPath, { signal });
  if (!Number.isFinite(duration) || duration <= 0) {
    return [];
  }

  // Pick the largest fps that still yields ≤ maxFrames over the duration.
  // Cap from below at 1 frame per 60 s so a very long static video still
  // produces a handful of samples; cap from above at 2 fps so a 5-second
  // clip doesn't produce 100 visually-identical samples.
  const desiredFps = Math.max(1 / 60, Math.min(2, maxFrames / Math.max(duration, 1)));
  const outputPattern = path.join(outputDir, 'frame-%04d.jpg');

  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-i',
    videoPath,
    '-vf',
    `fps=${desiredFps}`,
    '-frames:v',
    String(maxFrames),
    // See scene-cut path above: -vsync hard-fails on the bundled FFmpeg.
    '-fps_mode',
    'vfr',
    '-q:v',
    '4',
    // See scene-cut path above for the JFIF full-range YUV rationale.
    '-pix_fmt',
    'yuvj420p',
    '-an',
    '-sn',
    '-dn',
    outputPattern
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let settled = false;
    let onAbort = null;
    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* spawn target may already be dead */
      }
      reject(new Error(`Even-spaced keyframe extraction timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (killTimer.unref) killTimer.unref();
    if (signal) {
      onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        try {
          child.kill('SIGKILL');
        } catch {
          /* spawn target may already be dead */
        }
        reject(
          attachErrorCode(
            new Error('Even-spaced keyframe extraction cancelled'),
            ERROR_CODES.OPERATION_CANCELLED
          )
        );
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      if (code !== 0) {
        reject(new Error(`Even-spaced ffmpeg exited with code ${code}`));
        return;
      }
      try {
        const entries = await fs.readdir(outputDir);
        const frameFiles = entries.filter((name) => /^frame-\d+\.jpg$/.test(name)).sort();
        // Synthesize timestamps from the chosen fps so downstream consumers
        // (caption merge by timestamp) still get a usable t-coordinate.
        const result = frameFiles.slice(0, maxFrames).map((file, idx) => ({
          timestamp: Math.min(duration, (idx + 0.5) / desiredFps),
          framePath: path.join(outputDir, file)
        }));
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  });
}

module.exports = {
  transcodeToWhisperPcm,
  extractKeyframes,
  resolveFfmpegPath,
  createBoundedStderrCollector,
  describesMissingAudioStream,
  MAX_FFMPEG_STDERR_BYTES,
  WHISPER_SAMPLE_RATE,
  WHISPER_CHANNELS,
  WHISPER_BYTES_PER_SAMPLE
};
