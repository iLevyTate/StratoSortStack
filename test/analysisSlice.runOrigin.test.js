/**
 * The analysis slice remembers why the current run started (files the person
 * added, files queued during the last run, a resume after restart, a retry or
 * a reanalysis) so the progress card can say so.
 */
import analysisReducer, {
  startAnalysis,
  stopAnalysis,
  resetAnalysisState,
  resetToSafeState
} from '../src/renderer/store/slices/analysisSlice';

describe('analysisSlice runOrigin', () => {
  const initial = () => analysisReducer(undefined, { type: '@@INIT' });

  test('starts empty', () => {
    expect(initial().runOrigin).toBeNull();
  });

  test.each(['added', 'queued', 'resume', 'retry', 'reanalyze'])(
    'startAnalysis keeps a known origin (%s)',
    (origin) => {
      const state = analysisReducer(initial(), startAnalysis({ total: 3, origin }));
      expect(state.runOrigin).toBe(origin);
      expect(state.analysisProgress.total).toBe(3);
    }
  );

  test('an unknown or missing origin counts as files the person added', () => {
    expect(analysisReducer(initial(), startAnalysis({ total: 3, origin: 'bogus' })).runOrigin).toBe(
      'added'
    );
    expect(analysisReducer(initial(), startAnalysis({ total: 3 })).runOrigin).toBe('added');
    expect(analysisReducer(initial(), startAnalysis()).runOrigin).toBe('added');
  });

  test('stopping, resetting or a safe reset clears it', () => {
    const running = analysisReducer(initial(), startAnalysis({ total: 3, origin: 'queued' }));
    expect(analysisReducer(running, stopAnalysis()).runOrigin).toBeNull();
    expect(analysisReducer(running, resetAnalysisState()).runOrigin).toBeNull();
    expect(analysisReducer(running, resetToSafeState()).runOrigin).toBeNull();
  });
});
