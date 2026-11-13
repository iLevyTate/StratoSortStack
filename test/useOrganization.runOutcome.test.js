/**
 * How a finished organize run is reported: one toast and one banner
 * (`lastOrganizeSummary`) that say what was moved, what was not and why.
 *
 * A file that was not moved must never be counted as organized: a failed row,
 * a row the run never reached, and a duplicate that was removed because the
 * destination already held the same content are each reported for what they
 * are. A run that left files behind stays on Organize.
 */

import { renderHook, act } from '@testing-library/react';

jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

jest.mock('../src/shared/constants', () => ({
  PHASES: { DISCOVER: 'discover', ORGANIZE: 'organize', COMPLETE: 'complete' },
  IPC_CHANNELS: {
    FILES: { PERFORM_OPERATION: 'files:perform-operation' }
  }
}));

jest.mock('../src/renderer/components/UndoRedoSystem', () => ({
  createOrganizeBatchAction: jest.fn((label, operations, callbacks, options) => ({
    type: 'organize-batch',
    label,
    operations,
    callbacks,
    options
  }))
}));

const files = ['a', 'b', 'c'].map((n) => ({
  path: `/in/${n}.txt`,
  name: `${n}.txt`,
  analysis: { category: 'documents', suggestedName: `${n.toUpperCase()}.txt` }
}));

const moved = (n) => ({
  success: true,
  source: `/in/${n}.txt`,
  destination: `/Documents/${n.toUpperCase()}.txt`
});
const failed = (n, error = 'EEXIST: destination exists') => ({
  success: false,
  source: `/in/${n}.txt`,
  destination: `/Documents/${n.toUpperCase()}.txt`,
  error
});
const duplicate = (n, sourceRemoval = 'trashed') => ({
  success: true,
  source: `/in/${n}.txt`,
  destination: '/Documents/A.txt',
  operation: 'move',
  skipped: true,
  reason: 'duplicate',
  sourceRemoval
});
const notStarted = (n, flag) => ({
  success: false,
  source: `/in/${n}.txt`,
  destination: `/Documents/${n.toUpperCase()}.txt`,
  operation: 'move',
  [flag]: true
});

function buildOptions(batchResult, overrides = {}) {
  return {
    unprocessedFiles: files,
    editingFiles: {},
    getFileWithEdits: jest.fn((file) => file),
    findSmartFolderForCategory: jest.fn(() => null),
    defaultLocation: '/Documents',
    smartFolders: [],
    analysisResults: [],
    markFilesAsProcessed: jest.fn(),
    unmarkFilesAsProcessed: jest.fn(),
    actions: { setPhaseData: jest.fn(), advancePhase: jest.fn() },
    phaseData: { organizedFiles: [] },
    addNotification: jest.fn(),
    dispatch: jest.fn(),
    // Like the real executor: run the action's onExecute, then resolve.
    executeAction: jest.fn().mockImplementation(async (action) => {
      action?.callbacks?.onExecute?.(batchResult);
      return batchResult;
    }),
    addOrganizedFiles: jest.fn(),
    removeOrganizedFiles: jest.fn(),
    setOrganizingState: jest.fn(),
    ...overrides
  };
}

// The routing note about categories mapped to Uncategorized is unrelated to
// the batch outcome; these tests look only at the outcome toasts.
function outcomeToasts(options) {
  return options.addNotification.mock.calls.filter((call) => call[3] !== 'category-changed');
}

describe('useOrganization: how a finished run is reported', () => {
  let useOrganization;

  async function run(batchResult, overrides) {
    const options = buildOptions(batchResult, overrides);
    const rendered = renderHook(() => useOrganization(options));
    await act(async () => {
      await rendered.result.current.handleOrganizeFiles();
    });
    return { options, hook: rendered.result };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    global.window = global.window || {};
    global.window.electronAPI = {
      events: { onOperationProgress: jest.fn(() => jest.fn()) },
      files: { normalizePath: jest.fn((p) => p) }
    };
    useOrganization = require('../src/renderer/phases/organize/useOrganization').useOrganization;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('every file moved', () => {
    test('one success toast, a banner with the count, and on to Complete', async () => {
      const { options, hook } = await run({
        success: true,
        results: [moved('a'), moved('b'), moved('c')],
        successCount: 3
      });

      expect(outcomeToasts(options)).toEqual([['Organized 3 files', 'success', 7000]]);
      expect(hook.current.lastOrganizeSummary).toEqual({
        outcome: 'moved',
        count: 3,
        headline: 'Moved 3 files to their destinations',
        detail: ''
      });
      expect(options.actions.advancePhase).toHaveBeenCalledWith('complete');
    });

    test('the banner clears itself', async () => {
      jest.useFakeTimers();
      const { hook } = await run({ success: true, results: [moved('a')], successCount: 1 });
      expect(hook.current.lastOrganizeSummary).toMatchObject({
        headline: 'Moved 1 file to its destination'
      });

      act(() => {
        jest.advanceTimersByTime(12000);
      });

      expect(hook.current.lastOrganizeSummary).toBeNull();
    });
  });

  describe('some files not moved', () => {
    const partial = {
      success: true,
      results: [moved('a'), moved('b'), failed('c')],
      successCount: 2,
      failCount: 1
    };

    test('one warning toast with the reason, and the run stays on Organize', async () => {
      const { options, hook } = await run(partial);

      const toasts = outcomeToasts(options);
      expect(toasts).toHaveLength(1);
      const [message, level] = toasts[0];
      expect(level).toBe('warning');
      expect(message).toMatch(/^Organized 2 files with 1 failure\. \S/);
      expect(hook.current.lastOrganizeSummary).toMatchObject({
        outcome: 'partial',
        count: 2,
        headline: 'Moved 2 files; 1 could not be moved'
      });
      expect(hook.current.lastOrganizeSummary.detail).toMatch(
        /Files that were not moved are still listed\.$/
      );
      expect(options.actions.advancePhase).not.toHaveBeenCalled();
      // The files that did move are still recorded.
      expect(options.addOrganizedFiles).toHaveBeenCalledWith([
        expect.objectContaining({ originalPath: '/in/a.txt' }),
        expect.objectContaining({ originalPath: '/in/b.txt' })
      ]);
    });

    test('the banner stays until it is dismissed', async () => {
      jest.useFakeTimers();
      const { hook } = await run(partial);

      act(() => {
        jest.advanceTimersByTime(60000);
      });
      expect(hook.current.lastOrganizeSummary).toMatchObject({ outcome: 'partial' });

      act(() => {
        hook.current.dismissOrganizeSummary();
      });
      expect(hook.current.lastOrganizeSummary).toBeNull();
    });

    test('the next run clears the previous banner when it starts', async () => {
      const { options, hook } = await run(partial);
      let finish;
      options.executeAction.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ success: true, results: [], successCount: 0 });
          })
      );

      let second;
      await act(async () => {
        second = hook.current.handleOrganizeFiles();
        await Promise.resolve();
      });
      expect(hook.current.lastOrganizeSummary).toBeNull();

      await act(async () => {
        finish();
        await second;
      });
    });
  });

  describe('no file moved', () => {
    test('one error toast with the reason and nothing else', async () => {
      const { options, hook } = await run({
        success: false,
        results: [failed('a'), failed('b'), failed('c')],
        successCount: 0,
        failCount: 3
      });

      const toasts = outcomeToasts(options);
      expect(toasts).toHaveLength(1);
      const [message, level] = toasts[0];
      expect(level).toBe('error');
      expect(message).toMatch(/^No files were organized\. \S/);
      expect(hook.current.lastOrganizeSummary).toMatchObject({
        outcome: 'none',
        count: 0,
        headline: 'No files were organized'
      });
      expect(options.addOrganizedFiles).not.toHaveBeenCalled();
      expect(options.actions.advancePhase).not.toHaveBeenCalled();
    });

    test('a batch that stopped on an error reports that error', async () => {
      const { options, hook } = await run({
        success: false,
        partialFailure: true,
        results: [moved('a')],
        successCount: 1,
        failCount: 0,
        error: 'The batch lock could not be acquired',
        errorCode: 'PARTIAL_FAILURE'
      });

      const toasts = outcomeToasts(options);
      expect(toasts).toHaveLength(1);
      expect(toasts[0][0]).toMatch(/^Organized 1 file, but the run did not finish\. \S/);
      expect(toasts[0][1]).toBe('warning');
      expect(hook.current.lastOrganizeSummary).toMatchObject({
        outcome: 'partial',
        headline: 'Moved 1 file; the run did not finish'
      });
      expect(options.actions.advancePhase).not.toHaveBeenCalled();
    });
  });

  describe('duplicates removed instead of moved', () => {
    test('are counted apart from the files that moved', async () => {
      const { options, hook } = await run({
        success: true,
        results: [moved('a'), duplicate('b'), moved('c')],
        // Main counts a removed duplicate as a success.
        successCount: 3
      });

      expect(outcomeToasts(options)).toEqual([
        [
          'Organized 2 files. 1 identical copy was not moved: the destination already had the same content. It is in the system Trash.',
          'success',
          10000
        ]
      ]);
      expect(hook.current.lastOrganizeSummary).toEqual({
        outcome: 'moved',
        count: 2,
        headline: 'Moved 2 files to their destinations',
        detail:
          '1 identical copy was not moved: the destination already had the same content. It is in the system Trash.'
      });
      expect(options.actions.advancePhase).toHaveBeenCalledWith('complete');
    });

    test('are recorded as removed duplicates that point at the kept copy', async () => {
      const { options } = await run({
        success: true,
        results: [moved('a'), duplicate('b')],
        successCount: 2
      });

      const [entries] = options.addOrganizedFiles.mock.calls[0];
      expect(entries).toHaveLength(2);
      expect(entries[0]).not.toHaveProperty('duplicateRemoval');
      expect(entries[1]).toMatchObject({
        originalPath: '/in/b.txt',
        path: '/Documents/A.txt',
        duplicateRemoval: 'trashed'
      });
    });

    test('say "removed" when a copy did not go to the Trash', async () => {
      const { options } = await run({
        success: true,
        results: [moved('a'), duplicate('b', 'trashed'), duplicate('c', 'deleted')],
        successCount: 3
      });

      const [message] = outcomeToasts(options)[0];
      expect(message).toBe(
        'Organized 1 file. 2 identical copies were not moved: the destination already had the same content. They were removed.'
      );
      const [entries] = options.addOrganizedFiles.mock.calls[0];
      expect(entries.map((e) => e.duplicateRemoval)).toEqual([undefined, 'trashed', 'deleted']);
    });

    test('a run of nothing but duplicates does not claim a move', async () => {
      const { options, hook } = await run(
        { success: true, results: [duplicate('b')], successCount: 1 },
        { unprocessedFiles: [files[1]] }
      );

      expect(outcomeToasts(options)).toEqual([
        [
          'No files needed moving. 1 identical copy was not moved: the destination already had the same content. It is in the system Trash.',
          'info',
          10000
        ]
      ]);
      expect(hook.current.lastOrganizeSummary).toMatchObject({
        outcome: 'moved',
        count: 0,
        headline: 'No files needed moving'
      });
    });

    test('are still reported when another file failed', async () => {
      const { options, hook } = await run({
        success: true,
        results: [duplicate('b'), failed('c')],
        successCount: 1,
        failCount: 1
      });

      const toasts = outcomeToasts(options);
      expect(toasts).toHaveLength(1);
      expect(toasts[0][1]).toBe('error');
      expect(toasts[0][0]).toMatch(/^No files were organized\. /);
      expect(toasts[0][0]).toMatch(/1 identical copy was not moved/);
      expect(hook.current.lastOrganizeSummary).toMatchObject({ outcome: 'none', count: 0 });
      expect(options.actions.advancePhase).not.toHaveBeenCalled();
    });
  });

  describe('a run that was stopped', () => {
    test('files the user cancelled before they started are not failures', async () => {
      const { options, hook } = await run({
        success: true,
        cancelled: true,
        cancelledCount: 2,
        results: [moved('a'), notStarted('b', 'cancelled'), notStarted('c', 'cancelled')],
        successCount: 1,
        completedOperations: 3
      });

      const toasts = outcomeToasts(options);
      expect(toasts).toEqual([
        ['Organization cancelled — 1 file organized, 2 skipped.', 'warning']
      ]);
      expect(hook.current.lastOrganizeSummary).toMatchObject({ outcome: 'moved', count: 1 });
      expect(options.actions.advancePhase).not.toHaveBeenCalled();
    });

    test('a cancel before any file moved says so once', async () => {
      const { options, hook } = await run({
        success: true,
        cancelled: true,
        cancelledCount: 3,
        results: ['a', 'b', 'c'].map((n) => notStarted(n, 'cancelled')),
        successCount: 0,
        completedOperations: 3
      });

      expect(outcomeToasts(options)).toEqual([
        ['Organization cancelled before any file was moved.', 'warning']
      ]);
      expect(hook.current.lastOrganizeSummary).toBeNull();
    });

    test('an interrupted run is reported as unfinished, with what happens next', async () => {
      const { options, hook } = await run({
        success: true,
        interrupted: true,
        interruptedCount: 2,
        abortReason: 'ipc-timeout',
        results: [moved('a'), notStarted('b', 'interrupted'), notStarted('c', 'interrupted')],
        successCount: 1,
        completedOperations: 3
      });

      expect(outcomeToasts(options)).toEqual([
        [
          'Organized 1 file, but the run did not finish. The run was interrupted. The remaining moves resume the next time StratoSort starts.',
          'warning',
          8000
        ]
      ]);
      expect(hook.current.lastOrganizeSummary).toMatchObject({
        outcome: 'partial',
        count: 1,
        headline: 'Moved 1 file; the run did not finish'
      });
      expect(options.actions.advancePhase).not.toHaveBeenCalled();
    });

    test('a run main stopped after failures says so, and counts the untried files apart', async () => {
      const { options, hook } = await run({
        success: false,
        stoppedOnFailure: true,
        stopReason: 'Critical error on file 2/3: EACCES: permission denied',
        notAttemptedCount: 1,
        results: [
          failed('a', 'EACCES: permission denied'),
          failed('b', 'EACCES: permission denied'),
          notStarted('c', 'notAttempted')
        ],
        successCount: 0,
        failCount: 2
      });

      const toasts = outcomeToasts(options);
      expect(toasts).toHaveLength(1);
      const [message, level, duration] = toasts[0];
      expect(level).toBe('error');
      expect(duration).toBe(9000);
      expect(message).toMatch(/^Organization was stopped; no files were moved\. \S/);
      expect(message).toMatch(/ The run was stopped after 2 failures; 1 file was not attempted\.$/);
      // Nothing resumes these files, so the interrupted wording does not apply.
      expect(message).not.toMatch(/resume/);
      expect(hook.current.lastOrganizeSummary).toMatchObject({
        outcome: 'none',
        count: 0,
        headline: 'Organization was stopped; no files were moved'
      });
      expect(message).toBe(
        `Organization was stopped; no files were moved. ${hook.current.lastOrganizeSummary.detail}`
      );
      expect(options.addOrganizedFiles).not.toHaveBeenCalled();
      expect(options.actions.advancePhase).not.toHaveBeenCalled();
    });

    test('a stopped run that kept a file an earlier run moved counts only real failures', async () => {
      const { options, hook } = await run({
        success: false,
        stoppedOnFailure: true,
        stopReason: 'Strict-mode failure on file 2/3: EACCES: permission denied',
        notAttemptedCount: 1,
        results: [
          { ...moved('a'), resumed: true },
          failed('b', 'EACCES: permission denied'),
          notStarted('c', 'notAttempted')
        ],
        successCount: 1,
        failCount: 1
      });

      const toasts = outcomeToasts(options);
      expect(toasts).toHaveLength(1);
      const [message, level] = toasts[0];
      expect(level).toBe('warning');
      expect(message).toMatch(/^Organized 1 file with 1 failure\. \S/);
      expect(message).toMatch(/ The run was stopped after 1 failure; 1 file was not attempted\.$/);
      expect(hook.current.lastOrganizeSummary).toMatchObject({
        outcome: 'partial',
        count: 1,
        headline: 'Moved 1 file; 1 could not be moved'
      });
      expect(options.actions.advancePhase).not.toHaveBeenCalled();
    });
  });
});
