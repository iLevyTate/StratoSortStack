// @ts-check
/**
 * Graph filter default values for UnifiedSearchModal
 *
 * @module search/utils/graphFilterDefaults
 */

export const DEFAULT_CLUSTER_MODE = 'topic';

export const CLUSTER_MODE_CHIP_LABELS = Object.freeze({
  topic: 'semantic topic',
  time: 'recency',
  type: 'file type',
  tag: 'tag or folder'
});

export function getDefaultClusterFilters() {
  return {
    confidence: ['high', 'medium', 'low'],
    minSize: 1,
    fileType: 'all',
    search: ''
  };
}

export function getDefaultActiveFilters() {
  return {
    types: ['cluster', 'file', 'query', 'folder'],
    confidence: ['high', 'medium', 'low']
  };
}
