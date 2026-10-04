// @ts-check
/**
 * Category → smart-folder resolution shared by main and renderer.
 *
 * Handles naming-convention artifacts such as `Nature_17803333378895`
 * (category-subject) so files route to the configured `Nature` folder instead
 * of surfacing spurious folder names in Organize.
 *
 * @module shared/categoryFolderMatching
 */

const { namesAreEquivalent, canonicalizeFolderName } = require('./smartFolderNameValidation');

/** Trailing separator + 10+ digit token (category-subject / message-id suffix). */
const CATEGORY_SUBJECT_SUFFIX_RE = /(?:[_\-\s]+)\d{10,}$/;

/** The built-in catch-all every uncategorized file already routes to. */
const DEFAULT_CATEGORY_NAME = 'Uncategorized';

/**
 * True when a label is the built-in default catch-all ("Uncategorized").
 * Used to keep it out of *new* folder recommendations: it already exists as the
 * default bucket, so proposing it as a new themed folder is meaningless.
 *
 * @param {string} label
 * @returns {boolean}
 */
function isDefaultCategoryName(label) {
  return (
    String(label || '')
      .trim()
      .toLowerCase() === DEFAULT_CATEGORY_NAME.toLowerCase()
  );
}

/**
 * Smart folders users can deliberately pick in Organize.
 * Excludes the built-in Uncategorized catch-all — unmatched files already
 * route there automatically when no description/name match succeeds.
 *
 * @param {any[]} smartFolders
 * @returns {any[]}
 */
function getSelectableSmartFolders(smartFolders) {
  return (Array.isArray(smartFolders) ? smartFolders : []).filter(
    (folder) => folder?.name && !isDefaultCategoryName(folder.name)
  );
}

/**
 * @param {string} label
 * @returns {boolean}
 */
function hasCategorySubjectSuffix(label) {
  return CATEGORY_SUBJECT_SUFFIX_RE.test(String(label || '').trim());
}

/**
 * Strip a trailing numeric subject token produced by category-subject naming.
 * `Nature_17803333378895` → `Nature`. Leaves short numeric tails (e.g. `_2024`).
 *
 * @param {string} label
 * @returns {string}
 */
function stripCategorySubjectSuffix(label) {
  const raw = String(label || '').trim();
  if (!raw) return raw;
  const stripped = raw.replace(CATEGORY_SUBJECT_SUFFIX_RE, '').trim();
  return stripped || raw;
}

/**
 * Score folder names when collapsing equivalent duplicates. Higher wins.
 * Penalizes category-subject suffix artifacts so `Nature` beats `Nature_<id>`.
 *
 * @param {string} name
 * @returns {number}
 */
function scoreFolderNameForDedup(name) {
  const raw = String(name || '').trim();
  if (!raw) return Number.NEGATIVE_INFINITY;
  let score = raw.length;
  if (hasCategorySubjectSuffix(raw)) {
    score -= 1000;
  }
  return score;
}

/** @param {string} value */
function canon(value) {
  return canonicalizeFolderName(value);
}

/**
 * @param {string} str
 * @param {number} idx
 */
function isWordBoundary(str, idx) {
  return idx >= str.length || str.charAt(idx) === ' ';
}

/** @param {string} raw */
function buildLabelVariants(raw) {
  const normalized = raw.toLowerCase().trim();
  return [
    normalized,
    normalized.replace(/s$/, ''),
    `${normalized}s`,
    normalized.replace(/\s+/g, ''),
    normalized.replace(/\s+/g, '-'),
    normalized.replace(/\s+/g, '_')
  ];
}

/**
 * Conservative plural stem so "budget" matches "budgets" without eating
 * short words ("this") or ss-endings ("business").
 * @param {string} token
 * @returns {string}
 */
function stemToken(token) {
  if (token.length <= 4) return token;
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (/(?:sses|shes|ches|xes)$/.test(token)) return token.slice(0, -2);
  if (token.endsWith('ss')) return token;
  if (token.endsWith('s')) return token.slice(0, -1);
  return token;
}

/**
 * Tokenize a label/description into lowercase alphanumeric stems (len >= 2).
 * @param {any} value
 * @returns {string[]}
 */
function tokenizeSemanticText(value) {
  if (!value) return [];
  return String(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length >= 2)
    .map(stemToken);
}

/**
 * Light morphological relatedness for folder-name pairs like finance/financial.
 * Requires a 5+ char shared prefix so "cat" does not claim "catalog".
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function tokensLikelyRelated(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 5 && longer.startsWith(shorter) && longer.length - shorter.length <= 4;
}

/** @param {string} a @param {string} b */
function tokensMatch(a, b) {
  return a === b || tokensLikelyRelated(a, b);
}

/**
 * @param {Set<string>} pool
 * @param {string} token
 */
function poolContainsToken(pool, token) {
  if (pool.has(token)) return true;
  for (const part of pool) {
    if (tokensLikelyRelated(part, token)) return true;
  }
  return false;
}

/**
 * Build the semantic token pool for a smart folder: description, keywords,
 * optional category field, and name (name alone is weaker signal here — name
 * matching already ran earlier in the pipeline).
 *
 * @param {any} folder
 * @returns {Set<string>}
 */
function buildFolderSemanticTokenPool(folder) {
  /** @type {Set<string>} */
  const pool = new Set();
  const add = (/** @type {any} */ value) => {
    for (const part of tokenizeSemanticText(value)) pool.add(part);
  };
  add(folder?.description);
  add(folder?.category);
  add(folder?.name);
  if (Array.isArray(folder?.keywords)) {
    for (const kw of folder.keywords) add(kw);
  } else {
    add(folder?.keywords);
  }
  return pool;
}

/**
 * Hybrid lexical score of an LLM category/label against a folder's
 * description + keywords (+ name/category). Same shape as
 * FolderMatchingService.matchTokensToFolders:
 *   0.6 * Jaccard + 0.4 * overlapRatio
 *
 * @param {string} label
 * @param {any} folder
 * @returns {number}
 */
function scoreLabelAgainstFolderSemantics(label, folder) {
  const inputTokens = tokenizeSemanticText(label);
  if (inputTokens.length === 0) return 0;
  const pool = buildFolderSemanticTokenPool(folder);
  if (pool.size === 0) return 0;

  const inputSet = new Set(inputTokens);
  let overlap = 0;
  for (const tok of inputSet) {
    if (poolContainsToken(pool, tok)) overlap += 1;
  }
  if (overlap === 0) return 0;

  const unionSize = pool.size + inputSet.size - overlap;
  const jaccard = unionSize > 0 ? overlap / unionSize : 0;
  const overlapRatio = inputSet.size > 0 ? overlap / inputSet.size : 0;
  const composite = 0.6 * jaccard + 0.4 * overlapRatio;
  // Long folder descriptions dilute Jaccard below minScore even when half the
  // label's tokens are explicit folder keywords ("Climate Change" → Nature).
  if (inputSet.size > 1 && overlapRatio >= 0.5) {
    return Math.max(composite, 0.4);
  }
  return composite;
}

/** Splits a free-text description into its list items ("invoices, receipts and tax"). */
const DESCRIPTION_ITEM_SPLIT_RE = /[,;|/\n()&]+|\b(?:and|or)\b/i;

/**
 * Normalize a single-token label to a comparable stem set (singular/plural).
 * @param {string} token
 * @returns {Set<string>}
 */
function singleTokenVariants(token) {
  return new Set([token, token.replace(/s$/, ''), `${token}s`]);
}

/**
 * A one-word label always has overlapRatio 1 the moment the word appears
 * anywhere in a description, so the composite score is meaningless for it
 * ("Personal" → Finance via "personal finance"). Require the word to be an
 * explicit unit instead: a keyword, a folder-name token, or a standalone
 * description list item ("invoices" in "invoices, receipts, tax").
 *
 * @param {string} token
 * @param {any} folder
 * @returns {boolean}
 */
function folderExplicitlyNamesToken(token, folder) {
  const variants = singleTokenVariants(token);
  const matchesPhrase = (/** @type {any} */ phrase) => {
    const parts = tokenizeSemanticText(phrase);
    return parts.length === 1 && (variants.has(parts[0]) || tokensMatch(parts[0], token));
  };

  const keywords = Array.isArray(folder?.keywords)
    ? folder.keywords
    : folder?.keywords
      ? [folder.keywords]
      : [];
  if (keywords.some(matchesPhrase)) return true;
  if (
    tokenizeSemanticText(folder?.name).some(
      (part) => variants.has(part) || tokensMatch(part, token)
    )
  ) {
    return true;
  }
  if (
    tokenizeSemanticText(folder?.category).some(
      (part) => variants.has(part) || tokensMatch(part, token)
    )
  ) {
    return true;
  }

  return String(folder?.description || '')
    .split(DESCRIPTION_ITEM_SPLIT_RE)
    .some(matchesPhrase);
}

/**
 * Pick the best smart folder when an LLM category fits the folder's
 * description/keywords better than its name. Used as a safety net after
 * name-only stages fail (e.g. "Invoices" → Financial with description
 * "invoices, receipts, tax").
 *
 * @param {string} label
 * @param {any[]} folders
 * @param {{ minScore?: number, minMargin?: number }} [options]
 * @returns {any|null} folder record, or null when no confident semantic hit
 */
function findBestSemanticFolder(label, folders, options = {}) {
  const minScore = Number.isFinite(options.minScore)
    ? /** @type {number} */ (options.minScore)
    : 0.35;
  const minMargin = Number.isFinite(options.minMargin)
    ? /** @type {number} */ (options.minMargin)
    : 0.05;
  const list = Array.isArray(folders) ? folders : [];
  if (!String(label || '').trim() || list.length === 0) return null;

  const labelTokens = Array.from(new Set(tokenizeSemanticText(label)));
  const singleToken = labelTokens.length === 1 ? labelTokens[0] : null;

  /** @type {{ folder: any, score: number }[]} */
  const ranked = [];
  for (const folder of list) {
    const name = String(folder?.name || '').trim();
    if (!name || name.toLowerCase() === DEFAULT_CATEGORY_NAME.toLowerCase()) continue;
    if (singleToken && !folderExplicitlyNamesToken(singleToken, folder)) continue;
    const score = scoreLabelAgainstFolderSemantics(label, folder);
    if (score >= minScore) ranked.push({ folder, score });
  }
  if (ranked.length === 0) return null;

  ranked.sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const second = ranked[1];
  if (second) {
    const margin = best.score - second.score;
    // Mid-tier near-ties and exact high-score ties are both guesses.
    if ((margin < minMargin && best.score < 0.5) || margin < 1e-9) {
      return null;
    }
  }
  return best.folder;
}

/**
 * Resolve a label to a smart-folder record using the same precedence as
 * FolderMatchingService.matchCategoryToFolder (subset), plus renderer variants.
 *
 * @param {string} label - Category, vendor, etc.
 * @param {Array<{name?: string, path?: string}>} smartFolders
 * @returns {{name?: string, path?: string}|null}
 */
function findSmartFolderForLabel(label, smartFolders) {
  const folders = (Array.isArray(smartFolders) ? smartFolders : []).filter(
    (f) => f && typeof f.name === 'string' && f.name.trim()
  );
  if (!folders.length) return null;

  const raw = String(label || '').trim();
  if (!raw) return null;

  const candidates = [];
  const seen = new Set();
  for (const candidate of [raw, stripCategorySubjectSuffix(raw)]) {
    const key = candidate.toLowerCase();
    if (!candidate || seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }

  for (const candidate of candidates) {
    const match = matchSingleLabelToFolder(candidate, folders);
    if (match) return match;
  }

  return null;
}

/**
 * @param {string} raw
 * @param {any[]} folders
 */
function matchSingleLabelToFolder(raw, folders) {
  const normalizedRaw = raw.toLowerCase().trim();
  const rawCanon = canon(raw);
  const variants = buildLabelVariants(raw);

  for (const folder of folders) {
    const name = folder.name.trim();
    const baseName = name.toLowerCase();
    if (baseName === normalizedRaw) return folder;

    const folderVariants = buildLabelVariants(baseName);
    if (folderVariants.includes(normalizedRaw)) return folder;
    for (const variant of variants) {
      if (folderVariants.includes(variant)) return folder;
    }
  }

  if (rawCanon) {
    for (const folder of folders) {
      if (canon(folder.name) === rawCanon) return folder;
    }
  }

  for (const folder of folders) {
    const name = folder.name.trim();
    if (!name || name.toLowerCase() === 'uncategorized') continue;
    if (namesAreEquivalent(raw, name)) return folder;
  }

  if (rawCanon) {
    let bestPrefix = null;
    let bestPrefixLengthDelta = Infinity;
    for (const folder of folders) {
      const name = folder.name.trim();
      if (!name) continue;
      const nameCanon = canon(name);
      if (!nameCanon || !rawCanon) continue;

      const rawIsPrefix =
        rawCanon.length >= 3 &&
        nameCanon.length > rawCanon.length &&
        nameCanon.startsWith(rawCanon) &&
        isWordBoundary(nameCanon, rawCanon.length);
      const nameIsPrefix =
        nameCanon.length >= 3 &&
        rawCanon.length > nameCanon.length &&
        rawCanon.startsWith(nameCanon) &&
        isWordBoundary(rawCanon, nameCanon.length);

      if (rawIsPrefix || nameIsPrefix) {
        const delta = Math.abs(nameCanon.length - rawCanon.length);
        if (delta < bestPrefixLengthDelta) {
          bestPrefixLengthDelta = delta;
          bestPrefix = folder;
        }
      }
    }
    if (bestPrefix) return bestPrefix;
  }

  // Description / keywords safety net (same threshold as main FolderMatchingService).
  return findBestSemanticFolder(raw, folders);
}

/**
 * Specialized file types whose extension is a stronger routing signal than a
 * generic LLM bucket ("Documents", "Uncategorized", "Models").
 * Tokens must appear in a folder name/description/keywords to count.
 */
/** @type {Record<string, string[]>} */
const SPECIALIZED_EXTENSION_CONCEPTS = {
  stl: ['3d', 'print', 'prints', 'printing', 'model', 'models', 'mesh', 'cad', 'slicer', 'gcode'],
  obj: ['3d', 'print', 'prints', 'printing', 'model', 'models', 'mesh', 'cad'],
  '3mf': ['3d', 'print', 'prints', 'printing', 'model', 'models', 'mesh', 'cad', 'slicer'],
  gcode: ['3d', 'print', 'prints', 'printing', 'slicer', 'gcode', 'ender', 'prusa', 'bambu'],
  scad: ['3d', 'print', 'prints', 'printing', 'openscad', 'scad', 'cad', 'model', 'models'],
  step: ['cad', '3d', 'model', 'models'],
  stp: ['cad', '3d', 'model', 'models'],
  iges: ['cad', '3d', 'model', 'models']
};

const GENERIC_BUCKET_NAMES = new Set([
  'uncategorized',
  'documents',
  'document',
  'images',
  'image',
  'files',
  'file',
  'default',
  'other',
  'models',
  'model'
]);

// "print" alone is ambiguous ("Print Shop Receipts"); only unmistakable
// maker/CAD tokens in the folder name count as a strong signal.
const STRONG_FOLDER_NAME_RE = /\b(3d|cad|slicer|gcode|openscad|scad)\b/i;

/**
 * @param {any} file
 * @returns {string}
 */
function extensionFromFile(file) {
  const raw = file?.extension || file?.analysis?.extension || '';
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim().replace(/^\./, '').toLowerCase();
  }
  const fromPath = String(file?.path || file?.name || '');
  const match = fromPath.match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : '';
}

/**
 * True when a matched folder is a generic catch-all that should lose to a
 * specialized extension match (e.g. .stl → "3D Prints" instead of Documents).
 *
 * @param {any} folder
 * @returns {boolean}
 */
function isGenericBucketFolder(folder) {
  return GENERIC_BUCKET_NAMES.has(
    String(folder?.name || '')
      .trim()
      .toLowerCase()
  );
}

/**
 * @param {any} folder
 * @param {string} ext
 * @returns {boolean} a keyword equals `ext` or `.ext`
 */
function folderKeywordClaimsExtension(folder, ext) {
  const keywords = Array.isArray(folder?.keywords)
    ? folder.keywords
    : folder?.keywords
      ? [folder.keywords]
      : [];
  return keywords.some(
    (/** @type {any} */ kw) =>
      String(kw || '')
        .trim()
        .toLowerCase()
        .replace(/^\./, '') === ext
  );
}

/**
 * True when the folder explicitly claims this extension — a keyword equal to
 * `stl` / `.stl`, or the dotted token `.stl` standing alone in the name or
 * description. Bare words are deliberately not a claim: "PDF manuals" would
 * otherwise capture every PDF and "step-by-step" every .step file, and a
 * substring test lets `.json` claim `.js`.
 *
 * @param {any} folder
 * @param {string} ext
 * @returns {boolean}
 */
function folderExplicitlyClaimsExtension(folder, ext) {
  if (!ext || !folder) return false;
  if (folderKeywordClaimsExtension(folder, ext)) return true;

  const text = `${folder.name || ''} ${folder.description || ''}`.toLowerCase();
  const escaped = ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])\\.${escaped}(?![a-z0-9])`).test(text);
}

/**
 * Folders that listed this extension on purpose (keywords / description).
 * Prefers a specific themed folder over a generic type bucket (Documents).
 * Several folders claiming the same extension is a configuration ambiguity;
 * refuse rather than route to whichever happens to be first.
 *
 * @param {string} ext
 * @param {any[]} folders
 * @returns {object|null}
 */
function findFolderClaimingExtension(ext, folders) {
  const claimants = folders.filter((folder) => folderExplicitlyClaimsExtension(folder, ext));
  if (claimants.length === 0) return null;
  const specific = claimants.filter((folder) => !isGenericBucketFolder(folder));
  const pool = specific.length > 0 ? specific : claimants;
  if (pool.length === 1) return pool[0];
  const keywordClaims = pool.filter((folder) => folderKeywordClaimsExtension(folder, ext));
  return keywordClaims.length === 1 ? keywordClaims[0] : null;
}

/**
 * Resolve an extension to a smart folder.
 * 1) Explicit "all .ext go here" claims (keywords / description)
 * 2) Specialized type heuristics (3D / CAD) when no explicit claim exists
 *
 * @param {string} extension
 * @param {any[]} smartFolders
 * @returns {any|null}
 */
function findSmartFolderForExtension(extension, smartFolders) {
  const ext = String(extension || '')
    .trim()
    .replace(/^\./, '')
    .toLowerCase();
  if (!ext) return null;

  const folders = (Array.isArray(smartFolders) ? smartFolders : []).filter(
    (f) => f && typeof f.name === 'string' && f.name.trim() && !isDefaultCategoryName(f.name)
  );
  if (folders.length === 0) return null;

  const claimed = findFolderClaimingExtension(ext, folders);
  if (claimed) return claimed;

  const concepts = SPECIALIZED_EXTENSION_CONCEPTS[ext];
  if (!concepts) return null;

  const conceptSet = new Set(concepts);
  /** @type {{ folder: any, score: number }[]} */
  const ranked = [];

  for (const folder of folders) {
    const pool = buildFolderSemanticTokenPool(folder);
    let conceptOverlap = 0;
    for (const token of pool) {
      if (conceptSet.has(token)) conceptOverlap += 1;
    }
    const strongName = STRONG_FOLDER_NAME_RE.test(String(folder.name || ''));
    // A lone print-family token ("Print Shop Receipts") or a bare extension
    // word in prose ("step-by-step") is not evidence of a maker folder: demand
    // an unmistakable name token or corroborating concept hits.
    const extMentioned = pool.has(ext);
    if (!strongName && conceptOverlap < (extMentioned ? 1 : 2)) continue;
    const overlap = conceptOverlap + (extMentioned ? 2 : 0);

    const printBias = /\b(print|prints|printing)\b/i.test(String(folder.name || '')) ? 1 : 0;
    ranked.push({ folder, score: overlap + (strongName ? 3 : 0) + printBias });
  }

  if (ranked.length === 0) return null;
  ranked.sort((a, b) => b.score - a.score);
  return ranked[0].score >= 2 ? ranked[0].folder : null;
}

const FILE_MATCH_FIELDS = ['category', 'vendor', 'organization', 'entity', 'sender', 'project'];

/**
 * Resolve a file to a smart folder: analysis labels first, then extension.
 * Generic buckets (Uncategorized / Documents / Models) yield to a specialized
 * extension match so .stl lands in "3D Prints" instead of the catch-all.
 *
 * @param {any} file
 * @param {any[]} smartFolders
 * @returns {any|null}
 */
function findSmartFolderForFile(file, smartFolders) {
  const folders = Array.isArray(smartFolders) ? smartFolders : [];
  if (folders.length === 0) return null;

  const specialized = findSmartFolderForExtension(extensionFromFile(file), folders);
  const analysis = file?.analysis && typeof file.analysis === 'object' ? file.analysis : file;

  /** @type {any} */
  let genericMatch = null;
  for (const field of FILE_MATCH_FIELDS) {
    const matched = findSmartFolderForLabel(analysis?.[field], folders);
    if (!matched) continue;
    if (isGenericBucketFolder(matched)) {
      if (specialized) return specialized;
      genericMatch = genericMatch || matched;
      continue;
    }
    return matched;
  }

  const keywordLabel = Array.isArray(analysis?.keywords)
    ? analysis.keywords
        .filter((/** @type {any} */ k) => typeof k === 'string' && k.trim())
        .join(' ')
    : typeof analysis?.keywords === 'string'
      ? analysis.keywords
      : '';
  if (keywordLabel.trim()) {
    const keywordMatched = findBestSemanticFolder(keywordLabel, folders);
    if (keywordMatched) return keywordMatched;
  }

  return specialized || genericMatch;
}

module.exports = {
  CATEGORY_SUBJECT_SUFFIX_RE,
  DEFAULT_CATEGORY_NAME,
  hasCategorySubjectSuffix,
  isDefaultCategoryName,
  getSelectableSmartFolders,
  stripCategorySubjectSuffix,
  scoreFolderNameForDedup,
  scoreLabelAgainstFolderSemantics,
  findBestSemanticFolder,
  findSmartFolderForLabel,
  findSmartFolderForExtension,
  findSmartFolderForFile,
  isGenericBucketFolder
};
