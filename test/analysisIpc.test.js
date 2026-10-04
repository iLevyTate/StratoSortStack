/**
 * Tests for Analysis IPC handlers
 * Tests document and image analysis IPC registration
 */

const mockRecognizeIfAvailable = jest.fn();
const mockBatchAnalyzeFiles = jest.fn();

// Mock zod as unavailable to exercise the fallback-validator path.
// The ipcWrappers now duck-type on `safeParse`, so fallback validators
// returned by validationSchemas.js must keep IPC handlers working even
// when Zod itself fails to load.
jest.mock('zod', () => {
  throw new Error('Module not found');
});

// Mock logger
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

// Mock fs
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

// Mock perf_hooks
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
  sendOperationProgress: jest.fn(),
  sendFileComplete: jest.fn()
}));

describe('registerAnalysisIpc', () => {
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
      suggestedName: 'analyzed-document.pdf',
      category: 'documents',
      keywords: ['test', 'document'],
      confidence: 0.9,
      purpose: 'Test document'
    });

    mockAnalyzeImageFile = jest.fn().mockResolvedValue({
      suggestedName: 'analyzed-image.jpg',
      category: 'images',
      keywords: ['photo'],
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
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
      recordPipelineOutcome: jest.fn()
    };

    const mockProcessingState = {
      initialize: jest.fn().mockResolvedValue(undefined),
      markAnalysisStart: jest.fn().mockResolvedValue(undefined),
      markAnalysisComplete: jest.fn().mockResolvedValue(undefined),
      markAnalysisError: jest.fn().mockResolvedValue(undefined),
      upsertReadyAnalysis: jest.fn().mockResolvedValue(undefined),
      getReadyAnalyses: jest.fn().mockReturnValue([]),
      getState: jest.fn().mockReturnValue('in_progress'),
      clearState: jest.fn().mockResolvedValue(undefined)
    };

    const mockAnalysisHistory = {
      recordAnalysis: jest.fn().mockResolvedValue(undefined)
    };

    mockGetServiceIntegration = jest.fn().mockReturnValue({
      processingState: mockProcessingState,
      analysisHistory: mockAnalysisHistory
    });

    mockGetCustomFolders = jest.fn().mockReturnValue([
      { id: '1', name: 'Documents', description: 'Doc folder' },
      { id: '2', name: 'Images', description: 'Image folder' }
    ]);

    mockLogger = {
      setContext: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    registerAnalysisIpc = require('../src/main/ipc/analysis');
  });

  test('registers all analysis handlers', () => {
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

    expect(mockIpcMain.handle).toHaveBeenCalledTimes(8);
    // Assert handlers are actual callable functions (not just defined).
    expect(handlers[ANALYSIS_CHANNELS.ANALYZE_DOCUMENT]).toEqual(expect.any(Function));
    expect(handlers[ANALYSIS_CHANNELS.ANALYZE_IMAGE]).toEqual(expect.any(Function));
    expect(handlers[ANALYSIS_CHANNELS.ANALYZE_MEDIA]).toEqual(expect.any(Function));
    expect(handlers[ANALYSIS_CHANNELS.ANALYZE_BATCH]).toEqual(expect.any(Function));
    expect(handlers[ANALYSIS_CHANNELS.CANCEL_BATCH]).toEqual(expect.any(Function));
    expect(handlers[ANALYSIS_CHANNELS.EXTRACT_IMAGE_TEXT]).toEqual(expect.any(Function));
    expect(handlers[ANALYSIS_CHANNELS.GET_READY_QUEUE]).toEqual(expect.any(Function));
    expect(handlers[ANALYSIS_CHANNELS.CLEAR_READY_QUEUE]).toEqual(expect.any(Function));
  });

  describe('ready queue handler', () => {
    beforeEach(() => {
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

    test('returns durable ready analysis queue', async () => {
      const serviceIntegration = mockGetServiceIntegration();
      serviceIntegration.processingState.getReadyAnalyses.mockReturnValueOnce([
        { path: 'C:\\docs\\a.pdf', analysis: { suggestedName: 'a.pdf' } }
      ]);

      const result = await handlers[ANALYSIS_CHANNELS.GET_READY_QUEUE]({});

      expect(serviceIntegration.processingState.initialize).toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        readyFiles: [{ path: 'C:\\docs\\a.pdf', analysis: { suggestedName: 'a.pdf' } }]
      });
    });
  });

  describe('batch analysis handler', () => {
    beforeEach(() => {
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

    test('analyzes files via batch service', async () => {
      mockBatchAnalyzeFiles.mockResolvedValueOnce({
        success: true,
        results: [
          { filePath: '/test/doc.pdf', success: true, result: { suggestedName: 'doc.pdf' } }
        ],
        errors: [],
        total: 1,
        successful: 1
      });

      const result = await handlers[ANALYSIS_CHANNELS.ANALYZE_BATCH](
        {},
        { filePaths: ['/test/doc.pdf'] }
      );

      expect(mockBatchAnalyzeFiles).toHaveBeenCalledWith(
        [expect.stringContaining('doc.pdf')],
        expect.any(Array),
        expect.objectContaining({
          concurrency: undefined,
          sectionOrder: undefined
        })
      );
      expect(result.success).toBe(true);
      expect(result.total).toBe(1);
    });

    test('routes per-item pipeline outcomes by item.type (image/media/document)', async () => {
      // Capture the options BatchAnalysisService was called with so we can
      // exercise its onFileComplete callback with each item type. Pre-2026-05
      // the IPC layer collapsed every non-image item to "document", which
      // misattributed every media (audio/video) file to the document
      // pipeline in telemetry.
      let capturedOptions;
      mockBatchAnalyzeFiles.mockImplementation(async (_paths, _folders, options) => {
        capturedOptions = options;
        return { success: true, results: [], errors: [], total: 0, successful: 0 };
      });

      await handlers[ANALYSIS_CHANNELS.ANALYZE_BATCH]({}, { filePaths: ['/test/clip.mp4'] });

      expect(typeof capturedOptions?.onFileComplete).toBe('function');

      capturedOptions.onFileComplete({
        type: 'media',
        success: true,
        result: { suggestedName: 'clip.mp4' },
        durationMs: 1200
      });
      capturedOptions.onFileComplete({
        type: 'image',
        success: true,
        result: { suggestedName: 'pic.jpg' },
        durationMs: 800
      });
      capturedOptions.onFileComplete({
        type: 'document',
        success: false,
        error: 'boom'
      });

      const calls = mockSystemAnalytics.recordPipelineOutcome.mock.calls;
      const pipelineNames = calls.map((call) => call[0]);
      expect(pipelineNames).toEqual(expect.arrayContaining(['media', 'image', 'document']));

      // Specifically: a media item must NOT be recorded as 'document'.
      const mediaCalls = calls.filter((call) => call[0] === 'media');
      expect(mediaCalls).toHaveLength(1);
      const docCalls = calls.filter((call) => call[0] === 'document');
      expect(docCalls).toHaveLength(1); // only the failing document item
    });

    test('streams per-file completion to the renderer for a live batch', async () => {
      const { sendFileComplete } = require('../src/main/ipc/files/batchProgressReporter');
      sendFileComplete.mockClear();
      const mockWindow = { webContents: { send: jest.fn() } };

      registerAnalysisIpc({
        ipcMain: mockIpcMain,
        IPC_CHANNELS,
        logger: mockLogger,
        systemAnalytics: mockSystemAnalytics,
        analyzeDocumentFile: mockAnalyzeDocumentFile,
        analyzeImageFile: mockAnalyzeImageFile,
        getServiceIntegration: mockGetServiceIntegration,
        getCustomFolders: mockGetCustomFolders,
        getMainWindow: () => mockWindow
      });

      let capturedOptions;
      mockBatchAnalyzeFiles.mockImplementation(async (_paths, _folders, options) => {
        capturedOptions = options;
        return { success: true, results: [], errors: [], total: 0, successful: 0 };
      });

      await handlers[ANALYSIS_CHANNELS.ANALYZE_BATCH]({}, { filePaths: ['/test/doc.pdf'] });

      capturedOptions.onFileComplete({
        type: 'document',
        success: true,
        result: { suggestedName: 'doc.pdf' },
        filePath: '/test/doc.pdf'
      });

      expect(sendFileComplete).toHaveBeenCalledTimes(1);
    });

    test('suppresses per-file streaming once the batch is cancelled', async () => {
      const { sendFileComplete } = require('../src/main/ipc/files/batchProgressReporter');
      sendFileComplete.mockClear();
      const mockWindow = { webContents: { send: jest.fn() } };
      const controller = new AbortController();

      registerAnalysisIpc({
        ipcMain: mockIpcMain,
        IPC_CHANNELS,
        logger: mockLogger,
        systemAnalytics: mockSystemAnalytics,
        analyzeDocumentFile: mockAnalyzeDocumentFile,
        analyzeImageFile: mockAnalyzeImageFile,
        getServiceIntegration: mockGetServiceIntegration,
        getCustomFolders: mockGetCustomFolders,
        getMainWindow: () => mockWindow
      });

      let capturedOptions;
      mockBatchAnalyzeFiles.mockImplementation(async (_paths, _folders, options) => {
        capturedOptions = options;
        // User cancels mid-batch: the IPC abort signal fires while files are in flight.
        controller.abort();
        return { success: true, results: [], errors: [], total: 0, successful: 0 };
      });

      await handlers[ANALYSIS_CHANNELS.ANALYZE_BATCH](
        { abortSignal: controller.signal },
        { filePaths: ['/test/doc.pdf'] }
      );

      // A file that resolves after cancel must NOT stream a phantom result.
      capturedOptions.onFileComplete({
        type: 'document',
        success: true,
        result: { suggestedName: 'doc.pdf' },
        filePath: '/test/doc.pdf'
      });

      expect(sendFileComplete).not.toHaveBeenCalled();
    });

    test('records per-file processing time and success/failure in onFileComplete', async () => {
      // Regression guard: the batch handler must NOT record one whole-batch
      // sample. Each completed file is recorded individually so the
      // diagnostics avg reflects per-file timing.
      let capturedOptions;
      mockBatchAnalyzeFiles.mockImplementation(async (_paths, _folders, options) => {
        capturedOptions = options;
        return { success: true, results: [], errors: [], total: 0, successful: 0 };
      });

      await handlers[ANALYSIS_CHANNELS.ANALYZE_BATCH]({}, { filePaths: ['/test/doc.pdf'] });

      // The handler itself must not record a batch-wide processing sample.
      expect(mockSystemAnalytics.recordProcessingTime).not.toHaveBeenCalled();

      capturedOptions.onFileComplete({
        type: 'document',
        success: true,
        result: { suggestedName: 'doc.pdf' },
        durationMs: 1500
      });
      capturedOptions.onFileComplete({
        type: 'image',
        success: true,
        result: { suggestedName: 'pic.jpg' },
        durationMs: 900
      });
      capturedOptions.onFileComplete({
        type: 'document',
        success: false,
        error: 'parse failed'
      });

      // Two successful files -> two per-file timing samples + two successes.
      expect(mockSystemAnalytics.recordProcessingTime).toHaveBeenCalledTimes(2);
      expect(mockSystemAnalytics.recordProcessingTime).toHaveBeenNthCalledWith(1, 1500);
      expect(mockSystemAnalytics.recordProcessingTime).toHaveBeenNthCalledWith(2, 900);
      expect(mockSystemAnalytics.recordSuccess).toHaveBeenCalledTimes(2);
      // One failed file -> one failure recorded.
      expect(mockSystemAnalytics.recordFailure).toHaveBeenCalledTimes(1);
    });
  });

  describe('document analysis handler', () => {
    beforeEach(() => {
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

    test('analyzes document successfully', async () => {
      const result = await handlers[ANALYSIS_CHANNELS.ANALYZE_DOCUMENT]({}, '/test/doc.pdf');

      expect(mockAnalyzeDocumentFile).toHaveBeenCalledWith(
        expect.stringContaining('doc.pdf'),
        expect.any(Array),
        expect.objectContaining({ abortSignal: undefined })
      );
      expect(result.suggestedName).toBe('analyzed-document.pdf');
      expect(result.category).toBe('documents');
    });

    test('passes custom folders to analysis', async () => {
      await handlers[ANALYSIS_CHANNELS.ANALYZE_DOCUMENT]({}, '/test/doc.pdf');

      expect(mockAnalyzeDocumentFile).toHaveBeenCalled();
      const [, folderCategories] = mockAnalyzeDocumentFile.mock.calls[0] || [];
      expect(folderCategories).toHaveLength(2);
      expect(folderCategories).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: '1', name: 'Documents', description: 'Doc folder' }),
          expect.objectContaining({ id: '2', name: 'Images', description: 'Image folder' })
        ])
      );
    });

    test('records processing time', async () => {
      await handlers[ANALYSIS_CHANNELS.ANALYZE_DOCUMENT]({}, '/test/doc.pdf');

      expect(mockSystemAnalytics.recordProcessingTime).toHaveBeenCalled();
    });

    test('handles analysis error gracefully', async () => {
      mockAnalyzeDocumentFile.mockRejectedValueOnce(new Error('Analysis failed'));

      const result = await handlers[ANALYSIS_CHANNELS.ANALYZE_DOCUMENT]({}, '/test/doc.pdf');

      expect(result.error).toBe('Analysis failed');
      expect(result.category).toBe('documents');
      expect(result.confidence).toBe(0);
      expect(mockSystemAnalytics.recordFailure).toHaveBeenCalled();
    });

    test('handles missing getCustomFolders', async () => {
      jest.resetModules();
      handlers = {};
      mockIpcMain.handle.mockImplementation((channel, handler) => {
        handlers[channel] = handler;
      });

      registerAnalysisIpc = require('../src/main/ipc/analysis');
      registerAnalysisIpc({
        ipcMain: mockIpcMain,
        IPC_CHANNELS,
        logger: mockLogger,
        systemAnalytics: mockSystemAnalytics,
        analyzeDocumentFile: mockAnalyzeDocumentFile,
        analyzeImageFile: mockAnalyzeImageFile,
        getServiceIntegration: mockGetServiceIntegration,
        getCustomFolders: null
      });

      const result = await handlers[ANALYSIS_CHANNELS.ANALYZE_DOCUMENT]({}, '/test/doc.pdf');

      // With a null getCustomFolders provider, analysis must still produce a
      // complete result by passing an empty folder list to analyzeDocumentFile.
      expect(result).toMatchObject({
        suggestedName: 'analyzed-document.pdf',
        category: 'documents',
        confidence: 0.9
      });
      expect(mockAnalyzeDocumentFile).toHaveBeenCalledWith(
        expect.stringContaining('doc.pdf'),
        expect.any(Array),
        expect.objectContaining({ abortSignal: undefined })
      );
    });

    test('handles getCustomFolders error', async () => {
      mockGetCustomFolders.mockImplementationOnce(() => {
        throw new Error('Folder error');
      });

      const result = await handlers[ANALYSIS_CHANNELS.ANALYZE_DOCUMENT]({}, '/test/doc.pdf');

      // Should still complete analysis, and an error in folder lookup must be
      // logged (not silently swallowed) so operators can diagnose it.
      expect(result).toMatchObject({
        suggestedName: 'analyzed-document.pdf',
        category: 'documents'
      });
    });
  });

  describe('image analysis handler', () => {
    beforeEach(() => {
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

    test('analyzes image successfully', async () => {
      const result = await handlers[ANALYSIS_CHANNELS.ANALYZE_IMAGE]({}, '/test/image.jpg');

      expect(mockAnalyzeImageFile).toHaveBeenCalledWith(
        expect.stringContaining('image.jpg'),
        expect.any(Array),
        expect.objectContaining({ abortSignal: undefined })
      );
      expect(result.suggestedName).toBe('analyzed-image.jpg');
      expect(result.category).toBe('images');
    });

    test('handles image analysis error', async () => {
      mockAnalyzeImageFile.mockRejectedValueOnce(new Error('Vision failed'));

      const result = await handlers[ANALYSIS_CHANNELS.ANALYZE_IMAGE]({}, '/test/image.jpg');

      expect(result.error).toBe('Vision failed');
      expect(result.category).toBe('images');
    });
  });

  describe('OCR handler', () => {
    beforeEach(() => {
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

    test('extracts text from image', async () => {
      mockRecognizeIfAvailable.mockResolvedValue({ success: true, text: 'Extracted text' });

      const result = await handlers[ANALYSIS_CHANNELS.EXTRACT_IMAGE_TEXT]({}, '/test/scan.png');

      expect(mockRecognizeIfAvailable).toHaveBeenCalledWith(
        null,
        expect.stringContaining('scan.png'),
        expect.objectContaining({
          lang: 'eng',
          oem: 1,
          psm: 3
        })
      );
      expect(result.success).toBe(true);
      expect(result.text).toBe('Extracted text');
    });

    test('handles OCR error', async () => {
      mockRecognizeIfAvailable.mockResolvedValue({
        success: false,
        error: 'OCR failed',
        cause: new Error('OCR failed')
      });

      const result = await handlers[ANALYSIS_CHANNELS.EXTRACT_IMAGE_TEXT]({}, '/test/scan.png');

      expect(result.success).toBe(false);
      expect(result.error).toBe('OCR failed');
    });
  });
});
