// @ts-check
const EXPERIENCE_MODES = Object.freeze({
  SIMPLE: 'simple',
  ADVANCED: 'advanced'
});

const EXPERIENCE_MODE_VALUES = Object.freeze(Object.values(EXPERIENCE_MODES));

/**
 * Values applied silently when a user selects Simple mode.
 *
 * **Design intent (changed 2026-04):** Simple mode is now a UI simplification,
 * NOT a feature downgrade. We keep all the recommended embedding / graph /
 * chunking features enabled in the background so a user who later switches to
 * Advanced does NOT have to re-process every file they already analyzed in
 * Simple. Previously these were set to `'skip'` / `false` to avoid surprising
 * the user with background work, but the consequence was that every Simple-mode
 * analysis produced files with no embeddings — search, graph expansion, and
 * chunk context all silently failed on those files until the user manually
 * re-analyzed them after switching to Advanced.
 *
 * The mode toggle only controls UI visibility of the Advanced-only sections;
 * a user's non-recommended Advanced choices are parked while Simple is on
 * and restored on the way back (carryAdvancedValuesAcrossModeSwitch).
 */
const SIMPLE_MODE_ENFORCED_VALUES = Object.freeze({
  defaultEmbeddingPolicy: 'embed',
  embeddingTiming: 'during_analysis',
  autoChunkOnAnalysis: true,
  graphExpansionEnabled: true,
  chunkContextEnabled: true
});

/**
 * Legacy Simple-mode values (pre-2026-04). Used by the one-time schema-v3
 * migration (SettingsMigrator) that flips existing Simple-mode users to the
 * new recommended defaults — without this, users who installed the app before
 * the inversion would keep their stored `'skip'` / `'manual'` / `false`
 * values and never benefit from background embedding even though they're on
 * the new code.
 */
const LEGACY_SIMPLE_MODE_VALUES = Object.freeze({
  defaultEmbeddingPolicy: 'skip',
  embeddingTiming: 'manual',
  autoChunkOnAnalysis: false,
  graphExpansionEnabled: false,
  chunkContextEnabled: false
});

/**
 * @param {string} value
 * @param {string} [fallback]
 * @returns {string}
 */
function normalizeExperienceMode(value, fallback = EXPERIENCE_MODES.SIMPLE) {
  return EXPERIENCE_MODE_VALUES.includes(/** @type {'simple'|'advanced'} */ (value))
    ? value
    : fallback;
}

/**
 * @param {string|Record<string,unknown>} settingsOrMode
 * @returns {boolean}
 */
function isSimpleExperienceMode(settingsOrMode) {
  const mode =
    settingsOrMode && typeof settingsOrMode === 'object'
      ? /** @type {Record<string,unknown>} */ (settingsOrMode).experienceMode
      : settingsOrMode;

  return normalizeExperienceMode(/** @type {string} */ (mode)) === EXPERIENCE_MODES.SIMPLE;
}

/**
 * Apply mode-specific settings invariants.
 *
 * Both Simple and Advanced modes now share the same recommended defaults for
 * embedding/graph/chunk features (see SIMPLE_MODE_ENFORCED_VALUES). The mode
 * field only controls UI exposure, not feature behavior — with one exception:
 * selecting Simple mode re-applies the recommended values, because the
 * affected controls are hidden in Simple mode and an invisible non-default
 * state would be impossible for the user to diagnose. Advanced mode never
 * touches user values.
 *
 * Note: this function intentionally does NOT migrate legacy pre-2026-04
 * values. Doing that here (on every save/load) made deliberate Advanced-mode
 * choices of `'skip'` / `'manual'` / `false` impossible — they were silently
 * reverted on the next save. The legacy flip is a one-time schema-v3 step in
 * SettingsMigrator (see `upgradeLegacySimpleModeValues`).
 *
 * @param {Record<string,unknown>} settings
 * @returns {Record<string,unknown>}
 */
function applyExperienceModeSettings(settings) {
  const normalized = /** @type {Record<string,unknown>} */ ({
    ...(settings && typeof settings === 'object' ? settings : {})
  });
  const experienceMode = normalizeExperienceMode(/** @type {string} */ (normalized.experienceMode));

  normalized.experienceMode = experienceMode;

  if (experienceMode === EXPERIENCE_MODES.SIMPLE) {
    Object.assign(normalized, SIMPLE_MODE_ENFORCED_VALUES);
  }

  return normalized;
}

/**
 * Carry the user's Advanced-mode choices across a Simple/Advanced switch.
 *
 * Simple mode enforces SIMPLE_MODE_ENFORCED_VALUES over controls it hides, so
 * a user who had chosen `skip`, `manual` or chunks-off in Advanced lost those
 * choices the moment they clicked Simple, and switching back restored
 * nothing (audit row ST-08). This pairs the two transitions:
 *
 * - Advanced → Simple: the previous values that differ from the enforced
 *   ones are parked in `advancedModeValues` (a stash already present on
 *   `next`, e.g. from the renderer mirroring this step, wins).
 * - Simple → Advanced: the parked values are put back and the stash is set
 *   to null. A parked value replaces only a key that still holds the
 *   Simple-enforced value: that is what the renderer's toggle sends, while
 *   an imported Advanced export carries explicit choices of its own, and
 *   those are the user's, not this machine's old stash.
 *
 * No transition: `next` is returned unchanged (same reference). Callers run
 * `applyExperienceModeSettings` on the result as before.
 *
 * @param {Record<string,unknown>|null|undefined} previous settings before the change
 * @param {Record<string,unknown>} next settings after the change (mode already set)
 * @returns {Record<string,unknown>}
 */
function carryAdvancedValuesAcrossModeSwitch(previous, next) {
  if (!next || typeof next !== 'object') return next;
  const prevMode = normalizeExperienceMode(
    /** @type {string} */ (previous && typeof previous === 'object' ? previous.experienceMode : '')
  );
  const nextMode = normalizeExperienceMode(/** @type {string} */ (next.experienceMode));
  if (prevMode === nextMode || !previous || typeof previous !== 'object') return next;

  const result = { ...next };
  if (nextMode === EXPERIENCE_MODES.SIMPLE) {
    /** @type {Record<string,unknown>} */
    const parked = {};
    const provided = next.advancedModeValues;
    if (provided && typeof provided === 'object' && !Array.isArray(provided)) {
      Object.assign(parked, provided);
    } else {
      for (const key of Object.keys(SIMPLE_MODE_ENFORCED_VALUES)) {
        const value = previous[key];
        if (
          value !== undefined &&
          value !==
            SIMPLE_MODE_ENFORCED_VALUES[
              /** @type {keyof typeof SIMPLE_MODE_ENFORCED_VALUES} */ (key)
            ]
        ) {
          parked[key] = value;
        }
      }
    }
    // Null rather than absent: the loaded shape carries the key (default
    // null), and an explicit null lets a renderer merge clear a stale stash.
    result.advancedModeValues = Object.keys(parked).length > 0 ? parked : null;
    return result;
  }

  const parked = previous.advancedModeValues ?? next.advancedModeValues;
  if (parked && typeof parked === 'object' && !Array.isArray(parked)) {
    for (const key of Object.keys(SIMPLE_MODE_ENFORCED_VALUES)) {
      if (!Object.prototype.hasOwnProperty.call(parked, key)) continue;
      const enforced =
        SIMPLE_MODE_ENFORCED_VALUES[/** @type {keyof typeof SIMPLE_MODE_ENFORCED_VALUES} */ (key)];
      const incoming = next[key];
      if (incoming === undefined || incoming === enforced) {
        result[key] = /** @type {Record<string,unknown>} */ (parked)[key];
      }
    }
  }
  result.advancedModeValues = null;
  return result;
}

/**
 * One-time legacy migration (pre-2026-04 → recommended values), applied by
 * SettingsMigrator when upgrading a settings file below schema v3. Flips a
 * key only when it exactly matches the legacy Simple-mode value; deliberate
 * non-legacy choices (e.g. `defaultEmbeddingPolicy: 'web_only'`) are kept.
 *
 * @param {Record<string,unknown>} settings - mutated in place
 * @returns {string[]} keys that were upgraded
 */
function upgradeLegacySimpleModeValues(settings) {
  /** @type {string[]} */
  const upgradedKeys = [];
  if (!settings || typeof settings !== 'object') return upgradedKeys;

  for (const key of /** @type {(keyof typeof LEGACY_SIMPLE_MODE_VALUES)[]} */ (
    Object.keys(LEGACY_SIMPLE_MODE_VALUES)
  )) {
    if (settings[key] === LEGACY_SIMPLE_MODE_VALUES[key]) {
      settings[key] = SIMPLE_MODE_ENFORCED_VALUES[key];
      upgradedKeys.push(key);
    }
  }
  return upgradedKeys;
}

/**
 * Effective auto-chunking flag AFTER experience-mode enforcement. Decide
 * "build chunk vectors?" from this, never from the mode name: Simple mode
 * enforces `autoChunkOnAnalysis: true`, so a mode-name check silently
 * dropped chunk vectors for every default install (F-192 / CP-12).
 *
 * @param {Record<string,unknown>|null|undefined} settings
 * @returns {boolean}
 */
function isAutoChunkEnabled(settings) {
  if (!settings || typeof settings !== 'object') return true;
  return applyExperienceModeSettings(settings).autoChunkOnAnalysis !== false;
}

module.exports = {
  EXPERIENCE_MODES,
  EXPERIENCE_MODE_VALUES,
  SIMPLE_MODE_ENFORCED_VALUES,
  LEGACY_SIMPLE_MODE_VALUES,
  normalizeExperienceMode,
  isSimpleExperienceMode,
  isAutoChunkEnabled,
  applyExperienceModeSettings,
  carryAdvancedValuesAcrossModeSwitch,
  upgradeLegacySimpleModeValues
};
