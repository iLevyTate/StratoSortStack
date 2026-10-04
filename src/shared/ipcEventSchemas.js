// @ts-check
/**
 * IPC Event Schemas
 *
 * Zod schemas for validating IPC event payloads sent between main and renderer processes.
 * These provide type safety and runtime validation for cross-process communication.
 *
 * Usage:
 * - Main process: Use safeSend() from ipcWrappers.js to validate before sending
 * - Renderer: Use validateEventData() in ipcMiddleware.js to validate on receipt
 */

const { logger } = require('./logger');

// Try to load zod for validation
/** @type {any} */
let z;
let hasWarnedMissingZod = false;
try {
  z = require('zod');
} catch (error) {
  logger.warn('[ipcEventSchemas] Zod not available, schema validation disabled:', error.message);
  z = null;
}

const { IPC_CHANNELS, IPC_EVENTS } = require('./constants');

// Only define schemas if Zod is available
/** @type {Record<string, any>} */
const schemas = z
  ? (() => {
      /**
       * Operation Progress Event
       * Emitted during batch operations, downloads, and background tasks
       * Shape varies based on `type` field
       */
      const operationProgressSchema = z.object({
        type: z
          .enum([
            'batch_organize',
            'batch_analyze',
            'model-download',
            'model-download-complete',
            'model-download-error',
            'dependency',
            'hint',
            'analyze'
          ])
          .optional(),
        current: z.number().optional(),
        total: z.number().optional(),
        completed: z.number().optional(),
        percentage: z.number().min(0).max(100).optional(),
        message: z.string().optional(),
        phase: z.string().optional(),
        stage: z.string().optional(),
        // For model-download type
        model: z.string().optional(),
        status: z.string().optional(),
        digest: z.string().optional(),
        dependency: z.string().optional(),
        degraded: z.boolean().optional(),
        progress: z
          .object({
            model: z.string().optional(),
            filename: z.string().optional(),
            percent: z.number().optional(),
            percentage: z.number().optional(),
            downloadedBytes: z.number().optional(),
            totalBytes: z.number().optional(),
            speedBps: z.number().optional(),
            etaSeconds: z.number().optional(),
            error: z.string().optional(),
            companion: z.unknown().optional()
          })
          .optional(),
        // For batch operations
        file: z.string().optional(),
        success: z.boolean().optional(),
        error: z.string().optional(),
        // Batch analysis progress (from BatchAnalysisService._buildProgressSnapshot)
        batchId: z.string().optional(),
        currentFile: z.string().optional(),
        percent: z.number().optional(),
        section: z.string().optional(),
        sectionCurrent: z.number().optional(),
        sectionTotal: z.number().optional(),
        sectionOrder: z.array(z.string()).optional(),
        docCompleted: z.number().optional(),
        imageCompleted: z.number().optional(),
        documentsTotal: z.number().optional(),
        imagesTotal: z.number().optional(),
        docInFlight: z.number().optional(),
        imageInFlight: z.number().optional(),
        embeddingQueueSize: z.number().optional(),
        embeddingQueueCapacity: z.number().optional()
      });

      /**
       * File Operation Complete Event
       * Emitted after file move, delete, rename, or copy operations
       * Can be single file (oldPath/newPath) or batch (files/destinations)
       */
      const fileOperationCompleteSchema = z.object({
        operation: z.enum(['move', 'delete', 'rename', 'copy']),
        // Single file operation
        oldPath: z.string().optional(),
        newPath: z.string().optional(),
        // Batch operation
        files: z.array(z.string()).optional(),
        destinations: z.array(z.string()).optional()
      });

      /**
       * System Metrics Event
       * Periodic metrics broadcast from main process
       */
      const systemMetricsSchema = z.object({
        uptime: z.number().optional(),
        memory: z
          .object({
            used: z.number(),
            total: z.number(),
            percentage: z.number()
          })
          .optional(),
        cpu: z.number().optional(),
        // Extended metrics from systemAnalytics
        timestamp: z.number().optional(),
        processedFiles: z.number().optional(),
        successfulOperations: z.number().optional(),
        failedOperations: z.number().optional(),
        avgProcessingTime: z.number().optional(),
        errorRate: z.number().optional(),
        recentErrors: z
          .array(
            z.object({
              timestamp: z.union([z.number(), z.string()]).optional(),
              message: z.string().optional(),
              stack: z.string().optional()
            })
          )
          .optional(),
        llamaHealth: z.record(z.string(), z.unknown()).optional(),
        pipeline: z.record(z.string(), z.unknown()).optional(),
        stability: z.record(z.string(), z.unknown()).optional(),
        // Fix 2B: Replace z.any() with typed schemas
        // Use z.unknown() values to tolerate future non-numeric fields from Node.js
        processMemory: z.record(z.string(), z.unknown()).optional(),
        heapUsage: z.record(z.string(), z.unknown()).optional()
      });

      /**
       * Notification Event
       * Generic notification for toast display
       */
      const notificationSchema = z.object({
        id: z.string().optional(),
        message: z.string().optional(),
        title: z.string().optional(),
        severity: z.enum(['info', 'success', 'warning', 'error']).optional(),
        variant: z.enum(['info', 'success', 'warning', 'error']).optional(),
        duration: z.number().optional(),
        type: z.string().optional(),
        timestamp: z.union([z.string(), z.number()]).optional(),
        source: z.string().optional(),
        // Fix 2B: Replace z.any() with z.unknown() for notification data
        data: z.unknown().optional(),
        status: z.string().optional(),
        groupKey: z.string().optional()
      });

      /**
       * App Error Event
       * Error notification from main process to renderer
       */
      const appErrorSchema = z.object({
        message: z.string().optional(),
        error: z.string().optional(),
        type: z.string().optional(),
        severity: z.enum(['critical', 'error', 'warning', 'info']).optional(),
        userMessage: z.string().optional(),
        code: z.string().optional(),
        stack: z.string().optional(),
        timestamp: z.union([z.string(), z.number()]).optional()
      });

      /**
       * Settings Changed External Event
       * Emitted when settings are changed programmatically
       */
      const settingsChangedExternalSchema = z.object({
        // Fix 2B: Replace z.any() with typed schema
        settings: z.record(z.string(), z.unknown()).optional(),
        source: z.string().optional(),
        timestamp: z.number().optional()
      });

      /**
       * Vector DB Status Changed Event
       * Emitted when Vector DB connection status changes.
       * Fix 2D: .passthrough() removed — `health` field is now explicitly declared,
       * so arbitrary extra fields no longer need to pass through validation.
       */
      const vectorDbStatusChangedSchema = z.object({
        status: z.enum([
          'connected',
          'disconnected',
          'connecting',
          'error',
          'online',
          'offline',
          'recovering',
          'circuit_changed',
          'operation_queued',
          'hydrating'
        ]),
        // Health field used by normalizeServiceHealth() for richer status mapping
        health: z.string().optional(),
        timestamp: z.number().optional(),
        error: z.string().optional()
      });

      /**
       * Menu Action Event
       * Emitted from application menu to trigger UI actions
       */
      const menuActionSchema = z.enum([
        'select-files',
        'select-folder',
        'open-settings',
        'show-about'
      ]);

      /**
       * App Update Event
       * Emitted during auto-update process
       */
      const appUpdateSchema = z.object({
        status: z.enum([
          'checking',
          'available',
          'not-available',
          'downloading',
          'downloaded',
          'error'
        ]),
        version: z.string().optional(),
        progress: z.number().optional(),
        error: z.string().optional()
      });

      /**
       * Open Semantic Search Event
       * Emitted from system tray or global shortcut to trigger semantic search UI
       */
      const openSemanticSearchSchema = z.void();

      /**
       * Notification activation (tray click → focus app / navigate)
       */
      const notificationActionSchema = z.object({
        type: z.string(),
        data: z.unknown().optional()
      });

      /**
       * Smart Folders Updated Event
       * Emitted after a main-process-initiated smart folder mutation (e.g. the
       * background LLM enhancement that runs after smart-folders:add returns).
       * Signal-only: the renderer re-fetches the list via the existing thunk.
       */
      const smartFoldersUpdatedSchema = z.object({
        folderId: z.string().optional(),
        reason: z.string().optional(),
        timestamp: z.number().optional()
      });

      /**
       * Batch Results Chunk Event
       * Emitted during batch operations to stream results progressively
       */
      // Fix 2B: Replace z.any() with typed schemas for batch results.
      // chunk/results arrays can contain objects (analysis results) or primitives (file paths),
      // so we use z.unknown() to accept both without blocking events in strict mode.
      const batchResultsChunkSchema = z.object({
        // Current payload shape emitted by main batchProgressReporter.
        batchId: z.string().optional(),
        chunk: z.array(z.unknown()).optional(),
        chunkIndex: z.number().int().nonnegative().optional(),
        totalChunks: z.number().int().nonnegative().optional(),
        isLast: z.boolean().optional(),
        // Legacy compatibility fields (older emitters / tests).
        results: z.array(z.unknown()).optional(),
        total: z.number().optional(),
        operationType: z.string().optional()
      });

      // Per-file completion emitted during batch analysis. `item` mirrors the
      // BatchAnalysisService normalized shape ({ filePath, success, result,
      // error, type }); result/error stay unknown/optional because the payload
      // varies per section (document/image/media) and per success/failure.
      const analysisFileCompleteSchema = z.object({
        batchId: z.string().optional(),
        item: z.object({
          filePath: z.string(),
          success: z.boolean(),
          result: z.unknown().optional(),
          // nullish (not optional) so a null error/type fails soft — a benign
          // payload must never be silently dropped and strand a file as
          // "analyzing". The sender still normalizes these; this is defense in depth.
          error: z.string().nullish(),
          type: z.string().nullish()
        })
      });

      /**
       * Undo/Redo State Changed Event
       * Emitted after undo/redo operations to notify UI of state changes
       */
      const undoRedoStateChangedSchema = z.object({
        action: z.enum(['undo', 'redo']),
        result: z
          .object({
            success: z.boolean(),
            message: z.string().optional(),
            affectedFiles: z.array(z.string()).optional(),
            // UndoRedoService returns the action metadata and batch operation details
            action: z
              .object({
                id: z.string().optional(),
                type: z.string().optional(),
                description: z.string().optional(),
                // UndoRedoService persists ISO timestamps, but older callers may still
                // emit numeric epochs, so accept either representation.
                timestamp: z.union([z.number(), z.string().datetime()]).optional()
              })
              .optional(),
            results: z.array(z.record(z.string(), z.unknown())).optional(),
            successCount: z.number().optional(),
            failCount: z.number().optional(),
            operations: z.array(z.record(z.string(), z.unknown())).optional(),
            // partial=true signals that a batch undo/redo finished with mixed
            // results — some operations succeeded, others (e.g. ENOENT on a
            // file the user moved manually) failed. UndoRedoService emits
            // this so the renderer can render an "advance + show details"
            // UI instead of treating the whole action as a hard failure.
            // Without the field in the schema, strict-mode safeSend would
            // strip it and the renderer never sees the partial flag.
            partial: z.boolean().optional()
          })
          .optional()
      });

      /**
       * Chat Stream Chunk Event
       * Emitted during chat streaming; payload shape varies by type (chunk, status, done, error)
       */
      // Fix 2B: Replace z.any() with typed schemas for chat streaming.
      // `response` is a string during 'chunk' events but an object during 'done' events
      // (contains documentAnswer[], modelAnswer[], followUps[]), so it must accept both.
      const chatStreamChunkSchema = z.object({
        requestId: z.union([z.string(), z.number()]).optional(),
        sessionId: z.string().optional(),
        type: z.string().optional(),
        text: z.string().optional(),
        error: z.string().optional(),
        response: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
        sources: z.array(z.record(z.string(), z.unknown())).optional(),
        meta: z.record(z.string(), z.unknown()).optional()
      });

      /**
       * Chat Stream End Event
       * Emitted when chat streaming completes
       */
      const chatStreamEndSchema = z.object({
        requestId: z.union([z.string(), z.number()]).optional(),
        sessionId: z.string().optional()
      });

      /**
       * Downloads triage scan progress (Tier 0 / Tier 1)
       */
      const downloadsTriageScanProgressSchema = z.object({
        phase: z.enum(['tier0', 'tier1']),
        done: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        rate: z.number().nonnegative().optional(),
        etaSeconds: z.number().nonnegative().optional(),
        triageId: z.string().optional()
      });

      const downloadsTriageSessionInvalidatedSchema = z.object({
        // Bound the array — these payloads come from main and the renderer
        // bridge already caps array length at 10000 for inbound, so 10000
        // matches that policy on the outbound side.
        evictedIds: z.array(z.string()).max(10000)
      });

      /**
       * MCP Server Status Changed Event
       * Emitted by McpServerLifecycleService when the MCP server starts/stops/errors.
       * Payload mirrors the shape returned by `lifecycle.status()`.
       */
      const mcpStatusChangedSchema = z
        .object({
          status: z.enum(['stopped', 'starting', 'running', 'stopping', 'error']),
          port: z.number().int().nonnegative().nullable().optional(),
          tokenMasked: z.string().nullable().optional(),
          // `enabled` mirrors lifecycle.status() — McpServerLifecycleService
          // tracks the user's intent (toggle on/off) separately from `status`
          // (lifecycle phase). Without this field declared here, validateEventPayload
          // strips it from the payload before it reaches the renderer's global
          // STATUS_CHANGED subscriber, leaving state.enabled stale whenever the
          // settings panel isn't mounted (its local subscriber bypassed the
          // strip). Result: UI toggle desync after a server restart.
          enabled: z.boolean().optional(),
          // Optional metadata; loose to allow lifecycle additions without a
          // schema bump.
          meta: z.record(z.string(), z.unknown()).optional(),
          error: z.string().optional()
        })
        // .passthrough() so any new field added to lifecycle.status() in the
        // future flows through without a schema bump. Default Zod stripping
        // combined with safeSend's strict-default would silently ship partial
        // events to the renderer. (See vectorDbStatusChangedSchema for the
        // matching precedent.)
        .passthrough();

      /**
       * AI Provider Status Changed Event
       * Emitted by AIRouter when routing changes or provider readiness flips.
       * Payload mirrors `_routerStatus()` in src/main/ipc/aiProvider.js.
       */
      const aiProviderStatusChangedSchema = z
        .object({
          providers: z
            .array(
              z.object({
                id: z.string(),
                displayName: z.string().optional(),
                enabled: z.boolean(),
                ready: z.boolean()
              })
            )
            .optional(),
          routing: z
            .object({
              default: z.string().optional(),
              perFolder: z.record(z.string(), z.string()).optional()
            })
            .optional(),
          // _routerStatus() always emits `consent` since the cloud-consent
          // gating shipped. Without declaring it here, validateEventPayload
          // would strip it from STATUS_CHANGED events before the renderer
          // sees them — silently overriding consent set via acknowledgeCloud
          // with the absent field on the next status push.
          consent: z
            .object({
              acknowledgedCloudAt: z.string().nullable().optional()
            })
            .optional()
        })
        // .passthrough() so future _routerStatus() additions flow through
        // without a schema bump. The previous strip-by-default behavior is
        // exactly what caused the `consent` desync this comment documents.
        .passthrough();

      return {
        operationProgressSchema,
        fileOperationCompleteSchema,
        systemMetricsSchema,
        notificationSchema,
        appErrorSchema,
        settingsChangedExternalSchema,
        vectorDbStatusChangedSchema,
        menuActionSchema,
        appUpdateSchema,
        openSemanticSearchSchema,
        notificationActionSchema,
        smartFoldersUpdatedSchema,
        batchResultsChunkSchema,
        analysisFileCompleteSchema,
        undoRedoStateChangedSchema,
        chatStreamChunkSchema,
        chatStreamEndSchema,
        downloadsTriageScanProgressSchema,
        downloadsTriageSessionInvalidatedSchema,
        mcpStatusChangedSchema,
        aiProviderStatusChangedSchema
      };
    })()
  : {};

/**
 * Event channel to schema mapping
 * Maps IPC channel names to their validation schemas
 */
const EVENT_SCHEMAS = z
  ? {
      [IPC_EVENTS.OPERATION_PROGRESS]: schemas.operationProgressSchema,
      [IPC_EVENTS.FILE_OPERATION_COMPLETE]: schemas.fileOperationCompleteSchema,
      [IPC_EVENTS.SYSTEM_METRICS]: schemas.systemMetricsSchema,
      [IPC_EVENTS.NOTIFICATION]: schemas.notificationSchema,
      [IPC_EVENTS.APP_ERROR]: schemas.appErrorSchema,
      [IPC_EVENTS.SETTINGS_CHANGED_EXTERNAL]: schemas.settingsChangedExternalSchema,
      [IPC_CHANNELS.VECTOR_DB.STATUS_CHANGED]: schemas.vectorDbStatusChangedSchema,
      [IPC_EVENTS.MENU_ACTION]: schemas.menuActionSchema,
      [IPC_EVENTS.APP_UPDATE]: schemas.appUpdateSchema,
      [IPC_EVENTS.OPEN_SEMANTIC_SEARCH]: schemas.openSemanticSearchSchema,
      [IPC_EVENTS.NOTIFICATION_ACTION]: schemas.notificationActionSchema,
      [IPC_EVENTS.SMART_FOLDERS_UPDATED]: schemas.smartFoldersUpdatedSchema,
      [IPC_EVENTS.BATCH_RESULTS_CHUNK]: schemas.batchResultsChunkSchema,
      [IPC_EVENTS.ANALYSIS_FILE_COMPLETE]: schemas.analysisFileCompleteSchema,
      [IPC_CHANNELS.UNDO_REDO.STATE_CHANGED]: schemas.undoRedoStateChangedSchema,
      [IPC_CHANNELS.CHAT.STREAM_CHUNK]: schemas.chatStreamChunkSchema,
      [IPC_CHANNELS.CHAT.STREAM_END]: schemas.chatStreamEndSchema,
      ...(IPC_CHANNELS.DOWNLOADS?.TRIAGE_SCAN_PROGRESS
        ? {
            [IPC_CHANNELS.DOWNLOADS.TRIAGE_SCAN_PROGRESS]: schemas.downloadsTriageScanProgressSchema
          }
        : {}),
      ...(IPC_CHANNELS.DOWNLOADS?.TRIAGE_SESSION_INVALIDATED
        ? {
            [IPC_CHANNELS.DOWNLOADS.TRIAGE_SESSION_INVALIDATED]:
              schemas.downloadsTriageSessionInvalidatedSchema
          }
        : {}),
      ...(IPC_CHANNELS.MCP?.STATUS_CHANGED
        ? { [IPC_CHANNELS.MCP.STATUS_CHANGED]: schemas.mcpStatusChangedSchema }
        : {}),
      ...(IPC_CHANNELS.AI_PROVIDER?.STATUS_CHANGED
        ? {
            [IPC_CHANNELS.AI_PROVIDER.STATUS_CHANGED]: schemas.aiProviderStatusChangedSchema
          }
        : {})
    }
  : {};

/**
 * Validate event payload against schema
 * @param {string} channel - IPC channel name
 * @param {*} data - Payload to validate
 * @returns {{ valid: boolean, data?: *, error?: * }}
 */
function validateEventPayload(channel, data) {
  if (!z) {
    // This ensures callers using strict mode won't send unvalidated payloads.
    if (!hasWarnedMissingZod) {
      hasWarnedMissingZod = true;
      logger.error(`[ipcEventSchemas] CRITICAL: Zod missing, validation will fail-closed`);
    }
    return { valid: false, error: 'Zod validation library not available', data };
  }

  const schema = EVENT_SCHEMAS[channel];
  if (!schema) {
    // No schema defined for this channel, allow through
    return { valid: true, data };
  }

  const result = schema.safeParse(data);
  if (!result.success) {
    return {
      valid: false,
      error: result.error,
      data // Return original data for debugging
    };
  }

  return { valid: true, data: result.data };
}

/**
 * Get schema for a channel (for external use)
 * @param {string} channel - IPC channel name
 * @returns {*} Zod schema or undefined
 */
function getEventSchema(channel) {
  return EVENT_SCHEMAS[channel];
}

/**
 * Check if a channel has a defined schema
 * @param {string} channel - IPC channel name
 * @returns {boolean}
 */
function hasEventSchema(channel) {
  return Object.prototype.hasOwnProperty.call(EVENT_SCHEMAS, channel);
}

module.exports = {
  // Individual schemas (may be undefined if Zod not available)
  ...schemas,

  // Schema lookup map
  EVENT_SCHEMAS,

  // Utility functions
  validateEventPayload,
  getEventSchema,
  hasEventSchema,

  // Re-export Zod instance for convenience
  z
};
