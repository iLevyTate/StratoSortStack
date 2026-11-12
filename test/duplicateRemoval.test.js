import {
  describeDuplicateRemoval,
  isRemovedDuplicate
} from '../src/renderer/utils/duplicateRemoval';

describe('duplicateRemoval', () => {
  test('an entry is a removed duplicate only when it says how the copy was removed', () => {
    expect(isRemovedDuplicate({ duplicateRemoval: 'trashed' })).toBe(true);
    expect(isRemovedDuplicate({ duplicateRemoval: 'deleted' })).toBe(true);
    expect(isRemovedDuplicate({ path: '/dest/a.pdf' })).toBe(false);
    expect(isRemovedDuplicate(null)).toBe(false);
    expect(isRemovedDuplicate('trashed')).toBe(false);
  });

  test('says where the copy went', () => {
    expect(describeDuplicateRemoval({ duplicateRemoval: 'trashed' })).toBe(
      'This copy is in the system Trash.'
    );
    expect(describeDuplicateRemoval({ duplicateRemoval: 'deleted' })).toBe(
      'This copy was removed.'
    );
  });

  test('says nothing about a file that was moved', () => {
    expect(describeDuplicateRemoval({ path: '/dest/a.pdf' })).toBe('');
    expect(describeDuplicateRemoval(undefined)).toBe('');
  });
});
