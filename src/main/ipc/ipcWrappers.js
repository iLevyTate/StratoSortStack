// @ts-check
/**
 * Centralized IPC Handler Wrappers
 *
 * Provides consistent error handling, validation, service checking,
 * and logging patterns for all IPC handlers.
 *
 * Usage:
 *   const handler = createHandler({
 *     logger,
 *     schema: z.object({ filePath: z.string() }),
 *     serviceName: 'analysisHistory',
 *     getService: () => getServiceIntegration()?.analysisHistory,
 *     handler: async (event, data) => {
 *       // Your handler logic
 *       return { result: 'data' };
 *     }
 *   });
 */

const {
  createSuccessResponse: createStandardSuccessResponse,
  createErrorResponse: importedCreateErrorResponse,
  ERROR_CODES
} = require('../../shared/errorHandlingUtils');

/**
 * Minimal logger surface used by the wrappers. Structurally satisfied by the
 * shared Logger class, scoped createLogger() instances, and test doubles.
 * @typedef {{ debug?: (...args: any[]) => void, info?: (...args: any[]) => void, warn?: (...args: any[]) => void, error?: (...args: any[]) => void }} LoggerLike
 */

/**
 * Minimal validator contract shared by Zod schemas and the fallback
 * validators in validationSchemas.js (duck-typed on `safeParse`).
 * @typedef {{ safeParse: (value: unknown) => { success: boolean, data?: any, error?: any } }} SafeParseSchema
 */

/**
 * Generic IPC handler signature: (event, ...payloadArgs) => result.
 * @typedef {(...args: any[]) => any} IpcHandlerFn
 */

/** @type {typeof importedCreateErrorResponse} */
const createErrorResponse =
  typeof importedCreateErrorResponse === 'function'
    ? importedCreateErrorResponse
    : (error, context = {}) => {
        const errorMessage = error?.message || String(error || 'Unknown error');
        const errorCode = error?.code || error?.errorCode || ERROR_CODES.UNKNOWN_ERROR;
        const details = {
          ...context,
          ...(error?.validationErrors && {
            validationErrors: error.validationErrors
          })
        };
        return {
          success: false,
          error: {
            code: errorCode,
            message: errorMessage,
            details: Object.keys(details).length > 0 ? details : undefined
          }
        };
      };
const { logger } = require('../../shared/logger');
const { validateEventPayload, hasEventSchema } = require('../../shared/ipcEventSchemas');

// Try to load zod for validation
/** @type {typeof import('zod') | null} */
let z;
try {
  z = require('zod');
} catch (error) {
  // This aids debugging when Zod fails to load (e.g., missing module)
  logger.warn('[IPC] Zod not available, skipping schema validation:', error.message);
  z = null;
}

let hasWarnedMissingZod = false;
function warnMissingZod(context = 'IPC') {
  if (hasWarnedMissingZod) {
    return;
  }
  hasWarnedMissingZod = true;
  logger.warn(`[${context}] Zod not available; schema validation disabled.`);
}

/**
 * Standard IPC error response format
 * @typedef {Object} IPCErrorResponse
 * @property {boolean} success - Always false for errors
 * @property {Object} error - Error details
 * @property {string} error.code - Error code for programmatic handling
 * @property {string} error.message - Human-readable error message
 * @property {Object} [error.details] - Additional error context
 */

/**
 * Standard IPC success response format
 * @typedef {Object} IPCSuccessResponse
 * @property {boolean} success - Always true for success
 * @property {*} [data] - Response data (spread into response for backwards compatibility)
 */

/**
 * Create success response (IPC-specific wrapper)
 * For backwards compatibility, spreads object data directly into response
 * @param {*} data - Response data (defaults to empty object for IPC compatibility)
 * @returns {IPCSuccessResponse} Standardized success response
 */
function createSuccessResponse(data = {}) {
  // For IPC handlers, if data is already an object, spread it for backwards compatibility
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return {
      success: true,
      ...data
    };
  }
  return createStandardSuccessResponse(data);
}

/**
 * Create a simple success response with optional warnings
 * This is the preferred format for settings-style handlers
 * @param {Record<string, any>} [data] - Response data to include
 * @param {string[]} [warnings] - Optional warnings array
 * @returns {Record<string, any>} Success response
 */
function successResponse(data = {}, warnings = []) {
  /** @type {Record<string, any>} */
  const response = { success: true, ...data };
  if (warnings && warnings.length > 0) {
    response.warnings = warnings;
  }
  return response;
}

/**
 * Create a simple error response
 * This is the preferred format for settings-style handlers
 * @param {string} error - Error message
 * @param {Record<string, any>} [extras] - Additional fields (e.g., validationErrors)
 * @returns {import('../../shared/types/ipc').IpcFailure} Error response
 */
function errorResponse(error, extras = {}) {
  return { success: false, error, ...extras };
}

/**
 * Create a canceled response (for dialog cancellation)
 * @returns {import('../../shared/types/ipc').IpcFailure} Canceled response
 */
function canceledResponse() {
  return { success: false, canceled: true };
}

/**
 * Create middleware that ensures the vector DB is initialized before handler executes.
 * Use this to wrap handlers that require the vector DB to be ready.
 *
 * @param {Object} options - Configuration options
 * @param {() => Promise<any>} options.ensureInit - Async function to trigger initialization
 * @param {() => boolean} options.isInitRef - Function that returns current isInitialized state
 * @param {IpcHandlerFn} options.handler - The handler function to wrap
 * @param {LoggerLike} [options.logger] - Optional logger for debug output
 * @returns {(...args: any[]) => Promise<any>} Wrapped handler that checks init state first
 *
 * @example
 * const handler = withVectorDbInit({
 *   ensureInit: ensureInitialized,
 *   isInitRef: () => isInitialized,
 *   handler: async (event, params) => {
 *     // Handler logic here - vector DB is guaranteed ready
 *   }
 * });
 */
function withVectorDbInit({ ensureInit, isInitRef, handler }) {
  return async (...args) => {
    try {
      await ensureInit();
    } catch (e) {
      return {
        success: false,
        error: 'Vector DB is not available yet. Please try again in a moment.',
        code: e?.code || 'VECTOR_DB_UNAVAILABLE',
        unavailable: true
      };
    }

    if (!isInitRef()) {
      return {
        success: false,
        error: 'Vector DB initialization pending. Please try again in a few seconds.',
        code: 'VECTOR_DB_PENDING',
        pending: true
      };
    }

    return handler(...args);
  };
}

/**
 * Wrap an IPC handler with try/catch and error logging
 * @param {LoggerLike} logger - Logger instance
 * @param {IpcHandlerFn} fn - Handler function to wrap
 * @param {Object} [options] - Additional options
 * @param {string} [options.context] - Context string for logging
 * @returns {(...args: any[]) => Promise<any>} Wrapped handler function
 */
function withErrorLogging(logger, fn, options = {}) {
  const { context = 'IPC' } = options;

  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      try {
        logger?.error?.(`[${context}] Handler error:`, error);
      } catch (logError) {
        // If logging itself fails, do not fall back to console.* here to avoid bypassing
        // our logging policy and to prevent recursive error loops in edge cases.
        void logError;
      }
      throw error;
    }
  };
}

/**
 * Wrap an IPC handler with input validation using Zod schema
 * @param {LoggerLike} logger - Logger instance
 * @param {SafeParseSchema|null|undefined} schema - Zod schema (or fallback validator) for validation
 * @param {IpcHandlerFn} handler - Handler function to wrap
 * @param {Object} [options] - Additional options
 * @param {string} [options.context] - Context string for logging
 * @returns {(...args: any[]) => Promise<any>} Wrapped handler function with validation
 */
function withValidation(logger, schema, handler, options = {}) {
  const { context = 'IPC' } = options;

  if (!schema) {
    return withErrorLogging(logger, handler, options);
  }

  // Duck-type on `safeParse` rather than gating on a global Zod reference.
  // validationSchemas.js exposes fallback validators that implement the same
  // `{ success, data, error }` shape even when Zod itself is unavailable, so
  // any object that quacks like a validator is honored here. The historical
  // "Zod unavailable -> block all requests" branch caused hard failures in
  // environments where the fallback was the intended path.
  if (typeof schema.safeParse !== 'function') {
    warnMissingZod(context);
    return withErrorLogging(
      logger,
      async () =>
        createErrorResponse(
          { message: 'Input validation unavailable', name: 'ValidationUnavailableError' },
          { detail: 'Provided schema does not implement safeParse' }
        ),
      options
    );
  }

  return withErrorLogging(
    logger,
    async (...args) => {
      try {
        // Electron ipcMain.handle args: (event, ...payloadArgs)
        const payload = args.slice(1);
        const parsed = schema.safeParse(payload.length <= 1 ? payload[0] : payload);

        if (!parsed.success) {
          logger?.warn?.(`[${context}] Validation failed:`, parsed.error);
          return createErrorResponse(
            { message: 'Invalid input', name: 'ValidationError' },
            {
              validationErrors:
                parsed.error?.flatten?.() ?? parsed.error?.message ?? String(parsed.error)
            }
          );
        }

        const normalized = parsed.data;
        // Reconstruct the args: keep event as first, then validated payload
        const nextArgs = [args[0], ...(Array.isArray(normalized) ? normalized : [normalized])];
        return await handler(...nextArgs);
      } catch (e) {
        logger?.error?.(`[${context}] Validation wrapper failed:`, e);
        throw e;
      }
    },
    options
  );
}

/**
 * Internal helper for service availability check logic
 * FIX: Extracted to avoid duplication between withServiceCheck and createHandler
 * @param {Object} options - Configuration options
 * @param {LoggerLike} options.logger - Logger instance
 * @param {string} options.serviceName - Name of the service
 * @param {() => any} options.getService - Function that returns the service instance
 * @param {IpcHandlerFn} options.handler - Handler function to wrap
 * @param {*} [options.fallbackResponse] - Response to return if service unavailable
 * @param {string} [options.context] - Context string for logging
 * @returns {(...args: any[]) => Promise<any>} Handler with service check (without error logging wrapper)
 */
function _createServiceCheckHandler({
  logger,
  serviceName,
  getService,
  handler,
  fallbackResponse = null,
  context = 'IPC'
}) {
  return async (...args) => {
    const service = getService();

    if (!service) {
      // When a fallbackResponse is configured, the missing-service branch is an
      // expected degraded-mode path (e.g. renderer polls undo-redo:get-state
      // during the ~3 s window before ServiceIntegration.initialize() finishes
      // — observed in production logs). The caller gets a sensible default and
      // proceeds. Logging that at warn level produces startup noise indistinguishable
      // from a real misconfiguration. Reserve warn for the no-fallback case where
      // the handler genuinely cannot serve the caller.
      if (fallbackResponse !== null) {
        logger?.debug?.(
          `[${context}] Service not yet available, returning fallback: ${serviceName}`
        );
        return fallbackResponse;
      }

      logger?.warn?.(`[${context}] Service not available: ${serviceName}`);
      return createErrorResponse(
        {
          message: `${serviceName} service is not available`,
          name: 'ServiceUnavailableError',
          code: ERROR_CODES.SERVICE_UNAVAILABLE
        },
        { serviceName }
      );
    }

    return await handler(...args, service);
  };
}

/**
 * Wrap an IPC handler with service availability check
 * @param {Object} options - Configuration options
 * @param {LoggerLike} options.logger - Logger instance
 * @param {string} options.serviceName - Name of the service (for error messages)
 * @param {() => any} options.getService - Function that returns the service instance
 * @param {IpcHandlerFn} options.handler - Handler function to wrap
 * @param {*} [options.fallbackResponse] - Response to return if service unavailable
 * @param {string} [options.context] - Context string for logging
 * @returns {(...args: any[]) => Promise<any>} Wrapped handler function with service check
 */
function withServiceCheck({
  logger,
  serviceName,
  getService,
  handler,
  fallbackResponse = null,
  context = 'IPC'
}) {
  const serviceCheckHandler = _createServiceCheckHandler({
    logger,
    serviceName,
    getService,
    handler,
    fallbackResponse,
    context
  });
  return withErrorLogging(logger, serviceCheckHandler, { context });
}

/**
 * Create a fully-wrapped IPC handler with all standard patterns
 *
 * This is the primary factory function that combines:
 * - Error logging
 * - Input validation (optional)
 * - Service availability checking (optional)
 * - Consistent error response format
 *
 * @param {Object} options - Configuration options
 * @param {LoggerLike} options.logger - Logger instance (required)
 * @param {IpcHandlerFn} options.handler - Handler function (required)
 * @param {SafeParseSchema|null} [options.schema] - Zod schema for input validation
 * @param {string|null} [options.serviceName] - Name of required service
 * @param {(() => any)|null} [options.getService] - Function to get service instance
 * @param {*} [options.fallbackResponse] - Response when service unavailable
 * @param {string} [options.context] - Context string for logging (default: 'IPC')
 * @param {boolean} [options.wrapResponse] - Whether to wrap successful results in success response (default: false)
 * @param {((value: any) => any)|null} [options.normalize] - Optional normalization for validated payloads
 * @returns {(...args: any[]) => Promise<any>} Fully wrapped IPC handler
 *
 * @example
 * // Simple handler with just error logging
 * const handler = createHandler({
 *   logger,
 *   handler: async (event) => {
 *     return { data: 'result' };
 *   }
 * });
 *
 * @example
 * // Handler with validation
 * const handler = createHandler({
 *   logger,
 *   schema: z.object({ filePath: z.string().min(1) }),
 *   handler: async (event, { filePath }) => {
 *     return { path: filePath };
 *   }
 * });
 *
 * @example
 * // Handler with service check
 * const handler = createHandler({
 *   logger,
 *   serviceName: 'analysisHistory',
 *   getService: () => getServiceIntegration()?.analysisHistory,
 *   fallbackResponse: { entries: [], total: 0 },
 *   handler: async (event, data, service) => {
 *     return await service.getEntries();
 *   }
 * });
 */
function createHandler({
  logger,
  handler,
  schema = null,
  serviceName = null,
  getService = null,
  fallbackResponse = null,
  context = 'IPC',
  wrapResponse = false,
  normalize = null
}) {
  if (!logger) {
    throw new Error('createHandler requires a logger');
  }
  if (!handler || typeof handler !== 'function') {
    throw new Error('createHandler requires a handler function');
  }

  // Build the handler chain from inside out
  let wrappedHandler = handler;

  // Wrap response in success format if requested
  if (wrapResponse) {
    const innerHandler = wrappedHandler;
    wrappedHandler = async (...args) => {
      const result = await innerHandler(...args);
      // Don't double-wrap if already a success/error response
      if (result && typeof result === 'object' && 'success' in result) {
        return result;
      }
      return createSuccessResponse(result);
    };
  }

  // Add service check if configured
  if (serviceName && getService) {
    wrappedHandler = _createServiceCheckHandler({
      logger,
      serviceName,
      getService,
      handler: wrappedHandler,
      fallbackResponse,
      context
    });
  }

  // Add validation if schema provided. Duck-type on `safeParse` so fallback
  // validators (validationSchemas.js) work identically to Zod schemas without
  // requiring a global `z` reference. The former "Zod unavailable -> block
  // all" failure mode was the root cause behind IPC handlers failing closed
  // in test harnesses and any environment where Zod failed to load.
  if (schema && typeof schema.safeParse === 'function') {
    const innerHandler = wrappedHandler;
    wrappedHandler = async (...args) => {
      // Electron ipcMain.handle args: (event, ...payloadArgs)
      const payload = args.slice(1);
      const parsed = schema.safeParse(payload.length <= 1 ? payload[0] : payload);

      if (!parsed.success) {
        logger?.warn?.(`[${context}] Validation failed:`, parsed.error);
        return createErrorResponse(
          { message: 'Invalid input', name: 'ValidationError' },
          {
            validationErrors:
              parsed.error?.flatten?.() ?? parsed.error?.message ?? String(parsed.error)
          }
        );
      }

      let normalized = parsed.data;
      if (typeof normalize === 'function') {
        try {
          normalized = normalize(normalized);
        } catch (normalizeError) {
          logger?.warn?.(`[${context}] Normalization failed:`, normalizeError?.message);
          return createErrorResponse(
            { message: 'Invalid input', name: 'NormalizationError' },
            { error: normalizeError?.message }
          );
        }
      }
      // Reconstruct args while preserving original IPC arity.
      // Single-payload array args (e.g. folders[]) must remain a single argument.
      const shouldSpreadArray = payload.length > 1;
      let normalizedArgs =
        shouldSpreadArray && Array.isArray(normalized) ? normalized : [normalized];
      // invoke() with no args yields payload=[]; void schemas parse as undefined — omit so
      // service-checked handlers can keep (event, service) instead of (event, undefined, service).
      if (normalized === undefined && payload.length === 0) {
        normalizedArgs = [];
      }
      const nextArgs = [args[0], ...normalizedArgs];
      return await innerHandler(...nextArgs);
    };
  }

  if (schema && typeof schema.safeParse !== 'function') {
    // Schema was supplied but is not a valid validator (neither Zod nor a
    // fallback that implements safeParse). Fail closed rather than silently
    // passing unvalidated data.
    warnMissingZod(context);
    wrappedHandler = async () => {
      logger?.error?.(
        `[${context}] Blocking request: schema does not implement safeParse (validation unavailable)`
      );
      return createErrorResponse(
        { message: 'Input validation unavailable', name: 'ValidationUnavailableError' },
        { detail: 'Provided schema does not implement safeParse' }
      );
    };
  }

  // Add normalization without schema (raw payload passthrough)
  if (!schema && typeof normalize === 'function') {
    const innerHandler = wrappedHandler;
    wrappedHandler = async (...args) => {
      const payload = args.slice(1);
      let normalized;
      try {
        normalized = normalize(payload.length <= 1 ? payload[0] : payload);
      } catch (normalizeError) {
        logger?.warn?.(`[${context}] Normalization failed:`, normalizeError?.message);
        return createErrorResponse(
          { message: 'Invalid input', name: 'NormalizationError' },
          { error: normalizeError?.message }
        );
      }
      const shouldSpreadArray = payload.length > 1;
      const normalizedArgs =
        shouldSpreadArray && Array.isArray(normalized) ? normalized : [normalized];
      const nextArgs = [args[0], ...normalizedArgs];
      return await innerHandler(...nextArgs);
    };
  }

  // Always wrap with error logging
  return withErrorLogging(logger, wrappedHandler, { context });
}

/**
 * Per-channel configuration accepted by {@link registerHandlers}: everything
 * {@link createHandler} takes except logger/context (injected at registration).
 * @typedef {Object} HandlerConfig
 * @property {IpcHandlerFn} handler - Handler function (required)
 * @property {SafeParseSchema|null} [schema] - Zod schema for input validation
 * @property {string|null} [serviceName] - Name of required service
 * @property {(() => any)|null} [getService] - Function to get service instance
 * @property {*} [fallbackResponse] - Response when service unavailable
 * @property {boolean} [wrapResponse] - Wrap successful results in success response
 * @property {((value: any) => any)|null} [normalize] - Normalization for validated payloads
 * @property {string} [context] - Per-channel context override
 */

/**
 * Register multiple IPC handlers with consistent patterns.
 * Uses the IPC registry for targeted cleanup during shutdown.
 *
 * @param {Object} options - Configuration options
 * @param {import('electron').IpcMain} options.ipcMain - Electron ipcMain instance
 * @param {LoggerLike} options.logger - Logger instance
 * @param {Record<string, HandlerConfig>} options.handlers - Map of channel names to handler configs
 * @param {string} [options.context] - Default context for logging
 *
 * @example
 * registerHandlers({
 *   ipcMain,
 *   logger,
 *   context: 'Settings',
 *   handlers: {
 *     [IPC_CHANNELS.SETTINGS.GET]: {
 *       handler: async () => settingsService.load()
 *     },
 *     [IPC_CHANNELS.SETTINGS.SAVE]: {
 *       schema: settingsSchema,
 *       handler: async (event, settings) => settingsService.save(settings)
 *     }
 *   }
 * });
 */
function registerHandlers({ ipcMain, logger, handlers, context = 'IPC' }) {
  const { registerHandler } = require('../core/ipcRegistry');

  for (const [channel, config] of Object.entries(handlers)) {
    const handler = createHandler({
      logger,
      context,
      ...config
    });
    registerHandler(ipcMain, channel, handler);
  }
}

/**
 * Safe wrapper for ipcMain.handle that registers with the IPC registry.
 * Use this instead of ipcMain.handle() directly to ensure proper cleanup.
 *
 * @param {import('electron').IpcMain} ipcMain - Electron ipcMain instance
 * @param {string} channel - IPC channel name
 * @param {IpcHandlerFn} handler - Handler function
 */
function safeHandle(ipcMain, channel, handler) {
  const { registerHandler } = require('../core/ipcRegistry');
  registerHandler(ipcMain, channel, handler);
}

/**
 * Safe wrapper for ipcMain.on that registers with the IPC registry.
 * Use this instead of ipcMain.on() directly to ensure proper cleanup.
 *
 * @param {import('electron').IpcMain} ipcMain - Electron ipcMain instance
 * @param {string} channel - IPC channel name
 * @param {(...args: any[]) => void} listener - Listener function
 */
function safeOn(ipcMain, channel, listener) {
  const { registerListener } = require('../core/ipcRegistry');
  registerListener(ipcMain, channel, listener);
}

/**
 * Safe wrapper for webContents.send() that validates event payloads.
 * Use this instead of webContents.send() directly to ensure type safety.
 *
 * Validation is **blocking by default** (strict mode): invalid payloads are logged and NOT sent.
 * Use `{ strict: false }` to log-but-send during migration.
 *
 * @param {import('electron').WebContents} webContents - Electron webContents instance
 * @param {string} channel - IPC channel name
 * @param {*} data - Payload to send
 * @param {Object} [options] - Options
 * @param {boolean} [options.strict=true] - If true (default), don't send on validation failure
 * @returns {boolean} Whether the send was attempted (false only in strict mode on failure)
 *
 * @example
 * // Basic usage
 * safeSend(mainWindow.webContents, 'operation-progress', { current: 1, total: 10 });
 *
 * @example
 * // Strict mode (won't send if validation fails)
 * safeSend(win.webContents, 'notification', data, { strict: true });
 */
function safeSend(webContents, channel, data, options = {}) {
  const { strict = true } = options;

  if (!webContents || typeof webContents.send !== 'function') {
    logger.debug(`[IPC Event] Cannot send '${channel}': invalid webContents`);
    return false;
  }
  if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) {
    logger.debug(`[IPC Event] Cannot send '${channel}': webContents destroyed`);
    return false;
  }

  // Validate if schema exists for this channel
  if (hasEventSchema(channel)) {
    const { valid, error } = validateEventPayload(channel, data);

    if (!valid) {
      logger.warn(`[IPC Event] Validation failed for '${channel}':`, {
        error: error?.flatten ? error.flatten() : String(error),
        data: typeof data === 'object' ? Object.keys(data) : typeof data
      });

      if (strict) {
        logger.error(
          `[IPC Event] Blocking send for '${channel}' due to validation failure (strict mode)`
        );
        return false;
      }
      // In non-strict mode, log but continue sending
    }
  }

  // Send the event
  try {
    webContents.send(channel, data);
    return true;
  } catch (sendError) {
    logger.error(`[IPC Event] Failed to send '${channel}':`, sendError);
    return false;
  }
}

/**
 * Safe wrapper that gets the main window and sends if available.
 * Handles common patterns of checking window existence before send.
 *
 * @param {(() => import('electron').BrowserWindow | null) | import('electron').BrowserWindow} getMainWindow - Function that returns main window (or the window itself)
 * @param {string} channel - IPC channel name
 * @param {*} data - Payload to send
 * @param {Object} [options] - Options passed to safeSend
 * @returns {boolean} Whether the send was attempted
 *
 * @example
 * safeSendToMain(getMainWindow, 'notification', { message: 'Hello' });
 */
function safeSendToMain(getMainWindow, channel, data, options = {}) {
  try {
    const win = typeof getMainWindow === 'function' ? getMainWindow() : getMainWindow;
    if (!win || win.isDestroyed()) {
      logger.debug(`[IPC Event] Cannot send '${channel}': window not available`);
      return false;
    }
    return safeSend(win.webContents, channel, data, options);
  } catch (error) {
    logger.error(`[IPC Event] Error in safeSendToMain for '${channel}':`, error);
    return false;
  }
}

// Export Zod instance for convenience (if available)
module.exports = {
  // Primary exports
  createHandler,
  registerHandlers,

  // Safe IPC registration (uses registry for cleanup)
  safeHandle,
  safeOn,

  // Safe event sending with validation
  safeSend,
  safeSendToMain,

  // Individual wrappers for backwards compatibility
  withErrorLogging,
  withValidation,
  withServiceCheck,
  withVectorDbInit,

  // Response helpers (structured format)
  createErrorResponse,
  createSuccessResponse,

  // Response helpers (simple format - preferred for settings-style handlers)
  successResponse,
  errorResponse,
  canceledResponse,

  // Re-export error codes for convenience
  ERROR_CODES,

  // Zod instance (may be null if not installed)
  z
};
