// @ts-check
/**
 * Chat-tab state + logic for the Unified Search modal (§I Phase 4).
 *
 * Owns the conversation lifecycle (session id, message list with the
 * MAX_CHAT_MESSAGES cap, streaming submit with request-id stale-guards,
 * stop/regenerate/reset), the document scope panel state, and persona /
 * response-mode selection.  flows IN (chat context);
 * the graph bridge (handleUseSourcesInGraph) stays in the modal.
 *
 * Extracted verbatim from UnifiedSearchModal — behavior parity is pinned
 * by the existing modal suites.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createLogger } from '../../../../shared/logger';
import {
  DEFAULT_CHAT_PERSONA_ID,
  getAllChatPersonas,
  getChatPersonaById
} from '../../../../shared/chatPersonas';
import { queryStream, getConversation } from '../../../services/ipc/chatIpc';
import { mapErrorToNotification } from '../../../utils/errorMapping';
import { nextRequestId, isCurrentRequest, invalidateRequests } from '../../../utils/requestGuard';
import { getMetadataPath, getMetadataName } from '../utils';

const logger = createLogger('useChatTab');

const ENABLE_SEARCH_TRACE_LOGS = process.env.NODE_ENV === 'development';

const MAX_CHAT_MESSAGES = 200;

/**
 * @param {{
 *   isOpen: boolean,
 *   searchResults: any[],
 *   defaultTopK: number,
 *   openFile: (path: string) => void,
 *   setError: (v: string) => void
 * }} props
 */
export function useChatTab({ isOpen, searchResults, defaultTopK, openFile, setError }) {
  const [chatMessages, setChatMessages] = useState([]);
  const [currentConversationId, setCurrentConversationId] = useState(null);
  const [strictScope, setStrictScope] = useState(false);
  const [documentScope, setDocumentScope] = useState([]);
  const [isConvSidebarOpen, setIsConvSidebarOpen] = useState(true);
  const [isDocScopeOpen, setIsDocScopeOpen] = useState(false);
  const [isChatting, setIsChatting] = useState(false);
  const [chatError, setChatError] = useState('');
  const [chatWarning, setChatWarning] = useState('');
  // Off by default: on, chat answers from the Search tab's last results
  // instead of the whole library, which is a scope the user should choose.
  const [useSearchContext, setUseSearchContext] = useState(false);
  const [responseMode, setResponseMode] = useState('fast');
  const [chatPersona, setChatPersona] = useState(DEFAULT_CHAT_PERSONA_ID);
  const [chatStatus, setChatStatus] = useState('');
  /** Sanitized custom personas from settings (refreshed when Knowledge OS opens). */
  const [savedCustomPersonas, setSavedCustomPersonas] = useState([]);

  const chatPersonaOptions = useMemo(
    () => getAllChatPersonas(savedCustomPersonas),
    [savedCustomPersonas]
  );

  // Hydrate persisted chat preferences (response mode, personas) on open.
  useEffect(() => {
    if (!isOpen) return undefined;
    let isMounted = true;
    const loadChatPreferences = async () => {
      try {
        const settings = await window.electronAPI?.settings?.get?.();
        if (!isMounted) return;
        const savedMode = settings?.chatResponseMode;
        if (savedMode === 'fast' || savedMode === 'deep') {
          setResponseMode(savedMode);
        }
        const customs = Array.isArray(settings?.customChatPersonas)
          ? settings.customChatPersonas
          : [];
        setSavedCustomPersonas(customs);
        const savedPersona = settings?.chatPersona;
        if (getChatPersonaById(savedPersona, customs)) {
          setChatPersona(savedPersona);
        } else if (savedPersona) {
          setChatPersona(DEFAULT_CHAT_PERSONA_ID);
        }
      } catch (error) {
        logger.debug('[useChatTab] Failed to load chat preferences', {
          error: error?.message || String(error)
        });
      }
    };
    loadChatPreferences();
    return () => {
      isMounted = false;
    };
  }, [isOpen]);

  const chatSessionRef = useRef(null);
  const chatRequestCounterRef = useRef(0);
  const chatInFlightRef = useRef(false);
  const chatStreamRef = useRef(null);
  const chatWatchdogRef = useRef(null);
  // Streaming throttle: accumulate tokens in a ref and flush to state every 200ms
  // instead of once per animation frame (~60fps). This drops state updates from
  // ~60/sec to ~5/sec, avoiding O(n) array clones on every token.
  const pendingStreamChunkRef = useRef('');
  const streamingRafRef = useRef(null);
  const streamingFlushIntervalRef = useRef(null);

  // Tear down active chat stream resources (watchdog, flush interval, and
  // the stream itself). Called by the modal on close AND on unmount so no
  // token flushes land after teardown.
  const cancelChatStream = useCallback(() => {
    clearTimeout(chatWatchdogRef.current);
    chatWatchdogRef.current = null;
    clearInterval(streamingFlushIntervalRef.current);
    streamingFlushIntervalRef.current = null;
    chatStreamRef.current?.cancel?.();
    chatStreamRef.current = null;
  }, []);

  // Cancel any in-flight stream on unmount.
  useEffect(() => () => cancelChatStream(), [cancelChatStream]);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const ensureChatSession = useCallback(() => {
    if (!chatSessionRef.current) {
      chatSessionRef.current = crypto.randomUUID();
    }
    return chatSessionRef.current;
  }, []);

  const handleChatSend = useCallback(
    async (
      /** @type {any} */ text,
      /** @type {any} */ overrideContextIds = null,
      /** @type {any} */ options = {}
    ) => {
      const { skipAddUserMessage = false } = options || {};
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (!trimmed) return;
      if (chatInFlightRef.current) {
        setChatWarning('Please wait for the current response to finish.');
        return;
      }

      const requestId = nextRequestId(chatRequestCounterRef);
      chatInFlightRef.current = true;

      setChatError('');
      setChatWarning('');
      setChatStatus('Getting ready...');
      setIsChatting(true);

      try {
        const sessionId = ensureChatSession();
        let contextFileIds = [];

        if (Array.isArray(overrideContextIds) && overrideContextIds.length > 0) {
          contextFileIds = overrideContextIds;
        } else if (documentScope.length > 0) {
          contextFileIds = documentScope.map((item) => item.id);
        } else if (useSearchContext) {
          const resultScoreMap = new Map(
            (searchResults || []).map((/** @type {any} */ result) => [
              result?.id,
              Number(result?.score) || 0
            ])
          );
          contextFileIds = Array.from(
            new Set(
              (searchResults || [])
                .map((/** @type {any} */ result) => result?.id)
                .filter((/** @type {any} */ id) => typeof id === 'string' && id.length > 0)
            )
          )
            .sort((aId, bId) => {
              const aScore = resultScoreMap.get(aId) || 0;
              const bScore = resultScoreMap.get(bId) || 0;
              return bScore - aScore;
            })
            .slice(0, 200);
        }

        if (strictScope && contextFileIds.length === 0) {
          setChatWarning(
            'Strict scope is enabled but no documents are selected. Add files to the scope or enable search context.'
          );
          setChatStatus('');
          setIsChatting(false);
          chatInFlightRef.current = false;
          return;
        }

        if (strictScope && documentScope.length === 0 && contextFileIds.length > 0) {
          setChatWarning(
            'Strict scope is using your current search results as the document set. Add files to the document scope panel to pin specific documents.'
          );
        }

        if (!skipAddUserMessage) {
          setChatMessages((prev) => {
            const next = [...prev, { role: 'user', text: trimmed }];
            if (next.length > MAX_CHAT_MESSAGES) {
              let toRemove = next.length - MAX_CHAT_MESSAGES;
              const pruned = [];
              for (const m of next) {
                if (m.role !== 'system' && toRemove > 0) {
                  toRemove--;
                } else {
                  pruned.push(m);
                }
              }
              return pruned;
            }
            return next;
          });
        }

        if (ENABLE_SEARCH_TRACE_LOGS) {
          logger.info('[KnowledgeOS] Chat query', {
            sessionId,
            queryLength: trimmed.length,
            useSearchContext,
            contextFileCount: contextFileIds.length,
            topK: Math.min(8, defaultTopK)
          });
        }

        // Add placeholder assistant message
        setChatMessages((prev) => [...prev, { role: 'assistant', text: '', isStreaming: true }]);

        const stream = queryStream({
          requestId,
          sessionId,
          query: trimmed,
          topK: Math.min(5, defaultTopK),
          mode: 'hybrid',
          contextFileIds,
          strictScope,
          responseMode,
          documentScopeItems: documentScope,
          // Regenerate re-sends the same query; the user row is already
          // persisted, so tell the main process not to insert it again.
          skipSaveUserTurn: skipAddUserMessage
        });
        chatStreamRef.current = stream;

        // Activity-aware watchdog with a hard cap. Any stream activity (status/chunk)
        // re-arms the timer, but total stream runtime is still capped.
        const CHAT_STREAM_TIMEOUT_MS = 3 * 60 * 1000;
        const streamStartedAtMs = Date.now();
        const handleChatStreamTimeout = () => {
          if (!isMountedRef.current) return;
          if (!isCurrentRequest(chatRequestCounterRef, requestId)) return;
          cancelAnimationFrame(streamingRafRef.current);
          streamingRafRef.current = null;
          clearInterval(streamingFlushIntervalRef.current);
          streamingFlushIntervalRef.current = null;
          pendingStreamChunkRef.current = '';
          logger.warn('[KnowledgeOS] Chat stream timed out — no activity from main process');
          setChatError('The response timed out. Please try again.');
          setChatStatus('');
          setChatWarning('');
          setChatMessages((prev) => {
            const msgs = [...prev];
            const last = msgs[msgs.length - 1];
            if (last && last.role === 'assistant' && last.isStreaming) msgs.pop();
            return msgs;
          });
          setIsChatting(false);
          chatInFlightRef.current = false;
          chatStreamRef.current?.cancel?.();
          chatStreamRef.current = null;
        };
        const armChatWatchdog = () => {
          clearTimeout(chatWatchdogRef.current);
          const elapsedMs = Date.now() - streamStartedAtMs;
          const remainingMs = CHAT_STREAM_TIMEOUT_MS - elapsedMs;
          if (remainingMs <= 0) {
            handleChatStreamTimeout();
            return;
          }
          chatWatchdogRef.current = setTimeout(handleChatStreamTimeout, remainingMs);
        };
        armChatWatchdog();

        stream.on('data', (data) => {
          if (!isCurrentRequest(chatRequestCounterRef, requestId)) return;
          armChatWatchdog();

          if (data.type === 'status') {
            setChatStatus(data.text);
          } else if (data.type === 'chunk') {
            // Accumulate tokens in a ref; an interval flushes to state every 100ms.
            // This drops state updates from ~60/sec to ~10/sec while feeling more responsive.
            pendingStreamChunkRef.current += data.text;
            if (streamingFlushIntervalRef.current === null) {
              const flushChunks = () => {
                const chunk = pendingStreamChunkRef.current;
                if (!chunk) return;
                pendingStreamChunkRef.current = '';
                setChatMessages((prev) => {
                  const newMessages = [...prev];
                  const lastMsg = newMessages[newMessages.length - 1];
                  if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isStreaming) {
                    newMessages[newMessages.length - 1] = {
                      ...lastMsg,
                      text: (lastMsg.text || '') + chunk
                    };
                  }
                  return newMessages;
                });
              };
              streamingFlushIntervalRef.current = setInterval(flushChunks, 100);
            }
          } else if (data.type === 'error') {
            clearTimeout(chatWatchdogRef.current);
            cancelAnimationFrame(streamingRafRef.current);
            streamingRafRef.current = null;
            clearInterval(streamingFlushIntervalRef.current);
            streamingFlushIntervalRef.current = null;
            pendingStreamChunkRef.current = '';
            logger.warn('[KnowledgeOS] Chat error via stream', { error: data.error });
            const { message } = mapErrorToNotification({ error: data.error || 'Chat failed' });
            setChatError(message);
            setChatWarning('');
            setChatStatus('');
            setChatMessages((prev) => {
              const newMessages = [...prev];
              const lastMsg = newMessages[newMessages.length - 1];
              if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isStreaming) {
                newMessages.pop();
              }
              return newMessages;
            });
            setIsChatting(false);
            chatInFlightRef.current = false;
          } else if (data.type === 'done') {
            clearTimeout(chatWatchdogRef.current);
            cancelAnimationFrame(streamingRafRef.current);
            streamingRafRef.current = null;
            clearInterval(streamingFlushIntervalRef.current);
            streamingFlushIntervalRef.current = null;
            // Final flush: push any remaining accumulated tokens before finalizing
            if (pendingStreamChunkRef.current) {
              const finalChunk = pendingStreamChunkRef.current;
              pendingStreamChunkRef.current = '';
              setChatMessages((prev) => {
                const newMessages = [...prev];
                const lastMsg = newMessages[newMessages.length - 1];
                if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isStreaming) {
                  newMessages[newMessages.length - 1] = {
                    ...lastMsg,
                    text: (lastMsg.text || '') + finalChunk
                  };
                }
                return newMessages;
              });
            }
            pendingStreamChunkRef.current = '';
            const response = data.response;
            setChatMessages((prev) => {
              const newMessages = [...prev];
              const lastMsg = newMessages[newMessages.length - 1];
              if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isStreaming) {
                // Clone message to avoid in-place mutation
                newMessages[newMessages.length - 1] = {
                  ...lastMsg,
                  text: '', // Clear text, use structured fields
                  documentAnswer: response.documentAnswer || [],
                  modelAnswer: response.modelAnswer || [],
                  followUps: response.followUps || [],
                  sources: data.sources || [],
                  meta: {
                    contradictions: data.meta?.contradictions || [],
                    comparisonIntent: Boolean(data.meta?.comparisonIntent),
                    gapAnalysisIntent: Boolean(data.meta?.gapAnalysisIntent),
                    holisticIntent: Boolean(data.meta?.holisticIntent)
                  },
                  isStreaming: false
                };
              }
              return newMessages;
            });

            const nextWarning =
              data.meta?.warning ||
              (data.meta?.retrievalAvailable === false
                ? 'Document retrieval unavailable. Responses use model knowledge only.'
                : '');
            setChatWarning(nextWarning);
            setChatStatus('');

            // First send in a fresh session: the conversation row now exists
            // in ChatHistoryStore. Adopt it as the active conversation so the
            // sidebar highlights it and reloads its list (it refetches when
            // currentConversationId changes).
            setCurrentConversationId((/** @type {any} */ prev) =>
              prev === sessionId ? prev : sessionId
            );

            setIsChatting(false);
            chatInFlightRef.current = false;
            chatStreamRef.current = null;
          }
        });

        stream.on('end', () => {
          clearTimeout(chatWatchdogRef.current);
          cancelAnimationFrame(streamingRafRef.current);
          streamingRafRef.current = null;
          clearInterval(streamingFlushIntervalRef.current);
          streamingFlushIntervalRef.current = null;
          pendingStreamChunkRef.current = '';
          if (chatInFlightRef.current) {
            setIsChatting(false);
            chatInFlightRef.current = false;
          }
          chatStreamRef.current = null;
        });

        stream.on('error', (err) => {
          clearTimeout(chatWatchdogRef.current);
          cancelAnimationFrame(streamingRafRef.current);
          streamingRafRef.current = null;
          clearInterval(streamingFlushIntervalRef.current);
          streamingFlushIntervalRef.current = null;
          pendingStreamChunkRef.current = '';
          if (!isCurrentRequest(chatRequestCounterRef, requestId)) return;

          logger.warn('[KnowledgeOS] Chat query failed', { error: err?.message || err });
          const { message } = mapErrorToNotification({ error: err?.message || err });
          setChatError(message);
          setChatWarning('');
          setChatStatus('');

          // Remove the streaming message
          setChatMessages((prev) => {
            const newMessages = [...prev];
            const lastMsg = newMessages[newMessages.length - 1];
            if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isStreaming) {
              newMessages.pop();
            }
            return newMessages;
          });

          setIsChatting(false);
          chatInFlightRef.current = false;
          chatStreamRef.current = null;
        });

        stream.begin();
      } catch (chatErr) {
        clearTimeout(chatWatchdogRef.current);
        cancelAnimationFrame(streamingRafRef.current);
        streamingRafRef.current = null;
        clearInterval(streamingFlushIntervalRef.current);
        streamingFlushIntervalRef.current = null;
        pendingStreamChunkRef.current = '';
        if (!isCurrentRequest(chatRequestCounterRef, requestId)) return;
        logger.warn('[KnowledgeOS] Chat query failed', { error: chatErr?.message || chatErr });
        const { message } = mapErrorToNotification({ error: chatErr?.message || chatErr });
        setChatError(message);
        setChatWarning('');
        setChatStatus('');
        setIsChatting(false);
        chatInFlightRef.current = false;
        chatStreamRef.current?.cancel?.();
        chatStreamRef.current = null;
      }
    },
    [
      defaultTopK,
      documentScope,
      ensureChatSession,
      responseMode,
      searchResults,
      strictScope,
      useSearchContext
    ]
  );

  const handleResponseModeChange = useCallback(
    (/** @type {any} */ nextMode) => {
      if (nextMode !== 'fast' && nextMode !== 'deep') return;
      setResponseMode(nextMode);
      window.electronAPI?.settings
        ?.save?.({ chatResponseMode: nextMode })
        .catch((/** @type {any} */ err) => {
          logger.debug('[UnifiedSearchModal] Failed to save chat response mode', {
            error: err?.message || String(err)
          });
          setError('Failed to save chat response mode. Please try again.');
        });
    },
    [setError]
  );

  const handleChatPersonaChange = useCallback(
    (/** @type {any} */ nextPersona) => {
      if (!getChatPersonaById(nextPersona, savedCustomPersonas)) return;
      setChatPersona(nextPersona);
      window.electronAPI?.settings
        ?.save?.({ chatPersona: nextPersona })
        .catch((/** @type {any} */ err) => {
          logger.debug('[UnifiedSearchModal] Failed to save chat persona', {
            error: err?.message || String(err)
          });
          setError('Failed to save chat persona. Please try again.');
        });
    },
    [savedCustomPersonas, setError]
  );

  const handleAddToScope = useCallback(async (/** @type {any} */ items) => {
    const allPaths = [];
    const unresolvedNames = [];
    for (const item of items) {
      const itemPath = typeof item?.path === 'string' ? item.path.trim() : '';
      const isFolder = item?.type === 'folder';
      if (isFolder) {
        try {
          const result = await window.electronAPI.files.getDirectoryContents(itemPath);
          if (result.success && result.files) {
            allPaths.push(...result.files.map((/** @type {any} */ f) => f.path));
          }
        } catch (err) {
          logger.warn('[UnifiedSearchModal] Failed to scan folder for scope', {
            path: item?.path,
            error: err?.message || String(err)
          });
        }
      } else {
        if (!itemPath) continue;
        if (/[\\/]/.test(itemPath)) {
          allPaths.push(itemPath);
        } else {
          unresolvedNames.push(itemPath);
        }
      }
    }

    try {
      const result = await window.electronAPI.embeddings.findFilesByPaths(allPaths);
      const directMatches = result?.success && result.results ? result.results : [];
      const nameMatches = [];

      for (const unresolvedName of unresolvedNames) {
        try {
          const searchResp = await window.electronAPI.embeddings.search(unresolvedName, {
            topK: 30,
            mode: 'hybrid'
          });
          if (!searchResp?.success || !Array.isArray(searchResp.results)) continue;
          const lowerName = unresolvedName.toLowerCase();
          const exactNameMatches = searchResp.results.filter((/** @type {any} */ candidate) => {
            const candidateName = candidate?.metadata?.name || candidate?.metadata?.fileName || '';
            return typeof candidateName === 'string' && candidateName.toLowerCase() === lowerName;
          });
          nameMatches.push(...exactNameMatches);
        } catch (nameMatchErr) {
          logger.debug('[UnifiedSearchModal] Failed unresolved name lookup', {
            name: unresolvedName,
            error: nameMatchErr?.message || String(nameMatchErr)
          });
        }
      }

      const combined = [...directMatches, ...nameMatches];
      if (combined.length > 0) {
        const newItems = combined
          .map((r) => ({
            id: r.id,
            path: r.path || getMetadataPath(r, r?.id) || '',
            name: r.name || getMetadataName(r, r.path || getMetadataPath(r, r?.id), r?.id) || '',
            type: r.type || r?.metadata?.type || 'file'
          }))
          .filter((item) => item.id && item.path);
        const dedupedNewItems = Array.from(
          new Map(newItems.map((item) => [item.id, item])).values()
        );

        const resolvedPaths = new Set(dedupedNewItems.map((i) => i.path));
        const droppedPaths = allPaths.filter((p) => !resolvedPaths.has(p));
        const unresolvedFoundByName = new Set(
          dedupedNewItems.map((item) => item.name?.toLowerCase()).filter(Boolean)
        );
        const droppedNames = unresolvedNames.filter(
          (name) => !unresolvedFoundByName.has(name.toLowerCase())
        );
        const droppedEntries = [...droppedPaths, ...droppedNames];
        if (droppedEntries.length > 0) {
          const visibleNames = droppedEntries.map((p) => p.split(/[/\\]/).pop()).slice(0, 5);
          const suffix = droppedEntries.length > 5 ? ` and ${droppedEntries.length - 5} more` : '';
          setChatWarning(
            `${droppedEntries.length} file(s) not in index: ${visibleNames.join(', ')}${suffix}. Index these files first.`
          );
        }

        setDocumentScope((prev) => {
          const existingIds = new Set(prev.map((i) => i.id));
          const uniqueNew = dedupedNewItems.filter((i) => !existingIds.has(i.id));
          return [...prev, ...uniqueNew];
        });
      }
    } catch (e) {
      logger.error('Failed to resolve scope files', e);
    }
  }, []);

  const handleRemoveFromScope = useCallback((/** @type {any} */ id) => {
    setDocumentScope((/** @type {any[]} */ prev) => prev.filter((item) => item.id !== id));
  }, []);

  const handleClearScope = useCallback(() => {
    setDocumentScope([]);
  }, []);

  const handleNewConversation = useCallback(() => {
    const previousSessionId = chatSessionRef.current;
    clearTimeout(chatWatchdogRef.current);
    cancelAnimationFrame(streamingRafRef.current);
    streamingRafRef.current = null;
    clearInterval(streamingFlushIntervalRef.current);
    streamingFlushIntervalRef.current = null;
    pendingStreamChunkRef.current = '';
    chatStreamRef.current?.cancel?.();
    chatStreamRef.current = null;
    invalidateRequests(chatRequestCounterRef);
    chatInFlightRef.current = false;
    setCurrentConversationId(null);
    setChatMessages([]);
    setDocumentScope([]);
    setChatError('');
    setChatWarning('');
    setChatStatus('');
    setIsChatting(false);
    if (previousSessionId) {
      window.electronAPI?.chat
        ?.resetSession?.(previousSessionId)
        .catch((/** @type {any} */ err) => {
          logger.debug('[UnifiedSearchModal] Failed to reset chat session', {
            sessionId: previousSessionId,
            error: err?.message || String(err)
          });
        });
    }
    chatSessionRef.current = crypto.randomUUID();
  }, []);

  const handleSelectConversation = useCallback(async (/** @type {any} */ id) => {
    try {
      const conversation = await getConversation(id);
      if (conversation) {
        clearTimeout(chatWatchdogRef.current);
        cancelAnimationFrame(streamingRafRef.current);
        streamingRafRef.current = null;
        clearInterval(streamingFlushIntervalRef.current);
        streamingFlushIntervalRef.current = null;
        pendingStreamChunkRef.current = '';
        chatStreamRef.current?.cancel?.();
        chatStreamRef.current = null;
        invalidateRequests(chatRequestCounterRef);
        chatInFlightRef.current = false;
        setCurrentConversationId(id);
        setChatMessages(conversation.messages || []);
        setChatError('');
        setChatWarning('');
        setChatStatus('');
        setIsChatting(false);
        chatSessionRef.current = id;
        setDocumentScope(conversation.documentScope || []);
      }
    } catch (err) {
      logger.error('[UnifiedSearchModal] Failed to load conversation', err);
      setChatError('Failed to load conversation');
    }
  }, []);

  const handleStopGenerating = useCallback(() => {
    clearTimeout(chatWatchdogRef.current);
    cancelAnimationFrame(streamingRafRef.current);
    streamingRafRef.current = null;
    clearInterval(streamingFlushIntervalRef.current);
    streamingFlushIntervalRef.current = null;
    pendingStreamChunkRef.current = '';
    chatStreamRef.current?.cancel?.(); // cancel() already calls cleanup()
    chatStreamRef.current = null;
    invalidateRequests(chatRequestCounterRef);
    chatInFlightRef.current = false;
    setChatStatus('');
    setIsChatting(false);
    setChatWarning('Generation stopped.');
    setChatMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last && last.role === 'assistant' && last.isStreaming) {
        next.pop();
      }
      return next;
    });
  }, []);

  const handleChatReset = useCallback(async () => {
    handleNewConversation();
  }, [handleNewConversation]);

  const handleRegenerate = useCallback(
    async (/** @type {any} */ text) => {
      const lastUserMsg = [...chatMessages].reverse().find((m) => m.role === 'user');
      const queryText = typeof text === 'string' && text.trim() ? text : lastUserMsg?.text;
      if (!queryText) return;

      setChatMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant') {
          next.pop();
        }
        return next;
      });

      await handleChatSend(queryText, null, { skipAddUserMessage: true });
    },
    [chatMessages, handleChatSend]
  );

  const handleChatOpenSource = useCallback(
    (/** @type {any} */ source) => {
      if (source?.path) {
        openFile(source.path);
      }
    },
    [openFile]
  );

  // Reset to a clean slate for a fresh open (called from the modal's
  // open-reset effect so the reset ordering stays exactly as before).
  const resetChatState = useCallback(() => {
    setChatMessages([]);
    setChatError('');
    setIsChatting(false);
    setUseSearchContext(false);
    chatSessionRef.current = crypto.randomUUID();
  }, []);

  return {
    chatMessages,
    setChatMessages,
    currentConversationId,
    setCurrentConversationId,
    strictScope,
    setStrictScope,
    documentScope,
    setDocumentScope,
    isConvSidebarOpen,
    setIsConvSidebarOpen,
    isDocScopeOpen,
    setIsDocScopeOpen,
    isChatting,
    chatError,
    setChatError,
    chatWarning,
    useSearchContext,
    setUseSearchContext,
    // How many of the last search's files a context-scoped answer draws on
    // (the send path caps the ids at 200).
    searchContextCount: Math.min((searchResults || []).length, 200),
    responseMode,
    setResponseMode,
    chatPersona,
    setChatPersona,
    chatStatus,
    savedCustomPersonas,
    chatPersonaOptions,
    chatSessionRef,
    ensureChatSession,
    handleChatSend,
    handleResponseModeChange,
    handleChatPersonaChange,
    handleAddToScope,
    handleRemoveFromScope,
    handleClearScope,
    handleNewConversation,
    handleSelectConversation,
    handleStopGenerating,
    handleChatReset,
    handleRegenerate,
    handleChatOpenSource,
    resetChatState,
    cancelChatStream
  };
}
