// @ts-check
/**
 * HEIC/HEIF to PNG via ffmpeg.
 *
 * Apple photos arrive as HEIC containers holding an HEVC-coded image that
 * neither Tesseract nor the vision model can read. This module asks the
 * ffmpeg binary the media pipeline already ships (see
 * `services/MediaTranscoder.resolveFfmpegPath`) for the first frame as a PNG
 * written to stdout, so the rest of the image pipeline keeps working on a
 * format it understands.
 *
 * Contract: the function never throws. Every failure mode - no ffmpeg on the
 * machine, an ffmpeg built without an HEVC decoder, a corrupt file, a timeout,
 * an abort, an output larger than the caller is willing to hold - resolves to
 * `null` with a single debug log line. The caller decides what degrading to
 * metadata-only analysis looks like.
 *
 * @module analysis/extractors/heicDecode
 */

const path = require('path');
const childProcess = require('child_process');
const { createLogger } = require('../../../shared/logger');
const MediaTranscoder = require('../../services/MediaTranscoder');

const logger = createLogger('HeicDecode');

/** Default wall-clock budget for one decode. A single still frame is normally sub-second. */
const HEIC_DECODE_TIMEOUT_MS = 20000;
/** Default cap on the PNG written back by ffmpeg (a 48 MP photo compresses well under this). */
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Only the end of stderr is kept in the log line: ffmpeg prints the decisive error last. */
const STDERR_TAIL_CHARS = 400;
/** First four bytes of every PNG stream. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
/**
 * Largest delay Node's timers honour. Anything above it fires after 1 ms (with
 * a TimeoutOverflowWarning), which would turn a generous `timeoutMs` into an
 * instant kill, so the budget is clamped here instead.
 */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * ffmpeg wording for "this build cannot decode HEVC". `moov atom not found`
 * and friends describe a broken container, not a missing decoder, and must
 * not match: the caller may surface a "install an HEVC-capable ffmpeg" hint
 * only for the decoder case.
 */
const EXPLICIT_DECODER_PATTERNS = [/Decoder \(codec hevc\) not found/i, /Unsupported codec/i];
const HEVC_PATTERN = /hevc/i;
const DECODER_MISSING_PATTERNS = [/not found/i, /No decoder/i];

/**
 * @typedef {(command: string, args: string[], options: { stdio: Array<'ignore' | 'pipe'> }) => any} SpawnLike
 */

/**
 * @typedef {Object} DecodeOptions
 * @property {number} [timeoutMs] Wall-clock budget before the child is killed (default 20000).
 * @property {number} [maxOutputBytes] Cap on collected stdout bytes (default 64 MiB).
 * @property {string} [ffmpegPath] Binary to run; resolved through MediaTranscoder when omitted.
 * @property {SpawnLike} [spawnImpl] Replacement for `child_process.spawn` (tests).
 * @property {AbortSignal} [signal] Cancels the decode; the child is killed.
 */

/**
 * Whether ffmpeg's stderr says the build has no HEVC decoder.
 *
 * Evaluated per line so an unrelated `not found` (a missing moov atom, a
 * missing input file) on one line and an `hevc` stream description on
 * another do not combine into a false positive.
 *
 * @param {string | null | undefined} stderrText
 * @returns {boolean}
 */
function describesMissingHevcDecoder(stderrText) {
  if (typeof stderrText !== 'string' || !stderrText) return false;
  const lines = stderrText.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    if (EXPLICIT_DECODER_PATTERNS.some((pattern) => pattern.test(line))) return true;
    if (HEVC_PATTERN.test(line) && DECODER_MISSING_PATTERNS.some((pattern) => pattern.test(line))) {
      return true;
    }
  }
  return false;
}

/**
 * Decode the first image of a HEIC/HEIF file to PNG bytes.
 *
 * @param {string} filePath Absolute path to the HEIC file.
 * @param {DecodeOptions} [options]
 * @returns {Promise<Buffer | null>} PNG bytes, or `null` when ffmpeg could
 *   not produce a PNG for any reason.
 */
async function decodeHeicToPng(filePath, options = {}) {
  const {
    timeoutMs = HEIC_DECODE_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    ffmpegPath = undefined,
    spawnImpl = undefined,
    signal = undefined
  } = options || {};

  if (typeof filePath !== 'string' || !filePath.trim()) {
    logger.debug('[HeicDecode] filePath must be a non-empty string; skipping');
    return null;
  }
  const file = path.basename(filePath);

  if (signal && signal.aborted) {
    logger.debug('[HeicDecode] Aborted before spawn', { file });
    return null;
  }

  let binary = typeof ffmpegPath === 'string' && ffmpegPath.trim() ? ffmpegPath.trim() : null;
  if (!binary) {
    try {
      binary = MediaTranscoder.resolveFfmpegPath();
    } catch (err) {
      logger.debug('[HeicDecode] ffmpeg unavailable; skipping HEIC decode', {
        file,
        error: toMessage(err)
      });
      return null;
    }
  }

  const spawnFn = typeof spawnImpl === 'function' ? spawnImpl : childProcess.spawn;
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-i',
    filePath,
    '-frames:v',
    '1',
    '-f',
    'image2pipe',
    '-vcodec',
    'png',
    'pipe:1'
  ];
  const effectiveTimeout = Math.min(
    toPositiveNumber(timeoutMs, HEIC_DECODE_TIMEOUT_MS),
    MAX_TIMER_MS
  );
  const effectiveMaxBytes = toPositiveNumber(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
  // Created before spawn so a failure here cannot leak a running child.
  const stderr = MediaTranscoder.createBoundedStderrCollector();

  return new Promise((resolve) => {
    /** @type {any} */
    let child;
    try {
      child = spawnFn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      // spawn() itself can throw synchronously (invalid binary path on some
      // platforms, EAGAIN under process limits). Same answer as a late error.
      logger.debug('[HeicDecode] Decode failed', {
        file,
        reason: 'spawn failed',
        error: toMessage(err)
      });
      resolve(null);
      return;
    }
    if (!child || typeof child.on !== 'function') {
      logger.debug('[HeicDecode] spawn returned no child process', { file });
      resolve(null);
      return;
    }

    /** @type {Buffer[]} */
    let pngChunks = [];
    let pngBytes = 0;
    let settled = false;
    /** Set once 'close' has fired: the process is gone, so no signal is sent. */
    let exited = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let killTimer = null;

    const cleanup = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (signal) {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {
          /* defensive: a non-standard signal implementation */
        }
      }
    };

    const killChild = () => {
      if (exited) return;
      try {
        if (typeof child.kill === 'function') child.kill('SIGKILL');
      } catch {
        /* the process may already be gone */
      }
    };

    /**
     * Resolve `null` exactly once, with the reason and the stderr tail in the
     * debug log so a support bundle shows why a photo was analysed without
     * pixels. Never logs stdout (image bytes).
     * @param {string} reason
     * @param {Record<string, unknown>} [extra]
     */
    const giveUp = (reason, extra = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      killChild();
      // Release whatever was buffered: the bytes will never be returned.
      pngChunks = [];
      const stderrText = stderr.text().trim();
      logger.debug('[HeicDecode] Decode failed', {
        file,
        reason,
        missingHevcDecoder: describesMissingHevcDecoder(stderrText),
        stderrTail: tail(stderrText, STDERR_TAIL_CHARS),
        stderrTruncated: stderr.truncated,
        ...extra
      });
      resolve(null);
    };

    /** @param {Buffer} png */
    const succeed = (png) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(png);
    };

    const onAbort = () => giveUp('aborted');
    if (signal) {
      try {
        signal.addEventListener('abort', onAbort, { once: true });
      } catch (err) {
        // A signal-like object without addEventListener: the pre-spawn
        // `aborted` check is all the cancellation we can offer, and a throw
        // here would reject the promise and leak the child.
        logger.debug('[HeicDecode] abort signal does not support listeners', {
          file,
          error: toMessage(err)
        });
      }
    }

    killTimer = setTimeout(
      () => giveUp('timeout', { timeoutMs: effectiveTimeout }),
      effectiveTimeout
    );
    // Do not keep the process alive for an abandoned decode.
    if (killTimer && typeof killTimer.unref === 'function') killTimer.unref();

    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (/** @type {unknown} */ chunk) => {
        if (settled) return;
        const buf = toBuffer(chunk);
        pngBytes += buf.length;
        if (pngBytes > effectiveMaxBytes) {
          giveUp('output cap exceeded', { maxOutputBytes: effectiveMaxBytes });
          return;
        }
        pngChunks.push(buf);
      });
      // An unhandled 'error' on a stream is thrown from the emitter and would
      // take the main process down; a broken stdout pipe means no PNG.
      child.stdout.on('error', (/** @type {unknown} */ err) => {
        giveUp('stdout stream error', { error: toMessage(err) });
      });
    }

    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (/** @type {unknown} */ chunk) => {
        stderr.push(toBuffer(chunk));
      });
      // stderr is diagnostics only: losing it must not fail the decode.
      child.stderr.on('error', () => {});
    }

    child.on('error', (/** @type {any} */ err) => {
      // ENOENT: the resolved path is stale or PATH lookup found nothing.
      giveUp('spawn error', {
        code: err && err.code ? err.code : undefined,
        error: toMessage(err)
      });
    });

    child.on(
      'close',
      (/** @type {number | null} */ code, /** @type {string | null} */ killSignal) => {
        exited = true;
        if (settled) return;
        if (code !== 0) {
          giveUp('non-zero exit', { exitCode: code, killSignal: killSignal || undefined });
          return;
        }
        const png = Buffer.concat(pngChunks, pngBytes);
        if (!hasPngSignature(png)) {
          giveUp('stdout is not a PNG stream', { bytes: png.length });
          return;
        }
        logger.debug('[HeicDecode] Decoded HEIC to PNG', { file, bytes: png.length });
        succeed(png);
      }
    );
  });
}

/**
 * @param {Buffer} buf
 * @returns {boolean}
 */
function hasPngSignature(buf) {
  return (
    buf.length >= PNG_SIGNATURE.length &&
    buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  );
}

/**
 * Coerce a stream chunk to a Buffer without ever throwing: a fake or
 * misconfigured stream could hand over a string or something stranger, and a
 * throw inside a 'data' handler would be an uncaught exception.
 * @param {unknown} chunk
 * @returns {Buffer}
 */
function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array)
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === 'string') return Buffer.from(chunk);
  return Buffer.alloc(0);
}

/**
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function tail(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `...${text.slice(text.length - maxChars)}`;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function toPositiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function toMessage(err) {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : String(err);
}

module.exports = {
  decodeHeicToPng,
  describesMissingHevcDecoder,
  HEIC_DECODE_TIMEOUT_MS
};
