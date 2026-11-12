/**
 * The Organize "Preview" asks the main process for a dry-run plan of the
 * same operations a Move would send. `handlePreviewOrganize` returns that
 * plan, adds the files this batch sends to one name (the Move refuses to
 * start while any exist), and throws when the request fails or is refused,
 * so the screen can say why instead of showing an empty preview.
 */

import { renderHook } from '@testing-library/react';

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
  createOrganizeBatchAction: jest.fn(),
  previewBatchOrganize: jest.fn()
}));

const { previewBatchOrganize } = require('../src/renderer/components/UndoRedoSystem');
const { useOrganization } = require('../src/renderer/phases/organize/useOrganization');

const FINANCE = { id: 'fin', name: 'Finance', path: '/Users/hans/Sorted/Finance' };

const file = (path, category, suggestedName) => {
  const name = path.split(/[\\/]/).pop();
  return { path, name, analysis: { category, suggestedName: suggestedName || name } };
};

const hookOptions = (unprocessedFiles) => ({
  unprocessedFiles,
  editingFiles: {},
  getFileWithEdits: (f) => f,
  findSmartFolderForCategory: (label) =>
    String(label).toLowerCase() === FINANCE.name.toLowerCase() ? FINANCE : null,
  defaultLocation: '/Users/hans/Documents',
  smartFolders: [FINANCE],
  analysisResults: [],
  markFilesAsProcessed: jest.fn(),
  unmarkFilesAsProcessed: jest.fn(),
  actions: { setPhaseData: jest.fn(), advancePhase: jest.fn() },
  phaseData: { organizedFiles: [] },
  addNotification: jest.fn(),
  dispatch: jest.fn(),
  executeAction: jest.fn(),
  addOrganizedFiles: jest.fn(),
  removeOrganizedFiles: jest.fn(),
  setOrganizingState: jest.fn()
});

const dryRunPlan = (wouldMove) => ({
  success: true,
  dryRun: true,
  total: wouldMove.length,
  wouldMove,
  skipped: [],
  wouldCreateFolders: [],
  conflicts: 0
});

describe('useOrganization: handlePreviewOrganize', () => {
  beforeEach(() => {
    previewBatchOrganize.mockReset();
    global.window = global.window || {};
    global.window.electronAPI = {
      events: { onOperationProgress: jest.fn(() => jest.fn()) },
      files: { normalizePath: jest.fn((p) => p) }
    };
  });

  test('sends the operations a Move would send and returns the plan', async () => {
    const invoice = file('/Users/hans/Downloads/scan.pdf', 'Finance', 'Invoice March.pdf');
    const moved = [
      { source: invoice.path, destination: '/Users/hans/Sorted/Finance/Invoice March.pdf' }
    ];
    previewBatchOrganize.mockResolvedValue(dryRunPlan(moved));

    const { result } = renderHook(() => useOrganization(hookOptions([invoice])));
    const plan = await result.current.handlePreviewOrganize();

    expect(previewBatchOrganize).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'move',
        source: invoice.path,
        destination: '/Users/hans/Sorted/Finance/Invoice March.pdf'
      })
    ]);
    expect(plan.wouldMove).toEqual(moved);
    expect(plan.sameDestination).toEqual([]);
  });

  test('lists the files this batch sends to one name', async () => {
    const first = file('/Users/hans/Downloads/scan 1.pdf', 'Finance', 'Invoice.pdf');
    const second = file('/Users/hans/Downloads/scan 2.pdf', 'Finance', 'Invoice.pdf');
    const other = file('/Users/hans/Downloads/budget.xlsx', 'Finance');
    previewBatchOrganize.mockResolvedValue(dryRunPlan([]));

    const { result } = renderHook(() => useOrganization(hookOptions([first, second, other])));
    const plan = await result.current.handlePreviewOrganize();

    expect(plan.sameDestination).toEqual([
      {
        destination: '/Users/hans/Sorted/Finance/Invoice.pdf',
        files: [
          { fileName: 'Invoice.pdf', sourcePath: first.path },
          { fileName: 'Invoice.pdf', sourcePath: second.path }
        ]
      }
    ]);
  });

  test('previews only the files it is given', async () => {
    const picked = file('/Users/hans/Downloads/a.pdf', 'Finance');
    const left = file('/Users/hans/Downloads/b.pdf', 'Finance');
    previewBatchOrganize.mockResolvedValue(dryRunPlan([]));

    const { result } = renderHook(() => useOrganization(hookOptions([picked, left])));
    await result.current.handlePreviewOrganize([picked]);

    expect(previewBatchOrganize.mock.calls[0][0].map((op) => op.source)).toEqual([picked.path]);
  });

  test('throws the reason when the main process refuses the batch', async () => {
    previewBatchOrganize.mockResolvedValue({
      success: false,
      error: 'Batch size exceeds maximum of 1000',
      errorCode: 'BATCH_TOO_LARGE'
    });

    const { result } = renderHook(() =>
      useOrganization(hookOptions([file('/Users/hans/Downloads/a.pdf', 'Finance')]))
    );

    await expect(result.current.handlePreviewOrganize()).rejects.toThrow(
      'Batch size exceeds maximum of 1000'
    );
  });

  test('throws when the request itself fails', async () => {
    previewBatchOrganize.mockRejectedValue(new Error('File operations API not available'));

    const { result } = renderHook(() =>
      useOrganization(hookOptions([file('/Users/hans/Downloads/a.pdf', 'Finance')]))
    );

    await expect(result.current.handlePreviewOrganize()).rejects.toThrow(
      'File operations API not available'
    );
  });

  test('returns null, without asking, when there is no file to preview', async () => {
    const { result } = renderHook(() => useOrganization(hookOptions([])));

    await expect(result.current.handlePreviewOrganize()).resolves.toBeNull();
    expect(previewBatchOrganize).not.toHaveBeenCalled();
  });
});
