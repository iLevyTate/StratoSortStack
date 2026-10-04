/**
 * Tests for the REAL SecureIPCManager.enqueueThrottled (src/preload/preload.js).
 *
 * These exercise the actual method — imported via the preload module's
 * test-only `SecureIPCManager` export — so a regression in the stale-entry
 * eviction, the per-task cleanup, or the previous-rejection absorption turns
 * this suite red. (The earlier version reimplemented enqueueThrottled inline
 * and asserted against the copy, so it could never catch a real regression.)
 */

const mockInvoke = jest.fn();
const mockOn = jest.fn();
const mockRemoveListener = jest.fn();
const mockSend = jest.fn();
const mockExposeInMainWorld = jest.fn();
const mockGetPathForFile = jest.fn();

jest.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mockExposeInMainWorld },
  ipcRenderer: {
    invoke: mockInvoke,
    on: mockOn,
    removeListener: mockRemoveListener,
    send: mockSend
  },
  webUtils: { getPathForFile: mockGetPathForFile }
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

jest.mock('../src/preload/ipcRateLimiter', () => ({
  IpcRateLimiter: jest.fn().mockImplementation(() => ({
    checkRateLimit: jest.fn()
  }))
}));

jest.mock('../src/preload/ipcSanitizer', () => ({
  createIpcSanitizer: jest.fn(() => ({
    sanitizeArguments: jest.fn((args) => args)
  }))
}));

jest.mock('../src/preload/ipcValidator', () => ({
  createIpcValidator: jest.fn(() => ({
    validateResult: jest.fn((result) => result),
    validateEventSource: jest.fn(() => true),
    isValidSystemMetrics: jest.fn(() => true)
  }))
}));

jest.mock('../src/shared/pathSanitization', () => ({
  sanitizePath: jest.fn((p) => p)
}));

jest.mock('../src/shared/performanceConstants', () => ({
  LIMITS: { MAX_IPC_REQUESTS_PER_SECOND: 200, IPC_INVOKE_TIMEOUT: 1000 },
  TIMEOUTS: {}
}));

jest.mock('../src/shared/securityConfig', () => ({
  ...jest.requireActual('../src/shared/securityConfig'),
  ALLOWED_RECEIVE_CHANNELS: [],
  ALLOWED_SEND_CHANNELS: []
}));

jest.mock('../src/shared/constants', () => jest.requireActual('../src/shared/constants'));

describe('SecureIPCManager.enqueueThrottled (real method)', () => {
  let SecureIPCManager;
  // A channel that is NOT in THROTTLED_CHANNELS, so delayMs === 0 and no inner
  // setTimeout is armed — keeps the eviction/cleanup branches under test while
  // leaving zero pending timers for the worker to trip over on teardown.
  const CH = 'test:channel';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    global.window = global.window || {};
    global.window.addEventListener = jest.fn();
    global.window.removeEventListener = jest.fn();

    ({ SecureIPCManager } = require('../src/preload/preload'));
  });

  test('evicts a stale (never-settled) queue entry when a new task is enqueued', async () => {
    jest.useFakeTimers();
    try {
      const mgr = new SecureIPCManager();

      // First task never settles → its queue entry + timestamp persist.
      const stuck = mgr.enqueueThrottled(CH, () => new Promise(() => {}));
      stuck.catch(() => {}); // never rejects, but never leave it floating
      expect(mgr.channelQueues.get(CH)).toBe(stuck);
      expect(mgr._channelQueueTimestamps.has(CH)).toBe(true);

      // Advance past STALE_QUEUE_TIMEOUT_MS (30000ms) so the next enqueue sees
      // the entry as stale and evicts it.
      jest.advanceTimersByTime(31000);

      let ran = false;
      const fresh = mgr.enqueueThrottled(CH, () => {
        ran = true;
        return Promise.resolve('done');
      });

      // With eviction, `fresh` chains on a clean Promise.resolve() and runs
      // immediately. Without eviction it would chain on `stuck` and hang here.
      await fresh;

      expect(ran).toBe(true);
      expect(fresh).not.toBe(stuck);
      // finally-cleanup ran for the completed fresh entry.
      expect(mgr.channelQueues.has(CH)).toBe(false);
      expect(mgr._channelQueueTimestamps.has(CH)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test('clears the queue + timestamp maps after a task settles', async () => {
    const mgr = new SecureIPCManager();

    await mgr.enqueueThrottled(CH, () => Promise.resolve('ok'));

    // The `.finally` in enqueueThrottled removes the entry it owns.
    expect(mgr.channelQueues.size).toBe(0);
    expect(mgr._channelQueueTimestamps.size).toBe(0);
  });

  test('a rejected task does not poison the next task on the same channel', async () => {
    const mgr = new SecureIPCManager();

    const failed = mgr.enqueueThrottled(CH, () => Promise.reject(new Error('boom')));
    failed.catch(() => {}); // the returned promise surfaces the rejection

    // Enqueued synchronously while `failed` is still the head of the channel
    // queue, so it chains on it. The previous-rejection `.catch` must absorb
    // the failure; otherwise this rejects instead of resolving.
    const next = mgr.enqueueThrottled(CH, () => Promise.resolve('ok'));

    await expect(next).resolves.toBe('ok');
  });
});
