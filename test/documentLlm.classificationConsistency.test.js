/**
 * @jest-environment node
 *
 * The same kind of export should land in the same folder. These tests pin the
 * parts of the document classification call that decide that:
 *  - every Smart Folder the user made reaches the prompt (not just the first 10)
 *  - folder descriptions are not cut at 140 characters
 *  - the call samples at a low temperature with a fixed seed
 *  - an identical file under another name reuses the first file's answer
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

const mockLlamaService = {
  _initialized: true,
  initialize: jest.fn().mockResolvedValue(undefined),
  getConfig: jest.fn(),
  listModels: jest.fn().mockResolvedValue([{ name: 'test-model.gguf' }]),
  updateConfig: jest.fn().mockResolvedValue(undefined),
  generateText: jest.fn()
};

jest.mock('../src/main/services/LlamaService', () => ({
  getInstance: () => mockLlamaService
}));

const { analyzeTextWithLlama } = require('../src/main/analysis/documentLlm');
const { AI_DEFAULTS } = require('../src/shared/constants');
const { logger } = require('../src/shared/logger');

const DEFAULTS = [
  'Uncategorized',
  'Documents',
  'Images',
  'Videos',
  'Music',
  'Spreadsheets',
  'Presentations',
  'Archives'
].map((name) => ({ name, description: `${name} default folder`, isDefault: true }));

let textCounter = 0;
function uniqueText(label) {
  textCounter += 1;
  return `${label} ${textCounter} ${Date.now()}`;
}

function answer(category, extra = {}) {
  mockLlamaService.generateText.mockResolvedValue({
    response: JSON.stringify({
      category,
      purpose: 'Search performance export',
      keywords: ['queries', 'clicks', 'impressions'],
      confidence: 80,
      suggestedName: 'search_console_queries',
      ...extra
    })
  });
}

function promptSent(callIndex = 0) {
  return mockLlamaService.generateText.mock.calls[callIndex][0].prompt;
}

describe('documentLlm classification consistency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLlamaService.getConfig.mockResolvedValue({
      textModel: 'test-model.gguf',
      contextSize: 8192
    });
  });

  describe('folders in the prompt', () => {
    test('a folder added after the 8 defaults and 4 others still reaches the prompt', async () => {
      const folders = [
        ...DEFAULTS,
        { name: 'GSC', description: 'Google Search Console exports', isDefault: false },
        { name: 'SEO', description: 'SEO tool reports', isDefault: false },
        { name: 'Other', description: 'Anything else', isDefault: false },
        { name: 'Test Folder', description: 'Testing', isDefault: false },
        { name: 'Bing data', description: 'Bing Webmaster exports', isDefault: false }
      ];
      answer('Bing data');
      await analyzeTextWithLlama(uniqueText('bing export'), 'bing.csv', folders);
      const prompt = promptSent();
      expect(prompt).toContain('"Bing data"');
      expect(prompt).toContain('"GSC"');
      expect(prompt).toContain('"Uncategorized"');
    });

    test('the catch-all stays in the prompt when there are more folders than fit', async () => {
      const many = Array.from({ length: 24 }, (_, i) => ({
        name: `Client ${i + 1}`,
        description: `Client ${i + 1} reports`,
        isDefault: false
      }));
      const folders = [...many, { name: 'Uncategorized', description: 'Catch-all' }];
      answer('Client 1');
      await analyzeTextWithLlama(uniqueText('client export'), 'client.csv', folders);
      expect(promptSent()).toContain('"Uncategorized"');
      expect(logger.info).toHaveBeenCalledWith(
        '[DocumentLLM] Smart folders left out of prompt',
        expect.objectContaining({ omitted: 5 })
      );
    });

    test('a long folder description reaches the model whole', async () => {
      const description = `${'Search Console performance exports with queries and pages. '.repeat(
        4
      )}EXCLUDE: Bing exports`;
      expect(description.length).toBeGreaterThan(140);
      expect(description.length).toBeLessThanOrEqual(300);
      const folders = [
        { name: 'GSC', description, isDefault: false },
        { name: 'Uncategorized', description: 'Catch-all', isDefault: true }
      ];
      answer('GSC');
      await analyzeTextWithLlama(uniqueText('gsc export'), 'gsc.xlsx', folders);
      expect(promptSent()).toContain('EXCLUDE: Bing exports');
    });

    test('a longer folder list leaves less room for the document, not more', async () => {
      // Small context: the document sample must shrink so the prompt fits.
      mockLlamaService.getConfig.mockResolvedValue({
        textModel: 'test-model.gguf',
        contextSize: 4096
      });
      const longText = 'word '.repeat(20000);
      const fewFolders = [{ name: 'Uncategorized', description: 'Catch-all' }];
      const manyFolders = Array.from({ length: 20 }, (_, i) => ({
        name: `Folder ${i + 1}`,
        description: 'd'.repeat(290),
        isDefault: false
      }));
      answer('Uncategorized');
      await analyzeTextWithLlama(`${longText} a`, 'few.txt', fewFolders);
      await analyzeTextWithLlama(`${longText} b`, 'many.txt', manyFolders);
      const contentOf = (p) => p.split('<document_content>')[1].length;
      expect(contentOf(promptSent(1))).toBeLessThan(contentOf(promptSent(0)));
    });
  });

  describe('sampling', () => {
    test('classification uses a low temperature and a fixed seed', async () => {
      answer('Uncategorized');
      await analyzeTextWithLlama(uniqueText('sampling'), 'a.txt', DEFAULTS);
      expect(mockLlamaService.generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: AI_DEFAULTS.TEXT.CLASSIFICATION_TEMPERATURE,
          seed: AI_DEFAULTS.TEXT.CLASSIFICATION_SEED
        })
      );
      expect(AI_DEFAULTS.TEXT.CLASSIFICATION_TEMPERATURE).toBeLessThanOrEqual(0.3);
      expect(Number.isInteger(AI_DEFAULTS.TEXT.CLASSIFICATION_SEED)).toBe(true);
    });
  });

  describe('timing log', () => {
    test('a context overflow then a success logs two model calls', async () => {
      mockLlamaService.generateText.mockRejectedValueOnce(new Error('Too long prompt'));
      answer('Uncategorized');
      await analyzeTextWithLlama(uniqueText('overflow'), 'a.txt', DEFAULTS);
      expect(logger.info).toHaveBeenCalledWith(
        '[documentLlm] LLM inference completed',
        expect.objectContaining({ llmCalls: 2, promptChars: expect.any(Number) })
      );
      expect(logger.info).toHaveBeenCalledWith(
        '[DocumentLLM] Analysis complete',
        expect.objectContaining({ llmCalls: 2, llmMs: expect.any(Number) })
      );
    });
  });

  describe('identical content under another name', () => {
    const folders = [
      { name: 'GSC', description: 'Google Search Console exports', isDefault: false },
      { name: 'Uncategorized', description: 'Catch-all', isDefault: true }
    ];

    test('the second copy reuses the first answer, without its suggested name', async () => {
      const text = uniqueText('identical gsc export');
      answer('GSC');
      const first = await analyzeTextWithLlama(text, 'a.xlsx', folders, '2026-09-03');
      const second = await analyzeTextWithLlama(text, 'b_copy.xlsx', folders, '2026-09-04');
      expect(mockLlamaService.generateText).toHaveBeenCalledTimes(1);
      expect(first.category).toBe('GSC');
      expect(second.category).toBe('GSC');
      expect(first.suggestedName).toBe('search_console_queries.xlsx');
      expect(second.suggestedName).toBeUndefined();
    });

    test('a date taken from the first file is not copied to the second', async () => {
      const text = uniqueText('undated export');
      answer('GSC', { date: undefined });
      const first = await analyzeTextWithLlama(text, 'a.xlsx', folders, '2026-09-03');
      const second = await analyzeTextWithLlama(text, 'b.xlsx', folders, '2026-09-04');
      expect(first.date).toBe('2026-09-03');
      expect(second.date).toBe('2026-09-04');
    });

    test('a date read from the content is kept for the copy', async () => {
      const text = uniqueText('dated export');
      answer('GSC', { date: '2025-01-15' });
      await analyzeTextWithLlama(text, 'a.xlsx', folders, '2026-09-03');
      const second = await analyzeTextWithLlama(text, 'b.xlsx', folders, '2026-09-04');
      expect(second.date).toBe('2025-01-15');
    });

    test('changed Smart Folders are not answered from the earlier result', async () => {
      const text = uniqueText('folders changed');
      answer('GSC');
      await analyzeTextWithLlama(text, 'a.xlsx', folders);
      const edited = [
        { ...folders[0], description: 'Only Search Console query exports' },
        folders[1]
      ];
      await analyzeTextWithLlama(text, 'b.xlsx', edited);
      expect(mockLlamaService.generateText).toHaveBeenCalledTimes(2);
    });

    test('bypassCache analyzes again', async () => {
      const text = uniqueText('bypass');
      answer('GSC');
      await analyzeTextWithLlama(text, 'a.xlsx', folders);
      await analyzeTextWithLlama(text, 'b.xlsx', folders, null, [], { bypassCache: true });
      expect(mockLlamaService.generateText).toHaveBeenCalledTimes(2);
    });

    test('a failed analysis is never reused', async () => {
      const text = uniqueText('failed first');
      mockLlamaService.generateText.mockResolvedValue({ response: 'not json at all' });
      const first = await analyzeTextWithLlama(text, 'a.xlsx', folders);
      expect(first.error).toBeTruthy();
      answer('GSC');
      const callsBefore = mockLlamaService.generateText.mock.calls.length;
      const second = await analyzeTextWithLlama(text, 'b.xlsx', folders);
      expect(mockLlamaService.generateText.mock.calls.length).toBeGreaterThan(callsBefore);
      expect(second.category).toBe('GSC');
    });

    test('a timed-out analysis is never reused', async () => {
      const text = uniqueText('timed out first');
      mockLlamaService.generateText.mockRejectedValueOnce(new Error('Operation timed out'));
      const first = await analyzeTextWithLlama(text, 'a.xlsx', folders);
      expect(first.error).toBeTruthy();
      answer('GSC');
      const second = await analyzeTextWithLlama(text, 'b.xlsx', folders);
      expect(second.category).toBe('GSC');
      expect(mockLlamaService.generateText).toHaveBeenCalledTimes(2);
    });
  });
});
