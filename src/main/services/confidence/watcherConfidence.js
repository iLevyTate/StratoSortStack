// @ts-check
const { THRESHOLDS } = require('../../../shared/performanceConstants');

const DEFAULT_CONFIDENCE_PERCENT = THRESHOLDS.DEFAULT_CONFIDENCE_PERCENT || 70;
const FALLBACK_CONFIDENCE_PERCENT = 35;

function getPreferredConfidenceSource(/** @type {any} */ value) {
  if (!value || typeof value !== 'object') return {};

  if (value.analysis && typeof value.analysis === 'object') {
    return value.analysis;
  }

  if (typeof value.analysisConfidence === 'number' && !Number.isNaN(value.analysisConfidence)) {
    return {
      ...value,
      confidence: value.analysisConfidence
    };
  }

  return value;
}

/**
 * Clamp a numeric value into 0-100 (percentage scale).
 * @param {number} value
 * @param {number} fallback
 * @returns {number}
 */
function clampPercent(value, fallback = DEFAULT_CONFIDENCE_PERCENT) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Map a 0..1-ish similarity/score into a conservative 30..70 range.
 * This prevents vector similarity or heuristic scores from being shown as \"90% confidence\".
 * @param {number} value
 * @returns {number} 1-100
 */
function mapSimilarityToPercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return FALLBACK_CONFIDENCE_PERCENT;
  // Clamp to [0, 1] then map into [30, 70]
  const clamped = Math.min(1, Math.max(0, value));
  return clampPercent(30 + clamped * 40, FALLBACK_CONFIDENCE_PERCENT);
}

/**
 * Derive a simple, consistent confidence percentage for watcher flows.
 * - Accepts 0-1 or 0-100 inputs.
 * - Falls back to a minimal completeness-based score when missing.
 * @param {Record<string, any>} analysis
 * @returns {number} 1-100 integer percent
 */
function deriveWatcherConfidencePercent(analysis = {}) {
  const normalizedAnalysis = getPreferredConfidenceSource(analysis);

  // 1) Prefer explicit confidence if provided by analysis model
  const explicit = normalizedAnalysis.confidence;
  const hasError = Boolean(normalizedAnalysis.error);
  if (typeof explicit === 'number' && !Number.isNaN(explicit)) {
    // Treat a zero confidence without an error as "missing" to avoid 0% spam.
    if (explicit === 0 && !hasError) {
      // fall through to derived confidence
    } else {
      if (explicit >= 0 && explicit <= 1) {
        return clampPercent(explicit * 100, FALLBACK_CONFIDENCE_PERCENT);
      }
      return clampPercent(explicit, FALLBACK_CONFIDENCE_PERCENT);
    }
  }

  // 2) Similarity/score are not true \"confidence\"; keep conservative to avoid misleading 90% values
  const similarityLike = normalizedAnalysis.similarity ?? normalizedAnalysis.score ?? null;
  if (typeof similarityLike === 'number' && !Number.isNaN(similarityLike)) {
    if (similarityLike >= 0 && similarityLike <= 1) return mapSimilarityToPercent(similarityLike);
    // If a caller provides an already-percentage score, still cap it at 70 by mapping.
    return clampPercent(Math.min(70, similarityLike), FALLBACK_CONFIDENCE_PERCENT);
  }

  // Lightweight completeness-based fallback
  const hasCategory = Boolean(normalizedAnalysis.category);
  const hasFolder =
    Boolean(normalizedAnalysis.smartFolder) ||
    Boolean(normalizedAnalysis.folder) ||
    Boolean(normalizedAnalysis.suggestedFolder);
  const hasSummaryOrKeywords =
    (typeof normalizedAnalysis.summary === 'string' &&
      normalizedAnalysis.summary.trim().length >= 60) ||
    (Array.isArray(normalizedAnalysis.keywords) && normalizedAnalysis.keywords.length >= 3);
  const hasSuggestedName = Boolean(normalizedAnalysis.suggestedName);

  const signalCount = [hasCategory, hasFolder, hasSummaryOrKeywords, hasSuggestedName].filter(
    Boolean
  ).length;
  // Keep derived confidence low enough to trigger \"low confidence\" UX by default.
  // Completeness should never be reported as \"high confidence\".
  const derived = FALLBACK_CONFIDENCE_PERCENT + signalCount * 5; // 35..55

  return clampPercent(derived, FALLBACK_CONFIDENCE_PERCENT);
}

module.exports = {
  deriveWatcherConfidencePercent,
  DEFAULT_CONFIDENCE_PERCENT
};
