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
  hideBareFileNames,
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

    test('the end of a word is not taken for the start of a cut name', () => {
      // "folder" ends in "r", which starts "report.pdf", but not at a word start.
      const text = 'Problem: Could not move it into the archive folder…';
      expect(redactActivityText(problemActivity(text, 'report.pdf'), true)).toBe(text);
      expect(
        redactActivityText(problemActivity('Problem: Could not read (rep…', 'report.pdf'), true)
      ).toBe('Problem: Could not read (a file…');
    });

    test("shows a Problem line's own redactedText instead of hiding names by substring", () => {
      const activity = {
        ...problemActivity('Problem: Deleted b: GET http:/health failed', 'b'),
        files: ['b', 'health failed'],
        redactedText: 'Problem: Deleted a file: GET http:/a file'
      };
      expect(redactActivityText(activity, true)).toBe('Problem: Deleted a file: GET http:/a file');
      expect(redactActivityText(activity, false)).toBe(
        'Problem: Deleted b: GET http:/health failed'
      );
    });

    test('hides every name a Problem line lists in files', () => {
      expect(
        redactActivityText(
          {
            ...problemActivity(
              'Problem: Failed to move alpha secret.pdf to beta secret.pdf: EBUSY',
              'alpha secret.pdf to'
            ),
            files: ['alpha secret.pdf to', 'beta secret.pdf']
          },
          true
        )
      ).toBe('Problem: Failed to move a file a file: EBUSY');
    });

    test('applies the cut-line rule to each listed name', () => {
      const second = `beta ${'b'.repeat(400)}.pdf`;
      const full = `Problem: Failed to move a.pdf to ${second}`;
      const text = `${full.slice(0, 299)}…`;
      expect(
        redactActivityText({ ...problemActivity(text, 'a.pdf'), files: ['a.pdf', second] }, true)
      ).toBe('Problem: Failed to move a file to a file…');
    });

    test('ignores a files value that is not a list of names', () => {
      expect(
        redactActivityText({ ...problemActivity('Problem: x.pdf', 'x.pdf'), files: 'x' }, true)
      ).toBe('Problem: a file');
      expect(
        redactActivityText({ ...problemActivity('Problem: y.pdf'), files: [7, '', 'y.pdf'] }, true)
      ).toBe('Problem: a file');
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
        // A forward-slash drive path (C:/...) keeps the spaces in its name, and
        // it cannot be told from a POSIX path, so a "/" name is read like a
        // Windows one: the words after a POSIX name are hidden too.
        'a name after "/" runs like a Windows name',
        '[FILE-OPS] Deleted file: [REDACTED_PATH]/old.log (120 bytes)',
        '[FILE-OPS] Deleted file: [REDACTED_PATH]'
      ],
      [
        'a forward-slash drive name with spaces and brackets',
        'open [REDACTED_PATH]/report [final] (2).pdf: EBUSY',
        'open [REDACTED_PATH]: EBUSY'
      ],
      [
        'a name after "/" with a quote inside',
        'Read [REDACTED_PATH]/my"file.pdf ok',
        'Read [REDACTED_PATH]'
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
      ['a bare token is left alone', 'Path: [REDACTED_PATH]', 'Path: [REDACTED_PATH]'],
      [
        'ipc/analysis.js naming line: original, raw and final',
        '{"convention":"subject-date","caseConvention":"kebab-case","original":"Lab results.pdf","raw":"Blood work","final":"2026-11-05-blood-work.pdf"}',
        '{"convention":"subject-date","caseConvention":"kebab-case","original":"a file","raw":"a file","final":"a file"}'
      ],
      [
        'ipc/semantic.js rebuild failure: path and name',
        String.raw`{"path":"[REDACTED_PATH]\\x.pdf","name":"Quarterly report.pdf","reason":"boom","code":"REBUILD_ERROR"}`,
        '{"path":"a file","name":"a file","reason":"boom","code":"REBUILD_ERROR"}'
      ],
      [
        'FilePathCoordinator copy line: source and dest',
        '{"source":"tax.pdf","dest":"tax (1).pdf"}',
        '{"source":"a file","dest":"a file"}'
      ],
      [
        'a list of names',
        '{"files":["a.pdf","b notes.docx"],"count":2}',
        '{"files":["a file","a file"],"count":2}'
      ],
      [
        'a bare name under an unlisted key',
        '{"message":"x","detail":"scan 2024.png","items":["IMG_2041.HEIC"]}',
        '{"message":"x","detail":"a file","items":["a file"]}'
      ],
      [
        'codes, types, versions and model names survive',
        '{"version":"1.2.3","level":"info","mimeType":"image/jpeg","model":"Qwen2.5-7B-Instruct-Q4_K_M.gguf","code":"storage.full","host":"api.example.com","collections":["files"],"note":"done."}',
        '{"version":"1.2.3","level":"info","mimeType":"image/jpeg","model":"Qwen2.5-7B-Instruct-Q4_K_M.gguf","code":"storage.full","host":"api.example.com","collections":["files"],"note":"done."}'
      ],
      [
        'hosts and addresses survive',
        '{"url":"example.com","uri":"x.example.org","href":"docs.example.net","host":"a.io","hostname":"b.io","domain":"c.io","endpoint":"api.example.com","baseUrl":"llm.local"}',
        '{"url":"example.com","uri":"x.example.org","href":"docs.example.net","host":"a.io","hostname":"b.io","domain":"c.io","endpoint":"api.example.com","baseUrl":"llm.local"}'
      ],
      [
        // Pinned over-redaction: any other value that ends like a file name
        // (a sentence ending in one, a domain under another key) is hidden whole.
        'over-hides other values that end like a file name',
        '{"detail":"see config.json","server":"example.com"}',
        '{"detail":"a file","server":"a file"}'
      ],
      [
        'a name after "/" runs across further folders',
        'Moved [REDACTED_PATH]/My Drive/passport.pdf ok',
        'Moved [REDACTED_PATH]'
      ],
      [
        'a name after "/" still stops before " => " and the next token',
        'Copy [REDACTED_PATH]/Tax Returns/a.pdf => [REDACTED_PATH]/My Drive/b.pdf: EBUSY',
        'Copy [REDACTED_PATH] => [REDACTED_PATH]: EBUSY'
      ],
      [
        'a name after "/" with folders inside JSON stays valid JSON',
        '{"error":"cannot open [REDACTED_PATH]/My Drive/passport.pdf","code":"EBUSY"}',
        '{"error":"cannot open [REDACTED_PATH]","code":"EBUSY"}'
      ],
      [
        'a file field cut at the end of dataText',
        '{"n":1,"fileName":"very long na…',
        '{"n":1,"fileName":"a file…'
      ],
      ['a file field cut without a mark', '{"n":1,"filePath":"abc', '{"n":1,"filePath":"a file'],
      ['quoted names in a message', 'Renamed "a.pdf" to "b c.pdf"', 'Renamed "a file" to "a file"']
    ])('%s', (_label, input, expected) => {
      expect(redactRawText(input, true)).toBe(expected);
    });
  });

  describe('bare file names (no redacted-path token)', () => {
    // src/main/ipc/files/batchOrganizeHandler.js performUUIDFallback logs
    // path.basename(op.source): no [REDACTED_PATH] token precedes the name.
    const UUID_FALLBACK = '[FILE-OPS] Falling back to UUID for tax-return-2025.pdf';

    test('the real UUID fallback line hides its name in Raw and in its Activity line', () => {
      const { activityFromLogRecord } = require('../../src/main/services/liveLogActivity');
      expect(redactRawText(UUID_FALLBACK, true)).toBe('[FILE-OPS] Falling back to UUID for a file');
      expect(redactRawText(UUID_FALLBACK, false)).toBe(UUID_FALLBACK);
      const activity = activityFromLogRecord({
        level: 'warn',
        context: 'IPC:Files:BatchOrganize',
        msg: UUID_FALLBACK
      });
      expect(redactActivityText(activity, true)).toBe('Problem: Falling back to UUID for a file');
      const line = formatCopyLine(
        {
          id: 1,
          time: new Date(2026, 10, 5, 9, 0, 1).toISOString(),
          level: 'warn',
          context: 'IPC:Files:BatchOrganize',
          msg: UUID_FALLBACK,
          dataText: '',
          activity
        },
        'raw',
        true
      );
      expect(line).not.toContain('tax-return');
    });

    test.each([
      [
        'an unquoted name inside a data string',
        '{"error":"opened tax.pdf ok"}',
        '{"error":"opened a file ok"}'
      ],
      ['a name used as a key', '{"tax.pdf":{"size":3}}', '{"a file":{"size":3}}'],
      [
        'a name after a JSON newline escape',
        '{"detail":"line\\ntax.pdf ok"}',
        '{"detail":"line\\na file ok"}'
      ],
      ['a cut value', '{"error":"cannot open tax.pd…', '{"error":"cannot open a file…'],
      ['a name in a plain message', 'opened IMG_2041.HEIC.', 'opened a file.'],
      ['a name in parentheses', 'skipped (b.docx)', 'skipped (a file)'],
      ['a model value stays', '{"model":"Qwen.Q4.bin"}', '{"model":"Qwen.Q4.bin"}'],
      ['a URL value stays', '{"url":"https://x.test/a.pdf"}', '{"url":"https://x.test/a.pdf"}'],
      [
        'a URL in a message stays',
        'GET https://example.com/a.pdf 404',
        'GET https://example.com/a.pdf 404'
      ],
      ['a host stays', 'reach api.anthropic.com', 'reach api.anthropic.com'],
      ['a model file stays', 'load Qwen3-4B-Q4_K_M.gguf', 'load Qwen3-4B-Q4_K_M.gguf'],
      [
        'versions and members stay',
        'v4.0.6 storage.getItem e.g. 1.5',
        'v4.0.6 storage.getItem e.g. 1.5'
      ]
    ])('%s', (_label, input, expected) => {
      expect(redactRawText(input, true)).toBe(expected);
    });

    test('dataText stays valid JSON after hiding bare names', () => {
      const out = redactRawText('{"error":"opened tax.pdf ok","n":1.5,"tax.pdf":true}', true);
      expect(JSON.parse(out)).toEqual({ error: 'opened a file ok', n: 1.5, 'a file': true });
    });

    test('Activity lines hide bare names the classifier did not list', () => {
      expect(
        redactActivityText(
          {
            kind: 'organize',
            icon: 'folder',
            tone: 'success',
            text: 'Renamed a.pdf to b.pdf',
            file: 'a.pdf'
          },
          true
        )
      ).toBe('Renamed a file to a file');
    });

    test('the panel and the classifier find the same bare names', () => {
      const classifier = require('../../src/main/services/liveLogActivity');
      const cases = [
        UUID_FALLBACK,
        'opened tax.pdf ok',
        'Done with IMG_2041.HEIC.',
        'name=foo.docx (1).jpg [x.png]',
        'cut tax.pd…',
        'see https://example.com/a.pdf and api.openai.com',
        'load Qwen3-4B-Q4_K_M.gguf v4.0.6 storage.getItem e.g. i.e. .env .pdf',
        'line\ntax.pdf'
      ];
      for (const value of cases) {
        expect(hideBareFileNames(value)).toBe(classifier.hideBareFileNames(value));
      }
    });
  });

  describe('end to end: real logger and classifier output leaves no file name', () => {
    const { sanitizeLogData } = jest.requireActual('../../src/shared/logger');
    const { activityFromLogRecord } = require('../../src/main/services/liveLogActivity');

    const NAMES = [
      'Zephyr Lab results.pdf',
      'Quokka [2024] (final) draft.docx',
      'Narwhal, Inc; memo.txt',
      'Okapi.pdf'
    ];
    /** Distinctive words of a name (4+ letters or digits). */
    const wordsOf = (name) => name.split(/[^A-Za-z0-9]+/).filter((w) => w.length >= 4);

    /** Raw (unsanitized) log lines naming `name`, and one naming two files. */
    const rawLines = (name) => [
      // Plain templates: in String.raw, `\${name}` would escape the `$`.
      `Failed to move C:\\Users\\jdoe\\Inbox\\${name} to D:\\Archive\\Okapi.pdf: EBUSY`,
      `Failed to move C:\\Users\\jdoe\\a.pdf, C:\\Users\\jdoe\\${name}`,
      `copy \\\\nas\\home\\jdoe\\${name} done`,
      `payload ${JSON.stringify({ from: `C:\\Users\\jdoe\\${name}` })}`,
      `open C:/Users/jdoe/${name} now`,
      `/home/jdoe/docs/${name} could not be read`,
      // The logger cuts a POSIX path at the first whitespace, so a folder
      // with a space leaves the rest of the path after the token.
      `Moved /Users/me/Library/CloudStorage/GoogleDrive-x/My Drive/${name} ok`,
      `/home/me/Documents/Tax Returns/${name}`
    ];

    /** @param {string} output @param {string} name */
    function expectHidden(output, name) {
      expect(output).not.toContain(name);
      for (const word of wordsOf(name)) expect(output).not.toContain(word);
    }

    test.each(NAMES)('%s', (name) => {
      for (const raw of rawLines(name)) {
        expect(raw).toContain(name);
        const msg = sanitizeLogData(raw);
        expect(msg).toContain('[REDACTED_PATH]');
        expect(msg).not.toMatch(/jdoe|Users|Inbox|Archive|nas\b/);
        expectHidden(redactRawText(msg, true), name);

        const activity = activityFromLogRecord({ level: 'warn', context: 'X', msg });
        expect(activity.kind).toBe('problem');
        expectHidden(redactActivityText(activity, true), name);
        expectHidden(redactActivityText(activity, true), 'Okapi.pdf');
      }

      const winPath = `C:\\Users\\jdoe\\${name}`;
      const dataText = JSON.stringify(
        sanitizeLogData({
          filePath: winPath,
          error: `cannot open ${winPath}: EBUSY`,
          detail: `D:/x/${name}`,
          name,
          files: [name]
        })
      );
      expectHidden(redactRawText(dataText, true), name);
      expect(() => JSON.parse(redactRawText(dataText, true))).not.toThrow();
    });

    const SPACED_FOLDER_PATHS = [
      ['/Users/me/Library/CloudStorage/GoogleDrive-x/My Drive/passport.pdf', 'passport'],
      ['/home/me/Documents/Tax Returns/2024 return.pdf', 'return.pdf']
    ];

    test.each(SPACED_FOLDER_PATHS)(
      'Raw tab: a file inside a folder with a space (%s) is hidden',
      (filePath, word) => {
        const msg = sanitizeLogData(`[FILE-OPS] Moved ${filePath} ok`);
        expect(msg).toContain(word); // the logger alone leaves it visible
        const shown = redactRawText(msg, true);
        expect(shown).toBe('[FILE-OPS] Moved [REDACTED_PATH]');
        const dataText = JSON.stringify(sanitizeLogData({ error: `cannot open ${filePath}` }));
        expect(redactRawText(dataText, true)).toBe('{"error":"cannot open [REDACTED_PATH]"}');
      }
    );

    test.each(SPACED_FOLDER_PATHS)(
      'Activity tab: a file inside a folder with a space (%s) is hidden',
      (filePath, word) => {
        const msg = sanitizeLogData(`[FILE-OPS] Moved ${filePath} ok`);
        const activity = activityFromLogRecord({ level: 'warn', context: 'FileOps', msg });
        expect(activity.text).toContain(word);
        expect(redactActivityText(activity, true)).toBe('Problem: Moved a file');
      }
    );

    test.each([
      [
        // "b" (a folder tail) and "health" (a URL tail) would, hidden by
        // substring, also eat letters out of "Problem" and other words.
        '[FILE-OPS] Deleted /srv/data/b: GET http://localhost:8080/api/health failed',
        'Problem: Deleted a file: GET http:/a file'
      ],
      [
        '[CACHE] Deleted /var/cache/health: rebuilt the health index',
        'Problem: Deleted a file: rebuilt the health index'
      ]
    ])('Activity tab: short names do not garble other words (%s)', (raw, expected) => {
      const activity = activityFromLogRecord({
        level: 'warn',
        context: 'X',
        msg: sanitizeLogData(raw)
      });
      expect(redactActivityText(activity, true)).toBe(expected);
    });

    test('Activity tab: a line cut at 300 characters still hides every name', () => {
      const name = `Zephyr ${'long '.repeat(80)}results.pdf`;
      const msg = sanitizeLogData(
        `Failed to move C:\\Users\\jdoe\\${name} to D:\\Archive\\${name}: EBUSY`
      );
      const activity = activityFromLogRecord({ level: 'error', context: 'X', msg });
      expect(activity.text.endsWith('…')).toBe(true);
      const shown = redactActivityText(activity, true);
      expect(shown).toBe('Problem: Failed to move a file a file: EBUSY');
      expectHidden(shown, name);
    });

    test('the classifier and the panel use the same redaction label', () => {
      const classifier = require('../../src/main/services/liveLogActivity');
      expect(classifier.REDACTED_FILE_LABEL).toBe(REDACTED_FILE_LABEL);
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
