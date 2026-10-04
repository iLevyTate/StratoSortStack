/**
 * ChatService.runOnce (MCP `chat_with_documents`) session isolation.
 *
 * H10: runOnce used to save turns to `_mcpSessions` while `_runRetrieval`
 * read history / registered citations on `_sessions`, so multi-turn
 * `session_id` was a no-op and every MCP call evicted an in-app session.
 *
 * H11: `_mcpSessions` shared the ChatHistoryStore, so each MCP call created a
 * permanent Chat-sidebar conversation and a client-chosen `session_id` could
 * read or append an existing in-app conversation.
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

function answerJson(text) {
  return JSON.stringify({ documentAnswer: [], modelAnswer: [{ text }], followUps: [] });
}

function makeStore() {
  return {
    initialize: jest.fn(async () => undefined),
    getConversation: jest.fn(() => ({
      id: 'in-app-conv',
      title: 'Private in-app chat',
      messages: [
        { role: 'user', text: 'SECRET in-app question' },
        { role: 'assistant', text: 'SECRET in-app answer', sources: [] }
      ]
    })),
    createConversation: jest.fn(),
    addMessage: jest.fn(),
    updateTitle: jest.fn(),
    updateDocumentScope: jest.fn()
  };
}

function makeService({ store = makeStore(), answers = ['first answer', 'second answer'] } = {}) {
  const prompts = [];
  let call = 0;
  const llamaService = {
    generateTextStreaming: jest.fn(async ({ prompt, onToken }) => {
      prompts.push(prompt);
      const response = answerJson(answers[Math.min(call++, answers.length - 1)]);
      onToken?.(response);
      return { response };
    })
  };
  const service = new ChatService({ llamaService, chatHistoryStore: store });
  jest.spyOn(service, '_retrieveSources').mockResolvedValue({
    sources: [{ id: 'doc-1', fileId: 'f1', name: 'a.pdf', path: '/docs/a.pdf', snippet: 's' }],
    meta: {}
  });
  return { service, llamaService, prompts, store };
}

describe('ChatService.runOnce session isolation', () => {
  test('second call with the same session_id sees the first turn in its prompt (H10)', async () => {
    const { service, prompts } = makeService();

    const first = await service.runOnce({ query: 'What is in the Q3 report?', sessionId: 'abc' });
    expect(first.sessionId).toBe('abc');
    expect(first.answer).toContain('first answer');
    expect(prompts[0]).not.toContain('first answer');

    const second = await service.runOnce({ query: 'And the renewal clause?', sessionId: 'abc' });
    expect(second.sessionId).toBe('abc');
    expect(prompts[1]).toContain('What is in the Q3 report?');
    expect(prompts[1]).toContain('first answer');
  });

  test('citation registry lives on the MCP session so ordinals stay stable across turns (H10)', async () => {
    const { service } = makeService();
    await service.runOnce({ query: 'q1', sessionId: 'cite' });
    await service.runOnce({ query: 'q2', sessionId: 'cite' });

    const memory = await service._mcpSessions.getSessionMemory('mcp:cite');
    expect(memory._citationRegistry.map.get('f1')).toBe(1);
    expect(memory._citationRegistry.next).toBe(2);
  });

  test('MCP turns never touch the in-app session LRU (H10)', async () => {
    const { service } = makeService();
    await service.runOnce({ query: 'hello there', sessionId: 'abc' });
    await service.runOnce({ query: 'hello again', sessionId: 'abc' });

    expect(service._sessionLRU.size).toBe(0);
    expect(service._mcpSessions.lru.has('mcp:abc')).toBe(true);
    expect(service._mcpSessions.lru.has('abc')).toBe(false);
  });

  test('a session_id equal to an in-app conversation id neither reads nor appends it (H11)', async () => {
    const { service, prompts, store } = makeService();

    await service.runOnce({ query: 'tell me more', sessionId: 'in-app-conv' });

    // Not read: the in-app history must not leak into the MCP prompt.
    expect(prompts[0]).not.toContain('SECRET');
    // Not appended / not persisted anywhere.
    expect(store.getConversation).not.toHaveBeenCalled();
    expect(store.createConversation).not.toHaveBeenCalled();
    expect(store.addMessage).not.toHaveBeenCalled();
    expect(store.updateTitle).not.toHaveBeenCalled();
  });

  test('auto-generated session ids are also kept out of the history store (H11)', async () => {
    const { service, store } = makeService();
    const result = await service.runOnce({ query: 'one-shot question' });

    expect(result.sessionId).toMatch(/^mcp-\d+$/);
    expect(store.createConversation).not.toHaveBeenCalled();
    expect(store.addMessage).not.toHaveBeenCalled();
    expect(service._sessionLRU.size).toBe(0);
  });
});

describe('ChatService.runOnce citation contract (docs/MCP_SERVER.md)', () => {
  // The engine hands back per-turn ids; the session then remaps them to
  // conversation-scoped ordinals (first-seen order), so the model sees
  // doc-1 = b.pdf, doc-2 = c.pdf, doc-3 = d.pdf for this turn.
  const sources = [
    { id: 'doc-7', fileId: 'f2', name: 'b.pdf', path: '/docs/b.pdf', snippet: 'sb' },
    { id: 'doc-8', fileId: 'f3', name: 'c.pdf', path: '/docs/c.pdf', snippet: 'sc' },
    { id: 'doc-9', fileId: 'f4', name: 'd.pdf', path: '/docs/d.pdf', snippet: 'sd' }
  ];

  function makeServiceWith({ response, retrieval }) {
    const llamaService = {
      generateTextStreaming: jest.fn(async ({ onToken }) => {
        onToken?.(response);
        return { response };
      })
    };
    const service = new ChatService({ llamaService, chatHistoryStore: makeStore() });
    jest.spyOn(service, '_retrieveSources').mockResolvedValue(retrieval);
    return service;
  }

  test('markers are 1-based indexes into citations, in first-use order, inline tokens included', async () => {
    // The engine's doc-N ordinals are conversation-scoped and non-contiguous.
    const service = makeServiceWith({
      retrieval: { sources, meta: {} },
      response: JSON.stringify({
        documentAnswer: [
          { text: 'Renews every 30 days [doc-2] and was signed in August [doc-1].', citations: [] },
          { text: 'Late fees are $40 [doc-3].', citations: ['doc-3'] }
        ],
        modelAnswer: [],
        followUps: []
      })
    });

    const result = await service.runOnce({ query: 'renewal terms?', sessionId: 'cite-order' });

    expect(result.grounded).toBe(true);
    expect(result.answer).toBe(
      'Renews every 30 days [1] and was signed in August [2].\n\nLate fees are $40 [3].'
    );
    expect(result.answer).not.toContain('[doc-');
    expect(result.citations.map((c) => [c.id, c.file_name])).toEqual([
      [1, 'c.pdf'],
      [2, 'b.pdf'],
      [3, 'd.pdf']
    ]);
  });

  test('an answer that cites nothing is reported as ungrounded with no document claims', async () => {
    const service = makeServiceWith({
      retrieval: { sources: [], meta: { resultCount: 0 } },
      response: JSON.stringify({
        documentAnswer: [{ text: 'Your contract renews yearly.', citations: [] }],
        modelAnswer: [{ text: 'I found no matching documents for that.' }],
        followUps: []
      })
    });

    const result = await service.runOnce({ query: 'renewal?', sessionId: 'no-sources' });

    expect(result.grounded).toBe(false);
    expect(result.citations).toEqual([]);
    expect(result.answer).toBe('I found no matching documents for that.');
  });

  test('a failed search is RETRIEVAL_FAILED, not a model-only answer', async () => {
    const service = makeServiceWith({
      retrieval: {
        sources: [],
        meta: { retrievalAvailable: false, error: 'index locked', warning: 'x' }
      },
      response: answerJson('should not be generated')
    });

    await expect(service.runOnce({ query: 'q', sessionId: 'fail' })).rejects.toMatchObject({
      code: 'RETRIEVAL_FAILED',
      message: 'index locked'
    });
    expect(service.llamaService.generateTextStreaming).not.toHaveBeenCalled();
  });

  test('a missing model surfaces as NO_MODEL (the tool maps it to MODEL_NOT_READY)', async () => {
    const service = makeServiceWith({ retrieval: { sources, meta: {} }, response: '' });
    service.llamaService.generateTextStreaming = jest.fn(async () => {
      const err = new Error('No text model configured');
      err.code = 'LLAMA_002';
      throw err;
    });

    await expect(service.runOnce({ query: 'q', sessionId: 'nomodel' })).rejects.toMatchObject({
      code: 'NO_MODEL'
    });
  });
});
