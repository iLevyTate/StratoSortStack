const fs = require('fs');
const os = require('os');
const path = require('path');
const { LOCK_FILENAME } = require('../src/main/core/userDataLock');
const {
  resolveUserDataPath,
  isProcessAlive,
  inspectRunningInstance
} = require('../scripts/check-running-instance');

describe('check-running-instance dev guard', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-guard-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const writeLock = (payload) =>
    fs.writeFileSync(
      path.join(tmpDir, LOCK_FILENAME),
      typeof payload === 'string' ? payload : JSON.stringify(payload)
    );

  describe('inspectRunningInstance', () => {
    it('allows clean when no lock file exists', () => {
      const result = inspectRunningInstance(tmpDir);
      expect(result.blocked).toBe(false);
      expect(result.reason).toBe('no-lock');
    });

    it('blocks clean when a live process holds the lock', () => {
      writeLock({ pid: process.pid });
      const result = inspectRunningInstance(tmpDir);
      expect(result.blocked).toBe(true);
      expect(result.pid).toBe(process.pid);
      expect(result.reason).toBe('instance-alive');
    });

    it('allows clean when the lock pid is dead (stale lock)', () => {
      // PID 1 is init/system on POSIX and reserved on Windows; a freshly chosen
      // very-high pid is reliably absent. Use a pid we can prove is not alive.
      let deadPid = 2147483646;
      while (isProcessAlive(deadPid)) deadPid -= 1;
      writeLock({ pid: deadPid });
      const result = inspectRunningInstance(tmpDir);
      expect(result.blocked).toBe(false);
      expect(result.reason).toBe('stale');
    });

    it('allows clean when the lock is unparseable (mid-write/corrupt)', () => {
      writeLock('{ not valid json');
      const result = inspectRunningInstance(tmpDir);
      expect(result.blocked).toBe(false);
      expect(result.reason).toBe('unparseable');
    });

    it('allows clean when the lock has no usable pid', () => {
      writeLock({ startedAt: 'whenever' });
      const result = inspectRunningInstance(tmpDir);
      expect(result.blocked).toBe(false);
      expect(result.reason).toBe('stale');
    });
  });

  describe('isProcessAlive', () => {
    it('returns true for the current process', () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it('returns false for invalid pids', () => {
      expect(isProcessAlive(0)).toBe(false);
      expect(isProcessAlive(-1)).toBe(false);
      expect(isProcessAlive(NaN)).toBe(false);
      expect(isProcessAlive(1.5)).toBe(false);
    });
  });

  describe('resolveUserDataPath', () => {
    const ORIGINAL_ENV = process.env.STRATOSORT_E2E_USER_DATA;

    afterEach(() => {
      if (ORIGINAL_ENV === undefined) {
        delete process.env.STRATOSORT_E2E_USER_DATA;
      } else {
        process.env.STRATOSORT_E2E_USER_DATA = ORIGINAL_ENV;
      }
    });

    it('honours the E2E userData override', () => {
      process.env.STRATOSORT_E2E_USER_DATA = tmpDir;
      expect(resolveUserDataPath()).toBe(tmpDir);
    });

    it('resolves to a "StratoSort Core" directory by default', () => {
      delete process.env.STRATOSORT_E2E_USER_DATA;
      expect(resolveUserDataPath().endsWith(path.join('', 'StratoSort Core'))).toBe(true);
    });
  });
});
