/**
 * Renderer service layer for the Live Activity feed (systemIpc).
 */
jest.mock('../src/renderer/services/ipc/electronApi', () => ({
  requireElectronAPI: jest.fn()
}));

const { requireElectronAPI } = require('../src/renderer/services/ipc/electronApi');
const { systemIpc } = require('../src/renderer/services/ipc/systemIpc');

describe('systemIpc live log methods', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('subscribeLiveLog returns the backlog entries', async () => {
    requireElectronAPI.mockReturnValue({
      system: {
        subscribeLiveLog: jest.fn().mockResolvedValue({ success: true, entries: [{ id: 1 }] })
      }
    });
    await expect(systemIpc.subscribeLiveLog()).resolves.toEqual({ entries: [{ id: 1 }] });
  });

  test('subscribeLiveLog tolerates a response without entries', async () => {
    requireElectronAPI.mockReturnValue({
      system: { subscribeLiveLog: jest.fn().mockResolvedValue({ success: true }) }
    });
    await expect(systemIpc.subscribeLiveLog()).resolves.toEqual({ entries: [] });
  });

  test('subscribeLiveLog throws on an error response', async () => {
    requireElectronAPI.mockReturnValue({
      system: {
        subscribeLiveLog: jest.fn().mockResolvedValue({ success: false, error: 'handler missing' })
      }
    });
    await expect(systemIpc.subscribeLiveLog()).rejects.toThrow('handler missing');
  });

  test('subscribeLiveLog surfaces the message of a standard error response', async () => {
    // The main handler answers failures with createErrorResponse, whose
    // `error` is an object ({ code, message }), not a string.
    requireElectronAPI.mockReturnValue({
      system: {
        subscribeLiveLog: jest.fn().mockResolvedValue({
          success: false,
          error: { code: 'UNKNOWN_ERROR', message: 'feed unavailable' }
        })
      }
    });
    await expect(systemIpc.subscribeLiveLog()).rejects.toThrow(/^feed unavailable$/);
  });

  test('subscribeLiveLog falls back to a generic message when the error has none', async () => {
    requireElectronAPI.mockReturnValue({
      system: { subscribeLiveLog: jest.fn().mockResolvedValue({ success: false, error: {} }) }
    });
    await expect(systemIpc.subscribeLiveLog()).rejects.toThrow('Failed to start live activity');
  });

  test('subscribeLiveLog throws when the bridge is missing', async () => {
    requireElectronAPI.mockReturnValue({ system: {} });
    await expect(systemIpc.subscribeLiveLog()).rejects.toThrow(
      'Live activity is unavailable in this build'
    );
  });

  test('unsubscribeLiveLog calls the bridge, and is a no-op without it', async () => {
    const unsubscribeLiveLog = jest.fn().mockResolvedValue({ success: true });
    requireElectronAPI.mockReturnValue({ system: { unsubscribeLiveLog } });
    await expect(systemIpc.unsubscribeLiveLog()).resolves.toBeUndefined();
    expect(unsubscribeLiveLog).toHaveBeenCalledTimes(1);

    requireElectronAPI.mockReturnValue({ system: {} });
    await expect(systemIpc.unsubscribeLiveLog()).resolves.toBeUndefined();
  });

  test('onLiveLogBatch forwards the callback and returns the cleanup', () => {
    const cleanup = jest.fn();
    const onLiveLogBatch = jest.fn(() => cleanup);
    requireElectronAPI.mockReturnValue({ system: { onLiveLogBatch } });
    const callback = jest.fn();

    const off = systemIpc.onLiveLogBatch(callback);

    expect(onLiveLogBatch).toHaveBeenCalledWith(callback);
    off();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test('onLiveLogBatch returns a no-op cleanup without the bridge', () => {
    requireElectronAPI.mockReturnValue({ system: {} });
    const off = systemIpc.onLiveLogBatch(jest.fn());
    expect(() => off()).not.toThrow();
  });
});
