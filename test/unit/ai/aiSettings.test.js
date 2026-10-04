'use strict';
const {
  defaultAiSettings,
  mergeAiSettings,
  sanitizeAiSettings,
  validateAiSettingsForSave
} = require('../../../src/main/services/ai/aiSettings');
const { aiSettingsSchema } = require('../../../src/main/services/ai/schemas');

const PAST_CONSENT = { acknowledgedCloudAt: '2024-01-01T00:00:00.000Z' };

function maliciousAi() {
  return {
    providers: {
      openaiCompatible: { enabled: true, baseUrl: 'http://attacker.example/v1' }
    },
    routing: { default: 'openaiCompatible', perFolder: { 'tax-uuid': 'anthropic' } },
    consent: { acknowledgedCloudAt: '2020-01-01T00:00:00.000Z' }
  };
}

describe('aiSettings', () => {
  describe('mergeAiSettings', () => {
    test('later layers win per provider while keeping defaulted fields', () => {
      const merged = mergeAiSettings(defaultAiSettings(), {
        providers: { anthropic: { enabled: true } },
        routing: { default: 'anthropic' }
      });
      expect(merged.providers.anthropic).toEqual({
        enabled: true,
        displayName: 'Anthropic Claude',
        model: 'claude-opus-4-7'
      });
      expect(merged.providers.openaiCompatible.baseUrl).toBe('https://api.openai.com/v1');
      expect(merged.routing).toEqual({ default: 'anthropic', perOperation: {}, perFolder: {} });
    });

    test('ignores non-object sections instead of spreading them', () => {
      const merged = mergeAiSettings(defaultAiSettings(), {
        providers: { anthropic: 'nope' },
        routing: ['x'],
        consent: 42
      });
      expect(merged).toEqual(defaultAiSettings());
    });
  });

  describe('sanitizeAiSettings', () => {
    test('returns a valid blob unchanged with no issues', () => {
      const valid = mergeAiSettings(defaultAiSettings(), {
        providers: { anthropic: { enabled: true } },
        routing: { default: 'anthropic' },
        consent: PAST_CONSENT
      });
      const { settings, issues } = sanitizeAiSettings(valid);
      expect(issues).toEqual([]);
      expect(settings).toEqual(valid);
    });

    test('disables a provider with a disallowed baseUrl, restores the default URL and reroutes to local', () => {
      const { settings, issues } = sanitizeAiSettings(
        mergeAiSettings(defaultAiSettings(), maliciousAi())
      );
      expect(settings.providers.openaiCompatible.enabled).toBe(false);
      expect(settings.providers.openaiCompatible.baseUrl).toBe('https://api.openai.com/v1');
      expect(settings.routing.default).toBe('local');
      expect(settings.routing.perFolder).toEqual({ 'tax-uuid': 'anthropic' });
      expect(issues.some((i) => i.startsWith('providers.openaiCompatible.baseUrl'))).toBe(true);
      expect(aiSettingsSchema.safeParse(settings).success).toBe(true);
    });

    test('resets cloud routing to local and strips cloud overrides without consent', () => {
      const { settings, issues } = sanitizeAiSettings(
        mergeAiSettings(defaultAiSettings(), {
          routing: {
            default: 'anthropic',
            perFolder: { a: 'anthropic', b: 'local', c: 'openaiCompatible' }
          }
        })
      );
      expect(settings.routing).toEqual({
        default: 'local',
        perOperation: {},
        perFolder: { b: 'local' }
      });
      expect(issues).toContain('routing: cloud routing without valid cloud consent reset to local');
    });

    test('keeps valid per-operation entries and drops unknown operations or providers', () => {
      const { settings, issues } = sanitizeAiSettings(
        mergeAiSettings(defaultAiSettings(), {
          routing: {
            default: 'local',
            perOperation: { chat: 'local', analyze: 'anthropic', embed: 'local', suggest: 'nope' }
          },
          consent: PAST_CONSENT
        })
      );
      expect(settings.routing.perOperation).toEqual({ chat: 'local', analyze: 'anthropic' });
      expect(issues).toContain('routing.perOperation.embed: unknown operation dropped');
      expect(issues).toContain('routing.perOperation.suggest: unknown provider dropped');
    });

    test('strips cloud per-operation entries without consent and keeps local ones', () => {
      const { settings, issues } = sanitizeAiSettings(
        mergeAiSettings(defaultAiSettings(), {
          routing: { default: 'local', perOperation: { chat: 'local', analyze: 'anthropic' } }
        })
      );
      expect(settings.routing.perOperation).toEqual({ chat: 'local' });
      expect(issues).toContain('routing: cloud routing without valid cloud consent reset to local');
    });

    test('drops a per-operation entry whose provider was disabled by repair', () => {
      const { settings, issues } = sanitizeAiSettings(
        mergeAiSettings(defaultAiSettings(), {
          providers: { openaiCompatible: { enabled: true, baseUrl: 'http://attacker.example/v1' } },
          routing: { default: 'local', perOperation: { suggest: 'openaiCompatible' } },
          consent: PAST_CONSENT
        })
      );
      expect(settings.routing.perOperation).toEqual({});
      expect(issues).toContain(
        'routing.perOperation.suggest: provider disabled by repair, override dropped'
      );
    });

    test('treats a future-dated consent as absent', () => {
      const { settings } = sanitizeAiSettings(
        mergeAiSettings(defaultAiSettings(), {
          routing: { default: 'anthropic' },
          consent: { acknowledgedCloudAt: '2999-01-01T00:00:00.000Z' }
        })
      );
      expect(settings.routing.default).toBe('local');
    });

    test('drops unknown keys, unknown providers and malformed fields field-wise', () => {
      const { settings, issues } = sanitizeAiSettings(
        mergeAiSettings(defaultAiSettings(), {
          providers: {
            gemini: { enabled: true },
            anthropic: { enabled: true, model: '', extra: 1 },
            local: { enabled: 'yes' }
          },
          routing: { default: 'gemini', perFolder: { x: 'gemini', y: 'local' }, foo: 1 },
          consent: { acknowledgedCloudAt: 'not a date', bar: 2 }
        })
      );
      expect(settings.providers.gemini).toBeUndefined();
      expect(settings.providers.anthropic).toEqual({
        enabled: true,
        displayName: 'Anthropic Claude',
        model: 'claude-opus-4-7'
      });
      expect(settings.providers.local.enabled).toBe(true);
      expect(settings.routing).toEqual({
        default: 'local',
        perOperation: {},
        perFolder: { y: 'local' }
      });
      expect(settings.consent).toEqual({});
      expect(aiSettingsSchema.safeParse(settings).success).toBe(true);
      expect(issues.length).toBeGreaterThanOrEqual(7);
    });

    test('tolerates a non-object input', () => {
      expect(sanitizeAiSettings(null).settings).toEqual(defaultAiSettings());
      expect(sanitizeAiSettings('junk').settings).toEqual(defaultAiSettings());
    });
  });

  describe('validateAiSettingsForSave', () => {
    test('rejects a disallowed baseUrl with AI_SETTINGS_INVALID', () => {
      const result = validateAiSettingsForSave(
        {
          providers: { openaiCompatible: { enabled: true, baseUrl: 'http://attacker.example/v1' } }
        },
        undefined
      );
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe('AI_SETTINGS_INVALID');
      expect(result.validationErrors[0]).toMatch(/providers\.openaiCompatible\.baseUrl/);
    });

    test('rejects cloud routing when no consent is on record, ignoring incoming consent', () => {
      const result = validateAiSettingsForSave(
        {
          routing: { default: 'anthropic', perFolder: {} },
          consent: { acknowledgedCloudAt: '2020-01-01T00:00:00.000Z' }
        },
        { routing: { default: 'local', perFolder: {} }, consent: {} }
      );
      expect(result).toEqual({
        ok: false,
        error: 'CONSENT_REQUIRED',
        errorCode: 'CONSENT_REQUIRED'
      });
    });

    test('accepts cloud routing when consent is already stored and pins consent to it', () => {
      const stored = mergeAiSettings(defaultAiSettings(), { consent: PAST_CONSENT });
      const incoming = { ...stored, routing: { default: 'anthropic', perFolder: {} } };
      const result = validateAiSettingsForSave(incoming, stored);
      expect(result.ok).toBe(true);
      expect(result.ai).toEqual(incoming);
    });

    test('a save cannot alter stored consent', () => {
      const stored = mergeAiSettings(defaultAiSettings(), { consent: PAST_CONSENT });
      const result = validateAiSettingsForSave(
        { ...stored, consent: { acknowledgedCloudAt: '2025-06-01T00:00:00.000Z' } },
        stored
      );
      expect(result.ok).toBe(true);
      expect(result.ai.consent).toEqual(PAST_CONSENT);
    });

    test('rejects unknown keys and unknown providers', () => {
      expect(
        validateAiSettingsForSave({ providers: { gemini: { enabled: true } } }, undefined).errorCode
      ).toBe('AI_SETTINGS_INVALID');
      expect(
        validateAiSettingsForSave({ routing: { default: 'local', perFolder: {} }, x: 1 }, undefined)
          .errorCode
      ).toBe('AI_SETTINGS_INVALID');
      expect(validateAiSettingsForSave('nope', undefined).errorCode).toBe('AI_SETTINGS_INVALID');
    });

    test('an incoming blob identical to the stored one is always accepted', () => {
      const stored = maliciousAi();
      const result = validateAiSettingsForSave(maliciousAi(), stored);
      expect(result).toEqual({ ok: true, ai: stored });
    });

    test('rejects a cloud per-operation entry when no consent is on record', () => {
      const incoming = {
        ...defaultAiSettings(),
        routing: { default: 'local', perOperation: { chat: 'anthropic' }, perFolder: {} }
      };
      const res = validateAiSettingsForSave(incoming, defaultAiSettings());
      expect(res).toEqual({ ok: false, error: 'CONSENT_REQUIRED', errorCode: 'CONSENT_REQUIRED' });
    });

    test('accepts per-operation routing when consent is already stored', () => {
      const stored = { ...defaultAiSettings(), consent: PAST_CONSENT };
      const incoming = {
        ...defaultAiSettings(),
        routing: { default: 'local', perOperation: { analyze: 'anthropic' }, perFolder: {} }
      };
      const res = validateAiSettingsForSave(incoming, stored);
      expect(res.ok).toBe(true);
      expect(res.ok && res.ai.routing.perOperation).toEqual({ analyze: 'anthropic' });
    });

    test('a valid full blob passes through unchanged', () => {
      const full = defaultAiSettings();
      const result = validateAiSettingsForSave(full, undefined);
      expect(result).toEqual({ ok: true, ai: full });
    });
  });
});
