/**
 * Tests for Analysis IPC handlers running with REAL Zod.
 *
 * The sibling file `analysisIpc.test.js` mocks zod as unavailable to exercise
 * the fallback-validator path. This file does NOT mock zod, so the real
 * schema validation from `validationSchemas.js` and inline schemas in
 * `analysis.js` runs against payloads. Together they give us both paths.
 */

const mockRecognizeIfAvailable = jest.fn();
const mockBatchAnalyzeFiles = jest.fn();

// Intentionally NO jest.mock('zod', ...) — we want the real module here.

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

jest.mock('fs', () => ({
  promises: {
    stat: jest.fn().mockResolvedValue({
      size: 1024,
      mtimeMs: Date.now()
    }),
    lstat: jest.fn().mockResolvedValue({
      isSymbolicLink: jest.fn().mockReturnValue(false),
      size: 1024,
      mtimeMs: Date.now()
    }),
    access: jest.fn().mockResolvedValue(undefined)
  },
  existsSync: jest.fn().mockReturnValue(true)
}));

jest.mock('perf_hooks', () => ({
  performance: {
    now: jest.fn().mockReturnValue(0)
  }
}));

jest.mock('../src/main/utils/tesseractUtils', () => ({
  recognizeIfAvailable: (...args) => mockRecognizeIfAvailable(...args)
}));

jest.mock('../src/main/services/BatchAnalysisService', () =>
  jest.fn().mockImplementation(() => ({
    analyzeFiles: (...args) => mockBatchAnalyzeFiles(...args)
  }))
);

jest.mock('../src/main/ipc/files/batchProgressReporter', () => ({
  sendFileOperationBatchComplete: jest.fn(),
  sendOperationProgress: jest.fn()
}));

describe('registerAnalysisIpc (real Zod)', () => {
  let registerAnalysisIpc;
  let mockIpcMain;
  let mockAnalyzeDocumentFile;
  let mockAnalyzeImageFile;
  let mockSystemAnalytics;
  let mockGetServiceIntegration;
  let mockGetCustomFolders;
  let mockLogger;
  let handlers;

  const { IPC_CHANNELS } = require('../src/shared/constants');
  const ANALYSIS_CHANNELS = IPC_CHANNELS.ANALYSIS;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    handlers = {};

    mockIpcMain = {
      handle: jest.fn((channel, handler) => {
        handlers[channel] = handler;
      })
    };

    mockAnalyzeDocumentFile = jest.fn().mockResolvedValue({
      suggestedName: 'doc.pdf',
      category: 'documents',
      keywords: ['test'],
      confidence: 0.9
    });
    mockAnalyzeImageFile = jest.fn().mockResolvedValue({
      suggestedName: 'img.jpg',
      category: 'images',
      keywords: [],
      confidence: 0.85
    });

    mockRecognizeIfAvailable.mockReset();
    mockBatchAnalyzeFiles.mockReset();
    mockBatchAnalyzeFiles.mockResolvedValue({
      success: true,
      results: [],
      errors: [],
      total: 0,
      successful: 0
    });

    mockSystemAnalytics = {
      recordProcessingTime: jest.fn(),
      recordFailure: jest.fn()
    };

    mockGetServiceIntegration = jest.fn().mockReturnValue({
      processingState: {
        initialize: jest.fn().mockResolvedValue(undefined),
        markAnalysisStart: jest.fn().mockResolvedValue(undefined),
        markAnalysisComplete: jest.fn().mockResolvedValue(undefined),
        markAnalysisError: jest.fn().mockResolvedValue(undefined),
        upsertReadyAnalysis: jest.fn().mockResolvedValue(undefined),
        getReadyAnalyses: jest.fn().mockReturnValue([]),
        getState: jest.fn().mockReturnValue('in_progress'),
        clearState: jest.fn().mockResolvedValue(undefined)
      },
      analysisHistory: {
        recordAnalysis: jest.fn().mockResolvedValue(undefined)
      }
    });

    mockGetCustomFolders = jest.fn().mockReturnValue([]);

    mockLogger = {
      setContext: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    registerAnalysisIpc = require('../src/main/ipc/analysis');
    registerAnalysisIpc({
      ipcMain: mockIpcMain,
      IPC_CHANNELS,
      logger: mockLogger,
      systemAnalytics: mockSystemAnalytics,
      analyzeDocumentFile: mockAnalyzeDocumentFile,
      analyzeImageFile: mockAnalyzeImageFile,
      getServiceIntegration: mockGetServiceIntegration,
      getCustomFolders: mockGetCustomFolders
    });
  });

  test('zod loads successfully in this test file (sanity)', () => {
    // Sanity: if zod is somehow missing, the rest of the suite is meaningless.
    expect(() => require('zod')).not.toThrow();
    const { z } = require('zod');
    expect(typeof z.object).toBe('function');
  });

  describe('ANALYZE_BATCH validation', () => {
    test('rejects payloads with non-string filePaths entries', async () => {
      const result = await handlers[ANALYSIS_CHANNELS.ANALYZE_BATCH](
        {},
        { filePaths: ['ok.pdf', 42, null] }
      );

      expect(result).toMatchObject({
        success: false,
        error: expect.objectContaining({
          message: 'Invalid input',
          details: expect.objectContaining({
            errorType: 'ValidationError'
          })
        })
      });
      expect(mockBatchAnalyzeFiles).not.toHaveBeenCalled();
    });

    test('rejects payloads with empty filePaths array', async () => {
      const result = await handlers[ANALYSIS_CHANNELS.ANALYZE_BATCH]({}, { filePaths: [] });

      expect(result).toMatchObject({
        success: false,
        error: expect.objectContaining({
          message: 'Invalid input'
        })
      });
      expect(mockBatchAnalyzeFiles).not.toHaveBeenCalled();
    });

    test('rejects payloads with out-of-range concurrency option', async () => {
      const result = await handlers[ANALYSIS_CHANNELS.ANALYZE_BATCH](
        {},
        {
          filePaths: ['/x/a.pdf'],
          options: { concurrency: 99 } // max is 8
        }
      );

      expect(result).toMatchObject({
        success: false,
        error: expect.objectContaining({
          message: 'Invalid input'
        })
      });
      expect(mockBatchAnalyzeFiles).not.toHaveBeenCalled();
    });

    test('accepts a well-formed payload and reaches the service', async () => {
      mockBatchAnalyzeFiles.mockResolvedValueOnce({
        success: true,
        results: [{ filePath: '/x/a.pdf', success: true, result: { suggestedName: 'a.pdf' } }],
        errors: [],
        total: 1,
        successful: 1
      });

      const result = await handlers[ANALYSIS_CHANNELS.ANALYZE_BATCH](
        {},
        {
          filePaths: ['/x/a.pdf'],
          options: { concurrency: 2, sectionOrder: 'documents-first' }
        }
      );

      expect(result).toMatchObject({
        success: true,
        total: 1,
        successful: 1
      });
      expect(mockBatchAnalyzeFiles).toHaveBeenCalledWith(
        [expect.stringContaining('a.pdf')],
        expect.any(Array),
        expect.objectContaining({ concurrency: 2, sectionOrder: 'documents-first' })
      );
    });

    // Regression guard: batch handler must register a mediaAnalyzer wrapper
    // alongside documentAnalyzer/imageAnalyzer. Before this fix the batch
    // handler omitted mediaAnalyzer entirely, so BatchAnalysisService fell
    // back to the bare media adapter that bypasses applyUserNamingFromSettings —
    // confirmed post-2.0.9 regression for audio/video batch runs.
    test('registers a mediaAnalyzer wrapper for batch audio/video naming', async () => {
      mockBatchAnalyzeFiles.mockResolvedValueOnce({
        success: true,
        results: [],
        errors: [],
        total: 0,
        successful: 0
      });

      await handlers[ANALYSIS_CHANNELS.ANALYZE_BATCH]({}, { filePaths: ['/x/podcast.mp3'] });

      expect(mockBatchAnalyzeFiles).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Array),
        expect.objectContaining({
          documentAnalyzer: expect.any(Function),
          imageAnalyzer: expect.any(Function),
          mediaAnalyzer: expect.any(Function)
        })
      );
    });
  });

  describe('single-file analyze payload with namingSettings', () => {
    test('ANALYZE_DOCUMENT accepts object payload and applies naming override', async () => {
      const fsPromises = require('fs').promises;
      fsPromises.stat.mockResolvedValueOnce({
        size: 1024,
        birthtime: new Date('2026-06-01T12:00:00Z'),
        mtime: new Date('2026-06-01T12:00:00Z')
      });

      mockAnalyzeDocumentFile.mockResolvedValueOnce({
        suggestedName: 'Timeline 1',
        category: 'documents',
        keywords: ['demo'],
        confidence: 0.9
      });

      const result = await handlers[ANALYSIS_CHANNELS.ANALYZE_DOCUMENT](
        {},
        {
          filePath: '/x/Timeline 1.mp4',
          namingSettings: {
            convention: 'subject-date',
            separator: '-',
            dateFormat: 'YYYY-MM-DD',
            caseConvention: 'kebab-case'
          }
        }
      );

      expect(result.suggestedName).toBe('timeline-1-2026-06-01.mp4');
      expect(result.llmSuggestedName).toBe('Timeline 1');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Naming convention applied'),
        expect.objectContaining({ final: 'timeline-1-2026-06-01.mp4' })
      );
    });
  });

  describe('CANCEL_BATCH validation', () => {
    test('rejects payloads missing batchId', async () => {
      const result = await handlers[ANALYSIS_CHANNELS.CANCEL_BATCH]({}, {});

      expect(result).toMatchObject({
        success: false,
        error: expect.objectContaining({
          message: 'Invalid input'
        })
      });
    });

    test('rejects batchId exceeding max length', async () => {
      const tooLong = 'x'.repeat(200); // schema caps at 160
      const result = await handlers[ANALYSIS_CHANNELS.CANCEL_BATCH]({}, { batchId: tooLong });

      expect(result).toMatchObject({
        success: false,
        error: expect.objectContaining({
          message: 'Invalid input'
        })
      });
    });
  });
});
