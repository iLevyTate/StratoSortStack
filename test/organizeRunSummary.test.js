import {
  CLEAN_RUN_SUMMARY_MS,
  leftFilesUnmoved,
  normalizeOrganizeRunSummary,
  summaryForNextLaunch,
  summaryTimeLeft
} from '../src/renderer/utils/organizeRunSummary';

const summaryOf = (outcome, extra = {}) => ({
  outcome,
  count: 2,
  headline: `headline for ${outcome}`,
  detail: '',
  finishedAt: 1000,
  resumesAtLaunch: false,
  ...extra
});

describe('normalizeOrganizeRunSummary', () => {
  test('keeps a complete summary as it is', () => {
    const summary = summaryOf('partial', { detail: 'EACCES', resumesAtLaunch: true });

    expect(normalizeOrganizeRunSummary(summary)).toEqual(summary);
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'moved'],
    ['an array', [summaryOf('moved')]],
    ['an unknown outcome', summaryOf('finished')],
    ['a missing headline', summaryOf('moved', { headline: '' })],
    ['a headline that is not text', summaryOf('moved', { headline: 3 })]
  ])('%s is not a summary', (_label, value) => {
    expect(normalizeOrganizeRunSummary(value)).toBeNull();
  });

  test('fills in what a damaged summary lost and drops what does not belong', () => {
    expect(
      normalizeOrganizeRunSummary({
        outcome: 'none',
        headline: 'No files were moved',
        count: -1,
        detail: 7,
        finishedAt: 'yesterday',
        resumesAtLaunch: 'yes',
        files: ['C:\\Docs\\a.pdf']
      })
    ).toEqual({
      outcome: 'none',
      count: 0,
      headline: 'No files were moved',
      detail: '',
      finishedAt: null,
      resumesAtLaunch: false
    });
  });
});

describe('leftFilesUnmoved', () => {
  test.each(['partial', 'none', 'rolledBack'])('%s left files where they were', (outcome) => {
    expect(leftFilesUnmoved(summaryOf(outcome))).toBe(true);
  });

  test('a run that moved everything did not, and neither did no run', () => {
    expect(leftFilesUnmoved(summaryOf('moved'))).toBe(false);
    expect(leftFilesUnmoved(null)).toBe(false);
  });
});

describe('summaryForNextLaunch', () => {
  test.each(['partial', 'none', 'rolledBack'])('keeps a %s run', (outcome) => {
    const summary = summaryOf(outcome);

    expect(summaryForNextLaunch(summary)).toBe(summary);
  });

  test('does not keep a run that moved everything', () => {
    expect(summaryForNextLaunch(summaryOf('moved'))).toBeNull();
  });

  test('does not keep an interrupted run: main finishes it at launch', () => {
    expect(summaryForNextLaunch(summaryOf('partial', { resumesAtLaunch: true }))).toBeNull();
  });

  test('keeps nothing when there is no summary', () => {
    expect(summaryForNextLaunch(null)).toBeNull();
  });
});

describe('summaryTimeLeft', () => {
  test('a run that left files unmoved has no time limit', () => {
    expect(summaryTimeLeft(summaryOf('partial'), 10 ** 12)).toBe(Infinity);
  });

  test('a clean run counts down from the moment it finished', () => {
    const summary = summaryOf('moved', { finishedAt: 5000 });

    expect(summaryTimeLeft(summary, 5000)).toBe(CLEAN_RUN_SUMMARY_MS);
    expect(summaryTimeLeft(summary, 5000 + CLEAN_RUN_SUMMARY_MS - 1)).toBe(1);
    expect(summaryTimeLeft(summary, 5000 + CLEAN_RUN_SUMMARY_MS)).toBe(0);
    expect(summaryTimeLeft(summary, 5000 + CLEAN_RUN_SUMMARY_MS + 60000)).toBe(0);
  });

  test('a clean run with no known finish time has none left', () => {
    expect(summaryTimeLeft(summaryOf('moved', { finishedAt: null }), 0)).toBe(0);
  });

  test('no summary has none left', () => {
    expect(summaryTimeLeft(null, 0)).toBe(0);
  });
});
