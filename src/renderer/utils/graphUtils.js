// @ts-check
/**
 * ReactFlow graph utilities for node positioning and identification
 */

/**
 * Generate a unique ID for a query node.
 *
 * @param {string} query - The search query text
 * @param {string|number} salt - A unique salt value (e.g., timestamp)
 * @returns {string} Unique node ID
 */
export function makeQueryNodeId(query, salt) {
  const short = String(query || '')
    .trim()
    .slice(0, 64)
    .replace(/\s+/g, '_');
  return `query:${short}:${salt}`;
}

/**
 * Calculate default node position in a grid layout.
 *
 * @param {number} index - Node index in the list
 * @returns {{x: number, y: number}} Position coordinates
 */
export function defaultNodePosition(index) {
  const spacingX = 260;
  const spacingY = 90;
  const col = index % 3;
  const row = Math.floor(index / 3);
  return { x: 80 + col * spacingX, y: 80 + row * spacingY };
}

/**
 * Single 0–1 strength for ranking connections (file graph + cluster overlay).
 * Prefer explicit similarity/score; normalize knowledge `weight` (0–10 scale) to 0–1.
 *
 * @param {any} data - ReactFlow edge `data`
 * @returns {number}
 */
export function edgeStrengthScore(data) {
  if (!data || typeof data !== 'object') return 0;
  if (typeof data.similarity === 'number' && Number.isFinite(data.similarity)) {
    return Math.max(0, Math.min(1, data.similarity));
  }
  if (typeof data.score === 'number' && Number.isFinite(data.score)) {
    return Math.max(0, Math.min(1, data.score));
  }
  if (typeof data.weight === 'number' && Number.isFinite(data.weight)) {
    return Math.max(0, Math.min(1, data.weight / 10));
  }
  return 0;
}

/**
 * Plain-English summary of why two graph nodes are connected. Takes the
 * EdgeAggregator `reasons[]` and returns a one-sentence `headline` for
 * first-time users plus a `details[]` array with the same technical
 * strings power users were already seeing. Deterministic — no LLM call.
 *
 * Headline priority:
 *   1. shared_concepts with concepts → "Both mention X[, Y, and Z]"
 *   2. centroid_bridge → "Connects your <source> and <target> work"
 *   3. content_similarity ≥ 0.85 → "Nearly identical content"
 *   4. content_similarity ≥ 0.55 → "Similar content (N% match)"
 *   5. fallback → "Loosely related"
 *
 * @param {any[]} reasons - EdgeAggregator reasons array
 * @param {{ sourceLabel?: string, targetLabel?: string, bridgeCount?: number }} [opts]
 * @returns {{ headline: string, details: string[] }}
 */
export function summarizeConnectionReasons(reasons, opts = {}) {
  const list = Array.isArray(reasons) ? reasons.filter(Boolean) : [];
  const sourceLabel = typeof opts.sourceLabel === 'string' ? opts.sourceLabel.trim() : '';
  const targetLabel = typeof opts.targetLabel === 'string' ? opts.targetLabel.trim() : '';
  const bridgeCount = Math.max(0, Math.floor(Number(opts.bridgeCount) || 0));

  const sharedConcepts = list.find((r) => r?.kind === 'shared_concepts');
  const centroidBridge = list.find((r) => r?.kind === 'centroid_bridge');
  const contentSim = list.find((r) => r?.kind === 'content_similarity');

  const details = list.map((r) => {
    switch (r?.kind) {
      case 'shared_concepts': {
        const cs = Array.isArray(r.concepts) ? r.concepts.filter(Boolean) : [];
        return cs.length > 0 ? `Shared concepts: ${cs.slice(0, 4).join(', ')}` : 'Shared concepts';
      }
      case 'content_similarity': {
        const pct = Math.round((Number(r.similarity) || 0) * 100);
        return `${pct}% similar content`;
      }
      case 'centroid_bridge': {
        const terms = Array.isArray(r.sharedTerms) ? r.sharedTerms.filter(Boolean) : [];
        const clusters = Array.isArray(r.clusters) ? r.clusters.filter(Boolean) : [];
        if (terms.length > 0) return `Bridges clusters via: ${terms.slice(0, 3).join(', ')}`;
        if (clusters.length === 2) return `Bridges clusters: ${clusters.join(' ↔ ')}`;
        return 'Bridges two topic clusters';
      }
      default:
        return typeof r?.kind === 'string' ? r.kind : 'Related';
    }
  });

  const formatList = (/** @type {any} */ items) => {
    if (items.length === 0) return '';
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
  };

  let headline = 'Loosely related';

  if (sharedConcepts) {
    const cs = Array.isArray(sharedConcepts.concepts)
      ? sharedConcepts.concepts.filter(Boolean).slice(0, 3)
      : [];
    if (cs.length > 0) {
      headline = `Both mention ${formatList(cs)}`;
    } else {
      headline = 'Share common concepts';
    }
  } else if (centroidBridge) {
    if (bridgeCount > 0) {
      const fileWord = bridgeCount === 1 ? 'file' : 'files';
      headline =
        sourceLabel && targetLabel
          ? `${bridgeCount} ${fileWord} link ${sourceLabel} and ${targetLabel}`
          : `${bridgeCount} ${fileWord} belong to both topic groups`;
    } else if (sourceLabel && targetLabel) {
      headline = `${sourceLabel} and ${targetLabel} overlap by topic`;
    } else {
      const terms = Array.isArray(centroidBridge.sharedTerms)
        ? centroidBridge.sharedTerms.filter(Boolean).slice(0, 2)
        : [];
      headline =
        terms.length > 0
          ? `Related topics share ${formatList(terms)}`
          : 'Two topic groups are related';
    }
  } else if (contentSim) {
    const pct = Math.round((Number(contentSim.similarity) || 0) * 100);
    if (pct >= 85) {
      headline = 'Nearly identical content';
    } else if (pct >= 55) {
      headline = `Similar content (${pct}% match)`;
    } else if (pct > 0) {
      headline = `Loosely similar content (${pct}%)`;
    }
  }

  if (bridgeCount > 0 && centroidBridge) {
    const fileWord = bridgeCount === 1 ? 'file' : 'files';
    details.unshift(`${bridgeCount} linking ${fileWord} across both groups`);
  }

  return { headline, details };
}
