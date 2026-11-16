/**
 * A folder can be both a folder being sorted and a smart folder files are
 * sent to. A file the plan sends to the folder it is already in used to be
 * renamed there (or left as it was) and counted as moved, with only a notice
 * on screen. Now the user must choose first: leave such files there, or skip
 * them. Move does nothing until they choose, and the choice is kept on the
 * smart folder (`inPlaceFiles`) so the next run does not ask again.
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

const mockPreview = jest.fn();
jest.mock('../src/renderer/components/UndoRedoSystem', () => ({
  createOrganizeBatchAction: jest.fn((label, operations, callbacks, options) => ({
    type: 'organize-batch',
    label,
    operations,
    callbacks,
    options
  })),
  previewBatchOrganize: (...args) => mockPreview(...args)
}));

const {
  findInPlaceMoves,
  applyInPlaceChoices,
  useOrganization
} = require('../src/renderer/phases/organize/useOrganization');

const INPUT_PATH = '/Users/alex/Strato Input';
const input = (extra = {}) => ({ id: 'in', name: 'Strato Input', path: INPUT_PATH, ...extra });
const BING = { id: 'bing', name: 'Bing data', path: '/Users/alex/Sorted/Bing data' };

const file = (path, category) => {
  const name = path.split(/[\\/]/).pop();
  return { path, name, analysis: { category, suggestedName: name } };
};

const staying = file(`${INPUT_PATH}/keywords.csv`, 'Strato Input');
const leaving = file(`${INPUT_PATH}/bing.csv`, 'Bing data');

function options({ smartFolders, unprocessedFiles = [staying, leaving], ...overrides } = {}) {
  const folders = smartFolders || [input(), BING];
  return {
    unprocessedFiles,
    editingFiles: {},
    getFileWithEdits: jest.fn((f) => f),
    findSmartFolderForCategory: jest.fn(
      (label) =>
        folders.find((folder) => folder.name.toLowerCase() === String(label).toLowerCase()) || null
    ),
    defaultLocation: '/Users/alex/Documents',
    smartFolders: folders,
    analysisResults: [],
    markFilesAsProcessed: jest.fn(),
    unmarkFilesAsProcessed: jest.fn(),
    actions: { setPhaseData: jest.fn(), advancePhase: jest.fn() },
    phaseData: { organizedFiles: [] },
    addNotification: jest.fn(),
    dispatch: jest.fn(),
    executeAction: jest.fn(async (action) => {
      const result = {
        success: true,
        results: action.operations.map((op) => ({ success: true, ...op }))
      };
      action?.callbacks?.onExecute?.(result);
      return result;
    }),
    addOrganizedFiles: jest.fn(),
    removeOrganizedFiles: jest.fn(),
    setOrganizingState: jest.fn(),
    setLastOrganizeRun: jest.fn(),
    setLastOrganizeRunFiles: jest.fn(),
    rememberSmartFolderChoice: jest.fn(async () => true),
    ...overrides
  };
}

const sentSources = (opts) =>
  opts.executeAction.mock.calls.flatMap(([action]) => action.operations.map((op) => op.source));

beforeEach(() => {
  jest.clearAllMocks();
  global.window = global.window || {};
  global.window.electronAPI = {
    events: { onOperationProgress: jest.fn(() => jest.fn()) },
    files: { normalizePath: jest.fn((p) => p) }
  };
});

describe('the choice kept on a smart folder', () => {
  const planFor = (smartFolders, files = [staying]) => {
    const { unprocessedFiles: _u, ...inputs } = options({ smartFolders });
    return { ...inputs, files };
  };

  test('is read from the folder, and is null until the user chooses', () => {
    expect(findInPlaceMoves(planFor([input(), BING]))[0].choice).toBeNull();
    expect(findInPlaceMoves(planFor([input({ inPlaceFiles: 'skip' }), BING]))[0].choice).toBe(
      'skip'
    );
    expect(findInPlaceMoves(planFor([input({ inPlaceFiles: 'leave' }), BING]))[0].choice).toBe(
      'leave'
    );
    // Anything else saved there is no choice.
    expect(findInPlaceMoves(planFor([input({ inPlaceFiles: 'yes' }), BING]))[0].choice).toBeNull();
  });

  test('applies to a file however its folder is spelled: separators, case and a trailing slash', () => {
    const folder = {
      id: 'in',
      name: 'Strato Input',
      path: 'c:/users/alex/strato input/',
      inPlaceFiles: 'skip'
    };
    const filed = file('C:\\Users\\Alex\\Strato Input\\a.csv', 'Strato Input');
    const { unprocessedFiles: _u, ...inputs } = options({ smartFolders: [folder] });

    const [move] = findInPlaceMoves({
      ...inputs,
      files: [filed],
      defaultLocation: 'C:\\Users\\Alex\\Documents'
    });
    expect(move).toEqual(expect.objectContaining({ folderId: 'in', choice: 'skip' }));
  });

  test('applies on macOS to a folder name the file system hands back decomposed', () => {
    const folder = {
      id: 'cafe',
      name: 'Café',
      path: '/Users/alex/Cafe\u0301',
      inPlaceFiles: 'leave'
    };
    const filed = file('/Users/alex/Caf\u00e9/menu.pdf', 'Café');
    const { unprocessedFiles: _u, ...inputs } = options({ smartFolders: [folder] });

    const [move] = findInPlaceMoves({ ...inputs, files: [filed] });
    expect(move).toEqual(expect.objectContaining({ folderId: 'cafe', choice: 'leave' }));
  });

  test('a file in a folder inside a smart folder moves up to it, so nothing is asked', () => {
    const nested = file(`${INPUT_PATH}/2026/keywords.csv`, 'Strato Input');
    expect(findInPlaceMoves(planFor([input(), BING], [nested]))).toEqual([]);
  });

  test('a choice made on screen wins until the saved list shows it, and null asks again', () => {
    const moves = findInPlaceMoves(planFor([input({ inPlaceFiles: 'skip' }), BING]));
    const key = moves[0].folderKey;

    expect(applyInPlaceChoices(moves, new Map([[key, 'leave']]))[0].choice).toBe('leave');
    expect(applyInPlaceChoices(moves, new Map([[key, null]]))[0].choice).toBeNull();
    expect(applyInPlaceChoices(moves, new Map([['/elsewhere', 'leave']]))[0].choice).toBe('skip');
  });
});

describe('Move with files that would stay where they are', () => {
  async function move(opts) {
    const rendered = renderHook(() => useOrganization(opts));
    await act(async () => {
      await rendered.result.current.handleOrganizeFiles();
    });
    return rendered;
  }

  test('does nothing until the user chooses, and keeps the last run report', async () => {
    const opts = options();
    await move(opts);

    expect(opts.executeAction).not.toHaveBeenCalled();
    expect(opts.setLastOrganizeRun).not.toHaveBeenCalled();
    expect(opts.setLastOrganizeRunFiles).not.toHaveBeenCalled();
    expect(opts.addNotification).toHaveBeenCalledWith(
      expect.stringContaining('Choose whether to leave them there or skip them'),
      'warning',
      6000,
      'organize-in-place-choice'
    );
  });

  test('a folder chosen as "leave" keeps its files in the run', async () => {
    const opts = options({ smartFolders: [input({ inPlaceFiles: 'leave' }), BING] });
    await move(opts);

    expect(sentSources(opts)).toEqual([staying.path, leaving.path]);
  });

  test('a folder chosen as "skip" leaves its files out of the run; the others move', async () => {
    const opts = options({ smartFolders: [input({ inPlaceFiles: 'skip' }), BING] });
    await move(opts);

    expect(sentSources(opts)).toEqual([leaving.path]);
  });

  test('when every file is skipped nothing runs, and the user is told why', async () => {
    const opts = options({
      smartFolders: [input({ inPlaceFiles: 'skip' }), BING],
      unprocessedFiles: [staying]
    });
    await move(opts);

    expect(opts.executeAction).not.toHaveBeenCalled();
    expect(opts.addNotification).toHaveBeenCalledWith(
      'You chose to skip every one of these files, so nothing was moved.',
      'info',
      4000,
      'organize-in-place-choice'
    );
  });

  test('a queue with no such files moves as before, without asking', async () => {
    const opts = options({ unprocessedFiles: [leaving] });
    await move(opts);

    expect(sentSources(opts)).toEqual([leaving.path]);
  });

  test('choosing on screen unlocks Move at once and is kept on the smart folder', async () => {
    const opts = options();
    const rendered = renderHook(() => useOrganization(opts));
    expect(rendered.result.current.inPlaceMoves[0].choice).toBeNull();

    await act(async () => {
      await rendered.result.current.setInPlaceChoice('skip');
    });

    expect(rendered.result.current.inPlaceMoves[0].choice).toBe('skip');
    expect(opts.rememberSmartFolderChoice).toHaveBeenCalledWith(['in'], { inPlaceFiles: 'skip' });

    await act(async () => {
      await rendered.result.current.handleOrganizeFiles();
    });
    expect(sentSources(opts)).toEqual([leaving.path]);
  });

  test('"change this choice" asks again: Move stops until the user chooses', async () => {
    const opts = options({ smartFolders: [input({ inPlaceFiles: 'leave' }), BING] });
    const rendered = renderHook(() => useOrganization(opts));

    await act(async () => {
      await rendered.result.current.setInPlaceChoice(null);
    });

    expect(rendered.result.current.inPlaceMoves[0].choice).toBeNull();
    expect(opts.rememberSmartFolderChoice).toHaveBeenCalledWith(['in'], { inPlaceFiles: null });
    await act(async () => {
      await rendered.result.current.handleOrganizeFiles();
    });
    expect(opts.executeAction).not.toHaveBeenCalled();
  });

  test('a choice that could not be saved still applies now, and the user is told', async () => {
    const opts = options({ rememberSmartFolderChoice: jest.fn(async () => false) });
    const rendered = renderHook(() => useOrganization(opts));

    await act(async () => {
      await rendered.result.current.setInPlaceChoice('leave');
    });

    expect(rendered.result.current.inPlaceMoves[0].choice).toBe('leave');
    expect(opts.addNotification).toHaveBeenCalledWith(
      'Your choice was not saved. StratoSort will ask again next time.',
      'warning',
      5000,
      'organize-in-place-save'
    );
  });

  test('the preview leaves skipped files out', async () => {
    mockPreview.mockResolvedValue({ success: true, wouldMove: [] });
    const opts = options({ smartFolders: [input({ inPlaceFiles: 'skip' }), BING] });
    const rendered = renderHook(() => useOrganization(opts));

    await act(async () => {
      await rendered.result.current.handlePreviewOrganize();
    });

    const [ops] = mockPreview.mock.calls[0];
    expect(ops.map((op) => op.source)).toEqual([leaving.path]);
  });
});
