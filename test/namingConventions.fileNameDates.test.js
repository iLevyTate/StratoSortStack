/**
 * A date written in the original file name outranks the file's own times in
 * the new name, so only a real day counts: a whole run of digits that names
 * a valid month and day in a plausible year. Order, tracking and account
 * numbers, and dates like 2024-13-45, fall back to the modified time instead
 * of rolling over into an absurd or different date.
 */

const { generateSuggestedNameFromAnalysis } = require('../src/shared/namingConventions');

const settings = {
  convention: 'subject-date',
  separator: '-',
  dateFormat: 'YYYY-MM-DD',
  caseConvention: 'kebab-case'
};
// Local noon, so the modified day is the same in every time zone.
const fileTimestamps = { modified: new Date(2025, 2, 4, 12) };

const nameFor = (originalFileName, suggestedName) =>
  generateSuggestedNameFromAnalysis({
    originalFileName,
    analysis: { suggestedName },
    settings,
    fileTimestamps
  });

describe('generateSuggestedNameFromAnalysis: dates in the file name', () => {
  test('an 8-digit order number is not a date', () => {
    expect(nameFor('Order 98765432.pdf', 'Amazon order receipt')).toBe(
      'amazon-order-receipt-2025-03-04.pdf'
    );
  });

  test('digits inside a longer number are not a date', () => {
    expect(nameFor('Tracking 1Z12345678.pdf', 'Shipping label')).toBe(
      'shipping-label-2025-03-04.pdf'
    );
    expect(nameFor('Account 9920240315.pdf', 'Bank statement')).toBe(
      'bank-statement-2025-03-04.pdf'
    );
  });

  test('a written date with an invalid month or day does not roll over', () => {
    expect(nameFor('Invoice-2024-13-45.pdf', 'Invoice')).toBe('invoice-2025-03-04.pdf');
    expect(nameFor('scan_20240230.pdf', 'Scan')).toBe('scan-2025-03-04.pdf');
  });

  test('a year far in the future is not a date', () => {
    expect(nameFor('Ref 20990101.pdf', 'Reference')).toBe('reference-2025-03-04.pdf');
  });

  test('real written dates still win over the modified time', () => {
    expect(nameFor('report_20240315.pdf', 'Quarterly report')).toBe(
      'quarterly-report-2024-03-15.pdf'
    );
    expect(nameFor('IMG_20240315_123456.jpg', 'Beach sunset')).toBe('beach-sunset-2024-03-15.jpg');
    expect(nameFor('IMG20240315123456.jpg', 'Beach sunset')).toBe('beach-sunset-2024-03-15.jpg');
    expect(nameFor('Invoice 2024-03-15.pdf', 'Invoice')).toBe('invoice-2024-03-15.pdf');
  });

  test('a later valid date is used when an earlier number is not one', () => {
    expect(nameFor('Order 98765432 20240315.pdf', 'Order receipt')).toBe(
      'order-receipt-2024-03-15.pdf'
    );
  });

  test('an invalid written analysis date is ignored', () => {
    expect(
      generateSuggestedNameFromAnalysis({
        originalFileName: 'notes.txt',
        analysis: { suggestedName: 'Notes', date: '2024-02-30' },
        settings,
        fileTimestamps: {}
      })
    ).toBe('notes.txt');
    expect(
      generateSuggestedNameFromAnalysis({
        originalFileName: 'notes.txt',
        analysis: { suggestedName: 'Notes', date: '2024-02-29' },
        settings,
        fileTimestamps: {}
      })
    ).toBe('notes-2024-02-29.txt');
  });
});
