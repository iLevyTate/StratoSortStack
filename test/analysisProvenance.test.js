/**
 * F-195 (K-06): which analyses are "provisional" (fallback-only) and which
 * of those are worth retrying once a missing capability (model) appears.
 * One shared truth table, used by the history writer, the watcher's
 * needs-analysis check and the startup knowledge repair.
 */
const {
  isFallbackAnalysis,
  isCapabilityFallback,
  PROVISIONAL_MAX_RETRIES
} = require('../src/shared/analysisProvenance');

describe('analysisProvenance', () => {
  test.each([
    ['explicit _isFallback', { _isFallback: true }, true],
    ['explicit isFallback', { isFallback: true }, true],
    ['error category (watcher gave up)', { category: 'error' }, true],
    ['filename fallback', { extractionMethod: 'filename_fallback' }, true],
    ['extension fallback', { extractionMethod: 'extension_fallback' }, true],
    ['bare filename', { extractionMethod: 'filename' }, true],
    ['failed', { extractionMethod: 'failed' }, true],
    ['pdf with no text layer', { extractionMethod: 'pdf_no_text' }, true],
    [
      'content fallback (LLM failed after extraction)',
      { extractionMethod: 'content_fallback' },
      true
    ],
    ['media skipped (no whisper)', { extractionMethod: 'media-skipped-no-whisper' }, true],
    ['extension short-circuit', { extractionMethod: 'extension_short_circuit' }, true],
    ['no reader for the format in this build', { extractionMethod: 'format_unsupported' }, true],
    ['real content analysis', { extractionMethod: 'content', category: 'Finance' }, false],
    ['no method at all', { category: 'Finance' }, false],
    ['nothing', null, false]
  ])('isFallbackAnalysis: %s', (_label, analysis, expected) => {
    expect(isFallbackAnalysis(analysis)).toBe(expected);
  });

  test.each([
    ['model missing (filename fallback)', { extractionMethod: 'filename_fallback' }, true],
    [
      'LLM failed after extraction',
      { extractionMethod: 'content_fallback', fallbackReason: 'ai_analysis_failed' },
      true
    ],
    [
      'reason names the model',
      { _isFallback: true, fallbackReason: 'text model not available' },
      true
    ],
    ['whisper missing', { extractionMethod: 'media-skipped-no-whisper' }, true],
    ['watcher gave up after retries', { category: 'error' }, true],
    ['pdf has no text — a new model will not help', { extractionMethod: 'pdf_no_text' }, false],
    [
      'extension short-circuit is a policy, not a gap',
      { extractionMethod: 'extension_short_circuit' },
      false
    ],
    [
      'a format this build cannot read (BIFF .xls, undecodable HEIC, encrypted .doc) is not a model gap',
      { extractionMethod: 'format_unsupported', fallbackReason: 'no reader in this build' },
      false
    ],
    ['real analysis', { extractionMethod: 'content' }, false]
  ])('isCapabilityFallback: %s', (_label, analysis, expected) => {
    expect(isCapabilityFallback(analysis)).toBe(expected);
  });

  test('retry budget is small and positive', () => {
    expect(PROVISIONAL_MAX_RETRIES).toBeGreaterThan(0);
    expect(PROVISIONAL_MAX_RETRIES).toBeLessThanOrEqual(3);
  });
});
