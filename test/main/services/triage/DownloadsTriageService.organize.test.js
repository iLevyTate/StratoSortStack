/**
 * @jest-environment node
 */
jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const path = require('path');
const fs = require('fs').promises;
const os = require('os');

const mockPerformFileMove = jest.fn();

jest.mock('../../../../src/main/ipc/files/batchOrganizeHandler', () => ({
  performFileMove: (...args) => mockPerformFileMove(...args),
  computeFileChecksum: jest.fn()
}));

jest.mock('electron', () => ({
  app: { getPath: jest.fn() },
  shell: { trashItem: jest.fn() }
}));

const mockServices = {
  orama: null,
  undoRedo: null,
  coordinator: null
};

jest.mock('../../../../src/main/services/ServiceContainer', () => ({
  container: {
    tryResolve: jest.fn((id) => {
      if (id === 'filePathCoordinator') return mockServices.coordinator;
      if (id === 'oramaVector') return mockServices.orama;
      if (id === 'undoRedo') return mockServices.undoRedo;
      if (id === 'analysisHistory') return null;
      if (id === 'folderMatching') return null;
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

jest.mock('../../../../src/main/core/customFolders', () => ({
  loadCustomFolders: jest.fn().mockResolvedValue([])
}));

let mockClassifierQueue;
jest.mock('../../../../src/main/services/triage/FastTriageClassifier', () => {
  const actual = jest.requireActual('../../../../src/main/services/triage/FastTriageClassifier');
  class MockClassifier {
    async classifyFile() {
      const override = mockClassifierQueue?.shift();
      if (override) return override;
      return {
        bucket: actual.BUCKET.AMBIGUOUS,
        signal: actual.SIGNAL.NO_MATCH,
        confidence: 0,
        why: 'mock ambiguous'
      };
    }
  }
  return {
    ...actual,
    FastTriageClassifier: MockClassifier
  };
});

const { ACTION_TYPES } = require('../../../../src/shared/constants');
const {
  DownloadsTriageService
} = require('../../../../src/main/services/triage/DownloadsTriageService');

describe('DownloadsTriageService act(organize)', () => {
  let testDir;
  let targetDir;
  let service;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `triage-org-${Date.now()}`);
    targetDir = path.join(testDir, 'SmartTarget');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(testDir, 'doc-move.txt'), 'content');

    mockClassifierQueue = [
      {
        bucket: 'keep',
        signal: 'lexical-match',
        confidence: 0.95,
        why: 'test keep',
        suggestedFolder: { id: 'sf1', name: 'Target', path: targetDir }
      }
    ];

    mockServices.orama = { deleteFileByPath: jest.fn() };
    mockServices.undoRedo = { recordBatch: jest.fn().mockResolvedValue('undo-1') };
    mockServices.coordinator = {
      batchPathUpdate: jest.fn().mockResolvedValue({ success: true })
    };

    mockPerformFileMove.mockClear();
    mockPerformFileMove.mockImplementation(async (op) => {
      await fs.mkdir(path.dirname(op.destination), { recursive: true });
      await fs.rename(op.source, op.destination);
      return { destination: op.destination };
    });
    mockServices.undoRedo.recordBatch.mockClear();
    mockServices.coordinator.batchPathUpdate.mockClear();

    jest.resetModules();
    const electron = require('electron');
    electron.app.getPath.mockReturnValue(testDir);

    jest.doMock('electron', () => ({
      app: { getPath: jest.fn().mockReturnValue(testDir) },
      shell: { trashItem: jest.fn() }
    }));

    const {
      DownloadsTriageService: Fresh
    } = require('../../../../src/main/services/triage/DownloadsTriageService');
    service = new Fresh();
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('moves files to suggested folder, records MOVE_BATCH, updates coordinator', async () => {
    const started = await service.start({ folderPath: testDir, minAgeHours: 0 });
    expect(started.buckets.keep.length).toBe(1);
    const row = started.buckets.keep[0];
    const destPath = path.join(targetDir, 'doc-move.txt');

    const result = await service.act({
      triageId: started.triageId,
      action: 'organize',
      files: [
        {
          path: row.filePath,
          size: row.size,
          suggestedFolderPath: row.suggestedFolder.path
        }
      ],
      summary: { label: 'test organize' }
    });

    expect(result.success).toBe(true);
    expect(result.moved).toHaveLength(1);
    expect(path.normalize(result.moved[0].destination)).toBe(path.normalize(destPath));
    expect(mockPerformFileMove).toHaveBeenCalledTimes(1);

    await expect(fs.access(destPath)).resolves.toBeUndefined();

    expect(mockServices.undoRedo.recordBatch).toHaveBeenCalledTimes(1);
    const [batchType, ops, opts] = mockServices.undoRedo.recordBatch.mock.calls[0];
    expect(batchType).toBe(ACTION_TYPES.MOVE_BATCH);
    expect(ops).toEqual([
      expect.objectContaining({
        type: 'move',
        originalPath: path.normalize(row.filePath),
        newPath: path.normalize(destPath)
      })
    ]);
    expect(opts.summary?.label).toBe('test organize');

    expect(mockServices.coordinator.batchPathUpdate).toHaveBeenCalledWith(
      [{ oldPath: path.normalize(row.filePath), newPath: path.normalize(destPath) }],
      { type: 'move' }
    );

    const session = service._getSession(started.triageId);
    expect(session.buckets.keep).toHaveLength(0);
  });

  test('dedup-skipped moves record NO undo op — undo must not relocate the untouched surviving sibling [F-169]', async () => {
    const started = await service.start({ folderPath: testDir, minAgeHours: 0 });
    expect(started.buckets.keep.length).toBe(1);
    const row = started.buckets.keep[0];
    const survivingSibling = path.join(targetDir, 'doc-move.txt');

    // Simulate performFileMove's dedup-skip: an identical file already sits
    // at the destination, so the SOURCE is unlinked and the untouched
    // sibling is reported as the destination.
    mockPerformFileMove.mockImplementation(async (op) => {
      await fs.mkdir(path.dirname(survivingSibling), { recursive: true });
      await fs.writeFile(survivingSibling, 'identical-content');
      await fs.unlink(op.source);
      return { destination: survivingSibling, skipped: true };
    });

    const result = await service.act({
      triageId: started.triageId,
      action: 'organize',
      files: [
        { path: row.filePath, size: row.size, suggestedFolderPath: row.suggestedFolder.path }
      ],
      summary: { label: 'dedup organize' }
    });

    expect(result.success).toBe(true);
    expect(result.moved).toHaveLength(1);
    // Pre-fix a {type:'move', newPath: sibling} op was recorded, so undoing
    // the batch MOVED the sibling — a file this operation never touched —
    // out of its home. No restorable mutation happened; no undo op.
    expect(mockServices.undoRedo.recordBatch).not.toHaveBeenCalled();
  });

  test('partial failure: records moved only, returns failed[], strips only moved rows', async () => {
    await fs.writeFile(path.join(testDir, 'doc-b.txt'), 'b');
    mockClassifierQueue = [
      {
        bucket: 'keep',
        signal: 'lexical-match',
        confidence: 0.95,
        why: 'a',
        suggestedFolder: { id: 'sf1', name: 'Target', path: targetDir }
      },
      {
        bucket: 'keep',
        signal: 'lexical-match',
        confidence: 0.95,
        why: 'b',
        suggestedFolder: { id: 'sf1', name: 'Target', path: targetDir }
      }
    ];

    jest.resetModules();
    jest.doMock('electron', () => ({
      app: { getPath: jest.fn().mockReturnValue(testDir) },
      shell: { trashItem: jest.fn() }
    }));
    const {
      DownloadsTriageService: Fresh
    } = require('../../../../src/main/services/triage/DownloadsTriageService');
    const svc = new Fresh();

    const started = await svc.start({ folderPath: testDir, minAgeHours: 0 });
    const rows = started.buckets.keep;
    expect(rows.length).toBe(2);

    let call = 0;
    mockPerformFileMove.mockImplementation(async (op) => {
      call += 1;
      if (call === 1) {
        await fs.mkdir(path.dirname(op.destination), { recursive: true });
        await fs.rename(op.source, op.destination);
        return { destination: op.destination };
      }
      throw new Error('simulated move failure');
    });

    const result = await svc.act({
      triageId: started.triageId,
      action: 'organize',
      files: rows.map((r) => ({
        path: r.filePath,
        size: r.size,
        suggestedFolderPath: r.suggestedFolder.path
      }))
    });

    expect(result.success).toBe(false);
    expect(result.moved?.length).toBe(1);
    expect(result.failed?.length).toBe(1);

    expect(mockServices.undoRedo.recordBatch).toHaveBeenCalledTimes(1);
    const [, ops] = mockServices.undoRedo.recordBatch.mock.calls[0];
    expect(ops).toHaveLength(1);

    const session = svc._getSession(started.triageId);
    expect(session.buckets.keep.length).toBe(1);
  });

  test('serializes concurrent act(organize) on the same triage session (no overlapping moves)', async () => {
    await fs.writeFile(path.join(testDir, 'doc-2.txt'), '2');
    mockClassifierQueue = [
      {
        bucket: 'keep',
        signal: 'lexical-match',
        confidence: 0.95,
        why: 'a',
        suggestedFolder: { id: 'sf1', name: 'Target', path: targetDir }
      },
      {
        bucket: 'keep',
        signal: 'lexical-match',
        confidence: 0.95,
        why: 'b',
        suggestedFolder: { id: 'sf1', name: 'Target', path: targetDir }
      }
    ];

    jest.resetModules();
    jest.doMock('electron', () => ({
      app: { getPath: jest.fn().mockReturnValue(testDir) },
      shell: { trashItem: jest.fn() }
    }));
    const {
      DownloadsTriageService: Fresh
    } = require('../../../../src/main/services/triage/DownloadsTriageService');
    const svc = new Fresh();

    const started = await svc.start({ folderPath: testDir, minAgeHours: 0 });
    const rows = started.buckets.keep;
    expect(rows.length).toBe(2);

    let inflight = 0;
    let maxInflight = 0;
    mockPerformFileMove.mockImplementation(async (op) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 20));
      await fs.mkdir(path.dirname(op.destination), { recursive: true });
      await fs.rename(op.source, op.destination);
      inflight -= 1;
      return { destination: op.destination };
    });

    await Promise.all([
      svc.act({
        triageId: started.triageId,
        action: 'organize',
        files: [
          {
            path: rows[0].filePath,
            size: rows[0].size,
            suggestedFolderPath: rows[0].suggestedFolder.path
          }
        ]
      }),
      svc.act({
        triageId: started.triageId,
        action: 'organize',
        files: [
          {
            path: rows[1].filePath,
            size: rows[1].size,
            suggestedFolderPath: rows[1].suggestedFolder.path
          }
        ]
      })
    ]);

    expect(maxInflight).toBe(1);
  });
});
