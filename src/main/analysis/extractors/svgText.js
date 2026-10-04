// @ts-check
/**
 * SVG to plain text.
 *
 * Collects the human-readable parts of an SVG document (`<title>`, `<desc>`,
 * `<text>`, `<tspan>`, `<textPath>` and the Dublin Core title/description
 * inside `<metadata>`) in document order and returns them as plain lines a
 * language model can summarize. Everything else - styles, scripts, path
 * data, gradients, embedded images - is never emitted.
 *
 * The scanner is a single forward pass driven by `indexOf`, so a multi-MB
 * document is handled in tens of milliseconds and no regex ever runs over
 * the whole input (no catastrophic backtracking). Attribute values may
 * contain `>` and tags may be self-closing; namespace-prefixed documents
 * (`<svg:svg>`, `<svg:text>`) are read like unprefixed ones. Malformed or
 * truncated markup degrades to partial text rather than an exception: a `<`
 * that does not start a tag (`a < b` in a script or label) is literal text,
 * and a tag that never closes before the next tag begins ends there, so one
 * unbalanced quote cannot swallow the rest of the document.
 *
 * Shared by the main-thread extractor and the text extraction worker.
 *
 * @module analysis/extractors/svgText
 */

const { createLogger } = require('../../../shared/logger');

const logger = createLogger('SvgText');

const DEFAULT_MAX_CHARS = 20000;
/** Bytes (or string characters) decoded at most; the rest is ignored. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
/** How much of the head of a file is sniffed for the `<svg` root tag. */
const SNIFF_BYTES = 2048;

/** Elements whose character data is document text (lower-case local names). */
const TEXT_ELEMENTS = new Set(['title', 'desc', 'text', 'tspan', 'textpath']);
/** Elements collected inside `<metadata>` (lower-case qualified names). */
const METADATA_TEXT_ELEMENTS = new Set(['dc:title', 'dc:description']);
/** Elements whose whole body is skipped without inspection (local names). */
const OPAQUE_ELEMENTS = new Set(['style', 'script']);

/** `<svg` or `<prefix:svg` followed by whitespace, `/`, `>` or the end of input. */
const SVG_ROOT_RE = /<(?:[A-Za-z_][\w.-]*:)?svg(?=[\s/>]|$)/i;

/** C0 controls (other than the whitespace ones) and DEL: never useful text. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000e-\u001f\u007f]/g;

const { decodeHtmlEntities } = require('./htmlEntities');

/**
 * @typedef {Object} ExtractOptions
 * @property {number} [maxChars] Cap on the returned text (default 20000).
 * @property {number} [maxBytes] Bytes decoded at most (default 64 MiB); text
 *   beyond this point in the document is not read.
 */

/**
 * Extract the readable text of an SVG document.
 *
 * @param {string | Buffer | Uint8Array | null | undefined} svg Document source.
 * @param {ExtractOptions} [options]
 * @returns {string} Unique non-empty lines joined with `\n`, truncated to
 *   `maxChars`; `''` for non-SVG input or a document without text.
 */
function extractTextFromSvg(svg, options = {}) {
  const opts = options || {};
  const maxChars = toBoundedInt(opts.maxChars, DEFAULT_MAX_CHARS, 0);
  const maxBytes = toBoundedInt(opts.maxBytes, DEFAULT_MAX_BYTES, 1);
  if (maxChars === 0) return '';

  let source;
  try {
    source = toSourceString(svg, maxBytes);
  } catch (err) {
    logger.debug('[SvgText] Could not decode SVG input', { error: toMessage(err) });
    return '';
  }
  if (!source) return '';

  const rootIndex = findSvgRoot(source);
  if (rootIndex < 0) {
    logger.debug('[SvgText] Input has no <svg> root; skipping', { chars: source.length });
    return '';
  }

  /** @type {Collector} */
  const collector = { lines: [], seen: new Set(), total: 0, limit: maxChars };
  try {
    scan(source, rootIndex, source.length, TEXT_ELEMENTS, collector);
  } catch (err) {
    // The scanner is defensive; this only guards the contract (never throw).
    logger.debug('[SvgText] Scanner aborted on malformed markup', { error: toMessage(err) });
  }

  if (collector.lines.length === 0) return '';
  const text = collector.lines.join('\n');
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/**
 * Cheap sniff for SVG content: an `<svg` (or `<prefix:svg`) tag within the
 * first 2 KB, case-insensitive.
 *
 * @param {Buffer | Uint8Array | string | null | undefined} buffer File head or whole file.
 * @returns {boolean}
 */
function looksLikeSvg(buffer) {
  if (buffer == null) return false;
  let head;
  if (typeof buffer === 'string') {
    head = buffer.slice(0, SNIFF_BYTES);
  } else if (Buffer.isBuffer(buffer) || buffer instanceof Uint8Array) {
    head = decodeBuffer(
      Buffer.from(buffer.buffer, buffer.byteOffset, Math.min(buffer.byteLength, SNIFF_BYTES))
    );
  } else {
    return false;
  }
  return SVG_ROOT_RE.test(head);
}

/**
 * @typedef {Object} Collector
 * @property {string[]} lines Output lines in document order.
 * @property {Set<string>} seen Lines already emitted (dedupe).
 * @property {number} total Characters emitted so far, including separators.
 * @property {number} limit Stop collecting once `total` reaches this.
 */

/**
 * Walk `source[start, end)` once, collecting the content of every element in
 * `collectSet`. Recurses into `<metadata>` with the Dublin Core set.
 *
 * @param {string} source
 * @param {number} start
 * @param {number} end Exclusive bound.
 * @param {Set<string>} collectSet Lower-case element names to collect.
 * @param {Collector} out
 */
function scan(source, start, end, collectSet, out) {
  let pos = start;
  while (pos < end && out.total < out.limit) {
    const lt = source.indexOf('<', pos);
    if (lt < 0 || lt >= end) break;
    if (!startsTag(source, lt)) {
      // A bare `<` in character data (`a < b`): not markup.
      pos = lt + 1;
      continue;
    }

    const special = skipSpecialConstruct(source, lt, end);
    if (special >= 0) {
      pos = special;
      continue;
    }

    if (source.charCodeAt(lt + 1) === 0x2f /* / */) {
      // Stray or unmatched closing tag: step over it.
      pos = boundedAfter(source, '>', lt + 2, end);
      continue;
    }

    const tag = parseOpenTag(source, lt, end);
    if (!tag) break;
    if (tag.selfClosing || tag.name.length === 0) {
      pos = tag.end;
      continue;
    }

    const name = tag.name;
    const local = localName(name);
    const collected = collectSet === TEXT_ELEMENTS ? collectSet.has(local) : collectSet.has(name);
    if (collected) {
      const close = findMatchingClose(source, name, tag.end, end);
      emit(out, stripMarkup(source, tag.end, close.contentEnd));
      pos = close.resume;
      continue;
    }
    if (OPAQUE_ELEMENTS.has(local)) {
      pos = findMatchingClose(source, name, tag.end, end).resume;
      continue;
    }
    if (local === 'metadata' && collectSet !== METADATA_TEXT_ELEMENTS) {
      const close = findMatchingClose(source, name, tag.end, end);
      scan(source, tag.end, close.contentEnd, METADATA_TEXT_ELEMENTS, out);
      pos = close.resume;
      continue;
    }
    pos = tag.end;
  }
}

/**
 * Does the `<` at `lt` begin markup? XML allows a tag, a closing tag, a
 * comment/CDATA/declaration or a processing instruction; anything else
 * (`< `, `<1`, `<<`, a trailing `<`) is a literal angle bracket.
 *
 * @param {string} source
 * @param {number} lt Index of `<`.
 * @returns {boolean}
 */
function startsTag(source, lt) {
  const next = source.charCodeAt(lt + 1);
  return (
    isNameStart(next) || next === 0x2f /* / */ || next === 0x21 /* ! */ || next === 0x3f
  ); /* ? */
}

/** @param {number} code */
function isNameStart(code) {
  return (
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x41 && code <= 0x5a) || // A-Z
    code === 0x5f || // _
    code === 0x3a || // :
    code >= 0x80 // non-ASCII name characters
  );
}

/**
 * Skip comments, CDATA sections, processing instructions and declarations
 * that start at `lt`.
 *
 * @param {string} source
 * @param {number} lt Index of `<`.
 * @param {number} end Exclusive bound.
 * @returns {number} Index to resume from, or -1 when `lt` starts an ordinary tag.
 */
function skipSpecialConstruct(source, lt, end) {
  const next = source.charCodeAt(lt + 1);
  if (next === 0x21 /* ! */) {
    if (source.startsWith('<!--', lt)) return boundedAfter(source, '-->', lt + 4, end);
    if (source.startsWith('<![CDATA[', lt)) return boundedAfter(source, ']]>', lt + 9, end);
    return boundedAfter(source, '>', lt + 2, end);
  }
  if (next === 0x3f /* ? */) return boundedAfter(source, '?>', lt + 2, end);
  return -1;
}

/**
 * @param {string} source
 * @param {string} needle
 * @param {number} from
 * @param {number} end Exclusive bound.
 * @returns {number} Index just past `needle`, or `end` when it is absent.
 */
function boundedAfter(source, needle, from, end) {
  const idx = source.indexOf(needle, from);
  return idx < 0 || idx >= end ? end : Math.min(end, idx + needle.length);
}

/**
 * @typedef {Object} OpenTag
 * @property {string} name Lower-case qualified element name (may be empty).
 * @property {number} end Index to resume from: just past the closing `>`, or
 *   at the `<` of the next tag when this one never closed.
 * @property {boolean} selfClosing True for `<x ... />`.
 */

/**
 * Parse the tag starting at `lt`, honouring quoted attribute values so a `>`
 * inside quotes does not end the tag. A `<` that begins another tag ends
 * this one even inside quotes: XML forbids a raw `<` in attribute values, so
 * the only way to get there is an unbalanced quote, and stopping keeps the
 * damage to one tag.
 *
 * @param {string} source
 * @param {number} lt Index of `<`.
 * @param {number} end Exclusive bound.
 * @returns {OpenTag | null} `null` when the tag never closes before `end`.
 */
function parseOpenTag(source, lt, end) {
  let i = lt + 1;
  while (i < end && !isNameTerminator(source.charCodeAt(i))) i += 1;
  const name = source.slice(lt + 1, i).toLowerCase();

  /** @type {number} */
  let quote = 0;
  while (i < end) {
    const code = source.charCodeAt(i);
    if (code === 0x3c /* < */ && startsTag(source, i)) {
      return { name, end: i, selfClosing: false };
    }
    if (quote !== 0) {
      if (code === quote) quote = 0;
    } else if (code === 0x22 || code === 0x27) {
      quote = code;
    } else if (code === 0x3e /* > */) {
      const selfClosing = source.charCodeAt(i - 1) === 0x2f /* / */ && i - 1 > lt;
      return { name, end: i + 1, selfClosing };
    }
    i += 1;
  }
  return null;
}

/** @param {number} code */
function isNameTerminator(code) {
  return (
    code === 0x20 ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    code === 0x0c ||
    code === 0x3e /* > */ ||
    code === 0x2f /* / */ ||
    code === 0x3c /* < */
  );
}

/**
 * `dc:title` -> `title`; names without a prefix are returned unchanged.
 *
 * @param {string} name Lower-case qualified name.
 * @returns {string}
 */
function localName(name) {
  const colon = name.lastIndexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

/**
 * @typedef {Object} CloseMatch
 * @property {number} contentEnd Index where the element's content stops.
 * @property {number} resume Index just past the closing tag.
 */

/**
 * Find the closing tag that balances an open `<name>` whose content starts at
 * `from`, tracking same-name nesting (`<tspan>` inside `<tspan>`). Attribute
 * quotes are honoured; comments and CDATA inside the element are stepped over
 * so a `</name>` inside them is not mistaken for the real close.
 *
 * @param {string} source
 * @param {string} name Lower-case qualified element name.
 * @param {number} from
 * @param {number} end Exclusive bound.
 * @returns {CloseMatch} Falls back to `end` for both fields when unclosed.
 */
function findMatchingClose(source, name, from, end) {
  let depth = 1;
  let pos = from;
  while (pos < end) {
    const lt = source.indexOf('<', pos);
    if (lt < 0 || lt >= end) break;
    if (!startsTag(source, lt)) {
      pos = lt + 1;
      continue;
    }

    const special = skipSpecialConstruct(source, lt, end);
    if (special >= 0) {
      pos = special;
      continue;
    }

    if (source.charCodeAt(lt + 1) === 0x2f /* / */) {
      const closeEnd = boundedAfter(source, '>', lt + 2, end);
      if (tagNameMatches(source, lt + 2, name, end)) {
        depth -= 1;
        if (depth === 0) return { contentEnd: lt, resume: closeEnd };
      }
      pos = closeEnd;
      continue;
    }

    const tag = parseOpenTag(source, lt, end);
    if (!tag) break;
    if (!tag.selfClosing && tag.name === name) depth += 1;
    pos = tag.end;
  }
  return { contentEnd: end, resume: end };
}

/**
 * Case-insensitive check that the element name at `at` equals `name` and is
 * followed by a name terminator.
 *
 * @param {string} source
 * @param {number} at
 * @param {string} name Lower-case.
 * @param {number} end Exclusive bound.
 */
function tagNameMatches(source, at, name, end) {
  const stop = at + name.length;
  if (stop > end) return false;
  if (source.slice(at, stop).toLowerCase() !== name) return false;
  return stop === end || isNameTerminator(source.charCodeAt(stop));
}

/**
 * Turn the markup between `from` and `to` into one collapsed line: inner tags
 * become a single space, comments vanish, CDATA keeps its literal content,
 * a bare `<` stays and character references are decoded.
 *
 * @param {string} source
 * @param {number} from
 * @param {number} to Exclusive bound.
 * @returns {string}
 */
function stripMarkup(source, from, to) {
  /** @type {string[]} */
  const parts = [];
  let pos = from;
  let search = from;
  while (pos < to) {
    const lt = source.indexOf('<', search);
    if (lt < 0 || lt >= to) {
      parts.push(decodeEntities(source.slice(pos, to)));
      break;
    }
    if (!startsTag(source, lt)) {
      search = lt + 1;
      continue;
    }
    if (lt > pos) parts.push(decodeEntities(source.slice(pos, lt)));

    if (source.startsWith('<![CDATA[', lt)) {
      const close = source.indexOf(']]>', lt + 9);
      const stop = close < 0 || close >= to ? to : close;
      parts.push(source.slice(lt + 9, stop));
      pos = stop === to ? to : stop + 3;
    } else if (source.startsWith('<!--', lt)) {
      pos = boundedAfter(source, '-->', lt + 4, to);
    } else {
      const tag = parseOpenTag(source, lt, to);
      parts.push(' ');
      pos = tag ? tag.end : to;
    }
    search = pos;
  }
  return collapseWhitespace(parts.join(''));
}

/**
 * Character references: the shared table (XML predefined, HTML 4 Latin-1
 * and typographic names) plus numeric references.
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  return decodeHtmlEntities(text);
}

/**
 * @param {string} text
 * @returns {string}
 */
function collapseWhitespace(text) {
  return text.replace(CONTROL_CHARS_RE, '').replace(/\s+/g, ' ').trim();
}

/**
 * Append a line unless it is empty or already present; bump the running total.
 *
 * @param {Collector} out
 * @param {string} line
 */
function emit(out, line) {
  if (line.length === 0 || out.seen.has(line)) return;
  out.seen.add(line);
  out.lines.push(line);
  out.total += line.length + 1;
}

/**
 * Locate the `<svg` root tag (case-insensitive, optionally namespace-prefixed)
 * anywhere in the document. Returns the index of its `<` so scanning can
 * start there, or -1.
 *
 * @param {string} source
 * @returns {number}
 */
function findSvgRoot(source) {
  const match = SVG_ROOT_RE.exec(source);
  return match ? match.index : -1;
}

/**
 * @param {string | Buffer | Uint8Array | null | undefined} svg
 * @param {number} maxBytes
 * @returns {string}
 */
function toSourceString(svg, maxBytes) {
  if (svg == null) return '';
  /** @type {string} */
  let text;
  /** @type {number} */
  let inputLength;
  if (typeof svg === 'string') {
    inputLength = svg.length;
    text = inputLength > maxBytes ? svg.slice(0, maxBytes) : svg;
  } else if (Buffer.isBuffer(svg) || svg instanceof Uint8Array) {
    inputLength = svg.byteLength;
    const bytes = Buffer.from(svg.buffer, svg.byteOffset, Math.min(inputLength, maxBytes));
    text = decodeBuffer(bytes);
  } else {
    return '';
  }
  if (inputLength > maxBytes) {
    logger.debug('[SvgText] Input exceeds decode cap; reading the head only', {
      inputLength,
      maxBytes
    });
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Decode bytes as UTF-8, or as UTF-16 when a byte-order mark says so.
 *
 * @param {Buffer} bytes
 * @returns {string}
 */
function decodeBuffer(bytes) {
  if (bytes.length >= 2) {
    const b0 = bytes[0];
    const b1 = bytes[1];
    if (b0 === 0xff && b1 === 0xfe) return bytes.toString('utf16le', 2);
    if (b0 === 0xfe && b1 === 0xff) {
      const evenLength = (bytes.length - 2) & ~1;
      return Buffer.from(bytes.subarray(2, 2 + evenLength))
        .swap16()
        .toString('utf16le');
    }
  }
  return bytes.toString('utf8');
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 */
function toBoundedInt(value, fallback, min) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/** @param {unknown} err */
function toMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

module.exports = {
  extractTextFromSvg,
  looksLikeSvg
};
