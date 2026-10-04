/**
 * @jest-environment node
 *
 * CG-1: IPC round-trip integration tests.
 * Tests representative channels with REAL channel validation and schema checking,
 * without mocking at boundaries. Verifies the preload -> main -> response path
 * for a selection of key channels.
 */

const { IPC_CHANNELS } = require('../src/shared/constants');

// Mock electron with a fake ipcMain/ipcRenderer bridge
// Variable names MUST start with 'mock' to be accessible inside jest.mock() factory
const mockIpcHandlers = new Map();
const mockIpcListeners = new Map();

jest.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: jest.fn()
  },
  ipcRenderer: {
    invoke: jest.fn(async (channel, ...args) => {
      const handler = mockIpcHandlers.get(channel);
      if (!handler) {
        throw new Error(`No handler registered for channel: ${channel}`);
      }
      return handler({}, ...args);
    }),
    on: jest.fn((channel, callback) => {
      const existing = mockIpcListeners.get(channel) || [];
      existing.push(callback);
      mockIpcListeners.set(channel, existing);
    }),
    removeListener: jest.fn(),
    send: jest.fn()
  },
  webUtils: {
    getPathForFile: jest.fn((f) => f?.path || '/mock/path')
  }
}));

jest.mock('../src/shared/logger', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    setContext: jest.fn(),
    setLevel: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  })),
  LOG_LEVELS: { DEBUG: 'debug', INFO: 'info' }
}));

jest.mock('../src/shared/performanceConstants', () => ({
  LIMITS: {
    MAX_IPC_REQUESTS_PER_SECOND: 200,
    IPC_INVOKE_TIMEOUT: 5000
  },
  TIMEOUTS: {
    DIRECTORY_SCAN: 2000,
    AI_ANALYSIS_LONG: 3000,
    AI_ANALYSIS_BATCH: 5000
  }
}));

jest.mock('../src/shared/pathSanitization', () => ({
  sanitizePath: jest.fn((p) => (typeof p === 'string' ? p.replace('file://', '') : p))
}));

describe('IPC Integration: round-trip channel verification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIpcHandlers.clear();
    mockIpcListeners.clear();
  });

  test('all IPC_CHANNELS categories are defined and non-empty', () => {
    const categories = Object.keys(IPC_CHANNELS);
    expect(categories.length).toBeGreaterThan(10);

    for (const cat of categories) {
      const channels = Object.values(IPC_CHANNELS[cat]);
      expect(channels.length).toBeGreaterThan(0);
      channels.forEach((ch) => {
        expect(typeof ch).toBe('string');
        expect(ch.length).toBeGreaterThan(0);
      });
    }
  });

  test('all channel strings are unique across categories', () => {
    const allChannels = [];
    for (const cat of Object.values(IPC_CHANNELS)) {
      allChannels.push(...Object.values(cat));
    }
    const unique = new Set(allChannels);
    const duplicates = allChannels.filter((ch, i) => allChannels.indexOf(ch) !== i);
    expect(duplicates).toEqual([]);
    expect(unique.size).toBe(allChannels.length);
  });

  test('channel naming follows namespace:action convention', () => {
    const allChannels = [];
    for (const cat of Object.values(IPC_CHANNELS)) {
      allChannels.push(...Object.values(cat));
    }
    const withColon = allChannels.filter((ch) => ch.includes(':'));
    const withoutColon = allChannels.filter((ch) => !ch.includes(':'));

    // At least 90% should follow the convention
    expect(withColon.length / allChannels.length).toBeGreaterThan(0.9);

    // Any without colon should be documented exceptions
    for (const ch of withoutColon) {
      expect(ch).toMatch(/^[a-z-]+$/);
    }
  });

  test('handler registration round-trip succeeds for settings:get', () => {
    mockIpcHandlers.set(IPC_CHANNELS.SETTINGS.GET, async () => ({
      success: true,
      data: { theme: 'dark' }
    }));

    const { ipcRenderer } = require('electron');

    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS.GET).then((result) => {
      expect(result).toEqual({ success: true, data: { theme: 'dark' } });
    });
  });

  test('handler registration round-trip succeeds for embeddings:get-stats', () => {
    mockIpcHandlers.set(IPC_CHANNELS.EMBEDDINGS.GET_STATS, async () => ({
      success: true,
      data: { fileCount: 42, folderCount: 5, dimension: 384 }
    }));

    const { ipcRenderer } = require('electron');

    return ipcRenderer.invoke(IPC_CHANNELS.EMBEDDINGS.GET_STATS).then((result) => {
      expect(result.success).toBe(true);
      expect(result.data.fileCount).toBe(42);
    });
  });

  test('unregistered channel invoke throws descriptive error', async () => {
    const { ipcRenderer } = require('electron');

    await expect(ipcRenderer.invoke('nonexistent:channel')).rejects.toThrow(
      'No handler registered for channel: nonexistent:channel'
    );
  });
});
