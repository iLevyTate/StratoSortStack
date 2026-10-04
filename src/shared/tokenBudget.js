// @ts-check
/**
 * Clamp requested LLM output tokens to remaining context.
 * Must be monotonic in `requestedMaxTokens`. An unknown context size
 * (non-finite or non-positive) cannot bound anything, so the request passes
 * through unchanged rather than degrading to NaN.
 * @param {number} requestedMaxTokens
 * @param {number} effectiveContextSize
 * @param {number} [promptLength]
 * @returns {number}
 */
function clampOutputTokens(requestedMaxTokens, effectiveContextSize, promptLength = 0) {
  const TEMPLATE_OVERHEAD_TOKENS = 64;
  const ctx = Number(effectiveContextSize);
  if (!Number.isFinite(ctx) || ctx <= 0) return requestedMaxTokens;
  const promptTokens = Math.max(0, Math.ceil(Number(promptLength) / 4) || 0);
  const remaining = ctx - promptTokens - TEMPLATE_OVERHEAD_TOKENS;
  return Math.min(requestedMaxTokens, Math.max(128, remaining));
}

module.exports = { clampOutputTokens };
