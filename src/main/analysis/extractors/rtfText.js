// @ts-check
/**
 * RTF to plain text.
 *
 * The previous reader stripped braces and control words with two regexes,
 * which leaked font table names, the `\*\generator` group and `\pict` hex
 * data into the analyzed text and turned every `\uN` escape into "?". This
 * is a small tokenizer instead: it walks the groups, skips destinations that
 * never carry body text, decodes `\'xx` byte escapes (code page 1252 or
 * UTF-8 when the document says so) and `\uN` code units with their `\ucN`
 * fallback characters, and turns paragraph controls into line breaks.
 *
 * Shared by the main-thread extractor and the text extraction worker so both
 * produce the same text.
 */

/** Destinations whose content is never document text. */
const SKIPPED_DESTINATIONS = new Set([
  'fonttbl',
  'colortbl',
  'stylesheet',
  'listtable',
  'listoverridetable',
  'rsidtbl',
  'generator',
  'info',
  'pict',
  'object',
  'objdata',
  'xmlnstbl',
  'themedata',
  'colorschememapping',
  'latentstyles',
  'datastore',
  'mmathPr',
  'fchars',
  'lchars',
  'header',
  'footer',
  'headerl',
  'headerr',
  'headerf',
  'footerl',
  'footerr',
  'footerf',
  'ftnsep',
  'ftnsepc',
  'aftnsep',
  'aftnsepc',
  'bkmkstart',
  'bkmkend',
  'field',
  'fldinst',
  'operator',
  'panose',
  'blipuid',
  'shpinst',
  'shprslt',
  'sp',
  'sn',
  'sv',
  'wgrffmtfilter',
  'pgdsctbl',
  'revtbl',
  'protusertbl',
  'userprops'
]);

/** Control words that produce text of their own. */
const SYMBOL_WORDS = /** @type {Record<string, string>} */ ({
  par: '\n',
  line: '\n',
  sect: '\n',
  page: '\n',
  tab: '\t',
  cell: '\t',
  row: '\n',
  emdash: '—',
  endash: '–',
  emspace: ' ',
  enspace: ' ',
  qmspace: ' ',
  bullet: '•',
  lquote: '‘',
  rquote: '’',
  ldblquote: '“',
  rdblquote: '”',
  '~': ' ',
  '-': '',
  _: '-'
});

/**
 * Windows-1252 bytes 0x80-0x9F that differ from Latin-1.
 * @type {Record<number, string>}
 */
const WIN1252_EXTRAS = {
  0x80: '€',
  0x82: '‚',
  0x83: 'ƒ',
  0x84: '„',
  0x85: '…',
  0x86: '†',
  0x87: '‡',
  0x88: 'ˆ',
  0x89: '‰',
  0x8a: 'Š',
  0x8b: '‹',
  0x8c: 'Œ',
  0x8e: 'Ž',
  0x91: '‘',
  0x92: '’',
  0x93: '“',
  0x94: '”',
  0x95: '•',
  0x96: '–',
  0x97: '—',
  0x98: '˜',
  0x99: '™',
  0x9a: 'š',
  0x9b: '›',
  0x9c: 'œ',
  0x9e: 'ž',
  0x9f: 'Ÿ'
};

/**
 * @param {number[]} bytes
 * @param {boolean} utf8
 * @returns {string}
 */
function decodeBytes(bytes, utf8) {
  if (bytes.length === 0) return '';
  if (utf8 || bytes.length > 1) {
    const text = Buffer.from(bytes).toString('utf8');
    if (!text.includes('�')) return text;
  }
  return bytes.map((b) => WIN1252_EXTRAS[b] || String.fromCharCode(b)).join('');
}

/**
 * True when the string starts like an RTF document (optional whitespace, then
 * `{\rtf`).
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeRtf(text) {
  return /^\s*\{\s*\\rtf/i.test(text);
}

/**
 * Convert RTF markup to plain text. Non-RTF input is returned unchanged so a
 * mislabelled plain-text file is not destroyed.
 * @param {any} rtf
 * @returns {string}
 */
function rtfToText(rtf) {
  if (rtf === null || rtf === undefined) return '';
  const input = typeof rtf === 'string' ? rtf : String(rtf);
  if (input.length === 0) return '';
  if (!looksLikeRtf(input)) return input;

  const utf8 = /\\ansicpg65001\b/.test(input);
  /** @type {string[]} */
  const out = [];
  /** @type {number[]} */
  const pendingBytes = [];
  const flushBytes = () => {
    if (pendingBytes.length) {
      out.push(decodeBytes(pendingBytes.splice(0, pendingBytes.length), utf8));
    }
  };

  // Group state: skipDepth marks the depth at which a skipped destination
  // began; while set, nothing is emitted until the group closes.
  let depth = 0;
  let skipDepth = -1;
  /** Characters to drop after a \uN escape, per group (RTF default 1). */
  const ucStack = [1];
  let uc = 1;
  /** Fallback characters still to skip after the last \uN. */
  let skipChars = 0;
  /** Set right after `{` so the next control word can be tested as a destination. */
  let groupJustOpened = false;

  const n = input.length;
  let i = 0;
  while (i < n) {
    const ch = input[i];
    if (ch === '{') {
      flushBytes();
      depth += 1;
      ucStack.push(uc);
      groupJustOpened = true;
      skipChars = 0;
      i += 1;
      continue;
    }
    if (ch === '}') {
      flushBytes();
      if (skipDepth === depth) skipDepth = -1;
      depth = Math.max(0, depth - 1);
      uc = ucStack.length > 1 ? /** @type {number} */ (ucStack.pop()) : 1;
      groupJustOpened = false;
      skipChars = 0;
      i += 1;
      continue;
    }
    if (ch === '\\') {
      const next = input[i + 1];
      if (next === undefined) break;
      // Byte escape \'xx
      if (next === "'") {
        const hex = input.slice(i + 2, i + 4);
        i += 4;
        if (skipDepth !== -1) continue;
        if (skipChars > 0) {
          skipChars -= 1;
          continue;
        }
        if (/^[0-9a-fA-F]{2}$/.test(hex)) pendingBytes.push(parseInt(hex, 16));
        continue;
      }
      // Destination marker \* : the group is a destination; skip unless the
      // control word that follows is a known text destination (none are).
      if (next === '*') {
        i += 2;
        if (groupJustOpened && skipDepth === -1) skipDepth = depth;
        continue;
      }
      // Escaped literal characters
      if (next === '\\' || next === '{' || next === '}') {
        i += 2;
        if (skipDepth === -1 && skipChars === 0) {
          flushBytes();
          out.push(next);
        } else if (skipChars > 0) skipChars -= 1;
        continue;
      }
      // Control symbols (single non-letter)
      if (!/[a-zA-Z]/.test(next)) {
        i += 2;
        if (skipDepth === -1) {
          const sym = SYMBOL_WORDS[next];
          if (sym !== undefined) {
            flushBytes();
            out.push(sym);
          } else if (next === '\n' || next === '\r') {
            flushBytes();
            out.push('\n');
          }
        }
        continue;
      }
      // Control word: letters, optional signed number, optional single space
      let j = i + 1;
      while (j < n && /[a-zA-Z]/.test(input[j])) j += 1;
      const word = input.slice(i + 1, j);
      let numStr = '';
      if (j < n && (input[j] === '-' || /[0-9]/.test(input[j]))) {
        let k = j;
        if (input[k] === '-') k += 1;
        while (k < n && /[0-9]/.test(input[k])) k += 1;
        numStr = input.slice(j, k);
        j = k;
      }
      if (j < n && input[j] === ' ') j += 1;
      i = j;

      if (groupJustOpened && SKIPPED_DESTINATIONS.has(word) && skipDepth === -1) {
        skipDepth = depth;
      }
      groupJustOpened = false;
      if (skipDepth !== -1) continue;

      if (word === 'uc') {
        uc = Math.max(0, parseInt(numStr || '1', 10) || 0);
        continue;
      }
      if (word === 'u') {
        flushBytes();
        let code = parseInt(numStr, 10);
        if (Number.isFinite(code)) {
          if (code < 0) code += 65536;
          if (code >= 0 && code <= 0xffff) out.push(String.fromCharCode(code));
        }
        skipChars = uc;
        continue;
      }
      const sym = SYMBOL_WORDS[word];
      if (sym !== undefined) {
        flushBytes();
        out.push(sym);
      }
      continue;
    }
    // Plain character
    i += 1;
    if (skipDepth !== -1) continue;
    if (ch === '\r' || ch === '\n') continue;
    if (skipChars > 0) {
      skipChars -= 1;
      continue;
    }
    flushBytes();
    out.push(ch);
  }
  flushBytes();

  return out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

module.exports = { rtfToText, looksLikeRtf, SKIPPED_DESTINATIONS };
