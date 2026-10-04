// @ts-check
const os = require('os');
const { spawn } = require('child_process');
const { setTimeout, clearTimeout } = require('timers');
const { getNvidiaSmiCommand, isMacOS } = require('../../shared/platformUtils');
const { createLogger } = require('../../shared/logger');
const { CONCURRENCY } = require('../../shared/performanceConstants');

const logger = createLogger('PerformanceService');
/**
 * PerformanceService
 * - Detects system capabilities (CPU threads, GPU availability)
 * - Tunes concurrency recommendations based on GPU availability
 * - Supports NVIDIA (CUDA), AMD (ROCm), Intel, and Apple Silicon (Metal) GPUs
 */

/** @type {Record<string, any>|null} */
let cachedCapabilities = null;

/**
 * Run a command with timeout and return stdout
 * @param {string} command - Command to run
 * @param {string[]} args - Command arguments
 * @param {number} timeout - Timeout in ms
 * @returns {Promise<{success: boolean, stdout: string}>}
 */
async function runCommand(command, args, timeout = 5000) {
  return new Promise((resolve) => {
    let resolved = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timeoutId = null;
    /** @type {any} */
    let proc = null;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (proc && !proc.killed) {
        try {
          proc.kill();
        } catch {
          // Process may have already exited
        }
      }
      // Ensure we release event listeners promptly (avoids retaining closures in edge cases).
      if (proc) {
        try {
          proc.stdout?.removeAllListeners?.();
          proc.stderr?.removeAllListeners?.();
          proc.removeAllListeners?.();
        } catch {
          // Non-fatal cleanup
        }
      }
    };

    const safeResolve = (/** @type {any} */ value) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(value);
    };

    try {
      proc = spawn(command, args, { windowsHide: true });

      timeoutId = setTimeout(() => {
        safeResolve({ success: false, stdout: '' });
      }, timeout);
      // Allow process to exit if this timer is the only thing keeping it alive
      // Critical for Jest test cleanup - the timeout still fires during Promise.race
      if (timeoutId.unref) {
        timeoutId.unref();
      }

      let stdout = '';
      proc.stdout.on('data', (/** @type {any} */ d) => {
        stdout += d.toString();
      });
      proc.stderr.on('data', () => {}); // Discard stderr

      proc.on('error', () => safeResolve({ success: false, stdout: '' }));
      proc.on('close', (/** @type {any} */ code) => {
        safeResolve({ success: code === 0, stdout: stdout.trim() });
      });
    } catch {
      // Intentionally handled: command may not exist on this system (e.g., nvidia-smi on non-NVIDIA)
      // Debug-level logging to avoid noise in logs for expected failures
      safeResolve({ success: false, stdout: '' });
    }
  });
}

/**
 * Detect NVIDIA GPU via nvidia-smi
 */
async function detectNvidiaGpu() {
  const result = await runCommand(getNvidiaSmiCommand(), [
    '--query-gpu=name,memory.total',
    '--format=csv,noheader,nounits'
  ]);

  if (result.success && result.stdout) {
    const lines = result.stdout.split(/\r?\n/);
    const first = lines[0] || '';
    const [name, mem] = first.split(',').map((s) => s && s.trim());
    return {
      vendor: 'nvidia',
      gpuName: name || 'NVIDIA GPU',
      gpuMemoryMB: Number(mem) || null
    };
  }
  return null;
}

/**
 * Detect AMD GPU via rocm-smi (Linux) or checking for AMD in device list
 */
async function detectAmdGpu() {
  // Try rocm-smi on Linux
  if (process.platform === 'linux') {
    const result = await runCommand('rocm-smi', ['--showmeminfo', 'vram', '--csv']);
    if (result.success && result.stdout) {
      // Parse rocm-smi output for VRAM
      const match = result.stdout.match(/(\d+)\s*$/m);
      const vramMB = match ? Math.floor(Number(match[1]) / (1024 * 1024)) : null;
      return {
        vendor: 'amd',
        gpuName: 'AMD GPU (ROCm)',
        gpuMemoryMB: vramMB
      };
    }
  }

  // On Windows, check for AMD GPU via WMIC (less reliable for VRAM)
  if (process.platform === 'win32') {
    const result = await runCommand('wmic', ['path', 'win32_VideoController', 'get', 'name']);
    if (result.success && /AMD|Radeon/i.test(result.stdout)) {
      return {
        vendor: 'amd',
        gpuName: 'AMD GPU',
        gpuMemoryMB: null // WMIC doesn't reliably report VRAM for AMD
      };
    }
  }
  return null;
}

/**
 * Detect Intel GPU (Arc, Iris, UHD)
 */
async function detectIntelGpu() {
  if (process.platform === 'win32') {
    const result = await runCommand('wmic', ['path', 'win32_VideoController', 'get', 'name']);
    if (result.success && /Intel.*(?:Arc|Iris|UHD|Graphics)/i.test(result.stdout)) {
      return /** @type {{ vendor: string, gpuName: string, gpuMemoryMB: number|null }} */ ({
        vendor: 'intel',
        gpuName: 'Intel GPU',
        gpuMemoryMB: null
      });
    }
  }

  if (process.platform === 'linux') {
    const result = await runCommand('lspci', []);
    if (result.success && /Intel.*(?:Arc|Iris|UHD|Graphics)/i.test(result.stdout)) {
      return /** @type {{ vendor: string, gpuName: string, gpuMemoryMB: number|null }} */ ({
        vendor: 'intel',
        gpuName: 'Intel GPU',
        gpuMemoryMB: null
      });
    }
  }
  return null;
}

/**
 * Detect Apple Silicon GPU (M1, M2, M3, M4)
 */
async function detectAppleGpu() {
  if (!isMacOS) return null;

  const result = await runCommand('sysctl', ['-n', 'machdep.cpu.brand_string']);
  if (result.success && /Apple M[1-9]/i.test(result.stdout)) {
    // Get unified memory size (shared between CPU and GPU on Apple Silicon)
    const memResult = await runCommand('sysctl', ['-n', 'hw.memsize']);
    const totalMemBytes = memResult.success ? Number(memResult.stdout) : 0;
    // Apple Silicon uses unified memory - estimate ~70% available for GPU
    const gpuMemoryMB = totalMemBytes ? Math.floor((totalMemBytes * 0.7) / (1024 * 1024)) : null;

    return {
      vendor: 'apple',
      gpuName: result.stdout.trim(),
      gpuMemoryMB
    };
  }
  return null;
}

/**
 * Detect any available GPU (NVIDIA, AMD, Intel, Apple)
 */
async function detectGpu() {
  logger.debug('[PerformanceService] Detecting GPU...');

  // Run all GPU detections in parallel to avoid sequential timeout stacking
  const [nvidia, apple, amd, intel] = await Promise.allSettled([
    detectNvidiaGpu(),
    detectAppleGpu(),
    detectAmdGpu(),
    detectIntelGpu()
  ]);

  // Return first successful detection in priority order
  if (nvidia.status === 'fulfilled' && nvidia.value) {
    logger.info('[PerformanceService] NVIDIA GPU detected', nvidia.value);
    return nvidia.value;
  }
  if (apple.status === 'fulfilled' && apple.value) {
    logger.info('[PerformanceService] Apple Silicon GPU detected', apple.value);
    return apple.value;
  }
  if (amd.status === 'fulfilled' && amd.value) {
    logger.info('[PerformanceService] AMD GPU detected', amd.value);
    return amd.value;
  }
  if (intel.status === 'fulfilled' && intel.value) {
    logger.info('[PerformanceService] Intel GPU detected', intel.value);
    return intel.value;
  }

  logger.debug('[PerformanceService] No GPU detected, using CPU-only mode');
  return null;
}

function normalizeGpuHint(/** @type {any} */ gpuHint) {
  if (!gpuHint || typeof gpuHint !== 'object') return undefined;

  const type = String(gpuHint.type || '').toLowerCase();
  const name = String(gpuHint.name || gpuHint.gpuName || '').trim();
  const parsedVram = Number(gpuHint.vramMB);
  const gpuMemoryMB = Number.isFinite(parsedVram) && parsedVram > 0 ? Math.floor(parsedVram) : null;

  if (type === 'cpu' || /cpu/i.test(name)) {
    return null;
  }

  let vendor = null;
  if (type === 'cuda' || /nvidia/i.test(name)) {
    vendor = 'nvidia';
  } else if (type === 'metal' || /apple/i.test(name)) {
    vendor = 'apple';
  } else if (/amd|radeon/i.test(name)) {
    vendor = 'amd';
  } else if (/intel|arc|iris|uhd/i.test(name)) {
    vendor = 'intel';
  }

  return {
    vendor,
    gpuName: name || 'GPU',
    gpuMemoryMB
  };
}

/** @param {{ gpuHint?: any }} [options] */
async function detectSystemCapabilities(options = {}) {
  if (cachedCapabilities) {
    logger.debug('[PerformanceService] Returning cached capabilities');
    return cachedCapabilities;
  }

  logger.info('[PerformanceService] Detecting system capabilities...');
  const cpuThreads = Array.isArray(os.cpus()) ? os.cpus().length : 4;
  const hintedGpu = normalizeGpuHint(options.gpuHint);
  const hasHint = typeof hintedGpu !== 'undefined';
  const gpu = hasHint ? hintedGpu : await detectGpu();

  if (hasHint) {
    logger.debug('[PerformanceService] Using provided GPU hint', {
      hasGpu: Boolean(gpu),
      gpuName: gpu?.gpuName || null,
      gpuMemoryMB: gpu?.gpuMemoryMB || null
    });
  }

  cachedCapabilities = {
    cpuThreads,
    hasGpu: gpu !== null,
    gpuVendor: gpu?.vendor ?? null,
    gpuName: gpu?.gpuName ?? null,
    gpuMemoryMB: gpu?.gpuMemoryMB ?? null,
    // Legacy compatibility
    hasNvidiaGpu: gpu?.vendor === 'nvidia'
  };

  logger.info('[PerformanceService] System capabilities detected', {
    cpuThreads,
    hasGpu: cachedCapabilities.hasGpu,
    gpuVendor: cachedCapabilities.gpuVendor,
    gpuName: cachedCapabilities.gpuName,
    gpuMemoryMB: cachedCapabilities.gpuMemoryMB
  });

  return cachedCapabilities;
}

/**
 * Get recommended max concurrent analysis based on system capabilities.
 *
 * Philosophy:
 * - Default to 1 for best UX (user sees progress immediately)
 * - Higher concurrency only benefits high-VRAM systems
 * - Vision models need ~4GB VRAM each, text ~2GB each
 * - Running multiple LLM calls on same GPU doesn't speed up each call
 *
 * @param {Record<string, any>} [options] - { gpuHint }
 * @returns {Promise<Record<string, any>>} Recommended concurrency settings
 */
async function getRecommendedConcurrency(options = {}) {
  const caps = await detectSystemCapabilities(options);
  const vram = caps.gpuMemoryMB || 0;
  const totalMemGB = os.totalmem() / 1024 / 1024 / 1024;
  const cpuThreads = caps.cpuThreads || 4;

  // Base recommendation on VRAM
  // - Vision analysis: ~4GB per instance
  // - Text analysis: ~2GB per instance
  // - Some overhead for OS/other apps: ~2GB
  let maxConcurrent = 1; // Default: sequential for best UX
  let reason;

  if (!caps.hasGpu) {
    // CPU only - keep at 1, it's slow anyway
    reason = 'CPU-only mode: sequential processing recommended';
  } else if (vram >= 24000) {
    // 24GB+ (3090/4090) - can run multiple vision analyses
    maxConcurrent = 3;
    reason = 'High VRAM (24GB+): can parallelize vision analysis';
  } else if (vram >= 16000) {
    // 16GB+ - some parallelism possible
    maxConcurrent = 2;
    reason = 'Good VRAM (16GB+): moderate parallelism safe';
  } else if (vram >= 12000) {
    // 12GB+ - limited parallelism for text only
    maxConcurrent = 2;
    reason = 'Adequate VRAM (12GB+): limited parallelism for text models';
  } else {
    // <12GB (including user's 6GB) - sequential only
    maxConcurrent = 1;
    reason = 'Limited VRAM (<12GB): sequential processing prevents exhaustion';
  }

  // Additional safety caps so we don't overwhelm smaller systems even if VRAM is high.
  // CPU: avoid running more concurrent analyses than the machine can realistically schedule.
  // Using ~4 threads per analysis keeps the UI responsive and reduces context switching overhead.
  const cpuCap = Math.max(1, Math.floor(cpuThreads / 4));
  if (maxConcurrent > cpuCap) {
    maxConcurrent = cpuCap;
    reason = `${reason} (capped by CPU threads)`;
  }

  // RAM: if total system RAM is low, keep concurrency conservative to prevent paging/OS pressure.
  if (totalMemGB > 0 && totalMemGB < 12) {
    if (maxConcurrent > 1) {
      maxConcurrent = 1;
      reason = `${reason} (capped by system RAM <12GB)`;
    }
  }

  // Embedding concurrency — embeddings use a tiny model (~140MB VRAM) compared to
  // text/vision (2-4GB), so GPU systems can safely run many more embedding requests
  // in parallel without exhausting VRAM.
  let embeddingConcurrency = 1;
  if (caps.hasGpu) {
    if (vram >= 24000) {
      embeddingConcurrency = 6;
    } else if (vram >= 16000) {
      embeddingConcurrency = 5;
    } else if (vram >= 12000) {
      embeddingConcurrency = 4;
    } else if (vram >= 8000) {
      embeddingConcurrency = 3;
    } else if (vram >= 4000) {
      // 4-8GB GPUs (e.g. RTX 4050 6GB): the embedding model is ~140MB, so two
      // parallel embedding requests fit comfortably even when text/vision
      // analysis must stay sequential. This keeps embedding throughput from
      // collapsing to 1 on the most common consumer laptop GPUs.
      embeddingConcurrency = 2;
    }
  }

  return {
    maxConcurrent,
    embeddingConcurrency,
    reason,
    // null when the probe could not read GPU memory (AMD, Intel, lspci-only
    // Linux); the wizard's recommender tells that apart from a real 0.
    vramMB: Number.isFinite(caps.gpuMemoryMB) && caps.gpuMemoryMB > 0 ? caps.gpuMemoryMB : null,
    hasGpu: caps.hasGpu,
    gpuName: caps.gpuName,
    cpuThreads,
    totalMemGB: Math.round(totalMemGB * 10) / 10
  };
}

/**
 * Resolve the effective analysis concurrency given the user's auto/manual choice.
 *
 * - Auto (default): always defer to the live hardware recommendation. This is
 *   the "hardware-aware" behavior — the user's manual number is ignored.
 * - Manual (autoConcurrency === false): honor the user's explicit value (the
 *   power-user escape hatch), clamped to [MIN_WORKERS, MAX_WORKERS]. Runtime
 *   backpressure (queue pressure, memory) still applies downstream — this only
 *   controls whether the *static* hardware cap is enforced.
 *
 * @param {{ autoConcurrency?: boolean, manualValue?: number, recommendedMax?: number }} [params]
 * @returns {number} Effective concurrency, always >= 1
 */
function resolveEffectiveConcurrency({
  autoConcurrency = true,
  manualValue,
  recommendedMax = 0
} = {}) {
  const recMax =
    Number.isFinite(recommendedMax) && recommendedMax > 0
      ? recommendedMax
      : CONCURRENCY.DEFAULT_WORKERS;

  if (autoConcurrency !== false) {
    return Math.max(CONCURRENCY.MIN_WORKERS, recMax);
  }

  const manual = Math.round(Number(manualValue));
  if (!Number.isFinite(manual) || manual < CONCURRENCY.MIN_WORKERS) {
    return Math.max(CONCURRENCY.MIN_WORKERS, recMax);
  }
  return Math.max(CONCURRENCY.MIN_WORKERS, Math.min(manual, CONCURRENCY.MAX_WORKERS));
}

module.exports = {
  detectSystemCapabilities,
  getRecommendedConcurrency,
  resolveEffectiveConcurrency
};
