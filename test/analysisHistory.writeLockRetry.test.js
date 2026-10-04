/**
 * @jest-environment node
 *
 * Regression guard for the WRITE_LOCK_TIMEOUT single-retry policy in
 * `recordAnalysisResult` (src/main/ipc/analysisUtils.js).
 *
 * Why this test exists
 * --------------------
 * AnalysisHistoryService rejects writes when it can't acquire its write
 * lock in time (post-2.0.9 hardening to prevent the v2 "race-with-the-
 * holder, corrupt the blob" path). Bulk imports can legitimately produce
 * contention; without the retry the analysis we just paid LLM tokens to
 * compute would silently fail to land in history, and the file would
 * disappear from chat/search.
 *
 * Behavioral contract guarded here:
 *   1. WRITE_LOCK_TIMEOUT on first attempt -> exactly one retry, ~100ms
 *      after, returns `{ persisted: true }` on success.
 *   2. Non-WRITE_LOCK_TIMEOUT errors are NOT retried — they fall through
 *      to the existing logger.error branch and return
 *      `{ persisted: false, reason }`.
 *   3. WRITE_LOCK_TIMEOUT on BOTH attempts also falls through to the
 *      logger.error branch (don't retry forever).
 *   4. The retry classifies on `err.code` OR `err.name` so callers that
 *      raise an Error subclass with `name = 'WRITE_LOCK_TIMEOUT'` are
 *      covered the same as `err.code = 'WRITE_LOCK_TIMEOUT'`.
 */

jest.mock('../src/shared/normalization', () => ({
  normalizeError: jest.fn(() => ({
    message: 'normalized',
    errorType: 'TYPE',
    isRetryable: false,
    code: 'CODE'
  })),
  normalizeText: jest.fn((v) => v),
  normalizeOptionalText: jest.fn((v) => v),
  normalizeKeywords: jest.fn((v) => v)
}));

const fs = require('fs').promises;
jest.spyOn(fs, 'stat').mockResolvedValue({ size: 10, mtimeMs: 123 });

const { recordAnalysisResult } = require('../src/main/ipc/analysisUtils');

function makeLogger() {
  return {
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    info: jest.fn()
  };
}

function makeWriteLockError({ via = 'code' } = {}) {
  const err = new Error('Write lock acquisition timed out');
  if (via === 'code') err.code = 'WRITE_LOCK_TIMEOUT';
  if (via === 'name') err.name = 'WRITE_LOCK_TIMEOUT';
  return err;
}

describe('recordAnalysisResult — WRITE_LOCK_TIMEOUT retry policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('retries exactly once and returns persisted:true when the second write succeeds', async () => {
    const recordAnalysis = jest
      .fn()
      .mockRejectedValueOnce(makeWriteLockError({ via: 'code' }))
      .mockResolvedValueOnce(undefined);
    const logger = makeLogger();

    const result = await recordAnalysisResult({
      filePath: 'C:\\bulk\\file.pdf',
      result: { category: 'docs', confidence: 0.5 },
      processingTime: 12,
      modelType: 'llm',
      analysisHistory: { recordAnalysis },
      logger
    });

    expect(result).toEqual({ persisted: true });
    expect(recordAnalysis).toHaveBeenCalledTimes(2);
    // Both attempts target the same fileInfo + normalized payload.
    expect(recordAnalysis.mock.calls[0]).toEqual(recordAnalysis.mock.calls[1]);
    // We logged the contention at debug level (not warn/error) so the happy
    // case of "lock contention recovered on retry" doesn't pollute error logs.
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Write lock contention'),
      expect.objectContaining({ filePath: 'C:\\bulk\\file.pdf' })
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('classifies WRITE_LOCK_TIMEOUT via err.name as well as err.code', async () => {
    const recordAnalysis = jest
      .fn()
      .mockRejectedValueOnce(makeWriteLockError({ via: 'name' }))
      .mockResolvedValueOnce(undefined);
    const logger = makeLogger();

    const result = await recordAnalysisResult({
      filePath: 'C:\\bulk\\file.pdf',
      result: { category: 'docs' },
      processingTime: 1,
      modelType: 'llm',
      analysisHistory: { recordAnalysis },
      logger
    });

    expect(result).toEqual({ persisted: true });
    expect(recordAnalysis).toHaveBeenCalledTimes(2);
  });

  test('does NOT retry non-WRITE_LOCK_TIMEOUT errors (e.g. EACCES) and reports persisted:false', async () => {
    const otherErr = new Error('permission denied');
    otherErr.code = 'EACCES';
    const recordAnalysis = jest.fn().mockRejectedValueOnce(otherErr);
    const logger = makeLogger();

    const result = await recordAnalysisResult({
      filePath: 'C:\\bulk\\file.pdf',
      result: { category: 'docs' },
      processingTime: 1,
      modelType: 'llm',
      analysisHistory: { recordAnalysis },
      logger
    });

    expect(result).toEqual({ persisted: false, reason: 'permission denied' });
    expect(recordAnalysis).toHaveBeenCalledTimes(1);
    // Non-retryable failure is the operator's only signal that a file
    // didn't land in history — must be at error level, not debug.
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to record analysis'),
      expect.objectContaining({ filePath: 'C:\\bulk\\file.pdf' })
    );
  });

  test('returns persisted:false when WRITE_LOCK_TIMEOUT happens on BOTH attempts (no infinite retry)', async () => {
    const recordAnalysis = jest
      .fn()
      .mockRejectedValueOnce(makeWriteLockError())
      .mockRejectedValueOnce(makeWriteLockError());
    const logger = makeLogger();

    const result = await recordAnalysisResult({
      filePath: 'C:\\bulk\\file.pdf',
      result: { category: 'docs' },
      processingTime: 1,
      modelType: 'llm',
      analysisHistory: { recordAnalysis },
      logger
    });

    expect(result.persisted).toBe(false);
    expect(result.reason).toBeDefined();
    expect(recordAnalysis).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();
  });

  test('happy path (no error) does not exercise the retry branch', async () => {
    const recordAnalysis = jest.fn().mockResolvedValue(undefined);
    const logger = makeLogger();

    const result = await recordAnalysisResult({
      filePath: 'C:\\bulk\\file.pdf',
      result: { category: 'docs' },
      processingTime: 1,
      modelType: 'llm',
      analysisHistory: { recordAnalysis },
      logger
    });

    expect(result).toEqual({ persisted: true });
    expect(recordAnalysis).toHaveBeenCalledTimes(1);
    expect(logger.debug).not.toHaveBeenCalledWith(
      expect.stringContaining('Write lock contention'),
      expect.anything()
    );
  });
});
