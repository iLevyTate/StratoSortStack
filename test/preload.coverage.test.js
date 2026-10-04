/**
 * Comprehensive preload coverage tests.
 * Targets: SecureIPCManager methods, buildEmbeddingSearchPayload,
 *          throwIfFailed, files.analyze routing, files.normalizePath,
 *          safeOn, auditStaleListeners, enqueueThrottled, cleanup.
 */

const mockInvoke = jest.fn();
const mockOn = jest.fn();
const mockRemoveListener = jest.fn();
const mockSend = jest.fn();
const mockExposeInMainWorld = jest.fn();

const mockGetPathForFile = jest.fn();

jest.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mockExposeInMainWorld },
  ipcRenderer: {
    invoke: mockInvoke,
    on: mockOn,
    removeListener: mockRemoveListener,
    send: mockSend
  },
  webUtils: { getPathForFile: mockGetPathForFile }
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
    checkRateLimit: jest.fn()
  }))
}));

jest.mock('../src/preload/ipcSanitizer', () => ({
  createIpcSanitizer: jest.fn(() => ({
    sanitizeArguments: jest.fn((args) => args)
  }))
}));

jest.mock('../src/preload/ipcValidator', () => ({
  createIpcValidator: jest.fn(() => ({
    validateResult: jest.fn((result) => result),
    validateEventSource: jest.fn(() => true),
    isValidSystemMetrics: jest.fn(() => true)
  }))
}));

jest.mock('../src/shared/pathSanitization', () => ({
  sanitizePath: jest.fn((p) => p.replace('file://', ''))
}));

jest.mock('../src/shared/performanceConstants', () => ({
  LIMITS: {
    MAX_IPC_REQUESTS_PER_SECOND: 200,
    IPC_INVOKE_TIMEOUT: 1000
  },
  TIMEOUTS: {
    DIRECTORY_SCAN: 2000,
    AI_ANALYSIS_LONG: 3000,
    AI_ANALYSIS_BATCH: 5000
  }
}));

// Spread the real module so SETTINGS_VALIDATION (used by settings.update's
// key allowlist gate) keeps its genuine shape; only the channel lists are
// overridden for these tests.
jest.mock('../src/shared/securityConfig', () => ({
  ...jest.requireActual('../src/shared/securityConfig'),
  ALLOWED_RECEIVE_CHANNELS: [
    'operation-progress',
    'app:error',
    'app:update',
    'system-metrics',
    'menu-action',
    'settings-changed-external',
    'operation-error',
    'operation-complete',
    'operation-failed',
    'file-operation-complete',
    'notification',
    'batch-results-chunk',
    'chat:stream-chunk',
    'chat:stream-end'
  ],
  ALLOWED_SEND_CHANNELS: ['renderer-error-report']
}));

// Use the real constants module. preload.js has its own generated
// IPC_CHANNELS copy (see `=== START GENERATED IPC_CHANNELS ===`), so today the
// only field it actually reads from '../shared/constants' is
// SUPPORTED_IMAGE_EXTENSIONS. The previous hand-rolled mock had truncated
// channel names (e.g. 'emb:search' / 'org:auto') that silently diverged from
// reality; tests already asserted against real channel values like
// 'embeddings:search' and 'analysis:analyze-document', so the mock was dead
// code that invited drift. jest.requireActual keeps the test honest if preload
// ever reintroduces a direct IPC_CHANNELS import.
jest.mock('../src/shared/constants', () => jest.requireActual('../src/shared/constants'));

// Matcher for the abort envelope appended by preload to every
// `ipcRenderer.invoke` call (see src/preload/preload.js _invokeWithTimeout).
const IPC_META_ENVELOPE = expect.objectContaining({
  __stratosortIpcMeta: expect.objectContaining({ requestId: expect.any(String) })
});

describe('Preload Coverage', () => {
  let electronAPI;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    global.window = global.window || {};
    global.window.addEventListener = jest.fn();
    global.window.removeEventListener = jest.fn();

    // Load preload module
    require('../src/preload/preload');

    // Capture exposed API
    const call = mockExposeInMainWorld.mock.calls[0];
    electronAPI = call ? call[1] : null;
  });

  describe('files.normalizePath', () => {
    test('normalizes duplicate separators', () => {
      expect(electronAPI.files.normalizePath('C:\\\\Users\\\\test')).toBe('C:\\Users\\test');
    });

    test('strips trailing separator', () => {
      expect(electronAPI.files.normalizePath('C:\\Users\\test\\')).toBe('C:\\Users\\test');
    });

    test('preserves root paths', () => {
      expect(electronAPI.files.normalizePath('C:\\')).toBe('C:\\');
    });

    test('handles UNC paths', () => {
      const result = electronAPI.files.normalizePath('\\\\server\\share\\file');
      expect(result).toContain('server');
    });

    test('returns non-string input unchanged', () => {
      expect(electronAPI.files.normalizePath(42)).toBe(42);
    });

    test('handles forward slash normalization', () => {
      expect(electronAPI.files.normalizePath('C://Users//test')).toBe('C:/Users/test');
    });
  });

  describe('files.analyze', () => {
    beforeEach(() => {
      mockInvoke.mockResolvedValue({ success: true });
    });

    test('routes image extensions to analyze:image', async () => {
      await electronAPI.files.analyze('C:\\photos\\test.jpg');
      expect(mockInvoke).toHaveBeenCalledWith(
        'analysis:analyze-image',
        'C:\\photos\\test.jpg',
        IPC_META_ENVELOPE
      );
    });

    test('routes PNG to image analysis', async () => {
      await electronAPI.files.analyze('C:\\photos\\test.png');
      expect(mockInvoke).toHaveBeenCalledWith(
        'analysis:analyze-image',
        'C:\\photos\\test.png',
        IPC_META_ENVELOPE
      );
    });

    test('routes document extensions to analyze:document', async () => {
      await electronAPI.files.analyze('C:\\docs\\report.pdf');
      expect(mockInvoke).toHaveBeenCalledWith(
        'analysis:analyze-document',
        'C:\\docs\\report.pdf',
        IPC_META_ENVELOPE
      );
    });

    test('rejects empty file path', async () => {
      await expect(electronAPI.files.analyze('')).rejects.toThrow('Invalid file path');
    });

    test('rejects HTTP URLs', async () => {
      await expect(electronAPI.files.analyze('http://example.com')).rejects.toThrow(
        'Invalid file path'
      );
    });

    test('rejects HTTPS URLs', async () => {
      await expect(electronAPI.files.analyze('https://example.com')).rejects.toThrow(
        'Invalid file path'
      );
    });

    test('accepts well-formed UNC paths (matches main-side smart-folder policy)', async () => {
      await electronAPI.files.analyze('\\\\server\\share\\report.pdf');
      expect(mockInvoke).toHaveBeenCalledWith(
        'analysis:analyze-document',
        '\\\\server\\share\\report.pdf',
        IPC_META_ENVELOPE
      );
    });

    test('rejects Windows device-namespace syntax', async () => {
      await expect(electronAPI.files.analyze('\\\\?\\C:\\docs\\report.pdf')).rejects.toThrow(
        'device-namespace'
      );
      await expect(electronAPI.files.analyze('\\\\.\\PhysicalDrive0')).rejects.toThrow(
        'device-namespace'
      );
    });

    test('rejects malformed UNC and UNC alternate data streams', async () => {
      await expect(electronAPI.files.analyze('\\\\server')).rejects.toThrow('malformed UNC');
      await expect(electronAPI.files.analyze('\\\\server\\share\\file.pdf:hidden')).rejects.toThrow(
        'malformed UNC'
      );
    });

    test('rejects relative paths', async () => {
      await expect(electronAPI.files.analyze('relative/path.pdf')).rejects.toThrow(
        'must be an absolute path'
      );
    });

    test('handles file:// protocol by sanitizing', async () => {
      await electronAPI.files.analyze('C:\\docs\\test.pdf');
      expect(mockInvoke).toHaveBeenCalled();
    });

    test('unwraps array input', async () => {
      await electronAPI.files.analyze(['C:\\docs\\report.pdf']);
      expect(mockInvoke).toHaveBeenCalledWith(
        'analysis:analyze-document',
        'C:\\docs\\report.pdf',
        IPC_META_ENVELOPE
      );
    });

    test('unwraps object with path property', async () => {
      await electronAPI.files.analyze({ path: 'C:\\docs\\report.pdf' });
      expect(mockInvoke).toHaveBeenCalledWith(
        'analysis:analyze-document',
        'C:\\docs\\report.pdf',
        IPC_META_ENVELOPE
      );
    });

    test('trims whitespace and quotes from path', async () => {
      await electronAPI.files.analyze('"C:\\docs\\report.pdf"');
      expect(mockInvoke).toHaveBeenCalledWith(
        'analysis:analyze-document',
        'C:\\docs\\report.pdf',
        IPC_META_ENVELOPE
      );
    });

    test('routes .gif to image analysis', async () => {
      await electronAPI.files.analyze('C:\\img\\anim.gif');
      expect(mockInvoke).toHaveBeenCalledWith(
        'analysis:analyze-image',
        'C:\\img\\anim.gif',
        IPC_META_ENVELOPE
      );
    });

    test('routes .webp to image analysis', async () => {
      await electronAPI.files.analyze('C:\\img\\photo.webp');
      expect(mockInvoke).toHaveBeenCalledWith(
        'analysis:analyze-image',
        'C:\\img\\photo.webp',
        IPC_META_ENVELOPE
      );
    });

    test('routes .heic to image analysis', async () => {
      await electronAPI.files.analyze('C:\\img\\photo.heic');
      expect(mockInvoke).toHaveBeenCalledWith(
        'analysis:analyze-image',
        'C:\\img\\photo.heic',
        IPC_META_ENVELOPE
      );
    });

    test('routes .mp4 to media analysis', async () => {
      await electronAPI.files.analyze('C:\\videos\\clip.mp4');
      expect(mockInvoke).toHaveBeenCalledWith(
        'analysis:analyze-media',
        'C:\\videos\\clip.mp4',
        IPC_META_ENVELOPE
      );
    });

    test('routes .mp3 to media analysis', async () => {
      await electronAPI.files.analyze('C:\\audio\\song.mp3');
      expect(mockInvoke).toHaveBeenCalledWith(
        'analysis:analyze-media',
        'C:\\audio\\song.mp3',
        IPC_META_ENVELOPE
      );
    });

    test('routes .mov to media analysis', async () => {
      await electronAPI.files.analyze('C:\\videos\\clip.mov');
      expect(mockInvoke).toHaveBeenCalledWith(
        'analysis:analyze-media',
        'C:\\videos\\clip.mov',
        IPC_META_ENVELOPE
      );
    });

    test('routes .wav to media analysis', async () => {
      await electronAPI.files.analyze('C:\\audio\\sound.wav');
      expect(mockInvoke).toHaveBeenCalledWith(
        'analysis:analyze-media',
        'C:\\audio\\sound.wav',
        IPC_META_ENVELOPE
      );
    });
  });

  describe('files.getStats', () => {
    test('returns normalized stats object', async () => {
      mockInvoke.mockResolvedValue({
        success: true,
        stats: { size: 1024, isDirectory: false }
      });

      const result = await electronAPI.files.getStats('C:\\file.txt');
      expect(result.success).toBe(true);
      expect(result.exists).toBe(true);
      expect(result.size).toBe(1024);
    });

    test('handles failure result', async () => {
      mockInvoke.mockResolvedValue({ success: false, error: 'not found' });

      const result = await electronAPI.files.getStats('C:\\missing.txt');
      expect(result.success).toBe(false);
      expect(result.exists).toBe(false);
    });

    test('handles null result', async () => {
      mockInvoke.mockResolvedValue(null);

      const result = await electronAPI.files.getStats('C:\\file.txt');
      expect(result).toBeNull();
    });
  });

  describe('settings with throwIfFailed', () => {
    test('settings.get resolves on success', async () => {
      mockInvoke.mockResolvedValue({ success: true, data: { theme: 'dark' } });
      const result = await electronAPI.settings.get();
      expect(result.success).toBe(true);
    });

    test('settings.save throws on failure', async () => {
      mockInvoke.mockResolvedValue({ success: false, error: 'validation failed' });
      await expect(electronAPI.settings.save({ invalid: true })).rejects.toThrow(
        'validation failed'
      );
    });

    test('settings.save allows canceled result', async () => {
      mockInvoke.mockResolvedValue({ success: false, canceled: true });
      const result = await electronAPI.settings.save({});
      expect(result.canceled).toBe(true);
    });

    test('settings.save allows cancelled (British spelling)', async () => {
      mockInvoke.mockResolvedValue({ success: false, cancelled: true });
      const result = await electronAPI.settings.save({});
      expect(result.cancelled).toBe(true);
    });

    test('settings.get throws when result is null', async () => {
      mockInvoke.mockResolvedValue(null);
      await expect(electronAPI.settings.get()).rejects.toThrow('Failed to load settings');
    });
  });

  describe('events.sendError', () => {
    test('sends error report via ipcRenderer.send', () => {
      electronAPI.events.sendError({ message: 'Test error', stack: 'stack...' });
      expect(mockSend).toHaveBeenCalledWith('renderer-error-report', expect.any(Object));
    });

    test('does nothing for null error data', () => {
      electronAPI.events.sendError(null);
      expect(mockSend).not.toHaveBeenCalled();
    });

    test('does nothing for error without message', () => {
      electronAPI.events.sendError({ code: 500 });
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('window methods', () => {
    test('window.minimize calls safeInvoke', async () => {
      mockInvoke.mockResolvedValue(true);
      await electronAPI.window.minimize();
      expect(mockInvoke).toHaveBeenCalledWith('window:minimize', IPC_META_ENVELOPE);
    });

    test('window.close calls safeInvoke', async () => {
      mockInvoke.mockResolvedValue(true);
      await electronAPI.window.close();
      expect(mockInvoke).toHaveBeenCalledWith('window:close', IPC_META_ENVELOPE);
    });
  });

  describe('system.log payload normalization', () => {
    test('coerces primitive data into an object payload', async () => {
      mockInvoke.mockResolvedValue({ success: true });
      await electronAPI.system.log('warn', 'hello', 'raw-string-data');

      expect(mockInvoke).toHaveBeenCalledWith(
        'system:log',
        {
          level: 'warn',
          message: 'hello',
          data: { value: 'raw-string-data' }
        },
        IPC_META_ENVELOPE
      );
    });

    test('maps unknown level and empty message to safe defaults', async () => {
      mockInvoke.mockResolvedValue({ success: true });
      await electronAPI.system.log('not-a-level', '', null);

      expect(mockInvoke).toHaveBeenCalledWith(
        'system:log',
        {
          level: 'info',
          message: '[renderer-log]',
          data: {}
        },
        IPC_META_ENVELOPE
      );
    });
  });

  describe('embeddings.search payload building', () => {
    test('builds default search payload', async () => {
      mockInvoke.mockResolvedValue({ results: [] });
      await electronAPI.embeddings.search('test query');
      expect(mockInvoke).toHaveBeenCalledWith(
        'embeddings:search',
        expect.objectContaining({
          query: 'test query',
          topK: 20,
          mode: 'hybrid'
        }),
        IPC_META_ENVELOPE
      );
    });

    test('includes optional parameters when provided', async () => {
      mockInvoke.mockResolvedValue({ results: [] });
      await electronAPI.embeddings.search('test', {
        topK: 5,
        minScore: 0.5,
        chunkWeight: 0.3,
        chunkTopK: 10,
        correctSpelling: true,
        expandSynonyms: false,
        rerank: true,
        rerankTopN: 3
      });

      expect(mockInvoke).toHaveBeenCalledWith(
        'embeddings:search',
        expect.objectContaining({
          query: 'test',
          topK: 5,
          minScore: 0.5,
          chunkWeight: 0.3,
          chunkTopK: 10,
          correctSpelling: true,
          expandSynonyms: false,
          rerank: true,
          rerankTopN: 3
        }),
        IPC_META_ENVELOPE
      );
    });
  });

  describe('safeOn listener management', () => {
    test('registers listener for allowed receive channels', () => {
      const callback = jest.fn();
      electronAPI.events.onOperationProgress(callback);
      expect(mockOn).toHaveBeenCalledWith('operation-progress', expect.any(Function));
    });

    test('returns cleanup function that removes listener', () => {
      const callback = jest.fn();
      const cleanup = electronAPI.events.onOperationProgress(callback);
      expect(typeof cleanup).toBe('function');
      cleanup();
      expect(mockRemoveListener).toHaveBeenCalledWith('operation-progress', expect.any(Function));
    });
  });

  describe('files.getPathForDroppedFile', () => {
    test('calls sanitizePath on raw path from webUtils', () => {
      const { sanitizePath } = require('../src/shared/pathSanitization');
      mockGetPathForFile.mockReturnValue('C:\\Users\\test\\file.pdf');

      const result = electronAPI.files.getPathForDroppedFile({ name: 'file.pdf' });

      expect(mockGetPathForFile).toHaveBeenCalledWith({ name: 'file.pdf' });
      expect(sanitizePath).toHaveBeenCalledWith('C:\\Users\\test\\file.pdf');
      expect(result).toBe('C:\\Users\\test\\file.pdf');
    });

    test('returns empty string when file is null', () => {
      const result = electronAPI.files.getPathForDroppedFile(null);

      expect(result).toBe('');
      expect(mockGetPathForFile).not.toHaveBeenCalled();
    });

    test('returns empty string when getPathForFile returns empty', () => {
      const { sanitizePath } = require('../src/shared/pathSanitization');
      sanitizePath.mockClear();
      mockGetPathForFile.mockReturnValue('');

      const result = electronAPI.files.getPathForDroppedFile({ name: 'file.pdf' });

      expect(result).toBe('');
      expect(sanitizePath).not.toHaveBeenCalled();
    });

    test('returns empty string when getPathForFile throws', () => {
      mockGetPathForFile.mockImplementation(() => {
        throw new Error('webUtils failed');
      });

      const result = electronAPI.files.getPathForDroppedFile({ name: 'file.pdf' });

      expect(result).toBe('');
    });

    test('falls back to cleaned raw path on a depth-limit (PATH_TOO_DEEP) rejection', () => {
      const { sanitizePath } = require('../src/shared/pathSanitization');
      mockGetPathForFile.mockReturnValue('C:\\Users\\test\\very\\nested\\file.pdf');
      sanitizePath.mockImplementationOnce(() => {
        const err = new Error('Invalid path: path depth (101) exceeds maximum (100)');
        err.code = 'PATH_TOO_DEEP';
        throw err;
      });

      const result = electronAPI.files.getPathForDroppedFile({ name: 'file.pdf' });

      expect(result).toBe('C:\\Users\\test\\very\\nested\\file.pdf');
    });

    test('falls back to cleaned raw path on a length-limit (PATH_TOO_LONG) rejection', () => {
      const { sanitizePath } = require('../src/shared/pathSanitization');
      mockGetPathForFile.mockReturnValue('C:\\Users\\test\\file.pdf');
      sanitizePath.mockImplementationOnce(() => {
        const err = new Error('Invalid path: path length (300) exceeds maximum (260)');
        err.code = 'PATH_TOO_LONG';
        throw err;
      });

      const result = electronAPI.files.getPathForDroppedFile({ name: 'file.pdf' });

      expect(result).toBe('C:\\Users\\test\\file.pdf');
    });

    test('fails closed (returns "") when sanitizePath rejects for a non-limit reason', () => {
      const { sanitizePath } = require('../src/shared/pathSanitization');
      mockGetPathForFile.mockReturnValue('C:\\Users\\test\\file.txt::$DATA');
      // Traversal / ADS / reserved-name rejections throw plain Errors (no .code)
      // — a canonical OS drop path never produces these, so the raw fallback
      // must NOT re-admit them.
      sanitizePath.mockImplementationOnce(() => {
        throw new Error('Invalid path: Windows alternate data stream syntax is not allowed');
      });

      const result = electronAPI.files.getPathForDroppedFile({ name: 'file.txt' });

      expect(result).toBe('');
    });

    test('fails closed when a length/depth fallback path still contains traversal', () => {
      const { sanitizePath } = require('../src/shared/pathSanitization');
      mockGetPathForFile.mockReturnValue('C:\\Users\\test\\..\\..\\Windows\\System32\\x');
      sanitizePath.mockImplementationOnce(() => {
        const err = new Error('Invalid path: path length exceeds maximum');
        err.code = 'PATH_TOO_LONG';
        throw err;
      });

      const result = electronAPI.files.getPathForDroppedFile({ name: 'x' });

      expect(result).toBe('');
    });
  });

  describe('API surface completeness', () => {
    test('exposes files API', () => {
      expect(electronAPI.files).toBeDefined();
      expect(typeof electronAPI.files.select).toBe('function');
      expect(typeof electronAPI.files.analyze).toBe('function');
      expect(typeof electronAPI.files.normalizePath).toBe('function');
    });

    test('exposes smartFolders API', () => {
      expect(electronAPI.smartFolders).toBeDefined();
      expect(typeof electronAPI.smartFolders.get).toBe('function');
    });

    test('exposes analysis API', () => {
      expect(electronAPI.analysis).toBeDefined();
      expect(typeof electronAPI.analysis.document).toBe('function');
      expect(typeof electronAPI.analysis.image).toBe('function');
      expect(typeof electronAPI.analysis.batch).toBe('function');
    });

    test('exposes embeddings API', () => {
      expect(electronAPI.embeddings).toBeDefined();
      expect(typeof electronAPI.embeddings.search).toBe('function');
    });

    test('exposes chat API', () => {
      expect(electronAPI.chat).toBeDefined();
      expect(typeof electronAPI.chat.queryStream).toBe('function');
      expect(typeof electronAPI.chat.cancelStream).toBe('function');
    });

    test('exposes knowledge API', () => {
      expect(electronAPI.knowledge).toBeDefined();
      expect(typeof electronAPI.knowledge.getRelationshipEdges).toBe('function');
    });

    test('exposes organize API', () => {
      expect(electronAPI.organize).toBeDefined();
      expect(typeof electronAPI.organize.auto).toBe('function');
    });

    test('exposes undoRedo API', () => {
      expect(electronAPI.undoRedo).toBeDefined();
      expect(typeof electronAPI.undoRedo.undo).toBe('function');
    });

    test('exposes system API', () => {
      expect(electronAPI.system).toBeDefined();
      expect(typeof electronAPI.system.getMetrics).toBe('function');
    });

    test('exposes vectorDb API', () => {
      expect(electronAPI.vectorDb).toBeDefined();
      expect(typeof electronAPI.vectorDb.getStats).toBe('function');
    });

    test('exposes llama API', () => {
      expect(electronAPI.llama).toBeDefined();
      expect(typeof electronAPI.llama.getModels).toBe('function');
    });

    test('exposes settings API', () => {
      expect(electronAPI.settings).toBeDefined();
      expect(typeof electronAPI.settings.get).toBe('function');
      expect(typeof electronAPI.settings.update).toBe('function');
    });
  });

  // Fix 1A: analysis.document/image/extractText path validation
  describe('analysis.document path validation (Fix 1A)', () => {
    beforeEach(() => {
      mockInvoke.mockResolvedValue({ success: true });
    });

    test('accepts well-formed UNC paths; rejects device-namespace syntax', async () => {
      await expect(
        electronAPI.analysis.document('\\\\nas\\share\\report.pdf')
      ).resolves.not.toThrow();
      await expect(electronAPI.analysis.document('\\\\?\\C:\\docs\\payload')).rejects.toThrow(
        'device-namespace'
      );
    });

    test('rejects relative paths', async () => {
      await expect(electronAPI.analysis.document('relative/path.pdf')).rejects.toThrow(
        'must be an absolute path'
      );
    });

    test('rejects HTTP URLs', async () => {
      await expect(electronAPI.analysis.document('http://evil.com/file')).rejects.toThrow(
        'Invalid file path'
      );
    });

    test('rejects paths with `..` traversal segments', async () => {
      await expect(
        electronAPI.analysis.document('C:\\Users\\me\\Documents\\..\\..\\Windows\\System32\\x')
      ).rejects.toThrow('path traversal');
      await expect(electronAPI.analysis.document('/home/me/docs/../../etc/passwd')).rejects.toThrow(
        'path traversal'
      );
    });

    test('accepts valid absolute path', async () => {
      await electronAPI.analysis.document('C:\\docs\\file.pdf');
      const docCalls = mockInvoke.mock.calls.filter((c) => c[0] === 'analysis:analyze-document');
      expect(docCalls).toHaveLength(1);
      expect(docCalls[0][1]).toBe('C:\\docs\\file.pdf');
    });
  });

  describe('analysis.image path validation (Fix 1A)', () => {
    beforeEach(() => {
      mockInvoke.mockResolvedValue({ success: true });
    });

    test('accepts well-formed UNC paths; rejects ADS stream names', async () => {
      await expect(electronAPI.analysis.image('\\\\nas\\share\\img.png')).resolves.not.toThrow();
      await expect(electronAPI.analysis.image('\\\\nas\\share\\img.png:hidden')).rejects.toThrow(
        'malformed UNC'
      );
    });

    test('rejects relative paths', async () => {
      await expect(electronAPI.analysis.image('relative/img.png')).rejects.toThrow(
        'must be an absolute path'
      );
    });

    test('accepts valid absolute path', async () => {
      await electronAPI.analysis.image('C:\\photos\\test.png');
      const imgCalls = mockInvoke.mock.calls.filter((c) => c[0] === 'analysis:analyze-image');
      expect(imgCalls).toHaveLength(1);
      expect(imgCalls[0][1]).toBe('C:\\photos\\test.png');
    });
  });

  describe('analysis.extractText path validation (Fix 1A)', () => {
    beforeEach(() => {
      mockInvoke.mockResolvedValue({ success: true });
    });

    test('accepts well-formed UNC paths; rejects device-namespace syntax', async () => {
      await expect(
        electronAPI.analysis.extractText('\\\\nas\\share\\img.png')
      ).resolves.not.toThrow();
      await expect(electronAPI.analysis.extractText('\\\\?\\C:\\img.png')).rejects.toThrow(
        'device-namespace'
      );
    });

    test('accepts valid absolute path', async () => {
      // Verifies path validation passes — call does not reject
      await expect(electronAPI.analysis.extractText('C:\\photos\\test.png')).resolves.not.toThrow();
    });
  });

  // Fix 2A: Event-only channels excluded from invoke whitelist
  describe('event-only channel exclusion (Fix 2A)', () => {
    test('event-only channels are exposed as listeners, not invoke targets', () => {
      // vectorDb.onStatusChanged is a listener (safeOn), not an invoke (safeInvoke).
      // The channel 'vdb:status-changed' should be removed from ALL_SEND_CHANNELS
      // so it cannot be invoked via safeInvoke.
      expect(electronAPI.vectorDb).toBeDefined();
      expect(typeof electronAPI.vectorDb.onStatusChanged).toBe('function');
      // Events exposed correctly as receive-only listeners
      expect(electronAPI.events).toBeDefined();
      expect(typeof electronAPI.events.onOperationProgress).toBe('function');
    });
  });

  // Fix 1C: Concurrency limits for expensive operations
  describe('concurrency limits (Fix 1C)', () => {
    test('rejects concurrent full-rebuild calls', async () => {
      // First call takes a while
      let resolveFirst;
      mockInvoke.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
      mockInvoke.mockResolvedValue({ success: true });

      const first = electronAPI.embeddings.fullRebuild();

      // Second call while first is pending should be rejected
      await expect(electronAPI.embeddings.fullRebuild()).rejects.toThrow(
        'Operation already in progress'
      );

      // Clean up first call
      resolveFirst({ success: true });
      await first;

      // After first completes, lock should be released — third call should succeed
      mockInvoke.mockResolvedValue({ success: true });
      await expect(electronAPI.embeddings.fullRebuild()).resolves.toBeDefined();
    });

    test('throttle rejection carries CONCURRENCY_LIMIT code for downstream handlers', async () => {
      // Renderer handlers (e.g. SettingsPanel auto-health-check) need to
      // distinguish a throttle rejection from a real IPC failure without
      // pattern-matching the message string.
      let resolveFirst;
      mockInvoke.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));

      const first = electronAPI.embeddings.fullRebuild();

      const throttled = electronAPI.embeddings.fullRebuild().catch((err) => err);
      const err = await throttled;
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe('CONCURRENCY_LIMIT');

      resolveFirst({ success: true });
      await first;
    });

    test('a throttled caller does not release the in-flight holder lock', async () => {
      // Regression: the finally block used to delete the concurrency lock for
      // ANY concurrency-limited channel, including a caller that was just
      // throttled. That released the lock still held by the in-flight owner,
      // so the next caller proceeded mid-operation and serialization broke.
      let resolveFirst;
      mockInvoke.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));

      // Holder A acquires the lock and stays in flight.
      const first = electronAPI.embeddings.fullRebuild();

      // Caller B is throttled — it must NOT free A's lock on its way out.
      await expect(electronAPI.embeddings.fullRebuild()).rejects.toThrow(
        'Operation already in progress'
      );

      // Caller C, while A is STILL pending, must also be throttled. With the
      // bug, B's finally had released the lock and C would proceed past the
      // throttle (rejecting with a different/no error) instead of being
      // serialized behind A.
      await expect(electronAPI.embeddings.fullRebuild()).rejects.toThrow(
        'Operation already in progress'
      );

      // Once the holder completes, the lock releases and a new call succeeds.
      resolveFirst({ success: true });
      await first;
      mockInvoke.mockResolvedValue({ success: true });
      await expect(electronAPI.embeddings.fullRebuild()).resolves.toBeDefined();
    });
  });

  // Fix 2C: Payload size guard
  describe('payload size guard (Fix 2C)', () => {
    beforeEach(() => {
      mockInvoke.mockResolvedValue({ success: true });
    });

    test('rejects strings exceeding 5MB', async () => {
      const hugeString = 'x'.repeat(6 * 1024 * 1024);
      await expect(electronAPI.settings.save(hugeString)).rejects.toThrow(
        'string exceeds 5MB limit'
      );
    });

    test('rejects arrays exceeding 10,000 items', async () => {
      const hugeArray = new Array(10001).fill('item');
      await expect(electronAPI.smartFolders.save(hugeArray)).rejects.toThrow(
        'array exceeds 10,000 item limit'
      );
    });

    test('rejects objects exceeding 5,000 keys', async () => {
      const hugeObj = {};
      for (let i = 0; i < 5001; i++) hugeObj[`key${i}`] = i;
      await expect(electronAPI.settings.save(hugeObj)).rejects.toThrow(
        'object exceeds 5,000 key limit'
      );
    });
  });

  // Fix 2E: Error code preservation
  describe('error code preservation (Fix 2E)', () => {
    afterEach(() => {
      mockInvoke.mockReset();
    });

    test('preserves error code from structured errors', async () => {
      const structuredError = new Error('File not found');
      structuredError.code = 'FILE_NOT_FOUND';
      structuredError.details = { path: '/test' };
      // Preload logging invokes `system:log` before `settings:get`; a single
      // mockRejectedValueOnce would be consumed by that best-effort log call.
      mockInvoke.mockImplementation((channel) => {
        if (channel === 'system:log') {
          return Promise.resolve();
        }
        return Promise.reject(structuredError);
      });

      try {
        await electronAPI.settings.get();
        // Should not reach here
        expect(true).toBe(false);
      } catch (err) {
        expect(err.message).toContain('File not found');
        expect(err.code).toBe('FILE_NOT_FOUND');
        expect(err.details).toEqual({ path: '/test' });
      }
    });
  });

  // Bridge-method invocation coverage
  // Each bridge method is a tiny arrow function that forwards to secureIPC.
  // Coverage credit comes from execution, not from `typeof === 'function'` checks,
  // so this block exercises every method one-shot. Listener bridges (onX) for
  // channels not in the test mock's allowlist still invoke the wrapper before
  // safeOn early-returns — the wrapper itself is what we need covered.
  describe('Bridge invocation coverage', () => {
    beforeEach(() => {
      mockInvoke.mockResolvedValue({ success: true });
    });

    test('embeddings tail bridges', async () => {
      await electronAPI.embeddings.findSimilar('id-1', 5);
      expect(mockInvoke).toHaveBeenCalledWith(
        'embeddings:find-similar',
        { fileId: 'id-1', topK: 5 },
        IPC_META_ENVELOPE
      );
      await electronAPI.embeddings.rebuildBM25Index();
      expect(mockInvoke).toHaveBeenCalledWith('embeddings:rebuild-bm25', IPC_META_ENVELOPE);
      await electronAPI.embeddings.getSearchStatus();
      expect(mockInvoke).toHaveBeenCalledWith('embeddings:get-search-status', IPC_META_ENVELOPE);
      await electronAPI.embeddings.diagnoseSearch('q');
      expect(mockInvoke).toHaveBeenCalledWith(
        'embeddings:diagnose-search',
        { testQuery: 'q' },
        IPC_META_ENVELOPE
      );
      await electronAPI.embeddings.findMultiHop(['s1'], { depth: 2 });
      expect(mockInvoke).toHaveBeenCalledWith(
        'embeddings:find-multi-hop',
        { seedIds: ['s1'], options: { depth: 2 } },
        IPC_META_ENVELOPE
      );
      await electronAPI.embeddings.computeClusters('auto');
      expect(mockInvoke).toHaveBeenCalledWith(
        'embeddings:compute-clusters',
        { k: 'auto' },
        IPC_META_ENVELOPE
      );
      await electronAPI.embeddings.getClusters();
      expect(mockInvoke).toHaveBeenCalledWith('embeddings:get-clusters', IPC_META_ENVELOPE);
      await electronAPI.embeddings.getClusterMembers('c1');
      expect(mockInvoke).toHaveBeenCalledWith(
        'embeddings:get-cluster-members',
        { clusterId: 'c1' },
        IPC_META_ENVELOPE
      );
      await electronAPI.embeddings.getSimilarityEdges(['f1', 'f2'], { threshold: 0.5 });
      expect(mockInvoke).toHaveBeenCalledWith(
        'embeddings:get-similarity-edges',
        { fileIds: ['f1', 'f2'], threshold: 0.5, maxEdgesPerNode: undefined },
        IPC_META_ENVELOPE
      );
      await electronAPI.embeddings.getFileMetadata(['f1']);
      expect(mockInvoke).toHaveBeenCalledWith(
        'embeddings:get-file-metadata',
        { fileIds: ['f1'] },
        IPC_META_ENVELOPE
      );
      await electronAPI.embeddings.findFilesByPaths(['C:/a.txt']);
      expect(mockInvoke).toHaveBeenCalledWith(
        'embeddings:find-files-by-paths',
        { paths: ['C:/a.txt'] },
        IPC_META_ENVELOPE
      );
      await electronAPI.embeddings.findDuplicates({ minSimilarity: 0.9 });
      expect(mockInvoke).toHaveBeenCalledWith(
        'embeddings:find-duplicates',
        { minSimilarity: 0.9 },
        IPC_META_ENVELOPE
      );
      await electronAPI.embeddings.trashDuplicates({ ids: ['f1'] });
      expect(mockInvoke).toHaveBeenCalledWith(
        'embeddings:trash-duplicates',
        { ids: ['f1'] },
        IPC_META_ENVELOPE
      );
      await electronAPI.embeddings.reindexFileHashes({ scope: 'all' });
      expect(mockInvoke).toHaveBeenCalledWith(
        'embeddings:reindex-file-hashes',
        { scope: 'all' },
        IPC_META_ENVELOPE
      );
      await electronAPI.embeddings.clearClusters();
      expect(mockInvoke).toHaveBeenCalledWith('embeddings:clear-clusters', IPC_META_ENVELOPE);
      await electronAPI.embeddings.renameCluster('c1', 'New');
      expect(mockInvoke).toHaveBeenCalledWith(
        'embeddings:rename-cluster',
        { clusterId: 'c1', newLabel: 'New' },
        IPC_META_ENVELOPE
      );
    });

    test('chat bridges', async () => {
      await electronAPI.chat.queryStream({ q: 'hi' });
      expect(mockInvoke).toHaveBeenCalledWith('chat:query-stream', { q: 'hi' }, IPC_META_ENVELOPE);
      await electronAPI.chat.cancelStream({ sessionId: 's1' });
      expect(mockInvoke).toHaveBeenCalledWith(
        'chat:cancel-stream',
        { sessionId: 's1' },
        IPC_META_ENVELOPE
      );
      const offChunk = electronAPI.chat.onStreamChunk(jest.fn());
      const offEnd = electronAPI.chat.onStreamEnd(jest.fn());
      expect(typeof offChunk).toBe('function');
      expect(typeof offEnd).toBe('function');
      await electronAPI.chat.resetSession('s1');
      expect(mockInvoke).toHaveBeenCalledWith(
        'chat:reset-session',
        { sessionId: 's1' },
        IPC_META_ENVELOPE
      );
      await electronAPI.chat.listConversations(10, 0);
      expect(mockInvoke).toHaveBeenCalledWith(
        'chat:list-conversations',
        { limit: 10, offset: 0 },
        IPC_META_ENVELOPE
      );
      await electronAPI.chat.getConversation('c1');
      expect(mockInvoke).toHaveBeenCalledWith(
        'chat:get-conversation',
        { id: 'c1' },
        IPC_META_ENVELOPE
      );
      await electronAPI.chat.deleteConversation('c1');
      expect(mockInvoke).toHaveBeenCalledWith(
        'chat:delete-conversation',
        { id: 'c1' },
        IPC_META_ENVELOPE
      );
      await electronAPI.chat.searchConversations('term');
      expect(mockInvoke).toHaveBeenCalledWith(
        'chat:search-conversations',
        { query: 'term' },
        IPC_META_ENVELOPE
      );
      await electronAPI.chat.exportConversation('c1');
      expect(mockInvoke).toHaveBeenCalledWith(
        'chat:export-conversation',
        { id: 'c1' },
        IPC_META_ENVELOPE
      );
    });

    test('knowledge bridges', async () => {
      await electronAPI.knowledge.getRelationshipEdges(['f1'], { minWeight: 0.1 });
      expect(mockInvoke).toHaveBeenCalledWith(
        'knowledge:get-relationship-edges',
        { fileIds: ['f1'], minWeight: 0.1, maxEdges: undefined },
        IPC_META_ENVELOPE
      );
      await electronAPI.knowledge.getRelationshipStats();
      expect(mockInvoke).toHaveBeenCalledWith(
        'knowledge:get-relationship-stats',
        IPC_META_ENVELOPE
      );
      await electronAPI.knowledge.getRelatedDocuments('f1', { limit: 10 });
      expect(mockInvoke).toHaveBeenCalledWith(
        'knowledge:get-related-documents',
        { fileId: 'f1', limit: 10, minWeight: undefined, similarityThreshold: undefined },
        IPC_META_ENVELOPE
      );
      await electronAPI.knowledge.rebuildRelationships();
      expect(mockInvoke).toHaveBeenCalledWith(
        'knowledge:rebuild-relationships',
        {},
        IPC_META_ENVELOPE
      );
    });

    test('downloads triage bridges', async () => {
      await electronAPI.downloads.triage.start({});
      expect(mockInvoke).toHaveBeenCalledWith('downloads:triage:start', {}, IPC_META_ENVELOPE);
      await electronAPI.downloads.triage.deepScan({ ids: [] });
      expect(mockInvoke).toHaveBeenCalledWith(
        'downloads:triage:deep-scan',
        { ids: [] },
        IPC_META_ENVELOPE
      );
      await electronAPI.downloads.triage.act({ id: 'x', action: 'keep' });
      expect(mockInvoke).toHaveBeenCalledWith(
        'downloads:triage:act',
        { id: 'x', action: 'keep' },
        IPC_META_ENVELOPE
      );
      const offProg = electronAPI.downloads.triage.onScanProgress(jest.fn());
      const offInv = electronAPI.downloads.triage.onSessionInvalidated(jest.fn());
      expect(typeof offProg).toBe('function');
      expect(typeof offInv).toBe('function');
    });

    test('July-burst bridges: atlas, transcript export, timeline, warm, triage report, file-complete stream', async () => {
      // Coverage for the methods PRs #359..#391 exposed without preload
      // tests — their absence dropped src/preload function coverage below
      // the 68% floor (found by the Pass-3 capstone `npm run ci`).
      mockInvoke.mockResolvedValue({ success: true });

      await electronAPI.atlas.getProjection({ offset: 0, limit: 100 });
      expect(mockInvoke).toHaveBeenCalledWith(
        'atlas:get-projection',
        expect.objectContaining({ offset: 0, limit: 100 }),
        IPC_META_ENVELOPE
      );
      await electronAPI.atlas.getProjection();
      expect(mockInvoke).toHaveBeenCalledWith('atlas:get-projection', {}, IPC_META_ENVELOPE);
      await electronAPI.atlas.getStatus();
      expect(mockInvoke).toHaveBeenCalledWith('atlas:get-status', IPC_META_ENVELOPE);

      await electronAPI.analysisHistory.exportTranscript('/docs/talk.mp3', 'vtt');
      expect(mockInvoke).toHaveBeenCalledWith(
        'analysis-history:export-transcript',
        { filePath: '/docs/talk.mp3', format: 'vtt' },
        IPC_META_ENVELOPE
      );
      await electronAPI.analysisHistory.getTimeline({ limit: 10, offset: 0 });
      expect(mockInvoke).toHaveBeenCalledWith(
        'analysis-history:get-timeline',
        { limit: 10, offset: 0 },
        IPC_META_ENVELOPE
      );
      await electronAPI.analysisHistory.getTimeline();
      expect(mockInvoke).toHaveBeenCalledWith(
        'analysis-history:get-timeline',
        {},
        IPC_META_ENVELOPE
      );

      await electronAPI.llama.warm();
      expect(mockInvoke).toHaveBeenCalledWith('llama:warm', IPC_META_ENVELOPE);

      await electronAPI.downloads.triage.exportReport('triage-1');
      expect(mockInvoke).toHaveBeenCalledWith(
        'downloads:triage:export-report',
        { triageId: 'triage-1' },
        IPC_META_ENVELOPE
      );

      const offFileComplete = electronAPI.events.onAnalysisFileComplete(jest.fn());
      expect(typeof offFileComplete).toBe('function');
      offFileComplete();
    });

    test('suggestions bridges', async () => {
      await electronAPI.suggestions.getFileSuggestions({ id: 'f1' }, {});
      expect(mockInvoke).toHaveBeenCalledWith(
        'suggestions:get-file',
        { file: { id: 'f1' }, options: {} },
        IPC_META_ENVELOPE
      );
      await electronAPI.suggestions.getBatchSuggestions([{ id: 'f1' }], {});
      expect(mockInvoke).toHaveBeenCalledWith(
        'suggestions:get-batch',
        { files: [{ id: 'f1' }], options: {} },
        IPC_META_ENVELOPE
      );
      await electronAPI.suggestions.recordFeedback({ id: 'f1' }, { kind: 's' }, true, 'note');
      expect(mockInvoke).toHaveBeenCalledWith(
        'suggestions:record-feedback',
        { file: { id: 'f1' }, suggestion: { kind: 's' }, accepted: true, note: 'note' },
        IPC_META_ENVELOPE
      );
      await electronAPI.suggestions.getStrategies();
      expect(mockInvoke).toHaveBeenCalledWith('suggestions:get-strategies', IPC_META_ENVELOPE);
      await electronAPI.suggestions.applyStrategy([{ id: 'f1' }], 'strat-1');
      expect(mockInvoke).toHaveBeenCalledWith(
        'suggestions:apply-strategy',
        { files: [{ id: 'f1' }], strategyId: 'strat-1' },
        IPC_META_ENVELOPE
      );
      await electronAPI.suggestions.getUserPatterns();
      expect(mockInvoke).toHaveBeenCalledWith('suggestions:get-user-patterns', IPC_META_ENVELOPE);
      await electronAPI.suggestions.clearPatterns();
      expect(mockInvoke).toHaveBeenCalledWith('suggestions:clear-patterns', IPC_META_ENVELOPE);
      await electronAPI.suggestions.analyzeFolderStructure([{ id: 'f1' }]);
      expect(mockInvoke).toHaveBeenCalledWith(
        'suggestions:analyze-folder-structure',
        { files: [{ id: 'f1' }] },
        IPC_META_ENVELOPE
      );
      await electronAPI.suggestions.suggestNewFolder({ id: 'f1' });
      expect(mockInvoke).toHaveBeenCalledWith(
        'suggestions:suggest-new-folder',
        { file: { id: 'f1' } },
        IPC_META_ENVELOPE
      );
      await electronAPI.suggestions.addFeedbackMemory('text', { tag: 't' });
      expect(mockInvoke).toHaveBeenCalledWith(
        'suggestions:add-feedback-memory',
        { text: 'text', metadata: { tag: 't' } },
        IPC_META_ENVELOPE
      );
      await electronAPI.suggestions.getFeedbackMemory();
      expect(mockInvoke).toHaveBeenCalledWith('suggestions:get-feedback-memory', IPC_META_ENVELOPE);
      await electronAPI.suggestions.updateFeedbackMemory('id-1', 'text', { tag: 't' });
      expect(mockInvoke).toHaveBeenCalledWith(
        'suggestions:update-feedback-memory',
        { id: 'id-1', text: 'text', metadata: { tag: 't' } },
        IPC_META_ENVELOPE
      );
      await electronAPI.suggestions.deleteFeedbackMemory('id-1');
      expect(mockInvoke).toHaveBeenCalledWith(
        'suggestions:delete-feedback-memory',
        { id: 'id-1' },
        IPC_META_ENVELOPE
      );
    });

    test('organize bridges', async () => {
      await electronAPI.organize.auto({ files: [] });
      expect(mockInvoke).toHaveBeenCalledWith('organize:auto', { files: [] }, IPC_META_ENVELOPE);
      await electronAPI.organize.batch({ ops: [] });
      expect(mockInvoke).toHaveBeenCalledWith('organize:batch', { ops: [] }, IPC_META_ENVELOPE);
      await electronAPI.organize.processNew({ ids: [] });
      expect(mockInvoke).toHaveBeenCalledWith(
        'organize:process-new',
        { ids: [] },
        IPC_META_ENVELOPE
      );
      await electronAPI.organize.getStats();
      expect(mockInvoke).toHaveBeenCalledWith('organize:get-stats', IPC_META_ENVELOPE);
      await electronAPI.organize.clusterBatch([{ id: 'f1' }], [{ id: 'sf1' }]);
      expect(mockInvoke).toHaveBeenCalledWith(
        'organize:cluster-batch',
        { files: [{ id: 'f1' }], smartFolders: [{ id: 'sf1' }] },
        IPC_META_ENVELOPE
      );
      await electronAPI.organize.identifyOutliers([{ id: 'f1' }]);
      expect(mockInvoke).toHaveBeenCalledWith(
        'organize:identify-outliers',
        { files: [{ id: 'f1' }] },
        IPC_META_ENVELOPE
      );
      await electronAPI.organize.getClusterSuggestions({ id: 'f1' }, [{ id: 'sf1' }]);
      expect(mockInvoke).toHaveBeenCalledWith(
        'organize:get-cluster-suggestions',
        { file: { id: 'f1' }, smartFolders: [{ id: 'sf1' }] },
        IPC_META_ENVELOPE
      );
    });

    test('undoRedo bridges', async () => {
      await electronAPI.undoRedo.undo();
      expect(mockInvoke).toHaveBeenCalledWith('undo-redo:undo', IPC_META_ENVELOPE);
      await electronAPI.undoRedo.redo();
      expect(mockInvoke).toHaveBeenCalledWith('undo-redo:redo', IPC_META_ENVELOPE);
      await electronAPI.undoRedo.getHistory(20);
      expect(mockInvoke).toHaveBeenCalledWith('undo-redo:get-history', 20, IPC_META_ENVELOPE);
      await electronAPI.undoRedo.getState();
      expect(mockInvoke).toHaveBeenCalledWith('undo-redo:get-state', IPC_META_ENVELOPE);
      await electronAPI.undoRedo.clear();
      expect(mockInvoke).toHaveBeenCalledWith('undo-redo:clear', IPC_META_ENVELOPE);
      await electronAPI.undoRedo.canUndo();
      expect(mockInvoke).toHaveBeenCalledWith('undo-redo:can-undo', IPC_META_ENVELOPE);
      await electronAPI.undoRedo.canRedo();
      expect(mockInvoke).toHaveBeenCalledWith('undo-redo:can-redo', IPC_META_ENVELOPE);
      const off = electronAPI.undoRedo.onStateChanged(jest.fn());
      expect(typeof off).toBe('function');
    });

    test('system bridges', async () => {
      await electronAPI.system.getMetrics();
      expect(mockInvoke).toHaveBeenCalledWith('system:get-metrics', IPC_META_ENVELOPE);
      await electronAPI.system.getApplicationStatistics();
      expect(mockInvoke).toHaveBeenCalledWith('system:get-app-stats', IPC_META_ENVELOPE);
      await electronAPI.system.applyUpdate();
      expect(mockInvoke).toHaveBeenCalledWith('system:apply-update', IPC_META_ENVELOPE);
      await electronAPI.system.checkForUpdates();
      expect(mockInvoke).toHaveBeenCalledWith('system:check-for-updates', IPC_META_ENVELOPE);
      await electronAPI.system.downloadUpdate();
      expect(mockInvoke).toHaveBeenCalledWith('system:download-update', IPC_META_ENVELOPE);
      await electronAPI.system.getConfig();
      expect(mockInvoke).toHaveBeenCalledWith('system:get-config', IPC_META_ENVELOPE);
      await electronAPI.system.getConfigValue('feature.flag');
      expect(mockInvoke).toHaveBeenCalledWith(
        'system:get-config-value',
        'feature.flag',
        IPC_META_ENVELOPE
      );
      await electronAPI.system.getRecommendedConcurrency();
      expect(mockInvoke).toHaveBeenCalledWith(
        'system:get-recommended-concurrency',
        IPC_META_ENVELOPE
      );
      await electronAPI.system.exportLogs();
      expect(mockInvoke).toHaveBeenCalledWith('system:export-logs', IPC_META_ENVELOPE);
      await electronAPI.system.getDegradedState();
      expect(mockInvoke).toHaveBeenCalledWith('system:get-degraded-state', IPC_META_ENVELOPE);
      await electronAPI.system.dismissDegradedFlag('CODE_X');
      expect(mockInvoke).toHaveBeenCalledWith(
        'system:dismiss-degraded-flag',
        { code: 'CODE_X' },
        IPC_META_ENVELOPE
      );
      const off = electronAPI.system.onOpenSemanticSearch(jest.fn());
      expect(typeof off).toBe('function');
    });

    test('trace bridges', () => {
      const session = electronAPI.trace.beginSession();
      expect(session).toBeDefined();
      expect(typeof session.traceId).toBe('string');
      const tid = electronAPI.trace.generateTraceId();
      expect(typeof tid).toBe('string');
      const cur = electronAPI.trace.currentTraceId();
      // After beginSession, currentTraceId should match (or be null if expired).
      expect(cur === null || typeof cur === 'string').toBe(true);
      session.end();
    });

    test('window bridges', async () => {
      await electronAPI.window.minimize();
      expect(mockInvoke).toHaveBeenCalledWith('window:minimize', IPC_META_ENVELOPE);
      await electronAPI.window.toggleMaximize();
      expect(mockInvoke).toHaveBeenCalledWith('window:toggle-maximize', IPC_META_ENVELOPE);
      await electronAPI.window.isMaximized();
      expect(mockInvoke).toHaveBeenCalledWith('window:is-maximized', IPC_META_ENVELOPE);
      await electronAPI.window.close();
      expect(mockInvoke).toHaveBeenCalledWith('window:close', IPC_META_ENVELOPE);
    });

    test('llama bridges', async () => {
      await electronAPI.llama.getModels();
      expect(mockInvoke).toHaveBeenCalledWith('llama:get-models', IPC_META_ENVELOPE);
      await electronAPI.llama.getConfig();
      expect(mockInvoke).toHaveBeenCalledWith('llama:get-config', IPC_META_ENVELOPE);
      await electronAPI.llama.updateConfig({ topK: 40 });
      expect(mockInvoke).toHaveBeenCalledWith(
        'llama:update-config',
        { topK: 40 },
        IPC_META_ENVELOPE
      );
      await electronAPI.llama.testConnection();
      expect(mockInvoke).toHaveBeenCalledWith('llama:test-connection', IPC_META_ENVELOPE);
      await electronAPI.llama.downloadModel('llama-3-8b');
      expect(mockInvoke).toHaveBeenCalledWith(
        'llama:download-model',
        'llama-3-8b',
        IPC_META_ENVELOPE
      );
      await electronAPI.llama.deleteModel('llama-3-8b');
      expect(mockInvoke).toHaveBeenCalledWith(
        'llama:delete-model',
        'llama-3-8b',
        IPC_META_ENVELOPE
      );
      await electronAPI.llama.getDownloadStatus();
      expect(mockInvoke).toHaveBeenCalledWith('llama:get-download-status', IPC_META_ENVELOPE);
    });

    test('vectorDb bridges', async () => {
      await electronAPI.vectorDb.getStats();
      expect(mockInvoke).toHaveBeenCalledWith('vectordb:get-stats', IPC_META_ENVELOPE);
      await electronAPI.vectorDb.healthCheck();
      expect(mockInvoke).toHaveBeenCalledWith('vectordb:health-check', IPC_META_ENVELOPE);
      const off = electronAPI.vectorDb.onStatusChanged(jest.fn());
      expect(typeof off).toBe('function');
    });

    test('events listener bridges', () => {
      const offs = [
        electronAPI.events.onOperationProgress(jest.fn()),
        electronAPI.events.onAppError(jest.fn()),
        electronAPI.events.onAppUpdate(jest.fn()),
        electronAPI.events.onSystemMetrics(jest.fn()),
        electronAPI.events.onMenuAction(jest.fn()),
        electronAPI.events.onSettingsChanged(jest.fn()),
        electronAPI.events.onFileOperationComplete(jest.fn()),
        electronAPI.events.onNotification(jest.fn()),
        electronAPI.events.onBatchResultsChunk(jest.fn())
      ];
      offs.forEach((off) => expect(typeof off).toBe('function'));
    });

    test('settings extended bridges', async () => {
      await electronAPI.settings.getConfigurableLimits();
      expect(mockInvoke).toHaveBeenCalledWith('settings:get-limits', IPC_META_ENVELOPE);
      await electronAPI.settings.getLogsInfo();
      expect(mockInvoke).toHaveBeenCalledWith('settings:get-logs-info', IPC_META_ENVELOPE);
      await electronAPI.settings.openLogsFolder();
      expect(mockInvoke).toHaveBeenCalledWith('settings:open-logs-folder', IPC_META_ENVELOPE);
      await electronAPI.settings.export('C:/out.json');
      expect(mockInvoke).toHaveBeenCalledWith('settings:export', 'C:/out.json', IPC_META_ENVELOPE);
      await electronAPI.settings.import('C:/in.json');
      expect(mockInvoke).toHaveBeenCalledWith('settings:import', 'C:/in.json', IPC_META_ENVELOPE);
      await electronAPI.settings.createBackup();
      expect(mockInvoke).toHaveBeenCalledWith('settings:create-backup', IPC_META_ENVELOPE);
      await electronAPI.settings.listBackups();
      expect(mockInvoke).toHaveBeenCalledWith('settings:list-backups', IPC_META_ENVELOPE);
      await electronAPI.settings.restoreBackup('C:/backup.json');
      expect(mockInvoke).toHaveBeenCalledWith(
        'settings:restore-backup',
        'C:/backup.json',
        IPC_META_ENVELOPE
      );
      await electronAPI.settings.deleteBackup('C:/backup.json');
      expect(mockInvoke).toHaveBeenCalledWith(
        'settings:delete-backup',
        'C:/backup.json',
        IPC_META_ENVELOPE
      );
    });

    test('settings.update merges and persists', async () => {
      // First call (GET) returns current settings; second call (SAVE) returns merged.
      mockInvoke
        .mockResolvedValueOnce({ success: true, textModel: 'old.gguf' })
        .mockResolvedValueOnce({ success: true });
      const result = await electronAPI.settings.update('textModel', 'new.gguf');
      expect(result).toBeDefined();
      // Verify both GET and SAVE were invoked.
      const calls = mockInvoke.mock.calls.map((c) => c[0]);
      expect(calls).toContain('settings:get');
      expect(calls).toContain('settings:save');
    });

    test('settings.update rejects non-allowlisted keys', async () => {
      await expect(electronAPI.settings.update('notARealSetting', 'x')).rejects.toThrow(
        'not an allowlisted settings key'
      );
      // Nothing should reach the IPC layer for a rejected key.
      const calls = mockInvoke.mock.calls.map((c) => c[0]);
      expect(calls).not.toContain('settings:save');
    });

    test('settings.update rejects empty key', async () => {
      await expect(electronAPI.settings.update('', 'value')).rejects.toThrow(
        'non-empty string key'
      );
      await expect(electronAPI.settings.update('   ', 'value')).rejects.toThrow(
        'non-empty string key'
      );
    });
  });
});
