// @ts-check
/**
 * Privacy-oriented redaction for user-shareable exports (logs, analysis history, chat, etc.).
 * Stricter than runtime logging sanitization: extra sensitive keys and inline secret patterns.
 */

const { sanitizeLogData } = require('./logger');

/**
 * Keys to strip entirely on export. Substring (not anchored) match so
 * camelCase / mixed variants — `authToken`, `bearerToken`, `accessToken`,
 * `clientSecret`, `sessionKey`, `refreshToken`, `cookieHeader`, `authHeader`,
 * `huggingFaceToken`, `mcpToken`, `xApiKey`, `idToken` — are caught the same
 * way the runtime logger catches them. Anchored matching here was strictly
 * looser than the logger's pattern: an export thus leaked secrets that
 * runtime logs already redact, which is the wrong failure direction for a
 * "stricter" pipeline.
 */
const EXPORT_SENSITIVE_KEY_PATTERN =
  /(token|password|passwd|secret|apikey|api[_-]?key|authorization|auth[_-]?header|credential|priv(ate)?[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?key|sessionid|session_id|cookie|set-cookie|csrf|xsrf|otp|pin|ssn|client[_-]?secret|id[_-]?token|jwt|bearer)/i;

/**
 * Remove common token shapes from free-form text (JWT, Bearer, API-style prefixes).
 * @param {string} str
 * @returns {string}
 */
function redactInlineSecrets(str) {
  if (typeof str !== 'string' || str.length === 0) {
    return str;
  }
  let s = str;
  s = s.replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[REDACTED_JWT]');
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, 'Bearer [REDACTED]');
  s = s.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]');
  s = s.replace(/\bsk-(?:live|proj|test)-[A-Za-z0-9]{10,}\b/gi, '[REDACTED]');
  s = s.replace(/\bsk-[A-Za-z0-9]{10,}\b/g, '[REDACTED]');
  return s;
}

/**
 * Deep redaction for exported JSON-like structures and log lines.
 * @param {unknown} data
 * @returns {unknown}
 */
function deepSanitizeForExport(data) {
  if (typeof data === 'string') {
    // Redact inline secrets BEFORE path redaction. `sanitizeLogData` rewrites
    // path-shaped substrings to `[REDACTED_PATH]/basename`; a secret whose
    // own character set spans `/` (notably `Bearer <token>`, whose pattern
    // allows `/`) gets split at the separator by that rewrite, destroying the
    // `\b…\b` anchoring `redactInlineSecrets` needs and leaking the token.
    // Secrets-first is strictly safer: path redaction only removes text, so it
    // can never expose a secret the inline pass still has to catch.
    return sanitizeLogData(redactInlineSecrets(data));
  }

  if (data === null || typeof data !== 'object') {
    return data;
  }

  if (data instanceof Error) {
    const errData = /** @type {Record<string, any>} */ (/** @type {any} */ (data));
    return deepSanitizeForExport({
      name: data.name,
      message: data.message,
      stack: data.stack,
      ...(errData.code ? { code: errData.code } : {})
    });
  }

  if (Array.isArray(data)) {
    return data.map((item) => deepSanitizeForExport(item));
  }

  /** @type {Record<string, any>} */
  const sanitized = {};
  for (const [key, value] of Object.entries(data)) {
    if (EXPORT_SENSITIVE_KEY_PATTERN.test(key)) {
      sanitized[key] = '[REDACTED]';
    } else if (key === 'stack' && typeof value === 'string') {
      sanitized[key] = deepSanitizeForExport(value);
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = deepSanitizeForExport(value);
    } else if (typeof value === 'string') {
      sanitized[key] = deepSanitizeForExport(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Redact a full exported document (e.g. markdown) as a single string.
 * @param {string} text
 * @returns {string}
 */
function sanitizeExportText(text) {
  return /** @type {string} */ (deepSanitizeForExport(text));
}

module.exports = {
  EXPORT_SENSITIVE_KEY_PATTERN,
  redactInlineSecrets,
  deepSanitizeForExport,
  sanitizeExportText
};
