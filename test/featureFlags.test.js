const { GRAPH_FEATURE_FLAGS, isGraphViewEnabled } = require('../src/shared/featureFlags');

describe('featureFlags', () => {
  test('GRAPH_FEATURE_FLAGS includes expected keys', () => {
    expect(GRAPH_FEATURE_FLAGS).toHaveProperty('SHOW_GRAPH');
  });

  test('SHOW_GRAPH defaults to true', () => {
    expect(GRAPH_FEATURE_FLAGS.SHOW_GRAPH).toBe(true);
  });

  test('isGraphViewEnabled is on regardless of experience mode', () => {
    expect(isGraphViewEnabled()).toBe(true);
    expect(isGraphViewEnabled(null)).toBe(true);
    expect(isGraphViewEnabled({ experienceMode: 'simple' })).toBe(true);
    expect(isGraphViewEnabled({ experienceMode: 'advanced' })).toBe(true);
  });

  // The Settings switch ("Enable graph view") must mean the same thing in a
  // packaged build as in `npm run dev`; a toggle that only works in
  // development is a lie in the shipped UI.
  test.each(['development', 'production', 'test', undefined])(
    'isGraphViewEnabled honors the graph toggle when NODE_ENV=%s',
    (nodeEnv) => {
      const originalNodeEnv = process.env.NODE_ENV;
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      try {
        expect(isGraphViewEnabled({ developerGraphEnabled: false })).toBe(false);
        expect(isGraphViewEnabled({ developerGraphEnabled: true })).toBe(true);
        expect(isGraphViewEnabled({})).toBe(true);
      } finally {
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNodeEnv;
      }
    }
  );
});
