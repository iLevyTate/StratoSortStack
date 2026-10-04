// @ts-check
/**
 * LlamaUtils - Utilities for node-llama-cpp based LlamaService
 *
 * This module provides utility functions for working with the in-process
 * LlamaService.
 *
 * @module llamaUtils
 */

const { createLogger } = require('../shared/logger');
const { AI_DEFAULTS, DEFAULT_AI_MODELS } = require('../shared/constants');
const { ERROR_CODES } = require('../shared/errorCodes');
const { resolveEmbeddingDimension } = require('../shared/embeddingDimensions');

const logger = createLogger('llama-utils');

// When the settings file is unreadable, getCurrentLlamaConfig() falls back
// to the in-memory cached selections — which on first boot are the defaults
// (or null), and on later boots may be stale. The settings UI shows these
// values to the user as if they were authoritative, masking the underlying
// load failure. Surfacing via DegradedStateBanner gives the user actionable
// signal: "your model selection may not match what's saved on disk."
const LLAMA_CONFIG_STALE_CODE = 'llama.config-stale';

function _raiseLlamaConfigStale(/** @type {any} */ detail) {
  try {
    const { getInstance: getDegradedStateTracker } = require('./services/DegradedStateTracker');
    getDegradedStateTracker().raise({
      code: LLAMA_CONFIG_STALE_CODE,
      subsystem: 'ai-engine',
      severity: 'warning',
      message:
        "Couldn't read AI model settings; using last known values. Open Settings → AI to verify " +
        'the active models — changes you made may not be applied until the settings file is readable.',
      detail
    });
  } catch {
    /* tracker is best-effort */
  }
}

function _clearLlamaConfigStale() {
  try {
    const { getInstance: getDegradedStateTracker } = require('./services/DegradedStateTracker');
    getDegradedStateTracker().clear(LLAMA_CONFIG_STALE_CODE);
  } catch {
    /* never throw from a successful response path */
  }
}

// Selected models - in-memory cache
let selectedTextModel = AI_DEFAULTS.TEXT?.MODEL || null;
let selectedVisionModel = AI_DEFAULTS.IMAGE?.MODEL || null;
let selectedEmbeddingModel = AI_DEFAULTS.EMBEDDING?.MODEL || null;

/**
 * Lazy load LlamaService to avoid circular dependencies
 */
function getLlamaService() {
  try {
    const { getInstance } = require('./services/LlamaService');
    return getInstance();
  } catch (error) {
    logger.warn('[LlamaUtils] Failed to get LlamaService instance:', error.message);
    return null;
  }
}

/**
 * Get current text model name
 * @returns {string|null}
 */
function getTextModel() {
  const service = getLlamaService();
  if (service?._selectedModels?.text) {
    return service._selectedModels.text;
  }
  return selectedTextModel;
}

/**
 * Get current vision model name
 * @returns {string|null}
 */
function getVisionModel() {
  const service = getLlamaService();
  if (service?._selectedModels?.vision) {
    return service._selectedModels.vision;
  }
  return selectedVisionModel;
}

/**
 * Get current embedding model name
 * @returns {string|null}
 */
function getEmbeddingModel() {
  const service = getLlamaService();
  if (service?._selectedModels?.embedding) {
    return service._selectedModels.embedding;
  }
  return selectedEmbeddingModel;
}

/**
 * Set text model
 * @param {string} model - Model filename
 */
async function setTextModel(model) {
  selectedTextModel = model;
  const service = getLlamaService();
  if (service) {
    await service.updateConfig({ textModel: model });
  }
}

/**
 * Set vision model
 * @param {string} model - Model filename
 */
async function setVisionModel(model) {
  selectedVisionModel = model;
  const service = getLlamaService();
  if (service) {
    await service.updateConfig({ visionModel: model });
  }
}

/**
 * Set embedding model
 * @param {string} model - Model filename
 */
async function setEmbeddingModel(model) {
  selectedEmbeddingModel = model;
  const service = getLlamaService();
  if (service) {
    await service.updateConfig({ embeddingModel: model });
  }
}

// Helper to detect legacy Ollama model names
const isLegacyModelName = (/** @type {any} */ name) => {
  if (!name || typeof name !== 'string') return false;
  return !name.endsWith('.gguf') && (name.includes(':') || !name.includes('.'));
};

/**
 * Load configuration from settings
 */
async function loadLlamaConfig() {
  try {
    // Prefer the live LlamaService config first so logs and runtime use the same
    // selected models (avoids stale settings-only drift in long-lived sessions).
    const service = getLlamaService();
    if (service && typeof service.getConfig === 'function') {
      try {
        const liveConfig = await service.getConfig();
        if (liveConfig && typeof liveConfig === 'object') {
          selectedTextModel = liveConfig.textModel || selectedTextModel;
          selectedVisionModel = liveConfig.visionModel || selectedVisionModel;
          selectedEmbeddingModel = liveConfig.embeddingModel || selectedEmbeddingModel;

          logger.info('[LlamaUtils] Config loaded', {
            textModel: selectedTextModel,
            visionModel: selectedVisionModel,
            embeddingModel: selectedEmbeddingModel,
            source: 'llama-service'
          });

          _clearLlamaConfigStale();
          return {
            selectedTextModel,
            selectedVisionModel,
            selectedEmbeddingModel
          };
        }
      } catch (serviceError) {
        logger.debug(
          '[LlamaUtils] Could not read live LlamaService config, falling back to settings',
          {
            error: serviceError?.message
          }
        );
      }
    }

    const { getInstance: getSettings } = require('./services/SettingsService');
    const settings = getSettings();
    const allSettings = (await settings?.load?.()) || {};

    // Helper to resolve model name
    const resolveModel = (/** @type {any} */ configured, /** @type {any} */ defaultName) => {
      if (!configured) return defaultName;
      if (isLegacyModelName(configured)) return defaultName;
      return configured;
    };

    // Load model names from settings or use defaults
    selectedTextModel = resolveModel(
      allSettings.textModel,
      AI_DEFAULTS.TEXT?.MODEL ?? DEFAULT_AI_MODELS.TEXT_ANALYSIS
    );
    selectedVisionModel = resolveModel(
      allSettings.visionModel,
      AI_DEFAULTS.IMAGE?.MODEL ?? DEFAULT_AI_MODELS.IMAGE_ANALYSIS
    );
    selectedEmbeddingModel = resolveModel(
      allSettings.embeddingModel,
      AI_DEFAULTS.EMBEDDING?.MODEL ?? DEFAULT_AI_MODELS.EMBEDDING
    );

    logger.info('[LlamaUtils] Config loaded', {
      textModel: selectedTextModel,
      visionModel: selectedVisionModel,
      embeddingModel: selectedEmbeddingModel,
      source: 'settings'
    });

    _clearLlamaConfigStale();
    return {
      selectedTextModel,
      selectedVisionModel,
      selectedEmbeddingModel
    };
  } catch (error) {
    logger.warn('[LlamaUtils] Failed to load config:', error.message);
    _raiseLlamaConfigStale({ error: error?.message });
    return {
      selectedTextModel,
      selectedVisionModel,
      selectedEmbeddingModel
    };
  }
}

/**
 * Get embedding dimensions for current model
 * @returns {number}
 */
function getEmbeddingDimensions() {
  const selectedModel = getEmbeddingModel();
  const defaultDimension = AI_DEFAULTS.EMBEDDING?.DIMENSIONS || 768;
  return resolveEmbeddingDimension(selectedModel, { defaultDimension });
}

/**
 * Clean up resources
 */
async function cleanup() {
  // We do not manually shut it down here to avoid double-dispose issues.
  // This function is kept for backward compatibility with scripts.
  const service = getLlamaService();
  if (service && typeof service.shutdown === 'function') {
    // Only shut down if not managed by container (e.g. in standalone scripts)
    // But we can't easily tell. Safe to rely on container shutdown.
  }
}

// Backward compatibility aliases
const getLlamaModel = getTextModel;
const getLlamaVisionModel = getVisionModel;
const getLlamaEmbeddingModel = getEmbeddingModel;
const setLlamaModel = setTextModel;
const setLlamaVisionModel = setVisionModel;
const setLlamaEmbeddingModel = setEmbeddingModel;

/**
 * Degraded-state flag raised when analysis has to run on a different installed
 * text model than the configured one. Distinct from LlamaService's
 * `llama.auto-fallback.text`, which that service clears on the next direct
 * load; this one is cleared by LlamaService when the user picks a text model
 * explicitly (updateConfig without `autoFallback`).
 */
const TEXT_MODEL_SUBSTITUTED_FLAG = 'llama.text-model-substituted';

/**
 * @param {string} configuredModel
 * @param {string} fallbackModel
 */
function raiseTextModelSubstitutedFlag(configuredModel, fallbackModel) {
  try {
    const { getInstance: getDegradedStateTracker } = require('./services/DegradedStateTracker');
    getDegradedStateTracker().raise({
      code: TEXT_MODEL_SUBSTITUTED_FLAG,
      subsystem: 'llama',
      severity: 'warning',
      message: `Configured text model "${configuredModel}" is not installed. Analysis is using "${fallbackModel}" instead; pick a model in Settings → Models to clear this notice.`,
      detail: {
        errorCode: ERROR_CODES.LLAMA_MODEL_AUTO_FALLBACK,
        type: 'text',
        configuredModel,
        fallbackModel,
        source: 'analysis'
      }
    });
  } catch (err) {
    logger.debug('[LlamaUtils] Could not raise text-model substitution flag', {
      error: err?.message
    });
  }
}

/**
 * Ensure the text model is initialized and resolves to an installed GGUF file
 * before document/image analysis runs. Returns a user-facing error when models
 * are missing instead of a generic AI engine failure mid-inference.
 *
 * When the configured model is missing but another text model is installed,
 * the substitute is persisted as before so later loads find it, and a
 * degraded-state flag says so in the UI (audit row ML-06).
 *
 * @returns {Promise<{ ok: true, model: string } | { ok: false, error: string }>}
 */
async function ensureTextModelReadyForAnalysis() {
  const service = getLlamaService();
  if (!service) {
    return {
      ok: false,
      error: 'AI engine unavailable. Check Settings > Models and try again.'
    };
  }

  if (!service._initialized && typeof service.initialize === 'function') {
    try {
      await service.initialize();
    } catch (err) {
      return {
        ok: false,
        error: `AI engine failed to initialize: ${err?.message || String(err)}. Check Settings > Models.`
      };
    }
  }

  const cfg = (await service.getConfig?.()) || {};
  let textModel =
    cfg.textModel ||
    cfg.selectedTextModel ||
    AI_DEFAULTS.TEXT?.MODEL ||
    DEFAULT_AI_MODELS.TEXT_ANALYSIS;

  if (isLegacyModelName(textModel)) {
    textModel = AI_DEFAULTS.TEXT?.MODEL || DEFAULT_AI_MODELS.TEXT_ANALYSIS;
  }

  let modelNames = [];
  try {
    const models = await service.listModels();
    modelNames = (models || [])
      .map((/** @type {any} */ m) => String(m?.name || m?.filename || '').trim())
      .filter(Boolean);
  } catch (err) {
    return {
      ok: false,
      error: `Could not verify AI models: ${err?.message || String(err)}. Check Settings > Models.`
    };
  }

  /** On case-sensitive filesystems the configured basename must match the on-disk listing. */
  const resolveInstalledModelName = (/** @type {any} */ candidate) => {
    if (!candidate) return null;
    const lc = String(candidate).toLowerCase();
    return (
      modelNames.find(
        (/** @type {any} */ installed) => installed === candidate || installed.toLowerCase() === lc
      ) || null
    );
  };

  const matchesInstalled = (/** @type {any} */ candidate) =>
    Boolean(resolveInstalledModelName(candidate));

  const canonicalConfigured = resolveInstalledModelName(textModel);
  if (canonicalConfigured) {
    if (canonicalConfigured !== textModel && typeof service.updateConfig === 'function') {
      try {
        await service.updateConfig({ textModel: canonicalConfigured });
      } catch (err) {
        logger.warn('[LlamaUtils] Failed to persist canonical text model filename casing', {
          model: canonicalConfigured,
          error: err?.message
        });
      }
    }
    return { ok: true, model: canonicalConfigured };
  }

  if (!matchesInstalled(textModel)) {
    const configuredTextModel = textModel;
    const fallbacks = AI_DEFAULTS.TEXT?.FALLBACK_MODELS || [];
    const matchedFallbackEntry = fallbacks.find((candidate) => matchesInstalled(candidate));
    if (matchedFallbackEntry) {
      textModel = resolveInstalledModelName(matchedFallbackEntry) || matchedFallbackEntry;
    } else {
      let categorizeModel;
      try {
        ({ categorizeModel } = require('../shared/modelCategorization'));
      } catch {
        categorizeModel = null;
      }
      const installedTextModels =
        typeof categorizeModel === 'function'
          ? modelNames.filter((/** @type {any} */ name) => categorizeModel(name) === 'text')
          : [];
      if (installedTextModels.length > 0) {
        textModel = installedTextModels[0];
      } else {
        return {
          ok: false,
          error: `Text model "${textModel}" not downloaded. Download it in Settings > Models.`
        };
      }
    }

    raiseTextModelSubstitutedFlag(configuredTextModel, textModel);

    if (typeof service.updateConfig === 'function') {
      try {
        await service.updateConfig({ textModel }, { autoFallback: true });
      } catch (err) {
        logger.warn('[LlamaUtils] Failed to persist resolved text model for analysis', {
          textModel,
          error: err?.message
        });
      }
    }
  }

  return { ok: true, model: textModel };
}

module.exports = {
  // Primary exports
  getLlamaService,
  getTextModel,
  getVisionModel,
  getEmbeddingModel,
  setTextModel,
  setVisionModel,
  setEmbeddingModel,
  loadLlamaConfig,
  getEmbeddingDimensions,
  cleanup,
  ensureTextModelReadyForAnalysis,
  TEXT_MODEL_SUBSTITUTED_FLAG,

  // Aliases
  getLlamaModel,
  getLlamaVisionModel,
  getLlamaEmbeddingModel,
  setLlamaModel,
  setLlamaVisionModel,
  setLlamaEmbeddingModel
};
