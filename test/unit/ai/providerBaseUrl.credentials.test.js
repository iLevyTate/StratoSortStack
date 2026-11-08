'use strict';
/**
 * A provider base URL carrying user:password must be refused at the schema
 * layer (SET_PROVIDER_CONFIG and the persisted ai schema share this rule), so
 * the user sees a clear validation message instead of a saved config whose
 * every request fails and whose error text would carry the password.
 */
const {
  PROVIDER_BASE_URL_RULE,
  isAllowedProviderBaseUrl
} = require('../../../src/main/services/ai/providerBaseUrl');

describe('isAllowedProviderBaseUrl and URL credentials', () => {
  test.each([
    'https://alice:hunter2@gateway.example.test/v1',
    'https://alice@gateway.example.test/v1',
    'https://:hunter2@gateway.example.test/v1',
    'http://bob:pw@localhost:11434/v1',
    'http://bob@127.0.0.1/v1'
  ])('rejects %s', (url) => {
    expect(isAllowedProviderBaseUrl(url)).toBe(false);
  });

  test.each(['https://gateway.example.test/v1', 'http://localhost:11434/v1'])(
    'still allows %s',
    (url) => {
      expect(isAllowedProviderBaseUrl(url)).toBe(true);
    }
  );

  test('the validation message names the credentials rule', () => {
    expect(PROVIDER_BASE_URL_RULE).toMatch(/username or password/i);
  });
});
