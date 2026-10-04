// @ts-check
/**
 * Regroup semantic clusters for graph "Group files by" presentation modes.
 *
 * Topic mode uses backend semantic clusters as-is. Time, type, and tag modes
 * flatten member files into new display buckets without recomputing embeddings.
 *
 * @module search/utils/clusterRegroupUtils
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Recency buckets ordered newest-first for display. */
export const RECENCY_BUCKETS = Object.freeze([
  { key: 'today', label: 'Today', maxAgeMs: 1 * MS_PER_DAY },
  { key: 'past-week', label: 'Past week', maxAgeMs: 7 * MS_PER_DAY },
  { key: 'past-month', label: 'Past month', maxAgeMs: 30 * MS_PER_DAY },
  { key: 'past-quarter', label: 'Past 3 months', maxAgeMs: 90 * MS_PER_DAY },
  { key: 'past-year', label: 'Past year', maxAgeMs: 365 * MS_PER_DAY },
  { key: 'older', label: 'Older', maxAgeMs: Infinity }
]);

/**
 * @param {number|null|undefined} timeMs
 * @returns {string}
 */
export function getRecencyBucketKey(timeMs) {
  if (!Number.isFinite(timeMs)) return 'unknown-date';
  const ageMs = Date.now() - timeMs;
  if (ageMs < 0) return RECENCY_BUCKETS[0].key;
  for (const bucket of RECENCY_BUCKETS) {
    if (ageMs <= bucket.maxAgeMs) return bucket.key;
  }
  return RECENCY_BUCKETS[RECENCY_BUCKETS.length - 1].key;
}

/**
 * @param {string} bucketKey
 * @returns {string}
 */
export function getRecencyBucketLabel(bucketKey) {
  if (bucketKey === 'unknown-date') return 'Unknown date';
  const match = RECENCY_BUCKETS.find((b) => b.key === bucketKey);
  return match?.label || 'Older';
}

/**
 * Collect per-file rows used for regrouping from semantic cluster payloads.
 *
 * @param {any[]} clusters
 * @returns {Array<{id: string, timeMs: number|null, fileCategory: string, fileCategoryLabel: string, folderName: string|null, primaryTag: string|null}>}
 */
export function flattenClusterMembers(clusters) {
  const members = [];
  const list = Array.isArray(clusters) ? clusters : [];

  for (const cluster of list) {
    if (Array.isArray(cluster.memberMeta) && cluster.memberMeta.length > 0) {
      for (const row of cluster.memberMeta) {
        if (row?.id) members.push(row);
      }
      continue;
    }

    const ids = Array.isArray(cluster.memberIds) ? cluster.memberIds : [];
    for (const id of ids) {
      if (!id) continue;
      members.push({
        id,
        timeMs: Number.isFinite(cluster.timeRange?.endMs) ? cluster.timeRange.endMs : null,
        fileCategory: cluster.dominantFileCategory || 'other',
        fileCategoryLabel: cluster.dominantFileCategoryLabel || 'Other',
        folderName: cluster.dominantFolderName || null,
        primaryTag: Array.isArray(cluster.commonTags) ? cluster.commonTags[0] || null : null
      });
    }
  }

  return members;
}

/**
 * @param {any} member
 * @param {'time'|'type'|'tag'} mode
 * @returns {string}
 */
function bucketKeyForMember(member, mode) {
  if (mode === 'time') return getRecencyBucketKey(member.timeMs);
  if (mode === 'type') {
    return (
      String(member.fileCategory || member.fileCategoryLabel || 'other')
        .trim()
        .toLowerCase() || 'other'
    );
  }
  const folder = String(member.folderName || '').trim();
  if (folder) return `folder:${folder.toLowerCase()}`;
  const tag = String(member.primaryTag || '').trim();
  if (tag) return `tag:${tag.toLowerCase()}`;
  return 'untagged';
}

/**
 * @param {string} bucketKey
 * @param {'time'|'type'|'tag'} mode
 * @param {any[]} bucketMembers
 * @returns {string}
 */
function labelForBucket(bucketKey, mode, bucketMembers) {
  if (mode === 'time') return getRecencyBucketLabel(bucketKey);

  if (mode === 'type') {
    const label = bucketMembers.find((m) => m.fileCategoryLabel)?.fileCategoryLabel;
    if (label) return String(label);
    return bucketKey.charAt(0).toUpperCase() + bucketKey.slice(1);
  }

  if (bucketKey === 'untagged') return 'No folder or tag';
  if (bucketKey.startsWith('folder:')) {
    const raw = bucketKey.slice('folder:'.length);
    return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : 'Folder';
  }
  if (bucketKey.startsWith('tag:')) {
    return bucketKey.slice('tag:'.length) || 'Tag';
  }
  return bucketKey;
}

/** @param {any[]} memberRows */
function buildTimeRange(memberRows) {
  const times = memberRows
    .map((/** @type {any} */ m) => m.timeMs)
    .filter((/** @type {any} */ ms) => Number.isFinite(ms));
  if (times.length === 0) return null;
  let startMs = times[0];
  let endMs = times[0];
  for (let i = 1; i < times.length; i++) {
    if (times[i] < startMs) startMs = times[i];
    if (times[i] > endMs) endMs = times[i];
  }
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    startMs,
    endMs
  };
}

/**
 * @param {any[]} clusters - Semantic clusters from the backend
 * @param {string} mode - topic | time | type | tag
 * @returns {Array<object>}
 */
export function regroupClustersForMode(clusters, mode) {
  if (!mode || mode === 'topic') {
    return Array.isArray(clusters) ? clusters : [];
  }
  if (mode !== 'time' && mode !== 'type' && mode !== 'tag') {
    return Array.isArray(clusters) ? clusters : [];
  }

  const members = flattenClusterMembers(clusters);
  if (members.length === 0) return Array.isArray(clusters) ? clusters : [];

  const buckets = new Map();
  for (const member of members) {
    const key = bucketKeyForMember(member, mode);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(member);
  }

  let entries = [...buckets.entries()];

  if (mode === 'time') {
    const order = new Map(RECENCY_BUCKETS.map((b, i) => [b.key, i]));
    order.set('unknown-date', RECENCY_BUCKETS.length);
    entries.sort((a, b) => (order.get(a[0]) ?? 999) - (order.get(b[0]) ?? 999));
  } else {
    entries.sort((a, b) =>
      labelForBucket(a[0], mode, a[1]).localeCompare(labelForBucket(b[0], mode, b[1]))
    );
  }

  return entries.map(([bucketKey, bucketMembers]) => {
    const memberIds = bucketMembers.map((/** @type {any} */ m) => m.id);
    const label = labelForBucket(bucketKey, mode, bucketMembers);
    const typeLabel =
      bucketMembers.find((/** @type {any} */ m) => m.fileCategoryLabel)?.fileCategoryLabel ||
      'Other';
    const folderName =
      bucketMembers.find((/** @type {any} */ m) => m.folderName)?.folderName || null;
    const tags = bucketMembers.map((/** @type {any} */ m) => m.primaryTag).filter(Boolean);

    return {
      id: `regroup:${mode}:${bucketKey}`,
      clusterId: bucketKey,
      label,
      memberCount: memberIds.length,
      memberIds,
      memberMeta: bucketMembers,
      confidence: 'medium',
      reason: `Regrouped by ${mode}`,
      dominantCategory: /** @type {any} */ (null),
      commonTags: [...new Set(tags)].slice(0, 10),
      topTerms: /** @type {any[]} */ ([]),
      dominantFileCategory: mode === 'type' ? bucketKey : bucketMembers[0]?.fileCategory || 'other',
      dominantFileCategoryLabel: mode === 'type' ? typeLabel : typeLabel,
      dominantFolderName: folderName,
      timeRange: mode === 'time' ? buildTimeRange(bucketMembers) : buildTimeRange(bucketMembers),
      isRegrouped: true
    };
  });
}
