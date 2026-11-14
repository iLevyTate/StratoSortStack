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
const { peekAvailableMemoryBytes } = require('../utils/systemMemory');

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
    // Loads in progress: memory that is being taken but is not resident yet
    // (see reserveLoad).
    /** @type {Map<string, { sizeBytes: number, settled: Promise<void>, settle: () => void }>} */
    this._pendingLoads = new Map();
    // A pinned text or vision model can stay busy for a whole inference.
    // Queue the next load behind it instead of refusing after a few seconds
    // and turning the file into a stored fallback.
    this._pinnedResidentWaitMs = 3 * 60 * 1000;
    this._pinnedResidentPollMs = 2000;

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
    // A load of this model that is in progress reserved the old guess. The
    // first text load of a session held 4 GiB for a 5.8 GiB model, so an
    // embedding model asked for meanwhile was told both fit on the GPU.
    const pending = this._pendingLoads.get(modelType);
    if (pending) pending.sizeBytes = estimatedUsage;
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
   *   ramBudget  = min(70% of available system RAM, 16 GiB)
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
   *
   * "Available" comes from systemMemory: os.freemem() on Windows and Linux,
   * where it already counts reclaimable caches, and the kernel's available
   * figure on macOS, where os.freemem() counts only free pages and a busy Mac
   * shows a few hundred MB.
   */
  _calculateMaxMemory() {
    const totalMemory = os.totalmem();
    const availableMemory = peekAvailableMemoryBytes();

    // System RAM budget: 70% of available, capped at 16GB
    const ramBudget = Math.min(availableMemory * 0.7, 16 * 1024 * 1024 * 1024);

    let maxUsable = ramBudget;

    // When GPU info is available, use the larger of RAM and VRAM budgets.
    // On discrete GPUs, models are loaded into VRAM via GPU offload, so system
    // RAM availability should not constrain the budget.
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
        availableGB: Math.round(availableMemory / 1024 / 1024 / 1024),
        maxUsableGB: Math.round(maxUsable / 1024 / 1024 / 1024)
      });
    }

    return maxUsable;
  }

  /**
   * Refresh the memory budget based on current available memory.
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
   * Whether a model holds memory or is about to: it is in memory, or a load
   * of it is in progress. A caller that asked only getLoadedContext saw
   * nothing for the seconds a load takes, while the budget already counted
   * it. Asking does not count as using the model.
   * @param {string} modelType
   * @returns {boolean}
   */
  isLoadedOrLoading(modelType) {
    const entry = this._loadedModels.get(modelType);
    return Boolean(entry && !entry.disposing) || this._pendingLoads.has(modelType);
  }

  /**
   * Whether a model runs on the CPU beside another model that holds the GPU
   * (see ensureModelLoaded). Its caller may want it back on the GPU once
   * there is room. Asking does not count as using the model.
   * @param {string} modelType
   * @returns {boolean}
   */
  isOnCpuBeside(modelType) {
    const entry = this._loadedModels.get(modelType);
    return Boolean(entry && !entry.disposing && entry.cpuBeside);
  }

  /**
   * Residents that take memory from the budget. One that takes none (a
   * model on the CPU beside the one that holds the GPU, Whisper on the CPU)
   * is never unloaded to make room and is not something a load waits for:
   * a text model larger than the budget unloaded them on every load and
   * freed nothing.
   * @param {string} [excludeType]
   * @returns {number}
   */
  _budgetedResidentCount(excludeType) {
    let count = 0;
    for (const [type, entry] of this._loadedModels) {
      if (type !== excludeType && entry.sizeBytes > 0) count += 1;
    }
    return count;
  }

  /**
   * Check if we can load a model of given type
   */
  canLoadModel(/** @type {any} */ modelType) {
    const estimatedSize = this._modelSizeEstimates[modelType] || 0;
    const projectedUsage = this._currentMemoryUsage + this._pendingLoadBytes() + estimatedSize;
    return projectedUsage < this._maxMemoryUsage;
  }

  /**
   * Count memory that a load in progress is about to take.
   *
   * A model used to enter the budget only once it had finished loading, and
   * the vision runtime only once its health check had passed (about a minute
   * on a laptop GPU). Whatever asked "does this fit?" in between was told
   * the memory was free, so a text model and the vision runtime could be
   * started half a second apart and sit together at twice the budget.
   *
   * A reservation cannot be evicted; callers that need its memory wait for
   * it to end. It ends when the load becomes a resident (ensureModelLoaded,
   * registerExternalConsumer) or fails.
   *
   * @param {string} type
   * @param {number} sizeBytes
   * @returns {() => void} ends the reservation; calling it again does nothing
   */
  reserveLoad(type, sizeBytes) {
    /** @type {() => void} */
    let settle = () => {};
    /** @type {Promise<void>} */
    const settled = new Promise((resolve) => {
      settle = resolve;
    });
    const record = { sizeBytes: Math.max(0, Number(sizeBytes) || 0), settled, settle };
    const replaced = this._pendingLoads.get(type);
    this._pendingLoads.set(type, record);
    replaced?.settle();
    return () => {
      if (this._pendingLoads.get(type) === record) this._pendingLoads.delete(type);
      record.settle();
    };
  }

  /**
   * Loads in progress that are not residents yet. A type that is both
   * reserved and registered (the instant between the two) counts once, as
   * the resident.
   * @param {string} [excludeType]
   * @returns {Array<[string, { sizeBytes: number, settled: Promise<void> }]>}
   */
  _pendingLoadEntries(excludeType) {
    return [...this._pendingLoads].filter(
      ([type]) => type !== excludeType && !this._loadedModels.has(type)
    );
  }

  /**
   * @param {string} [excludeType]
   * @returns {number}
   */
  _pendingLoadBytes(excludeType) {
    let total = 0;
    for (const [, pending] of this._pendingLoadEntries(excludeType)) total += pending.sizeBytes;
    return total;
  }

  /**
   * Wait for the loads in progress to end, for at most the time a load
   * waits on a pinned resident.
   * @param {string} [excludeType]
   * @returns {Promise<boolean>} false when one is still in progress
   */
  async _pendingLoadsSettled(excludeType) {
    const waits = this._pendingLoadEntries(excludeType).map(([, pending]) => pending.settled);
    if (waits.length === 0) return true;
    if (!(this._pinnedResidentWaitMs > 0)) return false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), this._pinnedResidentWaitMs);
    });
    try {
      return await Promise.race([Promise.all(waits).then(() => true), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Whether a consumer that loads outside this manager (the vision
   * llama-server child, registered afterwards as an external consumer) fits
   * the budget next to what is resident now. Mirrors ensureModelLoaded's
   * rule: with nothing resident a single oversized estimate is allowed
   * through (the runtime may still manage with mmap or GPU offload); with
   * residents pinned by in-flight work the answer is honest. A load in
   * progress counts like a resident. `excludeType` leaves out a registration
   * or reservation the caller is about to replace, so a resident vision
   * runtime is not counted twice.
   *
   * @param {number} sizeBytes
   * @param {{ excludeType?: string }} [options]
   * @returns {boolean}
   */
  canFitExternalLoad(sizeBytes, { excludeType } = {}) {
    this._refreshMemoryBudget();
    const excluded = excludeType ? this._loadedModels.get(excludeType) : null;
    const residentCount =
      this._budgetedResidentCount(excludeType) + this._pendingLoadEntries(excludeType).length;
    if (residentCount <= 0) return true;
    const usage =
      this._currentMemoryUsage -
      (excluded ? excluded.sizeBytes || 0 : 0) +
      this._pendingLoadBytes(excludeType);
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
      // A load in progress cannot be evicted. Wait for it to become a
      // resident (or fail), then judge it like any other.
      if (this._pendingLoadEntries(excludeType).length > 0) {
        if (!(await this._pendingLoadsSettled(excludeType))) return false;
        continue;
      }
      const evictable = [...this._loadedModels.entries()]
        .filter(
          ([type, entry]) =>
            type !== excludeType && entry.sizeBytes > 0 && (this._activeRefs.get(type) || 0) === 0
        )
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
   * Returns true when the model is the only thing that takes memory from the
   * budget (a call on a loaded context loads nothing), when it is resident
   * with headroom left beside the others, or when a fresh load fits within
   * the current budget. Unlike ensureModelLoaded(), this never proceeds
   * when the budget is exceeded — callers use it to skip non-critical inference
   * (e.g. graph cluster label refinement) instead of risking native OOM.
   *
   * @param {string} modelType
   * @returns {boolean}
   */
  canRunOptionalLoad(modelType) {
    this._refreshMemoryBudget();
    const entry = this._loadedModels.get(modelType);
    if (entry) {
      if (entry.disposing) return false;
      // A model whose estimate is above the budget on its own (7B on a 6 GB
      // card) never has headroom, so this said no for the rest of the session
      // while the model sat idle in memory.
      if (this._budgetedResidentCount(modelType) === 0 && this._pendingLoadEntries().length === 0) {
        return true;
      }
      const remaining = Math.max(
        0,
        this._maxMemoryUsage - this._currentMemoryUsage - this._pendingLoadBytes()
      );
      return remaining >= OPTIONAL_INFERENCE_HEADROOM_BYTES;
    }
    return this.canLoadModel(modelType);
  }

  /**
   * Ensure model is loaded, unloading others if necessary
   * @returns {Promise<any>}
   */
  async ensureModelLoaded(/** @type {any} */ modelType, options = {}) {
    // Already loaded? If a dispose is mid-flight for this type, wait for it
    // to settle first: returning the context now would hand the caller a
    // context whose native teardown is in progress (use-after-dispose). If
    // the dispose fails, the entry stays tracked and is safe to return.
    for (;;) {
      let entry = this._loadedModels.get(modelType);
      if (entry?.disposing) {
        await entry.disposePromise;
        entry = this._loadedModels.get(modelType);
      }
      if (entry) {
        entry.lastUsed = Date.now();
        return entry.context;
      }
      // Another caller is loading this model (the load lock can be dropped
      // from under a load that waits longer than its timeout). Wait for that
      // load instead of starting a second copy; if it fails, try here.
      const inFlight = this._pendingLoads.get(modelType);
      if (!inFlight) break;
      await inFlight.settled;
    }

    // Refresh budget from current system state before making load decisions
    this._refreshMemoryBudget();

    // Check if we need to free memory -- evict LRU models until budget allows.
    // Break if _unloadLeastRecentlyUsed could not evict (all models in active use).
    const estimatedSize = this._modelSizeEstimates[modelType] || 0;

    // A CPU-only load next to a pinned resident (the vision runtime during a
    // vision batch) does not take the resident's GPU memory, so the resident
    // is left out of the budget for this load. Without this, a 236 MB
    // embedding model "did not fit" beside the 6 GB vision runtime and the
    // runtime was shut down and restarted for every image of the batch.
    const besideType = /** @type {any} */ (options)?.besideResident;
    const cpuBeside =
      typeof besideType === 'string' && /** @type {any} */ (options)?.gpuLayersOverride === 0;
    // keepBeside: the caller chose this CPU load so an idle resident (the
    // text model between files) stays; without it only a pinned one does.
    // A resident that is still starting cannot be evicted and is pinned by
    // the work that started it, so it is left out the same way. Read on
    // every check: the resident can finish starting during the wait below.
    const besideBytes = () => {
      if (!cpuBeside) return 0;
      const besideEntry = this._loadedModels.get(besideType);
      if (!besideEntry) return this._pendingLoads.get(besideType)?.sizeBytes || 0;
      const pinned =
        (this._activeRefs.get(besideType) || 0) > 0 ||
        /** @type {any} */ (options)?.keepBeside === true;
      return pinned ? besideEntry.sizeBytes || 0 : 0;
    };
    const fits = () => {
      // Loaded or being loaded by another caller since this one started
      // waiting: nothing to make room for, the check before the load joins it.
      if (this._loadedModels.has(modelType) || this._pendingLoads.has(modelType)) return true;
      const beside = besideBytes();
      return beside > 0
        ? this._currentMemoryUsage + this._pendingLoadBytes() - beside + estimatedSize <
            this._maxMemoryUsage
        : this.canLoadModel(modelType);
    };
    // Residents that take memory from the budget, or loads in progress that
    // will become residents.
    const othersHoldMemory = () => this._budgetedResidentCount() > 0 || this._pendingLoads.size > 0;

    while (!fits() && this._budgetedResidentCount() > 0) {
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
    // remaining residents are pinned by in-flight inference. Wait for those
    // refs to drain and retry eviction so a document queued behind a vision
    // batch (or an embedding queued behind a text inference) runs once the
    // resident releases, instead of stacking a second multi-GB model. A load
    // in progress is waited out the same way: it becomes a resident that is
    // evicted here once it is idle.
    if (!fits() && othersHoldMemory() && this._pinnedResidentWaitMs > 0) {
      const deadline = Date.now() + this._pinnedResidentWaitMs;
      // Once nothing else holds memory there is nothing left to wait for: a
      // model whose own estimate exceeds the budget never fits, and waited
      // out the whole three minutes after the resident had gone.
      while (!fits() && othersHoldMemory() && Date.now() < deadline) {
        await delay(this._pinnedResidentPollMs);
        this._refreshMemoryBudget();
        while (!fits() && this._budgetedResidentCount() > 0) {
          const sizeBefore = this._loadedModels.size;
          // Quiet: the pass above already logged that nothing can be
          // evicted; repeating it every poll wrote a warning every 2 s for
          // as long as the wait lasted.
          await this._unloadLeastRecentlyUsed({ quiet: true });
          if (this._loadedModels.size === sizeBefore) break;
        }
      }
    }

    if (!fits()) {
      if (othersHoldMemory()) {
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
          loadedModels: Array.from(this._loadedModels.keys()),
          pendingLoads: Array.from(this._pendingLoads.keys())
        });
        throw budgetError;
      }
      // Nothing else takes memory from the budget: the single model's
      // conservative estimate exceeds the budget on its own. Proceed — the
      // runtime can still succeed (GPU offload, mmap), and failing here
      // would permanently
      // brick the feature on low-RAM machines.
      logger.warn('[Memory] Budget exceeded by single model estimate, attempting load anyway', {
        requestedType: modelType,
        estimatedSizeMB: Math.round(estimatedSize / 1024 / 1024),
        maxUsableMB: Math.round(this._maxMemoryUsage / 1024 / 1024),
        currentUsageMB: Math.round(this._currentMemoryUsage / 1024 / 1024)
      });
    }

    // Another caller loaded this model, or began to, while this one waited
    // for room: use that load.
    if (this._loadedModels.has(modelType) || this._pendingLoads.has(modelType)) {
      return this.ensureModelLoaded(modelType, options);
    }

    // The memory counts as taken from here, not from when the load finishes.
    const endReservation = this.reserveLoad(modelType, estimatedSize);
    try {
      // Load the model via the bound callback
      const context = await this._loadModelFn(modelType, options);

      // The load callback may have refined the estimate from the real file
      // size (updateModelSizeEstimate); record what this model actually
      // costs so later budget decisions are not held to the fixed guess.
      // A model on the CPU beside the one that holds the GPU takes none of
      // the memory the budget stands for, as Whisper on the CPU does not
      // (WhisperService registers that at 0 bytes).
      const recordedSize = cpuBeside ? 0 : this._modelSizeEstimates[modelType] || estimatedSize;
      this._loadedModels.set(modelType, {
        context,
        lastUsed: Date.now(),
        sizeBytes: recordedSize,
        cpuBeside
      });
      this._currentMemoryUsage += recordedSize;

      logger.info('[Memory] Model loaded', {
        type: modelType,
        currentUsageMB: Math.round(this._currentMemoryUsage / 1024 / 1024)
      });

      return context;
    } finally {
      endReservation();
    }
  }

  /**
   * Unload least recently used model, skipping models with active references
   * and models that take nothing from the budget.
   * @param {{ quiet?: boolean }} [options] quiet: no warning when nothing can be evicted
   */
  async _unloadLeastRecentlyUsed({ quiet = false } = {}) {
    let oldest = null;
    let oldestTime = Infinity;

    for (const [type, entry] of this._loadedModels) {
      // Never evict a model that is currently in-use for inference
      if ((this._activeRefs.get(type) || 0) > 0) continue;
      if (!(entry.sizeBytes > 0)) continue;

      if (entry.lastUsed < oldestTime) {
        oldest = type;
        oldestTime = entry.lastUsed;
      }
    }

    if (oldest) {
      await this.unloadModel(oldest);
    } else if (!quiet) {
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
      pendingLoads: Array.from(this._pendingLoads.keys()),
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
   * Waits for active references to drain before unloading (max `waitMs`,
   * 5s by default). `waitMs: 0` gives up at once when the model is in use,
   * for callers that will simply try again on their next load.
   *
   * @param {string} modelType
   * @param {{ allowedRefs?: number, waitMs?: number }} [options]
   */
  async unloadModel(modelType, { allowedRefs = 0, waitMs = 5000 } = {}) {
    const refs = this._activeRefs.get(modelType) || 0;
    if (refs > allowedRefs) {
      logger.info('[Memory] Waiting for active refs before unload', {
        type: modelType,
        refs,
        allowedRefs
      });
      const deadline = Date.now() + Math.max(0, waitMs);
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
