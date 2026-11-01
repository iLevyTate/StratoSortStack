/**
 * @jest-environment node
 *
 * Tests for llamaBackendSelector.js covering:
 *  - buildBackendCandidates() for CUDA, Metal, Vulkan, and unknown GPU types
 *  - initLlamaWithBackend() happy path: GPU backend selected
 *  - initLlamaWithBackend() fallback: GPU fails, CPU succeeds
 *  - initLlamaWithBackend() fatal: all backends fail
 *  - Null/missing gpuInfo handling
 *  - prioritizeCachedBackend() and the last-known-good backend record
 */

const {
  SLOW_BACKEND_ATTEMPT_WARN_MS,
  getGpuBackendOverride,
  buildBackendCandidates,
  filterCandidatesBySupport,
  prioritizeCachedBackend,
  resolveVisionRuntimeBackend,
  initLlamaWithBackend
} = require('../src/main/utils/llamaBackendSelector');

describe('llamaBackendSelector', () => {
  // ─── buildBackendCandidates ─────────────────────────────────

  describe('buildBackendCandidates', () => {
    test('returns [cuda, vulkan, auto] for CUDA GPU', () => {
      expect(buildBackendCandidates({ type: 'cuda' })).toEqual(['cuda', 'vulkan', 'auto']);
    });

    test('returns [metal, auto] for Metal GPU', () => {
      expect(buildBackendCandidates({ type: 'metal' })).toEqual(['metal', 'auto']);
    });

    test('returns [vulkan, auto] for Vulkan GPU', () => {
      expect(buildBackendCandidates({ type: 'vulkan' })).toEqual(['vulkan', 'auto']);
    });

    test('returns safe platform defaults for unknown GPU type', () => {
      const result = buildBackendCandidates({ type: 'directx' });
      if (process.platform === 'darwin') {
        expect(result).toEqual(['metal', 'auto']);
      } else {
        expect(result).toEqual(['auto']);
      }
    });

    test('returns safe platform defaults when gpuInfo is null', () => {
      const result = buildBackendCandidates(null);
      if (process.platform === 'darwin') {
        expect(result).toEqual(['metal', 'auto']);
      } else {
        expect(result).toEqual(['auto']);
      }
    });

    test('returns safe platform defaults when gpuInfo.type is missing', () => {
      const result = buildBackendCandidates({ name: 'GPU' });
      if (process.platform === 'darwin') {
        expect(result).toEqual(['metal', 'auto']);
      } else {
        expect(result).toEqual(['auto']);
      }
    });

    test('normalizes type to lowercase', () => {
      expect(buildBackendCandidates({ type: 'CUDA' })).toEqual(['cuda', 'vulkan', 'auto']);
      expect(buildBackendCandidates({ type: 'Metal' })).toEqual(['metal', 'auto']);
    });

    test('treats non-string type as null (falls back to platform defaults)', () => {
      const numResult = buildBackendCandidates({ type: 123 });
      const objResult = buildBackendCandidates({ type: {} });
      const boolResult = buildBackendCandidates({ type: true });

      // All should produce the same platform-default candidates as null
      const expected = buildBackendCandidates(null);
      expect(numResult).toEqual(expected);
      expect(objResult).toEqual(expected);
      expect(boolResult).toEqual(expected);
    });

    test('handles empty object (no type property)', () => {
      const result = buildBackendCandidates({});
      const expected = buildBackendCandidates(null);
      expect(result).toEqual(expected);
    });

    describe('STRATOSORT_LLM_GPU_BACKEND override', () => {
      const original = process.env.STRATOSORT_LLM_GPU_BACKEND;

      afterEach(() => {
        if (original === undefined) {
          delete process.env.STRATOSORT_LLM_GPU_BACKEND;
        } else {
          process.env.STRATOSORT_LLM_GPU_BACKEND = original;
        }
      });

      test('forces CUDA candidate chain when set to cuda', () => {
        process.env.STRATOSORT_LLM_GPU_BACKEND = 'cuda';
        expect(buildBackendCandidates({ type: 'vulkan' })).toEqual(['cuda', 'vulkan', 'auto']);
      });

      test('forces CPU when set to cpu', () => {
        process.env.STRATOSORT_LLM_GPU_BACKEND = 'cpu';
        expect(buildBackendCandidates({ type: 'cuda' })).toEqual([false]);
      });

      test('forces Vulkan chain when set to vulkan', () => {
        process.env.STRATOSORT_LLM_GPU_BACKEND = 'vulkan';
        expect(buildBackendCandidates({ type: 'cuda' })).toEqual(['vulkan', 'auto']);
      });

      test('normalizes cpu-like override values', () => {
        process.env.STRATOSORT_LLM_GPU_BACKEND = 'off';
        expect(getGpuBackendOverride()).toBe('cpu');
      });
    });
  });

  describe('resolveVisionRuntimeBackend', () => {
    test('prefers Vulkan runtime on Windows when GPU is unknown', () => {
      expect(
        resolveVisionRuntimeBackend({
          gpuInfo: null,
          preferredBackend: 'auto',
          platform: 'win32',
          arch: 'x64'
        })
      ).toBe('vulkan');
    });

    test('maps unsupported Linux CUDA preference to Vulkan runtime', () => {
      expect(
        resolveVisionRuntimeBackend({
          gpuInfo: { type: 'cuda' },
          preferredBackend: 'cuda',
          platform: 'linux',
          arch: 'x64'
        })
      ).toBe('vulkan');
    });

    // Fail-safe: unknown GPU detection on Linux must NOT speculatively pick
    // Vulkan — the Vulkan runtime probes the driver at load and crashes the
    // helper process on machines without one (headless boxes, arm64 SBCs).
    test('falls back to CPU runtime on Linux when backend is auto and detection is unknown', () => {
      expect(
        resolveVisionRuntimeBackend({
          gpuInfo: null,
          preferredBackend: 'auto',
          platform: 'linux',
          arch: 'x64'
        })
      ).toBe('cpu');
    });

    test('falls back to CPU runtime on Linux arm64 when backend is auto and detection is unknown', () => {
      expect(
        resolveVisionRuntimeBackend({
          gpuInfo: null,
          preferredBackend: 'auto',
          platform: 'linux',
          arch: 'arm64'
        })
      ).toBe('cpu');
    });

    test('still selects Vulkan on Linux when a Vulkan GPU is detected', () => {
      expect(
        resolveVisionRuntimeBackend({
          gpuInfo: { type: 'vulkan' },
          preferredBackend: 'auto',
          platform: 'linux',
          arch: 'x64'
        })
      ).toBe('vulkan');
    });

    test('uses CPU runtime on Linux when no GPU is detected', () => {
      expect(
        resolveVisionRuntimeBackend({
          gpuInfo: { type: 'cpu' },
          preferredBackend: 'auto',
          platform: 'linux',
          arch: 'x64'
        })
      ).toBe('cpu');
    });

    test('uses Metal runtime on macOS', () => {
      expect(
        resolveVisionRuntimeBackend({
          gpuInfo: { type: 'metal' },
          preferredBackend: 'auto',
          platform: 'darwin',
          arch: 'arm64'
        })
      ).toBe('metal');
    });
  });

  // ─── initLlamaWithBackend ──────────────────────────────────

  describe('initLlamaWithBackend', () => {
    const mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    test('selects CUDA backend when getLlama succeeds', async () => {
      const mockLlama = { gpu: 'cuda' };
      const getLlama = jest.fn().mockResolvedValue(mockLlama);

      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda', name: 'RTX 4090' },
        logger: mockLogger,
        context: 'test'
      });

      expect(result.llama).toBe(mockLlama);
      expect(result.backend).toBe('cuda');
      expect(result.selection.selected).toBe('cuda');
      expect(result.selection.attempted).toHaveLength(1);
      expect(result.selection.attempted[0].success).toBe(true);
      expect(getLlama).toHaveBeenCalledWith({ gpu: 'cuda' });
    });

    test('falls back from CUDA to Vulkan when CUDA fails', async () => {
      const mockLlama = { gpu: 'vulkan' };
      const getLlama = jest
        .fn()
        .mockRejectedValueOnce(new Error('CUDA init failed'))
        .mockResolvedValueOnce(mockLlama);

      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test'
      });

      expect(result.backend).toBe('vulkan');
      expect(result.selection.attempted).toHaveLength(2);
      expect(result.selection.attempted[0].success).toBe(false);
      expect(result.selection.attempted[1].success).toBe(true);
      expect(getLlama).toHaveBeenNthCalledWith(1, { gpu: 'cuda' });
      expect(getLlama).toHaveBeenNthCalledWith(2, { gpu: 'vulkan' });
    });

    test('falls back to CPU when all GPU backends fail', async () => {
      const mockLlama = { gpu: false };
      const getLlama = jest
        .fn()
        .mockRejectedValueOnce(new Error('CUDA failed'))
        .mockRejectedValueOnce(new Error('Vulkan failed'))
        .mockRejectedValueOnce(new Error('Auto failed'))
        .mockResolvedValueOnce(mockLlama); // CPU fallback

      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test'
      });

      expect(result.backend).toBe('cpu');
      expect(result.selection.selected).toBe('cpu');
      expect(result.selection.attempted).toHaveLength(4); // cuda, vulkan, auto, cpu
      expect(getLlama).toHaveBeenLastCalledWith({ gpu: false });
    });

    test('throws fatal error when all backends including CPU fail', async () => {
      const getLlama = jest.fn().mockRejectedValue(new Error('fatal init failure'));

      await expect(
        initLlamaWithBackend({
          getLlama,
          gpuInfo: { type: 'cuda' },
          logger: mockLogger,
          context: 'test'
        })
      ).rejects.toThrow(/Failed to initialize Llama backend/);

      // Should have attempted: cuda, vulkan, auto, cpu
      expect(getLlama).toHaveBeenCalledTimes(4);
    });

    test('fatal error includes attempt details', async () => {
      const getLlama = jest.fn().mockRejectedValue(new Error('init error'));

      try {
        await initLlamaWithBackend({
          getLlama,
          gpuInfo: { type: 'metal' },
          logger: mockLogger,
          context: 'test'
        });
        fail('Should have thrown');
      } catch (error) {
        expect(error.attempts).toBeDefined();
        // metal and auto are recorded; CPU failure is captured as originalError
        expect(error.attempts).toHaveLength(2); // metal, auto
        expect(error.originalError).toBeDefined();
        expect(error.message).toMatch(/metal, auto/);
      }
    });

    test('falls back from Metal to auto to CPU when Metal fails', async () => {
      const mockLlama = { gpu: false };
      const getLlama = jest
        .fn()
        .mockRejectedValueOnce(new Error('Metal init failed'))
        .mockRejectedValueOnce(new Error('Auto init failed'))
        .mockResolvedValueOnce(mockLlama);

      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'metal' },
        logger: mockLogger,
        context: 'test'
      });

      expect(result.backend).toBe('cpu');
      expect(result.selection.selected).toBe('cpu');
      expect(result.selection.attempted).toHaveLength(3); // metal, auto, cpu
      expect(result.selection.attempted[0]).toMatchObject({
        backend: 'metal',
        success: false
      });
      expect(result.selection.attempted[1]).toMatchObject({
        backend: 'auto',
        success: false
      });
      expect(result.selection.attempted[2]).toMatchObject({
        backend: 'cpu',
        success: true
      });
    });

    test('falls back from Vulkan to auto when Vulkan fails', async () => {
      const mockLlama = { gpu: 'auto' };
      const getLlama = jest
        .fn()
        .mockRejectedValueOnce(new Error('Vulkan init failed'))
        .mockResolvedValueOnce(mockLlama);

      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'vulkan' },
        logger: mockLogger,
        context: 'test'
      });

      expect(result.backend).toBe('auto');
      expect(result.selection.attempted).toHaveLength(2); // vulkan, auto
      expect(getLlama).toHaveBeenNthCalledWith(1, { gpu: 'vulkan' });
      expect(getLlama).toHaveBeenNthCalledWith(2, { gpu: 'auto' });
    });

    test('works with null gpuInfo (tries the safe platform default first)', async () => {
      const mockLlama = { gpu: 'cpu' };
      const getLlama = jest.fn().mockResolvedValue(mockLlama);

      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: null,
        logger: mockLogger,
        context: 'test'
      });

      expect(result.backend).toBe('cpu');
      // First call is platform-specific: cuda/vulkan on win32/linux, metal on darwin
      expect(getLlama).toHaveBeenCalled();
      expect(result.selection.detectedGpu).toBeNull();
    });

    test('passes llamaLogger to getLlama when provided', async () => {
      const mockLlama = { gpu: 'cuda' };
      const getLlama = jest.fn().mockResolvedValue(mockLlama);
      const llamaLogger = jest.fn();

      await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test',
        llamaLogger
      });

      expect(getLlama).toHaveBeenCalledWith({ gpu: 'cuda', logger: llamaLogger });
    });

    test('omits logger key from getLlama options when no llamaLogger provided', async () => {
      const getLlama = jest.fn().mockResolvedValue({ gpu: 'cuda' });

      await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test'
      });

      expect(getLlama).toHaveBeenCalledWith({ gpu: 'cuda' });
      expect(getLlama.mock.calls[0][0]).not.toHaveProperty('logger');
    });

    test('passes llamaLogger to the CPU fallback getLlama call', async () => {
      const llamaLogger = jest.fn();
      const getLlama = jest
        .fn()
        .mockRejectedValueOnce(new Error('CUDA failed'))
        .mockRejectedValueOnce(new Error('Vulkan failed'))
        .mockRejectedValueOnce(new Error('Auto failed'))
        .mockResolvedValueOnce({ gpu: false });

      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test',
        llamaLogger
      });

      expect(result.backend).toBe('cpu');
      expect(getLlama).toHaveBeenLastCalledWith({ gpu: false, logger: llamaLogger });
    });

    test('uses console when no logger provided', async () => {
      const mockLlama = { gpu: 'auto' };
      const getLlama = jest.fn().mockResolvedValue(mockLlama);

      // Should not throw even without logger
      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: null,
        context: 'test'
      });

      expect(result.llama).toBe(mockLlama);
    });
  });

  // ─── filterCandidatesBySupport ─────────────────────────────

  describe('filterCandidatesBySupport', () => {
    test('drops cuda when node-llama-cpp does not list it and replaces trailing auto with CPU', () => {
      expect(filterCandidatesBySupport(['cuda', 'vulkan', 'auto'], ['vulkan', false])).toEqual([
        'vulkan',
        false
      ]);
    });

    test('keeps the full chain (minus auto) when both GPU types are supported', () => {
      expect(
        filterCandidatesBySupport(['cuda', 'vulkan', 'auto'], ['cuda', 'vulkan', false])
      ).toEqual(['cuda', 'vulkan', false]);
    });

    test('returns [auto] when no explicit GPU candidate remains', () => {
      expect(filterCandidatesBySupport(['vulkan', 'auto'], [false])).toEqual(['auto']);
      expect(filterCandidatesBySupport(['cuda', 'vulkan', 'auto'], [false])).toEqual(['auto']);
    });

    test('leaves metal untouched', () => {
      // macOS arm64: node-llama-cpp reports only metal; auto has nothing to add.
      expect(filterCandidatesBySupport(['metal', 'auto'], ['metal'])).toEqual(['metal', false]);
      // metal is never dropped even when the supported list omits it.
      expect(filterCandidatesBySupport(['metal', 'auto'], [false])).toEqual(['metal', false]);
    });

    test('keeps auto when supported lists a GPU type the explicit candidates do not cover', () => {
      // GPUMonitor said vulkan (WMI fallback) but the CUDA runtime is present:
      // auto must stay so node-llama-cpp can still negotiate CUDA.
      expect(filterCandidatesBySupport(['vulkan', 'auto'], ['cuda', 'vulkan', false])).toEqual([
        'vulkan',
        'auto'
      ]);
      expect(filterCandidatesBySupport(['metal', 'auto'], ['vulkan', false])).toEqual([
        'metal',
        'auto'
      ]);
    });

    test('passes CPU-only and auto-only chains through unchanged', () => {
      expect(filterCandidatesBySupport([false], ['cuda', 'vulkan', false])).toEqual([false]);
      expect(filterCandidatesBySupport(['auto'], ['cuda', 'vulkan', false])).toEqual(['auto']);
    });

    test('returns candidates unchanged when the supported list is unavailable', () => {
      expect(filterCandidatesBySupport(['cuda', 'vulkan', 'auto'], null)).toEqual([
        'cuda',
        'vulkan',
        'auto'
      ]);
      expect(filterCandidatesBySupport(['cuda', 'vulkan', 'auto'], undefined)).toEqual([
        'cuda',
        'vulkan',
        'auto'
      ]);
    });

    test('does not mutate its input', () => {
      const candidates = ['cuda', 'vulkan', 'auto'];
      filterCandidatesBySupport(candidates, ['vulkan', false]);
      expect(candidates).toEqual(['cuda', 'vulkan', 'auto']);
    });
  });

  // ─── initLlamaWithBackend: supported-backend filter, timings, console ───

  describe('initLlamaWithBackend with getLlamaGpuTypes', () => {
    const mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };
    const originalOverride = process.env.STRATOSORT_LLM_GPU_BACKEND;
    const originalSoftware = process.env.STRATOSORT_FORCE_SOFTWARE_GPU;

    beforeEach(() => {
      jest.clearAllMocks();
      delete process.env.STRATOSORT_LLM_GPU_BACKEND;
      delete process.env.STRATOSORT_FORCE_SOFTWARE_GPU;
    });

    afterEach(() => {
      jest.useRealTimers();
      if (originalOverride === undefined) {
        delete process.env.STRATOSORT_LLM_GPU_BACKEND;
      } else {
        process.env.STRATOSORT_LLM_GPU_BACKEND = originalOverride;
      }
      if (originalSoftware === undefined) {
        delete process.env.STRATOSORT_FORCE_SOFTWARE_GPU;
      } else {
        process.env.STRATOSORT_FORCE_SOFTWARE_GPU = originalSoftware;
      }
    });

    test('skips cuda when node-llama-cpp reports only vulkan as supported', async () => {
      const getLlama = jest.fn().mockResolvedValue({ gpu: 'vulkan' });
      const getLlamaGpuTypes = jest.fn().mockResolvedValue(['vulkan', false]);

      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda', name: 'RTX 4090' },
        logger: mockLogger,
        context: 'test',
        getLlamaGpuTypes
      });

      expect(getLlamaGpuTypes).toHaveBeenCalledWith('supported');
      expect(getLlama).toHaveBeenCalledTimes(1);
      expect(getLlama).toHaveBeenNthCalledWith(1, { gpu: 'vulkan' });
      expect(getLlama.mock.calls.some(([opts]) => opts.gpu === 'cuda')).toBe(false);
      expect(result.backend).toBe('vulkan');
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[test] Llama backend candidates filtered by node-llama-cpp support',
        expect.objectContaining({
          supported: ['vulkan', false],
          candidates: ['cuda', 'vulkan', 'auto'],
          filtered: ['vulkan', false],
          changed: true
        })
      );
    });

    test('tries CPU (not auto) after the last supported GPU candidate fails', async () => {
      const getLlama = jest
        .fn()
        .mockRejectedValueOnce(new Error('Vulkan init failed'))
        .mockResolvedValueOnce({ gpu: false });
      const getLlamaGpuTypes = jest.fn().mockResolvedValue(['vulkan', false]);

      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test',
        getLlamaGpuTypes
      });

      expect(result.backend).toBe('cpu');
      expect(getLlama).toHaveBeenCalledTimes(2);
      expect(getLlama).toHaveBeenNthCalledWith(1, { gpu: 'vulkan' });
      expect(getLlama).toHaveBeenNthCalledWith(2, { gpu: false });
      expect(result.selection.attempted.map((entry) => entry.backend)).toEqual(['vulkan', false]);
    });

    test('uses the unfiltered ladder when getLlamaGpuTypes rejects', async () => {
      const getLlama = jest.fn().mockResolvedValue({ gpu: 'cuda' });
      const getLlamaGpuTypes = jest.fn().mockRejectedValue(new Error('probe exploded'));

      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test',
        getLlamaGpuTypes
      });

      expect(result.backend).toBe('cuda');
      expect(getLlama).toHaveBeenNthCalledWith(1, { gpu: 'cuda' });
      expect(mockLogger.debug).toHaveBeenCalledWith(
        '[test] node-llama-cpp supported-backend probe failed',
        expect.objectContaining({ error: 'probe exploded' })
      );
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        '[test] Llama backend candidates filtered by node-llama-cpp support',
        expect.anything()
      );
    });

    test('uses the unfiltered ladder when getLlamaGpuTypes resolves a non-array', async () => {
      const getLlama = jest.fn().mockResolvedValue({ gpu: 'cuda' });
      const getLlamaGpuTypes = jest.fn().mockResolvedValue(undefined);

      await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test',
        getLlamaGpuTypes
      });

      expect(getLlama).toHaveBeenNthCalledWith(1, { gpu: 'cuda' });
    });

    test('skips the filter when STRATOSORT_LLM_GPU_BACKEND forces a backend', async () => {
      process.env.STRATOSORT_LLM_GPU_BACKEND = 'cuda';
      const getLlama = jest.fn().mockResolvedValue({ gpu: 'cuda' });
      const getLlamaGpuTypes = jest.fn().mockResolvedValue(['vulkan', false]);

      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'vulkan' },
        logger: mockLogger,
        context: 'test',
        getLlamaGpuTypes
      });

      expect(getLlamaGpuTypes).not.toHaveBeenCalled();
      expect(getLlama).toHaveBeenNthCalledWith(1, { gpu: 'cuda' });
      expect(result.backend).toBe('cuda');
    });

    test('skips the probe when the candidate chain has no explicit GPU entry', async () => {
      process.env.STRATOSORT_FORCE_SOFTWARE_GPU = '1'; // -> [false]
      const getLlama = jest.fn().mockResolvedValue({ gpu: false });
      const getLlamaGpuTypes = jest.fn().mockResolvedValue(['cuda', 'vulkan', false]);

      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test',
        getLlamaGpuTypes
      });

      expect(getLlamaGpuTypes).not.toHaveBeenCalled();
      expect(getLlama).toHaveBeenCalledWith({ gpu: false });
      expect(result.backend).toBe('cpu');
    });

    test('still passes llamaLogger to filtered attempts', async () => {
      const getLlama = jest.fn().mockResolvedValue({ gpu: 'vulkan' });
      const getLlamaGpuTypes = jest.fn().mockResolvedValue(['vulkan', false]);
      const llamaLogger = jest.fn();

      await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test',
        llamaLogger,
        getLlamaGpuTypes
      });

      expect(getLlama).toHaveBeenCalledWith({ gpu: 'vulkan', logger: llamaLogger });
    });

    test('records a numeric durationMs on every attempt, including the CPU fallback', async () => {
      const getLlama = jest
        .fn()
        .mockRejectedValueOnce(new Error('CUDA failed'))
        .mockRejectedValueOnce(new Error('Vulkan failed'))
        .mockRejectedValueOnce(new Error('Auto failed'))
        .mockResolvedValueOnce({ gpu: false });

      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test'
      });

      expect(result.selection.attempted).toHaveLength(4);
      for (const entry of result.selection.attempted) {
        expect(typeof entry.durationMs).toBe('number');
        expect(Number.isFinite(entry.durationMs)).toBe(true);
        expect(entry.durationMs).toBeGreaterThanOrEqual(0);
      }
      // The failure warning and the final CPU fallback both carry the timing.
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[test] Llama backend init failed',
        expect.objectContaining({ backend: 'cuda', durationMs: expect.any(Number) })
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[test] Falling back to CPU backend',
        expect.objectContaining({
          durationMs: expect.any(Number),
          attempted: expect.arrayContaining([
            expect.objectContaining({ backend: 'cuda', durationMs: expect.any(Number) })
          ])
        })
      );
    });

    test('includes durationMs in the selected-backend log', async () => {
      const getLlama = jest.fn().mockResolvedValue({ gpu: 'cuda' });

      await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test'
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        '[test] Llama backend selected',
        expect.objectContaining({
          requested: 'cuda',
          actual: 'cuda',
          durationMs: expect.any(Number),
          attempted: [expect.objectContaining({ backend: 'cuda', durationMs: expect.any(Number) })]
        })
      );
    });

    test('warns when a single candidate exceeds the slow threshold', async () => {
      jest.useFakeTimers();
      const getLlama = jest.fn(async () => {
        jest.advanceTimersByTime(SLOW_BACKEND_ATTEMPT_WARN_MS + 1);
        return { gpu: 'cuda' };
      });

      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test'
      });

      expect(result.selection.attempted[0].durationMs).toBeGreaterThan(
        SLOW_BACKEND_ATTEMPT_WARN_MS
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[test] Llama backend attempt exceeded slow threshold',
        expect.objectContaining({
          backend: 'cuda',
          durationMs: expect.any(Number),
          thresholdMs: SLOW_BACKEND_ATTEMPT_WARN_MS
        })
      );
    });

    test('warns for a slow candidate that fails, too', async () => {
      jest.useFakeTimers();
      const getLlama = jest
        .fn()
        .mockImplementationOnce(async () => {
          jest.advanceTimersByTime(SLOW_BACKEND_ATTEMPT_WARN_MS + 1);
          throw new Error('CUDA failed slowly');
        })
        .mockResolvedValue({ gpu: 'vulkan' });

      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test'
      });

      expect(result.backend).toBe('vulkan');
      expect(result.selection.attempted[0]).toMatchObject({ backend: 'cuda', success: false });
      expect(result.selection.attempted[0].durationMs).toBeGreaterThan(
        SLOW_BACKEND_ATTEMPT_WARN_MS
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[test] Llama backend attempt exceeded slow threshold',
        expect.objectContaining({ backend: 'cuda' })
      );
    });

    test('does not warn about slowness for fast attempts', async () => {
      const getLlama = jest.fn().mockResolvedValue({ gpu: 'cuda' });

      await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test'
      });

      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        '[test] Llama backend attempt exceeded slow threshold',
        expect.anything()
      );
    });

    test('forwards node-llama-cpp console output into the logger during an attempt', async () => {
      const originalWarn = console.warn;
      const originalError = console.error;
      const getLlama = jest.fn(async () => {
        console.warn(
          '[node-llama-cpp] The prebuilt binary for platform "win" "x64" with CUDA support is not compatible with the current system, falling back to using Vulkan'
        );
        console.error(
          '[node-llama-cpp] Failed to load a prebuilt binary. Error:',
          new Error('boom')
        );
        return { gpu: 'vulkan' };
      });

      await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'vulkan' },
        logger: mockLogger,
        context: 'test'
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[test] [node-llama-cpp] The prebuilt binary for platform "win" "x64" with CUDA support is not compatible with the current system, falling back to using Vulkan',
        expect.objectContaining({ consoleLevel: 'warn', backend: 'vulkan' })
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[test\] \[node-llama-cpp\] Failed to load a prebuilt binary\. Error: Error: boom/
        ),
        expect.objectContaining({ consoleLevel: 'error', backend: 'vulkan' })
      );
      // Console is restored once the attempt settles.
      expect(console.warn).toBe(originalWarn);
      expect(console.error).toBe(originalError);
    });

    test('strips a colourised node-llama-cpp prefix before forwarding', async () => {
      const esc = String.fromCharCode(27);
      const getLlama = jest.fn(async () => {
        console.warn(
          `${esc}[90m[node-llama-cpp]${esc}[39m A prebuilt binary was not found, falling back to using CPU`
        );
        return { gpu: 'vulkan' };
      });

      await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'vulkan' },
        logger: mockLogger,
        context: 'test'
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[test] [node-llama-cpp] A prebuilt binary was not found, falling back to using CPU',
        expect.objectContaining({ consoleLevel: 'warn' })
      );
    });

    test('passes unprefixed console output through untouched', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const getLlama = jest.fn(async () => {
          // Orama initialises in the same Promise.all as the Llama backend.
          console.warn('[Orama] index restored with warnings');
          return { gpu: 'vulkan' };
        });

        await initLlamaWithBackend({
          getLlama,
          gpuInfo: { type: 'vulkan' },
          logger: mockLogger,
          context: 'test'
        });

        expect(warnSpy).toHaveBeenCalledWith('[Orama] index restored with warnings');
        expect(mockLogger.warn).not.toHaveBeenCalledWith(
          expect.stringContaining('[node-llama-cpp] [Orama]'),
          expect.anything()
        );
        // The wrapper hands back the console it found.
        expect(console.warn).toBe(warnSpy);
      } finally {
        warnSpy.mockRestore();
      }
    });

    test('restores console even when getLlama throws', async () => {
      const originalWarn = console.warn;
      const originalError = console.error;
      const getLlama = jest.fn().mockRejectedValue(new Error('fatal'));

      await expect(
        initLlamaWithBackend({
          getLlama,
          gpuInfo: { type: 'vulkan' },
          logger: mockLogger,
          context: 'test'
        })
      ).rejects.toThrow(/Failed to initialize Llama backend/);

      expect(console.warn).toBe(originalWarn);
      expect(console.error).toBe(originalError);
    });

    test('does not touch console when no logger is supplied', async () => {
      const originalWarn = console.warn;
      let warnDuringAttempt = null;
      const getLlama = jest.fn(async () => {
        warnDuringAttempt = console.warn;
        return { gpu: 'auto' };
      });

      await initLlamaWithBackend({ getLlama, gpuInfo: null, context: 'test' });

      expect(warnDuringAttempt).toBe(originalWarn);
      expect(console.warn).toBe(originalWarn);
    });
  });

  // ─── prioritizeCachedBackend ───────────────────────────────

  describe('prioritizeCachedBackend', () => {
    test('moves a cached backend already in the list to the front', () => {
      expect(prioritizeCachedBackend(['cuda', 'vulkan', 'auto'], 'vulkan')).toEqual([
        'vulkan',
        'cuda',
        'auto'
      ]);
      expect(prioritizeCachedBackend(['cuda', 'vulkan', false], 'vulkan')).toEqual([
        'vulkan',
        'cuda',
        false
      ]);
    });

    test('leaves the list as-is when the cached backend already leads', () => {
      expect(prioritizeCachedBackend(['cuda', 'vulkan', 'auto'], 'cuda')).toEqual([
        'cuda',
        'vulkan',
        'auto'
      ]);
    });

    test('inserts a cached backend ahead of auto when the list does not name it', () => {
      expect(prioritizeCachedBackend(['auto'], 'vulkan')).toEqual(['vulkan', 'auto']);
      expect(prioritizeCachedBackend(['vulkan', 'auto'], 'cuda')).toEqual([
        'cuda',
        'vulkan',
        'auto'
      ]);
    });

    test('leaves CPU-only and auto-free lists alone', () => {
      expect(prioritizeCachedBackend([false], 'cuda')).toEqual([false]);
      expect(prioritizeCachedBackend(['vulkan', false], 'cuda')).toEqual(['vulkan', false]);
    });

    test('ignores anything that is not an explicit GPU backend', () => {
      const candidates = ['cuda', 'vulkan', 'auto'];
      for (const cached of [null, undefined, '', 'cpu', 'auto', false, 'directml', 42]) {
        expect(prioritizeCachedBackend(candidates, cached)).toEqual(candidates);
      }
    });

    test('does not mutate its input', () => {
      const candidates = ['cuda', 'vulkan', 'auto'];
      prioritizeCachedBackend(candidates, 'vulkan');
      prioritizeCachedBackend(candidates, 'metal');
      expect(candidates).toEqual(['cuda', 'vulkan', 'auto']);
    });

    test('composes with the support filter in either order for a listed backend', () => {
      const supported = ['cuda', 'vulkan', false];
      const reorderedThenFiltered = filterCandidatesBySupport(
        prioritizeCachedBackend(['cuda', 'vulkan', 'auto'], 'vulkan'),
        supported
      );
      const filteredThenReordered = prioritizeCachedBackend(
        filterCandidatesBySupport(['cuda', 'vulkan', 'auto'], supported),
        'vulkan'
      );
      expect(reorderedThenFiltered).toEqual(['vulkan', 'cuda', false]);
      expect(filteredThenReordered).toEqual(reorderedThenFiltered);
    });

    test('lets the support filter drop a cached backend whose runtime is gone', () => {
      expect(
        filterCandidatesBySupport(prioritizeCachedBackend(['cuda', 'vulkan', 'auto'], 'cuda'), [
          'vulkan',
          false
        ])
      ).toEqual(['vulkan', false]);
      // Inserted ahead of auto, then ruled out: back to plain auto.
      expect(
        filterCandidatesBySupport(prioritizeCachedBackend(['auto'], 'vulkan'), [false])
      ).toEqual(['auto']);
    });
  });

  // ─── initLlamaWithBackend: last-known-good backend record ───

  describe('initLlamaWithBackend with backendCache', () => {
    const mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };
    const ENV_KEYS = [
      'STRATOSORT_LLM_GPU_BACKEND',
      'STRATOSORT_FORCE_SOFTWARE_GPU',
      'ELECTRON_FORCE_SOFTWARE'
    ];
    const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    const originalArgv = process.argv;

    /** @param {string|null} cached */
    const makeBackendCache = (cached) => ({
      read: jest.fn().mockResolvedValue(cached),
      write: jest.fn().mockResolvedValue(true),
      clear: jest.fn().mockResolvedValue(undefined)
    });

    const requestedGpus = (getLlama) => getLlama.mock.calls.map(([opts]) => opts.gpu);

    beforeEach(() => {
      jest.clearAllMocks();
      for (const key of ENV_KEYS) delete process.env[key];
      process.argv = originalArgv.filter((arg) => arg !== '--safe-mode');
    });

    afterEach(() => {
      process.argv = originalArgv;
      for (const key of ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
      }
    });

    test('tries the cached backend first, so a hit tests a single binary', async () => {
      const backendCache = makeBackendCache('vulkan');
      const getLlama = jest.fn().mockResolvedValue({ gpu: 'vulkan' });
      const getLlamaGpuTypes = jest.fn().mockResolvedValue(['cuda', 'vulkan', false]);

      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda', name: 'RTX 4070' },
        logger: mockLogger,
        context: 'test',
        getLlamaGpuTypes,
        backendCache
      });

      expect(result.backend).toBe('vulkan');
      expect(requestedGpus(getLlama)).toEqual(['vulkan']);
      expect(result.selection.attempted).toHaveLength(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[test] Llama backend candidates ordered by cached selection',
        expect.objectContaining({
          cachedBackend: 'vulkan',
          candidates: ['cuda', 'vulkan', 'auto'],
          prioritized: ['vulkan', 'cuda', 'auto'],
          changed: true
        })
      );
      // Steady state: the record already says vulkan, so nothing is written.
      expect(backendCache.write).not.toHaveBeenCalled();
      expect(backendCache.clear).not.toHaveBeenCalled();
    });

    test("passes this launch's supported-backend set to the record on read and write", async () => {
      const backendCache = makeBackendCache(null);
      const getLlama = jest.fn().mockResolvedValue({ gpu: 'cuda' });
      const getLlamaGpuTypes = jest.fn().mockResolvedValue(['cuda', 'vulkan', false]);

      await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test',
        getLlamaGpuTypes,
        backendCache
      });

      // The probe runs before the record is read: the set is part of its key.
      expect(getLlamaGpuTypes.mock.invocationCallOrder[0]).toBeLessThan(
        backendCache.read.mock.invocationCallOrder[0]
      );
      expect(backendCache.read).toHaveBeenCalledWith({
        supportedGpuTypes: ['cuda', 'vulkan', false]
      });
      expect(backendCache.write).toHaveBeenCalledWith('cuda', {
        supportedGpuTypes: ['cuda', 'vulkan', false]
      });
    });

    test('a Vulkan record saved while CUDA was unsupported does not keep CUDA behind it', async () => {
      // Real record on disk: a driver-only launch (CUDA runtime missing) saved
      // vulkan; the user then installed a CUDA toolkit.
      const fsp = require('fs').promises;
      const os = require('os');
      const path = require('path');
      const { createLlamaBackendCache } = require('../src/main/utils/llamaBackendCache');
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'llama-selector-cache-'));
      const makeRealCache = () =>
        createLlamaBackendCache({
          userDataPath,
          appVersion: '5.0.1',
          nodeLlamaVersion: '3.22.2',
          gpuInfo: { type: 'cuda', name: 'NVIDIA GeForce RTX 4070' }
        });
      try {
        const driverOnly = await initLlamaWithBackend({
          getLlama: jest.fn().mockResolvedValue({ gpu: 'vulkan' }),
          gpuInfo: { type: 'cuda', name: 'NVIDIA GeForce RTX 4070' },
          logger: mockLogger,
          context: 'test',
          getLlamaGpuTypes: jest.fn().mockResolvedValue(['vulkan', false]),
          backendCache: makeRealCache()
        });
        expect(driverOnly.backend).toBe('vulkan');
        await expect(makeRealCache().read({ supportedGpuTypes: ['vulkan', false] })).resolves.toBe(
          'vulkan'
        );

        const getLlama = jest.fn().mockResolvedValue({ gpu: 'cuda' });
        const withToolkit = await initLlamaWithBackend({
          getLlama,
          gpuInfo: { type: 'cuda', name: 'NVIDIA GeForce RTX 4070' },
          logger: mockLogger,
          context: 'test',
          getLlamaGpuTypes: jest.fn().mockResolvedValue(['cuda', 'vulkan', false]),
          backendCache: makeRealCache()
        });

        expect(requestedGpus(getLlama)[0]).toBe('cuda');
        expect(withToolkit.backend).toBe('cuda');
        // The record now says cuda for the new supported set.
        await expect(
          makeRealCache().read({ supportedGpuTypes: ['cuda', 'vulkan', false] })
        ).resolves.toBe('cuda');
      } finally {
        await fsp.rm(userDataPath, { recursive: true, force: true, maxRetries: 3 });
      }
    });

    test('a cached backend that already leads changes nothing and is not rewritten', async () => {
      const backendCache = makeBackendCache('cuda');
      const getLlama = jest.fn().mockResolvedValue({ gpu: 'cuda' });

      await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test',
        backendCache
      });

      expect(requestedGpus(getLlama)).toEqual(['cuda']);
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[test] Llama backend candidates ordered by cached selection',
        expect.objectContaining({ prioritized: ['cuda', 'vulkan', 'auto'], changed: false })
      );
      expect(backendCache.write).not.toHaveBeenCalled();
    });

    test('runs the plain ladder on a cache miss and saves the GPU backend it lands on', async () => {
      const backendCache = makeBackendCache(null);
      const getLlama = jest
        .fn()
        .mockRejectedValueOnce(new Error('CUDA binary test failed'))
        .mockResolvedValueOnce({ gpu: 'vulkan' });

      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test',
        backendCache
      });

      expect(result.backend).toBe('vulkan');
      expect(requestedGpus(getLlama)).toEqual(['cuda', 'vulkan']);
      expect(backendCache.write).toHaveBeenCalledTimes(1);
      expect(backendCache.write).toHaveBeenCalledWith('vulkan', { supportedGpuTypes: null });
      expect(backendCache.clear).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[test] Saved Llama backend selection for the next launch',
        { backend: 'vulkan', previous: null }
      );
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        '[test] Llama backend candidates ordered by cached selection',
        expect.anything()
      );
    });

    test('clears the record when the cached attempt fails, then continues the ladder', async () => {
      const backendCache = makeBackendCache('vulkan');
      const getLlama = jest
        .fn()
        .mockRejectedValueOnce(new Error('Vulkan binary test failed'))
        .mockResolvedValueOnce({ gpu: 'cuda' });

      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test',
        backendCache
      });

      expect(result.backend).toBe('cuda');
      expect(requestedGpus(getLlama)).toEqual(['vulkan', 'cuda']);
      expect(backendCache.clear).toHaveBeenCalledTimes(1);
      // Cleared before the next candidate is tried.
      expect(backendCache.clear.mock.invocationCallOrder[0]).toBeLessThan(
        getLlama.mock.invocationCallOrder[1]
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[test] Cleared cached Llama backend after it failed',
        { backend: 'vulkan', error: 'Vulkan binary test failed' }
      );
      expect(backendCache.write).toHaveBeenCalledWith('cuda', { supportedGpuTypes: null });
    });

    test('a read-only record (the embedding worker) is used but never cleared or written', async () => {
      const read = jest.fn().mockResolvedValue('vulkan');
      const getLlama = jest
        .fn()
        .mockRejectedValueOnce(new Error('Vulkan binary test failed'))
        .mockResolvedValueOnce({ gpu: 'cuda' });

      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test',
        backendCache: { read }
      });

      expect(result.backend).toBe('cuda');
      expect(requestedGpus(getLlama)).toEqual(['vulkan', 'cuda']);
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[test] Cached Llama backend failed; record left to its owner',
        { backend: 'vulkan', error: 'Vulkan binary test failed' }
      );
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        '[test] Cleared cached Llama backend after it failed',
        expect.anything()
      );
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        '[test] Saved Llama backend selection for the next launch',
        expect.anything()
      );
    });

    test('clears the record and saves nothing when the ladder ends on CPU', async () => {
      const backendCache = makeBackendCache('cuda');
      const getLlama = jest
        .fn()
        .mockRejectedValueOnce(new Error('CUDA failed'))
        .mockRejectedValueOnce(new Error('Vulkan failed'))
        .mockRejectedValueOnce(new Error('Auto failed'))
        .mockResolvedValueOnce({ gpu: false });

      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test',
        backendCache
      });

      expect(result.backend).toBe('cpu');
      expect(backendCache.clear).toHaveBeenCalledTimes(1);
      expect(backendCache.write).not.toHaveBeenCalled();
    });

    test('only the cached backend failing clears the record', async () => {
      const backendCache = makeBackendCache('vulkan');
      const getLlama = jest.fn().mockResolvedValue({ gpu: 'vulkan' });

      await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test',
        backendCache
      });

      expect(backendCache.clear).not.toHaveBeenCalled();
    });

    test('inserts a cached backend ahead of auto and runs it past the support probe', async () => {
      // GPUMonitor saw only a Vulkan adapter (WMI fallback), but last launch
      // auto resolved to CUDA on this same fingerprint.
      const backendCache = makeBackendCache('cuda');
      const getLlama = jest.fn().mockResolvedValue({ gpu: 'cuda' });
      const getLlamaGpuTypes = jest.fn().mockResolvedValue(['cuda', 'vulkan', false]);

      await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'vulkan' },
        logger: mockLogger,
        context: 'test',
        getLlamaGpuTypes,
        backendCache
      });

      expect(requestedGpus(getLlama)).toEqual(['cuda']);
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[test] Llama backend candidates filtered by node-llama-cpp support',
        expect.objectContaining({
          candidates: ['cuda', 'vulkan', 'auto'],
          filtered: ['cuda', 'vulkan', false]
        })
      );
    });

    test('a cached backend the support probe rules out is skipped but not cleared', async () => {
      const backendCache = makeBackendCache('cuda');
      const getLlama = jest.fn().mockResolvedValue({ gpu: 'vulkan' });
      const getLlamaGpuTypes = jest.fn().mockResolvedValue(['vulkan', false]);

      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test',
        getLlamaGpuTypes,
        backendCache
      });

      expect(result.backend).toBe('vulkan');
      expect(requestedGpus(getLlama)).toEqual(['vulkan']);
      expect(backendCache.clear).not.toHaveBeenCalled();
      // The ladder settled elsewhere, so the record is replaced.
      expect(backendCache.write).toHaveBeenCalledWith('vulkan', {
        supportedGpuTypes: ['vulkan', false]
      });
    });

    test('saves the backend auto actually resolved to', async () => {
      const backendCache = makeBackendCache(null);
      const getLlama = jest
        .fn()
        .mockRejectedValueOnce(new Error('Vulkan failed'))
        .mockResolvedValueOnce({ gpu: 'cuda' });

      await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'vulkan' },
        logger: mockLogger,
        context: 'test',
        backendCache
      });

      expect(requestedGpus(getLlama)).toEqual(['vulkan', 'auto']);
      expect(backendCache.write).toHaveBeenCalledWith('cuda', { supportedGpuTypes: null });
    });

    test('never saves a CPU result, even when auto lands on it', async () => {
      const backendCache = makeBackendCache(null);
      const getLlama = jest.fn().mockResolvedValue({ gpu: false });

      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'vulkan' },
        logger: mockLogger,
        context: 'test',
        backendCache
      });

      expect(result.backend).toBe('cpu');
      expect(backendCache.write).not.toHaveBeenCalled();
    });

    test('ignores a record value that is not an explicit GPU backend', async () => {
      const backendCache = makeBackendCache('cpu');
      const getLlama = jest.fn().mockResolvedValue({ gpu: 'cuda' });

      await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test',
        backendCache
      });

      expect(requestedGpus(getLlama)).toEqual(['cuda']);
      expect(backendCache.write).toHaveBeenCalledWith('cuda', { supportedGpuTypes: null });
    });

    test.each([
      [
        'STRATOSORT_LLM_GPU_BACKEND override',
        () => (process.env.STRATOSORT_LLM_GPU_BACKEND = 'vulkan')
      ],
      ['--safe-mode', () => (process.argv = [...process.argv, '--safe-mode'])],
      ['software rendering mode', () => (process.env.STRATOSORT_FORCE_SOFTWARE_GPU = '1')]
    ])('bypasses the record entirely under %s', async (_label, activate) => {
      activate();
      const backendCache = makeBackendCache('cuda');
      const getLlama = jest.fn().mockResolvedValue({ gpu: 'vulkan' });

      await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'vulkan' },
        logger: mockLogger,
        context: 'test',
        backendCache
      });

      expect(backendCache.read).not.toHaveBeenCalled();
      expect(backendCache.write).not.toHaveBeenCalled();
      expect(backendCache.clear).not.toHaveBeenCalled();
      expect(requestedGpus(getLlama)[0]).not.toBe('cuda');
    });

    test('a record that fails to read falls back to the plain ladder', async () => {
      const backendCache = makeBackendCache(null);
      backendCache.read.mockRejectedValue(new Error('EACCES'));
      const getLlama = jest.fn().mockResolvedValue({ gpu: 'cuda' });

      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test',
        backendCache
      });

      expect(result.backend).toBe('cuda');
      expect(requestedGpus(getLlama)).toEqual(['cuda']);
      expect(mockLogger.debug).toHaveBeenCalledWith('[test] Cached Llama backend read failed', {
        error: 'EACCES'
      });
    });

    test('a write or clear that throws never fails the selection', async () => {
      const backendCache = makeBackendCache('vulkan');
      backendCache.clear.mockRejectedValue(new Error('EPERM'));
      backendCache.write.mockRejectedValue(new Error('ENOSPC'));
      const getLlama = jest
        .fn()
        .mockRejectedValueOnce(new Error('Vulkan failed'))
        .mockResolvedValueOnce({ gpu: 'cuda' });

      const result = await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test',
        backendCache
      });

      expect(result.backend).toBe('cuda');
      expect(result.llama).toEqual({ gpu: 'cuda' });
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        '[test] Saved Llama backend selection for the next launch',
        expect.anything()
      );
    });

    test('keeps the exact getLlama option shape when a cache is supplied', async () => {
      const backendCache = makeBackendCache('cuda');
      const getLlama = jest.fn().mockResolvedValue({ gpu: 'cuda' });

      await initLlamaWithBackend({
        getLlama,
        gpuInfo: { type: 'cuda' },
        logger: mockLogger,
        context: 'test',
        backendCache
      });

      expect(getLlama).toHaveBeenCalledWith({ gpu: 'cuda' });
    });
  });
});
