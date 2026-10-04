/**
 * @jest-environment node
 *
 * Tests for llamaBackendSelector.js covering:
 *  - buildBackendCandidates() for CUDA, Metal, Vulkan, and unknown GPU types
 *  - initLlamaWithBackend() happy path: GPU backend selected
 *  - initLlamaWithBackend() fallback: GPU fails, CPU succeeds
 *  - initLlamaWithBackend() fatal: all backends fail
 *  - Null/missing gpuInfo handling
 */

const {
  getGpuBackendOverride,
  buildBackendCandidates,
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
});
