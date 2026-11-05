'use strict';
const {
  CLOUD_CONSENT_VERSION,
  hasCloudConsent,
  hasCloudFrameConsent
} = require('../../../src/main/services/ai/schemas');
const {
  defaultAiSettings,
  mergeAiSettings,
  sanitizeAiSettings,
  validateAiSettingsForSave
} = require('../../../src/main/services/ai/aiSettings');
const { AIRouter } = require('../../../src/main/services/ai/AIRouter');

const LEGACY_CONSENT = { acknowledgedCloudAt: '2024-01-01T00:00:00.000Z' };
const CURRENT_CONSENT = { acknowledgedCloudAt: '2024-01-01T00:00:00.000Z', version: 2 };

describe('cloud consent version', () => {
  test('the current version is the one that covers video frames', () => {
    expect(CLOUD_CONSENT_VERSION).toBe(2);
  });

  test('consent saved before versions existed still covers text work but not video frames', () => {
    const settings = { consent: LEGACY_CONSENT };
    expect(hasCloudConsent(settings)).toBe(true);
    expect(hasCloudFrameConsent(settings)).toBe(false);
  });

  test('consent at the current version covers video frames', () => {
    expect(hasCloudFrameConsent({ consent: CURRENT_CONSENT })).toBe(true);
  });

  test('a version without a valid timestamp is not consent', () => {
    expect(hasCloudFrameConsent({ consent: { version: 2 } })).toBe(false);
    expect(
      hasCloudFrameConsent({
        consent: { acknowledgedCloudAt: '2999-01-01T00:00:00.000Z', version: 2 }
      })
    ).toBe(false);
  });

  test('settings.json keeps a valid version and drops a malformed one', () => {
    const kept = sanitizeAiSettings(
      mergeAiSettings(defaultAiSettings(), { consent: CURRENT_CONSENT })
    );
    expect(kept.settings.consent).toEqual(CURRENT_CONSENT);

    const dropped = sanitizeAiSettings(
      mergeAiSettings(defaultAiSettings(), { consent: { ...LEGACY_CONSENT, version: 'two' } })
    );
    expect(dropped.settings.consent.version).toBeUndefined();
    expect(hasCloudFrameConsent(dropped.settings)).toBe(false);
  });

  test('a whole-settings save cannot raise the stored consent version', () => {
    const stored = mergeAiSettings(defaultAiSettings(), { consent: LEGACY_CONSENT });
    const result = validateAiSettingsForSave({ ...stored, consent: CURRENT_CONSENT }, stored);
    expect(result.ok).toBe(true);
    expect(result.ok && result.ai.consent).toEqual(LEGACY_CONSENT);
  });

  test('AIRouter.hasFrameConsent reads the stored consent fresh on each call', () => {
    let settings = { consent: LEGACY_CONSENT, providers: {}, routing: { default: 'local' } };
    const router = new AIRouter({ providers: {}, getSettings: () => settings });
    expect(router.hasFrameConsent()).toBe(false);
    settings = { ...settings, consent: CURRENT_CONSENT };
    expect(router.hasFrameConsent()).toBe(true);
  });
});
