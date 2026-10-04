/**
 * @jest-environment jsdom
 *
 * Tests for chatIpc: ChatStream cancel, error propagation, and edge cases.
 */

describe('chatIpc', () => {
  let originalElectronAPI;

  function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const mockChatAPI = (overrides = {}) => ({
    queryStream: jest.fn().mockResolvedValue({ success: true }),
    cancelStream: jest.fn().mockResolvedValue(undefined),
    onStreamChunk: jest.fn(() => () => {}),
    onStreamEnd: jest.fn(() => () => {}),
    ...overrides
  });

  beforeEach(() => {
    jest.resetModules();
    originalElectronAPI = window.electronAPI;
    jest.useFakeTimers();
  });

  afterEach(() => {
    window.electronAPI = originalElectronAPI;
    jest.useRealTimers();
  });

  describe('queryStream / ChatStream', () => {
    test('emits error when Chat API is not available', async () => {
      window.electronAPI = { chat: null };

      const { queryStream } = require('../src/renderer/services/ipc/chatIpc');
      const stream = queryStream({ sessionId: 's1' });

      const onError = jest.fn();
      stream.on('error', onError);

      stream.begin();

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Chat API is not available. The app may still be loading.'
        })
      );
    });

    test('emits error when queryStream returns invalid response', async () => {
      window.electronAPI = {
        chat: {
          ...mockChatAPI(),
          queryStream: () => null
        }
      };

      const { queryStream } = require('../src/renderer/services/ipc/chatIpc');
      const stream = queryStream({ sessionId: 's1' });

      const onError = jest.fn();
      stream.on('error', onError);

      stream.begin();

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Chat queryStream did not return a valid response.' })
      );
    });

    test('emits error when invoke rejects with success: false', async () => {
      window.electronAPI = {
        chat: mockChatAPI({
          queryStream: () => Promise.resolve({ success: false, error: 'Server error' })
        })
      };

      const { queryStream } = require('../src/renderer/services/ipc/chatIpc');
      const stream = queryStream({ sessionId: 's1' });

      const onError = jest.fn();
      stream.on('error', onError);

      stream.begin();

      return Promise.resolve().then(() => {
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Server error' }));
      });
    });

    test('emits error when invoke promise rejects', async () => {
      jest.useRealTimers();
      const err = new Error('Network failed');
      window.electronAPI = {
        chat: mockChatAPI({
          queryStream: () => Promise.reject(err)
        })
      };

      const { queryStream } = require('../src/renderer/services/ipc/chatIpc');
      const stream = queryStream({ sessionId: 's1' });

      const onError = jest.fn();
      stream.on('error', onError);

      stream.begin();

      await new Promise((r) => setTimeout(r, 10));

      expect(onError).toHaveBeenCalledWith(err);
      jest.useFakeTimers();
    });

    test('cancel before start emits end', async () => {
      const queryStreamMock = jest.fn(() => new Promise(() => {}));
      window.electronAPI = {
        chat: mockChatAPI({
          queryStream: queryStreamMock
        })
      };

      const { queryStream } = require('../src/renderer/services/ipc/chatIpc');
      const stream = queryStream({ sessionId: 's1', requestId: 'r1' });

      const onEnd = jest.fn();
      stream.on('end', onEnd);

      stream.cancel();

      expect(onEnd).toHaveBeenCalled();
      expect(queryStreamMock).not.toHaveBeenCalled();
    });

    test('filters stream events to matching request id', async () => {
      let chunkHandler = null;
      let endHandler = null;
      window.electronAPI = {
        chat: mockChatAPI({
          onStreamChunk: jest.fn((callback) => {
            chunkHandler = callback;
            return () => {};
          }),
          onStreamEnd: jest.fn((callback) => {
            endHandler = callback;
            return () => {};
          })
        })
      };

      const { queryStream } = require('../src/renderer/services/ipc/chatIpc');
      const stream = queryStream({ sessionId: 's1', requestId: 'r1' });

      const onData = jest.fn();
      const onEnd = jest.fn();
      stream.on('data', onData);
      stream.on('end', onEnd);

      stream.begin();
      await Promise.resolve();

      chunkHandler({ type: 'chunk', text: 'ignore', requestId: 'r2' });
      chunkHandler({ type: 'chunk', text: 'accept', requestId: 'r1' });
      endHandler({ requestId: 'r2' });
      endHandler({ requestId: 'r1' });

      expect(onData).toHaveBeenCalledTimes(1);
      expect(onData).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'chunk', text: 'accept', requestId: 'r1' })
      );
      expect(onEnd).toHaveBeenCalledTimes(1);
    });

    test('cancel after start calls cancelStream and emits end', async () => {
      const cleanupFn = jest.fn();
      const cancelStream = jest.fn().mockResolvedValue(undefined);
      window.electronAPI = {
        chat: mockChatAPI({
          onStreamChunk: () => cleanupFn,
          onStreamEnd: () => cleanupFn,
          queryStream: () => new Promise(() => {}),
          cancelStream
        })
      };

      const { queryStream } = require('../src/renderer/services/ipc/chatIpc');
      const stream = queryStream({ sessionId: 's1', requestId: 'r1' });

      const onEnd = jest.fn();
      stream.on('end', onEnd);

      stream.begin();
      stream.cancel();

      expect(cancelStream).toHaveBeenCalledWith({ requestId: 'r1', sessionId: 's1' });
      expect(onEnd).toHaveBeenCalled();
    });

    test('cancel is idempotent - second cancel does nothing', async () => {
      const cancelStream = jest.fn().mockResolvedValue(undefined);
      window.electronAPI = {
        chat: mockChatAPI({
          queryStream: () => new Promise(() => {}),
          cancelStream
        })
      };

      const { queryStream } = require('../src/renderer/services/ipc/chatIpc');
      const stream = queryStream({ sessionId: 's1' });

      const onEnd = jest.fn();
      stream.on('end', onEnd);

      stream.begin();
      stream.cancel();
      stream.cancel();
      stream.cancel();

      expect(cancelStream).toHaveBeenCalledTimes(1);
      expect(onEnd).toHaveBeenCalledTimes(1);
    });

    test('ignores late query failures after cleanup', async () => {
      const deferred = createDeferred();
      window.electronAPI = {
        chat: mockChatAPI({
          queryStream: jest.fn().mockReturnValue(deferred.promise)
        })
      };

      const { queryStream } = require('../src/renderer/services/ipc/chatIpc');
      const stream = queryStream({ requestId: 'req-1', sessionId: 'sess-1' });
      const errorHandler = jest.fn();
      stream.on('error', errorHandler);

      stream.begin();
      await Promise.resolve();

      stream.cleanup();
      deferred.reject(new Error('late failure'));

      await Promise.resolve();
      await Promise.resolve();

      expect(errorHandler).not.toHaveBeenCalled();
    });
  });

  describe('extractErrorMessage', () => {
    test('listConversations throws when result.success is false', async () => {
      window.electronAPI = {
        chat: {
          listConversations: jest.fn().mockResolvedValue({
            success: false,
            error: 'Database unavailable'
          })
        }
      };

      const { listConversations } = require('../src/renderer/services/ipc/chatIpc');

      await expect(listConversations()).rejects.toThrow('Database unavailable');
    });

    test('listConversations throws instead of crashing on malformed bridge response', async () => {
      window.electronAPI = {
        chat: {
          listConversations: jest.fn().mockResolvedValue(undefined)
        }
      };

      const { listConversations } = require('../src/renderer/services/ipc/chatIpc');

      await expect(listConversations()).rejects.toThrow();
    });

    test('getConversation returns null when API missing', async () => {
      window.electronAPI = { chat: {} };

      const { getConversation } = require('../src/renderer/services/ipc/chatIpc');

      const result = await getConversation('c1');
      expect(result).toBeNull();
    });
  });
});
