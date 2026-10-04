// @ts-check
/**
 * Embedding Dimension Resolver
 *
 * Centralizes embedding dimension lookup across services.
 *
 * @module shared/embeddingDimensions
 */

const { AI_DEFAULTS } = require('./constants');
const { getModel } = require('./modelRegistry');
const { createLogger } = require('./logger');

/**
 * @typedef {{ dimensions?: number, [key: string]: unknown }} ModelCatalogEntry
 */

const logger = createLogger('EmbeddingDimensions');

/**
 * Embedding dimension fallbacks for partial model name matching.
 * Primary lookup uses MODEL_CATALOG via getModel() for exact GGUF filenames.
 */
const DIMENSION_FALLBACKS = {
  'nomic-embed': 768,
  embeddinggemma: 768,
  'mxbai-embed-large': 1024,
  'all-minilm': 384,
  'bge-large': 1024,
  'snowflake-arctic-embed': 1024,
  gte: 768,
  default: 768
};

/** @param {string|null|undefined} modelName @returns {number|null} */
const getFallbackDimension = (modelName) => {
  if (!modelName || typeof modelName !== 'string') return null;
  const normalized = modelName.toLowerCase();
  const entries = Object.entries(DIMENSION_FALLBACKS)
    .filter(([key]) => key !== 'default')
    .sort(([a], [b]) => b.length - a.length);
  for (const [key, dimension] of entries) {
    if (normalized.includes(key.toLowerCase())) {
      return dimension;
    }
  }
  return null;
};

/** @param {number|undefined} override @returns {number} */
const getDefaultDimension = (override) => {
  if (Number.isInteger(override) && override > 0) return override;
  const fallback = AI_DEFAULTS?.EMBEDDING?.DIMENSIONS;
  return Number.isInteger(fallback) && fallback > 0 ? fallback : DIMENSION_FALLBACKS.default;
};

/**
 * Resolve embedding dimension for a model name.
 * @param {string} modelName
 * @param {{ defaultDimension?: number }} [options]
 * @returns {number}
 */
function resolveEmbeddingDimension(modelName, options = {}) {
  const defaultDimension = getDefaultDimension(options.defaultDimension);

  if (!modelName) return defaultDimension;

  const catalogEntry = /** @type {ModelCatalogEntry|null} */ (getModel(modelName));
  if (catalogEntry?.dimensions) {
    return catalogEntry.dimensions;
  }

  const fallback = getFallbackDimension(modelName);
  if (!fallback) {
    logger.warn(
      `Unknown embedding model "${modelName}", falling back to default dimension ${defaultDimension}`
    );
  }
  return fallback || defaultDimension;
}

/**
 * Check whether a model name maps to a known embedding dimension.
 * @param {string} modelName
 * @returns {boolean}
 */
function isKnownEmbeddingModel(modelName) {
  if (!modelName) return false;
  if (/** @type {ModelCatalogEntry|null} */ (getModel(modelName))?.dimensions) return true;
  return Boolean(getFallbackDimension(modelName));
}

module.exports = {
  resolveEmbeddingDimension,
  isKnownEmbeddingModel
};
