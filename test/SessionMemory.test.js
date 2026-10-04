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

  test('delete removes the session from the LRU', async () => {
    const memory = new SessionMemory();
    await memory.getSessionMemory('gone');
    memory.delete('gone');
    expect(memory.lru.has('gone')).toBe(false);
  });
});
