/**
 * @jest-environment node
 *
 * Unit tests for ChatHistoryStore.searchConversations after the
 * encryption rollout. better-sqlite3 is a native addon that doesn't
 * load cleanly under Jest, so we inject a fake _db that mimics the
 * better-sqlite3 prepared-statement API surface the store actually
 * uses (prepare → { run, get, all }). This keeps the test focused on
 * the SQL+decrypt merge logic without a real SQLite roundtrip.
 *
 * The integration angle (real SQLite) is exercised by the existing
 * chat-ipc handler tests + manual verification.
 */

jest.mock('electron', () => ({
  app: { getPath: () => '/tmp' }
}));

jest.mock('better-sqlite3', () => jest.fn(), { virtual: true });

// NOTE: do NOT reset modules. ChatHistoryStore requires safeStorageEncryption
// internally; if that helper is loaded twice (once here, once after a
// resetModules-triggered re-require), the test override only sticks on one
// copy and Stage 2 decrypts return empty. Sharing the cached module copy
// keeps the override visible to both encrypt() in tests and
// decryptFromStorage() in the store.
const {
  setSafeStorageOverride,
  ENCRYPTION_PREFIX,
  encrypt
} = require('../src/shared/safeStorageEncryption');
const { ChatHistoryStore } = require('../src/main/services/ChatHistoryStore');

function makeStubSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`STUB::${plain}`, 'utf8'),
    decryptString: (buf) => {
      const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
      if (!s.startsWith('STUB::')) throw new Error('decryptString: bad ciphertext');
      return s.slice('STUB::'.length);
    }
  };
}

/**
 * Minimal better-sqlite3 stub that routes prepare(sql) → handler based on
 * the SQL string the store generates. Returns canned in-memory rows so
 * we can verify searchConversations' SQL stage + decrypt-and-scan stage.
 *
 * Each preparedStatement carries `.run`, `.get`, `.all`. searchConversations
 * uses .all on the SQL stage, .all on the candidate-conversations query,
 * and .all on the per-conversation message lookup.
 */
function makeFakeDb({ conversations = [], messagesByConv = new Map() } = {}) {
  return {
    prepare(sql) {
      const trimmed = String(sql).replace(/\s+/g, ' ').trim();
      return {
        all(...args) {
          // Stage 1: SQL LIKE on plain columns
          if (trimmed.startsWith('SELECT DISTINCT c.* FROM conversations c JOIN messages m')) {
            const pattern = String(args[0] || '').replace(/^%|%$/g, '');
            return conversations.filter((c) => {
              const titleMatch = String(c.title || '')
                .toLowerCase()
                .includes(pattern.toLowerCase());
              if (titleMatch) return true;
              const msgs = messagesByConv.get(c.id) || [];
              return msgs.some((m) =>
                String(m.text || '')
                  .toLowerCase()
                  .includes(pattern.toLowerCase())
              );
            });
          }
          // Stage 2: candidate conversations (most-recent first)
          if (trimmed.startsWith('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT')) {
            return [...conversations].sort((a, b) =>
              String(b.updated_at).localeCompare(String(a.updated_at))
            );
          }
          // Per-conversation messages for the decrypt scan
          if (trimmed.startsWith('SELECT document_answer, model_answer, meta FROM messages')) {
            return messagesByConv.get(args[0]) || [];
          }
          throw new Error(`Unhandled SQL in fake db: ${trimmed}`);
        },
        get() {
          return null;
        },
        run() {
          return { changes: 0, lastInsertRowid: 0 };
        }
      };
    }
  };
}

beforeEach(() => {
  setSafeStorageOverride(makeStubSafeStorage());
});

afterEach(() => {
  setSafeStorageOverride(null);
});

/**
 * Build a store with the init guard already flipped and a fake _db
 * injected. Lets us call searchConversations directly without a real
 * SQLite + electron roundtrip.
 */
function buildStore({ conversations, messagesByConv }) {
  const store = new ChatHistoryStore();
  store._db = makeFakeDb({ conversations, messagesByConv });
  // Bypass _checkInit by flipping the init guard's internal state. The
  // guard exposes isInitialized() but no setter, so we patch the guard
  // object the store created in its constructor.
  store._initGuard.isInitialized = () => true;
  return store;
}

describe('ChatHistoryStore — searchConversations after encryption rollout', () => {
  test('finds matches in user-typed text (plain column, stage 1)', () => {
    const conv = {
      id: 'c1',
      title: 'My pricing chat',
      document_scope: '[]',
      created_at: 't1',
      updated_at: 't1'
    };
    const msgs = [{ text: 'what are the latest enterprise pricing tiers' }];
    const store = buildStore({
      conversations: [conv],
      messagesByConv: new Map([['c1', msgs]])
    });

    const results = store.searchConversations('enterprise pricing');
    expect(results.items.map((r) => r.id)).toContain('c1');
    expect(results).toMatchObject({ capped: false, capLimit: expect.any(Number) });
  });

  test('finds matches in conversation title (plain column, stage 1)', () => {
    const conv = {
      id: 'c2',
      title: 'Quarterly review prep',
      document_scope: '[]',
      created_at: 't2',
      updated_at: 't2'
    };
    const store = buildStore({
      conversations: [conv],
      messagesByConv: new Map([['c2', [{ text: 'unrelated' }]]])
    });

    expect(store.searchConversations('quarterly').items.map((r) => r.id)).toContain('c2');
  });

  test('finds matches in encrypted documentAnswer (stage 2 decrypt-and-scan)', () => {
    const conv = {
      id: 'c3',
      title: 'Internal',
      document_scope: '[]',
      created_at: 't3',
      updated_at: 't3'
    };
    const docAnswerJson = JSON.stringify([
      { text: 'The whitepaper covers GDPR Article 32 in detail.' }
    ]);
    const msgs = [
      {
        text: 'see attached',
        document_answer: encrypt(docAnswerJson),
        model_answer: '',
        meta: ''
      }
    ];
    const store = buildStore({
      conversations: [conv],
      messagesByConv: new Map([['c3', msgs]])
    });

    const results = store.searchConversations('GDPR Article 32');
    // Without stage 2, this would miss because document_answer is
    // ciphertext on disk and SQL LIKE would never match the plaintext.
    expect(results.items.map((r) => r.id)).toContain('c3');
  });

  test('finds matches in encrypted modelAnswer + meta', () => {
    const conv = {
      id: 'c4',
      title: 'Internal',
      document_scope: '[]',
      created_at: 't4',
      updated_at: 't4'
    };
    const msgs = [
      {
        text: 'unrelated',
        document_answer: '',
        model_answer: encrypt(
          JSON.stringify([{ text: 'I would recommend SAML SSO over OAuth here.' }])
        ),
        meta: encrypt(JSON.stringify({ topic: 'authentication-strategy' }))
      }
    ];
    const store = buildStore({
      conversations: [conv],
      messagesByConv: new Map([['c4', msgs]])
    });

    expect(store.searchConversations('SAML SSO').items.map((r) => r.id)).toContain('c4');
    expect(store.searchConversations('authentication-strategy').items.map((r) => r.id)).toContain(
      'c4'
    );
  });

  test('case-insensitive match across both stages', () => {
    const c1 = {
      id: 'c1',
      title: 'My Project',
      document_scope: '[]',
      created_at: 't',
      updated_at: 't'
    };
    const c2 = {
      id: 'c2',
      title: 'Other',
      document_scope: '[]',
      created_at: 't',
      updated_at: 't'
    };
    const messagesByConv = new Map([
      ['c1', [{ text: 'we discussed PROJECT alpha yesterday' }]],
      [
        'c2',
        [
          {
            text: '...',
            document_answer: encrypt(JSON.stringify([{ text: 'See PROJECT-Beta milestones' }])),
            model_answer: '',
            meta: ''
          }
        ]
      ]
    ]);
    const store = buildStore({ conversations: [c1, c2], messagesByConv });

    const ids = store.searchConversations('project').items.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['c1', 'c2']));
  });

  test('returns no duplicates when both stages would match the same conversation', () => {
    const conv = {
      id: 'c1',
      title: 'Architecture review',
      document_scope: '[]',
      created_at: 't',
      updated_at: 't'
    };
    const msgs = [
      {
        text: 'the migration architecture is solid',
        document_answer: encrypt(JSON.stringify([{ text: 'architecture diagram attached' }])),
        model_answer: '',
        meta: ''
      }
    ];
    const store = buildStore({
      conversations: [conv],
      messagesByConv: new Map([['c1', msgs]])
    });

    const results = store.searchConversations('architecture');
    expect(results.items.filter((r) => r.id === 'c1')).toHaveLength(1);
  });

  test('respects SEARCH_RESULT_LIMIT (20) when many matches', () => {
    const conversations = [];
    const messagesByConv = new Map();
    for (let i = 0; i < 25; i += 1) {
      conversations.push({
        id: `c${i}`,
        title: `needle ${i}`,
        document_scope: '[]',
        created_at: 't',
        updated_at: `t${String(i).padStart(3, '0')}`
      });
      messagesByConv.set(`c${i}`, [{ text: `this contains needle ${i}` }]);
    }
    const store = buildStore({ conversations, messagesByConv });
    expect(store.searchConversations('needle').items).toHaveLength(20);
  });

  test('does not match conversations without the term in any column', () => {
    const noise = {
      id: 'noise',
      title: 'Project alpha',
      document_scope: '[]',
      created_at: 't',
      updated_at: 't'
    };
    const target = {
      id: 'target',
      title: 'Project beta',
      document_scope: '[]',
      created_at: 't',
      updated_at: 't'
    };
    const messagesByConv = new Map([
      ['noise', [{ text: 'just a regular note' }]],
      [
        'target',
        [
          {
            text: 'unrelated',
            document_answer: encrypt(
              JSON.stringify([{ text: 'discussion about quantum entanglement' }])
            ),
            model_answer: '',
            meta: ''
          }
        ]
      ]
    ]);
    const store = buildStore({ conversations: [noise, target], messagesByConv });

    const ids = store.searchConversations('quantum').items.map((r) => r.id);
    expect(ids).toEqual(['target']);
  });

  test('empty / non-string query returns empty envelope (capped=false)', () => {
    const store = buildStore({ conversations: [], messagesByConv: new Map() });
    for (const q of ['', '   ', null, undefined]) {
      const result = store.searchConversations(q);
      expect(result.items).toEqual([]);
      expect(result.capped).toBe(false);
    }
  });

  test('encrypted-but-empty payloads (cross-machine handoff) do not crash search', () => {
    const conv = {
      id: 'roaming',
      title: 'Roaming chat',
      document_scope: '[]',
      created_at: 't',
      updated_at: 't'
    };
    const msgs = [
      {
        text: '',
        // Marker present but ciphertext won't decrypt under our stub.
        document_answer: `${ENCRYPTION_PREFIX}garbage_base64`,
        model_answer: '',
        meta: ''
      }
    ];
    const store = buildStore({
      conversations: [conv],
      messagesByConv: new Map([['roaming', msgs]])
    });

    expect(() => store.searchConversations('anything')).not.toThrow();
  });

  describe('search-cap notice (SEARCH_DECRYPT_SCAN_CAP)', () => {
    /**
     * Build a fake DB that ALSO answers the COUNT(*) query the cap-detection
     * code added. The existing makeFakeDb stub returns null from get(); this
     * helper wraps it and returns { n: totalRowCount } for the COUNT.
     */
    function buildStoreWithCount({ conversations, messagesByConv, total }) {
      const store = new ChatHistoryStore();
      const baseDb = makeFakeDb({ conversations, messagesByConv });
      store._db = {
        prepare(sql) {
          const stmt = baseDb.prepare(sql);
          const trimmed = String(sql).replace(/\s+/g, ' ').trim();
          if (trimmed.startsWith('SELECT COUNT(*) AS n FROM conversations')) {
            return {
              all: stmt.all,
              get: () => ({ n: total }),
              run: stmt.run
            };
          }
          return stmt;
        }
      };
      store._initGuard.isInitialized = () => true;
      return store;
    }

    test('capped=false when totalConversations <= cap', () => {
      const conv = {
        id: 'a',
        title: 'hello world',
        document_scope: '[]',
        created_at: 't',
        updated_at: 't'
      };
      const store = buildStoreWithCount({
        conversations: [conv],
        messagesByConv: new Map([['a', [{ text: 'hello world' }]]]),
        total: 50
      });
      // Force stage 2 to run (stage 1 won't fully fill the result list)
      const result = store.searchConversations('xyz-no-match');
      expect(result.capped).toBe(false);
      expect(result.capLimit).toBe(500);
    });

    test('capped=true when totalConversations exceeds cap', () => {
      const conv = {
        id: 'a',
        title: 'hello',
        document_scope: '[]',
        created_at: 't',
        updated_at: 't'
      };
      const store = buildStoreWithCount({
        conversations: [conv],
        messagesByConv: new Map([['a', [{ text: 'unrelated' }]]]),
        total: 600
      });
      // Stage 1 returns nothing (no LIKE match), stage 2 runs, COUNT(*) > 500
      const result = store.searchConversations('xyz-no-match');
      expect(result.capped).toBe(true);
      expect(result.capLimit).toBe(500);
      expect(result.items).toEqual([]); // no match, but cap notice present
    });

    test('envelope shape is stable: { items, capped, capLimit, scannedCount }', () => {
      const store = buildStoreWithCount({
        conversations: [],
        messagesByConv: new Map(),
        total: 0
      });
      const result = store.searchConversations('x');
      expect(result).toMatchObject({
        items: expect.any(Array),
        capped: expect.any(Boolean),
        capLimit: expect.any(Number),
        scannedCount: expect.any(Number)
      });
    });
  });
});
