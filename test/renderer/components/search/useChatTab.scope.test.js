/**
 * useChatTab — adding files to the chat document scope must never be a
 * silent no-op: when nothing could be added the user is told why.
 */

import { renderHook, act } from '@testing-library/react';

import { useChatTab } from '../../../../src/renderer/components/search/hooks/useChatTab';

jest.mock('../../../../src/shared/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger, createLogger: () => logger };
});

function renderChatTab() {
  return renderHook(() =>
    useChatTab({
      isOpen: false,
      searchResults: [],
      defaultTopK: 6,
      openFile: jest.fn(),
      setError: jest.fn()
    })
  );
}

describe('useChatTab document scope', () => {
  const originalApi = window.electronAPI;
  let api;

  beforeEach(() => {
    api = {
      embeddings: {
        findFilesByPaths: jest.fn().mockResolvedValue({ success: true, results: [] }),
        search: jest.fn().mockResolvedValue({ success: true, results: [] })
      },
      files: {
        getDirectoryContents: jest.fn().mockResolvedValue({ success: true, files: [] })
      }
    };
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: api });
  });

  afterEach(() => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: originalApi });
  });

  test('adds indexed files to the scope without a warning', async () => {
    api.embeddings.findFilesByPaths.mockResolvedValue({
      success: true,
      results: [{ id: 'file:1', path: '/synthetic/docs/report.pdf', name: 'report.pdf' }]
    });
    const { result } = renderChatTab();

    await act(async () => {
      await result.current.handleAddToScope([
        { path: '/synthetic/docs/report.pdf', name: 'report.pdf', type: 'file' }
      ]);
    });

    expect(result.current.documentScope).toEqual([
      { id: 'file:1', path: '/synthetic/docs/report.pdf', name: 'report.pdf', type: 'file' }
    ]);
    expect(result.current.chatWarning).toBe('');
  });

  test('warns when none of the chosen files are in the index', async () => {
    const { result } = renderChatTab();

    await act(async () => {
      await result.current.handleAddToScope([
        { path: '/synthetic/docs/new-notes.txt', name: 'new-notes.txt', type: 'file' }
      ]);
    });

    expect(result.current.documentScope).toEqual([]);
    expect(result.current.chatWarning).toMatch(/1 file\(s\) not in index: new-notes\.txt/);
  });

  test('warns when a dropped item has no readable path', async () => {
    const { result } = renderChatTab();

    await act(async () => {
      await result.current.handleAddToScope([{ path: undefined, name: 'a.pdf', type: 'file' }]);
    });

    expect(result.current.documentScope).toEqual([]);
    expect(result.current.chatWarning).toMatch(/No files were added/i);
  });

  test('warns when the index lookup fails', async () => {
    api.embeddings.findFilesByPaths.mockRejectedValue(new Error('ipc down'));
    const { result } = renderChatTab();

    await act(async () => {
      await result.current.handleAddToScope([
        { path: '/synthetic/docs/report.pdf', name: 'report.pdf', type: 'file' }
      ]);
    });

    expect(result.current.documentScope).toEqual([]);
    expect(result.current.chatWarning).toMatch(/Could not check/i);
  });

  test('adds the indexed files of a dropped folder', async () => {
    api.files.getDirectoryContents.mockResolvedValue({
      success: true,
      files: [{ path: '/synthetic/docs/Invoices/jan.pdf' }]
    });
    api.embeddings.findFilesByPaths.mockResolvedValue({
      success: true,
      results: [{ id: 'file:jan', path: '/synthetic/docs/Invoices/jan.pdf', name: 'jan.pdf' }]
    });
    const { result } = renderChatTab();

    await act(async () => {
      await result.current.handleAddToScope([
        { path: '/synthetic/docs/Invoices', name: 'Invoices', type: 'folder' }
      ]);
    });

    expect(api.files.getDirectoryContents).toHaveBeenCalledWith('/synthetic/docs/Invoices');
    expect(result.current.documentScope.map((item) => item.id)).toEqual(['file:jan']);
  });
});
