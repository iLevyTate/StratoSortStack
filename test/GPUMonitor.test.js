jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock('../src/shared/platformUtils', () => ({
  getNvidiaSmiCommand: jest.fn(() =>
    process.platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi'
  )
}));

// GPUMonitor now uses promisify(execFile) instead of execSync.
// We provide a [promisify.custom] function so promisify() returns our mock.
const mockExecFileAsync = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });

jest.mock('child_process', () => {
  const fn = function () {};
  fn[require('util').promisify.custom] = mockExecFileAsync;
  return { execFile: fn };
});

const { GPUMonitor } = require('../src/main/services/GPUMonitor');

describe('GPUMonitor', () => {
  beforeEach(() => {
    mockExecFileAsync.mockReset();
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
  });

  test('detectGPU uses platform-specific detection', async () => {
    const monitor = new GPUMonitor();
    monitor._platform = 'win32';
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'RTX 4090, 24576', stderr: '' });

    const result = await monitor.detectGPU();
    expect(result.type).toBe('cuda');
    expect(result.vramMB).toBe(24576);
  });

  test('nvidia-smi detection records the driver version and asks for it', async () => {
    const monitor = new GPUMonitor();
    monitor._platform = 'win32';
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'RTX 4090, 24576, 581.57\n', stderr: '' });

    const result = await monitor.detectGPU();

    expect(result).toEqual(
      expect.objectContaining({ type: 'cuda', name: 'RTX 4090', driverVersion: '581.57' })
    );
    // The mocked command name follows the real platform running the suite.
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      expect.stringMatching(/^nvidia-smi(\.exe)?$/),
      expect.arrayContaining(['--query-gpu=name,memory.total,driver_version']),
      expect.anything()
    );
  });

  test('nvidia-smi detection leaves the driver version out when it is missing or [N/A]', async () => {
    for (const stdout of ['RTX 4090, 24576', 'RTX 4090, 24576, [N/A]']) {
      const monitor = new GPUMonitor();
      monitor._platform = 'linux';
      mockExecFileAsync.mockReset();
      mockExecFileAsync.mockResolvedValueOnce({ stdout, stderr: '' });

      const result = await monitor.detectGPU();

      expect(result.type).toBe('cuda');
      expect(result).not.toHaveProperty('driverVersion');
    }
  });

  test('windows WMI detection records the adapter driver version', async () => {
    const monitor = new GPUMonitor();
    monitor._platform = 'win32';
    mockExecFileAsync
      .mockRejectedValueOnce(new Error('no nvidia')) // nvidia-smi
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          Name: 'AMD Radeon RX 7800 XT',
          AdapterRAM: 2147483648,
          DriverVersion: '32.0.12011.1036'
        }),
        stderr: ''
      });

    const result = await monitor.detectGPU();

    expect(result.name).toBe('AMD Radeon RX 7800 XT');
    expect(result.driverVersion).toBe('32.0.12011.1036');
  });

  test('windows detection falls back to wmic', async () => {
    const monitor = new GPUMonitor();
    monitor._platform = 'win32';
    mockExecFileAsync
      .mockRejectedValueOnce(new Error('no nvidia'))
      // PowerShell fails
      .mockResolvedValueOnce({ stdout: '', stderr: 'powershell error' })
      // WMIC succeeds with CSV format
      .mockResolvedValueOnce({
        stdout: 'Node,AdapterRAM,Name\nMYPC,2147483648,Intel UHD',
        stderr: ''
      });

    const result = await monitor.detectGPU();
    expect(result.type).toBe('vulkan');
    expect(result.vramMB).toBeGreaterThan(0);
  });

  test('windows detection keeps NVIDIA adapter on vulkan path when nvidia-smi is unavailable', async () => {
    const monitor = new GPUMonitor();
    monitor._platform = 'win32';
    mockExecFileAsync
      .mockRejectedValueOnce(new Error('command not found')) // nvidia-smi
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { Name: 'Intel UHD', AdapterRAM: 2147483648 },
          // AdapterRAM is unreliable/truncated on some systems; vendor should still win.
          { Name: 'NVIDIA GeForce RTX 4050', AdapterRAM: 0 }
        ]),
        stderr: ''
      });

    const result = await monitor.detectGPU();
    expect(result.type).toBe('vulkan');
    expect(result.name).toMatch(/nvidia/i);
  });

  test('linux detection uses lspci when nvidia-smi missing', async () => {
    const monitor = new GPUMonitor();
    monitor._platform = 'linux';
    mockExecFileAsync.mockRejectedValueOnce(new Error('no nvidia')).mockResolvedValueOnce({
      stdout: '00:02.0 VGA compatible controller: Intel HD',
      stderr: ''
    });

    const result = await monitor.detectGPU();
    expect(result.type).toBe('vulkan');
    expect(result.name).toContain('Intel');
  });

  test('getGPUMemoryUsage returns null on mac', async () => {
    const monitor = new GPUMonitor();
    monitor._platform = 'darwin';
    const result = await monitor.getGPUMemoryUsage();
    expect(result).toBeNull();
  });

  test('getGPUMemoryUsage parses nvidia-smi output', async () => {
    const monitor = new GPUMonitor();
    monitor._platform = 'win32';
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '200, 1000', stderr: '' });

    const result = await monitor.getGPUMemoryUsage();
    expect(result.usedMB).toBe(200);
    expect(result.totalMB).toBe(1000);
    expect(result.percentUsed).toBe(20);
  });

  describe('macOS detection', () => {
    const os = require('os');
    const MiB = 1024 * 1024;
    const expectedUnifiedVramMB = (totalBytes) => Math.round(Math.round(totalBytes * 0.75) / MiB);

    function macMonitor(arch) {
      const monitor = new GPUMonitor();
      monitor._platform = 'darwin';
      monitor._arch = arch;
      return monitor;
    }

    test('Apple Silicon reads the model name and sizes VRAM at 75% of hw.memsize', async () => {
      const monitor = macMonitor('arm64');
      mockExecFileAsync
        .mockResolvedValueOnce({
          stdout: JSON.stringify({ SPDisplaysDataType: [{ sppci_model: 'Apple M4 Pro' }] }),
          stderr: ''
        })
        .mockResolvedValueOnce({ stdout: 'hw.memsize: 25769803776\n', stderr: '' });

      const result = await monitor.detectGPU();

      expect(result).toEqual({
        type: 'metal',
        name: 'Apple M4 Pro',
        vramBytes: 19327352832,
        vramMB: 18432,
        isAppleSilicon: true
      });
    });

    test('Apple Silicon stays Metal with unified VRAM when system_profiler fails or times out', async () => {
      const monitor = macMonitor('arm64');
      // runCommand turns every rejection (including the timeout kill) into null.
      mockExecFileAsync.mockRejectedValue(new Error('system_profiler timed out'));

      const result = await monitor.detectGPU();

      expect(result).toEqual({
        type: 'metal',
        name: 'Apple Silicon GPU',
        vramBytes: Math.round(os.totalmem() * 0.75),
        vramMB: expectedUnifiedVramMB(os.totalmem()),
        isAppleSilicon: true
      });
      expect(result.vramMB).toBeGreaterThan(0);
    });

    test('Apple Silicon keeps a GPU model name without "apple" in it', async () => {
      const monitor = macMonitor('arm64');
      mockExecFileAsync
        .mockResolvedValueOnce({
          stdout: JSON.stringify({ SPDisplaysDataType: [{ sppci_model: 'Integrated GPU' }] }),
          stderr: ''
        })
        .mockResolvedValueOnce({ stdout: 'hw.memsize: 17179869184\n', stderr: '' });

      const result = await monitor.detectGPU();

      expect(result).toEqual(
        expect.objectContaining({
          type: 'metal',
          name: 'Integrated GPU',
          vramMB: 12288,
          isAppleSilicon: true
        })
      );
    });

    test('an unreadable hw.memsize falls back to os.totalmem()', async () => {
      const monitor = macMonitor('arm64');
      mockExecFileAsync
        .mockResolvedValueOnce({
          stdout: JSON.stringify({ SPDisplaysDataType: [{ sppci_model: 'Apple M2' }] }),
          stderr: ''
        })
        .mockRejectedValueOnce(new Error('sysctl not found'));

      const result = await monitor.detectGPU();

      expect(result.name).toBe('Apple M2');
      expect(result.vramMB).toBe(expectedUnifiedVramMB(os.totalmem()));
      expect(result.vramMB).toBeGreaterThan(0);
    });

    test('an Intel Mac still reports a CPU when system_profiler fails', async () => {
      const monitor = macMonitor('x64');
      mockExecFileAsync.mockRejectedValue(new Error('system_profiler timed out'));

      const result = await monitor.detectGPU();

      expect(result).toEqual({ type: 'cpu', name: 'CPU' });
      expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
    });

    test('an Intel Mac still reads a discrete GPU from system_profiler', async () => {
      const monitor = macMonitor('x64');
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: JSON.stringify({
          SPDisplaysDataType: [{ sppci_model: 'AMD Radeon Pro 5500M', sppci_vram: '8 GB' }]
        }),
        stderr: ''
      });

      const result = await monitor.detectGPU();

      expect(result).toEqual({
        type: 'metal',
        name: 'AMD Radeon Pro 5500M',
        vramBytes: 8192 * MiB,
        vramMB: 8192,
        isAppleSilicon: false
      });
    });
  });

  describe('child process options', () => {
    const { TIMEOUTS } = require('../src/shared/performanceConstants');

    test('probes run hidden with the HEALTH_CHECK timeout', async () => {
      const monitor = new GPUMonitor();
      monitor._platform = 'win32';
      mockExecFileAsync.mockResolvedValueOnce({ stdout: 'RTX 4090, 24576', stderr: '' });

      await monitor.detectGPU();

      expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        expect.stringMatching(/^nvidia-smi/),
        expect.any(Array),
        expect.objectContaining({ windowsHide: true, timeout: TIMEOUTS.HEALTH_CHECK })
      );
    });

    test('every step of the Windows fallback chain (nvidia-smi -> powershell -> wmic) is hidden', async () => {
      const monitor = new GPUMonitor();
      monitor._platform = 'win32';
      mockExecFileAsync
        .mockRejectedValueOnce(new Error('no nvidia')) // nvidia-smi
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // powershell: empty
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // wmic: empty

      const result = await monitor.detectGPU();

      expect(result.type).toBe('cpu');
      expect(mockExecFileAsync.mock.calls.map(([cmd]) => cmd)).toEqual([
        expect.stringMatching(/^nvidia-smi/),
        'powershell',
        'wmic'
      ]);
      for (const [, , options] of mockExecFileAsync.mock.calls) {
        expect(options).toEqual(
          expect.objectContaining({ windowsHide: true, timeout: TIMEOUTS.HEALTH_CHECK })
        );
      }
    });

    test('per-call options are merged on top of the hidden-window defaults', async () => {
      const monitor = new GPUMonitor();
      monitor._platform = 'linux';
      mockExecFileAsync
        .mockRejectedValueOnce(new Error('no nvidia')) // nvidia-smi
        .mockResolvedValueOnce({
          stdout: '00:02.0 VGA compatible controller: Intel HD',
          stderr: ''
        }); // lspci (shell: true)

      await monitor.detectGPU();

      const [, , lspciOptions] = mockExecFileAsync.mock.calls[1];
      expect(lspciOptions).toEqual(
        expect.objectContaining({ shell: true, windowsHide: true, timeout: TIMEOUTS.HEALTH_CHECK })
      );
    });

    test('getGPUMemoryUsage probe is hidden too', async () => {
      const monitor = new GPUMonitor();
      monitor._platform = 'linux';
      mockExecFileAsync.mockResolvedValueOnce({ stdout: '200, 1000', stderr: '' });

      await monitor.getGPUMemoryUsage();

      expect(mockExecFileAsync).toHaveBeenCalledWith(
        expect.stringMatching(/^nvidia-smi/),
        expect.any(Array),
        expect.objectContaining({ windowsHide: true })
      );
    });
  });
});
