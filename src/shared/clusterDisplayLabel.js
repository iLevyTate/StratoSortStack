// @ts-check
/**
 * Human-readable cluster labels for graph UI and organize flows.
 * Replaces opaque "Cluster 3" names with topic hints from metadata when possible.
 */

const GENERIC_CLUSTER_LABEL = /^cluster\s*#?\s*\d+$/i;

/**
 * @param {string|null|undefined} label
 * @returns {boolean}
 */
export function isGenericClusterLabel(label) {
  if (label == null) return true;
  const trimmed = String(label).trim();
  if (!trimmed) return true;
  if (GENERIC_CLUSTER_LABEL.test(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  return lower === 'untitled topic' || lower === 'cluster' || lower === 'cluster folder';
}

/**
 * @param {string} term
 * @returns {string}
 */
function formatTermForLabel(term) {
  const s = String(term || '').trim();
  if (!s) return '';
  if (s.length <= 3 && /^[a-z0-9]+$/i.test(s)) return s.toUpperCase();
  if (/^[a-z0-9]+$/i.test(s) && s === s.toLowerCase()) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  return s;
}

/**
 * @param {string[]} terms
 * @param {number} maxTerms
 * @returns {string}
 */
function labelFromTerms(terms, maxTerms = 3) {
  const formatted = (Array.isArray(terms) ? terms : [])
    .map(formatTermForLabel)
    .filter(Boolean)
    .slice(0, Math.max(1, maxTerms));
  if (formatted.length === 0) return '';
  if (formatted.length === 1) return formatted[0];
  if (formatted.length === 2) return `${formatted[0]} & ${formatted[1]}`;
  return `${formatted.slice(0, -1).join(', ')} & ${formatted[formatted.length - 1]}`;
}

/**
 * Resolve a display label for a cluster node or graph cluster payload.
 *
 * @param {any} cluster
 * @param {{ maxTerms?: number, preferStoredLabel?: boolean }} [options]
 * @returns {string}
 */
export function deriveClusterDisplayLabel(cluster, options = {}) {
  const { maxTerms = 3, preferStoredLabel = true } = options;
  const stored = cluster?.label != null ? String(cluster.label).trim() : '';

  if (preferStoredLabel && stored && !isGenericClusterLabel(stored)) {
    return stored;
  }

  const topTerms = Array.isArray(cluster?.topTerms)
    ? cluster.topTerms.filter((/** @type {any} */ t) => t != null && String(t).trim())
    : [];
  const commonTags = Array.isArray(cluster?.commonTags)
    ? cluster.commonTags.filter((/** @type {any} */ t) => t != null && String(t).trim())
    : [];
  const terms = topTerms.length > 0 ? topTerms : commonTags;
  const fromTerms = labelFromTerms(terms, maxTerms);
  if (fromTerms) return fromTerms;

  const dominantCategory = cluster?.dominantCategory ? String(cluster.dominantCategory).trim() : '';
  if (dominantCategory && !isGenericClusterLabel(dominantCategory)) {
    return dominantCategory;
  }

  const fileCategoryLabel = cluster?.dominantFileCategoryLabel
    ? String(cluster.dominantFileCategoryLabel).trim()
    : '';
  if (fileCategoryLabel) {
    const count = Number(cluster?.memberCount) || 0;
    if (count > 0) return `${fileCategoryLabel} (${count} files)`;
    return `${fileCategoryLabel} files`;
  }

  const folder = cluster?.dominantFolderName ? String(cluster.dominantFolderName).trim() : '';
  if (folder) return folder;

  if (stored && !isGenericClusterLabel(stored)) return stored;

  const numericId =
    typeof cluster?.clusterId === 'number'
      ? cluster.clusterId
      : typeof cluster?.id === 'number'
        ? cluster.id
        : null;
  if (numericId != null && Number.isFinite(numericId)) {
    return `Topic group ${numericId + 1}`;
  }

  return 'Similar files';
}
