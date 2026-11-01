/**
 * Tests for Custom Folders Module
 * Tests folder configuration persistence
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

describe('Custom Folders', () => {
  let customFolders;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    customFolders = require('../src/main/core/customFolders');
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockFs.readFile.mockRejectedValue(enoent);
  });

  describe('getCustomFoldersPath', () => {
    test('returns path in userData directory', () => {
      const path = customFolders.getCustomFoldersPath();
      expect(path).toContain('userData');
      expect(path).toContain('custom-folders.json');
    });
  });

  describe('loadCustomFolders', () => {
    test('loads and parses saved folders, only ensures Uncategorized', async () => {
      const savedFolders = [
        {
          id: 'folder1',
          name: 'Documents',
          path: '/test/documents',
          isDefault: false
        },
        {
          id: 'uncategorized',
          name: 'Uncategorized',
          path: '/test/uncategorized',
          isDefault: true
        }
      ];
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(savedFolders));

      const folders = await customFolders.loadCustomFolders();

      expect(folders.some((f) => f.name === 'Documents')).toBe(true);
      expect(folders.some((f) => f.name === 'Uncategorized')).toBe(true);
      // Should NOT inject extra defaults the user didn't add
      expect(folders.some((f) => f.name === 'Archives')).toBe(false);
      expect(folders).toHaveLength(2);
    });

    test('creates only Uncategorized when file does not exist (first launch)', async () => {
      mockFs.readFile.mockRejectedValueOnce(new Error('ENOENT'));

      const folders = await customFolders.loadCustomFolders();

      // First launch: only Uncategorized is created; user builds their own structure
      expect(folders).toHaveLength(1);
      expect(folders[0].name).toBe('Uncategorized');
      expect(folders[0].isDefault).toBe(true);
      expect(mockFs.mkdir).toHaveBeenCalled();
    });

    test('strips __proto__ injection from persisted JSON', async () => {
      // Exercises the safeJsonTryParse path: a file on disk that has been
      // hand-edited to try to pollute Object.prototype must not affect the
      // runtime prototype chain. loadCustomFolders should return a clean
      // array and the prototype should remain untouched.
      const malicious = '[{"__proto__":{"polluted":true},"name":"Evil","path":"/tmp"}]';
      mockFs.readFile.mockResolvedValueOnce(malicious);

      const folders = await customFolders.loadCustomFolders();

      expect({}.polluted).toBeUndefined();
      expect(folders.some((f) => f.polluted)).toBe(false);
    });

    test('adds only Uncategorized if it is missing from saved data', async () => {
      const savedFolders = [
        {
          id: 'folder1',
          name: 'Documents',
          path: '/test/documents',
          isDefault: false
        }
      ];
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(savedFolders));

      const folders = await customFolders.loadCustomFolders();

      // Should add Uncategorized but NOT other defaults
      expect(folders).toHaveLength(2);
      expect(folders.some((f) => f.name === 'Documents')).toBe(true);
      expect(folders.some((f) => f.name.toLowerCase() === 'uncategorized')).toBe(true);
      expect(folders.some((f) => f.name === 'Archives')).toBe(false);
    });

    test('heals Uncategorized folder when saved entry has no path', async () => {
      const savedFolders = [
        {
          id: 'uncategorized',
          name: 'Uncategorized',
          path: '',
          isDefault: true
        }
      ];
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(savedFolders));

      const folders = await customFolders.loadCustomFolders();
      const uncategorized = folders.find((folder) => folder.name === 'Uncategorized');

      expect(uncategorized?.path).toBe('/mock/documents/Uncategorized');
      expect(mockFs.mkdir).toHaveBeenCalledWith('/mock/documents/Uncategorized', {
        recursive: true
      });
      expect(mockSafeWriteFile).toHaveBeenCalled();
    });

    test('normalizes folder paths', async () => {
      const savedFolders = [
        {
          id: 'uncategorized',
          name: 'Uncategorized',
          path: '/test/path',
          isDefault: true
        }
      ];
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(savedFolders));

      const folders = await customFolders.loadCustomFolders();

      const uncategorized = folders.find((folder) => folder.name === 'Uncategorized');
      expect(uncategorized?.path).toBeDefined();
    });

    test('heals missing folder ids instead of dropping folders', async () => {
      const savedFolders = [
        {
          name: 'Projects',
          path: '/test/projects',
          isDefault: false
        },
        {
          name: 'Uncategorized',
          path: '/test/uncategorized',
          isDefault: true
        }
      ];
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(savedFolders));

      const folders = await customFolders.loadCustomFolders();
      const projects = folders.find((folder) => folder.name === 'Projects');
      const uncategorized = folders.find((folder) => folder.name === 'Uncategorized');

      expect(projects).toBeDefined();
      expect(typeof projects.id).toBe('string');
      expect(projects.id.length).toBeGreaterThan(0);
      expect(uncategorized).toBeDefined();
      expect(typeof uncategorized.id).toBe('string');
      expect(uncategorized.id.length).toBeGreaterThan(0);
    });

    test('does not re-add defaults when custom folders exist', async () => {
      const savedFolders = [
        {
          id: 'custom-projects',
          name: 'Projects',
          path: '/custom/projects',
          isDefault: false
        },
        {
          id: 'uncategorized',
          name: 'Uncategorized',
          path: '/custom/uncategorized',
          isDefault: true
        }
      ];

      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(savedFolders));

      const folders = await customFolders.loadCustomFolders();

      expect(folders.some((f) => f.name === 'Projects')).toBe(true);
      expect(folders.some((f) => f.name === 'Documents')).toBe(false);
      expect(folders.some((f) => f.name === 'Archives')).toBe(false);
    });

    test('recovers custom folders from legacy userData when current has defaults only', async () => {
      const currentDefaults = [
        {
          id: 'default-documents',
          name: 'Documents',
          path: '/test/documents',
          isDefault: true
        },
        {
          id: 'default-uncategorized',
          name: 'Uncategorized',
          path: '/test/uncategorized',
          isDefault: true
        }
      ];
      const legacyFolders = [
        {
          id: 'custom-projects',
          name: 'Projects',
          path: '/custom/projects',
          isDefault: false
        },
        {
          id: 'default-documents-legacy',
          name: 'Documents',
          path: '/test/documents',
          isDefault: true
        }
      ];

      mockFs.readFile.mockImplementation((filePath) => {
        const normalizedPath = String(filePath).replace(/\\/g, '/');
        if (normalizedPath.endsWith('/userData/custom-folders.json')) {
          return Promise.resolve(JSON.stringify(currentDefaults));
        }
        if (normalizedPath.endsWith('/StratoSort/custom-folders.json')) {
          return Promise.resolve(JSON.stringify(legacyFolders));
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });

      const folders = await customFolders.loadCustomFolders();

      expect(folders.some((folder) => folder.name === 'Projects')).toBe(true);
    });

    test('re-runs legacy recovery when an old completion marker exists but current folders lost custom entries', async () => {
      const currentDefaults = [
        {
          id: 'default-documents',
          name: 'Documents',
          path: '/test/documents',
          isDefault: true
        },
        {
          id: 'default-uncategorized',
          name: 'Uncategorized',
          path: '/test/uncategorized',
          isDefault: true
        }
      ];
      const legacyFolders = [
        {
          id: 'custom-projects',
          name: 'Projects',
          path: '/custom/projects',
          isDefault: false
        }
      ];
      const legacyRecoveryMarker = {
        completed: true,
        markerVersion: 2,
        updatedAt: '2026-03-08T15:42:56.678Z',
        addedCount: 1,
        sources: ['/legacy/StratoSort/custom-folders.json']
      };

      mockFs.readFile.mockImplementation((filePath) => {
        const normalizedPath = String(filePath).replace(/\\/g, '/');
        if (normalizedPath.endsWith('/userData/custom-folders.json')) {
          return Promise.resolve(JSON.stringify(currentDefaults));
        }
        if (normalizedPath.endsWith('/userData/custom-folders-legacy-recovery.v2.json')) {
          return Promise.resolve(JSON.stringify(legacyRecoveryMarker));
        }
        if (normalizedPath.endsWith('/StratoSort/custom-folders.json')) {
          return Promise.resolve(JSON.stringify(legacyFolders));
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });

      const folders = await customFolders.loadCustomFolders();

      expect(folders.some((folder) => folder.name === 'Projects')).toBe(true);
    });

    test('does not recover legacy default-only folders', async () => {
      const currentFolders = [
        {
          id: 'default-uncategorized',
          name: 'Uncategorized',
          path: '/test/uncategorized',
          isDefault: true
        }
      ];
      const legacyDefaultOnly = [
        {
          id: 'default-work-legacy',
          name: 'Work',
          path: '/legacy/work',
          isDefault: true
        },
        {
          id: 'default-financial-legacy',
          name: 'Financial',
          path: '/legacy/financial',
          isDefault: true
        }
      ];

      mockFs.readFile.mockImplementation((filePath) => {
        const normalizedPath = String(filePath).replace(/\\/g, '/');
        if (normalizedPath.endsWith('/userData/custom-folders.json')) {
          return Promise.resolve(JSON.stringify(currentFolders));
        }
        if (normalizedPath.endsWith('/StratoSort/custom-folders.json')) {
          return Promise.resolve(JSON.stringify(legacyDefaultOnly));
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });

      const folders = await customFolders.loadCustomFolders();

      expect(folders).toHaveLength(1);
      expect(folders[0].name).toBe('Uncategorized');
      expect(folders.some((folder) => folder.name === 'Work')).toBe(false);
    });

    test('does not recover legacy defaults when misflagged as non-default', async () => {
      const currentFolders = [
        {
          id: 'default-uncategorized',
          name: 'Uncategorized',
          path: '/test/uncategorized',
          isDefault: true
        }
      ];
      const legacyMisflaggedDefaults = [
        {
          id: 'legacy-documents',
          name: 'Documents',
          path: '/legacy/documents',
          isDefault: false
        },
        {
          id: 'legacy-images',
          name: 'Images',
          path: '/legacy/images',
          isDefault: false
        }
      ];

      mockFs.readFile.mockImplementation((filePath) => {
        const normalizedPath = String(filePath).replace(/\\/g, '/');
        if (normalizedPath.endsWith('/userData/custom-folders.json')) {
          return Promise.resolve(JSON.stringify(currentFolders));
        }
        if (normalizedPath.endsWith('/StratoSort/custom-folders.json')) {
          return Promise.resolve(JSON.stringify(legacyMisflaggedDefaults));
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });

      const folders = await customFolders.loadCustomFolders();

      expect(folders).toHaveLength(1);
      expect(folders[0].name).toBe('Uncategorized');
      expect(folders.some((folder) => folder.name === 'Documents')).toBe(false);
      expect(folders.some((folder) => folder.name === 'Images')).toBe(false);
    });

    test('recovers missing legacy custom folders even when current set already has custom entries', async () => {
      const currentFolders = [
        {
          id: 'custom-documents',
          name: 'Documents',
          path: '/custom/work-documents',
          isDefault: false
        },
        {
          id: 'default-uncategorized',
          name: 'Uncategorized',
          path: '/custom/uncategorized',
          isDefault: true
        }
      ];
      const legacyCustomFolders = [
        {
          id: 'legacy-projects',
          name: 'Projects',
          path: '/legacy/projects',
          isDefault: false
        }
      ];

      mockFs.readFile.mockImplementation((filePath) => {
        const normalizedPath = String(filePath).replace(/\\/g, '/');
        if (normalizedPath.endsWith('/userData/custom-folders.json')) {
          return Promise.resolve(JSON.stringify(currentFolders));
        }
        if (normalizedPath.endsWith('/StratoSort/custom-folders.json')) {
          return Promise.resolve(JSON.stringify(legacyCustomFolders));
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });

      const folders = await customFolders.loadCustomFolders();

      expect(folders.some((folder) => folder.name === 'Documents')).toBe(true);
      expect(folders.some((folder) => folder.name === 'Projects')).toBe(true);
    });

    test('recovers legacy-only default-name folders when they are persisted as non-default custom entries', async () => {
      const currentFolders = [
        {
          id: 'default-uncategorized',
          name: 'Uncategorized',
          path: '/custom/uncategorized',
          isDefault: true
        },
        {
          id: 'custom-nature',
          name: 'Nature',
          path: '/custom/nature',
          isDefault: false
        }
      ];
      const legacyCustomFolders = [
        {
          id: 'legacy-work',
          name: 'Work',
          path: '/legacy/work',
          isDefault: false
        },
        {
          id: 'legacy-code',
          name: 'Code',
          path: '/legacy/code',
          isDefault: false
        }
      ];

      mockFs.readFile.mockImplementation((filePath) => {
        const normalizedPath = String(filePath).replace(/\\/g, '/');
        if (normalizedPath.endsWith('/userData/custom-folders.json')) {
          return Promise.resolve(JSON.stringify(currentFolders));
        }
        if (normalizedPath.endsWith('/StratoSort/custom-folders.json')) {
          return Promise.resolve(JSON.stringify(legacyCustomFolders));
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });

      const folders = await customFolders.loadCustomFolders();

      expect(folders.some((folder) => folder.name === 'Nature')).toBe(true);
      expect(folders.some((folder) => folder.name === 'Work')).toBe(true);
      expect(folders.some((folder) => folder.name === 'Code')).toBe(true);
    });

    test('skips legacy recovery after marker is written to avoid repeatedly resurrecting removed folders', async () => {
      const currentFolders = [
        {
          id: 'custom-documents',
          name: 'Documents',
          path: '/custom/work-documents',
          isDefault: false
        },
        {
          id: 'default-uncategorized',
          name: 'Uncategorized',
          path: '/custom/uncategorized',
          isDefault: true
        }
      ];
      const legacyCustomFolders = [
        {
          id: 'legacy-projects',
          name: 'Projects',
          path: '/legacy/projects',
          isDefault: false
        }
      ];
      const markerPayload = {
        completed: true,
        markerVersion: 2,
        updatedAt: '2026-02-24T00:00:00.000Z',
        addedCount: 1
      };

      mockFs.readFile.mockImplementation((filePath) => {
        const normalizedPath = String(filePath).replace(/\\/g, '/');
        if (normalizedPath.endsWith('/userData/custom-folders.json')) {
          return Promise.resolve(JSON.stringify(currentFolders));
        }
        if (normalizedPath.endsWith('/userData/custom-folders-legacy-recovery.v2.json')) {
          return Promise.resolve(JSON.stringify(markerPayload));
        }
        if (normalizedPath.endsWith('/StratoSort/custom-folders.json')) {
          return Promise.resolve(JSON.stringify(legacyCustomFolders));
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });

      const folders = await customFolders.loadCustomFolders();

      expect(folders.some((folder) => folder.name === 'Documents')).toBe(true);
      expect(folders.some((folder) => folder.name === 'Projects')).toBe(false);
    });

    test('does not mark legacy recovery complete when no legacy source could be scanned', async () => {
      const currentFolders = [
        {
          id: 'custom-documents',
          name: 'Documents',
          path: '/custom/work-documents',
          isDefault: false
        },
        {
          id: 'default-uncategorized',
          name: 'Uncategorized',
          path: '/custom/uncategorized',
          isDefault: true
        }
      ];
      const legacyCustomFolders = [
        {
          id: 'legacy-projects',
          name: 'Projects',
          path: '/legacy/projects',
          isDefault: false
        }
      ];

      let legacyAvailable = false;
      mockFs.readFile.mockImplementation((filePath) => {
        const normalizedPath = String(filePath).replace(/\\/g, '/');
        if (normalizedPath.endsWith('/userData/custom-folders.json')) {
          return Promise.resolve(JSON.stringify(currentFolders));
        }
        if (normalizedPath.endsWith('/userData/custom-folders-legacy-recovery.v2.json')) {
          return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        }
        if (normalizedPath.endsWith('/StratoSort/custom-folders.json')) {
          if (legacyAvailable) {
            return Promise.resolve(JSON.stringify(legacyCustomFolders));
          }
          return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });

      const firstRun = await customFolders.loadCustomFolders();
      expect(firstRun.some((folder) => folder.name === 'Projects')).toBe(false);
      expect(
        mockFs.writeFile.mock.calls.filter(([target]) =>
          String(target).includes('custom-folders-legacy-recovery.v2.json')
        )
      ).toHaveLength(0);

      legacyAvailable = true;
      const secondRun = await customFolders.loadCustomFolders();
      expect(secondRun.some((folder) => folder.name === 'Projects')).toBe(true);
    });

    test('prunes persisted legacy default-only bundle to Uncategorized', async () => {
      const persistedLegacyDefaults = [
        {
          id: 'default-uncategorized',
          name: 'Uncategorized',
          path: '/legacy/uncategorized',
          isDefault: true
        },
        {
          id: 'default-work-legacy',
          name: 'Work',
          path: '/legacy/work',
          isDefault: true
        },
        {
          id: 'default-financial-legacy',
          name: 'Financial',
          path: '/legacy/financial',
          isDefault: true
        }
      ];

      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(persistedLegacyDefaults));

      const folders = await customFolders.loadCustomFolders();

      expect(folders).toHaveLength(1);
      expect(folders[0].name).toBe('Uncategorized');
      expect(folders[0].path).toBe('/legacy/uncategorized');
      expect(mockSafeWriteFile).toHaveBeenCalled();
      expect(folders.some((folder) => folder.name === 'Work')).toBe(false);
    });

    test('handles invalid JSON gracefully', async () => {
      mockFs.readFile.mockResolvedValueOnce('not valid json');

      const folders = await customFolders.loadCustomFolders();

      // Should create only Uncategorized when JSON is invalid
      expect(folders).toHaveLength(1);
      expect(folders[0].name).toBe('Uncategorized');
    });

    test('handles non-array JSON payload gracefully', async () => {
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify({ folders: [] }));

      const folders = await customFolders.loadCustomFolders();

      expect(folders).toHaveLength(1);
      expect(folders[0].name).toBe('Uncategorized');
    });

    test('auto-dedupes canonical-equivalent folders on load and persists the cleaned list', async () => {
      const savedFolders = [
        { id: 'f1', name: 'Logos', path: '/test/Logos', isDefault: false },
        {
          id: 'f2',
          name: 'Logos and Graphic Design',
          path: '/test/LogosGD',
          isDefault: false
        },
        {
          id: 'uncat',
          name: 'Uncategorized',
          path: '/test/uncategorized',
          isDefault: true
        }
      ];
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(savedFolders));

      const { logger } = require('../src/shared/logger');

      const loaded = await customFolders.loadCustomFolders();

      expect(loaded.some((f) => f.name === 'Logos and Graphic Design')).toBe(true);
      expect(loaded.some((f) => f.name === 'Logos')).toBe(false);
      expect(mockSafeWriteFile).toHaveBeenCalled();

      const infoCalls = logger.info.mock.calls.filter((call) =>
        String(call[0] || '').includes('Auto-deduped canonical-equivalent folders on load')
      );
      expect(infoCalls.length).toBeGreaterThanOrEqual(1);

      const warnCalls = logger.warn.mock.calls.filter((call) =>
        String(call[0] || '').includes('Canonical-equivalent folders detected')
      );
      expect(warnCalls).toHaveLength(0);
    });

    test('does NOT warn when persisted folders have no canonical duplicates', async () => {
      // Counterpart: the detector must not spam logs for healthy folder
      // sets. The "Uncategorized" + "Documents" pair share no tokens, so
      // no warning fires.
      const savedFolders = [
        { id: 'f1', name: 'Documents', path: '/test/Documents', isDefault: false },
        {
          id: 'uncat',
          name: 'Uncategorized',
          path: '/test/uncategorized',
          isDefault: true
        }
      ];
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(savedFolders));

      const { logger } = require('../src/shared/logger');

      await customFolders.loadCustomFolders();

      const warnCalls = logger.warn.mock.calls.filter((call) =>
        String(call[0] || '').includes('Canonical-equivalent folders detected')
      );
      expect(warnCalls).toHaveLength(0);
    });
  });

  describe('saveCustomFolders', () => {
    test('saves folders to file atomically', async () => {
      const folders = [
        {
          id: 'folder1',
          name: 'Documents',
          path: '/test/documents'
        }
      ];

      await customFolders.saveCustomFolders(folders);

      expect(mockSafeWriteFile).toHaveBeenCalled();
    });

    test('normalizes paths before saving', async () => {
      const folders = [
        {
          id: 'folder1',
          name: 'Documents',
          path: '/test/documents'
        }
      ];

      await customFolders.saveCustomFolders(folders);

      const writeCall = mockSafeWriteFile.mock.calls[0];
      expect(writeCall[1]).toContain('Documents');
    });

    test('handles non-array input', async () => {
      await customFolders.saveCustomFolders(null);

      expect(mockSafeWriteFile).toHaveBeenCalled();
    });

    test('cleans up temp file on write failure and re-throws', async () => {
      const folders = [{ id: 'folder1', name: 'Test', path: '/test' }];
      mockSafeWriteFile.mockRejectedValueOnce(new Error('Write failed'));

      await expect(customFolders.saveCustomFolders(folders)).rejects.toThrow('Write failed');
    });

    test('handles atomic write failure and re-throws', async () => {
      const folders = [{ id: 'folder1', name: 'Test', path: '/test' }];
      mockSafeWriteFile.mockRejectedValueOnce(new Error('Atomic write failed'));

      await expect(customFolders.saveCustomFolders(folders)).rejects.toThrow('Atomic write failed');
    });
  });

  describe('bounded Uncategorized probes (slow or unwritable Documents)', () => {
    const neverSettles = () => new Promise(() => {});
    const lastSavedFolders = () => JSON.parse(mockSafeWriteFile.mock.calls.at(-1)[1]);

    afterEach(() => {
      jest.useRealTimers();
      // mockImplementation survives clearAllMocks; restore the shared default.
      mockFs.mkdir.mockReset().mockResolvedValue(undefined);
      delete mockFs.stat;
    });

    test('logs the resolved Documents folder once at info', async () => {
      const { logger } = require('../src/shared/logger');

      await customFolders.loadCustomFolders();
      await customFolders.loadCustomFolders();

      const documentsLogs = logger.info.mock.calls.filter(
        ([msg]) => msg === '[STORAGE] Documents folder resolved for Uncategorized'
      );
      expect(documentsLogs).toEqual([
        [
          '[STORAGE] Documents folder resolved for Uncategorized',
          { documentsPath: '/mock/documents' }
        ]
      ]);
    });

    test('first launch: a hung mkdir is abandoned after the probe timeout and keeps the Documents path', async () => {
      jest.useFakeTimers();
      mockFs.mkdir.mockImplementation(neverSettles);
      const { logger } = require('../src/shared/logger');

      const pending = customFolders.loadCustomFolders();
      await jest.advanceTimersByTimeAsync(3000);
      const folders = await pending;

      // Organize creates a missing target directory on the first move, so a
      // slow volume must not relocate the catch-all folder into app data.
      expect(folders).toHaveLength(1);
      expect(folders[0].path).toBe('/mock/documents/Uncategorized');
      expect(lastSavedFolders()[0].path).toBe('/mock/documents/Uncategorized');
      expect(mockFs.mkdir).not.toHaveBeenCalledWith('/mock/userData/Uncategorized', {
        recursive: true
      });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Creating the Uncategorized folder is slow'),
        expect.objectContaining({ path: '/mock/documents/Uncategorized', timeoutMs: 3000 })
      );
    });

    test('first launch: an unwritable Documents keeps the Documents path and raises a warning flag', async () => {
      const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      mockFs.mkdir.mockImplementation(async (dir) => {
        if (String(dir).startsWith('/mock/documents')) throw eacces;
      });

      const folders = await customFolders.loadCustomFolders();

      // Never userData: organize moves user files into this folder, and the
      // uninstaller's "remove settings and data" option deletes userData.
      expect(folders[0].path).toBe('/mock/documents/Uncategorized');
      expect(lastSavedFolders()[0].path).toBe('/mock/documents/Uncategorized');
      expect(mockFs.mkdir).not.toHaveBeenCalledWith(
        expect.stringContaining('/mock/userData'),
        expect.anything()
      );
      const flags = require('../src/main/services/DegradedStateTracker').getInstance().list();
      expect(flags).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'storage.uncategorized-unavailable',
            severity: 'warning',
            detail: expect.objectContaining({
              path: '/mock/documents/Uncategorized',
              code: 'EACCES'
            })
          })
        ])
      );
    });

    test('a saved Documents path that still cannot be created is retried and flagged on every launch', async () => {
      const eperm = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      mockFs.stat = jest.fn().mockRejectedValue(enoent);
      mockFs.mkdir.mockRejectedValue(eperm);
      const saved = [
        {
          id: 'uncat',
          name: 'Uncategorized',
          path: '/mock/documents/Uncategorized',
          isDefault: true
        }
      ];
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(saved));

      const folders = await customFolders.loadCustomFolders();

      expect(mockFs.mkdir).toHaveBeenCalledWith('/mock/documents/Uncategorized', {
        recursive: true
      });
      expect(folders.find((f) => f.name === 'Uncategorized').path).toBe(
        '/mock/documents/Uncategorized'
      );
      const flags = require('../src/main/services/DegradedStateTracker').getInstance().list();
      expect(flags.map((flag) => flag.code)).toContain('storage.uncategorized-unavailable');
    });

    test('an fs ETIMEDOUT is a failure (flagged), not a probe timeout', async () => {
      const etimedout = Object.assign(new Error('ETIMEDOUT: connection timed out, mkdir'), {
        code: 'ETIMEDOUT'
      });
      mockFs.mkdir.mockImplementation(async (dir) => {
        if (String(dir).startsWith('/mock/documents')) throw etimedout;
      });
      const { logger } = require('../src/shared/logger');

      const folders = await customFolders.loadCustomFolders();

      expect(folders[0].path).toBe('/mock/documents/Uncategorized');
      expect(logger.warn).toHaveBeenCalledWith(
        '[STORAGE] Could not create the Uncategorized folder',
        expect.objectContaining({ code: 'ETIMEDOUT' })
      );
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('Creating the Uncategorized folder is slow'),
        expect.anything()
      );
    });

    test('a saved Uncategorized entry is left untouched when its check times out', async () => {
      jest.useFakeTimers();
      mockFs.stat = jest.fn(neverSettles);
      const saved = [
        { id: 'docs', name: 'Work', path: '/test/work' },
        { id: 'uncat', name: 'Uncategorized', path: '/slow/share/Uncategorized', isDefault: true }
      ];
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(saved));

      const pending = customFolders.loadCustomFolders();
      await jest.advanceTimersByTimeAsync(3000);
      const folders = await pending;

      expect(folders.find((f) => f.name === 'Uncategorized').path).toBe(
        '/slow/share/Uncategorized'
      );
      expect(mockFs.mkdir).not.toHaveBeenCalled();
      expect(mockSafeWriteFile).not.toHaveBeenCalled();
    });

    test('createDefaultUncategorizedFolder never throws, even when every mkdir fails', async () => {
      mockFs.mkdir.mockRejectedValue(Object.assign(new Error('EROFS'), { code: 'EROFS' }));

      const folder = await customFolders.createDefaultUncategorizedFolder();

      expect(folder).toEqual(
        expect.objectContaining({
          name: 'Uncategorized',
          isDefault: true,
          path: '/mock/documents/Uncategorized'
        })
      );
    });

    test('an unresolvable Documents folder puts the defaults under home/Documents, never userData', async () => {
      const { app } = require('electron');
      const defaultGetPath = app.getPath.getMockImplementation();
      app.getPath.mockImplementation((type) => {
        if (type === 'documents') throw new Error("Failed to get 'documents' path");
        if (type === 'userData') return '/mock/userData';
        if (type === 'home') return '/mock/home';
        return '/mock/path';
      });

      try {
        const folder = await customFolders.createDefaultUncategorizedFolder();

        expect(folder.path).toBe('/mock/home/Documents/Uncategorized');
      } finally {
        app.getPath.mockImplementation(defaultGetPath);
      }
    });
  });

  describe('resetToDefaultFolders', () => {
    test('creates default folders directly under Documents root', async () => {
      const folders = await customFolders.resetToDefaultFolders();

      expect(folders.find((folder) => folder.name === 'Documents')?.path).toBe(
        '/mock/documents/Documents'
      );
      expect(folders.find((folder) => folder.name === 'Uncategorized')?.path).toBe(
        '/mock/documents/Uncategorized'
      );
      expect(mockFs.mkdir).toHaveBeenCalledWith('/mock/documents/Documents', { recursive: true });
      expect(mockFs.mkdir).toHaveBeenCalledWith('/mock/documents/Uncategorized', {
        recursive: true
      });
    });
  });

  describe('dedupeSmartFoldersOnLoad', () => {
    test('removes duplicate id+path entries and keeps the better canonical name', () => {
      const folders = [
        {
          id: 'same-id',
          name: 'Logos',
          path: 'C:/Users/test/StratoSort/Logos'
        },
        {
          id: 'same-id',
          name: 'Logos and Graphic Design',
          path: 'C:/Users/test/StratoSort/Logos'
        },
        { id: 'other', name: 'Financial', path: 'C:/Users/test/StratoSort/Financial' }
      ];
      const { folders: deduped, removedCount } = customFolders.dedupeSmartFoldersOnLoad(folders);
      expect(removedCount).toBe(1);
      expect(deduped).toHaveLength(2);
      expect(deduped.some((f) => f.name === 'Logos and Graphic Design')).toBe(true);
      expect(deduped.some((f) => f.name === 'Logos')).toBe(false);
    });

    test('drops category-subject suffix folder when canonical name exists', () => {
      const folders = [
        { id: 'nature', name: 'Nature', path: 'C:/Users/test/StratoSort/Nature' },
        {
          id: 'nature-dup',
          name: 'Nature_17803333378895',
          path: 'C:/Users/test/StratoSort/Nature2'
        },
        { id: 'logos', name: 'Logos', path: 'C:/Users/test/StratoSort/Logos' }
      ];
      const { folders: deduped, removedCount } = customFolders.dedupeSmartFoldersOnLoad(folders);
      expect(removedCount).toBe(1);
      expect(deduped.some((f) => f.name === 'Nature')).toBe(true);
      expect(deduped.some((f) => f.name === 'Nature_17803333378895')).toBe(false);
    });
  });
});
