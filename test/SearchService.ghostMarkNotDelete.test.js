// test/SearchService.ghostMarkNotDelete.test.js
jest.mock('../src/shared/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  },
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })
}));

// The repo-wide setupFilesAfterEnv (test/test-setup.js) mocks `fs` with an
// empty in-memory memfs volume, so a real `fs.access` on __filename (or any
// path on disk) would ENOENT there too. Override it here, matching the
// pattern already used by test/SearchService.resilience.test.js: only paths
// listed in mockAbsentPaths ENOENT, everything else resolves as present.
// (Named with the `mock` prefix because jest.mock() factories may only
// close over out-of-scope variables named that way — see babel-plugin-jest-hoist.)
//
// Note: the ENOENT-vs-missing-volume branch in `_validateFileExistence`
// checks `path.parse(filePath).root`. On Windows that yields `C:\` (or
// whichever drive letter), so listing a drive root in mockAbsentPaths actually
// exercises the "volume itself is gone" branch. On POSIX, `path.parse` of a
// Windows-style path like `E:\gone\file.txt` yields an empty root (''), so
// that `if (volumeRoot)` guard is falsy and the branch is skipped entirely —
// the third test below is Windows-only for that reason.
const mockAbsentPaths = new Set([
  'C:\\definitely\\missing\\ghost-file.txt',
  'C:\\definitely\\missing\\x.txt',
  'E:\\gone\\file.txt',
  'E:\\'
]);

jest.mock('fs', () => ({
  promises: {
    access: jest.fn(async (filePath) => {
      if (mockAbsentPaths.has(String(filePath))) {
        const err = new Error('ENOENT: no such file or directory');
        err.code = 'ENOENT';
        throw err;
      }
      return undefined;
    })
  }
}));

const { SearchService } = require('../src/main/services/SearchService');

const flushImmediates = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

function makeService() {
  const vectorDbService = {
    initialize: jest.fn().mockResolvedValue(true),
    getStats: jest.fn().mockResolvedValue({ files: 0, fileChunks: 0, folders: 0 }),
    getFile: jest.fn().mockResolvedValue(null),
    markEmbeddingsOrphaned: jest.fn().mockResolvedValue({ marked: 1, failed: 0 }),
    batchDeleteFileEmbeddings: jest.fn().mockResolvedValue({ deleted: 1 })
  };
  const service = new SearchService({
    vectorDbService,
    analysisHistoryService: { analysisHistory: { metadata: { totalEntries: 0 }, entries: {} } },
    parallelEmbeddingService: { embedText: jest.fn() }
  });
  return { service, vectorDbService };
}

describe('SearchService ghost cleanup (D5 monotonic store)', () => {
  test('marks a missing file orphaned and never deletes its embedding', async () => {
    const { service, vectorDbService } = makeService();
    const ghost = {
      id: 'file:c:/definitely/missing/ghost-file.txt',
      score: 0.9,
      metadata: { path: 'C:\\definitely\\missing\\ghost-file.txt' }
    };
    const present = { id: 'file:present', score: 0.8, metadata: { path: __filename } };

    const outcome = await service._validateFileExistence([ghost, present]);
    await flushImmediates();

    expect(outcome.validResults.map((r) => r.id)).toEqual(['file:present']);
    expect(outcome.ghostCount).toBe(1);
    expect(vectorDbService.markEmbeddingsOrphaned).toHaveBeenCalledWith([ghost.id]);
    expect(vectorDbService.batchDeleteFileEmbeddings).not.toHaveBeenCalled();
  });

  test('does nothing when cleanup is disabled', async () => {
    const { service, vectorDbService } = makeService();
    const ghost = {
      id: 'file:g',
      score: 0.9,
      metadata: { path: 'C:\\definitely\\missing\\x.txt' }
    };
    await service._validateFileExistence([ghost], { triggerCleanup: false });
    await flushImmediates();
    expect(vectorDbService.markEmbeddingsOrphaned).not.toHaveBeenCalled();
    expect(vectorDbService.batchDeleteFileEmbeddings).not.toHaveBeenCalled();
  });

  // Windows-only: see the mockAbsentPaths comment above for why the volume-root
  // guard this exercises is a no-op on POSIX.
  (process.platform === 'win32' ? test : test.skip)(
    'does not mark a file on an unmounted volume',
    async () => {
      const { service, vectorDbService } = makeService();
      const onGoneVolume = {
        id: 'file:e:/gone/file.txt',
        score: 0.9,
        metadata: { path: 'E:\\gone\\file.txt' }
      };
      const outcome = await service._validateFileExistence([onGoneVolume]);
      await flushImmediates();
      expect(outcome.validResults.map((r) => r.id)).toEqual(['file:e:/gone/file.txt']);
      expect(vectorDbService.markEmbeddingsOrphaned).not.toHaveBeenCalled();
    }
  );
});
