/**
 * @jest-environment node
 */
import uiReducer, {
  GRAPH_INSIGHTS_SECTION_KEYS,
  setGraphInsightsSection
} from '../../src/renderer/store/slices/uiSlice';

describe('uiSlice graphInsightsSection', () => {
  test('initial state opens Insights by default', () => {
    const state = uiReducer(undefined, { type: '@@init' });
    expect(state.graphInsightsSection).toBe('insights');
  });

  test('setGraphInsightsSection toggles allowed keys', () => {
    let state = uiReducer(undefined, { type: '@@init' });
    state = uiReducer(state, setGraphInsightsSection('filters'));
    expect(state.graphInsightsSection).toBe('filters');
    state = uiReducer(state, setGraphInsightsSection(null));
    expect(state.graphInsightsSection).toBeNull();
  });

  test('all graph sidebar section keys are accepted', () => {
    for (const key of GRAPH_INSIGHTS_SECTION_KEYS) {
      const state = uiReducer(undefined, setGraphInsightsSection(key));
      expect(state.graphInsightsSection).toBe(key);
    }
  });

  test('invalid key falls back to insights', () => {
    const state = uiReducer(undefined, setGraphInsightsSection('nope'));
    expect(state.graphInsightsSection).toBe('insights');
  });
});
