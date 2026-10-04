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
  class SlowClassifier {
    async classifyFile() {
      await new Promise((r) => setTimeout(r, 120));
      return {
        bucket: actual.BUCKET.AMBIGUOUS,
        signal: actual.SIGNAL.NO_MATCH,
        confidence: 0,
        why: 'abort test'
      };
    }
  }
  return {
    ...actual,
    FastTriageClassifier: SlowClassifier
  };
});

const { scanDirectory } = require('../../../../src/main/folderScanner');

const {
  DownloadsTriageService
} = require('../../../../src/main/services/triage/DownloadsTriageService');

describe('DownloadsTriageService.start() abort', () => {
  let testDir;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `triage-abort-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    const nodes = [];
    for (let i = 0; i < 6; i++) {
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

  test('returns canceled and does not persist session when aborted', async () => {
    const svc = new DownloadsTriageService();
    const ac = new AbortController();
    const done = svc.start({ folderPath: testDir, minAgeHours: 0 }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    const result = await done;
    expect(result.canceled || result.cancelled).toBe(true);
    expect(result.success).toBe(false);
    expect(svc._sessions.size).toBe(0);
  }, 15000);
});
