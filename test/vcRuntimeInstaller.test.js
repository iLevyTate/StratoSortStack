/**
 * In-app install of the bundled Visual C++ Redistributable
 * (src/main/utils/vcRuntimeInstaller.js): only the Microsoft-signed file under
 * the app's own resources directory ever runs, elevated, with fixed arguments;
 * exit codes map to success / cancelled / failure; anything unusual falls back
 * to the download page (`not-bundled`). It only runs while the runtime is
 * missing, and what runs is a verified copy in a fresh per-call temp dir.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  INSTALLER_ENV_VAR,
  INSTALL_TIMEOUT_MS,
  ELEVATED_INSTALL_SCRIPT,
  LAUNCH_FAILED_MARKER,
  STAGING_DIR_PREFIX,
  VC_REDIST_INSTALL_ARGS,
  bundledVcRedistPath,
  installBundledVcRuntime,
  mapVcRedistExitCode,
  runInstallerElevated,
  stageInstallerCopy,
  vcRedistFileName
} = require('../src/main/utils/vcRuntimeInstaller');
const { encodedCommandArgs, powershellPath } = require('../src/main/utils/authenticode');
const { asyncSpawn } = require('../src/main/utils/asyncSpawnUtils');
const { getIpcInvokeTimeout } = require('../src/shared/ipcInvokeTimeout');
const { IPC_CHANNELS } = require('../src/shared/constants');

const RESOURCES = 'C:\\Users\\me\\AppData\\Local\\Programs\\StratoSort Stack\\resources';
const X64_EXE = path.join(RESOURCES, 'assets', 'runtime', 'vcredist', 'vc_redist.x64.exe');
const STAGED_EXE = path.join(os.tmpdir(), 'stratosort-vcredist-abc123', 'vc_redist.x64.exe');
const MISSING = { applicable: true, present: false };
const PRESENT = { applicable: true, present: true };

/** The pre-install probe says missing; every later probe says `after`. */
function detectSequence(after = PRESENT) {
  return jest.fn().mockResolvedValueOnce(MISSING).mockResolvedValue(after);
}

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
  const cleanup = jest.fn(async () => true);
  return {
    platform: 'win32',
    arch: 'x64',
    resourcesPath: RESOURCES,
    env: { SystemRoot: 'C:\\Windows' },
    fileExists: jest.fn(async () => true),
    stageCopy: jest.fn(async () => ({ path: STAGED_EXE, cleanup })),
    cleanup,
    verifySignature: jest.fn(async () => validVerdict()),
    runElevated: jest.fn(async () => ({ exitCode: 0, launchFailed: false, timedOut: false })),
    detect: detectSequence(),
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
    [
      1618,
      { success: false, cancelled: false, needsRestart: false, meaning: 'install-in-progress' }
    ],
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
    expect(d.stageCopy).not.toHaveBeenCalled();
    expect(d.runElevated).not.toHaveBeenCalled();
  });

  test('no resources directory: not-bundled', async () => {
    const d = deps({ resourcesPath: '' });
    const res = await installBundledVcRuntime(d);
    expect(res.reason).toBe('not-bundled');
    expect(d.fileExists).not.toHaveBeenCalled();
    expect(d.runElevated).not.toHaveBeenCalled();
  });

  test('runtime already present: refused before anything is copied, checked or spawned', async () => {
    const d = deps({ detect: jest.fn(async () => PRESENT) });
    await expect(installBundledVcRuntime(d)).resolves.toEqual({
      success: false,
      cancelled: false,
      needsRestart: false,
      exitCode: null,
      reason: 'already-installed',
      runtimePresent: true
    });
    expect(d.detect).toHaveBeenCalledTimes(1);
    expect(d.stageCopy).not.toHaveBeenCalled();
    expect(d.verifySignature).not.toHaveBeenCalled();
    expect(d.runElevated).not.toHaveBeenCalled();
  });

  test('a failing pre-install probe does not block the install', async () => {
    const d = deps({
      detect: jest.fn().mockRejectedValueOnce(new Error('probe broke')).mockResolvedValue(PRESENT)
    });
    await expect(installBundledVcRuntime(d)).resolves.toMatchObject({ success: true });
    expect(d.runElevated).toHaveBeenCalledTimes(1);
  });

  test.each([
    [
      'not Microsoft',
      { ok: false, reason: 'not-microsoft', info: { status: 'Valid', subject: 'CN=Evil, O=Evil' } }
    ],
    ['not Valid', { ok: false, reason: 'not-valid', info: { status: 'HashMismatch' } }]
  ])('bad signature (%s): refused and never spawned', async (_label, verdict) => {
    const d = deps({ verifySignature: jest.fn(async () => verdict) });
    await expect(installBundledVcRuntime(d)).resolves.toMatchObject({
      success: false,
      cancelled: false,
      reason: 'signature-invalid'
    });
    expect(d.verifySignature).toHaveBeenCalledWith(STAGED_EXE, expect.anything());
    expect(d.runElevated).not.toHaveBeenCalled();
    expect(d.cleanup).toHaveBeenCalledTimes(1);
    expect(d.logger.warn).toHaveBeenCalled();
  });

  test('signature could not be read (PowerShell missing/blocked/timed out): signature-unreadable', async () => {
    const d = deps({
      verifySignature: jest.fn(async () => ({ ok: false, reason: 'unreadable', info: null }))
    });
    const res = await installBundledVcRuntime(d);
    expect(res).toMatchObject({ success: false, cancelled: false, reason: 'signature-unreadable' });
    expect(res.error).not.toMatch(/not Microsoft-signed/);
    expect(d.runElevated).not.toHaveBeenCalled();
    expect(d.cleanup).toHaveBeenCalledTimes(1);
  });

  test('exit 0: the verified temp copy is what runs, then it is removed', async () => {
    const d = deps();
    await expect(installBundledVcRuntime(d)).resolves.toEqual({
      success: true,
      cancelled: false,
      needsRestart: false,
      exitCode: 0,
      runtimePresent: true
    });
    expect(d.stageCopy).toHaveBeenCalledWith(X64_EXE);
    expect(d.verifySignature).toHaveBeenCalledWith(STAGED_EXE, expect.anything());
    expect(d.runElevated).toHaveBeenCalledWith(STAGED_EXE, expect.anything());
    expect(d.verifySignature.mock.invocationCallOrder[0]).toBeLessThan(
      d.runElevated.mock.invocationCallOrder[0]
    );
    expect(d.cleanup).toHaveBeenCalledTimes(1);
    expect(d.detect).toHaveBeenCalledTimes(2);
  });

  test('the temp copy is removed even when the run throws', async () => {
    const d = deps({
      runElevated: jest.fn(async () => {
        throw new Error('boom');
      })
    });
    await expect(installBundledVcRuntime(d)).resolves.toMatchObject({
      success: false,
      reason: 'installer-failed',
      error: 'boom'
    });
    expect(d.cleanup).toHaveBeenCalledTimes(1);
  });

  test('copying the installer fails: reported, nothing verified or spawned', async () => {
    const d = deps({
      stageCopy: jest.fn(async () => {
        throw new Error('ENOSPC');
      })
    });
    await expect(installBundledVcRuntime(d)).resolves.toMatchObject({
      success: false,
      reason: 'launch-failed'
    });
    expect(d.verifySignature).not.toHaveBeenCalled();
    expect(d.runElevated).not.toHaveBeenCalled();
  });

  test('exit 1638 (newer version present): success', async () => {
    const d = deps({ runElevated: jest.fn(async () => ({ exitCode: 1638 })) });
    await expect(installBundledVcRuntime(d)).resolves.toMatchObject({
      success: true,
      needsRestart: false,
      exitCode: 1638
    });
  });

  test('exit 1618 (another installation is running): install-in-progress', async () => {
    const d = deps({
      runElevated: jest.fn(async () => ({ exitCode: 1618 })),
      detect: detectSequence(MISSING)
    });
    const res = await installBundledVcRuntime(d);
    expect(res).toMatchObject({
      success: false,
      cancelled: false,
      reason: 'install-in-progress',
      exitCode: 1618
    });
    expect(res.error).toMatch(/Another installation/);
  });

  test('exit 3010: success with needsRestart, even before the DLLs appear', async () => {
    const d = deps({
      runElevated: jest.fn(async () => ({ exitCode: 3010 })),
      detect: detectSequence(MISSING)
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
      detect: detectSequence(MISSING)
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
      detect: detectSequence(MISSING)
    });
    await expect(installBundledVcRuntime(d)).resolves.toMatchObject({
      success: false,
      cancelled: false,
      exitCode: 1603,
      reason: 'installer-failed'
    });
  });

  test('exit 0 but the DLLs are still missing: not reported as success', async () => {
    const d = deps({ detect: detectSequence(MISSING) });
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
  });

  test('arm64 app stages the arm64 file', async () => {
    const d = deps({ arch: 'arm64' });
    await installBundledVcRuntime(d);
    expect(d.stageCopy).toHaveBeenCalledWith(
      path.join(RESOURCES, 'assets', 'runtime', 'vcredist', 'vc_redist.arm64.exe')
    );
  });

  test('main gives up before the preload invoke budget for this channel runs out', () => {
    expect(getIpcInvokeTimeout(IPC_CHANNELS.SYSTEM.INSTALL_VC_RUNTIME)).toBeGreaterThanOrEqual(
      INSTALL_TIMEOUT_MS + 60 * 1000
    );
  });
});

describe('stageInstallerCopy', () => {
  let root;
  let source;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-stage-test-'));
    source = path.join(root, 'resources', 'vc_redist.x64.exe');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'MZ-bundled');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('copies into a fresh directory per call and removes it on cleanup', async () => {
    const a = await stageInstallerCopy(source, { tmpDir: root });
    const b = await stageInstallerCopy(source, { tmpDir: root });

    for (const staged of [a, b]) {
      expect(path.basename(staged.path)).toBe('vc_redist.x64.exe');
      expect(path.dirname(path.dirname(staged.path))).toBe(root);
      expect(path.basename(path.dirname(staged.path)).startsWith(STAGING_DIR_PREFIX)).toBe(true);
      expect(fs.readFileSync(staged.path, 'utf8')).toBe('MZ-bundled');
    }
    expect(path.dirname(a.path)).not.toBe(path.dirname(b.path));

    await expect(a.cleanup()).resolves.toBe(true);
    expect(fs.existsSync(path.dirname(a.path))).toBe(false);
    expect(fs.existsSync(b.path)).toBe(true);
    await b.cleanup();
    expect(fs.existsSync(source)).toBe(true);
  });

  test('a failed copy leaves no directory behind and rejects', async () => {
    await expect(
      stageInstallerCopy(path.join(root, 'missing.exe'), { tmpDir: root })
    ).rejects.toThrow();
    expect(fs.readdirSync(root).filter((n) => n.startsWith(STAGING_DIR_PREFIX))).toEqual([]);
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
    expect(options.timeout).toBe(INSTALL_TIMEOUT_MS);
  });

  test('the script avoids what ConstrainedLanguage mode rejects', () => {
    expect(ELEVATED_INSTALL_SCRIPT).not.toMatch(/\[Console\]::/);
    expect(ELEVATED_INSTALL_SCRIPT).not.toMatch(/-is \[/);
    expect(ELEVATED_INSTALL_SCRIPT).not.toMatch(/\[pscustomobject\]/i);
    expect(ELEVATED_INSTALL_SCRIPT).toContain(`Write-Output ('${LAUNCH_FAILED_MARKER}: '`);
    expect(ELEVATED_INSTALL_SCRIPT).toContain('exit [int]$p.ExitCode');
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

/**
 * The real script, run by Windows PowerShell 5.1 in ConstrainedLanguage mode
 * (as on managed PCs). `-Verb RunAs` is stripped so no UAC prompt appears; the
 * rest runs verbatim, through runInstallerElevated's own output parsing.
 */
const describeWindows = process.platform === 'win32' ? describe : describe.skip;
describeWindows('elevated script under ConstrainedLanguage (real PowerShell)', () => {
  const CLM_PREFIX =
    "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\n" +
    "if ($ExecutionContext.SessionState.LanguageMode -ne 'ConstrainedLanguage') { exit 99 }\n";
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

  /** spawnImpl that runs `transform(script)` in CLM instead of the fixed script. */
  const clmSpawn =
    (transform = (script) => script) =>
    (command, args, options) => {
      const script = Buffer.from(args[args.length - 1], 'base64').toString('utf16le');
      const rewritten = CLM_PREFIX + transform(script.replace('-Verb RunAs ', ''));
      return asyncSpawn(command, encodedCommandArgs(rewritten), { ...options, timeout: 60000 });
    };

  test('sanity: a .NET method call really fails in this mode', () => {
    const r = spawnSync(
      powershellPath(),
      encodedCommandArgs(`${CLM_PREFIX}[Console]::Out.WriteLine('x')`),
      { encoding: 'utf8', windowsHide: true, timeout: 60000 }
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('x');
  }, 60000);

  test('the installer exit code comes back through exit', async () => {
    // where.exe rejects /install with exit code 2.
    const run = await runInstallerElevated(path.join(system32, 'where.exe'), {
      spawnImpl: clmSpawn()
    });
    expect(run).toMatchObject({ exitCode: 2, launchFailed: false, timedOut: false });
  }, 60000);

  test('a launch failure prints the marker', async () => {
    const run = await runInstallerElevated('C:\\definitely\\missing\\vc_redist.x64.exe', {
      spawnImpl: clmSpawn()
    });
    expect(run.exitCode).toBe(1);
    expect(run.launchFailed).toBe(true);
    expect(run.detail).toMatch(/\S/);
  }, 60000);

  test('a declined UAC prompt (ERROR_CANCELLED text) exits 1223', async () => {
    // Start-Process reports a declined prompt as an InvalidOperationException
    // whose message carries the system text for 1223; reproduce that message.
    const declined = clmSpawn((script) =>
      script.replace(
        /\$p = Start-Process[^\n]*/,
        "throw ('This command cannot be run due to the error: ' + (((& (Join-Path $env:SystemRoot 'System32\\net.exe') helpmsg 1223) | Where-Object { $_ }) -join ' '))"
      )
    );
    const run = await runInstallerElevated('C:\\x.exe', { spawnImpl: declined });
    expect(run).toMatchObject({ exitCode: 1223, launchFailed: false });
  }, 60000);
});
