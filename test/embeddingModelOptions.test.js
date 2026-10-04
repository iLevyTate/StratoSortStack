jest.mock('../src/shared/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  },
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })
}));

jest.mock('../src/main/services/ServiceContainer', () => ({
  ServiceIds: {
    LLAMA_SERVICE: 'llamaService'
  },
  container: {
    tryResolve: jest.fn()
  }
}));

const { container } = require('../src/main/services/ServiceContainer');
const { AI_DEFAULTS } = require('../src/shared/constants');
const { resolveEmbeddingModelOptions } = require('../src/main/analysis/embeddingModelOptions');

describe('resolveEmbeddingModelOptions', () => {
  test('returns the configured embedding model and context size', async () => {
    container.tryResolve.mockReturnValue({
      getConfig: jest.fn().mockResolvedValue({
        embeddingModel: 'nomic-embed-text-v1.5-Q8_0.gguf',
        embeddingContextSize: 2048
      })
    });
    await expect(resolveEmbeddingModelOptions()).resolves.toEqual({
      embeddingModel: 'nomic-embed-text-v1.5-Q8_0.gguf',
      embeddingContextSize: 2048
    });
  });

  test('falls back to the default model when the service is unavailable', async () => {
    container.tryResolve.mockReturnValue(null);
    const result = await resolveEmbeddingModelOptions();
    expect(result.embeddingModel).toBe(AI_DEFAULTS.EMBEDDING.MODEL);
    expect(result.embeddingContextSize).toBeUndefined();
  });

  test('falls back to the default model when getConfig rejects', async () => {
    container.tryResolve.mockReturnValue({
      getConfig: jest.fn().mockRejectedValue(new Error('config load failed'))
    });
    await expect(resolveEmbeddingModelOptions()).resolves.toEqual({
      embeddingModel: AI_DEFAULTS.EMBEDDING.MODEL,
      embeddingContextSize: undefined
    });
  });

  test('falls back to the default model when the resolved service has no getConfig', async () => {
    container.tryResolve.mockReturnValue({});
    const result = await resolveEmbeddingModelOptions();
    expect(result.embeddingModel).toBe(AI_DEFAULTS.EMBEDDING.MODEL);
    expect(result.embeddingContextSize).toBeUndefined();
  });

  test('ignores a config without an embedding model', async () => {
    container.tryResolve.mockReturnValue({ getConfig: jest.fn().mockResolvedValue({}) });
    const result = await resolveEmbeddingModelOptions();
    expect(result.embeddingModel).toBe(AI_DEFAULTS.EMBEDDING.MODEL);
    expect(result.embeddingContextSize).toBeUndefined();
  });

  test.each([0, -512, Number.NaN, Number.POSITIVE_INFINITY])(
    'ignores a context size of %p instead of shrinking the budget',
    async (embeddingContextSize) => {
      container.tryResolve.mockReturnValue({
        getConfig: jest.fn().mockResolvedValue({
          embeddingModel: 'nomic-embed-text-v1.5-Q8_0.gguf',
          embeddingContextSize
        })
      });
      const result = await resolveEmbeddingModelOptions();
      expect(result.embeddingModel).toBe('nomic-embed-text-v1.5-Q8_0.gguf');
      expect(result.embeddingContextSize).toBeUndefined();
    }
  );
});
