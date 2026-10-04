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
  const DELAY_MS = 35;
  // Exposed via globalThis because jest.mock factories cannot close over
  // module-scope test variables. The test asserts on maxInFlight directly —
  // overlapping classifyFile calls are the proof of parallelism, unlike a
  // wall-clock bound, which flakes on slow shared CI runners.
  const stats = { inFlight: 0, maxInFlight: 0 };
  globalThis.__triageParallelStats__ = stats;
  class SlowClassifier {
    async classifyFile() {
      stats.inFlight += 1;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      await new Promise((r) => setTimeout(r, DELAY_MS));
      stats.inFlight -= 1;
      return {
        bucket: actual.BUCKET.AMBIGUOUS,
        signal: actual.SIGNAL.NO_MATCH,
        confidence: 0,
        why: 'parallel test'
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

describe('DownloadsTriageService.start() parallel Tier 0', () => {
  let testDir;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `triage-par-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    const nodes = [];
    for (let i = 0; i < 64; i++) {
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

  test('runs Tier 0 classification in parallel, not serially', async () => {
    const stats = globalThis.__triageParallelStats__;
    stats.inFlight = 0;
    stats.maxInFlight = 0;
    const svc = new DownloadsTriageService();
    const result = await svc.start({ folderPath: testDir, minAgeHours: 0 });
    expect(result.success).toBe(true);
    expect(result.total).toBe(64);
    expect(stats.maxInFlight).toBeGreaterThanOrEqual(2);
  });
});
