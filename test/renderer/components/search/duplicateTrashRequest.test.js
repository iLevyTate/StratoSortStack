/**
 * "Send to Trash" in the duplicate dialog names the kept copy of every
 * byte-identical set, so the main process can re-read the bytes before
 * trashing. Without it the main-side check never runs.
 */
import { buildTrashDuplicatesRequest } from '../../../../src/renderer/components/search/hooks/duplicateTrashRequest';

const f = (p) => ({ id: p, path: p });

describe('buildTrashDuplicatesRequest', () => {
  test('exact sets carry their kept copy for re-checking; similar sets do not', () => {
    const request = buildTrashDuplicatesRequest([
      { keep: f('/a/one.pdf'), delete: [f('/b/one.pdf'), f('/c/one.pdf')], tier: 'exact' },
      { keep: f('/a/draft.docx'), delete: [f('/b/draft.docx')], tier: 'related' }
    ]);

    expect(request.paths).toEqual(['/b/one.pdf', '/c/one.pdf', '/b/draft.docx']);
    expect(request.summary).toEqual({ label: 'Delete duplicates', tier: 'mixed' });
    expect(request.verifyIdentical).toEqual([
      { keep: '/a/one.pdf', paths: ['/b/one.pdf', '/c/one.pdf'] }
    ]);
  });

  test('with no exact set, nothing is sent for re-checking', () => {
    const request = buildTrashDuplicatesRequest([
      { keep: f('/a/x.png'), delete: [f('/b/x.png')], tier: 'nearIdentical' }
    ]);
    expect(request).toEqual({
      paths: ['/b/x.png'],
      summary: { label: 'Delete duplicates', tier: 'nearIdentical' }
    });
  });
});
