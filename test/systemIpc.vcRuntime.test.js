/**
 * SYSTEM.INSTALL_VC_RUNTIME and SYSTEM.RELAUNCH_APP handlers
 * (src/main/ipc/system.js), exercised through the real installer module
 * (src/main/utils/vcRuntimeInstaller.js) and Authenticode helper with only
 * the process spawn, the runtime probe and the filesystem faked:
 *
 *   - off Windows, or without the bundled exe: `not-bundled`, nothing spawned
 *   - runtime already present: `already-installed`, nothing spawned (no UAC)
 *   - a bad signature: refused, the installer never spawned; a signature
 *     PowerShell could not read at all: `signature-unreadable`
 *   - what is verified and run is a copy in a fresh temp dir, removed after
 *   - exit codes 0 / 3010 / 1638 / 1602 / 1223 map to success / restart / cancel
 *   - whatever the renderer sends never reaches the spawned command
 */

jest.mock('../src/main/ipc/ipcWrappers', () => ({
  createHandler: jest.fn(({ handler }) => handler),
  createErrorResponse: jest.fn((error) => ({
    success: false,
    error: error.message || String(error)
  })),
  canceledResponse: jest.fn(),
  safeHandle: (ipcMain, channel, handler) => {
    ipcMain.handle(channel, handler);
  }
}));

const mockAsyncSpawn = jest.fn();
jest.mock('../src/main/utils/asyncSpawnUtils', () => ({
  asyncSpawn: (...args) => mockAsyncSpawn(...args)
}));

const mockDetectVcRuntime = jest.fn();
jest.mock('../src/main/utils/vcRuntimeDetection', () => ({
  detectVcRuntime: (...args) => mockDetectVcRuntime(...args)
}));

const mockRequestRelaunch = jest.fn(() => true);
jest.mock('../src/main/core/lifecycle', () => ({
  requestRelaunchAfterShutdown: (...args) => mockRequestRelaunch(...args)
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { IPC_CHANNELS } = require('../src/shared/constants');

const MS_SIGNATURE = JSON.stringify({
  Status: 'Valid',
  StatusMessage: 'Signature verified.',
  Subject: 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',
  ProductVersion: '14.51.36247.0',
  FileVersion: '14.51.36247.0'
});
const RENDERER_PAYLOAD = {
  path: 'C:\\evil\\payload.exe',
  args: ['/evil-flag'],
  exitCode: 0
};

/** Route the two PowerShell calls by the env var each one uses. */
function fakePowerShell({ signature = MS_SIGNATURE, installExit = 0 } = {}) {
  mockAsyncSpawn.mockImplementation(async (_command, _args, options) => {
    if (options?.env?.SS_AUTHENTICODE_TARGET) return { status: 0, stdout: signature };
    if (options?.env?.SS_VC_REDIST_INSTALLER) return { status: installExit, stdout: '' };
    return { status: 1, stdout: '' };
  });
}

const installCalls = () =>
  mockAsyncSpawn.mock.calls.filter(([, , options]) => options?.env?.SS_VC_REDIST_INSTALLER);

describe('SYSTEM.INSTALL_VC_RUNTIME / RELAUNCH_APP', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalResourcesPath = process.resourcesPath;
  let handlers;
  let resourcesPath;
  let exePath;

  function setPlatform(value) {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  }

  function stageBundledExe() {
    fs.mkdirSync(path.dirname(exePath), { recursive: true });
    fs.writeFileSync(exePath, 'MZ');
  }

  beforeEach(() => {
    mockAsyncSpawn.mockReset();
    mockDetectVcRuntime.mockReset();
    // Missing before the install, present after it.
    mockDetectVcRuntime
      .mockResolvedValueOnce({ applicable: true, present: false })
      .mockResolvedValue({ applicable: true, present: true });
    mockRequestRelaunch.mockClear();

    resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-ipc-resources-'));
    exePath = path.join(
      resourcesPath,
      'assets',
      'runtime',
      'vcredist',
      process.arch === 'arm64' ? 'vc_redist.arm64.exe' : 'vc_redist.x64.exe'
    );
    process.resourcesPath = resourcesPath;
    setPlatform('win32');

    handlers = {};
    const ipcMain = { handle: jest.fn((channel, handler) => (handlers[channel] = handler)) };
    const registerSystemIpc = require('../src/main/ipc/system');
    registerSystemIpc({
      ipcMain,
      IPC_CHANNELS,
      logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
      systemAnalytics: { collectMetrics: jest.fn() },
      getServiceIntegration: () => ({})
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform);
    process.resourcesPath = originalResourcesPath;
  });

  const install = (payload = RENDERER_PAYLOAD) =>
    handlers[IPC_CHANNELS.SYSTEM.INSTALL_VC_RUNTIME]({ sender: { id: 1 } }, payload);

  test('both channels are registered', () => {
    expect(typeof handlers['system:install-vc-runtime']).toBe('function');
    expect(typeof handlers['system:relaunch-app']).toBe('function');
  });

  test('not win32: not-bundled, nothing spawned', async () => {
    setPlatform('darwin');
    stageBundledExe();
    fakePowerShell();
    await expect(install()).resolves.toMatchObject({ success: false, reason: 'not-bundled' });
    expect(mockAsyncSpawn).not.toHaveBeenCalled();
  });

  test('bundled exe missing: not-bundled, nothing spawned', async () => {
    fakePowerShell();
    await expect(install()).resolves.toMatchObject({ success: false, reason: 'not-bundled' });
    expect(mockAsyncSpawn).not.toHaveBeenCalled();
  });

  test('runtime already present: already-installed, nothing spawned', async () => {
    stageBundledExe();
    fakePowerShell();
    mockDetectVcRuntime.mockReset();
    mockDetectVcRuntime.mockResolvedValue({ applicable: true, present: true });
    await expect(install()).resolves.toMatchObject({
      success: false,
      reason: 'already-installed',
      runtimePresent: true
    });
    expect(mockAsyncSpawn).not.toHaveBeenCalled();
  });

  test('PowerShell cannot read the signature: signature-unreadable, never spawned', async () => {
    stageBundledExe();
    mockAsyncSpawn.mockResolvedValue({ status: 1, stdout: '', stderr: 'blocked' });
    await expect(install()).resolves.toMatchObject({
      success: false,
      reason: 'signature-unreadable'
    });
    expect(installCalls()).toHaveLength(0);
  });

  test('exit 1618: install-in-progress', async () => {
    stageBundledExe();
    fakePowerShell({ installExit: 1618 });
    mockDetectVcRuntime.mockResolvedValue({ applicable: true, present: false });
    await expect(install()).resolves.toMatchObject({
      success: false,
      cancelled: false,
      reason: 'install-in-progress',
      exitCode: 1618
    });
  });

  test.each([
    ['unsigned', JSON.stringify({ Status: 'NotSigned', Subject: null })],
    [
      'signed by someone else',
      JSON.stringify({ Status: 'Valid', Subject: 'CN=Contoso, O=Contoso Ltd, C=US' })
    ],
    ['tampered', JSON.stringify({ Status: 'HashMismatch', Subject: 'O=Microsoft Corporation' })]
  ])('%s installer: refused and never spawned', async (_label, signature) => {
    stageBundledExe();
    fakePowerShell({ signature });
    await expect(install()).resolves.toMatchObject({
      success: false,
      cancelled: false,
      reason: 'signature-invalid'
    });
    expect(mockAsyncSpawn).toHaveBeenCalledTimes(1); // the signature read only
    expect(installCalls()).toHaveLength(0);
  });

  test.each([
    [0, { success: true, cancelled: false, needsRestart: false, exitCode: 0 }],
    [3010, { success: true, cancelled: false, needsRestart: true, exitCode: 3010 }],
    [1638, { success: true, cancelled: false, needsRestart: false, exitCode: 1638 }],
    [1602, { success: false, cancelled: true, needsRestart: false, exitCode: 1602 }],
    [1223, { success: false, cancelled: true, needsRestart: false, exitCode: 1223 }],
    [1603, { success: false, cancelled: false, needsRestart: false, exitCode: 1603 }]
  ])('installer exit %p', async (installExit, expected) => {
    stageBundledExe();
    fakePowerShell({ installExit });
    if (!expected.success)
      mockDetectVcRuntime.mockResolvedValue({ applicable: true, present: false });
    await expect(install()).resolves.toMatchObject(expected);
    expect(installCalls()).toHaveLength(1);
  });

  test('the spawned command carries nothing from the renderer', async () => {
    stageBundledExe();
    fakePowerShell();
    await install({ ...RENDERER_PAYLOAD, path: 'C:\\evil\\payload.exe' });

    // Verified, then run: the same file, a copy of the bundled one in a fresh
    // temp directory that is gone once the install returns.
    const [sigCall, runCall] = mockAsyncSpawn.mock.calls;
    const staged = sigCall[2].env.SS_AUTHENTICODE_TARGET;
    expect(runCall[2].env.SS_VC_REDIST_INSTALLER).toBe(staged);
    expect(staged).not.toBe(exePath);
    expect(path.basename(staged)).toBe(path.basename(exePath));
    expect(path.resolve(path.dirname(path.dirname(staged)))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(path.dirname(staged)).startsWith('stratosort-vcredist-')).toBe(true);
    expect(fs.existsSync(path.dirname(staged))).toBe(false);
    expect(fs.existsSync(exePath)).toBe(true);
    for (const [command, args, options] of mockAsyncSpawn.mock.calls) {
      expect(command).toMatch(/System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
      const decoded = Buffer.from(args[args.length - 1], 'base64').toString('utf16le');
      const everything = [command, ...args, decoded, JSON.stringify(options.env)].join(' ');
      expect(everything).not.toMatch(/evil/i);
    }
    const script = Buffer.from(runCall[1][runCall[1].length - 1], 'base64').toString('utf16le');
    expect(script).toContain("-ArgumentList '/install','/passive','/norestart' -Verb RunAs");
  });

  test('a second click while installing joins the running install', async () => {
    stageBundledExe();
    let finish;
    mockAsyncSpawn.mockImplementation(async (_c, _a, options) => {
      if (options?.env?.SS_AUTHENTICODE_TARGET) return { status: 0, stdout: MS_SIGNATURE };
      return new Promise((resolve) => {
        finish = () => resolve({ status: 0, stdout: '' });
      });
    });
    const first = install();
    const second = install();
    await new Promise((r) => setImmediate(r));
    finish();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(installCalls()).toHaveLength(1);
  });

  test('RELAUNCH_APP records a relaunch and quits after replying', async () => {
    const { app } = require('electron');
    app.quit.mockClear();
    const result = await handlers[IPC_CHANNELS.SYSTEM.RELAUNCH_APP]({ sender: { id: 1 } });
    expect(result).toEqual({ success: true });
    expect(mockRequestRelaunch).toHaveBeenCalledTimes(1);
    expect(app.quit).not.toHaveBeenCalled();
    await new Promise((r) => setImmediate(r));
    expect(app.quit).toHaveBeenCalledTimes(1);
  });
});
