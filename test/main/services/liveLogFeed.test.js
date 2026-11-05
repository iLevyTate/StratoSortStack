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
  ACTIVITY_MERGE_WINDOW_MS
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
    expect(b.listenerCount('destroyed')).toBe(0);

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

  describe('activity merge (same kind and file within the merge window)', () => {
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

    test('activities without a file (missing or empty) are never merged', () => {
      const { emit, backlog } = setup();

      emit('indexed');
      emit('indexed');
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
