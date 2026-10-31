// @ts-check
const os = require('os');
const path = require('path');
const fs = require('fs');
const Piscina = /** @type {any} */ (require('piscina'));
const { createLogger } = require('../../shared/logger');
const { getAppRoot } = require('./bundledResourcePaths');
const { TIMEOUTS } = require('../../shared/performanceConstants');
const { parsePositiveInt } = require('../../shared/numberUtils');

/** @type {any} */
let app = null;
try {
  ({ app } = require('electron'));
} catch (err) {
  // electron require failed – running in test/worker context
  void err;
  app = null;
}

const logger = createLogger('WorkerPools');

/** @type {any} */
let ocrPool = null;
/** @type {any} */
let embeddingPool = null;
/** @type {any} */
let textExtractionPool = null;
/** @type {any} */
let imagePreprocessPool = null;
let _embeddingWorkerMissing = false;
let _loggedPiscinaDisabled = false;
let _loggedEmbeddingWorkerDisabled = false;
let _loggedEmbeddingWorkerEnabled = false;
let _warnedEmbeddingWorkerVramBudget = false;
// Default off: pool uses maxThreads 1 and loads a second embedding stack in VRAM;
// ParallelEmbeddingService falls back to LlamaService in the main process (better throughput + accounting).
// Read per-call (not cached at module load) so settings panel toggles, profile
// loads, and test helpers that mutate process.env take effect without a process
// restart. CLAUDE.md and docs/CONFIG.md document this as runtime-tunable.
function isEmbeddingWorkerEnabled() {
  return String(process.env.STRATOSORT_ENABLE_EMBEDDING_WORKER || 'false').toLowerCase() === 'true';
}

/**
 * What the embedding worker needs from electron's app, which a worker thread
 * cannot reach: the userData folder (for the GPU backend record) and the app
 * version (part of that record's key). Empty outside Electron.
 *
 * @returns {{ userDataPath?: string, appVersion?: string }}
 */
function getEmbeddingWorkerData() {
  /** @type {{ userDataPath?: string, appVersion?: string }} */
  const data = {};
  try {
    if (typeof app?.getPath === 'function') data.userDataPath = app.getPath('userData');
    if (typeof app?.getVersion === 'function') data.appVersion = app.getVersion();
  } catch {
    // Not ready or not Electron: the worker runs its plain backend ladder.
  }
  return data;
}
const DEFAULT_CPU_POOL_MAX_THREADS = 4;
const ABSOLUTE_CPU_POOL_MAX_THREADS = 8;

async function drainPool(/** @type {any} */ pool, /** @type {any} */ label) {
  if (!pool) return;
  if (typeof pool.drain === 'function') {
    await pool.drain();
    return;
  }

  const start = Date.now();
  const timeoutMs = 5000;
  let pending = typeof pool.pending === 'number' ? pool.pending : 0;
  let queueSize = typeof pool.queueSize === 'number' ? pool.queueSize : 0;

  while (pending + queueSize > 0 && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 50);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    pending = typeof pool.pending === 'number' ? pool.pending : 0;
    queueSize = typeof pool.queueSize === 'number' ? pool.queueSize : 0;
  }

  if (pending + queueSize > 0) {
    logger.warn('[WorkerPools] Timed out waiting for pool to drain', {
      label,
      pending,
      queueSize
    });
  }
}

function _getAppRoot() {
  return getAppRoot(app);
}

function shouldUsePiscina() {
  let disabledReason = null;
  if (process.env.JEST_WORKER_ID || process.env.NODE_ENV === 'test') {
    disabledReason = 'test-environment';
  }
  if (
    !disabledReason &&
    String(process.env.STRATOSORT_DISABLE_PISCINA || '').toLowerCase() === 'true'
  ) {
    disabledReason = 'env-disabled';
  }
  if (disabledReason) {
    if (!_loggedPiscinaDisabled) {
      _loggedPiscinaDisabled = true;
      logger.info('[WorkerPools] Piscina disabled', { reason: disabledReason });
    }
    return false;
  }
  _loggedPiscinaDisabled = false;
  return true;
}

/**
 * @param {string} name Worker entry name (webpack.main.config.js `entry` key)
 * @returns {string|null}
 */
function resolveWorkerPath(name) {
  const isPackaged = Boolean(app?.isPackaged);
  const candidates = [];

  // Packaged: worker bundles are the only dist files electron-builder unpacks
  // from the asar (electron-builder.json asarUnpack). worker_threads needs a
  // real on-disk entry, and __dirname resolves inside app.asar (where
  // fs.existsSync still succeeds), so the unpacked path must be tried first.
  if (isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', `${name}.js`));
  }
  // Webpack emits worker bundles alongside main.js in dist
  candidates.push(path.join(__dirname, `${name}.js`));
  // Dev fallback: resolve from app root (handles __dirname !== dist after bundling)
  candidates.push(path.join(_getAppRoot(), 'dist', `${name}.js`));
  // Dev fallback: source worker location
  candidates.push(path.join(_getAppRoot(), 'src', 'main', 'workers', `${name}.js`));
  if (isPackaged) {
    candidates.push(path.join(app.getAppPath?.() || '', 'dist', `${name}.js`));
  }

  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (resolved) return resolved;

  logger.error(`[WorkerPools] Could not resolve ${name} in any known location`, {
    __dirname,
    appRoot: _getAppRoot(),
    candidates
  });
  return null;
}

function resolveCpuPoolThreads(
  /** @type {any} */ envVarName,
  defaultMax = DEFAULT_CPU_POOL_MAX_THREADS
) {
  const cpuCount = Array.isArray(os.cpus?.()) ? os.cpus().length : 1;
  const baseline = Math.max(1, cpuCount - 1);
  const envOverride = parsePositiveInt(process.env[envVarName]);
  const requested = envOverride || Math.min(defaultMax, baseline);
  return Math.max(1, Math.min(requested, baseline, ABSOLUTE_CPU_POOL_MAX_THREADS));
}

// Failure tracking. Counters never decrement on success (Piscina has no
// per-task success hook we can wire here without wrapping every callsite),
// so we use a sliding-window approach: counters automatically reset to 0
// after FAILURE_RESET_MS of no failures. Without this, a single transient
// HMR-time failure would lock the pool out for the rest of the process
// lifetime.
const FAILURE_RESET_MS = 5 * 60 * 1000; // 5 minutes
const MAX_POOL_FAILURES = 5;
const MAX_EMBEDDING_FAILURES = 5;
const MAX_TEXT_EXTRACTION_FAILURES = 5;
const MAX_IMAGE_PREPROCESS_FAILURES = 5;

let ocrFailCount = 0;
let ocrLastFailureAt = 0;
let ocrBackoffUntil = 0;

let embeddingFailCount = 0;
// embeddingPool's getter doesn't gate on embeddingFailCount (it gates on
// _embeddingWorkerMissing instead), so we don't need a sliding-window reset
// here — but we do still track the count for diagnostic logging.

let textExtractionFailCount = 0;
let textExtractionLastFailureAt = 0;

let imagePreprocessFailCount = 0;
let imagePreprocessLastFailureAt = 0;

function _maybeResetFailCount(
  /** @type {any} */ lastFailureAt,
  /** @type {any} */ getReset,
  /** @type {any} */ setReset
) {
  if (lastFailureAt > 0 && Date.now() - lastFailureAt > FAILURE_RESET_MS) {
    setReset(0);
    return true;
  }
  return getReset();
}

// Note: we deliberately do NOT guard these getters with an "in-flight"
// boolean that returns null. Piscina's constructor is synchronous, so
// JS single-threaded execution already serializes creation. A previous
// `_creatingXPool` flag existed; if anything did manage to re-enter the
// getter during construction (e.g. a synchronous log observer calling
// back into the pool), the flag caused the second caller to silently
// fall back to the non-pooled path for that call — a lost-wakeup-style
// correctness bug that only showed up as occasional throughput dips.
// With no flag, a second entry either sees the assigned `ocrPool` (the
// normal case) or runs creation once more; Piscina handles duplicate
// construction cleanly by tearing the older one down on GC.

function getOcrPool() {
  if (!shouldUsePiscina()) return null;
  if (ocrPool) return ocrPool;
  // Sliding-window reset: if it's been > FAILURE_RESET_MS since the last
  // failure, give the pool another chance instead of staying disabled
  // for the rest of the process lifetime.
  if (ocrLastFailureAt > 0 && Date.now() - ocrLastFailureAt > FAILURE_RESET_MS) {
    ocrFailCount = 0;
    ocrLastFailureAt = 0;
  }
  if (ocrFailCount >= MAX_POOL_FAILURES) return null;
  if (ocrBackoffUntil > Date.now()) return null;

  const maxThreads = resolveCpuPoolThreads('STRATOSORT_OCR_WORKER_THREADS');
  const filename = resolveWorkerPath('ocrWorker');
  if (!filename) {
    logger.warn('[WorkerPools] OCR worker not found, disabling pool');
    return null;
  }
  ocrPool = new Piscina({
    filename,
    maxThreads,
    minThreads: 1,
    idleTimeout: 60000
  });
  ocrPool.stratosortMaxThreads = maxThreads;
  ocrPool.on('error', (/** @type {any} */ error) => {
    ocrFailCount++;
    ocrLastFailureAt = Date.now();
    ocrBackoffUntil =
      Date.now() + Math.min(1000 * Math.pow(2, ocrFailCount - 1), TIMEOUTS.SERVICE_STARTUP);
    logger.error('[WorkerPools] OCR worker thread error:', {
      error: error?.message,
      failCount: ocrFailCount,
      maxFailures: MAX_POOL_FAILURES,
      backoffMs: ocrBackoffUntil - Date.now()
    });
    const dyingPool = ocrPool;
    ocrPool = null;
    drainPool(dyingPool, 'ocr-error-cleanup')
      .then(() => dyingPool.destroy?.())
      .catch((e) => {
        logger.debug('[WorkerPools] OCR pool destroy failed:', e?.message);
      });
    if (ocrFailCount >= MAX_POOL_FAILURES) {
      logger.error('[WorkerPools] OCR pool permanently disabled after repeated failures');
    }
  });
  logger.info('[WorkerPools] OCR pool initialized', { maxThreads });
  return ocrPool;
}

function getEmbeddingPool() {
  if (!shouldUsePiscina()) return null;
  if (!isEmbeddingWorkerEnabled()) {
    if (!_loggedEmbeddingWorkerDisabled) {
      _loggedEmbeddingWorkerDisabled = true;
      _loggedEmbeddingWorkerEnabled = false; // arm for next enable transition
      logger.info('[WorkerPools] Embedding worker disabled by config', {
        envVar: 'STRATOSORT_ENABLE_EMBEDDING_WORKER'
      });
    }
    return null;
  }
  if (!_loggedEmbeddingWorkerEnabled) {
    _loggedEmbeddingWorkerEnabled = true;
    _loggedEmbeddingWorkerDisabled = false; // arm for next disable transition
    logger.info('[WorkerPools] Embedding worker enabled by config', {
      envVar: 'STRATOSORT_ENABLE_EMBEDDING_WORKER'
    });
  }
  if (embeddingPool) return embeddingPool;
  if (_embeddingWorkerMissing) return null;

  const filename = resolveWorkerPath('embeddingWorker');
  if (!filename) {
    logger.warn('[WorkerPools] Embedding worker not found, disabling pool');
    _embeddingWorkerMissing = true;
    return null;
  }
  // Loud, one-time warning on every enable so the split-VRAM contract is
  // visible in logs and crash reports. The worker loads a *separate*
  // node-llama-cpp stack, which the main-process ModelMemoryManager
  // cannot see or budget against — on a GPU with ~6 GB free, enabling
  // this mode can pin 2× embedding model VRAM (one per process) and
  // surprise the user with OOMs that look unrelated. Callers that want
  // this mode (usually diagnostic tools) must accept that trade-off.
  if (!_warnedEmbeddingWorkerVramBudget) {
    _warnedEmbeddingWorkerVramBudget = true;
    logger.warn(
      '[WorkerPools] Embedding worker enabled — a second node-llama-cpp stack will be loaded in the worker thread. ' +
        'VRAM accounting in ModelMemoryManager only tracks the main process, so total GPU usage may double. ' +
        'Disable STRATOSORT_ENABLE_EMBEDDING_WORKER to return to the default in-process embedding path.'
    );
  }
  embeddingPool = new Piscina({
    filename,
    // The worker cannot reach electron's app; it reads the GPU backend record
    // LlamaService keeps under userData (see utils/llamaBackendCache).
    workerData: getEmbeddingWorkerData(),
    maxThreads: 1,
    minThreads: 1,
    // 10-minute idle timeout: keeps the GPU-resident embedding model warm
    // between searches. The default 60s causes a cold-start penalty (thread
    // respawn + model reload, ~2-5s) whenever the user pauses between queries.
    idleTimeout: 10 * 60 * 1000
  });
  embeddingPool.stratosortMaxThreads = 1;
  embeddingPool.on('error', (/** @type {any} */ error) => {
    embeddingFailCount++;
    logger.error('[WorkerPools] Embedding worker thread error:', {
      error: error?.message,
      failCount: embeddingFailCount,
      maxFailures: MAX_EMBEDDING_FAILURES
    });
    const dyingPool = embeddingPool;
    embeddingPool = null;
    drainPool(dyingPool, 'embedding-error-cleanup')
      .then(() => dyingPool.destroy?.())
      .catch((e) => {
        logger.debug('[WorkerPools] Embedding pool destroy failed:', e?.message);
      });
    if (embeddingFailCount >= MAX_EMBEDDING_FAILURES) {
      _embeddingWorkerMissing = true;
      logger.error('[WorkerPools] Embedding pool permanently disabled after repeated failures');
    }
  });
  logger.info('[WorkerPools] Embedding pool initialized', { maxThreads: 1 });
  return embeddingPool;
}

function getTextExtractionPool() {
  if (!shouldUsePiscina()) return null;
  if (textExtractionPool) return textExtractionPool;
  if (
    textExtractionLastFailureAt > 0 &&
    Date.now() - textExtractionLastFailureAt > FAILURE_RESET_MS
  ) {
    textExtractionFailCount = 0;
    textExtractionLastFailureAt = 0;
  }
  if (textExtractionFailCount >= MAX_TEXT_EXTRACTION_FAILURES) return null;

  const maxThreads = resolveCpuPoolThreads('STRATOSORT_TEXT_EXTRACTION_WORKER_THREADS');
  const filename = resolveWorkerPath('textExtractionWorker');
  if (!filename) {
    logger.warn('[WorkerPools] Text extraction worker not found, disabling pool');
    return null;
  }
  textExtractionPool = new Piscina({
    filename,
    maxThreads,
    minThreads: 1,
    idleTimeout: 60000
  });
  textExtractionPool.stratosortMaxThreads = maxThreads;
  textExtractionPool.on('error', (/** @type {any} */ error) => {
    textExtractionFailCount++;
    textExtractionLastFailureAt = Date.now();
    logger.error('[WorkerPools] Text extraction worker thread error:', {
      error: error?.message,
      failCount: textExtractionFailCount,
      maxFailures: MAX_TEXT_EXTRACTION_FAILURES
    });
    const dyingPool = textExtractionPool;
    textExtractionPool = null;
    drainPool(dyingPool, 'text-extraction-error-cleanup')
      .then(() => dyingPool.destroy?.())
      .catch((e) => {
        logger.debug('[WorkerPools] Text extraction pool destroy failed:', e?.message);
      });
    if (textExtractionFailCount >= MAX_TEXT_EXTRACTION_FAILURES) {
      logger.error(
        '[WorkerPools] Text extraction pool permanently disabled after repeated failures'
      );
    }
  });
  logger.info('[WorkerPools] Text extraction pool initialized', { maxThreads });
  return textExtractionPool;
}

function getImagePreprocessPool() {
  if (!shouldUsePiscina()) return null;
  if (imagePreprocessPool) return imagePreprocessPool;
  if (
    imagePreprocessLastFailureAt > 0 &&
    Date.now() - imagePreprocessLastFailureAt > FAILURE_RESET_MS
  ) {
    imagePreprocessFailCount = 0;
    imagePreprocessLastFailureAt = 0;
  }
  if (imagePreprocessFailCount >= MAX_IMAGE_PREPROCESS_FAILURES) return null;

  // Image preprocessing (sharp/libvips) is CPU-bound but each op is short
  // and bursts often come from the bulk folder analysis path. We therefore
  // follow the same CPU-pool sizing heuristic as OCR/text extraction rather
  // than capping at 1 like the embedding worker.
  const maxThreads = resolveCpuPoolThreads('STRATOSORT_IMAGE_WORKER_THREADS');
  const filename = resolveWorkerPath('imagePreprocessWorker');
  if (!filename) {
    logger.warn('[WorkerPools] Image preprocess worker not found, disabling pool');
    return null;
  }
  imagePreprocessPool = new Piscina({
    filename,
    maxThreads,
    minThreads: 1,
    idleTimeout: 60000
  });
  imagePreprocessPool.stratosortMaxThreads = maxThreads;
  imagePreprocessPool.on('error', (/** @type {any} */ error) => {
    imagePreprocessFailCount++;
    imagePreprocessLastFailureAt = Date.now();
    logger.error('[WorkerPools] Image preprocess worker thread error:', {
      error: error?.message,
      failCount: imagePreprocessFailCount,
      maxFailures: MAX_IMAGE_PREPROCESS_FAILURES
    });
    const dyingPool = imagePreprocessPool;
    imagePreprocessPool = null;
    drainPool(dyingPool, 'image-preprocess-error-cleanup')
      .then(() => dyingPool.destroy?.())
      .catch((e) => {
        logger.debug('[WorkerPools] Image preprocess pool destroy failed:', e?.message);
      });
    if (imagePreprocessFailCount >= MAX_IMAGE_PREPROCESS_FAILURES) {
      logger.error(
        '[WorkerPools] Image preprocess pool permanently disabled after repeated failures'
      );
    }
  });
  logger.info('[WorkerPools] Image preprocess pool initialized', { maxThreads });
  return imagePreprocessPool;
}

async function destroyOcrPool() {
  const pool = ocrPool;
  ocrPool = null;
  if (pool) {
    try {
      await drainPool(pool, 'ocr');
    } catch (error) {
      logger.warn('[WorkerPools] Error draining OCR pool:', { error: error?.message });
    }
    try {
      await pool.destroy();
    } catch (error) {
      logger.warn('[WorkerPools] Error destroying OCR pool:', { error: error?.message });
    }
  }
}

async function destroyEmbeddingPool() {
  const pool = embeddingPool;
  embeddingPool = null;
  if (pool) {
    // Run the worker's cleanup task BEFORE drain/destroy so node-llama-cpp
    // model + context handles get an explicit `dispose()`. Without this,
    // pool.destroy() terminates the worker thread while the native context
    // is still allocated; on some GPU drivers (CUDA / Metal) the VRAM is
    // not released until the next process touches the device. Bounded
    // timeout so a hung worker can't gate shutdown indefinitely.
    try {
      await Promise.race([
        pool.run({ type: 'cleanup' }),
        new Promise((resolve) => setTimeout(resolve, TIMEOUTS.HEALTH_CHECK))
      ]);
    } catch (error) {
      logger.warn('[WorkerPools] Embedding worker cleanup task failed:', {
        error: error?.message
      });
    }
    try {
      await drainPool(pool, 'embedding');
    } catch (error) {
      logger.warn('[WorkerPools] Error draining embedding pool:', { error: error?.message });
    }
    try {
      await pool.destroy();
    } catch (error) {
      logger.warn('[WorkerPools] Error destroying embedding pool:', { error: error?.message });
    }
  }
}

async function destroyTextExtractionPool() {
  const pool = textExtractionPool;
  textExtractionPool = null;
  if (pool) {
    try {
      await drainPool(pool, 'textExtraction');
    } catch (error) {
      logger.warn('[WorkerPools] Error draining text extraction pool:', { error: error?.message });
    }
    try {
      await pool.destroy();
    } catch (error) {
      logger.warn('[WorkerPools] Error destroying text extraction pool:', {
        error: error?.message
      });
    }
  }
}

async function destroyImagePreprocessPool() {
  const pool = imagePreprocessPool;
  imagePreprocessPool = null;
  if (pool) {
    try {
      await drainPool(pool, 'imagePreprocess');
    } catch (error) {
      logger.warn('[WorkerPools] Error draining image preprocess pool:', {
        error: error?.message
      });
    }
    try {
      await pool.destroy();
    } catch (error) {
      logger.warn('[WorkerPools] Error destroying image preprocess pool:', {
        error: error?.message
      });
    }
  }
}

async function destroyPools() {
  await destroyOcrPool();
  await destroyEmbeddingPool();
  await destroyTextExtractionPool();
  await destroyImagePreprocessPool();
}

function getWorkerPoolHealth() {
  return {
    piscinaEnabled: shouldUsePiscina(),
    embeddingWorkerEnabled: isEmbeddingWorkerEnabled(),
    ocrPoolReady: Boolean(ocrPool),
    embeddingPoolReady: Boolean(embeddingPool),
    embeddingWorkerMissing: _embeddingWorkerMissing,
    imagePreprocessPoolReady: Boolean(imagePreprocessPool),
    ocrFailCount,
    embeddingFailCount,
    imagePreprocessFailCount,
    ocrMaxThreads: ocrPool?.stratosortMaxThreads || 0,
    embeddingMaxThreads: embeddingPool?.stratosortMaxThreads || 0,
    textExtractionMaxThreads: textExtractionPool?.stratosortMaxThreads || 0,
    imagePreprocessMaxThreads: imagePreprocessPool?.stratosortMaxThreads || 0
  };
}

module.exports = {
  getOcrPool,
  getEmbeddingPool,
  getTextExtractionPool,
  getImagePreprocessPool,
  destroyPools,
  destroyOcrPool,
  destroyEmbeddingPool,
  destroyTextExtractionPool,
  destroyImagePreprocessPool,
  getWorkerPoolHealth,
  shouldUsePiscina,
  resolveWorkerPath, // Export for testing
  getEmbeddingWorkerData // Export for testing
};
