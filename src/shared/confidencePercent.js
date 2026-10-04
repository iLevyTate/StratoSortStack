// @ts-check
/**
 * Normalize confidence and threshold values to a 0–100 integer percentage.
 * Shared by main-process watchers and renderer UI so scales stay consistent.
 */

/**
 * @param {number} value - Confidence on 0–1 or 0–100 scale
 * @returns {number} Integer 0–100
 */
function normalizeConfidencePercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  // Values in (0, 1] are treated as fractions; values > 1 are already percentages.
  const normalized = value > 1 ? value : value * 100;
  return Math.round(Math.min(100, Math.max(0, normalized)));
}

/**
 * @param {number} value - Threshold on 0–1 or 0–100 scale
 * @param {number} [fallback=75]
 * @returns {number} Integer 0–100
 */
function normalizeThresholdPercent(value, fallback = 75) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  if (value > 1) {
    return Math.round(Math.min(100, Math.max(0, value)));
  }
  return Math.round(Math.min(100, Math.max(0, value * 100)));
}

module.exports = {
  normalizeConfidencePercent,
  normalizeThresholdPercent
};
