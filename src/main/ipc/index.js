// @ts-check
const registerFilesIpc = require('./files');
const registerSmartFoldersIpc = require('./smartFolders');
const registerUndoRedoIpc = require('./undoRedo');
const registerAnalysisHistoryIpc = require('./analysisHistory');
const registerSystemIpc = require('./system');
const { registerLlamaIpc } = require('./llama'); // New in-process LLM handler
const { registerWhisperIpc } = require('./whisper'); // In-process whisper model installer
const registerAnalysisIpc = require('./analysis');
const registerSettingsIpc = require('./settings');
const registerEmbeddingsIpc = require('./semantic');
const registerWindowIpc = require('./window');
const { registerSuggestionsIpc } = require('./suggestions');
const { registerOrganizeIpc } = require('./organize');
const { registerVectorDbIpc } = require('./vectordb'); // New in-process vector DB handler
const registerChatIpc = require('./chat');
const registerKnowledgeIpc = require('./knowledge');
const registerDownloadsIpc = require('./downloads');
const registerMcpIpc = require('./mcp');
const registerAiProviderIpc = require('./aiProvider');
const registerLicenseIpc = require('./license');
const { IpcServiceContext, createFromLegacyParams } = require('./IpcServiceContext');

// Export IPC utilities for handler creation
const {
  createHandler,
  registerHandlers,
  withErrorLogging,
  withValidation,
  withServiceCheck,
  createErrorResponse,
  createSuccessResponse,
  ERROR_CODES
} = require('./ipcWrappers');
const { schemas, z } =
  /** @type {{ schemas: Record<string, any>, z: typeof import('zod')|null }} */ (
    require('./validationSchemas')
  );

/**
 * Register all IPC handlers using either an IpcServiceContext or legacy parameters
 *
 * @param {IpcServiceContext|Record<string, any>} servicesOrParams - Either an
 *   IpcServiceContext instance or a legacy parameters object with individual
 *   service properties (ipcMain, IPC_CHANNELS, logger, dialog, shell,
 *   systemAnalytics, getMainWindow, getServiceIntegration, getCustomFolders,
 *   setCustomFolders, saveCustomFolders, analyzeDocumentFile, analyzeImageFile,
 *   scanDirectory, settingsService, onSettingsChanged — see
 *   {@link createFromLegacyParams}).
 */
function registerAllIpc(servicesOrParams) {
  // Support both IpcServiceContext and legacy parameters
  let container;
  if (servicesOrParams instanceof IpcServiceContext) {
    container = servicesOrParams;
  } else {
    container = createFromLegacyParams(servicesOrParams);
  }

  // Validate container
  const validation = container.validate();
  if (!validation.valid) {
    throw new Error(
      `IpcServiceContext missing required services: ${validation.missing.join(', ')}`
    );
  }

  const { logger } = container.core;

  // Register individual IPC handlers
  registerFilesIpc(container);
  registerSmartFoldersIpc(container);
  registerUndoRedoIpc(container);
  registerAnalysisHistoryIpc(container);
  registerSystemIpc(container);
  registerLlamaIpc(container); // New in-process LLM handler
  registerWhisperIpc(container); // In-process whisper model installer
  registerAnalysisIpc(container);
  registerSettingsIpc(container);
  registerEmbeddingsIpc(container);
  registerWindowIpc(container);
  registerVectorDbIpc(container); // New in-process vector DB handler
  registerChatIpc(container);
  registerKnowledgeIpc(container);
  registerDownloadsIpc(container);
  registerMcpIpc(container);
  registerAiProviderIpc(container);
  registerLicenseIpc(container);

  // Register suggestions and organize handlers
  // These handlers manage their own service availability checks
  registerSuggestionsIpc(container);
  registerOrganizeIpc(container);

  logger.info('[IPC] All handlers registered via IpcServiceContext');
}

module.exports = {
  // Main registration function
  registerAllIpc,

  // IPC service context utilities
  IpcServiceContext,
  createFromLegacyParams,

  // IPC handler utilities
  createHandler,
  registerHandlers,
  withErrorLogging,
  withValidation,
  withServiceCheck,
  createErrorResponse,
  createSuccessResponse,
  ERROR_CODES,

  // Validation schemas
  schemas,
  z
};
