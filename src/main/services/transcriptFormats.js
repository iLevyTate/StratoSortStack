// @ts-check

/**
 * Pure converters from persisted Whisper transcript segments
 * ({start, end, text} in seconds) to VTT / SRT / JSON documents.
 * No I/O — fully unit-testable.
 */

/**
 * @typedef {Object} TranscriptJsonInput
 * @property {string|null} [sourceFile]
 * @property {string|null} [language]
 * @property {number|null} [durationSeconds]
 * @property {string} [text]
 * @property {Array<{start:number, end:number, text:string}>} [segments]
 */

/**
 * @param {Array<{start:number, end:number, text:string}|null|undefined>} segments
 * @returns {Array<{start:number, end:number, text:string}>}
 */
function sanitizeSegments(segments) {
  if (!Array.isArray(segments)) return [];
  /** @type {Array<{start:number, end:number, text:string}>} */
  const out = [];
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    const start = Number(seg.start);
    const end = Number(seg.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (end < start) continue;
    const text = String(seg.text ?? '')
      .replace(/\r?\n/g, ' ')
      .trim();
    out.push({ start, end, text });
  }
  return out;
}

/**
 * @param {number} n
 * @param {number} w
 * @returns {string}
 */
function pad(n, w) {
  return String(n).padStart(w, '0');
}

/**
 * Format seconds as HH:MM:SS<sep>mmm with millisecond carry.
 * @param {number} seconds
 * @param {'.'|','} sep - '.' for VTT, ',' for SRT
 * @returns {string}
 */
function formatTimestamp(seconds, sep) {
  const totalMs = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : 0;
  const ms = totalMs % 1000;
  const totalSec = (totalMs - ms) / 1000;
  const s = totalSec % 60;
  const totalMin = (totalSec - s) / 60;
  const m = totalMin % 60;
  const h = (totalMin - m) / 60;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${sep}${pad(ms, 3)}`;
}

/**
 * WebVTT cue-text escaping: the cue grammar treats `<` as tag-open (a raw
 * `<` swallows the rest of the line as a malformed tag in browser <track>
 * rendering) and requires `&` as an entity. SRT has no such rules, so this
 * applies to VTT only.
 * @param {string} text
 * @returns {string}
 */
function escapeVttCueText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param {Array<{start:number, end:number, text:string}>} segments
 * @returns {string} WebVTT document
 */
function toVtt(segments) {
  const cues = sanitizeSegments(segments).map(
    (seg, i) =>
      `${i + 1}\n${formatTimestamp(seg.start, '.')} --> ${formatTimestamp(seg.end, '.')}\n${escapeVttCueText(seg.text)}\n`
  );
  return `WEBVTT\n\n${cues.join('\n')}`;
}

/**
 * @param {Array<{start:number, end:number, text:string}>} segments
 * @returns {string} SubRip document
 */
function toSrt(segments) {
  return sanitizeSegments(segments)
    .map(
      (seg, i) =>
        `${i + 1}\n${formatTimestamp(seg.start, ',')} --> ${formatTimestamp(seg.end, ',')}\n${seg.text}\n\n`
    )
    .join('');
}

/**
 * @param {TranscriptJsonInput} input
 * @returns {string} pretty-printed JSON document
 */
function toTranscriptJson(input) {
  const src = input || {};
  return JSON.stringify(
    {
      sourceFile: typeof src.sourceFile === 'string' ? src.sourceFile : null,
      language: typeof src.language === 'string' ? src.language : null,
      durationSeconds: Number.isFinite(src.durationSeconds) ? src.durationSeconds : null,
      text: typeof src.text === 'string' ? src.text : '',
      segments: sanitizeSegments(src.segments || [])
    },
    null,
    2
  );
}

module.exports = { formatTimestamp, toVtt, toSrt, toTranscriptJson };
