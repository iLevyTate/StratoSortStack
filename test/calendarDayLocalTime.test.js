/**
 * @jest-environment node
 *
 * Dates in suggested names and analysis results are calendar days as the user
 * sees them. They were read with UTC getters or toISOString, so a file saved
 * in the evening west of Greenwich was named for the next day, and a date
 * written out by the model moved back a day east of it. The history index
 * is the other way round: it is keyed by UTC month, and a range of local
 * days was walked in local months.
 *
 * Jest gives each test file a copy of process.env, so setting TZ here does not
 * reach the runtime. Each zone runs in a child process that sets it first.
 *
 * The child is plain Node, without the module mapping of jest.config.js. One
 * of the modules it loads requires 'electron', and the entry point of that
 * package downloads the Electron binary when it is not on disk yet (a fresh
 * CI runner) and says so on stdout. The probe puts an empty module in its
 * place first, as the mapping does here.
 */

const { execFileSync } = require('child_process');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

const PROBE = `
process.env.TZ = process.argv[1];
require.cache[require.resolve('electron')] = { exports: {}, loaded: true };
const { generateSuggestedNameFromAnalysis, formatDate } = require('./src/shared/namingConventions');
const { toWrittenCalendarDay, toLocalCalendarDay, toLocalCalendarMs } = require('./src/shared/contentDateSanity');
const { buildAnalysisFromModelJson } = require('./src/main/analysis/modelAnalysisResult');
const { getAnalysisByDateRange } = require('./src/main/services/analysisHistory/queries');
const foundInRange = (at, start, end) =>
  getAnalysisByDateRange(
    { entries: { 1: { id: 1, timestamp: at.toISOString(), fileName: 'entry.pdf' } } },
    { dateIndex: { [at.toISOString().substring(0, 7)]: [1] } },
    start,
    end
  ).total;
const settings = {
  convention: 'subject-date',
  separator: '-',
  dateFormat: 'YYYY-MM-DD',
  caseConvention: 'kebab-case'
};
const name = (originalFileName, analysis, fileTimestamps) =>
  generateSuggestedNameFromAnalysis({ originalFileName, analysis, settings, fileTimestamps });
const quiet = { warn() {}, debug() {}, info() {}, error() {} };
process.stdout.write(
  JSON.stringify({
    offsetMinutes: new Date('2026-11-10T01:30:00Z').getTimezoneOffset(),
    modifiedDate: name('notes.txt', { suggestedName: 'Meeting Notes' }, {
      modified: new Date('2026-11-10T01:30:00Z')
    }),
    modifiedString: name('notes.txt', { suggestedName: 'Meeting Notes' }, {
      modified: '2026-11-09T22:30:00.000Z'
    }),
    fileNameDate: name('Report 2026-04-28.pdf', { suggestedName: 'Quarterly Report' }),
    analysisDate: name('scan.pdf', { suggestedName: 'Invoice', date: '2026-04-28' }),
    localMidnight: formatDate(new Date(2026, 3, 28), 'DD-MM-YYYY'),
    written: ['2024-05-05', 'May 5, 2024', '2024-05-05T23:30:00-05:00', '2024', '2024-05'].map(
      toWrittenCalendarDay
    ),
    writtenYearFirst: ['2024 May 5', '2024 June', '2024 May 5 10:00'].map(toWrittenCalendarDay),
    shownDays: ['2024-05-05', '2024-01-01', '2024-12-31', '0024-05-05'].map((day) => {
      const shown = new Date(toLocalCalendarMs(day));
      return [shown.getFullYear(), shown.getMonth() + 1, shown.getDate(), shown.getHours()];
    }),
    shownInstant: toLocalCalendarMs('2024-05-05T03:00:00Z') === Date.parse('2024-05-05T03:00:00Z'),
    shownNothing: [null, undefined, '', 'not a date'].map(toLocalCalendarMs),
    writtenWithZone: ['2024-05-05Z', '2024-05Z', '2024Z', '2024-05-05z'].map(toWrittenCalendarDay),
    writtenOddYears: ['0001-01-01', '0024-05-05', '0099-12-31', '20255-01-01', '19999', '202501'].map(
      toWrittenCalendarDay
    ),
    oddYearModelDates: ['0024-05-05', '20255-01-01', '19999'].map(
      (date) =>
        buildAnalysisFromModelJson(
          { date, category: 'Finance', keywords: ['invoice'], confidence: 80 },
          { originalFileName: 'invoice.pdf', smartFolders: [], fileDate: '2026-01-02', logger: quiet }
        ).date
    ),
    rangeEndingLateOnItsLastDay: foundInRange(
      new Date(2026, 11, 31, 23, 29),
      new Date(2026, 10, 15, 0, 30),
      new Date(2026, 11, 31, 23, 30)
    ),
    rangeStartingEarlyOnItsFirstDay: foundInRange(
      new Date(2026, 11, 10, 12),
      new Date(2026, 10, 15, 0, 30),
      new Date(2026, 11, 20)
    ),
    modelDate: buildAnalysisFromModelJson(
      { date: 'May 5, 2024', category: 'Finance', keywords: ['invoice'], confidence: 80 },
      { originalFileName: 'invoice.pdf', smartFolders: [], logger: quiet }
    ).date
  })
);
`;

const probes = new Map();
function inZone(zone) {
  if (!probes.has(zone)) {
    const out = execFileSync(process.execPath, ['-e', PROBE, zone], {
      cwd: repoRoot,
      encoding: 'utf8',
      // A probe that hangs fails this test, not the whole run.
      timeout: 60 * 1000
    });
    probes.set(zone, JSON.parse(out));
  }
  return probes.get(zone);
}

describe('the probe runs in the zone it names', () => {
  test.each([
    ['America/New_York', 300],
    ['Asia/Tokyo', -540],
    ['Europe/Berlin', -60]
  ])('%s', (zone, offsetMinutes) => {
    expect(inZone(zone).offsetMinutes).toBe(offsetMinutes);
  });
});

describe('suggested names use the local calendar day', () => {
  test('a file saved in the evening west of Greenwich keeps that day', () => {
    // 01:30 UTC on November 10 is 8:30 pm on November 9 in New York.
    expect(inZone('America/New_York').modifiedDate).toBe('meeting-notes-2026-11-09.txt');
  });

  test('a file saved in the morning east of Greenwich keeps that day', () => {
    // 22:30 UTC on November 9 is 7:30 am on November 10 in Tokyo.
    expect(inZone('Asia/Tokyo').modifiedString).toBe('meeting-notes-2026-11-10.txt');
  });

  test.each(['Europe/Berlin', 'Asia/Tokyo', 'America/Los_Angeles'])(
    'a date in the file name stays the same day in %s',
    (zone) => {
      expect(inZone(zone).fileNameDate).toBe('quarterly-report-2026-04-28.pdf');
    }
  );

  test.each(['Europe/Berlin', 'Asia/Tokyo', 'America/Los_Angeles'])(
    'the date of the analysis stays the same day in %s',
    (zone) => {
      expect(inZone(zone).analysisDate).toBe('invoice-2026-04-28.pdf');
    }
  );

  test.each(['Europe/Berlin', 'America/Los_Angeles'])(
    'formatDate reads the day a Date shows locally in %s',
    (zone) => {
      expect(inZone(zone).localMidnight).toBe('28-04-2026');
    }
  );
});

describe('a date the model wrote out is stored as the day written', () => {
  test.each(['Europe/Berlin', 'Asia/Tokyo', 'America/Los_Angeles', 'UTC'])('in %s', (zone) => {
    expect(inZone(zone).written).toEqual([
      '2024-05-05',
      '2024-05-05',
      '2024-05-05',
      '2024-01-01',
      '2024-05-01'
    ]);
    expect(inZone(zone).modelDate).toBe('2024-05-05');
  });

  // Only a date that is nothing but digits and dashes up to its time is kept
  // as written. "2024 May 5" starts with a year too, and was stored as the
  // first of January.
  test.each(['Europe/Berlin', 'Asia/Tokyo', 'America/Los_Angeles', 'UTC'])(
    'a year followed by the month in words keeps its month and day in %s',
    (zone) => {
      expect(inZone(zone).writtenYearFirst).toEqual(['2024-05-05', '2024-06-01', '2024-05-05']);
    }
  );
});

describe('a written date with nothing but a Z after it is the day written', () => {
  // "2024-05-05Z" is midnight UTC. Only "T" or a space was let through after
  // the day, so this one was read as a moment and came out as the 4th west of
  // Greenwich.
  test.each(['America/Los_Angeles', 'America/New_York', 'Europe/Berlin', 'Asia/Tokyo', 'UTC'])(
    'in %s',
    (zone) => {
      expect(inZone(zone).writtenWithZone).toEqual([
        '2024-05-05',
        '2024-05-01',
        '2024-01-01',
        '2024-05-05'
      ]);
    }
  );
});

describe('a stored day is shown as that day', () => {
  // Search results and the time ranges of clusters parsed "2024-05-05" as
  // UTC midnight and formatted it in local time: May 4 west of Greenwich.
  test.each(['America/Los_Angeles', 'America/New_York', 'Europe/Berlin', 'Asia/Tokyo', 'UTC'])(
    'in %s',
    (zone) => {
      expect(inZone(zone).shownDays).toEqual([
        [2024, 5, 5, 0],
        [2024, 1, 1, 0],
        [2024, 12, 31, 0],
        [24, 5, 5, 0]
      ]);
      // A moment in time is still that moment.
      expect(inZone(zone).shownInstant).toBe(true);
      expect(inZone(zone).shownNothing).toEqual([null, null, null, null]);
    }
  );
});

describe('a year that is not four digits of a real year', () => {
  // Date.UTC reads the years 0-99 as 1900-1999, so a misread "0024-05-05"
  // was stored as 1924 and passed the plausibility window. A year of five
  // or six digits parses as that year; its first four digits looked
  // plausible.
  test.each(['America/Los_Angeles', 'Asia/Tokyo', 'UTC'])('in %s', (zone) => {
    expect(inZone(zone).writtenOddYears).toEqual([
      '0001-01-01',
      '0024-05-05',
      '0099-12-31',
      null,
      null,
      null
    ]);
    // None of them is a content date: the file's date is used.
    expect(inZone(zone).oddYearModelDates).toEqual(['2026-01-02', '2026-01-02', '2026-01-02']);
  });
});

describe('a range of local days finds the history entries in it', () => {
  // The index is keyed by the UTC month of each entry. Walking the range in
  // local months and reading the UTC key of each step left out a month:
  // the last one west of Greenwich, the one after the first east of it.
  test('an entry late on the last day, west of Greenwich', () => {
    // 11:29 pm on December 31 in New York is January 1 in UTC.
    expect(inZone('America/New_York').rangeEndingLateOnItsLastDay).toBe(1);
  });

  test('an entry in the last month, east of Greenwich', () => {
    // 12:30 am on the 1st in Tokyo is still the month before in UTC, so
    // every step of the walk named the month before it.
    expect(inZone('Asia/Tokyo').rangeStartingEarlyOnItsFirstDay).toBe(1);
  });

  test.each(['America/Los_Angeles', 'Europe/Berlin', 'Asia/Tokyo', 'UTC'])(
    'both ends in %s',
    (zone) => {
      expect(inZone(zone).rangeEndingLateOnItsLastDay).toBe(1);
      expect(inZone(zone).rangeStartingEarlyOnItsFirstDay).toBe(1);
    }
  );
});

describe('toWrittenCalendarDay', () => {
  const { toWrittenCalendarDay } = require('../src/shared/contentDateSanity');

  test('a day past the end of the month rolls over as Date does', () => {
    expect(toWrittenCalendarDay('2024-02-31')).toBe('2024-03-02');
  });

  test.each([[''], [null], [undefined], ['not a date'], [{}]])('%p is not a date', (value) => {
    expect(toWrittenCalendarDay(value)).toBeNull();
  });
});
