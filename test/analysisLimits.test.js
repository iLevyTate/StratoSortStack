/**
 * @jest-environment node
 *
 * Analysis limits - file size limits from settings
 */

const { DEFAULT_SETTINGS } = require('../src/shared/defaultSettings');

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock('../src/main/services/SettingsService', () => ({
  getInstance: jest.fn()
}));

const SettingsService = require('../src/main/services/SettingsService');
const {
  getAnalysisLimits,
  getDefaultLimits,
  invalidateCache
} = require('../src/main/analysis/analysisLimits');

describe('analysisLimits', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invalidateCache();
  });

  describe('getDefaultLimits', () => {
    test('returns defaults when SettingsService unavailable', () => {
      SettingsService.getInstance.mockReturnValue(null);
      return getAnalysisLimits().then((limits) => {
        expect(limits).toEqual({
          maxImageFileSize: DEFAULT_SETTINGS.maxImageFileSize,
          maxDocumentFileSize: DEFAULT_SETTINGS.maxDocumentFileSize,
          maxTextFileSize: DEFAULT_SETTINGS.maxTextFileSize
        });
      });
    });
  });

  describe('getAnalysisLimits', () => {
    test('loads limits from SettingsService', async () => {
      SettingsService.getInstance.mockReturnValue({
        load: jest.fn().mockResolvedValue({
          maxImageFileSize: 80 * 1024 * 1024,
          maxDocumentFileSize: 150 * 1024 * 1024
        })
      });

      const limits = await getAnalysisLimits();
      expect(limits.maxImageFileSize).toBe(80 * 1024 * 1024);
      expect(limits.maxDocumentFileSize).toBe(150 * 1024 * 1024);
    });

    test('uses defaults when SettingsService.load fails', async () => {
      SettingsService.getInstance.mockReturnValue({
        load: jest.fn().mockRejectedValue(new Error('load failed'))
      });

      const limits = await getAnalysisLimits();
      expect(limits.maxImageFileSize).toBe(DEFAULT_SETTINGS.maxImageFileSize);
      expect(limits.maxDocumentFileSize).toBe(DEFAULT_SETTINGS.maxDocumentFileSize);
    });

    test('caches results within TTL', async () => {
      const loadMock = jest.fn().mockResolvedValue({
        maxImageFileSize: 90 * 1024 * 1024,
        maxDocumentFileSize: 180 * 1024 * 1024
      });
      SettingsService.getInstance.mockReturnValue({ load: loadMock });

      await getAnalysisLimits();
      await getAnalysisLimits();
      expect(loadMock).toHaveBeenCalledTimes(1);
    });

    test('invalidates cache when invalidateCache called', async () => {
      const loadMock = jest.fn().mockResolvedValue({
        maxImageFileSize: 90 * 1024 * 1024,
        maxDocumentFileSize: 180 * 1024 * 1024
      });
      SettingsService.getInstance.mockReturnValue({ load: loadMock });

      await getAnalysisLimits();
      invalidateCache();
      await getAnalysisLimits();
      expect(loadMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('invalidateCache', () => {
    test('clears cached limits', async () => {
      SettingsService.getInstance.mockReturnValue({
        load: jest
          .fn()
          .mockResolvedValueOnce({
            maxImageFileSize: 50 * 1024 * 1024,
            maxDocumentFileSize: 200 * 1024 * 1024
          })
          .mockResolvedValueOnce({
            maxImageFileSize: 70 * 1024 * 1024,
            maxDocumentFileSize: 200 * 1024 * 1024
          })
      });

      const first = await getAnalysisLimits();
      expect(first.maxImageFileSize).toBe(50 * 1024 * 1024);

      invalidateCache();
      const second = await getAnalysisLimits();
      expect(second.maxImageFileSize).toBe(70 * 1024 * 1024);
    });
  });
});
