// @ts-check
/**
 * Shared utilities for normalizing member/file path and ID across duplicate resolution
 * and search modal components. Centralizes path extraction logic to prevent fix drift.
 */

/**
 * Extract path from a member object (file, search result, duplicate member).
 * Tries common property names used across the codebase.
 *
 * @param {Record<string, any>} member - Member object (may have path, filePath, metadata.path, originalPath)
 * @returns {string} Resolved path or empty string
 */
function getMemberPath(member) {
  if (!member) return '';
  return member.path || member.filePath || member.metadata?.path || member.originalPath || '';
}

/**
 * Extract ID from a member, falling back to path or provided fallback.
 *
 * @param {Record<string, any>} member - Member object
 * @param {string} [fallback] - Fallback value when no id/path found
 * @returns {string} Member ID
 */
function getMemberId(member, fallback = '') {
  if (!member) return fallback;
  return member.id || getMemberPath(member) || fallback;
}

/**
 * Basename extraction that works with both forward and backslash separators.
 * Safe for use in shared (main + renderer) context.
 *
 * @param {string} p - Path string
 * @returns {string} Basename or empty string
 */
function safeBasename(p) {
  if (typeof p !== 'string') return '';
  const normalized = p.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

/**
 * Parent-directory portion of a path, working with both `/` and `\` separators.
 * Returns '' when there is no meaningful parent (no separator, or a leading
 * separator only). Safe for use in shared (main + renderer) context.
 *
 * @param {string} p - Path string
 * @returns {string} Directory portion or empty string
 */
function safeDirname(p) {
  if (typeof p !== 'string') return '';
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx > 0 ? p.slice(0, idx) : '';
}

/**
 * Normalize a duplicate-group member to a consistent shape (id, path, name, size).
 *
 * @param {Record<string, any>} member - Raw member from duplicate API
 * @param {number} index - Member index within group
 * @param {number} groupIndex - Group index
 * @returns {Record<string, any>} Normalized member with id, path, name, size
 */
function normalizeDuplicateMember(member, index, groupIndex) {
  const path = getMemberPath(member);
  const id = getMemberId(member, `dup:${groupIndex}:${index}`);
  const rawSize = member.size ?? member.fileSize ?? member.metadata?.size;
  const parsedSize = Number(rawSize);
  return {
    ...member,
    id,
    path,
    name: member.name || member.fileName || member.metadata?.name || safeBasename(path || id),
    size: Number.isFinite(parsedSize) && parsedSize >= 0 ? parsedSize : null
  };
}

module.exports = {
  getMemberPath,
  getMemberId,
  safeBasename,
  safeDirname,
  normalizeDuplicateMember
};
