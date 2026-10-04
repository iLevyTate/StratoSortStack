// @ts-check
/**
 * Media analysis orchestrator
 *
 * Routes audio and video files through:
 *   1. WhisperService — produces a transcript (text + timestamped segments)
 *   2. (video only) MediaTranscoder.extractKeyframes — captures scene-change
 *      stills written to a temp dir for later vision analysis
 *   3. (optional, video only) VisionService — captions each keyframe
 *   4. analyzeTextWithLlama — runs the existing schema extractor on a
 *      multimodal transcript (speech + visual descriptions interleaved by
 *      timestamp when captions are available, transcript-only otherwise)
 *      so the result is shape-compatible with documentAnalysis consumers
 *      (smart-folder matching, embedding queue, search index).
 *
 * The orchestrator is intentionally additive: existing analyzeDocumentFile /
 * analyzeImageFile paths are unchanged. Wiring this into simple-main's
 * dispatch is a follow-up; today callers can require this module directly
 * (e.g. from a future BatchAnalysisService route).
 *
 * @module analysis/mediaAnalysis
 */

const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const crypto = require('crypto');
const { createLogger } = require('../../shared/logger');
const { ERROR_CODES } = require('../../shared/errorCodes');
const { attachErrorCode } = require('../../shared/errorHandlingUtils');
const { normalizeAnalysisResult } = require('./utils');

const logger = createLogger('MediaAnalysis');

/**
 * Off by default. Mirrors the gate already honored by imageAnalysis.js:48
 * and semanticFolderMatcher.js:39. When enabled, expensive media analysis
 * (whisper transcription, ffmpeg keyframe extraction, vision-LLM captioning)
 * defers while the analysis embedding queue is saturated — otherwise media
 * runs unimpeded and adds CPU/GPU pressure that further starves embedding
 * progress. See docs/CONFIG.md (embeddings and embedding queue environment).
 */
const { isPipelineEmbeddingQueueWaitEnabled } = require('./utils');
const ENABLE_PIPELINE_EMBEDDING_QUEUE_WAIT = isPipelineEmbeddingQueueWaitEnabled();

const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.flac',
  '.aac',
  '.ogg',
  '.m4a',
  '.m4b', // audiobook
  '.opus',
  '.oga',
  '.wma',
  '.aiff',
  '.aif'
]);

// Video extensions kept consistent with fileTypeUtils.js so a file
// recognized as media elsewhere is not rejected here. `.3gp` (mobile)
// and `.mts/.m2ts` (AVCHD camcorder) were the gaps reported in the
// audio/video audit. NOTE: `.ts` is intentionally NOT included even
// though it's a real transport-stream video format — it collides with
// TypeScript source files, and `verify-analysis-routing` enforces
// `.ts` -> documents to keep dev workflows from feeding source code
// to whisper. Users with `.ts` video files should rename to `.m2ts`.
const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.mkv',
  '.webm',
  '.avi',
  '.flv',
  '.m4v',
  '.wmv',
  '.3gp',
  '.mts',
  '.m2ts'
]);

/**
 * Returns 'audio' | 'video' | null based on file extension. Used to gate
 * whether a file should be routed through this orchestrator.
 *
 * @param {string} filePath
 * @returns {'audio' | 'video' | null}
 */
function classifyMediaFile(filePath) {
  if (typeof filePath !== 'string') return null;
  const ext = path.extname(filePath).toLowerCase();
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return null;
}

/**
 * Best-effort media-kind inference across every signal we might have.
 * Used by SearchService (BM25 build) and ChatService (RAG source
 * shaping) to apply the lifted media cap to LEGACY analysis records
 * that pre-date the `analysis.mediaKind` field. Resolution order:
 *
 *   1. Explicit `analysis.mediaKind` from the v3.1.1+ pipeline.
 *   2. `mimeType` prefix — entries written by AnalysisHistoryServiceCore
 *      always include the file's mime type, so `audio/*` and `video/*`
 *      are reliable signals on legacy entries too.
 *   3. File extension — the last-resort fallback when mime type is
 *      missing (very old entries) or generic ('application/octet-stream').
 *
 * @param {Object} [params]
 * @param {*} [params.mediaKind] - explicit value from analysis (wins).
 * @param {string} [params.mimeType] - mime type if available.
 * @param {string} [params.filePath] - source path; only used to derive
 *   an extension via classifyMediaFile.
 * @returns {'audio' | 'video' | null}
 */
function inferMediaKind({ mediaKind, mimeType, filePath } = {}) {
  if (mediaKind === 'audio' || mediaKind === 'video') return mediaKind;
  if (typeof mimeType === 'string') {
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
  }
  return classifyMediaFile(filePath || '');
}

/**
 * Build a temp directory unique to one analysis run. Used to hold keyframe
 * stills before vision-LLM consumption. Caller is responsible for cleanup
 * via `cleanupKeyframeDir`.
 * @param {string} filePath
 */
async function createKeyframeWorkspace(filePath) {
  const stamp = crypto.randomBytes(8).toString('hex');
  const baseName = path
    .basename(filePath)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 40);
  const dir = path.join(os.tmpdir(), `stratosort-keyframes-${baseName}-${stamp}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** @param {string | null} dir */
async function cleanupKeyframeDir(dir) {
  if (!dir) return;
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn('[Media] Failed to clean keyframe workspace', {
      dir,
      error: err?.message
    });
  }
}

/**
 * Convert whisper segments into a transcript-with-timestamps string suitable
 * for downstream LLM analysis. Keeps timestamps because they're cheap and
 * help the LLM cite specific moments (e.g. "around 02:13 the speaker…").
 *
 * @param {Array<{ start: number, end: number, text: string }>} segments
 * @returns {string}
 */
function formatSegmentsForLlm(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return '';
  return segments
    .map((seg) => {
      const start = Number.isFinite(seg.start) ? formatTimestamp(seg.start) : '??:??';
      const end = Number.isFinite(seg.end) ? formatTimestamp(seg.end) : '??:??';
      const text = String(seg.text || '').trim();
      return text ? `[${start} → ${end}] ${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** @param {number} seconds */
function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(total / 60)
    .toString()
    .padStart(2, '0');
  const ss = (total % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

/**
 * Default vision-LLM prompt for keyframe captioning. Kept short so the
 * caption fits inside one transcript line — long descriptions inflate the
 * downstream `analyzeTextWithLlama` token budget without much value to the
 * schema extraction it drives.
 */
const DEFAULT_KEYFRAME_PROMPT =
  'Describe this video frame in one short sentence. ' +
  'Focus on visible objects, on-screen text, and overall setting. ' +
  'Do not speculate about audio or events outside the frame.';

/**
 * Bounded-concurrency caption loop. Runs `captionFn(framePath)` for each
 * keyframe with at most `concurrency` calls in flight. Failures are
 * captured per-frame so one bad frame doesn't poison the whole batch —
 * the merged transcript will simply omit the visual entry for that
 * timestamp.
 *
 * @param {Array<{ timestamp: number|null, framePath: string }>} keyframes
 * @param {Function} captionFn - async (framePath, signal) => string|null
 * @param {Object} [options]
 * @param {number} [options.concurrency=2] - Max concurrent vision calls.
 *   Vision LLMs are GPU-bound so higher numbers don't help and they thrash
 *   the same VRAM whisper just released.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Array<{ timestamp: number|null, framePath: string, caption: string|null, captionError?: string }>>}
 */
async function captionKeyframes(keyframes, captionFn, options = {}) {
  const { concurrency = 2, signal } = options;
  if (!Array.isArray(keyframes) || keyframes.length === 0) return [];
  if (typeof captionFn !== 'function') {
    throw new TypeError('[MediaAnalysis] captionFn must be a function');
  }
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array(keyframes.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < keyframes.length) {
      if (signal?.aborted) return;
      const idx = cursor++;
      const frame = keyframes[idx];
      try {
        const caption = await captionFn(frame.framePath, signal);
        results[idx] = {
          timestamp: frame.timestamp,
          framePath: frame.framePath,
          caption: typeof caption === 'string' ? caption.trim() || null : null
        };
      } catch (err) {
        results[idx] = {
          timestamp: frame.timestamp,
          framePath: frame.framePath,
          caption: null,
          captionError: err?.message || String(err)
        };
      }
    }
  };

  const workers = Array.from({ length: Math.min(limit, keyframes.length) }, () => worker());
  await Promise.all(workers);
  // Workers bail silently on abort, leaving undefined holes in `results`.
  // Returning that as a "partial caption set" would let an aborted analysis
  // continue to the LLM stage as if nothing happened — surface the cancel.
  if (signal?.aborted) {
    const error = new Error('Keyframe captioning cancelled');
    throw attachErrorCode(error, ERROR_CODES.OPERATION_CANCELLED);
  }
  return results;
}

/**
 * Build a single multimodal text representation that interleaves transcript
 * segments and keyframe captions in chronological order. Each line is
 * prefixed with [mm:ss] (or [mm:ss → mm:ss] for transcript ranges) plus a
 * `Speech:` or `Visual:` tag so the downstream LLM can disambiguate the
 * two streams. Segments without text and frames without a caption are
 * dropped; if both inputs are empty the function returns ''.
 *
 * @param {Array<{ start: number, end: number, text: string }>} segments
 * @param {Array<{ timestamp: number, caption: string }>} captions
 * @returns {string}
 */
function mergeTranscriptAndCaptions(segments, captions) {
  const events = [];
  for (const seg of segments || []) {
    const text = String(seg?.text || '').trim();
    if (!text || !Number.isFinite(seg.start)) continue;
    events.push({
      time: seg.start,
      end: Number.isFinite(seg.end) ? seg.end : seg.start,
      kind: 'speech',
      text
    });
  }
  for (const cap of captions || []) {
    if (!cap || !cap.caption) continue;
    if (!Number.isFinite(cap.timestamp)) continue;
    events.push({
      time: cap.timestamp,
      end: cap.timestamp,
      kind: 'visual',
      text: String(cap.caption).trim()
    });
  }
  if (events.length === 0) return '';
  // Stable sort by time, with speech rendering before a co-located caption
  // so the LLM sees "X said …, the screen showed …" reading-order rather
  // than the reverse. The kind comparator only fires when timestamps are
  // numerically equal which is rare but worth pinning down.
  events.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    if (a.kind === b.kind) return 0;
    return a.kind === 'speech' ? -1 : 1;
  });
  return events
    .map((ev) => {
      if (ev.kind === 'speech') {
        const start = formatTimestamp(ev.time);
        const end = formatTimestamp(ev.end);
        return `[${start} → ${end}] Speech: ${ev.text}`;
      }
      return `[${formatTimestamp(ev.time)}] Visual: ${ev.text}`;
    })
    .join('\n');
}

/**
 * Resolve a default caption function from the live LlamaService. Returns
 * null when LlamaService isn't available (test envs, early startup), in
 * which case the caller skips captioning gracefully.
 * @private
 */
function resolveDefaultCaptionFn() {
  let llamaService;
  try {
    const { getInstance } = require('../services/LlamaService');
    llamaService = getInstance();
  } catch {
    return null;
  }
  if (!llamaService || typeof llamaService.analyzeImage !== 'function') {
    return null;
  }
  /**
   * @param {string} framePath
   * @param {AbortSignal} [signal]
   */
  return async (framePath, signal) => {
    const response = await llamaService.analyzeImage({
      imagePath: framePath,
      prompt: DEFAULT_KEYFRAME_PROMPT,
      maxTokens: 128,
      temperature: 0.2,
      signal
    });
    if (!response) return null;
    return typeof response === 'string'
      ? response
      : response.response || response.text || response.content || null;
  };
}

/**
 * Analyze an audio or video file end-to-end. The result is shape-compatible
 * with what the document/image analysis paths return so callers can hand
 * it to smart-folder matching, embedding, etc. without special-casing.
 *
 * @param {string} filePath - Absolute path to the audio/video file.
 * @param {object} [dependencies] - Injected services.
 * @param {any} [dependencies.whisperService] - Instance with `transcribeMedia()`. Required at runtime; guarded below.
 * @param {Function} [dependencies.analyzeTextWithLlama] - Schema extractor;
 *   defaults to require('./documentLlm').analyzeTextWithLlama.
 * @param {Function} [dependencies.extractKeyframes] - Keyframe extractor;
 *   defaults to require('../services/MediaTranscoder').extractKeyframes.
 * @param {Function | null} [dependencies.captionImage] - Vision-LLM caption fn;
 *   `(framePath, signal) => Promise<string|null>`. Defaults to a wrapper
 *   around `LlamaService.analyzeImage` resolved at call time. Pass `null`
 *   to disable captioning even when the option is on.
 * @param {object} [options]
 * @param {any[]} [options.smartFolders] - Folder configs for routing hints.
 * @param {boolean} [options.extractVideoKeyframes] - Keyframe extraction.
 *   Defaults to `captionKeyframes`: frames are only useful once captioned,
 *   and extracting them for every video (ffmpeg scene detection, up to 12
 *   frames) while never captioning them cost time and produced a result
 *   that claimed visual analysis had happened (audit row MI-04). Pass
 *   `false` to skip extraction even when captioning is on.
 * @param {number} [options.maxKeyframes=12] - Cap on keyframes for video.
 * @param {boolean} [options.captionKeyframes=false] - Run each extracted
 *   keyframe through the vision LLM and merge captions into the transcript
 *   (multimodal analysis). Off by default — N keyframes = N vision calls,
 *   so this trades latency for richer search/categorization signal. The
 *   Settings toggle "Describe video keyframes" (`captionVideoKeyframes`)
 *   drives this through mediaAnalyzerAdapter.
 * @param {number} [options.maxCaptionedKeyframes=6] - When captioning is
 *   enabled, downsample to at most this many frames to keep cost bounded.
 *   Frames are picked evenly across the timeline.
 * @param {number} [options.captionConcurrency=2] - Max in-flight vision
 *   calls. Vision is GPU-bound so higher values rarely help.
 * @param {string} [options.language='en']
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.bypassCache=false] - Skip Whisper's transcript
 *   cache and the documentLlm analysis cache. Forwarded by dispatchers
 *   handling user-initiated re-analysis (see mediaAnalyzerAdapter).
 * @param {string|null} [options.smartFolderId=null] - When set, forwarded to
 *   analyzeTextWithLlama so per-folder AI-provider routing fires on media
 *   files (parity with document/image paths).
 * @returns {Promise<Object>} Normalized analysis result with media metadata.
 */
async function analyzeMediaFile(filePath, dependencies = {}, options = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    const error = new TypeError('[MediaAnalysis] filePath must be a non-empty string');
    throw attachErrorCode(error, ERROR_CODES.INVALID_INPUT);
  }
  const kind = classifyMediaFile(filePath);
  if (!kind) {
    const error = new Error(`[MediaAnalysis] Unsupported file extension: ${filePath}`);
    throw attachErrorCode(error, ERROR_CODES.INVALID_FILE_TYPE);
  }

  const whisperService = dependencies.whisperService;
  if (!whisperService || typeof whisperService.transcribeMedia !== 'function') {
    const error = new Error('[MediaAnalysis] whisperService is required');
    throw attachErrorCode(error, ERROR_CODES.SERVICE_UNAVAILABLE);
  }

  const analyzeTextFn =
    dependencies.analyzeTextWithLlama || require('./documentLlm').analyzeTextWithLlama;
  const extractKeyframesFn =
    dependencies.extractKeyframes || require('../services/MediaTranscoder').extractKeyframes;

  const {
    smartFolders = [],
    maxKeyframes = 12,
    captionKeyframes: shouldCaptionKeyframes = false,
    extractVideoKeyframes = shouldCaptionKeyframes,
    maxCaptionedKeyframes = 6,
    captionConcurrency = 2,
    // 'auto' = whisper language detection. WhisperService downgrades it to
    // 'en' when the loaded model is English-only (ggml-*.en.bin default).
    language = 'auto',
    signal,
    // Forwarded by the dispatcher (mediaAnalyzerAdapter). Until 3.1.1 these
    // were destructured by the adapter but silently dropped here, so:
    //  - watcher-driven re-analysis with bypassCache=true reused stale Whisper
    //    transcripts via WhisperService's in-memory cache,
    //  - per-folder AI-provider routing keyed on smartFolderId never fired
    //    because analyzeTextWithLlama only consults options.smartFolderId.
    bypassCache = false,
    smartFolderId = null
  } = options;

  // Pre-aborted callers should bail BEFORE doing any setup work. Without this
  // check, a media analyze that was cancelled before the dispatcher invoked
  // analyzeMediaFile still pays the cost of opening transcribe streams,
  // creating keyframe workspaces, and spinning up vision-LLM captioning —
  // each of which fails or is wasted partway through. Mirror the
  // already-existing aborted-before-start check in MediaTranscoder
  // (transcodeToWhisperPcm at src/main/services/MediaTranscoder.js:135-138)
  // so cancellation semantics are consistent across the media pipeline.
  if (signal?.aborted) {
    const error = new Error('Media analysis cancelled before start');
    throw attachErrorCode(error, ERROR_CODES.OPERATION_CANCELLED);
  }

  // Backpressure gate. Document and image analyses honor this flag at the
  // pre-enqueue step in imageAnalysis.js / semanticFolderMatcher.js. Media
  // analyses do not currently enqueue per-file embeddings, so the
  // architecturally-equivalent gate is "do not kick off whisper +
  // vision-LLM work while the analysis queue is saturated" — same intent
  // (let consumers catch up before producing more pressure), different
  // queue role.
  if (ENABLE_PIPELINE_EMBEDDING_QUEUE_WAIT) {
    let embeddingQueueManager = null;
    try {
      embeddingQueueManager = require('./embeddingQueue/queueManager');
    } catch {
      /* test envs may not load the queue manager — gate becomes a no-op */
    }
    if (
      embeddingQueueManager &&
      typeof embeddingQueueManager.waitForAnalysisQueueCapacity === 'function'
    ) {
      const queueCapacity = await embeddingQueueManager.waitForAnalysisQueueCapacity({
        highWatermarkPercent: 75,
        releasePercent: 50,
        maxWaitMs: 60000
      });
      if (queueCapacity?.timedOut) {
        logger.warn('[Media] Analysis embedding queue remained saturated before media analysis', {
          file: path.basename(filePath),
          capacityPercent: queueCapacity.capacityPercent
        });
      }
      // Re-check the abort signal AFTER the wait. A user cancel during the
      // up-to-60s queue wait would otherwise be honored only after the wait
      // returns; without this check the analyzer marches into the heavy
      // whisperService.transcribeMedia call despite the cancel having been
      // requested.
      if (signal?.aborted) {
        const error = new Error('Media analysis cancelled while waiting for queue capacity');
        throw attachErrorCode(error, ERROR_CODES.OPERATION_CANCELLED);
      }
    }
  }

  const fileName = path.basename(filePath);
  /** @type {string | null} */
  let keyframeDir = null;
  /** @type {any[]} */
  let keyframes = [];
  /** @type {any[]} */
  let captioned = [];

  try {
    // 1. Transcribe (audio for both audio and video files). bypassCache
    // disables WhisperService's in-memory cache so a forced re-analysis
    // re-runs ffmpeg+whisper instead of replaying the prior result.
    const transcript = await whisperService.transcribeMedia(filePath, {
      language,
      signal,
      useCache: !bypassCache
    });

    // 2. Optional keyframes for video. Failures are non-fatal — the
    // transcript alone is usable and we don't want to block the whole
    // pipeline on a missing codec.
    // Frames are only extracted when they will be captioned; uncaptioned
    // frames carried nothing but timestamps into the result.
    if (kind === 'video' && extractVideoKeyframes && shouldCaptionKeyframes) {
      try {
        keyframeDir = await createKeyframeWorkspace(filePath);
        keyframes = await extractKeyframesFn(filePath, keyframeDir, {
          maxFrames: maxKeyframes,
          signal
        });
      } catch (err) {
        if (keyframeDir) {
          await cleanupKeyframeDir(keyframeDir);
          keyframeDir = null;
        }
        // A user cancel must stop the pipeline, not degrade to audio-only.
        if (err?.code === ERROR_CODES.OPERATION_CANCELLED) throw err;
        logger.warn('[Media] Keyframe extraction failed; proceeding with audio only', {
          file: fileName,
          error: err?.message
        });
        keyframes = [];
      }
    }

    // 3. Optional vision-LLM captioning of keyframes. Even-spaced
    // downsampling keeps the cost bounded on long videos: a 30-minute
    // tutorial might extract 12 scene-change frames but only 6 of them
    // need to be captioned to give the LLM enough visual signal.
    if (
      kind === 'video' &&
      shouldCaptionKeyframes &&
      keyframes.length > 0 &&
      dependencies.captionImage !== null
    ) {
      const captionFn =
        (typeof dependencies.captionImage === 'function' && dependencies.captionImage) ||
        resolveDefaultCaptionFn();
      if (captionFn) {
        const downsampled = pickEvenlySpaced(keyframes, maxCaptionedKeyframes);
        try {
          captioned = await captionKeyframes(downsampled, captionFn, {
            concurrency: captionConcurrency,
            signal
          });
        } catch (err) {
          // A user cancel must stop the pipeline, not silently fall back to
          // transcript-only and continue burning LLM time on aborted work.
          if (err?.code === ERROR_CODES.OPERATION_CANCELLED) throw err;
          logger.warn(
            '[Media] Keyframe captioning failed; proceeding with transcript-only analysis',
            {
              file: fileName,
              error: err?.message
            }
          );
          captioned = [];
        }
      } else {
        logger.debug('[Media] No caption function available; skipping keyframe captioning');
      }
    }

    // 4. Run the existing text analyzer on the transcript (or the
    // multimodal merge when captions are present) so the result matches
    // the documentAnalysis schema. If the transcript is empty (silent
    // audio, music-only, etc.) we still return a normalized result with
    // a low-confidence fallback rather than throwing — that lets
    // organize/search treat the file gracefully.
    const transcriptOnlyForLlm = formatSegmentsForLlm(transcript.segments) || transcript.text || '';
    const hasUsableCaptions = captioned.some((c) => c?.caption);
    const transcriptForLlm = hasUsableCaptions
      ? mergeTranscriptAndCaptions(transcript.segments, captioned)
      : transcriptOnlyForLlm;
    const hasUsableTranscript = transcriptForLlm.trim().length > 0;

    let llmResult = null;
    if (hasUsableTranscript) {
      try {
        // analyzeTextWithLlama is positional:
        //   (textContent, originalFileName, smartFolders, fileDate, namingContext, options)
        // The pre-3.1.1 call here passed an object literal in position 2 as
        // smartFolders, so the array never reached the prompt builder
        // (smartFolders.length was undefined, folder hints silently absent).
        // Forward the dispatcher-provided bypassCache + smartFolderId so the
        // analysis cache is honored and per-folder provider routing fires.
        llmResult = await analyzeTextFn(transcriptForLlm, fileName, smartFolders, null, [], {
          signal,
          bypassCache,
          smartFolderId,
          fileType: kind
        });
      } catch (err) {
        logger.warn('[Media] LLM transcript analysis failed', {
          file: fileName,
          error: err?.message
        });
      }
    }

    const baseFallback = {
      category: kind === 'video' ? 'video' : 'audio',
      confidence: hasUsableTranscript ? 60 : 30,
      keywords: hasUsableTranscript ? [] : [kind, 'no-transcript']
    };

    // A file with no speech is not a transcription; recording it as one
    // made the fallback look like real content downstream (audit row MI-04).
    const extractionMethod = hasUsableCaptions
      ? 'whisper-transcription+vision-captions'
      : hasUsableTranscript
        ? 'whisper-transcription'
        : 'no-speech';

    const normalized = normalizeAnalysisResult(
      {
        ...llmResult,
        type: kind,
        category: llmResult?.category || baseFallback.category,
        keywords: llmResult?.keywords || baseFallback.keywords,
        confidence: llmResult?.confidence ?? baseFallback.confidence,
        llmSuggestedName: llmResult?.suggestedName || null,
        suggestedName: llmResult?.suggestedName,
        purpose:
          llmResult?.purpose ||
          (hasUsableTranscript
            ? hasUsableCaptions
              ? 'Spoken content + visual descriptions extracted via whisper.cpp + vision LLM'
              : 'Spoken content transcribed via whisper.cpp'
            : 'Media file with no detectable speech'),
        contentLength: transcriptForLlm.length,
        extractionMethod
      },
      baseFallback
    );

    // Build the keyframe summary BEFORE cleanup so framePath is still readable
    // for caption alignment; downstream consumers only need the caption text.
    const keyframeSummaries = keyframes.map((/** @type {any} */ k) => {
      const cap = captioned.find((c) => c?.framePath === k.framePath);
      return {
        timestamp: k.timestamp,
        caption: cap?.caption || null
      };
    });

    if (keyframeDir) {
      await cleanupKeyframeDir(keyframeDir);
      keyframeDir = null;
    }

    // Populate `extractedText` with the same blob the LLM saw (multimodal
    // when captions are available, transcript-only otherwise). The search
    // and chunk-embedding pipeline (semantic.js Rebuild flow + SearchService
    // BM25 weights) keys on `extractedText`; without this the v3.1.1 audio/
    // video feature is fundamentally broken for search — a user who analyzes
    // a podcast would never be able to find it by spoken-content keywords
    // even though the transcript is present in history. Document and image
    // analysis paths populate `extractedText` the same way, so this also
    // gives the BM25 weights and chunk-rebuild flow shape parity across
    // file types. The raw `transcript` field is preserved separately for
    // the AnalysisDetails UI and history-view rendering.
    const searchableText = transcriptForLlm || transcript.text || '';

    return {
      ...normalized,
      extractedText: searchableText,
      mediaKind: kind,
      transcript: transcript.text,
      transcriptSegments: transcript.segments,
      durationSeconds: transcript.durationSeconds,
      // 'auto' is a detection request, not a detected language — never
      // record it as one when whisper reported nothing.
      detectedLanguage: transcript.language || (language === 'auto' ? null : language),
      keyframes: keyframeSummaries,
      keyframeWorkspace: null,
      multimodalText: hasUsableCaptions ? transcriptForLlm : null
    };
  } catch (error) {
    if (keyframeDir) {
      await cleanupKeyframeDir(keyframeDir);
    }
    throw error;
  }
}

/**
 * Pick at most `n` items from `list` evenly spaced by index. Used to
 * downsample keyframes before vision-LLM captioning so the cost stays
 * bounded regardless of how many scene cuts ffmpeg detected. Returns the
 * input unchanged when `n >= list.length` or `n <= 0`.
 *
 * @template T
 * @param {T[]} list
 * @param {number} n
 * @returns {T[]}
 */
function pickEvenlySpaced(list, n) {
  if (!Array.isArray(list)) return [];
  if (!Number.isFinite(n) || n <= 0 || n >= list.length) return list.slice();
  // n === 1 would make step = (length-1)/0 = Infinity, then Math.round(0 * Infinity)
  // = NaN and list[NaN] = undefined. Return the middle element as the single
  // most-representative sample instead.
  if (n === 1) return [list[Math.floor((list.length - 1) / 2)]];
  const step = (list.length - 1) / (n - 1);
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.round(i * step);
    out.push(list[idx]);
  }
  return out;
}

module.exports = {
  analyzeMediaFile,
  classifyMediaFile,
  inferMediaKind,
  formatSegmentsForLlm,
  formatTimestamp,
  cleanupKeyframeDir,
  captionKeyframes,
  mergeTranscriptAndCaptions,
  pickEvenlySpaced,
  DEFAULT_KEYFRAME_PROMPT,
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS
};
