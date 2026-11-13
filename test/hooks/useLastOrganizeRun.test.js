/**
 * @jest-environment jsdom
 */
import React from 'react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { act, renderHook } from '@testing-library/react';

import filesReducer, { setLastOrganizeRun } from '../../src/renderer/store/slices/filesSlice';
import { useLastOrganizeRun } from '../../src/renderer/hooks/useLastOrganizeRun';
import { CLEAN_RUN_SUMMARY_MS } from '../../src/renderer/utils/organizeRunSummary';

const NOW = new Date(2026, 10, 12, 9, 30).getTime();

const summaryOf = (outcome, extra = {}) => ({
  outcome,
  count: 2,
  headline: `headline for ${outcome}`,
  detail: '',
  finishedAt: NOW,
  resumesAtLaunch: false,
  ...extra
});

// One store, any number of screens reading it: each renderScreen is a screen
// (Organize or the Dashboard) that mounts the hook.
function setup() {
  const store = configureStore({ reducer: { files: filesReducer } });
  const wrapper = ({ children }) => <Provider store={store}>{children}</Provider>;
  const renderScreen = () => renderHook(() => useLastOrganizeRun(), { wrapper });
  const stored = () => store.getState().files.lastOrganizeRun;
  return { store, renderScreen, stored };
}

const elapse = (ms) => act(() => jest.advanceTimersByTime(ms));

describe('useLastOrganizeRun', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('there is no summary before a run', () => {
    const { renderScreen } = setup();

    expect(renderScreen().result.current.lastOrganizeRun).toBeNull();
  });

  test('a run that left files unmoved stays until it is dismissed', () => {
    const { renderScreen, stored } = setup();
    const screen = renderScreen();

    act(() => screen.result.current.setLastOrganizeRun(summaryOf('partial')));
    elapse(10 * 60 * 1000);
    expect(screen.result.current.lastOrganizeRun).toEqual(summaryOf('partial'));

    act(() => screen.result.current.dismissLastOrganizeRun());
    expect(screen.result.current.lastOrganizeRun).toBeNull();
    expect(stored()).toBeNull();
  });

  test('a run that moved everything clears itself', () => {
    const { renderScreen, stored } = setup();
    const screen = renderScreen();

    act(() => screen.result.current.setLastOrganizeRun(summaryOf('moved')));
    elapse(CLEAN_RUN_SUMMARY_MS - 1);
    expect(screen.result.current.lastOrganizeRun).toEqual(summaryOf('moved'));

    elapse(1);
    expect(screen.result.current.lastOrganizeRun).toBeNull();
    expect(stored()).toBeNull();
  });

  test('a screen opened part-way through shows it for the time that is left', () => {
    const { store, renderScreen, stored } = setup();
    store.dispatch(setLastOrganizeRun(summaryOf('moved', { finishedAt: NOW - 5000 })));

    const screen = renderScreen();
    expect(screen.result.current.lastOrganizeRun).not.toBeNull();

    elapse(CLEAN_RUN_SUMMARY_MS - 5000 - 1);
    expect(stored()).not.toBeNull();
    elapse(1);
    expect(screen.result.current.lastOrganizeRun).toBeNull();
    expect(stored()).toBeNull();
  });

  test('a screen opened after the time is up does not show it, and clears it', () => {
    const { store, renderScreen, stored } = setup();
    store.dispatch(
      setLastOrganizeRun(summaryOf('moved', { finishedAt: NOW - CLEAN_RUN_SUMMARY_MS }))
    );

    const screen = renderScreen();
    expect(screen.result.current.lastOrganizeRun).toBeNull();

    elapse(0);
    expect(stored()).toBeNull();
  });

  test('a run that finishes while the screen is open is shown, however long it has been open', () => {
    const { renderScreen } = setup();
    const screen = renderScreen();
    elapse(60 * 60 * 1000);

    const summary = summaryOf('moved', { finishedAt: Date.now() });
    act(() => screen.result.current.setLastOrganizeRun(summary));

    expect(screen.result.current.lastOrganizeRun).toEqual(summary);
  });

  // A screen announces a failed run as an alert only when it is news there.
  describe('finishedWhileOpen', () => {
    test('is true for a run that finishes on the open screen', () => {
      const { renderScreen } = setup();
      const screen = renderScreen();
      expect(screen.result.current.finishedWhileOpen).toBe(false);

      elapse(60 * 1000);
      act(() =>
        screen.result.current.setLastOrganizeRun(summaryOf('none', { finishedAt: Date.now() }))
      );

      expect(screen.result.current.finishedWhileOpen).toBe(true);
    });

    test('is false on a screen opened after the run finished', () => {
      const { renderScreen } = setup();
      const organize = renderScreen();
      act(() => organize.result.current.setLastOrganizeRun(summaryOf('none')));
      organize.unmount();
      elapse(1);

      const reopened = renderScreen().result.current;
      expect(reopened.lastOrganizeRun).toEqual(summaryOf('none'));
      expect(reopened.finishedWhileOpen).toBe(false);
    });

    test('is false when the finish time is not known', () => {
      const { store, renderScreen } = setup();
      store.dispatch(setLastOrganizeRun(summaryOf('partial', { finishedAt: null })));

      expect(renderScreen().result.current.finishedWhileOpen).toBe(false);
    });
  });

  test('a new run replaces the summary and restarts its time', () => {
    const { renderScreen, stored } = setup();
    const screen = renderScreen();

    act(() => screen.result.current.setLastOrganizeRun(summaryOf('moved')));
    elapse(CLEAN_RUN_SUMMARY_MS - 1000);
    const second = summaryOf('moved', { count: 5, finishedAt: Date.now() });
    act(() => screen.result.current.setLastOrganizeRun(second));

    elapse(CLEAN_RUN_SUMMARY_MS - 1);
    expect(stored()).toEqual(second);
    elapse(1);
    expect(stored()).toBeNull();
  });

  test('a screen that closes leaves the summary for the next one', () => {
    const { renderScreen, stored } = setup();
    const organize = renderScreen();
    act(() => organize.result.current.setLastOrganizeRun(summaryOf('partial')));
    organize.unmount();
    elapse(60 * 1000);

    expect(stored()).toEqual(summaryOf('partial'));
    expect(renderScreen().result.current.lastOrganizeRun).toEqual(summaryOf('partial'));
  });

  test('a closed screen does not clear a clean run early or twice', () => {
    const { store, renderScreen, stored } = setup();
    const organize = renderScreen();
    act(() => organize.result.current.setLastOrganizeRun(summaryOf('moved')));
    organize.unmount();

    // No screen is open: nothing counts the time down.
    elapse(CLEAN_RUN_SUMMARY_MS * 2);
    expect(stored()).toEqual(summaryOf('moved'));

    // The next screen sees its time is up, hides it and clears it.
    const dispatch = jest.spyOn(store, 'dispatch');
    const dashboard = renderScreen();
    expect(dashboard.result.current.lastOrganizeRun).toBeNull();
    elapse(0);
    expect(stored()).toBeNull();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test('anything that is not a run summary clears it', () => {
    const { renderScreen, stored } = setup();
    const screen = renderScreen();
    act(() => screen.result.current.setLastOrganizeRun(summaryOf('partial')));

    act(() => screen.result.current.setLastOrganizeRun({ outcome: 'unknown' }));

    expect(stored()).toBeNull();
  });
});
