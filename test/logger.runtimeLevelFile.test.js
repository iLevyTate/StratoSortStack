/**
 * A runtime switch to 'debug' (Settings -> loggingLevel, or the persisted
 * setting applied after configureFileLogging at startup) must reach the
 * session log file for loggers that already existed when file logging was
 * configured. The multistream entries used to be pinned to the level at init,
 * so those loggers' debug records were dropped even though the pino level
 * allowed them.
 */

const path = require('path');
// Real os/fs: test-setup mocks both (memfs, '/tmp'), and this suite writes a
// real log file through sonic-boom.
const os = jest.requireActual('os');
const fs = require('fs');

jest.unmock('../src/shared/logger');
jest.unmock('fs');
jest.unmock('fs/promises');
jest.mock('fs', () => jest.requireActual('fs'));
jest.mock('fs/promises', () => jest.requireActual('fs/promises'));

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

// sonic-boom writes asynchronously; poll until the sentinel record lands.
async function readLogUntil(logFile, sentinel) {
  const deadline = Date.now() + 5000;
  let content = '';
  while (Date.now() < deadline) {
    content = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    if (content.includes(sentinel)) return content;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return content;
}

describe('logger runtime level change with file logging', () => {
  let tmpDir;
  let loggerModule;

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'production';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratosort-log-level-'));
    loggerModule = jest.requireActual('../src/shared/logger');
  });

  afterEach(async () => {
    try {
      await loggerModule.shutdownLogging();
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

  test('debug records from an existing logger reach the file after setGlobalLogLevel("debug")', async () => {
    const logFile = path.join(tmpDir, 'stratosort-session.log');
    const existing = loggerModule.createLogger('ExistingModule');

    loggerModule.configureFileLogging(logFile, {
      enableConsole: false,
      level: 'info',
      pollMs: 3_600_000
    });

    existing.debug('dropped-before-switch');
    loggerModule.setGlobalLogLevel('debug');
    existing.debug('kept-after-switch');
    existing.info('info-after-switch');

    const content = await readLogUntil(logFile, 'info-after-switch');

    expect(content).toContain('info-after-switch');
    expect(content).toContain('kept-after-switch');
    expect(content).not.toContain('dropped-before-switch');
  });

  test('raising the level back to info drops debug records again', async () => {
    const logFile = path.join(tmpDir, 'stratosort-session.log');
    const existing = loggerModule.createLogger('ExistingModule');

    loggerModule.configureFileLogging(logFile, {
      enableConsole: false,
      level: 'debug',
      pollMs: 3_600_000
    });

    loggerModule.setGlobalLogLevel('info');
    existing.debug('debug-after-raise');
    existing.info('info-after-raise');

    const content = await readLogUntil(logFile, 'info-after-raise');

    expect(content).toContain('info-after-raise');
    expect(content).not.toContain('debug-after-raise');
  });
});
