// @ts-check
/** @typedef {import('../../shared/analysisSchema').AnalysisResult} AnalysisResult */
// Coerce a non-numeric confidence shape into a number on the caller's
// existing scale. Models routinely return numeric strings ("0.85"),
// percent strings ("85%"), or categorical tokens ("high"/"medium"/"low")
// — previously any non-number shape collapsed to the fallback (0), so
// the image-analysis path (which hand-parsed these) and the document
// path diverged for identical model output. We deliberately DO NOT
// rescale raw numbers: upstream callers (document LLM, image LLM, tests,
// DB rows) use both the 0-1 and 0-100 scales depending on the route,
// and silently normalizing would change confidence gates across the
// codebase. Categorical tokens map onto a normalized 0-1 value the
// caller's fallback scale tends to tolerate; numeric strings preserve
// the emitted magnitude so "85" stays "85" and "0.85" stays "0.85".
/** @param {unknown} value */
function _coerceConfidence(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return null;
    if (trimmed === 'high' || trimmed === 'very high') return 0.9;
    if (trimmed === 'medium' || trimmed === 'moderate') return 0.7;
    if (trimmed === 'low') return 0.4;
    if (trimmed === 'very low' || trimmed === 'none') return 0.2;
    const percentMatch = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
    if (percentMatch) {
      const pct = Number(percentMatch[1]);
      if (Number.isFinite(pct)) return pct;
    }
    const num = Number(trimmed);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

/**
 * @param {any} raw
 * @param {AnalysisResult} [fallback]
 * @returns {AnalysisResult}
 */
function normalizeAnalysisResult(raw, fallback = {}) {
  /** @type {AnalysisResult} */
  const result = raw && typeof raw === 'object' ? { ...raw } : {};
  const rawType = typeof result.type === 'string' ? result.type.trim() : '';
  const isGenericType = ['image', 'document', 'file', 'unknown'].includes(rawType.toLowerCase());
  const coercedConfidence = _coerceConfidence(result.confidence);
  const coercedFallback = _coerceConfidence(fallback.confidence);
  const normalized = {
    category:
      typeof result.category === 'string' && result.category.trim()
        ? result.category
        : fallback.category || 'document',
    keywords: Array.isArray(result.keywords) ? result.keywords : fallback.keywords || [],
    keyEntities: Array.isArray(result.keyEntities)
      ? result.keyEntities.filter(Boolean)
      : fallback.keyEntities || [],
    confidence:
      coercedConfidence !== null
        ? coercedConfidence
        : coercedFallback !== null
          ? coercedFallback
          : 0,
    suggestedName:
      typeof result.suggestedName === 'string'
        ? result.suggestedName
        : fallback.suggestedName || null,
    extractionMethod: result.extractionMethod || fallback.extractionMethod || null,
    contentLength:
      typeof result.contentLength === 'number'
        ? result.contentLength
        : fallback.contentLength || null,
    documentType:
      typeof result.documentType === 'string' && result.documentType.trim()
        ? result.documentType
        : rawType && !isGenericType
          ? rawType
          : fallback.documentType || null,
    documentDate:
      typeof result.documentDate === 'string' && result.documentDate.trim()
        ? result.documentDate
        : typeof result.date === 'string' && result.date.trim()
          ? result.date
          : fallback.documentDate || null
  };
  return { ...result, ...normalized };
}

/**
 * Read the STRATOSORT_ANALYSIS_EMBEDDING_QUEUE_WAIT env flag in a single
 * canonical way. Three analysis modules (image, media, semanticFolderMatcher)
 * previously each had their own one-liner that re-read process.env and
 * lowercased the string — renaming the env var would have meant a triple
 * grep. Centralizing here so future renames touch one place.
 *
 * Off by default: BatchAnalysisService already backpressures on queue depth,
 * so the per-call wait is opt-in for diagnostic / replay scenarios.
 *
 * @returns {boolean}
 */
function isPipelineEmbeddingQueueWaitEnabled() {
  return (
    String(process.env.STRATOSORT_ANALYSIS_EMBEDDING_QUEUE_WAIT || '').toLowerCase() === 'true'
  );
}

module.exports = { normalizeAnalysisResult, isPipelineEmbeddingQueueWaitEnabled };
