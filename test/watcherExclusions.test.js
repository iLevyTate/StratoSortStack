/**
 * @jest-environment node
 *
 * User exclusion globs shared by the Downloads watcher, Smart Folder
 * watchers and the triage sweep.
 */

const {
  readExclusionGlobs,
  findMatchingExclusion,
  findUserExclusion
} = require('../src/main/services/watcherExclusions');

describe('watcherExclusions', () => {
  describe('readExclusionGlobs', () => {
    test('returns an empty list when settings carry no rules', () => {
      expect(readExclusionGlobs(null)).toEqual([]);
      expect(readExclusionGlobs({})).toEqual([]);
      expect(readExclusionGlobs({ downloadsTriageExclusions: 'not-an-array' })).toEqual([]);
    });

    test('trims, drops empties and dedupes like the save-time sanitizer', () => {
      expect(
        readExclusionGlobs({ downloadsTriageExclusions: [' *.iso ', '', '*.iso', 42, '*.psd'] })
      ).toEqual(['*.iso', '*.psd']);
    });

    test('adds the built-in defaults only when asked, user rules after them, no duplicates', () => {
      const { DEFAULT_EXCLUSION_GLOBS } = require('../src/shared/config/exclusionRulesSchema');
      const settings = { downloadsTriageExclusions: ['*.psd', '*.exe'] };
      expect(readExclusionGlobs(settings)).toEqual(['*.psd', '*.exe']);
      const withDefaults = readExclusionGlobs(settings, { includeDefaults: true });
      expect(withDefaults.slice(0, DEFAULT_EXCLUSION_GLOBS.length)).toEqual([
        ...DEFAULT_EXCLUSION_GLOBS
      ]);
      expect(withDefaults).toContain('*.psd');
      expect(withDefaults.filter((g) => g === '*.exe')).toHaveLength(1);
      expect(readExclusionGlobs(null, { includeDefaults: true })).toEqual([
        ...DEFAULT_EXCLUSION_GLOBS
      ]);
    });
  });

  describe('findMatchingExclusion', () => {
    test('matches the basename anywhere in the tree, case-insensitively', () => {
      expect(findMatchingExclusion('/home/u/Downloads/Ubuntu.ISO', ['*.iso'])).toBe('*.iso');
      expect(findMatchingExclusion('C:\\Users\\u\\Downloads\\setup-1.exe', ['setup-*.exe'])).toBe(
        'setup-*.exe'
      );
    });

    test('matches dotfiles', () => {
      expect(findMatchingExclusion('/docs/.env.local', ['.env*'])).toBe('.env*');
    });

    test('matches directory globs against the forward-slashed path', () => {
      expect(findMatchingExclusion('/docs/archived/2019/report.pdf', ['**/archived/**'])).toBe(
        '**/archived/**'
      );
      expect(findMatchingExclusion('C:\\docs\\archived\\report.pdf', ['**/archived/**'])).toBe(
        '**/archived/**'
      );
      expect(findMatchingExclusion('/docs/current/report.pdf', ['**/archived/**'])).toBeNull();
    });

    test('a relative folder glob names that folder at any depth beneath the root', () => {
      // `archived/**` used to be honored by the sweep's scanner and ignored
      // by the watchers; `**\/archived/**` the other way round. The sweep's
      // scanner only ever prunes beneath the folder it scans, so the root
      // is what the rule is read against (watcherExclusions.relativeGlob
      // covers the ancestor case).
      const root = '/home/u/Downloads';
      expect(
        findMatchingExclusion('/home/u/Downloads/archived/a.pdf', ['archived/**'], { root })
      ).toBe('archived/**');
      expect(
        findMatchingExclusion('/home/u/Downloads/2019/archived/sub/a.pdf', ['archived/**'], {
          root
        })
      ).toBe('archived/**');
      expect(
        findMatchingExclusion('/home/u/Downloads/archived-not/a.pdf', ['archived/**'], { root })
      ).toBeNull();
      expect(
        findMatchingExclusion('/home/u/archived/Downloads/a.pdf', ['archived/**'], {
          root: '/home/u/archived/Downloads'
        })
      ).toBeNull();
      // Anchored patterns are left exactly as written.
      expect(findMatchingExclusion('/srv/archived/a.pdf', ['/srv/**'])).toBe('/srv/**');
      expect(findMatchingExclusion('/home/u/srv/a.pdf', ['/srv/**'])).toBeNull();
      expect(findMatchingExclusion('C:\\Users\\u\\old\\a.pdf', ['C:/Users/u/old/**'])).toBe(
        'C:/Users/u/old/**'
      );
    });

    test('returns null when nothing matches or the list is empty', () => {
      expect(findMatchingExclusion('/docs/report.pdf', ['*.iso', '*.psd'])).toBeNull();
      expect(findMatchingExclusion('/docs/report.pdf', [])).toBeNull();
      expect(findMatchingExclusion('', ['*.pdf'])).toBeNull();
    });

    test('skips malformed and non-string patterns instead of throwing', () => {
      expect(findMatchingExclusion('/docs/report.pdf', [null, 7, '[', '*.pdf'])).toBe('*.pdf');
    });
  });

  describe('findUserExclusion', () => {
    test('reads the settings list and matches in one step', () => {
      const settings = { downloadsTriageExclusions: ['*.psd'] };
      expect(findUserExclusion('/docs/mock.PSD', settings)).toBe('*.psd');
      expect(findUserExclusion('/docs/mock.pdf', settings)).toBeNull();
      expect(findUserExclusion('/docs/mock.psd', undefined)).toBeNull();
    });

    test('applies the built-in defaults when asked, with no user list at all', () => {
      expect(findUserExclusion('/downloads/setup-1.2.3.exe', {})).toBeNull();
      expect(findUserExclusion('/downloads/setup-1.2.3.exe', {}, { includeDefaults: true })).toBe(
        '*.exe'
      );
      expect(findUserExclusion('/downloads/report.pdf', {}, { includeDefaults: true })).toBeNull();
    });
  });
});
