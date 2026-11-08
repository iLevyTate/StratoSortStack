/**
 * A record below the active level is dropped before it is formatted or
 * sanitized, so a disabled logger.debug() in a hot path costs nothing, while
 * records at enabled levels are written exactly as before. Uses the real
 * pino (level semantics included) writing into an in-memory stream.
 */

// test-setup.js mocks the logger globally; this suite exercises the real one.
jest.unmock('../src/shared/logger');

const { Writable } = require('stream');
const pino = require('pino');
const {
  createLogger,
  addLiveRecordListener,
  removeLiveRecordListener
} = require('../src/shared/logger');

/**
 * A logger whose pino writes JSON lines into `lines`, synchronously.
 * @param {string} level
 */
function capturingLogger(level) {
  const lines = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()));
      cb();
    }
  });
  const log = createLogger('LevelTest');
  log.level = level;
  log.pino = pino({ level, base: { context: 'LevelTest' } }, stream);
  return { log, lines };
}

/** An object that counts every read of its one property. */
function countingPayload() {
  const payload = { reads: 0 };
  Object.defineProperty(payload, 'filePath', {
    enumerable: true,
    get() {
      payload.reads += 1;
      return 'C:\\Users\\jdoe\\Docs\\x.pdf';
    }
  });
  return payload;
}

/** A value that counts how often util.format turns it into a string. */
function countingFormatArg() {
  const arg = {
    formats: 0,
    toString() {
      arg.formats += 1;
      return 'arg';
    }
  };
  return arg;
}

describe('logger levels below the active one', () => {
  test('a disabled debug call neither sanitizes its data nor formats its message', () => {
    const { log, lines } = capturingLogger('info');
    const payload = countingPayload();
    const formatArg = countingFormatArg();

    log.debug('value %s', String(formatArg), payload);
    log.debug('only data', payload);
    log.trace('trace data', payload);

    expect(payload.reads).toBe(0);
    expect(formatArg.formats).toBe(1); // the String() call above, nothing more
    expect(lines).toHaveLength(0);
  });

  test('a disabled level is not formatted even when util.format would run', () => {
    const { log } = capturingLogger('warn');
    const formatArg = countingFormatArg();

    log.info('a %s b %s', formatArg, formatArg);

    expect(formatArg.formats).toBe(0);
  });

  test('enabled levels are written sanitized, exactly as before', () => {
    const { log, lines } = capturingLogger('info');

    log.info('Moved C:\\Users\\jdoe\\Inbox\\x.pdf', {
      filePath: '/Users/jdoe/Medical Records/x.pdf',
      byPath: { 'C:\\Users\\jdoe\\Docs\\y.pdf': 'done' }
    });
    log.warn('count %d of %d', 3, 4);
    log.error('plain');

    expect(lines.map((line) => [line.level, line.msg])).toEqual([
      [30, 'Moved [REDACTED_PATH]\\x.pdf'],
      [40, 'count 3 of 4'],
      [50, 'plain']
    ]);
    expect(lines[0].filePath).toBe('[REDACTED_PATH]/x.pdf');
    expect(lines[0].byPath).toEqual({ '[REDACTED_PATH]\\y.pdf': 'done' });
    expect(JSON.stringify(lines)).not.toMatch(/jdoe|Inbox|Medical|Docs/);
  });

  test('raising the level with setLevel starts writing debug records', () => {
    const { log, lines } = capturingLogger('info');
    const payload = countingPayload();

    log.debug('before', payload);
    log.setLevel('debug');
    log.debug('after', payload);

    expect(lines.map((line) => line.msg)).toEqual(['after']);
    expect(lines[0].filePath).toBe('[REDACTED_PATH]\\x.pdf');
    expect(payload.reads).toBe(1);
  });

  test('terminal() at a disabled level skips sanitizing too', () => {
    const { log, lines } = capturingLogger('info');
    const payload = countingPayload();

    log.terminal('debug', 'quiet', payload);
    log.terminal('info', 'loud', payload);

    expect(lines.map((line) => line.msg)).toEqual(['loud']);
    expect(payload.reads).toBe(1);
  });

  test('live listeners still get every enabled record and no disabled one', () => {
    const { log } = capturingLogger('info');
    const listener = jest.fn();
    addLiveRecordListener(listener);
    try {
      log.debug('hidden', { a: 1 });
      log.info('shown', { 'C:\\Users\\jdoe\\Docs\\x.pdf': 'ok' });
    } finally {
      removeLiveRecordListener(listener);
    }

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        level: 'info',
        msg: 'shown',
        data: { '[REDACTED_PATH]\\x.pdf': 'ok' }
      })
    );
  });

  test('in the renderer a record the browser build would still transmit is kept', () => {
    const log = createLogger('LevelTest');
    const values = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
    const fake = { levels: { values }, levelVal: 40, debug: jest.fn(), info: jest.fn() };
    log.pino = /** @type {any} */ (fake);
    // Created at 'info', later raised to 'warn' by setLevel: the browser build
    // keeps transmitting info records to main, so they must still be handed over.
    log._transmitLevel = 'info';

    log.info('transmitted', { filePath: '/home/jdoe/x.pdf' });
    log.debug('dropped', { filePath: '/home/jdoe/x.pdf' });

    expect(fake.info).toHaveBeenCalledWith({ filePath: '[REDACTED_PATH]/x.pdf' }, 'transmitted');
    expect(fake.debug).not.toHaveBeenCalled();
  });

  test('a pino without numeric level fields keeps the old path', () => {
    const log = createLogger('LevelTest');
    const fake = { debug: jest.fn(), info: jest.fn() };
    log.pino = /** @type {any} */ (fake);

    log.debug('still handed to pino', { filePath: '/home/jdoe/x.pdf' });

    expect(fake.debug).toHaveBeenCalledWith(
      { filePath: '[REDACTED_PATH]/x.pdf' },
      'still handed to pino'
    );
  });
});
