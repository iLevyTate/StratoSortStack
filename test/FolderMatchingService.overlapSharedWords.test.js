/**
 * @jest-environment node
 *
 * A word several folder names share does not tell those folders apart. With
 * "GSC exports", "Bing exports" and "Clarity exports", the token overlap step
 * used to score each of them on "exports" alone and keep whichever came
 * first, so "Google Search Console exports" was filed under "Bing exports"
 * whenever that folder was added first.
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

const gsc = {
  name: 'GSC exports',
  description:
    'Google Search Console performance exports in Excel: queries, pages, clicks, impressions, CTR and position.'
};
const bing = {
  name: 'Bing exports',
  description:
    'Bing Webmaster Tools exports: keywords, pages, clicks and impressions from Bing search.'
};
const clarity = {
  name: 'Clarity exports',
  description: 'Microsoft Clarity CSV exports: sessions, users, scroll depth, browsers and devices.'
};
const seo = {
  name: 'SEO audits',
  description: 'PDF SEO audit reports with site scores, backlinks and recommendations.'
};
const uncategorized = {
  name: 'Uncategorized',
  description: 'Files that fit no other folder.',
  category: 'uncategorized',
  isDefault: true
};

const orders = {
  'Bing first': [bing, clarity, gsc, seo, uncategorized],
  'GSC first': [gsc, bing, clarity, seo, uncategorized]
};

describe.each(Object.entries(orders))('token overlap with shared words (%s)', (_order, folders) => {
  const match = (label) => FolderMatchingService.matchCategoryToFolder(label, folders);

  test('a spelled-out folder name goes to the folder its description names', () => {
    expect(match('Google Search Console exports')).toBe('GSC exports');
    expect(match('Search Console exports')).toBe('GSC exports');
  });

  test('a distinctive word still decides the match', () => {
    expect(match('Bing keyword exports')).toBe('Bing exports');
    expect(match('Clarity session exports')).toBe('Clarity exports');
  });

  test('a word only one description lists decides the match', () => {
    expect(match('Keyword exports')).toBe('Bing exports');
  });
});

describe('a label that only shares a common word', () => {
  test.each(['Web analytics exports', 'Keyword exports', 'Monthly exports'])(
    '%s is matched the same way whatever the folder order',
    (label) => {
      const results = Object.values(orders).map((folders) =>
        FolderMatchingService.matchCategoryToFolder(label, folders)
      );
      expect(results[0]).toBe(results[1]);
    }
  );

  test('Web analytics exports is not filed in an exports folder by order', () => {
    for (const folders of Object.values(orders)) {
      expect(FolderMatchingService.matchCategoryToFolder('Web analytics exports', folders)).toBe(
        'Uncategorized'
      );
    }
  });
});

describe('two folders matching as many distinctive words', () => {
  test('fall through to the descriptions instead of folder order', () => {
    const invoices = { name: 'Client invoices', description: 'Bills sent to clients' };
    const receipts = { name: 'Vendor receipts', description: 'Receipts from vendors' };
    const label = 'Client receipts';
    for (const folders of [
      [invoices, receipts, uncategorized],
      [receipts, invoices, uncategorized]
    ]) {
      expect(FolderMatchingService.matchCategoryToFolder(label, folders)).toBe('Uncategorized');
    }
  });
});
