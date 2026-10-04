'use strict';

const {
  DEFAULT_EXCLUSION_GLOBS,
  getDefaultExclusionGlobs,
  sanitizeExclusionGlobs
} = require('../../src/shared/config/exclusionRulesSchema');

describe('exclusionRulesSchema', () => {
  describe('DEFAULT_EXCLUSION_GLOBS', () => {
    test('is frozen and covers installer, in-progress, scratch, and VCS globs', () => {
      expect(Object.isFrozen(DEFAULT_EXCLUSION_GLOBS)).toBe(true);
      expect(DEFAULT_EXCLUSION_GLOBS).toEqual(
        expect.arrayContaining(['*.exe', '*.crdownload', '*.tmp', 'node_modules/**', '.git/**'])
      );
    });
  });

  describe('getDefaultExclusionGlobs', () => {
    test('returns a fresh mutable copy, not the frozen source array', () => {
      const a = getDefaultExclusionGlobs();
      const b = getDefaultExclusionGlobs();
      expect(a).toEqual([...DEFAULT_EXCLUSION_GLOBS]);
      expect(a).not.toBe(DEFAULT_EXCLUSION_GLOBS);
      expect(a).not.toBe(b);
      expect(() => a.push('*.extra')).not.toThrow();
      expect(getDefaultExclusionGlobs()).not.toContain('*.extra');
    });
  });

  describe('sanitizeExclusionGlobs', () => {
    test('returns null for non-array input', () => {
      expect(sanitizeExclusionGlobs(null)).toBeNull();
      expect(sanitizeExclusionGlobs(undefined)).toBeNull();
      expect(sanitizeExclusionGlobs('*.exe')).toBeNull();
      expect(sanitizeExclusionGlobs({ 0: '*.exe' })).toBeNull();
    });

    test('trims, drops empty/whitespace-only, and drops non-string entries', () => {
      expect(sanitizeExclusionGlobs(['  *.exe  ', '', '   ', 42, null, '*.tmp'])).toEqual([
        '*.exe',
        '*.tmp'
      ]);
    });

    test('dedupes after trimming', () => {
      expect(sanitizeExclusionGlobs(['*.exe', '  *.exe', '*.exe  '])).toEqual(['*.exe']);
    });

    test('drops entries longer than 256 characters', () => {
      const long = 'a'.repeat(257);
      const atLimit = 'b'.repeat(256);
      expect(sanitizeExclusionGlobs([long, atLimit])).toEqual([atLimit]);
    });

    test('caps the output at 200 entries', () => {
      const raw = Array.from({ length: 250 }, (_, i) => `glob-${i}`);
      expect(sanitizeExclusionGlobs(raw)).toHaveLength(200);
    });

    test('returns an empty array when nothing survives sanitization', () => {
      expect(sanitizeExclusionGlobs(['', '   ', 7, {}])).toEqual([]);
    });
  });
});
