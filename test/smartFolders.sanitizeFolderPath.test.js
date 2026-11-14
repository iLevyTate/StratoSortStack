/**
 * @jest-environment node
 *
 * sanitizeFolderPath checks a folder path from the renderer before it is
 * scanned or saved as a smart folder. It keeps out traversal, URLs, device
 * paths and system directories; it does not confine folders to the home
 * directory, so a folder on an external or secondary drive passes.
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
const posixOnly = process.platform === 'win32' ? test.skip : test;

describe('sanitizeFolderPath', () => {
  test.each([
    '\\\\.\\C:\\Temp',
    '\\\\?\\C:\\Temp',
    '//./C:/Temp',
    '//?/C:/Temp',
    '\\\\.\\UNC\\server\\share\\x',
    '\\\\?\\UNC\\server\\share\\x',
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1'
  ])('rejects Windows device-namespace path %s', async (input) => {
    await expect(sanitizeFolderPath(input)).rejects.toThrow(
      'Invalid path: Windows device namespace paths are not allowed'
    );
  });

  winOnly('accepts a real UNC share', async () => {
    await expect(sanitizeFolderPath('\\\\server\\share\\folder')).resolves.toBe(
      '\\\\server\\share\\folder'
    );
  });

  describe('any drive is acceptable', () => {
    winOnly('a folder under the home directory', async () => {
      await expect(sanitizeFolderPath('C:\\Users\\Test\\Documents\\Work')).resolves.toBe(
        'C:\\Users\\Test\\Documents\\Work'
      );
    });

    winOnly('a folder elsewhere on the system drive', async () => {
      await expect(sanitizeFolderPath('C:\\Temp')).resolves.toBe('C:\\Temp');
    });

    // The drive letter need not exist: a drive that is unplugged is judged as
    // spelled, and the failure to reach it surfaces where the folder is used.
    winOnly.each(['F:\\Sorted', 'F:\\', 'Q:\\Strato Input\\2025'])(
      'a folder on another drive: %s',
      async (input) => {
        await expect(sanitizeFolderPath(input)).resolves.toBe(input);
      }
    );

    posixOnly.each(['/Volumes/Samsung T7/Sorted', '/media/alex/SSD/Sorted', '/mnt/data/Sorted'])(
      'a folder on a mounted volume: %s',
      async (input) => {
        await expect(sanitizeFolderPath(input)).resolves.toBe(input);
      }
    );
  });

  describe('still refused', () => {
    test.each(['', '   ', null, undefined, 42])('no path: %p', async (input) => {
      await expect(sanitizeFolderPath(input)).rejects.toThrow(/Invalid path/);
    });

    test.each(['Sorted', './Sorted', 'Documents/Sorted'])('a relative path: %s', async (input) => {
      await expect(sanitizeFolderPath(input)).rejects.toThrow(/absolute path/);
    });

    winOnly.each(['F:\\Sorted\\..\\..\\Windows', 'C:\\Users\\Test\\..\\..\\Windows\\System32'])(
      'a path with traversal: %s',
      async (input) => {
        await expect(sanitizeFolderPath(input)).rejects.toThrow(/Invalid path/);
      }
    );

    posixOnly('a path with traversal', async () => {
      await expect(sanitizeFolderPath('/Volumes/SSD/../../etc')).rejects.toThrow(/Invalid path/);
    });

    test.each(['https://example.com/folder', 'smb://server/share/folder', 'ftp://host/folder'])(
      'a URL: %s',
      async (input) => {
        await expect(sanitizeFolderPath(input)).rejects.toThrow(/URL schemes are not allowed/);
      }
    );

    // A file:// URL is read as the folder it names (a dropped folder can
    // arrive in that form), so it is held to the same rules as a plain path.
    winOnly('a file:// URL is judged as the folder it names', async () => {
      await expect(sanitizeFolderPath('file:///F:/Sorted')).resolves.toBe('F:\\Sorted');
      await expect(sanitizeFolderPath('file:///C:/Windows/System32')).rejects.toThrow(
        /system directories/
      );
    });

    winOnly.each([
      'C:\\Windows\\System32',
      'C:\\Program Files\\Sorted',
      'D:\\Windows',
      'F:\\System Volume Information',
      'F:\\Program Files (x86)\\Sorted'
    ])('a system directory on any drive: %s', async (input) => {
      await expect(sanitizeFolderPath(input)).rejects.toThrow(/system directories/);
    });

    posixOnly.each(['/etc/Sorted', '/usr/sbin', '/proc/1'])(
      'a system directory: %s',
      async (input) => {
        await expect(sanitizeFolderPath(input)).rejects.toThrow(/system directories/);
      }
    );
  });
});
