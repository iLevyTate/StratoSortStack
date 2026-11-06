/**
 * Tests for Logger
 * Updated for Pino-based logger implementation.
 */

// Opt out of the global logger mock from test-setup.js since we're testing the real logger
jest.unmock('../src/shared/logger');

jest.mock('pino', () => {
  const mockPinoInstance = {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    child: jest.fn(function () {
      return this;
    })
  };
  const pinoMock = jest.fn(() => mockPinoInstance);
  pinoMock.transport = jest.fn(() => ({}));
  pinoMock.destination = jest.fn(() => ({ write: jest.fn(), end: jest.fn() }));
  pinoMock.multistream = jest.fn(() => ({ write: jest.fn(), end: jest.fn() }));
  pinoMock.stdTimeFunctions = { isoTime: () => '' };
  return pinoMock;
});

const {
  Logger,
  logger,
  LOG_LEVELS,
  createLogger,
  sanitizeLogData,
  setGlobalLogLevel,
  _normalizeBrowserTransmit
} = require('../src/shared/logger');
const pino = require('pino');

const buildMockPino = () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  child: jest.fn(function () {
    return this;
  })
});

describe('Logger', () => {
  describe('LOG_LEVELS', () => {
    test('has correct log level values', () => {
      expect(LOG_LEVELS.ERROR).toBe('error');
      expect(LOG_LEVELS.WARN).toBe('warn');
      expect(LOG_LEVELS.INFO).toBe('info');
      expect(LOG_LEVELS.DEBUG).toBe('debug');
      expect(LOG_LEVELS.TRACE).toBe('trace');
    });
  });

  describe('Logger class', () => {
    test('creates logger with default settings', () => {
      const log = new Logger();
      const expected = process.env.NODE_ENV === 'development' ? 'debug' : 'info';
      expect(log.level).toBe(expected);
      expect(log.enableFile).toBe(false);
      expect(log.logFile).toBe(null);
      expect(log.context).toBe('');
    });

    test('setLevel with string', () => {
      const log = new Logger();
      log.setLevel('DEBUG');
      expect(log.level).toBe('debug');
    });

    test('setLevel with number', () => {
      const log = new Logger();
      log.setLevel(1);
      expect(log.level).toBe('warn');
    });

    test('setLevel with invalid string defaults to info', () => {
      const log = new Logger();
      log.setLevel('INVALID');
      expect(log.level).toBe('info');
    });

    test('setContext sets context and updates pino child', () => {
      const log = new Logger();
      log.pino = buildMockPino();
      log.setContext('TestContext');
      expect(log.context).toBe('TestContext');
      expect(log.pino.child).toHaveBeenCalledWith({ context: 'TestContext' });
    });

    test('enableFileLogging enables file logging', () => {
      const log = new Logger();
      const initSpy = jest.spyOn(log, '_initPino');
      log.enableFileLogging('/path/to/log.txt');
      expect(log.enableFile).toBe(true);
      expect(log.logFile).toBe('/path/to/log.txt');
      expect(initSpy).toHaveBeenCalled();
    });

    test('disableConsoleLogging disables console', () => {
      const log = new Logger();
      const initSpy = jest.spyOn(log, '_initPino');
      log.disableConsoleLogging();
      expect(log.enableConsole).toBe(false);
      expect(initSpy).toHaveBeenCalled();
    });
  });

  describe('sanitizeLogData', () => {
    test('preserves error details', () => {
      const error = new Error('Test error');
      const sanitized = sanitizeLogData({ error });
      expect(sanitized.error).toEqual(
        expect.objectContaining({
          name: 'Error',
          message: 'Test error'
        })
      );
    });

    test('redacts file paths to [REDACTED_PATH] format uniformly', () => {
      const sanitized = sanitizeLogData({
        filePath: 'C:\\Users\\test\\file.txt',
        source: '/tmp/example.txt'
      });
      expect(sanitized.filePath).toBe('[REDACTED_PATH]\\file.txt');
      expect(sanitized.source).toBe('[REDACTED_PATH]/example.txt');
    });

    // CG-2: Sensitive key redaction tests
    test('redacts sensitive key values (token, password, apiKey)', () => {
      const sanitized = sanitizeLogData({
        token: 'sk-abc123secret',
        password: 'hunter2',
        apiKey: 'key-xyz789',
        normalField: 'safe-value'
      });
      expect(sanitized.token).toBe('[REDACTED]');
      expect(sanitized.password).toBe('[REDACTED]');
      expect(sanitized.apiKey).toBe('[REDACTED]');
      expect(sanitized.normalField).toBe('safe-value');
    });

    test('redacts sensitive keys case-insensitively', () => {
      const sanitized = sanitizeLogData({
        TOKEN: 'value',
        Password: 'value',
        API_KEY: 'value',
        authorization: 'Bearer xyz',
        secret: 'my-secret'
      });
      expect(sanitized.TOKEN).toBe('[REDACTED]');
      expect(sanitized.Password).toBe('[REDACTED]');
      expect(sanitized.API_KEY).toBe('[REDACTED]');
      expect(sanitized.authorization).toBe('[REDACTED]');
      expect(sanitized.secret).toBe('[REDACTED]');
    });

    test('redacts sensitive keys in nested objects', () => {
      const sanitized = sanitizeLogData({
        config: {
          token: 'nested-secret',
          host: 'localhost'
        }
      });
      expect(sanitized.config.token).toBe('[REDACTED]');
      expect(sanitized.config.host).toBe('localhost');
    });

    test('handles arrays with nested sensitive data', () => {
      const sanitized = sanitizeLogData({
        items: [{ password: 'secret', name: 'item1' }]
      });
      expect(sanitized.items[0].password).toBe('[REDACTED]');
      expect(sanitized.items[0].name).toBe('item1');
    });

    test('reduces userDataPath / logFilePath / homeDir to basename on Windows, hiding username', () => {
      const sanitized = sanitizeLogData({
        userDataPath: 'C:\\Users\\benja\\AppData\\Roaming\\StratoSort Stack',
        logFilePath: 'C:\\Users\\benja\\AppData\\Roaming\\StratoSort Stack\\logs\\session.log',
        homeDir: 'C:\\Users\\benja'
      });
      expect(sanitized.userDataPath).toBe('[REDACTED_PATH]/StratoSort Stack');
      expect(sanitized.logFilePath).toBe('[REDACTED_PATH]/session.log');
      expect(sanitized.homeDir).toBe('[REDACTED_PATH]/benja');
      // Username must not survive in the sanitized output for userDataPath
      // even though the raw string contained "benja".
      expect(JSON.stringify(sanitized.userDataPath)).not.toMatch(/benja/);
    });

    test('reduces userDataPath to basename on macOS and Linux, hiding username', () => {
      const sanitized = sanitizeLogData({
        userDataPath: '/Users/benja/Library/Application Support/StratoSort Stack',
        logsDir: '/home/benja/.config/StratoSort Stack/logs',
        tempDir: '/var/folders/abc/T'
      });
      expect(sanitized.userDataPath).toBe('[REDACTED_PATH]/StratoSort Stack');
      expect(sanitized.logsDir).toBe('[REDACTED_PATH]/logs');
      expect(sanitized.tempDir).toBe('[REDACTED_PATH]/T');
      expect(JSON.stringify(sanitized)).not.toMatch(/benja/);
    });

    test('path-like key redaction is case-insensitive and handles trailing separators', () => {
      const sanitized = sanitizeLogData({
        UserDataPath: 'C:\\Users\\benja\\AppData\\Roaming\\StratoSort Stack\\',
        LOGFILEPATH: '/var/log/stratosort/app.log/'
      });
      expect(sanitized.UserDataPath).toBe('[REDACTED_PATH]/StratoSort Stack');
      expect(sanitized.LOGFILEPATH).toBe('[REDACTED_PATH]/app.log');
    });

    test('does not aggressively redact unrelated *path keys like filePath', () => {
      // Keys like `filePath` or `sourcePath` refer to user content being
      // analyzed — we still want the generic string redaction (which keeps
      // the basename) without forcing the path-key-specific branch.
      const sanitized = sanitizeLogData({
        filePath: 'C:\\Users\\benja\\Documents\\report.pdf'
      });
      expect(sanitized.filePath).toBe('[REDACTED_PATH]\\report.pdf');
    });

    test('strips newlines and control characters from user-derived log fields (log-injection guard)', () => {
      const forged =
        'user clicked OK\n2025-01-01 00:00:00 INFO [audit] admin=root action=deleteAll';
      const sanitized = sanitizeLogData({
        userMessage: forged,
        chatInput: 'hello\r\nGOTCHA',
        ansi: 'title \u001b[31mRED\u001b[0m',
        nul: 'before\u0000after',
        // Tabs are preserved because existing log lines legitimately use them
        // for alignment. We only collapse control chars that can corrupt the
        // log stream.
        tabs: 'a\tb\tc'
      });

      expect(sanitized.userMessage).not.toContain('\n');
      expect(sanitized.userMessage).toMatch(/user clicked OK\\n/);
      // The forged log line payload must have its newline neutralized so a
      // naive `tail`/`grep` can't treat it as a standalone log entry.
      expect(sanitized.userMessage.split(/\r?\n/).length).toBe(1);

      expect(sanitized.chatInput).toBe('hello\\r\\nGOTCHA');
      expect(sanitized.ansi).toBe('title \\x1b[31mRED\\x1b[0m');
      expect(sanitized.nul).toBe('before\\x00after');
      expect(sanitized.tabs).toBe('a\tb\tc');
    });

    test('control-char stripping is a no-op on clean strings (fast path)', () => {
      const clean = 'regular log message with path C:\\Users\\benja\\file.txt';
      const sanitized = sanitizeLogData(clean);
      // Control-char stripping should leave the redacted path intact and
      // must not double-escape backslashes or alter basename output.
      expect(sanitized).toBe('regular log message with path [REDACTED_PATH]\\file.txt');
    });

    describe('every absolute path in one line', () => {
      test.each([' to ', ', ', ' -> ', ' => '])(
        'redacts both Windows paths joined by %j, leaving no directory of either',
        (joiner) => {
          const raw = String.raw`Failed to move C:\Users\jdoe\Documents\Inbox\Lab results.pdf${joiner}D:\Users\jdoe\Documents\Medical\Lab results.pdf: EBUSY`;
          const sanitized = sanitizeLogData(raw);
          expect(sanitized).toBe(
            String.raw`Failed to move [REDACTED_PATH]\Lab results.pdf${joiner}[REDACTED_PATH]\Lab results.pdf: EBUSY`
          );
          expect(sanitized).not.toMatch(/jdoe|Users|Documents|Inbox|Medical/);
        }
      );

      test('redacts the asyncFileOps move line with the same drive twice', () => {
        const sanitized = sanitizeLogData(
          String.raw`Failed to move C:\Users\jdoe\a.pdf to C:\Users\jdoe\Medical\a.pdf: EPERM`
        );
        expect(sanitized).toBe(
          String.raw`Failed to move [REDACTED_PATH]\a.pdf to [REDACTED_PATH]\a.pdf: EPERM`
        );
      });

      test('redacts a UNC path to its basename', () => {
        const sanitized = sanitizeLogData(String.raw`copy \\server\share\dir\file.pdf done`);
        expect(sanitized).toBe(String.raw`copy [REDACTED_PATH]\file.pdf done`);
        expect(sanitized).not.toMatch(/server|share|dir\\/);
      });

      test('redacts JSON-escaped Windows paths inside a string, keeping the escape', () => {
        const raw = JSON.stringify({
          from: 'C:\\Users\\jdoe\\x.pdf',
          to: '\\\\nas\\home\\jdoe\\y.pdf'
        });
        const sanitized = sanitizeLogData(`payload ${raw}`);
        expect(sanitized).toBe(
          String.raw`payload {"from":"[REDACTED_PATH]\\x.pdf","to":"[REDACTED_PATH]\\y.pdf"}`
        );
        expect(sanitized).not.toMatch(/Users|jdoe|nas|home/);
        // The redacted text is still valid JSON.
        expect(JSON.parse(sanitized.slice('payload '.length))).toEqual({
          from: '[REDACTED_PATH]\\x.pdf',
          to: '[REDACTED_PATH]\\y.pdf'
        });
      });

      test('redacts forward-slash drive paths, including the drive and first folder', () => {
        const sanitized = sanitizeLogData('open C:/Users/jdoe/x.pdf then D:/Users/jdoe/y.pdf');
        expect(sanitized).toBe('open [REDACTED_PATH]/x.pdf then [REDACTED_PATH]/y.pdf');
        expect(sanitized).not.toMatch(/Users|jdoe|C:|D:/);
      });

      test.each([
        [
          String.raw`Moved C:\Users\Bob\a.pdf to Finance/Taxes`,
          String.raw`Moved [REDACTED_PATH]\a.pdf to Finance/Taxes`
        ],
        [
          String.raw`Loaded C:\Models\qwen.gguf in 300ms (gpu=yes, 50% layers/offload)`,
          String.raw`Loaded [REDACTED_PATH]\qwen.gguf in 300ms (gpu=yes, 50% layers/offload)`
        ],
        [
          String.raw`[FILE-OPS] Move completed C:\Users\Bob\Inbox\a.pdf -> C:\Users\Bob\Finance\a.pdf (12/40)`,
          String.raw`[FILE-OPS] Move completed [REDACTED_PATH]\a.pdf -> [REDACTED_PATH]\a.pdf (12/40)`
        ],
        [
          String.raw`payload {"from":"C:\\Users\\Bob\\a.pdf","note":"12/40"}`,
          String.raw`payload {"from":"[REDACTED_PATH]\\a.pdf","note":"12/40"}`
        ]
      ])('a backslash path stops at its own separators, not a later slash: %s', (raw, expected) => {
        expect(sanitizeLogData(raw)).toBe(expected);
      });

      test('keeps basenames with spaces, brackets and parentheses whole', () => {
        expect(sanitizeLogData(String.raw`C:\Users\jdoe\My Docs\report [final] (2).pdf`)).toBe(
          String.raw`[REDACTED_PATH]\report [final] (2).pdf`
        );
        expect(sanitizeLogData('C:/Users/jdoe/My Docs/report [final] (2).pdf')).toBe(
          '[REDACTED_PATH]/report [final] (2).pdf'
        );
      });

      test('leaves POSIX paths, ratios, times and URLs as they were', () => {
        expect(sanitizeLogData('/home/me/a.pdf')).toBe('[REDACTED_PATH]/a.pdf');
        expect(sanitizeLogData('ratio 3:4 at 10:30')).toBe('ratio 3:4 at 10:30');
        // URLs: the scheme's single trailing letter is not a drive, so the
        // drive-path pass must not touch them (the POSIX pass already
        // reduced their path to the last segment before this change).
        expect(sanitizeLogData('see https://x/y')).toBe('see https:/[REDACTED_PATH]/y');
        expect(sanitizeLogData('GET http://localhost:8080/api/v1/models')).toBe(
          'GET http:/[REDACTED_PATH]/models'
        );
      });

      test('keeps the line and column of a stack frame and node:internal frames', () => {
        expect(
          sanitizeLogData(
            String.raw`at foo (C:\app\src\x.js:10:5) at node:internal/process/task_queues:104:5`
          )
        ).toBe(
          String.raw`at foo ([REDACTED_PATH]\x.js:10:5) at node:internal/process/task_queues:104:5`
        );
      });

      test('stays linear on long hostile inputs', () => {
        const hostile = [
          'C:\\' + 'a'.repeat(50000),
          'C:\\a'.repeat(12500),
          '\\\\' + 'a\\'.repeat(25000),
          'C:/' + 'a/'.repeat(25000) + ' ',
          'x' + 'aC:'.repeat(16000),
          'C:\\' + ' to C'.repeat(10000) + ':',
          '\\\\'.repeat(25000) + 'x',
          'C:' + '\\'.repeat(50000),
          '\\\\a:'.repeat(12500),
          'C:\\' + 'C:\\'.repeat(16000),
          'C:' + '\\'.repeat(25000) + 'a' + '\\'.repeat(24999) + 'a',
          'C:\\\\a\\'.repeat(10000),
          '\\\\\\\\a\\\\\\'.repeat(6000),
          'C:/a\\'.repeat(10000)
        ];
        for (const input of hostile) {
          const start = Date.now();
          const out = sanitizeLogData(input);
          expect(typeof out).toBe('string');
          expect(Date.now() - start).toBeLessThan(500);
        }
      });
    });
  });

  describe('logging methods', () => {
    test('error uses pino.error with sanitized data', () => {
      const log = new Logger();
      log.pino = buildMockPino();
      log.error('Error message', { filePath: '/path/to/file.txt' });
      expect(log.pino.error).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: '[REDACTED_PATH]/file.txt' }),
        'Error message'
      );
    });

    test('info logs without data', () => {
      const log = new Logger();
      log.pino = buildMockPino();
      log.info('Info message');
      expect(log.pino.info).toHaveBeenCalledWith('Info message');
    });

    test('info joins console-style message fragments into a single sanitized message', () => {
      const log = new Logger();
      log.pino = buildMockPino();

      log.info('Selected files:', 32, 'from', 'C:\\Users\\test\\Documents');

      expect(log.pino.info).toHaveBeenCalledWith(
        'Selected files: 32 from [REDACTED_PATH]\\Documents'
      );
    });

    test('info preserves object payloads while sanitizing the message', () => {
      const log = new Logger();
      log.pino = buildMockPino();

      log.info('Watching folder:', 'C:\\Users\\test\\Downloads', { pending: 3 });

      expect(log.pino.info).toHaveBeenCalledWith(
        expect.objectContaining({ pending: 3 }),
        'Watching folder: [REDACTED_PATH]\\Downloads'
      );
    });

    test('renderer transmit skips IPC logging while app is shutting down', () => {
      const originalProcessTypeDescriptor = Object.getOwnPropertyDescriptor(process, 'type');
      const systemLog = jest.fn().mockResolvedValue({ success: true });
      Object.defineProperty(process, 'type', {
        value: 'renderer',
        configurable: true,
        writable: true
      });
      global.window = {
        __STRATOSORT_SHUTTING_DOWN__: true,
        electronAPI: {
          system: {
            log: systemLog
          }
        }
      };

      new Logger();
      const options = pino.mock.calls[pino.mock.calls.length - 1][0];

      options.browser.transmit.send('info', {
        messages: ['Shutting down log', { context: 'Test' }]
      });

      expect(systemLog).not.toHaveBeenCalled();

      if (originalProcessTypeDescriptor) {
        Object.defineProperty(process, 'type', originalProcessTypeDescriptor);
      } else {
        delete process.type;
      }
      delete global.window;
    });

    test('renderer transmit normalization preserves structured payloads when pino/browser sends object first', () => {
      expect(_normalizeBrowserTransmit([{ selected: 3 }, 'Selected files: 3'])).toEqual({
        message: 'Selected files: 3',
        data: { selected: 3 }
      });
    });
  });

  describe('convenience methods', () => {
    test('fileOperation logs through info', () => {
      const log = new Logger();
      log.pino = buildMockPino();
      const infoSpy = jest.spyOn(log, 'info');
      log.fileOperation('move', '/path/to/file.txt', 'success');
      expect(infoSpy).toHaveBeenCalled();
    });

    test('aiAnalysis logs through info', () => {
      const log = new Logger();
      log.pino = buildMockPino();
      const infoSpy = jest.spyOn(log, 'info');
      log.aiAnalysis('/path/to/file.txt', 'llama3', 1500, 85);
      expect(infoSpy).toHaveBeenCalled();
    });

    test('phaseTransition logs through info', () => {
      const log = new Logger();
      log.pino = buildMockPino();
      const infoSpy = jest.spyOn(log, 'info');
      log.phaseTransition('discover', 'organize', { fileCount: 10 });
      expect(infoSpy).toHaveBeenCalled();
    });

    test('performance logs through debug', () => {
      const log = new Logger();
      log.pino = buildMockPino();
      const debugSpy = jest.spyOn(log, 'debug');
      log.performance('file-scan', 250, { files: 100 });
      expect(debugSpy).toHaveBeenCalled();
    });
  });

  describe('createLogger factory', () => {
    test('creates logger with context set', () => {
      const log = createLogger('TestService');
      expect(log.context).toBe('TestService');
    });

    test('inherits level from singleton', () => {
      logger.setLevel('debug');
      const log = createLogger('Test');
      expect(log.level).toBe(logger.level);
    });

    test('creates independent logger instance', () => {
      const log1 = createLogger('A');
      const log2 = createLogger('B');
      expect(log1).not.toBe(log2);
    });
  });

  describe('singleton logger', () => {
    test('logger is a Logger instance', () => {
      expect(logger).toBeInstanceOf(Logger);
    });

    test('singleton persists across requires', () => {
      const module2 = require('../src/shared/logger');
      expect(module2.logger).toBe(logger);
    });
  });

  describe('setGlobalLogLevel (loggingLevel wiring)', () => {
    afterEach(() => {
      // Restore the default so later tests/files are unaffected.
      setGlobalLogLevel('info');
    });

    test('updates the singleton and propagates to existing + future loggers', () => {
      const existing = createLogger('Existing');

      setGlobalLogLevel('debug');

      expect(logger.level).toBe('debug');
      expect(existing.level).toBe('debug');
      // Loggers created after the change inherit the new global level.
      expect(createLogger('Future').level).toBe('debug');
    });

    test('normalizes an unknown level to info', () => {
      setGlobalLogLevel('debug');
      setGlobalLogLevel('verbose');
      expect(logger.level).toBe('info');
    });

    test('ignores empty / non-string input', () => {
      setGlobalLogLevel('warn');
      setGlobalLogLevel('');
      setGlobalLogLevel(null);
      expect(logger.level).toBe('warn');
    });
  });
});
