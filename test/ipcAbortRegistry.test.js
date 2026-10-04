/**
 * Tests for IPC abort propagation between preload and main.
 *
 * Covers:
 *  - `ipcAbortRegistry` register/abort/unregister/abortAll semantics.
 *  - `ipcRegistry.registerHandler` strips the preload envelope, keeps it
 *    invisible to handlers, and exposes the abort signal via `event.abortSignal`.
 *  - An aborted request propagates through the signal, letting handlers bail.
 */

jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

jest.mock('../src/main/ipc/ipcSenderValidator', () => ({
  assertAllowedIpcSender: jest.fn(() => null)
}));

describe('ipcAbortRegistry', () => {
  let registry;

  beforeEach(() => {
    jest.resetModules();
    registry = require('../src/main/core/ipcAbortRegistry');
    registry._reset();
  });

  test('register + abort delivers the configured reason to the signal', () => {
    const signal = registry.register('rq-abc-1', 'chat:query-stream');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);

    const didAbort = registry.abort('rq-abc-1', 'ipc-timeout');
    expect(didAbort).toBe(true);
    expect(signal.aborted).toBe(true);
    // Node reflects the reason via `signal.reason` when supplied to `abort()`.
    expect(signal.reason).toBe('ipc-timeout');
  });

  test('abort is a no-op for unknown request ids', () => {
    expect(registry.abort('rq-missing', 'timeout')).toBe(false);
  });

  test('unregister drops the entry so later aborts are no-ops', () => {
    const signal = registry.register('rq-xyz', 'channel');
    registry.unregister('rq-xyz');
    const didAbort = registry.abort('rq-xyz', 'late');
    expect(didAbort).toBe(false);
    expect(signal.aborted).toBe(false);
  });

  test('rejects invalid request ids to prevent unbounded growth', () => {
    // Empty, too long, or containing unsafe characters must be rejected so a
    // compromised renderer cannot exhaust the map or inject log noise.
    expect(registry.register('', 'c')).toBeNull();
    expect(registry.register('rq with space', 'c')).toBeNull();
    expect(registry.register('rq\n-evil', 'c')).toBeNull();
    expect(registry.register('a'.repeat(200), 'c')).toBeNull();
    expect(registry.size()).toBe(0);
  });

  test('duplicate registrations return the existing signal without replacing it', () => {
    const first = registry.register('rq-dup', 'c');
    const second = registry.register('rq-dup', 'c');
    expect(second).toBe(first);
    expect(registry.size()).toBe(1);
  });

  test('abortAll fans out to every tracked entry', () => {
    const a = registry.register('rq-a', 'c1');
    const b = registry.register('rq-b', 'c2');
    const count = registry.abortAll('shutdown');
    expect(count).toBe(2);
    expect(a.aborted).toBe(true);
    expect(b.aborted).toBe(true);
    expect(a.reason).toBe('shutdown');
  });
});

describe('ipcRegistry abort envelope stripping', () => {
  let ipcRegistry;
  let abortRegistry;
  let ipcMain;
  let handlers;

  const makeEvent = () => ({
    sender: { id: 1, getURL: () => 'file:///' }
  });

  beforeEach(() => {
    jest.resetModules();
    ipcRegistry = require('../src/main/core/ipcRegistry');
    abortRegistry = require('../src/main/core/ipcAbortRegistry');
    abortRegistry._reset();
    ipcRegistry.setShuttingDown(false);

    handlers = {};
    ipcMain = {
      handle: jest.fn((channel, handler) => {
        handlers[channel] = handler;
      }),
      removeHandler: jest.fn(),
      on: jest.fn(),
      removeListener: jest.fn()
    };
  });

  test('envelope is hidden from the handler and abortSignal is attached to event', async () => {
    let observedArgs;
    let observedSignal;

    ipcRegistry.registerHandler(ipcMain, 'test:abortable', async (event, ...args) => {
      observedArgs = args;
      observedSignal = event.abortSignal;
      return { ok: true };
    });

    const payload = { query: 'hello' };
    const envelope = { __stratosortIpcMeta: { requestId: 'rq-strip-1' } };

    const event = makeEvent();
    const result = await handlers['test:abortable'](event, payload, envelope);

    expect(result).toEqual({ ok: true });
    // Handler must see only the real payload — envelope was stripped.
    expect(observedArgs).toEqual([payload]);
    // Handler can opt in to cancellation via `event.abortSignal`.
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal.aborted).toBe(false);
    // Registry entry must be cleaned up after the handler resolves.
    expect(abortRegistry.size()).toBe(0);
  });

  test('calls without the envelope behave exactly as before (backwards compatible)', async () => {
    let observedArgs;
    let observedSignal;

    ipcRegistry.registerHandler(ipcMain, 'test:legacy', async (event, ...args) => {
      observedArgs = args;
      observedSignal = event.abortSignal;
      return 'legacy-ok';
    });

    const result = await handlers['test:legacy'](makeEvent(), 'plain-arg');

    expect(result).toBe('legacy-ok');
    expect(observedArgs).toEqual(['plain-arg']);
    // No envelope => no abort registration => no signal exposed.
    expect(observedSignal).toBeUndefined();
    expect(abortRegistry.size()).toBe(0);
  });

  test('trailing object that is not an envelope is passed through untouched', async () => {
    let observedArgs;

    ipcRegistry.registerHandler(ipcMain, 'test:passthrough', async (_event, ...args) => {
      observedArgs = args;
      return null;
    });

    const trailingObject = { foo: 'bar', __stratosortIpcMeta: { requestId: 'nested' } };
    await handlers['test:passthrough'](makeEvent(), trailingObject);

    // The envelope detection requires the trailing object to have ONLY the
    // meta key, so a legitimate trailing object that happens to carry that
    // field must still be delivered to the handler.
    expect(observedArgs).toEqual([trailingObject]);
    expect(abortRegistry.size()).toBe(0);
  });

  test('renderer-supplied traceId becomes the handler correlation id', async () => {
    const { getCorrelationId } = require('../src/shared/correlationId');
    let observedCorrelationId;

    ipcRegistry.registerHandler(ipcMain, 'test:trace', async () => {
      observedCorrelationId = getCorrelationId();
      return { ok: true };
    });

    const envelope = {
      __stratosortIpcMeta: {
        requestId: 'rq-trace-1',
        traceId: 'tr-user-action-42'
      }
    };
    await handlers['test:trace'](makeEvent(), envelope);

    // Trace id takes precedence over the auto-generated correlation id so
    // that logs across multiple invokes in the same user action group.
    expect(observedCorrelationId).toBe('tr-user-action-42');
  });

  test('invalid trace id is rejected and correlation falls back to requestId', async () => {
    const { getCorrelationId } = require('../src/shared/correlationId');
    let observedCorrelationId;

    ipcRegistry.registerHandler(ipcMain, 'test:trace-invalid', async () => {
      observedCorrelationId = getCorrelationId();
      return null;
    });

    const envelope = {
      __stratosortIpcMeta: {
        requestId: 'rq-valid-1',
        // Unsafe trace id (contains a newline) must not land in log context.
        traceId: 'tr\nevil'
      }
    };
    await handlers['test:trace-invalid'](makeEvent(), envelope);

    expect(observedCorrelationId).toBe('rq-valid-1');
  });

  test('aborting mid-handler flips event.abortSignal so handlers can bail', async () => {
    let capturedSignal;
    let finished = false;

    ipcRegistry.registerHandler(ipcMain, 'test:cooperative', async (event) => {
      capturedSignal = event.abortSignal;
      // Simulate a long-running operation that polls the signal.
      await new Promise((resolve, reject) => {
        const interval = setInterval(() => {
          if (event.abortSignal?.aborted) {
            clearInterval(interval);
            reject(new Error('aborted'));
          }
        }, 5);
        if (interval && typeof interval.unref === 'function') interval.unref();
      }).catch((err) => {
        finished = true;
        throw err;
      });
    });

    const envelope = { __stratosortIpcMeta: { requestId: 'rq-coop-1' } };
    const handlerPromise = handlers['test:cooperative'](makeEvent(), envelope);

    // Simulate the preload's timeout firing by sending an abort through the
    // same path the ABORT_INVOKE listener uses.
    await new Promise((r) => setTimeout(r, 10));
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal.aborted).toBe(false);
    expect(abortRegistry.abort('rq-coop-1', 'ipc-timeout')).toBe(true);

    await expect(handlerPromise).rejects.toThrow('aborted');
    expect(finished).toBe(true);
    // Registry cleanup still happens in `finally`.
    expect(abortRegistry.size()).toBe(0);
  });
});
