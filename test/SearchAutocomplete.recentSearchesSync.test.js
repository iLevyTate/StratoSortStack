/**
 * @jest-environment jsdom
 */

// SearchAutocomplete used to load recent searches once on mount. Searches
// recorded afterwards (useSearchTab calls addToRecentSearches) never showed in
// its dropdown, and removing one entry wrote the stale mount-time list back,
// erasing every search made since the component mounted.

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import SearchAutocomplete, {
  addToRecentSearches,
  clearRecentSearches
} from '../src/renderer/components/search/SearchAutocomplete';

const KEY = 'stratosort-recent-searches';
const stored = () => JSON.parse(window.localStorage.getItem(KEY) || '[]');

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
  window.electronAPI = { embeddings: { search: jest.fn() } };
});

beforeEach(() => {
  window.localStorage.clear();
});

describe('SearchAutocomplete recent searches stay in sync with storage', () => {
  test('removing an old entry keeps searches recorded after mount', () => {
    window.localStorage.setItem(KEY, JSON.stringify(['taxes', 'budget']));
    render(<SearchAutocomplete value="" onChange={jest.fn()} />);

    act(() => {
      addToRecentSearches('invoice');
      addToRecentSearches('receipts');
    });

    fireEvent.click(screen.getByRole('combobox'));
    const taxesRow = screen.getByText('taxes').closest('[role="option"]');
    const removeButton = taxesRow.querySelector('[aria-label="Remove from history"]');
    fireEvent.click(removeButton);

    expect(stored()).toEqual(['receipts', 'invoice', 'budget']);
  });

  test('the dropdown shows searches recorded after mount', () => {
    window.localStorage.setItem(KEY, JSON.stringify(['taxes']));
    render(<SearchAutocomplete value="" onChange={jest.fn()} />);

    act(() => {
      addToRecentSearches('invoice');
    });
    fireEvent.click(screen.getByRole('combobox'));

    expect(screen.getByText('invoice')).toBeInTheDocument();
    expect(screen.getByText('taxes')).toBeInTheDocument();
  });

  test('clearing history elsewhere empties the dropdown', () => {
    window.localStorage.setItem(KEY, JSON.stringify(['taxes']));
    render(<SearchAutocomplete value="" onChange={jest.fn()} />);

    act(() => {
      clearRecentSearches();
    });
    fireEvent.click(screen.getByRole('combobox'));

    expect(screen.queryByText('taxes')).not.toBeInTheDocument();
  });
});
