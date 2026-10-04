/**
 * Tests for search utility modules:
 *   - graphPathUtils
 *   - graphLayoutUtils
 *   - searchResultUtils
 *   - graphFilterDefaults
 */

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock('../src/renderer/utils/semanticTerms', () => ({
  sanitizeSemanticTerms: jest.fn((terms) => (Array.isArray(terms) ? terms : []))
}));

import {
  normalizeGraphPathKey,
  extractPathFromSemanticId,
  toMetadataObject,
  getMetadataPath,
  getMetadataName,
  nodeDeduplicationKey
} from '../src/renderer/components/search/utils/graphPathUtils';

import {
  getZoomBucket,
  getDefaultGraphFitViewOptions,
  GRAPH_FIT_VIEW_MIN_ZOOM,
  buildUndirectedEdgeKey,
  applyParallelEdgeOffsets,
  EDGE_KIND_PRIORITY
} from '../src/renderer/components/search/utils/graphLayoutUtils';

import {
  getErrorMessage,
  validateSearchResponse,
  getParentFolderName,
  getConnectionReason,
  getFileExtension
} from '../src/renderer/components/search/utils/searchResultUtils';

import {
  getDefaultClusterFilters,
  getDefaultActiveFilters
} from '../src/renderer/components/search/utils/graphFilterDefaults';

import {
  regroupClustersForMode,
  getRecencyBucketKey,
  getRecencyBucketLabel
} from '../src/renderer/components/search/utils/clusterRegroupUtils';

// ─── graphPathUtils ────────────────────────────────────────────────────────────

describe('normalizeGraphPathKey', () => {
  it('lowercases Windows-style paths', () => {
    expect(normalizeGraphPathKey('C:\\Users\\Doc\\File.PDF')).toBe('c:/users/doc/file.pdf');
  });

  it('preserves case for Unix paths', () => {
    expect(normalizeGraphPathKey('/home/user/File.PDF')).toBe('/home/user/File.PDF');
  });

  it('collapses repeated separators', () => {
    expect(normalizeGraphPathKey('/a//b///c')).toBe('/a/b/c');
  });

  it('returns empty string for non-string input', () => {
    expect(normalizeGraphPathKey(null)).toBe('');
    expect(normalizeGraphPathKey(123)).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeGraphPathKey('   ')).toBe('');
  });
});

describe('extractPathFromSemanticId', () => {
  it('strips file: prefix', () => {
    expect(extractPathFromSemanticId('file:/docs/a.pdf')).toBe('/docs/a.pdf');
  });

  it('strips image: prefix (case insensitive)', () => {
    expect(extractPathFromSemanticId('Image:C:\\img\\photo.png')).toBe('C:\\img\\photo.png');
  });

  it('returns empty for bare word without path separators', () => {
    expect(extractPathFromSemanticId('file:justAWord')).toBe('');
  });

  it('returns empty for non-string', () => {
    expect(extractPathFromSemanticId(undefined)).toBe('');
  });
});

describe('toMetadataObject', () => {
  it('unwraps nested .metadata', () => {
    const obj = { metadata: { name: 'a' } };
    expect(toMetadataObject(obj)).toEqual({ name: 'a' });
  });

  it('returns object directly when no .metadata', () => {
    const obj = { name: 'b' };
    expect(toMetadataObject(obj)).toBe(obj);
  });

  it('returns empty object for null/undefined', () => {
    expect(toMetadataObject(null)).toEqual({});
    expect(toMetadataObject(undefined)).toEqual({});
  });
});

describe('getMetadataPath', () => {
  it('returns metadata.path when present', () => {
    expect(getMetadataPath({ metadata: { path: '/a.txt' } })).toBe('/a.txt');
  });

  it('returns metadata.filePath as fallback', () => {
    expect(getMetadataPath({ metadata: { filePath: '/b.txt' } })).toBe('/b.txt');
  });

  it('falls back to extracting path from id', () => {
    expect(getMetadataPath({ id: 'file:/c/d.pdf' })).toBe('/c/d.pdf');
  });

  it('uses fallbackId when no path or id', () => {
    expect(getMetadataPath({}, 'file:/fallback/e.txt')).toBe('/fallback/e.txt');
  });
});

describe('getMetadataName', () => {
  it('returns metadata.name when present', () => {
    expect(getMetadataName({ metadata: { name: 'Doc' } })).toBe('Doc');
  });

  it('falls back to basename of resolved path', () => {
    expect(getMetadataName({ metadata: { path: '/a/file.txt' } })).toBe('file.txt');
  });

  it('returns "Unknown" as last resort', () => {
    expect(getMetadataName({})).toBe('Unknown');
  });
});

describe('nodeDeduplicationKey', () => {
  it('uses normalized path for file nodes', () => {
    const node = { id: 'n1', data: { path: 'C:\\A\\B.pdf', kind: 'file' } };
    expect(nodeDeduplicationKey(node)).toBe(normalizeGraphPathKey('C:\\A\\B.pdf'));
  });

  it('uses id for non-file nodes', () => {
    const node = { id: 'cluster-1', data: { kind: 'cluster' } };
    expect(nodeDeduplicationKey(node)).toBe('cluster-1');
  });

  it('falls back to id when file node has no path', () => {
    const node = { id: 'n2', data: { kind: 'file' } };
    expect(nodeDeduplicationKey(node)).toBe('n2');
  });
});

// ─── graphLayoutUtils ──────────────────────────────────────────────────────────

describe('getDefaultGraphFitViewOptions', () => {
  it('caps fit-view zoom-out at the label visibility threshold', () => {
    const options = getDefaultGraphFitViewOptions();
    expect(options.minZoom).toBe(GRAPH_FIT_VIEW_MIN_ZOOM);
    expect(options.minZoom).toBeGreaterThanOrEqual(0.6);
    expect(options.padding).toBe(0.2);
    expect(options.maxZoom).toBe(1.5);
  });

  it('merges overrides without dropping minZoom default', () => {
    const options = getDefaultGraphFitViewOptions({ duration: 800, padding: 0.3 });
    expect(options.duration).toBe(800);
    expect(options.padding).toBe(0.3);
    expect(options.minZoom).toBe(GRAPH_FIT_VIEW_MIN_ZOOM);
  });
});

describe('getZoomBucket', () => {
  it('returns "far" below 0.6', () => {
    expect(getZoomBucket(0.3)).toBe('far');
    expect(getZoomBucket(0.59)).toBe('far');
  });

  it('returns "mid" between 0.6 and 0.9', () => {
    expect(getZoomBucket(0.6)).toBe('mid');
    expect(getZoomBucket(0.89)).toBe('mid');
  });

  it('returns "near" at 0.9 and above', () => {
    expect(getZoomBucket(0.9)).toBe('near');
    expect(getZoomBucket(2.0)).toBe('near');
  });
});

describe('buildUndirectedEdgeKey', () => {
  it('orders alphabetically', () => {
    expect(buildUndirectedEdgeKey({ source: 'b', target: 'a' })).toBe('a::b');
    expect(buildUndirectedEdgeKey({ source: 'a', target: 'b' })).toBe('a::b');
  });

  it('handles identical source/target', () => {
    expect(buildUndirectedEdgeKey({ source: 'x', target: 'x' })).toBe('x::x');
  });

  it('coerces non-string values', () => {
    expect(buildUndirectedEdgeKey({ source: 1, target: 2 })).toBe('1::2');
  });
});

describe('applyParallelEdgeOffsets', () => {
  it('returns same array when no parallel edges', () => {
    const edges = [
      { id: 'e1', source: 'a', target: 'b', data: {} },
      { id: 'e2', source: 'c', target: 'd', data: {} }
    ];
    const result = applyParallelEdgeOffsets(edges);
    expect(result).toBe(edges); // reference equality – no change needed
  });

  it('assigns offsets to parallel edges between same nodes', () => {
    const edges = [
      { id: 'e1', source: 'a', target: 'b', data: { kind: 'similarity' } },
      { id: 'e2', source: 'a', target: 'b', data: { kind: 'query_match' } }
    ];
    const result = applyParallelEdgeOffsets(edges);
    const offsets = result.map((e) => e.data.parallelOffset);

    expect(offsets[0]).not.toBe(offsets[1]);
    expect(offsets).toContain(-7);
    expect(offsets).toContain(7);
  });

  it('handles empty/null input gracefully', () => {
    expect(applyParallelEdgeOffsets([])).toEqual([]);
    expect(applyParallelEdgeOffsets(null)).toEqual([]);
    expect(applyParallelEdgeOffsets(undefined)).toEqual([]);
  });
});

describe('EDGE_KIND_PRIORITY', () => {
  it('ranks query_match highest (0)', () => {
    expect(EDGE_KIND_PRIORITY.query_match).toBe(0);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(EDGE_KIND_PRIORITY)).toBe(true);
  });
});

// ─── searchResultUtils ─────────────────────────────────────────────────────────

describe('getErrorMessage', () => {
  it('returns connection error message for ECONNREFUSED', () => {
    const result = getErrorMessage({ message: 'ECONNREFUSED' }, 'Search');
    expect(result).toMatch(/Embedding service unavailable/);
  });

  it('returns timeout message', () => {
    const result = getErrorMessage({ message: 'Request timeout' }, 'Search');
    expect(result).toMatch(/timed out/);
  });

  it('returns vector DB message for VECTOR_DB_UNAVAILABLE code', () => {
    const result = getErrorMessage({ code: 'VECTOR_DB_UNAVAILABLE', message: '' });
    expect(result).toMatch(/Knowledge Graph is initializing/);
  });

  it('returns embedding model changed message', () => {
    const result = getErrorMessage({ message: 'Embedding model changed recently' });
    expect(result).toMatch(/rebuild your index/);
  });

  it('falls back to error.message', () => {
    expect(getErrorMessage({ message: 'Custom error' })).toBe('Custom error');
  });

  it('falls back to context + "failed" for empty error', () => {
    expect(getErrorMessage({}, 'MyOp')).toBe('MyOp failed');
  });
});

describe('validateSearchResponse', () => {
  it('rejects null response', () => {
    const result = validateSearchResponse(null);
    expect(result.valid).toBe(false);
  });

  it('rejects response with success !== true', () => {
    const result = validateSearchResponse({ success: false, error: 'bad' });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('bad');
  });

  it('rejects a success envelope with missing results array (malformed contract)', () => {
    const result = validateSearchResponse({ success: true }, 'Search');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/malformed response/i);
  });

  it('rejects a success envelope whose results is not an array', () => {
    const result = validateSearchResponse({ success: true, results: 'oops' }, 'Search');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/malformed response/i);
  });

  it('filters out null and id-less results', () => {
    const result = validateSearchResponse({
      success: true,
      results: [{ id: 'a' }, null, { noId: true }, { id: 'b' }]
    });
    expect(result.valid).toBe(true);
    expect(result.results.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('deduplicates results by path, keeping higher score', () => {
    const result = validateSearchResponse({
      success: true,
      results: [
        { id: 'file:/a.txt', score: 0.5, metadata: { path: '/a.txt' } },
        { id: 'file:/a.txt', score: 0.9, metadata: { path: '/a.txt' } }
      ]
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].score).toBe(0.9);
  });
});

describe('getParentFolderName', () => {
  it('returns parent folder for Unix path', () => {
    expect(getParentFolderName('/a/b/file.txt')).toBe('b');
  });

  it('returns parent folder for Windows path', () => {
    expect(getParentFolderName('C:\\docs\\sub\\file.pdf')).toBe('sub');
  });

  it('returns empty for single-segment path', () => {
    expect(getParentFolderName('file.txt')).toBe('');
  });

  it('returns empty for non-string', () => {
    expect(getParentFolderName(null)).toBe('');
  });
});

describe('getConnectionReason', () => {
  it('returns query type for query_match', () => {
    const edge = {
      data: { kind: 'query_match', score: 0.85, matchDetails: { matchedTerms: ['tax'] } }
    };
    const result = getConnectionReason(edge);
    expect(result.type).toBe('query');
    expect(result.label).toMatch(/Query match 85%/);
  });

  it('returns knowledge type for knowledge kind', () => {
    const edge = { data: { kind: 'knowledge', concepts: ['finance'] } };
    const result = getConnectionReason(edge);
    expect(result.type).toBe('knowledge');
  });

  it('returns bridge type for cross_cluster kind', () => {
    const edge = { data: { kind: 'cross_cluster', similarity: 0.7, bridgeCount: 2 } };
    const result = getConnectionReason(edge);
    expect(result.type).toBe('bridge');
  });

  it('returns organize type for organize kind', () => {
    const edge = { data: { kind: 'organize' } };
    const result = getConnectionReason(edge);
    expect(result.type).toBe('organize');
    expect(result.label).toBe('Organize suggestion');
    expect(result.detail).toMatch(/smart folder/);
  });

  it('returns similarity type as default', () => {
    const edge = { data: { similarity: 0.6 } };
    const result = getConnectionReason(edge);
    expect(result.type).toBe('similarity');
    expect(result.label).toMatch(/Similar content 60%/);
  });
});

describe('getFileExtension', () => {
  it('returns extension without dot', () => {
    expect(getFileExtension('file.pdf')).toBe('pdf');
  });

  it('returns empty for no extension', () => {
    expect(getFileExtension('Makefile')).toBe('');
  });
});

// ─── graphFilterDefaults ───────────────────────────────────────────────────────

describe('getDefaultClusterFilters', () => {
  it('returns expected shape', () => {
    const filters = getDefaultClusterFilters();
    expect(filters).toEqual({
      confidence: ['high', 'medium', 'low'],
      minSize: 1,
      fileType: 'all',
      search: ''
    });
  });

  it('returns a new object each call', () => {
    expect(getDefaultClusterFilters()).not.toBe(getDefaultClusterFilters());
  });
});

describe('getDefaultActiveFilters', () => {
  it('returns expected shape', () => {
    const filters = getDefaultActiveFilters();
    expect(filters).toEqual({
      types: ['cluster', 'file', 'query', 'folder'],
      confidence: ['high', 'medium', 'low']
    });
  });

  it('returns a new object each call', () => {
    expect(getDefaultActiveFilters()).not.toBe(getDefaultActiveFilters());
  });
});

// ─── clusterRegroupUtils ───────────────────────────────────────────────────────

describe('regroupClustersForMode', () => {
  const semanticClusters = [
    {
      id: 'cluster:0',
      label: 'Finance',
      memberIds: ['file:a', 'file:b', 'file:c'],
      memberMeta: [
        {
          id: 'file:a',
          timeMs: Date.now() - 2 * 24 * 60 * 60 * 1000,
          fileCategory: 'document',
          fileCategoryLabel: 'Document',
          folderName: 'Finance',
          primaryTag: 'budget'
        },
        {
          id: 'file:b',
          timeMs: Date.now() - 10 * 24 * 60 * 60 * 1000,
          fileCategory: 'spreadsheet',
          fileCategoryLabel: 'Spreadsheet',
          folderName: 'Finance',
          primaryTag: 'q4'
        },
        {
          id: 'file:c',
          timeMs: Date.now() - 200 * 24 * 60 * 60 * 1000,
          fileCategory: 'image',
          fileCategoryLabel: 'Image',
          folderName: 'Photos',
          primaryTag: null
        }
      ]
    }
  ];

  it('returns clusters unchanged for topic mode', () => {
    expect(regroupClustersForMode(semanticClusters, 'topic')).toEqual(semanticClusters);
  });

  it('splits files into recency buckets for time mode', () => {
    const regrouped = regroupClustersForMode(semanticClusters, 'time');
    expect(regrouped.length).toBeGreaterThan(1);
    const totalMembers = regrouped.reduce((sum, c) => sum + (c.memberCount || 0), 0);
    expect(totalMembers).toBe(3);
    expect(regrouped.every((c) => c.isRegrouped)).toBe(true);
    expect(regrouped.some((c) => c.label === 'Past week')).toBe(true);
  });

  it('groups files by file category for type mode', () => {
    const regrouped = regroupClustersForMode(semanticClusters, 'type');
    const labels = regrouped.map((c) => c.label).sort();
    expect(labels).toEqual(expect.arrayContaining(['Document', 'Image', 'Spreadsheet']));
  });

  it('groups files by folder for tag mode', () => {
    const regrouped = regroupClustersForMode(semanticClusters, 'tag');
    const labels = regrouped.map((c) => c.label);
    expect(labels).toEqual(expect.arrayContaining(['Finance', 'Photos']));
  });
});

describe('getRecencyBucketKey', () => {
  it('maps recent timestamps to today', () => {
    expect(getRecencyBucketKey(Date.now() - 60 * 1000)).toBe('today');
  });

  it('returns unknown-date for invalid timestamps', () => {
    expect(getRecencyBucketKey(null)).toBe('unknown-date');
    expect(getRecencyBucketLabel('unknown-date')).toBe('Unknown date');
  });
});
