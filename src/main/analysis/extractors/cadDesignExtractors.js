// @ts-check
/**
 * CAD, 3D-print and design-document readers: STL, OBJ, 3MF, G-code, EPS and
 * Adobe Illustrator.
 *
 * Every reader takes a path and resolves to short labelled lines that a
 * language model can summarise, or '' when the file holds nothing useful.
 * Malformed or empty content never throws (it is logged at debug level and a
 * placeholder or '' comes back); real filesystem errors such as ENOENT and
 * EACCES propagate so callers can tell "cannot open" from "nothing inside".
 * Reads are byte-capped so a multi-gigabyte mesh is never pulled into memory
 * whole, and the returned text is capped at 20,000 characters.
 */
const fs = require('fs').promises;

const { createLogger } = require('../../../shared/logger');

const logger = createLogger('CadDesignExtractors');

const MAX_OUTPUT_CHARS = 20000;
const MAX_COMMENT_CHARS = 200;

const STL_SNIFF_BYTES = 4096;
const STL_ASCII_SIGNATURE_BYTES = 80;
const STL_ASCII_MAX_BYTES = 32 * 1024 * 1024;
const STL_BINARY_HEADER_BYTES = 80;
const STL_BINARY_MIN_BYTES = 84;
const STL_BINARY_TRIANGLE_BYTES = 50;
const STL_BINARY_MAX_SCANNED_TRIANGLES = 2_000_000;
const STL_BINARY_TRIANGLES_PER_CHUNK = 20_000; // 1,000,000 bytes per read
const STL_ASCII_NAME_WINDOW_CHARS = 512;

const OBJ_HEAD_BYTES = 512 * 1024;
const OBJ_TAIL_BYTES = 64 * 1024;
const OBJ_MAX_COMMENTS = 20;
const OBJ_MAX_NAMES = 50;

const THREE_MF_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const THREE_MF_MAX_MODEL_BYTES = 128 * 1024 * 1024;
const THREE_MF_MAX_MODEL_CHARS = 64 * 1024 * 1024;
const THREE_MF_MAX_CONTENT_TYPES_BYTES = 1024 * 1024;
const THREE_MF_MAX_NAMES = 50;
const THREE_MF_MAX_METADATA = 50;
const THREE_MF_MAX_LISTED_PARTS = 20;
const THREE_MF_NO_MODEL = '3MF file (no model part found)';

const GCODE_HEAD_BYTES = 256 * 1024;
const GCODE_TAIL_BYTES = 256 * 1024;
const GCODE_MAX_COMMENTS = 200;
const GCODE_MAX_BANNER_LINES = 5;

const EPS_MAX_BYTES = 1024 * 1024;
const EPS_MAX_SHOW_CHARS = 2000;
const EPS_MAX_STRING_CHARS = 4000;
const EPS_SCAN_BUDGET_CHARS = 50 * 1024 * 1024;
const EPS_MAX_FIELD_CHARS = 300;
const EPS_OPERATOR_LOOKAHEAD_CHARS = 512;
const DOS_EPS_MAGIC = [0xc5, 0xd0, 0xd3, 0xc6];

const PDF_SNIFF_BYTES = 1024;

const UNREADABLE_STL = 'STL file (unreadable structure)';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Node and memfs filesystem errors carry an uppercase errno code (ENOENT,
 * EACCES, EISDIR...). Parser failures never do, so this separates "cannot
 * open the file" (propagate) from "cannot make sense of the bytes" (report).
 * @param {unknown} error
 * @returns {boolean}
 */
function isFilesystemError(error) {
  if (!error || typeof error !== 'object') return false;
  const code = /** @type {{ code?: unknown }} */ (error).code;
  return typeof code === 'string' && /^E[A-Z0-9]+$/.test(code);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Size of a regular file. A directory is "cannot open", not "nothing inside",
 * so it fails with the EISDIR a read() on it would raise; memfs reports
 * directories as 0 bytes, which would otherwise look like an empty file.
 * @param {string} filePath
 * @returns {Promise<number>}
 */
async function statFileSize(filePath) {
  const stats = await fs.stat(filePath);
  if (stats.isDirectory()) {
    throw Object.assign(new Error('EISDIR: illegal operation on a directory, read'), {
      code: 'EISDIR',
      errno: -21,
      syscall: 'read',
      path: filePath
    });
  }
  return stats.size;
}

/**
 * Read exactly `length` bytes at `position`, or fewer when the file ends first.
 * @param {import('fs').promises.FileHandle} handle
 * @param {number} position
 * @param {number} length
 * @returns {Promise<Buffer>}
 */
async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled === length ? buffer : buffer.subarray(0, filled);
}

/**
 * Read the first `maxBytes` of a file.
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {Promise<{ buffer: Buffer, size: number, fullyRead: boolean }>}
 */
async function readPrefix(filePath, maxBytes) {
  const size = await statFileSize(filePath);
  const length = Math.min(size, maxBytes);
  if (length === 0) return { buffer: Buffer.alloc(0), size, fullyRead: true };
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = await readAt(handle, 0, length);
    return { buffer, size, fullyRead: size <= maxBytes };
  } finally {
    await handle.close();
  }
}

/**
 * Read the first `headBytes` and last `tailBytes` of a file. Small files come
 * back whole in `head` with `tail` null and `fullyRead` true.
 * @param {string} filePath
 * @param {number} headBytes
 * @param {number} tailBytes
 * @returns {Promise<{ head: Buffer, tail: Buffer | null, size: number, fullyRead: boolean }>}
 */
async function readHeadAndTail(filePath, headBytes, tailBytes) {
  const size = await statFileSize(filePath);
  if (size === 0) return { head: Buffer.alloc(0), tail: null, size, fullyRead: true };
  const handle = await fs.open(filePath, 'r');
  try {
    if (size <= headBytes + tailBytes) {
      const head = await readAt(handle, 0, size);
      return { head, tail: null, size, fullyRead: true };
    }
    const head = await readAt(handle, 0, headBytes);
    const tail = await readAt(handle, size - tailBytes, tailBytes);
    return { head, tail, size, fullyRead: false };
  } finally {
    await handle.close();
  }
}

/**
 * Split text into lines, dropping the partial line at either edge of a
 * buffer that was cut out of the middle of a file.
 * @param {string} text
 * @param {{ dropFirst?: boolean, dropLast?: boolean }} [options]
 * @returns {string[]}
 */
function splitLines(text, options = {}) {
  const lines = text.split(/\r\n|\r|\n/);
  if (options.dropFirst && lines.length > 0) lines.shift();
  if (options.dropLast && lines.length > 0) lines.pop();
  return lines;
}

/**
 * Join non-empty lines and apply the output cap.
 * @param {string[]} lines
 * @returns {string}
 */
function finishOutput(lines) {
  const text = lines.filter((line) => line && line.trim()).join('\n');
  return text.length > MAX_OUTPUT_CHARS ? text.slice(0, MAX_OUTPUT_CHARS) : text;
}

/**
 * Thousands-separated integer, independent of the process locale.
 * @param {number} value
 * @returns {string}
 */
function formatInt(value) {
  return Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * "1 facet" / "12,345 facets".
 * @param {number} count
 * @param {string} noun singular form
 * @returns {string}
 */
function plural(count, noun) {
  return `${formatInt(count)} ${count === 1 ? noun : `${noun}s`}`;
}

/**
 * One decimal place, falling back to three when a non-zero length would
 * otherwise round to 0.0 (sub-millimetre parts).
 * @param {number} value
 * @returns {string}
 */
function formatLength(value) {
  const rounded = value.toFixed(1);
  return rounded === '0.0' && value !== 0 ? value.toFixed(3) : rounded;
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatMegabytes(bytes) {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Collapse a fragment to a single trimmed line of printable text.
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function cleanInline(text, maxChars) {
  const cleaned = text
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is being removed
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f�]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}...` : cleaned;
}

/**
 * Printable ASCII run of a fixed-width binary header.
 * @param {Buffer} buffer
 * @returns {string}
 */
function printableHeaderText(buffer) {
  return cleanInline(buffer.toString('latin1').replace(/[^\x20-\x7e]/g, ' '), 200);
}

/**
 * Count the matches of a global regex without building a result array.
 * @param {string} text
 * @param {RegExp} pattern global regex
 * @returns {number}
 */
function countMatches(text, pattern) {
  let count = 0;
  pattern.lastIndex = 0;
  while (pattern.exec(text) !== null) count += 1;
  return count;
}

/**
 * @param {string} text
 * @returns {string}
 */
function decodeXmlEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    const lower = String(entity).toLowerCase();
    if (lower.startsWith('#')) {
      const codePoint = lower.startsWith('#x')
        ? parseInt(lower.slice(2), 16)
        : parseInt(lower.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    /** @type {Record<string, string>} */
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    return named[lower] || match;
  });
}

/**
 * Value of `name="..."` or `name='...'` inside an element's attribute text.
 * @param {string} attributes
 * @param {string} name
 * @returns {string} decoded and collapsed, '' when absent
 */
function readXmlAttribute(attributes, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"<>]*)"|'([^'<>]*)')`, 'i').exec(
    attributes
  );
  if (!match) return '';
  return decodeXmlEntities(match[1] !== undefined ? match[1] : match[2]);
}

/**
 * @typedef {{ minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, vertices: number }} Bounds
 */

/** @returns {Bounds} */
function createBounds() {
  return {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
    vertices: 0
  };
}

/**
 * @param {Bounds} bounds
 * @param {number} x
 * @param {number} y
 * @param {number} z
 */
function extendBounds(bounds, x, y, z) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
  if (x < bounds.minX) bounds.minX = x;
  if (x > bounds.maxX) bounds.maxX = x;
  if (y < bounds.minY) bounds.minY = y;
  if (y > bounds.maxY) bounds.maxY = y;
  if (z < bounds.minZ) bounds.minZ = z;
  if (z > bounds.maxZ) bounds.maxZ = z;
  bounds.vertices += 1;
}

/**
 * @param {Bounds} bounds
 * @param {string} [note] appended when the box covers only part of the mesh
 * @returns {string} '' when no finite vertex was seen
 */
function describeBounds(bounds, note = '') {
  if (bounds.vertices === 0) return '';
  const dims = [
    bounds.maxX - bounds.minX,
    bounds.maxY - bounds.minY,
    bounds.maxZ - bounds.minZ
  ].map(formatLength);
  return `Bounding box ${dims.join(' x ')} units${note ? ` ${note}` : ''}`;
}

// ---------------------------------------------------------------------------
// STL
// ---------------------------------------------------------------------------

/**
 * ASCII STL: "solid <name>" then "facet normal" / "vertex x y z" blocks.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function describeAsciiStl(filePath) {
  const { buffer, fullyRead } = await readPrefix(filePath, STL_ASCII_MAX_BYTES);
  const text = buffer.toString('latin1');

  // "solid" may follow a BOM or stray bytes; it was found inside the first
  // 80 bytes by the caller, so look for it there rather than at offset 0.
  const solidIndex = text.slice(0, STL_ASCII_SIGNATURE_BYTES).search(/\bsolid\b/i);
  const nameMatch =
    solidIndex >= 0
      ? /^solid\b[ \t]*([^\r\n]*)/i.exec(
          text.slice(solidIndex, solidIndex + STL_ASCII_NAME_WINDOW_CHARS)
        )
      : null;
  const name = nameMatch ? cleanInline(nameMatch[1], 120) : '';

  const facets = countMatches(text, /\bfacet\s+normal\b/gi);

  const bounds = createBounds();
  const vertexPattern = /\bvertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/gi;
  let match;
  while ((match = vertexPattern.exec(text)) !== null) {
    extendBounds(bounds, parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3]));
  }

  const lines = [
    name ? `STL 3D model "${name}"` : 'STL 3D model',
    `ASCII STL with ${fullyRead ? '' : 'at least '}${plural(facets, 'facet')}`,
    describeBounds(bounds, fullyRead ? '' : `(first ${formatMegabytes(STL_ASCII_MAX_BYTES)} only)`)
  ];
  if (!fullyRead) {
    lines.push(`Only the first ${formatMegabytes(STL_ASCII_MAX_BYTES)} of the file were scanned`);
  }
  return finishOutput(lines);
}

/**
 * Scan up to `triangleCount` binary triangles in 1 MB chunks and return the
 * bounding box of their vertices.
 * @param {string} filePath
 * @param {number} triangleCount
 * @returns {Promise<Bounds>}
 */
async function scanBinaryStlBounds(filePath, triangleCount) {
  const bounds = createBounds();
  if (triangleCount <= 0) return bounds;
  const handle = await fs.open(filePath, 'r');
  try {
    let position = STL_BINARY_MIN_BYTES;
    let remaining = triangleCount;
    while (remaining > 0) {
      const wanted = Math.min(remaining, STL_BINARY_TRIANGLES_PER_CHUNK);
      const chunk = await readAt(handle, position, wanted * STL_BINARY_TRIANGLE_BYTES);
      const complete = Math.floor(chunk.length / STL_BINARY_TRIANGLE_BYTES);
      for (let i = 0; i < complete; i += 1) {
        // 12-byte normal, three 12-byte vertices, 2-byte attribute count.
        let offset = i * STL_BINARY_TRIANGLE_BYTES + 12;
        for (let v = 0; v < 3; v += 1) {
          extendBounds(
            bounds,
            chunk.readFloatLE(offset),
            chunk.readFloatLE(offset + 4),
            chunk.readFloatLE(offset + 8)
          );
          offset += 12;
        }
      }
      if (complete < wanted) break; // file ended early
      remaining -= wanted;
      position += wanted * STL_BINARY_TRIANGLE_BYTES;
    }
  } finally {
    await handle.close();
  }
  return bounds;
}

/**
 * Binary STL: 80-byte header, uint32 LE triangle count, 50-byte triangles.
 * @param {string} filePath
 * @param {Buffer} sniff first bytes of the file (at least 84 when size allows)
 * @param {number} size file size in bytes
 * @returns {Promise<string>}
 */
async function describeBinaryStl(filePath, sniff, size) {
  if (size < STL_BINARY_MIN_BYTES || sniff.length < STL_BINARY_MIN_BYTES) return UNREADABLE_STL;
  const triangleCount = sniff.readUInt32LE(STL_BINARY_HEADER_BYTES);
  const expectedSize = STL_BINARY_MIN_BYTES + triangleCount * STL_BINARY_TRIANGLE_BYTES;
  if (Math.abs(size - expectedSize) > STL_BINARY_TRIANGLE_BYTES) {
    logger.debug('[STL] Binary triangle count does not match file size', {
      triangleCount,
      expectedSize,
      size
    });
    return UNREADABLE_STL;
  }

  const header = printableHeaderText(sniff.subarray(0, STL_BINARY_HEADER_BYTES));
  const headerName = /^solid\s+(\S.*)$/i.exec(header);
  const name = headerName ? cleanInline(headerName[1], 120) : '';

  const scanned = Math.min(triangleCount, STL_BINARY_MAX_SCANNED_TRIANGLES);
  const bounds = await scanBinaryStlBounds(filePath, scanned);

  return finishOutput([
    name ? `STL 3D model "${name}"` : 'STL 3D model',
    `Binary STL with ${plural(triangleCount, 'triangle')}`,
    describeBounds(
      bounds,
      scanned < triangleCount ? `(first ${formatInt(scanned)} triangles only)` : ''
    ),
    header ? `Header: ${header}` : ''
  ]);
}

/**
 * Describe an STL mesh (ASCII or binary).
 * @param {string} filePath
 * @returns {Promise<string>} '' for an empty file, a placeholder for a broken one
 */
async function extractTextFromStl(filePath) {
  const sniff = await readPrefix(filePath, STL_SNIFF_BYTES);
  if (sniff.size === 0) return '';
  try {
    const sniffText = sniff.buffer.toString('latin1');
    // Some binary exporters write "solid ..." into the 80-byte header, so the
    // ASCII verdict also needs the word "facet" early in the file.
    const isAscii =
      /solid/i.test(sniffText.slice(0, STL_ASCII_SIGNATURE_BYTES)) && /\bfacet\b/i.test(sniffText);
    return isAscii
      ? await describeAsciiStl(filePath)
      : await describeBinaryStl(filePath, sniff.buffer, sniff.size);
  } catch (error) {
    if (isFilesystemError(error)) throw error;
    logger.debug('[STL] Unreadable structure', { error: describeError(error) });
    return UNREADABLE_STL;
  }
}

// ---------------------------------------------------------------------------
// OBJ
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   comments: string[],
 *   objects: Set<string>,
 *   groups: Set<string>,
 *   materialLibraries: Set<string>,
 *   materials: Set<string>,
 *   vertices: number,
 *   faces: number
 * }} ObjSummary
 */

/**
 * @param {Set<string>} set
 * @param {string} value
 */
function addName(set, value) {
  const cleaned = cleanInline(value, 120);
  if (cleaned && set.size < OBJ_MAX_NAMES) set.add(cleaned);
}

/**
 * Walk OBJ lines collecting names; counts and leading comments only when
 * `countGeometry` is set (the head of the file).
 * @param {string[]} lines
 * @param {ObjSummary} summary
 * @param {boolean} countGeometry
 */
function scanObjLines(lines, summary, countGeometry) {
  let inLeadingComments = countGeometry;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (inLeadingComments && summary.comments.length < OBJ_MAX_COMMENTS) {
        const comment = cleanInline(line.slice(1), MAX_COMMENT_CHARS);
        if (comment) summary.comments.push(comment);
      }
      continue;
    }
    inLeadingComments = false;
    const keyword = /^(\S+)\s*(.*)$/.exec(line);
    if (!keyword) continue;
    const [, key, rest] = keyword;
    switch (key) {
      case 'v':
        if (countGeometry) summary.vertices += 1;
        break;
      case 'f':
        if (countGeometry) summary.faces += 1;
        break;
      case 'o':
        addName(summary.objects, rest);
        break;
      case 'g':
        addName(summary.groups, rest);
        break;
      case 'mtllib':
        addName(summary.materialLibraries, rest);
        break;
      case 'usemtl':
        addName(summary.materials, rest);
        break;
      default:
        break;
    }
  }
}

/**
 * Describe a Wavefront OBJ mesh from its first 512 KB and last 64 KB.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function extractTextFromObj(filePath) {
  const { head, tail, fullyRead } = await readHeadAndTail(filePath, OBJ_HEAD_BYTES, OBJ_TAIL_BYTES);
  try {
    /** @type {ObjSummary} */
    const summary = {
      comments: [],
      objects: new Set(),
      groups: new Set(),
      materialLibraries: new Set(),
      materials: new Set(),
      vertices: 0,
      faces: 0
    };
    scanObjLines(splitLines(head.toString('utf8'), { dropLast: !fullyRead }), summary, true);
    if (tail) {
      scanObjLines(splitLines(tail.toString('utf8'), { dropFirst: true }), summary, false);
    }

    const hasContent =
      summary.vertices > 0 ||
      summary.faces > 0 ||
      summary.objects.size > 0 ||
      summary.groups.size > 0 ||
      summary.materialLibraries.size > 0 ||
      summary.materials.size > 0 ||
      summary.comments.length > 0;
    if (!hasContent) return '';

    const approx = fullyRead ? '' : 'at least ';
    const lines = ['OBJ 3D model'];
    if (summary.objects.size) lines.push(`Objects: ${[...summary.objects].join(', ')}`);
    if (summary.groups.size) lines.push(`Groups: ${[...summary.groups].join(', ')}`);
    if (summary.materialLibraries.size) {
      lines.push(`Material libraries: ${[...summary.materialLibraries].join(', ')}`);
    }
    if (summary.materials.size) lines.push(`Materials: ${[...summary.materials].join(', ')}`);
    for (const comment of summary.comments) lines.push(`Comment: ${comment}`);
    lines.push(`Vertices: ${approx}${formatInt(summary.vertices)}`);
    lines.push(`Faces: ${approx}${formatInt(summary.faces)}`);
    if (!fullyRead) {
      lines.push(
        `Counts cover the first ${OBJ_HEAD_BYTES / 1024} KB of the file; names also come from the last ${OBJ_TAIL_BYTES / 1024} KB`
      );
    }
    return finishOutput(lines);
  } catch (error) {
    if (isFilesystemError(error)) throw error;
    logger.debug('[OBJ] Could not parse', { error: describeError(error) });
    return '';
  }
}

// ---------------------------------------------------------------------------
// 3MF
// ---------------------------------------------------------------------------

/**
 * @param {string} xml
 * @returns {{ unit: string, title: string, metadata: Array<[string, string]>, objectCount: number, objectNames: string[], componentCount: number, vertexCount: number, triangleCount: number }}
 */
function parse3mfModel(xml) {
  // Every pattern here stops at the next "<" or ">" instead of scanning to the
  // end of the part, so a model with thousands of unterminated tags costs
  // O(n) rather than O(n * tags). A trailing "/" is excluded from the
  // attribute run so a self-closing <metadata name="x"/> cannot swallow the
  // next element's text; <model .../> and <object .../> accept it explicitly.
  const attributeRun = '((?:[^<>/]|/(?!>))*)';
  const modelTag = new RegExp(`<(?:[\\w.-]+:)?model\\b${attributeRun}/?>`, 'i').exec(xml);
  const unit = modelTag ? cleanInline(readXmlAttribute(modelTag[1], 'unit'), 40) : '';

  /** @type {Array<[string, string]>} */
  const metadata = [];
  let title = '';
  const metadataPattern = new RegExp(
    `<(?:[\\w.-]+:)?metadata\\b${attributeRun}>([^<]*)</(?:[\\w.-]+:)?metadata>`,
    'gi'
  );
  let match;
  while (metadata.length < THREE_MF_MAX_METADATA && (match = metadataPattern.exec(xml)) !== null) {
    const name = cleanInline(readXmlAttribute(match[1], 'name'), 80);
    const value = cleanInline(decodeXmlEntities(match[2]), EPS_MAX_FIELD_CHARS);
    if (!name || !value) continue;
    if (!title && name.toLowerCase() === 'title') title = value;
    metadata.push([name, value]);
  }

  /** @type {string[]} */
  const objectNames = [];
  let objectCount = 0;
  const objectPattern = new RegExp(`<(?:[\\w.-]+:)?object\\b${attributeRun}/?>`, 'gi');
  while ((match = objectPattern.exec(xml)) !== null) {
    objectCount += 1;
    if (objectNames.length >= THREE_MF_MAX_NAMES) continue;
    const name = cleanInline(readXmlAttribute(match[1], 'name'), 120);
    if (name && !objectNames.includes(name)) objectNames.push(name);
  }

  return {
    unit,
    title,
    metadata,
    objectCount,
    objectNames,
    componentCount: countMatches(xml, /<(?:[\w.-]+:)?component\b/gi),
    vertexCount: countMatches(xml, /<(?:[\w.-]+:)?vertex\b/gi),
    triangleCount: countMatches(xml, /<(?:[\w.-]+:)?triangle\b/gi)
  };
}

/**
 * Describe a 3MF package: metadata, object names and counts from the model
 * part, with the content-types part only confirming the container.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function extractTextFrom3mf(filePath) {
  const size = await statFileSize(filePath);
  if (size === 0) return '';
  if (size > THREE_MF_MAX_ARCHIVE_BYTES) {
    logger.debug('[3MF] Archive exceeds inspection cap', { size });
    return finishOutput([
      '3MF 3D model',
      `Archive too large to inspect (${formatMegabytes(size)}, cap ${formatMegabytes(THREE_MF_MAX_ARCHIVE_BYTES)})`
    ]);
  }
  const archive = await fs.readFile(filePath);

  try {
    const AdmZip = require('adm-zip');
    /** @type {any[]} */
    let entries;
    try {
      const zip = new AdmZip(archive);
      entries = zip.getEntries().filter((/** @type {any} */ entry) => !entry.isDirectory);
    } catch (zipError) {
      logger.debug('[3MF] Not a readable zip container', { error: describeError(zipError) });
      return THREE_MF_NO_MODEL;
    }

    const lowerName = (/** @type {any} */ entry) => String(entry.entryName || '').toLowerCase();
    const modelEntry =
      entries.find((entry) => lowerName(entry) === '3d/3dmodel.model') ||
      entries.find((entry) => lowerName(entry).endsWith('.model'));
    if (!modelEntry) {
      logger.debug('[3MF] No model part in archive', { entries: entries.length });
      return THREE_MF_NO_MODEL;
    }

    const lines = [];
    const declaredSize = Number(modelEntry.header && modelEntry.header.size) || 0;
    if (declaredSize > THREE_MF_MAX_MODEL_BYTES) {
      lines.push('3MF 3D model');
      lines.push(`Model part too large to inspect (${formatMegabytes(declaredSize)})`);
    } else {
      let xml = modelEntry.getData().toString('utf8');
      const truncated = xml.length > THREE_MF_MAX_MODEL_CHARS;
      if (truncated) xml = xml.slice(0, THREE_MF_MAX_MODEL_CHARS);
      const model = parse3mfModel(xml);
      const approx = truncated ? 'at least ' : '';

      lines.push(model.title ? `3MF 3D model "${model.title}"` : '3MF 3D model');
      if (model.unit) lines.push(`Unit: ${model.unit}`);
      lines.push(`Objects: ${approx}${formatInt(model.objectCount)}`);
      if (model.objectNames.length) lines.push(`Object names: ${model.objectNames.join(', ')}`);
      if (model.componentCount)
        lines.push(`Components: ${approx}${formatInt(model.componentCount)}`);
      if (model.vertexCount || model.triangleCount) {
        lines.push(
          `Mesh: ${approx}${formatInt(model.vertexCount)} vertices, ${approx}${formatInt(model.triangleCount)} triangles`
        );
      }
      for (const [name, value] of model.metadata) {
        if (name.toLowerCase() === 'title' && value === model.title) continue;
        lines.push(`${name}: ${value}`);
      }
      if (truncated) lines.push('Model part was only partially scanned');
    }

    const contentTypes = entries.find((entry) => lowerName(entry) === '[content_types].xml');
    if (contentTypes) {
      const declared = Number(contentTypes.header && contentTypes.header.size) || 0;
      if (declared <= THREE_MF_MAX_CONTENT_TYPES_BYTES) {
        const text = contentTypes.getData().toString('utf8');
        lines.push(
          /3dmanufacturing|3dmodel/i.test(text)
            ? 'Container: OPC package declaring the 3D manufacturing model content type'
            : 'Container: OPC package'
        );
      }
    }

    const parts = entries
      .slice(0, THREE_MF_MAX_LISTED_PARTS)
      .map((entry) => cleanInline(String(entry.entryName || ''), 120));
    if (parts.length) {
      const more = entries.length > parts.length ? ` (+${entries.length - parts.length} more)` : '';
      lines.push(`Package parts: ${parts.join(', ')}${more}`);
    }
    return finishOutput(lines);
  } catch (error) {
    if (isFilesystemError(error)) throw error;
    logger.debug('[3MF] Could not parse model part', { error: describeError(error) });
    return THREE_MF_NO_MODEL;
  }
}

// ---------------------------------------------------------------------------
// G-code
// ---------------------------------------------------------------------------

const GCODE_BANNER_PATTERN =
  /generated (?:by|with)|\bflavor\b|slicer|\bcura\b|prusa|bambu|simplify3d|slic3r|orcaslicer|ideamaker|kisslicer/i;

// Per-layer and per-segment markers repeat with changing values and would
// otherwise fill the comment budget.
const GCODE_NOISE_PATTERN =
  /^(?:LAYER|Z|HEIGHT|TYPE|MESH|WIDTH|TIME_ELAPSED|FEATURE|LINE_WIDTH|Z_HEIGHT|OBJECT_ID|layer num\/total_layer_count)\s*:|^layer \d+,|^(?:LAYER_CHANGE|WIPE_START|WIPE_END|AFTER_LAYER_CHANGE|BEFORE_LAYER_CHANGE|CHANGE_LAYER|VT\d+|CP TOOLCHANGE.*|(?:stop )?printing object\b.*)$/i;

const GCODE_SETTING_PATTERN = /^([A-Za-z_][A-Za-z0-9_ .\-/()#%[\]]{0,60}?)\s*[=:]\s*(\S.*)$/;

const GCODE_PRIORITY_PATTERN =
  /filament|layer.?height|estimated|print(?:ing)?.?time|\btime\b|nozzle|temp(?:erature)?\b|material|printer|\bbed\b|infill|total/i;

const GCODE_BASE64_PATTERN = /^[A-Za-z0-9+/]{40,}={0,2}$/;

/**
 * @param {string} line
 * @returns {string | null} comment body, or null for a non-comment line
 */
function gcodeCommentBody(line) {
  if (line.startsWith(';')) return line.slice(1).trim();
  // CNC posts (Fusion 360, Mastercam) wrap comments in parentheses.
  if (line.startsWith('(') && line.endsWith(')')) return line.slice(1, -1).trim();
  return null;
}

/**
 * Describe a G-code file from its slicer comments: banner first, then
 * print settings, then everything else.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function extractTextFromGcode(filePath) {
  const { head, tail, fullyRead } = await readHeadAndTail(
    filePath,
    GCODE_HEAD_BYTES,
    GCODE_TAIL_BYTES
  );
  try {
    const lines = splitLines(head.toString('utf8'), { dropLast: !fullyRead });
    if (tail) lines.push(...splitLines(tail.toString('utf8'), { dropFirst: true }));

    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {string[]} */
    const banner = [];
    /** @type {string[]} */
    const prioritySettings = [];
    /** @type {string[]} */
    const otherSettings = [];
    /** @type {string[]} */
    const remarks = [];
    let commandCount = 0;
    let inThumbnail = false;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const body = gcodeCommentBody(line);
      if (body === null) {
        if (/^[GMT]\d/i.test(line)) commandCount += 1;
        continue;
      }
      if (/^thumbnail(?:_\w+)? begin\b/i.test(body)) {
        inThumbnail = true;
        continue;
      }
      if (/^thumbnail(?:_\w+)? end\b/i.test(body)) {
        inThumbnail = false;
        continue;
      }
      if (inThumbnail || !body || !/[A-Za-z0-9]/.test(body)) continue;
      if (GCODE_BASE64_PATTERN.test(body) || GCODE_NOISE_PATTERN.test(body)) continue;
      if (seen.size >= GCODE_MAX_COMMENTS) break;
      const comment = cleanInline(body, MAX_COMMENT_CHARS);
      if (!comment || seen.has(comment)) continue;
      seen.add(comment);

      if (banner.length < GCODE_MAX_BANNER_LINES && GCODE_BANNER_PATTERN.test(comment)) {
        banner.push(comment);
      } else if (GCODE_SETTING_PATTERN.test(comment)) {
        (GCODE_PRIORITY_PATTERN.test(comment) ? prioritySettings : otherSettings).push(comment);
      } else {
        remarks.push(comment);
      }
    }

    if (seen.size === 0) {
      return commandCount > 0
        ? finishOutput([
            'G-code toolpath file',
            'No comments or slicer metadata in the sampled bytes'
          ])
        : '';
    }

    const output = ['G-code toolpath file'];
    for (const line of banner) output.push(`Slicer: ${line}`);
    if (prioritySettings.length || otherSettings.length) {
      output.push('Print settings:');
      output.push(...prioritySettings, ...otherSettings);
    }
    if (remarks.length) {
      output.push('Other comments:');
      output.push(...remarks);
    }
    if (!fullyRead) {
      output.push(
        `Comments come from the first ${GCODE_HEAD_BYTES / 1024} KB and last ${GCODE_TAIL_BYTES / 1024} KB of the file`
      );
    }
    return finishOutput(output);
  } catch (error) {
    if (isFilesystemError(error)) throw error;
    logger.debug('[GCODE] Could not parse', { error: describeError(error) });
    return '';
  }
}

// ---------------------------------------------------------------------------
// EPS / PostScript
// ---------------------------------------------------------------------------

/** @type {Array<[string, string]>} DSC keyword -> output label */
const DSC_FIELDS = [
  ['Title', 'Title'],
  ['Creator', 'Creator'],
  ['CreationDate', 'Created'],
  ['For', 'For'],
  ['BoundingBox', 'Bounding box'],
  ['DocumentFonts', 'Fonts'],
  ['LanguageLevel', 'Language level'],
  ['Pages', 'Pages']
];

const SHOW_OPERATORS = new Set([
  'show',
  'ashow',
  'widthshow',
  'awidthshow',
  'kshow',
  'xshow',
  'yshow',
  'xyshow',
  // Illustrator's native text operators (pre-PDF .ai / AI EPS). "Tj" is PDF
  // syntax and deliberately ignored.
  'Tx',
  'TX'
]);

/**
 * Read the PostScript portion of an EPS file: the whole prefix for a plain
 * file, or the section the DOS EPS binary header points at.
 * @param {string} filePath
 * @returns {Promise<{ buffer: Buffer, dosWrapped: boolean }>}
 */
async function readPostScriptSection(filePath) {
  const size = await statFileSize(filePath);
  if (size === 0) return { buffer: Buffer.alloc(0), dosWrapped: false };
  const handle = await fs.open(filePath, 'r');
  try {
    const probe = await readAt(handle, 0, Math.min(size, 32));
    const isDosEps =
      probe.length >= 12 && DOS_EPS_MAGIC.every((byte, index) => probe[index] === byte);
    if (isDosEps) {
      const offset = probe.readUInt32LE(4);
      const length = probe.readUInt32LE(8);
      if (offset >= size || length === 0) {
        logger.debug('[EPS] DOS EPS header points outside the file', { offset, length, size });
        return { buffer: Buffer.alloc(0), dosWrapped: true };
      }
      const wanted = Math.min(length, size - offset, EPS_MAX_BYTES);
      return { buffer: await readAt(handle, offset, wanted), dosWrapped: true };
    }
    return { buffer: await readAt(handle, 0, Math.min(size, EPS_MAX_BYTES)), dosWrapped: false };
  } finally {
    await handle.close();
  }
}

/**
 * Decode PostScript string escapes: \n \r \t \b \f \\ \( \) \ooo and the
 * backslash-newline continuation.
 * @param {string} raw
 * @returns {string}
 */
function decodePostScriptString(raw) {
  return raw.replace(/\\(\r\n|\r|\n|[0-7]{1,3}|[\s\S])/g, (match, escape) => {
    const code = String(escape);
    if (code === '\n' || code === '\r' || code === '\r\n') return '';
    if (/^[0-7]/.test(code)) return String.fromCharCode(parseInt(code, 8) & 0xff);
    switch (code) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      default:
        return code;
    }
  });
}

/**
 * Strip one layer of enclosing parentheses, decoding escapes inside.
 * @param {string} value
 * @returns {string}
 */
function unwrapPostScriptString(value) {
  const match = /^\((.*)\)$/s.exec(value.trim());
  return match ? decodePostScriptString(match[1]) : value;
}

/**
 * Value of a DSC comment, honouring "(atend)" deferrals and "%%+"
 * continuation lines. The last concrete value wins.
 * @param {string} text
 * @param {string} keyword
 * @returns {string}
 */
function readDscValue(text, keyword) {
  const pattern = new RegExp(`^%%${keyword}:[ \\t]*([^\\r\\n]*)`, 'gm');
  let value = '';
  let match;
  while ((match = pattern.exec(text)) !== null) {
    let candidate = match[1].trim();
    let cursor = pattern.lastIndex;
    for (;;) {
      const continuation = /^\r?\n%%\+[ \t]*([^\r\n]*)/.exec(text.slice(cursor, cursor + 1024));
      if (!continuation) break;
      candidate += ` ${continuation[1].trim()}`;
      cursor += continuation[0].length;
    }
    if (/^\(atend\)$/i.test(candidate)) continue;
    value = candidate;
  }
  return cleanInline(unwrapPostScriptString(value), EPS_MAX_FIELD_CHARS);
}

/**
 * "llx lly urx ury" plus the implied page size when the four numbers parse.
 * @param {string} value
 * @returns {string}
 */
function describeBoundingBox(value) {
  const parts = value.split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return value;
  const width = Number((parts[2] - parts[0]).toFixed(1));
  const height = Number((parts[3] - parts[1]).toFixed(1));
  return `${value} (${width} x ${height} pt)`;
}

/**
 * Index of the ")" closing the PostScript string that opens at `start`,
 * honouring nesting and backslash escapes; -1 when none within the cap.
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function findPostScriptStringEnd(text, start) {
  const limit = Math.min(text.length, start + EPS_MAX_STRING_CHARS);
  let depth = 0;
  for (let i = start; i < limit; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The operator token following a string operand, skipping whitespace and an
 * optional array/procedure operand (xshow, kshow). The scan never looks more
 * than EPS_OPERATOR_LOOKAHEAD_CHARS past `position`, and `end` reports how
 * far it got so the caller can charge the work against its budget.
 * @param {string} text
 * @param {number} position index just past the closing ")"
 * @returns {{ token: string, end: number }}
 */
function readOperatorAfter(text, position) {
  const limit = Math.min(text.length, position + EPS_OPERATOR_LOOKAHEAD_CHARS);
  let i = position;
  while (i < limit && /\s/.test(text[i])) i += 1;
  if (i < limit && (text[i] === '[' || text[i] === '{')) {
    const close = text[i] === '[' ? ']' : '}';
    let j = i + 1;
    while (j < limit && text[j] !== close) j += 1;
    if (j >= limit) return { token: '', end: j };
    i = j + 1;
    while (i < limit && /\s/.test(text[i])) i += 1;
  }
  const token = /^[A-Za-z]+/.exec(text.slice(i, Math.min(limit, i + 16)));
  return token ? { token: token[0], end: i + token[0].length } : { token: '', end: i };
}

/**
 * Best-effort text operands of show-family operators, up to `maxChars`.
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function collectShowText(text, maxChars) {
  /** @type {string[]} */
  const parts = [];
  let total = 0;
  let budget = EPS_SCAN_BUDGET_CHARS;
  let index = text.indexOf('(');
  while (index !== -1 && total < maxChars && budget > 0) {
    const end = findPostScriptStringEnd(text, index);
    budget -= (end === -1 ? EPS_MAX_STRING_CHARS : end - index) + 1;
    if (end === -1) {
      index = text.indexOf('(', index + 1);
      continue;
    }
    const operator = readOperatorAfter(text, end + 1);
    budget -= operator.end - end;
    if (SHOW_OPERATORS.has(operator.token)) {
      const decoded = cleanInline(decodePostScriptString(text.slice(index + 1, end)), maxChars);
      if (decoded) {
        parts.push(decoded);
        total += decoded.length + 1;
      }
    }
    index = text.indexOf('(', end + 1);
  }
  const joined = parts.join(' ');
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
}

/**
 * Labelled lines for a PostScript section, without a type header.
 * @param {Buffer} buffer
 * @returns {string[]}
 */
function describePostScript(buffer) {
  if (buffer.length === 0) return [];
  const text = buffer.toString('latin1');
  /** @type {string[]} */
  const lines = [];
  for (const [keyword, label] of DSC_FIELDS) {
    const value = readDscValue(text, keyword);
    if (!value) continue;
    if (keyword === 'BoundingBox') {
      lines.push(`${label}: ${describeBoundingBox(value)}`);
    } else if (keyword === 'DocumentFonts') {
      lines.push(`${label}: ${value.split(/\s+/).filter(Boolean).join(', ')}`);
    } else {
      lines.push(`${label}: ${value}`);
    }
  }
  const showText = collectShowText(text, EPS_MAX_SHOW_CHARS);
  if (showText) lines.push(`Text: ${showText}`);
  return lines;
}

/**
 * @param {string} filePath
 * @returns {Promise<{ header: string, lines: string[] }>}
 */
async function describeEpsFile(filePath) {
  const { buffer, dosWrapped } = await readPostScriptSection(filePath);
  try {
    const lines = describePostScript(buffer);
    // A wrapper note on its own (header pointing at nothing) is not useful.
    if (dosWrapped && lines.length > 0) {
      lines.unshift('Container: DOS EPS binary wrapper with preview section');
    }
    const header = /EPSF/.test(buffer.subarray(0, 256).toString('latin1'))
      ? 'Encapsulated PostScript (EPS) graphic'
      : 'PostScript document';
    return { header, lines };
  } catch (error) {
    if (isFilesystemError(error)) throw error;
    logger.debug('[EPS] Could not parse', { error: describeError(error) });
    return { header: '', lines: [] };
  }
}

/**
 * Describe an EPS/PostScript file: DSC header comments and the text drawn
 * with show-family operators.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function extractTextFromEps(filePath) {
  const { header, lines } = await describeEpsFile(filePath);
  if (lines.length === 0) return '';
  return finishOutput([header, ...lines]);
}

// ---------------------------------------------------------------------------
// Adobe Illustrator
// ---------------------------------------------------------------------------

/**
 * True when "%PDF-" occurs within the first 1024 bytes (PDF-compatible .ai).
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function isPdfCompatibleFile(filePath) {
  const { buffer } = await readPrefix(filePath, PDF_SNIFF_BYTES);
  return buffer.toString('latin1').includes('%PDF-');
}

/**
 * Describe an Adobe Illustrator document. PDF-compatible files are handed to
 * the injected PDF reader; older PostScript-flavoured files go through the
 * EPS reader. Resolves to '' when neither path finds anything.
 * @param {string} filePath
 * @param {{ extractTextFromPdf?: (filePath: string) => Promise<string> }} [options]
 * @returns {Promise<string>}
 */
async function extractTextFromAi(filePath, options = {}) {
  const extractTextFromPdf = options ? options.extractTextFromPdf : undefined;
  const pdfCompatible = await isPdfCompatibleFile(filePath);
  if (pdfCompatible && typeof extractTextFromPdf === 'function') {
    const text = await extractTextFromPdf(filePath);
    return typeof text === 'string' ? text : '';
  }
  const { lines } = await describeEpsFile(filePath);
  // An empty or structureless file gets '' like every other reader; the
  // label alone would tell the model nothing the extension does not.
  if (lines.length === 0) return '';
  const header = pdfCompatible
    ? 'Adobe Illustrator document (PDF-compatible, PostScript view)'
    : 'Adobe Illustrator document';
  return finishOutput([header, ...lines]);
}

module.exports = {
  extractTextFromStl,
  extractTextFromObj,
  extractTextFrom3mf,
  extractTextFromGcode,
  extractTextFromEps,
  isPdfCompatibleFile,
  extractTextFromAi
};
