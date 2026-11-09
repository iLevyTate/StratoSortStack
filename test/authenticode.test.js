/**
 * src/main/utils/authenticode.js — the one rule shared by the redistributable
 * staging script, the packaged-artifact verifier and the in-app installer:
 * Valid Authenticode status and a signer whose subject has O=Microsoft
 * Corporation. The file path only ever travels in the child environment.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const {
  SIGNATURE_SCRIPT,
  TARGET_ENV_VAR,
  encodedCommandArgs,
  powershellPath,
  evaluateMicrosoftSignature,
  parseAuthenticodeOutput,
  readAuthenticode,
  readAuthenticodeSync,
  subjectHasOrganization
} = require('../src/main/utils/authenticode');

const MS_SUBJECT =
  'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US';
const JSON_LINE = JSON.stringify({
  Status: 'Valid',
  StatusMessage: 'Signature verified.',
  Subject: MS_SUBJECT,
  ProductVersion: '14.51.36247.0',
  FileVersion: '14.51.36247.0'
});

describe('subjectHasOrganization', () => {
  test.each([
    [MS_SUBJECT, true],
    ['CN=Microsoft Windows, O="Microsoft Corporation", C=US', true],
    ['CN=Microsoft Corporation, O=Microsoft Corporation Ltd, C=US', false],
    ['CN=O=Microsoft Corporation, O=Contoso', false],
    ['CN=Contoso, OU=Microsoft Corporation', false],
    ['', false],
    [null, false]
  ])('%p -> %p', (subject, expected) => {
    expect(subjectHasOrganization(subject)).toBe(expected);
  });
});

describe('parse + evaluate', () => {
  test('parses the JSON line PowerShell prints, ignoring noise', () => {
    expect(parseAuthenticodeOutput(`WARNING: something\r\n${JSON_LINE}\r\n`)).toEqual({
      status: 'Valid',
      statusMessage: 'Signature verified.',
      subject: MS_SUBJECT,
      productVersion: '14.51.36247.0',
      fileVersion: '14.51.36247.0'
    });
    expect(parseAuthenticodeOutput('')).toBeNull();
    expect(parseAuthenticodeOutput('{not json')).toBeNull();
  });

  test('requires Valid and a Microsoft signer', () => {
    const info = parseAuthenticodeOutput(JSON_LINE);
    expect(evaluateMicrosoftSignature(info)).toMatchObject({ ok: true, reason: 'valid' });
    expect(evaluateMicrosoftSignature({ ...info, status: 'NotSigned' })).toMatchObject({
      ok: false,
      reason: 'not-valid'
    });
    expect(evaluateMicrosoftSignature({ ...info, subject: 'CN=Evil, O=Evil' })).toMatchObject({
      ok: false,
      reason: 'not-microsoft'
    });
    expect(evaluateMicrosoftSignature(null)).toMatchObject({ ok: false, reason: 'unreadable' });
  });
});

describe('PowerShell invocation', () => {
  const tricky = "C:\\Program Files\\O'Brien\\$(calc)\\vc_redist.x64.exe";

  test('async: absolute powershell.exe, encoded fixed script, path only in env', async () => {
    const spawnImpl = jest.fn(async () => ({ status: 0, stdout: JSON_LINE }));
    const info = await readAuthenticode(tricky, { env: { SystemRoot: 'C:\\Windows' }, spawnImpl });
    expect(info.status).toBe('Valid');
    const [command, args, options] = spawnImpl.mock.calls[0];
    expect(command).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(args).toContain('-EncodedCommand');
    const script = Buffer.from(args[args.length - 1], 'base64').toString('utf16le');
    expect(script).toContain(`Get-AuthenticodeSignature -LiteralPath $target`);
    expect(script).toContain(`$env:${TARGET_ENV_VAR}`);
    expect(args.join(' ')).not.toContain('Brien');
    expect(options.env[TARGET_ENV_VAR]).toBe(tricky);
  });

  test('a failing PowerShell resolves to null rather than throwing', async () => {
    await expect(
      readAuthenticode('x', { env: {}, spawnImpl: jest.fn(async () => ({ status: 1 })) })
    ).resolves.toBeNull();
    await expect(
      readAuthenticode('x', {
        env: {},
        spawnImpl: jest.fn(async () => {
          throw new Error('spawn failed');
        })
      })
    ).resolves.toBeNull();
    expect(
      readAuthenticodeSync('x', {
        env: {},
        spawnSyncImpl: jest.fn(() => ({ status: 0, stdout: '' }))
      })
    ).toBeNull();
  });
});

describe('signature script and ConstrainedLanguage mode', () => {
  test('uses nothing ConstrainedLanguage rejects', () => {
    // [pscustomobject] fails there with ConversionSupportedOnlyToCoreTypes, and
    // .NET static calls with MethodInvocationNotSupportedInConstrainedLanguage.
    expect(SIGNATURE_SCRIPT).not.toMatch(/\[pscustomobject\]/i);
    expect(SIGNATURE_SCRIPT).not.toMatch(/\[Console\]::/);
    expect(SIGNATURE_SCRIPT.split('\n')).toContain('@{');
    expect(SIGNATURE_SCRIPT).toContain('} | ConvertTo-Json -Compress');
  });

  const describeWindows = process.platform === 'win32' ? describe : describe.skip;
  describeWindows('real Windows PowerShell 5.1', () => {
    const CLM_PREFIX =
      "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\n" +
      "if ($ExecutionContext.SessionState.LanguageMode -ne 'ConstrainedLanguage') { exit 99 }\n";
    const notepad = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'notepad.exe');

    test.each([
      ['FullLanguage', ''],
      ['ConstrainedLanguage', CLM_PREFIX]
    ])(
      '%s: reads a Microsoft-signed system file as Valid / O=Microsoft Corporation',
      (_mode, prefix) => {
        const result = spawnSync(powershellPath(), encodedCommandArgs(prefix + SIGNATURE_SCRIPT), {
          env: { ...process.env, [TARGET_ENV_VAR]: notepad },
          encoding: 'utf8',
          windowsHide: true,
          timeout: 60000
        });
        expect(result.status).toBe(0);
        const info = parseAuthenticodeOutput(result.stdout);
        expect(info).toMatchObject({ status: 'Valid' });
        expect(evaluateMicrosoftSignature(info)).toMatchObject({ ok: true, reason: 'valid' });
      },
      60000
    );
  });
});

describe('Windows PowerShell child environment', () => {
  // GitHub's Windows runners run steps in PowerShell 7, which exports a
  // PSModulePath listing its own module folders; Windows PowerShell 5.1 then
  // loads PowerShell 7's security module and Get-AuthenticodeSignature fails.
  test('drops PSModulePath in any casing and keeps everything else', () => {
    const env = {
      SystemRoot: 'C:/Windows',
      PSModulePath: 'C:/Program Files/PowerShell/7/Modules',
      psmodulepath: 'x',
      KEEP_ME: '1'
    };
    const spawnSyncImpl = jest.fn(() => ({ status: 1, stdout: '', stderr: 'boom' }));
    readAuthenticodeSync('C:/file.exe', { env, spawnSyncImpl });
    const childEnv = spawnSyncImpl.mock.calls[0][2].env;
    expect(Object.keys(childEnv).some((k) => k.toLowerCase() === 'psmodulepath')).toBe(false);
    expect(childEnv.KEEP_ME).toBe('1');
    expect(childEnv.SystemRoot).toBe('C:/Windows');
    expect(Object.values(childEnv)).toContain('C:/file.exe');
  });

  test('a failed read reports the exit code and stderr through diagnostics', () => {
    const diagnostics = {};
    const result = readAuthenticodeSync('C:/file.exe', {
      env: { SystemRoot: 'C:/Windows' },
      diagnostics,
      spawnSyncImpl: jest.fn(() => ({
        status: 1,
        stdout: '',
        stderr: 'Get-AuthenticodeSignature : The term is not recognized\r\n  at line 3'
      }))
    });
    expect(result).toBeNull();
    expect(diagnostics.exitCode).toBe(1);
    expect(diagnostics.stderr).toMatch(/not recognized at line 3/);
  });
});
