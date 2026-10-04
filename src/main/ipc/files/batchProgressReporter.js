// @ts-check
/**
 * Batch Progress Reporter
 *
 * Handles IPC progress updates and chunked result delivery.
 */

const { IPC_EVENTS } = require('../../../shared/constants');
const { BATCH } = require('../../../shared/performanceConstants');
const { safeSend } = require('../ipcWrappers');

/** @typedef {() => import('electron').BrowserWindow | null} GetMainWindowFn */

const THROTTLE_MS = BATCH?.PROGRESS_UPDATE_INTERVAL ?? 500;

let _lastProgressSendMs = 0;
/** @type {GetMainWindowFn|null} */
let _pendingGetMainWindow = null;
/** @type {*} */
let _pendingProgressPayload = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let _pendingProgressTimer = null;

/**
 * @param {GetMainWindowFn} getMainWindow
 * @param {*} payload
 */
function _doSend(getMainWindow, payload) {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    safeSend(win.webContents, IPC_EVENTS.OPERATION_PROGRESS, payload);
  }
}

/**
 * Throttled progress sender.  Emits at most once per THROTTLE_MS.
 * The final update in a batch is always delivered (via trailing flush).
 * @param {GetMainWindowFn} getMainWindow
 * @param {*} payload
 */
function sendOperationProgress(getMainWindow, payload) {
  const now = Date.now();
  const elapsed = now - _lastProgressSendMs;

  if (elapsed >= THROTTLE_MS) {
    if (_pendingProgressTimer) {
      clearTimeout(_pendingProgressTimer);
      _pendingProgressTimer = null;
    }
    _pendingGetMainWindow = null;
    _pendingProgressPayload = null;
    _lastProgressSendMs = now;
    _doSend(getMainWindow, payload);
    return;
  }

  // Trailing edge: buffer the latest payload and window getter for flush
  _pendingGetMainWindow = getMainWindow;
  _pendingProgressPayload = payload;
  if (!_pendingProgressTimer) {
    _pendingProgressTimer = setTimeout(() => {
      _pendingProgressTimer = null;
      if (_pendingProgressPayload && _pendingGetMainWindow) {
        _lastProgressSendMs = Date.now();
        _doSend(_pendingGetMainWindow, _pendingProgressPayload);
        _pendingGetMainWindow = null;
        _pendingProgressPayload = null;
      }
    }, THROTTLE_MS - elapsed);
  }
}

/**
 * Deliver batch results to the renderer in fixed-size chunks.
 * @param {GetMainWindowFn} getMainWindow
 * @param {string} batchId
 * @param {any[]} results
 * @param {number} maxPerChunk
 * @returns {Promise<{ sent: boolean, totalChunks: number }>}
 */
async function sendChunkedResults(getMainWindow, batchId, results, maxPerChunk) {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) {
    return { sent: false, totalChunks: 0 };
  }

  if (!Array.isArray(results)) {
    return { sent: false, totalChunks: 0 };
  }

  if (!Number.isInteger(maxPerChunk) || maxPerChunk <= 0) {
    return { sent: false, totalChunks: 0 };
  }

  if (results.length === 0) {
    return { sent: true, totalChunks: 0 };
  }

  const totalChunks = Math.ceil(results.length / maxPerChunk);

  for (let i = 0; i < results.length; i += maxPerChunk) {
    if (win.isDestroyed()) {
      return { sent: false, totalChunks: Math.floor(i / maxPerChunk) };
    }
    const chunk = results.slice(i, i + maxPerChunk);
    const chunkIndex = Math.floor(i / maxPerChunk);

    safeSend(win.webContents, IPC_EVENTS.BATCH_RESULTS_CHUNK, {
      batchId,
      chunk,
      chunkIndex,
      totalChunks,
      isLast: chunkIndex === totalChunks - 1
    });

    await new Promise((resolve) => setImmediate(resolve));
  }

  return { sent: true, totalChunks };
}

/**
 * Deliver a single completed file's analysis result to the renderer as soon as
 * it finishes. Unlike sendOperationProgress this is NOT throttled: every file
 * must reach the Discover UI so items stream in and the pipeline counter moves.
 * Uses a channel distinct from BATCH_RESULTS_CHUNK to avoid colliding with the
 * organize phase's chunk listeners.
 * @param {GetMainWindowFn} getMainWindow
 * @param {*} payload
 */
function sendFileComplete(getMainWindow, payload) {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    safeSend(win.webContents, IPC_EVENTS.ANALYSIS_FILE_COMPLETE, payload);
  }
}

/**
 * Batch-level FILE_OPERATION_COMPLETE notification. The renderer's
 * graph/timeline/recommendation-map listeners key on this event to remap
 * moved paths; `files`/`destinations` arrays are the batch form of the
 * single-op `oldPath`/`newPath` payload (see ipcEventSchemas.js). Never
 * throws: notification is best-effort and the disk mutation it reports
 * has already happened.
 * @param {GetMainWindowFn} getMainWindow
 * @param {{ operation: 'move'|'delete'|'rename'|'copy', files: string[], destinations?: string[] }} payload
 */
function sendFileOperationBatchComplete(getMainWindow, { operation, files, destinations }) {
  try {
    if (!Array.isArray(files) || files.length === 0) return;
    const win = getMainWindow?.();
    if (!win || win.isDestroyed()) return;
    safeSend(win.webContents, IPC_EVENTS.FILE_OPERATION_COMPLETE, {
      operation,
      files,
      ...(Array.isArray(destinations) ? { destinations } : {})
    });
  } catch {
    // Best-effort notification; the operation itself already completed.
  }
}

module.exports = {
  sendOperationProgress,
  sendChunkedResults,
  sendFileComplete,
  sendFileOperationBatchComplete
};
