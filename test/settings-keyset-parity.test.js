/**
 * Settings keyset parity guard.
 *
 * Settings flow through four independent surfaces that must agree, or keys get
 * silently dropped (the root cause of the downloadsTriageExclusions / chat
 * persona / ai persistence bugs):
 *
 *   - DEFAULT_SETTINGS         (shared/defaultSettings.js)        -> stamped defaults
 *   - VALIDATION_RULES         (shared/settingsValidation.js)     -> the real save/load gate
 *   - settingsSchema (Zod)     (main/ipc/validationSchemas.js)    -> the settings:save IPC gate
 *   - allowedKeys              (shared/securityConfig.js)         -> the import allowlist
 *
 * This test fails fast if a future change adds a key to one surface but forgets
 * the others. Keep it green rather than expanding EXEMPT_FROM_DEFAULTS unless a
 * key is genuinely owned by a subsystem that seeds its own default.
 */

const { DEFAULT_SETTINGS } = require('../src/shared/defaultSettings');
const { VALIDATION_RULES } = require('../src/shared/settingsValidation');
const { SETTINGS_VALIDATION } = require('../src/shared/securityConfig');
const { settingsSchema } = require('../src/main/ipc/validationSchemas');

// Keys that are intentionally validated/allowlisted/schema'd but do NOT carry a
// flat default in DEFAULT_SETTINGS because a subsystem owns and seeds them.
//   - `ai`: the AI provider subsystem builds its default blob via
//     aiProvider._defaultAiSettings() and validates it against
//     main/services/ai/schemas.aiSettingsSchema at the AI_PROVIDER.* boundary.
const EXEMPT_FROM_DEFAULTS = new Set(['ai']);

const ruleKeys = new Set(Object.keys(VALIDATION_RULES));
const allowedKeys = new Set(SETTINGS_VALIDATION.allowedKeys);
const zodKeys = new Set(Object.keys(settingsSchema.shape || {}));
const defaultKeys = new Set(Object.keys(DEFAULT_SETTINGS));

const diff = (a, b) => [...a].filter((k) => !b.has(k)).sort();

describe('settings keyset parity', () => {
  test('VALIDATION_RULES and the import allowlist cover the same keys', () => {
    expect({
      inRulesNotAllowed: diff(ruleKeys, allowedKeys),
      inAllowedNotRules: diff(allowedKeys, ruleKeys)
    }).toEqual({ inRulesNotAllowed: [], inAllowedNotRules: [] });
  });

  test('VALIDATION_RULES and the Zod settings schema cover the same keys', () => {
    expect({
      inRulesNotZod: diff(ruleKeys, zodKeys),
      inZodNotRules: diff(zodKeys, ruleKeys)
    }).toEqual({ inRulesNotZod: [], inZodNotRules: [] });
  });

  test('every validated key has a default (except subsystem-owned exemptions)', () => {
    const missingDefaults = [...ruleKeys].filter(
      (k) => !defaultKeys.has(k) && !EXEMPT_FROM_DEFAULTS.has(k)
    );
    expect(missingDefaults.sort()).toEqual([]);
  });

  test('every default key is validated (no orphan defaults)', () => {
    expect(diff(defaultKeys, ruleKeys)).toEqual([]);
  });
});
