// @ts-check
/**
 * Chat session memory — the per-conversation state layer.
 *
 * Owns the LRU of in-memory session buffers (with eviction persistence to
 * ChatHistoryStore so evicted conversations reopen from history, T-06),
 * history text assembly for the prompt (including the [doc-N] -> [name]
 * rewrite so stale citation tokens never re-enter prompts), and turn
 * persistence (conversation creation, scope sync, title upgrades).
 * Extracted from ChatService; the facade delegates and exposes the LRU for
 * its existing oracles.
 */

const { LRUCache } = require('../../../shared/LRUCache');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('ChatSessionMemory');

const MAX_SESSIONS = 50;
const SESSION_TTL_MS = 60 * 60 * 1000; // 60 minutes

class SessionMemory {
  /** @param {{ chatHistoryStore?: any, memoryWindow?: number, name?: string }} [deps] */
  constructor({ chatHistoryStore, memoryWindow = 6, name = 'ChatServiceSessions' } = {}) {
    this.chatHistoryStore = chatHistoryStore;
    this.memoryWindow = Math.max(1, memoryWindow);
    this.lru = new LRUCache({
      maxSize: MAX_SESSIONS,
      ttlMs: SESSION_TTL_MS,
      lruStrategy: 'access',
      name,
      onEvict: (sessionKey, memory) => {
        void this.persistEvictedInMemorySession(sessionKey, memory);
      }
    });
    this.lru.initialize();
  }

  delete(/** @type {any} */ sessionId) {
    this.lru.delete(String(sessionId));
  }

  // Stops the LRU's TTL sweep interval as well as dropping entries; a bare
  // lru.clear() would leave the timer running for the process lifetime.
  dispose() {
    void this.lru.shutdown();
  }

  async getSessionMemory(/** @type {any} */ sessionId) {
    const key = sessionId || 'default';

    if (this.lru.has(key)) {
      const session = this.lru.get(key);
      session._lastAccessedAt = Date.now();
      return session;
    }

    const memory = this.createMemory(key);
    memory._lastAccessedAt = Date.now();
    this.lru.set(key, memory);
    return memory;
  }

  async persistEvictedInMemorySession(/** @type {any} */ sessionKey, /** @type {any} */ memory) {
    const store = this.chatHistoryStore;
    if (!store || !memory?._lines?.length) {
      return;
    }
    try {
      await store.initialize?.();
    } catch {
      /* store may already be initialized */
    }
    try {
      let conv = store.getConversation(sessionKey);
      if (!conv) {
        store.createConversation('New Conversation', [], sessionKey);
      }
      for (const line of memory._lines) {
        if (typeof line !== 'string') continue;
        if (line.startsWith('User: ')) {
          store.addMessage(sessionKey, { role: 'user', text: line.slice(6) });
        } else if (line.startsWith('Assistant: ')) {
          store.addMessage(sessionKey, { role: 'assistant', text: line.slice(11) });
        }
      }
    } catch (error) {
      logger.warn('[ChatSessionMemory] Failed to persist evicted session to history store', {
        sessionKey,
        error: error.message
      });
    }
  }

  createMemory(/** @type {any} */ sessionKey) {
    const maxTurns = Math.max(1, this.memoryWindow);
    /** @type {Record<string, any>} */
    const memory = {
      _sessionId: sessionKey,
      sessionId: sessionKey,
      _lastAccessedAt: Date.now(),
      /** @type {string[]} */
      _lines: [],
      loadMemoryVariables: async () => ({
        history: memory._lines.join('\n')
      }),
      saveContext: async (
        /** @type {{ input?: string }} */ { input },
        /** @type {{ output?: any }} */ { output }
      ) => {
        if (typeof input === 'string' && input.trim()) {
          memory._lines.push(`User: ${input.trim()}`);
        }
        if (typeof output === 'string' && output.trim()) {
          memory._lines.push(`Assistant: ${output.trim()}`);
        }

        const maxLines = maxTurns * 2;
        if (memory._lines.length > maxLines) {
          memory._lines.splice(0, memory._lines.length - maxLines);
        }
      }
    };
    return memory;
  }

  async getHistoryText(/** @type {any} */ memory) {
    if (this.chatHistoryStore && memory?.sessionId) {
      try {
        const conv = this.chatHistoryStore.getConversation(memory.sessionId);
        if (!conv) return '';
        const messages = conv.messages.slice(-(this.memoryWindow * 2));
        return messages
          .map((/** @type {any} */ m) => {
            const role = m.role === 'user' ? 'User' : 'Assistant';
            let text = m.text;
            if (m.role === 'assistant' && !text) {
              const docs =
                m.documentAnswer
                  ?.map((/** @type {any} */ d) => d.text)
                  .filter(Boolean)
                  .join('\n') || '';
              const model =
                m.modelAnswer
                  ?.map((/** @type {any} */ d) => d.text)
                  .filter(Boolean)
                  .join('\n') || '';
              text = [docs, model].filter(Boolean).join('\n');
            }
            if (
              m.role === 'assistant' &&
              text &&
              Array.isArray(m.sources) &&
              m.sources.length > 0
            ) {
              for (const source of m.sources) {
                const sourceId = source?.id;
                const sourceName = source?.name;
                if (!sourceId || !sourceName) continue;
                const escapedId = String(sourceId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                text = text.replace(new RegExp(`\\[${escapedId}\\]`, 'g'), `[${sourceName}]`);
              }
            }
            return `${role}: ${text}`;
          })
          .join('\n');
      } catch (error) {
        logger.warn('[ChatSessionMemory] Failed to load history from store:', error.message);
      }
    }

    try {
      const vars = await memory.loadMemoryVariables({});
      return typeof vars?.history === 'string' ? vars.history : '';
    } catch (error) {
      logger.debug('[ChatSessionMemory] Failed to load memory variables:', error.message);
      return '';
    }
  }

  async saveMemoryTurn(
    /** @type {any} */ memory,
    /** @type {any} */ input,
    /** @type {any} */ output,
    { skipUserMessage = false } = {}
  ) {
    if (this.chatHistoryStore && memory?.sessionId) {
      try {
        // Ensure conversation exists, passing sessionId so the store uses it
        let conv = this.chatHistoryStore.getConversation(memory.sessionId);
        const isFirstTurn = !conv;
        if (!conv) {
          this.chatHistoryStore.createConversation(
            (typeof input === 'string' ? input.slice(0, 50) : '') || 'New Conversation',
            memory._documentScope || [],
            memory.sessionId
          );
        } else if (this.chatHistoryStore.updateDocumentScope) {
          // Scope is otherwise only written at creation; persist mid-
          // conversation changes so a reload restores the scope the user
          // actually had, not the one from turn 1.
          const liveScope = memory._documentScope || [];
          const storedScope = conv.documentScope || [];
          if (JSON.stringify(liveScope) !== JSON.stringify(storedScope)) {
            this.chatHistoryStore.updateDocumentScope(memory.sessionId, liveScope);
          }
        }

        // Persist user turn — unless this is a regenerate, where the original
        // user row already exists and re-inserting duplicates it on reload.
        if (!skipUserMessage) {
          this.chatHistoryStore.addMessage(memory.sessionId, {
            role: 'user',
            text: typeof input === 'string' ? input : ''
          });
        }

        /** @type {Record<string, any>} */
        const assistantMessage = {
          role: 'assistant',
          text: typeof output === 'string' ? output : output?.text || ''
        };
        if (output && typeof output === 'object' && !Array.isArray(output)) {
          assistantMessage.text = output.text || '';
          assistantMessage.documentAnswer = output.documentAnswer || [];
          assistantMessage.modelAnswer = output.modelAnswer || [];
          assistantMessage.sources = output.sources || [];
          assistantMessage.followUps = output.followUps || [];
          assistantMessage.meta = output.meta || {};
        }
        this.chatHistoryStore.addMessage(memory.sessionId, assistantMessage);

        // Also fixes legacy conversations stuck with "New Chat" title.
        if (this.chatHistoryStore.updateTitle) {
          const currentTitle = isFirstTurn ? null : conv?.title || '';
          const needsTitleUpdate =
            isFirstTurn || currentTitle === 'New Chat' || currentTitle === 'New Conversation';

          if (needsTitleUpdate && typeof input === 'string' && input.trim()) {
            const betterTitle =
              input.trim().length > 60 ? input.trim().slice(0, 57) + '...' : input.trim();
            this.chatHistoryStore.updateTitle(memory.sessionId, betterTitle);
          }
        }

        return;
      } catch (error) {
        logger.warn('[ChatSessionMemory] Failed to persist turn:', error.message);
      }
    }

    // Fallback to in-memory saveContext for sessions without ChatHistoryStore
    if (typeof memory?.saveContext === 'function') {
      try {
        const outputText = typeof output === 'string' ? output : output?.text || '';
        await memory.saveContext({ input }, { output: outputText });
      } catch (error) {
        logger.debug('[ChatSessionMemory] Failed to save memory:', error.message);
      }
    }
  }

  /**
   * Remap per-turn `doc-N` ids to conversation-scoped FIRST-SEEN ordinals so
   * the same document keeps its number across turns. Pre-fix, the retrieval
   * engine renumbered sequentially every turn, so `doc-2` in turn 1 could be
   * a different file than `doc-2` in turn 2 — confusing across chat bubbles
   * and for the model (history references drifting numbers). Ordinals may be
   * non-contiguous within a turn (doc-2, doc-5); the prompt template tells
   * the model to cite the bracketed ids verbatim.
   *
   * Sources without a stable key (no fileId/path) keep their engine id —
   * they cannot be tracked across turns.
   *
   * @param {object} memory Session memory object (registry lives on it).
   * @param {Array<object>} sources Engine-numbered sources, retrieval order.
   * @returns {Array<object>} Sources with stable ids.
   */
  applyStableCitationIds(memory, sources) {
    if (!memory || !Array.isArray(sources) || sources.length === 0) return sources;
    const registry = this._getCitationRegistry(memory);
    return sources.map((/** @type {any} */ source) => {
      const key = source?.fileId || source?.path || null;
      if (!key) return source;
      let ordinal = registry.map.get(key);
      if (!ordinal) {
        ordinal = registry.next;
        registry.next += 1;
        registry.map.set(key, ordinal);
      }
      return { ...source, id: `doc-${ordinal}` };
    });
  }

  /**
   * Get (or lazily build) the citation registry for a session. Rehydrates
   * from persisted history so numbering survives LRU eviction and app
   * restarts: stored assistant messages carry their `sources` arrays
   * (`{id: 'doc-N', fileId}`); first-seen mapping wins on legacy conflicts
   * (per-turn renumbered conversations), and later documents simply continue
   * the sequence.
   *
   * Ordinals must be UNIQUE across the conversation: legacy per-turn
   * renumbered histories can carry `doc-1 -> fileA` in turn 1 and
   * `doc-1 -> fileB` in turn 2. Naively seeding both would give two different
   * files the same registry id, and CitationRenderer's id->source Map is
   * last-one-wins — clicking a citation would open the wrong document. The
   * first document keeps its stored ordinal; a different document claiming an
   * already-taken ordinal is renumbered to the next free ordinal.
   * @private
   */
  _getCitationRegistry(/** @type {any} */ memory) {
    if (memory._citationRegistry) return memory._citationRegistry;
    const registry = { map: new Map(), next: 1 };
    try {
      if (this.chatHistoryStore && memory.sessionId) {
        const conv = this.chatHistoryStore.getConversation(memory.sessionId);
        /** @type {Set<number>} Ordinals already claimed by a document. */
        const usedOrdinals = new Set();
        for (const message of conv?.messages || []) {
          for (const source of message?.sources || []) {
            const key = source?.fileId || source?.path || null;
            const match = typeof source?.id === 'string' && source.id.match(/^doc-(\d+)$/);
            if (!key || !match) continue;
            let ordinal = Number(match[1]);
            // First-seen mapping wins; later legacy renumberings of the same
            // document are ignored (its ordinal is already fixed). Still
            // reserve the stored ordinal so no future document is assigned an
            // id that already appears in persisted messages.
            if (registry.map.has(key)) {
              usedOrdinals.add(ordinal);
              registry.next = Math.max(registry.next, ordinal + 1);
              continue;
            }
            if (usedOrdinals.has(ordinal)) {
              // Legacy collision: this ordinal already belongs to a different
              // document. Renumber to the next free ordinal so every registry
              // id maps to exactly one document.
              while (usedOrdinals.has(registry.next)) registry.next += 1;
              ordinal = registry.next;
            }
            registry.map.set(key, ordinal);
            usedOrdinals.add(ordinal);
            registry.next = Math.max(registry.next, ordinal + 1);
          }
        }
      }
    } catch (error) {
      logger.debug('[ChatSessionMemory] Citation registry rehydration failed (best-effort)', {
        error: error?.message
      });
    }
    memory._citationRegistry = registry;
    return registry;
  }
}

module.exports = { SessionMemory, MAX_SESSIONS, SESSION_TTL_MS };
