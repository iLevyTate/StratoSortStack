// @ts-check
import { toCanonicalPath } from './canonicalPath';
import { safeBasename } from './pathUtils';

export function pathsMatch(/** @type {any} */ a, /** @type {any} */ b) {
  if (!a || !b) return false;
  return toCanonicalPath(a) === toCanonicalPath(b);
}

export function fileNameMatches(/** @type {any} */ path, /** @type {any} */ fileName) {
  if (!path || !fileName) return false;
  return safeBasename(path).toLowerCase() === fileName.toLowerCase();
}

function collectFilePaths(/** @type {any} */ file) {
  if (!file || typeof file !== 'object') return [];
  return [
    file.path,
    file.id,
    file.originalPath,
    file.currentPath,
    file.newPath,
    file.destination,
    file.source
  ].filter(Boolean);
}

export function fileMatchesFocusTarget(
  /** @type {any} */ file,
  /** @type {any} */ filePath,
  /** @type {any} */ fileName
) {
  const candidates = collectFilePaths(file);
  if (filePath && candidates.some((p) => pathsMatch(p, filePath))) {
    return true;
  }
  if (fileName && candidates.some((p) => fileNameMatches(p, fileName))) {
    return true;
  }
  return false;
}

export function findFileIndexByPathOrName(
  /** @type {any} */ files,
  /** @type {any} */ filePath,
  /** @type {any} */ fileName
) {
  if (!Array.isArray(files)) return -1;
  return files.findIndex((file) => fileMatchesFocusTarget(file, filePath, fileName));
}

export function findFileByPathOrName(
  /** @type {any} */ files,
  /** @type {any} */ filePath,
  /** @type {any} */ fileName
) {
  const index = findFileIndexByPathOrName(files, filePath, fileName);
  return index >= 0 ? files[index] : null;
}
