/**
 * A Stop or a conversation delete while chat is still retrieving sources must
 * not persist anything. Retrieval ignores the stream signal, so the cancel
 * used to surface later as the local queue's INFERENCE_SLOT_ABORTED (a plain
 * Error, not an AbortError). The catch then saved an "Error: Inference slot
 * aborted..." turn and, for a deleted conversation, recreated it.
 */

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const ChatService = require('../src/main/services/ChatService');

function slotAbortedError() {
  const err = new Error('Inference slot aborted before queuing (text)');
  err.code = 'INFERENCE_SLOT_ABORTED';
  return err;
}

function makeService({ generate } = {}) {
  const store = {
    initialize: jest.fn(async () => undefined),
    // The conversation was deleted (or never existed yet).
    getConversation: jest.fn(() => null),
    createConversation: jest.fn(),
    addMessage: jest.fn(),
    updateTitle: jest.fn()
  };
  const llamaService = {
    generateTextStreaming: jest.fn(
      generate ||
        (async () => {
          throw slotAbortedError();
        })
    )
  };
  const service = new ChatService({ llamaService, chatHistoryStore: store });
  jest.spyOn(service, '_resolveGenerateBackend').mockReturnValue(null);
  return { service, store, llamaService };
}

function deferredRetrieval(service, sessionId) {
  let resolve;
  const pending = new Promise((r) => {
    resolve = r;
  });
  jest.spyOn(service, '_runRetrieval').mockImplementation(async () => {
    await pending;
    return {
      retrieval: { sources: [], meta: {} },
      prompt: 'p',
      memory: { sessionId, _lines: [] }
    };
  });
  return () => resolve();
}

function expectNothingPersisted(store) {
  expect(store.createConversation).not.toHaveBeenCalled();
  expect(store.addMessage).not.toHaveBeenCalled();
}

describe('ChatService.queryStreaming cancel while retrieving', () => {
  test('Stop during retrieval saves no error turn and reports a cancel', async () => {
    const { service, store, llamaService } = makeService();
    const finishRetrieval = deferredRetrieval(service, 'conv-1');
    const events = [];
    const run = service.queryStreaming({
      sessionId: 'conv-1',
      requestId: 'r1',
      query: 'what does the lease say about pets?',
      onEvent: (evt) => events.push(evt)
    });

    await service.cancelStreamingRequest({ requestId: 'r1' });
    finishRetrieval();
    await run;

    expectNothingPersisted(store);
    expect(llamaService.generateTextStreaming).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'error')).toEqual([
      { type: 'error', error: 'Generation canceled' }
    ]);
  });

  test('deleting the conversation during retrieval does not recreate it, even with strictScope', async () => {
    const { service, store } = makeService();
    const finishRetrieval = deferredRetrieval(service, 'conv-2');
    const run = service.queryStreaming({
      sessionId: 'conv-2',
      requestId: 'r2',
      query: 'summarize the selected contract',
      strictScope: true,
      onEvent: () => {}
    });

    await service.resetSession('conv-2');
    finishRetrieval();
    await run;

    expectNothingPersisted(store);
  });

  test('a slot-aborted error after a cancel during generation saves nothing', async () => {
    const { service, store } = makeService({
      generate: async () => {
        await service.cancelStreamingRequest({ requestId: 'r3' });
        throw slotAbortedError();
      }
    });
    deferredRetrieval(service, 'conv-3')();
    const events = [];
    await service.queryStreaming({
      sessionId: 'conv-3',
      requestId: 'r3',
      query: 'what does the lease say about pets?',
      onEvent: (evt) => events.push(evt)
    });

    expectNothingPersisted(store);
    expect(events.find((e) => e.type === 'error')?.error).toBe('Generation canceled');
  });

  test('a real generation failure still saves the error turn', async () => {
    const { service, store } = makeService({
      generate: async () => {
        throw new Error('model crashed');
      }
    });
    deferredRetrieval(service, 'conv-4')();
    const events = [];
    await service.queryStreaming({
      sessionId: 'conv-4',
      requestId: 'r4',
      query: 'what does the lease say about pets?',
      onEvent: (evt) => events.push(evt)
    });

    const assistantRows = store.addMessage.mock.calls
      .map(([, msg]) => msg)
      .filter((m) => m.role === 'assistant');
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0].modelAnswer[0].text).toContain('model crashed');
    expect(events.find((e) => e.type === 'error')?.error).toBe('model crashed');
  });

  test('the conversational path reports a cancel, not a failure', async () => {
    const { service, store } = makeService({
      generate: async () => {
        await service.cancelStreamingRequest({ requestId: 'r5' });
        throw slotAbortedError();
      }
    });
    jest.spyOn(service, '_isConversational').mockReturnValue(true);
    const events = [];
    await service.queryStreaming({
      sessionId: 'conv-5',
      requestId: 'r5',
      query: 'hello there',
      onEvent: (evt) => events.push(evt)
    });

    expect(store.addMessage).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'error')?.error).toBe('Generation canceled');
  });
});
