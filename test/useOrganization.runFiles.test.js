/**
 * What an organize run leaves behind for the screens that report it:
 * - files.lastOrganizeRunFiles, one row per file with where it is now or why
 *   it did not move;
 * - the summary's notMovedCount, so the Dashboard can count those files;
 * - one error message and a lasting summary when the batch call itself fails.
 * And how files are matched when main returns a path in another spelling.
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

let mockIsMac = false;
jest.mock('../src/renderer/utils/platform', () => ({
  get isMac() {
    return mockIsMac;
  },
  isWindows: false
}));

const files = ['a', 'b', 'c'].map((n) => ({
  path: `/in/${n}.txt`,
  name: `${n}.txt`,
  analysis: { category: 'documents', suggestedName: `${n.toUpperCase()}.txt` }
}));
const dest = (n) => `/Documents/Uncategorized/${n.toUpperCase()}.txt`;
const moved = (n) => ({ success: true, source: `/in/${n}.txt`, destination: dest(n) });

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
    executeAction: jest.fn().mockImplementation(async (action) => {
      action?.callbacks?.onExecute?.(batchResult);
      return batchResult;
    }),
    addOrganizedFiles: jest.fn(),
    removeOrganizedFiles: jest.fn(),
    setOrganizingState: jest.fn(),
    setLastOrganizeRun: jest.fn(),
    setLastOrganizeRunFiles: jest.fn(),
    ...overrides
  };
}

const runFilesDispatches = (options) =>
  options.setLastOrganizeRunFiles.mock.calls.map((call) => ({ payload: call[0] }));
const lastRun = (options) => options.setLastOrganizeRun.mock.calls.at(-1)?.[0];

describe('useOrganization: the per-file record of a run', () => {
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
    mockIsMac = false;
    global.window = global.window || {};
    global.window.electronAPI = {
      events: { onOperationProgress: jest.fn(() => jest.fn()) },
      files: { normalizePath: jest.fn((p) => p) }
    };
    useOrganization = require('../src/renderer/phases/organize/useOrganization').useOrganization;
  });

  test('a run clears the last list when it starts, then stores one row per file', async () => {
    const { options } = await run({
      success: true,
      successCount: 2,
      failCount: 1,
      results: [
        moved('a'),
        { success: false, source: '/in/b.txt', destination: dest('b'), error: 'EACCES' },
        moved('c')
      ]
    });

    const stored = runFilesDispatches(options);
    expect(stored[0].payload).toEqual([]);
    const rows = stored.at(-1).payload;
    expect(rows.map((r) => [r.name, r.outcome])).toEqual([
      ['a.txt', 'moved'],
      ['b.txt', 'failed'],
      ['c.txt', 'moved']
    ]);
    expect(rows[0].finalPath).toBe(dest('a'));
    expect(lastRun(options).notMovedCount).toBe(1);
  });

  test('a rolled-back run stores the files it returned', async () => {
    const { options } = await run({
      success: false,
      rolledBack: true,
      results: [
        { success: false, rolledBack: true, source: '/in/a.txt', destination: dest('a') },
        { success: false, source: '/in/b.txt', destination: dest('b'), error: 'EIO' },
        { success: false, notAttempted: true, source: '/in/c.txt', destination: dest('c') }
      ]
    });

    const rows = runFilesDispatches(options).at(-1).payload;
    expect(rows.map((r) => r.outcome)).toEqual(['restored', 'failed', 'notMoved']);
    expect(lastRun(options).notMovedCount).toBe(3);
  });

  test('a thrown batch call: one error message and a summary that stays', async () => {
    const { options } = await run(null, {
      executeAction: jest.fn().mockRejectedValue(new Error('IPC timeout'))
    });

    const errors = options.addNotification.mock.calls.filter((call) => call[1] === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toMatch(/^Organization failed: /);
    expect(lastRun(options)).toEqual(
      expect.objectContaining({
        outcome: 'none',
        count: 0,
        headline: 'Organization stopped with an error'
      })
    );
    expect(lastRun(options).detail).toMatch(
      /Files that were not moved are still listed\. Check the destination folders for any that were\.$/
    );
  });

  test('a thrown batch call still lists every file, without claiming it stayed put', async () => {
    const { options } = await run(null, {
      executeAction: jest.fn().mockRejectedValue(new Error('IPC timeout'))
    });

    const rows = runFilesDispatches(options).at(-1).payload;
    expect(rows.map((r) => [r.name, r.outcome])).toEqual([
      ['a.txt', 'notMoved'],
      ['b.txt', 'notMoved'],
      ['c.txt', 'notMoved']
    ]);
    for (const row of rows) {
      expect(row.reason).toMatch(/may have moved/i);
      expect(row.reason).toMatch(/destination folder/i);
    }
    expect(lastRun(options).notMovedCount).toBe(3);
  });

  test('a batch call that throws after its results were stored keeps those rows', async () => {
    const batchResult = {
      success: true,
      successCount: 3,
      results: [moved('a'), moved('b'), moved('c')]
    };
    const { options } = await run(batchResult, {
      executeAction: jest.fn().mockImplementation(async (action) => {
        action?.callbacks?.onExecute?.(batchResult);
        throw new Error('late failure');
      })
    });

    const rows = runFilesDispatches(options).at(-1).payload;
    expect(rows.map((r) => r.outcome)).toEqual(['moved', 'moved', 'moved']);
  });

  test('the not-moved count matches the list when main returns fewer rows than files', async () => {
    const { options } = await run({
      success: false,
      partialFailure: true,
      error: 'Batch failed',
      results: [
        moved('a'),
        { success: false, source: '/in/b.txt', destination: dest('b'), error: 'EACCES' }
      ]
    });

    const rows = runFilesDispatches(options).at(-1).payload;
    expect(rows.map((r) => r.outcome)).toEqual(['moved', 'failed', 'notMoved']);
    expect(lastRun(options).notMovedCount).toBe(2);
  });

  test('a file main returns in its composed spelling keeps its original name', async () => {
    const decomposed = '/in/Ma\u0308rz.txt';
    const composed = '/in/M\u00e4rz.txt';
    const file = {
      path: decomposed,
      name: 'Ma\u0308rz.txt',
      analysis: { category: 'documents', suggestedName: 'Rechnung.txt' }
    };
    const { options } = await run(
      {
        success: true,
        successCount: 1,
        results: [{ success: true, source: composed, destination: '/Documents/Rechnung.txt' }]
      },
      {
        unprocessedFiles: [file],
        analysisResults: [{ path: decomposed, name: 'Ma\u0308rz.txt' }]
      }
    );

    const organized = options.addOrganizedFiles.mock.calls[0][0];
    expect(organized[0].originalName).toBe('Ma\u0308rz.txt');
  });

  describe('two files headed for one name that differs only in case', () => {
    const twins = [
      {
        path: '/in/1.pdf',
        name: '1.pdf',
        analysis: { category: 'x', suggestedName: 'Report.pdf' }
      },
      { path: '/in/2.pdf', name: '2.pdf', analysis: { category: 'x', suggestedName: 'report.pdf' } }
    ];

    test('are one destination on a Mac', async () => {
      mockIsMac = true;
      const { options, hook } = await run(null, { unprocessedFiles: twins });
      expect(hook.current.organizeConflicts).toHaveLength(1);
      expect(options.executeAction).not.toHaveBeenCalled();
    });

    test('are two destinations on Linux', async () => {
      mockIsMac = false;
      const { hook } = await run(
        { success: true, successCount: 2, results: [] },
        { unprocessedFiles: twins }
      );
      expect(hook.current.organizeConflicts).toHaveLength(0);
    });
  });
});
