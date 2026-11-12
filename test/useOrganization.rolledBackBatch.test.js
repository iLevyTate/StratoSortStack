/**
 * fileops-organize-2 (renderer half): a batch the main process rolled back
 * must not read as organized. Main rewrites restored rows to
 * `success: false, rolledBack: true` and keeps `success: true,
 * rollbackFailed: true` on rows whose restore failed (those files really are
 * at their destination). The renderer must show one error toast that names
 * the files left behind, and must not show success/partial toasts or the
 * generic "nothing organized" warning on top of it.
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

function buildOptions(rollbackResult) {
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
      action?.callbacks?.onExecute?.(rollbackResult);
      return rollbackResult;
    }),
    addOrganizedFiles: jest.fn(),
    removeOrganizedFiles: jest.fn(),
    setOrganizingState: jest.fn()
  };
}

// The routing note about categories mapped to Uncategorized is unrelated to
// the batch outcome; these tests look only at the outcome toasts.
function outcomeToasts(options) {
  return options.addNotification.mock.calls.filter((call) => call[3] !== 'category-changed');
}

function rolledBack(rows, extra = {}) {
  return {
    success: false,
    rolledBack: true,
    rollbackReason: 'Critical error: EACCES: permission denied',
    results: rows,
    successCount: 0,
    failCount: 1,
    criticalError: true,
    batchId: 'batch_1',
    recoveryPath: null,
    rollbackFailCount: 0,
    ...extra
  };
}

describe('useOrganization: rolled-back batch (fileops-organize-2)', () => {
  let useOrganization;

  beforeEach(() => {
    jest.clearAllMocks();
    global.window = global.window || {};
    global.window.electronAPI = {
      events: { onOperationProgress: jest.fn(() => jest.fn()) },
      files: { normalizePath: jest.fn((p) => p) }
    };
    useOrganization = require('../src/renderer/phases/organize/useOrganization').useOrganization;
  });

  test('fully restored batch: one error toast, nothing recorded as organized', async () => {
    const result = rolledBack([
      {
        success: false,
        rolledBack: true,
        source: '/in/a.txt',
        destination: '/Documents/A.txt',
        error: 'Critical error: EACCES: permission denied'
      },
      {
        success: false,
        rolledBack: true,
        source: '/in/b.txt',
        destination: '/Documents/B.txt',
        error: 'Critical error: EACCES: permission denied'
      },
      {
        success: false,
        source: '/in/c.txt',
        destination: '/Documents/C.txt',
        error: 'EACCES: permission denied',
        critical: true
      }
    ]);
    const options = buildOptions(result);
    const { result: hook } = renderHook(() => useOrganization(options));

    await act(async () => {
      await hook.current.handleOrganizeFiles();
    });

    const calls = outcomeToasts(options);
    expect(calls).toHaveLength(1);
    const [message, level] = calls[0];
    expect(level).toBe('error');
    expect(message).toMatch(/rolled back/i);
    expect(message).toMatch(/returned to their original locations/i);
    expect(options.addOrganizedFiles).not.toHaveBeenCalled();
    expect(options.dispatch).not.toHaveBeenCalled();
    expect(options.markFilesAsProcessed).not.toHaveBeenCalled();
    expect(options.actions.advancePhase).not.toHaveBeenCalled();
    // The banner repeats the toast and stays after the toast is gone.
    expect(hook.current.lastOrganizeSummary).toMatchObject({
      outcome: 'rolledBack',
      count: 0,
      headline: 'Organization was rolled back'
    });
    expect(message).toBe(
      `Organization was rolled back. ${hook.current.lastOrganizeSummary.detail}`
    );
  });

  test('partially restored batch: names files left at their destination and the recovery file', async () => {
    const result = rolledBack(
      [
        {
          success: false,
          rolledBack: true,
          source: '/in/a.txt',
          destination: '/Documents/A.txt',
          error: 'Critical error: EACCES: permission denied'
        },
        {
          success: true,
          rollbackFailed: true,
          rollbackError: 'EBUSY',
          source: '/in/b.txt',
          destination: 'C:\\Docs\\B.txt'
        },
        {
          success: false,
          source: '/in/c.txt',
          destination: '/Documents/C.txt',
          error: 'EACCES: permission denied',
          critical: true
        }
      ],
      { rollbackFailCount: 1, recoveryPath: '/userData/recovery/rollback_batch_1.json' }
    );
    const options = buildOptions(result);
    const { result: hook } = renderHook(() => useOrganization(options));

    await act(async () => {
      await hook.current.handleOrganizeFiles();
    });

    const calls = outcomeToasts(options);
    expect(calls).toHaveLength(1);
    const [message, level] = calls[0];
    expect(level).toBe('error');
    expect(message).toMatch(/rolled back/i);
    // Named by its file name, not its full Windows path.
    expect(message).toMatch(/: B\.txt\./);
    expect(message).not.toMatch(/A\.txt/);
    expect(message).toContain('/userData/recovery/rollback_batch_1.json');

    // The file the rollback could not restore really is at its destination:
    // its paths follow it; the restored file's paths do not.
    expect(options.dispatch).toHaveBeenCalled();
    for (const [action] of options.dispatch.mock.calls) {
      expect(action.payload.oldPaths).toEqual(['/in/b.txt']);
      expect(action.payload.newPaths).toEqual(['C:\\Docs\\B.txt']);
    }
    expect(options.actions.advancePhase).not.toHaveBeenCalled();
  });

  test('a recovery path is not shown when every file was restored (main deletes that file)', async () => {
    const result = rolledBack(
      [
        {
          success: false,
          rolledBack: true,
          source: '/in/a.txt',
          destination: '/Documents/A.txt',
          error: 'x'
        }
      ],
      { recoveryPath: '/userData/recovery/rollback_batch_1.json', rollbackFailCount: 0 }
    );
    const options = buildOptions(result);
    const { result: hook } = renderHook(() => useOrganization(options));

    await act(async () => {
      await hook.current.handleOrganizeFiles();
    });

    const calls = outcomeToasts(options);
    expect(calls).toHaveLength(1);
    const [message] = calls[0];
    expect(message).not.toContain('rollback_batch_1.json');
  });
});
