/**
 * @jest-environment node
 *
 * Every change to the undo stack is pushed to each open window on
 * UNDO_REDO.STATE_CHANGED (and to in-process listeners), so the toolbar's
 * undo and redo buttons follow a move made from another screen without a
 * poll. A destroyed window is skipped and a throwing listener does not stop
 * the others.
 */

const mockGetAllWindows = jest.fn(() => []);
const mockSafeSend = jest.fn();

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/test/userData')
  },
  BrowserWindow: {
    getAllWindows: (...args) => mockGetAllWindows(...args)
  }
}));

jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn().mockResolvedValue(),
    rename: jest.fn().mockResolvedValue(),
    mkdir: jest.fn().mockResolvedValue(),
    unlink: jest.fn().mockResolvedValue(),
    access: jest.fn(),
    stat: jest.fn(),
    readdir: jest.fn().mockResolvedValue([]),
    rm: jest.fn().mockResolvedValue()
  }
}));

jest.mock('../src/shared/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }))
}));

jest.mock('../src/shared/atomicFileOperations', () => ({
  crossDeviceMove: jest.fn().mockResolvedValue(),
  durableWriteJson: jest.fn().mockResolvedValue()
}));

jest.mock('../src/shared/pathSanitization', () => ({
  validateFileOperationPath: jest.fn(async (candidate) => ({
    valid: true,
    normalizedPath: String(candidate)
  }))
}));

jest.mock('../src/main/ipc/ipcWrappers', () => ({
  safeSend: (...args) => mockSafeSend(...args)
}));

jest.mock('../src/main/services/ServiceContainer', () => ({
  container: {
    tryResolve: jest.fn(() => null),
    has: jest.fn(() => false),
    resolve: jest.fn(() => null)
  },
  ServiceIds: {
    ORAMA_VECTOR: 'ORAMA_VECTOR',
    FILE_PATH_COORDINATOR: 'FILE_PATH_COORDINATOR'
  }
}));

const fs = require('fs').promises;
const UndoRedoService = require('../src/main/services/UndoRedoService');
const { IPC_CHANNELS } = require('../src/shared/constants');

describe('UndoRedoService state broadcast', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    fs.readFile.mockRejectedValue(enoent);
    fs.access.mockRejectedValue(enoent);
    service = new UndoRedoService({
      maxActions: 5,
      maxMemoryMB: 1,
      maxBatchSize: 10,
      saveDebounceMs: 0
    });
  });

  test('a change reaches every live window and every listener, and skips a destroyed window', () => {
    const live = { isDestroyed: () => false, webContents: { id: 1 } };
    const gone = { isDestroyed: () => true, webContents: { id: 2 } };
    mockGetAllWindows.mockReturnValue([live, gone]);
    const listener = jest.fn();
    service.onStateChanged(listener);

    service._notifyStateChanged('record');

    expect(listener).toHaveBeenCalledWith({ reason: 'record' });
    expect(mockSafeSend).toHaveBeenCalledTimes(1);
    expect(mockSafeSend).toHaveBeenCalledWith(
      live.webContents,
      IPC_CHANNELS.UNDO_REDO.STATE_CHANGED,
      { action: 'record' }
    );
  });

  test('a listener that throws does not stop the broadcast', () => {
    const live = { isDestroyed: () => false, webContents: { id: 1 } };
    mockGetAllWindows.mockReturnValue([live]);
    const bad = jest.fn(() => {
      throw new Error('listener broke');
    });
    const good = jest.fn();
    service.onStateChanged(bad);
    service.onStateChanged(good);

    expect(() => service._notifyStateChanged('clear')).not.toThrow();

    expect(good).toHaveBeenCalledWith({ reason: 'clear' });
    expect(mockSafeSend).toHaveBeenCalledWith(live.webContents, expect.any(String), {
      action: 'clear'
    });
  });

  test('unsubscribing stops the listener, and a window list that throws is not fatal', () => {
    const listener = jest.fn();
    const off = service.onStateChanged(listener);
    off();
    mockGetAllWindows.mockImplementation(() => {
      throw new Error('no windows yet');
    });

    expect(() => service._notifyStateChanged('remove')).not.toThrow();

    expect(listener).not.toHaveBeenCalled();
    expect(mockSafeSend).not.toHaveBeenCalled();
  });

  test('recording an action is one of the changes that is broadcast', async () => {
    const live = { isDestroyed: () => false, webContents: { id: 1 } };
    mockGetAllWindows.mockReturnValue([live]);

    await service.recordAction({
      type: 'rename',
      oldPath: '/a/one.txt',
      newPath: '/a/two.txt'
    });

    expect(mockSafeSend).toHaveBeenCalledWith(
      live.webContents,
      IPC_CHANNELS.UNDO_REDO.STATE_CHANGED,
      { action: 'record' }
    );
  });
});
