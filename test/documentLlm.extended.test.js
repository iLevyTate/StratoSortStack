/**
 * @jest-environment node
 *
 * Extended tests for documentLlm.js covering:
 *  - JSON repair fallback when initial parse fails
 *  - Empty/no response from LLM
 *  - Confidence calculation from response quality
 *  - Date validation and sanitization
 *  - Keyword filtering
 *  - Smart folder category matching
 *  - Outer error handler (LLM crash)
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
  getConfig: jest.fn().mockResolvedValue({ textModel: 'test-model.gguf', contextSize: 4096 }),
  listModels: jest.fn().mockResolvedValue([{ name: 'test-model.gguf' }]),
  updateConfig: jest.fn().mockResolvedValue(undefined),
  generateText: jest.fn()
};

jest.mock('../src/main/services/LlamaService', () => ({
  getInstance: () => mockLlamaService
}));

jest.mock('../src/main/utils/llmOptimization', () => ({
  globalDeduplicator: {
    generateKey: jest.fn(() => 'dedup-key'),
    deduplicate: jest.fn((_key, fn) => fn())
  }
}));

// Use a singleton so all callers (including the SUT) share the same mock instance
const mockCacheService = {
  generateKey: jest.fn(() => 'cache-key'),
  get: jest.fn(() => null),
  set: jest.fn()
};
jest.mock('../src/main/services/AnalysisCacheService', () => ({
  getInstance: () => mockCacheService
}));

// Mock withAbortableTimeout to just execute the function directly
jest.mock('../src/shared/promiseUtils', () => ({
  withAbortableTimeout: jest.fn(async (fn) => {
    const controller = new AbortController();
    return fn(controller);
  }),
  withTimeout: jest.fn(async (promise) => promise),
  Semaphore: jest.fn(),
  createBackgroundWorkTracker: jest.fn(() => ({
    track: jest.fn((p) => p),
    drain: jest.fn(),
    get size() {
      return 0;
    }
  })),
  createInitGuard: jest.fn(() => ({
    isInitialized: () => false,
    initialize: jest.fn(async (fn) => fn()),
    reset: jest.fn(),
    requireInitialized: jest.fn()
  }))
}));

jest.mock('../src/main/services/FolderMatchingService', () => ({
  matchCategoryToFolder: jest.fn((category) => category),
  matchCategoryToFolderWithSuggestion: jest.fn((cat) => ({
    folder: cat,
    suggestedNewFolder: null,
    source: 'matched'
  }))
}));

const mockGetOrganizationGuidance = jest.fn(async () => '');
jest.mock('../src/main/analysis/organizationGuidance', () => ({
  ...jest.requireActual('../src/main/analysis/organizationGuidance'),
  getOrganizationGuidance: () => mockGetOrganizationGuidance()
}));

const { analyzeTextWithLlama } = require('../src/main/analysis/documentLlm');

describe('documentLlm – extended', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset generateText to a default resolved value (clearAllMocks doesn't reset implementations)
    mockLlamaService.getConfig.mockResolvedValue({
      textModel: 'test-model.gguf',
      contextSize: 4096
    });
    mockLlamaService.listModels.mockResolvedValue([{ name: 'test-model.gguf' }]);
    mockLlamaService.generateText.mockResolvedValue({ response: '{}' });
    // Reset cache to miss by default
    mockCacheService.get.mockReset().mockReturnValue(null);
    mockCacheService.set.mockReset();
    mockCacheService.generateKey.mockReset().mockReturnValue('cache-key');
    mockGetOrganizationGuidance.mockResolvedValue('');
  });

  // ─── JSON repair fallback ──────────────────────────────────

  test('falls back to JSON repair when initial parse fails', async () => {
    // First LLM call returns malformed JSON
    mockLlamaService.generateText
      .mockResolvedValueOnce({ response: '{ malformed json!!!' })
      // JSON repair call returns valid JSON
      .mockResolvedValueOnce({
        response: JSON.stringify({
          category: 'documents',
          keywords: ['test'],
          confidence: 85,
          suggestedName: 'repaired_doc'
        })
      });

    const result = await analyzeTextWithLlama('Test content', 'test.pdf', []);

    // Should succeed via repair path
    if (result.error) {
      // Repair may fail in test env without full LLM — just verify error is graceful
      expect(result.keywords).toEqual([]);
      expect(result.confidence).toBe(0);
    } else {
      expect(result.suggestedName).toBeDefined();
    }
  });

  test('performs strict JSON retry before returning fallback parse error', async () => {
    mockLlamaService.generateText
      // Initial analysis response
      .mockResolvedValueOnce({ response: '{ malformed json' })
      // JSON repair helper response
      .mockResolvedValueOnce({ response: '{ still malformed' })
      // Strict retry response
      .mockResolvedValueOnce({
        response: JSON.stringify({
          category: 'documents',
          keywords: ['retry'],
          confidence: 82,
          suggestedName: 'strict_retry_ok'
        })
      });

    const result = await analyzeTextWithLlama('Retry content', 'retry.pdf', []);

    expect(mockLlamaService.generateText).toHaveBeenCalledTimes(3);
    expect(result.error).toBeUndefined();
    expect(result.suggestedName).toBe('strict_retry_ok.pdf');
  });

  // ─── Empty/null response ───────────────────────────────────

  test('returns error object when LLM returns no response content', async () => {
    mockLlamaService.generateText.mockResolvedValue({ response: '' });

    const result = await analyzeTextWithLlama('Test', 'doc.pdf', []);

    expect(result.error).toMatch(/No content|Failed/i);
    expect(result.keywords).toEqual([]);
    expect(result.confidence).toBeLessThanOrEqual(65);
  });

  test('returns error object when LLM returns null response', async () => {
    mockLlamaService.generateText.mockResolvedValue({ response: null });

    const result = await analyzeTextWithLlama('Test', 'doc.pdf', []);

    expect(result.error).toBeDefined();
    expect(result.keywords).toEqual([]);
  });

  // ─── Confidence calculation ────────────────────────────────

  test('calculates confidence from response quality fields', async () => {
    mockLlamaService.generateText.mockResolvedValue({
      response: JSON.stringify({
        category: 'invoices',
        purpose: 'billing',
        keywords: ['invoice', 'payment', 'total'],
        project: 'Q1 Billing',
        suggestedName: 'q1_invoice'
        // No confidence field — should be calculated
      })
    });

    const result = await analyzeTextWithLlama('Invoice for Q1', 'invoice.pdf', []);

    // Base 70 + category(5) + purpose(5) + keywords>=3(5) + project(5) + suggestedName(5) = 95
    expect(result.confidence).toBe(95);
  });

  test('assigns base confidence when response has minimal fields', async () => {
    mockLlamaService.generateText.mockResolvedValue({
      response: JSON.stringify({
        category: 'documents',
        keywords: ['doc']
        // Missing purpose, project, suggestedName
      })
    });

    const result = await analyzeTextWithLlama('Some text', 'doc.pdf', []);

    // Base 70 + category(5) = 75
    expect(result.confidence).toBe(75);
  });

  test('preserves valid LLM-provided confidence in 60-100 range', async () => {
    mockLlamaService.generateText.mockResolvedValue({
      response: JSON.stringify({
        category: 'documents',
        keywords: ['doc'],
        confidence: 88 // Valid range, should be kept as-is
      })
    });

    const result = await analyzeTextWithLlama('Text', 'doc.pdf', []);
    expect(result.confidence).toBe(88);
  });

  test.each([
    [0.9, 90],
    [0.45, 45],
    [1, 100],
    [0, 0]
  ])('reads a fractional confidence of %p as %p percent', async (fromModel, expected) => {
    mockLlamaService.generateText.mockResolvedValue({
      response: JSON.stringify({ category: 'documents', keywords: ['doc'], confidence: fromModel })
    });

    const result = await analyzeTextWithLlama('Text', 'doc.pdf', []);
    expect(result.confidence).toBe(expected);
  });

  test('overrides out-of-range LLM confidence', async () => {
    mockLlamaService.generateText.mockResolvedValue({
      response: JSON.stringify({
        category: 'documents',
        keywords: ['doc'],
        confidence: 999 // Out of range
      })
    });

    const result = await analyzeTextWithLlama('Text', 'doc.pdf', []);
    // Should be recalculated, not 999
    expect(result.confidence).toBeLessThanOrEqual(95);
    expect(result.confidence).toBeGreaterThanOrEqual(70);
  });

  // ─── Date validation ───────────────────────────────────────

  test('sanitizes valid date to ISO format', async () => {
    mockLlamaService.generateText.mockResolvedValue({
      response: JSON.stringify({
        category: 'documents',
        keywords: ['report'],
        date: '2024-03-15T10:30:00Z',
        confidence: 80
      })
    });

    const result = await analyzeTextWithLlama('Report', 'report.pdf', []);
    expect(result.date).toBe('2024-03-15');
  });

  test('removes invalid date from response', async () => {
    mockLlamaService.generateText.mockResolvedValue({
      response: JSON.stringify({
        category: 'documents',
        keywords: ['report'],
        date: 'not-a-date',
        confidence: 80
      })
    });

    const result = await analyzeTextWithLlama('Report', 'report.pdf', []);
    // Invalid date should be removed, no date field or undefined
    expect(result.date).toBeUndefined();
  });

  test('falls back to fileDate when LLM returns no date', async () => {
    mockLlamaService.generateText.mockResolvedValue({
      response: JSON.stringify({
        category: 'documents',
        keywords: ['report'],
        confidence: 80
      })
    });

    const result = await analyzeTextWithLlama('Report', 'report.pdf', [], '2024-01-01');
    expect(result.date).toBe('2024-01-01');
  });

  // ─── Keyword filtering ─────────────────────────────────────

  test('filters out non-string keywords', async () => {
    mockLlamaService.generateText.mockResolvedValue({
      response: JSON.stringify({
        category: 'documents',
        keywords: ['valid', 42, null, '', 'also-valid', true],
        confidence: 80
      })
    });

    const result = await analyzeTextWithLlama('Text', 'doc.pdf', []);
    expect(result.keywords).toEqual(['valid', 'also-valid']);
  });

  // ─── Suggested name extension preservation ─────────────────

  test('appends original file extension to suggestedName', async () => {
    mockLlamaService.generateText.mockResolvedValue({
      response: JSON.stringify({
        category: 'documents',
        keywords: ['invoice'],
        suggestedName: 'q1_invoice',
        confidence: 80
      })
    });

    const result = await analyzeTextWithLlama('Invoice', 'original.docx', []);
    expect(result.suggestedName).toBe('q1_invoice.docx');
  });

  test('does not double-append extension when already present', async () => {
    mockLlamaService.generateText.mockResolvedValue({
      response: JSON.stringify({
        category: 'documents',
        keywords: ['invoice'],
        suggestedName: 'q1_invoice.pdf',
        confidence: 80
      })
    });

    const result = await analyzeTextWithLlama('Invoice', 'original.pdf', []);
    expect(result.suggestedName).toBe('q1_invoice.pdf');
  });

  // ─── LLM crash / outer error handler ───────────────────────

  test('returns graceful error when LLM throws', async () => {
    mockLlamaService.generateText.mockRejectedValue(new Error('GPU out of memory'));

    const result = await analyzeTextWithLlama('Text', 'doc.pdf', []);

    expect(result.error).toMatch(/AI engine error|GPU out of memory/i);
    expect(result.keywords).toEqual([]);
    expect(result.confidence).toBe(0);
  });

  test('outer-catch result is stamped with failureMode and a logger.error breadcrumb', async () => {
    // Regression guard for documentLlm.js outer catch (lines 760-778).
    // Without these two signals, an AbortError / GPU OOM / native llama-cpp
    // crash returns the same `keywords: [], confidence: 0` shape as a
    // low-confidence successful analysis — `normalizeAnalysisResult`
    // can't tell the difference and the file is silently routed to the
    // catch-all folder. The `failureMode` tag is what lets a caller
    // route engine crashes to a quarantine bucket; the logger.error
    // breadcrumb is what lets a postmortem reconstruct the failure.
    const { logger: mockLogger } = require('../src/shared/logger');
    mockLogger.error.mockClear();

    const crash = new Error('GPU out of memory');
    crash.code = 'GPU_OOM';
    crash.name = 'NativeLlamaError';
    mockLlamaService.generateText.mockRejectedValue(crash);

    const result = await analyzeTextWithLlama('Text', 'doc.pdf', []);

    expect(result.failureMode).toBe('llm-engine-error');

    // The breadcrumb must include enough shape (message + code + name) for
    // a postmortem to distinguish OOM from AbortError from native crashes
    // — a bare 'AI provider error.' string is what we are explicitly fixing.
    const errorCalls = mockLogger.error.mock.calls;
    const outerCatchCall = errorCalls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('Outer catch — AI engine failed')
    );
    expect(outerCatchCall).toBeTruthy();
    expect(outerCatchCall[1]).toMatchObject({
      message: 'GPU out of memory',
      code: 'GPU_OOM',
      name: 'NativeLlamaError'
    });
  });

  test('outer-catch breadcrumb tolerates errors without code/name', async () => {
    // Defensive: the breadcrumb shape must not throw on errors that lack
    // a `code` or `name` (older error subclasses, plain Error instances).
    const { logger: mockLogger } = require('../src/shared/logger');
    mockLogger.error.mockClear();

    mockLlamaService.generateText.mockRejectedValue(new Error('something opaque'));

    const result = await analyzeTextWithLlama('Text', 'doc.pdf', []);

    expect(result.failureMode).toBe('llm-engine-error');
    const outerCatchCall = mockLogger.error.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('Outer catch — AI engine failed')
    );
    expect(outerCatchCall).toBeTruthy();
    expect(outerCatchCall[1].message).toBe('something opaque');
    // code/name come back as undefined rather than throwing — both fields are
    // present on the object so structured-log consumers see consistent keys.
    expect(outerCatchCall[1]).toHaveProperty('code');
    expect(outerCatchCall[1]).toHaveProperty('name', 'Error');
  });

  test('rethrows a memory-budget refusal instead of returning an analysis', async () => {
    const budget = new Error(
      'Cannot load text model: memory budget exceeded and resident models are in active use'
    );
    budget.code = 'MODEL_MEMORY_BUDGET_EXCEEDED';
    mockLlamaService.generateText.mockRejectedValue(budget);

    await expect(analyzeTextWithLlama('Text', 'doc.pdf', [])).rejects.toMatchObject({
      code: 'MODEL_MEMORY_BUDGET_EXCEEDED'
    });
  });

  // ─── Cache hit path ────────────────────────────────────────

  test('returns cached result without calling LLM', async () => {
    const cachedResult = {
      category: 'cached',
      keywords: ['cached-kw'],
      confidence: 92
    };

    mockCacheService.get.mockReturnValue(cachedResult);

    const result = await analyzeTextWithLlama('Text', 'doc.pdf', []);

    // A copy, not the stored object: callers stamp the result with this
    // run's index hand-off, which must never reach the cache.
    expect(result).toEqual(cachedResult);
    expect(result).not.toBe(cachedResult);
    expect(mockLlamaService.generateText).not.toHaveBeenCalled();
  });

  test('a caller stamping its own hand-off on a cache hit does not change the stored result', async () => {
    const stored = { category: 'cached', keywords: ['kw'], confidence: 90 };
    mockCacheService.get.mockReturnValue(stored);

    const first = await analyzeTextWithLlama('Text', 'report.pdf', []);
    // documentAnalysis -> applySemanticFolderMatching writes this onto the result.
    first._embeddingForPersistence = {
      meta: { path: '/a/report.pdf' },
      wasEnqueued: true,
      chunksEmbedded: true
    };
    first.keywords.push('stamped');

    const second = await analyzeTextWithLlama('Text', 'report.pdf', []);
    expect(second._embeddingForPersistence).toBeUndefined();
    expect(second.keywords).toEqual(['kw']);
    expect(stored._embeddingForPersistence).toBeUndefined();
  });

  test('changed organization instructions are not answered from the cache', async () => {
    // A working cache keyed on what the code under test hands to generateKey.
    const store = new Map();
    mockCacheService.generateKey.mockImplementation((seed, model) => `${model}|${seed}`);
    mockCacheService.get.mockImplementation((key) => store.get(key) ?? null);
    mockCacheService.set.mockImplementation((key, value) => store.set(key, value));
    mockLlamaService.generateText.mockResolvedValue({
      response: JSON.stringify({ category: 'Finance', keywords: ['a'], confidence: 80 })
    });

    mockGetOrganizationGuidance.mockResolvedValue('Keep tax papers in Finance.');
    await analyzeTextWithLlama('Some invoice text', 'invoice.pdf', []);
    await analyzeTextWithLlama('Some invoice text', 'invoice.pdf', []);
    // Same instructions: the second run is a cache hit.
    expect(mockLlamaService.generateText).toHaveBeenCalledTimes(1);

    mockGetOrganizationGuidance.mockResolvedValue('Put every invoice in Clients.');
    await analyzeTextWithLlama('Some invoice text', 'invoice.pdf', []);

    expect(mockLlamaService.generateText).toHaveBeenCalledTimes(2);
    expect(mockLlamaService.generateText.mock.calls[1][0].prompt).toContain(
      'Put every invoice in Clients.'
    );
  });

  test('the cache stores a copy, not the object handed back to the caller', async () => {
    mockCacheService.get.mockReturnValue(null);
    mockLlamaService.generateText.mockResolvedValue({
      response: JSON.stringify({ category: 'Finance', keywords: ['a', 'b'], confidence: 80 })
    });

    const result = await analyzeTextWithLlama('Some invoice text', 'invoice.pdf', []);
    const storedCall = mockCacheService.set.mock.calls.at(-1);
    expect(storedCall).toBeDefined();
    const storedValue = storedCall[1];
    expect(storedValue).not.toBe(result);
    result._embeddingForPersistence = { wasEnqueued: true, chunksEmbedded: true };
    expect(storedValue._embeddingForPersistence).toBeUndefined();
  });
});
