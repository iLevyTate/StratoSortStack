/**
 * Sample first, the pure parts: when the offer applies, which files the
 * sample takes, how many folders have description hints, and where each
 * sample file would go (the same ranking Organize uses).
 */
import {
  SAMPLE_OFFER_MIN_FILES,
  SAMPLE_SIZE,
  countFoldersWithHints,
  pickSampleFiles,
  rankSampleFiles,
  shouldOfferSample
} from '../src/renderer/phases/discover/sampleRun';
import { RANKING_OPTIONS } from '../src/renderer/phases/organize/useOrganizeSuggestions';

const { getFolderDefinitionsHash } = require('../src/shared/smartFolderDefinitions');

const INVOICES = {
  id: 'f-inv',
  name: 'Invoices',
  description: 'Bills and invoices from suppliers, not receipts',
  path: '/Users/alex/Library/Invoices'
};
const PHOTOS = {
  id: 'f-photo',
  name: 'Photos',
  description: 'Pictures taken with the phone or camera',
  path: '/Users/alex/Library/Photos'
};
const UNCATEGORIZED = {
  id: 'f-unc',
  name: 'Uncategorized',
  description: '',
  path: '/Users/alex/Library/Uncategorized',
  isDefault: true
};
const FOLDERS = [INVOICES, PHOTOS, UNCATEGORIZED];

const makeFiles = (count, ext = 'pdf') =>
  Array.from({ length: count }, (_, i) => ({
    path: `/Users/alex/Inbox/file-${ext}-${i}.${ext}`,
    name: `file-${ext}-${i}.${ext}`
  }));

describe('shouldOfferSample', () => {
  const base = {
    smartFolders: FOLDERS,
    reviewedHash: null,
    isAnalyzing: false
  };

  test('a batch at the threshold is offered a sample', () => {
    expect(SAMPLE_OFFER_MIN_FILES).toBe(20);
    expect(shouldOfferSample({ ...base, files: makeFiles(SAMPLE_OFFER_MIN_FILES) })).toBe(true);
  });

  test('a smaller batch is not', () => {
    expect(shouldOfferSample({ ...base, files: makeFiles(SAMPLE_OFFER_MIN_FILES - 1) })).toBe(
      false
    );
  });

  test('the same file listed twice counts once', () => {
    const files = makeFiles(SAMPLE_OFFER_MIN_FILES - 1);
    expect(shouldOfferSample({ ...base, files: [...files, files[0]] })).toBe(false);
  });

  test('not while another run is going: the files wait for it', () => {
    expect(shouldOfferSample({ ...base, files: makeFiles(30), isAnalyzing: true })).toBe(false);
  });

  test('not with only the Uncategorized catch-all: there is nothing to try', () => {
    expect(
      shouldOfferSample({ ...base, smartFolders: [UNCATEGORIZED], files: makeFiles(30) })
    ).toBe(false);
  });

  test('not again for folder definitions already tried, but again once they change', () => {
    const reviewedHash = getFolderDefinitionsHash(FOLDERS);
    expect(shouldOfferSample({ ...base, reviewedHash, files: makeFiles(30) })).toBe(false);

    const edited = [{ ...INVOICES, description: 'Supplier invoices only' }, PHOTOS, UNCATEGORIZED];
    expect(
      shouldOfferSample({ ...base, smartFolders: edited, reviewedHash, files: makeFiles(30) })
    ).toBe(true);
  });
});

describe('pickSampleFiles', () => {
  test('takes SAMPLE_SIZE files spread across the file types in the batch', () => {
    const files = [...makeFiles(20, 'pdf'), ...makeFiles(6, 'jpg'), ...makeFiles(2, 'xlsx')];
    const picked = pickSampleFiles(files);
    expect(picked).toHaveLength(SAMPLE_SIZE);
    const types = picked.map((f) => f.name.split('.').pop());
    // One of each type first, the most common type first; then a second round.
    expect(types).toEqual(['pdf', 'jpg', 'xlsx', 'pdf', 'jpg']);
  });

  test('a batch of one type takes its first files', () => {
    const files = makeFiles(30, 'pdf');
    expect(pickSampleFiles(files)).toEqual(files.slice(0, SAMPLE_SIZE));
  });

  test('reads the type from the extension field when there is one', () => {
    const files = [
      { path: '/Users/alex/a', name: 'a', extension: '.PDF' },
      { path: '/Users/alex/b', name: 'b', extension: 'pdf' },
      { path: '/Users/alex/c.png', name: 'c.png' }
    ];
    expect(pickSampleFiles(files, 2).map((f) => f.path)).toEqual([
      '/Users/alex/a',
      '/Users/alex/c.png'
    ]);
  });

  test('never more files than the batch has', () => {
    expect(pickSampleFiles(makeFiles(3))).toHaveLength(3);
    expect(pickSampleFiles([])).toEqual([]);
  });
});

describe('countFoldersWithHints', () => {
  test('counts folders with a missing, short or look-alike description, not the catch-all', () => {
    const folders = [
      INVOICES,
      PHOTOS,
      UNCATEGORIZED, // empty description, but it is the catch-all
      { id: 'a', name: 'Misc', description: '', path: '/Users/alex/Misc' }, // missing
      { id: 'b', name: 'Work', description: 'Work stuff', path: '/Users/alex/Work' } // short
    ];
    expect(countFoldersWithHints(folders)).toBe(2);
  });

  test('two folders that read alike both count', () => {
    const folders = [
      {
        id: 'a',
        name: 'Reports',
        description: 'Monthly search reports keyword rankings traffic',
        path: '/Users/alex/Reports'
      },
      {
        id: 'b',
        name: 'Analytics',
        description: 'Monthly search reports keyword rankings traffic exports',
        path: '/Users/alex/Analytics'
      }
    ];
    expect(countFoldersWithHints(folders)).toBe(2);
  });

  test('clear, distinct descriptions count none', () => {
    expect(countFoldersWithHints(FOLDERS)).toBe(0);
  });
});

describe('rankSampleFiles', () => {
  const invoice = {
    path: '/Users/alex/Inbox/march.pdf',
    name: 'march.pdf',
    analysis: { category: 'Photos', summary: 'Supplier invoice for March' }
  };
  const photo = {
    path: '/Users/alex/Inbox/beach.jpg',
    name: 'beach.jpg',
    analysis: { category: 'Photos' }
  };
  const failed = { path: '/Users/alex/Inbox/broken.docx', name: 'broken.docx', error: 'Timed out' };

  test('the engine ranking decides, as in Organize, with its score and reason', async () => {
    const getBatchSuggestions = jest.fn().mockResolvedValue({
      success: true,
      groups: [
        {
          files: [
            {
              path: invoice.path,
              suggestion: {
                folder: 'Invoices',
                path: INVOICES.path,
                folderId: INVOICES.id,
                isSmartFolder: true
              },
              confidence: 0.82,
              explanation: 'This file reads like "Invoices"',
              alternatives: []
            }
          ]
        }
      ]
    });

    const rows = await rankSampleFiles({
      files: [invoice, photo, failed],
      smartFolders: FOLDERS,
      getBatchSuggestions
    });

    expect(getBatchSuggestions).toHaveBeenCalledTimes(1);
    const [sent, options] = getBatchSuggestions.mock.calls[0];
    expect(options).toBe(RANKING_OPTIONS);
    // Only analyzed files are ranked.
    expect(sent.map((f) => f.path)).toEqual([invoice.path, photo.path]);

    expect(rows).toEqual([
      {
        path: invoice.path,
        name: 'march.pdf',
        analyzed: true,
        folder: 'Invoices',
        score: 0.82,
        reason: 'This file reads like "Invoices"'
      },
      {
        // No engine answer: the analysis label picks the folder, without a score.
        path: photo.path,
        name: 'beach.jpg',
        analyzed: true,
        folder: 'Photos',
        score: null,
        reason: 'Matched by the label the analysis gave this file'
      },
      {
        path: failed.path,
        name: 'broken.docx',
        analyzed: false,
        folder: null,
        score: null,
        reason: 'This file could not be analyzed.'
      }
    ]);
  });

  test('a failed ranking falls back to name matching; no fit means Uncategorized', async () => {
    const getBatchSuggestions = jest.fn().mockRejectedValue(new Error('engine offline'));
    const unknown = {
      path: '/Users/alex/Inbox/notes.txt',
      name: 'notes.txt',
      analysis: { category: 'Recipes' }
    };

    const rows = await rankSampleFiles({
      files: [photo, unknown],
      smartFolders: FOLDERS,
      getBatchSuggestions
    });

    expect(rows[0]).toMatchObject({ folder: 'Photos', score: null });
    expect(rows[1]).toMatchObject({
      analyzed: true,
      folder: null,
      score: null,
      reason: 'No Smart Folder fits this file.'
    });
  });
});
