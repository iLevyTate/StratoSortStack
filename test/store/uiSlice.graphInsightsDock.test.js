/**
 * @jest-environment node
 */
import uiReducer, { setGraphInsightsDockCollapsed } from '../../src/renderer/store/slices/uiSlice';

describe('uiSlice graphInsightsDockCollapsed', () => {
  test('initial state keeps the insight dock expanded', () => {
    const state = uiReducer(undefined, { type: '@@init' });
    expect(state.graphInsightsDockCollapsed).toBe(false);
  });

  test('setGraphInsightsDockCollapsed coerces truthy/falsy payloads to booleans', () => {
    let state = uiReducer(undefined, setGraphInsightsDockCollapsed(true));
    expect(state.graphInsightsDockCollapsed).toBe(true);

    state = uiReducer(state, setGraphInsightsDockCollapsed(false));
    expect(state.graphInsightsDockCollapsed).toBe(false);

    state = uiReducer(state, setGraphInsightsDockCollapsed(1));
    expect(state.graphInsightsDockCollapsed).toBe(true);

    state = uiReducer(state, setGraphInsightsDockCollapsed(undefined));
    expect(state.graphInsightsDockCollapsed).toBe(false);
  });
});
