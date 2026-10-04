// @ts-check
/**
 * Feature Flags
 * Granular toggles for enabling/disabling features across the application.
 *
 * Usage:
 *   const { GRAPH_FEATURE_FLAGS } = require('../shared/featureFlags');
 *   if (GRAPH_FEATURE_FLAGS.SHOW_GRAPH) { ... }
 */

/** @param {string} key @param {boolean} fallback @returns {boolean} */
const readEnvFlag = (key, fallback) => {
  const rawValue = typeof process !== 'undefined' ? process.env?.[key] : undefined;
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(rawValue).trim().toLowerCase());
};

// Graph Visualization Feature Flags
const GRAPH_FEATURE_FLAGS = {
  SHOW_GRAPH: readEnvFlag('STRATOSORT_GRAPH_ENABLED', true) // Master toggle
};

/**
 * Graph/Atlas tabs are always available regardless of experience mode; simple
 * mode softens the in-tab experience instead of hiding the entry points.
 * @param {{developerGraphEnabled?: boolean}|null|undefined} settings
 * @returns {boolean}
 */
function isGraphViewEnabled(settings) {
  // The Settings switch ("Enable graph view") is honored in every build. It
  // used to be development-only, which made the shipped switch a no-op.
  return GRAPH_FEATURE_FLAGS.SHOW_GRAPH && settings?.developerGraphEnabled !== false;
}

module.exports = {
  GRAPH_FEATURE_FLAGS,
  isGraphViewEnabled
};
