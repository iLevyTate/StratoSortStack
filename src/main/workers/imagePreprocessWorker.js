// @ts-check
'use strict';

/**
 * imagePreprocessWorker
 *
 * Offloads `sharp` / libvips work off the Electron main thread so that IPC,
 * Redux state, and the AI pipeline remain responsive while images are being
 * decoded, resized, rasterized, or re-encoded.
 *
 * Each task type maps to an operation that today runs inline in the main
 * process (see `src/main/analysis/imageAnalysis.js` and
 * `src/main/analysis/documentExtractors.js`). Callers MUST keep a synchronous
 * sharp-in-main-process fallback so that startup failures of this worker
 * (e.g. sharp native module missing, Piscina disabled) never regress feature
 * behaviour — only throughput.
 *
 * Contract:
 *   Input:  { type, buffer: Buffer, options?: object }
 *   Output: per-task object (see switch in module.exports below)
 *
 * Buffers are passed by structured-clone copy (not transfer). Total per-call
 * payload is bounded by the caller's own size limits (e.g. OCR_MAX_FILE_SIZE,
 * OCR_MAX_BYTES), so we do not re-enforce limits here — doing so would split
 * the source of truth across two files.
 */

const { createLogger } = require('../../shared/logger');
const { createSharpLoader } = require('../../shared/getSharp');
const { pickExifIsoDay } = require('../analysis/exifDate');

const logger = createLogger('ImagePreprocessWorker');
const getSharp = createSharpLoader({
  logger,
  label: '[ImagePreprocessWorker] Failed to load sharp',
  concurrency: 1
});

/**
 * Parse EXIF metadata and return the earliest capture date in YYYY-MM-DD form.
 * Mirrors the behaviour of `extractExifDate` in imageAnalysis.js so the two
 * paths stay interchangeable.
 */
/** @param {any} meta */
function extractExifDateFromMetadata(meta) {
  if (!meta || !meta.exif) return null;
  try {
    /** @type {any} */
    const exif = require('exif-reader')(meta.exif);
    if (!exif) return null;
    // One reader for both paths: IFD-grouped 2.x and flat 1.x shapes, with
    // placeholder dates (unset camera clock) skipped.
    return pickExifIsoDay(exif);
  } catch {
    return null;
  }
}

async function handleMetadata(
  /** @type {{ buffer: Buffer, options?: any }} */ { buffer, options }
) {
  const sharp = getSharp();
  if (!sharp) {
    return { error: 'sharp unavailable in worker' };
  }
  const meta = await sharp(buffer, options?.sharpOptions || undefined).metadata();
  const exifDate = extractExifDateFromMetadata(meta);
  return {
    metadata: {
      width: meta?.width,
      height: meta?.height,
      format: meta?.format,
      channels: meta?.channels,
      space: meta?.space,
      hasAlpha: meta?.hasAlpha,
      density: meta?.density,
      orientation: meta?.orientation
    },
    exifDate
  };
}

async function handlePreprocess(
  /** @type {{ buffer: Buffer, options?: any }} */ { buffer, options }
) {
  const sharp = getSharp();
  if (!sharp) {
    return { error: 'sharp unavailable in worker' };
  }
  const maxDimension = Number.isFinite(options?.maxDimension) ? options.maxDimension : 1024;
  const needsFormatConversion = Boolean(options?.needsFormatConversion);
  const sharpOptions = options?.sharpOptions || undefined;

  let meta;
  try {
    meta = await sharp(buffer, sharpOptions).metadata();
  } catch {
    meta = null;
  }

  const shouldResize =
    meta && (Number(meta.width) > maxDimension || Number(meta.height) > maxDimension);

  // Match the main-thread path: EXIF orientation must be baked in before any
  // early-return, otherwise small portrait JPEGs go to the VLM rotated 90°
  // and produce wrong tags/descriptions. See imageAnalysis.js for the full
  // rationale.
  const hasNonIdentityOrientation = Boolean(
    meta && Number.isFinite(meta.orientation) && meta.orientation > 1
  );

  if (!needsFormatConversion && !shouldResize && !hasNonIdentityOrientation) {
    return { buffer, changed: false };
  }

  let transformer = sharp(buffer, sharpOptions).rotate();
  if (shouldResize) {
    /** @type {{ fit: string, withoutEnlargement: boolean, width?: number, height?: number }} */
    const resizeOptions = { fit: 'inside', withoutEnlargement: true };
    if (meta && meta.width && meta.height) {
      if (meta.width >= meta.height) {
        resizeOptions.width = maxDimension;
      } else {
        resizeOptions.height = maxDimension;
      }
    } else {
      resizeOptions.width = maxDimension;
    }
    transformer = transformer.resize(resizeOptions);
  }
  const compressionLevel = Number.isFinite(options?.compressionLevel)
    ? options.compressionLevel
    : 5;
  const out = await transformer.png({ compressionLevel }).toBuffer();
  return { buffer: out, changed: true };
}

async function handleResizeForOcr(
  /** @type {{ buffer: Buffer, options?: any }} */ { buffer, options }
) {
  const sharp = getSharp();
  if (!sharp) {
    return { error: 'sharp unavailable in worker' };
  }
  const maxWidth = options?.maxWidth;
  const maxHeight = options?.maxHeight;
  const compressionLevel = Number.isFinite(options?.compressionLevel)
    ? options.compressionLevel
    : 6;

  let pipeline = sharp(buffer);
  const meta = await pipeline.metadata();
  const shouldResize =
    Number.isFinite(maxWidth) &&
    Number.isFinite(maxHeight) &&
    (meta.width > maxWidth || meta.height > maxHeight);
  if (shouldResize) {
    pipeline = pipeline.resize(maxWidth, maxHeight, {
      fit: 'inside',
      withoutEnlargement: true
    });
  }
  const out = await pipeline.png({ compressionLevel }).toBuffer();
  return { buffer: out, width: meta.width, height: meta.height, resized: shouldResize };
}

async function handleRasterizePdf(
  /** @type {{ buffer: Buffer, options?: any }} */ { buffer, options }
) {
  const sharp = getSharp();
  if (!sharp) {
    return { error: 'sharp unavailable in worker' };
  }
  const density = Number.isFinite(options?.density) ? options.density : 200;
  const maxWidth = options?.maxWidth;
  const maxHeight = options?.maxHeight;
  const compressionLevel = Number.isFinite(options?.compressionLevel)
    ? options.compressionLevel
    : 6;

  let pipeline = sharp(buffer, { density });
  let metadata;
  try {
    metadata = await pipeline.metadata();
  } catch (metaError) {
    // libvips may lack PDF support; surface a structured error so the caller
    // can fall back to the canvas-based renderer path.
    return { error: metaError?.message || 'pdf metadata failed', unsupported: true };
  }

  const shouldResize =
    Number.isFinite(maxWidth) &&
    Number.isFinite(maxHeight) &&
    (metadata.width > maxWidth || metadata.height > maxHeight);
  if (shouldResize) {
    pipeline = pipeline.resize(maxWidth, maxHeight, {
      fit: 'inside',
      withoutEnlargement: true
    });
  }

  try {
    const out = await pipeline.png({ compressionLevel }).toBuffer();
    return {
      buffer: out,
      width: metadata.width,
      height: metadata.height,
      resized: shouldResize
    };
  } catch (renderError) {
    return { error: renderError?.message || 'pdf rasterize failed', renderFailed: true };
  }
}

/** @param {any} task */
module.exports = async function runImagePreprocessTask(task = {}) {
  const { type } = task || {};
  try {
    switch (type) {
      case 'metadata':
        return await handleMetadata(task);
      case 'preprocess':
        return await handlePreprocess(task);
      case 'resize_for_ocr':
        return await handleResizeForOcr(task);
      case 'rasterize_pdf':
        return await handleRasterizePdf(task);
      default:
        return { error: `Unknown image preprocess task type: ${type}` };
    }
  } catch (error) {
    // Never throw across the worker boundary — callers use a structured
    // { error } result to decide whether to fall back to sync sharp in the
    // main process.
    return { error: error?.message || String(error) };
  }
};
