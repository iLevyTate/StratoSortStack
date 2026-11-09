/**
 * Resume after a crash that landed between a collision-suffixed rename and
 * the (debounced) done mark: the journal still holds the PLANNED destination,
 * which is occupied by the pre-existing file that caused the collision, while
 * the moved file sits under the live handler's `_N` (or UUID-fallback) name.
 * Resume must recognise the moved file by the journaled size+mtime and mark
 * the op done at that path, so it still gets its undo entry and path update.
 */

const path = require('path');
const fs = require('fs').promises;
const os = require('os');

const { resumeIncompleteBatches } = require('../src/main/services/OrganizeResumeService');

describe('OrganizeResumeService: crash after a collision-suffixed move', () => {
  let testDir;
  let processingState;
  const logger = { warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  const getMainWindow = () => null;

  beforeEach(async () => {
    jest.clearAllMocks();
    testDir = path.join(os.tmpdir(), `resume-collision-${Date.now()}`);
    await fs.mkdir(path.join(testDir, 'sorted'), { recursive: true });
    processingState = {
      getIncompleteOrganizeBatches: jest.fn().mockReturnValue([]),
      markOrganizeOpStarted: jest.fn().mockResolvedValue(),
      markOrganizeOpDone: jest.fn().mockResolvedValue(),
      markOrganizeOpError: jest.fn().mockResolvedValue(),
      completeOrganizeBatch: jest.fn().mockResolvedValue()
    };
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  /**
   * Journal one in_progress op whose source is gone; `movedTo` holds the
   * moved bytes (recorded size+mtime), `planned` optionally holds an
   * unrelated occupant.
   */
  async function journalCrashedOp({ movedTo, plannedOccupant = 'a different, longer occupant' }) {
    const source = path.join(testDir, 'inbox', 'a.txt');
    const planned = path.join(testDir, 'sorted', 'a.txt');
    if (plannedOccupant !== null) await fs.writeFile(planned, plannedOccupant);
    if (movedTo) await fs.writeFile(movedTo, 'moved');
    const movedStat = movedTo ? await fs.stat(movedTo) : { size: 5, mtimeMs: Date.now() };
    processingState.getIncompleteOrganizeBatches.mockReturnValue([
      {
        id: 'batch1',
        operations: [
          {
            source,
            destination: planned,
            status: 'in_progress',
            sourceSize: movedStat.size,
            sourceMtime: movedStat.mtimeMs
          }
        ]
      }
    ]);
    return { source, planned };
  }

  test('adopts the `_1` sibling that matches the recorded file', async () => {
    const moved = path.join(testDir, 'sorted', 'a_1.txt');
    const { planned } = await journalCrashedOp({ movedTo: moved });

    await resumeIncompleteBatches({ processingState }, logger, getMainWindow);

    expect(processingState.markOrganizeOpError).not.toHaveBeenCalled();
    expect(processingState.markOrganizeOpDone).toHaveBeenCalledWith('batch1', 0, {
      destination: moved
    });
    // Nothing on disk was touched.
    expect(await fs.readFile(planned, 'utf8')).toBe('a different, longer occupant');
    expect(await fs.readFile(moved, 'utf8')).toBe('moved');
  });

  test('adopts a UUID-fallback sibling that matches the recorded file', async () => {
    const moved = path.join(testDir, 'sorted', 'a_1f2e3d4c.txt');
    await journalCrashedOp({ movedTo: moved });

    await resumeIncompleteBatches({ processingState }, logger, getMainWindow);

    expect(processingState.markOrganizeOpError).not.toHaveBeenCalled();
    expect(processingState.markOrganizeOpDone).toHaveBeenCalledWith('batch1', 0, {
      destination: moved
    });
  });

  test('adopts the sibling when the planned occupant is gone too', async () => {
    const moved = path.join(testDir, 'sorted', 'a_2.txt');
    await fs.writeFile(path.join(testDir, 'sorted', 'a_1.txt'), 'another unrelated file');
    await journalCrashedOp({ movedTo: moved, plannedOccupant: null });

    await resumeIncompleteBatches({ processingState }, logger, getMainWindow);

    expect(processingState.markOrganizeOpError).not.toHaveBeenCalled();
    expect(processingState.markOrganizeOpDone).toHaveBeenCalledWith('batch1', 0, {
      destination: moved
    });
  });

  test('still fails the op when no sibling matches the recorded file', async () => {
    await fs.writeFile(path.join(testDir, 'sorted', 'a_1.txt'), 'not the moved file at all');
    await journalCrashedOp({ movedTo: null });

    await resumeIncompleteBatches({ processingState }, logger, getMainWindow);

    expect(processingState.markOrganizeOpDone).not.toHaveBeenCalled();
    expect(processingState.markOrganizeOpError).toHaveBeenCalledWith(
      'batch1',
      0,
      expect.stringMatching(/does not match/)
    );
  });

  test('does not adopt a name outside the suffix pattern', async () => {
    const lookalike = path.join(testDir, 'sorted', 'a copy.txt');
    await journalCrashedOp({ movedTo: lookalike });

    await resumeIncompleteBatches({ processingState }, logger, getMainWindow);

    expect(processingState.markOrganizeOpDone).not.toHaveBeenCalled();
    expect(processingState.markOrganizeOpError).toHaveBeenCalled();
  });

  test('two matching siblings are ambiguous: neither is adopted and the op fails', async () => {
    // The user's own identical copy (a_1) sorts before the name the crashed
    // batch really used (a_2); both carry the recorded size+mtime.
    const userCopy = path.join(testDir, 'sorted', 'a_1.txt');
    const moved = path.join(testDir, 'sorted', 'a_2.txt');
    await fs.writeFile(userCopy, 'moved');
    await journalCrashedOp({ movedTo: moved });
    const movedStat = await fs.stat(moved);
    await fs.utimes(userCopy, movedStat.atime, movedStat.mtime);

    await resumeIncompleteBatches({ processingState }, logger, getMainWindow);

    expect(processingState.markOrganizeOpDone).not.toHaveBeenCalled();
    expect(processingState.markOrganizeOpError).toHaveBeenCalledWith(
      'batch1',
      0,
      expect.stringMatching(/does not match/)
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/ambiguous/i),
      expect.objectContaining({ batchId: 'batch1', index: 0, matches: 2 })
    );
    expect(await fs.readFile(userCopy, 'utf8')).toBe('moved');
    expect(await fs.readFile(moved, 'utf8')).toBe('moved');
  });

  test('a sibling another op of the batch already claimed is not adopted twice', async () => {
    const claimed = path.join(testDir, 'sorted', 'a_1.txt');
    const moved = path.join(testDir, 'sorted', 'a_2.txt');
    await fs.writeFile(claimed, 'moved');
    await journalCrashedOp({ movedTo: moved });
    const movedStat = await fs.stat(moved);
    await fs.utimes(claimed, movedStat.atime, movedStat.mtime);
    const [batch] = processingState.getIncompleteOrganizeBatches();
    batch.operations.unshift({
      source: path.join(testDir, 'inbox', 'other.txt'),
      destination: claimed,
      status: 'done'
    });

    await resumeIncompleteBatches({ processingState }, logger, getMainWindow);

    expect(processingState.markOrganizeOpError).not.toHaveBeenCalled();
    expect(processingState.markOrganizeOpDone).toHaveBeenCalledWith('batch1', 1, {
      destination: moved
    });
  });
});
