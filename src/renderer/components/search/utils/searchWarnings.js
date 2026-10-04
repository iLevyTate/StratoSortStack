// @ts-check
/**
 * Search warning normalization + severity ordering.
 *
 * Shared between UnifiedSearchModal (which normalizes warnings when storing
 * them in searchMeta) and SearchDiagnosticsBanner (which renders the top
 * few). Lives in `utils/` to keep both consumers free of the dependency on
 * the modal's internal helpers.
 */

/** @type {Readonly<Record<string, number>>} */
const WARNING_SEVERITY_ORDER = Object.freeze({
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
});

const normalizeSearchWarnings = (/** @type {any} */ warnings) => {
  if (!Array.isArray(warnings) || warnings.length === 0) return [];
  return warnings
    .filter((warning) => warning && typeof warning === 'object' && warning.message)
    .map((warning) => ({
      type: String(warning.type || 'warning'),
      severity: String(warning.severity || 'low').toLowerCase(),
      message: String(warning.message || '').trim()
    }))
    .filter((warning) => warning.message.length > 0)
    .sort((a, b) => {
      const aRank = WARNING_SEVERITY_ORDER[a.severity] ?? 99;
      const bRank = WARNING_SEVERITY_ORDER[b.severity] ?? 99;
      if (aRank !== bRank) return aRank - bRank;
      return a.message.localeCompare(b.message);
    });
};

module.exports = {
  WARNING_SEVERITY_ORDER,
  normalizeSearchWarnings
};
