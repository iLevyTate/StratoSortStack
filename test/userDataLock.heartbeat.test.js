/**
 * @jest-environment node
 *
 * Liveness of the user-data lock is judged by a heartbeat the holder
 * writes into the lock file, not by its PID alone. After a crash or a
 * Windows session end the lock file survives, and once the OS reuses the
 * PID `process.kill(pid, 0)` reports "alive" forever: every launch was
 * refused with no window and nothing on screen (audit row LC-02).
 */
const fs = require('fs');
const path = require('path');

const {
  acquireUserDataLock,
  releaseUserDataLock,
  refreshUserDataLockHeartbeat,
  attachUserDataLockPowerMonitor,
  LOCK_FILENAME,
  HEARTBEAT_INTERVAL_MS,
  STALE_HEARTBEAT_MS
} = require('../src/main/core/userDataLock');

// A PID that is alive and is not ours: the jest parent process.
const livePid = process.ppid;

const T0 = new Date('2026-10-02T10:00:00.000Z');

describe('userDataLock — heartbeat staleness', () => {
  let tmpDir;
  let lockPath;
  let logger;

  beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
    tmpDir = fs.mkdtempSync('/tmp/stratosort-lock-heartbeat-');
    lockPath = path.join(tmpDir, LOCK_FILENAME);
    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  });

  afterEach(() => {
    releaseUserDataLock();
    jest.useRealTimers();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  const writeHolder = (payload) => fs.writeFileSync(lockPath, JSON.stringify(payload));
  const readPayload = () => JSON.parse(fs.readFileSync(lockPath, 'utf8'));

  test('heartbeat constants: refresh well inside the staleness window', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0);
    expect(STALE_HEARTBEAT_MS).toBeGreaterThanOrEqual(HEARTBEAT_INTERVAL_MS * 4);
  });

  test('a live PID with a fresh heartbeat keeps the lock', () => {
    writeHolder({
      pid: livePid,
      startedAt: new Date(T0.getTime() - 60_000).toISOString(),
      heartbeatAt: new Date(T0.getTime() - 10_000).toISOString()
    });

    const result = acquireUserDataLock({ userDataPath: tmpDir, logger });

    expect(result.acquired).toBe(false);
    expect(result.reason).toBe('another-instance-holds-lock');
    expect(result.holderPid).toBe(livePid);
  });

  test('a live PID whose heartbeat went stale is reclaimed (PID reuse after a crash)', () => {
    writeHolder({
      pid: livePid,
      startedAt: new Date(T0.getTime() - 2 * STALE_HEARTBEAT_MS).toISOString(),
      heartbeatAt: new Date(T0.getTime() - STALE_HEARTBEAT_MS - 1000).toISOString()
    });

    const result = acquireUserDataLock({ userDataPath: tmpDir, logger });

    expect(result.acquired).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('heartbeat is stale'),
      expect.objectContaining({ holderPid: livePid })
    );
    expect(readPayload().pid).toBe(process.pid);
  });

  test('a pre-heartbeat payload (pid + startedAt only) ages out by its start time', () => {
    writeHolder({
      pid: livePid,
      startedAt: new Date(T0.getTime() - STALE_HEARTBEAT_MS - 1000).toISOString()
    });

    const result = acquireUserDataLock({ userDataPath: tmpDir, logger });

    expect(result.acquired).toBe(true);
  });

  test('waking from sleep refreshes the heartbeat at once, before the interval can', () => {
    // The 30 s timer does not run while the OS sleeps. After a six-hour
    // lid-close the stamp was six hours old for up to one interval, and a
    // launch in that window reclaimed a live holder's lock.
    expect(acquireUserDataLock({ userDataPath: tmpDir, logger }).acquired).toBe(true);
    const handlers = new Map();
    const powerMonitor = {
      on: jest.fn((name, fn) => handlers.set(name, fn)),
      removeListener: jest.fn((name) => handlers.delete(name))
    };
    const detach = attachUserDataLockPowerMonitor(powerMonitor, logger);
    expect([...handlers.keys()]).toEqual(expect.arrayContaining(['resume', 'suspend']));

    const sixHours = 6 * 60 * 60_000;
    jest.setSystemTime(new Date(T0.getTime() + sixHours));
    expect(Date.parse(readPayload().heartbeatAt)).toBe(T0.getTime());

    handlers.get('resume')();
    expect(Date.parse(readPayload().heartbeatAt)).toBe(T0.getTime() + sixHours);

    detach();
    expect(handlers.size).toBe(0);
    // No powerMonitor (tests, old Electron): a no-op detach.
    expect(typeof attachUserDataLockPowerMonitor(null)).toBe('function');
  });

  test('a payload with no timestamps and a live PID is still treated as live', () => {
    writeHolder({ pid: livePid });

    const result = acquireUserDataLock({ userDataPath: tmpDir, logger });

    expect(result.acquired).toBe(false);
    expect(result.reason).toBe('another-instance-holds-lock');
  });

  test('a dead PID is reclaimed regardless of heartbeat age', () => {
    writeHolder({ pid: 2 ** 22 - 7, heartbeatAt: T0.toISOString() });

    const result = acquireUserDataLock({ userDataPath: tmpDir, logger });

    expect(result.acquired).toBe(true);
  });

  test('the holder writes heartbeatAt on acquire and refreshes it on the interval', () => {
    const result = acquireUserDataLock({ userDataPath: tmpDir, logger });
    expect(result.acquired).toBe(true);

    const first = readPayload();
    expect(first.pid).toBe(process.pid);
    expect(first.heartbeatAt).toBe(T0.toISOString());
    expect(first.userDataPath).toBe(tmpDir);

    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    const second = readPayload();
    expect(second.heartbeatAt).toBe(new Date(T0.getTime() + HEARTBEAT_INTERVAL_MS).toISOString());
    expect(second.startedAt).toBe(first.startedAt);

    jest.setSystemTime(new Date(T0.getTime() + 3 * HEARTBEAT_INTERVAL_MS));
    expect(refreshUserDataLockHeartbeat(logger)).toBe(true);
    expect(readPayload().heartbeatAt).toBe(
      new Date(T0.getTime() + 3 * HEARTBEAT_INTERVAL_MS).toISOString()
    );
  });

  test('refresh is a no-op after release and the interval stops', () => {
    acquireUserDataLock({ userDataPath: tmpDir, logger });
    releaseUserDataLock(logger);

    expect(refreshUserDataLockHeartbeat(logger)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('a lock whose holder stopped heartbeating is reclaimable by a later launch', () => {
    // Simulate: this process acquired, then died without release. The next
    // launch (same machine, PID reused by a live process) must get in once
    // the heartbeat is old enough.
    acquireUserDataLock({ userDataPath: tmpDir, logger });
    const payload = readPayload();
    releaseUserDataLock(logger);
    writeHolder({ ...payload, pid: livePid });

    jest.setSystemTime(new Date(T0.getTime() + STALE_HEARTBEAT_MS + 1000));
    const result = acquireUserDataLock({ userDataPath: tmpDir, logger });
    expect(result.acquired).toBe(true);
  });
});
