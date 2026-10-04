// @ts-check
/**
 * DegradationManager — central decision-maker for "what do we skip when
 * the LLM stack is in trouble?".
 *
 * Watches GPU availability, model-load failures, and the model registry
 * to decide whether to: fall back to CPU, mark a model missing, suppress
 * embeddings, or surface a user-facing warning. Produces a degradation
 * snapshot the renderer reads to render the degraded-state badge and to
 * decide whether to short-circuit specific operations like batch
 * embedding.
 */
const { createLogger } = require('../../shared/logger');
const { getInstance: getGPUMonitor } = require('./GPUMonitor');
const { getInstance: getModelDownloadManager } = require('./ModelDownloadManager');
const {
  looksLikeCorruptGguf,
  looksLikeVramExhausted,
  looksLikeMmapFailure
} = require('../../shared/llamaErrorClassifier');
const logger = createLogger('DegradationManager');

class DegradationManager {
  constructor(/** @type {any} */ llamaService) {
    this._llamaService = llamaService;
    this._gpuMonitor = getGPUMonitor();
    this._downloadManager = getModelDownloadManager();
    this._degradationState = {
      gpuAvailable: true,
      usingCPUFallback: false,
      missingModels: [],
      warnings: []
    };
  }

  /**
   * Check system readiness and determine degradation level
   */
  async checkSystemReadiness() {
    // Guard against null llamaService (singleton getInstance() may create
    // the manager before LlamaService is available).
    if (!this._llamaService) {
      return {
        ready: false,
        issues: [
          { type: 'no_llama_service', message: 'LlamaService not available', severity: 'error' }
        ],
        /** @type {any[]} */
        warnings: [],
        degradationState: this._degradationState
      };
    }

    // Reset transient degraded state at the top of every check. Without this,
    // `missingModels` was only ever appended to (line 76), so after a user
    // installed a previously-missing model and re-ran the check, the array
    // stayed populated forever and `attemptRecovery()` permanently returned
    // canRecover:false. Reset both here so the check accurately reflects
    // current state, not the union of every prior run.
    this._degradationState.missingModels = [];
    this._degradationState.warnings = [];

    const issues = [];
    const warnings = [];

    // Check GPU
    const gpuInfo = /** @type {Record<string, any>} */ (await this._gpuMonitor.detectGPU());
    if (gpuInfo.type === 'cpu') {
      warnings.push({
        type: 'no_gpu',
        message: 'No GPU detected. AI features will run on CPU (slower).',
        severity: 'warning'
      });
      this._degradationState.gpuAvailable = false;
    }

    // Check models
    const downloadedModels = await this._downloadManager.getDownloadedModels();
    const downloadedNames = new Set(downloadedModels.map((/** @type {any} */ m) => m.filename));

    const missingRequired = [];
    // without arguments). Also guard _selectedModels to avoid TypeError.
    const selectedModels = this._llamaService?._selectedModels;
    if (selectedModels) {
      if (selectedModels.embedding && !downloadedNames.has(selectedModels.embedding)) {
        missingRequired.push('embedding');
      }
      if (selectedModels.text && !downloadedNames.has(selectedModels.text)) {
        missingRequired.push('text');
      }
    }

    if (missingRequired.length > 0) {
      issues.push({
        type: 'missing_models',
        models: missingRequired,
        message: `Required models not downloaded: ${missingRequired.join(', ')}`,
        severity: 'error',
        action: 'download_models'
      });
      this._degradationState.missingModels = missingRequired;
    }

    // Check disk space
    const spaceCheck = await this._downloadManager.checkDiskSpace(1024 * 1024 * 1024); // 1GB minimum
    if (!spaceCheck.sufficient) {
      warnings.push({
        type: 'low_disk_space',
        message: 'Low disk space. Some features may not work.',
        severity: 'warning'
      });
    }

    this._degradationState.warnings = warnings;

    return {
      ready: issues.length === 0,
      issues,
      warnings,
      gpuInfo,
      degradationState: this._degradationState
    };
  }

  /**
   * Handle a specific error and determine recovery action
   */
  /** @param {any} error @param {{ modelType?: string }} [context] */
  async handleError(error, context = {}) {
    // Coalesce robustly: workers and IPC layers occasionally reject with a
    // bare string or a plain object instead of an Error. `error.message` is
    // then undefined and the legacy `(error.message || '')` collapsed to ''
    // — every classifier check missed and the request fell into the silent
    // unknown-error branch. Using String() on the error itself preserves the
    // text so the patterns can match.
    const message = String(error?.message ?? error ?? '').toLowerCase();

    // Persistent GPU memory pressure errors should switch to CPU fallback.
    // Use the shared classifier so main and renderer stay aligned on which
    // signatures count as VRAM exhaustion. The legacy substring list below
    // covers a few broader hints ('unable to allocate', 'failed to allocate',
    // bare 'vram') that the classifier patterns intentionally don't match,
    // so we OR them together.
    const persistentGpuPressure =
      looksLikeVramExhausted(error) ||
      message.includes('unable to allocate') ||
      message.includes('failed to allocate') ||
      message.includes('buffer allocation failed') ||
      message.includes('vram');
    if (persistentGpuPressure) {
      logger.warn('[Degradation] GPU memory error, attempting recovery');

      // Update state so attemptRecovery() knows to try re-enabling GPU later
      this._degradationState.usingCPUFallback = true;
      this._degradationState.gpuAvailable = false;

      return {
        action: 'retry_with_cpu',
        message: 'GPU memory exhausted. Switching to CPU mode.',
        shouldNotifyUser: true
      };
    }

    // Transient backend faults should retry primary backend first.
    if (
      message.includes('metal error') ||
      message.includes('metal device') ||
      message.includes('no metal') ||
      message.includes('vulkan error') ||
      message.includes('vk_error') ||
      message.includes('cuda error')
    ) {
      logger.warn('[Degradation] Transient GPU backend error; retrying primary path first');
      return {
        action: 'retry_same_backend',
        message: 'Transient GPU backend error detected. Retrying primary path.',
        shouldNotifyUser: false
      };
    }

    // Genuinely-corrupt GGUF: only emit the redownload guidance when the
    // error message contains a real integrity signal (invalid magic, GGUF
    // header mismatch, unexpected EOF, parser failure). The native addon
    // throws a generic "Failed to load model" for many unrelated causes —
    // VRAM contention, init races, file-handle issues — so matching that
    // alone caused false-positive "Model corrupted, please redownload"
    // messages whenever a load attempt happened to fail under VRAM pressure.
    // mmap failures get the same redownload action since the remediation
    // path (reset model files) is the same and the resilience layer cannot
    // recover from a busted mmap.
    if (looksLikeCorruptGguf(error) || looksLikeMmapFailure(error)) {
      logger.error('[Degradation] Model file integrity failure detected', {
        message: error?.message
      });

      return {
        action: 'redownload_model',
        message: 'Model file may be corrupted. Please re-download.',
        shouldNotifyUser: true,
        modelType: context.modelType
      };
    }

    // Generic "Failed to load model" without a specific signal — most
    // production occurrences are transient VRAM contention from a sibling
    // process (e.g. the vision server) holding allocations during a
    // text-model load. Tag the error with a 'transient_load_failure' action
    // so LlamaService can attach `_degradationAction` and withLlamaResilience
    // can run a single retry with backoff + vision recheck.
    //
    // We do NOT add 'failed to load model' to RETRYABLE_LLAMA_ERRORS directly
    // — that would retry permanent failures (e.g., file deleted post-startup)
    // 3 times before surfacing. The named action lets resilience apply a
    // narrower recovery policy.
    if (message.includes('failed to load model')) {
      logger.warn('[Degradation] Generic model load failure; tagging for transient-load recovery', {
        message: error?.message
      });
      return {
        action: 'transient_load_failure',
        message: 'Model load failed; one retry queued.',
        shouldNotifyUser: false,
        originalError: error
      };
    }

    // Disk error
    if (message.includes('enospc') || message.includes('no space left')) {
      return {
        action: 'cleanup_disk',
        message: 'Disk full. Please free up space.',
        shouldNotifyUser: true
      };
    }

    // Unknown error — log so a novel failure mode surfaces in production
    // logs even though we don't have a recovery action. Stack first so we
    // capture programming errors (TypeError, etc.) that lose context if we
    // only print message.
    logger.error('[Degradation] Unclassified error from caller; no recovery action available', {
      modelType: context.modelType,
      error: error?.stack || error?.message || String(error)
    });
    return {
      action: 'none',
      message: 'An unexpected error occurred.',
      shouldNotifyUser: false,
      originalError: error
    };
  }

  /**
   * Get current degradation state for UI
   */
  getDegradationState() {
    return { ...this._degradationState };
  }

  /**
   * Attempt to recover from degraded state
   */
  async attemptRecovery() {
    if (this._degradationState.missingModels.length > 0) {
      return {
        canRecover: false,
        action: 'download_models',
        message: 'Please download required models to continue.'
      };
    }

    if (this._degradationState.usingCPUFallback) {
      // Try to re-enable GPU
      const gpuInfo = /** @type {Record<string, any>} */ (await this._gpuMonitor.detectGPU());
      if (gpuInfo.type !== 'cpu') {
        this._degradationState.usingCPUFallback = false;
        this._degradationState.gpuAvailable = true;
        return {
          canRecover: true,
          action: 'gpu_restored',
          message: 'GPU access restored.'
        };
      }
    }

    return {
      canRecover: true,
      action: 'none',
      message: 'System operating normally.'
    };
  }
}

// Singleton
/** @type {DegradationManager|null} */
let instance = null;
/**
 * Get or create the DegradationManager singleton.
 *
 * @param {Record<string, any>} [llamaService] - LlamaService instance. Required on first
 *   call so the manager can inspect `_selectedModels` during readiness checks.
 *   Subsequent calls may omit it; the original reference is preserved.
 * @returns {DegradationManager}
 */
function getInstance(llamaService) {
  if (!instance) {
    instance = new DegradationManager(llamaService);
  } else if (llamaService && !instance._llamaService) {
    // before the LlamaService was available (e.g., during startup).
    instance._llamaService = llamaService;
  }
  return instance;
}

module.exports = { DegradationManager, getInstance };
