/**
 * Tests for Files Slice
 * Tests Redux slice for file selection and management
 */

import filesReducer, {
  setSelectedFiles,
  addSelectedFiles,
  removeSelectedFile,
  removeSelectedFiles,
  updateFileState,
  setFileStates,
  mergeFileStates,
  setSmartFolders,
  addSmartFolder,
  setOrganizedFiles,
  addOrganizedFiles,
  removeOrganizedFiles,
  releaseOrganizedPaths,
  setNamingConvention,
  clearFiles,
  resetFilesState,
  updateFilePathsAfterMove,
  fetchSmartFolders
} from '../src/renderer/store/slices/filesSlice';
import { selectFilesWithAnalysis } from '../src/renderer/store/selectors';

describe('filesSlice', () => {
  const initialState = {
    selectedFiles: [],
    smartFolders: [],
    smartFoldersLoaded: false,
    smartFoldersLoading: false,
    smartFoldersError: null,
    organizedFiles: [],
    organizedPathIndex: [],
    fileStates: {},
    namingConvention: {
      convention: 'subject-date',
      dateFormat: 'YYYY-MM-DD',
      caseConvention: 'kebab-case',
      separator: '-'
    }
  };

  describe('initial state', () => {
    test('returns initial state', () => {
      const result = filesReducer(undefined, { type: 'unknown' });

      expect(result.selectedFiles).toEqual([]);
      expect(result.smartFolders).toEqual([]);
      expect(result.fileStates).toEqual({});
    });
  });

  describe('setSelectedFiles', () => {
    test('sets selected files', () => {
      const files = [
        { path: '/file1.pdf', name: 'file1.pdf' },
        { path: '/file2.pdf', name: 'file2.pdf' }
      ];

      const result = filesReducer(initialState, setSelectedFiles(files));

      expect(result.selectedFiles).toHaveLength(2);
      expect(result.selectedFiles[0].path).toBe('/file1.pdf');
    });

    test('serializes Date objects', () => {
      const files = [
        {
          path: '/file.pdf',
          created: new Date('2024-01-01'),
          modified: new Date('2024-01-02')
        }
      ];

      const result = filesReducer(initialState, setSelectedFiles(files));

      expect(typeof result.selectedFiles[0].created).toBe('string');
      expect(result.selectedFiles[0].created).toBe('2024-01-01T00:00:00.000Z');
    });
  });

  describe('addSelectedFiles', () => {
    test('adds new files', () => {
      const state = {
        ...initialState,
        selectedFiles: [{ path: '/file1.pdf' }]
      };
      const newFiles = [{ path: '/file2.pdf' }];

      const result = filesReducer(state, addSelectedFiles(newFiles));

      expect(result.selectedFiles).toHaveLength(2);
    });

    test('filters duplicate files', () => {
      const state = {
        ...initialState,
        selectedFiles: [{ path: '/file1.pdf' }]
      };
      const newFiles = [{ path: '/file1.pdf' }, { path: '/file2.pdf' }];

      const result = filesReducer(state, addSelectedFiles(newFiles));

      expect(result.selectedFiles).toHaveLength(2);
    });
  });

  describe('removeSelectedFiles', () => {
    test('removes multiple files by path and cleans fileStates', () => {
      const state = {
        ...initialState,
        selectedFiles: [{ path: '/file1.pdf' }, { path: '/file2.pdf' }, { path: '/file3.pdf' }],
        fileStates: {
          '/file1.pdf': { state: 'ready' },
          '/file2.pdf': { state: 'analyzing' }
        }
      };

      const result = filesReducer(state, removeSelectedFiles(['/file1.pdf', '/file3.pdf']));

      expect(result.selectedFiles).toHaveLength(1);
      expect(result.selectedFiles[0].path).toBe('/file2.pdf');
      expect(result.fileStates['/file1.pdf']).toBeUndefined();
      expect(result.fileStates['/file2.pdf']).toBeDefined();
    });

    test('ignores non-array payload', () => {
      const state = { ...initialState, selectedFiles: [{ path: '/a.pdf' }] };
      const result = filesReducer(state, removeSelectedFiles(null));
      expect(result.selectedFiles).toHaveLength(1);
    });

    test('removes Windows paths with mixed separators/casing', () => {
      const state = {
        ...initialState,
        selectedFiles: [{ path: 'C:/Docs/Report.PDF' }],
        fileStates: {
          'c:\\docs\\report.pdf': { state: 'ready' }
        }
      };

      const result = filesReducer(state, removeSelectedFiles(['C:\\DOCS\\report.pdf']));
      expect(result.selectedFiles).toHaveLength(0);
      expect(result.fileStates['c:\\docs\\report.pdf']).toBeUndefined();
    });
  });

  describe('removeSelectedFile', () => {
    test('removes file by path', () => {
      const state = {
        ...initialState,
        selectedFiles: [{ path: '/file1.pdf' }, { path: '/file2.pdf' }],
        fileStates: {
          '/file1.pdf': { state: 'ready' }
        }
      };

      const result = filesReducer(state, removeSelectedFile('/file1.pdf'));

      expect(result.selectedFiles).toHaveLength(1);
      expect(result.selectedFiles[0].path).toBe('/file2.pdf');
      expect(result.fileStates['/file1.pdf']).toBeUndefined();
    });
  });

  describe('updateFileState', () => {
    test('updates file state', () => {
      const result = filesReducer(
        initialState,
        updateFileState({
          path: '/file.pdf',
          state: 'analyzing',
          metadata: { progress: 50 }
        })
      );

      expect(result.fileStates['/file.pdf'].state).toBe('analyzing');
      expect(result.fileStates['/file.pdf'].progress).toBe(50);
      expect(result.fileStates['/file.pdf'].timestamp).toBeDefined();
    });

    // Fast path: when the exact key already exists (a file cycling
    // discovering -> analyzing -> done under one path), it is reused in place
    // and no second entry appears.
    test('reuses the exact key when a file cycles state under one path', () => {
      const analyzing = filesReducer(
        initialState,
        updateFileState({ path: '/file.pdf', state: 'analyzing', metadata: { progress: 50 } })
      );
      const done = filesReducer(
        analyzing,
        updateFileState({ path: '/file.pdf', state: 'done', metadata: { progress: 100 } })
      );

      expect(Object.keys(done.fileStates)).toEqual(['/file.pdf']);
      expect(done.fileStates['/file.pdf'].state).toBe('done');
      expect(done.fileStates['/file.pdf'].progress).toBe(100);
    });

    // Slow path: when the exact key is absent but a canonically-equal key
    // (same file, different casing/separators from another IPC source) exists,
    // that key is reused so one file never holds two entries.
    test('dedupes onto a canonically-equal key recorded with different casing/separators', () => {
      const first = filesReducer(
        initialState,
        updateFileState({ path: 'C:\\Docs\\Report.pdf', state: 'analyzing' })
      );
      const second = filesReducer(
        first,
        updateFileState({ path: 'c:/docs/report.pdf', state: 'done' })
      );

      expect(Object.keys(second.fileStates)).toEqual(['C:\\Docs\\Report.pdf']);
      expect(second.fileStates['C:\\Docs\\Report.pdf'].state).toBe('done');
    });
  });

  describe('setFileStates', () => {
    test('replaces all file states', () => {
      const newStates = {
        '/file1.pdf': { state: 'ready' },
        '/file2.pdf': { state: 'error' }
      };

      const result = filesReducer(initialState, setFileStates(newStates));

      expect(result.fileStates).toEqual(newStates);
    });
  });

  // fileStates carry lifecycle metadata only; the heavy `analysis` payload
  // (extractedText etc.) lives canonically in analysisSlice.results. Storing it
  // here too doubled the in-memory/persisted footprint and is never read back,
  // so every fileStates write strips it.
  describe('analysis payload is never stored in fileStates', () => {
    const heavyAnalysis = {
      suggestedName: 'invoice-2026.pdf',
      category: 'finance',
      extractedText: 'x'.repeat(64000)
    };

    test('updateFileState drops analysis but keeps other metadata', () => {
      const result = filesReducer(
        initialState,
        updateFileState({
          path: '/file.pdf',
          state: 'ready',
          metadata: {
            analysis: heavyAnalysis,
            name: 'file.pdf',
            size: 1234,
            analyzedAt: '2026-06-22T00:00:00.000Z'
          }
        })
      );

      const entry = result.fileStates['/file.pdf'];
      expect(entry.analysis).toBeUndefined();
      expect(entry.state).toBe('ready');
      expect(entry.name).toBe('file.pdf');
      expect(entry.size).toBe(1234);
      expect(entry.analyzedAt).toBe('2026-06-22T00:00:00.000Z');
    });

    test('setFileStates drops analysis from every entry', () => {
      const result = filesReducer(
        initialState,
        setFileStates({
          '/a.pdf': { state: 'ready', analysis: heavyAnalysis, name: 'a.pdf' },
          '/b.pdf': { state: 'error', error: 'boom' }
        })
      );

      expect(result.fileStates['/a.pdf'].analysis).toBeUndefined();
      expect(result.fileStates['/a.pdf'].state).toBe('ready');
      expect(result.fileStates['/a.pdf'].name).toBe('a.pdf');
      expect(result.fileStates['/b.pdf']).toEqual({ state: 'error', error: 'boom' });
    });

    test('mergeFileStates drops analysis from incoming entries', () => {
      const seeded = {
        ...initialState,
        fileStates: { '/a.pdf': { state: 'pending' } }
      };

      const result = filesReducer(
        seeded,
        mergeFileStates({
          '/b.pdf': { state: 'ready', analysis: heavyAnalysis, name: 'b.pdf' }
        })
      );

      expect(result.fileStates['/a.pdf']).toEqual({ state: 'pending' });
      expect(result.fileStates['/b.pdf'].analysis).toBeUndefined();
      expect(result.fileStates['/b.pdf'].state).toBe('ready');
      expect(result.fileStates['/b.pdf'].name).toBe('b.pdf');
    });
  });

  describe('setSmartFolders', () => {
    test('sets smart folders', () => {
      const folders = [{ id: '1', name: 'Documents', path: '/docs' }];

      const result = filesReducer(initialState, setSmartFolders(folders));

      expect(result.smartFolders).toHaveLength(1);
      expect(result.smartFolders[0].name).toBe('Documents');
    });
  });

  describe('addSmartFolder', () => {
    test('adds a smart folder', () => {
      const folder = { id: '1', name: 'New Folder' };

      const result = filesReducer(initialState, addSmartFolder(folder));

      expect(result.smartFolders).toHaveLength(1);
    });
  });

  describe('setOrganizedFiles', () => {
    test('sets organized files', () => {
      const files = [{ path: '/organized/file.pdf' }];

      const result = filesReducer(initialState, setOrganizedFiles(files));

      expect(result.organizedFiles).toEqual(files);
    });
  });

  describe('addOrganizedFiles', () => {
    test('appends to organized files', () => {
      const state = {
        ...initialState,
        organizedFiles: [{ originalPath: '/old.pdf' }]
      };
      const newFiles = [{ originalPath: '/new.pdf' }];

      const result = filesReducer(state, addOrganizedFiles(newFiles));

      expect(result.organizedFiles).toHaveLength(2);
      expect(result.organizedFiles[1].originalPath).toBe('/new.pdf');
    });

    test('skips re-append when originalPath already exists', () => {
      const state = {
        ...initialState,
        organizedFiles: [
          {
            originalPath: 'C:\\Downloads\\notes.pdf',
            path: 'C:\\Docs\\Research\\notes.pdf'
          }
        ]
      };

      const result = filesReducer(
        state,
        addOrganizedFiles([
          {
            originalPath: 'C:\\Downloads\\notes.pdf',
            path: 'C:\\Docs\\Research\\notes.pdf'
          },
          {
            originalPath: 'C:\\Downloads\\other.pdf',
            path: 'C:\\Docs\\Research\\other.pdf'
          }
        ])
      );

      expect(result.organizedFiles).toHaveLength(2);
      expect(result.organizedFiles.map((f) => f.originalPath)).toEqual([
        'C:\\Downloads\\notes.pdf',
        'C:\\Downloads\\other.pdf'
      ]);
    });

    test('grows organizedPathIndex with original and destination paths', () => {
      const result = filesReducer(
        initialState,
        addOrganizedFiles([
          {
            originalPath: 'C:\\Downloads\\report.pdf',
            path: 'C:\\Docs\\Research\\report.pdf'
          }
        ])
      );

      expect(result.organizedPathIndex).toEqual(
        expect.arrayContaining(['c:/downloads/report.pdf', 'c:/docs/research/report.pdf'])
      );
    });

    test('keeps organizedPathIndex when rich history later shrinks via setOrganizedFiles', () => {
      const withMany = filesReducer(
        initialState,
        addOrganizedFiles([
          { originalPath: '/a.pdf', path: '/dest/a.pdf' },
          { originalPath: '/b.pdf', path: '/dest/b.pdf' },
          { originalPath: '/c.pdf', path: '/dest/c.pdf' }
        ])
      );

      // Persistence / UI may keep only the recent rich history tail.
      const truncated = filesReducer(
        withMany,
        setOrganizedFiles([{ originalPath: '/c.pdf', path: '/dest/c.pdf' }])
      );

      expect(truncated.organizedFiles).toHaveLength(1);
      expect(truncated.organizedPathIndex).toEqual(
        expect.arrayContaining([
          '/a.pdf',
          '/dest/a.pdf',
          '/b.pdf',
          '/dest/b.pdf',
          '/c.pdf',
          '/dest/c.pdf'
        ])
      );
    });
  });

  describe('removeOrganizedFiles', () => {
    test('removes organized files by path', () => {
      const state = {
        ...initialState,
        organizedFiles: [{ originalPath: 'C:/docs/a.pdf' }, { originalPath: 'C:/docs/b.pdf' }]
      };

      const result = filesReducer(state, removeOrganizedFiles(['C:\\docs\\a.pdf']));

      expect(result.organizedFiles).toHaveLength(1);
      expect(result.organizedFiles[0].originalPath).toBe('C:/docs/b.pdf');
    });

    test('ignores non-array payload', () => {
      const state = {
        ...initialState,
        organizedFiles: [{ originalPath: '/a.pdf' }]
      };
      const result = filesReducer(state, removeOrganizedFiles(null));
      expect(result.organizedFiles).toHaveLength(1);
    });

    test('removes matching keys from organizedPathIndex on undo', () => {
      const state = {
        ...initialState,
        organizedFiles: [
          { originalPath: 'C:/docs/a.pdf', path: 'C:/out/a.pdf' },
          { originalPath: 'C:/docs/b.pdf', path: 'C:/out/b.pdf' }
        ],
        organizedPathIndex: ['c:/docs/a.pdf', 'c:/out/a.pdf', 'c:/docs/b.pdf', 'c:/out/b.pdf']
      };

      const result = filesReducer(state, removeOrganizedFiles(['C:\\docs\\a.pdf']));

      expect(result.organizedPathIndex).toEqual(['c:/docs/b.pdf', 'c:/out/b.pdf']);
    });
  });

  describe('setNamingConvention', () => {
    test('updates naming convention', () => {
      const result = filesReducer(
        initialState,
        setNamingConvention({
          convention: 'date-subject',
          separator: '_'
        })
      );

      expect(result.namingConvention.convention).toBe('date-subject');
      expect(result.namingConvention.separator).toBe('_');
      // Other values should be preserved
      expect(result.namingConvention.dateFormat).toBe('YYYY-MM-DD');
    });
  });

  describe('clearFiles', () => {
    test('clears selected files and states', () => {
      const state = {
        ...initialState,
        selectedFiles: [{ path: '/file.pdf' }],
        fileStates: { '/file.pdf': { state: 'ready' } }
      };

      const result = filesReducer(state, clearFiles());

      expect(result.selectedFiles).toEqual([]);
      expect(result.fileStates).toEqual({});
    });
  });

  describe('releaseOrganizedPaths (H4)', () => {
    const organizeAtoB = () => {
      let state = filesReducer(
        { ...initialState, selectedFiles: [{ path: 'C:\\Downloads\\invoice.pdf' }] },
        addOrganizedFiles([
          { originalPath: 'C:\\Downloads\\invoice.pdf', path: 'C:\\Finance\\invoice.pdf' }
        ])
      );
      state = filesReducer(
        state,
        updateFilePathsAfterMove({
          oldPaths: ['C:\\Downloads\\invoice.pdf'],
          newPaths: ['C:\\Finance\\invoice.pdf']
        })
      );
      return state;
    };

    test('re-selecting the original path makes it visible again in selectFilesWithAnalysis', () => {
      let files = organizeAtoB();
      const newInvoice = { path: 'C:\\Downloads\\invoice.pdf', name: 'invoice.pdf' };

      // Hidden before release: the durable index still holds the original key.
      const hiddenState = {
        files: filesReducer(files, addSelectedFiles([newInvoice])),
        analysis: { results: [] },
        ui: { resetCounter: 0 }
      };
      expect(selectFilesWithAnalysis(hiddenState).map((f) => f.path)).toEqual([]);

      files = filesReducer(files, releaseOrganizedPaths([newInvoice.path]));
      files = filesReducer(files, addSelectedFiles([newInvoice]));
      const visible = selectFilesWithAnalysis({
        files,
        analysis: { results: [] },
        ui: { resetCounter: 1 }
      });

      expect(visible.map((f) => f.path)).toEqual(['C:\\Downloads\\invoice.pdf']);
      expect(files.organizedPathIndex).toEqual(['c:/finance/invoice.pdf']);
      expect(files.organizedFiles).toEqual([]);
    });

    test('keeps the untouched side of the move organized', () => {
      const files = filesReducer(
        organizeAtoB(),
        releaseOrganizedPaths(['C:\\Downloads\\invoice.pdf'])
      );
      const visible = selectFilesWithAnalysis({
        files,
        analysis: { results: [] },
        ui: { resetCounter: 2 }
      });
      // Destination row remapped into the queue stays hidden — it is still organized.
      expect(visible).toEqual([]);
    });

    test('ignores empty / unknown payloads', () => {
      const state = organizeAtoB();
      expect(filesReducer(state, releaseOrganizedPaths(undefined))).toBe(state);
      const untouched = filesReducer(state, releaseOrganizedPaths(['C:\\Other\\x.pdf']));
      expect(untouched.organizedPathIndex).toEqual(state.organizedPathIndex);
      expect(untouched.organizedFiles).toEqual(state.organizedFiles);
    });
  });

  describe('resetFilesState', () => {
    test('clears session files but preserves smartFolders and organizedPathIndex (SW-31)', () => {
      const folders = [{ id: '1', name: 'Docs' }];
      const index = ['/organized/a.pdf'];
      const state = {
        ...initialState,
        selectedFiles: [{ path: '/file.pdf' }],
        fileStates: { '/file.pdf': { state: 'ready' } },
        smartFolders: folders,
        smartFoldersLoaded: true,
        smartFoldersLoading: false,
        smartFoldersError: null,
        organizedPathIndex: index
      };

      const result = filesReducer(state, resetFilesState());

      expect(result.selectedFiles).toEqual([]);
      expect(result.fileStates).toEqual({});
      expect(result.organizedFiles).toEqual([]);
      expect(result.smartFolders).toEqual(folders);
      expect(result.smartFoldersLoaded).toBe(true);
      expect(result.smartFoldersLoading).toBe(false);
      expect(result.smartFoldersError).toBeNull();
      expect(result.organizedPathIndex).toEqual(index);
    });
  });

  describe('updateFilePathsAfterMove', () => {
    test('updates selectedFiles and fileStates paths', () => {
      const state = {
        ...initialState,
        selectedFiles: [{ path: '/old/a.pdf', name: 'a.pdf' }],
        fileStates: { '/old/a.pdf': { state: 'ready' } }
      };

      const result = filesReducer(
        state,
        updateFilePathsAfterMove({
          oldPaths: ['/old/a.pdf'],
          newPaths: ['/new/a.pdf']
        })
      );

      expect(result.selectedFiles[0].path).toBe('/new/a.pdf');
      expect(result.fileStates['/new/a.pdf']).toBeDefined();
      expect(result.fileStates['/old/a.pdf']).toBeUndefined();
    });

    test('does not mutate state when array lengths differ', () => {
      const state = {
        ...initialState,
        selectedFiles: [{ path: '/old/a.pdf' }, { path: '/old/b.pdf' }]
      };

      const result = filesReducer(
        state,
        updateFilePathsAfterMove({
          oldPaths: ['/old/a.pdf', '/old/b.pdf'],
          newPaths: ['/new/a.pdf']
        })
      );

      expect(result.selectedFiles[0].path).toBe('/old/a.pdf');
      expect(result.selectedFiles[1].path).toBe('/old/b.pdf');
    });

    test('returns unchanged when payload arrays invalid', () => {
      const state = { ...initialState, selectedFiles: [{ path: '/a.pdf' }] };
      const result = filesReducer(
        state,
        updateFilePathsAfterMove({
          oldPaths: 'not-array',
          newPaths: ['/new.pdf']
        })
      );
      expect(result.selectedFiles[0].path).toBe('/a.pdf');
    });

    test('updates Windows path variants with canonical matching', () => {
      const state = {
        ...initialState,
        selectedFiles: [{ path: 'C:/Old/A.PDF', name: 'A.PDF' }],
        fileStates: { 'c:\\old\\a.pdf': { state: 'ready' } }
      };
      const result = filesReducer(
        state,
        updateFilePathsAfterMove({
          oldPaths: ['C:\\OLD\\A.pdf'],
          newPaths: ['C:\\new\\A.pdf']
        })
      );

      expect(result.selectedFiles[0].path).toBe('C:\\new\\A.pdf');
      expect(result.fileStates['C:\\new\\A.pdf']).toBeDefined();
      expect(result.fileStates['c:\\old\\a.pdf']).toBeUndefined();
    });

    test('keeps organizedFiles path and currentPath aligned on remap', () => {
      const state = {
        ...initialState,
        organizedFiles: [
          {
            originalPath: '/old/a.pdf',
            path: '/first/a.pdf',
            currentPath: '/first/a.pdf'
          }
        ]
      };
      const result = filesReducer(
        state,
        updateFilePathsAfterMove({
          oldPaths: ['/first/a.pdf'],
          newPaths: ['/second/a.pdf']
        })
      );

      expect(result.organizedFiles[0].currentPath).toBe('/second/a.pdf');
      expect(result.organizedFiles[0].path).toBe('/second/a.pdf');
    });

    test('dedupes selectedFiles when remap lands on an already-selected path', () => {
      const state = {
        ...initialState,
        selectedFiles: [
          { path: 'C:\\Downloads\\notes.pdf', name: 'notes.pdf' },
          { path: 'C:\\Documents\\Research\\notes.pdf', name: 'notes.pdf' }
        ]
      };

      const result = filesReducer(
        state,
        updateFilePathsAfterMove({
          oldPaths: ['C:\\Downloads\\notes.pdf'],
          newPaths: ['C:\\Documents\\Research\\notes.pdf']
        })
      );

      expect(result.selectedFiles).toHaveLength(1);
      expect(result.selectedFiles[0].path).toBe('C:\\Documents\\Research\\notes.pdf');
    });

    test('does not re-index restored originals after organize then undo', () => {
      const organized = filesReducer(
        initialState,
        addOrganizedFiles([
          { originalPath: 'C:\\Downloads\\report.pdf', path: 'C:\\Docs\\report.pdf' }
        ])
      );

      const afterUndoRemove = filesReducer(
        organized,
        removeOrganizedFiles(['C:\\Downloads\\report.pdf'])
      );
      const afterPathRemap = filesReducer(
        afterUndoRemove,
        updateFilePathsAfterMove({
          oldPaths: ['C:\\Docs\\report.pdf'],
          newPaths: ['C:\\Downloads\\report.pdf']
        })
      );

      expect(afterPathRemap.organizedPathIndex).toEqual([]);
      expect(afterPathRemap.organizedFiles).toHaveLength(0);
    });
  });

  describe('fetchSmartFolders', () => {
    test('sets loading state on pending', () => {
      const result = filesReducer(initialState, {
        type: fetchSmartFolders.pending.type
      });

      expect(result.smartFoldersLoading).toBe(true);
    });

    test('sets folders on fulfilled', () => {
      const folders = [{ id: '1', name: 'Docs' }];

      const result = filesReducer(initialState, {
        type: fetchSmartFolders.fulfilled.type,
        payload: folders
      });

      expect(result.smartFolders).toEqual(folders);
      expect(result.smartFoldersLoading).toBe(false);
    });

    test('clears loading on rejected', () => {
      const state = { ...initialState, smartFoldersLoading: true };

      const result = filesReducer(state, {
        type: fetchSmartFolders.rejected.type
      });

      expect(result.smartFoldersLoading).toBe(false);
    });

    test('sets smartFoldersError on reject', () => {
      const result = filesReducer(initialState, {
        type: fetchSmartFolders.rejected.type,
        payload: 'Network error'
      });

      expect(result.smartFoldersError).toBe('Network error');
    });
  });
});
