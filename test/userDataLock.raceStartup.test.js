/**
 * @jest-environment node
 *
 * Regression test for the FORCE_LAUNCH vs. primary-startup race.
 *
 * Sequence this test simulates:
 *   1. Primary process opens the lock file with flag 'wx' (succeeds).
 *   2. Primary is still about to write its pid payload.
 *   3. FORCE_LAUNCH secondary process launches, sees EEXIST, reads the
 *      (empty) lock file, JSON.parse fails.
 *
 * Before the fix: the secondary treated the empty lock as "corrupt/stale"
 * and reclaimed it, so two live processes ended up writing to Orama /
 * SQLite concurrently.
 *
 * After the fix: mtime-based grace window (STARTUP_GRACE_MS) flags the
 * lock as "another-instance-starting" when the caller is FORCE_LAUNCH,
 * and the secondary refuses to start.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  acquireUserDataLock,
  releaseUserDataLock,
  LOCK_FILENAME,
  STARTUP_GRACE_MS
} = require('../src/main/core/userDataLock');

describe('userDataLock — FORCE_LAUNCH vs. primary-startup race', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratosort-lock-race-'));
  });

  afterEach(() => {
    releaseUserDataLock();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  test('exports a sane grace window (documented, non-zero)', () => {
    expect(STARTUP_GRACE_MS).toBeGreaterThan(0);
    expect(STARTUP_GRACE_MS).toBeLessThanOrEqual(5 * 60_000);
  });

  test('FORCE_LAUNCH is refused when a fresh (empty) lock file is present', () => {
    // Simulate the primary's mid-startup state: lock file exists but has
    // not yet had its pid payload written. We use a plain writeFileSync
    // (not 'wx') to sidestep the locked fd — we're modelling the
    // observable on-disk state of a racer.
    const lockPath = path.join(tmpDir, LOCK_FILENAME);
    fs.writeFileSync(lockPath, ''); // zero-byte "starting" record

    const result = acquireUserDataLock({
      userDataPath: tmpDir,
      isForceLaunch: true
    });

    expect(result.acquired).toBe(false);
    expect(result.reason).toBe('another-instance-starting');
    // File must not have been reclaimed.
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  test('normal launch (non-FORCE_LAUNCH) still reclaims an empty/corrupt lock', () => {
    const lockPath = path.join(tmpDir, LOCK_FILENAME);
    fs.writeFileSync(lockPath, 'not-json-at-all');

    const result = acquireUserDataLock({
      userDataPath: tmpDir,
      isForceLaunch: false
    });

    expect(result.acquired).toBe(true);
    // The lock now belongs to us — the reclaim path overwrote the
    // stale record with our pid payload.
    const payload = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    expect(payload.pid).toBe(process.pid);
  });

  test('FORCE_LAUNCH reclaims an old (expired-grace) empty lock', () => {
    const lockPath = path.join(tmpDir, LOCK_FILENAME);
    fs.writeFileSync(lockPath, '');
    // Back-date mtime past the grace window.
    const oldTime = new Date(Date.now() - (STARTUP_GRACE_MS + 60_000));
    fs.utimesSync(lockPath, oldTime, oldTime);

    const result = acquireUserDataLock({
      userDataPath: tmpDir,
      isForceLaunch: true
    });

    expect(result.acquired).toBe(true);
  });

  test('two sequential acquires correctly return to the same process', () => {
    const first = acquireUserDataLock({
      userDataPath: tmpDir,
      isForceLaunch: false
    });
    expect(first.acquired).toBe(true);

    releaseUserDataLock();

    const second = acquireUserDataLock({
      userDataPath: tmpDir,
      isForceLaunch: false
    });
    expect(second.acquired).toBe(true);
  });
});
