/**
 * The CSV a user saves after an organize run: one line per file, in words a
 * spreadsheet shows as they are.
 */

const { toOrganizeReportCsv } = require('../src/main/services/organize/organizeReport');

const BOM = '\uFEFF';

describe('toOrganizeReportCsv', () => {
  test('starts with a BOM and the header, and ends with a newline', () => {
    const csv = toOrganizeReportCsv([]);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv).toBe(`${BOM}File,Outcome,Details,Original location,Final location\r\n`);
  });

  test.each([
    ['moved', 'Moved'],
    ['duplicate', 'Duplicate removed'],
    ['failed', 'Failed'],
    ['notMoved', 'Not moved'],
    ['restored', 'Returned'],
    ['leftAtDestination', 'Not returned']
  ])('outcome %s reads "%s"', (outcome, word) => {
    const csv = toOrganizeReportCsv([
      { name: 'a.csv', originalPath: '/in/a.csv', finalPath: '/out/a.csv', outcome, reason: '' }
    ]);
    const line = csv.split('\r\n')[1];
    expect(line.startsWith(`a.csv,${word},`)).toBe(true);
    expect(line.endsWith(',/in/a.csv,/out/a.csv')).toBe(true);
  });

  test('a removed duplicate says its copy was already there', () => {
    const csv = toOrganizeReportCsv([
      {
        name: 'a (1).csv',
        originalPath: '/in/a (1).csv',
        finalPath: '/out/a.csv',
        outcome: 'duplicate',
        reason: 'This copy is in the system Trash.'
      }
    ]);
    expect(csv.split('\r\n')[1]).toBe(
      'a (1).csv,Duplicate removed,An identical copy was already there. This copy is in the system Trash.,/in/a (1).csv,/out/a.csv'
    );
  });

  test('quotes a path with a comma or a quote', () => {
    const csv = toOrganizeReportCsv([
      {
        name: 'q "1".csv',
        originalPath: 'C:\\In\\GSC, 2026\\q "1".csv',
        finalPath: null,
        outcome: 'failed',
        reason: 'Access denied.'
      }
    ]);
    expect(csv.split('\r\n')[1]).toBe(
      '"q ""1"".csv",Failed,Access denied.,"C:\\In\\GSC, 2026\\q ""1"".csv",'
    );
  });

  test('a name a spreadsheet would run as a formula is kept as text', () => {
    const csv = toOrganizeReportCsv([
      { name: '=HYPERLINK("x").csv', originalPath: '/in/x', finalPath: '/out/x', outcome: 'moved' }
    ]);
    expect(csv.split('\r\n')[1].startsWith('"\'=HYPERLINK(""x"").csv",Moved')).toBe(true);
  });

  test('a renamed file says so in Details', () => {
    const csv = toOrganizeReportCsv([
      {
        name: 'a.pdf',
        originalPath: '/in/a.pdf',
        finalPath: '/out/a (1).pdf',
        outcome: 'moved',
        renamedOnCollision: true
      }
    ]);
    expect(csv.split('\r\n')[1]).toBe(
      'a.pdf,Moved,Renamed: a file with this name was already there.,/in/a.pdf,/out/a (1).pdf'
    );
  });
});
