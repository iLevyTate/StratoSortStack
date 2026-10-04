/**
 * Tests for the BatchAnalysisService -> analyzeMediaFile adapter.
 *
 * The adapter bridges the dispatcher's `(filePath, smartFolders, { isCancelled })`
 * convention into analyzeMediaFile's `(filePath, deps, options)` convention,
 * and provides a graceful-skip fallback when Whisper is unavailable.
 */

jest.mock('electron', () => require('./mocks/electron'));

jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  };
  return {
    createLogger: () => logger,
    createSafeLogger: () => logger,
    logger,
    __mockLogger: logger
  };
});

// The adapter reads the "Describe video keyframes" toggle from settings when
// the constructor gives no explicit flag.
let mockSettings = {};
jest.mock('../src/main/services/SettingsService', () => ({
  getInstance: () => ({ getAll: () => mockSettings })
}));

const mockAnalyzeMediaFile = jest.fn();
jest.mock('../src/main/analysis/mediaAnalysis', () => ({
  ...jest.requireActual('../src/main/analysis/mediaAnalysis'),
  analyzeMediaFile: (...args) => mockAnalyzeMediaFile(...args)
}));

const {
  createMediaAnalyzerAdapter,
  buildSkipResult
} = require('../src/main/services/mediaAnalyzerAdapter');
const { ERROR_CODES } = require('../src/shared/errorCodes');

describe('mediaAnalyzerAdapter', () => {
  beforeEach(() => {
    mockSettings = {};
    mockAnalyzeMediaFile.mockReset();
  });

  describe('buildSkipResult', () => {
    test('produces audio skip-shape for .mp3', () => {
      const result = buildSkipResult('/tmp/song.mp3');
      expect(result.mediaKind).toBe('audio');
      expect(result.category).toBe('audio');
      expect(result.extractionMethod).toBe('media-skipped-no-whisper');
      expect(result._skipped).toBe(true);
      expect(result.transcript).toBe('');
      expect(result.keyframes).toEqual([]);
      expect(result.suggestedName).toBe('song');
      expect(result.purpose).toMatch(/Whisper model not installed/);
    });

    test('produces video skip-shape for .mp4', () => {
      const result = buildSkipResult('/tmp/clip.mp4');
      expect(result.mediaKind).toBe('video');
      expect(result.category).toBe('video');
    });

    test('uses audio fallback for unknown extensions', () => {
      const result = buildSkipResult('/tmp/strange.xyz');
      expect(result.mediaKind).toBe('audio');
    });
  });

  describe('createMediaAnalyzerAdapter', () => {
    test('returns skip-shape when whisperService is null', async () => {
      const adapter = createMediaAnalyzerAdapter({ whisperService: null });
      const result = await adapter('/tmp/a.mp3', [], {});
      expect(result._skipped).toBe(true);
      expect(result.extractionMethod).toBe('media-skipped-no-whisper');
      expect(mockAnalyzeMediaFile).not.toHaveBeenCalled();
    });

    test('returns skip-shape when whisperService lacks transcribeMedia', async () => {
      const adapter = createMediaAnalyzerAdapter({ whisperService: {} });
      const result = await adapter('/tmp/a.mp3', [], {});
      expect(result._skipped).toBe(true);
      expect(mockAnalyzeMediaFile).not.toHaveBeenCalled();
    });

    test('returns skip-shape when analyzeMediaFile throws LLAMA_MODEL_NOT_FOUND', async () => {
      const err = new Error('Whisper model not found at /tmp/model');
      err.code = ERROR_CODES.LLAMA_MODEL_NOT_FOUND;
      mockAnalyzeMediaFile.mockRejectedValue(err);

      const whisper = { transcribeMedia: jest.fn() };
      const adapter = createMediaAnalyzerAdapter({ whisperService: whisper });
      const result = await adapter('/tmp/a.mp3', [], {});
      expect(result._skipped).toBe(true);
      expect(result.mediaKind).toBe('audio');
      expect(mockAnalyzeMediaFile).toHaveBeenCalledTimes(1);
    });

    test('passes through normal analysis result on success', async () => {
      const happy = {
        category: 'video',
        keywords: ['demo'],
        confidence: 80,
        extractionMethod: 'whisper-transcription',
        mediaKind: 'video',
        transcript: 'hello world',
        transcriptSegments: [],
        durationSeconds: 12,
        detectedLanguage: 'en',
        keyframes: [],
        keyframeWorkspace: null,
        multimodalText: null
      };
      mockAnalyzeMediaFile.mockResolvedValue(happy);

      const whisper = { transcribeMedia: jest.fn() };
      const adapter = createMediaAnalyzerAdapter({ whisperService: whisper });
      const result = await adapter('/tmp/clip.mp4', ['Movies'], {});
      expect(result).toBe(happy);
      const [filePath, deps, opts] = mockAnalyzeMediaFile.mock.calls[0];
      expect(filePath).toBe('/tmp/clip.mp4');
      expect(deps.whisperService).toBe(whisper);
      expect(opts.smartFolders).toEqual(['Movies']);
      expect(opts.captionKeyframes).toBe(false);
    });

    test('reads the captionVideoKeyframes setting at call time when no flag is given (MI-04)', async () => {
      mockAnalyzeMediaFile.mockResolvedValue({});
      const whisper = { transcribeMedia: jest.fn() };
      const adapter = createMediaAnalyzerAdapter({ whisperService: whisper });

      mockSettings = { captionVideoKeyframes: true };
      await adapter('/tmp/clip.mp4', [], {});
      expect(mockAnalyzeMediaFile.mock.calls[0][2].captionKeyframes).toBe(true);

      mockSettings = { captionVideoKeyframes: false };
      await adapter('/tmp/clip.mp4', [], {});
      expect(mockAnalyzeMediaFile.mock.calls[1][2].captionKeyframes).toBe(false);
    });

    test('an explicit constructor flag wins over the setting', async () => {
      mockAnalyzeMediaFile.mockResolvedValue({});
      mockSettings = { captionVideoKeyframes: true };
      const adapter = createMediaAnalyzerAdapter({
        whisperService: { transcribeMedia: jest.fn() },
        captionKeyframes: false
      });
      await adapter('/tmp/clip.mp4', [], {});
      expect(mockAnalyzeMediaFile.mock.calls[0][2].captionKeyframes).toBe(false);
    });

    test('honors captionKeyframes:true when adapter constructed with that flag', async () => {
      mockAnalyzeMediaFile.mockResolvedValue({});
      const whisper = { transcribeMedia: jest.fn() };
      const adapter = createMediaAnalyzerAdapter({
        whisperService: whisper,
        captionKeyframes: true
      });
      await adapter('/tmp/clip.mp4', [], {});
      const opts = mockAnalyzeMediaFile.mock.calls[0][2];
      expect(opts.captionKeyframes).toBe(true);
    });

    test('propagates non-Whisper-missing errors unchanged', async () => {
      const err = new Error('disk full');
      err.code = 'ENOSPC';
      mockAnalyzeMediaFile.mockRejectedValue(err);

      const whisper = { transcribeMedia: jest.fn() };
      const adapter = createMediaAnalyzerAdapter({ whisperService: whisper });
      await expect(adapter('/tmp/a.mp3', [], {})).rejects.toMatchObject({ code: 'ENOSPC' });
    });

    test('treats /whisper.+model not found/ message as missing-model even without code', async () => {
      const err = new Error('Whisper Model Not Found at C:\\models\\ggml.bin');
      mockAnalyzeMediaFile.mockRejectedValue(err);

      const whisper = { transcribeMedia: jest.fn() };
      const adapter = createMediaAnalyzerAdapter({ whisperService: whisper });
      const result = await adapter('/tmp/a.mp3', [], {});
      expect(result._skipped).toBe(true);
    });

    test('plumbs bypassCache and smartFolderId from dispatcher options to analyzeMediaFile', async () => {
      // Regression guard: SmartFolderWatcher and DownloadWatcher both pass
      // `{ bypassCache, smartFolderId }` to the adapter (see
      // SmartFolderWatcher.js:1548-1551). An earlier version of this adapter
      // only destructured `isCancelled`, silently dropping the other fields
      // so user-forced re-analysis kept reusing cached transcripts and
      // per-folder AI provider overrides could not fire on media files.
      let receivedOpts;
      mockAnalyzeMediaFile.mockImplementation((_p, _d, opts) => {
        receivedOpts = opts;
        return Promise.resolve({});
      });

      const whisper = { transcribeMedia: jest.fn() };
      const adapter = createMediaAnalyzerAdapter({ whisperService: whisper });
      await adapter('/tmp/clip.mp4', ['Movies'], {
        isCancelled: () => false,
        bypassCache: true,
        smartFolderId: 'folder-42'
      });

      expect(receivedOpts.bypassCache).toBe(true);
      expect(receivedOpts.smartFolderId).toBe('folder-42');
      expect(receivedOpts.smartFolders).toEqual(['Movies']);
    });

    test('omits bypassCache and smartFolderId when caller did not supply them', async () => {
      let receivedOpts;
      mockAnalyzeMediaFile.mockImplementation((_p, _d, opts) => {
        receivedOpts = opts;
        return Promise.resolve({});
      });

      const whisper = { transcribeMedia: jest.fn() };
      const adapter = createMediaAnalyzerAdapter({ whisperService: whisper });
      await adapter('/tmp/clip.mp4', ['Movies'], {});

      expect(receivedOpts.bypassCache).toBeUndefined();
      expect(receivedOpts.smartFolderId).toBeUndefined();
    });

    test('isCancelled callback is bridged to an AbortSignal', async () => {
      let receivedSignal;
      let abortedDuringCall;
      mockAnalyzeMediaFile.mockImplementation((_p, _d, opts) => {
        receivedSignal = opts.signal;
        // Capture the signal state DURING the analyzer call. After the
        // adapter resolves it disposes the signal (aborts the controller
        // to clear the cancel-poll interval), so checking .aborted post-await
        // would always observe `true` — that's the intended cleanup.
        abortedDuringCall = opts.signal?.aborted;
        return Promise.resolve({});
      });

      const whisper = { transcribeMedia: jest.fn() };
      const adapter = createMediaAnalyzerAdapter({ whisperService: whisper });
      const isCancelled = jest.fn(() => false);
      await adapter('/tmp/a.mp3', [], { isCancelled });

      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      expect(abortedDuringCall).toBe(false);
      // After the adapter returns, dispose() has aborted the controller —
      // this is intentional cleanup of the polling interval.
      expect(receivedSignal.aborted).toBe(true);
    });

    test('when isCancelled is omitted, signal is undefined', async () => {
      let receivedSignal = 'unset';
      mockAnalyzeMediaFile.mockImplementation((_p, _d, opts) => {
        receivedSignal = opts.signal;
        return Promise.resolve({});
      });

      const whisper = { transcribeMedia: jest.fn() };
      const adapter = createMediaAnalyzerAdapter({ whisperService: whisper });
      await adapter('/tmp/a.mp3', [], {});
      expect(receivedSignal).toBeUndefined();
    });

    test('synchronous-already-cancelled state aborts the signal before any interval tick', async () => {
      // Pre-fix the adapter started a 200 ms polling interval and only
      // the FIRST tick checked the cancel flag. A caller that was
      // already cancelled by the time analyzeMediaFile started would
      // wait up to 200 ms before the abort fired, by which time ffmpeg
      // had often already spawned + completed. The synchronous check
      // covers the watcher-races-the-user case (the cancel flag flips
      // between dispatcher dispatch and analyzer entry) without an
      // extra tick of latency.
      let receivedSignal;
      mockAnalyzeMediaFile.mockImplementation((_p, _d, opts) => {
        receivedSignal = opts.signal;
        return Promise.resolve({});
      });
      const whisper = { transcribeMedia: jest.fn() };
      const adapter = createMediaAnalyzerAdapter({ whisperService: whisper });
      const isCancelled = jest.fn(() => true); // already cancelled
      await adapter('/tmp/a.mp3', [], { isCancelled });
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      // Aborted synchronously, NOT after a 200 ms delay.
      expect(receivedSignal.aborted).toBe(true);
      // The poll-interval check would have been at least one extra
      // call; the sync path uses exactly one.
      expect(isCancelled.mock.calls.length).toBe(1);
    });

    test('cancel-poll latency is at most ~50 ms (down from 200 ms)', async () => {
      // Verify that once the cancel flag flips AFTER analyzer entry,
      // the abort fires within the new poll window — not the old 200 ms
      // window. This is the watcher-already-spawned-ffmpeg case from
      // the audit: every 150 ms saved means another 0.5 GB of PCM
      // buffer not allocated needlessly.
      jest.useFakeTimers();
      try {
        let receivedSignal;
        mockAnalyzeMediaFile.mockImplementation((_p, _d, opts) => {
          receivedSignal = opts.signal;
          return new Promise((resolve) => setImmediate(resolve));
        });
        const whisper = { transcribeMedia: jest.fn() };
        const adapter = createMediaAnalyzerAdapter({ whisperService: whisper });
        let cancelled = false;
        const isCancelled = () => cancelled;

        const inflight = adapter('/tmp/a.mp3', [], { isCancelled });
        // Let the synchronous setup run before flipping the flag.
        await Promise.resolve();
        cancelled = true;
        // Advance 50 ms — the new poll interval. Old code would still
        // be at signal.aborted === false for another 150 ms.
        jest.advanceTimersByTime(50);
        expect(receivedSignal).toBeInstanceOf(AbortSignal);
        expect(receivedSignal.aborted).toBe(true);
        jest.advanceTimersByTime(50);
        await inflight;
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
