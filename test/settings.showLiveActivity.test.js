/**
 * showLiveActivity: the on/off switch for the Live Activity panel, registered
 * on all four settings surfaces like other boolean settings
 * (test/settings-keyset-parity.test.js explains why all four must agree).
 */
const { DEFAULT_SETTINGS } = require('../src/shared/defaultSettings');
const {
  VALIDATION_RULES,
  validateSettings,
  sanitizeSettings
} = require('../src/shared/settingsValidation');
const { SETTINGS_VALIDATION } = require('../src/shared/securityConfig');
const { settingsSchema } = require('../src/main/ipc/validationSchemas');

describe('showLiveActivity setting', () => {
  test('defaults to off', () => {
    expect(DEFAULT_SETTINGS.showLiveActivity).toBe(false);
  });

  test('is on the settings import allowlist', () => {
    expect(new Set(SETTINGS_VALIDATION.allowedKeys).has('showLiveActivity')).toBe(true);
  });

  test('validates as an optional boolean', () => {
    expect(VALIDATION_RULES.showLiveActivity).toEqual({ type: 'boolean', required: false });
    expect(validateSettings({ showLiveActivity: true }).valid).toBe(true);
    expect(validateSettings({ showLiveActivity: false }).valid).toBe(true);
    expect(validateSettings({ showLiveActivity: 'yes' }).valid).toBe(false);
  });

  test('the settings:save schema accepts booleans and rejects strings', () => {
    expect(settingsSchema.safeParse({ showLiveActivity: true }).success).toBe(true);
    expect(settingsSchema.safeParse({ showLiveActivity: null }).success).toBe(true);
    expect(settingsSchema.safeParse({ showLiveActivity: 'yes' }).success).toBe(false);
  });

  // Load and backup restore run sanitizeSettings; a non-boolean must be
  // handled exactly as for the sibling boolean captionVideoKeyframes.
  test.each([true, 'yes', 1, null])(
    'sanitizeSettings treats %p the same as captionVideoKeyframes',
    (value) => {
      const own = sanitizeSettings({ showLiveActivity: value });
      const sibling = sanitizeSettings({ captionVideoKeyframes: value });
      expect(Object.hasOwn(own, 'showLiveActivity')).toBe(
        Object.hasOwn(sibling, 'captionVideoKeyframes')
      );
      expect(own.showLiveActivity).toEqual(sibling.captionVideoKeyframes);
    }
  );
});
