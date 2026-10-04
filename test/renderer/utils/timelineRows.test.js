/**
 * @jest-environment node
 */
import {
  buildTimelineRows,
  formatTimelineDay,
  isDateOnly
} from '../../../src/renderer/utils/timelineRows';

describe('buildTimelineRows', () => {
  const items = [
    { id: 'c', effectiveDate: '2024-12-25T08:00:00.000Z', fileName: 'c.pdf' },
    { id: 'a', effectiveDate: '2024-12-01', fileName: 'a.pdf' },
    { id: 'b', effectiveDate: '2019-06-14', fileName: 'b.jpg' },
    { id: 'x', effectiveDate: 'garbage', fileName: 'x.bin' }
  ];

  test('emits year and month header rows with item rows beneath (input order preserved)', () => {
    const rows = buildTimelineRows(items);
    expect(rows.map((r) => r.type)).toEqual([
      'year',
      'month',
      'item',
      'item',
      'year',
      'month',
      'item',
      'undated',
      'item'
    ]);
    expect(rows[0]).toMatchObject({ type: 'year', label: '2024' });
    expect(rows[1]).toMatchObject({ type: 'month', label: 'December 2024' });
    expect(rows[4]).toMatchObject({ type: 'year', label: '2019' });
    expect(rows[7]).toMatchObject({ type: 'undated', label: 'Undated' });
    expect(rows[8].item.id).toBe('x');
  });

  test('empty input yields empty rows', () => {
    expect(buildTimelineRows([])).toEqual([]);
    expect(buildTimelineRows(null)).toEqual([]);
  });

  test('groups full timestamps by LOCAL month, date-only strings by their literal day', () => {
    // A moment near UTC midnight lands in different months depending on the
    // runner's timezone — the headers must agree with the user's clock.
    const ts = '2024-12-31T23:30:00.000Z';
    const local = new Date(ts);
    const expectedYear = String(local.getFullYear());
    const rows = buildTimelineRows([{ id: 't', effectiveDate: ts, fileName: 't.pdf' }]);
    expect(rows[0]).toMatchObject({ type: 'year', label: expectedYear });

    // Date-only content dates keep their calendar day in every timezone
    // (UTC-midnight parse must NOT shift them back a day west of Greenwich).
    const dateOnlyRows = buildTimelineRows([
      { id: 'd', effectiveDate: '2024-12-01', fileName: 'd' }
    ]);
    expect(dateOnlyRows[0]).toMatchObject({ type: 'year', label: '2024' });
    expect(dateOnlyRows[1]).toMatchObject({ type: 'month', label: 'December 2024' });
  });
});

describe('formatTimelineDay / isDateOnly', () => {
  test('date-only strings pass through verbatim', () => {
    expect(isDateOnly('2024-12-01')).toBe(true);
    expect(formatTimelineDay('2024-12-01')).toBe('2024-12-01');
  });

  test('timestamps format as the LOCAL calendar day', () => {
    const ts = '2024-12-31T23:30:00.000Z';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    expect(isDateOnly(ts)).toBe(false);
    expect(formatTimelineDay(ts)).toBe(
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    );
  });

  test('unparseable input returns null', () => {
    expect(formatTimelineDay('garbage')).toBeNull();
  });

  test('non-ISO parseable strings route through the LOCAL path, not date-only [F-165]', () => {
    // Pre-fix, any string lacking 'T' was treated as ISO date-only: display
    // became value.slice(0, 10) — "May 5, 20" — and UTC getters were applied
    // to a local-parsed Date (day shift east of Greenwich).
    const value = 'May 5, 2024';
    expect(isDateOnly(value)).toBe(false);
    const d = new Date(value); // parses as LOCAL midnight
    const pad = (n) => String(n).padStart(2, '0');
    expect(formatTimelineDay(value)).toBe(
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    );
  });

  test('space-separated datetime strings are moments in time, not date-only [F-165]', () => {
    expect(isDateOnly('2024-05-05 10:00')).toBe(false);
  });
});
