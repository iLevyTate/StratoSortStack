// @ts-check
const path = require('path');
const { workerData } = require('worker_threads');
const { createLogger } = require('../../shared/logger');
const { ERROR_CODES } = require('../../shared/errorCodes');

const logger = createLogger('EmbeddingWorker');

/** @type {any} */
let llamaInstance = null;
/** @type {string | null} */
let currentModelPath = null;
/** @type {any} */
let currentGpuLayers = null;
/** @type {any} */
let model = null;
/** @type {any} */
let context = null;

const isOutOfMemoryError = (/** @type {any} */ error) => {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('out of memory') ||
    message.includes('oom') ||
    message.includes('allocate') ||
    message.includes('buffer')
  );
};

/**
 * Resolve gpuLayers value to match LlamaService convention.
 * Leave undefined for auto so node-llama-cpp can fit to VRAM.
 */
/** @param {any} gpuLayers */
function resolveGpuLayers(gpuLayers) {
  if (gpuLayers === 'auto' || gpuLayers === -1 || gpuLayers == null) return undefined;
  if (typeof gpuLayers === 'number' && gpuLayers >= 0) return gpuLayers;
  return undefined;
}

/**
 * Initialize the Llama runtime with GPU auto-detection.
 * Cached across calls so GPU probe only happens once per worker lifetime.
 */
async function getLlamaInstance() {
  if (llamaInstance) return llamaInstance;

  const nodeLlama = await import(/* webpackIgnore: true */ 'node-llama-cpp');
  const { getLlama, getLlamaGpuTypes } = nodeLlama;
  const { GPUMonitor } = require('../services/GPUMonitor');
  const { initLlamaWithBackend } = require('../utils/llamaBackendSelector');
  const { createReadOnlyLlamaBackendCache } = require('../utils/llamaBackendCache');
  const { createFilteredLlamaLogger } = require('../utils/llamaLogFilter');
  // Embedding models are exactly the case that trips the benign tokenizer
  // round-trip warning; suppress it here too.
  const llamaLogger = createFilteredLlamaLogger(nodeLlama);
  const gpuMonitor = new GPUMonitor();

  let gpuInfo = null;
  try {
    gpuInfo = await gpuMonitor.detectGPU();
  } catch {
    // Ignore detection error
  }

  // Same supported-backend filter and remembered backend as LlamaService,
  // so this second stack does not re-test GPU binaries the main process has
  // already ruled out. userData and the app version come from the pool
  // (workerPools passes them as workerData); the record is read-only here.
  /** @type {any} */
  let backendCache;
  try {
    backendCache = await createReadOnlyLlamaBackendCache({
      userDataPath: workerData?.userDataPath,
      appVersion: workerData?.appVersion,
      nodeLlama,
      gpuInfo
    });
  } catch {
    backendCache = undefined;
  }

  try {
    const selection = await initLlamaWithBackend({
      getLlama,
      gpuInfo,
      logger,
      context: 'EmbeddingWorker',
      llamaLogger,
      getLlamaGpuTypes,
      backendCache
    });
    llamaInstance = selection.llama;
  } catch (error) {
    logger.warn('[EmbeddingWorker] GPU init failed, falling back to CPU', {
      error: error?.message
    });
    llamaInstance = await getLlama({ gpu: false, logger: llamaLogger });
  }

  return llamaInstance;
}

/**
 * @param {{ modelPath: string, gpuLayers?: any }} params
 */
async function ensureModelLoaded({ modelPath, gpuLayers }) {
  if (!modelPath) {
    throw Object.assign(new Error('Embedding model path is required'), {
      code: ERROR_CODES.LLAMA_MODEL_NOT_FOUND
    });
  }

  const resolvedLayers = resolveGpuLayers(gpuLayers);

  if (model && context && currentModelPath === modelPath && currentGpuLayers === resolvedLayers) {
    return context;
  }

  const llama = await getLlamaInstance();
  const resolvedPath = path.normalize(modelPath);
  logger.info('[EmbeddingWorker] Loading embedding model', {
    modelPath: resolvedPath,
    gpuLayers: typeof resolvedLayers === 'number' ? resolvedLayers : 'auto'
  });

  // Dispose previous model if exists
  if (context) {
    try {
      await context.dispose();
    } catch (e) {
      logger.warn('[EmbeddingWorker] Failed to dispose previous context', { error: e.message });
    }
    context = null;
  }
  if (model) {
    try {
      await model.dispose();
    } catch (e) {
      logger.warn('[EmbeddingWorker] Failed to dispose previous model', { error: e.message });
    }
    model = null;
    context = null;
  }

  try {
    /** @type {{ modelPath: string, gpuLayers?: number }} */
    const modelOptions = { modelPath: resolvedPath };
    if (typeof resolvedLayers === 'number') {
      modelOptions.gpuLayers = resolvedLayers;
    }
    model = await llama.loadModel(modelOptions);
    context = await model.createEmbeddingContext();
    currentModelPath = modelPath;
    currentGpuLayers = resolvedLayers;
    const actualLayers = model.gpuLayers ?? 'unknown';
    const gpuActive = typeof actualLayers === 'number' && actualLayers > 0;
    logger.info('[EmbeddingWorker] Embedding model ready', {
      gpuLayers: actualLayers,
      gpuActive: gpuActive ? 'yes' : 'no'
    });
    return context;
  } catch (error) {
    logger.error('[EmbeddingWorker] Failed to load embedding model', { error: error.message });
    // Ensure partially loaded model/context are disposed to avoid leaks
    if (context?.dispose) {
      try {
        await context.dispose();
      } catch {
        /* ignore */
      }
      context = null;
    }
    if (model?.dispose) {
      try {
        await model.dispose();
      } catch {
        /* ignore */
      }
      model = null;
    }
    currentModelPath = null;
    currentGpuLayers = null;
    if (isOutOfMemoryError(error)) {
      error.code = ERROR_CODES.LLAMA_OOM;
    } else if (!error.code) {
      error.code = ERROR_CODES.LLAMA_MODEL_LOAD_FAILED;
    }
    throw error;
  }
}

/**
 * Clean up GPU resources (model + context) before worker termination.
 * Call via pool.run({ type: 'cleanup' }) before pool.destroy().
 */
async function cleanup() {
  if (context) {
    try {
      await context.dispose();
    } catch {
      /* ignore */
    }
    context = null;
  }
  if (model) {
    try {
      await model.dispose();
    } catch {
      /* ignore */
    }
    model = null;
  }
  currentModelPath = null;
  currentGpuLayers = null;
  llamaInstance = null;
}

/**
 * @param {{ type?: string, text?: string, modelPath?: string, gpuLayers?: any }} [payload]
 */
module.exports = async function runEmbeddingTask(payload = {}) {
  if (!payload || typeof payload !== 'object') {
    throw Object.assign(new Error('Embedding payload must be an object'), {
      code: ERROR_CODES.LLAMA_INFERENCE_FAILED
    });
  }
  if (payload?.type === 'cleanup') {
    await cleanup();
    logger.info('[EmbeddingWorker] Cleanup completed');
    return { cleaned: true };
  }
  const { text, modelPath, gpuLayers = 'auto' } = payload || {};
  if (typeof text !== 'string') {
    throw Object.assign(new Error('Embedding text must be a string'), {
      code: ERROR_CODES.LLAMA_INFERENCE_FAILED
    });
  }
  if (!modelPath) {
    throw Object.assign(new Error('Embedding model path is required'), {
      code: ERROR_CODES.LLAMA_MODEL_NOT_FOUND
    });
  }

  try {
    logger.debug('[EmbeddingWorker] Generating embedding', {
      textLength: text.length,
      modelPath: modelPath ? path.basename(modelPath) : 'unknown',
      gpuLayers
    });
    const ctx = await ensureModelLoaded({ modelPath, gpuLayers });
    const embedding = await ctx.getEmbeddingFor(text);
    const vector = Array.from(embedding.vector);
    return { embedding: vector, model: path.basename(modelPath) };
  } catch (error) {
    const errorMsg = String(error?.message || error || '').toLowerCase();
    if (
      errorMsg.includes('input is longer than the context size') ||
      errorMsg.includes('context size of')
    ) {
      const actualContextSize =
        context?.contextSize ?? context?._contextSize ?? model?.trainContextSize ?? 'unknown';
      error.message = `${error.message} (Actual context size: ${actualContextSize})`;
    }

    if (isOutOfMemoryError(error)) {
      error.code = ERROR_CODES.LLAMA_OOM;
    } else if (!error.code) {
      error.code = ERROR_CODES.LLAMA_INFERENCE_FAILED;
    }
    throw error;
  }
};
