/**
 * @jest-environment jsdom
 */
import { renderHook, waitFor, act } from '@testing-library/react';

const mockDispatch = jest.fn();
let mockOrganizeFocusRequest = null;

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock('../src/renderer/store/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector) =>
    selector({
      ui: { organizeFocusRequest: mockOrganizeFocusRequest }
    })
}));

jest.mock('../src/renderer/store/slices/uiSlice', () => ({
  clearOrganizeFocus: jest.fn(() => ({ type: 'ui/clearOrganizeFocus' }))
}));

import { useOrganizeNotificationFocus } from '../src/renderer/phases/organize/useOrganizeNotificationFocus';
import { clearOrganizeFocus } from '../src/renderer/store/slices/uiSlice';

function renderFocusHook(overrides = {}) {
  const setSelectedFiles = jest.fn();
  const setFocusFileIndex = jest.fn();
  const setViewingFileDetails = jest.fn();
  const setShowHistoryModal = jest.fn();
  const addNotification = jest.fn();
  const revealFile = jest.fn().mockResolvedValue(undefined);

  const props = {
    unprocessedFiles: [],
    processedFiles: [],
    setSelectedFiles,
    setFocusFileIndex,
    setViewingFileDetails,
    setShowHistoryModal,
    addNotification,
    revealFile,
    ...overrides
  };

  renderHook(() => useOrganizeNotificationFocus(props));

  return {
    setSelectedFiles,
    setFocusFileIndex,
    setViewingFileDetails,
    setShowHistoryModal,
    addNotification,
    revealFile
  };
}

describe('useOrganizeNotificationFocus', () => {
  beforeEach(() => {
    mockOrganizeFocusRequest = null;
    jest.clearAllMocks();
  });

  test('selects and focuses unprocessed file by path', () => {
    mockOrganizeFocusRequest = {
      filePath: '/tmp/invoice.pdf',
      fileName: 'invoice.pdf',
      openDetails: true,
      requestedAt: 1000
    };

    const unprocessedFiles = [{ path: '/tmp/invoice.pdf', name: 'invoice.pdf' }];
    const { setSelectedFiles, setFocusFileIndex, setViewingFileDetails } = renderFocusHook({
      unprocessedFiles
    });

    expect(setSelectedFiles).toHaveBeenCalledWith(new Set(['/tmp/invoice.pdf']));
    expect(setFocusFileIndex).toHaveBeenCalledWith(0);
    expect(setViewingFileDetails).toHaveBeenCalledWith(unprocessedFiles[0]);
    expect(clearOrganizeFocus).toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/clearOrganizeFocus' });
  });

  test('opens history modal for processed file match', () => {
    mockOrganizeFocusRequest = {
      filePath: '/dest/notes.txt',
      fileName: 'notes.txt',
      openDetails: true,
      requestedAt: 2000
    };

    const processedFiles = [
      {
        path: '/dest/notes.txt',
        originalName: 'notes.txt',
        analysis: { category: 'Notes' }
      }
    ];
    const { setShowHistoryModal, setViewingFileDetails } = renderFocusHook({ processedFiles });

    expect(setShowHistoryModal).toHaveBeenCalledWith(true);
    expect(setViewingFileDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'notes.txt',
        path: '/dest/notes.txt'
      })
    );
    expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/clearOrganizeFocus' });
  });

  test('reveals file in Explorer when not in organize lists', async () => {
    mockOrganizeFocusRequest = {
      filePath: '/downloads/new.pdf',
      fileName: 'new.pdf',
      openDetails: true,
      requestedAt: 3000
    };

    window.electronAPI = {
      analysisHistory: {
        getFileHistory: jest.fn().mockResolvedValue([])
      }
    };

    const { revealFile, addNotification } = renderFocusHook();

    await waitFor(() => {
      expect(revealFile).toHaveBeenCalledWith('/downloads/new.pdf');
    });
    expect(addNotification).toHaveBeenCalledWith('Opened new.pdf in Explorer', 'info', 3500);
    expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/clearOrganizeFocus' });

    delete window.electronAPI;
  });

  test('ignores duplicate focus requests with the same requestedAt', () => {
    mockOrganizeFocusRequest = {
      filePath: '/tmp/a.pdf',
      fileName: 'a.pdf',
      openDetails: true,
      requestedAt: 4000
    };

    const unprocessedFiles = [{ path: '/tmp/a.pdf', name: 'a.pdf' }];
    const props = {
      unprocessedFiles,
      processedFiles: [],
      setSelectedFiles: jest.fn(),
      setFocusFileIndex: jest.fn(),
      setViewingFileDetails: jest.fn(),
      setShowHistoryModal: jest.fn(),
      addNotification: jest.fn(),
      revealFile: jest.fn()
    };

    const { rerender } = renderHook(() => useOrganizeNotificationFocus(props));

    expect(props.setSelectedFiles).toHaveBeenCalledTimes(1);

    rerender();

    expect(props.setSelectedFiles).toHaveBeenCalledTimes(1);
  });

  describe('a lookup that is still pending when the file lists change', () => {
    let resolveHistory;

    const renderWithPendingHistory = (initialLists) => {
      window.electronAPI = {
        analysisHistory: {
          getFileHistory: jest.fn(
            () =>
              new Promise((resolve) => {
                resolveHistory = resolve;
              })
          )
        }
      };
      const callbacks = {
        setSelectedFiles: jest.fn(),
        setFocusFileIndex: jest.fn(),
        setViewingFileDetails: jest.fn(),
        setShowHistoryModal: jest.fn(),
        addNotification: jest.fn(),
        revealFile: jest.fn().mockResolvedValue(undefined)
      };
      const view = renderHook((lists) => useOrganizeNotificationFocus({ ...lists, ...callbacks }), {
        initialProps: initialLists
      });
      return { ...callbacks, rerender: view.rerender };
    };

    afterEach(() => {
      delete window.electronAPI;
    });

    test('still opens the details and clears the request after the lists are replaced', async () => {
      mockOrganizeFocusRequest = {
        filePath: '/downloads/watched.pdf',
        fileName: 'watched.pdf',
        openDetails: true,
        requestedAt: 5000
      };

      const { setViewingFileDetails, rerender } = renderWithPendingHistory({
        unprocessedFiles: [],
        processedFiles: []
      });
      expect(window.electronAPI.analysisHistory.getFileHistory).toHaveBeenCalledTimes(1);

      // Organize's own mount re-render: same contents, new array references.
      rerender({ unprocessedFiles: [], processedFiles: [] });

      await act(async () => {
        resolveHistory([{ fileName: 'watched.pdf', category: 'Finance' }]);
      });

      expect(setViewingFileDetails).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'watched.pdf', path: '/downloads/watched.pdf' })
      );
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/clearOrganizeFocus' });
      expect(window.electronAPI.analysisHistory.getFileHistory).toHaveBeenCalledTimes(1);
    });

    test('opens the history modal for an organized file that is listed only after mount', async () => {
      mockOrganizeFocusRequest = {
        filePath: '/dest/notes.txt',
        fileName: 'notes.txt',
        openDetails: true,
        requestedAt: 6000
      };

      const { setShowHistoryModal, setViewingFileDetails, revealFile, rerender } =
        renderWithPendingHistory({ unprocessedFiles: [], processedFiles: [] });

      rerender({
        unprocessedFiles: [],
        processedFiles: [
          { path: '/dest/notes.txt', originalName: 'notes.txt', analysis: { category: 'Notes' } }
        ]
      });

      await act(async () => {
        resolveHistory([]);
      });

      expect(setShowHistoryModal).toHaveBeenCalledWith(true);
      expect(setViewingFileDetails).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/dest/notes.txt', analysis: { category: 'Notes' } })
      );
      expect(revealFile).not.toHaveBeenCalled();
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/clearOrganizeFocus' });
    });
  });
});
