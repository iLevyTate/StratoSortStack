/**
 * Live Activity invoke handlers: subscribe streams to the calling window and
 * returns the backlog; unsubscribe stops it. Both target event.sender.
 */
jest.mock('../src/main/ipc/ipcWrappers', () => ({
  createHandler: jest.fn(({ handler }) => handler),
  createErrorResponse: jest.fn((error) => ({
    success: false,
    error: error.message || String(error)
  })),
  canceledResponse: jest.fn(() => ({ success: false, canceled: true })),
  safeHandle: (ipcMain, channel, handler) => {
    ipcMain.handle(channel, handler);
  }
}));

jest.mock('../src/main/services/DegradedStateTracker', () => ({
  getInstance: () => ({ raise: jest.fn(), clear: jest.fn(), list: jest.fn(() => []) })
}));

jest.mock('../src/main/core/autoUpdater', () => ({
  quitAndInstall: jest.fn(),
  checkForUpdates: jest.fn()
}));

jest.mock('../src/shared/config/index', () => ({
  dump: jest.fn().mockReturnValue({ config: {}, metadata: {} }),
  validate: jest.fn().mockReturnValue({ valid: true, errors: [], warnings: [] }),
  get: jest.fn()
}));

const mockFeed = { subscribe: jest.fn(), unsubscribe: jest.fn() };
jest.mock('../src/main/services/liveLogFeed', () => ({
  getLiveLogFeed: () => mockFeed
}));

describe('system live log handlers', () => {
  const { IPC_CHANNELS } = require('../src/shared/constants');
  let handlers;
  let mockIpcMain;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    handlers = {};
    mockIpcMain = {
      handle: jest.fn((channel, handler) => {
        handlers[channel] = handler;
      })
    };
    const registerSystemIpc = require('../src/main/ipc/system');
    registerSystemIpc({
      ipcMain: mockIpcMain,
      IPC_CHANNELS,
      logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
      systemAnalytics: { collectMetrics: jest.fn() },
      getServiceIntegration: () => ({})
    });
  });

  test('registers subscribe and unsubscribe, but no handler for the push-only batch channel', () => {
    expect(handlers[IPC_CHANNELS.SYSTEM.LIVE_LOG_SUBSCRIBE]).toEqual(expect.any(Function));
    expect(handlers[IPC_CHANNELS.SYSTEM.LIVE_LOG_UNSUBSCRIBE]).toEqual(expect.any(Function));
    expect(handlers[IPC_CHANNELS.SYSTEM.LIVE_LOG_BATCH]).toBeUndefined();
  });

  test('subscribe streams to the sender and returns the backlog', async () => {
    const sender = { id: 7, send: jest.fn() };
    mockFeed.subscribe.mockReturnValue({ entries: [{ id: 1 }, { id: 2 }] });

    const result = await handlers[IPC_CHANNELS.SYSTEM.LIVE_LOG_SUBSCRIBE]({ sender });

    expect(mockFeed.subscribe).toHaveBeenCalledWith(sender);
    expect(result).toEqual({ success: true, entries: [{ id: 1 }, { id: 2 }] });
  });

  test('a failing subscribe returns an error response instead of throwing', async () => {
    mockFeed.subscribe.mockImplementation(() => {
      throw new Error('feed unavailable');
    });

    const result = await handlers[IPC_CHANNELS.SYSTEM.LIVE_LOG_SUBSCRIBE]({ sender: {} });

    expect(result).toEqual({ success: false, error: 'feed unavailable' });
  });

  test('unsubscribe stops streaming to the sender', async () => {
    const sender = { id: 7, send: jest.fn() };

    const result = await handlers[IPC_CHANNELS.SYSTEM.LIVE_LOG_UNSUBSCRIBE]({ sender });

    expect(mockFeed.unsubscribe).toHaveBeenCalledWith(sender);
    expect(result).toEqual({ success: true });
  });

  test('a failing unsubscribe returns an error response instead of throwing', async () => {
    mockFeed.unsubscribe.mockImplementation(() => {
      throw new Error('already gone');
    });

    const result = await handlers[IPC_CHANNELS.SYSTEM.LIVE_LOG_UNSUBSCRIBE]({ sender: {} });

    expect(result).toEqual({ success: false, error: 'already gone' });
  });
});
