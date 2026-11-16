/**
 * @jest-environment node
 *
 * Under the default 'during_analysis' timing the analysis pass indexes a
 * download under its Downloads path. The watcher then moves (or renames) the
 * file itself, and both watchers ignore their own tracked moves, so nothing
 * re-keyed that vector: the old id stayed behind, the organized file had no
 * vector at its real path and its history said embedding 'skipped'.
 */

const mockFs = {
  stat: jest.fn().mockResolvedValue({
    isDirectory: () => false,
    size: 100,
    birthtime: new Date('2026-11-01T00:00:00Z'),
    mtime: new Date('2026-11-01T00:00:00Z')
  }),
  access: jest.fn().mockResolvedValue(undefined),
  mkdir: jest.fn().mockResolvedValue(undefined),
  rename: jest.fn().mockResolvedValue(undefined)
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

jest.mock('../src/shared/atomicFileOperations', () => ({
  crossDeviceMove: jest.fn().mockResolvedValue(undefined),
  renameNoReplace: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../src/shared/fileOperationTracker', () => ({
  getInstance: jest.fn(() => ({
    wasRecentlyOperated: jest.fn().mockReturnValue(false),
    recordOperation: jest.fn()
  }))
}));

// Default settings: the analysis pass embeds, the final stage does not.
jest.mock('../src/main/services/embedding/embeddingGate', () => ({
  shouldEmbed: jest
    .fn()
    .mockResolvedValue({ shouldEmbed: false, timing: 'during_analysis', policy: 'embed' })
}));

jest.mock('../src/main/ipc/analysisUtils', () => ({
  recordAnalysisResult: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../src/main/services/autoOrganize/namingUtils', () => ({
  generateSuggestedNameFromAnalysis: jest.fn(() => 'invoice-2026-11-01')
}));

const mockSearchService = { invalidateIndex: jest.fn() };
jest.mock('../src/main/ipc/semantic', () => ({
  getSearchServiceInstance: jest.fn(() => mockSearchService)
}));

const path = require('path');
const { recordAnalysisResult } = require('../src/main/ipc/analysisUtils');
const { getSemanticFileId } = require('../src/shared/fileIdUtils');
const DownloadWatcher = require('../src/main/services/DownloadWatcher');

const FINANCE = { id: 'f1', name: 'Finance', path: path.resolve('/smart/Finance') };
const SOURCE = path.resolve('/downloads/invoice.pdf');
const DEST = path.join(FINANCE.path, 'invoice-2026-11-01.pdf');

function handoffFor(filePath) {
  return {
    vector: [0.1, 0.2],
    model: 'embed-model',
    meta: { path: filePath },
    wasEnqueued: true,
    chunksEmbedded: true
  };
}

function makeWatcher({ coordinator, vectorRow = null } = {}) {
  const calls = [];
  const filePathCoordinator =
    coordinator === undefined
      ? {
          atomicPathUpdate: jest.fn(async (oldPath, newPath) => {
            calls.push(['atomicPathUpdate', oldPath, newPath]);
            return { success: true, errors: [], updated: { vectorDb: true } };
          })
        }
      : coordinator;
  recordAnalysisResult.mockImplementation(async ({ filePath }) => {
    calls.push(['recordAnalysisResult', filePath]);
  });
  const analysisHistoryService = {
    getAnalysisByPath: jest.fn().mockResolvedValue({ embedding: { status: null } }),
    updateEmbeddingStateByPath: jest.fn().mockResolvedValue(undefined)
  };
  const vectorDbService = {
    getFile: jest.fn().mockResolvedValue(vectorRow),
    upsertFile: jest.fn()
  };
  const watcher = new DownloadWatcher({
    analyzeDocumentFile: jest.fn(),
    analyzeImageFile: jest.fn(),
    getCustomFolders: jest.fn(() => [FINANCE]),
    autoOrganizeService: { processNewFile: jest.fn() },
    settingsService: { load: jest.fn().mockResolvedValue({ autoOrganize: true }) },
    analysisHistoryService,
    vectorDbService,
    folderMatcher: { embedText: jest.fn() },
    filePathCoordinator
  });
  watcher._ensureDirectory = jest.fn().mockResolvedValue(undefined);
  return { watcher, filePathCoordinator, analysisHistoryService, vectorDbService, calls };
}

function autoOrganizeResult() {
  const analysis = { summary: 'An invoice', subject: 'Invoice', category: 'Finance' };
  return {
    source: SOURCE,
    destination: DEST,
    analysis: { ...analysis, _embeddingForPersistence: handoffFor(SOURCE) },
    confidence: 0.9
  };
}

describe('DownloadWatcher re-keys the analysis index after its own move', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('auto-organize moves the vector, chunks and queue item to the destination', async () => {
    const { watcher, filePathCoordinator, calls } = makeWatcher();
    watcher.autoOrganizeService.processNewFile.mockResolvedValue(autoOrganizeResult());

    await watcher._attemptAutoOrganize(SOURCE);

    expect(filePathCoordinator.atomicPathUpdate).toHaveBeenCalledWith(SOURCE, DEST, {
      type: 'move',
      folderMeta: { newSmartFolder: 'Finance', newSmartFolderPath: FINANCE.path }
    });
    // Before history is written, so the destination entry is the one that stays.
    const order = calls.map((c) => c[0]);
    expect(order.indexOf('atomicPathUpdate')).toBeLessThan(order.indexOf('recordAnalysisResult'));
    expect(mockSearchService.invalidateIndex).toHaveBeenCalledWith(
      expect.objectContaining({ oldPath: SOURCE, newPath: DEST })
    );
  });

  test('the moved file is marked done, not skipped, when its row is already at the new id', async () => {
    const { watcher, analysisHistoryService, vectorDbService } = makeWatcher({
      vectorRow: { id: 'x' }
    });
    watcher.autoOrganizeService.processNewFile.mockResolvedValue(autoOrganizeResult());

    await watcher._attemptAutoOrganize(SOURCE);

    expect(vectorDbService.getFile).toHaveBeenCalledWith(getSemanticFileId(DEST));
    expect(analysisHistoryService.updateEmbeddingStateByPath).toHaveBeenCalledWith(DEST, {
      status: 'done'
    });
    expect(analysisHistoryService.updateEmbeddingStateByPath).not.toHaveBeenCalledWith(
      DEST,
      expect.objectContaining({ status: 'skipped' })
    );
    // The analysis vector is reused, not computed again.
    expect(vectorDbService.upsertFile).not.toHaveBeenCalled();
  });

  test('a vector still queued leaves the moved file pending', async () => {
    const { watcher, analysisHistoryService } = makeWatcher({ vectorRow: null });
    watcher.autoOrganizeService.processNewFile.mockResolvedValue(autoOrganizeResult());

    await watcher._attemptAutoOrganize(SOURCE);

    expect(analysisHistoryService.updateEmbeddingStateByPath).toHaveBeenCalledWith(DEST, {
      status: 'pending',
      model: 'embed-model'
    });
  });

  test('without a coordinator the move still completes and history keeps the old skipped state', async () => {
    const { watcher, analysisHistoryService } = makeWatcher({ coordinator: null });
    watcher.autoOrganizeService.processNewFile.mockResolvedValue(autoOrganizeResult());

    const outcome = await watcher._attemptAutoOrganize(SOURCE);

    expect(outcome).toEqual({ handled: true, shouldFallback: false });
    expect(analysisHistoryService.updateEmbeddingStateByPath).toHaveBeenCalledWith(DEST, {
      status: 'skipped'
    });
  });

  test('a coordinator that throws does not fail the organize', async () => {
    const { watcher } = makeWatcher({
      coordinator: { atomicPathUpdate: jest.fn().mockRejectedValue(new Error('locked')) }
    });
    watcher.autoOrganizeService.processNewFile.mockResolvedValue(autoOrganizeResult());

    const outcome = await watcher._attemptAutoOrganize(SOURCE);

    expect(outcome).toEqual({ handled: true, shouldFallback: false });
    expect(recordAnalysisResult).toHaveBeenCalledWith(expect.objectContaining({ filePath: DEST }));
  });

  test('a fallback rename re-keys the index to the renamed file', async () => {
    const { watcher, filePathCoordinator, analysisHistoryService } = makeWatcher({
      vectorRow: { id: 'x' }
    });
    watcher.settingsService.load.mockResolvedValue({ namingConvention: 'subject-date' });
    watcher.analyzeDocumentFile.mockResolvedValue({
      summary: 'An invoice',
      subject: 'Invoice',
      _embeddingForPersistence: handoffFor(SOURCE)
    });
    const renamed = path.join(path.dirname(SOURCE), 'invoice-2026-11-01.pdf');

    await watcher._fallbackOrganize(SOURCE);

    expect(filePathCoordinator.atomicPathUpdate).toHaveBeenCalledWith(
      SOURCE,
      renamed,
      expect.objectContaining({ type: 'move' })
    );
    expect(analysisHistoryService.updateEmbeddingStateByPath).not.toHaveBeenCalledWith(
      renamed,
      expect.objectContaining({ status: 'skipped' })
    );
  });

  test('a fallback that does not rename leaves the index alone', async () => {
    const { watcher, filePathCoordinator } = makeWatcher();
    watcher.settingsService.load.mockResolvedValue({});
    watcher.analyzeDocumentFile.mockResolvedValue({
      summary: 'An invoice',
      subject: 'Invoice',
      _embeddingForPersistence: handoffFor(SOURCE)
    });

    await watcher._fallbackOrganize(SOURCE);

    expect(filePathCoordinator.atomicPathUpdate).not.toHaveBeenCalled();
  });
});
