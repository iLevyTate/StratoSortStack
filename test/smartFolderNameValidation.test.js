const {
  validateSmartFolderName,
  canonicalizeFolderName,
  namesAreEquivalent,
  findEquivalentFolderGroups
} = require('../src/shared/smartFolderNameValidation');

describe('smartFolderNameValidation', () => {
  describe('validateSmartFolderName', () => {
    test('accepts a clean name', () => {
      const result = validateSmartFolderName('Marketing');
      expect(result.valid).toBe(true);
      expect(result.sanitizedName).toBe('Marketing');
      expect(result.warning).toBeNull();
    });

    test('rejects illegal characters', () => {
      const result = validateSmartFolderName('Marketing<test>');
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe('INVALID_FOLDER_NAME_CHARS');
    });

    test('rejects empty/whitespace names', () => {
      expect(validateSmartFolderName('').valid).toBe(false);
      expect(validateSmartFolderName('   ').valid).toBe(false);
    });

    test('strips " > " separator with warning', () => {
      const result = validateSmartFolderName('Work > Projects');
      expect(result.valid).toBe(true);
      expect(result.sanitizedName).toBe('Work');
      expect(result.warning).toContain('Work');
    });
  });

  describe('canonicalizeFolderName', () => {
    test('lowercases and collapses non-alphanumeric runs', () => {
      expect(canonicalizeFolderName('Logos and Graphic Design')).toBe('logos and graphic design');
      expect(canonicalizeFolderName('Lab-Corp_Tests')).toBe('lab corp tests');
      expect(canonicalizeFolderName('  spaced   out  ')).toBe('spaced out');
    });

    test('returns empty string for falsy/empty inputs', () => {
      expect(canonicalizeFolderName('')).toBe('');
      expect(canonicalizeFolderName(null)).toBe('');
      expect(canonicalizeFolderName(undefined)).toBe('');
    });
  });

  describe('namesAreEquivalent', () => {
    test('returns true when canonical forms match exactly', () => {
      expect(namesAreEquivalent('Logos', 'logos')).toBe(true);
      expect(namesAreEquivalent('Lab Corp', 'lab-corp')).toBe(true);
    });

    test('returns true when shorter name is a token-subset of the longer (Logos / Logos and Graphic Design)', () => {
      // Regression: the live bug. "Logos and Graphic Design" was treated as
      // distinct from "Logos" and inserted as a duplicate smart folder.
      expect(namesAreEquivalent('Logos', 'Logos and Graphic Design')).toBe(true);
      expect(namesAreEquivalent('Logos and Graphic Design', 'Logos')).toBe(true);
    });

    test('returns true for Marketing / Marketing Materials', () => {
      expect(namesAreEquivalent('Marketing', 'Marketing Materials')).toBe(true);
    });

    test('returns false when names share no tokens', () => {
      expect(namesAreEquivalent('Work', 'Personal')).toBe(false);
      expect(namesAreEquivalent('Workshop', 'Work Out')).toBe(false); // different tokens
    });

    test('returns false for tokens that partially overlap but neither set is a subset', () => {
      // "Marketing Plan" tokens: {marketing, plan}; "Plan Materials" tokens:
      // {plan, materials}. Shorter (both size 2) has tokens not in the other.
      expect(namesAreEquivalent('Marketing Plan', 'Plan Materials')).toBe(false);
    });

    test('returns false for empty / nullish inputs', () => {
      expect(namesAreEquivalent('', 'Anything')).toBe(false);
      expect(namesAreEquivalent('Anything', '')).toBe(false);
      expect(namesAreEquivalent(null, 'Anything')).toBe(false);
    });

    test('returns true for identical canonical forms across punctuation', () => {
      expect(namesAreEquivalent('Lab-Corp', 'Lab Corp')).toBe(true);
      expect(namesAreEquivalent('LabCorp Inc.', 'labcorp inc')).toBe(true);
    });
  });

  describe('findEquivalentFolderGroups', () => {
    test('returns empty array for fewer than 2 folders', () => {
      expect(findEquivalentFolderGroups([])).toEqual([]);
      expect(findEquivalentFolderGroups([{ name: 'Logos' }])).toEqual([]);
    });

    test('returns empty array when all folder names are distinct', () => {
      const folders = [
        { name: 'Work' },
        { name: 'Personal' },
        { name: 'Financial' },
        { name: 'Archives' }
      ];
      expect(findEquivalentFolderGroups(folders)).toEqual([]);
    });

    test('groups the live "Logos" / "Logos and Graphic Design" duplicate', () => {
      // Mirrors the user's actual smart-folder set from
      // stratosort-2026-06-01T01-07-17-389Z.log.
      const folders = [
        { name: 'Archives' },
        { name: 'Uncategorized' },
        { name: '3D print' },
        { name: 'Financial' },
        { name: 'Research' },
        { name: 'Work' },
        { name: 'Logos and Graphic Design' },
        { name: 'Kennedy Applied Sciences' },
        { name: 'Logos' }
      ];
      const groups = findEquivalentFolderGroups(folders);
      expect(groups).toHaveLength(1);
      expect(groups[0].names.sort()).toEqual(['Logos', 'Logos and Graphic Design']);
      // indices are 6 ("Logos and Graphic Design") and 8 ("Logos") in input order
      expect(groups[0].indices.sort()).toEqual([6, 8]);
    });

    test('groups multiple distinct equivalence classes', () => {
      const folders = [
        { name: 'Logos' },
        { name: 'Logos and Graphic Design' },
        { name: 'Marketing' },
        { name: 'Marketing Materials' },
        { name: 'Archives' } // singleton — no group
      ];
      const groups = findEquivalentFolderGroups(folders);
      expect(groups).toHaveLength(2);
      const allNames = groups.flatMap((g) => g.names).sort();
      expect(allNames).toEqual([
        'Logos',
        'Logos and Graphic Design',
        'Marketing',
        'Marketing Materials'
      ]);
    });

    test('groups three-way equivalence under a single shared token', () => {
      const folders = [
        { name: 'Reports' },
        { name: 'Reports Q1' },
        { name: 'Reports Annual Summary' }
      ];
      const groups = findEquivalentFolderGroups(folders);
      expect(groups).toHaveLength(1);
      expect(groups[0].indices).toEqual([0, 1, 2]);
    });

    test('ignores empty / nullish names without crashing', () => {
      const folders = [
        { name: 'Work' },
        { name: '' },
        { name: null },
        { name: 'Work' } // exact duplicate of [0]
      ];
      const groups = findEquivalentFolderGroups(folders);
      expect(groups).toHaveLength(1);
      expect(groups[0].indices).toEqual([0, 3]);
    });

    test('treats non-array input as empty without crashing', () => {
      expect(findEquivalentFolderGroups(null)).toEqual([]);
      expect(findEquivalentFolderGroups(undefined)).toEqual([]);
      expect(findEquivalentFolderGroups('not an array')).toEqual([]);
    });
  });
});
