/**
 * @jest-environment jsdom
 *
 * Sample first, the flow: a large batch is offered a sample before it runs;
 * the user can skip it, or try a few files, see where they would go, then
 * continue with the rest or go edit the folders. The offer does not come
 * back for the same Smart Folder definitions, and does once they change.
 */
import React from 'react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { renderHook, act } from '@testing-library/react';
import uiReducer from '../src/renderer/store/slices/uiSlice';
import filesReducer, { setSmartFolders } from '../src/renderer/store/slices/filesSlice';
import analysisReducer, { setAnalysisResults } from '../src/renderer/store/slices/analysisSlice';
import { useSampleRun } from '../src/renderer/phases/discover/useSampleRun';
import { SAMPLE_SIZE } from '../src/renderer/phases/discover/sampleRun';

const { getFolderDefinitionsHash } = require('../src/shared/smartFolderDefinitions');

const INVOICES = {
  id: 'f-inv',
  name: 'Invoices',
  description: 'Bills and invoices from suppliers, not receipts',
  path: '/Users/alex/Library/Invoices'
};
const PHOTOS = {
  id: 'f-photo',
  name: 'Photos',
  description: 'Pictures taken with the phone or camera',
  path: '/Users/alex/Library/Photos'
};
const FOLDERS = [INVOICES, PHOTOS];

const makeFiles = (count) =>
  Array.from({ length: count }, (_, i) => {
    const ext = i % 2 === 0 ? 'pdf' : 'jpg';
    return { path: `/Users/alex/Inbox/file-${i}.${ext}`, name: `file-${i}.${ext}` };
  });

function makeStore() {
  const store = configureStore({
    reducer: { ui: uiReducer, files: filesReducer, analysis: analysisReducer },
    middleware: (getDefault) => getDefault({ serializableCheck: false, immutableCheck: false })
  });
  store.dispatch(setSmartFolders(FOLDERS));
  return store;
}

function setup(store = makeStore()) {
  const analyzeFiles = jest.fn(async () => ({ started: true }));
  const cancelAnalysis = jest.fn();
  const advancePhase = jest.fn();
  const wrapper = ({ children }) => <Provider store={store}>{children}</Provider>;
  const hook = renderHook(() => useSampleRun({ analyzeFiles, cancelAnalysis, advancePhase }), {
    wrapper
  });
  return { store, hook, analyzeFiles, cancelAnalysis, advancePhase };
}

/** The sample run: record a result for each file, as the analysis run does. */
function analyzeSampleInto(store, analyzeFiles) {
  analyzeFiles.mockImplementationOnce(async (files) => {
    store.dispatch(
      setAnalysisResults(
        files.map((file) => ({
          ...file,
          analysis: { category: file.name.endsWith('.jpg') ? 'Photos' : 'Invoices' }
        }))
      )
    );
    return { started: true };
  });
}

beforeEach(() => {
  window.electronAPI = {
    suggestions: {
      getBatchSuggestions: jest.fn().mockResolvedValue({ success: true, groups: [] })
    }
  };
});

afterEach(() => {
  delete window.electronAPI;
});

describe('useSampleRun', () => {
  test('a small batch starts at once, with no offer', async () => {
    const { hook, analyzeFiles } = setup();
    const files = makeFiles(19);
    let result;
    await act(async () => {
      result = await hook.result.current.analyzeFiles(files);
    });
    expect(analyzeFiles).toHaveBeenCalledWith(files, undefined);
    expect(result).toEqual({ started: true });
    expect(hook.result.current.session).toBeNull();
  });

  test('a large batch is offered a sample and nothing runs yet', async () => {
    const { hook, analyzeFiles } = setup();
    let result;
    await act(async () => {
      result = await hook.result.current.analyzeFiles(makeFiles(25));
    });
    expect(result).toEqual({ started: false, reason: 'sample-offered' });
    expect(analyzeFiles).not.toHaveBeenCalled();
    const { session } = hook.result.current;
    expect(session.stage).toBe('offer');
    expect(session.files).toHaveLength(25);
    expect(session.picked).toHaveLength(SAMPLE_SIZE);
    expect(session.hash).toBe(getFolderDefinitionsHash(FOLDERS));
  });

  test('runs the analysis starts itself are never held', async () => {
    const { hook, analyzeFiles } = setup();
    const files = makeFiles(25);
    await act(async () => {
      await hook.result.current.analyzeFiles(files, { origin: 'queued' });
      await hook.result.current.analyzeFiles(files, { bypassCache: true });
    });
    expect(analyzeFiles).toHaveBeenCalledTimes(2);
    expect(hook.result.current.session).toBeNull();
  });

  test('skipped: the whole batch runs, and the offer stays away for these folders', async () => {
    const { store, hook, analyzeFiles } = setup();
    const files = makeFiles(25);
    await act(async () => {
      await hook.result.current.analyzeFiles(files);
    });
    await act(async () => {
      await hook.result.current.skipSample();
    });
    expect(analyzeFiles).toHaveBeenCalledWith(files);
    expect(hook.result.current.session).toBeNull();
    expect(store.getState().ui.smartFolderSampleHash).toBe(getFolderDefinitionsHash(FOLDERS));

    // The next large batch with the same folders starts at once.
    const more = makeFiles(30).map((f) => ({ ...f, path: f.path.replace('Inbox', 'More') }));
    await act(async () => {
      await hook.result.current.analyzeFiles(more);
    });
    expect(analyzeFiles).toHaveBeenLastCalledWith(more, undefined);
    expect(hook.result.current.session).toBeNull();
  });

  test('continued: the sample is reviewed, then only the other files run', async () => {
    const { store, hook, analyzeFiles } = setup();
    window.electronAPI.suggestions.getBatchSuggestions.mockResolvedValue({
      success: true,
      groups: [
        {
          files: [
            {
              path: '/Users/alex/Inbox/file-0.pdf',
              suggestion: {
                folder: 'Invoices',
                path: INVOICES.path,
                folderId: INVOICES.id,
                isSmartFolder: true
              },
              confidence: 0.9,
              explanation: 'Reads like a supplier invoice',
              alternatives: []
            }
          ]
        }
      ]
    });
    const files = makeFiles(25);
    await act(async () => {
      await hook.result.current.analyzeFiles(files);
    });
    const picked = hook.result.current.session.picked;

    analyzeSampleInto(store, analyzeFiles);
    await act(async () => {
      await hook.result.current.startSample();
    });

    // The sample goes through the normal run, marked as a sample.
    expect(analyzeFiles).toHaveBeenCalledWith(picked, { origin: 'sample' });
    const { session } = hook.result.current;
    expect(session.stage).toBe('review');
    expect(session.rows).toHaveLength(SAMPLE_SIZE);
    expect(session.rows[0]).toEqual({
      path: '/Users/alex/Inbox/file-0.pdf',
      name: 'file-0.pdf',
      analyzed: true,
      folder: 'Invoices',
      score: 0.9,
      reason: 'Reads like a supplier invoice'
    });
    expect(session.rows.find((row) => row.name.endsWith('.jpg'))).toMatchObject({
      folder: 'Photos',
      score: null
    });
    // Reviewing the sample is what is remembered.
    expect(store.getState().ui.smartFolderSampleHash).toBe(getFolderDefinitionsHash(FOLDERS));

    await act(async () => {
      await hook.result.current.continueWithRest();
    });
    const sampled = new Set(picked.map((f) => f.path));
    const rest = files.filter((f) => !sampled.has(f.path));
    expect(analyzeFiles).toHaveBeenLastCalledWith(rest);
    expect(rest).toHaveLength(25 - SAMPLE_SIZE);
    expect(hook.result.current.session).toBeNull();
  });

  test('not offered again until the definitions change, then offered again', async () => {
    const { store, hook, analyzeFiles } = setup();
    await act(async () => {
      await hook.result.current.analyzeFiles(makeFiles(25));
    });
    analyzeSampleInto(store, analyzeFiles);
    await act(async () => {
      await hook.result.current.startSample();
    });
    act(() => {
      hook.result.current.dismiss();
    });

    const second = makeFiles(25).map((f) => ({ ...f, path: f.path.replace('Inbox', 'Second') }));
    await act(async () => {
      await hook.result.current.analyzeFiles(second);
    });
    expect(analyzeFiles).toHaveBeenLastCalledWith(second, undefined);

    // A reworded description is a new definition: the offer comes back.
    act(() => {
      store.dispatch(
        setSmartFolders([{ ...INVOICES, description: 'Supplier invoices only' }, PHOTOS])
      );
    });
    const third = makeFiles(25).map((f) => ({ ...f, path: f.path.replace('Inbox', 'Third') }));
    const callsBefore = analyzeFiles.mock.calls.length;
    await act(async () => {
      await hook.result.current.analyzeFiles(third);
    });
    expect(analyzeFiles).toHaveBeenCalledTimes(callsBefore);
    expect(hook.result.current.session.stage).toBe('offer');
  });

  test('edit folders after the review: go to Setup, the rest stays unanalyzed', async () => {
    const { store, hook, analyzeFiles, advancePhase } = setup();
    await act(async () => {
      await hook.result.current.analyzeFiles(makeFiles(25));
    });
    analyzeSampleInto(store, analyzeFiles);
    await act(async () => {
      await hook.result.current.startSample();
    });
    act(() => {
      hook.result.current.editFolders();
    });
    expect(advancePhase).toHaveBeenCalledWith('setup');
    expect(analyzeFiles).toHaveBeenCalledTimes(1); // the sample only
    expect(hook.result.current.session).toBeNull();
  });

  test('stop during the sample cancels the run and records nothing', async () => {
    const { store, hook, analyzeFiles, cancelAnalysis } = setup();
    await act(async () => {
      await hook.result.current.analyzeFiles(makeFiles(25));
    });
    let finish;
    analyzeFiles.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    let sampleDone;
    act(() => {
      sampleDone = hook.result.current.startSample();
    });
    expect(hook.result.current.session.stage).toBe('running');

    act(() => {
      hook.result.current.stopSample();
    });
    expect(cancelAnalysis).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({ started: true });
      await sampleDone;
    });
    expect(hook.result.current.session).toBeNull();
    expect(store.getState().ui.smartFolderSampleHash).toBeNull();
  });

  test('files added while the offer is open join its batch', async () => {
    const { hook, analyzeFiles } = setup();
    await act(async () => {
      await hook.result.current.analyzeFiles(makeFiles(25));
    });
    const extra = [{ path: '/Users/alex/Inbox/late.pdf', name: 'late.pdf' }];
    await act(async () => {
      await hook.result.current.analyzeFiles(extra);
    });
    expect(analyzeFiles).not.toHaveBeenCalled();
    expect(hook.result.current.session.files).toHaveLength(26);
  });
});
