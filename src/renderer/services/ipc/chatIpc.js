// @ts-check
import { EventEmitter } from 'events';

/** @returns {Record<string, any>|undefined} */
const getElectronAPI = () => /** @type {any} */ (window).electronAPI;

/** @param {any} result */
function extractErrorMessage(result) {
  if (!result) return 'Chat service unavailable';
  if (typeof result.error === 'string') return result.error;
  if (result.error?.message) return result.error.message;
  return 'Chat service unavailable';
}

class ChatStream extends EventEmitter {
  constructor() {
    super();
    this.handleChunk = this.handleChunk.bind(this);
    this.handleEnd = this.handleEnd.bind(this);
    /** @type {Array<() => void>} */
    this.cleanupFns = [];
    /** @type {any} */
    this.payload = null;
    this._cancelled = false;
    this._cleaned = false;
    this._beginCalled = false;
    /** @type {any} */
    this._pendingPayload = null;
  }

  /**
   * Attach IPC listeners first, then call `begin()` so the first STREAM_CHUNK
   * cannot arrive before `stream.on('data')` is registered.
   */
  begin() {
    if (this._beginCalled) return;
    this._beginCalled = true;
    if (this._cancelled || this._cleaned) return;
    const payload = this._pendingPayload;
    this._pendingPayload = null;
    if (!payload) {
      this.emit('error', new Error('Chat stream has no payload to start.'));
      this.cleanup();
      return;
    }
    this.start(payload);
  }

  /** @param {any} payload */
  start(payload) {
    if (this._cancelled) return;
    this.payload = payload;

    try {
      const electronAPI = getElectronAPI();
      if (!electronAPI?.chat) {
        this.emit('error', new Error('Chat API is not available. The app may still be loading.'));
        this.cleanup();
        return;
      }

      if (electronAPI.chat.onStreamChunk) {
        this.cleanupFns.push(electronAPI.chat.onStreamChunk(this.handleChunk));
      }
      if (electronAPI.chat.onStreamEnd) {
        this.cleanupFns.push(electronAPI.chat.onStreamEnd(this.handleEnd));
      }

      if (this._cancelled) {
        this.cleanup();
        return;
      }

      /** @type {any} */
      const invokePromise = electronAPI.chat.queryStream(payload);

      if (!invokePromise || typeof invokePromise.then !== 'function') {
        this.emit('error', new Error('Chat queryStream did not return a valid response.'));
        this.cleanup();
        return;
      }

      /** @type {(result: any) => void} */
      const onResult = (result) => {
        if (this._cleaned) return;
        if (result && result.success === false) {
          this.emit('error', new Error(extractErrorMessage(result)));
          this.cleanup();
        }
      };
      /** @type {(err: unknown) => void} */
      const onError = (err) => {
        if (this._cleaned) return;
        this.emit('error', err);
        this.cleanup();
      };
      invokePromise.then(onResult).catch(onError);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      this.cleanup();
    }
  }

  /** @param {any} data */
  matchesEvent(data) {
    const expectedRequestId = this.payload?.requestId;
    if (expectedRequestId !== undefined && expectedRequestId !== null) {
      return String(data?.requestId) === String(expectedRequestId);
    }

    const expectedSessionId = this.payload?.sessionId;
    if (expectedSessionId !== undefined && expectedSessionId !== null) {
      if (data?.sessionId === undefined || data?.sessionId === null) return true;
      return String(data.sessionId) === String(expectedSessionId);
    }

    return true;
  }

  /** @param {any} data */
  handleChunk(data) {
    if (this._cancelled) return;
    if (!this.matchesEvent(data)) return;
    this.emit('data', data);
  }

  /** @param {any} data */
  handleEnd(data) {
    if (this._cancelled) return;
    if (!this.matchesEvent(data)) return;
    this.emit('end');
    this.cleanup();
  }

  cleanup() {
    if (this._cleaned) return;
    this._cleaned = true;
    this.cleanupFns.forEach((fn) => {
      if (typeof fn === 'function') fn();
    });
    this.cleanupFns = [];
    this.removeAllListeners();
  }

  cancel() {
    if (this._cancelled) return;
    this._cancelled = true;
    this._pendingPayload = null;

    try {
      const electronAPI = getElectronAPI();
      if (electronAPI?.chat?.cancelStream) {
        electronAPI.chat
          .cancelStream({
            requestId: this.payload?.requestId,
            sessionId: this.payload?.sessionId
          })
          .catch(() => {
            // Best-effort cancel; stream is already being torn down
          });
      }
    } catch {
      // Best-effort cancel; don't propagate
    }

    // Emit 'end' BEFORE cleanup() strips all listeners, so the caller's
    // 'end' handler (which resets isChatting / chatInFlightRef) still fires.
    this.emit('end');
    this.cleanup();
  }
}

/** @param {any} payload */
export function queryStream(payload) {
  const stream = new ChatStream();
  stream._pendingPayload = payload;
  return stream;
}

export async function listConversations(limit = 50, offset = 0) {
  const electronAPI = getElectronAPI();
  if (!electronAPI?.chat?.listConversations) return [];
  const result = await electronAPI.chat.listConversations(limit, offset);
  if (!result?.success) throw new Error(extractErrorMessage(result));
  return result.conversations;
}

/** @param {string} id */
export async function getConversation(id) {
  const electronAPI = getElectronAPI();
  if (!electronAPI?.chat?.getConversation) return null;
  const result = await electronAPI.chat.getConversation(id);
  if (!result?.success) throw new Error(extractErrorMessage(result));
  return result.conversation;
}

/** @param {string} id */
export async function deleteConversation(id) {
  const electronAPI = getElectronAPI();
  if (!electronAPI?.chat?.deleteConversation) return;
  const result = await electronAPI.chat.deleteConversation(id);
  if (!result?.success) throw new Error(extractErrorMessage(result));
}

/**
 * @typedef {Object} SearchConversationsEnvelope
 * @property {Array<any>} items - matched conversation rows
 * @property {boolean} capped - true when history exceeded the decrypt-scan cap
 *           and matches in encrypted columns of older conversations may have
 *           been missed. UI should surface "showing recent N" notice.
 * @property {number} capLimit - the decrypt-scan cap value (e.g. 500)
 * @property {number} scannedCount - actual rows scanned in stage 2
 */
/**
 * @param {string} query
 * @returns {Promise<SearchConversationsEnvelope>}
 */
export async function searchConversations(query) {
  const electronAPI = getElectronAPI();
  if (!electronAPI?.chat?.searchConversations) {
    return { items: [], capped: false, capLimit: 0, scannedCount: 0 };
  }
  const result = await electronAPI.chat.searchConversations(query);
  if (!result?.success) throw new Error(extractErrorMessage(result));
  return {
    items: Array.isArray(result.results) ? result.results : [],
    capped: Boolean(result.capped),
    capLimit: Number(result.capLimit) || 0,
    scannedCount: Number(result.scannedCount) || 0
  };
}

/** @param {string} id */
export async function exportConversation(id) {
  const electronAPI = getElectronAPI();
  if (!electronAPI?.chat?.exportConversation) return null;
  const result = await electronAPI.chat.exportConversation(id);
  if (!result?.success) throw new Error(extractErrorMessage(result));
  return result.markdown;
}
