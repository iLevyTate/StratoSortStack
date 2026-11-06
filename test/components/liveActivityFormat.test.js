/**
 * View helpers for the Live Activity panel: level filtering, time format,
 * file-name redaction ("Redact paths" on), icon lookup, the problem context
 * tag and the copy-line format.
 */
import {
  LEVEL_FILTER_OPTIONS,
  REDACTED_FILE_LABEL,
  activityContextTag,
  activityEntries,
  filterRawEntries,
  formatCopyLine,
  formatEntryTime,
  levelRank,
  listContexts,
  pickActivityIcon,
  redactActivityText,
  redactRawText
} from '../../src/renderer/components/diagnostics/liveActivityFormat';

const TIME = new Date(2026, 10, 5, 9, 4, 7).toISOString();

function entry(id, overrides = {}) {
  return {
    id,
    time: TIME,
    level: 'info',
    context: 'Test',
    msg: `message ${id}`,
    dataText: '',
    activity: null,
    ...overrides
  };
}

const ANALYZING = {
  kind: 'analyze',
  icon: 'analyze',
  tone: 'info',
  text: 'Analyzing receipt-0412.jpg',
  file: 'receipt-0412.jpg'
};

function problemActivity(text, file) {
  return { kind: 'problem', icon: 'alert', tone: 'warn', text, ...(file ? { file } : {}) };
}

describe('liveActivityFormat', () => {
  test('offers debug, info, warn and error as minimum levels', () => {
    expect(LEVEL_FILTER_OPTIONS).toEqual(['debug', 'info', 'warn', 'error']);
  });

  test('ranks levels and treats unknown levels as info', () => {
    expect(levelRank('trace')).toBeLessThan(levelRank('debug'));
    expect(levelRank('debug')).toBeLessThan(levelRank('info'));
    expect(levelRank('info')).toBeLessThan(levelRank('warn'));
    expect(levelRank('warn')).toBeLessThan(levelRank('error'));
    expect(levelRank('error')).toBeLessThan(levelRank('fatal'));
    expect(levelRank('nonsense')).toBe(levelRank('info'));
    expect(levelRank('constructor')).toBe(levelRank('info'));
  });

  test('formats entry times as local HH:MM:SS', () => {
    expect(formatEntryTime(TIME)).toBe('09:04:07');
    expect(formatEntryTime('not a date')).toBe('--:--:--');
  });

  describe('filters', () => {
    const entries = [
      entry(1, { level: 'debug', context: 'OramaVectorService' }),
      entry(2, { level: 'info', context: 'SmartFolderWatcher', activity: ANALYZING }),
      entry(3, { level: 'warn', context: 'DownloadWatcher' }),
      entry(4, { level: 'error', context: 'SmartFolderWatcher' }),
      entry(5, { level: 'trace', context: '' })
    ];

    test('activityEntries keeps only recognized events', () => {
      expect(activityEntries(entries).map((e) => e.id)).toEqual([2]);
    });

    test('filterRawEntries applies the minimum level', () => {
      expect(filterRawEntries(entries, 'debug', 'all').map((e) => e.id)).toEqual([1, 2, 3, 4]);
      expect(filterRawEntries(entries, 'warn', 'all').map((e) => e.id)).toEqual([3, 4]);
    });

    test('filterRawEntries applies the context filter', () => {
      expect(filterRawEntries(entries, 'debug', 'SmartFolderWatcher').map((e) => e.id)).toEqual([
        2, 4
      ]);
    });

    test('listContexts returns the distinct, non-empty contexts sorted', () => {
      expect(listContexts(entries)).toEqual([
        'DownloadWatcher',
        'OramaVectorService',
        'SmartFolderWatcher'
      ]);
    });
  });

  describe('activity redaction', () => {
    test('hides the file name only when redaction is on', () => {
      expect(redactActivityText(ANALYZING, false)).toBe('Analyzing receipt-0412.jpg');
      expect(redactActivityText(ANALYZING, true)).toBe(`Analyzing ${REDACTED_FILE_LABEL}`);
      expect(
        redactActivityText(
          { kind: 'vision', icon: 'eye', tone: 'info', text: 'Vision batch started' },
          true
        )
      ).toBe('Vision batch started');
    });

    test('hides a name with spaces, brackets and parentheses whole', () => {
      const file = 'Tax [2024] (final) copy.pdf';
      expect(
        redactActivityText(
          problemActivity(`Problem: Could not move ${file} to Archive`, file),
          true
        )
      ).toBe('Problem: Could not move a file to Archive');
    });

    test('hides every occurrence of the name', () => {
      const file = 'notes.txt';
      expect(
        redactActivityText(
          problemActivity(`Problem: Renamed ${file} because ${file} already existed`, file),
          true
        )
      ).toBe('Problem: Renamed a file because a file already existed');
    });

    test('hides overlapping occurrences without leaving a fragment', () => {
      expect(redactActivityText(problemActivity('Problem: saw aXaXa here', 'aXa'), true)).toBe(
        'Problem: saw a file here'
      );
    });

    test('hides the part of a long name that made it into a cut line', () => {
      // The classifier cuts its text at 300 characters; `file` is kept whole,
      // so the line holds only the start of the name before the "…".
      const file = `Quarterly report for the finance team ${'x'.repeat(400)}.pdf`;
      const full = `Problem: Cannot read ${file}`;
      const text = `${full.slice(0, 299)}…`;
      expect(text.includes(file)).toBe(false);
      expect(redactActivityText(problemActivity(text, file), true)).toBe(
        'Problem: Cannot read a file…'
      );
    });

    test('hides a cut name even when only its first character survived the cut', () => {
      expect(
        redactActivityText(problemActivity('Problem: Cannot read r…', 'report.pdf'), true)
      ).toBe('Problem: Cannot read a file…');
    });

    test('hides both a whole occurrence and a cut one at the end', () => {
      const file = 'invoice 2024.pdf';
      const text = `Problem: ${file} clashes with ${file.slice(0, 7)}…`;
      expect(redactActivityText(problemActivity(text, file), true)).toBe(
        'Problem: a file clashes with a file…'
      );
    });

    test('a cut line whose end is not the name keeps its words', () => {
      const file = 'report.pdf';
      const text = `Problem: Could not move ${file} into the archive fold…`;
      expect(redactActivityText(problemActivity(text, file), true)).toBe(
        'Problem: Could not move a file into the archive fold…'
      );
    });

    test('a name the feed itself cut still hides the start that reached the line', () => {
      const file = `${'A'.repeat(1999)}…`;
      const text = `Problem: ${'A'.repeat(290)}…`;
      expect(redactActivityText(problemActivity(text, file), true)).toBe('Problem: a file…');
    });

    test('a line that does not contain the name is left as it is', () => {
      expect(redactActivityText(problemActivity('Problem: Disk is full', 'report.pdf'), true)).toBe(
        'Problem: Disk is full'
      );
    });
  });

  describe('raw redaction', () => {
    test('keeps everything when redaction is off', () => {
      const text = '[SMART-FOLDER-WATCHER] Analyzing file: [REDACTED_PATH]\\receipt.jpg';
      expect(redactRawText(text, false)).toBe(text);
      expect(redactRawText('', true)).toBe('');
    });

    test.each([
      [
        'Windows name with spaces',
        '[SMART-FOLDER-WATCHER] Analyzing file: [REDACTED_PATH]\\receipt 0412.jpg',
        '[SMART-FOLDER-WATCHER] Analyzing file: [REDACTED_PATH]'
      ],
      [
        'Windows name with several words',
        'Moved [REDACTED_PATH]\\My Invoice 2024.pdf',
        'Moved [REDACTED_PATH]'
      ],
      [
        'Windows name with parentheses',
        'Kept [REDACTED_PATH]\\Tax (final).pdf',
        'Kept [REDACTED_PATH]'
      ],
      [
        'two Windows names around an arrow',
        '[DOWNLOAD-WATCHER] Auto-organized with 87% confidence: [REDACTED_PATH]\\a b.pdf => [REDACTED_PATH]\\a b.pdf',
        '[DOWNLOAD-WATCHER] Auto-organized with 87% confidence: [REDACTED_PATH] => [REDACTED_PATH]'
      ],
      [
        'a Windows name never swallows the next token',
        'Merged [REDACTED_PATH]\\a.pdf, [REDACTED_PATH]\\b.pdf',
        'Merged [REDACTED_PATH][REDACTED_PATH]'
      ],
      [
        'a POSIX name never swallows the next token',
        'Merged [REDACTED_PATH]/a.pdf,[REDACTED_PATH]/b.pdf',
        'Merged [REDACTED_PATH][REDACTED_PATH]'
      ],
      [
        'POSIX name stops at whitespace',
        '[FILE-OPS] Deleted file: [REDACTED_PATH]/old.log (120 bytes)',
        '[FILE-OPS] Deleted file: [REDACTED_PATH] (120 bytes)'
      ],
      [
        'POSIX name with a quote inside',
        'Read [REDACTED_PATH]/my"file.pdf ok',
        'Read [REDACTED_PATH] ok'
      ],
      [
        'JSON-escaped Windows path in a file field',
        '{"filePath":"[REDACTED_PATH]\\\\tax.pdf","held":1}',
        '{"filePath":"a file","held":1}'
      ],
      [
        'JSON-escaped Windows name with spaces in another field',
        '{"error":"cannot open [REDACTED_PATH]\\\\My Invoice 2024.pdf","code":"EBUSY"}',
        '{"error":"cannot open [REDACTED_PATH]","code":"EBUSY"}'
      ],
      [
        'POSIX path inside JSON ends at the closing quote',
        '{"error":"cannot open [REDACTED_PATH]/tax.pdf","code":"EBUSY"}',
        '{"error":"cannot open [REDACTED_PATH]","code":"EBUSY"}'
      ],
      [
        'POSIX name with an escaped quote inside JSON',
        '{"note":"[REDACTED_PATH]/say\\"hi\\".txt","n":1}',
        '{"note":"[REDACTED_PATH]","n":1}'
      ],
      [
        'JSON cut inside a path value',
        '{"error":"[REDACTED_PATH]\\\\very long na…',
        '{"error":"[REDACTED_PATH]'
      ],
      [
        'file name field',
        '{"fileName":"receipt.jpg","category":"Financial"}',
        '{"fileName":"a file","category":"Financial"}'
      ],
      [
        'path-like fields, folder names kept',
        '{"oldPath":"[REDACTED_PATH]\\\\a.pdf","newPath":"[REDACTED_PATH]/b.pdf","sourcePath":"x","originalFileName":"y.pdf","folder":"Financial"}',
        '{"oldPath":"a file","newPath":"a file","sourcePath":"a file","originalFileName":"a file","folder":"Financial"}'
      ],
      [
        'file field with an escaped quote',
        '{"fileName":"a\\"b.pdf","n":1}',
        '{"fileName":"a file","n":1}'
      ],
      [
        'keys that merely end in "file" are not file fields; empty values stay empty',
        '{"profile":"default","file":""}',
        '{"profile":"default","file":""}'
      ],
      ['a bare token is left alone', 'Path: [REDACTED_PATH]', 'Path: [REDACTED_PATH]']
    ])('%s', (_label, input, expected) => {
      expect(redactRawText(input, true)).toBe(expected);
    });
  });

  describe('icons', () => {
    const TABLE = { analyze: 'AnalyzeIcon', alert: 'AlertIcon' };

    test('looks a known icon up in the table', () => {
      expect(pickActivityIcon(TABLE, 'analyze', 'Fallback')).toBe('AnalyzeIcon');
    });

    test.each([[''], ['unknown'], ['constructor'], ['toString'], ['__proto__']])(
      'falls back for %p',
      (name) => {
        expect(pickActivityIcon(TABLE, name, 'Fallback')).toBe('Fallback');
      }
    );
  });

  describe('problem context tag', () => {
    test('problem rows carry their context', () => {
      expect(
        activityContextTag(
          entry(1, { context: 'DownloadWatcher', activity: problemActivity('Problem: x') })
        )
      ).toBe('DownloadWatcher');
    });

    test('other rows and problems without a context carry none', () => {
      expect(activityContextTag(entry(1, { activity: ANALYZING }))).toBe('');
      expect(activityContextTag(entry(2, { context: '', activity: problemActivity('P') }))).toBe(
        ''
      );
      expect(activityContextTag(entry(3))).toBe('');
    });
  });

  describe('copy lines', () => {
    test('activity lines are time + text, redacted when asked', () => {
      const e = entry(1, { activity: ANALYZING });
      expect(formatCopyLine(e, 'activity', false)).toBe('09:04:07 Analyzing receipt-0412.jpg');
      expect(formatCopyLine(e, 'activity', true)).toBe('09:04:07 Analyzing a file');
    });

    test('problem lines carry the context name', () => {
      const e = entry(1, {
        level: 'warn',
        context: 'DownloadWatcher',
        activity: problemActivity('Problem: Cannot access file:')
      });
      expect(formatCopyLine(e, 'activity', false)).toBe(
        '09:04:07 Problem: Cannot access file: [DownloadWatcher]'
      );
    });

    test('raw lines are time, padded level, context, message and data', () => {
      const e = entry(1, {
        level: 'warn',
        context: 'DownloadWatcher',
        msg: '[DOWNLOAD-WATCHER] Cannot access file:',
        dataText: '{"filePath":"[REDACTED_PATH]\\\\tax.pdf"}'
      });
      expect(formatCopyLine(e, 'raw', false)).toBe(
        '09:04:07 WARN  [DownloadWatcher] [DOWNLOAD-WATCHER] Cannot access file: {"filePath":"[REDACTED_PATH]\\\\tax.pdf"}'
      );
      expect(formatCopyLine(e, 'raw', true)).toBe(
        '09:04:07 WARN  [DownloadWatcher] [DOWNLOAD-WATCHER] Cannot access file: {"filePath":"a file"}'
      );
    });

    test('raw lines without a context say App and omit empty data', () => {
      expect(formatCopyLine(entry(1, { context: '' }), 'raw', false)).toBe(
        '09:04:07 INFO  [App] message 1'
      );
    });

    test('an entry without an activity copies as a raw line on the Activity tab', () => {
      expect(formatCopyLine(entry(1), 'activity', false)).toBe('09:04:07 INFO  [Test] message 1');
    });
  });
});
