/**
 * @jest-environment node
 *
 * The RAM half of the model budget follows AVAILABLE memory (systemMemory),
 * not os.freemem(). On macOS os.freemem() counts only free pages: a busy
 * 24 GB Mac reports about 400 MB, and without a GPU memory figure the whole
 * model budget fell to 280 MB, so models were evicted and reloaded for every
 * file. On Windows and Linux the figure is os.freemem() as before.
 */

// isolateModules re-runs mock factories, so every copy shares these two.
const mockTotalmem = jest.fn(() => 24 * 1024 * 1024 * 1024);
const mockFreemem = jest.fn(() => 400 * 1024 * 1024);
jest.mock('os', () => ({
  totalmem: () => mockTotalmem(),
  freemem: () => mockFreemem()
}));

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })
}));

// systemMemory probes `sysctl -n kern.memorystatus_level` on darwin.
const mockAsyncSpawn = jest.fn();
jest.mock('../src/main/utils/asyncSpawnUtils', () => ({
  asyncSpawn: (...args) => mockAsyncSpawn(...args)
}));

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

/**
 * Load ModelMemoryManager and the shared systemMemory reader fresh, as on a
 * host of the given platform (the shared reader fixes its platform on first use).
 */
function loadOn(platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  let modules;
  jest.isolateModules(() => {
    modules = {
      ModelMemoryManager: require('../src/main/services/ModelMemoryManager').ModelMemoryManager,
      systemMemory: require('../src/main/utils/systemMemory')
    };
  });
  return modules;
}

function createMockLlamaService() {
  return { _models: {}, _contexts: {}, _loadModel: jest.fn() };
}

describe('ModelMemoryManager budget uses available memory', () => {
  beforeEach(() => {
    mockAsyncSpawn.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform);
  });

  test('on macOS without a GPU memory figure the budget follows the kernel available figure', async () => {
    // 60% of 24 GiB available, while only 400 MB of pages are free.
    mockAsyncSpawn.mockResolvedValue({ status: 0, stdout: '60\n' });
    const { ModelMemoryManager, systemMemory } = loadOn('darwin');

    const manager = new ModelMemoryManager(createMockLlamaService());
    // The first reading has not landed yet; let it land, then refresh as
    // every load decision does.
    await systemMemory.getAvailableMemoryBytes();
    manager._refreshMemoryBudget();

    const available = Math.round((24 * GiB * 60) / 100);
    expect(manager._maxMemoryUsage).toBeCloseTo(available * 0.7, -1);
    // Without the available figure: 0.7 x 400 MB = 280 MB.
    expect(manager._maxMemoryUsage).toBeGreaterThan(10 * GiB);
    expect(mockAsyncSpawn).toHaveBeenCalledWith(
      '/usr/sbin/sysctl',
      ['-n', 'kern.memorystatus_level'],
      expect.anything()
    );
  });

  test('on macOS a GPU-less budget gets the same figure through setGpuInfo(null)', async () => {
    mockAsyncSpawn.mockResolvedValue({ status: 0, stdout: '50\n' });
    const { ModelMemoryManager, systemMemory } = loadOn('darwin');
    await systemMemory.getAvailableMemoryBytes();

    const manager = new ModelMemoryManager(createMockLlamaService());
    // LlamaService passes null after a Metal init falls back to the CPU.
    manager.setGpuInfo(null);

    expect(manager._maxMemoryUsage).toBeCloseTo(12 * GiB * 0.7, -1);
  });

  test('on Windows the budget is still 70% of os.freemem() and nothing is spawned', () => {
    mockFreemem.mockReturnValue(6 * GiB);
    try {
      const { ModelMemoryManager } = loadOn('win32');

      const manager = new ModelMemoryManager(createMockLlamaService());
      manager._refreshMemoryBudget();

      expect(manager._maxMemoryUsage).toBeCloseTo(6 * GiB * 0.7, -1);
      expect(mockAsyncSpawn).not.toHaveBeenCalled();
    } finally {
      mockFreemem.mockReturnValue(400 * MiB);
    }
  });
});
