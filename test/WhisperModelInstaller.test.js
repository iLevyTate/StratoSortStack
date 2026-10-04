/**
 * Coverage for WhisperModelInstaller — the in-process counterpart of
 * scripts/setup-whisper-model.js. Exercises the deltas vs the CLI script:
 * input validation, idempotent dedup of overlapping installs, and the
 * onProgress contract that the renderer can subscribe to.
 *
 * The download primitives (`fetchExpectedMetadata`, `setupOneModel`) are
 * mocked at module-resolve time so we don't actually hit Hugging Face.
 * That keeps tests fast and runnable on CI agents without internet.
 */

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn((key) => {
      if (key === 'userData') return '/tmp/stratosort-test-userdata';
      throw new Error(`unexpected app.getPath key: ${key}`);
    })
  }
}));

jest.mock('fs', () => {
  const real = jest.requireActual('fs');
  return {
    ...real,
    promises: {
      ...real.promises,
      mkdir: jest.fn(async () => undefined)
    }
  };
});

const mockSetupOneModel = jest.fn();
const mockFetchExpectedMetadata = jest.fn();
const mockEnsureModelPresent = jest.fn();

jest.mock('../scripts/setup-whisper-model', () => {
  // Reuse the real defaults / pattern so the validation tests track the
  // real CLI script and can't drift silently. Only the network-touching
  // bits (fetch / setup) are stubbed.
  const real = jest.requireActual('../scripts/setup-whisper-model');
  return {
    ...real,
    setupOneModel: (...args) => mockSetupOneModel(...args),
    fetchExpectedMetadata: (...args) => mockFetchExpectedMetadata(...args),
    ensureModelPresent: (...args) => mockEnsureModelPresent(...args)
  };
});

jest.mock('../src/shared/logger', () => {
  const stub = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
    trace: jest.fn(),
    child: jest.fn()
  };
  stub.child.mockReturnValue(stub);
  return {
    logger: stub,
    createLogger: jest.fn(() => stub),
    correlationId: jest.fn(() => 'test'),
    setCorrelationId: jest.fn()
  };
});

const path = require('path');
const {
  installWhisperModel,
  checkInstallStatus,
  getInstallDir,
  DEFAULT_WHISPER_MODEL,
  DEFAULT_VAD_MODEL,
  _resetActiveInstallForTesting
} = require('../src/main/services/WhisperModelInstaller');

beforeEach(() => {
  mockSetupOneModel.mockReset();
  mockFetchExpectedMetadata.mockReset();
  mockEnsureModelPresent.mockReset();
  _resetActiveInstallForTesting();
});

describe('getInstallDir', () => {
  test('returns userData/models/whisper', () => {
    expect(getInstallDir()).toBe(path.join('/tmp/stratosort-test-userdata', 'models', 'whisper'));
  });
});

describe('installWhisperModel — happy paths', () => {
  test('installs whisper with default filename', async () => {
    mockSetupOneModel.mockResolvedValueOnce('installed');

    const result = await installWhisperModel();

    expect(result.success).toBe(true);
    expect(result.whisper).toEqual({
      filename: DEFAULT_WHISPER_MODEL,
      outcome: 'installed'
    });
    expect(result.vad).toBeUndefined();
    expect(mockSetupOneModel).toHaveBeenCalledTimes(1);
    const [filename, dir, args, label] = mockSetupOneModel.mock.calls[0];
    expect(filename).toBe(DEFAULT_WHISPER_MODEL);
    expect(dir).toContain('whisper');
    expect(args).toMatchObject({ auto: true, check: false });
    expect(label).toBe('whisper');
  });

  test('also installs VAD when installVad: true', async () => {
    mockSetupOneModel.mockResolvedValueOnce('installed').mockResolvedValueOnce('present');

    const result = await installWhisperModel({ installVad: true });

    expect(result.whisper.outcome).toBe('installed');
    expect(result.vad).toEqual({ filename: DEFAULT_VAD_MODEL, outcome: 'present' });
    expect(mockSetupOneModel).toHaveBeenCalledTimes(2);
  });

  test('emits onProgress events in order: whisper:start, whisper:done, vad:start, vad:done', async () => {
    mockSetupOneModel.mockResolvedValueOnce('installed').mockResolvedValueOnce('installed');
    const events = [];

    await installWhisperModel({
      installVad: true,
      onProgress: (stage, payload) => events.push({ stage, payload })
    });

    expect(events.map((e) => e.stage)).toEqual([
      'whisper:start',
      'whisper:done',
      'vad:start',
      'vad:done'
    ]);
    expect(events[1].payload.outcome).toBe('installed');
  });

  test('idempotent — overlapping calls dedup to a single download', async () => {
    let resolveSetup;
    mockSetupOneModel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSetup = resolve;
        })
    );

    // Two callers race the same window. The second must observe the
    // first's outcome rather than starting a duplicate download — the
    // assertion that proves this is `setupOneModel` is called exactly
    // once across both calls. (Identity equality on the returned
    // promise is unreliable because `async function` boxes its return.)
    const first = installWhisperModel();
    const second = installWhisperModel();

    // Drain microtasks so the first call's `await fs.mkdir` resolves
    // and `setupOneModel` is reached before we assert.
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockSetupOneModel).toHaveBeenCalledTimes(1);

    resolveSetup('installed');
    const [a, b] = await Promise.all([first, second]);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(a.whisper.outcome).toBe(b.whisper.outcome);
  });

  test('after a completed install, the next call is a fresh invocation (not the cached promise)', async () => {
    mockSetupOneModel.mockResolvedValueOnce('installed').mockResolvedValueOnce('present');

    await installWhisperModel();
    await installWhisperModel();

    expect(mockSetupOneModel).toHaveBeenCalledTimes(2);
  });
});

describe('installWhisperModel — input validation', () => {
  test('rejects whisper filename that does not match the GGML pattern', async () => {
    await expect(installWhisperModel({ modelFilename: 'evil.bin' })).rejects.toThrow(
      /Invalid whisper model filename/
    );
    expect(mockSetupOneModel).not.toHaveBeenCalled();
  });

  test('rejects path-traversal in filename', async () => {
    await expect(installWhisperModel({ modelFilename: '../../../etc/passwd' })).rejects.toThrow(
      /Invalid whisper model filename/
    );
  });

  test('rejects bad VAD filename when installVad: true', async () => {
    await expect(
      installWhisperModel({ installVad: true, vadFilename: 'not-a-ggml-file.txt' })
    ).rejects.toThrow(/Invalid VAD model filename/);
  });

  test('clears the dedup cache after a rejected validation so subsequent calls can proceed', async () => {
    await expect(installWhisperModel({ modelFilename: 'evil.bin' })).rejects.toThrow();
    mockSetupOneModel.mockResolvedValueOnce('installed');
    const result = await installWhisperModel(); // default model, valid
    expect(result.success).toBe(true);
  });
});

describe('installWhisperModel — failure propagation', () => {
  test('propagates downstream setupOneModel error and clears dedup cache', async () => {
    mockSetupOneModel.mockRejectedValueOnce(new Error('checksum mismatch'));

    await expect(installWhisperModel()).rejects.toThrow('checksum mismatch');

    // Subsequent call should NOT receive the cached rejected promise.
    mockSetupOneModel.mockResolvedValueOnce('installed');
    const result = await installWhisperModel();
    expect(result.success).toBe(true);
  });
});

describe('checkInstallStatus', () => {
  test('reports present for whisper when ensureModelPresent says so', async () => {
    mockFetchExpectedMetadata.mockResolvedValueOnce({
      size: 150 * 1024 * 1024,
      sha256: 'a'.repeat(64)
    });
    mockEnsureModelPresent.mockResolvedValueOnce({ present: true, size: 150 * 1024 * 1024 });

    const status = await checkInstallStatus();

    expect(status.whisper.present).toBe(true);
    expect(status.whisper.expectedBytes).toBe(150 * 1024 * 1024);
    expect(status.vad).toBeNull();
  });

  test('marks whisper unknown when metadata fetch throws', async () => {
    mockFetchExpectedMetadata.mockRejectedValueOnce(new Error('ENETUNREACH'));

    const status = await checkInstallStatus();

    expect(status.whisper.present).toBe(false);
    expect(status.whisper.unknown).toBe(true);
  });

  test('includes vad when includeVad: true', async () => {
    mockFetchExpectedMetadata
      .mockResolvedValueOnce({ size: 150 * 1024 * 1024, sha256: 'a'.repeat(64) })
      .mockResolvedValueOnce({ size: 1 * 1024 * 1024, sha256: 'b'.repeat(64) });
    mockEnsureModelPresent
      .mockResolvedValueOnce({ present: true })
      .mockResolvedValueOnce({ present: false });

    const status = await checkInstallStatus({ includeVad: true });

    expect(status.whisper.present).toBe(true);
    expect(status.vad.present).toBe(false);
    expect(status.vad.filename).toBe(DEFAULT_VAD_MODEL);
  });
});
