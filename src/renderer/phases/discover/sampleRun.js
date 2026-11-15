// @ts-check
/**
 * Sample first: before a large batch, offer to analyze a few files and show
 * where each would go, so vague Smart Folders show up after minutes instead
 * of after the whole run.
 *
 * The sample uses the normal analysis run (origin 'sample') and the same
 * ranking Organize uses (suggestions.getBatchSuggestions, then
 * resolveOrganizeDestination), so what the sample shows is what Organize
 * would do. Nothing is moved. Sample results are ordinary results: the rest
 * of the batch does not analyze those files again.
 *
 * The offer is remembered per Smart Folder definition set
 * (getFolderDefinitionsHash: names, descriptions and paths). Once the user
 * has seen a sample, or chosen to skip it, for a set, it is not offered again
 * until a folder's name, description or path changes.
 *
 * @module discover/sampleRun
 */

import { getFolderDefinitionsHash } from '../../../shared/smartFolderDefinitions';
import { checkFolderDescription } from '../../../shared/smartFolderDescriptionCheck';
import {
  findSmartFolderForFile,
  findSmartFolderForLabel
} from '../../../shared/categoryFolderMatching';
import {
  countDestinationFolders,
  isUncategorizedBucket
} from '../../utils/smartFolderDestinations';
import { toCanonicalPath } from '../../utils/canonicalPath';
import { RANKING_OPTIONS, toSuggestionFile } from '../organize/useOrganizeSuggestions';
import {
  describeRouting,
  normalizeEngineEntry,
  resolveOrganizeDestination,
  routingScore
} from '../organize/organizeDestination';

/** A batch of this many files or more gets the sample offer. */
export const SAMPLE_OFFER_MIN_FILES = 20;
/** How many files the sample analyzes. */
export const SAMPLE_SIZE = 5;

/**
 * @typedef {Object} SampleRow
 * @property {string} path
 * @property {string} name
 * @property {boolean} analyzed
 * @property {string|null} folder - Smart Folder name, null for Uncategorized
 * @property {number|null} score - 0..1, only where it measures the folder's fit
 * @property {string} reason
 */

/**
 * The files in `files` with a path, once each (by canonical path).
 * @param {any[]} files
 * @returns {any[]}
 */
export function uniqueFiles(files) {
  const seen = new Set();
  const out = [];
  for (const file of Array.isArray(files) ? files : []) {
    const key = toCanonicalPath(file?.path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

/**
 * Whether to offer a sample before analyzing `files`.
 *
 * @param {{ files: any[], smartFolders: any, reviewedHash: string|null|undefined, isAnalyzing: boolean }} input
 * @returns {boolean}
 */
export function shouldOfferSample({ files, smartFolders, reviewedHash, isAnalyzing }) {
  // Files added during a run wait for it; the offer would interrupt nothing.
  if (isAnalyzing) return false;
  if (uniqueFiles(files).length < SAMPLE_OFFER_MIN_FILES) return false;
  // With only the Uncategorized catch-all there is nothing to try.
  if (countDestinationFolders(smartFolders) === 0) return false;
  const hash = getFolderDefinitionsHash(smartFolders);
  return Boolean(hash) && hash !== reviewedHash;
}

/**
 * @param {any} file
 * @returns {string} lowercase extension without the dot, '' when none
 */
function extensionOf(file) {
  const fromField = typeof file?.extension === 'string' ? file.extension.trim() : '';
  if (fromField) return fromField.replace(/^\./, '').toLowerCase();
  const name =
    (typeof file?.name === 'string' && file.name) ||
    String(file?.path || '')
      .split(/[\\/]/)
      .pop() ||
    '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Up to `size` files spread across the file types in the batch: one of each
 * type in turn, the most common types first, so a batch of PDFs, photos and
 * spreadsheets samples all three.
 *
 * @param {any[]} files
 * @param {number} [size]
 * @returns {any[]}
 */
export function pickSampleFiles(files, size = SAMPLE_SIZE) {
  /** @type {Map<string, any[]>} */
  const byType = new Map();
  for (const file of uniqueFiles(files)) {
    const ext = extensionOf(file);
    const group = byType.get(ext);
    if (group) group.push(file);
    else byType.set(ext, [file]);
  }
  const groups = [...byType.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([, group]) => group);
  const picked = [];
  for (let round = 0; picked.length < size; round += 1) {
    let tookAny = false;
    for (const group of groups) {
      if (picked.length >= size) break;
      if (round < group.length) {
        picked.push(group[round]);
        tookAny = true;
      }
    }
    if (!tookAny) break;
  }
  return picked;
}

/**
 * How many Smart Folders (not the Uncategorized catch-all) have a
 * description hint from checkFolderDescription.
 *
 * @param {any} smartFolders
 * @returns {number}
 */
export function countFoldersWithHints(smartFolders) {
  const folders = Array.isArray(smartFolders) ? smartFolders.filter(Boolean) : [];
  let count = 0;
  for (const folder of folders) {
    if (isUncategorizedBucket(folder)) continue;
    const issues = checkFolderDescription({
      name: folder.name,
      description: folder.description,
      otherFolders: folders.filter((other) => other !== folder)
    });
    if (issues.length > 0) count += 1;
  }
  return count;
}

/**
 * @param {any} file
 * @returns {string}
 */
function displayName(file) {
  return (
    (typeof file?.name === 'string' && file.name) ||
    String(file?.path || '')
      .split(/[\\/]/)
      .pop() ||
    ''
  );
}

/**
 * Where each sample file would go and why, the way Organize decides it: the
 * suggestion engine's ranking first, name matching when it has nothing.
 *
 * @param {{ files: any[], smartFolders: any[], getBatchSuggestions?: Function|null }} input
 *   files: the sample files merged with their analysis results
 * @returns {Promise<SampleRow[]>}
 */
export async function rankSampleFiles({ files, smartFolders, getBatchSuggestions }) {
  const folders = Array.isArray(smartFolders) ? smartFolders : [];
  const list = Array.isArray(files) ? files : [];
  const analyzed = list.filter((file) => file?.analysis && !file?.error);

  /** @type {Map<string, any>} */
  const engineByPath = new Map();
  if (analyzed.length > 0 && typeof getBatchSuggestions === 'function') {
    try {
      const response = await getBatchSuggestions(analyzed.map(toSuggestionFile), RANKING_OPTIONS);
      const groups = response?.success && Array.isArray(response.groups) ? response.groups : [];
      for (const group of groups) {
        for (const entry of Array.isArray(group?.files) ? group.files : []) {
          const key = toCanonicalPath(entry?.path);
          const normalized = normalizeEngineEntry(entry);
          if (key && normalized) engineByPath.set(key, normalized);
        }
      }
    } catch {
      // The ranking is optional here as in Organize: name matching decides.
    }
  }

  const byLabel = (/** @type {any} */ label) =>
    typeof label === 'string' && label.trim() ? findSmartFolderForLabel(label, folders) : null;
  const byFile = (/** @type {any} */ file) => findSmartFolderForFile(file, folders);

  return list.map((file) => {
    const path = String(file?.path || '');
    const name = displayName(file);
    if (!file?.analysis || file?.error) {
      /** @type {SampleRow} */
      const notAnalyzed = {
        path,
        name,
        analyzed: false,
        folder: null,
        score: null,
        reason: 'This file could not be analyzed.'
      };
      return notAnalyzed;
    }
    const destination = resolveOrganizeDestination({
      fileWithEdits: file,
      edits: null,
      engineSuggestion: engineByPath.get(toCanonicalPath(path)) || null,
      smartFolders: folders,
      findSmartFolderForCategory: byLabel,
      findSmartFolderForFile: byFile
    });
    return {
      path,
      name,
      analyzed: true,
      folder: destination.folder?.name || null,
      score: routingScore(destination),
      reason:
        describeRouting(destination, file.analysis.category) || 'No Smart Folder fits this file.'
    };
  });
}
