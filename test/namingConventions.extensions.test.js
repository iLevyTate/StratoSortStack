/**
 * The new name keeps the file's whole extension (.tar.gz, not .gz), and only
 * a real file type is removed from a suggested name: the dots of "St. Louis"
 * or "v2.1" are part of the subject.
 */

const {
  generateSuggestedNameFromAnalysis,
  generatePreviewName,
  trailingFileExtension
} = require('../src/shared/namingConventions');

const settings = {
  convention: 'subject-date',
  separator: '-',
  dateFormat: 'YYYY-MM-DD',
  caseConvention: 'kebab-case'
};
const fileTimestamps = { modified: new Date(2025, 2, 4, 12) };

const nameFor = (originalFileName, suggestedName, overrides = {}) =>
  generateSuggestedNameFromAnalysis({
    originalFileName,
    analysis: suggestedName === undefined ? {} : { suggestedName },
    settings: { ...settings, ...overrides },
    fileTimestamps
  });

describe('generateSuggestedNameFromAnalysis: compound extensions', () => {
  test('a .tar.gz keeps .tar.gz', () => {
    expect(nameFor('logs.tar.gz', undefined)).toBe('logs-2025-03-04.tar.gz');
    expect(nameFor('logs.tar.gz', 'server logs backup')).toBe(
      'server-logs-backup-2025-03-04.tar.gz'
    );
    expect(nameFor('logs.tar.gz', 'logs.tar.gz')).toBe('logs-2025-03-04.tar.gz');
  });

  test('the fallback name for an archive does not leave "tar" in the subject', () => {
    // safeSuggestedName flattens logs.tar.gz to logs_tar.gz
    expect(nameFor('logs.tar.gz', 'logs_tar.gz')).toBe('logs-2025-03-04.tar.gz');
  });

  test('keep-original keeps the whole name', () => {
    expect(nameFor('logs.tar.gz', 'x', { convention: 'keep-original' })).toBe('logs.tar.gz');
  });

  test('the preview keeps .tar.gz too', () => {
    expect(
      generatePreviewName('logs.tar.gz', {
        convention: 'category-subject',
        separator: '-',
        dateFormat: 'YYYY-MM-DD',
        caseConvention: 'kebab-case'
      })
    ).toBe('category-logs.tar.gz');
  });
});

describe('generateSuggestedNameFromAnalysis: dots inside a suggested name', () => {
  test('a dotted subject with no extension stays whole', () => {
    expect(nameFor('scan.pdf', 'St._Louis_trip_itinerary')).toBe(
      'st-louis-trip-itinerary-2025-03-04.pdf'
    );
    expect(nameFor('scan.pdf', 'Invoice No. 12345')).toBe('invoice-no-12345-2025-03-04.pdf');
  });

  test("the file's own extension is removed in any case", () => {
    expect(nameFor('scan.pdf', 'St._Louis_trip_itinerary.PDF')).toBe(
      'st-louis-trip-itinerary-2025-03-04.pdf'
    );
  });

  test('another real file type is still removed', () => {
    expect(nameFor('scan.pdf', 'budget_report.docx')).toBe('budget-report-2025-03-04.pdf');
  });
});

describe('trailingFileExtension', () => {
  test.each([
    ['report.pdf', '.pdf'],
    ['PHOTO.JPG', '.JPG'],
    ['song.mp3', '.mp3'],
    ['Receipt from J. Smith', ''],
    ['Notes v1.2', ''],
    ['St._Louis', ''],
    ['Dr.Smith', ''],
    ['.env', ''],
    ['plain', '']
  ])('%s -> %s', (name, ext) => {
    expect(trailingFileExtension(name)).toBe(ext);
  });
});
