/**
 * Live Activity hook on the shared logger: opt-in listeners receive each
 * record after sanitization, only at enabled levels, and can never break the
 * log write they observe.
 */

// test-setup.js mocks the logger globally; this suite exercises the real one.
jest.unmock('../src/shared/logger');

jest.mock('pino', () => {
  const instance = {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
    isLevelEnabled: jest.fn((level) => level !== 'debug' && level !== 'trace'),
    child: jest.fn(function child() {
      return this;
    })
  };
  const pinoMock = jest.fn(() => instance);
  pinoMock.transport = jest.fn(() => ({}));
  pinoMock.destination = jest.fn(() => ({ write: jest.fn(), end: jest.fn() }));
  pinoMock.multistream = jest.fn(() => ({ write: jest.fn(), end: jest.fn() }));
  pinoMock.stdTimeFunctions = { isoTime: () => '' };
  pinoMock.__instance = instance;
  return pinoMock;
});

const pino = require('pino');
const {
  createLogger,
  addLiveRecordListener,
  removeLiveRecordListener
} = require('../src/shared/logger');

describe('logger live record listeners', () => {
  const instance = pino.__instance;
  let registered;

  beforeEach(() => {
    registered = [];
    jest.clearAllMocks();
    instance.isLevelEnabled.mockImplementation((level) => level !== 'debug' && level !== 'trace');
  });

  afterEach(() => {
    for (const fn of registered) removeLiveRecordListener(fn);
  });

  function listen(fn = jest.fn()) {
    registered.push(fn);
    addLiveRecordListener(fn);
    return fn;
  }

  test('a listener receives the sanitized record with context and timestamp', () => {
    const listener = listen();
    const log = createLogger('LiveTest');

    log.info('Saved C:\\Users\\bob\\Documents\\tax.pdf', {
      filePath: '/home/bob/private/doc.txt',
      apiKey: 'sk-secret'
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toEqual({
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      level: 'info',
      context: 'LiveTest',
      msg: 'Saved [REDACTED_PATH]\\tax.pdf',
      data: { filePath: '[REDACTED_PATH]/doc.txt', apiKey: '[REDACTED]' }
    });
  });

  test('records below the enabled level are not delivered', () => {
    const listener = listen();
    const log = createLogger('LiveTest');

    log.debug('quiet detail');
    expect(listener).not.toHaveBeenCalled();

    log.warn('loud problem');
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', msg: 'loud problem', context: 'LiveTest' })
    );
  });

  test('a throwing listener never breaks logging and does not starve other listeners', () => {
    listen(
      jest.fn(() => {
        throw new Error('boom');
      })
    );
    const second = listen();
    const log = createLogger('LiveTest');

    expect(() => log.error('still written')).not.toThrow();
    expect(instance.error).toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', msg: 'still written' })
    );
  });

  test('removed listeners stop receiving records', () => {
    const listener = listen();
    const log = createLogger('LiveTest');
    removeLiveRecordListener(listener);

    log.info('after removal');

    expect(listener).not.toHaveBeenCalled();
  });

  test('with no listener the logger does not even probe the level (zero cost)', () => {
    const log = createLogger('LiveTest');

    log.info('nobody listening');

    expect(instance.isLevelEnabled).not.toHaveBeenCalled();
    expect(instance.info).toHaveBeenCalled();
  });

  test('non-function listeners are ignored', () => {
    addLiveRecordListener(null);
    addLiveRecordListener('not a function');
    const log = createLogger('LiveTest');

    expect(() => log.info('fine')).not.toThrow();
    expect(instance.isLevelEnabled).not.toHaveBeenCalled();
  });
});
