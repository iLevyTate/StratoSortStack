/**
 * The document IPC pipeline-outcome classifier must count a result whose
 * contents were never read as `fallback`, not `primary`. The legacy-format and
 * encrypted-.doc branches moved from `filename_fallback` to
 * `format_unsupported` (so the watcher stops retrying them as a model gap),
 * and the string heuristic in classifyAnalysisOutcome did not know the new
 * name: a folder of .xls files stopped moving the Diagnostics fallback rate.
 */

const mockRecognizeIfAvailable = jest.fn();
const mockBatchAnalyzeFiles = jest.fn();

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
    stat: jest.fn().mockResolvedValue({ size: 1024, mtimeMs: Date.now() }),
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
  performance: { now: jest.fn().mockReturnValue(0) }
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

const { IPC_CHANNELS } = require('../src/shared/constants');
const ANALYZE_DOCUMENT = IPC_CHANNELS.ANALYSIS.ANALYZE_DOCUMENT;

/** What analyzeDocumentFile returns for a BIFF .xls: no content was read. */
const LEGACY_XLS_RESULT = Object.freeze({
  purpose:
    'Excel 97-2003 workbook (.xls): contents not readable in this build, organized by filename.',
  project: 'ledger',
  category: 'Finance',
  date: '2020-09-13',
  keywords: ['ledger'],
  confidence: 70,
  suggestedName: 'ledger.xls',
  extractionError: 'Legacy format not supported',
  extractionErrorCode: 'LEGACY_FORMAT_UNSUPPORTED',
  extractionMethod: 'format_unsupported'
});

describe('classifyAnalysisOutcome and format_unsupported', () => {
  let handlers;
  let systemAnalytics;
  let analyzeDocumentFile;

  const register = () => {
    const registerAnalysisIpc = require('../src/main/ipc/analysis');
    registerAnalysisIpc({
      ipcMain: {
        handle: jest.fn((channel, handler) => {
          handlers[channel] = handler;
        })
      },
      IPC_CHANNELS,
      logger: require('../src/shared/logger').logger,
      systemAnalytics,
      analyzeDocumentFile,
      analyzeImageFile: jest.fn(),
      getServiceIntegration: () => ({
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
        analysisHistory: { recordAnalysis: jest.fn().mockResolvedValue(undefined) }
      }),
      getCustomFolders: () => [{ id: '1', name: 'Finance', description: 'Money' }]
    });
  };

  const documentOutcomes = () =>
    systemAnalytics.recordPipelineOutcome.mock.calls
      .filter(([pipeline]) => pipeline === 'document')
      .map(([, outcome, meta]) => ({ outcome, reason: meta?.reason }));

  beforeEach(() => {
    jest.resetModules();
    handlers = {};
    systemAnalytics = {
      recordProcessingTime: jest.fn(),
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
      recordPipelineOutcome: jest.fn()
    };
    analyzeDocumentFile = jest.fn();
    register();
  });

  test('a bare format_unsupported result (method only, no flags) is a fallback', async () => {
    // Robustness: even a producer that stamps only the method must not be
    // counted as a real content analysis. The method list lives in
    // shared/analysisProvenance; the classifier must agree with it.
    analyzeDocumentFile.mockResolvedValue({ ...LEGACY_XLS_RESULT });

    await handlers[ANALYZE_DOCUMENT]({}, '/test/ledger.xls');

    expect(documentOutcomes()).toEqual([{ outcome: 'fallback', reason: 'format_unsupported' }]);
  });

  test('a format_unsupported result carrying the fallback flags is a fallback with its reason', async () => {
    analyzeDocumentFile.mockResolvedValue({
      ...LEGACY_XLS_RESULT,
      isFallback: true,
      _isFallback: true,
      fallbackReason: 'no reader for this format in this build'
    });

    await handlers[ANALYZE_DOCUMENT]({}, '/test/ledger.xls');

    expect(documentOutcomes()).toEqual([
      { outcome: 'fallback', reason: 'no reader for this format in this build' }
    ]);
  });

  test('an encrypted .doc stamped format_unsupported is a fallback', async () => {
    analyzeDocumentFile.mockResolvedValue({
      ...LEGACY_XLS_RESULT,
      purpose:
        'Word document is password-protected, so its contents were not read; organized by filename.',
      suggestedName: 'secret.doc',
      extractionErrorCode: 'DOC_ENCRYPTED'
    });

    await handlers[ANALYZE_DOCUMENT]({}, '/test/secret.doc');

    expect(documentOutcomes()).toHaveLength(1);
    expect(documentOutcomes()[0].outcome).toBe('fallback');
  });

  test('a real content analysis is still primary', async () => {
    analyzeDocumentFile.mockResolvedValue({
      purpose: 'Quarterly ledger',
      category: 'Finance',
      keywords: ['ledger', 'q3'],
      confidence: 92,
      suggestedName: 'q3-ledger.xlsx',
      extractionMethod: 'xlsx'
    });

    await handlers[ANALYZE_DOCUMENT]({}, '/test/q3-ledger.xlsx');

    expect(documentOutcomes()).toEqual([{ outcome: 'primary', reason: 'xlsx' }]);
  });
});
