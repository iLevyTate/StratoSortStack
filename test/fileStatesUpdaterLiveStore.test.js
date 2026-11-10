/**
 * @jest-environment jsdom
 */
/**
 * setFileStates(prev => next) replaces the whole fileStates map, so `prev`
 * has to be what the store holds at that moment. It was the map the hook last
 * rendered with: a second write in the same tick, or any write after the phase
 * was left (a Discover run ends when main lets go of its file, which can be
 * minutes later), put that older map back over everything changed since.
 * Real reducers and real hooks.
 */
import React from 'react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { renderHook, act } from '@testing-library/react';

import uiReducer from '../src/renderer/store/slices/uiSlice';
import filesReducer, {
  setFileStates,
  updateFileState
} from '../src/renderer/store/slices/filesSlice';
import analysisReducer from '../src/renderer/store/slices/analysisSlice';
import systemReducer from '../src/renderer/store/slices/systemSlice';
import { useDiscoverState } from '../src/renderer/phases/discover/useDiscoverState';
import { useOrganizeState } from '../src/renderer/phases/organize/useOrganizeState';

function makeStore() {
  const store = configureStore({
    reducer: {
      ui: uiReducer,
      files: filesReducer,
      analysis: analysisReducer,
      system: systemReducer
    },
    middleware: (getDefault) => getDefault({ serializableCheck: false, immutableCheck: false })
  });
  store.dispatch(
    setFileStates({
      '/docs/recording.mp3': { state: 'analyzing' },
      '/docs/report.pdf': { state: 'pending' }
    })
  );
  return store;
}

const mount = (useHook, store) =>
  renderHook(() => useHook(), {
    wrapper: ({ children }) => <Provider store={store}>{children}</Provider>
  });

const states = (store) =>
  Object.fromEntries(
    Object.entries(store.getState().files.fileStates).map(([path, info]) => [path, info.state])
  );

// What a run does with the files it did not finish.
const requeueInFlight = (prev) =>
  Object.fromEntries(
    Object.entries(prev).map(([path, info]) => [
      path,
      info.state === 'analyzing' ? { ...info, state: 'pending' } : info
    ])
  );

describe.each([
  ['Discover', useDiscoverState],
  ['Organize', useOrganizeState]
])('setFileStates(updater) in %s', (_phase, useHook) => {
  test('sees a change made earlier in the same tick', () => {
    const store = makeStore();
    const { result } = mount(useHook, store);

    act(() => {
      store.dispatch(updateFileState({ path: '/docs/report.pdf', state: 'ready' }));
      result.current.setFileStates(requeueInFlight);
    });

    expect(states(store)).toEqual({
      '/docs/recording.mp3': 'pending',
      '/docs/report.pdf': 'ready'
    });
  });

  test('called after the phase was left, keeps what changed since', () => {
    const store = makeStore();
    const { result, unmount } = mount(useHook, store);
    const setFileStatesOfLeftPhase = result.current.setFileStates;

    unmount();
    act(() => {
      store.dispatch(updateFileState({ path: '/docs/report.pdf', state: 'ready' }));
      store.dispatch(updateFileState({ path: '/docs/photo.png', state: 'pending' }));
    });
    act(() => {
      setFileStatesOfLeftPhase(requeueInFlight);
    });

    expect(states(store)).toEqual({
      '/docs/recording.mp3': 'pending',
      '/docs/report.pdf': 'ready',
      '/docs/photo.png': 'pending'
    });
  });
});
