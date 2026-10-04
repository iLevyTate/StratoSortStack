// @ts-check
/**
 * LlamaService - In-process LLM using node-llama-cpp
 *
 * Fully in-process GGUF model inference service.
 * Supports Metal (macOS), CUDA (Windows/Linux), Vulkan, and CPU fallback.
 * Integrates resilience, memory management, and performance tracking.
 *
 * @module services/LlamaService
 */

const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const { app } = require('electron');
const { EventEmitter } = require('events');
const { createLogger } = require('../../shared/logger');
const { createSingletonHelpers } = require('../../shared/singletonFactory');
const { AI_DEFAULTS, DEFAULT_AI_MODELS } = require('../../shared/constants');
const { getModel } = require('../../shared/modelRegistry');
const { resolveEmbeddingDimension } = require('../../shared/embeddingDimensions');
const { isVisionDecodePressureError } = require('./visionErrorClassification');
const { ERROR_CODES } = require('../../shared/errorCodes');
const { attachErrorCode } = require('../../shared/errorHandlingUtils');
const { looksLikeCpuIncompatibility } = require('../../shared/llamaErrorClassifier');
const { categorizeModel, isModelSupportFile } = require('../../shared/modelCategorization');
const { capEmbeddingInput } = require('../utils/embeddingInput');
const { createFilteredLlamaLogger } = require('../utils/llamaLogFilter');
const { clampOutputTokens } = require('../../shared/tokenBudget');
const SettingsService = require('./SettingsService');
const { getInstance: getVisionService } = require('./VisionService');
const { ensureResolvedModelsPath } = require('./modelPathResolver');

// New Managers
const { GPUMonitor } = require('./GPUMonitor');
const { ModelMemoryManager } = require('./ModelMemoryManager');
const { DegradationManager } = require('./DegradationManager');
const { ModelAccessCoordinator } = require('./ModelAccessCoordinator');
const { PerformanceMetrics } = require('./PerformanceMetrics');
const {
  withLlamaResilience,
  cleanupLlamaCircuits,
  shouldFallbackToCPU
} = require('./LlamaResilience');
const { delay, createBackgroundWorkTracker } = require('../../shared/promiseUtils');
const { LLAMA, TIMEOUTS } = require('../../shared/performanceConstants');
const { parsePositiveInt } = require('../../shared/numberUtils');

const logger = createLogger('LlamaService');
const NEGATIVE_VISION_SUPPORT_TTL_MS = 15_000;

function getSystemAnalyticsSafe() {
  try {
    return require('../core/systemAnalytics');
  } catch {
    return null;
  }
}

const isOutOfMemoryError = (/** @type {any} */ error) => {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('out of memory') || message.includes('oom');
};

const isSequenceExhaustedError = (/** @type {any} */ error) => {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('no sequences left');
};

const normalizeEmbeddingInput = (
  /** @type {any} */ text,
  operationName = 'embedding',
  /** @type {any} */ modelName
) => {
  if (typeof text !== 'string') {
    const error = new TypeError(
      `[LlamaService] ${operationName} expects "text" to be a string; received ${typeof text}`
    );
    throw attachErrorCode(error, ERROR_CODES.INVALID_INPUT);
  }
  const normalized = text.trim();
  if (!normalized) {
    const error = new TypeError(`[LlamaService] ${operationName} requires non-empty text input`);
    throw attachErrorCode(error, ERROR_CODES.INVALID_INPUT);
  }
  const capped = capEmbeddingInput(normalized, { modelName });
  if (capped.wasTruncated) {
    logger.warn('[LlamaService] Embedding input capped to token budget', {
      operation: operationName,
      model: modelName,
      originalLength: normalized.length,
      cappedLength: capped.text.length,
      estimatedTokens: capped.estimatedTokens,
      maxTokens: capped.maxTokens
    });
  }
  return capped.text;
};

/** @type {any} */
let _nodeLlamaModule = null;
/** @type {any} */
let _nodeLlamaLoadPromise = null;
async function loadNodeLlamaModule() {
  if (_nodeLlamaModule) return _nodeLlamaModule;
  // concurrent callers both see _nodeLlamaModule === null. Without this,
  // both callers start a separate dynamic import() and the second overwrites
  // the first's result. Storing the promise ensures all callers await the
  // same in-flight import.
  if (!_nodeLlamaLoadPromise) {
    _nodeLlamaLoadPromise = import(/* webpackIgnore: true */ 'node-llama-cpp');
  }
  try {
    _nodeLlamaModule = await _nodeLlamaLoadPromise;
    return _nodeLlamaModule;
  } catch (error) {
    // Clear promise on failure so a future caller can retry
    _nodeLlamaLoadPromise = null;
    throw error;
  }
}

// Vision models (LLaVA) encode images into ~4000 tokens. This floor guarantees
// enough room for image tokens + prompt + response in the vision context.
const VISION_MIN_CONTEXT = 4608;
// First-attempt ("preferred") text context ceilings by hardware tier. These
// only LOWER the initial context attempt from the configured size so analysis
// stays responsive on modest hardware; they never raise it above the user's
// configured value and are never persisted. High-VRAM GPUs (>= 12 GB) get no
// cap and use the configured size directly.
const CPU_TEXT_CONTEXT = 2048;
const LOW_VRAM_TEXT_CONTEXT = 4096;
const MID_VRAM_TEXT_CONTEXT = 6144;
// VRAM tier boundaries (MB). Below LOW = low-VRAM GPU; [LOW, MID) = mid-tier.
const LOW_VRAM_THRESHOLD_MB = 8000;
const MID_VRAM_THRESHOLD_MB = 12000;
const LOW_VRAM_VISION_CONTEXT = 4608;
const LOW_VRAM_VISION_BATCH_SIZE = 1024;
const LOW_VRAM_VISION_UBATCH_SIZE = 256;
const LOW_VRAM_VISION_RETRY_BATCH_SIZE = 512;
const LOW_VRAM_VISION_RETRY_UBATCH_SIZE = 128;
const LOW_VRAM_VISION_RETRY_MAX_TOKENS = 256;

// Default model configuration (from aiModelConfig)
const DEFAULT_CONFIG = {
  textModel: AI_DEFAULTS.TEXT?.MODEL ?? DEFAULT_AI_MODELS.TEXT_ANALYSIS,
  visionModel: AI_DEFAULTS.IMAGE?.MODEL ?? DEFAULT_AI_MODELS.IMAGE_ANALYSIS,
  embeddingModel: AI_DEFAULTS.EMBEDDING?.MODEL ?? DEFAULT_AI_MODELS.EMBEDDING,
  gpuLayers: 'auto', // 'auto' = let node-llama-cpp fit GPU layers to VRAM
  contextSize: 8192,
  threads: 0 // 0 = auto-detect
};

/**
 * Validate whether a model name is a recognized embedding model.
 * Accepts if EITHER the model registry OR pattern-based categorization
 * identifies it as embedding. This keeps the gatekeeper consistent with the
 * frontend's categorizeModel() that populates the embedding dropdown.
 * Previously, a registry entry with a non-embedding type would short-circuit
 * and reject models that pattern matching correctly identified as embedding.
 */
const _isAllowedEmbeddingModel = (/** @type {any} */ name) => {
  if (!name) return false;
  const registryInfo = getModel(name);
  if (registryInfo?.type === 'embedding') return true;
  return categorizeModel(name) === 'embedding';
};

// Model filenames removed from MODEL_CATALOG. Persisted settings that point
// at one of these are treated as legacy and resolve to the current default,
// so users on prior installs auto-heal without manual settings surgery.
const REMOVED_MODEL_FILENAMES = new Set([
  // Removed 2026-05 (commercial-license cleanup): xtuner llava-phi-3 has no
  // SPDX license metadata. Replaced by Apache-2.0 llava-v1.6-mistral-7b.
  'llava-phi-3-mini-int4.gguf',
  'llava-phi-3-mini-mmproj-f16.gguf'
]);

// Helper to detect legacy Ollama model names and removed catalog entries
const isLegacyModelName = (/** @type {any} */ name) => {
  if (!name || typeof name !== 'string') return false;
  if (REMOVED_MODEL_FILENAMES.has(name)) return true;
  return !name.endsWith('.gguf') && (name.includes(':') || !name.includes('.'));
};

class LlamaService extends EventEmitter {
  constructor() {
    super();
    this._initialized = false;
    /** @type {any} */
    this._modelsPath = null;
    /** @type {Record<string, any>} */
    this._config = { ...DEFAULT_CONFIG };
    this._configLoaded = false;
    this._configLoadPromise = null; // Promise gate for _ensureConfigLoaded()

    // Llama core
    this._llama = null;
    this._gpuBackend = null;
    this._detectedGpu = null;
    this._gpuSelection = null;

    // Managers
    this._gpuMonitor = new GPUMonitor();
    this._modelMemoryManager = null; // Initialized after llama
    this._degradationManager = null; // Initialized after llama
    this._coordinator = new ModelAccessCoordinator();

    // Since PerformanceMetrics is stateful (interval), we should use the singleton
    // or properly destroy the old one. Here we use the new instance but ensure
    // we destroy it in shutdown().
    this._metrics = new PerformanceMetrics();

    // Track fire-and-forget promises so shutdown can await them
    /** @type {any} */
    this._bgWork = createBackgroundWorkTracker('LlamaService');

    // Internal state
    /** @type {Record<string, any>} */
    this._models = { text: null, vision: null, embedding: null };
    /** @type {Record<string, any>} */
    this._contexts = { text: null, vision: null, embedding: null };
    /** @type {Record<string, any>} */
    this._selectedModels = { text: null, vision: null, embedding: null };
    // Model types whose resident context still serves a PREVIOUS model
    // selection (config swap happened while inference was in flight, so
    // unloadAll was skipped). _ensureModelLoaded swaps these out at the
    // next safe opportunity instead of serving the stale model forever.
    this._staleModelTypes = new Set();
    /** @type {Record<string, any>} */
    this._preferredContextSize = { text: null, vision: null };
    /** @type {Record<string, any>} */
    this._preferredContextSequences = { text: null, vision: null };
    this._visionContextSize = null;
    this._embeddingContextSize = null;
    // What is actually running on the CPU: the whole engine after a failed
    // GPU init, or the model types a load fell back to CPU for. Health reads
    // these, not DegradationManager's sticky "saw a VRAM error once" bit.
    this._engineCpuFallback = false;
    /** @type {Set<string>} */
    this._cpuFallbackTypes = new Set();
    this._modelChangeCallbacks = new Set();
    this._visionProjectorStatus = {
      required: false,
      available: false,
      projectorName: null,
      projectorPath: null,
      projectorSizeMB: null
    };
    this._visionInputSupported = null;
    this._visionInputCheckedAt = 0;
    this._visionCheckPromise = null; // Promise gate for _supportsVisionInput()
    this._initPromise = null; // Promise gate to prevent concurrent initialize() calls

    // Concurrency gates
    this._configChangeGate = null;
    this._modelReloadGates = new Map();

    // Cooperative shutdown: long-running callers (batch embed loops,
    // waitForIdleOperations, GPU watchdog probes, circuit-breaker sleeps)
    // can observe this signal to exit early instead of extending shutdown
    // to its worst-case wall-clock budget. Aborted at the *start* of
    // shutdown() so consumers see the signal before we begin unloading.
    // Recreated after shutdown finishes so a subsequent re-initialize()
    // starts from a fresh signal (some consumers cache the signal across
    // operations).
    this._shutdownAbort = new AbortController();

    // Vision batch mode — keeps vision server alive across multiple images
    this._visionBatchMode = false;
    this._visionBatchModeRefs = 0;
    this._visionBatchModeLock = Promise.resolve();
  }

  _createGate() {
    let resolve;
    const promise = new Promise((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  _generateOperationId(/** @type {any} */ prefix) {
    return `${prefix}-${require('crypto').randomUUID()}`;
  }

  async _withVisionBatchModeLock(/** @type {any} */ fn) {
    const previous = this._visionBatchModeLock;
    /** @type {(v?: any) => void} */
    let release = () => {};
    this._visionBatchModeLock = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      return await fn();
    } finally {
      release();
    }
  }

  _beginConfigChangeGate() {
    if (this._configChangeGate) return this._configChangeGate;
    this._configChangeGate = this._createGate();
    return this._configChangeGate;
  }

  _endConfigChangeGate() {
    if (!this._configChangeGate) return;
    this._configChangeGate.resolve();
    /** @type {any} */
    this._configChangeGate = null;
  }

  _beginModelReloadGate(/** @type {any} */ modelType) {
    if (this._modelReloadGates.has(modelType)) {
      return this._modelReloadGates.get(modelType);
    }
    const gate = this._createGate();
    this._modelReloadGates.set(modelType, gate);
    return gate;
  }

  _endModelReloadGate(/** @type {any} */ modelType) {
    const gate = this._modelReloadGates.get(modelType);
    if (!gate) return;
    gate.resolve();
    this._modelReloadGates.delete(modelType);
  }

  async _awaitModelReady(/** @type {any} */ modelType) {
    if (this._configChangeGate) {
      await this._configChangeGate.promise;
    }
    const gate = this._modelReloadGates.get(modelType);
    if (gate) {
      await gate.promise;
    }
  }

  /**
   * Check legacy userData/models directories for a specific model filename.
   * Returns the absolute legacy path if found, or null otherwise. Used to
   * distinguish "model never installed" from "model exists but in the wrong
   * directory" so we can show actionable copy for the latter.
   *
   * @param {string} modelName
   * @returns {Promise<string | null>}
   * @private
   */
  async _findModelInLegacyUserData(modelName) {
    if (!modelName) return null;
    let getLegacyPaths;
    try {
      ({ getLegacyUserDataPaths: getLegacyPaths } = require('../core/userDataMigration'));
    } catch {
      return null;
    }
    if (typeof getLegacyPaths !== 'function') return null;
    const candidates = getLegacyPaths() || [];
    for (const base of candidates) {
      if (!base) continue;
      const candidate = path.join(base, 'models', modelName);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // keep checking
      }
    }
    return null;
  }

  async _ensureVisionAssets(/** @type {any} */ modelName) {
    const modelInfo = getModel(modelName);
    const clipModel = modelInfo?.clipModel;
    if (!clipModel?.name) {
      this._visionProjectorStatus = {
        required: false,
        available: false,
        projectorName: null,
        projectorPath: null,
        projectorSizeMB: null
      };
      return this._visionProjectorStatus;
    }

    const projectorName = clipModel.name;
    const projectorPath = path.join(this._modelsPath, projectorName);
    try {
      const stats = await fs.stat(projectorPath);
      this._visionProjectorStatus = {
        required: true,
        available: true,
        projectorName,
        projectorPath,
        projectorSizeMB: Math.ceil(stats.size / (1024 * 1024))
      };
      return this._visionProjectorStatus;
    } catch {
      this._visionProjectorStatus = {
        required: true,
        available: false,
        projectorName,
        projectorPath,
        projectorSizeMB: null
      };
      logger.warn('[LlamaService] Vision projector missing for model', {
        modelName,
        projectorName,
        modelsPath: this._modelsPath
      });
      return this._visionProjectorStatus;
    }
  }

  async _ensureConfigLoaded() {
    if (!this._modelsPath) {
      try {
        const resolved = /** @type {any} */ (await ensureResolvedModelsPath());
        this._modelsPath = resolved.modelsPath;
        if (resolved.source === 'legacy') {
          logger.warn('[LlamaService] Using legacy models directory', {
            modelsPath: resolved.modelsPath,
            currentModelsPath: resolved.currentModelsPath
          });
        }
      } catch (e) {
        const base =
          typeof app?.getPath === 'function' && app.getPath('userData')
            ? app.getPath('userData')
            : os.tmpdir();
        this._modelsPath = path.join(base, 'models');
        try {
          await fs.mkdir(this._modelsPath, { recursive: true });
        } catch {
          // Non-fatal in tests and restricted environments; model ops will surface errors later.
        }
        logger.debug('[LlamaService] Falling back to default models directory:', e?.message);
      }
    }

    if (this._configLoaded) return;

    // triggering _loadConfig(). Without this, two concurrent callers both
    // see _configLoaded === false, both call _loadConfig(), and the second
    // may overwrite partially-set state from the first.
    if (this._configLoadPromise) {
      return this._configLoadPromise;
    }

    this._configLoadPromise = this._loadConfig().then(
      /** @returns {any} */ () => {
        this._configLoaded = true;
        return undefined;
      }
    );

    try {
      await this._configLoadPromise;
    } catch (error) {
      // Clear promise on failure so a future caller can retry
      this._configLoadPromise = null;
      throw error;
    } finally {
      // Clear promise reference after completion (success path keeps _configLoaded = true)
      this._configLoadPromise = null;
    }
  }

  /**
   * GPU info the memory budget should be derived from: the detected GPU
   * only when models are offloaded to it.
   * @returns {any}
   */
  _memoryBudgetGpuInfo() {
    if (this._gpuBackend === 'cpu') return null;
    if (this._config?.gpuLayers === 0) return null;
    return this._detectedGpu || null;
  }

  _applyContextSizing() {
    const vramMB = this._detectedGpu?.vramMB || 0;
    const isCpu = this._gpuBackend === 'cpu';

    // Auto-detect a sensible default only when no valid context size is configured.
    // Never clamp user-configured values; the fallback ladder in _loadModel
    // handles OOM dynamically by trying progressively smaller sizes.
    if (!Number.isFinite(this._config.contextSize) || this._config.contextSize <= 0) {
      let autoSize = LOW_VRAM_TEXT_CONTEXT;
      if (isCpu) {
        autoSize = CPU_TEXT_CONTEXT;
      } else if (vramMB >= MID_VRAM_THRESHOLD_MB) {
        autoSize = 8192;
      } else if (vramMB >= LOW_VRAM_THRESHOLD_MB) {
        autoSize = MID_VRAM_TEXT_CONTEXT;
      }
      this._config.contextSize = autoSize;
      logger.info('[LlamaService] Context size auto-configured', {
        contextSize: autoSize,
        vramMB: vramMB || null,
        backend: this._gpuBackend
      });
    }

    // Ensure the vision context is always large enough for image tokens + prompt + response.
    // On CPU / lower-VRAM GPUs, cap vision context to a safe floor to avoid decode/KV pressure.
    const configuredVisionContext = Math.max(this._config.contextSize, VISION_MIN_CONTEXT);
    const capVisionContext = isCpu || (vramMB > 0 && vramMB < LOW_VRAM_THRESHOLD_MB);
    this._visionContextSize = capVisionContext
      ? Math.min(configuredVisionContext, LOW_VRAM_VISION_CONTEXT)
      : configuredVisionContext;

    // First-attempt ("preferred") context bias. Picks the largest context the
    // detected hardware can run efficiently and only ever LOWERS from the
    // configured size — it never raises beyond the configured ceiling and never
    // mutates/persists _config.contextSize. This keeps analysis responsive on
    // every machine (CPU, low/mid/high VRAM) by avoiding doomed oversized first
    // attempts and their KV-cache pressure + retry latency.
    const textCeiling = this._resolveHardwareTextContextCeiling(isCpu, vramMB);
    if (Number.isFinite(textCeiling) && textCeiling < this._config.contextSize) {
      this._preferredContextSize.text = Math.max(1024, textCeiling);
      // CPU and low-VRAM GPUs can only sustain a single sequence; mid-tier keeps
      // the VRAM-derived default from _getContextSequences().
      this._preferredContextSequences.text = isCpu || vramMB < LOW_VRAM_THRESHOLD_MB ? 1 : null;
    } else {
      this._preferredContextSize.text = null;
      this._preferredContextSequences.text = null;
    }

    if (capVisionContext && this._visionContextSize < configuredVisionContext) {
      this._preferredContextSize.vision = Math.max(VISION_MIN_CONTEXT, this._visionContextSize);
      this._preferredContextSequences.vision = 1;
    } else {
      this._preferredContextSize.vision = null;
      this._preferredContextSequences.vision = null;
    }

    if (Number.isFinite(this._preferredContextSize.text)) {
      logger.info('[LlamaService] Applied hardware-aware context preference', {
        vramMB: vramMB || null,
        backend: this._gpuBackend,
        preferredTextContext: this._preferredContextSize.text,
        preferredVisionContext: this._preferredContextSize.vision,
        configuredContext: this._config.contextSize
      });
    }

    logger.debug('[LlamaService] Context sizing resolved', {
      textContext: this._config.contextSize,
      visionContext: this._visionContextSize,
      vramMB: vramMB || null,
      backend: this._gpuBackend
    });
  }

  /**
   * Largest text context the detected hardware can run efficiently as a first
   * attempt. Returns null when no cap applies (high-VRAM GPU or unknown VRAM),
   * meaning the configured context size is used directly.
   * @private
   */
  _resolveHardwareTextContextCeiling(/** @type {any} */ isCpu, /** @type {any} */ vramMB) {
    if (isCpu) return CPU_TEXT_CONTEXT;
    if (vramMB <= 0) return null; // GPU with unknown VRAM: don't second-guess
    if (vramMB < LOW_VRAM_THRESHOLD_MB) return LOW_VRAM_TEXT_CONTEXT;
    if (vramMB < MID_VRAM_THRESHOLD_MB) return MID_VRAM_TEXT_CONTEXT;
    return null; // high-VRAM GPU: use configured size
  }

  _getEffectiveContextSize(type = 'text') {
    if (type === 'vision') {
      if (Number.isFinite(this._visionContextSize)) {
        return this._visionContextSize;
      }
      return Math.max(this._config.contextSize, VISION_MIN_CONTEXT);
    }
    if (type === 'embedding') {
      if (Number.isFinite(this._embeddingContextSize) && this._embeddingContextSize > 0) {
        return this._embeddingContextSize;
      }
      return null;
    }
    const preferred = /** @type {any} */ (this._preferredContextSize)?.[type];
    if (Number.isFinite(preferred) && preferred > 0) {
      return preferred;
    }
    return this._config.contextSize;
  }

  _isLowVramProfile() {
    const vramMB = this._detectedGpu?.vramMB || 0;
    return this._gpuBackend !== 'cpu' && vramMB > 0 && vramMB < LOW_VRAM_THRESHOLD_MB;
  }

  _isUnknownVramGpuProfile() {
    const vramMB = this._detectedGpu?.vramMB || 0;
    return this._gpuBackend !== 'cpu' && vramMB <= 0;
  }

  _shouldUseConservativeVisionProfile() {
    return this._isLowVramProfile() || this._isUnknownVramGpuProfile();
  }

  _buildVisionRuntimeProfile(/** @type {any} */ { maxTokens, retryDegraded = false } = {}) {
    const effectiveContextSize = this._getEffectiveContextSize('vision');
    const envBatchSize = parsePositiveInt(process.env.STRATOSORT_VISION_BATCH_SIZE);
    const envUbatchSize = parsePositiveInt(process.env.STRATOSORT_VISION_UBATCH_SIZE);
    const useConservativeProfile = this._shouldUseConservativeVisionProfile();

    const defaultBatchSize = retryDegraded
      ? LOW_VRAM_VISION_RETRY_BATCH_SIZE
      : LOW_VRAM_VISION_BATCH_SIZE;
    const defaultUbatchSize = retryDegraded
      ? LOW_VRAM_VISION_RETRY_UBATCH_SIZE
      : LOW_VRAM_VISION_UBATCH_SIZE;

    const profile = {
      contextSize: effectiveContextSize,
      batchSize: envBatchSize || (useConservativeProfile ? defaultBatchSize : null),
      ubatchSize: envUbatchSize || (useConservativeProfile ? defaultUbatchSize : null),
      maxTokens:
        retryDegraded && useConservativeProfile
          ? Math.max(
              64,
              Math.min(
                Number(maxTokens) || LOW_VRAM_VISION_RETRY_MAX_TOKENS,
                LOW_VRAM_VISION_RETRY_MAX_TOKENS
              )
            )
          : maxTokens
    };

    return profile;
  }

  _isVisionDecodePressureError(/** @type {any} */ errorLike) {
    return isVisionDecodePressureError(errorLike);
  }

  _getContextSequences(type = 'text') {
    const preferred = /** @type {any} */ (this._preferredContextSequences)?.[type];
    if (Number.isFinite(preferred) && preferred > 0) return preferred;
    if (type === 'embedding') return 1;
    if (this._gpuBackend === 'cpu') return 1;
    const vramMB = this._detectedGpu?.vramMB || 0;
    if (vramMB > 0 && vramMB < 7000) return 1;
    if (vramMB >= 24000) return 4;
    if (vramMB >= 16000) return 3;
    return 2;
  }

  /**
   * Get the current effective configuration.
   * This is the public API used by IPC and analysis modules.
   */
  async getConfig() {
    await this._ensureConfigLoaded();
    return {
      textModel: this._selectedModels.text || this._config.textModel,
      visionModel: this._selectedModels.vision || this._config.visionModel,
      embeddingModel: this._selectedModels.embedding || this._config.embeddingModel,
      gpuLayers: this._config.gpuLayers,
      contextSize: this._getEffectiveContextSize('text'),
      visionContextSize: this._getEffectiveContextSize('vision'),
      embeddingContextSize: this._getEffectiveContextSize('embedding'),
      threads: this._config.threads,
      gpuBackend: this._gpuBackend,
      modelsPath: this._modelsPath,
      visionProjector: { ...this._visionProjectorStatus }
    };
  }

  /**
   * Update configuration and persist to SettingsService.
   * Triggers model-change notifications when a selected model changes.
   *
   * @param {any} [partial]
   * @param {any} [options]
   */
  async updateConfig(/** @type {any} */ partial = {}, /** @type {any} */ options = {}) {
    // Serialize concurrent calls. _beginConfigChangeGate is idempotent on an
    // existing gate, so overlapping calls used to share one gate: the first
    // finisher released it while the other was still mid-teardown, letting
    // inference proceed against a model being swapped and leaving spurious
    // _staleModelTypes markers. A promise-chain mutex also means the second
    // caller diffs against the first caller's APPLIED config.
    const previousTurn = this._updateConfigTurn || Promise.resolve();
    /** @type {(v?: any) => void} */
    let releaseTurn = () => {};
    this._updateConfigTurn = new Promise((resolve) => {
      releaseTurn = resolve;
    });
    await previousTurn;
    try {
      return await this._applyConfigUpdate(partial, options);
    } finally {
      releaseTurn();
    }
  }

  async _applyConfigUpdate(/** @type {any} */ partial = {}, /** @type {any} */ options = {}) {
    const { skipSave = false, autoFallback = false } = options || {};
    await this._ensureConfigLoaded();

    const prev = { ...this._selectedModels };
    let modelDowngraded = false;
    // Backward-compatible key mapping:
    // IPC/settings historically used llamaGpuLayers/llamaContextSize,
    // while internal code uses gpuLayers/contextSize.
    const resolvedGpuLayers =
      partial.gpuLayers ?? partial.llamaGpuLayers ?? partial.llamaGPULayers ?? undefined;
    const resolvedContextSize = partial.contextSize ?? partial.llamaContextSize ?? undefined;

    if (partial.textModel) this._selectedModels.text = String(partial.textModel);
    if (partial.textModel && !autoFallback && String(partial.textModel) !== prev.text) {
      // A text-model CHANGE (Settings, wizard) supersedes the substitution
      // llamaUtils.ensureTextModelReadyForAnalysis made for a missing model
      // (flag code shared with that helper by name). The substituted name is
      // persisted and rides along with every later settings save, import and
      // restore, so an unchanged name is not a choice and keeps the notice.
      try {
        const { getInstance: getDegradedStateTracker } = require('./DegradedStateTracker');
        getDegradedStateTracker().clear('llama.text-model-substituted');
      } catch {
        /* tracker may not be available in tests */
      }
    }
    if (partial.visionModel) this._selectedModels.vision = String(partial.visionModel);
    if (partial.embeddingModel) {
      const requested = String(partial.embeddingModel);
      if (!_isAllowedEmbeddingModel(requested)) {
        logger.warn(
          '[LlamaService] Embedding model not recognized by categorization; accepting user selection',
          {
            requested,
            recognized: false
          }
        );
      }
      this._selectedModels.embedding = requested;
    }

    const engineTuningChanged =
      (typeof resolvedGpuLayers === 'number' && resolvedGpuLayers !== this._config.gpuLayers) ||
      (typeof resolvedContextSize === 'number' && resolvedContextSize !== this._config.contextSize);
    if (typeof resolvedGpuLayers === 'number' && resolvedGpuLayers !== this._config.gpuLayers) {
      this._config.gpuLayers = resolvedGpuLayers;
      // gpuLayers 0 moves every model into system RAM; the budget follows.
      this._modelMemoryManager?.setGpuInfo?.(this._memoryBudgetGpuInfo());
    }
    if (
      typeof resolvedContextSize === 'number' &&
      resolvedContextSize !== this._config.contextSize
    ) {
      // Every settings save forwards llamaContextSize, so this runs only on
      // a real change: resetting the hardware-aware preferences on an
      // unchanged value left _getEffectiveContextSize reporting the
      // configured 8192 for a context created at the CPU ceiling of 2048.
      this._config.contextSize = resolvedContextSize;
      this._embeddingContextSize = null;
      if (this._gpuBackend) {
        // Re-derive the ceilings for the new configured size instead of
        // nulling them: the next load then starts at the size this
        // hardware can run, not at the ceiling and down the OOM ladder.
        this._applyContextSizing();
      } else {
        /** @type {any} */ (this._preferredContextSize).text = null;
        /** @type {any} */ (this._preferredContextSize).vision = null;
        /** @type {any} */ (this._preferredContextSequences).text = null;
        /** @type {any} */ (this._preferredContextSequences).vision = null;
        this._visionContextSize = null;
      }
    }
    if (typeof partial.threads === 'number') this._config.threads = partial.threads;

    if (!skipSave) {
      try {
        await SettingsService.getInstance().save({
          textModel: this._selectedModels.text,
          visionModel: this._selectedModels.vision,
          embeddingModel: this._selectedModels.embedding,
          llamaGpuLayers: this._config.gpuLayers,
          llamaContextSize: this._config.contextSize
        });
      } catch (error) {
        logger.warn('[LlamaService] Failed to persist config:', error.message);
      }
    }

    // New GPU layer or context settings only take effect at model load, so
    // a model already in memory keeps the old ones. Mark every resident type
    // stale: _ensureModelLoaded swaps it on its next use once in-flight
    // operations release it, the same path a model change takes when
    // unloadAll is refused.
    if (engineTuningChanged && this._modelMemoryManager) {
      const resident = this._modelMemoryManager.getMemoryStatus?.()?.loadedModels || [];
      for (const type of resident) {
        this._staleModelTypes.add(type);
      }
      if (resident.length > 0) {
        logger.info('[LlamaService] Engine tuning changed; resident models reload on next use', {
          resident,
          gpuLayers: this._config.gpuLayers,
          contextSize: this._config.contextSize
        });
      }
    }

    // If any selected model changed, force unload so next operation reloads correct model.
    const changedTypes = [];
    if (prev.text !== this._selectedModels.text) changedTypes.push('text');
    if (prev.vision !== this._selectedModels.vision) changedTypes.push('vision');
    if (prev.embedding !== this._selectedModels.embedding) changedTypes.push('embedding');
    if (changedTypes.includes('vision')) {
      this._visionInputSupported = null;
    }
    const needsGate = changedTypes.length > 0;
    if (needsGate) {
      this._beginConfigChangeGate();
    }
    try {
      if (changedTypes.length > 0 && this._modelMemoryManager) {
        // Acquire load locks before unloading to avoid crashing in-flight inference
        const releaseLocks = [];
        try {
          for (const type of changedTypes) {
            if (this._coordinator) {
              releaseLocks.push(
                await this._coordinator.acquireLoadLock(type, {
                  onForceRelease: async (/** @type {any} */ { reason }) => {
                    logger.error(
                      '[LlamaService] Force-release during config change; unloading model',
                      { modelType: type, reason }
                    );
                    try {
                      if (this._modelMemoryManager?.unloadModel) {
                        await this._modelMemoryManager.unloadModel(type);
                      }
                    } catch (unloadErr) {
                      logger.warn('[LlamaService] Config-change unload threw', {
                        modelType: type,
                        error: unloadErr?.message
                      });
                    }
                  }
                })
              );
            }
          }
          const safeToUnload = await this._waitForIdleOperations('config-change', 60000);
          if (safeToUnload) {
            await this._modelMemoryManager.unloadAll();
          } else {
            logger.warn(
              '[LlamaService] Skipping unloadAll due to active operations - config change will apply on next load'
            );
          }
          // Any changed type still resident is serving the OLD model
          // (unloadAll skipped, or unload refused due to active refs).
          // Mark it stale so _ensureModelLoaded force-swaps it instead of
          // returning the cached context indefinitely.
          const resident = new Set(
            this._modelMemoryManager.getMemoryStatus?.()?.loadedModels || []
          );
          for (const type of changedTypes) {
            if (resident.has(type)) {
              this._staleModelTypes.add(type);
              logger.warn('[LlamaService] Model still resident after config swap; marked stale', {
                modelType: type
              });
            } else {
              this._staleModelTypes.delete(type);
            }
          }
        } catch (e) {
          logger.debug('[LlamaService] unloadAll failed (non-fatal):', e?.message);
        } finally {
          for (const release of releaseLocks) {
            try {
              release();
            } catch {
              /* ignore */
            }
          }
        }
      }
    } finally {
      if (needsGate) {
        this._endConfigChangeGate();
      }
    }

    // Reset circuit breakers for changed model types — the old breaker state
    // reflects failures from the previous model, not the newly selected one.
    if (changedTypes.length > 0) {
      const { resetLlamaCircuit: resetCircuit } = require('./LlamaResilience');
      for (const type of changedTypes) {
        resetCircuit(type);
      }
    }

    // Notify subscribers. Async callbacks are awaited (settled, not raced):
    // FolderMatchingService's embedding-model handler resets the vector DB
    // and rewrites the embedding-index metadata. When updateConfig() is part
    // of a larger flow (e.g. FULL_REBUILD with modelOverride), letting that
    // handler run fire-and-forget raced the rebuild's own resetAll() and
    // markRebuildInProgress() — it could delete freshly rebuilt entries and
    // erase the crash marker. The config-change gate is already released
    // above, so awaiting here cannot deadlock re-entrant config reads.
    for (const type of changedTypes) {
      const payload = {
        type,
        previousModel: prev[type],
        newModel: this._selectedModels[type]
      };
      this.emit('model-change', payload);
      /** @type {Promise<any>[]} */
      const callbackResults = [];
      for (const cb of this._modelChangeCallbacks) {
        try {
          callbackResults.push(Promise.resolve(cb(payload)));
        } catch {
          // ignore synchronous callback errors
        }
      }
      await Promise.allSettled(callbackResults);
    }

    if (changedTypes.length > 0) {
      logger.info('[LlamaService] Model configuration updated', {
        changedTypes,
        selectedModels: { ...this._selectedModels },
        modelDowngraded
      });
    } else {
      logger.debug('[LlamaService] updateConfig applied with no model change', {
        modelDowngraded,
        partialKeys: Object.keys(partial || {})
      });
    }

    return { success: true, modelDowngraded, selected: { ...this._selectedModels } };
  }

  /**
   * Subscribe to model changes.
   * @returns {Function} unsubscribe
   */
  onModelChange(/** @type {any} */ callback) {
    if (typeof callback !== 'function') return () => {};
    this._modelChangeCallbacks.add(callback);
    return () => this._modelChangeCallbacks.delete(callback);
  }

  /**
   * Lightweight health check for the in-process AI engine.
   *
   * Coalesces concurrent calls: when the Settings panel and the auto-health
   * poller both fire test-connection within the per-channel concurrency-lock
   * window (observed in production logs at 127ms apart), the second caller
   * would previously hit the preload's "Operation already in progress" lock
   * and surface an ERROR-level log on every Settings open. By awaiting the
   * in-flight Promise here, both callers get the same result and the lock
   * never sees a second invocation.
   */
  async testConnection() {
    if (this._testConnectionInFlight) {
      return this._testConnectionInFlight;
    }
    const work = (async () => {
      try {
        await this._ensureConfigLoaded();
        const models = await this.listModels();
        return {
          success: true,
          status: 'healthy',
          modelCount: models.length,
          gpuBackend: this._gpuBackend
        };
      } catch (error) {
        // Without this log, repeated unhealthy ticks on the renderer's health
        // pill leave no diagnostic trail — postmortem can't tell whether the
        // failure was config load, model enumeration, or a deeper engine
        // crash, so reproducing user reports of "AI shows red" becomes
        // guesswork.
        logger.error('[LlamaService.testConnection] health check failed', {
          message: error?.message,
          code: error?.code,
          name: error?.name
        });
        return { success: false, status: 'unhealthy', error: error.message };
      }
    })();
    this._testConnectionInFlight = work;
    try {
      return await work;
    } finally {
      // Clear so the next call (after this resolves) actually re-checks
      // rather than returning a cached stale result.
      if (this._testConnectionInFlight === work) {
        this._testConnectionInFlight = null;
      }
    }
  }

  /**
   * Initialize the LlamaService
   */
  async initialize() {
    if (this._initialized) return;

    // Promise gate: concurrent callers all await the same initialization.
    // Without this, two concurrent calls both see _initialized = false and
    // both proceed, creating duplicate managers and orphaning state.
    if (this._initPromise) return this._initPromise;

    this._initPromise = this._doInitialize();
    try {
      await this._initPromise;
    } catch (error) {
      // Clear the promise so a future retry can attempt initialization again
      this._initPromise = null;
      throw error;
    }
  }

  /** @private Actual initialization logic, called once via the promise gate. */
  async _doInitialize() {
    logger.info('[LlamaService] Initializing...');

    try {
      await this._ensureConfigLoaded();

      // Initialize Managers
      this._degradationManager = new DegradationManager(this);

      // Check system readiness (GPU, disk, models)
      const readiness = await this._degradationManager.checkSystemReadiness();
      if (!readiness.ready) {
        logger.warn('[LlamaService] System degradation detected', readiness.issues);
        // We continue initialization but note the degradation
      }

      // Initialize Llama with GPU detection
      await this._initializeLlama();

      // Apply context sizing based on detected GPU/CPU budgets
      this._applyContextSizing();

      // Initialize Memory Manager with GPU info for VRAM-aware budgeting.
      // When weights land in system RAM (CPU backend, gpuLayers 0) the
      // budget must be RAM-sized: a 24 GB card the engine cannot use is
      // not where the models go.
      this._modelMemoryManager = new ModelMemoryManager(this, {
        gpuInfo: this._memoryBudgetGpuInfo()
      });

      // Upgrade coordinator with GPU-aware concurrency from PerformanceService
      try {
        const { getRecommendedConcurrency } = require('./PerformanceService');
        const recs = await getRecommendedConcurrency({ gpuHint: this._detectedGpu });
        if (recs.maxConcurrent > 1) {
          if (
            this._coordinator &&
            typeof this._coordinator.updateInferenceConcurrency === 'function'
          ) {
            this._coordinator.updateInferenceConcurrency(recs.maxConcurrent);
          } else {
            this._coordinator = new ModelAccessCoordinator({
              inferenceSlots: recs.maxConcurrent
            });
          }
          logger.info('[LlamaService] Coordinator upgraded with GPU-aware concurrency', {
            maxConcurrent: recs.maxConcurrent,
            reason: recs.reason,
            vramMB: recs.vramMB,
            gpuName: recs.gpuName
          });
        }
      } catch (perfError) {
        logger.debug('[LlamaService] PerformanceService not available, using default concurrency', {
          error: perfError?.message
        });
      }

      // Configuration is loaded via _ensureConfigLoaded()

      this._initialized = true;
      this.emit('initialized', {
        gpuBackend: this._gpuBackend,
        gpuDevice: readiness.gpuInfo?.name
      });

      logger.info('[LlamaService] Initialized successfully', {
        gpuBackend: this._gpuBackend,
        modelsPath: this._modelsPath
      });
    } catch (error) {
      logger.error('[LlamaService] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Initialize Llama with automatic GPU detection/fallback.
   *
   * node-llama-cpp's `getLlama({ gpu: 'auto' })` probes for CUDA → Vulkan → Metal
   * and silently falls back to CPU when none are usable.  We surface the result
   * so users know whether inference will be fast (GPU) or slow (CPU-only).
   */
  async _initializeLlama() {
    const nodeLlama = await loadNodeLlamaModule();
    const { getLlama } = nodeLlama;
    // Drops the benign tokenizer round-trip warning that BERT WordPiece
    // embedding models (nomic-embed-text) always trip; forwards everything else.
    const llamaLogger = createFilteredLlamaLogger(nodeLlama);

    // Detect what GPU the OS sees (independent of node-llama-cpp's own probe)
    try {
      const gpuInfo = await this._gpuMonitor.detectGPU();
      this._detectedGpu = gpuInfo;
      logger.info('[LlamaService] System GPU detected', {
        type: gpuInfo.type,
        name: gpuInfo.name,
        vramMB: gpuInfo.vramMB || 0
      });
    } catch {
      this._detectedGpu = null;
      logger.debug('[LlamaService] GPU detection skipped');
    }

    // Initialize Llama backend deterministically (CUDA -> auto -> CPU)
    try {
      const { initLlamaWithBackend } = require('../utils/llamaBackendSelector');
      const selection = await initLlamaWithBackend({
        getLlama,
        gpuInfo: this._detectedGpu,
        logger,
        context: 'LlamaService',
        llamaLogger
      });
      this._llama = selection.llama;
      this._gpuBackend = selection.backend;
      this._gpuSelection = selection.selection;
      this._engineCpuFallback = false;
      // Tell VisionService which backend actually loaded so its
      // resolveVisionRuntimeBackend() picks the same family. Without this,
      // Windows non-ARM with NVIDIA hardware: GPUMonitor reports vulkan
      // (WMI/CIM fallback never confirms CUDA), main inference confirms
      // cuda, and the vision server keeps booting on Vulkan — two driver
      // stacks active simultaneously, reduced VRAM efficiency. Lazy-require
      // to avoid a require cycle.
      try {
        const { confirmGpuBackend } = require('./VisionService');
        if (typeof confirmGpuBackend === 'function') {
          confirmGpuBackend(selection.backend);
        }
      } catch {
        /* defensive: VisionService may not be loadable in some test contexts */
      }
    } catch (error) {
      logger.warn('[LlamaService] GPU initialization failed, falling back to CPU', {
        error: error?.message
      });
      this._llama = await getLlama({ gpu: false, logger: llamaLogger });
      this._gpuBackend = 'cpu';
      this._engineCpuFallback = true;
      // Weights now load into system RAM; a manager built earlier (reload
      // paths) must stop budgeting against VRAM.
      this._modelMemoryManager?.setGpuInfo?.(null);
      this._gpuSelection = {
        attempted: [],
        selected: 'cpu',
        requested: 'cpu',
        detectedGpu: this._detectedGpu || null
      };
    }

    if (this._gpuBackend === 'cpu' || this._gpuBackend === false || !this._gpuBackend) {
      this._gpuBackend = 'cpu';
      logger.warn(
        '[LlamaService] Running on CPU only — inference will be slow for large models. ' +
          'Install CUDA toolkit (NVIDIA) or ensure Vulkan drivers are up to date for GPU acceleration.'
      );
    } else {
      logger.info('[LlamaService] GPU acceleration active', {
        backend: this._gpuBackend,
        message: 'Text, embedding, and vision models will use GPU for faster inference.'
      });
    }
  }

  /**
   * Load configuration from settings
   */
  async _loadConfig() {
    try {
      const settingsService = SettingsService.getInstance();
      const settings = (await settingsService.load()) || {};

      // Helper to resolve model name (fallback to default if legacy/missing)
      const resolveModel = (
        /** @type {any} */ configured,
        /** @type {any} */ defaultName,
        /** @type {any} */ type
      ) => {
        if (!configured) return defaultName;
        if (isLegacyModelName(configured)) {
          logger.warn(
            `[LlamaService] Detected legacy ${type} model name "${configured}", falling back to default`,
            {
              legacy: configured,
              fallback: defaultName
            }
          );
          return defaultName;
        }
        return configured;
      };

      this._selectedModels = {
        text: resolveModel(settings.textModel, AI_DEFAULTS.TEXT.MODEL, 'text'),
        vision: resolveModel(settings.visionModel, AI_DEFAULTS.IMAGE.MODEL, 'vision'),
        embedding: resolveModel(settings.embeddingModel, AI_DEFAULTS.EMBEDDING.MODEL, 'embedding')
      };
      await this._autoHealEmbeddingModelSelection(settingsService, settings);

      if (typeof settings.llamaGpuLayers === 'number') {
        this._config.gpuLayers = settings.llamaGpuLayers;
        if (settings.llamaGpuLayers === 0) {
          logger.warn(
            '[LlamaService] GPU layers set to 0 in settings — AI inference will use CPU only. ' +
              'Set to -1 (auto) in Settings > AI Models for GPU acceleration.'
          );
        }
      }
      if (typeof settings.llamaContextSize === 'number') {
        this._config.contextSize = settings.llamaContextSize;
      }
    } catch (error) {
      logger.warn('[LlamaService] Failed to load config from settings:', error.message);
      this._selectedModels = {
        text: AI_DEFAULTS.TEXT.MODEL,
        vision: AI_DEFAULTS.IMAGE.MODEL,
        embedding: AI_DEFAULTS.EMBEDDING.MODEL
      };
    }
  }

  async _getInstalledEmbeddingModels() {
    try {
      const entries = await fs.readdir(this._modelsPath, { withFileTypes: true });
      const models = entries
        .filter(
          (entry) =>
            entry?.isFile?.() &&
            String(entry.name || '')
              .toLowerCase()
              .endsWith('.gguf')
        )
        .map((entry) => entry.name)
        .filter((name) => categorizeModel(name) === 'embedding');
      return Array.from(new Set(models)).sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  async _resolveMissingEmbeddingModel(/** @type {any} */ requestedModel) {
    const installed = await this._getInstalledEmbeddingModels();
    if (!Array.isArray(installed) || installed.length === 0) return null;
    if (installed.includes(requestedModel)) return requestedModel;

    const expectedDim = resolveEmbeddingDimension(requestedModel, {
      defaultDimension: AI_DEFAULTS.EMBEDDING?.DIMENSIONS
    });
    const sameDimInstalled = installed.filter(
      (modelName) =>
        resolveEmbeddingDimension(modelName, {
          defaultDimension: expectedDim
        }) === expectedDim
    );

    const preferredOrder = [
      AI_DEFAULTS.EMBEDDING.MODEL,
      ...(AI_DEFAULTS.EMBEDDING.FALLBACK_MODELS || [])
    ].filter(Boolean);

    for (const candidate of preferredOrder) {
      if (sameDimInstalled.includes(candidate)) return candidate;
    }
    for (const candidate of preferredOrder) {
      if (installed.includes(candidate)) return candidate;
    }
    if (sameDimInstalled.length > 0) return sameDimInstalled[0];
    return installed[0];
  }

  async _persistEmbeddingModelSelection(
    /** @type {any} */ settingsService,
    /** @type {any} */ settings,
    /** @type {any} */ modelName
  ) {
    try {
      if (!modelName || settings?.embeddingModel === modelName) return;
      // In non-Electron diagnostics/test harnesses, app may be partially mocked.
      // Skip persistence there; runtime will still use the healed in-memory model.
      if (typeof app?.getVersion !== 'function') return;
      const baseSettings =
        settings && typeof settings === 'object' ? settings : (await settingsService.load()) || {};
      await settingsService.save({
        ...baseSettings,
        embeddingModel: modelName
      });
    } catch (error) {
      logger.warn('[LlamaService] Failed to persist healed embedding model selection', {
        model: modelName,
        error: error?.message
      });
    }
  }

  async _autoHealEmbeddingModelSelection(
    /** @type {any} */ settingsService,
    /** @type {any} */ settings
  ) {
    const configuredModel = this._selectedModels.embedding;
    if (!configuredModel) return;
    try {
      await fs.access(path.join(this._modelsPath, configuredModel));
      this._config.embeddingModel = configuredModel;
      return;
    } catch {
      // Model missing - resolve to an installed embedding model.
    }

    const healedModel = await this._resolveMissingEmbeddingModel(configuredModel);
    if (!healedModel || healedModel === configuredModel) return;

    logger.warn(
      '[LlamaService] Configured embedding model missing; auto-healing to installed model',
      {
        configured: configuredModel,
        healed: healedModel
      }
    );
    this._selectedModels.embedding = healedModel;
    this._config.embeddingModel = healedModel;
    await this._persistEmbeddingModelSelection(settingsService, settings, healedModel);
  }

  /**
   * Best-effort, non-blocking warm-up of the text model so the next text
   * inference (e.g. smart-folder AI description generation) skips the ~15s cold
   * VRAM load. Callers should fire-and-forget; this never rejects. It holds the
   * model no longer than ordinary use would (the caller is about to need it),
   * so it does not add sustained memory pressure.
   * @returns {Promise<{ success: boolean, skipped?: boolean }>}
   */
  async warmTextModel() {
    try {
      // Skip when the vision model is resident / batch mode is active. Loading
      // the ~6GB text model alongside a resident vision server (~4GB) races
      // into held VRAM on low-VRAM machines and surfaces as "Failed to load
      // model". The warm is best-effort — the on-demand load path
      // (_releaseVisionForLoad + the ModelMemoryManager safety net) handles
      // VRAM pressure correctly when the user actually triggers text inference.
      // Mirrors the inference-path guard at the vision-batch preload site.
      if (this._visionBatchMode) {
        logger.debug('[LlamaService] Text warm-up skipped — vision batch mode active');
        return { success: false, skipped: true };
      }
      let visionResident = false;
      try {
        visionResident = Boolean(getVisionService()?.isAlive?.());
      } catch {
        visionResident = false;
      }
      if (visionResident) {
        logger.debug('[LlamaService] Text warm-up skipped — vision server resident');
        return { success: false, skipped: true };
      }

      await this._ensureModelLoaded('text');
      // The pre-checks above are check-then-act: a batch can enter vision
      // batch mode during the ~15s load (its unloadModel('text') no-ops
      // because the warm load hasn't registered yet), leaving the ~6GB text
      // model resident for the whole vision batch — exactly the contention
      // this guard exists to prevent. Undo the load, mirroring
      // _preloadTextAfterVisionRelease. Re-check BOTH pre-conditions: a
      // SINGLE-image analyzeImage started mid-warm spawns the vision server
      // without batch mode, and its own unloadModel('text') hit the same
      // not-yet-registered no-op.
      let visionResidentAfterLoad = false;
      try {
        visionResidentAfterLoad = Boolean(getVisionService()?.isAlive?.());
      } catch {
        visionResidentAfterLoad = false;
      }
      if (this._visionBatchMode || visionResidentAfterLoad) {
        try {
          await this._modelMemoryManager.unloadModel('text');
        } catch (unloadErr) {
          logger.debug('[LlamaService] Post-warm text unload (vision became active) threw', {
            error: /** @type {any} */ (unloadErr)?.message
          });
        }
        logger.debug('[LlamaService] Text warm-up undone — vision became active during load', {
          batchMode: this._visionBatchMode,
          visionResident: visionResidentAfterLoad
        });
        return { success: false, skipped: true };
      }
      return { success: true };
    } catch (error) {
      logger.debug('[LlamaService] Text warm-up skipped', {
        error: /** @type {any} */ (error)?.message
      });
      return { success: false };
    }
  }

  /**
   * Ensure a model is loaded and ready.
   * Uses ModelMemoryManager to handle swapping and OOM prevention.
   *
   * Always acquires the coordinator load lock to prevent use-after-dispose
   * races where a concurrent updateConfig() or enterVisionBatchMode() could
   * dispose the context between the fast-path return and the caller's first await.
   * The lock is fast when the model is already loaded (ensureModelLoaded returns
   * immediately with the existing context).
   *
   * Note: ParallelEmbeddingService uses pinModel()/unpinModel() instead of
   * acquireModelLoadLock() to avoid deadlock with this non-reentrant lock.
   *
   * @param {string} modelType
   * @param {any} [options]
   */
  async _ensureModelLoaded(modelType, /** @type {any} */ { selfRef = false } = {}) {
    if (!this._initialized) await this.initialize();

    // VRAM contention safety net: if the vision server is still resident
    // (e.g., a keep-alive timer hasn't fired yet) and we're loading a
    // different model type, the vision process is holding ~4 GB of VRAM
    // out-of-process — ModelMemoryManager can't see or evict that. Without
    // tearing it down we race into busy VRAM and the load fails. Skip in
    // batch mode (which manages vision lifecycle explicitly) and when we're
    // loading the vision model itself.
    //
    // We probe twice: once before the load lock (so a queued caller starts
    // shutdown early and CUDA has more time to release VRAM while we wait
    // for the lock) and once after acquiring the lock (definitive — vision
    // could have been restarted by a sibling caller while we waited).
    await this._releaseVisionForLoad(modelType, 'pre-lock');

    // Wire a cooperative abort hook so the coordinator never has to drop our
    // mutex while a load is mid-flight. If the load stalls past the timeout,
    // the coordinator calls back into unloadModel, which tears down any
    // partially-initialized context (freeing the lock) before a second loader
    // can race against stale model state.
    const releaseLock = await this._coordinator.acquireLoadLock(modelType, {
      onForceRelease: async (/** @type {any} */ { reason }) => {
        logger.error(
          '[LlamaService] Coordinator requested force-release of load lock; aborting load',
          {
            modelType,
            reason
          }
        );
        try {
          if (this._modelMemoryManager?.unloadModel) {
            await this._modelMemoryManager.unloadModel(modelType);
          }
        } catch (unloadErr) {
          logger.warn('[LlamaService] Abort unload threw', {
            modelType,
            error: unloadErr?.message
          });
        }
      }
    });

    try {
      // Definitive vision check now that we hold the lock — vision may have
      // been restarted by a sibling code path between the pre-lock probe and
      // here, and ours is the load that will actually consume VRAM.
      await this._releaseVisionForLoad(modelType, 'post-lock');

      // Stale-swap: a config change selected a different model for this type
      // while the old one was pinned by in-flight inference. We hold the
      // load lock now, so swap it out (unloadModel still waits for OTHER
      // operations' refs to drain; if they never do, serve the stale model
      // this round and retry on the next load).
      //
      // allowedRefs reflects whether OUR caller holds a ref on this type
      // (inference paths acquireRef before calling us; background preloads
      // don't). Without excluding the self-ref, an inference call could
      // never swap a stale model: its own pin made the wait time out on
      // every call, adding 5s latency under the load lock indefinitely.
      if (this._staleModelTypes.has(modelType)) {
        const unloaded = await this._modelMemoryManager.unloadModel(modelType, {
          allowedRefs: selfRef ? 1 : 0
        });
        if (unloaded) {
          this._staleModelTypes.delete(modelType);
          logger.info('[LlamaService] Swapped out stale model after config change', { modelType });
        } else {
          logger.warn('[LlamaService] Stale model still pinned; serving previous model this call', {
            modelType
          });
        }
      }

      return await this._modelMemoryManager.ensureModelLoaded(modelType);
    } catch (error) {
      // Handle degradation (e.g., model file corruption, OOM, disk full)
      const resolution = await this._degradationManager.handleError(error, { modelType });
      if (resolution.action === 'redownload_model') {
        const redownloadError = /** @type {Error & { code?: string }} */ (
          new Error(`Model corrupted, please redownload: ${this._selectedModels[modelType]}`)
        );
        redownloadError.code = ERROR_CODES.LLAMA_MODEL_LOAD_FAILED;
        throw redownloadError;
      }
      if (resolution.action === 'retry_with_cpu') {
        logger.warn(
          `[LlamaService] GPU OOM loading ${modelType} — DegradationManager suggests CPU fallback`
        );
        // Surface the action so withLlamaResilience can trigger CPU fallback
        /** @type {any} */ (error)._degradationAction = 'retry_with_cpu';
      }
      if (resolution.action === 'transient_load_failure') {
        // Generic load failure with no specific signal. Tag the error so
        // withLlamaResilience runs the transient-load-failure recovery
        // (one retry with backoff + vision recheck) instead of treating it
        // as a permanent failure.
        /** @type {any} */ (error)._degradationAction = 'transient_load_failure';
      }
      if (resolution.action === 'cleanup_disk') {
        const diskError = /** @type {Error & { code?: string }} */ (
          new Error(`Disk full, cannot load ${modelType} model. Please free up space.`)
        );
        diskError.code = ERROR_CODES.LLAMA_MODEL_LOAD_FAILED;
        throw diskError;
      }
      throw error;
    } finally {
      releaseLock();
    }
  }

  /**
   * Probe the vision service and tear it down if it's still holding VRAM
   * we're about to need for a text model load. Idempotent and safe to
   * call multiple times; `shutdown()` deduplicates via `_shutdownPromise`.
   *
   * Embedding loads are exempt: the ~200MB embedding model coexists with a
   * resident vision runtime (vision batch mode already relies on this), and
   * evicting vision for it caused a per-image llama-server restart —
   * analyze image (vision) → embed result (teardown) → next image (10-30s
   * respawn). Genuine VRAM exhaustion on the embedding path is absorbed by
   * its GPU→auto→CPU load fallback tiers.
   *
   * @param {string} modelType
   * @param {'pre-lock' | 'post-lock'} phase  for log breadcrumbs
   * @private
   */
  async _releaseVisionForLoad(modelType, phase) {
    if (modelType === 'vision' || modelType === 'embedding' || this._visionBatchMode) return;

    let visionService;
    try {
      visionService = getVisionService();
    } catch (visionErr) {
      // getVisionService() throwing means the module hasn't initialized at
      // all — there is no vision child to tear down. Fine to skip.
      logger.debug('[LlamaService] Vision service unavailable during pre-load probe', {
        modelType,
        phase,
        error: visionErr?.message
      });
      return;
    }

    try {
      // _isReady (not _port) is the startup sentinel: VisionService assigns
      // _port at spawn time, before the health check, so checking _port here
      // let a teardown SIGTERM a mid-startup child (seen in production as
      // "Vision runtime exited during startup (code=null, signal=SIGTERM)").
      //
      // Rather than skip teardown outright when vision is mid-startup — which
      // let a text load barrel into VRAM the child was still allocating (the
      // residual cross-type VRAM race) — wait (bounded) for startup to settle,
      // then fall through to the normal idle-eviction below. We never SIGTERM a
      // starting child; we let it finish, then shut it down gracefully. If the
      // wait cap expires (pathological hang), skip teardown as before so a stuck
      // vision startup can't stall the text load indefinitely.
      if (visionService?._startPromise && !visionService._isReady) {
        logger.debug('[LlamaService] Vision mid-startup; awaiting readiness before VRAM release', {
          modelType,
          phase
        });
        const MID_STARTUP_WAIT_CAP_MS = 20000;
        const TIMED_OUT = Symbol('vision-start-wait-timeout');
        /** @type {ReturnType<typeof setTimeout>|undefined} */
        let capTimer;
        let outcome;
        try {
          outcome = await Promise.race([
            Promise.resolve(visionService._startPromise).then(
              () => 'settled',
              () => 'settled'
            ),
            new Promise((resolve) => {
              capTimer = setTimeout(() => resolve(TIMED_OUT), MID_STARTUP_WAIT_CAP_MS);
            })
          ]);
        } finally {
          if (capTimer) clearTimeout(capTimer);
        }
        if (outcome === TIMED_OUT) {
          logger.debug('[LlamaService] Vision still starting after wait cap; skipping teardown', {
            modelType,
            phase
          });
          return;
        }
      }

      // Re-check batch mode AFTER any wait above: a batch can enter vision
      // batch mode during the (up to 20s) startup wait and adopt the very
      // server we were about to shut down — the entry check at the top of
      // this method predates the await and no longer holds.
      if (this._visionBatchMode) {
        logger.debug(
          '[LlamaService] Vision batch mode entered during startup wait; keeping server',
          {
            modelType,
            phase
          }
        );
        return;
      }

      if (visionService?.isAlive?.() && visionService.isIdleKeepAliveEnabled?.()) {
        // A request may be mid-flight on the server (a single Discover image
        // while a chat turn starts). Tearing it down then failed that image
        // over to OCR and charged the vision breaker (audit row ML-05). Wait
        // for the request to finish; if it does not, leave the server up and
        // let the memory budget decide whether the text load fits beside it.
        if (
          typeof visionService.hasInFlightRequests === 'function' &&
          visionService.hasInFlightRequests()
        ) {
          const VISION_REQUEST_DRAIN_MS = 15000;
          const idle =
            typeof visionService.waitForIdle === 'function'
              ? await visionService.waitForIdle(VISION_REQUEST_DRAIN_MS)
              : false;
          if (!idle) {
            logger.info('[LlamaService] Vision request still in flight; keeping server for now', {
              modelType,
              phase
            });
            return;
          }
          if (this._visionBatchMode || !visionService.isAlive?.()) return;
        }
        logger.info('[LlamaService] Vision server still resident; releasing VRAM before load', {
          modelType,
          phase
        });
        await visionService.shutdown();
        // CUDA driver needs a beat to actually return VRAM to the OS pool
        // after the child process exits.
        await delay(500);
      }
    } catch (visionErr) {
      // Real failure (shutdown deadlock, IPC broken, getter crashed) — warn
      // with stack so production logs surface the cause when the next load
      // fails with VRAM contention.
      logger.warn('[LlamaService] Pre-load vision teardown failed', {
        modelType,
        phase,
        error: visionErr?.stack || visionErr?.message
      });
    }
  }

  /**
   * Memory the vision llama-server will hold for the selected vision model
   * (model file plus projector, with runtime overhead). Delegates to
   * VisionService so the number matches what it registers with the budget;
   * falls back to the manager's fixed vision estimate.
   * @returns {Promise<number>}
   */
  async _estimateVisionRuntimeBytes() {
    const fallback = this._modelMemoryManager?._modelSizeEstimates?.vision || 5 * 1024 ** 3;
    try {
      const visionService = getVisionService();
      if (typeof visionService?.estimateRuntimeMemoryBytes !== 'function') return fallback;
      const modelName = this._selectedModels.vision || this._config.visionModel;
      const estimate = await visionService.estimateRuntimeMemoryBytes({
        modelPath: modelName ? path.join(this._modelsPath, modelName) : null,
        mmprojPath: this._visionProjectorStatus?.projectorPath || null
      });
      return Number.isFinite(estimate) && estimate > 0 ? estimate : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Free VRAM for the vision llama-server and refuse to spawn it when what
   * stays resident leaves no room (audit row ML-01). unloadModel() returns
   * false when a model is pinned by in-flight inference; that result used
   * to be ignored and the server spawned regardless, so a 7B text model and
   * a ~5 GB vision server sat together. The budget now decides: a server
   * already running is excluded from the sum (its spawn adds nothing).
   *
   * @param {'single' | 'batch'} phase
   * @throws {Error & { code: 'MODEL_MEMORY_BUDGET_EXCEEDED' }}
   */
  async _releaseMemoryForVisionRuntime(phase) {
    const manager = this._modelMemoryManager;
    if (!manager) return;
    const textUnloaded = await manager.unloadModel('text');
    const embeddingUnloaded = await manager.unloadModel('embedding');
    // Whisper registers as the 'audio' external consumer (300-500 MB on
    // CUDA, ~190 MB for the base model). It has no idle unload of its own,
    // so after one voice memo it stayed resident until exit, and on every
    // machine whose budget is below the vision estimate the single-image
    // path refused to spawn the vision runtime "while audio stay in use".
    // It is idle whenever nothing is transcribing (the ref drain below says
    // so), in both phases. The unload is a no-op when whisper isn't
    // registered, so wrap to swallow both "no such model" and the rare 5s
    // ref-drain timeout.
    try {
      await manager.unloadModel('audio');
    } catch (audioUnloadErr) {
      logger.debug('[LlamaService] Audio (whisper) unload skipped or failed', {
        error: audioUnloadErr?.message
      });
    }
    // Brief delay for CUDA driver to release VRAM back to the OS
    await delay(500);

    if (typeof manager.canFitExternalLoad !== 'function') return;
    let runtimeType = 'vision-runtime';
    let alreadyRunning = false;
    try {
      const visionService = getVisionService();
      alreadyRunning = Boolean(visionService?.isAlive?.());
      const { VISION_RUNTIME_MEMORY_TYPE } = require('./VisionService');
      if (VISION_RUNTIME_MEMORY_TYPE) runtimeType = VISION_RUNTIME_MEMORY_TYPE;
    } catch {
      /* vision module unavailable: treat as not running */
    }
    if (alreadyRunning) return;

    const estimate = await this._estimateVisionRuntimeBytes();
    // Idle residents are evicted first, as ensureModelLoaded does for a
    // model load; only residents pinned by in-flight work can refuse.
    const fits =
      typeof manager.makeRoomForExternalLoad === 'function'
        ? await manager.makeRoomForExternalLoad(estimate, { excludeType: runtimeType })
        : manager.canFitExternalLoad(estimate, { excludeType: runtimeType });
    if (fits) return;

    const status =
      /** @type {{ loadedModels?: string[], maxMemoryMB?: number, currentUsageMB?: number }} */ (
        manager.getMemoryStatus?.() || {}
      );
    const resident = Array.isArray(status.loadedModels) ? status.loadedModels : [];
    const budgetError = /** @type {Error & { code?: string }} */ (
      new Error(
        `Cannot start the vision runtime (${phase}): memory budget exceeded while ` +
          `${resident.join(', ') || 'other models'} stay in use` +
          (textUnloaded === false ? ' (text model is pinned by an active operation)' : '')
      )
    );
    budgetError.code = 'MODEL_MEMORY_BUDGET_EXCEEDED';
    logger.error('[LlamaService] Refusing vision runtime spawn: memory budget exceeded', {
      phase,
      estimateMB: Math.round(estimate / 1024 / 1024),
      maxMemoryMB: status.maxMemoryMB,
      currentUsageMB: status.currentUsageMB,
      resident,
      textUnloaded,
      embeddingUnloaded
    });
    throw budgetError;
  }

  async _waitForIdleOperations(
    /** @type {any} */ reason,
    timeoutMs = 30000,
    /** @type {any} */ options = {}
  ) {
    if (!this._coordinator) return true;
    const { modelType, excludeOperationId } = options || {};
    const getActiveCount = (/** @type {any} */ status) => {
      const operations = Array.isArray(status?.operations) ? status.operations : [];
      return operations.filter((/** @type {any} */ op) => {
        if (excludeOperationId && op.id === excludeOperationId) return false;
        if (modelType && op.modelType !== modelType) return false;
        return true;
      }).length;
    };
    const start = Date.now();
    let status = this._coordinator.getStatus();
    let activeCount = getActiveCount(status);
    // Observe the cooperative shutdown signal so shutdown() doesn't sit on
    // this wall-clock timeout when we already committed to teardown. This
    // matters most on force-quit paths where operations never actually
    // clear (driver hang, cancelled network) — without the signal check
    // we previously burned the full 30s before letting the app exit.
    const shutdownSignal = this._shutdownAbort?.signal;
    while (
      activeCount > 0 &&
      Date.now() - start < timeoutMs &&
      !(shutdownSignal?.aborted && reason === 'shutdown')
    ) {
      await delay(100);
      status = this._coordinator.getStatus();
      activeCount = getActiveCount(status);
    }
    if (activeCount > 0) {
      logger.warn(
        '[LlamaService] Operations still active after wait, aborting model unload to prevent crash',
        {
          reason,
          activeOperations: activeCount,
          modelType,
          excludeOperationId
        }
      );
      // Do not unload if operations are active - this prevents segfaults/crashes
      // The config change will apply to *future* loads, but current models stay resident
      return false;
    }
    return true;
  }

  /**
   * Acquire a model load lock to prevent configuration changes during a batch.
   * @param {string} modelType
   * @returns {Promise<Function>} release callback
   */
  async acquireModelLoadLock(modelType) {
    if (!this._coordinator) return () => {};
    return this._coordinator.acquireLoadLock(modelType);
  }

  /**
   * Return per-model inference queue pressure for adaptive background callers.
   */
  getQueueStats() {
    if (!this._coordinator || typeof this._coordinator.getQueueStats !== 'function') {
      return null;
    }
    return this._coordinator.getQueueStats();
  }

  /**
   * Whether optional background inference may run for a model type without
   * forcing a load that exceeds the memory budget.
   * @param {string} [modelType='text']
   * @returns {boolean}
   */
  canRunOptionalInference(modelType = 'text') {
    if (!this._initialized || !this._modelMemoryManager) {
      return false;
    }
    return this._modelMemoryManager.canRunOptionalLoad(modelType);
  }

  /**
   * Synchronous readiness probe consumed by the AI provider router via
   * LocalLlamaProvider.ready() and surfaced in Settings → AI ("Status").
   *
   * "Ready" means the local engine can serve a request of this type, NOT that
   * a model is already resident: a model is loaded lazily by _ensureModelLoaded()
   * on first use. We therefore report ready when a model is already loaded OR a
   * model of this type is selected (which _loadConfig() resolves to a sane
   * default). This mirrors how cloud providers' ready() reflects "configured"
   * (an API key is present) rather than a verified live connection — a genuinely
   * missing/corrupt model surfaces as a load error on first inference, exactly
   * like an invalid cloud key surfaces on the first call.
   *
   * Must stay synchronous because AIRouter.choose() is synchronous. When config
   * has not been loaded yet (very early startup) we kick off the idempotent
   * config load so the next probe reflects the selected model.
   *
   * @param {'text'|'vision'|'embedding'} [type='text']
   * @returns {boolean}
   */
  isModelReady(type = 'text') {
    const key = type === 'vision' || type === 'embedding' ? type : 'text';
    if (this._models?.[key]) return true;
    if (this._selectedModels?.[key]) return true;
    if (!this._configLoaded && !this._configLoadPromise) {
      this._bgWork.track(this._ensureConfigLoaded().catch(() => {}));
    }
    return false;
  }

  /**
   * Pin a model to prevent the memory manager from evicting it.
   * Use this instead of acquireModelLoadLock() when you need to keep a model
   * resident during a batch but the batch's items will call generateEmbedding()
   * (which internally acquires the non-reentrant load lock).
   * Callers MUST call unpinModel() when done.
   * @param {string} modelType
   */
  pinModel(modelType) {
    this._modelMemoryManager?.acquireRef(modelType);
  }

  /**
   * Unpin a model, allowing the memory manager to evict it if needed.
   * @param {string} modelType
   */
  unpinModel(modelType) {
    this._modelMemoryManager?.releaseRef(modelType);
  }

  async _recoverFromSequenceExhaustion(/** @type {any} */ modelType, /** @type {any} */ error) {
    logger.warn('[LlamaService] Sequence exhaustion detected, reloading model', {
      modelType,
      error: error?.message
    });
    const currentSeq = this._preferredContextSequences?.[modelType];
    if (!Number.isFinite(currentSeq) || currentSeq > 1) {
      this._preferredContextSequences[modelType] = 1;
      logger.info('[LlamaService] Reduced sequences to 1 after exhaustion', { modelType });
    }
    try {
      if (this._modelMemoryManager?.unloadModel) {
        const unloaded = await this._modelMemoryManager.unloadModel(modelType);
        if (unloaded === false) {
          // Active refs (or a failed dispose) kept the exhausted model
          // resident — the retry would hit the same exhausted sequences.
          // Mark the type stale so the next _ensureModelLoaded (which holds
          // the load lock) swaps it out once the pins drain.
          this._staleModelTypes.add(modelType);
          logger.warn(
            '[LlamaService] Exhausted model still pinned; deferring reload to next load',
            { modelType }
          );
        }
      } else if (this._modelMemoryManager?.unloadAll) {
        await this._modelMemoryManager.unloadAll();
      }
    } catch (unloadError) {
      logger.warn('[LlamaService] Failed to unload model during recovery', {
        modelType,
        error: unloadError?.message
      });
    }
    await delay(100);
  }

  async _supportsVisionInput() {
    if (this._visionInputSupported === true) return true;
    if (
      this._visionInputSupported === false &&
      Date.now() - this._visionInputCheckedAt < NEGATIVE_VISION_SUPPORT_TTL_MS
    ) {
      return false;
    }

    // concurrent callers both see _visionInputSupported === null.
    if (this._visionCheckPromise) return this._visionCheckPromise;

    this._visionCheckPromise = (async () => {
      try {
        await this._ensureConfigLoaded();
        const modelName = this._selectedModels.vision || this._config.visionModel;
        if (!modelName) {
          this._visionInputSupported = false;
          this._visionInputCheckedAt = Date.now();
          return this._visionInputSupported;
        }
        await this._ensureVisionAssets(modelName);
        if (this._visionProjectorStatus.required && !this._visionProjectorStatus.available) {
          this._visionInputSupported = false;
          this._visionInputCheckedAt = Date.now();
          return this._visionInputSupported;
        }
        this._visionInputSupported = true;
        this._visionInputCheckedAt = Date.now();
      } catch {
        this._visionInputSupported = false;
        this._visionInputCheckedAt = Date.now();
      }
      return this._visionInputSupported;
    })();

    try {
      return await this._visionCheckPromise;
    } finally {
      this._visionCheckPromise = null;
    }
  }

  /**
   * Determine the optimal GPU layer strategy based on available VRAM and the
   * actual GGUF model file size. Returns:
   *   - 999  → VRAM clearly sufficient for full offload (model + KV cache + overhead)
   *   - undefined → VRAM is tight; let node-llama-cpp auto-detect optimal layers
   *
   * Uses the real file size from disk (most accurate proxy for GPU memory) when
   * available, with a type-based estimate as fallback.
   *
   * The 60% VRAM threshold reserves ~40% for KV cache, OS/driver compositor,
   * and safety margin — suitable for laptops (shared thermal/power budgets)
   * through desktop GPUs with 4-24GB+ VRAM.
   *
   * @param {string} modelPath - Path to the GGUF model file
   * @param {string} type - Model type ('text', 'vision', 'embedding')
   * @returns {Promise<number|undefined>} GPU layers value (999 = max, undefined = auto)
   * @private
   */
  async _resolveGpuLayerStrategy(modelPath, type) {
    const vramMB = this._detectedGpu?.vramMB || 0;
    if (vramMB <= 0) {
      // No GPU info available — let node-llama-cpp decide
      return undefined;
    }

    // Best effort: read the actual GGUF file size (most accurate proxy for
    // model weight memory). Falls back to rough per-type estimates.
    let modelSizeMB;
    try {
      const stats = await fs.stat(modelPath);
      modelSizeMB = Math.ceil(stats.size / (1024 * 1024));
    } catch {
      /** @type {Record<string, number>} */
      const TYPE_ESTIMATES_MB = { embedding: 500, text: 4096, vision: 5120 };
      modelSizeMB = TYPE_ESTIMATES_MB[type] || 4096;
    }

    // If model file size is under 60% of VRAM, full offloading should be safe.
    // The remaining 40% covers KV cache, context buffers, OS compositor, and
    // driver overhead — conservative enough for laptop GPUs with tight VRAM.
    const maxSafeModelMB = Math.floor(vramMB * 0.6);

    if (modelSizeMB < maxSafeModelMB) {
      logger.debug('[LlamaService] VRAM sufficient for full GPU offload', {
        type,
        modelSizeMB,
        vramMB,
        headroomMB: maxSafeModelMB - modelSizeMB
      });
      return 999;
    }

    logger.debug('[LlamaService] VRAM tight, using auto GPU layer detection', {
      type,
      modelSizeMB,
      vramMB,
      deficitMB: modelSizeMB - maxSafeModelMB
    });
    return undefined;
  }

  /**
   * Resolve GPU layer count for the out-of-process llama-server (vision path).
   * In-process loads use {@link _resolveGpuLayerStrategy} when settings are "auto";
   * vision previously forwarded raw `gpuLayers` (often the string "auto"), so
   * VisionService omitted `--n-gpu-layers` and some llama-server builds defaulted
   * to CPU-only weights. Align behavior with the VRAM-aware strategy when possible.
   *
   * @param {string} modelName - Vision GGUF filename under modelsPath
   * @param {boolean} forceCpuVision - LlamaResilience CPU retry
   * @returns {Promise<number|undefined>} 0 = CPU; positive integer = --n-gpu-layers; undefined = omit flag (tight VRAM, server auto-fit)
   * @private
   */
  async _resolveGpuLayersForVisionServer(modelName, forceCpuVision) {
    if (forceCpuVision) {
      return 0;
    }
    const configLayers = this._config.gpuLayers;
    if (typeof configLayers === 'number' && Number.isFinite(configLayers) && configLayers >= 0) {
      return configLayers;
    }
    const modelPath = path.join(this._modelsPath, modelName);
    const strat = await this._resolveGpuLayerStrategy(modelPath, 'vision');
    if (typeof strat === 'number' && Number.isFinite(strat)) {
      return strat;
    }
    const vramMB = this._detectedGpu?.vramMB || 0;
    if (vramMB <= 0) {
      logger.info(
        '[LlamaService] Vision server: no VRAM telemetry; requesting max GPU offload (999) so llama-server uses GPU when available'
      );
      return 999;
    }

    // Tight VRAM: omitting --n-gpu-layers historically let llama-server pick
    // its own count, but on laptop GPUs (~6 GB) it over-offloads and the
    // process SIGTERMs itself mid-load_tensors. Compute an explicit count
    // that fits: vram - mmproj - KV cache - overhead = budget for weight
    // layers; budget / per-layer size = layers we can safely offload.
    const modelSizeMB = await this._safeStatMB(modelPath);
    const mmprojSizeMB = this._visionProjectorStatus.projectorSizeMB || 600;
    const ctxBytesPerToken = this._estimateVisionKvBytesPerToken(modelName);
    const ctxTokens = this._visionContextSize || LLAMA.CONTEXT_VISION;
    const ctxMB = Math.ceil((ctxBytesPerToken * ctxTokens) / (1024 * 1024));
    const usableForLayersMB = vramMB - mmprojSizeMB - ctxMB - LLAMA.VISION_TIGHT_VRAM_OVERHEAD_MB;

    if (usableForLayersMB <= 0) {
      logger.warn(
        '[LlamaService] Vision server: VRAM insufficient for partial offload — forcing CPU',
        {
          vramMB,
          modelSizeMB,
          mmprojSizeMB,
          ctxMB,
          overheadMB: LLAMA.VISION_TIGHT_VRAM_OVERHEAD_MB
        }
      );
      return 0;
    }

    const totalLayers = this._estimateVisionLayerCountForModel(modelName);
    const perLayerMB = Math.max(1, Math.ceil(modelSizeMB / totalLayers));
    const safeLayers = Math.max(
      1,
      Math.min(totalLayers, Math.floor(usableForLayersMB / perLayerMB))
    );
    logger.info('[LlamaService] Vision server: explicit GPU layer count for tight VRAM', {
      vramMB,
      modelSizeMB,
      mmprojSizeMB,
      ctxMB,
      perLayerMB,
      safeLayers,
      totalLayers,
      overheadMB: LLAMA.VISION_TIGHT_VRAM_OVERHEAD_MB
    });
    return safeLayers;
  }

  /**
   * Best-effort `fs.stat`-based size in MB. Returns a conservative fallback
   * when the path cannot be stat'd so callers (tight-VRAM layer math) still
   * produce a usable budget rather than dividing by zero.
   *
   * Fallback is intentionally larger than typical 7B-class GGUF weights
   * so the resulting layer count under-offloads — under-offloading is
   * recoverable (CPU layers are slower but the runtime still loads); over-
   * offloading SIGTERMs at `load_tensors` and is what this whole code path
   * exists to prevent.
   *
   * @param {string} filePath
   * @returns {Promise<number>} Size in MB (rounded up).
   * @private
   */
  async _safeStatMB(filePath) {
    try {
      const stats = await fs.stat(filePath);
      return Math.ceil(stats.size / (1024 * 1024));
    } catch {
      return 5120; // conservative ~5 GB fallback for vision-class models
    }
  }

  /**
   * Conservative estimate of bytes per token consumed by the KV cache for the
   * named vision model. Used by tight-VRAM layer math to subtract context
   * memory from the offload budget before dividing by per-layer size.
   *
   * Values are deliberately on the high side so over-estimation is the
   * error direction. Mistral / LLaMA-2 7B class models with grouped-query
   * attention land around 200-256 KB per token at typical KV dtypes.
   *
   * @param {string} _modelName
   * @returns {number} bytes per token
   * @private
   */
  _estimateVisionKvBytesPerToken(_modelName) {
    return 256 * 1024;
  }

  /**
   * Total transformer block count for the named vision model, used by
   * tight-VRAM layer math. Default 33 covers Mistral-7B-class (32 blocks +
   * the output projection layer that llama-server counts separately for
   * `--n-gpu-layers`); add lookup-table entries here when a model with a
   * meaningfully different layer count is added to the catalog.
   *
   * @param {string} _modelName
   * @returns {number}
   * @private
   */
  _estimateVisionLayerCountForModel(_modelName) {
    return 33;
  }

  /**
   * ACTUAL model loading logic called by ModelMemoryManager
   * @param {string} type
   * @param {any} [options]
   * @returns {Promise<any>}
   * @private
   */
  async _loadModel(type, /** @type {any} */ options = {}) {
    const modelName = this._selectedModels[type];
    if (!modelName) {
      const noModelError = /** @type {Error & { code?: string }} */ (
        new Error(`No ${type} model configured`)
      );
      noModelError.code = ERROR_CODES.LLAMA_MODEL_NOT_FOUND;
      throw noModelError;
    }

    const modelPath = path.join(this._modelsPath, modelName);

    if (type === 'vision') {
      await this._ensureVisionAssets(modelName);
    }

    // Verify file exists. modelFileAccessible is set on the success branch
    // and consulted later (around line 1810) to decide whether to clear the
    // auto-fallback degraded flag — only direct-path loads (not heal-via-
    // fallback) signify recovery from a missing-model state.
    let modelFileAccessible;
    try {
      await fs.access(modelPath);
      modelFileAccessible = true;
      // Tell the memory budget what this model really weighs. The manager's
      // fixed per-type guesses (text 4 GiB) undercount a 7B Q4 file by
      // about 1 GiB before KV cache; updateModelSizeEstimate adds the
      // runtime overhead and the manager records the refined size for this
      // load (audit row ML-03).
      try {
        const stats = await fs.stat(modelPath);
        if (stats?.size > 0) {
          this._modelMemoryManager?.updateModelSizeEstimate?.(type, stats.size);
        }
      } catch {
        /* keep the fixed estimate */
      }
    } catch {
      if (type === 'embedding') {
        const healedModel = await this._resolveMissingEmbeddingModel(modelName);
        if (healedModel && healedModel !== modelName) {
          logger.warn(
            `[LlamaService] Configured embedding model "${modelName}" not found, auto-healing to "${healedModel}"`
          );
          this._selectedModels.embedding = healedModel;
          this._config.embeddingModel = healedModel;
          await this._persistEmbeddingModelSelection(
            SettingsService.getInstance(),
            null,
            healedModel
          );
          return this._loadModel(type, options);
        }
      }

      // If primary model is missing, try default model as fallback
      const defaultModel =
        type === 'text'
          ? AI_DEFAULTS.TEXT.MODEL
          : type === 'vision'
            ? AI_DEFAULTS.IMAGE.MODEL
            : AI_DEFAULTS.EMBEDDING.MODEL;

      if (modelName !== defaultModel) {
        const defaultPath = path.join(this._modelsPath, defaultModel);
        try {
          await fs.access(defaultPath);
          logger.warn(
            `[LlamaService] Configured ${type} model "${modelName}" not found, falling back to default "${defaultModel}"`
          );
          this._selectedModels[type] = defaultModel;
          // Surface the silent fallback to the renderer. Quality may be
          // reduced (especially when the user explicitly configured a larger
          // model), so a warning banner + diagnostics entry is appropriate.
          try {
            const { getInstance: getDegradedStateTracker } = require('./DegradedStateTracker');
            getDegradedStateTracker().raise({
              code: `llama.auto-fallback.${type}`,
              subsystem: 'llama',
              severity: 'warning',
              message: `Configured ${type} model is missing; using default "${defaultModel}" instead. Reinstall the preferred model from Settings → Models.`,
              detail: {
                errorCode: ERROR_CODES.LLAMA_MODEL_AUTO_FALLBACK,
                type,
                configuredModel: modelName,
                fallbackModel: defaultModel
              }
            });
          } catch (trackerErr) {
            logger.debug('[LlamaService] Could not raise auto-fallback flag', {
              error: trackerErr?.message
            });
          }
          // Recursively call with the new model
          return this._loadModel(type, options);
        } catch {
          // Default also missing, proceed to throw original error
        }
      }

      // Before giving up, peek at legacy userData paths. If the model exists
      // there but not at the current models path, surface the path-mismatch
      // copy so users know to move or re-migrate the file (rather than the
      // generic "model not found" which implies a fresh install).
      const legacyMatch = await this._findModelInLegacyUserData(modelName).catch(
        /** @returns {any} */ () => null
      );
      if (legacyMatch) {
        const mismatchError = /** @type {Error & { code?: string, detail?: any }} */ (
          new Error(
            `Model "${modelName}" found in legacy directory (${legacyMatch}) but missing from ${this._modelsPath}`
          )
        );
        mismatchError.code = ERROR_CODES.LLAMA_MODEL_PATH_MISMATCH;
        mismatchError.detail = {
          configuredModel: modelName,
          legacyPath: legacyMatch,
          expectedPath: modelPath
        };
        throw mismatchError;
      }

      const notFoundError = /** @type {Error & { code?: string }} */ (
        new Error(`Model not found: ${modelName}`)
      );
      notFoundError.code = ERROR_CODES.LLAMA_MODEL_NOT_FOUND;
      throw notFoundError;
    }

    const startTime = Date.now();
    logger.info(`[LlamaService] Loading ${type} model: ${modelName}`);

    try {
      // Resolve gpuLayers with a three-tier fallback strategy:
      //   1. Max offload (gpuLayers: 999) — request all layers on GPU.
      //      node-llama-cpp clamps to the model's actual layer count.
      //   2. Auto (gpuLayers: undefined) — let node-llama-cpp conservatively
      //      pick layers that fit in available VRAM.
      //   3. CPU only (gpuLayers: 0) — no GPU offloading.
      // gpuLayersOverride takes precedence (set by CPU fallback retries).
      let gpuLayers;
      if (typeof options.gpuLayersOverride === 'number') {
        gpuLayers = options.gpuLayersOverride;
        logger.info(`[LlamaService] GPU layers overridden for ${type}`, {
          override: gpuLayers,
          reason: gpuLayers === 0 ? 'CPU fallback' : 'explicit'
        });
      } else if (options._gpuAutoFallback) {
        // Tier 2: intermediate fallback — let node-llama-cpp auto-detect
        gpuLayers = undefined;
        logger.info(`[LlamaService] GPU layers auto-detection for ${type} (fallback from max)`);
      } else {
        const configLayers = this._config.gpuLayers;
        if (typeof configLayers === 'number' && configLayers >= 0) {
          // Explicit numeric configuration from user (e.g., 20)
          gpuLayers = configLayers;
        } else {
          // 'auto', -1, null, undefined: use VRAM-aware strategy.
          // Compares actual model file size against available VRAM to decide
          // between max offloading (999) and auto-detection (undefined).
          // The three-tier fallback chain (max → auto → CPU) is the safety net.
          gpuLayers = await this._resolveGpuLayerStrategy(modelPath, type);
        }
      }

      let model;
      try {
        /** @type {Record<string, any>} */
        const modelOptions = { modelPath };
        if (typeof gpuLayers === 'number') {
          modelOptions.gpuLayers = gpuLayers;
        }
        model = await this._llama.loadModel(modelOptions);
      } catch (err) {
        if (shouldFallbackToCPU(err)) {
          // Tier 2: max failed → try auto-detection
          if (!options._gpuAutoFallback && !options._cpuFallbackTried && gpuLayers > 0) {
            logger.warn('[LlamaService] Max GPU offload failed, falling back to auto-detection', {
              error: err?.message || String(err)
            });
            return this._loadModel(type, { ...options, _gpuAutoFallback: true });
          }
          // Tier 3: auto failed → try CPU only
          if (!options._cpuFallbackTried) {
            logger.warn('[LlamaService] GPU offload failed, falling back to CPU', {
              error: err?.message || String(err)
            });
            return this._loadModel(type, {
              ...options,
              gpuLayersOverride: 0,
              _cpuFallbackTried: true
            });
          }
        }
        // Annotate the load error so renderer error mapping can surface the
        // actionable SIGILL / CPU-incompatibility copy instead of the generic
        // "failed to load model" message.
        if (looksLikeCpuIncompatibility(err) && !err.code) {
          attachErrorCode(err, ERROR_CODES.LLAMA_MODEL_INCOMPATIBLE_CPU);
        } else if (!err.code) {
          attachErrorCode(err, ERROR_CODES.LLAMA_MODEL_LOAD_FAILED);
        }
        throw err;
      }

      logger.info(`[LlamaService] Model ${type} GPU offload`, {
        requestedLayers:
          gpuLayers === 999 ? 'max' : typeof gpuLayers === 'number' ? gpuLayers : 'auto',
        actualGpuLayers: model.gpuLayers ?? 'unknown',
        backend: this._gpuBackend
      });

      let context;
      let lastError;

      if (type === 'embedding') {
        try {
          context = await model.createEmbeddingContext();
          const ctxSize =
            context?.contextSize ?? context?._contextSize ?? model?.trainContextSize ?? null;
          if (Number.isFinite(ctxSize) && ctxSize > 0) {
            this._embeddingContextSize = ctxSize;
          }
        } catch (err) {
          lastError = err;
          logger.warn(`[LlamaService] Failed to create embedding context: ${err.message}`);

          if (shouldFallbackToCPU(err)) {
            // Tier 2: max → auto
            if (
              !options._gpuAutoFallback &&
              !options._cpuFallbackTried &&
              typeof gpuLayers === 'number' &&
              gpuLayers > 0
            ) {
              logger.warn('[LlamaService] Embedding context failed, falling back to auto GPU');
              try {
                await model.dispose?.();
              } catch {
                /* ignore */
              }
              return this._loadModel(type, { ...options, _gpuAutoFallback: true });
            }
            // Tier 3: auto → CPU
            if (!options._cpuFallbackTried && gpuLayers !== 0) {
              logger.warn('[LlamaService] Embedding context failed on GPU, retrying on CPU');
              try {
                await model.dispose?.();
              } catch {
                /* ignore */
              }
              return this._loadModel(type, {
                ...options,
                gpuLayersOverride: 0,
                _cpuFallbackTried: true
              });
            }
          }
        }
      } else {
        // Try to create context, falling back to smaller sizes if OOM/failure occurs
        const configuredSize = this._config.contextSize;
        const preferredSize = this._preferredContextSize?.[type];
        const candidates = [];
        if (Number.isFinite(preferredSize) && preferredSize > 0) {
          candidates.push(preferredSize);
        }
        if (!candidates.includes(configuredSize)) {
          candidates.push(configuredSize);
        }
        if (configuredSize > 4096 && !candidates.includes(4096)) candidates.push(4096);
        if (configuredSize > 2048 && !candidates.includes(2048)) candidates.push(2048);
        if (configuredSize > 1024 && !candidates.includes(1024)) candidates.push(1024);

        const baseSequences = this._getContextSequences(type);
        const sequenceCandidates = [];
        if (Number.isFinite(baseSequences) && baseSequences > 0) {
          sequenceCandidates.push(baseSequences);
        }
        if (!sequenceCandidates.includes(1)) sequenceCandidates.push(1);

        let contextCreated = false;
        // Tracks whether a larger candidate was actually attempted and threw.
        // Without this, using a smaller *preferred* size first (e.g. the
        // low-VRAM ladder, which never even tries `configuredSize`) was logged
        // as "Context creation failed for size N" — a false alarm that made a
        // correctly-working low-VRAM setup look broken.
        let attemptedAndFailed = false;
        for (const size of candidates) {
          for (const sequences of sequenceCandidates) {
            try {
              context = await model.createContext({
                contextSize: size,
                sequences
              });

              if (size !== configuredSize) {
                if (attemptedAndFailed) {
                  logger.warn(
                    `[LlamaService] Context creation failed at a larger size; fell back to ${size} (configured ${configuredSize})`
                  );
                } else {
                  // Intentional preferred size (e.g. low-VRAM); nothing failed.
                  logger.info('[LlamaService] Using preferred context size', {
                    type,
                    contextSize: size,
                    configuredSize
                  });
                }
              }
              if (sequences !== baseSequences) {
                logger.warn('[LlamaService] Reduced context sequences to fit VRAM', {
                  type,
                  sequences
                });
              }

              this._preferredContextSize[type] = size;
              this._preferredContextSequences[type] = sequences;
              contextCreated = true;
              break;
            } catch (err) {
              lastError = err;
              attemptedAndFailed = true;
              logger.warn(
                `[LlamaService] Failed to create ${type} context with size ${size} and sequences ${sequences}: ${err.message}`
              );
            }
          }
          if (contextCreated) break;
        }

        if (!context && shouldFallbackToCPU(lastError)) {
          // Exhausted all context candidates on the current backend profile.
          // Only now escalate to auto GPU / CPU fallback.
          if (
            !options._gpuAutoFallback &&
            !options._cpuFallbackTried &&
            typeof gpuLayers === 'number' &&
            gpuLayers > 0
          ) {
            logger.warn('[LlamaService] Context candidates exhausted, falling back to auto GPU');
            try {
              await model.dispose?.();
            } catch {
              /* ignore */
            }
            return this._loadModel(type, { ...options, _gpuAutoFallback: true });
          }
          if (!options._cpuFallbackTried && gpuLayers !== 0) {
            logger.warn('[LlamaService] Context candidates exhausted on GPU, retrying on CPU');
            try {
              await model.dispose?.();
            } catch {
              /* ignore */
            }
            return this._loadModel(type, {
              ...options,
              gpuLayersOverride: 0,
              _cpuFallbackTried: true
            });
          }
        }
      }

      if (!context) {
        // Without this, the model stays resident in VRAM despite having no
        // usable context, and repeated retries can exhaust GPU memory.
        let disposed = false;
        try {
          if (model && typeof model.dispose === 'function') {
            await model.dispose();
            disposed = true;
          }
        } catch (disposeErr) {
          logger.warn('[LlamaService] Failed to dispose model after context failure', {
            type,
            error: disposeErr?.message
          });
        }
        if (!disposed && model) {
          logger.error('[LlamaService] Model disposal failed — potential GPU memory leak', {
            type
          });
        }
        throw lastError || new Error('Failed to create context');
      }

      this._models[type] = model;
      this._contexts[type] = context;

      // Record what this load placed on the GPU from what the model reports —
      // not from what we asked for. `gpuLayers` is `undefined` on both auto
      // paths (the tier-2 `_gpuAutoFallback` retry and
      // `_resolveGpuLayerStrategy`'s tight-VRAM answer), and `undefined !== 0`
      // used to clear the record, so a type that node-llama-cpp then placed
      // entirely on the CPU reported as back on the GPU. `model.gpuLayers` is
      // the layer count node-llama-cpp *resolved* for this load (0 whenever
      // GPU support is off or nothing was offloaded) — strictly better than
      // the request, since it is recomputed even for an explicit numeric
      // `gpuLayers`. It is resolved just before the native load rather than
      // read back from llama.cpp afterwards, so a divergence between that
      // plan and what llama.cpp ends up doing stays invisible here.
      const realizedGpuLayers = typeof model.gpuLayers === 'number' ? model.gpuLayers : null;
      const cpuByUserChoice =
        typeof options.gpuLayersOverride !== 'number' && this._config.gpuLayers === 0;
      if (this._gpuBackend === 'cpu') {
        // Nothing is running on a GPU backend, so a per-type record here
        // would have the badge claim "<type> on CPU" alongside an active GPU
        // backend — false. Engine-wide CPU is reported by `gpuBackend`
        // itself; note that `_engineCpuFallback` covers only the case where
        // GPU init *threw* (initLlamaWithBackend's catch). When the selector
        // instead negotiates CPU successfully after a GPU candidate failed,
        // `_engineCpuFallback` stays false and the renderer surfaces the
        // fallback from `gpuBackend === 'cpu'` plus a detected non-CPU GPU
        // (LlamaConfigSection's "GPU detected but running on CPU" notice),
        // not from this set.
        this._cpuFallbackTypes.delete(type);
      } else if (realizedGpuLayers === 0) {
        // A user who configured `gpuLayers: 0` chose the CPU; that is not a
        // fallback and must not raise the "GPU unavailable" warning. Clear
        // rather than leave as-is: a record from an earlier genuine fallback
        // would otherwise outlive the choice and keep the warning up forever.
        if (cpuByUserChoice) this._cpuFallbackTypes.delete(type);
        else this._cpuFallbackTypes.add(type);
      } else if (realizedGpuLayers > 0) {
        this._cpuFallbackTypes.delete(type);
      } else if (gpuLayers === 0 && options.gpuLayersOverride === 0) {
        // The binding reported no layer count at all. The one thing we know
        // is that this load asked for CPU-only, so record it; on any other
        // request an unconfirmed value must not clear an existing record.
        this._cpuFallbackTypes.add(type);
      }

      // Clear any auto-fallback degraded flag for this model type. Without
      // this, when the user reinstalled a previously-missing model and the
      // resolver successfully loaded it (modelFileAccessible=true above),
      // the warning banner stayed up forever — DegradedStateTracker's flag
      // was raised on fallback but had no recovery path. Clear it on every
      // successful load that didn't go through the fallback chain.
      if (modelFileAccessible) {
        try {
          const { getInstance: _getDegradedStateTracker } = require('./DegradedStateTracker');
          _getDegradedStateTracker().clear(`llama.auto-fallback.${type}`);
        } catch {
          /* tracker may not be available in tests */
        }
      }

      this._metrics.recordModelLoad(type, Date.now() - startTime);
      return context;
    } catch (error) {
      logger.error(`[LlamaService] Failed to load ${type} model:`, error);
      if (isOutOfMemoryError(error)) {
        throw attachErrorCode(error, ERROR_CODES.LLAMA_OOM);
      }
      throw attachErrorCode(error, ERROR_CODES.LLAMA_MODEL_LOAD_FAILED);
    }
  }

  /**
   * Force-reload a model in CPU-only mode.
   * Called by resilience layer when GPU errors are detected.
   * @param {string} modelType - Model type to reload
   * @private
   */
  async _reloadModelCPU(modelType, /** @type {any} */ options = {}) {
    if (modelType === 'vision') {
      // Vision inference runs in the llama-server child; analyzeImage's
      // forceCPU retry already rebuilds the server config with the CPU
      // backend, and _ensureServer restarts the child when the config
      // changes. Loading the vision GGUF in-process here doubled vision
      // memory at the moment the GPU was already out of it, and nothing read
      // that model (audit row ML-02). Reset the breaker, as the in-process
      // path did, so GPU failures do not count against the CPU server.
      const { resetLlamaCircuit } = require('./LlamaResilience');
      resetLlamaCircuit('vision');
      logger.warn(
        '[LlamaService] Vision CPU fallback: restarting llama-server on the CPU backend; nothing to load in-process'
      );
      return null;
    }
    logger.warn(`[LlamaService] Reloading ${modelType} model in CPU-only mode`);

    const releaseLock = this._coordinator
      ? await this._coordinator.acquireLoadLock(modelType, {
          onForceRelease: async (/** @type {any} */ { reason }) => {
            logger.error(
              '[LlamaService] Force-release during CPU reload; unloading partially-loaded model',
              { modelType, reason }
            );
            try {
              if (this._modelMemoryManager?.unloadModel) {
                await this._modelMemoryManager.unloadModel(modelType);
              }
            } catch (unloadErr) {
              logger.warn('[LlamaService] CPU-reload unload threw', {
                modelType,
                error: unloadErr?.message
              });
            }
          }
        })
      : null;
    this._beginModelReloadGate(modelType);
    const { operationId } = options || {};

    try {
      // Other operations of the same model type may be blocked on the reload
      // gate that we just acquired, creating a circular wait. A shorter timeout
      // prevents a 60s hang; if operations are still active after 10s, they are
      // likely blocked on us, so proceeding with the reload is the correct action.
      const safeToReload = await this._waitForIdleOperations('cpu-fallback', 10000, {
        modelType,
        excludeOperationId: operationId
      });
      if (!safeToReload) {
        logger.warn(
          '[LlamaService] Other operations still active during CPU fallback — ' +
            'likely blocked on reload gate. Proceeding with reload.',
          { modelType, operationId }
        );
        // Don't throw — proceed with the reload. Operations waiting on the gate
        // will get the new CPU-loaded model when we release the gate.
      }

      // Unload via ModelMemoryManager to keep its tracking (_loadedModels map,
      // _currentMemoryUsage) consistent. Bypassing the manager leaves stale
      // entries that cause getLoadedContext() to return disposed contexts.
      //
      // allowedRefs: 1 — every _reloadModelCPU call site sits inside its
      // operation's own acquireRef window (the resilience retry callback),
      // so waiting for zero refs would deadlock on our own pin and time out
      // deterministically. One remaining ref is ours; it is not running
      // inference (the GPU error already aborted this attempt's inference).
      if (this._modelMemoryManager) {
        const unloaded = await this._modelMemoryManager.unloadModel(modelType, {
          allowedRefs: 1
        });
        if (unloaded === false) {
          // The GPU model is still resident (active refs or failed dispose) —
          // ensureModelLoaded below would early-return that same GPU context
          // and the "CPU fallback" would silently change nothing, re-hitting
          // the OOM. Mark the type stale so the next locked load swaps it,
          // and surface a retryable failure to the caller.
          this._staleModelTypes.add(modelType);
          const stillResident = /** @type {Error & { code?: string }} */ (
            new Error(
              `CPU fallback for ${modelType} deferred: model is pinned by active operations`
            )
          );
          stillResident.code = 'MODEL_RELOAD_DEFERRED';
          throw stillResident;
        }
      } else {
        // Fallback: no memory manager yet (early startup). Dispose directly.
        if (this._contexts[modelType]) {
          try {
            await this._contexts[modelType].dispose?.();
          } catch {
            /* ignore */
          }
          this._contexts[modelType] = null;
        }
        if (this._models[modelType]) {
          try {
            await this._models[modelType].dispose?.();
          } catch {
            /* ignore */
          }
          this._models[modelType] = null;
        }
      }

      // Reset circuit breaker before CPU reload — the GPU failures that triggered
      // this fallback are not indicative of the CPU path's health.
      const { resetLlamaCircuit: resetCircuitCPU } = require('./LlamaResilience');
      resetCircuitCPU(modelType);

      // Reload with gpuLayers: 0 (CPU only)
      if (this._modelMemoryManager) {
        return this._modelMemoryManager.ensureModelLoaded(modelType, { gpuLayersOverride: 0 });
      }
      return this._loadModel(modelType, { gpuLayersOverride: 0 });
    } finally {
      this._endModelReloadGate(modelType);
      if (releaseLock) {
        try {
          releaseLock();
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * Generate embedding with resilience, metrics, and fallback model chain.
   *
   * If the primary embedding model is missing or fails to load, tries each model
   * in AI_DEFAULTS.EMBEDDING.FALLBACK_MODELS before giving up. This mirrors the
   * fallback behavior of the old OllamaService.
   */
  async generateEmbedding(/** @type {any} */ text, /** @type {any} */ options = {}) {
    const operationId = `embed-${require('crypto').randomUUID()}`;
    const signal = options.signal || options.abortSignal || null;
    if (signal?.aborted) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error('generateEmbedding aborted before start')
      );
      err.name = 'AbortError';
      err.code = 'ABORT_ERR';
      throw err;
    }
    await this._awaitModelReady('embedding');

    const modelName =
      this._selectedModels.embedding || this._config.embeddingModel || AI_DEFAULTS.EMBEDDING.MODEL;
    const normalizedText = normalizeEmbeddingInput(text, 'generateEmbedding', modelName);

    return this._coordinator.withModel(
      'embedding',
      async () => {
        this._modelMemoryManager?.acquireRef('embedding');
        try {
          try {
            return await this._executeEmbeddingInference(normalizedText, { operationId, signal });
          } catch (error) {
            // Don't run the fallback if the caller has already cancelled —
            // it would rebind and retry against a second model even though
            // the requester is gone.
            if (signal?.aborted) throw error;
            return await this._tryEmbeddingFallback(normalizedText, error);
          }
        } finally {
          this._modelMemoryManager?.releaseRef('embedding');
        }
      },
      { operationId, signal }
    );
  }

  /**
   * Core embedding inference wrapped in resilience (retry + circuit breaker).
   * @private
   */
  async _executeEmbeddingInference(/** @type {any} */ text, options = {}) {
    return withLlamaResilience(
      async (retryOptions) => {
        // Handle CPU fallback from LlamaResilience when GPU errors occur
        if (retryOptions?.forceCPU && this._gpuBackend !== 'cpu') {
          await this._reloadModelCPU('embedding', options);
        }

        const startTime = Date.now();

        try {
          // selfRef: generateEmbedding holds acquireRef('embedding') around
          // this entire resilience callback.
          const context = await this._ensureModelLoaded('embedding', { selfRef: true });

          const embedding = await context.getEmbeddingFor(text);
          const vector = Array.from(embedding.vector);
          const durationMs = Date.now() - startTime;

          this._metrics.recordEmbedding(durationMs, true);

          logger.debug('[LlamaService] Embedding generated', {
            model: this._selectedModels.embedding,
            inputChars: text?.length || 0,
            dimensions: vector.length,
            durationMs,
            gpu: this._gpuBackend !== 'cpu'
          });
          getSystemAnalyticsSafe()?.recordPipelineOutcome?.('embedding', 'primary', {
            reason: this._selectedModels.embedding || 'primary_embedding_model'
          });

          return {
            embedding: vector,
            model: this._selectedModels.embedding
          };
        } catch (error) {
          this._metrics.recordEmbedding(Date.now() - startTime, false);
          if (isOutOfMemoryError(error)) {
            throw attachErrorCode(error, ERROR_CODES.LLAMA_OOM);
          }
          const originalCode = error?.code || error?.originalError?.code;
          if (
            originalCode === ERROR_CODES.LLAMA_MODEL_NOT_FOUND ||
            originalCode === ERROR_CODES.LLAMA_MODEL_LOAD_FAILED
          ) {
            throw attachErrorCode(error, originalCode);
          }
          throw attachErrorCode(error, ERROR_CODES.LLAMA_INFERENCE_FAILED);
        }
      },
      { modelType: 'embedding' }
    );
  }

  /**
   * One-off embedding inference for a specific model without mutating selection.
   * Used only for fallback attempts to avoid mid-batch model changes.
   * @private
   */
  async _executeEmbeddingInferenceWithModel(/** @type {any} */ text, /** @type {any} */ modelName) {
    if (!this._initialized) {
      await this.initialize();
    }
    await this._ensureConfigLoaded();

    const resolvedName = String(modelName || '').trim();
    if (!resolvedName) {
      const noModelError = /** @type {Error & { code?: string }} */ (
        new Error('No embedding model configured')
      );
      noModelError.code = ERROR_CODES.LLAMA_MODEL_NOT_FOUND;
      throw noModelError;
    }

    const modelPath = path.join(this._modelsPath, resolvedName);
    try {
      await fs.access(modelPath);
    } catch {
      const notFoundError = /** @type {Error & { code?: string }} */ (
        new Error(`Model not found: ${resolvedName}`)
      );
      notFoundError.code = ERROR_CODES.LLAMA_MODEL_NOT_FOUND;
      throw notFoundError;
    }

    const normalizedText = normalizeEmbeddingInput(
      text,
      '_executeEmbeddingInferenceWithModel',
      resolvedName
    );

    const inferWithOptions = async (/** @type {any} */ loadOptions = {}) => {
      let model = null;
      let context = null;
      const startTime = Date.now();

      try {
        let gpuLayers;
        const configLayers = this._config.gpuLayers;
        if (loadOptions.forceCPU || loadOptions._cpuFallbackTried) {
          gpuLayers = 0;
        } else if (loadOptions._gpuAutoFallback) {
          gpuLayers = undefined;
        } else if (typeof configLayers === 'number' && configLayers >= 0) {
          gpuLayers = configLayers;
        } else {
          gpuLayers = await this._resolveGpuLayerStrategy(modelPath, 'embedding');
        }

        /** @type {Record<string, any>} */
        const modelOptions = { modelPath };
        if (typeof gpuLayers === 'number') {
          modelOptions.gpuLayers = gpuLayers;
        }
        model = await this._llama.loadModel(modelOptions);

        try {
          context = await model.createEmbeddingContext();
        } catch (contextError) {
          if (shouldFallbackToCPU(contextError)) {
            // Tier 2: explicit GPU layers -> auto GPU
            if (
              !loadOptions._gpuAutoFallback &&
              !loadOptions._cpuFallbackTried &&
              typeof gpuLayers === 'number' &&
              gpuLayers > 0
            ) {
              logger.warn(
                '[LlamaService] Fallback embedding context failed, retrying with auto GPU layers',
                { model: resolvedName }
              );
              return inferWithOptions({ ...loadOptions, _gpuAutoFallback: true });
            }
            // Tier 3: auto/explicit GPU -> CPU
            if (!loadOptions._cpuFallbackTried && gpuLayers !== 0) {
              logger.warn(
                '[LlamaService] Fallback embedding context failed on GPU, retrying on CPU',
                {
                  model: resolvedName
                }
              );
              return inferWithOptions({ ...loadOptions, _cpuFallbackTried: true, forceCPU: true });
            }
          }
          throw contextError;
        }

        const embedding = await context.getEmbeddingFor(normalizedText);
        const vector = Array.from(embedding.vector);
        this._metrics.recordEmbedding(Date.now() - startTime, true);
        return { embedding: vector, model: resolvedName };
      } catch (error) {
        this._metrics.recordEmbedding(Date.now() - startTime, false);
        if (shouldFallbackToCPU(error) && !loadOptions._cpuFallbackTried) {
          logger.warn('[LlamaService] Fallback embedding load failed on GPU, retrying on CPU', {
            model: resolvedName
          });
          return inferWithOptions({ ...loadOptions, _cpuFallbackTried: true, forceCPU: true });
        }
        if (isOutOfMemoryError(error)) {
          throw attachErrorCode(error, ERROR_CODES.LLAMA_OOM);
        }
        if (error?.code === ERROR_CODES.LLAMA_MODEL_NOT_FOUND) {
          throw error;
        }
        throw attachErrorCode(error, ERROR_CODES.LLAMA_MODEL_LOAD_FAILED);
      } finally {
        if (context?.dispose) {
          try {
            await context.dispose();
          } catch {
            /* ignore */
          }
        }
        if (model?.dispose) {
          try {
            await model.dispose();
          } catch {
            /* ignore */
          }
        }
      }
    };

    return withLlamaResilience(
      async (retryOptions = {}) => {
        const forceCPU = retryOptions?.forceCPU === true;
        return inferWithOptions(forceCPU ? { _cpuFallbackTried: true, forceCPU: true } : {});
      },
      { modelType: 'embedding' }
    );
  }

  /**
   * Try fallback embedding models when the primary model is missing or corrupt.
   *
   * Only activates for LLAMA_MODEL_NOT_FOUND and LLAMA_MODEL_LOAD_FAILED errors.
   * OOM and inference errors propagate immediately (fallback models would likely
   * hit the same issue).
   *
   * Checks both error.code and error.originalError.code because the resilience
   * wrapper may wrap the original error.
   *
   * @private
   */
  async _tryEmbeddingFallback(/** @type {any} */ text, /** @type {any} */ primaryError) {
    const errorCode = primaryError?.code || primaryError?.originalError?.code;

    if (
      errorCode !== ERROR_CODES.LLAMA_MODEL_NOT_FOUND &&
      errorCode !== ERROR_CODES.LLAMA_MODEL_LOAD_FAILED
    ) {
      getSystemAnalyticsSafe()?.recordPipelineOutcome?.('embedding', 'error', {
        reason: primaryError?.message || errorCode || 'embedding_inference_error'
      });
      throw primaryError;
    }

    const primaryModel = this._selectedModels.embedding;
    const expectedDim = resolveEmbeddingDimension(primaryModel, {
      defaultDimension: AI_DEFAULTS.EMBEDDING?.DIMENSIONS
    });
    const fallbackModels = (AI_DEFAULTS.EMBEDDING.FALLBACK_MODELS || []).filter(
      (m) => m !== primaryModel
    );

    if (fallbackModels.length === 0) {
      throw primaryError;
    }

    logger.warn('[LlamaService] Primary embedding model unavailable, trying fallback chain', {
      primaryModel,
      error: primaryError.message,
      code: errorCode,
      fallbacks: fallbackModels
    });

    for (const fallbackModel of fallbackModels) {
      const fallbackDim = resolveEmbeddingDimension(fallbackModel, {
        defaultDimension: expectedDim
      });
      if (fallbackDim !== expectedDim) {
        logger.warn('[LlamaService] Skipping embedding fallback due to dimension mismatch', {
          primaryModel,
          fallbackModel,
          expectedDim,
          fallbackDim
        });
        continue;
      }
      try {
        const result = await this._executeEmbeddingInferenceWithModel(text, fallbackModel);

        logger.warn('[LlamaService] Embedding fallback succeeded', {
          originalModel: primaryModel,
          fallbackModel
        });
        getSystemAnalyticsSafe()?.recordPipelineOutcome?.('embedding', 'fallback', {
          reason: `fallback_model:${fallbackModel}`
        });

        return result;
      } catch (fallbackError) {
        if (fallbackError?.code === ERROR_CODES.LLAMA_OOM) {
          throw fallbackError;
        }
        logger.warn(`[LlamaService] Fallback model also failed: ${fallbackModel}`, {
          error: fallbackError.message
        });
      }
    }

    // All fallbacks exhausted — throw the original error
    getSystemAnalyticsSafe()?.recordPipelineOutcome?.('embedding', 'error', {
      reason: primaryError?.message || 'embedding_fallback_exhausted'
    });
    throw primaryError;
  }

  /**
   * Batch generate embeddings.
   *
   * The previous implementation called generateEmbedding() per item, which
   * acquired a fresh ModelAccessCoordinator inference slot and bumped the
   * memory-manager ref count for every text. With the embedding queue's
   * default concurrency of 1 those per-item acquires also serialised any
   * "parallelism" inside a chunk.
   *
   * This version pins the embedding model once for the whole batch and holds
   * a single inference slot for each chunk of CHUNK_SIZE items. That collapses
   * N coordinator round-trips into ceil(N/CHUNK_SIZE), while still releasing
   * the slot between chunks so foreground requests (chat, search) can
   * interleave fairly.
   *
   * Per-item retry / model fallback semantics are preserved by calling the
   * existing _executeEmbeddingInference + _tryEmbeddingFallback helpers from
   * inside the held slot — neither of those takes the inference slot itself.
   */
  async batchGenerateEmbeddings(/** @type {any} */ texts, /** @type {any} */ options = {}) {
    if (!Array.isArray(texts)) {
      const error = new TypeError(
        '[LlamaService] batchGenerateEmbeddings expects an array of texts'
      );
      throw attachErrorCode(error, ERROR_CODES.INVALID_INPUT);
    }
    const { onProgress } = options;
    const signal = options.signal || options.abortSignal || null;
    if (signal?.aborted) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error('batchGenerateEmbeddings aborted before start')
      );
      err.name = 'AbortError';
      err.code = 'ABORT_ERR';
      throw err;
    }

    const total = texts.length;
    if (total === 0) return { embeddings: [], failedIndexes: [] };

    await this._awaitModelReady('embedding');

    const modelName =
      this._selectedModels.embedding || this._config.embeddingModel || AI_DEFAULTS.EMBEDDING.MODEL;

    const operationId = `batch-embed-${require('crypto').randomUUID()}`;
    const results = new Array(total);
    /** @type {number[]} */
    const failedIndexes = [];
    let completed = 0;

    // Bound per-slot wall clock so other lanes can interleave between chunks.
    const CHUNK_SIZE = 16;

    // Pin the embedding model for the whole batch so the memory manager
    // cannot evict it between chunks under VRAM pressure. Pairs with the
    // releaseRef in the finally block.
    this._modelMemoryManager?.acquireRef('embedding');
    try {
      for (let chunkStart = 0; chunkStart < total; chunkStart += CHUNK_SIZE) {
        if (signal?.aborted) {
          const err = /** @type {Error & { code?: string }} */ (
            new Error('batchGenerateEmbeddings aborted mid-batch')
          );
          err.name = 'AbortError';
          err.code = 'ABORT_ERR';
          throw err;
        }
        const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, total);

        await this._coordinator.withModel(
          'embedding',
          async () => {
            for (let i = chunkStart; i < chunkEnd; i++) {
              if (signal?.aborted) {
                const err = /** @type {Error & { code?: string }} */ (
                  new Error('batchGenerateEmbeddings aborted mid-batch')
                );
                err.name = 'AbortError';
                err.code = 'ABORT_ERR';
                throw err;
              }
              const normalizedText = normalizeEmbeddingInput(
                texts[i],
                'batchGenerateEmbeddings',
                modelName
              );
              try {
                const result = await this._executeEmbeddingInference(normalizedText, {
                  operationId: `${operationId}#${i}`,
                  signal
                });
                results[i] = result.embedding;
              } catch (error) {
                if (signal?.aborted) throw error;
                try {
                  const fallbackResult = await this._tryEmbeddingFallback(normalizedText, error);
                  results[i] = fallbackResult?.embedding ?? null;
                  if (results[i] == null) failedIndexes.push(i);
                } catch (fallbackError) {
                  logger.warn('[LlamaService] Batch embedding failed item', {
                    index: i,
                    error: fallbackError.message
                  });
                  results[i] = null;
                  failedIndexes.push(i);
                }
              }
              completed++;
              if (onProgress) {
                onProgress({
                  current: completed,
                  total,
                  progress: completed / total
                });
              }
            }
          },
          { operationId: `${operationId}-chunk-${chunkStart}`, signal }
        );
      }
      return { embeddings: results, failedIndexes };
    } finally {
      this._modelMemoryManager?.releaseRef('embedding');
    }
  }

  /**
   * Generate text response with streaming support.
   *
   * @param {any} options
   */
  async generateTextStreaming(options) {
    const { prompt, systemPrompt, maxTokens = 2048, temperature = 0.7, signal, onToken } = options;
    const requestedMaxTokens = Number.isFinite(Number(maxTokens))
      ? Math.max(1, Math.floor(Number(maxTokens)))
      : 2048;
    const effectiveContextSize = this._getEffectiveContextSize('text');
    const promptLength =
      String(prompt || '').length + (systemPrompt ? String(systemPrompt).length : 0);
    const safeMaxTokens = clampOutputTokens(requestedMaxTokens, effectiveContextSize, promptLength);
    if (safeMaxTokens !== requestedMaxTokens) {
      logger.warn('[LlamaService] Clamped maxTokens to fit context budget', {
        requestedMaxTokens,
        clampedMaxTokens: safeMaxTokens,
        effectiveContextSize
      });
    }
    const operationId = this._generateOperationId('text-stream');
    await this._awaitModelReady('text');

    return this._coordinator.withModel(
      'text',
      async () => {
        this._modelMemoryManager?.acquireRef('text');
        try {
          return await withLlamaResilience(
            async (retryOptions) => {
              // Handle CPU fallback from LlamaResilience when GPU errors occur
              if (retryOptions?.forceCPU && this._gpuBackend !== 'cpu') {
                await this._reloadModelCPU('text', { operationId });
              }

              const startTime = Date.now();
              /** @type {any} */
              let session;
              /** @type {any} */
              let abortHandler;

              const runOnce = async () => {
                if (signal?.aborted) {
                  const abortError = new Error('Operation aborted');
                  abortError.name = 'AbortError';
                  throw abortError;
                }

                // selfRef: this runOnce executes inside acquireRef('text').
                const context = await this._ensureModelLoaded('text', { selfRef: true });

                // node-llama-cpp reclaims disposed sequence IDs asynchronously
                // (via withLock). After a previous session.dispose(), the slot
                // may not be immediately available. Yield briefly to let any
                // pending reclaim complete before allocating a new sequence.
                if (typeof context.sequencesLeft === 'number' && context.sequencesLeft === 0) {
                  const waitStart = Date.now();
                  for (let _wait = 0; _wait < 50; _wait++) {
                    await delay(10);
                    if (context.sequencesLeft > 0) break;
                  }
                  const waitDuration = Date.now() - waitStart;
                  if (waitDuration > 400) {
                    logger.warn('[LlamaService] Slow sequence allocation detected', {
                      waitDuration,
                      sequencesLeft: context.sequencesLeft,
                      model: this._selectedModels?.text
                    });
                  }
                }

                const { LlamaChatSession } = await loadNodeLlamaModule();
                session = new LlamaChatSession({
                  contextSequence: context.getSequence(),
                  systemPrompt: systemPrompt || 'You are a helpful assistant.',
                  autoDisposeSequence: true
                });

                if (signal) {
                  abortHandler = () => {
                    try {
                      session?.dispose();
                    } catch (disposeError) {
                      logger.warn('[LlamaService] Session dispose on abort failed', {
                        error: disposeError?.message
                      });
                    }
                  };
                  signal.addEventListener('abort', abortHandler, { once: true });
                }

                /** @type {Record<string, any>} */
                const promptOptions = {
                  maxTokens: safeMaxTokens,
                  temperature,
                  onTextChunk: (/** @type {any} */ chunk) => {
                    if (typeof onToken === 'function') {
                      try {
                        onToken(chunk);
                      } catch (e) {
                        logger.warn('[LlamaService] onToken callback failed', { error: e.message });
                      }
                    }
                  }
                };
                if (signal) promptOptions.signal = signal;
                return await session.prompt(prompt, promptOptions);
              };

              try {
                let response;
                try {
                  response = await runOnce();
                } catch (error) {
                  if (isSequenceExhaustedError(error)) {
                    if (session) {
                      try {
                        session.dispose();
                      } catch {
                        /* model is being unloaded; dispose may throw */
                      }
                      session = null;
                    }
                    await this._recoverFromSequenceExhaustion('text', error);
                    response = await runOnce();
                  } else {
                    throw error;
                  }
                }

                const durationMs = Date.now() - startTime;
                const responseChars = response?.length || 0;
                const approxTokens = Math.round(responseChars / 4);
                this._metrics.recordTextGeneration(durationMs, approxTokens, true);

                logger.info('[LlamaService] Text streaming complete', {
                  model: this._selectedModels?.text,
                  promptChars: prompt?.length || 0,
                  responseChars,
                  approxTokens,
                  durationMs,
                  maxTokens: safeMaxTokens,
                  requestedMaxTokens,
                  temperature,
                  gpu: this._gpuBackend !== 'cpu'
                });

                return { response };
              } catch (error) {
                this._metrics.recordTextGeneration(Date.now() - startTime, 0, false);
                if (isOutOfMemoryError(error)) {
                  throw attachErrorCode(error, ERROR_CODES.LLAMA_OOM);
                }
                throw attachErrorCode(error, ERROR_CODES.LLAMA_INFERENCE_FAILED);
              } finally {
                if (signal && abortHandler) {
                  try {
                    signal.removeEventListener('abort', abortHandler);
                  } catch {
                    /* ignore */
                  }
                }
                if (session) {
                  try {
                    session.dispose();
                  } catch (disposeError) {
                    logger.warn('[LlamaService] Session dispose failed', {
                      error: disposeError?.message
                    });
                  }
                }
              }
            },
            { modelType: 'text' }
          );
        } finally {
          this._modelMemoryManager?.releaseRef('text');
        }
      },
      // Forward signal so the coordinator queue entry is immediately cancelled
      // if the caller's AbortController fires (e.g. LLMSuggester timeout).
      // Priority 10: interactive streaming requests jump ahead of background work.
      { operationId, signal, priority: 10 }
    );
  }

  /**
   * Generate text response
   */
  async generateText(/** @type {any} */ options) {
    const { prompt, systemPrompt, maxTokens = 2048, temperature = 0.7, signal } = options;
    const requestedMaxTokens = Number.isFinite(Number(maxTokens))
      ? Math.max(1, Math.floor(Number(maxTokens)))
      : 2048;
    const effectiveContextSize = this._getEffectiveContextSize('text');
    const promptLength =
      String(prompt || '').length + (systemPrompt ? String(systemPrompt).length : 0);
    const safeMaxTokens = clampOutputTokens(requestedMaxTokens, effectiveContextSize, promptLength);
    if (safeMaxTokens !== requestedMaxTokens) {
      logger.warn('[LlamaService] Clamped maxTokens to fit context budget', {
        requestedMaxTokens,
        clampedMaxTokens: safeMaxTokens,
        effectiveContextSize
      });
    }
    const operationId = this._generateOperationId('text');
    await this._awaitModelReady('text');

    return this._coordinator.withModel(
      'text',
      async () => {
        this._modelMemoryManager?.acquireRef('text');
        try {
          return await withLlamaResilience(
            async (retryOptions) => {
              // Handle CPU fallback from LlamaResilience when GPU errors occur
              if (retryOptions?.forceCPU && this._gpuBackend !== 'cpu') {
                await this._reloadModelCPU('text', { operationId });
              }

              const startTime = Date.now();
              /** @type {any} */
              let session;
              /** @type {any} */
              let abortHandler;

              const runOnce = async () => {
                if (signal?.aborted) {
                  const abortError = new Error('Operation aborted');
                  abortError.name = 'AbortError';
                  throw abortError;
                }

                // selfRef: this runOnce executes inside acquireRef('text').
                const context = await this._ensureModelLoaded('text', { selfRef: true });

                // node-llama-cpp reclaims disposed sequence IDs asynchronously
                // (via withLock). After a previous session.dispose(), the slot
                // may not be immediately available. Yield briefly to let any
                // pending reclaim complete before allocating a new sequence.
                if (typeof context.sequencesLeft === 'number' && context.sequencesLeft === 0) {
                  const waitStart = Date.now();
                  for (let _wait = 0; _wait < 50; _wait++) {
                    await delay(10);
                    if (context.sequencesLeft > 0) break;
                  }
                  const waitDuration = Date.now() - waitStart;
                  if (waitDuration > 400) {
                    logger.warn('[LlamaService] Slow sequence allocation detected', {
                      waitDuration,
                      sequencesLeft: context.sequencesLeft,
                      model: this._selectedModels?.text
                    });
                  }
                }

                const { LlamaChatSession } = await loadNodeLlamaModule();
                session = new LlamaChatSession({
                  contextSequence: context.getSequence(),
                  systemPrompt: systemPrompt || 'You are a helpful assistant.',
                  autoDisposeSequence: true
                });

                if (signal) {
                  abortHandler = () => {
                    try {
                      session?.dispose();
                    } catch (disposeError) {
                      logger.warn('[LlamaService] Session dispose on abort failed', {
                        error: disposeError?.message
                      });
                    }
                  };
                  signal.addEventListener('abort', abortHandler, { once: true });
                }

                /** @type {Record<string, any>} */
                const promptOptions = { maxTokens: safeMaxTokens, temperature };
                if (signal) promptOptions.signal = signal;
                return await session.prompt(prompt, promptOptions);
              };

              try {
                let response;
                try {
                  response = await runOnce();
                } catch (error) {
                  if (isSequenceExhaustedError(error)) {
                    // _recoverFromSequenceExhaustion unloads the model (which cascades
                    // to contexts), but the LlamaChatSession wrapper holds internal
                    // state that must be explicitly released.
                    if (session) {
                      try {
                        session.dispose();
                      } catch {
                        /* model is being unloaded; dispose may throw */
                      }
                      session = null;
                    }
                    await this._recoverFromSequenceExhaustion('text', error);
                    response = await runOnce();
                  } else {
                    throw error;
                  }
                }

                const durationMs = Date.now() - startTime;
                const responseChars = response?.length || 0;
                const approxTokens = Math.round(responseChars / 4);
                this._metrics.recordTextGeneration(durationMs, approxTokens, true);

                logger.info('[LlamaService] Text inference complete', {
                  model: this._selectedModels?.text,
                  promptChars: prompt?.length || 0,
                  responseChars,
                  approxTokens,
                  durationMs,
                  maxTokens: safeMaxTokens,
                  requestedMaxTokens,
                  temperature,
                  gpu: this._gpuBackend !== 'cpu'
                });

                return { response };
              } catch (error) {
                this._metrics.recordTextGeneration(Date.now() - startTime, 0, false);
                if (isOutOfMemoryError(error)) {
                  throw attachErrorCode(error, ERROR_CODES.LLAMA_OOM);
                }
                throw attachErrorCode(error, ERROR_CODES.LLAMA_INFERENCE_FAILED);
              } finally {
                if (signal && abortHandler) {
                  try {
                    signal.removeEventListener('abort', abortHandler);
                  } catch {
                    /* ignore */
                  }
                }
                if (session) {
                  try {
                    session.dispose();
                  } catch (disposeError) {
                    logger.warn('[LlamaService] Session dispose failed', {
                      error: disposeError?.message
                    });
                  }
                }
              }
            },
            { modelType: 'text' }
          );
        } finally {
          this._modelMemoryManager?.releaseRef('text');
        }
      },
      // Forward signal so the coordinator queue entry is immediately cancelled
      // if the caller's AbortController fires (e.g. LLMSuggester timeout).
      { operationId, signal }
    );
  }

  /**
   * Analyze text with structured response (convenience wrapper around generateText).
   * Matches the contract expected by ChatService and other callers that pass
   * (prompt, options) and expect {success, response, error}.
   */
  async analyzeText(/** @type {any} */ prompt, /** @type {any} */ options = {}) {
    try {
      const result = await this.generateText({
        prompt,
        systemPrompt:
          options.systemPrompt || 'You are a helpful assistant. Always return valid JSON.',
        maxTokens: options.maxTokens || 2048,
        temperature: options.temperature || 0.7,
        ...(options.format && { format: options.format }),
        ...(options.signal && { signal: options.signal })
      });
      return /** @type {Record<string, any>} */ ({ success: true, response: result.response });
    } catch (error) {
      return /** @type {Record<string, any>} */ ({
        success: false,
        response: null,
        error: error.message || 'Text analysis failed',
        code: error.code || null
      });
    }
  }

  /**
   * Enter vision batch mode — unloads text/embedding models once, keeps vision
   * server alive across multiple analyzeImage() calls. Call exitVisionBatchMode()
   * when the batch is done.
   */
  async enterVisionBatchMode() {
    return this._withVisionBatchModeLock(async () => {
      this._visionBatchModeRefs += 1;
      if (this._visionBatchModeRefs > 1) {
        this._visionBatchMode = true;
        logger.debug('[LlamaService] Joined existing vision batch mode', {
          refs: this._visionBatchModeRefs
        });
        return;
      }

      this._visionBatchMode = true;
      try {
        await this._releaseMemoryForVisionRuntime('batch');
      } catch (error) {
        this._visionBatchModeRefs = Math.max(0, this._visionBatchModeRefs - 1);
        this._visionBatchMode = this._visionBatchModeRefs > 0;
        throw error;
      }

      logger.info('[LlamaService] Entered vision batch mode', {
        refs: this._visionBatchModeRefs
      });
    });
  }

  /**
   * Exit vision batch mode — shuts down vision server, waits for VRAM release,
   * then pre-loads text model for subsequent inference.
   */
  async exitVisionBatchMode() {
    return this._withVisionBatchModeLock(async () => {
      if (this._visionBatchModeRefs <= 0) {
        this._visionBatchMode = false;
        logger.warn('[LlamaService] exitVisionBatchMode called without active batch mode');
        return;
      }

      this._visionBatchModeRefs -= 1;
      if (this._visionBatchModeRefs > 0) {
        this._visionBatchMode = true;
        logger.debug('[LlamaService] Deferred vision batch mode exit; active owners remain', {
          refs: this._visionBatchModeRefs
        });
        return;
      }

      this._visionBatchMode = false;
      try {
        const visionService = getVisionService();
        await visionService.shutdown();
      } catch {
        /* ignore — server may already be gone */
      }
      // Wait for CUDA VRAM release before reloading text model
      await delay(500);
      this._bgWork.track(this._preloadTextAfterVisionRelease(['embedding']));
      logger.info('[LlamaService] Exited vision batch mode');
    });
  }

  /**
   * Best-effort text-model preload after a vision teardown, guarded against a
   * concurrent enterVisionBatchMode(). Fire-and-forget: callers wrap this in
   * _bgWork.track() and never await it; it never rejects.
   *
   * The raw `_ensureModelLoaded('text')` this replaces could load the text
   * model into VRAM that a re-entrant enterVisionBatchMode() intends to keep
   * free for vision — enter sets _visionBatchMode and unloads text without
   * serializing against this load. So: skip if batch mode is already active,
   * and if it flips active while we load, unload the model we just loaded to
   * honor batch mode instead of leaving text resident.
   *
   * @param {string[]} circuitsToReset - LlamaResilience circuits to reset once
   *   the text/embedding path is confirmed healthy.
   * @returns {Promise<void>}
   * @private
   */
  async _preloadTextAfterVisionRelease(circuitsToReset) {
    // Rapid exit -> enter: batch mode was re-entered before we even start.
    if (this._visionBatchMode) return;
    let loaded;
    try {
      loaded = await this._ensureModelLoaded('text');
    } catch (err) {
      logger.warn(
        '[LlamaService] Text model preload after vision release failed:',
        /** @type {any} */ (err)?.message
      );
      return;
    }
    if (!loaded) return;
    // enterVisionBatchMode() may have flipped batch mode true while we loaded;
    // undo our load so text doesn't linger in VRAM the batch wants for vision.
    if (this._visionBatchMode) {
      try {
        await this._modelMemoryManager.unloadModel('text');
      } catch (unloadErr) {
        logger.debug('[LlamaService] Post-preload text unload (batch re-entered) threw', {
          error: /** @type {any} */ (unloadErr)?.message
        });
      }
      return;
    }
    const { resetLlamaCircuit } = require('./LlamaResilience');
    for (const circuit of circuitsToReset) {
      resetLlamaCircuit(circuit);
    }
  }

  /**
   * Analyze image using the vision model.
   * @param {any} options
   */
  async analyzeImage(
    /** @type {any} */ {
      imagePath,
      imageBase64,
      prompt = 'Describe this image.',
      systemPrompt,
      maxTokens = 512,
      temperature = 0.2,
      timeoutMs,
      signal
    } = {}
  ) {
    const imageSource = imageBase64 || imagePath;
    if (!imageSource) {
      return this.generateText({
        prompt,
        systemPrompt: systemPrompt || 'You are a helpful assistant.',
        maxTokens,
        temperature,
        ...(signal && { signal })
      });
    }

    const operationId = this._generateOperationId('vision');
    await this._awaitModelReady('vision');
    return this._coordinator.withModel(
      'vision',
      async () => {
        this._modelMemoryManager?.acquireRef('vision');
        try {
          return await withLlamaResilience(
            async (retryOptions) => {
              // Handle CPU fallback from LlamaResilience when GPU errors occur
              if (retryOptions?.forceCPU && this._gpuBackend !== 'cpu') {
                await this._reloadModelCPU('vision', { operationId });
              }

              const startTime = Date.now();
              try {
                const modelName = this._selectedModels.vision || this._config.visionModel;
                await this._ensureVisionAssets(modelName);
                try {
                  await fs.access(path.join(this._modelsPath, modelName));
                } catch {
                  const missingModelError = /** @type {Error & { code?: string }} */ (
                    new Error(`Vision model not found: ${modelName}`)
                  );
                  missingModelError.code = ERROR_CODES.LLAMA_MODEL_NOT_FOUND;
                  throw missingModelError;
                }
                if (
                  this._visionProjectorStatus.required &&
                  !this._visionProjectorStatus.available
                ) {
                  const missingError = /** @type {Error & { code?: string }} */ (
                    new Error(
                      `Vision model not found: missing projector ${this._visionProjectorStatus.projectorName}`
                    )
                  );
                  missingError.code = ERROR_CODES.LLAMA_MODEL_NOT_FOUND;
                  throw missingError;
                }

                // Free VRAM for vision server (it runs out-of-process, no shared memory)
                // In batch mode, enterVisionBatchMode() already handled this
                if (!this._visionBatchMode && this._modelMemoryManager) {
                  await this._releaseMemoryForVisionRuntime('single');
                }

                const visionService = getVisionService();
                const forceCpuVision = retryOptions?.forceCPU === true;
                const visionServerGpuLayers = await this._resolveGpuLayersForVisionServer(
                  modelName,
                  forceCpuVision
                );
                logger.info('[LlamaService] Using local vision runtime for image analysis', {
                  backend: forceCpuVision ? 'cpu' : this._gpuBackend,
                  timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : null,
                  visionGpuLayers:
                    typeof visionServerGpuLayers === 'number' ? visionServerGpuLayers : 'auto'
                });
                const baseRuntimeProfile = this._buildVisionRuntimeProfile({ maxTokens });
                const buildVisionRequest = (/** @type {any} */ runtimeProfile) => ({
                  imageBase64,
                  imagePath,
                  prompt,
                  systemPrompt:
                    systemPrompt ||
                    'You are a vision assistant that analyzes images based on provided descriptions and OCR text.',
                  maxTokens: runtimeProfile.maxTokens,
                  temperature,
                  timeoutMs,
                  signal,
                  config: {
                    modelPath: path.join(this._modelsPath, modelName),
                    mmprojPath: this._visionProjectorStatus.projectorPath,
                    mmprojRequired: this._visionProjectorStatus.required,
                    contextSize: runtimeProfile.contextSize,
                    threads: this._config.threads,
                    gpuLayers: visionServerGpuLayers,
                    batchSize: runtimeProfile.batchSize,
                    ubatchSize: runtimeProfile.ubatchSize,
                    runtimeBackend: forceCpuVision ? 'cpu' : this._gpuBackend
                  }
                });

                let result;
                try {
                  result = await visionService.analyzeImage(buildVisionRequest(baseRuntimeProfile));
                } catch (visionError) {
                  const shouldRetryDegraded =
                    this._shouldUseConservativeVisionProfile() &&
                    this._isVisionDecodePressureError(visionError);
                  if (!shouldRetryDegraded) {
                    throw visionError;
                  }
                  const degradedProfile = this._buildVisionRuntimeProfile({
                    maxTokens,
                    retryDegraded: true
                  });
                  logger.warn(
                    '[LlamaService] Vision request failed under memory pressure; retrying with reduced runtime profile',
                    {
                      contextSize: degradedProfile.contextSize,
                      batchSize: degradedProfile.batchSize,
                      ubatchSize: degradedProfile.ubatchSize,
                      maxTokens: degradedProfile.maxTokens,
                      error: visionError?.message
                    }
                  );
                  result = await visionService.analyzeImage(buildVisionRequest(degradedProfile));
                }

                const visionDuration = Date.now() - startTime;
                const visionChars = result?.response?.length || 0;
                this._metrics.recordTextGeneration(
                  visionDuration,
                  visionChars ? visionChars / 4 : 0,
                  true
                );

                logger.info('[LlamaService] Vision inference complete', {
                  model: modelName,
                  promptChars: prompt?.length || 0,
                  responseChars: visionChars,
                  durationMs: visionDuration,
                  gpu: this._gpuBackend !== 'cpu',
                  gpuBackend: this._gpuBackend
                });

                // In batch mode, exitVisionBatchMode() handles shutdown + reload
                if (!this._visionBatchMode) {
                  const keepAliveEnabled =
                    typeof visionService.isIdleKeepAliveEnabled === 'function' &&
                    visionService.isIdleKeepAliveEnabled();

                  if (keepAliveEnabled) {
                    // Keep-alive is the explicit signal that "more vision calls
                    // are coming" — schedule the idle shutdown timer and SKIP
                    // the speculative text preload. Previously we kicked off
                    // _ensureModelLoaded('text') here while the vision server
                    // was still resident, which raced into ~4 GB of held VRAM
                    // and surfaced as "Failed to load model" / mis-classified
                    // corruption errors. The natural on-demand load path on
                    // the next text inference handles VRAM pressure correctly,
                    // either after the keep-alive expires or via the safety
                    // net in _ensureModelLoaded.
                    visionService.scheduleIdleShutdown?.('single-image-complete');
                  } else {
                    // Keep-alive disabled: shut down vision now to release
                    // VRAM, wait for CUDA driver release, then preload text
                    // for the next inference (typical metadata-after-image
                    // flow).
                    try {
                      await visionService.shutdown();
                    } catch (shutdownErr) {
                      // shutdown() is idempotent and dedupes via
                      // _shutdownPromise, so the only realistic failure modes
                      // here are: bgWork.drain() rejected, exit listener never
                      // fired within 5s (driver hang), or SIGKILL threw on
                      // Windows EPERM. Don't silently swallow — the next text
                      // preload may race a still-dying vision child for VRAM,
                      // and the warn breadcrumb is the only diagnostic.
                      logger.warn(
                        '[LlamaService] Vision shutdown after single-image inference failed; text preload may race VRAM',
                        { error: shutdownErr?.stack || shutdownErr?.message }
                      );
                    }
                    await delay(500);
                    this._bgWork.track(this._preloadTextAfterVisionRelease(['text', 'embedding']));
                  }
                }

                return { response: result.response };
              } catch (error) {
                this._metrics.recordTextGeneration(Date.now() - startTime, 0, false);
                if (isOutOfMemoryError(error)) {
                  throw attachErrorCode(error, ERROR_CODES.LLAMA_OOM);
                }
                // Preserve existing error codes (e.g., LLAMA_MODEL_NOT_FOUND from _ensureModelLoaded)
                // instead of unconditionally overwriting with INFERENCE_FAILED
                if (!error.code) {
                  throw attachErrorCode(error, ERROR_CODES.LLAMA_INFERENCE_FAILED);
                }
                throw error;
              }
            },
            { modelType: 'vision' }
          );
        } finally {
          this._modelMemoryManager?.releaseRef('vision');
        }
      },
      { operationId }
    );
  }

  async supportsVisionInput() {
    return this._supportsVisionInput();
  }

  /**
   * List available models
   */
  async listModels() {
    await this._ensureConfigLoaded();
    try {
      const files = await fs.readdir(this._modelsPath);
      return await Promise.all(
        files
          .filter((f) => /\.gguf$/i.test(f))
          .map(async (f) => {
            // Support files (mmproj projector) are listed for the management UI
            // but typed 'support' so pickers/category buckets exclude them —
            // they are not loadable standalone models.
            const type = isModelSupportFile(f)
              ? 'support'
              : getModel(f)?.type || categorizeModel(f);
            const fullPath = path.join(this._modelsPath, f);
            // Best-effort on-disk size so the management UI can show real
            // numbers instead of a permanent "Unknown size".
            let sizeBytes = null;
            try {
              const stats = await fs.stat(fullPath);
              sizeBytes = stats.size;
            } catch {
              // Non-fatal — size stays unknown for this entry.
            }
            return { name: f, path: fullPath, type, sizeBytes };
          })
      );
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn('[LlamaService] Failed to list models', {
          error: error.message,
          code: error.code
        });
      }
      return [];
    }
  }

  /**
   * AbortSignal fired at the start of shutdown(). Consumers running long
   * or polling operations (background embed loops, reconnect backoffs,
   * model pre-load warmups) can observe this to cooperatively cancel
   * instead of waiting out their individual timeouts while the app tries
   * to quit. Safe to call before initialize(); returns `undefined` only
   * when the service has been disposed and not yet re-initialized.
   * @returns {AbortSignal|undefined}
   */
  getShutdownSignal() {
    return this._shutdownAbort?.signal;
  }

  /**
   * Circuit breaker states for health reporting. LlamaResilience is required
   * lazily so a test that mocks it without this export still gets a shape.
   * @returns {{ states: Record<string, string>, open: string[] }}
   */
  _getCircuitSummary() {
    try {
      const { getLlamaCircuitSummary } = require('./LlamaResilience');
      const summary = getLlamaCircuitSummary();
      return summary && Array.isArray(summary.open) ? summary : { states: {}, open: [] };
    } catch {
      return { states: {}, open: [] };
    }
  }

  /**
   * Get service status.
   *
   * `healthy` means initialized with no model type paused by its circuit
   * breaker. A GPU-to-CPU fallback is reported in `usingCPUFallback` and
   * `degraded` rather than as unhealthy: inference still works, slower.
   */
  getHealthStatus() {
    const circuits = this._getCircuitSummary();
    // Derived from what is loaded, not from DegradationManager's bit: that
    // one is set on the first VRAM-pattern error before any retry and never
    // cleared, so a load that then succeeded on the GPU read as "CPU
    // fallback" for the rest of the process. The record is written only by
    // _loadModel, and a model can leave without a reload (config swap, vision
    // spawn, eviction, shutdown), so the memory manager's residency list —
    // the same one `memory.loadedModels` reports below — decides whether a
    // record still counts; without a manager there is nothing to check it
    // against and the record stands.
    const memory = this._modelMemoryManager?.getMemoryStatus();
    const resident = Array.isArray(memory?.loadedModels) ? memory.loadedModels : null;
    const cpuFallbackTypes = [...this._cpuFallbackTypes].filter(
      (type) => !resident || resident.includes(type)
    );
    const usingCPUFallback = this._engineCpuFallback || cpuFallbackTypes.length > 0;
    return {
      healthy: this._initialized && circuits.open.length === 0,
      initialized: this._initialized,
      degraded: circuits.open.length > 0 || usingCPUFallback,
      openCircuits: circuits.open,
      circuitBreakers: circuits.states,
      usingCPUFallback,
      cpuFallbackTypes,
      gpuBackend: this._gpuBackend,
      gpuDetected: this._detectedGpu,
      gpuSelection: this._gpuSelection,
      metrics: this._metrics.getMetrics(),
      memory
    };
  }

  async shutdown() {
    // Re-entrance guard: prevent double shutdown from StartupManager + ServiceContainer
    if (this._isShuttingDown) {
      logger.debug('[LlamaService] Shutdown already in progress, skipping');
      return;
    }
    this._isShuttingDown = true;
    logger.info('[LlamaService] Shutting down...');

    // Fire the cooperative cancellation signal before we start draining.
    // Consumers that registered abort listeners (background embed loops,
    // polling waits, etc.) short-circuit their work instead of soaking up
    // the remaining wall-clock budget of each individual await.
    try {
      this._shutdownAbort?.abort();
    } catch (error) {
      logger.warn('[LlamaService] Shutdown abort signal failed to fire', {
        error: error?.message
      });
    }

    try {
      // Drain tracked background work (model preloads, etc.)
      await this._bgWork.drain();

      const gateWasNotSet = !this._configChangeGate;
      let configGateTimedOut = false;
      if (this._configChangeGate) {
        try {
          await Promise.race([
            this._configChangeGate.promise,
            delay(5000)
              .then(
                /** @returns {any} */ () => {
                  configGateTimedOut = true;
                  return undefined;
                }
              )
              .catch((/** @type {any} */ err) => {
                logger.debug('[LlamaService] Config-change gate delay failed:', err?.message);
              })
          ]);
          if (configGateTimedOut) {
            logger.warn('[LlamaService] Config-change gate wait timed out during shutdown');
          }
        } catch (error) {
          logger.warn(
            '[LlamaService] Config-change gate wait failed during shutdown:',
            error?.message
          );
        }
      }
      if (gateWasNotSet) {
        this._beginConfigChangeGate();
      }

      if (this._modelReloadGates?.size) {
        for (const [modelType, gate] of this._modelReloadGates.entries()) {
          try {
            await Promise.race([gate.promise, delay(5000)]);
          } catch (error) {
            logger.warn('[LlamaService] Model reload gate wait failed during shutdown', {
              modelType,
              error: error?.message
            });
          }
        }
      }

      let safeToUnload = true;
      try {
        if (this._coordinator) {
          safeToUnload = await this._waitForIdleOperations('shutdown', TIMEOUTS.SERVICE_STARTUP);
        }
      } catch (error) {
        safeToUnload = false;
        logger.warn(
          '[LlamaService] Error waiting for idle operations during shutdown:',
          error?.message
        );
      }

      // Unload models with error isolation
      if (this._modelMemoryManager) {
        try {
          if (safeToUnload) {
            await this._modelMemoryManager.unloadAll();
          } else {
            logger.warn(
              '[LlamaService] Skipping model unload due to active operations during shutdown'
            );
          }
        } catch (error) {
          logger.warn('[LlamaService] Error unloading models during shutdown:', error?.message);
        }
      }

      // Dispose llama instance with error isolation
      if (this._llama) {
        try {
          if (safeToUnload) {
            await this._llama.dispose?.();
          } else {
            logger.warn('[LlamaService] Skipping llama dispose due to active operations');
          }
        } catch (error) {
          logger.warn('[LlamaService] Error disposing llama during shutdown:', error?.message);
        }
      }

      // Clean up circuit breaker timers
      cleanupLlamaCircuits();

      // Clean up all references to prevent stale state
      this._initialized = false;
      this._initPromise = null;
      this._configLoaded = false;
      this._modelsPath = null; // Reset so re-initialization discovers fresh path
      this._llama = null;
      this._models = { text: null, vision: null, embedding: null };
      this._contexts = { text: null, vision: null, embedding: null };
      this._modelChangeCallbacks.clear();
      if (this._modelReloadGates?.size) {
        // Force-resolve any leftover reload gates so future operations cannot
        // block on stale promises after re-initialization.
        for (const gate of this._modelReloadGates.values()) {
          try {
            gate?.resolve?.();
          } catch {
            /* ignore */
          }
        }
        this._modelReloadGates.clear();
      }
      // Note: _coordinator is intentionally NOT nulled — it has no resources to leak,
      // and fire-and-forget operations may still reference it after shutdown.
      this._degradationManager = null;
      // Refresh the abort controller so a subsequent re-initialize starts
      // from a non-aborted signal. Consumers caching the old signal during
      // shutdown remain aborted (correct — their caller won), but anything
      // created after this point gets the new one.
      this._shutdownAbort = new AbortController();

      if (this._configChangeGate && (gateWasNotSet || configGateTimedOut)) {
        this._endConfigChangeGate();
      }
    } finally {
      // Always clear the re-entrance latch so re-initialization can call
      // shutdown again. This MUST live in finally: an unexpected throw
      // earlier in the body (e.g. background-work drain) would otherwise
      // leave the latch stuck true and turn every later shutdown into a
      // silent no-op.
      this._isShuttingDown = false;
      // Always clear PerformanceMetrics interval (avoids leak if shutdown throws mid-body)
      if (this._metrics?.destroy) {
        try {
          this._metrics.destroy();
        } catch {
          /* ignore */
        }
      }
    }
  }
}

// Singleton export
const { getInstance, createInstance, registerWithContainer, resetInstance } =
  createSingletonHelpers({
    ServiceClass: LlamaService,
    serviceId: 'LLAMA_SERVICE',
    serviceName: 'LlamaService',
    getContainer: () => require('./ServiceContainer'),
    shutdownMethod: 'shutdown'
  });

module.exports = {
  LlamaService,
  getInstance,
  createInstance,
  registerWithContainer,
  resetInstance
};
