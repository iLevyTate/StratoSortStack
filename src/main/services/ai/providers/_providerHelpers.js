// @ts-check
'use strict';
/**
 * Shared helpers for cloud AI provider implementations
 * (AnthropicProvider, OpenAICompatibleProvider).
 *
 * - `combineSignalsWithTimeout` produces an AbortSignal that fires if either
 *   the caller-provided signal aborts OR the timeout elapses. Required
 *   because Node's global `fetch` has no built-in request-level timeout: a
 *   server that opens the connection and never sends headers will hang the
 *   analysis queue indefinitely.
 * - `redactSensitive` strips Bearer tokens and known API-key shapes from
 *   provider-returned error strings before they get logged or attached to
 *   thrown errors. Some providers echo the Authorization header back in
 *   their 401 / 403 responses, which would otherwise land in user-visible
 *   logs and crash dumps.
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

function combineSignalsWithTimeout(
  /** @type {any} */ callerSignal,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
) {
  const controller = new AbortController();
  let timer = null;
  const onCallerAbort = () => controller.abort(callerSignal?.reason);

  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  const cancel = () => {
    if (timer) clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
  };

  return { signal: controller.signal, cancel };
}

// Match Bearer tokens, OpenAI-style sk-..., Anthropic-style sk-ant-..., and
// generic "key: <val>" / "token: <val>" patterns. Replace the secret portion
// with a fixed redaction marker; preserve enough surrounding context that the
// error message remains useful for debugging.
const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._\-+/=]+/gi,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /(api[_-]?key|x-api-key|authorization)\s*[:=]\s*[^\s,;"']+/gi
];

function redactSensitive(/** @type {any} */ value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  let out = value;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '<redacted>');
  }
  return out;
}

module.exports = {
  DEFAULT_REQUEST_TIMEOUT_MS,
  combineSignalsWithTimeout,
  redactSensitive
};
