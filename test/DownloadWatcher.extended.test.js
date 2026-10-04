const path = require('path');

const { ErrorCategory } = require('../src/shared/errorClassifier');

// Mock dependencies
jest.mock('fs', () => ({
  promises: {
    stat: jest.fn(),
    access: jest.fn(),
    mkdir: jest.fn().mockResolvedValue(undefined),
    rename: jest.fn().mockResolvedValue(undefined)
  },
  constants: { R_OK: 4 }
}));

const mockFs = require('fs').promises;

jest.mock('chokidar', () => ({
  watch: jest.fn().mockReturnValue({
    on: jest.fn().mockReturnThis(),
    close: jest.fn(),
    removeAllListeners: jest.fn()
  })
}));

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

jest.mock('../src/shared/config/index', () => ({
  get: jest.fn((key, defaultVal) => defaultVal)
}));

jest.mock('../src/shared/errorClassifier', () => ({
  isNotFoundError: jest.fn(),
  isCrossDeviceError: jest.fn(),
  isExistsError: jest.fn(),
  getErrorCategory: jest.fn(),
  ErrorCategory: {
    FILE_IN_USE: 'FILE_IN_USE',
    NOT_FOUND: 'NOT_FOUND',
    PERMISSION_DENIED: 'PERMISSION_DENIED',
    UNKNOWN: 'UNKNOWN'
  }
}));

jest.mock('../src/shared/atomicFileOperations', () => ({
  crossDeviceMove: jest.fn().mockResolvedValue(undefined),
  // Delegate to the suite's fs.rename mock; tests drive occupied-destination
  // behavior by seeding renameNoReplace rejections. Real no-replace semantics
  // are covered by atomicFileOperations.test.js.
  renameNoReplace: jest.fn((src, dest) => require('fs').promises.rename(src, dest))
}));

jest.mock('../src/main/ipc/analysisUtils', () => ({
  recordAnalysisResult: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../src/main/services/autoOrganize/namingUtils', () => ({
  generateSuggestedNameFromAnalysis: jest.fn()
}));

jest.mock('../src/main/services/embedding/embeddingGate', () => ({
  shouldEmbed: jest.fn().mockResolvedValue({
    shouldEmbed: true,
    timing: 'after_organize',
    policy: 'embed'
  })
}));

// Mock fileOperationTracker to prevent infinite loop protection from interfering with tests
jest.mock('../src/shared/fileOperationTracker', () => ({
  getInstance: jest.fn(() => ({
    wasRecentlyOperated: jest.fn().mockReturnValue(false),
    recordOperation: jest.fn(),
    clear: jest.fn(),
    shutdown: jest.fn()
  })),
  FileOperationTracker: jest.fn(),
  DEFAULT_COOLDOWN_MS: 5000
}));

jest.mock('../src/main/errors/FileSystemError', () => ({
  FileSystemError: class FileSystemError extends Error {
    constructor(code, metadata = {}) {
      super(`FileSystemError: ${code}`);
      this.code = code;
      this.metadata = metadata;
      this.isFileSystemError = true;
    }
    getUserFriendlyMessage() {
      return this.message;
    }
    static fromNodeError(err) {
      return new FileSystemError(err.code || 'UNKNOWN');
    }
    static forOperation(op, err) {
      return new FileSystemError(`${op.toUpperCase()}_FAILED`);
    }
  },
  WatcherError: class WatcherError extends Error {
    constructor(path, error) {
      super('WatcherError');
      this.code = 'WATCHER_ERROR';
      this.isFileSystemError = true;
    }
    getUserFriendlyMessage() {
      return 'Watcher error';
    }
    shouldRetry() {
      return false;
    }
    toJSON() {
      return { message: 'Watcher error' };
    }
  }
}));

describe('DownloadWatcher Extended Coverage', () => {
  let DownloadWatcher;
  let watcher;
  let mockDependencies;
  let errorClassifier;
  let analysisUtils;
  let namingUtils;
  let embeddingGate;
  let originalSetTimeout;

  beforeEach(() => {
    jest.clearAllMocks();

    mockFs.stat.mockReset();
    mockFs.access.mockReset();
    mockFs.rename.mockReset();
    mockFs.mkdir.mockReset();

    // Setup setTimeout mock for retry logic
    originalSetTimeout = global.setTimeout;
    global.setTimeout = jest.fn((fn, delay) => {
      // Execute immediately for tests unless we want to control it
      if (typeof fn === 'function') fn();
      return { unref: jest.fn() };
    });

    DownloadWatcher = require('../src/main/services/DownloadWatcher');
    errorClassifier = require('../src/shared/errorClassifier');
    analysisUtils = require('../src/main/ipc/analysisUtils');
    namingUtils = require('../src/main/services/autoOrganize/namingUtils');
    embeddingGate = require('../src/main/services/embedding/embeddingGate');

    mockDependencies = {
      analyzeDocumentFile: jest.fn(),
      analyzeImageFile: jest.fn(),
      getCustomFolders: jest.fn().mockReturnValue([{ id: '1', name: 'Docs', path: '/docs' }]),
      autoOrganizeService: {
        processNewFile: jest.fn()
      },
      settingsService: {
        load: jest.fn().mockResolvedValue({
          autoOrganize: true,
          confidenceThreshold: 0.75,
          namingConvention: 'subject-date'
        })
      },
      notificationService: {
        notifyFileOrganized: jest.fn(),
        notifyLowConfidence: jest.fn()
      },
      analysisHistoryService: {}
    };

    watcher = new DownloadWatcher(mockDependencies);

    // Setup default mock behaviors
    mockFs.stat.mockResolvedValue({
      isDirectory: () => false,
      size: 100,
      birthtime: new Date(),
      mtime: new Date()
    });
    mockFs.access.mockResolvedValue(undefined);
    mockFs.rename.mockResolvedValue(undefined); // Reset rename behavior
    mockFs.mkdir.mockResolvedValue(undefined);
    embeddingGate.shouldEmbed.mockResolvedValue({
      shouldEmbed: true,
      timing: 'after_organize',
      policy: 'embed'
    });

    errorClassifier.isNotFoundError.mockReturnValue(false);
    errorClassifier.isCrossDeviceError.mockReturnValue(false);
    errorClassifier.isExistsError.mockReturnValue(false);
    errorClassifier.getErrorCategory.mockReturnValue('UNKNOWN');
  });

  afterEach(() => {
    global.setTimeout = originalSetTimeout;
  });

  describe('File Validation Edge Cases', () => {
    test('rejects files with .git in path', async () => {
      const filePath = path.join(path.sep, 'downloads', 'project', '.git', 'config');
      const result = await watcher._validateFile(filePath);
      expect(result).toBe(false);
    });

    test('rejects files with node_modules in path', async () => {
      const filePath = path.join(path.sep, 'downloads', 'project', 'node_modules', 'lib.js');
      const result = await watcher._validateFile(filePath);
      expect(result).toBe(false);
    });

    test('rejects files with node_modules in mixed-separator paths', async () => {
      const filePath = `${path.sep}downloads/project\\node_modules/lib.js`;
      const result = await watcher._validateFile(filePath);
      expect(result).toBe(false);
    });

    test('rejects empty files', async () => {
      mockFs.stat.mockResolvedValueOnce({ size: 0 });
      const result = await watcher._validateFile('/downloads/empty.txt');
      expect(result).toBe(false);
    });

    test('handles file disappearing during validation (TOCTOU)', async () => {
      // FIX: Now using fs.stat instead of fs.access for atomic existence check
      mockFs.stat.mockRejectedValueOnce(new Error('ENOENT'));
      errorClassifier.isNotFoundError.mockReturnValueOnce(true);

      const result = await watcher._validateFile('/downloads/gone.txt');
      expect(result).toBe(false);
    });

    test('rejects specific temp patterns', async () => {
      const patterns = [
        'file.tmp',
        'file.crdownload',
        'file.part',
        '~$doc.docx',
        '.DS_Store',
        'Thumbs.db'
      ];

      for (const name of patterns) {
        const result = await watcher._validateFile(`/downloads/${name}`);
        expect(result).toBe(false);
      }
    });
  });

  describe('User exclusion rules', () => {
    test('skips a file that matches a user exclusion glob', async () => {
      mockDependencies.settingsService.load.mockResolvedValue({
        downloadsTriageExclusions: ['*.iso', '**/archived/**']
      });

      expect(await watcher._validateFile('/downloads/ubuntu.iso')).toBe(false);
      expect(await watcher._validateFile('/downloads/archived/report.pdf')).toBe(false);
      // Excluded files never reach the stat / size gate.
      expect(mockFs.stat).not.toHaveBeenCalled();
    });

    test('still processes files the rules do not mention', async () => {
      mockDependencies.settingsService.load.mockResolvedValue({
        downloadsTriageExclusions: ['*.iso']
      });

      expect(await watcher._validateFile('/downloads/report.pdf')).toBe(true);
    });

    test('a settings read failure does not block the watcher', async () => {
      mockDependencies.settingsService.load.mockRejectedValue(new Error('settings unavailable'));

      expect(await watcher._validateFile('/downloads/report.pdf')).toBe(true);
    });

    test('the built-in defaults apply with an empty user list: installers are left alone', async () => {
      // The sweep skipped setup.exe by default while the live watcher ran a
      // filename-only analysis on it and raised "Manual Review Needed".
      mockDependencies.settingsService.load.mockResolvedValue({ downloadsTriageExclusions: [] });

      expect(await watcher._validateFile('/downloads/setup-1.2.3.exe')).toBe(false);
      expect(await watcher._validateFile('/downloads/ubuntu-24.04.iso')).toBe(false);
      expect(await watcher._validateFile('/downloads/photo.heic.crdownload')).toBe(false);
      expect(await watcher._validateFile('/downloads/report.pdf')).toBe(true);
      expect(mockFs.stat).toHaveBeenCalledTimes(1);
    });

    test('a relative folder rule reads beneath the watched Downloads folder, never above it', async () => {
      // `archived/**` means "skip folders named archived inside Downloads".
      // The matcher can only read it that way when the watcher tells it
      // which folder it watches; without that the rule is inert.
      mockDependencies.settingsService.load.mockResolvedValue({
        downloadsTriageExclusions: ['archived/**']
      });

      watcher.downloadsPath = '/downloads';
      expect(await watcher._validateFile('/downloads/x/archived/report.pdf')).toBe(false);
      expect(await watcher._validateFile('/downloads/report.pdf')).toBe(true);

      // A Downloads folder that itself sits under an `archived` folder is
      // not excluded whole.
      watcher.downloadsPath = '/home/u/archived/Downloads';
      expect(await watcher._validateFile('/home/u/archived/Downloads/report.pdf')).toBe(true);
    });

    test('start() records the folder it watches so the rules have a root', async () => {
      mockFs.stat.mockResolvedValue({ isDirectory: () => true });

      await watcher.start();

      expect(typeof watcher.downloadsPath).toBe('string');
      expect(path.basename(watcher.downloadsPath).toLowerCase()).toBe('downloads');
    });

    test('handleFile reads settings once and hands the snapshot to every phase', async () => {
      mockDependencies.settingsService.load.mockResolvedValue({
        autoOrganize: true,
        confidenceThreshold: 0.75,
        namingConvention: 'subject-date',
        downloadsTriageExclusions: ['*.psd']
      });
      mockDependencies.autoOrganizeService.processNewFile.mockResolvedValue({
        destination: '/docs/file.txt',
        confidence: 0.9,
        category: 'Docs'
      });

      await watcher.handleFile('/downloads/file.txt');

      expect(mockDependencies.settingsService.load).toHaveBeenCalledTimes(1);
      expect(mockDependencies.autoOrganizeService.processNewFile).toHaveBeenCalledWith(
        '/downloads/file.txt',
        expect.any(Array),
        expect.objectContaining({ autoOrganizeEnabled: true, confidenceThreshold: 0.75 })
      );

      mockDependencies.settingsService.load.mockClear();
      mockDependencies.autoOrganizeService.processNewFile.mockClear();
      await watcher.handleFile('/downloads/mockup.psd');
      expect(mockDependencies.settingsService.load).toHaveBeenCalledTimes(1);
      expect(mockDependencies.autoOrganizeService.processNewFile).not.toHaveBeenCalled();
    });
  });

  describe('_moveFile Retry Logic', () => {
    test('retries on FILE_IN_USE error and succeeds', async () => {
      // Fail twice with FILE_IN_USE, then succeed
      mockFs.rename
        .mockRejectedValueOnce(new Error('EBUSY'))
        .mockRejectedValueOnce(new Error('EBUSY'))
        .mockResolvedValueOnce(undefined);

      errorClassifier.getErrorCategory
        .mockReturnValueOnce(ErrorCategory.FILE_IN_USE)
        .mockReturnValueOnce(ErrorCategory.FILE_IN_USE);

      await watcher._moveFile('/src', '/dest');

      expect(mockFs.rename).toHaveBeenCalledTimes(3);
    });

    test('gives up after max retries for FILE_IN_USE', async () => {
      mockFs.rename.mockRejectedValue(new Error('EBUSY'));
      errorClassifier.getErrorCategory.mockReturnValue(ErrorCategory.FILE_IN_USE);

      await expect(watcher._moveFile('/src', '/dest')).rejects.toThrow();

      // Initial + 5 retries = 6 calls
      expect(mockFs.rename).toHaveBeenCalledTimes(6);
    });

    test('stops retrying and surfaces ENOENT if the file disappears mid-retry', async () => {
      mockFs.rename.mockRejectedValueOnce(new Error('EBUSY'));
      errorClassifier.getErrorCategory.mockReturnValueOnce(ErrorCategory.FILE_IN_USE);

      // _handleDuplicateMove also performs a stat on destination; reject enough times to
      // ensure the retry check sees the NOT_FOUND error.
      const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      mockFs.stat
        .mockRejectedValueOnce(enoent)
        .mockRejectedValueOnce(enoent)
        .mockRejectedValueOnce(enoent);
      errorClassifier.isNotFoundError.mockReturnValueOnce(true);

      // Must NOT resolve like a successful move — the caller would record
      // undo/history and notify for a file that never moved.
      await expect(watcher._moveFile('/src', '/dest')).rejects.toMatchObject({ code: 'ENOENT' });

      expect(mockFs.rename).toHaveBeenCalledTimes(1);
      // Stat called to verify existence before retry
      expect(mockFs.stat).toHaveBeenCalledWith('/src');
    });

    test('F-080: refuses to overwrite an occupied destination (fail closed, no bare rename)', async () => {
      // fs.rename silently replaces an occupied destination on every
      // platform. _moveFile must go through renameNoReplace so an occupied
      // destination surfaces as an error (the caller falls back to the
      // triage flow, which walks collision suffixes) instead of destroying
      // the occupant. The auto-organize service pre-computes unique names,
      // so EEXIST here is only the external-race window — fail closed.
      const { renameNoReplace } = require('../src/shared/atomicFileOperations');
      const eexist = new Error("EEXIST: file already exists, rename '/src' -> '/dest'");
      eexist.code = 'EEXIST';
      renameNoReplace.mockRejectedValueOnce(eexist);
      errorClassifier.isCrossDeviceError.mockReturnValueOnce(false);
      errorClassifier.getErrorCategory.mockReturnValueOnce(ErrorCategory.UNKNOWN);

      await expect(watcher._moveFile('/src', '/dest')).rejects.toMatchObject({
        isFileSystemError: true
      });
      // The bare, occupant-destroying rename must never run.
      expect(mockFs.rename).not.toHaveBeenCalled();
    });
  });

  describe('_moveFileWithConflictHandling', () => {
    test('F-080: occupied destination is detected by the no-replace preflight and walks to _1', async () => {
      const { renameNoReplace } = require('../src/shared/atomicFileOperations');
      const eexist = new Error('EEXIST: file already exists');
      eexist.code = 'EEXIST';
      renameNoReplace.mockRejectedValueOnce(eexist); // original destination occupied
      errorClassifier.isExistsError.mockReturnValueOnce(true);
      renameNoReplace.mockResolvedValueOnce(undefined); // _1 slot is free

      const result = await watcher._moveFileWithConflictHandling(
        '/src/file.txt',
        '/dest/file.txt',
        '.txt'
      );

      expect(result.destination).toEqual(expect.stringContaining('file_1.txt'));
      // The bare, occupant-destroying rename must never run.
      expect(mockFs.rename).not.toHaveBeenCalled();
    });

    test('generates unique name if destination exists', async () => {
      // First rename fails with EEXIST (destination occupied)
      mockFs.rename.mockRejectedValueOnce(new Error('EEXIST'));
      errorClassifier.isExistsError.mockReturnValueOnce(true);

      // Second rename (_1 suffix) succeeds
      mockFs.rename.mockResolvedValueOnce(undefined);

      await watcher._moveFileWithConflictHandling('/src/file.txt', '/dest/file.txt', '.txt');

      // Should have tried _1 suffix directly via rename (no fs.access TOCTOU)
      expect(mockFs.rename).toHaveBeenLastCalledWith(
        '/src/file.txt',
        expect.stringContaining('file_1.txt')
      );
    });

    test('increments counter until free name found', async () => {
      // First rename fails with EEXIST
      mockFs.rename.mockRejectedValueOnce(new Error('EEXIST'));
      errorClassifier.isExistsError.mockReturnValueOnce(true);

      // _1 rename fails with EEXIST
      mockFs.rename.mockRejectedValueOnce(new Error('EEXIST'));
      errorClassifier.isExistsError.mockReturnValueOnce(true);
      // _2 rename fails with EEXIST
      mockFs.rename.mockRejectedValueOnce(new Error('EEXIST'));
      errorClassifier.isExistsError.mockReturnValueOnce(true);
      // _3 rename succeeds
      mockFs.rename.mockResolvedValueOnce(undefined);

      await watcher._moveFileWithConflictHandling('/src/file.txt', '/dest/file.txt', '.txt');

      expect(mockFs.rename).toHaveBeenLastCalledWith(
        '/src/file.txt',
        expect.stringContaining('file_3.txt')
      );
    });

    test('falls back to crossDeviceMove on EXDEV', async () => {
      const { crossDeviceMove } = require('../src/shared/atomicFileOperations');
      mockFs.rename.mockRejectedValueOnce(new Error('EXDEV'));
      errorClassifier.isCrossDeviceError.mockReturnValueOnce(true);

      await watcher._moveFileWithConflictHandling('/src', '/dest', '.txt');

      expect(crossDeviceMove).toHaveBeenCalledWith('/src', '/dest', { verify: true });
    });
  });

  describe('Auto-Organize Integration', () => {
    test('records analysis history on success', async () => {
      mockDependencies.autoOrganizeService.processNewFile.mockResolvedValue({
        destination: '/docs/file.txt',
        confidence: 0.9,
        category: 'Docs'
      });

      await watcher._attemptAutoOrganize('/downloads/file.txt');

      expect(analysisUtils.recordAnalysisResult).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: '/docs/file.txt',
          result: expect.objectContaining({
            category: 'Docs',
            confidence: 90
          })
        })
      );
    });

    test('prefers analysis confidence for organized notifications when available', async () => {
      mockDependencies.autoOrganizeService.processNewFile.mockResolvedValue({
        destination: '/docs/file.txt',
        confidence: 0.1,
        analysisConfidence: 88,
        category: 'Docs'
      });

      await watcher._attemptAutoOrganize('/downloads/file.txt');

      expect(mockDependencies.notificationService.notifyFileOrganized).toHaveBeenCalledWith(
        'file.txt',
        'docs',
        88,
        '/docs/file.txt'
      );
    });

    test('uses low-confidence notification when routed for manual review', async () => {
      mockDependencies.autoOrganizeService.processNewFile.mockResolvedValue({
        destination: '/docs/file.txt',
        confidence: 0.1,
        analysisConfidence: 88,
        requiresManualReview: true,
        suggestedFolder: 'Docs'
      });

      await watcher._attemptAutoOrganize('/downloads/file.txt');

      expect(mockDependencies.notificationService.notifyLowConfidence).toHaveBeenCalledWith(
        'file.txt',
        10,
        75,
        'Docs',
        '/docs/file.txt'
      );
      expect(mockDependencies.notificationService.notifyFileOrganized).not.toHaveBeenCalled();
    });

    test('notifies on low confidence', async () => {
      mockDependencies.autoOrganizeService.processNewFile.mockResolvedValue({
        destination: null,
        confidence: 0.5,
        suggestedFolder: 'Docs'
      });

      await watcher._attemptAutoOrganize('/downloads/file.txt');

      expect(mockDependencies.notificationService.notifyLowConfidence).toHaveBeenCalledWith(
        'file.txt',
        50,
        75,
        'Docs',
        '/downloads/file.txt'
      );
    });

    // D2: a held file is never moved, its analysis is kept at the original
    // path, and the reviewer is told even when the only problem is a
    // suggested folder that is not a configured smart folder.
    test('keeps a held file in place, records its analysis there, and asks for review', async () => {
      mockDependencies.analysisHistoryService = {
        getAnalysisByPath: jest.fn().mockResolvedValue(null),
        recordAnalysis: jest.fn().mockResolvedValue('id-1')
      };
      watcher = new DownloadWatcher(mockDependencies);
      analysisUtils.recordAnalysisResult.mockClear();
      mockDependencies.autoOrganizeService.processNewFile.mockResolvedValue({
        source: '/downloads/lease.pdf',
        destination: null,
        held: true,
        requiresManualReview: true,
        confidence: 0.9,
        suggestedFolder: 'Housing',
        analysis: { category: 'Housing', summary: 'Lease renewal', extractionMethod: 'pdf-text' }
      });

      await watcher._attemptAutoOrganize('/downloads/lease.pdf');

      expect(mockFs.rename).not.toHaveBeenCalled();
      expect(analysisUtils.recordAnalysisResult).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: '/downloads/lease.pdf',
          result: expect.objectContaining({
            category: 'Housing',
            extractionMethod: 'pdf-text',
            actualPath: null
          })
        })
      );
      expect(mockDependencies.notificationService.notifyLowConfidence).toHaveBeenCalledWith(
        'lease.pdf',
        90,
        75,
        'Housing',
        '/downloads/lease.pdf'
      );
      expect(mockDependencies.notificationService.notifyFileOrganized).not.toHaveBeenCalled();
    });

    test('handles disappearing file before move (TOCTOU)', async () => {
      mockDependencies.autoOrganizeService.processNewFile.mockResolvedValue({
        destination: '/docs/file.txt',
        confidence: 1.0
      });

      // Mock _moveFile to throw NOT_FOUND
      mockFs.rename.mockRejectedValue(new Error('ENOENT'));
      errorClassifier.isNotFoundError.mockReturnValue(true);

      const result = await watcher._attemptAutoOrganize('/downloads/file.txt');

      // Should handle it gracefully
      expect(result.handled).toBe(true);
      expect(result.shouldFallback).toBe(false);
    });

    test('does not record undo or notify when the file vanishes during a FILE_IN_USE retry', async () => {
      mockDependencies.autoOrganizeService.processNewFile.mockResolvedValue({
        destination: '/docs/file.txt',
        confidence: 1.0,
        undoAction: { type: 'FILE_MOVE', data: { source: '/downloads/file.txt' } }
      });
      const recordAction = jest.fn().mockResolvedValue(undefined);
      watcher.autoOrganizeService.undoRedo = { recordAction };
      mockFs.rename.mockRejectedValueOnce(new Error('EBUSY'));
      errorClassifier.getErrorCategory.mockReturnValueOnce(ErrorCategory.FILE_IN_USE);
      const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      mockFs.stat.mockRejectedValue(enoent);
      errorClassifier.isNotFoundError.mockReturnValue(true);

      const result = await watcher._attemptAutoOrganize('/downloads/file.txt');

      expect(result).toEqual({ handled: true, shouldFallback: false });
      expect(mockFs.rename).toHaveBeenCalledTimes(1);
      expect(recordAction).not.toHaveBeenCalled();
      expect(mockDependencies.notificationService.notifyFileOrganized).not.toHaveBeenCalled();
      expect(analysisUtils.recordAnalysisResult).not.toHaveBeenCalled();
    });
  });

  describe('Directory Verification', () => {
    test('handles stat failure', async () => {
      mockFs.stat.mockRejectedValue(new Error('EACCES'));

      // We need to call _verifyDirectory directly or via start
      // It's private, but accessible in test
      const result = await watcher._verifyDirectory('/downloads');

      expect(result).toBe(false);
      expect(watcher.lastError).toBeDefined();
      expect(require('../src/shared/logger').logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Cannot access downloads directory'),
        expect.anything()
      );
    });

    test('handles non-directory path', async () => {
      mockFs.stat.mockResolvedValue({ isDirectory: () => false });

      const result = await watcher._verifyDirectory('/downloads');

      expect(result).toBe(false);
      expect(require('../src/shared/logger').logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Path is not a directory'),
        expect.anything()
      );
    });
  });

  describe('Watcher Error Handling', () => {
    test('stops watcher on fatal error', () => {
      watcher.restartAttempts = 3;
      watcher.maxRestartAttempts = 3;

      const mockChokidarWatcher = require('chokidar').watch();
      watcher.watcher = mockChokidarWatcher; // Set active watcher

      // Create a non-recoverable error
      const error = new Error('Fatal error');

      watcher._handleWatcherError(error);

      expect(mockChokidarWatcher.close).toHaveBeenCalled();
      expect(watcher.watcher).toBeNull();
    });
  });

  describe('Fallback Organize', () => {
    test('uses naming convention if enabled', async () => {
      mockDependencies.analyzeDocumentFile.mockResolvedValue({
        category: 'Docs',
        summary: 'test doc'
      });

      namingUtils.generateSuggestedNameFromAnalysis.mockReturnValue('NewName.pdf');

      await watcher._fallbackOrganize('/downloads/original.pdf');

      // Should have tried to rename to NewName.pdf
      // _moveFileWithConflictHandling calls fs.rename
      expect(mockFs.rename).toHaveBeenCalledWith(
        '/downloads/original.pdf',
        expect.stringContaining('NewName.pdf')
      );
    });

    test('records an undo entry for a fallback rename', async () => {
      const recordAction = jest.fn().mockResolvedValue('undo-1');
      watcher.autoOrganizeService.undoRedo = { recordAction };
      mockDependencies.analyzeDocumentFile.mockResolvedValue({
        category: 'Docs',
        summary: 'test doc'
      });
      namingUtils.generateSuggestedNameFromAnalysis.mockReturnValue('NewName.pdf');

      await watcher._fallbackOrganize('/downloads/original.pdf');

      expect(recordAction).toHaveBeenCalledTimes(1);
      expect(recordAction).toHaveBeenCalledWith('FILE_RENAME', {
        originalPath: '/downloads/original.pdf',
        newPath: expect.stringContaining('NewName.pdf'),
        source: 'download_watcher_fallback'
      });
    });

    test('does not record an undo entry when the name is unchanged', async () => {
      const recordAction = jest.fn().mockResolvedValue('undo-1');
      watcher.autoOrganizeService.undoRedo = { recordAction };
      mockDependencies.analyzeDocumentFile.mockResolvedValue({
        category: 'Docs',
        summary: 'test doc'
      });
      namingUtils.generateSuggestedNameFromAnalysis.mockReturnValue(null);

      await watcher._fallbackOrganize('/downloads/original.pdf');

      expect(recordAction).not.toHaveBeenCalled();
    });

    test('a failed undo record does not undo the rename or the history write', async () => {
      watcher.autoOrganizeService.undoRedo = {
        recordAction: jest.fn().mockRejectedValue(new Error('undo store busy'))
      };
      mockDependencies.analyzeDocumentFile.mockResolvedValue({
        category: 'Docs',
        summary: 'test doc'
      });
      namingUtils.generateSuggestedNameFromAnalysis.mockReturnValue('NewName.pdf');

      await watcher._fallbackOrganize('/downloads/original.pdf');

      expect(analysisUtils.recordAnalysisResult).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: expect.stringContaining('NewName.pdf') })
      );
    });

    test('records fallback history using final renamed path', async () => {
      mockDependencies.analyzeDocumentFile.mockResolvedValue({
        category: 'Docs',
        summary: 'test doc',
        suggestedName: 'original.pdf'
      });

      namingUtils.generateSuggestedNameFromAnalysis.mockReturnValue('NewName.pdf');

      await watcher._fallbackOrganize('/downloads/original.pdf');

      expect(analysisUtils.recordAnalysisResult).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: expect.stringContaining('NewName.pdf')
        })
      );
    });

    test('preserves analysis suggested name in fallback history when file is not renamed', async () => {
      mockDependencies.analyzeDocumentFile.mockResolvedValue({
        category: 'Docs',
        summary: 'test doc',
        suggestedName: 'ai_subject_name.pdf'
      });
      namingUtils.generateSuggestedNameFromAnalysis.mockReturnValue(null);

      await watcher._fallbackOrganize('/downloads/original.pdf');

      expect(analysisUtils.recordAnalysisResult).toHaveBeenCalledWith(
        expect.objectContaining({
          result: expect.objectContaining({
            suggestedName: 'ai_subject_name.pdf'
          })
        })
      );
    });

    test('records history for fallback-only analysis results', async () => {
      mockDependencies.analyzeDocumentFile.mockResolvedValue({
        category: 'Docs',
        summary: 'fallback',
        extractionMethod: 'failed',
        _isFallback: true
      });

      await watcher._fallbackOrganize('/downloads/original.pdf');

      expect(analysisUtils.recordAnalysisResult).toHaveBeenCalled();
    });

    test('embedding text includes final visible filename after rename', async () => {
      watcher.folderMatcher = {
        embedText: jest.fn().mockResolvedValue({ vector: [1, 2, 3], model: 'm' })
      };
      watcher.vectorDbService = {
        upsertFile: jest.fn().mockResolvedValue(true)
      };

      await watcher._embedAnalyzedFile('/docs/final-name.pdf', {
        suggestedName: 'original-ai-name.pdf',
        summary: 'test doc'
      });

      expect(watcher.folderMatcher.embedText).toHaveBeenCalledWith(
        expect.stringContaining('final-name.pdf')
      );
    });

    test('handles file disappearing during analysis', async () => {
      mockDependencies.analyzeDocumentFile.mockRejectedValue(new Error('ENOENT'));
      errorClassifier.isNotFoundError.mockReturnValue(true);

      await watcher._fallbackOrganize('/downloads/ghost.pdf');

      // Should log debug and return, not error
      // Check logger
      expect(require('../src/shared/logger').logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('File disappeared'),
        expect.any(String)
      );
    });
  });
});
