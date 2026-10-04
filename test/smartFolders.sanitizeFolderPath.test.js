/**
 * @jest-environment node
 */
jest.mock('electron', () => ({
  app: {
    getPath: jest.fn((name) => {
      if (name === 'documents') return 'C:\\Users\\Test\\Documents';
      if (name === 'downloads') return 'C:\\Users\\Test\\Downloads';
      return '';
    })
  },
  BrowserWindow: { getAllWindows: jest.fn(() => []) }
}));

jest.mock('../src/shared/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger, createLogger: jest.fn(() => logger) };
});

jest.mock('../src/main/services/FolderMatchingService', () => ({ getInstance: jest.fn() }));
jest.mock('../src/main/services/ParallelEmbeddingService', () => ({ getInstance: jest.fn() }));
jest.mock('../src/main/services/LlamaService', () => ({ getInstance: jest.fn() }));
jest.mock('../src/main/services/SmartFoldersLLMService', () => ({
  enhanceSmartFolderWithLLM: jest.fn()
}));

const { sanitizeFolderPath } = require('../src/main/ipc/smartFolders');

const winOnly = process.platform === 'win32' ? test : test.skip;

describe('sanitizeFolderPath', () => {
  test.each([
    '\\\\.\\C:\\Temp',
    '\\\\?\\C:\\Temp',
    '//./C:/Temp',
    '//?/C:/Temp',
    '\\\\.\\UNC\\server\\share\\x',
    '\\\\?\\UNC\\server\\share\\x',
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1'
  ])('rejects Windows device-namespace path %s', (input) => {
    expect(() => sanitizeFolderPath(input)).toThrow(
      'Invalid path: Windows device namespace paths are not allowed'
    );
  });

  winOnly('still accepts a real UNC share outside the allowed app paths', () => {
    expect(sanitizeFolderPath('\\\\server\\share\\folder')).toBe('\\\\server\\share\\folder');
  });

  winOnly('still enforces allowed-base containment for local drive paths', () => {
    expect(sanitizeFolderPath('C:\\Users\\Test\\Documents\\Work')).toBe(
      'C:\\Users\\Test\\Documents\\Work'
    );
    expect(() => sanitizeFolderPath('C:\\Temp')).toThrow(/allowed directories/);
  });
});
