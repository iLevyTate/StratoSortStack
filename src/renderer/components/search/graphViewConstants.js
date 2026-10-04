// @ts-check
/**
 * Graph view constants + minimap helpers for the Unified Search modal's
 * graph tab. Extracted so GraphTabContent and useGraphTab can import them
 * without a circular dependency on the modal shell.
 */
import { NODE_TYPES, EDGE_TYPES } from './graphTypes';

export const GRAPH_VIEW_NODE_TYPES = NODE_TYPES;
export const GRAPH_VIEW_EDGE_TYPES = EDGE_TYPES;

export const GRAPH_SIDEBAR_CARD =
  'rounded-lg border border-border-soft bg-system-gray-100/90 p-3 shadow-sm';
export const GRAPH_SIDEBAR_SECTION_TITLE =
  'text-xs font-semibold text-system-gray-400 uppercase tracking-wider flex items-center gap-compact';

export const GRAPH_MINIMAP_STYLE = Object.freeze({
  width: 168,
  height: 104,
  borderRadius: 12,
  overflow: 'hidden',
  backgroundColor: 'var(--surface-panel-bg)',
  border: '1px solid color-mix(in srgb, var(--border-soft) 88%, transparent)',
  boxShadow: 'var(--shadow-soft)'
});
// The effective mask paint comes from the `.react-flow__minimap-mask` rules in
// the graph <style> block below (!important beats React Flow's inline values);
// these props are kept in sync with those rules.
export const GRAPH_MINIMAP_MASK_COLOR = 'color-mix(in srgb, var(--surface-muted) 78%, transparent)';
export const GRAPH_MINIMAP_MASK_STROKE_COLOR =
  'color-mix(in srgb, var(--color-stratosort-blue) 70%, transparent)';

// MiniMap node dots are painted as SVG fill values, which cannot resolve
// var() references — the theme tokens are resolved to concrete colors and
// re-read whenever the palette changes.
/** @type {Readonly<Record<string, string>>} */
const GRAPH_MINIMAP_TOKEN_FALLBACKS = Object.freeze({
  '--color-stratosort-indigo': '#1078a0',
  '--color-stratosort-danger': '#f87171',
  '--color-stratosort-warning': '#f0b030',
  '--color-system-gray-500': '#8d9fab',
  '--color-stratosort-blue': '#3ba0c0'
});

export function resolveGraphMiniMapPalette() {
  let rootStyles = null;
  try {
    rootStyles =
      typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
        ? window.getComputedStyle(document.documentElement)
        : null;
  } catch {
    rootStyles = null;
  }
  const read = (/** @type {string} */ token) => {
    const value = rootStyles?.getPropertyValue(token)?.trim();
    return value || GRAPH_MINIMAP_TOKEN_FALLBACKS[token];
  };
  return {
    query: read('--color-stratosort-indigo'),
    duplicateExact: read('--color-stratosort-danger'),
    duplicateNear: read('--color-stratosort-warning'),
    duplicateRelated: read('--color-system-gray-500'),
    cluster: read('--color-stratosort-warning'),
    file: read('--color-stratosort-blue')
  };
}

export function getGraphMiniMapNodeColor(/** @type {any} */ node, /** @type {any} */ palette) {
  if (node?.data?.kind === 'query') return palette.query;
  if (node?.data?.kind === 'duplicate') {
    // Tier-aware coloring: exact=danger (safe to delete), near=warning
    // (review), related=gray (caution, may be drafts).
    const tier = node.data?.duplicateTier;
    if (tier === 'exact') return palette.duplicateExact;
    if (tier === 'nearIdentical') return palette.duplicateNear;
    if (tier === 'related') return palette.duplicateRelated;
    return palette.duplicateNear;
  }
  if (node?.data?.kind === 'cluster') return palette.cluster;
  return palette.file;
}
