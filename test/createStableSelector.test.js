/**
 * Tests for createStableSelector
 * Tests the WeakMap-based caching to prevent race conditions
 */

import {
  selectFilesWithAnalysis,
  selectFileStats,
  LARGE_ARRAY_THRESHOLD
} from '../src/renderer/store/selectors';

describe('createStableSelector', () => {
  describe('organized files excluded from active queue', () => {
    test('does not keep already-moved files as ready-to-organize', () => {
      const state = {
        files: {
          selectedFiles: [
            { path: '/dest/moved.pdf', name: 'moved.pdf' },
            { path: '/inbox/pending.pdf', name: 'pending.pdf' }
          ],
          fileStates: {},
          organizedFiles: [{ originalPath: '/inbox/moved.pdf', path: '/dest/moved.pdf' }],
          organizedPathIndex: ['/inbox/moved.pdf', '/dest/moved.pdf']
        },
        analysis: {
          results: [
            { path: '/dest/moved.pdf', analysis: { category: 'docs' } },
            { path: '/inbox/pending.pdf', analysis: { category: 'docs' } }
          ]
        }
      };

      const files = selectFilesWithAnalysis(state);
      const stats = selectFileStats(state);

      expect(files.map((f) => f.path)).toEqual(['/inbox/pending.pdf']);
      expect(stats.ready).toBe(1);
      expect(stats.total).toBe(1);
    });

    test('collapses duplicate selected paths so Organize cannot render twin keys', () => {
      const state = {
        files: {
          selectedFiles: [
            { path: 'C:\\Documents\\Research\\notes.pdf', name: 'notes.pdf', id: 'a' },
            { path: 'C:\\Documents\\Research\\notes.pdf', name: 'notes.pdf', id: 'b' },
            { path: 'C:\\Downloads\\other.pdf', name: 'other.pdf', id: 'c' }
          ],
          fileStates: {},
          organizedFiles: [],
          organizedPathIndex: []
        },
        analysis: {
          results: [
            {
              path: 'C:\\Documents\\Research\\notes.pdf',
              analysis: { category: 'Research' }
            },
            { path: 'C:\\Downloads\\other.pdf', analysis: { category: 'Work' } }
          ]
        }
      };

      const files = selectFilesWithAnalysis(state);

      expect(files).toHaveLength(2);
      expect(files.map((f) => f.path)).toEqual([
        'C:\\Documents\\Research\\notes.pdf',
        'C:\\Downloads\\other.pdf'
      ]);
    });
  });

  describe('Reference Stability', () => {
    test('returns same reference when array contents are unchanged', () => {
      const state = {
        files: {
          selectedFiles: [
            { path: '/file1.pdf', name: 'file1.pdf' },
            { path: '/file2.pdf', name: 'file2.pdf' }
          ],
          fileStates: {},
          organizedPathIndex: []
        },
        analysis: {
          results: [
            { path: '/file1.pdf', analysis: { category: 'docs' } },
            { path: '/file2.pdf', analysis: { category: 'images' } }
          ]
        }
      };

      const result1 = selectFilesWithAnalysis(state);
      const result2 = selectFilesWithAnalysis(state);

      // Same input should return same reference
      expect(result1).toBe(result2);
    });

    test('returns new reference when array contents change', () => {
      const state1 = {
        files: {
          selectedFiles: [{ path: '/file1.pdf', name: 'file1.pdf' }],
          fileStates: {}
        },
        analysis: {
          results: [{ path: '/file1.pdf', analysis: { category: 'docs' } }]
        }
      };

      const state2 = {
        files: {
          selectedFiles: [
            { path: '/file1.pdf', name: 'file1.pdf' },
            { path: '/file2.pdf', name: 'file2.pdf' }
          ],
          fileStates: {}
        },
        analysis: {
          results: [
            { path: '/file1.pdf', analysis: { category: 'docs' } },
            { path: '/file2.pdf', analysis: { category: 'images' } }
          ]
        }
      };

      const result1 = selectFilesWithAnalysis(state1);
      const result2 = selectFilesWithAnalysis(state2);

      // Different input should return different reference
      expect(result1).not.toBe(result2);
    });

    test('returns same object reference when object properties unchanged', () => {
      const state = {
        files: {
          selectedFiles: [{ path: '/file1.pdf' }],
          fileStates: {}
        },
        analysis: {
          results: [{ path: '/file1.pdf', analysis: { category: 'docs' } }]
        }
      };

      const result1 = selectFileStats(state);
      const result2 = selectFileStats(state);

      // Same input should return same reference for object results
      expect(result1).toBe(result2);
    });
  });

  describe('WeakMap Cache Isolation', () => {
    test('different state objects get independent caches', () => {
      // State A with 1 ready file
      const stateA = {
        files: {
          selectedFiles: [{ path: '/a.pdf' }],
          fileStates: {}
        },
        analysis: {
          results: [{ path: '/a.pdf', analysis: { category: 'docs' } }]
        }
      };

      // State B with 2 ready files
      const stateB = {
        files: {
          selectedFiles: [{ path: '/b1.pdf' }, { path: '/b2.pdf' }],
          fileStates: {}
        },
        analysis: {
          results: [
            { path: '/b1.pdf', analysis: { category: 'docs' } },
            { path: '/b2.pdf', analysis: { category: 'images' } }
          ]
        }
      };

      // Call selector with both states
      const resultA1 = selectFilesWithAnalysis(stateA);
      const resultB1 = selectFilesWithAnalysis(stateB);
      const resultA2 = selectFilesWithAnalysis(stateA);
      const resultB2 = selectFilesWithAnalysis(stateB);

      // Each state should get its own cached result
      expect(resultA1.length).toBe(1);
      expect(resultB1.length).toBe(2);
      expect(resultA1).toBe(resultA2);
      expect(resultB1).toBe(resultB2);
    });

    test('concurrent calls with same state return same reference', async () => {
      const state = {
        files: {
          selectedFiles: [{ path: '/file.pdf' }],
          fileStates: {}
        },
        analysis: {
          results: [{ path: '/file.pdf', analysis: { category: 'docs' } }]
        }
      };

      // Simulate concurrent calls
      const results = await Promise.all([
        Promise.resolve(selectFilesWithAnalysis(state)),
        Promise.resolve(selectFilesWithAnalysis(state)),
        Promise.resolve(selectFilesWithAnalysis(state))
      ]);

      // All should return the same reference
      expect(results[0]).toBe(results[1]);
      expect(results[1]).toBe(results[2]);
    });
  });

  describe('Shallow Comparison', () => {
    test('array with same items returns cached reference', () => {
      const file1 = { path: '/file1.pdf', analysis: { category: 'a' } };
      const file2 = { path: '/file2.pdf', analysis: { category: 'b' } };

      const state = {
        files: {
          selectedFiles: [file1, file2],
          fileStates: {}
        },
        analysis: {
          results: [
            { path: '/file1.pdf', analysis: { category: 'a' } },
            { path: '/file2.pdf', analysis: { category: 'b' } }
          ]
        }
      };

      const result1 = selectFilesWithAnalysis(state);
      const result2 = selectFilesWithAnalysis(state);

      expect(result1).toBe(result2);
    });

    test('object with same values returns cached reference', () => {
      const state = {
        files: {
          selectedFiles: [{ path: '/file.pdf' }],
          fileStates: {}
        },
        analysis: {
          results: [{ path: '/file.pdf', analysis: { category: 'docs' } }]
        }
      };

      const stats1 = selectFileStats(state);
      const stats2 = selectFileStats(state);

      expect(stats1).toBe(stats2);
      expect(stats1.total).toBe(1);
      expect(stats1.ready).toBe(1);
    });
  });

  describe('Edge Cases', () => {
    test('handles empty arrays', () => {
      const state = {
        files: {
          selectedFiles: [],
          fileStates: {}
        },
        analysis: { results: [] }
      };

      const result1 = selectFilesWithAnalysis(state);
      const result2 = selectFilesWithAnalysis(state);

      expect(result1).toEqual([]);
      expect(result1).toBe(result2);
    });

    test('handles null/undefined gracefully', () => {
      const state = {
        files: {
          selectedFiles: null,
          fileStates: {}
        },
        analysis: { results: null }
      };

      // Should not throw
      expect(() => selectFilesWithAnalysis(state)).not.toThrow();
    });

    test('handles rapid state changes', () => {
      const states = Array.from({ length: 10 }, (_, i) => ({
        files: {
          selectedFiles: [{ path: `/file${i}.pdf` }],
          fileStates: {}
        },
        analysis: {
          results: [{ path: `/file${i}.pdf`, analysis: { category: `cat${i}` } }]
        }
      }));

      // Rapidly switch between states
      const results = states.map((s) => selectFilesWithAnalysis(s));

      // Each state should get correct result
      results.forEach((result, i) => {
        expect(result.length).toBe(1);
        expect(result[0].path).toBe(`/file${i}.pdf`);
      });
    });
  });

  describe('Large Array Memory Protection (C12)', () => {
    test('LARGE_ARRAY_THRESHOLD is exported and equals 1000', () => {
      expect(LARGE_ARRAY_THRESHOLD).toBe(1000);
    });

    test('uses fast-path comparison for arrays exceeding LARGE_ARRAY_THRESHOLD', () => {
      // Build a state with more than LARGE_ARRAY_THRESHOLD ready files.
      // When the same state is called twice, the fast-path (length + first/last identity)
      // should still return a cached reference for stability.
      const count = LARGE_ARRAY_THRESHOLD + 1;
      const selectedFiles = Array.from({ length: count }, (_, i) => ({
        path: `/file${i}.pdf`,
        name: `file${i}.pdf`
      }));
      const results = selectedFiles.map((f) => ({
        path: f.path,
        analysis: { category: 'docs' }
      }));
      const state = {
        files: { selectedFiles, fileStates: {} },
        analysis: { results }
      };

      const result1 = selectFilesWithAnalysis(state);
      const result2 = selectFilesWithAnalysis(state);

      // Both calls should return correct data
      expect(result1.length).toBe(count);
      expect(result2.length).toBe(count);

      // Same state → same reference via fast-path caching
      expect(result1).toBe(result2);
    });

    test('detects changes in large arrays via fast-path comparison', () => {
      // When different states produce different large arrays, they should NOT be cached
      const count = LARGE_ARRAY_THRESHOLD + 1;
      const makeState = (prefix) => {
        const selectedFiles = Array.from({ length: count }, (_, i) => ({
          path: `/${prefix}${i}.pdf`,
          name: `${prefix}${i}.pdf`
        }));
        const results = selectedFiles.map((f) => ({
          path: f.path,
          analysis: { category: 'docs' }
        }));
        return {
          files: { selectedFiles, fileStates: {} },
          analysis: { results }
        };
      };

      const state1 = makeState('file');
      const state2 = makeState('other');

      const result1 = selectFilesWithAnalysis(state1);
      const result2 = selectFilesWithAnalysis(state2);

      expect(result1.length).toBe(count);
      expect(result2.length).toBe(count);
      // Different content → different references
      expect(result1).not.toBe(result2);
    });

    test('does not reuse cache when only middle items change in large arrays', () => {
      const count = LARGE_ARRAY_THRESHOLD + 1;

      const makeReadyFile = (i, pathSuffix = `${i}`) => {
        const analysis = { category: 'docs' };
        return {
          path: `/file${pathSuffix}.pdf`,
          name: `file${pathSuffix}.pdf`,
          extension: '.pdf',
          analysis,
          status: 'pending',
          error: null,
          analyzedAt: null
        };
      };

      const files1 = Array.from({ length: count }, (_, i) => makeReadyFile(i));
      const files2 = [...files1];
      const middleIndex = Math.floor(count / 2);
      files2[middleIndex] = makeReadyFile(middleIndex, `${middleIndex}-updated`);

      const makeState = (selectedFiles) => ({
        files: {
          selectedFiles,
          fileStates: {}
        },
        analysis: {
          // Reuse the same analysis object references so selectFilesWithAnalysis
          // can preserve item identity for unchanged entries.
          results: selectedFiles.map((f) => ({ path: f.path, analysis: f.analysis }))
        }
      });

      const state1 = makeState(files1);
      const state2 = makeState(files2);

      const result1 = selectFilesWithAnalysis(state1);
      const result2 = selectFilesWithAnalysis(state2);

      expect(result1).not.toBe(result2);
      expect(result2[middleIndex].path).toBe(`/file${middleIndex}-updated.pdf`);
      expect(result2[0]).toBe(result1[0]);
      expect(result2[result2.length - 1]).toBe(result1[result1.length - 1]);
    });

    test('still caches arrays at or below LARGE_ARRAY_THRESHOLD', () => {
      const count = LARGE_ARRAY_THRESHOLD;
      const selectedFiles = Array.from({ length: count }, (_, i) => ({
        path: `/cached${i}.pdf`,
        name: `cached${i}.pdf`
      }));
      const results = selectedFiles.map((f) => ({
        path: f.path,
        analysis: { category: 'docs' }
      }));

      const state = {
        files: { selectedFiles, fileStates: {} },
        analysis: { results }
      };

      const result1 = selectFilesWithAnalysis(state);
      const result2 = selectFilesWithAnalysis(state);

      // At the threshold boundary, caching should still work
      expect(result1.length).toBe(count);
      expect(result1).toBe(result2);
    });

    test('transitions between small and large arrays correctly', () => {
      // First, call with a small array to populate lastResult
      const smallState = {
        files: {
          selectedFiles: [{ path: '/small.pdf', name: 'small.pdf' }],
          fileStates: {}
        },
        analysis: {
          results: [{ path: '/small.pdf', analysis: { category: 'docs' } }]
        }
      };

      const smallResult = selectFilesWithAnalysis(smallState);
      expect(smallResult.length).toBe(1);

      // Now call with a large array — lastResult transitions to large array
      const count = LARGE_ARRAY_THRESHOLD + 5;
      const selectedFiles = Array.from({ length: count }, (_, i) => ({
        path: `/large${i}.pdf`,
        name: `large${i}.pdf`
      }));
      const results = selectedFiles.map((f) => ({
        path: f.path,
        analysis: { category: 'docs' }
      }));

      const largeState = {
        files: { selectedFiles, fileStates: {} },
        analysis: { results }
      };

      const largeResult = selectFilesWithAnalysis(largeState);
      expect(largeResult.length).toBe(count);

      // Go back to small state — should still work correctly
      const smallResult2 = selectFilesWithAnalysis(smallState);
      expect(smallResult2.length).toBe(1);
    });
  });
});
