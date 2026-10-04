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

const {
  withProcessingState,
  buildErrorContext,
  createAnalysisFallback,
  recordAnalysisResult,
  getFolderCategories
} = require('../src/main/ipc/analysisUtils');

describe('analysisUtils', () => {
  test('withProcessingState marks start and complete', async () => {
    const processingState = {
      markAnalysisStart: jest.fn(),
      markAnalysisComplete: jest.fn()
    };
    const logger = { warn: jest.fn(), debug: jest.fn() };

    const result = await withProcessingState({
      filePath: 'C:\\a.txt',
      processingState,
      logger,
      logPrefix: '[TEST]',
      fn: async () => 'ok'
    });

    expect(result).toBe('ok');
    expect(processingState.markAnalysisStart).toHaveBeenCalled();
    expect(processingState.markAnalysisComplete).toHaveBeenCalled();
  });

  test('withProcessingState marks error on failure', async () => {
    const processingState = {
      markAnalysisStart: jest.fn(),
      markAnalysisError: jest.fn()
    };
    const logger = { warn: jest.fn(), debug: jest.fn() };

    await expect(
      withProcessingState({
        filePath: 'C:\\a.txt',
        processingState,
        logger,
        logPrefix: '[TEST]',
        fn: async () => {
          throw new Error('fail');
        }
      })
    ).rejects.toThrow('fail');

    expect(processingState.markAnalysisError).toHaveBeenCalled();
  });

  test('buildErrorContext returns structured fields', () => {
    const error = new Error('boom');
    const ctx = buildErrorContext({ operation: 'op', filePath: 'C:\\a.txt', error });
    expect(ctx.fileName).toBe('a.txt');
    expect(ctx.operation).toBe('op');
  });

  test('createAnalysisFallback uses normalized error', () => {
    const fallback = createAnalysisFallback('C:\\a.txt', 'documents', 'bad');
    expect(fallback.error).toBe('normalized');
    expect(fallback.errorCode).toBe('CODE');
  });

  test('recordAnalysisResult writes to history', async () => {
    const analysisHistory = { recordAnalysis: jest.fn() };
    const logger = { warn: jest.fn() };
    await recordAnalysisResult({
      filePath: 'C:\\a.txt',
      result: { category: 'docs', confidence: 0.5 },
      processingTime: 10,
      modelType: 'llm',
      analysisHistory,
      logger
    });

    expect(analysisHistory.recordAnalysis).toHaveBeenCalled();
  });

  test('recordAnalysisResult preserves media-specific fields for audio/video', async () => {
    // Regression: AnalysisDetails.jsx reads transcript / durationSeconds /
    // detectedLanguage / transcriptSegments / keyframes when surfacing a
    // history entry. Before this fix recordAnalysisResult dropped them on
    // the floor, so reopening a previously-analyzed media file's details
    // showed a blank Duration / Language / Transcript pane while the
    // fresh-analysis path (which doesn't go through history) showed them.
    const analysisHistory = { recordAnalysis: jest.fn() };
    const logger = { warn: jest.fn() };
    const segments = [
      { start: 0, end: 1.5, text: 'hello' },
      { start: 1.5, end: 3.0, text: 'world' }
    ];
    const keyframes = [
      { timestamp: 0.5, caption: 'a person speaking' },
      { timestamp: 2.0, caption: null }
    ];
    await recordAnalysisResult({
      filePath: 'C:\\clip.mp4',
      result: {
        category: 'tutorials',
        confidence: 0.7,
        transcript: 'hello world',
        transcriptSegments: segments,
        durationSeconds: 3.0,
        detectedLanguage: 'en',
        keyframes,
        mediaKind: 'video',
        extractedText: ''
      },
      processingTime: 1234,
      modelType: 'llm',
      analysisHistory,
      logger
    });

    expect(analysisHistory.recordAnalysis).toHaveBeenCalled();
    const persisted = analysisHistory.recordAnalysis.mock.calls[0][1];
    expect(persisted.transcript).toBe('hello world');
    expect(persisted.transcriptSegments).toEqual(segments);
    expect(persisted.durationSeconds).toBe(3.0);
    expect(persisted.detectedLanguage).toBe('en');
    expect(persisted.keyframes).toEqual(keyframes);
    expect(persisted.mediaKind).toBe('video');
  });

  test('recordAnalysisResult bounds media field sizes', async () => {
    // Defense in depth: a pathological transcript or keyframe list must not
    // bloat the history row. The slice/maxLength caps mirror the limits
    // applied to extractedText elsewhere in the same normalizer.
    const analysisHistory = { recordAnalysis: jest.fn() };
    const logger = { warn: jest.fn() };
    const segments = Array.from({ length: 5000 }, (_, i) => ({
      start: i,
      end: i + 1,
      text: `seg${i}`
    }));
    const keyframes = Array.from({ length: 200 }, (_, i) => ({
      timestamp: i,
      caption: `frame ${i}`
    }));
    await recordAnalysisResult({
      filePath: 'C:\\big.mp4',
      result: {
        transcriptSegments: segments,
        keyframes
      },
      processingTime: 1,
      modelType: 'llm',
      analysisHistory,
      logger
    });
    const persisted = analysisHistory.recordAnalysis.mock.calls[0][1];
    expect(persisted.transcriptSegments).toHaveLength(1000);
    expect(persisted.keyframes).toHaveLength(50);
  });

  test('getFolderCategories handles errors', () => {
    const logger = { warn: jest.fn() };
    const result = getFolderCategories(
      () => {
        throw new Error('fail');
      },
      (folders) => folders,
      logger
    );
    expect(result).toEqual([]);
  });

  // F-195 (K-06): a fallback-only analysis is persisted as PROVISIONAL so the
  // watcher can retry it once the missing model appears, and so it is never
  // mistaken for a real result. The retry budget rides along in the entry.
  describe('recordAnalysisResult provisional stamping [F-195]', () => {
    const logger = { warn: jest.fn(), debug: jest.fn() };

    test('a real analysis is not provisional', async () => {
      const analysisHistory = { recordAnalysis: jest.fn(), getAnalysisByPath: jest.fn() };
      await recordAnalysisResult({
        filePath: 'C:\\a.txt',
        result: { category: 'docs', extractionMethod: 'content' },
        processingTime: 1,
        modelType: 'llm',
        analysisHistory,
        logger
      });
      const persisted = analysisHistory.recordAnalysis.mock.calls[0][1];
      expect(persisted.provisional).toBe(false);
      expect(persisted.provisionalRetries).toBe(0);
    });

    test('a fallback analysis is stamped provisional with its reason', async () => {
      const analysisHistory = {
        recordAnalysis: jest.fn(),
        getAnalysisByPath: jest.fn().mockResolvedValue(null)
      };
      await recordAnalysisResult({
        filePath: 'C:\\a.txt',
        result: {
          category: 'Documents',
          extractionMethod: 'filename_fallback',
          fallbackReason: 'text model not available',
          _isFallback: true
        },
        processingTime: 1,
        modelType: 'llm',
        analysisHistory,
        logger
      });
      const persisted = analysisHistory.recordAnalysis.mock.calls[0][1];
      expect(persisted.provisional).toBe(true);
      expect(persisted.fallbackReason).toBe('text model not available');
      expect(persisted.provisionalRetries).toBe(0);
    });

    test('re-recording a fallback over a provisional entry spends one retry', async () => {
      const analysisHistory = {
        recordAnalysis: jest.fn(),
        getAnalysisByPath: jest
          .fn()
          .mockResolvedValue({ analysis: { provisional: true, provisionalRetries: 1 } })
      };
      await recordAnalysisResult({
        filePath: 'C:\\a.txt',
        result: { category: 'Documents', extractionMethod: 'filename_fallback' },
        processingTime: 1,
        modelType: 'llm',
        analysisHistory,
        logger
      });
      const persisted = analysisHistory.recordAnalysis.mock.calls[0][1];
      expect(persisted.provisional).toBe(true);
      expect(persisted.provisionalRetries).toBe(2);
    });

    test('a real analysis over a provisional entry clears the flag and the budget', async () => {
      const analysisHistory = {
        recordAnalysis: jest.fn(),
        getAnalysisByPath: jest
          .fn()
          .mockResolvedValue({ analysis: { provisional: true, provisionalRetries: 1 } })
      };
      await recordAnalysisResult({
        filePath: 'C:\\a.txt',
        result: { category: 'Finance', extractionMethod: 'content', summary: 'real' },
        processingTime: 1,
        modelType: 'llm',
        analysisHistory,
        logger
      });
      const persisted = analysisHistory.recordAnalysis.mock.calls[0][1];
      expect(persisted.provisional).toBe(false);
      expect(persisted.provisionalRetries).toBe(0);
      expect(persisted.fallbackReason).toBeNull();
    });
  });
});
