// @ts-check
'use strict';

/** Claude and OpenAI vision accept these four types. */
const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
/** One video is a handful of frames, not a film strip. */
const MAX_IMAGES = 4;
/** About 4.5 MB of base64, under the provider per-image limit. */
const MAX_DATA_CHARS = 6_000_000;

/**
 * @param {unknown} images
 * @returns {Array<{ mediaType: string, data: string }>}
 */
function normalizeImages(images) {
  if (!Array.isArray(images)) return [];
  /** @type {Array<{ mediaType: string, data: string }>} */
  const out = [];
  for (const image of images) {
    if (out.length >= MAX_IMAGES) break;
    const mediaType = /** @type {any} */ (image)?.mediaType;
    const data = /** @type {any} */ (image)?.data;
    if (!ALLOWED_MEDIA_TYPES.has(mediaType) || typeof data !== 'string' || data.length === 0) {
      continue;
    }
    if (data.length > MAX_DATA_CHARS) continue;
    out.push({ mediaType, data });
  }
  return out;
}

/**
 * Anthropic user content: a string when there are no images, otherwise
 * image blocks followed by the text block.
 * @param {unknown} prompt
 * @param {unknown} images
 * @returns {string | Array<Record<string, any>>}
 */
function anthropicUserContent(prompt, images) {
  const frames = normalizeImages(images);
  const text = String(prompt ?? '');
  if (frames.length === 0) return text;
  return [
    ...frames.map((frame) => ({
      type: 'image',
      source: { type: 'base64', media_type: frame.mediaType, data: frame.data }
    })),
    { type: 'text', text }
  ];
}

/**
 * OpenAI-compatible user content. Same rule as Anthropic: text only, unless
 * image frames were supplied.
 * @param {unknown} prompt
 * @param {unknown} images
 * @returns {string | Array<Record<string, any>>}
 */
function openAiUserContent(prompt, images) {
  const frames = normalizeImages(images);
  const text = String(prompt ?? '');
  if (frames.length === 0) return text;
  return [
    ...frames.map((frame) => ({
      type: 'image_url',
      image_url: { url: `data:${frame.mediaType};base64,${frame.data}` }
    })),
    { type: 'text', text }
  ];
}

module.exports = {
  MAX_IMAGES,
  anthropicUserContent,
  normalizeImages,
  openAiUserContent
};
