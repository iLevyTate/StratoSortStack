'use strict';

const { summarizeChunks } = require('../../../src/main/analysis/documentLlm');

jest.mock('../../../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

const mockAnalyze = jest.fn(async () => ({ text: '- key fact one\n- key fact two' }));

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
  generateText: jest.fn(async () => ({ response: '- local summary' }))
};

describe('documentLlm summarizeChunks router integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('uses cloud router backend when active instead of local llamaService', async () => {
    const text = 'A'.repeat(16000);
    const result = await summarizeChunks(text, mockLlamaService, { smartFolderId: null });

    expect(result).toContain('key fact');
    expect(mockAnalyze).toHaveBeenCalled();
    expect(mockLlamaService.generateText).not.toHaveBeenCalled();
  });

  test('falls back to llamaService when router is unavailable', async () => {
    const aiProvider = require('../../../src/main/ipc/aiProvider');
    aiProvider.getActiveAiRouter.mockReturnValueOnce(null);

    const text = 'B'.repeat(16000);
    const result = await summarizeChunks(text, mockLlamaService, {});

    expect(result).toContain('local summary');
    expect(mockLlamaService.generateText).toHaveBeenCalled();
  });
});
