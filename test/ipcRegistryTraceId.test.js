/**
 * O-3 oracle: ipcRegistry binds the preload meta envelope's traceId (or the
 * requestId fallback) as the logger correlation id for the entire handler
 * run, and strips the envelope so handlers never observe it.
 */

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

describe('ipcRegistry correlation id binding (O-3)', () => {
  let handlers;

  beforeEach(() => {
    jest.resetModules();
    const { registerHandler, setShuttingDown } = require('../src/main/core/ipcRegistry');
    const { getCorrelationId } = require('../src/shared/correlationId');
    setShuttingDown(false);

    handlers = {};
    const ipcMain = {
      handle: jest.fn((channel, handler) => {
        handlers[channel] = handler;
      }),
      removeHandler: jest.fn(),
      on: jest.fn(),
      removeListener: jest.fn()
    };

    registerHandler(ipcMain, 'test:correlation', async (_event, ...args) => ({
      correlationId: getCorrelationId(),
      args
    }));
  });

  test('envelope traceId becomes the handler correlation id', async () => {
    const result = await handlers['test:correlation']({}, 'payload', {
      __stratosortIpcMeta: { requestId: 'rq-1', traceId: 'tr-abc' }
    });

    expect(result.correlationId).toBe('tr-abc');
    // Envelope must be stripped from handler args
    expect(result.args).toEqual(['payload']);
  });

  test('falls back to requestId when no traceId is present', async () => {
    const result = await handlers['test:correlation']({}, 'payload', {
      __stratosortIpcMeta: { requestId: 'rq-fallback-1' }
    });

    expect(result.correlationId).toBe('rq-fallback-1');
  });

  test('rejects malformed traceId and falls back to requestId', async () => {
    const result = await handlers['test:correlation']({}, 'payload', {
      __stratosortIpcMeta: { requestId: 'rq-2', traceId: 'bad trace id with spaces!' }
    });

    expect(result.correlationId).toBe('rq-2');
  });

  test('generates a correlation id when no envelope is present', async () => {
    const result = await handlers['test:correlation']({}, 'payload');

    expect(typeof result.correlationId).toBe('string');
    expect(result.correlationId.length).toBeGreaterThan(0);
    expect(result.args).toEqual(['payload']);
  });
});
