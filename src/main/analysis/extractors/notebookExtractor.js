// @ts-check
/**
 * Jupyter notebook (.ipynb) to plain text.
 *
 * Renders a notebook as short labelled blocks a language model can summarize:
 * a header naming the kernel, then each cell in order - markdown as-is,
 * `[code]` blocks for source, `[output]` blocks for the text outputs that
 * follow them. Rich outputs (images, HTML, widgets) are skipped because
 * their payloads are not text.
 *
 * Reads are bounded by bytes so a multi-GB file is never pulled into memory,
 * malformed JSON yields `''` rather than an exception, and real filesystem
 * errors (ENOENT, EACCES, ...) propagate to the caller. Trailing whitespace
 * is trimmed with `trimEnd()`, never `/\s+$/`: that regex is quadratic on a
 * long whitespace run and a notebook cell can hold megabytes of it.
 *
 * @module analysis/extractors/notebookExtractor
 */

const fs = require('fs');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('NotebookExtractor');

const DEFAULT_MAX_CHARS = 500000;
const DEFAULT_MAX_OUTPUT_CHARS_PER_CELL = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const TRUNCATION_MARKER = '…';
/** A kernel name longer than this is not a name; the header keeps the head. */
const MAX_KERNEL_NAME_CHARS = 200;
const SEGMENT_SEPARATOR = '\n\n';

// Terminal colour codes are common in stream outputs and are noise for a model.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * @typedef {Object} NotebookExtractOptions
 * @property {number} [maxChars] Cap on the returned text (default 500000).
 * @property {number} [maxOutputCharsPerCell] Cap on the output text kept per
 *   code cell, across all of that cell's outputs (default 2000).
 * @property {number} [maxBytes] Files above this size are not read and yield
 *   `''` (default 50 MiB).
 */

/**
 * Extract the readable text of a Jupyter notebook.
 *
 * @param {string} filePath
 * @param {NotebookExtractOptions} [options]
 * @returns {Promise<string>} Labelled blocks joined by blank lines, truncated
 *   to `maxChars`; `''` when the file is not a notebook or has no cells.
 */
async function extractTextFromIpynb(filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) return '';
  const opts = options || {};
  const maxChars = toBoundedInt(opts.maxChars, DEFAULT_MAX_CHARS, 0);
  const maxOutputChars = toBoundedInt(
    opts.maxOutputCharsPerCell,
    DEFAULT_MAX_OUTPUT_CHARS_PER_CELL,
    0
  );
  const maxBytes = toBoundedInt(opts.maxBytes, DEFAULT_MAX_BYTES, 1);
  if (maxChars === 0) return '';

  const stat = await fs.promises.stat(filePath);
  if (stat.size > maxBytes) {
    logger.debug('[NotebookExtractor] Notebook exceeds read cap; skipping', {
      bytes: stat.size,
      maxBytes
    });
    return '';
  }

  if (stat.size === 0) return '';

  const raw = await readHeadBytes(filePath, Math.min(stat.size, maxBytes));
  if (raw.length === 0) return '';

  const notebook = parseNotebook(raw);
  if (!notebook) return '';

  const cells = collectCells(notebook);
  if (cells.length === 0) {
    logger.debug('[NotebookExtractor] Notebook has no cells');
    return '';
  }

  /** @type {string[]} */
  const segments = [];
  let total = 0;
  const push = (/** @type {string} */ segment) => {
    const text = segment.trimEnd();
    if (text.length === 0) return;
    segments.push(text);
    total += text.length + SEGMENT_SEPARATOR.length;
  };

  push(buildHeader(notebook));

  for (const cell of cells) {
    if (total >= maxChars) break;
    renderCell(cell, maxOutputChars, push);
  }

  const text = segments.join(SEGMENT_SEPARATOR);
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/**
 * @param {Buffer} raw
 * @returns {any | null} The parsed notebook object, or `null` on bad JSON.
 */
function parseNotebook(raw) {
  let text = raw.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.debug('[NotebookExtractor] JSON root is not a notebook object');
      return null;
    }
    return parsed;
  } catch (err) {
    logger.debug('[NotebookExtractor] Notebook is not valid JSON', { error: toMessage(err) });
    return null;
  }
}

/**
 * nbformat 4 keeps cells at the root; nbformat 3 nests them in worksheets.
 *
 * @param {any} notebook
 * @returns {any[]}
 */
function collectCells(notebook) {
  if (Array.isArray(notebook.cells)) {
    return notebook.cells.filter((/** @type {unknown} */ c) => c && typeof c === 'object');
  }
  if (Array.isArray(notebook.worksheets)) {
    /** @type {any[]} */
    const cells = [];
    for (const sheet of notebook.worksheets) {
      if (sheet && Array.isArray(sheet.cells)) {
        for (const cell of sheet.cells) {
          if (cell && typeof cell === 'object') cells.push(cell);
        }
      }
    }
    return cells;
  }
  return [];
}

/**
 * @param {any} notebook
 * @returns {string}
 */
function buildHeader(notebook) {
  const metadata =
    notebook.metadata && typeof notebook.metadata === 'object' ? notebook.metadata : {};
  const kernel = firstString(
    metadata.kernelspec && metadata.kernelspec.display_name,
    metadata.language_info && metadata.language_info.name,
    metadata.kernelspec && metadata.kernelspec.name
  );
  if (!kernel) return 'Jupyter notebook';
  const name =
    kernel.length > MAX_KERNEL_NAME_CHARS ? kernel.slice(0, MAX_KERNEL_NAME_CHARS) : kernel;
  return `Jupyter notebook (${name})`;
}

/**
 * @param {any} cell
 * @param {number} maxOutputChars
 * @param {(segment: string) => void} push
 */
function renderCell(cell, maxOutputChars, push) {
  const type = typeof cell.cell_type === 'string' ? cell.cell_type : 'raw';
  // nbformat 3 code cells store source under `input`.
  const source = joinSource(cell.source !== undefined ? cell.source : cell.input);

  if (type === 'code') {
    if (source.length > 0) push(labelled('[code]', source));
    renderOutputs(cell.outputs, maxOutputChars, push);
    return;
  }
  // markdown, raw and any unknown type carry their source verbatim.
  if (source.length > 0) push(source);
}

/**
 * Emit `[output]` blocks for the text outputs of a code cell, sharing one
 * character budget across the cell.
 *
 * @param {unknown} outputs
 * @param {number} budget
 * @param {(segment: string) => void} push
 */
function renderOutputs(outputs, budget, push) {
  if (!Array.isArray(outputs) || budget <= 0) return;
  let remaining = budget;
  for (const output of outputs) {
    if (remaining <= 0) break;
    const text = outputText(output);
    if (text.length === 0) continue;
    if (text.length > remaining) {
      push(labelled('[output]', text.slice(0, remaining) + TRUNCATION_MARKER));
      break;
    }
    push(labelled('[output]', text));
    remaining -= text.length;
  }
}

/**
 * Plain text of one output entry; `''` for rich-only outputs.
 *
 * @param {any} output
 * @returns {string}
 */
function outputText(output) {
  if (!output || typeof output !== 'object') return '';
  const type = output.output_type;
  /** @type {unknown} */
  let value;
  if (type === 'stream') {
    value = output.text;
  } else if (type === 'execute_result' || type === 'display_data' || type === 'pyout') {
    const data = output.data && typeof output.data === 'object' ? output.data : null;
    value = data ? data['text/plain'] : output.text;
  } else {
    return '';
  }
  return cleanOutput(joinSource(value));
}

/**
 * @param {string} text
 * @returns {string}
 */
function cleanOutput(text) {
  return text.replace(ANSI_ESCAPE_RE, '').replace(/\r\n?/g, '\n').trimEnd();
}

/**
 * Notebook `source`/`text` fields are either a string or an array of lines
 * that usually, but not always, keep their trailing newline.
 *
 * @param {unknown} value
 * @returns {string}
 */
function joinSource(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  /** @type {string[]} */
  const parts = [];
  // Tracked as a flag: calling endsWith() on the growing string would flatten
  // V8's rope on every iteration and turn a long array into quadratic work.
  let needsNewline = false;
  for (const part of value) {
    if (typeof part !== 'string' || part.length === 0) continue;
    if (needsNewline) parts.push('\n');
    parts.push(part);
    needsNewline = part.charCodeAt(part.length - 1) !== 0x0a;
  }
  return parts.join('');
}

/**
 * @param {string} label
 * @param {string} body
 * @returns {string}
 */
function labelled(label, body) {
  const trimmed = body.replace(/^\n+/, '').trimEnd();
  return trimmed.indexOf('\n') >= 0 ? `${label}\n${trimmed}` : `${label} ${trimmed}`;
}

/**
 * @param {...unknown} candidates
 * @returns {string}
 */
function firstString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
  }
  return '';
}

/**
 * Read at most `maxBytes` from the start of a file.
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
  extractTextFromIpynb
};
