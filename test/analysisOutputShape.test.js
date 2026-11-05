/**
 * What a model says is checked before it is stored or offered as a folder.
 *
 * From a real run: an image was stored with contentType
 * "text_document OR photograph OR screenshot OR other" (the model copied the
 * prompt's example), and titles like "Mystery Bin Declutter: 2-5-10 Method"
 * were offered as new folders.
 */

jest.mock('../src/shared/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: () => logger, logger };
});

const { isTitleLikeCategory } = require('../src/shared/categoryFolderMatching');

describe('normalizeImageContentType', () => {
  const {
    normalizeImageContentType,
    IMAGE_CONTENT_TYPES
  } = require('../src/main/analysis/imageAnalysis');

  test('allowed values pass through, case and spacing aside', () => {
    for (const value of IMAGE_CONTENT_TYPES) expect(normalizeImageContentType(value)).toBe(value);
    expect(normalizeImageContentType(' Photograph ')).toBe('photograph');
    expect(normalizeImageContentType('text document')).toBe('text_document');
  });

  test('an echo of the option list is stored as other, not as the raw string', () => {
    expect(normalizeImageContentType('text_document OR photograph OR screenshot OR other')).toBe(
      'other'
    );
  });

  test('common synonyms map; anything else and missing values become other', () => {
    expect(normalizeImageContentType('photo')).toBe('photograph');
    expect(normalizeImageContentType('document')).toBe('text_document');
    expect(normalizeImageContentType('landscape')).toBe('other');
    expect(normalizeImageContentType(undefined)).toBe('other');
    expect(normalizeImageContentType('')).toBe('other');
  });
});

describe('isTitleLikeCategory', () => {
  test.each([
    ['Mystery Bin Declutter: 2-5-10 Method', true],
    ['How I organized my entire garage in one weekend', true],
    ['A very long category name that keeps going past forty chars', true],
    ['Financial', false],
    ['3D print', false],
    ['Local Al File Organizer', false],
    ['', false]
  ])('%s -> %s', (label, expected) => {
    expect(isTitleLikeCategory(label)).toBe(expected);
  });
});

describe('matchCategoryToFolderWithSuggestion', () => {
  const FolderMatchingService = require('../src/main/services/FolderMatchingService');
  const Service = FolderMatchingService.FolderMatchingService || FolderMatchingService;
  const folders = [{ name: 'Financial' }, { name: 'Work' }, { name: 'Uncategorized' }];

  test('a title-shaped category still falls back, but is not offered as a new folder', () => {
    const result = Service.matchCategoryToFolderWithSuggestion(
      'Mystery Bin Declutter: 2-5-10 Method',
      folders
    );
    expect(result.folder).toBe('Uncategorized');
    expect(result.suggestedNewFolder).toBeNull();
  });

  test('a folder-sized unmatched category is still offered', () => {
    const result = Service.matchCategoryToFolderWithSuggestion('Recipes', folders);
    expect(result.folder).toBe('Uncategorized');
    expect(result.suggestedNewFolder).toBe('Recipes');
  });
});

describe('naming context does not rebuild the search index for every file', () => {
  const {
    fetchNamingContextFromBm25,
    NAMING_REBUILD_MIN_INTERVAL_MS
  } = require('../src/main/analysis/namingContextBm25');

  function searchService() {
    return {
      bm25Index: {},
      isIndexStale: jest.fn(() => true),
      buildBM25Index: jest.fn().mockResolvedValue(undefined),
      bm25Search: jest.fn().mockResolvedValue([])
    };
  }

  test('a stale index is rebuilt at most once per interval', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const service = searchService();
      await fetchNamingContextFromBm25(service, { fileName: 'a.png' });
      await fetchNamingContextFromBm25(service, { fileName: 'b.png' });
      await fetchNamingContextFromBm25(service, { fileName: 'c.png' });
      expect(service.buildBM25Index).toHaveBeenCalledTimes(1);

      now.mockReturnValue(1_000_000 + NAMING_REBUILD_MIN_INTERVAL_MS);
      await fetchNamingContextFromBm25(service, { fileName: 'd.png' });
      expect(service.buildBM25Index).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  test('a missing index is always built', async () => {
    const service = { ...searchService(), bm25Index: null };
    await fetchNamingContextFromBm25(service, { fileName: 'a.png' });
    expect(service.buildBM25Index).toHaveBeenCalledTimes(1);
  });
});
