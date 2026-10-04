// @ts-check
'use strict';
const { z } = require('zod');
const crypto = require('node:crypto');
const { createLogger } = require('../../../../shared/logger');

const _logger = createLogger('mcp.chatWithDocuments');

// LRU + TTL-bounded session mutex map. The previous unbounded Map leaked
// memory over a long-running server: every distinct session_id (or
// auto-generated UUID) added a permanent entry. We now bound by:
//   - count: 64 is well above realistic concurrent interactive load (the
//     previous 256 was high enough that an in-flight session could be
//     evicted by a burst of new chats and orphan its mutex)
//   - age: 30 minutes since last touch — idle sessions get reaped before
//     LRU pressure kicks in, so eviction normally only runs on truly cold
//     sessions
const MAX_SESSIONS = 64;
const SESSION_TTL_MS = 30 * 60 * 1000;
const _sessionMutex = new Map(); // id -> { tail, lastTouch }

function _evictExpired(/** @type {any} */ now) {
  for (const [id, entry] of _sessionMutex) {
    if (now - entry.lastTouch > SESSION_TTL_MS) {
      _sessionMutex.delete(id);
    }
  }
}

function _withSessionMutex(/** @type {any} */ sessionId, /** @type {any} */ fn) {
  const now = Date.now();
  _evictExpired(now);

  const existing = _sessionMutex.get(sessionId);
  const prevTail = existing?.tail || Promise.resolve();
  const next = prevTail.then(fn, fn);

  // Refresh LRU position; evict oldest when over cap.
  _sessionMutex.delete(sessionId);
  _sessionMutex.set(sessionId, {
    tail: next.catch(() => {}),
    lastTouch: now
  });

  if (_sessionMutex.size > MAX_SESSIONS) {
    const oldestId = _sessionMutex.keys().next().value;
    _sessionMutex.delete(oldestId);
    _logger.warn(
      'Session mutex evicted under cap pressure; subsequent calls with this id start a fresh chain.',
      { evictedId: oldestId, cap: MAX_SESSIONS }
    );
  }
  return next;
}

function registerChatWithDocuments(/** @type {any} */ mcp, /** @type {any} */ services) {
  mcp.registerTool(
    'chat_with_documents',
    {
      description:
        "RAG chat over the user's analyzed documents. Returns an answer with [n] citation markers and a citation list. Non-streaming in v1.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(2000)
          .describe('Question to answer from the analyzed documents'),
        session_id: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe('Conversation id for multi-turn context; omit to start a new conversation'),
        max_context_files: z
          .number()
          .int()
          .min(1)
          .max(15)
          .optional()
          .describe('Maximum number of retrieved documents to ground the answer on (default 5)'),
        persona: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('Optional answering style, e.g. "concise analyst"')
      }
    },
    async (/** @type {any} */ args) => {
      const query = (args?.query || '').trim();
      if (!query) return _err('INVALID_QUERY', 'query is required.');
      const sessionId = args?.session_id || `mcp-${crypto.randomUUID()}`;
      try {
        const result = await _withSessionMutex(sessionId, async () =>
          services.chat.runOnce({
            query,
            sessionId,
            maxContextFiles: args?.max_context_files ?? 5,
            persona: args?.persona,
            timeoutMs: 60_000,
            // Privacy contract: the MCP surface promises zero outbound calls
            // (docs/MCP_SERVER.md), so never route MCP prompts to a cloud
            // provider even when the user enabled one for in-app chat.
            forceLocal: true
          })
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                answer: result.answer,
                citations: result.citations || [],
                // false: no document was cited, so the text is the model's
                // own words (typically "no matching documents").
                grounded: result.grounded === true,
                session_id: result.sessionId,
                tokens_used: result.tokens_used || { prompt: 0, completion: 0 }
              })
            }
          ]
        };
      } catch (err) {
        const code =
          err.code === 'TIMEOUT'
            ? 'LLM_TIMEOUT'
            : err.code === 'NO_MODEL'
              ? 'MODEL_NOT_READY'
              : 'RETRIEVAL_FAILED';
        // Don't echo err.message verbatim — could include absolute paths,
        // model names, or llama.cpp internals. Use a stable, classified msg.
        const friendly = {
          LLM_TIMEOUT: 'request timed out',
          MODEL_NOT_READY: 'model not ready',
          RETRIEVAL_FAILED: 'retrieval failed'
        }[code];
        return _err(code, friendly);
      }
    }
  );
  return 'chat_with_documents';
}

function _err(/** @type {any} */ code, /** @type {any} */ message) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }]
  };
}

module.exports = { registerChatWithDocuments };
