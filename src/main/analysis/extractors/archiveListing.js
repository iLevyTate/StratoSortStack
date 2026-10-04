// @ts-check
/**
 * Archive listing extractor for tar, tar.gz and single-member gzip files.
 *
 * Produces a short, language-model-friendly description of an archive without
 * extracting it: the entry names (capped), an entry count and a one-line
 * summary. Reads are bounded by bytes so a multi-GB archive is never pulled
 * into memory, and malformed input yields `null` rather than an exception.
 * Real filesystem errors (ENOENT, EACCES, ...) propagate to the caller.
 *
 * @module analysis/extractors/archiveListing
 */

const fs = require('fs');
const tar = require('tar');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('ArchiveListing');

/** @typedef {'tar' | 'tgz' | 'gzip'} ArchiveFormat */

/**
 * @typedef {Object} ArchiveDescription
 * @property {ArchiveFormat} format Detected archive family.
 * @property {string} summary One short line a language model can use directly.
 * @property {string[]} entryNames Entry paths in archive order (capped at `maxEntries`).
 * @property {number | null} totalEntries Exact entry count, or `null` when unknown.
 * @property {boolean} truncated True when `entryNames` or the count is incomplete.
 */

/**
 * @typedef {Object} DescribeArchiveOptions
 * @property {number} [maxEntries] Cap on collected entry names (default 50).
 * @property {number} [maxBytes] Archives above this size are not read (default 200 MiB).
 * @property {number} [fullCountMaxBytes] Below this size the whole archive is scanned so
 *   `totalEntries` is exact even when names are capped; above it reading stops once
 *   `maxEntries` names are collected and unread bytes remain, and `totalEntries` is
 *   `null` (default 16 MiB).
 * @property {number} [maxDecompressionRatio] Inflated-to-compressed byte ratio at which
 *   tar aborts a gzip stream (default 1000, tar's own default). Bounds the CPU a gzip
 *   bomb can consume; the entries read so far are reported as a truncated listing.
 */

const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const DEFAULT_FULL_COUNT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_DECOMPRESSION_RATIO = 1000;
const READ_CHUNK_BYTES = 256 * 1024;
// RFC 1952 FEXTRA is at most 65535 bytes, so 128 KiB always covers the header.
const GZIP_HEADER_READ_BYTES = 128 * 1024;
const SNIFF_BYTES = 512;
const MAX_ENTRY_NAME_CHARS = 512;
const MAX_SUMMARY_CHARS = 20000;
// The tar parser emits synchronously; the timer only guards against a hang.
const PARSER_SETTLE_TIMEOUT_MS = 5000;

const GZIP_MAGIC = [0x1f, 0x8b];
const GZIP_CM_DEFLATE = 0x08;
const GZIP_FLG_FEXTRA = 0x04;
const GZIP_FLG_FNAME = 0x08;
const GZIP_FLG_RESERVED = 0xe0;
const GZIP_FIXED_HEADER_BYTES = 10;
const TAR_MAGIC = 'ustar';
const TAR_MAGIC_OFFSET = 257;
// tar surfaces its ratio guard as a TAR_ABORT error with this message.
const DECOMPRESSION_RATIO_ERROR = /max decompression ratio exceeded/i;

/** @type {Record<ArchiveFormat, string>} */
const FORMAT_LABELS = { tar: 'TAR', tgz: 'tar.gz', gzip: 'gzip' };

/**
 * Classify an archive by its file name alone.
 *
 * @param {string} fileName File name or path; matching is case-insensitive.
 * @returns {ArchiveFormat | null} `tar` for `.tar`, `tgz` for `.tgz`/`.tar.gz`,
 *   `gzip` for any other `.gz`, otherwise `null`.
 */
function classifyArchiveExtension(fileName) {
  if (typeof fileName !== 'string' || fileName.length === 0) return null;
  const segments = fileName.split(/[\\/]/);
  const base = (segments[segments.length - 1] || '').toLowerCase();
  if (hasExtension(base, '.tar')) return 'tar';
  if (hasExtension(base, '.tgz') || hasExtension(base, '.tar.gz')) return 'tgz';
  if (hasExtension(base, '.gz')) return 'gzip';
  return null;
}

/**
 * @param {string} base Lower-cased base name.
 * @param {string} ext Extension including the leading dot.
 */
function hasExtension(base, ext) {
  return base.length > ext.length && base.endsWith(ext);
}

/**
 * Read the original file name stored in a gzip member header (RFC 1952 FNAME).
 *
 * @param {string} filePath
 * @returns {Promise<string | null>} The Latin-1 name, or `null` when the file is
 *   not a gzip member or carries no FNAME field.
 */
async function readGzipOriginalName(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) {
    logger.debug('[ArchiveListing] Skipping non-regular file for gzip name');
    return null;
  }
  const head = await readHeadBytes(filePath, GZIP_HEADER_READ_BYTES);
  const header = parseGzipHeader(head);
  if (!header) {
    logger.debug('[ArchiveListing] Not a readable gzip header', { bytes: head.length });
    return null;
  }
  return header.name;
}

/**
 * Describe a tar, tar.gz or gzip file without extracting it.
 *
 * @param {string} filePath
 * @param {DescribeArchiveOptions} [options]
 * @returns {Promise<ArchiveDescription | null>} `null` for empty, corrupt or
 *   unrecognised input. Filesystem errors are not swallowed.
 */
async function describeArchive(filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  const opts = options || {};
  const entryLimit = toBoundedInt(opts.maxEntries, DEFAULT_MAX_ENTRIES, 1);
  const byteLimit = toBoundedInt(opts.maxBytes, DEFAULT_MAX_BYTES, 1);
  const fullCountLimit = toBoundedInt(opts.fullCountMaxBytes, DEFAULT_FULL_COUNT_MAX_BYTES, 0);
  const ratioLimit = toBoundedInt(opts.maxDecompressionRatio, DEFAULT_MAX_DECOMPRESSION_RATIO, 1);

  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) {
    logger.debug('[ArchiveListing] Skipping non-regular file');
    return null;
  }
  if (stat.size === 0) {
    logger.debug('[ArchiveListing] Skipping empty archive');
    return null;
  }

  let format = classifyArchiveExtension(filePath);
  if (!format) {
    format = await sniffArchiveFormat(filePath);
    if (!format) {
      logger.debug('[ArchiveListing] Unrecognised archive signature');
      return null;
    }
  }

  if (format === 'gzip') {
    return describeGzipMember(filePath);
  }

  if (stat.size > byteLimit) {
    logger.debug('[ArchiveListing] Archive exceeds listing size cap', {
      format,
      size: stat.size,
      maxBytes: byteLimit
    });
    return {
      format,
      summary: `${FORMAT_LABELS[format]} archive (too large for content listing)`,
      entryNames: [],
      totalEntries: null,
      truncated: true
    };
  }

  return listTarEntries(filePath, format, {
    entryLimit,
    byteLimit,
    fileSize: stat.size,
    countAll: stat.size <= fullCountLimit,
    ratioLimit
  });
}

/**
 * @param {string} filePath
 * @returns {Promise<ArchiveDescription | null>}
 */
async function describeGzipMember(filePath) {
  const head = await readHeadBytes(filePath, GZIP_HEADER_READ_BYTES);
  const header = parseGzipHeader(head);
  if (!header) {
    logger.debug('[ArchiveListing] Corrupt gzip header', { bytes: head.length });
    return null;
  }
  const name = header.name;
  return {
    format: 'gzip',
    summary: capText(name ? `gzip-compressed ${name}` : 'gzip archive'),
    entryNames: name ? [name] : [],
    totalEntries: 1,
    truncated: false
  };
}

/**
 * Stream a tar (optionally gzip-compressed) through the tar parser, collecting
 * entry names. Reading stops early once enough names are collected and unread
 * bytes remain, unless the archive is small enough that an exact count is cheap.
 *
 * @param {string} filePath
 * @param {'tar' | 'tgz'} format
 * @param {{
 *   entryLimit: number,
 *   byteLimit: number,
 *   fileSize: number,
 *   countAll: boolean,
 *   ratioLimit: number
 * }} limits
 * @returns {Promise<ArchiveDescription | null>}
 */
async function listTarEntries(filePath, format, limits) {
  const { entryLimit, byteLimit, fileSize, countAll, ratioLimit } = limits;
  /** @type {string[]} */
  const entryNames = [];
  let totalEntries = 0;
  let invalidEntries = 0;
  let badArchive = false;
  let stopped = false;
  let ratioExceeded = false;
  let settled = false;
  /** @type {Error | null} */
  let failure = null;

  const parser = new tar.Parser({
    strict: false,
    maxDecompressionRatio: ratioLimit,
    /** @param {import('tar').ReadEntry} entry */
    onReadEntry: (entry) => {
      totalEntries += 1;
      if (entryNames.length < entryLimit) {
        entryNames.push(formatEntryName(entry));
      }
      // Drain the body so the parser can advance; contents are discarded.
      entry.resume();
    },
    /** @param {string} code */
    onwarn: (code) => {
      if (code === 'TAR_BAD_ARCHIVE') badArchive = true;
      else if (code === 'TAR_ENTRY_INVALID') invalidEntries += 1;
    }
  });
  parser.on('error', (/** @type {unknown} */ err) => {
    settled = true;
    if (stopped || ratioExceeded || failure) return;
    const error = toError(err);
    if (DECOMPRESSION_RATIO_ERROR.test(error.message)) ratioExceeded = true;
    else failure = error;
  });
  parser.on('end', () => {
    settled = true;
  });

  const handle = await fs.promises.open(filePath, 'r');
  let bytesFed = 0;
  try {
    while (bytesFed < byteLimit && !failure && !ratioExceeded) {
      const want = Math.min(READ_CHUNK_BYTES, byteLimit - bytesFed);
      // Fresh buffer per chunk: the parser may retain a slice across writes.
      const chunk = Buffer.alloc(want);
      const { bytesRead } = await handle.read(chunk, 0, want, bytesFed);
      if (bytesRead === 0) break;
      bytesFed += bytesRead;
      try {
        parser.write(bytesRead === want ? chunk : chunk.subarray(0, bytesRead));
      } catch (err) {
        failure = toError(err);
        break;
      }
      // Stop early only while unread bytes remain: once the whole file has been
      // fed, finishing the parse is free and yields an exact count.
      if (!countAll && entryNames.length >= entryLimit && bytesFed < fileSize) {
        stopped = true;
        break;
      }
    }
  } finally {
    await handle.close();
  }

  if (stopped) {
    // Stops the parser; the resulting TAR_ABORT error is expected.
    safeAbort(parser);
  } else if (!failure && !ratioExceeded) {
    try {
      parser.end();
    } catch (err) {
      failure = toError(err);
    }
    await waitForParserSettle(parser, () => settled);
  }

  const damaged = failure !== null || badArchive || invalidEntries > 0;
  if (totalEntries === 0 && (damaged || ratioExceeded)) {
    logger.debug('[ArchiveListing] Corrupt archive, no readable entries', {
      format,
      bytesFed,
      invalidEntries,
      badArchive,
      ratioExceeded,
      error: failure ? failure.message : undefined
    });
    return null;
  }

  const label = FORMAT_LABELS[format];
  if (damaged) {
    logger.debug('[ArchiveListing] Archive damaged after readable entries', {
      format,
      totalEntries,
      invalidEntries,
      badArchive,
      error: failure ? failure.message : undefined
    });
    return {
      format,
      summary: capText(
        `${label} archive, damaged after ${pluralizeEntries(totalEntries)} (listing may be incomplete)`
      ),
      entryNames,
      totalEntries: null,
      truncated: true
    };
  }

  if (stopped || ratioExceeded) {
    if (ratioExceeded) {
      logger.debug('[ArchiveListing] Decompression ratio limit reached', {
        format,
        totalEntries,
        bytesFed,
        maxDecompressionRatio: ratioLimit
      });
    }
    return {
      format,
      summary: capText(
        `${label} archive with ${totalEntries}+ entries (first ${entryNames.length} listed)`
      ),
      entryNames,
      totalEntries: null,
      truncated: true
    };
  }

  const namesTruncated = entryNames.length < totalEntries;
  const summary = namesTruncated
    ? `${label} archive with ${pluralizeEntries(totalEntries)} (first ${entryNames.length} listed)`
    : `${label} archive with ${pluralizeEntries(totalEntries)}`;
  return {
    format,
    summary: capText(summary),
    entryNames,
    totalEntries,
    truncated: namesTruncated
  };
}

/**
 * Detect the archive family from leading bytes when the extension is unknown.
 *
 * @param {string} filePath
 * @returns {Promise<ArchiveFormat | null>}
 */
async function sniffArchiveFormat(filePath) {
  const head = await readHeadBytes(filePath, SNIFF_BYTES);
  if (head.length >= GZIP_MAGIC.length && head[0] === GZIP_MAGIC[0] && head[1] === GZIP_MAGIC[1]) {
    return 'gzip';
  }
  const magicEnd = TAR_MAGIC_OFFSET + TAR_MAGIC.length;
  if (
    head.length >= magicEnd &&
    head.toString('latin1', TAR_MAGIC_OFFSET, magicEnd) === TAR_MAGIC
  ) {
    return 'tar';
  }
  return null;
}

/**
 * Parse an RFC 1952 member header.
 *
 * @param {Buffer} buf Leading bytes of the file.
 * @returns {{ name: string | null } | null} `null` when the bytes are not a
 *   well-formed gzip header (or the header does not fit in `buf`).
 */
function parseGzipHeader(buf) {
  if (buf.length < GZIP_FIXED_HEADER_BYTES) return null;
  if (buf[0] !== GZIP_MAGIC[0] || buf[1] !== GZIP_MAGIC[1] || buf[2] !== GZIP_CM_DEFLATE) {
    return null;
  }
  const flg = buf[3];
  if ((flg & GZIP_FLG_RESERVED) !== 0) return null;
  let pos = GZIP_FIXED_HEADER_BYTES;
  if ((flg & GZIP_FLG_FEXTRA) !== 0) {
    if (pos + 2 > buf.length) return null;
    pos += 2 + buf.readUInt16LE(pos);
    if (pos > buf.length) return null;
  }
  if ((flg & GZIP_FLG_FNAME) === 0) return { name: null };
  const end = buf.indexOf(0, pos);
  if (end === -1) return null;
  const name = sanitizeName(buf.toString('latin1', pos, end));
  return { name: name.length > 0 ? name : null };
}

/**
 * Read at most `maxBytes` from the start of a file. Filesystem errors propagate.
 *
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readHeadBytes(filePath, maxBytes) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    let total = 0;
    while (total < maxBytes) {
      const { bytesRead } = await handle.read(buffer, total, maxBytes - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}

/**
 * Resolve once the parser has emitted `end` or `error`, or after a safety
 * timeout. The parser normally settles synchronously inside `end()`.
 *
 * @param {import('tar').Parser} parser
 * @param {() => boolean} isSettled
 * @returns {Promise<void>}
 */
function waitForParserSettle(parser, isSettled) {
  if (isSettled()) return Promise.resolve();
  return new Promise((resolve) => {
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    const finish = () => {
      if (timer) clearTimeout(timer);
      parser.removeListener('end', finish);
      parser.removeListener('error', finish);
      resolve();
    };
    timer = setTimeout(finish, PARSER_SETTLE_TIMEOUT_MS);
    parser.once('end', finish);
    parser.once('error', finish);
  });
}

/** @param {import('tar').Parser} parser */
function safeAbort(parser) {
  try {
    parser.abort(new Error('archive listing stopped at entry cap'));
  } catch {
    // The abort error is surfaced via the 'error' listener; nothing else to do.
  }
}

/** @param {import('tar').ReadEntry} entry */
function formatEntryName(entry) {
  let name = sanitizeName(typeof entry.path === 'string' ? entry.path : '');
  if (entry.type === 'Directory' && name.length > 0 && !name.endsWith('/')) {
    name += '/';
  }
  return name.length > 0 ? name : '(unnamed entry)';
}

/**
 * Strip control characters and cap the length of an untrusted name.
 * @param {string} raw
 */
function sanitizeName(raw) {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return cleaned.length > MAX_ENTRY_NAME_CHARS
    ? `${cleaned.slice(0, MAX_ENTRY_NAME_CHARS - 1)}…`
    : cleaned;
}

/** @param {number} count */
function pluralizeEntries(count) {
  return count === 1 ? '1 entry' : `${count} entries`;
}

/** @param {string} text */
function capText(text) {
  return text.length > MAX_SUMMARY_CHARS ? text.slice(0, MAX_SUMMARY_CHARS) : text;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min Smallest accepted value.
 */
function toBoundedInt(value, fallback, min) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/** @param {unknown} err */
function toError(err) {
  return err instanceof Error ? err : new Error(String(err));
}

module.exports = {
  describeArchive,
  readGzipOriginalName,
  classifyArchiveExtension
};
