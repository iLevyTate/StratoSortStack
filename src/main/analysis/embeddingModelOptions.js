// @ts-check
/**
 * Embedding Model Options Resolver
 *
 * One resolver for the active embedding model + context size, used by every
 * embedding-text summary builder so they all cap to the same token budget
 * (CP-11) instead of drifting to the legacy 512-token floor when the model
 * options are omitted.
 *
 * Deliberately a leaf module: it only imports the DI container and shared
 * constants/logger, so requiring it never pulls in LlamaService (and its
 * transitive VisionService/tar/node-llama-cpp chain). Callers that need this
 * to stay a lazy/leaf dependency (e.g. embeddingSync.js) rely on that.
 *
 * @module analysis/embeddingModelOptions
 */

const { container, ServiceIds } = require('../services/ServiceContainer');
const { AI_DEFAULTS } = require('../../shared/constants');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('EmbeddingModelOptions');

/**
 * Resolve the active embedding model name and context size once, so every
 * embedding-text builder caps to the same token budget (CP-11).
 *
 * Never rejects. When LLAMA_SERVICE is unresolvable, the resolved service
 * lacks `getConfig`, or `getConfig()` throws, this returns
 * `AI_DEFAULTS.EMBEDDING.MODEL` with `embeddingContextSize` left undefined.
 * A context size that is not a positive finite number is ignored, so a
 * half-written config can't shrink the budget to 0 or NaN.
 * No side effects: this only reads from the DI container via `tryResolve`
 * and never constructs a service itself.
 *
 * @returns {Promise<{ embeddingModel: string, embeddingContextSize: number | undefined }>}
 */
async function resolveEmbeddingModelOptions() {
  let embeddingModel = AI_DEFAULTS.EMBEDDING.MODEL;
  let embeddingContextSize;
  try {
    const llamaService = container.tryResolve(ServiceIds.LLAMA_SERVICE);
    const cfg =
      llamaService && typeof llamaService.getConfig === 'function'
        ? await llamaService.getConfig()
        : null;
    if (cfg?.embeddingModel) embeddingModel = cfg.embeddingModel;
    if (Number.isFinite(cfg?.embeddingContextSize) && cfg.embeddingContextSize > 0) {
      embeddingContextSize = cfg.embeddingContextSize;
    }
  } catch (cfgError) {
    logger.debug('[EmbeddingModelOptions] Could not read embedding config; using defaults', {
      error: cfgError.message
    });
  }
  return { embeddingModel, embeddingContextSize };
}

module.exports = { resolveEmbeddingModelOptions };
