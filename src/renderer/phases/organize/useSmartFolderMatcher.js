// @ts-check
/**
 * useSmartFolderMatcher Hook
 *
 * Smart folder matching with caching.
 *
 * @module organize/useSmartFolderMatcher
 */

import { useMemo } from 'react';
import {
  findSmartFolderForFile,
  findSmartFolderForLabel
} from '../../../shared/categoryFolderMatching';
import { toCanonicalPath } from '../../utils/canonicalPath';

/**
 * Pre-normalize a folder list into a lookup table once per smartFolders
 * change. Used by both hook variants below so we only pay the cost once.
 */
function buildNormalizedFolders(/** @type {any} */ smartFolders) {
  const safeFolders = Array.isArray(smartFolders) ? smartFolders : [];
  return safeFolders.map((folder) => {
    const baseName = folder?.name?.toLowerCase()?.trim() || '';
    return {
      original: folder,
      normalized: baseName,
      variants: [
        baseName,
        baseName.replace(/s$/, ''),
        `${baseName}s`,
        baseName.replace(/\s+/g, ''),
        baseName.replace(/\s+/g, '-'),
        baseName.replace(/\s+/g, '_')
      ]
    };
  });
}

/**
 * Resolve a single string (category / vendor / etc.) to a folder using the
 * existing exact + variant matching logic. Pure helper, no caching — the
 * hooks below provide caching.
 */
function findFolderForString(/** @type {any} */ normalizedFolders, /** @type {any} */ raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const folders = normalizedFolders.map((/** @type {any} */ entry) => entry.original);
  return findSmartFolderForLabel(raw, folders);
}

/**
 * Hook for smart folder matching with caching, keyed by category string.
 * @param {any[]} smartFolders - Smart folders array
 * @returns {Function} (category: string) => folder | null
 */
export function useSmartFolderMatcher(smartFolders) {
  return useMemo(() => {
    const normalizedFolders = buildNormalizedFolders(smartFolders);
    const folderCache = new Map();

    return (/** @type {any} */ category) => {
      if (!category) return null;
      if (folderCache.has(category)) return folderCache.get(category);
      const matched = findFolderForString(normalizedFolders, category);
      folderCache.set(category, matched);
      return matched;
    };
  }, [smartFolders]);
}

/**
 * Per-file variant of the matcher. Walks the file's analysis fields in the
 * fallback order shared with `deriveEntityKey` so that a folder named after
 * a file's vendor / organization still resolves even if the file's
 * `category` doesn't match the folder name.
 *
 * @param {any[]} smartFolders - Smart folders array
 * @returns {Function} (file: object) => folder | null
 */
export function useSmartFolderMatcherForFile(smartFolders) {
  return useMemo(() => {
    const folders = buildNormalizedFolders(smartFolders).map(
      (/** @type {any} */ entry) => entry.original
    );
    /** @type {Map<string, { signature: any[], result: any }>} */
    const fileCache = new Map();

    return (/** @type {any} */ file) => {
      const cacheKey = toCanonicalPath(file?.path) || file?.id || null;
      if (!cacheKey) return findSmartFolderForFile(file, folders);

      // Only the analysis object (or the file itself when it carries the
      // analysis fields inline), extension and name feed the match, so a
      // cached result stays valid as long as those references are unchanged.
      const signature = [
        file?.analysis && typeof file.analysis === 'object' ? file.analysis : file,
        file?.extension,
        file?.name
      ];
      const cached = fileCache.get(cacheKey);
      if (cached && cached.signature.every((value, index) => value === signature[index])) {
        return cached.result;
      }
      const result = findSmartFolderForFile(file, folders);
      fileCache.set(cacheKey, { signature, result });
      return result;
    };
  }, [smartFolders]);
}
