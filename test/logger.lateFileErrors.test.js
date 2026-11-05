/**
 * Logging shuts down cleanly: no file stream outlives it, and a stream error
 * that arrives afterwards is not written to the console.
 *
 * CI failed on otherwise green runs (Windows and macOS, all suites passing,
 * exit code 1) with "Cannot log after tests are done ... [Logger] File log
 * stream error" right after logger.rotation.test.js: a sonic-boom destination
 * was still opening (they open asynchronously) when the test removed its temp
 * directory, the open failed with ENOENT, and the logger reported it to a
 * console Jest had already torn down.
 */

const path = require('path');
const os = jest.requireActual('os');
const fs = require('fs');

jest.unmock('../src/shared/logger');
jest.unmock('fs');
jest.unmock('fs/promises');
jest.mock('fs', () => jest.requireActual('fs'));
jest.mock('fs/promises', () => jest.requireActual('fs/promises'));

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

describe('logger shutdown and late file-stream errors', () => {
  let tmpDir;
  let logger;
  let errorSpy;

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'production';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratosort-log-late-'));
    logger = jest.requireActual('../src/shared/logger');
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  const lateStreamErrors = () =>
    errorSpy.mock.calls.filter((call) => String(call[0]).includes('File log stream error'));

  test('a destination still opening at shutdown is opened and closed before shutdown returns', async () => {
    const statSyncSpy = jest.spyOn(fs, 'statSync').mockImplementation(() => ({ size: 8 * 1024 }));
    logger.configureFileLogging(path.join(tmpDir, 'session.log'), {
      enableConsole: false,
      maxBytes: 1024,
      pollMs: 3_600_000
    });
    // Rotation creates a new destination that opens asynchronously; shut
    // down before it has had a chance to open.
    logger._rotateLogFileNow();
    statSyncSpy.mockRestore();

    await logger.shutdownLogging();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(lateStreamErrors()).toEqual([]);
  });

  test('a stream error after shutdown is not written to the console', async () => {
    logger.configureFileLogging(path.join(tmpDir, 'session.log'), {
      enableConsole: false,
      pollMs: 3_600_000
    });
    const stream = logger.logger._fileStream;
    await logger.shutdownLogging();

    stream.emit('error', Object.assign(new Error('ENOENT: gone'), { code: 'ENOENT' }));
    expect(lateStreamErrors()).toEqual([]);
  });

  test('a stream error while logging is running is still reported', () => {
    logger.configureFileLogging(path.join(tmpDir, 'session.log'), {
      enableConsole: false,
      pollMs: 3_600_000
    });
    logger.logger._fileStream.emit(
      'error',
      Object.assign(new Error('EACCES: denied'), { code: 'EACCES' })
    );
    expect(lateStreamErrors().length).toBeGreaterThan(0);
  });
});
