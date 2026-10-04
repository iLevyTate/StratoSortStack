// @ts-check
/**
 * HTML and XML character-reference decoding shared by every tag stripper:
 * the main-thread HTML extractor, the text extraction worker and the SVG
 * text reader. Before this module each kept its own six-entity table, so
 * `caf&eacute;`, `it&#8217;s` and `&mdash;` survived into the indexed text
 * of .html, .epub, ODF, KML, PPTX fallbacks and mail bodies, and a search
 * for "café" missed the file.
 *
 * Numeric references (decimal and hex) are decoded in full; the named set
 * covers the XML predefined entities plus the HTML 4 Latin-1, typographic
 * and symbol names people actually meet in documents.
 */

/** @type {Record<string, string>} */
const NAMED_ENTITIES = Object.freeze({
  // XML predefined and the common HTML spacing entities
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  zwnj: '‌',
  zwj: '‍',
  shy: '­',
  // Typography
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  lsaquo: '‹',
  rsaquo: '›',
  hellip: '…',
  bull: '•',
  middot: '·',
  dagger: '†',
  Dagger: '‡',
  permil: '‰',
  prime: '′',
  Prime: '″',
  // Symbols
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  micro: 'µ',
  para: '¶',
  sect: '§',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  sup1: '¹',
  sup2: '²',
  sup3: '³',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  curren: '¤',
  iexcl: '¡',
  iquest: '¿',
  not: '¬',
  macr: '¯',
  acute: '´',
  cedil: '¸',
  ordf: 'ª',
  ordm: 'º',
  brvbar: '¦',
  uml: '¨',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
  harr: '↔',
  minus: '−',
  ne: '≠',
  le: '≤',
  ge: '≥',
  infin: '∞',
  sum: '∑',
  radic: '√',
  // Latin-1 letters
  Agrave: 'À',
  Aacute: 'Á',
  Acirc: 'Â',
  Atilde: 'Ã',
  Auml: 'Ä',
  Aring: 'Å',
  AElig: 'Æ',
  Ccedil: 'Ç',
  Egrave: 'È',
  Eacute: 'É',
  Ecirc: 'Ê',
  Euml: 'Ë',
  Igrave: 'Ì',
  Iacute: 'Í',
  Icirc: 'Î',
  Iuml: 'Ï',
  ETH: 'Ð',
  Ntilde: 'Ñ',
  Ograve: 'Ò',
  Oacute: 'Ó',
  Ocirc: 'Ô',
  Otilde: 'Õ',
  Ouml: 'Ö',
  Oslash: 'Ø',
  Ugrave: 'Ù',
  Uacute: 'Ú',
  Ucirc: 'Û',
  Uuml: 'Ü',
  Yacute: 'Ý',
  THORN: 'Þ',
  szlig: 'ß',
  agrave: 'à',
  aacute: 'á',
  acirc: 'â',
  atilde: 'ã',
  auml: 'ä',
  aring: 'å',
  aelig: 'æ',
  ccedil: 'ç',
  egrave: 'è',
  eacute: 'é',
  ecirc: 'ê',
  euml: 'ë',
  igrave: 'ì',
  iacute: 'í',
  icirc: 'î',
  iuml: 'ï',
  eth: 'ð',
  ntilde: 'ñ',
  ograve: 'ò',
  oacute: 'ó',
  ocirc: 'ô',
  otilde: 'õ',
  ouml: 'ö',
  oslash: 'ø',
  ugrave: 'ù',
  uacute: 'ú',
  ucirc: 'û',
  uuml: 'ü',
  yacute: 'ý',
  thorn: 'þ',
  yuml: 'ÿ',
  OElig: 'Œ',
  oelig: 'œ',
  Scaron: 'Š',
  scaron: 'š',
  Yuml: 'Ÿ',
  fnof: 'ƒ'
});

const ENTITY_PATTERN = /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{0,31});/g;

/**
 * Decode character references. Unknown names and invalid code points are
 * left as written, so nothing a document says is lost.
 * @param {string} text
 * @returns {string}
 */
function decodeHtmlEntities(text) {
  if (typeof text !== 'string' || text.indexOf('&') < 0) return text;
  return text.replace(ENTITY_PATTERN, (match, body) => {
    if (body.charCodeAt(0) === 0x23 /* # */) {
      const isHex = body.charCodeAt(1) === 0x78 || body.charCodeAt(1) === 0x58;
      const codePoint = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) return match;
      // A control character has no place in extracted text; NUL and the C0
      // range (bar tab, newline and return) and DEL are dropped, not kept
      // as the literal reference and not emitted as the raw byte.
      if (
        codePoint === 0x7f ||
        (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
      ) {
        return '';
      }
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    // Case matters for the letters (Aacute vs aacute); the XML five and
    // nbsp are also accepted in any case, as browsers do for HTML.
    const exact = NAMED_ENTITIES[body];
    if (exact !== undefined) return exact;
    const folded = NAMED_ENTITIES[body.toLowerCase()];
    return folded !== undefined && /^(amp|lt|gt|quot|apos|nbsp)$/i.test(body) ? folded : match;
  });
}

module.exports = { NAMED_ENTITIES, decodeHtmlEntities };
