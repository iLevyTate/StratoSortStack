/**
 * Where the vector store lives. `vectorDbPersistPath` is a folder name under
 * the app data directory; anything that would leave it (an absolute path, a
 * traversal, a share) falls back to the default so the index never leaves
 * userData (SECURITY.md).
 */

let mockLogger;
let mockSettingsInstance;

jest.mock('electron', () => ({
  app: {
    // Host-absolute userData root. `_resolveVectorDataPath` builds its fallback
    // with path.join() but its relative leg with path.resolve(), and on Windows
    // only the latter is drive-qualified ('C:\mock-user-data\...'), so a bare
    // '/mock-user-data' makes the two legs disagree and the relative-leg
    // assertions fail on Windows only. Resolving the root once makes them agree
    // on every platform.
    getPath: jest.fn(() => require('path').resolve('/mock-user-data'))
  }
}));

jest.mock('../src/shared/logger', () => {
  mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  };
  return {
    createLogger: () => mockLogger
  };
});

jest.mock('../src/shared/singletonFactory', () => ({
  createSingletonHelpers: () => ({
    getInstance: jest.fn(),
    createInstance: jest.fn(),
    registerWithContainer: jest.fn(),
    resetInstance: jest.fn()
  })
}));

jest.mock('../src/main/services/SettingsService', () => ({
  getInstance: () => mockSettingsInstance
}));

jest.mock('@orama/orama', () => ({
  create: jest.fn(),
  insert: jest.fn(),
  search: jest.fn(),
  remove: jest.fn(),
  update: jest.fn(),
  count: jest.fn(),
  getByID: jest.fn()
}));

jest.mock('@orama/plugin-data-persistence', () => ({
  persist: jest.fn(),
  restore: jest.fn()
}));

jest.mock('lz4-napi', () => ({
  compress: jest.fn(async (buf) => buf),
  uncompress: jest.fn(async (buf) => buf)
}));

jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    unlink: jest.fn(),
    rename: jest.fn(),
    mkdir: jest.fn(),
    writeFile: jest.fn(),
    stat: jest.fn()
  }
}));

const path = require('path');
const { OramaVectorService } = require('../src/main/services/OramaVectorService');

const USER_DATA = path.resolve('/mock-user-data');
const FALLBACK = path.join(USER_DATA, 'vector-db');

describe('OramaVectorService._resolveVectorDataPath', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSettingsInstance = { load: jest.fn(async () => ({})) };
  });

  test('the default folder name resolves under userData', async () => {
    const service = new OramaVectorService();
    await expect(service._resolveVectorDataPath()).resolves.toBe(FALLBACK);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  test('a relative folder name is honoured, nested or not', async () => {
    const service = new OramaVectorService();
    mockSettingsInstance.load.mockResolvedValue({ vectorDbPersistPath: 'vectors/v2' });
    await expect(service._resolveVectorDataPath()).resolves.toBe(
      path.join(USER_DATA, 'vectors', 'v2')
    );
    mockSettingsInstance.load.mockResolvedValue({ vectorDbPersistPath: '  index  ' });
    await expect(service._resolveVectorDataPath()).resolves.toBe(path.join(USER_DATA, 'index'));
  });

  test.each([
    ['an absolute POSIX path', '/etc/stratosort'],
    ['an absolute Windows path', 'C:\\Users\\kim\\vectors'],
    ['a UNC share', '\\\\nas\\share\\vectors'],
    ['a POSIX share', '//nas/share/vectors'],
    ['a traversal out of userData', '../elsewhere'],
    ['userData itself', '.']
  ])('%s falls back to the default and says so', async (_label, configured) => {
    const service = new OramaVectorService();
    mockSettingsInstance.load.mockResolvedValue({ vectorDbPersistPath: configured });
    await expect(service._resolveVectorDataPath()).resolves.toBe(FALLBACK);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });

  test('a settings read that fails falls back to the default without a warning', async () => {
    const service = new OramaVectorService();
    mockSettingsInstance.load.mockRejectedValue(new Error('settings locked'));
    await expect(service._resolveVectorDataPath()).resolves.toBe(FALLBACK);
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Could not read vectorDbPersistPath'),
      expect.objectContaining({ error: 'settings locked' })
    );
  });

  test('a non-string setting is ignored', async () => {
    const service = new OramaVectorService();
    mockSettingsInstance.load.mockResolvedValue({ vectorDbPersistPath: 42 });
    await expect(service._resolveVectorDataPath()).resolves.toBe(FALLBACK);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});
