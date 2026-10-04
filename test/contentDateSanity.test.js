/**
 * @jest-environment node
 */
const {
  isPlausibleContentDate,
  CONTENT_DATE_MIN_YEAR
} = require('../src/shared/contentDateSanity');

describe('isPlausibleContentDate (F-158)', () => {
  const now = new Date('2026-07-21T12:00:00Z');

  test('accepts ordinary content years', () => {
    expect(isPlausibleContentDate('2024-05-05', now)).toBe(true);
    expect(isPlausibleContentDate('1900-01-01', now)).toBe(true);
    expect(isPlausibleContentDate('2026-12-31', now)).toBe(true);
  });

  test('accepts one year of future slack (postdated invoices), no more', () => {
    expect(isPlausibleContentDate('2027-01-01', now)).toBe(true);
    expect(isPlausibleContentDate('2028-01-01', now)).toBe(false);
  });

  test('rejects hallucinated and OCR-misread years', () => {
    expect(isPlausibleContentDate('2103-01-01', now)).toBe(false);
    expect(isPlausibleContentDate('0201-05-03', now)).toBe(false);
    expect(isPlausibleContentDate(String(CONTENT_DATE_MIN_YEAR - 1) + '-12-31', now)).toBe(false);
  });

  test('rejects non-strings and short/garbage input', () => {
    expect(isPlausibleContentDate(null, now)).toBe(false);
    expect(isPlausibleContentDate(undefined, now)).toBe(false);
    expect(isPlausibleContentDate('', now)).toBe(false);
    expect(isPlausibleContentDate('20', now)).toBe(false);
    expect(isPlausibleContentDate('May 5, 2024', now)).toBe(false);
  });
});
