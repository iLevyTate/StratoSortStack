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
  // Not an engine placement: the confidence falls back to the label's.
  expect(screen.getByText('95% confidence')).toBeInTheDocument();
});

test('a name match says so and keeps the plain folder list', () => {
  renderItem({
    category: 'Taxes',
    routing: { folder: FOLDERS[2], source: 'name', engine: null }
  });
  expect(screen.getByTestId('organize-routing-note')).toHaveTextContent('Matched by folder name');
  fireEvent.click(screen.getByRole('combobox', { name: /Category/i }));
  const options = within(screen.getByRole('listbox')).getAllByRole('option');
  expect(options.map((o) => o.textContent)).toEqual(['Archive', 'Finance', 'Taxes']);
});

test('without routing (legacy callers) there is no note', () => {
  renderItem({ routing: null });
  expect(screen.queryByTestId('organize-routing-note')).not.toBeInTheDocument();
});
