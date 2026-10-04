// @ts-check
/**
 * Graph path utilities for UnifiedSearchModal
 * Pure functions for path normalization and metadata extraction
 *
 * @module search/utils/graphPathUtils
 */

import { safeBasename } from '../../../../shared/memberPathUtils';

export function normalizeGraphPathKey(/** @type {any} */ filePath) {
  if (typeof filePath !== 'string') return '';
  const normalized = filePath.trim().replace(/[\\/]+/g, '/');
  if (!normalized) return '';
  return /^[A-Za-z]:/.test(filePath) || filePath.includes('\\')
    ? normalized.toLowerCase()
    : normalized;
}

export function extractPathFromSemanticId(/** @type {any} */ value) {
  if (typeof value !== 'string') return '';
  const stripped = value.replace(/^(file|image):/i, '').trim();
  if (!stripped) return '';
  return /^[A-Za-z]:[\\/]/.test(stripped) || stripped.startsWith('/') || /[\\/]/.test(stripped)
    ? stripped
    : '';
}

export function toMetadataObject(/** @type {any} */ value) {
  if (!value || typeof value !== 'object') return {};
  if (value.metadata && typeof value.metadata === 'object') return value.metadata;
  return value;
}

export function getMetadataPath(/** @type {any} */ value, fallbackId = '') {
  const metadata = toMetadataObject(value);
  const directPath =
    typeof metadata.path === 'string' && metadata.path.trim()
      ? metadata.path.trim()
      : typeof metadata.filePath === 'string' && metadata.filePath.trim()
        ? metadata.filePath.trim()
        : '';
  if (directPath) return directPath;

  const id =
    fallbackId ||
    (typeof value?.id === 'string' && value.id.trim() ? value.id.trim() : '') ||
    (typeof metadata.id === 'string' ? metadata.id.trim() : '');
  return extractPathFromSemanticId(id);
}

export function getMetadataName(/** @type {any} */ value, fallbackPath = '', fallbackId = '') {
  const metadata = toMetadataObject(value);
  const directName =
    typeof metadata.name === 'string' && metadata.name.trim()
      ? metadata.name.trim()
      : typeof metadata.fileName === 'string' && metadata.fileName.trim()
        ? metadata.fileName.trim()
        : '';
  if (directName) return directName;

  const resolvedPath = fallbackPath || getMetadataPath(value, fallbackId);
  if (resolvedPath) {
    const base = safeBasename(resolvedPath);
    if (base) return base;
  }

  const pathFromId = extractPathFromSemanticId(fallbackId);
  const idBase = safeBasename(pathFromId || fallbackId);
  return idBase || fallbackId || 'Unknown';
}

/**
 * Dedup key for graph nodes: use file path for file nodes, id for everything else
 */
export function nodeDeduplicationKey(/** @type {any} */ n) {
  return n.data?.path && n.data?.kind === 'file'
    ? normalizeGraphPathKey(n.data.path) || n.id
    : n.id;
}
