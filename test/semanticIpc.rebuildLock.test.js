const {
  acquireRebuildLock,
  touchRebuildLock,
  releaseRebuildLock
} = require('../src/main/ipc/semantic');

const TEN_MINUTES = 10 * 60 * 1000;

describe('rebuild lock', () => {
  /** @type {number} */
  let now;
  /** @type {jest.SpyInstance} */
  let nowSpy;

  beforeEach(() => {
    now = 1_000_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    // Force-clear any lock state leaked from a prior test.
    releaseRebuildLock(null);
  });

  afterEach(() => {
    releaseRebuildLock(null);
    nowSpy.mockRestore();
  });

  test('second acquire is rejected while a rebuild is running', () => {
    const first = acquireRebuildLock('FULL_REBUILD');
    expect(first.acquired).toBe(true);

    const second = acquireRebuildLock('FULL_REBUILD');
    expect(second.acquired).toBe(false);
    expect(second.reason).toMatch(/in progress/i);
  });

  test('a heartbeating holder is never displaced, no matter how long it runs', () => {
    // Regression: the stale-lock override used wall-clock age, so a rebuild
    // legitimately running longer than the stale window could be silently
    // displaced by a retry — two concurrent rebuilds then interleaved
    // resetAll() + upserts and corrupted the index.
    const first = acquireRebuildLock('FULL_REBUILD');
    expect(first.acquired).toBe(true);

    // Simulate a 45-minute rebuild that heartbeats every "iteration".
    for (let elapsed = 0; elapsed < 45 * 60 * 1000; elapsed += 60 * 1000) {
      now += 60 * 1000;
      touchRebuildLock(first.token);
    }

    const steal = acquireRebuildLock('FULL_REBUILD');
    expect(steal.acquired).toBe(false);
  });

  test('an inactive (hung) holder is displaced after the stale window', () => {
    const first = acquireRebuildLock('FULL_REBUILD');
    expect(first.acquired).toBe(true);

    now += TEN_MINUTES + 1;

    const second = acquireRebuildLock('FULL_REBUILD');
    expect(second.acquired).toBe(true);
    expect(second.token).not.toBe(first.token);
  });

  test('heartbeats from a stale token are ignored', () => {
    const first = acquireRebuildLock('FULL_REBUILD');
    now += TEN_MINUTES + 1;
    const second = acquireRebuildLock('FULL_REBUILD');
    expect(second.acquired).toBe(true);

    // The displaced holder keeps heartbeating with its old token — it must
    // not refresh the new holder's activity clock.
    now += TEN_MINUTES + 1;
    touchRebuildLock(first.token);

    const third = acquireRebuildLock('FULL_REBUILD');
    expect(third.acquired).toBe(true);
  });

  test('release with a stale token is ignored; release with the live token works', () => {
    const first = acquireRebuildLock('FULL_REBUILD');
    now += TEN_MINUTES + 1;
    const second = acquireRebuildLock('FULL_REBUILD');
    expect(second.acquired).toBe(true);

    // Displaced holder's finally-block release must not free the new lock.
    expect(releaseRebuildLock(first.token)).toBe(false);
    expect(acquireRebuildLock('FULL_REBUILD').acquired).toBe(false);

    expect(releaseRebuildLock(second.token)).toBe(true);
    expect(acquireRebuildLock('FULL_REBUILD').acquired).toBe(true);
  });
});
