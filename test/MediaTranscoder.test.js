/**
 * Tests for MediaTranscoder.
 *
 * The ffmpeg binary is mocked via child_process.spawn. We assert argument
 * shape, abort propagation, timeout enforcement, and PCM-byte assembly.
 */

const { EventEmitter } = require('events');
const path = require('path');

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

// MediaTranscoder's resolveFfmpegPath() walks: STRATOSORT_FFMPEG_PATH env →
// bundled assets/runtime/ffmpeg → PATH fallback. We mock runtimePaths so
// the bundled-location branch returns a sentinel string and gets accepted
// by the resolver (memfs is already mocked at the global level by
// test-setup.js, so existsSync against the sentinel returns false unless
// we also pre-create it — easier to mock runtimePaths AND the fs.existsSync
// for that single path).
const mockFfmpegPath = '/tmp/mock-ffmpeg-binary';

jest.mock('../src/main/utils/runtimePaths', () => ({
  resolveRuntimePath: (..._segments) => mockFfmpegPath,
  resolveRuntimeRoot: () => '/tmp'
}));

const mockSpawn = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: (...args) => mockSpawn(...args)
}));

// Pre-create the sentinel before each test so resolveFfmpegPath()'s
// existsSync passes. Must be beforeEach (not beforeAll) because
// test-setup.js calls vol.reset() in its own beforeEach and wipes the
// volume — our hook registers later, so it runs *after* the reset.
//
// Also pre-create the canonical mock input paths used by the transcode
// suites. PR #181 added an fs.stat() pre-flight size check before
// spawning ffmpeg; without these stub files in memfs the precheck would
// reject every transcode call with INVALID_INPUT before the test could
// exercise the actual spawn / abort / exit-code paths it cares about.
beforeEach(() => {
  const fs = require('fs');
  try {
    fs.mkdirSync('/tmp', { recursive: true });
  } catch {
    /* /tmp may already exist */
  }
  fs.writeFileSync(mockFfmpegPath, '');
  // resolveFfmpegPath() now also requires the bundled binary to be executable
  // (X_OK), matching the real-world packaging step that runs chmod 0o755 on
  // extract. Without this, every test would fall through to the PATH lookup.
  fs.chmodSync(mockFfmpegPath, 0o755);
  try {
    fs.mkdirSync('/mock', { recursive: true });
  } catch {
    /* /mock may already exist */
  }
  fs.writeFileSync('/mock/audio.mp3', '');
  fs.writeFileSync('/mock/broken.mp4', '');
});

const {
  transcodeToWhisperPcm,
  extractKeyframes,
  resolveFfmpegPath,
  createBoundedStderrCollector,
  MAX_FFMPEG_STDERR_BYTES,
  WHISPER_SAMPLE_RATE
} = require('../src/main/services/MediaTranscoder');
const { ERROR_CODES } = require('../src/shared/errorCodes');

function makeFakeChild({
  pcmChunks = [],
  stderrChunks = [],
  exitCode = 0,
  killSignal = null,
  errorEvent = null
} = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  process.nextTick(() => {
    if (errorEvent) {
      child.emit('error', errorEvent);
      return;
    }
    for (const chunk of pcmChunks) child.stdout.emit('data', chunk);
    for (const chunk of stderrChunks) child.stderr.emit('data', chunk);
    child.emit('close', exitCode, killSignal);
  });
  return child;
}

describe('resolveFfmpegPath — executability check (regression: 3.1.1 audit)', () => {
  // Regression guard for the 3.1.1 audit: previously resolveFfmpegPath only
  // checked existsSync(bundled), so a present-but-unexecutable binary
  // (read-only filesystem, broken chmod 0o755 on extract, antivirus
  // quarantine) made it past resolution and crashed deep inside spawn() with
  // a cryptic EACCES. The fix uses fs.accessSync(..., X_OK) and falls through
  // to PATH (with the actionable warn-once log) when the bundled file
  // exists but is not executable.
  test('returns the bundled path when present AND executable', () => {
    const fs = require('fs');
    fs.writeFileSync(mockFfmpegPath, '');
    fs.chmodSync(mockFfmpegPath, 0o755);
    expect(resolveFfmpegPath()).toBe(mockFfmpegPath);
  });

  // On Windows the X_OK gate is intentionally a no-op (libuv ACL→GENERIC_EXECUTE
  // is unreliable for files extracted via Explorer; spawn ENOENT/EACCES surfaces
  // real failures via SERVICE_UNAVAILABLE in child.on('error')). Only assert
  // the X_OK fall-through on platforms where the gate actually fires.
  const xOkTest = process.platform === 'win32' ? test.skip : test;
  xOkTest('falls through to PATH-resolvable name when bundled file lacks execute bit', () => {
    const fs = require('fs');
    fs.writeFileSync(mockFfmpegPath, '');
    fs.chmodSync(mockFfmpegPath, 0o644); // rw-r--r-- — exists, NOT executable
    const resolved = resolveFfmpegPath();
    // Should NOT be the bundled path (skipped because not executable);
    // should be the bare binary name so OS PATH lookup runs.
    expect(resolved).not.toBe(mockFfmpegPath);
    expect(resolved).toBe('ffmpeg');
  });

  test('STRATOSORT_FFMPEG_PATH override still wins regardless of bundled state', () => {
    const fs = require('fs');
    const overridePath = '/tmp/explicit-override-ffmpeg';
    fs.writeFileSync(overridePath, '');
    fs.chmodSync(overridePath, 0o755);
    const prev = process.env.STRATOSORT_FFMPEG_PATH;
    process.env.STRATOSORT_FFMPEG_PATH = overridePath;
    try {
      expect(resolveFfmpegPath()).toBe(overridePath);
    } finally {
      if (prev === undefined) delete process.env.STRATOSORT_FFMPEG_PATH;
      else process.env.STRATOSORT_FFMPEG_PATH = prev;
    }
  });
});

describe('transcodeToWhisperPcm — argument construction', () => {
  beforeEach(() => mockSpawn.mockReset());

  test('passes the expected ffmpeg flags for whisper format', async () => {
    mockSpawn.mockImplementation(() =>
      makeFakeChild({
        pcmChunks: [Buffer.from([0x01, 0x00, 0x02, 0x00])],
        exitCode: 0
      })
    );
    const result = await transcodeToWhisperPcm('/mock/audio.mp3');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [bin, args] = mockSpawn.mock.calls[0];
    expect(bin).toBe(mockFfmpegPath);
    // Required pieces of the argument list — order doesn't matter for these assertions
    expect(args).toEqual(expect.arrayContaining(['-i', '/mock/audio.mp3', '-vn', '-f', 's16le']));
    expect(args).toEqual(expect.arrayContaining(['-ar', String(WHISPER_SAMPLE_RATE)]));
    expect(args).toEqual(expect.arrayContaining(['-ac', '1']));
    expect(args[args.length - 1]).toBe('pipe:1');
    expect(result.sampleRate).toBe(WHISPER_SAMPLE_RATE);
    expect(result.channels).toBe(1);
    expect(result.pcm.length).toBe(4);
  });

  test('rejects empty input path with INVALID_INPUT', async () => {
    await expect(transcodeToWhisperPcm('')).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT
    });
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe('createBoundedStderrCollector', () => {
  test('keeps the head of the stream up to the cap and flags truncation', () => {
    const collector = createBoundedStderrCollector(10);
    collector.push(Buffer.from('abcd'));
    collector.push(Buffer.from('efghijkl'));
    collector.push(Buffer.from('never kept'));

    expect(collector.text()).toBe('abcdefghij');
    expect(collector.text().length).toBe(10);
    expect(collector.truncated).toBe(true);
  });

  test('is a plain passthrough while under the cap', () => {
    const collector = createBoundedStderrCollector(64);
    collector.push(Buffer.from('one '));
    collector.push(Buffer.from('two'));

    expect(collector.text()).toBe('one two');
    expect(collector.truncated).toBe(false);
  });

  test('default cap is 256 KiB', () => {
    expect(MAX_FFMPEG_STDERR_BYTES).toBe(256 * 1024);
  });
});

describe('transcodeToWhisperPcm — failure modes', () => {
  beforeEach(() => mockSpawn.mockReset());

  test('stderr retention is bounded even when ffmpeg emits megabytes of noise', async () => {
    // 4 MiB of stderr in 4 KiB chunks; the error message must be built from
    // the (bounded) head and the run must not retain the full stream.
    const noise = Buffer.alloc(4 * 1024, 0x41);
    const stderrChunks = [Buffer.from('moov atom not found\n')];
    for (let i = 0; i < 1024; i += 1) stderrChunks.push(noise);
    mockSpawn.mockImplementation(() => makeFakeChild({ stderrChunks, exitCode: 1 }));

    await expect(
      transcodeToWhisperPcm('/mock/broken.mp4', { retryAttempts: 1 })
    ).rejects.toMatchObject({
      code: ERROR_CODES.ANALYSIS_FAILED,
      message: expect.stringContaining('moov atom not found')
    });
  });

  test('non-zero exit surfaces ANALYSIS_FAILED with stderr text', async () => {
    mockSpawn.mockImplementation(() =>
      makeFakeChild({
        stderrChunks: [Buffer.from('moov atom not found')],
        exitCode: 1
      })
    );
    await expect(
      // retryAttempts:1 disables the new transient-failure retry loop so
      // this test asserts the single-attempt error mapping.
      transcodeToWhisperPcm('/mock/broken.mp4', { retryAttempts: 1 })
    ).rejects.toMatchObject({
      code: ERROR_CODES.ANALYSIS_FAILED
    });
  });

  test('retries on transient ffmpeg failures and succeeds on the 2nd attempt', async () => {
    // Real-world cause: Windows AV briefly locks newly-copied files.
    // First spawn → ffmpeg exits 1 with "Permission denied"; second
    // spawn → success. The retry layer should hide the failure from
    // the caller entirely.
    let callCount = 0;
    mockSpawn.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return makeFakeChild({
          stderrChunks: [Buffer.from('Permission denied')],
          exitCode: 1
        });
      }
      return makeFakeChild({
        pcmChunks: [Buffer.from([0x01, 0x00, 0x02, 0x00])],
        exitCode: 0
      });
    });
    const result = await transcodeToWhisperPcm('/mock/audio.mp3', {
      retryAttempts: 3,
      retryBaseMs: 1
    });
    expect(callCount).toBe(2);
    expect(result.pcm.length).toBe(4);
  });

  test('a video with no audio stream is MEDIA_NO_AUDIO_STREAM, reported once, never retried', async () => {
    // ffmpeg with -vn -sn -dn on a silent screen recording has nothing to
    // encode and exits non-zero. That is a fact about the file, not a
    // transient failure: three retries and a raw ffmpeg message helped nobody.
    require('fs').writeFileSync('/mock/screen-recording.mp4', '');
    let callCount = 0;
    mockSpawn.mockImplementation(() => {
      callCount += 1;
      return makeFakeChild({
        stderrChunks: [Buffer.from('Output file #0 does not contain any stream')],
        exitCode: 234
      });
    });
    await expect(
      transcodeToWhisperPcm('/mock/screen-recording.mp4', { retryAttempts: 3, retryBaseMs: 1 })
    ).rejects.toMatchObject({
      code: ERROR_CODES.MEDIA_NO_AUDIO_STREAM,
      message: expect.stringMatching(/No audio stream to transcribe in screen-recording\.mp4/)
    });
    expect(callCount).toBe(1);
  });

  test('describesMissingAudioStream matches the ffmpeg wordings and nothing else', () => {
    const { describesMissingAudioStream } = require('../src/main/services/MediaTranscoder');
    expect(describesMissingAudioStream('Output file #0 does not contain any stream')).toBe(true);
    expect(describesMissingAudioStream("Stream map '0:a' matches no streams.")).toBe(true);
    expect(describesMissingAudioStream('Output file is empty, nothing was encoded')).toBe(true);
    expect(describesMissingAudioStream('Permission denied')).toBe(false);
    expect(describesMissingAudioStream('moov atom not found')).toBe(false);
    expect(describesMissingAudioStream('')).toBe(false);
    expect(describesMissingAudioStream(null)).toBe(false);
  });

  test('retry does NOT trigger on ENOENT (configuration error, not transient)', async () => {
    // ENOENT means the ffmpeg binary itself is missing; retrying won't
    // help and would just delay the actionable error message.
    let callCount = 0;
    mockSpawn.mockImplementation(() => {
      callCount += 1;
      return makeFakeChild({
        errorEvent: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
      });
    });
    await expect(
      transcodeToWhisperPcm('/mock/audio.mp3', { retryAttempts: 3, retryBaseMs: 1 })
    ).rejects.toMatchObject({ code: ERROR_CODES.SERVICE_UNAVAILABLE });
    expect(callCount).toBe(1);
  });

  test('retry exhausts attempts then rethrows the final ANALYSIS_FAILED error', async () => {
    let callCount = 0;
    mockSpawn.mockImplementation(() => {
      callCount += 1;
      return makeFakeChild({
        stderrChunks: [Buffer.from('Resource busy')],
        exitCode: 1
      });
    });
    await expect(
      transcodeToWhisperPcm('/mock/audio.mp3', { retryAttempts: 3, retryBaseMs: 1 })
    ).rejects.toMatchObject({ code: ERROR_CODES.ANALYSIS_FAILED });
    expect(callCount).toBe(3);
  });

  test('spawn ENOENT surfaces SERVICE_UNAVAILABLE so the upstream catch can flag the audio-transcription banner', async () => {
    mockSpawn.mockImplementation(() =>
      makeFakeChild({
        errorEvent: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
      })
    );
    // WhisperService.transcribeMedia keys on SERVICE_UNAVAILABLE /
    // LLAMA_MODEL_NOT_FOUND to raise the DegradedStateBanner. A bare
    // ENOENT was indistinguishable from a transient failure; this
    // wrapping turns "ffmpeg not on PATH" into a subsystem-down signal.
    await expect(transcodeToWhisperPcm('/mock/audio.mp3')).rejects.toMatchObject({
      code: ERROR_CODES.SERVICE_UNAVAILABLE,
      message: expect.stringMatching(/ffmpeg is unavailable.*ENOENT/i)
    });
  });

  test('spawn EACCES is also tagged SERVICE_UNAVAILABLE (executable bit lost)', async () => {
    mockSpawn.mockImplementation(() =>
      makeFakeChild({
        errorEvent: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })
      })
    );
    await expect(transcodeToWhisperPcm('/mock/audio.mp3')).rejects.toMatchObject({
      code: ERROR_CODES.SERVICE_UNAVAILABLE,
      message: expect.stringMatching(/ffmpeg is unavailable.*EACCES/i)
    });
  });

  test('aborted signal surfaces OPERATION_CANCELLED before spawn', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      transcodeToWhisperPcm('/mock/audio.mp3', { signal: ac.signal })
    ).rejects.toMatchObject({ code: ERROR_CODES.OPERATION_CANCELLED });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test('aborting mid-stream kills the child', async () => {
    // Build a child that never closes on its own so we can drive the abort
    // path deterministically; the helper schedules a close event on
    // process.nextTick which would beat the abort.
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = jest.fn();
    mockSpawn.mockImplementation(() => child);

    const ac = new AbortController();
    const p = transcodeToWhisperPcm('/mock/audio.mp3', { signal: ac.signal });
    // Yield once so the service attaches its abort listener before we fire it.
    await new Promise((r) => setImmediate(r));
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: ERROR_CODES.OPERATION_CANCELLED });
    expect(child.kill).toHaveBeenCalled();
  });

  test('exceeding maxDurationSeconds rejects with INVALID_INPUT', async () => {
    // Stream more bytes than the 1-second cap allows. 16k samples * 2 bytes
    // = 32_000 bytes per second. We send 100_000 bytes with maxDuration=1s.
    mockSpawn.mockImplementation(() =>
      makeFakeChild({
        pcmChunks: [Buffer.alloc(100_000)],
        exitCode: 0
      })
    );
    await expect(
      transcodeToWhisperPcm('/mock/audio.mp3', { maxDurationSeconds: 1 })
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_INPUT });
  });
});

// Use the same fs module that MediaTranscoder consumes so workspace
// state is visible to it. Jest's test-setup installs memfs as the
// 'fs' mock; pulling it through `require('fs')` keeps writes/reads on
// the same in-memory volume the SUT sees.
const fsMod = require('fs').promises;

describe('extractKeyframes — argument construction and parsing', () => {
  let workspace;

  beforeEach(async () => {
    mockSpawn.mockReset();
    workspace = `/tmp/keyframes-test-${Math.random().toString(36).slice(2)}`;
    await fsMod.mkdir(workspace, { recursive: true });
  });

  afterEach(async () => {
    if (workspace) {
      try {
        await fsMod.rm(workspace, { recursive: true, force: true });
      } catch {
        /* memfs may have already cleaned this up */
      }
    }
  });

  test('passes scene-detection filter and writes frames into outputDir', async () => {
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = jest.fn();
      // Drop two synthetic "frame" files into the workspace before the
      // close event so the post-process readdir picks them up.
      process.nextTick(async () => {
        await fsMod.writeFile(`${workspace}/frame-0001.jpg`, 'fake1');
        await fsMod.writeFile(`${workspace}/frame-0002.jpg`, 'fake2');
        child.stderr.emit(
          'data',
          Buffer.from(
            '[Parsed_showinfo_1 @ 0xabc] n: 0 pts: 0 pts_time:1.5\n' +
              '[Parsed_showinfo_1 @ 0xabc] n: 1 pts: 100 pts_time:7.25\n'
          )
        );
        child.emit('close', 0, null);
      });
      return child;
    });

    const result = await extractKeyframes('/mock/video.mp4', workspace, { sceneThreshold: 0.5 });
    const [bin, args] = mockSpawn.mock.calls[0];
    expect(bin).toBe(mockFfmpegPath);
    expect(args).toEqual(expect.arrayContaining(['-i', '/mock/video.mp4']));
    // Filter graph string should mention scene threshold and showinfo
    const filterArgIdx = args.indexOf('-vf');
    expect(filterArgIdx).toBeGreaterThan(-1);
    expect(args[filterArgIdx + 1]).toMatch(/scene/);
    expect(args[filterArgIdx + 1]).toMatch(/showinfo/);
    expect(args[filterArgIdx + 1]).toContain('0.5');

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      timestamp: 1.5,
      framePath: path.join(workspace, 'frame-0001.jpg')
    });
    expect(result[1]).toEqual({
      timestamp: 7.25,
      framePath: path.join(workspace, 'frame-0002.jpg')
    });
  });

  test('parses showinfo timestamps from the bounded head when stderr exceeds the cap', async () => {
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = jest.fn();
      process.nextTick(async () => {
        await fsMod.writeFile(`${workspace}/frame-0001.jpg`, 'fake1');
        await fsMod.writeFile(`${workspace}/frame-0002.jpg`, 'fake2');
        child.stderr.emit(
          'data',
          Buffer.from(
            '[Parsed_showinfo_1 @ 0xabc] n: 0 pts: 0 pts_time:1.5\n' +
              '[Parsed_showinfo_1 @ 0xabc] n: 1 pts: 100 pts_time:7.25\n'
          )
        );
        // 4 MiB of trailing log noise in 4 KiB chunks — well past the cap.
        const noise = Buffer.alloc(4 * 1024, 0x2e);
        for (let i = 0; i < 1024; i += 1) child.stderr.emit('data', noise);
        child.emit('close', 0, null);
      });
      return child;
    });

    const result = await extractKeyframes('/mock/video.mp4', workspace, { maxFrames: 2 });

    expect(result.map((frame) => frame.timestamp)).toEqual([1.5, 7.25]);
  });

  test('rejects empty videoPath / outputDir', async () => {
    await expect(extractKeyframes('', workspace)).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT
    });
    await expect(extractKeyframes('/mock/video.mp4', '')).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT
    });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test('rejects out-of-range sceneThreshold and maxFrames', async () => {
    await expect(
      extractKeyframes('/mock/video.mp4', workspace, { sceneThreshold: 0 })
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_INPUT });
    await expect(
      extractKeyframes('/mock/video.mp4', workspace, { sceneThreshold: 1.5 })
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_INPUT });
    await expect(
      extractKeyframes('/mock/video.mp4', workspace, { maxFrames: 0 })
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_INPUT });
  });

  test('non-zero ffmpeg exit surfaces ANALYSIS_FAILED', async () => {
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = jest.fn();
      process.nextTick(() => {
        child.stderr.emit('data', Buffer.from('codec not found'));
        child.emit('close', 1, null);
      });
      return child;
    });
    await expect(extractKeyframes('/mock/video.mp4', workspace)).rejects.toMatchObject({
      code: ERROR_CODES.ANALYSIS_FAILED
    });
  });

  test('scene-detection 0-frame result triggers evenly-spaced fallback (real-video gap)', async () => {
    // Regression: a real ~8 s product-shot video with gradual motion
    // (Coffee_cups_stacked_*) yielded zero scene-cut frames at the
    // production threshold of 0.4. Without the fallback, the orchestrator
    // proceeds transcript-only and the multimodal vision-LLM path never
    // engages — which is what extractedText / multimodalText callers see.
    // Mocks three sequential ffmpeg invocations: scene-cut (zero frames),
    // duration probe, and the even-spaced sampler.
    let callIdx = 0;
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = jest.fn();
      const thisCall = callIdx++;
      process.nextTick(async () => {
        if (thisCall === 0) {
          // Scene-cut pass: zero showinfo lines, no frames written.
          child.emit('close', 0, null);
        } else if (thisCall === 1) {
          // Duration probe: ffmpeg without an output, emits Duration line.
          child.stderr.emit(
            'data',
            Buffer.from('  Duration: 00:00:08.00, start: 0.000000, bitrate: 1000 kb/s\n')
          );
          child.emit('close', 1, null); // probe always exits non-zero
        } else {
          // Even-spaced fallback writes JPEGs into the workspace.
          await fsMod.writeFile(`${workspace}/frame-0001.jpg`, 'fb1');
          await fsMod.writeFile(`${workspace}/frame-0002.jpg`, 'fb2');
          await fsMod.writeFile(`${workspace}/frame-0003.jpg`, 'fb3');
          child.emit('close', 0, null);
        }
      });
      return child;
    });

    const result = await extractKeyframes('/mock/static-shot.mp4', workspace, {
      maxFrames: 3
    });
    expect(result).toHaveLength(3);
    // Even-spaced timestamps must be monotonic and within the duration.
    expect(result[0].timestamp).toBeGreaterThan(0);
    expect(result[result.length - 1].timestamp).toBeLessThanOrEqual(8);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].timestamp).toBeGreaterThan(result[i - 1].timestamp);
    }
    // Three ffmpeg invocations: scene-cut + probe + even-spaced.
    expect(mockSpawn).toHaveBeenCalledTimes(3);
  });

  test('keyframeFallback:none preserves pre-fix behavior (returns [] when scene cuts find nothing)', async () => {
    // Opt-out for callers that genuinely want scene-cut-only output.
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = jest.fn();
      process.nextTick(() => child.emit('close', 0, null));
      return child;
    });
    const result = await extractKeyframes('/mock/static-shot.mp4', workspace, {
      maxFrames: 5,
      keyframeFallback: 'none'
    });
    expect(result).toEqual([]);
    // Only the scene-cut call; no probe, no fallback.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  test('fallback failure is non-fatal — returns [] without throwing', async () => {
    // If duration probe fails (corrupt mp4, unreadable metadata) the
    // orchestrator already handles [] gracefully (transcript-only). The
    // fallback path must absorb its own errors so that flow stays the
    // same instead of bubbling a second-stage failure as the primary
    // error code.
    let callIdx = 0;
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = jest.fn();
      const thisCall = callIdx++;
      process.nextTick(() => {
        if (thisCall === 0) {
          child.emit('close', 0, null);
        } else {
          // Probe emits no Duration line — parse fails inside fallback.
          child.stderr.emit('data', Buffer.from('Invalid data found when processing input'));
          child.emit('close', 1, null);
        }
      });
      return child;
    });
    const result = await extractKeyframes('/mock/corrupt.mp4', workspace, { maxFrames: 4 });
    expect(result).toEqual([]);
  });
});
