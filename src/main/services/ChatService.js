// @ts-check
/**
 * ChatService — streaming RAG chat over the user's documents.
 *
 * Builds prompts that interleave (a) the user's question, (b) the
 * configured persona, and (c) retrieved document context fenced inside
 * `<document_content>` tags with a per-request nonce. Calls into
 * LlamaService for inference. This class is the facade + streaming
 * lifecycle owner; the concern modules live in ./chat/ (promptSanitizers,
 * queryIntent, CitationExtractor, PromptBuilder, SessionMemory,
 * RetrievalEngine) behind thin delegating methods.
 */
const { createLogger } = require('../../shared/logger');
const { getChatPersonaOrDefault, getEffectivePersona } = require('../../shared/chatPersonas');
const { beginInteractiveTextRequest } = require('./textModelActivity');

// Prompt-injection hardening lives in chat/promptSanitizers.js — all
// user-authored document content and metadata flows through those helpers
// before being concatenated into the LLM prompt (fence escape, invisible-
// character injection, and metadata newline-smuggling defenses; see the
// module doc for the full threat model).

// Cloud provider error codes that mean "transient or policy failure; degrade
// gracefully to local". Mirrors the matching set in documentLlm.js so chat
// and analysis apply the same fallback policy. AUTH_FAILED, CONTENT_TOO_LONG,
// PROVIDER_DISABLED, CONSENT_REQUIRED are intentionally NOT in this set —
// the user should see those and fix them, not silently route to local.
// Fallback additionally requires err.tokensEmitted !== true: NETWORK_ERROR
// can now fire mid-stream (see providers' _readStream), and retrying locally
// after tokens already streamed would append a second answer to the partial
// one the user saw.
const CLOUD_CHAT_FALLBACK_CODES = new Set([
  'BUDGET_EXCEEDED',
  'RATE_LIMITED',
  'NETWORK_ERROR',
  'PROVIDER_FAILED'
]);

// Sanitizers extracted to chat/promptSanitizers.js (direct unit oracles in
// test/chat/promptSanitizers.test.js). Local aliases keep the existing call
// sites (25 of them) unchanged.
const {
  sanitizeExtractedForPrompt: _sanitizeExtractedForPrompt,
  sanitizeMetadataForPrompt: _sanitizeMetadataForPrompt
} = require('./chat/promptSanitizers');
// Answer parsing, output clamps, and citation reconciliation live in
// chat/CitationExtractor.js (direct oracles in test/chat/citationExtractor.test.js).
const citationExtractor = require('./chat/CitationExtractor');
// Session LRU + history + turn persistence (oracles reach the LRU via the
// _sessionLRU getter on the facade).
const { SessionMemory } = require('./chat/SessionMemory');

// Prompt assembly + global budget live in chat/PromptBuilder.js (budget
// oracles in ChatService.extended.test.js run through the facade).
const { buildPrompt } = require('./chat/PromptBuilder');
// Hybrid search execution + context-file scoring (no session/prompt state).
const { RetrievalEngine } = require('./chat/RetrievalEngine');

const logger = createLogger('ChatService');
const DEFAULTS = {
  topK: 5,
  mode: 'hybrid',
  chunkTopK: 6,
  chunkWeight: 0.2,
  contextFileLimit: 200,
  memoryWindow: 6
};
const HOLISTIC_MIN_TOPK = 12;
const HOLISTIC_MIN_CHUNK_TOPK = 80;
const HOLISTIC_MIN_CHUNK_WEIGHT = 0.35;

const STREAM_CONTROLLER_SWEEP_MS = 120000;
const STREAM_CONTROLLER_WARN_THRESHOLD = 8;
let _streamKeyCounter = 0;

const MCP_SESSION_PREFIX = 'mcp:';
// Generation errors that mean the local model is absent or not loaded; the
// MCP tool reports them as MODEL_NOT_READY instead of RETRIEVAL_FAILED.
const MODEL_NOT_READY_CODES = new Set(['NO_MODEL', 'LLAMA_002', 'LLAMA_MODEL_NOT_FOUND']);

// Appended to the answer when a cloud provider stopped at its output token
// cap. The streamed text is complete as far as it goes, so this is a notice,
// not an error.
const OUTPUT_TRUNCATED_NOTICE =
  '[Response cut short: the cloud provider reached its output token limit. Ask a follow-up to continue.]';

// Query-intent detectors extracted to chat/queryIntent.js (direct unit
// oracles in test/chat/queryIntent.test.js). The `_is*` methods below stay
// as thin delegations so behavior oracles keep exercising the facade.
const queryIntent = require('./chat/queryIntent');

const RESPONSE_MODES = {
  fast: {
    chunkTopK: 6,
    chunkWeight: 0.2,
    expandSynonyms: false,
    correctSpelling: false,
    rerank: false
  },
  deep: {
    chunkTopK: 60,
    chunkWeight: 0.4,
    expandSynonyms: true,
    correctSpelling: true,
    rerank: true
  }
};

class ChatService {
  /**
   * @param {any} deps
   */
  constructor({
    searchService,
    vectorDbService,
    embeddingService,
    llamaService,
    settingsService,
    chatHistoryStore
  }) {
    this.searchService = searchService;
    this.vectorDbService = vectorDbService;
    this.embeddingService = embeddingService;
    this.llamaService = llamaService;
    this.settingsService = settingsService;
    this.chatHistoryStore = chatHistoryStore;
    // Session state (LRU + history + turn persistence) lives in
    // chat/SessionMemory.js; the _sessionLRU getter below exposes its LRU
    // for the existing oracles.
    this._sessions = new SessionMemory({
      chatHistoryStore,
      memoryWindow: DEFAULTS.memoryWindow,
      name: 'ChatServiceSessions'
    });
    // MCP sessions are deliberately in-memory only (no chatHistoryStore):
    // external clients must never create conversations in the Chat sidebar
    // or read/append an in-app conversation by guessing its id. Keys are
    // namespaced via MCP_SESSION_PREFIX for the same reason.
    this._mcpSessions = new SessionMemory({
      memoryWindow: DEFAULTS.memoryWindow,
      name: 'McpChatSessions'
    });
    this._retrieval = new RetrievalEngine({
      searchService,
      vectorDbService,
      embeddingService,
      settingsService,
      defaults: DEFAULTS
    });
    this.activeStreamControllers = new Map(); // request/session keyed AbortControllers
    this._streamControllerSweepTimer = setInterval(() => {
      for (const [key, streamState] of this.activeStreamControllers) {
        if (streamState?.controller?.signal?.aborted) {
          this.activeStreamControllers.delete(key);
        }
      }
      const n = this.activeStreamControllers.size;
      if (n > STREAM_CONTROLLER_WARN_THRESHOLD) {
        logger.warn('[ChatService] Elevated in-flight stream controller count', { count: n });
      }
    }, STREAM_CONTROLLER_SWEEP_MS);
    if (this._streamControllerSweepTimer?.unref) {
      this._streamControllerSweepTimer.unref();
    }
    this._disposed = false;
  }

  /**
   * Release resources owned by this instance.
   *
   * The cached `ChatService` is nulled when the Llama backend is swapped
   * (see `src/main/ipc/chat.js`). Without an explicit teardown the old
   * instance stayed alive via its `setInterval` closure, leaking a timer
   * and a retainer on the old LlamaService per swap. This idempotent
   * disposer clears the sweep timer and aborts any in-flight streams so
   * the old instance can actually be garbage collected.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._streamControllerSweepTimer) {
      clearInterval(this._streamControllerSweepTimer);
      this._streamControllerSweepTimer = null;
    }
    for (const [key, streamState] of this.activeStreamControllers) {
      try {
        streamState?.controller?.abort();
      } catch {
        // Best-effort: individual aborts may already have fired.
      }
      this.activeStreamControllers.delete(key);
    }
    this._sessions?.dispose();
    this._mcpSessions?.dispose();
  }

  async resetSession(/** @type {any} */ sessionId) {
    if (sessionId) {
      this._sessionLRU.delete(String(sessionId));
      const key = String(sessionId);
      for (const [streamKey, streamState] of this.activeStreamControllers) {
        if (String(streamState?.sessionId || '') === key) {
          try {
            streamState.controller?.abort();
          } catch {
            // Ignore abort errors
          }
          this.activeStreamControllers.delete(streamKey);
        }
      }
    }
  }

  /**
   * Abort an in-flight streaming query by request id or session id.
   *
   * @param {Object} [params]
   * @param {string|number|null} [params.requestId] - Client-supplied stream request id
   * @param {string|null} [params.sessionId] - Session scope; cancels all streams for the session
   * @returns {Promise<{canceled: boolean, by?: string}>}
   */
  async cancelStreamingRequest({ requestId, sessionId } = {}) {
    if (requestId !== undefined && requestId !== null) {
      const key = `req:${String(requestId)}`;
      const streamState = this.activeStreamControllers.get(key);
      if (streamState?.controller) {
        streamState.controller.abort();
        this.activeStreamControllers.delete(key);
        return { canceled: true, by: 'requestId' };
      }
    }

    if (sessionId) {
      const sessionKey = String(sessionId);
      let canceledAny = false;
      for (const [key, streamState] of this.activeStreamControllers) {
        if (String(streamState?.sessionId || '') === sessionKey) {
          try {
            streamState.controller?.abort();
          } catch {
            // Ignore abort errors
          }
          this.activeStreamControllers.delete(key);
          canceledAny = true;
        }
      }
      if (canceledAny) {
        return { canceled: true, by: 'sessionId' };
      }
    }

    return { canceled: false };
  }

  /**
   * Run a non-streaming chat turn: retrieval (when needed), prompt build, and LLM JSON response.
   *
   * @param {any} params
   * @returns {Promise<{success: boolean, response?: Object, sources?: Array<any>, meta?: Object, error?: string}>}
   */
  async query({
    sessionId,
    query,
    topK = DEFAULTS.topK,
    mode = DEFAULTS.mode,
    chunkTopK = DEFAULTS.chunkTopK,
    chunkWeight = DEFAULTS.chunkWeight,
    contextFileIds = [],
    strictScope = false,
    responseMode = 'fast'
  }) {
    const cleanQuery = typeof query === 'string' ? query.trim() : '';
    if (!cleanQuery || cleanQuery.length < 2) {
      logger.warn('[ChatService] Query rejected (too short)', {
        sessionId: sessionId || 'default',
        queryLength: cleanQuery.length
      });
      return { success: false, error: 'Query must be at least 2 characters' };
    }

    if (!this.llamaService) {
      logger.error('[ChatService] Service unavailable', {
        hasSearch: Boolean(this.searchService),
        hasLlama: Boolean(this.llamaService)
      });
      return { success: false, error: 'Chat service unavailable' };
    }

    // Short-circuit for pure chitchat to save resources
    if (this._isConversational(cleanQuery)) {
      logger.info('[ChatService] Detected conversational query, skipping retrieval', {
        query: cleanQuery
      });
      const memory = await this._getSessionMemory(sessionId);
      const history = await this._getHistoryText(memory);

      const prompt = `You are StratoSort, a friendly local AI assistant. You help users search, explore, and understand the files on their machine. Everything runs on-device — no data leaves their computer.

${history ? `Conversation so far:\n${history}\n` : ''}User: "${cleanQuery}"

Respond warmly and naturally. If they greet you or check if you are working, greet them back and briefly mention what you can do. Suggest 2-3 things they could try as follow-up questions.

Example output:
{"modelAnswer":[{"text":"Hey there! I'm up and running. I can search your documents by meaning, answer questions about your files, find related documents, and help organize your workspace. What would you like to explore?"}],"documentAnswer":[],"followUps":["Summarize my most recent documents","What topics do my files cover?","Find files related to taxes"]}

Now respond as JSON:`;

      try {
        const result = await this.llamaService.analyzeText(prompt, { format: 'json' });
        if (result?.success) {
          const parsed = this._parseResponse(result.response, []);
          await this._saveMemoryTurn(memory, cleanQuery, {
            text: this._formatForMemory(parsed),
            documentAnswer: parsed.documentAnswer || [],
            modelAnswer: parsed.modelAnswer || [],
            sources: [],
            followUps: parsed.followUps || [],
            meta: { retrievalSkipped: true }
          });
          return { success: true, response: parsed, sources: [], meta: { retrievalSkipped: true } };
        }
      } catch (err) {
        logger.warn('[ChatService] Conversational response failed:', err);
      }
      // Fall through to normal flow if something fails
    }

    const {
      retrieval,
      prompt,
      holisticIntent,
      correctionIntent,
      comparisonIntent,
      gapAnalysisIntent,
      contradictions,
      forcedResponseMode,
      memory
    } = await this._runRetrieval({
      sessionId,
      cleanQuery,
      topK,
      mode,
      chunkTopK,
      chunkWeight,
      contextFileIds,
      strictScope,
      responseMode
    });

    if (strictScope && (!retrieval.sources || retrieval.sources.length === 0)) {
      /** @type {Record<string, any>} */
      const abstention = {
        documentAnswer: [],
        modelAnswer: [
          {
            text: 'I cannot find this information in the selected documents. Try broadening your document scope or rephrasing your question.'
          }
        ],
        followUps: []
      };
      await this._saveMemoryTurn(memory, cleanQuery, {
        text: abstention.modelAnswer[0].text,
        documentAnswer: [],
        modelAnswer: abstention.modelAnswer,
        sources: [],
        followUps: [],
        meta: { ...retrieval.meta, strictScopeAbstention: true }
      });
      return {
        success: true,
        response: abstention,
        sources: [],
        meta: { ...retrieval.meta, strictScopeAbstention: true }
      };
    }

    const llamaResult = await this.llamaService.analyzeText(prompt, {
      format: 'json'
    });

    if (!llamaResult?.success) {
      logger.warn('[ChatService] LLM response failed', {
        error: llamaResult?.error || 'Unknown error'
      });
      return {
        success: false,
        error: llamaResult?.error || 'LLM response failed',
        sources: retrieval.sources
      };
    }

    const parsed = this._parseResponse(llamaResult.response, retrieval.sources);
    if (!retrieval?.sources?.length) {
      parsed.documentAnswer = [];
    }
    const queryMeta = {
      ...retrieval.meta,
      responseMode: forcedResponseMode,
      holisticIntent,
      correctionIntent,
      comparisonIntent,
      gapAnalysisIntent,
      contradictions
    };
    let assistantForMemory = {
      text: this._formatForMemory(parsed, retrieval.sources),
      documentAnswer: parsed.documentAnswer,
      modelAnswer: parsed.modelAnswer,
      sources: retrieval.sources,
      followUps: parsed.followUps || [],
      meta: queryMeta
    };

    // Smart fallback if model returns nothing (improves UX)
    if (parsed.documentAnswer.length === 0 && parsed.modelAnswer.length === 0) {
      const dropped = /** @type {any} */ (retrieval.meta)?.droppedLowRelevance || 0;
      if (retrieval.sources.length === 0 && dropped === 0) {
        parsed.modelAnswer.push({
          text: "I didn't find any documents matching your query. Try rephrasing with different keywords, or ask about a topic that's in your indexed files."
        });
      } else if (retrieval.sources.length === 0 && dropped > 0) {
        parsed.modelAnswer.push({
          text: `I found ${dropped} document${dropped > 1 ? 's' : ''} but none were relevant enough to your question. Try more specific keywords or a different angle.`
        });
      } else {
        parsed.modelAnswer.push({
          text: `I found ${retrieval.sources.length} related document${retrieval.sources.length > 1 ? 's' : ''} but couldn't extract a specific answer. You can explore the sources below directly.`
        });
      }
      // Re-format for memory since we added a fallback response
      assistantForMemory = {
        text: this._formatForMemory(parsed, retrieval.sources),
        documentAnswer: parsed.documentAnswer,
        modelAnswer: parsed.modelAnswer,
        sources: retrieval.sources,
        followUps: parsed.followUps || [],
        meta: queryMeta
      };
      await this._saveMemoryTurn(memory, cleanQuery, assistantForMemory);
    } else {
      await this._saveMemoryTurn(memory, cleanQuery, assistantForMemory);
    }

    return {
      success: true,
      response: parsed,
      sources: retrieval.sources,
      meta: {
        ...retrieval.meta,
        responseMode: forcedResponseMode,
        holisticIntent,
        correctionIntent,
        comparisonIntent,
        gapAnalysisIntent,
        contradictions
      }
    };
  }

  /**
   * Stream a chat turn; emits structured events via `onEvent` (chunks, done, error).
   *
   * @param {any} params - Same retrieval knobs as `query` plus streaming fields
   * @returns {Promise<void>}
   */
  async queryStreaming({
    sessionId,
    requestId,
    query,
    topK = DEFAULTS.topK,
    mode = DEFAULTS.mode,
    chunkTopK = DEFAULTS.chunkTopK,
    chunkWeight = DEFAULTS.chunkWeight,
    contextFileIds = [],
    strictScope = false,
    responseMode = 'fast',
    documentScopeItems = [],
    // Regenerate flow: the user row for this query is already persisted from
    // the original turn, so don't insert it again (it shows up as duplicate
    // user bubbles after a conversation reload).
    skipSaveUserTurn = false,
    onEvent,
    // Setup-phase AbortSignal forwarded from the IPC handler. Fires when
    // the preload timeout rejects the QUERY_STREAM invoke before the
    // stream is fully wired. Mid-stream cancellation continues to use
    // CANCEL_STREAM -> cancelStreamingRequest(). We attach this to the
    // per-stream AbortController so retrieval/embedding work that hasn't
    // reached the first chunk yet aborts cleanly.
    externalSignal
  }) {
    const cleanQuery = typeof query === 'string' ? query.trim() : '';
    if (!cleanQuery || cleanQuery.length < 2) {
      if (onEvent) onEvent({ type: 'error', error: 'Query must be at least 2 characters' });
      return;
    }

    if (!this.llamaService) {
      if (onEvent) onEvent({ type: 'error', error: 'Chat service unavailable' });
      return;
    }

    const streamKey =
      requestId !== undefined && requestId !== null
        ? `req:${String(requestId)}`
        : `session:${String(sessionId || 'default')}:${++_streamKeyCounter}`;

    // Abort any existing streams for this session to prevent parallel generation
    const effectiveSessionId = String(sessionId || 'default');
    for (const [key, state] of this.activeStreamControllers) {
      if (String(state?.sessionId || '') === effectiveSessionId) {
        try {
          state.controller?.abort();
        } catch {
          // Ignore abort errors
        }
        this.activeStreamControllers.delete(key);
      }
    }
    const streamController = new AbortController();
    this.activeStreamControllers.set(streamKey, {
      controller: streamController,
      sessionId: sessionId || 'default'
    });

    // Link the IPC handler's abort signal (preload-timeout / ABORT_INVOKE)
    // into the stream controller. The IPC entry is torn down right after
    // the synchronous handler returns {success:true}, so this listener
    // only matters during setup — but that's the most common place for a
    // stream to stall (retrieval + first-token latency). We don't remove
    // the listener: the external signal is cheap to hold, and when the
    // stream finishes naturally streamController.abort is a no-op.
    if (externalSignal) {
      if (externalSignal.aborted) {
        try {
          streamController.abort(externalSignal.reason || 'external-abort');
        } catch {
          /* noop */
        }
      } else {
        externalSignal.addEventListener(
          'abort',
          () => {
            try {
              streamController.abort(externalSignal.reason || 'external-abort');
            } catch {
              /* noop */
            }
          },
          { once: true }
        );
      }
    }
    const endInteractiveTextRequest = beginInteractiveTextRequest();

    // Slightly tighter than the renderer chunk flush so prose previews feel continuous.
    const STREAM_PREVIEW_INTERVAL_MS = 120;
    let lastPreviewEmitAt = 0;
    let emittedPreviewLength = 0;
    const extractStreamingPreview = (/** @type {any} */ rawText) => {
      if (!rawText) return '';
      const sanitized = String(rawText)
        .replace(/```json\s*/gi, '')
        .replace(/```/g, '');
      const segments = [];
      const completePattern = /"text"\s*:\s*"((?:\\.|[^"\\])*)"/g;
      let match;
      while ((match = completePattern.exec(sanitized)) !== null) {
        if (match[1]) segments.push(match[1]);
      }
      const tailMatch = sanitized.match(/"text"\s*:\s*"((?:\\.|[^"\\])*)$/);
      if (tailMatch?.[1]) {
        segments.push(tailMatch[1]);
      }
      return segments.join('\n\n');
    };
    const normalizePreviewChunk = (/** @type {any} */ text) =>
      String(text || '')
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    const emitPreviewDelta = (/** @type {any} */ rawText, { force = false } = {}) => {
      if (!onEvent) return;
      const now = Date.now();
      if (!force && now - lastPreviewEmitAt < STREAM_PREVIEW_INTERVAL_MS) return;
      const preview = extractStreamingPreview(rawText);
      if (!preview || preview.length <= emittedPreviewLength) return;

      const delta = preview.slice(emittedPreviewLength);
      emittedPreviewLength = preview.length;
      lastPreviewEmitAt = now;

      const normalizedDelta = normalizePreviewChunk(delta);
      if (normalizedDelta.length > 0) {
        onEvent({ type: 'chunk', text: normalizedDelta });
      }
    };

    // Short-circuit for pure chitchat
    try {
      const conversationalEarly = this._isConversational(cleanQuery);
      if (onEvent) {
        onEvent({
          type: 'status',
          text: conversationalEarly ? 'Thinking...' : 'Searching your library...'
        });
      }
      if (conversationalEarly) {
        const memory = await this._getSessionMemory(sessionId);
        memory._documentScope = documentScopeItems || [];
        const history = await this._getHistoryText(memory);

        const prompt = `You are StratoSort, a friendly local AI assistant. You help users search, explore, and understand the files on their machine. Everything runs on-device — no data leaves their computer.

${history ? `Conversation so far:\n${history}\n` : ''}User: "${cleanQuery}"

Respond warmly and naturally. If they greet you or check if you are working, greet them back and briefly mention what you can do. Suggest 2-3 things they could try as follow-up questions.

Example output:
{"modelAnswer":[{"text":"Hey there! I'm up and running. I can search your documents by meaning, answer questions about your files, find related documents, and help organize your workspace. What would you like to explore?"}],"documentAnswer":[],"followUps":["Summarize my most recent documents","What topics do my files cover?","Find files related to taxes"]}

Now respond as JSON:`;

        let fullResponse = '';
        try {
          let tokenCount = 0;
          const onTokenConversational = (/** @type {any} */ token) => {
            fullResponse += token;
            tokenCount++;
            emitPreviewDelta(fullResponse);
            if (tokenCount % 20 === 0 && onEvent) {
              onEvent({ type: 'status', text: 'Generating response...' });
            }
          };
          const cloudProviderConv = this._resolveGenerateBackend('chat');
          // Streams via cloud when available, transparently falls back to local
          // Llama on transient cloud failures (network/budget/rate-limit).
          // Auth/content errors still surface so the user can fix them.
          const conversationalStream = await this._streamWithLocalFallback({
            cloudProvider: cloudProviderConv,
            prompt,
            signal: streamController.signal,
            onToken: onTokenConversational
          });
          fullResponse = conversationalStream.text || fullResponse;
          if (conversationalStream.viaFallback && onEvent) {
            onEvent({
              type: 'status',
              text: 'Cloud provider unavailable; using local model'
            });
          }
          emitPreviewDelta(fullResponse, { force: true });

          const parsed = this._parseResponse(fullResponse, []);
          if (conversationalStream.truncated) {
            parsed.modelAnswer.push({ text: OUTPUT_TRUNCATED_NOTICE });
          }
          await this._saveMemoryTurn(
            memory,
            cleanQuery,
            {
              text: this._formatForMemory(parsed),
              documentAnswer: parsed.documentAnswer || [],
              modelAnswer: parsed.modelAnswer || [],
              sources: [],
              followUps: parsed.followUps || [],
              meta: { retrievalSkipped: true }
            },
            { skipUserMessage: skipSaveUserTurn }
          );

          // Do not emit a final full-prose { type: 'chunk' } here: preview deltas
          // already streamed the text; a duplicate full chunk was appended in the UI.
          if (onEvent)
            onEvent({
              type: 'done',
              response: parsed,
              sources: [],
              meta: { retrievalSkipped: true }
            });
        } catch (err) {
          logger.warn('[ChatService] Conversational streaming failed:', err);
          try {
            const isAbort = err?.name === 'AbortError';
            if (onEvent)
              onEvent({
                type: 'error',
                error: isAbort ? 'Generation canceled' : 'Conversational response failed'
              });
          } catch (eventErr) {
            logger.warn('[ChatService] onEvent callback also failed:', eventErr?.message);
          }
        }
        return;
      }

      const {
        retrieval,
        prompt,
        holisticIntent,
        correctionIntent,
        comparisonIntent,
        gapAnalysisIntent,
        contradictions,
        forcedResponseMode,
        memory
      } = await this._runRetrieval({
        sessionId,
        cleanQuery,
        topK,
        mode,
        chunkTopK,
        chunkWeight,
        contextFileIds,
        strictScope,
        responseMode
      });
      memory._documentScope = documentScopeItems || [];

      if (onEvent) {
        const sourceCount = Array.isArray(retrieval?.sources) ? retrieval.sources.length : 0;
        const droppedLowRelevance = Number(
          /** @type {any} */ (retrieval?.meta)?.droppedLowRelevance || 0
        );
        const droppedForBudget = Number(
          /** @type {any} */ (retrieval?.meta)?.droppedForBudget || 0
        );
        const budgetNote =
          droppedForBudget > 0
            ? ` (${droppedForBudget} more left out to fit the model's context)`
            : '';
        const retrievalStatus =
          sourceCount > 0
            ? `Found ${sourceCount} relevant source${sourceCount === 1 ? '' : 's'}${budgetNote}...`
            : droppedLowRelevance > 0
              ? `No relevant sources found (${droppedLowRelevance} filtered out). Drafting best-effort answer...`
              : 'No relevant sources found. Drafting best-effort answer...';
        onEvent({
          type: 'status',
          text: retrievalStatus
        });
      }

      if (strictScope && (!retrieval.sources || retrieval.sources.length === 0)) {
        const abstentionText =
          'I cannot find this information in the selected documents. Try broadening your document scope or rephrasing your question.';
        /** @type {Record<string, any>} */
        const abstention = {
          documentAnswer: [],
          modelAnswer: [{ text: abstentionText }],
          followUps: []
        };
        // Persist the abstention so it survives conversation reload
        await this._saveMemoryTurn(
          memory,
          cleanQuery,
          {
            text: abstentionText,
            documentAnswer: [],
            modelAnswer: abstention.modelAnswer,
            sources: [],
            followUps: [],
            meta: { ...retrieval.meta, strictScopeAbstention: true }
          },
          { skipUserMessage: skipSaveUserTurn }
        );
        if (onEvent) {
          onEvent({ type: 'chunk', text: abstentionText });
          onEvent({
            type: 'done',
            response: abstention,
            sources: [],
            meta: { ...retrieval.meta, strictScopeAbstention: true }
          });
        }
        return;
      }

      let fullResponse = '';
      let tokenCount = 0;
      const onTokenRetrieval = (/** @type {any} */ token) => {
        fullResponse += token;
        tokenCount++;
        emitPreviewDelta(fullResponse);
        if (tokenCount % 20 === 0 && onEvent) {
          onEvent({ type: 'status', text: 'Analyzing documents...' });
        }
      };
      const cloudProviderRetrieval = this._resolveGenerateBackend('chat');
      const retrievalStream = await this._streamWithLocalFallback({
        cloudProvider: cloudProviderRetrieval,
        prompt,
        signal: streamController.signal,
        onToken: onTokenRetrieval
      });
      fullResponse = retrievalStream.text || fullResponse;
      if (retrievalStream.viaFallback && onEvent) {
        onEvent({
          type: 'status',
          text: 'Cloud provider unavailable; using local model'
        });
      }
      emitPreviewDelta(fullResponse, { force: true });

      const parsed = this._parseResponse(fullResponse, retrieval.sources);
      if (!retrieval?.sources?.length) {
        parsed.documentAnswer = [];
      }

      // Smart fallback logic (mirrors query())
      if (parsed.documentAnswer.length === 0 && parsed.modelAnswer.length === 0) {
        const dropped = /** @type {any} */ (retrieval.meta)?.droppedLowRelevance || 0;
        let fallbackText = '';
        if (retrieval.sources.length === 0 && dropped === 0) {
          fallbackText =
            "I didn't find any documents matching your query. Try rephrasing with different keywords, or ask about a topic that's in your indexed files.";
        } else if (retrieval.sources.length === 0 && dropped > 0) {
          fallbackText = `I found ${dropped} document${dropped > 1 ? 's' : ''} but none were relevant enough to your question. Try more specific keywords or a different angle.`;
        } else {
          fallbackText = `I found ${retrieval.sources.length} related document${retrieval.sources.length > 1 ? 's' : ''} but couldn't extract a specific answer. You can explore the sources below directly.`;
        }
        parsed.modelAnswer.push({ text: fallbackText });
      }
      if (retrievalStream.truncated) {
        parsed.modelAnswer.push({ text: OUTPUT_TRUNCATED_NOTICE });
      }

      // Do not emit a final full-prose { type: 'chunk' }: streaming preview deltas
      // already built the visible text; the renderer finalizes from `done`.

      const assistantForMemory = {
        text: this._formatForMemory(parsed, retrieval.sources),
        documentAnswer: parsed.documentAnswer,
        modelAnswer: parsed.modelAnswer,
        sources: retrieval.sources,
        followUps: parsed.followUps || [],
        meta: {
          ...retrieval.meta,
          responseMode: forcedResponseMode,
          holisticIntent,
          comparisonIntent,
          gapAnalysisIntent,
          contradictions
        }
      };
      await this._saveMemoryTurn(memory, cleanQuery, assistantForMemory, {
        skipUserMessage: skipSaveUserTurn
      });

      if (onEvent) {
        onEvent({
          type: 'done',
          response: parsed,
          sources: retrieval.sources,
          meta: {
            ...retrieval.meta,
            responseMode: forcedResponseMode,
            holisticIntent,
            correctionIntent,
            comparisonIntent,
            gapAnalysisIntent,
            contradictions
          }
        });
      }
    } catch (error) {
      logger.error('[ChatService] Streaming query failed:', error);
      const isAbort = error?.name === 'AbortError';
      if (!isAbort) {
        try {
          const memory = await this._getSessionMemory(sessionId);
          if (this.chatHistoryStore && memory?.sessionId) {
            let conv = this.chatHistoryStore.getConversation(memory.sessionId);
            if (!conv) {
              // Use documentScopeItems from the outer scope instead of memory._documentScope,
              // which is empty on a fresh _getSessionMemory() call in the error path.
              this.chatHistoryStore.createConversation(
                (typeof cleanQuery === 'string' ? cleanQuery.slice(0, 50) : '') ||
                  'New Conversation',
                documentScopeItems || [],
                memory.sessionId
              );
            }
            if (!skipSaveUserTurn) {
              this.chatHistoryStore.addMessage(memory.sessionId, {
                role: 'user',
                text: cleanQuery
              });
            }
            this.chatHistoryStore.addMessage(memory.sessionId, {
              role: 'assistant',
              text: '',
              modelAnswer: [
                { text: `Error: ${error.message || 'Response failed'}. Please try again.` }
              ]
            });
          }
        } catch (saveErr) {
          logger.warn('[ChatService] Failed to save error turn:', saveErr.message);
        }
      }
      if (onEvent) {
        try {
          onEvent({
            type: 'error',
            error: isAbort ? 'Generation canceled' : error.message || 'Streaming failed'
          });
        } catch (notifyErr) {
          logger.debug('[ChatService] Failed to send error event to renderer:', notifyErr.message);
        }
      }
    } finally {
      this.activeStreamControllers.delete(streamKey);
      endInteractiveTextRequest();
    }
  }

  /**
   * Non-streaming single-turn RAG chat for MCP callers.
   * Reuses the existing retrieve+prompt pipeline and wraps
   * LlamaService.generateTextStreaming with an AbortController timeout.
   *
   * @param {Object} params
   * @param {string} params.query
   * @param {string} [params.sessionId]
   * @param {number} [params.maxContextFiles=5]
   * @param {string} [params.persona]
   * @param {number} [params.timeoutMs=60000]
   * @param {boolean} [params.forceLocal=false] Skip any configured cloud
   *   provider and generate with the local model only. MCP-originated calls
   *   set this: docs/MCP_SERVER.md promises zero outbound calls for the MCP
   *   surface regardless of the user's in-app cloud chat settings.
   * @returns {Promise<{sessionId:string, answer:string, citations:Array<any>, grounded:boolean, tokens_used:Object}>}
   */
  async runOnce({
    query,
    sessionId,
    maxContextFiles = 5,
    persona,
    timeoutMs = 60_000,
    forceLocal = false
  }) {
    if (!this.llamaService) {
      const err = new Error(
        'LLM model not loaded — open StratoSort and wait for the model to finish loading.'
      );
      /** @type {any} */ (err).code = 'NO_MODEL';
      throw err;
    }

    const cleanQuery = String(query || '').trim();
    if (!cleanQuery) {
      const err = /** @type {Error & { code?: string }} */ (new Error('query is required'));
      err.code = 'INVALID_QUERY';
      throw err;
    }

    // The client keeps using its own id; only the memory key is namespaced so
    // an MCP client can never address an in-app conversation.
    const effectiveSessionId = String(sessionId || `mcp-${Date.now()}`);
    const memoryKey = `${MCP_SESSION_PREFIX}${effectiveSessionId}`;

    // Reuse the existing retrieve+prompt pipeline against the MCP-only store.
    const { retrieval, prompt, memory } = await this._runRetrieval({
      sessionId: memoryKey,
      cleanQuery,
      topK: maxContextFiles,
      mode: 'hybrid',
      chunkTopK: maxContextFiles * 2,
      chunkWeight: undefined,
      contextFileIds: [],
      strictScope: false,
      responseMode: 'fast',
      memoryStore: this._mcpSessions
    });
    // A search that threw is not "no matching documents": report it as the
    // RETRIEVAL_FAILED the tool contract names instead of answering from
    // the model alone and calling that grounded.
    if (/** @type {any} */ (retrieval?.meta)?.retrievalAvailable === false) {
      const failed = /** @type {Error & { code?: string }} */ (
        new Error(/** @type {any} */ (retrieval.meta).error || 'Document retrieval failed')
      );
      failed.code = 'RETRIEVAL_FAILED';
      throw failed;
    }

    // Generate with timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let fullResponse = '';
    let outputTruncated = false;
    try {
      const cloudProviderOnce = forceLocal ? null : this._resolveGenerateBackend('chat');
      // _streamWithLocalFallback accumulates via onToken and falls back to
      // local on transient cloud errors. The `systemPrompt: persona` arg
      // used to be passed only on the cloud path; for parity we pass it
      // along when invoking the cloud provider but the local generator
      // (generateTextStreaming) accepts the same field.
      const tokenAccumulator = (/** @type {any} */ token) => {
        if (typeof token === 'string') fullResponse += token;
      };
      if (cloudProviderOnce) {
        try {
          const result = await /** @type {any} */ (cloudProviderOnce).chatStream({
            prompt,
            systemPrompt: persona,
            signal: controller.signal,
            onToken: tokenAccumulator
          });
          if (!fullResponse) fullResponse = result?.text || '';
          outputTruncated = result?.truncated === true;
        } catch (err) {
          if (err?.name === 'AbortError' || controller.signal.aborted) throw err;
          const code = err && err.name === 'AIProviderError' ? err.code : null;
          // tokensEmitted guard: tokenAccumulator already holds partial cloud
          // text; a local retry would concatenate a second answer onto it.
          if (!(code && CLOUD_CHAT_FALLBACK_CODES.has(code) && err.tokensEmitted !== true))
            throw err;
          logger.warn('[ChatService] runOnce: cloud provider error; falling back to local', {
            provider:
              /** @type {any} */ (cloudProviderOnce).id ||
              /** @type {any} */ (cloudProviderOnce).displayName ||
              'cloud',
            code
          });
          const result = await this.llamaService.generateTextStreaming({
            prompt,
            systemPrompt: persona,
            signal: controller.signal,
            onToken: tokenAccumulator,
            maxTokens: 1024
          });
          if (!fullResponse) fullResponse = result?.response || '';
        }
      } else {
        // generateTextStreaming returns `{ response }` not a plain string —
        // assigning the whole result to `fullResponse` (and discarding tokens
        // via the empty onToken) made `_parseResponse` run against an object
        // instead of text, silently producing an empty parsed result every
        // time runOnce was used. Fix: accumulate via onToken and fall back to
        // `result.response` for the final text.
        const result = await this.llamaService.generateTextStreaming({
          prompt,
          systemPrompt: persona,
          signal: controller.signal,
          onToken: tokenAccumulator,
          maxTokens: 1024
        });
        if (!fullResponse) fullResponse = result?.response || '';
      }
    } catch (err) {
      if (err?.name === 'AbortError' || controller.signal.aborted) {
        const t = /** @type {Error & { code?: string }} */ (
          new Error(`Chat generation timed out after ${timeoutMs}ms`)
        );
        t.code = 'TIMEOUT';
        throw t;
      }
      const wrapped = /** @type {Error & { code?: string }} */ (
        new Error(err?.message || 'Chat generation failed')
      );
      // A model that is missing or not loaded is the tool's MODEL_NOT_READY,
      // not a retrieval failure.
      wrapped.code = MODEL_NOT_READY_CODES.has(String(err?.code || ''))
        ? 'NO_MODEL'
        : 'RETRIEVAL_FAILED';
      throw wrapped;
    } finally {
      clearTimeout(timer);
    }

    const parsed = this._parseResponse(fullResponse, retrieval.sources);
    // With nothing retrieved there is nothing to ground on: keep the model's
    // own words (the prompt told it to say it found no documents) and drop
    // document-shaped claims, as the in-app path does.
    const sources = Array.isArray(retrieval.sources) ? retrieval.sources : [];
    if (sources.length === 0) parsed.documentAnswer = [];

    // Markers in `answer` are 1-based indexes into `citations`, numbered in
    // first-use order (docs/MCP_SERVER.md). The engine's doc-N ids are
    // conversation-scoped ordinals that need not start at 1 or be contiguous,
    // so a client could not map them to the list. Inline tokens count as
    // citations too: a model that cites only inline used to yield an empty
    // list under markers nothing could resolve.
    const sourceById = new Map(sources.map((/** @type {any} */ s) => [s.id, s]));
    /** @type {string[]} */
    const orderedDocIds = [];
    const noteDocId = (/** @type {string} */ id) => {
      if (sourceById.has(id) && !orderedDocIds.includes(id)) orderedDocIds.push(id);
    };
    for (const item of parsed.documentAnswer) {
      for (const match of String(item.text || '').matchAll(/\[doc-(\d+)\]/g)) {
        noteDocId(`doc-${match[1]}`);
      }
      for (const id of item.citations || []) noteDocId(id);
    }
    const markerById = new Map(orderedDocIds.map((id, i) => [id, i + 1]));
    const renumber = (/** @type {string} */ text) =>
      String(text || '')
        .replace(/[ \t]*\[doc-(\d+)\]/g, (token, num) => {
          const marker = markerById.get(`doc-${num}`);
          return marker ? token.replace(/\[doc-\d+\]/, `[${marker}]`) : '';
        })
        .replace(/\s+([.,;:!?])/g, '$1')
        .trim();

    // Build the answer string by concatenating doc + model answers.
    const answerParts = [];
    for (const item of parsed.documentAnswer) answerParts.push(renumber(item.text));
    for (const item of parsed.modelAnswer) answerParts.push(renumber(item.text));
    if (outputTruncated) answerParts.push(OUTPUT_TRUNCATED_NOTICE);
    const answer = answerParts.filter(Boolean).join('\n\n');

    await this._mcpSessions.saveMemoryTurn(memory, cleanQuery, answer);

    const citations = orderedDocIds.map((id, i) => {
      const s = sourceById.get(id);
      return {
        id: i + 1,
        file_path: s.path || '',
        file_name: s.name || '',
        snippet: s.snippet || '',
        chunk_index: s.matchDetails?.chunkIndex ?? 0
      };
    });

    return {
      sessionId: effectiveSessionId,
      answer,
      citations,
      grounded: citations.length > 0,
      tokens_used: {
        prompt: Math.max(1, Math.round(String(prompt).length / 4)),
        completion: Math.round(String(fullResponse).length / 4)
      }
    };
  }

  /**
   * `memoryStore` is the SessionMemory that history is read from and citation
   * ordinals are registered on; defaults to the in-app store (`_sessions`).
   * @param {any} params
   */
  async _runRetrieval({
    sessionId,
    cleanQuery,
    topK,
    mode,
    chunkTopK,
    chunkWeight,
    contextFileIds,
    strictScope = false,
    responseMode,
    memoryStore = this._sessions
  }) {
    logger.info('[ChatService] Retrieval started', {
      sessionId: sessionId || 'default',
      queryLength: cleanQuery.length,
      topK,
      mode,
      chunkTopK,
      chunkWeight,
      contextFileCount: Array.isArray(contextFileIds) ? contextFileIds.length : 0
    });

    const memory = await memoryStore.getSessionMemory(sessionId);
    const history = await memoryStore.getHistoryText(memory);
    const holisticIntent = this._isHolisticSynthesisQuery(cleanQuery);
    const correctionIntent = this._isCorrectionFeedback(cleanQuery);
    const comparisonIntent = this._isComparisonQuery(cleanQuery);
    const gapAnalysisIntent = this._isGapAnalysisQuery(cleanQuery);

    // Precompute embedding to share between hybridSearch and _scoreContextFiles
    // This saves a redundant inference call when context files are present.
    let precomputedEmbedding = null;
    if (this.embeddingService && mode !== 'bm25') {
      try {
        const CHAT_EMBEDDING_TIMEOUT_MS = 3000;
        const normalizedQuery = cleanQuery.trim().replace(/\s+/g, ' ');
        const embedPromise = this.embeddingService.embedText(normalizedQuery);
        // Attach the rejection absorber BEFORE the race. Previously this line
        // lived after the await, so if embedPromise rejected while (or even
        // before) the race was running, Node would log an
        // unhandledPromiseRejection from the still-unhandled original
        // promise and — in newer runtimes — could crash the process. The
        // race-wrapped `.then(...)` handles its own fulfillment/rejection
        // path, but the raw `embedPromise` needs its own no-op catch
        // attached synchronously.
        embedPromise.catch(() => {});
        const result = await Promise.race([
          embedPromise.then((/** @type {any} */ r) => (r?.vector ? { vector: r.vector } : null)),
          new Promise((resolve) => setTimeout(() => resolve(null), CHAT_EMBEDDING_TIMEOUT_MS))
        ]);
        precomputedEmbedding = result?.vector || null;
      } catch (e) {
        // error (not warn): a failed embedding silently degrades chat from
        // semantic-augmented retrieval to keyword-only, which the user
        // experiences as worse answers with no indication why. Operators
        // need this in default-level logs to correlate.
        logger.error('[ChatService] Embedding precompute failed; degrading to keyword-only', {
          error: e.message
        });
      }
    }

    // Normalize so callers cannot pass an unknown string and silently get hybrid behavior.
    const normalizedResponseMode = responseMode === 'deep' ? 'deep' : 'fast';
    const forcedResponseMode = normalizedResponseMode;
    const intentSuggestsDeep = holisticIntent || comparisonIntent || gapAnalysisIntent;
    // Broad retrieval + chunk expansion only when the user chose Deep *and* the query
    // matches holistic / comparison / gap heuristics. Fast always stays on the fast path.
    const modeConfig = RESPONSE_MODES[forcedResponseMode] || RESPONSE_MODES.fast;
    const needsBroadRetrieval = normalizedResponseMode === 'deep' && intentSuggestsDeep;
    const effectiveTopK = needsBroadRetrieval ? Math.max(topK, HOLISTIC_MIN_TOPK) : topK;
    const effectiveChunkTopK = needsBroadRetrieval
      ? Math.max(
          Number.isInteger(chunkTopK) && chunkTopK > 0 ? chunkTopK : modeConfig.chunkTopK,
          HOLISTIC_MIN_CHUNK_TOPK
        )
      : Number.isInteger(chunkTopK) && chunkTopK > 0
        ? chunkTopK
        : modeConfig.chunkTopK;
    const effectiveChunkWeight = needsBroadRetrieval
      ? Math.max(
          typeof chunkWeight === 'number' ? chunkWeight : modeConfig.chunkWeight,
          HOLISTIC_MIN_CHUNK_WEIGHT
        )
      : typeof chunkWeight === 'number'
        ? chunkWeight
        : modeConfig.chunkWeight;
    const effectiveRerank = Boolean(modeConfig.rerank);

    const retrieval = await this._retrieveSources(cleanQuery, {
      topK: effectiveTopK,
      mode,
      chunkTopK: effectiveChunkTopK,
      chunkWeight: effectiveChunkWeight,
      contextFileIds,
      strictScope,
      expandSynonyms: modeConfig.expandSynonyms,
      correctSpelling: modeConfig.correctSpelling,
      rerank: effectiveRerank,
      precomputedEmbedding
    });

    const _rmeta = /** @type {any} */ (retrieval?.meta);
    logger.debug('[ChatService] Retrieval completed', {
      resultCount: retrieval?.sources?.length || 0,
      mode: _rmeta?.mode || mode,
      contextBoosted: Boolean(_rmeta?.contextBoosted),
      queryMeta: _rmeta?.queryMeta ? Object.keys(_rmeta.queryMeta) : []
    });

    // Stable citations: remap the engine's per-turn sequential doc-N ids to
    // conversation-scoped first-seen ordinals so the same document keeps its
    // number across turns (ids may be non-contiguous within a turn).
    retrieval.sources = memoryStore.applyStableCitationIds(memory, retrieval.sources);

    const contradictions = this._detectContradictions(retrieval.sources);

    const persona = await this._getPersona();
    const effectiveContext =
      typeof this.llamaService?._getEffectiveContextSize === 'function'
        ? this.llamaService._getEffectiveContextSize('text')
        : 2048;
    const built = this._buildPrompt({
      query: cleanQuery,
      history,
      sources: retrieval.sources,
      persona,
      responseMode: forcedResponseMode,
      intent: {
        holisticIntent,
        correctionIntent,
        comparisonIntent,
        gapAnalysisIntent
      },
      strictScope,
      contradictions,
      effectiveContext
    });
    // The sources the model saw are the only ones the answer can cite and
    // the only ones the UI may list. Anything the budget dropped is reported
    // in meta instead of shown as if it had been read.
    const keptIds = new Set(built.keptSourceIds);
    const promptSources = retrieval.sources.filter((/** @type {any} */ s) => keptIds.has(s.id));
    const droppedForBudget = retrieval.sources.length - promptSources.length;
    retrieval.sources = promptSources;
    retrieval.meta = /** @type {any} */ ({
      ...(retrieval.meta || {}),
      sourcesInPrompt: promptSources.length,
      droppedForBudget,
      extractScale: built.extractScale
    });
    const prompt = built.prompt;

    return {
      history,
      retrieval,
      persona,
      prompt,
      holisticIntent,
      correctionIntent,
      comparisonIntent,
      gapAnalysisIntent,
      contradictions,
      forcedResponseMode,
      memory
    };
  }

  async _getSessionMemory(/** @type {any} */ sessionId) {
    return this._sessions.getSessionMemory(sessionId);
  }

  // Existing oracles address the LRU directly (size/has); expose the real one.
  get _sessionLRU() {
    return this._sessions.lru;
  }

  async _persistEvictedInMemorySession(/** @type {any} */ sessionKey, /** @type {any} */ memory) {
    return this._sessions.persistEvictedInMemorySession(sessionKey, memory);
  }

  _createMemory(/** @type {any} */ sessionKey) {
    return this._sessions.createMemory(sessionKey);
  }

  async _getHistoryText(/** @type {any} */ memory) {
    return this._sessions.getHistoryText(memory);
  }

  async _saveMemoryTurn(
    /** @type {any} */ memory,
    /** @type {any} */ input,
    /** @type {any} */ output,
    options = {}
  ) {
    return this._sessions.saveMemoryTurn(memory, input, output, options);
  }

  _isConversational(/** @type {any} */ query) {
    return queryIntent.isConversational(query);
  }

  _isComparisonQuery(/** @type {any} */ query) {
    return queryIntent.isComparisonQuery(query);
  }

  _isGapAnalysisQuery(/** @type {any} */ query) {
    return queryIntent.isGapAnalysisQuery(query);
  }

  _detectContradictions(/** @type {any} */ sources) {
    return queryIntent.detectContradictions(sources);
  }

  _isHolisticSynthesisQuery(/** @type {any} */ query) {
    return queryIntent.isHolisticSynthesisQuery(query);
  }

  _isCorrectionFeedback(/** @type {any} */ query) {
    return queryIntent.isCorrectionFeedback(query);
  }

  async _retrieveSources(/** @type {any} */ query, /** @type {any} */ options) {
    return this._retrieval.retrieveSources(query, options);
  }

  async _scoreContextFiles(
    /** @type {any} */ query,
    /** @type {any} */ fileIds,
    /** @type {any} */ precomputedEmbedding = null
  ) {
    return this._retrieval.scoreContextFiles(query, fileIds, precomputedEmbedding);
  }

  _padOrTruncateVector(/** @type {any} */ vector, /** @type {any} */ expectedDim) {
    return this._retrieval.padOrTruncateVector(vector, expectedDim);
  }

  async _getPersona() {
    try {
      if (this.settingsService?.load) {
        const settings = await this.settingsService.load();
        // getEffectivePersona resolves either a built-in or a user-defined
        // persona (passed via customChatPersonas), then merges
        // chatPersonaCustomGuidance (free-text override settable from the
        // Settings UI) into the chosen persona's guidance. The result has
        // the same shape so the rest of the chat pipeline doesn't need
        // to know about either form of customization.
        return getEffectivePersona(
          settings?.chatPersona,
          settings?.chatPersonaCustomGuidance,
          settings?.customChatPersonas
        );
      }
    } catch (error) {
      logger.debug('[ChatService] Failed to load persona setting:', error.message);
    }
    return getChatPersonaOrDefault(/** @type {any} */ (undefined));
  }

  _buildPrompt(/** @type {any} */ params) {
    return buildPrompt(params);
  }

  _parseResponse(/** @type {any} */ rawResponse, /** @type {any} */ sources) {
    return citationExtractor.parseResponse(rawResponse, sources);
  }

  _clampAnswerText(/** @type {any} */ text) {
    return citationExtractor.clampAnswerText(text);
  }

  _reconcileInlineCitations(/** @type {any} */ text, /** @type {any} */ sourceIds) {
    return citationExtractor.reconcileInlineCitations(text, sourceIds);
  }

  _formatForMemory(/** @type {any} */ parsed, /** @type {any} */ sources = []) {
    return citationExtractor.formatForMemory(parsed, sources);
  }

  /**
   * Returns the cloud AI provider chosen by the router for chat operations,
   * or null if no cloud provider is configured / the router is unavailable.
   *
   * Lazy-required so this module remains loadable without the IPC tree being
   * initialized (unit tests, early-boot paths). When null is returned the
   * caller MUST fall back to direct this.llamaService usage.
   *
   * Use `_streamWithLocalFallback` (below) for the actual streaming call so
   * transient cloud failures degrade gracefully to local without hard-failing
   * the whole conversation. Auth/quota/content errors still surface so the
   * user can fix them — same policy as documentLlm.js.
   *
   * @param {string} [operation='chat'] Operation hint passed to router.choose().
   * @returns {Object|null} Provider instance or null (use direct llamaService).
   */
  _resolveGenerateBackend(operation = 'chat') {
    let router;
    try {
      const aiProvider = require('../ipc/aiProvider');
      router = aiProvider.getActiveAiRouter ? aiProvider.getActiveAiRouter() : null;
    } catch {
      router = null;
    }
    if (!router) return null;
    try {
      const provider = router.choose({ operation, allowFallback: false });
      // Local provider: skip routing — direct llamaService is faster (no double-wrap)
      if (provider.id === 'local') return null;
      return provider;
    } catch {
      // No cloud provider ready — caller will use direct llamaService
      return null;
    }
  }

  /**
   * Stream a chat response, transparently falling back to the local Llama
   * model when the cloud provider hits a transient/policy failure.
   *
   * Why this exists: pre-fix, ChatService routed to a cloud provider with
   * `allowFallback: false` and surfaced any error as a fatal "Chat failed"
   * to the user — including transient hiccups that v2.0.9 never had because
   * v2 was always local. The fallback codes mirror documentLlm.js so the
   * "what counts as transient" policy is consistent across analysis + chat:
   * BUDGET_EXCEEDED / RATE_LIMITED / NETWORK_ERROR / PROVIDER_FAILED degrade
   * silently; AUTH_FAILED / CONTENT_TOO_LONG / etc. still surface so the
   * user is prompted to fix their config.
   *
   * @param {Object} params
   * @param {Object|null} params.cloudProvider Provider from `_resolveGenerateBackend`, or null for local.
   * @param {string} params.prompt
   * @param {AbortSignal} params.signal
   * @param {Function} params.onToken
   * @returns {Promise<{text: string, viaFallback: boolean, fallbackReason?: string, truncated?: boolean}>}
   */
  async _streamWithLocalFallback({ cloudProvider, prompt, signal, onToken }) {
    const localStream = async () => {
      let fullResponse = '';
      const wrapToken = (/** @type {any} */ token) => {
        fullResponse += token;
        if (typeof onToken === 'function') onToken(token);
      };
      await this.llamaService.generateTextStreaming({
        prompt,
        signal,
        onToken: wrapToken
      });
      return { text: fullResponse, viaFallback: false };
    };

    if (!cloudProvider) {
      return localStream();
    }

    try {
      const result = await /** @type {any} */ (cloudProvider).chatStream({
        prompt,
        signal,
        onToken
      });
      return {
        text: result?.text || '',
        viaFallback: false,
        truncated: result?.truncated === true
      };
    } catch (err) {
      // Don't fall back on user-initiated abort — that's not a cloud failure.
      if (err?.name === 'AbortError') throw err;

      const code = err && err.name === 'AIProviderError' ? err.code : null;
      // tokensEmitted guard: if the cloud stream died AFTER streaming tokens
      // through onToken, a local retry would append a second answer to the
      // partial one already rendered. Surface the failure instead; only
      // zero-token failures (headers arrived, connection died before the
      // first token) fall back transparently.
      if (code && CLOUD_CHAT_FALLBACK_CODES.has(code) && err.tokensEmitted !== true) {
        logger.warn('[ChatService] cloud provider error; falling back to local Llama', {
          provider:
            /** @type {any} */ (cloudProvider).id ||
            /** @type {any} */ (cloudProvider).displayName ||
            'cloud',
          code,
          message: err.message
        });
        const fallback = await localStream();
        return { ...fallback, viaFallback: true, fallbackReason: code };
      }
      // Non-transient (or mid-stream after tokens): surface so the user can
      // fix config (auth, quota, content) or retry cleanly.
      throw err;
    }
  }
}

module.exports = ChatService;
