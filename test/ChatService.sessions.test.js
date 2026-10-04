/**
 * Tests for ChatService session management and edge cases.
 *
 * Verifies:
 * - Session eviction when MAX_SESSIONS is reached
 * - _isConversational short-circuits on long input (ReDoS prevention)
 * - _isConversational correctly identifies known conversational phrases
 * - _formatForMemory handles empty/null parsed responses
 */

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock('../src/main/utils/jsonRepair', () => ({
  extractAndParseJSON: jest.fn()
}));

const ChatService = require('../src/main/services/ChatService');

function createMinimalService() {
  return new ChatService({
    llamaService: {
      analyzeText: jest.fn().mockResolvedValue({ success: true, response: '{}' })
    }
  });
}

describe('ChatService session management', () => {
  test('evicts oldest session when MAX_SESSIONS is reached', async () => {
    const service = createMinimalService();

    // MAX_SESSIONS is 50; create 50 sessions
    for (let i = 0; i < 50; i++) {
      await service._getSessionMemory(`session-${i}`);
    }
    expect(service._sessionLRU.size).toBe(50);

    // Creating session 51 should evict session-0 (oldest)
    await service._getSessionMemory('session-50');
    expect(service._sessionLRU.size).toBe(50);
    expect(service._sessionLRU.has('session-0')).toBe(false);
    expect(service._sessionLRU.has('session-50')).toBe(true);
  });

  test('evicts least-recently-used session after a refresh (access LRU)', async () => {
    const service = createMinimalService();

    for (let i = 0; i < 50; i++) {
      await service._getSessionMemory(`session-${i}`);
    }
    await service._getSessionMemory('session-0');
    await service._getSessionMemory('session-50');

    expect(service._sessionLRU.has('session-0')).toBe(true);
    expect(service._sessionLRU.has('session-1')).toBe(false);
    expect(service._sessionLRU.has('session-50')).toBe(true);
  });

  test('expires sessions after TTL', async () => {
    jest.useFakeTimers();
    const service = createMinimalService();
    const t0 = 1_700_000_000_000;
    jest.setSystemTime(t0);

    await service._getSessionMemory('ttl-session');
    expect(service._sessionLRU.has('ttl-session')).toBe(true);

    jest.setSystemTime(t0 + 60 * 60 * 1000 + 1);
    expect(service._sessionLRU.get('ttl-session')).toBeNull();
    jest.useRealTimers();
  });

  // The LlamaService swap in src/main/ipc/chat.js disposes and rebuilds the
  // ChatService; every timer dispose() misses leaks once per swap.
  test('dispose() releases every timer the constructor installed', () => {
    jest.useFakeTimers();
    try {
      const baseline = jest.getTimerCount();
      const service = createMinimalService();
      expect(jest.getTimerCount()).toBeGreaterThan(baseline);

      service.dispose();

      expect(jest.getTimerCount()).toBe(baseline);
    } finally {
      jest.useRealTimers();
    }
  });

  test('persists evicted in-memory lines to chatHistoryStore', async () => {
    const store = {
      initialize: jest.fn().mockResolvedValue(undefined),
      getConversation: jest.fn(() => null),
      createConversation: jest.fn(),
      addMessage: jest.fn()
    };
    const service = new ChatService({
      llamaService: { analyzeText: jest.fn().mockResolvedValue({ success: true, response: '{}' }) },
      chatHistoryStore: store
    });

    const memory = service._createMemory('evict-me');
    await memory.saveContext({ input: 'Hi' }, { output: 'Hello' });

    await service._persistEvictedInMemorySession('evict-me', memory);

    expect(store.createConversation).toHaveBeenCalled();
    expect(store.addMessage).toHaveBeenCalledWith(
      'evict-me',
      expect.objectContaining({ role: 'user', text: 'Hi' })
    );
    expect(store.addMessage).toHaveBeenCalledWith(
      'evict-me',
      expect.objectContaining({ role: 'assistant', text: 'Hello' })
    );
  });

  test('_saveMemoryTurn skips the user row on regenerate (skipUserMessage)', async () => {
    const store = {
      initialize: jest.fn().mockResolvedValue(undefined),
      getConversation: jest.fn(() => ({ id: 'regen', title: 'Existing' })),
      createConversation: jest.fn(),
      addMessage: jest.fn()
    };
    const service = new ChatService({
      llamaService: { analyzeText: jest.fn().mockResolvedValue({ success: true, response: '{}' }) },
      chatHistoryStore: store
    });

    const memory = await service._getSessionMemory('regen');
    await service._saveMemoryTurn(
      memory,
      'same question again',
      { text: 'regenerated answer' },
      { skipUserMessage: true }
    );

    const roles = store.addMessage.mock.calls.map(([, msg]) => msg.role);
    expect(roles).toEqual(['assistant']);
  });

  test('reuses existing session instead of creating new', async () => {
    const service = createMinimalService();
    const mem1 = await service._getSessionMemory('test-session');
    const mem2 = await service._getSessionMemory('test-session');
    expect(mem1).toBe(mem2);
  });

  test('uses "default" key when sessionId is null/undefined', async () => {
    const service = createMinimalService();
    const mem1 = await service._getSessionMemory(null);
    const mem2 = await service._getSessionMemory(undefined);
    expect(mem1).toBe(mem2);
    expect(service._sessionLRU.has('default')).toBe(true);
  });

  test('resetSession removes the session', async () => {
    const service = createMinimalService();
    await service._getSessionMemory('to-delete');
    expect(service._sessionLRU.has('to-delete')).toBe(true);

    await service.resetSession('to-delete');
    expect(service._sessionLRU.has('to-delete')).toBe(false);
  });
});

describe('ChatService _isConversational', () => {
  let service;

  beforeEach(() => {
    service = createMinimalService();
  });

  test('returns true for known greetings', () => {
    expect(service._isConversational('hello')).toBe(true);
    expect(service._isConversational('Hi')).toBe(true);
    expect(service._isConversational('HEY')).toBe(true);
    expect(service._isConversational('good morning')).toBe(true);
    expect(service._isConversational('thanks')).toBe(true);
    expect(service._isConversational('thank you')).toBe(true);
    expect(service._isConversational('who are you')).toBe(true);
    expect(service._isConversational('what can you do')).toBe(true);
  });

  test('returns false for non-conversational queries', () => {
    expect(service._isConversational('find my tax returns')).toBe(false);
    expect(service._isConversational('search for documents about AI')).toBe(false);
  });

  test('strips punctuation before matching', () => {
    expect(service._isConversational('hello!')).toBe(true);
    expect(service._isConversational('thanks!!!')).toBe(true);
    expect(service._isConversational('hi...')).toBe(true);
  });

  test('short-circuits on long input to prevent ReDoS', () => {
    // A string > 100 chars should return false immediately
    const longString = 'a'.repeat(200);
    const start = Date.now();
    const result = service._isConversational(longString);
    const elapsed = Date.now() - start;

    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(10); // Should be near-instant
  });

  test('handles edge cases gracefully', () => {
    expect(service._isConversational('')).toBe(false);
    expect(service._isConversational('   ')).toBe(false);
  });
});

describe('ChatService _formatForMemory', () => {
  let service;

  beforeEach(() => {
    service = createMinimalService();
  });

  test('combines document and model answers', () => {
    const parsed = {
      documentAnswer: [{ text: 'Doc info' }],
      modelAnswer: [{ text: 'Model response' }],
      followUps: []
    };
    expect(service._formatForMemory(parsed)).toBe('Doc info\nModel response');
  });

  test('returns fallback when both answer arrays are empty', () => {
    const parsed = {
      documentAnswer: [],
      modelAnswer: [],
      followUps: []
    };
    expect(service._formatForMemory(parsed)).toBe('No answer produced.');
  });

  test('handles null/undefined answer arrays', () => {
    const parsed = {};
    expect(service._formatForMemory(parsed)).toBe('No answer produced.');
  });
});

describe('ChatService fallback memory', () => {
  test('memory window limits stored turns', async () => {
    const service = createMinimalService();
    const memory = await service._getSessionMemory('test');

    // DEFAULTS.memoryWindow is 6, so we can store 6 turns (12 lines)
    for (let i = 0; i < 10; i++) {
      await memory.saveContext({ input: `Question ${i}` }, { output: `Answer ${i}` });
    }

    const { history } = await memory.loadMemoryVariables({});
    // Should only contain the last 6 turns
    expect(history).not.toContain('Question 0');
    expect(history).not.toContain('Question 3');
    expect(history).toContain('Question 4');
    expect(history).toContain('Answer 9');
  });
});

// Stable citation ids: the same document must keep its doc-N number across
// turns of a conversation. Pre-fix, RetrievalEngine renumbered sequentially
// per turn, so doc-2 in turn 1 could be a different file than doc-2 in
// turn 2 — confusing across bubbles and for the model.
describe('ChatService stable citation ids', () => {
  const src = (fileId, extra = {}) => ({
    id: 'doc-999', // provisional per-turn id from the engine; must be replaced
    fileId,
    name: `${fileId}.pdf`,
    path: `/docs/${fileId}.pdf`,
    ...extra
  });

  test('first-seen ordinals are stable across turns; new docs extend the sequence', async () => {
    const service = createMinimalService();
    const memory = await service._getSessionMemory('stable-cite');

    const turn1 = service._sessions.applyStableCitationIds(memory, [src('A'), src('B')]);
    expect(turn1.map((s) => s.id)).toEqual(['doc-1', 'doc-2']);

    // Turn 2 retrieves B (again) and C (new): B keeps doc-2, C gets doc-3.
    const turn2 = service._sessions.applyStableCitationIds(memory, [src('B'), src('C')]);
    expect(turn2.map((s) => s.id)).toEqual(['doc-2', 'doc-3']);

    // Order within a turn does not disturb assignments.
    const turn3 = service._sessions.applyStableCitationIds(memory, [src('C'), src('A')]);
    expect(turn3.map((s) => s.id)).toEqual(['doc-3', 'doc-1']);
  });

  test('registry rehydrates from persisted history after eviction/restart', async () => {
    const store = {
      getConversation: jest.fn().mockReturnValue({
        messages: [
          {
            role: 'assistant',
            sources: [
              { id: 'doc-1', fileId: 'A' },
              { id: 'doc-2', fileId: 'B' }
            ]
          }
        ]
      })
    };
    const service = new ChatService({
      llamaService: { analyzeText: jest.fn() },
      chatHistoryStore: store
    });

    // Fresh memory (post-eviction / post-restart): the registry must be
    // seeded from the stored messages' sources, so B keeps doc-2 and a new
    // doc continues at doc-3.
    const memory = await service._getSessionMemory('rehydrated-session');
    const turn = service._sessions.applyStableCitationIds(memory, [src('B'), src('NEW')]);
    expect(turn.map((s) => s.id)).toEqual(['doc-2', 'doc-3']);
  });

  test('legacy per-turn renumbered history rehydrates with UNIQUE ordinals (no duplicate doc-N)', async () => {
    // Legacy conversations were renumbered per turn, so two different files
    // can both be stored as doc-1. Rehydration must not give both the same
    // registry ordinal — CitationRenderer's id->source Map is last-one-wins,
    // so duplicate ids open the wrong document on click.
    const store = {
      getConversation: jest.fn().mockReturnValue({
        messages: [
          { role: 'assistant', sources: [{ id: 'doc-1', fileId: 'A' }] },
          {
            role: 'assistant',
            sources: [
              { id: 'doc-1', fileId: 'B' }, // legacy collision with A
              { id: 'doc-2', fileId: 'C' }
            ]
          }
        ]
      })
    };
    const service = new ChatService({
      llamaService: { analyzeText: jest.fn() },
      chatHistoryStore: store
    });

    const memory = await service._getSessionMemory('legacy-collide');
    const turn = service._sessions.applyStableCitationIds(memory, [
      src('A'),
      src('B'),
      src('C'),
      src('NEW')
    ]);
    const ids = turn.map((s) => s.id);

    // First mapping wins: A keeps doc-1. B collided on doc-1 and is
    // renumbered to the next free ordinal. Every id is unique and NEW
    // continues the sequence.
    expect(ids[0]).toBe('doc-1');
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['doc-1', 'doc-2', 'doc-3', 'doc-4']);
  });

  test('legacy renumberings of the SAME document keep first ordinal and reserve later ones', async () => {
    const store = {
      getConversation: jest.fn().mockReturnValue({
        messages: [
          { role: 'assistant', sources: [{ id: 'doc-1', fileId: 'A' }] },
          // Same file renumbered by a legacy turn — first-seen mapping wins,
          // but doc-2 already appears in persisted messages, so no future
          // document may be assigned it.
          { role: 'assistant', sources: [{ id: 'doc-2', fileId: 'A' }] }
        ]
      })
    };
    const service = new ChatService({
      llamaService: { analyzeText: jest.fn() },
      chatHistoryStore: store
    });

    const memory = await service._getSessionMemory('legacy-same-doc');
    const turn = service._sessions.applyStableCitationIds(memory, [src('A'), src('NEW')]);
    expect(turn.map((s) => s.id)).toEqual(['doc-1', 'doc-3']);
  });

  test('sources without any stable key pass through unchanged', async () => {
    const service = createMinimalService();
    const memory = await service._getSessionMemory('no-key');
    const bare = { id: 'doc-1', name: 'x' };
    const out = service._sessions.applyStableCitationIds(memory, [bare]);
    // No fileId/path — cannot be tracked across turns; keep the engine id.
    expect(out[0].id).toBe('doc-1');
  });
});
