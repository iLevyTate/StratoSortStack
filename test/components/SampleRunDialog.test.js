/**
 * @jest-environment jsdom
 *
 * The sample-first dialog: the offer (sample or skip), the running sample
 * (stop only), and the review (where each file would go, with its score and
 * reason; continue or edit the folders).
 */
import React from 'react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import uiReducer from '../../src/renderer/store/slices/uiSlice';
import SampleRunDialog from '../../src/renderer/components/discover/SampleRunDialog';

const files = Array.from({ length: 25 }, (_, i) => ({
  path: `/Users/alex/Inbox/file-${i}.pdf`,
  name: `file-${i}.pdf`
}));
const picked = files.slice(0, 5);

function renderDialog(session, extra = {}) {
  const store = configureStore({
    reducer: {
      ui: uiReducer,
      // Path privacy loaded and off, so file names show as they are.
      system: () => ({ redactPaths: false, redactPathsLoaded: true })
    }
  });
  const handlers = {
    onSample: jest.fn(),
    onSkip: jest.fn(),
    onStop: jest.fn(),
    onContinue: jest.fn(),
    onEditFolders: jest.fn(),
    onClose: jest.fn()
  };
  render(
    <Provider store={store}>
      <SampleRunDialog session={session} {...handlers} {...extra} />
    </Provider>
  );
  return handlers;
}

describe('SampleRunDialog', () => {
  test('the offer: try a few files first, or analyze them all', () => {
    const handlers = renderDialog({
      id: 1,
      stage: 'offer',
      files,
      picked,
      hash: 'sf-1',
      hintCount: 2,
      rows: []
    });

    expect(screen.getByText('Try a few files first?')).toBeInTheDocument();
    expect(
      screen.getByText(
        '25 files are ready to analyze. Analyze 5 of them first to see where your Smart Folders send them. No files are moved.'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        '2 Smart Folders have a description hint in Setup. The sample shows whether it matters.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText('file-0.pdf')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Analyze 5 files first' }));
    expect(handlers.onSample).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze all 25 files' }));
    expect(handlers.onSkip).toHaveBeenCalledTimes(1);
  });

  test('no hint line when every folder description is clear', () => {
    renderDialog({ id: 1, stage: 'offer', files, picked, hash: 'sf-1', hintCount: 0, rows: [] });
    expect(screen.queryByText(/description hint/)).not.toBeInTheDocument();
  });

  test('while the sample runs, the only way out is Stop', () => {
    const handlers = renderDialog(
      { id: 1, stage: 'running', files, picked, hash: 'sf-1', hintCount: 0, rows: [] },
      { progress: { current: 2, total: 5 } }
    );
    expect(screen.getByText('Trying your Smart Folders')).toBeInTheDocument();
    expect(screen.getByText('2 of 5 done')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(handlers.onStop).toHaveBeenCalledTimes(1);
  });

  test('the review shows each file with its folder, score and reason', () => {
    const handlers = renderDialog({
      id: 1,
      stage: 'review',
      files,
      picked,
      hash: 'sf-1',
      hintCount: 0,
      rows: [
        {
          path: picked[0].path,
          name: 'file-0.pdf',
          analyzed: true,
          folder: 'Invoices',
          score: 0.82,
          reason: 'Reads like a supplier invoice'
        },
        {
          path: picked[1].path,
          name: 'file-1.pdf',
          analyzed: true,
          folder: null,
          score: null,
          reason: 'No Smart Folder fits this file.'
        },
        {
          path: picked[2].path,
          name: 'file-2.pdf',
          analyzed: false,
          folder: null,
          score: null,
          reason: 'This file could not be analyzed.'
        }
      ]
    });

    expect(screen.getByText('Where these files would go')).toBeInTheDocument();
    expect(screen.getByText('Invoices')).toBeInTheDocument();
    expect(screen.getByText('Strong match')).toBeInTheDocument();
    expect(screen.getByText('Reads like a supplier invoice')).toBeInTheDocument();
    expect(screen.getByText('Uncategorized')).toBeInTheDocument();
    expect(screen.getByText('Not analyzed')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Analyze the other 20 files' }));
    expect(handlers.onContinue).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Smart Folders' }));
    expect(handlers.onEditFolders).toHaveBeenCalledTimes(1);
  });
});
