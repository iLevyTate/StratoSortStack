/**
 * useChatTab — adding files to the chat document scope must never be a
 * silent no-op: when nothing could be added the user is told why. Also
 * covers the scope size limits, the fresh-open reset, refused sends,
 * conversation switching and where settings-save failures are shown.
 */

import { renderHook, act } from '@testing-library/react';

import { useChatTab } from '../../../../src/renderer/components/search/hooks/useChatTab';
import { queryStream, getConversation } from '../../../../src/renderer/services/ipc/chatIpc';

jest.mock('../../../../src/renderer/services/ipc/chatIpc', () => ({
  queryStream: jest.fn(),
  getConversation: jest.fn()
}));

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
      openFile: jest.fn()
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

  const folderOf = (count, prefix = 'f') => ({
    success: true,
    files: Array.from({ length: count }, (_, i) => ({ path: `/synthetic/big/${prefix}-${i}.txt` }))
  });
  const indexEveryPath = (paths) => ({
    success: true,
    results: paths.map((p) => ({ id: `file:${p}`, path: p, name: p.split('/').pop() }))
  });
  const bigFolder = [{ path: '/synthetic/big', name: 'big', type: 'folder' }];

  test('looks a large folder up in chunks of at most 1000 paths', async () => {
    api.files.getDirectoryContents.mockResolvedValue(folderOf(2500));
    const { result } = renderChatTab();

    await act(async () => {
      await result.current.handleAddToScope(bigFolder);
    });

    const chunkSizes = api.embeddings.findFilesByPaths.mock.calls.map(([paths]) => paths.length);
    expect(chunkSizes).toEqual([1000, 1000, 500]);
    expect(result.current.chatWarning).toMatch(/2500 file\(s\) not in index/);
  });

  test('caps the scope at 1000 files and says so', async () => {
    api.files.getDirectoryContents.mockResolvedValue(folderOf(1500));
    api.embeddings.findFilesByPaths.mockImplementation(async (paths) => indexEveryPath(paths));
    const { result } = renderChatTab();

    await act(async () => {
      await result.current.handleAddToScope(bigFolder);
    });

    expect(result.current.documentScope).toHaveLength(1000);
    expect(result.current.chatWarning).toMatch(/holds up to 1000 files/);
    // The unchecked remainder is not reported as missing from the index.
    expect(result.current.chatWarning).not.toMatch(/not in index/);
  });

  test('caps the scope across several additions', async () => {
    api.embeddings.findFilesByPaths.mockImplementation(async (paths) => indexEveryPath(paths));
    const { result } = renderChatTab();

    api.files.getDirectoryContents.mockResolvedValue(folderOf(600, 'a'));
    await act(async () => {
      await result.current.handleAddToScope(bigFolder);
    });
    expect(result.current.documentScope).toHaveLength(600);
    expect(result.current.chatWarning).toBe('');

    api.files.getDirectoryContents.mockResolvedValue(folderOf(600, 'b'));
    await act(async () => {
      await result.current.handleAddToScope(bigFolder);
    });
    expect(result.current.documentScope).toHaveLength(1000);
    expect(result.current.chatWarning).toMatch(/holds up to 1000 files/);
  });
});

describe('useChatTab conversation state', () => {
  const originalApi = window.electronAPI;
  let api;
  const fakeStream = () => ({ on: jest.fn(), begin: jest.fn(), cancel: jest.fn() });
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  beforeEach(() => {
    queryStream.mockReset();
    getConversation.mockReset();
    queryStream.mockImplementation(() => fakeStream());
    api = {
      settings: { get: jest.fn().mockResolvedValue({}), save: jest.fn().mockResolvedValue({}) },
      chat: { resetSession: jest.fn().mockResolvedValue({}) }
    };
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: api });
  });

  afterEach(() => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: originalApi });
  });

  test('a send reports whether it was accepted', async () => {
    const { result } = renderChatTab();

    act(() => result.current.setStrictScope(true));
    let accepted;
    await act(async () => {
      accepted = await result.current.handleChatSend('What is in my files?');
    });
    expect(accepted).toBe(false);
    expect(queryStream).not.toHaveBeenCalled();
    expect(result.current.chatMessages).toEqual([]);

    act(() => result.current.setStrictScope(false));
    await act(async () => {
      accepted = await result.current.handleChatSend('What is in my files?');
    });
    expect(accepted).toBe(true);
    expect(queryStream).toHaveBeenCalledTimes(1);

    // A second send while the first is still streaming is refused.
    await act(async () => {
      accepted = await result.current.handleChatSend('And another thing');
    });
    expect(accepted).toBe(false);
    expect(queryStream).toHaveBeenCalledTimes(1);
  });

  test('a fresh open starts a new conversation with nothing carried over', async () => {
    getConversation.mockResolvedValue({
      messages: [{ role: 'user', text: 'earlier question' }],
      documentScope: [{ id: 'file:1', path: '/synthetic/a.pdf', name: 'a.pdf', type: 'file' }]
    });
    const { result } = renderChatTab();

    await act(async () => {
      await result.current.handleSelectConversation('conv-1');
    });
    act(() => result.current.setStrictScope(true));
    await act(async () => {
      await result.current.handleChatSend('follow-up');
    });
    // Leaves a warning behind, and the first send is still in flight.
    await act(async () => {
      await result.current.handleChatSend('too soon');
    });
    expect(result.current.currentConversationId).toBe('conv-1');
    expect(result.current.documentScope).toHaveLength(1);
    expect(result.current.chatWarning).not.toBe('');
    expect(result.current.chatStatus).not.toBe('');

    act(() => result.current.resetChatState());

    expect(result.current.chatMessages).toEqual([]);
    expect(result.current.currentConversationId).toBeNull();
    expect(result.current.documentScope).toEqual([]);
    expect(result.current.strictScope).toBe(false);
    expect(result.current.chatWarning).toBe('');
    expect(result.current.chatStatus).toBe('');
    expect(result.current.isChatting).toBe(false);
    expect(result.current.chatSessionRef.current).not.toBe('conv-1');

    // The send that was in flight when the modal closed no longer blocks.
    let accepted;
    await act(async () => {
      accepted = await result.current.handleChatSend('first question after reopening');
    });
    expect(accepted).toBe(true);
  });

  test('the conversation clicked last wins when loads resolve out of order', async () => {
    const first = deferred();
    const second = deferred();
    getConversation.mockImplementation((id) => (id === 'conv-a' ? first.promise : second.promise));
    const { result } = renderChatTab();

    let loadA;
    let loadB;
    act(() => {
      loadA = result.current.handleSelectConversation('conv-a');
      loadB = result.current.handleSelectConversation('conv-b');
    });
    await act(async () => {
      second.resolve({ messages: [{ role: 'user', text: 'from B' }] });
      await loadB;
    });
    await act(async () => {
      first.resolve({ messages: [{ role: 'user', text: 'from A' }] });
      await loadA;
    });

    expect(result.current.currentConversationId).toBe('conv-b');
    expect(result.current.chatMessages).toEqual([{ role: 'user', text: 'from B' }]);
    expect(result.current.chatSessionRef.current).toBe('conv-b');
  });

  test('a conversation that finishes loading after New chat is dropped', async () => {
    const pending = deferred();
    getConversation.mockReturnValue(pending.promise);
    const { result } = renderChatTab();

    let load;
    act(() => {
      load = result.current.handleSelectConversation('conv-a');
    });
    act(() => result.current.handleNewConversation());
    await act(async () => {
      pending.resolve({ messages: [{ role: 'user', text: 'from A' }] });
      await load;
    });

    expect(result.current.currentConversationId).toBeNull();
    expect(result.current.chatMessages).toEqual([]);
  });

  test('a failed settings save is reported in the chat panel warning', async () => {
    api.settings.save.mockRejectedValue(new Error('disk full'));
    const { result } = renderChatTab();

    await act(async () => {
      result.current.handleResponseModeChange('deep');
    });
    expect(result.current.chatWarning).toBe('Failed to save chat response mode. Please try again.');
    // Not the chat error banner: its Retry button would regenerate an answer.
    expect(result.current.chatError).toBe('');
  });
});
