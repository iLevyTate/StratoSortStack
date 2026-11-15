/**
 * @jest-environment node
 */
/**
 * Startup resume replays journaled organize ops without anyone asking, so it
 * must hold every move to the live handler's rules: a folder the user
 * declined (or that would need confirming) is refused rather than prompted
 * for, ops the live run refused stay refused, and the strict allowlist
 * applies. It must also leave alone a batch a live run owns: one started in
 * this session, or one closed while resume waited for the batch lock.
 */

const path = require('path');
const fs = require('fs').promises;
const fssync = require('fs');
const os = require('os');
const { dialog } = require('electron');
const { resumeIncompleteBatches } = require('../src/main/services/OrganizeResumeService');
const { acquireBatchLock, releaseBatchLock } = require('../src/main/ipc/files/batchLockManager');
const { _resetDestinationPolicyForTests } = require('../src/main/ipc/files/destinationPolicy');

describe('OrganizeResumeService replay policy', () => {
  let testDir;
  let inbox;
  let sorted;
  let elsewhere;
  let processingState;
  let logger;
  const getMainWindow = () => null;
  const savedStrict = process.env.STRATOSORT_STRICT_FILE_OPS;

  /** @param {any[]} batches */
  function makeProcessingState(batches) {
    return {
      getIncompleteOrganizeBatches: jest.fn().mockReturnValue(batches),
      markOrganizeOpStarted: jest.fn().mockResolvedValue(undefined),
      markOrganizeOpDone: jest.fn().mockResolvedValue(undefined),
      markOrganizeOpError: jest.fn().mockResolvedValue(undefined),
      markOrganizeOpsPersisted: jest.fn().mockResolvedValue(undefined),
      completeOrganizeBatch: jest.fn().mockResolvedValue(undefined)
    };
  }

  function smartFolderWatcher() {
    return { getSmartFolders: () => [{ path: sorted }], watchedPaths: [sorted] };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    _resetDestinationPolicyForTests();
    delete process.env.STRATOSORT_STRICT_FILE_OPS;
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-policy-'));
    inbox = path.join(testDir, 'inbox');
    sorted = path.join(testDir, 'sorted');
    elsewhere = path.join(testDir, 'elsewhere');
    await Promise.all([inbox, sorted, elsewhere].map((d) => fs.mkdir(d, { recursive: true })));
    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  });

  afterEach(async () => {
    if (savedStrict === undefined) delete process.env.STRATOSORT_STRICT_FILE_OPS;
    else process.env.STRATOSORT_STRICT_FILE_OPS = savedStrict;
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  test('refuses, without a dialog, a pending move into a folder that is not trusted', async () => {
    const source = path.join(inbox, 'a.txt');
    const destination = path.join(elsewhere, 'a.txt');
    await fs.writeFile(source, 'A');
    processingState = makeProcessingState([
      { id: 'batch1', operations: [{ source, destination, status: 'pending' }] }
    ]);

    await resumeIncompleteBatches(
      { processingState, smartFolderWatcher: smartFolderWatcher() },
      logger,
      getMainWindow
    );

    expect(fssync.existsSync(source)).toBe(true);
    expect(fssync.existsSync(destination)).toBe(false);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(processingState.markOrganizeOpStarted).not.toHaveBeenCalled();
    expect(processingState.markOrganizeOpError).toHaveBeenCalledWith(
      'batch1',
      0,
      expect.stringMatching(/^Invalid destination path: /)
    );
    expect(processingState.markOrganizeOpDone).not.toHaveBeenCalled();
    expect(processingState.completeOrganizeBatch).toHaveBeenCalledWith('batch1');
  });

  test('still replays a pending move into a Smart Folder', async () => {
    const source = path.join(inbox, 'a.txt');
    const destination = path.join(sorted, 'a.txt');
    await fs.writeFile(source, 'A');
    processingState = makeProcessingState([
      { id: 'batch1', operations: [{ source, destination, status: 'pending' }] }
    ]);

    await resumeIncompleteBatches(
      { processingState, smartFolderWatcher: smartFolderWatcher() },
      logger,
      getMainWindow
    );

    expect(await fs.readFile(destination, 'utf8')).toBe('A');
    expect(processingState.markOrganizeOpError).not.toHaveBeenCalled();
    expect(processingState.markOrganizeOpDone).toHaveBeenCalledWith('batch1', 0, { destination });
  });

  test('leaves an op the live run refused failed, even if its folder is allowed now', async () => {
    const source = path.join(inbox, 'a.txt');
    const destination = path.join(sorted, 'a.txt');
    await fs.writeFile(source, 'A');
    processingState = makeProcessingState([
      {
        id: 'batch1',
        operations: [
          {
            source,
            destination,
            status: 'failed',
            error: `Invalid destination path: Destination folder was not approved: ${sorted}`
          }
        ]
      }
    ]);

    await resumeIncompleteBatches(
      { processingState, smartFolderWatcher: smartFolderWatcher() },
      logger,
      getMainWindow
    );

    expect(fssync.existsSync(source)).toBe(true);
    expect(fssync.existsSync(destination)).toBe(false);
    expect(processingState.markOrganizeOpStarted).not.toHaveBeenCalled();
    expect(processingState.markOrganizeOpDone).not.toHaveBeenCalled();
  });

  test('applies the strict allowlist to the source of a replayed move', async () => {
    process.env.STRATOSORT_STRICT_FILE_OPS = 'true';
    const source = path.join(inbox, 'a.txt');
    const destination = path.join(sorted, 'a.txt');
    await fs.writeFile(source, 'A');
    processingState = makeProcessingState([
      { id: 'batch1', operations: [{ source, destination, status: 'pending' }] }
    ]);

    await resumeIncompleteBatches(
      { processingState, smartFolderWatcher: smartFolderWatcher() },
      logger,
      getMainWindow
    );

    expect(fssync.existsSync(source)).toBe(true);
    expect(processingState.markOrganizeOpError).toHaveBeenCalledWith(
      'batch1',
      0,
      expect.stringMatching(/^Invalid source path: /)
    );
  });

  test('skips a batch this session started', async () => {
    const source = path.join(inbox, 'a.txt');
    const destination = path.join(sorted, 'a.txt');
    await fs.writeFile(source, 'A');
    processingState = makeProcessingState([
      { id: 'live', operations: [{ source, destination, status: 'pending' }], pausedAt: 'x' }
    ]);
    processingState.isSessionOrganizeBatch = jest.fn((id) => id === 'live');

    await resumeIncompleteBatches(
      { processingState, smartFolderWatcher: smartFolderWatcher() },
      logger,
      getMainWindow
    );

    expect(fssync.existsSync(source)).toBe(true);
    expect(processingState.markOrganizeOpStarted).not.toHaveBeenCalled();
    // A paused live batch must stay open so the renderer's Resume still works.
    expect(processingState.completeOrganizeBatch).not.toHaveBeenCalled();
  });

  test('does not replay a batch a live run closed while resume waited for the lock', async () => {
    const source = path.join(inbox, 'a.txt');
    const destination = path.join(sorted, 'a.txt');
    await fs.writeFile(source, 'A');
    const batch = {
      id: 'batch_1700000000000_0000abcd',
      completedAt: null,
      operations: [{ source, destination, status: 'pending' }]
    };
    processingState = makeProcessingState([batch]);

    // A live run holds the batch; the user cancels it, which closes the
    // journal entry with this op still pending.
    expect(await acquireBatchLock(batch.id)).toBe(true);
    const run = resumeIncompleteBatches(
      { processingState, smartFolderWatcher: smartFolderWatcher() },
      logger,
      getMainWindow
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    batch.completedAt = new Date().toISOString();
    releaseBatchLock(batch.id);
    await run;

    expect(fssync.existsSync(source)).toBe(true);
    expect(fssync.existsSync(destination)).toBe(false);
    expect(processingState.markOrganizeOpStarted).not.toHaveBeenCalled();
    expect(processingState.completeOrganizeBatch).not.toHaveBeenCalled();
    // The lock was handed back.
    await expect(acquireBatchLock('probe', 1000)).resolves.toBe(true);
    releaseBatchLock('probe');
  });
});
