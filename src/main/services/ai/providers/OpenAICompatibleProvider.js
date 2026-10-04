// @ts-check
'use strict';
const { AIProviderError } = require('../errors');
const {
  combineSignalsWithTimeout,
  redactSensitive,
  DEFAULT_REQUEST_TIMEOUT_MS
} = require('./_providerHelpers');
const { isAllowedProviderBaseUrl } = require('../providerBaseUrl');

const DEFAULT_MAX_TOKENS = 4096;
// Abort an in-flight stream if no chunk arrives within this window.
const STREAM_IDLE_TIMEOUT_MS = 60_000;

function _normalizeBase(/** @type {any} */ url) {
  if (!url) return '';
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function _httpStatusToCode(/** @type {any} */ status, /** @type {any} */ errBody) {
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 413) return 'CONTENT_TOO_LONG';
  if (status === 400) {
    const code = errBody?.error?.code;
    if (code === 'context_length_exceeded') return 'CONTENT_TOO_LONG';
  }
  if (status >= 500 && status < 600) return 'PROVIDER_FAILED';
  return 'PROVIDER_FAILED';
}

class OpenAICompatibleProvider {
  /** @param {{ getKey?: (...args: any[]) => any, model?: string, baseUrl?: string, displayName?: string, fetchFn?: any, costTracker?: any, streamIdleTimeoutMs?: number, logger?: any }} [deps] */
  constructor({
    getKey,
    model,
    baseUrl,
    displayName,
    fetchFn,
    costTracker,
    streamIdleTimeoutMs,
    logger
  } = {}) {
    if (typeof getKey !== 'function')
      throw new Error('OpenAICompatibleProvider: getKey function is required');
    this._getKey = getKey;
    this._model = model;
    // Last line of defense: a base URL outside the allow-list leaves the
    // provider unconfigured (ready() false, requests refused) even if every
    // upstream validation was bypassed, so the bearer key can never reach it.
    this._baseUrl = isAllowedProviderBaseUrl(baseUrl) ? _normalizeBase(baseUrl) : '';
    this._fetch = fetchFn || globalThis.fetch;
    this._costTracker = costTracker || null;
    this._logger = logger || { warn: () => {}, error: () => {} };
    this._streamIdleTimeoutMs =
      typeof streamIdleTimeoutMs === 'number' ? streamIdleTimeoutMs : STREAM_IDLE_TIMEOUT_MS;
    this._readyCache = false;
    this._refreshing = false;
    this.id = 'openaiCompatible';
    this.displayName = displayName || 'OpenAI / Custom';
    // See AnthropicProvider for rationale on pre-warming.
    this._warmReady();
  }

  _warmReady() {
    if (!this._baseUrl) return;
    try {
      const k = this._getKey();
      if (k && typeof k.then === 'function') this._refreshReadyAsync(k);
      else if (typeof k === 'string') this._readyCache = k.length > 0;
      else this._readyCache = Boolean(k);
    } catch {
      /* default false stays */
    }
  }

  // Sync to match AIRouter.choose(); see AnthropicProvider for the rationale.
  ready() {
    if (!this._baseUrl) return false;
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
    // Always terminate the chain so a runtime hiccup in the .finally branch
    // can't escape as an unhandled rejection. See AnthropicProvider for the
    // matching rationale.
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
    return this._chatCompletions({ prompt, options, stream: false });
  }

  async suggest(/** @type {any} */ prompt, options = {}) {
    return this.analyze(prompt, options);
  }

  /** @param {Record<string, any>} [payload] */
  async chatStream(payload = {}) {
    const { prompt, systemPrompt, signal, onToken, options = {} } = payload;
    return this._chatCompletions({ prompt, systemPrompt, options, signal, onToken, stream: true });
  }

  /**
   * @param {{
   *   prompt?: string,
   *   systemPrompt?: string,
   *   options?: { maxTokens?: number, jsonMode?: boolean },
   *   signal?: AbortSignal,
   *   onToken?: (t: string) => void,
   *   stream?: boolean
   * }} args
   */
  async _chatCompletions({ prompt, systemPrompt, options = {}, signal, onToken, stream }) {
    const key = await this._getKey();
    if (!key) throw new AIProviderError('AUTH_FAILED', 'OpenAI-compatible API key not configured');
    if (!this._baseUrl)
      throw new AIProviderError('AUTH_FAILED', 'OpenAI-compatible base URL not configured');

    // Atomic variant queues through the cost tracker's single-flight chain so
    // concurrent callers serialize and observe each other's committed
    // recordUsage — preventing a multi-call race past the cap.
    if (typeof this._costTracker?.enforceCapAtomic === 'function') {
      await this._costTracker.enforceCapAtomic({ provider: this.id });
    } else {
      this._costTracker?.enforceCap?.({ provider: this.id });
    }

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: String(systemPrompt) });
    messages.push({ role: 'user', content: String(prompt ?? '') });

    /** @type {Record<string, any>} */
    const body = {
      model: this._model,
      messages,
      stream: !!stream,
      max_tokens: options.maxTokens || DEFAULT_MAX_TOKENS
    };
    // Ask the server to emit a final usage chunk so streaming calls can be
    // cost-tracked. Without this, OpenAI streams emit no usage block and
    // every streaming chat call bypasses CostTracker — silently breaching
    // monthly spend caps. Compatible providers that don't recognize
    // stream_options ignore it gracefully (it lives under the OpenAI
    // request schema).
    if (stream) body.stream_options = { include_usage: true };
    if (options.jsonMode) body.response_format = { type: 'json_object' };

    const url = `${this._baseUrl}/chat/completions`;
    // Combine the caller's signal with a request-level timeout so a server
    // that opens the connection but never sends headers can't hang the
    // analysis queue forever. Streaming responses get their own STREAM_IDLE
    // timeout once the headers arrive — the timeout here only governs the
    // initial HTTP handshake plus, for non-streaming, the full response.
    const { signal: combinedSignal, cancel: cancelCombined } = combineSignalsWithTimeout(
      signal,
      DEFAULT_REQUEST_TIMEOUT_MS
    );

    let response;
    try {
      response = await this._fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`
        },
        body: JSON.stringify(body),
        signal: combinedSignal
      });
    } catch (err) {
      cancelCombined();
      throw new AIProviderError(
        'NETWORK_ERROR',
        `Failed to reach ${this._baseUrl}: ${redactSensitive(err.message)}`,
        { cause: err }
      );
    }

    if (!response.ok) {
      /** @type {Record<string, any>} */
      let errBody = {};
      let errMessage = `HTTP ${response.status}`;
      try {
        errBody = await response.json();
        if (errBody?.error?.message) errMessage = redactSensitive(errBody.error.message);
      } catch {
        // body unreadable; use generic message
      }
      cancelCombined();
      throw new AIProviderError(_httpStatusToCode(response.status, errBody), errMessage);
    }

    if (stream) {
      // _readStream owns its own STREAM_IDLE_TIMEOUT_MS; the request-level
      // timer's job is finished once headers arrive.
      cancelCombined();
      return this._readStream(response, onToken, signal);
    }

    // Non-streaming: keep the request-level timeout AND the caller's abort
    // signal armed until the body is fully read. Clearing them at the
    // header boundary let a stalled body (half-open connection, proxy
    // hiccup) hang response.json() forever with no way to cancel.
    let parsed;
    try {
      parsed = await response.json();
    } catch (err) {
      if (combinedSignal?.aborted) {
        // Same classification as an abort during the fetch handshake.
        throw new AIProviderError(
          'NETWORK_ERROR',
          'Provider response body read timed out or was aborted',
          { cause: err }
        );
      }
      throw new AIProviderError('INVALID_RESPONSE', 'Provider returned non-JSON response', {
        cause: err
      });
    } finally {
      cancelCombined();
    }
    const text = parsed.choices?.[0]?.message?.content || '';
    const usage = parsed.usage || {};
    this._trackUsage(usage);
    const truncated = parsed.choices?.[0]?.finish_reason === 'length';
    if (truncated) {
      const err = new AIProviderError(
        'OUTPUT_TRUNCATED',
        'Provider stopped because max_tokens was reached'
      );
      // Callers with a JSON-repair path can still salvage the partial output.
      err.partialText = text;
      throw err;
    }
    return { text, usage, truncated: false };
  }

  _trackUsage(/** @type {any} */ usage) {
    if (!this._costTracker) return;
    // OpenAI shape: prompt_tokens / completion_tokens (snake_case).
    const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
    const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
    if (inputTokens === 0 && outputTokens === 0) return;
    this._costTracker
      .recordUsage({ provider: this.id, model: this._model, inputTokens, outputTokens })
      .catch((/** @type {any} */ err) => {
        // CostTracker logs the persist failure internally and bumps its
        // _persistFailureCount; enforceCap() will fail-closed on the next
        // call once the threshold is hit.
        this._logger.error('[openaiCompatible] cost tracker recordUsage failed', {
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
    if (!reader) throw new AIProviderError('INVALID_RESPONSE', 'Stream had no body');
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let usage = {};
    let truncated = false;

    // Wire abort to reader.cancel() so consumer cancellation actually
    // terminates the network read.
    let abortListener = null;
    if (signal) {
      abortListener = () => {
        try {
          reader.cancel();
        } catch {
          /* defensive */
        }
      };
      if (signal.aborted) {
        abortListener();
      } else {
        signal.addEventListener('abort', abortListener, { once: true });
      }
    }

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
      const payload = dataLine.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      const tok = parsed.choices?.[0]?.delta?.content;
      if (typeof tok === 'string' && tok.length > 0) {
        fullText += tok;
        if (typeof onToken === 'function') onToken(tok);
      }
      if (parsed.choices?.[0]?.finish_reason === 'length') truncated = true;
      if (parsed.error) {
        throw new AIProviderError(
          'PROVIDER_FAILED',
          redactSensitive(parsed.error?.message || 'Provider stream error')
        );
      }
      // OpenAI emits the usage block in the final chunk when
      // stream_options.include_usage is set on the request.
      if (parsed.usage) usage = { ...usage, ...parsed.usage };
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
      // Drain a trailing event without a final blank-line terminator. Some
      // OpenAI-compatible servers (Ollama, certain proxies) flush the
      // [DONE] marker or a final usage chunk without the expected \r\n\r\n,
      // which would otherwise leave usage in `buffer` and never recorded.
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
        `Stream failed mid-read: ${redactSensitive(err?.message || String(err))}`,
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
        // Leaving the loop via an exception (e.g. an in-band `error` chunk)
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
        /* releaseLock can throw after cancel() */
      }
      // Track usage in the finally so every exit path — success, idle
      // timeout, mid-read failure — records what was actually billed.
      // If usage is empty (very early abort) this no-ops.
      this._trackUsage(usage);
    }
    if (cancelled) {
      const idle = new AIProviderError('STREAM_IDLE_TIMEOUT', 'Stream idle timeout exceeded');
      idle.tokensEmitted = fullText.length > 0;
      throw idle;
    }
    // Every token was already delivered via onToken, so a finish_reason of
    // `length` is a complete-but-truncated answer, not a failure: report it in
    // the result and let the caller decide how to surface it.
    return { text: fullText, usage, truncated };
  }
}

module.exports = { OpenAICompatibleProvider };
