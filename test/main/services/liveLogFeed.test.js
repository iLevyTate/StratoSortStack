/**
 * liveLogFeed: the main-process side of the Live Activity panel. It listens
 * to the logger only while a window is subscribed, keeps a bounded backlog,
 * and pushes small batches on a 250 ms cadence.
 */
const { EventEmitter } = require('events');
const {
  createLiveLogFeed,
  getLiveLogFeed,
  RING_CAPACITY,
  FLUSH_INTERVAL_MS,
  MAX_BATCH_ENTRIES,
  MAX_MSG_CHARS,
  MAX_BATCH_CHARS,
  MAX_DATA_TEXT_CHARS,
  MAX_CONTEXT_CHARS,
  ACTIVITY_MERGE_WINDOW_MS,
  MERGEABLE_KINDS
} = require('../../../src/main/services/liveLogFeed');

function makeRegistry() {
  const listeners = new Set();
  return {
    listeners,
    addListener: jest.fn((fn) => listeners.add(fn)),
    removeListener: jest.fn((fn) => listeners.delete(fn)),
    emit(record) {
      for (const fn of [...listeners]) fn(record);
    }
  };
}

function makeWebContents() {
  const wc = new EventEmitter();
  wc.destroyed = false;
  wc.send = jest.fn();
  wc.isDestroyed = () => wc.destroyed;
  return wc;
}

function record(n, overrides = {}) {
  return {
    time: '2026-11-05T09:00:00.000Z',
    level: 'info',
    context: 'Test',
    msg: `message ${n}`,
    data: undefined,
    ...overrides
  };
}

function makeFeed(overrides = {}) {
  const registry = makeRegistry();
  const send = jest.fn();
  const classify = jest.fn(() => null);
  const feed = createLiveLogFeed({
    addListener: registry.addListener,
    removeListener: registry.removeListener,
    classify,
    send,
    ...overrides
  });
  return { feed, registry, send, classify };
}

const DETACH_EVENTS = ['destroyed', 'render-process-gone', 'did-navigate'];

const IDLE = { subscribers: 0, listening: false, buffered: 0, pending: 0, timerActive: false };

describe('liveLogFeed', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('registers no logger listener and no timer while nobody is subscribed', () => {
    const { feed, registry } = makeFeed();
    expect(registry.addListener).not.toHaveBeenCalled();
    expect(feed.getStats()).toEqual(IDLE);
  });

  test('the first subscriber registers the listener once and gets an empty backlog', () => {
    const { feed, registry } = makeFeed();
    const wc = makeWebContents();

    expect(feed.subscribe(wc)).toEqual({ entries: [] });
    expect(feed.subscribe(wc)).toEqual({ entries: [] });

    expect(registry.addListener).toHaveBeenCalledTimes(1);
    expect(feed.getStats()).toEqual({ ...IDLE, subscribers: 1, listening: true });
  });

  test('a subscriber without a send method is refused', () => {
    const { feed, registry } = makeFeed();
    expect(feed.subscribe(null)).toEqual({ entries: [] });
    expect(feed.subscribe({})).toEqual({ entries: [] });
    expect(registry.addListener).not.toHaveBeenCalled();
  });

  test('a later subscriber receives the backlog with ids and classified activity', () => {
    const classify = jest.fn((r) =>
      r.msg === 'message 2' ? { kind: 'k', icon: 'i', tone: 'info', text: 'two' } : null
    );
    const { feed, registry } = makeFeed({ classify });
    feed.subscribe(makeWebContents());

    registry.emit(record(1, { data: { count: 3 } }));
    registry.emit(record(2));

    expect(feed.subscribe(makeWebContents()).entries).toEqual([
      {
        id: 1,
        time: '2026-11-05T09:00:00.000Z',
        level: 'info',
        context: 'Test',
        msg: 'message 1',
        dataText: '{"count":3}',
        activity: null
      },
      {
        id: 2,
        time: '2026-11-05T09:00:00.000Z',
        level: 'info',
        context: 'Test',
        msg: 'message 2',
        dataText: '',
        activity: { kind: 'k', icon: 'i', tone: 'info', text: 'two' }
      }
    ]);
  });

  test('sends one batch per 250 ms window to every subscriber, then idles', () => {
    const { feed, registry, send } = makeFeed();
    const a = makeWebContents();
    const b = makeWebContents();
    feed.subscribe(a);
    feed.subscribe(b);

    registry.emit(record(1));
    registry.emit(record(2));
    registry.emit(record(3));

    jest.advanceTimersByTime(FLUSH_INTERVAL_MS - 1);
    expect(send).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toBe(a);
    expect(send.mock.calls[1][0]).toBe(b);
    const payload = send.mock.calls[0][1];
    expect(payload.dropped).toBe(0);
    expect(payload.entries.map((e) => e.id)).toEqual([1, 2, 3]);

    jest.advanceTimersByTime(FLUSH_INTERVAL_MS * 4);
    expect(send).toHaveBeenCalledTimes(2);
    expect(feed.getStats().timerActive).toBe(false);
  });

  test('caps a batch at 200 entries, dropping the oldest and counting them', () => {
    const { feed, registry, send } = makeFeed();
    feed.subscribe(makeWebContents());

    for (let i = 1; i <= MAX_BATCH_ENTRIES + 50; i += 1) registry.emit(record(i));
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);

    const payload = send.mock.calls[0][1];
    expect(payload.entries).toHaveLength(MAX_BATCH_ENTRIES);
    expect(payload.entries[0].id).toBe(51);
    expect(payload.entries[MAX_BATCH_ENTRIES - 1].id).toBe(250);
    expect(payload.dropped).toBe(50);
  });

  test('caps a batch at MAX_BATCH_CHARS (msg + dataText), dropping the oldest and counting them', () => {
    const { feed, registry, send } = makeFeed();
    feed.subscribe(makeWebContents());
    const fit = Math.floor(MAX_BATCH_CHARS / MAX_MSG_CHARS);

    for (let i = 1; i <= fit + 22; i += 1) {
      registry.emit(record(i, { msg: `${i}`.padEnd(MAX_MSG_CHARS + 5, 'x') }));
    }
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);

    const payload = send.mock.calls[0][1];
    expect(payload.entries).toHaveLength(fit);
    expect(payload.entries[0].id).toBe(23);
    expect(payload.entries[fit - 1].id).toBe(fit + 22);
    expect(payload.dropped).toBe(22);
    const chars = payload.entries.reduce((n, e) => n + e.msg.length + e.dataText.length, 0);
    expect(chars).toBeLessThanOrEqual(MAX_BATCH_CHARS);
  });

  test('the subscribe backlog keeps the newest entries within MAX_BATCH_CHARS', () => {
    const { feed, registry } = makeFeed();
    feed.subscribe(makeWebContents());
    const fit = Math.floor(MAX_BATCH_CHARS / MAX_MSG_CHARS);

    for (let i = 1; i <= fit + 10; i += 1) {
      registry.emit(record(i, { msg: 'y'.repeat(MAX_MSG_CHARS) }));
      jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
    }

    const { entries } = feed.subscribe(makeWebContents());
    expect(feed.getStats().buffered).toBe(fit + 10);
    expect(entries).toHaveLength(fit);
    expect(entries[0].id).toBe(11);
    expect(entries[fit - 1].id).toBe(fit + 10);
  });

  test('keeps only the last 500 entries for the backlog', () => {
    const { feed, registry } = makeFeed();
    feed.subscribe(makeWebContents());

    for (let i = 1; i <= RING_CAPACITY + 100; i += 1) {
      registry.emit(record(i));
      if (i % 100 === 0) jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
    }

    const { entries } = feed.subscribe(makeWebContents());
    expect(entries).toHaveLength(RING_CAPACITY);
    expect(entries[0].id).toBe(101);
    expect(entries[RING_CAPACITY - 1].id).toBe(RING_CAPACITY + 100);
  });

  test('drops a subscriber when its webContents is destroyed', () => {
    const { feed, registry, send } = makeFeed();
    const wc = makeWebContents();
    feed.subscribe(wc);
    registry.emit(record(1));

    wc.destroyed = true;
    wc.emit('destroyed');

    expect(feed.getStats()).toEqual(IDLE);
    expect(registry.removeListener).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(send).not.toHaveBeenCalled();
  });

  test.each([
    ['render-process-gone', [{}, { reason: 'crashed', exitCode: 1 }]],
    ['did-navigate', [{}, 'app://index.html', 200, 'OK']]
  ])(
    'drops a subscriber when %s fires (crash recovery / reload reuse the webContents)',
    (event, args) => {
      const { feed, registry, send } = makeFeed();
      const wc = makeWebContents();
      feed.subscribe(wc);
      registry.emit(record(1));

      wc.emit(event, ...args);

      expect(feed.getStats()).toEqual(IDLE);
      expect(registry.removeListener).toHaveBeenCalledTimes(1);
      for (const name of DETACH_EVENTS) expect(wc.listenerCount(name)).toBe(0);
      jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
      expect(send).not.toHaveBeenCalled();
    }
  );

  test('the reloaded page can subscribe the same webContents again', () => {
    const { feed, registry, send } = makeFeed();
    const wc = makeWebContents();
    feed.subscribe(wc);
    wc.emit('did-navigate', {}, 'app://index.html');

    expect(feed.subscribe(wc)).toEqual({ entries: [] });
    expect(feed.getStats()).toMatchObject({ subscribers: 1, listening: true });
    for (const name of DETACH_EVENTS) expect(wc.listenerCount(name)).toBe(1);

    registry.emit(record(1));
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe(wc);
  });

  test('a crashed window leaves the other subscribers and the backlog alone', () => {
    const { feed, registry } = makeFeed();
    const a = makeWebContents();
    const b = makeWebContents();
    feed.subscribe(a);
    feed.subscribe(b);
    registry.emit(record(1));

    a.emit('render-process-gone', {}, { reason: 'oom' });

    expect(feed.getStats()).toMatchObject({ subscribers: 1, listening: true, buffered: 1 });
    for (const name of DETACH_EVENTS) {
      expect(a.listenerCount(name)).toBe(0);
      expect(b.listenerCount(name)).toBe(1);
    }
  });

  test('subscribing the same webContents twice registers its detach handlers once', () => {
    const { feed } = makeFeed();
    const wc = makeWebContents();
    feed.subscribe(wc);
    feed.subscribe(wc);
    for (const name of DETACH_EVENTS) expect(wc.listenerCount(name)).toBe(1);
  });

  test('removes the listener and clears buffers only on the last unsubscribe', () => {
    const { feed, registry } = makeFeed();
    const a = makeWebContents();
    const b = makeWebContents();
    feed.subscribe(a);
    feed.subscribe(b);
    registry.emit(record(1));

    feed.unsubscribe(a);
    expect(registry.removeListener).not.toHaveBeenCalled();
    expect(feed.getStats().listening).toBe(true);

    feed.unsubscribe(b);
    expect(registry.removeListener).toHaveBeenCalledTimes(1);
    expect(feed.getStats()).toEqual(IDLE);
    for (const event of DETACH_EVENTS) expect(b.listenerCount(event)).toBe(0);

    expect(feed.subscribe(makeWebContents()).entries).toEqual([]);
  });

  test('unsubscribing an unknown webContents is a no-op', () => {
    const { feed, registry } = makeFeed();
    feed.subscribe(makeWebContents());
    feed.unsubscribe(makeWebContents());
    feed.unsubscribe(null);
    expect(registry.removeListener).not.toHaveBeenCalled();
  });

  test('ignores records logged while a batch is being delivered (no feedback loop)', () => {
    const registry = makeRegistry();
    const send = jest.fn(() => registry.emit(record(99, { level: 'warn', msg: 'send failed' })));
    const feed = createLiveLogFeed({
      addListener: registry.addListener,
      removeListener: registry.removeListener,
      classify: () => null,
      send
    });
    feed.subscribe(makeWebContents());

    registry.emit(record(1));
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);

    expect(send).toHaveBeenCalledTimes(1);
    expect(feed.getStats().pending).toBe(0);
    expect(feed.getStats().buffered).toBe(1);
    expect(feed.getStats().timerActive).toBe(false);
  });

  test('a failing send never throws and still reaches the other subscribers', () => {
    const send = jest.fn((wc) => {
      if (wc.tag === 'bad') throw new Error('send failed');
    });
    const { feed, registry } = makeFeed({ send });
    const bad = makeWebContents();
    bad.tag = 'bad';
    const good = makeWebContents();
    feed.subscribe(bad);
    feed.subscribe(good);

    registry.emit(record(1));
    expect(() => jest.advanceTimersByTime(FLUSH_INTERVAL_MS)).not.toThrow();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toBe(good);
  });

  test('a webContents found destroyed at flush time is skipped and dropped', () => {
    const { feed, registry, send } = makeFeed();
    const gone = makeWebContents();
    const alive = makeWebContents();
    feed.subscribe(gone);
    feed.subscribe(alive);
    registry.emit(record(1));

    gone.destroyed = true;
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe(alive);
    expect(feed.getStats().subscribers).toBe(1);
  });

  test('normalizes entries: unknown level, long message, unserializable data, throwing classifier', () => {
    const { feed, registry } = makeFeed({
      classify: () => {
        throw new Error('bad rule');
      }
    });
    feed.subscribe(makeWebContents());
    const circular = {};
    circular.self = circular;

    registry.emit(
      record(1, { level: 'verbose', msg: 'x'.repeat(MAX_MSG_CHARS + 10), data: circular })
    );

    const [entry] = feed.subscribe(makeWebContents()).entries;
    expect(entry.level).toBe('info');
    expect(entry.msg).toHaveLength(MAX_MSG_CHARS);
    expect(entry.msg.endsWith('…')).toBe(true);
    expect(entry.dataText).toBe('[unserializable]');
    expect(entry.activity).toBeNull();
  });

  describe('per-line bounds', () => {
    function onlyEntry(overrides) {
      const { feed, registry } = makeFeed();
      feed.subscribe(makeWebContents());
      registry.emit(record(1, overrides));
      return feed.subscribe(makeWebContents()).entries[0];
    }

    test('a huge string in data is cut before serialization', () => {
      const entry = onlyEntry({ data: { big: 'y'.repeat(5_000_000), after: 1 } });
      expect(entry.dataText.length).toBeLessThanOrEqual(MAX_DATA_TEXT_CHARS);
      expect(entry.dataText.startsWith('{"big":"yyy')).toBe(true);
      expect(entry.dataText.endsWith('…')).toBe(true);
    });

    test('a huge array is not walked past the budget', () => {
      const items = Array.from({ length: 10_000 }, (_, i) => ({ toJSON: jest.fn(() => i) }));
      const entry = onlyEntry({ data: { items } });

      const visited = items.filter((item) => item.toJSON.mock.calls.length > 0).length;
      expect(visited).toBeLessThanOrEqual(MAX_DATA_TEXT_CHARS);
      expect(visited).toBeGreaterThan(0);
      expect(entry.dataText.length).toBeLessThanOrEqual(MAX_DATA_TEXT_CHARS);
      expect(entry.dataText.startsWith('{"items":[0,1,2')).toBe(true);
      expect(entry.dataText.endsWith('…')).toBe(true);
    });

    test('many keys: the ones past the budget are omitted and the cut is marked', () => {
      const data = {};
      for (let i = 0; i < 2000; i += 1) data[`key${i}`] = i;
      const entry = onlyEntry({ data });
      expect(entry.dataText.length).toBeLessThanOrEqual(MAX_DATA_TEXT_CHARS);
      expect(entry.dataText.startsWith('{"key0":0,"key1":1')).toBe(true);
      expect(entry.dataText.endsWith('…')).toBe(true);
    });

    test('small data is serialized exactly, with no cut marker', () => {
      const data = { fileName: 'a.pdf', count: 3, ok: true, tags: ['x', 'y'], nested: { n: null } };
      expect(onlyEntry({ data }).dataText).toBe(JSON.stringify(data));
    });

    test('context is capped at MAX_CONTEXT_CHARS', () => {
      const entry = onlyEntry({ context: 'C'.repeat(MAX_CONTEXT_CHARS + 30) });
      expect(entry.context).toHaveLength(MAX_CONTEXT_CHARS);
      expect(entry.context.endsWith('…')).toBe(true);
      expect(onlyEntry({ context: undefined }).context).toBe('');
    });

    test('a non-string msg is stringified; a missing msg becomes empty', () => {
      expect(onlyEntry({ msg: 42 }).msg).toBe('42');
      expect(onlyEntry({ msg: undefined }).msg).toBe('');
    });

    test('a missing time falls back to the current clock', () => {
      jest.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
      expect(onlyEntry({ time: undefined }).time).toBe('2026-01-02T03:04:05.000Z');
    });

    test('truncation never splits a surrogate pair', () => {
      const msg = `${'x'.repeat(MAX_MSG_CHARS - 2)}\u{1F600}tail`;
      const entry = onlyEntry({ msg });
      expect(entry.msg).toBe(`${'x'.repeat(MAX_MSG_CHARS - 2)}…`);
      expect(entry.msg).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);

      const intact = onlyEntry({ msg: `${'x'.repeat(MAX_MSG_CHARS - 3)}\u{1F600}tail` });
      expect(intact.msg).toBe(`${'x'.repeat(MAX_MSG_CHARS - 3)}\u{1F600}…`);
    });
  });

  test('the flush timer is unref-ed so it never keeps the process alive', () => {
    const fakeSetTimeout = global.setTimeout;
    const unref = jest.fn();
    const spy = jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms) => {
      // jsdom timer ids are numbers; hand back a Node-style handle instead.
      // The real (fake) timer is still scheduled and cleared in afterEach.
      fakeSetTimeout(fn, ms);
      return { unref };
    });
    try {
      const { feed, registry } = makeFeed();
      feed.subscribe(makeWebContents());
      registry.emit(record(1));
      expect(unref).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('a manual flush cancels the pending timer, so the batch is not sent twice', () => {
    const { feed, registry, send } = makeFeed();
    feed.subscribe(makeWebContents());
    registry.emit(record(1));

    feed.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(feed.getStats().timerActive).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('uses the real activity classifier by default', () => {
    const registry = makeRegistry();
    const feed = createLiveLogFeed({
      addListener: registry.addListener,
      removeListener: registry.removeListener,
      send: jest.fn()
    });
    feed.subscribe(makeWebContents());

    registry.emit(
      record(1, {
        context: 'SearchService',
        msg: '[SearchService] BM25 index built with 12 documents'
      })
    );

    const [entry] = feed.subscribe(makeWebContents()).entries;
    expect(entry.activity).toEqual({
      kind: 'search-index',
      icon: 'search',
      tone: 'success',
      text: 'Search index built (12 documents)'
    });
  });

  test('getLiveLogFeed is a singleton wired to the shared logger listener API', () => {
    // Under test-setup.js the logger module is test/mocks/logger.js, whose
    // addLiveRecordListener / removeLiveRecordListener are jest.fn() (Task 1).
    const loggerModule = require('../../../src/shared/logger');
    const feed = getLiveLogFeed();
    expect(getLiveLogFeed()).toBe(feed);

    const wc = makeWebContents();
    feed.subscribe(wc);
    expect(loggerModule.addLiveRecordListener).toHaveBeenCalledWith(expect.any(Function));

    feed.unsubscribe(wc);
    expect(loggerModule.removeLiveRecordListener).toHaveBeenCalledWith(
      loggerModule.addLiveRecordListener.mock.calls[0][0]
    );
  });

  test('the listener only buffers: no send happens until the flush timer fires', () => {
    const { feed, registry, send } = makeFeed();
    const wc = makeWebContents();
    feed.subscribe(wc);

    registry.emit(record(1));

    expect(send).not.toHaveBeenCalled();
    expect(wc.send).not.toHaveBeenCalled();
    expect(feed.getStats()).toMatchObject({ pending: 1, timerActive: true });
  });

  test('a send that logs a warning (safeSend failure path) adds no entry and no new batch', () => {
    const registry = makeRegistry();
    const send = jest.fn(() => {
      // What safeSend does on a blocked or failed send: log synchronously.
      registry.emit(
        record(0, { level: 'warn', context: 'IPC', msg: '[IPC Event] Validation failed' })
      );
      registry.emit(
        record(0, { level: 'error', context: 'IPC', msg: '[IPC Event] Blocking send' })
      );
    });
    const feed = createLiveLogFeed({
      addListener: registry.addListener,
      removeListener: registry.removeListener,
      classify: () => null,
      send
    });
    feed.subscribe(makeWebContents());

    registry.emit(record(1));
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS * 10);

    expect(send).toHaveBeenCalledTimes(1);
    const { entries } = feed.subscribe(makeWebContents());
    expect(entries.map((e) => e.msg)).toEqual(['message 1']);
  });

  test('the delivery guard is shared: another feed ignores records logged during a send', () => {
    const registry = makeRegistry();
    const send = jest.fn(() => registry.emit(record(0, { level: 'warn', msg: 'send failed' })));
    const sender = createLiveLogFeed({
      addListener: registry.addListener,
      removeListener: registry.removeListener,
      classify: () => null,
      send
    });
    const bystander = createLiveLogFeed({
      addListener: registry.addListener,
      removeListener: registry.removeListener,
      classify: () => null,
      send: jest.fn()
    });
    sender.subscribe(makeWebContents());
    bystander.subscribe(makeWebContents());

    registry.emit(record(1));
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);

    expect(send).toHaveBeenCalledTimes(1);
    expect(bystander.getStats().buffered).toBe(1);
    // Outside a delivery, records reach every feed again.
    registry.emit(record(2));
    expect(sender.getStats().buffered).toBe(2);
    expect(bystander.getStats().buffered).toBe(2);
  });

  test('a flush nested inside another feed send does not lift the outer guard', () => {
    const registry = makeRegistry();
    const inner = createLiveLogFeed({
      addListener: registry.addListener,
      removeListener: registry.removeListener,
      classify: () => null,
      send: jest.fn()
    });
    const outerSend = jest.fn(() => {
      inner.flush();
      registry.emit(record(0, { level: 'warn', msg: 'send failed after nested flush' }));
    });
    const outer = createLiveLogFeed({
      addListener: registry.addListener,
      removeListener: registry.removeListener,
      classify: () => null,
      send: outerSend
    });
    outer.subscribe(makeWebContents());
    inner.subscribe(makeWebContents());

    registry.emit(record(1));
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);

    expect(outerSend).toHaveBeenCalledTimes(1);
    expect(outer.getStats()).toMatchObject({ buffered: 1, pending: 0 });
    expect(inner.getStats()).toMatchObject({ buffered: 1, pending: 0 });
  });

  describe('activity merge (repeated completion lines within the merge window)', () => {
    /** "<kind> <file>" -> an activity; a message without a space has no file. */
    function mergeClassify(r) {
      const space = r.msg.indexOf(' ');
      const kind = space === -1 ? r.msg : r.msg.slice(0, space);
      const activity = { kind, icon: 'check', tone: 'success', text: r.msg };
      if (space !== -1) activity.file = r.msg.slice(space + 1);
      return activity;
    }

    function setup() {
      const { feed, registry, send } = makeFeed({ classify: mergeClassify });
      feed.subscribe(makeWebContents());
      const emit = (msg) => registry.emit(record(0, { msg }));
      const backlog = () => feed.subscribe(makeWebContents()).entries;
      return { feed, emit, backlog, send };
    }

    test('a duplicate inside the window keeps its raw record but loses its activity', () => {
      const { emit, backlog, send } = setup();

      emit('analyzed report.pdf');
      jest.advanceTimersByTime(ACTIVITY_MERGE_WINDOW_MS - 1);
      emit('analyzed report.pdf');

      const entries = backlog();
      expect(entries).toHaveLength(2);
      expect(entries[0].activity).toMatchObject({ kind: 'analyzed', file: 'report.pdf' });
      expect(entries[1].msg).toBe('analyzed report.pdf');
      expect(entries[1].activity).toBeNull();

      jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
      const lastBatch = send.mock.calls[send.mock.calls.length - 1][1];
      expect(lastBatch.entries.map((e) => e.activity)).toEqual([null]);
    });

    test('the same kind and file after the window is kept', () => {
      const { emit, backlog } = setup();

      emit('analyzed report.pdf');
      jest.advanceTimersByTime(ACTIVITY_MERGE_WINDOW_MS + 1);
      emit('analyzed report.pdf');

      expect(backlog().map((e) => e.activity && e.activity.file)).toEqual([
        'report.pdf',
        'report.pdf'
      ]);
    });

    test('a suppressed duplicate does not extend the window', () => {
      const { emit, backlog } = setup();

      emit('analyzed report.pdf');
      jest.advanceTimersByTime(6000);
      emit('analyzed report.pdf');
      jest.advanceTimersByTime(6000);
      emit('analyzed report.pdf');

      expect(backlog().map((e) => e.activity !== null)).toEqual([true, false, true]);
    });

    test('a different file or a different kind is kept', () => {
      const { emit, backlog } = setup();

      emit('analyzed report.pdf');
      emit('analyzed invoice.pdf');
      emit('analyze report.pdf');

      expect(backlog().every((e) => e.activity !== null)).toBe(true);
    });

    test('only completion lines are mergeable', () => {
      expect([...MERGEABLE_KINDS]).toEqual(['analyzed']);
    });

    test('two problems about the same file inside the window both keep their activity', () => {
      const { emit, backlog } = setup();

      emit('problem report.pdf');
      jest.advanceTimersByTime(1000);
      emit('problem report.pdf');

      expect(backlog().map((e) => e.activity && e.activity.kind)).toEqual(['problem', 'problem']);
    });

    test('progress lines for the same file are never merged', () => {
      const { emit, backlog } = setup();

      emit('analyze report.pdf');
      emit('analyze report.pdf');
      emit('organize report.pdf');
      emit('organize report.pdf');

      expect(backlog().every((e) => e.activity !== null)).toBe(true);
    });

    test('with the real classifier: Queued then Analyzing X both show, the two Analyzed X merge', () => {
      const registry = makeRegistry();
      const feed = createLiveLogFeed({
        addListener: registry.addListener,
        removeListener: registry.removeListener,
        send: jest.fn()
      });
      feed.subscribe(makeWebContents());

      registry.emit(
        record(0, {
          context: 'SmartFolderWatcher',
          msg: '[SMART-FOLDER-WATCHER] Queued for analysis:',
          data: { filePath: '[REDACTED_PATH]\\lease.docx', eventType: 'add' }
        })
      );
      registry.emit(
        record(0, {
          context: 'DocumentAnalysis',
          msg: 'Analyzing document file',
          data: { path: '[REDACTED_PATH]\\lease.docx' }
        })
      );
      registry.emit(
        record(0, {
          context: 'DocumentAnalysis',
          msg: '[AI-ANALYSIS-SUCCESS] Document analyzed',
          data: { fileName: 'lease.docx', category: 'Housing' }
        })
      );
      registry.emit(
        record(0, {
          context: 'SmartFolderWatcher',
          msg: '[SMART-FOLDER-WATCHER] Analysis complete: [REDACTED_PATH]\\lease.docx'
        })
      );

      const entries = feed.subscribe(makeWebContents()).entries;
      expect(entries.map((e) => e.activity && e.activity.text)).toEqual([
        'Queued lease.docx for analysis',
        'Analyzing lease.docx',
        'Analyzed lease.docx → Housing',
        null
      ]);
    });

    test('activities without a file (missing or empty) are never merged', () => {
      const { emit, backlog } = setup();

      emit('analyzed');
      emit('analyzed');
      emit('analyzed ');
      emit('analyzed ');

      expect(backlog().every((e) => e.activity !== null)).toBe(true);
    });

    test('the merge memory is cleared with the buffer on the last unsubscribe', () => {
      const { feed, registry } = makeFeed({ classify: mergeClassify });
      const wc = makeWebContents();
      feed.subscribe(wc);
      registry.emit(record(0, { msg: 'analyzed report.pdf' }));
      feed.unsubscribe(wc);

      feed.subscribe(makeWebContents());
      registry.emit(record(0, { msg: 'analyzed report.pdf' }));

      const [entry] = feed.subscribe(makeWebContents()).entries;
      expect(entry.activity).toMatchObject({ kind: 'analyzed', file: 'report.pdf' });
    });

    test.each([
      [RING_CAPACITY - 2, 'stays in the full ring', null],
      [RING_CAPACITY - 1, 'is evicted by the duplicate itself', 'report.pdf']
    ])('boundary: original + %i other lines, the original %s', (others, _label, expectedFile) => {
      const { feed, registry } = makeFeed({ classify: mergeClassify });
      feed.subscribe(makeWebContents());
      registry.emit(record(0, { msg: 'analyzed report.pdf' }));
      for (let i = 0; i < others; i += 1) registry.emit(record(0, { msg: 'tick' }));
      registry.emit(record(0, { msg: 'analyzed report.pdf' }));

      const entries = feed.subscribe(makeWebContents()).entries;
      const last = entries[entries.length - 1];
      expect(last.msg).toBe('analyzed report.pdf');
      expect(last.activity && last.activity.file).toBe(expectedFile);
    });

    test('an original evicted from the backlog no longer suppresses a duplicate', () => {
      const { feed, registry } = makeFeed({ classify: mergeClassify });
      feed.subscribe(makeWebContents());
      registry.emit(record(0, { msg: 'analyzed report.pdf' }));
      for (let i = 0; i < RING_CAPACITY; i += 1) registry.emit(record(0, { msg: 'tick' }));
      registry.emit(record(0, { msg: 'analyzed report.pdf' }));

      const entries = feed.subscribe(makeWebContents()).entries;
      expect(entries[entries.length - 1].activity).toMatchObject({ file: 'report.pdf' });
    });
  });
});
