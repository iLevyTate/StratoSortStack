/**
 * Tests for FolderMatchingService.matchTokensToFolders — the Phase 3 keyword
 * matcher used by the Tier 0 FastTriageClassifier when cached embeddings
 * aren't available.
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

describe('FolderMatchingService.matchTokensToFolders', () => {
  let FolderMatchingService;
  let service;

  beforeEach(() => {
    jest.resetModules();
    FolderMatchingService = require('../src/main/services/FolderMatchingService');
    // The class expects vectorDbService for vector matching, but
    // matchTokensToFolders is pure logic — we don't need a real DB here.
    service = Object.create(FolderMatchingService.prototype);
  });

  test('returns empty for empty inputs', () => {
    expect(service.matchTokensToFolders([], [])).toEqual([]);
    expect(service.matchTokensToFolders(['pdf'], [])).toEqual([]);
    expect(service.matchTokensToFolders([], [{ name: 'x' }])).toEqual([]);
  });

  test('ranks folder with strongest keyword overlap first', () => {
    const folders = [
      { id: 'a', name: 'Invoices', keywords: ['invoice', 'receipt'] },
      { id: 'b', name: 'Reports', keywords: ['report', 'quarterly'] },
      { id: 'c', name: 'Misc', keywords: [] }
    ];
    const ranked = service.matchTokensToFolders(['invoice', 'q3', 'acme'], folders, { topK: 3 });
    expect(ranked[0].id).toBe('a');
    expect(ranked[0].matchedTokens).toContain('invoice');
  });

  test('filters folders below minScore', () => {
    const folders = [
      { id: 'weak', name: 'Weak', keywords: ['xyz'] },
      { id: 'zero', name: 'Zero', keywords: [] }
    ];
    const ranked = service.matchTokensToFolders(['abc'], folders, { minScore: 0.5 });
    expect(ranked).toEqual([]);
  });

  test('honors topK cap', () => {
    const folders = Array.from({ length: 10 }).map((_, i) => ({
      id: `f${i}`,
      name: `Folder${i}`,
      keywords: ['shared']
    }));
    const ranked = service.matchTokensToFolders(['shared'], folders, { topK: 3, minScore: 0 });
    expect(ranked).toHaveLength(3);
  });

  test('category and description contribute to the folder token pool', () => {
    const folders = [
      {
        id: 'via-cat',
        name: 'Archive',
        category: 'invoices',
        keywords: []
      },
      {
        id: 'via-desc',
        name: 'Inbox',
        description: 'Receipts and invoices',
        keywords: []
      }
    ];
    const ranked = service.matchTokensToFolders(['invoices'], folders, { minScore: 0 });
    const ids = ranked.map((r) => r.id);
    expect(ids).toContain('via-cat');
    expect(ids).toContain('via-desc');
  });

  test('is case-insensitive', () => {
    const folders = [{ id: 'mix', name: 'MixedCase', keywords: ['INVOICE'] }];
    const ranked = service.matchTokensToFolders(['Invoice'], folders, { minScore: 0 });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].matchedTokens).toContain('invoice');
  });
});
