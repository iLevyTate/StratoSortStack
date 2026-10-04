/**
 * Tests for documentLlm
 */

const { analyzeTextWithLlama, AppConfig } = require('../src/main/analysis/documentLlm');
const { logger } = require('../src/shared/logger');

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
  getConfig: jest.fn().mockResolvedValue({ textModel: 'test-model.gguf' }),
  listModels: jest.fn().mockResolvedValue([{ name: 'test-model.gguf' }]),
  updateConfig: jest.fn().mockResolvedValue(undefined),
  generateText: jest.fn()
};

jest.mock('../src/main/services/LlamaService', () => ({
  getInstance: () => mockLlamaService
}));

describe('documentLlm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLlamaService.getConfig.mockResolvedValue({ textModel: 'test-model.gguf' });
    mockLlamaService.listModels.mockResolvedValue([{ name: 'test-model.gguf' }]);
  });

  test('analyzeTextWithLlama returns structured result', async () => {
    mockLlamaService.generateText.mockResolvedValue({
      response: JSON.stringify({
        project: 'Invoices',
        purpose: 'Billing',
        category: 'Financial',
        keywords: ['invoice'],
        confidence: 0.9,
        suggestedName: 'invoice_q1'
      })
    });

    // Pass smart folders so the LLM category can be validated against them.
    // With no folders, matchCategoryToFolder correctly returns 'Uncategorized'.
    const smartFolders = [
      { name: 'Financial', description: 'Financial documents' },
      { name: 'Uncategorized', description: 'Uncategorized files' }
    ];
    const result = await analyzeTextWithLlama('Invoice Q1', 'invoice.txt', smartFolders);
    expect(result.category).toBe('Financial');
    expect(result.suggestedName).toBe('invoice_q1.txt');
  });

  test('uses cache for identical inputs', async () => {
    mockLlamaService.generateText.mockResolvedValue({
      response: JSON.stringify({
        category: 'Documents',
        confidence: 0.5,
        suggestedName: 'doc'
      })
    });

    const smartFolders = [
      { name: 'Documents', description: 'General documents' },
      { name: 'Uncategorized', description: 'Uncategorized files' }
    ];
    const r1 = await analyzeTextWithLlama('Text', 'doc.txt', smartFolders);
    const r2 = await analyzeTextWithLlama('Text', 'doc.txt', smartFolders);

    expect(r1.suggestedName).toBe('doc.txt');
    expect(r2.suggestedName).toBe('doc.txt');
    expect(mockLlamaService.generateText).toHaveBeenCalledTimes(1);
  });

  describe('suggestedName sanitization', () => {
    const smartFolders = [{ name: 'Uncategorized', description: 'Uncategorized files' }];

    const analyzeWithSuggestedName = async (suggestedName, fileName) => {
      mockLlamaService.generateText.mockResolvedValue({
        response: JSON.stringify({ category: 'Uncategorized', confidence: 0.5, suggestedName })
      });
      // Distinct text per call defeats the analysis cache.
      return analyzeTextWithLlama(`content for ${suggestedName}`, fileName, smartFolders);
    };

    test('strips Windows-illegal characters and trailing dots, keeping the original extension', async () => {
      const result = await analyzeWithSuggestedName('Q3 <report>: "final"?. ', 'quarterly.pdf');
      expect(result.suggestedName).toBe('Q3 report final.pdf');
    });

    test('guards reserved device names', async () => {
      const result = await analyzeWithSuggestedName('CON', 'console-log.txt');
      expect(result.suggestedName).toBe('_CON.txt');
    });

    test('preserves unicode', async () => {
      const result = await analyzeWithSuggestedName('Résumé 東京', 'cv.docx');
      expect(result.suggestedName).toBe('Résumé 東京.docx');
    });

    test('rejects a name with nothing usable left and logs a warning', async () => {
      const result = await analyzeWithSuggestedName(':::', 'blank.txt');
      expect(result.suggestedName).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        '[documentLlm] suggestedName has no usable characters, rejecting',
        expect.objectContaining({ suggestedName: ':::', fileName: 'blank.txt' })
      );
    });
  });
});
