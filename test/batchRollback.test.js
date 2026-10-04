jest.mock('electron', () => jest.requireActual('./mocks/electron'));

const mockFsPromises = {
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn(),
  copyFile: jest.fn().mockResolvedValue(undefined),
  rename: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined)
};

const mockCrossDeviceMove = jest.fn().mockResolvedValue(undefined);

jest.mock('fs', () => ({
  promises: mockFsPromises,
  constants: { COPYFILE_EXCL: 1 }
}));

jest.mock('../src/shared/atomicFileOperations', () => ({
  crossDeviceMove: mockCrossDeviceMove,
  // Delegate to the suite's fs.rename mock; tests drive occupied-source
  // behavior by seeding renameNoReplace rejections. Real no-replace
  // semantics are covered by atomicFileOperations.test.js.
  renameNoReplace: jest.fn((src, dest) => mockFsPromises.rename(src, dest))
}));

jest.mock('../src/main/ipc/files/batchLockManager', () => ({
  renewBatchLock: jest.fn().mockReturnValue(true)
}));

const { executeRollback } = require('../src/main/ipc/files/batchRollback');
const { renewBatchLock } = require('../src/main/ipc/files/batchLockManager');

describe('executeRollback', () => {
  let log;

  beforeEach(() => {
    jest.clearAllMocks();
    log = {
      warn: jest.fn(),
      info: jest.fn(),
      error: jest.fn()
    };
  });

  // Rollback usually starts AFTER the batch exhausted MAX_TOTAL_BATCH_TIME,
  // so without per-op renewal the lock's TTL would lapse mid-restore and a
  // second batch could interleave with the files being moved back.
  test('renews the batch lock after every rollback op, including failed ones', async () => {
    mockFsPromises.rename
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EBUSY' }));

    await executeRollback(
      [
        { source: '/src/a.txt', destination: '/dst/a.txt' },
        { source: '/src/b.txt', destination: '/dst/b.txt' }
      ],
      [],
      0,
      'test',
      'batch-renew',
      log
    );

    expect(renewBatchLock).toHaveBeenCalledTimes(2);
    expect(renewBatchLock).toHaveBeenCalledWith('batch-renew');
  });

  test('creates recovery manifest and deletes it on full success', async () => {
    const completedOperations = [
      { source: '/src/a.txt', destination: '/dst/a.txt' },
      { source: '/src/b.txt', destination: '/dst/b.txt' }
    ];

    const result = await executeRollback(
      completedOperations,
      [{ success: true }, { success: true }],
      0,
      'test',
      'batch-1',
      log
    );

    expect(mockFsPromises.mkdir).toHaveBeenCalled();
    expect(mockFsPromises.writeFile).toHaveBeenCalled();

    const [tmpPath, manifestJson] = mockFsPromises.writeFile.mock.calls[0];
    expect(JSON.parse(manifestJson).status).toBe('pending');

    // writeFileAtomic writes to a tmp file then renames it to the manifest path,
    // plus 2 rollback renames = 3 total rename calls
    expect(mockFsPromises.rename).toHaveBeenCalledTimes(3);
    // The manifest path is the second arg of the first rename call (writeFileAtomic)
    const manifestPath = mockFsPromises.rename.mock.calls[0][1];
    expect(manifestPath).toContain('rollback_batch-1.json');
    expect(mockFsPromises.unlink).toHaveBeenCalledWith(manifestPath);
    expect(result.rolledBack).toBe(true);
    expect(result.rollbackFailCount).toBe(0);
  });

  test('uses cross-device move on EXDEV errors', async () => {
    const exdevError = new Error('EXDEV');
    exdevError.code = 'EXDEV';
    // First rename call is from writeFileAtomic (manifest creation) - let it succeed.
    // Second rename call is the actual rollback rename - make it throw EXDEV.
    mockFsPromises.rename
      .mockResolvedValueOnce(undefined) // writeFileAtomic: tmp -> manifest
      .mockRejectedValueOnce(exdevError); // rollback rename: dst -> src

    await executeRollback(
      [{ source: '/src/a.txt', destination: '/dst/a.txt' }],
      [],
      1,
      'test',
      'batch-2',
      log
    );

    expect(mockFsPromises.mkdir).toHaveBeenCalledWith('/src', { recursive: true });
    expect(mockCrossDeviceMove).toHaveBeenCalledWith('/dst/a.txt', '/src/a.txt', { verify: true });
  });

  test('updates recovery manifest on partial failure', async () => {
    // writeFileAtomic for initial manifest: writeFile(tmp) + rename(tmp -> manifest) succeed.
    // Then rollback renames: first rollback op fails (reversed order: b.txt first),
    // second rollback op succeeds.
    mockFsPromises.rename
      .mockResolvedValueOnce(undefined) // writeFileAtomic: tmp -> manifest
      .mockRejectedValueOnce(new Error('Rename failed')) // rollback of b.txt fails
      .mockResolvedValueOnce(undefined) // rollback of a.txt succeeds
      .mockResolvedValueOnce(undefined); // writeFileAtomic: tmp -> manifest (update)

    mockFsPromises.readFile.mockResolvedValueOnce(
      JSON.stringify({ status: 'pending', results: [] })
    );

    const result = await executeRollback(
      [
        { source: '/src/a.txt', destination: '/dst/a.txt' },
        { source: '/src/b.txt', destination: '/dst/b.txt' }
      ],
      [],
      2,
      'test',
      'batch-3',
      log
    );

    // The last writeFile call is for the updated manifest (via writeFileAtomic)
    const lastWriteCall =
      mockFsPromises.writeFile.mock.calls[mockFsPromises.writeFile.mock.calls.length - 1];
    const updatedManifest = JSON.parse(lastWriteCall[1]);

    expect(updatedManifest.status).toBe('partial_failure');
    expect(updatedManifest.results.length).toBeGreaterThan(0);
    expect(result.rollbackFailCount).toBeGreaterThan(0);
  });

  test('F-081: rollback refuses to overwrite a file that now occupies the original source path', async () => {
    // fs.rename silently replaces an occupied destination, so a blind
    // rollback rename could destroy a file the user (or another process)
    // placed at the original source path after the forward move. The
    // rollback must go through renameNoReplace and record the op as failed
    // (the moved file stays safe at its destination).
    const { renameNoReplace } = require('../src/shared/atomicFileOperations');
    const eexist = new Error("EEXIST: file already exists, rename '/dst/a.txt' -> '/src/a.txt'");
    eexist.code = 'EEXIST';
    renameNoReplace.mockRejectedValueOnce(eexist);

    const result = await executeRollback(
      [{ source: '/src/a.txt', destination: '/dst/a.txt' }],
      [],
      1,
      'test',
      'batch-occupied',
      log
    );

    expect(result.rollbackFailCount).toBe(1);
    expect(result.rollbackSuccessCount).toBe(0);
    expect(result.rollbackResults[0]).toMatchObject({
      success: false,
      file: '/src/a.txt'
    });
    expect(result.rollbackResults[0].error).toContain('EEXIST');
    // The occupant-destroying bare rename must never run for the rollback op
    // (fs.rename is still used for the manifest tmp-file swap only).
    expect(mockFsPromises.rename).not.toHaveBeenCalledWith('/dst/a.txt', '/src/a.txt');
  });

  // Regression: a rolled-back batch must be CLOSED in the processing-state
  // journal (rolledBackAt + completedAt). Pre-fix, the batch stayed
  // "incomplete" and OrganizeResumeService auto-replayed it at next launch —
  // re-moving files the user was told were rolled back.
  test('closes the journal batch after a fully successful rollback', async () => {
    const processingState = {
      markOrganizeBatchRolledBack: jest.fn().mockResolvedValue(),
      completeOrganizeBatch: jest.fn().mockResolvedValue()
    };

    const result = await executeRollback(
      [{ source: '/src/a.txt', destination: '/dst/a.txt' }],
      [],
      1,
      'test',
      'batch-close',
      log,
      processingState
    );

    expect(result.rolledBack).toBe(true);
    expect(processingState.markOrganizeBatchRolledBack).toHaveBeenCalledWith('batch-close');
    expect(processingState.completeOrganizeBatch).toHaveBeenCalledWith('batch-close');
    // rolledBackAt must land first: a crash between the two writes still
    // leaves the marker that getIncompleteOrganizeBatches skips.
    expect(processingState.markOrganizeBatchRolledBack.mock.invocationCallOrder[0]).toBeLessThan(
      processingState.completeOrganizeBatch.mock.invocationCallOrder[0]
    );
  });

  test('closes the journal batch even when rollback partially fails', async () => {
    const processingState = {
      markOrganizeBatchRolledBack: jest.fn().mockResolvedValue(),
      completeOrganizeBatch: jest.fn().mockResolvedValue()
    };
    const { renameNoReplace } = require('../src/shared/atomicFileOperations');
    renameNoReplace.mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EBUSY' }));

    const result = await executeRollback(
      [{ source: '/src/a.txt', destination: '/dst/a.txt' }],
      [],
      1,
      'test',
      'batch-close-partial',
      log,
      processingState
    );

    expect(result.rollbackFailCount).toBe(1);
    expect(processingState.markOrganizeBatchRolledBack).toHaveBeenCalledWith('batch-close-partial');
    expect(processingState.completeOrganizeBatch).toHaveBeenCalledWith('batch-close-partial');
  });

  test('journal-close failure does not fail the rollback result', async () => {
    const processingState = {
      markOrganizeBatchRolledBack: jest.fn().mockRejectedValue(new Error('disk gone')),
      completeOrganizeBatch: jest.fn().mockResolvedValue()
    };

    const result = await executeRollback(
      [{ source: '/src/a.txt', destination: '/dst/a.txt' }],
      [],
      1,
      'test',
      'batch-close-err',
      log,
      processingState
    );

    expect(result.rolledBack).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to close journal batch after rollback')
    );
  });

  test('F-081: duplicate-source restore copies exclusively (never clobbers an occupant)', async () => {
    await executeRollback(
      [
        {
          source: '/src/dup.txt',
          destination: '/dst/kept.txt',
          rollbackAction: 'restore_duplicate_source'
        }
      ],
      [],
      1,
      'test',
      'batch-dup-occupied',
      log
    );

    // COPYFILE_EXCL (mocked as 1) makes the restore fail instead of
    // replacing whatever now occupies the original source path.
    expect(mockFsPromises.copyFile).toHaveBeenCalledWith('/dst/kept.txt', '/src/dup.txt', 1);
  });
});
