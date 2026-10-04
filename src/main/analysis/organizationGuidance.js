// @ts-check
/**
 * Global "how to organize" instructions.
 *
 * A single free-text field the user sets in Settings that is injected into every
 * organization prompt (document + image analysis and alternative suggestions) so
 * the model follows the user's own organizing rules. Distinct from per-folder
 * descriptions (which describe one folder); this is workspace-wide guidance.
 *
 * @module analysis/organizationGuidance
 */

const { getInstance: getSettingsService } = require('../services/SettingsService');

/** Hard cap mirrored from settingsValidation (organizationCustomGuidance.maxLength). */
const MAX_GUIDANCE_CHARS = 2048;

/**
 * Read the user's global organization guidance. Returns '' when unset or on any
 * error. Backed by SettingsService's short TTL cache, so calling it per-file
 * during a batch is cheap.
 *
 * @returns {Promise<string>}
 */
async function getOrganizationGuidance() {
  try {
    const svc = typeof getSettingsService === 'function' ? getSettingsService() : null;
    if (!svc || typeof svc.load !== 'function') return '';
    const settings = await svc.load();
    const raw = settings?.organizationCustomGuidance;
    if (typeof raw !== 'string') return '';
    return raw.trim().slice(0, MAX_GUIDANCE_CHARS);
  } catch {
    return '';
  }
}

/**
 * Format the guidance as a prompt block, or '' when empty. Kept identical across
 * the analysis and suggestion prompts so the model sees consistent instructions.
 *
 * @param {string} guidance
 * @returns {string}
 */
function formatOrganizationGuidanceBlock(guidance) {
  const g = String(guidance || '').trim();
  if (!g) return '';
  return (
    `\n\nUSER ORGANIZATION INSTRUCTIONS (apply when choosing the folder/category, ` +
    `but never invent a folder that is not in the list above):\n${g}`
  );
}

module.exports = {
  getOrganizationGuidance,
  formatOrganizationGuidanceBlock,
  MAX_GUIDANCE_CHARS
};
