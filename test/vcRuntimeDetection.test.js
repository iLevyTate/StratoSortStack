/**
 * Detection of the Microsoft Visual C++ Redistributable the node-llama-cpp
 * Windows binaries import (MSVCP140.dll + VCRUNTIME140.dll). A clean Windows
 * install lacks it, and node-llama-cpp then reports only NoBinaryFoundError.
 */

const path = require('path');
const {
  VC_REDIST_DOWNLOAD_PAGE_URL,
  VC_RUNTIME_DLLS,
  isNativeBinaryLoadError,
  vcRuntimeMissingMessage,
  readVcRuntimeRegistryInstalled,
  detectVcRuntime
} = require('../src/main/utils/vcRuntimeDetection');

const WIN_ENV = { SystemRoot: 'C:\\Windows' };
const SYSTEM32 = path.join('C:\\Windows', 'System32');

describe('isNativeBinaryLoadError', () => {
  test('recognises node-llama-cpp NoBinaryFoundError by message (plain Error) or name', () => {
    expect(isNativeBinaryLoadError(new Error('NoBinaryFoundError'))).toBe(true);
    const named = new Error('no binary');
    named.name = 'NoBinaryFoundError';
    expect(isNativeBinaryLoadError(named)).toBe(true);
  });

  test('recognises a native addon load failure', () => {
    const dlopen = Object.assign(new Error('boom'), { code: 'ERR_DLOPEN_FAILED' });
    expect(isNativeBinaryLoadError(dlopen)).toBe(true);
    expect(isNativeBinaryLoadError(new Error('The specified module could not be found.'))).toBe(
      true
    );
    expect(isNativeBinaryLoadError(new Error('%1 is not a valid Win32 application.'))).toBe(true);
  });

  test('ignores config, model and non-error values', () => {
    expect(isNativeBinaryLoadError(new Error('Settings file unreadable'))).toBe(false);
    expect(isNativeBinaryLoadError(new Error('Model not found: text.gguf'))).toBe(false);
    expect(isNativeBinaryLoadError(null)).toBe(false);
    expect(isNativeBinaryLoadError('NoBinaryFoundError')).toBe(false);
  });
});

describe('vcRuntimeMissingMessage', () => {
  test('names the architecture-specific redistributable', () => {
    expect(vcRuntimeMissingMessage('x64')).toBe(
      "Local AI needs the Microsoft Visual C++ Redistributable (x64), which isn't installed on this PC. Install it from Microsoft, then restart StratoSort."
    );
    expect(vcRuntimeMissingMessage('arm64')).toContain('Redistributable (ARM64)');
  });

  test('download page is Microsoft learn page over HTTPS', () => {
    const url = new URL(VC_REDIST_DOWNLOAD_PAGE_URL);
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('learn.microsoft.com');
  });
});

describe('detectVcRuntime', () => {
  test('not applicable off Windows, and never probes the filesystem', async () => {
    const fileExists = jest.fn();
    const status = await detectVcRuntime({ platform: 'linux', fileExists });
    expect(status).toEqual(expect.objectContaining({ applicable: false, present: true }));
    expect(fileExists).not.toHaveBeenCalled();
  });

  test('present when both DLLs exist in System32', async () => {
    const fileExists = jest.fn().mockResolvedValue(true);
    const status = await detectVcRuntime({
      platform: 'win32',
      arch: 'x64',
      env: WIN_ENV,
      fileExists,
      readRegistryInstalled: async () => true
    });
    expect(status).toEqual({
      applicable: true,
      present: true,
      missingDlls: [],
      systemDir: SYSTEM32,
      registryInstalled: true,
      archLabel: 'x64'
    });
    expect(fileExists.mock.calls.map(([p]) => p)).toEqual(
      VC_RUNTIME_DLLS.map((dll) => path.join(SYSTEM32, dll))
    );
  });

  test('missing when the DLLs are absent (clean Windows install)', async () => {
    const status = await detectVcRuntime({
      platform: 'win32',
      arch: 'x64',
      env: WIN_ENV,
      fileExists: async () => false,
      readRegistryInstalled: async () => null
    });
    expect(status.present).toBe(false);
    expect(status.missingDlls).toEqual(['msvcp140.dll', 'vcruntime140.dll']);
    expect(status.registryInstalled).toBeNull();
  });

  test('one missing DLL is enough to report missing', async () => {
    const status = await detectVcRuntime({
      platform: 'win32',
      arch: 'arm64',
      env: WIN_ENV,
      fileExists: async (p) => !p.endsWith('msvcp140.dll'),
      readRegistryInstalled: async () => false
    });
    expect(status.present).toBe(false);
    expect(status.missingDlls).toEqual(['msvcp140.dll']);
    expect(status.archLabel).toBe('ARM64');
    expect(status.registryInstalled).toBe(false);
  });

  test('never throws: a throwing fs probe counts as missing, a throwing registry read as unknown', async () => {
    const status = await detectVcRuntime({
      platform: 'win32',
      env: WIN_ENV,
      fileExists: async () => {
        throw new Error('EACCES');
      },
      readRegistryInstalled: async () => {
        throw new Error('reg.exe blocked');
      }
    });
    expect(status.present).toBe(false);
    expect(status.registryInstalled).toBeNull();
  });
});

describe('readVcRuntimeRegistryInstalled', () => {
  test('reads Installed=1 from the arch runtime key via reg.exe (no shell)', async () => {
    const spawnImpl = jest.fn().mockResolvedValue({
      status: 0,
      stdout:
        '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64\r\n    Installed    REG_DWORD    0x1\r\n'
    });
    await expect(
      readVcRuntimeRegistryInstalled({ arch: 'x64', env: WIN_ENV, spawnImpl })
    ).resolves.toBe(true);
    const [cmd, args, options] = spawnImpl.mock.calls[0];
    expect(cmd).toBe(path.join(SYSTEM32, 'reg.exe'));
    expect(args).toEqual([
      'query',
      'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64',
      '/v',
      'Installed'
    ]);
    expect(options).toEqual(expect.objectContaining({ timeout: expect.any(Number) }));
    expect(options.shell).toBeUndefined();
  });

  test('Installed=0 reads false; an absent key, a failed spawn or a throw read null', async () => {
    await expect(
      readVcRuntimeRegistryInstalled({
        env: WIN_ENV,
        spawnImpl: jest.fn().mockResolvedValue({ status: 0, stdout: 'Installed REG_DWORD 0x0' })
      })
    ).resolves.toBe(false);
    await expect(
      readVcRuntimeRegistryInstalled({
        env: WIN_ENV,
        spawnImpl: jest.fn().mockResolvedValue({ status: 1, stdout: '', stderr: 'ERROR' })
      })
    ).resolves.toBeNull();
    await expect(
      readVcRuntimeRegistryInstalled({
        env: WIN_ENV,
        spawnImpl: jest.fn().mockRejectedValue(new Error('spawn failed'))
      })
    ).resolves.toBeNull();
  });
});
