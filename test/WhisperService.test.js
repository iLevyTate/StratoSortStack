/**
 * Tests for WhisperService and MediaTranscoder.
 *
 * The whisper.cpp binding is not loaded in unit tests; we inject a fake
 * binding via WhisperService's `bindingOverride` constructor option. The
 * goal is to exercise model-path resolution, lazy load, error wrapping,
 * cache behaviour, and abort handling without touching native code.
 */

const path = require('path');

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

jest.mock('../src/shared/singletonFactory', () => ({
  createSingletonHelpers: () => ({
    getInstance: jest.fn(),
    createInstance: jest.fn(),
    registerWithContainer: jest.fn(),
    resetInstance: jest.fn(),
    disposeLocalInstance: jest.fn()
  })
}));

jest.mock('../src/main/services/modelPathResolver', () => ({
  ensureResolvedModelsPath: jest.fn(async () => ({
    modelsPath: '/mock/userData/models',
    source: 'current-empty'
  }))
}));

const mockFsStat = jest.fn();
const mockFsMkdir = jest.fn(async () => undefined);
const mockFsLstat = jest.fn();
const mockFsCopyFile = jest.fn(async () => undefined);
const fakeFsPromises = {
  stat: mockFsStat,
  mkdir: mockFsMkdir,
  lstat: mockFsLstat,
  copyFile: mockFsCopyFile
};

const {
  WhisperService,
  _shouldUseGpu,
  DEFAULT_MODEL_FILENAME,
  WHISPER_SUBDIR
} = require('../src/main/services/WhisperService');
const { ERROR_CODES } = require('../src/shared/errorCodes');

function makeFakeBinding({ initWhisperImpl, transcribeDataImpl, includeFile = true } = {}) {
  const handles = [];
  const transcribeData =
    transcribeDataImpl ||
    jest.fn((_pcm, _opts) => {
      let resolveFn;
      let rejectFn;
      const promise = new Promise((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
      const handle = {
        promise,
        stop: jest.fn(() =>
          rejectFn(Object.assign(new Error('cancelled'), { name: 'AbortError' }))
        ),
        _resolve: (value) => resolveFn(value),
        _reject: (err) => rejectFn(err)
      };
      handles.push(handle);
      return handle;
    });

  const initWhisper =
    initWhisperImpl ||
    jest.fn(async (options) => {
      // Mirror the real @fugood/whisper.node binding contract
      // (NativeContextOptions.filePath, see node_modules/@fugood/whisper.node/lib/binding.ts).
      // Catches `model:` / other wrong keys at the mock layer so a future
      // regression fails the suite instead of silently passing.
      if (typeof options?.filePath !== 'string' || !options.filePath) {
        throw new Error('Mock initWhisper: NativeContextOptions.filePath is required');
      }
      return {
        transcribeData,
        transcribeFile: includeFile ? jest.fn() : undefined,
        release: jest.fn()
      };
    });

  return { binding: { initWhisper }, handles, transcribeData };
}

function fakeGpuMonitor(gpuInfo = { type: 'cpu', name: 'CPU' }) {
  return { detectGPU: jest.fn(async () => gpuInfo) };
}

describe('WhisperService — _shouldUseGpu helper', () => {
  test('returns false when GPU info is missing', () => {
    expect(_shouldUseGpu(null)).toBe(false);
    expect(_shouldUseGpu(undefined)).toBe(false);
  });
  test('returns false on cpu', () => {
    expect(_shouldUseGpu({ type: 'cpu' })).toBe(false);
  });
  test('returns true for metal/cuda/vulkan', () => {
    expect(_shouldUseGpu({ type: 'metal', vramMB: 16384 })).toBe(true);
    expect(_shouldUseGpu({ type: 'cuda', vramMB: 8192 })).toBe(true);
    expect(_shouldUseGpu({ type: 'vulkan', vramMB: 0 })).toBe(true);
  });
});

describe('WhisperService — model path resolution', () => {
  beforeEach(() => {
    mockFsStat.mockReset();
    mockFsMkdir.mockReset();
  });

  test('throws LLAMA_MODEL_NOT_FOUND when the GGML file is missing', async () => {
    // Both the primary stat and the legacy migration's lstat must miss
    // for the LLAMA_MODEL_NOT_FOUND path to fire (the migration is now a
    // pre-throw fallback). mockFsStat misses unconditionally; lstat is
    // also rejected so no legacy candidate matches.
    mockFsStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockFsLstat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const { binding } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises
    });
    await expect(svc._resolveModelPath()).rejects.toMatchObject({
      code: ERROR_CODES.LLAMA_MODEL_NOT_FOUND
    });
  });

  test('migrates the whisper model from a legacy userData folder when the current path is empty', async () => {
    // Regression: simple-main.js sets `app.name = 'StratoSort Stack'`
    // (capitals + space) but scripts/setup-whisper-model.js builds its
    // install path from package.json `name` (lowercase). The result is
    // a real divergence between the resolved current userData
    // (`%APPDATA%\StratoSort Stack\…`) and where the model actually
    // ends up on disk (`%APPDATA%\stratosort-core\…`). modelPathResolver
    // migrates `.gguf` files but the Whisper model is `.bin`, so the
    // user-visible failure was: setup script reports "present and
    // verified" but every transcribe call raises LLAMA_MODEL_NOT_FOUND.
    // After the fix, _resolveModelPath walks the legacy folders and
    // copies the file before throwing.
    mockFsStat.mockReset();
    mockFsLstat.mockReset();
    mockFsCopyFile.mockReset();
    mockFsMkdir.mockReset();
    // Primary stat misses (current path empty), then legacy lstat finds the file.
    mockFsStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockFsLstat.mockResolvedValueOnce({ isFile: () => true });
    const { binding } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises
    });
    const resolved = await svc._resolveModelPath();
    expect(resolved.endsWith(path.join(WHISPER_SUBDIR, DEFAULT_MODEL_FILENAME))).toBe(true);
    // Migration must have copied the file (one copyFile call).
    expect(mockFsCopyFile).toHaveBeenCalledTimes(1);
    const [legacySource, currentTarget] = mockFsCopyFile.mock.calls[0];
    expect(legacySource).toMatch(/whisper/);
    expect(legacySource).toMatch(new RegExp(DEFAULT_MODEL_FILENAME.replace('.', '\\.') + '$'));
    expect(currentTarget).toBe(resolved);
  });

  test('rejects unsafe legacy filenames (defense-in-depth against tampered package.json)', async () => {
    // The migration helper uses modelFileName as a path component. A
    // hostile package.json with modelFilename: '../foo' could otherwise
    // copy outside the whisper subdir. Constructor accepts modelFilename
    // verbatim, so guard at the migration boundary.
    mockFsStat.mockReset();
    mockFsLstat.mockReset();
    mockFsCopyFile.mockReset();
    mockFsStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const { binding } = makeFakeBinding();
    const svc = new WhisperService({
      modelFilename: '../escape.bin',
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises
    });
    await expect(svc._resolveModelPath()).rejects.toMatchObject({
      code: ERROR_CODES.LLAMA_MODEL_NOT_FOUND
    });
    // Reject must NOT have triggered any copy — migration helper bailed.
    expect(mockFsCopyFile).not.toHaveBeenCalled();
  });

  test('VAD model migration mirrors the primary model migration', async () => {
    // VAD is the same .bin shape, also installed by setup-whisper-model
    // into the legacy folder. Without this migration, opt-in VAD
    // silently disables on every fresh install.
    mockFsStat.mockReset();
    mockFsLstat.mockReset();
    mockFsCopyFile.mockReset();
    mockFsStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockFsLstat.mockResolvedValueOnce({ isFile: () => true });
    const { binding } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises
    });
    const resolved = await svc._resolveVadModelPath();
    expect(resolved).toBeTruthy();
    expect(resolved.endsWith('ggml-silero-v5.1.2.bin')).toBe(true);
    expect(mockFsCopyFile).toHaveBeenCalledTimes(1);
  });

  test('VAD returns null when both current and all legacy candidates miss', async () => {
    mockFsStat.mockReset();
    mockFsLstat.mockReset();
    mockFsCopyFile.mockReset();
    mockFsStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockFsLstat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const { binding } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises
    });
    expect(await svc._resolveVadModelPath()).toBeNull();
    expect(mockFsCopyFile).not.toHaveBeenCalled();
  });

  test('returns the resolved path when the model file exists', async () => {
    mockFsStat.mockResolvedValue({ isFile: () => true });
    const { binding } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises
    });
    const resolved = await svc._resolveModelPath();
    expect(resolved).toBe(
      path.join('/mock/userData/models', WHISPER_SUBDIR, DEFAULT_MODEL_FILENAME)
    );
  });

  test('honours a modelFilename override', async () => {
    mockFsStat.mockResolvedValue({ isFile: () => true });
    const { binding } = makeFakeBinding();
    const svc = new WhisperService({
      modelFilename: 'ggml-small.en-q5_1.bin',
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises
    });
    const resolved = await svc._resolveModelPath();
    expect(resolved.endsWith(path.join(WHISPER_SUBDIR, 'ggml-small.en-q5_1.bin'))).toBe(true);
  });
});

describe('WhisperService — lazy load and transcription', () => {
  beforeEach(() => {
    mockFsStat.mockReset();
    mockFsMkdir.mockReset();
  });

  test('initWhisper is called once across concurrent transcriptions', async () => {
    mockFsStat.mockResolvedValue({ isFile: () => true });
    const { binding, handles, transcribeData } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor({ type: 'metal', vramMB: 16384 }),
      fsPromisesOverride: fakeFsPromises,
      transcoderOverride: {
        transcodeToWhisperPcm: jest.fn(async () => ({
          pcm: Buffer.alloc(32000), // 1 second of silence
          sampleRate: 16000,
          channels: 1,
          durationSeconds: 1.0
        }))
      }
    });

    const p1 = svc.transcribeMedia('/mock/a.mp3');
    const p2 = svc.transcribeMedia('/mock/b.mp3');

    // The transcribe mutex serializes against the shared whisper.cpp
    // context, so the second native handle does NOT spawn until the
    // first resolves. Drain the queue one at a time.
    await new Promise((r) => setImmediate(r));
    expect(handles).toHaveLength(1);
    handles[0]._resolve({ result: 'text-0', segments: [] });
    await new Promise((r) => setImmediate(r));
    expect(handles).toHaveLength(2);
    handles[1]._resolve({ result: 'text-1', segments: [] });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.text).toBe('text-0');
    expect(r2.text).toBe('text-1');
    expect(binding.initWhisper).toHaveBeenCalledTimes(1);
    expect(transcribeData).toHaveBeenCalledTimes(2);
    // initWhisper signature is `(options, variant?)`. The mocked GPU is
    // `{ type: 'metal' }` (macOS default package handles Metal), so the
    // variant arg correctly resolves to `undefined` while useGpu stays true.
    expect(binding.initWhisper).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: expect.stringMatching(/\.bin$/),
        useGpu: true
      }),
      undefined
    );
  });

  test('a file with no audio stream yields an empty transcript instead of a failure', async () => {
    mockFsStat.mockResolvedValue({ size: 100, mtimeMs: 1, isFile: () => true });
    const { binding, transcribeData } = makeFakeBinding();
    const noAudio = Object.assign(new Error('No audio stream to transcribe in silent.mp4'), {
      code: ERROR_CODES.MEDIA_NO_AUDIO_STREAM
    });
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      transcoderOverride: { transcodeToWhisperPcm: jest.fn(async () => Promise.reject(noAudio)) }
    });

    const result = await svc.transcribeMedia('/mock/silent.mp4');

    expect(result).toMatchObject({
      text: '',
      segments: [],
      durationSeconds: 0,
      noAudioStream: true,
      cached: false
    });
    expect(transcribeData).not.toHaveBeenCalled();
  });

  test('any other transcoder failure still propagates', async () => {
    mockFsStat.mockResolvedValue({ size: 100, mtimeMs: 1, isFile: () => true });
    const { binding } = makeFakeBinding();
    const broken = Object.assign(new Error('ffmpeg failed (exit=1): moov atom not found'), {
      code: ERROR_CODES.ANALYSIS_FAILED
    });
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      transcoderOverride: { transcodeToWhisperPcm: jest.fn(async () => Promise.reject(broken)) }
    });

    await expect(svc.transcribeMedia('/mock/broken.mp4')).rejects.toMatchObject({
      code: ERROR_CODES.ANALYSIS_FAILED
    });
  });

  test('two concurrent transcribeMedia calls for the same file share one transcode', async () => {
    // Cache-miss dedup: without the _pendingTranscriptions Map, both
    // callers would race past the cache check (both miss), kick off
    // independent transcoder + binding.transcribeData passes, and double
    // the model VRAM pressure. Verifies the second arrival joins the
    // first's in-flight Promise instead.
    mockFsStat.mockResolvedValue({ size: 100, mtimeMs: 1, isFile: () => true });
    const { binding, handles, transcribeData } = makeFakeBinding();
    const transcoder = jest.fn(async () => ({
      pcm: Buffer.alloc(32000),
      sampleRate: 16000,
      channels: 1,
      durationSeconds: 1
    }));
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      transcoderOverride: { transcodeToWhisperPcm: transcoder }
    });
    const a = svc.transcribeMedia('/mock/race.mp3');
    const b = svc.transcribeMedia('/mock/race.mp3');
    await new Promise((r) => setImmediate(r));
    // Only one in-flight whisper handle was opened despite two callers.
    expect(handles).toHaveLength(1);
    handles[0]._resolve({ result: 'shared', segments: [] });
    const [r1, r2] = await Promise.all([a, b]);
    // Transcoder + binding each called exactly once.
    expect(transcoder).toHaveBeenCalledTimes(1);
    expect(transcribeData).toHaveBeenCalledTimes(1);
    // Both callers got the same transcript text. The first caller sees
    // cached:false (it did the work), the second sees cached:true (it
    // joined). Either is acceptable; what matters is identical content.
    expect(r1.text).toBe('shared');
    expect(r2.text).toBe('shared');
  });

  test('useCache:false bypasses the dedup join (forced re-analysis must do its own pass)', async () => {
    // A user-forced re-analysis (bypassCache=true upstream → useCache=false
    // here) must NOT join an in-flight call: that would silently return
    // a result already populated by the prior caller. Force two
    // independent transcode calls.
    mockFsStat.mockResolvedValue({ size: 100, mtimeMs: 1, isFile: () => true });
    const { binding, handles, transcribeData } = makeFakeBinding();
    const transcoder = jest.fn(async () => ({
      pcm: Buffer.alloc(32000),
      sampleRate: 16000,
      channels: 1,
      durationSeconds: 1
    }));
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      transcoderOverride: { transcodeToWhisperPcm: transcoder }
    });
    const a = svc.transcribeMedia('/mock/force.mp3', { useCache: false });
    const b = svc.transcribeMedia('/mock/force.mp3', { useCache: false });
    // The transcribe mutex serializes against the shared whisper.cpp
    // context. Two independent passes still run (no dedup, useCache:false
    // bypasses the in-flight join) but they run sequentially, not
    // concurrently.
    await new Promise((r) => setImmediate(r));
    expect(handles).toHaveLength(1);
    handles[0]._resolve({ result: 'pass-1', segments: [] });
    await new Promise((r) => setImmediate(r));
    expect(handles).toHaveLength(2);
    handles[1]._resolve({ result: 'pass-2', segments: [] });
    await Promise.all([a, b]);
    expect(transcoder).toHaveBeenCalledTimes(2);
    expect(transcribeData).toHaveBeenCalledTimes(2);
  });

  test('cache returns identical-input transcription without calling the binding twice', async () => {
    mockFsStat.mockResolvedValue({ size: 100, mtimeMs: 1, isFile: () => true });
    const { binding, handles, transcribeData } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      transcoderOverride: {
        transcodeToWhisperPcm: jest.fn(async () => ({
          pcm: Buffer.alloc(32000),
          sampleRate: 16000,
          channels: 1,
          durationSeconds: 1.0
        }))
      }
    });

    const first = svc.transcribeMedia('/mock/a.mp3');
    await new Promise((r) => setImmediate(r));
    handles[0]._resolve({
      result: 'hello world',
      segments: [{ t0: 0, t1: 100, text: 'hello world' }]
    });
    const r1 = await first;
    expect(r1.cached).toBe(false);
    expect(r1.text).toBe('hello world');
    expect(r1.segments[0]).toEqual({ start: 0, end: 1, text: 'hello world' });

    const r2 = await svc.transcribeMedia('/mock/a.mp3');
    expect(r2.cached).toBe(true);
    expect(r2.text).toBe('hello world');
    expect(transcribeData).toHaveBeenCalledTimes(1);
  });

  test('serializes different-file transcribeData calls (process-wide mutex)', async () => {
    // whisper.cpp's transcribe context is a single shared native resource.
    // Without the mutex, two different files entering the watcher within
    // ~100 ms would both call context.transcribeData() concurrently and
    // race the binding (output garbling / segfault). The mutex must hold
    // for the FULL lifetime of each native call, so the second handle
    // does not even spawn until the first resolves.
    mockFsStat.mockResolvedValue({ isFile: () => true });
    const { binding, handles, transcribeData } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      transcoderOverride: {
        transcodeToWhisperPcm: jest.fn(async () => ({
          pcm: Buffer.alloc(32000),
          sampleRate: 16000,
          channels: 1,
          durationSeconds: 1.0
        }))
      }
    });

    const a = svc.transcribeMedia('/mock/file-a.mp3');
    const b = svc.transcribeMedia('/mock/file-b.mp3');

    // Tick once: only ONE native handle exists despite two callers
    // (mutex is held by file-a).
    await new Promise((r) => setImmediate(r));
    expect(handles).toHaveLength(1);
    expect(transcribeData).toHaveBeenCalledTimes(1);

    // Resolving handle 0 releases the lock; then file-b's handle spawns.
    handles[0]._resolve({ result: 'A', segments: [] });
    await new Promise((r) => setImmediate(r));
    expect(handles).toHaveLength(2);
    expect(transcribeData).toHaveBeenCalledTimes(2);

    handles[1]._resolve({ result: 'B', segments: [] });
    const [r1, r2] = await Promise.all([a, b]);
    expect(r1.text).toBe('A');
    expect(r2.text).toBe('B');
  });

  test('mutex is process-wide: serializes across DIFFERENT WhisperService instances', async () => {
    // The chain lives at module scope, not on `this`, so even if the
    // codebase ever produces a second WhisperService (future refactor,
    // a test that forgets to use the singleton, etc.) both instances
    // still serialize against the single shared whisper.cpp native
    // context. Without module-scope, two instances would each have
    // their own `_transcribeChain` and race the binding.
    mockFsStat.mockResolvedValue({ isFile: () => true });
    const a = makeFakeBinding();
    const b = makeFakeBinding();
    const transcoder = jest.fn(async () => ({
      pcm: Buffer.alloc(32000),
      sampleRate: 16000,
      channels: 1,
      durationSeconds: 1
    }));
    const svcA = new WhisperService({
      bindingOverride: a.binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      transcoderOverride: { transcodeToWhisperPcm: transcoder }
    });
    const svcB = new WhisperService({
      bindingOverride: b.binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      transcoderOverride: { transcodeToWhisperPcm: transcoder }
    });

    const p1 = svcA.transcribeMedia('/mock/from-a.mp3');
    const p2 = svcB.transcribeMedia('/mock/from-b.mp3');

    await new Promise((r) => setImmediate(r));
    // Only the FIRST instance's binding has spawned a handle — the
    // second instance is queued behind the module-scope mutex.
    expect(a.handles).toHaveLength(1);
    expect(b.handles).toHaveLength(0);

    a.handles[0]._resolve({ result: 'A', segments: [] });
    await new Promise((r) => setImmediate(r));
    expect(b.handles).toHaveLength(1);
    b.handles[0]._resolve({ result: 'B', segments: [] });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.text).toBe('A');
    expect(r2.text).toBe('B');
  });

  test('mutex releases after a transcribeData rejection (next caller proceeds)', async () => {
    // If a transcribe call throws (binding error, model fault) the lock
    // chain MUST still advance — otherwise one bad file would deadlock
    // the whole service for the rest of the session.
    mockFsStat.mockResolvedValue({ isFile: () => true });
    const { binding, handles } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      transcoderOverride: {
        transcodeToWhisperPcm: jest.fn(async () => ({
          pcm: Buffer.alloc(32000),
          sampleRate: 16000,
          channels: 1,
          durationSeconds: 1.0
        }))
      }
    });

    const failing = svc.transcribeMedia('/mock/bad.mp3').catch((err) => err);
    const recovering = svc.transcribeMedia('/mock/good.mp3');

    await new Promise((r) => setImmediate(r));
    expect(handles).toHaveLength(1);
    handles[0]._reject(new Error('binding boom'));

    const captured = await failing;
    expect(captured).toBeInstanceOf(Error);

    await new Promise((r) => setImmediate(r));
    // Lock released — second caller's native handle now exists.
    expect(handles).toHaveLength(2);
    handles[1]._resolve({ result: 'recovered', segments: [] });
    const r2 = await recovering;
    expect(r2.text).toBe('recovered');
  });

  test('chunks long audio (>1h) into multiple transcribeData passes', async () => {
    // PCM longer than LONG_AUDIO_THRESHOLD_SECONDS (1h) is sliced into
    // ~10-min passes so a single transcribeData() call doesn't try to
    // hold the whole KV cache for a 4-hour buffer in memory. We assert
    // that (1) more than one binding call happens, (2) per-segment
    // timestamps are rebased to the global timeline, and (3) the merged
    // text concatenates each chunk's contribution.
    mockFsStat.mockResolvedValue({ isFile: () => true });
    const { binding, handles, transcribeData } = makeFakeBinding();

    // 2-hour PCM. 16000 Hz * 2 bytes * 7200 s = 230_400_000 bytes.
    // Allocate a small buffer the same length so .subarray slicing
    // produces non-empty chunks. Use Buffer.alloc with the real length.
    const SAMPLE_RATE = 16000;
    const BYTES_PER_SAMPLE = 2;
    const TOTAL_SECONDS = 7200; // 2h
    const totalBytes = SAMPLE_RATE * BYTES_PER_SAMPLE * TOTAL_SECONDS;
    const longPcm = Buffer.alloc(totalBytes);

    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises
    });

    // Drive the chunk loop. Resolve each handle as it appears so the
    // serial-mutex chain advances. Each chunk reports a single segment
    // ranging 0..chunkSeconds with chunk-local text "chunk N".
    const drainPromise = (async () => {
      let chunkIdx = 0;
      // Cap iterations defensively so a bug can't run forever.
      while (chunkIdx < 50) {
        await new Promise((r) => setImmediate(r));
        const next = handles[chunkIdx];
        if (!next) break;
        next._resolve({
          result: `chunk ${chunkIdx}`,
          segments: [{ t0: 0, t1: 100 * 60, text: `chunk ${chunkIdx}` }] // 0..600s span
        });
        chunkIdx += 1;
      }
    })();

    const result = await svc._transcribePcm(longPcm);
    await drainPromise;

    // Threshold 3600s with 600s chunk size and 1s overlap — first chunk
    // covers [0, 601), next [600, 1201), … total chunks for 7200s ≈ 12.
    expect(transcribeData.mock.calls.length).toBeGreaterThan(1);
    // Each segment's `start` is rebased into the global timeline so they
    // span the full 0..TOTAL_SECONDS range.
    expect(result.segments[0].start).toBe(0);
    expect(result.segments[result.segments.length - 1].start).toBeGreaterThan(3600);
    // Concatenated text contains contributions from at least two chunks.
    expect(result.text).toMatch(/chunk 0/);
    expect(result.text).toMatch(/chunk 1/);
  }, 15000);

  test('rejects empty PCM with INVALID_INPUT', async () => {
    mockFsStat.mockResolvedValue({ isFile: () => true });
    const { binding } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises
    });
    await expect(svc._transcribePcm(Buffer.alloc(0))).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT
    });
  });

  test('rejects odd-length PCM (not s16le aligned)', async () => {
    mockFsStat.mockResolvedValue({ isFile: () => true });
    const { binding } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises
    });
    await expect(svc._transcribePcm(Buffer.alloc(7))).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT
    });
  });

  test('shutdown stops in-flight transcriptions and clears cache', async () => {
    mockFsStat.mockResolvedValue({ size: 1, mtimeMs: 1, isFile: () => true });
    const { binding, handles } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      transcoderOverride: {
        transcodeToWhisperPcm: jest.fn(async () => ({
          pcm: Buffer.alloc(32000),
          sampleRate: 16000,
          channels: 1,
          durationSeconds: 1.0
        }))
      }
    });
    const inflight = svc.transcribeMedia('/mock/long.wav');
    await new Promise((r) => setImmediate(r));
    expect(svc.getStatus().activeTranscriptions).toBe(1);

    await svc.shutdown();
    // The fake handle's stop() rejects the promise; the service translates
    // that into ANALYSIS_FAILED on the caller side.
    await expect(inflight).rejects.toBeDefined();
    expect(handles[0].stop).toHaveBeenCalled();
    expect(svc.getStatus().loaded).toBe(false);
  });

  test('rejects further transcriptions after shutdown', async () => {
    const { binding } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises
    });
    await svc.shutdown();
    await expect(svc.transcribeMedia('/mock/a.mp3')).rejects.toMatchObject({
      code: ERROR_CODES.SERVICE_UNAVAILABLE
    });
  });

  test('shutdown during an in-flight load releases the freshly built context instead of leaking it', async () => {
    // Regression (P0-2): _ensureLoaded checked _isShuttingDown only at entry,
    // then awaited model resolve / GPU detect / initWhisper before caching the
    // handle. If shutdown() ran during that window it read _context === null,
    // skipped release(), and set it null — the in-flight load then cached a
    // live native whisper.cpp handle nothing ever frees (VRAM/RAM leak).
    mockFsStat.mockResolvedValue({ isFile: () => true });
    const release = jest.fn(async () => {});
    let resolveInit;
    let signalInitCalled;
    const initCalled = new Promise((r) => (signalInitCalled = r));
    const initWhisper = jest.fn(() => {
      signalInitCalled();
      return new Promise((resolve) => {
        resolveInit = () =>
          resolve({ transcribeData: jest.fn(), transcribeFile: jest.fn(), release });
      });
    });
    const svc = new WhisperService({
      bindingOverride: { initWhisper },
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises
    });

    const loadResult = svc._ensureLoaded().catch((e) => e);
    // Park the load at the pending initWhisper (past the entry shutdown check)
    // so shutdown() genuinely races an in-flight load rather than a no-op.
    await initCalled;

    await svc.shutdown();
    resolveInit();

    const result = await loadResult;
    expect(result).toBeInstanceOf(Error);
    expect(result.code).toBe(ERROR_CODES.SERVICE_UNAVAILABLE);
    // The freshly constructed handle must be released exactly once, not leaked.
    expect(release).toHaveBeenCalledTimes(1);
    expect(svc._context).toBeNull();
  });

  test('evict during an in-flight load releases the built context instead of returning a freed handle', async () => {
    // evict() (the memory-manager dispose path) deliberately does NOT set
    // _isShuttingDown — it stays reloadable — so the shutdown-only guard didn't
    // cover it. An evict during the load window released the previous handle and
    // nulled _context, then the in-flight load cached AND returned the just-built
    // context: a use-after-free for the transcribe caller plus a dangling memory
    // registration. The _loadGeneration guard makes the in-flight load
    // release-and-bail instead.
    mockFsStat.mockResolvedValue({ isFile: () => true });
    const release = jest.fn(async () => {});
    let resolveInit;
    let signalInitCalled;
    const initCalled = new Promise((r) => (signalInitCalled = r));
    const initWhisper = jest.fn(() => {
      signalInitCalled();
      return new Promise((resolve) => {
        resolveInit = () =>
          resolve({ transcribeData: jest.fn(), transcribeFile: jest.fn(), release });
      });
    });
    const svc = new WhisperService({
      bindingOverride: { initWhisper },
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises
    });

    const loadResult = svc._ensureLoaded().catch((e) => e);
    // Park at the pending initWhisper (past the entry guard) so evict() races a
    // genuinely in-flight load.
    await initCalled;

    await svc.evict();
    resolveInit();

    const result = await loadResult;
    expect(result).toBeInstanceOf(Error);
    expect(result.code).toBe(ERROR_CODES.SERVICE_UNAVAILABLE);
    // The freshly built handle is released, never cached or returned.
    expect(release).toHaveBeenCalledTimes(1);
    expect(svc._context).toBeNull();
    // evict() leaves the service reloadable — not shutting down.
    expect(svc._isShuttingDown).toBe(false);
  });

  test('a normal load with no concurrent teardown still caches the context', async () => {
    // Control: the generation guard must not interfere with a healthy load.
    mockFsStat.mockResolvedValue({ isFile: () => true });
    const release = jest.fn(async () => {});
    const initWhisper = jest.fn(async () => ({
      transcribeData: jest.fn(),
      transcribeFile: jest.fn(),
      release
    }));
    const svc = new WhisperService({
      bindingOverride: { initWhisper },
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises
    });

    const ctx = await svc._ensureLoaded();

    expect(ctx).toBeDefined();
    expect(svc._context).toBe(ctx);
    expect(release).not.toHaveBeenCalled();
  });
});

describe('WhisperService — isAvailable', () => {
  beforeEach(() => {
    mockFsStat.mockReset();
    mockFsMkdir.mockReset();
  });

  test('returns false when model file is missing', async () => {
    mockFsStat.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const { binding } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises
    });
    expect(await svc.isAvailable()).toBe(false);
  });

  test('returns true when model and binding are present', async () => {
    mockFsStat.mockResolvedValue({ isFile: () => true });
    const { binding } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises
    });
    expect(await svc.isAvailable()).toBe(true);
  });
});

function fakeMemoryManager() {
  // Track active refs so tests can assert that mid-transcription eviction
  // would be blocked. Mirrors the real ModelMemoryManager._activeRefs Map
  // semantics — non-zero count protects the consumer from eviction.
  const activeRefs = new Map();
  return {
    registerExternalConsumer: jest.fn(({ dispose }) => {
      // Capture the dispose callback so a test can simulate eviction.
      fakeMemoryManager._lastDispose = dispose;
      return true;
    }),
    unregisterExternalConsumer: jest.fn(() => true),
    acquireRef: jest.fn((type) => {
      activeRefs.set(type, (activeRefs.get(type) || 0) + 1);
    }),
    releaseRef: jest.fn((type) => {
      const current = activeRefs.get(type) || 0;
      if (current <= 1) activeRefs.delete(type);
      else activeRefs.set(type, current - 1);
    }),
    _activeRefsForTest: activeRefs
  };
}

/**
 * Builds a binding that exposes both `initWhisper` and `initWhisperVad`. The
 * VAD context returns the `segments` configured by the test so we can drive
 * different timeline shapes (single segment, multiple segments, empty).
 */
function makeVadCapableBinding({ vadSegments = [], vadDetectImpl } = {}) {
  const transcribeData = jest.fn((pcm, _opts) => {
    // Production now passes ArrayBuffer (whisper.node binding contract);
    // ArrayBuffer has .byteLength, not .length. Use byteLength so the mock
    // works regardless of whether a test happens to pass a Buffer directly.
    const byteLength = pcm.byteLength;
    const sampleCount = byteLength / 2;
    const durationSec = sampleCount / 16000;
    return {
      promise: Promise.resolve({
        result: `bytes=${byteLength}`,
        segments: [{ t0: 0, t1: Math.round(durationSec * 100), text: `bytes=${byteLength}` }]
      }),
      stop: jest.fn()
    };
  });
  const initWhisper = jest.fn(async (options) => {
    if (typeof options?.filePath !== 'string' || !options.filePath) {
      throw new Error('Mock initWhisper: NativeContextOptions.filePath is required');
    }
    return {
      transcribeData,
      transcribeFile: jest.fn(),
      release: jest.fn()
    };
  });
  const detect =
    vadDetectImpl ||
    jest.fn(async () => ({
      segments: vadSegments
    }));
  const initWhisperVad = jest.fn(async (options) => {
    if (typeof options?.filePath !== 'string' || !options.filePath) {
      throw new Error('Mock initWhisperVad: NativeVadContextOptions.filePath is required');
    }
    return {
      detectSpeechData: detect,
      release: jest.fn()
    };
  });
  return { binding: { initWhisper, initWhisperVad }, transcribeData, detect };
}

describe('WhisperService — ModelMemoryManager coordination', () => {
  beforeEach(() => {
    mockFsStat.mockReset();
    mockFsMkdir.mockReset();
  });

  test('registers with the memory manager after the model loads', async () => {
    mockFsStat
      .mockResolvedValueOnce({ isFile: () => true })
      .mockResolvedValueOnce({ size: 150 * 1024 * 1024, isFile: () => true });
    const memory = fakeMemoryManager();
    const { binding } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor({ type: 'metal', vramMB: 16384 }),
      fsPromisesOverride: fakeFsPromises,
      memoryManagerOverride: memory
    });
    await svc._ensureLoaded();
    expect(memory.registerExternalConsumer).toHaveBeenCalledTimes(1);
    const arg = memory.registerExternalConsumer.mock.calls[0][0];
    expect(arg.type).toBe('audio');
    expect(arg.sizeBytes).toBe(Math.ceil(150 * 1024 * 1024 * 1.3));
    expect(typeof arg.dispose).toBe('function');
    expect(arg.label).toContain('whisper:');
  });

  test('uses memoryEstimateBytes override when supplied', async () => {
    mockFsStat.mockResolvedValue({ isFile: () => true });
    const memory = fakeMemoryManager();
    const { binding } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      memoryManagerOverride: memory,
      memoryEstimateBytes: 333 * 1024 * 1024
    });
    await svc._ensureLoaded();
    expect(memory.registerExternalConsumer.mock.calls[0][0].sizeBytes).toBe(333 * 1024 * 1024);
  });

  test('shutdown unregisters the consumer slot', async () => {
    mockFsStat.mockResolvedValue({ isFile: () => true, size: 150 * 1024 * 1024 });
    const memory = fakeMemoryManager();
    const { binding } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      memoryManagerOverride: memory
    });
    await svc._ensureLoaded();
    await svc.shutdown();
    expect(memory.unregisterExternalConsumer).toHaveBeenCalledWith('audio');
  });

  test('eviction via dispose callback tears down the service', async () => {
    mockFsStat.mockResolvedValue({ isFile: () => true, size: 150 * 1024 * 1024 });
    const memory = fakeMemoryManager();
    const { binding } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      memoryManagerOverride: memory
    });
    await svc._ensureLoaded();
    expect(svc.getStatus().loaded).toBe(true);
    await fakeMemoryManager._lastDispose();
    expect(svc.getStatus().loaded).toBe(false);
    expect(memory.unregisterExternalConsumer).not.toHaveBeenCalled();
  });

  test('eviction leaves the service reloadable (P0: media section survives vision batch mode)', async () => {
    // Regression (P0): BatchAnalysisService runs documents → images → media.
    // The images section calls LlamaService.enterVisionBatchMode(), which frees
    // VRAM via ModelMemoryManager.unloadModel('audio') — invoking whisper's
    // dispose callback. That path used to call shutdown(), latching
    // _isShuttingDown permanently, so every media-section transcribeMedia()
    // afterwards failed with "WhisperService is shutting down". Eviction must
    // release the native context but keep the service reloadable.
    mockFsStat.mockResolvedValue({ isFile: () => true, size: 150 * 1024 * 1024 });
    const memory = fakeMemoryManager();
    const { binding } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      memoryManagerOverride: memory
    });

    await svc._ensureLoaded();
    expect(svc.getStatus().loaded).toBe(true);

    // Simulate the memory manager evicting the 'audio' consumer mid-batch.
    await fakeMemoryManager._lastDispose();
    expect(svc.getStatus().loaded).toBe(false);
    // The key invariant: eviction is NOT a terminal shutdown.
    expect(svc._isShuttingDown).toBe(false);

    // The media section can now reload whisper instead of erroring forever,
    // and the reload re-registers with the shared memory coordinator.
    await expect(svc._ensureLoaded()).resolves.toBeDefined();
    expect(svc.getStatus().loaded).toBe(true);
    expect(memory.registerExternalConsumer).toHaveBeenCalledTimes(2);
  });

  test('transcription re-validates the context after taking its memory ref — an evict in the zero-ref window reloads instead of using a freed handle [F-153]', async () => {
    mockFsStat.mockResolvedValue({ isFile: () => true, size: 150 * 1024 * 1024 });
    const memory = fakeMemoryManager();
    const { binding, handles, transcribeData } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      memoryManagerOverride: memory
    });

    // Fire the evict AFTER the load resolves but BEFORE the caller resumes —
    // the exact microtask window in which zero refs are held and a real
    // enterVisionBatchMode()/LRU unload disposes immediately.
    const origEnsure = svc._ensureLoaded.bind(svc);
    let evictedOnce = false;
    jest.spyOn(svc, '_ensureLoaded').mockImplementation(async () => {
      const ctx = await origEnsure();
      if (!evictedOnce) {
        evictedOnce = true;
        await fakeMemoryManager._lastDispose();
      }
      return ctx;
    });

    const resultPromise = svc._transcribePcmRaw(Buffer.alloc(3200), { language: 'en' });
    // Pre-fix the stale (freed) context got the native call; post-fix the
    // re-validation reloads first, so exactly one call lands on the LIVE
    // second context.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(handles).toHaveLength(1);
    handles[0]._resolve({ result: 'recovered', segments: [] });

    const result = await resultPromise;
    expect(result.text).toBe('recovered');
    expect(transcribeData).toHaveBeenCalledTimes(1);
    // The service loaded twice: initial capture + the post-evict reload.
    expect(binding.initWhisper).toHaveBeenCalledTimes(2);
    expect(svc.getStatus().loaded).toBe(true);
  });

  test('_runVad bails with a structured error when the captured VAD context was evicted before the ref was taken [F-153]', async () => {
    mockFsStat.mockResolvedValue({ isFile: () => true, size: 150 * 1024 * 1024 });
    const memory = fakeMemoryManager();
    const { binding } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      memoryManagerOverride: memory
    });

    // The caller captured this vad long before _runVad took its memory ref;
    // an evict in between freed it (service now holds a different/absent
    // context). detect() on the stale handle would be a native UAF.
    const staleVad = { detect: jest.fn() };
    svc._vadContext = null;

    await expect(svc._runVad(Buffer.alloc(3200), staleVad, undefined)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE'
    });
    expect(staleVad.detect).not.toHaveBeenCalled();
  });

  test('shutdown stays terminal (no reload after app teardown)', async () => {
    // Companion to the eviction test above: the terminal path must remain
    // one-way so app teardown never resurrects the model.
    mockFsStat.mockResolvedValue({ isFile: () => true, size: 150 * 1024 * 1024 });
    const memory = fakeMemoryManager();
    const { binding } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      memoryManagerOverride: memory
    });

    await svc._ensureLoaded();
    await svc.shutdown();
    expect(svc._isShuttingDown).toBe(true);
    await expect(svc._ensureLoaded()).rejects.toMatchObject({
      code: ERROR_CODES.SERVICE_UNAVAILABLE
    });
  });

  test('no memory manager available → load proceeds without registration', async () => {
    mockFsStat.mockResolvedValue({ isFile: () => true });
    const { binding } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      memoryManagerOverride: null
    });
    await expect(svc._ensureLoaded()).resolves.toBeDefined();
    expect(svc.getStatus().loaded).toBe(true);
  });

  test('transcribe holds a memory ref across the native call window', async () => {
    mockFsStat.mockResolvedValue({ isFile: () => true, size: 150 * 1024 * 1024 });
    const memory = fakeMemoryManager();
    // Use a deferred handle so we can observe the ref state mid-flight.
    let resolveTranscribe;
    const transcribeData = jest.fn(() => ({
      promise: new Promise((resolve) => {
        resolveTranscribe = resolve;
      }),
      stop: jest.fn()
    }));
    const initWhisper = jest.fn(async () => ({ transcribeData, release: jest.fn() }));
    const binding = { initWhisper };
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      memoryManagerOverride: memory
    });

    const pcm = Buffer.alloc(16000 * 2 * 2); // 2 seconds of 16-bit mono PCM @ 16kHz
    const transcribePromise = svc._transcribePcmRaw(pcm);

    // Drain microtasks so the native handle has been allocated AND the ref acquired.
    await new Promise((resolve) => setImmediate(resolve));

    expect(memory.acquireRef).toHaveBeenCalledWith('audio');
    expect(memory._activeRefsForTest.get('audio')).toBe(1);
    expect(memory.releaseRef).not.toHaveBeenCalled();

    resolveTranscribe({ text: 'hello' });
    await transcribePromise;

    expect(memory.releaseRef).toHaveBeenCalledWith('audio');
    expect(memory._activeRefsForTest.has('audio')).toBe(false);
  });

  test('transcribe releases the memory ref when the native call throws', async () => {
    mockFsStat.mockResolvedValue({ isFile: () => true, size: 150 * 1024 * 1024 });
    const memory = fakeMemoryManager();
    const transcribeData = jest.fn(() => ({
      promise: Promise.reject(new Error('whisper exploded')),
      stop: jest.fn()
    }));
    const initWhisper = jest.fn(async () => ({ transcribeData, release: jest.fn() }));
    const binding = { initWhisper };
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      memoryManagerOverride: memory
    });

    const pcm = Buffer.alloc(16000 * 2 * 2);
    await expect(svc._transcribePcmRaw(pcm)).rejects.toThrow();
    expect(memory.releaseRef).toHaveBeenCalledWith('audio');
    expect(memory._activeRefsForTest.has('audio')).toBe(false);
  });
});

describe('WhisperService — VAD preprocessing', () => {
  beforeEach(() => {
    mockFsStat.mockReset();
    mockFsMkdir.mockReset();
  });

  test('VAD path slices PCM by detected speech segments and merges timestamps', async () => {
    mockFsStat.mockResolvedValue({ isFile: () => true });
    const vadSegments = [
      { start: 1.0, end: 2.0 },
      { start: 5.0, end: 7.0 }
    ];
    const { binding, transcribeData, detect } = makeVadCapableBinding({ vadSegments });
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      enableVad: true
    });
    const pcm = Buffer.alloc(10 * 16000 * 2);
    const result = await svc._transcribePcm(pcm, { language: 'en' });
    expect(detect).toHaveBeenCalledTimes(1);
    expect(transcribeData).toHaveBeenCalledTimes(2);
    // pcmToArrayBuffer materializes a fresh ArrayBuffer for every call
    // (whisper.node binding requires ArrayBuffer, not Node Buffer); assert
    // on .byteLength which exists on both Buffer and ArrayBuffer.
    const callPcmLengths = transcribeData.mock.calls.map((c) => c[0].byteLength);
    expect(callPcmLengths.sort((a, b) => a - b)).toEqual([32000, 64000]);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].start).toBeCloseTo(1.0, 5);
    expect(result.segments[0].end).toBeCloseTo(2.0, 5);
    expect(result.segments[1].start).toBeCloseTo(5.0, 5);
    expect(result.segments[1].end).toBeCloseTo(7.0, 5);
  });

  test('falls back to full-pcm transcription when VAD reports no speech', async () => {
    mockFsStat.mockResolvedValue({ isFile: () => true });
    const { binding, transcribeData } = makeVadCapableBinding({ vadSegments: [] });
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      enableVad: true
    });
    const pcm = Buffer.alloc(2 * 16000 * 2);
    const result = await svc._transcribePcm(pcm);
    expect(transcribeData).toHaveBeenCalledTimes(1);
    // Now passing ArrayBuffer (binding contract); .byteLength is the
    // cross-type-safe size accessor.
    expect(transcribeData.mock.calls[0][0].byteLength).toBe(pcm.length);
    expect(typeof result.text).toBe('string');
  });

  test('VAD failure is non-fatal — falls back to plain transcription', async () => {
    mockFsStat.mockResolvedValue({ isFile: () => true });
    const detect = jest.fn(async () => {
      throw new Error('vad oom');
    });
    const { binding, transcribeData } = makeVadCapableBinding({ vadDetectImpl: detect });
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      enableVad: true
    });
    const pcm = Buffer.alloc(16000 * 2);
    const result = await svc._transcribePcm(pcm);
    expect(detect).toHaveBeenCalled();
    expect(transcribeData).toHaveBeenCalledTimes(1);
    expect(result.text).toContain('bytes=');
  });

  test('VAD detect is serialized by the module-scope mutex (concurrent VAD runs do not race the binding)', async () => {
    // vad.detectSpeechData() shares the same single-shared-context
    // hazard as transcribeData. Two files entering the VAD-enabled
    // path simultaneously must serialize — without the mutex the
    // binding would be invoked twice in parallel against one native
    // VAD context.
    mockFsStat.mockResolvedValue({ isFile: () => true });
    let detectStartCount = 0;
    const detectGate = [];
    const detect = jest.fn(
      () =>
        new Promise((resolve) => {
          detectStartCount += 1;
          detectGate.push(() => resolve({ segments: [] }));
        })
    );
    const { binding } = makeVadCapableBinding({ vadDetectImpl: detect });
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      enableVad: true
    });

    const a = svc._transcribePcm(Buffer.alloc(2 * 16000 * 2));
    const b = svc._transcribePcm(Buffer.alloc(2 * 16000 * 2));

    await new Promise((r) => setImmediate(r));
    // Only the first VAD call has started — the second is queued
    // behind the module-scope mutex.
    expect(detectStartCount).toBe(1);
    detectGate[0]();
    await new Promise((r) => setImmediate(r));
    expect(detectStartCount).toBe(2);
    detectGate[1]();
    await Promise.all([a, b]);
  });

  test('VAD path chunks any single segment longer than the long-audio threshold', async () => {
    // Defensive guard: if VAD ever returns one massive talking-head
    // segment longer than LONG_AUDIO_THRESHOLD_SECONDS (1h), feeding
    // the entire slice to a single transcribeData() call would
    // re-introduce the OOM risk the chunking commit guards against.
    // Verify the per-segment loop routes long slices through the
    // chunked path.
    mockFsStat.mockResolvedValue({ isFile: () => true });
    // 2-hour PCM with a single 2-hour VAD segment.
    const TWO_HOURS = 7200;
    const pcm = Buffer.alloc(TWO_HOURS * 16000 * 2);
    const { binding, transcribeData } = makeVadCapableBinding({
      vadSegments: [{ start: 0, end: TWO_HOURS }]
    });
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      enableVad: true
    });

    await svc._transcribePcm(pcm);
    // Without the chunking guard there'd be 1 transcribe call (the
    // full 2-hour slice). With it, ceil(7200 / 600) ≈ 12 calls.
    expect(transcribeData.mock.calls.length).toBeGreaterThan(1);
  }, 15000);

  test('VAD model missing → load returns null and disables VAD permanently', async () => {
    mockFsStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const { binding } = makeVadCapableBinding({ vadSegments: [{ start: 0, end: 1 }] });
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      enableVad: true
    });
    const ctx = await svc._ensureVadLoaded();
    expect(ctx).toBeNull();
    expect(svc.getStatus().vad.disabledReason).toBe('vad-model-missing');
    mockFsStat.mockClear();
    const ctx2 = await svc._ensureVadLoaded();
    expect(ctx2).toBeNull();
    expect(mockFsStat).not.toHaveBeenCalled();
  });

  test('binding without initWhisperVad disables VAD path with a clear reason', async () => {
    mockFsStat.mockResolvedValue({ isFile: () => true });
    const { binding } = makeFakeBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      enableVad: true
    });
    const ctx = await svc._ensureVadLoaded();
    expect(ctx).toBeNull();
    expect(svc.getStatus().vad.disabledReason).toBe('binding-missing-initWhisperVad');
  });

  test('disabled by default — _transcribePcm goes straight to whisper without VAD', async () => {
    mockFsStat.mockResolvedValue({ isFile: () => true });
    const { binding, transcribeData, detect } = makeVadCapableBinding({
      vadSegments: [{ start: 0, end: 1 }]
    });
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises
    });
    const pcm = Buffer.alloc(16000 * 2);
    await svc._transcribePcm(pcm);
    expect(detect).not.toHaveBeenCalled();
    expect(transcribeData).toHaveBeenCalledTimes(1);
    expect(svc.getStatus().vad.enabled).toBe(false);
  });

  test('_slicePcmBySeconds clamps to buffer bounds and returns empty for inverted ranges', () => {
    const { binding } = makeVadCapableBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises
    });
    const pcm = Buffer.alloc(16000 * 2);
    expect(svc._slicePcmBySeconds(pcm, -1, 0.5).length).toBe(16000);
    expect(svc._slicePcmBySeconds(pcm, 0.5, 5).length).toBe(16000);
    expect(svc._slicePcmBySeconds(pcm, 0.7, 0.3).length).toBe(0);
  });

  test('_normalizeVadResult accepts both flat array and {segments} shapes', () => {
    const { binding } = makeVadCapableBinding();
    const svc = new WhisperService({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises
    });
    expect(
      svc._normalizeVadResult([
        { start: 0, end: 1 },
        { t0: 200, t1: 300 }
      ])
    ).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 }
    ]);
    expect(svc._normalizeVadResult({ segments: [{ start: 0.5, end: 1.5 }] })).toEqual([
      { start: 0.5, end: 1.5 }
    ]);
    expect(svc._normalizeVadResult(null)).toEqual([]);
    expect(svc._normalizeVadResult({ segments: [{ start: 1, end: 0 }] })).toEqual([]);
  });
});

// The DegradedStateTracker module is required lazily inside WhisperService so
// the singleton can be replaced for these tests without a top-level mock.
// jest.doMock + jest.resetModules ensures the require() inside transcribeMedia
// resolves to our fake instance.
describe('WhisperService — DegradedStateBanner integration', () => {
  let trackerInstance;
  let svc;

  beforeEach(() => {
    jest.resetModules();
    trackerInstance = { raise: jest.fn(), clear: jest.fn() };
    jest.doMock('../src/main/services/DegradedStateTracker', () => ({
      getInstance: () => trackerInstance
    }));
    mockFsStat.mockReset();
  });

  afterEach(() => {
    jest.dontMock('../src/main/services/DegradedStateTracker');
  });

  test('transcribeMedia raises audio-transcription banner on LLAMA_MODEL_NOT_FOUND', async () => {
    // fsStat rejects so _resolveModelPath surfaces LLAMA_MODEL_NOT_FOUND once
    // _ensureLoaded fires after the transcoder returns valid PCM.
    mockFsStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const { WhisperService: HotWhisper } = require('../src/main/services/WhisperService');
    const { binding } = makeFakeBinding();
    svc = new HotWhisper({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      transcoderOverride: {
        transcodeToWhisperPcm: jest.fn(async () => ({
          pcm: Buffer.alloc(32000),
          sampleRate: 16000,
          channels: 1,
          durationSeconds: 1
        }))
      }
    });
    // useCache: false so we skip _buildCacheKey (which would also hit fsStat)
    // and isolate the model-resolution failure path.
    await expect(svc.transcribeMedia('/mock/clip.mp3', { useCache: false })).rejects.toMatchObject({
      code: ERROR_CODES.LLAMA_MODEL_NOT_FOUND
    });
    expect(trackerInstance.raise).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'whisper.unavailable',
        subsystem: 'audio-transcription',
        severity: 'error'
      })
    );
    // Whisper-side message points at the in-UI install action, not ffmpeg.
    // (Pre-2026-05-10 the message told users to run a CLI command; the
    // banner now exposes an in-process install button instead.)
    expect(trackerInstance.raise.mock.calls[0][0].message).toMatch(/Whisper model is missing/);
    // The action payload is what the DegradedStateBanner uses to render
    // the inline install button — without it, the banner has no CTA and
    // production users have no way to recover.
    expect(trackerInstance.raise.mock.calls[0][0].detail.action).toEqual(
      expect.objectContaining({
        code: 'whisper.install-model',
        label: 'Install model'
      })
    );
  });

  describe('ffmpeg-unavailable banner — platform-specific guidance', () => {
    // Helpers to drive the same failure across all three OS branches.
    // We override process.platform so each branch of `_ffmpegUnavailableMessage`
    // runs on every CI runner, not just whichever OS the test happens to be on.
    const ORIGINAL_PLATFORM = process.platform;
    const setPlatform = (value) =>
      Object.defineProperty(process, 'platform', { value, configurable: true });
    const restorePlatform = () =>
      Object.defineProperty(process, 'platform', {
        value: ORIGINAL_PLATFORM,
        configurable: true
      });

    afterEach(() => {
      restorePlatform();
    });

    async function triggerFfmpegFailure() {
      mockFsStat.mockResolvedValue({ isFile: () => true });
      const { WhisperService: HotWhisper } = require('../src/main/services/WhisperService');
      const { binding } = makeFakeBinding();
      const ffmpegError = Object.assign(new Error('ffmpeg is unavailable (ENOENT): spawn ENOENT'), {
        code: ERROR_CODES.SERVICE_UNAVAILABLE
      });
      svc = new HotWhisper({
        bindingOverride: binding,
        gpuMonitor: fakeGpuMonitor(),
        fsPromisesOverride: fakeFsPromises,
        transcoderOverride: {
          transcodeToWhisperPcm: jest.fn(async () => {
            throw ffmpegError;
          })
        }
      });
      await expect(
        svc.transcribeMedia('/mock/clip.mp4', { useCache: false })
      ).rejects.toMatchObject({ code: ERROR_CODES.SERVICE_UNAVAILABLE });
      expect(trackerInstance.raise).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'whisper.unavailable',
          detail: expect.objectContaining({ ffmpegSide: true })
        })
      );
      // STRATOSORT_FFMPEG_PATH is the universal escape-hatch mentioned on
      // every platform — assert it's present so a platform branch can never
      // ship a message that omits the operator-friendly fallback.
      const message = trackerInstance.raise.mock.calls[0][0].message;
      expect(message).toMatch(/STRATOSORT_FFMPEG_PATH/);
      // The model-installer banner action MUST NOT appear on the ffmpeg
      // branch — there's no in-process ffmpeg installer, so a button would
      // be a dead end.
      expect(trackerInstance.raise.mock.calls[0][0].detail.action).toBeUndefined();
      return message;
    }

    test('Windows message references the dev setup script', async () => {
      setPlatform('win32');
      const message = await triggerFfmpegFailure();
      expect(message).toMatch(/setup:ffmpeg-runtime/);
    });

    test('Linux message references the system package manager (NOT the throwing setup script)', async () => {
      setPlatform('linux');
      const message = await triggerFfmpegFailure();
      // The CLI script throws on Linux ("not yet wired up"); the banner
      // must not point users at that dead end.
      expect(message).not.toMatch(/setup:ffmpeg-runtime/);
      expect(message).toMatch(/apt install ffmpeg|dnf install ffmpeg|package manager/i);
    });

    test('macOS message references Homebrew + reinstall', async () => {
      setPlatform('darwin');
      const message = await triggerFfmpegFailure();
      expect(message).toMatch(/brew install ffmpeg|reinstall/i);
    });
  });

  test('transcribeMedia clears the banner on a successful transcription', async () => {
    mockFsStat.mockResolvedValue({ isFile: () => true });
    const { WhisperService: HotWhisper } = require('../src/main/services/WhisperService');
    const { binding, handles } = makeFakeBinding();
    const transcoder = jest.fn(async () => ({
      pcm: Buffer.alloc(16000 * 2),
      sampleRate: 16000,
      channels: 1,
      durationSeconds: 1
    }));
    svc = new HotWhisper({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      transcoderOverride: { transcodeToWhisperPcm: transcoder }
    });
    const pending = svc.transcribeMedia('/mock/clip.mp3', { useCache: false });
    // Match the existing 'cache returns identical-input transcription' test
    // pattern: a single setImmediate is enough for _ensureLoaded to walk
    // through binding.initWhisper + GPU detection + transcribeData call,
    // at which point handles[0] is populated.
    await new Promise((r) => setImmediate(r));
    handles[0]._resolve({ result: 'hello', segments: [] });
    await pending;
    expect(trackerInstance.clear).toHaveBeenCalledWith('whisper.unavailable');
  });

  test('transient ANALYSIS_FAILED does not raise the banner (per-file, not subsystem-down)', async () => {
    mockFsStat.mockResolvedValue({ isFile: () => true });
    const { WhisperService: HotWhisper } = require('../src/main/services/WhisperService');
    const { binding } = makeFakeBinding();
    const transcoder = jest.fn(async () => {
      throw Object.assign(new Error('per-file decode error'), {
        code: ERROR_CODES.ANALYSIS_FAILED
      });
    });
    svc = new HotWhisper({
      bindingOverride: binding,
      gpuMonitor: fakeGpuMonitor(),
      fsPromisesOverride: fakeFsPromises,
      transcoderOverride: { transcodeToWhisperPcm: transcoder }
    });
    await expect(svc.transcribeMedia('/mock/clip.mp3', { useCache: false })).rejects.toMatchObject({
      code: ERROR_CODES.ANALYSIS_FAILED
    });
    expect(trackerInstance.raise).not.toHaveBeenCalled();
  });
});

describe('WhisperService — _augmentWindowsDllSearchPathForCuda', () => {
  // Strategy: stage the runtime files at the path the REAL VisionService
  // computes from the mocked `app.getPath('userData')` and the live
  // `LLAMA_CPP_RELEASE_TAG`. That way the helper's lazy
  // `require('./VisionService')` works against the real module, no
  // `jest.doMock` (which fights the lazy `require('fs')` + memfs interaction
  // documented at the top of this file).
  let savedPlatformDescriptor;
  let savedPath;
  let runtimeRoot;
  let binDir;

  const {
    _augmentWindowsDllSearchPathForCuda,
    _resetNativeWhisperCacheForTesting
  } = require('../src/main/services/WhisperService');
  const { getRuntimeRoot, LLAMA_CPP_RELEASE_TAG } = require('../src/main/services/VisionService');

  beforeEach(() => {
    const fs = require('fs');
    runtimeRoot = getRuntimeRoot(LLAMA_CPP_RELEASE_TAG);
    binDir = path.join(runtimeRoot, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    savedPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    savedPath = process.env.PATH;
    _resetNativeWhisperCacheForTesting();
  });

  afterEach(() => {
    const fs = require('fs');
    if (savedPlatformDescriptor)
      Object.defineProperty(process, 'platform', savedPlatformDescriptor);
    process.env.PATH = savedPath;
    try {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    _resetNativeWhisperCacheForTesting();
  });

  function writeManifestAndBinary({ withCudartDll }) {
    const fs = require('fs');
    const binaryPath = path.join(binDir, 'llama-server.exe');
    fs.writeFileSync(binaryPath, 'fake binary');
    if (withCudartDll) {
      // The augmentation now requires BOTH `cudart64_12.dll` AND `cublas64_12.dll`
      // (whisper.node depends on both). Staging only one was the false-positive
      // case that caused the augmentation to succeed but whisper.node to still
      // fail at require() time with a cublas-missing error.
      fs.writeFileSync(path.join(binDir, 'cudart64_12.dll'), 'fake dll');
      fs.writeFileSync(path.join(binDir, 'cublas64_12.dll'), 'fake dll');
    }
    fs.writeFileSync(
      path.join(runtimeRoot, 'runtime.json'),
      JSON.stringify({
        tag: LLAMA_CPP_RELEASE_TAG,
        assetName: 'fake.zip',
        binaryPath
      })
    );
  }

  test('no-op on non-win32 platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    writeManifestAndBinary({ withCudartDll: true });
    const before = process.env.PATH;
    const result = _augmentWindowsDllSearchPathForCuda();
    expect(result).toBe(false);
    expect(process.env.PATH).toBe(before);
  });

  test('prepends vision runtime dir to PATH on win32 when CUDA DLLs are staged', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    writeManifestAndBinary({ withCudartDll: true });

    const before = process.env.PATH || '';
    const result = _augmentWindowsDllSearchPathForCuda();
    expect(result).toBe(true);
    expect(process.env.PATH).toBe(`${binDir}${path.delimiter}${before}`);
  });

  test('returns false when cudart64_12.dll is absent (vision runtime is Vulkan/CPU)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    writeManifestAndBinary({ withCudartDll: false });
    const before = process.env.PATH;
    expect(_augmentWindowsDllSearchPathForCuda()).toBe(false);
    expect(process.env.PATH).toBe(before);
  });

  test('returns false when no runtime manifest is staged yet', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    // beforeEach mkdir'd the dir but we never write the manifest.
    const before = process.env.PATH;
    expect(_augmentWindowsDllSearchPathForCuda()).toBe(false);
    expect(process.env.PATH).toBe(before);
  });

  test('is idempotent — second call is a no-op', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    writeManifestAndBinary({ withCudartDll: true });

    expect(_augmentWindowsDllSearchPathForCuda()).toBe(true);
    const afterFirst = process.env.PATH;
    expect(_augmentWindowsDllSearchPathForCuda()).toBe(false);
    expect(process.env.PATH).toBe(afterFirst);
    const occurrences = (process.env.PATH || '').split(path.delimiter).filter((p) => p === binDir);
    expect(occurrences).toHaveLength(1);
  });

  test('returns false when only one of the required CUDA DLLs is present (partial-staging guard)', () => {
    // Regression guard: prior augmentation only checked for `cudart64_12.dll`.
    // A vision-runtime stage that ships `cudart64` but somehow lacks
    // `cublas64_12.dll` would augment PATH successfully, then whisper.node
    // would still fail to require with a cublas-not-found error. The new
    // check requires BOTH DLLs so failed augmentation is a clean signal.
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const fs = require('fs');
    const binaryPath = path.join(binDir, 'llama-server.exe');
    fs.writeFileSync(binaryPath, 'fake binary');
    fs.writeFileSync(path.join(binDir, 'cudart64_12.dll'), 'fake');
    // Deliberately omit cublas64_12.dll.
    fs.writeFileSync(
      path.join(runtimeRoot, 'runtime.json'),
      JSON.stringify({ tag: LLAMA_CPP_RELEASE_TAG, binaryPath })
    );
    const before = process.env.PATH;
    expect(_augmentWindowsDllSearchPathForCuda()).toBe(false);
    expect(process.env.PATH).toBe(before);
  });
});

describe('WhisperService — _detectInstalledCudaVersion', () => {
  const { _detectInstalledCudaVersion } = require('../src/main/services/WhisperService');

  let savedCudaPath;
  beforeEach(() => {
    savedCudaPath = process.env.CUDA_PATH;
  });
  afterEach(() => {
    if (savedCudaPath === undefined) delete process.env.CUDA_PATH;
    else process.env.CUDA_PATH = savedCudaPath;
  });

  test('extracts major.minor from a versioned CUDA_PATH on Windows', () => {
    process.env.CUDA_PATH = 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v13.1';
    expect(_detectInstalledCudaVersion()).toBe('13.1');
  });

  test('handles forward-slash CUDA_PATH (POSIX-style envs)', () => {
    process.env.CUDA_PATH = '/usr/local/cuda/v12.6';
    expect(_detectInstalledCudaVersion()).toBe('12.6');
  });

  test('extracts major only when minor is absent', () => {
    process.env.CUDA_PATH = 'C:\\NVIDIA\\v12';
    expect(_detectInstalledCudaVersion()).toBe('12');
  });

  test('returns null when CUDA_PATH does not match a versioned NVIDIA path', () => {
    process.env.CUDA_PATH = 'C:\\some\\random\\path';
    expect(_detectInstalledCudaVersion()).toBeNull();
  });

  test('returns null when CUDA_PATH is unset', () => {
    delete process.env.CUDA_PATH;
    expect(_detectInstalledCudaVersion()).toBeNull();
  });
});

describe('WhisperService — _collectCudaDllSearchDirs', () => {
  const { _collectCudaDllSearchDirs } = require('../src/main/services/WhisperService');

  let savedCudaPath;
  let savedCudaPathV12;
  beforeEach(() => {
    savedCudaPath = process.env.CUDA_PATH;
    savedCudaPathV12 = process.env.CUDA_PATH_V12_6;
  });
  afterEach(() => {
    if (savedCudaPath === undefined) delete process.env.CUDA_PATH;
    else process.env.CUDA_PATH = savedCudaPath;
    if (savedCudaPathV12 === undefined) delete process.env.CUDA_PATH_V12_6;
    else process.env.CUDA_PATH_V12_6 = savedCudaPathV12;
  });

  test('includes CUDA_PATH/bin when CUDA_PATH is set', () => {
    process.env.CUDA_PATH = 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.6';
    const dirs = _collectCudaDllSearchDirs();
    // Build the expectation with the same path ops the implementation uses
    // (join + normalize) so the assertion holds on POSIX runners, where '\\'
    // is not a separator and a hardcoded Windows string would never match.
    const expected = path.normalize(path.join(process.env.CUDA_PATH, 'bin'));
    expect(dirs.some((d) => path.normalize(d) === expected)).toBe(true);
  });

  test('includes side-by-side CUDA_PATH_V12_* env vars', () => {
    process.env.CUDA_PATH_V12_6 = 'C:\\NVIDIA\\v12.6';
    const dirs = _collectCudaDllSearchDirs();
    const expected = path.normalize(path.join(process.env.CUDA_PATH_V12_6, 'bin'));
    expect(dirs.some((d) => path.normalize(d) === expected)).toBe(true);
  });

  test('deduplicates identical directories case-insensitively', () => {
    process.env.CUDA_PATH = 'C:\\NVIDIA\\v12.6';
    process.env.CUDA_PATH_V12_6 = 'C:\\nvidia\\V12.6'; // same dir, different casing
    const dirs = _collectCudaDllSearchDirs();
    const lower = dirs.map((d) => d.toLowerCase());
    const unique = new Set(lower);
    expect(unique.size).toBe(lower.length);
  });
});
