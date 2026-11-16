/**
 * @jest-environment node
 *
 * When Organize finds an identical copy already in the destination folder,
 * the source is removed and the kept sibling is reported as the destination.
 * That is a deletion, not a move: sending it to batchPathUpdate re-pointed
 * the kept file's path at the removed file's history entry, so a lookup of
 * the kept file returned the removed file's analysis.
 */
jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const path = require('path');
const fs = require('fs').promises;
const os = require('os');

const mockPerformFileMove = jest.fn();

jest.mock('../src/main/ipc/files/batchOrganizeHandler', () => ({
  performFileMove: (...args) => mockPerformFileMove(...args),
  computeFileChecksum: jest.fn()
}));

jest.mock('electron', () => ({
  app: { getPath: jest.fn() },
  shell: { trashItem: jest.fn() }
}));

const mockServices = { undoRedo: null, coordinator: null };

jest.mock('../src/main/services/ServiceContainer', () => ({
  container: {
    tryResolve: jest.fn((id) => {
      if (id === 'filePathCoordinator') return mockServices.coordinator;
      if (id === 'undoRedo') return mockServices.undoRedo;
      return null;
    }),
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

jest.mock('../src/main/core/customFolders', () => ({
  loadCustomFolders: jest.fn().mockResolvedValue([])
}));

let mockTargetDir;
jest.mock('../src/main/services/triage/FastTriageClassifier', () => {
  const actual = jest.requireActual('../src/main/services/triage/FastTriageClassifier');
  class MockClassifier {
    async classifyFile() {
      return {
        bucket: 'keep',
        signal: 'lexical-match',
        confidence: 0.95,
        why: 'test keep',
        suggestedFolder: { id: 'sf1', name: 'Target', path: mockTargetDir }
      };
    }
  }
  return { ...actual, FastTriageClassifier: MockClassifier };
});

const { DownloadsTriageService } = require('../src/main/services/triage/DownloadsTriageService');

describe('DownloadsTriageService act(organize) with a duplicate already in the folder', () => {
  let testDir;
  let service;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-dedup-hist-'));
    mockTargetDir = path.join(testDir, 'Target');
    await fs.mkdir(mockTargetDir, { recursive: true });
    await fs.writeFile(path.join(testDir, 'report.pdf'), 'same bytes');
    await fs.writeFile(path.join(testDir, 'notes.txt'), 'other');
    // The scan root must sit inside Downloads.
    require('electron').app.getPath.mockReturnValue(testDir);

    mockServices.undoRedo = { recordBatch: jest.fn().mockResolvedValue('undo-1') };
    mockServices.coordinator = {
      batchPathUpdate: jest.fn().mockResolvedValue({ success: true }),
      handleFileDeletion: jest.fn().mockResolvedValue({ success: true })
    };

    // report.pdf is a dedup skip (its identical copy is kept as
    // "report (1).pdf"); everything else moves normally.
    mockPerformFileMove.mockReset();
    mockPerformFileMove.mockImplementation(async (op) => {
      if (path.basename(op.source) === 'report.pdf') {
        await fs.unlink(op.source);
        return {
          skipped: true,
          destination: path.join(mockTargetDir, 'report (1).pdf'),
          reason: 'duplicate'
        };
      }
      await fs.rename(op.source, op.destination);
      return { destination: op.destination };
    });

    service = new DownloadsTriageService();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function organize(names) {
    const started = await service.start({ folderPath: testDir, minAgeHours: 0 });
    const rows = started.buckets.keep.filter((r) => names.includes(path.basename(r.filePath)));
    expect(rows).toHaveLength(names.length);
    return service.act({
      triageId: started.triageId,
      action: 'organize',
      files: rows.map((r) => ({
        path: r.filePath,
        size: r.size,
        suggestedFolderPath: r.suggestedFolder.path
      }))
    });
  }

  test('only real moves reach batchPathUpdate; the removed source is a deletion', async () => {
    const result = await organize(['report.pdf', 'notes.txt']);

    expect(result.success).toBe(true);
    // The renderer still sees both files leave the triage list.
    expect(result.moved).toHaveLength(2);

    expect(mockServices.coordinator.batchPathUpdate).toHaveBeenCalledTimes(1);
    const [changes] = mockServices.coordinator.batchPathUpdate.mock.calls[0];
    expect(changes).toEqual([
      {
        oldPath: path.join(testDir, 'notes.txt'),
        newPath: path.join(mockTargetDir, 'notes.txt')
      }
    ]);
    expect(mockServices.coordinator.handleFileDeletion).toHaveBeenCalledTimes(1);
    expect(mockServices.coordinator.handleFileDeletion).toHaveBeenCalledWith(
      path.join(testDir, 'report.pdf')
    );
  });

  test('a request where every file is a duplicate still removes the source from history', async () => {
    const result = await organize(['report.pdf']);

    expect(result.success).toBe(true);
    expect(mockServices.undoRedo.recordBatch).not.toHaveBeenCalled();
    expect(mockServices.coordinator.batchPathUpdate).not.toHaveBeenCalled();
    expect(mockServices.coordinator.handleFileDeletion).toHaveBeenCalledWith(
      path.join(testDir, 'report.pdf')
    );
  });

  test('a failing index cleanup does not fail the organize', async () => {
    mockServices.coordinator.handleFileDeletion.mockRejectedValue(new Error('index busy'));
    const result = await organize(['report.pdf']);
    expect(result.success).toBe(true);
    expect(result.moved).toHaveLength(1);
  });
});
