/**
 * @jest-environment node
 */
jest.unmock('fs');
jest.unmock('fs/promises');

const path = require('path');
const fs = require('fs').promises;
const os = require('os');

jest.mock('electron', () => ({
  app: { getPath: jest.fn() },
  shell: { trashItem: jest.fn() }
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

jest.mock('../../../../src/main/core/customFolders', () => ({
  loadCustomFolders: jest.fn().mockResolvedValue([])
}));

jest.mock('../../../../src/main/folderScanner', () => ({
  scanDirectory: jest.fn()
}));

jest.mock('../../../../src/main/services/triage/FastTriageClassifier', () => {
  const actual = jest.requireActual('../../../../src/main/services/triage/FastTriageClassifier');
  class QuickClassifier {
    async classifyFile() {
      return {
        bucket: actual.BUCKET.AMBIGUOUS,
        signal: actual.SIGNAL.NO_MATCH,
        confidence: 0,
        why: 'progress test'
      };
    }
  }
  return {
    ...actual,
    FastTriageClassifier: QuickClassifier
  };
});

const { scanDirectory } = require('../../../../src/main/folderScanner');

const {
  DownloadsTriageService
} = require('../../../../src/main/services/triage/DownloadsTriageService');

describe('DownloadsTriageService.start() onProgress', () => {
  let testDir;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `triage-prog-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    const nodes = [];
    for (let i = 0; i < 12; i++) {
      const fp = path.join(testDir, `f${i}.txt`);
      await fs.writeFile(fp, 'x');
      nodes.push({
        type: 'file',
        path: fp,
        name: `f${i}.txt`,
        size: 1,
        mtimeMs: Date.now(),
        stats: { size: 1, mtimeMs: Date.now() }
      });
    }
    scanDirectory.mockResolvedValue(nodes);
    const electron = require('electron');
    electron.app.getPath.mockReturnValue(testDir);
  });

  test('onProgress emits monotonic done through total', async () => {
    const progresses = [];
    const svc = new DownloadsTriageService();
    await svc.start(
      { folderPath: testDir, minAgeHours: 0 },
      {
        onProgress: (p) => progresses.push({ ...p })
      }
    );
    expect(progresses.length).toBeGreaterThan(0);
    const last = progresses[progresses.length - 1];
    expect(last.phase).toBe('tier0');
    expect(last.done).toBe(12);
    expect(last.total).toBe(12);
    let prev = -1;
    for (const pr of progresses) {
      expect(pr.done).toBeGreaterThanOrEqual(prev);
      prev = pr.done;
    }
  });
});
