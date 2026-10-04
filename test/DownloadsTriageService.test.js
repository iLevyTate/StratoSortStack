/**
 * @jest-environment node
 */
/**
 * Integration tests for the Phase 3 DownloadsTriageService orchestrator.
 * Exercises: session lifecycle (TTL + concurrency cap), the act('trash')
 * path hitting TrashService + UndoRedoService, and the 'ignore' cleanup.
 *
 * The FastTriageClassifier is mocked so we can control bucket assignment
 * deterministically; the integration with the real classifier is covered
 * by FastTriageClassifier.test.js.
 */

jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const path = require('path');
const fs = require('fs').promises;
const os = require('os');

const mockTrashItem = jest.fn();

jest.mock('electron', () => ({
  app: { getPath: jest.fn() },
  shell: { trashItem: (...args) => mockTrashItem(...args) }
}));

const mockServices = {
  orama: null,
  undoRedo: null,
  analysisHistory: null,
  folderMatching: null
};

jest.mock('../src/main/services/ServiceContainer', () => ({
  container: {
    tryResolve: jest.fn((id) => {
      if (id === 'oramaVector') return mockServices.orama;
      if (id === 'undoRedo') return mockServices.undoRedo;
      if (id === 'analysisHistory') return mockServices.analysisHistory;
      if (id === 'folderMatching') return mockServices.folderMatching;
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
    PARALLEL_EMBEDDING: 'parallelEmbedding'
  }
}));

jest.mock('../src/main/core/customFolders', () => ({
  loadCustomFolders: jest.fn().mockResolvedValue([])
}));

// Force every classifier call into a predictable bucket so the orchestrator
// branches are tested without depending on the real cascade.
let mockClassifierQueue;
// Every (entry, context) the orchestrator handed the classifier, so a test
// can pin what the sweep tells Tier 0 about the folder it is sweeping.
let mockClassifyCalls;
jest.mock('../src/main/services/triage/FastTriageClassifier', () => {
  const actual = jest.requireActual('../src/main/services/triage/FastTriageClassifier');
  class MockClassifier {
    async classifyFile(entry, context) {
      mockClassifyCalls?.push({ entry, context });
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

describe('DownloadsTriageService', () => {
  let testDir;
  let service;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `triage-svc-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(path.join(testDir, 'doc-a.txt'), 'a');
    await fs.writeFile(path.join(testDir, 'doc-b.txt'), 'bb');

    mockClassifierQueue = [];
    mockClassifyCalls = [];
    mockTrashItem.mockReset();
    mockTrashItem.mockResolvedValue(undefined);
    mockServices.orama = { deleteFileByPath: jest.fn().mockResolvedValue({ deleted: 0 }) };
    mockServices.undoRedo = { recordBatch: jest.fn().mockResolvedValue('action-1') };
    mockServices.analysisHistory = null;
    mockServices.folderMatching = null;

    jest.resetModules();
    const electron = require('electron');
    electron.app.getPath.mockReturnValue(testDir);

    jest.doMock('electron', () => ({
      app: { getPath: jest.fn().mockReturnValue(testDir) },
      shell: { trashItem: (...args) => mockTrashItem(...args) }
    }));
    jest.doMock('../src/main/services/ServiceContainer', () => ({
      container: {
        tryResolve: jest.fn((id) => {
          if (id === 'oramaVector') return mockServices.orama;
          if (id === 'undoRedo') return mockServices.undoRedo;
          if (id === 'analysisHistory') return mockServices.analysisHistory;
          if (id === 'folderMatching') return mockServices.folderMatching;
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
        PARALLEL_EMBEDDING: 'parallelEmbedding'
      }
    }));
    jest.doMock('../src/main/core/customFolders', () => ({
      loadCustomFolders: jest.fn().mockResolvedValue([])
    }));
    jest.doMock('../src/main/services/triage/FastTriageClassifier', () => {
      const actual = jest.requireActual('../src/main/services/triage/FastTriageClassifier');
      class MockClassifier {
        async classifyFile(entry, context) {
          mockClassifyCalls?.push({ entry, context });
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
      return { ...actual, FastTriageClassifier: MockClassifier };
    });

    const module = require('../src/main/services/triage/DownloadsTriageService');
    service = new module.DownloadsTriageService({
      ttlMs: 50,
      maxConcurrent: 2
    });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('start() returns a session with bucketed results', async () => {
    mockClassifierQueue = [
      { bucket: 'trash', signal: 'hash-collision', confidence: 1, why: 'duplicate' },
      { bucket: 'keep', signal: 'lexical-match', confidence: 0.8, why: 'matches Invoices' }
    ];
    const result = await service.start({ folderPath: testDir, minAgeHours: 0 });
    expect(result.success).toBe(true);
    expect(result.triageId).toMatch(/^triage-/);
    expect(result.total).toBe(2);
    expect(result.buckets.trash).toHaveLength(1);
    expect(result.buckets.keep).toHaveLength(1);
  });

  test('start() returns structured error for missing folder', async () => {
    const result = await service.start({
      folderPath: path.join(testDir, 'does-not-exist')
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('ENOENT');
  });

  test('concurrency cap evicts the oldest session', async () => {
    mockClassifierQueue = [];
    const s1 = await service.start({ folderPath: testDir, minAgeHours: 0 });
    mockClassifierQueue = [];
    const s2 = await service.start({ folderPath: testDir, minAgeHours: 0 });
    mockClassifierQueue = [];
    const s3 = await service.start({ folderPath: testDir, minAgeHours: 0 });

    expect(service._getSession(s1.triageId)).toBeNull(); // evicted
    expect(service._getSession(s2.triageId)).not.toBeNull();
    expect(service._getSession(s3.triageId)).not.toBeNull();
  });

  test('TTL expires sessions', async () => {
    mockClassifierQueue = [];
    const s1 = await service.start({ folderPath: testDir, minAgeHours: 0 });
    await new Promise((r) => setTimeout(r, 75)); // exceed ttlMs=50
    mockClassifierQueue = [];
    await service.start({ folderPath: testDir, minAgeHours: 0 }); // triggers eviction
    expect(service._getSession(s1.triageId)).toBeNull();
  });

  test('act(trash) routes through TrashService + batched Undo + Orama cleanup', async () => {
    mockClassifierQueue = [
      { bucket: 'trash', signal: 'hash-collision', confidence: 1, why: 'duplicate a' },
      { bucket: 'trash', signal: 'hash-collision', confidence: 1, why: 'duplicate b' }
    ];
    const started = await service.start({ folderPath: testDir, minAgeHours: 0 });
    const trashTargets = started.buckets.trash.map((r) => ({
      path: r.filePath,
      size: r.size
    }));

    const result = await service.act({
      triageId: started.triageId,
      action: 'trash',
      files: trashTargets,
      summary: { label: 'test' }
    });

    expect(result.success).toBe(true);
    expect(result.trashed).toHaveLength(2);
    expect(mockTrashItem).toHaveBeenCalledTimes(2);

    expect(mockServices.undoRedo.recordBatch).toHaveBeenCalledTimes(1);
    const [actionType, ops] = mockServices.undoRedo.recordBatch.mock.calls[0];
    expect(actionType).toBe('TRASH_BATCH');
    expect(ops).toHaveLength(2);
    for (const op of ops) {
      expect(op.type).toBe('trash');
      expect(op.originalPath).toBeDefined();
    }

    // Orama cleanup per trashed file.
    expect(mockServices.orama.deleteFileByPath).toHaveBeenCalledTimes(2);

    // Session state should have the trashed items removed from the buckets.
    const session = service._getSession(started.triageId);
    expect(session.buckets.trash).toHaveLength(0);
  });

  test('act(ignore) removes files from session without OS side effects', async () => {
    mockClassifierQueue = [
      { bucket: 'ambiguous', signal: 'no-match', confidence: 0, why: 'uncertain' },
      { bucket: 'ambiguous', signal: 'no-match', confidence: 0, why: 'uncertain' }
    ];
    const started = await service.start({ folderPath: testDir, minAgeHours: 0 });
    const files = started.buckets.ambiguous.map((r) => ({ path: r.filePath }));

    const result = await service.act({
      triageId: started.triageId,
      action: 'ignore',
      files
    });

    expect(result.success).toBe(true);
    expect(result.ignored).toBe(2);
    expect(mockTrashItem).not.toHaveBeenCalled();

    const session = service._getSession(started.triageId);
    expect(session.buckets.ambiguous).toHaveLength(0);
  });

  test('act with unknown action returns structured error', async () => {
    const result = await service.act({
      triageId: 'missing',
      action: 'shred',
      files: [{ path: '/tmp/x' }]
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('UNKNOWN_ACTION');
  });

  test('deepScan gracefully reports missing embedding service', async () => {
    mockClassifierQueue = [
      { bucket: 'ambiguous', signal: 'no-match', confidence: 0, why: 'uncertain' }
    ];
    const started = await service.start({ folderPath: testDir, minAgeHours: 0 });
    mockServices.folderMatching = null;
    const result = await service.deepScan({ triageId: started.triageId });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('EMBED_UNAVAILABLE');
  });

  test('deepScan tolerates embedding-service introspection returning null/throwing', async () => {
    // Cat 5 fix introspects folderMatching._getEmbeddingService() to cap submission
    // parallelism at the embedding queue's concurrency limit. The fallback must be
    // safe when introspection is unavailable (returns null) or throws — falling
    // back to CPU concurrency without crashing the deep scan. This locks that in.
    mockClassifierQueue = [
      { bucket: 'ambiguous', signal: 'no-match', confidence: 0, why: 'uncertain' }
    ];
    const started = await service.start({ folderPath: testDir, minAgeHours: 0 });

    // folderMatching: real-shape methods, but introspection helper returns null
    // (or throws — we cycle through both via successive calls below).
    let introspectCallCount = 0;
    mockServices.folderMatching = {
      embedText: jest.fn().mockResolvedValue({ vector: new Array(384).fill(0.1) }),
      matchVectorToFolders: jest.fn().mockResolvedValue([]),
      _getEmbeddingService: () => {
        introspectCallCount += 1;
        if (introspectCallCount === 1) return null;
        throw new Error('introspection failure');
      }
    };

    const first = await service.deepScan({ triageId: started.triageId });
    expect(first.success).toBe(true);

    // Second call exercises the throw path through the same try/catch fallback.
    mockClassifierQueue = [
      { bucket: 'ambiguous', signal: 'no-match', confidence: 0, why: 'uncertain' }
    ];
    const startedAgain = await service.start({ folderPath: testDir, minAgeHours: 0 });
    const second = await service.deepScan({ triageId: startedAgain.triageId });
    expect(second.success).toBe(true);
  });

  test('Tier 0 is told which folder is being swept, so a relative folder rule reads beneath it', async () => {
    // `archived/**` names folders called archived INSIDE the swept folder.
    // The classifier can only read it that way when the sweep hands it the
    // folder; without that the rule is inert in the sweep.
    const result = await service.start({
      folderPath: testDir,
      minAgeHours: 0,
      exclusionGlobs: ['archived/**']
    });
    expect(result.success).toBe(true);
    expect(mockClassifyCalls.length).toBe(2);
    for (const { context } of mockClassifyCalls) {
      expect(context.folderPath).toBe(testDir);
      expect(context.exclusionGlobs).toContain('archived/**');
    }
  });

  test('a swept folder that itself sits under an `archived` folder is not excluded whole', async () => {
    // Run the real Tier 0 cascade for this one: the rule must not read the
    // root's own ancestors, only what lies beneath it.
    const actual = jest.requireActual('../src/main/services/triage/FastTriageClassifier');
    const real = new actual.FastTriageClassifier();
    service._buildClassifier = () => real;

    const root = path.join(testDir, 'archived', 'photos');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'holiday.txt'), 'x');
    // Older than the 24h floor, so the age signal does not pre-empt the rule.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await fs.utimes(path.join(root, 'holiday.txt'), twoDaysAgo, twoDaysAgo);

    const result = await service.start({
      folderPath: root,
      minAgeHours: 0,
      exclusionGlobs: ['archived/**']
    });
    expect(result.success).toBe(true);
    expect(result.total).toBe(1);
    expect(result.buckets.excluded).toEqual([]);
  });
});

describe('buildTriageScanIgnorePatterns', () => {
  const {
    buildTriageScanIgnorePatterns
  } = require('../src/main/services/triage/DownloadsTriageService');

  test('maps folder rules in either spelling onto the scanner ignore list', () => {
    const ignores = buildTriageScanIgnorePatterns([
      '*.iso',
      'Thumbs.db',
      'archived/**',
      '**/old-stuff/**',
      'a/b/nested/**',
      '**/*.psd' // wildcard segment: no directory to ignore, the classifier handles it
    ]);
    expect(ignores).toEqual(expect.arrayContaining(['*.iso', 'Thumbs.db', 'archived']));
    expect(ignores).toContain('old-stuff');
    expect(ignores).toContain('nested');
    expect(ignores).not.toContain('**');
    expect(ignores).not.toContain('*.psd');
  });
});
