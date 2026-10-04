/**
 * @jest-environment node
 */
const { clampOutputTokens } = require('../src/shared/tokenBudget');

describe('clampOutputTokens', () => {
  test('is monotonic in requested tokens', () => {
    const ctx = 2048;
    const small = clampOutputTokens(256, ctx, 0);
    const large = clampOutputTokens(2048, ctx, 0);
    expect(large).toBeGreaterThanOrEqual(small);
    expect(large).toBeGreaterThan(128);
  });

  test('CPU context 2048 with a default request yields more than 128', () => {
    expect(clampOutputTokens(2048, 2048, 0)).toBeGreaterThan(128);
  });

  // L5: an unknown context size used to propagate as NaN into maxTokens.
  test.each([undefined, null, NaN, Infinity, -Infinity, 'not-a-number', 0, -512])(
    'returns the requested tokens unchanged when the context size is unusable (%p)',
    (ctx) => {
      expect(clampOutputTokens(512, ctx, 4000)).toBe(512);
    }
  );

  test('numeric-string context sizes are still honoured', () => {
    expect(clampOutputTokens(4096, '1024', 0)).toBe(1024 - 64);
  });
});
