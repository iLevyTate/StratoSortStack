/**
 * @jest-environment node
 *
 * The last name-matching step (token overlap) used to accept one shared word,
 * so a label like "Local AI report for 2026" went to "Test Folder for Stratot
 * data" because both contain "for". Filler and generic words no longer count.
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

jest.mock('../src/main/services/LlamaService', () => ({
  getInstance: () => ({ generateEmbedding: jest.fn(), getConfig: jest.fn() })
}));

const FolderMatchingService = require('../src/main/services/FolderMatchingService');

describe('token overlap ignores filler words', () => {
  const folders = [
    { name: 'SEO data' },
    { name: 'Test Folder for Stratot data' },
    { name: 'Uncategorized' }
  ];
  const match = (label) => FolderMatchingService.matchCategoryToFolder(label, folders);

  test('a shared "for" is not a match', () => {
    expect(match('Local AI report for 2026')).toBe('Uncategorized');
  });

  test('a shared "data" is not a match', () => {
    expect(match('AI industry data')).toBe('Uncategorized');
  });

  test('a shared year is not a match', () => {
    const dated = [{ name: 'Taxes 2026' }, { name: 'Uncategorized' }];
    expect(FolderMatchingService.matchCategoryToFolder('Holiday photos 2026', dated)).toBe(
      'Uncategorized'
    );
  });

  test('meaningful shared words still match', () => {
    expect(match('Stratot test data')).toBe('Test Folder for Stratot data');
    expect(match('SEO data analysis')).toBe('SEO data');
  });

  test('the unmatched label is offered as a new folder', () => {
    const result = FolderMatchingService.matchCategoryToFolderWithSuggestion(
      'AI industry data',
      folders
    );
    expect(result.folder).toBe('Uncategorized');
    expect(result.suggestedNewFolder).toBe('AI industry data');
  });

  test('a folder named only with filler words is never an overlap match', () => {
    const generic = [{ name: 'Other Stuff' }, { name: 'Uncategorized' }];
    expect(FolderMatchingService.matchCategoryToFolder('Vendor stuff archive', generic)).toBe(
      'Uncategorized'
    );
  });
});
