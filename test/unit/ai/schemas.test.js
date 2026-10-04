'use strict';
const {
  providerConfigSchema,
  routingSchema,
  aiSettingsSchema,
  isAllowedProviderBaseUrl
} = require('../../../src/main/services/ai/schemas');

describe('isAllowedProviderBaseUrl', () => {
  test.each([
    'https://api.openai.com/v1',
    'http://localhost:11434/v1',
    'http://127.0.0.1/v1',
    'http://[::1]:8080/v1',
    'http://[0:0:0:0:0:0:0:1]/v1'
  ])('allows %s', (url) => {
    expect(isAllowedProviderBaseUrl(url)).toBe(true);
  });

  test.each([
    'http://attacker.example/v1',
    'http://localhost.attacker.example/v1',
    'http://127.0.0.1@evil.example/v1',
    'ftp://api.openai.com/v1',
    'not a url',
    '',
    null,
    undefined
  ])('rejects %s', (url) => {
    expect(isAllowedProviderBaseUrl(url)).toBe(false);
  });

  test('providerConfigSchema applies the same rule', () => {
    expect(
      providerConfigSchema.safeParse({
        enabled: true,
        baseUrl: 'http://localhost.attacker.example'
      }).success
    ).toBe(false);
    expect(
      providerConfigSchema.safeParse({ enabled: true, baseUrl: 'http://localhost:11434/v1' })
        .success
    ).toBe(true);
  });
});

describe('AI provider Zod schemas', () => {
  test('providerConfigSchema accepts the local provider with no extras', () => {
    const result = providerConfigSchema.parse({ enabled: true, displayName: 'Local Llama' });
    expect(result.enabled).toBe(true);
  });

  test('providerConfigSchema accepts an Anthropic-shaped config', () => {
    const result = providerConfigSchema.parse({
      enabled: true,
      displayName: 'Anthropic Claude',
      model: 'claude-opus-4-7',
      apiKeyRef: 'anthropic'
    });
    expect(result.model).toBe('claude-opus-4-7');
    expect(result.apiKeyRef).toBe('anthropic');
  });

  test('providerConfigSchema accepts an OpenAI-compatible config with baseUrl', () => {
    const result = providerConfigSchema.parse({
      enabled: true,
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      apiKeyRef: 'openaiCompatible'
    });
    expect(result.baseUrl).toBe('https://api.openai.com/v1');
  });

  test('providerConfigSchema rejects a non-https baseUrl', () => {
    expect(() =>
      providerConfigSchema.parse({
        enabled: true,
        baseUrl: 'ftp://api.openai.com',
        model: 'gpt-4o'
      })
    ).toThrow();
  });

  test('routingSchema parses default + perFolder map', () => {
    const result = routingSchema.parse({
      default: 'local',
      perFolder: { 'tax-uuid': 'anthropic', 'medical-uuid': 'local' }
    });
    expect(result.default).toBe('local');
    expect(result.perFolder['tax-uuid']).toBe('anthropic');
  });

  test('routingSchema rejects an unknown default provider name', () => {
    expect(() => routingSchema.parse({ default: 'gemini', perFolder: {} })).toThrow();
  });

  test('aiSettingsSchema composes the full ai.* settings tree', () => {
    const result = aiSettingsSchema.parse({
      providers: {
        local: { enabled: true, displayName: 'Local Llama' },
        anthropic: {
          enabled: false,
          displayName: 'Anthropic Claude',
          model: 'claude-opus-4-7',
          apiKeyRef: 'anthropic'
        },
        openaiCompatible: {
          enabled: false,
          displayName: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o',
          apiKeyRef: 'openaiCompatible'
        }
      },
      routing: { default: 'local', perFolder: {} }
    });
    expect(result.providers.local.enabled).toBe(true);
    expect(result.routing.default).toBe('local');
  });
});
