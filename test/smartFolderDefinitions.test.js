/**
 * getFolderDefinitionsHash: one hash of what the Smart Folders say (names,
 * descriptions, paths). The sample offer is remembered per hash, and each
 * analysis is stamped with it, so it must change exactly when a definition
 * the AI reads changes.
 */
const { getFolderDefinitionsHash } = require('../src/shared/smartFolderDefinitions');

const INVOICES = {
  id: 'f1',
  name: 'Invoices',
  description: 'Bills and invoices from suppliers',
  path: '/Users/alex/Library/Invoices'
};
const PHOTOS = {
  id: 'f2',
  name: 'Photos',
  description: 'Pictures from the phone and camera',
  path: '/Users/alex/Library/Photos'
};

describe('getFolderDefinitionsHash', () => {
  test('no folders give no hash', () => {
    expect(getFolderDefinitionsHash([])).toBe('');
    expect(getFolderDefinitionsHash(undefined)).toBe('');
    expect(getFolderDefinitionsHash([null, {}])).toBe('');
  });

  test('the same definitions give the same hash in any order', () => {
    const hash = getFolderDefinitionsHash([INVOICES, PHOTOS]);
    expect(hash).toMatch(/^sf-[0-9a-f]{14}$/);
    expect(getFolderDefinitionsHash([PHOTOS, INVOICES])).toBe(hash);
  });

  test('spaces around a value, separator style and a trailing separator do not count', () => {
    const hash = getFolderDefinitionsHash([INVOICES]);
    expect(
      getFolderDefinitionsHash([
        {
          ...INVOICES,
          name: ' Invoices ',
          description: 'Bills and invoices from suppliers  ',
          path: '\\Users\\alex\\Library\\Invoices\\'
        }
      ])
    ).toBe(hash);
  });

  test('ids and keywords do not count: the AI does not read them', () => {
    const hash = getFolderDefinitionsHash([INVOICES]);
    expect(getFolderDefinitionsHash([{ ...INVOICES, id: 'other', keywords: ['tax'] }])).toBe(hash);
  });

  test('a new name, description or path, or another folder, changes the hash', () => {
    const hash = getFolderDefinitionsHash([INVOICES, PHOTOS]);
    const variants = [
      [{ ...INVOICES, name: 'Bills' }, PHOTOS],
      [{ ...INVOICES, description: 'Supplier invoices, not receipts' }, PHOTOS],
      [{ ...INVOICES, path: '/Users/alex/Finance/Invoices' }, PHOTOS],
      [INVOICES],
      [INVOICES, PHOTOS, { name: 'Taxes', description: 'Tax forms', path: '/Users/alex/Taxes' }]
    ];
    const hashes = variants.map((folders) => getFolderDefinitionsHash(folders));
    for (const other of hashes) expect(other).not.toBe(hash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  test('moving text between name and description is a different definition', () => {
    const a = getFolderDefinitionsHash([{ name: 'Tax', description: 'forms', path: '/p' }]);
    const b = getFolderDefinitionsHash([{ name: 'Tax forms', description: '', path: '/p' }]);
    expect(a).not.toBe(b);
  });
});
