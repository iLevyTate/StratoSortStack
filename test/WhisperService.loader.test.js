/**
 * Coverage for WhisperService's platform-variant loader chain
 * (`loadNativeWhisperModule`) and the GPU-info → variant-list mapper
 * (`whisperVariantFor`). These are the GPU-engagement code paths that
 * carried this entire branch's audit motivation: the loader replaces the
 * binding's broken ESM-import based loader, and the mapper guarantees we
 * try cuda → vulkan → default in the right order so NVIDIA users without
 * the CUDA runtime DLLs still get GPU acceleration via Vulkan.
 *
 * These tests intentionally use virtual mocks (`{ virtual: true }`) so
 * they exercise the loader logic regardless of which variants happen to be
 * installed on the runner. CI runs on Windows, Linux, and macOS — without
 * virtual mocks, only one would have the right packages on disk.
 */

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
    correlationId: jest.fn(() => 'test-correlation-id'),
    setCorrelationId: jest.fn()
  };
});

const {
  _whisperVariantFor: whisperVariantFor,
  _loadNativeWhisperModule: loadNativeWhisperModule,
  _resetNativeWhisperCacheForTesting
} = require('../src/main/services/WhisperService');

const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_ARCH = process.arch;

function setPlatform(value) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

function setArch(value) {
  Object.defineProperty(process, 'arch', { value, configurable: true });
}

function restorePlatform() {
  Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true });
}

function restoreArch() {
  Object.defineProperty(process, 'arch', { value: ORIGINAL_ARCH, configurable: true });
}

function makeMockNative({ withContext = true } = {}) {
  const mod = {};
  if (withContext) {
    mod.WhisperContext = jest.fn();
    mod.WhisperVadContext = jest.fn();
  }
  return mod;
}

function virtualMock(packageName, factory) {
  jest.doMock(packageName, factory, { virtual: true });
}

function virtualMissing(packageName) {
  jest.doMock(
    packageName,
    () => {
      const err = new Error(`Cannot find module '${packageName}'`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    },
    { virtual: true }
  );
}

describe('whisperVariantFor', () => {
  afterEach(() => {
    restorePlatform();
  });

  test('returns [] when gpuInfo is null (CPU-only path)', () => {
    expect(whisperVariantFor(null)).toEqual([]);
  });

  test('returns [] when gpuInfo.type === "cpu"', () => {
    expect(whisperVariantFor({ type: 'cpu' })).toEqual([]);
  });

  test('returns [] on darwin regardless of GPU type (Metal is in default package)', () => {
    setPlatform('darwin');
    expect(whisperVariantFor({ type: 'cuda' })).toEqual([]);
    expect(whisperVariantFor({ type: 'vulkan' })).toEqual([]);
    expect(whisperVariantFor({ type: 'amd' })).toEqual([]);
  });

  test('NVIDIA on Windows returns ["cuda", "vulkan"] (CUDA first, Vulkan fallback)', () => {
    setPlatform('win32');
    expect(whisperVariantFor({ type: 'cuda' })).toEqual(['cuda', 'vulkan']);
    expect(whisperVariantFor({ type: 'nvidia' })).toEqual(['cuda', 'vulkan']);
  });

  test('NVIDIA on Linux returns ["cuda", "vulkan"]', () => {
    setPlatform('linux');
    expect(whisperVariantFor({ type: 'cuda' })).toEqual(['cuda', 'vulkan']);
  });

  test('AMD/Intel/Vulkan-labeled GPUs return ["vulkan"] only', () => {
    setPlatform('win32');
    expect(whisperVariantFor({ type: 'amd' })).toEqual(['vulkan']);
    expect(whisperVariantFor({ type: 'intel' })).toEqual(['vulkan']);
    expect(whisperVariantFor({ type: 'vulkan' })).toEqual(['vulkan']);
  });

  test('case-insensitive on type label', () => {
    setPlatform('win32');
    expect(whisperVariantFor({ type: 'NVIDIA' })).toEqual(['cuda', 'vulkan']);
    expect(whisperVariantFor({ type: 'AMD' })).toEqual(['vulkan']);
  });

  test('unknown GPU type returns [] (CPU fallback)', () => {
    setPlatform('win32');
    expect(whisperVariantFor({ type: 'mystery-asic' })).toEqual([]);
  });
});

describe('loadNativeWhisperModule fallback chain', () => {
  beforeEach(() => {
    _resetNativeWhisperCacheForTesting();
    setPlatform('win32');
    setArch('x64');
  });

  afterEach(() => {
    _resetNativeWhisperCacheForTesting();
    restorePlatform();
    restoreArch();
    jest.resetModules();
  });

  test('returns first variant in the list when its package loads successfully', () => {
    const cudaMock = makeMockNative();
    virtualMock('@fugood/node-whisper-win32-x64-cuda', () => cudaMock);

    const result = loadNativeWhisperModule(['cuda', 'vulkan']);

    expect(result.WhisperContext).toBe(cudaMock.WhisperContext);
    expect(result._resolvedVariant).toBe('cuda');
  });

  test('falls back to vulkan when cuda variant fails to require (the headline NVIDIA case)', () => {
    // Simulates: cuda package present on disk but cudart64_*.dll missing
    // from PATH → require throws ERR_DLOPEN_FAILED. Vulkan succeeds because
    // its loader ships with the GPU driver.
    virtualMissing('@fugood/node-whisper-win32-x64-cuda');
    const vulkanMock = makeMockNative();
    virtualMock('@fugood/node-whisper-win32-x64-vulkan', () => vulkanMock);

    const result = loadNativeWhisperModule(['cuda', 'vulkan']);

    expect(result.WhisperContext).toBe(vulkanMock.WhisperContext);
    expect(result._resolvedVariant).toBe('vulkan');
  });

  test('falls back to default when every GPU variant fails', () => {
    virtualMissing('@fugood/node-whisper-win32-x64-cuda');
    virtualMissing('@fugood/node-whisper-win32-x64-vulkan');
    const defaultMock = makeMockNative();
    virtualMock('@fugood/node-whisper-win32-x64', () => defaultMock);

    const result = loadNativeWhisperModule(['cuda', 'vulkan']);

    expect(result.WhisperContext).toBe(defaultMock.WhisperContext);
    expect(result._resolvedVariant).toBe('default');
  });

  test('appends the default variant even when called with empty list (CPU-only path)', () => {
    const defaultMock = makeMockNative();
    virtualMock('@fugood/node-whisper-win32-x64', () => defaultMock);

    const result = loadNativeWhisperModule([]);

    expect(result._resolvedVariant).toBe('default');
  });

  test('skips a variant that loads but exposes no WhisperContext (corrupt package)', () => {
    virtualMock('@fugood/node-whisper-win32-x64-cuda', () =>
      makeMockNative({ withContext: false })
    );
    const vulkanMock = makeMockNative();
    virtualMock('@fugood/node-whisper-win32-x64-vulkan', () => vulkanMock);

    const result = loadNativeWhisperModule(['cuda', 'vulkan']);

    expect(result._resolvedVariant).toBe('vulkan');
  });

  test('throws when every candidate fails (no whisper available at all)', () => {
    virtualMissing('@fugood/node-whisper-win32-x64-cuda');
    virtualMissing('@fugood/node-whisper-win32-x64-vulkan');
    virtualMissing('@fugood/node-whisper-win32-x64');

    expect(() => loadNativeWhisperModule(['cuda', 'vulkan'])).toThrow(/Cannot find module/);
  });

  test('caches the resolved module — second call does not re-walk the chain', () => {
    const cudaMock = makeMockNative();
    const cudaFactory = jest.fn(() => cudaMock);
    virtualMock('@fugood/node-whisper-win32-x64-cuda', cudaFactory);

    const first = loadNativeWhisperModule(['cuda', 'vulkan']);
    const second = loadNativeWhisperModule(['cuda', 'vulkan']);

    expect(first).toBe(second);
    // factory called exactly once across both load attempts
    expect(cudaFactory).toHaveBeenCalledTimes(1);
  });

  test('respects platform override (linux candidates differ from win32)', () => {
    setPlatform('linux');
    const linuxMock = makeMockNative();
    virtualMock('@fugood/node-whisper-linux-x64-vulkan', () => linuxMock);

    const result = loadNativeWhisperModule(['vulkan']);

    expect(result.WhisperContext).toBe(linuxMock.WhisperContext);
    expect(result._resolvedVariant).toBe('vulkan');
  });

  test('respects arch override (arm64 candidates differ from x64)', () => {
    setArch('arm64');
    const armMock = makeMockNative();
    virtualMock('@fugood/node-whisper-win32-arm64-vulkan', () => armMock);

    const result = loadNativeWhisperModule(['vulkan']);

    expect(result._resolvedVariant).toBe('vulkan');
    expect(result.WhisperContext).toBe(armMock.WhisperContext);
  });
});

/**
 * Static-source guard for the webpack-erasure regression: if the variant
 * loader ever drops `_nativeRequire` and reverts to a bare
 * `require(candidate.name)`, the call site gets erased to webpack's
 * `webpackEmptyContext` stub at bundle time and every variant fails
 * MODULE_NOT_FOUND in dev/prod (jest.doMock virtual modules let the
 * runtime tests above pass anyway because jest doesn't use webpack —
 * that's the gap this guard closes). See WhisperService.js JSDoc on
 * `loadNativeWhisperModule` for the full rationale (and why
 * `__non_webpack_require__` was tried first and rejected).
 */
describe('WhisperService source-level webpack guard', () => {
  const realFs = jest.requireActual('fs');
  const realPath = jest.requireActual('path');
  const SOURCE = realFs.readFileSync(
    realPath.join(__dirname, '..', 'src', 'main', 'services', 'WhisperService.js'),
    'utf8'
  );

  test('imports createRequire from the Node "module" builtin', () => {
    expect(SOURCE).toMatch(/createRequire\s*\}\s*=\s*require\(['"]module['"]\)/);
  });

  test('declares a file-scope _nativeRequire bound to __filename', () => {
    expect(SOURCE).toMatch(/_nativeRequire\s*=\s*createRequire\(__filename\)/);
  });

  test('the candidate loop calls _nativeRequire(candidate.name), not bare require()', () => {
    // The bug regressed when this was `require(candidate.name)`. Bare
    // `require(<runtime-string>)` is the trigger for webpackEmptyContext.
    expect(SOURCE).toMatch(/_nativeRequire\(candidate\.name\)/);
    // Belt-and-suspenders: code-only (comments stripped) must NOT contain
    // a bare `require(candidate.name)` — that's the regressed form.
    // Comments document the bad pattern explicitly so a reader can find
    // it; we exempt them from the static-string check.
    const codeOnly = SOURCE
      // Strip block comments /* ... */ (including JSDoc).
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // Strip line comments // ...
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    // `_nativeRequire(candidate.name)` is fine; `require(candidate.name)`
    // is not. Match exactly the bad form by requiring a non-identifier
    // character (or start-of-line) immediately before `require`.
    expect(codeOnly).not.toMatch(/(^|[^a-zA-Z_$])require\(candidate\.name\)/m);
  });
});
