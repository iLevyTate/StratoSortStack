// @ts-check
import { buildCategories } from './atlasMapUtils';

/** Alpha suffix appended to base hex colors for the dimmed (de-emphasized) palette half. */
export const DIM_ALPHA_HEX = '2e';

const MAX_UINT8_CATEGORIES = 255;

/**
 * Map the Atlas projection state to EmbeddingView inputs.
 * Emphasis workaround: EmbeddingView has no per-point opacity, so when an
 * emphasis set is active the palette is doubled — indices [0, n) are the
 * bright variants, [n, 2n) the dimmed ones — and de-emphasized points get
 * `category + n`. Falls back to no-emphasis if 2n would exceed Uint8 range.
 * Also preserves the [x, y, category, emphasized] tuples that
 * pickNextPointInDirection and the lasso/selection code consume.
 * @param {any} points - projection state ({ids, x, y, folderKeys, categoryKeys, tagKeys, kinds, clusterKeys?, count})
 * @param {string} colorMode - 'category' | 'topics' | 'folder' | 'tag' | 'kind'
 * @param {Set<string>|null} emphasisSet - ids to emphasize (null = no emphasis)
 */
export function buildEmbeddingData(points, colorMode, emphasisSet) {
  if (!points || !points.count) return null;
  const { categoryIndex, palette, legend } = buildCategories(points, colorMode);
  const n = points.count;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const category = new Uint8Array(n);
  const pts = new Array(n);

  const canEmphasize = Boolean(emphasisSet) && palette.length * 2 <= MAX_UINT8_CATEGORIES;
  const categoryColors = canEmphasize
    ? [...palette, ...palette.map((c) => `${c}${DIM_ALPHA_HEX}`)]
    : [...palette];

  for (let i = 0; i < n; i++) {
    x[i] = points.x[i];
    y[i] = points.y[i];
    const emphasized = !emphasisSet || emphasisSet.has(points.ids[i]) ? 1 : 0;
    const cat = categoryIndex[i];
    category[i] = canEmphasize && !emphasized ? cat + palette.length : cat;
    pts[i] = [points.x[i], points.y[i], category[i], emphasized];
  }
  return { x, y, category, categoryColors, legend, pts, hasEmphasis: canEmphasize };
}

/**
 * Nearest point to (px, py) within maxDist, else -1. Linear scan — fine for
 * the corpus sizes the Atlas pages in (<= tens of thousands per hover).
 * @param {number} px
 * @param {number} py
 * @param {Float32Array} x
 * @param {Float32Array} y
 * @param {number} maxDist
 */
export function nearestPointIndex(px, py, x, y, maxDist) {
  let best = -1;
  let bestSq = maxDist * maxDist;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i] - px;
    const dy = y[i] - py;
    const sq = dx * dx + dy * dy;
    if (sq <= bestSq) {
      bestSq = sq;
      best = i;
    }
  }
  return best;
}

/**
 * Indices of points inside a lasso: EmbeddingView's rangeSelection is either
 * a Rectangle ({xMin,yMin,xMax,yMax}) or a polygon ({x,y}[]). Rectangle gets
 * the fast path; polygons use even-odd ray casting.
 * @param {{xMin:number, yMin:number, xMax:number, yMax:number}|Array<{x:number,y:number}>|null} range
 * @param {Float32Array} x
 * @param {Float32Array} y
 * @returns {number[]}
 */
export function indicesInLasso(range, x, y) {
  if (!range) return [];
  const out = [];
  if (!Array.isArray(range)) {
    const { xMin, yMin, xMax, yMax } = range;
    if ([xMin, yMin, xMax, yMax].some((v) => typeof v !== 'number')) return [];
    for (let i = 0; i < x.length; i++) {
      if (x[i] >= xMin && x[i] <= xMax && y[i] >= yMin && y[i] <= yMax) out.push(i);
    }
    return out;
  }
  if (range.length < 3) return [];
  for (let i = 0; i < x.length; i++) {
    let inside = false;
    for (let a = 0, b = range.length - 1; a < range.length; b = a++) {
      const xi = range[a].x;
      const yi = range[a].y;
      const xj = range[b].x;
      const yj = range[b].y;
      const intersects =
        yi > y[i] !== yj > y[i] && x[i] < ((xj - xi) * (y[i] - yi)) / (yj - yi) + xi;
      if (intersects) inside = !inside;
    }
    if (inside) out.push(i);
  }
  return out;
}
