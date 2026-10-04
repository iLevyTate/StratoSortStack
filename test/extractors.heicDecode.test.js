/**
 * Tests for the HEIC -> PNG ffmpeg bridge.
 *
 * No real ffmpeg is spawned: `spawnImpl` is injected with an EventEmitter
 * based fake child so each exit path (success, decoder missing, timeout,
 * output cap, spawn error, abort) is driven deterministically.
 */

const { EventEmitter } = require('events');

// `electron` (reached via MediaTranscoder -> runtimePaths) is mapped to
// test/mocks/electron.js by moduleNameMapper in test/jest.config.js; an
// explicit jest.mock() here would recurse into that same mapped path.

const { logger } = require('./mocks/logger');
const MediaTranscoder = require('../src/main/services/MediaTranscoder');
const {
  decodeHeicToPng,
  describesMissingHevcDecoder,
  HEIC_DECODE_TIMEOUT_MS
} = require('../src/main/analysis/extractors/heicDecode');

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BODY = Buffer.from('IHDR-and-the-rest-of-a-tiny-png');
const FAKE_FFMPEG = '/opt/fake/ffmpeg';
const INPUT = '/photos/IMG_0001.HEIC';

const EXPECTED_ARGS = [
  '-hide_banner',
  '-loglevel',
  'error',
  '-nostdin',
  '-i',
  INPUT,
  '-frames:v',
  '1',
  '-f',
  'image2pipe',
  '-vcodec',
  'png',
  'pipe:1'
];

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

/** Yield to the event loop so listeners attached by the decoder are in place. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Last `logger.debug` call payload, or undefined. */
function lastDebugPayload() {
  const calls = logger.debug.mock.calls;
  return calls.length ? calls[calls.length - 1][1] : undefined;
}

describe('decodeHeicToPng', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  test('returns the PNG buffer when ffmpeg exits 0 with a PNG stream', async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn(() => child);

    const promise = decodeHeicToPng(INPUT, { ffmpegPath: FAKE_FFMPEG, spawnImpl });
    await tick();
    child.stdout.emit('data', PNG_HEADER);
    child.stdout.emit('data', PNG_BODY);
    child.emit('close', 0, null);

    const png = await promise;
    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.equals(Buffer.concat([PNG_HEADER, PNG_BODY]))).toBe(true);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith(FAKE_FFMPEG, EXPECTED_ARGS, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  test('returns null on a non-zero exit and reports the missing HEVC decoder from stderr', async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn(() => child);

    const promise = decodeHeicToPng(INPUT, { ffmpegPath: FAKE_FFMPEG, spawnImpl });
    await tick();
    child.stderr.emit(
      'data',
      Buffer.from('Decoder (codec hevc) not found for input stream #0:0\n')
    );
    child.emit('close', 1, null);

    await expect(promise).resolves.toBeNull();
    const payload = lastDebugPayload();
    expect(payload).toMatchObject({
      reason: 'non-zero exit',
      exitCode: 1,
      missingHevcDecoder: true
    });
    expect(payload.stderrTail).toContain('codec hevc');
    expect(payload.file).toBe('IMG_0001.HEIC');
  });

  test('returns null when the exit code is 0 but stdout is not a PNG', async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn(() => child);

    const promise = decodeHeicToPng(INPUT, { ffmpegPath: FAKE_FFMPEG, spawnImpl });
    await tick();
    child.stdout.emit('data', Buffer.from('\xff\xd8\xff\xe0 definitely a jpeg', 'binary'));
    child.emit('close', 0, null);

    await expect(promise).resolves.toBeNull();
    expect(lastDebugPayload()).toMatchObject({
      reason: 'stdout is not a PNG stream',
      missingHevcDecoder: false
    });
  });

  test('returns null and sends SIGKILL when ffmpeg never closes before timeoutMs', async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn(() => child);

    const result = await decodeHeicToPng(INPUT, {
      ffmpegPath: FAKE_FFMPEG,
      spawnImpl,
      timeoutMs: 30
    });

    expect(result).toBeNull();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(lastDebugPayload()).toMatchObject({ reason: 'timeout', timeoutMs: 30 });
  });

  test('returns null and kills the child once stdout exceeds maxOutputBytes', async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn(() => child);

    const promise = decodeHeicToPng(INPUT, {
      ffmpegPath: FAKE_FFMPEG,
      spawnImpl,
      maxOutputBytes: 16
    });
    await tick();
    child.stdout.emit('data', PNG_HEADER); // 8 bytes, under the cap
    child.stdout.emit('data', Buffer.alloc(16, 0x41)); // 24 total, over the cap

    await expect(promise).resolves.toBeNull();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(lastDebugPayload()).toMatchObject({
      reason: 'output cap exceeded',
      maxOutputBytes: 16
    });

    // A late close after the kill must not resolve twice or throw.
    child.emit('close', null, 'SIGKILL');
    await expect(promise).resolves.toBeNull();
  });

  test("returns null when the child emits 'error' (ffmpeg binary missing)", async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn(() => child);

    const promise = decodeHeicToPng(INPUT, { ffmpegPath: FAKE_FFMPEG, spawnImpl });
    await tick();
    child.emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }));

    await expect(promise).resolves.toBeNull();
    expect(lastDebugPayload()).toMatchObject({ reason: 'spawn error', code: 'ENOENT' });
  });

  test('returns null when spawn itself throws synchronously', async () => {
    const spawnImpl = jest.fn(() => {
      throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
    });

    await expect(
      decodeHeicToPng(INPUT, { ffmpegPath: FAKE_FFMPEG, spawnImpl })
    ).resolves.toBeNull();
    expect(lastDebugPayload()).toMatchObject({ reason: 'spawn failed' });
  });

  test('aborting the signal kills the child and resolves null', async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn(() => child);
    const controller = new AbortController();

    const promise = decodeHeicToPng(INPUT, {
      ffmpegPath: FAKE_FFMPEG,
      spawnImpl,
      signal: controller.signal
    });
    await tick();
    child.stdout.emit('data', PNG_HEADER);
    controller.abort();

    await expect(promise).resolves.toBeNull();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(lastDebugPayload()).toMatchObject({ reason: 'aborted' });

    // Data arriving after the abort is ignored.
    child.stdout.emit('data', PNG_BODY);
    child.emit('close', 0, null);
    await expect(promise).resolves.toBeNull();
  });

  test('an already-aborted signal resolves null without spawning', async () => {
    const spawnImpl = jest.fn();
    const controller = new AbortController();
    controller.abort();

    await expect(
      decodeHeicToPng(INPUT, { ffmpegPath: FAKE_FFMPEG, spawnImpl, signal: controller.signal })
    ).resolves.toBeNull();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  test('resolves the binary through MediaTranscoder.resolveFfmpegPath when ffmpegPath is omitted', async () => {
    const resolveSpy = jest
      .spyOn(MediaTranscoder, 'resolveFfmpegPath')
      .mockReturnValue('/bundled/ffmpeg');
    const child = makeFakeChild();
    const spawnImpl = jest.fn(() => child);

    const promise = decodeHeicToPng(INPUT, { spawnImpl });
    await tick();
    child.stdout.emit('data', Buffer.concat([PNG_HEADER, PNG_BODY]));
    child.emit('close', 0, null);

    await expect(promise).resolves.toEqual(Buffer.concat([PNG_HEADER, PNG_BODY]));
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(spawnImpl.mock.calls[0][0]).toBe('/bundled/ffmpeg');
  });

  test('returns null without spawning when no ffmpeg can be resolved', async () => {
    jest.spyOn(MediaTranscoder, 'resolveFfmpegPath').mockImplementation(() => {
      throw new Error('STRATOSORT_FFMPEG_PATH points at a non-existent file: /nope');
    });
    const spawnImpl = jest.fn();

    await expect(decodeHeicToPng(INPUT, { spawnImpl })).resolves.toBeNull();
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('ffmpeg unavailable'),
      expect.objectContaining({ error: expect.stringContaining('non-existent') })
    );
  });

  test('rejects nothing for an invalid filePath', async () => {
    const spawnImpl = jest.fn();
    await expect(decodeHeicToPng('', { spawnImpl })).resolves.toBeNull();
    await expect(decodeHeicToPng(/** @type {any} */ (null), { spawnImpl })).resolves.toBeNull();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  test('exports the default timeout constant', () => {
    expect(HEIC_DECODE_TIMEOUT_MS).toBe(20000);
  });
});

describe('decodeHeicToPng adversarial inputs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('empty file: exit 0 with no stdout at all resolves null without killing', async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn(() => child);

    const promise = decodeHeicToPng(INPUT, { ffmpegPath: FAKE_FFMPEG, spawnImpl });
    await tick();
    child.emit('close', 0, null);

    await expect(promise).resolves.toBeNull();
    expect(lastDebugPayload()).toMatchObject({
      reason: 'stdout is not a PNG stream',
      bytes: 0,
      missingHevcDecoder: false
    });
    // The process already exited; nothing is signalled after 'close'.
    expect(child.kill).not.toHaveBeenCalled();
  });

  test('one-byte file: a lone 0x89 is not a PNG and the byte never reaches the log', async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn(() => child);

    const promise = decodeHeicToPng(INPUT, { ffmpegPath: FAKE_FFMPEG, spawnImpl });
    await tick();
    child.stdout.emit('data', Buffer.from([0x89]));
    child.emit('close', 0, null);

    await expect(promise).resolves.toBeNull();
    const payload = lastDebugPayload();
    expect(payload).toMatchObject({ reason: 'stdout is not a PNG stream', bytes: 1 });
    // stdout bytes are never logged, in any shape: no key carries them and the
    // byte itself does not appear anywhere in the serialized payload.
    expect(Object.keys(payload)).toEqual(
      expect.not.arrayContaining(['stdout', 'png', 'buffer', 'output', 'data'])
    );
    expect(JSON.stringify(payload)).not.toContain('\u0089');
    expect(child.kill).not.toHaveBeenCalled();
  });

  test('a non-zero exit after the process is gone does not send a signal', async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn(() => child);

    const promise = decodeHeicToPng(INPUT, { ffmpegPath: FAKE_FFMPEG, spawnImpl });
    await tick();
    child.stderr.emit('data', Buffer.from('[mov,mp4 @ 0x1] moov atom not found\n'));
    child.emit('close', 1, null);

    await expect(promise).resolves.toBeNull();
    expect(lastDebugPayload()).toMatchObject({
      reason: 'non-zero exit',
      exitCode: 1,
      missingHevcDecoder: false
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  test('header claims a huge image: a single chunk larger than the cap is dropped, not buffered', async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn(() => child);
    // IHDR claiming 0xFFFFFFFF x 0xFFFFFFFF pixels, followed by a payload that
    // is itself over the cap in one write.
    const ihdr = Buffer.concat([
      PNG_HEADER,
      Buffer.from([0x00, 0x00, 0x00, 0x0d]),
      Buffer.from('IHDR'),
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x08, 0x06, 0x00, 0x00, 0x00])
    ]);
    const cap = 64 * 1024;
    const flood = Buffer.alloc(cap + 1, 0x5a);

    const promise = decodeHeicToPng(INPUT, {
      ffmpegPath: FAKE_FFMPEG,
      spawnImpl,
      maxOutputBytes: cap
    });
    await tick();
    child.stdout.emit('data', ihdr);
    child.stdout.emit('data', flood);

    await expect(promise).resolves.toBeNull();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    const payload = lastDebugPayload();
    expect(payload).toMatchObject({ reason: 'output cap exceeded', maxOutputBytes: cap });
    expect(JSON.stringify(payload)).not.toContain('ZZZZ');

    // Data and close after the kill are ignored and do not re-settle.
    child.stdout.emit('data', flood);
    child.emit('close', null, 'SIGKILL');
    await expect(promise).resolves.toBeNull();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  test('a PNG exactly at maxOutputBytes is accepted (cap is inclusive)', async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn(() => child);

    const promise = decodeHeicToPng(INPUT, {
      ffmpegPath: FAKE_FFMPEG,
      spawnImpl,
      maxOutputBytes: PNG_HEADER.length
    });
    await tick();
    child.stdout.emit('data', PNG_HEADER);
    child.emit('close', 0, null);

    await expect(promise).resolves.toEqual(PNG_HEADER);
    expect(child.kill).not.toHaveBeenCalled();
  });

  test('a multi-megabyte stderr flood is bounded and only its tail is logged', async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn(() => child);

    const promise = decodeHeicToPng(INPUT, { ffmpegPath: FAKE_FFMPEG, spawnImpl });
    await tick();
    const line = Buffer.from('[hevc @ 0x1] Could not find ref with POC 12\n');
    const started = Date.now();
    for (let i = 0; i < 50000; i += 1) {
      child.stderr.emit('data', line); // ~2.2 MiB in total, far past the 256 KiB bound
    }
    child.emit('close', 1, null);

    await expect(promise).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    const payload = lastDebugPayload();
    expect(payload).toMatchObject({
      reason: 'non-zero exit',
      stderrTruncated: true,
      missingHevcDecoder: false
    });
    expect(payload.stderrTail.length).toBeLessThanOrEqual(400 + 3);
    expect(payload.stderrTail.startsWith('...')).toBe(true);
  });

  test('describesMissingHevcDecoder stays linear on a multi-megabyte near-miss input', () => {
    // One 4 MiB line full of "hevc" and "not foun" near-misses (no newline),
    // then 200k short lines alternating the two halves of the predicate.
    const singleLine = 'Stream #0:0: Video: hevc (Main) not foun '.repeat(100000);
    const manyLines = Array.from({ length: 200000 }, (_, i) =>
      i % 2 ? 'Stream #0:0: Video: hevc (Main Still Picture)' : '/x.heic: No such file, not found'
    ).join('\n');

    const started = Date.now();
    expect(describesMissingHevcDecoder(singleLine)).toBe(false);
    expect(describesMissingHevcDecoder(manyLines)).toBe(false);
    expect(describesMissingHevcDecoder(`${singleLine}\n${manyLines}\nhevc: No decoder`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test('a timeoutMs above the 32-bit timer limit is clamped instead of firing immediately', async () => {
    jest.useFakeTimers();
    const child = makeFakeChild();
    const spawnImpl = jest.fn(() => child);

    const promise = decodeHeicToPng(INPUT, {
      ffmpegPath: FAKE_FFMPEG,
      spawnImpl,
      timeoutMs: Number.MAX_SAFE_INTEGER
    });
    // Node (and the fake timer) would turn an overflowing delay into 1 ms.
    jest.advanceTimersByTime(60 * 1000);
    expect(child.kill).not.toHaveBeenCalled();

    child.stdout.emit('data', Buffer.concat([PNG_HEADER, PNG_BODY]));
    child.emit('close', 0, null);
    await expect(promise).resolves.toEqual(Buffer.concat([PNG_HEADER, PNG_BODY]));
  });

  test("an 'error' on the stdout pipe resolves null instead of crashing the process", async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn(() => child);

    const promise = decodeHeicToPng(INPUT, { ffmpegPath: FAKE_FFMPEG, spawnImpl });
    await tick();
    // With no listener, EventEmitter would throw this from emit().
    child.stdout.emit('error', new Error('read EPIPE'));
    child.stderr.emit('error', new Error('read EPIPE'));

    await expect(promise).resolves.toBeNull();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(lastDebugPayload()).toMatchObject({ reason: 'stdout stream error' });
  });

  test('a signal-like object without addEventListener does not reject or leak the child', async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn(() => child);

    const promise = decodeHeicToPng(INPUT, {
      ffmpegPath: FAKE_FFMPEG,
      spawnImpl,
      signal: /** @type {any} */ ({ aborted: false })
    });
    await tick();
    child.stdout.emit('data', Buffer.concat([PNG_HEADER, PNG_BODY]));
    child.emit('close', 0, null);

    await expect(promise).resolves.toEqual(Buffer.concat([PNG_HEADER, PNG_BODY]));
  });

  test('non-Buffer stdout chunks are coerced instead of throwing inside the handler', async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn(() => child);

    const promise = decodeHeicToPng(INPUT, { ffmpegPath: FAKE_FFMPEG, spawnImpl });
    await tick();
    child.stdout.emit('data', new Uint8Array(PNG_HEADER));
    child.stdout.emit('data', PNG_BODY.toString('latin1'));
    child.stdout.emit('data', 42); // nonsense from a broken stream: contributes nothing
    child.emit('close', 0, null);

    await expect(promise).resolves.toEqual(Buffer.concat([PNG_HEADER, PNG_BODY]));
  });
});

describe('describesMissingHevcDecoder', () => {
  test('matches the explicit "Decoder (codec hevc) not found" line', () => {
    expect(
      describesMissingHevcDecoder(
        '[vist#0:0/hevc @ 0x5581] Decoder (codec hevc) not found for input stream #0:0\n'
      )
    ).toBe(true);
  });

  test('matches hevc together with "No decoder"', () => {
    expect(describesMissingHevcDecoder('Decoding requested, but no decoder found for: hevc')).toBe(
      true
    );
    expect(describesMissingHevcDecoder('[hevc @ 0x1] No decoder available')).toBe(true);
  });

  test('matches "Unsupported codec"', () => {
    expect(describesMissingHevcDecoder('Unsupported codec with id 173 for input stream 0')).toBe(
      true
    );
  });

  test('does not treat a broken container as a decoder problem', () => {
    expect(
      describesMissingHevcDecoder('[mov,mp4,m4a,3gp,3g2,mj2 @ 0x55d] moov atom not found')
    ).toBe(false);
  });

  test('does not combine "hevc" and "not found" across different lines', () => {
    expect(
      describesMissingHevcDecoder(
        'Stream #0:0: Video: hevc (Main Still Picture)\n/photos/x.heic: No such file or directory, moov atom not found'
      )
    ).toBe(false);
  });

  test('is false for empty and non-string input', () => {
    expect(describesMissingHevcDecoder('')).toBe(false);
    expect(describesMissingHevcDecoder(null)).toBe(false);
    expect(describesMissingHevcDecoder(undefined)).toBe(false);
  });
});
