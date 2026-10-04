// @ts-check
import { updateProgress } from '../slices/analysisSlice';
import { updateMetrics, updateHealth, addNotification } from '../slices/systemSlice';
import {
  atomicUpdateFilePathsAfterMove,
  atomicRemoveFilesWithCleanup,
  invalidateSmartFolders
} from '../slices/filesSlice';
import { statusPushed as aiProviderStatusPushed } from '../slices/aiProviderSlice';
import { statusPushed as mcpStatusPushed } from '../slices/mcpServerSlice';
import { logger } from '../../../shared/logger';
import { IPC_CHANNELS } from '../../../shared/constants';
import { validateEventPayload, hasEventSchema } from '../../../shared/ipcEventSchemas';
import { toCanonicalPath } from '../../utils/canonicalPath';

/**
 * Validate incoming IPC event data against schema.
 * Logs warnings for invalid data and drops invalid payloads.
 *
 * @param {string} eventName - The event channel name
 * @param {*} data - The event payload
 * @returns {{ valid: boolean, data: * }} - Validation result with original or validated data
 */
function validateIncomingEvent(eventName, data) {
  if (!hasEventSchema(eventName)) {
    // No schema for this event, pass through
    return { valid: true, data };
  }

  const result = validateEventPayload(eventName, data);

  if (!result.valid) {
    logger.warn(`[IPC Middleware] Received invalid '${eventName}' event:`, {
      error: result.error?.flatten ? result.error.flatten() : String(result.error),
      dataKeys: data && typeof data === 'object' ? Object.keys(data) : typeof data
    });
    return { valid: false, data: null };
  }

  return { valid: true, data: result.data };
}

/**
 * Normalize operation-progress payloads used by analysis UI.
 * Main process batch analysis emits { completed, total }, while renderer analysis
 * state expects { current, total }.
 *
 * Only normalize analysis-related events so model download progress does not
 * pollute discover/organize analysis progress state.
 *
 * @param {*} payload
 * @returns {*}
 */
function normalizeAnalysisProgressPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;

  const type = String(payload.type || '').toLowerCase();
  if (type !== 'batch_analyze' && type !== 'analyze') {
    return payload;
  }

  const normalized = { ...payload };
  const completed = Number(payload.completed);
  const total = Number(payload.total);

  if (!Number.isFinite(Number(payload.current)) && Number.isFinite(completed) && completed >= 0) {
    normalized.current = completed;
  }

  if (Number.isFinite(total) && total >= 0) {
    normalized.total = total;
  }

  return normalized;
}

function dedupePathsByCanonicalValue(/** @type {any} */ paths) {
  const canonicalSeen = new Set();
  const deduped = [];
  for (const candidate of paths || []) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    const canonical = toCanonicalPath(candidate);
    if (!canonical || canonicalSeen.has(canonical)) continue;
    canonicalSeen.add(canonical);
    deduped.push(candidate);
  }
  return deduped;
}

// Track listeners for cleanup to prevent memory leaks
let listenersInitialized = false;
/** @type {any[]} */
let cleanupFunctions = [];
/** @type {any} */
let beforeUnloadHandler = null;

// Events that arrive before store.dispatch is ready are queued and flushed later
let isStoreReady = false;
/** @type {any[]} */
let eventQueue = [];
/** @type {any} */
let storeRef = null;

// Soft cap: eviction target for NON-critical events. Critical actions (path
// updates after moves, notifications, progress) are never dropped at this
// size — the queue grows for them instead, because losing an atomic path
// update leaves the store pointing at stale paths.
const MAX_EVENT_QUEUE_SIZE = 300;
// Hard ceiling for pathological pre-ready bursts: beyond this, oldest
// criticals drop (counted + surfaced after ready). ~2000 small action
// payloads is a few MB held only until markStoreReady flushes.
const MAX_CRITICAL_EVENT_QUEUE_SIZE = 2000;
const CRITICAL_ACTION_CREATORS = new Set([
  updateProgress,
  updateMetrics,
  updateHealth,
  addNotification,
  atomicUpdateFilePathsAfterMove,
  atomicRemoveFilesWithCleanup
]);
let droppedCriticalEventCount = 0;

/**
 * Emit a startup warning if critical events were dropped at the HARD queue
 * ceiling (criticals grow past the soft cap and are only dropped beyond
 * MAX_CRITICAL_EVENT_QUEUE_SIZE). Dropped events are gone — this surfaces
 * the fact so the user knows state may be stale. Called after markStoreReady.
 */
export function recoverPersistedCriticalEvents() {
  if (!storeRef || !isStoreReady) return;
  if (droppedCriticalEventCount <= 0) return;
  const droppedCount = droppedCriticalEventCount;
  droppedCriticalEventCount = 0;
  storeRef.dispatch(
    addNotification({
      message: `${droppedCount} critical updates were dropped during startup pressure.`,
      severity: 'warning',
      duration: 6000
    })
  );
}

/**
 * Queue an event for later dispatch or dispatch immediately if store is ready
 * @param {Function} actionCreator - The Redux action creator
 * @param {*} data - The event payload
 */
/**
 * @param {Function} actionCreator - The Redux action creator
 * @param {*} data - The event payload
 */
function safeDispatch(actionCreator, data) {
  const dispatchAny = /** @type {any} */ (safeDispatch);
  if (isStoreReady && storeRef) {
    storeRef.dispatch(actionCreator(data));
  } else {
    // Determine if we should add an overflow warning notification
    const shouldWarn =
      !dispatchAny.hasWarnedOverflow && eventQueue.length >= MAX_EVENT_QUEUE_SIZE * 0.8;
    const slotsNeeded = 1 + (shouldWarn ? 1 : 0);

    // Make room for the incoming event (and optional warning) in a single pass
    if (eventQueue.length > MAX_EVENT_QUEUE_SIZE - slotsNeeded) {
      logger.warn('[IPC Middleware] Event queue full, dropping events to make room', {
        queueSize: eventQueue.length,
        maxSize: MAX_EVENT_QUEUE_SIZE,
        slotsNeeded
      });
    }
    while (eventQueue.length > MAX_EVENT_QUEUE_SIZE - slotsNeeded) {
      const dropIndex = eventQueue.findIndex(
        (entry) => !CRITICAL_ACTION_CREATORS.has(entry.actionCreator)
      );
      if (dropIndex >= 0) {
        eventQueue.splice(dropIndex, 1);
        continue;
      }
      // Everything left is critical: GROW instead of dropping, up to the
      // hard ceiling that guards runaway memory.
      if (eventQueue.length <= MAX_CRITICAL_EVENT_QUEUE_SIZE - slotsNeeded) {
        break;
      }
      droppedCriticalEventCount += 1;
      eventQueue.shift();
    }

    if (shouldWarn) {
      /** @type {any} */ (safeDispatch).hasWarnedOverflow = true;
      eventQueue.push({
        actionCreator: addNotification,
        data: {
          message: 'System is busy - some updates may be delayed.',
          severity: 'warning',
          duration: 5000
        }
      });
    }

    eventQueue.push({ actionCreator, data });
    logger.debug('[IPC Middleware] Queued early event', {
      actionType: actionCreator?.name || 'unknown',
      queueSize: eventQueue.length,
      isStoreReady,
      hasStoreRef: !!storeRef
    });
  }
}

/**
 * Mark the store as ready and flush any queued events
 * Called after store configuration is complete
 */
export function markStoreReady() {
  logger.debug('[IPC Middleware] markStoreReady called', {
    isStoreReady,
    queueSize: eventQueue.length,
    hasStoreRef: !!storeRef
  });

  if (isStoreReady) return;
  isStoreReady = true;

  if (eventQueue.length > 0 && storeRef) {
    logger.info('[IPC Middleware] Flushing event queue', { count: eventQueue.length });
    // If events arrive during the forEach loop, they would be added to eventQueue
    // and then lost when eventQueue = [] runs. By swapping first, new events
    // go into a fresh array while we process the old one.
    const eventsToFlush = eventQueue;
    eventQueue = [];
    eventsToFlush.forEach(({ actionCreator, data }) => {
      try {
        storeRef.dispatch(actionCreator(data));
      } catch (e) {
        logger.error('[IPC Middleware] Error flushing queued event:', e.message);
        // Only notify for non-notification actions to avoid infinite loops
        if (actionCreator !== addNotification) {
          try {
            storeRef.dispatch(
              addNotification({
                message: 'Some updates may not have been applied correctly.',
                severity: 'warning',
                duration: 4000
              })
            );
          } catch (notifyError) {
            // Last resort - can't notify, just log
            logger.error(
              '[IPC Middleware] Failed to dispatch error notification:',
              notifyError.message
            );
          }
        }
      }
    });
  }

  if (/** @type {any} */ (safeDispatch).hasWarnedOverflow) {
    /** @type {any} */ (safeDispatch).hasWarnedOverflow = false;
  }

  // Surface any criticals dropped at the hard ceiling during startup pressure
  recoverPersistedCriticalEvents();
}

/** Max rate for Redux `updateProgress` from IPC — keeps UI responsive during bursty backend events. */
const IPC_PROGRESS_STORE_THROTTLE_MS = 80;

/**
 * @param {*} payload - Normalized operation-progress payload
 * @returns {boolean} Whether this update must reach the store immediately (completion / failure / 100%).
 */
function isTerminalOperationProgressPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const type = String(payload.type || '').toLowerCase();
  if (type.includes('complete') || type.includes('error')) return true;
  const nested = payload.progress && typeof payload.progress === 'object' ? payload.progress : null;
  const percent = Number(payload.percent ?? nested?.percent);
  if (percent === 100) return true;
  const total = Number(payload.total);
  if (!Number.isFinite(total) || total <= 0) return false;
  const done = Number(payload.current ?? payload.completed);
  return Number.isFinite(done) && done >= total;
}

let lastIpcProgressStoreDispatchMs = 0;
/** @type {NodeJS.Timeout | null} */
let ipcProgressTrailingTimer = null;
/** @type {any} */
let ipcProgressPendingPayload = null;

function flushPendingIpcProgressToStore() {
  ipcProgressTrailingTimer = null;
  if (!ipcProgressPendingPayload) return;
  const payload = ipcProgressPendingPayload;
  ipcProgressPendingPayload = null;
  lastIpcProgressStoreDispatchMs = Date.now();
  safeDispatch(updateProgress, payload);
}

/**
 * Throttle Redux progress dispatches from the main process. CustomEvents are still emitted per event
 * so listeners (e.g. batch analysis) can update refs every time without duplicate store writes.
 */
function dispatchThrottledProgressToStore(/** @type {any} */ normalizedPayload) {
  if (!isStoreReady) {
    safeDispatch(updateProgress, normalizedPayload);
    return;
  }

  if (isTerminalOperationProgressPayload(normalizedPayload)) {
    if (ipcProgressTrailingTimer) {
      clearTimeout(ipcProgressTrailingTimer);
      ipcProgressTrailingTimer = null;
    }
    ipcProgressPendingPayload = null;
    lastIpcProgressStoreDispatchMs = Date.now();
    safeDispatch(updateProgress, normalizedPayload);
    return;
  }

  const now = Date.now();
  if (now - lastIpcProgressStoreDispatchMs >= IPC_PROGRESS_STORE_THROTTLE_MS) {
    lastIpcProgressStoreDispatchMs = now;
    safeDispatch(updateProgress, normalizedPayload);
    return;
  }

  ipcProgressPendingPayload = normalizedPayload;
  if (!ipcProgressTrailingTimer) {
    const delay = Math.max(
      0,
      IPC_PROGRESS_STORE_THROTTLE_MS - (now - lastIpcProgressStoreDispatchMs)
    );
    ipcProgressTrailingTimer = setTimeout(flushPendingIpcProgressToStore, delay);
  }
}

const ipcMiddleware = (/** @type {any} */ store) => {
  storeRef = store;

  // Set up listeners once (with cleanup tracking)
  if (window.electronAPI?.events && !listenersInitialized) {
    // This ensures no duplicate listeners accumulate even if listenersInitialized
    // was incorrectly reset or the module was partially reloaded
    cleanupIpcListeners(false);

    listenersInitialized = true;

    // Listen for operation progress from batch operations
    if (typeof window.electronAPI.events.onOperationProgress === 'function') {
      const progressCleanup = window.electronAPI.events.onOperationProgress(
        (/** @type {any} */ data) => {
          const { valid, data: validatedData } = validateIncomingEvent('operation-progress', data);
          if (!valid) return;
          const normalized = normalizeAnalysisProgressPayload(validatedData);
          dispatchThrottledProgressToStore(normalized);
          // Re-dispatch as DOM CustomEvent so runBatchPath's progress listener receives it
          window.dispatchEvent(new CustomEvent('operation-progress', { detail: validatedData }));
        }
      );
      if (progressCleanup) cleanupFunctions.push(progressCleanup);
    } else {
      logger.debug('[IPC] onOperationProgress handler unavailable');
    }

    // Listen for system metrics updates
    if (typeof window.electronAPI.events.onSystemMetrics === 'function') {
      const metricsCleanup = window.electronAPI.events.onSystemMetrics(
        (/** @type {any} */ metrics) => {
          const { valid, data: validatedMetrics } = validateIncomingEvent(
            'system-metrics',
            metrics
          );
          if (!valid) return;
          safeDispatch(updateMetrics, validatedMetrics);
        }
      );
      if (metricsCleanup) cleanupFunctions.push(metricsCleanup);
    } else {
      logger.debug('[IPC] onSystemMetrics handler unavailable');
    }

    if (window.electronAPI.events.onFileOperationComplete) {
      const fileOpCleanup = window.electronAPI.events.onFileOperationComplete(
        (/** @type {any} */ data) => {
          const { valid, data: validatedData } = validateIncomingEvent(
            'file-operation-complete',
            data
          );
          if (!valid) return;
          logger.info('[IPC] File operation complete event received', {
            operation: validatedData.operation,
            fileCount: validatedData.files?.length
          });

          try {
            if (validatedData.operation === 'move') {
              // Support both batch payloads (files/destinations) and single-file payloads
              // (oldPath/newPath) emitted by main file operation handlers.
              const oldPaths =
                Array.isArray(validatedData.files) && validatedData.files.length > 0
                  ? validatedData.files
                  : validatedData.oldPath
                    ? [validatedData.oldPath]
                    : [];
              const newPaths =
                Array.isArray(validatedData.destinations) && validatedData.destinations.length > 0
                  ? validatedData.destinations
                  : validatedData.newPath
                    ? [validatedData.newPath]
                    : [];

              const dedupedOldPaths = dedupePathsByCanonicalValue(oldPaths);
              const dedupedNewPaths = dedupePathsByCanonicalValue(newPaths);
              if (dedupedOldPaths.length > 0 && dedupedOldPaths.length === dedupedNewPaths.length) {
                // Use atomic action to update BOTH filesSlice AND analysisSlice
                // in a single dispatch, preventing path desync from race conditions.
                safeDispatch(atomicUpdateFilePathsAfterMove, {
                  oldPaths: dedupedOldPaths,
                  newPaths: dedupedNewPaths
                });
              }
            } else if (validatedData.operation === 'delete') {
              // Support both batch payloads (files) and single-file payloads (oldPath).
              const removedPaths = dedupePathsByCanonicalValue(
                Array.isArray(validatedData.files) && validatedData.files.length > 0
                  ? validatedData.files
                  : validatedData.oldPath
                    ? [validatedData.oldPath]
                    : []
              );
              if (removedPaths.length > 0) {
                // Use atomic action to remove files from BOTH filesSlice AND analysisSlice.
                safeDispatch(atomicRemoveFilesWithCleanup, removedPaths);
              }
            }

            // (e.g., UnifiedSearchModal graph updates, search index invalidation)
            try {
              window.dispatchEvent(
                new CustomEvent('file-operation-complete', { detail: validatedData })
              );
            } catch (eventErr) {
              logger.warn(
                '[IPC Middleware] Failed to dispatch file-operation-complete event:',
                eventErr.message
              );
            }
          } catch (e) {
            logger.error('[IPC Middleware] Failed to dispatch file operation update', {
              operation: validatedData.operation,
              error: e.message
            });
          }
        }
      );
      if (fileOpCleanup) cleanupFunctions.push(fileOpCleanup);
    }

    // Now uses unified notification schema from main process (no field translation needed)
    if (window.electronAPI.events.onNotification) {
      const notificationCleanup = window.electronAPI.events.onNotification(
        (/** @type {any} */ data) => {
          const { valid, data: validatedData } = validateIncomingEvent('notification', data);
          if (!valid) return;

          // Pass standardized notification directly to Redux
          // Main process now sends unified schema with: id, message, severity, duration, etc.
          safeDispatch(addNotification, validatedData);

          // Emit custom event for toast display (decoupled from IPC middleware)
          // This allows NotificationContext to listen without duplicate IPC listeners
          try {
            window.dispatchEvent(new CustomEvent('app:notification', { detail: validatedData }));
          } catch (e) {
            logger.warn('[IPC Middleware] Failed to dispatch notification event:', e.message);
          }
        }
      );
      if (notificationCleanup) cleanupFunctions.push(notificationCleanup);
    }

    if (window.electronAPI.events.onNotificationAction) {
      const notificationActionCleanup = window.electronAPI.events.onNotificationAction(
        (/** @type {any} */ data) => {
          const { valid, data: validatedData } = validateIncomingEvent('notification-action', data);
          if (!valid) return;

          try {
            window.dispatchEvent(
              new CustomEvent('app:notification-action', { detail: validatedData })
            );
          } catch (e) {
            logger.warn(
              '[IPC Middleware] Failed to dispatch notification-action event:',
              e.message
            );
          }
        }
      );
      if (notificationActionCleanup) cleanupFunctions.push(notificationActionCleanup);
    }

    if (window.electronAPI.events.onSmartFoldersUpdated) {
      const smartFoldersUpdatedCleanup = window.electronAPI.events.onSmartFoldersUpdated(
        (/** @type {any} */ data) => {
          const { valid } = validateIncomingEvent('smart-folders-updated', data);
          if (!valid) return;

          // Signal-only event: re-fetch the canonical folder list from main so
          // every consumer (Setup screen included) reflects background
          // mutations like the post-add LLM enhancement.
          safeDispatch(invalidateSmartFolders, undefined);
        }
      );
      if (smartFoldersUpdatedCleanup) cleanupFunctions.push(smartFoldersUpdatedCleanup);
    }

    if (window.electronAPI.events.onBatchResultsChunk) {
      const batchChunkCleanup = window.electronAPI.events.onBatchResultsChunk(
        (/** @type {any} */ data) => {
          const { valid, data: validatedData } = validateIncomingEvent('batch-results-chunk', data);
          if (!valid) return;
          const chunkItems = Array.isArray(validatedData?.chunk)
            ? validatedData.chunk
            : Array.isArray(validatedData?.results)
              ? validatedData.results
              : [];
          const chunkIndex = Number.isInteger(validatedData?.chunkIndex)
            ? validatedData.chunkIndex
            : Number.isInteger(validatedData?.chunk)
              ? validatedData.chunk
              : 0;
          const totalChunks = Number.isInteger(validatedData?.totalChunks)
            ? validatedData.totalChunks
            : Number.isInteger(validatedData?.total)
              ? validatedData.total
              : 0;
          const normalizedPayload = {
            ...validatedData,
            chunk: chunkItems,
            chunkIndex,
            totalChunks
          };
          logger.debug('[IPC] Batch results chunk received', {
            chunkIndex: normalizedPayload.chunkIndex,
            totalChunks: normalizedPayload.totalChunks,
            resultCount: normalizedPayload.chunk.length
          });

          // Emit custom event for components that need progressive batch updates
          try {
            window.dispatchEvent(
              new CustomEvent('batch-results-chunk', { detail: normalizedPayload })
            );
          } catch (e) {
            logger.warn(
              '[IPC Middleware] Failed to dispatch batch-results-chunk event:',
              e.message
            );
          }
        }
      );
      if (batchChunkCleanup) cleanupFunctions.push(batchChunkCleanup);
    }

    if (window.electronAPI.events.onAnalysisFileComplete) {
      const fileCompleteCleanup = window.electronAPI.events.onAnalysisFileComplete(
        (/** @type {any} */ data) => {
          const { valid, data: validatedData } = validateIncomingEvent(
            'analysis:file-complete',
            data
          );
          if (!valid) {
            // Loud on purpose: a silently-dropped file-complete event strands the
            // file as "analyzing" and makes results appear only at end-of-batch.
            logger.warn(
              "[IPC Middleware] Dropped invalid 'analysis:file-complete' event; file will not stream incrementally",
              { filePath: data?.item?.filePath }
            );
            return;
          }
          // Re-emit as a window event so the Discover phase's active batch run
          // can apply each file incrementally. Kept off Redux here: useAnalysis
          // owns the per-file state machine (fileStates + throttled results
          // flush) and dispatching from two places would double-apply.
          try {
            window.dispatchEvent(
              new CustomEvent('analysis:file-complete', { detail: validatedData })
            );
          } catch (e) {
            logger.warn(
              '[IPC Middleware] Failed to dispatch analysis:file-complete event:',
              e.message
            );
          }
        }
      );
      if (fileCompleteCleanup) cleanupFunctions.push(fileCompleteCleanup);
    }

    if (window.electronAPI.events.onAppError) {
      const appErrorCleanup = window.electronAPI.events.onAppError((/** @type {any} */ data) => {
        const { valid, data: validatedData } = validateIncomingEvent('app:error', data);
        if (!valid) return;
        logger.error('[IPC] App error event received', validatedData);

        const notificationId =
          (typeof validatedData?.id === 'string' && validatedData.id) ||
          `app-error-${Date.now().toString(36)}`;
        const notificationPayload = {
          id: notificationId,
          notificationId,
          message: validatedData.message || validatedData.error || 'An error occurred',
          severity: 'error',
          duration: 6000,
          groupKey: 'app-error'
        };
        safeDispatch(addNotification, notificationPayload);
        try {
          window.dispatchEvent(
            new CustomEvent('app:notification', { detail: notificationPayload })
          );
        } catch (e) {
          logger.warn(
            '[IPC Middleware] Failed to dispatch app error notification event:',
            e.message
          );
        }
      });
      if (appErrorCleanup) cleanupFunctions.push(appErrorCleanup);
    }

    const normalizeServiceHealth = (/** @type {any} */ status, /** @type {any} */ health) => {
      const normalizedStatus = status ? String(status).toLowerCase() : '';
      const normalizedHealth = health ? String(health).toLowerCase() : '';

      if (['healthy', 'ok', 'online'].includes(normalizedHealth)) return 'online';
      if (['unhealthy', 'permanently_failed', 'offline', 'error'].includes(normalizedHealth)) {
        return 'offline';
      }
      // Hydrating / indexing = the DB is technically available for writes but
      // searches may be incomplete until the background restore finishes.
      // Surface this as 'indexing' so the UI can show a non-blocking banner
      // instead of either "online" (misleading) or "connecting" (implies no service).
      if (['indexing', 'hydrating'].includes(normalizedHealth)) return 'indexing';
      if (['hydrating', 'indexing'].includes(normalizedStatus)) return 'indexing';

      if (['online', 'connected', 'running', 'available'].includes(normalizedStatus)) {
        return 'online';
      }
      if (
        ['connecting', 'starting', 'initializing', 'recovering', 'booting'].includes(
          normalizedStatus
        )
      ) {
        return 'connecting';
      }
      if (
        ['offline', 'disconnected', 'stopped', 'failed', 'disabled', 'error'].includes(
          normalizedStatus
        )
      ) {
        return 'offline';
      }
      return 'unknown';
    };

    // Subscribe to Vector DB status changes (Orama)
    if (window.electronAPI?.vectorDb?.onStatusChanged) {
      const vectorStatusCleanup = window.electronAPI.vectorDb.onStatusChanged(
        (/** @type {any} */ data) => {
          const { valid, data: validatedData } = validateIncomingEvent(
            IPC_CHANNELS.VECTOR_DB.STATUS_CHANGED,
            data
          );
          if (!valid) return;
          logger.debug('[IPC] Vector DB status changed', { status: validatedData?.status });

          if (validatedData?.status || validatedData?.health) {
            const mapped = normalizeServiceHealth(validatedData.status, validatedData.health);
            safeDispatch(updateHealth, { vectorDb: mapped });
          }
        }
      );
      if (vectorStatusCleanup) cleanupFunctions.push(vectorStatusCleanup);
    }

    // Subscribe to AI provider routing/readiness status. Without this global
    // subscriber, AIProviderBadge in NavigationBar (always mounted) shows stale
    // routing.default after the user closes the settings panel and the router
    // falls back from cloud → local (e.g. budget cap hit).
    if (window.electronAPI?.aiProvider?.onStatusChanged) {
      const aiProviderStatusCleanup = window.electronAPI.aiProvider.onStatusChanged(
        (/** @type {any} */ payload) => {
          const { valid, data: validatedData } = validateIncomingEvent(
            IPC_CHANNELS.AI_PROVIDER.STATUS_CHANGED,
            payload
          );
          if (!valid) return;
          safeDispatch(aiProviderStatusPushed, validatedData);
        }
      );
      if (aiProviderStatusCleanup) cleanupFunctions.push(aiProviderStatusCleanup);
    }

    // Subscribe to MCP server lifecycle status. McpServerSection also
    // subscribes locally; same dedup-by-action rationale as above. Without
    // this, status changes that happen while the panel is unmounted (port
    // collision retry, auto-disable on shutdown error) are dropped.
    if (window.electronAPI?.mcp?.onStatusChanged) {
      const mcpStatusCleanup = window.electronAPI.mcp.onStatusChanged(
        (/** @type {any} */ payload) => {
          const { valid, data: validatedData } = validateIncomingEvent(
            IPC_CHANNELS.MCP.STATUS_CHANGED,
            payload
          );
          if (!valid) return;
          safeDispatch(mcpStatusPushed, validatedData);
        }
      );
      if (mcpStatusCleanup) cleanupFunctions.push(mcpStatusCleanup);
    }

    // Clean up listeners on window unload to prevent memory leaks
    beforeUnloadHandler = () => cleanupIpcListeners(true);
    window.addEventListener('beforeunload', beforeUnloadHandler);

    // Handle HMR cleanup if webpack hot module replacement is enabled.
    // Use isTeardown=false so we keep storeRef / isStoreReady — only listeners are torn down
    // and re-registered on the next middleware invocation (avoids dropping in-flight IPC routing).
    const moduleAny = /** @type {any} */ (module);
    if (moduleAny.hot) {
      moduleAny.hot.dispose(() => {
        cleanupIpcListeners(false);
      });
    }
  }

  // but we already have a storeRef from before. This handles HMR and late-loading middleware.
  if (storeRef && !isStoreReady) {
    setTimeout(markStoreReady, 0);
  }

  return (/** @type {any} */ next) => (/** @type {any} */ action) => {
    return next(action);
  };
};

// Export cleanup function for use during hot reload or app teardown
export const cleanupIpcListeners = (isTeardown = false) => {
  if (ipcProgressTrailingTimer) {
    clearTimeout(ipcProgressTrailingTimer);
    ipcProgressTrailingTimer = null;
  }
  ipcProgressPendingPayload = null;
  lastIpcProgressStoreDispatchMs = 0;

  cleanupFunctions.forEach((cleanup) => {
    try {
      cleanup();
    } catch (e) {
      logger.warn('Error cleaning up IPC listener:', e);
    }
  });
  cleanupFunctions = [];
  listenersInitialized = false;

  // This must happen BEFORE the isTeardown check, otherwise HMR calls with
  // isTeardown=false would leave orphaned handlers in the event listener list
  if (beforeUnloadHandler) {
    window.removeEventListener('beforeunload', beforeUnloadHandler);
    beforeUnloadHandler = null;
  }

  // During HMR or listener refresh, we want to keep the store state
  if (isTeardown) {
    isStoreReady = false;
    eventQueue = [];
    droppedCriticalEventCount = 0;
    storeRef = null;
    if (typeof safeDispatch !== 'undefined') {
      /** @type {any} */ (safeDispatch).hasWarnedOverflow = false;
    }
  }
};

export default ipcMiddleware;
