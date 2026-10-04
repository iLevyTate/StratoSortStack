/**
 * @jest-environment jsdom
 *
 * renderHook smokes for useSearchModalStats — the shared stats/rebuild state
 * extracted from UnifiedSearchModal (§I Phase 2). Behavior parity with the
 * in-modal implementation is otherwise pinned by the existing modal suites.
 */
import { renderHook, act, waitFor } from '@testing-library/react';

jest.mock('../../../../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const mockGetStatsCached = jest.fn();
const mockInvalidateStatsCache = jest.fn();
jest.mock('../../../../src/renderer/services/ipc', () => ({
  embeddingsIpc: {
    getStatsCached: (...args) => mockGetStatsCached(...args),
    invalidateStatsCache: (...args) => mockInvalidateStatsCache(...args)
  }
}));

import { useSearchModalStats } from '../../../../src/renderer/components/search/hooks/useSearchModalStats';

describe('useSearchModalStats', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.window.electronAPI = {
      settings: { get: jest.fn().mockResolvedValue({ embeddingTiming: 'manual' }) },
      embeddings: {
        rebuildFolders: jest.fn().mockResolvedValue({ success: true }),
        rebuildFiles: jest.fn().mockResolvedValue({ success: true })
      }
    };
    mockGetStatsCached.mockResolvedValue({
      success: true,
      files: 7,
      folders: 3,
      initialized: true
    });
  });

  function mount(props = {}) {
    return renderHook(
      (p) =>
        useSearchModalStats({
          isOpen: true,
          setError: jest.fn(),
          showSuccess: jest.fn(),
          showError: jest.fn(),
          ...p
        }),
      { initialProps: props }
    );
  }

  test('loads stats on open and exposes them', async () => {
    const { result } = mount();

    await waitFor(() => expect(result.current.hasLoadedStats).toBe(true));
    expect(result.current.stats).toMatchObject({ files: 7, folders: 3, initialized: true });
    expect(result.current.statsUnavailable).toBe(false);
    expect(result.current.embeddingConfig).toMatchObject({ timing: 'manual' });
  });

  test('marks statsUnavailable when the vector DB reports unavailable', async () => {
    mockGetStatsCached.mockResolvedValue({ success: false, code: 'VECTOR_DB_UNAVAILABLE' });
    const { result } = mount();

    await waitFor(() => expect(result.current.hasLoadedStats).toBe(true));
    expect(result.current.stats).toBeNull();
    expect(result.current.statsUnavailable).toBe(true);
  });

  test('rebuildFiles refreshes stats and reports success', async () => {
    const showSuccess = jest.fn();
    const { result } = renderHook(() =>
      useSearchModalStats({
        isOpen: true,
        setError: jest.fn(),
        showSuccess,
        showError: jest.fn()
      })
    );
    await waitFor(() => expect(result.current.hasLoadedStats).toBe(true));
    mockGetStatsCached.mockClear();

    await act(async () => {
      await result.current.rebuildFiles();
    });

    expect(window.electronAPI.embeddings.rebuildFiles).toHaveBeenCalledTimes(1);
    expect(mockGetStatsCached).toHaveBeenCalledWith({ forceRefresh: true });
    expect(showSuccess).toHaveBeenCalled();
    expect(result.current.isRebuildingFiles).toBe(false);
  });

  test('file-operation-complete move events invalidate + refresh and notify the caller', async () => {
    const onFileOperation = jest.fn();
    const { result } = mount({ onFileOperation });
    await waitFor(() => expect(result.current.hasLoadedStats).toBe(true));
    mockGetStatsCached.mockClear();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('file-operation-complete', { detail: { operation: 'move' } })
      );
    });

    expect(onFileOperation).toHaveBeenCalledWith(expect.objectContaining({ operation: 'move' }));
    expect(mockInvalidateStatsCache).toHaveBeenCalled();
    await waitFor(() => expect(mockGetStatsCached).toHaveBeenCalled());
  });
});
