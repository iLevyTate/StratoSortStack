// @ts-check
/**
 * EPUB structure reader: `META-INF/container.xml` -> OPF package document ->
 * title / creators / language, manifest and spine.
 *
 * The OPF decides the reading order of a book; without it the archive order
 * does, and the book's own title never reaches the extracted text. Everything
 * here is parsed with namespace-tolerant regexes (no XML library), reads are
 * bounded by bytes so a crafted entry cannot be inflated whole, and malformed
 * input yields `null` / `''` plus a debug log rather than an exception. The
 * caller owns the zip handle and the filesystem, so filesystem errors are not
 * this module's concern.
 *
 * @module analysis/extractors/epubStructure
 */

const path = require('path');
const zlib = require('zlib');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('EpubStructure');

/**
 * Structural view of an adm-zip entry (only what this module touches).
 * @typedef {Object} ZipEntryLike
 * @property {string} entryName Entry path inside the archive (forward slashes).
 * @property {boolean} [isDirectory]
 * @property {{ size?: number, method?: number }} [header]
 * @property {() => Buffer} getData
 * @property {() => Buffer} [getCompressedData]
 */

/**
 * Structural view of an adm-zip instance.
 * @typedef {Object} ZipLike
 * @property {(name: string) => ZipEntryLike | null | undefined} getEntry
 * @property {() => ZipEntryLike[]} getEntries
 */

/**
 * @typedef {Object} EpubStructure
 * @property {string | null} title First `dc:title`, tags stripped and entities decoded.
 * @property {string[]} creators Every `dc:creator`, deduped, in document order.
 * @property {string | null} language First `dc:language`.
 * @property {string} opfPath Zip entry name of the package document.
 * @property {string[]} spineEntryNames Zip entry names in spine order (only entries
 *   that exist in the archive; `linear="no"` items dropped when a linear item exists).
 * @property {number} manifestCount Number of `<item>` elements in the manifest.
 */

/** @typedef {{ attrs: string, inner: string }} XmlElement */

const CONTAINER_PATH = 'META-INF/container.xml';
const OPF_MEDIA_TYPE_RE = /application\/oebps-package\+xml/i;
const TEXT_ENTRY_RE = /\.(?:xhtml|html|htm)$/i;
const ZIP_METHOD_DEFLATED = 8;

const MAX_CONTAINER_BYTES = 1024 * 1024;
const MAX_OPF_BYTES = 8 * 1024 * 1024;
const MAX_ROOTFILES = 50;
const MAX_MANIFEST_ITEMS = 50000;
const MAX_SPINE_ITEMS = 10000;
const MAX_METADATA_ELEMENTS = 200;
const MAX_CREATORS = 50;
const MAX_FIELD_CHARS = 500;
const MAX_LANGUAGE_CHARS = 50;
// Raw markup a single metadata field is allowed to hand the text cleaner.
const MAX_RAW_FIELD_CHARS = 16384;
const MAX_OUTPUT_CHARS = 20000;

/** @type {Record<string, string>} */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»'
};

// ---------------------------------------------------------------------------
// Zip helpers
// ---------------------------------------------------------------------------

/**
 * Inflate a zip entry with a hard byte cap. Deflated entries go through zlib
 * with `maxOutputLength` (a real pre-inflate limit); stored entries are
 * bounded by their actual length. Returns `null` for anything over the cap,
 * empty, or unreadable.
 *
 * @param {ZipEntryLike | null | undefined} entry
 * @param {number} maxBytes
 * @returns {Buffer | null}
 */
function readEntryBounded(entry, maxBytes) {
  if (!entry || entry.isDirectory || typeof entry.getData !== 'function') return null;
  const declared = Number(entry.header?.size ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    logger.debug('[EPUB] Skipping oversized zip entry', {
      entry: entry.entryName,
      declaredSize: declared,
      maxBytes
    });
    return null;
  }
  try {
    const method = Number(entry.header?.method ?? -1);
    /** @type {Buffer | null | undefined} */
    let data;
    if (method === ZIP_METHOD_DEFLATED && typeof entry.getCompressedData === 'function') {
      const compressed = entry.getCompressedData();
      if (!compressed || compressed.length === 0) return null;
      // Throws ERR_BUFFER_TOO_LARGE the moment output exceeds maxBytes.
      data = zlib.inflateRawSync(compressed, { maxOutputLength: maxBytes });
    } else {
      data = entry.getData();
    }
    if (!data || data.length === 0 || data.length > maxBytes) return null;
    return data;
  } catch (error) {
    logger.debug('[EPUB] Failed to inflate zip entry', {
      entry: entry.entryName,
      error: error?.message
    });
    return null;
  }
}

/**
 * Decode an XML buffer to a string, honouring a UTF-16 BOM and dropping a
 * UTF-8 BOM. EPUB XML is UTF-8 in practice; UTF-16 is permitted by the spec.
 *
 * @param {Buffer | null} buffer
 * @returns {string}
 */
function bufferToXml(buffer) {
  if (!buffer || buffer.length === 0) return '';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    // swap16 requires an even length; a trailing odd byte is not a code unit.
    const end = buffer.length - ((buffer.length - 2) % 2);
    return Buffer.from(buffer.subarray(2, end)).swap16().toString('utf16le');
  }
  const text = buffer.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Find the real entry name for a path: exact match first, then a
 * case-insensitive match over all file entries (built once per call site).
 *
 * @param {ZipLike} zip
 * @param {{ lower: Map<string, string> | null }} cache Lazily built lowercase index.
 * @param {string} name
 * @returns {string | null}
 */
function resolveEntryName(zip, cache, name) {
  if (!name) return null;
  const direct = zip.getEntry(name);
  // adm-zip keeps its entry table in a plain object, so a crafted href such as
  // "constructor" or "__proto__" comes back as an Object.prototype member
  // rather than an entry; only a real entry carries a string name.
  if (direct && !direct.isDirectory && typeof direct.entryName === 'string') {
    return direct.entryName;
  }
  if (!cache.lower) {
    cache.lower = new Map();
    for (const entry of zip.getEntries()) {
      if (!entry || entry.isDirectory || typeof entry.entryName !== 'string') continue;
      const key = entry.entryName.toLowerCase();
      if (!cache.lower.has(key)) cache.lower.set(key, entry.entryName);
    }
  }
  return cache.lower.get(name.toLowerCase()) || null;
}

// ---------------------------------------------------------------------------
// XML helpers (regex based; tolerant of any namespace prefix)
// ---------------------------------------------------------------------------

/** Compiled once per attribute name; a large manifest reads it 100k+ times. */
/** @type {Map<string, RegExp>} */
const ATTR_RE_CACHE = new Map();

/**
 * Read one attribute from an element's attribute string. Accepts single or
 * double quotes, any attribute order, and is case-insensitive on the name.
 *
 * @param {string} attrs
 * @param {string} name Literal attribute name (no regex metacharacters).
 * @returns {string | null}
 */
function getAttr(attrs, name) {
  let re = ATTR_RE_CACHE.get(name);
  if (!re) {
    re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
    ATTR_RE_CACHE.set(name, re);
  }
  const match = re.exec(attrs);
  if (!match) return null;
  const value = match[1] !== undefined ? match[1] : match[2];
  return value === undefined ? null : value;
}

/**
 * Find elements by local name, ignoring any namespace prefix. Handles both
 * self-closing (`<x .../>`) and paired (`<x ...>inner</x>`) forms; an unclosed
 * paired element yields an empty `inner`.
 *
 * @param {string} xml
 * @param {string} localName Literal element local name.
 * @param {number} limit Maximum number of elements to collect.
 * @returns {XmlElement[]}
 */
function findElements(xml, localName, limit) {
  /** @type {XmlElement[]} */
  const results = [];
  // `[^<>]*`, not `[^>]*`: an opener that never reaches `>` must give up at
  // the next `<`, otherwise every unclosed `<item ` rescans to the end of the
  // document and a few hundred KB of them cost tens of seconds.
  const openRe = new RegExp(`<(?:[\\w.-]+:)?${localName}(?=[\\s/>])([^<>]*)>`, 'gi');
  const closeRe = new RegExp(`</(?:[\\w.-]+:)?${localName}\\s*>`, 'gi');
  // Once no closing tag exists past some position, none exists for any later
  // opener either; remembering that keeps a run of unclosed elements linear.
  let closersExhausted = false;
  let match;
  while (results.length < limit && (match = openRe.exec(xml)) !== null) {
    const attrs = match[1] || '';
    if (attrs.endsWith('/')) {
      results.push({ attrs: attrs.slice(0, -1), inner: '' });
      continue;
    }
    if (closersExhausted) {
      results.push({ attrs, inner: '' });
      continue;
    }
    closeRe.lastIndex = openRe.lastIndex;
    const close = closeRe.exec(xml);
    if (!close) {
      closersExhausted = true;
      results.push({ attrs, inner: '' });
      continue;
    }
    results.push({ attrs, inner: xml.slice(openRe.lastIndex, close.index) });
    openRe.lastIndex = closeRe.lastIndex;
  }
  return results;
}

/**
 * Inner XML of the first element with this local name, or `null` when absent.
 *
 * @param {string} xml
 * @param {string} localName
 * @returns {string | null}
 */
function sectionOf(xml, localName) {
  const [first] = findElements(xml, localName, 1);
  return first ? first.inner : null;
}

/**
 * Decode numeric and common named XML/HTML entities. Unknown named entities
 * are left as written.
 *
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi,
    (/** @type {string} */ whole, /** @type {string} */ body) => {
      if (body[0] === '#') {
        const hex = body[1] === 'x' || body[1] === 'X';
        const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
        if (code >= 0xd800 && code <= 0xdfff) return '';
        return String.fromCodePoint(code);
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named === undefined ? whole : named;
    }
  );
}

/**
 * Cap the raw markup of one field. A title is capped at 500 characters of
 * text, so scanning megabytes of markup for it is wasted work; the cut lands
 * before a dangling `<` so a truncated tag does not leak into the text.
 *
 * @param {string} raw
 * @returns {string}
 */
function boundRawField(raw) {
  if (raw.length <= MAX_RAW_FIELD_CHARS) return raw;
  const cut = raw.slice(0, MAX_RAW_FIELD_CHARS);
  const lastOpen = cut.lastIndexOf('<');
  return lastOpen > cut.lastIndexOf('>') ? cut.slice(0, lastOpen) : cut;
}

/**
 * Unwrap `<![CDATA[...]]>` sections with index scans rather than a lazy
 * regex, which rescans to the end for every opener that has no closer.
 *
 * @param {string} text
 * @returns {string}
 */
function unwrapCdata(text) {
  const OPEN = '<![CDATA[';
  const CLOSE = ']]>';
  let start = text.indexOf(OPEN);
  if (start < 0) return text;
  let out = '';
  let cursor = 0;
  while (start >= 0) {
    const bodyStart = start + OPEN.length;
    const end = text.indexOf(CLOSE, bodyStart);
    out += text.slice(cursor, start);
    if (end < 0) {
      out += text.slice(bodyStart);
      return out;
    }
    out += text.slice(bodyStart, end);
    cursor = end + CLOSE.length;
    start = text.indexOf(OPEN, cursor);
  }
  return out + text.slice(cursor);
}

/**
 * Turn element content into one trimmed line: CDATA unwrapped, tags stripped,
 * entities decoded, control characters removed, whitespace collapsed, capped.
 *
 * @param {string | null | undefined} raw
 * @param {number} maxChars
 * @returns {string}
 */
function cleanText(raw, maxChars) {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  let text = unwrapCdata(boundRawField(raw));
  // `[^<>]*`, not `[^>]*`: a run of `<` with no `>` must not rescan quadratically.
  text = text.replace(/<[^<>]*>/g, ' ');
  text = decodeEntities(text);
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is being removed
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > maxChars ? text.slice(0, maxChars).trim() : text;
}

/**
 * @param {string} raw
 * @returns {string}
 */
function safeDecodeURIComponent(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Resolve an href from the OPF (or a `full-path` from container.xml, with
 * `baseDir` `''`) to a normalised zip entry path. Fragments are dropped,
 * percent-encoding is decoded, and anything external or escaping the archive
 * root yields `null`.
 *
 * @param {string} href
 * @param {string} baseDir Directory the href is relative to ('' for the root).
 * @returns {string | null}
 */
function resolveHref(href, baseDir) {
  let value = decodeEntities(href).trim();
  if (!value) return null;
  const hash = value.indexOf('#');
  if (hash >= 0) value = value.slice(0, hash);
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  value = safeDecodeURIComponent(value).replace(/\\/g, '/');
  if (!value) return null;
  const joined = value.startsWith('/') ? value.slice(1) : path.posix.join(baseDir, value);
  const normalized = path.posix.normalize(joined).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    return null;
  }
  return normalized;
}

/**
 * @param {string[]} names
 * @returns {string[]}
 */
function dedupe(names) {
  return Array.from(new Set(names));
}

// ---------------------------------------------------------------------------
// EPUB parsing
// ---------------------------------------------------------------------------

/**
 * Pick the package document path out of container.xml: the rootfile declaring
 * the OPF media type wins, otherwise the first rootfile.
 *
 * @param {string} containerXml
 * @returns {string | null}
 */
function parseContainerRootfile(containerXml) {
  const rootfiles = findElements(containerXml, 'rootfile', MAX_ROOTFILES);
  if (rootfiles.length === 0) return null;
  const preferred = rootfiles.find((element) =>
    OPF_MEDIA_TYPE_RE.test(getAttr(element.attrs, 'media-type') || '')
  );
  const fullPath = getAttr((preferred || rootfiles[0]).attrs, 'full-path');
  return fullPath ? resolveHref(fullPath, '') : null;
}

/**
 * Read the first non-empty text value of the named metadata elements.
 *
 * @param {string} metadataXml
 * @param {string} localName
 * @param {number} maxChars
 * @returns {string | null}
 */
function firstMetadataValue(metadataXml, localName, maxChars) {
  for (const element of findElements(metadataXml, localName, MAX_METADATA_ELEMENTS)) {
    const value = cleanText(element.inner, maxChars);
    if (value) return value;
  }
  return null;
}

/**
 * Read the book structure from an open EPUB archive.
 *
 * Returns `null` when container.xml, the package document or its `<spine>`
 * element is missing or unreadable; an empty but present spine yields a
 * structure with no `spineEntryNames` so the caller can fall back to archive
 * order while keeping the metadata. Never throws.
 *
 * @param {ZipLike} zip adm-zip instance already opened by the caller.
 * @returns {EpubStructure | null}
 */
function readEpubStructure(zip) {
  if (!zip || typeof zip.getEntry !== 'function' || typeof zip.getEntries !== 'function') {
    return null;
  }
  try {
    /** @type {{ lower: Map<string, string> | null }} */
    const cache = { lower: null };

    const containerName = resolveEntryName(zip, cache, CONTAINER_PATH);
    if (!containerName) {
      logger.debug('[EPUB] container.xml not found');
      return null;
    }
    const containerXml = bufferToXml(
      readEntryBounded(zip.getEntry(containerName), MAX_CONTAINER_BYTES)
    );
    const opfRelative = containerXml ? parseContainerRootfile(containerXml) : null;
    if (!opfRelative) {
      logger.debug('[EPUB] container.xml has no usable rootfile');
      return null;
    }

    const opfName = resolveEntryName(zip, cache, opfRelative);
    if (!opfName) {
      logger.debug('[EPUB] package document missing from archive');
      return null;
    }
    const opfXml = bufferToXml(readEntryBounded(zip.getEntry(opfName), MAX_OPF_BYTES));
    if (!opfXml) {
      logger.debug('[EPUB] package document unreadable');
      return null;
    }

    const spineXml = sectionOf(opfXml, 'spine');
    if (spineXml === null) {
      logger.debug('[EPUB] package document has no spine');
      return null;
    }

    const metadataXml = sectionOf(opfXml, 'metadata') ?? opfXml;
    const title = firstMetadataValue(metadataXml, 'title', MAX_FIELD_CHARS);
    const language = firstMetadataValue(metadataXml, 'language', MAX_LANGUAGE_CHARS);
    const creators = dedupe(
      findElements(metadataXml, 'creator', MAX_METADATA_ELEMENTS)
        .map((element) => cleanText(element.inner, MAX_FIELD_CHARS))
        .filter(Boolean)
    ).slice(0, MAX_CREATORS);

    const opfDirRaw = path.posix.dirname(opfName);
    const opfDir = opfDirRaw === '.' ? '' : opfDirRaw;
    const manifestXml = sectionOf(opfXml, 'manifest') ?? opfXml;
    const items = findElements(manifestXml, 'item', MAX_MANIFEST_ITEMS);
    /** @type {Map<string, string>} */
    const hrefById = new Map();
    for (const item of items) {
      const id = getAttr(item.attrs, 'id');
      const href = getAttr(item.attrs, 'href');
      if (id && href && !hrefById.has(id)) hrefById.set(id, href);
    }

    /** @type {Array<{ entryName: string, nonLinear: boolean }>} */
    const resolved = [];
    let skipped = 0;
    for (const itemref of findElements(spineXml, 'itemref', MAX_SPINE_ITEMS)) {
      const idref = getAttr(itemref.attrs, 'idref');
      const href = idref ? hrefById.get(idref) : undefined;
      const entryPath = href ? resolveHref(href, opfDir) : null;
      const entryName = entryPath ? resolveEntryName(zip, cache, entryPath) : null;
      if (!entryName) {
        skipped += 1;
        continue;
      }
      const linear = (getAttr(itemref.attrs, 'linear') || '').trim().toLowerCase();
      resolved.push({ entryName, nonLinear: linear === 'no' });
    }
    if (skipped > 0) {
      logger.debug('[EPUB] Spine items without a matching archive entry skipped', { skipped });
    }
    const hasLinear = resolved.some((entry) => !entry.nonLinear);
    const spineEntryNames = dedupe(
      resolved.filter((entry) => !hasLinear || !entry.nonLinear).map((entry) => entry.entryName)
    );

    return {
      title,
      creators,
      language,
      opfPath: opfName,
      spineEntryNames,
      manifestCount: items.length
    };
  } catch (error) {
    logger.debug('[EPUB] Structure read failed', { error: error?.message });
    return null;
  }
}

/**
 * Entry names whose text should be extracted, in reading order: the spine when
 * the structure has one, otherwise every `.xhtml` / `.html` / `.htm` entry in
 * archive order (the legacy behaviour). Always deduped; never throws.
 *
 * @param {ZipLike} zip
 * @param {EpubStructure | null | undefined} structure
 * @returns {string[]}
 */
function pickEpubEntriesForText(zip, structure) {
  const spine =
    structure && Array.isArray(structure.spineEntryNames) ? structure.spineEntryNames : [];
  if (spine.length > 0) {
    return dedupe(spine.filter((name) => typeof name === 'string' && name.length > 0));
  }
  if (!zip || typeof zip.getEntries !== 'function') return [];
  try {
    return dedupe(
      zip
        .getEntries()
        .filter(
          (entry) =>
            entry &&
            !entry.isDirectory &&
            typeof entry.entryName === 'string' &&
            TEXT_ENTRY_RE.test(entry.entryName)
        )
        .map((entry) => entry.entryName)
    );
  } catch (error) {
    logger.debug('[EPUB] Listing archive entries failed', { error: error?.message });
    return [];
  }
}

/**
 * Short labelled header lines for a language model: `Title: ...`,
 * `Author: A, B`, `Language: en`. Empty string when nothing is known.
 *
 * @param {EpubStructure | null | undefined} structure
 * @returns {Promise<string>}
 */
async function describeEpubHeader(structure) {
  if (!structure || typeof structure !== 'object') return '';
  /** @type {string[]} */
  const lines = [];
  const title = cleanText(structure.title, MAX_FIELD_CHARS);
  if (title) lines.push(`Title: ${title}`);
  const creators = Array.isArray(structure.creators)
    ? dedupe(
        structure.creators.map((creator) => cleanText(creator, MAX_FIELD_CHARS)).filter(Boolean)
      ).slice(0, MAX_CREATORS)
    : [];
  if (creators.length > 0) lines.push(`Author: ${creators.join(', ')}`);
  const language = cleanText(structure.language, MAX_LANGUAGE_CHARS);
  if (language) lines.push(`Language: ${language}`);
  return lines.join('\n').slice(0, MAX_OUTPUT_CHARS);
}

module.exports = { readEpubStructure, pickEpubEntriesForText, describeEpubHeader };
