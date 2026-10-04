// @ts-check
/**
 * Shared numeric parsing helpers used by IPC, workers, and services.
 */

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function parsePositiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toPercentNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, numeric));
}

/**
 * @param {unknown} value
 * @param {number} [fallback=0]
 * @returns {number}
 */
function toFiniteNonNegativeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

module.exports = {
  parsePositiveInt,
  toPercentNumber,
  toFiniteNonNegativeNumber
};
