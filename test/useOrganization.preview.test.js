/**
 * The Organize "Preview" asks the main process for a dry-run plan of the
 * same operations a Move would send. `handlePreviewOrganize` returns that
 * plan, numbers apart the files this batch would give one name (marked
 * like a name taken on disk), lists any it still sends to one name (the Move
 * refuses to start while any exist), and throws when the request fails or is
 * refused, so the screen can say why instead of showing an empty preview.
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

const FINANCE = { id: 'fin', name: 'Finance', path: '/Users/alex/Sorted/Finance' };

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
  defaultLocation: '/Users/alex/Documents',
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
    const invoice = file('/Users/alex/Downloads/scan.pdf', 'Finance', 'Invoice March.pdf');
    const moved = [
      { source: invoice.path, destination: '/Users/alex/Sorted/Finance/Invoice March.pdf' }
    ];
    previewBatchOrganize.mockResolvedValue(dryRunPlan(moved));

    const { result } = renderHook(() => useOrganization(hookOptions([invoice])));
    const plan = await result.current.handlePreviewOrganize();

    expect(previewBatchOrganize).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'move',
        source: invoice.path,
        destination: '/Users/alex/Sorted/Finance/Invoice March.pdf'
      })
    ]);
    expect(plan.wouldMove).toEqual(moved);
    expect(plan.sameDestination).toEqual([]);
  });

  test('numbers apart files this batch would give one name, and marks them', async () => {
    const first = file('/Users/alex/Downloads/scan 1.pdf', 'Finance', 'Invoice.pdf');
    const second = file('/Users/alex/Downloads/scan 2.pdf', 'Finance', 'Invoice.pdf');
    const third = file('/Users/alex/Downloads/scan 3.pdf', 'Finance', 'Invoice.pdf');
    const other = file('/Users/alex/Downloads/budget.xlsx', 'Finance');
    // Main echoes what it was sent: the numbered names are free on disk.
    previewBatchOrganize.mockImplementation(async (ops) =>
      dryRunPlan(ops.map((op) => ({ source: op.source, destination: op.destination })))
    );

    const { result } = renderHook(() =>
      useOrganization(hookOptions([first, second, third, other]))
    );
    const plan = await result.current.handlePreviewOrganize();

    // The shape main gives a taken name (formatNumberedCollisionCandidate).
    expect(previewBatchOrganize.mock.calls[0][0].map((op) => op.destination)).toEqual([
      '/Users/alex/Sorted/Finance/Invoice.pdf',
      '/Users/alex/Sorted/Finance/Invoice_1.pdf',
      '/Users/alex/Sorted/Finance/Invoice_2.pdf',
      '/Users/alex/Sorted/Finance/budget.xlsx'
    ]);
    expect(plan.wouldMove.map((item) => Boolean(item.collision))).toEqual([
      false,
      true,
      true,
      false
    ]);
    // Nothing left that would stop the move.
    expect(plan.sameDestination).toEqual([]);
  });

  test('a number never lands on the name another file of the batch is headed for', async () => {
    const first = file('/Users/alex/Downloads/a.pdf', 'Finance', 'Invoice.pdf');
    const second = file('/Users/alex/Downloads/b.pdf', 'Finance', 'Invoice.pdf');
    const named = file('/Users/alex/Downloads/c.pdf', 'Finance', 'Invoice_1.pdf');
    previewBatchOrganize.mockResolvedValue(dryRunPlan([]));

    const { result } = renderHook(() => useOrganization(hookOptions([first, second, named])));
    const plan = await result.current.handlePreviewOrganize();

    expect(previewBatchOrganize.mock.calls[0][0].map((op) => op.destination)).toEqual([
      '/Users/alex/Sorted/Finance/Invoice.pdf',
      '/Users/alex/Sorted/Finance/Invoice_2.pdf',
      '/Users/alex/Sorted/Finance/Invoice_1.pdf'
    ]);
    expect(plan.sameDestination).toEqual([]);
  });

  test('a file already filed under the name keeps it; the newcomer is numbered', async () => {
    const incoming = file('/Users/alex/Downloads/scan.pdf', 'Finance', 'Invoice.pdf');
    const filed = file('/Users/alex/Sorted/Finance/Invoice.pdf', 'Finance', 'Invoice.pdf');
    previewBatchOrganize.mockResolvedValue(dryRunPlan([]));

    const { result } = renderHook(() => useOrganization(hookOptions([incoming, filed])));
    await result.current.handlePreviewOrganize();

    expect(previewBatchOrganize.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        source: incoming.path,
        destination: '/Users/alex/Sorted/Finance/Invoice_1.pdf'
      }),
      expect.objectContaining({
        source: filed.path,
        destination: '/Users/alex/Sorted/Finance/Invoice.pdf'
      })
    ]);
  });

  test('names that differ only in case or accent encoding are numbered apart on Windows', async () => {
    const win = (...parts) => ['C:', 'Users', 'alex', ...parts].join('\\');
    const folder = { id: 'fin', name: 'Finance', path: win('Sorted', 'Finance') };
    // Decomposed accents (as macOS returns them) and composed upper case.
    const first = file(win('Downloads', '1.pdf'), 'Finance', 'Résumé.pdf');
    const second = file(win('Downloads', '2.pdf'), 'Finance', 'RÉSUMÉ.PDF');
    previewBatchOrganize.mockResolvedValue(dryRunPlan([]));

    const { result } = renderHook(() =>
      useOrganization({
        ...hookOptions([first, second]),
        defaultLocation: win('Documents'),
        findSmartFolderForCategory: () => folder,
        smartFolders: [folder]
      })
    );
    const plan = await result.current.handlePreviewOrganize();

    expect(previewBatchOrganize.mock.calls[0][0].map((op) => op.destination)).toEqual([
      win('Sorted', 'Finance', 'Résumé.pdf'),
      win('Sorted', 'Finance', 'RÉSUMÉ_1.PDF')
    ]);
    expect(plan.sameDestination).toEqual([]);
  });

  test('previews only the files it is given', async () => {
    const picked = file('/Users/alex/Downloads/a.pdf', 'Finance');
    const left = file('/Users/alex/Downloads/b.pdf', 'Finance');
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
      useOrganization(hookOptions([file('/Users/alex/Downloads/a.pdf', 'Finance')]))
    );

    await expect(result.current.handlePreviewOrganize()).rejects.toThrow(
      'Batch size exceeds maximum of 1000'
    );
  });

  test('throws when the request itself fails', async () => {
    previewBatchOrganize.mockRejectedValue(new Error('File operations API not available'));

    const { result } = renderHook(() =>
      useOrganization(hookOptions([file('/Users/alex/Downloads/a.pdf', 'Finance')]))
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
