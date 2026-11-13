/**
 * folderOverlap: advice shown when a folder to sort and a Smart Folder (where
 * sorted files go) are the same folder or sit inside each other.
 */
import {
  folderKey,
  isSameOrInside,
  findNestedDestinations,
  describeSourceOverlap,
  sourceOverlapMessage
} from '../../../src/renderer/utils/folderOverlap';

const CI = { caseInsensitive: true };
const CS = { caseInsensitive: false };

describe('folderKey', () => {
  test('uses forward slashes, drops a trailing slash and folds case when asked', () => {
    expect(folderKey('C:\\Users\\H\\Out\\', CI)).toBe('c:/users/h/out');
    expect(folderKey('/Users/H/Out/', CS)).toBe('/Users/H/Out');
  });

  test('composes decomposed Unicode so macOS spellings match', () => {
    expect(folderKey('/Users/h/Cafe\u0301', CS)).toBe(folderKey('/Users/h/Caf\u00e9', CS));
  });

  test('is empty for a missing path', () => {
    expect(folderKey(undefined, CI)).toBe('');
    expect(folderKey('', CI)).toBe('');
  });
});

describe('isSameOrInside', () => {
  test('a Windows child under a parent spelled with other separators and case', () => {
    expect(isSameOrInside('C:\\Users\\H\\Out\\GSC', 'c:/users/h/out', CI)).toBe(true);
  });

  test('a sibling that only shares a name prefix is not inside', () => {
    expect(isSameOrInside('/Users/h/Out2', '/Users/h/Out', CI)).toBe(false);
  });

  test('the same folder with a trailing slash and other case, only when case is ignored', () => {
    expect(
      isSameOrInside('/Users/H/Public/Strato Input/', '/users/h/public/strato input', CI)
    ).toBe(true);
    expect(
      isSameOrInside('/Users/H/Public/Strato Input/', '/users/h/public/strato input', CS)
    ).toBe(false);
  });

  test('a parent is not inside its child, and an empty path is never inside', () => {
    expect(isSameOrInside('/P/Out', '/P/Out/GSC', CI)).toBe(false);
    expect(isSameOrInside('', '/P/Out', CI)).toBe(false);
    expect(isSameOrInside('/P/Out', '', CI)).toBe(false);
  });

  test('anything on a drive is inside that drive root', () => {
    expect(isSameOrInside('C:\\Data', 'C:\\', CI)).toBe(true);
    expect(isSameOrInside('/Users/h', '/', CS)).toBe(true);
  });
});

describe('findNestedDestinations', () => {
  const testFolder = { id: 't', name: 'Test Folder', path: '/P/Strato Output' };
  const gsc = { id: 'g', name: 'GSC', path: '/P/Strato Output/GSC' };

  test('a Smart Folder inside another one is reported once', () => {
    expect(findNestedDestinations([testFolder, gsc], CI)).toEqual([
      { outer: testFolder, inner: gsc }
    ]);
  });

  test('identical or sibling paths are not nesting', () => {
    expect(
      findNestedDestinations([testFolder, { id: 'x', name: 'Copy', path: '/P/Strato Output/' }], CI)
    ).toEqual([]);
    expect(
      findNestedDestinations([testFolder, { id: 's', name: 'Sib', path: '/P/Strato Output2' }], CI)
    ).toEqual([]);
  });

  test('each inner folder is paired with the folder that holds it most closely', () => {
    const deeper = { id: 'd', name: 'Queries', path: '/P/Strato Output/GSC/Queries' };
    expect(findNestedDestinations([testFolder, gsc, deeper], CI)).toEqual([
      { outer: testFolder, inner: gsc },
      { outer: gsc, inner: deeper }
    ]);
  });

  test('ignores entries without a path and non-arrays', () => {
    expect(findNestedDestinations([testFolder, { name: 'No path' }], CI)).toEqual([]);
    expect(findNestedDestinations(null, CI)).toEqual([]);
  });
});

describe('describeSourceOverlap and sourceOverlapMessage', () => {
  const docs = '/Users/h/Documents';
  const defaults = [
    'Documents',
    'Images',
    'Videos',
    'Music',
    'Spreadsheets',
    'Presentations',
    'Archives',
    'Uncategorized'
  ].map((name) => ({
    id: name,
    name,
    path: `${docs}/${name}`,
    ...(name === 'Uncategorized' ? { category: 'uncategorized' } : {})
  }));

  test('the folder to sort is the catch-all under another name', () => {
    const catchAll = {
      name: 'Strato test Data',
      path: '/P/Strato Input',
      category: 'uncategorized',
      isDefault: true
    };
    const result = describeSourceOverlap('/P/Strato Input', [catchAll], CI);
    expect(result).toEqual({ kind: 'is', folder: catchAll });
    expect(sourceOverlapMessage(result)).toContain('fit nowhere else');
    expect(sourceOverlapMessage(result)).toContain('"Strato test Data"');
  });

  test('the folder to sort is an ordinary Smart Folder', () => {
    const gsc = { name: 'GSC', path: '/P/Out/GSC' };
    const result = describeSourceOverlap('/P/Out/GSC/', [gsc], CI);
    expect(result).toEqual({ kind: 'is', folder: gsc });
    expect(sourceOverlapMessage(result)).toBe(
      '"GSC" is one of your Smart Folders, where sorted files go. Files that belong there stay in this folder.'
    );
  });

  test('the folder to sort is inside a Smart Folder', () => {
    const gsc = { name: 'GSC', path: '/P/Out/GSC' };
    const result = describeSourceOverlap('/P/Out/GSC/raw', [gsc], CI);
    expect(result).toEqual({ kind: 'inside', folder: gsc });
    expect(sourceOverlapMessage(result)).toContain('inside your Smart Folder "GSC"');
  });

  test('the folder to sort holds the default Smart Folders', () => {
    const result = describeSourceOverlap(docs, defaults, CI);
    expect(result?.kind).toBe('contains');
    expect(result?.folders).toHaveLength(8);
    expect(sourceOverlapMessage(result)).toContain('8 of your Smart Folders');
  });

  test('one Smart Folder inside is named in the singular', () => {
    const result = describeSourceOverlap('/P', [{ name: 'GSC', path: '/P/Out/GSC' }], CI);
    expect(sourceOverlapMessage(result)).toBe(
      'This folder holds your Smart Folder "GSC". Files already sorted there will be analyzed and sorted again.'
    );
  });

  test('an unrelated folder gives no advice', () => {
    expect(describeSourceOverlap('/Users/h/Downloads', defaults, CI)).toBeNull();
    expect(sourceOverlapMessage(null)).toBeNull();
  });
});
