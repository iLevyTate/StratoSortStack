// @ts-check
/**
 * Safe JSON Operations Utility
 *
 * Provides safe JSON parsing and stringifying operations with fallbacks.
 * For file-based JSON operations, use atomicFile.js instead.
 * For LLM output parsing, use jsonRepair.js instead.
 *
 * @module shared/safeJsonOps
 */

// Reviver that strips prototype pollution keys
/**
 * @param {string} key
 * @param {any} value
 * @returns {any}
 */
function _safeReviver(key, value) {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    return undefined;
  }
  return value;
}

/**
 * Safely parse JSON string with fallback
 *
 * @param {string} text - JSON string to parse
 * @param {*} fallback - Value to return on parse failure (default: null)
 * @returns {*} Parsed value or fallback
 *
 * @example
 * const data = safeParse(jsonString, {});
 * const items = safeParse(itemsJson, []);
 */
function safeParse(text, fallback = null) {
  if (text === null || text === undefined) {
    return fallback;
  }

  try {
    return JSON.parse(text, _safeReviver);
  } catch {
    return fallback;
  }
}

/**
 * Safely stringify value with fallback
 *
 * @param {*} value - Value to stringify
 * @param {string|null} [fallback] - Value to return on stringify failure (default: null)
 * @param {{ pretty?: boolean }} [options] - Options
 * @returns {string|null} JSON string or fallback
 *
 * @example
 * const json = safeStringify(data);
 * const prettyJson = safeStringify(data, null, { pretty: true });
 */
function safeStringify(value, fallback = null, options = {}) {
  const { pretty = false } = options;

  try {
    return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  } catch {
    return fallback;
  }
}

/**
 * Parse each line of a multi-line string as JSON
 * Returns array of successfully parsed objects, skipping invalid lines
 *
 * @param {string} text - Multi-line JSON string (JSONL format)
 * @returns {Array<any>} Array of parsed objects
 *
 * @example
 * const logs = parseJsonLines(logFileContent);
 */
function parseJsonLines(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const PARSE_FAILED = Symbol('parse_failed');
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line, _safeReviver);
      } catch {
        return PARSE_FAILED;
      }
    })
    .filter((obj) => obj !== PARSE_FAILED);
}

/**
 * Try to parse JSON, returning result and success status
 * Useful when you need to know if parsing failed without using fallback
 *
 * @param {string} text - JSON string to parse
 * @returns {{success: boolean, value: *, error: Error|null}}
 *
 * @example
 * const { success, value, error } = tryParse(jsonString);
 * if (!success) {
 *   logger.warn('Parse failed:', error.message);
 * }
 */
function tryParse(text) {
  if (text === null || text === undefined) {
    return { success: false, value: null, error: new Error('Input is null or undefined') };
  }

  try {
    const value = JSON.parse(text, _safeReviver);
    return { success: true, value, error: null };
  } catch (error) {
    return { success: false, value: null, error };
  }
}

/**
 * Deep clone an object using JSON serialization
 * Note: This will not preserve functions, undefined values, or circular references
 *
 * @param {*} value - Value to clone
 * @param {*} fallback - Value to return on failure
 * @returns {*} Cloned value or fallback
 */
function jsonClone(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value), _safeReviver);
  } catch {
    return fallback;
  }
}

// structuredClone is ~3× faster than JSON round-trips and preserves Maps, Sets,
// Dates, and typed arrays. It's globally available in Node 17+, but jsdom test
// shims occasionally omit it — fall back to JSON so tests behave identically.
// Mirrors `structuredClone` semantics: throws on non-cloneable input. Use
// `jsonClone` instead when you want a fallback value on failure.
/**
 * @param {any} value
 * @returns {any}
 */
function deepClone(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value), _safeReviver);
}

/**
 * Canonical JSON with sorted object keys. Used for settings snapshots and backups.
 * @param {any} value
 * @param {string|number} [indent=0]
 * @returns {string}
 */
function stableStringify(value, indent = 0) {
  return JSON.stringify(
    value,
    (key, val) => {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        return Object.keys(val)
          .sort()
          .reduce((/** @type {Record<string, any>} */ acc, k) => {
            acc[k] = val[k];
            return acc;
          }, {});
      }
      return val;
    },
    indent
  );
}

module.exports = {
  safeParse,
  safeStringify,
  parseJsonLines,
  tryParse,
  jsonClone,
  deepClone,
  stableStringify
};
