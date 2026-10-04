// @ts-check
const { registerHandlers, safeSend } = require('./ipcWrappers');
const { IpcServiceContext, createFromLegacyParams } = require('./IpcServiceContext');
const { schemas } = require('./validationSchemas');
const ChatService = require('../services/ChatService');
const { container, ServiceIds } = require('../services/ServiceContainer');
const { logger: moduleLogger } = require('../../shared/logger');

// Module-scope reference to the currently cached ChatService, set by the
// register function below. ChatService lives outside the DI container (its
// lifetime follows LlamaService swaps, not the container's), so app shutdown
// must reach into this closure to dispose it before Electron quits — otherwise
// the background stream-controller sweep interval keeps ticking.
/** @type {any} */
let _activeChatService = null;
/** @type {(() => any) | null} */
let _chatServiceFactory = null;

/**
 * @param {IpcServiceContext|Record<string, any>} servicesOrParams - Service context or legacy parameters
 */
function registerChatIpc(servicesOrParams) {
  let context;
  if (servicesOrParams instanceof IpcServiceContext) {
    context = servicesOrParams;
  } else {
    context = createFromLegacyParams(servicesOrParams);
  }

  const { ipcMain, IPC_CHANNELS, logger } = context.core;
  const { getServiceIntegration } = context;

  /** @type {any} */
  let chatService = null;
  const getChatService = () => {
    const integration = getServiceIntegration && getServiceIntegration();
    const diContainer = integration?.container || container;

    if (!diContainer || typeof diContainer.resolve !== 'function') {
      logger.warn('[Chat] DI container unavailable');
      return null;
    }

    /** @param {string} serviceId */
    const safeResolve = (serviceId) => {
      try {
        return diContainer.resolve(serviceId);
      } catch (error) {
        logger.warn('[Chat] Failed to resolve service', {
          serviceId,
          error: error?.message || String(error)
        });
        return null;
      }
    };

    const searchService = safeResolve(ServiceIds.SEARCH_SERVICE);
    const vectorDbService = safeResolve(ServiceIds.ORAMA_VECTOR);
    const embeddingService = safeResolve(ServiceIds.PARALLEL_EMBEDDING);
    const llamaService = safeResolve(ServiceIds.LLAMA_SERVICE);

    // Drop cached ChatService when LlamaService instance changes (model reload / container refresh).
    // `ChatService` owns a long-lived `setInterval` (stream-controller sweep); without disposing
    // we leak a timer and a retainer on the old Llama instance on every swap.
    if (chatService && chatService.llamaService !== llamaService) {
      try {
        chatService.dispose?.();
      } catch (disposeError) {
        logger.warn?.('[Chat] ChatService dispose failed', {
          error: disposeError?.message || String(disposeError)
        });
      }
      chatService = null;
      _activeChatService = null;
    }

    if (chatService) return chatService;
    const settingsService = safeResolve(ServiceIds.SETTINGS);
    const chatHistoryStore = safeResolve(ServiceIds.CHAT_HISTORY_STORE);

    // If cached with null llamaService, all chat queries fail for the entire session.
    if (!llamaService) {
      const isRegistered = diContainer?.has?.(ServiceIds.LLAMA_SERVICE);
      logger.warn('[Chat] Llama service not available', {
        registered: isRegistered,
        containerAvailable: !!diContainer
      });
      return null;
    }

    try {
      chatService = new ChatService({
        searchService,
        vectorDbService,
        embeddingService,
        llamaService,
        settingsService,
        chatHistoryStore
      });
      _activeChatService = chatService;
    } catch (error) {
      logger.error('[Chat] Failed to initialize ChatService', {
        error: error?.message || String(error)
      });
      chatService = null;
      _activeChatService = null;
    }

    return chatService;
  };
  _chatServiceFactory = getChatService;
  const getChatServiceSafe = () => {
    try {
      return getChatService();
    } catch (error) {
      logger.error('[Chat] Failed to access ChatService', {
        error: error?.message || String(error)
      });
      return null;
    }
  };

  registerHandlers({
    ipcMain,
    logger,
    context: 'Chat',
    handlers: {
      [IPC_CHANNELS.CHAT.QUERY_STREAM]: {
        schema: schemas.chatQuery,
        serviceName: 'chat',
        getService: getChatServiceSafe,
        fallbackResponse: { success: false, error: 'Chat service unavailable' },
        handler: async (event, payload, service) => {
          const sender = event.sender;
          const streamMeta = {
            requestId: payload?.requestId,
            sessionId: payload?.sessionId
          };

          // Return immediately — streaming data flows through STREAM_CHUNK/STREAM_END
          // events, not through the invoke return value.  Awaiting the full streaming
          // operation here would block the invoke promise for 30-60s+, racing against
          // the preload's IPC timeout and causing spurious timeout errors.
          //
          // Cancellation model:
          //   * CANCEL_STREAM (IPC_CHANNELS.CHAT.CANCEL_STREAM) is the canonical
          //     mid-stream cancel path. It reaches ChatService.cancelStreamingRequest
          //     which aborts the per-requestId streamController.
          //   * event.abortSignal here only covers the *setup phase* of the
          //     stream (before the handler returns {success:true}). It is
          //     threaded through as externalSignal so queryStreaming can
          //     cancel early if the preload timeout fires before the first
          //     chunk is emitted. Once the handler returns, ipcRegistry's
          //     finally tears the entry down and ABORT_INVOKE on the same
          //     requestId no longer reaches this signal — that's by design.
          service
            .queryStreaming({
              ...payload,
              externalSignal: event?.abortSignal,
              onEvent: (/** @type {Record<string, any>} */ data) => {
                if (!sender.isDestroyed()) {
                  safeSend(sender, IPC_CHANNELS.CHAT.STREAM_CHUNK, {
                    ...data,
                    ...streamMeta
                  });
                }
              }
            })
            .then(
              /** @type {() => void} */ (
                () => {
                  if (!sender.isDestroyed()) {
                    safeSend(sender, IPC_CHANNELS.CHAT.STREAM_END, streamMeta);
                  }
                  return undefined;
                }
              )
            )
            .catch((/** @type {any} */ err) => {
              logger.error('[Chat] Streaming background error', {
                error: err?.message || String(err)
              });
              if (!sender.isDestroyed()) {
                safeSend(sender, IPC_CHANNELS.CHAT.STREAM_CHUNK, {
                  type: 'error',
                  error: err?.message || 'Streaming failed',
                  ...streamMeta
                });
                safeSend(sender, IPC_CHANNELS.CHAT.STREAM_END, streamMeta);
              }
            });

          return { success: true };
        }
      },
      [IPC_CHANNELS.CHAT.CANCEL_STREAM]: {
        schema: schemas.chatCancel,
        serviceName: 'chat',
        getService: getChatServiceSafe,
        fallbackResponse: { success: false, error: 'Chat service unavailable' },
        handler: async (event, payload = {}, service) => {
          const result = await service.cancelStreamingRequest(payload);
          return { success: true, ...result };
        }
      },
      [IPC_CHANNELS.CHAT.RESET_SESSION]: {
        schema: schemas.chatReset,
        serviceName: 'chat',
        getService: getChatServiceSafe,
        fallbackResponse: { success: false, error: 'Chat service unavailable' },
        handler: async (event, { sessionId } = {}, service) => {
          await service.resetSession(sessionId);
          return { success: true };
        }
      },
      [IPC_CHANNELS.CHAT.LIST_CONVERSATIONS]: {
        schema: schemas.chatListConversations,
        serviceName: 'chat',
        getService: getChatServiceSafe,
        fallbackResponse: { success: false, error: 'Chat service unavailable' },
        handler: async (event, { limit, offset } = {}, service) => {
          if (!service.chatHistoryStore) return { success: false, error: 'History not available' };
          return {
            success: true,
            conversations: service.chatHistoryStore.listConversations(limit, offset)
          };
        }
      },
      [IPC_CHANNELS.CHAT.GET_CONVERSATION]: {
        schema: schemas.chatConversationId,
        serviceName: 'chat',
        getService: getChatServiceSafe,
        fallbackResponse: { success: false, error: 'Chat service unavailable' },
        handler: async (event, { id } = {}, service) => {
          if (!service.chatHistoryStore) return { success: false, error: 'History not available' };
          const conv = service.chatHistoryStore.getConversation(id);
          return { success: true, conversation: conv };
        }
      },
      [IPC_CHANNELS.CHAT.DELETE_CONVERSATION]: {
        schema: schemas.chatConversationId,
        serviceName: 'chat',
        getService: getChatServiceSafe,
        fallbackResponse: { success: false, error: 'Chat service unavailable' },
        handler: async (event, { id } = {}, service) => {
          if (!service.chatHistoryStore) return { success: false, error: 'History not available' };
          service.chatHistoryStore.deleteConversation(id);
          // Sessions are keyed by conversation id. Purge the in-memory LRU
          // session too — otherwise its eviction hook
          // (_persistEvictedInMemorySession) would silently recreate the
          // conversation we just deleted, and any in-flight stream would keep
          // writing to it.
          await service.resetSession(id);
          return { success: true };
        }
      },
      [IPC_CHANNELS.CHAT.SEARCH_CONVERSATIONS]: {
        schema: schemas.chatSearchConversations,
        serviceName: 'chat',
        getService: getChatServiceSafe,
        fallbackResponse: { success: false, error: 'Chat service unavailable' },
        handler: async (event, { query } = {}, service) => {
          if (!service.chatHistoryStore) return { success: false, error: 'History not available' };
          // searchConversations now returns an envelope with cap-hit metadata
          // so the renderer can show "showing recent N conversations" when the
          // user's history exceeds the decrypt-scan cap. The `results` field
          // remains the array for backward-compat consumers.
          const searchResult = service.chatHistoryStore.searchConversations(query);
          return {
            success: true,
            results: searchResult.items,
            capped: searchResult.capped,
            capLimit: searchResult.capLimit,
            scannedCount: searchResult.scannedCount
          };
        }
      },
      [IPC_CHANNELS.CHAT.EXPORT_CONVERSATION]: {
        schema: schemas.chatConversationId,
        serviceName: 'chat',
        getService: getChatServiceSafe,
        fallbackResponse: { success: false, error: 'Chat service unavailable' },
        handler: async (event, { id } = {}, service) => {
          if (!service.chatHistoryStore) return { success: false, error: 'History not available' };
          if (!service.chatHistoryStore.exportAsMarkdown)
            return { success: false, error: 'Export not supported' };
          const markdown = service.chatHistoryStore.exportAsMarkdown(id);
          if (!markdown) return { success: false, error: 'Conversation not found' };
          return { success: true, markdown };
        }
      }
    }
  });
}

/**
 * Dispose the module-scoped ChatService (used by app shutdown).
 *
 * ChatService is not container-managed — its lifetime is tied to the active
 * LlamaService and the IPC registration closure. Without an explicit hook
 * the stream-controller sweep interval and any in-flight abort controllers
 * survive `before-quit`, so the process lingers on exit.
 *
 * Safe to call multiple times and when no service is active.
 * @returns {void}
 */
function disposeChatService() {
  const instance = _activeChatService;
  if (!instance) return;
  _activeChatService = null;
  try {
    instance.dispose?.();
  } catch (error) {
    moduleLogger.warn?.('[Chat] disposeChatService failed', {
      error: error?.message || String(error)
    });
  }
}

function getActiveChatService() {
  return _activeChatService;
}

/**
 * Create (or return) the ChatService used by in-app chat and MCP.
 * MCP must not wait for the first renderer chat invoke — otherwise
 * `chat_with_documents` fails with a null service until the user opens Chat.
 * @returns {any}
 */
function getOrCreateChatService() {
  if (_activeChatService) return _activeChatService;
  if (typeof _chatServiceFactory === 'function') {
    return _chatServiceFactory();
  }
  return null;
}

module.exports = registerChatIpc;
module.exports.disposeChatService = disposeChatService;
module.exports.getActiveChatService = getActiveChatService;
module.exports.getOrCreateChatService = getOrCreateChatService;
