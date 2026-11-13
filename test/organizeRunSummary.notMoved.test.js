/**
 * A run summary counts the files the run did not move, so the Dashboard can
 * say how many there are instead of "0 failed".
 */

import { normalizeOrganizeRunSummary } from '../src/renderer/utils/organizeRunSummary';

const summary = (extra) => ({
  outcome: 'partial',
  count: 3,
  headline: 'Moved 3 files; 2 could not be moved',
  detail: '',
  finishedAt: 1,
  ...extra
});

describe('notMovedCount', () => {
  test('is kept', () => {
    expect(normalizeOrganizeRunSummary(summary({ notMovedCount: 2 })).notMovedCount).toBe(2);
  });

  // A summary without the field means none were left behind.
  test.each([[0], [-1], ['x'], [1.5], [undefined]])('%p is not stored', (value) => {
    expect(normalizeOrganizeRunSummary(summary({ notMovedCount: value }))).not.toHaveProperty(
      'notMovedCount'
    );
  });
});
