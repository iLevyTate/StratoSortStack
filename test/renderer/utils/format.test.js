/**
 * @jest-environment node
 */
import {
  formatMillisHuman,
  formatDuration,
  formatMediaTimecode,
  formatDateTime,
  setDateLocale
} from '../../../src/renderer/utils/format';

describe('formatMillisHuman', () => {
  it('formats sub-second values as ms', () => {
    expect(formatMillisHuman(0)).toBe('0 ms');
    expect(formatMillisHuman(850)).toBe('850 ms');
  });

  it('formats under one minute with at most one decimal second', () => {
    expect(formatMillisHuman(21547)).toBe('21.5s');
    expect(formatMillisHuman(10000)).toBe('10s');
    expect(formatMillisHuman(9876)).toBe('9.9s');
  });

  it('delegates to formatDuration for long spans', () => {
    expect(formatMillisHuman(90000)).toBe(formatDuration(90000));
  });
});

describe('formatMediaTimecode', () => {
  it('renders mm:ss under one hour', () => {
    expect(formatMediaTimecode(0)).toBe('00:00');
    expect(formatMediaTimecode(5)).toBe('00:05');
    expect(formatMediaTimecode(65)).toBe('01:05');
    expect(formatMediaTimecode(3599)).toBe('59:59');
  });

  it('switches to hh:mm:ss at and above one hour', () => {
    expect(formatMediaTimecode(3600)).toBe('01:00:00');
    expect(formatMediaTimecode(5400)).toBe('01:30:00');
    // 90 min — must not collide with 90 seconds (which is "01:30")
    expect(formatMediaTimecode(5400)).not.toBe(formatMediaTimecode(90));
    expect(formatMediaTimecode(7325)).toBe('02:02:05');
  });

  it('coerces invalid input to 00:00', () => {
    expect(formatMediaTimecode(null)).toBe('00:00');
    expect(formatMediaTimecode(undefined)).toBe('00:00');
    expect(formatMediaTimecode(NaN)).toBe('00:00');
    expect(formatMediaTimecode(-5)).toBe('00:00');
  });
});

describe('formatDateTime', () => {
  afterEach(() => {
    // Reset between tests so one assertion doesn't leak locale state.
    setDateLocale(null);
  });

  it('returns the fallback string for invalid inputs', () => {
    expect(formatDateTime(null, 'datetime', '—')).toBe('—');
    expect(formatDateTime(undefined, 'datetime', '—')).toBe('—');
    expect(formatDateTime('', 'datetime', '—')).toBe('—');
    expect(formatDateTime('not a date', 'datetime', '—')).toBe('—');
  });

  it('accepts Date, epoch ms, and ISO strings', () => {
    setDateLocale('en-US');
    const iso = '2024-05-01T15:30:00Z';
    const d = new Date(iso);
    const out1 = formatDateTime(d, 'date');
    const out2 = formatDateTime(d.getTime(), 'date');
    const out3 = formatDateTime(iso, 'date');
    expect(out1).toBe(out2);
    expect(out2).toBe(out3);
    // Sanity: contains "2024" and the month token.
    expect(out1).toMatch(/2024/);
  });

  it('is deterministic once the locale is pinned', () => {
    setDateLocale('en-GB');
    // Noon UTC to avoid cross-timezone rollover in CI matrix.
    const iso = '2024-05-01T12:00:00Z';
    // en-GB renders date as DD/MM/YYYY for dateStyle: short.
    const short = formatDateTime(iso, 'short');
    // en-GB dateStyle: short => DD/MM/YYYY (4-digit year)
    expect(short).toMatch(/^\d{2}\/\d{2}\/2024$/);
    setDateLocale('en-US');
    // en-US dateStyle: short => M/D/YY (2-digit year in ICU default).
    const enUs = formatDateTime(iso, 'short');
    expect(enUs).toMatch(/^\d{1,2}\/\d{1,2}\/\d{2,4}$/);
    expect(enUs).not.toBe(short);
  });

  it('reuses cached formatters across calls (smoke test for perf)', () => {
    setDateLocale('en-US');
    // Two rapid calls must not throw and must return the same string for
    // the same input — this exercises the Map cache hit path.
    const a = formatDateTime(0, 'datetime');
    const b = formatDateTime(0, 'datetime');
    expect(a).toBe(b);
  });
});
