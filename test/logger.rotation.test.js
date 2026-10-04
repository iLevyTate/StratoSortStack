/**
 * Tests for the size-based log rotation and ENOSPC / disk-error handling in
 * `src/shared/logger.js`. We intentionally avoid exercising real pino file
 * streams here — those have their own open-file race with sonic-boom's async
 * initialization and they aren't what we're testing. Instead we stub
 * `fs.statSync` so the rotation gate sees any size we want it to see, and we
 * drive the internal entry points directly.
 */

const path = require('path');
// Real os, not the test-setup mock: the mock pins tmpdir() to the memfs
// '/tmp', but this suite runs against the REAL filesystem (below), where
// '/tmp' does not exist on Windows CI runners (mkdtemp ENOENT).
const os = jest.requireActual('os');
const fs = require('fs');

// The global test-setup.js replaces '../src/shared/logger' with a stub that
// has no file stream or rotation logic. It also swaps `fs` for memfs, which
// doesn't round-trip Windows paths cleanly through sonic-boom. For this suite
// we need the real modules on both sides — rotation is about real filesystem
// behaviour (size, ENOENT, ENOSPC), and memfs fights us on that.
jest.unmock('../src/shared/logger');
jest.unmock('fs');
jest.unmock('fs/promises');
jest.mock('fs', () => jest.requireActual('fs'));
jest.mock('fs/promises', () => jest.requireActual('fs/promises'));

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

describe('logger file rotation and disk error handling', () => {
  let tmpDir;
  let logger;
  let statSyncSpy;

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'production';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratosort-log-rot-'));
    logger = jest.requireActual('../src/shared/logger');
  });

  afterEach(async () => {
    if (statSyncSpy) {
      statSyncSpy.mockRestore();
      statSyncSpy = null;
    }
    try {
      await logger.shutdownLogging();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  test('rotates the log file once the size threshold is exceeded', () => {
    const logFile = path.join(tmpDir, 'stratosort-session.log');

    // Pre-write enough content that the file is comfortably over our 1 KB
    // rotation threshold. We also `fsync`/close explicitly so the stat call
    // the rotation logic performs sees the expected size regardless of
    // whether pino subsequently opens it for append.
    const fd = fs.openSync(logFile, 'w');
    fs.writeSync(fd, Buffer.alloc(8 * 1024, 0x2e));
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    logger.configureFileLogging(logFile, {
      enableConsole: false,
      maxBytes: 1024,
      pollMs: 3_600_000
    });

    // Sanity check — the file must still be >=1 KB for the rotation gate to
    // trigger. If this fails the rotation test itself tells us nothing.
    expect(fs.statSync(logFile).size).toBeGreaterThanOrEqual(1024);

    logger._rotateLogFileNow();

    const state = logger._getLogRotationState();
    expect(state.rotationIndex).toBe(1);
    const expected = path.join(tmpDir, 'stratosort-session-1.log');
    expect(logger.logger.logFile).toBe(expected);
  });

  test('rotation ends the previous shared destination and keeps exactly one open', async () => {
    const logFile = path.join(tmpDir, 'stratosort-fdleak.log');
    statSyncSpy = jest.spyOn(fs, 'statSync').mockImplementation(() => ({ size: 8 * 1024 }));

    logger.configureFileLogging(logFile, {
      enableConsole: false,
      maxBytes: 1024,
      pollMs: 3_600_000
    });
    // A second logger sharing the same destination must not keep it alive.
    logger.createLogger('RotationPeer');

    const previous = logger.logger._fileStream;
    expect(previous).toBeTruthy();
    expect(logger._getSharedFileDestinationPaths()).toEqual([logFile]);
    const previousClosed = new Promise((resolve) => previous.once('close', resolve));

    logger._rotateLogFileNow();

    const rotated = path.join(tmpDir, 'stratosort-fdleak-1.log');
    expect(logger._getSharedFileDestinationPaths()).toEqual([rotated]);
    expect(logger.logger._fileStream).not.toBe(previous);
    await previousClosed;

    logger._rotateLogFileNow();
    expect(logger._getSharedFileDestinationPaths()).toEqual([
      path.join(tmpDir, 'stratosort-fdleak-2.log')
    ]);
  });

  test('warns once when the per-session rotation cap engages and stops rotating', () => {
    const logFile = path.join(tmpDir, 'stratosort-cap.log');
    statSyncSpy = jest.spyOn(fs, 'statSync').mockImplementation(() => ({ size: 8 * 1024 }));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      logger.configureFileLogging(logFile, {
        enableConsole: false,
        maxBytes: 1024,
        pollMs: 3_600_000
      });

      for (let i = 0; i < logger.MAX_LOG_ROTATIONS; i += 1) {
        logger._rotateLogFileNow();
      }
      expect(logger._getLogRotationState().rotationIndex).toBe(logger.MAX_LOG_ROTATIONS);
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('rotation cap'));

      logger._rotateLogFileNow();
      logger._rotateLogFileNow();

      expect(logger._getLogRotationState().rotationIndex).toBe(logger.MAX_LOG_ROTATIONS);
      const capWarnings = warnSpy.mock.calls.filter(
        ([msg]) => typeof msg === 'string' && msg.includes('rotation cap')
      );
      expect(capWarnings).toHaveLength(1);

      // A fresh session re-arms both the counter and the one-shot warning.
      logger.configureFileLogging(path.join(tmpDir, 'stratosort-cap2.log'), {
        enableConsole: false,
        maxBytes: 1024,
        pollMs: 3_600_000
      });
      expect(logger._getLogRotationState().rotationIndex).toBe(0);
      expect(logger._getLogRotationState().rotationCapWarned).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('skips rotation when another writer holds the rotation lock', () => {
    const logFile = path.join(tmpDir, 'stratosort-lockheld.log');

    const fd = fs.openSync(logFile, 'w');
    fs.writeSync(fd, Buffer.alloc(8 * 1024, 0x2e));
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    // Simulate a sibling process mid-rotation: a fresh lock file sitting
    // next to the log. Our rotation gate must see EEXIST and back off
    // rather than renaming the file out from under the peer.
    const lockPath = `${logFile}.rotating`;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999, startedAt: Date.now() }));

    logger.configureFileLogging(logFile, {
      enableConsole: false,
      maxBytes: 1024,
      pollMs: 3_600_000
    });

    logger._rotateLogFileNow();

    const state = logger._getLogRotationState();
    expect(state.rotationIndex).toBe(0);
    expect(logger.logger.logFile).toBe(logFile);
    // Peer's lock must still be intact — we never rewrote it.
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  test('reclaims a stale rotation lock whose owner has gone away', () => {
    const logFile = path.join(tmpDir, 'stratosort-stalelock.log');

    const fd = fs.openSync(logFile, 'w');
    fs.writeSync(fd, Buffer.alloc(8 * 1024, 0x2e));
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    // Lock file dated well outside the 30s stale window → the crashed
    // writer's leftover marker must not permanently wedge rotation.
    const lockPath = `${logFile}.rotating`;
    fs.writeFileSync(lockPath, '');
    const oneHourAgo = Date.now() - 3_600_000;
    fs.utimesSync(lockPath, new Date(oneHourAgo), new Date(oneHourAgo));

    logger.configureFileLogging(logFile, {
      enableConsole: false,
      maxBytes: 1024,
      pollMs: 3_600_000
    });

    logger._rotateLogFileNow();

    const state = logger._getLogRotationState();
    expect(state.rotationIndex).toBe(1);
    // Lock released after successful rotation.
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('does not rotate when the file is below the threshold', () => {
    const logFile = path.join(tmpDir, 'stratosort-small.log');
    statSyncSpy = jest.spyOn(fs, 'statSync').mockImplementation(() => ({ size: 128 }));

    logger.configureFileLogging(logFile, {
      enableConsole: false,
      maxBytes: 1024 * 1024,
      pollMs: 3_600_000
    });

    logger._rotateLogFileNow();

    const state = logger._getLogRotationState();
    expect(state.rotationIndex).toBe(0);
    expect(logger.logger.logFile).toBe(logFile);
  });

  test('invokes onFileError and disables file logging on ENOSPC', () => {
    const logFile = path.join(tmpDir, 'stratosort-enospc.log');
    const onFileError = jest.fn();

    logger.configureFileLogging(logFile, {
      enableConsole: false,
      maxBytes: 1024 * 1024,
      pollMs: 3_600_000,
      onFileError
    });

    const state = logger._getLogRotationState();
    expect(typeof state.onError).toBe('function');

    const err = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    state.onError(err);

    expect(onFileError).toHaveBeenCalledTimes(1);
    expect(onFileError.mock.calls[0][0].code).toBe('ENOSPC');
  });

  test('rotation resets the per-session counter and clears the prior disk-error latch', () => {
    const logFile = path.join(tmpDir, 'stratosort-reset.log');

    // First session: set a disk-error latch and bump the rotation counter via
    // the internal onError hook.
    logger.configureFileLogging(logFile, {
      enableConsole: false,
      maxBytes: 1024,
      pollMs: 3_600_000,
      onFileError: () => {}
    });
    logger._getLogRotationState().onError(Object.assign(new Error('dq'), { code: 'EDQUOT' }));

    // New session (simulated by a fresh configureFileLogging call without the
    // internal _isRotation flag) should start from a clean slate.
    const logFile2 = path.join(tmpDir, 'stratosort-reset2.log');
    logger.configureFileLogging(logFile2, {
      enableConsole: false,
      maxBytes: 1024 * 1024,
      pollMs: 3_600_000
    });

    const state = logger._getLogRotationState();
    expect(state.rotationIndex).toBe(0);
    expect(state.diskErrorRaised).toBe(false);
  });

  test('shutdownLogging stops the rotation timer', async () => {
    const logFile = path.join(tmpDir, 'stratosort-shutdown.log');
    logger.configureFileLogging(logFile, {
      enableConsole: false,
      maxBytes: 1024 * 1024,
      pollMs: 50
    });
    expect(logger._getLogRotationState().pollMs).toBe(50);

    await logger.shutdownLogging();

    logger._rotateLogFileNow();
    expect(logger._getLogRotationState().rotationIndex).toBe(0);
  });
});
