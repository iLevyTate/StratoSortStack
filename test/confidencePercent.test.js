const {
  normalizeConfidencePercent,
  normalizeThresholdPercent
} = require('../src/shared/confidencePercent');

describe('confidencePercent', () => {
  describe('normalizeConfidencePercent', () => {
    test('converts 0-1 fractions to percent', () => {
      expect(normalizeConfidencePercent(0.75)).toBe(75);
      expect(normalizeConfidencePercent(0.1)).toBe(10);
    });

    test('passes through 0-100 values', () => {
      expect(normalizeConfidencePercent(88)).toBe(88);
      expect(normalizeConfidencePercent(50)).toBe(50);
    });

    test('clamps invalid and out-of-range values', () => {
      expect(normalizeConfidencePercent(Number.NaN)).toBe(0);
      expect(normalizeConfidencePercent(150)).toBe(100);
      expect(normalizeConfidencePercent(-5)).toBe(0);
    });
  });

  describe('normalizeThresholdPercent', () => {
    test('converts fractional thresholds', () => {
      expect(normalizeThresholdPercent(0.75)).toBe(75);
    });

    test('accepts legacy percent thresholds without multiplying', () => {
      expect(normalizeThresholdPercent(75)).toBe(75);
      expect(normalizeThresholdPercent(75)).not.toBe(7500);
    });

    test('falls back when invalid', () => {
      expect(normalizeThresholdPercent(undefined)).toBe(75);
      expect(normalizeThresholdPercent(null, 80)).toBe(80);
    });
  });
});
