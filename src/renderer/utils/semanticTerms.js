// @ts-check
import normalizeList from './normalizeList';

const SEMANTIC_STOPWORDS = new Set(
  [
    'a',
    'an',
    'and',
    'are',
    'as',
    'at',
    'be',
    'but',
    'by',
    'for',
    'from',
    'has',
    'have',
    'he',
    'her',
    'hers',
    'him',
    'his',
    'i',
    'if',
    'in',
    'into',
    'is',
    'it',
    'its',
    'me',
    'my',
    'no',
    'not',
    'of',
    'on',
    'or',
    'our',
    'ours',
    'she',
    'so',
    'that',
    'the',
    'their',
    'theirs',
    'them',
    'then',
    'there',
    'these',
    'they',
    'this',
    'those',
    'to',
    'too',
    'up',
    'us',
    'was',
    'we',
    'were',
    'what',
    'when',
    'where',
    'which',
    'who',
    'why',
    'with',
    'you',
    'your',
    'yours',
    'file',
    'files',
    'document',
    'documents',
    'image',
    'images',
    'photo',
    'photos',
    'report',
    'reports',
    'note',
    'notes',
    'draft',
    'final',
    // Extended filler / function words that leak into graph labels from body text
    'also',
    'just',
    'about',
    'more',
    'other',
    'some',
    'such',
    'very',
    'can',
    'will',
    'should',
    'may',
    'might',
    'been',
    'being',
    'had',
    'get',
    'got',
    'all',
    'any',
    'both',
    'each',
    'few',
    'many',
    'most',
    'own',
    'same',
    'out',
    'over',
    'under',
    'again',
    'further',
    'once',
    'here',
    'how',
    'off',
    'only',
    'could',
    'would',
    'shall',
    'must',
    'need',
    'like',
    'well',
    'even',
    'still',
    'back',
    'much',
    'way',
    'new',
    'old',
    'first',
    'last',
    'next',
    'per',
    'via',
    'make',
    'made',
    'use',
    'used',
    'using',
    'one',
    'two',
    'three',
    'page',
    'pages',
    'pdf',
    'doc'
  ].map((term) => String(term).toLowerCase())
);

export const normalizeSemanticTerm = (/** @type {any} */ value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');

export const isMeaningfulSemanticTerm = (/** @type {any} */ term, { minLength = 2 } = {}) => {
  const normalized = normalizeSemanticTerm(term);
  if (!normalized || normalized.length < minLength) return false;
  if (/^\d+$/.test(normalized)) return false;
  if (SEMANTIC_STOPWORDS.has(normalized)) return false;
  return true;
};

export const sanitizeSemanticTerms = (
  /** @type {any} */ terms,
  { maxTerms = Infinity, minLength = 2 } = {}
) => {
  if (!Array.isArray(terms) || terms.length === 0) return [];

  const seen = new Set();
  const cleaned = [];
  for (const term of terms) {
    const normalized = normalizeSemanticTerm(term);
    if (!isMeaningfulSemanticTerm(normalized, { minLength })) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    cleaned.push(normalized);
    if (cleaned.length >= maxTerms) break;
  }

  return cleaned;
};

/** Normalize tags/keywords/entities from graph metadata, then drop filler stopwords. */
export const sanitizeGraphMetadataTerms = (
  /** @type {any} */ value,
  { maxTerms = 5, minLength = 2 } = {}
) => sanitizeSemanticTerms(normalizeList(value), { maxTerms, minLength });
