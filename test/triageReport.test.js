const { buildReportRows, toTriageCsv } = require('../src/main/services/triage/triageReport');

describe('triageReport', () => {
  const buckets = {
    keep: [
      {
        filePath: 'C:/dl/report.pdf',
        fileName: 'report.pdf',
        size: 1024,
        mtimeMs: 1750000000000,
        bucket: 'keep',
        signal: 'inside-smart-folder',
        confidence: 0.92,
        why: 'Matches "Finance" smart folder',
        suggestedFolder: { id: 'f1', name: 'Finance', path: 'C:/docs/Finance' }
      }
    ],
    trash: [
      {
        filePath: 'C:/dl/setup (1).exe',
        fileName: 'setup (1).exe',
        size: 2048,
        mtimeMs: 1750000000000,
        bucket: 'trash',
        signal: 'hash-collision',
        confidence: 0.99,
        why: 'Duplicate, "quoted" name'
      }
    ],
    excluded: [],
    ambiguous: [],
    review: [],
    unmatched: []
  };

  describe('buildReportRows', () => {
    test('flattens buckets in stable order with normalized fields', () => {
      const rows = buildReportRows(buckets);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        fileName: 'report.pdf',
        filePath: 'C:/dl/report.pdf',
        bucket: 'keep',
        confidence: 0.92,
        signal: 'inside-smart-folder',
        why: 'Matches "Finance" smart folder',
        sizeBytes: 1024,
        modifiedIso: new Date(1750000000000).toISOString(),
        suggestedFolderPath: 'C:/docs/Finance'
      });
      expect(rows[1].bucket).toBe('trash');
      expect(rows[1].suggestedFolderPath).toBe('');
    });

    test('tolerates missing buckets, records, and fields', () => {
      const rows = buildReportRows({ keep: [null, { filePath: 'C:/x' }], trash: undefined });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        fileName: '',
        filePath: 'C:/x',
        confidence: '',
        sizeBytes: '',
        modifiedIso: ''
      });
    });

    test('returns empty array for non-object input', () => {
      expect(buildReportRows(null)).toEqual([]);
    });
  });

  describe('toTriageCsv', () => {
    test('emits header plus RFC4180-escaped rows', () => {
      const csv = toTriageCsv(buildReportRows(buckets));
      const lines = csv.split('\n');
      expect(lines[0]).toBe(
        'fileName,filePath,bucket,confidence,signal,why,sizeBytes,modifiedIso,suggestedFolderPath'
      );
      // Plain fields stay bare; fields with commas/quotes get RFC 4180
      // quote-doubling (not JSON backslash escaping).
      expect(lines[1]).toContain('report.pdf');
      expect(lines[1]).not.toContain('\\');
      expect(lines[2]).toContain('"Duplicate, ""quoted"" name"');
      expect(csv.endsWith('\n')).toBe(true);
    });

    test('does not mangle Windows backslash paths', () => {
      const csv = toTriageCsv([
        {
          fileName: 'file.pdf',
          filePath: 'C:\\Users\\me\\Downloads\\file.pdf',
          bucket: 'keep',
          confidence: 0.5,
          signal: '',
          why: '',
          sizeBytes: 1,
          modifiedIso: '',
          suggestedFolderPath: ''
        }
      ]);
      expect(csv).toContain('C:\\Users\\me\\Downloads\\file.pdf');
      expect(csv).not.toContain('\\\\');
    });

    test('neutralizes spreadsheet formula-leading cells', () => {
      const csv = toTriageCsv([
        {
          fileName: '=HYPERLINK("http://evil","x").pdf',
          filePath: 'C:/dl/x.pdf',
          bucket: 'keep',
          confidence: 0.5,
          signal: '',
          why: '+SUM(A1)',
          sizeBytes: 1,
          modifiedIso: '',
          suggestedFolderPath: ''
        }
      ]);
      const row = csv.split('\n')[1];
      expect(row.startsWith(`"'=HYPERLINK(`)).toBe(true);
      expect(row).toContain(`'+SUM(A1)`);
      // Numeric cells stay bare numbers.
      expect(row).toContain(',0.5,');
    });

    test('empty rows yields header only', () => {
      expect(toTriageCsv([])).toBe(
        'fileName,filePath,bucket,confidence,signal,why,sizeBytes,modifiedIso,suggestedFolderPath\n'
      );
    });
  });
});
