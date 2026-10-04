// @ts-check
/**
 * JSON Repair Utility for LLM Responses
 *
 * Handles common JSON malformation issues from LLM outputs:
 * - Trailing commas
 * - Unescaped characters
 * - Truncated JSON
 * - Markdown code fences
 * - Extra text before/after JSON
 *
 * @module utils/jsonRepair
 */

const { createLogger } = require('../../shared/logger');

const logger = createLogger('JSONRepair');
const DEFAULT_PREVIEW_HEAD = 500;
const DEFAULT_PREVIEW_TAIL = 200;

/**
 * @param {any} rawResponse
 * @param {{ previewHead?: number, previewTail?: number }} [options]
 */
function buildResponsePreview(rawResponse, options = {}) {
  const safe = typeof rawResponse === 'string' ? rawResponse : String(rawResponse || '');
  const head =
    typeof options.previewHead === 'number' && options.previewHead >= 0
      ? options.previewHead
      : DEFAULT_PREVIEW_HEAD;
  const tail =
    typeof options.previewTail === 'number' && options.previewTail >= 0
      ? options.previewTail
      : DEFAULT_PREVIEW_TAIL;
  return {
    responseLength: safe.length,
    responsePreview: safe.substring(0, head),
    responseEnd: safe.substring(Math.max(0, safe.length - tail))
  };
}

/**
 * HIGH FIX: Extract balanced JSON object or array using brace counting
 * This properly handles cases where there's text before/after JSON, or
 * multiple JSON objects in the response (extracts the first complete one).
 *
 * @param {string} text - Text potentially containing JSON
 * @returns {string|null} Extracted JSON string or null if not found
 */
function extractBalancedJson(text) {
  if (!text || typeof text !== 'string') return null;

  // Find the first { or [ that might start a JSON structure
  let startIndex = -1;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' || text[i] === '[') {
      startIndex = i;
      break;
    }
  }

  if (startIndex === -1) return null;

  // Count braces and brackets separately to avoid conflating {} with []
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startIndex; i < text.length; i++) {
    const char = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') {
      braceDepth++;
    } else if (char === '}') {
      braceDepth--;
    } else if (char === '[') {
      bracketDepth++;
    } else if (char === ']') {
      bracketDepth--;
    }

    if (braceDepth === 0 && bracketDepth === 0) {
      // Found matching close
      return text.slice(startIndex, i + 1);
    }
  }

  // No complete balanced JSON found, return everything from start (might be truncated)
  // This allows the repair functions to attempt to fix truncated JSON
  return text.slice(startIndex);
}

/**
 * Strip a leading ```json / ``` fence even when no closing fence exists (e.g. truncated LLM output).
 * Also strips a trailing ``` when the response is otherwise a single fenced block.
 * @param {string} text
 * @returns {string}
 */
function stripLeadingFence(text) {
  if (!text || typeof text !== 'string') return text;
  const m = text.match(/^\s*```(?:json)?\s*\n?([\s\S]*?)(?:\n?```)?\s*$/);
  return m ? m[1] : text;
}

/**
 * Attempts to extract and parse JSON from potentially malformed LLM output
 * @param {string} rawResponse - The raw response from the LLM
 * @param {Object} defaultValue - Default value to return if all parsing fails
 * @param {any} rawResponse
 * @param {any} [defaultValue]
 * @param {{ logOnFailure?: boolean, source?: string, fileName?: string, model?: string, previewHead?: number, previewTail?: number }} [options]
 * @returns {any} Parsed JSON object or default value
 */
function extractAndParseJSON(rawResponse, defaultValue = null, options = {}) {
  if (!rawResponse || typeof rawResponse !== 'string') {
    return defaultValue;
  }

  const fenceStripped = stripLeadingFence(rawResponse);

  // Step 1: Try direct parse first (including after leading-fence normalization)
  try {
    return JSON.parse(fenceStripped);
  } catch (e) {
    logger.debug('[JSONRepair] Direct parse failed, attempting repair', {
      error: e.message,
      responseLength: rawResponse.length
    });
  }

  // Step 2: Extract JSON from markdown code fences. Previously we took the
  // FIRST ```…``` match, which meant if the model wrote a chatty intro
  // fence (e.g. explanatory ```text``` or a partial ```json``` echoing the
  // schema) before the real answer, we'd parse the intro and ignore the
  // real payload. Walk every fence and return the first one that parses;
  // fall back to the first json-flavoured fence as `cleaned` so downstream
  // repair still has a reasonable candidate when nothing parses outright.
  let cleaned = rawResponse;
  const fencePattern = /```(json)?\s*([\s\S]*?)```/gi;
  let firstJsonFence = null;
  let fenceMatch;
  while ((fenceMatch = fencePattern.exec(rawResponse)) !== null) {
    const candidate = (fenceMatch[2] || '').trim();
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Not parseable on its own — keep the first json-tagged fence (or
      // first fence at all) as a repair hint and keep scanning.
      if (!firstJsonFence) firstJsonFence = candidate;
      if (fenceMatch[1] && firstJsonFence !== candidate) firstJsonFence = candidate;
    }
  }
  if (firstJsonFence) {
    cleaned = firstJsonFence;
  }

  // Step 3: Extract JSON object/array using balanced brace matching
  // from first '{' to last '}' which could include invalid content between JSON objects
  const extractedJson = extractBalancedJson(rawResponse);
  if (extractedJson) {
    cleaned = extractedJson;
  }

  // Step 4: Apply common repairs
  cleaned = repairJSON(cleaned);

  // Step 5: Final parse attempt
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const shouldLog = options.logOnFailure !== false;
    if (shouldLog) {
      const preview = buildResponsePreview(rawResponse, options);
      logger.warn('[JSONRepair] All repair attempts failed', {
        error: e.message,
        originalLength: rawResponse.length,
        cleanedLength: cleaned.length,
        cleanedPreview: cleaned.substring(0, 300),
        source: options.source,
        fileName: options.fileName,
        model: options.model,
        ...preview
      });
    }
    return defaultValue;
  }
}

/**
 * Apply common JSON repairs
 * @param {string} json - Potentially malformed JSON string
 * @returns {string} Repaired JSON string
 */
function repairJSON(json) {
  if (!json || typeof json !== 'string') return json;

  let repaired = json;

  // Remove control characters except newlines (\x0A), carriage returns (\x0D), and tabs (\x09)
  // Using RegExp constructor to avoid ESLint no-control-regex warning
  // eslint-disable-next-line no-control-regex
  const controlCharRegex = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
  repaired = repaired.replace(controlCharRegex, '');

  repaired = repaired.replace(/,\s*([}\]])/g, '$1');

  // Match: "value" followed by whitespace then "key":
  repaired = repaired.replace(/("|\d|true|false|null)\s*\n\s*"/g, '$1,\n"');

  // This regex finds strings and escapes any unescaped newlines within them
  // for environments that don't support ES2018 lookbehind assertions
  repaired = repaired.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (match, content) => {
    // Escape any actual newlines that aren't already escaped.
    // Count consecutive backslashes before the character: if even (0, 2, ...),
    // the newline itself is unescaped and needs escaping; if odd, it's already
    // escaped by the preceding backslash.
    let fixed = '';
    for (let i = 0; i < content.length; i++) {
      const char = content[i];
      if (char === '\n' || char === '\r' || char === '\t') {
        // Count consecutive backslashes immediately before this character
        let backslashCount = 0;
        let j = i - 1;
        while (j >= 0 && content[j] === '\\') {
          backslashCount++;
          j--;
        }
        // Even number of backslashes means newline is unescaped
        if (backslashCount % 2 === 0) {
          if (char === '\n') fixed += '\\n';
          else if (char === '\r') fixed += '\\r';
          else if (char === '\t') fixed += '\\t';
        } else {
          fixed += char;
        }
      } else {
        fixed += char;
      }
    }
    return `"${fixed}"`;
  });

  // Count structural braces/brackets only (skip those inside JSON strings)
  let openBraces = 0,
    closeBraces = 0,
    openBrackets = 0,
    closeBrackets = 0;
  let inString = false;
  {
    let escaped = false;
    for (let i = 0; i < repaired.length; i++) {
      const ch = repaired[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === '{') openBraces++;
        else if (ch === '}') closeBraces++;
        else if (ch === '[') openBrackets++;
        else if (ch === ']') closeBrackets++;
      }
    }
  }

  // If the JSON ended abruptly inside a string, close the string first
  if (inString) {
    repaired += '"';
  }

  // Add missing closing brackets/braces
  if (openBrackets > closeBrackets) {
    repaired += ']'.repeat(openBrackets - closeBrackets);
  }

  if (openBraces > closeBraces) {
    repaired += '}'.repeat(openBraces - closeBraces);
  }

  // Remove any text after the final closing brace/bracket
  const lastBrace = repaired.lastIndexOf('}');
  const lastBracket = repaired.lastIndexOf(']');
  const lastClose = Math.max(lastBrace, lastBracket);
  if (lastClose > 0 && lastClose < repaired.length - 1) {
    repaired = repaired.substring(0, lastClose + 1);
  }

  return repaired;
}

/**
 * Validate that a parsed object has expected structure for document analysis
 * @param {any} parsed - Parsed JSON object
 * @returns {Record<string, any> | null} Validated and sanitized object, or null if invalid
 */
function validateDocumentAnalysis(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  // Ensure required fields exist with defaults
  return {
    date: typeof parsed.date === 'string' ? parsed.date : undefined,
    project: typeof parsed.project === 'string' ? parsed.project : undefined,
    purpose: typeof parsed.purpose === 'string' ? parsed.purpose : undefined,
    category: typeof parsed.category === 'string' ? parsed.category : 'document',
    keywords: Array.isArray(parsed.keywords)
      ? parsed.keywords.filter((/** @type {any} */ k) => typeof k === 'string' && k.length > 0)
      : [],
    confidence:
      typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 100
        ? parsed.confidence
        : 70,
    suggestedName: typeof parsed.suggestedName === 'string' ? parsed.suggestedName : undefined
  };
}

module.exports = {
  extractAndParseJSON,
  buildResponsePreview,
  repairJSON,
  validateDocumentAnalysis
};
