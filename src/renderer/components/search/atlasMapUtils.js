// @ts-check
/**
 * Pure helpers for the latent-space Atlas map. Kept separate from
 * AtlasTabContent.jsx so they can be unit-tested — the component module pulls
 * in regl-scatterplot, which needs WebGL at import time and cannot load under
 * jsdom.
 */

import { LIMITS } from '../../../shared/performanceConstants';

export const ATLAS_PALETTE = [
  '#2563eb',
  '#dc2626',
  '#16a34a',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#65a30d',
  '#ea580c',
  '#4f46e5',
  '#0d9488',
  '#ca8a04'
];
export const ATLAS_OTHER_COLOR = '#94a3b8';
export const ATLAS_KIND_COLORS = ['#2563eb', '#f59e0b']; // file, folder

/** @type {Record<string, [number, number]>} */
export const ARROW_DIRECTIONS = {
  ArrowRight: [1, 0],
  ArrowLeft: [-1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1]
};

/**
 * The point-array field each non-'kind' colour mode groups by. `category`
 * (smart folder / AI category) and `topics` (embedding clusters) are the
 * human-meaningful modes; `folder` (source directory) and `tag` are the raw
 * modes kept for drill-down.
 * @type {Record<string, string>}
 */
export const MODE_KEY_FIELD = {
  category: 'categoryKeys',
  topics: 'clusterKeys',
  folder: 'folderKeys',
  tag: 'tagKeys'
};

/**
 * Assign each point a categorical colour index for the active colour mode.
 * The most frequent keys get distinct palette colours; the long tail collapses
 * into a single "Other" bucket so the legend stays readable.
 *
 * @param {{ kinds: string[], folderKeys: string[], tagKeys: string[], categoryKeys?: string[], clusterKeys?: string[] }} points
 * @param {string} mode - 'category' | 'topics' | 'folder' | 'tag' | 'kind'
 * @returns {{ categoryIndex: number[], palette: string[], legend: Array<{label: string, color: string}> }}
 */
export function buildCategories(points, mode) {
  if (mode === 'kind') {
    const categoryIndex = points.kinds.map((k) => (k === 'folder' ? 1 : 0));
    return {
      categoryIndex,
      palette: ATLAS_KIND_COLORS,
      legend: [
        { label: 'Files', color: ATLAS_KIND_COLORS[0] },
        { label: 'Folders', color: ATLAS_KIND_COLORS[1] }
      ]
    };
  }
  const field = MODE_KEY_FIELD[mode] || 'folderKeys';
  // Fall back to source folders if the requested key array is absent (old cached
  // projection with no categoryKeys, or topics selected before clusters load) so
  // the map still renders instead of collapsing to a single bucket.
  const candidate = /** @type {any} */ (points)[field];
  const src =
    Array.isArray(candidate) && candidate.length === points.folderKeys.length
      ? candidate
      : points.folderKeys;
  const freq = new Map();
  for (const raw of src) {
    const key = raw || '(none)';
    freq.set(key, (freq.get(key) || 0) + 1);
  }
  const top = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, ATLAS_PALETTE.length)
    .map(([k]) => k);
  const keyToIdx = new Map(top.map((k, i) => [k, i]));
  const otherIdx = ATLAS_PALETTE.length;
  let usedOther = false;
  const categoryIndex = src.map((raw) => {
    const key = raw || '(none)';
    const idx = keyToIdx.get(key);
    if (idx !== undefined) return idx;
    usedOther = true;
    return otherIdx;
  });
  const legend = top.map((k, i) => ({ label: k, color: ATLAS_PALETTE[i] }));
  if (usedOther) legend.push({ label: 'Other', color: ATLAS_OTHER_COLOR });
  return { categoryIndex, palette: [...ATLAS_PALETTE, ATLAS_OTHER_COLOR], legend };
}

// Floor for the cos(angle) divisor below: keeps far-off-axis points reachable
// (worst-case 4x distance penalty) instead of unreachable, so a lone point at
// 80 degrees off the arrow is still preferred over nothing. Raise towards 1 to
// demand tighter alignment; lower towards 0 to tolerate more sideways drift.
const ANGULAR_TOLERANCE = 0.25;

/**
 * Pick the point the keyboard cursor moves to for an arrow-key press.
 *
 * Scores each candidate by distance / max(cos(angle), tolerance), where angle
 * is the deviation from the arrow direction. Plain nearest-in-half-plane
 * "drifts": pressing right could select a near point at 89 degrees off-axis.
 * Dividing by cos makes off-axis points look proportionally farther away.
 *
 * @param {Array<Array<number>>} pts - drawn points, [x, y, ...] in [-1, 1]
 * @param {number} fromIdx - index of the point the cursor is on
 * @param {[number, number]} dir - unit arrow direction in GL space (y up)
 * @returns {number} index of the next point, or -1 to stay put
 */
export function pickNextPointInDirection(pts, fromIdx, dir) {
  const [fx, fy] = pts[fromIdx];
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < pts.length; i++) {
    if (i === fromIdx) continue;
    const dx = pts[i][0] - fx;
    const dy = pts[i][1] - fy;
    const along = dx * dir[0] + dy * dir[1];
    // Keep candidates in the half-plane of the arrow direction only.
    if (along <= 0) continue;
    const dist = Math.hypot(dx, dy);
    const cosAngle = along / dist;
    const score = dist / Math.max(cosAngle, ANGULAR_TOLERANCE);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/**
 * Must stay ≤ `LIMITS.MAX_TOP_K`. The embeddings:search Zod schema rejects
 * anything larger; Atlas used to send 200, which the banner rendered as
 * "[object Object]" because the handler returns `{ code, message }`.
 */
export const ATLAS_SEARCH_TOP_K = LIMITS.MAX_TOP_K;

/**
 * Format an IPC failure for Atlas banners. Accepts a full envelope
 * `{ success, error }`, the `error` field itself, an Error, or a string.
 *
 * @param {any} value
 * @param {string} [context]
 * @returns {string}
 */
export function atlasIpcFailureMessage(value, context = 'Atlas') {
  if (value == null) return `${context} failed`;
  if (typeof value === 'string') return value || `${context} failed`;
  if (value instanceof Error) return value.message || `${context} failed`;
  const inner = value && typeof value === 'object' && value.error != null ? value.error : value;
  if (typeof inner === 'string') return inner || `${context} failed`;
  if (inner && typeof inner === 'object') {
    if (typeof inner.message === 'string' && inner.message) return inner.message;
    if (typeof inner.code === 'string' && inner.code) return inner.code;
  }
  return `${context} failed`;
}
