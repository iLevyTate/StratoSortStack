/**
 * ensureUncategorizedFolder recognises the catch-all by category
 * after a rename and restores its name instead of adding a second one.
 */

// Mock logger
jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

// Mock fs
const mockFs = {
  readFile: jest.fn(),
  writeFile: jest.fn().mockResolvedValue(undefined),
  rename: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
  mkdir: jest.fn().mockResolvedValue(undefined)
};
jest.mock('fs', () => ({
  promises: mockFs
}));

// Mock atomicFileOperations (used by safeWriteFile in customFolders)
const mockSafeWriteFile = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/shared/atomicFileOperations', () => ({
  safeWriteFile: mockSafeWriteFile
}));

// Mock electron
jest.mock('electron', () => ({
  app: {
    getPath: jest.fn((type) => {
      if (type === 'userData') return '/mock/userData';
      if (type === 'documents') return '/mock/documents';
      return '/mock/path';
    })
  }
}));

// Mock path to work cross-platform
jest.mock('path', () => {
  const actualPath = jest.requireActual('path');
  return {
    ...actualPath,
    join: (...args) => args.join('/'),
    normalize: (p) => p
  };
});

describe('Uncategorized catch-all renamed in an older build', () => {
  let customFolders;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    customFolders = require('../src/main/core/customFolders');
  });

  test('ensureUncategorizedFolder restores the name of a renamed catch-all and does not add a second one', async () => {
    const savedFolders = [
      { id: 'gsc', name: 'GSC', path: '/P/Strato Output/GSC', isDefault: false },
      {
        id: 'default-uncategorized-1',
        name: 'Strato test Data',
        path: '/P/Strato Input',
        isDefault: true,
        category: 'uncategorized'
      }
    ];
    mockFs.readFile.mockResolvedValueOnce(JSON.stringify(savedFolders));

    const folders = await customFolders.loadCustomFolders();

    const catchAlls = folders.filter(
      (f) => f.category === 'uncategorized' || String(f.name).toLowerCase() === 'uncategorized'
    );
    expect(catchAlls).toHaveLength(1);
    expect(catchAlls[0]).toMatchObject({
      id: 'default-uncategorized-1',
      name: 'Uncategorized',
      path: '/P/Strato Input'
    });
    expect(folders).toHaveLength(2);
    const persisted = JSON.parse(mockSafeWriteFile.mock.calls.at(-1)[1]);
    expect(persisted.find((f) => f.id === 'default-uncategorized-1').name).toBe('Uncategorized');
  });

  test('a renamed catch-all beside a re-added Uncategorized becomes an ordinary folder', async () => {
    const { isUncategorizedFolder } = require('../src/shared/uncategorizedFolder');
    // An older build looked the catch-all up by name only, so after the
    // rename it appended a second one.
    const savedFolders = [
      {
        id: 'default-uncategorized-1',
        name: 'Strato test Data',
        path: '/P/Strato Input',
        isDefault: true,
        category: 'uncategorized'
      },
      { id: 'gsc', name: 'GSC', path: '/P/Strato Output/GSC', isDefault: false },
      {
        id: 'default-uncategorized-2',
        name: 'Uncategorized',
        path: '/P/Uncategorized',
        isDefault: true,
        category: 'uncategorized'
      }
    ];
    mockFs.readFile.mockResolvedValueOnce(JSON.stringify(savedFolders));

    const folders = await customFolders.loadCustomFolders();

    expect(folders).toHaveLength(3);
    const catchAlls = folders.filter((f) => isUncategorizedFolder(f));
    expect(catchAlls.map((f) => f.id)).toEqual(['default-uncategorized-2']);
    const renamed = folders.find((f) => f.id === 'default-uncategorized-1');
    expect(renamed).toMatchObject({
      name: 'Strato test Data',
      path: '/P/Strato Input',
      category: 'general',
      isDefault: false
    });
    const persisted = JSON.parse(mockSafeWriteFile.mock.calls.at(-1)[1]);
    expect(persisted.filter((f) => isUncategorizedFolder(f)).map((f) => f.id)).toEqual([
      'default-uncategorized-2'
    ]);
    expect(persisted.find((f) => f.id === 'default-uncategorized-1').category).toBe('general');
  });

  test('a user folder the AI gave the category "uncategorized" is not taken for the catch-all', async () => {
    const savedFolders = [
      { id: 'other', name: 'Other', path: '/P/Other', isDefault: false, category: 'uncategorized' },
      {
        id: 'default-uncategorized-1',
        name: 'Uncategorized',
        path: '/P/Uncategorized',
        isDefault: true,
        category: 'uncategorized'
      }
    ];
    mockFs.readFile.mockResolvedValueOnce(JSON.stringify(savedFolders));

    const folders = await customFolders.loadCustomFolders();

    expect(folders.find((f) => f.id === 'other')).toMatchObject({
      name: 'Other',
      category: 'general',
      isDefault: false
    });
    expect(folders.find((f) => f.id === 'default-uncategorized-1').name).toBe('Uncategorized');
  });

  test('without a seeded catch-all, a user folder with that category is not renamed', async () => {
    const savedFolders = [
      { id: 'other', name: 'Other', path: '/P/Other', isDefault: false, category: 'uncategorized' }
    ];
    mockFs.readFile.mockResolvedValueOnce(JSON.stringify(savedFolders));

    const folders = await customFolders.loadCustomFolders();

    expect(folders.find((f) => f.id === 'other')).toMatchObject({
      name: 'Other',
      category: 'general'
    });
    const catchAll = folders.find((f) => f.name === 'Uncategorized');
    expect(catchAll).toMatchObject({ category: 'uncategorized', isDefault: true });
    expect(folders).toHaveLength(2);
  });
});
