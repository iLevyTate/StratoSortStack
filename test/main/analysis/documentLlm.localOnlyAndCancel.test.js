'use strict';

/**
 * Two routing guarantees of analyzeTextWithLlama:
 *  - forceLocal (OCR text from local images) keeps EVERY inference call local,
 *    including the map-reduce chunk summaries of deep analysis.
 *  - a user cancel during a cloud call never starts a local re-run of the
 *    cancelled file, whatever error the provider reports for the cancel.
 * Fake cloud provider only; no network.
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

const LOCAL_JSON = JSON.stringify({
  category: 'Financial',
  keywords: ['local'],
  confidence: 0.8,
  suggestedName: 'local_result'
});

const mockLlamaService = {
  _initialized: true,
  initialize: jest.fn().mockResolvedValue(undefined),
  getConfig: jest.fn(),
  listModels: jest.fn(),
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

describe('documentLlm local-only and cancel routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLlamaService.getConfig.mockResolvedValue({ textModel: 'test-model.gguf' });
    mockLlamaService.listModels.mockResolvedValue([{ name: 'test-model.gguf' }]);
    mockLlamaService.generateText.mockResolvedValue({ response: LOCAL_JSON });
    mockAnalyze.mockResolvedValue({ text: LOCAL_JSON });
  });

  test('forceLocal keeps deep-analysis chunk summaries off the cloud provider', async () => {
    mockLlamaService.getConfig.mockResolvedValue({
      textModel: 'test-model.gguf',
      deepAnalysis: true
    });
    const ocrText = 'Scanned receipt line with totals. '.repeat(3500); // > 100k chars

    await analyzeTextWithLlama(ocrText, 'scan.png', smartFolders, null, [], {
      forceLocal: true,
      bypassCache: true
    });

    expect(mockAnalyze).not.toHaveBeenCalled();
    expect(mockLlamaService.generateText).toHaveBeenCalled();
  });

  test('without forceLocal, deep analysis may use the cloud provider (unchanged)', async () => {
    mockLlamaService.getConfig.mockResolvedValue({
      textModel: 'test-model.gguf',
      deepAnalysis: true
    });
    const text = 'Quarterly invoice ledger entry. '.repeat(3500);
    await analyzeTextWithLlama(text, 'ledger.txt', smartFolders, null, [], { bypassCache: true });
    expect(mockAnalyze).toHaveBeenCalled();
  });

  test.each([
    ['NETWORK_ERROR', () => new AIProviderError('NETWORK_ERROR', 'Failed to reach host: aborted')],
    ['AbortError', () => Object.assign(new Error('Operation aborted'), { name: 'AbortError' })]
  ])(
    'a cancel during the cloud call (%s) does not start a local fallback',
    async (_label, makeError) => {
      const ac = new AbortController();
      mockAnalyze.mockImplementation(async (_prompt, opts) => {
        ac.abort();
        // Let the abort propagate to the per-call controller first.
        await new Promise((r) => setTimeout(r, 0));
        expect(opts.signal.aborted).toBe(true);
        throw makeError();
      });

      await analyzeTextWithLlama('Invoice for services', 'cancel.txt', smartFolders, null, [], {
        signal: ac.signal,
        bypassCache: true
      }).catch(() => {});
      // Give any detached fallback a chance to start.
      await new Promise((r) => setTimeout(r, 20));

      expect(mockAnalyze).toHaveBeenCalled();
      expect(mockLlamaService.generateText).not.toHaveBeenCalled();
    }
  );

  test('a real (uncancelled) network failure still falls back to local', async () => {
    mockAnalyze.mockRejectedValue(new AIProviderError('NETWORK_ERROR', 'Failed to reach host'));
    const result = await analyzeTextWithLlama(
      'Invoice for services (network failure)',
      'net.txt',
      smartFolders,
      null,
      [],
      { signal: new AbortController().signal, bypassCache: true }
    );
    expect(mockLlamaService.generateText).toHaveBeenCalled();
    expect(result.keywords).toEqual(['local']);
  });
});
