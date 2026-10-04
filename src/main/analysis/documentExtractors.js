// @ts-check
const fs = require('fs').promises;

const { FileProcessingError } = require('../errors/AnalysisError');
const { createLogger } = require('../../shared/logger');
const { LRUCache } = require('../../shared/LRUCache');
const { LIMITS, FILE_SIZE_LIMITS } = require('../../shared/constants');
const { getAnalysisLimits } = require('./analysisLimits');
const {
  withTimeout,
  withAbortableTimeout,
  mapWithConcurrency,
  throwIfAborted
} = require('../../shared/promiseUtils');
const { createSharpLoader } = require('../../shared/getSharp');

const EXTRACTION_TIMEOUTS = {
  PDF: 120000, // 2 minutes for PDF (can be slow for large files)
  DOCX: 60000, // 1 minute for DOCX
  XLSX: 90000, // 1.5 minutes for XLSX (can be slow for large spreadsheets)
  PPTX: 90000, // 1.5 minutes for PPTX
  OCR: 180000, // 3 minutes for OCR (very slow operation)
  DEFAULT: 60000 // 1 minute default
};

// Average characters of text layer per page below which a PDF is treated as
// a scan and OCR runs. A one-line footer such as "Scanned with CamScanner"
// is 23 characters; a page of body text is thousands.
const PDF_MIN_TEXT_CHARS_PER_PAGE = 40;

// Previously, logger was referenced at line 25 but declared at line 32, causing a
// ReferenceError (Temporal Dead Zone) when fast-xml-parser was missing.
const logger = createLogger('DocumentExtractors');

const getSharp = createSharpLoader({
  logger,
  label: '[OCR] sharp unavailable, image preprocessing disabled'
});

/** @type {any} */
let unpdfRenderer = null;
/** @type {any} */
let unpdfRendererInit = null;
/** @type {Promise<any> | null} */
let unpdfModulePromise = null;

/**
 * Resolve the unpdf module once: CJS require first, ESM import as fallback.
 * A failed load is not memoised so a later call can retry.
 * @returns {Promise<any>}
 */
function loadUnpdf() {
  if (!unpdfModulePromise) {
    unpdfModulePromise = (async () => {
      try {
        return require('unpdf');
      } catch (requireError) {
        try {
          const mod = await import('unpdf');
          return mod.default && typeof mod.default === 'object' ? { ...mod, ...mod.default } : mod;
        } catch (importError) {
          unpdfModulePromise = null;
          throw new Error(importError.message || requireError.message, { cause: importError });
        }
      }
    })();
  }
  return unpdfModulePromise;
}

/** @type {any} */
let officeParserModule = null;

/**
 * officeparser pulls in a large dependency graph; resolve it once on first
 * use rather than at module load.
 * @returns {any}
 */
function loadOfficeParser() {
  if (!officeParserModule) {
    officeParserModule = require('officeparser');
  }
  return officeParserModule;
}

/** @type {any} */
let wordExtractorModule = null;
/** @type {any} */
let msgReaderModule = null;
/** @type {any} */
let postalMimeModule = null;

/**
 * word-extractor (MIT) reads Word 97-2003 binary documents; officeparser
 * never did (it rejects every OLE format), so `.doc` landed in the filename
 * fallback for every file (audit row MI-01).
 * @returns {any} WordExtractor class
 */
function loadWordExtractor() {
  if (!wordExtractorModule) {
    wordExtractorModule = /** @type {any} */ (require('word-extractor'));
  }
  return wordExtractorModule;
}

/**
 * @kenjiuno/msgreader (Apache-2.0) reads Outlook .msg (OLE) files.
 * @returns {any} MsgReader class
 */
function loadMsgReader() {
  if (!msgReaderModule) {
    const mod = /** @type {any} */ (require('@kenjiuno/msgreader'));
    msgReaderModule = mod.default || mod;
  }
  return msgReaderModule;
}

/**
 * postal-mime (MIT-0) parses RFC 822 mail: multipart, base64 and
 * quoted-printable bodies, RFC 2047 headers. The previous .eml reader split
 * on the first blank line and kept everything after it raw, so a base64 body
 * was stored and embedded as base64 (audit row MI-05).
 * @returns {any} PostalMime class
 */
function loadPostalMime() {
  if (!postalMimeModule) {
    const mod = /** @type {any} */ (require('postal-mime'));
    postalMimeModule = mod.default || mod;
  }
  return postalMimeModule;
}

/**
 * Compose the searchable text of a mail message: headers people search by,
 * the plain body (or the HTML body reduced to text), then attachment names.
 * @param {{ subject?: string|null, from?: string|null, to?: string|null, text?: string|null, html?: string|null, attachments?: string[] }} mail
 * @returns {Promise<string>}
 */
async function composeMailText(mail) {
  const lines = [];
  if (mail.subject) lines.push(`Subject: ${mail.subject}`);
  if (mail.from) lines.push(`From: ${mail.from}`);
  if (mail.to) lines.push(`To: ${mail.to}`);
  let body = typeof mail.text === 'string' ? mail.text.trim() : '';
  if (!body && typeof mail.html === 'string' && mail.html.trim()) {
    body = (await extractPlainTextFromHtml(mail.html)).trim();
  }
  if (body) lines.push('', body);
  const attachments = Array.isArray(mail.attachments) ? mail.attachments.filter(Boolean) : [];
  if (attachments.length > 0) lines.push('', `Attachments: ${attachments.join(', ')}`);
  return lines.join('\n');
}

/**
 * "Name <address>" for a parsed mailbox, or whatever part is present.
 * @param {any} box
 * @returns {string}
 */
function formatMailbox(box) {
  if (!box) return '';
  if (typeof box === 'string') return box.trim();
  const name = typeof box.name === 'string' ? box.name.trim() : '';
  const address = typeof box.address === 'string' ? box.address.trim() : '';
  if (name && address) return `${name} <${address}>`;
  return name || address;
}

function ensurePromiseResolversPolyfill() {
  const P = /** @type {any} */ (Promise);
  if (typeof P.withResolvers === 'function') return;
  P.withResolvers = () => {
    /** @type {any} */
    let resolve;
    /** @type {any} */
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

async function getUnpdfRenderer() {
  if (unpdfRenderer) return unpdfRenderer;
  if (unpdfRendererInit) return unpdfRendererInit;
  unpdfRendererInit = (async () => {
    let unpdf;
    try {
      unpdf = await loadUnpdf();
    } catch (error) {
      logger.warn('[OCR] unpdf renderer unavailable', { error: error.message });
      return null;
    }
    const { definePDFJSModule, renderPageAsImage, getDocumentProxy } = unpdf;

    if (typeof definePDFJSModule !== 'function' || typeof renderPageAsImage !== 'function') {
      logger.warn('[OCR] unpdf renderer APIs missing');
      return null;
    }

    // IMPORTANT:
    // Unpdf ships with a serverless PDF.js bundle where API and worker versions are aligned.
    // Forcing a custom pdfjs-dist build here can cause mismatches such as:
    // "API version X does not match Worker version Y" and break scanned-PDF OCR.
    // Default behavior uses unpdf's bundled PDF.js unless explicitly overridden.
    const useOfficialPdfjs = String(process.env.STRATOSORT_USE_OFFICIAL_PDFJS || '').toLowerCase();
    if (useOfficialPdfjs === 'true') {
      ensurePromiseResolversPolyfill();
      try {
        await definePDFJSModule(() => import('pdfjs-dist/legacy/build/pdf.mjs'));
      } catch (error) {
        logger.warn('[OCR] Failed to load official pdfjs-dist renderer', { error: error.message });
        return null;
      }
    }

    unpdfRenderer = { renderPageAsImage, getDocumentProxy };
    return unpdfRenderer;
  })();
  return unpdfRendererInit;
}

let XMLParser;
try {
  // Prefer the full parser when available
  ({ XMLParser } = require('fast-xml-parser'));
} catch (error) {
  logger.debug('[EXTRACT] fast-xml-parser not found, using fallback', { error: error.message });
  // Fallback: lightweight internal parser to keep runtime alive when dependency is missing
  ({ XMLParser } = require('./xmlParserFallback'));
}
const { parse: parseCsv } = require('csv-parse/sync');
const { parse: parseCsvStream } = require('csv-parse');
const { isTesseractAvailable, recognizeIfAvailable } = require('../utils/tesseractUtils');
const { getTextExtractionPool } = require('../utils/workerPools');
const MAX_CSV_ROWS = 5000;
const MAX_CSV_COLS = 100;

// Pre-compiled regex patterns for performance (compiled once at module load)
const REGEX_PATTERNS = {
  // RTF patterns
  rtfHexEscape: /\\'([0-9a-fA-F]{2})/g,
  rtfBraces: /[{}]/g,
  rtfControlWords: /\\[a-zA-Z]+-?\d* ?/g,

  // HTML patterns
  scriptTags: /<script[\s\S]*?<\/script>/gi,
  styleTags: /<style[\s\S]*?<\/style>/gi,
  htmlTags: /<[^>]+>/g,

  // Whitespace patterns
  whitespace: /\s+/g,
  doubleNewline: /\r?\n\r?\n/,

  // Email header patterns
  subjectHeader: /^Subject:\s*(.*)$/im,
  fromHeader: /^From:\s*(.*)$/im,
  toHeader: /^To:\s*(.*)$/im
};

// Memory management constants
// Note: MAX_FILE_SIZE is imported from shared/constants.js as LIMITS.MAX_FILE_SIZE
const { rtfToText } = require('./extractors/rtfText');
const { decodeHtmlEntities } = require('./extractors/htmlEntities');

const MAX_TEXT_LENGTH = 500000; // 500k characters max output
const MAX_XLSX_ROWS = 10000; // Limit spreadsheet rows to prevent memory issues
// Columns are capped too: usedRange.cells() materializes the whole rectangle
// before the row cap applies, and a 10,000 x 200 export is two million cells.
const MAX_XLSX_COLUMNS = 512;
const MAX_XLSX_ZIP_ENTRIES = 32; // Fallback: cap number of worksheet XML entries processed
const MAX_XLSX_ZIP_ENTRY_BYTES = 10 * 1024 * 1024; // Fallback: cap per-entry inflate size
// Per-entry inflate ceiling for all office/archive extraction paths. Office
// XML parts and embedded images are far smaller than this in legitimate
// documents; only a zip bomb hits it.
const MAX_ZIP_ENTRY_INFLATED_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_UNCOMPRESSED_TOTAL = 256 * 1024 * 1024;

// ZIP container layout (APPNOTE.TXT §4.3). Only the trailing records and the
// central directory are read, so the pre-scan cost is independent of the
// archive's payload size.
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_EOCD_MIN_SIZE = 22;
const ZIP_MAX_COMMENT_LENGTH = 0xffff;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_LOCATOR_SIZE = 20;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_SIZE = 56;
const ZIP_CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const ZIP_CENTRAL_HEADER_SIZE = 46;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const ZIP_UINT16_MAX = 0xffff;
const ZIP_UINT32_MAX = 0xffffffff;
// Office archives hold a few hundred parts at most; a directory beyond this
// is treated as malformed and left to the extractor's own per-entry caps.
const ZIP_MAX_CENTRAL_DIRECTORY_BYTES = 4 * 1024 * 1024;

/**
 * @param {import('fs').promises.FileHandle} handle
 * @param {number} position
 * @param {number} length
 * @returns {Promise<Buffer>}
 */
async function readExactAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error('Truncated zip archive');
  return buffer;
}

/**
 * Locate the zip64 extended-information extra field and return the 8-byte
 * original size it carries (first field whenever the header size is 0xFFFFFFFF).
 * @param {Buffer} directory
 * @param {number} extraStart
 * @param {number} extraLength
 * @returns {number}
 */
function readZip64UncompressedSize(directory, extraStart, extraLength) {
  const extraEnd = Math.min(extraStart + extraLength, directory.length);
  let cursor = extraStart;
  while (cursor + 4 <= extraEnd) {
    const id = directory.readUInt16LE(cursor);
    const length = directory.readUInt16LE(cursor + 2);
    if (id === ZIP64_EXTRA_FIELD_ID) {
      if (length < 8 || cursor + 4 + 8 > extraEnd) {
        throw new Error('Malformed zip64 extra field');
      }
      return Number(directory.readBigUInt64LE(cursor + 4));
    }
    cursor += 4 + length;
  }
  throw new Error('Zip64 size marker without zip64 extra field');
}

/**
 * Sum the uncompressed sizes declared in a zip's central directory without
 * inflating anything or reading the payload. Stops early once the running
 * total exceeds `limit`. Throws on malformed or unsupported containers.
 * @param {string} filePath
 * @param {number} limit
 * @returns {Promise<number>}
 */
async function sumZipDeclaredUncompressedBytes(filePath, limit) {
  const { size: fileSize } = await fs.stat(filePath);
  const handle = await fs.open(filePath, 'r');
  try {
    const tailLength = Math.min(fileSize, ZIP_EOCD_MIN_SIZE + ZIP_MAX_COMMENT_LENGTH);
    const tailStart = fileSize - tailLength;
    const tail = await readExactAt(handle, tailStart, tailLength);
    let eocdOffset = -1;
    for (let i = tail.length - ZIP_EOCD_MIN_SIZE; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === ZIP_EOCD_SIGNATURE) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset < 0) throw new Error('Zip end-of-central-directory record not found');

    let entryCount = tail.readUInt16LE(eocdOffset + 10);
    let directorySize = tail.readUInt32LE(eocdOffset + 12);
    let directoryOffset = tail.readUInt32LE(eocdOffset + 16);

    if (
      entryCount === ZIP_UINT16_MAX ||
      directorySize === ZIP_UINT32_MAX ||
      directoryOffset === ZIP_UINT32_MAX
    ) {
      const locatorPosition = tailStart + eocdOffset - ZIP64_EOCD_LOCATOR_SIZE;
      if (locatorPosition < 0) throw new Error('Zip64 locator out of bounds');
      const locator = await readExactAt(handle, locatorPosition, ZIP64_EOCD_LOCATOR_SIZE);
      if (locator.readUInt32LE(0) !== ZIP64_EOCD_LOCATOR_SIGNATURE) {
        throw new Error('Zip64 end-of-central-directory locator not found');
      }
      const zip64EocdPosition = Number(locator.readBigUInt64LE(8));
      if (zip64EocdPosition + ZIP64_EOCD_SIZE > fileSize) {
        throw new Error('Zip64 end-of-central-directory record out of bounds');
      }
      const zip64Eocd = await readExactAt(handle, zip64EocdPosition, ZIP64_EOCD_SIZE);
      if (zip64Eocd.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
        throw new Error('Zip64 end-of-central-directory record not found');
      }
      entryCount = Number(zip64Eocd.readBigUInt64LE(32));
      directorySize = Number(zip64Eocd.readBigUInt64LE(40));
      directoryOffset = Number(zip64Eocd.readBigUInt64LE(48));
    }

    if (
      directorySize > ZIP_MAX_CENTRAL_DIRECTORY_BYTES ||
      directoryOffset + directorySize > fileSize
    ) {
      throw new Error('Zip central directory out of bounds');
    }

    const directory = await readExactAt(handle, directoryOffset, directorySize);
    let total = 0;
    let cursor = 0;
    for (let i = 0; i < entryCount; i += 1) {
      if (
        cursor + ZIP_CENTRAL_HEADER_SIZE > directory.length ||
        directory.readUInt32LE(cursor) !== ZIP_CENTRAL_HEADER_SIGNATURE
      ) {
        throw new Error('Malformed zip central directory header');
      }
      let uncompressedSize = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      if (uncompressedSize === ZIP_UINT32_MAX) {
        uncompressedSize = readZip64UncompressedSize(
          directory,
          cursor + ZIP_CENTRAL_HEADER_SIZE + nameLength,
          extraLength
        );
      }
      total += uncompressedSize;
      if (total > limit) return total;
      cursor += ZIP_CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
    }
    return total;
  } finally {
    await handle.close();
  }
}

/**
 * Pre-scan a zip's declared uncompressed size before handing the archive to
 * mammoth / xlsx-populate / officeparser, which inflate eagerly. Only the
 * over-cap case is fatal: a container this scan cannot parse is deferred to
 * the extractor, which tolerates more damage and enforces its own per-entry
 * inflate caps.
 * @param {string} filePath
 * @param {string} [context]
 * @param {{ maxUncompressedBytes?: number }} [options]
 * @returns {Promise<void>}
 */
async function assertZipUncompressedCap(
  filePath,
  context = 'ZIP',
  { maxUncompressedBytes = MAX_ZIP_UNCOMPRESSED_TOTAL } = {}
) {
  let total;
  try {
    total = await sumZipDeclaredUncompressedBytes(filePath, maxUncompressedBytes);
  } catch (error) {
    logger.debug(`[${context}] Zip pre-scan skipped, deferring to extractor`, {
      filePath,
      error: error?.message
    });
    return;
  }
  if (total > maxUncompressedBytes) {
    throw new FileProcessingError('FILE_TOO_LARGE', filePath, {
      suggestion: `${context} archive uncompressed size exceeds ${Math.round(maxUncompressedBytes / 1024 / 1024)}MB safety cap`,
      fileSize: total,
      maxSize: maxUncompressedBytes
    });
  }
}

/**
 * Zip-bomb-safe replacement for AdmZip `entry.getData()`.
 *
 * AdmZip inflates entries fully into memory and trusts the entry header, so a
 * crafted archive with an understated `size` field can bypass header-based
 * checks and allocate gigabytes. For deflated entries we decompress the raw
 * compressed bytes ourselves with zlib's `maxOutputLength`, which aborts
 * inflation the moment output exceeds the cap — a real pre-inflate limit, not
 * a post-hoc check. Stored (uncompressed) entries are bounded by their actual
 * byte length.
 *
 * @param {any} entry - AdmZip entry
 * @param {{ maxBytes?: number, context?: string }} [options]
 * @returns {Buffer|null} Inflated data, or null when missing/over-limit
 */
function safeGetZipEntryData(
  entry,
  { maxBytes = MAX_ZIP_ENTRY_INFLATED_BYTES, context = 'ZIP' } = {}
) {
  if (!entry || typeof entry.getData !== 'function') return null;
  const declaredSize = Number(entry.header?.size ?? 0);
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    logger.warn(`[${context}] Skipping zip entry: declared size exceeds limit`, {
      entry: entry.entryName,
      declaredSize,
      maxBytes
    });
    return null;
  }
  try {
    const ZIP_METHOD_DEFLATED = 8;
    const method = Number(entry.header?.method ?? -1);
    let data;
    if (method === ZIP_METHOD_DEFLATED && typeof entry.getCompressedData === 'function') {
      const zlib = require('zlib');
      const compressed = entry.getCompressedData();
      if (!compressed || compressed.length === 0) return null;
      // Throws ERR_BUFFER_TOO_LARGE when inflated output exceeds maxBytes.
      data = zlib.inflateRawSync(compressed, { maxOutputLength: maxBytes });
    } else {
      data = entry.getData();
    }
    if (!data) return null;
    if (data.length > maxBytes) {
      logger.warn(`[${context}] Skipping zip entry: inflated size exceeds limit`, {
        entry: entry.entryName,
        inflatedSize: data.length,
        maxBytes
      });
      return null;
    }
    return data;
  } catch (error) {
    logger.warn(`[${context}] Failed to inflate zip entry safely`, {
      entry: entry.entryName,
      error: error?.message
    });
    return null;
  }
}
const xmlParser = new XMLParser({
  ignoreAttributes: true,
  attributeNamePrefix: '',
  trimValues: true,
  allowBooleanAttributes: true,
  ignoreDeclaration: true
});

// Windows-1252 characters in the 0x80-0x9F range that differ from ISO-8859-1.
// Maps byte value to Unicode code point for correct decoding.
const WIN1252_EXTRAS = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178
};

/**
 * Decode a byte using Windows-1252 mapping.
 * @param {number} b - Byte value (0-255)
 * @returns {string} Decoded character
 */
function decodeWin1252Byte(b) {
  const mapped = /** @type {Record<number, number>} */ (WIN1252_EXTRAS)[b];
  return mapped ? String.fromCharCode(mapped) : String.fromCharCode(b);
}

/**
 * Read a text file with automatic encoding detection.
 * Detects UTF-16 LE/BE via BOM, then falls back to UTF-8 with a replacement-
 * character ratio check — if >5% are \uFFFD, retries with latin1.
 * @param {string} filePath - Path to the text file
 * @returns {Promise<string>} Decoded file content
 */
/**
 * Read at most `maxBytes` from the start of a file. Used for text files over
 * the configured size limit: the old streaming reader was removed as dead code
 * in 2026-09 and such files fell to the filename fallback; analyzing the head
 * is the honest middle ground.
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readTextFileHead(filePath, maxBytes) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return bytesRead === maxBytes ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * BOM and code-page aware text read.
 * @param {string} filePath
 * @param {{ maxBytes?: number | null }} [options] `maxBytes` reads only the
 *   head of the file (see readTextFileHead).
 * @returns {Promise<string>}
 */
async function readTextFileWithEncoding(filePath, options = {}) {
  const maxBytes =
    options && Number.isFinite(options.maxBytes) && Number(options.maxBytes) > 0
      ? Math.floor(Number(options.maxBytes))
      : null;
  const raw = maxBytes ? await readTextFileHead(filePath, maxBytes) : await fs.readFile(filePath);
  return decodeTextBuffer(raw);
}

/**
 * Decode a text buffer: UTF-16 BOMs, UTF-8 with BOM, Windows-1252 recovery.
 * @param {Buffer} raw
 * @returns {Promise<string>}
 */
async function decodeTextBuffer(raw) {
  if (!raw || raw.length === 0) return '';

  // UTF-16 LE BOM: 0xFF 0xFE
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    return raw.toString('utf16le').replace(/^\uFEFF/, '');
  }
  // UTF-16 BE BOM: 0xFE 0xFF — swap bytes in-place for utf16le decoding.
  // An odd byte length is malformed per the spec; truncate to an even
  // length instead of emitting a trailing NUL (which previously landed
  // inside the returned string and broke downstream tokenizers/line
  // counters). Previously we allocated a full duplicate buffer and copied
  // swapping bytes — `Buffer.swap16()` is an in-place intrinsic that
  // eliminates the duplicate allocation for what can be multi-MB files.
  // `raw` is a freshly-read buffer not shared with anyone else in this
  // process, so mutating it is safe.
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
    const evenLength = raw.length - (raw.length % 2);
    const view = evenLength === raw.length ? raw : raw.subarray(0, evenLength);
    view.swap16();
    return view.toString('utf16le').replace(/^\uFEFF/, '');
  }

  // Default: UTF-8 (handles UTF-8 BOM automatically)
  const text = raw.toString('utf8').replace(/^\uFEFF/, '');

  // Check for excessive replacement characters (sign of wrong encoding).
  // Previously we retried as `latin1` (ISO-8859-1) on failure, but the
  // overwhelming majority of mis-decoded content on Windows is CP1252
  // (smart quotes, em-dashes, euro sign in the 0x80-0x9F band). Plain
  // latin1 maps those bytes to C1 control characters that downstream
  // consumers render as empty boxes. Detect CP1252-ish content via
  // presence of bytes in the WIN1252 gap range and decode through our
  // extras map; fall back to latin1 only when the input is genuinely
  // ISO-8859-1 (no 0x80-0x9F bytes).
  if (text.length > 0) {
    let replacementCount = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 0xfffd) replacementCount++;
    }
    if (replacementCount / text.length > 0.05) {
      let hasWin1252Gap = false;
      for (let i = 0; i < raw.length; i++) {
        const b = raw[i];
        if (b >= 0x80 && b <= 0x9f) {
          hasWin1252Gap = true;
          break;
        }
      }
      if (hasWin1252Gap) {
        let out = '';
        for (let i = 0; i < raw.length; i++) {
          out += decodeWin1252Byte(raw[i]);
        }
        return out;
      }
      return raw.toString('latin1');
    }
  }

  return text;
}

/**
 * Clean and normalize whitespace in extracted text
 * Preserves paragraph structure but removes excessive whitespace
 * @param {string} text - Text to clean
 * @returns {string} Cleaned text
 */
function cleanWhitespace(text) {
  if (!text) return '';
  // 1. Normalize line endings
  let cleaned = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // 2. Remove trailing whitespace on lines
  cleaned = cleaned.replace(/[ \t]+$/gm, '');
  // 3. Collapse multiple empty lines (3 or more newlines) into 2 newlines (one empty line)
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  // 4. Trim start/end
  return cleaned.trim();
}

/**
 * Check file size and enforce memory limits
 * Uses maxDocumentFileSize from settings when available
 * @param {string} filePath - Path to file
 * @param {string} fileName - Name of file for error messages
 * @param {number} [maxSizeOverride] - Optional override; when omitted, loads from settings
 * @throws {FileProcessingError} If file exceeds size limit
 */
async function checkFileSize(filePath, fileName, maxSizeOverride) {
  try {
    const stats = await fs.stat(filePath);
    let maxSize = maxSizeOverride;
    if (maxSize == null || !Number.isFinite(maxSize)) {
      const limits = await getAnalysisLimits();
      maxSize = limits.maxDocumentFileSize ?? LIMITS.MAX_FILE_SIZE;
    }
    if (stats.size > maxSize) {
      throw new FileProcessingError('FILE_TOO_LARGE', fileName, {
        suggestion: `File size ${(stats.size / 1024 / 1024).toFixed(1)}MB exceeds limit of ${(maxSize / 1024 / 1024).toFixed(1)}MB`,
        fileSize: stats.size,
        maxSize
      });
    }
    return stats.size;
  } catch (error) {
    if (error.code === 'FILE_TOO_LARGE') throw error;
    throw new FileProcessingError('FILE_READ_ERROR', fileName, {
      suggestion: error.message,
      cause: error
    });
  }
}

/**
 * Truncate text to prevent memory issues
 * @param {string} text - Text to truncate
 * @returns {string} Truncated text
 */
function truncateText(text) {
  if (!text) return '';
  if (text.length <= MAX_TEXT_LENGTH) return text;
  return `${text.substring(0, MAX_TEXT_LENGTH)}\n\n[Text truncated due to length]`;
}

/**
 * Coerce an officeparser parse result into plain text.
 *
 * officeparser v6+ resolves to an `OfficeParserAST` object exposing `toText()`
 * (no `.text` property and no `parseOfficeAsync`), whereas v5 resolved to a
 * plain string. This keeps the extractor agnostic to either shape.
 *
 * @param {any} result - Value resolved by parseOffice/parseOfficeAsync.
 * @returns {string} Plain-text representation, or '' when none is available.
 */
function officeResultToText(result) {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  if (typeof result.toText === 'function') {
    const text = result.toText();
    return typeof text === 'string' ? text : '';
  }
  return typeof result.text === 'string' ? result.text : '';
}

/**
 * Parse an office document to plain text.
 *
 * @param {any} officeParser - The required `officeparser` module.
 * @param {string} filePath - Absolute path to the document.
 * @returns {Promise<string>} Extracted plain text.
 */
async function parseOfficeFile(officeParser, filePath) {
  if (!officeParser) {
    throw new Error('officeParser unavailable');
  }
  // officeparser v6+ exposes parseOffice (returns an AST); v5 exposed
  // parseOfficeAsync (returns a string). Support both for resilience.
  if (typeof officeParser.parseOffice === 'function') {
    return officeResultToText(await officeParser.parseOffice(filePath));
  }
  if (typeof officeParser.parseOfficeAsync === 'function') {
    return officeResultToText(await officeParser.parseOfficeAsync(filePath));
  }
  throw new Error('officeParser.parseOffice is not a function');
}

const DOC_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * The first `length` bytes of a file, or fewer when the file is shorter.
 *
 * The read buffer is zero-filled, so returning it whole would hand the caller
 * NUL padding it cannot tell from file content. That is invisible to a
 * signature comparison (`matchesSignature` length-guards, so a file shorter
 * than a signature never matched one anyway) but decisive for the content
 * sniffers below, which reject a NUL as proof of a binary file.
 *
 * Trimming to `bytesRead` therefore widens what the sniffers accept: EVERY
 * file shorter than the requested length now reaches them as its own bytes,
 * so any short non-OLE, non-ZIP .doc that is under 2% control characters is
 * read as text where it previously always returned '' — not just the
 * plain-text memo that exposed this. Short binary content is still rejected,
 * by the same two checks that reject it at full length: a NUL byte anywhere
 * in the head, or too many control characters.
 *
 * @param {any} filePath
 * @param {number} [length]
 * @returns {Promise<Buffer>}
 */
async function readFileSignature(filePath, length = 8) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function matchesSignature(/** @type {any} */ buffer, /** @type {any} */ signature) {
  if (!buffer || buffer.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (buffer[i] !== signature[i]) return false;
  }
  return true;
}

function isOleCompoundFile(/** @type {any} */ buffer) {
  return matchesSignature(buffer, DOC_SIGNATURE);
}

/**
 * Whether an OLE Word document has the FIB fEncrypted bit set (MS-DOC
 * 2.5.1 FibBase, flags word at offset 0x0A, bit 0x0100). Reads the
 * `WordDocument` stream with cfb. Returns false when the stream is absent
 * or unreadable, so the normal reader still gets its turn.
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function isEncryptedWordDocument(filePath) {
  try {
    const CFB = /** @type {any} */ (require('cfb'));
    const buffer = await fs.readFile(filePath);
    const container = CFB.read(buffer, { type: 'buffer' });
    const entry = CFB.find(container, 'WordDocument') || CFB.find(container, '/WordDocument');
    const content = entry?.content;
    if (!content || content.length < 0x0c) return false;
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    return (bytes.readUInt16LE(0x0a) & 0x0100) !== 0;
  } catch (error) {
    logger.debug('[DOC] Encryption flag could not be read', { error: error?.message });
    return false;
  }
}

/** @param {Buffer} head */
function looksLikeRtf(head) {
  if (!head || head.length < 5) return false;
  const start = head.subarray(0, Math.min(head.length, 16)).toString('latin1').trimStart();
  return start.startsWith('{\\rtf');
}

/**
 * Plain text by inspection: no NUL bytes and almost nothing but printable
 * characters and whitespace in the first block (UTF-16 with a BOM counts,
 * since decodeTextBuffer handles it).
 * @param {Buffer} head
 */
function looksLikePlainText(head) {
  if (!head || head.length === 0) return false;
  if (
    head.length >= 2 &&
    ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))
  ) {
    return true;
  }
  let control = 0;
  for (const byte of head) {
    if (byte === 0) return false;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c) control++;
  }
  return control / head.length < 0.02;
}

/**
 * HTML or XML by inspection of the DECODED text: a leading `<` opening a
 * doctype, an XML declaration, a comment, or any tag that is closed later.
 *
 * Decided after decoding rather than on the head bytes, because a byte sniff
 * cannot see through UTF-16, and because a bare `<table>` / `<div>` fragment
 * has nothing recognizable in its first bytes - and that fragment is exactly
 * what report and export endpoints emit under a `.doc` name. Markup is
 * printable, so looksLikePlainText accepts all of it and the tags, CSS and
 * script bodies become the document's prose.
 *
 * Real prose never starts with `<`, so this cannot swallow a text document.
 * @param {string} text
 */
function looksLikeMarkup(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const head = text.replace(/^\uFEFF/, '').trimStart();
  if (!head.startsWith('<')) return false;
  if (/^<(?:\?xml|!--|!doctype)/i.test(head)) return true;
  // A fragment of only void elements (`<p>a<br>b<br>`) never closes a tag, so
  // a leading well-known HTML element name is accepted as evidence on its own.
  if (
    /^<(?:html|head|body|meta|link|title|style|script|table|thead|tbody|tr|td|th|div|span|p|br|hr|h[1-6]|ul|ol|li|a|img|b|i|strong|em)\b/i.test(
      head
    )
  ) {
    return true;
  }
  return /<\/[a-z][\w:-]*\s*>/i.test(head.slice(0, 8192));
}

/**
 * A document-source container that happens to be printable: PDF or
 * PostScript. Returning it verbatim put `%PDF-1.4 ...` in the prompt, the
 * stored rawText and the embedded chunks.
 * @param {Buffer} head
 */
function looksLikeDocumentSource(head) {
  if (!head || head.length < 4) return false;
  // Skip a UTF-8 BOM, then trimStart like looksLikeRtf: a leading newline
  // before %PDF- is still a legal PDF, and without the trim that source came
  // back as the prose.
  const body = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? head.subarray(3) : head;
  const text = body.subarray(0, Math.min(body.length, 512)).toString('latin1').trimStart();
  return text.startsWith('%PDF-') || text.startsWith('%!PS');
}

function isZipFile(/** @type {any} */ buffer) {
  return matchesSignature(buffer, ZIP_SIGNATURE);
}

function flattenXmlText(/** @type {any} */ value, /** @type {any} */ chunks) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    chunks.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => flattenXmlText(item, chunks));
    return;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((item) => flattenXmlText(item, chunks));
  }
}

async function extractPlainTextFromXml(/** @type {any} */ xmlString) {
  if (!xmlString) return '';
  try {
    const parsed = xmlParser.parse(xmlString);
    /** @type {any[]} */
    const chunks = [];
    flattenXmlText(parsed, chunks);
    const text = chunks.join(' ').replace(REGEX_PATTERNS.whitespace, ' ').trim();
    if (text) return truncateText(text);
  } catch (error) {
    logger.warn('[XML] Failed to parse XML safely, falling back to tag stripping', {
      error: error.message
    });
  }
  return await extractPlainTextFromHtml(xmlString);
}

function formatCsvRow(/** @type {any} */ row) {
  if (Array.isArray(row)) {
    const cells = [];
    const len = Math.min(row.length, MAX_CSV_COLS);
    for (let i = 0; i < len; i += 1) {
      const cell = row[i];
      if (cell !== null && cell !== undefined) cells.push(String(cell));
    }
    return cells.join(' ');
  }
  if (row && typeof row === 'object') {
    const values = Object.values(row);
    const cells = [];
    const len = Math.min(values.length, MAX_CSV_COLS);
    for (let i = 0; i < len; i += 1) {
      const cell = values[i];
      if (cell !== null && cell !== undefined) cells.push(String(cell));
    }
    return cells.join(' ');
  }
  return String(row);
}

async function extractTextFromCsv(/** @type {any} */ filePath) {
  // Treat CSV as structured text; enforce file size to avoid memory blowups
  await checkFileSize(filePath, filePath);
  const raw = await readTextFileWithEncoding(filePath);

  // Stream-parse so we can stop reading after MAX_CSV_ROWS instead of
  // materializing the entire records array and then slicing. For a 200 MB
  // CSV the old path built every row into a JS array before throwing all
  // but the first 5 000 away — a large transient allocation plus GC churn.
  // The stream path stops feeding rows to the consumer as soon as the cap
  // is hit.
  try {
    const parser = parseCsvStream(raw, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true
    });
    const lines = [];
    for await (const row of parser) {
      lines.push(formatCsvRow(row));
      if (lines.length >= MAX_CSV_ROWS) {
        // Cooperative abort: tell the parser we're done so it releases
        // its internal state before we fall out of the loop.
        if (typeof parser.end === 'function') {
          try {
            parser.end();
          } catch {
            // csv-parse async iterator: .end() may be unavailable in some
            // versions; falling through simply lets GC reclaim the parser.
          }
        }
        break;
      }
    }
    if (lines.length === 0) {
      return truncateText(raw);
    }
    return truncateText(lines.join('\n'));
  } catch (error) {
    logger.warn('[CSV] Streaming parse failed, falling back to raw text', {
      error: error.message
    });
    // Fall back to legacy sync parser for small/edge inputs that the
    // streaming parser rejects but the sync one accepts. The sync path
    // still slices after the fact, so we only take it when streaming
    // has already failed — worst case the allocation is bounded by the
    // same file-size cap enforced at the top of the function.
    try {
      const records = parseCsv(raw, {
        bom: true,
        skipEmptyLines: true,
        relaxColumnCount: true,
        relaxQuotes: true
      });
      if (!Array.isArray(records) || records.length === 0) {
        return truncateText(raw);
      }
      const limit = Math.min(records.length, MAX_CSV_ROWS);
      const lines = new Array(limit);
      for (let i = 0; i < limit; i += 1) {
        lines[i] = formatCsvRow(records[i]);
      }
      return truncateText(lines.join('\n'));
    } catch (fallbackError) {
      logger.warn('[CSV] Sync fallback also failed, returning raw text', {
        error: fallbackError.message
      });
      return truncateText(raw);
    }
  }
}

// Internal buffer cache: extractTextFromPdf pins its buffer once it knows OCR
// will follow, so ocrPdfIfNeeded can reuse it instead of reading the same file
// a second time. Bounded + TTL to cap memory. The periodic sweep is the
// safety net for entries whose OCR consumer never ran (e.g. the caller gave
// up on the extraction before the pin happened); without it a stranded
// multi-hundred-MB buffer would sit until the cache reached capacity.
const PDF_BUFFER_CACHE_SWEEP_MS = 60 * 1000;
const _pdfBufferCache = new LRUCache({
  maxSize: 50,
  ttlMs: 5 * 60 * 1000,
  lruStrategy: 'access',
  name: 'PdfExtractBuffer'
});
_pdfBufferCache.initialize(PDF_BUFFER_CACHE_SWEEP_MS);

/**
 * Release pinned PDF buffers and stop the TTL sweep. Safe to call more than once.
 * @returns {Promise<void>}
 */
async function shutdownPdfBufferCache() {
  await _pdfBufferCache.shutdown();
}

/**
 * Detect a pdfjs/unpdf encrypted-PDF rejection. pdfjs raises a
 * `PasswordException` (with code 1 = NEED_PASSWORD, 2 = INCORRECT_PASSWORD)
 * but the class isn't directly importable here because unpdf bundles its
 * own pdfjs build. Match by error.name first (canonical) then by message
 * pattern as a fallback.
 */
function isEncryptedPdfError(/** @type {any} */ err) {
  if (!err) return false;
  if (err.code === 'PDF_ENCRYPTED') return true;
  if (err.name === 'PasswordException') return true;
  const msg = String(err.message || '').toLowerCase();
  return (
    msg.includes('password') &&
    (msg.includes('encrypted') || msg.includes('protected') || msg.includes('required'))
  );
}

/**
 * @param {any} filePath
 * @param {any} fileName
 * @param {{ signal?: AbortSignal }} [options]
 */
async function extractTextFromPdf(filePath, fileName, options = {}) {
  const { signal } = options;
  await checkFileSize(filePath, fileName);
  throwIfAborted(signal);

  try {
    const rawBuffer = await fs.readFile(filePath);
    throwIfAborted(signal);
    // Buffer is a Uint8Array subclass but pdf.js does a strict instanceof check.
    const dataBuffer = new Uint8Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.byteLength);
    const { extractText, getDocumentProxy } = await loadUnpdf();
    if (typeof extractText !== 'function' || typeof getDocumentProxy !== 'function') {
      throw new Error('unpdf extractText/getDocumentProxy is unavailable');
    }
    // extractText(data, options) only reads `mergePages`; DocumentInitParameters
    // such as isEvalSupported are honoured only via getDocumentProxy, so the
    // document must be opened here and torn down after extraction.
    const pdf = await getDocumentProxy(dataBuffer, { isEvalSupported: false });
    const destroyPdf = async () => {
      try {
        await pdf?.destroy?.();
      } catch {
        // PDF.js proxy teardown errors are not actionable here.
      }
    };
    // pdf.js has no AbortSignal hook; destroying the proxy is the only way to
    // stop in-flight page work when the caller times out or cancels.
    const onAbort = () => {
      void destroyPdf();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    let result;
    let pageCount = 0;
    try {
      result = await extractText(pdf, { mergePages: true });
      pageCount = Number(result?.totalPages) || Number(pdf?.numPages) || 0;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await destroyPdf();
    }
    throwIfAborted(signal);

    // unpdf may return text as a string or, in edge cases, as an array of page
    // strings.  Normalise to a single string so downstream .trim() never fails.
    let pdfText;
    const rawText = result?.text;
    if (typeof rawText === 'string') {
      pdfText = rawText;
    } else if (Array.isArray(rawText)) {
      pdfText = rawText.filter((p) => typeof p === 'string').join('\n');
    } else {
      pdfText = rawText != null ? String(rawText) : '';
    }

    const cleanedText = cleanWhitespace(pdfText || '');
    const textLayerChars = cleanedText.trim().length;
    const pages = Math.max(1, pageCount);
    // A scan with a one-line footer ("Scanned with CamScanner") has a text
    // layer, but not one worth analyzing. Below PDF_MIN_TEXT_CHARS_PER_PAGE
    // on average the file is treated as image-based and OCR runs; the thin
    // layer rides on the error so the caller can keep it if OCR finds
    // nothing better.
    const thinTextLayer =
      textLayerChars > 0 && textLayerChars < PDF_MIN_TEXT_CHARS_PER_PAGE * pages;
    if (textLayerChars === 0 || thinTextLayer) {
      // Only now is it known that OCR will run: pin the bytes for
      // ocrPdfIfNeeded, which releases them in its finally. pdf.js may have
      // transferred the ArrayBuffer to its worker, leaving a detached
      // zero-length husk — never cache that.
      if (rawBuffer.length > 0) _pdfBufferCache.set(filePath, rawBuffer);
      if (thinTextLayer) {
        logger.info('[PDF] Text layer too thin to analyze; treating as a scan', {
          fileName,
          textLayerChars,
          pages
        });
      }
      throw new FileProcessingError('PDF_NO_TEXT_CONTENT', fileName, {
        suggestion: thinTextLayer
          ? `PDF text layer is too thin to analyze (${textLayerChars} characters over ${pages} page(s)); treating as a scan`
          : 'PDF may be image-based or corrupted',
        textLayer: thinTextLayer ? cleanedText : '',
        pageCount: pages
      });
    }

    return truncateText(cleanedText);
  } catch (error) {
    // Encrypted/password-protected PDFs cannot be unlocked here, and OCR
    // can't help (sharp won't rasterize an encrypted PDF either). Surface a
    // distinct status so the caller can show "this PDF is encrypted" rather
    // than the generic "no extractable text" path that ends in empty content
    // with no user-facing explanation.
    if (isEncryptedPdfError(error)) {
      logger.info('[PDF] Encrypted/password-protected PDF detected', { fileName });
      throw new FileProcessingError('PDF_ENCRYPTED', fileName, {
        suggestion: 'PDF is password-protected. Decrypt the file before analysis.'
      });
    }
    if (error?.code === 'PDF_NO_TEXT_CONTENT') {
      logger.info('[PDF] No extractable text from PDF parser', { fileName });
    } else {
      logger.warn('[PDF] Extraction failed:', {
        fileName,
        error: error?.message
      });
    }
    throw error;
  }
}

/**
 * @param {any} filePath
 * @param {{ signal?: AbortSignal }} [options]
 */
async function ocrPdfIfNeeded(filePath, options = {}) {
  const { signal } = options;
  throwIfAborted(signal);
  let pdfBuffer;
  let rasterPng;

  // Cap density to 150 DPI (was 200) - still good for OCR, but reduces memory 44%
  // Add max dimensions to prevent huge images from 200+ page PDFs
  const OCR_DENSITY = 150; // DPI for rasterization
  const OCR_MAX_WIDTH = 2480; // ~A4 at 150 DPI
  const OCR_MAX_HEIGHT = 3508; // ~A4 at 150 DPI
  const OCR_MAX_FILE_SIZE = 30 * 1024 * 1024; // 30MB limit (reduced from 50MB)

  try {
    if (!(await isTesseractAvailable())) {
      logger.debug('[OCR] Skipping PDF OCR - tesseract unavailable');
      return '';
    }
    throwIfAborted(signal);
    const sharp = getSharp();
    if (!sharp) {
      logger.debug('[OCR] Skipping PDF OCR preprocessing - sharp unavailable');
      return '';
    }

    // Fixed: Check file size before OCR processing (OCR is very memory intensive)
    const stats = await fs.stat(filePath);
    throwIfAborted(signal);
    // OCR has stricter limits due to image processing overhead
    if (stats.size > OCR_MAX_FILE_SIZE) {
      logger.info('[OCR] Skipping OCR - file exceeds size limit', {
        filePath,
        fileSize: stats.size,
        maxSize: OCR_MAX_FILE_SIZE
      });
      return '';
    }

    // Reuse buffer from extractTextFromPdf if available to avoid redundant
    // reads. Guard on length: pdf.js may TRANSFER the extraction view's
    // ArrayBuffer to its worker, detaching the cached Buffer into a truthy
    // zero-length husk — trusting it silently feeds OCR 0 bytes.
    const cachedPdfBuffer = _pdfBufferCache.get(filePath);
    pdfBuffer =
      cachedPdfBuffer && cachedPdfBuffer.length > 0 ? cachedPdfBuffer : await fs.readFile(filePath);
    throwIfAborted(signal);

    // A 40MB PDF at 200 DPI could become 150MB+ PNG, causing OOM.
    // Rasterization happens on the worker pool when available; sync sharp is
    // still used as a fallback so OCR keeps working when Piscina is disabled
    // (e.g. in tests) or the worker pool has failed permanently.
    const imagePool = (() => {
      try {
        return require('../utils/workerPools').getImagePreprocessPool?.();
      } catch {
        return null;
      }
    })();

    let sharpPipeline = null;
    let metadata = null;
    let workerRasterized = false;

    if (imagePool) {
      let workerResult = null;
      try {
        workerResult = await imagePool.run({
          type: 'rasterize_pdf',
          buffer: pdfBuffer,
          options: {
            density: OCR_DENSITY,
            maxWidth: OCR_MAX_WIDTH,
            maxHeight: OCR_MAX_HEIGHT,
            compressionLevel: 6
          }
        });
      } catch (workerErr) {
        logger.debug('[OCR] Worker rasterize dispatch failed, falling back to sync', {
          filePath,
          error: workerErr?.message
        });
      }

      if (workerResult && !workerResult.error && workerResult.buffer) {
        // Piscina deserializes worker results as Uint8Array, but downstream
        // consumers (sharp, tesseract.js) expect Node Buffer. Without an
        // explicit Buffer.from() wrap they error with "Invalid url value".
        // Mirrors the matching fix in imageAnalysis.js for the vision path.
        rasterPng = Buffer.isBuffer(workerResult.buffer)
          ? workerResult.buffer
          : Buffer.from(workerResult.buffer);
        workerRasterized = true;
        metadata = { width: workerResult.width, height: workerResult.height };
        if (workerResult.resized) {
          logger.debug('[OCR] Resized large image for OCR (worker)', {
            originalWidth: workerResult.width,
            originalHeight: workerResult.height,
            maxWidth: OCR_MAX_WIDTH,
            maxHeight: OCR_MAX_HEIGHT
          });
        }
      } else if (workerResult && workerResult.unsupported) {
        logger.debug(
          '[OCR] sharp (worker) cannot rasterise this PDF (libvips PDF support may be missing)',
          { filePath, error: workerResult.error }
        );
        const fallbackText = await ocrPdfWithCanvasRenderer(pdfBuffer, {
          lang: 'eng',
          oem: 1,
          psm: 3
        });
        if (fallbackText) return fallbackText;
        return '';
      } else if (workerResult && workerResult.renderFailed) {
        logger.debug(
          '[OCR] sharp (worker) rasterization failed, attempting canvas renderer fallback',
          { filePath, error: workerResult.error }
        );
        const fallbackText = await ocrPdfWithCanvasRenderer(pdfBuffer, {
          lang: 'eng',
          oem: 1,
          psm: 3
        });
        if (fallbackText) return fallbackText;
        return '';
      }
      // Any other failure mode: fall through to the sync sharp path below.
    }

    if (!workerRasterized) {
      sharpPipeline = sharp(pdfBuffer, { density: OCR_DENSITY });

      // Verify sharp can actually process this PDF (requires libvips PDF support).
      // Without poppler/pdfium compiled into libvips, sharp throws
      // "Input buffer contains unsupported image format".
      try {
        metadata = await sharpPipeline.metadata();
      } catch (metaError) {
        logger.debug('[OCR] sharp cannot rasterise this PDF (libvips PDF support may be missing)', {
          filePath,
          error: metaError.message
        });
        const fallbackText = await ocrPdfWithCanvasRenderer(pdfBuffer, {
          lang: 'eng',
          oem: 1,
          psm: 3
        });
        if (fallbackText) {
          return fallbackText;
        }
        return '';
      }
      if (metadata.width > OCR_MAX_WIDTH || metadata.height > OCR_MAX_HEIGHT) {
        logger.debug('[OCR] Resizing large image for OCR', {
          originalWidth: metadata.width,
          originalHeight: metadata.height,
          maxWidth: OCR_MAX_WIDTH,
          maxHeight: OCR_MAX_HEIGHT
        });
        sharpPipeline = sharpPipeline.resize(OCR_MAX_WIDTH, OCR_MAX_HEIGHT, {
          fit: 'inside',
          withoutEnlargement: true
        });
      }
      throwIfAborted(signal);

      try {
        rasterPng = await sharpPipeline.png({ compressionLevel: 6 }).toBuffer();
      } catch (renderError) {
        logger.debug('[OCR] sharp rasterization failed, attempting canvas renderer fallback', {
          filePath,
          error: renderError.message
        });
        const fallbackText = await ocrPdfWithCanvasRenderer(pdfBuffer, {
          lang: 'eng',
          oem: 1,
          psm: 3
        });
        if (fallbackText) {
          return fallbackText;
        }
        return '';
      }
    }

    // Clear PDF buffer before OCR to reduce peak memory
    pdfBuffer = null;
    throwIfAborted(signal);

    const ocrResult = await recognizeIfAvailable(null, rasterPng, {
      lang: 'eng',
      oem: 1,
      psm: 3
    });
    if (!ocrResult.success) {
      return '';
    }
    const ocrText = ocrResult.text;

    // Fixed: Truncate OCR results and clean up
    const result = ocrText && ocrText.trim().length > 0 ? truncateText(ocrText) : '';
    rasterPng = null;
    return result;
  } catch (error) {
    logger.warn('[OCR] OCR processing failed', {
      filePath,
      error: error.message,
      errorCode: error.code
    });
    return '';
  } finally {
    // Covers every early return above (tesseract/sharp unavailable, oversized
    // file) as well as the abort/error paths, so the pinned buffer never
    // outlives the OCR attempt.
    _pdfBufferCache.delete(filePath);
    // Explicit cleanup (intentional for GC)
    // eslint-disable-next-line no-useless-assignment -- cleanup before scope exit
    pdfBuffer = null;
    // eslint-disable-next-line no-useless-assignment -- cleanup before scope exit
    rasterPng = null;
  }
}

async function ocrPdfWithCanvasRenderer(/** @type {any} */ pdfBuffer, options = {}) {
  if (!pdfBuffer || pdfBuffer.length === 0) return '';

  const renderer = await getUnpdfRenderer();
  if (!renderer) return '';

  let canvasModule;
  try {
    canvasModule = require('@napi-rs/canvas');
  } catch (error) {
    logger.warn('[OCR] @napi-rs/canvas unavailable, cannot render PDF pages for OCR', {
      error: error.message
    });
    return '';
  }

  const canvasImport = () => Promise.resolve(canvasModule);
  // Important: create a standalone copy (not a view over Node Buffer memory),
  // then reuse a PDFDocumentProxy where available so transfer/detach behavior
  // in PDF.js workers does not break page 2+ renders.
  const sourceData = Uint8Array.from(pdfBuffer);
  let pdfDoc = null;
  if (typeof renderer.getDocumentProxy === 'function') {
    try {
      pdfDoc = await renderer.getDocumentProxy(sourceData, { isEvalSupported: false });
    } catch (error) {
      logger.debug(
        '[OCR] Failed to create shared PDF document proxy; using per-page data fallback',
        {
          error: error.message
        }
      );
      pdfDoc = null;
    }
  }
  const MAX_PAGES = 3;
  const SCALE = 1.5;
  const OCR_PAGE_CONCURRENCY = 2;

  const renderedPages = [];
  // Fallback path (no PDFDocumentProxy): PDF.js may detach the input buffer
  // after renderPageAsImage, so we defensively re-copy when the previous
  // render detached it. Previously the loop unconditionally re-copied the
  // full PDF for every page (3 × `Uint8Array.from(sourceData)` of a
  // multi-MB buffer); reusing the copy when it survives avoids that
  // allocation entirely for renderers that don't detach.
  let perPageRenderTarget = null;
  try {
    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
      try {
        let renderTarget;
        if (pdfDoc) {
          renderTarget = pdfDoc;
        } else {
          if (!perPageRenderTarget || perPageRenderTarget.byteLength === 0) {
            perPageRenderTarget = Uint8Array.from(sourceData);
          }
          renderTarget = perPageRenderTarget;
        }
        const rendered = await renderer.renderPageAsImage(renderTarget, pageNumber, {
          canvasImport,
          scale: SCALE
        });
        renderedPages.push({ pageNumber, imageBuffer: Buffer.from(rendered) });
      } catch (error) {
        logger.debug('[OCR] PDF page render failed', {
          pageNumber,
          error: error.message
        });
      }
    }
  } finally {
    // eslint-disable-next-line no-useless-assignment -- drop strong reference so GC can reclaim the PDF bytes before OCR
    perPageRenderTarget = null;
    try {
      await pdfDoc?.destroy?.();
    } catch {
      // Ignore cleanup errors from PDF.js proxy teardown.
    }
  }

  const pageTexts = await mapWithConcurrency(
    renderedPages,
    OCR_PAGE_CONCURRENCY,
    async (
      /** @type {{ pageNumber: number, imageBuffer: Buffer }} */ { pageNumber, imageBuffer }
    ) => {
      try {
        const ocrResult = await recognizeIfAvailable(null, imageBuffer, options);
        if (ocrResult.success && ocrResult.text && ocrResult.text.trim()) {
          return ocrResult.text.trim();
        }
      } catch (error) {
        logger.debug('[OCR] PDF page OCR failed', {
          pageNumber,
          error: error.message
        });
      }
      return '';
    },
    { settle: true }
  );

  const trimmed = pageTexts.filter(Boolean).join('\n\n').trim();
  if (!trimmed) return '';
  logger.info('[OCR] Successfully extracted text via PDF page renderer fallback');
  return truncateText(trimmed);
}

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function extractTextFromDoc(filePath) {
  const fileSize = await checkFileSize(filePath, filePath);
  try {
    const signature = await readFileSignature(filePath, 8);
    if (isZipFile(signature)) {
      logger.warn('[DOC] File appears to be DOCX container, routing to DOCX extractor');
      return await extractTextFromDocx(filePath);
    }
    if (!isOleCompoundFile(signature)) {
      // Mail clients and converters hand out ".doc" files that are RTF or
      // plain text inside. Returning '' here left them as "extraction
      // failed" with two wasted watcher retries; read them for what they are.
      const head = await readFileSignature(filePath, 512);
      // .doc is admitted at the document ceiling, which is far above the text
      // ceiling, so a mislabeled text file must not be read whole here.
      const readAsText = async () => {
        const { maxTextFileSize } = await getAnalysisLimits();
        const maxText = Number.isFinite(maxTextFileSize)
          ? maxTextFileSize
          : FILE_SIZE_LIMITS.MAX_TEXT_FILE_SIZE;
        return await readTextFileWithEncoding(filePath, {
          maxBytes: fileSize > maxText ? maxText : null
        });
      };
      if (looksLikeRtf(head)) {
        logger.info('[DOC] File is RTF under a .doc name; reading it as RTF', { filePath });
        return truncateText(await extractPlainTextFromRtf(await readAsText()));
      }
      if (looksLikeDocumentSource(head)) {
        logger.warn('[DOC] File is PDF/PostScript source under a .doc name, skipping parse', {
          filePath
        });
        return '';
      }
      if (looksLikePlainText(head)) {
        const text = await readAsText();
        if (looksLikeMarkup(text)) {
          logger.info('[DOC] File is HTML under a .doc name; reading its visible text', {
            filePath
          });
          return truncateText(await extractPlainTextFromHtml(text));
        }
        logger.info('[DOC] File is plain text under a .doc name; reading it as text', { filePath });
        return truncateText(text);
      }
      logger.warn('[DOC] Unsupported/binary DOC file detected, skipping parse', {
        filePath
      });
      return '';
    }
    if (await isEncryptedWordDocument(filePath)) {
      // word-extractor tests only fWhichTblStm in the FIB flags; with
      // fEncrypted set it reads RC4 or XOR bytes as a piece table and
      // either throws out of bounds or returns garbage, both logged as a
      // generic corruption. Say what the file is.
      throw new FileProcessingError('DOC_ENCRYPTED', filePath, {
        suggestion: 'Remove the password from the document and try again.'
      });
    }
    const WordExtractor = loadWordExtractor();
    const document = await new WordExtractor().extract(filePath);
    const parts = [
      document?.getBody?.(),
      document?.getHeaders?.(),
      document?.getFootnotes?.(),
      document?.getEndnotes?.(),
      document?.getTextboxes?.()
    ]
      .map((part) => (typeof part === 'string' ? part.trim() : ''))
      .filter(Boolean);
    return truncateText(parts.join('\n\n'));
  } catch (error) {
    if (error instanceof FileProcessingError) throw error;
    logger.warn('[DOC] Word 97-2003 extraction failed', { error: error.message });
    throw new FileProcessingError('DOC_EXTRACTION_FAILURE', filePath, {
      suggestion: 'DOC file may be corrupted, password-protected or in an unsupported format',
      originalError: error.message
    });
  }
}

/**
 * @param {any} err
 * @returns {boolean}
 */
function isAbortError(err) {
  return err?.name === 'AbortError';
}

/**
 * OCR the images embedded in an Office archive. Returns '' when nothing is
 * recognisable; the only error that escapes is an AbortError from `signal`.
 *
 * @param {string} filePath
 * @param {string} mediaPathPrefix - e.g. 'word/media/' or 'ppt/media/'
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<string>}
 */
async function extractImagesFromOfficeArchiveAndOcr(filePath, mediaPathPrefix, options = {}) {
  const { signal } = options;
  const AdmZip = require('adm-zip');
  const OCR_MAX_WIDTH = 2480; // ~A4 at 150 DPI
  const OCR_MAX_HEIGHT = 3508; // ~A4 at 150 DPI
  const OCR_MAX_BYTES = 20 * 1024 * 1024; // 20MB limit per image
  const OFFICE_OCR_MAX_IMAGES = 10;
  const OFFICE_OCR_CONCURRENCY = 2;

  try {
    throwIfAborted(signal);
    if (!(await isTesseractAvailable())) {
      logger.debug('[OFFICE-OCR] Skipping OCR - tesseract unavailable');
      return '';
    }
    const sharp = getSharp();
    if (!sharp) {
      logger.debug('[OFFICE-OCR] Skipping image preprocessing - sharp unavailable');
      return '';
    }

    const zip = new AdmZip(filePath);
    const zipEntries = zip.getEntries();

    // Filter for image files in the specified media folder (e.g. 'word/media/' or 'ppt/media/')
    const imageEntries = zipEntries.filter(
      (/** @type {any} */ entry) =>
        entry.entryName.startsWith(mediaPathPrefix) &&
        /\.(png|jpg|jpeg|tiff|bmp|gif|webp)$/i.test(entry.entryName)
    );

    if (imageEntries.length === 0) return '';

    logger.info(
      `[OFFICE-OCR] Found ${imageEntries.length} images in ${mediaPathPrefix}, attempting OCR`
    );

    const limitedEntries = imageEntries.slice(0, OFFICE_OCR_MAX_IMAGES);
    const extractedTexts = await mapWithConcurrency(
      limitedEntries,
      OFFICE_OCR_CONCURRENCY,
      async (/** @type {any} */ entry) => {
        throwIfAborted(signal);
        const buffer = safeGetZipEntryData(entry, {
          maxBytes: OCR_MAX_BYTES,
          context: 'OFFICE-OCR'
        });
        if (!buffer || buffer.length === 0) {
          return '';
        }
        if (buffer.length > OCR_MAX_BYTES) {
          logger.debug('[OFFICE-OCR] Skipping large image', {
            entry: entry.entryName,
            size: buffer.length,
            maxBytes: OCR_MAX_BYTES
          });
          return '';
        }

        let ocrBuffer = buffer;
        try {
          const imagePool = (() => {
            try {
              return require('../utils/workerPools').getImagePreprocessPool?.();
            } catch {
              return null;
            }
          })();

          let handledByWorker = false;
          if (imagePool) {
            try {
              const workerResult = await imagePool.run({
                type: 'resize_for_ocr',
                buffer,
                options: {
                  maxWidth: OCR_MAX_WIDTH,
                  maxHeight: OCR_MAX_HEIGHT,
                  compressionLevel: 6
                }
              });
              if (workerResult && !workerResult.error && workerResult.buffer) {
                // Same Piscina Uint8Array vs Node Buffer issue as the
                // PDF rasterize path above — wrap defensively so tesseract
                // does not throw "Invalid url value" on Office-image OCR.
                ocrBuffer = Buffer.isBuffer(workerResult.buffer)
                  ? workerResult.buffer
                  : Buffer.from(workerResult.buffer);
                handledByWorker = true;
              }
            } catch (workerErr) {
              logger.debug('[OFFICE-OCR] Worker preprocess failed, falling back to sync', {
                entry: entry.entryName,
                error: workerErr?.message
              });
            }
          }

          if (!handledByWorker) {
            let pipeline = sharp(buffer);
            const meta = await pipeline.metadata();
            if (meta.width > OCR_MAX_WIDTH || meta.height > OCR_MAX_HEIGHT) {
              pipeline = pipeline.resize(OCR_MAX_WIDTH, OCR_MAX_HEIGHT, {
                fit: 'inside',
                withoutEnlargement: true
              });
            }
            ocrBuffer = await pipeline.png({ compressionLevel: 6 }).toBuffer();
          }
        } catch (prepError) {
          logger.debug('[OFFICE-OCR] Image preprocessing failed, using original buffer', {
            entry: entry.entryName,
            error: prepError.message
          });
        }

        const ocrResult = await recognizeIfAvailable(null, ocrBuffer, {
          lang: 'eng',
          oem: 1,
          psm: 3
        });
        if (!ocrResult.success) {
          logger.debug('[OFFICE-OCR] OCR failed for image', {
            entry: entry.entryName,
            error: ocrResult.error
          });
          return '';
        }
        if (ocrResult.success && ocrResult.text && ocrResult.text.trim()) {
          return ocrResult.text.trim();
        }
        return '';
      },
      { settle: true }
    );
    // settle:true swallows per-image AbortErrors; re-check so cancellation
    // propagates to the caller instead of degrading to "no OCR text".
    throwIfAborted(signal);

    return extractedTexts.filter(Boolean).join('\n\n').trim();
  } catch (error) {
    if (isAbortError(error)) throw error;
    logger.warn('[OFFICE-OCR] Failed to extract/OCR images from office archive', {
      error: error.message
    });
    return '';
  }
}

async function extractTextFromDocxXml(/** @type {any} */ filePath) {
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(filePath);
    if (!zip || typeof zip.getEntries !== 'function') {
      logger.debug('[DOCX] Zip reader unavailable, skipping XML extraction');
      return '';
    }
    const entries = zip.getEntries();
    if (!entries || entries.length === 0) return '';

    const xmlEntries = entries.filter((/** @type {any} */ entry) => {
      const name = entry.entryName.toLowerCase();
      return (
        name === 'word/document.xml' ||
        name.startsWith('word/header') ||
        name.startsWith('word/footer')
      );
    });

    if (xmlEntries.length === 0) return '';

    /** @type {any[]} */
    const chunks = [];
    for (const entry of xmlEntries) {
      try {
        const xml = safeGetZipEntryData(entry, { context: 'DOCX' })?.toString('utf8') || '';
        if (!xml) continue;
        const text = await extractPlainTextFromXml(xml);
        if (text) {
          chunks.push(text);
        }
      } catch (error) {
        logger.debug('[DOCX] XML extraction failed for entry', {
          entry: entry.entryName,
          error: error.message
        });
      }
    }

    return truncateText(chunks.join('\n\n'));
  } catch (error) {
    logger.debug('[DOCX] XML extraction failed for archive', { error: error.message });
    return '';
  }
}

/**
 * Extract text from a DOCX. Fallback chain runs each stage at most once:
 * mammoth -> officeparser -> document.xml -> OCR of embedded images.
 * Rejects with the original mammoth error when every stage comes back empty.
 *
 * @param {string} filePath
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<string>}
 */
async function extractTextFromDocx(filePath, options = {}) {
  const { signal } = options;
  const mammoth = require('mammoth');
  await checkFileSize(filePath, filePath);
  throwIfAborted(signal);

  const signature = await readFileSignature(filePath, 8);
  if (isOleCompoundFile(signature)) {
    logger.warn('[DOCX] File appears to be legacy DOC, routing to DOC extractor');
    return await extractTextFromDoc(filePath);
  }
  if (!isZipFile(signature)) {
    throw Object.assign(new Error('Invalid DOCX container signature'), { code: 'INVALID_DOCX' });
  }
  await assertZipUncompressedCap(filePath, 'DOCX');

  /** @type {Error} */
  let mammothError;
  try {
    const result = await mammoth.extractRawText({ path: filePath });
    if (!result.value || result.value.trim().length === 0) {
      throw new Error('No text content in DOCX');
    }
    return truncateText(cleanWhitespace(result.value));
  } catch (error) {
    mammothError = error;
  }
  const mammothMsg = mammothError.message || '';
  // Electron's DOMParser rejects mammoth's undefined mimeType; officeparser
  // still succeeds. Don't log that as a user-facing extraction failure.
  const mammothIsKnownElectronGap = /mimeType ["']undefined["']/.test(mammothMsg);
  if (mammothIsKnownElectronGap) {
    logger.debug('[DOCX] Mammoth skipped (Electron DOMParser mimeType); using officeparser', {
      filePath
    });
  } else {
    logger.warn('[DOCX] Mammoth extraction failed, trying officeparser fallback', {
      error: mammothMsg,
      filePath
    });
  }

  throwIfAborted(signal);
  let fallbackFailure = 'No text content in DOCX (fallback)';
  try {
    const text = await parseOfficeFile(loadOfficeParser(), filePath);
    if (text && text.trim().length > 0) {
      return truncateText(cleanWhitespace(text));
    }
  } catch (officeParserError) {
    fallbackFailure = officeParserError.message;
  }

  throwIfAborted(signal);
  const xmlText = await extractTextFromDocxXml(filePath);
  if (xmlText && xmlText.length > 0) {
    return truncateText(cleanWhitespace(xmlText));
  }

  throwIfAborted(signal);
  logger.info('[DOCX] Text extraction failed, attempting OCR for embedded images');
  const ocrText = await extractImagesFromOfficeArchiveAndOcr(filePath, 'word/media/', { signal });
  if (ocrText && ocrText.length > 0) {
    return truncateText(cleanWhitespace(ocrText));
  }

  logger.error('[DOCX] All extraction methods failed', {
    mammothError: mammothError.message,
    fallbackError: fallbackFailure
  });
  throw mammothError;
}

async function extractSharedStringsFromXlsxXml(/** @type {any} */ sharedStringsXml) {
  if (!sharedStringsXml || typeof sharedStringsXml !== 'string') return [];
  const pool = getTextExtractionPool();
  if (pool && sharedStringsXml.length > 10000) {
    try {
      return await pool.run({ type: 'xlsx_shared', payload: { text: sharedStringsXml } });
    } catch (error) {
      logger.debug('[XLSX] Worker extraction failed, falling back to sync', {
        error: error.message
      });
    }
  }
  const strings = [];
  try {
    const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/gi;
    let siMatch;
    while ((siMatch = siRegex.exec(sharedStringsXml)) !== null) {
      const siInner = siMatch[1] || '';
      const parts = [];
      const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/gi;
      let tMatch;
      while ((tMatch = tRegex.exec(siInner)) !== null) {
        parts.push(tMatch[1] || '');
      }
      const rawText = parts.length > 0 ? parts.join('') : siInner;
      strings.push(await extractPlainTextFromHtml(rawText));
      // Safety cap for pathological sharedStrings
      if (strings.length > 500000) break;
    }
  } catch (error) {
    logger.debug('[XLSX] Failed to parse sharedStrings.xml', { error: error.message });
    return [];
  }
  return strings;
}

async function extractTextFromXlsxWorksheetXml(
  /** @type {any} */ worksheetXml,
  /** @type {any} */ sharedStrings = [],
  /** @type {any} */ rowBudget
) {
  if (!worksheetXml || typeof worksheetXml !== 'string') return { text: '', rowsUsed: 0 };
  const pool = getTextExtractionPool();
  if (pool && worksheetXml.length > 10000) {
    try {
      return await pool.run({
        type: 'xlsx_worksheet',
        payload: { text: worksheetXml, sharedStrings, rowBudget }
      });
    } catch (error) {
      logger.debug('[XLSX] Worker extraction failed, falling back to sync', {
        error: error.message
      });
    }
  }
  const shared = Array.isArray(sharedStrings) ? sharedStrings : [];
  const maxRows = Number.isFinite(rowBudget) ? rowBudget : MAX_XLSX_ROWS;

  const lines = [];
  let rowsUsed = 0;
  let approxLength = 0;

  try {
    const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/gi;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(worksheetXml)) !== null) {
      if (rowsUsed >= maxRows) break;
      const rowXml = rowMatch[1] || '';
      const rowValues = [];

      const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>/gi;
      let cellMatch;
      while ((cellMatch = cellRegex.exec(rowXml)) !== null) {
        const cellAttrs = cellMatch[1] || '';
        const cellInner = cellMatch[2] || '';

        const typeMatch = /\bt=(?:"([^"]+)"|'([^']+)')/i.exec(cellAttrs);
        const cellType = typeMatch ? typeMatch[1] || typeMatch[2] : null;

        if (cellType === 'e') continue;

        const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(cellInner);
        const rawV = vMatch ? vMatch[1] : null;

        if (cellType === 's') {
          const idx = Number.parseInt(String(rawV ?? ''), 10);
          if (Number.isFinite(idx) && idx >= 0 && idx < shared.length) {
            const s = shared[idx];
            if (s) rowValues.push(s);
          } else if (rawV !== null && rawV !== undefined && String(rawV).trim()) {
            rowValues.push(String(rawV).trim());
          }
          continue;
        }

        if (cellType === 'inlineStr') {
          const parts = [];
          const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/gi;
          let tMatch;
          while ((tMatch = tRegex.exec(cellInner)) !== null) {
            parts.push(tMatch[1] || '');
          }
          const inlineText = await extractPlainTextFromHtml(parts.join(''));
          if (inlineText) rowValues.push(inlineText);
          continue;
        }

        if (rawV !== null && rawV !== undefined) {
          const cleaned = await extractPlainTextFromHtml(String(rawV));
          if (cleaned) rowValues.push(cleaned);
          continue;
        }

        // Last resort: strip tags from cell content to capture any embedded text.
        const cellText = await extractPlainTextFromHtml(cellInner);
        if (cellText) rowValues.push(cellText);
      }

      if (rowValues.length > 0) {
        const line = rowValues.join(' ');
        lines.push(line);
        rowsUsed += 1;
        approxLength += line.length + 1;
        if (approxLength > MAX_TEXT_LENGTH) break;
      }
    }
  } catch (error) {
    logger.debug('[XLSX] Worksheet XML parse failed', { error: error.message });
    return { text: '', rowsUsed: 0 };
  }

  return { text: lines.join('\n'), rowsUsed };
}

/**
 * @param {any} filePath
 * @param {{ maxRows?: number }} [options]
 */
async function extractTextFromXlsxZipFallback(filePath, { maxRows } = {}) {
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(filePath);
    if (!zip || typeof zip.getEntries !== 'function') return '';

    const entries = zip.getEntries();
    if (!Array.isArray(entries) || entries.length === 0) return '';

    const normalized = entries
      .map((entry) => ({
        entry,
        name: String(entry?.entryName || '')
          .replace(/\\/g, '/')
          .toLowerCase()
      }))
      .filter(({ name }) => name.length > 0);

    const sharedEntry = normalized.find(({ name }) => name === 'xl/sharedstrings.xml')?.entry;
    let sharedStrings = [];
    if (sharedEntry) {
      const data = safeGetZipEntryData(sharedEntry, {
        maxBytes: MAX_XLSX_ZIP_ENTRY_BYTES,
        context: 'XLSX'
      });
      if (data) {
        sharedStrings = await extractSharedStringsFromXlsxXml(data.toString('utf8'));
      }
    }

    const sheetEntries = normalized
      .filter(({ name }) => name.startsWith('xl/worksheets/') && name.endsWith('.xml'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ entry }) => entry);

    if (sheetEntries.length === 0 && sharedStrings.length === 0) return '';

    let remainingRows = Math.max(0, Number.isFinite(maxRows) ? maxRows : MAX_XLSX_ROWS);
    let extracted = '';
    let processedEntries = 0;

    for (const entry of sheetEntries) {
      if (processedEntries >= MAX_XLSX_ZIP_ENTRIES) break;
      if (remainingRows <= 0) break;
      if (!entry || typeof entry.getData !== 'function') continue;

      const data = safeGetZipEntryData(entry, {
        maxBytes: MAX_XLSX_ZIP_ENTRY_BYTES,
        context: 'XLSX'
      });
      if (!data) continue;

      const xml = data.toString('utf8');
      const { text, rowsUsed } = await extractTextFromXlsxWorksheetXml(
        xml,
        sharedStrings,
        remainingRows
      );
      if (text && text.trim()) {
        extracted += `${text}\n`;
      }
      remainingRows -= rowsUsed;
      processedEntries += 1;

      if (extracted.length > MAX_TEXT_LENGTH) {
        extracted = truncateText(extracted);
        break;
      }
    }

    // If we couldn't read worksheets but have shared strings, return them as a last-resort signal.
    if (!extracted.trim() && sharedStrings.length > 0) {
      extracted = sharedStrings.filter(Boolean).join('\n');
    }

    return truncateText(cleanWhitespace(extracted.trim()));
  } catch (error) {
    logger.debug('[XLSX] ZIP fallback failed', { error: error.message });
    return '';
  }
}

// Excel number formats that render a day serial as a date, a time of day,
// both, or an elapsed duration. Quoted literals and [colour]/[locale]
// prefixes are removed first: their letters are not format codes. Bracketed
// [h] [m] [s] are elapsed-time tokens and are read before that strip.
const XLSX_ELAPSED_PATTERN = /\[(h+|m+|s+)\]/i;

/** @param {any} numberFormat */
function stripXlsxFormatLiterals(numberFormat) {
  return String(numberFormat)
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '');
}

/**
 * The date/time fields of a literal-stripped format code, in the order they
 * appear, plus the section breaks between them. A run of one letter is one
 * field, since only the letter and the run's length say which field it is:
 *
 * - 'y' | 'd' | 'h' | 's' — a year, day, hour or seconds field.
 * - 'm' — a run of one or two m's: Excel's one ambiguous code, a month or a
 *   minute depending on what sits beside it.
 * - 'mon' — a run of three or more m's. 'mmm', 'mmmm' and 'mmmmm' spell a
 *   month name ("Mar", "March", "M"); Excel writes minutes only as m or mm,
 *   so these are a month whatever they sit beside.
 * - 'ap' — a consumed AM/PM or A/P clock marker.
 * - ';' — a section break. The positive/negative/zero/text sections are
 *   separate formats, so a field in one cannot change what an m in another
 *   means.
 *
 * This is a tokenizer rather than a strip-the-time-tokens regex because what
 * an `m` means depends on its neighbours, and separators are optional: the
 * regex that preceded it could only recognise colon-joined pairs, so the
 * minutes in built-in format 47 ('mmss.0') and in customs like 'hhmm' read
 * as a month and turned a duration into an 1899 date.
 *
 * @param {string} code  literal-stripped format code
 * @returns {string[]}
 */
function xlsxFormatTokens(code) {
  const lower = code.toLowerCase();
  /** @type {string[]} */
  const tokens = [];
  for (let i = 0; i < lower.length; i += 1) {
    const char = lower[i];
    if (char === ';') {
      tokens.push(';');
      continue;
    }
    if (char === 'a') {
      // Clock markers: their letters name no field, and consuming them whole
      // keeps the 'm' of AM/PM out of the token stream.
      if (lower.startsWith('am/pm', i)) {
        tokens.push('ap');
        i += 4;
      } else if (lower.startsWith('a/p', i)) {
        tokens.push('ap');
        i += 2;
      }
      continue;
    }
    if (char !== 'y' && char !== 'm' && char !== 'd' && char !== 'h' && char !== 's') continue;
    let run = 1;
    while (lower[i + run] === char) run += 1;
    i += run - 1;
    tokens.push(char === 'm' && run >= 3 ? 'mon' : char);
  }
  return tokens;
}

/**
 * What a number format shows for a day serial.
 * @param {any} numberFormat
 * @returns {'date'|'datetime'|'time'|'elapsed'|null}  null when it is not a date or time format
 */
function xlsxFormatKind(numberFormat) {
  if (typeof numberFormat !== 'string' || !numberFormat) return null;
  if (/^general$/i.test(numberFormat.trim())) return null;
  const code = stripXlsxFormatLiterals(numberFormat);
  // [h] [m] [s] count past their range: a duration, whose remaining m/s
  // tokens are minutes and seconds, never a calendar day.
  if (XLSX_ELAPSED_PATTERN.test(numberFormat)) return /[yd]/i.test(code) ? 'datetime' : 'elapsed';
  const tokens = xlsxFormatTokens(code);
  let hasDay = false;
  let hasTime = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === 'y' || token === 'd' || token === 'mon') hasDay = true;
    else if (token === 'h' || token === 's' || token === 'ap') hasTime = true;
    else if (token === 'm') {
      // Excel's own rule, which is about adjacent FIELDS, not adjacent
      // characters: an m or mm is minutes when it is the field right after an
      // hour or right before seconds. Separators between the two are
      // irrelevant ('hhmm', 'h:mm' and 'h" at "mm' all mean minutes), but
      // another field or a section break in between is not ('h mmmm' is an
      // hour and a month name; '0.00;mm;ss' is three separate formats).
      // Anywhere else m is a month.
      if (tokens[i - 1] === 'h' || tokens[i + 1] === 's') hasTime = true;
      else hasDay = true;
    }
  }
  if (hasDay && hasTime) return 'datetime';
  if (hasDay) return 'date';
  if (hasTime) return 'time';
  return null;
}

/** @param {any} numberFormat */
function isXlsxDateFormat(numberFormat) {
  return xlsxFormatKind(numberFormat) !== null;
}

const pad2 = (/** @type {number} */ n) => String(n).padStart(2, '0');

/**
 * @param {Date} date
 * @param {{ withTime: boolean }} options
 */
function xlsxDateToText(date, { withTime }) {
  const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return withTime ? `${day} ${pad2(date.getHours())}:${pad2(date.getMinutes())}` : day;
}

/**
 * Time of day from the fractional part of a serial: HH:MM, or HH:MM:SS when
 * the format shows seconds. The day is omitted; Excel's own display of an
 * h:mm cell never mentions 30 December 1899.
 * @param {number} serial
 * @param {string} numberFormat
 */
function xlsxTimeOfDayToText(serial, numberFormat) {
  const fraction = serial - Math.floor(serial);
  const showSeconds = /s/i.test(stripXlsxFormatLiterals(numberFormat));
  if (showSeconds) {
    const total = Math.round(fraction * 86400) % 86400;
    return `${pad2(Math.floor(total / 3600))}:${pad2(Math.floor((total % 3600) / 60))}:${pad2(total % 60)}`;
  }
  const minutes = Math.round(fraction * 1440) % 1440;
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

/**
 * Elapsed duration for [h]:mm:ss, [mm]:ss and [ss] formats: the bracketed
 * unit runs past its usual range (36 hours stays 36:00:00).
 * @param {number} serial  days
 * @param {string} numberFormat
 */
function xlsxElapsedToText(serial, numberFormat) {
  const unit = (numberFormat.match(XLSX_ELAPSED_PATTERN)?.[1] || 'h')[0].toLowerCase();
  const code = stripXlsxFormatLiterals(numberFormat);
  const totalSeconds = Math.round(serial * 86400);
  if (unit === 's') return String(totalSeconds);
  if (unit === 'm') {
    const minutes = Math.floor(totalSeconds / 60);
    return /s/i.test(code) ? `${minutes}:${pad2(totalSeconds % 60)}` : String(minutes);
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return /s/i.test(code)
    ? `${hours}:${pad2(minutes)}:${pad2(totalSeconds % 60)}`
    : `${hours}:${pad2(minutes)}`;
}

// Serial of 1904-01-01 in the 1900 date system: a workbook saved with
// <workbookPr date1904="1"/> counts its days from there.
const XLSX_1904_EPOCH_OFFSET_DAYS = 1462;

/**
 * Whether the workbook uses the 1904 date system (Excel for Mac heritage,
 * still a per-file option that travels with the file). xlsx-populate keeps
 * the parsed xl/workbook.xml on `_node`; absent that, the 1900 system is
 * assumed as it always was.
 * @param {any} workbook
 * @returns {boolean}
 */
function readXlsxDate1904(workbook) {
  try {
    const children = workbook?._node?.children;
    if (!Array.isArray(children)) return false;
    const pr = children.find((/** @type {any} */ c) => c?.name === 'workbookPr');
    const flag = pr?.attributes?.date1904;
    return flag === '1' || flag === 'true' || flag === 1 || flag === true;
  } catch {
    return false;
  }
}

/**
 * Text for one spreadsheet cell. Dates are stored as day serials and come
 * back as numbers, so a date-formatted cell is rendered as a date, a
 * time-formatted one as a time of day and an [h]:mm one as a duration; rich
 * text and formula errors are objects and are rendered as their text rather
 * than "[object Object]". Returns null for a cell with nothing to say.
 * @param {any} value
 * @param {string|null} numberFormat
 * @param {any} XLSX xlsx-populate module (for numberToDate)
 * @param {{ date1904?: boolean }} [options]
 * @returns {string|null}
 */
function formatXlsxCellValue(value, numberFormat, XLSX, options = {}) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const kind = xlsxFormatKind(numberFormat);
    if (kind === 'time') return `${pad2(value.getHours())}:${pad2(value.getMinutes())}`;
    const midnight = value.getHours() === 0 && value.getMinutes() === 0;
    return xlsxDateToText(value, {
      withTime: kind ? kind === 'datetime' : !midnight
    });
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'function') return String(value.text());
    if (typeof value.error === 'function') return String(value.error());
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const kind = xlsxFormatKind(numberFormat);
    const format = /** @type {string} */ (numberFormat);
    if (kind === 'time') return xlsxTimeOfDayToText(value, format);
    if (kind === 'elapsed') return xlsxElapsedToText(value, format);
    if (kind && typeof XLSX?.numberToDate === 'function') {
      const serial = options.date1904 ? value + XLSX_1904_EPOCH_OFFSET_DAYS : value;
      const date = XLSX.numberToDate(serial);
      if (date instanceof Date && !Number.isNaN(date.getTime())) {
        return xlsxDateToText(date, { withTime: kind === 'datetime' });
      }
    }
  }
  return String(value);
}

/**
 * The cell's number format code without allocating a Style. xlsx-populate's
 * cell.style() creates a Style per call, and StyleSheet.createStyle clones
 * the xf and pushes font, fill, border and xf nodes each time, so reading
 * every cell of a 10,000 x 200 sheet that way grew the heap by about 700
 * bytes a cell. The xf node already holds numFmtId; it is read directly and
 * memoized per style id (ids are workbook-wide). Cells from other sources
 * (tests, older shapes) still answer through style().
 * @param {any} cell
 * @param {Map<any, string|null>} [formatCache]  one per workbook
 * @returns {string|null}
 */
function xlsxCellNumberFormat(cell, formatCache) {
  try {
    const styleId = Number.isInteger(cell?._styleId) ? cell._styleId : 0;
    const styleSheet = cell?.workbook?.()?.styleSheet?.();
    const xfNodes = styleSheet?._cellXfsNode?.children;
    if (Array.isArray(xfNodes) && typeof styleSheet.getNumberFormatCode === 'function') {
      if (formatCache?.has(styleId)) return formatCache.get(styleId) ?? null;
      const numFmtId = xfNodes[styleId]?.attributes?.numFmtId;
      const code = numFmtId === undefined ? null : styleSheet.getNumberFormatCode(Number(numFmtId));
      const format = typeof code === 'string' ? code : null;
      formatCache?.set(styleId, format);
      return format;
    }
    const format = cell?.style?.('numberFormat');
    return typeof format === 'string' ? format : null;
  } catch {
    return null;
  }
}

/**
 * The used range, narrowed to the row and column caps before its cells are
 * materialized. Falls back to the range as given when the sheet cannot
 * re-address it.
 * @param {any} sheet
 * @param {any} usedRange
 */
function capXlsxRange(sheet, usedRange) {
  try {
    const startCell = usedRange?.startCell?.();
    const endCell = usedRange?.endCell?.();
    if (!startCell || !endCell || typeof sheet?.range !== 'function') return usedRange;
    const startRow = startCell.rowNumber();
    const startCol = startCell.columnNumber();
    const endRow = Math.min(endCell.rowNumber(), startRow + MAX_XLSX_ROWS - 1);
    const endCol = Math.min(endCell.columnNumber(), startCol + MAX_XLSX_COLUMNS - 1);
    if (endRow === endCell.rowNumber() && endCol === endCell.columnNumber()) return usedRange;
    logger.warn('[XLSX] Used range capped before reading cells', {
      sheetName: sheet?.name?.() || 'unknown',
      rows: endCell.rowNumber() - startRow + 1,
      columns: endCell.columnNumber() - startCol + 1,
      maxRows: MAX_XLSX_ROWS,
      maxColumns: MAX_XLSX_COLUMNS
    });
    return sheet.range(startRow, startCol, endRow, endCol) || usedRange;
  } catch {
    return usedRange;
  }
}

async function extractTextFromXlsx(/** @type {any} */ filePath) {
  const XLSX = require('xlsx-populate');
  // Fixed: Check file size before loading workbook
  await checkFileSize(filePath, filePath);
  await assertZipUncompressedCap(filePath, 'XLSX');

  let workbook;
  let allText = '';
  let primaryMethodFailed = false;
  let primaryErrorMessage = null;

  try {
    workbook = await XLSX.fromFileAsync(filePath);

    if (!workbook || typeof workbook.sheets !== 'function') {
      throw new Error('Invalid workbook structure: sheets() method not available');
    }

    const sheets = workbook.sheets();
    if (!Array.isArray(sheets) || sheets.length === 0) {
      throw new Error('No sheets found in XLSX file');
    }

    const cellOptions = { date1904: readXlsxDate1904(workbook) };
    if (cellOptions.date1904) {
      logger.debug('[XLSX] Workbook uses the 1904 date system');
    }
    /** @type {Map<any, string|null>} */
    const formatCache = new Map();
    let totalRows = 0;

    for (const sheet of sheets) {
      try {
        if (!sheet || typeof sheet.usedRange !== 'function') {
          logger.warn('[XLSX] Sheet missing usedRange method, skipping', {
            sheetName: sheet?.name() || 'unknown'
          });
          continue;
        }

        const usedRange = sheet.usedRange();
        if (!usedRange) {
          logger.debug('[XLSX] Sheet has no used range, skipping', {
            sheetName: sheet?.name() || 'unknown'
          });
          continue;
        }

        if (typeof usedRange.value !== 'function') {
          logger.warn('[XLSX] usedRange missing value() method, trying alternative extraction', {
            sheetName: sheet?.name() || 'unknown'
          });

          // Fallback: Try to extract cell values manually
          try {
            const startCell = usedRange.startCell();
            const endCell = usedRange.endCell();
            if (startCell && endCell) {
              const startRow = startCell.rowNumber();
              const endRow = endCell.rowNumber();
              const startCol = startCell.columnNumber();
              const endCol = endCell.columnNumber();

              for (let row = startRow; row <= endRow && totalRows < MAX_XLSX_ROWS; row++) {
                const rowData = [];
                for (let col = startCol; col <= endCol; col++) {
                  try {
                    const cell = sheet.cell(row, col);
                    if (cell) {
                      const text = formatXlsxCellValue(
                        cell.value(),
                        xlsxCellNumberFormat(cell, formatCache),
                        XLSX,
                        cellOptions
                      );
                      if (text !== null && text !== '') rowData.push(text);
                    }
                  } catch (cellError) {
                    // Skip individual cell errors
                    logger.debug('[XLSX] Cell read error', { error: cellError.message, row, col });
                  }
                }
                if (rowData.length > 0) {
                  allText += `${rowData.join(' ')}\n`;
                  totalRows++;
                }
              }
            }
          } catch (fallbackError) {
            logger.warn('[XLSX] Fallback extraction failed', {
              error: fallbackError.message,
              sheetName: sheet?.name() || 'unknown'
            });
          }
          continue;
        }

        // Cells carry the number format that tells a date serial from a
        // number; the plain value grid does not. Prefer them when available.
        if (typeof usedRange.cells === 'function') {
          /** @type {any[][]|null} */
          let cellRows = null;
          try {
            cellRows = capXlsxRange(sheet, usedRange).cells();
          } catch (cellsError) {
            logger.debug('[XLSX] usedRange.cells() failed; using values', {
              error: cellsError.message,
              sheetName: sheet?.name() || 'unknown'
            });
          }
          if (Array.isArray(cellRows)) {
            const cellRowsToProcess = Math.min(cellRows.length, MAX_XLSX_ROWS);
            if (cellRows.length > MAX_XLSX_ROWS) {
              logger.warn('[XLSX] Sheet row limit applied', {
                totalRows: cellRows.length,
                limit: MAX_XLSX_ROWS
              });
            }
            for (let i = 0; i < cellRowsToProcess; i++) {
              const rowCells = Array.isArray(cellRows[i]) ? cellRows[i] : [];
              /** @type {string[]} */
              const texts = [];
              for (const cell of rowCells) {
                try {
                  const text = formatXlsxCellValue(
                    cell?.value?.(),
                    xlsxCellNumberFormat(cell, formatCache),
                    XLSX,
                    cellOptions
                  );
                  if (text !== null && text !== '') texts.push(text);
                } catch (cellError) {
                  logger.debug('[XLSX] Cell read error', { error: cellError.message });
                }
              }
              if (texts.length > 0) {
                allText += `${texts.join(' ')}\n`;
                totalRows++;
              }
              if (totalRows % 1000 === 0 && allText.length > MAX_TEXT_LENGTH) {
                allText = truncateText(allText);
                break;
              }
            }
            if (allText.length > MAX_TEXT_LENGTH) break;
            continue;
          }
        }

        const values = usedRange.value();
        if (!Array.isArray(values)) {
          logger.warn('[XLSX] usedRange.value() did not return array', {
            sheetName: sheet?.name() || 'unknown',
            valueType: typeof values
          });
          continue;
        }

        // Fixed: Limit rows to prevent memory exhaustion
        const rowsToProcess = Math.min(values.length, MAX_XLSX_ROWS);
        if (values.length > MAX_XLSX_ROWS) {
          logger.warn('[XLSX] Sheet row limit applied', {
            totalRows: values.length,
            limit: MAX_XLSX_ROWS
          });
        }

        for (let i = 0; i < rowsToProcess; i++) {
          const row = values[i];
          if (Array.isArray(row)) {
            allText += `${row
              .map((cell) => formatXlsxCellValue(cell, null, XLSX))
              .filter((text) => text !== null && text !== '')
              .join(' ')}\n`;
            totalRows++;

            // Fixed: Check text length periodically to prevent runaway memory
            if (totalRows % 1000 === 0 && allText.length > MAX_TEXT_LENGTH) {
              allText = truncateText(allText);
              break;
            }
          } else if (row && typeof row === 'object' && !Array.isArray(row)) {
            // Handle object rows (e.g., { columnA: 'value1', columnB: 'value2' })
            const objectValues = Object.values(row)
              .map((cell) => formatXlsxCellValue(cell, null, XLSX))
              .filter((text) => text !== null && text !== '');
            if (objectValues.length > 0) {
              allText += `${objectValues.join(' ')}\n`;
              totalRows++;
            }
          } else if (row !== null && row !== undefined) {
            // Handle scalar rows (single value)
            allText += `${String(row)}\n`;
            totalRows++;
          }
        }

        if (allText.length > MAX_TEXT_LENGTH) break;
      } catch (sheetError) {
        // Log sheet-level errors but continue processing other sheets
        logger.warn('[XLSX] Error processing sheet', {
          error: sheetError.message,
          sheetName: sheet?.name() || 'unknown'
        });
        continue;
      }
    }
  } catch (primaryError) {
    logger.warn('[XLSX] Primary extraction failed', { error: primaryError.message });
    primaryMethodFailed = true;
    primaryErrorMessage = primaryError?.message || String(primaryError);
  } finally {
    // Explicit cleanup (intentional for GC)
    // eslint-disable-next-line no-useless-assignment -- cleanup before scope exit
    workbook = null;
  }

  allText = allText.trim();
  if (!allText) {
    logger.info('[XLSX] Trying ZIP-based fallback extraction');
    const zipText = await extractTextFromXlsxZipFallback(filePath);
    if (zipText && zipText.trim()) {
      return zipText;
    }

    let officeParserErrorMessage = null;
    try {
      logger.info(
        primaryMethodFailed
          ? '[XLSX] ZIP fallback returned no text, trying officeParser fallback after primary failure'
          : '[XLSX] ZIP fallback returned no text, trying officeParser fallback'
      );
      const fallbackText = await parseOfficeFile(loadOfficeParser(), filePath);
      if (fallbackText && fallbackText.trim()) {
        return truncateText(fallbackText);
      }
    } catch (fallbackError) {
      officeParserErrorMessage = fallbackError?.message || String(fallbackError);
      logger.warn('[XLSX] Fallback extraction also failed', {
        error: officeParserErrorMessage
      });
    }

    const errorMsg = primaryMethodFailed ? 'XLSX extraction failed' : 'No text content in XLSX';
    if (primaryMethodFailed) {
      logger.error('[XLSX] Extraction failed', { filePath, error: errorMsg });
    }

    throw new FileProcessingError('XLSX_EXTRACTION_FAILURE', filePath, {
      originalError: errorMsg,
      primaryError: primaryErrorMessage,
      officeParserError: officeParserErrorMessage,
      suggestion: 'XLSX file may be corrupted, password-protected, or in an unsupported format'
    });
  }

  // Fixed: Truncate final result
  return truncateText(cleanWhitespace(allText));
}

/**
 * @param {string} filePath
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<string>}
 */
async function extractTextFromPptx(filePath, options = {}) {
  const { signal } = options;
  const AdmZip = require('adm-zip');
  // Fixed: Check file size before reading
  await checkFileSize(filePath, filePath);
  await assertZipUncompressedCap(filePath, 'PPTX');
  throwIfAborted(signal);

  let text = '';
  let primaryMethodFailed = false;

  try {
    text = await parseOfficeFile(loadOfficeParser(), filePath);
  } catch (primaryError) {
    logger.warn('[PPTX] Primary extraction failed, trying fallback', {
      error: primaryError.message,
      filePath
    });
    primaryMethodFailed = true;
  }

  if (!text || text.trim().length === 0) {
    logger.warn(
      primaryMethodFailed
        ? '[PPTX] Trying ZIP-based extraction after primary failure'
        : '[PPTX] Primary extraction returned no text, trying ZIP-based extraction'
    );
    try {
      const zip = new AdmZip(filePath);
      const entries = zip.getEntries();
      let extractedText = '';

      // Extract text from slide XML files
      for (const entry of entries) {
        const name = entry.entryName.toLowerCase();
        if (name.startsWith('ppt/slides/slide') && name.endsWith('.xml')) {
          try {
            const entryData = safeGetZipEntryData(entry, { context: 'PPTX' });
            if (!entryData) {
              logger.debug('[PPTX] Entry data unavailable or over size limit', { entry: name });
              continue;
            }
            const xmlContent = entryData.toString('utf8');
            // Extract text from XML (simple tag stripping)
            const slideText = await extractPlainTextFromHtml(xmlContent);
            if (slideText && slideText.trim()) {
              extractedText += `${slideText}\n`;
            }

            // Limit processing to prevent memory issues
            if (extractedText.length > MAX_TEXT_LENGTH) {
              break;
            }
          } catch (entryError) {
            // Skip individual entry errors
            logger.debug('[PPTX] Error processing slide entry', {
              entry: name,
              error: entryError.message
            });
          }
        }
      }

      if (extractedText && extractedText.trim()) {
        return truncateText(extractedText);
      }
    } catch (zipError) {
      logger.warn('[PPTX] ZIP-based extraction failed', {
        error: zipError.message
      });
    }

    // Fallback 3: OCR for image-heavy presentations
    throwIfAborted(signal);
    try {
      logger.info('[PPTX] Text extraction failed, attempting OCR for embedded images');
      const ocrText = await extractImagesFromOfficeArchiveAndOcr(filePath, 'ppt/media/', {
        signal
      });
      if (ocrText && ocrText.length > 0) {
        return truncateText(ocrText);
      }
    } catch (ocrError) {
      if (isAbortError(ocrError)) throw ocrError;
      logger.warn('[PPTX] OCR fallback failed', { error: ocrError.message });
    }

    // If we reach here, both methods failed or returned empty
    const errorMsg = primaryMethodFailed ? 'PPTX extraction failed' : 'No text content in PPTX';

    // Only log error if primary failed too, otherwise it's just empty content
    if (primaryMethodFailed) {
      logger.error('[PPTX] Extraction failed', { filePath, error: errorMsg });
    }

    // Re-throw as FileProcessingError for consistent error handling
    throw new FileProcessingError('PPTX_EXTRACTION_FAILURE', filePath, {
      originalError: errorMsg,
      suggestion: 'PPTX file may be corrupted, password-protected, or in an unsupported format'
    });
  }

  // Fixed: Truncate result to prevent memory issues
  return truncateText(cleanWhitespace(text));
}

async function extractPlainTextFromHtml(/** @type {any} */ html) {
  if (!html) return '';
  const pool = getTextExtractionPool();
  if (pool && html.length > 10000) {
    try {
      return await pool.run({ type: 'html', payload: { text: html } });
    } catch (error) {
      logger.debug('[HTML] Worker extraction failed, falling back to sync', {
        error: error.message
      });
    }
  }
  // Fallback / small strings
  try {
    const withoutScripts = html.replace(REGEX_PATTERNS.scriptTags, '');
    const withoutStyles = withoutScripts.replace(REGEX_PATTERNS.styleTags, '');
    const withoutTags = withoutStyles.replace(REGEX_PATTERNS.htmlTags, ' ');
    // Numeric and named references both (the old six-entity table left
    // caf&eacute; and it&#8217;s in the indexed text).
    const entitiesDecoded = decodeHtmlEntities(withoutTags);
    return entitiesDecoded.replace(REGEX_PATTERNS.whitespace, ' ').trim();
  } catch (error) {
    logger.debug('[HTML] Plain text extraction failed', { error: error.message });
    return html;
  }
}

async function extractPlainTextFromRtf(/** @type {any} */ rtf) {
  if (!rtf) return '';
  const pool = getTextExtractionPool();
  if (pool && rtf.length > 10000) {
    try {
      return await pool.run({ type: 'rtf', payload: { text: rtf } });
    } catch (error) {
      logger.debug('[RTF] Worker extraction failed, falling back to sync', {
        error: error.message
      });
    }
  }
  // Fallback / small strings: the shared tokenizer (also used by the worker).
  try {
    return rtfToText(rtf);
  } catch (error) {
    logger.debug('[RTF] Extraction failed', { error: error.message });
    return rtf;
  }
}

// ODF (.odt/.ods/.odp): officeparser understands the OpenDocument structure
// (paragraphs, headings, table cells, entities); the content.xml tag stripper
// stays as the fallback because it also handles files officeparser rejects.
async function extractTextFromOdfZip(/** @type {any} */ filePath) {
  await checkFileSize(filePath, filePath);
  try {
    const parsed = await parseOfficeFile(loadOfficeParser(), filePath);
    if (parsed && parsed.trim().length > 0) return truncateText(parsed);
  } catch (primaryError) {
    logger.debug('[ODF] officeparser failed, using content.xml fallback', {
      error: primaryError?.message
    });
  }
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(filePath);
    const entry = zip.getEntry('content.xml');
    if (!entry) return '';
    const data = safeGetZipEntryData(entry, { context: 'ODF' });
    if (!data) return '';
    const xml = data.toString('utf8');
    return await extractPlainTextFromHtml(xml);
  } catch (error) {
    logger.error('Failed to extract ODF content:', { filePath, error: error.message });
    throw new FileProcessingError('ODF_EXTRACTION_FAILURE', filePath, {
      suggestion: 'ODF file may be corrupted or in an unsupported format',
      originalError: error.message
    });
  }
}

async function extractTextFromEpub(/** @type {any} */ filePath) {
  const AdmZip = require('adm-zip');
  // Fixed: Check file size before processing
  await checkFileSize(filePath, filePath);

  /** @type {any} */
  let zip;
  try {
    zip = new AdmZip(filePath);
    // Read the OPF: chapters in spine order with the title and authors first.
    // Without it the archive order decided the reading order and the book's
    // own title never reached the text.
    /** @type {{ structure: any, entryNames: string[] | null, header: string }} */
    let plan = { structure: null, entryNames: null, header: '' };
    try {
      const epubStructure = require('./extractors/epubStructure');
      const structure = epubStructure.readEpubStructure(zip);
      const picked = epubStructure.pickEpubEntriesForText(zip, structure);
      const header = structure ? await epubStructure.describeEpubHeader(structure) : '';
      plan = {
        structure,
        entryNames: Array.isArray(picked) && picked.length > 0 ? picked : null,
        header: typeof header === 'string' ? header : ''
      };
    } catch (structureError) {
      logger.debug('[EPUB] OPF structure unavailable, using archive order', {
        error: structureError?.message
      });
    }
    const allEntries = zip.getEntries();
    // Resolve spine names against the listing already in hand rather than a
    // per-name `getEntry` round trip (which some zip handles do not expose).
    /** @type {Map<string, any>} */
    const entriesByName = new Map();
    for (const entry of allEntries) {
      if (entry && typeof entry.entryName === 'string' && !entriesByName.has(entry.entryName)) {
        entriesByName.set(entry.entryName, entry);
      }
    }
    const entries = plan.entryNames
      ? plan.entryNames
          .map(
            (/** @type {string} */ name) =>
              entriesByName.get(name) ||
              (typeof zip.getEntry === 'function' ? zip.getEntry(name) : null)
          )
          .filter((/** @type {any} */ e) => Boolean(e))
      : allEntries;
    let text = plan.header ? `${plan.header}\n\n` : '';
    let processedEntries = 0;

    for (const e of entries) {
      const name = e.entryName.toLowerCase();
      if (name.endsWith('.xhtml') || name.endsWith('.html') || name.endsWith('.htm')) {
        try {
          const entryData = safeGetZipEntryData(e, { context: 'EPUB' });
          if (!entryData) continue;
          const html = entryData.toString('utf8');
          text += `${await extractPlainTextFromHtml(html)}\n`;
          processedEntries++;

          // Fixed: Limit number of entries and text length
          if (processedEntries >= 100 || text.length > MAX_TEXT_LENGTH) {
            text = truncateText(text);
            break;
          }
        } catch (error) {
          // Expected: Skip corrupt entries in archive
          logger.debug('Skipping corrupt archive entry', {
            error: error.message
          });
        }
      }
    }

    const result = text.trim();
    return truncateText(result);
  } finally {
    // Explicit cleanup (intentional for GC)
    zip = null;
  }
}

async function extractTextFromEml(/** @type {any} */ filePath) {
  // Fixed: Check file size before reading
  await checkFileSize(filePath, filePath);

  // Outlook "Save As" can emit UTF-16 .eml — a hard-coded utf8 read decodes
  // it to NUL-interleaved mojibake that matches no header regex.
  const raw = await readTextFileWithEncoding(filePath);

  try {
    const PostalMime = loadPostalMime();
    const parsed = await new PostalMime().parse(raw);
    const text = await composeMailText({
      subject: parsed?.subject || '',
      from: formatMailbox(parsed?.from),
      to: Array.isArray(parsed?.to) ? parsed.to.map(formatMailbox).filter(Boolean).join(', ') : '',
      text: parsed?.text || '',
      html: parsed?.html || '',
      attachments: Array.isArray(parsed?.attachments)
        ? parsed.attachments.map((/** @type {any} */ a) => a?.filename).filter(Boolean)
        : []
    });
    if (text.trim()) return truncateText(text);
  } catch (error) {
    logger.warn('[EML] MIME parse failed; falling back to header split', {
      error: error.message
    });
  }

  // Last resort for a file postal-mime cannot parse at all: headers people
  // search by plus the raw body, as before.
  const parts = raw.split(REGEX_PATTERNS.doubleNewline);
  const headers = parts[0] || '';
  const body = parts.slice(1).join('\n\n');
  const subject = (headers.match(REGEX_PATTERNS.subjectHeader) || [])[1] || '';
  const from = (headers.match(REGEX_PATTERNS.fromHeader) || [])[1] || '';
  const to = (headers.match(REGEX_PATTERNS.toHeader) || [])[1] || '';
  return truncateText([subject, from, to, body].filter(Boolean).join('\n'));
}

/**
 * Plain text of a PR_RTF_COMPRESSED body: inflate with the decoder msgreader
 * itself depends on, then run the same RTF tokenizer .rtf files use. Returns
 * '' when the bytes cannot be read; the headers still get indexed.
 * @param {Uint8Array} compressedRtf
 * @returns {Promise<string>}
 */
async function msgBodyFromCompressedRtf(compressedRtf) {
  try {
    const { decompressRTF } = /** @type {any} */ (require('@kenjiuno/decompressrtf'));
    const bytes = decompressRTF(Array.from(compressedRtf));
    if (!Array.isArray(bytes) || bytes.length === 0) return '';
    // RTF is 7-bit with \'xx escapes for anything else; latin1 keeps each
    // byte a character so the tokenizer sees the escapes as written.
    const rtf = Buffer.from(bytes).toString('latin1');
    const text = await extractPlainTextFromRtf(rtf);
    return typeof text === 'string' ? text.trim() : '';
  } catch (error) {
    logger.debug('[MSG] Compressed RTF body could not be read', { error: error?.message });
    return '';
  }
}

async function extractTextFromMsg(/** @type {any} */ filePath) {
  await checkFileSize(filePath, filePath);
  try {
    const MsgReader = loadMsgReader();
    const buffer = await fs.readFile(filePath);
    const data = new MsgReader(buffer).getFileData();
    if (!data || data.error) {
      throw new Error(data?.error || 'Unrecognized Outlook message');
    }
    const recipients = Array.isArray(data.recipients) ? data.recipients : [];
    let body = typeof data.body === 'string' ? data.body : '';
    const html = typeof data.bodyHtml === 'string' ? data.bodyHtml : '';
    let bodySource = body.trim() ? 'body' : html.trim() ? 'html' : 'none';
    // Exchange exports often carry the body as PR_RTF_COMPRESSED alone, with
    // PR_BODY synthesized on demand by Outlook. Without this the message was
    // indexed as subject, addresses and attachment names and counted as a
    // complete extraction, so nothing ever came back for its words.
    if (bodySource === 'none' && data.compressedRtf && data.compressedRtf.length > 0) {
      body = await msgBodyFromCompressedRtf(data.compressedRtf);
      if (body) bodySource = 'compressedRtf';
    }
    logger.debug('[MSG] Body source', { bodySource });
    const text = await composeMailText({
      subject: data.subject || '',
      from: formatMailbox({
        name: data.senderName,
        address: data.senderEmail || data.senderSmtpAddress
      }),
      to: recipients
        .map((/** @type {any} */ r) =>
          formatMailbox({ name: r?.name, address: r?.email || r?.smtpAddress })
        )
        .filter(Boolean)
        .join(', '),
      text: body,
      html,
      attachments: Array.isArray(data.attachments)
        ? data.attachments.map((/** @type {any} */ a) => a?.fileName || a?.name).filter(Boolean)
        : []
    });
    return truncateText(text);
  } catch (error) {
    logger.warn('[MSG] Outlook message extraction failed', { error: error.message });
    throw new FileProcessingError('DOC_EXTRACTION_FAILURE', filePath, {
      suggestion: 'The Outlook message may be corrupted or not an OLE .msg file',
      originalError: error.message
    });
  }
}

async function extractTextFromKml(/** @type {any} */ filePath) {
  await checkFileSize(filePath, filePath);
  const xml = await readTextFileWithEncoding(filePath);
  return await extractPlainTextFromHtml(xml);
}

async function extractTextFromKmz(/** @type {any} */ filePath) {
  await checkFileSize(filePath, filePath);
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(filePath);
  const kmlEntry =
    zip.getEntry('doc.kml') ||
    zip.getEntries().find((/** @type {any} */ e) => e.entryName.toLowerCase().endsWith('.kml'));
  if (!kmlEntry) return '';
  const kmlData = safeGetZipEntryData(kmlEntry, { context: 'KMZ' });
  if (!kmlData) return '';
  const xml = kmlData.toString('utf8');
  return await extractPlainTextFromHtml(xml);
}

/**
 * Excel 97-2003 (.xls) and PowerPoint 97-2003 (.ppt) have no reader in this
 * build: officeparser rejects every OLE format, the npm `xlsx` build carries
 * open advisories that fail the production audit, and no maintained
 * permissively licensed .ppt parser exists. Saying so immediately (instead of
 * returning '' and letting the pipeline retry) sends the file to the filename
 * fallback with an honest reason (audit row MI-01).
 * @param {string} filePath
 * @param {'.xls'|'.ppt'} fileType
 * @param {string} suggestion
 */
function legacyFormatUnsupported(filePath, fileType, suggestion) {
  return new FileProcessingError('LEGACY_FORMAT_UNSUPPORTED', filePath, {
    fileType,
    suggestion
  });
}

/**
 * Many ".xls" and ".ppt" files are not BIFF or PPT97 at all: web apps
 * export HTML tables and CSV under .xls, and a renamed Office Open XML zip
 * keeps working in Excel and PowerPoint. Read those for what they are;
 * only a true OLE compound file is the legacy format this build cannot read.
 * @param {string} filePath
 * @returns {Promise<'zip'|'rtf'|'text'|'ole'|'unknown'>}
 */
async function sniffLegacyOfficeKind(filePath) {
  const head = await readFileSignature(filePath, 512);
  if (isZipFile(head)) return 'zip';
  if (isOleCompoundFile(head)) return 'ole';
  if (looksLikeRtf(head)) return 'rtf';
  if (looksLikePlainText(head)) return 'text';
  return 'unknown';
}

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function readTextOrHtmlDisguisedAsOffice(filePath) {
  const text = await readTextFileWithEncoding(filePath);
  if (/<\s*(html|table|body|tr|td)\b/i.test(text.slice(0, 4096))) {
    return truncateText(await extractPlainTextFromHtml(text));
  }
  return truncateText(text);
}

async function extractTextFromXls(/** @type {any} */ filePath) {
  await checkFileSize(filePath, filePath);
  const kind = await sniffLegacyOfficeKind(filePath);
  if (kind === 'zip') {
    logger.info('[XLS] File is an Office Open XML zip under a .xls name; reading it as XLSX');
    return extractTextFromXlsx(filePath);
  }
  if (kind === 'text') {
    logger.info('[XLS] File is text (HTML table or CSV) under a .xls name; reading it as text');
    return readTextOrHtmlDisguisedAsOffice(filePath);
  }
  throw legacyFormatUnsupported(
    filePath,
    '.xls',
    'Save the workbook as .xlsx to have its contents analyzed.'
  );
}

async function extractTextFromPpt(/** @type {any} */ filePath) {
  await checkFileSize(filePath, filePath);
  const kind = await sniffLegacyOfficeKind(filePath);
  if (kind === 'zip') {
    logger.info('[PPT] File is an Office Open XML zip under a .ppt name; reading it as PPTX');
    return extractTextFromPptx(filePath);
  }
  if (kind === 'text') {
    logger.info('[PPT] File is text under a .ppt name; reading it as text');
    return readTextOrHtmlDisguisedAsOffice(filePath);
  }
  throw legacyFormatUnsupported(
    filePath,
    '.ppt',
    'Save the presentation as .pptx to have its contents analyzed.'
  );
}

/**
 * Chunk text for downstream analysis with optional overlap.
 * Keeps total output under a configurable limit to avoid LLM truncation.
 * @param {string} text - Normalized text to chunk
 * @param {Object} options
 * @param {number} [options.chunkSize=4000] - Target chunk size in characters
 * @param {number} [options.overlap=400] - Overlap between chunks in characters
 * @param {number} [options.maxTotalLength=16000] - Max combined length to return
 * @returns {{chunks: string[], combined: string}}
 */
function chunkTextForAnalysis(
  text,
  { chunkSize = 4000, overlap = 400, maxTotalLength = 16000 } = {}
) {
  if (!text || typeof text !== 'string') {
    return { chunks: [], combined: '' };
  }

  const safeChunkSize = Math.max(500, chunkSize);
  const safeOverlap = Math.min(Math.max(0, overlap), Math.floor(safeChunkSize / 2));

  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + safeChunkSize, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - safeOverlap;
  }

  // Combine chunks until reaching the maxTotalLength budget
  const combined = [];
  let remaining = Math.max(1000, maxTotalLength);
  for (const chunk of chunks) {
    if (remaining <= 0) break;
    const slice = chunk.slice(0, remaining);
    combined.push(slice);
    remaining -= slice.length;
  }

  return {
    chunks,
    combined: combined.join('\n\n---\n\n')
  };
}

// These wrappers ensure extraction operations don't block the pipeline forever

/**
 * Extract text from PDF with timeout protection. The timeout aborts the
 * underlying extraction (not just the caller's await) so a slow pdf.js run
 * cannot outlive its consumer and pin its buffer in `_pdfBufferCache`.
 * @param {string} filePath - Path to PDF file
 * @param {string} fileName - Name of file for error messages
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<string>} Extracted text
 */
async function extractTextFromPdfWithTimeout(filePath, fileName, options = {}) {
  return withAbortableTimeout(
    (abortController) =>
      extractTextFromPdf(filePath, fileName, { ...options, signal: abortController.signal }),
    EXTRACTION_TIMEOUTS.PDF,
    `PDF extraction: ${fileName || filePath}`,
    { signal: options.signal }
  );
}

/**
 * OCR PDF with timeout protection
 * @param {string} filePath - Path to PDF file
 * @returns {Promise<string>} OCR text
 */
async function ocrPdfWithTimeout(filePath, options = {}) {
  return withTimeout(
    ocrPdfIfNeeded(filePath, options),
    EXTRACTION_TIMEOUTS.OCR,
    `OCR: ${filePath}`
  );
}

/**
 * Extract text from DOCX with timeout protection; the timeout aborts the
 * fallback chain so no OCR keeps running after the caller has given up.
 * @param {string} filePath - Path to DOCX file
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<string>} Extracted text
 */
async function extractTextFromDocxWithTimeout(filePath, options = {}) {
  return withAbortableTimeout(
    (abortController) => extractTextFromDocx(filePath, { signal: abortController.signal }),
    EXTRACTION_TIMEOUTS.DOCX,
    `DOCX extraction: ${filePath}`,
    { signal: options.signal }
  );
}

/**
 * Extract text from XLSX with timeout protection
 * @param {string} filePath - Path to XLSX file
 * @returns {Promise<string>} Extracted text
 */
async function extractTextFromXlsxWithTimeout(filePath) {
  return withTimeout(
    extractTextFromXlsx(filePath),
    EXTRACTION_TIMEOUTS.XLSX,
    `XLSX extraction: ${filePath}`
  );
}

/**
 * Extract text from PPTX with timeout protection; the timeout aborts the
 * fallback chain so no OCR keeps running after the caller has given up.
 * @param {string} filePath - Path to PPTX file
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<string>} Extracted text
 */
async function extractTextFromPptxWithTimeout(filePath, options = {}) {
  return withAbortableTimeout(
    (abortController) => extractTextFromPptx(filePath, { signal: abortController.signal }),
    EXTRACTION_TIMEOUTS.PPTX,
    `PPTX extraction: ${filePath}`,
    { signal: options.signal }
  );
}

module.exports = {
  // These prevent extraction operations from hanging indefinitely
  extractTextFromPdf: extractTextFromPdfWithTimeout,
  ocrPdfIfNeeded: ocrPdfWithTimeout,
  extractTextFromDocx: extractTextFromDocxWithTimeout,
  extractTextFromXlsx: extractTextFromXlsxWithTimeout,
  extractTextFromPptx: extractTextFromPptxWithTimeout,
  // Also export original versions for cases where caller manages timeout
  extractTextFromPdfRaw: extractTextFromPdf,
  ocrPdfIfNeededRaw: ocrPdfIfNeeded,
  extractTextFromDocxRaw: extractTextFromDocx,
  extractTextFromXlsxRaw: extractTextFromXlsx,
  extractTextFromPptxRaw: extractTextFromPptx,
  // Other extractors (typically faster, less prone to hanging)
  extractTextFromDoc,
  extractTextFromXls,
  extractTextFromPpt,
  extractTextFromOdfZip,
  extractTextFromEpub,
  extractTextFromEml,
  extractTextFromMsg,
  extractTextFromKml,
  extractTextFromKmz,
  extractTextFromCsv,
  extractPlainTextFromXml,
  extractPlainTextFromRtf,
  extractPlainTextFromHtml,
  readTextFileWithEncoding,
  readTextFileHead,
  decodeTextBuffer,
  chunkTextForAnalysis,
  cleanWhitespace,
  // Export timeout constants for callers who need custom timeouts
  EXTRACTION_TIMEOUTS,
  // Exported so the document analysis orchestrator can short-circuit OCR
  // for encrypted PDFs (where rasterization can't help either).
  isEncryptedPdfError,
  assertZipUncompressedCap,
  MAX_ZIP_UNCOMPRESSED_TOTAL,
  shutdownPdfBufferCache,
  // Test-only observability for the extract -> OCR buffer hand-off.
  _pdfBufferCacheSizeForTests: () => _pdfBufferCache.size,
  PDF_MIN_TEXT_CHARS_PER_PAGE,
  formatXlsxCellValue,
  xlsxFormatKind,
  xlsxCellNumberFormat,
  readXlsxDate1904,
  isXlsxDateFormat
};
