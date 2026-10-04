/**
 * Installed-model matching, shared by the reanalyze preflight (ipc/semantic)
 * and the watcher's provisional-retry check (F-195). Moved out of the IPC
 * module so a service can ask "is this model installed?" without importing
 * handler registration.
 */
const { findInstalledModelMatch, normalizeModelName } = require('../src/shared/modelNameMatch');

describe('modelNameMatch', () => {
  const installed = ['Mistral-7B-Instruct-v0.3-Q4_K_M.gguf', 'nomic-embed-text-v1.5-Q8_0.gguf'];

  test('normalizes case and whitespace', () => {
    expect(normalizeModelName('  Foo.GGUF ')).toBe('foo.gguf');
    expect(normalizeModelName(null)).toBe('');
  });

  test('exact match wins regardless of case', () => {
    expect(findInstalledModelMatch(installed, 'mistral-7b-instruct-v0.3-q4_k_m.gguf')).toBe(
      installed[0]
    );
  });

  test('fuzzy-matches legacy short names in either direction', () => {
    expect(findInstalledModelMatch(installed, 'mistral')).toBe(installed[0]);
    expect(findInstalledModelMatch(['nomic'], 'nomic-embed-text-v1.5-Q8_0.gguf')).toBe('nomic');
  });

  test('returns null for no model, no list, or no match', () => {
    expect(findInstalledModelMatch(installed, '')).toBeNull();
    expect(findInstalledModelMatch(null, 'mistral')).toBeNull();
    expect(findInstalledModelMatch(installed, 'llava')).toBeNull();
  });
});
