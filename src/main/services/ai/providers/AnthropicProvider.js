// @ts-check
'use strict';
const { AIProviderError } = require('../errors');
const {
  combineSignalsWithTimeout,
  redactSensitive,
  DEFAULT_REQUEST_TIMEOUT_MS
} = require('./_providerHelpers');

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-4-7';
const DEFAULT_MAX_TOKENS = 4096;
const ANTHROPIC_VERSION = '2023-06-01';
// Abort an in-flight stream if no chunk arrives within this window. Without
// this, a stalled or hostile server can cause reader.read() to hang forever.
const STREAM_IDLE_TIMEOUT_MS = 60_000;

function _httpStatusToCode(/** @type {any} */ status) {
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 413) return 'CONTENT_TOO_LONG';
  if (status >= 500 && status < 600) return 'PROVIDER_FAILED';
  return 'PROVIDER_FAILED';
}

class AnthropicProvider {
  /** @param {{ getKey?: (...args: any[]) => any, model?: string, fetchFn?: any, costTracker?: any, streamIdleTimeoutMs?: number, logger?: any }} [deps] */
  constructor({ getKey, model, fetchFn, costTracker, streamIdleTimeoutMs, logger } = {}) {
    if (typeof getKey !== 'function')
      throw new Error('AnthropicProvider: getKey function is required');
    this._getKey = getKey;
    this._model = model || DEFAULT_MODEL;
    this._fetch = fetchFn || globalThis.fetch;
    this._costTracker = costTracker || null;
    this._logger = logger || { warn: () => {}, error: () => {} };
    // streamIdleTimeoutMs is configurable so tests can verify the watchdog
    // without waiting 60 seconds. Production uses STREAM_IDLE_TIMEOUT_MS.
    this._streamIdleTimeoutMs =
      typeof streamIdleTimeoutMs === 'number' ? streamIdleTimeoutMs : STREAM_IDLE_TIMEOUT_MS;
    this._readyCache = false;
    this._refreshing = false;
    this.id = 'anthropic';
    this.displayName = 'Anthropic Claude';
    // Pre-warm the ready cache so the FIRST sync call to ready() after
    // construction with an async getKey doesn't return a stale `false`.
    // Without this, every cold-start analysis silently routed to local
    // even when a cloud key was configured.
    this._warmReady();
  }

  _warmReady() {
    try {
      const k = this._getKey();
      if (k && typeof k.then === 'function') this._refreshReadyAsync(k);
      else if (typeof k === 'string') this._readyCache = k.length > 0;
      else this._readyCache = Boolean(k);
    } catch {
      /* default false stays */
    }
  }

  // ready() must be sync because AIRouter.choose() is sync. When getKey is
  // sync (tests, in-memory lookups) we resolve immediately. When getKey is
  // async (real keystore), we return the cached result and kick off a
  // background refresh so the next routing decision sees fresh state.
  ready() {
    try {
      const k = this._getKey();
      if (typeof k === 'string') {
        this._readyCache = k.length > 0;
        return this._readyCache;
      }
      if (k && typeof k.then === 'function') {
        this._refreshReadyAsync(k);
        return this._readyCache;
      }
      this._readyCache = Boolean(k);
      return this._readyCache;
    } catch {
      return false;
    }
  }

  _refreshReadyAsync(/** @type {any} */ promise) {
    if (this._refreshing) return;
    this._refreshing = true;
    // Always terminate the chain in .catch so an unhandled rejection doesn't
    // crash the main process or leave _readyCache inconsistent. The .then
    // resolution branches above already swallow rejections, but the .finally
    // can itself reject if the runtime is in a bad state.
    /** @type {(k: any) => undefined} */
    const onResolved = (k) => {
      this._readyCache = typeof k === 'string' && k.length > 0;
      return undefined;
    };
    /** @type {(err: unknown) => undefined} */
    const onRejected = (_err) => {
      this._readyCache = false;
      return undefined;
    };
    Promise.resolve(promise)
      .then(onResolved, onRejected)
      .finally(() => {
        this._refreshing = false;
      })
      .catch(() => {
        this._refreshing = false;
      });
  }

  async analyze(/** @type {any} */ prompt, options = {}) {
    return this._messages({ prompt, options, stream: false });
  }

  async suggest(/** @type {any} */ prompt, options = {}) {
    return this.analyze(prompt, options);
  }

  /** @param {Record<string, any>} [payload] */
  async chatStream(payload = {}) {
    const { prompt, systemPrompt, signal, onToken } = payload;
    return this._messages({ prompt, systemPrompt, signal, onToken, stream: true });
  }

  /**
   * @param {{
   *   prompt?: string,
   *   systemPrompt?: string,
   *   options?: { maxTokens?: number },
   *   signal?: AbortSignal,
   *   onToken?: (t: string) => void,
   *   stream?: boolean
   * }} args
   */
  async _messages({ prompt, systemPrompt, options = {}, signal, onToken, stream }) {
    const key = await this._getKey();
    if (!key) throw new AIProviderError('AUTH_FAILED', 'Anthropic API key not configured');

    // Pre-call: refuse if last month's spend already crossed the cap.
    // BUDGET_EXCEEDED bubbles up to the caller, which can surface it in the UI.
    // Use the atomic variant so concurrent callers serialize through the cost
    // tracker's write chain and the second-in-line observes the first's
    // committed recordUsage — preventing a multi-call race past the cap.
    if (typeof this._costTracker?.enforceCapAtomic === 'function') {
      await this._costTracker.enforceCapAtomic({ provider: this.id });
    } else {
      this._costTracker?.enforceCap?.({ provider: this.id });
    }

    /** @type {Record<string, any>} */
    const body = {
      model: this._model,
      max_tokens: options.maxTokens || DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content: String(prompt ?? '') }],
      stream: !!stream
    };
    if (systemPrompt) body.system = systemPrompt;

    // See OpenAICompatibleProvider for rationale on the combined timeout.
    const { signal: combinedSignal, cancel: cancelCombined } = combineSignalsWithTimeout(
      signal,
      DEFAULT_REQUEST_TIMEOUT_MS
    );

    let response;
    try {
      response = await this._fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': ANTHROPIC_VERSION
        },
        body: JSON.stringify(body),
        signal: combinedSignal
      });
    } catch (err) {
      cancelCombined();
      throw new AIProviderError(
        'NETWORK_ERROR',
        `Failed to reach Anthropic: ${redactSensitive(err.message)}`,
        { cause: err }
      );
    }

    if (!response.ok) {
      let errorMessage = `Anthropic returned HTTP ${response.status}`;
      try {
        const errBody = await response.json();
        if (errBody?.error?.message) errorMessage = redactSensitive(errBody.error.message);
      } catch {
        // body unreadable; use generic message
      }
      cancelCombined();
      throw new AIProviderError(_httpStatusToCode(response.status), errorMessage);
    }

    if (stream) {
      // _readStream owns its own idle timeout; the request-level timer's
      // job is finished once headers arrive.
      cancelCombined();
      return this._readStream(response, onToken, signal);
    }

    // Non-streaming: keep the request-level timeout AND the caller's abort
    // signal armed until the body is fully read — clearing them at the
    // header boundary let a stalled body hang response.json() forever.
    let parsed;
    try {
      parsed = await response.json();
    } catch (err) {
      if (combinedSignal?.aborted) {
        // Same classification as an abort during the fetch handshake.
        throw new AIProviderError(
          'NETWORK_ERROR',
          'Anthropic response body read timed out or was aborted',
          { cause: err }
        );
      }
      throw new AIProviderError('INVALID_RESPONSE', 'Anthropic returned non-JSON response', {
        cause: err
      });
    } finally {
      cancelCombined();
    }
    const text = (parsed.content || [])
      .filter((/** @type {any} */ c) => c.type === 'text')
      .map((/** @type {any} */ c) => c.text)
      .join('');
    const usage = parsed.usage || {};
    this._trackUsage(usage);
    const truncated = parsed.stop_reason === 'max_tokens';
    if (truncated) {
      const err = new AIProviderError(
        'OUTPUT_TRUNCATED',
        'Anthropic stopped because max_tokens was reached'
      );
      // Callers with a JSON-repair path can still salvage the partial output.
      err.partialText = text;
      throw err;
    }
    return { text, usage, truncated: false };
  }

  _trackUsage(/** @type {any} */ usage) {
    if (!this._costTracker) return;
    // Anthropic returns input_tokens / output_tokens (snake_case).
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    if (inputTokens === 0 && outputTokens === 0) return;
    this._costTracker
      .recordUsage({ provider: this.id, model: this._model, inputTokens, outputTokens })
      .catch((/** @type {any} */ err) => {
        // CostTracker logs the persist failure internally and bumps its
        // _persistFailureCount; enforceCap() will fail-closed on the next
        // call once the threshold is hit. We log here at error level so
        // the failure is visible even if the tracker's logger is silent.
        this._logger.error('[anthropic] cost tracker recordUsage failed', {
          inputTokens,
          outputTokens,
          error: err?.message || String(err)
        });
      });
  }

  async _readStream(
    /** @type {any} */ response,
    /** @type {any} */ onToken,
    /** @type {any} */ signal
  ) {
    const reader = response.body?.getReader?.();
    if (!reader) throw new AIProviderError('INVALID_RESPONSE', 'Anthropic stream had no body');
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let usage = {};
    let truncated = false;

    // Wire abort to reader.cancel() so the underlying network read terminates
    // immediately on consumer cancellation. Without this, reader.read()
    // continues draining bytes until the next chunk arrives, costing tokens
    // the user already abandoned and delaying connection cleanup.
    let abortListener = null;
    if (signal) {
      abortListener = () => {
        try {
          reader.cancel();
        } catch {
          /* defensive: cancel can throw if stream is already closed */
        }
      };
      if (signal.aborted) {
        abortListener();
      } else {
        signal.addEventListener('abort', abortListener, { once: true });
      }
    }

    // Idle watchdog: if no chunk arrives within STREAM_IDLE_TIMEOUT_MS we
    // force the reader to error out by canceling the underlying response.
    // Without this, a stalled server hangs reader.read() forever even when
    // the consumer signal hasn't fired.
    /** @type {ReturnType<typeof setTimeout>|null} */
    let idleTimer = null;
    let cancelled = false;
    let readFailed = false;
    const armWatchdog = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        cancelled = true;
        try {
          reader.cancel(new AIProviderError('STREAM_IDLE_TIMEOUT', 'Stream idle timeout exceeded'));
        } catch {
          /* ignore */
        }
      }, this._streamIdleTimeoutMs);
    };

    const handleEvent = (/** @type {any} */ evt) => {
      const dataLine = evt.split(/\r?\n/).find((/** @type {any} */ l) => l.startsWith('data:'));
      if (!dataLine) return;
      const json = dataLine.slice(5).trim();
      if (!json) return;
      let parsed;
      try {
        parsed = JSON.parse(json);
      } catch {
        return;
      }
      if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
        const tok = parsed.delta.text || '';
        fullText += tok;
        if (typeof onToken === 'function') onToken(tok);
      } else if (parsed.type === 'message_delta' && parsed.usage) {
        usage = { ...usage, ...parsed.usage };
        if (parsed.delta?.stop_reason === 'max_tokens') truncated = true;
      } else if (parsed.type === 'error' || parsed.error) {
        throw new AIProviderError(
          'PROVIDER_FAILED',
          redactSensitive(parsed.error?.message || parsed.message || 'Anthropic stream error')
        );
      }
    };

    try {
      armWatchdog();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        armWatchdog();
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || '';
        for (const evt of events) handleEvent(evt);
      }
      // Drain any final event the server flushed without a trailing blank
      // line. Anthropic emits message_delta (with usage) immediately before
      // message_stop; if both arrive in the same chunk and the server
      // doesn't terminate the final event with \r\n\r\n, the usage block
      // would otherwise be left in `buffer` and never recorded.
      buffer += decoder.decode();
      if (buffer.trim().length > 0) handleEvent(buffer);
    } catch (err) {
      // A mid-body connection reset rejects reader.read() with a raw
      // undici/DOM error (e.g. TypeError: terminated) — the only provider
      // error path outside the AIProviderError taxonomy. Unwrapped, it
      // bypasses ChatService's transient-failure fallback and surfaces the
      // raw message in the UI. tokensEmitted lets callers avoid falling
      // back after tokens already streamed (a second answer would be
      // appended to the partial one the user saw).
      readFailed = true;
      if (err?.name === 'AbortError' || err?.name === 'AIProviderError') {
        if (err.tokensEmitted === undefined) err.tokensEmitted = fullText.length > 0;
        throw err;
      }
      const wrapped = new AIProviderError(
        'NETWORK_ERROR',
        `Anthropic stream failed mid-read: ${redactSensitive(err?.message || String(err))}`,
        { cause: err }
      );
      wrapped.tokensEmitted = fullText.length > 0;
      throw wrapped;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (signal && abortListener) {
        try {
          signal.removeEventListener('abort', abortListener);
        } catch {
          /* defensive */
        }
      }
      if (readFailed) {
        // Leaving the loop via an exception (e.g. an in-band `error` event)
        // does not close the response body; cancel so the connection is
        // released now rather than when the reader is garbage-collected.
        try {
          await reader.cancel();
        } catch {
          /* already errored or closed */
        }
      }
      try {
        reader.releaseLock?.();
      } catch {
        /* releaseLock can throw if cancel() preceded it */
      }
      // Track usage in the finally so every exit path — success, idle
      // timeout, mid-read failure — records what was actually billed.
      // If usage is empty (very early abort) this no-ops.
      this._trackUsage(usage);
    }
    if (cancelled) {
      const idle = new AIProviderError(
        'STREAM_IDLE_TIMEOUT',
        'Anthropic stream idle timeout exceeded'
      );
      idle.tokensEmitted = fullText.length > 0;
      throw idle;
    }
    // Every token was already delivered via onToken, so a max_tokens stop is
    // a complete-but-truncated answer, not a failure: report it in the result
    // and let the caller decide how to surface it.
    return { text: fullText, usage, truncated };
  }
}

module.exports = { AnthropicProvider };
