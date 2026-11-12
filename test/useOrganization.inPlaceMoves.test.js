/**
 * A folder can be both where files wait and a smart folder files are sent
 * to. A file routed to the folder it is already in is renamed there, or left
 * untouched, and the run still counts it as moved; nothing appears anywhere
 * new. `inPlaceMoves` lists those files before the run so the screen can say
 * so.
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
  createOrganizeBatchAction: jest.fn()
}));

const {
  findInPlaceMoves,
  useOrganization
} = require('../src/renderer/phases/organize/useOrganization');
const { toCanonicalPath } = require('../src/renderer/utils/canonicalPath');

const INPUT = { id: 'in', name: 'Strato Input', path: '/Users/hans/Strato Input' };
const BING = { id: 'bing', name: 'Bing data', path: '/Users/hans/Sorted/Bing data' };

const file = (path, category, suggestedName) => {
  const name = path.split(/[\\/]/).pop();
  return { path, name, analysis: { category, suggestedName: suggestedName || name } };
};

/** Plan inputs the way OrganizePhase passes them, with name matching only. */
function plan(files, { smartFolders = [INPUT, BING], editingFiles = {}, ...rest } = {}) {
  return {
    files,
    editingFiles,
    getFileWithEdits: jest.fn((f) => f),
    findSmartFolderForCategory: jest.fn(
      (label) =>
        smartFolders.find((folder) => folder.name.toLowerCase() === String(label).toLowerCase()) ||
        null
    ),
    defaultLocation: '/Users/hans/Documents',
    smartFolders,
    ...rest
  };
}

describe('findInPlaceMoves', () => {
  beforeEach(() => {
    global.window = global.window || {};
    global.window.electronAPI = { files: { normalizePath: jest.fn((p) => p) } };
  });

  test('lists a file sent to the folder it is in, and says whether it gets a new name', () => {
    const renamed = file('/Users/hans/Strato Input/a.csv', 'Strato Input', 'Keywords 2025.csv');
    const untouched = file('/Users/hans/Strato Input/b.csv', 'Strato Input');

    expect(findInPlaceMoves(plan([renamed, untouched]))).toEqual([
      { sourcePath: renamed.path, fileName: 'a.csv', folderName: 'Strato Input', renamed: true },
      { sourcePath: untouched.path, fileName: 'b.csv', folderName: 'Strato Input', renamed: false }
    ]);
  });

  test('leaves out a file that is sent to another folder', () => {
    const leaving = file('/Users/hans/Strato Input/bing.csv', 'Bing data');
    expect(findInPlaceMoves(plan([leaving]))).toEqual([]);
  });

  test('a file drops out once the user picks another folder on its card', () => {
    const picked = file('/Users/hans/Strato Input/a.csv', 'Strato Input');
    const editingFiles = { [toCanonicalPath(picked.path)]: { category: 'Bing data' } };

    expect(findInPlaceMoves(plan([picked]))).toHaveLength(1);
    expect(findInPlaceMoves(plan([picked], { editingFiles }))).toEqual([]);
  });

  test('a file in a subfolder of a smart folder is moved, so it is not listed', () => {
    const nested = file('/Users/hans/Strato Input/2025/a.csv', 'Strato Input');
    expect(findInPlaceMoves(plan([nested]))).toEqual([]);
  });

  test('does not work out a destination for files outside every smart folder', () => {
    const inputs = plan([file('/Users/hans/Downloads/a.csv', 'Strato Input')]);

    expect(findInPlaceMoves(inputs)).toEqual([]);
    expect(inputs.getFileWithEdits).not.toHaveBeenCalled();
    expect(inputs.findSmartFolderForCategory).not.toHaveBeenCalled();
  });

  test('a smart folder without a path lives under the default location', () => {
    const reports = { id: 'r', name: 'Reports' };
    const filed = file('/Users/hans/Documents/Reports/q3.pdf', 'Reports');

    expect(findInPlaceMoves(plan([filed], { smartFolders: [reports] }))).toEqual([
      { sourcePath: filed.path, fileName: 'q3.pdf', folderName: 'Reports', renamed: false }
    ]);
  });

  test('a file already in Uncategorized that matches no folder stays there', () => {
    const stray = file('/Users/hans/Documents/Uncategorized/notes.txt', 'Recipes');

    expect(findInPlaceMoves(plan([stray]))).toEqual([
      { sourcePath: stray.path, fileName: 'notes.txt', folderName: 'Uncategorized', renamed: false }
    ]);
  });

  test('Windows spellings of one folder match', () => {
    const smartFolders = [{ id: 'in', name: 'Strato Input', path: 'c:/users/hans/strato input/' }];
    const filed = file('C:\\Users\\Hans\\Strato Input\\a.csv', 'Strato Input');

    expect(
      findInPlaceMoves(
        plan([filed], { smartFolders, defaultLocation: 'C:\\Users\\Hans\\Documents' })
      )
    ).toEqual([
      { sourcePath: filed.path, fileName: 'a.csv', folderName: 'Strato Input', renamed: false }
    ]);
  });

  test('nothing to list without files or a default location', () => {
    const filed = file('/Users/hans/Strato Input/a.csv', 'Strato Input');

    expect(findInPlaceMoves(plan(undefined))).toEqual([]);
    expect(findInPlaceMoves(plan([null, {}, { path: 42 }]))).toEqual([]);
    expect(findInPlaceMoves(plan([filed], { defaultLocation: undefined }))).toEqual([]);
    expect(findInPlaceMoves(plan([filed], { defaultLocation: '' }))).toEqual([]);
  });
});

describe('useOrganization: inPlaceMoves', () => {
  const hookOptions = (unprocessedFiles) => {
    const { files: _files, ...inputs } = plan(unprocessedFiles);
    return {
      ...inputs,
      unprocessedFiles,
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
    };
  };

  beforeEach(() => {
    global.window = global.window || {};
    global.window.electronAPI = {
      events: { onOperationProgress: jest.fn(() => jest.fn()) },
      files: { normalizePath: jest.fn((p) => p) }
    };
  });

  test('covers every ready file in the queue, and only ready files', () => {
    const ready = file('/Users/hans/Strato Input/a.csv', 'Strato Input');
    const notAnalyzed = { path: '/Users/hans/Strato Input/b.csv', name: 'b.csv' };
    const leaving = file('/Users/hans/Strato Input/bing.csv', 'Bing data');

    const options = hookOptions([ready, notAnalyzed, leaving]);
    const { result } = renderHook(() => useOrganization(options));

    expect(result.current.inPlaceMoves).toEqual([
      { sourcePath: ready.path, fileName: 'a.csv', folderName: 'Strato Input', renamed: false }
    ]);
  });

  test('is empty when no file stays where it is', () => {
    const options = hookOptions([file('/Users/hans/Downloads/a.csv', 'Bing data')]);
    const { result } = renderHook(() => useOrganization(options));

    expect(result.current.inPlaceMoves).toEqual([]);
  });
});
