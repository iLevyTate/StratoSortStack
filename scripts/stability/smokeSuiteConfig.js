/**
 * Fixed smoke suite for release-stability comparisons.
 *
 * Each journey maps to a deterministic set of Jest tests that represent
 * critical user paths. The same list is used for baseline and target refs.
 */

const SMOKE_JOURNEYS = [
  {
    id: 'discover-import-analyze',
    label: 'Discover / Import / Analyze',
    tests: ['test/analysis-ipc-handlers.test.js', 'test/analysisSlice.test.js'],
    required: true
  },
  {
    id: 'organize-uncategorized-fallback',
    label: 'Organize / Uncategorized fallback',
    tests: [
      'test/useOrganization.test.js',
      'test/batchOrganizeHandler.test.js',
      'test/OrganizationSuggestionServiceCore.migration.test.js'
    ],
    required: true
  },
  {
    id: 'semantic-search-graph',
    label: 'Semantic search / graph',
    tests: ['test/semanticIpc.search.test.js', 'test/components/UnifiedSearchModal.test.js'],
    required: true
  }
];

module.exports = {
  SMOKE_JOURNEYS
};
