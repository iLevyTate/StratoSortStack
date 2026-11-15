/**
 * @jest-environment jsdom
 *
 * D1: the Organize card shows where the file goes and why. Engine-ranked
 * folders come first in the list, a one-line note says why, and the
 * confidence shown is the engine's routing confidence rather than the
 * LLM's confidence in its own label.
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore, createSlice } from '@reduxjs/toolkit';
import ReadyFileItem from '../../src/renderer/components/organize/ReadyFileItem';

const FOLDERS = [
  { id: 'arc', name: 'Archive', path: '/L/Archive' },
  { id: 'fin', name: 'Finance', path: '/L/Finance' },
  { id: 'tax', name: 'Taxes', path: '/L/Taxes' }
];

const ENGINE = {
  folder: 'Finance',
  path: '/L/Finance',
  folderId: 'fin',
  confidence: 0.64,
  source: 'semantic',
  explanation: 'This file\'s meaning matches "Finance"',
  alternatives: [{ folder: 'Taxes', path: '/L/Taxes', folderId: 'tax', confidence: 0.4 }]
};

function renderItem({ routing, category = 'Finance', analysis = {} }) {
  const ui = createSlice({
    name: 'ui',
    initialState: { settings: { redactPaths: false } },
    reducers: {}
  });
  const store = configureStore({ reducer: { ui: ui.reducer } });
  return render(
    <Provider store={store}>
      <ReadyFileItem
        file={{
          path: '/in/receipt.pdf',
          name: 'receipt.pdf',
          size: 2048,
          analysis: { suggestedName: 'receipt', category: 'Taxes', confidence: 95, ...analysis }
        }}
        index={0}
        isSelected={false}
        onToggleSelected={() => {}}
        stateDisplay={{ icon: null, label: 'Ready', color: 'green', spinning: false }}
        smartFolders={FOLDERS}
        editing={null}
        onEdit={() => {}}
        category={category}
        routing={routing}
      />
    </Provider>
  );
}

test('an engine placement shows its explanation and routing confidence', () => {
  renderItem({ routing: { folder: FOLDERS[1], source: 'engine', engine: ENGINE } });
  expect(screen.getByTestId('organize-routing-note')).toHaveTextContent(
    'This file\'s meaning matches "Finance"'
  );
  // 64% from the engine, not the label's 95%.
  expect(screen.getByText('64% confidence')).toBeInTheDocument();
  expect(screen.queryByText('95% confidence')).not.toBeInTheDocument();
});

test('ranked folders come first, the best match marked', () => {
  renderItem({ routing: { folder: FOLDERS[1], source: 'engine', engine: ENGINE } });
  fireEvent.click(screen.getByRole('combobox', { name: /Category/i }));
  const options = within(screen.getByRole('listbox')).getAllByRole('option');
  expect(options.map((o) => o.textContent)).toEqual(['Finance (best match)', 'Taxes', 'Archive']);
});

test('a user choice says so and names the suggestion it overrode', () => {
  renderItem({
    category: 'Taxes',
    routing: { folder: FOLDERS[2], source: 'user', engine: ENGINE }
  });
  expect(screen.getByTestId('organize-routing-note')).toHaveTextContent(
    'Your choice (suggested: Finance)'
  );
  // The label's 95% and the engine's 64% both rate other folders, not the
  // one the user picked: show no percentage.
  expect(screen.queryByText(/% confidence/)).not.toBeInTheDocument();
});

test('a name match says so and keeps the plain folder list', () => {
  renderItem({
    category: 'Taxes',
    routing: { folder: FOLDERS[2], source: 'name', engine: null }
  });
  expect(screen.getByTestId('organize-routing-note')).toHaveTextContent(
    'Matched by the label the analysis gave this file'
  );
  // The label's own confidence is not a match score: show none.
  expect(screen.queryByText(/% confidence/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('combobox', { name: /Category/i }));
  const options = within(screen.getByRole('listbox')).getAllByRole('option');
  expect(options.map((o) => o.textContent)).toEqual(['Archive', 'Finance', 'Taxes']);
});

describe('a file that needs review', () => {
  const UNCATEGORIZED = { id: 'unc', name: 'Uncategorized', path: '/L/Uncategorized' };
  const REVIEW_ENGINE = {
    folder: 'Uncategorized',
    path: '/L/Uncategorized',
    folderId: 'unc',
    confidence: 0.1,
    source: 'default',
    needsReview: true,
    reviewReason: 'weak_match',
    explanation: 'No Smart Folder matched this file well. The closest was "Finance".',
    alternatives: [
      { folder: 'Finance', path: '/L/Finance', folderId: 'fin', confidence: 0.45 },
      { folder: 'Taxes', path: '/L/Taxes', folderId: 'tax', confidence: 0.41 }
    ]
  };

  test('says so in plain words, with the reason and where it goes', () => {
    renderItem({
      category: 'Uncategorized',
      routing: { folder: UNCATEGORIZED, source: 'review', engine: REVIEW_ENGINE }
    });
    const note = screen.getByTestId('organize-needs-review');
    expect(note).toHaveTextContent('Needs review');
    expect(note).toHaveTextContent(
      'No Smart Folder matched this file well. The closest was "Finance".'
    );
    expect(note).toHaveTextContent('It goes to "Uncategorized" unless you pick a folder.');
    // The engine's 10% is not a match score: show none, and never the label's 95%.
    expect(screen.queryByText(/% confidence/)).not.toBeInTheDocument();
  });

  test('lists the closest folders first, none marked as the best match', () => {
    renderItem({
      category: 'Uncategorized',
      routing: { folder: UNCATEGORIZED, source: 'review', engine: REVIEW_ENGINE }
    });
    fireEvent.click(screen.getByRole('combobox', { name: /Category/i }));
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    const labels = options.map((o) => o.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Finance', 'Taxes', 'Archive']));
    expect(labels.some((label) => label.includes('best match'))).toBe(false);
    expect(labels.indexOf('Finance')).toBeLessThan(labels.indexOf('Archive'));
  });

  test('with no default folder it names where the file goes', () => {
    renderItem({
      category: 'Uncategorized',
      routing: {
        folder: null,
        source: 'review',
        engine: { ...REVIEW_ENGINE, folder: null, path: null, folderId: null }
      }
    });
    expect(screen.getByTestId('organize-needs-review')).toHaveTextContent(
      'It goes to "Uncategorized" unless you pick a folder.'
    );
  });

  test('once the user picks a folder it is their choice, with no suggestion named', () => {
    renderItem({
      category: 'Finance',
      routing: { folder: FOLDERS[1], source: 'user', engine: REVIEW_ENGINE }
    });
    expect(screen.queryByTestId('organize-needs-review')).not.toBeInTheDocument();
    expect(screen.getByTestId('organize-routing-note')).toHaveTextContent(/^Your choice$/);
  });
});

test('without routing (legacy callers) there is no note', () => {
  renderItem({ routing: null });
  expect(screen.queryByTestId('organize-routing-note')).not.toBeInTheDocument();
});
