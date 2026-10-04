/**
 * @jest-environment node
 */
jest.unmock('fs');
jest.unmock('fs/promises');

const path = require('path');
const fs = require('fs').promises;
const os = require('os');

jest.mock('../../../../src/main/folderScanner', () => ({
  scanDirectory: jest.fn()
}));

jest.mock('electron', () => ({
  app: { getPath: jest.fn() }
}));

jest.mock('../../../../src/main/core/customFolders', () => ({
  loadCustomFolders: jest.fn().mockResolvedValue([])
}));

jest.mock('../../../../src/main/services/ServiceContainer', () => ({
  container: {
    tryResolve: jest.fn(() => null),
    has: jest.fn(() => true),
    resolve: jest.fn()
  },
  ServiceIds: {
    ORAMA_VECTOR: 'oramaVector',
    UNDO_REDO: 'undoRedo',
    ANALYSIS_HISTORY: 'analysisHistory',
    FOLDER_MATCHING: 'folderMatching',
    PARALLEL_EMBEDDING: 'parallelEmbedding',
    FILE_PATH_COORDINATOR: 'filePathCoordinator'
  }
}));

jest.mock('../../../../src/main/services/triage/FastTriageClassifier', () => {
  const actual = jest.requireActual('../../../../src/main/services/triage/FastTriageClassifier');
  return {
    ...actual,
    FastTriageClassifier: class {
      async classifyFile() {
        return {
          bucket: actual.BUCKET.AMBIGUOUS,
          signal: actual.SIGNAL.NO_MATCH,
          confidence: 0,
          why: 'mock'
        };
      }
    }
  };
});

const { scanDirectory } = require('../../../../src/main/folderScanner');
const electron = require('electron');

const {
  DownloadsTriageService
} = require('../../../../src/main/services/triage/DownloadsTriageService');

describe('DownloadsTriageService scan walk (folder nodes)', () => {
  let testDir;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `triage-walk-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    electron.app.getPath.mockReturnValue(testDir);
    scanDirectory.mockResolvedValue([
      { type: 'folder', path: path.join(testDir, 'empty-sub'), name: 'empty-sub' }
    ]);
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('does not treat type=folder without children as a file entry', async () => {
    const svc = new DownloadsTriageService();
    const result = await svc.start({ folderPath: testDir, minAgeHours: 0 });
    expect(result.success).toBe(true);
    expect(result.total).toBe(0);
  });
});
