// @ts-check
'use strict';

/**
 * Helpers for stamping the AI provider id onto an analysis result.
 *
 * Used by `_analyzeWithProvider` in documentAnalysis.js so that the renderer
 * can surface a per-row indicator showing whether a file was processed
 * locally or in the cloud. Kept as a separate module so the logic is
 * unit-testable without booting the full analysis pipeline.
 *
 * Prefer `result.provider` from documentLlm when present — it reflects the
 * provider that actually served inference (including cloud→local fallback).
 * This helper is the fallback when that field is absent.
 */

function resolveProviderIdFromRouter(
  /** @type {any} */ router,
  /** @type {any} */ smartFolderId = null
) {
  if (!router) return 'local';
  // Prefer the side-effect-free preview when available (router was extended
  // to expose previewChoiceId so stamping doesn't produce duplicate warnings
  // for every analyzed file in a folder with an unavailable override).
  if (typeof router.previewChoiceId === 'function') {
    return router.previewChoiceId({ operation: 'analyze', smartFolderId }) || 'local';
  }
  if (typeof router.choose !== 'function') return 'local';
  try {
    const chosen = router.choose({ operation: 'analyze', smartFolderId });
    return chosen?.id || 'local';
  } catch {
    return 'local';
  }
}

function stampAnalysisProvider(/** @type {any} */ analysis, /** @type {any} */ providerId) {
  if (!analysis || typeof analysis !== 'object') return analysis;
  if (analysis.error) return analysis;
  if (!providerId) return analysis;
  analysis.provider = providerId;
  return analysis;
}

/**
 * True when document analysis goes to a cloud provider (the active router's
 * side-effect-free preview for 'analyze' names one other than local). The
 * local text model then does no document work, so it need not be loaded or
 * limit concurrency. False when there is no router or on any doubt.
 * @returns {boolean}
 */
function isDocumentAnalysisRemote() {
  try {
    // Lazy: aiProvider requires the services tree.
    const aiProvider = require('../ipc/aiProvider');
    const router = aiProvider.getActiveAiRouter ? aiProvider.getActiveAiRouter() : null;
    if (typeof router?.previewChoiceId !== 'function') return false;
    const providerId = router.previewChoiceId({ operation: 'analyze' });
    return Boolean(providerId) && providerId !== 'local';
  } catch {
    return false;
  }
}

module.exports = {
  resolveProviderIdFromRouter,
  stampAnalysisProvider,
  isDocumentAnalysisRemote
};
