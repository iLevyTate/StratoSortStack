// @ts-check
/**
 * Smart Folder Name Validation — single source of truth.
 *
 * Pure JS, no Node-only imports. Safe to import from both the main process
 * (`src/main/ipc/smartFolders.js`) and the renderer (`AddSmartFolderModal`,
 * `SmartFolderItem`). Validation rules originate from main-process server
 * behavior so renderer pre-validation matches what the server will accept —
 * no more silent post-submit rejections.
 *
 * @module shared/smartFolderNameValidation
 */

const { ERROR_CODES } = require('./errorCodes');

// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS = /[<>:"|?*\x00-\x1f]/;
const RESERVED_DEVICE_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
const TRAILING_DOT_OR_SPACE = /[. ]$/;

/**
 * Validate a smart folder name against all server-enforced rules.
 *
 * @param {string} rawName - User-supplied folder name (untrimmed).
 * @returns {{
 *   valid: boolean,
 *   error: string | null,
 *   errorCode: string | null,
 *   sanitizedName: string,
 *   warning: string | null
 * }}
 *   - `valid`: true if the name will be accepted by the server.
 *   - `error` / `errorCode`: rejection reason when `valid` is false.
 *   - `sanitizedName`: the name as it will be persisted (after " > " stripping).
 *   - `warning`: non-blocking notice (e.g. " > " was stripped) — set even when
 *     `valid` is true, so callers can surface the transformation to the user.
 */
function validateSmartFolderName(rawName) {
  if (typeof rawName !== 'string' || !rawName.trim()) {
    return {
      valid: false,
      error: 'Folder name is required and must be a non-empty string',
      errorCode: ERROR_CODES.INVALID_FOLDER_NAME,
      sanitizedName: '',
      warning: null
    };
  }

  let sanitizedName = rawName.trim();
  let warning = null;

  // " > " separator strip — historical behavior for names like
  // "Work > Project Management Templates" (only the first segment is kept).
  // Preserved for backward compat, but surfaced as a warning so it's no
  // longer silent.
  if (sanitizedName.includes(' > ')) {
    const originalForWarning = sanitizedName;
    sanitizedName = sanitizedName.split(' > ')[0].trim();
    warning = `Folder name will be saved as "${sanitizedName}" (the " > " separator and everything after it is dropped).`;
    if (!sanitizedName) {
      return {
        valid: false,
        error: `Folder name "${originalForWarning}" collapses to empty after the " > " separator is removed`,
        errorCode: ERROR_CODES.INVALID_FOLDER_NAME,
        sanitizedName: '',
        warning: null
      };
    }
  }

  if (ILLEGAL_CHARS.test(sanitizedName)) {
    return {
      valid: false,
      error: 'Folder name contains invalid characters. Please avoid: < > : " | ? *',
      errorCode: ERROR_CODES.INVALID_FOLDER_NAME_CHARS,
      sanitizedName,
      warning: null
    };
  }

  // Path-traversal segments like "..", "Foo/../bar" — reject up front.
  const nameParts = sanitizedName.split(/[\\/]/);
  if (nameParts.some((segment) => segment === '..')) {
    return {
      valid: false,
      error: 'Folder name cannot contain path traversal segments (..)',
      errorCode: ERROR_CODES.INVALID_FOLDER_NAME_CHARS,
      sanitizedName,
      warning: null
    };
  }

  if (RESERVED_DEVICE_NAMES.test(sanitizedName)) {
    return {
      valid: false,
      error:
        'Folder name is a Windows reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9). Choose a different name.',
      errorCode: ERROR_CODES.INVALID_FOLDER_NAME_CHARS,
      sanitizedName,
      warning: null
    };
  }

  // Windows silently trims trailing dots and spaces from path components,
  // which would otherwise create silent duplicates like "Notes." → "Notes".
  if (TRAILING_DOT_OR_SPACE.test(sanitizedName)) {
    return {
      valid: false,
      error: 'Folder name cannot end with a space or period.',
      errorCode: ERROR_CODES.INVALID_FOLDER_NAME_CHARS,
      sanitizedName,
      warning: null
    };
  }

  return {
    valid: true,
    error: null,
    errorCode: null,
    sanitizedName,
    warning
  };
}

/**
 * Lowercase a folder name and collapse all non-alphanumeric runs to a single
 * space, then trim. Mirrors the `canonicalize()` helper inside
 * `semanticFolderMatcher.js` so the matcher and the smart-folder-add dedup
 * agree on what "the same name in different surface form" means.
 *
 * @param {string} value
 * @returns {string} canonical form ("logos and graphic design")
 */
function canonicalizeFolderName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Decide whether two folder names refer to the same concept. Used to block
 * the recommender from proposing "Logos and Graphic Design" when "Logos"
 * already exists — that case crashed into the analysis pipeline as a
 * silent duplicate and confused the embedding-based matcher.
 *
 * Rule: every token of the shorter canonical name must also appear in the
 * longer one. So:
 *   "Logos" ⊂ "Logos and Graphic Design" → equivalent
 *   "Marketing" ⊂ "Marketing Materials"  → equivalent
 *   "Personal" ⊂ "Personal Projects"     → equivalent
 *   "Work" vs "Workshop"                 → NOT equivalent (different tokens)
 *
 * Note: "Personal" vs "Personal Projects" being flagged is a deliberate
 * trade-off. The recommender prefers redirecting to the existing folder
 * over creating a near-duplicate that the embedding matcher then has to
 * choose between. A user who genuinely wants both can still add the
 * sub-folder manually; the UI surfaces this as "did you mean X?" not a
 * hard refusal.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function namesAreEquivalent(a, b) {
  const canonA = canonicalizeFolderName(a);
  const canonB = canonicalizeFolderName(b);
  if (!canonA || !canonB) return false;
  if (canonA === canonB) return true;
  const tokensA = new Set(canonA.split(/\s+/).filter(Boolean));
  const tokensB = new Set(canonB.split(/\s+/).filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  const [shorter, longer] = tokensA.size <= tokensB.size ? [tokensA, tokensB] : [tokensB, tokensA];
  for (const t of shorter) {
    if (!longer.has(t)) return false;
  }
  return true;
}

/**
 * Find groups of smart folders whose names are canonically equivalent
 * (per `namesAreEquivalent` — token-subset match).
 *
 * Used at startup to surface duplicates that slipped in before PR #252's
 * dedup-by-canonical-name guard was added to `handleSmartFoldersAdd`. The
 * user's `"Logos"` + `"Logos and Graphic Design"` pair is the canonical
 * example: both folders end up in `availableFolders`, and the
 * embedding-based matcher then flip-flops between them, producing the
 * "category keeps switching" symptom in the logs.
 *
 * Returns groups of size ≥ 2. Each group is the indices in the input
 * array that share an equivalence class. The caller decides what to do
 * with them (currently: log a warning so the user can merge manually).
 *
 * Complexity is O(n²) over folder count — fine for typical n ≤ 30.
 *
 * @param {Array<{name?: string}>} folders
 * @returns {Array<{indices: number[], names: string[]}>}
 */
function findEquivalentFolderGroups(folders) {
  const safe = Array.isArray(folders) ? folders : [];
  if (safe.length < 2) return [];

  const visited = new Set();
  const groups = [];

  for (let i = 0; i < safe.length; i += 1) {
    if (visited.has(i)) continue;
    const groupIndices = [i];
    for (let j = i + 1; j < safe.length; j += 1) {
      if (visited.has(j)) continue;
      if (namesAreEquivalent(safe[i]?.name, safe[j]?.name)) {
        groupIndices.push(j);
        visited.add(j);
      }
    }
    if (groupIndices.length > 1) {
      visited.add(i);
      groups.push({
        indices: groupIndices,
        names: groupIndices.map((idx) => safe[idx]?.name).filter(Boolean)
      });
    }
  }

  return groups;
}

module.exports = {
  validateSmartFolderName,
  canonicalizeFolderName,
  namesAreEquivalent,
  findEquivalentFolderGroups
};
