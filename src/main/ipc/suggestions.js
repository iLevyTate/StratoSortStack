// @ts-check
/**
 * Organization Suggestions IPC Handlers
 *
 * Handles AI-powered file organization suggestions, feedback recording,
 * and organization strategies.
 */
const { IpcServiceContext, createFromLegacyParams } = require('./IpcServiceContext');
const { createHandler, createErrorResponse, safeHandle } = require('./ipcWrappers');
const { schemas } = require('./validationSchemas');
const OrganizationSuggestionService = require('../services/organization');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('IPC:Suggestions');
/**
 * @param {IpcServiceContext|Record<string, any>} servicesOrParams - Service context or legacy parameters
 */
function registerSuggestionsIpc(servicesOrParams) {
  let container;
  if (servicesOrParams instanceof IpcServiceContext) {
    container = servicesOrParams;
  } else {
    container = createFromLegacyParams(servicesOrParams);
  }

  const { ipcMain, IPC_CHANNELS } = container.core;
  const { settingsService } = container.settings;
  const { getCustomFolders } = container.folders;
  const { getServiceIntegration } = container;

  // Retrieve services from integration if available
  /** @type {any} */
  let vectorDbService = null;
  /** @type {any} */
  let folderMatchingService = null;

  // Legacy support: if servicesOrParams has them directly
  if (!(servicesOrParams instanceof IpcServiceContext)) {
    vectorDbService = servicesOrParams.vectorDbService;
    folderMatchingService = servicesOrParams.folderMatchingService;
  }

  // If not found, try getting from serviceIntegration
  if ((!vectorDbService || !folderMatchingService) && getServiceIntegration) {
    const integration = getServiceIntegration();
    if (integration) {
      // Back-compat: ServiceIntegration historically exposed `vectorDbService`.
      // After the Orama migration it stores the instance on `vectorService`.
      vectorDbService =
        vectorDbService ||
        integration.vectorDbService ||
        integration.vectorService ||
        integration.vectorDb;
      folderMatchingService = folderMatchingService || integration.folderMatchingService;
    }
  }

  const context = 'Suggestions';

  /**
   * The suggestion service these handlers use.
   *
   * Prefer the container singleton that ServiceIntegration exposes: it is the
   * instance LearningFeedbackService, auto-organize and undo all write to.
   * This module used to build its own second instance. Both loaded
   * user-patterns.json and feedback-memory.json once and saved their whole
   * in-memory state, so each save overwrote the other's learning, and
   * nothing the renderer read here saw corrections recorded by batch
   * organize until a restart.
   *
   * A local instance is built only when there is no ServiceIntegration at
   * all (legacy callers that pass the services directly).
   */
  /** @type {any} */
  let localSuggestionService = null;
  const buildLocalService = () => {
    if (!vectorDbService || !folderMatchingService) return null;
    try {
      const service = new OrganizationSuggestionService(
        /** @type {any} */ ({
          vectorDbService,
          folderMatchingService,
          settingsService
        })
      );
      logger.info('[SUGGESTIONS] Built a local OrganizationSuggestionService (no shared instance)');
      return service;
    } catch (error) {
      logger.debug('[SUGGESTIONS] Local suggestion service not yet possible:', error.message);
      return null;
    }
  };

  const getSuggestionService = () => {
    const integration =
      typeof getServiceIntegration === 'function' ? getServiceIntegration() : null;
    // Inside the app the integration always exists; until it has initialized
    // the handlers return their "unavailable" fallback rather than spinning
    // up a second instance that would outlive the window.
    if (integration) return integration.suggestionService || null;
    if (!localSuggestionService) localSuggestionService = buildLocalService();
    return localSuggestionService;
  };

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SUGGESTIONS.GET_FILE_SUGGESTIONS,
    createHandler({
      logger,
      context,
      schema: schemas?.fileSuggestion,
      serviceName: 'suggestionService',
      getService: getSuggestionService,
      fallbackResponse: {
        success: false,
        error: 'Suggestion service unavailable (vector DB may not be ready)',
        primary: null,
        alternatives: [],
        confidence: 0
      },
      handler: async (event, { file, options = {} }, service) => {
        try {
          logger.info('[SUGGESTIONS] Getting suggestions for file:', file.name);

          const smartFolders = getCustomFolders();
          const suggestions = await service.getSuggestionsForFile(file, smartFolders, options);

          logger.info('[SUGGESTIONS] Generated suggestions:', {
            file: file.name,
            primary: suggestions.primary?.folder,
            alternatives: suggestions.alternatives?.length || 0,
            confidence: suggestions.confidence
          });

          return suggestions;
        } catch (error) {
          logger.error('[SUGGESTIONS] Failed to get file suggestions:', error);
          return createErrorResponse(error);
        }
      }
    })
  );

  // Get batch suggestions for multiple files
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SUGGESTIONS.GET_BATCH_SUGGESTIONS,
    createHandler({
      logger,
      context,
      schema: schemas?.batchSuggestion,
      serviceName: 'suggestionService',
      getService: getSuggestionService,
      fallbackResponse: {
        success: false,
        error: 'Suggestion service unavailable (vector DB may not be ready)',
        groups: [],
        recommendations: []
      },
      handler: async (event, { files, options = {} }, service) => {
        try {
          logger.info('[SUGGESTIONS] Getting batch suggestions for', files.length, 'files');

          const smartFolders = getCustomFolders();
          const batchSuggestions = await service.getBatchSuggestions(files, smartFolders, {
            ...options,
            signal: event?.abortSignal ?? options?.signal
          });

          logger.info('[SUGGESTIONS] Generated batch suggestions:', {
            fileCount: files.length,
            groups: batchSuggestions.groups?.length || 0,
            recommendations: batchSuggestions.recommendations?.length || 0
          });

          return batchSuggestions;
        } catch (error) {
          logger.error('[SUGGESTIONS] Failed to get batch suggestions:', error);
          return createErrorResponse(error, {
            groups: []
          });
        }
      }
    })
  );

  // Record user feedback on suggestions
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SUGGESTIONS.RECORD_FEEDBACK,
    createHandler({
      logger,
      context,
      schema: schemas?.feedback,
      serviceName: 'suggestionService',
      getService: getSuggestionService,
      fallbackResponse: {
        success: false,
        error: 'Suggestion service unavailable'
      },
      handler: async (event, { file, suggestion, accepted, note }, service) => {
        try {
          logger.info('[SUGGESTIONS] Recording feedback:', {
            file: file.name,
            suggestion: suggestion?.folder,
            accepted
          });

          await service.recordFeedback(file, suggestion, accepted, note);
          if (note) {
            await service.recordFeedbackNote(file, suggestion, accepted, note);
          }

          return { success: true };
        } catch (error) {
          logger.error('[SUGGESTIONS] Failed to record feedback:', error);
          return createErrorResponse(error);
        }
      }
    })
  );

  // Add feedback memory
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SUGGESTIONS.ADD_FEEDBACK_MEMORY,
    createHandler({
      logger,
      context,
      schema: schemas?.feedbackMemoryAdd,
      serviceName: 'suggestionService',
      getService: getSuggestionService,
      fallbackResponse: {
        success: false,
        error: 'Suggestion service unavailable'
      },
      handler: async (event, { text, metadata }, service) => {
        try {
          const item = await service.addFeedbackMemory(text, metadata);
          return { success: true, item };
        } catch (error) {
          logger.error('[SUGGESTIONS] Failed to add feedback memory:', error);
          return createErrorResponse(error);
        }
      }
    })
  );

  // Get feedback memory list
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SUGGESTIONS.GET_FEEDBACK_MEMORY,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      serviceName: 'suggestionService',
      getService: getSuggestionService,
      fallbackResponse: {
        success: false,
        error: 'Suggestion service unavailable',
        items: []
      },
      handler: async (event, service) => {
        try {
          const items = await service.listFeedbackMemory();
          return { success: true, items };
        } catch (error) {
          logger.error('[SUGGESTIONS] Failed to get feedback memory:', error);
          return createErrorResponse(error, { items: [] });
        }
      }
    })
  );

  // Delete feedback memory
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SUGGESTIONS.DELETE_FEEDBACK_MEMORY,
    createHandler({
      logger,
      context,
      schema: schemas?.feedbackMemoryDelete,
      serviceName: 'suggestionService',
      getService: getSuggestionService,
      fallbackResponse: {
        success: false,
        error: 'Suggestion service unavailable'
      },
      handler: async (event, { id }, service) => {
        try {
          const removed = await service.deleteFeedbackMemory(id);
          return { success: true, removed };
        } catch (error) {
          logger.error('[SUGGESTIONS] Failed to delete feedback memory:', error);
          return createErrorResponse(error);
        }
      }
    })
  );

  // Update feedback memory
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SUGGESTIONS.UPDATE_FEEDBACK_MEMORY,
    createHandler({
      logger,
      context,
      schema: schemas?.feedbackMemoryUpdate,
      serviceName: 'suggestionService',
      getService: getSuggestionService,
      fallbackResponse: {
        success: false,
        error: 'Suggestion service unavailable'
      },
      handler: async (event, { id, text, metadata }, service) => {
        try {
          const item = await service.updateFeedbackMemory(id, text, metadata);
          return { success: true, item };
        } catch (error) {
          logger.error('[SUGGESTIONS] Failed to update feedback memory:', error);
          return createErrorResponse(error);
        }
      }
    })
  );

  // Get organization strategies
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SUGGESTIONS.GET_STRATEGIES,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      serviceName: 'suggestionService',
      getService: getSuggestionService,
      fallbackResponse: {
        success: false,
        error: 'Suggestion service is not available',
        strategies: []
      },
      handler: async (event, service) => {
        try {
          logger.info('[SUGGESTIONS] Getting organization strategies');

          return {
            success: true,
            strategies: Object.entries(service.strategies).map(([id, strategy]) => ({
              id,
              ...strategy
            }))
          };
        } catch (error) {
          logger.error('[SUGGESTIONS] Failed to get strategies:', error);
          return createErrorResponse(error, {
            strategies: []
          });
        }
      }
    })
  );

  // Apply a specific strategy to files
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SUGGESTIONS.APPLY_STRATEGY,
    createHandler({
      logger,
      context,
      schema: schemas?.strategyApplication,
      serviceName: 'suggestionService',
      getService: getSuggestionService,
      fallbackResponse: {
        success: false,
        error: 'Suggestion service is not available',
        results: []
      },
      handler: async (event, { files, strategyId }, service) => {
        try {
          logger.info('[SUGGESTIONS] Applying strategy:', {
            strategy: strategyId,
            fileCount: files.length
          });

          const strategy = service.strategies[strategyId];
          if (!strategy) {
            throw new Error(`Unknown strategy: ${strategyId}`);
          }

          const smartFolders = getCustomFolders();
          const results = [];

          for (const file of files) {
            const folder = service.mapFileToStrategy(file, strategy, smartFolders);
            results.push({
              file,
              folder,
              strategy: strategyId
            });
          }

          return {
            success: true,
            results
          };
        } catch (error) {
          logger.error('[SUGGESTIONS] Failed to apply strategy:', error);
          return createErrorResponse(error);
        }
      }
    })
  );

  // Get user patterns (for debugging/UI display)
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SUGGESTIONS.GET_USER_PATTERNS,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      serviceName: 'suggestionService',
      getService: getSuggestionService,
      fallbackResponse: {
        success: false,
        error: 'Suggestion service not available',
        patterns: []
      },
      handler: async (event, service) => {
        try {
          logger.info('[SUGGESTIONS] Getting user patterns');

          const patterns = Array.from(service.userPatterns.entries()).map(([pattern, data]) => ({
            pattern,
            ...data
          }));

          return {
            success: true,
            patterns
          };
        } catch (error) {
          logger.error('[SUGGESTIONS] Failed to get user patterns:', error);
          return createErrorResponse(error, {
            patterns: []
          });
        }
      }
    })
  );

  // Clear user patterns (for testing/reset)
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SUGGESTIONS.CLEAR_PATTERNS,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      serviceName: 'suggestionService',
      getService: getSuggestionService,
      fallbackResponse: {
        success: false,
        error: 'Suggestion service not available'
      },
      handler: async (event, service) => {
        try {
          logger.info('[SUGGESTIONS] Clearing user patterns');

          service.userPatterns.clear();
          service.feedbackHistory = [];

          return { success: true };
        } catch (error) {
          logger.error('[SUGGESTIONS] Failed to clear patterns:', error);
          return createErrorResponse(error);
        }
      }
    })
  );

  // Analyze folder structure for improvements
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SUGGESTIONS.ANALYZE_FOLDER_STRUCTURE,
    createHandler({
      logger,
      context,
      schema: schemas.analyzeFolderStructure,
      serviceName: 'suggestionService',
      getService: getSuggestionService,
      fallbackResponse: {
        success: false,
        error: 'Suggestion service not available',
        improvements: []
      },
      handler: async (event, { files = [] }, service) => {
        try {
          logger.info('[SUGGESTIONS] Analyzing folder structure');

          const smartFolders = getCustomFolders();
          const improvements = await service.analyzeFolderStructure(smartFolders, files);

          logger.info('[SUGGESTIONS] Folder analysis complete:', {
            improvementCount: improvements.length,
            smartFolderCount: smartFolders.length
          });

          return {
            success: true,
            improvements,
            smartFolders
          };
        } catch (error) {
          logger.error('[SUGGESTIONS] Failed to analyze folder structure:', error);
          return createErrorResponse(error, {
            improvements: []
          });
        }
      }
    })
  );

  // Suggest new smart folder
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SUGGESTIONS.SUGGEST_NEW_FOLDER,
    createHandler({
      logger,
      context,
      schema: schemas.suggestNewFolder,
      serviceName: 'suggestionService',
      getService: getSuggestionService,
      fallbackResponse: {
        success: false,
        error: 'Suggestion service not available'
      },
      handler: async (event, { file }, service) => {
        try {
          logger.info('[SUGGESTIONS] Suggesting new folder for:', file.name);

          const smartFolders = getCustomFolders();
          const suggestion = await service.suggestNewSmartFolder(file, smartFolders);

          return {
            success: true,
            suggestion
          };
        } catch (error) {
          logger.error('[SUGGESTIONS] Failed to suggest new folder:', error);
          return createErrorResponse(error);
        }
      }
    })
  );

  logger.info('[IPC] Suggestions handlers registered');

  return getSuggestionService();
}

module.exports = { registerSuggestionsIpc };
