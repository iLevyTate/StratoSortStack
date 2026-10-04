/**
 * @jest-environment node
 *
 * Unit tests for ChatHistoryStore input-size validation. The store rejects
 * over-sized titles, document scopes, and message payloads with a structured
 * ChatHistoryValidationError before any DB call — defense against DoS via
 * a buggy or malicious IPC caller writing multi-MB encrypted blobs per row.
 *
 * Pattern: stub the DB and flip the init guard so we can call createConversation
 * and addMessage directly without a real SQLite roundtrip. The validation runs
 * first and throws, so the stubbed DB methods should never be invoked when a
 * limit is exceeded.
 */

jest.mock('electron', () => ({
  app: { getPath: () => '/tmp' }
}));

jest.mock('better-sqlite3', () => jest.fn(), { virtual: true });

const {
  ChatHistoryStore,
  ChatHistoryValidationError,
  CHAT_HISTORY_LIMITS
} = require('../src/main/services/ChatHistoryStore');

/**
 * Build a store with the init guard flipped and a stub DB whose prepare()
 * never returns rows. Validation runs before any prepare/run, so the stub
 * is only there so successful calls don't NPE.
 */
function buildStore() {
  const store = new ChatHistoryStore();
  const stmt = { run: jest.fn(), get: jest.fn(), all: jest.fn(() => []) };
  store._db = {
    prepare: jest.fn(() => stmt)
  };
  store._initGuard.isInitialized = () => true;
  store._hasMetaColumn = true;
  store._hasSortOrderColumn = true;
  return { store, stmt };
}

describe('ChatHistoryStore — input size validation', () => {
  describe('CHAT_HISTORY_LIMITS export', () => {
    test('exposes finite numeric limits', () => {
      expect(CHAT_HISTORY_LIMITS.MAX_CONVERSATION_TITLE).toBe(512);
      expect(CHAT_HISTORY_LIMITS.MAX_MESSAGE_TEXT).toBe(64_000);
      expect(CHAT_HISTORY_LIMITS.MAX_DOCUMENT_SCOPE_ITEMS).toBe(200);
      expect(CHAT_HISTORY_LIMITS.MAX_MESSAGE_PAYLOAD_BYTES).toBe(256_000);
    });

    test('is frozen so callers cannot mutate limits at runtime', () => {
      expect(Object.isFrozen(CHAT_HISTORY_LIMITS)).toBe(true);
    });
  });

  describe('createConversation', () => {
    test('accepts a normal title and scope', () => {
      const { store, stmt } = buildStore();
      const result = store.createConversation('My chat', [{ id: 'a', path: '/foo' }]);
      expect(result.title).toBe('My chat');
      expect(stmt.run).toHaveBeenCalled();
    });

    test('rejects title over MAX_CONVERSATION_TITLE chars', () => {
      const { store, stmt } = buildStore();
      const huge = 'x'.repeat(CHAT_HISTORY_LIMITS.MAX_CONVERSATION_TITLE + 1);
      expect(() => store.createConversation(huge, [])).toThrow(ChatHistoryValidationError);
      try {
        store.createConversation(huge, []);
      } catch (err) {
        expect(err.code).toBe('CONVERSATION_TITLE_TOO_LONG');
        expect(err.metadata).toMatchObject({
          limit: CHAT_HISTORY_LIMITS.MAX_CONVERSATION_TITLE
        });
      }
      expect(stmt.run).not.toHaveBeenCalled();
    });

    test('rejects documentScope over MAX_DOCUMENT_SCOPE_ITEMS', () => {
      const { store, stmt } = buildStore();
      const scope = Array.from(
        { length: CHAT_HISTORY_LIMITS.MAX_DOCUMENT_SCOPE_ITEMS + 1 },
        (_, i) => ({ id: String(i), path: `/p/${i}` })
      );
      expect(() => store.createConversation('ok', scope)).toThrow(ChatHistoryValidationError);
      try {
        store.createConversation('ok', scope);
      } catch (err) {
        expect(err.code).toBe('DOCUMENT_SCOPE_TOO_LARGE');
      }
      expect(stmt.run).not.toHaveBeenCalled();
    });

    test('rejects a single document-scope item over the per-item byte limit', () => {
      const { store, stmt } = buildStore();
      const bigItem = {
        id: 'a',
        path: 'x'.repeat(CHAT_HISTORY_LIMITS.MAX_DOCUMENT_SCOPE_ITEM_BYTES + 100)
      };
      expect(() => store.createConversation('ok', [bigItem])).toThrow(
        /Document scope item at index 0/
      );
      expect(stmt.run).not.toHaveBeenCalled();
    });

    test('rejects non-array documentScope with structured error', () => {
      const { store } = buildStore();
      try {
        store.createConversation('ok', 'not-an-array');
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ChatHistoryValidationError);
        expect(err.code).toBe('DOCUMENT_SCOPE_INVALID_TYPE');
      }
    });
  });

  describe('addMessage', () => {
    test('accepts a normal user message', () => {
      const { store, stmt } = buildStore();
      const result = store.addMessage('conv-1', { role: 'user', text: 'hi' });
      expect(result.text).toBe('hi');
      expect(stmt.run).toHaveBeenCalled();
    });

    test('rejects message.text over MAX_MESSAGE_TEXT chars', () => {
      const { store, stmt } = buildStore();
      const huge = 'x'.repeat(CHAT_HISTORY_LIMITS.MAX_MESSAGE_TEXT + 1);
      expect(() => store.addMessage('c', { role: 'user', text: huge })).toThrow(
        ChatHistoryValidationError
      );
      try {
        store.addMessage('c', { role: 'user', text: huge });
      } catch (err) {
        expect(err.code).toBe('MESSAGE_TEXT_TOO_LONG');
      }
      expect(stmt.run).not.toHaveBeenCalled();
    });

    test('rejects 1MB payload via combined text + answers + sources', () => {
      const { store, stmt } = buildStore();
      const payload = {
        role: 'assistant',
        text: 'x'.repeat(60_000), // under text cap
        modelAnswer: ['y'.repeat(200_000)],
        sources: [{ id: 'a', snippet: 'z'.repeat(50_000) }]
      };
      try {
        store.addMessage('c', payload);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ChatHistoryValidationError);
        expect(err.code).toBe('MESSAGE_PAYLOAD_TOO_LARGE');
      }
      expect(stmt.run).not.toHaveBeenCalled();
    });

    test('rejects message.sources over MAX_MESSAGE_SOURCES_ITEMS', () => {
      const { store, stmt } = buildStore();
      const sources = Array.from(
        { length: CHAT_HISTORY_LIMITS.MAX_MESSAGE_SOURCES_ITEMS + 1 },
        (_, i) => ({ id: String(i) })
      );
      try {
        store.addMessage('c', { role: 'assistant', text: 'hi', sources });
        throw new Error('expected throw');
      } catch (err) {
        expect(err.code).toBe('MESSAGE_SOURCES_TOO_MANY');
      }
      expect(stmt.run).not.toHaveBeenCalled();
    });

    test('rejects message.followUps over MAX_MESSAGE_FOLLOWUPS_ITEMS', () => {
      const { store, stmt } = buildStore();
      const followUps = Array.from(
        { length: CHAT_HISTORY_LIMITS.MAX_MESSAGE_FOLLOWUPS_ITEMS + 1 },
        (_, i) => ({ q: `q${i}` })
      );
      try {
        store.addMessage('c', { role: 'assistant', text: 'hi', followUps });
        throw new Error('expected throw');
      } catch (err) {
        expect(err.code).toBe('MESSAGE_FOLLOWUPS_TOO_MANY');
      }
      expect(stmt.run).not.toHaveBeenCalled();
    });

    test('rejects non-object message with structured error', () => {
      const { store } = buildStore();
      try {
        store.addMessage('c', null);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ChatHistoryValidationError);
        expect(err.code).toBe('MESSAGE_INVALID_TYPE');
      }
    });
  });

  describe('ChatHistoryValidationError', () => {
    test('is operational and carries code + metadata', () => {
      const err = new ChatHistoryValidationError('test', 'TEST_CODE', { a: 1 });
      expect(err.name).toBe('ChatHistoryValidationError');
      expect(err.code).toBe('TEST_CODE');
      expect(err.metadata).toEqual({ a: 1 });
      expect(err.isOperational).toBe(true);
      expect(err).toBeInstanceOf(Error);
    });
  });
});
