// @ts-check
/**
 * WhisperService - In-process speech-to-text using whisper.cpp
 *
 * Uses `@fugood/whisper.node` (N-API binding to whisper.cpp) for fully
 * on-device transcription with the same backend story as LlamaService:
 * Metal on macOS, CUDA/Vulkan on Windows/Linux, CPU fallback.
 *
 * The service is intentionally narrower than LlamaService:
 *   - Only one model type (audio); no vision/text/embedding multiplexing.
 *   - Buffer-in / segments-out; no streaming yet (follow-up).
 *   - Reuses GPUMonitor for backend selection and ensureResolvedModelsPath()
 *     for model file location, but does not register with ModelMemoryManager
 *     yet — whisper-base is small (~150 MB) and lifetime-managed here.
 *
 * Audio input contract: 16-bit signed little-endian PCM, mono, 16 kHz.
 * Use MediaTranscoder.transcodeToWhisperPcm() to convert any source media.
 *
 * @module services/WhisperService
 */

/**
 * Re-export the native binding's option types so the helpers below can
 * declare them as @returns. With @ts-check enabled at file top, this
 * makes tsc fail the typecheck if anyone reintroduces the `model:` vs
 * `filePath:` regression we hit during the 2026-05-09 multimedia pipeline
 * verification. See node_modules/@fugood/whisper.node/lib/binding.ts for
 * the underlying NativeContextOptions / NativeVadContextOptions shape.
 *
 * @typedef {import('@fugood/whisper.node/lib/binding').NativeContextOptions} NativeContextOptions
 * @typedef {import('@fugood/whisper.node/lib/binding').NativeVadContextOptions} NativeVadContextOptions
 */

/**
 * @typedef {{ type: string, name: string, vramMB?: number }} GpuInfo
 * GPU information returned by GPUMonitor.detectGPU(). `type` is one of
 * 'cpu' | 'cuda' | 'nvidia' | 'vulkan' | 'amd' | 'intel'.
 */

/**
 * @typedef {{ signal?: AbortSignal, language?: string, temperature?: number, translate?: boolean }} TranscribeOptions
 * Options accepted by _transcribePcmRaw, _transcribePcmInChunks, and
 * _transcribePcmWithVad. All fields are optional.
 */

/**
 * Subset of fs.promises used by WhisperService. Typed here so injected
 * test overrides are accepted without widening _fs to the full fs.promises
 * interface (which requires many more methods).
 *
 * @typedef {{
 *   mkdir: (path: string, opts?: { recursive?: boolean }) => Promise<string|undefined>,
 *   stat: (path: string) => Promise<import('fs').Stats>,
 *   lstat: (path: string) => Promise<import('fs').Stats>,
 *   copyFile: (src: string, dest: string) => Promise<void>
 * }} WhisperFsPromises
 */

const { createRequire } = require('module');
const path = require('path');

/**
 * Webpack-bypassing require for runtime-computed package specifiers. See the
 * `loadNativeWhisperModule` JSDoc for the bug this defeats. `Module.createRequire`
 * is a Node builtin that returns a real CJS `require` bound to this file —
 * webpack's `electron-main` target externalizes the `'module'` import, so this
 * call survives bundling unchanged. In raw-node environments
 * (`scripts/run-real-media.js`, jest) it works identically. The result is
 * indistinguishable from a hand-written `require` from this module's directory.
 */
const _nativeRequire = createRequire(__filename);
const fs = require('fs').promises;
const crypto = require('crypto');
const { app } = require('electron');
const { EventEmitter } = require('events');
const { createLogger } = require('../../shared/logger');
const { createSingletonHelpers } = require('../../shared/singletonFactory');
const { ERROR_CODES } = require('../../shared/errorCodes');
const { attachErrorCode } = require('../../shared/errorHandlingUtils');
const { ensureResolvedModelsPath } = require('./modelPathResolver');
const { getInstance: getGPUMonitor } = require('./GPUMonitor');
const { transcodeToWhisperPcm, WHISPER_SAMPLE_RATE } = require('./MediaTranscoder');

/** @typedef {import('./GPUMonitor').GPUMonitor} GPUMonitor */

const logger = createLogger('WhisperService');

/**
 * The whisper.node binding (1.0.18+) declares `audioData: ArrayBuffer` for
 * both transcribeData() and detectSpeechData(); the native code throws
 * "TypeError: Expected ArrayBuffer" when handed a Node Buffer. Buffer is a
 * Uint8Array view onto a *possibly shared* underlying ArrayBuffer
 * (Buffer.allocUnsafe pools allocations into a single backing buffer, so
 * `.buffer` alone would expose other allocations). The default fix is to
 * slice by the view's byteOffset/byteLength to materialize a fresh
 * ArrayBuffer of exactly our region.
 *
 * OPTIMIZATION: when the Buffer owns its ENTIRE underlying ArrayBuffer
 * (byteOffset === 0 AND byteLength === buffer.byteLength), no other
 * allocation is interleaved and we can hand `pcm.buffer` directly to the
 * binding — saving a full memcpy. This holds for `Buffer.alloc()`,
 * `Buffer.allocUnsafeSlow()`, and `Buffer.concat()` results, which is what
 * MediaTranscoder produces (Buffer.concat over the chunks captured from
 * ffmpeg stdout). Saves ~456MB of churn on a 2-hour audio analysis. We
 * keep the slice fallback for `Buffer.allocUnsafe()` results and arbitrary
 * TypedArray subviews where the underlying ArrayBuffer is shared.
 */
/**
 * @param {Buffer|ArrayBufferView|ArrayBuffer} pcm
 * @returns {ArrayBufferLike}
 */
function pcmToArrayBuffer(pcm) {
  if (pcm instanceof ArrayBuffer) return pcm;
  if (ArrayBuffer.isView(pcm)) {
    if (pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength) {
      return pcm.buffer;
    }
    return pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
  }
  throw new TypeError(`pcmToArrayBuffer expected Buffer/Uint8Array/ArrayBuffer, got ${typeof pcm}`);
}

/**
 * Default whisper model filename. base.en is the smallest model that produces
 * usable transcripts for English content. Quantized variants can be selected
 * via constructor options (`modelFilename`) once additional models are
 * present in the models directory.
 */
const DEFAULT_MODEL_FILENAME = 'ggml-base.en.bin';
const DEFAULT_VAD_MODEL_FILENAME = 'ggml-silero-v5.1.2.bin';
const WHISPER_SUBDIR = 'whisper';

// Long-audio chunking. whisper.cpp + KV cache costs scale with input
// duration; passing a 4-hour PCM (the MediaTranscoder cap) to a single
// transcribeData() call has been observed to OOM CPU/GPU at base-en
// sizes. When no VAD is configured AND the input is longer than this
// threshold, the PCM is sliced into segment-aware chunks and each is
// transcribed via the same `_transcribePcmRaw` path (so the mutex still
// serializes against the shared context, just one chunk at a time).
const LONG_AUDIO_THRESHOLD_SECONDS = 3600; // 1 hour
const LONG_AUDIO_CHUNK_SECONDS = 600; // 10 minutes per pass
const LONG_AUDIO_CHUNK_OVERLAP_SECONDS = 1; // dedupe boundary words

// Module-scope serial chains around the two native whisper.cpp surfaces.
// These intentionally live OUTSIDE any class instance so a process-wide
// guarantee holds even if multiple WhisperService instances are
// constructed (a future refactor, an inadvertent test-double, etc.).
// `_pendingTranscriptions` only dedupes the SAME file landing twice;
// two DIFFERENT files arriving within ~100 ms (e.g. a watcher firing on
// a multi-file paste) would each call `transcribeData()` (or
// `vad.detectSpeechData()`) on a single shared native context. The
// bindings are not documented as thread-safe — concurrent calls have
// been observed to garble output or fault the native side. Every call
// to `_transcribePcmRaw()` / `_runVad()` acquires the relevant lock,
// runs to completion, and releases. A VAD-segmented file holds the
// transcribe lock across all its segments so no other file can
// interleave.
let _transcribeChain = Promise.resolve();
let _vadChain = Promise.resolve();

const TRANSCRIBE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const TRANSCRIBE_CACHE_MAX_ENTRIES = 100;

// Default VAD thresholds. These mirror whisper.cpp's defaults for Silero v5.x.
// Tuneable via constructor options.vadThresholds.
const DEFAULT_VAD_THRESHOLDS = Object.freeze({
  threshold: 0.5, // probability above which a frame is considered speech
  minSpeechDurationMs: 250, // discard speech segments shorter than this
  minSilenceDurationMs: 100, // silence shorter than this is bridged into the surrounding segment
  speechPadMs: 30 // expand each segment by this much on either side
});

// Codes that indicate the speech-to-text subsystem itself is unavailable
// (versus a single file failing to transcribe). These are the only cases
// that flip the DegradedStateBanner — a transient ANALYSIS_FAILED on one
// noisy file should not raise a banner that says Whisper is broken.
const WHISPER_UNAVAILABLE_ERROR_CODES = new Set([
  ERROR_CODES.LLAMA_MODEL_NOT_FOUND,
  ERROR_CODES.SERVICE_UNAVAILABLE
]);
const WHISPER_DEGRADED_CODE = 'whisper.unavailable';

/**
 * Build the platform-appropriate guidance string for a missing-ffmpeg
 * failure. The CLI script `npm run setup:ffmpeg-runtime` only supports
 * win32 + darwin — it throws an explicit "Linux ffmpeg runtime is not
 * yet wired up" error on Linux because BtbN ships .tar.xz which Node
 * can't extract natively. Telling Linux users to run that script would
 * send them down a dead-end path; telling Windows/macOS users to
 * "install via package manager" is wrong because the bundled LGPL
 * binary IS the supported path there.
 *
 * The STRATOSORT_FFMPEG_PATH escape hatch works on every platform and
 * is mentioned everywhere as the universal fallback.
 */
function _ffmpegUnavailableMessage() {
  const base = 'Audio/video transcription is unavailable: ffmpeg cannot be launched.';
  const escapeHatch = 'Or set STRATOSORT_FFMPEG_PATH to a valid binary.';
  if (process.platform === 'linux') {
    return `${base} Install ffmpeg via your package manager (e.g. \`apt install ffmpeg\` or \`dnf install ffmpeg\`). ${escapeHatch}`;
  }
  if (process.platform === 'darwin') {
    return `${base} The bundled binary should ship with the app — reinstall, or install ffmpeg via Homebrew (\`brew install ffmpeg\`). ${escapeHatch}`;
  }
  return `${base} Run 'npm run setup:ffmpeg-runtime' (dev), reinstall the app, or install ffmpeg manually. ${escapeHatch}`;
}

/**
 * @param {any} error
 */
function _maybeRaiseWhisperUnavailable(error) {
  if (!error || typeof error !== 'object') return;
  if (!WHISPER_UNAVAILABLE_ERROR_CODES.has(error.code)) return;
  try {
    const tracker = require('./DegradedStateTracker').getInstance();
    // The single banner code covers both subsystems that can take audio
    // transcription down (Whisper model/binding, or the ffmpeg transcoder)
    // because the user-actionable answer is similarly shaped. Detail.errorCode
    // + ffmpegSide let logs and support distinguish.
    const isFfmpegSide =
      typeof error.message === 'string' && /ffmpeg is unavailable/i.test(error.message);
    // Only the model-missing branch is user-actionable from the UI today
    // — `WhisperModelInstaller` covers GGML downloads but not ffmpeg
    // packaging, which still requires either a system install or a
    // rebuild. Surface an `action` payload only for the model case so
    // the banner button never appears when it would be a dead end.
    const action = isFfmpegSide
      ? null
      : {
          code: 'whisper.install-model',
          label: 'Install model',
          confirm:
            'Download the Whisper speech-to-text model now? About 150 MB; downloads from huggingface.co.'
        };
    tracker.raise({
      code: WHISPER_DEGRADED_CODE,
      subsystem: 'audio-transcription',
      severity: 'error',
      message: isFfmpegSide
        ? _ffmpegUnavailableMessage()
        : 'Audio/video transcription is unavailable: the Whisper model is missing. ' +
          'Click "Install model" to download it.',
      detail: { errorCode: error.code, ffmpegSide: isFfmpegSide, ...(action ? { action } : {}) }
    });
  } catch {
    /* tracker is best-effort; never throw from a service error path */
  }
}

function _clearWhisperUnavailable() {
  try {
    require('./DegradedStateTracker').getInstance().clear(WHISPER_DEGRADED_CODE);
  } catch {
    /* never throw from a successful response path */
  }
}

/**
 * Lazy-load the native binding so test environments without the addon can
 * still import the service. Mirrors the pattern in LlamaService.
 */
/** @type {any} */
let _whisperModule = null;
/** @type {Promise<any>|null} */
let _whisperLoadPromise = null;
async function loadWhisperBinding() {
  if (_whisperModule) return _whisperModule;
  if (!_whisperLoadPromise) {
    _whisperLoadPromise = (async () => {
      return require('@fugood/whisper.node');
    })();
  }
  try {
    _whisperModule = await _whisperLoadPromise;
    return _whisperModule;
  } catch (error) {
    _whisperLoadPromise = null;
    throw error;
  }
}

/**
 * Load a whisper.node platform package directly via `require()`.
 *
 * The official binding's `initWhisper(opts, variant)` internally uses
 * `await import(packageName)` to load the variant package. That throws
 * `ERR_UNKNOWN_FILE_EXTENSION` on Node 18+ ESM because `.node` native
 * modules cannot be loaded via dynamic `import()` — only via CJS
 * `require()` (which uses `process.dlopen`). The binding's silent catch
 * then falls back to the CPU default and emits "no GPU found" at the
 * whisper.cpp layer regardless of `useGpu: true` and the variant arg.
 *
 * This helper bypasses that bug: it tries each variant in `variants` in
 * order via `require()`, then falls back to the default platform package.
 *
 * Variant `require()` can fail when the variant's native dependencies
 * aren't satisfied at runtime (CUDA: missing cudart64_*.dll on PATH;
 * Vulkan: missing GPU driver). We log and fall through to the next option.
 *
 * Module-level cache avoids re-walking the candidate list on every load
 * (a cold WhisperContext + WhisperVadContext would otherwise each retry
 * the failing variants).
 *
 * Cache lifetime: process-lifetime by design. `process.dlopen` (which
 * is what `require('@fugood/node-whisper-...')` ultimately calls)
 * cannot load the same `.node` file twice in one process — Node's
 * module cache returns the already-loaded module on the second
 * `require`, and clearing `require.cache[...]` doesn't unload the
 * native handle. So even if we DID clear `_cachedNativeModule` on
 * `WhisperService.shutdown()`, a subsequent re-init would still get the
 * same native module back. The cache is a fast-path; it isn't the
 * source of truth. Tests that need to swap variant order across cases
 * use `_resetNativeWhisperCacheForTesting()` (exported below) — that
 * works because the test mocks (`jest.doMock` + `jest.resetModules`)
 * bypass the underlying dlopen anyway.
 *
 * **Bundler hazard — DO NOT replace `_nativeRequire` with a bare `require`.**
 * The candidate package name is computed at runtime from `process.platform`
 * + `process.arch` + variant, so webpack cannot statically analyze the
 * specifier. A bare `require(candidate.name)` gets erased to webpack's
 * `webpackEmptyContext` stub, which throws `MODULE_NOT_FOUND` for every
 * input — every variant in the chain fails and media transcription
 * silently falls back to filename-only categorization in any webpack-
 * built bundle (i.e. `npm run dev` and every `dist:*` build). We use
 * `Module.createRequire(__filename)` (saved as the file-scope
 * `_nativeRequire`) which returns a real Node require that webpack
 * cannot see through — webpack's `electron-main` target externalizes
 * the `'module'` import so the call survives bundling unchanged.
 * `__non_webpack_require__` was tried first but webpack 5 silently
 * folds `typeof __non_webpack_require__ === 'function'` to a constant
 * and rewrites the identifier to its bundled `require` — the wrapper
 * looks like it bypasses webpack but actually doesn't.
 *
 * @param {string[]} variants Ordered list, best-first. Empty = CPU-only.
 * @returns {{ WhisperContext: Function, WhisperVadContext: Function, _resolvedVariant: string }}
 */
/** @type {any} */
let _cachedNativeModule = null;
// Module-level guard so the Windows DLL search path is only mutated once per
// process. `process.dlopen` cannot be undone; we just need to make the CUDA
// runtime DLLs reachable BEFORE the first cuda-variant `require()` call.
let _windowsDllPathAugmented = false;

/**
 * Make the CUDA 12 runtime DLLs reachable to whisper.node's CUDA variant on
 * Windows. The vision runtime (`VisionService._downloadRuntime`) already
 * stages `cudart64_12.dll` / `cublas64_12.dll` next to `llama-server.exe`
 * under `{userData}/runtime/llama.cpp/{tag}/`. Without this hook, Windows'
 * DLL loader doesn't search that directory and `@fugood/node-whisper-
 * win32-x64-cuda`'s dependent loads fail with `ERR_DLOPEN_FAILED` — whisper
 * silently falls back to Vulkan (~2-3× slower on this hardware class).
 *
 * Prepending the vision runtime's binary directory to `process.env.PATH`
 * is sufficient: on Windows, `LoadLibrary` searches PATH as part of the
 * default DLL search order, and `process.dlopen` (called by `require()`
 * for `.node` files) honors PATH for dependent loads.
 *
 * Idempotent and silent: if the vision runtime hasn't been staged yet, the
 * DLLs are absent, or the manifest is unreadable, falls through unchanged
 * so the existing Vulkan → CPU fallback still triggers.
 *
 * @returns {boolean} True if PATH was augmented this call; false otherwise.
 */
function _augmentWindowsDllSearchPathForCuda() {
  if (_windowsDllPathAugmented) return false;
  if (process.platform !== 'win32') return false;
  const candidateDirs = _collectCudaDllSearchDirs();
  for (const dir of candidateDirs) {
    if (!_dirHasRequiredCudaDlls(dir)) continue;
    const currentPath = process.env.PATH || '';
    if (!currentPath.split(path.delimiter).includes(dir)) {
      process.env.PATH = `${dir}${path.delimiter}${currentPath}`;
    }
    _windowsDllPathAugmented = true;
    logger.info('[Whisper] Augmented PATH for CUDA DLL lookup', {
      dir,
      searched: candidateDirs.length
    });
    return true;
  }
  // No candidate dir had the required CUDA 12 DLLs. Log the detected installed
  // CUDA major version so the user sees the version mismatch in one line.
  const installedCuda = _detectInstalledCudaVersion();
  logger.debug('[Whisper] CUDA 12 DLLs not found in any candidate dir', {
    searched: candidateDirs,
    detectedInstalledCuda: installedCuda
  });
  return false;
}

const REQUIRED_CUDA_DLLS = ['cudart64_12.dll', 'cublas64_12.dll'];

/**
 * Read `process.env.CUDA_PATH` and return its major.minor version (e.g.
 * "12.6") if it points at a recognizable NVIDIA CUDA install. Used to tell
 * the user `you have CUDA X.Y but we need 12.x` in the warning when no
 * search dir works out.
 * @returns {string|null}
 */
function _detectInstalledCudaVersion() {
  const cudaPath = process.env.CUDA_PATH || '';
  if (!cudaPath) return null;
  const m = cudaPath.match(/[\\/]v(\d+)(?:\.(\d+))?[\\/]?$/i);
  if (!m) return null;
  return m[2] ? `${m[1]}.${m[2]}` : m[1];
}

/**
 * Enumerate plausible locations for `cudart64_12.dll` / `cublas64_12.dll`,
 * ordered from most-specific to most-generic. The first dir that actually
 * contains BOTH required DLLs is the one we prepend to PATH.
 *
 * Search order:
 *   1. VisionService's staged runtime (the original behavior — only valid
 *      when the user has triggered a vision-model download).
 *   2. `process.env.CUDA_PATH/bin` when CUDA_PATH points at v12.
 *   3. Common Windows CUDA-12 install paths
 *      (`C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.*\bin`).
 *   4. `CUDA_PATH_V12_*` env vars (NVIDIA sets one per installed version).
 *
 * The fallback search closes the v2.0.9-era regression where the app
 * worked because the user had CUDA 12 installed system-wide; after they
 * upgraded to CUDA 13+ the bundle-less @fugood/whisper.node CUDA variant
 * could no longer find its dependent DLLs through the default search
 * path.
 *
 * @returns {string[]} Distinct directory paths to try, in order.
 */
function _collectCudaDllSearchDirs() {
  const fsSync = require('fs');
  /** @type {string[]} */
  const dirs = [];
  const seen = new Set();
  /** @param {string} dir */
  const push = (dir) => {
    if (typeof dir !== 'string' || !dir) return;
    const normalized = path.normalize(dir);
    if (seen.has(normalized.toLowerCase())) return;
    seen.add(normalized.toLowerCase());
    dirs.push(normalized);
  };

  // 1. VisionService staged runtime (original behavior).
  try {
    const { getRuntimeRoot, LLAMA_CPP_RELEASE_TAG } = require('./VisionService');
    const runtimeRoot = getRuntimeRoot(LLAMA_CPP_RELEASE_TAG);
    const manifestPath = path.join(runtimeRoot, 'runtime.json');
    if (fsSync.existsSync(manifestPath)) {
      const manifest = JSON.parse(fsSync.readFileSync(manifestPath, 'utf8'));
      const binaryPath = manifest?.binaryPath;
      if (typeof binaryPath === 'string' && binaryPath) {
        push(path.dirname(binaryPath));
      }
    }
  } catch (err) {
    logger.debug('[Whisper] Vision runtime dir resolution failed', { error: err?.message });
  }

  // 2. CUDA_PATH (NVIDIA sets this to the active CUDA install root).
  //    Only useful when it points at a v12.x install.
  const cudaPath = process.env.CUDA_PATH || '';
  if (cudaPath) push(path.join(cudaPath, 'bin'));

  // 3. NVIDIA installs each toolkit at a versioned path AND sets
  //    `CUDA_PATH_V<MAJOR>_<MINOR>` env vars per installed version. Walk
  //    every such env var that names a v12 install — covers the case
  //    where the user has BOTH CUDA 12 and CUDA 13 side-by-side.
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^CUDA_PATH_V12(?:_\d+)?$/i.test(key)) continue;
    if (typeof value === 'string' && value) {
      push(path.join(value, 'bin'));
    }
  }

  // 4. Well-known default install location for CUDA 12.x, in case env vars
  //    are absent (some users run the installer with non-default options
  //    that skip env var setup).
  try {
    const defaultBase = path.join('C:', 'Program Files', 'NVIDIA GPU Computing Toolkit', 'CUDA');
    if (fsSync.existsSync(defaultBase)) {
      for (const entry of fsSync.readdirSync(defaultBase)) {
        if (/^v12(\.\d+)?$/i.test(entry)) {
          push(path.join(defaultBase, entry, 'bin'));
        }
      }
    }
  } catch (err) {
    logger.debug('[Whisper] Default CUDA install scan failed', { error: err?.message });
  }

  return dirs;
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function _dirHasRequiredCudaDlls(dir) {
  const fsSync = require('fs');
  try {
    return REQUIRED_CUDA_DLLS.every((dll) => fsSync.existsSync(path.join(dir, dll)));
  } catch {
    return false;
  }
}

async function ensureVisionRuntimeCudaDlls() {
  if (process.platform !== 'win32') return;
  try {
    const { getInstance: getVisionService } = require('./VisionService');
    await getVisionService().ensureRuntimeStaged();
  } catch (err) {
    logger.debug('[Whisper] Vision runtime staging for CUDA DLLs failed (non-fatal)', {
      error: err?.message
    });
  }
  _augmentWindowsDllSearchPathForCuda();
}

/**
 * @param {string[]} variants
 * @returns {any}
 */
function loadNativeWhisperModule(variants) {
  if (_cachedNativeModule) return _cachedNativeModule;
  const platform = process.platform;
  const arch = process.arch;
  const variantList = Array.isArray(variants) ? variants : [];
  const candidates = variantList.map((variant) => ({
    name: `@fugood/node-whisper-${platform}-${arch}-${variant}`,
    label: variant
  }));
  candidates.push({ name: `@fugood/node-whisper-${platform}-${arch}`, label: 'default' });

  let lastError = null;
  for (const candidate of candidates) {
    try {
      if (candidate.label === 'cuda') {
        // ensureVisionRuntimeCudaDlls is async but loadNativeWhisperModule is sync;
        // staging is best-effort via the synchronous PATH augmentation below when
        // the runtime was already downloaded. Full async staging runs in _ensureLoaded.
        _augmentWindowsDllSearchPathForCuda();
      }
      // See JSDoc above — `_nativeRequire` is the file-scope require
      // returned by `Module.createRequire(__filename)`. Bare `require`
      // here is webpack-erased to `webpackEmptyContext`.
      const nativeModule = _nativeRequire(candidate.name);
      if (nativeModule && nativeModule.WhisperContext) {
        _cachedNativeModule = { ...nativeModule, _resolvedVariant: candidate.label };
        return _cachedNativeModule;
      }
      lastError = new Error(`Loaded ${candidate.name} but it has no WhisperContext export`);
    } catch (err) {
      lastError = err;
      logger.debug(`[Whisper] Failed to load ${candidate.name}:`, {
        message: err?.message,
        code: err?.code
      });
      // Promote CUDA `ERR_DLOPEN_FAILED` to a warning with actionable
      // guidance. The generic "module could not be found" comes from
      // the Windows loader and never names the missing DLL; the cause
      // is almost always a CUDA runtime major-version mismatch
      // (@fugood/whisper.node's prebuilt CUDA variant links CUDA 12.x — it
      // imports cudart64_12.dll + cublas64_12.dll; a user on CUDA 13+ only
      // has cudart64_13.dll / cublas64_13.dll, so the dependent load fails).
      // Fallback to the next variant (vulkan/default/cpu) will still
      // proceed; this just makes the perf-affecting cause discoverable
      // without diff-spelunking through whisper.cpp source.
      if (candidate.label === 'cuda' && err?.code === 'ERR_DLOPEN_FAILED') {
        const detectedCuda = _detectInstalledCudaVersion();
        const versionHint = detectedCuda
          ? ` Your CUDA_PATH points at v${detectedCuda}; install CUDA 12.x side-by-side ` +
            `(NVIDIA supports multiple versions concurrently) or wait for a whisper.node ` +
            `build against CUDA ${detectedCuda.split('.')[0]}.`
          : ` No CUDA install detected via CUDA_PATH; install CUDA 12.x or use the Vulkan/CPU fallback.`;
        logger.warn(
          `[Whisper] CUDA variant failed to load — needs CUDA 12.x runtime DLLs ` +
            `(cudart64_12.dll, cublas64_12.dll) on PATH.${versionHint} ` +
            `Falling back to next variant; expect reduced GPU performance.`,
          {
            variant: candidate.label,
            code: err?.code,
            detectedInstalledCuda: detectedCuda
          }
        );
      }
    }
  }
  throw lastError || new Error('No whisper.node platform package could be loaded');
}

/**
 * Map a GPUMonitor backend label to whisper.node's `useGpu` flag.
 *
 * @param {GpuInfo|null} gpuInfo - Result of `GPUMonitor.detectGPU()`
 * @returns {boolean}
 */
function shouldUseGpu(gpuInfo) {
  if (!gpuInfo || gpuInfo.type === 'cpu') return false;
  // A 0 vramMB result on Linux/Vulkan typically means lspci found a GPU but
  // we couldn't read VRAM size. Trust the type label and let whisper.cpp's
  // own probe decide whether the backend actually works.
  return true;
}

/**
 * Build the options object for the native WhisperContext constructor /
 * `initWhisper`. Centralized so the property names are typed in exactly
 * one place — tsc enforces this body matches NativeContextOptions, which
 * is what catches `model:` vs `filePath:` mistakes that previously
 * shipped to production (see commit history around 2026-05-09).
 *
 * @param {string} modelPath - Absolute path to the GGML model file.
 * @param {boolean} useGpu
 * @returns {NativeContextOptions}
 */
function buildNativeContextOptions(modelPath, useGpu) {
  return { filePath: modelPath, useGpu };
}

/**
 * Same pattern for the VAD context. NativeVadContextOptions has a different
 * shape than NativeContextOptions (no useFlashAttn, optional nThreads), so
 * we get a dedicated factory rather than sharing one.
 *
 * @param {string} modelPath
 * @param {boolean} useGpu
 * @returns {NativeVadContextOptions}
 */
function buildNativeVadContextOptions(modelPath, useGpu) {
  return { filePath: modelPath, useGpu };
}

/**
 * Map a GPUMonitor backend label to an ORDERED list of whisper.node variants
 * to try, best-first. The loader (loadNativeWhisperModule) walks the list
 * and uses the first one that successfully `require()`s.
 *
 * The binding ships SEPARATE platform packages per backend
 * (`@fugood/node-whisper-<platform>-<arch>[-cuda|-vulkan]`). Calling the
 * binding's `initWhisper(opts)` without a `variant` arg uses the 'default'
 * build, which is CPU-only — so even when `useGpu: true` is requested, the
 * whisper.cpp init logs `whisper_backend_init_gpu: no GPU found` and falls
 * back to CPU. We have to load the right package ourselves.
 *
 * Why an ORDERED list rather than a single variant: on NVIDIA Windows, the
 * cuda variant gives best perf BUT it requires the CUDA runtime DLLs
 * (cudart64_*.dll, etc.) on PATH. Many users have CUDA installed but not
 * configured for Node's process environment, so the cuda variant `require`s
 * fine on disk but fails to load with "The specified module could not be
 * found." The vulkan variant works on the same NVIDIA GPU because the
 * Vulkan loader is shipped with the GPU driver — no separate runtime install
 * needed. So for NVIDIA Windows we try cuda first (best case) then fall
 * back to vulkan (always-works case). Empty list means CPU-only path.
 *
 * @param {GpuInfo|null} gpuInfo - Result of `GPUMonitor.detectGPU()`
 * @returns {string[]} Ordered variants to try; empty if CPU-only.
 */
function whisperVariantFor(gpuInfo) {
  if (!gpuInfo || gpuInfo.type === 'cpu') return [];
  const type = String(gpuInfo.type || '').toLowerCase();
  // macOS Metal is in the default arm64 package — no variant needed.
  if (process.platform === 'darwin') return [];
  if (type === 'cuda' || type === 'nvidia') return ['cuda', 'vulkan'];
  // AMD and Intel GPUs use Vulkan exclusively. A 'vulkan' label from
  // GPUMonitor means it already detected Vulkan capability.
  if (type === 'vulkan' || type === 'amd' || type === 'intel') return ['vulkan'];
  return [];
}

class WhisperService extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {string} [options.modelFilename] - GGML model filename (e.g. 'ggml-base.en.bin').
   * @param {string} [options.modelsDir] - Override for the models directory.
   * @param {GPUMonitor} [options.gpuMonitor] - Inject a GPUMonitor (testing).
   * @param {Object} [options.bindingOverride] - Inject a whisper binding (testing).
   * @param {{ transcodeToWhisperPcm?: Function }} [options.transcoderOverride] - Inject a transcoder (testing).
   * @param {WhisperFsPromises} [options.fsPromisesOverride] - Inject fs.promises (testing).
   * @param {Object} [options.memoryManagerOverride] - Inject a ModelMemoryManager
   *   instance (testing). When omitted the service tries to resolve the
   *   live LlamaService memory manager at load time and silently skips
   *   registration if none is available.
   * @param {number} [options.memoryEstimateBytes] - Override the size
   *   estimate published to the memory manager. Defaults to the on-disk
   *   model file size + 30% runtime/KV overhead.
   * @param {boolean} [options.enableVad=false] - Pre-process PCM through
   *   Silero VAD before transcription. Speeds up long-form audio 2-5×
   *   (silent stretches are skipped) and reduces hallucination on
   *   silence — a known whisper failure mode. Opt-in because the VAD
   *   companion model must be installed via
   *   `npm run setup:whisper-model -- --vad`.
   * @param {string} [options.vadModelFilename] - GGML Silero VAD model
   *   filename (default: 'ggml-silero-v5.1.2.bin').
   * @param {Object} [options.vadThresholds] - Override default VAD
   *   thresholds (`{threshold, minSpeechDurationMs, minSilenceDurationMs, speechPadMs}`).
   */
  constructor(options = {}) {
    super();
    this._modelFilename = options.modelFilename || DEFAULT_MODEL_FILENAME;
    this._modelsDirOverride = options.modelsDir || null;
    // Default to the process-wide singleton so GPU detection runs once per launch.
    this._gpuMonitor = options.gpuMonitor || getGPUMonitor();
    this._bindingOverride = options.bindingOverride || null;
    this._transcoderOverride = options.transcoderOverride || null;
    /** @type {WhisperFsPromises} */
    this._fs = /** @type {WhisperFsPromises} */ (options.fsPromisesOverride || fs);
    this._memoryManagerOverride = options.memoryManagerOverride || null;
    this._memoryEstimateOverride = Number.isFinite(options.memoryEstimateBytes)
      ? options.memoryEstimateBytes
      : null;

    this._enableVad = Boolean(options.enableVad);
    this._vadModelFilename = options.vadModelFilename || DEFAULT_VAD_MODEL_FILENAME;
    this._vadThresholds = { ...DEFAULT_VAD_THRESHOLDS, ...(options.vadThresholds || {}) };

    this._modelPath = /** @type {string|null} */ (null);
    this._vadModelPath = /** @type {string|null} */ (null);
    this._context = null;
    this._vadContext = null;
    this._loadPromise = null;
    this._vadLoadPromise = null;
    this._vadDisabledReason = null; // set when VAD load fails so we don't keep retrying
    this._gpuInfo = /** @type {GpuInfo|null} */ (null);
    this._isShuttingDown = false;
    // Bumped by every teardown (_releaseResources, i.e. shutdown AND evict).
    // _ensureLoaded captures it at the start of a load and re-checks before
    // caching, so a context built during a concurrent evict is released and
    // discarded instead of being cached/returned (use-after-free). evict()
    // deliberately does not set _isShuttingDown, so this is the only signal
    // that distinguishes "evicted mid-load" from a healthy load.
    this._loadGeneration = 0;
    // In-flight teardown latch: shutdown()/evict() share one _releaseResources
    // run instead of double-releasing the same native contexts.
    /** @type {Promise<void>|null} */
    this._teardownPromise = null;
    this._activeTranscriptions = new Set();
    this._cache = new Map(); // key -> { result, expiresAt }
    this._memoryRegistration = null; // { manager, type } once registered
    // Cache-miss dedup: when two callers race the same file before either
    // populates the cache, both would otherwise transcode + transcribe
    // independently. The whisper context is a single shared resource so
    // this also doubles model VRAM pressure during the overlap. Map keyed
    // on the same cacheKey the cache uses, holding the in-flight Promise
    // so a second arrival joins it instead of starting parallel work.
    this._pendingTranscriptions = new Map();
  }

  /**
   * Acquire the process-wide transcribe mutex. The chain lives at MODULE
   * scope (see `_transcribeChain` near the bottom of this file) so that
   * even if some future code instantiates a second WhisperService, all
   * callers still serialize against the single shared whisper.cpp
   * context. The chain is never reset by `shutdown()` for the same
   * reason: a fresh service must still wait for any in-flight native
   * call started by the prior instance.
   *
   * Returns a `release()` function the caller MUST invoke (in a finally)
   * once the underlying `transcribeData()` call has fully resolved or
   * rejected.
   * @private
   */
  async _acquireTranscribeLock() {
    const prev = _transcribeChain;
    // Initialized to no-op so the inferred type is `() => void` rather than
    // `(() => void) | undefined`. The Promise executor runs synchronously and
    // always reassigns release before the function returns, so the no-op is
    // never actually invoked — it's purely a type-narrowing aid for @ts-check.
    let release = () => {};
    _transcribeChain = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await prev;
    } catch {
      // Prior holder errored — still our turn. Swallow so the lock chain
      // stays advanceable.
    }
    return release;
  }

  /**
   * Resolve the absolute path to the configured GGML model file. Throws with
   * an actionable message if the file is missing so the caller can prompt the
   * user to run a setup script.
   */
  async _resolveModelPath() {
    if (this._modelPath) return this._modelPath;

    let baseDir = this._modelsDirOverride;
    if (!baseDir) {
      try {
        const resolved = await ensureResolvedModelsPath();
        baseDir = resolved.modelsPath;
      } catch (error) {
        const fallback =
          typeof app?.getPath === 'function' ? path.join(app.getPath('userData'), 'models') : null;
        if (!fallback) throw error;
        baseDir = fallback;
      }
    }

    const whisperDir = path.join(baseDir, WHISPER_SUBDIR);
    try {
      await this._fs.mkdir(whisperDir, { recursive: true });
    } catch {
      // Non-fatal in tests; the access check below will surface the real error.
    }

    const candidate = path.join(whisperDir, this._modelFilename);
    let primaryErrorMessage = 'unknown error';
    try {
      const stat = await this._fs.stat(candidate);
      if (!stat.isFile()) {
        throw new Error(`Path exists but is not a file: ${candidate}`);
      }
      this._modelPath = candidate;
      return this._modelPath;
    } catch (error) {
      primaryErrorMessage = error?.message || primaryErrorMessage;
    }

    // Cross-userData migration. simple-main.js:16 sets `app.name =
    // 'StratoSort Stack'` so app.getPath('userData') resolves to
    // %APPDATA%\StratoSort Stack\, but scripts/setup-whisper-model.js
    // computes its install dir from package.json `name` (lowercase) and
    // installs to %APPDATA%\stratosort-core\. modelPathResolver migrates
    // `.gguf` files automatically, but the Whisper model is `.bin` and
    // slips through that filter — `setup:whisper-model` reports success
    // while the running app raises LLAMA_MODEL_NOT_FOUND on the next
    // transcribe call. Walk the same legacy userData folders the GGUF
    // migration uses, find ggml-*.bin in models/whisper/, and copy it
    // into the resolved current dir so both layers agree.
    const migratedPath = await this._tryMigrateLegacyWhisperModel(this._modelFilename, whisperDir);
    if (migratedPath) {
      this._modelPath = migratedPath;
      return this._modelPath;
    }

    const wrapped = new Error(
      `Whisper model not found at ${candidate}. ` +
        `Run 'npm run setup:whisper-model' to install, or download the GGML model from ` +
        `https://huggingface.co/ggerganov/whisper.cpp and place it in ${whisperDir}. ` +
        `(${primaryErrorMessage})`
    );
    throw attachErrorCode(wrapped, ERROR_CODES.LLAMA_MODEL_NOT_FOUND);
  }

  /**
   * Walk the LEGACY_USERDATA_FOLDERS list from userDataMigration and migrate
   * `<legacy>/models/whisper/<filename>` into the supplied current
   * `whisperDir`. Returns the resolved current target path on success,
   * `null` if nothing was found. Best-effort — failures are logged at debug
   * and treated as "no legacy file available" so the caller falls through
   * to the normal LLAMA_MODEL_NOT_FOUND error path.
   *
   * Used by both the primary model and the VAD companion. Both are `.bin`
   * files which the GGUF-only migration in modelPathResolver does not
   * cover.
   * @param {string} modelFileName
   * @param {string} currentWhisperDir
   * @returns {Promise<string|null>}
   * @private
   */
  async _tryMigrateLegacyWhisperModel(modelFileName, currentWhisperDir) {
    let getLegacyUserDataPaths;
    try {
      ({ getLegacyUserDataPaths } = require('../core/userDataMigration'));
    } catch {
      return null;
    }
    if (typeof getLegacyUserDataPaths !== 'function') return null;

    let legacyPaths;
    try {
      legacyPaths = getLegacyUserDataPaths();
    } catch {
      return null;
    }
    if (!Array.isArray(legacyPaths) || legacyPaths.length === 0) return null;

    // Defense in depth: reject filenames that contain path separators or
    // traversal so a tampered package.json couldn't read outside userData.
    if (
      typeof modelFileName !== 'string' ||
      modelFileName.includes('/') ||
      modelFileName.includes('\\') ||
      modelFileName === '.' ||
      modelFileName === '..'
    ) {
      return null;
    }

    const targetPath = path.join(currentWhisperDir, modelFileName);
    for (const legacyUserData of legacyPaths) {
      const legacySource = path.join(legacyUserData, 'models', WHISPER_SUBDIR, modelFileName);
      try {
        // lstat (not stat) so a symlink in the legacy dir pointing outside
        // userData doesn't get followed by `copyFile` and silently extract
        // its target into the current models dir. Mirrors the same posture
        // in modelPathResolver.migrateLegacyModelsToCurrent.
        const lstat = await this._fs.lstat(legacySource);
        if (!lstat || typeof lstat.isFile !== 'function' || !lstat.isFile()) continue;
        await this._fs.mkdir(currentWhisperDir, { recursive: true });
        await this._fs.copyFile(legacySource, targetPath);
        logger.info('[Whisper] Migrated whisper model from legacy userData', {
          from: legacySource,
          to: targetPath
        });
        return targetPath;
      } catch (err) {
        logger.debug('[Whisper] Legacy candidate skipped', {
          legacySource,
          error: err?.message
        });
      }
    }
    return null;
  }

  /**
   * Lazily initialize the native binding and load the configured model.
   * Concurrent callers share a single in-flight load via `_loadPromise`.
   */
  async _ensureLoaded() {
    if (this._isShuttingDown) {
      const error = new Error('WhisperService is shutting down');
      throw attachErrorCode(error, ERROR_CODES.SERVICE_UNAVAILABLE);
    }
    if (this._context) return this._context;
    if (this._loadPromise) return this._loadPromise;

    /** @type {Promise<any>} */
    const loadPromise = (async () => {
      // Snapshot the teardown generation: if evict()/shutdown() runs while this
      // load is in flight, _loadGeneration changes and we must not cache or
      // return the context we build below.
      const loadGeneration = this._loadGeneration;
      const binding = this._bindingOverride || (await loadWhisperBinding());
      if (!binding || typeof binding.initWhisper !== 'function') {
        const error = new Error(
          '@fugood/whisper.node binding is unavailable or missing initWhisper().'
        );
        throw attachErrorCode(error, ERROR_CODES.SERVICE_UNAVAILABLE);
      }

      const modelPath = await this._resolveModelPath();
      this._gpuInfo = /** @type {GpuInfo} */ (
        await this._gpuMonitor.detectGPU().catch((err) => {
          logger.warn('[Whisper] GPU detection failed; falling back to CPU', {
            error: err?.message
          });
          return { type: 'cpu', name: 'CPU' };
        })
      );
      const useGpu = shouldUseGpu(this._gpuInfo);
      const variantChain = whisperVariantFor(this._gpuInfo);

      if (variantChain.includes('cuda')) {
        await ensureVisionRuntimeCudaDlls();
      }

      // Resolve the native package via require() to bypass the binding's
      // broken ESM-import variant loader (see loadNativeWhisperModule docs).
      // Test paths inject a fully-formed binding override and skip this.
      let resolvedVariant = 'default';
      let context;
      if (this._bindingOverride) {
        context = await binding.initWhisper(
          buildNativeContextOptions(modelPath, useGpu),
          variantChain[0]
        );
      } else {
        const nativeModule = loadNativeWhisperModule(variantChain);
        resolvedVariant = nativeModule._resolvedVariant;
        // The binding's WhisperContext is constructed with the same options
        // shape as the official initWhisper(opts) wrapper — we just skip
        // the broken module-loading indirection.
        context = new nativeModule.WhisperContext(buildNativeContextOptions(modelPath, useGpu));
      }

      logger.info('[Whisper] Loading model', {
        modelFilename: this._modelFilename,
        modelPath,
        useGpu,
        backend: this._gpuInfo?.type || 'cpu',
        variantChain,
        resolvedVariant
      });
      this._resolvedVariant = resolvedVariant;

      // Different bindings expose the loaded handle under slightly different
      // names; normalize so the rest of the service has one shape.
      const normalized = this._normalizeContext(context);
      // Concurrent-teardown guard: shutdown() OR evict() may have run while
      // this load was in flight. shutdown() sets _isShuttingDown; evict()
      // deliberately does not (it stays reloadable) but both bump
      // _loadGeneration via _releaseResources(). Either way the context we
      // just built is stale — evict() already released the previous handle and
      // nulled _context, so caching this one would leak it (VRAM/RAM) and
      // returning it would hand the caller a context a concurrent evict is
      // about to (or already did) release. Release it and bail; the next
      // _ensureLoaded() reloads cleanly.
      if (this._isShuttingDown || this._loadGeneration !== loadGeneration) {
        if (typeof normalized.release === 'function') {
          try {
            await normalized.release();
          } catch (releaseError) {
            logger.warn('[Whisper] Error releasing context after teardown race', {
              error: releaseError?.message
            });
          }
        }
        const error = new Error('WhisperService context torn down during load');
        throw attachErrorCode(error, ERROR_CODES.SERVICE_UNAVAILABLE);
      }
      this._context = normalized;
      // Register with the shared memory coordinator so a subsequent
      // vision/text load knows whisper is occupying VRAM and can evict
      // it under pressure. Best-effort — the coordinator is owned by
      // LlamaService and may not exist in every test/runtime environment.
      await this._registerWithMemoryManager(modelPath);
      // The registration awaited fs I/O (_computeMemoryEstimate) — repeat the
      // teardown check AFTER the load's last await: a shutdown() landing
      // inside it released `normalized`, yet without this the load still
      // returned the freed context to its awaiter and left a phantom 'audio'
      // consumer registered.
      if (this._isShuttingDown || this._loadGeneration !== loadGeneration) {
        if (this._context === normalized) {
          this._context = null;
        }
        // The teardown that raced us ran BEFORE the registration existed, so
        // it found nothing to unregister — drop the phantom 'audio' consumer
        // here (same shape as shutdown's unregister).
        if (this._memoryRegistration) {
          const { manager, type } = this._memoryRegistration;
          this._memoryRegistration = null;
          try {
            manager.unregisterExternalConsumer?.(type);
          } catch {
            /* best-effort */
          }
        }
        if (typeof normalized.release === 'function') {
          try {
            await normalized.release();
          } catch (releaseError) {
            logger.warn('[Whisper] Error releasing context after post-registration teardown', {
              error: releaseError?.message
            });
          }
        }
        const error = new Error('WhisperService context torn down during load');
        throw attachErrorCode(error, ERROR_CODES.SERVICE_UNAVAILABLE);
      }
      this.emit('loaded', {
        modelFilename: this._modelFilename,
        useGpu,
        backend: this._gpuInfo?.type || 'cpu'
      });
      return normalized;
    })().catch((error) => {
      // Compare-and-clear: this load may have lost a teardown race, after
      // which a NEWER load already owns the slot. Clearing unconditionally
      // would let a third caller start yet another concurrent native load,
      // and the loser's context would leak (VRAM) when both assign _context.
      if (this._loadPromise === loadPromise) {
        this._loadPromise = null;
      }
      throw error;
    });
    this._loadPromise = loadPromise;

    try {
      return await loadPromise;
    } finally {
      // On success, leave the context cached; on failure the catch above
      // has already cleared the promise so a retry can proceed.
      if (this._context && this._loadPromise === loadPromise) {
        this._loadPromise = null;
      }
    }
  }

  /**
   * @param {*} ctx - Raw context returned by initWhisper.
   * @returns {{ transcribeFile: Function, transcribeData: Function, release: Function|null }}
   * @private
   */
  _normalizeContext(ctx) {
    if (!ctx || typeof ctx !== 'object') {
      const error = new Error('initWhisper did not return a context object');
      throw attachErrorCode(error, ERROR_CODES.SERVICE_UNAVAILABLE);
    }

    const transcribeFile =
      typeof ctx.transcribeFile === 'function' ? ctx.transcribeFile.bind(ctx) : null;
    const transcribeData =
      typeof ctx.transcribeData === 'function' ? ctx.transcribeData.bind(ctx) : null;

    if (!transcribeData) {
      const error = new Error(
        'Whisper context is missing transcribeData(); incompatible binding version.'
      );
      throw attachErrorCode(error, ERROR_CODES.SERVICE_UNAVAILABLE);
    }

    // Some binding versions expose `release()`, others `dispose()` or `free()`.
    const releaseFn =
      (typeof ctx.release === 'function' && ctx.release.bind(ctx)) ||
      (typeof ctx.dispose === 'function' && ctx.dispose.bind(ctx)) ||
      (typeof ctx.free === 'function' && ctx.free.bind(ctx)) ||
      null;

    return { transcribeFile, transcribeData, release: releaseFn };
  }

  /**
   * Transcribe an arbitrary audio or video file. The file is decoded to
   * 16 kHz mono PCM via the bundled LGPL ffmpeg binary and passed to whisper.cpp.
   *
   * @param {string} mediaPath - Absolute path to a supported audio/video file.
   * @param {Object} [options]
   * @param {string} [options.language='en'] - ISO-639-1 language code.
   * @param {number} [options.temperature=0.0] - Sampling temperature.
   * @param {boolean} [options.translate=false] - Translate to English.
   * @param {AbortSignal} [options.signal] - Cancel mid-flight.
   * @param {boolean} [options.useCache=true] - Read/write the in-memory cache.
   * @returns {Promise<{ text: string, segments: Array<{start: number, end: number, text: string}>, language: string, durationSeconds: number, cached: boolean }>}
   */
  async transcribeMedia(mediaPath, options = {}) {
    if (typeof mediaPath !== 'string' || !mediaPath.trim()) {
      const error = new TypeError('[WhisperService] mediaPath must be a non-empty string');
      throw attachErrorCode(error, ERROR_CODES.INVALID_INPUT);
    }
    if (this._isShuttingDown) {
      const error = new Error('WhisperService is shutting down');
      throw attachErrorCode(error, ERROR_CODES.SERVICE_UNAVAILABLE);
    }
    const {
      language: requestedLanguage = 'en',
      temperature = 0.0,
      translate = false,
      signal,
      useCache = true
    } = options;
    // 'auto' lets whisper.cpp language-detect — but English-only models
    // (ggml-*.en.bin, the default) have no other languages to detect, and
    // passing 'auto' to them degrades output. Resolve before the cache key
    // so 'auto' and its resolution share a cache entry.
    const language =
      requestedLanguage === 'auto' && /\.en\.bin$/i.test(this._modelFilename)
        ? 'en'
        : requestedLanguage;

    const cacheKey = useCache
      ? await this._buildCacheKey(mediaPath, { language, translate, temperature })
      : null;
    if (cacheKey) {
      const cached = this._cacheGet(cacheKey);
      if (cached) {
        _clearWhisperUnavailable();
        return { ...cached, cached: true };
      }
      // Dedup window: if a previous caller for the same key is still
      // mid-flight, attach to its Promise. This is critical for the
      // bulk-import case where a watcher fires multiple analyze events for
      // the same file in quick succession (e.g., a save tool that touches
      // the file twice) — without this both would race the model context.
      // Skipped when useCache is false because a forced re-analysis caller
      // explicitly wants its own pass; joining an in-flight call would
      // return a stale (cached-by-the-other-caller) transcript.
      const pending = this._pendingTranscriptions.get(cacheKey);
      if (pending) {
        const result = await pending;
        // Clone: callers may mutate (e.g., normalize for downstream stages).
        return { ...result, cached: true };
      }
    }

    const work = (async () => {
      try {
        const transcoder = this._transcoderOverride?.transcodeToWhisperPcm || transcodeToWhisperPcm;
        /** @type {Buffer} */
        let pcm;
        /** @type {number} */
        let durationSeconds;
        let noAudioStream = false;
        try {
          ({ pcm, durationSeconds } = await transcoder(mediaPath, { signal }));
        } catch (transcodeError) {
          // A file with no audio stream (a silent screen recording) is not a
          // transcription failure: it gets the same empty transcript as a
          // file whose audio decodes to nothing, so media analysis records
          // "no speech" and still extracts keyframes.
          if (transcodeError?.code !== ERROR_CODES.MEDIA_NO_AUDIO_STREAM) throw transcodeError;
          noAudioStream = true;
          pcm = Buffer.alloc(0);
          durationSeconds = 0;
        }

        // A successful transcode that produced zero samples means the file
        // has no decodable audio (e.g. a video whose audio track is empty).
        // That is a no-speech result, not an input error — route it to the
        // same graceful empty-transcript shape the VAD no-speech path uses
        // instead of letting _transcribePcm throw INVALID_INPUT.
        if (pcm.length === 0) {
          logger.info(
            noAudioStream
              ? '[Whisper] Media has no audio stream; returning empty transcript'
              : '[Whisper] Media produced no audio samples; returning empty transcript',
            { mediaPath }
          );
          const empty = {
            text: '',
            /** @type {Array<{start: number, end: number, text: string}>} */
            segments: [],
            // Never emit the literal 'auto' — it's a detection request, not
            // a detected language. With no audio nothing was detected.
            language: language === 'auto' ? null : language,
            durationSeconds: 0,
            noAudioStream,
            cached: false
          };
          if (cacheKey) this._cacheSet(cacheKey, empty);
          _clearWhisperUnavailable();
          return empty;
        }

        const result = await this._transcribePcm(pcm, {
          language,
          temperature,
          translate,
          signal
        });

        const enriched = {
          text: result.text,
          segments: result.segments,
          // Fall back to the requested language only when it names a real
          // language; 'auto' is a detection request, not a result.
          language: result.language || (language === 'auto' ? null : language),
          durationSeconds: Math.round(durationSeconds * 100) / 100,
          cached: false
        };

        if (cacheKey) {
          this._cacheSet(cacheKey, enriched);
        }
        _clearWhisperUnavailable();
        return enriched;
      } catch (error) {
        // Surface init/setup failures (model missing, native binding unavailable,
        // ffmpeg unreachable) via the DegradedStateBanner so users get an
        // actionable signal instead of a per-file "analysis failed". Transient
        // ANALYSIS_FAILED and OPERATION_CANCELLED do not flip the banner —
        // those are per-file conditions, not subsystem-down.
        _maybeRaiseWhisperUnavailable(error);
        throw error;
      }
    })();
    if (cacheKey) {
      this._pendingTranscriptions.set(cacheKey, work);
      // Always remove from the pending map regardless of resolution outcome
      // so a transient failure doesn't poison subsequent attempts. The
      // .catch(() => {}) absorption is essential — without it Node logs an
      // unhandled-rejection warning when the awaiter handles it but the
      // tap-handler (this finally) is "additional" from the runtime's view.
      work.finally(() => this._pendingTranscriptions.delete(cacheKey)).catch(() => {});
    }
    return work;
  }

  /**
   * Lower-level transcription entry point. Accepts pre-decoded 16 kHz mono
   * PCM as a Buffer (s16le). When `enableVad` is true and the Silero VAD
   * model is available, the PCM is segmented by speech detection first and
   * each segment is transcribed independently — silent stretches are
   * skipped, cutting wall-clock time on long-form audio and reducing
   * whisper's hallucination on silence.
   *
   * @param {Buffer} pcm
   * @param {TranscribeOptions} [options]
   * @returns {Promise<{ text: string, segments: Array<{start: number, end: number, text: string}>, language: string|null }>}
   */
  async _transcribePcm(pcm, options = {}) {
    if (!Buffer.isBuffer(pcm) || pcm.length === 0) {
      const error = new TypeError('[WhisperService] pcm must be a non-empty Buffer');
      throw attachErrorCode(error, ERROR_CODES.INVALID_INPUT);
    }
    if (pcm.length % 2 !== 0) {
      const error = new Error('PCM buffer length must be a multiple of 2 bytes (s16le)');
      throw attachErrorCode(error, ERROR_CODES.INVALID_INPUT);
    }

    if (this._enableVad) {
      const vad = await this._ensureVadLoaded();
      if (vad) {
        return this._transcribePcmWithVad(pcm, vad, options);
      }
    }

    // Long-audio guard. Without VAD a multi-hour PCM goes to the binding
    // in one call, which whisper.cpp can OOM on. The transcoder caps
    // total length at MAX_PCM_BYTES_PER_HOUR * 4 hours ≈ 439 MB, but
    // there's no safety net between "fits in transcoder budget" and
    // "fits in transcribe budget". Slice by time and run sequentially.
    const durationSeconds = pcm.length / (WHISPER_SAMPLE_RATE * 2);
    if (durationSeconds > LONG_AUDIO_THRESHOLD_SECONDS) {
      return this._transcribePcmInChunks(pcm, durationSeconds, options);
    }

    return this._transcribePcmRaw(pcm, options);
  }

  /**
   * Slice a long PCM buffer into ~LONG_AUDIO_CHUNK_SECONDS-second chunks
   * and transcribe each via the standard raw path. Per-chunk segment
   * timestamps are rebased to the global timeline so the merged output
   * matches what a single-call transcription would have produced (minus
   * a small dedupe of boundary words across the overlap).
   * @private
   */
  /**
   * Strip words from the start of `nextText` that duplicate the tail of
   * `prevText`. A segment straddling a chunk boundary keeps its full text
   * in chunk N (only its END timestamp is clamped), and chunk N+1
   * re-transcribes the same words from the boundary onward — without this
   * the merged transcript repeats every boundary phrase.
   * Comparison is case/punctuation-insensitive; the longest match wins.
   * @param {string} prevText
   * @param {string} nextText
   * @param {number} [maxWords]
   * @returns {string}
   * @private
   */
  _stripLeadingOverlapWords(prevText, nextText, maxWords = 15) {
    const norm = (/** @type {string} */ w) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const prevWords = String(prevText || '')
      .split(/\s+/)
      .filter(Boolean);
    const nextWords = String(nextText || '')
      .split(/\s+/)
      .filter(Boolean);
    const limit = Math.min(maxWords, prevWords.length, nextWords.length);
    for (let k = limit; k > 0; k -= 1) {
      let match = true;
      for (let i = 0; i < k; i += 1) {
        if (norm(prevWords[prevWords.length - k + i]) !== norm(nextWords[i])) {
          match = false;
          break;
        }
      }
      if (match) return nextWords.slice(k).join(' ');
    }
    return nextText;
  }

  /**
   * @param {Buffer} pcm
   * @param {number} totalDurationSeconds
   * @param {TranscribeOptions} [options]
   * @returns {Promise<{ text: string, segments: Array<{start: number, end: number, text: string}>, language: string|null }>}
   * @private
   */
  async _transcribePcmInChunks(pcm, totalDurationSeconds, options = {}) {
    const { signal } = options;
    const allSegments = [];
    const textParts = [];
    let detectedLanguage = null;
    const chunkSize = LONG_AUDIO_CHUNK_SECONDS;
    const overlap = LONG_AUDIO_CHUNK_OVERLAP_SECONDS;

    logger.info('[Whisper] Long-audio chunking engaged', {
      totalDurationSeconds: Math.round(totalDurationSeconds),
      chunkSeconds: chunkSize,
      chunkCount: Math.ceil(totalDurationSeconds / chunkSize)
    });

    for (let cursor = 0; cursor < totalDurationSeconds; cursor += chunkSize) {
      if (signal?.aborted) {
        const error = new Error('Transcription cancelled');
        throw attachErrorCode(error, ERROR_CODES.OPERATION_CANCELLED);
      }
      const chunkStart = cursor;
      const chunkEnd = Math.min(totalDurationSeconds, cursor + chunkSize + overlap);
      const slice = this._slicePcmBySeconds(pcm, chunkStart, chunkEnd);
      if (slice.length === 0) continue;

      const piece = await this._transcribePcmRaw(slice, options);

      // Drop the trailing overlap from this chunk's segments so the next
      // chunk's leading words aren't double-counted. The overlap exists
      // to give whisper enough context at the chunk boundary; we discard
      // its TEXT but keep the audio as priming.
      const acceptUntil = Math.min(chunkSize, chunkEnd - chunkStart);
      for (const ws of piece.segments || []) {
        const wsStart = Number.isFinite(ws.start) ? ws.start : 0;
        if (wsStart > acceptUntil) continue;
        const wsEnd = Number.isFinite(ws.end) ? ws.end : wsStart;
        allSegments.push({
          start: chunkStart + wsStart,
          end: chunkStart + Math.min(wsEnd, acceptUntil),
          text: ws.text || ''
        });
      }
      // For the text concatenation we accept the full piece on the first
      // chunk (no prior overlap) and trim by the per-segment filter on
      // subsequent chunks via the segment loop above. Fall back to the
      // raw text only when segments are absent (binding edge case).
      if (Array.isArray(piece.segments) && piece.segments.length > 0) {
        let localText = piece.segments
          .filter((ws) => (Number.isFinite(ws.start) ? ws.start : 0) <= acceptUntil)
          .map((ws) => (ws.text || '').trim())
          .filter(Boolean)
          .join(' ');
        // Dedupe boundary words against the previous chunk's accepted text.
        if (localText && textParts.length > 0) {
          localText = this._stripLeadingOverlapWords(textParts[textParts.length - 1], localText);
        }
        if (localText) textParts.push(localText);
      } else if (typeof piece.text === 'string' && piece.text.trim()) {
        textParts.push(piece.text.trim());
      }
      if (!detectedLanguage && piece.language) detectedLanguage = piece.language;
    }

    return {
      text: textParts.join(' '),
      segments: allSegments,
      language: detectedLanguage
    };
  }

  /**
   * Run a single whisper.cpp transcription pass over the given PCM buffer.
   * The wrapper around the binding's stop/promise handle, abort
   * propagation, and result normalization is shared between the direct
   * path and the per-segment VAD path.
   * @param {Buffer} pcm
   * @param {TranscribeOptions} [options]
   * @returns {Promise<{ text: string, segments: Array<{start: number, end: number, text: string}>, language: string|null }>}
   * @private
   */
  async _transcribePcmRaw(pcm, options = {}) {
    let context = await this._ensureLoaded();
    const { language = 'en', temperature = 0.0, translate = false, signal } = options;

    // Hold a memory ref for the entire native call window. Acquired AFTER
    // _ensureLoaded so the underlying registration exists; released in the
    // outermost finally so the ref is dropped on every exit path —
    // including the cancellation early-returns and the malformed-handle
    // throw. Without this, a concurrent llama load that triggered
    // ModelMemoryManager._unloadLeastRecentlyUsed would fire whisper's
    // dispose callback (=> shutdown(), which aborts every active
    // transcription handle) right out from under this in-flight call.
    let releaseMemoryRef = this._holdMemoryRef();

    // Zero-ref eviction window: an evict can land in the microtask between
    // _ensureLoaded resolving and the ref above being taken (no refs held →
    // dispose runs immediately, and post-evict _holdMemoryRef degrades to a
    // no-op). The captured context would then be a freed native handle.
    // Re-validate synchronously — no awaits sit between the ref and this
    // check — and reload once if we lost the race.
    if (this._context !== context) {
      releaseMemoryRef();
      context = await this._ensureLoaded();
      releaseMemoryRef = this._holdMemoryRef();
      if (this._context !== context) {
        releaseMemoryRef();
        const error = new Error('Whisper model was evicted during transcription setup');
        throw attachErrorCode(error, ERROR_CODES.SERVICE_UNAVAILABLE);
      }
    }

    try {
      const release = await this._acquireTranscribeLock();
      // Re-check cancellation: a caller may have aborted while we were queued
      // behind another file. Bail before allocating a native handle.
      if (signal?.aborted) {
        release();
        const error = new Error('Transcription cancelled');
        throw attachErrorCode(error, ERROR_CODES.OPERATION_CANCELLED);
      }

      let handle;
      try {
        handle = context.transcribeData(pcmToArrayBuffer(pcm), {
          language,
          temperature,
          translate,
          // Defensive defaults — some bindings ignore unknown keys, others apply
          // them as whisper-cli flags. These keep behaviour deterministic.
          sampleRate: WHISPER_SAMPLE_RATE,
          channels: 1
        });
      } catch (error) {
        release();
        throw error;
      }

      if (!handle || typeof handle.promise?.then !== 'function') {
        release();
        const error = new Error('transcribeData did not return a { promise, stop } handle');
        throw attachErrorCode(error, ERROR_CODES.SERVICE_UNAVAILABLE);
      }

      this._activeTranscriptions.add(handle);
      let onAbort;
      if (signal) {
        onAbort = () => {
          try {
            if (typeof handle.stop === 'function') handle.stop();
          } catch {
            /* ignore */
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        const raw = await handle.promise;
        // handle.stop() makes some binding versions resolve with whatever
        // partial segments were decoded so far. Returning that on a cancel
        // would let transcribeMedia cache a truncated transcript as if it
        // were complete — treat any post-abort settle as cancellation.
        if (signal?.aborted) {
          const cancelError = new Error('Transcription cancelled');
          throw attachErrorCode(cancelError, ERROR_CODES.OPERATION_CANCELLED);
        }
        return this._normalizeResult(raw);
      } catch (error) {
        // A mid-flight cancel surfaces as the binding rejecting after
        // handle.stop(); without this check it would be re-tagged
        // ANALYSIS_FAILED and counted as a real failure upstream.
        if (signal?.aborted && error?.code !== ERROR_CODES.OPERATION_CANCELLED) {
          const cancelError = new Error('Transcription cancelled');
          throw attachErrorCode(cancelError, ERROR_CODES.OPERATION_CANCELLED);
        }
        throw attachErrorCode(error, ERROR_CODES.ANALYSIS_FAILED);
      } finally {
        this._activeTranscriptions.delete(handle);
        if (signal && onAbort) {
          try {
            signal.removeEventListener('abort', onAbort);
          } catch {
            /* defensive */
          }
        }
        release();
      }
    } finally {
      releaseMemoryRef();
    }
  }

  /**
   * Slice s16le PCM by sample offsets. PCM is 2 bytes per sample so we
   * convert sample indices to byte offsets and slice. Out-of-range values
   * are clamped — whisper.cpp tolerates a small under-allocation but
   * negative offsets would corrupt downstream bookkeeping.
   * @param {Buffer} pcm
   * @param {number} startSec
   * @param {number} endSec
   * @returns {Buffer}
   * @private
   */
  _slicePcmBySeconds(pcm, startSec, endSec) {
    const bytesPerSample = 2;
    const startByte = Math.max(
      0,
      Math.floor(Math.max(0, startSec) * WHISPER_SAMPLE_RATE) * bytesPerSample
    );
    const endByte = Math.min(
      pcm.length,
      Math.ceil(Math.max(0, endSec) * WHISPER_SAMPLE_RATE) * bytesPerSample
    );
    if (endByte <= startByte) return Buffer.alloc(0);
    // .subarray shares memory; safe because the slice is read-only inside
    // transcribeData and the parent buffer outlives the call.
    return pcm.subarray(startByte, endByte);
  }

  /**
   * Run VAD over the full PCM, transcribe each detected speech segment,
   * and merge the per-segment results into one transcript with global
   * timestamps. Falls back to a full-pcm transcription when VAD reports
   * no speech (rare — usually means a microphone-noise-only file).
   * @param {Buffer} pcm
   * @param {any} vad
   * @param {TranscribeOptions} [options]
   * @returns {Promise<{ text: string, segments: Array<{start: number, end: number, text: string}>, language: string|null }>}
   * @private
   */
  async _transcribePcmWithVad(pcm, vad, options = {}) {
    const { signal } = options;
    let segments;
    try {
      segments = await this._runVad(pcm, vad, signal);
    } catch (error) {
      logger.warn('[Whisper] VAD detection failed; falling back to full-pcm transcription', {
        error: error?.message
      });
      return this._transcribePcmRaw(pcm, options);
    }

    if (!Array.isArray(segments) || segments.length === 0) {
      logger.debug('[Whisper] VAD found no speech; transcribing full pcm anyway');
      return this._transcribePcmRaw(pcm, options);
    }

    const allSegments = [];
    const textParts = [];
    let detectedLanguage = null;

    for (const seg of segments) {
      if (signal?.aborted) {
        const error = new Error('Transcription cancelled');
        throw attachErrorCode(error, ERROR_CODES.OPERATION_CANCELLED);
      }
      const slice = this._slicePcmBySeconds(pcm, seg.start, seg.end);
      if (slice.length === 0) continue;
      // Even with VAD on, a pathological single talking-head segment can
      // exceed the 1-hour OOM threshold. Route those through the chunked
      // path; otherwise hand the full slice to the binding in one call
      // (the common case, since most speech segments are <60 seconds).
      const segDurationSeconds = slice.length / (WHISPER_SAMPLE_RATE * 2);
      const piece =
        segDurationSeconds > LONG_AUDIO_THRESHOLD_SECONDS
          ? await this._transcribePcmInChunks(slice, segDurationSeconds, options)
          : await this._transcribePcmRaw(slice, options);
      // Adjust per-segment timestamps from segment-relative to global by
      // adding the VAD chunk's start offset.
      for (const ws of piece.segments || []) {
        const wsStart = Number.isFinite(ws.start) ? ws.start : 0;
        const wsEnd = Number.isFinite(ws.end) ? ws.end : wsStart;
        allSegments.push({
          start: seg.start + wsStart,
          end: seg.start + wsEnd,
          text: ws.text || ''
        });
      }
      if (typeof piece.text === 'string' && piece.text.trim()) {
        textParts.push(piece.text.trim());
      }
      if (!detectedLanguage && piece.language) {
        detectedLanguage = piece.language;
      }
    }

    return {
      text: textParts.join(' '),
      segments: allSegments,
      language: detectedLanguage
    };
  }

  /**
   * Resolve the absolute path to the VAD GGML model. Returns null
   * (without throwing) if the file is missing — VAD is opt-in and the
   * caller falls back to plain transcription when unavailable.
   * @private
   */
  async _resolveVadModelPath() {
    if (this._vadModelPath) return this._vadModelPath;
    let baseDir = this._modelsDirOverride;
    if (!baseDir) {
      try {
        const resolved = await ensureResolvedModelsPath();
        baseDir = resolved.modelsPath;
      } catch {
        return null;
      }
    }
    const whisperDir = path.join(baseDir, WHISPER_SUBDIR);
    const candidate = path.join(whisperDir, this._vadModelFilename);
    try {
      const stat = await this._fs.stat(candidate);
      if (stat.isFile()) {
        this._vadModelPath = candidate;
        return candidate;
      }
    } catch {
      /* fall through to legacy migration */
    }

    // Same cross-userData migration as the primary model. The Silero VAD
    // .bin file is also installed by setup-whisper-model.js into
    // %APPDATA%\stratosort-core\… while the running app reads from
    // %APPDATA%\StratoSort Stack\…  Without this fall-through, opt-in
    // VAD silently disables itself on every fresh install with the
    // perverse outcome that the message logged is "VAD model not
    // found" while the file is right there in the legacy folder.
    const migratedPath = await this._tryMigrateLegacyWhisperModel(
      this._vadModelFilename,
      whisperDir
    );
    if (migratedPath) {
      this._vadModelPath = migratedPath;
      return migratedPath;
    }

    return null;
  }

  /**
   * Lazily initialize the Silero VAD context. Returns null on any
   * failure (binding doesn't expose initWhisperVad, model file missing,
   * load throws). Failures are sticky — `_vadDisabledReason` is set so
   * subsequent calls short-circuit instead of repeating expensive load
   * attempts on every transcription.
   * @private
   */
  async _ensureVadLoaded() {
    if (this._isShuttingDown) return null;
    if (this._vadContext) return this._vadContext;
    if (this._vadDisabledReason) return null;
    if (this._vadLoadPromise) return this._vadLoadPromise;

    // Same teardown-generation snapshot as _ensureLoaded: an evict() landing
    // mid-VAD-load must not leave the freshly built VAD context cached and
    // resident after the eviction that was supposed to free whisper's VRAM.
    const vadLoadGeneration = this._loadGeneration;
    const vadLoadPromise = (async () => {
      const binding = this._bindingOverride || (await loadWhisperBinding());
      if (!binding || typeof binding.initWhisperVad !== 'function') {
        this._vadDisabledReason = 'binding-missing-initWhisperVad';
        logger.debug('[Whisper] VAD unavailable; binding does not expose initWhisperVad');
        return null;
      }
      const modelPath = await this._resolveVadModelPath();
      if (!modelPath) {
        this._vadDisabledReason = 'vad-model-missing';
        logger.warn(
          '[Whisper] VAD requested but model not found. Run ' +
            '`npm run setup:whisper-model -- --vad` to install it.',
          { vadModelFilename: this._vadModelFilename }
        );
        return null;
      }
      try {
        // VAD must use the same native module as the main whisper context
        // so it picks up the same backend (CUDA/Vulkan/CPU). Bypass the
        // binding's broken ESM loader the same way as _ensureLoaded; fall
        // back to the binding's initWhisperVad only when a test override
        // is in play (test bindings expose initWhisperVad directly).
        const variantChain = whisperVariantFor(this._gpuInfo);
        let ctx;
        if (this._bindingOverride) {
          ctx = await binding.initWhisperVad(
            buildNativeVadContextOptions(modelPath, shouldUseGpu(this._gpuInfo)),
            variantChain[0]
          );
        } else {
          const nativeModule = loadNativeWhisperModule(variantChain);
          if (!nativeModule.WhisperVadContext) {
            this._vadDisabledReason = 'native-module-missing-WhisperVadContext';
            logger.debug(
              '[Whisper] VAD unavailable; native module does not expose WhisperVadContext'
            );
            return null;
          }
          ctx = new nativeModule.WhisperVadContext(
            buildNativeVadContextOptions(modelPath, shouldUseGpu(this._gpuInfo))
          );
        }
        const detect =
          (typeof ctx?.detectSpeechData === 'function' && ctx.detectSpeechData.bind(ctx)) ||
          (typeof ctx?.detect === 'function' && ctx.detect.bind(ctx));
        const release =
          (typeof ctx?.release === 'function' && ctx.release.bind(ctx)) ||
          (typeof ctx?.dispose === 'function' && ctx.dispose.bind(ctx)) ||
          null;
        if (!detect) {
          this._vadDisabledReason = 'vad-context-missing-detect';
          logger.warn('[Whisper] VAD context lacks detectSpeechData; disabling VAD path');
          return null;
        }
        // Concurrent-teardown guard (see _ensureLoaded): if shutdown() OR
        // evict() raced this load, release the freshly built native VAD
        // handle rather than caching and leaking it.
        if (this._isShuttingDown || this._loadGeneration !== vadLoadGeneration) {
          if (typeof release === 'function') {
            try {
              await release();
            } catch (releaseError) {
              logger.warn('[Whisper] Error releasing VAD context after shutdown race', {
                error: releaseError?.message
              });
            }
          }
          return null;
        }
        this._vadContext = { detect, release };
        logger.info('[Whisper] VAD model loaded', {
          vadModelFilename: this._vadModelFilename,
          modelPath
        });
        return this._vadContext;
      } catch (error) {
        this._vadDisabledReason = `init-failed:${error?.message || 'unknown'}`;
        logger.warn('[Whisper] VAD init failed; disabling VAD path', {
          error: error?.message
        });
        return null;
      }
    })().catch((error) => {
      // Identity-guarded clear (mirrors _ensureLoaded): a rejecting load that
      // raced teardown+reload must not clobber the NEW load's slot — that let
      // a third caller start a concurrent load and leak the first-assigned
      // native VAD context.
      if (this._vadLoadPromise === vadLoadPromise) {
        this._vadLoadPromise = null;
      }
      throw error;
    });
    this._vadLoadPromise = vadLoadPromise;

    try {
      return await vadLoadPromise;
    } finally {
      if (
        this._vadLoadPromise === vadLoadPromise &&
        (this._vadContext || this._vadDisabledReason)
      ) {
        this._vadLoadPromise = null;
      }
    }
  }

  /**
   * Run Silero VAD over the PCM buffer. Returns an array of
   * `{ start, end }` speech segments in seconds. The binding accepts
   * threshold parameters either as a separate arg or merged into the
   * options object depending on version — we pass them both ways.
   * @param {Buffer} pcm
   * @param {any} vad
   * @param {AbortSignal|undefined} signal
   * @private
   */
  async _runVad(pcm, vad, signal) {
    if (signal?.aborted) {
      const error = new Error('VAD cancelled');
      throw attachErrorCode(error, ERROR_CODES.OPERATION_CANCELLED);
    }
    // Hold memory ref for the same reason _transcribePcmRaw does — a
    // concurrent llama load mid-VAD would otherwise tear down our
    // VadContext via the registered dispose hook.
    const releaseMemoryRef = this._holdMemoryRef();
    // VAD shares the same thread-safety hazard as transcribeData: a
    // single shared native context behind `vad.detect()`. Two files
    // arriving simultaneously into the VAD-enabled path would race the
    // binding. Serialize via the module-scope chain.
    const release = await this._acquireVadLock();
    if (signal?.aborted) {
      release();
      releaseMemoryRef();
      const error = new Error('VAD cancelled');
      throw attachErrorCode(error, ERROR_CODES.OPERATION_CANCELLED);
    }
    // The caller captured `vad` well before the ref above was taken — an
    // evict in that zero-ref window (or while queued on the lock pre-ref
    // registration) freed it. Bail rather than call into a freed handle;
    // _transcribePcmWithVad's catch degrades to full-pcm transcription.
    if (this._vadContext !== vad) {
      release();
      releaseMemoryRef();
      const error = new Error('VAD model was evicted before detection started');
      throw attachErrorCode(error, ERROR_CODES.SERVICE_UNAVAILABLE);
    }
    try {
      const result = await vad.detect(pcmToArrayBuffer(pcm), {
        sampleRate: WHISPER_SAMPLE_RATE,
        ...this._vadThresholds
      });
      return this._normalizeVadResult(result);
    } finally {
      release();
      releaseMemoryRef();
    }
  }

  /** @private — paired with `_acquireTranscribeLock`, see top-of-file rationale. */
  async _acquireVadLock() {
    const prev = _vadChain;
    // See `_acquireTranscribeLock` for why this is initialized rather than `let release;`.
    let release = () => {};
    _vadChain = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await prev;
    } catch {
      /* prior holder errored — still our turn */
    }
    return release;
  }

  /**
   * Normalize the VAD binding's output into `[{ start, end }]` in seconds.
   * Different binding versions return either { segments: [...] } or a
   * flat array; segment shape is either { start, end } or { t0, t1 }
   * (centiseconds, matching the whisper segment convention).
   * @param {any} raw
   * @returns {Array<{start: number, end: number}>}
   * @private
   */
  _normalizeVadResult(raw) {
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : Array.isArray(raw.segments) ? raw.segments : [];
    const out = [];
    for (const seg of list) {
      if (!seg) continue;
      const start = Number.isFinite(seg.start)
        ? seg.start
        : Number.isFinite(seg.t0)
          ? seg.t0 / 100
          : null;
      const end = Number.isFinite(seg.end)
        ? seg.end
        : Number.isFinite(seg.t1)
          ? seg.t1 / 100
          : null;
      if (start === null || end === null || end <= start) continue;
      out.push({ start, end });
    }
    return out;
  }

  /**
   * Normalize the binding's transcription result into a stable shape. The
   * binding returns `{ result: '...', segments: [...] }` in current versions,
   * but older snapshots return `{ text, segments }` directly. Tolerate both.
   *
   * @param {any} raw
   * @returns {{ text: string, segments: Array<{start: number, end: number, text: string}>, language: string|null }}
   * @private
   */
  _normalizeResult(raw) {
    if (typeof raw === 'string') {
      return { text: raw, segments: [], language: null };
    }
    if (!raw || typeof raw !== 'object') {
      return { text: '', segments: [], language: null };
    }
    const text = typeof raw.result === 'string' ? raw.result : raw.text || '';
    const segments = Array.isArray(raw.segments)
      ? raw.segments.map((/** @type {any} */ seg) => ({
          start: typeof seg.t0 === 'number' ? seg.t0 / 100 : seg.start,
          end: typeof seg.t1 === 'number' ? seg.t1 / 100 : seg.end,
          text: seg.text || ''
        }))
      : [];
    const language = typeof raw.language === 'string' ? raw.language : null;
    return { text, segments, language };
  }

  /**
   * Build a deterministic cache key from file content (size + mtime + path)
   * plus the analysis options. Avoids re-transcribing the same file when
   * neither the bytes nor the request changed.
   *
   * @param {string} mediaPath
   * @param {Object} params
   * @returns {Promise<string|null>}
   * @private
   */
  async _buildCacheKey(mediaPath, params) {
    let stat;
    try {
      stat = await this._fs.stat(mediaPath);
    } catch {
      // If we can't stat, skip caching rather than blowing up.
      return null;
    }
    const hasher = crypto.createHash('sha256');
    // v2: VAD configuration is part of the key. Toggling VAD (or changing
    // its thresholds/model) changes the transcript materially — segment
    // boundaries, hallucination behavior on silence — so a v1 cache entry
    // produced under different VAD settings must not be served.
    hasher.update(`v2|${this._modelFilename}|`);
    hasher.update(
      this._enableVad
        ? `vad:${this._vadModelFilename}:${JSON.stringify(this._vadThresholds)}|`
        : 'vad:off|'
    );
    hasher.update(mediaPath);
    hasher.update(`|${stat.size}|${stat.mtimeMs}|`);
    hasher.update(JSON.stringify(params));
    return hasher.digest('hex');
  }

  /**
   * @param {string} key
   * @returns {any}
   * @private
   */
  _cacheGet(key) {
    const entry = this._cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this._cache.delete(key);
      return null;
    }
    return entry.result;
  }

  /**
   * @param {string} key
   * @param {any} result
   * @private
   */
  _cacheSet(key, result) {
    if (this._cache.size >= TRANSCRIBE_CACHE_MAX_ENTRIES) {
      // Drop the oldest entry to keep memory bounded. Map preserves insertion
      // order, so the first key is the oldest.
      const oldest = this._cache.keys().next().value;
      if (oldest !== undefined) this._cache.delete(oldest);
    }
    this._cache.set(key, { result, expiresAt: Date.now() + TRANSCRIBE_CACHE_TTL_MS });
  }

  /**
   * Returns true if the configured model file is present on disk and the
   * binding is loadable. Cheap probe used by IPC health checks.
   */
  async isAvailable() {
    if (this._isShuttingDown) return false;
    try {
      await this._resolveModelPath();
    } catch {
      return false;
    }
    try {
      const binding = this._bindingOverride || (await loadWhisperBinding());
      return !!(binding && typeof binding.initWhisper === 'function');
    } catch {
      return false;
    }
  }

  /**
   * Acquire a ref against the shared `ModelMemoryManager` for the lifetime
   * of an in-flight transcription so the manager's LRU evictor does not
   * tear down our native context while a `transcribeData()` / `vad.detect()`
   * call is in progress. The dispose hook registered in
   * `_registerWithMemoryManager` calls `shutdown()`, which would abort
   * every in-flight handle — fine when the user has *actually* paused
   * audio work, but catastrophic if a concurrent llama load triggered
   * eviction mid-transcribe.
   *
   * Returns a release function suitable for use in a `try/finally`. If
   * we have not yet registered (the typical case during the very first
   * `_ensureLoaded` call, or in tests that inject no memory manager),
   * the returned function is a no-op so callers can wire it
   * unconditionally.
   *
   * The ref bookkeeping is per-process via `ModelMemoryManager`, but the
   * `'audio'` key is whisper-specific — see `_registerWithMemoryManager`.
   * @private
   */
  _holdMemoryRef() {
    const registration = this._memoryRegistration;
    if (!registration || typeof registration.manager?.acquireRef !== 'function') {
      return () => {};
    }
    try {
      registration.manager.acquireRef(registration.type);
    } catch (error) {
      logger.debug('[Whisper] acquireRef failed (non-fatal)', { error: error?.message });
      return () => {};
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        registration.manager.releaseRef(registration.type);
      } catch (error) {
        logger.debug('[Whisper] releaseRef failed (non-fatal)', { error: error?.message });
      }
    };
  }

  /**
   * Resolve the live ModelMemoryManager from LlamaService, or return the
   * test override if one was injected. Returns null if neither is
   * available (e.g. LlamaService hasn't been initialized yet).
   * @private
   */
  _getMemoryManager() {
    if (this._memoryManagerOverride) return this._memoryManagerOverride;
    try {
      const { getInstance: getLlamaService } = require('./LlamaService');
      const llama = getLlamaService();
      // The manager is created lazily inside LlamaService.initialize();
      // it may not exist if a transcription is requested before any
      // text/vision/embedding model has been touched. That's fine —
      // we register on the next transcribe call.
      return llama?._modelMemoryManager || null;
    } catch {
      return null;
    }
  }

  /**
   * Compute the memory footprint to advertise to the coordinator.
   * Defaults to the on-disk model file size + ~30% for KV cache and
   * runtime allocations, matching the heuristic LlamaService uses for
   * text/vision/embedding models. Falls back to 200 MB when the file
   * size cannot be read (small enough to be conservative; whisper-base
   * is ~150 MB on disk).
   * @param {string} modelPath
   * @returns {Promise<number>}
   * @private
   */
  async _computeMemoryEstimate(modelPath) {
    if (this._memoryEstimateOverride !== null) {
      return this._memoryEstimateOverride;
    }
    try {
      const stat = await this._fs.stat(modelPath);
      if (stat?.size > 0) {
        return Math.ceil(stat.size * 1.3);
      }
    } catch {
      /* fall through to default */
    }
    return 200 * 1024 * 1024;
  }

  /**
   * Register this service's VRAM usage with the shared memory manager
   * so it participates in eviction decisions. Best-effort; failures are
   * logged at debug level since coordination is an optimization, not a
   * correctness invariant.
   * @param {string} modelPath
   * @private
   */
  async _registerWithMemoryManager(modelPath) {
    const manager = this._getMemoryManager();
    if (!manager || typeof manager.registerExternalConsumer !== 'function') {
      logger.debug('[Whisper] Memory manager unavailable; skipping registration');
      return;
    }
    if (this._memoryRegistration) return; // idempotent

    let sizeBytes;
    try {
      sizeBytes = await this._computeMemoryEstimate(modelPath);
    } catch (error) {
      logger.debug('[Whisper] Memory estimate failed; using fallback', {
        error: error?.message
      });
      sizeBytes = 200 * 1024 * 1024;
    }

    try {
      const dispose = async () => {
        // Manager has already removed the entry by the time it calls us;
        // mark our own bookkeeping so _releaseResources() doesn't try to
        // unregister again, then evict. Eviction releases the native context
        // but — unlike shutdown() — leaves the service reloadable, so a later
        // transcribeMedia() re-initializes the model instead of failing for
        // the rest of the process lifetime.
        this._memoryRegistration = null;
        await this.evict();
      };
      manager.registerExternalConsumer({
        type: 'audio',
        sizeBytes,
        dispose,
        label: `whisper:${this._modelFilename}`
      });
      this._memoryRegistration = { manager, type: 'audio' };
    } catch (error) {
      // Most likely a name collision with an existing 'audio' consumer;
      // safe to skip — the existing entry already represents whisper.
      logger.debug('[Whisper] registerExternalConsumer threw; coordination disabled', {
        error: error?.message
      });
    }
  }

  /**
   * Get a snapshot of service state — used by the diagnostics IPC channel.
   */
  getStatus() {
    return {
      modelFilename: this._modelFilename,
      modelPath: this._modelPath,
      loaded: !!this._context,
      backend: this._gpuInfo?.type || 'unknown',
      // The actual whisper.node variant package that resolved through
      // loadNativeWhisperModule's cuda → vulkan → default fallback chain.
      // null until first _ensureLoaded() call. Surfaced through the runtime
      // IPC info so users (and CI artifacts) can confirm GPU engagement
      // without grepping log lines.
      resolvedVariant: this._resolvedVariant || null,
      activeTranscriptions: this._activeTranscriptions.size,
      cacheSize: this._cache.size,
      vad: {
        enabled: this._enableVad,
        modelFilename: this._vadModelFilename,
        loaded: !!this._vadContext,
        disabledReason: this._vadDisabledReason
      }
    };
  }

  /**
   * Permanently shut the service down: release the loaded model, abort any
   * in-flight transcriptions, and latch `_isShuttingDown` so no further load
   * can occur. Idempotent. Used for app/container teardown. For the
   * memory-manager eviction path — which must stay reloadable — see evict().
   */
  async shutdown() {
    if (this._isShuttingDown) return;
    this._isShuttingDown = true;
    await this._releaseResources();
    logger.info('[Whisper] Service shut down');
  }

  /**
   * Release the native model to free VRAM under memory pressure while keeping
   * the service reloadable — the next `_ensureLoaded()` re-initializes the
   * model and re-registers with the shared memory manager. This is the path
   * the `ModelMemoryManager` dispose callback takes when a vision/text spawn
   * evicts the `'audio'` consumer mid-batch. Distinguishing this from
   * shutdown() is what stops a batch's images section from permanently
   * killing whisper before its media section runs. No-op once the service
   * has actually shut down (nothing left to reload).
   */
  async evict() {
    if (this._isShuttingDown) return;
    await this._releaseResources();
    logger.info('[Whisper] Model evicted under memory pressure (reloadable)');
  }

  /**
   * Shared teardown for shutdown() and evict(): abort in-flight
   * transcriptions, release the native + VAD contexts, drop the
   * memory-manager slot, and clear load state / caches. Deliberately does
   * NOT touch `_isShuttingDown` — the caller decides whether teardown is
   * terminal (shutdown) or reloadable (evict).
   * @private
   */
  async _releaseResources() {
    // Single-entry: shutdown() racing an in-flight evict() (or two evicts)
    // must await the SAME teardown, not run a second one that re-releases
    // the same native contexts (double-free risk in the binding).
    if (this._teardownPromise) return this._teardownPromise;
    const teardown = this._doReleaseResources().finally(() => {
      this._teardownPromise = null;
    });
    this._teardownPromise = teardown;
    return teardown;
  }

  /** @private */
  async _doReleaseResources() {
    // Invalidate any in-flight _ensureLoaded: a load that started before this
    // teardown must not cache/return the context we're about to release.
    this._loadGeneration += 1;
    // Capture and null the cached handles BEFORE the first await:
    // _ensureLoaded's fast path returns `this._context` synchronously, so a
    // non-null value during the async release window below would hand a new
    // transcription a context that is mid-free (use-after-free) — the
    // generation guard only protects loads, not the cached fast path.
    const context = this._context;
    const vadContext = this._vadContext;
    this._context = null;
    this._vadContext = null;
    this._loadPromise = null;
    this._vadLoadPromise = null;
    // Stop in-flight transcriptions so their promises settle before unload.
    for (const handle of this._activeTranscriptions) {
      try {
        if (typeof handle.stop === 'function') handle.stop();
      } catch {
        /* ignore */
      }
    }
    this._activeTranscriptions.clear();

    if (context && typeof context.release === 'function') {
      try {
        await context.release();
      } catch (error) {
        logger.warn('[Whisper] Error releasing context', { error: error?.message });
      }
    }
    if (vadContext && typeof vadContext.release === 'function') {
      try {
        await vadContext.release();
      } catch (error) {
        logger.warn('[Whisper] Error releasing VAD context', { error: error?.message });
      }
    }
    // Release the slot held in the shared memory coordinator so a
    // follow-up vision/text load sees the freed budget. Skipped if the
    // manager already evicted us (it cleared _memoryRegistration before
    // calling our dispose callback).
    if (this._memoryRegistration) {
      const { manager, type } = this._memoryRegistration;
      this._memoryRegistration = null;
      try {
        manager.unregisterExternalConsumer(type);
      } catch (error) {
        logger.debug('[Whisper] unregisterExternalConsumer threw', {
          error: error?.message
        });
      }
    }
    this._cache.clear();
    // Drop pending dedup entries so the Map doesn't keep their Promises
    // (and any captured `pcm` / `result` closures) alive past teardown.
    // The actual in-flight whisper handles were already aborted via
    // _activeTranscriptions above; the pending callers will still resolve
    // or reject from the upstream try/catch, just without a Map entry.
    this._pendingTranscriptions.clear();
  }
}

/** @type {{ getInstance: Function, createInstance: Function, registerWithContainer: Function, resetInstance: Function }} */
const { getInstance, createInstance, registerWithContainer, resetInstance } = /** @type {any} */ (
  createSingletonHelpers({
    ServiceClass: WhisperService,
    serviceId: 'WHISPER_SERVICE',
    serviceName: 'WhisperService',
    getContainer: () => require('./ServiceContainer'),
    shutdownMethod: 'shutdown'
  })
);

module.exports = {
  WhisperService,
  getInstance,
  createInstance,
  registerWithContainer,
  resetInstance,
  // Exposed for tests.
  _shouldUseGpu: shouldUseGpu,
  _whisperVariantFor: whisperVariantFor,
  _loadNativeWhisperModule: loadNativeWhisperModule,
  _augmentWindowsDllSearchPathForCuda,
  _detectInstalledCudaVersion,
  _collectCudaDllSearchDirs,
  _resetNativeWhisperCacheForTesting: () => {
    _cachedNativeModule = null;
    _windowsDllPathAugmented = false;
  },
  DEFAULT_MODEL_FILENAME,
  DEFAULT_VAD_MODEL_FILENAME,
  WHISPER_SUBDIR,
  DEFAULT_VAD_THRESHOLDS
};
