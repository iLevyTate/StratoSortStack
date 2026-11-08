/**
 * system.abortInvoke request scoping.
 *
 * A per-channel abort cancels every in-flight invoke on that channel, so the
 * search tab superseding its own EMBEDDINGS.SEARCH used to cancel the chat
 * tab's name-resolution search on the same channel. Callers can now tag an
 * invoke with a renderer-chosen `abortKey` (embeddings.search option) and
 * abort only the invokes carrying it. The untagged per-channel form keeps
 * working for existing callers (organize cancel / pause).
 */

const mockInvoke = jest.fn();
const mockSend = jest.fn();
const mockExposeInMainWorld = jest.fn();
const mockCheckRateLimit = jest.fn();

jest.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mockExposeInMainWorld },
  ipcRenderer: {
    invoke: mockInvoke,
    on: jest.fn(),
    removeListener: jest.fn(),
    send: mockSend
  },
  webUtils: { getPathForFile: jest.fn() }
}));

jest.mock('../src/shared/logger', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    setContext: jest.fn(),
    setLevel: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  })),
  LOG_LEVELS: { DEBUG: 'debug', INFO: 'info' }
}));

jest.mock('../src/preload/ipcRateLimiter', () => ({
  IpcRateLimiter: jest.fn().mockImplementation(() => ({
    checkRateLimit: mockCheckRateLimit
  }))
}));

jest.mock('../src/preload/ipcValidator', () => ({
  createIpcValidator: jest.fn(() => ({
    validateResult: jest.fn((result) => result),
    validateEventSource: jest.fn(() => true),
    isValidSystemMetrics: jest.fn(() => true)
  }))
}));

const SEARCH = 'embeddings:search';
const ABORT = 'system:abort-invoke';

describe('preload system.abortInvoke request scoping', () => {
  let electronAPI;
  /** @type {Array<(v: any) => void>} */
  let resolvers;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    global.window = global.window || {};
    global.window.addEventListener = jest.fn();
    global.window.removeEventListener = jest.fn();
    resolvers = [];
    mockInvoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        })
    );
    require('../src/preload/preload');
    electronAPI = mockExposeInMainWorld.mock.calls[0][1];
  });

  afterEach(async () => {
    resolvers.forEach((resolve) => resolve({ success: true, results: [] }));
    await new Promise((r) => setImmediate(r));
  });

  const flush = () => new Promise((r) => setImmediate(r));
  const requestIdOf = (call) => call[call.length - 1].__stratosortIpcMeta.requestId;
  const abortSends = () => mockSend.mock.calls.filter(([channel]) => channel === ABORT);
  // Preload issues its own startup invokes; only the search calls matter here.
  const searchInvokes = () => mockInvoke.mock.calls.filter(([channel]) => channel === SEARCH);

  async function startTwoSearches() {
    // Search tab (tagged) and chat name-resolution (untagged), same channel.
    const tagged = electronAPI.embeddings.search('first query', {
      topK: 20,
      abortKey: 'search-tab-1'
    });
    const untagged = electronAPI.embeddings.search('report.pdf', { topK: 30 });
    await flush();
    expect(searchInvokes()).toHaveLength(2);
    return {
      tagged,
      untagged,
      taggedId: requestIdOf(searchInvokes()[0]),
      untaggedId: requestIdOf(searchInvokes()[1])
    };
  }

  test('abort by abortKey cancels only the invoke that carries it', async () => {
    const { taggedId, untaggedId } = await startTwoSearches();
    expect(taggedId).not.toBe(untaggedId);

    const signalled = electronAPI.system.abortInvoke({
      channel: SEARCH,
      abortKey: 'search-tab-1',
      reason: 'search-superseded'
    });

    expect(signalled).toBe(1);
    expect(abortSends()).toEqual([
      [ABORT, { requestId: taggedId, channel: SEARCH, reason: 'search-superseded' }]
    ]);
  });

  test('the abortKey never reaches main in the search payload', async () => {
    await startTwoSearches();
    const payload = searchInvokes()[0][1];
    expect(payload).toEqual(expect.objectContaining({ query: 'first query', topK: 20 }));
    expect(payload).not.toHaveProperty('abortKey');
  });

  test('per-channel abort (no abortKey) still signals every in-flight invoke', async () => {
    const { taggedId, untaggedId } = await startTwoSearches();

    const signalled = electronAPI.system.abortInvoke({
      channel: SEARCH,
      reason: 'user-cancel'
    });

    expect(signalled).toBe(2);
    expect(abortSends().map(([, p]) => p.requestId)).toEqual([taggedId, untaggedId]);
  });

  test('an unknown abortKey signals nothing', async () => {
    await startTwoSearches();
    expect(electronAPI.system.abortInvoke({ channel: SEARCH, abortKey: 'search-tab-999' })).toBe(0);
    expect(abortSends()).toHaveLength(0);
  });

  test('a malformed abortKey signals nothing instead of widening to the whole channel', async () => {
    await startTwoSearches();
    for (const abortKey of [
      'bad key',
      'x\nevil',
      '',
      'a'.repeat(65),
      42,
      { k: 1 },
      null,
      undefined
    ]) {
      expect(electronAPI.system.abortInvoke({ channel: SEARCH, abortKey })).toBe(0);
    }
    expect(abortSends()).toHaveLength(0);
  });

  test('a matching abortKey on another channel is not signalled', async () => {
    await startTwoSearches();
    expect(
      electronAPI.system.abortInvoke({
        channel: 'files:perform-operation',
        abortKey: 'search-tab-1'
      })
    ).toBe(0);
    expect(abortSends()).toHaveLength(0);
  });

  test('abortInvoke is rate-limited', async () => {
    await startTwoSearches();
    mockCheckRateLimit.mockImplementationOnce(() => {
      throw new Error('Rate limit exceeded');
    });
    expect(electronAPI.system.abortInvoke({ channel: SEARCH, abortKey: 'search-tab-1' })).toBe(0);
    expect(abortSends()).toHaveLength(0);
    expect(mockCheckRateLimit).toHaveBeenCalledWith(ABORT);
  });

  test('once the tagged invoke settles its abortKey no longer matches', async () => {
    const { tagged } = await startTwoSearches();
    resolvers[mockInvoke.mock.calls.indexOf(searchInvokes()[0])]({ success: true, results: [] });
    await tagged;
    expect(electronAPI.system.abortInvoke({ channel: SEARCH, abortKey: 'search-tab-1' })).toBe(0);
    expect(abortSends()).toHaveLength(0);
  });
});
