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
