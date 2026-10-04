// @ts-check
/**
 * Provenance of an analysis result: was it a real content analysis, or a
 * fallback the pipeline produced because something was missing?
 *
 * One truth table for three consumers (F-195 / K-06):
 *  - the history writer stamps fallback results `provisional`;
 *  - the smart-folder watcher re-queues provisional entries once the missing
 *    capability appears (bounded by PROVISIONAL_MAX_RETRIES);
 *  - the startup knowledge repair never embeds them.
 */

/** Extraction methods that mean "no real content analysis happened". */
const FALLBACK_METHODS = Object.freeze(
  new Set([
    'filename_fallback',
    'extension_fallback',
    'filename',
    'failed',
    'pdf_no_text',
    'content_fallback',
    'media-skipped-no-whisper',
    'extension_short_circuit',
    // No reader for the format in this build (BIFF .xls, PPT97, a HEIC
    // without an HEVC decoder, a password-protected .doc): installing a
    // model changes nothing, so it is never retried as a capability gap.
    'format_unsupported'
  ])
);

/**
 * Fallbacks a newly installed / recovered model can fix. `pdf_no_text`,
 * `extension_short_circuit` and `format_unsupported` are content, policy or
 * build limitations — retrying them would loop forever (or, bounded by
 * PROVISIONAL_MAX_RETRIES, analyze every .xls three times for nothing).
 */
const CAPABILITY_FALLBACK_METHODS = Object.freeze(
  new Set([
    'filename_fallback',
    'extension_fallback',
    'filename',
    'failed',
    'content_fallback',
    'media-skipped-no-whisper'
  ])
);

const CAPABILITY_REASON_PATTERN =
  /model|llama|whisper|vision|unavailable|not (?:ready|available|installed|loaded)|ai_analysis_failed/i;

/** How many times a provisional entry is retried before it is left alone. */
const PROVISIONAL_MAX_RETRIES = 2;

/**
 * @param {Record<string, any> | null | undefined} analysis
 * @returns {boolean}
 */
function isFallbackAnalysis(analysis) {
  if (!analysis || typeof analysis !== 'object') return false;
  return (
    analysis._isFallback === true ||
    analysis.isFallback === true ||
    analysis.category === 'error' ||
    FALLBACK_METHODS.has(String(analysis.extractionMethod || ''))
  );
}

/**
 * @param {Record<string, any> | null | undefined} analysis
 * @returns {boolean}
 */
function isCapabilityFallback(analysis) {
  if (!isFallbackAnalysis(analysis)) return false;
  const method = String(analysis?.extractionMethod || '');
  if (CAPABILITY_FALLBACK_METHODS.has(method)) return true;
  if (method && FALLBACK_METHODS.has(method)) return false; // content/policy limitation
  if (analysis?.category === 'error') return true;
  return CAPABILITY_REASON_PATTERN.test(String(analysis?.fallbackReason || ''));
}

module.exports = {
  FALLBACK_METHODS,
  CAPABILITY_FALLBACK_METHODS,
  PROVISIONAL_MAX_RETRIES,
  isFallbackAnalysis,
  isCapabilityFallback
};
