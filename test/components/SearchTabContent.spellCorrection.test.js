/**
 * @jest-environment jsdom
 *
 * When search corrected the query's spelling, the notice offers a way to
 * search for exactly what was typed (and back again).
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

jest.mock('../../src/shared/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })
}));

jest.mock('../../src/renderer/store/hooks', () => ({
  useAppSelector: jest.fn(() => false),
  useAppDispatch: jest.fn(() => jest.fn())
}));

// Presentation-only children not under test.
jest.mock('../../src/renderer/components/search/SearchAutocomplete', () => ({
  __esModule: true,
  default: () => null,
  addToRecentSearches: jest.fn()
}));
jest.mock('../../src/renderer/components/search/ResultRow', () => ({
  __esModule: true,
  default: ({ result }) => <div>{result.metadata.name}</div>
}));
jest.mock('../../src/renderer/components/search/EmptySearchState', () => ({
  __esModule: true,
  default: () => null
}));

import SearchTabContent from '../../src/renderer/components/search/SearchTabContent';

const result = { id: 'r1', metadata: { name: 'beach.jpg', path: '/p/beach.jpg' }, score: 0.9 };

function renderTab(searchOverrides = {}) {
  const search = {
    query: 'vacaton photos',
    setQuery: jest.fn(),
    debouncedQuery: 'vacaton photos',
    searchResults: [result],
    selectedSearchId: 'r1',
    isSearching: false,
    queryMeta: {
      original: 'vacaton photos',
      corrected: 'vacation photos',
      corrections: [{ original: 'vacaton', corrected: 'vacation' }]
    },
    searchMeta: null,
    exactSearch: null,
    searchExactly: jest.fn(),
    searchWithCorrection: jest.fn(),
    bulkSelectedIds: new Set(),
    focusedResultIndex: -1,
    viewMode: 'all',
    setViewMode: jest.fn(),
    selectedSearchResult: result,
    selectedSearchResultPath: '/p/beach.jpg',
    selectedSearchResultName: 'beach.jpg',
    searchStatusLabel: '1 result',
    groupedResults: {},
    resultIdToIndex: new Map([['r1', 0]]),
    ...searchOverrides
  };
  render(
    <SearchTabContent
      search={search}
      stats={{ files: 1 }}
      error=""
      setActiveTab={jest.fn()}
      handleChatSend={jest.fn()}
      resultListRef={{ current: null }}
    />
  );
  return search;
}

describe('SearchTabContent spelling correction notice', () => {
  test('offers to search for exactly what was typed', () => {
    const search = renderTab();

    expect(screen.getByText(/Showing results for/)).toHaveTextContent(
      'Showing results for vacation photos.'
    );
    const button = screen.getByRole('button', { name: 'Search for vacaton photos instead' });
    expect(button).toHaveTextContent('vacaton photos');

    fireEvent.click(button);
    expect(search.searchExactly).toHaveBeenCalledTimes(1);
  });

  test('after an exact search, offers the corrected query back', () => {
    const search = renderTab({
      queryMeta: { original: 'vacaton photos', corrected: 'vacaton photos', corrections: [] },
      exactSearch: { query: 'vacaton photos', corrected: 'vacation photos' }
    });

    expect(screen.getByText(/Showing results for/)).toHaveTextContent(
      'Showing results for vacaton photos as typed.'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Search for vacation photos instead' }));
    expect(search.searchWithCorrection).toHaveBeenCalledTimes(1);
  });

  test('shows no notice when nothing was corrected', () => {
    renderTab({ queryMeta: { original: 'beach', corrected: 'beach', corrections: [] } });
    expect(screen.queryByText(/Showing results for/)).toBeNull();
  });
});
