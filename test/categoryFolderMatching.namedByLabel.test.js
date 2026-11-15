/**
 * findSmartFolderNamedByLabel: the exact or near-exact name match that
 * needs-review routing accepts as evidence on its own. Description and
 * keyword overlap, and a label that fits two folders, do not count.
 */

const {
  findSmartFolderNamedByLabel,
  findSmartFolderForLabel
} = require('../src/shared/categoryFolderMatching');

const FOLDERS = [
  { name: 'SEO data', description: 'Keyword rankings and search traffic exports.' },
  { name: 'SEO audits', description: 'PDF SEO audit reports.' },
  { name: 'Invoices', description: 'Invoices, receipts and tax documents' },
  { name: 'Marketing Materials' },
  { name: 'Uncategorized', isDefault: true }
];

describe('findSmartFolderNamedByLabel', () => {
  test.each([
    ['SEO data', 'SEO data'],
    ['seo-data', 'SEO data'],
    ['Invoice', 'Invoices'],
    ['invoices', 'Invoices'],
    ['Marketing Materials Q3', 'Marketing Materials'],
    ['Nature_17803333378895', null]
  ])('%s names %s', (label, expected) => {
    const folder = findSmartFolderNamedByLabel(label, FOLDERS);
    expect(folder ? folder.name : null).toBe(expected);
  });

  test('a label that fits two folders names neither', () => {
    expect(findSmartFolderNamedByLabel('SEO', FOLDERS)).toBeNull();
  });

  test('a one-word label that is only part of a folder name is not a name', () => {
    expect(findSmartFolderNamedByLabel('Data', FOLDERS)).toBeNull();
    expect(findSmartFolderNamedByLabel('Marketing', FOLDERS)).toBeNull();
  });

  test('description words are not a name, though the broader matcher uses them', () => {
    expect(findSmartFolderForLabel('Tax documents', FOLDERS)?.name).toBe('Invoices');
    expect(findSmartFolderNamedByLabel('Tax documents', FOLDERS)).toBeNull();
  });

  test('the default folder never counts', () => {
    expect(findSmartFolderNamedByLabel('Uncategorized', FOLDERS)).toBeNull();
    expect(findSmartFolderNamedByLabel('Inbox', [{ name: 'Inbox', isDefault: true }])).toBeNull();
  });
});
