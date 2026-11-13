/**
 * @jest-environment node
 */
/**
 * Per-op failure handling in the batch organize handler, driven through a
 * small stateful in-memory filesystem whose rename REPLACES an occupied
 * destination (real fs.rename semantics) and fails ENOENT when the
 * destination's parent directory is missing. Covers:
 *  - one file's permission error (EPERM/EACCES) is a per-file failure, not a
 *    batch-wide rollback; repeated permission errors still roll back
 *  - one file that fails the check after its move is a per-file failure too;
 *    a run of them still rolls back
 *  - a destination folder removed mid-batch is recreated, and is never
 *    reported as a missing source
 *  - a cross-device move that loses the publish race walks to the next
 *    suffix instead of failing
 *  - a rolled-back batch reports restored files as not organized, and
 *    broadcasts the files whose restore failed (they stayed moved)
 *  - a run that failures stopped has one row per file, and the files it did
 *    not reach are marked not attempted
 */

const path = require('path');

const mockState = {
  /** @type {Map<string, string>} */
  files: new Map(),
  /** @type {Set<string>} */
  dirs: new Set(),
  /** @type {((src: string, dest: string) => any) | null} */
  renameHook: null,
  /** Runs once the rename has been applied. @type {((src: string, dest: string) => void) | null} */
  afterRenameHook: null,
  /** @type {((src: string, dest: string) => void) | null} */
  copyHook: null,
  /** @type {Array<[string, string]>} */
  renames: [],
  /** @type {string[]} */
  mkdirs: []
};
const mockNorm = (p) => require('path').resolve(String(p));
const mockErr = (code, msg) => Object.assign(new Error(`${code}: ${msg}`), { code });

jest.mock('fs', () => {
  const p = require('path');
  const addDirs = (dir) => {
    let d = dir;
    while (d && !mockState.dirs.has(d)) {
      mockState.dirs.add(d);
      const parent = p.dirname(d);
      if (parent === d) break;
      d = parent;
    }
  };
  const promises = {
    access: jest.fn(async (fp) => {
      const n = mockNorm(fp);
      if (mockState.files.has(n) || mockState.dirs.has(n)) return undefined;
      throw mockErr('ENOENT', n);
    }),
    stat: jest.fn(async (fp) => {
      const n = mockNorm(fp);
      if (!mockState.files.has(n)) throw mockErr('ENOENT', n);
      return {
        size: mockState.files.get(n).length,
        mtimeMs: 1000,
        isFile: () => true,
        isDirectory: () => false
      };
    }),
    mkdir: jest.fn(async (dir) => {
      const n = mockNorm(dir);
      mockState.mkdirs.push(n);
      addDirs(n);
      return undefined;
    }),
    rename: jest.fn(async (src, dest) => {
      const s = mockNorm(src);
      const d = mockNorm(dest);
      mockState.renames.push([s, d]);
      if (mockState.renameHook) await mockState.renameHook(s, d);
      if (!mockState.files.has(s)) throw mockErr('ENOENT', s);
      if (!mockState.dirs.has(p.dirname(d))) throw mockErr('ENOENT', d);
      // Real rename semantics: an occupied destination is REPLACED.
      mockState.files.set(d, mockState.files.get(s));
      mockState.files.delete(s);
      if (mockState.afterRenameHook) mockState.afterRenameHook(s, d);
    }),
    copyFile: jest.fn(async (src, dest, mode) => {
      const s = mockNorm(src);
      const d = mockNorm(dest);
      if (!mockState.files.has(s)) throw mockErr('ENOENT', s);
      if (mode && mockState.files.has(d)) throw mockErr('EEXIST', d);
      mockState.files.set(d, mockState.files.get(s));
      if (mockState.copyHook) mockState.copyHook(s, d);
    }),
    unlink: jest.fn(async (fp) => {
      const n = mockNorm(fp);
      if (!mockState.files.has(n)) throw mockErr('ENOENT', n);
      mockState.files.delete(n);
    }),
    writeFile: jest.fn(async (fp, data) => {
      mockState.files.set(mockNorm(fp), String(data));
    })
  };
  return { promises, constants: { COPYFILE_EXCL: 1 } };
});

jest.mock('../src/main/ipc/files/batchLockManager', () => ({
  acquireBatchLock: jest.fn().mockResolvedValue(true),
  renewBatchLock: jest.fn().mockReturnValue(true),
  releaseBatchLock: jest.fn()
}));

jest.mock('../src/main/services/ServiceContainer', () => ({
  container: { has: jest.fn(() => false), resolve: jest.fn(), tryResolve: jest.fn(() => null) },
  ServiceIds: { FILE_PATH_COORDINATOR: 'filePathCoordinator', LEARNING_FEEDBACK: 'lf' }
}));

jest.mock('../src/main/services/FolderMatchingService', () => ({
  matchCategoryToFolder: jest.fn(() => null)
}));

jest.mock('../src/main/ipc/files/batchValidator', () => ({
  validateBatchOperation: jest.fn(() => null),
  MAX_BATCH_SIZE: 1000
}));

jest.mock('../src/main/ipc/files/batchProgressReporter', () => ({
  sendFileOperationBatchComplete: jest.fn(),
  sendOperationProgress: jest.fn(),
  sendChunkedResults: jest.fn().mockResolvedValue({ sent: true })
}));

jest.mock('../src/shared/fileOperationTracker', () => ({
  getInstance: jest.fn(() => ({ recordOperation: jest.fn() }))
}));

jest.mock('../src/main/ipc/files/embeddingSync', () => ({
  syncEmbeddingForMove: jest.fn(),
  removeEmbeddingsForPathBestEffort: jest.fn()
}));

jest.mock('../src/main/utils/fileDedup', () => ({
  computeFileChecksum: jest.fn().mockResolvedValue('checksum'),
  handleDuplicateMove: jest.fn().mockResolvedValue(null),
  findSemanticDuplicates: jest.fn().mockResolvedValue({ hasDuplicates: false, matches: [] })
}));

jest.mock('../src/shared/pathSanitization', () => ({
  validateFileOperationPath: jest.fn(async (p) => ({
    valid: true,
    normalizedPath: require('path').resolve(p)
  })),
  normalizePathForIndex: jest.fn((p) => String(p).replace(/\\/g, '/'))
}));

jest.mock('../src/main/ipc/files/destinationPolicy', () => ({
  authorizeDestinations: jest.fn().mockResolvedValue(new Map()),
  authorizeDestination: jest.fn().mockResolvedValue({ allowed: true }),
  decisionForDestination: jest.fn(() => ({ allowed: true })),
  buildStrictFileOpsAllowlist: jest.fn(() => ({ enabled: false, allowlist: [] }))
}));

jest.mock('../src/main/ipc/semantic', () => ({
  getSearchServiceInstance: jest.fn(() => null)
}));

// Lock-retry backoff is real time otherwise (10 attempts, ~2.25 s per file).
jest.mock('../src/shared/promiseUtils', () => ({
  ...jest.requireActual('../src/shared/promiseUtils'),
  delay: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../src/main/ipc/files/batchRollback', () => {
  const actual = jest.requireActual('../src/main/ipc/files/batchRollback');
  return { executeRollback: jest.fn(actual.executeRollback) };
});

const {
  handleBatchOrganize,
  performFileMove
} = require('../src/main/ipc/files/batchOrganizeHandler');
const { executeRollback } = require('../src/main/ipc/files/batchRollback');
const { sendFileOperationBatchComplete } = require('../src/main/ipc/files/batchProgressReporter');

const R = (p) => path.resolve(p);
const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function seedFile(p, content) {
  const n = R(p);
  mockState.files.set(n, content);
  let d = path.dirname(n);
  while (!mockState.dirs.has(d)) {
    mockState.dirs.add(d);
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
}

function makeOps(count, destDir = '/dest') {
  const ops = [];
  for (let k = 1; k <= count; k++) {
    seedFile(`/src/doc${k}.pdf`, `DOC-${k}`);
    ops.push({ source: `/src/doc${k}.pdf`, destination: `${destDir}/doc${k}.pdf`, type: 'move' });
  }
  return ops;
}

function makeProcessingState() {
  return {
    createOrLoadOrganizeBatch: jest.fn((id, ops) => ({ operations: ops })),
    markOrganizeOpStarted: jest.fn(),
    markOrganizeOpDone: jest.fn(),
    markOrganizeOpError: jest.fn(),
    markOrganizeBatchRolledBack: jest.fn(),
    completeOrganizeBatch: jest.fn()
  };
}

async function run(operations, extra = {}) {
  const processingState = makeProcessingState();
  const recordAction = jest.fn().mockResolvedValue(undefined);
  const result = await handleBatchOrganize({
    operation: { operations, ...extra },
    logger: silentLog,
    getServiceIntegration: () => ({
      processingState,
      undoRedo: { recordAction, hasBatchAction: jest.fn().mockResolvedValue(false) }
    }),
    getMainWindow: () => null
  });
  return { result, recordAction };
}

const resultFor = (result, k) => result.results.find((r) => r.source === R(`/src/doc${k}.pdf`));

beforeEach(() => {
  mockState.files.clear();
  mockState.dirs.clear();
  mockState.renameHook = null;
  mockState.afterRenameHook = null;
  mockState.copyHook = null;
  mockState.renames = [];
  mockState.mkdirs = [];
  jest.clearAllMocks();
});

describe('one file with a permission error', () => {
  test.each(['EPERM', 'EACCES'])(
    'a persistent %s on one source fails only that file; the rest of the batch stands',
    async (code) => {
      const ops = makeOps(5);
      mockState.renameHook = (s) => {
        if (s === R('/src/doc3.pdf')) throw mockErr(code, 'operation not permitted, rename');
      };

      const { result } = await run(ops);

      expect(executeRollback).not.toHaveBeenCalled();
      expect(result.rolledBack).toBeUndefined();
      expect(result.successCount).toBe(4);
      expect(result.failCount).toBe(1);
      expect(resultFor(result, 3)).toMatchObject({
        success: false,
        errorCode: code,
        critical: false
      });
      for (const k of [1, 2, 4, 5]) {
        expect(mockState.files.get(R(`/dest/doc${k}.pdf`))).toBe(`DOC-${k}`);
      }
      expect(mockState.files.get(R('/src/doc3.pdf'))).toBe('DOC-3');
    }
  );

  test('permission errors on several files in a row still roll the batch back', async () => {
    const ops = makeOps(8);
    mockState.renameHook = (s) => {
      if (s !== R('/src/doc1.pdf') && s.startsWith(R('/src'))) {
        throw mockErr('EACCES', 'permission denied, rename');
      }
    };

    const { result } = await run(ops);

    expect(executeRollback).toHaveBeenCalledTimes(1);
    expect(result.rolledBack).toBe(true);
    // doc1 moved and was restored by the rollback.
    expect(mockState.files.get(R('/src/doc1.pdf'))).toBe('DOC-1');
    expect(mockState.files.has(R('/dest/doc1.pdf'))).toBe(false);
  });

  test('ENOSPC on one file still rolls the batch back', async () => {
    const ops = makeOps(3);
    mockState.renameHook = (s) => {
      if (s === R('/src/doc3.pdf')) throw mockErr('ENOSPC', 'no space left on device');
    };
    // doc3 must fail after doc1/doc2 completed.
    const { result } = await run([ops[0], ops[1]].concat([ops[2]]));
    expect(result.rolledBack).toBe(true);
  });
});

describe('one file that fails the check after its move', () => {
  // Something else (a sync client, an antivirus quarantine) takes the file
  // right after it lands.
  const vanishAfterMove = (shouldVanish) => {
    mockState.afterRenameHook = (s, d) => {
      if (s.startsWith(R('/src')) && shouldVanish(s)) mockState.files.delete(d);
    };
  };

  test('a file missing from its destination fails alone; the rest stay moved and undoable', async () => {
    const ops = makeOps(5);
    vanishAfterMove((s) => s === R('/src/doc3.pdf'));

    const { result, recordAction } = await run(ops);

    expect(executeRollback).not.toHaveBeenCalled();
    expect(result.rolledBack).toBeUndefined();
    expect(result.successCount).toBe(4);
    expect(result.failCount).toBe(1);
    expect(resultFor(result, 3)).toMatchObject({
      success: false,
      errorCode: 'MOVE_VERIFICATION_DESTINATION_FAILED',
      critical: false
    });
    expect(resultFor(result, 3).error).toBe(
      `Move verification failed: destination does not exist after move: ${R('/dest/doc3.pdf')}. The file is no longer at its original location either.`
    );
    for (const k of [1, 2, 4, 5]) {
      expect(mockState.files.get(R(`/dest/doc${k}.pdf`))).toBe(`DOC-${k}`);
    }
    // Undo covers the four confirmed moves and not the one that failed.
    expect(recordAction).toHaveBeenCalledTimes(1);
    expect(recordAction.mock.calls[0][1].operations.map((o) => o.originalPath).sort()).toEqual(
      [1, 2, 4, 5].map((k) => R(`/src/doc${k}.pdf`))
    );
  });

  test('a file still at its source after the move fails alone and says so', async () => {
    const ops = makeOps(3);
    mockState.afterRenameHook = (s) => {
      if (s === R('/src/doc2.pdf')) mockState.files.set(s, 'DOC-2');
    };

    const { result } = await run(ops);

    expect(executeRollback).not.toHaveBeenCalled();
    expect(result.successCount).toBe(2);
    expect(resultFor(result, 2)).toMatchObject({
      success: false,
      errorCode: 'MOVE_VERIFICATION_SOURCE_EXISTS',
      critical: false
    });
    expect(resultFor(result, 2).error).toContain(R('/src/doc2.pdf'));
  });

  test('a destination that is missing while the source is back says the file is still there', async () => {
    const ops = makeOps(1);
    mockState.afterRenameHook = (s, d) => {
      mockState.files.set(s, mockState.files.get(d));
      mockState.files.delete(d);
    };

    const { result } = await run(ops);

    expect(resultFor(result, 1).error).toMatch(/The file is still at its original location\.$/);
    expect(result.successCount).toBe(0);
    expect(result.failCount).toBe(1);
  });

  test('files vanishing from the destination several times in a row still roll the batch back', async () => {
    const ops = makeOps(8);
    vanishAfterMove((s) => s !== R('/src/doc1.pdf'));

    const { result } = await run(ops);

    expect(executeRollback).toHaveBeenCalledTimes(1);
    expect(result.rolledBack).toBe(true);
    // doc1 was confirmed and is returned by the rollback.
    expect(mockState.files.get(R('/src/doc1.pdf'))).toBe('DOC-1');
    expect(mockState.files.has(R('/dest/doc1.pdf'))).toBe(false);
  });

  test('a confirmed move between two failed checks keeps them per-file', async () => {
    // A move whose source is another move's destination makes the batch run
    // one file at a time, so the order below is the order on disk.
    seedFile('/src/chain.pdf', 'CHAIN');
    const chain = [
      { source: '/src/chain.pdf', destination: '/stage/chain.pdf', type: 'move' },
      { source: '/stage/chain.pdf', destination: '/dest/chain.pdf', type: 'move' }
    ];
    // doc1, doc3 and doc5 fail; doc2, doc4 and doc6 are confirmed in between.
    vanishAfterMove((s) => /doc[135]\.pdf$/.test(s));

    const { result } = await run(chain.concat(makeOps(6)));

    expect(executeRollback).not.toHaveBeenCalled();
    expect(result.successCount).toBe(5);
    expect(result.failCount).toBe(3);
  });

  test('strict mode still rolls back on the first failed check', async () => {
    const ops = makeOps(3);
    vanishAfterMove((s) => s === R('/src/doc3.pdf'));

    const { result } = await run(ops, { strict: true });

    expect(result.rolledBack).toBe(true);
    expect(resultFor(result, 3)).toMatchObject({ critical: false, strictModeTriggered: true });
  });

  test('a destination that cannot be read for another reason keeps its own code', async () => {
    const fsPromises = require('fs').promises;
    const ops = makeOps(3);
    const realAccess = fsPromises.access.getMockImplementation();
    fsPromises.access.mockImplementation(async (fp) => {
      if (mockNorm(fp) === R('/dest/doc3.pdf')) throw mockErr('EIO', 'i/o error');
      return realAccess(fp);
    });

    try {
      const { result } = await run(ops);
      expect(result.rolledBack).toBe(true);
      expect(result.results.find((r) => r.errorCode === 'EIO')).toMatchObject({ critical: true });
    } finally {
      fsPromises.access.mockImplementation(realAccess);
    }
  });
});

describe('destination folder removed mid-batch', () => {
  test('later moves recreate the folder instead of reporting the source missing', async () => {
    const ops = makeOps(4, '/dest/D');
    let removed = false;
    mockState.renameHook = (s, d) => {
      // Once doc1 has landed, a sync client / the user deletes /dest/D.
      if (!removed && s === R('/src/doc2.pdf')) {
        removed = true;
        for (const f of [...mockState.files.keys()]) {
          if (f.startsWith(R('/dest/D'))) mockState.files.delete(f);
        }
        mockState.dirs.delete(R('/dest/D'));
      }
      return d;
    };

    const { result } = await run(ops.slice(0, 1));
    expect(result.successCount).toBe(1);

    const second = await run(ops.slice(1));
    for (const k of [2, 3, 4]) {
      const r = resultFor(second.result, k);
      expect(r.error || '').not.toMatch(/Source file not found/);
      expect(r.success).toBe(true);
      expect(mockState.files.get(R(`/dest/D/doc${k}.pdf`))).toBe(`DOC-${k}`);
    }
  });

  test('one batch: an emptied destination folder removed after the mkdir is recreated for every op', async () => {
    const ops = makeOps(5, '/dest/D');
    let removed = false;
    mockState.renameHook = (s, d) => {
      // The (still empty) folder disappears right before the first rename
      // into it, after the batch's cached mkdir already ran.
      if (!removed && path.dirname(d) === R('/dest/D')) {
        removed = true;
        mockState.dirs.delete(R('/dest/D'));
      }
    };

    const { result } = await run(ops);

    const notFound = result.results.filter((r) => /Source file not found/.test(r.error || ''));
    expect(notFound).toEqual([]);
    expect(result.successCount).toBe(5);
    for (const k of [1, 2, 3, 4, 5]) {
      expect(resultFor(result, k).success).toBe(true);
      expect(mockState.files.get(R(`/dest/D/doc${k}.pdf`))).toBe(`DOC-${k}`);
    }
  });

  test('a source that is genuinely missing is still reported as missing', async () => {
    const ops = makeOps(2);
    mockState.files.delete(R('/src/doc2.pdf'));

    const { result } = await run(ops);

    expect(resultFor(result, 2)).toMatchObject({ success: false, skipped: true });
    expect(resultFor(result, 2).error).toMatch(/Source file not found/);
    expect(resultFor(result, 1).success).toBe(true);
  });
});

describe('cross-device move losing the publish race', () => {
  test('walks to the next suffix when another file lands on the name during the copy', async () => {
    seedFile('/vol1/src/report.pdf', 'MINE');
    mockState.dirs.add(R('/vol2/dst'));
    mockState.dirs.add(R('/vol2'));
    // Every source->dest rename crosses volumes.
    mockState.renameHook = (s) => {
      if (s.startsWith(R('/vol1'))) throw mockErr('EXDEV', 'cross-device link not permitted');
    };
    let planted = false;
    mockState.copyHook = (s, d) => {
      if (!planted && d.startsWith(R('/vol2/dst/report.pdf'))) {
        planted = true;
        mockState.files.set(R('/vol2/dst/report.pdf'), 'SOMEONE-ELSE');
      }
    };

    const res = await performFileMove(
      { source: R('/vol1/src/report.pdf'), destination: R('/vol2/dst/report.pdf') },
      silentLog
    );

    expect(res.destination).toBe(R('/vol2/dst/report_1.pdf'));
    expect(mockState.files.get(R('/vol2/dst/report_1.pdf'))).toBe('MINE');
    expect(mockState.files.get(R('/vol2/dst/report.pdf'))).toBe('SOMEONE-ELSE');
    expect(mockState.files.has(R('/vol1/src/report.pdf'))).toBe(false);
  });
});

describe('rolled-back batch results', () => {
  test.each([
    ['after the other moves were reported', 30],
    ['while the other moves were still verifying', 0]
  ])(
    'critical failure %s: restored files are not organized; a file whose restore failed is reported, broadcast and undoable',
    async (_label, failDelayMs) => {
      const ops = makeOps(3);
      mockState.renameHook = async (s) => {
        if (s === R('/src/doc3.pdf')) {
          if (failDelayMs) await new Promise((resolve) => setTimeout(resolve, failDelayMs));
          throw mockErr('ENOSPC', 'no space left on device');
        }
        // Rollback of doc2 (dest -> src) fails: the file stays at its destination.
        if (s === R('/dest/doc2.pdf')) throw mockErr('EINVAL', 'cannot restore');
      };

      const { result, recordAction } = await run(ops);

      expect(result.rolledBack).toBe(true);
      // doc1 is back at its source: it must not read as organized.
      expect(mockState.files.get(R('/src/doc1.pdf'))).toBe('DOC-1');
      expect(resultFor(result, 1)).toMatchObject({ success: false, rolledBack: true });
      // doc2 could not be restored and really is at its destination.
      expect(mockState.files.get(R('/dest/doc2.pdf'))).toBe('DOC-2');
      expect(resultFor(result, 2)).toMatchObject({
        success: true,
        rollbackFailed: true,
        destination: R('/dest/doc2.pdf')
      });
      expect(result.results.filter((r) => r.success).map((r) => r.source)).toEqual([
        R('/src/doc2.pdf')
      ]);
      expect(sendFileOperationBatchComplete).toHaveBeenCalledWith(expect.any(Function), {
        operation: 'move',
        files: [R('/src/doc2.pdf')],
        destinations: [R('/dest/doc2.pdf')]
      });
      // The file that stayed moved gets an undo entry so the user can put it back.
      expect(recordAction).toHaveBeenCalledTimes(1);
      expect(recordAction.mock.calls[0][1].operations).toEqual([
        { type: 'move', originalPath: R('/src/doc2.pdf'), newPath: R('/dest/doc2.pdf') }
      ]);
    }
  );

  test('a fully restored batch broadcasts nothing and records no undo', async () => {
    const ops = makeOps(3);
    mockState.renameHook = (s) => {
      if (s === R('/src/doc3.pdf')) throw mockErr('ENOSPC', 'no space left on device');
    };

    const { result, recordAction } = await run(ops);

    expect(result.rolledBack).toBe(true);
    expect(result.results.filter((r) => r.success)).toEqual([]);
    expect(sendFileOperationBatchComplete).not.toHaveBeenCalled();
    expect(recordAction).not.toHaveBeenCalled();
  });
});

describe('a run stopped by failures', () => {
  // A move whose source is another move's destination makes the batch run one
  // file at a time. The pair goes last, so nothing is confirmed before it.
  const chainLast = (ops) => {
    seedFile('/src/chain.pdf', 'CHAIN');
    return ops.concat([
      { source: '/src/chain.pdf', destination: '/stage/chain.pdf', type: 'move' },
      { source: '/stage/chain.pdf', destination: '/dest/chain.pdf', type: 'move' }
    ]);
  };
  const denyDocs = (denied) => {
    mockState.renameHook = (s) => {
      if (s.startsWith(R('/src/doc')) && denied(s)) {
        throw mockErr('EACCES', 'permission denied, rename');
      }
    };
  };
  // A file the run never reached keeps the path the caller sent.
  const flagged = (result, flag) => result.results.filter((r) => r[flag]).map((r) => R(r.source));
  const rowFor = (result, k) => result.results.find((r) => R(r.source) === R(`/src/doc${k}.pdf`));

  test('with nothing moved yet: every file has a row, and the untried ones say so', async () => {
    const ops = chainLast(makeOps(6));
    denyDocs(() => true);

    const { result, recordAction } = await run(ops);

    expect(executeRollback).not.toHaveBeenCalled();
    expect(result.rolledBack).toBeUndefined();
    expect(result.success).toBe(false);
    expect(result.stoppedOnFailure).toBe(true);
    expect(result.stopReason).toMatch(/^Critical error on file 3\/8: /);
    expect(result.results).toHaveLength(8);
    expect(result.failCount).toBe(3);
    expect(result.notAttemptedCount).toBe(5);
    expect(result.summary).toBe('Processed 8 files: 0 successful, 3 failed, 5 not attempted');
    for (const k of [1, 2, 3]) {
      expect(resultFor(result, k)).toMatchObject({ success: false, errorCode: 'EACCES' });
      expect(resultFor(result, k).notAttempted).toBeUndefined();
    }
    expect(flagged(result, 'notAttempted')).toEqual([
      R('/src/doc4.pdf'),
      R('/src/doc5.pdf'),
      R('/src/doc6.pdf'),
      R('/src/chain.pdf'),
      R('/stage/chain.pdf')
    ]);
    for (const row of result.results.filter((r) => r.notAttempted)) {
      expect(row).toMatchObject({ success: false, operation: 'move' });
      expect(row.error).toBeUndefined();
    }
    // The journal batch is closed, so nothing resumes these files.
    expect(flagged(result, 'interrupted')).toEqual([]);
    expect(flagged(result, 'cancelled')).toEqual([]);
    expect(result.interrupted).toBeUndefined();
    expect(result.cancelled).toBe(false);
    // Nothing moved, so nothing is undoable.
    expect(recordAction).not.toHaveBeenCalled();
    for (const k of [1, 2, 3, 4, 5, 6]) {
      expect(mockState.files.get(R(`/src/doc${k}.pdf`))).toBe(`DOC-${k}`);
    }
    expect(mockState.files.get(R('/src/chain.pdf'))).toBe('CHAIN');
  });

  test('several files at a time: each file still has exactly one row', async () => {
    const ops = makeOps(8);
    denyDocs(() => true);

    const { result } = await run(ops);

    expect(executeRollback).not.toHaveBeenCalled();
    expect(result.stoppedOnFailure).toBe(true);
    expect(result.results.map((r) => R(r.source)).sort()).toEqual(
      ops.map((op) => R(op.source)).sort()
    );
    expect(result.notAttemptedCount).toBe(flagged(result, 'notAttempted').length);
    expect(result.failCount + result.notAttemptedCount).toBe(8);
    expect(flagged(result, 'interrupted')).toEqual([]);
  });

  test('strict mode: the first failure stops the run and the rest are not attempted', async () => {
    const ops = chainLast(makeOps(3));
    denyDocs((s) => s === R('/src/doc1.pdf'));

    const { result } = await run(ops, { strict: true });

    expect(executeRollback).not.toHaveBeenCalled();
    expect(result.stoppedOnFailure).toBe(true);
    expect(result.stopReason).toMatch(/^Strict-mode failure on file 1\/5: /);
    expect(resultFor(result, 1)).toMatchObject({ success: false, strictModeTriggered: true });
    expect(result.failCount).toBe(1);
    expect(result.notAttemptedCount).toBe(4);
    // Only the denied file was tried (its rename is retried).
    expect([...new Set(mockState.renames.map(([s]) => s))]).toEqual([R('/src/doc1.pdf')]);
  });

  test('a run that was not stopped carries no stop fields', async () => {
    const ops = makeOps(5);
    denyDocs((s) => s === R('/src/doc3.pdf'));

    const { result } = await run(ops);

    expect(result.stoppedOnFailure).toBeUndefined();
    expect(result.stopReason).toBeUndefined();
    expect(result.notAttemptedCount).toBeUndefined();
    expect(result.summary).toBe('Processed 5 files: 4 successful, 1 failed');
    expect(flagged(result, 'notAttempted')).toEqual([]);
  });

  test('with a move to undo: the rolled-back result lists the untried files too', async () => {
    const ops = chainLast(makeOps(8));
    denyDocs((s) => s !== R('/src/doc1.pdf'));

    const { result } = await run(ops);

    expect(executeRollback).toHaveBeenCalledTimes(1);
    expect(result.rolledBack).toBe(true);
    expect(result.stoppedOnFailure).toBeUndefined();
    expect(result.results).toHaveLength(10);
    expect(resultFor(result, 1)).toMatchObject({ success: false, rolledBack: true });
    expect(result.notAttemptedCount).toBe(6);
    expect(flagged(result, 'notAttempted')).toEqual([
      R('/src/doc5.pdf'),
      R('/src/doc6.pdf'),
      R('/src/doc7.pdf'),
      R('/src/doc8.pdf'),
      R('/src/chain.pdf'),
      R('/stage/chain.pdf')
    ]);
    expect(flagged(result, 'interrupted')).toEqual([]);
    expect(mockState.files.get(R('/src/doc1.pdf'))).toBe('DOC-1');
  });

  test('a file an earlier run already moved keeps its row when the resumed run is stopped', async () => {
    const ops = chainLast(makeOps(5));
    // doc5 was moved before the run was paused; resume skips it.
    mockState.files.delete(R('/src/doc5.pdf'));
    seedFile('/dest/doc5.pdf', 'DOC-5');
    ops[4].status = 'done';
    denyDocs(() => true);

    const { result } = await run(ops);

    expect(result.stoppedOnFailure).toBe(true);
    expect(result.results).toHaveLength(7);
    expect(rowFor(result, 5)).toMatchObject({ success: true, resumed: true });
    expect(rowFor(result, 4)).toMatchObject({ success: false, notAttempted: true });
    expect(result.summary).toBe('Processed 7 files: 1 successful, 3 failed, 3 not attempted');
  });
});

describe('rolled-back batch with a duplicate op', () => {
  test('every row for a restored file reads not organized, including the duplicate-skip row', async () => {
    const ops = makeOps(3);
    // The same move twice: the second copy hits the idempotency skip and
    // pushes its own success row for the same source.
    const withDuplicate = [ops[0], { ...ops[0] }, ops[1], ops[2]];
    mockState.renameHook = (s) => {
      if (s === R('/src/doc3.pdf')) throw mockErr('ENOSPC', 'no space left on device');
    };

    const { result, recordAction } = await run(withDuplicate);

    expect(result.rolledBack).toBe(true);
    expect(mockState.files.get(R('/src/doc1.pdf'))).toBe('DOC-1');
    const doc1Rows = result.results.filter((r) => r.source === R('/src/doc1.pdf'));
    expect(doc1Rows.length).toBeGreaterThanOrEqual(2);
    for (const row of doc1Rows) {
      expect(row).toMatchObject({ success: false, rolledBack: true });
    }
    expect(result.results.filter((r) => r.success)).toEqual([]);
    expect(recordAction).not.toHaveBeenCalled();
  });
});
