/**
 * Payload schema for the Live Activity batch push. safeSend validates every
 * push against it (strict by default) and BLOCKS a payload that fails, which
 * would silently blank the panel, so it must accept everything liveLogFeed
 * can produce and bound everything else.
 */
const { IPC_CHANNELS } = require('../src/shared/constants');
const { validateEventPayload, hasEventSchema } = require('../src/shared/ipcEventSchemas');
const {
  createLiveLogFeed,
  MAX_BATCH_ENTRIES,
  MAX_MSG_CHARS,
  MAX_DATA_TEXT_CHARS,
  MAX_CONTEXT_CHARS,
  MAX_TIME_CHARS,
  MAX_ACTIVITY_KIND_CHARS,
  MAX_ACTIVITY_ICON_CHARS,
  MAX_ACTIVITY_TEXT_CHARS,
  MAX_ACTIVITY_FILE_CHARS
} = require('../src/main/services/liveLogFeed');

const CHANNEL = IPC_CHANNELS.SYSTEM.LIVE_LOG_BATCH;

function entry(overrides = {}) {
  return {
    id: 1,
    time: '2026-11-05T09:00:00.000Z',
    level: 'info',
    context: 'SearchService',
    msg: '[SearchService] BM25 index built with 12 documents',
    dataText: '',
    activity: {
      kind: 'search-index',
      icon: 'search',
      tone: 'success',
      text: 'Search index built (12 documents)'
    },
    ...overrides
  };
}

/** @param {object} payload */
function isValid(payload) {
  return validateEventPayload(CHANNEL, payload).valid;
}

/** @param {object} overrides */
function oneEntryValid(overrides) {
  return isValid({ entries: [entry(overrides)], dropped: 0 });
}

describe('system:live-log:batch event schema', () => {
  test('is registered so safeSend validates every batch', () => {
    expect(hasEventSchema(CHANNEL)).toBe(true);
  });

  test('accepts entries with and without activity', () => {
    expect(
      isValid({
        entries: [
          entry(),
          entry({ id: 2, activity: null, dataText: '{"a":1}' }),
          entry({
            id: 3,
            activity: {
              kind: 'analyze',
              icon: 'analyze',
              tone: 'info',
              text: 'Analyzing a.pdf',
              file: 'a.pdf'
            }
          })
        ],
        dropped: 0
      })
    ).toBe(true);
  });

  test('accepts an empty batch that only reports dropped entries', () => {
    expect(isValid({ entries: [], dropped: 12 })).toBe(true);
  });

  test('accepts every log level the feed emits', () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
      expect(oneEntryValid({ level })).toBe(true);
    }
  });

  test('rejects an unknown level', () => {
    expect(oneEntryValid({ level: 'verbose' })).toBe(false);
  });

  test('rejects an unknown activity tone', () => {
    expect(oneEntryValid({ activity: { kind: 'x', icon: 'y', tone: 'loud', text: 'z' } })).toBe(
      false
    );
  });

  test('rejects a negative or fractional dropped count', () => {
    expect(isValid({ entries: [], dropped: -1 })).toBe(false);
    expect(isValid({ entries: [], dropped: 1.5 })).toBe(false);
  });

  test('rejects a payload without entries', () => {
    expect(isValid({ dropped: 0 })).toBe(false);
  });

  describe('bounds agree with the feed caps (liveLogFeed.js exports)', () => {
    test('entries per batch: MAX_BATCH_ENTRIES', () => {
      const batch = (n) => Array.from({ length: n }, (_, i) => entry({ id: i + 1 }));
      expect(isValid({ entries: batch(MAX_BATCH_ENTRIES), dropped: 0 })).toBe(true);
      expect(isValid({ entries: batch(MAX_BATCH_ENTRIES + 1), dropped: 0 })).toBe(false);
    });

    test('msg: MAX_MSG_CHARS', () => {
      expect(oneEntryValid({ msg: 'x'.repeat(MAX_MSG_CHARS) })).toBe(true);
      expect(oneEntryValid({ msg: 'x'.repeat(MAX_MSG_CHARS + 1) })).toBe(false);
    });

    test('dataText: MAX_DATA_TEXT_CHARS', () => {
      expect(oneEntryValid({ dataText: 'x'.repeat(MAX_DATA_TEXT_CHARS) })).toBe(true);
      expect(oneEntryValid({ dataText: 'x'.repeat(MAX_DATA_TEXT_CHARS + 1) })).toBe(false);
    });

    test('context: MAX_CONTEXT_CHARS', () => {
      expect(oneEntryValid({ context: 'c'.repeat(MAX_CONTEXT_CHARS) })).toBe(true);
      expect(oneEntryValid({ context: 'c'.repeat(MAX_CONTEXT_CHARS + 1) })).toBe(false);
    });

    test('time: MAX_TIME_CHARS', () => {
      expect(oneEntryValid({ time: 't'.repeat(MAX_TIME_CHARS) })).toBe(true);
      expect(oneEntryValid({ time: 't'.repeat(MAX_TIME_CHARS + 1) })).toBe(false);
    });

    test.each([
      ['kind', () => MAX_ACTIVITY_KIND_CHARS],
      ['icon', () => MAX_ACTIVITY_ICON_CHARS],
      ['text', () => MAX_ACTIVITY_TEXT_CHARS],
      ['file', () => MAX_ACTIVITY_FILE_CHARS]
    ])('activity %s: the feed clamp bound', (field, max) => {
      const activity = (n) => ({
        kind: 'problem',
        icon: 'alert',
        tone: 'warn',
        text: 'Problem',
        [field]: 'a'.repeat(n)
      });
      expect(oneEntryValid({ activity: activity(max()) })).toBe(true);
      expect(oneEntryValid({ activity: activity(max() + 1) })).toBe(false);
    });
  });

  describe('real liveLogFeed output passes the schema', () => {
    /** Run records through a real feed (real classifier) and return the batches it sends. */
    function feedBatches(records) {
      /** @type {Array<{ entries: any[], dropped: number }>} */
      const sent = [];
      let onRecord = null;
      const feed = createLiveLogFeed({
        addListener: (listener) => {
          onRecord = listener;
        },
        send: (_webContents, payload) => {
          sent.push(payload);
        }
      });
      const webContents = { send: jest.fn() };
      feed.subscribe(webContents);
      for (const record of records) onRecord(record);
      feed.flush();
      feed.unsubscribe(webContents);
      return sent;
    }

    function expectAllValid(batches) {
      expect(batches.length).toBeGreaterThan(0);
      for (const batch of batches) {
        const result = validateEventPayload(CHANNEL, batch);
        if (!result.valid) throw new Error(JSON.stringify(result.error?.issues ?? result.error));
        expect(result.valid).toBe(true);
      }
    }

    test('oversize msg, data, context and time, odd levels and a long-file problem', () => {
      const nested = { a: { b: { c: { d: { e: 'deep'.repeat(500) } } } } };
      const batches = feedBatches([
        {
          time: 'T'.repeat(500),
          level: 'info',
          context: 'C'.repeat(5000),
          msg: 'm'.repeat(50_000),
          data: { big: 'y'.repeat(100_000), arr: Array(10_000).fill(1), nested }
        },
        {
          time: '2026-11-05T09:00:00.000Z',
          level: 'warn',
          context: 'SomeService',
          msg: `[REDACTED_PATH]\\${'f'.repeat(10_000)}`
        },
        {
          time: '2026-11-05T09:00:00.000Z',
          level: 'error',
          context: 'Other',
          msg: `[TAG] Failed on [REDACTED_PATH]/${'g'.repeat(10_000)} hard`,
          data: { error: 'boom', stack: 's'.repeat(20_000) }
        },
        {
          time: 12345,
          level: 'verbose',
          context: undefined,
          msg: { not: 'a string' },
          data: 'plain string data'
        },
        {
          time: '2026-11-05T09:00:00.000Z',
          level: 'fatal',
          context: 'DocumentAnalysis',
          msg: 'Analyzing document file',
          data: { path: `[REDACTED_PATH]\\${'n'.repeat(5000)}.pdf` }
        },
        {
          time: '2026-11-05T09:00:00.000Z',
          level: 'warn',
          context: 'DegradedStateTracker',
          msg: '[DegradedState] flag raised',
          data: { code: 'x.y', message: `Lost [REDACTED_PATH]\\${'q'.repeat(3000)}` }
        },
        {
          time: '2026-11-05T09:00:00.000Z',
          level: 'trace',
          context: 'X',
          msg: '',
          data: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, i]))
        }
      ]);
      expectAllValid(batches);

      const entries = batches.flatMap((b) => b.entries);
      // The fixtures really exercised the caps and the long-file problem path.
      expect(entries.some((e) => e.msg.length === MAX_MSG_CHARS)).toBe(true);
      expect(entries.some((e) => e.dataText.length > MAX_DATA_TEXT_CHARS - 50)).toBe(true);
      expect(entries.some((e) => e.context.length === MAX_CONTEXT_CHARS)).toBe(true);
      expect(entries.some((e) => e.time.length === MAX_TIME_CHARS)).toBe(true);
      expect(entries.some((e) => e.activity === null)).toBe(true);
      const longProblemFile = entries
        .map((e) => e.activity)
        .filter((a) => a && a.kind === 'problem' && typeof a.file === 'string')
        .reduce((max, a) => Math.max(max, a.file.length), 0);
      expect(longProblemFile).toBeGreaterThan(1000);
      const degraded = entries.find((e) => e.context === 'DegradedStateTracker');
      expect(degraded.activity.kind).toBe('problem');
      expect(degraded.activity.file.length).toBeGreaterThan(1000);
    });

    test('a flood beyond the batch caps ships a bounded batch with a dropped count', () => {
      const records = Array.from({ length: 700 }, (_, i) => ({
        time: '2026-11-05T09:00:00.000Z',
        level: i % 2 ? 'warn' : 'info',
        context: 'Flood',
        msg: `line ${i} ${'x'.repeat(3000)}`,
        data: { i, payload: 'z'.repeat(3000) }
      }));
      const batches = feedBatches(records);
      expectAllValid(batches);
      expect(batches[0].entries.length).toBeLessThanOrEqual(MAX_BATCH_ENTRIES);
      expect(batches[0].dropped).toBeGreaterThan(0);
    });
  });
});
