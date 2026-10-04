/**
 * @jest-environment node
 *
 * The Downloads route used to persist a file vector and stop. Passage
 * (chunk) vectors came only from the smart-folder watcher, which never sees
 * a file the Downloads watcher just organized, so those files had no
 * deep-recall leg until a manual Rebuild (audit ST-05).
 */

const mockFs = {
  stat: jest.fn().mockResolvedValue({ isDirectory: () => false, size: 100 }),
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

jest.mock('../src/main/services/embedding/embeddingGate', () => ({
  shouldEmbed: jest.fn().mockResolvedValue({ shouldEmbed: true, timing: 'final', policy: 'embed' })
}));

jest.mock('../src/shared/folderUtils', () => ({
  findContainingSmartFolder: jest.fn(() => ({ name: 'Docs', path: '/custom/docs' }))
}));

jest.mock('../src/main/analysis/embeddingModelOptions', () => ({
  resolveEmbeddingModelOptions: jest.fn().mockResolvedValue({})
}));

jest.mock('../src/main/analysis/chunkEmbedding', () => ({
  embedFileChunks: jest.fn().mockResolvedValue({ persisted: 2, skipped: null })
}));

const { embedFileChunks } = require('../src/main/analysis/chunkEmbedding');
const DownloadWatcher = require('../src/main/services/DownloadWatcher');

function makeWatcher() {
  const folderMatcher = {
    embedText: jest.fn().mockResolvedValue({ vector: [0.1, 0.2, 0.3], model: 'embed-model' })
  };
  const vectorDbService = {
    upsertFile: jest.fn().mockResolvedValue(undefined),
    batchUpsertFileChunks: jest.fn(),
    deleteFileChunks: jest.fn()
  };
  const watcher = new DownloadWatcher({
    analyzeDocumentFile: jest.fn(),
    analyzeImageFile: jest.fn(),
    getCustomFolders: jest.fn(() => [{ id: '1', name: 'Docs', path: '/custom/docs' }]),
    settingsService: { load: jest.fn().mockResolvedValue({}) },
    folderMatcher,
    vectorDbService
  });
  return { watcher, folderMatcher, vectorDbService };
}

const longText = 'A long document body. '.repeat(40);

describe('DownloadWatcher passage vectors', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('builds passage vectors right after the file vector is stored', async () => {
    const { watcher, folderMatcher, vectorDbService } = makeWatcher();
    const filePath = '/custom/docs/report.pdf';

    await watcher._embedAnalyzedFile(filePath, {
      analysis: { summary: 'A report', subject: 'Report', extractedText: longText }
    });

    expect(vectorDbService.upsertFile).toHaveBeenCalledTimes(1);
    expect(embedFileChunks).toHaveBeenCalledTimes(1);
    const args = embedFileChunks.mock.calls[0][0];
    expect(args).toMatchObject({
      fileId: vectorDbService.upsertFile.mock.calls[0][0].id,
      filePath,
      extractedText: longText,
      vectorDb: vectorDbService
    });
    // Passages come from the same embedder as the file vector.
    await args.embedText('passage');
    expect(folderMatcher.embedText).toHaveBeenCalledWith('passage');
  });

  test('images keep their own pipeline: no passage vectors', async () => {
    const { watcher, vectorDbService } = makeWatcher();

    await watcher._embedAnalyzedFile('/custom/docs/photo.jpg', {
      analysis: { summary: 'A photo', subject: 'Photo', extractedText: longText }
    });

    expect(vectorDbService.upsertFile).toHaveBeenCalledTimes(1);
    expect(embedFileChunks).not.toHaveBeenCalled();
  });

  test('a skipped file vector means no passage vectors either', async () => {
    const { shouldEmbed } = require('../src/main/services/embedding/embeddingGate');
    shouldEmbed.mockResolvedValueOnce({ shouldEmbed: false, timing: 'manual', policy: 'skip' });
    const { watcher, vectorDbService } = makeWatcher();

    await watcher._embedAnalyzedFile('/custom/docs/report.pdf', {
      analysis: { summary: 'A report', subject: 'Report', extractedText: longText }
    });

    expect(vectorDbService.upsertFile).not.toHaveBeenCalled();
    expect(embedFileChunks).not.toHaveBeenCalled();
  });
});
