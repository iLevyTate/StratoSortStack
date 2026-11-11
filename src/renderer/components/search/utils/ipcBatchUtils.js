// @ts-check
/**
 * Chunked wrappers for IPC calls whose schemas cap the id list.
 * A cluster or an Atlas lasso can hold far more ids than one call accepts,
 * and an oversized call is rejected whole by the main-process schema.
 */

/** `getFileMetadata` accepts at most this many ids per call. */
export const FILE_METADATA_BATCH_LIMIT = 100;
/** `files.addTags` accepts at most this many file ids per call. */
export const ADD_TAGS_BATCH_LIMIT = 1000;

/**
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @returns {T[][]}
 */
export function chunkArray(items, size) {
  const list = Array.isArray(items) ? items : [];
  const step = Math.max(1, Math.floor(size) || 1);
  /** @type {T[][]} */
  const chunks = [];
  for (let i = 0; i < list.length; i += step) {
    chunks.push(list.slice(i, i + step));
  }
  return chunks;
}

/**
 * Fetch metadata for any number of ids, one schema-sized call at a time.
 * A failed chunk leaves its ids out of `metadata` and is counted in
 * `failedChunks`; `success` is false only when nothing could be fetched.
 *
 * @param {string[]} ids
 * @param {(ids: string[]) => Promise<any>} [getFileMetadata] - defaults to the preload bridge
 * @returns {Promise<{ success: boolean, metadata: Record<string, any>, failedChunks: number, error?: string }>}
 */
export async function fetchFileMetadataChunked(ids, getFileMetadata) {
  const call =
    getFileMetadata ||
    /** @type {any} */ (globalThis).window?.electronAPI?.embeddings?.getFileMetadata;
  const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
  /** @type {Record<string, any>} */
  const metadata = {};
  if (typeof call !== 'function') {
    return { success: false, metadata, failedChunks: 0, error: 'File metadata is unavailable' };
  }
  const chunks = chunkArray(list, FILE_METADATA_BATCH_LIMIT);
  let failedChunks = 0;
  /** @type {string|undefined} */
  let error;
  for (const chunk of chunks) {
    try {
      const res = await call(chunk);
      if (res?.success === false) {
        failedChunks++;
        error = error || (typeof res.error === 'string' ? res.error : undefined);
        continue;
      }
      Object.assign(metadata, res?.metadata || {});
    } catch (e) {
      failedChunks++;
      error = error || /** @type {any} */ (e)?.message;
    }
  }
  const success = chunks.length === 0 || failedChunks < chunks.length;
  return error ? { success, metadata, failedChunks, error } : { success, metadata, failedChunks };
}

/**
 * Tag any number of files, one schema-sized call at a time, and report how
 * many files were really updated (the handler can succeed for only some).
 *
 * @param {string[]} fileIds
 * @param {string[]} tags
 * @param {(fileIds: string[], tags: string[]) => Promise<any>} [addTags] - defaults to the preload bridge
 * @returns {Promise<{ success: boolean, total: number, updated: number, failed: number, error?: any }>}
 */
export async function addTagsChunked(fileIds, tags, addTags) {
  const call = addTags || /** @type {any} */ (globalThis).window?.electronAPI?.files?.addTags;
  const list = Array.isArray(fileIds) ? fileIds.filter(Boolean) : [];
  const total = list.length;
  if (typeof call !== 'function') {
    return { success: false, total, updated: 0, failed: total, error: 'Tagging is unavailable' };
  }
  let updated = 0;
  /** @type {any} */
  let error;
  for (const chunk of chunkArray(list, ADD_TAGS_BATCH_LIMIT)) {
    try {
      const res = await call(chunk, tags);
      // Older handlers return no count; treat a bare success as the whole chunk.
      const count = Number.isFinite(res?.updated)
        ? Number(res.updated)
        : res?.success
          ? chunk.length
          : 0;
      updated += Math.min(chunk.length, Math.max(0, count));
      if (!res?.success || count < chunk.length) {
        error = error || res?.errors?.[0]?.error || res?.error;
      }
    } catch (e) {
      error = error || /** @type {any} */ (e)?.message;
    }
  }
  const failed = total - updated;
  const result = { success: updated > 0, total, updated, failed };
  return error && failed > 0 ? { ...result, error } : result;
}
