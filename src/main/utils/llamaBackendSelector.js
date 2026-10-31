// @ts-check
const { format: formatConsoleArgs } = require('util');

const normalizeGpuType = (/** @type {any} */ gpuInfo) => {
  if (!gpuInfo || typeof gpuInfo.type !== 'string') return null;
  return gpuInfo.type.toLowerCase();
};

const CPU_ONLY_OVERRIDE_VALUES = new Set(['cpu', 'false', '0', 'off']);
const SUPPORTED_BACKENDS = new Set(['auto', 'cuda', 'vulkan', 'metal']);
// Explicit GPU candidates whose prebuilt binary node-llama-cpp tests in a
// child process before accepting it. Anything slower than this per attempt is
// worth a warning in the log because it is where a startup stall hides.
const SLOW_BACKEND_ATTEMPT_WARN_MS = 10000;
const EXPLICIT_GPU_BACKENDS = new Set(['cuda', 'vulkan', 'metal']);
// Backends node-llama-cpp's `getLlamaGpuTypes('supported')` can rule out by
// checking for driver/runtime libraries. Metal is left alone: on macOS the
// library always reports it and the platform default already prefers it.
const SUPPORT_FILTERED_BACKENDS = new Set(['cuda', 'vulkan']);
// Leading "[node-llama-cpp] " as the library prints it, optionally wrapped in
// ANSI SGR colour codes (ESC [ ... m). Built from a template so the escape
// byte never appears in source.
const ANSI_SGR_RUN = `(?:${String.fromCharCode(27)}\\[[0-9;]*m)*`;
const NODE_LLAMA_CONSOLE_PREFIX = new RegExp(
  `^${ANSI_SGR_RUN}\\[node-llama-cpp\\]${ANSI_SGR_RUN}\\s*`
);

function getGpuBackendOverride() {
  const forced = String(process.env.STRATOSORT_LLM_GPU_BACKEND || '')
    .trim()
    .toLowerCase();
  if (!forced) return null;
  if (CPU_ONLY_OVERRIDE_VALUES.has(forced)) return 'cpu';
  return SUPPORTED_BACKENDS.has(forced) ? forced : null;
}

function isExplicitSoftwareMode() {
  return (
    process.argv.includes('--safe-mode') ||
    process.env.STRATOSORT_FORCE_SOFTWARE_GPU === '1' ||
    process.env.ELECTRON_FORCE_SOFTWARE === '1'
  );
}

/** @param {any} value */
function normalizeRequestedBackend(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) return 'auto';
  if (CPU_ONLY_OVERRIDE_VALUES.has(normalized)) return 'cpu';
  return SUPPORTED_BACKENDS.has(normalized) ? normalized : 'auto';
}

function getVisionRuntimeSupport(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') {
    return arch === 'arm64' ? ['cpu'] : ['cuda', 'vulkan', 'cpu'];
  }
  if (platform === 'darwin') {
    return ['metal', 'cpu'];
  }
  if (platform === 'linux') {
    return ['vulkan', 'cpu'];
  }
  return ['cpu'];
}

function getDefaultVisionRuntimeBackend(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') {
    return arch === 'arm64' ? 'cpu' : 'vulkan';
  }
  if (platform === 'darwin') {
    return 'metal';
  }
  if (platform === 'linux') {
    return 'vulkan';
  }
  return 'cpu';
}

/**
 * @param {{ gpuInfo?: any, preferredBackend?: string, platform?: NodeJS.Platform, arch?: NodeJS.Architecture }} args
 */
function resolveVisionRuntimeBackend({
  gpuInfo,
  preferredBackend = 'auto',
  platform = process.platform,
  arch = process.arch
} = {}) {
  const supported = getVisionRuntimeSupport(platform, arch);
  const requested = normalizeRequestedBackend(preferredBackend);
  const gpuType = normalizeGpuType(gpuInfo);
  const forcedOverride = getGpuBackendOverride();

  if (requested !== 'auto') {
    if (supported.includes(requested)) {
      return requested;
    }
    if (requested === 'cpu') {
      return 'cpu';
    }
  }

  // Fail safe on Linux: when detection reports CPU-only OR could not identify
  // a GPU at all (null/unknown — common on headless boxes and arm64 SBCs),
  // don't speculatively select Vulkan. The Vulkan runtime probes the driver at
  // load and crashes the helper process when none is present; CPU is slow but
  // always works. An explicit STRATOSORT_LLM_GPU_BACKEND override still wins.
  if (platform === 'linux' && !forcedOverride && (gpuType === 'cpu' || gpuType === null)) {
    return 'cpu';
  }

  const candidates = buildBackendCandidates(gpuInfo);
  for (const candidate of candidates) {
    const backend = candidate === false ? 'cpu' : normalizeRequestedBackend(candidate);
    if (backend === 'auto') {
      return getDefaultVisionRuntimeBackend(platform, arch);
    }
    if (supported.includes(backend)) {
      return backend;
    }
  }

  return getDefaultVisionRuntimeBackend(platform, arch);
}

/**
 * Build backend candidates for node-llama-cpp getLlama().
 * Prefer the confirmed GPU backend when detection is trustworthy. For unknown
 * or fallback-only detections, avoid speculative CUDA and stay on the safer
 * platform default before letting node-llama-cpp auto-negotiate CPU.
 */
/**
 * @param {any} [gpuInfo]
 * @returns {Array<string|false>}
 */
function buildBackendCandidates(gpuInfo) {
  if (isExplicitSoftwareMode()) {
    return [false];
  }

  // Optional override for text/embedding node-llama-cpp init (e.g. force CUDA when
  // WMI reports Vulkan-only but nvidia-smi works, or for exotic driver setups).
  const forced = getGpuBackendOverride();
  if (forced) {
    if (forced === 'cpu') return [false];
    if (forced === 'cuda') return ['cuda', 'vulkan', 'auto'];
    if (forced === 'vulkan') return ['vulkan', 'auto'];
    if (forced === 'metal') return ['metal', 'auto'];
    if (forced === 'auto') return ['auto'];
  }

  const gpuType = normalizeGpuType(gpuInfo);
  if (gpuType === 'cuda') return ['cuda', 'vulkan', 'auto'];
  if (gpuType === 'metal') return ['metal', 'auto'];
  if (gpuType === 'vulkan') return ['vulkan', 'auto'];
  const platform = process.platform;
  if (platform === 'darwin') return ['metal', 'auto'];
  return ['auto'];
}

/**
 * Drop GPU candidates that node-llama-cpp itself reports as unsupported on
 * this machine, so we never ask it to load (and child-process test) a prebuilt
 * binary whose runtime libraries are missing; the CUDA prebuilt on a box
 * without the CUDA runtime DLLs costs several seconds per attempt and always
 * fails. `supported` is the result of `getLlamaGpuTypes('supported')`, e.g.
 * `['vulkan', false]`.
 *
 * - `cuda` / `vulkan` are removed when `supported` does not list them.
 * - `metal` is never touched.
 * - A trailing `auto` is replaced by `false` (CPU) when the explicit GPU
 *   candidates that remain already cover every GPU type in `supported`:
 *   `auto` would only re-test those same binaries before landing on CPU.
 * - When no explicit GPU candidate remains, the non-GPU remainder (normally
 *   `['auto']`) is returned so node-llama-cpp still negotiates for itself.
 *
 * Pure; `buildBackendCandidates()` stays untouched so its chains stay pinned.
 *
 * @param {Array<string|false>} candidates
 * @param {Array<string|false>|null|undefined} supported
 * @returns {Array<string|false>}
 */
function filterCandidatesBySupport(candidates, supported) {
  if (!Array.isArray(candidates) || !Array.isArray(supported)) return candidates;

  const supportedGpuTypes = new Set(
    supported
      .filter((entry) => typeof entry === 'string')
      .map((entry) => /** @type {string} */ (entry).toLowerCase())
  );

  const filtered = candidates.filter((candidate) => {
    if (typeof candidate === 'string' && SUPPORT_FILTERED_BACKENDS.has(candidate)) {
      return supportedGpuTypes.has(candidate);
    }
    return true;
  });

  const remainingGpu = new Set(
    filtered.filter(
      (candidate) => typeof candidate === 'string' && EXPLICIT_GPU_BACKENDS.has(candidate)
    )
  );
  if (remainingGpu.size === 0) {
    return filtered.length > 0 ? filtered : ['auto'];
  }

  const autoAddsNothing = [...supportedGpuTypes].every((gpuType) => remainingGpu.has(gpuType));
  if (!autoAddsNothing) return filtered;
  return filtered.map((candidate) => (candidate === 'auto' ? false : candidate));
}

/**
 * Put the GPU backend that worked on the last launch (see
 * `utils/llamaBackendCache`) at the front of the candidate list, so it is the
 * one binary node-llama-cpp tests first.
 *
 * - A cached backend already in the list moves to the front; the rest keep
 *   their order.
 * - A cached backend missing from a list that contains `auto` is inserted at
 *   the front: `auto` would test that same binary, possibly after others.
 * - Anything else (no cached GPU backend, or a list without it or `auto`,
 *   such as CPU-only `[false]`) is returned unchanged.
 *
 * Pure. Apply it before `filterCandidatesBySupport()` so a cached backend
 * whose runtime libraries have since disappeared is still dropped.
 *
 * @param {Array<string|false>} candidates
 * @param {any} cachedBackend
 * @returns {Array<string|false>}
 */
function prioritizeCachedBackend(candidates, cachedBackend) {
  if (!Array.isArray(candidates)) return candidates;
  if (typeof cachedBackend !== 'string' || !EXPLICIT_GPU_BACKENDS.has(cachedBackend)) {
    return candidates;
  }
  if (candidates.includes(cachedBackend)) {
    return [cachedBackend, ...candidates.filter((candidate) => candidate !== cachedBackend)];
  }
  if (candidates.includes('auto')) return [cachedBackend, ...candidates];
  return candidates;
}

/**
 * node-llama-cpp reports prebuilt-binary problems ("The prebuilt ... is not
 * compatible with the current system", "Failed to load a prebuilt ...")
 * through console.warn/console.error rather than the `logger` option it
 * accepts, so they never reach the JSONL log. Route both console methods into
 * the structured logger for the duration of one getLlama() attempt. Returns
 * the restore function; the caller runs it in `finally`.
 *
 * @param {any} log
 * @param {string} context
 * @param {any} backend
 * @returns {() => void}
 */
/* eslint-disable no-console -- this helper exists to wrap the console */
function captureNodeLlamaConsole(log, context, backend) {
  if (!log || log === console) return () => {};

  const originalWarn = console.warn;
  const originalError = console.error;
  let forwarding = false;
  const forward = (/** @type {Function} */ original, /** @type {string} */ consoleLevel) =>
    function forwardedConsole(/** @type {any[]} */ ...args) {
      // Re-entrancy guard: a logger that itself mirrors to the console must
      // not loop back into this wrapper.
      if (forwarding) {
        original.apply(console, args);
        return;
      }
      forwarding = true;
      try {
        // The library prefixes its own lines with "[node-llama-cpp] " (gray via
        // chalk when colour is on). Only those lines are forwarded; Orama and
        // the other services initialise concurrently and anything they print
        // keeps its own channel and attribution.
        const text = formatConsoleArgs(...args);
        if (!NODE_LLAMA_CONSOLE_PREFIX.test(text)) {
          original.apply(console, args);
          return;
        }
        // Drop the library prefix so it is not doubled.
        const message = text.replace(NODE_LLAMA_CONSOLE_PREFIX, '');
        log.warn(`[${context}] [node-llama-cpp] ${message}`, {
          consoleLevel,
          backend
        });
      } catch {
        original.apply(console, args);
      } finally {
        forwarding = false;
      }
    };

  const wrappedWarn = forward(originalWarn, 'warn');
  const wrappedError = forward(originalError, 'error');
  console.warn = wrappedWarn;
  console.error = wrappedError;

  return () => {
    // Only undo our own wrapper; never clobber one installed after ours.
    if (console.warn === wrappedWarn) console.warn = originalWarn;
    if (console.error === wrappedError) console.error = originalError;
  };
}
/* eslint-enable no-console */

/**
 * `backendCache` is an optional last-known-good record (the object
 * `createLlamaBackendCache()` returns, or any `{ read, write, clear }` with the
 * same contract). When given, and neither STRATOSORT_LLM_GPU_BACKEND nor
 * software/safe mode chooses the backend, the cached backend is tried first;
 * a failed cached attempt clears the record, and a GPU backend that differs
 * from the record is saved for the next launch. Both read and write receive
 * this launch's supported-backend set, so a record saved before a runtime
 * appeared (Vulkan saved while CUDA was missing) is not used once it has.
 *
 * @param {{
 *   getLlama: Function,
 *   gpuInfo?: any,
 *   logger?: any,
 *   context?: any,
 *   llamaLogger?: any,
 *   getLlamaGpuTypes?: Function,
 *   backendCache?: { read: Function, write: Function, clear: Function } | null
 * }} args
 */
async function initLlamaWithBackend({
  getLlama,
  gpuInfo,
  logger,
  context,
  llamaLogger,
  getLlamaGpuTypes,
  backendCache
}) {
  const log = logger || console;
  let candidates = buildBackendCandidates(gpuInfo);
  /** @type {any[]} */
  const attempted = [];

  // Last launch's working GPU backend goes first so a matching machine tests
  // one binary instead of re-testing the ones that failed before. An explicit
  // override or software/safe mode picks the backend on purpose, so the record
  // is neither read nor updated then.
  const useBackendCache =
    !!backendCache &&
    typeof backendCache.read === 'function' &&
    !getGpuBackendOverride() &&
    !isExplicitSoftwareMode();
  // Ask node-llama-cpp which GPU backends have their driver/runtime libraries
  // present (a cheap file-existence probe, cached by the library). The answer
  // filters the candidates below and is part of the cached record's key, so
  // it is fetched before the record is read. An explicit
  // STRATOSORT_LLM_GPU_BACKEND override bypasses it for users who know their
  // setup better; a chain with no explicit GPU entry and no record to check
  // has no use for it.
  const hasExplicitGpuCandidate = (/** @type {Array<string|false>} */ list) =>
    list.some((candidate) => typeof candidate === 'string' && EXPLICIT_GPU_BACKENDS.has(candidate));
  /** @type {Array<string|false>|null} */
  let supported = null;
  if (
    typeof getLlamaGpuTypes === 'function' &&
    !getGpuBackendOverride() &&
    (useBackendCache || hasExplicitGpuCandidate(candidates))
  ) {
    try {
      const probed = await getLlamaGpuTypes('supported');
      supported = Array.isArray(probed) ? probed : null;
    } catch (error) {
      log.debug?.(`[${context}] node-llama-cpp supported-backend probe failed`, {
        error: error?.message || String(error || 'Unknown error')
      });
    }
  }

  /** @type {string|null} */
  let cachedBackend = null;
  let cachedRecordValid = false;
  if (useBackendCache) {
    try {
      const value = await backendCache.read({ supportedGpuTypes: supported });
      cachedBackend = typeof value === 'string' && EXPLICIT_GPU_BACKENDS.has(value) ? value : null;
    } catch (error) {
      log.debug?.(`[${context}] Cached Llama backend read failed`, {
        error: error?.message || String(error || 'Unknown error')
      });
    }
    if (cachedBackend) {
      cachedRecordValid = true;
      const prioritized = prioritizeCachedBackend(candidates, cachedBackend);
      log.info(`[${context}] Llama backend candidates ordered by cached selection`, {
        cachedBackend,
        candidates,
        prioritized,
        changed:
          prioritized.length !== candidates.length ||
          prioritized.some((c, i) => c !== candidates[i])
      });
      candidates = prioritized;
    }
  }

  // A cached backend that fails its attempt is wrong for this machine now;
  // drop the record so the next launch runs the plain ladder.
  const forgetCachedBackend = async (/** @type {any} */ backend, /** @type {any} */ error) => {
    if (!cachedRecordValid || backend !== cachedBackend) return;
    cachedRecordValid = false;
    // A read-only record (the embedding worker's) is left for its owner.
    if (typeof backendCache?.clear !== 'function') {
      log.info(`[${context}] Cached Llama backend failed; record left to its owner`, {
        backend,
        error: error?.message || String(error || 'Unknown error')
      });
      return;
    }
    try {
      await backendCache.clear();
    } catch {
      // The record is a hint; a stale one costs one failed attempt next time.
    }
    log.info(`[${context}] Cleared cached Llama backend after it failed`, {
      backend,
      error: error?.message || String(error || 'Unknown error')
    });
  };

  // Save a GPU backend the ladder settled on when it differs from the record.
  // CPU is never saved, and an unchanged record is not rewritten, so a steady
  // launch does no disk write here.
  const rememberBackend = async (/** @type {any} */ backend) => {
    if (!useBackendCache || typeof backendCache?.write !== 'function') return;
    if (typeof backend !== 'string' || !EXPLICIT_GPU_BACKENDS.has(backend)) return;
    if (cachedRecordValid && backend === cachedBackend) return;
    let saved;
    try {
      saved = (await backendCache.write(backend, { supportedGpuTypes: supported })) === true;
    } catch {
      saved = false;
    }
    if (saved) {
      log.info(`[${context}] Saved Llama backend selection for the next launch`, {
        backend,
        previous: cachedBackend
      });
    }
  };

  // Drop the explicit candidates node-llama-cpp ruled out. This runs after the
  // cached reorder so a cached backend inserted ahead of `auto` is checked
  // against the same probe.
  if (Array.isArray(supported) && hasExplicitGpuCandidate(candidates)) {
    const filtered = filterCandidatesBySupport(candidates, supported);
    log.info(`[${context}] Llama backend candidates filtered by node-llama-cpp support`, {
      supported,
      candidates,
      filtered,
      changed: filtered.length !== candidates.length || filtered.some((c, i) => c !== candidates[i])
    });
    candidates = filtered;
  }

  // Only attach `logger` when a filter is supplied so callers that don't pass
  // one keep the exact { gpu } option shape (and node-llama-cpp's defaults).
  const llamaOptions = (/** @type {any} */ gpu) =>
    llamaLogger ? { gpu, logger: llamaLogger } : { gpu };

  // One getLlama() attempt, timed, with node-llama-cpp's console output
  // forwarded into the structured log for its duration.
  const attemptGetLlama = async (/** @type {any} */ gpu) => {
    const startedAt = Date.now();
    const restoreConsole = captureNodeLlamaConsole(logger, context, gpu);
    try {
      const llama = await getLlama(llamaOptions(gpu));
      return { llama, durationMs: Date.now() - startedAt };
    } catch (error) {
      throw Object.assign(
        error instanceof Error ? error : new Error(String(error || 'Unknown error')),
        { durationMs: Date.now() - startedAt }
      );
    } finally {
      restoreConsole();
    }
  };

  const warnIfSlow = (/** @type {any} */ backend, /** @type {number} */ durationMs) => {
    if (durationMs > SLOW_BACKEND_ATTEMPT_WARN_MS) {
      log.warn(`[${context}] Llama backend attempt exceeded slow threshold`, {
        backend,
        durationMs,
        thresholdMs: SLOW_BACKEND_ATTEMPT_WARN_MS
      });
    }
  };

  const summarizeAttempts = () =>
    attempted.map((entry) => ({
      backend: entry.backend,
      success: entry.success,
      actualBackend: entry.actualBackend,
      durationMs: entry.durationMs,
      error: entry.error
    }));

  for (const backend of candidates) {
    try {
      const { llama, durationMs } = await attemptGetLlama(backend);
      const actualBackend =
        llama?.gpu === false ? 'cpu' : llama?.gpu || (backend === 'auto' ? 'cpu' : backend);
      attempted.push({ backend, success: true, actualBackend, durationMs });
      warnIfSlow(backend, durationMs);

      log.info(`[${context}] Llama backend selected`, {
        requested: backend,
        actual: actualBackend,
        durationMs,
        detectedGpu: gpuInfo?.name || gpuInfo?.type || 'unknown',
        attempted: summarizeAttempts()
      });
      await rememberBackend(actualBackend);

      return {
        llama,
        backend: actualBackend,
        selection: {
          attempted,
          selected: actualBackend,
          requested: backend,
          detectedGpu: gpuInfo || null
        }
      };
    } catch (error) {
      const durationMs = typeof error?.durationMs === 'number' ? error.durationMs : 0;
      attempted.push({
        backend,
        success: false,
        durationMs,
        error: error?.message || String(error || 'Unknown error')
      });
      warnIfSlow(backend, durationMs);
      log.warn(`[${context}] Llama backend init failed`, {
        backend,
        durationMs,
        error: error?.message || String(error || 'Unknown error')
      });
      await forgetCachedBackend(backend, error);
    }
  }

  // GPU init failed for all candidates, fall back to CPU explicitly
  try {
    const { llama, durationMs } = await attemptGetLlama(false);
    attempted.push({ backend: 'cpu', success: true, actualBackend: 'cpu', durationMs });
    warnIfSlow('cpu', durationMs);
    log.warn(`[${context}] Falling back to CPU backend`, {
      durationMs,
      detectedGpu: gpuInfo?.name || gpuInfo?.type || 'unknown',
      attempted: summarizeAttempts()
    });
    return {
      llama,
      backend: 'cpu',
      selection: {
        attempted,
        selected: 'cpu',
        requested: 'cpu',
        detectedGpu: gpuInfo || null
      }
    };
  } catch (error) {
    throw Object.assign(
      new Error(
        `Failed to initialize Llama backend (attempted: ${attempted
          .map((/** @type {any} */ entry) => entry.backend)
          .join(', ')})`
      ),
      {
        attempts: attempted,
        originalError: error
      }
    );
  }
}

module.exports = {
  SLOW_BACKEND_ATTEMPT_WARN_MS,
  getGpuBackendOverride,
  isExplicitSoftwareMode,
  normalizeRequestedBackend,
  resolveVisionRuntimeBackend,
  buildBackendCandidates,
  filterCandidatesBySupport,
  prioritizeCachedBackend,
  initLlamaWithBackend
};
