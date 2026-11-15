/**
 * cleanSuggestedName removes an extension the model added and puts back the
 * file's own one. Only a real file type counts as an added extension: a
 * name with an abbreviation or version number keeps everything after its
 * last dot.
 */

const { buildAnalysisFromModelJson } = require('../src/main/analysis/modelAnalysisResult');

const quiet = { info: jest.fn(), warn: jest.fn(), debug: jest.fn() };

const suggestedNameFor = (suggestedName, originalFileName = 'scan.pdf') =>
  buildAnalysisFromModelJson(
    { suggestedName, category: 'Documents', keywords: ['letter'], confidence: 80 },
    { originalFileName, smartFolders: [], logger: quiet }
  ).suggestedName;

describe('buildAnalysisFromModelJson: suggested names with dots', () => {
  test('an abbreviation is not an extension', () => {
    expect(suggestedNameFor('Dr._Smith_referral_letter')).toBe('Dr._Smith_referral_letter.pdf');
    expect(suggestedNameFor('St._Louis_trip_itinerary')).toBe('St._Louis_trip_itinerary.pdf');
    expect(suggestedNameFor('Invoice No. 12345')).toBe('Invoice No. 12345.pdf');
  });

  test('a version number is not an extension', () => {
    expect(suggestedNameFor('Report_v2.1')).toBe('Report_v2.1.pdf');
  });

  test("the file's own extension is not doubled", () => {
    expect(suggestedNameFor('Quarterly_report.PDF')).toBe('Quarterly_report.pdf');
  });

  test('a different real file type the model added is replaced', () => {
    expect(suggestedNameFor('budget_report.docx')).toBe('budget_report.pdf');
  });
});
