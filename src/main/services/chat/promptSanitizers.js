// @ts-check
/**
 * Prompt-injection sanitizers for chat retrieval context.
 *
 * Every piece of document-derived text (extracted content AND metadata)
 * passes through here before being concatenated into the LLM prompt. They
 * defend against three classes of attack a malicious document (or an
 * attacker who tricks the user into importing one) could otherwise mount:
 *
 *   1. Fence escape: embedded text contains the literal string
 *      `</document_content>` to close our delimiter early and issue new
 *      instructions. We replace any occurrence of the fence tags (any case
 *      variant) with a neutralized marker so the closing tag only appears
 *      where WE emit it. Because ChatService also uses a per-request nonce
 *      on the fence, a pre-crafted document can't guess the exact closing
 *      tag even if the static replacement somehow missed a variant.
 *
 *   2. Invisible-character injection: zero-width, bidi-override, and
 *      private-use characters make displayed text differ from what the LLM
 *      reads. We strip the well-known offenders so what an auditor sees in
 *      the prompt is what the model actually gets.
 *
 *   3. Newline-smuggling in single-line metadata (Name/Path/Entity/etc.):
 *      these are emitted as `Key: value` lines, so an embedded newline lets
 *      attacker text pose as a NEW metadata row or a new system
 *      instruction. We collapse all whitespace runs to a single space in
 *      metadata fields.
 */

const PROMPT_FENCE_PATTERN = /<\/?\s*document_content\b[^>]*>/gi;
const INVISIBLE_INJECTION_CHARS =
  // zero-width space/joiner/non-joiner + bidi + invisible separators
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_EXCEPT_NEWLINE = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

function sanitizeExtractedForPrompt(/** @type {any} */ raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  return raw
    .replace(PROMPT_FENCE_PATTERN, '[fence-stripped]')
    .replace(INVISIBLE_INJECTION_CHARS, '')
    .replace(CONTROL_CHARS_EXCEPT_NEWLINE, ' ');
}

function sanitizeMetadataForPrompt(/** @type {any} */ raw, maxChars = 200) {
  if (raw == null) return '';
  const str = typeof raw === 'string' ? raw : String(raw);
  const normalized = str
    .replace(PROMPT_FENCE_PATTERN, '[fence-stripped]')
    .replace(INVISIBLE_INJECTION_CHARS, '')
    // In metadata (single-line key:value) collapse ALL whitespace to a
    // single space so newlines can't smuggle a fake metadata row or an
    // injected "System:" / "User:" prefix.
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}…`;
}

module.exports = {
  sanitizeExtractedForPrompt,
  sanitizeMetadataForPrompt,
  PROMPT_FENCE_PATTERN,
  INVISIBLE_INJECTION_CHARS,
  CONTROL_CHARS_EXCEPT_NEWLINE
};
