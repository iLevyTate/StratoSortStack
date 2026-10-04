/**
 * Tests for OrganizeResumeService
 * Tests resuming incomplete organize batches
 */

const path = require('path');
const fs = require('fs').promises;
const os = require('os');

describe('OrganizeResumeService', () => {
  let resumeIncompleteBatches;
  let testDir;
  let mockServiceIntegration;
  let mockLogger;
  let mockGetMainWindow;

  beforeEach(async () => {
    // jest.resetModules(); // Removed - breaks module imports

    // Create temp directory for tests
    testDir = path.join(os.tmpdir(), `resume-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    const module = require('../src/main/services/OrganizeResumeService');
    resumeIncompleteBatches = module.resumeIncompleteBatches;

    // Setup mocks
    mockLogger = {
      warn: jest.fn(),
      info: jest.fn()
    };

    mockServiceIntegration = {
      processingState: {
        getIncompleteOrganizeBatches: jest.fn().mockReturnValue([]),
        markOrganizeOpStarted: jest.fn().mockResolvedValue(),
        markOrganizeOpDone: jest.fn().mockResolvedValue(),
        markOrganizeOpError: jest.fn().mockResolvedValue(),
        completeOrganizeBatch: jest.fn().mockResolvedValue()
      }
    };

    mockGetMainWindow = jest.fn().mockReturnValue({
      isDestroyed: () => false,
      webContents: {
        send: jest.fn()
      }
    });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('resumeIncompleteBatches', () => {
    test('returns early when no incomplete batches', async () => {
      await resumeIncompleteBatches(mockServiceIntegration, mockLogger, mockGetMainWindow);

      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('logs warning when incomplete batches exist', async () => {
      mockServiceIntegration.processingState.getIncompleteOrganizeBatches.mockReturnValue([
        { id: 'batch1', operations: [] }
      ]);

      await resumeIncompleteBatches(mockServiceIntegration, mockLogger, mockGetMainWindow);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Resuming 1 incomplete')
      );
    });

    test('skips already done operations', async () => {
      mockServiceIntegration.processingState.getIncompleteOrganizeBatches.mockReturnValue([
        {
          id: 'batch1',
          operations: [{ source: '/a', destination: '/b', status: 'done' }]
        }
      ]);

      await resumeIncompleteBatches(mockServiceIntegration, mockLogger, mockGetMainWindow);

      expect(mockServiceIntegration.processingState.markOrganizeOpStarted).not.toHaveBeenCalled();
    });

    test('processes pending operations', async () => {
      const source = path.join(testDir, 'source.txt');
      const dest = path.join(testDir, 'dest.txt');
      await fs.writeFile(source, 'content');

      mockServiceIntegration.processingState.getIncompleteOrganizeBatches.mockReturnValue([
        {
          id: 'batch1',
          operations: [{ source, destination: dest, status: 'pending' }]
        }
      ]);

      await resumeIncompleteBatches(mockServiceIntegration, mockLogger, mockGetMainWindow);

      expect(mockServiceIntegration.processingState.markOrganizeOpStarted).toHaveBeenCalled();
      expect(mockServiceIntegration.processingState.markOrganizeOpDone).toHaveBeenCalled();
    });

    // UX-4 pause: a batch the USER paused must be finalized at startup
    // (persistence + completeOrganizeBatch) WITHOUT replaying its pending
    // ops — files silently moving at launch would be surprising. The user
    // explicitly stopped this work; restart discards the remainder.
    test('paused batch is finalized without replaying pending operations', async () => {
      const doneSource = path.join(testDir, 'done-source.txt');
      const doneDest = path.join(testDir, 'done-dest.txt');
      const pendingSource = path.join(testDir, 'pending-source.txt');
      const pendingDest = path.join(testDir, 'pending-dest.txt');
      await fs.writeFile(doneDest, 'already moved');
      await fs.writeFile(pendingSource, 'must not move');

      mockServiceIntegration.processingState.getIncompleteOrganizeBatches.mockReturnValue([
        {
          id: 'paused-batch',
          pausedAt: new Date().toISOString(),
          operations: [
            { source: doneSource, destination: doneDest, status: 'done' },
            { source: pendingSource, destination: pendingDest, status: 'pending' }
          ]
        }
      ]);

      await resumeIncompleteBatches(mockServiceIntegration, mockLogger, mockGetMainWindow);

      // Pending op was NOT replayed: source still in place, dest never created
      await expect(fs.access(pendingSource)).resolves.toBeUndefined();
      await expect(fs.access(pendingDest)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(mockServiceIntegration.processingState.markOrganizeOpStarted).not.toHaveBeenCalled();

      // But the batch is finalized so it never resurfaces as incomplete
      expect(mockServiceIntegration.processingState.completeOrganizeBatch).toHaveBeenCalledWith(
        'paused-batch'
      );
    });

    // Regression: rollback moved the completed ops' files BACK, so a batch
    // stamped rolledBackAt (older-build journal, or crash between the
    // rolledBackAt and completedAt stamps) must be closed WITHOUT replaying
    // pending ops or re-running post-batch persistence — either would act on
    // moves the user was told were rolled back.
    test('rolled-back batch is closed without replaying ops or running persistence', async () => {
      const doneSource = path.join(testDir, 'rb-done-source.txt');
      const doneDest = path.join(testDir, 'rb-done-dest.txt');
      const pendingSource = path.join(testDir, 'rb-pending-source.txt');
      const pendingDest = path.join(testDir, 'rb-pending-dest.txt');
      // Rollback restored the files to their sources.
      await fs.writeFile(doneSource, 'restored by rollback');
      await fs.writeFile(pendingSource, 'must not move');

      mockServiceIntegration.processingState.markOrganizeOpsPersisted = jest
        .fn()
        .mockResolvedValue();
      mockServiceIntegration.processingState.getIncompleteOrganizeBatches.mockReturnValue([
        {
          id: 'rolled-back-batch',
          rolledBackAt: new Date().toISOString(),
          operations: [
            { source: doneSource, destination: doneDest, status: 'done' },
            { source: pendingSource, destination: pendingDest, status: 'pending' }
          ]
        }
      ]);

      await resumeIncompleteBatches(mockServiceIntegration, mockLogger, mockGetMainWindow);

      // No op was replayed: sources untouched, destinations never created
      await expect(fs.access(doneSource)).resolves.toBeUndefined();
      await expect(fs.access(pendingSource)).resolves.toBeUndefined();
      await expect(fs.access(pendingDest)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(mockServiceIntegration.processingState.markOrganizeOpStarted).not.toHaveBeenCalled();
      expect(mockServiceIntegration.processingState.markOrganizeOpDone).not.toHaveBeenCalled();

      // No post-batch persistence (would record undo entries for moves that
      // no longer exist on disk)
      expect(
        mockServiceIntegration.processingState.markOrganizeOpsPersisted
      ).not.toHaveBeenCalled();

      // But the journal entry is closed so it never resurfaces
      expect(mockServiceIntegration.processingState.completeOrganizeBatch).toHaveBeenCalledWith(
        'rolled-back-batch'
      );
    });

    test('handles name collision', async () => {
      const source = path.join(testDir, 'source.txt');
      const dest = path.join(testDir, 'dest.txt');
      await fs.writeFile(source, 'content');
      await fs.writeFile(dest, 'existing');

      mockServiceIntegration.processingState.getIncompleteOrganizeBatches.mockReturnValue([
        {
          id: 'batch1',
          operations: [{ source, destination: dest, status: 'pending' }]
        }
      ]);

      await resumeIncompleteBatches(mockServiceIntegration, mockLogger, mockGetMainWindow);

      // Should complete with a modified destination
      expect(mockServiceIntegration.processingState.markOrganizeOpDone).toHaveBeenCalled();
    });

    test('sends progress updates', async () => {
      const source = path.join(testDir, 'source.txt');
      const dest = path.join(testDir, 'dest.txt');
      await fs.writeFile(source, 'content');

      mockServiceIntegration.processingState.getIncompleteOrganizeBatches.mockReturnValue([
        {
          id: 'batch1',
          operations: [{ source, destination: dest, status: 'pending' }]
        }
      ]);

      await resumeIncompleteBatches(mockServiceIntegration, mockLogger, mockGetMainWindow);

      const window = mockGetMainWindow();
      expect(window.webContents.send).toHaveBeenCalledWith(
        'operation-progress',
        expect.objectContaining({
          type: 'batch_organize',
          current: 1,
          total: 1
        })
      );
    });

    test('handles operation error gracefully', async () => {
      const source = path.join(testDir, 'notexists.txt');
      const dest = path.join(testDir, 'dest.txt');

      mockServiceIntegration.processingState.getIncompleteOrganizeBatches.mockReturnValue([
        {
          id: 'batch1',
          operations: [{ source, destination: dest, status: 'pending' }]
        }
      ]);

      await resumeIncompleteBatches(mockServiceIntegration, mockLogger, mockGetMainWindow);

      expect(mockServiceIntegration.processingState.markOrganizeOpError).toHaveBeenCalled();
    });

    test('marks done after a crash between rename and markOrganizeOpDone using the metadata the live handler journals', async () => {
      // End-to-end through the real ProcessingStateService: the live handler
      // persists {sourceSize, sourceMtime} via markOrganizeOpStarted, the
      // rename lands, the process dies before markOrganizeOpDone. On the next
      // launch the journal is read back from disk and the destination occupant
      // must be recognised as the moved file — not marked as an error.
      const { app } = require('electron');
      app.getPath.mockReturnValue(testDir);
      const ProcessingStateService = require('../src/main/services/ProcessingStateService');

      const source = path.join(testDir, 'moved-before-crash.txt');
      const dest = path.join(testDir, 'sorted', 'moved-before-crash.txt');
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(source, 'content');
      const sourceStat = await fs.stat(source);
      const batchId = 'batch_1700000000000_deadbeef';

      const crashedSession = new ProcessingStateService();
      crashedSession._startSweepInterval = jest.fn();
      try {
        await crashedSession.initialize();
        await crashedSession.createOrLoadOrganizeBatch(batchId, [
          { source, destination: dest, type: 'move' }
        ]);
        await crashedSession.markOrganizeOpStarted(batchId, 0, {
          sourceSize: sourceStat.size,
          sourceMtime: sourceStat.mtimeMs
        });
        await fs.rename(source, dest);
        await crashedSession.flushSaveState();
      } finally {
        await crashedSession.destroy();
      }

      const nextLaunch = new ProcessingStateService();
      nextLaunch._startSweepInterval = jest.fn();
      try {
        await nextLaunch.initialize();
        const doneSpy = jest.spyOn(nextLaunch, 'markOrganizeOpDone');
        const errorSpy = jest.spyOn(nextLaunch, 'markOrganizeOpError');

        await resumeIncompleteBatches(
          { processingState: nextLaunch },
          mockLogger,
          mockGetMainWindow
        );

        expect(doneSpy).toHaveBeenCalledWith(
          batchId,
          0,
          expect.objectContaining({ destination: dest })
        );
        expect(errorSpy).not.toHaveBeenCalled();
        expect(mockLogger.warn).not.toHaveBeenCalledWith(
          expect.stringContaining('Legacy journal entry'),
          expect.anything()
        );
      } finally {
        await nextLaunch.destroy();
      }
    });

    test('legacy journal entry without source metadata falls back to marking the op done with a warning', async () => {
      const source = path.join(testDir, 'legacy-missing.txt');
      const dest = path.join(testDir, 'legacy-dest.txt');
      await fs.writeFile(dest, 'content');

      mockServiceIntegration.processingState.getIncompleteOrganizeBatches.mockReturnValue([
        {
          id: 'batch1',
          operations: [{ source, destination: dest, status: 'in_progress' }]
        }
      ]);

      await resumeIncompleteBatches(mockServiceIntegration, mockLogger, mockGetMainWindow);

      expect(mockServiceIntegration.processingState.markOrganizeOpDone).toHaveBeenCalledWith(
        'batch1',
        0,
        expect.objectContaining({ destination: dest })
      );
      expect(mockServiceIntegration.processingState.markOrganizeOpError).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Legacy journal entry lacks source metadata'),
        expect.objectContaining({ batchId: 'batch1', index: 0, destination: dest })
      );
    });

    test('does not treat source-missing as done when dest size mismatches', async () => {
      const source = path.join(testDir, 'missing-mismatch.txt');
      const dest = path.join(testDir, 'dest-mismatch.txt');
      await fs.writeFile(dest, 'other occupant');
      const destStat = await fs.stat(dest);

      mockServiceIntegration.processingState.getIncompleteOrganizeBatches.mockReturnValue([
        {
          id: 'batch1',
          operations: [
            {
              source,
              destination: dest,
              status: 'pending',
              sourceSize: destStat.size + 99,
              sourceMtime: destStat.mtimeMs
            }
          ]
        }
      ]);

      await resumeIncompleteBatches(mockServiceIntegration, mockLogger, mockGetMainWindow);

      expect(mockServiceIntegration.processingState.markOrganizeOpDone).not.toHaveBeenCalled();
      expect(mockServiceIntegration.processingState.markOrganizeOpError).toHaveBeenCalled();
    });

    test('completes batch after processing all operations', async () => {
      const source = path.join(testDir, 'source.txt');
      const dest = path.join(testDir, 'dest.txt');
      await fs.writeFile(source, 'content');

      mockServiceIntegration.processingState.getIncompleteOrganizeBatches.mockReturnValue([
        {
          id: 'batch1',
          operations: [{ source, destination: dest, status: 'pending' }]
        }
      ]);

      await resumeIncompleteBatches(mockServiceIntegration, mockLogger, mockGetMainWindow);

      expect(mockServiceIntegration.processingState.completeOrganizeBatch).toHaveBeenCalledWith(
        'batch1'
      );
    });

    test('rejects operations whose persisted source path points at a dangerous system directory', async () => {
      // Simulate a tampered/corrupt journal entry targeting a disallowed
      // system path. The resume pass must refuse to touch it and mark the op
      // as errored instead of feeding it into fs.rename.
      const dangerousSource =
        process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/etc/passwd';
      const dest = path.join(testDir, 'dest.txt');

      mockServiceIntegration.processingState.getIncompleteOrganizeBatches.mockReturnValue([
        {
          id: 'batch1',
          operations: [{ source: dangerousSource, destination: dest, status: 'pending' }]
        }
      ]);

      await resumeIncompleteBatches(mockServiceIntegration, mockLogger, mockGetMainWindow);

      expect(mockServiceIntegration.processingState.markOrganizeOpError).toHaveBeenCalledWith(
        'batch1',
        0,
        expect.stringContaining('Unsafe source path for resume')
      );
      expect(mockServiceIntegration.processingState.markOrganizeOpDone).not.toHaveBeenCalled();
    });

    test('rejects operations with non-absolute persisted destination paths', async () => {
      const source = path.join(testDir, 'source.txt');
      await fs.writeFile(source, 'content');

      mockServiceIntegration.processingState.getIncompleteOrganizeBatches.mockReturnValue([
        {
          id: 'batch1',
          operations: [{ source, destination: 'relative/dest.txt', status: 'pending' }]
        }
      ]);

      await resumeIncompleteBatches(mockServiceIntegration, mockLogger, mockGetMainWindow);

      expect(mockServiceIntegration.processingState.markOrganizeOpError).toHaveBeenCalledWith(
        'batch1',
        0,
        expect.stringContaining('Unsafe destination path for resume')
      );
    });

    test('warns (but touches nothing) when service integration is null', async () => {
      await resumeIncompleteBatches(null, mockLogger, mockGetMainWindow);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('processingState unavailable')
      );
      expect(mockLogger.info).not.toHaveBeenCalled();
      // getMainWindow should not have been consulted — there is nothing to send.
      expect(mockGetMainWindow).not.toHaveBeenCalled();
    });

    test('warns (but touches nothing) when processingState is absent', async () => {
      await resumeIncompleteBatches({}, mockLogger, mockGetMainWindow);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('processingState unavailable')
      );
      expect(mockLogger.info).not.toHaveBeenCalled();
      expect(mockGetMainWindow).not.toHaveBeenCalled();
    });

    test('no-ops when getIncompleteOrganizeBatches is not a function', async () => {
      const badState = { processingState: { getIncompleteOrganizeBatches: null } };
      await resumeIncompleteBatches(badState, mockLogger, mockGetMainWindow);

      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockGetMainWindow).not.toHaveBeenCalled();
    });

    test('still completes operations when window is destroyed (but suppresses progress send)', async () => {
      const source = path.join(testDir, 'source.txt');
      const dest = path.join(testDir, 'dest.txt');
      await fs.writeFile(source, 'content');

      const sendSpy = jest.fn();
      mockGetMainWindow.mockReturnValue({
        isDestroyed: () => true,
        webContents: { send: sendSpy }
      });

      mockServiceIntegration.processingState.getIncompleteOrganizeBatches.mockReturnValue([
        {
          id: 'batch1',
          operations: [{ source, destination: dest, status: 'pending' }]
        }
      ]);

      await resumeIncompleteBatches(mockServiceIntegration, mockLogger, mockGetMainWindow);

      // Operation must still complete despite window being gone.
      expect(mockServiceIntegration.processingState.markOrganizeOpDone).toHaveBeenCalled();
      expect(mockServiceIntegration.processingState.completeOrganizeBatch).toHaveBeenCalledWith(
        'batch1'
      );
      // But progress events must not be fired at a destroyed webContents.
      expect(sendSpy).not.toHaveBeenCalled();
    });

    test('still completes operations when getMainWindow returns null', async () => {
      const source = path.join(testDir, 'source.txt');
      const dest = path.join(testDir, 'dest.txt');
      await fs.writeFile(source, 'content');

      mockGetMainWindow.mockReturnValue(null);

      mockServiceIntegration.processingState.getIncompleteOrganizeBatches.mockReturnValue([
        {
          id: 'batch1',
          operations: [{ source, destination: dest, status: 'pending' }]
        }
      ]);

      await resumeIncompleteBatches(mockServiceIntegration, mockLogger, mockGetMainWindow);

      expect(mockServiceIntegration.processingState.markOrganizeOpDone).toHaveBeenCalled();
      expect(mockServiceIntegration.processingState.completeOrganizeBatch).toHaveBeenCalledWith(
        'batch1'
      );
    });

    test('processes multiple batches', async () => {
      const source1 = path.join(testDir, 'source1.txt');
      const dest1 = path.join(testDir, 'dest1.txt');
      const source2 = path.join(testDir, 'source2.txt');
      const dest2 = path.join(testDir, 'dest2.txt');
      await fs.writeFile(source1, 'content1');
      await fs.writeFile(source2, 'content2');

      mockServiceIntegration.processingState.getIncompleteOrganizeBatches.mockReturnValue([
        {
          id: 'batch1',
          operations: [{ source: source1, destination: dest1, status: 'pending' }]
        },
        {
          id: 'batch2',
          operations: [{ source: source2, destination: dest2, status: 'pending' }]
        }
      ]);

      await resumeIncompleteBatches(mockServiceIntegration, mockLogger, mockGetMainWindow);

      expect(mockServiceIntegration.processingState.completeOrganizeBatch).toHaveBeenCalledWith(
        'batch1'
      );
      expect(mockServiceIntegration.processingState.completeOrganizeBatch).toHaveBeenCalledWith(
        'batch2'
      );
    });

    test('logs batch completion', async () => {
      const source = path.join(testDir, 'source.txt');
      const dest = path.join(testDir, 'dest.txt');
      await fs.writeFile(source, 'content');

      mockServiceIntegration.processingState.getIncompleteOrganizeBatches.mockReturnValue([
        {
          id: 'batch1',
          operations: [{ source, destination: dest, status: 'pending' }]
        }
      ]);

      await resumeIncompleteBatches(mockServiceIntegration, mockLogger, mockGetMainWindow);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Completed batch resume'),
        'batch1'
      );
    });
  });

  // Post-batch persistence is tracked per op (persistedOpIndices), not per
  // batch: a partial run interrupted by a non-user abort, or a pause → resume
  // → crash, leaves some done ops already covered by the live handler and
  // others not. Resume must persist exactly the uncovered done ops.
  describe('post-batch persistence coverage', () => {
    const handlerModule = require('../src/main/ipc/files/batchOrganizeHandler');
    let recordUndoSpy;

    const doneOp = (index) => ({
      source: path.join(testDir, `src-${index}.txt`),
      destination: path.join(testDir, `dest-${index}.txt`),
      status: 'done'
    });

    beforeEach(() => {
      recordUndoSpy = jest
        .spyOn(handlerModule, 'recordUndoAndUpdateDatabase')
        .mockResolvedValue({ undoRecorded: true, pathIndexUpdated: true });
      mockServiceIntegration.processingState.markOrganizeOpsPersisted = jest
        .fn()
        .mockResolvedValue();
    });

    afterEach(() => {
      recordUndoSpy.mockRestore();
    });

    test('persists only the done ops not yet covered by persistedOpIndices', async () => {
      const operations = Array.from({ length: 10 }, (_, i) => doneOp(i));
      mockServiceIntegration.processingState.getIncompleteOrganizeBatches.mockReturnValue([
        { id: 'batch_1700000000000_0000abcd', persistedOpIndices: [0, 1, 2, 3, 4], operations }
      ]);

      await resumeIncompleteBatches(mockServiceIntegration, mockLogger, mockGetMainWindow);

      expect(recordUndoSpy).toHaveBeenCalledTimes(1);
      const [, , successCount, undoBatchId, , , , completedOps] = recordUndoSpy.mock.calls[0];
      expect(completedOps.map((c) => c.index)).toEqual([5, 6, 7, 8, 9]);
      expect(successCount).toBe(5);
      // Distinct from the live run's undo id, but deterministic for this
      // subset so a crash-and-retry hits the hasBatchAction dedup guard.
      expect(undoBatchId).toBe('batch_1700000000000_0000abcd:p5');
      expect(mockServiceIntegration.processingState.markOrganizeOpsPersisted).toHaveBeenCalledWith(
        'batch_1700000000000_0000abcd',
        [5, 6, 7, 8, 9]
      );
    });

    test('leaves ops uncovered when the path index update did not land', async () => {
      recordUndoSpy.mockResolvedValue({ undoRecorded: true, pathIndexUpdated: false });
      mockServiceIntegration.processingState.getIncompleteOrganizeBatches.mockReturnValue([
        { id: 'batch1', persistedOpIndices: [], operations: [doneOp(0), doneOp(1)] }
      ]);

      await resumeIncompleteBatches(mockServiceIntegration, mockLogger, mockGetMainWindow);

      expect(recordUndoSpy).toHaveBeenCalledTimes(1);
      expect(
        mockServiceIntegration.processingState.markOrganizeOpsPersisted
      ).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Post-batch persistence incomplete'),
        expect.objectContaining({ batchId: 'batch1', pathIndexUpdated: false })
      );
    });

    test('legacy batch-wide persistedAt stamp covers every op that was done at load', async () => {
      mockServiceIntegration.processingState.getIncompleteOrganizeBatches.mockReturnValue([
        {
          id: 'legacy-batch',
          persistedAt: new Date().toISOString(),
          operations: [doneOp(0), doneOp(1), doneOp(2)]
        }
      ]);

      await resumeIncompleteBatches(mockServiceIntegration, mockLogger, mockGetMainWindow);

      expect(recordUndoSpy).not.toHaveBeenCalled();
      expect(
        mockServiceIntegration.processingState.markOrganizeOpsPersisted
      ).not.toHaveBeenCalled();
      expect(mockServiceIntegration.processingState.completeOrganizeBatch).toHaveBeenCalledWith(
        'legacy-batch'
      );
    });

    test('legacy stamp does not cover ops replayed during this resume', async () => {
      const pendingSource = path.join(testDir, 'legacy-pending.txt');
      const pendingDest = path.join(testDir, 'legacy-pending-dest.txt');
      await fs.writeFile(pendingSource, 'content');
      const batch = {
        id: 'legacy-batch',
        persistedAt: new Date().toISOString(),
        operations: [
          doneOp(0),
          { source: pendingSource, destination: pendingDest, status: 'pending' }
        ]
      };
      mockServiceIntegration.processingState.getIncompleteOrganizeBatches.mockReturnValue([batch]);
      // The real service mutates the live journal entry; mirror that so the
      // replayed op is 'done' by the time post-batch persistence runs.
      mockServiceIntegration.processingState.markOrganizeOpDone.mockImplementation(
        async (_id, index, update) => {
          Object.assign(batch.operations[index], update, { status: 'done' });
        }
      );

      await resumeIncompleteBatches(mockServiceIntegration, mockLogger, mockGetMainWindow);

      expect(recordUndoSpy).toHaveBeenCalledTimes(1);
      const completedOps = recordUndoSpy.mock.calls[0][7];
      expect(completedOps.map((c) => c.index)).toEqual([1]);
      expect(mockServiceIntegration.processingState.markOrganizeOpsPersisted).toHaveBeenCalledWith(
        'legacy-batch',
        [1]
      );
    });
  });
});
