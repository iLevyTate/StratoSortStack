/**
 * Tests for GPU Configuration Module
 * Tests GPU preference settings and hardware acceleration
 */

// Mock logger
jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

// Mock electron app
const mockApp = {
  disableHardwareAcceleration: jest.fn(),
  commandLine: {
    appendSwitch: jest.fn()
  }
};
jest.mock('electron', () => ({
  app: mockApp
}));

// Several tests below overwrite methods on the shared core `path` module and on
// the (memfs-mocked) `fs` module from inside jest.isolateModules(). isolateModules
// does NOT isolate core modules, on Windows `path.win32 === path`, and the suite
// runs every file in one worker (maxWorkers: 1), so a forward-slash `path.join`
// left behind here leaked into every later suite (WhisperService CUDA PATH,
// smartFolders rename K-08). Capture the originals once and restore after
// every test.
const sharedPath = require('path');
const sharedFs = require('fs');
const SHARED_MODULE_ORIGINALS = {
  path: { join: sharedPath.join },
  fs: {
    existsSync: sharedFs.existsSync,
    unlinkSync: sharedFs.unlinkSync,
    writeFileSync: sharedFs.writeFileSync,
    promises: sharedFs.promises
  }
};

afterEach(() => {
  Object.assign(sharedPath, SHARED_MODULE_ORIGINALS.path);
  Object.assign(sharedFs, SHARED_MODULE_ORIGINALS.fs);
});

describe('GPU Configuration', () => {
  let gpuConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    // Reset environment variables
    delete process.env.STRATOSORT_FORCE_SOFTWARE_GPU;
    delete process.env.ELECTRON_FORCE_SOFTWARE;
    delete process.env.ANGLE_BACKEND;
    delete process.env.STRATOSORT_GL_IMPLEMENTATION;
    delete process.env.STRATOSORT_IGNORE_GPU_BLOCKLIST;
  });

  describe('forceSoftwareRenderer', () => {
    test('is false by default', () => {
      gpuConfig = require('../src/main/core/gpuConfig');
      expect(gpuConfig.forceSoftwareRenderer).toBe(false);
    });

    test('is true when STRATOSORT_FORCE_SOFTWARE_GPU=1', () => {
      process.env.STRATOSORT_FORCE_SOFTWARE_GPU = '1';
      gpuConfig = require('../src/main/core/gpuConfig');
      expect(gpuConfig.forceSoftwareRenderer).toBe(true);
    });

    test('is true when ELECTRON_FORCE_SOFTWARE=1', () => {
      process.env.ELECTRON_FORCE_SOFTWARE = '1';
      gpuConfig = require('../src/main/core/gpuConfig');
      expect(gpuConfig.forceSoftwareRenderer).toBe(true);
    });
  });

  describe('shouldForceInferenceCpuMode', () => {
    test('is false when only renderer fallback state is active', () => {
      gpuConfig = require('../src/main/core/gpuConfig');
      expect(gpuConfig.shouldForceInferenceCpuMode()).toBe(false);
    });

    test('is true when safe mode is active', () => {
      const originalArgv = [...process.argv];
      process.argv.push('--safe-mode');

      jest.isolateModules(() => {
        const isolatedConfig = require('../src/main/core/gpuConfig');
        expect(isolatedConfig.shouldForceInferenceCpuMode()).toBe(true);
      });

      process.argv = originalArgv;
    });
  });

  describe('initializeGpuConfig', () => {
    test('disables hardware acceleration when forceSoftwareRenderer is true', () => {
      process.env.STRATOSORT_FORCE_SOFTWARE_GPU = '1';
      gpuConfig = require('../src/main/core/gpuConfig');

      gpuConfig.initializeGpuConfig();

      expect(mockApp.disableHardwareAcceleration).toHaveBeenCalled();
    });

    test('does not force llama CPU mode for renderer-only GPU fallback flag', () => {
      jest.isolateModules(() => {
        const mockFs = require('fs');
        mockFs.existsSync = jest.fn().mockReturnValue(true);
        mockFs.unlinkSync = jest.fn();

        const mockPath = require('path');
        mockPath.join = jest.fn((...args) => args.join('/'));

        mockApp.getPath = jest.fn().mockReturnValue('/tmp/test-userData');
        delete process.env.STRATOSORT_FORCE_SOFTWARE_GPU;
        delete process.env.ELECTRON_FORCE_SOFTWARE;

        const isolatedConfig = require('../src/main/core/gpuConfig');
        isolatedConfig.initializeGpuConfig();

        expect(mockApp.disableHardwareAcceleration).toHaveBeenCalled();
        expect(process.env.STRATOSORT_FORCE_SOFTWARE_GPU).toBeUndefined();

        delete mockApp.getPath;
      });
    });

    test('sets ANGLE d3d11 backend only on Windows (no valid d3d11 elsewhere)', () => {
      gpuConfig = require('../src/main/core/gpuConfig');

      gpuConfig.initializeGpuConfig();

      if (process.platform === 'win32') {
        expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith('use-angle', 'd3d11');
      } else {
        expect(mockApp.commandLine.appendSwitch).not.toHaveBeenCalledWith(
          'use-angle',
          expect.anything()
        );
      }
    });

    test('uses custom ANGLE backend from environment', () => {
      process.env.ANGLE_BACKEND = 'gl';
      gpuConfig = require('../src/main/core/gpuConfig');

      gpuConfig.initializeGpuConfig();

      expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith('use-angle', 'gl');
    });

    test('sets custom GL implementation when specified', () => {
      process.env.STRATOSORT_GL_IMPLEMENTATION = 'desktop';
      gpuConfig = require('../src/main/core/gpuConfig');

      gpuConfig.initializeGpuConfig();

      expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith('use-gl', 'desktop');
    });

    test('ignores GPU blocklist when STRATOSORT_IGNORE_GPU_BLOCKLIST=1', () => {
      process.env.STRATOSORT_IGNORE_GPU_BLOCKLIST = '1';
      gpuConfig = require('../src/main/core/gpuConfig');

      gpuConfig.initializeGpuConfig();

      expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith('ignore-gpu-blocklist');
    });

    test('does not ignore GPU blocklist by default (stability-first)', () => {
      gpuConfig = require('../src/main/core/gpuConfig');

      gpuConfig.initializeGpuConfig();

      expect(mockApp.commandLine.appendSwitch).not.toHaveBeenCalledWith('ignore-gpu-blocklist');
    });

    test('handles app.commandLine errors gracefully', () => {
      gpuConfig = require('../src/main/core/gpuConfig');

      // Set up mock to throw after module load
      mockApp.commandLine.appendSwitch.mockImplementation(() => {
        throw new Error('Failed to append switch');
      });

      // Should not throw
      expect(() => gpuConfig.initializeGpuConfig()).not.toThrow();
    });
  });

  describe('handleGpuProcessGone', () => {
    beforeEach(() => {
      gpuConfig = require('../src/main/core/gpuConfig');
    });

    test('ignores non-GPU process exits', () => {
      const { logger } = require('../src/shared/logger');

      gpuConfig.handleGpuProcessGone({}, { type: 'renderer' });

      expect(logger.error).not.toHaveBeenCalled();
    });

    test('logs GPU process exit', () => {
      const { logger } = require('../src/shared/logger');

      gpuConfig.handleGpuProcessGone(
        {},
        {
          type: 'GPU',
          reason: 'crashed',
          exitCode: 1
        }
      );

      expect(logger.error).toHaveBeenCalledWith(
        '[GPU] Process exited',
        expect.objectContaining({
          reason: 'crashed',
          exitCode: 1
        })
      );
    });

    test('warns after repeated GPU failures', () => {
      const { logger } = require('../src/shared/logger');

      gpuConfig.handleGpuProcessGone({}, { type: 'GPU' });
      gpuConfig.handleGpuProcessGone({}, { type: 'GPU' });

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Repeated GPU failures'));
    });
  });

  describe('GPU fallback flag persistence', () => {
    test('writes .gpu-fallback after 3 GPU crashes', async () => {
      let mockWriteFile;
      jest.isolateModules(() => {
        const mockFs = require('fs');
        mockFs.existsSync = jest.fn().mockReturnValue(false);
        mockWriteFile = jest.fn().mockResolvedValue(undefined);
        mockFs.promises = { writeFile: mockWriteFile };
        mockFs.unlinkSync = jest.fn();

        const mockPath = require('path');
        mockPath.join = jest.fn((...args) => args.join('/'));

        mockApp.getPath = jest.fn().mockReturnValue('/tmp/test-userData');

        const gpuMod = require('../src/main/core/gpuConfig');

        gpuMod.handleGpuProcessGone({}, { type: 'GPU', reason: 'crashed', exitCode: 1 });
        gpuMod.handleGpuProcessGone({}, { type: 'GPU', reason: 'crashed', exitCode: 1 });
        gpuMod.handleGpuProcessGone({}, { type: 'GPU', reason: 'crashed', exitCode: 1 });

        delete mockApp.getPath;
      });

      await new Promise((r) => setImmediate(r));

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('.gpu-fallback'),
        expect.any(String)
      );
    });

    test('does NOT write flag after only 2 crashes', async () => {
      let mockWriteFile;
      jest.isolateModules(() => {
        const mockFs = require('fs');
        mockFs.existsSync = jest.fn().mockReturnValue(false);
        mockWriteFile = jest.fn().mockResolvedValue(undefined);
        mockFs.promises = { writeFile: mockWriteFile };
        mockFs.unlinkSync = jest.fn();

        const mockPath = require('path');
        mockPath.join = jest.fn((...args) => args.join('/'));

        mockApp.getPath = jest.fn().mockReturnValue('/tmp/test-userData');

        const gpuMod = require('../src/main/core/gpuConfig');

        gpuMod.handleGpuProcessGone({}, { type: 'GPU', reason: 'crashed', exitCode: 1 });
        gpuMod.handleGpuProcessGone({}, { type: 'GPU', reason: 'crashed', exitCode: 1 });

        delete mockApp.getPath;
      });

      await new Promise((r) => setImmediate(r));

      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    test('handles flag write failure gracefully', async () => {
      let capturedLogger;
      jest.isolateModules(() => {
        const mockFs = require('fs');
        mockFs.existsSync = jest.fn().mockReturnValue(false);
        mockFs.promises = {
          writeFile: jest.fn().mockRejectedValue(new Error('EACCES'))
        };
        mockFs.unlinkSync = jest.fn();

        const mockPath = require('path');
        mockPath.join = jest.fn((...args) => args.join('/'));

        mockApp.getPath = jest.fn().mockReturnValue('/tmp/test-userData');

        const { logger } = require('../src/shared/logger');
        capturedLogger = logger;

        const gpuMod = require('../src/main/core/gpuConfig');

        gpuMod.handleGpuProcessGone({}, { type: 'GPU', reason: 'crashed', exitCode: 1 });
        gpuMod.handleGpuProcessGone({}, { type: 'GPU', reason: 'crashed', exitCode: 1 });
        gpuMod.handleGpuProcessGone({}, { type: 'GPU', reason: 'crashed', exitCode: 1 });

        delete mockApp.getPath;
      });

      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      expect(capturedLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to write GPU fallback flag'),
        expect.any(String)
      );
    });

    test('reads flag on module load and sets forceSoftwareRenderer', () => {
      jest.isolateModules(() => {
        const mockFs = require('fs');
        // Flag file exists — simulates a previous session writing it
        mockFs.existsSync = jest.fn().mockReturnValue(true);
        mockFs.unlinkSync = jest.fn();
        mockFs.writeFileSync = jest.fn();

        const mockPath = require('path');
        mockPath.join = jest.fn((...args) => args.join('/'));

        mockApp.getPath = jest.fn().mockReturnValue('/tmp/test-userData');

        const gpuMod = require('../src/main/core/gpuConfig');

        expect(gpuMod.forceSoftwareRenderer).toBe(true);
        // Flag should be cleaned up after reading
        expect(mockFs.unlinkSync).toHaveBeenCalled();

        delete mockApp.getPath;
      });
    });

    test('--safe-mode in argv sets forceSoftwareRenderer', () => {
      const originalArgv = [...process.argv];
      process.argv.push('--safe-mode');

      jest.isolateModules(() => {
        const mockFs = require('fs');
        mockFs.existsSync = jest.fn().mockReturnValue(false);
        mockFs.unlinkSync = jest.fn();
        mockFs.writeFileSync = jest.fn();

        const mockPath = require('path');
        mockPath.join = jest.fn((...args) => args.join('/'));

        mockApp.getPath = jest.fn().mockReturnValue('/tmp/test-userData');

        const gpuMod = require('../src/main/core/gpuConfig');

        expect(gpuMod.forceSoftwareRenderer).toBe(true);

        delete mockApp.getPath;
      });

      process.argv = originalArgv;
    });
  });

  describe('applyProductionOptimizations', () => {
    beforeEach(() => {
      // Reset mock to default implementation
      mockApp.commandLine.appendSwitch.mockReset();
      mockApp.commandLine.appendSwitch.mockImplementation(() => {});
    });

    test('enables GPU rasterization in production', () => {
      gpuConfig = require('../src/main/core/gpuConfig');

      gpuConfig.applyProductionOptimizations(false);

      expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith('enable-gpu-rasterization');
      expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith('enable-zero-copy');
    });

    test('enables GPU rasterization in development', () => {
      gpuConfig = require('../src/main/core/gpuConfig');

      gpuConfig.applyProductionOptimizations(true);

      expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith('enable-gpu-rasterization');
    });

    test('skips GPU optimizations when software rendering forced', () => {
      process.env.STRATOSORT_FORCE_SOFTWARE_GPU = '1';
      gpuConfig = require('../src/main/core/gpuConfig');
      jest.clearAllMocks();

      gpuConfig.applyProductionOptimizations(false);

      expect(mockApp.commandLine.appendSwitch).not.toHaveBeenCalledWith('enable-gpu-rasterization');
    });
  });
});
