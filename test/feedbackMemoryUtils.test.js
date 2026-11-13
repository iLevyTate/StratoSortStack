jest.mock('crypto', () => ({
  randomUUID: jest.fn(() => 'uuid-1')
}));

const {
  normalizeText,
  parseRuleFromText,
  buildMemoryEntry,
  applyMemoryRuleAdjustments
} = require('../src/main/services/organization/feedbackMemoryUtils');

describe('feedbackMemoryUtils', () => {
  test('normalizeText trims and caps length', () => {
    const result = normalizeText('  hello  ');
    expect(result).toBe('hello');
  });

  test('parseRuleFromText extracts extension rule', () => {
    const result = parseRuleFromText('.pdf -> Finance');
    expect(result.targetFolder).toBe('Finance');
    expect(result.rules[0]).toMatchObject({
      type: 'extension_to_folder',
      extension: 'pdf',
      folder: 'Finance'
    });
  });

  test('buildMemoryEntry returns null for empty input', () => {
    expect(buildMemoryEntry('')).toBeNull();
  });

  test('applyMemoryRuleAdjustments boosts matching folder', () => {
    const result = applyMemoryRuleAdjustments({
      fileExtension: '.pdf',
      suggestionFolder: 'Finance',
      rules: [{ type: 'extension_to_folder', extension: 'pdf', folder: 'Finance' }]
    });
    expect(result.boost).toBeGreaterThan(0);
  });
});

// F-202: correction memories must be attributable to the file they were
// recorded for, so an undo can find and remove them.
describe('buildMemoryEntry provenance [F-202]', () => {
  const { buildMemoryEntry } = require('../src/main/services/organization/feedbackMemoryUtils');

  test('keeps a normalized filePath when provided', () => {
    const { normalizePathForIndex } = require('../src/shared/pathSanitization');
    const entry = buildMemoryEntry('Files like "q1.pdf" do not belong in "Photos".', {
      source: 'feedback_reject',
      targetFolder: 'Photos',
      filePath: 'C:\\Docs\\Finance\\q1.pdf'
    });
    // Stored under the same key undo looks it up by. Case-folding is
    // platform-dependent (Windows/macOS fold, Linux does not); separators are
    // forward slashes everywhere.
    expect(entry.filePath).toBe(normalizePathForIndex('C:\\Docs\\Finance\\q1.pdf'));
    expect(entry.filePath).not.toContain('\\');
  });

  test('omits filePath when not provided', () => {
    const entry = buildMemoryEntry('Files like "x" belong in "Y".', { source: 'manual' });
    expect(entry.filePath).toBeNull();
  });
});

// A rule typed the natural way ("CSV files go to Bing") must create a rule,
// and a generated correction note must never create one: the newest rule per
// extension wins, so a junk rule replaces the user's real one.
describe('parseRuleFromText without a dot and for generated notes', () => {
  const {
    parseRuleFromText,
    buildMemoryEntry
  } = require('../src/main/services/organization/feedbackMemoryUtils');

  test.each([
    ['csv files go to Bing', 'csv', 'Bing'],
    ['All CSV files go to Bing', 'csv', 'Bing'],
    ['PDF files should go to Contracts', 'pdf', 'Contracts'],
    ['xlsx -> GSC', 'xlsx', 'GSC'],
    ['All .stl files go to 3D Prints', 'stl', '3D Prints']
  ])('"%s" is a rule for .%s', (text, extension, folder) => {
    expect(parseRuleFromText(text).rules).toEqual([
      expect.objectContaining({ type: 'extension_to_folder', extension, folder })
    ]);
  });

  test.each(['Client files go to Clients', 'Old files go to Archive', 'Files like these go to X'])(
    '"%s" names no file type and makes no rule',
    (text) => {
      expect(parseRuleFromText(text).rules).toEqual([]);
    }
  );

  test('a correction note keeps its target but makes no rule', () => {
    const entry = buildMemoryEntry(
      'Files like "Bing Keywords 2026-10-01 to 2026-10-31.csv" do not belong in "GSC"; they belong in "Bing".',
      { source: 'feedback_reject', targetFolder: 'GSC' }
    );
    expect(entry.rules).toEqual([]);
    expect(entry.targetFolder).toBe('GSC');
  });

  test('a note about "Report.pdf to client.pdf" cannot replace the .pdf rule', () => {
    const entry = buildMemoryEntry(
      'Files like "Report.pdf to client.pdf" do not belong in "Photos"; they belong in "Clients".',
      { source: 'feedback_reject', targetFolder: 'Photos' }
    );
    expect(entry.rules).toEqual([]);
  });

  test('a note the user types in Memory & Rules still makes a rule', () => {
    expect(buildMemoryEntry('csv files go to Bing').rules).toEqual([
      expect.objectContaining({ extension: 'csv', folder: 'Bing' })
    ]);
  });
});
