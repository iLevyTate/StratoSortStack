/**
 * A file the suggestion engine marks as needing review (no Smart Folder is a
 * confident match) is never moved by auto-organize or the download watcher
 * path, whatever confidence it carries and whatever the threshold is set to.
 * It is held where it is and listed for review.
 */

jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

jest.mock('electron', () => ({
  app: { getPath: jest.fn().mockReturnValue('/Users/alex/Documents') }
}));

const mockFs = {
  mkdir: jest.fn().mockResolvedValue(undefined),
  lstat: jest.fn().mockRejectedValue({ code: 'ENOENT' }),
  access: jest.fn().mockResolvedValue(undefined),
  stat: jest.fn().mockResolvedValue({ size: 1000, birthtime: new Date(), mtime: new Date() })
};
jest.mock('fs', () => ({ promises: mockFs }));

jest.mock('../src/main/analysis/documentAnalysis', () => ({
  analyzeDocumentFile: jest.fn().mockResolvedValue({ category: 'SEO data', confidence: 90 })
}));
jest.mock('../src/main/analysis/imageAnalysis', () => ({
  analyzeImageFile: jest.fn().mockResolvedValue({ category: 'Photos', confidence: 90 })
}));

const {
  processFilesIndividually,
  processNewFile
} = require('../src/main/services/autoOrganize/fileProcessor');
const {
  processBatchResults,
  batchOrganize
} = require('../src/main/services/autoOrganize/batchProcessor');

const UNCATEGORIZED = {
  id: 'u',
  name: 'Uncategorized',
  path: '/Users/alex/Library/Uncategorized',
  isDefault: true
};
const SEO_DATA = { id: 's', name: 'SEO data', path: '/Users/alex/Library/SEO data' };
const FOLDERS = [SEO_DATA, UNCATEGORIZED];

const REPORT = {
  name: 'state-of-local-ai.md',
  extension: 'md',
  path: '/Users/alex/Downloads/state-of-local-ai.md',
  analysis: { category: 'SEO data', confidence: 90 }
};

const EXPLANATION = 'No Smart Folder matched this file well. The closest was "SEO data".';

/** An engine answer that would clear a low threshold but needs review. */
function reviewSuggestion() {
  return {
    success: true,
    primary: {
      folder: 'Uncategorized',
      path: UNCATEGORIZED.path,
      folderId: 'u',
      isSmartFolder: true,
      source: 'default',
      needsReview: true
    },
    alternatives: [{ folder: 'SEO data', path: SEO_DATA.path, isSmartFolder: true }],
    confidence: 0.9,
    explanation: EXPLANATION,
    needsReview: true,
    routingDecision: { basis: 'needs_review', reason: 'weak_match' }
  };
}

const freshResults = () => ({ organized: [], needsReview: [], failed: [], operations: [] });

describe('processFilesIndividually', () => {
  test('holds a needs-review file even above the threshold', async () => {
    const results = freshResults();
    const service = { getSuggestionsForFile: jest.fn().mockResolvedValue(reviewSuggestion()) };

    await processFilesIndividually(
      [REPORT],
      FOLDERS,
      { confidenceThreshold: 0.1, defaultLocation: '/Users/alex/Library' },
      results,
      service
    );

    expect(results.operations).toEqual([]);
    expect(results.organized).toEqual([]);
    expect(results.needsReview).toHaveLength(1);
    expect(results.needsReview[0].explanation).toBe(EXPLANATION);
  });

  test('holds an unassigned file (no default folder) for review', async () => {
    const results = freshResults();
    const suggestion = { ...reviewSuggestion(), primary: null, confidence: 0 };
    const service = { getSuggestionsForFile: jest.fn().mockResolvedValue(suggestion) };

    await processFilesIndividually(
      [REPORT],
      [SEO_DATA],
      { confidenceThreshold: 0, defaultLocation: '/Users/alex/Library' },
      results,
      service
    );

    expect(results.operations).toEqual([]);
    expect(results.needsReview).toHaveLength(1);
    expect(results.needsReview[0].explanation).toBe(EXPLANATION);
  });
});

describe('processBatchResults', () => {
  test('holds needs-review entries and unassigned files, moves confident ones', () => {
    const results = freshResults();
    const confident = {
      ...REPORT,
      name: 'rankings.csv',
      path: '/Users/alex/Downloads/rankings.csv'
    };
    const orphan = { ...REPORT, name: 'notes.md', path: '/Users/alex/Downloads/notes.md' };
    const batch = {
      success: true,
      groups: [
        {
          folder: 'Uncategorized',
          path: UNCATEGORIZED.path,
          confidence: 0.9,
          files: [
            {
              ...REPORT,
              suggestion: reviewSuggestion().primary,
              confidence: 0.9,
              explanation: EXPLANATION,
              needsReview: true
            }
          ]
        },
        {
          folder: 'SEO data',
          path: SEO_DATA.path,
          confidence: 0.9,
          files: [
            {
              ...confident,
              suggestion: { folder: 'SEO data', path: SEO_DATA.path, isSmartFolder: true },
              confidence: 0.9,
              needsReview: false
            }
          ]
        }
      ],
      unassigned: [{ ...orphan, suggestion: null, needsReview: true, explanation: EXPLANATION }]
    };

    processBatchResults(
      batch,
      [REPORT, confident, orphan],
      { confidenceThreshold: 0.5, defaultLocation: '/Users/alex/Library' },
      results,
      FOLDERS
    );

    expect(results.operations.map((op) => op.source)).toEqual([confident.path]);
    expect(results.needsReview.map((r) => r.file.path).sort()).toEqual(
      [orphan.path, REPORT.path].sort()
    );
  });
});

describe('batchOrganize', () => {
  test('never auto-approves a needs-review file inside a confident group', async () => {
    const other = { ...REPORT, name: 'rankings.csv', path: '/Users/alex/Downloads/rankings.csv' };
    const service = {
      getBatchSuggestions: jest.fn().mockResolvedValue({
        success: true,
        groups: [
          {
            folder: 'Uncategorized',
            path: UNCATEGORIZED.path,
            confidence: 0.9,
            files: [
              { ...REPORT, needsReview: true },
              { ...other, needsReview: false }
            ]
          }
        ],
        unassigned: [{ ...REPORT, path: '/Users/alex/Downloads/notes.md', needsReview: true }]
      })
    };

    const result = await batchOrganize(
      [REPORT, other],
      FOLDERS,
      { confidenceThreshold: 0.5, defaultLocation: '/Users/alex/Library' },
      service
    );

    expect(result.operations.map((op) => op.source)).toEqual([other.path]);
    const held = result.skipped.filter((s) => s.reason === 'Needs review');
    expect(held.flatMap((s) => s.files.map((f) => f.path)).sort()).toEqual(
      ['/Users/alex/Downloads/notes.md', REPORT.path].sort()
    );
  });
});

describe('processNewFile (download watcher)', () => {
  test('does not move a needs-review file, and does not offer its label as the folder', async () => {
    const service = { getSuggestionsForFile: jest.fn().mockResolvedValue(reviewSuggestion()) };

    const result = await processNewFile(
      '/Users/alex/Downloads/state-of-local-ai.md',
      FOLDERS,
      { autoOrganizeEnabled: true, confidenceThreshold: 0.1, defaultLocation: '/Users/alex' },
      service
    );

    expect(result.destination).toBeNull();
    expect(result.held).toBe(true);
    expect(result.needsReview).toBe(true);
    expect(result.explanation).toBe(EXPLANATION);
    expect(result.suggestedFolder).toBe('Uncategorized');
  });

  test('with no default folder the label is not offered either', async () => {
    const service = {
      getSuggestionsForFile: jest
        .fn()
        .mockResolvedValue({ ...reviewSuggestion(), primary: null, confidence: 0 })
    };

    const result = await processNewFile(
      '/Users/alex/Downloads/state-of-local-ai.md',
      [SEO_DATA],
      { autoOrganizeEnabled: true, confidenceThreshold: 0.1, defaultLocation: '/Users/alex' },
      service
    );

    expect(result.destination).toBeNull();
    expect(result.suggestedFolder).toBeNull();
  });
});
