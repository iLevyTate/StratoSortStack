// @ts-check
/**
 * Where Organize sends a file, and why (decision D1, 2026-09-29).
 *
 * The grid card and the commit both call `resolveOrganizeDestination`, so
 * the move always matches what the card showed. Precedence:
 *
 *   1. the user's choice (an edit on the card, or one kept from an earlier
 *      visit as `analysis.userCategory`)
 *   2. the suggestion engine's ranked primary (embeddings, learned
 *      placements, feedback memory)
 *   3. name matching on the analysis label and entities (fallback 2)
 *
 * The caller falls back to Uncategorized when all three come up empty.
 *
 * When the engine says the file needs review (no Smart Folder is a
 * confident match), name matching does not run: the engine already checked
 * the names, and the broader matcher here could still pick a folder the file
 * does not belong in. The file goes to the default folder, or nowhere, until
 * the user picks one.
 *
 * @module organize/organizeDestination
 */

import { isGenericBucketFolder } from '../../../shared/categoryFolderMatching';
import { toCanonicalPath } from '../../utils/canonicalPath';

/**
 * @typedef {Object} EngineCandidate
 * @property {string} folder
 * @property {string} path
 * @property {string|null} folderId
 * @property {number|null} confidence - 0..1
 * @property {string|null} source - engine source tag (semantic, user_pattern, ...)
 */

/**
 * @typedef {Object} EngineSuggestionExtra
 * @property {string|null} explanation
 * @property {EngineCandidate[]} alternatives
 * @property {boolean} [needsReview] - no Smart Folder is a confident match
 * @property {string|null} [reviewReason] - no_match, weak_match or ambiguous
 * @property {string|null} [reviewClosest] - name of the closest Smart Folder
 *   when the file needs review (the "closest was …" folder), else absent
 */

/**
 * @typedef {Omit<EngineCandidate, 'folder'|'path'> & { folder: string|null, path: string|null } & EngineSuggestionExtra} EngineSuggestion
 */

/**
 * @typedef {Object} OrganizeDestination
 * @property {any|null} folder - the smart folder, or null for "use Uncategorized"
 * @property {'user'|'engine'|'name'|'review'|'none'} source - 'review': the
 *   engine found no confident match; `folder` is the default folder or null
 * @property {EngineSuggestion|null} engine - the engine's ranking for this file, if any
 */

/** @param {any} value @returns {number|null} */
function toUnitConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n > 1 ? Math.min(1, n / 100) : n;
}

/**
 * @param {any} raw
 * @returns {EngineCandidate|null} a smart-folder candidate with a path, else null
 */
function toCandidate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.isSmartFolder === false || raw.unresolvedSmartFolder) return null;
  if (typeof raw.folder !== 'string' || !raw.folder.trim()) return null;
  if (typeof raw.path !== 'string' || !raw.path.trim()) return null;
  return {
    folder: raw.folder,
    path: raw.path,
    folderId: typeof raw.folderId === 'string' ? raw.folderId : null,
    confidence: toUnitConfidence(raw.confidence ?? raw.score),
    source: typeof raw.source === 'string' ? raw.source : null
  };
}

/**
 * Normalize one `getBatchSuggestions` group entry into the renderer's shape.
 * Only smart folders with a path survive: the engine can also return
 * unresolved or non-smart-folder candidates, which Organize cannot target.
 *
 * @param {any} entry
 * @returns {EngineSuggestion|null}
 */
export function normalizeEngineEntry(entry) {
  const needsReview = entry?.needsReview === true || entry?.suggestion?.needsReview === true;
  const primary = toCandidate(entry?.suggestion);
  // A file that needs review may have no folder at all (no default folder).
  if (!primary && !needsReview) return null;
  const confidence = toUnitConfidence(entry?.confidence) ?? primary?.confidence ?? null;
  const seen = new Set(primary ? [toCanonicalPath(primary.path)] : []);
  /** @type {EngineCandidate[]} */
  const alternatives = [];
  for (const raw of Array.isArray(entry?.alternatives) ? entry.alternatives : []) {
    const candidate = toCandidate(raw);
    if (!candidate) continue;
    const key = toCanonicalPath(candidate.path);
    if (seen.has(key)) continue;
    seen.add(key);
    alternatives.push(candidate);
  }
  const reviewReason = entry?.routingDecision?.reason || entry?.suggestion?.review?.reason || null;
  const closest = entry?.routingDecision?.best?.folder ?? entry?.suggestion?.review?.best?.folder;
  const reviewClosest = typeof closest === 'string' && closest.trim() ? closest.trim() : null;
  return {
    ...(primary || { folder: null, path: null, folderId: null, source: null }),
    confidence,
    explanation:
      typeof entry?.explanation === 'string' && entry.explanation.trim()
        ? entry.explanation.trim()
        : null,
    alternatives,
    ...(needsReview ? { needsReview: true, reviewReason, reviewClosest } : {})
  };
}

/**
 * The live smart folder an engine candidate names, matched by id and then by
 * path. A candidate for a folder that has since been removed resolves to null.
 *
 * @param {{ folderId?: string|null, path?: string|null }|null|undefined} candidate
 * @param {any[]} smartFolders
 * @returns {any|null}
 */
export function findFolderForCandidate(candidate, smartFolders) {
  if (!candidate || !Array.isArray(smartFolders)) return null;
  if (candidate.folderId) {
    const byId = smartFolders.find((f) => f?.id && f.id === candidate.folderId);
    if (byId) return byId;
  }
  const wanted = toCanonicalPath(candidate.path);
  if (!wanted) return null;
  return smartFolders.find((f) => f?.path && toCanonicalPath(f.path) === wanted) || null;
}

/**
 * @param {Object} params
 * @param {any} params.fileWithEdits - file with card edits applied
 * @param {Record<string, any>|null|undefined} params.edits - this file's card edits
 * @param {EngineSuggestion|null|undefined} params.engineSuggestion
 * @param {any[]} params.smartFolders
 * @param {(label: any) => any} params.findSmartFolderForCategory
 * @param {((file: any) => any)|null|undefined} [params.findSmartFolderForFile]
 * @returns {OrganizeDestination}
 */
export function resolveOrganizeDestination({
  fileWithEdits,
  edits,
  engineSuggestion,
  smartFolders,
  findSmartFolderForCategory,
  findSmartFolderForFile
}) {
  const analysis = fileWithEdits?.analysis || {};
  const engine = engineSuggestion || null;

  const userCategory = edits?.category || analysis.userCategory;
  if (userCategory) {
    const chosen = findSmartFolderForCategory(userCategory);
    if (chosen) return { folder: chosen, source: 'user', engine };
  }

  const engineFolder = findFolderForCandidate(engine, smartFolders);
  if (engine?.needsReview) {
    return { folder: engineFolder, source: 'review', engine };
  }
  if (engineFolder && !isGenericBucketFolder(engineFolder)) {
    return { folder: engineFolder, source: 'engine', engine };
  }

  // Fallback 2: name matching. Generic buckets (Uncategorized, Documents)
  // from the label lose to a per-file match: .stl belongs in "3D Prints".
  const categoryFolder = findSmartFolderForCategory(analysis.category);
  const fileFolder =
    typeof findSmartFolderForFile === 'function' ? findSmartFolderForFile(fileWithEdits) : null;
  const named =
    fileFolder && (!categoryFolder || isGenericBucketFolder(categoryFolder))
      ? fileFolder
      : categoryFolder;
  if (named) return { folder: named, source: 'name', engine };

  if (engineFolder) return { folder: engineFolder, source: 'engine', engine };
  return { folder: null, source: 'none', engine };
}

/**
 * The suggestion a batch-organize op carries, so main can record a
 * correction when the file lands elsewhere. Only an engine pick counts: a
 * name match is derived from the label, which main already compares against.
 *
 * @param {OrganizeDestination} destination
 * @param {any[]} smartFolders
 * @returns {{ folder: string, path?: string, source: string } | undefined}
 */
export function suggestionForOperation(destination, smartFolders) {
  // A file that needs review had no engine pick to correct.
  if (destination?.engine?.needsReview) return undefined;
  const engineFolder = findFolderForCandidate(destination?.engine, smartFolders);
  if (!engineFolder || isGenericBucketFolder(engineFolder)) return undefined;
  return {
    folder: engineFolder.name,
    ...(typeof engineFolder.path === 'string' && engineFolder.path
      ? { path: engineFolder.path }
      : {}),
    source: 'engine'
  };
}

/**
 * Why a file goes where `resolveOrganizeDestination` sends it, in the words
 * the Organize card shows. The sample run before a large batch uses it too,
 * so both say the same thing about the same file.
 *
 * @param {OrganizeDestination|null|undefined} routing
 * @param {unknown} [category] - the label the card shows (edit or analysis)
 * @returns {string|null}
 */
export function describeRouting(routing, category) {
  if (!routing) return null;
  const engine = routing.engine;
  if (routing.source === 'review') {
    return engine?.explanation || 'No Smart Folder matched this file.';
  }
  if (routing.source === 'engine' && engine) {
    return engine.explanation || 'Ranked by what the file contains';
  }
  if (routing.source === 'user') {
    return engine?.folder && !engine.needsReview && engine.folder !== routing.folder?.name
      ? `Your choice (suggested: ${engine.folder})`
      : 'Your choice';
  }
  if (routing.source === 'name') {
    // A name match is either the analysis label or the file's own name/type.
    const fromLabel =
      typeof category === 'string' &&
      category.trim().toLowerCase() ===
        String(routing.folder?.name || '')
          .trim()
          .toLowerCase();
    return fromLabel
      ? 'Matched by the label the analysis gave this file'
      : 'Matched by folder name';
  }
  return null;
}

/**
 * The engine's fit for the folder it picked, 0..1, or null where a number
 * would not measure the folder: a name match, the user's own pick, or the
 * catch-all default.
 *
 * @param {OrganizeDestination|null|undefined} routing
 * @returns {number|null}
 */
export function routingScore(routing) {
  if (routing?.source !== 'engine' || !routing.engine) return null;
  if (routing.engine.source === 'default') return null;
  const value = routing.engine.confidence;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Stale results (decision, 2026-11-15): an explicit warning with a one-click
 * refresh, not a silent automatic one.
 *
 * Every analysis is stamped with the Smart Folder definitions it was made
 * under (`analysis.smartFolderHash`, see shared/smartFolderDefinitions). When
 * the definitions change, Organize already re-ranks every file through the
 * suggestion engine with the new folders (useOrganizeSuggestions), so an
 * engine pick is current. What can still be old is the fallback: the label
 * the analysis picked from the old folders (source 'name'), or no folder at
 * all from that label (source 'none'). Those files are stale. While the
 * re-rank is still running, files waiting for it count too.
 *
 * A stale file is not moved unnoticed: Organize lists them with one button
 * that analyzes them again (the existing Reanalyze), and Move asks first.
 * Refreshing automatically would mean analyzing again without asking, which
 * on a large batch takes as long as the first run did.
 *
 * Analyses made before the stamp existed carry no hash and are not flagged.
 * The user's own folder choice is never stale. Auto-organize (downloads and
 * watched folders, in main) needs no check: it analyzes each new file with
 * the folders current at that moment, and the analysis cache is keyed on the
 * whole folder descriptions, so an edit never returns an old pick.
 *
 * @param {any} file - the file as Organize lists it (with `analysis`)
 * @param {OrganizeDestination|null|undefined} destination
 * @param {string} currentHash - getFolderDefinitionsHash of the current folders
 * @returns {boolean}
 */
export function isStaleDestination(file, destination, currentHash) {
  const stamped = file?.analysis?.smartFolderHash;
  if (typeof stamped !== 'string' || !stamped || !currentHash) return false;
  if (stamped === currentHash) return false;
  return destination?.source === 'name' || destination?.source === 'none';
}

/**
 * The files among `files` whose destination is stale (see isStaleDestination).
 *
 * @param {any[]} files
 * @param {(file: any) => OrganizeDestination} resolveDestination
 * @param {string} currentHash
 * @returns {any[]}
 */
export function findStaleFiles(files, resolveDestination, currentHash) {
  if (!currentHash || !Array.isArray(files) || typeof resolveDestination !== 'function') return [];
  return files.filter((file) => {
    const stamped = file?.analysis?.smartFolderHash;
    // Only a file stamped with other definitions needs its destination worked out.
    if (typeof stamped !== 'string' || !stamped || stamped === currentHash) return false;
    return isStaleDestination(file, resolveDestination(file), currentHash);
  });
}
