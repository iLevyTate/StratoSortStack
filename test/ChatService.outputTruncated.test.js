/**
 * H13: a cloud provider hitting its output token cap now resolves the stream
 * with `truncated: true` instead of throwing OUTPUT_TRUNCATED after every
 * token was already delivered. ChatService must keep the streamed answer and
 * append a short notice — not persist "Error: max_tokens…" and discard it.
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

const NOTICE_RE = /Response cut short.*output token limit/;

function answerJson(text) {
  return JSON.stringify({ documentAnswer: [], modelAnswer: [{ text }], followUps: [] });
}

function makeCloudProvider({ text, truncated }) {
  return {
    id: 'openai',
    chatStream: jest.fn(async ({ onToken }) => {
      onToken?.(text);
      return { text, truncated };
    })
  };
}

function makeService(cloudProvider) {
  const store = {
    initialize: jest.fn(async () => undefined),
    getConversation: jest.fn(() => null),
    createConversation: jest.fn(),
    addMessage: jest.fn(),
    updateTitle: jest.fn()
  };
  const llamaService = { generateTextStreaming: jest.fn() };
  const service = new ChatService({ llamaService, chatHistoryStore: store });
  jest.spyOn(service, '_resolveGenerateBackend').mockReturnValue(cloudProvider);
  jest.spyOn(service, '_retrieveSources').mockResolvedValue({ sources: [], meta: {} });
  return { service, store, llamaService };
}

describe('ChatService cloud output truncation notice', () => {
  test('_streamWithLocalFallback surfaces truncated:true without falling back to local', async () => {
    const { service, llamaService } = makeService(null);
    const result = await service._streamWithLocalFallback({
      cloudProvider: makeCloudProvider({ text: 'partial', truncated: true }),
      prompt: 'p',
      signal: new AbortController().signal,
      onToken: () => {}
    });
    expect(result).toEqual({ text: 'partial', viaFallback: false, truncated: true });
    expect(llamaService.generateTextStreaming).not.toHaveBeenCalled();
  });

  test('queryStreaming keeps the streamed answer and appends the notice to done + persisted turn', async () => {
    const answer = answerJson('The contract renews every 30 days and');
    const { service, store } = makeService(makeCloudProvider({ text: answer, truncated: true }));

    const events = [];
    await service.queryStreaming({
      sessionId: 'trunc-session',
      requestId: 'r1',
      query: 'what does the contract say about renewal?',
      onEvent: (evt) => events.push(evt)
    });

    expect(events.some((e) => e.type === 'error')).toBe(false);
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    const texts = done.response.modelAnswer.map((m) => m.text);
    expect(texts[0]).toContain('renews every 30 days');
    expect(texts.at(-1)).toMatch(NOTICE_RE);

    const assistantRows = store.addMessage.mock.calls
      .map(([, msg]) => msg)
      .filter((m) => m.role === 'assistant');
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0].text).toContain('renews every 30 days');
    expect(assistantRows[0].text).toMatch(NOTICE_RE);
    expect(assistantRows[0].text).not.toMatch(/^Error:/);
  });

  test('queryStreaming adds no notice when the stream completed normally', async () => {
    const { service } = makeService(
      makeCloudProvider({ text: answerJson('complete answer'), truncated: false })
    );
    const events = [];
    await service.queryStreaming({
      sessionId: 's',
      requestId: 'r2',
      query: 'summarize the report please',
      onEvent: (evt) => events.push(evt)
    });
    const done = events.find((e) => e.type === 'done');
    expect(done.response.modelAnswer.map((m) => m.text)).toEqual(['complete answer']);
  });

  test('runOnce returns the truncated cloud answer with the notice instead of RETRIEVAL_FAILED', async () => {
    const { service } = makeService(
      makeCloudProvider({ text: answerJson('cut-short answer'), truncated: true })
    );
    const result = await service.runOnce({ query: 'what happened?', sessionId: 'once' });
    expect(result.answer).toContain('cut-short answer');
    expect(result.answer).toMatch(NOTICE_RE);
  });
});
