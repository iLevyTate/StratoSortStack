'use strict';

/**
 * H13: a cloud provider stopping at max_tokens during document analysis used
 * to become a hard per-file error. Truncated JSON is usually salvageable via
 * the extract/repair path, so the partial text is parsed when the provider
 * attaches it; otherwise the analysis falls back to the local model.
 */

const { analyzeTextWithLlama } = require('../../../src/main/analysis/documentLlm');
const { AIProviderError } = require('../../../src/main/services/ai/errors');

jest.mock('../../../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

const mockAnalyze = jest.fn();
jest.mock('../../../src/main/ipc/aiProvider', () => ({
  getActiveAiRouter: jest.fn(() => ({
    choose: jest.fn(() => ({
      id: 'openaiCompatible',
      displayName: 'OpenAI / Custom',
      analyze: mockAnalyze
    }))
  }))
}));

const mockLlamaService = {
  _initialized: true,
  initialize: jest.fn().mockResolvedValue(undefined),
  getConfig: jest.fn().mockResolvedValue({ textModel: 'test-model.gguf' }),
  listModels: jest.fn().mockResolvedValue([{ name: 'test-model.gguf' }]),
  updateConfig: jest.fn().mockResolvedValue(undefined),
  generateText: jest.fn()
};

jest.mock('../../../src/main/services/LlamaService', () => ({
  getInstance: () => mockLlamaService
}));

const smartFolders = [
  { name: 'Financial', description: 'Financial documents' },
  { name: 'Uncategorized', description: 'Uncategorized files' }
];

function truncatedError(partialText) {
  const err = new AIProviderError('OUTPUT_TRUNCATED', 'max_tokens reached');
  if (partialText !== undefined) err.partialText = partialText;
  return err;
}

describe('documentLlm cloud OUTPUT_TRUNCATED handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLlamaService.getConfig.mockResolvedValue({ textModel: 'test-model.gguf' });
    mockLlamaService.listModels.mockResolvedValue([{ name: 'test-model.gguf' }]);
  });

  test('salvages partialText through the JSON repair path instead of failing the file', async () => {
    // Unterminated JSON — exactly what a max_tokens stop leaves behind.
    mockAnalyze.mockRejectedValueOnce(
      truncatedError(
        '{"category":"Financial","keywords":["invoice","q1"],"confidence":0.9,"suggestedName":"invoice_q1","purpose":"Billing summ'
      )
    );

    const result = await analyzeTextWithLlama(
      'Invoice for Q1 services rendered (truncated-salvage case)',
      'invoice-salvage.txt',
      smartFolders
    );

    expect(result.error).toBeUndefined();
    expect(result.category).toBe('Financial');
    expect(result.keywords).toEqual(expect.arrayContaining(['invoice']));
    expect(mockLlamaService.generateText).not.toHaveBeenCalled();
  });

  test('falls back to the local model when OUTPUT_TRUNCATED carries no partial text', async () => {
    mockAnalyze.mockRejectedValueOnce(truncatedError(undefined));
    mockLlamaService.generateText.mockResolvedValueOnce({
      response: JSON.stringify({
        category: 'Financial',
        keywords: ['local'],
        confidence: 0.8,
        suggestedName: 'local_result'
      })
    });

    const result = await analyzeTextWithLlama(
      'Invoice for Q1 services rendered (truncated-no-partial case)',
      'invoice-fallback.txt',
      smartFolders
    );

    expect(result.category).toBe('Financial');
    expect(result.keywords).toEqual(['local']);
    expect(mockLlamaService.generateText).toHaveBeenCalledTimes(1);
  });
});
