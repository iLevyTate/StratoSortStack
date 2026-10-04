/**
 * @jest-environment node
 */
const {
  collectOrganizedPathKeys,
  mergeOrganizedPathIndex,
  removeFromOrganizedPathIndex,
  normalizeOrganizedPathIndex,
  MAX_ORGANIZED_PATH_INDEX
} = require('../src/renderer/utils/organizedPathIndex');

describe('organizedPathIndex', () => {
  test('collects original, path, and currentPath as canonical keys', () => {
    const keys = collectOrganizedPathKeys([
      {
        originalPath: 'C:\\Downloads\\a.pdf',
        path: 'C:\\Docs\\Research\\a.pdf',
        currentPath: 'C:\\Docs\\Research\\a.pdf'
      }
    ]);

    expect(keys).toEqual([
      'c:/downloads/a.pdf',
      'c:/docs/research/a.pdf',
      'c:/docs/research/a.pdf'
    ]);
  });

  test('merge dedupes and keeps newest keys when over the cap', () => {
    const existing = Array.from({ length: 5 }, (_, i) => `/old/${i}.pdf`);
    const incoming = Array.from({ length: 5 }, (_, i) => `/new/${i}.pdf`);

    const merged = mergeOrganizedPathIndex(existing, incoming, { max: 7 });

    expect(merged).toHaveLength(7);
    expect(merged).toEqual([
      '/old/3.pdf',
      '/old/4.pdf',
      '/new/0.pdf',
      '/new/1.pdf',
      '/new/2.pdf',
      '/new/3.pdf',
      '/new/4.pdf'
    ]);
  });

  test('remove drops matching canonical keys', () => {
    const next = removeFromOrganizedPathIndex(
      ['c:/docs/a.pdf', 'c:/docs/b.pdf', 'c:/docs/c.pdf'],
      ['C:\\Docs\\B.pdf']
    );
    expect(next).toEqual(['c:/docs/a.pdf', 'c:/docs/c.pdf']);
  });

  test('normalize coerces dirty payloads', () => {
    expect(normalizeOrganizedPathIndex(['C:\\A.pdf', '', null, 'C:\\A.pdf'])).toEqual(['c:/a.pdf']);
    expect(MAX_ORGANIZED_PATH_INDEX).toBeGreaterThanOrEqual(4000);
  });
});
