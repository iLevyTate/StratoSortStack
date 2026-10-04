/**
 * @jest-environment node
 */

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

const {
  DownloadsTriageService
} = require('../../../../src/main/services/triage/DownloadsTriageService');

describe('DownloadsTriageService.act session handling', () => {
  test.each(['trash', 'organize', 'ignore'])(
    'returns NO_SESSION for unknown triageId (action=%s)',
    async (action) => {
      const svc = new DownloadsTriageService();
      const result = await svc.act({
        triageId: 'no-such-session',
        action,
        files: [
          {
            path: '/tmp/triage-missing/a.txt',
            size: 1,
            suggestedFolderPath: '/tmp/triage-missing/target'
          }
        ]
      });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('NO_SESSION');
    }
  );
});

describe('DownloadsTriageService.getReportRows (real service) [F-184]', () => {
  // Previously pinned only against a mocked service — the expiry-on-export
  // semantics ("session expired", not a silent success) were untested on the
  // real implementation.
  test('returns null for unknown sessions and flattens live buckets', () => {
    const svc = new DownloadsTriageService();
    expect(svc.getReportRows('nope')).toBeNull();

    svc._sessions.set('t1', {
      createdAt: Date.now(),
      buckets: {
        keep: [
          {
            fileName: 'a.pdf',
            filePath: '/dl/a.pdf',
            bucket: 'keep',
            confidence: 0.9,
            signal: 's',
            why: 'w',
            size: 10,
            mtimeMs: 1700000000000
          }
        ],
        trash: [],
        excluded: [],
        ambiguous: [],
        review: [],
        unmatched: []
      }
    });

    const rows = svc.getReportRows('t1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fileName: 'a.pdf', bucket: 'keep', sizeBytes: 10 });
  });

  test('an expired session yields null (export says "expired", never silently succeeds)', () => {
    const svc = new DownloadsTriageService({ ttlMs: 1 });
    svc._sessions.set('t-old', {
      createdAt: Date.now() - 10,
      buckets: { keep: [], trash: [], excluded: [], ambiguous: [], review: [], unmatched: [] }
    });
    expect(svc.getReportRows('t-old')).toBeNull();
    // Eviction is real, not just a filtered view.
    expect(svc._sessions.has('t-old')).toBe(false);
  });
});
