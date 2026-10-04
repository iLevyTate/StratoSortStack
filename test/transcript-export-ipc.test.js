jest.mock('electron', () => jest.requireActual('./mocks/electron'));

const { ipcMain, dialog } = require('electron');

describe('AnalysisHistory transcript export IPC', () => {
  beforeEach(() => {
    ipcMain._handlers.clear();
    ipcMain.handle.mockClear();
    dialog.showSaveDialog.mockClear();
    jest.resetModules();
  });

  function register(serviceOverrides = {}) {
    const registerAnalysisHistoryIpc = require('../src/main/ipc/analysisHistory');
    const { IPC_CHANNELS } = require('../src/shared/constants');
    const logger = { error: jest.fn(), info: jest.fn(), warn: jest.fn() };
    const service = {
      getStatistics: jest.fn(async () => ({ total: 0 })),
      searchAnalysis: jest.fn(async () => []),
      getAnalysisByPath: jest.fn(async () => null),
      getRecentAnalysis: jest.fn(async () => []),
      clear: jest.fn(async () => ({})),
      createDefaultStructures: jest.fn(async () => ({})),
      ...serviceOverrides
    };
    registerAnalysisHistoryIpc({
      ipcMain,
      IPC_CHANNELS,
      logger,
      getServiceIntegration: () => ({ analysisHistory: service })
    });
    return { IPC_CHANNELS, service };
  }

  test('returns an error (without opening a dialog) when no segments exist', async () => {
    const { IPC_CHANNELS } = register();
    const handler = ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.EXPORT_TRANSCRIPT);
    const result = await handler(null, { filePath: 'C:/media/talk.mp4', format: 'vtt' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no timestamped transcript/i);
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
  });

  test('returns canceled when the user dismisses the save dialog', async () => {
    const entry = {
      analysis: {
        transcript: 'Hello world',
        transcriptSegments: [{ start: 0, end: 2, text: 'Hello world' }]
      }
    };
    const { IPC_CHANNELS } = register({ getAnalysisByPath: jest.fn(async () => entry) });
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: '' });
    const handler = ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.EXPORT_TRANSCRIPT);
    const result = await handler(null, { filePath: 'C:/media/talk.mp4', format: 'vtt' });
    expect(result).toMatchObject({ success: false, canceled: true });
  });

  test('writes a WEBVTT file to the chosen path on success', async () => {
    const entry = {
      analysis: {
        transcript: 'Hello world',
        transcriptSegments: [{ start: 0, end: 2, text: 'Hello world' }],
        detectedLanguage: 'en',
        durationSeconds: 2
      }
    };
    const { IPC_CHANNELS } = register({ getAnalysisByPath: jest.fn(async () => entry) });
    const fs = require('fs');
    const writeSpy = jest.spyOn(fs.promises, 'writeFile').mockResolvedValueOnce(undefined);
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: 'C:/out/talk.vtt' });

    const handler = ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.EXPORT_TRANSCRIPT);
    const result = await handler(null, { filePath: 'C:/media/talk.mp4', format: 'vtt' });

    expect(result).toMatchObject({ success: true, filePath: 'C:/out/talk.vtt' });
    expect(writeSpy).toHaveBeenCalledWith(
      'C:/out/talk.vtt',
      expect.stringMatching(/^WEBVTT\n\n1\n00:00:00\.000 --> 00:00:02\.000\nHello world/),
      'utf8'
    );
    expect(dialog.showSaveDialog).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ defaultPath: 'talk.vtt' })
    );
    writeSpy.mockRestore();
  });

  test('exports JSON when text exists even without segments', async () => {
    const entry = {
      analysis: {
        transcript: 'Hello world',
        transcriptSegments: [],
        detectedLanguage: 'en',
        durationSeconds: 2
      }
    };
    const { IPC_CHANNELS } = register({ getAnalysisByPath: jest.fn(async () => entry) });
    const fs = require('fs');
    const writeSpy = jest.spyOn(fs.promises, 'writeFile').mockResolvedValueOnce(undefined);
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: 'C:/out/talk.json' });

    const handler = ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.EXPORT_TRANSCRIPT);
    const result = await handler(null, { filePath: 'C:/media/talk.mp4', format: 'json' });

    expect(result).toMatchObject({ success: true, filePath: 'C:/out/talk.json' });
    const written = JSON.parse(writeSpy.mock.calls[0][1]);
    expect(written).toMatchObject({
      // Basename only [F-177]: the export is a shareable artifact — a
      // privacy-first product must not embed the machine's directory layout.
      sourceFile: 'talk.mp4',
      language: 'en',
      durationSeconds: 2,
      text: 'Hello world',
      segments: []
    });
    writeSpy.mockRestore();
  });

  test('flags the history segment-cap truncation in the export envelope [F-177]', async () => {
    // History persists at most 1000 segments; without the flag a VTT that
    // silently ended mid-media was indistinguishable from a complete one.
    const entry = {
      analysis: {
        transcript: 'long recording',
        transcriptSegments: Array.from({ length: 1000 }, (_, i) => ({
          start: i,
          end: i + 1,
          text: `cue ${i}`
        })),
        transcriptSegmentsTruncated: true
      }
    };
    const { IPC_CHANNELS } = register({ getAnalysisByPath: jest.fn(async () => entry) });
    const fs = require('fs');
    const writeSpy = jest.spyOn(fs.promises, 'writeFile').mockResolvedValueOnce(undefined);
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: 'C:/out/long.vtt' });

    const handler = ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.EXPORT_TRANSCRIPT);
    const result = await handler(null, { filePath: 'C:/media/long.mp4', format: 'vtt' });

    expect(result).toMatchObject({ success: true, truncated: true, segmentCount: 1000 });
    writeSpy.mockRestore();
  });

  test('short transcripts export without a truncated flag [F-177]', async () => {
    const entry = {
      analysis: {
        transcript: 'Hello world',
        transcriptSegments: [{ start: 0, end: 2, text: 'Hello world' }]
      }
    };
    const { IPC_CHANNELS } = register({ getAnalysisByPath: jest.fn(async () => entry) });
    const fs = require('fs');
    const writeSpy = jest.spyOn(fs.promises, 'writeFile').mockResolvedValueOnce(undefined);
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: 'C:/out/short.vtt' });

    const handler = ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.EXPORT_TRANSCRIPT);
    const result = await handler(null, { filePath: 'C:/media/short.mp4', format: 'vtt' });

    expect(result).toMatchObject({ success: true, segmentCount: 1 });
    expect(result.truncated).toBeUndefined();
    writeSpy.mockRestore();
  });

  test('writes SRT with comma milliseconds on success', async () => {
    const entry = {
      analysis: {
        transcript: 'Hello world',
        transcriptSegments: [{ start: 0, end: 2, text: 'Hello world' }]
      }
    };
    const { IPC_CHANNELS } = register({ getAnalysisByPath: jest.fn(async () => entry) });
    const fs = require('fs');
    const writeSpy = jest.spyOn(fs.promises, 'writeFile').mockResolvedValueOnce(undefined);
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: 'C:/out/talk.srt' });

    const handler = ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.EXPORT_TRANSCRIPT);
    const result = await handler(null, { filePath: 'C:/media/talk.mp4', format: 'srt' });

    expect(result).toMatchObject({ success: true, filePath: 'C:/out/talk.srt' });
    expect(writeSpy).toHaveBeenCalledWith(
      'C:/out/talk.srt',
      expect.stringMatching(/^1\n00:00:00,000 --> 00:00:02,000\nHello world\n\n$/),
      'utf8'
    );
    writeSpy.mockRestore();
  });
});
