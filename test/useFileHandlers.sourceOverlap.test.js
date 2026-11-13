/**
 * useFileHandlers warns (never blocks) when the folder picked for sorting
 * overlaps a Smart Folder, where sorted files go.
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
