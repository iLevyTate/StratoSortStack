/**
 * folderOverlap: advice shown when a folder to sort and a Smart Folder (where
 * sorted files go) are the same folder or sit inside each other.
 */
import {
  folderKey,
  isSameOrInside,
  findNestedDestinations,
  describeSourceOverlap,
  sourceOverlapMessage,
  foldersToConfirm,
  sourceOverlapQuestion
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

describe('the question before sorting a folder that overlaps a Smart Folder', () => {
  const reports = { id: 'r', name: 'Reports', path: 'C:\\Users\\Alex\\Sorted\\Reports' };

  test('the same folder in another case, slashes and a trailing slash still asks', () => {
    const result = describeSourceOverlap('c:/users/alex/sorted/reports/', [reports], CI);
    expect(result).toEqual({ kind: 'is', folder: reports });
    expect(foldersToConfirm(result)).toEqual([reports]);
  });

  test('a decomposed macOS spelling of the Smart Folder still asks', () => {
    const cafe = { id: 'c', name: 'Café', path: '/Users/alex/Caf\u00e9' };
    const result = describeSourceOverlap('/Users/alex/Cafe\u0301', [cafe], CS);
    expect(result?.kind).toBe('is');
    expect(foldersToConfirm(result)).toEqual([cafe]);
  });

  test('a Smart Folder the user already said may overlap is not asked about again', () => {
    const ok = { ...reports, sourceOverlapOk: true };
    expect(foldersToConfirm(describeSourceOverlap(reports.path, [ok], CI))).toEqual([]);
    // Chosen this session, before the saved list shows it.
    expect(
      foldersToConfirm(describeSourceOverlap(reports.path, [reports], CI), new Set(['r']))
    ).toEqual([]);
  });

  test('a folder holding several asks only about the ones not yet chosen', () => {
    const a = { id: 'a', name: 'A', path: '/P/Out/A', sourceOverlapOk: true };
    const b = { id: 'b', name: 'B', path: '/P/Out/B' };
    expect(foldersToConfirm(describeSourceOverlap('/P/Out', [a, b], CS))).toEqual([b]);
  });

  test('names the folder picked and the Smart Folder with its path', () => {
    expect(
      sourceOverlapQuestion(
        '/P/Out/GSC/raw',
        describeSourceOverlap('/P/Out/GSC/raw', [{ name: 'GSC', path: '/P/Out/GSC' }], CS)
      )
    ).toBe(
      'You picked /P/Out/GSC/raw to sort. It is inside your Smart Folder "GSC" at /P/Out/GSC. Files that belong in "GSC" will move out of the folder you picked to the top of "GSC". If you sort it, StratoSort will not ask again for this Smart Folder.'
    );
    expect(
      sourceOverlapQuestion(
        '/P/Out',
        describeSourceOverlap('/P/Out', [{ name: 'GSC', path: '/P/Out/GSC' }], CS)
      )
    ).toBe(
      'You picked /P/Out to sort. It holds your Smart Folder "GSC" at /P/Out/GSC. Files already sorted there will be analyzed and sorted again. If you sort it, StratoSort will not ask again for this Smart Folder.'
    );
    const two = describeSourceOverlap(
      '/P',
      [
        { name: 'A', path: '/P/A' },
        { name: 'B', path: '/P/B' }
      ],
      CS
    );
    expect(sourceOverlapQuestion('/P', two)).toContain(
      'It holds 2 of your Smart Folders: "A" at /P/A, "B" at /P/B.'
    );
    expect(sourceOverlapQuestion('/P', two)).toContain('not ask again for these Smart Folders.');
    expect(sourceOverlapQuestion('/P', null)).toBeNull();
  });

  test('the catch-all is described as where unmatched files go', () => {
    const catchAll = { name: 'Uncategorized', category: 'uncategorized', path: '/P/In' };
    expect(
      sourceOverlapQuestion('/P/In', describeSourceOverlap('/P/In', [catchAll], CS))
    ).toContain(
      'where files that fit nowhere else go. Files that fit nowhere else will stay in it.'
    );
  });
});
