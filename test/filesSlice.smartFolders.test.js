import reducer, {
  setSmartFolders,
  fetchSmartFolders
} from '../src/renderer/store/slices/filesSlice';

describe('filesSlice smartFolders', () => {
  test('setSmartFolders updates state', () => {
    const initial = reducer(undefined, { type: '@@INIT' });
    const next = reducer(initial, setSmartFolders([{ id: '1', name: 'Docs' }]));
    expect(next.smartFolders.length).toBe(1);
    expect(next.smartFolders[0].name).toBe('Docs');
  });

  test('fetchSmartFolders pending/fulfilled toggles loading', () => {
    const pendingState = reducer(undefined, { type: fetchSmartFolders.pending.type });
    expect(pendingState.smartFoldersLoading).toBe(true);
    const fulfilled = reducer(pendingState, {
      type: fetchSmartFolders.fulfilled.type,
      payload: [{ id: 'x' }]
    });
    expect(fulfilled.smartFoldersLoading).toBe(false);
    expect(fulfilled.smartFolders[0].id).toBe('x');
  });

  test('fetchSmartFolders fulfilled clears a sticky timeout error', () => {
    const rejected = reducer(undefined, {
      type: fetchSmartFolders.rejected.type,
      payload: 'IPC timeout'
    });
    expect(rejected.smartFoldersError).toBe('IPC timeout');

    const recovered = reducer(rejected, {
      type: fetchSmartFolders.fulfilled.type,
      payload: [{ id: '1', name: 'Docs' }]
    });
    expect(recovered.smartFoldersError).toBeNull();
    expect(recovered.smartFoldersLoaded).toBe(true);
    expect(recovered.smartFolders).toHaveLength(1);
  });
});
