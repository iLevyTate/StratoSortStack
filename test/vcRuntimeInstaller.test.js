/**
 * In-app install of the bundled Visual C++ Redistributable
 * (src/main/utils/vcRuntimeInstaller.js): only the Microsoft-signed file under
 * the app's own resources directory ever runs, elevated, with fixed arguments;
 * exit codes map to success / cancelled / failure; anything unusual falls back
 * to the download page (`not-bundled`).
 */

const path = require('path');
const {
  INSTALLER_ENV_VAR,
  ELEVATED_INSTALL_SCRIPT,
  VC_REDIST_INSTALL_ARGS,
  bundledVcRedistPath,
  installBundledVcRuntime,
  mapVcRedistExitCode,
  runInstallerElevated,
  vcRedistFileName
} = require('../src/main/utils/vcRuntimeInstaller');

const RESOURCES = 'C:\\Users\\me\\AppData\\Local\\Programs\\StratoSort Stack\\resources';
const X64_EXE = path.join(RESOURCES, 'assets', 'runtime', 'vcredist', 'vc_redist.x64.exe');

function validVerdict() {
  return {
    ok: true,
    reason: 'valid',
    info: {
      status: 'Valid',
      subject: 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',
      productVersion: '14.51.36247.0'
    }
  };
}

function deps(overrides = {}) {
  return {
    platform: 'win32',
    arch: 'x64',
    resourcesPath: RESOURCES,
    env: { SystemRoot: 'C:\\Windows' },
    fileExists: jest.fn(async () => true),
    verifySignature: jest.fn(async () => validVerdict()),
    runElevated: jest.fn(async () => ({ exitCode: 0, launchFailed: false, timedOut: false })),
    detect: jest.fn(async () => ({ applicable: true, present: true })),
    logger: { info: jest.fn(), warn: jest.fn() },
    ...overrides
  };
}

describe('bundled installer location', () => {
  test('is derived from resourcesPath and the app arch only', () => {
    expect(bundledVcRedistPath({ resourcesPath: RESOURCES, arch: 'x64' })).toBe(X64_EXE);
    expect(bundledVcRedistPath({ resourcesPath: RESOURCES, arch: 'arm64' })).toBe(
      path.join(RESOURCES, 'assets', 'runtime', 'vcredist', 'vc_redist.arm64.exe')
    );
    expect(bundledVcRedistPath({ resourcesPath: '', arch: 'x64' })).toBeNull();
    expect(vcRedistFileName('ia32')).toBe('vc_redist.x64.exe');
  });
});

describe('mapVcRedistExitCode', () => {
  test.each([
    [0, { success: true, cancelled: false, needsRestart: false }],
    [1638, { success: true, cancelled: false, needsRestart: false }],
    [3010, { success: true, cancelled: false, needsRestart: true }],
    [1641, { success: true, cancelled: false, needsRestart: true }],
    [1602, { success: false, cancelled: true, needsRestart: false }],
    [1223, { success: false, cancelled: true, needsRestart: false }],
    [1603, { success: false, cancelled: false, needsRestart: false }],
    [null, { success: false, cancelled: false, needsRestart: false }]
  ])('exit %p', (code, expected) => {
    expect(mapVcRedistExitCode(code)).toMatchObject(expected);
  });
});

describe('installBundledVcRuntime', () => {
  test('not win32: not-bundled, nothing checked or spawned', async () => {
    const d = deps({ platform: 'darwin' });
    await expect(installBundledVcRuntime(d)).resolves.toMatchObject({
      success: false,
      reason: 'not-bundled'
    });
    expect(d.fileExists).not.toHaveBeenCalled();
    expect(d.verifySignature).not.toHaveBeenCalled();
    expect(d.runElevated).not.toHaveBeenCalled();
  });

  test('missing exe (dev build): not-bundled, never spawned', async () => {
    const d = deps({ fileExists: jest.fn(async () => false) });
    await expect(installBundledVcRuntime(d)).resolves.toMatchObject({
      success: false,
      cancelled: false,
      reason: 'not-bundled'
    });
    expect(d.fileExists).toHaveBeenCalledWith(X64_EXE);
    expect(d.runElevated).not.toHaveBeenCalled();
  });

  test('no resources directory: not-bundled', async () => {
    const d = deps({ resourcesPath: '' });
    const res = await installBundledVcRuntime(d);
    expect(res.reason).toBe('not-bundled');
    expect(d.fileExists).not.toHaveBeenCalled();
    expect(d.runElevated).not.toHaveBeenCalled();
  });

  test.each([
    [
      'not Microsoft',
      { ok: false, reason: 'not-microsoft', info: { status: 'Valid', subject: 'CN=Evil, O=Evil' } }
    ],
    ['not Valid', { ok: false, reason: 'not-valid', info: { status: 'HashMismatch' } }],
    ['unreadable', { ok: false, reason: 'unreadable', info: null }]
  ])('bad signature (%s): refused and never spawned', async (_label, verdict) => {
    const d = deps({ verifySignature: jest.fn(async () => verdict) });
    await expect(installBundledVcRuntime(d)).resolves.toMatchObject({
      success: false,
      cancelled: false,
      reason: 'signature-invalid'
    });
    expect(d.verifySignature).toHaveBeenCalledWith(X64_EXE, expect.anything());
    expect(d.runElevated).not.toHaveBeenCalled();
    expect(d.logger.warn).toHaveBeenCalled();
  });

  test('exit 0: success, runtime re-detected', async () => {
    const d = deps();
    await expect(installBundledVcRuntime(d)).resolves.toEqual({
      success: true,
      cancelled: false,
      needsRestart: false,
      exitCode: 0,
      runtimePresent: true
    });
    expect(d.runElevated).toHaveBeenCalledWith(X64_EXE, expect.anything());
    expect(d.detect).toHaveBeenCalledTimes(1);
  });

  test('exit 1638 (newer version present): success', async () => {
    const d = deps({ runElevated: jest.fn(async () => ({ exitCode: 1638 })) });
    await expect(installBundledVcRuntime(d)).resolves.toMatchObject({
      success: true,
      needsRestart: false,
      exitCode: 1638
    });
  });

  test('exit 3010: success with needsRestart, even before the DLLs appear', async () => {
    const d = deps({
      runElevated: jest.fn(async () => ({ exitCode: 3010 })),
      detect: jest.fn(async () => ({ applicable: true, present: false }))
    });
    await expect(installBundledVcRuntime(d)).resolves.toMatchObject({
      success: true,
      needsRestart: true,
      exitCode: 3010,
      runtimePresent: false
    });
  });

  test.each([1602, 1223])('exit %p: cancelled', async (code) => {
    const d = deps({
      runElevated: jest.fn(async () => ({ exitCode: code })),
      detect: jest.fn(async () => ({ applicable: true, present: false }))
    });
    await expect(installBundledVcRuntime(d)).resolves.toMatchObject({
      success: false,
      cancelled: true,
      needsRestart: false,
      exitCode: code
    });
  });

  test('other exit codes: failure with the code', async () => {
    const d = deps({
      runElevated: jest.fn(async () => ({ exitCode: 1603 })),
      detect: jest.fn(async () => ({ applicable: true, present: false }))
    });
    await expect(installBundledVcRuntime(d)).resolves.toMatchObject({
      success: false,
      cancelled: false,
      exitCode: 1603,
      reason: 'installer-failed'
    });
  });

  test('exit 0 but the DLLs are still missing: not reported as success', async () => {
    const d = deps({ detect: jest.fn(async () => ({ applicable: true, present: false })) });
    await expect(installBundledVcRuntime(d)).resolves.toMatchObject({
      success: false,
      reason: 'runtime-still-missing',
      exitCode: 0
    });
  });

  test('launch failure and timeout are reported, not thrown', async () => {
    await expect(
      installBundledVcRuntime(
        deps({
          runElevated: jest.fn(async () => ({ exitCode: 1, launchFailed: true, detail: 'x' }))
        })
      )
    ).resolves.toMatchObject({ success: false, reason: 'launch-failed' });
    await expect(
      installBundledVcRuntime(deps({ runElevated: jest.fn(async () => ({ timedOut: true })) }))
    ).resolves.toMatchObject({ success: false, reason: 'timed-out' });
    await expect(
      installBundledVcRuntime(
        deps({
          runElevated: jest.fn(async () => {
            throw new Error('boom');
          })
        })
      )
    ).resolves.toMatchObject({ success: false, reason: 'installer-failed', error: 'boom' });
  });

  test('arm64 app runs the arm64 file', async () => {
    const d = deps({ arch: 'arm64' });
    await installBundledVcRuntime(d);
    expect(d.runElevated).toHaveBeenCalledWith(
      path.join(RESOURCES, 'assets', 'runtime', 'vcredist', 'vc_redist.arm64.exe'),
      expect.anything()
    );
  });
});

describe('runInstallerElevated', () => {
  test('runs a fixed elevated script; the path travels only in the environment', async () => {
    const spawnImpl = jest.fn(async () => ({ status: 3010, stdout: '', stderr: '' }));
    const env = { SystemRoot: 'D:\\Win', PATH: 'C:\\evil' };
    const tricky =
      "C:\\Users\\O'Brien\\$(calc)\\resources\\assets\\runtime\\vcredist\\vc_redist.x64.exe";

    const run = await runInstallerElevated(tricky, { env, spawnImpl });

    expect(run).toMatchObject({ exitCode: 3010, launchFailed: false, timedOut: false });
    const [command, args, options] = spawnImpl.mock.calls[0];
    expect(command).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand'
    ]);
    const script = Buffer.from(args[5], 'base64').toString('utf16le');
    expect(script).toBe(ELEVATED_INSTALL_SCRIPT);
    expect(script).toContain('-Verb RunAs -Wait -PassThru');
    expect(script).toContain(`-FilePath $env:${INSTALLER_ENV_VAR}`);
    VC_REDIST_INSTALL_ARGS.forEach((arg) => expect(script).toContain(`'${arg}'`));
    // Nothing caller-supplied appears in the command line.
    expect(args.join(' ')).not.toContain('Brien');
    expect(args.join(' ')).not.toContain('calc');
    expect(options.env[INSTALLER_ENV_VAR]).toBe(tricky);
    expect(options.windowsHide).toBe(true);
  });

  test('a Start-Process failure is reported as a launch failure', async () => {
    const spawnImpl = jest.fn(async () => ({
      status: 1,
      stdout: 'SS_VC_REDIST_LAUNCH_FAILED: The system cannot find the file specified.\r\n'
    }));
    await expect(runInstallerElevated('C:\\x.exe', { env: {}, spawnImpl })).resolves.toMatchObject({
      launchFailed: true,
      detail: 'The system cannot find the file specified.'
    });
  });
});
