/**
 * @jest-environment jsdom
 *
 * Render-level guard that ReadyFileItem surfaces analysis.suggestedNewFolder.
 *
 * Pre-fix: documentLlm.js + imageAnalysis.js attached `suggestedNewFolder`
 * whenever the LLM identified a meaningful theme that didn't match any
 * smart folder (paired with the unmatched-category floor raised to 0.75).
 * No renderer component read the field, so files routed to "Uncategorized"
 * with no hint about WHY — most-cited regression after the 0.55 -> 0.75
 * folder match floor change.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore, createSlice } from '@reduxjs/toolkit';
import ReadyFileItem from '../../src/renderer/components/organize/ReadyFileItem';

function makeStore() {
  const ui = createSlice({
    name: 'ui',
    initialState: { settings: { redactPaths: false } },
    reducers: {}
  });
  return configureStore({
    reducer: {
      ui: ui.reducer
    }
  });
}

function renderItem(props) {
  const store = makeStore();
  return render(
    <Provider store={store}>
      <ReadyFileItem
        file={{
          path: '/x/labcorp-results.pdf',
          name: 'labcorp-results.pdf',
          size: 1024,
          analysis: props.analysis
        }}
        index={0}
        isSelected={false}
        onToggleSelected={() => {}}
        stateDisplay={{ icon: null, label: 'Ready', color: 'green', spinning: false }}
        smartFolders={props.smartFolders || []}
        editing={null}
        onEdit={() => {}}
        category={props.category}
        onCreateSuggestedFolder={props.onCreateSuggestedFolder}
      />
    </Provider>
  );
}

describe('ReadyFileItem suggestedNewFolder surfacing', () => {
  test('shows the AI suggestion chip with the suggested folder name', () => {
    renderItem({
      analysis: {
        suggestedName: 'labcorp-results',
        category: 'Uncategorized',
        suggestedNewFolder: 'Labcorp'
      },
      category: 'Uncategorized',
      smartFolders: [
        { id: 'unc', name: 'Uncategorized' },
        { id: 'finance', name: 'Finance' }
      ]
    });

    expect(screen.getByText(/AI suggests a new smart folder/i)).toBeInTheDocument();
    // Surrounding quote characters are smart quotes; match on substring only.
    expect(screen.getByText(/Labcorp/)).toBeInTheDocument();
    // Built-in catch-all is shown as an automatic fallback label, not as a
    // peer category named "Uncategorized".
    expect(screen.getByRole('combobox', { name: /Category/i })).toHaveTextContent(
      /Fallback — no folder match \(Uncategorized\)/i
    );
  });

  test('hides the chip when the suggested name already exists as a smart folder', () => {
    renderItem({
      analysis: {
        suggestedName: 'labcorp-results',
        category: 'Labcorp',
        suggestedNewFolder: 'Labcorp'
      },
      category: 'Labcorp',
      // Folder named "Labcorp" already exists — the suggestion is redundant.
      smartFolders: [
        { id: 'unc', name: 'Uncategorized' },
        { id: 'lab', name: 'Labcorp' }
      ]
    });

    expect(screen.queryByText(/AI suggests a new smart folder/i)).toBeNull();
  });

  test('hides the chip when the analysis has no suggestedNewFolder', () => {
    renderItem({
      analysis: { suggestedName: 'doc', category: 'Finance' },
      category: 'Finance',
      smartFolders: [{ id: 'fin', name: 'Finance' }]
    });

    expect(screen.queryByText(/AI suggests a new smart folder/i)).toBeNull();
  });

  test('renders without a Create button when no onCreateSuggestedFolder callback is wired', () => {
    renderItem({
      analysis: {
        suggestedName: 'labcorp-results',
        category: 'Uncategorized',
        suggestedNewFolder: 'Labcorp'
      },
      category: 'Uncategorized',
      smartFolders: []
    });

    expect(screen.getByText(/AI suggests a new smart folder/i)).toBeInTheDocument();
    // Hint chip stays informational when no handler is wired.
    expect(screen.queryByRole('button', { name: /Create smart folder named Labcorp/i })).toBeNull();
  });

  test('renders the Create button when onCreateSuggestedFolder is wired', () => {
    const onCreate = jest.fn();
    renderItem({
      analysis: {
        suggestedName: 'labcorp-results',
        category: 'Uncategorized',
        suggestedNewFolder: 'Labcorp'
      },
      category: 'Uncategorized',
      smartFolders: [],
      onCreateSuggestedFolder: onCreate
    });

    const btn = screen.getByRole('button', { name: /Create smart folder named Labcorp/i });
    expect(btn).toBeInTheDocument();
  });
});

describe('ReadyFileItem path-keyed selection and edits (SW-10 / SW-15)', () => {
  test('toggles and edits by canonical path, not array index', () => {
    const onToggleSelected = jest.fn();
    const onEdit = jest.fn();
    const store = makeStore();

    render(
      <Provider store={store}>
        <ReadyFileItem
          file={{
            path: '/docs/invoice.pdf',
            name: 'invoice.pdf',
            size: 1024,
            analysis: { suggestedName: 'invoice', category: 'Finance' }
          }}
          index={7}
          isSelected={false}
          onToggleSelected={onToggleSelected}
          stateDisplay={{ icon: null, label: 'Ready', color: 'green', spinning: false }}
          smartFolders={[]}
          editing={null}
          onEdit={onEdit}
          category="Finance"
        />
      </Provider>
    );

    fireEvent.click(screen.getByRole('checkbox'));
    expect(onToggleSelected).toHaveBeenCalledWith('/docs/invoice.pdf');
    expect(onToggleSelected).not.toHaveBeenCalledWith(7);

    fireEvent.change(screen.getByDisplayValue('invoice'), { target: { value: 'renamed' } });
    expect(onEdit).toHaveBeenCalledWith('/docs/invoice.pdf', 'suggestedName', 'renamed');
  });
});
