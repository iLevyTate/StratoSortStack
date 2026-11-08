/**
 * The local model stops at a clamped output-token cap on small-context
 * profiles. When LlamaService reports that stop (`{ response, truncated: true }`)
 * chat must tell the user the answer was cut short, exactly as it does for a
 * cloud provider, on every streaming path (chat tab, cloud->local fallback,
 * MCP runOnce).
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

const LOCAL_NOTICE_RE = /Response cut short: the local model reached its output token limit/;

function answerJson(text) {
  return JSON.stringify({ documentAnswer: [], modelAnswer: [{ text }], followUps: [] });
}

function makeService({ truncated, text = answerJson('The lease allows one cat and') } = {}) {
  const store = {
    initialize: jest.fn(async () => undefined),
    getConversation: jest.fn(() => null),
    createConversation: jest.fn(),
    addMessage: jest.fn(),
    updateTitle: jest.fn()
  };
  const llamaService = {
    generateTextStreaming: jest.fn(async ({ onToken }) => {
      onToken?.(text);
      return { response: text, truncated };
    }),
    analyzeText: jest.fn(async () => ({ success: true, response: text, truncated }))
  };
  const service = new ChatService({ llamaService, chatHistoryStore: store });
  jest.spyOn(service, '_resolveGenerateBackend').mockReturnValue(null);
  jest.spyOn(service, '_retrieveSources').mockResolvedValue({ sources: [], meta: {} });
  return { service, store, llamaService };
}

describe('ChatService local output truncation notice', () => {
  test('_streamWithLocalFallback reports a local max-token stop', async () => {
    const { service } = makeService({ truncated: true });
    const result = await service._streamWithLocalFallback({
      cloudProvider: null,
      prompt: 'p',
      signal: new AbortController().signal,
      onToken: () => {}
    });
    expect(result.truncated).toBe(true);
    expect(result.viaFallback).toBe(false);
  });

  test('queryStreaming appends the local notice to done and to the persisted turn', async () => {
    const { service, store } = makeService({ truncated: true });
    const events = [];
    await service.queryStreaming({
      sessionId: 'local-trunc',
      requestId: 'r1',
      query: 'what does the lease say about pets?',
      onEvent: (evt) => events.push(evt)
    });

    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    const texts = done.response.modelAnswer.map((m) => m.text);
    expect(texts[0]).toContain('allows one cat');
    expect(texts.at(-1)).toMatch(LOCAL_NOTICE_RE);

    const assistantRows = store.addMessage.mock.calls
      .map(([, msg]) => msg)
      .filter((m) => m.role === 'assistant');
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0].text).toMatch(LOCAL_NOTICE_RE);
  });

  test('no notice when the local model finished normally', async () => {
    const { service } = makeService({ truncated: false, text: answerJson('complete answer') });
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

  test('runOnce on the local model returns the notice with the cut-short answer', async () => {
    const { service } = makeService({ truncated: true, text: answerJson('cut-short answer') });
    const result = await service.runOnce({ query: 'what happened?', sessionId: 'once' });
    expect(result.answer).toContain('cut-short answer');
    expect(result.answer).toMatch(LOCAL_NOTICE_RE);
  });

  test('query() on the local model appends the notice to a cut-short answer', async () => {
    const { service, store } = makeService({
      truncated: true,
      text: answerJson('cut-short answer')
    });
    jest.spyOn(service, '_runRetrieval').mockResolvedValue({
      retrieval: { sources: [], meta: {} },
      prompt: 'p',
      memory: null
    });
    jest.spyOn(service, '_saveMemoryTurn').mockResolvedValue(undefined);
    const result = await service.query({ sessionId: 'q', query: 'what does the lease say?' });
    expect(result.success).toBe(true);
    const texts = result.response.modelAnswer.map((m) => m.text);
    expect(texts[0]).toBe('cut-short answer');
    expect(texts.at(-1)).toMatch(LOCAL_NOTICE_RE);
    expect(service._saveMemoryTurn.mock.calls[0][2].text).toMatch(LOCAL_NOTICE_RE);
    void store;
  });

  test('query() adds no notice when the local model finished normally', async () => {
    const { service } = makeService({ truncated: false, text: answerJson('complete answer') });
    jest.spyOn(service, '_runRetrieval').mockResolvedValue({
      retrieval: { sources: [], meta: {} },
      prompt: 'p',
      memory: null
    });
    jest.spyOn(service, '_saveMemoryTurn').mockResolvedValue(undefined);
    const result = await service.query({ sessionId: 'q2', query: 'what does the lease say?' });
    expect(result.response.modelAnswer.map((m) => m.text)).toEqual(['complete answer']);
  });
});
