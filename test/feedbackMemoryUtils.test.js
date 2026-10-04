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
