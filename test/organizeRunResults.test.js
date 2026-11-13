/**
 * The per-file record of an organize run: one row per file the run was asked
 * to move, saying where it is now and, for a file that was not moved, why.
 */

import {
  buildRunResultRows,
  countRunOutcomes,
  destinationTotals,
  isDuplicateSkip,
  MAX_RUN_RESULT_ROWS,
  normalizeRunResultRows,
  organizedEntryToRow,
  revealPathFor,
  withQueueNote
} from '../src/renderer/utils/organizeRunResults';
import { mapErrorToNotification } from '../src/renderer/utils/errorMapping';

const op = (name, folder = '/Docs/GSC') => ({
  type: 'move',
  source: `/in/${name}`,
  destination: `${folder}/${name}`
});

describe('buildRunResultRows', () => {
  test('a moved file reports where it is now, in operation order', () => {
    const operations = [op('a.xlsx'), op('b.csv', '/Docs/Bing')];
    // Main finishes files concurrently, so results arrive in any order.
    const rows = buildRunResultRows({
      operations,
      rows: [
        { success: true, source: '/in/b.csv', destination: '/Docs/Bing/b.csv' },
        { success: true, source: '/in/a.xlsx', destination: '/Docs/GSC/a.xlsx' }
      ]
    });

    expect(rows).toEqual([
      {
        name: 'a.xlsx',
        originalPath: '/in/a.xlsx',
        plannedPath: '/Docs/GSC/a.xlsx',
        finalPath: '/Docs/GSC/a.xlsx',
        outcome: 'moved',
        reason: '',
        renamedOnCollision: false
      },
      {
        name: 'b.csv',
        originalPath: '/in/b.csv',
        plannedPath: '/Docs/Bing/b.csv',
        finalPath: '/Docs/Bing/b.csv',
        outcome: 'moved',
        reason: '',
        renamedOnCollision: false
      }
    ]);
  });

  test('a failed move carries the reason in plain words', () => {
    const [row] = buildRunResultRows({
      operations: [op('a.xlsx')],
      rows: [
        {
          success: false,
          source: '/in/a.xlsx',
          destination: '/Docs/GSC/a.xlsx',
          error: 'EACCES: permission denied',
          errorCode: 'EACCES'
        }
      ]
    });

    expect(row.outcome).toBe('failed');
    expect(row.finalPath).toBeNull();
    expect(row.reason).toBe(
      mapErrorToNotification({ error: 'EACCES: permission denied', errorCode: 'EACCES' }).message
    );
    expect(row.reason).not.toBe('');
  });

  test.each([
    ['notAttempted', 'notMoved', 'The run stopped before this file.'],
    ['cancelled', 'notMoved', 'You stopped the run before this file.'],
    [
      'interrupted',
      'notMoved',
      'The run was interrupted. It moves the next time StratoSort starts.'
    ]
  ])('a row marked %s is %s: %s', (flag, outcome, reason) => {
    const [row] = buildRunResultRows({
      operations: [op('a.xlsx')],
      rows: [{ success: false, source: '/in/a.xlsx', destination: '/x', [flag]: true }]
    });
    expect(row).toMatchObject({ outcome, reason, finalPath: null });
  });

  test('a rolled-back batch: restored files and files the rollback left behind', () => {
    const rows = buildRunResultRows({
      operations: [op('a.xlsx'), op('b.csv')],
      rows: [
        { success: false, rolledBack: true, source: '/in/a.xlsx', destination: '/Docs/GSC/a.xlsx' },
        {
          success: true,
          rollbackFailed: true,
          source: '/in/b.csv',
          destination: '/Docs/GSC/b.csv'
        }
      ]
    });

    expect(rows[0]).toMatchObject({
      outcome: 'restored',
      finalPath: null,
      reason: 'Returned to its original folder when the run was undone.'
    });
    expect(rows[1]).toMatchObject({
      outcome: 'leftAtDestination',
      finalPath: '/Docs/GSC/b.csv',
      // No path in the reason: the row shows the location, and hides it when
      // privacy redaction is on.
      reason:
        'Could not be returned when the run was undone. It is still in the destination folder.'
    });
  });

  test('a duplicate that was removed instead of moved', () => {
    const [row] = buildRunResultRows({
      operations: [op('a (1).xlsx')],
      rows: [
        {
          success: true,
          skipped: true,
          reason: 'duplicate',
          sourceRemoval: 'trashed',
          source: '/in/a (1).xlsx',
          destination: '/Docs/GSC/a.xlsx'
        }
      ]
    });
    expect(row).toMatchObject({
      outcome: 'duplicate',
      finalPath: '/Docs/GSC/a.xlsx',
      reason: 'This copy is in the system Trash.'
    });
  });

  test('a file with no result row did not move; the batch error says why', () => {
    const operations = [op('a.xlsx'), op('b.csv')];
    const results = [{ success: true, source: '/in/a.xlsx', destination: '/Docs/GSC/a.xlsx' }];

    expect(buildRunResultRows({ operations, rows: results })[1]).toMatchObject({
      outcome: 'notMoved',
      reason: 'The run ended before this file.'
    });
    const withError = buildRunResultRows({
      operations,
      rows: results,
      batchError: 'The disk is full'
    })[1];
    expect(withError.outcome).toBe('notMoved');
    expect(withError.reason).toBe(mapErrorToNotification({ error: 'The disk is full' }).message);
  });

  test('a run whose result never came back does not claim its files stayed put', () => {
    const rows = buildRunResultRows({
      operations: [op('a.xlsx'), op('b.csv')],
      rows: [],
      outcomeUnknown: true
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.outcome).toBe('notMoved');
      expect(row.finalPath).toBeNull();
      expect(row.reason).toMatch(/may have moved/i);
      expect(row.reason).toMatch(/destination folder/i);
      expect(row.reason).not.toMatch(/ended before this file/i);
    }
    // The stored shape accepts these rows.
    expect(normalizeRunResultRows(rows)).toHaveLength(2);
  });

  test('a file renamed because the name was taken is flagged', () => {
    const [row] = buildRunResultRows({
      operations: [op('a.pdf')],
      rows: [{ success: true, source: '/in/a.pdf', destination: '/Docs/GSC/a (1).pdf' }]
    });
    expect(row.finalPath).toBe('/Docs/GSC/a (1).pdf');
    expect(row.renamedOnCollision).toBe(true);
  });

  test('matches results whose source main rewrote (separators, case, Unicode form)', () => {
    const decomposed = '/Users/h/Ma\u0308rz.pdf';
    const composed = '/Users/h/M\u00e4rz.pdf';
    const rows = buildRunResultRows({
      operations: [
        { source: 'C:/In/A.pdf', destination: 'C:\\Out\\A.pdf' },
        { source: decomposed, destination: '/Bills/M\u00e4rz.pdf' }
      ],
      rows: [
        { success: true, source: 'c:\\in\\a.pdf', destination: 'C:\\Out\\A.pdf' },
        { success: true, source: composed, destination: '/Bills/M\u00e4rz.pdf' }
      ]
    });
    expect(rows.map((r) => r.outcome)).toEqual(['moved', 'moved']);
    expect(rows).toHaveLength(2);
  });

  test('a result that matches no operation is still reported', () => {
    const rows = buildRunResultRows({
      operations: [],
      rows: [{ success: true, source: '/in/x.pdf', destination: '/out/x.pdf' }]
    });
    expect(rows).toEqual([expect.objectContaining({ name: 'x.pdf', outcome: 'moved' })]);
  });

  test('isDuplicateSkip only accepts a successful duplicate skip', () => {
    expect(isDuplicateSkip({ success: true, skipped: true, reason: 'duplicate' })).toBe(true);
    expect(isDuplicateSkip({ success: false, skipped: true, reason: 'duplicate' })).toBe(false);
    expect(isDuplicateSkip(null)).toBe(false);
  });
});

describe('organizedEntryToRow', () => {
  test('a moved entry and a removed duplicate', () => {
    expect(
      organizedEntryToRow({
        originalPath: 'C:\\In\\a.pdf',
        path: 'C:\\D\\GSC\\a.pdf',
        originalName: 'a.pdf'
      })
    ).toMatchObject({
      name: 'a.pdf',
      originalPath: 'C:\\In\\a.pdf',
      finalPath: 'C:\\D\\GSC\\a.pdf',
      outcome: 'moved',
      reason: ''
    });
    expect(
      organizedEntryToRow({
        originalPath: '/in/b.pdf',
        path: '/D/b.pdf',
        duplicateRemoval: 'deleted'
      })
    ).toMatchObject({ name: 'b.pdf', outcome: 'duplicate', reason: 'This copy was removed.' });
  });
});

describe('destinationTotals', () => {
  test('groups files by the folder they are in now, busiest first', () => {
    const rows = [
      { name: 'a', originalPath: '/in/a', finalPath: 'C:/D/GSC/a.xlsx', outcome: 'moved' },
      { name: 'b', originalPath: '/in/b', finalPath: 'C:/D/GSC/b.xlsx', outcome: 'moved' },
      { name: 'c', originalPath: '/in/c', finalPath: 'C:/D/Bing/c.csv', outcome: 'moved' },
      { name: 'd', originalPath: '/in/d', finalPath: 'C:/D/Bing/c.csv', outcome: 'duplicate' },
      { name: 'e', originalPath: '/in/e', finalPath: null, outcome: 'failed' }
    ];
    expect(destinationTotals(rows)).toEqual([
      { folder: 'C:/D/GSC', moved: 2, duplicates: 0 },
      { folder: 'C:/D/Bing', moved: 1, duplicates: 1 }
    ]);
  });

  test('one Windows folder spelled two ways is one destination', () => {
    const rows = [
      { name: 'a', originalPath: 'x', finalPath: 'C:\\D\\GSC\\a.xlsx', outcome: 'moved' },
      { name: 'b', originalPath: 'y', finalPath: 'c:/d/gsc/b.xlsx', outcome: 'moved' }
    ];
    expect(destinationTotals(rows)).toEqual([{ folder: 'C:\\D\\GSC', moved: 2, duplicates: 0 }]);
  });
});

describe('revealPathFor', () => {
  test('the file where it is now', () => {
    expect(revealPathFor({ outcome: 'moved', finalPath: '/D/a', originalPath: '/in/a' })).toBe(
      '/D/a'
    );
    expect(
      revealPathFor({ outcome: 'leftAtDestination', finalPath: '/D/a', originalPath: '/in/a' })
    ).toBe('/D/a');
    expect(revealPathFor({ outcome: 'failed', finalPath: null, originalPath: '/in/a' })).toBe(
      '/in/a'
    );
    expect(revealPathFor({ outcome: 'restored', finalPath: null, originalPath: '/in/a' })).toBe(
      '/in/a'
    );
  });
});

describe('countRunOutcomes', () => {
  test('moved, duplicates and everything that stayed put', () => {
    expect(
      countRunOutcomes([
        { outcome: 'moved' },
        { outcome: 'leftAtDestination' },
        { outcome: 'duplicate' },
        { outcome: 'failed' },
        { outcome: 'notMoved' },
        { outcome: 'restored' }
      ])
    ).toEqual({ moved: 2, duplicates: 1, notMoved: 3 });
  });
});

describe('normalizeRunResultRows', () => {
  test('drops rows that are not run results and caps the list', () => {
    const good = {
      name: 'a',
      originalPath: '/in/a',
      finalPath: '/D/a',
      outcome: 'moved',
      reason: ''
    };
    expect(normalizeRunResultRows([good, null, { outcome: 'deleted' }, 'x'])).toEqual([
      expect.objectContaining({ name: 'a', outcome: 'moved' })
    ]);
    expect(normalizeRunResultRows('nope')).toEqual([]);
    expect(normalizeRunResultRows(Array(5).fill(good), 3)).toHaveLength(3);
    expect(MAX_RUN_RESULT_ROWS).toBe(10000);
  });
});

describe('withQueueNote', () => {
  const summary = {
    outcome: 'partial',
    count: 1,
    headline: 'Moved 1 file; 1 could not be moved',
    detail: 'Access denied. Files that were not moved are still listed.',
    finishedAt: 1
  };
  const rows = [
    { name: 'a', originalPath: '/in/a', finalPath: '/D/a', outcome: 'moved', reason: '' },
    { name: 'b', originalPath: '/in/B', finalPath: null, outcome: 'failed', reason: 'x' }
  ];

  test('keeps the sentence while a file that was not moved is still in the queue', () => {
    expect(withQueueNote(summary, rows, ['/in/B'])).toBe(summary);
  });

  test('says where the files are once none of them is in the queue', () => {
    expect(withQueueNote(summary, rows, ['/in/other']).detail).toBe(
      'Access denied. The files that were not moved are no longer in the queue. They are still in their original folders.'
    );
  });

  test('leaves a clean run alone', () => {
    const clean = { ...summary, outcome: 'moved' };
    expect(withQueueNote(clean, rows, [])).toBe(clean);
    expect(withQueueNote(null, rows, [])).toBeNull();
  });
});
