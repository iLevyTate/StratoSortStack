/**
 * sanitizePath composed every path (NFC) on every platform. NTFS and ext4
 * store names byte for byte, so a file whose name is decomposed (a + U+0308,
 * e.g. unzipped from a Mac) was then looked up under a name that does not
 * exist: analyze, organize and trash failed with not-found and undo dropped
 * the entry as gone. Only APFS/HFS+ look names up either way, so only darwin
 * composes. Comparison keys (normalizePathForIndex) still compose everywhere.
 *
 * pathSanitization is not required at the top of this file: the module reads
 * the platform from `os` once at load, and each test loads its own copy.
 */

const decomposedName = 'Ma\u0308rz.pdf';
const composedName = 'M\u00e4rz.pdf';

function loadFor(platform) {
  let mod;
  jest.isolateModules(() => {
    jest.doMock('os', () => ({ ...jest.requireActual('os'), platform: () => platform }));
    mod = require('../src/shared/pathSanitization');
  });
  return mod;
}

// The host's `path` picks the separator for POSIX-style input, so only the
// file name is compared.
const fileNameOf = (p) => p.split(/[\\/]/).pop();

describe('sanitizePath Unicode spelling per platform', () => {
  afterEach(() => {
    jest.dontMock('os');
  });

  test('linux keeps a decomposed name as given', () => {
    const { sanitizePath } = loadFor('linux');
    expect(fileNameOf(sanitizePath(`/home/user/${decomposedName}`))).toBe(decomposedName);
  });

  test('win32 keeps a decomposed name as given', () => {
    const { sanitizePath } = loadFor('win32');
    expect(fileNameOf(sanitizePath(`C:\\Users\\user\\${decomposedName}`))).toBe(decomposedName);
  });

  test('darwin composes, since APFS/HFS+ find the file under either spelling', () => {
    const { sanitizePath } = loadFor('darwin');
    expect(fileNameOf(sanitizePath(`/Users/user/${decomposedName}`))).toBe(composedName);
  });

  test('index keys still collapse both spellings off darwin', () => {
    const { normalizePathForIndex } = loadFor('linux');
    expect(normalizePathForIndex(`/home/user/${decomposedName}`)).toBe(
      normalizePathForIndex(`/home/user/${composedName}`)
    );
  });
});
