/**
 * @jest-environment node
 *
 * The analysis pass already indexes most files the smart-folder watcher
 * analyzes: documents get their file vector queued and their passages
 * written by the folder matcher, images get their file vector queued by the
 * image pipeline. The watcher used to redo both, so every analyzed document
 * had its passages deleted and rewritten (from the shorter stored copy of
 * the text) and every image was embedded twice. These tests pin that the
 * watcher reads the analysis hand-off and only does what is still missing.
 */

const mockFs = {
  stat: jest.fn().mockResolvedValue({ size: 100 }),
  access: jest.fn().mockResolvedValue(undefined)
};
jest.mock('fs', () => ({ promises: mockFs, constants: { R_OK: 4 } }));

jest.mock('chokidar', () => ({
  watch: jest.fn().mockReturnValue({ on: jest.fn().mockReturnThis(), close: jest.fn() })
}));

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

jest.mock('../src/main/services/embedding/embeddingGate', () => ({
  shouldEmbed: jest.fn().mockResolvedValue({ shouldEmbed: true, timing: 'ok', policy: 'embed' })
}));

jest.mock('../src/main/analysis/chunkEmbedding', () => ({
  embedFileChunks: jest.fn().mockResolvedValue({ persisted: 2, skipped: null })
}));

jest.mock('../src/main/analysis/embeddingSummary', () => ({
  buildEmbeddingSummary: jest.fn(() => ({ text: 'summary text' }))
}));

jest.mock('../src/main/analysis/embeddingModelOptions', () => ({
  resolveEmbeddingModelOptions: jest.fn().mockResolvedValue({})
}));

jest.mock('../src/main/services/organization/learningFeedback', () => ({
  getInstance: jest.fn(() => null),
  FEEDBACK_SOURCES: { WATCHER: 'watcher' }
}));

const { embedFileChunks } = require('../src/main/analysis/chunkEmbedding');
const SmartFolderWatcher = require('../src/main/services/SmartFolderWatcher');

const longText = 'A long document body. '.repeat(40);

/** A small stand-in for `this`: only what _embedAnalyzedFile touches. */
function makeFakeWatcher() {
  const fake = {
    analysisHistoryService: {
      getAnalysisByPath: jest.fn().mockResolvedValue(null),
      updateEmbeddingStateByPath: jest.fn().mockResolvedValue(undefined)
    },
    vectorDbService: {
      upsertFile: jest.fn().mockResolvedValue(undefined)
    },
    folderMatcher: {
      embedText: jest.fn().mockResolvedValue({ vector: [0.4, 0.5], model: 'embed-model' })
    },
    settingsService: { load: jest.fn().mockResolvedValue({}) }
  };
  fake._embedChunksForFile = SmartFolderWatcher.prototype._embedChunksForFile.bind(fake);
  return fake;
}

function embed(fake, filePath, result) {
  return SmartFolderWatcher.prototype._embedAnalyzedFile.call(fake, filePath, result);
}

describe('SmartFolderWatcher reuses what the analysis pass already indexed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('a document whose passages this run already wrote is not chunked again', async () => {
    const fake = makeFakeWatcher();
    const filePath = '/docs/report.pdf';

    await embed(fake, filePath, {
      extractedText: longText,
      _embeddingForPersistence: {
        vector: [0.1, 0.2],
        model: 'embed-model',
        meta: { path: filePath },
        wasEnqueued: true,
        chunksEmbedded: true
      }
    });

    expect(embedFileChunks).not.toHaveBeenCalled();
    expect(fake.vectorDbService.upsertFile).not.toHaveBeenCalled();
    expect(fake.folderMatcher.embedText).not.toHaveBeenCalled();
    expect(fake.analysisHistoryService.updateEmbeddingStateByPath).toHaveBeenCalledWith(filePath, {
      status: 'pending',
      model: 'embed-model'
    });
  });

  test('a queued file the queue already finished is not set back to pending', async () => {
    const fake = makeFakeWatcher();
    const filePath = '/docs/report.pdf';
    fake.analysisHistoryService.getAnalysisByPath.mockResolvedValue({
      embedding: { status: 'done', model: 'embed-model' }
    });

    await embed(fake, filePath, {
      extractedText: longText,
      _embeddingForPersistence: {
        vector: [0.1, 0.2],
        model: 'embed-model',
        meta: { path: filePath },
        wasEnqueued: true,
        chunksEmbedded: true
      }
    });

    expect(fake.analysisHistoryService.updateEmbeddingStateByPath).not.toHaveBeenCalledWith(
      filePath,
      expect.objectContaining({ status: 'pending' })
    );
  });

  test('a queued document whose passages were NOT written still gets them here', async () => {
    const fake = makeFakeWatcher();
    const filePath = '/docs/report.pdf';

    await embed(fake, filePath, {
      extractedText: longText,
      _embeddingForPersistence: {
        vector: [0.1, 0.2],
        model: 'embed-model',
        meta: { path: filePath },
        wasEnqueued: true,
        chunksEmbedded: false
      }
    });

    expect(embedFileChunks).toHaveBeenCalledTimes(1);
    expect(embedFileChunks.mock.calls[0][0]).toMatchObject({
      filePath,
      extractedText: longText
    });
    expect(fake.vectorDbService.upsertFile).not.toHaveBeenCalled();
  });

  test('an image the image pipeline queued is not embedded again, only chunked', async () => {
    const fake = makeFakeWatcher();
    const filePath = '/pics/scan.png';

    await embed(fake, filePath, {
      extractedText: longText,
      _embeddingForPersistence: {
        vector: [0.1, 0.2],
        model: 'embed-model',
        meta: { path: filePath },
        wasEnqueued: true
      }
    });

    expect(fake.folderMatcher.embedText).not.toHaveBeenCalled();
    expect(fake.vectorDbService.upsertFile).not.toHaveBeenCalled();
    expect(fake.analysisHistoryService.updateEmbeddingStateByPath).toHaveBeenCalledWith(filePath, {
      status: 'pending',
      model: 'embed-model'
    });
    // Nothing upstream builds passages for images, so the watcher still does,
    // under the image id.
    expect(embedFileChunks).toHaveBeenCalledTimes(1);
    expect(embedFileChunks.mock.calls[0][0].fileId).toMatch(/^image:/);
  });

  test('an image whose hand-off says "not queued" is still embedded here', async () => {
    const fake = makeFakeWatcher();
    const filePath = '/pics/scan.png';

    await embed(fake, filePath, {
      extractedText: longText,
      summary: 'A scanned page',
      _embeddingForPersistence: {
        vector: [0.1, 0.2],
        model: 'embed-model',
        meta: { path: filePath },
        wasEnqueued: false
      }
    });

    expect(fake.folderMatcher.embedText).toHaveBeenCalled();
    expect(fake.vectorDbService.upsertFile).toHaveBeenCalledTimes(1);
  });
});
