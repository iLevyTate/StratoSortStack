/**
 * @jest-environment node
 *
 * A relative folder glob (`Archive/**`) names a folder beneath the root the
 * caller is operating under: the Smart Folder being watched, the Downloads
 * folder, the folder the triage sweep scans. It must never read a segment
 * ABOVE that root as a match, or a Smart Folder at `D:\Archive\Photos`
 * loses every file to a rule meant for its `Archive` subfolders.
 */

const {
  findMatchingExclusion,
  findUserExclusion
} = require('../src/main/services/watcherExclusions');

describe('watcherExclusions relative folder globs', () => {
  test('a segment above the root does not match', () => {
    expect(
      findMatchingExclusion('D:\\Archive\\Photos\\x.pdf', ['Archive/**'], {
        root: 'D:\\Archive\\Photos'
      })
    ).toBeNull();
    expect(
      findMatchingExclusion('/home/u/archive/Downloads/x.pdf', ['archive/**'], {
        root: '/home/u/archive/Downloads'
      })
    ).toBeNull();
    // The sweep's always-on defaults are relative folder globs too.
    expect(
      findMatchingExclusion('C:\\dev\\node_modules\\pkg\\Downloads\\x.pdf', ['node_modules/**'], {
        root: 'C:\\dev\\node_modules\\pkg\\Downloads'
      })
    ).toBeNull();
    expect(
      findMatchingExclusion('/home/u/.git/Downloads/x.pdf', ['.git/**'], {
        root: '/home/u/.git/Downloads'
      })
    ).toBeNull();
  });

  test('the named folder beneath the root matches, at any depth', () => {
    expect(
      findMatchingExclusion('D:\\Archive\\Photos\\Archive\\x.pdf', ['Archive/**'], {
        root: 'D:\\Archive\\Photos'
      })
    ).toBe('Archive/**');
    expect(
      findMatchingExclusion('D:\\Archive\\Photos\\2019\\archive\\sub\\x.pdf', ['Archive/**'], {
        root: 'D:/Archive/Photos/'
      })
    ).toBe('Archive/**');
    expect(
      findMatchingExclusion('/home/u/Downloads/node_modules/pkg/x.js', ['node_modules/**'], {
        root: '/home/u/Downloads'
      })
    ).toBe('node_modules/**');
    expect(
      findMatchingExclusion('/home/u/Downloads/archived-not/x.pdf', ['archived/**'], {
        root: '/home/u/Downloads'
      })
    ).toBeNull();
  });

  test('without a root a relative folder glob is not applied', () => {
    // No root, no way to tell `D:\Archive\Photos\x.pdf` from a file that
    // really sits under an `Archive` subfolder; leaving the file alone is
    // the safe reading.
    expect(findMatchingExclusion('D:\\Archive\\Photos\\x.pdf', ['Archive/**'])).toBeNull();
    expect(findMatchingExclusion('/home/u/Downloads/archived/a.pdf', ['archived/**'])).toBeNull();
  });

  test('a file outside the root is not matched by a relative folder glob', () => {
    expect(
      findMatchingExclusion('/home/u/Other/Archive/x.pdf', ['Archive/**'], {
        root: '/home/u/Downloads'
      })
    ).toBeNull();
  });

  test('absolute and `**/`-prefixed patterns still read against the whole path', () => {
    const root = 'D:\\Archive\\Photos';
    expect(findMatchingExclusion('D:\\Archive\\Photos\\x.pdf', ['**/Archive/**'], { root })).toBe(
      '**/Archive/**'
    );
    expect(findMatchingExclusion('D:\\Archive\\Photos\\x.pdf', ['D:/Archive/**'], { root })).toBe(
      'D:/Archive/**'
    );
    expect(findMatchingExclusion('/srv/archived/a.pdf', ['/srv/**'], { root: '/srv' })).toBe(
      '/srv/**'
    );
    // Basename rules are unaffected by the root.
    expect(findMatchingExclusion('D:\\Archive\\Photos\\setup-1.exe', ['*.exe'], { root })).toBe(
      '*.exe'
    );
  });

  test('findUserExclusion forwards the root', () => {
    const settings = { downloadsTriageExclusions: ['Archive/**'] };
    expect(
      findUserExclusion('D:\\Archive\\Photos\\x.pdf', settings, { root: 'D:\\Archive\\Photos' })
    ).toBeNull();
    expect(
      findUserExclusion('D:\\Archive\\Photos\\Archive\\x.pdf', settings, {
        root: 'D:\\Archive\\Photos'
      })
    ).toBe('Archive/**');
    expect(
      findUserExclusion('/home/u/node_modules/Downloads/x.pdf', null, {
        includeDefaults: true,
        root: '/home/u/node_modules/Downloads'
      })
    ).toBeNull();
  });
});
