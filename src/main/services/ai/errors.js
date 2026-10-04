// @ts-check
'use strict';

const AI_ERROR_CODES = Object.freeze([
  'AUTH_FAILED',
  'RATE_LIMITED',
  'NETWORK_ERROR',
  'CONTENT_TOO_LONG',
  'BUDGET_EXCEEDED',
  'PROVIDER_DISABLED',
  'NO_PROVIDER_READY',
  'FOLDER_OVERRIDE_UNAVAILABLE',
  'OPERATION_OVERRIDE_UNAVAILABLE',
  'PROVIDER_FAILED',
  'INVALID_RESPONSE',
  'STREAM_IDLE_TIMEOUT',
  'OUTPUT_TRUNCATED'
]);

const _CODE_SET = new Set(AI_ERROR_CODES);

class AIProviderError extends Error {
  constructor(
    /** @type {any} */ code,
    /** @type {any} */ message,
    /** @type {{ cause?: unknown }} */ options = {}
  ) {
    if (!_CODE_SET.has(code)) {
      throw new Error(`AIProviderError: unknown error code ${code}`);
    }
    super(message, options);
    this.name = 'AIProviderError';
    this.code = code;
    /** @type {boolean|undefined} — set by providers when mid-stream failure occurred after tokens were emitted */
    this.tokensEmitted = undefined;
    /** @type {string|undefined} — OUTPUT_TRUNCATED only: the text generated before the token cap hit */
    this.partialText = undefined;
    if (options.cause) this.cause = options.cause;
  }

  // Sanitized JSON form — never include the message (may contain a key).
  toJSON() {
    return { name: this.name, code: this.code };
  }
}

module.exports = { AIProviderError, AI_ERROR_CODES };
