/**
 * Tests for src/main/analysis/mediaAnalysis.js — the audio/video orchestrator.
 *
 * All external services are injected via the dependencies object so we can
 * exercise routing, fallback, and result shape without spinning up whisper,
 * ffmpeg, or the LLM.
 */

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/mock/userData') }
}));

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

const {
  analyzeMediaFile,
  classifyMediaFile,
  inferMediaKind,
  formatSegmentsForLlm,
  formatTimestamp,
  captionKeyframes,
  mergeTranscriptAndCaptions,
  pickEvenlySpaced,
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS
} = require('../src/main/analysis/mediaAnalysis');
const { ERROR_CODES } = require('../src/shared/errorCodes');

describe('classifyMediaFile', () => {
  test.each([
    ['song.mp3', 'audio'],
    ['lecture.M4A', 'audio'],
    ['audiobook.m4b', 'audio'],
    ['call.opus', 'audio'],
    ['interview.aif', 'audio'],
    ['movie.mp4', 'video'],
    ['talk.MKV', 'video'],
    // Camcorder / mobile / broadcast formats — previously fileTypeUtils
    // recognized them as media but classifyMediaFile rejected them, so
    // the file would route through document analysis and fail.
    ['vacation.3gp', 'video'],
    ['camcorder.mts', 'video'],
    ['avchd.m2ts', 'video'],
    // `.ts` deliberately excluded: collides with TypeScript source files
    // (verify-analysis-routing enforces `.ts` -> documents). See
    // mediaAnalysis.js VIDEO_EXTENSIONS comment.
    ['app.ts', null],
    ['notes.pdf', null],
    ['photo.jpg', null],
    ['', null]
  ])('classifies %s as %s', (input, expected) => {
    expect(classifyMediaFile(input)).toBe(expected);
  });

  test('extension sets cover the common formats and the audit gaps', () => {
    expect(AUDIO_EXTENSIONS.has('.mp3')).toBe(true);
    expect(AUDIO_EXTENSIONS.has('.flac')).toBe(true);
    expect(AUDIO_EXTENSIONS.has('.m4b')).toBe(true);
    expect(VIDEO_EXTENSIONS.has('.mp4')).toBe(true);
    expect(VIDEO_EXTENSIONS.has('.mkv')).toBe(true);
    expect(VIDEO_EXTENSIONS.has('.3gp')).toBe(true);
    expect(VIDEO_EXTENSIONS.has('.mts')).toBe(true);
    // `.ts` MUST stay out of VIDEO_EXTENSIONS — see comment in
    // mediaAnalysis.js; this is a regression guard.
    expect(VIDEO_EXTENSIONS.has('.ts')).toBe(false);
  });
});

describe('inferMediaKind', () => {
  test('returns the explicit mediaKind when present (v3.1.1+ pipeline)', () => {
    expect(inferMediaKind({ mediaKind: 'audio', mimeType: 'foo/bar' })).toBe('audio');
    expect(inferMediaKind({ mediaKind: 'video' })).toBe('video');
  });

  test('falls back to mime-type prefix on legacy entries (no explicit field)', () => {
    expect(inferMediaKind({ mimeType: 'audio/mpeg' })).toBe('audio');
    expect(inferMediaKind({ mimeType: 'video/quicktime' })).toBe('video');
    expect(inferMediaKind({ mimeType: 'audio/ogg' })).toBe('audio');
  });

  test('falls back to extension when neither mediaKind nor mime type is helpful', () => {
    expect(inferMediaKind({ filePath: 'episode.mp3' })).toBe('audio');
    expect(inferMediaKind({ filePath: 'lecture.mkv' })).toBe('video');
    expect(inferMediaKind({ mimeType: 'application/octet-stream', filePath: 'a.m4a' })).toBe(
      'audio'
    );
  });

  test('returns null for non-media inputs across every signal path', () => {
    expect(inferMediaKind({})).toBeNull();
    expect(inferMediaKind({ mimeType: 'application/pdf' })).toBeNull();
    expect(inferMediaKind({ filePath: 'notes.pdf' })).toBeNull();
    expect(inferMediaKind({ mediaKind: 'something-else' })).toBeNull();
  });
});

describe('formatTimestamp / formatSegmentsForLlm', () => {
  test('formatTimestamp pads minutes and seconds', () => {
    expect(formatTimestamp(0)).toBe('00:00');
    expect(formatTimestamp(7.5)).toBe('00:07');
    expect(formatTimestamp(125)).toBe('02:05');
  });

  test('formatSegmentsForLlm emits [start → end] text per segment', () => {
    const out = formatSegmentsForLlm([
      { start: 0, end: 1.5, text: 'hello' },
      { start: 1.5, end: 3.0, text: ' world ' }
    ]);
    expect(out).toBe('[00:00 → 00:01] hello\n[00:01 → 00:03] world');
  });

  test('formatSegmentsForLlm handles missing data', () => {
    expect(formatSegmentsForLlm([])).toBe('');
    expect(formatSegmentsForLlm(null)).toBe('');
    expect(formatSegmentsForLlm([{ start: NaN, end: NaN, text: '' }])).toBe('');
  });
});

function fakeWhisper(transcript) {
  return {
    transcribeMedia: jest.fn(async () => transcript)
  };
}

describe('analyzeMediaFile — routing', () => {
  test('rejects unsupported extensions with INVALID_FILE_TYPE', async () => {
    await expect(
      analyzeMediaFile('/mock/notes.pdf', { whisperService: fakeWhisper({}) })
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_FILE_TYPE });
  });

  test('rejects empty path with INVALID_INPUT', async () => {
    await expect(analyzeMediaFile('', { whisperService: fakeWhisper({}) })).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT
    });
  });

  test('rejects when whisperService is missing', async () => {
    await expect(analyzeMediaFile('/mock/song.mp3', {})).rejects.toMatchObject({
      code: ERROR_CODES.SERVICE_UNAVAILABLE
    });
  });

  test('rejects with OPERATION_CANCELLED when signal is already aborted before entry', async () => {
    // Regression guard: prior to this fix, a pre-aborted signal still paid
    // the cost of opening transcribe streams, creating keyframe workspaces,
    // and starting vision-LLM captioning before the inner cancellation
    // checks fired. Mirror the existing aborted-before-start check in
    // MediaTranscoder.transcodeToWhisperPcm so the cancellation contract
    // is consistent across the media pipeline.
    const controller = new AbortController();
    controller.abort();
    const whisper = {
      transcribeMedia: jest.fn(() => {
        throw new Error('whisper should NOT be called for pre-aborted requests');
      })
    };

    await expect(
      analyzeMediaFile('/mock/song.mp3', { whisperService: whisper }, { signal: controller.signal })
    ).rejects.toMatchObject({ code: ERROR_CODES.OPERATION_CANCELLED });

    // The whisper service must not be called — the early-return check
    // happens BEFORE any setup work.
    expect(whisper.transcribeMedia).not.toHaveBeenCalled();
  });
});

describe('analyzeMediaFile — option propagation (regression: 3.1.1 silent-drop)', () => {
  // Regression guard for the 3.1.1 audit: PR #189 plumbed bypassCache and
  // smartFolderId through mediaAnalyzerAdapter, but analyzeMediaFile
  // destructured neither, so:
  //   - WhisperService kept reusing cached transcripts on user-forced refresh,
  //   - per-folder AI provider routing never fired on media files,
  //   - and analyzeTextWithLlama was being called with a malformed positional
  //     signature (an object literal in the smartFolders slot), so smart
  //     folders never reached the prompt builder either.
  test('forwards bypassCache=true to WhisperService as useCache=false', async () => {
    const transcribeMedia = jest.fn(async () => ({
      text: 'hi',
      segments: [{ start: 0, end: 1, text: 'hi' }],
      language: 'en',
      durationSeconds: 1.0
    }));
    const whisperService = { transcribeMedia };
    await analyzeMediaFile(
      '/mock/song.mp3',
      { whisperService, analyzeTextWithLlama: jest.fn(async () => ({})) },
      { bypassCache: true }
    );
    expect(transcribeMedia).toHaveBeenCalledWith(
      '/mock/song.mp3',
      expect.objectContaining({ useCache: false })
    );
  });

  test('default bypassCache=false leaves Whisper cache enabled', async () => {
    const transcribeMedia = jest.fn(async () => ({
      text: 'hi',
      segments: [{ start: 0, end: 1, text: 'hi' }],
      language: 'en',
      durationSeconds: 1.0
    }));
    await analyzeMediaFile(
      '/mock/song.mp3',
      { whisperService: { transcribeMedia }, analyzeTextWithLlama: jest.fn(async () => ({})) },
      {}
    );
    expect(transcribeMedia).toHaveBeenCalledWith(
      '/mock/song.mp3',
      expect.objectContaining({ useCache: true })
    );
  });

  test('forwards smartFolderId through to analyzeTextWithLlama options (positional signature)', async () => {
    const analyzeTextWithLlama = jest.fn(async () => ({ category: 'meeting' }));
    const transcript = {
      text: 'hello',
      segments: [{ start: 0, end: 1, text: 'hello' }],
      language: 'en',
      durationSeconds: 1.0
    };
    await analyzeMediaFile(
      '/mock/standup.mp3',
      {
        whisperService: { transcribeMedia: jest.fn(async () => transcript) },
        analyzeTextWithLlama
      },
      {
        smartFolders: [{ name: 'Meetings', description: 'standups' }],
        smartFolderId: 'sf-abc',
        bypassCache: true
      }
    );
    // analyzeTextWithLlama signature is positional:
    //   (textContent, originalFileName, smartFolders, fileDate, namingContext, options)
    const callArgs = analyzeTextWithLlama.mock.calls[0];
    // [0] textContent — the formatted transcript
    expect(callArgs[0]).toContain('[00:00 → 00:01] hello');
    // [1] originalFileName — was `undefined` pre-fix, now the file basename
    expect(callArgs[1]).toBe('standup.mp3');
    // [2] smartFolders — must be the array, not an object literal wrapping it
    expect(Array.isArray(callArgs[2])).toBe(true);
    expect(callArgs[2][0]).toEqual({ name: 'Meetings', description: 'standups' });
    // [5] options — must carry bypassCache + smartFolderId so the analysis
    // cache and per-folder provider routing both fire.
    expect(callArgs[5]).toEqual(
      expect.objectContaining({
        bypassCache: true,
        smartFolderId: 'sf-abc',
        fileType: 'audio'
      })
    );
  });
});

describe('analyzeMediaFile — audio path', () => {
  test('runs whisper, calls LLM with formatted transcript, returns normalized result', async () => {
    const whisperService = fakeWhisper({
      text: 'hello world',
      segments: [
        { start: 0, end: 1, text: 'hello' },
        { start: 1, end: 2, text: 'world' }
      ],
      language: 'en',
      durationSeconds: 2.0
    });
    const analyzeTextWithLlama = jest.fn(async (text) => ({
      category: 'meeting',
      keywords: ['standup', 'engineering'],
      confidence: 85,
      purpose: 'Daily standup notes',
      _seenText: text
    }));

    const result = await analyzeMediaFile(
      '/mock/standup.mp3',
      { whisperService, analyzeTextWithLlama },
      { smartFolders: [{ name: 'Meetings' }] }
    );

    // Default language is 'auto' (whisper language detection); WhisperService
    // downgrades it to 'en' itself when the loaded model is English-only.
    expect(whisperService.transcribeMedia).toHaveBeenCalledWith(
      '/mock/standup.mp3',
      expect.objectContaining({ language: 'auto' })
    );
    // LLM should have received the timestamped formatted transcript, not the raw text
    expect(analyzeTextWithLlama.mock.calls[0][0]).toContain('[00:00 → 00:01] hello');
    expect(result.mediaKind).toBe('audio');
    expect(result.category).toBe('meeting');
    expect(result.keywords).toEqual(['standup', 'engineering']);
    expect(result.transcript).toBe('hello world');
    expect(result.transcriptSegments).toHaveLength(2);
    expect(result.durationSeconds).toBe(2.0);
    expect(result.detectedLanguage).toBe('en');
    expect(result.keyframes).toEqual([]);
    expect(result.extractionMethod).toBe('whisper-transcription');
    // Regression: the result must populate `extractedText` with the same
    // searchable blob the LLM saw (transcript-only here, no captions). The
    // semantic chunk-rebuild flow (semantic.js:1194) and SearchService
    // BM25 weights both key on this field; without it media transcripts
    // are silently absent from the search index even though they're in
    // history. extractedText should equal transcriptForLlm.
    expect(result.extractedText).toBe(analyzeTextWithLlama.mock.calls[0][0]);
    expect(result.extractedText).toContain('[00:00 → 00:01] hello');
  });

  test('extractedText falls back to raw transcript when segment formatting yields empty (no segments)', async () => {
    // Defensive: an audio file with raw text but no timestamped segments
    // (some Whisper builds return text without segments) should still
    // produce a non-empty extractedText so search isn't silently broken
    // for that subset.
    const whisperService = fakeWhisper({
      text: 'hello world',
      segments: [],
      language: 'en',
      durationSeconds: 2
    });
    const analyzeTextWithLlama = jest.fn(async () => ({
      category: 'meeting',
      keywords: ['x'],
      confidence: 80
    }));
    const result = await analyzeMediaFile(
      '/mock/no-segments.mp3',
      { whisperService, analyzeTextWithLlama },
      { smartFolders: [] }
    );
    expect(result.extractedText).toBe('hello world');
  });

  test('produces a low-confidence fallback when there is no transcript', async () => {
    const whisperService = fakeWhisper({
      text: '',
      segments: [],
      language: null,
      durationSeconds: 12.0
    });
    const analyzeTextWithLlama = jest.fn();

    const result = await analyzeMediaFile('/mock/silence.wav', {
      whisperService,
      analyzeTextWithLlama
    });
    expect(analyzeTextWithLlama).not.toHaveBeenCalled();
    expect(result.category).toBe('audio');
    expect(result.confidence).toBe(30);
    expect(result.keywords).toContain('no-transcript');
  });

  test('LLM failure is non-fatal — falls back to base category', async () => {
    const whisperService = fakeWhisper({
      text: 'this is a test',
      segments: [{ start: 0, end: 1, text: 'this is a test' }],
      language: 'en',
      durationSeconds: 1.0
    });
    const analyzeTextWithLlama = jest.fn(async () => {
      throw new Error('LLM unavailable');
    });

    const result = await analyzeMediaFile('/mock/song.mp3', {
      whisperService,
      analyzeTextWithLlama
    });
    expect(result.category).toBe('audio');
    expect(result.confidence).toBe(60);
  });
});

describe('analyzeMediaFile — video path', () => {
  test('extracts keyframes alongside transcript when captioning is on', async () => {
    const whisperService = fakeWhisper({
      text: 'speech',
      segments: [{ start: 0, end: 1, text: 'speech' }],
      language: 'en',
      durationSeconds: 5.0
    });
    const analyzeTextWithLlama = jest.fn(async () => ({
      category: 'tutorial',
      keywords: ['demo']
    }));
    const extractKeyframes = jest.fn(async () => [
      { timestamp: 1.0, framePath: '/tmp/frame-0001.jpg' },
      { timestamp: 4.5, framePath: '/tmp/frame-0002.jpg' }
    ]);
    const captionImage = jest.fn(async () => 'a slide');

    const result = await analyzeMediaFile(
      '/mock/video.mp4',
      { whisperService, analyzeTextWithLlama, extractKeyframes, captionImage },
      { maxKeyframes: 5, captionKeyframes: true }
    );
    expect(extractKeyframes).toHaveBeenCalledTimes(1);
    expect(extractKeyframes.mock.calls[0][2]).toEqual(expect.objectContaining({ maxFrames: 5 }));
    expect(result.mediaKind).toBe('video');
    expect(result.keyframes).toHaveLength(2);
    expect(result.keyframes[0].timestamp).toBe(1.0);
    expect(result.keyframes[0].caption).toBe('a slide');
    // keyframeWorkspace is always cleaned up eagerly on success; the
    // workspace path is no longer surfaced to callers (see mediaAnalysis.js
    // lines 489-497 for rationale).
    expect(result.keyframeWorkspace).toBeNull();
  });

  test('captioning off (the default): no keyframes are extracted and none are claimed (MI-04)', async () => {
    const whisperService = fakeWhisper({
      text: 'speech',
      segments: [{ start: 0, end: 1, text: 'speech' }],
      language: 'en',
      durationSeconds: 5.0
    });
    const extractKeyframes = jest.fn(async () => [{ timestamp: 1.0, framePath: '/tmp/f.jpg' }]);

    const result = await analyzeMediaFile(
      '/mock/video.mp4',
      { whisperService, analyzeTextWithLlama: jest.fn(async () => ({})), extractKeyframes },
      { maxKeyframes: 5 }
    );

    expect(extractKeyframes).not.toHaveBeenCalled();
    expect(result.keyframes).toEqual([]);
    expect(result.extractionMethod).toBe('whisper-transcription');
    expect(result.multimodalText).toBeNull();
  });

  test('a video with no speech is recorded as no-speech, not as a transcription (MI-04)', async () => {
    const whisperService = fakeWhisper({
      text: '',
      segments: [],
      language: null,
      durationSeconds: 12
    });
    const analyzeTextWithLlama = jest.fn();

    const result = await analyzeMediaFile('/mock/silent-screen-recording.mp4', {
      whisperService,
      analyzeTextWithLlama,
      extractKeyframes: jest.fn()
    });

    expect(analyzeTextWithLlama).not.toHaveBeenCalled();
    expect(result.extractionMethod).toBe('no-speech');
    expect(result.confidence).toBe(30);
    expect(result.keywords).toEqual(expect.arrayContaining(['video', 'no-transcript']));
  });

  test('keyframe failure does not break the run', async () => {
    const whisperService = fakeWhisper({
      text: 'speech',
      segments: [{ start: 0, end: 1, text: 'speech' }],
      language: 'en',
      durationSeconds: 5.0
    });
    const analyzeTextWithLlama = jest.fn(async () => ({ category: 'tutorial' }));
    const extractKeyframes = jest.fn(async () => {
      throw new Error('codec missing');
    });

    const result = await analyzeMediaFile('/mock/video.mp4', {
      whisperService,
      analyzeTextWithLlama,
      extractKeyframes
    });
    expect(result.mediaKind).toBe('video');
    expect(result.keyframes).toEqual([]);
    expect(result.keyframeWorkspace).toBeNull();
    expect(result.transcript).toBe('speech');
  });

  test('structured logs use file basename, not the full filesystem path', async () => {
    // Privacy posture: support bundles and crash dumps must not include
    // user folder layouts. The whole project is "logs stay on-device,
    // no remote upload" but anything that DOES leave the box (manual
    // file share, support escalation) shouldn't leak personal paths.
    const { __mockLogger } = require('../src/shared/logger');
    __mockLogger.warn.mockClear();

    const whisperService = fakeWhisper({
      text: 'speech',
      segments: [{ start: 0, end: 1, text: 'speech' }],
      language: 'en',
      durationSeconds: 5.0
    });
    const extractKeyframes = jest.fn(async () => {
      throw new Error('codec missing');
    });

    // Captioning on so the extractor runs (and fails) at all; the caption fn
    // is null, which skips captioning without changing the logging under test.
    await analyzeMediaFile(
      '/Users/jane/Documents/Confidential Project/clip with secret name.mp4',
      {
        whisperService,
        analyzeTextWithLlama: jest.fn(async () => ({})),
        extractKeyframes,
        captionImage: null
      },
      { captionKeyframes: true }
    );

    const allWarnPayloads = __mockLogger.warn.mock.calls.map((call) => call[1]).filter(Boolean);
    // No payload should carry the full user-filesystem path.
    for (const payload of allWarnPayloads) {
      expect(payload.filePath).toBeUndefined();
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toMatch(/\/Users\/jane\/Documents/);
      expect(serialized).not.toMatch(/Confidential Project/);
    }
    // The basename IS surfaced via a `file` field for log readability.
    const keyframeFailureLog = allWarnPayloads.find(
      (p) => typeof p.file === 'string' && p.file.includes('clip with secret name.mp4')
    );
    expect(keyframeFailureLog).toBeDefined();
  });

  test('extractVideoKeyframes:false skips keyframe extraction entirely', async () => {
    const whisperService = fakeWhisper({
      text: 'speech',
      segments: [{ start: 0, end: 1, text: 'speech' }],
      language: 'en',
      durationSeconds: 5.0
    });
    const extractKeyframes = jest.fn();
    const result = await analyzeMediaFile(
      '/mock/video.mp4',
      { whisperService, analyzeTextWithLlama: jest.fn(async () => ({})), extractKeyframes },
      { extractVideoKeyframes: false }
    );
    expect(extractKeyframes).not.toHaveBeenCalled();
    expect(result.keyframes).toEqual([]);
  });

  test('full multimodal video flow: transcript + keyframes + captions interleave correctly', async () => {
    // End-to-end coverage of the v3.1.1 video path. Asserts that:
    //   1. analyzeMediaFile invokes Whisper, the keyframe extractor, AND the
    //      vision caption fn (one call per downsampled keyframe).
    //   2. The text seen by the LLM is the multimodal merge — speech and
    //      visual lines interleaved in chronological order with the
    //      `Speech:` / `Visual:` prefixes the prompt builder needs.
    //   3. `extractedText` (search-pipeline alias added in 3.1.1 audit) is
    //      the same multimodal blob the LLM saw, so chunk-rebuild indexes
    //      both spoken and visual content.
    //   4. `transcript` (raw spoken text) is preserved separately for the
    //      AnalysisDetails UI.
    //   5. `keyframes` returned to the caller include captions paired by
    //      framePath so the renderer can show frame thumbnails + captions.
    //   6. `multimodalText` is non-null when at least one caption was
    //      produced (it's nullable when captioning is off).
    //   7. `extractionMethod` reflects the multimodal pass.
    const whisperService = fakeWhisper({
      text: 'introduction body conclusion',
      segments: [
        { start: 0, end: 5, text: 'introduction' },
        { start: 5, end: 30, text: 'body' },
        { start: 30, end: 45, text: 'conclusion' }
      ],
      language: 'en',
      durationSeconds: 45
    });
    let seenLlmText = null;
    const analyzeTextWithLlama = jest.fn(async (text) => {
      seenLlmText = text;
      return {
        category: 'product-demo',
        keywords: ['onboarding', 'tutorial'],
        confidence: 90,
        purpose: 'How-to walkthrough'
      };
    });
    const extractKeyframes = jest.fn(async () => [
      { timestamp: 2.0, framePath: '/tmp/kf-1.jpg' },
      { timestamp: 17.5, framePath: '/tmp/kf-2.jpg' },
      { timestamp: 32.0, framePath: '/tmp/kf-3.jpg' }
    ]);
    const captionImage = jest.fn(async (framePath) => {
      // Return a caption keyed off the path so we can assert the right
      // caption attached to the right timestamp post-merge.
      const idx = framePath.match(/kf-(\d)/)?.[1];
      return `slide ${idx}`;
    });

    const result = await analyzeMediaFile(
      '/mock/walkthrough.mp4',
      { whisperService, analyzeTextWithLlama, extractKeyframes, captionImage },
      {
        captionKeyframes: true,
        maxKeyframes: 12,
        maxCaptionedKeyframes: 6,
        captionConcurrency: 2,
        smartFolders: [{ name: 'Tutorials' }]
      }
    );

    // 1. All three subsystems wired
    expect(extractKeyframes).toHaveBeenCalledTimes(1);
    expect(captionImage).toHaveBeenCalledTimes(3);

    // 2. LLM saw the merged multimodal blob in chronological order
    expect(seenLlmText).toMatch(/\[00:00 → 00:05\] Speech: introduction/);
    expect(seenLlmText).toMatch(/\[00:02\] Visual: slide 1/);
    expect(seenLlmText).toMatch(/\[00:05 → 00:30\] Speech: body/);
    expect(seenLlmText).toMatch(/\[00:17\] Visual: slide 2/);
    expect(seenLlmText).toMatch(/\[00:30 → 00:45\] Speech: conclusion/);
    expect(seenLlmText).toMatch(/\[00:32\] Visual: slide 3/);
    // Speech-before-visual at co-located timestamps is enforced via the
    // sort comparator; the introduction segment (0-5) must appear before
    // the slide-1 visual at 2.0 in source order — confirm by indexOf.
    const intro = seenLlmText.indexOf('Speech: introduction');
    const slide1 = seenLlmText.indexOf('Visual: slide 1');
    const body = seenLlmText.indexOf('Speech: body');
    const slide2 = seenLlmText.indexOf('Visual: slide 2');
    expect(intro).toBeGreaterThanOrEqual(0);
    expect(intro).toBeLessThan(slide1);
    expect(slide1).toBeLessThan(body);
    expect(body).toBeLessThan(slide2);

    // 3. extractedText is the same blob the LLM saw — so semantic.js's
    //    chunk-rebuild flow indexes spoken AND visual content.
    expect(result.extractedText).toBe(seenLlmText);

    // 4. Raw spoken transcript preserved for the renderer's transcript pane.
    expect(result.transcript).toBe('introduction body conclusion');
    expect(result.transcriptSegments).toHaveLength(3);

    // 5. keyframes returned with caption metadata pairing
    expect(result.keyframes).toHaveLength(3);
    expect(result.keyframes[0]).toEqual({ timestamp: 2.0, caption: 'slide 1' });
    expect(result.keyframes[1]).toEqual({ timestamp: 17.5, caption: 'slide 2' });
    expect(result.keyframes[2]).toEqual({ timestamp: 32.0, caption: 'slide 3' });

    // 6. multimodalText non-null when captions exist
    expect(result.multimodalText).toBe(seenLlmText);

    // 7. extractionMethod reflects multimodal source
    expect(result.extractionMethod).toBe('whisper-transcription+vision-captions');

    // 8. shape parity with documentAnalysis: category/keywords/confidence/purpose all set
    expect(result.mediaKind).toBe('video');
    expect(result.category).toBe('product-demo');
    expect(result.keywords).toEqual(['onboarding', 'tutorial']);
    expect(result.confidence).toBe(90);
    expect(result.purpose).toBe('How-to walkthrough');

    // 9. workspace cleaned up eagerly on success
    expect(result.keyframeWorkspace).toBeNull();
  });

  test('vision caption failure on one frame is non-fatal — surviving captions reach the merge', async () => {
    // Frames are captioned in a bounded-concurrency loop; a single bad
    // frame must not poison the batch. Verifies the per-frame catch in
    // captionKeyframes works end-to-end at the analyzeMediaFile level.
    const whisperService = fakeWhisper({
      text: 'one two',
      segments: [
        { start: 0, end: 3, text: 'one' },
        { start: 3, end: 6, text: 'two' }
      ],
      language: 'en',
      durationSeconds: 6
    });
    const analyzeTextWithLlama = jest.fn(async () => ({ category: 'tutorial' }));
    const extractKeyframes = jest.fn(async () => [
      { timestamp: 1.0, framePath: '/tmp/good.jpg' },
      { timestamp: 4.0, framePath: '/tmp/bad.jpg' }
    ]);
    const captionImage = jest.fn(async (framePath) => {
      if (framePath.includes('bad')) throw new Error('vision OOM');
      return 'a thing';
    });

    const result = await analyzeMediaFile(
      '/mock/video.mp4',
      { whisperService, analyzeTextWithLlama, extractKeyframes, captionImage },
      { captionKeyframes: true, maxCaptionedKeyframes: 6, captionConcurrency: 2 }
    );
    // Both keyframes surface; only the survivor has a caption.
    expect(result.keyframes.find((k) => k.timestamp === 1.0).caption).toBe('a thing');
    expect(result.keyframes.find((k) => k.timestamp === 4.0).caption).toBeNull();
    // multimodalText still includes the good caption alongside speech.
    expect(result.multimodalText).toMatch(/Visual: a thing/);
    expect(result.multimodalText).toMatch(/Speech: one/);
    expect(result.multimodalText).toMatch(/Speech: two/);
  });

  test('keyframe extraction error eagerly cleans up workspace before the throw', async () => {
    // Defensive: if the LLM step fails after keyframes were extracted,
    // the workspace dir must be removed (no /tmp/stratosort-keyframes-…
    // leaks). The orchestrator catches LLM failure as non-fatal, but if
    // the flow throws elsewhere the catch in analyzeMediaFile cleans up.
    const whisperService = fakeWhisper({
      text: 'hi',
      segments: [{ start: 0, end: 1, text: 'hi' }],
      language: 'en',
      durationSeconds: 1
    });
    // Inject a Whisper error so the try block throws AFTER the workspace
    // would have been created — but Whisper runs first, so the workspace
    // is never created in this path; this is the simpler error case.
    whisperService.transcribeMedia.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    await expect(
      analyzeMediaFile('/mock/video.mp4', {
        whisperService,
        analyzeTextWithLlama: jest.fn(),
        extractKeyframes: jest.fn()
      })
    ).rejects.toThrow('boom');
    // Whisper threw before keyframeDir was assigned, so cleanup is a no-op
    // here; this test serves as a guard that the catch path doesn't
    // re-throw a different error (e.g. cleanup-of-null TypeError).
  });
});

describe('pickEvenlySpaced', () => {
  test('returns input untouched when n >= length or n <= 0', () => {
    const list = [1, 2, 3, 4];
    expect(pickEvenlySpaced(list, 4)).toEqual([1, 2, 3, 4]);
    expect(pickEvenlySpaced(list, 99)).toEqual([1, 2, 3, 4]);
    expect(pickEvenlySpaced(list, 0)).toEqual([1, 2, 3, 4]);
    expect(pickEvenlySpaced(list, -1)).toEqual([1, 2, 3, 4]);
  });

  test('downsamples evenly across the timeline', () => {
    const list = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']; // 10 items
    // step = 9/2 = 4.5 → indices 0, 5, 9 (Math.round(4.5) = 5 in JS)
    expect(pickEvenlySpaced(list, 3)).toEqual(['a', 'f', 'j']);
    // step = 9/4 = 2.25 → indices 0, 2, 5, 7, 9
    expect(pickEvenlySpaced(list, 5)).toEqual(['a', 'c', 'f', 'h', 'j']);
  });

  test('non-array input returns []', () => {
    expect(pickEvenlySpaced(null, 3)).toEqual([]);
    expect(pickEvenlySpaced(undefined, 3)).toEqual([]);
  });

  test('n === 1 returns a single defined middle element (no [undefined] fencepost)', () => {
    // step = (length-1)/(n-1) divides by zero at n=1; guard returns the middle.
    expect(pickEvenlySpaced(['a', 'b', 'c'], 1)).toEqual(['b']);
    expect(pickEvenlySpaced(['a', 'b'], 1)).toEqual(['a']);
    expect(pickEvenlySpaced([1, 2, 3, 4], 1)).toEqual([2]);
    // The element must be defined — the bug returned [undefined].
    const [only] = pickEvenlySpaced(['x', 'y', 'z'], 1);
    expect(only).toBeDefined();
  });
});

describe('captionKeyframes', () => {
  test('runs captionFn over every frame and returns trimmed strings', async () => {
    const captionFn = jest.fn(async (frame) => `caption for ${frame}`);
    const frames = [
      { timestamp: 1, framePath: '/tmp/a.jpg' },
      { timestamp: 2, framePath: '/tmp/b.jpg' }
    ];
    const result = await captionKeyframes(frames, captionFn);
    expect(captionFn).toHaveBeenCalledTimes(2);
    expect(result).toEqual([
      { timestamp: 1, framePath: '/tmp/a.jpg', caption: 'caption for /tmp/a.jpg' },
      { timestamp: 2, framePath: '/tmp/b.jpg', caption: 'caption for /tmp/b.jpg' }
    ]);
  });

  test('per-frame failures are isolated — one bad frame does not poison others', async () => {
    const captionFn = jest.fn(async (frame) => {
      if (frame === '/tmp/bad.jpg') throw new Error('vision oom');
      return `caption for ${frame}`;
    });
    const frames = [
      { timestamp: 1, framePath: '/tmp/good.jpg' },
      { timestamp: 2, framePath: '/tmp/bad.jpg' },
      { timestamp: 3, framePath: '/tmp/good2.jpg' }
    ];
    const result = await captionKeyframes(frames, captionFn);
    expect(result[0].caption).toBe('caption for /tmp/good.jpg');
    expect(result[1].caption).toBeNull();
    expect(result[1].captionError).toBe('vision oom');
    expect(result[2].caption).toBe('caption for /tmp/good2.jpg');
  });

  test('respects bounded concurrency', async () => {
    let inflight = 0;
    let peakInflight = 0;
    const captionFn = jest.fn(async () => {
      inflight++;
      peakInflight = Math.max(peakInflight, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return 'ok';
    });
    const frames = Array.from({ length: 6 }, (_, i) => ({
      timestamp: i,
      framePath: `/tmp/f${i}.jpg`
    }));
    await captionKeyframes(frames, captionFn, { concurrency: 2 });
    expect(captionFn).toHaveBeenCalledTimes(6);
    expect(peakInflight).toBeLessThanOrEqual(2);
  });

  test('empty input is a no-op', async () => {
    const captionFn = jest.fn();
    expect(await captionKeyframes([], captionFn)).toEqual([]);
    expect(captionFn).not.toHaveBeenCalled();
  });

  test('non-function captionFn throws TypeError before any work', async () => {
    await expect(captionKeyframes([{ timestamp: 0, framePath: '/x' }], null)).rejects.toThrow(
      TypeError
    );
  });
});

describe('mergeTranscriptAndCaptions', () => {
  test('interleaves speech and visual entries chronologically with format tags', () => {
    const segments = [
      { start: 0, end: 2, text: 'hello everyone' },
      { start: 5, end: 8, text: 'lets discuss pricing' }
    ];
    const captions = [
      { timestamp: 1, caption: 'A title slide reading Welcome' },
      { timestamp: 6, caption: 'A whiteboard showing Free, Pro, Team tiers' }
    ];
    const merged = mergeTranscriptAndCaptions(segments, captions);
    expect(merged).toBe(
      [
        '[00:00 → 00:02] Speech: hello everyone',
        '[00:01] Visual: A title slide reading Welcome',
        '[00:05 → 00:08] Speech: lets discuss pricing',
        '[00:06] Visual: A whiteboard showing Free, Pro, Team tiers'
      ].join('\n')
    );
  });

  test('drops entries with no text or caption, drops captions with NaN timestamps', () => {
    const merged = mergeTranscriptAndCaptions(
      [
        { start: 0, end: 1, text: '   ' }, // whitespace only
        { start: 2, end: 3, text: 'real' }
      ],
      [
        { timestamp: 2.5, caption: '' }, // empty caption
        { timestamp: NaN, caption: 'no time' }, // bad timestamp
        { timestamp: 3, caption: 'kept' }
      ]
    );
    expect(merged).toBe('[00:02 → 00:03] Speech: real\n[00:03] Visual: kept');
  });

  test('returns empty string when both inputs are empty', () => {
    expect(mergeTranscriptAndCaptions([], [])).toBe('');
    expect(mergeTranscriptAndCaptions(null, null)).toBe('');
  });

  test('co-located events: speech renders before visual at the same timestamp', () => {
    const merged = mergeTranscriptAndCaptions(
      [{ start: 5, end: 5, text: 'said this' }],
      [{ timestamp: 5, caption: 'showed that' }]
    );
    expect(merged).toBe('[00:05 → 00:05] Speech: said this\n[00:05] Visual: showed that');
  });
});

describe('analyzeMediaFile — multimodal keyframe captioning', () => {
  test('captions keyframes and feeds the merged multimodal text to the LLM', async () => {
    const whisperService = fakeWhisper({
      text: 'welcome lets discuss pricing',
      segments: [
        { start: 0, end: 2, text: 'welcome' },
        { start: 5, end: 8, text: 'lets discuss pricing' }
      ],
      language: 'en',
      durationSeconds: 10.0
    });
    const captionImage = jest.fn(async (framePath) => {
      if (framePath.endsWith('frame-1.jpg')) return 'A title slide reading Welcome';
      if (framePath.endsWith('frame-2.jpg')) return 'A pricing whiteboard';
      return null;
    });
    const extractKeyframes = jest.fn(async () => [
      { timestamp: 1, framePath: '/tmp/frame-1.jpg' },
      { timestamp: 6, framePath: '/tmp/frame-2.jpg' }
    ]);
    const analyzeTextWithLlama = jest.fn(async (text) => ({
      category: 'demo',
      keywords: ['pricing'],
      _seenText: text
    }));

    const result = await analyzeMediaFile(
      '/mock/video.mp4',
      { whisperService, analyzeTextWithLlama, extractKeyframes, captionImage },
      { captionKeyframes: true }
    );

    expect(captionImage).toHaveBeenCalledTimes(2);
    // The LLM should have received the interleaved multimodal text.
    const sentText = analyzeTextWithLlama.mock.calls[0][0];
    expect(sentText).toContain('Speech: welcome');
    expect(sentText).toContain('Visual: A title slide reading Welcome');
    expect(sentText).toContain('Visual: A pricing whiteboard');
    expect(sentText).toContain('Speech: lets discuss pricing');

    expect(result.keyframes).toHaveLength(2);
    expect(result.keyframes[0].caption).toBe('A title slide reading Welcome');
    expect(result.keyframes[1].caption).toBe('A pricing whiteboard');
    expect(result.extractionMethod).toBe('whisper-transcription+vision-captions');
    expect(result.multimodalText).toBeTruthy();
    expect(result.multimodalText).toContain('Visual:');
  });

  test('captionKeyframes:false leaves the path identical to transcript-only', async () => {
    const whisperService = fakeWhisper({
      text: 'speech',
      segments: [{ start: 0, end: 1, text: 'speech' }],
      language: 'en',
      durationSeconds: 5.0
    });
    const captionImage = jest.fn();
    const extractKeyframes = jest.fn(async () => [{ timestamp: 1, framePath: '/tmp/a.jpg' }]);
    const result = await analyzeMediaFile(
      '/mock/video.mp4',
      {
        whisperService,
        analyzeTextWithLlama: jest.fn(async () => ({ category: 'video' })),
        extractKeyframes,
        captionImage
      },
      { captionKeyframes: false }
    );
    expect(captionImage).not.toHaveBeenCalled();
    // No captioning means no extraction either: frames carried nothing but
    // timestamps and the UI then claimed visual analysis (MI-04).
    expect(extractKeyframes).not.toHaveBeenCalled();
    expect(result.extractionMethod).toBe('whisper-transcription');
    expect(result.multimodalText).toBeNull();
    expect(result.keyframes).toEqual([]);
  });

  test('captioning failure is non-fatal — transcript-only path still runs', async () => {
    const whisperService = fakeWhisper({
      text: 'speech',
      segments: [{ start: 0, end: 1, text: 'speech' }],
      language: 'en',
      durationSeconds: 5.0
    });
    const captionImage = jest.fn(async () => {
      throw new Error('vision down');
    });
    const extractKeyframes = jest.fn(async () => [
      { timestamp: 1, framePath: '/tmp/a.jpg' },
      { timestamp: 2, framePath: '/tmp/b.jpg' }
    ]);
    const analyzeTextWithLlama = jest.fn(async () => ({ category: 'video' }));

    const result = await analyzeMediaFile(
      '/mock/video.mp4',
      { whisperService, analyzeTextWithLlama, extractKeyframes, captionImage },
      { captionKeyframes: true }
    );
    // captionKeyframes catches per-frame errors; the merge sees no captions
    // → multimodalText is null and extraction reverts to transcript-only.
    expect(result.extractionMethod).toBe('whisper-transcription');
    expect(result.multimodalText).toBeNull();
    expect(result.keyframes[0].caption).toBeNull();
    expect(result.keyframes[1].caption).toBeNull();
    // Speech still made it to the LLM via the transcript-only formatter
    // (no "Speech:" tag — that's only used by the multimodal merge).
    expect(analyzeTextWithLlama.mock.calls[0][0]).toContain('[00:00 → 00:01] speech');
  });

  test('passing captionImage:null disables captioning even when option is on', async () => {
    const whisperService = fakeWhisper({
      text: 'speech',
      segments: [{ start: 0, end: 1, text: 'speech' }],
      language: 'en',
      durationSeconds: 5.0
    });
    const extractKeyframes = jest.fn(async () => [{ timestamp: 1, framePath: '/tmp/a.jpg' }]);
    const result = await analyzeMediaFile(
      '/mock/video.mp4',
      {
        whisperService,
        analyzeTextWithLlama: jest.fn(async () => ({ category: 'video' })),
        extractKeyframes,
        captionImage: null
      },
      { captionKeyframes: true }
    );
    expect(result.extractionMethod).toBe('whisper-transcription');
    expect(result.multimodalText).toBeNull();
  });

  test('downsamples to maxCaptionedKeyframes when more frames are available', async () => {
    const whisperService = fakeWhisper({
      text: 'long video',
      segments: [{ start: 0, end: 60, text: 'long video' }],
      language: 'en',
      durationSeconds: 60.0
    });
    const captionImage = jest.fn(async () => 'cap');
    const extractKeyframes = jest.fn(async () =>
      Array.from({ length: 12 }, (_, i) => ({
        timestamp: i * 5,
        framePath: `/tmp/f${i}.jpg`
      }))
    );
    const result = await analyzeMediaFile(
      '/mock/video.mp4',
      {
        whisperService,
        analyzeTextWithLlama: jest.fn(async () => ({ category: 'video' })),
        extractKeyframes,
        captionImage
      },
      { captionKeyframes: true, maxCaptionedKeyframes: 4 }
    );
    expect(captionImage).toHaveBeenCalledTimes(4);
    // The result still surfaces all 12 keyframes (caption only on the
    // 4 that got captioned).
    expect(result.keyframes).toHaveLength(12);
    const captioned = result.keyframes.filter((k) => k.caption);
    expect(captioned).toHaveLength(4);
  });
});
