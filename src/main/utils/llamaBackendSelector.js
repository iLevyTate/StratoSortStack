// @ts-check
const normalizeGpuType = (/** @type {any} */ gpuInfo) => {
  if (!gpuInfo || typeof gpuInfo.type !== 'string') return null;
  return gpuInfo.type.toLowerCase();
};

const CPU_ONLY_OVERRIDE_VALUES = new Set(['cpu', 'false', '0', 'off']);
const SUPPORTED_BACKENDS = new Set(['auto', 'cuda', 'vulkan', 'metal']);

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
/** @param {any} [gpuInfo] */
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
 * @param {{ getLlama: Function, gpuInfo?: any, logger?: any, context?: any, llamaLogger?: any }} args
 */
async function initLlamaWithBackend({ getLlama, gpuInfo, logger, context, llamaLogger }) {
  const log = logger || console;
  const candidates = buildBackendCandidates(gpuInfo);
  /** @type {any[]} */
  const attempted = [];

  // Only attach `logger` when a filter is supplied so callers that don't pass
  // one keep the exact { gpu } option shape (and node-llama-cpp's defaults).
  const llamaOptions = (/** @type {any} */ gpu) =>
    llamaLogger ? { gpu, logger: llamaLogger } : { gpu };

  for (const backend of candidates) {
    try {
      const llama = await getLlama(llamaOptions(backend));
      const actualBackend =
        llama?.gpu === false ? 'cpu' : llama?.gpu || (backend === 'auto' ? 'cpu' : backend);
      attempted.push({ backend, success: true, actualBackend });

      log.info(`[${context}] Llama backend selected`, {
        requested: backend,
        actual: actualBackend,
        detectedGpu: gpuInfo?.name || gpuInfo?.type || 'unknown',
        attempted: attempted.map((entry) => ({
          backend: entry.backend,
          success: entry.success,
          actualBackend: entry.actualBackend,
          error: entry.error
        }))
      });

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
      attempted.push({
        backend,
        success: false,
        error: error?.message || String(error || 'Unknown error')
      });
      log.warn(`[${context}] Llama backend init failed`, {
        backend,
        error: error?.message || String(error || 'Unknown error')
      });
    }
  }

  // GPU init failed for all candidates, fall back to CPU explicitly
  try {
    const llama = await getLlama(llamaOptions(false));
    attempted.push({ backend: 'cpu', success: true, actualBackend: 'cpu' });
    log.warn(`[${context}] Falling back to CPU backend`, {
      detectedGpu: gpuInfo?.name || gpuInfo?.type || 'unknown',
      attempted: attempted.map((entry) => ({
        backend: entry.backend,
        success: entry.success,
        actualBackend: entry.actualBackend,
        error: entry.error
      }))
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
  getGpuBackendOverride,
  isExplicitSoftwareMode,
  normalizeRequestedBackend,
  resolveVisionRuntimeBackend,
  buildBackendCandidates,
  initLlamaWithBackend
};
