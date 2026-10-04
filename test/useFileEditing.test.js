/**
 * Tests for useFileEditing Hooks
 * Tests file editing, selection, and state display hooks
 */

import { renderHook, act } from '@testing-library/react';

// Mock dependencies
jest.mock('../src/renderer/utils/performance', () => ({
  debounce: (fn) => {
    const debouncedFn = (...args) => fn(...args);
    debouncedFn.cancel = jest.fn();
    return debouncedFn;
  }
}));

describe('useFileEditing hooks', () => {
  let hooks;

  beforeEach(() => {
    // jest.resetModules(); // Removed - breaks React hooks context
    hooks = require('../src/renderer/phases/organize/useFileEditing');
  });

  describe('useFileStateDisplay', () => {
    test('returns pending for unknown file', () => {
      const { result } = renderHook(() => hooks.useFileStateDisplay({}));

      expect(result.current.getFileState('/unknown.txt')).toBe('pending');
    });

    test('returns correct state for known file', () => {
      const fileStates = {
        '/file.txt': { state: 'analyzing' }
      };
      const { result } = renderHook(() => hooks.useFileStateDisplay(fileStates));

      expect(result.current.getFileState('/file.txt')).toBe('analyzing');
    });

    test('getFileStateDisplay returns organized for processed files', () => {
      const { result } = renderHook(() => hooks.useFileStateDisplay({}));

      const display = result.current.getFileStateDisplay('/file.txt', false, true);
      expect(display.label).toBe('Organized');
      expect(display.iconSymbol).toBe('✅');
    });

    test('getFileStateDisplay returns analyzing state', () => {
      const fileStates = { '/file.txt': { state: 'analyzing' } };
      const { result } = renderHook(() => hooks.useFileStateDisplay(fileStates));

      const display = result.current.getFileStateDisplay('/file.txt', false, false);
      expect(display.label).toBe('Analyzing...');
      expect(display.spinning).toBe(true);
    });

    test('getFileStateDisplay returns error state', () => {
      const fileStates = { '/file.txt': { state: 'error' } };
      const { result } = renderHook(() => hooks.useFileStateDisplay(fileStates));

      const display = result.current.getFileStateDisplay('/file.txt', false, false);
      expect(display.label).toBe('Error');
    });

    test('getFileStateDisplay returns ready state with analysis', () => {
      const fileStates = { '/file.txt': { state: 'ready' } };
      const { result } = renderHook(() => hooks.useFileStateDisplay(fileStates));

      const display = result.current.getFileStateDisplay('/file.txt', true, false);
      expect(display.label).toBe('Ready');
    });
  });

  describe('useFileEditing', () => {
    test('initializes with empty editingFiles', () => {
      const { result } = renderHook(() => hooks.useFileEditing());

      expect(result.current.editingFiles).toEqual({});
    });

    test('handleEditFile updates editing state by canonical path', () => {
      const { result } = renderHook(() => hooks.useFileEditing());

      act(() => {
        result.current.handleEditFile('/file.txt', 'suggestedName', 'new-name.txt');
      });

      expect(result.current.editingFiles['/file.txt'].suggestedName).toBe('new-name.txt');
    });

    test('handleEditFile preserves existing edits', () => {
      const { result } = renderHook(() => hooks.useFileEditing());

      act(() => {
        result.current.handleEditFile('/file.txt', 'suggestedName', 'name.txt');
        result.current.handleEditFile('/file.txt', 'category', 'documents');
      });

      expect(result.current.editingFiles['/file.txt'].suggestedName).toBe('name.txt');
      expect(result.current.editingFiles['/file.txt'].category).toBe('documents');
    });

    test('getFileWithEdits returns original file when no edits', () => {
      const { result } = renderHook(() => hooks.useFileEditing());
      const file = { path: '/file.txt', analysis: { suggestedName: 'original.txt' } };

      const edited = result.current.getFileWithEdits(file);

      expect(edited).toBe(file);
    });

    test('getFileWithEdits applies edits to file', () => {
      const { result } = renderHook(() => hooks.useFileEditing());
      const file = {
        path: '/file.txt',
        analysis: { suggestedName: 'original.txt', category: 'old' }
      };

      act(() => {
        result.current.handleEditFile('/file.txt', 'category', 'new-category');
      });

      const edited = result.current.getFileWithEdits(file);

      expect(edited.analysis.category).toBe('new-category');
    });

    test('edits follow the file when the visible list is filtered (SW-15)', () => {
      const { result } = renderHook(() => hooks.useFileEditing());
      const files = [
        { path: '/a.txt', analysis: { category: 'old-a' } },
        { path: '/b.txt', analysis: { category: 'old-b' } },
        { path: '/c.txt', analysis: { category: 'old-c' } }
      ];

      act(() => {
        result.current.handleEditFile('/c.txt', 'category', 'Docs');
      });

      const filtered = [files[2]];
      const edited = result.current.getFileWithEdits(filtered[0], 0);

      expect(edited.analysis.category).toBe('Docs');
      expect(result.current.getFileWithEdits(files[0]).analysis.category).toBe('old-a');
    });
  });

  describe('useFileSelection', () => {
    const files = [{ path: '/a.txt' }, { path: '/b.txt' }, { path: '/c.txt' }];

    test('initializes with empty selection', () => {
      const { result } = renderHook(() => hooks.useFileSelection(files));

      expect(result.current.selectedFiles.size).toBe(0);
    });

    test('toggleFileSelection adds file by canonical path', () => {
      const { result } = renderHook(() => hooks.useFileSelection(files));

      act(() => {
        result.current.toggleFileSelection('/a.txt');
      });

      expect(result.current.selectedFiles.has('/a.txt')).toBe(true);
    });

    test('toggleFileSelection removes file', () => {
      const { result } = renderHook(() => hooks.useFileSelection(files));

      act(() => {
        result.current.toggleFileSelection('/a.txt');
      });

      act(() => {
        result.current.toggleFileSelection('/a.txt');
      });

      expect(result.current.selectedFiles.has('/a.txt')).toBe(false);
    });

    test('selectAllFiles selects all when none selected', () => {
      const { result } = renderHook(() => hooks.useFileSelection(files));

      act(() => {
        result.current.selectAllFiles();
      });

      expect(result.current.selectedFiles.size).toBe(3);
      expect(result.current.selectedFiles.has('/a.txt')).toBe(true);
      expect(result.current.selectedFiles.has('/b.txt')).toBe(true);
      expect(result.current.selectedFiles.has('/c.txt')).toBe(true);
    });

    test('selectAllFiles clears when all selected', () => {
      const { result } = renderHook(() => hooks.useFileSelection(files));

      act(() => {
        result.current.selectAllFiles();
      });

      act(() => {
        result.current.selectAllFiles();
      });

      expect(result.current.selectedFiles.size).toBe(0);
    });

    test('clearSelection clears all selections', () => {
      const { result } = renderHook(() => hooks.useFileSelection(files));

      act(() => {
        result.current.toggleFileSelection('/a.txt');
        result.current.toggleFileSelection('/b.txt');
        result.current.clearSelection();
      });

      expect(result.current.selectedFiles.size).toBe(0);
    });

    test('preview filter uses path keys, not missing file.id (SW-10)', () => {
      const { result } = renderHook(() => hooks.useFileSelection(files));

      act(() => {
        result.current.toggleFileSelection('/b.txt');
      });

      const preview = files.filter((f) => result.current.selectedFiles.has(f.path));
      expect(preview).toEqual([files[1]]);
      expect(files.filter((f) => result.current.selectedFiles.has(f.id))).toEqual([]);
    });

    test('prunes selection when the list shrinks (SW-81)', () => {
      const { result, rerender } = renderHook(({ list }) => hooks.useFileSelection(list), {
        initialProps: { list: files }
      });

      act(() => {
        result.current.toggleFileSelection('/a.txt');
        result.current.toggleFileSelection('/c.txt');
      });

      rerender({ list: [files[0]] });

      expect(result.current.selectedFiles.has('/a.txt')).toBe(true);
      expect(result.current.selectedFiles.has('/c.txt')).toBe(false);
      expect(result.current.selectedFiles.size).toBe(1);
    });
  });

  describe('useProcessedFiles', () => {
    test('initializes with empty processedFileIds', () => {
      const { result } = renderHook(() => hooks.useProcessedFiles([]));

      expect(result.current.processedFileIds.size).toBe(0);
    });

    test('markFilesAsProcessed adds file paths', () => {
      const { result } = renderHook(() => hooks.useProcessedFiles([]));

      act(() => {
        result.current.markFilesAsProcessed(['/file1.txt', '/file2.txt']);
      });

      expect(result.current.processedFileIds.has('/file1.txt')).toBe(true);
      expect(result.current.processedFileIds.has('/file2.txt')).toBe(true);
    });

    test('unmarkFilesAsProcessed removes file paths', () => {
      const { result } = renderHook(() => hooks.useProcessedFiles([]));

      act(() => {
        result.current.markFilesAsProcessed(['/file1.txt', '/file2.txt']);
        result.current.unmarkFilesAsProcessed(['/file1.txt']);
      });

      expect(result.current.processedFileIds.has('/file1.txt')).toBe(false);
      expect(result.current.processedFileIds.has('/file2.txt')).toBe(true);
    });

    test('getFilteredFiles separates processed and unprocessed', () => {
      const organizedFiles = [{ originalPath: '/file1.txt' }, { originalPath: '/file2.txt' }];
      const { result } = renderHook(() => hooks.useProcessedFiles(organizedFiles));

      const filesWithAnalysis = [
        { path: '/file1.txt', analysis: {} },
        { path: '/file2.txt', analysis: {} },
        { path: '/file3.txt', analysis: {} }
      ];

      act(() => {
        result.current.markFilesAsProcessed(['/file1.txt']);
      });

      const { unprocessedFiles, processedFiles } =
        result.current.getFilteredFiles(filesWithAnalysis);

      expect(unprocessedFiles.length).toBe(2);
      expect(processedFiles.length).toBe(1);
    });

    test('getFilteredFiles treats file as processed when analysis path is post-move only', () => {
      const organizedFiles = [
        { originalPath: '/src/file1.txt', path: '/dest/file1.txt', currentPath: '/dest/file1.txt' }
      ];
      const { result } = renderHook(() => hooks.useProcessedFiles(organizedFiles));

      const filesWithAnalysis = [{ path: '/dest/file1.txt', analysis: {} }];

      act(() => {
        result.current.markFilesAsProcessed(['/src/file1.txt', '/dest/file1.txt']);
      });

      const { unprocessedFiles, processedFiles } =
        result.current.getFilteredFiles(filesWithAnalysis);

      expect(unprocessedFiles.length).toBe(0);
      expect(processedFiles.length).toBe(1);
    });

    test('getFilteredFiles filters out files without analysis', () => {
      const { result } = renderHook(() => hooks.useProcessedFiles([]));

      const filesWithAnalysis = [
        { path: '/file1.txt', analysis: {} },
        { path: '/file2.txt' } // No analysis
      ];

      const { unprocessedFiles } = result.current.getFilteredFiles(filesWithAnalysis);

      expect(unprocessedFiles.length).toBe(1);
    });
  });
});
