/**
 * Focused tests for FolderMatchingService embedding behavior.
 * These cover the main correctness and regression risks:
 * - cache HIT vs MISS
 * - known-model dimension adjustment (pad/truncate)
 * - unknown-model dimension trust (no silent destruction)
 * - chunk pooling path on truncation
 */
const FolderMatchingService = require('../src/main/services/FolderMatchingService');

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
  generateEmbedding: jest.fn(),
  getConfig: jest.fn().mockReturnValue({ embeddingModel: 'mxbai-embed-large' }),
  onModelChange: jest.fn(() => () => {})
};

jest.mock('../src/main/services/LlamaService', () => ({
  getInstance: () => mockLlamaService
}));

const mockParallelEmbeddingService = {
  batchEmbedTexts: jest.fn()
};

jest.mock('../src/main/services/ParallelEmbeddingService', () => ({
  getInstance: () => mockParallelEmbeddingService
}));

jest.mock('../src/main/utils/embeddingInput', () => ({
  capEmbeddingInput: jest.fn((text) => ({
    text: String(text || ''),
    wasTruncated: false,
    estimatedTokens: 0,
    maxTokens: 0,
    maxChars: 2000
  }))
}));

describe('FolderMatchingService embedText', () => {
  let mockVectorDb;

  beforeEach(() => {
    jest.clearAllMocks();
    mockVectorDb = { initialize: jest.fn().mockResolvedValue(undefined) };
  });

  test('returns cached embedding on cache HIT (no llama call)', async () => {
    const svc = new FolderMatchingService(mockVectorDb, {
      parallelEmbeddingService: mockParallelEmbeddingService
    });

    svc.embeddingCache.get = jest.fn().mockReturnValue({
      vector: [1, 2, 3],
      model: 'mxbai-embed-large'
    });
    svc.embeddingCache.set = jest.fn();

    const result = await svc.embedText('hello');

    expect(result.vector).toEqual([1, 2, 3]);
    expect(mockLlamaService.generateEmbedding).not.toHaveBeenCalled();
    expect(svc.embeddingCache.set).not.toHaveBeenCalled();
  });

  // F-200 (CP-15): a known model returning the wrong dimension is a real
  // mismatch (wrong file behind the configured name, stale config). Padding
  // or truncating produced fake near-zero cosines and masked it; now it fails
  // loudly with a typed code so the caller / degraded-state tracker can act.
  test('rejects a known model that returns FEWER dimensions than expected', async () => {
    mockLlamaService.getConfig.mockReturnValueOnce({ embeddingModel: 'mxbai-embed-large' }); // expected 1024
    mockLlamaService.generateEmbedding.mockResolvedValueOnce({
      embedding: new Array(1000).fill(0.5)
    });

    const svc = new FolderMatchingService(mockVectorDb, {
      parallelEmbeddingService: mockParallelEmbeddingService
    });
    svc.embeddingCache.set = jest.fn();

    await expect(svc.embedText('hi')).rejects.toMatchObject({
      code: 'VECTOR_004',
      message: expect.stringMatching(/mxbai-embed-large.*1024.*1000/)
    });
    expect(svc.embeddingCache.set).not.toHaveBeenCalled();
  });

  test('rejects a known model that returns MORE dimensions than expected', async () => {
    mockLlamaService.getConfig.mockReturnValueOnce({ embeddingModel: 'all-minilm' }); // expected 384
    mockLlamaService.generateEmbedding.mockResolvedValueOnce({
      embedding: new Array(768).fill(0.25)
    });

    const svc = new FolderMatchingService(mockVectorDb, {
      parallelEmbeddingService: mockParallelEmbeddingService
    });

    await expect(svc.embedText('hi')).rejects.toMatchObject({ code: 'VECTOR_004' });
  });

  test('does not adjust dimension for unknown model names', async () => {
    mockLlamaService.getConfig.mockReturnValueOnce({ embeddingModel: 'mystery-embed-v9' });
    mockLlamaService.generateEmbedding.mockResolvedValueOnce({
      embedding: new Array(10).fill(0.1)
    });

    const svc = new FolderMatchingService(mockVectorDb, {
      parallelEmbeddingService: mockParallelEmbeddingService
    });

    const result = await svc.embedText('hi');
    expect(result.model).toBe('mystery-embed-v9');
    expect(result.vector).toHaveLength(10);
  });

  test('uses chunk pooling when input is truncated and batch embeddings succeed', async () => {
    const { capEmbeddingInput } = require('../src/main/utils/embeddingInput');
    capEmbeddingInput.mockReturnValueOnce({
      text: 'TRUNCATED',
      wasTruncated: true,
      estimatedTokens: 99999,
      maxTokens: 4096,
      maxChars: 50
    });

    mockLlamaService.getConfig.mockReturnValueOnce({ embeddingModel: 'nomic-embed-text' }); // expected 768

    // Make chunk pooling path succeed
    mockParallelEmbeddingService.batchEmbedTexts.mockResolvedValueOnce({
      results: [
        { success: true, vector: new Array(768).fill(0.2), model: 'nomic-embed-text' },
        { success: true, vector: new Array(768).fill(0.4), model: 'nomic-embed-text' }
      ]
    });

    const svc = new FolderMatchingService(mockVectorDb, {
      parallelEmbeddingService: mockParallelEmbeddingService
    });
    svc.embeddingCache.set = jest.fn();

    const result = await svc.embedText('x'.repeat(1000));

    expect(mockParallelEmbeddingService.batchEmbedTexts).toHaveBeenCalled();
    expect(result.vector).toHaveLength(768);
    // mean pooled => 0.3
    expect(result.vector[0]).toBeCloseTo(0.3, 6);
    expect(svc.embeddingCache.set).toHaveBeenCalled();
    // Should not fall through to single embedding generation when pooling succeeds
    expect(mockLlamaService.generateEmbedding).not.toHaveBeenCalled();
  });

  // CP-15: pooling used to pad/truncate to the expected dimension BEFORE the
  // mismatch check, so a wrong-model vector from the chunk-pool path was
  // silently padded, cached and stored.
  test('chunk pooling does not mask a wrong-dimension model', async () => {
    const { capEmbeddingInput } = require('../src/main/utils/embeddingInput');
    capEmbeddingInput.mockReturnValueOnce({
      text: 'TRUNCATED',
      wasTruncated: true,
      estimatedTokens: 99999,
      maxTokens: 4096,
      maxChars: 50
    });
    mockLlamaService.getConfig.mockReturnValue({ embeddingModel: 'nomic-embed-text' }); // expected 768
    mockParallelEmbeddingService.batchEmbedTexts.mockResolvedValueOnce({
      results: [
        { success: true, vector: new Array(512).fill(0.2), model: 'nomic-embed-text' },
        { success: true, vector: new Array(512).fill(0.4), model: 'nomic-embed-text' }
      ]
    });
    mockLlamaService.generateEmbedding.mockResolvedValueOnce({
      embedding: new Array(512).fill(0.3)
    });

    const svc = new FolderMatchingService(mockVectorDb, {
      parallelEmbeddingService: mockParallelEmbeddingService
    });
    svc.embeddingCache.set = jest.fn();

    try {
      await expect(svc.embedText('x'.repeat(1000))).rejects.toMatchObject({
        code: 'VECTOR_004'
      });
      expect(svc.embeddingCache.set).not.toHaveBeenCalled();
    } finally {
      mockLlamaService.getConfig.mockReturnValue({ embeddingModel: 'mxbai-embed-large' });
      // Drop the queued single-embed value if this path never consumed it.
      mockLlamaService.generateEmbedding.mockReset();
    }
  });

  test('retries with stricter truncation on embedding context overflow', async () => {
    const { capEmbeddingInput } = require('../src/main/utils/embeddingInput');
    capEmbeddingInput
      .mockReturnValueOnce({
        text: 'A'.repeat(1500),
        wasTruncated: false,
        estimatedTokens: 375,
        maxTokens: 460,
        maxChars: 1840
      })
      .mockReturnValueOnce({
        text: 'A'.repeat(900),
        wasTruncated: true,
        estimatedTokens: 500,
        maxTokens: 322,
        maxChars: 966
      });

    mockLlamaService.getConfig.mockReturnValueOnce({ embeddingModel: 'all-minilm' });
    mockLlamaService.generateEmbedding
      .mockRejectedValueOnce(
        new Error(
          'Llama operation failed: Input is longer than the context size. Try to increase the context size or use another model that supports longer contexts.'
        )
      )
      .mockResolvedValueOnce({
        embedding: new Array(384).fill(0.1)
      });

    const svc = new FolderMatchingService(mockVectorDb, {
      parallelEmbeddingService: mockParallelEmbeddingService
    });
    svc.embeddingCache.get = jest.fn().mockReturnValue(null);
    svc.embeddingCache.set = jest.fn();

    const result = await svc.embedText('A'.repeat(2200));

    expect(result.vector).toHaveLength(384);
    expect(mockLlamaService.generateEmbedding).toHaveBeenCalledTimes(2);
    expect(mockLlamaService.generateEmbedding).toHaveBeenNthCalledWith(1, 'A'.repeat(1500));
    expect(mockLlamaService.generateEmbedding).toHaveBeenNthCalledWith(2, 'A'.repeat(900));
    expect(capEmbeddingInput).toHaveBeenNthCalledWith(2, 'A'.repeat(2200), {
      maxTokens: 322,
      charsPerToken: 3,
      modelName: 'all-minilm'
    });
    expect(svc.embeddingCache.set).toHaveBeenCalledWith(
      'A'.repeat(900),
      'all-minilm',
      result.vector
    );
  });
});
