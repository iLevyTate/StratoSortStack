import {
  isUncategorizedBucket,
  countDestinationFolders,
  hasDestinationFolder
} from '../../../src/renderer/utils/smartFolderDestinations';

const UNCATEGORIZED = {
  id: 'default-uncategorized',
  name: 'Uncategorized',
  category: 'uncategorized',
  isDefault: true
};

describe('smartFolderDestinations', () => {
  test('recognizes the catch-all by category or by name', () => {
    expect(isUncategorizedBucket(UNCATEGORIZED)).toBe(true);
    expect(isUncategorizedBucket({ name: '  uncategorized ' })).toBe(true);
    expect(isUncategorizedBucket({ name: 'Misc', category: 'Uncategorized' })).toBe(true);
    expect(isUncategorizedBucket({ name: 'Receipts' })).toBe(false);
    expect(isUncategorizedBucket(null)).toBe(false);
  });

  test('the fresh-profile list (only Uncategorized) has no destination', () => {
    expect(hasDestinationFolder([UNCATEGORIZED])).toBe(false);
    expect(countDestinationFolders([UNCATEGORIZED])).toBe(0);
  });

  test('the built-in defaults count even though they are isDefault', () => {
    const folders = [UNCATEGORIZED, { id: 'd1', name: 'Documents', isDefault: true }];
    expect(hasDestinationFolder(folders)).toBe(true);
    expect(countDestinationFolders(folders)).toBe(1);
  });

  test('tolerates missing or malformed lists', () => {
    expect(hasDestinationFolder(undefined)).toBe(false);
    expect(hasDestinationFolder([null, undefined])).toBe(false);
    expect(countDestinationFolders('nope')).toBe(0);
  });
});
