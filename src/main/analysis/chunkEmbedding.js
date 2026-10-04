// @ts-check
/**
 * Passage ("chunk") vectors for one analyzed file: the deep-recall leg that
 * search and chat fuse with the file-level vector. One builder for every
 * live ingestion route (Discover, the smart-folder watcher, Downloads), so
 * the passages a file gets never depend on which door it came in through.
 * The Settings rebuild keeps its own batched variant because it groups chunk
 * rows per flush; the payload shape there is the same as here.
 */

const path = require('path');
const { chunkText } = require('../utils/textChunking');
const { CHUNKING } = require('../../shared/performanceConstants');
const { AI_DEFAULTS } = require('../../shared/constants');
const { isAutoChunkEnabled } = require('../../shared/experienceMode');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('ChunkEmbedding');

/** @returns {Promise<any>} */
function defaultLoadSettings() {
  // Lazy: this module is loaded by the analysis pipeline, where pulling the
  // settings service in at require time would create a load-order cycle.
  const { getInstance } = require('../services/SettingsService');
  return getInstance().load();
}

/**
 * Whether chunk vectors should be built at all. Reads the resolved setting
 * (Simple mode forces chunking on), falling back to the shipped default when
 * settings cannot be read.
 * @param {() => Promise<any>} loadSettings
 */
async function isChunkingEnabled(loadSettings) {
  try {
    return isAutoChunkEnabled(await loadSettings());
  } catch (settingsErr) {
    logger.debug('[ChunkEmbedding] Could not load settings for chunk preference:', {
      error: settingsErr?.message
    });
    return AI_DEFAULTS.EMBEDDING.AUTO_CHUNK_ON_ANALYSIS !== false;
  }
}

/**
 * Embed the chunks of `text` into `batchUpsertFileChunks` payloads. Pure with
 * respect to the store: nothing is written. A chunk whose embedding fails is
 * dropped and logged; an abort stops the loop and returns what was built so
 * far (callers must not persist a partial set, see embedFileChunks).
 *
 * @param {object} p
 * @param {string} p.fileId
 * @param {string} p.filePath
 * @param {string} p.text
 * @param {(text: string) => Promise<{ vector?: number[], model?: string } | null | undefined>} p.embedText
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<{ payloads: Array<Record<string, any>>, aborted: boolean }>}
 */
async function buildFileChunkPayloads({ fileId, filePath, text, embedText, signal }) {
  const fileName = path.basename(filePath);
  const chunks = chunkText(text, {
    chunkSize: CHUNKING.CHUNK_SIZE,
    overlap: CHUNKING.OVERLAP,
    maxChunks: CHUNKING.MAX_CHUNKS
  });
  /** @type {Array<Record<string, any>>} */
  const payloads = [];
  for (const c of chunks) {
    if (signal?.aborted) return { payloads, aborted: true };
    try {
      const embedding = await embedText(c.text);
      if (!Array.isArray(embedding?.vector) || embedding.vector.length === 0) continue;
      const snippet = c.text.slice(0, 240);
      payloads.push({
        id: `chunk:${fileId}:${c.index}`,
        vector: embedding.vector,
        model: embedding.model,
        meta: {
          fileId,
          path: filePath,
          name: fileName,
          chunkIndex: c.index,
          startOffset: c.charStart,
          endOffset: c.charEnd,
          text: c.text,
          content: c.text,
          charStart: c.charStart,
          charEnd: c.charEnd,
          snippet,
          model: embedding.model || 'unknown'
        },
        document: snippet,
        updatedAt: new Date().toISOString()
      });
    } catch (chunkErr) {
      logger.debug('[ChunkEmbedding] Failed to embed chunk:', {
        file: fileName,
        chunkIndex: c.index,
        error: chunkErr?.message
      });
    }
  }
  return { payloads, aborted: Boolean(signal?.aborted) };
}

/**
 * Embed and persist chunk vectors for one file. The file's old chunks are
 * replaced only once a complete new set exists, so a failed or aborted pass
 * leaves the previous passages searchable. Never throws: chunking is a
 * recall improvement, and its failure must not fail the analysis that
 * produced the file vector.
 *
 * @param {object} p
 * @param {string} p.fileId  the file's vector id (chunk ids are derived from it)
 * @param {string} p.filePath
 * @param {string | null | undefined} p.extractedText
 * @param {(text: string) => Promise<{ vector?: number[], model?: string } | null | undefined>} p.embedText
 * @param {{ deleteFileChunks?: Function, batchUpsertFileChunks?: Function } | null | undefined} p.vectorDb
 * @param {() => Promise<any>} [p.loadSettings]  defaults to the settings service
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<{ persisted: number, skipped: string | null }>}
 *   `skipped` names why nothing was written: 'disabled', 'short_text',
 *   'no_store', 'aborted', 'no_embeddings' or 'error'.
 */
async function embedFileChunks({
  fileId,
  filePath,
  extractedText,
  embedText,
  vectorDb,
  loadSettings = defaultLoadSettings,
  signal
}) {
  try {
    if (!(await isChunkingEnabled(loadSettings))) return { persisted: 0, skipped: 'disabled' };
    const text = typeof extractedText === 'string' ? extractedText : '';
    if (text.trim().length < CHUNKING.MIN_TEXT_LENGTH) {
      return { persisted: 0, skipped: 'short_text' };
    }
    if (typeof vectorDb?.batchUpsertFileChunks !== 'function') {
      return { persisted: 0, skipped: 'no_store' };
    }

    const { payloads, aborted } = await buildFileChunkPayloads({
      fileId,
      filePath,
      text,
      embedText,
      signal
    });
    if (aborted) return { persisted: 0, skipped: 'aborted' };
    if (payloads.length === 0) return { persisted: 0, skipped: 'no_embeddings' };

    if (typeof vectorDb.deleteFileChunks === 'function') {
      await vectorDb.deleteFileChunks(fileId);
    }
    const count = await vectorDb.batchUpsertFileChunks(payloads);
    const persisted = Number.isFinite(Number(count)) ? Number(count) : payloads.length;
    logger.debug('[ChunkEmbedding] Embedded chunks:', {
      file: path.basename(filePath),
      count: persisted
    });
    return { persisted, skipped: null };
  } catch (error) {
    logger.warn('[ChunkEmbedding] Chunk embedding failed (non-fatal):', {
      file: path.basename(String(filePath || '')),
      error: error?.message
    });
    return { persisted: 0, skipped: 'error' };
  }
}

module.exports = {
  embedFileChunks,
  buildFileChunkPayloads
};
