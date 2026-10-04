/**
 * useOrganizeSuggestions (D1): Organize ranks destinations through the
 * suggestion engine, in chunks, without text generation, once per file.
 */

import { renderHook, act, waitFor } from '@testing-library/react';

jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

const {
  useOrganizeSuggestions,
  RANKING_OPTIONS,
  SUGGESTION_CHUNK_SIZE,
  toSuggestionFile
} = require('../src/renderer/phases/organize/useOrganizeSuggestions');

const FOLDERS = [{ id: 'fin', name: 'Finance', path: '/Library/Finance' }];

function makeFiles(count, prefix = 'doc') {
  return Array.from({ length: count }, (_, i) => ({
    path: `/in/${prefix}-${i}.pdf`,
    name: `${prefix}-${i}.pdf`,
    analysis: { category: 'Finance', extractedText: 'x'.repeat(1000) }
  }));
}

function respondFinance(files) {
  return {
    success: true,
    groups: [
      {
        folder: 'Finance',
        path: '/Library/Finance',
        files: files.map((f) => ({
          ...f,
          suggestion: {
            folder: 'Finance',
            path: '/Library/Finance',
            folderId: 'fin',
            isSmartFolder: true,
            source: 'semantic'
          },
          alternatives: [],
          confidence: 0.8,
          explanation: 'This file\'s meaning matches "Finance"'
        }))
      }
    ]
  };
}

let getBatchSuggestions;

beforeEach(() => {
  getBatchSuggestions = jest.fn(async (files) => respondFinance(files));
  global.window = global.window || {};
  global.window.electronAPI = { suggestions: { getBatchSuggestions } };
});

test('fetches in chunks with generation and improvement candidates off', async () => {
  const files = makeFiles(SUGGESTION_CHUNK_SIZE + 5);
  const { result } = renderHook(() => useOrganizeSuggestions(files, FOLDERS));

  await waitFor(() => expect(result.current.suggestionsByPath.size).toBe(files.length));
  expect(getBatchSuggestions).toHaveBeenCalledTimes(2);
  expect(getBatchSuggestions.mock.calls[0][0]).toHaveLength(SUGGESTION_CHUNK_SIZE);
  expect(getBatchSuggestions.mock.calls[1][0]).toHaveLength(5);
  for (const call of getBatchSuggestions.mock.calls) {
    expect(call[1]).toEqual({
      includeStructureAnalysis: false,
      skipGeneration: true,
      skipImprovementCandidates: true
    });
  }
  expect(RANKING_OPTIONS.skipGeneration).toBe(true);

  const entry = result.current.suggestionsByPath.get('/in/doc-0.pdf');
  expect(entry.folder).toBe('Finance');
  expect(entry.confidence).toBe(0.8);
  expect(entry.explanation).toMatch(/Finance/);
  await waitFor(() => expect(result.current.isRanking).toBe(false));
});

test('a new array of the same files does not refetch; a new file fetches only itself', async () => {
  const files = makeFiles(3);
  const { result, rerender } = renderHook(({ list }) => useOrganizeSuggestions(list, FOLDERS), {
    initialProps: { list: files }
  });
  await waitFor(() => expect(result.current.suggestionsByPath.size).toBe(3));
  expect(getBatchSuggestions).toHaveBeenCalledTimes(1);

  // Every Redux update hands the hook a fresh array; an edit changes analysis.
  rerender({
    list: files.map((f) => ({ ...f, analysis: { ...f.analysis, category: 'Taxes' } }))
  });
  await act(async () => {});
  expect(getBatchSuggestions).toHaveBeenCalledTimes(1);

  const added = makeFiles(1, 'new');
  rerender({ list: [...files, ...added] });
  await waitFor(() => expect(result.current.suggestionsByPath.size).toBe(4));
  expect(getBatchSuggestions).toHaveBeenCalledTimes(2);
  expect(getBatchSuggestions.mock.calls[1][0].map((f) => f.path)).toEqual(['/in/new-0.pdf']);
});

test('changing the smart folders ranks everything again', async () => {
  const files = makeFiles(2);
  const { result, rerender } = renderHook(({ folders }) => useOrganizeSuggestions(files, folders), {
    initialProps: { folders: FOLDERS }
  });
  await waitFor(() => expect(result.current.suggestionsByPath.size).toBe(2));

  rerender({ folders: [...FOLDERS, { id: 'tax', name: 'Taxes', path: '/Library/Taxes' }] });
  await waitFor(() => expect(getBatchSuggestions).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.suggestionsByPath.size).toBe(2));
});

test('a failed chunk leaves those files unranked instead of throwing', async () => {
  getBatchSuggestions.mockRejectedValueOnce(new Error('timeout'));
  const files = makeFiles(2);
  const { result } = renderHook(() => useOrganizeSuggestions(files, FOLDERS));
  await waitFor(() => expect(result.current.isRanking).toBe(false));
  expect(result.current.suggestionsByPath.size).toBe(0);
});

test('no smart folders, no API: nothing is fetched', async () => {
  renderHook(() => useOrganizeSuggestions(makeFiles(2), []));
  await act(async () => {});
  expect(getBatchSuggestions).not.toHaveBeenCalled();

  global.window.electronAPI = {};
  renderHook(() => useOrganizeSuggestions(makeFiles(2), FOLDERS));
  await act(async () => {});
  expect(getBatchSuggestions).not.toHaveBeenCalled();
});

test('the IPC payload drops full text and keeps what the engine reads', () => {
  const payload = toSuggestionFile({
    path: '/in/a.pdf',
    name: 'a.pdf',
    size: 10,
    analysis: {
      category: 'Finance',
      keywords: ['tax'],
      extractedText: 'long',
      transcript: 'long'
    }
  });
  expect(payload).toEqual({
    path: '/in/a.pdf',
    name: 'a.pdf',
    extension: 'pdf',
    size: 10,
    analysis: { category: 'Finance', keywords: ['tax'] }
  });
});
