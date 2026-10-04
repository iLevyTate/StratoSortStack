/**
 * @jest-environment node
 *
 * Covers the diagnostics metric-accounting fixes:
 *   1. `recordSuccess()` increments `successfulOperations` (previously dead code).
 *   2. `errorRate` is measured against total operations (success + failure) so
 *      it can never exceed 100%, even on failure-heavy runs where failures do
 *      not increment `processedFiles`.
 *   3. `destroy()` resets the lifetime processing counters.
 *   4. `getPipelineSummary()` exposes a `fallbackReasons` breakdown aggregated
 *      from the recent window (primary outcomes and null reasons excluded).
 */

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const systemAnalytics = require('../src/main/core/systemAnalytics');

describe('systemAnalytics metric accounting', () => {
  beforeEach(() => {
    // destroy() now resets the lifetime counters and pipeline/stability state.
    systemAnalytics.destroy();
  });

  test('recordSuccess increments successfulOperations', async () => {
    systemAnalytics.recordSuccess();
    systemAnalytics.recordSuccess();

    const metrics = await systemAnalytics.collectMetrics();
    expect(metrics.successfulOperations).toBe(2);
  });

  test('avgProcessingTime is the mean of per-file samples', async () => {
    systemAnalytics.recordProcessingTime(1000);
    systemAnalytics.recordProcessingTime(3000);

    const metrics = await systemAnalytics.collectMetrics();
    expect(metrics.processedFiles).toBe(2);
    expect(metrics.avgProcessingTime).toBe(2000);
  });

  test('errorRate is measured against total operations and never exceeds 100%', async () => {
    systemAnalytics.recordSuccess();
    systemAnalytics.recordFailure(new Error('a'));
    systemAnalytics.recordFailure(new Error('b'));
    systemAnalytics.recordFailure(new Error('c'));

    // 3 failures / (1 success + 3 failures) = 75%
    const metrics = await systemAnalytics.collectMetrics();
    expect(metrics.errorRate).toBe(75);
    expect(metrics.errorRate).toBeLessThanOrEqual(100);
  });

  test('errorRate is 100% (not >100) when every operation failed', async () => {
    systemAnalytics.recordFailure(new Error('a'));
    systemAnalytics.recordFailure(new Error('b'));

    const metrics = await systemAnalytics.collectMetrics();
    expect(metrics.errorRate).toBe(100);
  });

  test('destroy resets lifetime processing counters', async () => {
    systemAnalytics.recordProcessingTime(5000);
    systemAnalytics.recordSuccess();
    systemAnalytics.recordFailure(new Error('boom'));

    systemAnalytics.destroy();

    const metrics = await systemAnalytics.collectMetrics();
    expect(metrics.processedFiles).toBe(0);
    expect(metrics.successfulOperations).toBe(0);
    expect(metrics.failedOperations).toBe(0);
    expect(metrics.avgProcessingTime).toBe(0);
    expect(metrics.errorRate).toBe(0);
  });
});

describe('systemAnalytics pipeline fallbackReasons', () => {
  beforeEach(() => {
    systemAnalytics.destroy();
  });

  test('aggregates non-primary reasons from the recent window', async () => {
    systemAnalytics.recordPipelineOutcome('embedding', 'primary', {
      reason: 'primary_embedding_model'
    });
    systemAnalytics.recordPipelineOutcome('embedding', 'fallback', {
      reason: 'vector_primary_empty'
    });
    systemAnalytics.recordPipelineOutcome('embedding', 'fallback', {
      reason: 'vector_primary_empty'
    });
    systemAnalytics.recordPipelineOutcome('embedding', 'fallback', {
      reason: 'folder_vector_primary_unhealthy'
    });
    systemAnalytics.recordPipelineOutcome('embedding', 'error', {
      reason: 'embedding_fallback_exhausted'
    });

    const summary = systemAnalytics.getPipelineSummary();
    expect(summary.embedding.fallbackReasons).toEqual({
      vector_primary_empty: 2,
      folder_vector_primary_unhealthy: 1,
      embedding_fallback_exhausted: 1
    });
  });

  test('excludes primary outcomes and entries without a reason', async () => {
    systemAnalytics.recordPipelineOutcome('document', 'primary', { reason: 'ai_ok' });
    systemAnalytics.recordPipelineOutcome('document', 'fallback', {}); // no reason
    systemAnalytics.recordPipelineOutcome('document', 'fallback', { reason: 'filename_fallback' });

    const summary = systemAnalytics.getPipelineSummary();
    expect(summary.document.fallbackReasons).toEqual({ filename_fallback: 1 });
  });
});
