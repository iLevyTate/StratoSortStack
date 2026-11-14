// @ts-check
/**
 * Advice for when a folder to sort and a Smart Folder (where sorted files go)
 * overlap, or one Smart Folder sits inside another. Nothing here blocks a
 * choice: overlap can be deliberate, so the user is told what will happen.
 *
 * Paths compare by folder boundary ("/Out2" is not inside "/Out") and, on
 * Windows and macOS, without regard to case, the way their default volumes
 * treat names. Advice only: never use this to decide what a file operation
 * does.
 */
import { isMac, isWindows } from './platform';
import { isUncategorizedFolder } from '../../shared/uncategorizedFolder';

/**
 * @typedef {{ caseInsensitive?: boolean }} OverlapOptions
 * @typedef {{ name?: string, path?: string, category?: string }} FolderLike
 * @typedef {{ kind: 'is' | 'inside', folder: FolderLike }} OneFolderOverlap
 * @typedef {{ kind: 'contains', folders: FolderLike[] }} HeldFoldersOverlap
 * @typedef {OneFolderOverlap | HeldFoldersOverlap} SourceOverlap
 */

const DEFAULT_CASE_INSENSITIVE = isWindows || isMac;
const NAMES_LISTED = 3;

/**
 * Comparison key for a folder path: forward slashes, composed Unicode, no
 * trailing slash (a root stays '/' or 'c:/'), lowercased when case is ignored.
 * @param {unknown} p
 * @param {OverlapOptions} [opts]
 * @returns {string}
 */
export function folderKey(p, { caseInsensitive = DEFAULT_CASE_INSENSITIVE } = {}) {
  if (typeof p !== 'string' || !p.trim()) return '';
  let key = p.trim().replace(/[\\/]+/g, '/');
  try {
    key = key.normalize('NFC');
  } catch {
    /* keep as-is */
  }
  if (key.length > 1 && key.endsWith('/') && !/^[A-Za-z]:\/$/.test(key)) {
    key = key.slice(0, -1);
  }
  return caseInsensitive ? key.toLowerCase() : key;
}

/**
 * @param {string} childKey
 * @param {string} parentKey
 */
function keyIsSameOrInside(childKey, parentKey) {
  if (!childKey || !parentKey) return false;
  if (childKey === parentKey) return true;
  const prefix = parentKey.endsWith('/') ? parentKey : `${parentKey}/`;
  return childKey.startsWith(prefix);
}

/**
 * True when `child` is `parent` or lies anywhere below it.
 * @param {unknown} child
 * @param {unknown} parent
 * @param {OverlapOptions} [opts]
 */
export function isSameOrInside(child, parent, opts) {
  return keyIsSameOrInside(folderKey(child, opts), folderKey(parent, opts));
}

/**
 * @param {unknown} folders
 * @param {OverlapOptions} [opts]
 * @returns {{ folder: FolderLike, key: string }[]}
 */
function keyedFolders(folders, opts) {
  if (!Array.isArray(folders)) return [];
  return folders
    .filter((folder) => folder && typeof folder === 'object')
    .map((folder) => ({ folder, key: folderKey(folder.path, opts) }))
    .filter((entry) => entry.key);
}

/**
 * Every Smart Folder that sits strictly inside another one, paired with the
 * folder that holds it most closely (A > B > C gives A/B and B/C, not A/C).
 * @param {unknown} folders
 * @param {OverlapOptions} [opts]
 * @returns {{ outer: FolderLike, inner: FolderLike }[]}
 */
export function findNestedDestinations(folders, opts) {
  const entries = keyedFolders(folders, opts);
  /** @type {{ outer: FolderLike, inner: FolderLike }[]} */
  const pairs = [];
  for (const inner of entries) {
    let closest = null;
    for (const outer of entries) {
      if (outer.key === inner.key || !keyIsSameOrInside(inner.key, outer.key)) continue;
      if (!closest || outer.key.length > closest.key.length) closest = outer;
    }
    if (closest) pairs.push({ outer: closest.folder, inner: inner.folder });
  }
  return pairs;
}

/**
 * How a folder picked for sorting relates to the Smart Folders: it is one
 * ('is'), it lies inside one ('inside', the closest), or it holds some
 * ('contains'). Null when they do not overlap.
 * @param {unknown} sourceDir
 * @param {unknown} folders
 * @param {OverlapOptions} [opts]
 * @returns {SourceOverlap | null}
 */
export function describeSourceOverlap(sourceDir, folders, opts) {
  const sourceKey = folderKey(sourceDir, opts);
  if (!sourceKey) return null;
  const entries = keyedFolders(folders, opts);

  const same = entries.find((entry) => entry.key === sourceKey);
  if (same) return { kind: 'is', folder: same.folder };

  let closest = null;
  for (const entry of entries) {
    if (!keyIsSameOrInside(sourceKey, entry.key)) continue;
    if (!closest || entry.key.length > closest.key.length) closest = entry;
  }
  if (closest) return { kind: 'inside', folder: closest.folder };

  const held = entries.filter((entry) => keyIsSameOrInside(entry.key, sourceKey));
  if (held.length > 0) return { kind: 'contains', folders: held.map((entry) => entry.folder) };
  return null;
}

/**
 * @param {FolderLike} folder
 */
const quoted = (folder) => `"${folder?.name || 'Unnamed'}"`;

/**
 * The plain-language warning for a describeSourceOverlap result, or null.
 * @param {SourceOverlap | null | undefined} result
 * @returns {string | null}
 */
export function sourceOverlapMessage(result) {
  if (!result) return null;
  if (result.kind === 'contains') {
    const count = result.folders.length;
    const listed = result.folders.slice(0, NAMES_LISTED).map(quoted);
    const names =
      count > NAMES_LISTED
        ? `${listed.join(', ')} and ${count - NAMES_LISTED} more`
        : listed.join(', ');
    const lead =
      count === 1
        ? `This folder holds your Smart Folder ${names}.`
        : `This folder holds ${count} of your Smart Folders (${names}).`;
    return `${lead} Files already sorted there will be analyzed and sorted again.`;
  }
  const name = quoted(result.folder);
  if (result.kind === 'inside') {
    return `This folder is inside your Smart Folder ${name}. Files that belong in ${name} will move out of this folder to the top of ${name}.`;
  }
  if (isUncategorizedFolder(result.folder)) {
    return `${name} is where files that fit nowhere else go. Files that fit nowhere else will stay in this folder.`;
  }
  return `${name} is one of your Smart Folders, where sorted files go. Files that belong there stay in this folder.`;
}
