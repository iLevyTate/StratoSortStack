// @ts-check
/**
 * ModelAccessCoordinator — fairness + safety for the single LLM resource.
 *
 * Wraps each of {text, vision, embedding} models with a load-lock and
 * an inference queue. Inference concurrency defaults to 1 (configurable
 * via STRATOSORT_INFERENCE_CONCURRENCY, capped at 4) because llama.cpp
 * doesn't share GPU memory across concurrent generations safely. The
 * 15-second force-release grace lets a long-running holder cooperatively
 * abort before we drop the mutex on it; without that grace, abort paths
 * race and leave the model in a half-disposed state.
 */
const { createLogger } = require('../../shared/logger');
const PQueue = require('p-queue').default;

const logger = createLogger('ModelAccessCoordinator');

const MAX_INFERENCE_QUEUE = 100;
const MAX_QUEUE_SIZE = 100;
const LOAD_LOCK_TIMEOUT_MS = 120000; // 2 minutes: model loads can be slow on HDD/CPU
const INFERENCE_SLOT_TIMEOUT_MS = 300000; // 5 minutes: vision inference on CPU can be very slow
// Grace window after invoking a force-release callback (abort/unload) before
// we drop the mutex ourselves. Gives the holder time to cooperatively abort.
const FORCE_RELEASE_GRACE_MS = 15000;
const DEFAULT_INFERENCE_CONCURRENCY = (() => {
  const raw = Number(process.env.STRATOSORT_INFERENCE_CONCURRENCY);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.max(1, Math.min(4, Math.floor(raw)));
  }
  return 1;
})();

const MODEL_TYPES = ['text', 'vision', 'embedding'];

class ModelAccessCoordinator {
  /**
   * @param {{ inferenceSlots?: number }} [options] - Configuration options
   */
  constructor(options = {}) {
    // Per-model-type queues for loading (mutex semantics)
    this._loadQueues = {
      text: new PQueue({ concurrency: 1 }),
      vision: new PQueue({ concurrency: 1 }),
      embedding: new PQueue({ concurrency: 1 })
    };

    // Per-model-type inference queues.
    // This prevents vision operations (which may take minutes to load on CPU) from
    // starving embedding or text operations that share no GPU memory contention.
    const concurrency = options.inferenceSlots || DEFAULT_INFERENCE_CONCURRENCY;
    /** @type {Record<string, any>} */
    this._inferenceQueues = {};
    for (const type of MODEL_TYPES) {
      this._inferenceQueues[type] = new PQueue({ concurrency });
    }

    logger.info('[Coordinator] Per-model inference concurrency', {
      concurrency,
      modelTypes: MODEL_TYPES,
      source: options.inferenceSlots ? 'PerformanceService' : 'default'
    });

    // Track active operations for debugging
    this._activeOperations = new Map();
  }

  /**
   * Update inference concurrency limit dynamically
   * @param {number} concurrency - New concurrency limit
   */
  updateInferenceConcurrency(concurrency) {
    if (!Number.isFinite(concurrency) || concurrency < 1) return;
    // Clamp to an integer and an upper bound. A caller that accidentally
    // passes `Infinity` (from a parsed settings value) or a giant number
    // previously wrote it straight into p-queue, which would then try to
    // dequeue everything at once and blow out the model VRAM budget. The
    // upper cap is generous (16) but prevents pathological configs.
    const nextConcurrency = Math.max(1, Math.min(16, Math.floor(concurrency)));

    // No-op fast-path: avoid log spam from PerformanceService re-emitting
    // the same value every tick and keeps p-queue from touching its
    // internal queue when nothing actually changed.
    const first = this._inferenceQueues[MODEL_TYPES[0]];
    if (first && first.concurrency === nextConcurrency) return;

    logger.info('[Coordinator] Updating inference concurrency', {
      requested: concurrency,
      applied: nextConcurrency
    });

    // p-queue v9 supports in-place mutation of `.concurrency` — increases
    // dequeue extras immediately, decreases let in-flight tasks finish
    // naturally and only clamp on the next dequeue. We intentionally do
    // not pause/drain here: waiting for onIdle() could stall user-visible
    // inference for many seconds on a saturated queue just to propagate a
    // settings change, and the semantics above are already safe.
    for (const type of MODEL_TYPES) {
      if (this._inferenceQueues[type]) {
        this._inferenceQueues[type].concurrency = nextConcurrency;
      }
    }
  }

  /**
   * Acquire exclusive access for model loading.
   *
   * Includes a timeout to prevent indefinite hangs when the lock holder is
   * stuck (e.g. frozen GPU driver, blocked disk I/O).
   *
   * When the holder blows past the timeout, we previously dropped the mutex
   * unilaterally after a grace period. That is unsafe: a second loader could
   * then race with a stuck loader that is still touching model state. The
   * safer contract is:
   *   1. Fire `onForceRelease` (a caller-supplied abort/unload hook).
   *   2. Wait up to FORCE_RELEASE_GRACE_MS for the holder to release.
   *   3. Only if the holder still has not released do we drop the mutex as a
   *      last-resort deadlock break — and we log prominently so the failure
   *      is visible in telemetry.
   *
   * @param {string} modelType - 'text' | 'vision' | 'embedding'
   * @param {Record<string, any>} [options] - { timeoutMs, onForceRelease }
   * @returns {Promise<Function>} Release callback
   */
  async acquireLoadLock(modelType, options = {}) {
    const queue = /** @type {Record<string, any>} */ (this._loadQueues)[modelType];
    if (!queue) {
      throw new Error(`Unknown model type: ${modelType}`);
    }

    if (queue.size + queue.pending >= MAX_QUEUE_SIZE) {
      const error = /** @type {Error & { code?: string }} */ (
        new Error(`Load queue full for ${modelType}`)
      );
      error.code = 'QUEUE_FULL';
      throw error;
    }

    const timeoutMs = options.timeoutMs || LOAD_LOCK_TIMEOUT_MS;
    const onForceRelease =
      typeof options.onForceRelease === 'function' ? options.onForceRelease : null;
    /** @type {(v?: any) => void} */
    let releaseHeld;
    let timer = null;
    let startedRunning = false;
    let cancelledBeforeStart = false;
    let released = false;
    let startedSettled = false;
    /** @type {(v?: any) => void} */
    let startResolve;
    /** @type {(e?: any) => void} */
    let startReject;
    const started = new Promise((resolve, reject) => {
      startResolve = resolve;
      startReject = reject;
    });
    const held = new Promise((resolve) => {
      releaseHeld = resolve;
    });

    const releaseLock = (reason = 'caller') => {
      if (released) return false;
      released = true;
      try {
        releaseHeld();
      } catch {
        // No-op: releasing a held promise should not throw, but never break callers
      }
      logger.debug(`[Coordinator] Released load lock for ${modelType}`, { reason });
      return true;
    };

    queue.add(async () => {
      startedRunning = true;
      if (!startedSettled) {
        startedSettled = true;
        startResolve();
      }
      if (cancelledBeforeStart) {
        releaseLock('queue-wait-timeout');
        return;
      }
      await held;
    });

    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let innerTimer;

    timer = setTimeout(() => {
      // Phase 1: waiting in queue; reject caller and let queued task auto-release on dequeue.
      if (!startedRunning) {
        cancelledBeforeStart = true;
        if (!startedSettled) {
          startedSettled = true;
          const error = /** @type {Error & { code?: string }} */ (
            new Error(`Load lock timeout for ${modelType} after ${timeoutMs}ms`)
          );
          error.code = 'LOAD_LOCK_TIMEOUT';
          startReject(error);
        }
        return;
      }
      // Phase 2: lock acquired but still running.
      // Attempt a controlled abort/unload via the holder's onForceRelease hook
      // BEFORE we drop the mutex. If the hook releases the lock cooperatively
      // nothing else needs to happen. Only if the holder is truly stuck past
      // the grace window do we drop the mutex as a last-resort deadlock break.
      logger.warn('[Coordinator] Load lock held past timeout; attempting controlled abort', {
        modelType,
        timeoutMs,
        graceMs: FORCE_RELEASE_GRACE_MS,
        hasOnForceRelease: Boolean(onForceRelease)
      });

      const invokeForceRelease = async () => {
        if (released) return;
        if (onForceRelease) {
          // The grace-cap timer must be cleared when the hook wins the race;
          // otherwise it stays queued on the libuv loop for the full grace
          // window, keeps the event loop alive (blocking a clean shutdown),
          // and eventually rejects on an already-settled promise. Capturing
          // the timer handle here lets us clear it in the `finally` block.
          let graceTimer;
          try {
            await Promise.race([
              Promise.resolve().then(() =>
                onForceRelease({ modelType, reason: 'load-lock-timeout' })
              ),
              // Independent cap on the callback itself so a broken hook
              // cannot extend our wall-clock beyond the grace window.
              new Promise((_resolve, reject) => {
                graceTimer = setTimeout(
                  () => reject(new Error('onForceRelease callback exceeded grace window')),
                  FORCE_RELEASE_GRACE_MS
                );
              })
            ]);
          } catch (err) {
            logger.warn('[Coordinator] onForceRelease hook failed or timed out', {
              modelType,
              error: err?.message
            });
          } finally {
            if (graceTimer) clearTimeout(graceTimer);
          }
        } else {
          logger.error(
            '[Coordinator] No onForceRelease hook supplied for stuck load; ' +
              'unable to cooperatively abort. Consider wiring one in LlamaService.',
            { modelType }
          );
        }
      };

      // Invoke force-release immediately when the outer timer fires.
      // Previously this scheduled another `setTimeout(..., timeoutMs)` which
      // doubled the wall-clock wait for every stuck load (e.g. default 2min
      // → ~4min wait before mutex drop). The hook itself is already capped
      // by `FORCE_RELEASE_GRACE_MS` inside `invokeForceRelease`, so the
      // single grace stage we actually need is the one inside that helper.
      // Using setTimeout(0) preserves the "asynchronous tail" semantics
      // (gives any in-flight caller microtask a chance to settle) without
      // adding wall-clock.
      innerTimer = setTimeout(async () => {
        if (released) return;
        await invokeForceRelease();
        if (released) return;
        logger.error(
          '[Coordinator] Force-releasing stuck load lock after abort grace expired. ' +
            'Subsequent loaders may observe partially-loaded model state.',
          {
            modelType,
            hadForceReleaseHook: Boolean(onForceRelease)
          }
        );
        releaseLock('force-release-deadlock');
      }, 0);
    }, timeoutMs);

    try {
      await started;
    } catch (error) {
      clearTimeout(timer);
      clearTimeout(innerTimer);
      throw error;
    }

    logger.debug(`[Coordinator] Acquired load lock for ${modelType}`);

    return () => {
      releaseLock('caller');
      clearTimeout(timer);
      clearTimeout(innerTimer);
    };
  }

  /**
   * Get the inference queue for a model type (falls back to embedding queue for unknown types)
   * @private
   */
  _getInferenceQueue(/** @type {any} */ modelType) {
    return this._inferenceQueues[modelType] || this._inferenceQueues.embedding;
  }

  /**
   * Acquire slot for inference operation.
   *
   * Includes a timeout to prevent indefinite hangs when the slot holder is
   * stuck (e.g. frozen GPU driver, hung inference).
   *
   * @param {string} operationId - Unique operation identifier
   * @param {string} [modelType] - Model type for per-type queue routing
   * @param {Record<string, any>} [options] - { timeoutMs, signal, priority }
   */
  async acquireInferenceSlot(operationId, modelType, options = {}) {
    const queue = this._getInferenceQueue(modelType);
    const startTime = Date.now();

    // queue.size only counts waiting items, queue.pending counts active items
    if (queue.size + queue.pending >= MAX_INFERENCE_QUEUE) {
      const error = /** @type {Error & { code?: string }} */ (new Error('Inference queue full'));
      error.code = 'QUEUE_FULL';
      throw error;
    }

    const { signal, priority = 0 } = options;

    // Fast-path: caller already aborted before we even try to queue.
    if (signal?.aborted) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error(`Inference slot aborted before queuing (${modelType})`)
      );
      err.code = 'INFERENCE_SLOT_ABORTED';
      throw err;
    }

    const timeoutMs = options.timeoutMs || INFERENCE_SLOT_TIMEOUT_MS;
    /** @type {(v?: any) => void} */
    let releaseHeld;
    let timer = null;
    let startedRunning = false;
    let cancelledBeforeStart = false;
    let released = false;
    let startedSettled = false;
    /** @type {(v?: any) => void} */
    let startResolve;
    /** @type {(e?: any) => void} */
    let startReject;
    const started = new Promise((resolve, reject) => {
      startResolve = resolve;
      startReject = reject;
    });
    const held = new Promise((resolve) => {
      releaseHeld = resolve;
    });

    const releaseSlot = (reason = 'caller') => {
      if (released) return false;
      released = true;
      try {
        releaseHeld();
      } catch {
        // No-op: releasing a held promise should not throw, but never break callers
      }
      this._activeOperations.delete(operationId);
      logger.debug(`[Coordinator] Released inference slot`, { operationId, reason });
      return true;
    };

    queue.add(
      async () => {
        startedRunning = true;
        if (!startedSettled) {
          startedSettled = true;
          startResolve();
        }
        if (cancelledBeforeStart) {
          releaseSlot('queue-wait-timeout');
          return;
        }
        await held;
      },
      { priority }
    );

    timer = setTimeout(() => {
      // Phase 1: waiting in queue
      if (!startedRunning) {
        cancelledBeforeStart = true;
        if (!startedSettled) {
          startedSettled = true;
          const error = /** @type {Error & { code?: string }} */ (
            new Error(
              `Inference slot timeout for ${modelType || 'unknown'} (op: ${operationId}) after ${timeoutMs}ms`
            )
          );
          error.code = 'INFERENCE_SLOT_TIMEOUT';
          startReject(error);
        }
        return;
      }
      // Phase 2: slot acquired but not released
      // Do not force release here: the inference may still be running and
      // releasing early can allow unsafe concurrent use of model resources.
      logger.warn('[Coordinator] Inference slot held past timeout; waiting for holder to release', {
        operationId,
        modelType,
        timeoutMs,
        safetyMode: 'no-force-release'
      });
    }, timeoutMs);

    // If the caller provides an AbortSignal, cancel the queued entry immediately
    // when the signal fires — no need to wait for the full coordinator timeout.
    // This lets background jobs (e.g. LLM suggestions) vacate the queue as soon
    // as their own timeout fires, freeing space for interactive requests (chat).
    let removeAbortListener = null;
    if (signal) {
      const onAbort = () => {
        if (!startedRunning) {
          cancelledBeforeStart = true;
          if (!startedSettled) {
            startedSettled = true;
            const err = /** @type {Error & { code?: string }} */ (
              new Error(
                `Inference slot aborted while queued for ${modelType || 'unknown'} (op: ${operationId})`
              )
            );
            err.code = 'INFERENCE_SLOT_ABORTED';
            startReject(err);
          }
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    }

    try {
      await started;
    } catch (error) {
      clearTimeout(timer);
      removeAbortListener?.();
      throw error;
    }

    removeAbortListener?.();

    this._activeOperations.set(operationId, {
      startTime,
      acquiredAt: Date.now(),
      modelType
    });

    logger.debug(`[Coordinator] Acquired inference slot`, {
      operationId,
      modelType,
      waitTimeMs: Date.now() - startTime
    });

    return () => {
      releaseSlot('caller');
      clearTimeout(timer);
    };
  }

  /**
   * Execute with model coordination.
   * @param {string} modelType
   * @param {(...args: any[]) => any} operation
   * @param {Record<string, any>} [options] - { operationId, signal, priority }
   */
  async withModel(modelType, operation, options = {}) {
    const { operationId = `op-${Date.now()}`, signal, priority } = options;

    // Acquire inference slot for the specific model type, forwarding the
    // signal so queue entries can be cancelled before their slot is reached.
    const releaseSlot = await this.acquireInferenceSlot(operationId, modelType, {
      signal,
      priority
    });

    // Post-acquire abort: observe the signal while the operation runs so
    // operators can see that a caller walked away mid-inference, and so
    // the release metric distinguishes "caller cancelled" from "completed".
    // We don't force-release the slot (interruption-safety requires the
    // operation's natural teardown), but we do expose the signal to the
    // operation via a callback argument so it can cooperatively check.
    let postAcquireAbortObserved = false;
    const onPostAcquireAbort = () => {
      postAcquireAbortObserved = true;
      logger.debug('[Coordinator] Post-acquire abort observed', {
        operationId,
        modelType,
        reason: signal?.reason
      });
    };
    if (signal && !signal.aborted) {
      signal.addEventListener('abort', onPostAcquireAbort, { once: true });
    } else if (signal?.aborted) {
      postAcquireAbortObserved = true;
    }

    try {
      // Pass signal into the operation so callers that haven't captured it
      // in closure can still cooperate. Existing callers ignore the arg,
      // so this is non-breaking.
      return await operation({ signal });
    } finally {
      if (signal) signal.removeEventListener?.('abort', onPostAcquireAbort);
      if (postAcquireAbortObserved) {
        logger.debug('[Coordinator] Released slot after post-acquire abort', {
          operationId,
          modelType
        });
      }
      releaseSlot();
    }
  }

  /**
   * Get coordinator status
   */
  getStatus() {
    return {
      activeOperations: this._activeOperations.size,
      queues: this.getQueueStats(),
      operations: Array.from(this._activeOperations.entries()).map(
        (/** @type {[string, any]} */ [id, data]) => ({
          id,
          modelType: data.modelType,
          runningMs: Date.now() - data.startTime
        })
      )
    };
  }

  /**
   * Get per-model queue pressure snapshot for adaptive callers.
   * @returns {Record<string, { queued: number, pending: number, concurrency: number }>}
   */
  getQueueStats() {
    /** @type {Record<string, { queued: number, pending: number, concurrency: number }>} */
    const snapshot = {};
    for (const type of MODEL_TYPES) {
      const queue = this._inferenceQueues[type];
      if (!queue) continue;
      snapshot[type] = {
        queued: queue.size,
        pending: queue.pending,
        concurrency: queue.concurrency
      };
    }
    return snapshot;
  }
}

// Singleton
/** @type {ModelAccessCoordinator|null} */
let instance = null;

function getInstance() {
  if (!instance) {
    instance = new ModelAccessCoordinator();
  }
  return instance;
}

module.exports = { ModelAccessCoordinator, getInstance };
