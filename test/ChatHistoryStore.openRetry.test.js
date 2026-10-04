/**
 * @jest-environment node
 *
 * ChatHistoryStore: a transient SQLite open failure (file briefly held by
 * antivirus or backup tooling) is retried with backoff instead of disabling
 * chat for the whole session. Corruption and permission errors are not
 * retried.
 */

jest.mock('electron', () => ({
  app: { getPath: () => '/tmp/chat-open-retry' }
}));

const mockDatabase = jest.fn();
jest.mock('better-sqlite3', () => mockDatabase, { virtual: true });

const { ChatHistoryStore } = require('../src/main/services/ChatHistoryStore');

function fakeDb() {
  return {
    pragma: jest.fn(() => 0),
    close: jest.fn(),
    prepare: jest.fn(),
    exec: jest.fn(),
    transaction: jest.fn((fn) => fn)
  };
}

function sqliteError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function makeStore() {
  const store = new ChatHistoryStore();
  store._openRetryDelaysMs = [0, 0, 0];
  jest.spyOn(store, '_migrate').mockImplementation(() => {});
  return store;
}

describe('ChatHistoryStore open retry', () => {
  beforeEach(() => {
    mockDatabase.mockReset();
  });

  test('retries SQLITE_BUSY and SQLITE_LOCKED, then opens', async () => {
    mockDatabase
      .mockImplementationOnce(() => {
        throw sqliteError('SQLITE_BUSY');
      })
      .mockImplementationOnce(() => {
        throw sqliteError('SQLITE_LOCKED');
      })
      .mockImplementation(() => fakeDb());

    const store = makeStore();
    await store.initialize();

    expect(mockDatabase).toHaveBeenCalledTimes(3);
    expect(store._db).toBeTruthy();
  });

  test('retries SQLITE_CANTOPEN without quarantining the file', async () => {
    mockDatabase
      .mockImplementationOnce(() => {
        throw sqliteError('SQLITE_CANTOPEN');
      })
      .mockImplementation(() => fakeDb());

    const store = makeStore();
    const quarantine = jest.spyOn(store, '_quarantineCorruptDb').mockResolvedValue();
    await store.initialize();

    expect(mockDatabase).toHaveBeenCalledTimes(2);
    expect(quarantine).not.toHaveBeenCalled();
  });

  test('gives up after the configured attempts and rethrows the last error', async () => {
    mockDatabase.mockImplementation(() => {
      throw sqliteError('SQLITE_BUSY');
    });

    const store = makeStore();
    store._openRetryDelaysMs = [0, 0];

    await expect(store.initialize()).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
    // One initial attempt plus one per configured delay.
    expect(mockDatabase).toHaveBeenCalledTimes(3);
    expect(store._db).toBeNull();
  });

  test('does not retry a non-transient open error', async () => {
    mockDatabase.mockImplementation(() => {
      throw sqliteError('SQLITE_PERM');
    });

    const store = makeStore();
    await expect(store.initialize()).rejects.toMatchObject({ code: 'SQLITE_PERM' });
    expect(mockDatabase).toHaveBeenCalledTimes(1);
  });

  test('closes a half-open handle before retrying when migration fails transiently', async () => {
    const firstDb = fakeDb();
    mockDatabase.mockImplementationOnce(() => firstDb).mockImplementation(() => fakeDb());

    const store = new ChatHistoryStore();
    store._openRetryDelaysMs = [0];
    jest
      .spyOn(store, '_migrate')
      .mockImplementationOnce(() => {
        throw sqliteError('SQLITE_BUSY');
      })
      .mockImplementation(() => {});

    await store.initialize();

    expect(firstDb.close).toHaveBeenCalledTimes(1);
    expect(mockDatabase).toHaveBeenCalledTimes(2);
    expect(store._db).not.toBe(firstDb);
  });

  test('a corrupt database goes straight to quarantine, not retry', async () => {
    mockDatabase
      .mockImplementationOnce(() => {
        throw sqliteError('SQLITE_CORRUPT');
      })
      .mockImplementation(() => fakeDb());

    const store = makeStore();
    const quarantine = jest.spyOn(store, '_quarantineCorruptDb').mockResolvedValue();
    await store.initialize();

    expect(quarantine).toHaveBeenCalledTimes(1);
    expect(mockDatabase).toHaveBeenCalledTimes(2);
  });
});
