/**
 * Tests for VisionService.
 * Covers server lifecycle, analyzeImage, shutdown, and availability checks.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

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
    __mockLogger: logger
  };
});

jest.mock('../src/shared/singletonFactory', () => ({
  createSingletonHelpers: () => ({
    getInstance: jest.fn(),
    createInstance: jest.fn(),
    registerWithContainer: jest.fn(),
    resetInstance: jest.fn()
  })
}));

jest.mock('../src/shared/performanceConstants', () => ({
  TIMEOUTS: { AI_ANALYSIS_LONG: 300000, HEALTH_CHECK: 5000 }
}));

jest.mock('../src/main/utils/runtimePaths', () => ({
  resolveRuntimePath: jest.fn(() => '/mock/bundled/llama-server')
}));

jest.mock('../src/shared/platformUtils', () => ({
  getNvidiaSmiCommand: jest.fn(() => 'nvidia-smi.exe')
}));

// Mock child_process (VisionService uses async exec/execFile for GPU detection)
jest.mock('child_process', () => {
  const mockExecFile = jest.fn((cmd, args, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb;
    if (typeof callback === 'function') callback(null, { toString: () => '' }, '');
  });
  const mockExec = jest.fn((cmd, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb;
    if (typeof callback === 'function') callback(null, '', '');
  });
  return {
    spawn: jest.fn(),
    execSync: jest.fn(),
    execFileSync: jest.fn(),
    execFile: mockExecFile,
    exec: mockExec
  };
});

// Mock adm-zip and tar (not needed in unit tests)
jest.mock('adm-zip', () => jest.fn());
jest.mock('tar', () => ({ x: jest.fn() }));

const {
  VisionService,
  _resetRuntimeCache,
  _getAssetConfig,
  _createUtf8ChunkDecoder,
  _detectBase64Mime,
  _detectMimeFromPath
} = require('../src/main/services/VisionService');
const { getInstance: getGPUMonitor } = require('../src/main/services/GPUMonitor');
const { execFile } = require('child_process');
const { __mockLogger } = require('../src/shared/logger');

describe('VisionService', () => {
  let service;

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    _resetRuntimeCache();
    // VisionService shares the process-wide GPUMonitor singleton, which caches
    // its first detection; clear it so each test's child_process mock is
    // probed afresh. The singleton also records process.platform when it is
    // constructed, i.e. the real platform of the machine running the suite;
    // tests here redefine process.platform per case, so make the shared
    // instance follow it like the per-call monitor it replaced.
    const sharedGpuMonitor = getGPUMonitor();
    sharedGpuMonitor._gpuInfo = null;
    Object.defineProperty(sharedGpuMonitor, '_platform', {
      configurable: true,
      get: () => process.platform
    });
    service = new VisionService();
  });

  describe('constructor', () => {
    test('initializes with null state', () => {
      expect(service._process).toBeNull();
      expect(service._port).toBeNull();
      expect(service._binaryPath).toBeNull();
      expect(service._activeConfig).toBeNull();
    });

    test('starts not ready', () => {
      expect(service._isReady).toBe(false);
    });
  });

  describe('_buildServerArgs', () => {
    test('includes --api-key when a session key is provided', () => {
      const args = service._buildServerArgs({ modelPath: '/models/vision.gguf' }, 12345, 'secret');
      expect(args).toContain('--api-key');
      expect(args[args.indexOf('--api-key') + 1]).toBe('secret');
      expect(args).toContain('127.0.0.1');
    });
  });

  describe('_isReady lifecycle', () => {
    function createFakeChild() {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = jest.fn();
      child.pid = 4242;
      return child;
    }

    test('becomes ready only after the startup health check resolves', async () => {
      const child = createFakeChild();
      const { spawn } = require('child_process');
      spawn.mockReturnValue(child);
      service._ensureBinary = jest.fn().mockResolvedValue('/mock/llama-server');

      let resolveHealth;
      service._waitForHealth = jest.fn(
        () =>
          new Promise((resolve) => {
            resolveHealth = resolve;
          })
      );

      const startPromise = service._startServer({ modelPath: '/m.gguf' });
      // Let the spawn happen and _port get assigned (the pre-fix race window)
      await new Promise((resolve) => setImmediate(resolve));

      expect(service._port).not.toBeNull();
      expect(service._isReady).toBe(false); // mid-startup: port set, NOT ready

      resolveHealth();
      await startPromise;

      expect(service._isReady).toBe(true);

      // Runtime crash clears readiness
      child.emit('exit', 1, null);
      expect(service._isReady).toBe(false);
    });

    test('a spawn error fails the start at once instead of polling a dead port', async () => {
      const child = createFakeChild();
      const { spawn } = require('child_process');
      spawn.mockReturnValue(child);
      service._ensureBinary = jest.fn().mockResolvedValue('/mock/llama-server');
      let healthSignal;
      // Never resolves: without the fix the start waits out the whole
      // startup timeout.
      service._waitForHealth = jest.fn((port, timeoutMs, signal) => {
        healthSignal = signal;
        return new Promise(() => {});
      });

      const startPromise = service._startServer({ modelPath: '/m.gguf' });
      const outcome = Promise.race([
        startPromise.then(
          () => 'started',
          (error) => error
        ),
        new Promise((resolve) => setTimeout(() => resolve('still waiting'), 500))
      ]);
      await new Promise((resolve) => setImmediate(resolve));
      child.emit('error', new Error('spawn /mock/llama-server ENOENT'));

      const result = await outcome;
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toMatch(/Vision runtime failed to start: spawn .* ENOENT/);
      expect(healthSignal.aborted).toBe(true);
      expect(service._process).toBeNull();
      expect(service._isReady).toBe(false);
    });

    test('a stale exit from an old child does not clobber a newer child state', async () => {
      const childA = createFakeChild();
      const { spawn } = require('child_process');
      spawn.mockReturnValue(childA);
      service._ensureBinary = jest.fn().mockResolvedValue('/mock/llama-server');
      service._waitForHealth = jest.fn().mockResolvedValue(undefined);

      await service._startServer({ modelPath: '/m.gguf' });
      expect(service._process).toBe(childA);

      // A crash-then-restart has swapped in a newer child. The identity guard
      // must make the OLD child's late exit event a no-op so it can't null out
      // the new child's shared state.
      const childB = createFakeChild();
      service._process = childB;
      service._port = 9999;
      service._isReady = true;

      childA.emit('exit', 1, null);

      expect(service._process).toBe(childB);
      expect(service._port).toBe(9999);
      expect(service._isReady).toBe(true);
    });

    test('shutdown clears readiness', async () => {
      const mockProc = {
        kill: jest.fn(),
        once: jest.fn((event, cb) => {
          if (event === 'exit') cb(0, null);
        }),
        removeListener: jest.fn(),
        removeAllListeners: jest.fn()
      };
      service._process = mockProc;
      service._port = 8080;
      service._isReady = true;

      await service.shutdown();

      expect(service._isReady).toBe(false);
    });
  });

  describe('memory budget registration (ML-01, ML-05)', () => {
    const GiB = 1024 * 1024 * 1024;
    let manager;

    function createFakeChild() {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = jest.fn();
      child.pid = 4243;
      return child;
    }

    beforeEach(() => {
      manager = {
        registerExternalConsumer: jest.fn(() => true),
        unregisterExternalConsumer: jest.fn(() => true),
        acquireRef: jest.fn(),
        releaseRef: jest.fn()
      };
      service._memoryManagerOverride = manager;
      service.estimateRuntimeMemoryBytes = jest.fn().mockResolvedValue(5 * GiB);
    });

    async function startReadyServer() {
      const child = createFakeChild();
      const { spawn } = require('child_process');
      spawn.mockReturnValue(child);
      service._ensureBinary = jest.fn().mockResolvedValue('/mock/llama-server');
      service._waitForHealth = jest.fn().mockResolvedValue(undefined);
      await service._startServer({
        modelPath: '/models/vision.gguf',
        mmprojPath: '/models/mmproj.gguf'
      });
      return child;
    }

    test('registers the running child with the budget once the health check passes', async () => {
      await startReadyServer();

      expect(manager.registerExternalConsumer).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'vision-runtime',
          sizeBytes: 5 * GiB,
          label: 'llama-server:vision.gguf',
          dispose: expect.any(Function)
        })
      );
      expect(service.estimateRuntimeMemoryBytes).toHaveBeenCalledWith(
        expect.objectContaining({
          modelPath: '/models/vision.gguf',
          mmprojPath: '/models/mmproj.gguf'
        })
      );
      expect(service._memoryRegistration).toEqual({ manager, type: 'vision-runtime' });
    });

    test('the memory is reserved from before the spawn until the start is over', async () => {
      const order = [];
      const endReservation = jest.fn(() => order.push('reservation ended'));
      manager.reserveLoad = jest.fn(() => {
        order.push('reserved');
        return endReservation;
      });
      manager.registerExternalConsumer.mockImplementation(() => {
        order.push('registered');
        return true;
      });
      const { spawn } = require('child_process');
      spawn.mockImplementation(() => {
        order.push('spawned');
        return createFakeChild();
      });
      service._ensureBinary = jest.fn().mockResolvedValue('/mock/llama-server');
      service._waitForHealth = jest.fn().mockResolvedValue(undefined);

      await service._startServer({ modelPath: '/models/vision.gguf' });

      expect(manager.reserveLoad).toHaveBeenCalledWith('vision-runtime', 5 * GiB);
      expect(order).toEqual(['reserved', 'spawned', 'registered', 'reservation ended']);
    });

    test('memory is not reserved while the runtime binary is found, which can be a download', async () => {
      const order = [];
      manager.reserveLoad = jest.fn(() => {
        order.push('reserved');
        return jest.fn();
      });
      const { spawn } = require('child_process');
      spawn.mockReturnValue(createFakeChild());
      service._ensureBinary = jest.fn(async () => {
        order.push('binary found');
        return '/mock/llama-server';
      });
      service._waitForHealth = jest.fn().mockResolvedValue(undefined);

      await service._startServer({ modelPath: '/models/vision.gguf' });

      expect(order[0]).toBe('binary found');
      expect(order).toContain('reserved');
    });

    test('no binary: the start fails and nothing was reserved', async () => {
      manager.reserveLoad = jest.fn(() => jest.fn());
      service._ensureBinary = jest.fn().mockRejectedValue(new Error('no runtime for this backend'));

      await expect(service._startServer({ modelPath: '/models/vision.gguf' })).rejects.toThrow(
        'no runtime for this backend'
      );

      expect(manager.reserveLoad).not.toHaveBeenCalled();
    });

    test('a start that fails gives the reservation back', async () => {
      const endReservation = jest.fn();
      manager.reserveLoad = jest.fn(() => endReservation);
      const { spawn } = require('child_process');
      spawn.mockReturnValue(createFakeChild());
      service._ensureBinary = jest.fn().mockResolvedValue('/mock/llama-server');
      service._waitForHealth = jest.fn().mockRejectedValue(new Error('health check failed'));

      await expect(service._startServer({ modelPath: '/models/vision.gguf' })).rejects.toThrow(
        'health check failed'
      );

      expect(endReservation).toHaveBeenCalledTimes(1);
      expect(manager.registerExternalConsumer).not.toHaveBeenCalled();
    });

    test('a manager without reservations still starts the runtime', async () => {
      await startReadyServer();
      expect(service._isReady).toBe(true);
    });

    test('a child exit unregisters; shutdown unregisters', async () => {
      const child = await startReadyServer();
      child.emit('exit', 1, null);
      expect(manager.unregisterExternalConsumer).toHaveBeenCalledWith('vision-runtime');
      expect(service._memoryRegistration).toBeNull();

      manager.unregisterExternalConsumer.mockClear();
      await startReadyServer();
      service._process = {
        kill: jest.fn(),
        once: jest.fn((event, cb) => {
          if (event === 'exit') cb(0, null);
        }),
        removeListener: jest.fn(),
        removeAllListeners: jest.fn()
      };
      await service.shutdown();
      expect(manager.unregisterExternalConsumer).toHaveBeenCalledWith('vision-runtime');
      expect(service._memoryRegistration).toBeNull();
    });

    test('eviction by the manager shuts the server down without a second unregister', async () => {
      await startReadyServer();
      const { dispose } = manager.registerExternalConsumer.mock.calls[0][0];
      service.shutdown = jest.fn().mockResolvedValue(undefined);

      await dispose();

      expect(service.shutdown).toHaveBeenCalledTimes(1);
      expect(service._memoryRegistration).toBeNull();
      expect(manager.unregisterExternalConsumer).not.toHaveBeenCalled();
    });

    test('estimateRuntimeMemoryBytes sums model and projector with runtime overhead', async () => {
      const fresh = new VisionService();
      const statSpy = jest.spyOn(fs.promises, 'stat').mockImplementation(async (p) => ({
        size: String(p).includes('mmproj') ? 600 * 1024 * 1024 : 4 * GiB
      }));
      try {
        const bytes = await fresh.estimateRuntimeMemoryBytes({
          modelPath: '/models/vision.gguf',
          mmprojPath: '/models/mmproj.gguf'
        });
        expect(bytes).toBe(Math.ceil((4 * GiB + 600 * 1024 * 1024) * 1.3));
      } finally {
        statSpy.mockRestore();
      }
      const unreadable = jest.spyOn(fs.promises, 'stat').mockRejectedValue(new Error('ENOENT'));
      try {
        expect(await fresh.estimateRuntimeMemoryBytes({ modelPath: '/missing.gguf' })).toBe(
          5 * GiB
        );
      } finally {
        unreadable.mockRestore();
      }
    });

    test('a request in flight pins the registration and is visible to callers', async () => {
      const http = require('http');
      await startReadyServer();
      service._ensureServer = jest.fn().mockResolvedValue(undefined);
      let finishResponse;
      const requestSpy = jest.spyOn(http, 'request').mockImplementation((options, callback) => {
        const req = new EventEmitter();
        req.setTimeout = jest.fn();
        req.write = jest.fn();
        req.destroy = jest.fn();
        req.end = jest.fn(() => {
          const res = new EventEmitter();
          res.statusCode = 200;
          callback(res);
          finishResponse = () => {
            res.emit('data', JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
            res.emit('end');
          };
        });
        return req;
      });

      try {
        expect(service.hasInFlightRequests()).toBe(false);
        const pending = service.analyzeImage({
          imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
          config: { modelPath: '/models/vision.gguf', contextSize: 4096, threads: 4, gpuLayers: -1 }
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(service.hasInFlightRequests()).toBe(true);
        expect(manager.acquireRef).toHaveBeenCalledWith('vision-runtime');
        expect(await service.waitForIdle(50)).toBe(false);

        finishResponse();
        await expect(pending).resolves.toEqual({ response: 'ok' });
        expect(service.hasInFlightRequests()).toBe(false);
        expect(manager.releaseRef).toHaveBeenCalledWith('vision-runtime');
        expect(await service.waitForIdle(50)).toBe(true);
      } finally {
        requestSpy.mockRestore();
      }
    });
    // The stderr tail is whatever the runtime last wrote: its load banner
    // names the GPU backend, and "cuda" in the message made a rejected image
    // a retryable error.
    test('an error the runtime answers with keeps stderr text out of its message', async () => {
      const http = require('http');
      await startReadyServer();
      service._ensureServer = jest.fn().mockResolvedValue(undefined);
      service._recentStderr =
        'clip_ctx: CLIP using CUDA0 backend\nload_hparams: projector: mlp\ndecode: failed to find a memory slot for batch of size 1024';
      const requestSpy = jest.spyOn(http, 'request').mockImplementation((options, callback) => {
        const req = new EventEmitter();
        req.setTimeout = jest.fn();
        req.write = jest.fn();
        req.destroy = jest.fn();
        req.end = jest.fn(() => {
          const res = new EventEmitter();
          res.statusCode = 400;
          callback(res);
          res.emit(
            'data',
            JSON.stringify({ error: { message: 'Failed to load image or audio file' } })
          );
          res.emit('end');
        });
        return req;
      });

      try {
        const error = await service
          .analyzeImage({
            imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
            config: { modelPath: '/models/vision.gguf', contextSize: 4096, threads: 4 }
          })
          .catch((e) => e);

        expect(error.message).toBe('Failed to load image or audio file');
        expect(error.visionRuntimeHint).toMatch(/CUDA0/);
      } finally {
        requestSpy.mockRestore();
      }
    });

    describe('the hold a request takes on the registration', () => {
      const image = {
        imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
        config: { modelPath: '/models/vision.gguf', contextSize: 4096, threads: 4, gpuLayers: -1 }
      };

      /** A child that exits as soon as shutdown() kills it. */
      function exitingProcess() {
        return {
          kill: jest.fn(),
          once: jest.fn((event, cb) => {
            if (event === 'exit') cb(0, null);
          }),
          removeListener: jest.fn(),
          removeAllListeners: jest.fn()
        };
      }

      function failingRequest(message) {
        const http = require('http');
        return jest.spyOn(http, 'request').mockImplementation(() => {
          const req = new EventEmitter();
          req.setTimeout = jest.fn();
          req.write = jest.fn();
          req.destroy = jest.fn();
          req.end = jest.fn(() => process.nextTick(() => req.emit('error', new Error(message))));
          return req;
        });
      }

      test('a request that times out gives its hold back although the runtime was shut down', async () => {
        await startReadyServer();
        service._ensureServer = jest.fn().mockResolvedValue(undefined);
        service._process = exitingProcess();
        const requestSpy = failingRequest('Vision request timed out');

        try {
          await expect(service.analyzeImage(image)).rejects.toThrow('timed out');
        } finally {
          requestSpy.mockRestore();
        }

        // The timeout restarts the runtime, which drops the registration
        // before the request is over.
        expect(manager.unregisterExternalConsumer).toHaveBeenCalledWith('vision-runtime');
        expect(manager.acquireRef).toHaveBeenCalledTimes(1);
        expect(manager.releaseRef).toHaveBeenCalledTimes(1);
        expect(manager.releaseRef).toHaveBeenCalledWith('vision-runtime');
        expect(service.hasInFlightRequests()).toBe(false);
      });

      test('a request that began before the runtime registered is held once and released once', async () => {
        const end = service._beginRequest();
        expect(manager.acquireRef).not.toHaveBeenCalled();

        await startReadyServer();
        expect(manager.acquireRef).toHaveBeenCalledTimes(1);

        end();
        end();
        expect(manager.releaseRef).toHaveBeenCalledTimes(1);
        expect(service.hasInFlightRequests()).toBe(false);
      });

      test('an image counts as in flight while its runtime is still starting', async () => {
        let finishStart;
        service._ensureServer = jest.fn(
          () =>
            new Promise((resolve) => {
              finishStart = resolve;
            })
        );
        const pending = service.analyzeImage(image).catch((error) => error);
        await new Promise((resolve) => setImmediate(resolve));

        // A text load that looks now must see the image, or it shuts down
        // the runtime the image is waiting for.
        expect(service.hasInFlightRequests()).toBe(true);

        finishStart();
        await pending;
        expect(service.hasInFlightRequests()).toBe(false);
      });

      test('a request that never held the registration releases nothing', async () => {
        const end = service._beginRequest();
        end();
        expect(manager.acquireRef).not.toHaveBeenCalled();
        expect(manager.releaseRef).not.toHaveBeenCalled();
      });

      test('a shutdown while the runtime size is being measured leaves nothing registered', async () => {
        let finishEstimate;
        service.estimateRuntimeMemoryBytes = jest.fn(
          () =>
            new Promise((resolve) => {
              finishEstimate = () => resolve(5 * GiB);
            })
        );
        const child = createFakeChild();
        const { spawn } = require('child_process');
        spawn.mockReturnValue(child);
        service._ensureBinary = jest.fn().mockResolvedValue('/mock/llama-server');
        service._waitForHealth = jest.fn().mockResolvedValue(undefined);
        const starting = service
          ._startServer({ modelPath: '/models/vision.gguf', mmprojPath: '/models/mmproj.gguf' })
          .catch(() => {});
        for (let i = 0; i < 20 && !finishEstimate; i += 1) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(typeof finishEstimate).toBe('function');

        // The runtime goes away (crash, or a text load taking its memory).
        child.emit('exit', 1, null);
        finishEstimate();
        await starting;

        expect(manager.registerExternalConsumer).not.toHaveBeenCalled();
        expect(service._memoryRegistration).toBeNull();
      });
    });
  });

  describe('startup-failure latch', () => {
    const validConfig = { modelPath: '/m.gguf' };

    test('a startup failure sets the latch', async () => {
      service._ensureServer = jest.fn().mockRejectedValue(new Error('spawn failed'));

      await expect(service.analyzeImage({ config: validConfig })).rejects.toThrow('spawn failed');

      expect(service._startupFailureAt).toBeGreaterThan(0);
    });

    test('an exited-after-startup failure sets the latch', async () => {
      service._ensureServer = jest.fn().mockResolvedValue(undefined);
      // _process/_port stay null -> "server exited after startup" branch

      await expect(service.analyzeImage({ config: validConfig })).rejects.toThrow(/not running/i);

      expect(service._startupFailureAt).toBeGreaterThan(0);
    });

    test('fails fast without a spawn attempt while the cooldown is active', async () => {
      service._startupFailureAt = Date.now();
      service._ensureServer = jest.fn();

      const promise = service.analyzeImage({ config: validConfig });
      await expect(promise).rejects.toThrow(/vision runtime/i);
      await expect(promise).rejects.toMatchObject({ code: 'VISION_UNAVAILABLE' });

      expect(service._ensureServer).not.toHaveBeenCalled();
    });

    test('re-attempts startup once the cooldown has expired', async () => {
      service._startupFailureAt = Date.now() - 61_000;
      service._ensureServer = jest.fn().mockRejectedValue(new Error('still broken'));

      await expect(service.analyzeImage({ config: validConfig })).rejects.toThrow('still broken');

      expect(service._ensureServer).toHaveBeenCalledTimes(1);
    });

    test('a successful startup clears the latch', async () => {
      service._startupFailureAt = Date.now() - 61_000;
      service._ensureServer = jest.fn().mockImplementation(async () => {
        service._process = { pid: 4242 };
        service._port = 8080;
        // Force a post-startup failure so the test never reaches the HTTP call
        service._multimodalCapable = false;
      });

      await expect(service.analyzeImage({ config: validConfig })).rejects.toMatchObject({
        code: 'VISION_NO_MULTIMODAL'
      });

      expect(service._startupFailureAt).toBe(0);
    });

    test('consecutive startup failures escalate the cooldown [F-080]', async () => {
      service._startupFailureStreak = 2; // second consecutive failure -> 120s window
      service._startupFailureAt = Date.now() - 61_000; // past the flat 60s window
      service._ensureServer = jest.fn();

      const promise = service.analyzeImage({ config: validConfig });
      await expect(promise).rejects.toMatchObject({ code: 'VISION_UNAVAILABLE' });
      expect(service._ensureServer).not.toHaveBeenCalled();
    });

    test('escalated cooldown is capped at 15 minutes [F-080]', async () => {
      service._startupFailureStreak = 30; // uncapped this would be ~2^29 minutes
      service._startupFailureAt = Date.now() - 901_000; // just past the 15m cap
      service._ensureServer = jest.fn().mockRejectedValue(new Error('still broken'));

      await expect(service.analyzeImage({ config: validConfig })).rejects.toThrow('still broken');

      expect(service._ensureServer).toHaveBeenCalledTimes(1); // cap expired -> real retry
      expect(service._startupFailureStreak).toBe(31); // and the failure extends the streak
    });

    test('a successful startup resets the failure streak [F-080]', async () => {
      service._startupFailureStreak = 3; // 240s window...
      service._startupFailureAt = Date.now() - 300_000; // ...already elapsed
      service._ensureServer = jest.fn().mockImplementation(async () => {
        service._process = { pid: 4242 };
        service._port = 8080;
        // Force a post-startup failure so the test never reaches the HTTP call
        service._multimodalCapable = false;
      });

      await expect(service.analyzeImage({ config: validConfig })).rejects.toMatchObject({
        code: 'VISION_NO_MULTIMODAL'
      });

      expect(service._startupFailureStreak).toBe(0);
      expect(service._startupFailureAt).toBe(0);
    });
  });

  describe('UTF-8 stream decoding', () => {
    test('reassembles multi-byte characters split across chunks', () => {
      const messages = [];
      const decoder = _createUtf8ChunkDecoder((text) => messages.push(text));
      const emDash = Buffer.from('—', 'utf8');

      decoder.push(emDash.slice(0, 2));
      decoder.push(emDash.slice(2));
      decoder.end();

      expect(messages.join('')).toBe('—');
    });
  });

  describe('isAvailable', () => {
    test('returns true when env path exists', async () => {
      const original = process.env.STRATOSORT_LLAMA_SERVER_PATH;
      process.env.STRATOSORT_LLAMA_SERVER_PATH = '/mock/server';
      jest.spyOn(fs.promises, 'access').mockResolvedValue(undefined);

      expect(await service.isAvailable()).toBe(true);

      process.env.STRATOSORT_LLAMA_SERVER_PATH = original;
    });

    test('returns false when no binary found', async () => {
      delete process.env.STRATOSORT_LLAMA_SERVER_PATH;
      jest.spyOn(fs.promises, 'access').mockRejectedValue(new Error('Not found'));

      expect(await service.isAvailable()).toBe(false);
    });
  });

  describe('analyzeImage', () => {
    test('throws when no model path provided', async () => {
      await expect(service.analyzeImage({})).rejects.toThrow(/no model path/i);
    });

    test('throws when projector required but missing', async () => {
      await expect(
        service.analyzeImage({
          config: { modelPath: '/model.gguf', mmprojRequired: true }
        })
      ).rejects.toThrow(/projector/i);
    });

    test('throws when no image data provided', async () => {
      // Simulate server already running
      service._process = { kill: jest.fn() };
      service._port = 8080;
      service._activeConfig = {
        modelPath: '/model.gguf',
        mmprojPath: null,
        contextSize: 4096,
        threads: 4,
        gpuLayers: -1
      };

      // Mock _ensureServer to be a no-op (server already matches)
      service._ensureServer = jest.fn().mockResolvedValue(undefined);

      await expect(
        service.analyzeImage({
          config: {
            modelPath: '/model.gguf',
            contextSize: 4096,
            threads: 4,
            gpuLayers: -1
          }
        })
      ).rejects.toThrow(/Vision input not found/i);
    });

    test('uses per-request timeout override when provided', async () => {
      const http = require('http');
      let observedTimeoutMs = null;
      service._process = { kill: jest.fn() };
      service._port = 8080;
      service._ensureServer = jest.fn().mockResolvedValue(undefined);

      const requestSpy = jest.spyOn(http, 'request').mockImplementation((options, callback) => {
        const req = new EventEmitter();
        req.setTimeout = jest.fn((timeoutMs) => {
          observedTimeoutMs = timeoutMs;
        });
        req.write = jest.fn();
        req.end = jest.fn(() => {
          const res = new EventEmitter();
          res.statusCode = 200;
          callback(res);
          process.nextTick(() => {
            res.emit('data', JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
            res.emit('end');
          });
        });
        req.destroy = jest.fn();
        return req;
      });

      try {
        const result = await service.analyzeImage({
          imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
          timeoutMs: 123456,
          config: {
            modelPath: '/model.gguf',
            contextSize: 4096,
            threads: 4,
            gpuLayers: -1
          }
        });

        expect(result).toEqual({ response: 'ok' });
        expect(observedTimeoutMs).toBe(123456);
      } finally {
        requestSpy.mockRestore();
      }
    });

    describe('a request whose caller has already given up', () => {
      const config = { modelPath: '/model.gguf', contextSize: 4096, threads: 4, gpuLayers: -1 };
      const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
      /** Fail with a message instead of hanging until Jest's own timeout. */
      const settlesSoon = (promise) =>
        Promise.race([
          promise,
          new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error('analyzeImage never settled')), 500);
            timer.unref?.();
          })
        ]);
      /** A request double that reports a destroy the way Node does: an async 'error'. */
      const spyOnHttpRequest = () => {
        const http = require('http');
        return jest.spyOn(http, 'request').mockImplementation(() => {
          const req = new EventEmitter();
          req.setTimeout = jest.fn();
          req.write = jest.fn();
          req.end = jest.fn();
          req.destroy = jest.fn((err) => {
            process.nextTick(() => req.emit('error', err));
          });
          return req;
        });
      };

      test('aborted while the runtime was starting: rejects, holds nothing, keeps the runtime', async () => {
        const controller = new AbortController();
        service._process = { kill: jest.fn() };
        service._port = 8080;
        // The batch is cancelled during the (long) server start.
        service._ensureServer = jest.fn(async () => controller.abort());
        service.shutdown = jest.fn().mockResolvedValue(undefined);
        const scheduleIdle = jest.spyOn(service, 'scheduleIdleShutdown');
        const requestSpy = spyOnHttpRequest();

        try {
          await expect(
            settlesSoon(service.analyzeImage({ imageBase64, signal: controller.signal, config }))
          ).rejects.toThrow(/aborted/i);
          expect(requestSpy).not.toHaveBeenCalled();
          expect(service.hasInFlightRequests()).toBe(false);
          // The runtime has just become ready and is healthy: the next image
          // must not pay another start.
          expect(service.shutdown).not.toHaveBeenCalled();
          expect(scheduleIdle).toHaveBeenCalled();
        } finally {
          requestSpy.mockRestore();
        }
      });

      test('aborted before the call: does not start the runtime', async () => {
        const controller = new AbortController();
        controller.abort();
        service._ensureServer = jest.fn().mockResolvedValue(undefined);
        const requestSpy = spyOnHttpRequest();

        try {
          await expect(
            settlesSoon(service.analyzeImage({ imageBase64, signal: controller.signal, config }))
          ).rejects.toThrow(/aborted/i);
          expect(service._ensureServer).not.toHaveBeenCalled();
          expect(requestSpy).not.toHaveBeenCalled();
        } finally {
          requestSpy.mockRestore();
        }
      });

      test('aborted while the image file is read: the request settles and releases its hold', async () => {
        const controller = new AbortController();
        service._process = { kill: jest.fn() };
        service._port = 8080;
        service._ensureServer = jest.fn().mockResolvedValue(undefined);
        service.shutdown = jest.fn().mockResolvedValue(undefined);
        const readSpy = jest.spyOn(fs.promises, 'readFile').mockImplementation(async () => {
          controller.abort();
          return Buffer.from('not-a-real-image');
        });
        const requestSpy = spyOnHttpRequest();

        try {
          await expect(
            settlesSoon(
              service.analyzeImage({ imagePath: '/x/photo.png', signal: controller.signal, config })
            )
          ).rejects.toThrow(/aborted/i);
          expect(service.hasInFlightRequests()).toBe(false);
        } finally {
          readSpy.mockRestore();
          requestSpy.mockRestore();
        }
      });

      test('a failure after the runtime is up still schedules its idle shutdown', async () => {
        service._process = { kill: jest.fn() };
        service._port = 8080;
        service._ensureServer = jest.fn().mockResolvedValue(undefined);
        const scheduleIdle = jest.spyOn(service, 'scheduleIdleShutdown');
        const readSpy = jest
          .spyOn(fs.promises, 'readFile')
          .mockRejectedValue(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }));

        try {
          await expect(service.analyzeImage({ imagePath: '/x/gone.png', config })).rejects.toThrow(
            /ENOENT/
          );
          expect(scheduleIdle).toHaveBeenCalled();
        } finally {
          readSpy.mockRestore();
        }
      });
    });
  });

  describe('requestJson', () => {
    const { _requestJson } = require('../src/main/services/VisionService');

    test('a signal aborted before the call rejects without creating a request', async () => {
      const http = require('http');
      const requestSpy = jest.spyOn(http, 'request');
      const controller = new AbortController();
      controller.abort();
      try {
        await expect(
          _requestJson({ method: 'GET', port: 1, path: '/health', signal: controller.signal })
        ).rejects.toMatchObject({ name: 'AbortError', message: 'Vision request aborted' });
        expect(requestSpy).not.toHaveBeenCalled();
      } finally {
        requestSpy.mockRestore();
      }
    });

    test('an abort during the request rejects and removes its listener from the signal', async () => {
      const http = require('http');
      const requestSpy = jest.spyOn(http, 'request').mockImplementation(() => {
        const req = new EventEmitter();
        req.setTimeout = jest.fn();
        req.write = jest.fn();
        req.end = jest.fn();
        req.destroy = jest.fn((err) => process.nextTick(() => req.emit('error', err)));
        return req;
      });
      const controller = new AbortController();
      const removeSpy = jest.spyOn(controller.signal, 'removeEventListener');
      try {
        const pending = _requestJson({
          method: 'POST',
          port: 1,
          path: '/v1/chat/completions',
          body: { a: 1 },
          signal: controller.signal
        });
        controller.abort();
        await expect(pending).rejects.toThrow('Vision request aborted');
        expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
      } finally {
        requestSpy.mockRestore();
      }
    });
  });

  describe('requestJson against a runtime that stops part way through its answer', () => {
    const { _requestJson } = require('../src/main/services/VisionService');
    const http = require('http');
    let server;
    let port;
    let respond;

    beforeEach(async () => {
      server = http.createServer((req, res) => respond(req, res));
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = server.address().port;
    });
    afterEach(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });

    const outcomeOf = (pending) =>
      Promise.race([
        pending.then(
          (value) => ({ settled: 'resolved', value }),
          (error) => ({ settled: 'rejected', message: error.message })
        ),
        new Promise((resolve) => setTimeout(() => resolve({ settled: 'never' }), 1500))
      ]);

    test('rejects when the connection closes before the whole answer arrived', async () => {
      // The runtime crashed, or was stopped, after its headers went out.
      respond = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 200 });
        res.write('{"choices":[');
        setTimeout(() => res.socket.destroy(), 20);
      };

      const outcome = await outcomeOf(
        _requestJson({ method: 'POST', port, path: '/v1/chat/completions', body: { a: 1 } })
      );

      expect(outcome).toEqual({
        settled: 'rejected',
        message: 'Vision response ended before it was complete'
      });
    });

    test('still resolves with an answer that arrived whole', async () => {
      respond = (_req, res) => {
        const body = JSON.stringify({ choices: [{ message: { content: 'a cat' } }] });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        });
        res.end(body);
      };

      const outcome = await outcomeOf(
        _requestJson({ method: 'POST', port, path: '/v1/chat/completions', body: { a: 1 } })
      );

      expect(outcome).toEqual({
        settled: 'resolved',
        value: { status: 200, json: { choices: [{ message: { content: 'a cat' } }] } }
      });
    });

    test('keeps the timeout as the reason when that is what ended the request', async () => {
      respond = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 200 });
        res.write('{"choices":[');
      };

      const outcome = await outcomeOf(
        _requestJson({
          method: 'POST',
          port,
          path: '/v1/chat/completions',
          body: { a: 1 },
          timeoutMs: 100
        })
      );

      expect(outcome).toEqual({ settled: 'rejected', message: 'Vision request timed out' });
    });
  });

  describe('idle shutdown', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    test('a request still in flight when the idle timer fires keeps the runtime', async () => {
      jest.useFakeTimers();
      service._idleKeepAliveMs = 1000;
      service._process = { kill: jest.fn() };
      service.shutdown = jest.fn().mockResolvedValue(undefined);

      const endRequest = service._beginRequest();
      service.scheduleIdleShutdown('test');
      jest.advanceTimersByTime(1000);
      expect(service.shutdown).not.toHaveBeenCalled();

      // Once the request is done the re-armed timer shuts the runtime down.
      endRequest();
      jest.advanceTimersByTime(1000);
      expect(service.shutdown).toHaveBeenCalledTimes(1);
    });
  });

  describe('shutdown', () => {
    test('handles shutdown when no process running', async () => {
      service._process = null;

      // Should not throw
      await expect(service.shutdown()).resolves.toBeUndefined();
    });

    test('kills process and clears state on shutdown', async () => {
      const mockProc = {
        kill: jest.fn(),
        once: jest.fn((event, cb) => {
          if (event === 'exit') cb(0, null);
        })
      };
      service._process = mockProc;
      service._port = 8080;
      service._activeConfig = { modelPath: '/m.gguf' };
      service._startPromise = Promise.resolve();

      await service.shutdown();

      expect(mockProc.kill).toHaveBeenCalled();
      expect(service._process).toBeNull();
      expect(service._port).toBeNull();
      expect(service._activeConfig).toBeNull();
    });

    test('concurrent shutdown calls both resolve without error', async () => {
      const mockProc = {
        kill: jest.fn(),
        once: jest.fn((event, cb) => {
          if (event === 'exit') setTimeout(() => cb(0, null), 10);
        })
      };
      service._process = mockProc;

      // Both calls should resolve cleanly (second one gets the cached promise)
      await expect(Promise.all([service.shutdown(), service.shutdown()])).resolves.toBeDefined();

      // Process should only be killed once
      expect(mockProc.kill).toHaveBeenCalledTimes(1);
    });
  });

  describe('_configMatches', () => {
    test('returns false when no active config', () => {
      service._activeConfig = null;
      expect(service._configMatches({ modelPath: '/m.gguf' })).toBe(false);
    });

    test('returns true when config matches', () => {
      const config = {
        modelPath: '/model.gguf',
        mmprojPath: '/proj.gguf',
        contextSize: 4096,
        threads: 4,
        gpuLayers: 33
      };
      service._activeConfig = { ...config };
      expect(service._configMatches(config)).toBe(true);
    });

    test('returns false when config differs', () => {
      service._activeConfig = {
        modelPath: '/old.gguf',
        mmprojPath: null,
        contextSize: 2048,
        threads: 2,
        gpuLayers: 0
      };
      expect(
        service._configMatches({
          modelPath: '/new.gguf',
          mmprojPath: null,
          contextSize: 4096,
          threads: 4,
          gpuLayers: 33
        })
      ).toBe(false);
    });
  });

  describe('_ensureBinary', () => {
    test('tracks bundled runtime variant key', async () => {
      const runtimePaths = require('../src/main/utils/runtimePaths');
      runtimePaths.resolveRuntimePath.mockReturnValue('/mock/bundled/llama-server');
      jest.spyOn(fs.promises, 'access').mockResolvedValue(undefined);
      service._activeConfig = { runtimeBackend: 'cpu' };

      const binaryPath = await service._ensureBinary();

      expect(binaryPath).toBe('/mock/bundled/llama-server');
      expect(service._binaryVariantKey).toBe('cpu');
    });

    test('restarts runtime download when requested variant changes', async () => {
      const runtimePaths = require('../src/main/utils/runtimePaths');
      runtimePaths.resolveRuntimePath.mockReturnValue('/missing/bundled/llama-server');
      jest.spyOn(fs.promises, 'access').mockRejectedValue(new Error('missing'));

      const downloadSpy = jest.spyOn(service, '_downloadRuntime').mockImplementation(async () => {
        service._binaryPath = `/runtime/${service._activeConfig?.runtimeBackend || 'auto'}/llama-server`;
        service._binaryVariantKey = service._activeConfig?.runtimeBackend || 'auto';
      });

      service._activeConfig = { runtimeBackend: 'auto' };
      const autoBinary = await service._ensureBinary();

      service._binaryPath = null;
      service._activeConfig = { runtimeBackend: 'cpu' };
      const cpuBinary = await service._ensureBinary();

      expect(autoBinary).toContain('/runtime/auto/');
      expect(cpuBinary).toContain('/runtime/cpu/');
      expect(downloadSpy).toHaveBeenCalledTimes(2);
    });

    test('prefers a matching downloaded internal runtime before bundled binary', async () => {
      const originalPlatform = process.platform;
      const originalArch = process.arch;
      const runtimePaths = require('../src/main/utils/runtimePaths');

      Object.defineProperty(process, 'platform', { value: 'win32' });
      Object.defineProperty(process, 'arch', { value: 'x64' });
      runtimePaths.resolveRuntimePath.mockReturnValue('/mock/bundled/llama-server.exe');

      jest.spyOn(fs.promises, 'access').mockImplementation(async (targetPath) => {
        const normalized = String(targetPath).replace(/\\/g, '/');
        if (
          normalized === '/mock/bundled/llama-server.exe' ||
          normalized.endsWith('/runtime/llama.cpp/b9000/runtime.json') ||
          normalized.endsWith('/runtime/llama.cpp/b9000/downloaded/llama-server.exe')
        ) {
          return undefined;
        }
        throw new Error('missing');
      });
      jest.spyOn(fs.promises, 'readFile').mockResolvedValue(
        JSON.stringify({
          binaryPath: '/mock/userData/runtime/llama.cpp/b9000/downloaded/llama-server.exe',
          assetName: 'llama-b9000-bin-win-cpu-x64.zip'
        })
      );

      service._activeConfig = { runtimeBackend: 'cpu' };

      try {
        const binaryPath = await service._ensureBinary();
        expect(binaryPath).toBe(
          '/mock/userData/runtime/llama.cpp/b9000/downloaded/llama-server.exe'
        );
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
        Object.defineProperty(process, 'arch', { value: originalArch });
      }
    });
  });

  describe('detectBase64Mime / detectMimeFromPath', () => {
    test('detectBase64Mime maps known magic-number prefixes to MIME types', () => {
      expect(_detectBase64Mime('/9j/4AAQSkZJRg==')).toBe('image/jpeg');
      expect(_detectBase64Mime('iVBORw0KGgo=')).toBe('image/png');
      expect(_detectBase64Mime('R0lGODdh')).toBe('image/gif');
      expect(_detectBase64Mime('UklGRiQ=')).toBe('image/webp');
    });

    test('detectBase64Mime returns null for unknown prefixes and non-strings', () => {
      expect(_detectBase64Mime('AAAAunknownprefix')).toBeNull();
      expect(_detectBase64Mime('')).toBeNull();
      expect(_detectBase64Mime(null)).toBeNull();
      expect(_detectBase64Mime(undefined)).toBeNull();
      expect(_detectBase64Mime(12345)).toBeNull();
    });

    test('detectMimeFromPath maps known extensions case-insensitively', () => {
      expect(_detectMimeFromPath('/tmp/photo.png')).toBe('image/png');
      expect(_detectMimeFromPath('/tmp/photo.jpg')).toBe('image/jpeg');
      expect(_detectMimeFromPath('/tmp/photo.jpeg')).toBe('image/jpeg');
      expect(_detectMimeFromPath('/tmp/anim.GIF')).toBe('image/gif');
      expect(_detectMimeFromPath('/tmp/pic.WebP')).toBe('image/webp');
      expect(_detectMimeFromPath('/tmp/scan.bmp')).toBe('image/bmp');
      expect(_detectMimeFromPath('/tmp/scan.tif')).toBe('image/tiff');
      expect(_detectMimeFromPath('/tmp/scan.tiff')).toBe('image/tiff');
    });

    test('detectMimeFromPath returns null for unknown/missing extensions', () => {
      expect(_detectMimeFromPath('/tmp/document.txt')).toBeNull();
      expect(_detectMimeFromPath('/tmp/noextension')).toBeNull();
      expect(_detectMimeFromPath('')).toBeNull();
      expect(_detectMimeFromPath(null)).toBeNull();
      expect(_detectMimeFromPath(undefined)).toBeNull();
    });
  });

  describe('NVIDIA GPU detection for CUDA runtime', () => {
    const originalPlatform = process.platform;
    const originalArch = process.arch;
    let envBackup;

    const getSelectedRuntimeLog = () =>
      __mockLogger.info.mock.calls.find(
        ([message]) => message === '[VisionService] Selected vision runtime'
      );

    beforeEach(() => {
      _resetRuntimeCache();
      envBackup = { ...process.env };
      delete process.env.STRATOSORT_FORCE_SOFTWARE_GPU;
      delete process.env.ELECTRON_FORCE_SOFTWARE;
      delete process.env.STRATOSORT_LLM_GPU_BACKEND;
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      Object.defineProperty(process, 'arch', { value: originalArch });
      process.env = envBackup;
    });

    test('selects CUDA build when nvidia-smi succeeds on win32', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      Object.defineProperty(process, 'arch', { value: 'x64' });
      delete process.env.STRATOSORT_LLAMA_CPP_URL;
      delete process.env.STRATOSORT_LLAMA_SERVER_PATH;
      process.env.STRATOSORT_LLM_GPU_BACKEND = 'cuda';

      jest.spyOn(fs.promises, 'access').mockRejectedValue(new Error('Not found'));

      expect(await service.isAvailable()).toBe(false);

      const log = getSelectedRuntimeLog();
      expect(log).toBeTruthy();
      expect(log[1]).toEqual(expect.objectContaining({ resolvedBackend: 'cuda' }));
      expect(log[1].assetName).toMatch(/win-cuda/i);
    });

    test('falls back to Vulkan when nvidia-smi fails on win32', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      Object.defineProperty(process, 'arch', { value: 'x64' });
      delete process.env.STRATOSORT_LLAMA_CPP_URL;
      delete process.env.STRATOSORT_LLAMA_SERVER_PATH;
      delete process.env.STRATOSORT_PREFER_VULKAN;

      jest.spyOn(fs.promises, 'access').mockRejectedValue(new Error('Not found'));
      execFile.mockImplementation((cmd, args, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (cmd === 'nvidia-smi.exe' || (args && args[0] === 'nvidia-smi.exe')) {
          callback(new Error('not found'), '', '');
        } else {
          callback(new Error(`Unexpected command: ${cmd}`), '', '');
        }
      });

      expect(await service.isAvailable()).toBe(false);

      const log = getSelectedRuntimeLog();
      expect(log).toBeTruthy();
      expect(log[1]).toEqual(expect.objectContaining({ resolvedBackend: 'vulkan' }));
      expect(log[1].assetName).toMatch(/win-vulkan/i);
    });

    test('falls back to Vulkan when nvidia-smi fails and CIM has no NVIDIA adapter', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      Object.defineProperty(process, 'arch', { value: 'x64' });
      delete process.env.STRATOSORT_LLAMA_CPP_URL;
      delete process.env.STRATOSORT_LLAMA_SERVER_PATH;
      delete process.env.STRATOSORT_PREFER_VULKAN;

      jest.spyOn(fs.promises, 'access').mockRejectedValue(new Error('Not found'));
      execFile.mockImplementation((cmd, args, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (cmd === 'nvidia-smi.exe' || (args && args[0] === 'nvidia-smi.exe')) {
          callback(new Error('not found'), '', '');
        } else if (cmd === 'powershell') {
          callback(null, { toString: () => 'Intel UHD Graphics' }, '');
        } else {
          callback(new Error(`Unexpected command: ${cmd}`), '', '');
        }
      });

      expect(await service.isAvailable()).toBe(false);

      const log = getSelectedRuntimeLog();
      expect(log).toBeTruthy();
      expect(log[1]).toEqual(expect.objectContaining({ resolvedBackend: 'vulkan' }));
      expect(log[1].assetName).toMatch(/win-vulkan/i);
    });

    test('STRATOSORT_LLM_GPU_BACKEND=vulkan overrides CUDA detection', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      Object.defineProperty(process, 'arch', { value: 'x64' });
      process.env.STRATOSORT_LLM_GPU_BACKEND = 'vulkan';
      delete process.env.STRATOSORT_LLAMA_CPP_URL;
      delete process.env.STRATOSORT_LLAMA_SERVER_PATH;

      const asset = await _getAssetConfig();

      expect(asset.assetName).toMatch(/win-vulkan/i);
    });

    test('selects Linux Vulkan runtime when Vulkan GPU is detected', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      Object.defineProperty(process, 'arch', { value: 'x64' });
      delete process.env.STRATOSORT_LLM_GPU_BACKEND;

      execFile.mockImplementation((cmd, args, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (cmd === 'nvidia-smi.exe' || cmd === 'nvidia-smi') {
          callback(new Error('not found'), '', '');
          return;
        }
        if (cmd === 'lspci') {
          callback(null, {
            stdout: '00:02.0 VGA compatible controller: Intel Arc Graphics',
            stderr: ''
          });
          return;
        }
        callback(new Error(`Unexpected command: ${cmd}`), '', '');
      });

      const asset = await _getAssetConfig();
      expect(asset.assetName).toMatch(/ubuntu-vulkan-x64/i);
    });

    test('keeps Linux CPU runtime when detection resolves to CPU', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      Object.defineProperty(process, 'arch', { value: 'x64' });
      delete process.env.STRATOSORT_LLM_GPU_BACKEND;

      execFile.mockImplementation((cmd, args, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (cmd === 'nvidia-smi.exe' || cmd === 'nvidia-smi' || cmd === 'lspci') {
          callback(new Error('not found'), '', '');
          return;
        }
        callback(new Error(`Unexpected command: ${cmd}`), '', '');
      });

      const asset = await _getAssetConfig();
      expect(asset.assetName).toMatch(/ubuntu-x64\.tar\.gz/i);
    });

    test('selects Linux arm64 Vulkan runtime when Vulkan GPU is detected', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      Object.defineProperty(process, 'arch', { value: 'arm64' });
      delete process.env.STRATOSORT_LLM_GPU_BACKEND;

      execFile.mockImplementation((cmd, args, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (cmd === 'nvidia-smi.exe' || cmd === 'nvidia-smi') {
          callback(new Error('not found'), '', '');
          return;
        }
        if (cmd === 'lspci') {
          callback(null, {
            stdout: '00:02.0 VGA compatible controller: Intel Arc Graphics',
            stderr: ''
          });
          return;
        }
        callback(new Error(`Unexpected command: ${cmd}`), '', '');
      });

      const asset = await _getAssetConfig();
      expect(asset.assetName).toMatch(/ubuntu-vulkan-arm64/i);
    });

    test('keeps Linux arm64 CPU runtime when detection resolves to CPU', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      Object.defineProperty(process, 'arch', { value: 'arm64' });
      delete process.env.STRATOSORT_LLM_GPU_BACKEND;

      execFile.mockImplementation((cmd, args, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (cmd === 'nvidia-smi.exe' || cmd === 'nvidia-smi' || cmd === 'lspci') {
          callback(new Error('not found'), '', '');
          return;
        }
        callback(new Error(`Unexpected command: ${cmd}`), '', '');
      });

      const asset = await _getAssetConfig();
      expect(asset.assetName).toMatch(/ubuntu-arm64\.tar\.gz/i);
      expect(asset.assetName).not.toMatch(/vulkan/i);
    });
  });
});
