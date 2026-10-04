jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => 'C:\\fake-user-data')
  }
}));

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock('../src/shared/errorClassifier', () => ({
  isNotFoundError: jest.fn()
}));

jest.mock('../src/shared/performanceConstants', () => {
  // Keep every real constant (crossPlatformUtils reads TIMEOUTS at load);
  // only shrink the backoff step so retry tests stay fast.
  const actual = jest.requireActual('../src/shared/performanceConstants');
  return {
    ...actual,
    RETRY: { ...actual.RETRY, ATOMIC_BACKOFF_STEP_MS: 5 }
  };
});

const fs = require('fs').promises;
const { isNotFoundError } = require('../src/shared/errorClassifier');
const ProcessingStateService = require('../src/main/services/ProcessingStateService');

jest.spyOn(fs, 'readFile').mockResolvedValue(
  JSON.stringify({
    schemaVersion: '1.0.0',
    analysis: { jobs: {}, ready: {}, lastUpdated: '' },
    organize: { batches: {}, lastUpdated: '' }
  })
);
jest.spyOn(fs, 'writeFile').mockResolvedValue();
jest.spyOn(fs, 'rename').mockResolvedValue();
jest.spyOn(fs, 'mkdir').mockResolvedValue();
jest.spyOn(fs, 'unlink').mockResolvedValue();

// _performAtomicWrite opens the temp file (and, best-effort, the parent
// directory) via fs.open so it can fsync before/after the rename. Hand back
// fake handles and record them so tests can assert the fsync ordering.
const openedHandles = [];
jest.spyOn(fs, 'open').mockImplementation(async () => {
  const handle = {
    writeFile: jest.fn().mockResolvedValue(),
    sync: jest.fn().mockResolvedValue(),
    close: jest.fn().mockResolvedValue()
  };
  openedHandles.push(handle);
  return handle;
});

describe('ProcessingStateService', () => {
  let service;

  beforeEach(() => {
    isNotFoundError.mockReset();
    openedHandles.length = 0;
    service = new ProcessingStateService();
    service._startSweepInterval = jest.fn();
  });

  afterEach(async () => {
    if (service) {
      await service.destroy();
    }
  });

  test('constructor initializes defaults', () => {
    expect(service.state).toBeNull();
    expect(service.initialized).toBe(false);
    expect(service.SCHEMA_VERSION).toBe('1.0.0');
  });

  test('createEmptyState returns base structure', () => {
    const state = service.createEmptyState();
    expect(state.schemaVersion).toBe('1.0.0');
    expect(state.analysis.jobs).toEqual({});
    expect(state.analysis.ready).toEqual({});
    expect(state.organize.batches).toEqual({});
  });

  test('initialize loads existing state', async () => {
    await service.initialize();
    expect(service.initialized).toBe(true);
    expect(service.state.schemaVersion).toBe('1.0.0');
  });

  test('initialize creates empty state when file missing', async () => {
    fs.readFile.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    isNotFoundError.mockReturnValue(true);

    await service.initialize();

    expect(service.state.analysis.jobs).toEqual({});
    expect(service.initialized).toBe(true);
  });

  test('loadState recovers from corrupted JSON by resetting state', async () => {
    fs.readFile.mockResolvedValueOnce('{ invalid json');
    isNotFoundError.mockReturnValue(false);
    const saveSpy = jest.spyOn(service, '_saveStateInternal').mockResolvedValue();

    await service.loadState();

    expect(service.state).toBeTruthy();
    expect(service.state.analysis.jobs).toEqual({});
    expect(saveSpy).toHaveBeenCalled();
  });

  test('loadState recovers when persisted state has invalid shape', async () => {
    fs.readFile.mockResolvedValueOnce(JSON.stringify(['bad-shape']));
    isNotFoundError.mockReturnValue(false);
    const saveSpy = jest.spyOn(service, '_saveStateInternal').mockResolvedValue();

    await service.loadState();

    expect(service.state).toBeTruthy();
    expect(service.state.organize.batches).toEqual({});
    expect(saveSpy).toHaveBeenCalled();
  });

  test('_sanitizeReadyAnalysis persists llmSuggestedName for ready-queue hydration', () => {
    const sanitized = service._sanitizeReadyAnalysis({
      suggestedName: 'timeline-1-2026-06-01.mp4',
      llmSuggestedName: 'Timeline 1',
      category: 'video',
      keywords: ['demo']
    });

    expect(sanitized.llmSuggestedName).toBe('Timeline 1');
    expect(sanitized.suggestedName).toBe('timeline-1-2026-06-01.mp4');
  });

  test('saveState debounces multiple calls into one write', async () => {
    jest.useFakeTimers();
    service.state = service.createEmptyState();
    const writeSpy = jest.spyOn(service, '_performAtomicWrite').mockResolvedValue();

    const p1 = service.saveState();
    const p2 = service.saveState();
    jest.advanceTimersByTime(service._saveDebounceMs + 1);

    await Promise.all([p1, p2]);
    expect(writeSpy).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  });

  test('saveState flushes within one window of the FIRST call while calls keep arriving', async () => {
    jest.useFakeTimers();
    service.state = service.createEmptyState();
    const writeSpy = jest.spyOn(service, '_performAtomicWrite').mockResolvedValue();

    const p1 = service.saveState();
    jest.advanceTimersByTime(service._saveDebounceMs - 1);
    // A trailing-edge reset would push the flush out by another full window
    // on every call; a steady stream of callers must not defer it.
    const p2 = service.saveState();
    await jest.advanceTimersByTimeAsync(2);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    await Promise.all([p1, p2]);

    jest.useRealTimers();
  });

  test('flushSaveState waits for a write that was already in flight', async () => {
    jest.useFakeTimers();
    service.state = service.createEmptyState();
    let releaseWrite;
    const writeSpy = jest.spyOn(service, '_performAtomicWrite').mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseWrite = resolve;
        })
    );

    const save = service.saveState();
    await jest.advanceTimersByTimeAsync(service._saveDebounceMs + 1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    // The debounced flush took its resolvers before writing, so nothing
    // looks pending while the journal is still being written.
    expect(service._saveDebounceResolvers).toHaveLength(0);

    let flushed = false;
    const flush = service.flushSaveState().then(() => {
      flushed = true;
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // Shutdown's flush must not return before that write lands.
    expect(flushed).toBe(false);

    releaseWrite();
    await flush;
    await save;
    expect(flushed).toBe(true);
    expect(writeSpy).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  });

  test('organize op marks coalesce into one write instead of serializing on the lock', async () => {
    jest.useFakeTimers();
    service.state = service.createEmptyState();
    const writeSpy = jest.spyOn(service, '_performAtomicWrite').mockResolvedValue();
    const created = service.createOrLoadOrganizeBatch('batch-1', [
      { source: '/a/1.txt', destination: '/b/1.txt' },
      { source: '/a/2.txt', destination: '/b/2.txt' }
    ]);
    await jest.advanceTimersByTimeAsync(service._saveDebounceMs + 1);
    await created;
    writeSpy.mockClear();

    let secondResolved = false;
    const p1 = service.markOrganizeOpStarted('batch-1', 0, { sourceSize: 1, sourceMtime: 1 });
    const p2 = service.markOrganizeOpStarted('batch-1', 1, { sourceSize: 2, sourceMtime: 2 });
    p2.then(() => {
      secondResolved = true;
    });
    await jest.advanceTimersByTimeAsync(service._saveDebounceMs + 1);

    // Both mutations landed in memory and both callers were released by the
    // same flush: the mutation lock must not be held across the debounced save.
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(secondResolved).toBe(true);
    await p1;
    const ops = service.state.organize.batches['batch-1'].operations;
    expect(ops[0].status).toBe('in_progress');
    expect(ops[1].status).toBe('in_progress');
    expect(ops[1].sourceMtime).toBe(2);

    jest.useRealTimers();
  });

  test('_performAtomicWrite retries rename on EPERM', async () => {
    const state = service.createEmptyState();
    const renameSpy = jest
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EPERM' }))
      .mockResolvedValueOnce();

    jest.useFakeTimers();
    const promise = service._performAtomicWrite(state);
    await jest.runAllTimersAsync();
    await promise;
    expect(renameSpy).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  test('_performAtomicWrite fsyncs the temp file before renaming over the journal', async () => {
    fs.rename.mockClear();
    await service._performAtomicWrite(service.createEmptyState());

    // First handle is the temp state file: written, fsynced, closed — and
    // the fsync must land before the rename commits the filename.
    const tempHandle = openedHandles[0];
    expect(tempHandle.writeFile).toHaveBeenCalled();
    expect(tempHandle.sync).toHaveBeenCalled();
    expect(tempHandle.close).toHaveBeenCalled();
    expect(tempHandle.sync.mock.invocationCallOrder[0]).toBeLessThan(
      fs.rename.mock.invocationCallOrder[0]
    );
  });

  test('markAnalysisStart updates state and persists', async () => {
    service.state = service.createEmptyState();
    service.initialized = true;
    const saveSpy = jest.spyOn(service, 'saveState').mockResolvedValue({ success: true });

    await service.markAnalysisStart('C:\\file.txt');

    // Jobs are keyed by the canonical (normalized) path so case/separator
    // variants of the same file hit the same entry.
    const key = service._pathKey('C:\\file.txt');
    expect(service.state.analysis.jobs[key].status).toBe('in_progress');
    expect(service.state.analysis.jobs[key].path).toBe('C:\\file.txt');
    expect(saveSpy).toHaveBeenCalled();
  });

  // Case-folding only applies on case-insensitive filesystems
  const caseInsensitiveTest =
    process.platform === 'win32' || process.platform === 'darwin' ? test : test.skip;
  caseInsensitiveTest('analysis job lookups are path-case and separator insensitive', async () => {
    service.state = service.createEmptyState();
    service.initialized = true;
    jest.spyOn(service, 'saveState').mockResolvedValue({ success: true });

    await service.markAnalysisStart('C:\\Docs\\File.TXT');
    await service.markAnalysisComplete('c:/docs/file.txt');

    expect(Object.keys(service.state.analysis.jobs)).toHaveLength(1);
    expect(service.getState('C:\\DOCS\\FILE.txt')).toBe('done');
  });

  test('markAnalysisComplete persists ready analysis snapshot', async () => {
    service.state = service.createEmptyState();
    service.initialized = true;
    const saveSpy = jest.spyOn(service, 'saveState').mockResolvedValue({ success: true });
    jest.spyOn(fs, 'stat').mockResolvedValueOnce({
      size: 2048,
      birthtime: new Date('2026-01-01T00:00:00.000Z'),
      mtime: new Date('2026-01-02T00:00:00.000Z')
    });

    await service.markAnalysisComplete('C:\\docs\\file.txt', {
      suggestedName: 'file.txt',
      category: 'documents',
      keywords: ['invoice']
    });

    const completeKey = service._pathKey('C:\\docs\\file.txt');
    expect(service.state.analysis.jobs[completeKey].status).toBe('done');
    expect(service.state.analysis.ready[completeKey]).toEqual(
      expect.objectContaining({
        path: 'C:\\docs\\file.txt',
        name: 'file.txt',
        analysis: expect.objectContaining({
          suggestedName: 'file.txt',
          category: 'documents',
          keywords: ['invoice']
        })
      })
    );
    expect(saveSpy).toHaveBeenCalled();
  });

  test('clearAllReadyAnalyses clears ready and jobs, persists', async () => {
    service.state = service.createEmptyState();
    service.initialized = true;
    service.state.analysis.ready['C:\\a.txt'] = { path: 'C:\\a.txt', name: 'a.txt', analysis: {} };
    service.state.analysis.ready['C:\\b.txt'] = { path: 'C:\\b.txt', name: 'b.txt', analysis: {} };
    service.state.analysis.jobs['C:\\c.txt'] = { status: 'in_progress' };
    const saveSpy = jest.spyOn(service, 'saveState').mockResolvedValue();

    const result = await service.clearAllReadyAnalyses();

    expect(result.cleared).toBe(3);
    expect(service.state.analysis.ready).toEqual({});
    expect(service.state.analysis.jobs).toEqual({});
    expect(saveSpy).toHaveBeenCalled();
  });

  test('clearAllReadyAnalyses returns cleared 0 when empty', async () => {
    service.state = service.createEmptyState();
    service.initialized = true;
    const saveSpy = jest.spyOn(service, 'saveState').mockResolvedValue();

    const result = await service.clearAllReadyAnalyses();

    expect(result.cleared).toBe(0);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  test('markOrganizeOpStarted persists the source size+mtime on the journal entry', async () => {
    await service.initialize();
    const batchId = 'metadata-batch';
    await service.createOrLoadOrganizeBatch(batchId, [
      { source: '/from/a', destination: '/to/a' },
      { source: '/from/b', destination: '/to/b' }
    ]);
    jest.spyOn(service, 'saveState').mockResolvedValue({ success: true });

    await service.markOrganizeOpStarted(batchId, 0, {
      sourceSize: 4096,
      sourceMtime: 1700000000000
    });
    await service.markOrganizeOpStarted(batchId, 1);

    const [withMetadata, withoutMetadata] = service.state.organize.batches[batchId].operations;
    expect(withMetadata).toMatchObject({
      status: 'in_progress',
      source: '/from/a',
      sourceSize: 4096,
      sourceMtime: 1700000000000
    });
    expect(withoutMetadata.status).toBe('in_progress');
    expect(withoutMetadata).not.toHaveProperty('sourceSize');
    expect(withoutMetadata).not.toHaveProperty('sourceMtime');
  });

  test('organize mutators serialize through the shared state mutation lock (F-046)', async () => {
    await service.initialize();
    const batchId = 'serialize-batch';
    await service.createOrLoadOrganizeBatch(batchId, [{ source: '/from/a', destination: '/to/a' }]);

    // Gate the first mutator INSIDE the lock (its initialize() await, which
    // precedes the mutation) so we can observe whether the second mutator's
    // body runs while the first is still in flight. The save itself happens
    // outside the lock now, so gating it would prove nothing about ordering.
    // Each save records the status it sees, exposing the read-modify-write
    // ordering.
    let releaseFirst;
    const firstMutationGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const realInitialize = service.initialize.bind(service);
    let gated = false;
    jest.spyOn(service, 'initialize').mockImplementation(async () => {
      await realInitialize();
      if (!gated) {
        gated = true;
        await firstMutationGate;
      }
    });
    const savedStatuses = [];
    jest.spyOn(service, 'saveState').mockImplementation(async () => {
      savedStatuses.push(service.state.organize.batches[batchId].operations[0].status);
      return { success: true };
    });

    // Fire both mutators WITHOUT awaiting the first — they must run in order.
    const started = service.markOrganizeOpStarted(batchId, 0);
    const done = service.markOrganizeOpDone(batchId, 0);

    // Flush microtasks/timers: neither mutation has run (the first is parked
    // inside the lock, the second is queued behind it).
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(savedStatuses).toEqual([]);
    expect(service.state.organize.batches[batchId].operations[0].status).toBe('pending');

    releaseFirst();
    await Promise.all([started, done]);

    expect(savedStatuses).toEqual(['in_progress', 'done']);
    expect(service.state.organize.batches[batchId].operations[0].status).toBe('done');
  });

  // Regression: a rolled-back batch must never resurface as "incomplete".
  // Pre-fix, resume at next launch replayed it — re-moving files the user
  // was told were rolled back and recording bogus undo entries.
  test('markOrganizeBatchRolledBack stamps the batch and hides it from getIncompleteOrganizeBatches', async () => {
    service.state = service.createEmptyState();
    service.initialized = true;
    jest.spyOn(service, 'saveState').mockResolvedValue({ success: true });

    await service.createOrLoadOrganizeBatch('rb-batch', [
      { source: '/from/a', destination: '/to/a' }
    ]);
    expect(service.getIncompleteOrganizeBatches().map((b) => b.id)).toEqual(['rb-batch']);

    await service.markOrganizeBatchRolledBack('rb-batch');

    expect(service.state.organize.batches['rb-batch'].rolledBackAt).toEqual(expect.any(String));
    // Even before completeOrganizeBatch lands (crash between the two
    // stamps), the batch must not surface for resume.
    expect(service.state.organize.batches['rb-batch'].completedAt).toBeNull();
    expect(service.getIncompleteOrganizeBatches()).toEqual([]);
  });

  test('getIncompleteOrganizeBatches skips rolledBackAt journals written mid-rollback by older builds', () => {
    service.state = service.createEmptyState();
    service.state.organize.batches = {
      open: { id: 'open', operations: [], completedAt: null },
      rolledBack: {
        id: 'rolledBack',
        operations: [],
        completedAt: null,
        rolledBackAt: new Date().toISOString()
      },
      completed: { id: 'completed', operations: [], completedAt: new Date().toISOString() }
    };

    expect(service.getIncompleteOrganizeBatches().map((b) => b.id)).toEqual(['open']);
  });

  describe('per-op persistence journaling', () => {
    beforeEach(() => {
      service.state = service.createEmptyState();
      service.initialized = true;
      jest.spyOn(service, 'saveState').mockResolvedValue({ success: true });
    });

    test('markOrganizeOpsPersisted accumulates a sorted, de-duplicated index set', async () => {
      await service.createOrLoadOrganizeBatch('b', [
        { source: '/from/a', destination: '/to/a' },
        { source: '/from/b', destination: '/to/b' },
        { source: '/from/c', destination: '/to/c' }
      ]);

      await service.markOrganizeOpsPersisted('b', [2, 0]);
      await service.markOrganizeOpsPersisted('b', [1, 2, -1, 1.5, 'x']);

      const batch = service.state.organize.batches.b;
      expect(batch.persistedOpIndices).toEqual([0, 1, 2]);
      expect(batch.persistedAt).toEqual(expect.any(String));
    });

    test('markOrganizeOpsPersisted does not write when nothing new is covered', async () => {
      await service.createOrLoadOrganizeBatch('b', [{ source: '/from/a', destination: '/to/a' }]);
      await service.markOrganizeOpsPersisted('b', [0]);
      const writesAfterFirstStamp = service.saveState.mock.calls.length;

      await service.markOrganizeOpsPersisted('b', [0]);
      await service.markOrganizeOpsPersisted('b', []);

      expect(service.saveState).toHaveBeenCalledTimes(writesAfterFirstStamp);
    });

    test('loadState migrates a legacy batch-wide persistedAt stamp to the done op indices', async () => {
      const legacyState = {
        schemaVersion: '1.0.0',
        analysis: { jobs: {}, ready: {}, lastUpdated: '' },
        organize: {
          lastUpdated: '',
          batches: {
            legacy: {
              id: 'legacy',
              persistedAt: '2026-01-01T00:00:00.000Z',
              completedAt: null,
              operations: [
                { source: '/a', destination: '/b', status: 'done' },
                { source: '/c', destination: '/d', status: 'pending' },
                { source: '/e', destination: '/f', status: 'done' }
              ]
            },
            modern: {
              id: 'modern',
              persistedAt: '2026-01-01T00:00:00.000Z',
              persistedOpIndices: [1],
              completedAt: null,
              operations: [
                { source: '/a', destination: '/b', status: 'done' },
                { source: '/c', destination: '/d', status: 'done' }
              ]
            }
          }
        }
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(legacyState));
      const write = jest.spyOn(service, '_saveStateInternal').mockResolvedValue(undefined);
      service.initialized = false;
      service.state = null;

      await service.loadState();

      expect(service.state.organize.batches.legacy.persistedOpIndices).toEqual([0, 2]);
      expect(service.state.organize.batches.modern.persistedOpIndices).toEqual([1]);
      expect(write).toHaveBeenCalled();
    });
  });
});
