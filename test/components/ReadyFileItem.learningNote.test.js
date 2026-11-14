/**
 * @jest-environment jsdom
 *
 * A tester could not tell whether changing a folder teaches StratoSort anything,
 * and every card showed the same 60%. A user's change says what it teaches;
 * a score is shown only when it measures how well the folder matches.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore, createSlice } from '@reduxjs/toolkit';
import ReadyFileItem from '../../src/renderer/components/organize/ReadyFileItem';

const FOLDERS = [
  { id: 'gsc', name: 'GSC', path: '/L/GSC' },
  { id: 'bing', name: 'Bing', path: '/L/Bing' },
  { id: 'u', name: 'Uncategorized', path: '/L/Uncategorized', isDefault: true }
];

const ENGINE = {
  folder: 'Bing',
  path: '/L/Bing',
  folderId: 'bing',
  confidence: 0.62,
  source: 'semantic',
  explanation: 'This file\'s meaning matches "Bing"',
  alternatives: []
};

function renderItem({ routing, name = 'queries.csv', category = 'Bing' }) {
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
          path: `/in/${name}`,
          name,
          size: 2048,
          analysis: { suggestedName: 'queries', category: 'Bing', confidence: 60 }
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

describe('what a folder change teaches', () => {
  test('changing the suggested folder says StratoSort learns it after a few files', () => {
    renderItem({
      category: 'GSC',
      routing: { folder: FOLDERS[0], source: 'user', engine: ENGINE }
    });
    const note = screen.getByTestId('organize-learning-note');
    expect(note).toHaveTextContent('Once a few similar CSV files go to GSC');
    expect(note).toHaveTextContent('it suggests GSC for them too');
  });

  test('a file without an extension gets the same note without a type', () => {
    renderItem({
      name: 'README',
      category: 'GSC',
      routing: { folder: FOLDERS[0], source: 'user', engine: ENGINE }
    });
    expect(screen.getByTestId('organize-learning-note')).toHaveTextContent(
      'Once a few similar files go to GSC'
    );
  });

  test('no note when the engine placed the file', () => {
    renderItem({ routing: { folder: FOLDERS[1], source: 'engine', engine: ENGINE } });
    expect(screen.queryByTestId('organize-learning-note')).not.toBeInTheDocument();
  });

  test('no note when the user picked the suggested folder', () => {
    renderItem({ routing: { folder: FOLDERS[1], source: 'user', engine: ENGINE } });
    expect(screen.queryByTestId('organize-learning-note')).not.toBeInTheDocument();
  });
});

describe('the score on the card', () => {
  test('a folder matched by the label shows no score', () => {
    renderItem({ routing: { folder: FOLDERS[1], source: 'name', engine: null } });
    expect(screen.getByTestId('organize-routing-note')).toHaveTextContent(
      'Matched by the label the analysis gave this file'
    );
    expect(screen.queryByText(/% confidence/)).not.toBeInTheDocument();
  });

  test('the catch-all fallback shows no score', () => {
    const fallback = {
      folder: 'Uncategorized',
      path: '/L/Uncategorized',
      folderId: 'u',
      confidence: 0.1,
      source: 'default',
      explanation: 'No Smart Folder matched what this file contains',
      alternatives: []
    };
    renderItem({
      category: 'Uncategorized',
      routing: { folder: FOLDERS[2], source: 'engine', engine: fallback }
    });
    expect(screen.queryByText(/% confidence/)).not.toBeInTheDocument();
  });

  test('a folder the user picked shows no score', () => {
    // The label's 60% rates the label, not the folder the user chose.
    renderItem({
      category: 'GSC',
      routing: { folder: FOLDERS[0], source: 'user', engine: ENGINE }
    });
    expect(screen.getByTestId('organize-routing-note')).toHaveTextContent('Your choice');
    expect(screen.queryByText(/% confidence/)).not.toBeInTheDocument();
  });

  test('a content match still shows its score', () => {
    renderItem({ routing: { folder: FOLDERS[1], source: 'engine', engine: ENGINE } });
    expect(screen.getByText('62% confidence')).toBeInTheDocument();
  });
});
