/**
 * @jest-environment node
 *
 * A Discover batch in main, from the first await to the last report:
 * - a Stop that arrives while the paths are still being checked,
 * - a renderer that reloads, crashes or is destroyed while the batch runs,
 * - progress that is still on its way when the batch has ended,
 * - the size and date the history keeps for a file that was analyzed.
 */
jest.mock('fs', () => jest.requireActual('fs'));

const mockBatchAnalyzeFiles = jest.fn();

const mockIpcWrappers = {
  createHandler: jest.fn(({ handler }) => handler),
  withErrorLogging: jest.fn((logger, handler) => handler),
  withValidation: jest.fn((logger, schema, handler) => handler),
  safeHandle: jest.fn(),
  z: null
};
jest.mock('../src/main/ipc/ipcWrappers', () => mockIpcWrappers);

jest.mock('../src/main/utils/safeAccess', () => ({
  safeFilePath: jest.fn((filePath) => filePath)
}));
jest.mock('../src/shared/pathSanitization', () => ({
  validateFileOperationPath: jest.fn(async (filePath) => ({
    valid: true,
    normalizedPath: filePath
  }))
}));
jest.mock('../src/shared/folderUtils', () => ({
  mapFoldersToCategories: jest.fn().mockReturnValue(['cat1']),
  getFolderNamesString: jest.fn().mockReturnValue('cat1')
}));
jest.mock('../src/shared/logger', () => {
  const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { logger, createLogger: jest.fn(() => logger) };
});

const mockAnalysisUtils = {
  withProcessingState: jest.fn(),
  buildErrorContext: jest.fn().mockReturnValue({}),
  createAnalysisFallback: jest.fn().mockReturnValue({ fallback: true }),
  recordAnalysisResult: jest.fn(),
  getFolderCategories: jest.fn().mockReturnValue(['cat1'])
};
jest.mock('../src/main/ipc/analysisUtils', () => mockAnalysisUtils);

jest.mock('../src/main/utils/tesseractUtils', () => ({ recognizeIfAvailable: jest.fn() }));
jest.mock('../src/main/services/BatchAnalysisService', () =>
  jest.fn().mockImplementation(() => ({
    analyzeFiles: (...args) => mockBatchAnalyzeFiles(...args),
    shutdown: jest.fn()
  }))
);
jest.mock('../src/main/ipc/files/batchProgressReporter', () => ({
  sendFileComplete: jest.fn(),
  sendOperationProgress: jest.fn(),
  flushOperationProgress: jest.fn()
}));

const mockMediaAnalyzer = jest.fn();
jest.mock('../src/main/services/mediaAnalyzerAdapter', () => ({
  createMediaAnalyzerAdapter: () => mockMediaAnalyzer,
  buildSkipResult: jest.fn()
}));
jest.mock('../src/main/services/WhisperService', () => ({ getInstance: jest.fn(() => null) }));

const { EventEmitter } = require('events');
const fsPromises = require('fs').promises;
const registerAnalysisIpc = require('../src/main/ipc/analysis');
const { validateFileOperationPath } = require('../src/shared/pathSanitization');
const {
  sendOperationProgress,
  flushOperationProgress
} = require('../src/main/ipc/files/batchProgressReporter');

const IPC_CHANNELS = {
  ANALYSIS: {
    ANALYZE_DOCUMENT: 'analyze-document',
    ANALYZE_IMAGE: 'analyze-image',
    ANALYZE_MEDIA: 'analyze-media',
    ANALYZE_BATCH: 'analyze-batch',
    CANCEL_BATCH: 'cancel-batch',
    EXTRACT_IMAGE_TEXT: 'extract-image-text',
    GET_READY_QUEUE: 'get-ready-queue'
  }
};

const BATCH_DONE = { success: true, results: [], errors: [], total: 1, successful: 1 };

let handlers;
let analyzeDocumentFile;
let analyzeImageFile;
let batchCounter = 0;

/** Resolves after the promise jobs that are already queued have run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  mockBatchAnalyzeFiles.mockReset();
  mockMediaAnalyzer.mockReset();
  mockAnalysisUtils.withProcessingState.mockImplementation(async ({ fn }) => fn());
  mockAnalysisUtils.recordAnalysisResult.mockResolvedValue({ persisted: true });
  handlers = {};
  mockIpcWrappers.safeHandle.mockImplementation((_ipc, channel, handler) => {
    handlers[channel] = handler;
  });
  analyzeDocumentFile = jest.fn();
  analyzeImageFile = jest.fn();
  registerAnalysisIpc({
    ipcMain: { handle: jest.fn() },
    IPC_CHANNELS,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    systemAnalytics: { recordProcessingTime: jest.fn(), recordFailure: jest.fn() },
    analyzeDocumentFile,
    analyzeImageFile,
    getServiceIntegration: jest.fn().mockReturnValue({ analysisHistory: {} }),
    getCustomFolders: jest.fn().mockReturnValue([]),
    getMainWindow: () => ({})
  });
});

const analyzeBatch = (event, payload) =>
  handlers[IPC_CHANNELS.ANALYSIS.ANALYZE_BATCH](event, payload);
const cancelBatch = (batchId) => handlers[IPC_CHANNELS.ANALYSIS.CANCEL_BATCH]({}, { batchId });
const nextBatchId = () => `lifecycle-${++batchCounter}`;

/**
 * Starts a batch whose service call stays open. Returns the options the
 * service was given and a way to let the batch end.
 */
async function startOpenBatch(event = {}, filePaths = ['C:\\Docs\\a.pdf']) {
  const batchId = nextBatchId();
  let finish;
  let options;
  mockBatchAnalyzeFiles.mockImplementationOnce((_paths, _folders, batchOptions) => {
    options = batchOptions;
    return new Promise((resolve) => {
      finish = () => resolve(BATCH_DONE);
    });
  });
  const done = analyzeBatch(event, { batchId, filePaths });
  await settle();
  return {
    batchId,
    done,
    options,
    end: async () => {
      finish();
      await done;
    }
  };
}

describe('Stop while the paths of a batch are still being checked', () => {
  test('the batch is known to the cancel handler and does not analyze', async () => {
    const batchId = nextBatchId();
    let releaseValidation;
    validateFileOperationPath.mockImplementationOnce(
      (filePath) =>
        new Promise((resolve) => {
          releaseValidation = () => resolve({ valid: true, normalizedPath: filePath });
        })
    );
    let options;
    mockBatchAnalyzeFiles.mockImplementationOnce(async (_paths, _folders, batchOptions) => {
      options = batchOptions;
      return { ...BATCH_DONE, success: false, cancelled: true, successful: 0 };
    });

    const done = analyzeBatch({}, { batchId, filePaths: ['C:\\Docs\\a.pdf'] });
    await settle();
    expect(mockBatchAnalyzeFiles).not.toHaveBeenCalled();

    const answer = await cancelBatch(batchId);
    expect(answer).toEqual(expect.objectContaining({ success: true, cancelled: true }));
    expect(answer.notFound).toBeUndefined();

    releaseValidation();
    const result = await done;

    // The service is told at once: it starts no file.
    expect(options.isCancelled()).toBe(true);
    expect(options.abortSignal.aborted).toBe(true);
    expect(result.cancelled).toBe(true);
  });

  test('a batch that ends at the path check leaves nothing behind', async () => {
    const batchId = nextBatchId();
    validateFileOperationPath.mockResolvedValueOnce({ valid: false, error: 'outside' });

    const refused = await analyzeBatch({}, { batchId, filePaths: ['C:\\Nope\\a.pdf'] });
    expect(refused.success).toBe(false);
    expect(mockBatchAnalyzeFiles).not.toHaveBeenCalled();

    expect(await cancelBatch(batchId)).toEqual(expect.objectContaining({ notFound: true }));

    // The id is free again.
    mockBatchAnalyzeFiles.mockResolvedValueOnce(BATCH_DONE);
    const again = await analyzeBatch({}, { batchId, filePaths: ['C:\\Docs\\a.pdf'] });
    expect(again.success).toBe(true);
  });
});

describe('a batch whose renderer goes away', () => {
  const expectCancelled = (options, cancelled) => {
    expect(options.isCancelled()).toBe(cancelled);
    expect(options.abortSignal.aborted).toBe(cancelled);
  };

  test.each([
    ['its process is gone', (sender) => sender.emit('render-process-gone', {}, { reason: 'oom' })],
    // Emitted once the main frame has loaded another document.
    ['it is reloaded', (sender) => sender.emit('did-navigate', {}, 'app://index.html', 200, 'OK')],
    ['it is destroyed', (sender) => sender.emit('destroyed')]
  ])('is cancelled when %s', async (_what, goAway) => {
    const sender = new EventEmitter();
    const batch = await startOpenBatch({ sender });
    expectCancelled(batch.options, false);

    goAway(sender);

    expectCancelled(batch.options, true);
    await batch.end();
  });

  test.each([
    [
      'a navigation inside the page',
      (sender) => sender.emit('did-navigate-in-page', {}, 'app://index.html#/discover', true)
    ],
    [
      'a navigation of a frame inside the page',
      (sender) => sender.emit('did-frame-navigate', {}, 'about:blank', 200, 'OK', false)
    ],
    [
      // 'did-start-navigation' comes before 'will-navigate', which blocks a
      // link to another site: the page is still there afterwards.
      'a navigation that starts and is then blocked',
      (sender) =>
        sender.emit('did-start-navigation', {
          url: 'https://example.com/',
          isMainFrame: true,
          isSameDocument: false
        })
    ]
  ])('keeps running through %s', async (_what, happen) => {
    const sender = new EventEmitter();
    const batch = await startOpenBatch({ sender });

    happen(sender);

    expectCancelled(batch.options, false);
    await batch.end();
  });

  test('another window going away does not stop it', async () => {
    const sender = new EventEmitter();
    const other = new EventEmitter();
    const batch = await startOpenBatch({ sender });
    const otherBatch = await startOpenBatch({ sender: other }, ['C:\\Docs\\b.pdf']);

    other.emit('destroyed');

    expectCancelled(batch.options, false);
    expectCancelled(otherBatch.options, true);
    await batch.end();
    await otherBatch.end();
  });

  test('nothing is left listening on the renderer when the batch has ended', async () => {
    const sender = new EventEmitter();
    const batch = await startOpenBatch({ sender });
    expect(sender.listenerCount('destroyed')).toBe(1);

    await batch.end();

    for (const name of ['render-process-gone', 'did-navigate', 'destroyed']) {
      expect(sender.listenerCount(name)).toBe(0);
    }
  });
});

describe('progress of a batch that is on its way when the batch ends', () => {
  const stillWanted = (call) => sendOperationProgress.mock.calls[call][2]?.stillWanted?.();

  test('a report says whether its batch still wants it: yes while it runs', async () => {
    const batch = await startOpenBatch();

    batch.options.onProgress({ completed: 1, total: 2 });

    expect(sendOperationProgress).toHaveBeenCalledTimes(1);
    expect(stillWanted(0)).toBe(true);
    await batch.end();
  });

  test('no longer once the batch was cancelled', async () => {
    const batch = await startOpenBatch();
    batch.options.onProgress({ completed: 1, total: 2 });

    await cancelBatch(batch.batchId);

    expect(stillWanted(0)).toBe(false);
    await batch.end();
  });

  test('no longer once the batch has returned', async () => {
    const batch = await startOpenBatch();
    batch.options.onProgress({ completed: 2, total: 2 });

    await batch.end();

    expect(stillWanted(0)).toBe(false);
  });

  test('a batch that ran to its end sends its last report itself', async () => {
    const batch = await startOpenBatch();
    batch.options.onProgress({ completed: 2, total: 2 });

    await batch.end();

    expect(flushOperationProgress).toHaveBeenCalledTimes(1);
    expect(flushOperationProgress.mock.calls[0][1]).toMatchObject({
      type: 'batch_analyze',
      batchId: batch.batchId,
      completed: 2,
      total: 2
    });
  });

  test('a cancelled batch does not', async () => {
    const batch = await startOpenBatch();
    batch.options.onProgress({ completed: 1, total: 2 });

    await cancelBatch(batch.batchId);
    await batch.end();

    expect(flushOperationProgress).not.toHaveBeenCalled();
  });
});

describe('the size and date the history keeps for an analyzed file', () => {
  const BEFORE = { size: 10, mtimeMs: 1000, mtime: new Date(1000), birthtime: new Date(500) };
  const AFTER = { size: 20, mtimeMs: 2000, mtime: new Date(2000), birthtime: new Date(500) };
  let stat;
  let analyzed;
  let gone;

  beforeEach(() => {
    analyzed = false;
    gone = false;
    stat = jest.spyOn(fsPromises, 'stat').mockImplementation(async () => {
      if (analyzed && gone) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return analyzed ? AFTER : BEFORE;
    });
    // The file is saved again (or removed) while the model works on it.
    const analyzer = async () => {
      analyzed = true;
      return { category: 'Finance', keywords: ['invoice'] };
    };
    analyzeDocumentFile.mockImplementation(analyzer);
    analyzeImageFile.mockImplementation(analyzer);
    mockMediaAnalyzer.mockImplementation(analyzer);
  });

  afterEach(() => {
    stat.mockRestore();
  });

  const recordedStats = () => mockAnalysisUtils.recordAnalysisResult.mock.calls[0][0].fileStats;

  const viaBatch = (analyzerName) => async (filePath) => {
    mockBatchAnalyzeFiles.mockImplementationOnce(async (paths, folders, batchOptions) => {
      await batchOptions[analyzerName](paths[0], folders);
      return BATCH_DONE;
    });
    await analyzeBatch({}, { batchId: nextBatchId(), filePaths: [filePath] });
  };
  const viaHandler = (channel) => (filePath) => handlers[channel]({}, filePath);

  const WAYS = [
    ['a document', 'C:\\Docs\\a.pdf', viaHandler(IPC_CHANNELS.ANALYSIS.ANALYZE_DOCUMENT)],
    ['an image', 'C:\\Docs\\a.png', viaHandler(IPC_CHANNELS.ANALYSIS.ANALYZE_IMAGE)],
    ['a recording', 'C:\\Docs\\a.mp3', viaHandler(IPC_CHANNELS.ANALYSIS.ANALYZE_MEDIA)],
    ['a document in a batch', 'C:\\Docs\\a.pdf', viaBatch('documentAnalyzer')],
    ['an image in a batch', 'C:\\Docs\\a.png', viaBatch('imageAnalyzer')],
    ['a recording in a batch', 'C:\\Docs\\a.mp3', viaBatch('mediaAnalyzer')]
  ];

  test.each(WAYS)(
    '%s saved during its analysis is recorded as it was read',
    async (_what, filePath, analyze) => {
      await analyze(filePath);

      expect(mockAnalysisUtils.recordAnalysisResult).toHaveBeenCalledTimes(1);
      expect(recordedStats()).toEqual(expect.objectContaining({ size: 10, mtimeMs: 1000 }));
    }
  );

  test.each(WAYS)(
    '%s removed during its analysis is not recorded from the earlier read',
    async (_what, filePath, analyze) => {
      gone = true;

      await analyze(filePath);

      // Without stats the record reads the file itself and fails, as before.
      expect(mockAnalysisUtils.recordAnalysisResult).toHaveBeenCalledTimes(1);
      expect(recordedStats() ?? null).toBeNull();
    }
  );
});
