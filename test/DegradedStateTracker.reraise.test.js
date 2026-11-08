/**
 * Dismissing a degraded-state banner hides the condition the user saw. When
 * the condition later gets worse (another subsystem joins the flag, or a
 * warning escalates to an error) the banner must come back; a plain repeat of
 * the same raise must stay dismissed.
 */

jest.mock('../src/shared/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: () => logger, logger };
});

const {
  DegradedStateTracker,
  getInstance,
  STORAGE_FULL_CODE,
  raiseStorageFull,
  clearStorageFull
} = require('../src/main/services/DegradedStateTracker');

describe('DegradedStateTracker re-raise after dismiss', () => {
  test('a second source joining a dismissed flag shows it again', () => {
    const tracker = new DegradedStateTracker();
    tracker.raise({ code: 'storage.full', source: 'vector-store', severity: 'error' });
    tracker.dismiss('storage.full');
    expect(tracker.hasActive()).toBe(false);

    tracker.raise({ code: 'storage.full', source: 'analysis-history', severity: 'error' });

    const [flag] = tracker.list();
    expect(flag.sources).toEqual(['vector-store', 'analysis-history']);
    expect(flag.dismissed).toBe(false);
    expect(tracker.hasActive()).toBe(true);
  });

  test('a warning escalating to an error shows a dismissed flag again', () => {
    const tracker = new DegradedStateTracker();
    tracker.raise({ code: 'x.degraded', severity: 'warning', message: 'slow' });
    tracker.dismiss('x.degraded');

    tracker.raise({ code: 'x.degraded', severity: 'error', message: 'broken' });

    expect(tracker.list()[0]).toMatchObject({ severity: 'error', dismissed: false });
  });

  test('repeating the same raise keeps a dismissed flag dismissed', () => {
    const tracker = new DegradedStateTracker();
    tracker.raise({ code: 'storage.full', source: 'vector-store', severity: 'error' });
    tracker.dismiss('storage.full');

    tracker.raise({ code: 'storage.full', source: 'vector-store', severity: 'error' });
    tracker.raise({ code: 'x.other', severity: 'warning' });
    tracker.dismiss('x.other');
    tracker.raise({ code: 'x.other', severity: 'warning' });

    expect(tracker.list().map((f) => f.dismissed)).toEqual([true, true]);
    expect(tracker.hasActive()).toBe(false);
  });

  test('storage-full banner returns, naming both stores, when a second store fails after dismiss', () => {
    raiseStorageFull('vector-store', {});
    getInstance().dismiss(STORAGE_FULL_CODE);

    raiseStorageFull('analysis-history', {});

    const flag = getInstance()
      .list()
      .find((f) => f.code === STORAGE_FULL_CODE);
    expect(flag.dismissed).toBe(false);
    expect(flag.sources).toEqual(['vector-store', 'analysis-history']);
    expect(flag.message).toMatch(/search index or its analysis history/);
    expect(getInstance().hasActive()).toBe(true);

    clearStorageFull('vector-store');
    clearStorageFull('analysis-history');
  });
});
