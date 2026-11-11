/**
 * Pure helpers behind the Knowledge OS graph and Atlas fixes: smart-folder
 * path lookup, cluster-id parsing, carried-over knowledge edges, the guard
 * for the delayed cluster refresh, and the chunked IPC wrappers.
 */
import {
  resolveSmartFolderPath,
  carryOverRelClusterEdges,
  buildClusterOverviewSignature,
  isClusterOverviewUntouched,
  getClusterPayloadKey,
  parseSemanticClusterId,
  chunkArray,
  fetchFileMetadataChunked,
  addTagsChunked,
  FILE_METADATA_BATCH_LIMIT,
  ADD_TAGS_BATCH_LIMIT
} from '../../../../src/renderer/components/search/utils';

const ids = (count, prefix = 'file:') => Array.from({ length: count }, (_, i) => `${prefix}${i}`);

describe('resolveSmartFolderPath', () => {
  const folders = [
    { id: 'a', name: 'Invoices', path: 'C:\\Docs\\Invoices' },
    { id: 'b', name: 'No Path' },
    { id: 'c', name: 'Receipts', path: '/home/me/Receipts' }
  ];

  test('maps a smart folder name to its path, ignoring case and padding', () => {
    expect(resolveSmartFolderPath(folders, 'Invoices')).toBe('C:\\Docs\\Invoices');
    expect(resolveSmartFolderPath(folders, '  invoices ')).toBe('C:\\Docs\\Invoices');
    expect(resolveSmartFolderPath(folders, 'Receipts')).toBe('/home/me/Receipts');
  });

  test('returns an empty string when the name has no usable path', () => {
    expect(resolveSmartFolderPath(folders, 'Taxes')).toBe('');
    expect(resolveSmartFolderPath(folders, 'No Path')).toBe('');
    expect(resolveSmartFolderPath(null, 'Invoices')).toBe('');
    expect(resolveSmartFolderPath(folders, undefined)).toBe('');
  });

  test('passes an absolute path through unchanged', () => {
    expect(resolveSmartFolderPath([], 'C:\\Other\\Place')).toBe('C:\\Other\\Place');
    expect(resolveSmartFolderPath([], 'D:/Other/Place')).toBe('D:/Other/Place');
    expect(resolveSmartFolderPath([], '/srv/place')).toBe('/srv/place');
  });
});

describe('parseSemanticClusterId', () => {
  test('reads the backend number from a semantic cluster id', () => {
    expect(parseSemanticClusterId('cluster:0')).toBe(0);
    expect(parseSemanticClusterId('cluster:17')).toBe(17);
  });

  test('returns null for regrouped, duplicate and malformed ids', () => {
    expect(parseSemanticClusterId('regroup:type:documents')).toBeNull();
    expect(parseSemanticClusterId('dup-group-3')).toBeNull();
    expect(parseSemanticClusterId('cluster:')).toBeNull();
    expect(parseSemanticClusterId('cluster:1:2')).toBeNull();
    expect(parseSemanticClusterId(undefined)).toBeNull();
    expect(parseSemanticClusterId(4)).toBeNull();
  });
});

describe('carryOverRelClusterEdges', () => {
  const rel = { id: 'rel-cluster:cluster:1->cluster:2', source: 'cluster:1', target: 'cluster:2' };
  const cross = { id: 'cross:cluster:1->cluster:2', source: 'cluster:1', target: 'cluster:2' };
  const nodes = [{ id: 'cluster:1' }, { id: 'cluster:2' }];

  test('keeps knowledge edges whose two clusters are still drawn', () => {
    expect(carryOverRelClusterEdges([rel], nodes, [cross])).toEqual([cross, rel]);
  });

  test('drops knowledge edges that lost an endpoint', () => {
    expect(carryOverRelClusterEdges([rel], [{ id: 'cluster:1' }], [cross])).toEqual([cross]);
  });

  test('never carries other edge kinds or duplicates an edge already present', () => {
    const stale = { id: 'cross:old', source: 'cluster:1', target: 'cluster:2' };
    expect(carryOverRelClusterEdges([stale], nodes, [cross])).toEqual([cross]);
    expect(carryOverRelClusterEdges([rel], nodes, [cross, rel])).toEqual([cross, rel]);
  });

  test('tolerates missing lists', () => {
    expect(carryOverRelClusterEdges(undefined, nodes, undefined)).toEqual([]);
  });
});

describe('cluster overview refresh guard', () => {
  const drawn = [
    { id: 'cluster:1', position: { x: 10, y: 20 }, data: {} },
    { id: 'cluster:2', position: { x: 300, y: 40 }, data: {} }
  ];
  const signature = buildClusterOverviewSignature(drawn);

  test('holds while the drawn overview is unchanged, in any node order', () => {
    expect(isClusterOverviewUntouched(signature, drawn)).toBe(true);
    expect(isClusterOverviewUntouched(signature, [...drawn].reverse())).toBe(true);
  });

  test('fails once a cluster is expanded', () => {
    const expanded = [{ ...drawn[0], data: { expanded: true } }, drawn[1]];
    expect(isClusterOverviewUntouched(signature, expanded)).toBe(false);
  });

  test('fails once a node is moved or is being dragged', () => {
    const moved = [{ ...drawn[0], position: { x: 90, y: 20 } }, drawn[1]];
    expect(isClusterOverviewUntouched(signature, moved)).toBe(false);
    expect(isClusterOverviewUntouched(signature, [{ ...drawn[0], dragging: true }, drawn[1]])).toBe(
      false
    );
  });

  test('fails once nodes are added or removed', () => {
    const added = [...drawn, { id: 'file:a', position: { x: 0, y: 0 }, data: {} }];
    expect(isClusterOverviewUntouched(signature, added)).toBe(false);
    expect(isClusterOverviewUntouched(signature, [drawn[0]])).toBe(false);
  });

  test('fails when no overview was recorded', () => {
    expect(isClusterOverviewUntouched(null, drawn)).toBe(false);
    expect(isClusterOverviewUntouched('', [])).toBe(false);
  });
});

describe('getClusterPayloadKey', () => {
  const clusters = [{ id: 1, label: 'Taxes', memberCount: 4, confidence: 0.8 }];
  const edges = [{ source: 1, target: 2, similarity: 0.5 }];

  test('is stable for an identical payload', () => {
    expect(getClusterPayloadKey(clusters, edges)).toBe(
      getClusterPayloadKey(
        clusters.map((c) => ({ ...c })),
        edges.map((e) => ({ ...e }))
      )
    );
  });

  test('changes with a label, a member count or an edge', () => {
    const base = getClusterPayloadKey(clusters, edges);
    expect(getClusterPayloadKey([{ ...clusters[0], label: 'Tax 2025' }], edges)).not.toBe(base);
    expect(getClusterPayloadKey([{ ...clusters[0], memberCount: 5 }], edges)).not.toBe(base);
    expect(getClusterPayloadKey(clusters, [])).not.toBe(base);
  });
});

describe('chunkArray', () => {
  test('splits into pieces of at most the given size', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkArray([], 3)).toEqual([]);
    expect(chunkArray(undefined, 3)).toEqual([]);
  });

  test('never loops forever on a bad size', () => {
    expect(chunkArray([1, 2], 0)).toEqual([[1], [2]]);
  });
});

describe('fetchFileMetadataChunked', () => {
  const echo = jest.fn(async (chunk) => ({
    success: true,
    metadata: Object.fromEntries(chunk.map((id) => [id, { fileName: id }]))
  }));

  beforeEach(() => echo.mockClear());

  test('never sends more ids than one call accepts and merges every chunk', async () => {
    const result = await fetchFileMetadataChunked(ids(250), echo);

    expect(echo).toHaveBeenCalledTimes(3);
    echo.mock.calls.forEach(([chunk]) =>
      expect(chunk.length).toBeLessThanOrEqual(FILE_METADATA_BATCH_LIMIT)
    );
    expect(Object.keys(result.metadata)).toHaveLength(250);
    expect(result).toMatchObject({ success: true, failedChunks: 0 });
  });

  test('keeps what it could fetch when one chunk is rejected or throws', async () => {
    const flaky = jest
      .fn(echo)
      .mockImplementationOnce(async () => ({ success: false, error: 'Too many ids' }))
      .mockImplementationOnce(async () => {
        throw new Error('ipc down');
      });

    const result = await fetchFileMetadataChunked(ids(250), flaky);

    expect(result.success).toBe(true);
    expect(result.failedChunks).toBe(2);
    expect(result.error).toBe('Too many ids');
    expect(Object.keys(result.metadata)).toHaveLength(50);
  });

  test('reports failure when every chunk fails', async () => {
    const result = await fetchFileMetadataChunked(ids(150), async () => ({
      success: false,
      error: 'nope'
    }));

    expect(result).toEqual({ success: false, metadata: {}, failedChunks: 2, error: 'nope' });
  });

  test('uses the preload bridge by default and fails cleanly without it', async () => {
    window.electronAPI = { embeddings: { getFileMetadata: echo } };
    await expect(fetchFileMetadataChunked(['file:a'])).resolves.toMatchObject({
      success: true,
      metadata: { 'file:a': { fileName: 'file:a' } }
    });

    delete window.electronAPI;
    await expect(fetchFileMetadataChunked(['file:a'])).resolves.toMatchObject({ success: false });
  });
});

describe('addTagsChunked', () => {
  test('splits a large selection and adds up what was really tagged', async () => {
    const addTags = jest.fn(async (chunk) => ({ success: true, updated: chunk.length }));

    const result = await addTagsChunked(ids(2500), ['tax'], addTags);

    expect(addTags).toHaveBeenCalledTimes(3);
    addTags.mock.calls.forEach(([chunk, tags]) => {
      expect(chunk.length).toBeLessThanOrEqual(ADD_TAGS_BATCH_LIMIT);
      expect(tags).toEqual(['tax']);
    });
    expect(result).toEqual({ success: true, total: 2500, updated: 2500, failed: 0 });
  });

  test('reports a partial result instead of full success', async () => {
    const addTags = jest
      .fn()
      .mockResolvedValueOnce({ success: true, updated: 1000 })
      .mockResolvedValueOnce({
        success: true,
        updated: 400,
        errors: [{ fileId: 'file:1400', error: 'File not indexed' }]
      })
      .mockRejectedValueOnce(new Error('ipc down'));

    const result = await addTagsChunked(ids(2500), ['tax'], addTags);

    expect(result).toEqual({
      success: true,
      total: 2500,
      updated: 1400,
      failed: 1100,
      error: 'File not indexed'
    });
  });

  test('fails when nothing was tagged', async () => {
    const addTags = jest.fn(async () => ({ success: false, updated: 0, error: 'No index' }));

    await expect(addTagsChunked(ids(3), ['tax'], addTags)).resolves.toEqual({
      success: false,
      total: 3,
      updated: 0,
      failed: 3,
      error: 'No index'
    });
  });

  test('counts a bare success as the whole chunk', async () => {
    await expect(addTagsChunked(ids(3), ['tax'], async () => ({ success: true }))).resolves.toEqual(
      { success: true, total: 3, updated: 3, failed: 0 }
    );
  });
});
