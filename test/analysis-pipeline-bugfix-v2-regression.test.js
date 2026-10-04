/**
 * @jest-environment node
 *
 * Regression tests for analysis pipeline bug fixes (review cycle 2).
 *
 * Bug 1: Partial batch failure derived success count
 * Bug 3: Dead letter queue prune-after-push ordering
 * Bug 4: Failed item LRU eviction null guard
 * Bug 8: Content selection body budget safety margin
 * Bug 9: Embedding summary keyword/entity cap
 */

// ── Shared mocks ─────────────────────────────────────────────────────────────

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

jest.mock('../src/shared/promiseUtils', () => ({
  withTimeout: jest.fn((p) => p)
}));

jest.mock('../src/shared/performanceConstants', () => ({
  TIMEOUTS: { EMBEDDING_REQUEST: 1000, BATCH_EMBEDDING_MAX: 1000 },
  RETRY: { BACKOFF_BASE_MS: 100 },
  CONTENT_SELECTION: {
    OUTLINE_RATIO: 0.05,
    HEAD_RATIO: 0.37,
    TAIL_RATIO: 0.16,
    MIDDLE_SAMPLE_COUNT: 4,
    MARKER_OVERHEAD: 80
  }
}));

jest.mock('../src/main/analysis/embeddingQueue/persistence', () => ({
  persistFailedItems: jest.fn().mockResolvedValue(undefined),
  persistDeadLetterQueue: jest.fn().mockResolvedValue(undefined),
  SQLITE_KEYS: { failedItems: 'failedItems', deadLetter: 'deadLetter' }
}));

// ── Bug 1: Partial batch failure derives success count from items.length - failed.length ──

describe('Bug 1: partial batch failure count', () => {
  const {
    processItemsInParallel
  } = require('../src/main/analysis/embeddingQueue/parallelProcessor');

  function makeItems(count) {
    return Array.from({ length: count }, (_, i) => ({
      id: `file:item${i}.txt`,
      vector: [0.1, 0.2],
      meta: { path: `/path/item${i}.txt` },
      model: 'test',
      updatedAt: new Date().toISOString()
    }));
  }

  test('file batch: processedCount reflects items.length - failed.length, not result.count', async () => {
    const items = makeItems(5);
    // Service reports count: 0 but only 1 item actually failed
    // (simulating an inaccurate count from the vector service)
    const vectorDbService = {
      batchUpsertFiles: jest.fn().mockResolvedValue({
        count: 0, // Inaccurate!
        failed: [{ id: 'file:item2.txt', error: 'bad_vector' }]
      })
    };
    const onProgress = jest.fn();
    const onItemFailed = jest.fn();
    const failedItemIds = new Set();

    const processed = await processItemsInParallel({
      items,
      type: 'file',
      vectorDbService,
      failedItemIds,
      startProcessedCount: 0,
      totalBatchSize: 5,
      concurrency: 2,
      onProgress,
      onItemFailed
    });

    // Should be 4 (5 items - 1 failed), NOT 0 (the inaccurate result.count)
    expect(processed).toBe(4);
    expect(onItemFailed).toHaveBeenCalledTimes(1);
    expect(failedItemIds.has('file:item2.txt')).toBe(true);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ completed: 4 }));
  });

  test('folder batch: processedCount reflects items.length - failed.length', async () => {
    const items = makeItems(3).map((item) => ({
      ...item,
      id: item.id.replace('file:', 'folder:'),
      meta: { ...item.meta, name: 'TestFolder' }
    }));
    const vectorDbService = {
      batchUpsertFolders: jest.fn().mockResolvedValue({
        count: 1, // Says 1 but 2 actually succeeded
        failed: [{ id: 'folder:item0.txt', error: 'timeout' }]
      })
    };
    const onProgress = jest.fn();
    const onItemFailed = jest.fn();
    const failedItemIds = new Set();

    const processed = await processItemsInParallel({
      items,
      type: 'folder',
      vectorDbService,
      failedItemIds,
      startProcessedCount: 0,
      totalBatchSize: 3,
      concurrency: 2,
      onProgress,
      onItemFailed
    });

    // 3 items - 1 failed = 2, regardless of result.count
    expect(processed).toBe(2);
    expect(failedItemIds.has('folder:item0.txt')).toBe(true);
  });

  test('all items failed: processedCount is 0', async () => {
    const items = makeItems(2);
    const vectorDbService = {
      batchUpsertFiles: jest.fn().mockResolvedValue({
        count: 0,
        failed: [
          { id: 'file:item0.txt', error: 'err' },
          { id: 'file:item1.txt', error: 'err' }
        ]
      })
    };
    const onProgress = jest.fn();
    const onItemFailed = jest.fn();
    const failedItemIds = new Set();

    const processed = await processItemsInParallel({
      items,
      type: 'file',
      vectorDbService,
      failedItemIds,
      startProcessedCount: 0,
      totalBatchSize: 2,
      concurrency: 2,
      onProgress,
      onItemFailed
    });

    expect(processed).toBe(0);
    expect(onProgress).not.toHaveBeenCalled();
    expect(onItemFailed).toHaveBeenCalledTimes(2);
  });
});

// ── Bug 3: Dead letter queue prune-after-push ordering ───────────────────────

describe('Bug 3: dead letter queue holds maxDeadLetterSize items before pruning', () => {
  const {
    createFailedItemHandler
  } = require('../src/main/analysis/embeddingQueue/failedItemHandler');

  test('queue can hold exactly maxDeadLetterSize items', () => {
    const handler = createFailedItemHandler({
      itemMaxRetries: 3,
      maxDeadLetterSize: 5,
      maxFailedItemsSize: 100,
      failedItemsPath: '/tmp/f.json',
      deadLetterPath: '/tmp/d.json'
    });

    for (let i = 0; i < 5; i++) {
      handler.addToDeadLetterQueue({ id: `file:${i}` }, `err${i}`, 1);
    }

    // Queue should hold all 5 items (maxDeadLetterSize) without pruning
    expect(handler.deadLetterQueue.length).toBe(5);
    expect(handler.deadLetterQueue[0].itemId).toBe('file:0');
  });

  test('pruning triggers only when exceeding maxDeadLetterSize', () => {
    const handler = createFailedItemHandler({
      itemMaxRetries: 3,
      maxDeadLetterSize: 5,
      maxFailedItemsSize: 100,
      failedItemsPath: '/tmp/f.json',
      deadLetterPath: '/tmp/d.json'
    });

    // Fill to capacity
    for (let i = 0; i < 5; i++) {
      handler.addToDeadLetterQueue({ id: `file:${i}` }, `err${i}`, 1);
    }

    // 6th item causes pruning (length was 5, push to 6, 6 > 5 triggers prune)
    handler.addToDeadLetterQueue({ id: 'file:new' }, 'new_err', 1);

    // After prune: 1 item removed (10% of 5 = 0.5, Math.max(1, 0) = 1), then 5 remain
    expect(handler.deadLetterQueue.length).toBe(5);
    expect(handler.deadLetterQueue[0].itemId).toBe('file:1'); // file:0 was pruned
  });
});

// ── Bug 4: Failed item LRU eviction null guard ──────────────────────────────

describe('Bug 4: LRU eviction does not crash on missing entry', () => {
  const {
    createFailedItemHandler
  } = require('../src/main/analysis/embeddingQueue/failedItemHandler');

  test('no crash when failedItems map entry is absent during eviction', () => {
    const handler = createFailedItemHandler({
      itemMaxRetries: 3,
      maxDeadLetterSize: 50,
      maxFailedItemsSize: 3,
      failedItemsPath: '/tmp/f.json',
      deadLetterPath: '/tmp/d.json'
    });

    // Fill to capacity
    for (let i = 0; i < 3; i++) {
      handler.trackFailedItem({ id: `file:item${i}` }, `err${i}`);
    }
    expect(handler.failedItems.size).toBe(3);

    // Adding a 4th should evict the oldest and NOT throw
    expect(() => {
      handler.trackFailedItem({ id: 'file:new' }, 'new_err');
    }).not.toThrow();

    expect(handler.failedItems.size).toBe(3);
    expect(handler.failedItems.has('file:item0')).toBe(false); // evicted
    expect(handler.failedItems.has('file:new')).toBe(true);
    // Evicted item should be in dead letter queue
    expect(handler.deadLetterQueue.length).toBe(1);
    expect(handler.deadLetterQueue[0].itemId).toBe('file:item0');
  });
});

// ── Bug 8: Content selection body budget safety margin ──────────────────────

describe('Bug 8: content selection preserves [END] section for near-budget docs', () => {
  const { selectRepresentativeContent } = require('../src/main/analysis/contentSelector');

  test('assembled content includes [END] marker for documents barely exceeding budget', () => {
    const budget = 1000;
    // Create text just slightly over budget to trigger smart selection
    const text = 'A'.repeat(budget + 100);

    const { content, strategy } = selectRepresentativeContent(text, budget);

    expect(strategy).toBe('representative');
    // The [END] section should be present in the output
    expect(content).toContain('[END]');
    expect(content.length).toBeLessThanOrEqual(budget);
  });

  test('hard cap does not truncate tail content for moderately oversized docs', () => {
    const budget = 2000;
    // Make a document 2x the budget with distinct end content
    const beginning = 'BEGIN '.repeat(300);
    const ending = 'ENDING '.repeat(100);
    const text = beginning + 'M'.repeat(1500) + ending;

    const { content } = selectRepresentativeContent(text, budget);

    // Should contain [END] marker (tail section survived the hard cap)
    expect(content).toContain('[END]');
    expect(content.length).toBeLessThanOrEqual(budget);
  });
});

// ── Bug 9: Embedding summary keyword/entity cap ─────────────────────────────

describe('Bug 9: buildEmbeddingSummary caps keywords and entities', () => {
  jest.resetModules();

  jest.mock('../src/main/utils/embeddingInput', () => ({
    capEmbeddingInput: jest.fn((text) => ({
      text,
      wasTruncated: false,
      estimatedTokens: Math.ceil(text.length / 3.5),
      maxTokens: 512,
      maxChars: 1792
    })),
    getEmbeddingTokenLimit: jest.fn(() => 512)
  }));

  jest.mock('../src/main/analysis/semanticExtensionMap', () => ({
    enrichFileTextForEmbedding: jest.fn((text) => text)
  }));

  const { buildEmbeddingSummary } = require('../src/main/analysis/embeddingSummary');

  test('keywords are capped at 20', () => {
    const manyKeywords = Array.from({ length: 50 }, (_, i) => `keyword${i}`);
    const analysis = { summary: 'Test', keywords: manyKeywords, keyEntities: [] };

    const result = buildEmbeddingSummary(analysis, '', '.txt');

    // Only first 20 keywords should appear
    expect(result.text).toContain('keyword0');
    expect(result.text).toContain('keyword19');
    expect(result.text).not.toContain('keyword20');
    expect(result.text).not.toContain('keyword49');
  });

  test('keyEntities are capped at 15', () => {
    const manyEntities = Array.from({ length: 30 }, (_, i) => `entity${i}`);
    const analysis = { summary: 'Test', keywords: [], keyEntities: manyEntities };

    const result = buildEmbeddingSummary(analysis, '', '.txt');

    // Only first 15 entities should appear
    expect(result.text).toContain('entity0');
    expect(result.text).toContain('entity14');
    expect(result.text).not.toContain('entity15');
    expect(result.text).not.toContain('entity29');
  });

  test('large keyword array does not crowd out text snippet', () => {
    const hugeKeywords = Array.from({ length: 100 }, (_, i) => `longkeyword_${i}_padding`);
    const analysis = { summary: 'S', keywords: hugeKeywords, keyEntities: [] };
    const longText = 'X'.repeat(3000);

    const result = buildEmbeddingSummary(analysis, longText, '.pdf');

    // With capping, the text snippet should still get significant representation
    const xCount = (result.text.match(/X/g) || []).length;
    expect(xCount).toBeGreaterThan(400); // At least 400 chars of extracted text
  });
});
