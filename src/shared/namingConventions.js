// @ts-check
/**
 * Shared Naming Conventions
 *
 * Common formatting utilities used by both main-process and renderer naming modules.
 *
 * @module shared/namingConventions
 */

/**
 * Format a date according to the specified format
 * @param {Date} date - Date to format
 * @param {string} format - Date format string
 * @returns {string} Formatted date
 */
function formatDate(date, format) {
  // Use UTC to avoid timezone-dependent date drift (e.g., near midnight causing off-by-one days)
  // This keeps filenames stable and aligns with ISO-8601 date expectations in tests and exports.
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');

  switch (format) {
    case 'YYYY-MM-DD':
      return `${year}-${month}-${day}`;
    case 'MM-DD-YYYY':
      return `${month}-${day}-${year}`;
    case 'DD-MM-YYYY':
      return `${day}-${month}-${year}`;
    case 'YYYYMMDD':
      return `${year}${month}${day}`;
    default:
      return `${year}-${month}-${day}`;
  }
}

const DEFAULT_NAMING_CONVENTION_STATE = Object.freeze({
  convention: 'subject-date',
  separator: '-',
  dateFormat: 'YYYY-MM-DD',
  caseConvention: 'kebab-case'
});

/**
 * Normalize naming settings from Redux, legacy persisted state, or IPC payloads.
 * Legacy stores sometimes persisted `namingConvention` as a bare string.
 *
 * @param {*} raw - Raw naming state or settings fragment
 * @returns {{ convention: string, separator: string, dateFormat: string, caseConvention: string }}
 */
function normalizeNamingConventionState(raw) {
  if (!raw) {
    return { ...DEFAULT_NAMING_CONVENTION_STATE };
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed
      ? { ...DEFAULT_NAMING_CONVENTION_STATE, convention: trimmed }
      : { ...DEFAULT_NAMING_CONVENTION_STATE };
  }
  if (typeof raw !== 'object') {
    return { ...DEFAULT_NAMING_CONVENTION_STATE };
  }
  return {
    convention:
      raw.convention || raw.namingConvention || DEFAULT_NAMING_CONVENTION_STATE.convention,
    separator: raw.separator ?? DEFAULT_NAMING_CONVENTION_STATE.separator,
    dateFormat: raw.dateFormat || DEFAULT_NAMING_CONVENTION_STATE.dateFormat,
    caseConvention: raw.caseConvention || DEFAULT_NAMING_CONVENTION_STATE.caseConvention
  };
}

const COMMON_SEPARATOR_SET = new Set(['', '-', '.', '_']);

/**
 * Normalize separator values to supported options.
 * Supported values: empty string (no separator), "-", ".", "_".
 *
 * @param {string} separator - Raw separator value from settings/UI
 * @param {string} [fallback='-'] - Fallback separator when value is unsupported
 * @returns {string} Normalized separator
 */
function normalizeSeparator(separator, fallback = '-') {
  if (separator === undefined || separator === null) return fallback;
  if (separator === '') return '';

  const trimmed = String(separator).trim();
  if (COMMON_SEPARATOR_SET.has(trimmed)) return trimmed;
  if (!trimmed) return fallback;

  // Backward compatibility: normalize legacy values like " - " to "-"
  const firstSupported = trimmed.match(/[-._]/)?.[0];
  return firstSupported || fallback;
}

/**
 * @param {any} text
 * @returns {string[]}
 */
function splitWords(text) {
  return String(text ?? '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Apply case convention to text
 * @param {string} text - Text to transform
 * @param {string} convention - Case convention to apply
 * @param {Object} [options] - Optional transform options
 * @param {string} [options.wordSeparator] - Preferred separator for separator-based casing
 * @returns {string} Transformed text
 */
function applyCaseConvention(text, convention, options = {}) {
  const defaultWordSeparator = convention === 'snake_case' ? '_' : '-';
  const wordSeparator = normalizeSeparator(options.wordSeparator, defaultWordSeparator);

  switch (convention) {
    case 'kebab-case':
      return splitWords(text)
        .map((word) => word.toLowerCase())
        .join(wordSeparator);
    case 'snake_case':
      return splitWords(text)
        .map((word) => word.toLowerCase())
        .join(wordSeparator);
    case 'camelCase':
      return splitWords(text)
        .filter(Boolean)
        .map((word, index) =>
          index === 0
            ? word.toLowerCase()
            : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
        )
        .join('');
    case 'PascalCase':
      return splitWords(text)
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join('');
    case 'lowercase':
      return text.toLowerCase();
    case 'UPPERCASE':
      return text.toUpperCase();
    default:
      return text;
  }
}

/**
 * Generate a preview name based on naming convention settings
 * @param {string} originalName - Original filename
 * @param {Object} settings - Naming settings
 * @param {string} settings.convention - Naming convention
 * @param {string} settings.separator - Separator character
 * @param {string} settings.dateFormat - Date format
 * @param {string} settings.caseConvention - Case convention
 * @returns {string} Preview name
 */
function generatePreviewName(originalName, settings) {
  const { convention, separator, dateFormat, caseConvention } = settings;
  const safeSeparator = normalizeSeparator(separator);

  const baseName = originalName.replace(/\.[^/.]+$/, '');
  const dotIdx = originalName.lastIndexOf('.');
  const extension = dotIdx > 0 ? originalName.slice(dotIdx) : '';
  const today = new Date();

  let previewName;
  switch (convention) {
    case 'subject-date':
      previewName = `${baseName}${safeSeparator}${formatDate(today, dateFormat)}`;
      break;
    case 'date-subject':
      previewName = `${formatDate(today, dateFormat)}${safeSeparator}${baseName}`;
      break;
    case 'project-subject-date':
      previewName = `Project${safeSeparator}${baseName}${safeSeparator}${formatDate(today, dateFormat)}`;
      break;
    case 'category-subject':
      previewName = `Category${safeSeparator}${baseName}`;
      break;
    case 'keep-original':
      return `${baseName}${extension}`;
    default:
      previewName = baseName;
  }

  return (
    applyCaseConvention(previewName, caseConvention, { wordSeparator: safeSeparator }) + extension
  );
}

/**
 * Generate a final suggested filename from analysis + naming settings.
 * This implementation is shared by main and renderer naming utilities.
 *
 * @param {{ originalFileName: string, analysis: Record<string,any>, settings: Record<string,any>, fileTimestamps?: Record<string,any> }} params
 * @returns {string} Suggested filename (with extension preserved)
 */
function generateSuggestedNameFromAnalysis({
  originalFileName,
  analysis,
  settings,
  fileTimestamps
}) {
  const safeOriginalName = String(originalFileName || '').trim();
  if (!safeOriginalName) return '';

  const extDotIdx = safeOriginalName.lastIndexOf('.');
  const extension = extDotIdx > 0 ? safeOriginalName.slice(extDotIdx) : '';
  const originalBase = safeOriginalName.replace(/\.[^/.]+$/, '');

  const convention = settings?.convention || 'keep-original';
  const separator = normalizeSeparator(settings?.separator ?? '-');
  const dateFormat = settings?.dateFormat || 'YYYY-MM-DD';
  const caseConvention = settings?.caseConvention;

  /** @param {any} s @returns {string} */
  const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** @param {any} subject @param {any} token @returns {any} */
  const stripTrailingDateToken = (subject, token) => {
    if (!subject || !token) return subject;
    const t = String(token).trim();
    if (!t) return subject;

    const re = new RegExp(`(?:[\\s._-]*${escapeRegExp(t)})+$`);
    const stripped = String(subject)
      .replace(re, '')
      .replace(/[\s._-]+$/g, '')
      .trim();
    return stripped || subject;
  };

  /** @param {any} subject @param {any} [appendedYear] @returns {any} */
  const stripGenericTrailingDate = (subject, appendedYear = null) => {
    if (!subject) return subject;
    // Strip trailing date-like tokens before the convention re-appends a date.
    // Two passes are required because we want different policies for full
    // dates vs bare years:
    //
    //   - YYYY-MM-DD / YYYYMMDD / YYYY-MM are unambiguously dates. Strip
    //     them whenever they trail the subject (idempotent rename).
    //   - Bare YYYY tokens are NOT unambiguously dates. "Annual Report 2024"
    //     is a legitimate subject; stripping it would corrupt user intent.
    //     We only strip a trailing bare year when it MATCHES the year we
    //     are about to re-append (`appendedYear`) — i.e. the documented
    //     "logo_2026" + date 2026-04-28 case where we'd otherwise produce
    //     "logo_2026_2026-04-28". When no date is being appended, or when
    //     the trailing year differs from the one we're appending, the
    //     subject's year is preserved.
    const fullDateRe = /(?:[\s._-]*(?:\d{4}-\d{2}-\d{2}|\d{8}|\d{4}-\d{2}))+$/;
    let stripped = String(subject).replace(fullDateRe, '');

    if (appendedYear && /^\d{4}$/.test(String(appendedYear))) {
      const sameYearRe = new RegExp(`(?:[\\s._-]+${appendedYear})+$`);
      stripped = stripped.replace(sameYearRe, '');
    }

    stripped = stripped.replace(/[\s._-]+$/g, '').trim();
    return stripped || subject;
  };

  const rawProject =
    typeof analysis?.project === 'string' && analysis.project.trim()
      ? analysis.project.trim()
      : 'Project';

  const rawCategory =
    typeof analysis?.category === 'string' && analysis.category.trim()
      ? analysis.category.trim()
      : 'Category';

  // Reasonable date range: 1970-01-01 to 100 years in the future.
  const MIN_DATE_MS = 0;
  const MAX_DATE_MS = Date.now() + 100 * 365 * 24 * 60 * 60 * 1000;

  /** @param {Date} d @returns {boolean} */
  const isReasonableDate = (d) => {
    if (!d || Number.isNaN(d.getTime())) return false;
    const ms = d.getTime();
    return ms >= MIN_DATE_MS && ms <= MAX_DATE_MS;
  };

  /** @param {any} value @returns {Date|null} */
  const parseDateLike = (value) => {
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return isReasonableDate(value) ? value : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      const d = new Date(value);
      return isReasonableDate(d) ? d : null;
    }
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    if (!raw) return null;
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      const local = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return Number.isNaN(local.getTime()) ? null : local;
    }
    const m2 = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m2) {
      const local = new Date(Number(m2[1]), Number(m2[2]) - 1, Number(m2[3]));
      return Number.isNaN(local.getTime()) ? null : local;
    }
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  /** @param {any} nameBase @returns {Date|null} */
  const parseDateFromFileName = (nameBase) => {
    const s = String(nameBase || '');
    const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const m2 = s.match(/(\d{4})(\d{2})(\d{2})/);
    if (m2) {
      const d = new Date(Number(m2[1]), Number(m2[2]) - 1, Number(m2[3]));
      return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
  };

  const fileNameDate = parseDateFromFileName(originalBase);
  const modifiedDate = parseDateLike(fileTimestamps?.modified);
  const createdDate = parseDateLike(fileTimestamps?.created);
  const analysisDate = parseDateLike(analysis?.date);
  // Do not fabricate today's date when no real date source exists — a
  // spurious date in the filename misleads users and corrupts date-based
  // sorting.  When null, date-containing conventions omit the date token.
  const effectiveDate = fileNameDate || modifiedDate || createdDate || analysisDate || null;

  const formattedDate = effectiveDate ? formatDate(effectiveDate, dateFormat) : '';

  const MAX_SUBJECT_LENGTH = 50;
  let rawSubject =
    typeof analysis?.suggestedName === 'string' && analysis.suggestedName.trim()
      ? analysis.suggestedName.trim().replace(/\.[^/.]+$/, '')
      : originalBase;

  const conventionAddsDate = ['subject-date', 'date-subject', 'project-subject-date'].includes(
    convention
  );
  if (conventionAddsDate) {
    rawSubject = stripTrailingDateToken(rawSubject, formattedDate);
    rawSubject = stripTrailingDateToken(rawSubject, analysis?.date);
    // Pass the year of the date about to be re-appended so the generic
    // strip can collapse "logo_2026" + 2026-04-28 → "logo_2026-04-28"
    // without eating "Annual Report 2024" when the appended date is 2025.
    const appendedYear =
      effectiveDate && !Number.isNaN(effectiveDate.getTime())
        ? String(effectiveDate.getUTCFullYear())
        : null;
    rawSubject = stripGenericTrailingDate(rawSubject, appendedYear);
  }

  if (rawSubject.length > MAX_SUBJECT_LENGTH) {
    const truncated = rawSubject.slice(0, MAX_SUBJECT_LENGTH);
    const lastBreak = Math.max(
      truncated.lastIndexOf(' '),
      truncated.lastIndexOf('-'),
      truncated.lastIndexOf('_')
    );
    rawSubject = lastBreak > MAX_SUBJECT_LENGTH * 0.5 ? truncated.slice(0, lastBreak) : truncated;
  }

  /** @param {any} value @returns {string} */
  const sanitizeToken = (value) =>
    String(value || '')
      .trim()
      .replace(/[_]/g, ' ')
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const subject = sanitizeToken(rawSubject) || originalBase;
  const project = sanitizeToken(rawProject) || 'Project';
  const category = sanitizeToken(rawCategory) || 'Category';

  let base;
  switch (convention) {
    case 'subject-date':
      base = formattedDate ? `${subject}${separator}${formattedDate}` : subject;
      break;
    case 'date-subject':
      base = formattedDate ? `${formattedDate}${separator}${subject}` : subject;
      break;
    case 'project-subject-date':
      base = formattedDate
        ? `${project}${separator}${subject}${separator}${formattedDate}`
        : `${project}${separator}${subject}`;
      break;
    case 'category-subject':
      base = `${category}${separator}${subject}`;
      break;
    case 'keep-original':
      return `${originalBase}${extension}`;
    default:
      base = subject;
      break;
  }

  const finalBase = caseConvention
    ? applyCaseConvention(base, caseConvention, { wordSeparator: separator })
    : base;
  return `${finalBase}${extension}`;
}

const COMPRESSED_TAR_EXTENSIONS = ['.gz', '.bz2', '.xz', '.zst', '.lz', '.lzma', '.br', '.z'];

/**
 * @param {any} fileName
 * @returns {string}
 */
function getCompoundExtension(fileName) {
  if (typeof fileName !== 'string') return '';
  const lower = fileName.toLowerCase();
  for (const ext of COMPRESSED_TAR_EXTENSIONS) {
    const compound = `.tar${ext}`;
    if (lower.endsWith(compound)) {
      return fileName.slice(-compound.length);
    }
  }
  return '';
}

/**
 * Extract extension from filename.
 * Handles compound extensions (e.g. .tar.gz, .tar.bz2).
 *
 * @param {string} fileName - Filename to parse
 * @returns {string} Extension with dot prefix (e.g. .jpg, .tar.gz)
 */
function extractExtension(fileName) {
  if (!fileName || typeof fileName !== 'string') return '';
  const compound = getCompoundExtension(fileName);
  if (compound) return compound;
  const dotIdx = fileName.lastIndexOf('.');
  return dotIdx > 0 && dotIdx < fileName.length - 1 ? fileName.slice(dotIdx).toLowerCase() : '';
}

/**
 * Extract filename from path
 * @param {string} filePath - Full file path
 * @returns {string} Filename
 */
function extractFileName(filePath) {
  return filePath.split(/[\\/]/).pop();
}

/**
 * Ensure a filename is unique within a set by appending a numeric suffix before the extension.
 *
 * Example:
 * - "photo.jpg" -> "photo.jpg"
 * - "photo.jpg" again -> "photo-2.jpg"
 * - "photo.jpg" again -> "photo-3.jpg"
 *
 * Uniqueness is case-insensitive.
 *
 * @param {string} desiredName - Desired filename (may include extension)
 * @param {Map<string, number>} usedCounts - Map keyed by lowercased full filename to count
 * @returns {string} Unique filename
 */
function makeUniqueFileName(desiredName, usedCounts) {
  const raw = String(desiredName || '').trim();
  if (!raw) return '';

  const key = raw.toLowerCase();
  const prevCount = usedCounts.get(key) || 0;
  if (prevCount === 0) {
    usedCounts.set(key, 1);
    return raw;
  }

  // Split extension (only last dot, allow up to 10-char extensions like .markdown, .geojson)
  const dotIdx = raw.lastIndexOf('.');
  const hasExt = dotIdx > 0 && dotIdx > raw.length - 11;
  const base = hasExt ? raw.slice(0, dotIdx) : raw;
  const ext = hasExt ? raw.slice(dotIdx) : '';

  let n = prevCount + 1;
  // Find the first unused candidate
  for (let attempts = 0; attempts < 10000; attempts += 1) {
    const candidate = `${base}_${n}${ext}`;
    const candidateKey = candidate.toLowerCase();
    if (!usedCounts.has(candidateKey)) {
      usedCounts.set(key, n); // track latest for the original key
      usedCounts.set(candidateKey, 1);
      return candidate;
    }
    n += 1;
  }

  // Extremely unlikely unless usedCounts was pre-populated with a huge contiguous range.
  // Return the raw name rather than hanging.
  return raw;
}

/**
 * @param {any} settings
 * @returns {string}
 */
function namingSettingsKey(settings) {
  if (!settings || typeof settings !== 'object') return '';
  const normalized = normalizeNamingConventionState(settings);
  return `${normalized.convention}|${normalized.separator}|${normalized.dateFormat}|${normalized.caseConvention}`;
}

/**
 * Whether main-process naming was already applied and matches current Discover settings.
 * Used by ready-queue hydration to skip a redundant re-apply that would drop dates when
 * file timestamps are missing in renderer state.
 * @param {any} analysis
 * @param {any} namingSettings
 * @returns {boolean}
 */
function mainProcessNamingAlreadyApplied(analysis, namingSettings) {
  const llmName =
    typeof analysis?.llmSuggestedName === 'string' ? analysis.llmSuggestedName.trim() : '';
  const finalName =
    typeof analysis?.suggestedName === 'string' ? analysis.suggestedName.trim() : '';
  if (!llmName || !finalName) return false;

  const stored = analysis?.namingConvention;
  if (!stored || !namingSettings) return true;

  return namingSettingsKey(stored) === namingSettingsKey(namingSettings);
}

/**
 * Build analysis input for naming re-application — prefer raw LLM subject over convention-final name.
 * @param {any} analysis
 * @returns {any}
 */
function buildAnalysisInputForNamingReapply(analysis) {
  if (!analysis || typeof analysis !== 'object') return analysis;
  const llmName =
    typeof analysis.llmSuggestedName === 'string' ? analysis.llmSuggestedName.trim() : '';
  const raw =
    llmName ||
    (typeof analysis.originalSuggestedName === 'string'
      ? analysis.originalSuggestedName.trim()
      : '') ||
    (typeof analysis.suggestedName === 'string' ? analysis.suggestedName.trim() : '');
  return raw ? { ...analysis, suggestedName: raw } : analysis;
}

/**
 * Resolve the final suggested filename for Discover UI and ready-queue hydration.
 *
 * @param {{ originalFileName: string, analysis: Record<string,any>, settings: Record<string,any>, fileTimestamps?: { created?: Date|string|null, modified?: Date|string|null }, trustMainProcess?: boolean }} params
 * @returns {string}
 */
function resolveDiscoverSuggestedName({
  originalFileName,
  analysis,
  settings,
  fileTimestamps,
  trustMainProcess = false
}) {
  if (!analysis || typeof analysis !== 'object') {
    return originalFileName || '';
  }

  const finalName = typeof analysis.suggestedName === 'string' ? analysis.suggestedName.trim() : '';

  if (trustMainProcess || mainProcessNamingAlreadyApplied(analysis, settings)) {
    if (finalName) return finalName;
  }

  const normalizedSettings = normalizeNamingConventionState(settings || {});
  if (!normalizedSettings.convention || normalizedSettings.convention === 'keep-original') {
    return finalName || originalFileName || '';
  }

  const analysisForNaming = buildAnalysisInputForNamingReapply(analysis);
  const regenerated = generateSuggestedNameFromAnalysis({
    originalFileName,
    analysis: analysisForNaming,
    settings: normalizedSettings,
    fileTimestamps: fileTimestamps || {}
  });

  return regenerated || finalName || originalFileName || '';
}

module.exports = {
  DEFAULT_NAMING_CONVENTION_STATE,
  normalizeNamingConventionState,
  normalizeSeparator,
  formatDate,
  applyCaseConvention,
  generatePreviewName,
  generateSuggestedNameFromAnalysis,
  buildAnalysisInputForNamingReapply,
  mainProcessNamingAlreadyApplied,
  resolveDiscoverSuggestedName,
  extractExtension,
  extractFileName,
  makeUniqueFileName
};
