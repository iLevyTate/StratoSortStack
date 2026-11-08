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

describe('ipcAbortRegistry sender scoping', () => {
  let registry;

  beforeEach(() => {
    jest.resetModules();
    registry = require('../src/main/core/ipcAbortRegistry');
    registry._reset();
  });

  const fromSender = (id) => ({ sender: { id } });

  test('abort message from the registering sender aborts only that request', () => {
    const a = registry.register('rq-s1-a', 'embeddings:search', 1);
    const b = registry.register('rq-s1-b', 'embeddings:search', 1);

    expect(
      registry.handleAbortInvokeMessage(fromSender(1), {
        requestId: 'rq-s1-a',
        channel: 'embeddings:search',
        reason: 'search-superseded'
      })
    ).toBe(true);
    expect(a.aborted).toBe(true);
    expect(a.reason).toBe('search-superseded');
    expect(b.aborted).toBe(false);
  });

  test('abort message from a different webContents is ignored', () => {
    const signal = registry.register('rq-owned-by-1', 'embeddings:search', 1);
    expect(
      registry.handleAbortInvokeMessage(fromSender(2), {
        requestId: 'rq-owned-by-1',
        reason: 'renderer-cancel'
      })
    ).toBe(false);
    expect(signal.aborted).toBe(false);
  });

  test('abort message without a sender id is ignored', () => {
    const signal = registry.register('rq-owned-by-1', 'c', 1);
    expect(registry.handleAbortInvokeMessage({}, { requestId: 'rq-owned-by-1' })).toBe(false);
    expect(registry.handleAbortInvokeMessage(null, { requestId: 'rq-owned-by-1' })).toBe(false);
    expect(signal.aborted).toBe(false);
  });

  test('entries registered without a sender cannot be aborted over IPC', () => {
    const signal = registry.register('rq-no-sender', 'c');
    expect(registry.handleAbortInvokeMessage(fromSender(1), { requestId: 'rq-no-sender' })).toBe(
      false
    );
    expect(signal.aborted).toBe(false);
  });

  test('abort message for an unknown id or malformed payload is ignored', () => {
    const signal = registry.register('rq-known', 'c', 1);
    expect(registry.handleAbortInvokeMessage(fromSender(1), { requestId: 'rq-unknown' })).toBe(
      false
    );
    expect(registry.handleAbortInvokeMessage(fromSender(1), null)).toBe(false);
    expect(registry.handleAbortInvokeMessage(fromSender(1), 'rq-known')).toBe(false);
    expect(registry.handleAbortInvokeMessage(fromSender(1), { requestId: 42 })).toBe(false);
    expect(registry.handleAbortInvokeMessage(fromSender(1), { requestId: 'rq known' })).toBe(false);
    expect(signal.aborted).toBe(false);
  });

  test('abort message naming a different channel than the registered one is ignored', () => {
    const signal = registry.register('rq-chan', 'chat:query-stream', 1);
    expect(
      registry.handleAbortInvokeMessage(fromSender(1), {
        requestId: 'rq-chan',
        channel: 'embeddings:search'
      })
    ).toBe(false);
    expect(signal.aborted).toBe(false);
  });

  test('unsafe or oversized reasons fall back to the default reason', () => {
    const a = registry.register('rq-reason-a', 'c', 1);
    const b = registry.register('rq-reason-b', 'c', 1);
    registry.handleAbortInvokeMessage(fromSender(1), {
      requestId: 'rq-reason-a',
      reason: 'evil\nreason'
    });
    registry.handleAbortInvokeMessage(fromSender(1), {
      requestId: 'rq-reason-b',
      reason: 'x'.repeat(65)
    });
    expect(a.reason).toBe('ipc-timeout');
    expect(b.reason).toBe('ipc-timeout');
  });

  test('a duplicate id from another sender gets no signal and cannot unregister the owner', () => {
    const owner = registry.register('rq-shared', 'c', 1);
    expect(registry.register('rq-shared', 'c', 2)).toBeNull();
    registry.unregister('rq-shared', 2);
    expect(registry.size()).toBe(1);
    expect(registry.handleAbortInvokeMessage(fromSender(1), { requestId: 'rq-shared' })).toBe(true);
    expect(owner.aborted).toBe(true);
  });

  test('internal aborts (shutdown) are not sender-gated', () => {
    const signal = registry.register('rq-internal', 'c', 7);
    expect(registry.abortAll('shutdown')).toBe(1);
    expect(signal.aborted).toBe(true);
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

  test('the wrapper scopes the abort key to the invoking webContents', async () => {
    let capturedSignal;
    let release;
    ipcRegistry.registerHandler(ipcMain, 'test:sender-scoped', async (event) => {
      capturedSignal = event.abortSignal;
      await new Promise((r) => {
        release = r;
      });
      return 'done';
    });

    const envelope = { __stratosortIpcMeta: { requestId: 'rq-sender-1' } };
    const handlerPromise = handlers['test:sender-scoped'](makeEvent(), envelope);
    await new Promise((r) => setTimeout(r, 0));

    // Another window (sender 2) that learned the id cannot cancel it.
    expect(
      abortRegistry.handleAbortInvokeMessage(
        { sender: { id: 2 } },
        { requestId: 'rq-sender-1', channel: 'test:sender-scoped' }
      )
    ).toBe(false);
    expect(capturedSignal.aborted).toBe(false);

    // The invoking window (sender 1) can.
    expect(
      abortRegistry.handleAbortInvokeMessage(
        { sender: { id: 1 } },
        { requestId: 'rq-sender-1', channel: 'test:sender-scoped', reason: 'renderer-cancel' }
      )
    ).toBe(true);
    expect(capturedSignal.aborted).toBe(true);

    release();
    await expect(handlerPromise).resolves.toBe('done');
    expect(abortRegistry.size()).toBe(0);
  });
});
