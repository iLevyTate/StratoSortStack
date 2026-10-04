// @ts-check
/**
 * ModelMemoryManager — VRAM/RAM-aware load/dispose policy for LLM models.
 *
 * Decides which models can be co-resident given the detected GPU info
 * (VRAM budget) and OS RAM, and drives `LlamaService._loadModel` /
 * `_models[type].dispose()` through bound callbacks rather than holding
 * the full service reference. The bound-callback shape makes the
 * coupling explicit and easy to audit for unexpected access into
 * LlamaService internals.
 */
const os = require('os');
const { createLogger } = require('../../shared/logger');
const { delay } = require('../../shared/promiseUtils');

const logger = createLogger('ModelMemoryManager');

/**
 * Headroom kept for macOS and the rest of the app when RAM and GPU memory are
 * one pool (Apple Silicon). The GPU budget may not reach past total RAM minus
 * this reserve. 4 GiB is enough for the OS, Electron and the renderer.
 */
const UNIFIED_MEMORY_SYSTEM_RESERVE_BYTES = 4 * 1024 * 1024 * 1024;

/** Min free bytes under `_maxMemoryUsage` before optional LLM calls on an already-loaded model. */
const OPTIONAL_INFERENCE_HEADROOM_BYTES = 384 * 1024 * 1024;

class ModelMemoryManager {
  /**
   * @param {any} llamaService - LlamaService instance that provides model loading/unloading.
   * @param {{ gpuInfo?: any }} [options] - Configuration options
   */
  constructor(llamaService, options = {}) {
    // Bind specific callbacks rather than holding the entire service reference.
    // This makes the contract between ModelMemoryManager and LlamaService explicit.
    this._loadModelFn = (/** @type {any} */ type, /** @type {any} */ options) =>
      llamaService._loadModel(type, options);
    this._disposeModelFn = async (/** @type {any} */ type) => {
      if (llamaService._models?.[type]) {
        await llamaService._models[type].dispose();
        llamaService._models[type] = null;
        llamaService._contexts[type] = null;
      }
    };
    this._loadedModels = new Map(); // type -> { model, context, lastUsed, sizeBytes }
    this._activeRefs = new Map(); // type -> number of in-flight operations using this model
    this._gpuInfo = options.gpuInfo || null;
    this._maxMemoryUsage = this._calculateMaxMemory();
    this._currentMemoryUsage = 0;

    // Default model size estimates (in bytes) used when actual file size is unknown.
    // These are conservative upper-bound estimates including KV cache and runtime overhead.
    // Actual file sizes are used when available via updateModelSizeEstimate().
    /** @type {Record<string, number>} */
    this._modelSizeEstimates = {
      embedding: 200 * 1024 * 1024, // ~200MB (nomic-embed ~140MB + KV/runtime overhead)
      text: 4 * 1024 * 1024 * 1024, // ~4GB
      vision: 5 * 1024 * 1024 * 1024 // ~5GB
    };
  }

  /**
   * Update model size estimate from actual file size.
   * Should be called after model files are resolved to improve memory budget accuracy.
   * Adds ~30% overhead for KV cache and runtime buffers.
   * @param {string} modelType - 'text' | 'vision' | 'embedding'
   * @param {number} fileSizeBytes - Actual model file size in bytes
   */
  updateModelSizeEstimate(modelType, fileSizeBytes) {
    if (!fileSizeBytes || !Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) return;
    // Add ~30% overhead for KV cache, context buffers, and runtime allocations
    const estimatedUsage = Math.ceil(fileSizeBytes * 1.3);
    const oldEstimate = this._modelSizeEstimates[modelType];
    this._modelSizeEstimates[modelType] = estimatedUsage;
    logger.debug('[Memory] Updated model size estimate from file', {
      modelType,
      fileSizeMB: Math.round(fileSizeBytes / 1024 / 1024),
      estimatedUsageMB: Math.round(estimatedUsage / 1024 / 1024),
      oldEstimateMB: oldEstimate ? Math.round(oldEstimate / 1024 / 1024) : 'none'
    });
  }

  /**
   * Update GPU info after construction (e.g., after async GPU detection completes).
   * Recalculates memory budget with new VRAM data.
   * @param {any} gpuInfo - GPU info from GPUMonitor
   */
  setGpuInfo(gpuInfo) {
    this._gpuInfo = gpuInfo;
    this._maxMemoryUsage = this._calculateMaxMemory();
    logger.info('[Memory] GPU info updated, recalculated budget', {
      vramMB: gpuInfo?.vramMB || 0,
      maxUsableGB: Math.round(this._maxMemoryUsage / 1024 / 1024 / 1024)
    });
  }

  /**
   * Calculate maximum memory we can use.
   *
   * Budget = max(ramBudget, vramBudget) where
   *   ramBudget  = min(70% of free system RAM, 16 GiB)
   *   vramBudget = 80% of reported VRAM (0 when no GPU info)
   *
   * On discrete GPUs (e.g. NVIDIA), models are GPU-offloaded into VRAM which is
   * separate from system RAM. Using Math.min would yield 0 when free RAM is low
   * even though VRAM is plentiful. Math.max ensures the real constraint is used.
   *
   * On unified memory (Apple Silicon) GPUMonitor reports "VRAM" as 75% of total
   * RAM, which is what Metal may address, not what is free. RAM and VRAM are one
   * pool there, so the VRAM share is additionally capped at total RAM minus
   * UNIFIED_MEMORY_SYSTEM_RESERVE_BYTES; without the cap an 8 GB machine was
   * budgeted at 4.8 GB for models alone.
   */
  _calculateMaxMemory() {
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();

    // System RAM budget: 70% of free, capped at 16GB
    const ramBudget = Math.min(freeMemory * 0.7, 16 * 1024 * 1024 * 1024);

    let maxUsable = ramBudget;

    // When GPU info is available, use the larger of RAM and VRAM budgets.
    // On discrete GPUs, models are loaded into VRAM via GPU offload, so system
    // RAM free-mem should not constrain the budget.
    if (this._gpuInfo?.vramMB && this._gpuInfo.vramMB > 0) {
      const vramBytes = this._gpuInfo.vramMB * 1024 * 1024;
      let vramBudget = Math.floor(vramBytes * 0.8); // 80% of VRAM
      const unifiedMemory = Boolean(this._gpuInfo.isAppleSilicon || this._gpuInfo.unifiedMemory);
      if (unifiedMemory) {
        const unifiedCap = Math.max(0, totalMemory - UNIFIED_MEMORY_SYSTEM_RESERVE_BYTES);
        vramBudget = Math.min(vramBudget, unifiedCap);
      }
      maxUsable = Math.max(ramBudget, vramBudget);

      logger.info('[Memory] VRAM-aware budget calculated', {
        vramMB: this._gpuInfo.vramMB,
        unifiedMemory,
        vramBudgetGB: Math.round(vramBudget / 1024 / 1024 / 1024),
        ramBudgetGB: Math.round(ramBudget / 1024 / 1024 / 1024),
        effectiveBudgetGB: Math.round(maxUsable / 1024 / 1024 / 1024)
      });
    } else {
      logger.info('[Memory] Calculated max memory usage (no GPU VRAM info)', {
        totalGB: Math.round(totalMemory / 1024 / 1024 / 1024),
        freeGB: Math.round(freeMemory / 1024 / 1024 / 1024),
        maxUsableGB: Math.round(maxUsable / 1024 / 1024 / 1024)
      });
    }

    return maxUsable;
  }

  /**
   * Refresh the memory budget based on current free memory.
   * Called before load decisions to avoid using a stale snapshot from constructor time.
   */
  _refreshMemoryBudget() {
    this._maxMemoryUsage = this._calculateMaxMemory();
  }

  /**
   * Mark a model as actively in-use (prevents eviction while held).
   * Callers MUST call releaseRef when done.
   * @param {string} modelType
   */
  acquireRef(modelType) {
    this._activeRefs.set(modelType, (this._activeRefs.get(modelType) || 0) + 1);
  }

  /**
   * Release an active reference on a model type.
   * @param {string} modelType
   */
  releaseRef(modelType) {
    const current = this._activeRefs.get(modelType) || 0;
    if (current <= 1) {
      this._activeRefs.delete(modelType);
    } else {
      this._activeRefs.set(modelType, current - 1);
    }
  }

  /**
   * Get the context for an already-loaded model without acquiring any locks.
   * Returns null if the model is not currently loaded.
   * This enables a fast-path in LlamaService._ensureModelLoaded() that avoids
   * re-acquiring the load lock when the model is already resident.
   * @param {string} modelType
   * @returns {Object|null} The model context, or null if not loaded
   */
  getLoadedContext(modelType) {
    const entry = this._loadedModels.get(modelType);
    // A disposing entry's context is being torn down by the native side —
    // handing it out would let inference run on a freed context. Report
    // not-loaded so the caller takes the locked ensureModelLoaded path.
    if (entry && !entry.disposing) {
      entry.lastUsed = Date.now();
      return entry.context;
    }
    return null;
  }

  /**
   * Check if we can load a model of given type
   */
  canLoadModel(/** @type {any} */ modelType) {
    const estimatedSize = this._modelSizeEstimates[modelType] || 0;
    const projectedUsage = this._currentMemoryUsage + estimatedSize;
    return projectedUsage < this._maxMemoryUsage;
  }

  /**
   * Whether a consumer that loads outside this manager (the vision
   * llama-server child, registered afterwards as an external consumer) fits
   * the budget next to what is resident now. Mirrors ensureModelLoaded's
   * rule: with nothing resident a single oversized estimate is allowed
   * through (the runtime may still manage with mmap or GPU offload); with
   * residents pinned by in-flight work the answer is honest. `excludeType`
   * leaves out a registration the caller is about to replace, so a resident
   * vision runtime is not counted twice.
   *
   * @param {number} sizeBytes
   * @param {{ excludeType?: string }} [options]
   * @returns {boolean}
   */
  canFitExternalLoad(sizeBytes, { excludeType } = {}) {
    this._refreshMemoryBudget();
    const excluded = excludeType ? this._loadedModels.get(excludeType) : null;
    const residentCount = this._loadedModels.size - (excluded ? 1 : 0);
    if (residentCount <= 0) return true;
    const usage = this._currentMemoryUsage - (excluded ? excluded.sizeBytes || 0 : 0);
    return usage + Math.max(0, Number(sizeBytes) || 0) < this._maxMemoryUsage;
  }

  /**
   * Make room for an external load the way ensureModelLoaded makes room for
   * a model: evict idle (unpinned) residents, least recently used first,
   * until the load fits. Residents pinned by in-flight work are left alone,
   * so a false answer means the budget is genuinely taken.
   *
   * canFitExternalLoad alone judged the resident set as it stood, so a
   * 190 MB whisper model that had finished its transcription an hour ago
   * blocked the vision runtime on every 8 GB machine.
   * @param {number} sizeBytes
   * @param {{ excludeType?: string }} [options]
   * @returns {Promise<boolean>}
   */
  async makeRoomForExternalLoad(sizeBytes, { excludeType } = {}) {
    while (!this.canFitExternalLoad(sizeBytes, { excludeType })) {
      const evictable = [...this._loadedModels.entries()]
        .filter(([type]) => type !== excludeType && (this._activeRefs.get(type) || 0) === 0)
        .sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0));
      if (evictable.length === 0) return false;
      const [type] = evictable[0];
      logger.info('[Memory] Evicting idle model to make room for an external load', {
        type,
        requestedMB: Math.round((Number(sizeBytes) || 0) / 1024 / 1024)
      });
      const unloaded = await this.unloadModel(type);
      if (!unloaded) return false;
    }
    return true;
  }

  /**
   * Whether optional background work may use a model without forcing a load.
   * Returns true when the model is already resident, or when a fresh load fits
   * within the current budget. Unlike ensureModelLoaded(), this never proceeds
   * when the budget is exceeded — callers use it to skip non-critical inference
   * (e.g. graph cluster label refinement) instead of risking native OOM.
   *
   * @param {string} modelType
   * @returns {boolean}
   */
  canRunOptionalLoad(modelType) {
    this._refreshMemoryBudget();
    if (this._loadedModels.has(modelType)) {
      const remaining = Math.max(0, this._maxMemoryUsage - this._currentMemoryUsage);
      return remaining >= OPTIONAL_INFERENCE_HEADROOM_BYTES;
    }
    return this.canLoadModel(modelType);
  }

  /**
   * Ensure model is loaded, unloading others if necessary
   */
  async ensureModelLoaded(/** @type {any} */ modelType, options = {}) {
    // Already loaded? If a dispose is mid-flight for this type, wait for it
    // to settle first: returning the context now would hand the caller a
    // context whose native teardown is in progress (use-after-dispose). If
    // the dispose fails, the entry stays tracked and is safe to return.
    {
      let entry = this._loadedModels.get(modelType);
      if (entry?.disposing) {
        await entry.disposePromise;
        entry = this._loadedModels.get(modelType);
      }
      if (entry) {
        entry.lastUsed = Date.now();
        return entry.context;
      }
    }

    // Refresh budget from current system state before making load decisions
    this._refreshMemoryBudget();

    // Check if we need to free memory -- evict LRU models until budget allows.
    // Break if _unloadLeastRecentlyUsed could not evict (all models in active use).
    const estimatedSize = this._modelSizeEstimates[modelType] || 0;
    while (!this.canLoadModel(modelType) && this._loadedModels.size > 0) {
      const sizeBefore = this._loadedModels.size;
      await this._unloadLeastRecentlyUsed();
      if (this._loadedModels.size === sizeBefore) {
        // Nothing was evicted (all models have active refs) -- stop to avoid infinite loop
        logger.warn('[Memory] Cannot free enough memory -- all models in active use', {
          requestedType: modelType,
          loadedModels: Array.from(this._loadedModels.keys())
        });
        break;
      }
    }

    // Budget still exceeded after evicting everything evictable — the
    // remaining residents are pinned by in-flight inference. Wait briefly
    // for those refs to drain and retry eviction so concurrent bursts
    // (vision + whisper + batch analysis) queue instead of stacking loads.
    if (!this.canLoadModel(modelType) && this._loadedModels.size > 0) {
      const MAX_WAIT_ROUNDS = 5;
      const WAIT_MS = 2000;
      for (let round = 0; round < MAX_WAIT_ROUNDS && !this.canLoadModel(modelType); round += 1) {
        await delay(WAIT_MS);
        this._refreshMemoryBudget();
        while (!this.canLoadModel(modelType) && this._loadedModels.size > 0) {
          const sizeBefore = this._loadedModels.size;
          await this._unloadLeastRecentlyUsed();
          if (this._loadedModels.size === sizeBefore) break;
        }
      }
    }

    if (!this.canLoadModel(modelType)) {
      if (this._loadedModels.size > 0) {
        // Fail closed under concurrent pressure: stacking another multi-GB
        // model on top of pinned residents risks a native OOM that takes the
        // whole process down. Callers already handle load rejections.
        const budgetError = /** @type {Error & { code?: string }} */ (
          new Error(
            `Cannot load ${modelType} model: memory budget exceeded and resident models are in active use`
          )
        );
        budgetError.code = 'MODEL_MEMORY_BUDGET_EXCEEDED';
        logger.error('[Memory] Budget exceeded with pinned residents — refusing load', {
          requestedType: modelType,
          estimatedSizeMB: Math.round(estimatedSize / 1024 / 1024),
          maxUsableMB: Math.round(this._maxMemoryUsage / 1024 / 1024),
          currentUsageMB: Math.round(this._currentMemoryUsage / 1024 / 1024),
          loadedModels: Array.from(this._loadedModels.keys())
        });
        throw budgetError;
      }
      // Nothing else is resident: the single model's conservative estimate
      // exceeds the budget on its own. Proceed — the runtime can still
      // succeed (GPU offload, mmap), and failing here would permanently
      // brick the feature on low-RAM machines.
      logger.warn('[Memory] Budget exceeded by single model estimate, attempting load anyway', {
        requestedType: modelType,
        estimatedSizeMB: Math.round(estimatedSize / 1024 / 1024),
        maxUsableMB: Math.round(this._maxMemoryUsage / 1024 / 1024),
        currentUsageMB: Math.round(this._currentMemoryUsage / 1024 / 1024)
      });
    }

    // Load the model via the bound callback
    const context = await this._loadModelFn(modelType, options);

    // The load callback may have refined the estimate from the real file
    // size (updateModelSizeEstimate); record what this model actually
    // costs so later budget decisions are not held to the fixed guess.
    const recordedSize = this._modelSizeEstimates[modelType] || estimatedSize;
    this._loadedModels.set(modelType, {
      context,
      lastUsed: Date.now(),
      sizeBytes: recordedSize
    });
    this._currentMemoryUsage += recordedSize;

    logger.info('[Memory] Model loaded', {
      type: modelType,
      currentUsageMB: Math.round(this._currentMemoryUsage / 1024 / 1024)
    });

    return context;
  }

  /**
   * Unload least recently used model, skipping models with active references.
   */
  async _unloadLeastRecentlyUsed() {
    let oldest = null;
    let oldestTime = Infinity;

    for (const [type, entry] of this._loadedModels) {
      // Never evict a model that is currently in-use for inference
      if ((this._activeRefs.get(type) || 0) > 0) continue;

      if (entry.lastUsed < oldestTime) {
        oldest = type;
        oldestTime = entry.lastUsed;
      }
    }

    if (oldest) {
      await this.unloadModel(oldest);
    } else {
      logger.warn('[Memory] Cannot evict any model -- all loaded models are in active use');
    }
  }

  /**
   * Unload a specific model
   */
  async _unloadModel(/** @type {any} */ modelType) {
    const entry = this._loadedModels.get(modelType);
    if (!entry) return true;
    // Concurrent unloads of the same entry join the in-flight dispose
    // instead of racing it (the old code deleted the map entry up-front for
    // this, but that desynced tracking from reality whenever dispose failed:
    // the manager believed the memory was freed while the native context
    // still held it, and subsequent "within budget" loads could native-OOM
    // the process).
    if (entry.disposing) return entry.disposePromise;
    entry.disposing = true;
    entry.disposePromise = (async () => {
      logger.info('[Memory] Unloading model', { type: modelType });

      try {
        // External consumers (WhisperService, future MCP servers, etc.) provide
        // their own dispose callback at registration time so the manager can
        // evict them under memory pressure without depending on LlamaService's
        // model registry. Fall back to the LlamaService dispose hook for the
        // built-in text/vision/embedding types.
        if (typeof entry.dispose === 'function') {
          await entry.dispose();
        } else {
          await this._disposeModelFn(modelType);
        }
        // Drop tracking only after the dispose actually succeeded.
        if (this._loadedModels.get(modelType) === entry) {
          this._loadedModels.delete(modelType);
          this._currentMemoryUsage = Math.max(0, this._currentMemoryUsage - entry.sizeBytes);
        }
        return true;
      } catch (error) {
        // Keep the entry tracked: the memory is (most likely) still held by
        // the native side. The eviction loop's no-progress check prevents
        // retry spinning.
        entry.disposing = false;
        entry.disposePromise = null;
        logger.error('[Memory] Error unloading model — keeping entry tracked', {
          type: modelType,
          error: error?.message || String(error)
        });
        return false;
      }
    })();
    return entry.disposePromise;
  }

  /**
   * Register an external memory consumer (e.g. WhisperService) so its VRAM
   * usage is visible to load decisions and the manager can evict it under
   * pressure. The consumer supplies its own dispose callback because its
   * lifecycle is not tied to LlamaService's `_models` registry.
   *
   * @param {Object} options
   * @param {string} options.type - Unique identifier (e.g. 'audio').
   *   Must not collide with the built-in 'text' / 'vision' / 'embedding'
   *   types — those are owned by LlamaService.
   * @param {number} options.sizeBytes - Estimated memory footprint
   *   (model file + KV cache + runtime overhead). Used for budget math
   *   and surfaced in `getMemoryStatus()`.
   * @param {Function} options.dispose - Async (or sync) callback the
   *   manager invokes when evicting this consumer. Should release the
   *   underlying resources but does NOT need to call
   *   `unregisterExternalConsumer` itself — the manager already removed
   *   the entry before invoking dispose.
   * @param {string} [options.label] - Optional human-readable label for
   *   logs. Defaults to `type`.
   * @returns {boolean} True if registered; false if a registration with
   *   the same `type` already exists (idempotent — caller can ignore).
   */
  /** @param {{ type: string, sizeBytes: number, dispose: (...args: any[]) => any, label?: string }} args */
  registerExternalConsumer({ type, sizeBytes, dispose, label }) {
    if (typeof type !== 'string' || !type.trim()) {
      throw new TypeError('[Memory] registerExternalConsumer requires a non-empty type');
    }
    if (['text', 'vision', 'embedding'].includes(type)) {
      throw new Error(
        `[Memory] '${type}' is reserved for LlamaService; choose a distinct type for external consumers`
      );
    }
    if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
      throw new TypeError('[Memory] registerExternalConsumer requires a non-negative sizeBytes');
    }
    if (typeof dispose !== 'function') {
      throw new TypeError('[Memory] registerExternalConsumer requires a dispose function');
    }
    const existing = this._loadedModels.get(type);
    if (existing && !existing.disposing) {
      logger.debug('[Memory] External consumer already registered, ignoring duplicate', {
        type,
        existingSizeMB: Math.round((existing.sizeBytes || 0) / 1024 / 1024)
      });
      return false;
    }
    if (existing?.disposing) {
      // The slot is occupied by an entry whose dispose is mid-flight (we
      // evicted the consumer and it has already reloaded + re-registered).
      // Rejecting as a duplicate would let the dispose completion delete
      // the slot, leaving the consumer loaded but invisible to budget math.
      // Detach the old entry's bookkeeping now; the dispose completion's
      // `get(type) === entry` guard makes its own delete a no-op.
      this._loadedModels.delete(type);
      this._currentMemoryUsage = Math.max(0, this._currentMemoryUsage - (existing.sizeBytes || 0));
      logger.info('[Memory] External consumer re-registered over in-flight dispose', { type });
    }

    this._loadedModels.set(type, {
      context: null,
      lastUsed: Date.now(),
      sizeBytes,
      dispose,
      external: true,
      label: label || type
    });
    this._currentMemoryUsage += sizeBytes;
    // Surface in size-estimate map too so future canLoadModel(otherType)
    // calls factor this consumer in even if the entry was evicted and
    // the consumer re-registers later.
    /** @type {Record<string, any>} */ (this._modelSizeEstimates)[type] = sizeBytes;

    logger.info('[Memory] External consumer registered', {
      type,
      label: label || type,
      sizeMB: Math.round(sizeBytes / 1024 / 1024),
      currentUsageMB: Math.round(this._currentMemoryUsage / 1024 / 1024)
    });
    return true;
  }

  /**
   * Unregister an external consumer. Called by the consumer when it
   * shuts down voluntarily (NOT when the manager evicted it — eviction
   * already removed the entry before calling dispose, so calling this
   * from inside a dispose callback is a no-op).
   *
   * @param {string} type
   * @returns {boolean} True if an entry was removed.
   */
  unregisterExternalConsumer(type) {
    const entry = this._loadedModels.get(type);
    if (!entry || !entry.external) return false;
    this._loadedModels.delete(type);
    this._currentMemoryUsage = Math.max(0, this._currentMemoryUsage - entry.sizeBytes);
    logger.info('[Memory] External consumer unregistered', {
      type,
      currentUsageMB: Math.round(this._currentMemoryUsage / 1024 / 1024)
    });
    return true;
  }

  /**
   * Get current memory status
   */
  getMemoryStatus() {
    return {
      maxMemoryMB: Math.round(this._maxMemoryUsage / 1024 / 1024),
      currentUsageMB: Math.round(this._currentMemoryUsage / 1024 / 1024),
      loadedModels: Array.from(this._loadedModels.keys()),
      systemFreeMemoryMB: Math.round(os.freemem() / 1024 / 1024)
    };
  }

  /**
   * Unload all models
   */
  async unloadAll() {
    // Snapshot keys to avoid mutating Map during iteration
    const types = [...this._loadedModels.keys()];
    for (const type of types) {
      const unloaded = await this.unloadModel(type); // Use public method with ref drain
      if (!unloaded) {
        logger.warn('[Memory] Skipped unloadAll entry due to active refs', { type });
      }
    }
  }

  /**
   * Unload a specific model (public helper).
   * Waits for active references to drain before unloading (max 5s).
   *
   * @param {string} modelType
   * @param {{ allowedRefs?: number }} [options]
   */
  async unloadModel(modelType, { allowedRefs = 0 } = {}) {
    const refs = this._activeRefs.get(modelType) || 0;
    if (refs > allowedRefs) {
      logger.info('[Memory] Waiting for active refs before unload', {
        type: modelType,
        refs,
        allowedRefs
      });
      const deadline = Date.now() + 5000;
      while ((this._activeRefs.get(modelType) || 0) > allowedRefs && Date.now() < deadline) {
        await delay(100);
      }
      if ((this._activeRefs.get(modelType) || 0) > allowedRefs) {
        logger.warn('[Memory] Unload timeout — keeping model loaded due to active refs', {
          type: modelType,
          remainingRefs: this._activeRefs.get(modelType)
        });
        return false;
      }
    }
    return this._unloadModel(modelType);
  }
}

module.exports = { ModelMemoryManager, UNIFIED_MEMORY_SYSTEM_RESERVE_BYTES };
