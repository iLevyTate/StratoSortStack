// @ts-check
const { CHUNKING } = require('../../shared/performanceConstants');

function getMaxChunkableTextLength() {
  const chunkSize = Number.isFinite(CHUNKING.CHUNK_SIZE)
    ? Math.max(200, CHUNKING.CHUNK_SIZE)
    : 1000;
  const overlap = Number.isFinite(CHUNKING.OVERLAP) ? Math.max(0, CHUNKING.OVERLAP) : 200;
  const maxChunks = Number.isFinite(CHUNKING.MAX_CHUNKS) ? Math.max(1, CHUNKING.MAX_CHUNKS) : 80;
  const step = Math.max(1, chunkSize - Math.min(overlap, chunkSize - 1));
  return chunkSize + step * (maxChunks - 1);
}

function normalizeExtractedTextForStorage(/** @type {any} */ text) {
  if (typeof text !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/\u0000/g, '').trim();
  if (!cleaned) return null;
  const maxLen = getMaxChunkableTextLength();
  if (cleaned.length <= maxLen) return cleaned;
  // Snap to nearest whitespace boundary to avoid cutting mid-word
  const cutPoint = cleaned.lastIndexOf(' ', maxLen);
  return cleaned.slice(0, cutPoint > maxLen * 0.9 ? cutPoint : maxLen);
}

module.exports = {
  getMaxChunkableTextLength,
  normalizeExtractedTextForStorage
};
