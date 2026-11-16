/**
 * A folder picked for sorting that overlaps a Smart Folder (where sorted
 * files go) is sorted only once the user says so. The answer is kept on the
 * Smart Folder (`sourceOverlapOk`); after that, and when no dialog is wired
 * in, the overlap is described in a warning and the folder is sorted.
 */

import { renderHook, act, waitFor } from '@testing-library/react';

// Mock dependencies
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
  ...jest.requireActual('../src/shared/constants')
}));

jest.mock('../src/renderer/phases/discover/namingUtils', () => ({
  extractExtension: jest.fn((name) => {
    if (!name || !name.includes('.')) return '';
    return '.' + name.split('.').pop().toLowerCase();
  }),
  extractFileName: jest.fn((path) => {
    if (!path) return '';
    return path.split(/[\\/]/).pop() || '';
  })
}));

// Mock window.electronAPI
const mockElectronAPI = {
  files: {
    select: jest.fn(),
    selectDirectory: jest.fn(),
    getStats: jest.fn()
  },
  smartFolders: {
    scanStructure: jest.fn()
  }
};

const CATCH_ALL = {
  id: 'u',
  name: 'Strato test Data',
  category: 'uncategorized',
  isDefault: true,
  path: '/P/Strato Input'
};
const GSC = { id: 'g', name: 'GSC', path: '/P/Out/GSC' };

describe('useFileHandlers source overlap warnings', () => {
  let useFileHandlers;
  let mockAddSelectedFiles;
  let mockAddNotification;
  let mockAnalyzeFiles;

  const createOptions = (overrides = {}) => ({
    selectedFiles: [],
    setSelectedFiles: jest.fn(),
    addSelectedFiles: mockAddSelectedFiles,
    updateFileState: jest.fn(),
    addNotification: mockAddNotification,
    analyzeFiles: mockAnalyzeFiles,
    smartFolders: [CATCH_ALL, GSC],
    ...overrides
  });

  const overlapCalls = () =>
    mockAddNotification.mock.calls.filter(([, , , key]) => key === 'source-overlap');

  beforeEach(() => {
    jest.clearAllMocks();
    global.window = global.window || {};
    global.window.electronAPI = mockElectronAPI;
    mockAddSelectedFiles = jest.fn();
    mockAddNotification = jest.fn();
    mockAnalyzeFiles = jest.fn();
    mockElectronAPI.files.getStats.mockResolvedValue({
      size: 0,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      isDirectory: true
    });
    useFileHandlers = require('../src/renderer/phases/discover/useFileHandlers').useFileHandlers;
  });

  test('picking the catch-all folder warns that unmatched files stay there, and still analyzes', async () => {
    mockElectronAPI.files.selectDirectory.mockResolvedValue({
      success: true,
      path: '/P/Strato Input'
    });
    mockElectronAPI.smartFolders.scanStructure.mockResolvedValue({
      files: [{ path: '/P/Strato Input/gsc.xlsx', name: 'gsc.xlsx' }]
    });

    const { result } = renderHook(() => useFileHandlers(createOptions()));
    await act(async () => {
      await result.current.handleFolderSelection();
    });

    expect(overlapCalls()).toHaveLength(1);
    const [message, severity, duration] = overlapCalls()[0];
    expect(message).toContain('fit nowhere else');
    expect(severity).toBe('warning');
    expect(duration).toBe(8000);
    expect(mockAddSelectedFiles).toHaveBeenCalled();
    expect(mockAnalyzeFiles).toHaveBeenCalled();
  });

  test('picking a folder that holds a Smart Folder warns that its files are sorted again', async () => {
    mockElectronAPI.files.selectDirectory.mockResolvedValue({ success: true, path: '/P/Out' });
    mockElectronAPI.smartFolders.scanStructure.mockResolvedValue({
      files: [{ path: '/P/Out/GSC/a.csv', name: 'a.csv' }]
    });

    const { result } = renderHook(() => useFileHandlers(createOptions()));
    await act(async () => {
      await result.current.handleFolderSelection();
    });

    expect(overlapCalls()[0][0]).toBe(
      'This folder holds your Smart Folder "GSC". Files already sorted there will be analyzed and sorted again.'
    );
  });

  test('an unrelated folder gets no warning', async () => {
    mockElectronAPI.files.selectDirectory.mockResolvedValue({ success: true, path: '/P/Inbox' });
    mockElectronAPI.smartFolders.scanStructure.mockResolvedValue({
      files: [{ path: '/P/Inbox/a.csv', name: 'a.csv' }]
    });

    const { result } = renderHook(() => useFileHandlers(createOptions()));
    await act(async () => {
      await result.current.handleFolderSelection();
    });

    expect(overlapCalls()).toHaveLength(0);
    expect(mockAddSelectedFiles).toHaveBeenCalled();
  });

  test('a folder that failed to scan gets only the scan error', async () => {
    mockElectronAPI.files.selectDirectory.mockResolvedValue({
      success: true,
      path: '/P/Strato Input'
    });
    mockElectronAPI.smartFolders.scanStructure.mockResolvedValue({
      success: false,
      error: 'Folder not found'
    });

    const { result } = renderHook(() => useFileHandlers(createOptions()));
    await act(async () => {
      await result.current.handleFolderSelection();
    });

    expect(overlapCalls()).toHaveLength(0);
  });

  test('dropping a folder inside a Smart Folder warns once for that folder', async () => {
    mockElectronAPI.smartFolders.scanStructure.mockResolvedValue({
      files: [{ path: '/P/Out/GSC/raw/a.csv', name: 'a.csv' }]
    });

    const { result } = renderHook(() => useFileHandlers(createOptions()));
    await act(async () => {
      await result.current.handleFileDrop([{ path: '/P/Out/GSC/raw', name: 'raw' }]);
    });

    expect(overlapCalls()).toHaveLength(1);
    expect(overlapCalls()[0][0]).toContain('inside your Smart Folder "GSC"');
    expect(mockAnalyzeFiles).toHaveBeenCalled();
  });

  test('without Smart Folders nothing is compared', async () => {
    mockElectronAPI.files.selectDirectory.mockResolvedValue({
      success: true,
      path: '/P/Strato Input'
    });
    mockElectronAPI.smartFolders.scanStructure.mockResolvedValue({
      files: [{ path: '/P/Strato Input/gsc.xlsx', name: 'gsc.xlsx' }]
    });

    const { result } = renderHook(() =>
      useFileHandlers(createOptions({ smartFolders: undefined }))
    );
    await act(async () => {
      await result.current.handleFolderSelection();
    });

    expect(overlapCalls()).toHaveLength(0);
  });
});

describe('useFileHandlers: sorting a folder that overlaps a Smart Folder needs a choice', () => {
  let useFileHandlers;
  let mockAddSelectedFiles;
  let mockAddNotification;
  let mockAnalyzeFiles;
  let mockShowConfirm;
  let mockRemember;

  const OUT = { id: 'out', name: 'Reports', path: '/Users/alex/Sorted/Reports' };

  const createOptions = (overrides = {}) => ({
    selectedFiles: [],
    setSelectedFiles: jest.fn(),
    addSelectedFiles: mockAddSelectedFiles,
    updateFileState: jest.fn(),
    addNotification: mockAddNotification,
    analyzeFiles: mockAnalyzeFiles,
    smartFolders: [OUT],
    showConfirm: mockShowConfirm,
    rememberSmartFolderChoice: mockRemember,
    ...overrides
  });

  const overlapWarnings = () =>
    mockAddNotification.mock.calls.filter(([, , , key]) => key === 'source-overlap');
  const addedPaths = () =>
    mockAddSelectedFiles.mock.calls.flatMap(([files]) => files.map((f) => f.path));

  const pick = async (options) => {
    const { result } = renderHook(() => useFileHandlers(options));
    await act(async () => {
      await result.current.handleFolderSelection();
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    global.window = global.window || {};
    global.window.electronAPI = mockElectronAPI;
    mockAddSelectedFiles = jest.fn();
    mockAddNotification = jest.fn();
    mockAnalyzeFiles = jest.fn();
    mockShowConfirm = jest.fn();
    mockRemember = jest.fn(async () => true);
    mockElectronAPI.files.getStats.mockResolvedValue({ isDirectory: true });
    mockElectronAPI.files.selectDirectory.mockReset();
    mockElectronAPI.smartFolders.scanStructure.mockReset();
    mockElectronAPI.smartFolders.scanStructure.mockImplementation(async (dir) => ({
      files: [{ path: `${dir}/a.csv`, name: 'a.csv' }]
    }));
    useFileHandlers = require('../src/renderer/phases/discover/useFileHandlers').useFileHandlers;
  });

  test.each([
    ['the Smart Folder itself', '/Users/alex/Sorted/Reports', 'It is also your Smart Folder'],
    [
      'the Smart Folder spelled with a trailing slash',
      '/Users/alex/Sorted/Reports/',
      'It is also your Smart Folder'
    ],
    [
      'the Smart Folder spelled with Windows separators',
      '\\Users\\alex\\Sorted\\Reports',
      'It is also your Smart Folder'
    ],
    ['a folder inside it', '/Users/alex/Sorted/Reports/2026', 'It is inside your Smart Folder'],
    ['a folder that holds it', '/Users/alex/Sorted', 'It holds your Smart Folder']
  ])('picking %s asks first and names both folders', async (_label, picked, relation) => {
    mockElectronAPI.files.selectDirectory.mockResolvedValueOnce({ success: true, path: picked });
    mockShowConfirm.mockResolvedValue(true);

    await pick(createOptions());

    expect(mockShowConfirm).toHaveBeenCalledTimes(1);
    const [{ message, confirmText, cancelText }] = mockShowConfirm.mock.calls[0];
    expect(message).toContain(`You picked ${picked} to sort.`);
    expect(message).toContain(relation);
    expect(message).toContain('"Reports"');
    if (relation !== 'It is also your Smart Folder') {
      expect(message).toContain('at /Users/alex/Sorted/Reports');
    }
    expect(confirmText).toBe('Sort this folder');
    expect(cancelText).toBe('Pick another folder');
    expect(mockAnalyzeFiles).toHaveBeenCalled();
  });

  test('sorting it on purpose is kept on the Smart Folder, so the next pick is not asked', async () => {
    mockElectronAPI.files.selectDirectory.mockResolvedValue({
      success: true,
      path: '/Users/alex/Sorted/Reports'
    });
    mockShowConfirm.mockResolvedValue(true);

    await pick(createOptions());
    expect(mockRemember).toHaveBeenCalledWith(['out'], { sourceOverlapOk: true });

    mockShowConfirm.mockClear();
    await pick(createOptions({ smartFolders: [{ ...OUT, sourceOverlapOk: true }] }));
    expect(mockShowConfirm).not.toHaveBeenCalled();
    // Still said, not asked.
    expect(overlapWarnings()).toHaveLength(1);
  });

  test('"Pick another folder" sorts nothing from that folder and opens the picker again', async () => {
    mockElectronAPI.files.selectDirectory
      .mockResolvedValueOnce({ success: true, path: '/Users/alex/Sorted/Reports' })
      .mockResolvedValueOnce({ success: true, path: '/Users/alex/Inbox' });
    mockShowConfirm.mockResolvedValue(false);

    await pick(createOptions());

    expect(mockElectronAPI.files.selectDirectory).toHaveBeenCalledTimes(2);
    expect(mockRemember).not.toHaveBeenCalled();
    expect(addedPaths()).toEqual(['/Users/alex/Inbox/a.csv']);
  });

  test('closing the picker after declining sorts nothing', async () => {
    mockElectronAPI.files.selectDirectory
      .mockResolvedValueOnce({ success: true, path: '/Users/alex/Sorted/Reports' })
      .mockResolvedValueOnce({ success: false, path: null });
    mockShowConfirm.mockResolvedValue(false);

    await pick(createOptions());

    expect(mockAddSelectedFiles).not.toHaveBeenCalled();
    expect(mockAnalyzeFiles).not.toHaveBeenCalled();
  });

  test('a dropped folder that is declined is skipped; the rest of the drop is sorted', async () => {
    mockShowConfirm.mockResolvedValue(false);
    const { result } = renderHook(() => useFileHandlers(createOptions()));

    await act(async () => {
      await result.current.handleFileDrop([
        { path: '/Users/alex/Sorted/Reports', name: 'Reports' },
        { path: '/Users/alex/Inbox', name: 'Inbox' }
      ]);
    });

    expect(mockShowConfirm).toHaveBeenCalledTimes(1);
    expect(mockShowConfirm.mock.calls[0][0].cancelText).toBe('Skip this folder');
    expect(addedPaths()).toEqual(['/Users/alex/Inbox/a.csv']);
  });

  test('two dropped folders inside one Smart Folder ask once', async () => {
    mockShowConfirm.mockResolvedValue(true);
    const { result } = renderHook(() => useFileHandlers(createOptions()));

    await act(async () => {
      await result.current.handleFileDrop([
        { path: '/Users/alex/Sorted/Reports/2025', name: '2025' },
        { path: '/Users/alex/Sorted/Reports/2026', name: '2026' }
      ]);
    });

    expect(mockShowConfirm).toHaveBeenCalledTimes(1);
  });

  test('a choice that could not be saved still sorts the folder, and says it will ask again', async () => {
    mockElectronAPI.files.selectDirectory.mockResolvedValueOnce({
      success: true,
      path: '/Users/alex/Sorted/Reports'
    });
    mockShowConfirm.mockResolvedValue(true);
    mockRemember.mockResolvedValue(false);

    await pick(createOptions());

    expect(mockAnalyzeFiles).toHaveBeenCalled();
    expect(mockAddNotification).toHaveBeenCalledWith(
      'Your choice was not saved. StratoSort will ask again next time.',
      'warning',
      5000,
      'source-overlap-save'
    );
  });

  test('a folder that only shares a name prefix is not asked about', async () => {
    mockElectronAPI.files.selectDirectory.mockResolvedValueOnce({
      success: true,
      path: '/Users/alex/Sorted/Reports 2'
    });

    await pick(createOptions());

    expect(mockShowConfirm).not.toHaveBeenCalled();
    expect(mockAnalyzeFiles).toHaveBeenCalled();
  });
});
