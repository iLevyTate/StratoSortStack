// @ts-check
/**
 * Find a theme that recurs among uncategorized files, so the Organize screen
 * can offer "Create a Smart Folder for <theme>".
 *
 * The first version grouped on one field (vendor, organization, entity,
 * sender, project or category) by exact text. For a file whose contents could
 * not be read that field is the file's own name, so every file formed its own
 * group and no suggestion ever appeared. Files are now grouped on two
 * signals: a named entity the analysis found (skipping ones that are just the
 * file name or a generic category), and a keyword several files share.
 */

/** A group needs at least this many files before it is offered. */
export const THEME_MIN_FILES = 3;

// Words that describe a file's form, not its subject: grouping on them would
// offer folders like "Pdf" or "Document".
const GENERIC_WORDS = new Set([
  'archive',
  'document',
  'documents',
  'file',
  'files',
  'image',
  'images',
  'photo',
  'picture',
  'graphic',
  'text',
  'misc',
  'other',
  'unknown',
  'uncategorized',
  'default',
  'zip',
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'svg',
  'gif',
  'webp',
  'docx',
  'doc',
  'xlsx',
  'pptx',
  'txt',
  'md',
  'html',
  'mp3',
  'mp4',
  'mov',
  'wav'
]);

/** @param {unknown} value */
function normalize(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

/** "Tiller Template (3).xlsx" -> "tiller template 3" */
function fileStem(/** @type {any} */ file) {
  const name = String(file?.name || file?.path || '')
    .split(/[\\/]/)
    .pop();
  return normalize(String(name || '').replace(/\.[^.]+$/, '')).replace(/[^\p{L}\p{N}]+/gu, ' ');
}

/** @param {string} key */
function isUsableKey(key) {
  return key.length >= 3 && !GENERIC_WORDS.has(key) && !/^\d+$/.test(key);
}

/** @param {string} label */
function toDisplayName(label) {
  const trimmed = String(label).trim();
  // Keep the analysis's own casing ("SCANUE", "Brittney"); capitalize a
  // lowercase keyword so it reads as a folder name.
  return trimmed === trimmed.toLowerCase()
    ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
    : trimmed;
}

/**
 * The entity the analysis named for a file, or null when it only restates
 * the file's name or a generic category.
 * @param {any} file
 * @returns {{ key: string, label: string } | null}
 */
function entityOf(file) {
  const analysis = file?.analysis;
  if (!analysis || typeof analysis !== 'object') return null;
  const stem = fileStem(file);
  for (const field of ['vendor', 'organization', 'entity', 'sender', 'project']) {
    const raw = analysis[field];
    const key = normalize(raw);
    if (!key || !isUsableKey(key)) continue;
    // A fallback analysis sets project to the file's own name.
    if (key.replace(/[^\p{L}\p{N}]+/gu, ' ') === stem) continue;
    return { key, label: String(raw) };
  }
  return null;
}

/**
 * @param {any} file
 * @returns {Map<string, string>} keyword key -> label, once per file
 */
function keywordsOf(file) {
  const analysis = file?.analysis;
  const list = [
    ...(Array.isArray(analysis?.keywords) ? analysis.keywords : []),
    ...(Array.isArray(analysis?.tags) ? analysis.tags : [])
  ];
  /** @type {Map<string, string>} */
  const found = new Map();
  for (const raw of list) {
    const key = normalize(raw);
    if (key && isUsableKey(key) && !found.has(key)) found.set(key, String(raw));
  }
  return found;
}

/**
 * The largest recurring theme among `files`, or null when none reaches
 * THEME_MIN_FILES. A named entity wins a tie with a keyword: it is the more
 * specific signal.
 *
 * @param {any[]} files - Uncategorized files with their `analysis`
 * @returns {{ displayName: string, files: any[], source: 'entity' | 'keyword' } | null}
 */
export function findRecurringTheme(files) {
  /** @type {Map<string, { label: string, files: any[], source: 'entity' | 'keyword' }>} */
  const groups = new Map();
  /**
   * @param {string} id
   * @param {string} label
   * @param {any} file
   * @param {'entity' | 'keyword'} source
   */
  const add = (id, label, file, source) => {
    const group = groups.get(id) || { label, files: [], source };
    if (!group.files.includes(file)) group.files.push(file);
    // An entity's spelling ("Stratosort") reads better than a keyword's.
    if (source === 'entity' && group.source !== 'entity') {
      group.source = 'entity';
      group.label = label;
    }
    groups.set(id, group);
  };

  // One tally per term, whichever field named it: "Stratosort" as one file's
  // entity and another's keyword is the same theme.
  for (const file of Array.isArray(files) ? files : []) {
    const entity = entityOf(file);
    if (entity) add(entity.key, entity.label, file, 'entity');
    for (const [key, label] of keywordsOf(file)) {
      if (key !== entity?.key) add(key, label, file, 'keyword');
    }
  }

  /** @type {{ label: string, files: any[], source: 'entity' | 'keyword' } | null} */
  let best = null;
  for (const group of groups.values()) {
    if (group.files.length < THEME_MIN_FILES) continue;
    if (
      !best ||
      group.files.length > best.files.length ||
      (group.files.length === best.files.length &&
        group.source === 'entity' &&
        best.source === 'keyword')
    ) {
      best = group;
    }
  }
  return best
    ? { displayName: toDisplayName(best.label), files: best.files, source: best.source }
    : null;
}
