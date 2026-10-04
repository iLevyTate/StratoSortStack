/**
 * @jest-environment node
 */

const mockStart = jest.fn().mockResolvedValue({
  success: true,
  triageId: 't1',
  folderPath: '/x',
  total: 0,
  buckets: { keep: [], trash: [], excluded: [], ambiguous: [] }
});
const mockDeepScan = jest.fn().mockResolvedValue({ success: true, triageId: 't1', buckets: {} });
const mockAct = jest.fn();

jest.mock('../../../src/main/services/triage/DownloadsTriageService', () => ({
  getDownloadsTriageService: jest.fn(() => ({
    start: mockStart,
    deepScan: mockDeepScan,
    act: mockAct
  }))
}));

jest.mock('../../../src/main/ipc/ipcWrappers', () => ({
  registerHandlers: jest.fn(),
  safeSend: jest.fn()
}));

const { registerHandlers, safeSend } = require('../../../src/main/ipc/ipcWrappers');
const registerDownloadsIpc = require('../../../src/main/ipc/downloads');
const { IPC_CHANNELS } = require('../../../src/shared/constants');

describe('downloads IPC triage handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('triage:start forwards event.abortSignal to service.start', async () => {
    registerDownloadsIpc({
      ipcMain: {},
      IPC_CHANNELS,
      logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }
    });
    expect(registerHandlers).toHaveBeenCalled();
    const handlers = registerHandlers.mock.calls[0][0].handlers;
    const cfg = handlers[IPC_CHANNELS.DOWNLOADS.TRIAGE_START];
    expect(cfg?.handler).toEqual(expect.any(Function));
    const ac = new AbortController();
    const fakeEvent = {
      sender: { send: jest.fn(), isDestroyed: () => false },
      abortSignal: ac.signal
    };
    await cfg.handler(fakeEvent, {});
    expect(mockStart).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ signal: ac.signal, onProgress: expect.any(Function) })
    );
  });

  test('triage:deep-scan forwards event.abortSignal to service.deepScan', async () => {
    registerDownloadsIpc({
      ipcMain: {},
      IPC_CHANNELS,
      logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }
    });
    const handlers = registerHandlers.mock.calls[0][0].handlers;
    const cfg = handlers[IPC_CHANNELS.DOWNLOADS.TRIAGE_DEEP_SCAN];
    const ac = new AbortController();
    const fakeEvent = {
      sender: { send: jest.fn(), isDestroyed: () => false },
      abortSignal: ac.signal
    };
    await cfg.handler(fakeEvent, { triageId: 'tid' });
    expect(mockDeepScan).toHaveBeenCalledWith(
      { triageId: 'tid' },
      expect.objectContaining({ signal: ac.signal, onProgress: expect.any(Function) })
    );
  });

  test('progress sender uses safeSend with triage scan channel', async () => {
    registerDownloadsIpc({
      ipcMain: {},
      IPC_CHANNELS,
      logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }
    });
    const handlers = registerHandlers.mock.calls[0][0].handlers;
    const cfg = handlers[IPC_CHANNELS.DOWNLOADS.TRIAGE_START];
    const fakeEvent = {
      sender: { send: jest.fn(), isDestroyed: () => false },
      abortSignal: undefined
    };
    mockStart.mockImplementation(async (_payload, opts) => {
      if (opts?.onProgress) {
        opts.onProgress({ phase: 'tier0', done: 2, total: 2, rate: 10, etaSeconds: 0 });
      }
      return { success: true, triageId: 'x', folderPath: '/y', total: 2, buckets: {} };
    });
    await cfg.handler(fakeEvent, {});
    expect(safeSend).toHaveBeenCalledWith(
      fakeEvent.sender,
      IPC_CHANNELS.DOWNLOADS.TRIAGE_SCAN_PROGRESS,
      expect.objectContaining({ phase: 'tier0', done: 2, total: 2 })
    );
  });
});
