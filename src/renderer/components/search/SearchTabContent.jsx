/**
 * Search tab content for the Unified Search modal (§I Phase 6).
 * Presentation only — state/handlers arrive via the  prop
 * (useSearchTab's surface) plus modal-owned extras.
 */
import React from 'react';
import PropTypes from 'prop-types';
import {
  Copy,
  ExternalLink,
  FileText,
  FolderInput,
  FolderOpen,
  LayoutGrid,
  List,
  MessageSquare,
  Network,
  RefreshCw,
  Sparkles
} from 'lucide-react';
import { Button } from '../ui';
import { Heading, Text } from '../ui/Typography';
import { useAppSelector } from '../../store/hooks';
import { selectRedactPaths } from '../../store/selectors';
import { formatDisplayPath } from '../../utils/pathDisplay';
import { UI_VIRTUALIZATION } from '../../../shared/constants';
import EmptySearchState from './EmptySearchState';
import ResultRow from './ResultRow';
import SearchAutocomplete from './SearchAutocomplete';
import SearchDiagnosticsBanner from './SearchDiagnosticsBanner';
import SearchModeBanner from './SearchModeBanner';
import VirtualizedSearchResults from './VirtualizedSearchResults';

// Cap rows per category in grouped view (full counts still shown in header)
const GROUPED_VIEW_MAX_PER_CATEGORY = 50;

export default function SearchTabContent({
  search,
  stats,
  statsUnavailable,
  error,
  openFile,
  revealFile,
  copyPath,
  showEmptyBanner,
  selectedDocumentDetails,
  isLoadingDocumentDetails,
  convertSearchToGraph,
  moveSelectedToFolder,
  clearBulkSelection,
  toggleBulkSelection,
  handleResultSelect,
  resultListRef,
  embeddingConfig,
  rebuildFiles,
  handleChatSend,
  handleGoToDiscover,
  handleOpenSettings,
  setActiveTab,
  simpleMode,
  graphViewEnabled
}) {
  const redactPaths = useAppSelector(selectRedactPaths);
  const {
    query,
    setQuery,
    debouncedQuery,
    searchResults,
    selectedSearchId,
    isSearching,
    queryMeta,
    searchMeta,
    bulkSelectedIds,
    focusedResultIndex,
    viewMode,
    setViewMode,
    selectedSearchResult,
    selectedSearchResultPath,
    selectedSearchResultName,
    searchStatusLabel,
    groupedResults,
    resultIdToIndex
  } = search;

  return (
    <div className="flex flex-col gap-default flex-1">
      {/* Clean search input */}
      <div className="flex items-center gap-cozy">
        {/* eslint-disable jsx-a11y/no-autofocus -- deliberate initial focus per WAI-ARIA dialog pattern */}
        <SearchAutocomplete
          value={query}
          onChange={setQuery}
          onSearch={(q) => {
            setQuery(q);
          }}
          placeholder="Describe what you're looking for..."
          ariaLabel="Search query"
          className="flex-1"
          autoFocus
          disabled={statsUnavailable}
        />
        {/* eslint-enable jsx-a11y/no-autofocus */}
        {isSearching && (
          <Text
            as="div"
            variant="tiny"
            className="flex items-center gap-compact text-system-gray-400 shrink-0"
          >
            <RefreshCw className="h-4 w-4 animate-spin" />
            <span>Searching...</span>
          </Text>
        )}
      </div>

      {/* Search mode fallback banner */}
      <SearchModeBanner meta={searchMeta} />
      <SearchDiagnosticsBanner meta={searchMeta} />

      {/* Results header with view toggle */}
      {searchResults.length > 0 && (
        <div className="flex items-center justify-between">
          <Text as="span" variant="small" className="text-system-gray-500">
            {searchStatusLabel}
          </Text>
          <div className="flex items-center gap-compact">
            {/* View in Graph button */}
            {graphViewEnabled && (
              <Button
                variant="secondary"
                size="sm"
                onClick={convertSearchToGraph}
                title="Visualize search results as a graph"
                aria-label="View search results in graph"
              >
                <Network className="h-3.5 w-3.5" />
                <span>View in Graph</span>
              </Button>
            )}
            {/* Ask Assistant button */}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setActiveTab('chat');
                // If there is a query, ask about it
                if (debouncedQuery) {
                  handleChatSend(`Tell me about "${debouncedQuery}" based on these results`);
                }
              }}
              title="Ask AI assistant about these results"
              aria-label="Ask AI assistant about these results"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              <span>Ask AI</span>
            </Button>
            <div
              className="flex items-center gap-1 rounded-lg border border-border-soft bg-system-gray-100/90 p-0.5"
              role="group"
              aria-label="View mode"
            >
              <Button
                type="button"
                onClick={() => setViewMode('all')}
                aria-label="View all results"
                aria-pressed={viewMode === 'all'}
                variant={viewMode === 'all' ? 'secondary' : 'ghost'}
                size="xs"
                leftIcon={<List className="w-3.5 h-3.5" />}
                className={`rounded-md ${
                  viewMode === 'all'
                    ? 'bg-system-gray-100 text-system-gray-900 shadow-sm'
                    : 'text-system-gray-500 hover:bg-system-gray-100/80 hover:text-system-gray-700'
                }`}
              >
                All
              </Button>
              <Button
                type="button"
                onClick={() => setViewMode('grouped')}
                aria-label="Group results by type"
                aria-pressed={viewMode === 'grouped'}
                variant={viewMode === 'grouped' ? 'secondary' : 'ghost'}
                size="xs"
                leftIcon={<LayoutGrid className="w-3.5 h-3.5" />}
                className={`rounded-md ${
                  viewMode === 'grouped'
                    ? 'bg-system-gray-100 text-system-gray-900 shadow-sm'
                    : 'text-system-gray-500 hover:bg-system-gray-100/80 hover:text-system-gray-700'
                }`}
              >
                By Type
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk action bar - only shown when items are selected */}
      {bulkSelectedIds.size > 0 && (
        <div className="flex items-center gap-cozy p-2 bg-stratosort-blue/5 border border-stratosort-blue/20 rounded-lg">
          <span className="text-sm text-stratosort-blue">{bulkSelectedIds.size} selected</span>
          <Button
            variant="secondary"
            size="sm"
            onClick={moveSelectedToFolder}
            aria-label="Move selected to folder"
          >
            <FolderInput className="h-3.5 w-3.5" />
            <span>Move</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={clearBulkSelection}>
            Clear
          </Button>
        </div>
      )}

      {/* Query correction feedback - "Did you mean?" */}
      {queryMeta?.corrections?.length > 0 && searchResults.length > 0 && (
        <div className="flex items-center gap-compact px-3 py-2 bg-stratosort-accent/10 border border-stratosort-accent/30 rounded-lg text-sm">
          <Sparkles className="w-4 h-4 text-stratosort-accent shrink-0" />
          <span className="text-stratosort-accent">
            Showing results for{' '}
            <span className="font-medium">
              {queryMeta.corrections.map((c) => c.corrected).join(', ')}
            </span>{' '}
            instead of{' '}
            <span className="text-stratosort-accent line-through">
              {queryMeta.corrections.map((c) => c.original).join(', ')}
            </span>
          </span>
        </div>
      )}

      {/* Results grid */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-default flex-1">
        <div
          ref={resultListRef}
          className="flex flex-col gap-compact overflow-y-auto overflow-x-visible max-h-[60vh] px-1"
        >
          {searchResults.length === 0 && !error && !isSearching ? (
            <EmptySearchState
              query={debouncedQuery}
              hasIndexedFiles={stats?.files > 0 || showEmptyBanner}
              statsUnavailable={statsUnavailable}
              indexingHint={embeddingConfig}
              onOpenSettings={handleOpenSettings}
              onRebuildFiles={rebuildFiles}
              onSearchClick={setQuery}
              onGoToDiscover={handleGoToDiscover}
              corrections={queryMeta?.corrections}
              simpleMode={simpleMode}
            />
          ) : null}

          {/* Flat list view - virtualized when many results to avoid UI blocking */}
          {viewMode === 'all' &&
            (searchResults.length > UI_VIRTUALIZATION.THRESHOLD ? (
              <VirtualizedSearchResults
                results={searchResults}
                selectedSearchId={selectedSearchId}
                bulkSelectedIds={bulkSelectedIds}
                focusedResultIndex={focusedResultIndex}
                query={debouncedQuery}
                onSelect={handleResultSelect}
                onToggleBulk={toggleBulkSelection}
                onOpen={openFile}
                onReveal={revealFile}
                onCopyPath={copyPath}
                showGraphActions={graphViewEnabled}
              />
            ) : (
              searchResults.map((r, index) => (
                <ResultRow
                  key={r.id}
                  result={r}
                  isSelected={r.id === selectedSearchId}
                  isBulkSelected={bulkSelectedIds.has(r.id)}
                  isFocused={index === focusedResultIndex}
                  query={debouncedQuery}
                  index={index}
                  onSelect={handleResultSelect}
                  onToggleBulk={toggleBulkSelection}
                  onOpen={openFile}
                  onReveal={revealFile}
                  onCopyPath={copyPath}
                  showGraphActions={graphViewEnabled}
                />
              ))
            ))}

          {/* Grouped by type view */}
          {viewMode === 'grouped' &&
            Object.entries(groupedResults).map(([category, results]) => {
              const cappedResults =
                results.length > GROUPED_VIEW_MAX_PER_CATEGORY
                  ? results.slice(0, GROUPED_VIEW_MAX_PER_CATEGORY)
                  : results;
              const overflow = results.length - cappedResults.length;
              return (
                <div key={category} className="mb-4">
                  <div className="flex items-center gap-compact mb-2 sticky top-0 bg-system-gray-100 py-1 z-10">
                    <Text
                      as="h4"
                      variant="tiny"
                      className="font-semibold text-system-gray-500 uppercase tracking-wide"
                    >
                      {category}
                    </Text>
                    <Text
                      as="span"
                      variant="tiny"
                      className="text-system-gray-500 bg-system-gray-200 px-2 py-0.5 rounded-full text-xs font-medium"
                    >
                      {results.length}
                    </Text>
                  </div>
                  <div className="flex flex-col gap-compact">
                    {cappedResults.map((r) => {
                      const globalIndex = resultIdToIndex.get(r.id) ?? -1;
                      return (
                        <ResultRow
                          key={r.id}
                          result={r}
                          isSelected={r.id === selectedSearchId}
                          isBulkSelected={bulkSelectedIds.has(r.id)}
                          isFocused={globalIndex === focusedResultIndex}
                          query={debouncedQuery}
                          index={globalIndex >= 0 ? globalIndex : 0}
                          onSelect={handleResultSelect}
                          onToggleBulk={toggleBulkSelection}
                          onOpen={openFile}
                          onReveal={revealFile}
                          onCopyPath={copyPath}
                          showGraphActions={graphViewEnabled}
                        />
                      );
                    })}
                  </div>
                  {overflow > 0 ? (
                    <Text as="p" variant="tiny" className="text-system-gray-500 mt-2 pl-0.5">
                      {overflow} more result{overflow === 1 ? '' : 's'} in this group. Switch to
                      &ldquo;All&rdquo; view to see the full list.
                    </Text>
                  ) : null}
                </div>
              );
            })}
        </div>

        {/* Preview panel - clean and focused */}
        <div className="surface-panel p-4 min-h-[12rem] flex flex-col">
          {selectedSearchResult ? (
            <div className="flex flex-col gap-default flex-1">
              {/* File info header */}
              <div>
                <Heading as="h3" variant="h5" className="break-words">
                  {selectedSearchResultName}
                </Heading>
                <Text variant="tiny" className="text-system-gray-500 mt-1 break-all">
                  {formatDisplayPath(selectedSearchResultPath, {
                    redact: redactPaths,
                    segments: 2
                  })}
                </Text>
              </div>

              {/* Subject/summary - the main content */}
              {(() => {
                const subject =
                  selectedDocumentDetails?.analysis?.subject ||
                  selectedSearchResult?.metadata?.subject;
                const summary =
                  selectedDocumentDetails?.analysis?.summary ||
                  selectedSearchResult?.metadata?.summary;

                if (!subject && !summary) return null;

                return (
                  <div className="bg-system-gray-50 rounded-lg p-3">
                    {subject && (
                      <Text
                        variant="small"
                        className="font-medium text-system-gray-800 break-words"
                      >
                        {subject}
                      </Text>
                    )}
                    {summary && (
                      <Text variant="small" className="text-system-gray-600 mt-1 break-words">
                        {summary}
                      </Text>
                    )}
                  </div>
                );
              })()}

              {/* Tags - compact display */}
              {(() => {
                const tags =
                  selectedDocumentDetails?.analysis?.tags || selectedSearchResult?.metadata?.tags;
                if (!Array.isArray(tags) || tags.length === 0) return null;

                return (
                  <div className="flex flex-wrap gap-1.5">
                    {tags.slice(0, 6).map((tag, idx) => (
                      <Text
                        as="span"
                        variant="tiny"
                        key={`${tag}-${idx}`}
                        className="px-2 py-0.5 rounded-full bg-system-gray-100 text-system-gray-600 max-w-full break-words"
                      >
                        {tag}
                      </Text>
                    ))}
                    {tags.length > 6 && (
                      <Text as="span" variant="tiny" className="text-system-gray-400">
                        +{tags.length - 6} more
                      </Text>
                    )}
                  </div>
                );
              })()}

              {/* Document content preview */}
              {isLoadingDocumentDetails ? (
                <div className="flex-1 flex items-center justify-center p-4 animate-loading-fade">
                  <RefreshCw className="w-5 h-5 text-system-gray-300 animate-spin" />
                </div>
              ) : (
                (selectedDocumentDetails?.analysis?.extractedText ||
                  selectedSearchResult?.matchDetails?.bestSnippet ||
                  selectedSearchResult?.document) && (
                  <div className="flex-1 overflow-y-auto">
                    <Text
                      as="div"
                      variant="tiny"
                      className="uppercase text-system-gray-400 font-semibold mb-1 tracking-wider"
                    >
                      Content Preview
                    </Text>
                    <Text
                      variant="tiny"
                      className="text-system-gray-600 whitespace-pre-wrap leading-relaxed"
                    >
                      {String(
                        selectedDocumentDetails?.analysis?.extractedText ||
                          selectedSearchResult?.matchDetails?.bestSnippet ||
                          selectedSearchResult?.document
                      ).slice(0, 1000)}
                      {String(
                        selectedDocumentDetails?.analysis?.extractedText ||
                          selectedSearchResult?.matchDetails?.bestSnippet ||
                          selectedSearchResult?.document
                      ).length > 1000 && '...'}
                    </Text>
                  </div>
                )
              )}

              {/* Actions - prominent at bottom */}
              <div className="flex gap-compact pt-2 mt-auto border-t border-system-gray-100">
                <Button
                  variant="primary"
                  size="sm"
                  className="flex-1"
                  onClick={() => openFile(selectedSearchResultPath)}
                  disabled={!selectedSearchResultPath}
                >
                  <ExternalLink className="h-4 w-4" />
                  <span>Open file</span>
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => revealFile(selectedSearchResultPath)}
                  disabled={!selectedSearchResultPath}
                  title="Show containing folder"
                  aria-label="Show containing folder"
                  className="gap-1.5"
                >
                  <FolderOpen className="h-4 w-4" />
                  <span className="hidden md:inline">Folder</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => copyPath(selectedSearchResultPath)}
                  disabled={!selectedSearchResultPath}
                  aria-label="Copy file path"
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center">
              <FileText className="w-12 h-12 text-system-gray-200 mb-3" />
              <Text variant="small" className="text-system-gray-500">
                Select a file to preview
              </Text>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

SearchTabContent.propTypes = {
  search: PropTypes.object.isRequired,
  stats: PropTypes.object,
  statsUnavailable: PropTypes.bool,
  error: PropTypes.string,
  openFile: PropTypes.func,
  revealFile: PropTypes.func,
  copyPath: PropTypes.func,
  showEmptyBanner: PropTypes.bool,
  selectedDocumentDetails: PropTypes.object,
  isLoadingDocumentDetails: PropTypes.bool,
  convertSearchToGraph: PropTypes.func,
  moveSelectedToFolder: PropTypes.func,
  clearBulkSelection: PropTypes.func,
  toggleBulkSelection: PropTypes.func,
  handleResultSelect: PropTypes.func,
  resultListRef: PropTypes.object
};
