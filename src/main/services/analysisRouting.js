// @ts-check
/**
 * Pure routing helpers for the analysis dispatch.
 *
 * Extracted from BatchAnalysisService so verification scripts and tests
 * can import partitionFilesByModality without instantiating the full
 * service (which transitively pulls in electron.app via the embedding
 * queue and is not available in plain-Node contexts).
 *
 * The class methods on BatchAnalysisService delegate here so behavior
 * stays single-sourced.
 */

const path = require('path');
const { classifyMediaFile } = require('../analysis/mediaAnalysis');
const { getFileTypeCategory } = require('./autoOrganize/fileTypeUtils');

function isImageFile(/** @type {any} */ extension) {
  return getFileTypeCategory(extension) === 'Images';
}

function isMediaFile(/** @type {any} */ filePath) {
  return classifyMediaFile(filePath) !== null;
}

/**
 * Deterministically partition files into document, image, and media
 * sections. Preserves input order inside each modality lane.
 *
 * @param {string[]} filePaths
 * @returns {{ documents: string[], images: string[], media: string[] }}
 */
function partitionFilesByModality(filePaths) {
  const documents = [];
  const images = [];
  const media = [];

  for (const filePath of filePaths) {
    const extension = path.extname(filePath).toLowerCase();
    if (isImageFile(extension)) {
      images.push(filePath);
    } else if (isMediaFile(filePath)) {
      media.push(filePath);
    } else {
      documents.push(filePath);
    }
  }

  return { documents, images, media };
}

module.exports = {
  partitionFilesByModality,
  isImageFile,
  isMediaFile
};
