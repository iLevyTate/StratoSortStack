const { csvCell } = require('../../src/shared/csvUtils');

describe('csvCell', () => {
  test('plain strings and numbers pass through bare', () => {
    expect(csvCell('report.pdf')).toBe('report.pdf');
    expect(csvCell(0.92)).toBe('0.92');
    expect(csvCell(-1)).toBe('-1');
    expect(csvCell('')).toBe('');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  test('quotes fields containing delimiters, quotes or line breaks with RFC 4180 doubling', () => {
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('a\nb')).toBe('"a\nb"');
    expect(csvCell('C:\\Users\\me\\file.pdf')).toBe('C:\\Users\\me\\file.pdf');
  });

  test.each([
    ["=cmd|'/c calc'!A1.pdf", `"'=cmd|'/c calc'!A1.pdf"`],
    ['@SUM(1)', `"'@SUM(1)"`],
    ['+1', `"'+1"`],
    ['-1', `"'-1"`],
    ['\tx', `"'\tx"`],
    ['\rx', `"'\rx"`],
    ['=HYPERLINK("http://evil","x")', `"'=HYPERLINK(""http://evil"",""x"")"`]
  ])('neutralizes formula-leading cell %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });
});
