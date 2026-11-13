/**
 * Tests for Redux Selectors
 * Tests memoized selectors for computed state
 */

import {
  selectFilesWithAnalysis,
  selectFileStats,
  selectSelectedFiles,
  selectAnalysisResults,
  selectFileStates,
  selectSmartFolders,
  selectOrganizedCount,
  selectMovedCount,
  selectLastOrganizeRun
} from '../src/renderer/store/selectors';

describe('Redux Selectors', () => {
  // A file whose destination already held an identical copy is removed, not
  // moved; its history entry carries `duplicateRemoval`.
  describe('organized counts', () => {
    const stateWith = (organizedFiles) => ({ files: { organizedFiles } });

    test('selectMovedCount leaves out duplicates that were removed', () => {
      const state = stateWith([
        { path: '/out/a.pdf' },
        { path: '/out/b.pdf', duplicateRemoval: 'trashed' },
        { path: '/out/c.pdf', duplicateRemoval: 'deleted' },
        { path: '/out/d.pdf' }
      ]);

      expect(selectMovedCount(state)).toBe(2);
      expect(selectOrganizedCount(state)).toBe(4);
    });

    test('both counts are 0 without a history', () => {
      expect(selectMovedCount(stateWith(undefined))).toBe(0);
      expect(selectMovedCount(stateWith([]))).toBe(0);
      expect(selectOrganizedCount(stateWith(undefined))).toBe(0);
    });
  });

  describe('selectLastOrganizeRun', () => {
    test('returns the stored summary', () => {
      const summary = { outcome: 'partial', count: 1, headline: 'Moved 1 file' };

      expect(selectLastOrganizeRun({ files: { lastOrganizeRun: summary } })).toBe(summary);
    });

    test('is null before a run, and for state saved before the field existed', () => {
      expect(selectLastOrganizeRun({ files: { lastOrganizeRun: null } })).toBeNull();
      expect(selectLastOrganizeRun({ files: {} })).toBeNull();
      expect(selectLastOrganizeRun({})).toBeNull();
    });
  });

  describe('selectSelectedFiles', () => {
    test('returns selected files', () => {
      const state = {
        files: {
          selectedFiles: [{ path: '/file.pdf' }]
        }
      };

      const result = selectSelectedFiles(state);

      expect(result).toEqual([{ path: '/file.pdf' }]);
    });
  });

  describe('selectAnalysisResults', () => {
    test('returns analysis results', () => {
      const state = {
        analysis: {
          results: [{ path: '/file.pdf', analysis: { category: 'docs' } }]
        }
      };

      const result = selectAnalysisResults(state);

      expect(result).toHaveLength(1);
    });
  });

  describe('selectFileStates', () => {
    test('returns file states', () => {
      const state = {
        files: {
          fileStates: { '/file.pdf': { state: 'ready' } }
        }
      };

      const result = selectFileStates(state);

      expect(result['/file.pdf'].state).toBe('ready');
    });
  });

  describe('selectSmartFolders', () => {
    test('returns smart folders', () => {
      const state = {
        files: {
          smartFolders: [{ id: '1', name: 'Docs' }]
        }
      };

      const result = selectSmartFolders(state);

      expect(result).toHaveLength(1);
    });
  });

  describe('selectFilesWithAnalysis', () => {
    test('merges files with analysis results', () => {
      const state = {
        files: {
          selectedFiles: [
            { path: '/file1.pdf', name: 'file1.pdf' },
            { path: '/file2.pdf', name: 'file2.pdf' }
          ],
          fileStates: {}
        },
        analysis: {
          results: [
            {
              path: '/file1.pdf',
              analysis: { category: 'documents', subject: 'Report' }
            }
          ]
        }
      };

      const result = selectFilesWithAnalysis(state);

      expect(result).toHaveLength(2);
      expect(result[0].analysis).toEqual({ category: 'documents', subject: 'Report' });
      expect(result[1].analysis).toBeNull();
    });

    test('extracts extension from path', () => {
      const state = {
        files: {
          selectedFiles: [{ path: '/docs/report.pdf', name: 'report.pdf' }],
          fileStates: {}
        },
        analysis: { results: [] }
      };

      const result = selectFilesWithAnalysis(state);

      expect(result[0].extension).toBe('.pdf');
    });

    test('preserves existing extension', () => {
      const state = {
        files: {
          selectedFiles: [{ path: '/file.pdf', extension: '.PDF' }],
          fileStates: {}
        },
        analysis: { results: [] }
      };

      const result = selectFilesWithAnalysis(state);

      expect(result[0].extension).toBe('.PDF');
    });

    test('includes error from analysis results', () => {
      const state = {
        files: {
          selectedFiles: [{ path: '/file.pdf' }],
          fileStates: {}
        },
        analysis: {
          results: [{ path: '/file.pdf', error: 'Analysis failed' }]
        }
      };

      const result = selectFilesWithAnalysis(state);

      expect(result[0].error).toBe('Analysis failed');
    });

    test('returns empty array reference for empty files', () => {
      const state = {
        files: { selectedFiles: [], fileStates: {} },
        analysis: { results: [] }
      };

      const result = selectFilesWithAnalysis(state);

      expect(result).toEqual([]);
    });

    test('uses file state from fileStates', () => {
      const state = {
        files: {
          selectedFiles: [{ path: '/file.pdf' }],
          fileStates: { '/file.pdf': { state: 'analyzing' } }
        },
        analysis: { results: [] }
      };

      const result = selectFilesWithAnalysis(state);

      expect(result[0].status).toBe('analyzing');
    });
  });

  describe('selectFileStats', () => {
    test('returns file statistics', () => {
      const state = {
        files: {
          selectedFiles: [{ path: '/file1.pdf' }, { path: '/file2.pdf' }, { path: '/file3.pdf' }],
          fileStates: {},
          organizedFiles: [],
          organizedPathIndex: []
        },
        analysis: {
          results: [
            { path: '/file1.pdf', analysis: { category: 'docs' } },
            { path: '/file2.pdf', error: 'Failed' }
          ]
        },
        ui: { resetCounter: 10 }
      };

      const result = selectFileStats(state);

      expect(result.total).toBe(3);
      expect(result.ready).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.pending).toBe(1);
    });

    test('ready/failed/pending sum to total and exclude organized paths', () => {
      const state = {
        files: {
          selectedFiles: [
            { path: '/inbox/a.pdf', name: 'a.pdf' },
            { path: '/inbox/b.pdf', name: 'b.pdf' },
            { path: '/out/c.pdf', name: 'c.pdf' }
          ],
          fileStates: {},
          organizedFiles: [{ originalPath: '/inbox/c.pdf', path: '/out/c.pdf' }],
          organizedPathIndex: ['/inbox/c.pdf', '/out/c.pdf']
        },
        analysis: {
          results: [
            { path: '/inbox/a.pdf', analysis: { category: 'docs' } },
            { path: '/inbox/b.pdf', error: 'Failed' },
            { path: '/out/c.pdf', analysis: { category: 'docs' } }
          ]
        },
        ui: { resetCounter: 11 }
      };

      const files = selectFilesWithAnalysis(state);
      const stats = selectFileStats(state);

      expect(files.map((f) => f.path)).toEqual(['/inbox/a.pdf', '/inbox/b.pdf']);
      expect(stats.total).toBe(2);
      expect(stats.ready).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.pending).toBe(0);
      expect(stats.ready + stats.failed + stats.pending).toBe(stats.total);
    });

    test('excludes organized destinations from ready even when analysis still points there', () => {
      const state = {
        files: {
          selectedFiles: [{ path: 'C:\\Docs\\moved.pdf', name: 'moved.pdf' }],
          fileStates: { 'C:\\Docs\\moved.pdf': { state: 'ready' } },
          organizedFiles: [],
          organizedPathIndex: ['c:/docs/moved.pdf']
        },
        analysis: {
          results: [{ path: 'C:\\Docs\\moved.pdf', analysis: { category: 'docs' } }]
        },
        ui: { resetCounter: 12 }
      };

      expect(selectFilesWithAnalysis(state)).toEqual([]);
      expect(selectFileStats(state)).toEqual({
        total: 0,
        ready: 0,
        failed: 0,
        pending: 0
      });
    });
  });
});
