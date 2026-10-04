/**
 * @jest-environment node
 *
 * EXIF capture-date reading shared by imageAnalysis and the preprocess worker.
 */

const {
  exifDateValueToIsoDay,
  pickExifIsoDay,
  pickExifDateValue
} = require('../src/main/analysis/exifDate');

describe('exifDate', () => {
  const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);

  test('reads exif-reader 2.x Date objects and 1.x strings as a UTC day', () => {
    expect(exifDateValueToIsoDay(new Date(Date.UTC(2023, 4, 9, 23, 30, 0)), NOW)).toBe(
      '2023-05-09'
    );
    expect(exifDateValueToIsoDay('2021:12:24 08:30:00', NOW)).toBe('2021-12-24');
  });

  test('a placeholder or impossible date is not a date', () => {
    // exif-reader turns the unset-clock placeholder into a real 1899 Date.
    expect(exifDateValueToIsoDay(new Date(Date.UTC(1899, 10, 30)), NOW)).toBeNull();
    expect(exifDateValueToIsoDay(new Date(Date.UTC(1999, 10, 30)), NOW)).toBe('1999-11-30');
    expect(exifDateValueToIsoDay(new Date(Date.UTC(1979, 11, 31)), NOW)).toBeNull();
    expect(exifDateValueToIsoDay(new Date(NaN), NOW)).toBeNull();
    expect(exifDateValueToIsoDay('0000:00:00 00:00:00', NOW)).toBeNull();
    expect(exifDateValueToIsoDay('2000:00:00 00:00:00', NOW)).toBeNull();
    expect(exifDateValueToIsoDay('2024:13:01 00:00:00', NOW)).toBeNull();
    expect(exifDateValueToIsoDay('not a date', NOW)).toBeNull();
    expect(exifDateValueToIsoDay(null, NOW)).toBeNull();
  });

  test('a date more than a day in the future is a wrong clock, not a capture date', () => {
    expect(exifDateValueToIsoDay(new Date(NOW + 60 * 60 * 1000), NOW)).toBe('2026-10-02');
    expect(exifDateValueToIsoDay(new Date(NOW + 3 * 24 * 60 * 60 * 1000), NOW)).toBeNull();
    expect(exifDateValueToIsoDay('2031:01:01 00:00:00', NOW)).toBeNull();
  });

  test('candidates are tried in order and placeholders fall through', () => {
    const placeholder = new Date(Date.UTC(1899, 10, 30));
    expect(
      pickExifIsoDay(
        {
          Photo: { DateTimeOriginal: placeholder, DateTimeDigitized: placeholder },
          Image: { DateTime: new Date(Date.UTC(2020, 0, 2)) }
        },
        NOW
      )
    ).toBe('2020-01-02');
    expect(pickExifIsoDay({ Photo: { DateTimeOriginal: placeholder } }, NOW)).toBeNull();
    expect(pickExifIsoDay({ exif: { DateTimeDigitized: '2019:06:01 10:00:00' } }, NOW)).toBe(
      '2019-06-01'
    );
    expect(pickExifIsoDay(null, NOW)).toBeNull();
    expect(pickExifIsoDay('string', NOW)).toBeNull();
  });

  test('pickExifDateValue returns the raw candidate that produced the day', () => {
    const good = new Date(Date.UTC(2020, 0, 2));
    expect(
      pickExifDateValue({
        Photo: { DateTimeOriginal: new Date(Date.UTC(1899, 10, 30)) },
        Image: { DateTime: good }
      })
    ).toBe(good);
    expect(pickExifDateValue({})).toBeNull();
  });
});
