/**
 * SessionMemory unit tests — LRU sessions, turn window, and history rewrite.
 */

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const { SessionMemory, MAX_SESSIONS } = require('../src/main/services/chat/SessionMemory');

describe('SessionMemory', () => {
  test('reuses the same in-memory buffer for a session id', async () => {
    const memory = new SessionMemory({ memoryWindow: 2 });
    const a = await memory.getSessionMemory('s1');
    const b = await memory.getSessionMemory('s1');
    expect(b).toBe(a);
    expect(a.sessionId).toBe('s1');
  });

  test('evicts the oldest session after MAX_SESSIONS', async () => {
    const persist = jest.fn();
    const memory = new SessionMemory({
      memoryWindow: 1,
      chatHistoryStore: {
        initialize: jest.fn(),
        getConversation: jest.fn(() => null),
        createConversation: persist,
        addMessage: jest.fn()
      }
    });

    for (let i = 0; i < MAX_SESSIONS; i++) {
      const session = await memory.getSessionMemory(`s-${i}`);
      await session.saveContext({ input: `q${i}` }, { output: `a${i}` });
    }

    await memory.getSessionMemory(`s-${MAX_SESSIONS}`);

    expect(memory.lru.has('s-0')).toBe(false);
    expect(memory.lru.has(`s-${MAX_SESSIONS}`)).toBe(true);
  });

  test('dispose() clears the LRU cleanup interval and drops sessions', async () => {
    jest.useFakeTimers();
    try {
      const baseline = jest.getTimerCount();
      const memory = new SessionMemory({ memoryWindow: 2 });
      await memory.getSessionMemory('s1');
      expect(jest.getTimerCount()).toBe(baseline + 1);

      memory.dispose();

      expect(jest.getTimerCount()).toBe(baseline);
      expect(memory.lru.has('s1')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test('saveContext keeps only memoryWindow turns', async () => {
    const memory = new SessionMemory({ memoryWindow: 2 });
    const session = await memory.getSessionMemory('window');

    await session.saveContext({ input: 'q1' }, { output: 'a1' });
    await session.saveContext({ input: 'q2' }, { output: 'a2' });
    await session.saveContext({ input: 'q3' }, { output: 'a3' });

    expect(session._lines).toEqual(['User: q2', 'Assistant: a2', 'User: q3', 'Assistant: a3']);
  });

  test('getHistoryText rewrites citation ids to source names', async () => {
    const memory = new SessionMemory({
      memoryWindow: 4,
      chatHistoryStore: {
        getConversation: () => ({
          messages: [
            { role: 'user', text: 'What did it say?' },
            {
              role: 'assistant',
              text: 'See [doc-1] for the total.',
              sources: [{ id: 'doc-1', name: 'invoice.pdf' }]
            }
          ]
        })
      }
    });
    const session = await memory.getSessionMemory('cite');
    const history = await memory.getHistoryText(session);
    expect(history).toContain('[invoice.pdf]');
    expect(history).not.toContain('[doc-1]');
  });

  /** In-memory stand-in for ChatHistoryStore: conversations keyed by id. */
  function createFakeStore({ failCreate = false } = {}) {
    /** @type {Map<string, { id: string, title: string, documentScope: any[], messages: any[] }>} */
    const conversations = new Map();
    return {
      conversations,
      getConversation: jest.fn((id) => conversations.get(id) || null),
      createConversation: jest.fn((title, documentScope, id) => {
        if (failCreate) throw new Error('Document scope exceeds limit');
        conversations.set(id, { id, title, documentScope, messages: [] });
      }),
      addMessage: jest.fn((id, message) => {
        conversations.get(id).messages.push(message);
      })
    };
  }

  test('retry after a failed first attempt saves the question with the answer', async () => {
    // The failed attempt persisted nothing, so there is no user row to reuse.
    const store = createFakeStore();
    const memory = new SessionMemory({ chatHistoryStore: store });
    const session = await memory.getSessionMemory('retry-new');

    await memory.saveMemoryTurn(
      session,
      'What is in the report?',
      { text: 'A summary.' },
      { skipUserMessage: true }
    );

    expect(store.conversations.get('retry-new').messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'What is in the report?'],
      ['assistant', 'A summary.']
    ]);
  });

  test('retry of a failed follow-up saves the follow-up question', async () => {
    const store = createFakeStore();
    const memory = new SessionMemory({ chatHistoryStore: store });
    const session = await memory.getSessionMemory('retry-followup');
    await memory.saveMemoryTurn(session, 'First question', { text: 'First answer' });

    await memory.saveMemoryTurn(
      session,
      'And the second one?',
      { text: 'Second answer' },
      { skipUserMessage: true }
    );

    const rows = store.conversations.get('retry-followup').messages.map((m) => [m.role, m.text]);
    expect(rows).toEqual([
      ['user', 'First question'],
      ['assistant', 'First answer'],
      ['user', 'And the second one?'],
      ['assistant', 'Second answer']
    ]);
    expect(await memory.getHistoryText(session)).toContain('User: And the second one?');
  });

  test('regenerate does not duplicate a question that is already saved', async () => {
    const store = createFakeStore();
    const memory = new SessionMemory({ chatHistoryStore: store });
    const session = await memory.getSessionMemory('regen');
    await memory.saveMemoryTurn(session, 'Same question', { text: 'First answer' });

    await memory.saveMemoryTurn(
      session,
      'Same question',
      { text: 'Regenerated answer' },
      { skipUserMessage: true }
    );

    const roles = store.conversations.get('regen').messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'assistant']);
  });

  test('follow-ups keep their history when a turn could not be saved', async () => {
    const store = createFakeStore({ failCreate: true });
    const memory = new SessionMemory({ chatHistoryStore: store });
    const session = await memory.getSessionMemory('unsaved');

    await memory.saveMemoryTurn(session, 'First question', { text: 'First answer' });

    const history = await memory.getHistoryText(session);
    expect(history).toContain('User: First question');
    expect(history).toContain('Assistant: First answer');
  });

  test('delete removes the session from the LRU', async () => {
    const memory = new SessionMemory();
    await memory.getSessionMemory('gone');
    memory.delete('gone');
    expect(memory.lru.has('gone')).toBe(false);
  });
});
