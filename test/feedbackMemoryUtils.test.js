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

// Item 16: a correction memory records what was corrected, and two different
// files with the same type and label moved from the same folder into the same
// other folder are a learned correction.
describe('buildMemoryEntry correction', () => {
  const { buildMemoryEntry } = require('../src/main/services/organization/feedbackMemoryUtils');

  test('stores a normalized correction when one is given', () => {
    const entry = buildMemoryEntry('Files like "a.pdf" do not belong in "Invoices".', {
      source: 'feedback_reject',
      targetFolder: 'Invoices',
      correction: { extension: '.PDF', category: '  Invoices ', correctFolder: 'Receipts' }
    });
    expect(entry.correction).toEqual({
      extension: 'pdf',
      category: 'invoices',
      correctFolder: 'Receipts'
    });
  });

  test('keeps a correction without a category, with category null', () => {
    const entry = buildMemoryEntry('note', {
      source: 'feedback_reject',
      correction: { extension: 'pdf', category: null, correctFolder: 'Receipts' }
    });
    expect(entry.correction).toEqual({
      extension: 'pdf',
      category: null,
      correctFolder: 'Receipts'
    });
  });

  test('has no correction when none, or an unusable one, is given', () => {
    expect(buildMemoryEntry('note', { source: 'feedback_reject' })).not.toHaveProperty(
      'correction'
    );
    expect(
      buildMemoryEntry('note', {
        source: 'feedback_reject',
        correction: { extension: 'pdf', category: 'invoices', correctFolder: '  ' }
      })
    ).not.toHaveProperty('correction');
  });
});

describe('findLearnedCorrection', () => {
  const {
    findLearnedCorrection
  } = require('../src/main/services/organization/feedbackMemoryUtils');

  const smartFolders = [
    { id: 'inv', name: 'Invoices', path: '/sf/Invoices' },
    { id: 'rec', name: 'Receipts', path: '/sf/Receipts' },
    { id: 'tax', name: 'Taxes', path: '/sf/Taxes' },
    { id: 'unc', name: 'Uncategorized', path: '/sf/Uncategorized', isDefault: true }
  ];

  let seq = 0;
  /** A correction memory as recordCorrection stores it. */
  const reject = (file, overrides = {}) => ({
    id: `m-${++seq}`,
    text: 'note',
    source: 'feedback_reject',
    targetFolder: 'Invoices',
    filePath: `/sf/Receipts/${file}`,
    correction: { extension: 'pdf', category: 'invoices', correctFolder: 'Receipts' },
    ...overrides
  });

  const find = (memories, extra = {}) =>
    findLearnedCorrection({
      memories,
      extension: 'pdf',
      category: 'invoices',
      fromFolder: 'Invoices',
      smartFolders,
      ...extra
    });

  test('two different files moved the same way are a learned correction', () => {
    expect(find([reject('a.pdf'), reject('b.pdf')])).toEqual({
      folder: smartFolders[1],
      files: 2
    });
  });

  test('one file is not enough', () => {
    expect(find([reject('a.pdf')])).toBeNull();
  });

  test('the same file twice counts once', () => {
    expect(find([reject('a.pdf'), reject('a.pdf')])).toBeNull();
  });

  test('minFiles raises the bar', () => {
    expect(find([reject('a.pdf'), reject('b.pdf')], { minFiles: 3 })).toBeNull();
  });

  test('the top folder must be strictly ahead of any other', () => {
    const toTaxes = (file) =>
      reject(file, {
        filePath: `/sf/Taxes/${file}`,
        correction: { extension: 'pdf', category: 'invoices', correctFolder: 'Taxes' }
      });
    expect(find([reject('a.pdf'), reject('b.pdf'), toTaxes('c.pdf'), toTaxes('d.pdf')])).toBeNull();
    expect(
      find([reject('a.pdf'), reject('b.pdf'), reject('e.pdf'), toTaxes('c.pdf'), toTaxes('d.pdf')])
    ).toEqual({ folder: smartFolders[1], files: 3 });
  });

  test('legacy memories without a correction are ignored', () => {
    const legacy = (file) => {
      const entry = reject(file);
      delete entry.correction;
      return entry;
    };
    expect(find([legacy('a.pdf'), legacy('b.pdf')])).toBeNull();
    expect(find([legacy('a.pdf'), reject('b.pdf')])).toBeNull();
  });

  test('malformed input does not throw', () => {
    expect(
      find([
        null,
        undefined,
        'x',
        { source: 'feedback_reject', correction: 'oops' },
        reject('a.pdf')
      ])
    ).toBeNull();
    expect(findLearnedCorrection({ memories: null })).toBeNull();
    expect(findLearnedCorrection(undefined)).toBeNull();
  });

  test('matching is case-insensitive for type, label and folders', () => {
    const memories = [
      reject('a.pdf', {
        targetFolder: 'INVOICES',
        correction: { extension: 'PDF', category: 'Invoices', correctFolder: 'receipts' }
      }),
      reject('b.pdf')
    ];
    expect(
      find(memories, { extension: '.Pdf', category: 'INVOICES', fromFolder: 'invoices' })
    ).toEqual({ folder: smartFolders[1], files: 2 });
  });

  test.each(['document', 'Images', 'other', 'uncategorized', 'unknown', ''])(
    'a generic label (%p) never learns',
    (label) => {
      const generic = (file) =>
        reject(file, {
          correction: { extension: 'pdf', category: label, correctFolder: 'Receipts' }
        });
      expect(find([generic('a.pdf'), generic('b.pdf')], { category: label })).toBeNull();
    }
  );

  test('only the same type, label and from-folder count', () => {
    const others = [
      reject('a.pdf', {
        correction: { extension: 'png', category: 'invoices', correctFolder: 'Receipts' }
      }),
      reject('b.pdf', {
        correction: { extension: 'pdf', category: 'contracts', correctFolder: 'Receipts' }
      }),
      reject('c.pdf', { targetFolder: 'Taxes' }),
      reject('d.pdf', { source: 'feedback_accept' })
    ];
    expect(find([...others, reject('e.pdf')])).toBeNull();
  });

  test('a folder that is gone, or the catch-all, is never a learned correction', () => {
    const to = (folderName) => (file) =>
      reject(file, {
        correction: { extension: 'pdf', category: 'invoices', correctFolder: folderName }
      });
    expect(find([to('Archive')('a.pdf'), to('Archive')('b.pdf')])).toBeNull();
    expect(find([to('Uncategorized')('a.pdf'), to('Uncategorized')('b.pdf')])).toBeNull();
  });

  test('a correction back into the from-folder is ignored', () => {
    const back = (file) =>
      reject(file, {
        correction: { extension: 'pdf', category: 'invoices', correctFolder: 'Invoices' }
      });
    expect(find([back('a.pdf'), back('b.pdf')])).toBeNull();
  });

  test('entries without a filePath cannot be counted as distinct files', () => {
    expect(
      find([reject('a.pdf', { filePath: null }), reject('b.pdf', { filePath: null })])
    ).toBeNull();
  });
});

describe('findLearnedCorrection review follow-ups', () => {
  const {
    findLearnedCorrection,
    buildMemoryEntry
  } = require('../src/main/services/organization/feedbackMemoryUtils');

  const smartFolders = [
    { id: 'inv', name: 'Invoices', path: '/sf/Invoices' },
    { id: 'p-rec', name: 'Receipts', path: '/sf/Personal/Receipts' },
    { id: 'b-rec', name: 'Receipts', path: '/sf/Business/Receipts' },
    { id: 'tax', name: 'Taxes', path: '/sf/Taxes' }
  ];

  const memory = (file, { from = 'Invoices', to = 'Receipts', ...correction } = {}) => ({
    id: `m-${file}`,
    text: 'note',
    source: 'feedback_reject',
    targetFolder: from,
    filePath: `/sf/x/${file}`,
    correction: { extension: 'pdf', category: 'invoices', correctFolder: to, ...correction }
  });

  const find = (memories) =>
    findLearnedCorrection({
      memories,
      extension: 'pdf',
      category: 'invoices',
      fromFolder: 'Invoices',
      smartFolders
    });

  test('corrections away from the learned folder count against it', () => {
    const learned = [memory('a.pdf'), memory('b.pdf')];
    const back = [
      memory('c.pdf', { from: 'Receipts', to: 'Invoices' }),
      memory('d.pdf', { from: 'Receipts', to: 'Taxes' })
    ];
    expect(find([...learned, ...back])).toBeNull();
    expect(find([...learned, back[0]])).toEqual({ folder: smartFolders[1], files: 2 });
    expect(find([...learned, ...back, memory('e.pdf')])).toEqual({
      folder: smartFolders[1],
      files: 3
    });
  });

  test('contrary corrections for another type or label do not count', () => {
    const learned = [memory('a.pdf'), memory('b.pdf')];
    const other = [
      memory('c.pdf', { from: 'Receipts', to: 'Invoices', extension: 'png' }),
      memory('d.pdf', { from: 'Receipts', to: 'Invoices', category: 'contracts' })
    ];
    expect(find([...learned, ...other])).toEqual({ folder: smartFolders[1], files: 2 });
  });

  test('a recorded folder id picks the right one of two same-named folders', () => {
    const memories = ['a.pdf', 'b.pdf'].map((file) =>
      memory(file, { correctFolderId: 'b-rec', correctFolderPath: '/sf/Business/Receipts' })
    );
    expect(find(memories)).toEqual({ folder: smartFolders[2], files: 2 });
  });

  test('a recorded path is used when the id no longer matches', () => {
    const memories = ['a.pdf', 'b.pdf'].map((file) =>
      memory(file, { correctFolderId: 'gone', correctFolderPath: '/sf/Business/Receipts/' })
    );
    expect(find(memories)).toEqual({ folder: smartFolders[2], files: 2 });
  });

  test('corrections into two same-named folders are counted apart', () => {
    const memories = [
      memory('a.pdf', { correctFolderId: 'b-rec' }),
      memory('b.pdf', { correctFolderId: 'p-rec' })
    ];
    expect(find(memories)).toBeNull();
  });

  test('buildMemoryEntry keeps the folder id and path of a correction', () => {
    const entry = buildMemoryEntry('note', {
      source: 'feedback_reject',
      correction: {
        extension: 'pdf',
        category: 'invoices',
        correctFolder: 'Receipts',
        correctFolderId: 'b-rec',
        correctFolderPath: '/sf/Business/Receipts'
      }
    });
    expect(entry.correction).toEqual({
      extension: 'pdf',
      category: 'invoices',
      correctFolder: 'Receipts',
      correctFolderId: 'b-rec',
      correctFolderPath: '/sf/Business/Receipts'
    });
  });
});
