/**
 * The notice for a Smart Folder whose AI provider is not ready names the
 * provider that actually runs: the router falls through to the default, and
 * the old text said "Using the local model" even when that was Claude.
 */
const { folderOverrideNotice } = require('../../../src/main/ipc/aiProvider');

const providers = {
  local: { displayName: 'Local Llama' },
  anthropic: { displayName: 'Anthropic Claude' },
  openaiCompatible: { displayName: 'OpenAI / Custom' }
};

describe('folderOverrideNotice', () => {
  test('names the default provider that takes over', () => {
    expect(
      folderOverrideNotice({
        configured: 'openaiCompatible',
        reason: 'API key is missing or invalid',
        fallbackId: 'anthropic',
        providers
      })
    ).toBe(
      'A Smart Folder is set to OpenAI / Custom, which is not ready (API key is missing or invalid). Using Anthropic Claude instead. Change it in Settings → AI.'
    );
  });

  test('says the local model only when that is what runs', () => {
    expect(
      folderOverrideNotice({ configured: 'anthropic', fallbackId: 'local', providers })
    ).toContain('Using the local model instead.');
    expect(
      folderOverrideNotice({ configured: 'anthropic', fallbackId: null, providers })
    ).toContain('Using the local model instead.');
  });
});
