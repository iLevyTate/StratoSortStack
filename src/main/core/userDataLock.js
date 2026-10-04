// @ts-check
/**
 * User-data directory lock.
 *
 * Electron's `app.requestSingleInstanceLock()` historically misbehaves on some
 * macOS releases (<14), and we provide an `STRATOSORT_FORCE_LAUNCH=1` escape
 * hatch when a zombie process is holding that lock. FORCE_LAUNCH bypasses
 * Electron's lock but MUST NOT allow two live processes to scribble on the
 * same Orama and SQLite stores — that corrupts vector indexes and analysis
 * history silently.
 *
 * This module provides a filesystem-level lock anchored on the userData
 * directory. It is acquired once at startup AFTER the Electron single-instance
 * decision, and must be released on quit. If another live process already
 * holds the lock we refuse to start regardless of FORCE_LAUNCH — the lock is
 * about data integrity, not the UI single-instance contract.
 *
 * Staleness detection:
 *   - If the lockfile's recorded pid is no longer running we reclaim it
 *     (the previous process crashed without releasing).
 *   - If the lockfile is unreadable/corrupt we also reclaim it — treating
 *     it as authoritative would prevent recovery forever.
 *
 * @module core/userDataLock
 */

const fs = require('fs');
const path = require('path');

const LOCK_FILENAME = '.stratosort.userdata.lock';

// Grace window during which an empty / unparseable lock file is treated as
// "another instance is mid-startup and hasn't written its pid yet" rather
// than "stale / crashed". Without this, a FORCE_LAUNCH racer that reads
// the lock during the ~millisecond window between `openSync('wx')` and
// `writeSync(fd, payload)` in the primary will treat the zero-byte file
// as corrupt, reclaim it, and end up with two live processes sharing
// Orama / SQLite stores.
//
// 30s is generous — the payload write happens in the same tick as the
// open, so in practice the window is sub-millisecond. The grace is
// deliberately wider to absorb slow I/O on Windows (indexer, AV) without
// accidentally admitting a real crash to the fast path.
const STARTUP_GRACE_MS = 30_000;

// Liveness is judged by a heartbeat the holder writes into the lock file,
// not by the holder's PID alone. After an unclean exit (crash, power loss,
// Windows session end, which skips before-quit) the lock file survives,
// and once the OS hands that PID to any other process `process.kill(pid, 0)`
// says "alive" forever: every launch then refused to start with no window
// and no log. A holder refreshes `heartbeatAt` every HEARTBEAT_INTERVAL_MS;
// a lock whose heartbeat is older than STALE_HEARTBEAT_MS is stale whatever
// its PID says. The threshold is wide so a main thread blocked for a while
// (a long synchronous parse, a debugger pause) does not lose its lock.
const HEARTBEAT_INTERVAL_MS = 30_000;
const STALE_HEARTBEAT_MS = 5 * 60_000;

/** @type {any} */
let _lockFd = null;
/** @type {string | null} */
let _lockPath = null;
/** @type {any} */
let _acquiredAt = null;
/** @type {any} */
let _heartbeatTimer = null;
/** @type {string | null} */
let _userDataPath = null;

/**
 * True when the lock payload's last heartbeat (or, for a payload written
 * before heartbeats existed, its start time) is older than the staleness
 * threshold. A payload with neither timestamp is treated as live.
 * @param {any} parsed
 * @param {number} now
 */
function hasStaleHeartbeat(parsed, now) {
  const stamp = parsed?.heartbeatAt || parsed?.startedAt;
  if (!stamp) return false;
  const lastSeen = Date.parse(stamp);
  if (!Number.isFinite(lastSeen)) return false;
  return now - lastSeen > STALE_HEARTBEAT_MS;
}

function writeLockPayload() {
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: _acquiredAt,
    heartbeatAt: new Date().toISOString(),
    userDataPath: _userDataPath
  });
  fs.ftruncateSync(_lockFd, 0);
  fs.writeSync(_lockFd, payload, 0);
  fs.fsyncSync(_lockFd);
}

/**
 * Rewrite the lock payload with a fresh heartbeat. Called on a timer while
 * the lock is held; exported so tests can drive it directly.
 * @param {any} [logger]
 * @returns {boolean} whether the heartbeat was written
 */
function refreshUserDataLockHeartbeat(logger) {
  if (_lockFd === null) return false;
  try {
    writeLockPayload();
    return true;
  } catch (err) {
    logger?.debug?.('[STARTUP] Could not refresh user-data lock heartbeat', {
      lockPath: _lockPath,
      error: err?.message
    });
    return false;
  }
}

/**
 * Keep the heartbeat honest across sleep. The refresh interval does not run
 * while the OS sleeps, so after a long lid-close the lock looked abandoned
 * for up to one interval after wake, and a launch in that window (FORCE_LAUNCH,
 * or macOS releases where Electron's single-instance lock is skipped)
 * reclaimed a live holder's lock. A refresh on resume (and on unlock) closes
 * that window; one going into suspend keeps the stamp as fresh as it can be.
 * Returns a detach function. Safe with no powerMonitor (tests, old builds).
 * @param {any} powerMonitor  electron.powerMonitor (usable after app ready)
 * @param {any} [logger]
 * @returns {() => void}
 */
function attachUserDataLockPowerMonitor(powerMonitor, logger) {
  if (!powerMonitor || typeof powerMonitor.on !== 'function') return () => {};
  const refresh = () => {
    refreshUserDataLockHeartbeat(logger);
  };
  const events = ['resume', 'unlock-screen', 'suspend'];
  for (const name of events) powerMonitor.on(name, refresh);
  return () => {
    if (typeof powerMonitor.removeListener !== 'function') return;
    for (const name of events) powerMonitor.removeListener(name, refresh);
  };
}

function isProcessAlive(/** @type {any} */ pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we don't own it — still alive.
    return err && err.code === 'EPERM';
  }
}

/**
 * Attempt to acquire the user-data lock.
 *
 * @param {{ userDataPath: string, logger?: any, isForceLaunch?: boolean }} options
 *   userDataPath: Electron `userData` directory
 *   logger: Optional logger (info/warn/error)
 *   isForceLaunch: True when this process is
 *   running under STRATOSORT_FORCE_LAUNCH=1 (i.e. bypassed Electron's
 *   single-instance lock). When set, an empty/unparseable lock file that
 *   was written within {@link STARTUP_GRACE_MS} is treated as "another
 *   instance is mid-startup" and rejected with reason
 *   `another-instance-starting`, rather than reclaimed as stale.
 *   Normal launches (holding the Electron token) keep the original
 *   aggressive reclaim behaviour so a real crash recovery isn't blocked.
 * @returns {{ acquired: boolean, reason?: string, lockPath: string, holderPid?: number, error?: string }}
 */
function acquireUserDataLock({ userDataPath, logger, isForceLaunch = false }) {
  if (typeof userDataPath !== 'string' || userDataPath.length === 0) {
    throw new TypeError('acquireUserDataLock: userDataPath must be a non-empty string');
  }
  _lockPath = path.join(userDataPath, LOCK_FILENAME);

  try {
    fs.mkdirSync(userDataPath, { recursive: true });
  } catch (err) {
    logger?.error?.('[STARTUP] Could not ensure userData directory for DB lock', {
      userDataPath,
      error: err.message
    });
    return {
      acquired: false,
      reason: 'io-error',
      lockPath: _lockPath,
      error: err.message
    };
  }

  const tryOpenExclusive = () => fs.openSync(_lockPath, 'wx');

  let fd;
  try {
    fd = tryOpenExclusive();
  } catch (err) {
    if (err.code !== 'EEXIST') {
      logger?.error?.('[STARTUP] Could not create user-data lock', {
        lockPath: _lockPath,
        error: err.message
      });
      return {
        acquired: false,
        reason: 'io-error',
        lockPath: _lockPath,
        error: err.message
      };
    }

    // Existing lockfile — decide if it is live, starting, or stale.
    let holderPid = null;
    let stale = false;
    let unparseable = false;
    let readErrMessage = null;
    try {
      const contents = fs.readFileSync(_lockPath, 'utf8');
      const parsed = JSON.parse(contents);
      holderPid = Number.isInteger(parsed?.pid) ? parsed.pid : null;
      if (holderPid === process.pid) {
        stale = true; // our own previous aborted run
      } else if (holderPid && !isProcessAlive(holderPid)) {
        stale = true;
        logger?.warn?.('[STARTUP] Stale user-data lock detected, reclaiming', {
          lockPath: _lockPath,
          holderPid
        });
      } else if (holderPid && hasStaleHeartbeat(parsed, Date.now())) {
        // The PID is alive but the holder stopped writing heartbeats long
        // ago: the OS reused the PID after an unclean exit, or the holder
        // is hung. Either way nothing is writing to the stores it guarded.
        stale = true;
        logger?.warn?.('[STARTUP] User-data lock holder PID is alive but its heartbeat is stale', {
          lockPath: _lockPath,
          holderPid,
          heartbeatAt: parsed.heartbeatAt || parsed.startedAt || null
        });
      } else if (!holderPid) {
        unparseable = true;
      }
    } catch (readErr) {
      unparseable = true;
      readErrMessage = readErr.message;
    }

    // An unparseable or pid-less lock is ambiguous: it could be a real
    // crash OR it could be another instance mid-startup that hasn't
    // finished writing its payload yet (the ~microsecond window between
    // `openSync('wx')` and `writeSync`). Use mtime + the caller's
    // FORCE_LAUNCH disposition to decide.
    if (unparseable) {
      let mtimeMs = null;
      try {
        mtimeMs = fs.statSync(_lockPath).mtimeMs;
      } catch {
        // fall through — treat as fully stale
      }
      const rawAgeMs = mtimeMs == null ? Infinity : Date.now() - mtimeMs;
      // Clock-jump defense: a negative age means the lock's mtime is in the
      // future, which happens when the system wall clock was adjusted
      // backwards (DST, NTP correction, VM snapshot restore). We cannot
      // distinguish "fresh lock written before the jump" from "stale lock
      // written after a forward-then-backward jump", so fail closed by
      // treating the lock as FRESH. That refuses FORCE_LAUNCH but lets the
      // normal launcher retry after a moment; data integrity beats a
      // slightly slower recovery path.
      const MAX_REASONABLE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
      const clockJumpedBack = rawAgeMs < 0;
      const absurdlyOld = rawAgeMs > MAX_REASONABLE_AGE_MS;
      const ageMs = clockJumpedBack ? 0 : rawAgeMs;
      if (clockJumpedBack) {
        logger?.warn?.('[STARTUP] user-data lock mtime is in the future; clock jumped back', {
          lockPath: _lockPath,
          rawAgeMs,
          mtimeMs
        });
      }
      if (absurdlyOld) {
        logger?.warn?.('[STARTUP] user-data lock is implausibly old; treating as stale', {
          lockPath: _lockPath,
          rawAgeMs
        });
      }
      const fresh = !absurdlyOld && ageMs < STARTUP_GRACE_MS;

      if (fresh && isForceLaunch) {
        // A primary instance is probably mid-startup (it passed Electron's
        // single-instance token and is writing its pid now). Refuse
        // FORCE_LAUNCH so we don't race it and corrupt Orama/SQLite.
        logger?.warn?.(
          '[STARTUP] Refusing FORCE_LAUNCH: user-data lock is being written by another instance',
          { lockPath: _lockPath, ageMs, readError: readErrMessage }
        );
        return {
          acquired: false,
          reason: 'another-instance-starting',
          lockPath: _lockPath
        };
      }

      stale = true;
      logger?.warn?.('[STARTUP] Unreadable user-data lock; treating as stale', {
        lockPath: _lockPath,
        ageMs,
        isForceLaunch,
        error: readErrMessage
      });
    }

    if (!stale) {
      return {
        acquired: false,
        reason: 'another-instance-holds-lock',
        lockPath: _lockPath,
        holderPid
      };
    }

    try {
      fs.unlinkSync(_lockPath);
    } catch (unlinkErr) {
      if (unlinkErr.code !== 'ENOENT') {
        logger?.error?.('[STARTUP] Failed to remove stale user-data lock', {
          lockPath: _lockPath,
          error: unlinkErr.message
        });
        return {
          acquired: false,
          reason: 'io-error',
          lockPath: _lockPath,
          error: unlinkErr.message
        };
      }
    }

    try {
      fd = tryOpenExclusive();
    } catch (reopenErr) {
      if (reopenErr.code === 'EEXIST') {
        // Another racer beat us to recovery — refuse to proceed.
        return {
          acquired: false,
          reason: 'another-instance-holds-lock',
          lockPath: _lockPath
        };
      }
      logger?.error?.('[STARTUP] Could not reclaim stale user-data lock', {
        lockPath: _lockPath,
        error: reopenErr.message
      });
      return {
        acquired: false,
        reason: 'io-error',
        lockPath: _lockPath,
        error: reopenErr.message
      };
    }
  }

  _lockFd = fd;
  _acquiredAt = new Date().toISOString();
  _userDataPath = userDataPath;

  try {
    writeLockPayload();
  } catch (writeErr) {
    // We hold the fd, but we couldn't record our pid. Fail closed — without
    // a pid the next launcher has no basis to reclaim the lock.
    logger?.error?.('[STARTUP] Failed to write user-data lock payload', {
      lockPath: _lockPath,
      error: writeErr.message
    });
    releaseUserDataLock(logger);
    return {
      acquired: false,
      reason: 'io-error',
      lockPath: _lockPath,
      error: writeErr.message
    };
  }

  logger?.info?.('[STARTUP] Acquired user-data lock', {
    lockPath: _lockPath,
    pid: process.pid
  });

  _heartbeatTimer = setInterval(() => refreshUserDataLockHeartbeat(logger), HEARTBEAT_INTERVAL_MS);
  if (typeof _heartbeatTimer.unref === 'function') _heartbeatTimer.unref();

  return { acquired: true, lockPath: _lockPath };
}

/**
 * Release the user-data lock. Safe to call multiple times; safe to call
 * during crash / before-quit handlers.
 */
function releaseUserDataLock(/** @type {any} */ logger) {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
  if (_lockFd !== null) {
    try {
      fs.closeSync(_lockFd);
    } catch (err) {
      logger?.warn?.('[SHUTDOWN] Failed to close user-data lock fd', {
        error: err.message
      });
    }
    _lockFd = null;
  }
  if (_lockPath) {
    try {
      fs.unlinkSync(_lockPath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger?.warn?.('[SHUTDOWN] Failed to remove user-data lock file', {
          lockPath: _lockPath,
          error: err.message
        });
      }
    }
    _lockPath = null;
  }
  _acquiredAt = null;
}

function getUserDataLockInfo() {
  return {
    held: _lockFd !== null,
    lockPath: _lockPath,
    acquiredAt: _acquiredAt
  };
}

module.exports = {
  refreshUserDataLockHeartbeat,
  attachUserDataLockPowerMonitor,
  HEARTBEAT_INTERVAL_MS,
  STALE_HEARTBEAT_MS,
  LOCK_FILENAME,
  STARTUP_GRACE_MS,
  acquireUserDataLock,
  releaseUserDataLock,
  getUserDataLockInfo
};
